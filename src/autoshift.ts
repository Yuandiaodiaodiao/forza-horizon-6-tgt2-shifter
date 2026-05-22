/**
 * Adaptive Auto-Shift — First-Principles Power-Curve Lookup
 *
 * Core idea: at the current wheel speed, which gear produces the most power?
 *
 * 1. Build one per-car engine power curve from telemetry: powerCurve[rpmBin] → p99 max torque
 * 2. Use learned gear ratios to convert wheel speed → RPM for any gear
 * 3. Each frame: compare power output at gear-1, gear, gear+1
 * 4. Shift to whichever gear gives more power (with rev-limiter & shift-time guards)
 *
 * No neural network needed — this is a direct physics computation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_DATA_DIR, loadConfig } from "./config";
import { buildKeyAgentUrl } from "./env";

const KEY_AGENT = buildKeyAgentUrl();
const DATA_DIR = join(APP_DATA_DIR, "data", "cars");

interface GearProfile {
  sampleCount: number;
  /** Gear ratio: engine_rad_s / driven_wheel_rad_s */
  ratioSum: number;
  ratioCount: number;
}

type PowerBin = { torqueNm: number; count: number; max: number; torqueSamples: number[] };

const NM_RPM_PER_HP = 7127; // HP = torque(Nm) * RPM / 7127

interface CarProfile {
  ordinal: number;
  maxRpm: number;
  idleRpm: number;
  /** Shared engine power curve for the car/tune. Engine output at RPM is gear-independent. */
  powerByRpm: Map<number, PowerBin>;
  peakPower: number;
  peakPowerRpm: number;
  maxObservedRpm: number;
  /** Learned fuel-cut RPM: the RPM where the ECU cuts fuel and power drops to 0.
   *  This is the absolute ceiling — shift before this regardless of algorithm. */
  fuelCutRpm: number;
  fuelCutConfidence: number; // 0-1, how sure we are
  gears: Map<number, GearProfile>;
  totalSamples: number;
  totalShifts: number;
  firstSeen: number;
}

interface TelemetryFrame {
  rpm: number;
  max_rpm: number;
  idle_rpm: number;
  gear: number;
  power_hp: number;
  torque_nm: number;
  speed_kmh: number;
  accel: number;
  brake: number;
  g_lat?: number;
  g_lon?: number;
  tire_slip: number[];
  steer: number;
  car_ordinal: number;
  car_class: string;
  car_pi: number;
  drivetrain: string;
  num_cylinders?: number;
  susp_travel: number[];
  wheel_speed: number[];
  rumble_strip: number[];
  puddle_depth: number[];
}

export class AdaptiveAutoShift {
  private carProfiles: Map<number, CarProfile> = new Map();
  private currentCar: CarProfile | null = null;
  private currentOrdinal = 0;
  private lastShiftTime = 0;
  private lastShiftDirection: "up" | "down" | null = null;
  private lastShiftFromGear = 0;
  private lastShiftToGear = 0;
  private enabled = true;
  private shiftLog: string[] = [];
  private decisionLog: string[] = [];
  private lastDecisionLogTime = 0;

  // Manual override: separate timers for blocking upshift vs downshift
  private blockUpshiftUntil = 0;
  private blockDownshiftUntil = 0;
  private manualPauseMs = loadConfig().manualCooldownSec * 1000;

  private config = {
    shiftCooldownMs: 400,
    slipThreshold: 1.5,
    minSpeedForUpshift: 5,
    rpmBinSize: 10,
    /** Minimum power-curve data points to enable smart shifting */
    minSamplesForLookup: 50,
    /** Only learn from high-throttle samples (>80%) for accurate full-load power curve */
    minThrottleForLearning: 0.80,
    /** Top sample pool per RPM bin for p99 max-torque estimation. Low samples never evict high samples. */
    maxTorqueSamplesPerBin: 80,
    /** High percentile used as robust max torque; rejects single-frame spikes better than raw max. */
    torquePercentile: 0.99,
    /** Do not add much weaker samples once a bin already has a strong learned torque. */
    minTorqueSampleRatioOfLearned: 0.90,
    /** Reject terrain samples that can cap wheel power below the real engine curve. */
    maxRumbleForLearning: 0.05,
    maxPuddleForLearning: 0.02,
    brakeBlocksUpshift: true,
    maxGear: 10,
    /** Shift costs ~400ms of zero power. Only shift if net gain exceeds this penalty. */
    shiftTimePenaltyMs: 400,
    /** Minimum power advantage (HP) to trigger a shift — avoid micro-optimizing */
    minPowerAdvantageHp: 5,
    /** Downshifts are more likely to cause oscillation, so require a larger win. */
    downshiftAdvantageMultiplier: 2.0,
    /** Context downshift: prepare a lower gear while braking before waiting for low RPM. */
    downshiftPrepBrake: 0.28,
    /** Context downshift: recover earlier when the driver reapplies throttle from low RPM. */
    downshiftExitThrottle: 0.42,
    /** Current RPM below this fraction of peak power is considered out of the power band. */
    downshiftLuggingPeakFraction: 0.68,
    /** Target lower gear should land at least this deep into the power band. */
    downshiftTargetPeakFraction: 0.58,
    /** Never request a downshift if the lower gear would land too near the limiter. */
    downshiftSafeRpmFraction: 0.94,
    /** Maximum number of gears a single downshift decision may skip. */
    maxDownshiftSkipGears: 4,
    /** Generic usable power ceiling multiplier; kept as a loose backstop only. */
    postPeakCeilingMultiplier: 1.12,
    /** Hard post-peak RPM margin; beyond this, treat revs as limiter/overrun risk instead of power reserve. */
    postPeakCeilingRpmMargin: 300,
    /** Only trust post-peak limiter guards after the learned peak is in the high-RPM power band. */
    postPeakCeilingMinPeakRpmFraction: 0.72,
    /** If post-peak power drops below this ratio, treat that RPM as a power cliff / fuel-cut edge. */
    powerCliffRatio: 0.72,
    /** Start active fuel-cut detection near this fraction of declared max RPM. */
    fuelCutDetectRpmFraction: 0.84,
    /** Minimum throttle for fuel-cut observation; keep high enough to avoid partial-throttle false cuts. */
    fuelCutDetectThrottleMin: 0.80,
    /** High-RPM samples below this fraction of learned peak power indicate fuel cut / limiter. */
    fuelCutPowerDropRatio: 0.82,
    /** RPM growth below this amount across the recent window counts as limiter plateau. */
    fuelCutPlateauRpmDelta: 80,
    /** Do not reverse an automatic shift immediately unless a hard safety rule fires. */
    reversalLockMs: 2_500,
    /** Avoid stacking ordinary shifts while telemetry is still settling after a gear change. */
    minGearHoldMs: 1_200,
    /** Throttle non-shift decision trace logs. */
    decisionLogIntervalMs: 1_000,
    /** Shift command lock is released when telemetry confirms the target gear or this timeout expires. */
    shiftExecutionTimeoutMs: 2_000,
    /** Reset to first gear once the car is effectively stopped. */
    stopResetSpeedKmh: 1.0,
    /** Fallback RPM thresholds when power curve data is insufficient */
    fallbackUpshiftFraction: 0.92,
    fallbackDownshiftFraction: 0.35,
  };

  private lastSaveTime = 0;
  private readonly SAVE_INTERVAL_MS = 60_000; // auto-save every 60s
  private dirty = false; // tracks if data changed since last save

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.loadAll();
  }

  // --- Persistence ---

  /** Save a single car profile to disk as JSON */
  private saveCar(carKey: number, car: CarProfile) {
    const path = join(DATA_DIR, `${carKey}.json`);
    const data: any = {
      carKey,
      ordinal: car.ordinal,
      maxRpm: car.maxRpm,
      idleRpm: car.idleRpm,
      powerCurve: {} as Record<number, PowerBin>,
      peakPower: car.peakPower,
      peakPowerRpm: car.peakPowerRpm,
      maxObservedRpm: car.maxObservedRpm,
      fuelCutRpm: car.fuelCutRpm,
      fuelCutConfidence: car.fuelCutConfidence,
      totalSamples: car.totalSamples,
      totalShifts: car.totalShifts,
      firstSeen: car.firstSeen,
      gears: {} as Record<number, any>,
    };
    for (const [bin, v] of car.powerByRpm) {
      data.powerCurve[bin] = {
        torqueNm: v.torqueNm,
        torqueSamples: v.torqueSamples,
        count: v.count,
        max: this.powerFromTorque(bin, v.torqueNm),
      };
    }
    for (const [g, p] of car.gears) {
      data.gears[g] = {
        sampleCount: p.sampleCount,
        ratioSum: p.ratioSum,
        ratioCount: p.ratioCount,
      };
    }
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  /** Load a single car profile from disk */
  private loadCar(path: string): { carKey: number; profile: CarProfile } | null {
    try {
      const rawText = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
      const raw = JSON.parse(rawText);
      const powerByRpm = new Map<number, PowerBin>();
      const addPowerBin = (bin: number, v: any) => {
        const count = Number(v.count) || 0;
        const loadedSamples = Array.isArray(v.torqueSamples)
          ? v.torqueSamples.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
          : [];
        const migratedTorque = Number(v.torqueNm ?? v.maxTorqueNm) || this.torqueFromLegacyPowerBin(bin, v);
        const torqueSamples = this.topTorqueSamples(loadedSamples.length > 0 ? loadedSamples : (migratedTorque > 0 ? [migratedTorque] : []));
        const torqueNm = this.percentile(torqueSamples, this.config.torquePercentile);
        if (count <= 0) return;
        const existing = powerByRpm.get(bin);
        if (existing) {
          existing.torqueSamples = this.topTorqueSamples([...existing.torqueSamples, ...torqueSamples]);
          existing.torqueNm = this.percentile(existing.torqueSamples, this.config.torquePercentile);
          existing.count += count;
          existing.max = this.powerFromTorque(bin, existing.torqueNm);
        } else {
          powerByRpm.set(bin, { torqueNm, count, max: this.powerFromTorque(bin, torqueNm), torqueSamples });
        }
      };

      for (const [binStr, v] of Object.entries(raw.powerCurve || {}) as [string, any][]) {
        addPowerBin(Number(binStr), v);
      }

      const gears = new Map<number, GearProfile>();
      for (const [gStr, gData] of Object.entries(raw.gears || {}) as [string, any][]) {
        // Migration path: old profiles stored duplicate power curves under each gear.
        // Merge those into the shared per-car curve once on load.
        for (const [binStr, v] of Object.entries(gData.powerCurve || {}) as [string, any][]) {
          addPowerBin(Number(binStr), v);
        }
        gears.set(Number(gStr), {
          sampleCount: gData.sampleCount,
          ratioSum: gData.ratioSum,
          ratioCount: gData.ratioCount,
        });
      }
      const peak = this.computePeakPower(powerByRpm);
      return {
        carKey: raw.carKey,
        profile: {
          ordinal: raw.ordinal,
          maxRpm: raw.maxRpm,
          idleRpm: raw.idleRpm,
          powerByRpm,
          peakPower: raw.peakPower || peak.power,
          peakPowerRpm: raw.peakPowerRpm || peak.rpm,
          maxObservedRpm: raw.maxObservedRpm || Math.max(0, ...powerByRpm.keys()),
          fuelCutRpm: raw.fuelCutRpm || 0,
          fuelCutConfidence: raw.fuelCutConfidence || 0,
          gears,
          totalSamples: raw.totalSamples,
          totalShifts: raw.totalShifts,
          firstSeen: raw.firstSeen,
        },
      };
    } catch (e) {
      console.error(`  AUTO: Failed to load ${path}:`, e);
      return null;
    }
  }

  /** Load all car profiles from data directory */
  private loadAll() {
    if (!existsSync(DATA_DIR)) return;
    const files = readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const result = this.loadCar(join(DATA_DIR, f));
      if (result) {
        this.carProfiles.set(result.carKey, result.profile);
        const gearCount = result.profile.gears.size;
        const bins = result.profile.powerByRpm.size;
        this.log(`Loaded car ${result.carKey}: ${result.profile.totalSamples} samples, ${gearCount} gears, ${bins} shared power bins`);
      }
    }
    if (files.length > 0) this.log(`Loaded ${files.length} car profiles from disk`);
  }

  /** Save all dirty profiles. Called periodically and on car switch. */
  saveAll() {
    if (!this.dirty) return;
    for (const [carKey, car] of this.carProfiles) {
      if (car.totalSamples > 0) {
        this.saveCar(carKey, car);
      }
    }
    this.dirty = false;
    this.lastSaveTime = Date.now();
  }

  /** Auto-save check — call from update loop */
  private maybeSave() {
    if (this.dirty && Date.now() - this.lastSaveTime > this.SAVE_INTERVAL_MS) {
      this.saveAll();
    }
  }

  private powerFromTorque(rpm: number, torqueNm: number): number {
    return torqueNm > 0 && rpm > 0 ? torqueNm * rpm / NM_RPM_PER_HP : 0;
  }

  private torqueFromPower(rpm: number, powerHp: number): number {
    return powerHp > 0 && rpm > 0 ? powerHp * NM_RPM_PER_HP / rpm : 0;
  }

  private torqueFromLegacyPowerBin(rpm: number, v: any): number {
    const count = Number(v.count) || 0;
    const avgPower = count > 0 && Number(v.sum) > 0 ? Number(v.sum) / count : 0;
    const maxPower = Number(v.max) || 0;
    return this.torqueFromPower(rpm, Math.max(avgPower, maxPower));
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  }

  private topTorqueSamples(values: number[]): number[] {
    return values
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => b - a)
      .slice(0, this.config.maxTorqueSamplesPerBin)
      .sort((a, b) => a - b);
  }

  private addTorqueSample(pb: PowerBin, torqueNm: number): boolean {
    if (pb.torqueNm > 0 && torqueNm < pb.torqueNm * this.config.minTorqueSampleRatioOfLearned) {
      return false;
    }
    if (pb.torqueSamples.length >= this.config.maxTorqueSamplesPerBin) {
      const minKept = pb.torqueSamples[0] ?? 0;
      if (torqueNm <= minKept) return false;
    }
    pb.torqueSamples = this.topTorqueSamples([...pb.torqueSamples, torqueNm]);
    pb.torqueNm = this.percentile(pb.torqueSamples, this.config.torquePercentile);
    return true;
  }

  private getBinPowerHp(rpm: number, data: PowerBin): number {
    return this.powerFromTorque(rpm, data.torqueNm);
  }

  private computePeakPower(powerByRpm: Map<number, PowerBin>): { rpm: number; power: number } {
    let peakRpm = 0;
    let peakPower = 0;
    for (const [bin, data] of powerByRpm) {
      if (data.count <= 0) continue;
      const hp = this.getBinPowerHp(bin, data);
      if (hp > peakPower) {
        peakPower = hp;
        peakRpm = bin;
      }
    }
    return { rpm: peakRpm, power: peakPower };
  }

  // --- Car management ---

  private getOrCreateCar(ordinal: number, maxRpm: number, idleRpm: number): CarProfile {
    if (!this.carProfiles.has(ordinal)) {
      this.carProfiles.set(ordinal, {
        ordinal,
        maxRpm,
        idleRpm,
        powerByRpm: new Map(),
        peakPower: 0,
        peakPowerRpm: 0,
        maxObservedRpm: 0,
        fuelCutRpm: 0,
        fuelCutConfidence: 0,
        gears: new Map(),
        totalSamples: 0,
        totalShifts: 0,
        firstSeen: Date.now(),
      });
      this.log(`NEW CAR detected: ordinal=${ordinal} maxRPM=${maxRpm} idle=${idleRpm}`);
    }
    const car = this.carProfiles.get(ordinal)!;
    if (maxRpm > car.maxRpm) car.maxRpm = maxRpm;
    if (idleRpm > 0 && (car.idleRpm === 0 || idleRpm < car.idleRpm)) car.idleRpm = idleRpm;
    return car;
  }

  private switchCar(ordinal: number, maxRpm: number, idleRpm: number) {
    // Save previous car data before switching
    if (this.dirty) this.saveAll();
    this.currentOrdinal = ordinal;
    this.currentCar = this.getOrCreateCar(ordinal, maxRpm, idleRpm);
    this.lastShiftTime = 0;
    this.lastShiftDirection = null;
    this.lastShiftFromGear = 0;
    this.lastShiftToGear = 0;
    this.blockUpshiftUntil = 0;
    this.blockDownshiftUntil = 0;
    this.log(`SWITCH to car ordinal=${ordinal} (${this.currentCar.totalSamples} existing samples)`);
  }

  private getGearProfile(car: CarProfile, gear: number): GearProfile {
    if (!car.gears.has(gear)) {
      car.gears.set(gear, {
        sampleCount: 0,
        ratioSum: 0,
        ratioCount: 0,
      });
    }
    return car.gears.get(gear)!;
  }

  // --- Manual override (directional) ---

  onManualUpshift(currentGear: number) {
    const baseGear = this.getManualBaseGear(currentGear);
    const targetGear = Math.min(10, baseGear + 1);
    this.blockDownshiftUntil = Date.now() + this.manualPauseMs;
    this.blockUpshiftUntil = 0;
    this.holdGear(targetGear);
    this.log(`MANUAL upshift → hold gear ${targetGear}, block auto-downshift ${Math.round(this.manualPauseMs / 1000)}s`);
  }

  onManualDownshift(currentGear: number) {
    const baseGear = this.getManualBaseGear(currentGear);
    const targetGear = Math.max(1, baseGear - 1);
    this.blockUpshiftUntil = Date.now() + this.manualPauseMs;
    this.blockDownshiftUntil = 0;
    this.holdGear(targetGear);
    this.log(`MANUAL downshift → hold gear ${targetGear}, block auto-upshift ${Math.round(this.manualPauseMs / 1000)}s`);
  }

  private getManualBaseGear(currentGear: number): number {
    if (this.heldGear >= 1 && this.heldGear <= 10) return this.heldGear;
    if (currentGear >= 1 && currentGear <= 10) return currentGear;
    return 1;
  }

  private hasManualLock(now: number): boolean {
    return now < this.blockUpshiftUntil || now < this.blockDownshiftUntil;
  }

  private isBlockedByManualLock(direction: "up" | "down", now: number): boolean {
    return (direction === "up" && now < this.blockUpshiftUntil)
      || (direction === "down" && now < this.blockDownshiftUntil);
  }

  // --- Fuel-cut detection ---
  // Track recent high-RPM frames to detect limiter behavior. Some cars do not report zero
  // power at fuel cut, so use plateau/drop signals instead of only power<=0.
  private fuelCutSamples: { rpm: number; power: number; throttle: number }[] = [];

  private detectFuelCut(car: CarProfile, rpm: number, power_hp: number, throttle: number) {
    if (throttle < this.config.fuelCutDetectThrottleMin || rpm < car.maxRpm * this.config.fuelCutDetectRpmFraction) {
      this.fuelCutSamples = [];
      return;
    }

    this.fuelCutSamples.push({ rpm, power: power_hp, throttle });
    if (this.fuelCutSamples.length > 30) this.fuelCutSamples.shift();

    if (this.fuelCutSamples.length < 8) return;

    const recent = this.fuelCutSamples.slice(-8);
    const powerNow = recent.reduce((s, f) => s + f.power, 0) / recent.length;
    const rpmNow = recent.reduce((s, f) => s + f.rpm, 0) / recent.length;
    const throttleNow = recent.reduce((s, f) => s + f.throttle, 0) / recent.length;
    const minRecentRpm = Math.min(...recent.map(f => f.rpm));
    const maxRecentRpm = Math.max(...recent.map(f => f.rpm));
    const rpmDelta = recent[recent.length - 1].rpm - recent[0].rpm;
    const rpmSpread = maxRecentRpm - minRecentRpm;
    const powerDrop = car.peakPower > 50 && powerNow < car.peakPower * this.config.fuelCutPowerDropRatio;
    const plateau = Math.abs(rpmDelta) < this.config.fuelCutPlateauRpmDelta || rpmSpread < this.config.fuelCutPlateauRpmDelta * 1.5;
    const nearTop = rpmNow > car.maxRpm * this.config.fuelCutDetectRpmFraction;
    const peakLooksCredible = car.peakPowerRpm > car.maxRpm * this.config.postPeakCeilingMinPeakRpmFraction;
    const postPeakPlateau = peakLooksCredible
      && rpmNow > car.peakPowerRpm + this.config.postPeakCeilingRpmMargin * 0.5
      && plateau
      && powerNow < car.peakPower * 0.92;
    const hardZero = powerNow <= 5 && recent.some(s => s.power > 50);

    if (nearTop && (hardZero || (plateau && powerDrop) || postPeakPlateau)) {
      const cutRpm = Math.round(minRecentRpm);
      const minCredibleCutRpm = car.peakPowerRpm > 0
        ? car.peakPowerRpm + this.config.postPeakCeilingRpmMargin * 0.65
        : car.maxRpm * this.config.fuelCutDetectRpmFraction;
      if (cutRpm < minCredibleCutRpm) {
        this.traceDecision(`IGNORE fuel-cut candidate rpm=${cutRpm} min=${minCredibleCutRpm.toFixed(0)} p=${powerNow.toFixed(0)} peak=${car.peakPower.toFixed(0)} throttle=${throttleNow.toFixed(2)}`, true);
        this.fuelCutSamples = [];
        return;
      }
      const source = hardZero
        ? "zero-power"
        : postPeakPlateau
          ? `post-peak plateau p=${powerNow.toFixed(0)} peak=${car.peakPower.toFixed(0)} throttle=${throttleNow.toFixed(2)} dRpm=${rpmDelta.toFixed(0)} spread=${rpmSpread.toFixed(0)}`
          : `plateau/drop p=${powerNow.toFixed(0)} peak=${car.peakPower.toFixed(0)} throttle=${throttleNow.toFixed(2)} dRpm=${rpmDelta.toFixed(0)} spread=${rpmSpread.toFixed(0)}`;
      this.updateFuelCut(car, cutRpm, source);
      this.fuelCutSamples = [];
    }
  }

  private updateFuelCut(car: CarProfile, cutRpm: number, source: string) {
    if (car.fuelCutRpm === 0 || cutRpm < car.fuelCutRpm) {
      car.fuelCutRpm = cutRpm;
      car.fuelCutConfidence = Math.min(1, car.fuelCutConfidence + 0.25);
      this.log(`FUEL-CUT detected at ${cutRpm} RPM via ${source} (confidence=${car.fuelCutConfidence.toFixed(2)}) maxRPM=${car.maxRpm}`);
    } else {
      car.fuelCutRpm = Math.round(car.fuelCutRpm * 0.9 + cutRpm * 0.1);
      car.fuelCutConfidence = Math.min(1, car.fuelCutConfidence + 0.08);
      this.log(`FUEL-CUT confirmed at ${car.fuelCutRpm} RPM via ${source} (confidence=${car.fuelCutConfidence.toFixed(2)})`);
    }
    this.dirty = true;
  }

  // --- Learning: build power curve from full-throttle telemetry ---

  private recordSample(car: CarProfile, frame: TelemetryFrame) {
    const { gear, rpm, accel, wheel_speed, drivetrain } = frame;
    if (gear < 1 || rpm < 500) return;
    const powerHp = this.getEnginePowerHp(frame);
    const torqueNm = this.getEngineTorqueNm(frame);

    const throttle = accel / 255;
    const p = this.getGearProfile(car, gear);
    p.sampleCount++;
    car.totalSamples++;

    // Detect fuel-cut RPM (must be before power curve learning)
    this.detectFuelCut(car, rpm, powerHp, throttle);

    // Only learn power curve from clean, high-throttle, grounded, non-slipping samples.
    // Slip/airborne → engine unloaded → reported power is artificially low → pollutes curve.
    const maxSlip = Math.max(...(frame.tire_slip || [0]));
    const maxRumble = Math.max(...(frame.rumble_strip || [0]));
    const maxPuddle = Math.max(...(frame.puddle_depth || [0]));
    const suspMin = Math.min(...(frame.susp_travel || [0.5, 0.5, 0.5, 0.5]));
    const isGrounded = suspMin > 0.08;
    const isGripping = maxSlip < 1.5;
    const cleanSurface = maxRumble <= this.config.maxRumbleForLearning && maxPuddle <= this.config.maxPuddleForLearning;

    const belowKnownFuelCut = car.fuelCutRpm === 0 || rpm < car.fuelCutRpm - this.config.rpmBinSize;
    if (throttle >= this.config.minThrottleForLearning && torqueNm > 1 && isGrounded && isGripping && cleanSurface && belowKnownFuelCut) {
      const bin = Math.round(rpm / this.config.rpmBinSize) * this.config.rpmBinSize;
      if (!car.powerByRpm.has(bin)) {
        car.powerByRpm.set(bin, { torqueNm: 0, count: 0, max: 0, torqueSamples: [] });
      }
      const pb = car.powerByRpm.get(bin)!;
      const accepted = this.addTorqueSample(pb, torqueNm);
      if (!accepted) return;
      pb.count++;
      pb.max = this.powerFromTorque(bin, pb.torqueNm);
      if (rpm > car.maxObservedRpm) car.maxObservedRpm = rpm;

      const learnedHp = this.getBinPowerHp(bin, pb);
      if (learnedHp > car.peakPower || bin === car.peakPowerRpm) {
        const peak = this.computePeakPower(car.powerByRpm);
        car.peakPower = peak.power;
        car.peakPowerRpm = peak.rpm;
      }
      this.dirty = true;
    }

    // Gear ratio: engine_rad_s / driven_wheel_rad_s
    if (wheel_speed && wheel_speed.length === 4 && rpm > 1000) {
      let drivenAvg: number;
      if (drivetrain === "FWD") {
        drivenAvg = (Math.abs(wheel_speed[0]) + Math.abs(wheel_speed[1])) / 2;
      } else if (drivetrain === "RWD") {
        drivenAvg = (Math.abs(wheel_speed[2]) + Math.abs(wheel_speed[3])) / 2;
      } else {
        drivenAvg = wheel_speed.reduce((s, w) => s + Math.abs(w), 0) / 4;
      }
      const maxSlip = Math.max(...(frame.tire_slip || [0]));
      if (drivenAvg > 5 && maxSlip < 2) {
        const engineRadS = rpm * Math.PI * 2 / 60;
        const ratio = engineRadS / drivenAvg;
        if (ratio > 0.5 && ratio < 50) {
          p.ratioSum += ratio;
          p.ratioCount++;
          this.dirty = true;
        }
      }
    }
  }

  // --- Power curve lookup ---

  /** Get average engine power at a given RPM. Returns null if no data. */
  private lookupPower(car: CarProfile, rpm: number): number | null {
    if (car.powerByRpm.size < 3) return null;

    const bin = Math.round(rpm / this.config.rpmBinSize) * this.config.rpmBinSize;

    // Try exact bin first
    const exact = car.powerByRpm.get(bin);
    if (exact && exact.count >= 2) return this.getBinPowerHp(bin, exact);

    // Interpolate from nearest bins
    let lo: { rpm: number; power: number } | null = null;
    let hi: { rpm: number; power: number } | null = null;
    for (const [binRpm, data] of car.powerByRpm) {
      if (data.count < 2) continue;
      const hp = this.getBinPowerHp(binRpm, data);
      if (binRpm <= rpm && (!lo || binRpm > lo.rpm)) lo = { rpm: binRpm, power: hp };
      if (binRpm >= rpm && (!hi || binRpm < hi.rpm)) hi = { rpm: binRpm, power: hp };
    }

    if (lo && hi && lo.rpm !== hi.rpm) {
      const t = (rpm - lo.rpm) / (hi.rpm - lo.rpm);
      return lo.power + t * (hi.power - lo.power);
    }
    if (lo) return lo.power;
    if (hi) return hi.power;
    return null;
  }

  /** Get learned gear ratio. Returns null if insufficient data. */
  private getGearRatio(car: CarProfile, gear: number): number | null {
    const p = car.gears.get(gear);
    if (!p || p.ratioCount < 10) return null;
    return p.ratioSum / p.ratioCount;
  }

  /** Convert wheel speed (rad/s) to RPM given a gear ratio */
  private wheelSpeedToRpm(wheelRadS: number, gearRatio: number): number {
    return wheelRadS * gearRatio * 60 / (2 * Math.PI);
  }

  /**
   * Estimate local power slope (dP/dRPM) at a given RPM for a gear.
   * Positive = power still increasing, negative = past peak and falling.
   */
  private lookupPowerSlope(car: CarProfile, rpm: number): number | null {
    const step = this.config.rpmBinSize;
    const pLo = this.lookupPower(car, rpm - step);
    const pHi = this.lookupPower(car, rpm + step);
    if (pLo === null || pHi === null) return null;
    return (pHi - pLo) / (2 * step);
  }

  private getUsablePowerCeiling(car: CarProfile, maxRpm: number): { rpm: number; source: string } {
    let ceiling = maxRpm * 0.97;
    let source = "maxRpm";

    if (car.fuelCutRpm > 0 && car.fuelCutConfidence >= 0.3) {
      ceiling = Math.min(ceiling, car.fuelCutRpm - this.config.rpmBinSize);
      source = `fuel-cut@${car.fuelCutRpm}`;
    }

    if (car.peakPowerRpm > 0 && car.peakPower > 0) {
      const peakLooksCredible = car.peakPowerRpm > maxRpm * this.config.postPeakCeilingMinPeakRpmFraction;
      const postPeakMarginLimit = car.peakPowerRpm + this.config.postPeakCeilingRpmMargin;
      if (peakLooksCredible && postPeakMarginLimit < ceiling) {
        ceiling = postPeakMarginLimit;
        source = `post-peak-margin@${car.peakPowerRpm}`;
      }

      const postPeakLimit = car.peakPowerRpm * this.config.postPeakCeilingMultiplier;
      if (peakLooksCredible && postPeakLimit < ceiling) {
        ceiling = postPeakLimit;
        source = `post-peak@${car.peakPowerRpm}`;
      }

      if (peakLooksCredible) {
        const cliff = [...car.powerByRpm.entries()]
          .filter(([bin, data]) => bin > car.peakPowerRpm && data.count >= 2 && this.getBinPowerHp(bin, data) < car.peakPower * this.config.powerCliffRatio)
          .sort((a, b) => a[0] - b[0])[0];
        if (cliff && cliff[0] - this.config.rpmBinSize < ceiling) {
          ceiling = cliff[0] - this.config.rpmBinSize;
          source = `power-cliff@${cliff[0]}`;
        }
      }
    }

    return { rpm: Math.max(car.idleRpm * 2, ceiling), source };
  }

  private getEnginePowerHp(frame: TelemetryFrame): number {
    const torquePowerHp = this.getEngineTorqueNm(frame) > 0 && frame.rpm > 0
      ? this.getEngineTorqueNm(frame) * frame.rpm / NM_RPM_PER_HP
      : 0;
    return torquePowerHp > 1 ? torquePowerHp : Math.max(0, frame.power_hp || 0);
  }

  private getEngineTorqueNm(frame: TelemetryFrame): number {
    if (frame.torque_nm > 0) return frame.torque_nm;
    return this.torqueFromPower(frame.rpm, Math.max(0, frame.power_hp || 0));
  }

  private formatPowerMap(powers: Map<number, { rpm: number; power: number }>): string {
    return [...powers.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([g, p]) => `g${g}:${p.power.toFixed(0)}hp@${p.rpm.toFixed(0)}`)
      .join(" ");
  }

  /**
   * Anti-ping-pong check: if we shift to targetGear, would the RPM there
   * make the original gear look better, causing an immediate shift back?
   */
  private wouldPingPong(
    car: CarProfile, fromGear: number, toGear: number, wheelRadS: number
  ): boolean {
    const toRatio = this.getGearRatio(car, toGear);
    const fromRatio = this.getGearRatio(car, fromGear);
    if (!toRatio || !fromRatio) return false;

    const rpmInNewGear = this.wheelSpeedToRpm(wheelRadS, toRatio);
    const powerInNewGear = this.lookupPower(car, rpmInNewGear);
    const powerIfBack = this.lookupPower(car, this.wheelSpeedToRpm(wheelRadS, fromRatio));

    if (powerInNewGear === null || powerIfBack === null) return false;

    // After shifting, the old gear would still be better → ping-pong
    return powerIfBack > powerInNewGear;
  }

  private getSafeDownshiftCandidates(
    car: CarProfile,
    currentGear: number,
    wheelRadS: number,
    usableCeilingRpm: number,
    maxRpm: number
  ): Map<number, { rpm: number; power: number | null }> {
    const candidates = new Map<number, { rpm: number; power: number | null }>();
    const safeCeiling = Math.min(usableCeilingRpm, maxRpm * this.config.downshiftSafeRpmFraction);
    const minGear = Math.max(1, currentGear - this.config.maxDownshiftSkipGears);

    for (let g = currentGear - 1; g >= minGear; g--) {
      const ratio = this.getGearRatio(car, g);
      if (!ratio) continue;

      const rpm = this.wheelSpeedToRpm(wheelRadS, ratio);
      if (rpm > safeCeiling) continue;
      if (rpm < car.idleRpm * 1.1) continue;

      candidates.set(g, { rpm, power: this.lookupPower(car, rpm) });
    }

    return candidates;
  }

  /**
   * Earlier downshift layer for braking zones and corner exits.
   *
   * Pure power comparison is intentionally conservative for downshifts, but that can
   * leave the car in a tall gear until RPM is already low. This helper keeps the
   * existing power-curve model and adds context: brake means "prepare the exit gear";
   * throttle reapply plus low RPM means "recover the power band now".
   */
  private evaluateContextualDownshift(
    car: CarProfile,
    frame: TelemetryFrame,
    currentGear: number,
    wheelRadS: number,
    usableCeilingRpm: number
  ): { targetGear: number; reason: string; critical: boolean; trace: string } | null {
    if (currentGear <= 1 || wheelRadS < 1) return null;

    const throttle = frame.accel / 255;
    const brake = frame.brake / 255;
    const latG = Math.abs(frame.g_lat ?? 0);
    const lonG = frame.g_lon ?? 0;
    const steer = Math.abs(frame.steer ?? 0) / 127;
    const peakRpm = car.peakPowerRpm > 0 ? car.peakPowerRpm : frame.max_rpm * 0.72;
    const targetBandFloor = Math.max(car.idleRpm * 1.8, peakRpm * this.config.downshiftTargetPeakFraction);
    const currentBandFloor = Math.max(car.idleRpm * 2.0, peakRpm * this.config.downshiftLuggingPeakFraction);
    const currentPower = this.lookupPower(car, frame.rpm);

    const braking = brake >= this.config.downshiftPrepBrake || lonG < -0.25;
    const cornerEntry = braking && frame.speed_kmh > 25 && (latG > 0.18 || steer > 0.18 || frame.rpm < currentBandFloor);
    const exitDemand = throttle >= this.config.downshiftExitThrottle && brake < 0.18 && frame.rpm < currentBandFloor;
    const badlyLugging = throttle >= 0.30 && frame.rpm < Math.max(car.idleRpm * 1.6, peakRpm * 0.48);

    const safeCandidates = this.getSafeDownshiftCandidates(car, currentGear, wheelRadS, usableCeilingRpm, frame.max_rpm);
    let best: { gear: number; rpm: number; power: number | null; powerGain: number; score: number } | null = null;
    for (const [gear, c] of safeCandidates) {
      const powerGain = currentPower !== null && c.power !== null ? c.power - currentPower : 0;
      const rpmBandScore = 1 - Math.min(1, Math.abs(c.rpm - peakRpm) / Math.max(peakRpm, 1));
      const depthBonus = (currentGear - gear) * (braking ? 12 : 4);
      const score = (c.power ?? 0) + rpmBandScore * 80 + depthBonus;
      if (!best || score > best.score) best = { gear, rpm: c.rpm, power: c.power, powerGain, score };
    }
    if (!best) return null;

    if (cornerEntry && best.rpm >= targetBandFloor) {
      const critical = brake > 0.62 || frame.rpm < car.idleRpm * 1.45;
      return {
        targetGear: best.gear,
        critical,
        reason: `brake-prep downshift: g${currentGear}->g${best.gear} rpm ${frame.rpm}->${best.rpm.toFixed(0)} targetBand>=${targetBandFloor.toFixed(0)} brake=${(brake * 100).toFixed(0)}% latG=${latG.toFixed(2)}`,
        trace: `context=brake-prep target=g${best.gear} rpm=${best.rpm.toFixed(0)} curP=${currentPower?.toFixed(0) ?? "?"} tgtP=${best.power?.toFixed(0) ?? "?"}`,
      };
    }

    if ((exitDemand || badlyLugging) && best.rpm >= targetBandFloor * 0.92 && best.powerGain > -this.config.minPowerAdvantageHp) {
      const mode = exitDemand ? "exit-recover" : "lugging";
      return {
        targetGear: best.gear,
        critical: frame.rpm < car.idleRpm * 1.35,
        reason: `${mode} downshift: g${currentGear}->g${best.gear} rpm ${frame.rpm}->${best.rpm.toFixed(0)} throttle=${(throttle * 100).toFixed(0)}% ΔP=${best.powerGain.toFixed(0)}hp`,
        trace: `context=${mode} target=g${best.gear} rpm=${best.rpm.toFixed(0)} curP=${currentPower?.toFixed(0) ?? "?"} tgtP=${best.power?.toFixed(0) ?? "?"}`,
      };
    }

    return null;
  }

  /**
   * Core decision: compare power output across gears at current wheel speed.
   *
   * Handles edge cases:
   * 1. Ping-pong: won't shift if the target gear would immediately want to shift back
   * 2. Declining power curve: if current gear is past peak and power is falling,
   *    factor in the "remaining headroom" — shift early if almost out of RPM range
   * 3. Over-rev protection: skip gears where RPM would exceed safe limits
   * 4. Stall protection: skip gears where RPM would drop below idle
   */
  private comparePowerAcrossGears(
    car: CarProfile, currentGear: number, wheelRadS: number, usableCeilingRpm: number
  ): { bestGear: number; currentPower: number; powers: Map<number, { rpm: number; power: number }>; slopeInfo?: string; powerTrace: string } | null {
    const currentRatio = this.getGearRatio(car, currentGear);
    if (!currentRatio || wheelRadS < 1) return null;

    const powers = new Map<number, { rpm: number; power: number }>();

    const candidateGears = [currentGear, currentGear + 1];
    for (let g = currentGear - 1; g >= Math.max(1, currentGear - this.config.maxDownshiftSkipGears); g--) {
      candidateGears.push(g);
    }

    for (const g of candidateGears) {
      if (g < 1 || g > this.config.maxGear) continue;
      const ratio = this.getGearRatio(car, g);
      if (!ratio) continue;

      const rpm = this.wheelSpeedToRpm(wheelRadS, ratio);

      if (rpm < car.idleRpm * 1.1) continue;
      if (rpm > usableCeilingRpm) continue;

      const power = this.lookupPower(car, rpm);
      if (power !== null) {
        powers.set(g, { rpm, power });
      }
    }

    const cur = powers.get(currentGear);
    if (!cur) return null;

    // --- Power slope analysis for current gear ---
    const curSlope = this.lookupPowerSlope(car, cur.rpm);
    let slopeInfo: string | undefined;

    // If current gear is past peak power and declining, apply "headroom" logic:
    // Even if next gear has slightly less power NOW, if current gear is running out
    // of RPM and power is dropping, shifting early avoids the dead zone near redline.
    let headroomBonus = 0;
    if (curSlope !== null && curSlope < 0) {
      const rpmHeadroom = (car.maxRpm - cur.rpm) / car.maxRpm;
      // Less headroom + steeper decline → bigger bonus for shifting up
      // headroomBonus is added to the next gear's "effective power" for comparison
      headroomBonus = Math.abs(curSlope) * this.config.rpmBinSize * (1 - rpmHeadroom) * 3;
      slopeInfo = `slope=${curSlope.toFixed(2)}hp/rpm headroom=${(rpmHeadroom * 100).toFixed(0)}% bonus=${headroomBonus.toFixed(1)}hp`;
    }

    // Find best gear considering headroom bonus for upshift
    let bestGear = currentGear;
    let bestEffectivePower = cur.power;
    for (const [g, { power }] of powers) {
      let effectivePower = power;
      // Apply headroom bonus only to the next gear up (encourages early upshift
      // when current gear is past peak)
      if (g === currentGear + 1 && headroomBonus > 0) {
        effectivePower += headroomBonus;
      }
      if (effectivePower > bestEffectivePower) {
        bestEffectivePower = effectivePower;
        bestGear = g;
      }
    }

    // Anti-ping-pong: verify the shift is stable
    if (bestGear !== currentGear) {
      if (this.wouldPingPong(car, currentGear, bestGear, wheelRadS)) {
        // The shift would immediately reverse — stay in current gear
        bestGear = currentGear;
        slopeInfo = (slopeInfo || "") + " [ping-pong blocked]";
      }
    }

    return { bestGear, currentPower: cur.power, powers, slopeInfo, powerTrace: this.formatPowerMap(powers) };
  }

  // --- Data completeness check ---

  /** A gear's data is "complete" when it has enough power bins and a learned ratio */
  private isGearDataComplete(car: CarProfile, gear: number): boolean {
    const p = car.gears.get(gear);
    if (!p) return false;
    const hasRatio = p.ratioCount >= 10;
    const curveSamples = [...car.powerByRpm.values()].reduce((sum, bin) => sum + bin.count, 0);
    const hasCurve = car.powerByRpm.size >= 8 && curveSamples >= this.config.minSamplesForLookup;
    return hasRatio && hasCurve;
  }

  /** Human-readable progress string for a gear */
  private getDataProgress(car: CarProfile, gear: number): string {
    const p = car.gears.get(gear);
    if (!p) return `g${gear}:no data`;
    return `curve:${car.powerByRpm.size}bins g${gear}:${p.ratioCount}ratios`;
  }

  // --- Shift history for hysteresis ---
  private recentShiftTimes: number[] = [];
  private readonly HYSTERESIS_WINDOW_MS = 5_000;
  private readonly MAX_SHIFTS_IN_WINDOW = 3; // if more than this, increase threshold

  private getHysteresisMultiplier(): number {
    const now = Date.now();
    this.recentShiftTimes = this.recentShiftTimes.filter(t => now - t < this.HYSTERESIS_WINDOW_MS);
    if (this.recentShiftTimes.length <= this.MAX_SHIFTS_IN_WINDOW) return 1.0;
    // Exponentially increase threshold to suppress rapid shifting
    return 1.0 + (this.recentShiftTimes.length - this.MAX_SHIFTS_IN_WINDOW) * 0.5;
  }

  // --- Gear hold management ---
  private heldGear = -99;
  private autoHolding = false;
  private shiftExecutionLocked = false;
  private latestTelemetryGear = 0;

  noteTelemetryGear(gear: number) {
    if (gear >= -1 && gear <= this.config.maxGear) this.latestTelemetryGear = gear;
  }

  private async holdGear(targetGear: number) {
    if (targetGear === this.heldGear) return;
    try { await fetch(`${KEY_AGENT}/gear/hold/${targetGear}`); } catch {}
    this.heldGear = targetGear;
    this.autoHolding = true;
  }

  private async executeShiftCommand(targetGear: number) {
    this.shiftExecutionLocked = true;
    try {
      await this.holdGear(targetGear);

      const deadline = Date.now() + this.config.shiftExecutionTimeoutMs;
      while (this.latestTelemetryGear !== targetGear && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      if (this.latestTelemetryGear === targetGear) {
        this.traceDecision(`SYNC gear target=${targetGear} confirmed`, true);
      } else {
        this.traceDecision(`SYNC timeout target=${targetGear} telemetry=${this.latestTelemetryGear}`, true);
      }
    } finally {
      this.shiftExecutionLocked = false;
    }
  }

  private async releaseGear() {
    if (!this.autoHolding) return;
    try { await fetch(`${KEY_AGENT}/gear/release`); } catch {}
    this.heldGear = -99;
    this.autoHolding = false;
  }

  // --- Get driven wheel speed ---

  private getDrivenWheelSpeed(frame: TelemetryFrame): number {
    const ws = frame.wheel_speed;
    if (!ws || ws.length !== 4) return 0;
    if (frame.drivetrain === "FWD") {
      return (Math.abs(ws[0]) + Math.abs(ws[1])) / 2;
    } else if (frame.drivetrain === "RWD") {
      return (Math.abs(ws[2]) + Math.abs(ws[3])) / 2;
    }
    return ws.reduce((s, w) => s + Math.abs(w), 0) / 4;
  }

  // --- Main update ---

  async update(frame: TelemetryFrame): Promise<{ action: string | null; reason: string }> {
    if (!this.enabled) return { action: null, reason: "disabled" };
    if (this.shiftExecutionLocked) return { action: null, reason: "shift execution locked" };

    const { rpm, max_rpm, idle_rpm, gear, speed_kmh, brake, tire_slip, car_ordinal } = frame;

    if (!car_ordinal || max_rpm <= 0) return { action: null, reason: "no car data" };

    // Composite car ID
    const dtVal = frame.drivetrain === "FWD" ? 1 : frame.drivetrain === "RWD" ? 2 : 3;
    const carKey = car_ordinal * 1000000
      + (frame.car_pi || 0) * 100
      + (frame.num_cylinders || 0) * 10
      + dtVal;

    if (carKey !== this.currentOrdinal) {
      this.switchCar(carKey, max_rpm, idle_rpm);
      this.log(`Car: ord=${car_ordinal} class=${frame.car_class} PI=${frame.car_pi} dt=${frame.drivetrain} → key=${carKey}`);
    }
    const car = this.currentCar!;

    const now = Date.now();

    // Always learn power curve
    this.recordSample(car, frame);
    this.maybeSave();

    // Skip invalid states
    if (gear < 1 || gear > this.config.maxGear) return { action: null, reason: `gear=${gear}` };
    if (now - this.lastShiftTime < this.config.shiftCooldownMs) {
      return { action: null, reason: "cooldown" };
    }

    const maxSlip = Math.max(...(tire_slip || [0]));
    const susp = frame.susp_travel || [0.5, 0.5, 0.5, 0.5];
    const suspMin = Math.min(...susp);

    // Airborne protection
    if (suspMin < 0.05) return { action: null, reason: "airborne" };

    // Get driven wheel speed for cross-gear comparison (used below)
    const wheelRadS = this.getDrivenWheelSpeed(frame);

    if (speed_kmh <= this.config.stopResetSpeedKmh && gear !== 1) {
      this.lastShiftTime = now;
      this.lastShiftDirection = "down";
      this.lastShiftFromGear = gear;
      this.lastShiftToGear = 1;
      this.recentShiftTimes.push(now);
      car.totalShifts++;
      const r = `STOP RESET: speed ${speed_kmh.toFixed(1)} km/h -> gear 1`;
      this.log(`DN: ${r}`);
      this.traceDecision(`EXEC stop-reset ${gear}->1 speed=${speed_kmh.toFixed(1)} rpm=${rpm}`, true);
      await this.executeShiftCommand(1);
      return { action: "downshift", reason: r };
    }

    // ========== FUEL-CUT ABSOLUTE CEILING ==========
    // If we've learned the fuel-cut RPM, force upshift before hitting it.
    // This overrides everything — even if the algorithm hasn't decided yet.
    const usableCeiling = this.getUsablePowerCeiling(car, max_rpm);
    const effectiveCeiling = usableCeiling.rpm;

    if (rpm >= effectiveCeiling && gear < this.config.maxGear) {
      if (this.isBlockedByManualLock("up", now)) {
        this.traceDecision(`BLOCK manual-lock up ceiling gear=${gear} rpm=${rpm} ceiling=${effectiveCeiling.toFixed(0)} source=${usableCeiling.source} held=${this.heldGear}`, true);
        return { action: null, reason: "manual-lock blocks upshift" };
      }
      // Immediate upshift — fuel cut imminent
      const fuelCutTag = usableCeiling.source;
      this.lastShiftTime = now;
      this.lastShiftDirection = "up";
      this.lastShiftFromGear = gear;
      this.lastShiftToGear = gear + 1;
      this.recentShiftTimes.push(now);
      car.totalShifts++;
      const r = `CEILING: RPM ${rpm} >= ${effectiveCeiling.toFixed(0)} (${fuelCutTag}) -> forced upshift ${gear}->${gear + 1}`;
      this.log(`UP: ${r}`);
      this.traceDecision(`EXEC ceiling up ${gear}->${gear + 1} rpm=${rpm} ceiling=${effectiveCeiling.toFixed(0)} source=${fuelCutTag} slip=${maxSlip.toFixed(2)} wheel=${wheelRadS.toFixed(2)}`, true);
      await this.executeShiftCommand(gear + 1);
      return { action: "upshift", reason: r };
    }

    // ========== FIRST-PRINCIPLES SHIFT DECISION ==========
    //
    // Strategy depends on data completeness:
    //   A) Have power curves + ratios for current & adjacent gears → power comparison
    //   B) Incomplete data → redline shifting (upshift near max RPM, downshift at low RPM)

    // Check if we have enough data for power-curve mode
    const hasCurrentGearData = this.isGearDataComplete(car, gear);
    const hasAdjacentData = (gear >= this.config.maxGear || this.isGearDataComplete(car, gear + 1))
      && (gear <= 1 || this.isGearDataComplete(car, gear - 1));
    const usePowerCurve = hasCurrentGearData && hasAdjacentData && wheelRadS > 1;

    const comparison = usePowerCurve
      ? this.comparePowerAcrossGears(car, gear, wheelRadS, effectiveCeiling)
      : null;

    let wantShift: "up" | "down" | null = null;
    let reason = "";
    let decisionTrace = "";
    let shiftAdvantage = 0;
    let breakEvenSec = Infinity;
    let effectiveMinAdvantage = this.config.minPowerAdvantageHp;
    let criticalShift = false;
    let targetGear = gear;

    if (comparison) {
      // ---- MODE A: Power-curve comparison ----
      const { bestGear, currentPower, powers, slopeInfo, powerTrace } = comparison;
      decisionTrace = `mode=power gear=${gear} best=${bestGear} ${powerTrace}`;

      if (bestGear !== gear) {
        const target = powers.get(bestGear)!;
        const advantage = target.power - currentPower;
        shiftAdvantage = advantage;

        const shiftTimeSec = this.config.shiftTimePenaltyMs / 1000;
        const energyLostDuringShift = currentPower * shiftTimeSec;
        breakEvenSec = advantage > 0 ? energyLostDuringShift / advantage : Infinity;

        const hystMult = this.getHysteresisMultiplier();
        const direction = bestGear > gear ? "up" : "down";
        const directionMult = direction === "down" ? this.config.downshiftAdvantageMultiplier : 1;
        effectiveMinAdvantage = this.config.minPowerAdvantageHp * hystMult * directionMult;

        if (advantage >= effectiveMinAdvantage && breakEvenSec < 2.0) {
          wantShift = direction;
          targetGear = bestGear;
          const hystTag = hystMult > 1 ? ` hyst×${hystMult.toFixed(1)}` : "";
          const downTag = directionMult > 1 ? ` down×${directionMult.toFixed(1)}` : "";
          const slopeTag = slopeInfo ? ` [${slopeInfo}]` : "";
          reason = `power: g${gear}=${currentPower.toFixed(0)}hp @${powers.get(gear)!.rpm.toFixed(0)}rpm → g${bestGear}=${target.power.toFixed(0)}hp @${target.rpm.toFixed(0)}rpm (Δ=${advantage.toFixed(0)}hp, min=${effectiveMinAdvantage.toFixed(0)}hp, breakeven=${breakEvenSec.toFixed(1)}s${hystTag}${downTag})${slopeTag}`;
        } else {
          this.traceDecision(`BLOCK threshold ${decisionTrace} Δ=${advantage.toFixed(1)} min=${effectiveMinAdvantage.toFixed(1)} breakeven=${breakEvenSec.toFixed(2)}s`);
        }
      }

      // Force downshift if RPM is very low
      if (!wantShift) {
        const contextualDownshift = this.evaluateContextualDownshift(car, frame, gear, wheelRadS, effectiveCeiling);
        if (contextualDownshift) {
          wantShift = "down";
          targetGear = contextualDownshift.targetGear;
          criticalShift = contextualDownshift.critical;
          reason = contextualDownshift.reason;
          decisionTrace = decisionTrace ? `${decisionTrace} ${contextualDownshift.trace}` : contextualDownshift.trace;
        }
      }

      if (!wantShift && rpm < idle_rpm * 1.5 && gear > 1 && speed_kmh > 15) {
        wantShift = "down";
        const rescue = this.getSafeDownshiftCandidates(car, gear, wheelRadS, effectiveCeiling, max_rpm);
        const deepest = [...rescue.keys()].sort((a, b) => a - b)[0];
        targetGear = deepest ?? gear - 1;
        criticalShift = rpm < idle_rpm * 1.25;
        reason = `low-RPM rescue: g${gear}->g${targetGear} RPM ${rpm} < ${(idle_rpm * 1.5).toFixed(0)}`;
      }
    } else {
      // ---- MODE B: Redline shifting (data incomplete) ----
      // Simple but reliable: upshift near redline, downshift at low RPM
      const upRpm = max_rpm * this.config.fallbackUpshiftFraction;
      const brakeRatio = brake / 255;
      const throttleRatio = frame.accel / 255;
      const downRpm = max_rpm * (
        brakeRatio >= this.config.downshiftPrepBrake || throttleRatio >= this.config.downshiftExitThrottle
          ? Math.max(this.config.fallbackDownshiftFraction, 0.46)
          : this.config.fallbackDownshiftFraction
      );

      if (rpm >= upRpm && gear < this.config.maxGear) {
        wantShift = "up";
        targetGear = gear + 1;
        criticalShift = rpm >= max_rpm * 0.96;
        reason = `redline RPM ${rpm}>=${upRpm.toFixed(0)} (${gear}→${gear + 1}) [learning: ${this.getDataProgress(car, gear)}]`;
      } else if (rpm <= downRpm && gear > 1 && speed_kmh > 10) {
        wantShift = "down";
        targetGear = gear - 1;
        criticalShift = rpm < idle_rpm * 1.25;
        reason = `low-RPM ${rpm}<=${downRpm.toFixed(0)} (${gear}→${gear - 1}) [learning]`;
      }
    }

    if (!wantShift) {
      if (comparison && decisionTrace) {
        this.traceDecision(`HOLD ${decisionTrace}`);
      }
      // Periodic debug
      if (car.totalSamples % 300 === 0 && car.totalSamples > 0) {
        const ratioGears = [...car.gears.entries()]
          .filter(([, p]) => p.ratioCount > 10)
          .map(([g, p]) => `g${g}:${(p.ratioSum / p.ratioCount).toFixed(2)}`)
          .join(" ");
        console.log(`  [pwr] curve:${car.powerByRpm.size}bins peak:${car.peakPower.toFixed(0)}hp@${car.peakPowerRpm} | ratios: ${ratioGears}`);
      }
      return { action: null, reason: comparison ? "hold (best gear)" : "hold (learning)" };
    }

    // ========== GUARDS ==========

    const msSinceShift = now - this.lastShiftTime;
    const isReversal = this.lastShiftDirection !== null && wantShift !== this.lastShiftDirection;

    if (this.isBlockedByManualLock(wantShift, now)) {
      this.traceDecision(`BLOCK manual-lock ${wantShift} gear=${gear} held=${this.heldGear} blockUp=${now < this.blockUpshiftUntil} blockDown=${now < this.blockDownshiftUntil} reason=${reason}`, true);
      return { action: null, reason: `manual-lock blocks ${wantShift}shift` };
    }

    if (this.hasManualLock(now)) {
      this.traceDecision(`ALLOW manual-lock same-direction ${wantShift} gear=${gear} held=${this.heldGear} blockUp=${now < this.blockUpshiftUntil} blockDown=${now < this.blockDownshiftUntil} reason=${reason}`, true);
    }

    if (!criticalShift && msSinceShift < this.config.minGearHoldMs) {
      this.traceDecision(`BLOCK settle ${wantShift} gear=${gear} last=${this.lastShiftDirection} ${this.lastShiftFromGear}->${this.lastShiftToGear} age=${msSinceShift}ms reason=${reason}`);
      return { action: null, reason: "post-shift settle" };
    }

    if (!criticalShift && isReversal && msSinceShift < this.config.reversalLockMs) {
      this.traceDecision(`BLOCK reversal ${wantShift} gear=${gear} last=${this.lastShiftDirection} ${this.lastShiftFromGear}->${this.lastShiftToGear} age=${msSinceShift}ms Δ=${shiftAdvantage.toFixed(1)} min=${effectiveMinAdvantage.toFixed(1)} breakeven=${breakEvenSec.toFixed(2)}s ${decisionTrace}`);
      return { action: null, reason: "anti-oscillation reversal lock" };
    }

    // Check manual override blocks
    if (wantShift === "up" && now < this.blockUpshiftUntil) {
      this.traceDecision(`BLOCK manual up gear=${gear} reason=${reason}`);
      return { action: null, reason: "manual-block upshift" };
    }
    if (wantShift === "down" && now < this.blockDownshiftUntil) {
      this.traceDecision(`BLOCK manual down gear=${gear} reason=${reason}`);
      return { action: null, reason: "manual-block downshift" };
    }

    // Brake blocks upshift
    if (wantShift === "up" && this.config.brakeBlocksUpshift && brake > 30) {
      this.traceDecision(`BLOCK braking up gear=${gear} brake=${brake} reason=${reason}`);
      return { action: null, reason: "braking" };
    }

    // Traction guard for upshift
    if (wantShift === "up") {
      const slipLimit = gear <= 2 ? 8.0 : gear <= 4 ? 3.0 : this.config.slipThreshold;
      if (maxSlip > slipLimit) {
        this.traceDecision(`BLOCK slip up gear=${gear} slip=${maxSlip.toFixed(2)} limit=${slipLimit} reason=${reason}`);
        return { action: null, reason: `slip ${maxSlip.toFixed(1)}>${slipLimit}` };
      }
      if (speed_kmh < this.config.minSpeedForUpshift) {
        this.traceDecision(`BLOCK speed up gear=${gear} speed=${speed_kmh.toFixed(1)} reason=${reason}`);
        return { action: null, reason: "too slow" };
      }
    }

    // Low speed low gear guard for downshift
    if (wantShift === "down" && speed_kmh < 10 && gear <= 2) {
      this.traceDecision(`BLOCK low-speed down gear=${gear} speed=${speed_kmh.toFixed(1)} reason=${reason}`);
      return { action: null, reason: "low speed low gear" };
    }

    // ========== EXECUTE SHIFT ==========

    this.lastShiftTime = now;
    this.lastShiftDirection = wantShift;
    this.lastShiftFromGear = gear;
    this.recentShiftTimes.push(now);
    car.totalShifts++;
    this.lastShiftToGear = targetGear;
    this.log(`${wantShift === "up" ? "UP" : "DN"}: ${reason}`);
    if (decisionTrace) this.traceDecision(`EXEC ${wantShift} ${gear}->${targetGear} ${decisionTrace} reason=${reason}`, true);
    await this.executeShiftCommand(targetGear);
    return { action: wantShift === "up" ? "upshift" : "downshift", reason };
  }

  // --- Fallback thresholds (when power curve data insufficient) ---

  private getFallbackUpRpm(car: CarProfile, gear: number): number {
    if (car.peakPowerRpm > 0 && car.powerByRpm.size >= 8) {
      return Math.min(car.peakPowerRpm * 1.05, car.maxRpm * 0.93);
    }
    return car.maxRpm * this.config.fallbackUpshiftFraction;
  }

  private getFallbackDownRpm(car: CarProfile, gear: number): number {
    return car.maxRpm * this.config.fallbackDownshiftFraction;
  }

  // --- Logging ---

  private log(msg: string) {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    const line = `[${ts}] ${msg}`;
    console.log(`  AUTO: ${line}`);
    this.shiftLog.push(line);
    if (this.shiftLog.length > 500) this.shiftLog.shift();
  }

  private traceDecision(msg: string, force = false) {
    const now = Date.now();
    if (!force && now - this.lastDecisionLogTime < this.config.decisionLogIntervalMs) return;
    this.lastDecisionLogTime = now;
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    const line = `[${ts}] ${msg}`;
    console.log(`  AUTO TRACE: ${line}`);
    this.decisionLog.push(line);
    if (this.decisionLog.length > 1000) this.decisionLog.shift();
  }

  // --- Control ---

  setEnabled(on: boolean) { this.enabled = on; this.log(on ? "ENABLED" : "DISABLED"); }
  isEnabled() { return this.enabled; }
  setManualCooldownSec(seconds: number) { this.manualPauseMs = Math.max(0, Math.min(120, seconds)) * 1000; }

  getStatus() {
    const cars: Record<number, any> = {};
    for (const [ordinal, car] of this.carProfiles) {
      const curveSummary: { rpm: number; hp: number }[] = [];
      for (const [bin, data] of [...car.powerByRpm.entries()].sort((a, b) => a[0] - b[0])) {
        if (data.count >= 2) curveSummary.push({ rpm: bin, hp: +this.getBinPowerHp(bin, data).toFixed(1) });
      }
      const gears: Record<number, any> = {};
      for (const [g, p] of car.gears) {
        const avgRatio = p.ratioCount > 10 ? p.ratioSum / p.ratioCount : null;
        gears[g] = {
          samples: p.sampleCount,
          ratio: avgRatio ? +avgRatio.toFixed(3) : null,
          ratioSamples: p.ratioCount,
        };
      }
      // Per-gear data completeness
      const gearComplete: Record<number, boolean> = {};
      for (const g of car.gears.keys()) {
        gearComplete[g] = this.isGearDataComplete(car, g);
      }

      cars[ordinal] = {
        totalSamples: car.totalSamples,
        totalShifts: car.totalShifts,
        maxRpm: car.maxRpm,
        idleRpm: car.idleRpm,
        powerBins: car.powerByRpm.size,
        peakHp: +car.peakPower.toFixed(1),
        peakHpRpm: car.peakPowerRpm,
        powerCurve: curveSummary.length > 0 ? curveSummary : undefined,
        fuelCutRpm: car.fuelCutRpm || null,
        fuelCutConfidence: car.fuelCutConfidence || 0,
        gearComplete,
        gears,
      };
    }
    return {
      enabled: this.enabled,
      manualCooldownSec: this.manualPauseMs / 1000,
      currentCar: this.currentOrdinal,
      blockUpshift: Date.now() < this.blockUpshiftUntil,
      blockDownshift: Date.now() < this.blockDownshiftUntil,
      lastShift: this.lastShiftDirection ? {
        direction: this.lastShiftDirection,
        from: this.lastShiftFromGear,
        to: this.lastShiftToGear,
        ageMs: Date.now() - this.lastShiftTime,
      } : null,
      shiftExecutionLocked: this.shiftExecutionLocked,
      algorithm: "first-principles power-curve lookup",
      cars,
      recentShifts: this.shiftLog.slice(-30),
      decisionTrace: this.decisionLog.slice(-80),
    };
  }
}

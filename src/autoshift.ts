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
import type { PowerCurveSeed, PowerCurveSnapshot } from "./power_curve_types";

const KEY_AGENT = buildKeyAgentUrl();
const DATA_DIR = join(APP_DATA_DIR, "data", "cars");

interface GearProfile {
  sampleCount: number;
  /** Gear ratio: engine_rad_s / driven_wheel_rad_s */
  ratioSum: number;
  ratioCount: number;
}

type PowerBin = { torqueNm: number; count: number; max: number; torqueSamples: number[] };
type CurveLookupCache = { points: { rpm: number; power: number }[]; totalSamples: number };

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
  /** Learned rolling radius: vehicle speed (m/s) / driven wheel speed (rad/s). */
  wheelRadiusSum: number;
  wheelRadiusCount: number;
  totalSamples: number;
  totalShifts: number;
  shiftTiming: ShiftTimingProfile;
  firstSeen: number;
}

interface ShiftTimingProfile {
  samples: number;
  avgMs: number;
  ewmaMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  upSamples: number;
  upAvgMs: number;
  downSamples: number;
  downAvgMs: number;
}

interface PendingShiftTiming {
  carOrdinal: number;
  direction: "up" | "down";
  fromGear: number;
  toGear: number;
  source: "auto" | "manual";
  startedAt: number;
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
  clutch: number;
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

type ShiftIntent = "up" | "down" | null;

interface ShiftDecision {
  wantShift: ShiftIntent;
  targetGear: number;
  reason: string;
  decisionTrace: string;
  shiftAdvantage: number;
  breakEvenSec: number;
  effectiveMinAdvantage: number;
  criticalShift: boolean;
  holdReason: string;
  thresholdTrace?: string;
}

interface GearShiftThresholds {
  downshiftRpm: number | null;
  upshiftRpm: number | null;
  source: "learned" | "fallback";
  reason: string;
}

export class AdaptiveAutoShift {
  private carProfiles: Map<number, CarProfile> = new Map();
  private curveLookupCache = new WeakMap<CarProfile, CurveLookupCache>();
  private lastPowerCurveRevision = 0;
  private currentCar: CarProfile | null = null;
  private currentOrdinal = 0;
  private lastShiftTime = 0;
  private lastShiftDirection: "up" | "down" | null = null;
  private lastShiftFromGear = 0;
  private lastShiftToGear = 0;
  private nextCeilingUpshiftAt = 0;
  private enabled = true;
  private shiftLog: string[] = [];
  private decisionLog: string[] = [];
  private lastDecisionLogTime = 0;

  // Manual override: separate timers for blocking upshift vs downshift
  private blockUpshiftUntil = 0;
  private blockDownshiftUntil = 0;
  private manualPauseMs = loadConfig().manualCooldownSec * 1000;

  private config = {
    /** Do not issue another command while a recent shift has not been confirmed by telemetry. */
    shiftCooldownMs: 400,
    /** Fuel-cut/ceiling upshifts need a hard debounce so limiter frames cannot chain-skip gears. */
    ceilingUpshiftCooldownMs: 500,
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
    postPeakCeilingRpmMargin: 900,
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
    /** Avoid stacking ordinary shifts only while telemetry has not confirmed the target gear. */
    minGearHoldMs: 1_200,
    /** After a downshift, wait briefly if engine RPM has not settled to the speed-implied gear RPM. */
    downshiftSettleMs: 900,
    /** After any shift, keep planning locked until RPM matches wheel speed and target gear. */
    shiftRpmSettleTimeoutMs: 900,
    /** RPM may lag the selected gear during clutch/engine-speed synchronization. */
    downshiftSettleToleranceFraction: 0.10,
    /** Throttle non-shift decision trace logs. */
    decisionLogIntervalMs: 1_000,
    /** Shift command lock is released when telemetry confirms the target gear or this timeout expires. */
    shiftExecutionTimeoutMs: 2_000,
    /** Key-agent HTTP calls must never be allowed to hold the auto-shift loop forever. */
    keyAgentRequestTimeoutMs: 800,
    /** Treat clutch telemetry at or below this value as fully released. */
    clutchReleasedThreshold: 5,
    /** Need this many clean samples before using speed-derived gear caps. */
    minWheelRadiusSamples: 20,
    /** Small tolerance so telemetry quantization does not block exactly-at-threshold shifts. */
    gearMinSpeedToleranceKmh: 2.0,
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
      wheelRadiusSum: car.wheelRadiusSum,
      wheelRadiusCount: car.wheelRadiusCount,
      totalSamples: car.totalSamples,
      totalShifts: car.totalShifts,
      shiftTiming: car.shiftTiming,
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
          wheelRadiusSum: Number(raw.wheelRadiusSum) || 0,
          wheelRadiusCount: Number(raw.wheelRadiusCount) || 0,
          totalSamples: raw.totalSamples,
          totalShifts: raw.totalShifts,
          shiftTiming: this.normalizeShiftTiming(raw.shiftTiming),
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

  private defaultShiftTiming(): ShiftTimingProfile {
    return {
      samples: 0,
      avgMs: 0,
      ewmaMs: 0,
      minMs: 0,
      maxMs: 0,
      lastMs: 0,
      upSamples: 0,
      upAvgMs: 0,
      downSamples: 0,
      downAvgMs: 0,
    };
  }

  private normalizeShiftTiming(raw: any): ShiftTimingProfile {
    const base = this.defaultShiftTiming();
    if (!raw || typeof raw !== "object") return base;
    return {
      samples: Math.max(0, Number(raw.samples) || 0),
      avgMs: Math.max(0, Number(raw.avgMs) || 0),
      ewmaMs: Math.max(0, Number(raw.ewmaMs) || 0),
      minMs: Math.max(0, Number(raw.minMs) || 0),
      maxMs: Math.max(0, Number(raw.maxMs) || 0),
      lastMs: Math.max(0, Number(raw.lastMs) || 0),
      upSamples: Math.max(0, Number(raw.upSamples) || 0),
      upAvgMs: Math.max(0, Number(raw.upAvgMs) || 0),
      downSamples: Math.max(0, Number(raw.downSamples) || 0),
      downAvgMs: Math.max(0, Number(raw.downAvgMs) || 0),
    };
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
        wheelRadiusSum: 0,
        wheelRadiusCount: 0,
        totalSamples: 0,
        totalShifts: 0,
        shiftTiming: this.defaultShiftTiming(),
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
    this.nextCeilingUpshiftAt = 0;
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
    if (this.currentCar && !this.isShiftOutputDisabled()) this.beginShiftTiming(this.currentCar, "up", baseGear, targetGear, "manual");
    this.holdGear(targetGear);
    this.log(`MANUAL upshift → hold gear ${targetGear}, block auto-downshift ${Math.round(this.manualPauseMs / 1000)}s`);
  }

  onManualDownshift(currentGear: number) {
    const baseGear = this.getManualBaseGear(currentGear);
    const targetGear = Math.max(1, baseGear - 1);
    this.blockUpshiftUntil = Date.now() + this.manualPauseMs;
    this.blockDownshiftUntil = 0;
    if (this.currentCar && !this.isShiftOutputDisabled()) this.beginShiftTiming(this.currentCar, "down", baseGear, targetGear, "manual");
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

  // --- Learning retained here for drivetrain/fuel-cut state; power curve is worker-owned ---

  private recordSample(car: CarProfile, frame: TelemetryFrame) {
    const { gear, rpm, accel, wheel_speed, drivetrain } = frame;
    if (gear < 1 || rpm < 500) return;
    const powerHp = this.getEnginePowerHp(frame);

    const throttle = accel / 255;
    const p = this.getGearProfile(car, gear);
    p.sampleCount++;
    car.totalSamples++;

    // Fuel-cut and gear-ratio state remain local to the shift decision engine.
    this.detectFuelCut(car, rpm, powerHp, throttle);

    const maxSlip = Math.max(...(frame.tire_slip || [0]));
    const maxRumble = Math.max(...(frame.rumble_strip || [0]));
    const maxPuddle = Math.max(...(frame.puddle_depth || [0]));
    const suspMin = Math.min(...(frame.susp_travel || [0.5, 0.5, 0.5, 0.5]));
    const isGrounded = suspMin > 0.08;
    const isGripping = maxSlip < 1.5;
    const cleanSurface = maxRumble <= this.config.maxRumbleForLearning && maxPuddle <= this.config.maxPuddleForLearning;

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

      if (drivenAvg > 5 && frame.speed_kmh > 10 && maxSlip < 1.0 && isGrounded && cleanSurface) {
        const radiusM = (frame.speed_kmh / 3.6) / drivenAvg;
        if (radiusM >= 0.15 && radiusM <= 0.60) {
          car.wheelRadiusSum += radiusM;
          car.wheelRadiusCount++;
          this.dirty = true;
        }
      }
    }
  }

  // --- Power curve lookup ---

  private getCurveLookup(car: CarProfile): CurveLookupCache {
    const cached = this.curveLookupCache.get(car);
    if (cached) return cached;
    const points: { rpm: number; power: number }[] = [];
    let totalSamples = 0;
    for (const [rpm, data] of car.powerByRpm) {
      totalSamples += data.count;
      if (data.count >= 2) points.push({ rpm, power: this.getBinPowerHp(rpm, data) });
    }
    points.sort((a, b) => a.rpm - b.rpm);
    const next = { points, totalSamples };
    this.curveLookupCache.set(car, next);
    return next;
  }

  /** Get average engine power at a given RPM. Returns null if no data. */
  private lookupPower(car: CarProfile, rpm: number): number | null {
    const points = this.getCurveLookup(car).points;
    if (points.length < 3) return null;
    let lo = 0;
    let hi = points.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].rpm === rpm) return points[mid].power;
      if (points[mid].rpm < rpm) lo = mid + 1;
      else hi = mid - 1;
    }
    const lower = points[Math.max(0, hi)];
    const upper = points[Math.min(points.length - 1, lo)];
    if (!lower) return upper?.power ?? null;
    if (!upper || lower.rpm === upper.rpm) return lower.power;
    const t = (rpm - lower.rpm) / (upper.rpm - lower.rpm);
    return lower.power + t * (upper.power - lower.power);
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

  private getWheelRadiusM(car: CarProfile): number | null {
    if (car.wheelRadiusCount < this.config.minWheelRadiusSamples) return null;
    return car.wheelRadiusSum / car.wheelRadiusCount;
  }

  private rpmToSpeedKmh(car: CarProfile, gear: number, rpm: number): number | null {
    const ratio = this.getGearRatio(car, gear);
    const radiusM = this.getWheelRadiusM(car);
    if (!ratio || !radiusM) return null;
    const engineRadS = rpm * 2 * Math.PI / 60;
    const wheelRadS = engineRadS / ratio;
    return wheelRadS * radiusM * 3.6;
  }

  private speedToRpm(car: CarProfile, gear: number, speedKmh: number): number | null {
    const ratio = this.getGearRatio(car, gear);
    const radiusM = this.getWheelRadiusM(car);
    if (!ratio || !radiusM) return null;
    const wheelRadS = speedKmh / 3.6 / radiusM;
    return this.wheelSpeedToRpm(wheelRadS, ratio);
  }

  private getUpshiftRpmForSpeedCap(car: CarProfile, fromGear: number, toGear: number, maxRpm: number): number | null {
    const fromRatio = this.getGearRatio(car, fromGear);
    const toRatio = this.getGearRatio(car, toGear);
    if (!fromRatio || !toRatio) return null;

    const usableCeiling = this.getUsablePowerCeiling(car, maxRpm).rpm;
    const fallback = Math.min(usableCeiling, maxRpm * this.config.fallbackUpshiftFraction);
    if (car.powerByRpm.size < 8 || car.peakPower <= 0) return fallback;

    const startRpm = Math.max(car.idleRpm * 1.8, maxRpm * 0.35);
    for (let rpm = startRpm; rpm <= usableCeiling; rpm += this.config.rpmBinSize) {
      const nextRpm = rpm * toRatio / fromRatio;
      if (nextRpm < car.idleRpm * 1.1) continue;
      const currentPower = this.lookupPower(car, rpm);
      const nextPower = this.lookupPower(car, nextRpm);
      if (currentPower === null || nextPower === null) continue;
      if (nextPower >= currentPower + this.config.minPowerAdvantageHp) return rpm;
    }

    return fallback;
  }

  private getMinSpeedForGearKmh(car: CarProfile, targetGear: number, maxRpm: number): number | null {
    if (targetGear <= 1 || targetGear > this.config.maxGear) return null;
    if (!this.getGearRatio(car, targetGear)) return null;
    const fromGear = targetGear - 1;
    const upshiftRpm = this.getGearShiftThresholds(car, fromGear, this.getHighestLearnedForwardGear(car), maxRpm).upshiftRpm;
    if (!upshiftRpm) return null;
    return this.rpmToSpeedKmh(car, fromGear, upshiftRpm);
  }

  private getDownshiftSpeedForGearKmh(car: CarProfile, gear: number, maxRpm: number): number | null {
    if (gear <= 1 || gear > this.config.maxGear) return gear === 1 ? 0 : null;
    const ratio = this.getGearRatio(car, gear);
    const lowerRatio = this.getGearRatio(car, gear - 1);
    const radiusM = this.getWheelRadiusM(car);
    if (!ratio || !lowerRatio || !radiusM) return null;

    const candidates: number[] = [];
    const hasPowerModel = car.powerByRpm.size >= 8 && this.getCurveLookup(car).totalSamples >= this.config.minSamplesForLookup;
    if (hasPowerModel) {
      const peakRpm = car.peakPowerRpm > 0 ? car.peakPowerRpm : maxRpm * 0.72;
      const currentBandFloor = Math.max(car.idleRpm * 2.0, peakRpm * this.config.downshiftLuggingPeakFraction);
      const contextual = this.rpmToSpeedKmh(car, gear, currentBandFloor);
      if (contextual != null) candidates.push(contextual);

      const rescue = this.rpmToSpeedKmh(car, gear, car.idleRpm * 1.5);
      if (rescue != null) candidates.push(rescue);

      const power = this.getPowerDownshiftSpeedForGearKmh(car, gear, maxRpm);
      if (power != null) candidates.push(power);
    } else {
      const fallback = this.rpmToSpeedKmh(car, gear, maxRpm * this.config.fallbackDownshiftFraction);
      if (fallback != null) candidates.push(fallback);
    }

    if (candidates.length === 0) return null;
    const maxInLower = this.rpmToSpeedKmh(
      car,
      gear - 1,
      Math.min(this.getUsablePowerCeiling(car, maxRpm).rpm, maxRpm * this.config.downshiftSafeRpmFraction)
    );
    const downshiftSpeed = Math.max(...candidates);
    return maxInLower != null ? Math.min(downshiftSpeed, maxInLower) : downshiftSpeed;
  }

  private getPowerDownshiftSpeedForGearKmh(car: CarProfile, gear: number, maxRpm: number): number | null {
    if (gear <= 1) return null;
    const usableCeiling = this.getUsablePowerCeiling(car, maxRpm).rpm;
    const safeLowerCeiling = Math.min(usableCeiling, maxRpm * this.config.downshiftSafeRpmFraction);
    const maxCurrentSpeed = this.rpmToSpeedKmh(car, gear, usableCeiling);
    const maxLowerSpeed = this.rpmToSpeedKmh(car, gear - 1, safeLowerCeiling);
    if (maxCurrentSpeed == null || maxLowerSpeed == null) return null;

    const maxSpeed = Math.max(1, Math.min(maxCurrentSpeed, maxLowerSpeed));
    const step = Math.max(0.5, maxSpeed / 240);
    const minAdvantage = this.config.minPowerAdvantageHp * this.config.downshiftAdvantageMultiplier;
    let threshold: number | null = null;

    for (let speed = step; speed <= maxSpeed; speed += step) {
      const currentRpm = this.speedToRpm(car, gear, speed);
      const lowerRpm = this.speedToRpm(car, gear - 1, speed);
      if (currentRpm == null || lowerRpm == null) continue;
      if (currentRpm < car.idleRpm * 1.1 || currentRpm > usableCeiling) continue;
      if (lowerRpm < car.idleRpm * 1.1 || lowerRpm > safeLowerCeiling) continue;

      const currentPower = this.lookupPower(car, currentRpm);
      const lowerPower = this.lookupPower(car, lowerRpm);
      if (currentPower === null || lowerPower === null) continue;

      const advantage = lowerPower - currentPower;
      const breakEvenSec = advantage > 0 ? currentPower * (this.getShiftPenaltyMs(car) / 1000) / advantage : Infinity;
      if (advantage >= minAdvantage && breakEvenSec < 2.0) threshold = speed;
    }

    return threshold;
  }

  private getUpshiftSpeedCapBlock(
    car: CarProfile,
    currentGear: number,
    targetGear: number,
    speedKmh: number,
    maxRpm: number
  ): { minSpeed: number; cappedGear: number } | null {
    if (targetGear <= currentGear) return null;
    for (let g = currentGear + 1; g <= targetGear; g++) {
      const minSpeed = this.getMinSpeedForGearKmh(car, g, maxRpm);
      if (minSpeed === null) continue;
      if (speedKmh + this.config.gearMinSpeedToleranceKmh < minSpeed) {
        return { minSpeed, cappedGear: g };
      }
    }
    return null;
  }

  private getLandingRpmInGear(car: CarProfile, targetGear: number, wheelRadS: number): number | null {
    const targetRatio = this.getGearRatio(car, targetGear);
    if (!targetRatio || wheelRadS < 1) return null;
    return this.wheelSpeedToRpm(wheelRadS, targetRatio);
  }

  private hasLearnedShiftModel(car: CarProfile, gear: number): boolean {
    return this.isGearDataComplete(car, gear) && this.getGearRatio(car, gear) !== null;
  }

  private getLearnedUpshiftRpm(car: CarProfile, gear: number, maxRpm: number): number | null {
    const fromRatio = this.getGearRatio(car, gear);
    const toRatio = this.getGearRatio(car, gear + 1);
    if (!fromRatio || !toRatio) return null;
    if (!this.hasLearnedShiftModel(car, gear) || !this.hasLearnedShiftModel(car, gear + 1)) return null;

    const usableCeiling = this.getUsablePowerCeiling(car, maxRpm).rpm;
    const peakRpm = car.peakPowerRpm > 0 ? car.peakPowerRpm : maxRpm * 0.72;
    const minUpshiftRpm = Math.max(car.idleRpm * 2.2, peakRpm + 450, maxRpm * 0.78);
    const startRpm = Math.max(minUpshiftRpm, maxRpm * 0.35);
    let best: number | null = null;

    for (let rpm = startRpm; rpm <= usableCeiling; rpm += this.config.rpmBinSize) {
      const nextRpm = rpm * toRatio / fromRatio;
      if (nextRpm < car.idleRpm * 1.1) continue;
      const currentPower = this.lookupPower(car, rpm);
      const nextPower = this.lookupPower(car, nextRpm);
      if (currentPower === null || nextPower === null) continue;
      const currentIsFalling = currentPower <= car.peakPower - this.config.minPowerAdvantageHp
        || rpm >= usableCeiling - Math.max(150, this.config.rpmBinSize * 10);
      if (currentIsFalling && nextPower >= currentPower - this.config.minPowerAdvantageHp) {
        best = rpm;
        break;
      }
    }

    return best ?? Math.min(usableCeiling, maxRpm * this.config.fallbackUpshiftFraction);
  }

  private getLearnedEntryRpm(car: CarProfile, gear: number, maxRpm: number): number | null {
    const currentRatio = this.getGearRatio(car, gear);
    const lowerRatio = this.getGearRatio(car, gear - 1);
    if (!currentRatio || !lowerRatio) return null;
    if (!this.hasLearnedShiftModel(car, gear) || !this.hasLearnedShiftModel(car, gear - 1)) return null;
    const lowerUpshiftRpm = this.getLearnedUpshiftRpm(car, gear - 1, maxRpm);
    if (lowerUpshiftRpm == null) return null;
    return lowerUpshiftRpm * currentRatio / lowerRatio;
  }

  private getLearnedDownshiftRpm(car: CarProfile, gear: number, maxRpm: number, upshiftRpm: number | null): number | null {
    const entryRpm = this.getLearnedEntryRpm(car, gear, maxRpm);
    if (entryRpm == null) return null;
    const hysteresisRpm = Math.max(this.config.rpmBinSize * 8, maxRpm * 0.04);
    const maxDownshiftRpm = upshiftRpm != null ? upshiftRpm - hysteresisRpm : this.getUsablePowerCeiling(car, maxRpm).rpm - hysteresisRpm;
    const minDownshiftRpm = Math.max(car.idleRpm * 1.4, maxRpm * 0.30);
    return Math.max(minDownshiftRpm, Math.min(entryRpm - hysteresisRpm, maxDownshiftRpm));
  }

  private getGearShiftThresholds(car: CarProfile, gear: number, highestLearnedGear: number, maxRpm: number): GearShiftThresholds {
    const usableCeiling = this.getUsablePowerCeiling(car, maxRpm).rpm;
    const fallbackUp = Math.min(usableCeiling, maxRpm * this.config.fallbackUpshiftFraction);
    const fallbackDown = Math.max(car.idleRpm * 1.5, maxRpm * 0.50);
    const canUseLearned = this.hasLearnedShiftModel(car, gear);
    const canDiscoverNextGear = gear < Math.min(this.config.maxGear, 6);

    if (canUseLearned) {
      const learnedUp = gear < highestLearnedGear ? this.getLearnedUpshiftRpm(car, gear, maxRpm) : null;
      const learnedDown = gear > 1 ? this.getLearnedDownshiftRpm(car, gear, maxRpm, learnedUp) : null;
      const hasKnownNextGear = gear < highestLearnedGear;
      const hasRequiredAdjacent = (!hasKnownNextGear || learnedUp !== null) && (gear <= 1 || learnedDown !== null);
      const hasValidBand = learnedDown == null || learnedUp == null || learnedDown < learnedUp - this.config.rpmBinSize;
      if (!hasKnownNextGear && canDiscoverNextGear) {
        return {
          downshiftRpm: gear > 1 ? learnedDown ?? fallbackDown : null,
          upshiftRpm: fallbackUp,
          source: "fallback",
          reason: `fallback missing learned next gear g${gear} highest=${highestLearnedGear} up=${fallbackUp.toFixed(0)}`,
        };
      }
      if (hasRequiredAdjacent) {
        if (!hasValidBand) {
          return {
            downshiftRpm: gear > 1 ? fallbackDown : null,
            upshiftRpm: gear < highestLearnedGear ? fallbackUp : null,
            source: "fallback",
            reason: `fallback invalid learned band g${gear} down=${learnedDown?.toFixed(0) ?? "-"} up=${learnedUp?.toFixed(0) ?? "-"}`,
          };
        }
        return {
          downshiftRpm: gear > 1 ? learnedDown : null,
          upshiftRpm: gear < highestLearnedGear ? learnedUp : null,
          source: "learned",
          reason: `learned thresholds g${gear} down=${learnedDown?.toFixed(0) ?? "-"} up=${learnedUp?.toFixed(0) ?? "-"}`,
        };
      }
    }

    return {
      downshiftRpm: gear > 1 ? fallbackDown : null,
      upshiftRpm: gear < this.config.maxGear ? fallbackUp : null,
      source: "fallback",
      reason: `fallback thresholds g${gear} down=${gear > 1 ? fallbackDown.toFixed(0) : "-"} up=${gear < this.config.maxGear ? fallbackUp.toFixed(0) : "-"}`,
    };
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
        const cliff = this.getCurveLookup(car).points
          .find(point => point.rpm > car.peakPowerRpm && point.power < car.peakPower * this.config.powerCliffRatio);
        if (cliff && cliff.rpm - this.config.rpmBinSize < ceiling) {
          ceiling = cliff.rpm - this.config.rpmBinSize;
          source = `power-cliff@${cliff.rpm}`;
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
    const downshiftSpeed = this.getDownshiftSpeedForGearKmh(car, currentGear, frame.max_rpm);
    const belowCurrentBand = frame.rpm < currentBandFloor
      && (downshiftSpeed == null || frame.speed_kmh <= downshiftSpeed + this.config.gearMinSpeedToleranceKmh);

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

    if (belowCurrentBand && best.rpm >= targetBandFloor * 0.92) {
      return {
        targetGear: best.gear,
        critical: braking || frame.rpm < car.idleRpm * 1.45,
        reason: `speed-band downshift: g${currentGear}->g${best.gear} speed=${frame.speed_kmh.toFixed(1)}km/h rpm ${frame.rpm}->${best.rpm.toFixed(0)} band>=${currentBandFloor.toFixed(0)}${downshiftSpeed != null ? ` threshold=${downshiftSpeed.toFixed(1)}km/h` : ""}`,
        trace: `context=speed-band target=g${best.gear} rpm=${best.rpm.toFixed(0)} curP=${currentPower?.toFixed(0) ?? "?"} tgtP=${best.power?.toFixed(0) ?? "?"}`,
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
    const curveSamples = this.getCurveLookup(car).totalSamples;
    const hasCurve = car.powerByRpm.size >= 8 && curveSamples >= this.config.minSamplesForLookup;
    return hasRatio && hasCurve;
  }

  private getHighestLearnedForwardGear(car: CarProfile): number {
    let highest = 1;
    for (const [gear, profile] of car.gears) {
      if (gear >= 1 && gear <= this.config.maxGear && profile.ratioCount >= 10) {
        highest = Math.max(highest, gear);
      }
    }
    return highest;
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
  private latestTelemetryClutch = 255;
  private latestTelemetryFrame: TelemetryFrame | null = null;
  private pendingShiftTiming: PendingShiftTiming | null = null;

  noteTelemetryGear(gear: number, clutch?: number, frame?: TelemetryFrame) {
    if (gear >= -1 && gear <= this.config.maxGear) this.latestTelemetryGear = gear;
    if (clutch != null && clutch >= 0 && clutch <= 255) this.latestTelemetryClutch = clutch;
    if (frame) this.latestTelemetryFrame = frame;
    this.completePendingShiftTiming();
  }

  private isShiftSynced(targetGear: number): boolean {
    return this.latestTelemetryGear === targetGear
      && this.latestTelemetryClutch <= this.config.clutchReleasedThreshold;
  }

  private hasRecentUnconfirmedShift(now: number, windowMs: number): boolean {
    return this.lastShiftTime > 0
      && now - this.lastShiftTime < windowMs
      && !this.isShiftSynced(this.lastShiftToGear);
  }

  private getRpmSettleGap(car: CarProfile, gear: number, wheelRadS: number, actualRpm: number): {
    expectedRpm: number;
    gapRpm: number;
    toleranceRpm: number;
  } | null {
    const ratio = this.getGearRatio(car, gear);
    if (!ratio || wheelRadS < 1) return null;
    const expectedRpm = this.wheelSpeedToRpm(wheelRadS, ratio);
    const toleranceRpm = Math.max(350, expectedRpm * this.config.downshiftSettleToleranceFraction);
    return {
      expectedRpm,
      gapRpm: expectedRpm - actualRpm,
      toleranceRpm,
    };
  }

  private getLatestTargetRpmSettleGap(car: CarProfile, targetGear: number): ReturnType<AdaptiveAutoShift["getRpmSettleGap"]> {
    const frame = this.latestTelemetryFrame;
    if (!frame || frame.gear !== targetGear) return null;
    return this.getRpmSettleGap(car, targetGear, this.getDrivenWheelSpeed(frame), frame.rpm);
  }

  private isTargetRpmSettled(car: CarProfile, targetGear: number): boolean {
    const settle = this.getLatestTargetRpmSettleGap(car, targetGear);
    if (!settle) return true;
    return Math.abs(settle.gapRpm) <= settle.toleranceRpm;
  }

  private isShiftOutputDisabled(): boolean {
    return loadConfig().shiftMode === "off";
  }

  private async keyAgentFetch(path: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.keyAgentRequestTimeoutMs);
    try {
      await fetch(`${KEY_AGENT}${path}`, { signal: controller.signal });
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.traceDecision(`KEY-AGENT request failed path=${path} timeout=${this.config.keyAgentRequestTimeoutMs}ms error=${message}`, true);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async holdGear(targetGear: number): Promise<boolean> {
    if (this.isShiftOutputDisabled()) {
      this.traceDecision(`READONLY hold skipped target=${targetGear}`, true);
      return true;
    }
    if (targetGear === this.heldGear) return true;
    const ok = await this.keyAgentFetch(`/gear/hold/${targetGear}`);
    if (!ok) return false;
    this.heldGear = targetGear;
    this.autoHolding = true;
    return true;
  }

  private beginShiftTiming(car: CarProfile, direction: "up" | "down", fromGear: number, toGear: number, source: "auto" | "manual") {
    this.pendingShiftTiming = {
      carOrdinal: car.ordinal,
      direction,
      fromGear,
      toGear,
      source,
      startedAt: Date.now(),
    };
  }

  private completePendingShiftTiming() {
    const pending = this.pendingShiftTiming;
    if (!pending || !this.isShiftSynced(pending.toGear)) return;
    const car = this.carProfiles.get(pending.carOrdinal);
    if (!car) {
      this.pendingShiftTiming = null;
      return;
    }

    const elapsedMs = Date.now() - pending.startedAt;
    if (elapsedMs < 40 || elapsedMs > this.config.shiftExecutionTimeoutMs) {
      this.traceDecision(`SHIFT-TIME ignored ${pending.fromGear}->${pending.toGear} ${elapsedMs}ms source=${pending.source}`, true);
      this.pendingShiftTiming = null;
      return;
    }

    this.recordShiftTime(car, pending.direction, elapsedMs);
    this.traceDecision(`SHIFT-TIME ${pending.direction} ${pending.fromGear}->${pending.toGear} ${elapsedMs}ms avg=${car.shiftTiming.avgMs.toFixed(0)} ewma=${car.shiftTiming.ewmaMs.toFixed(0)} n=${car.shiftTiming.samples} source=${pending.source}`, true);
    this.pendingShiftTiming = null;
  }

  private recordShiftTime(car: CarProfile, direction: "up" | "down", elapsedMs: number) {
    const st = car.shiftTiming;
    st.samples++;
    st.lastMs = elapsedMs;
    st.avgMs += (elapsedMs - st.avgMs) / st.samples;
    st.ewmaMs = st.ewmaMs > 0 ? st.ewmaMs * 0.82 + elapsedMs * 0.18 : elapsedMs;
    st.minMs = st.minMs > 0 ? Math.min(st.minMs, elapsedMs) : elapsedMs;
    st.maxMs = Math.max(st.maxMs, elapsedMs);
    if (direction === "up") {
      st.upSamples++;
      st.upAvgMs += (elapsedMs - st.upAvgMs) / st.upSamples;
    } else {
      st.downSamples++;
      st.downAvgMs += (elapsedMs - st.downAvgMs) / st.downSamples;
    }
    this.dirty = true;
  }

  private getShiftPenaltyMs(car: CarProfile): number {
    const learned = car.shiftTiming.ewmaMs || car.shiftTiming.avgMs;
    if (car.shiftTiming.samples < 3 || learned <= 0) return this.config.shiftTimePenaltyMs;
    return Math.max(120, Math.min(this.config.shiftExecutionTimeoutMs, learned));
  }

  private async executeShiftCommand(car: CarProfile, direction: "up" | "down", fromGear: number, targetGear: number) {
    if (this.isShiftOutputDisabled()) {
      this.traceDecision(`READONLY ${direction} ${fromGear}->${targetGear} output disabled`, true);
      return;
    }
    this.shiftExecutionLocked = true;
    try {
      this.beginShiftTiming(car, direction, fromGear, targetGear, "auto");
      const commandSent = await this.holdGear(targetGear);
      if (!commandSent) {
        this.pendingShiftTiming = null;
        this.traceDecision(`SYNC abort ${direction} ${fromGear}->${targetGear} key-agent command failed`, true);
        return;
      }

      const deadline = Date.now() + this.config.shiftExecutionTimeoutMs;
      while (!this.isShiftSynced(targetGear) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      this.completePendingShiftTiming();

      if (this.isShiftSynced(targetGear)) {
        this.traceDecision(`SYNC gear target=${targetGear} clutch=${this.latestTelemetryClutch} confirmed`, true);
        const settleDeadline = Date.now() + this.config.shiftRpmSettleTimeoutMs;
        while (!this.isTargetRpmSettled(car, targetGear) && Date.now() < settleDeadline) {
          await Bun.sleep(10);
        }
        const settle = this.getLatestTargetRpmSettleGap(car, targetGear);
        if (settle && Math.abs(settle.gapRpm) > settle.toleranceRpm) {
          this.traceDecision(`SYNC rpm-settle timeout target=${targetGear} rpm=${this.latestTelemetryFrame?.rpm.toFixed(0) ?? "?"} expected=${settle.expectedRpm.toFixed(0)} gap=${settle.gapRpm.toFixed(0)} tol=${settle.toleranceRpm.toFixed(0)}`, true);
        } else if (settle) {
          this.traceDecision(`SYNC rpm-settled target=${targetGear} rpm=${this.latestTelemetryFrame?.rpm.toFixed(0) ?? "?"} expected=${settle.expectedRpm.toFixed(0)} gap=${settle.gapRpm.toFixed(0)} tol=${settle.toleranceRpm.toFixed(0)}`, true);
        }
      } else {
        this.traceDecision(`SYNC timeout target=${targetGear} telemetry=${this.latestTelemetryGear} clutch=${this.latestTelemetryClutch}`, true);
        this.pendingShiftTiming = null;
      }
    } finally {
      this.shiftExecutionLocked = false;
    }
  }

  private async releaseGear() {
    if (!this.autoHolding) return;
    if (this.isShiftOutputDisabled()) {
      this.heldGear = -99;
      this.autoHolding = false;
      return;
    }
    await this.keyAgentFetch("/gear/release");
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

  private evaluateShiftDecision(
    car: CarProfile,
    frame: TelemetryFrame,
    gear: number,
    wheelRadS: number,
    effectiveCeiling: number,
    highestLearnedGear: number,
    options: { hysteresisMultiplier?: number } = {}
  ): ShiftDecision {
    const { rpm, max_rpm, idle_rpm, speed_kmh, brake } = frame;
    const thresholds = this.getGearShiftThresholds(car, gear, highestLearnedGear, max_rpm);
    let wantShift: ShiftIntent = null;
    let targetGear = gear;
    let reason = "";
    let criticalShift = false;
    const decisionTrace = `mode=threshold source=${thresholds.source} gear=${gear} rpm=${rpm.toFixed(0)} down=${thresholds.downshiftRpm?.toFixed(0) ?? "-"} up=${thresholds.upshiftRpm?.toFixed(0) ?? "-"}`;

    const maxUpshiftGear = thresholds.source === "fallback" ? this.config.maxGear : highestLearnedGear;
    if (thresholds.upshiftRpm !== null && rpm >= thresholds.upshiftRpm && gear < maxUpshiftGear) {
      wantShift = "up";
      targetGear = gear + 1;
      criticalShift = rpm >= effectiveCeiling || rpm >= max_rpm * 0.96;
      reason = `threshold upshift: g${gear}->g${targetGear} RPM ${rpm.toFixed(0)}>=${thresholds.upshiftRpm.toFixed(0)} [${thresholds.source}]`;
    } else if (thresholds.downshiftRpm !== null && rpm <= thresholds.downshiftRpm && gear > 1 && speed_kmh > 10) {
      wantShift = "down";
      targetGear = gear - 1;
      criticalShift = rpm < idle_rpm * 1.45 || brake / 255 >= this.config.downshiftPrepBrake;
      reason = `threshold downshift: g${gear}->g${targetGear} RPM ${rpm.toFixed(0)}<=${thresholds.downshiftRpm.toFixed(0)} [${thresholds.source}]`;
    }

    return {
      wantShift,
      targetGear,
      reason,
      decisionTrace,
      shiftAdvantage: 0,
      breakEvenSec: Infinity,
      effectiveMinAdvantage: this.config.minPowerAdvantageHp,
      criticalShift,
      holdReason: `hold (${thresholds.source} thresholds)`,
    };
  }

  private makeStableBaselineFrame(car: CarProfile, gear: number, rpm: number): { frame: TelemetryFrame; wheelRadS: number } | null {
    const ratio = this.getGearRatio(car, gear);
    const speedKmh = this.rpmToSpeedKmh(car, gear, rpm);
    if (!ratio || speedKmh == null) return null;
    const engineRadS = rpm * 2 * Math.PI / 60;
    const wheelRadS = engineRadS / ratio;
    return {
      wheelRadS,
      frame: {
        rpm,
        max_rpm: car.maxRpm,
        idle_rpm: car.idleRpm,
        gear,
        power_hp: this.lookupPower(car, rpm) ?? 0,
        torque_nm: 0,
        speed_kmh: speedKmh,
        accel: Math.round(0.70 * 255),
        brake: 0,
        clutch: 0,
        g_lat: 0,
        g_lon: 0,
        tire_slip: [0, 0, 0, 0],
        steer: 0,
        car_ordinal: car.ordinal,
        car_class: "",
        car_pi: 0,
        drivetrain: "AWD",
        susp_travel: [0.5, 0.5, 0.5, 0.5],
        wheel_speed: [wheelRadS, wheelRadS, wheelRadS, wheelRadS],
        rumble_strip: [0, 0, 0, 0],
        puddle_depth: [0, 0, 0, 0],
      },
    };
  }

  private computeDecisionScanBand(car: CarProfile, gear: number): {
    leftRpm: number | null;
    rightRpm: number | null;
    leftReason: string | null;
    rightReason: string | null;
    source: "shift-thresholds";
    thresholdSource: "learned" | "fallback" | "unavailable";
    context: "stable-baseline";
    stepRpm: number;
    unavailableReason?: string;
  } {
    const stepRpm = Math.max(this.config.rpmBinSize, 25);

    const highestLearnedGear = this.getHighestLearnedForwardGear(car);
    const thresholds = this.getGearShiftThresholds(car, gear, highestLearnedGear, car.maxRpm);
    const ceiling = this.getUsablePowerCeiling(car, car.maxRpm).rpm;
    const leftRpm = thresholds.downshiftRpm ?? car.idleRpm;
    const rightRpm = thresholds.upshiftRpm ?? ceiling;
    const leftReason = thresholds.downshiftRpm !== null ? `downshift<=${thresholds.downshiftRpm.toFixed(0)} [${thresholds.source}]` : "first gear";
    const rightReason = thresholds.upshiftRpm !== null ? `upshift>=${thresholds.upshiftRpm.toFixed(0)} [${thresholds.source}]` : "top gear";

    if (leftRpm == null || rightRpm == null || rightRpm <= leftRpm) {
      return { leftRpm, rightRpm, leftReason, rightReason, source: "shift-thresholds", thresholdSource: thresholds.source, context: "stable-baseline", stepRpm, unavailableReason: "no-hold-band" };
    }
    return { leftRpm, rightRpm, leftReason, rightReason, source: "shift-thresholds", thresholdSource: thresholds.source, context: "stable-baseline", stepRpm };
  }

  // --- Main update ---

  async update(frame: TelemetryFrame): Promise<{ action: string | null; reason: string }> {
    if (!this.enabled) return { action: null, reason: "disabled" };
    this.noteTelemetryGear(frame.gear, frame.clutch, frame);
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

    // Update shift-specific measurements; the power curve arrives asynchronously.
    this.recordSample(car, frame);
    this.maybeSave();

    // Skip invalid states
    if (gear < 1 || gear > this.config.maxGear) return { action: null, reason: `gear=${gear}` };
    if (this.hasRecentUnconfirmedShift(now, this.config.shiftCooldownMs)) {
      return { action: null, reason: "waiting for gear sync" };
    }

    const maxSlip = Math.max(...(tire_slip || [0]));
    const susp = frame.susp_travel || [0.5, 0.5, 0.5, 0.5];
    const suspMin = Math.min(...susp);

    // Airborne protection
    if (suspMin < 0.05) return { action: null, reason: "airborne" };

    // Get driven wheel speed for cross-gear comparison (used below)
    const wheelRadS = this.getDrivenWheelSpeed(frame);
    const highestLearnedGear = this.getHighestLearnedForwardGear(car);

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
      await this.executeShiftCommand(car, "down", gear, 1);
      return { action: "downshift", reason: r };
    }

    // ========== FUEL-CUT ABSOLUTE CEILING ==========
    // If we've learned the fuel-cut RPM, force upshift before hitting it.
    // This overrides everything — even if the algorithm hasn't decided yet.
    const usableCeiling = this.getUsablePowerCeiling(car, max_rpm);
    const effectiveCeiling = usableCeiling.rpm;

    const canDiscoverNextGear = gear < Math.min(this.config.maxGear, 6);
    const ceilingMaxGear = this.hasLearnedShiftModel(car, gear) && highestLearnedGear > gear
      ? highestLearnedGear
      : canDiscoverNextGear ? this.config.maxGear : highestLearnedGear;
    if (rpm >= effectiveCeiling && gear < ceilingMaxGear) {
      if (now < this.nextCeilingUpshiftAt) {
        const waitMs = this.nextCeilingUpshiftAt - now;
        this.traceDecision(`BLOCK ceiling-cooldown up ${gear}->${gear + 1} wait=${waitMs.toFixed(0)}ms rpm=${rpm} ceiling=${effectiveCeiling.toFixed(0)} source=${usableCeiling.source}`, true);
        return { action: null, reason: `ceiling cooldown ${waitMs.toFixed(0)}ms` };
      }
      const speedCap = this.getUpshiftSpeedCapBlock(car, gear, gear + 1, speed_kmh, max_rpm);
      if (speedCap) {
        const overrideMinSpeed = speedCap.minSpeed * 0.8;
        if (speed_kmh + this.config.gearMinSpeedToleranceKmh < overrideMinSpeed) {
          this.traceDecision(`BLOCK speed-cap ceiling up ${gear}->${gear + 1} speed=${speed_kmh.toFixed(1)} min=${speedCap.minSpeed.toFixed(1)} overrideMin=${overrideMinSpeed.toFixed(1)} capped=g${speedCap.cappedGear} rpm=${rpm} slip=${maxSlip.toFixed(2)}`, true);
          return { action: null, reason: `speed-cap g${speedCap.cappedGear} min ${overrideMinSpeed.toFixed(1)}km/h` };
        }
        this.traceDecision(`ALLOW ceiling override speed-cap up ${gear}->${gear + 1} speed=${speed_kmh.toFixed(1)} min=${speedCap.minSpeed.toFixed(1)} overrideMin=${overrideMinSpeed.toFixed(1)} rpm=${rpm}`, true);
      }
      const landingRpm = this.getLandingRpmInGear(car, gear + 1, wheelRadS);
      if (landingRpm !== null && landingRpm < idle_rpm * 1.1) {
        this.traceDecision(`BLOCK low-landing ceiling up ${gear}->${gear + 1} speed=${speed_kmh.toFixed(1)} landing=${landingRpm.toFixed(0)} min=${(idle_rpm * 1.1).toFixed(0)} rpm=${rpm} slip=${maxSlip.toFixed(2)}`, true);
        return { action: null, reason: `landing rpm too low ${landingRpm.toFixed(0)}` };
      }
      // Immediate upshift — fuel cut imminent
      const fuelCutTag = usableCeiling.source;
      this.lastShiftTime = now;
      this.lastShiftDirection = "up";
      this.lastShiftFromGear = gear;
      this.lastShiftToGear = gear + 1;
      this.nextCeilingUpshiftAt = now + this.config.ceilingUpshiftCooldownMs;
      this.recentShiftTimes.push(now);
      car.totalShifts++;
      const r = `CEILING: RPM ${rpm} >= ${effectiveCeiling.toFixed(0)} (${fuelCutTag}) -> forced upshift ${gear}->${gear + 1}`;
      this.log(`UP: ${r}`);
      this.traceDecision(`EXEC ceiling up ${gear}->${gear + 1} rpm=${rpm} ceiling=${effectiveCeiling.toFixed(0)} source=${fuelCutTag} slip=${maxSlip.toFixed(2)} wheel=${wheelRadS.toFixed(2)}`, true);
      await this.executeShiftCommand(car, "up", gear, gear + 1);
      return { action: "upshift", reason: r };
    }

    // ========== FIRST-PRINCIPLES SHIFT DECISION ==========
    //
    // Strategy depends on data completeness:
    //   A) Have power curves + ratios for current & adjacent gears → power comparison
    //   B) Incomplete data → redline shifting (upshift near max RPM, downshift at low RPM)

    const decision = this.evaluateShiftDecision(car, frame, gear, wheelRadS, effectiveCeiling, highestLearnedGear);
    const {
      wantShift,
      targetGear,
      reason,
      decisionTrace,
      shiftAdvantage,
      breakEvenSec,
      effectiveMinAdvantage,
      criticalShift,
    } = decision;

    if (!wantShift) {
      if (decision.thresholdTrace) this.traceDecision(decision.thresholdTrace);
      if (decisionTrace) {
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
      return { action: null, reason: decision.holdReason };
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

    if (!criticalShift && this.hasRecentUnconfirmedShift(now, this.config.minGearHoldMs)) {
      this.traceDecision(`BLOCK unsynced-settle ${wantShift} gear=${gear} last=${this.lastShiftDirection} ${this.lastShiftFromGear}->${this.lastShiftToGear} age=${msSinceShift}ms telem=${this.latestTelemetryGear} clutch=${this.latestTelemetryClutch} reason=${reason}`);
      return { action: null, reason: "waiting for gear sync" };
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
      const speedCap = this.getUpshiftSpeedCapBlock(car, gear, targetGear, speed_kmh, max_rpm);
      if (speedCap) {
        this.traceDecision(`BLOCK speed-cap up ${gear}->${targetGear} speed=${speed_kmh.toFixed(1)} min=${speedCap.minSpeed.toFixed(1)} capped=g${speedCap.cappedGear} reason=${reason}`, true);
        return { action: null, reason: `speed-cap g${speedCap.cappedGear} min ${speedCap.minSpeed.toFixed(1)}km/h` };
      }
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

    if (wantShift === "down") {
      const landingRpm = this.getLandingRpmInGear(car, targetGear, wheelRadS);
      const safeDownshiftCeiling = Math.min(effectiveCeiling, max_rpm * this.config.downshiftSafeRpmFraction);
      if (landingRpm !== null && landingRpm > safeDownshiftCeiling) {
        this.traceDecision(`BLOCK overrev down ${gear}->${targetGear} speed=${speed_kmh.toFixed(1)} landing=${landingRpm.toFixed(0)} safe=${safeDownshiftCeiling.toFixed(0)} reason=${reason}`, true);
        return { action: null, reason: `downshift overrev ${landingRpm.toFixed(0)}>${safeDownshiftCeiling.toFixed(0)}` };
      }

      const settling = this.lastShiftDirection === "down"
        && gear === this.lastShiftToGear
        && msSinceShift < this.config.downshiftSettleMs
        ? this.getRpmSettleGap(car, gear, wheelRadS, rpm)
        : null;
      if (settling && settling.gapRpm > settling.toleranceRpm) {
        this.traceDecision(`BLOCK downshift-settle ${gear}->${targetGear} age=${msSinceShift}ms rpm=${rpm.toFixed(0)} expected=${settling.expectedRpm.toFixed(0)} gap=${settling.gapRpm.toFixed(0)} tol=${settling.toleranceRpm.toFixed(0)} reason=${reason}`, true);
        return { action: null, reason: "waiting for rpm settle" };
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
    await this.executeShiftCommand(car, wantShift, gear, targetGear);
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

  getPowerCurveSeeds(): PowerCurveSeed[] {
    return [...this.carProfiles.entries()].map(([carKey, car]) => ({
      carKey,
      bins: [...car.powerByRpm.entries()].map(([rpm, bin]) => ({
        rpm,
        count: bin.count,
        torqueSamples: [...bin.torqueSamples],
      })),
    }));
  }

  applyPowerCurveSnapshot(snapshot: PowerCurveSnapshot | null) {
    const source = snapshot?.car;
    if (!source || snapshot.revision === this.lastPowerCurveRevision) return;
    const car = this.carProfiles.get(source.carKey);
    if (!car) return;
    this.lastPowerCurveRevision = snapshot.revision;

    const powerByRpm = new Map<number, PowerBin>();
    for (const point of source.powerCurve) {
      const torqueNm = this.torqueFromPower(point.rpm, point.hp);
      powerByRpm.set(point.rpm, {
        torqueNm,
        count: Math.max(2, point.samples),
        max: point.hp,
        torqueSamples: [torqueNm],
      });
    }
    car.powerByRpm = powerByRpm;
    car.peakPower = source.peakHp;
    car.peakPowerRpm = source.peakHpRpm;
    car.maxObservedRpm = Math.max(0, ...powerByRpm.keys());
    this.curveLookupCache.delete(car);
    this.dirty = true;
  }

  getOverlayStatus() {
    const car = this.currentCar;
    const curveSummary = car
      ? this.getCurveLookup(car).points.map(point => ({ rpm: point.rpm, hp: +point.power.toFixed(1) }))
      : [];
    const gears: Record<number, any> = {};
    let learningStatus: "learning" | "complete" = "learning";
    const fallbackGears: number[] = [];
    if (car) {
      const forwardGearCount = [...car.gears.keys()].filter(g => g >= 1 && g <= this.config.maxGear).length;
      let learnedGearCount = 0;
      for (const [g, p] of car.gears) {
        if (g < 1 || g > this.config.maxGear) continue;
        const avgRatio = p.ratioCount > 10 ? p.ratioSum / p.ratioCount : null;
        const band = this.computeDecisionScanBand(car, g);
        if (band.thresholdSource === "learned") learnedGearCount++;
        if (band.thresholdSource === "fallback") fallbackGears.push(g);
        gears[g] = {
          ratio: avgRatio ? +avgRatio.toFixed(3) : null,
          ratioSamples: p.ratioCount,
          leftRpm: band.leftRpm != null ? +band.leftRpm.toFixed(0) : null,
          rightRpm: band.rightRpm != null ? +band.rightRpm.toFixed(0) : null,
          downshiftRpm: band.leftRpm != null ? +band.leftRpm.toFixed(0) : null,
          upshiftRpm: band.rightRpm != null ? +band.rightRpm.toFixed(0) : null,
          source: band.source,
          thresholdSource: band.thresholdSource,
          context: band.context,
          stepRpm: band.stepRpm,
          leftReason: band.leftReason,
          rightReason: band.rightReason,
          unavailableReason: band.unavailableReason ?? null,
        };
      }
      learningStatus = forwardGearCount > 0 && learnedGearCount === forwardGearCount ? "complete" : "learning";
    }
    return {
      enabled: this.enabled,
      currentCar: this.currentOrdinal,
      learningStatus,
      fallbackGears,
      blockUpshift: Date.now() < this.blockUpshiftUntil,
      blockDownshift: Date.now() < this.blockDownshiftUntil,
      lastShift: this.lastShiftDirection ? {
        direction: this.lastShiftDirection,
        from: this.lastShiftFromGear,
        to: this.lastShiftToGear,
        ageMs: Date.now() - this.lastShiftTime,
      } : null,
      car: car ? {
        totalSamples: car.totalSamples,
        powerBins: car.powerByRpm.size,
        maxRpm: car.maxRpm,
        idleRpm: car.idleRpm,
        peakHp: +car.peakPower.toFixed(1),
        peakHpRpm: car.peakPowerRpm,
        fuelCutRpm: car.fuelCutRpm || null,
        shiftTiming: {
          samples: car.shiftTiming.samples,
          avgMs: +car.shiftTiming.avgMs.toFixed(1),
          ewmaMs: +car.shiftTiming.ewmaMs.toFixed(1),
          activePenaltyMs: +this.getShiftPenaltyMs(car).toFixed(1),
        },
        powerCurve: curveSummary,
        gears,
      } : null,
    };
  }

  getStatus() {
    const cars: Record<number, any> = {};
    for (const [ordinal, car] of this.carProfiles) {
      const curveSummary = this.getCurveLookup(car).points
        .map(point => ({ rpm: point.rpm, hp: +point.power.toFixed(1) }));
      const gears: Record<number, any> = {};
      for (const [g, p] of car.gears) {
        const avgRatio = p.ratioCount > 10 ? p.ratioSum / p.ratioCount : null;
        const minSpeed = this.getMinSpeedForGearKmh(car, g, car.maxRpm);
        const downshiftSpeed = this.getDownshiftSpeedForGearKmh(car, g, car.maxRpm);
        gears[g] = {
          samples: p.sampleCount,
          ratio: avgRatio ? +avgRatio.toFixed(3) : null,
          ratioSamples: p.ratioCount,
          minSpeedKmh: minSpeed != null ? +minSpeed.toFixed(1) : null,
          downshiftSpeedKmh: downshiftSpeed != null ? +downshiftSpeed.toFixed(1) : null,
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
        wheelRadiusM: this.getWheelRadiusM(car),
        wheelRadiusSamples: car.wheelRadiusCount,
        shiftTiming: {
          samples: car.shiftTiming.samples,
          avgMs: +car.shiftTiming.avgMs.toFixed(1),
          ewmaMs: +car.shiftTiming.ewmaMs.toFixed(1),
          minMs: +car.shiftTiming.minMs.toFixed(1),
          maxMs: +car.shiftTiming.maxMs.toFixed(1),
          lastMs: +car.shiftTiming.lastMs.toFixed(1),
          upSamples: car.shiftTiming.upSamples,
          upAvgMs: +car.shiftTiming.upAvgMs.toFixed(1),
          downSamples: car.shiftTiming.downSamples,
          downAvgMs: +car.shiftTiming.downAvgMs.toFixed(1),
          activePenaltyMs: +this.getShiftPenaltyMs(car).toFixed(1),
        },
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
      pendingShiftTiming: this.pendingShiftTiming ? {
        direction: this.pendingShiftTiming.direction,
        from: this.pendingShiftTiming.fromGear,
        to: this.pendingShiftTiming.toGear,
        source: this.pendingShiftTiming.source,
        ageMs: Date.now() - this.pendingShiftTiming.startedAt,
      } : null,
      shiftExecutionLocked: this.shiftExecutionLocked,
      algorithm: "first-principles power-curve lookup",
      cars,
      recentShifts: this.shiftLog.slice(-30),
      decisionTrace: this.decisionLog.slice(-80),
    };
  }

  exportShiftFixture(carKey = this.currentOrdinal) {
    const car = this.carProfiles.get(carKey);
    if (!car) return null;
    const highestLearnedGear = this.getHighestLearnedForwardGear(car);
    const gears: Record<number, any> = {};
    for (const [g, p] of [...car.gears.entries()].sort((a, b) => a[0] - b[0])) {
      if (g < 1 || g > this.config.maxGear) continue;
      const ratio = p.ratioCount > 0 ? p.ratioSum / p.ratioCount : null;
      const thresholds = this.getGearShiftThresholds(car, g, highestLearnedGear, car.maxRpm);
      gears[g] = {
        sampleCount: p.sampleCount,
        ratioCount: p.ratioCount,
        ratio: ratio != null ? +ratio.toFixed(6) : null,
        complete: this.isGearDataComplete(car, g),
        downshiftRpm: thresholds.downshiftRpm != null ? +thresholds.downshiftRpm.toFixed(0) : null,
        upshiftRpm: thresholds.upshiftRpm != null ? +thresholds.upshiftRpm.toFixed(0) : null,
        thresholdSource: thresholds.source,
        thresholdReason: thresholds.reason,
      };
    }
    return {
      schema: "tgt2.autoshift.fixture.v1",
      exportedAt: new Date().toISOString(),
      carKey,
      ordinal: car.ordinal,
      maxRpm: car.maxRpm,
      idleRpm: car.idleRpm,
      peakPower: +car.peakPower.toFixed(1),
      peakPowerRpm: car.peakPowerRpm,
      fuelCutRpm: car.fuelCutRpm || null,
      fuelCutConfidence: car.fuelCutConfidence || 0,
      wheelRadius: this.getWheelRadiusM(car),
      wheelRadiusCount: car.wheelRadiusCount,
      totalSamples: car.totalSamples,
      totalShifts: car.totalShifts,
      highestLearnedGear,
      learningStatus: Object.values(gears).every((g: any) => g.thresholdSource === "learned") ? "complete" : "learning",
      gears,
      powerCurve: this.getCurveLookup(car).points.map(point => ({
        rpm: point.rpm,
        hp: +point.power.toFixed(3),
      })),
    };
  }
}

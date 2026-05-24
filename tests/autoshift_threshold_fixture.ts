import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type GearThresholds = {
  downshiftRpm: number | null;
  upshiftRpm: number | null;
  source: "learned" | "fallback";
  reason: string;
};

type GearSummary = {
  gear: number;
  ratio: number | null;
  ratioSamples: number;
  downshiftRpm: number | null;
  upshiftRpm: number | null;
  source: string;
  reason: string;
};

const root = resolve(import.meta.dir, "..");
const fixturePath = join(root, "test-fixtures", "autoshift", "current-car-569060862.profile.json");
const runtimeAppData = join(root, "test-fixtures", "autoshift", ".runtime-appdata");
const runtimeCarsDir = join(runtimeAppData, "TGT2Telemetry", "data", "cars");

if (!existsSync(fixturePath)) {
  throw new Error(`Missing fixture: ${fixturePath}`);
}

rmSync(runtimeAppData, { recursive: true, force: true });
mkdirSync(runtimeCarsDir, { recursive: true });

const profile = JSON.parse(await Bun.file(fixturePath).text());
const runtimeProfilePath = join(runtimeCarsDir, `${profile.carKey}.json`);
writeFileSync(runtimeProfilePath, JSON.stringify(profile, null, 2));

process.env.LOCALAPPDATA = runtimeAppData;
const { AdaptiveAutoShift } = await import("../src/autoshift");

const autoShift = new AdaptiveAutoShift() as any;
const car = autoShift.carProfiles.get(profile.carKey);
if (!car) {
  throw new Error(`AdaptiveAutoShift did not load fixture car ${profile.carKey}`);
}

const highestLearnedGear = autoShift.getHighestLearnedForwardGear(car);
const rows: GearSummary[] = [];

for (const [gear, gearProfile] of [...car.gears.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  if (gear < 1 || gear > autoShift.config.maxGear) continue;
  const thresholds = autoShift.getGearShiftThresholds(car, gear, highestLearnedGear, car.maxRpm) as GearThresholds;
  const ratio = gearProfile.ratioCount > 0 ? gearProfile.ratioSum / gearProfile.ratioCount : null;
  rows.push({
    gear,
    ratio: ratio == null ? null : Math.round(ratio * 1000000) / 1000000,
    ratioSamples: gearProfile.ratioCount,
    downshiftRpm: thresholds.downshiftRpm == null ? null : Math.round(thresholds.downshiftRpm),
    upshiftRpm: thresholds.upshiftRpm == null ? null : Math.round(thresholds.upshiftRpm),
    source: thresholds.source,
    reason: thresholds.reason,
  });
}

const invalid = rows.filter(row =>
  row.downshiftRpm != null && row.upshiftRpm != null && row.downshiftRpm >= row.upshiftRpm
);

console.log(JSON.stringify({
  fixture: fixturePath,
  carKey: profile.carKey,
  maxRpm: car.maxRpm,
  idleRpm: car.idleRpm,
  peakPowerRpm: car.peakPowerRpm,
  fuelCutRpm: car.fuelCutRpm,
  highestLearnedGear,
  gears: rows,
}, null, 2));

if (invalid.length > 0) {
  console.error(`Invalid threshold bands: ${invalid.map(row => `G${row.gear} ${row.downshiftRpm}>=${row.upshiftRpm}`).join(", ")}`);
  process.exit(1);
}

const gear2 = car.gears.get(2);
if (gear2) {
  const originalRatioCount = gear2.ratioCount;
  const originalRatioSum = gear2.ratioSum;
  const originalMaxRpm = car.maxRpm;
  const originalPeakPower = car.peakPower;
  const originalPeakPowerRpm = car.peakPowerRpm;
  const originalFuelCutRpm = car.fuelCutRpm;
  const originalFuelCutConfidence = car.fuelCutConfidence;
  gear2.ratioCount = Math.min(5, originalRatioCount);
  gear2.ratioSum = originalRatioCount > 0 ? originalRatioSum * gear2.ratioCount / originalRatioCount : 0;
  const minSpeedForUnlearnedG2 = autoShift.getMinSpeedForGearKmh(car, 2, car.maxRpm);
  if (minSpeedForUnlearnedG2 !== null) {
    console.error(`Unlearned G2 should not create speed-cap min speed, got ${minSpeedForUnlearnedG2}`);
    process.exit(1);
  }

  const highestWithUnlearnedG2 = autoShift.getHighestLearnedForwardGear(car);
  const g1Fallback = autoShift.getGearShiftThresholds(car, 1, highestWithUnlearnedG2, car.maxRpm) as GearThresholds;
  if (g1Fallback.upshiftRpm == null || g1Fallback.upshiftRpm > car.maxRpm * 0.93) {
    console.error(`Unlearned G2 should keep G1 fallback upshift near redline fallback, got ${g1Fallback.upshiftRpm}`);
    process.exit(1);
  }
  car.maxRpm = 11000;
  car.peakPower = Math.max(car.peakPower, 600);
  car.peakPowerRpm = 10230;
  car.fuelCutRpm = 0;
  car.fuelCutConfidence = 0;
  const highRpmFallback = autoShift.getGearShiftThresholds(car, 1, highestWithUnlearnedG2, car.maxRpm) as GearThresholds;
  if (Math.round(highRpmFallback.upshiftRpm ?? 0) !== Math.round(car.maxRpm * 0.92)) {
    console.error(`High-RPM unlearned G1 should fallback at 0.92 redline, got ${highRpmFallback.upshiftRpm}`);
    process.exit(1);
  }
  const minCredibleFuelCutRpm = autoShift.getMinCredibleFuelCutRpm(car);
  if (minCredibleFuelCutRpm > 10100) {
    console.error(`High-RPM peak should not require fuel-cut above 10100rpm, got min=${minCredibleFuelCutRpm}`);
    process.exit(1);
  }
  car.maxRpm = originalMaxRpm;
  car.peakPower = originalPeakPower;
  car.peakPowerRpm = originalPeakPowerRpm;
  car.fuelCutRpm = originalFuelCutRpm;
  car.fuelCutConfidence = originalFuelCutConfidence;
  gear2.ratioCount = originalRatioCount;
  gear2.ratioSum = originalRatioSum;
}

const gear4 = car.gears.get(4);
const gear5 = car.gears.get(5);
const gear6 = car.gears.get(6);
const gear7 = car.gears.get(7);
if (gear4 && gear5 && gear6) {
  const originalG5 = { ratioSum: gear5.ratioSum, ratioCount: gear5.ratioCount };
  const originalG6 = { ratioSum: gear6.ratioSum, ratioCount: gear6.ratioCount };
  const originalG7 = gear7 ? { ratioSum: gear7.ratioSum, ratioCount: gear7.ratioCount } : null;
  const g4Ratio = gear4.ratioSum / gear4.ratioCount;
  gear5.ratioCount = 20;
  gear5.ratioSum = g4Ratio * 1.12 * gear5.ratioCount;
  gear6.ratioCount = 20;
  gear6.ratioSum = g4Ratio * 1.35 * gear6.ratioCount;
  if (gear7) {
    gear7.ratioCount = 20;
    gear7.ratioSum = g4Ratio * 0.45 * gear7.ratioCount;
  }

  if (autoShift.getGearRatio(car, 5) !== null || autoShift.getGearRatio(car, 6) !== null || (gear7 && autoShift.getGearRatio(car, 7) !== null)) {
    console.error("Non-contiguous or non-monotonic learned gear ratios should be rejected");
    process.exit(1);
  }
  const highestContiguous = autoShift.getHighestContiguousRatioGear(car);
  if (highestContiguous !== 4) {
    console.error(`Expected contiguous ratio prefix through G4 after G5 pollution, got G${highestContiguous}`);
    process.exit(1);
  }
  const g4Fallback = autoShift.getGearShiftThresholds(car, 4, autoShift.getHighestLearnedForwardGear(car), car.maxRpm) as GearThresholds;
  const g5Fallback = autoShift.getGearShiftThresholds(car, 5, autoShift.getHighestLearnedForwardGear(car), car.maxRpm) as GearThresholds;
  if (g4Fallback.upshiftRpm == null || g5Fallback.upshiftRpm == null) {
    console.error(`Fallback discovery should allow two serialized discovery gears, got G4 up=${g4Fallback.upshiftRpm} G5 up=${g5Fallback.upshiftRpm}`);
    process.exit(1);
  }
  if (!autoShift.isPlausibleRatioSample(car, 5, g4Ratio * 0.82)) {
    console.error("Plausible new G5 ratio should not be blocked by polluted higher gears");
    process.exit(1);
  }

  gear5.ratioSum = originalG5.ratioSum;
  gear5.ratioCount = originalG5.ratioCount;
  gear6.ratioSum = originalG6.ratioSum;
  gear6.ratioCount = originalG6.ratioCount;
  if (gear7 && originalG7) {
    gear7.ratioSum = originalG7.ratioSum;
    gear7.ratioCount = originalG7.ratioCount;
  }
}

rmSync(runtimeAppData, { recursive: true, force: true });

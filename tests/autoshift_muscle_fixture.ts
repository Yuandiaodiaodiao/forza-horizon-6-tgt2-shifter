import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type ExportGear = {
  sampleCount: number;
  ratioCount: number;
  ratio: number | null;
};

type GearThresholds = {
  downshiftRpm: number | null;
  upshiftRpm: number | null;
  source: "learned" | "fallback";
  reason: string;
};

const root = resolve(import.meta.dir, "..");
const fixturePath = join(root, "test-fixtures", "autoshift", "remote-current", "current-export.json");
const runtimeAppData = join(root, "test-fixtures", "autoshift", ".runtime-muscle-appdata");
const runtimeCarsDir = join(runtimeAppData, "TGT2Telemetry", "data", "cars");

if (!existsSync(fixturePath)) {
  throw new Error(`Missing fixture: ${fixturePath}`);
}

const exported = JSON.parse(await Bun.file(fixturePath).text());
if (exported.peakPowerRpm > exported.maxRpm * 0.72) {
  throw new Error(`Muscle fixture should have a low-RPM peak, got peak=${exported.peakPowerRpm} max=${exported.maxRpm}`);
}

const powerCurve: Record<number, any> = {};
for (const point of exported.powerCurve || []) {
  powerCurve[point.rpm] = {
    count: Math.max(2, Number(point.samples) || 2),
    max: point.hp,
  };
}

const gears: Record<number, any> = {};
for (const [gear, info] of Object.entries(exported.gears || {}) as [string, ExportGear][]) {
  if (!info.ratio || info.ratioCount <= 0) continue;
  gears[Number(gear)] = {
    sampleCount: info.sampleCount,
    ratioSum: info.ratio * info.ratioCount,
    ratioCount: info.ratioCount,
  };
}

const profile = {
  carKey: exported.carKey,
  ordinal: exported.ordinal,
  maxRpm: exported.maxRpm,
  idleRpm: exported.idleRpm,
  powerCurve,
  peakPower: exported.peakPower,
  peakPowerRpm: exported.peakPowerRpm,
  maxObservedRpm: Math.max(0, ...Object.keys(powerCurve).map(Number)),
  fuelCutRpm: exported.fuelCutRpm || 0,
  fuelCutConfidence: exported.fuelCutConfidence || 0,
  wheelRadiusSum: (exported.wheelRadius || 0) * Math.max(1, exported.wheelRadiusCount || 1),
  wheelRadiusCount: exported.wheelRadiusCount || 1,
  totalSamples: exported.totalSamples,
  totalShifts: exported.totalShifts,
  discoveredTopGear: exported.discoveredTopGear || 0,
  shiftTiming: {
    samples: 3,
    avgMs: 170,
    ewmaMs: 170,
    minMs: 150,
    maxMs: 200,
    lastMs: 170,
    upSamples: 2,
    upAvgMs: 170,
    downSamples: 1,
    downAvgMs: 170,
  },
  firstSeen: Date.now(),
  gears,
};

rmSync(runtimeAppData, { recursive: true, force: true });
mkdirSync(runtimeCarsDir, { recursive: true });
writeFileSync(join(runtimeCarsDir, `${profile.carKey}.json`), JSON.stringify(profile, null, 2));

process.env.LOCALAPPDATA = runtimeAppData;
const { AdaptiveAutoShift } = await import("../src/autoshift");

const autoShift = new AdaptiveAutoShift() as any;
const car = autoShift.carProfiles.get(profile.carKey);
if (!car) throw new Error(`AdaptiveAutoShift did not load muscle fixture ${profile.carKey}`);

const highestLearnedGear = autoShift.getHighestLearnedForwardGear(car);
const rows = [1, 2, 3, 4].map(gear => {
  const thresholds = autoShift.getGearShiftThresholds(car, gear, highestLearnedGear, car.maxRpm) as GearThresholds;
  return {
    gear,
    downshiftRpm: thresholds.downshiftRpm == null ? null : Math.round(thresholds.downshiftRpm),
    upshiftRpm: thresholds.upshiftRpm == null ? null : Math.round(thresholds.upshiftRpm),
    source: thresholds.source,
    reason: thresholds.reason,
  };
});

console.log(JSON.stringify({
  fixture: fixturePath,
  carKey: profile.carKey,
  maxRpm: car.maxRpm,
  peakPowerRpm: car.peakPowerRpm,
  fuelCutRpm: car.fuelCutRpm,
  highestLearnedGear,
  gears: rows,
}, null, 2));

const g2 = rows.find(row => row.gear === 2);
const g3 = rows.find(row => row.gear === 3);
if (!g2?.upshiftRpm || !g3?.upshiftRpm) {
  console.error("Expected learned G2/G3 upshift thresholds");
  process.exit(1);
}

if (g2.upshiftRpm >= Math.round(car.maxRpm * 0.78) || g3.upshiftRpm >= Math.round(car.maxRpm * 0.78)) {
  console.error(`Low-RPM peak fixture should shift before 0.78*maxRpm, got G2=${g2.upshiftRpm} G3=${g3.upshiftRpm}`);
  process.exit(1);
}

if (g2.upshiftRpm > 6250 || g3.upshiftRpm > 6350) {
  console.error(`Low-RPM peak shift points should move earlier, got G2=${g2.upshiftRpm} G3=${g3.upshiftRpm}`);
  process.exit(1);
}

rmSync(runtimeAppData, { recursive: true, force: true });

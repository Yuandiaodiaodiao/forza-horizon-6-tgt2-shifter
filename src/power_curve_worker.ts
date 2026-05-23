import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  PowerCurveCarSnapshot,
  PowerCurvePoint,
  PowerCurveSeed,
  PowerCurveSnapshot,
  PowerCurveTelemetry,
  PowerCurveWorkerMessage,
} from "./power_curve_types";

declare var self: Worker;

type Bin = { count: number; torqueSamples: number[] };
type Car = { bins: Map<number, Bin>; acceptedSamples: number; updatedAt: number };
type StoredCar = { acceptedSamples: number; updatedAt: number; bins: Record<string, Bin> };

const NM_RPM_PER_HP = 7127;
const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const SLOT_BYTES = 512 * 1024;
const MAX_SAMPLES_PER_BIN = 80;
const MIN_THROTTLE = 0.80;
const MAX_RUMBLE = 0.05;
const MAX_PUDDLE = 0.02;
const encoder = new TextEncoder();

let header: Int32Array | null = null;
let sharedBytes: Uint8Array | null = null;
let dataPath = "";
let activeCarKey = 0;
let revision = 0;
let outputDirty = false;
let persistedDirty = false;
const cars = new Map<number, Car>();

self.onmessage = (event: MessageEvent<PowerCurveWorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") {
    header = new Int32Array(message.sharedBuffer, 0, HEADER_INTS);
    sharedBytes = new Uint8Array(message.sharedBuffer);
    dataPath = message.dataPath;
    loadPersisted();
    mergeSeeds(message.seeds);
    publish();
    return;
  }
  if (message.type === "sample") {
    acceptSample(message.frame);
    return;
  }
  if (message.type === "stop") {
    persist();
    publish();
    process.exit(0);
  }
};

setInterval(() => {
  if (outputDirty) publish();
}, 100);

setInterval(() => {
  if (persistedDirty) persist();
}, 5_000);

function acceptSample(frame: PowerCurveTelemetry) {
  if (activeCarKey !== frame.carKey) outputDirty = true;
  activeCarKey = frame.carKey;
  const car = getCar(frame.carKey);
  const rpm = Math.round(frame.rpm);
  const torqueNm = frame.torqueNm > 1
    ? frame.torqueNm
    : frame.powerHp > 1 && rpm > 0
      ? frame.powerHp * NM_RPM_PER_HP / rpm
      : 0;
  if (
    rpm < 500
    || torqueNm <= 1
    || frame.throttle < MIN_THROTTLE
    || frame.maxSlip >= 1.5
    || frame.maxRumble > MAX_RUMBLE
    || frame.maxPuddle > MAX_PUDDLE
    || frame.suspMin <= 0.08
  ) {
    return;
  }

  const bin = car.bins.get(rpm) ?? { count: 0, torqueSamples: [] };
  const learnedTorque = median(bin.torqueSamples);
  if (learnedTorque > 0 && torqueNm < learnedTorque * 0.90) return;
  if (bin.torqueSamples.length >= MAX_SAMPLES_PER_BIN && torqueNm <= bin.torqueSamples[0]) return;

  bin.torqueSamples = [...bin.torqueSamples, torqueNm]
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a)
    .slice(0, MAX_SAMPLES_PER_BIN)
    .sort((a, b) => a - b);
  bin.count++;
  car.bins.set(rpm, bin);
  car.acceptedSamples++;
  car.updatedAt = Date.now();
  outputDirty = true;
  persistedDirty = true;
}

function buildCarSnapshot(carKey: number, car: Car): PowerCurveCarSnapshot {
  const oneRpm = [...car.bins.entries()]
    .filter(([, bin]) => bin.count > 0 && bin.torqueSamples.length > 0)
    .map(([rpm, bin]) => ({
      rpm,
      hp: median(bin.torqueSamples) * rpm / NM_RPM_PER_HP,
      samples: bin.count,
    }))
    .sort((a, b) => a.rpm - b.rpm);
  const threeRpm = aggregateMedian(oneRpm, 3);
  const powerCurve = aggregateMedian(threeRpm, 10).filter(point => point.samples >= 2);
  const overlayCurve = aggregateMedian(powerCurve, 100);
  const peak = powerCurve.reduce((best, point) => point.hp > best.hp ? point : best, { rpm: 0, hp: 0, samples: 0 });
  return {
    carKey,
    totalSamples: car.acceptedSamples,
    powerBins: powerCurve.length,
    peakHp: round(peak.hp),
    peakHpRpm: peak.rpm,
    updatedAt: car.updatedAt,
    powerCurve,
    overlayCurve,
  };
}

function aggregateMedian(points: PowerCurvePoint[], width: number): PowerCurvePoint[] {
  const buckets = new Map<number, PowerCurvePoint[]>();
  for (const point of points) {
    const rpm = Math.round(point.rpm / width) * width;
    const values = buckets.get(rpm) ?? [];
    values.push(point);
    buckets.set(rpm, values);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rpm, values]) => ({
      rpm,
      hp: round(median(values.map(point => point.hp))),
      samples: values.reduce((sum, point) => sum + point.samples, 0),
    }));
}

function publish() {
  if (!header || !sharedBytes) return;
  const car = activeCarKey ? cars.get(activeCarKey) : undefined;
  const snapshot: PowerCurveSnapshot = {
    revision: ++revision,
    updatedAt: Date.now(),
    car: car ? buildCarSnapshot(activeCarKey, car) : null,
  };
  const encoded = encoder.encode(JSON.stringify(snapshot));
  if (encoded.length > SLOT_BYTES) {
    console.error(`  POWER CURVE snapshot exceeds shared slot: ${encoded.length} bytes`);
    return;
  }
  const slot = Atomics.load(header, 1) === 0 ? 1 : 0;
  sharedBytes.set(encoded, HEADER_BYTES + slot * SLOT_BYTES);
  Atomics.store(header, 2 + slot, encoded.length);
  Atomics.store(header, 1, slot);
  Atomics.add(header, 0, 1);
  outputDirty = false;
}

function mergeSeeds(seeds: PowerCurveSeed[]) {
  for (const seed of seeds) {
    if (cars.has(seed.carKey)) continue;
    const car = getCar(seed.carKey);
    for (const bin of seed.bins) {
      if (bin.count <= 0 || bin.torqueSamples.length === 0) continue;
      car.bins.set(Math.round(bin.rpm), {
        count: bin.count,
        torqueSamples: cleanSamples(bin.torqueSamples),
      });
      car.acceptedSamples += bin.count;
    }
  }
}

function getCar(carKey: number): Car {
  let car = cars.get(carKey);
  if (!car) {
    car = { bins: new Map(), acceptedSamples: 0, updatedAt: Date.now() };
    cars.set(carKey, car);
  }
  return car;
}

function persist() {
  if (!dataPath) return;
  const saved: Record<string, StoredCar> = {};
  for (const [carKey, car] of cars) {
    saved[carKey] = {
      acceptedSamples: car.acceptedSamples,
      updatedAt: car.updatedAt,
      bins: Object.fromEntries(car.bins),
    };
  }
  mkdirSync(dirname(dataPath), { recursive: true });
  writeFileSync(dataPath, JSON.stringify(saved));
  persistedDirty = false;
}

function loadPersisted() {
  if (!dataPath || !existsSync(dataPath)) return;
  try {
    const stored = JSON.parse(readFileSync(dataPath, "utf8")) as Record<string, StoredCar>;
    for (const [carKey, car] of Object.entries(stored)) {
      const bins = new Map<number, Bin>();
      for (const [rpm, bin] of Object.entries(car.bins ?? {})) {
        const torqueSamples = cleanSamples(bin.torqueSamples ?? []);
        if (torqueSamples.length > 0) bins.set(Number(rpm), { count: Number(bin.count) || 0, torqueSamples });
      }
      cars.set(Number(carKey), {
        bins,
        acceptedSamples: Number(car.acceptedSamples) || 0,
        updatedAt: Number(car.updatedAt) || Date.now(),
      });
    }
  } catch (error) {
    console.error(`  POWER CURVE failed to load persistence: ${String(error)}`);
  }
}

function cleanSamples(samples: number[]): number[] {
  return samples
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a)
    .slice(0, MAX_SAMPLES_PER_BIN)
    .sort((a, b) => a - b);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

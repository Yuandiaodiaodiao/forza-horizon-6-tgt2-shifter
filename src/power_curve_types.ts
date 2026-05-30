export interface PowerCurvePoint {
  rpm: number;
  hp: number;
  samples: number;
}

export interface PowerCurveCarSnapshot {
  carKey: number;
  totalSamples: number;
  powerBins: number;
  peakHp: number;
  peakHpRpm: number;
  updatedAt: number;
  /** Consumer curve after 1 -> 3 -> 10 RPM upper-quantile aggregation and smoothing. */
  powerCurve: PowerCurvePoint[];
  /** Rendering curve after an additional 100 RPM upper-quantile aggregation and smoothing. */
  overlayCurve: PowerCurvePoint[];
}

export interface PowerCurveSnapshot {
  revision: number;
  updatedAt: number;
  car: PowerCurveCarSnapshot | null;
}

export interface PowerCurveSeedBin {
  rpm: number;
  count: number;
  torqueSamples: number[];
}

export interface PowerCurveSeed {
  carKey: number;
  bins: PowerCurveSeedBin[];
}

export interface PowerCurveTelemetry {
  carKey: number;
  rpm: number;
  torqueNm: number;
  powerHp: number;
  throttle: number;
  maxSlip: number;
  maxRumble: number;
  maxPuddle: number;
  suspMin: number;
}

export interface PowerCurveWorkerInit {
  type: "init";
  sharedBuffer: SharedArrayBuffer;
  dataPath: string;
  seeds: PowerCurveSeed[];
}

export interface PowerCurveWorkerSample {
  type: "sample";
  frame: PowerCurveTelemetry;
}

export interface PowerCurveWorkerStop {
  type: "stop";
}

export interface PowerCurveWorkerResetCar {
  type: "reset-car";
  carKey: number;
}

export type PowerCurveWorkerMessage = PowerCurveWorkerInit | PowerCurveWorkerSample | PowerCurveWorkerStop | PowerCurveWorkerResetCar;

export function telemetryCarKey(frame: Record<string, any>): number {
  const drivetrain = frame.drivetrain === "FWD" ? 1 : frame.drivetrain === "RWD" ? 2 : 3;
  return Number(frame.car_ordinal || 0) * 1_000_000
    + Number(frame.car_pi || 0) * 100
    + Number(frame.num_cylinders || 0) * 10
    + drivetrain;
}

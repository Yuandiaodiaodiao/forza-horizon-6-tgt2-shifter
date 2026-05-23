import type { PowerCurveSeed, PowerCurveSnapshot, PowerCurveTelemetry, PowerCurveWorkerMessage } from "./power_curve_types";
import { telemetryCarKey } from "./power_curve_types";

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;
const SLOT_BYTES = 512 * 1024;
const SHARED_BYTES = HEADER_BYTES + SLOT_BYTES * 2;

export class PowerCurvePipeline {
  private readonly buffer = new SharedArrayBuffer(SHARED_BYTES);
  private readonly header = new Int32Array(this.buffer, 0, HEADER_INTS);
  private readonly bytes = new Uint8Array(this.buffer);
  private readonly decoder = new TextDecoder();
  private readonly worker: Worker;
  private stopped = false;
  private lastVersion = -1;
  private cached: PowerCurveSnapshot | null = null;

  constructor(dataPath: string, seeds: PowerCurveSeed[], worker?: Worker) {
    this.worker = worker ?? new Worker(new URL("./power_curve_worker.ts", import.meta.url).href);
    const init: PowerCurveWorkerMessage = { type: "init", sharedBuffer: this.buffer, dataPath, seeds };
    this.worker.postMessage(init);
    this.worker.addEventListener("error", (event) => {
      console.error(`  POWER CURVE worker error: ${event.message}`);
    });
  }

  submit(frame: Record<string, any>) {
    if (this.stopped) return;
    const sample = this.toSample(frame);
    if (sample) this.worker.postMessage({ type: "sample", frame: sample } satisfies PowerCurveWorkerMessage);
  }

  readLatest(): PowerCurveSnapshot | null {
    for (let attempt = 0; attempt < 2; attempt++) {
      const version = Atomics.load(this.header, 0);
      if (version === 0) return this.cached;
      if (version === this.lastVersion) return this.cached;

      const slot = Atomics.load(this.header, 1);
      const length = Atomics.load(this.header, 2 + slot);
      if (slot < 0 || slot > 1 || length <= 0 || length > SLOT_BYTES) return this.cached;
      const start = HEADER_BYTES + slot * SLOT_BYTES;
      const json = this.decoder.decode(this.bytes.slice(start, start + length));
      if (version !== Atomics.load(this.header, 0)) continue;
      try {
        this.cached = JSON.parse(json) as PowerCurveSnapshot;
        this.lastVersion = version;
      } catch {
        return this.cached;
      }
      return this.cached;
    }
    return this.cached;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.worker.postMessage({ type: "stop" } satisfies PowerCurveWorkerMessage);
    } catch {
      return;
    }
    (this.worker as Worker & { unref?: () => void }).unref?.();
  }

  private toSample(frame: Record<string, any>): PowerCurveTelemetry | null {
    if (!frame.car_ordinal || !frame.rpm) return null;
    return {
      carKey: telemetryCarKey(frame),
      rpm: Math.round(Number(frame.rpm) || 0),
      torqueNm: Number(frame.torque_nm) || 0,
      powerHp: Number(frame.power_hp) || 0,
      throttle: (Number(frame.accel) || 0) / 255,
      maxSlip: Math.max(...(frame.tire_slip ?? [0]).map(Number)),
      maxRumble: Math.max(...(frame.rumble_strip ?? [0]).map(Number)),
      maxPuddle: Math.max(...(frame.puddle_depth ?? [0]).map(Number)),
      suspMin: Math.min(...(frame.susp_travel ?? [0.5]).map(Number)),
    };
  }
}

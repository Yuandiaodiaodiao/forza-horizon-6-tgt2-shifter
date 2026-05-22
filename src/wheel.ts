/**
 * Wheel input via winmm.dll FFI (read-only, no DirectInput interference)
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

const winmm = dlopen("winmm.dll", {
  joyGetNumDevs:  { returns: FFIType.u32, args: [] },
  joyGetDevCapsW: { returns: FFIType.u32, args: [FFIType.u32, FFIType.ptr, FFIType.u32] },
  joyGetPosEx:    { returns: FFIType.u32, args: [FFIType.u32, FFIType.ptr] },
});

const JOYINFOEX_SIZE = 52;
const JOYCAPSW_SIZE  = 728;
const JOY_RETURNALL  = 0xff;
const JOY_CAP_HASPOV = 0x10;
const JOYERR_NOERROR = 0;
const AXIS_DEADZONE  = 0.008;
const AXIS_NAMES     = ["X", "Y", "Z", "R", "U", "V"];

interface AxisRange { min: number; max: number; }

function normalize(val: number, lo: number, hi: number): number {
  if (hi === lo) return 0;
  return Math.round(((val - lo) / (hi - lo) * 2 - 1) * 100000) / 100000;
}

function povToXY(pov: number): [number, number] {
  if (pov === 0xffff || pov === 65535) return [0, 0];
  const deg = pov / 100;
  const map: Record<number, [number, number]> = {
    0: [0,1], 45: [1,1], 90: [1,0], 135: [1,-1],
    180: [0,-1], 225: [-1,-1], 270: [-1,0], 315: [-1,1],
  };
  let closest = 0, minDist = 999;
  for (const d of Object.keys(map)) {
    const dist = Math.abs(Number(d) - deg);
    if (dist < minDist) { minDist = dist; closest = Number(d); }
  }
  return minDist < 30 ? map[closest] : [0, 0];
}

export class WheelReader {
  joyId = -1;
  name = "";
  numAxes = 0;
  numButtons = 0;
  hasPov = false;
  connected = false;

  private axisRanges: AxisRange[] = [];
  private prevAxes: number[] = [];
  private prevButtons = 0;
  private prevPov: [number, number] = [0, 0];
  private infoBuf = new ArrayBuffer(JOYINFOEX_SIZE);
  private infoView = new DataView(this.infoBuf);

  constructor(forceId?: number) {
    const numDevs = winmm.symbols.joyGetNumDevs() as number;
    if (numDevs === 0) return;

    const capsBuf = new ArrayBuffer(JOYCAPSW_SIZE);
    let bestId = -1, bestAxes = 0;

    // JOYCAPSW field offsets (calculated from struct layout):
    // 0: wMid(2), 2: wPid(2), 4: szPname(64), 68: wXmin(4), 72: wXmax(4),
    // 76: wYmin(4), 80: wYmax(4), 84: wZmin(4), 88: wZmax(4),
    // 92: wNumButtons(4), 96: wPeriodMin(4), 100: wPeriodMax(4),
    // 104: wRmin(4), 108: wRmax(4), 112: wUmin(4), 116: wUmax(4),
    // 120: wVmin(4), 124: wVmax(4), 128: wCaps(4), 132: wMaxAxes(4),
    // 136: wNumAxes(4), 140: wMaxButtons(4)
    const OFF_NUM_BUTTONS = 92;
    const OFF_CAPS = 128;
    const OFF_NUM_AXES = 136;
    const AXIS_RANGE_OFFSETS: [number, number][] = [
      [68, 72],   // X min/max
      [76, 80],   // Y
      [84, 88],   // Z
      [104, 108], // R
      [112, 116], // U
      [120, 124], // V
    ];

    for (let id = 0; id < Math.min(numDevs, 16); id++) {
      this.infoView.setUint32(0, JOYINFOEX_SIZE, true);
      this.infoView.setUint32(4, JOY_RETURNALL, true);
      if (winmm.symbols.joyGetPosEx(id, ptr(this.infoBuf)) !== JOYERR_NOERROR) continue;

      const ret = winmm.symbols.joyGetDevCapsW(id, ptr(capsBuf), JOYCAPSW_SIZE);
      if (ret !== JOYERR_NOERROR) continue;

      const cv = new DataView(capsBuf);
      const axes = cv.getUint32(OFF_NUM_AXES, true);
      const btns = cv.getUint32(OFF_NUM_BUTTONS, true);
      console.log(`  Found joystick [${id}]: axes=${axes} buttons=${btns}`);

      if (forceId != null && id === forceId) { bestId = id; bestAxes = axes; break; }
      if (axes > bestAxes) { bestId = id; bestAxes = axes; }
    }

    if (bestId < 0) return;
    this.joyId = bestId;

    winmm.symbols.joyGetDevCapsW(bestId, ptr(capsBuf), JOYCAPSW_SIZE);
    const cv = new DataView(capsBuf);
    this.numAxes    = Math.min(cv.getUint32(OFF_NUM_AXES, true), 6);
    this.numButtons = cv.getUint32(OFF_NUM_BUTTONS, true);
    this.hasPov     = !!(cv.getUint32(OFF_CAPS, true) & JOY_CAP_HASPOV);
    this.name       = `Joystick ${bestId}`;
    this.connected  = true;

    const rangeOffsets = AXIS_RANGE_OFFSETS;
    for (let i = 0; i < 6; i++) {
      const [lo, hi] = rangeOffsets[i];
      this.axisRanges.push({ min: cv.getUint32(lo, true), max: cv.getUint32(hi, true) });
    }

    // initial state
    this.infoView.setUint32(0, JOYINFOEX_SIZE, true);
    this.infoView.setUint32(4, JOY_RETURNALL, true);
    winmm.symbols.joyGetPosEx(this.joyId, ptr(this.infoBuf));
    this.prevAxes = this.readAxes();
    this.prevButtons = this.infoView.getUint32(32, true);
    this.prevPov = povToXY(this.infoView.getUint32(40, true));
  }

  private readAxes(): number[] {
    const raw = [
      this.infoView.getUint32(8, true),  // X
      this.infoView.getUint32(12, true), // Y
      this.infoView.getUint32(16, true), // Z
      this.infoView.getUint32(20, true), // R
      this.infoView.getUint32(24, true), // U
      this.infoView.getUint32(28, true), // V
    ];
    return raw.slice(0, this.numAxes).map((v, i) =>
      normalize(v, this.axisRanges[i].min, this.axisRanges[i].max)
    );
  }

  poll(): any[] {
    if (!this.connected) return [];

    this.infoView.setUint32(0, JOYINFOEX_SIZE, true);
    this.infoView.setUint32(4, JOY_RETURNALL, true);
    if (winmm.symbols.joyGetPosEx(this.joyId, ptr(this.infoBuf)) !== JOYERR_NOERROR) return [];

    const ts = Date.now() / 1000;
    const events: any[] = [];

    // axes
    const axes = this.readAxes();
    for (let i = 0; i < this.numAxes; i++) {
      if (Math.abs(axes[i] - this.prevAxes[i]) > AXIS_DEADZONE) {
        this.prevAxes[i] = axes[i];
        events.push({ type: "axis", ts, axis: i, value: axes[i] });
      }
    }

    // buttons
    const btns = this.infoView.getUint32(32, true);
    if (btns !== this.prevButtons) {
      const diff = btns ^ this.prevButtons;
      for (let i = 0; i < this.numButtons; i++) {
        if (diff & (1 << i)) {
          events.push({
            type: btns & (1 << i) ? "button_down" : "button_up",
            ts, button: i,
          });
        }
      }
      this.prevButtons = btns;
    }

    // POV hat
    if (this.hasPov) {
      const pov = povToXY(this.infoView.getUint32(40, true));
      if (pov[0] !== this.prevPov[0] || pov[1] !== this.prevPov[1]) {
        this.prevPov = pov;
        events.push({ type: "hat", ts, hat: 0, value: pov });
      }
    }

    return events;
  }
}

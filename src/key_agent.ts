/**
 * Key Agent v5 — interactive desktop session
 *
 * Injection methods:
 *  E) vJoy virtual joystick — DirectInput device, zero FFB interference (DEFAULT)
 *  C) SendInput atomic tap — down+up in single call
 *  A) SendInput with 60ms hold
 *  B) keybd_event with 60ms hold
 *  D) PostMessage to foreground window
 *
 * MUST be started by double-clicking start_key_agent.bat (interactive session required)
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { loadConfig, updateConfig } from "./config";
import { envNumber, envString } from "./env";
const FFI = FFIType as typeof FFIType & { usize: typeof FFIType.u64; isize: typeof FFIType.i64 };

// ── user32.dll (keyboard methods A-D) ──

const user32 = dlopen("user32.dll", {
  SendInput: {
    returns: FFIType.u32,
    args: [FFIType.u32, FFIType.ptr, FFIType.i32],
  },
  keybd_event: {
    returns: FFIType.void,
    args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.ptr],
  },
  GetForegroundWindow: {
    returns: FFIType.ptr,
    args: [],
  },
  PostMessageW: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.u32, FFI.usize, FFI.isize],
  },
});
const user32Symbols = user32.symbols as any;

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const INPUT_SIZE = 40;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

const KEYS: Record<string, { vk: number; scan: number }> = {
  E: { vk: 0x45, scan: 0x12 },
  Q: { vk: 0x51, scan: 0x10 },
  W: { vk: 0x57, scan: 0x11 },
  S: { vk: 0x53, scan: 0x1f },
};

// ── vJoy (Method E) ──

const VJOY_DEVICE_ID = 1;
const VJOY_BTN_PULSE_MS = 40;
const VJOY_CLUTCH_PULSE_MS = 40;

// vJoy button mapping: btn 1 = reverse, btn 2-11 = gear 1-10, btn 12 = clutch
const VJOY_BTN_REVERSE = 1;
const VJOY_BTN_GEAR_BASE = 2; // gear N → button N+1
const VJOY_BTN_CLUTCH = 12;

let vjoyAvailable = false;
let vjoy: any = null;
let vjoyDllPath = "";
let vjoyButtonCount = 0;

// Auto-detect system drive from SYSTEMROOT or common locations
const SYS_DRIVE = (process.env.SYSTEMROOT ?? "C:\\Windows").slice(0, 2);
function getVjoyPaths(configuredPath = "") {
  const paths: string[] = [];
  const trimmed = configuredPath.trim();
  if (trimmed) {
    paths.push(trimmed.endsWith(".dll") ? trimmed : `${trimmed.replace(/[\\/]$/, "")}\\x64\\vJoyInterface.dll`);
  }
  paths.push(
  `${SYS_DRIVE}\\Program Files\\vJoy\\x64\\vJoyInterface.dll`,
  `${SYS_DRIVE}\\Program Files (x86)\\vJoy\\x64\\vJoyInterface.dll`,
  "C:\\Program Files\\vJoy\\x64\\vJoyInterface.dll",
  "G:\\Program Files\\vJoy\\x64\\vJoyInterface.dll",
  );
  return [...new Set(paths)];
}

function openVjoyDll(dllPath: string) {
  return dlopen(dllPath, {
      vJoyEnabled: { returns: FFIType.bool, args: [] },
      AcquireVJD: { returns: FFIType.bool, args: [FFIType.u32] },
      RelinquishVJD: { returns: FFIType.void, args: [FFIType.u32] },
      GetVJDStatus: { returns: FFIType.i32, args: [FFIType.u32] },
      GetVJDButtonNumber: { returns: FFIType.i32, args: [FFIType.u32] },
      ResetVJD: { returns: FFIType.bool, args: [FFIType.u32] },
      SetBtn: { returns: FFIType.bool, args: [FFIType.i32, FFIType.u32, FFIType.u8] },
    });
}

function releaseVjoyDevice() {
  if (vjoy && vjoyAvailable) {
    try {
      vjoyReleaseAll();
      vjoy.symbols.ResetVJD(VJOY_DEVICE_ID);
      vjoy.symbols.RelinquishVJD(VJOY_DEVICE_ID);
    } catch {}
  }
  vjoyAvailable = false;
  vjoy = null;
  vjoyDllPath = "";
  vjoyButtonCount = 0;
  vjoyHeldBtn = -1;
}

function initVjoy(configuredPath = "") {
  releaseVjoyDevice();
  for (const dllPath of getVjoyPaths(configuredPath)) {
    try {
      vjoy = openVjoyDll(dllPath);
      vjoyDllPath = dllPath;
      break;
    } catch {
      vjoy = null;
      vjoyDllPath = "";
    }
  }

  if (!vjoy) {
    console.log("  vJoy: DLL not found (not installed)");
    return;
  }

  try {
    const enabled = vjoy.symbols.vJoyEnabled();
    if (enabled) {
      const status = vjoy.symbols.GetVJDStatus(VJOY_DEVICE_ID) as number;
      const statusNames = ["OWN", "FREE", "BUSY", "MISS", "UNKN"];
      console.log(`  vJoy driver enabled, device ${VJOY_DEVICE_ID} status: ${statusNames[status] ?? status}`);

      if (status === 0 || status === 1) {
        // OWN or FREE — acquire
        if (status === 1) {
          const ok = vjoy.symbols.AcquireVJD(VJOY_DEVICE_ID);
          if (!ok) {
            console.log("  vJoy: AcquireVJD failed");
          }
        }
        vjoy.symbols.ResetVJD(VJOY_DEVICE_ID);
        const nBtns = vjoy.symbols.GetVJDButtonNumber(VJOY_DEVICE_ID) as number;
        vjoyButtonCount = nBtns;
        console.log(`  vJoy: acquired device ${VJOY_DEVICE_ID} (${nBtns} buttons)`);
        vjoyAvailable = nBtns >= VJOY_BTN_CLUTCH;
        if (!vjoyAvailable) {
          console.log(`  vJoy: need >= ${VJOY_BTN_CLUTCH} buttons, got ${nBtns}. Configure in vJoyConf!`);
        } else {
          vjoyReleaseAll();
          vjoyHoldGear(1);
          console.log(`  vJoy DLL: ${vjoyDllPath}`);
        }
      } else {
        console.log(`  vJoy: device ${VJOY_DEVICE_ID} not available (${statusNames[status]})`);
      }
    } else {
      console.log("  vJoy driver not enabled");
    }
  } catch (e) {
    console.log(`  vJoy init error: ${e}`);
  }
}

function vjoyBtnPulse(btnId: number, pulseMs: number = VJOY_BTN_PULSE_MS) {
  if (!vjoy || !vjoyAvailable) return;
  vjoy.symbols.SetBtn(1, VJOY_DEVICE_ID, btnId);
  setTimeout(() => {
    vjoy!.symbols.SetBtn(0, VJOY_DEVICE_ID, btnId);
  }, pulseMs);
}

function vjoyPulseClutch() {
  vjoyBtnPulse(VJOY_BTN_CLUTCH, VJOY_CLUTCH_PULSE_MS);
}

// Held gear state: one button always pressed
let vjoyHeldBtn = -1;

function vjoyHoldGear(gear: number) {
  if (!vjoy || !vjoyAvailable) return;
  const newBtn = gear === -1 ? VJOY_BTN_REVERSE
    : (gear >= 1 && gear <= 10) ? VJOY_BTN_GEAR_BASE + gear - 1
    : -1;
  if (newBtn < 0 || newBtn === vjoyHeldBtn) return;
  // Release old button

  if (vjoyHeldBtn >= 0) {
    vjoy.symbols.SetBtn(0, VJOY_DEVICE_ID, vjoyHeldBtn);
  }
  // Press clutch, hold the new gear, then release clutch immediately.
  vjoy.symbols.SetBtn(1, VJOY_DEVICE_ID, newBtn);
  vjoy.symbols.SetBtn(1, VJOY_DEVICE_ID, VJOY_BTN_CLUTCH);
  vjoy.symbols.SetBtn(0, VJOY_DEVICE_ID, VJOY_BTN_CLUTCH);
  vjoyHeldBtn = newBtn;
  console.log(`  vJoy: clutch btn ${VJOY_BTN_CLUTCH} + hold btn ${newBtn} (gear ${gear})`);
}

function vjoyReleaseAll() {
  if (!vjoy || !vjoyAvailable) return;
  let released = 0;
  for (let btn = 1; btn <= vjoyButtonCount; btn++) {
    if (vjoy.symbols.SetBtn(0, VJOY_DEVICE_ID, btn)) released++;
  }
  vjoyHeldBtn = -1;
  console.log(`  vJoy: released all ${released} buttons`);
}

function vjoySetGear(gear: number): boolean {
  if (gear === -1) {
    vjoyBtnPulse(VJOY_BTN_REVERSE);
    return true;
  } else if (gear >= 1 && gear <= 10) {
    vjoyBtnPulse(VJOY_BTN_GEAR_BASE + gear - 1);
    return true;
  }
  return false;
}

// ── Keyboard helpers (methods A-D) ──

function sendInputKey(scan: number, up: boolean): number {
  const buf = new ArrayBuffer(INPUT_SIZE);
  const v = new DataView(buf);
  v.setUint32(0, INPUT_KEYBOARD, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, scan, true);
  v.setUint32(12, KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0), true);
  return user32Symbols.SendInput(1, ptr(buf), INPUT_SIZE) as number;
}

function sendInputTap(scan: number): number {
  const buf = new ArrayBuffer(INPUT_SIZE * 2);
  const v = new DataView(buf);
  v.setUint32(0, INPUT_KEYBOARD, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, scan, true);
  v.setUint32(12, KEYEVENTF_SCANCODE, true);
  v.setUint32(INPUT_SIZE, INPUT_KEYBOARD, true);
  v.setUint16(INPUT_SIZE + 8, 0, true);
  v.setUint16(INPUT_SIZE + 10, scan, true);
  v.setUint32(INPUT_SIZE + 12, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP, true);
  return user32Symbols.SendInput(2, ptr(buf), INPUT_SIZE) as number;
}

function keybdEvent(vk: number, scan: number, up: boolean) {
  user32Symbols.keybd_event(vk, scan, up ? 2 : 0, null);
}

function postMessageTap(vk: number, scan: number) {
  const hwnd = user32Symbols.GetForegroundWindow();
  if (!hwnd) return;
  user32Symbols.PostMessageW(hwnd, WM_KEYDOWN, vk, 1 | (scan << 16));
  user32Symbols.PostMessageW(hwnd, WM_KEYUP, vk, 1 | (scan << 16) | (1 << 30) | (1 << 31));
}

// ── Method selection ──

type Method = "A" | "B" | "C" | "D" | "E";
const initialConfig = loadConfig();
initVjoy(initialConfig.vjoyPath);
let method: Method = initialConfig.shiftMode === "vjoy" && vjoyAvailable ? "E" : "C";
let currentGear = vjoyHeldBtn === VJOY_BTN_GEAR_BASE ? 1 : 0;

const heldKeys = new Set<string>();

function keyDown(name: string) {
  const k = KEYS[name];
  if (!k) return;
  if (heldKeys.has(name)) return;
  heldKeys.add(name);
  if (method === "D") {
    const hwnd = user32Symbols.GetForegroundWindow();
    if (hwnd) user32Symbols.PostMessageW(hwnd, WM_KEYDOWN, k.vk, 1 | (k.scan << 16));
  } else if (method === "A" || method === "C") {
    sendInputKey(k.scan, false);
  } else {
    keybdEvent(k.vk, k.scan, false);
  }
}

function keyUp(name: string) {
  const k = KEYS[name];
  if (!k) return;
  heldKeys.delete(name);
  if (method === "D") {
    const hwnd = user32Symbols.GetForegroundWindow();
    if (hwnd) user32Symbols.PostMessageW(hwnd, WM_KEYUP, k.vk, 1 | (k.scan << 16) | (1 << 30) | (1 << 31));
  } else if (method === "A" || method === "C") {
    sendInputKey(k.scan, true);
  } else {
    keybdEvent(k.vk, k.scan, true);
  }
}

async function pressKey(name: string, holdMs: number = 60) {
  const k = KEYS[name];
  if (!k) return;
  if (method === "C") {
    sendInputTap(k.scan);
  } else if (method === "D") {
    postMessageTap(k.vk, k.scan);
  } else if (method === "A") {
    sendInputKey(k.scan, false);
    await Bun.sleep(holdMs);
    sendInputKey(k.scan, true);
  } else {
    keybdEvent(k.vk, k.scan, false);
    await Bun.sleep(holdMs);
    keybdEvent(k.vk, k.scan, true);
  }
}

// Up/down sequential shift — vJoy direct gear if available, keyboard fallback
function doShift(direction: "up" | "down") {
  if (method === "E" && vjoyAvailable) {
    const targetGear = direction === "up" ? currentGear + 1 : currentGear - 1;
    if (vjoySetGear(targetGear)) vjoyPulseClutch();
  } else {
    pressKey(direction === "up" ? "E" : "Q");
  }
}

// Direct gear selection always uses vJoy
function doGear(gear: number) {
  if (vjoyAvailable) {
    vjoySetGear(gear);
  }
}

async function sequentialShiftToGear(targetGear: number) {
  if (targetGear < 1 || targetGear > 10) return false;
  if (currentGear < 1 || currentGear > 10) {
    await pressKey(targetGear > 1 ? "E" : "Q");
    return true;
  }
  const diff = targetGear - currentGear;
  const key = diff > 0 ? "E" : "Q";
  for (let i = 0; i < Math.abs(diff); i++) {
    await pressKey(key);
    await Bun.sleep(80);
  }
  currentGear = targetGear;
  return true;
}

// ── HTTP Server ──

const PORT = envNumber("TGT2_KEY_AGENT_PORT", 7788);
const HOST = envString("TGT2_KEY_AGENT_BIND_HOST", "0.0.0.0");

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const cmd = new URL(req.url).pathname.slice(1).toUpperCase();
    const R = (body: string, init?: ResponseInit) =>
      new Response(body, { ...init, headers: { ...cors, ...init?.headers } });
    const RJ = (data: any) =>
      new Response(JSON.stringify(data), { headers: { ...cors, "Content-Type": "application/json" } });

    if (cmd === "UP") { doShift("up"); return R("OK:UP"); }
    if (cmd === "DOWN") { doShift("down"); return R("OK:DOWN"); }

    // /clutch — pulse vJoy button 12 for in-game clutch binding
    if (cmd === "CLUTCH") {
      vjoyPulseClutch();
      return R(`OK:CLUTCH:${VJOY_BTN_CLUTCH}`);
    }

    // /gear/hold/N — hold gear button continuously (releases previous)
    if (cmd.startsWith("GEAR/HOLD/")) {
      const g = parseInt(cmd.split("/")[2]);
      if (!isNaN(g) && g >= -1 && g <= 10) {
        if (method === "E" && vjoyAvailable) {
          vjoyHoldGear(g);
          return R(`OK:HOLD:${g}:VJOY`);
        }
        if (await sequentialShiftToGear(g)) return R(`OK:HOLD:${g}:KEYBOARD`);
      }
    }

    // /gear/release — release all held gear buttons (for manual override)
    if (cmd === "GEAR/RELEASE") {
      vjoyReleaseAll();
      return R("OK:RELEASED");
    }

    // /gear/N — pulse (legacy, for binding in Forza menus)
    if (cmd.startsWith("GEAR/")) {
      const g = parseInt(cmd.split("/")[1]);
      if (!isNaN(g) && g >= -1 && g <= 10) {
        doGear(g);
        return R(`OK:GEAR:${g}`);
      }
    }

    if (cmd.startsWith("TELEM/")) {
      const g = parseInt(cmd.split("/")[1]);
      if (!isNaN(g)) { currentGear = g; return R("OK"); }
    }

    if (cmd === "THROTTLE/ON") { keyDown("W"); return R("OK:W_ON"); }
    if (cmd === "THROTTLE/OFF") { keyUp("W"); return R("OK:W_OFF"); }
    if (cmd === "BRAKE/ON") { keyDown("S"); return R("OK:S_ON"); }
    if (cmd === "BRAKE/OFF") { keyUp("S"); return R("OK:S_OFF"); }

    if (cmd.startsWith("PRESS/")) {
      const parts = cmd.split("/");
      const key = parts[1];
      const ms = parseInt(parts[2] || "60");
      if (KEYS[key]) { await pressKey(key, ms); return R(`OK:PRESS:${key}:${ms}`); }
    }

    if (cmd === "RELEASE") {
      for (const k of [...heldKeys]) keyUp(k);
      return R("OK:RELEASED");
    }

    if (cmd === "PING") return R("PONG");

    if (cmd === "METHOD/A") { method = "A"; return R("METHOD:A (SendInput 60ms)"); }
    if (cmd === "METHOD/B") { method = "B"; return R("METHOD:B (keybd_event 60ms)"); }
    if (cmd === "METHOD/C") { method = "C"; return R("METHOD:C (SendInput atomic)"); }
    if (cmd === "METHOD/D") { method = "D"; return R("METHOD:D (PostMessage)"); }
    if (cmd === "METHOD/E") {
      if (!vjoyAvailable) return R("ERROR: vJoy not available", { status: 500 });
      method = "E";
      updateConfig({ shiftMode: "vjoy" });
      return R("METHOD:E (vJoy virtual joystick)");
    }
    if (cmd === "METHOD/KEYBOARD") {
      method = "C";
      updateConfig({ shiftMode: "keyboard" });
      return R("METHOD:KEYBOARD (SendInput atomic)");
    }

    if (cmd === "CONFIG" && req.method === "GET") {
      return RJ({ ...loadConfig(), configPath: (await import("./config")).CONFIG_PATH });
    }

    if (cmd === "CONFIG" && req.method === "POST") {
      const body = await req.json().catch(() => ({})) as any;
      const patch: any = {};
      if (body.shiftMode === "keyboard" || body.shiftMode === "vjoy") patch.shiftMode = body.shiftMode;
      if (typeof body.vjoyPath === "string") patch.vjoyPath = body.vjoyPath;
      if (body.manualCooldownSec != null) patch.manualCooldownSec = Number(body.manualCooldownSec);
      const next = updateConfig(patch);
      if (typeof patch.vjoyPath === "string") initVjoy(next.vjoyPath);
      method = next.shiftMode === "vjoy" && vjoyAvailable ? "E" : "C";
      return RJ({ ...next, method, vjoyAvailable, vjoyDllPath });
    }

    if (cmd === "STATUS") {
      return RJ({
        method,
        vjoyAvailable,
        vjoyDllPath,
        vjoyDevice: VJOY_DEVICE_ID,
        vjoyHeldBtn,
        vjoyClutchBtn: VJOY_BTN_CLUTCH,
        heldKeys: [...heldKeys],
      });
    }

    return R(
      "Commands: /up /down /gear/N /gear/hold/N /gear/release /clutch /throttle/on|off /brake/on|off /press/KEY/MS /release /status /config /method/A|B|C|D|E|KEYBOARD",
      { status: 400 },
    );
  },
});

console.log("=".repeat(55));
console.log("  Key Agent v5 — interactive session");
console.log(`  http://${HOST}:${PORT}`);
console.log(`  Method: ${method}${method === "E" ? " (vJoy direct gear)" : ""}`);
console.log("  E=vJoy  C=atomic  D=PostMessage  A/B=legacy");
if (vjoyAvailable) {
  console.log(`  vJoy device ${VJOY_DEVICE_ID} ready ✓`);
  console.log("  Button mapping:");
  console.log("    Btn 1 = Reverse");
  console.log("    Btn 2-11 = Gear 1-10");
  console.log("    Btn 12 = Clutch");
  console.log("  → In Forza: bind each gear to vJoy buttons");
}
console.log("=".repeat(55));

process.on("exit", () => {
  releaseVjoyDevice();
});

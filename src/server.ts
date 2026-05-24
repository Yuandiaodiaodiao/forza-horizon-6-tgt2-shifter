/**
 * T-GT II + Forza Telemetry — Combined Windows Server
 *
 * Single Bun process:
 *  - FFI -> winmm.dll for joystick polling (read-only, no FFB interference)
 *  - UDP listener for Forza "Data Out" telemetry
 *  - WebSocket server broadcasting all events
 *  - Adaptive auto-shift module
 *
 * Usage: bun run src/server.ts [--ws-port 8765] [--udp-port 6688] [--poll-hz 30] [--telem-hz 60]
 */

import { parseArgs } from "util";
import { appendFile, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { WheelReader } from "./wheel";
import { ForzaReceiver } from "./forza";
import { AdaptiveAutoShift } from "./autoshift";
import { APP_DATA_DIR, CONFIG_PATH, loadConfig, updateConfig } from "./config";
import { buildKeyAgentUrl, envBool, envNumber } from "./env";
import { PowerCurvePipeline } from "./power_curve_pipeline";
import { getBuildInfo } from "./updater";
import dashboardHtml from "../dashboard.html" with { type: "text" };

const DASHBOARD_HTML = dashboardHtml as unknown as string;

const { values: args } = parseArgs({
  options: {
    "ws-port":  { type: "string", default: String(envNumber("TGT2_WS_PORT", 8765)) },
    "udp-port": { type: "string", default: String(envNumber("TGT2_UDP_PORT", 6688)) },
    "poll-hz":  { type: "string", default: String(envNumber("TGT2_POLL_HZ", 30)) },
    "telem-hz": { type: "string", default: String(envNumber("TGT2_TELEM_HZ", 60)) },
    "joy-id":   { type: "string" },
    "auto-shift": { type: "boolean", default: envBool("TGT2_AUTO_SHIFT", true) },
    "no-dashboard": { type: "boolean", default: false },
  },
});

const WS_PORT   = parseInt(args["ws-port"]!);
const UDP_PORT  = parseInt(args["udp-port"]!);
const POLL_HZ   = parseInt(args["poll-hz"]!);
const TELEM_HZ  = parseInt(args["telem-hz"]!);
const JOY_ID    = args["joy-id"] != null ? parseInt(args["joy-id"]) : process.env.TGT2_JOY_ID ? envNumber("TGT2_JOY_ID", 0) : undefined;
const KEY_AGENT = buildKeyAgentUrl();
const START_TIME = Date.now();
const PIPELINE_LOG_PATH = join(process.env.LOCALAPPDATA ?? process.cwd(), "TGT2Telemetry", "logs", "pipeline.log");
const MAX_WS_BUFFER_BYTES = envNumber("TGT2_WS_MAX_BUFFER_KB", 512) * 1024;
const DISPATCH_PERIOD_MS = 1000 / TELEM_HZ;
const DISPATCH_WAKE_MS = Math.max(1, Math.floor(DISPATCH_PERIOD_MS / 2));

console.log("=".repeat(60));
console.log("  T-GT II + Forza Server (Bun + TypeScript)");
console.log("  winmm.dll read-only — no DirectInput interference");
console.log("=".repeat(60));

// --- Auto-shift ---
const autoShift = new AdaptiveAutoShift();
autoShift.setEnabled(args["auto-shift"] ?? true);
const powerCurveWorkerHost = globalThis as typeof globalThis & { __tgt2PowerCurveWorker?: Worker };
const powerCurve = new PowerCurvePipeline(
  join(APP_DATA_DIR, "data", "power-curves-worker.json"),
  autoShift.getPowerCurveSeeds(),
  powerCurveWorkerHost.__tgt2PowerCurveWorker
);
delete powerCurveWorkerHost.__tgt2PowerCurveWorker;
console.log(`  Auto-shift: ${autoShift.isEnabled() ? "ON" : "OFF"}`);
console.log("  Power curve: worker + shared snapshot (10 RPM consumer / 100 RPM overlay)");

// --- WebSocket Server ---
const clients = new Set<any>();
const overlayClients = new Set<any>();

const server = Bun.serve<{ channel: "dashboard" | "overlay" }>({
  port: WS_PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const channel = path === "/overlay" ? "overlay" : "dashboard";
      if (server.upgrade(req, { data: { channel } })) return;
    }

    if (path === "/" || path === "/dashboard.html") {
      return new Response(DASHBOARD_HTML, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
    }

    if (path === "/config" && req.method === "GET") {
      return Response.json({ ...loadConfig(), configPath: CONFIG_PATH }, { headers: cors });
    }

    if (path === "/version") {
      return Response.json(getBuildInfo(), { headers: cors });
    }

    if (path === "/config" && req.method === "POST") {
      return updateAppConfig(req, cors);
    }

    if (path.startsWith("/key-agent/")) {
      return proxyKeyAgent(req, path.slice("/key-agent".length), cors);
    }

    if (path === "/admin/restart") {
      return handleRestart(req, server, cors);
    }

    // HTTP API for auto-shift control
    if (path === "/autoshift/status") {
      refreshPowerCurveSnapshot();
      return Response.json(autoShift.getStatus(), { headers: cors });
    }
    if (path === "/overlay/state") {
      return Response.json(buildOverlayState(), { headers: cors });
    }
    if (path === "/autoshift/on") {
      autoShift.setEnabled(true);
      return new Response("OK:ON", { headers: cors });
    }
    if (path === "/autoshift/off") {
      autoShift.setEnabled(false);
      return new Response("OK:OFF", { headers: cors });
    }
    if (path === "/autoshift/toggle") {
      autoShift.setEnabled(!autoShift.isEnabled());
      return new Response(`OK:${autoShift.isEnabled() ? "ON" : "OFF"}`, { headers: cors });
    }

    return new Response("T-GT II Server | /dashboard.html | /autoshift/status|on|off|toggle", { status: 200, headers: cors });
  },
  websocket: {
    open(ws) {
      if (ws.data?.channel === "overlay") {
        overlayClients.add(ws);
        ws.send(JSON.stringify({ type: "overlay_model", ...buildOverlayModel() }));
        console.log(`  Overlay WS connected (${overlayClients.size} total)`);
      } else {
        clients.add(ws);
        console.log(`  Dashboard WS connected (${clients.size} total)`);
      }
    },
    close(ws) {
      if (ws.data?.channel === "overlay") {
        overlayClients.delete(ws);
        console.log(`  Overlay WS disconnected (${overlayClients.size} total)`);
      } else {
        clients.delete(ws);
        console.log(`  Dashboard WS disconnected (${clients.size} total)`);
      }
    },
    message() {},
  },
});

console.log(`  WebSocket server on ws://0.0.0.0:${WS_PORT}`);

function sendToChannel(channel: "dashboard" | "overlay", connections: Set<any>, json: string) {
  for (const ws of connections) {
    try {
      const buffered = ws.getBufferedAmount();
      stats.maxWsBufferedBytes = Math.max(stats.maxWsBufferedBytes, buffered);
      if (buffered > MAX_WS_BUFFER_BYTES) {
        stats.slowClientDisconnects++;
        pipelineLog(`slow-client channel=${channel} buffered=${buffered} max=${MAX_WS_BUFFER_BYTES}`);
        ws.close(1013, "telemetry client too slow");
        connections.delete(ws);
        continue;
      }
      ws.send(json);
    } catch {
      connections.delete(ws);
    }
  }
}

function broadcast(json: string) {
  sendToChannel("dashboard", clients, json);
}

function broadcastOverlay(json: string) {
  sendToChannel("overlay", overlayClients, json);
}

async function setRaceStartGear() {
  try {
    const resp = await fetch(`${KEY_AGENT}/gear/hold/1`);
    console.log(`  [race] Set gear 1 via key agent: ${resp.status}`);
  } catch (e) {
    console.log(`  [race] Failed to set gear 1: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Wheel Reader ---
const wheel = new WheelReader(JOY_ID);
if (wheel.connected) {
  console.log(`\n  Wheel: ${wheel.name} (ID=${wheel.joyId})`);
  console.log(`  Axes: ${wheel.numAxes}  Buttons: ${wheel.numButtons}  POV: ${wheel.hasPov}`);
  console.log(`  Polling at ${POLL_HZ} Hz\n`);

  broadcast(JSON.stringify({
    type: "connected",
    ts: Date.now() / 1000,
    name: wheel.name,
    axes: wheel.numAxes,
    buttons: wheel.numButtons,
    hats: wheel.hasPov ? 1 : 0,
  }));

  let emitCount = 0;
  setInterval(() => {
    const events = wheel.poll();
    for (const evt of events) {
      broadcast(JSON.stringify(evt));
      emitCount++;
      if (evt.type === "button_down" && evt.button === 1) {
        autoShift.onManualUpshift(lastTelemGear);
      }
      if (evt.type === "button_down" && evt.button === 0) {
        autoShift.onManualDownshift(lastTelemGear);
      }
      if (evt.type !== "axis" || emitCount % 30 === 0) {
        console.log(formatEvent(evt));
      }
    }
  }, Math.round(1000 / POLL_HZ));
} else {
  console.log("  No joystick found (may be disconnected).");
}

// --- Forza Telemetry + Auto-shift ---
let telemCount = 0;
let lastLoggedCar = 0;
let lastTelemGear = 1;
let lastKeyAgentGear = 0;
let lastDistance = -1;
let lastLapNumber = -1;
let latestTelemetry: Record<string, any> | null = null;
let lastOverlayModelAt = 0;
let lastOverlayCarOrdinal = 0;
let pendingTelemetry: Record<string, any> | null = null;
let telemetryDecisionLocked = false;
let capturedTelemetry: Record<string, any> | null = null;
let captureRevision = 0;
let dispatchedRevision = 0;
let frameSequence = 0;
let nextDispatchDueAt = performance.now();
const stats = {
  captured: 0,
  captureOverwrites: 0,
  dispatched: 0,
  idleTicks: 0,
  algorithmConsumed: 0,
  algorithmOverwrites: 0,
  algorithmSlowFrames: 0,
  maxAlgorithmMs: 0,
  slowClientDisconnects: 0,
  maxWsBufferedBytes: 0,
  maxDispatchDelayMs: 0,
};
let lastDispatchTickAt = performance.now();

function pipelineLog(message: string) {
  appendFile(PIPELINE_LOG_PATH, `[${new Date().toISOString()}] ${message}\r\n`, () => {});
}

mkdirSync(dirname(PIPELINE_LOG_PATH), { recursive: true });
pipelineLog(`start dispatchHz=${TELEM_HZ} maxWsBufferBytes=${MAX_WS_BUFFER_BYTES}`);

async function processLatestTelemetry() {
  if (telemetryDecisionLocked) return;
  telemetryDecisionLocked = true;

  try {
    while (pendingTelemetry) {
      const evt = pendingTelemetry;
      pendingTelemetry = null;
      stats.algorithmConsumed++;
      refreshPowerCurveSnapshot();
      const algorithmStartedAt = performance.now();
      const result = await autoShift.update(evt as any);
      const algorithmMs = performance.now() - algorithmStartedAt;
      stats.maxAlgorithmMs = Math.max(stats.maxAlgorithmMs, algorithmMs);
      if (algorithmMs > DISPATCH_PERIOD_MS) stats.algorithmSlowFrames++;
      const modelNeedsRefresh = evt.car_ordinal !== lastOverlayCarOrdinal || Date.now() - lastOverlayModelAt >= 1000;
      if (modelNeedsRefresh) broadcastOverlayModel();

      if (result.action) {
        broadcast(JSON.stringify({
          type: "autoshift",
          ts: Date.now() / 1000,
          action: result.action,
          reason: result.reason,
          gear: evt.gear,
          rpm: evt.rpm,
        }));
      }

      telemCount++;
      if (telemCount % 600 === 0) {
        const s = autoShift.getStatus();
        const carInfo = s.cars[s.currentCar];
        if (carInfo) {
          const gears = Object.entries(carInfo.gears)
            .map(([g, p]: [string, any]) => `G${g}:${p.samples}`)
            .join(" ");
          console.log(`  [car ${s.currentCar}] ${carInfo.totalSamples} samples, ${carInfo.totalShifts} shifts | ${gears}`);
        }
      }
    }
  } finally {
    telemetryDecisionLocked = false;
    if (pendingTelemetry) void processLatestTelemetry();
  }
}

async function updateAppConfig(req: Request, cors: Record<string, string>) {
  const body = await req.json().catch(() => ({})) as any;
  const patch: any = {};
  if (body.shiftMode === "keyboard" || body.shiftMode === "vjoy" || body.shiftMode === "off") patch.shiftMode = body.shiftMode;
  if (typeof body.vjoyPath === "string") patch.vjoyPath = body.vjoyPath;
  if (body.manualCooldownSec != null) patch.manualCooldownSec = Number(body.manualCooldownSec);
  const config = updateConfig(patch);
  autoShift.setManualCooldownSec(config.manualCooldownSec);

  try {
    await fetch(`${KEY_AGENT}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  } catch {}

  return Response.json({ ...config, configPath: CONFIG_PATH }, { headers: cors });
}

async function proxyKeyAgent(req: Request, targetPath: string, cors: Record<string, string>) {
  const url = new URL(req.url);
  const target = `${KEY_AGENT}${targetPath}${url.search}`;
  try {
    const resp = await fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: { ...cors, "Content-Type": resp.headers.get("Content-Type") ?? "text/plain" },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502, headers: cors });
  }
}

function buildOverlayModel() {
  const curveSnapshot = powerCurve.readLatest()?.car;
  const status = autoShift.getOverlayStatus();
  const car = status.car;
  const overlayCurveCar = curveSnapshot && (!status.currentCar || curveSnapshot.carKey === status.currentCar)
    ? curveSnapshot
    : null;
  return {
    ts: Date.now() / 1000,
    autoshift: {
      enabled: status.enabled,
      currentCar: status.currentCar,
      blockUpshift: status.blockUpshift,
      blockDownshift: status.blockDownshift,
      lastShift: status.lastShift,
    },
    car: car || overlayCurveCar ? {
      totalSamples: overlayCurveCar ? overlayCurveCar.totalSamples : car!.totalSamples,
      powerBins: overlayCurveCar ? overlayCurveCar.powerBins : car!.powerBins,
      maxRpm: car?.maxRpm ?? latestTelemetry?.max_rpm ?? 0,
      idleRpm: car?.idleRpm ?? latestTelemetry?.idle_rpm ?? 0,
      peakHp: overlayCurveCar ? overlayCurveCar.peakHp : car!.peakHp,
      peakHpRpm: overlayCurveCar ? overlayCurveCar.peakHpRpm : car!.peakHpRpm,
      fuelCutRpm: car?.fuelCutRpm ?? null,
      shiftTiming: car?.shiftTiming ?? null,
      gears: car?.gears ?? {},
      powerCurve: overlayCurveCar ? overlayCurveCar.overlayCurve : [],
    } : null,
  };
}

function refreshPowerCurveSnapshot() {
  autoShift.applyPowerCurveSnapshot(powerCurve.readLatest());
}

function buildOverlayFrame(evt: Record<string, any>, seq = frameSequence) {
  return {
    type: "overlay_frame",
    seq,
    ts: evt.ts,
    telemetry: {
      rpm: evt.rpm ?? 0,
      maxRpm: evt.max_rpm ?? 0,
      idleRpm: evt.idle_rpm ?? 0,
      gear: evt.gear ?? 0,
      speedKmh: evt.speed_kmh ?? 0,
      powerHp: evt.power_hp ?? 0,
      torqueNm: evt.torque_nm ?? 0,
      throttle: evt.accel != null ? evt.accel / 255 : 0,
      brake: evt.brake != null ? evt.brake / 255 : 0,
      carOrdinal: evt.car_ordinal ?? 0,
    },
  };
}

function broadcastOverlayModel() {
  lastOverlayModelAt = Date.now();
  lastOverlayCarOrdinal = latestTelemetry?.car_ordinal ?? 0;
  broadcastOverlay(JSON.stringify({ type: "overlay_model", ...buildOverlayModel() }));
}

function buildOverlayState() {
  return {
    ...buildOverlayModel(),
    telemetry: latestTelemetry ? buildOverlayFrame(latestTelemetry).telemetry : null,
  };
}

async function handleRestart(req: Request, srv: any, cors: Record<string, string>) {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }

  const url = new URL(req.url);
  const ip = srv.requestIP?.(req)?.address ?? "";
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "";
  const config = loadConfig();
  const token = req.headers.get("X-Admin-Token") ?? url.searchParams.get("token") ?? "";
  if (!isLocal && (!config.adminToken || token !== config.adminToken)) {
    return Response.json({ error: "remote restart requires admin_token" }, { status: 403, headers: cors });
  }

  const body = req.method === "POST" ? await req.json().catch(() => ({})) as any : {};
  const exePath = String(body.exePath ?? url.searchParams.get("exe") ?? process.execPath);
  const restartArgs = Array.isArray(body.args) ? body.args.map(String) : process.argv.slice(2);
  const cwd = dirname(exePath);

  powerCurve.stop();
  autoShift.saveAll();
  console.log(`  ADMIN: restart requested from ${ip || "local"} -> ${exePath}`);

  setTimeout(() => {
    try {
      if (process.platform === "win32") {
        const cmd = `ping 127.0.0.1 -n 2 >nul & start "" ${quoteCmd(exePath)} ${restartArgs.map(quoteCmd).join(" ")}`;
        Bun.spawn(["cmd", "/c", cmd], { cwd, stdout: "ignore", stderr: "ignore" });
      } else {
        Bun.spawn([exePath, ...restartArgs], { cwd, stdout: "ignore", stderr: "ignore" });
      }
    } catch (e) {
      console.log(`  ADMIN: failed to spawn restart target: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      process.exit(0);
    }
  }, 200);

  return Response.json({ ok: true, exePath, args: restartArgs, uptimeMs: Date.now() - START_TIME }, { headers: cors });
}

function quoteCmd(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

const forza = new ForzaReceiver(UDP_PORT, TELEM_HZ, (evt) => {
  if (evt.type === "telemetry") captureTelemetryFrame(evt);
});

setInterval(dispatchCapturedTelemetry, DISPATCH_WAKE_MS);
setInterval(() => {
  const ageMs = capturedTelemetry ? Date.now() - (capturedTelemetry.ts * 1000) : -1;
  const pending = captureRevision - dispatchedRevision;
  pipelineLog(
    `captured=${stats.captured} dispatched=${stats.dispatched} captureReplaced=${stats.captureOverwrites} ` +
    `algorithm=${stats.algorithmConsumed} algorithmReplaced=${stats.algorithmOverwrites} algorithmSlow=${stats.algorithmSlowFrames} ` +
    `maxAlgorithmMs=${stats.maxAlgorithmMs.toFixed(1)} pending=${pending} ` +
    `lastInputAgeMs=${ageMs.toFixed(0)} dashClients=${clients.size} overlayClients=${overlayClients.size} ` +
    `maxWsBuffered=${stats.maxWsBufferedBytes} slowDisconnects=${stats.slowClientDisconnects} ` +
    `maxDispatchDelayMs=${stats.maxDispatchDelayMs.toFixed(1)}`
  );
  stats.maxWsBufferedBytes = 0;
  stats.maxDispatchDelayMs = 0;
  stats.maxAlgorithmMs = 0;
}, 2_000);

console.log(`  Forza UDP on port ${UDP_PORT}, aggregate/distribute at ${TELEM_HZ} Hz`);
console.log(`  Pipeline log: ${PIPELINE_LOG_PATH}`);
console.log("  Waiting for Forza telemetry data...\n");

// UDP capture is latest-wins. The 60Hz distributor emits only fresh frames,
// so downstream consumers cannot receive old frames after input stops.
function captureTelemetryFrame(evt: Record<string, any>) {
  stats.captured++;
  if (captureRevision !== dispatchedRevision) stats.captureOverwrites++;
  capturedTelemetry = evt;
  captureRevision++;
}

function dispatchCapturedTelemetry() {
  const tickAt = performance.now();
  stats.maxDispatchDelayMs = Math.max(stats.maxDispatchDelayMs, tickAt - lastDispatchTickAt - DISPATCH_WAKE_MS);
  lastDispatchTickAt = tickAt;

  if (tickAt < nextDispatchDueAt) return;
  if (!capturedTelemetry || captureRevision === dispatchedRevision) {
    stats.idleTicks++;
    return;
  }

  nextDispatchDueAt = tickAt + DISPATCH_PERIOD_MS;
  dispatchedRevision = captureRevision;
  frameSequence++;
  stats.dispatched++;
  const evt = capturedTelemetry;
  latestTelemetry = evt;
  broadcast(JSON.stringify({ ...evt, seq: frameSequence }));
  broadcastOverlay(JSON.stringify(buildOverlayFrame(evt, frameSequence)));
  powerCurve.submit(evt);

  const dist = evt.distance ?? 0;
  const lap = evt.lap_number ?? 0;
  if (lastDistance > 100 && dist < 10) {
    broadcast(JSON.stringify({ type: "race_start", ts: Date.now() / 1000 }));
    console.log("  [race] New race detected (distance reset)");
    setRaceStartGear();
  } else if (lastLapNumber > 0 && lap === 0 && lastLapNumber > lap) {
    broadcast(JSON.stringify({ type: "race_start", ts: Date.now() / 1000 }));
    console.log("  [race] New race detected (lap reset)");
    setRaceStartGear();
  }
  lastDistance = dist;
  lastLapNumber = lap;
  if (evt.gear >= 1 && evt.gear <= 10) lastTelemGear = evt.gear;
  autoShift.noteTelemetryGear(evt.gear, evt.clutch);
  if (evt.gear !== lastKeyAgentGear) {
    lastKeyAgentGear = evt.gear;
    fetch(`${KEY_AGENT}/telem/${evt.gear}`).catch(() => {});
  }

  if (pendingTelemetry) stats.algorithmOverwrites++;
  pendingTelemetry = evt;
  void processLatestTelemetry();
}

// --- Graceful shutdown: give the worker time to flush its 1 RPM source bins ---
let shutdownStarted = false;
function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  powerCurve.stop();
  autoShift.saveAll();
  setTimeout(() => process.exit(0), 100);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => { autoShift.saveAll(); });

// --- Helpers ---
function formatEvent(evt: any): string {
  switch (evt.type) {
    case "axis":        return `[Axis ${evt.axis}]  value=${evt.value > 0 ? "+" : ""}${evt.value.toFixed(5)}`;
    case "button_down": return `[Btn  ${evt.button}]  DOWN`;
    case "button_up":   return `[Btn  ${evt.button}]  UP`;
    case "hat":         return `[Hat]  value=[${evt.value}]`;
    default:            return JSON.stringify(evt);
  }
}

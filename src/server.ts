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
import { dirname } from "node:path";
import { WheelReader } from "./wheel";
import { ForzaReceiver } from "./forza";
import { AdaptiveAutoShift } from "./autoshift";
import { CONFIG_PATH, loadConfig, updateConfig } from "./config";
import { buildKeyAgentUrl, envBool, envNumber } from "./env";
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

console.log("=".repeat(60));
console.log("  T-GT II + Forza Server (Bun + TypeScript)");
console.log("  winmm.dll read-only — no DirectInput interference");
console.log("=".repeat(60));

// --- Auto-shift ---
const autoShift = new AdaptiveAutoShift();
autoShift.setEnabled(args["auto-shift"] ?? true);
console.log(`  Auto-shift: ${autoShift.isEnabled() ? "ON" : "OFF"}`);

// --- WebSocket Server ---
const clients = new Set<any>();

const server = Bun.serve({
  port: WS_PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;

    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (path === "/" || path === "/dashboard.html") {
      return new Response(DASHBOARD_HTML, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
    }

    if (path === "/config" && req.method === "GET") {
      return Response.json({ ...loadConfig(), configPath: CONFIG_PATH }, { headers: cors });
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
      return Response.json(autoShift.getStatus(), { headers: cors });
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

    if (server.upgrade(req)) return;
    return new Response("T-GT II Server | /dashboard.html | /autoshift/status|on|off|toggle", { status: 200, headers: cors });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`  WS client connected (${clients.size} total)`);
    },
    close(ws) {
      clients.delete(ws);
      console.log(`  WS client disconnected (${clients.size} total)`);
    },
    message() {},
  },
});

console.log(`  WebSocket server on ws://0.0.0.0:${WS_PORT}`);

function broadcast(json: string) {
  for (const ws of clients) {
    try { ws.send(json); } catch { clients.delete(ws); }
  }
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
let pendingTelemetry: Record<string, any> | null = null;
let telemetryDecisionLocked = false;

async function processLatestTelemetry() {
  if (telemetryDecisionLocked) return;
  telemetryDecisionLocked = true;

  try {
    while (pendingTelemetry) {
      const evt = pendingTelemetry;
      pendingTelemetry = null;
      const result = await autoShift.update(evt as any);

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
  if (body.shiftMode === "keyboard" || body.shiftMode === "vjoy") patch.shiftMode = body.shiftMode;
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
  broadcast(JSON.stringify(evt));

  // Detect new race/session: distance resets or lap number drops
  if (evt.type === "telemetry") {
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
    autoShift.noteTelemetryGear(evt.gear);
    if (evt.gear !== lastKeyAgentGear) {
      lastKeyAgentGear = evt.gear;
      fetch(`${KEY_AGENT}/telem/${evt.gear}`).catch(() => {});
    }
  }

  if (evt.type === "telemetry") {
    pendingTelemetry = evt;
    void processLatestTelemetry();
  }
});

console.log(`  Forza UDP on port ${UDP_PORT}, broadcast at ${TELEM_HZ} Hz`);
console.log("  Waiting for Forza telemetry data...\n");

// --- Graceful shutdown: persist car data ---
process.on("SIGINT", () => { autoShift.saveAll(); process.exit(0); });
process.on("SIGTERM", () => { autoShift.saveAll(); process.exit(0); });
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

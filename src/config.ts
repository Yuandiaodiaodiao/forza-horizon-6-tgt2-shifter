import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ShiftMode = "keyboard" | "vjoy" | "off";

export interface AppConfig {
  shiftMode: ShiftMode;
  vjoyPath: string;
  manualCooldownSec: number;
  adminToken: string;
}

export const APP_DATA_DIR = join(process.env.LOCALAPPDATA ?? process.cwd(), "TGT2Telemetry");
const CONFIG_DIR = APP_DATA_DIR;
export const CONFIG_PATH = join(CONFIG_DIR, "settings.ini");

const DEFAULT_CONFIG: AppConfig = {
  shiftMode: "vjoy",
  vjoyPath: "",
  manualCooldownSec: 10,
  adminToken: "",
};

function parseIni(text: string): Record<string, Record<string, string>> {
  const data: Record<string, Record<string, string>> = {};
  let section = "general";
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].toLowerCase();
      data[section] ??= {};
      continue;
    }
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    data[section] ??= {};
    data[section][line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return data;
}

function serializeIni(config: AppConfig): string {
  return [
    "; T-GT II + Forza Telemetry settings",
    "; shift_mode = keyboard, vjoy, or off",
    "[shift]",
    `shift_mode=${config.shiftMode}`,
    `manual_cooldown_sec=${config.manualCooldownSec}`,
    "",
    "[vjoy]",
    `path=${config.vjoyPath}`,
    "",
    "; Set admin_token to allow remote /admin/restart calls.",
    "; Empty token means admin restart is localhost-only.",
    "[admin]",
    `admin_token=${config.adminToken}`,
    "",
  ].join("\r\n");
}

export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  const ini = parseIni(readFileSync(CONFIG_PATH, "utf-8"));
  const shift = ini.shift ?? {};
  const vjoy = ini.vjoy ?? {};
  const admin = ini.admin ?? {};
  const mode = shift.shift_mode === "keyboard" || shift.shift_mode === "vjoy" || shift.shift_mode === "off"
    ? shift.shift_mode
    : DEFAULT_CONFIG.shiftMode;
  const cooldown = Number(shift.manual_cooldown_sec);
  return {
    shiftMode: mode,
    vjoyPath: vjoy.path ?? DEFAULT_CONFIG.vjoyPath,
    manualCooldownSec: Number.isFinite(cooldown) ? Math.max(0, Math.min(120, cooldown)) : DEFAULT_CONFIG.manualCooldownSec,
    adminToken: admin.admin_token ?? DEFAULT_CONFIG.adminToken,
  };
}

export function saveConfig(config: AppConfig) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, serializeIni(config));
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  if (next.shiftMode !== "keyboard" && next.shiftMode !== "vjoy" && next.shiftMode !== "off") next.shiftMode = DEFAULT_CONFIG.shiftMode;
  next.manualCooldownSec = Math.max(0, Math.min(120, Number(next.manualCooldownSec) || 0));
  saveConfig(next);
  return next;
}

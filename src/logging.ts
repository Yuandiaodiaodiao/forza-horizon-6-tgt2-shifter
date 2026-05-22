import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.env.LOCALAPPDATA ?? process.cwd(), "TGT2Telemetry", "logs");
export const LOG_PATH = join(LOG_DIR, "app.log");

function stringify(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function write(level: string, args: unknown[]) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(stringify).join(" ")}\r\n`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line);
  } catch {}
}

export function setupLogging() {
  write("INFO", ["=".repeat(70)]);
  write("INFO", ["process start", `pid=${process.pid}`, `exec=${process.execPath}`, `cwd=${process.cwd()}`]);
  write("INFO", ["argv", process.argv.join(" ")]);

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    write("INFO", args);
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    write("WARN", args);
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    write("ERROR", args);
    originalError(...args);
  };

  process.on("uncaughtException", (err) => {
    write("FATAL", ["uncaughtException", err]);
    originalError(err);
  });
  process.on("unhandledRejection", (reason) => {
    write("FATAL", ["unhandledRejection", reason]);
    originalError(reason);
  });

  return LOG_PATH;
}

export function logFatalStartupError(err: unknown) {
  write("FATAL", ["startup failed", err]);
}


import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envBool, envNumber, envString } from "./env";
import windowsOverlayPs1 from "./windows_overlay.ps1" with { type: "text" };

const OVERLAY_DIR = join(process.env.LOCALAPPDATA ?? process.cwd(), "TGT2Telemetry");
const OVERLAY_SCRIPT = join(OVERLAY_DIR, "windows_overlay.ps1");

export function openWindowsOverlay() {
  if (process.platform !== "win32") return;
  if (process.argv.includes("--no-overlay")) return;
  if (!envBool("TGT2_OVERLAY", true)) return;

  const host = envString("TGT2_OVERLAY_HOST", envString("TGT2_DASHBOARD_HOST", "127.0.0.1"));
  const port = envNumber("TGT2_WS_PORT", 8765);
  const wsUrl = envString("TGT2_OVERLAY_WS_URL", `ws://${host}:${port}/overlay`);
  const refreshMs = String(envNumber("TGT2_OVERLAY_REFRESH_MS", 16));

  setTimeout(() => {
    try {
      mkdirSync(OVERLAY_DIR, { recursive: true });
      const script = windowsOverlayPs1 as unknown as string;
      if (!existsSync(OVERLAY_SCRIPT) || readFileSync(OVERLAY_SCRIPT, "utf8") !== script) {
        writeFileSync(OVERLAY_SCRIPT, script, "utf8");
      }

      const proc = Bun.spawn([
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-STA",
        "-File", OVERLAY_SCRIPT,
        "-WsUrl", wsUrl,
        "-RefreshMs", refreshMs,
      ], {
        stdout: "ignore",
        stderr: "ignore",
      });
      (proc as any).unref?.();
      console.log(`  Overlay window: ${wsUrl}`);
    } catch (e) {
      console.log(`  Failed to open overlay: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 1200);
}

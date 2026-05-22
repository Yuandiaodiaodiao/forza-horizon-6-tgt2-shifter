/**
 * One-click Windows entry point.
 *
 * Imports both services into one Bun process:
 *  - key_agent HTTP control API on :7788
 *  - telemetry/autoshift/dashboard server on :8765
 */

import { LOG_PATH, logFatalStartupError, setupLogging } from "./logging";
import { envNumber, envString } from "./env";

setupLogging();
console.log(`  Log file: ${LOG_PATH}`);

function openDashboard() {
  const host = envString("TGT2_DASHBOARD_HOST", "127.0.0.1");
  const port = envNumber("TGT2_WS_PORT", 8765);
  const url = envString("TGT2_DASHBOARD_URL", `http://${host}:${port}/dashboard.html`);
  if (process.argv.includes("--no-dashboard")) return;
  setTimeout(() => {
    try {
      if (process.platform === "win32") {
        Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
      } else if (process.platform === "darwin") {
        Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
      } else {
        Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
      }
    } catch (e) {
      console.log(`  Dashboard URL: ${url}`);
      console.log(`  Failed to open browser: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 800);
}

try {
  await import("./key_agent");
  await import("./server");
  openDashboard();
} catch (e) {
  logFatalStartupError(e);
  console.error("Startup failed:", e);
  console.error(`Log file: ${LOG_PATH}`);
  if (process.platform === "win32" && !process.argv.includes("--no-error-pause")) {
    console.error("Keeping this window open for 30 seconds...");
    await Bun.sleep(30_000);
  }
  process.exit(1);
}

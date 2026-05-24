# T-GT II + Forza Telemetry — Project Notes

## Architecture (Bun + TypeScript)

```text
Windows (${TGT2_WINDOWS_HOST})                 Mac (${TGT2_MAC_HOST})
┌────────────────────────────┐               ┌──────────────────────┐
│ bun run src/server.ts      │   WS 8765     │ bun run src/proxy.ts │
│ ┌─ FFI winmm.dll (30Hz)   │ ──────────▶   │ relay → WS 8766      │
│ ├─ UDP :6688 (Forza)       │               │ dashboard.html       │
│ ├─ Adaptive Auto-Shift     │               │ served on HTTP 9999  │
│ │  └─ power-curve lookup   │               └──────────────────────┘
│ ├─ 60Hz latest-frame fanout│
│ │  ├─ dashboard WS         │
│ │  ├─ overlay WS /overlay  │
│ │  ├─ autoshift            │
│ │  └─ power-curve Worker   │
│ │     └─ shared snapshots  │
│ └─ WPF native overlay      │
│                            │
│ start_key_agent.bat        │
│ ┌─ bun run src/key_agent.ts│
│ ├─ HTTP :7788 (gear/keys)  │
│ ├─ vJoy FFI (DirectInput)  │
│ └─ user32 FFI (fallback)   │
└────────────────────────────┘
```

## Stack

- **Runtime**: Bun 1.3.14 (Windows), Bun 1.3.10 (Mac)
- **Language**: TypeScript (strict mode)
- **Joystick**: `bun:ffi` -> `winmm.dll joyGetPosEx`
- **Telemetry**: `node:dgram` UDP socket
- **WebSocket**: built-in `Bun.serve`
- **Native Overlay**: PowerShell/WPF, launched from the compiled app
- **Gear Control**: `bun:ffi` -> `vJoyInterface.dll`
- **Key Injection**: `bun:ffi` -> `user32.dll SendInput` / `keybd_event`

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Windows combined server entry point |
| `src/app.ts` | Single-process Windows app entry point |
| `src/overlay.ts` | Starts the Windows native floating overlay |
| `src/windows_overlay.ps1` | PowerShell/WPF overlay UI |
| `src/wheel.ts` | winmm joystick reader |
| `src/forza.ts` | Forza UDP telemetry parser |
| `src/autoshift.ts` | First-principles power-curve auto-shift |
| `src/power_curve_pipeline.ts` | Non-blocking shared snapshot reader / Worker input |
| `src/power_curve_worker.ts` | Per-car 1 RPM curve learning, upper-quantile aggregation, and output smoothing |
| `src/power_curve_types.ts` | Power curve snapshot and worker message contract |
| `src/key_agent.ts` | vJoy/key input agent |
| `src/proxy.ts` | Mac WebSocket relay proxy |
| `dashboard.html` | Browser dashboard |

## Key Agent

Key Agent runs on the interactive desktop session (`start_key_agent.bat`) and listens on `http://0.0.0.0:7788`.

It must be started by double-clicking `start_key_agent.bat` on the Windows desktop. SSH Session 0 cannot inject input into Session 1.

### API endpoints

- `/gear/N` — direct gear selection via vJoy (N = -1 to 10)
- `/clutch` — pulse vJoy button 12 for clutch binding
- `/up`, `/down` — sequential shift
- `/throttle/on|off`, `/brake/on|off` — hold/release keys
- `/method/A|B|E` — switch injection method
- `/ping` — health check

## Adaptive Auto-Shift

The active algorithm does not use a neural network. It is a direct physics lookup:

1. Learn one engine power curve per car/tune from clean high-throttle telemetry.
2. Learn each gear ratio from engine RPM and driven wheel speed.
3. At each frame, convert current wheel speed into RPM for `gear-1`, `gear`, and `gear+1`.
4. Compare estimated horsepower and shift only when the target gear clears shift-cost and anti-oscillation guards.

### Learning filters

- High throttle only (`accel / 255 >= 0.80`)
- Grounded suspension
- Low tire slip
- Clean surface: low rumble strip and puddle depth
- Top-sample pool per RPM bin, using high-percentile torque to avoid weak terrain samples dragging the curve down

### Guards

- Fuel-cut / post-peak usable RPM ceiling
- Fuel-cut / ceiling-triggered upshifts have an independent `500ms` debounce to prevent one limiter event from chaining multiple upshifts.
- Brake blocks upshift
- Airborne protection
- Slip guard, relaxed in low gears
- Minimum shift cooldown
- Post-shift settle window
- Shift execution must wait for three conditions before releasing planning: telemetry target gear, clutch released, and RPM matching wheel speed plus learned gear ratio within tolerance. Keep this wait bounded by timeout.
- All key-agent HTTP calls from auto-shift must use a hard timeout. A stuck `/gear/hold/N` request can otherwise leave `shiftExecutionLocked=true` and stop automatic planning while the process still appears alive.
- Reversal lock
- Larger threshold for downshift advantage
- Directional manual paddle override

## Telemetry Distribution

The server must not queue historical telemetry for dashboard, overlay, or shifting:

1. UDP capture replaces one latest-frame slot as packets arrive.
2. A fixed `TGT2_TELEM_HZ` tick, normally `60`, distributes at most one newly captured frame.
3. The same distributed frame fans out to the dashboard WebSocket, `/overlay` WebSocket, auto-shift consumer, and power-curve Worker.
4. If no new UDP frame arrives, no telemetry frame is distributed. A display still advancing after input stops indicates an old build or client-side backlog.
5. Each outbound frame has a monotonically increasing `seq`; clients can detect skipped or delayed frames without replaying stale data.

WebSocket clients are bounded by `TGT2_WS_MAX_BUFFER_KB` (default `512`). Disconnect a slow client once its send buffer exceeds the limit rather than retaining historical telemetry in memory.

### Power Curve Worker

- The worker accepts only required scalar telemetry fields and maintains full-load power samples in 1 RPM bins per car.
- Consumer snapshots use upper-quantile aggregation through `1 -> 3 -> 10 RPM/bin`; overlay snapshots aggregate once more to `100 RPM/bin`.
- Published curves are smoothed before export; points that sit too far from the local smooth line are replaced by interpolated values from neighboring inliers.
- Snapshots are published through double-buffered `SharedArrayBuffer` storage. Auto-shift and overlay read the most recent complete snapshot without waiting for curve recalculation.
- Worker source bins persist in `data/power-curves-worker.json`; legacy auto-shift curve data seeds the worker when no worker-owned profile exists.

### Pipeline Diagnostics

The compiled Windows app writes server telemetry diagnostics to:

```text
%LOCALAPPDATA%\TGT2Telemetry\logs\pipeline.log
```

The WPF overlay writes receive/render diagnostics to:

```text
%LOCALAPPDATA%\TGT2Telemetry\logs\overlay.log
```

Interpret diagnostics as follows:

- `captured` continuing to rise after a race means Forza is still sending input; it is not downstream replay.
- `captured` stopped but `dispatched` rising is a distributor bug.
- `captureReplaced` rising means UDP input exceeds the selected distribution rate; the system intentionally keeps only the newest frame.
- `algorithmReplaced` rising means shift evaluation is slower than telemetry arrival and is consuming latest frames only.
- `/autoshift/status` returning `shiftExecutionLocked: true` for multiple seconds means the auto-shift executor is stuck, usually in key-agent I/O or shift synchronization. Check `recentShifts` and `decisionTrace` for the last `EXEC ...` without a matching `SYNC ...`.
- `maxWsBuffered` rising or `slowDisconnects` increasing identifies a slow dashboard/overlay consumer.
- `maxAlgorithmMs` above one telemetry period identifies algorithm/model generation blocking the real-time loop.
- `maxDispatchDelayMs` reveals timer scheduling delays independently of WebSocket buffers.
- Overlay `wireAgeMs` increasing identifies receive/render lag; `gaps` identifies skipped sequence numbers.

## Windows Overlay

- The native overlay is embedded in the compiled executable through `src/overlay.ts` and `src/windows_overlay.ps1`.
- It connects directly to `ws://127.0.0.1:8765/overlay`; do not poll `/state` for live rendering.
- Keep dashboard and overlay on separate WebSocket channels so a stalled UI cannot delay the other consumer.
- For WPF transparency, use a transparent top-level window and change the alpha of the root panel brush. Changing `Window.Opacity` also fades chart/text and is not the desired background-opacity control.
- Do not assume one WebSocket receive result is one JSON message. A learned power curve can fragment across frames; reassemble through `EndOfMessage` before parsing. Dropping fragments causes the overlay to remain on `Learning curve...` while `/overlay/state` already contains curve data.
- Keep the WebSocket receive loop off the WPF `DispatcherTimer`. Use a background receive pump that overwrites latest model/frame snapshots; let the UI timer render only the newest available frame.
- Send a reduced overlay-only power curve, currently capped near 160 representative points. The browser dashboard may retain full detail, but sending hundreds of points every model refresh delays the real-time overlay stream.
- Gear RPM bands must render the thresholds exported by auto-shift (`leftRpm` / `rightRpm`) directly. Do not repair, expand, or infer intervals in PowerShell.
- Missing or incomplete learned gear data should still appear as fallback threshold bands for existing forward gears. N/R gears are not rendered.
- Use ASCII overlay status labels (`LEARNED`, `LEARNING / FALLBACK`) to avoid mojibake in the PowerShell/WPF text path.

### Auto-Shift Fixture Export

The Windows server exposes the current learned shift model for local regression tests:

```bash
curl "http://$TGT2_WINDOWS_HOST:8765/autoshift/export-fixture?car=current"
```

The JSON includes gear ratios, power curve points, learned/fallback shift thresholds, fuel-cut data, and learning status. Use this endpoint to pull car-specific test fixtures back to Mac instead of scraping logs.

### Windows Timing Notes

- A nominal `setInterval(..., 17)` can behave near `32ms` on Windows, yielding roughly `30Hz` even while UDP capture receives `60Hz`.
- For a `60Hz` output deadline, wake more frequently than the output period and publish only when the deadline is due. Do not rely on a rounded `17ms` interval as the cadence source.
- Avoid building full status for every stored car from the overlay refresh path. Overlay model generation must query only the current car; expanding all historical curves can block telemetry processing for hundreds of milliseconds.

## Running

```bash
# Windows — server
set PATH=%PATH%;%TGT2_WINDOWS_BUN_BIN%
cd /d %TGT2_WINDOWS_PROJECT_DIR%
bun run src/server.ts

# Windows — one-click app with browser + native overlay
bun run src/app.ts

# Compiled distributable exe (includes src/power_curve_worker.ts as a worker entrypoint)
bun run build:win

# Windows — key agent
# Double-click: %TGT2_WINDOWS_PROJECT_DIR%\start_key_agent.bat

# Mac — proxy
bun run src/proxy.ts

# Mac — dashboard
python3 -m http.server 9999 --bind 0.0.0.0
open http://localhost:9999/dashboard.html
```

## Windows Deploy Notes

Keep local deployment values in `.env` and do not commit that file:

```bash
set -a
source .env
set +a
```

For development, upload active files with `scp` to both the project root docs/config and `src/` as needed:

```bash
sshpass -p "$TGT2_WINDOWS_PASSWORD" scp -o StrictHostKeyChecking=no \
  src/autoshift.ts src/server.ts src/key_agent.ts src/forza.ts src/wheel.ts src/overlay.ts src/windows_overlay.ps1 \
  "$TGT2_WINDOWS_USER@$TGT2_WINDOWS_HOST:$TGT2_WINDOWS_PROJECT_DIR/src/"
```

Restart only the server process on TCP 8765. Do not restart `key_agent` over SSH; it must remain in the interactive desktop session for vJoy/input injection.

For end-user runs, compile and deploy the single executable:

```bash
bun run build:win
sshpass -p "$TGT2_WINDOWS_PASSWORD" scp -o StrictHostKeyChecking=no \
  dist/tgt2-telemetry.exe \
  "$TGT2_WINDOWS_USER@$TGT2_WINDOWS_HOST:Desktop/tgt2-reader/dist/tgt2-telemetry.exe"
```

If SCP cannot overwrite `tgt2-telemetry.exe`, the running Windows process is holding the file. Upload to `tgt2-telemetry.next.exe`, request `/admin/restart` with that `exePath`, then overwrite the official filename after the old process exits. Verify `/autoshift/status` afterwards; `shiftExecutionLocked` should be `false` when idle.

Use the remote-home-relative `Desktop/tgt2-reader/...` SCP path on this machine. Do not reuse an unquoted Windows backslash path loaded through shell `.env`; backslashes may be consumed and create a wrong destination directory.

Reliable restart method:

```bash
# Stop current server PID
sshpass -p "$TGT2_WINDOWS_PASSWORD" ssh -o StrictHostKeyChecking=no \
  "$TGT2_WINDOWS_USER@$TGT2_WINDOWS_HOST" \
  "for /f \"tokens=5\" %a in ('netstat -ano ^| findstr \":8765 .*LISTENING\"') do taskkill /PID %a /F"

# Start detached via Task Scheduler; Start-Process over SSH may exit without leaving 8765 listening
sshpass -p "$TGT2_WINDOWS_PASSWORD" ssh -o StrictHostKeyChecking=no \
  "$TGT2_WINDOWS_USER@$TGT2_WINDOWS_HOST" \
  "schtasks /Create /TN TGT2Server /SC ONCE /ST 23:59 /TR \"cmd /c cd /d %TGT2_WINDOWS_PROJECT_DIR% && %TGT2_WINDOWS_BUN_BIN%\\bun.exe run src/server.ts\" /F && schtasks /Run /TN TGT2Server"

# Verify listener
sshpass -p "$TGT2_WINDOWS_PASSWORD" ssh -o StrictHostKeyChecking=no \
  "$TGT2_WINDOWS_USER@$TGT2_WINDOWS_HOST" \
  "netstat -ano | findstr \"0.0.0.0:8765\""
```

Observed: foreground `bun run src/server.ts` over SSH works for debugging, but dies with the SSH session. `powershell Start-Process`/`cmd start` over SSH was unreliable on this machine. The scheduled-task launch left the server listening on 8765.

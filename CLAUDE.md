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
│ └─ WS broadcast            │
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
- **Gear Control**: `bun:ffi` -> `vJoyInterface.dll`
- **Key Injection**: `bun:ffi` -> `user32.dll SendInput` / `keybd_event`

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Windows combined server entry point |
| `src/wheel.ts` | winmm joystick reader |
| `src/forza.ts` | Forza UDP telemetry parser |
| `src/autoshift.ts` | First-principles power-curve auto-shift |
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
- Brake blocks upshift
- Airborne protection
- Slip guard, relaxed in low gears
- Minimum shift cooldown
- Post-shift settle window
- Reversal lock
- Larger threshold for downshift advantage
- Directional manual paddle override

## Running

```bash
# Windows — server
set PATH=%PATH%;%TGT2_WINDOWS_BUN_BIN%
cd /d %TGT2_WINDOWS_PROJECT_DIR%
bun run src/server.ts

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

Upload active files with `scp` to both the project root docs/config and `src/` as needed:

```bash
sshpass -p "$TGT2_WINDOWS_PASSWORD" scp -o StrictHostKeyChecking=no \
  src/autoshift.ts src/server.ts src/key_agent.ts src/forza.ts src/wheel.ts \
  "$TGT2_WINDOWS_USER@$TGT2_WINDOWS_HOST:$TGT2_WINDOWS_PROJECT_DIR/src/"
```

Restart only the server process on TCP 8765. Do not restart `key_agent` over SSH; it must remain in the interactive desktop session for vJoy/input injection.

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

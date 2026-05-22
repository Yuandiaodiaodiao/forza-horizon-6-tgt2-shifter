# Forza Horizon 6 T-GT II Semi-Auto Shifter

Bun + TypeScript implementation for reading a Thrustmaster T-GT II wheel,
receiving Forza Horizon 6 telemetry, serving a dashboard, and running a
manual/automatic hybrid shifting strategy.

## Run

```bash
# Windows one-click app (key agent + telemetry + dashboard)
bun run src/app.ts

# Build distributable Windows binary
bun run build:win

# Windows server
bun run src/server.ts

# Mac relay proxy
bun run src/proxy.ts

# Dashboard static server
python3 -m http.server 9999 --bind 0.0.0.0
```

Open `http://localhost:9999/dashboard.html`.

## Restart API

The one-click app exposes `POST /admin/restart`. Localhost can call it directly.
Remote calls require `admin_token` in `settings.ini` and the same value in
`?token=...` or `X-Admin-Token`.

```bash
curl -X POST "http://WINDOWS_IP:8765/admin/restart?token=TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"exePath\":\"C:\\\\path\\\\to\\\\new-tgt2-telemetry.exe\"}"
```

## Logs

The one-click exe writes startup and crash logs to:

```text
%LOCALAPPDATA%\TGT2Telemetry\logs\app.log
```

## Active Code

| File | Purpose |
|------|---------|
| `src/server.ts` | Windows combined server entry point |
| `src/app.ts` | Single-process Windows app entry point |
| `src/config.ts` | INI-backed local app settings |
| `src/wheel.ts` | winmm joystick reader |
| `src/forza.ts` | Forza UDP telemetry parser |
| `src/autoshift.ts` | First-principles power-curve auto-shift |
| `src/key_agent.ts` | vJoy/key input agent |
| `src/proxy.ts` | Mac WebSocket relay proxy |
| `dashboard.html` | Browser dashboard |

## Semi-Auto Shift

The active algorithm does not use a neural network. It learns one shared
engine power curve per car/tune from clean high-throttle telemetry, learns
gear ratios from wheel speed, then compares adjacent gears at the current
wheel speed. Guards handle fuel-cut, shift cost, reversal lock, brake, slip,
airborne state, and manual paddle overrides.

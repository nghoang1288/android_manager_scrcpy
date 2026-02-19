# Walkthrough: Auto-Reconnect, Tab Visibility & Cloudflare Tunnel

## Changes Made

### 1. Auto-Reconnect & Tab Visibility (`DeviceDetail.tsx`)

**Refactored** `initializeDevice` into two reusable `useCallback` functions:
- **`connectDevice()`** — Initializes transport, ADB, scrcpy client, audio/video streams
- **`disconnectDevice()`** — Cleans up all connections, audio, and video elements

**Auto-reconnect** on disconnect/error:
- Exponential backoff: 1s → 2s → 4s → ... → 30s max
- Up to 10 attempts before giving up
- Triggered by: video stream error, transport disconnect, connection failure

**Tab visibility** management:
- `visibilitychange` listener disconnects video when tab is hidden (saves bandwidth)
- Automatically reconnects when tab becomes visible again

**Connection status UI:**
- Badge in header: 🟢 Connected / 🟡 Reconnecting... / 🔴 Disconnected
- Reconnecting overlay on video area with spinner and attempt counter

---

### 2. WebSocket URL Fix

| File | Change |
|------|--------|
| `websocket-transport.ts` | `window.location.hostname:8080` → `window.location.host` |
| `DeviceDetail.tsx` | Hardcoded URL → relative `/api/...` |
| `App.tsx` | `hostname:8080` → `host` |

This ensures all connections work through any proxy, tunnel, or non-standard port.

---

### 3. Cloudflare Quick Tunnel

| File | Change |
|------|--------|
| `docker-compose.yml` | Added `tunnel` service with `cloudflare/cloudflared` |
| `index.ts` | Added `GET /api/tunnel/url` endpoint |
| `App.tsx` | Tunnel URL banner with copy button |

**How it works:**
1. `cloudflared` starts a Quick Tunnel to `https://localhost:8080` with `--no-tls-verify`
2. Random `*.trycloudflare.com` URL is generated
3. View URL: `docker logs amc-tunnel`

---

## Build & Deploy

```bash
# Build & deploy with tunnel
docker compose up -d --build

# View tunnel URL
docker logs amc-tunnel
```

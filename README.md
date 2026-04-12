# Bale VPN Tunnel 🔒

> **Route full internet through a Bale.ai voice call.**
> The slave machine (restricted to `web.bale.ai` only) exposes a WiFi hotspot.
> Every device connecting to that hotspot gets real internet — tunneled through
> Bale's LiveKit media infrastructure directly to the master node.

---

## Table of Contents

1. [How Bale Works Internally](#-how-bale-works-internally)
2. [What We Discovered (HAR Analysis)](#-what-we-discovered-har-analysis)
3. [Architecture](#-architecture)
4. [How the Tunnel Works](#-how-the-tunnel-works-step-by-step)
5. [Repository Structure](#-repository-structure)
6. [Setup & Running](#-setup--running)
7. [Environment Variables](#-environment-variables)
8. [Token Capture Flow](#-token-capture-flow)
9. [Troubleshooting](#-troubleshooting)
10. [Security Notes](#-security-notes)

---

## 📡 How Bale Works Internally

This section documents Bale's internal call infrastructure, reverse-engineered
from a live HAR capture of `web.bale.ai` during a voice call.

### Bale uses LiveKit as its SFU

Bale does **not** implement its own WebRTC stack. It delegates all real-time
media to **LiveKit** — an open-source, scalable WebRTC SFU (Selective Forwarding
Unit).

| Component | Value |
|-----------|-------|
| SFU type | [LiveKit](https://livekit.io/) (open source) |
| Signaling server | `wss://meet-em.ble.ir/rtc` |
| CDN/Infrastructure | Sotoon CDN (`*.ble.ir`, `185.166.104.x`) |
| SDK version | `livekit-client` v2.15.2, protocol 16 |
| SFU server IP | `2.188.186.66` (Iran) |
| Fallback TCP port | **445** (passive, great for restricted firewalls) |
| STUN server | standard public STUN (discovers external IP) |

### The WebSocket signaling URL

When a call starts, Bale's frontend connects to:
```
wss://meet-em.ble.ir/rtc
  ?access_token=<JWT>
  &auto_subscribe=1
  &sdk=js
  &version=2.15.2
  &protocol=16
  &adaptive_stream=1
```

On reconnect it adds `&reconnect=1&sid=<session_id>&reconnect_reason=1`.

### JWT token structure (LiveKit standard)

Bale generates a short-lived JWT for each call participant. The token is
signed by Bale's LiveKit API secret (not public). Decoded payload structure:

```json
{
  "iss": "<LIVEKIT_API_KEY>",
  "sub": "<BALE_USER_ID>",
  "exp": <unix_timestamp>,
  "nbf": <unix_timestamp>,
  "kind": "standard",
  "attributes": {
    "name": "",
    "raise_hand": "0"
  },
  "video": {
    "canPublish":     true,
    "canPublishData": true,
    "canSubscribe":   true,
    "room":           "<ROOM_UUID>",
    "roomAdmin":      true,
    "roomJoin":       true
  },
  "metadata": "{\"user_id\":<BALE_USER_ID>, \"auth_sid\":<AUTH_SID>}"
}
```

**Key flag: `canPublishData: true`** — the LiveKit server explicitly allows
binary data track publishing. This is the foundation of our tunnel.

### WebRTC SDP structure

Each call SDP contains **two PeerConnections**:

1. **Subscriber PC** — SFU → browser (incoming audio/video)
2. **Publisher PC** — browser → SFU (outgoing audio/video)

Both SDPs include:
```
m=application <PORT> UDP/DTLS/SCTP webrtc-datachannel
a=sctp-port:5000
a=max-message-size:262144    ← 256 KB per message!
a=sendrecv
```

This means every Bale call already has a bidirectional **data channel** open
with 256 KB message size. We use this for raw IP packet transport.

### LiveKit signaling protocol

Messages over the WebSocket are **Protobuf-encoded** (`livekit-protocol` schema).
Key message types:

| Proto message | Direction | Purpose |
|---------------|-----------|---------|
| `SignalRequest { offer }` | Client → Server | SDP offer (publisher PC) |
| `SignalResponse { answer }` | Server → Client | SDP answer |
| `SignalRequest { answer }` | Client → Server | SDP answer (subscriber PC) |
| `SignalResponse { offer }` | Server → Client | SDP offer from SFU |
| `SignalRequest { trickle }` | Both | ICE candidate (JSON in proto) |
| `SignalResponse { join }` | Server → Client | Room info on connect |
| `SignalResponse { token_refresh }` | Server → Client | New JWT before expiry |
| `SignalRequest { add_track }` | Client → Server | Register a new track |

ICE candidates are JSON inside the protobuf `trickle` field:
```json
{
  "candidate": "candidate:807906550 1 udp 2130706431 2.188.186.66 34971 typ host",
  "sdpMid": "0",
  "sdpMLineIndex": 0,
  "usernameFragment": null
}
```

### How data tracks work in LiveKit

LiveKit data tracks use the WebRTC data channel under the hood, published
to all room participants via the SFU's SCTP relay:

```javascript
// Publish binary data to all subscribers in the room
await room.localParticipant.publishData(
  new Uint8Array(ipPacket),
  { reliable: false, topic: 'vpn' }   // LOSSY = UDP semantics for IP packets
);

// Receive data from any participant
room.on(RoomEvent.DataReceived, (data, participant, kind, topic) => {
  if (topic === 'vpn') writeToTunDevice(Buffer.from(data));
});
```

`reliable: false` maps to `DataPacket_Kind.LOSSY` — uses unordered SCTP
delivery, matching UDP semantics for IP forwarding. Use `reliable: true`
for TCP-only scenarios where you need packet ordering.

---

## 🔬 What We Discovered (HAR Analysis)

A HAR capture of `web.bale.ai` during a live call revealed:

| Discovery | Details |
|-----------|---------|
| SFU backend | LiveKit — not a proprietary Bale stack |
| Data channel in SDP | `m=application webrtc-datachannel` present in every call |
| Max message size | **262,144 bytes** (256 KB) per data frame |
| `canPublishData` | `true` — server grants data publishing to all call participants |
| Reconnect strategy | Uses `sid` + `reconnect_reason=1` query params |
| Token refresh | Server sends new JWT before expiry (no reconnect needed) |
| TCP fallback port | **445** — survives most corporate/restricted firewalls |
| Infrastructure | Sotoon CDN (Iran), IP `2.188.186.66`, port `34971` UDP / `445` TCP |
| `ble.ir` reachable | `meet-em.ble.ir`, `cdn-siloo.ble.ir` — same CDN as `bale.ai` |

**Critical implication:** The slave machine only needs access to `*.bale.ai`
and `*.ble.ir`. Since both are on Sotoon CDN, a firewall that allows Bale
also allows the LiveKit SFU. **No special ports need to be open.**

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SLAVE MACHINE                            │
│  (restricted internet: only bale.ai / ble.ir allowed)          │
│                                                                 │
│  ┌─────────────┐    ┌────────────┐    ┌─────────────────────┐  │
│  │  WiFi AP    │    │  iptables  │    │      tun0           │  │
│  │  hostapd    │───▶│    NAT     │───▶│   10.0.0.2/30       │  │
│  │  dnsmasq    │    │ MASQUERADE │    │  (TUN device)       │  │
│  └─────────────┘    └────────────┘    └──────────┬──────────┘  │
│   192.168.77.0/24                                │             │
│                                           IP packets            │
│                                                  │             │
│                                    ┌─────────────▼───────────┐ │
│                                    │   @livekit/rtc-node     │ │
│                                    │   publishData(pkt,      │ │
│                                    │     {topic:'vpn'})      │ │
│                                    └─────────────┬───────────┘ │
└──────────────────────────────────────────────────┼─────────────┘
                                                   │
                                    wss://meet-em.ble.ir/rtc
                                    (LiveKit SFU — Bale's infra)
                                    Data Channel (SCTP/DTLS)
                                    Max message: 256 KB
                                    TCP fallback port 445
                                                   │
┌──────────────────────────────────────────────────┼─────────────┐
│                        MASTER MACHINE            │             │
│               (full internet access)             │             │
│                                                  │             │
│                                    ┌─────────────▼───────────┐ │
│                                    │   @livekit/rtc-node     │ │
│                                    │   DataReceived(pkt)     │ │
│                                    └─────────────┬───────────┘ │
│                                                  │             │
│                                    ┌─────────────▼───────────┐ │
│                                    │      tun0               │ │
│                                    │   10.0.0.1/30           │ │
│                                    └─────────────┬───────────┘ │
│                                                  │             │
│                                    ┌─────────────▼───────────┐ │
│                                    │  iptables MASQUERADE    │ │
│                                    │  tun0 → eth0            │ │
│                                    └─────────────┬───────────┘ │
└──────────────────────────────────────────────────┼─────────────┘
                                                   │
                                              🌐 Internet
```

### IP addressing

| Interface | IP | Role |
|-----------|----|------|
| `tun0` on master | `10.0.0.1` | VPN gateway |
| `tun0` on slave | `10.0.0.2` | VPN client |
| `wlan0` on slave | `192.168.77.1` | Hotspot gateway |
| Hotspot DHCP pool | `192.168.77.10–100` | Connected devices |

---

## 🔄 How the Tunnel Works (Step by Step)

### Phase 1 — Token Capture (one time only)

```
Both nodes run Puppeteer with a WebSocket interceptor:

window.WebSocket = function(url, ...args) {
  if (url.includes('meet-em.ble.ir')) {
    const token = url.match(/access_token=([^&]+)/)[1];
    window.__livekitToken = token;   // captured!
  }
  return new OrigWS(url, ...args);
};
```

This fires when Bale's livekit-client connects to the SFU
during a voice call. The token is saved to `/app/session/livekit_token.json`.

### Phase 2 — Native LiveKit connection (every subsequent run)

Both containers use `@livekit/rtc-node` to join the **same LiveKit room**
without a browser:

```
Master & Slave:
  new Room()
  room.connect('wss://meet-em.ble.ir', token, { autoSubscribe: true })
  room.on(RoomEvent.DataReceived, ...)
  room.localParticipant.publishData(...)
```

### Phase 3 — Packet forwarding loop

```
Slave → Master:

  [Hotspot client TCP/UDP packet]
       ↓ kernel routes via tun0 default route
  [tun_manager.py reads from /dev/net/tun]
       ↓ 2-byte length prefix framing
  [Node.js reassembles → publishData(pkt, {topic:'vpn'})]
       ↓ LiveKit SCTP data channel
  [Master DataReceived event]
       ↓ strip length prefix
  [tun_manager.py writes to /dev/net/tun]
       ↓ Linux IP stack
  [iptables NAT → eth0 → Internet]

Master → Slave: exact reverse path
```

### Phase 4 — WiFi hotspot

After routing is configured on the slave:
```sh
hostapd  → creates WiFi AP on wlan0
dnsmasq  → provides DHCP + DNS to connected devices
iptables → MASQUERADE wlan0 → tun0
```

Any device connecting to the hotspot has a default route pointing to `tun0`,
which tunnels through LiveKit to the master's internet.

---

## 📁 Repository Structure

```
bale-tunnel/
│
├── master/
│   ├── Dockerfile         Ubuntu 22.04, Node 20, Chromium, Python 3
│   ├── package.json       @livekit/rtc-node, puppeteer, puppeteer-extra-stealth
│   ├── tunnel.js          ★ Main orchestrator (token capture + LiveKit + TUN)
│   ├── tun_manager.py     ★ TUN device I/O — /dev/net/tun ↔ stdin/stdout frames
│   ├── gateway.sh         iptables NAT: tun0 → eth0 → internet
│   └── .env.example       Config template
│
├── slave/
│   ├── Dockerfile         Same base + hostapd + dnsmasq + rfkill + iw
│   ├── package.json       Same Node deps
│   ├── tunnel.js          ★ Slave orchestrator (token capture + LiveKit + TUN + hotspot)
│   ├── tun_manager.py     Same TUN manager (different IPs)
│   ├── hotspot.sh         hostapd + dnsmasq WiFi AP setup
│   └── .env.example
│
├── docker-compose.yml     Local dev: both containers on one machine
├── HAR_ANALYSIS.md        Bale internals: LiveKit protocol reverse engineering
├── .env.example           Root env config
├── .gitignore             Excludes .env, sessions, chrome profiles
└── README.md              This file
```

### Key file: `tun_manager.py`

A Python subprocess that owns `/dev/net/tun` and communicates with Node.js
via stdin/stdout using 2-byte big-endian length-prefixed frames:

```
[2 bytes: packet length BE] [N bytes: raw IP packet]
```

Why Python? The `fcntl.ioctl(fd, TUNSETIFF, ifr)` syscall to bind a TUN
device is trivial in Python but requires native bindings in Node.js.
This design keeps Node.js pure-JS while Python handles the privileged syscall.

### Key file: `tunnel.js` (both nodes)

Responsibilities in order of execution:
1. Check for saved LiveKit token → if none, launch Puppeteer
2. Puppeteer opens Bale, user logs in + starts call → token captured + saved
3. Puppeteer closes — not needed again until token expires
4. `@livekit/rtc-node` joins the LiveKit room
5. Master: sets up iptables NAT, starts TUN, forwards packets to internet
6. Slave: sets up TUN routing, launches hotspot, forwards packets to master

---

## 🚀 Setup & Running

### Prerequisites

| Requirement | Master | Slave |
|-------------|--------|-------|
| Linux OS (real kernel, not WSL2) | ✅ | ✅ |
| Docker Engine v24+ | ✅ | ✅ |
| `/dev/net/tun` device | ✅ | ✅ |
| WiFi card with AP mode support | ❌ | ✅ |
| Full internet access | ✅ | ❌ |
| Bale account (2nd phone number) | ✅ | ✅ |

**Check WiFi AP mode (slave):**
```bash
iw phy phy0 info | grep -A 10 "Supported interface modes"
# Must include: * AP
```

**Check TUN module (both):**
```bash
ls /dev/net/tun   # must exist
modprobe tun      # load module if missing
```

### Step 1 — Clone & configure

```bash
git clone https://github.com/Z23599848/Yes.git bale-tunnel
cd bale-tunnel
```

**Master:**
```bash
cp master/.env.example master/.env
# Edit master/.env:
#   BALE_PHONE=+989XXXXXXXXX
#   INTERNET_IFACE=eth0
```

**Slave:**
```bash
cp slave/.env.example slave/.env
# Edit slave/.env:
#   BALE_PHONE=+989YYYYYYYYY     (different account!)
#   MASTER_BALE_PHONE=+989XXXXXXXXX
#   WIFI_IFACE=wlan0
#   HOTSPOT_SSID=BaleTunnel
#   HOTSPOT_PASS=tunnel1234
```

### Step 2 — Build Docker images

**On master machine:**
```bash
docker build -t bale-vpn-master ./master
```

**On slave machine:**
```bash
docker build -t bale-vpn-slave ./slave
```

### Step 3 — Run and capture tokens (first time only)

Both machines run simultaneously. Each opens a browser window.

**Master:**
```bash
docker run --privileged --cap-add NET_ADMIN \
  --device /dev/net/tun \
  --env-file master/.env \
  -e HEADLESS=false \
  -v $(pwd)/master/session:/app/session \
  -it bale-vpn-master
```

**Slave:**
```bash
docker run --privileged --cap-add NET_ADMIN \
  --network host \
  --device /dev/net/tun \
  --env-file slave/.env \
  -e HEADLESS=false \
  -v $(pwd)/slave/session:/app/session \
  -it bale-vpn-slave
```

**In each browser window:**
1. Log in with the respective Bale phone number (enter OTP)
2. Slave: open chat with master's phone number, start a **voice call**
3. Master: accept the call
4. Once the call connects, press **ENTER** in each terminal
5. The LiveKit token is saved — browser closes — tunnel starts

### Step 4 — Subsequent runs (headless, no browser)

```bash
# Master
docker run --privileged --cap-add NET_ADMIN \
  --device /dev/net/tun \
  --env-file master/.env \
  -e HEADLESS=true \
  -v $(pwd)/master/session:/app/session \
  -d bale-vpn-master

# Slave
docker run --privileged --cap-add NET_ADMIN \
  --network host \
  --device /dev/net/tun \
  --env-file slave/.env \
  -e HEADLESS=true \
  -v $(pwd)/slave/session:/app/session \
  -d bale-vpn-slave
```

The token file `session/livekit_token.json` persists in the volume.
No browser, no manual interaction needed.

### Development (both containers on one machine)

```bash
cp .env.example .env  # fill in MASTER_BALE_PHONE and SLAVE_BALE_PHONE
docker-compose up --build
```

---

## ⚙️ Environment Variables

### Master

| Variable | Default | Description |
|----------|---------|-------------|
| `BALE_PHONE` | — | Phone number for master Bale account (`+989...`) |
| `HEADLESS` | `false` | `true` after first token capture |
| `LIVEKIT_TOKEN` | — | Paste token directly (skips Puppeteer entirely) |
| `LIVEKIT_URL` | `wss://meet-em.ble.ir` | LiveKit SFU URL |
| `TUN_LOCAL_IP` | `10.0.0.1` | Master TUN interface IP |
| `TUN_PEER_IP` | `10.0.0.2` | Slave TUN interface IP (point-to-point) |
| `INTERNET_IFACE` | `eth0` | Container's outbound internet NIC |
| `SESSION_FILE` | `/app/session/master_session.json` | Bale browser session |
| `TOKEN_FILE` | `/app/session/livekit_token.json` | LiveKit token cache |

### Slave

| Variable | Default | Description |
|----------|---------|-------------|
| `BALE_PHONE` | — | Phone number for slave Bale account (different!) |
| `MASTER_BALE_PHONE` | — | Master's phone number (to open chat and call) |
| `HEADLESS` | `false` | `true` after first token capture |
| `LIVEKIT_TOKEN` | — | Paste token directly |
| `LIVEKIT_URL` | `wss://meet-em.ble.ir` | LiveKit SFU URL |
| `TUN_LOCAL_IP` | `10.0.0.2` | Slave TUN interface IP |
| `TUN_PEER_IP` | `10.0.0.1` | Master TUN interface IP |
| `WIFI_IFACE` | `wlan0` | Physical WiFi adapter for hostapd |
| `HOTSPOT_SSID` | `BaleTunnel` | WiFi network name |
| `HOTSPOT_PASS` | `tunnel1234` | WiFi password |
| `SESSION_FILE` | `/app/session/slave_session.json` | Bale browser session |
| `TOKEN_FILE` | `/app/session/livekit_token.json` | LiveKit token cache |

---

## 🔑 Token Capture Flow

The most important step. Here's exactly what happens inside the browser:

```javascript
// Injected as evaluateOnNewDocument (runs before Bale's JS)
const OrigWS = window.WebSocket;
window.WebSocket = function(url, ...args) {
  if (url.includes('meet-em.ble.ir')) {
    // URL looks like:
    // wss://meet-em.ble.ir/rtc?access_token=eyJ...&auto_subscribe=1&sdk=js&...
    const token = url.match(/access_token=([^&]+)/)[1];
    window.__livekitToken = token;
    window.__livekitTokenCaptured = true;
  }
  return new OrigWS(url, ...args);
};
```

Puppeteer polls `window.__livekitToken` after you press ENTER. Once found,
it's saved to `livekit_token.json` and the browser closes.

**When does the token expire?**
LiveKit tokens from Bale expire after ~6 hours (`exp` claim). When the token
expires, the LiveKit server sends a `token_refresh` SignalResponse with a
new token automatically — `@livekit/rtc-node` handles this transparently
via the `RoomEvent.TokenExpiring` event. Long-running tunnels should survive
without re-login.

**If the token is permanently expired:**
Delete `session/livekit_token.json` and rerun with `HEADLESS=false` to
capture a new one.

---

## 🔧 Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No LiveKit token captured` | Call didn't start before ENTER | Token fires on WS connect to `meet-em.ble.ir`; make sure call is ringing |
| `canPublishData` error | Bale JWT lacks the flag | Use a newer Bale account or check if Bale changed their policy |
| `TUN device not found` | Module not loaded | `modprobe tun` or add `--device /dev/net/tun` to docker run |
| `Permission denied on /dev/net/tun` | Missing `CAP_NET_ADMIN` | Add `--privileged` or `--cap-add NET_ADMIN` |
| Hotspot starts but no internet | Routing not set up | Check `ip route` on slave: `default dev tun0` must be present |
| LiveKit disconnects frequently | Token expired or network drop | Code auto-reconnects; check logs for `DisconnectReason` |
| `meet-em.ble.ir` unreachable on slave | Firewall too strict | Try port 443 (HTTPS) — LiveKit falls back to WS over 443; add `ble.ir` to allowed domains |
| `hostapd` fails | WiFi card doesn't support AP mode | Verify with `iw phy phy0 info \| grep AP`; try a USB WiFi adapter (Alfa AWUS036ACH recommended) |
| Packets sent but not received | Wrong room — tokens from different calls | Both nodes must join the **same** LiveKit room UUID (check JWT `video.room` field matches) |

---

## 🔐 Security Notes

- **`.env` files are in `.gitignore`** — never committed.
- **Session files** (`session/`) are in `.gitignore` — stored in Docker volumes only.
- **LiveKit tokens** are short-lived JWTs (≈6h TTL) and are auto-refreshed.
- **The WebSocket bridge** in v1 listened on `127.0.0.1` only (not exposed). v2 has no local bridge — data goes directly through `@livekit/rtc-node`.
- **NAT on master** ensures slave clients cannot see each other's traffic or the master's LAN.
- **The HAR file** (`web.bale.ai.har`) must **never be committed** — it contains session cookies and tokens. It is listed in `.gitignore`.

---

## 📚 References & Related Projects

| Resource | Link |
|----------|------|
| LiveKit open source SFU | https://github.com/livekit/livekit |
| LiveKit protocol (protobuf) | https://github.com/livekit/protocol |
| `@livekit/rtc-node` | https://github.com/livekit/node-sdks |
| LiveKit data channels docs | https://docs.livekit.io/guides/data-messages |
| Linux TUN/TAP docs | https://www.kernel.org/doc/Documentation/networking/tuntap.txt |
| hostapd AP mode | https://w1.fi/hostapd/ |
| LiveKit JWT reference | https://docs.livekit.io/home/get-started/authentication |

---

*Built by reverse-engineering a Bale HAR capture and discovering its LiveKit backend.
The key insight: `canPublishData: true` in the JWT means binary data travels
through Bale's own call infrastructure — no side channels needed.*

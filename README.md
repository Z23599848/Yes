# Bale VPN Tunnel 🔒

> **Tunnel full internet access through a Bale voice call.**
> The slave machine (restricted to `web.bale.ai` only) creates a WiFi hotspot.
> All devices on that hotspot get real internet via the master node—over a
> WebRTC data channel established through the Bale call.

---

## Architecture

```
[Hotspot Clients]
     │ WiFi
[Slave — wlan0 AP]
     │ iptables NAT
[Slave TUN0  10.0.0.2] ──── IP packets ────
     │                                    │
[Slave JS — WebRTC DataChannel]    [Master JS — WebRTC DataChannel]
     │                                    │
     └──────── bale.ai WebRTC ───────────┘
                                          │
                               [Master TUN0  10.0.0.1]
                                          │ iptables NAT
                               [Master eth0 → Internet 🌐]
```

### How it works

1. **Both nodes** open `https://web.bale.ai/` in a headless Chromium browser.
2. A JavaScript payload is injected that **monkey-patches `RTCPeerConnection`**
   before Bale's code loads, capturing every peer connection.
3. The **slave initiates a Bale voice call** to the master.
   This creates a standard WebRTC peer connection through Bale's TURN servers.
4. The slave **adds a binary data channel** (`vpn-tunnel`) to that same PC and
   sends a `[VPN:OFFER]` signaling message via the Bale chat.
5. The master receives the offer, creates an SDP answer, sends `[VPN:ANSWER]`.
   ICE candidates are exchanged as `[VPN:ICE]` chat messages.
6. Once the data channel opens, raw **IP packets** flow over it—making it a VPN.
7. The slave configures **`tun0`** as the default route and launches a
   **WiFi hotspot** (`hostapd` + `dnsmasq`).
   All hotspot traffic → TUN0 → data channel → master → internet.

---

## Requirements

### Master (your internet-connected PC)
| Requirement | Notes |
|-------------|-------|
| Linux (or WSL2 + real kernel) | Docker with `--privileged` |
| Docker Engine | v24+ |
| `/dev/net/tun` | TUN module must be loaded |
| A Bale account | Phone number + OTP for first login |

### Slave (restricted PC — only bale.ai)
| Requirement | Notes |
|-------------|-------|
| Linux with real kernel | NOT WSL2 |
| Docker Engine | v24+ |
| `/dev/net/tun` | TUN module must be loaded |
| **WiFi card supporting AP mode** | Verify below |
| A **different** Bale account | Second phone number |

**Check WiFi AP mode:**
```bash
iw phy phy0 info | grep -A 10 "Supported interface modes"
# Must show: * AP
```

---

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/Z23599848/yes.git
cd yes
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your Bale phone numbers and WiFi settings
nano .env
```

### 3A. Master (run on your PC)

```bash
cd master
cp .env.example .env
# Edit master/.env
docker build -t bale-vpn-master .
docker run --privileged --cap-add NET_ADMIN \
  --device /dev/net/tun \
  -e BALE_PHONE="+989XXXXXXXXX" \
  -e HEADLESS=false \
  -v $(pwd)/session:/app/session \
  -it bale-vpn-master
```

On **first run**, a browser will open. Log in manually, then press **ENTER** in the terminal. The session is saved for future runs.

### 3B. Slave (run on the restricted PC)

```bash
cd slave
cp .env.example .env
# Edit slave/.env
docker build -t bale-vpn-slave .
docker run --privileged --cap-add NET_ADMIN \
  --network host \
  --device /dev/net/tun \
  -e BALE_PHONE="+989YYYYYYYYY" \
  -e MASTER_BALE_PHONE="+989XXXXXXXXX" \
  -e HEADLESS=false \
  -e WIFI_IFACE=wlan0 \
  -e HOTSPOT_SSID=BaleTunnel \
  -e HOTSPOT_PASS=tunnel1234 \
  -v $(pwd)/session:/app/session \
  -it bale-vpn-slave
```

> ⚠️ The slave needs `--network host` so `hostapd` can control the physical WiFi adapter.

### 4. Both logged in? The tunnel starts automatically.

The slave will:
1. Find and open the master's Bale chat
2. Start a voice call
3. Exchange WebRTC signaling via chat messages
4. Launch the WiFi hotspot

Connect any device to **BaleTunnel** and it gets full internet.

---

## Development (both on same machine)

```bash
cp .env.example .env
docker-compose up --build
```

Note: on a single Linux machine, you still need a real WiFi adapter in AP mode
for the hotspot part. The VPN tunnel itself works without it.

---

## Environment Variables

### Master

| Variable | Default | Description |
|----------|---------|-------------|
| `BALE_PHONE` | — | Master Bale account phone (`+989...`) |
| `HEADLESS` | `false` | `true` after first login |
| `TUN_LOCAL_IP` | `10.0.0.1` | Master TUN IP |
| `TUN_PEER_IP` | `10.0.0.2` | Slave TUN IP |
| `INTERNET_IFACE` | `eth0` | Container's outbound NIC |
| `WS_BRIDGE_PORT` | `9876` | Local WebSocket bridge port |

### Slave

| Variable | Default | Description |
|----------|---------|-------------|
| `BALE_PHONE` | — | Slave Bale account phone |
| `MASTER_BALE_PHONE` | — | Master's phone (to find & call) |
| `HEADLESS` | `false` | `true` after first login |
| `WIFI_IFACE` | `wlan0` | Physical WiFi adapter |
| `HOTSPOT_SSID` | `BaleTunnel` | Hotspot network name |
| `HOTSPOT_PASS` | `tunnel1234` | Hotspot password |
| `TUN_LOCAL_IP` | `10.0.0.2` | Slave TUN IP |
| `TUN_PEER_IP` | `10.0.0.1` | Master TUN IP |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `No RTCPeerConnection detected` | Make sure you started the voice call before hitting ENTER |
| `no-input-found` in logs | Bale UI changed selectors; open browser and type chat manually |
| WiFi hotspot fails | Check `iw phy phy0 info` — card may not support AP mode |
| Tunnel packets not forwarding | Check `iptables -L -t nat` on both master and slave |
| Data channel never opens | Bale's SFU may be stripping data channels — try direct P2P call |

---

## File Structure

```
bale-tunnel/
├── master/
│   ├── Dockerfile         # Ubuntu + Node20 + Chromium + Python3
│   ├── package.json
│   ├── tunnel.js          # Main orchestrator: Puppeteer + WS bridge + signaling
│   ├── tun_manager.py     # TUN device I/O bridge (stdin/stdout framed packets)
│   ├── gateway.sh         # iptables NAT for master
│   └── .env.example
├── slave/
│   ├── Dockerfile
│   ├── package.json
│   ├── tunnel.js          # Slave orchestrator: call, offer, hotspot
│   ├── tun_manager.py     # Same TUN manager with slave IPs
│   ├── hotspot.sh         # hostapd + dnsmasq WiFi AP setup
│   └── .env.example
├── docker-compose.yml     # Local dev: both containers
├── .env.example
├── .gitignore
└── README.md
```

---

## Security Notes

- The `.env` files containing phone numbers are in `.gitignore`.
- Sessions are stored in Docker volumes (`master-session`, `slave-session`), not in the repo.
- The WebSocket bridge listens on `127.0.0.1` only (not exposed externally).
- All traffic to the internet is NAT'd through the master — the slave never directly touches the internet beyond `bale.ai`.

---

*Built with Puppeteer, WebRTC, Linux TUN/TAP, hostapd, and Bale's WebRTC infrastructure.*

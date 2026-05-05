# Bale VPN Tunnel

Route traffic through a Bale.ai voice call by capturing the LiveKit token that
Bale's web app creates when a call starts.

This repo has two roles:

- `master`: runs on the machine with normal internet access and acts as the
  gateway.
- `slave`: runs on the restricted machine, starts a hotspot, and sends traffic
  through the Bale/LiveKit call to the master.

For the reverse-engineering notes, see [HAR_ANALYSIS.md](HAR_ANALYSIS.md).

## Quick Start

Run this on both machines:

```bash
git clone https://github.com/Z23599848/Yes.git bale-tunnel
cd bale-tunnel
node setup.js
```

The wrapper asks:

- whether this machine is `master` or `slave`
- the Bale phone number for this machine
- on the slave, the master's Bale phone number to call
- network settings such as `INTERNET_IFACE`, `WIFI_IFACE`, hotspot SSID, and
  hotspot password

It then writes the ignored role-specific `.env` file, builds the Docker image,
mounts the role's `session/` directory, and starts the container.

## First Run

On first run there is no saved LiveKit token, so the wrapper sets
`HEADLESS=false`.

The role script will:

1. Open Bale Web in Puppeteer.
2. Submit the Bale phone number.
3. Prompt in the terminal for the SMS OTP if Bale asks for one.
4. Save Bale session cookies/localStorage under `master/session/` or
   `slave/session/`.
5. On the slave, open the master chat and start a voice call.
6. On the master, detect and accept the incoming call.
7. Capture the LiveKit token from the `meet-em.ble.ir` WebSocket URL.
8. Save the token to `session/livekit_token.json`.
9. Close the browser and start the tunnel.

Do not paste OTP codes into chat or commit them. The scripts use the OTP only in
the current terminal session and do not store it.

## Subsequent Runs

After `session/livekit_token.json` exists, run:

```bash
node setup.js
```

The wrapper detects the saved token, sets `HEADLESS=true`, skips Puppeteer, and
connects directly with the native LiveKit client.

If a token becomes permanently invalid, delete the token file on the affected
machine and rerun the wrapper:

```bash
rm master/session/livekit_token.json
# or
rm slave/session/livekit_token.json
node setup.js
```

LiveKit tokens from Bale are expected to expire after roughly 6 hours, but the
LiveKit client may receive refreshes during a live session.

## Requirements

| Requirement | Master | Slave |
| --- | --- | --- |
| Linux with a real kernel | yes | yes |
| Docker Engine 24+ | yes | yes |
| Node.js 18+ for `setup.js` | yes | yes |
| `/dev/net/tun` | yes | yes |
| Full internet access | yes | no |
| WiFi card with AP mode | no | yes |
| Separate Bale account/phone number | yes | yes |

Check TUN:

```bash
ls /dev/net/tun
sudo modprobe tun
```

Check AP mode on the slave:

```bash
iw phy phy0 info | grep -A 10 "Supported interface modes"
```

## Manual Docker Commands

Use these only when debugging the wrapper.

Master:

```bash
docker build -t bale-vpn-master ./master
docker run --privileged --cap-add NET_ADMIN \
  --device /dev/net/tun \
  --env-file master/.env \
  -v "$(pwd)/master/session:/app/session" \
  -it bale-vpn-master
```

Slave:

```bash
docker build -t bale-vpn-slave ./slave
docker run --privileged --cap-add NET_ADMIN \
  --network host \
  --device /dev/net/tun \
  --env-file slave/.env \
  -v "$(pwd)/slave/session:/app/session" \
  -it bale-vpn-slave
```

## Environment Variables

The wrapper writes these automatically.

Master:

| Variable | Purpose |
| --- | --- |
| `BALE_PHONE` | Master's Bale account phone number |
| `INTERNET_IFACE` | Master's outbound internet interface, usually `eth0` |
| `HEADLESS` | `false` for token capture, `true` after token exists |
| `SESSION_FILE` | Bale browser session path inside the container |
| `TOKEN_FILE` | LiveKit token path inside the container |

Slave:

| Variable | Purpose |
| --- | --- |
| `BALE_PHONE` | Slave's Bale account phone number |
| `MASTER_BALE_PHONE` | Master's Bale phone number to call |
| `WIFI_IFACE` | Slave WiFi adapter for the hotspot |
| `HOTSPOT_SSID` | Hotspot network name |
| `HOTSPOT_PASS` | Hotspot password |
| `HEADLESS` | `false` for token capture, `true` after token exists |

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| `No LiveKit token captured` | Make sure the call started/connected. If Bale changed its UI, follow the manual fallback prompt to start or accept the call. |
| OTP fails | Enter the newest SMS code. The scripts allow retries. |
| TUN device missing | Run `sudo modprobe tun` and make sure Docker gets `--device /dev/net/tun`. |
| Permission denied on TUN | Run the container with `--privileged` or `--cap-add NET_ADMIN`. |
| Hotspot starts but no internet | Check slave routing: `ip route` should include `default dev tun0`. |
| `hostapd` fails | Confirm the WiFi card supports AP mode. |
| Packets do not flow | Master and slave likely captured tokens from different calls. Delete both token files and run setup again on both machines. |

## Repository Layout

```text
master/              Master Docker image and tunnel script
slave/               Slave Docker image, tunnel script, hotspot setup
setup.js             One-step wrapper for build/run/login
AI_CODER_PROMPT.md   Development prompt addendum
HAR_ANALYSIS.md      Technical notes from the Bale call HAR
docker-compose.yml   Local development compose file
```

## Security Notes

- `.env` files are ignored.
- `session/` directories are ignored.
- Do not commit HAR files, cookies, session data, LiveKit tokens, or SMS codes.

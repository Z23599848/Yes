# HAR Analysis — web.bale.ai.har
# Source: Captured from a real Bale voice call session (April 12, 2026)

## Key Findings

### 1. Bale uses LiveKit for calls
- **WebSocket signaling server**: `wss://meet-em.ble.ir/rtc`
- This is a **LiveKit SFU** (`livekit-server`) — open source, well-documented protocol
- Protocol version: `v2.15.2`, `protocol=16`
- The WebSocket path is: `/rtc?access_token=<JWT>&auto_subscribe=1&sdk=js&version=2.15.2&protocol=16`

### 2. JWT token structure
```json
{
  "iss": "<LIVEKIT_API_KEY>",
  "sub": "<BALE_USER_ID>",
  "video": {
    "canPublish": true,
    "canPublishData": true,  // ← DATA CHANNEL IS ALLOWED!
    "canSubscribe": true,
    "room": "<ROOM_UUID>",
    "roomAdmin": true,
    "roomJoin": true
  },
  "metadata": "{\"user_id\":<BALE_USER_ID>,\"auth_sid\":<AUTH_SID>}"
}
```

### 3. DATA CHANNELS ARE SUPPORTED ✅
The SDP offer/answer clearly shows:
```
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
a=sctp-port:5000
a=max-message-size:262144   ← 256 KB per message
a=sendrecv                  ← bidirectional
```
`canPublishData: true` in the JWT confirms the server allows data channel traffic.

### 4. Bale uses LiveKit's signaling protocol (Protobuf over WebSocket)
Message format: Protobuf (binary). Key message types observed:
- `offer` / `answer` — SDP wrapped in LiveKit protobuf SignalRequest
- `trickle` — ICE candidates (JSON: `{"candidate":"...","sdpMid":"0","sdpMLineIndex":0}`)
- Token refresh message (msg#6 in session 1)
- Room join info (msg#0: contains room UUID + participant tokens)

### 5. Two RTCPeerConnection sessions per call
Session 1: The SFU (`meet-em.ble.ir`) sends an **offer first**, browser answers.
Session 2: Browser sends **offer** (for publishing), SFU answers.
Both sessions have `m=application webrtc-datachannel` in the SDP.

### 6. The SFU server IP
- `meet-em.ble.ir` → `2.188.186.66` (Iran, Sotoon CDN)
- The slave (restricted to bale.ai) CAN reach `ble.ir` (same CDN as bale.ai)

### 7. ICE candidates observed
- Bale's SFU provides: `2.188.186.66:34971` (UDP) and `2.188.186.66:445` (TCP passive)
- Client collected: local IPs + SRFLX via `148.252.164.249` (STUN)
- Port **445** (TCP) is a great fallback for restricted networks

---

## Impact on Implementation

### CRITICAL CHANGE: Do NOT monkey-patch RTCPeerConnection
Bale uses **LiveKit**, which has its own JS SDK (`livekit-client`).
The SDK creates the RTCPeerConnection internally. Our monkey-patch approach
still works, but there is a **cleaner alternative**:

**Use the `livekit-client` npm package directly** from within the container
(without a browser at all!) to join the call room and open a data channel.

```
Flow (no browser needed!):
1. Slave container: POST to Bale API to get the LiveKit token + room ID
2. Slave container: use @livekit/rtc-node to connect to wss://meet-em.ble.ir/rtc
3. Open a data channel on the LiveKit room (LocalDataTrack / publishData)
4. Master does the same, joins the same room
5. VPN packets flow via LiveKit data tracks — no browser required!
```

This is **much more efficient and reliable** than browser automation.

### LiveKit Data Track API (from livekit-client)
```javascript
// Publish binary data to all participants in the room
await room.localParticipant.publishData(uint8Array, DataPacket_Kind.RELIABLE);
// Or LOSSY for lower latency (UDP semantics)
await room.localParticipant.publishData(uint8Array, DataPacket_Kind.LOSSY);

// Receive data
room.on(RoomEvent.DataReceived, (data, participant, kind) => { ... });
```

### Required: Get the LiveKit token from Bale
Need to find how Bale's web app gets the `access_token` for the LiveKit WebSocket.
This requires inspecting the Bale REST API or WebSocket (main Bale WS, not LiveKit).

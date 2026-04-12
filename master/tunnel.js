'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   BALE VPN TUNNEL — MASTER NODE  (v2 — LiveKit Native Client)       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * HAR ANALYSIS FINDING: Bale uses LiveKit SFU for voice/video calls.
 *   WebSocket: wss://meet-em.ble.ir/rtc
 *   JWT claim: canPublishData: true  → data tracks are ALLOWED by server
 *   SDP shows: m=application UDP/DTLS/SCTP webrtc-datachannel
 *               a=max-message-size:262144
 *
 * This means we DON'T need a browser or Puppeteer to tunnel data.
 * We join the LiveKit room directly using @livekit/rtc-node (native),
 * receive binary data tracks from the slave, write them to TUN.
 *
 * FLOW:
 *   Slave                    LiveKit room (meet-em.ble.ir)     Master
 *   ──────                   ─────────────────────────────     ──────
 *   publishData(IP pkt)  →   data track                    →  DataReceived event
 *                                                              write to TUN0
 *   DataReceived event   ←   data track                    ←  publishData(IP pkt)
 *   write to TUN0
 *
 * SETUP STEPS:
 *  1. Both master and slave log into web.bale.ai (manual, first run only).
 *     After login, we intercept the LiveKit JWT from the page just once
 *     and save it.  (Or you extract it from the HAR / network tab).
 *  2. The master container runs this file; the slave runs slave/tunnel.js.
 *
 * LIVEKIT ROOM TOKEN:
 *  The Bale web app obtains the LiveKit JWT when a call is started.
 *  We capture it by monkey-patching the WebSocket constructor in Puppeteer
 *  to grab the `access_token` query param the first time it connects to
 *  wss://meet-em.ble.ir/rtc.
 *  Once captured, both nodes connect directly as LiveKit participants.
 *
 * MASTER ROLE:
 *  - Sets up iptables NAT (gateway.sh)
 *  - Joins the LiveKit room as a "publisher" participant
 *  - Opens Puppeteer once to let user log in and grabs LiveKit token
 *  - Receives IP packets via DataReceived events → writes to TUN
 *  - Reads IP packets from TUN → publishData to room
 */

const { Room, RoomEvent, DataPacket_Kind, DisconnectReason } = require('@livekit/rtc-node');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

puppeteer.use(Stealth());

// ── Configuration ─────────────────────────────────────────────────────
const CFG = {
  BALE_URL:         'https://web.bale.ai/',
  BALE_PHONE:       process.env.BALE_PHONE        || '',
  SESSION_FILE:     process.env.SESSION_FILE       || '/app/session/master_session.json',
  TOKEN_FILE:       process.env.TOKEN_FILE         || '/app/session/livekit_token.json',
  CHROME_PROFILE:   '/app/session/chrome-profile',
  TUN_LOCAL_IP:     process.env.TUN_LOCAL_IP       || '10.0.0.1',
  TUN_PEER_IP:      process.env.TUN_PEER_IP        || '10.0.0.2',
  INTERNET_IFACE:   process.env.INTERNET_IFACE     || 'eth0',
  LIVEKIT_URL:      process.env.LIVEKIT_URL        || 'wss://meet-em.ble.ir',
  // If you already have the token, set this env var to skip Puppeteer entirely
  LIVEKIT_TOKEN:    process.env.LIVEKIT_TOKEN      || '',
  HEADLESS:         process.env.HEADLESS           !== 'false',
};

// ── Logging ───────────────────────────────────────────────────────────
const tag = (t) => `[${t.toUpperCase().padEnd(7)}]`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = (...a) => console.error(new Date().toISOString(), ...a);

// ── Globals ────────────────────────────────────────────────────────────
let tunProc;
let tunBuf  = Buffer.alloc(0);
let lkRoom;

// ══════════════════════════════════════════════════════════════════════
// 1. TUN MANAGER
// ══════════════════════════════════════════════════════════════════════
function startTun(onPacket) {
  log(tag('tun'), 'Starting tun_manager.py …');

  tunProc = spawn('python3', [
    path.join(__dirname, 'tun_manager.py'),
    CFG.TUN_LOCAL_IP,
    CFG.TUN_PEER_IP,
  ], { stdio: ['pipe', 'pipe', 'inherit'] });

  tunProc.on('error', (e) => err(tag('tun'), 'Spawn error:', e.message));
  tunProc.on('exit',  (c) => log(tag('tun'), 'Exited with code', c));

  // TUN → LiveKit: read length-prefixed frames, call onPacket
  tunProc.stdout.on('data', (chunk) => {
    tunBuf = Buffer.concat([tunBuf, chunk]);
    while (tunBuf.length >= 2) {
      const plen = tunBuf.readUInt16BE(0);
      if (tunBuf.length < 2 + plen) break;
      const pkt = tunBuf.slice(2, 2 + plen);
      tunBuf    = tunBuf.slice(2 + plen);
      onPacket(pkt);
    }
  });
}

function writeToTun(buf) {
  if (!tunProc || !tunProc.stdin.writable) return;
  const hdr = Buffer.allocUnsafe(2);
  hdr.writeUInt16BE(buf.length, 0);
  tunProc.stdin.write(Buffer.concat([hdr, buf]));
}

// ══════════════════════════════════════════════════════════════════════
// 2. GATEWAY
// ══════════════════════════════════════════════════════════════════════
function setupGateway() {
  try {
    execSync(`bash ${path.join(__dirname, 'gateway.sh')} ${CFG.INTERNET_IFACE} tun0`,
      { stdio: 'inherit' });
  } catch (e) {
    err(tag('gw'), 'gateway.sh failed:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. ACQUIRE LIVEKIT TOKEN
//    Strategy A: use LIVEKIT_TOKEN env var (or saved token file)
//    Strategy B: open Puppeteer, intercept the WSS URL, extract token
// ══════════════════════════════════════════════════════════════════════
function loadSavedToken() {
  try {
    if (CFG.LIVEKIT_TOKEN) return { token: CFG.LIVEKIT_TOKEN, url: CFG.LIVEKIT_URL };
    if (fs.existsSync(CFG.TOKEN_FILE)) {
      const t = JSON.parse(fs.readFileSync(CFG.TOKEN_FILE, 'utf8'));
      if (t.token && t.url) return t;
    }
  } catch (_) {}
  return null;
}

function saveToken(token, url) {
  fs.mkdirSync(path.dirname(CFG.TOKEN_FILE), { recursive: true });
  fs.writeFileSync(CFG.TOKEN_FILE, JSON.stringify({ token, url }, null, 2));
  log(tag('token'), 'LiveKit token saved to', CFG.TOKEN_FILE);
}

/**
 * Monkey-patch WebSocket inside Puppeteer page to capture the LiveKit WSS URL
 * (which contains the access_token in its query string).
 */
const WS_INTERCEPT_SCRIPT = `
(function() {
  if (window.__livekitTokenCaptured) return;
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, ...args) {
    if (typeof url === 'string' && url.includes('meet-em.ble.ir')) {
      console.log('[VPN-TOKEN] LiveKit WS URL captured:', url.slice(0, 120));
      window.__livekitWsUrl = url;
      // Extract just the token
      const m = url.match(/access_token=([^&]+)/);
      if (m) window.__livekitToken = m[1];
      window.__livekitTokenCaptured = true;
    }
    return new OrigWS(url, ...args);
  };
  Object.assign(window.WebSocket, OrigWS);
  window.WebSocket.prototype = OrigWS.prototype;
  console.log('[VPN-TOKEN] WebSocket interceptor installed');
})();
`;

async function acquireTokenViaBrowser() {
  log(tag('token'), 'Launching browser to capture LiveKit token …');

  const browser = await puppeteer.launch({
    headless: CFG.HEADLESS ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',
    ],
    userDataDir: CFG.CHROME_PROFILE,
  });

  const page = await browser.newPage();
  const ctx  = browser.defaultBrowserContext();
  await ctx.overridePermissions('https://web.bale.ai', ['microphone', 'camera', 'notifications']);

  // Install WS interceptor before Bale loads
  await page.evaluateOnNewDocument(WS_INTERCEPT_SCRIPT);
  await page.goto(CFG.BALE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Restore or do manual login
  const session = loadSavedSession();
  if (session) {
    await restoreSession(page, session);
    await page.reload({ waitUntil: 'networkidle2' });
  }

  log(tag('token'), '─────────────────────────────────────────────────────');
  log(tag('token'), ' ACTION REQUIRED:');
  log(tag('token'), '  1. If not logged in: log in to Bale now.');
  log(tag('token'), '  2. Start a voice call with the slave account.');
  log(tag('token'), '  3. Once the call is ringing/connected the token');
  log(tag('token'), '     will be captured automatically.');
  log(tag('token'), '  4. Press ENTER here when the call is ringing.');
  log(tag('token'), '─────────────────────────────────────────────────────');

  await promptEnter('Press ENTER after the call is ringing …');
  await saveCurrentSession(page);

  // Poll for the intercepted token (up to 30 s after ENTER)
  log(tag('token'), 'Waiting for LiveKit token …');
  let token = null, url = null;
  for (let i = 0; i < 60; i++) {
    const result = await page.evaluate(() => ({
      token: window.__livekitToken,
      url:   window.__livekitWsUrl,
    }));
    if (result.token) { token = result.token; url = result.url; break; }
    await sleep(500);
  }

  await browser.close();

  if (!token) throw new Error('Failed to capture LiveKit token. Did the call start?');

  // Strip query params from URL to get base URL
  const baseUrl = url ? url.split('?')[0].replace('/rtc', '') : CFG.LIVEKIT_URL;
  saveToken(token, baseUrl);
  return { token, url: baseUrl };
}

// ══════════════════════════════════════════════════════════════════════
// 4. SESSION HELPERS
// ══════════════════════════════════════════════════════════════════════
function loadSavedSession() {
  try {
    if (fs.existsSync(CFG.SESSION_FILE))
      return JSON.parse(fs.readFileSync(CFG.SESSION_FILE, 'utf8'));
  } catch (_) {}
  return null;
}

async function restoreSession(page, session) {
  try {
    await page.setCookie(...session.cookies);
    await page.evaluate((ls) => {
      for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
    }, session.localStorage);
  } catch (_) {}
}

async function saveCurrentSession(page) {
  try {
    const cookies = await page.cookies();
    const ls = await page.evaluate(() => {
      const d = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i); d[k] = localStorage.getItem(k);
      }
      return d;
    });
    fs.mkdirSync(path.dirname(CFG.SESSION_FILE), { recursive: true });
    fs.writeFileSync(CFG.SESSION_FILE, JSON.stringify({ cookies, localStorage: ls }));
    log(tag('session'), 'Saved.');
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════
// 5. LIVEKIT ROOM — CONNECT AND TUNNEL
// ══════════════════════════════════════════════════════════════════════
async function connectAndTunnel(livekitUrl, token) {
  log(tag('lk'), `Connecting to LiveKit: ${livekitUrl}`);

  lkRoom = new Room();

  // When we receive data from slave → write to TUN
  lkRoom.on(RoomEvent.DataReceived, (data, participant, kind, topic) => {
    if (topic !== 'vpn') return;  // Ignore non-VPN data
    const buf = Buffer.from(data);
    writeToTun(buf);
  });

  lkRoom.on(RoomEvent.Disconnected, (reason) => {
    log(tag('lk'), 'Disconnected:', DisconnectReason[reason] || reason);
    // Reconnect after 3 s
    setTimeout(() => connectAndTunnel(livekitUrl, token), 3000);
  });

  lkRoom.on(RoomEvent.Connected, () => {
    log(tag('lk'), '✓ Connected to LiveKit room:', lkRoom.name);
    log(tag('lk'), '  Participants:', lkRoom.numParticipants);
  });

  lkRoom.on(RoomEvent.ParticipantConnected, (p) => {
    log(tag('lk'), 'Participant joined:', p.identity);
  });

  lkRoom.on(RoomEvent.ParticipantDisconnected, (p) => {
    log(tag('lk'), 'Participant left:', p.identity);
  });

  await lkRoom.connect(livekitUrl, token, {
    autoSubscribe: true,
  });

  // TUN → LiveKit: start TUN and forward packets into the room
  startTun((pkt) => {
    if (lkRoom.state !== 'connected') return;
    lkRoom.localParticipant.publishData(
      new Uint8Array(pkt),
      { reliable: false, topic: 'vpn' }   // LOSSY = lower latency (UDP semantics)
    ).catch(() => {});
  });

  log(tag('lk'), '✓ Tunnel active. Master is forwarding all slave hotspot traffic.');
}

// ══════════════════════════════════════════════════════════════════════
// 6. HELPERS
// ══════════════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function promptEnter(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg + '\n', () => { rl.close(); resolve(); });
  });
}

// ══════════════════════════════════════════════════════════════════════
// 7. MAIN
// ══════════════════════════════════════════════════════════════════════
async function main() {
  log('╔══════════════════════════════════════════════════╗');
  log('║   BALE VPN TUNNEL — MASTER NODE  (v2 LiveKit)    ║');
  log('╚══════════════════════════════════════════════════╝');
  log('  Signaling: wss://meet-em.ble.ir  (LiveKit SFU)   ');
  log('  Data: canPublishData=true → binary data tracks   ');
  log();

  setupGateway();

  // Acquire LiveKit token (from env, file, or browser capture)
  let tokenInfo = loadSavedToken();
  if (!tokenInfo) {
    log(tag('token'), 'No saved token found — starting browser to capture one.');
    tokenInfo = await acquireTokenViaBrowser();
  } else {
    log(tag('token'), 'Using saved LiveKit token.');
  }

  await connectAndTunnel(tokenInfo.url, tokenInfo.token);

  log(tag('master'), '');
  log(tag('master'), '══════════════════════════════════════════════════');
  log(tag('master'), ' GATEWAY READY                                    ');
  log(tag('master'), ' Slave hotspot traffic tunnels through LiveKit    ');
  log(tag('master'), ' and exits here to the internet.                  ');
  log(tag('master'), '══════════════════════════════════════════════════');

  // Graceful shutdown
  const shutdown = async () => {
    if (lkRoom) await lkRoom.disconnect();
    if (tunProc) tunProc.kill();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);

  // keepalive
  await new Promise(() => {}); // run forever
}

main().catch((e) => { err('[FATAL]', e); process.exit(1); });

'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   BALE VPN TUNNEL — SLAVE NODE  (v2 — LiveKit Native Client)        ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * FLOW:
 *  1. Open Bale in Puppeteer once to login and capture the LiveKit token.
 *  2. Join the same LiveKit room as master using @livekit/rtc-node.
 *  3. Create TUN device — route all hotspot traffic through it.
 *  4. TUN reads → publishData(pkt, {topic:'vpn'}) → master → internet.
 *  5. Master publishData replies → DataReceived → write to TUN → hotspot clients.
 *  6. Launch WiFi hotspot (hostapd + dnsmasq) after tunnel is up.
 *
 * NOTE: The LiveKit room is created/joined by Bale when a call starts.
 *   The slave starts the call FROM the browser (one time), captures the JWT,
 *   then the native LiveKit client takes over for the actual data tunnel.
 *   No browser is needed after token capture.
 *
 * IMPORTANT ABOUT THE ROOM:
 *   Both master and slave must be in the SAME LiveKit room.
 *   This means the slave must call the master (or vice versa) on Bale
 *   to create the room, capture their respective tokens, then keep the call alive.
 *   The room UUID is embedded in both tokens.
 *
 *   Alternative if you want to skip call setup: you could use a pre-known
 *   room name and a shared secret to generate tokens via Bale's LiveKit
 *   server -- but that requires knowing Bale's LiveKit API secret.
 *   Easiest: start a call, capture tokens from both devices, save them.
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
  BALE_URL:           'https://web.bale.ai/',
  BALE_PHONE:         process.env.BALE_PHONE         || '',
  MASTER_BALE_PHONE:  process.env.MASTER_BALE_PHONE  || '',
  SESSION_FILE:       process.env.SESSION_FILE        || '/app/session/slave_session.json',
  TOKEN_FILE:         process.env.TOKEN_FILE          || '/app/session/livekit_token.json',
  CHROME_PROFILE:     '/app/session/chrome-profile',
  TUN_LOCAL_IP:       process.env.TUN_LOCAL_IP        || '10.0.0.2',
  TUN_PEER_IP:        process.env.TUN_PEER_IP         || '10.0.0.1',
  LIVEKIT_URL:        process.env.LIVEKIT_URL         || 'wss://meet-em.ble.ir',
  LIVEKIT_TOKEN:      process.env.LIVEKIT_TOKEN       || '',
  WIFI_IFACE:         process.env.WIFI_IFACE          || 'wlan0',
  HOTSPOT_SSID:       process.env.HOTSPOT_SSID        || 'BaleTunnel',
  HOTSPOT_PASS:       process.env.HOTSPOT_PASS        || 'tunnel1234',
  HEADLESS:           process.env.HEADLESS            !== 'false',
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
// 2. HOTSPOT
// ══════════════════════════════════════════════════════════════════════
function startHotspot() {
  log(tag('hotspot'), 'Launching hotspot.sh …');
  try {
    execSync(
      `WIFI_IFACE=${CFG.WIFI_IFACE} HOTSPOT_SSID=${CFG.HOTSPOT_SSID} ` +
      `HOTSPOT_PASS=${CFG.HOTSPOT_PASS} bash ${path.join(__dirname, 'hotspot.sh')}`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    err(tag('hotspot'), 'hotspot.sh failed:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 3. CONFIGURE DEFAULT ROUTE THROUGH TUN
// ══════════════════════════════════════════════════════════════════════
function configureTunRouting() {
  log(tag('net'), 'Setting default route → tun0');
  try {
    execSync('ip route add default dev tun0 metric 50 2>/dev/null || true');
    execSync('ip route add 10.0.0.0/30 dev tun0 2>/dev/null || true');
  } catch (e) {
    err(tag('net'), e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 4. ACQUIRE LIVEKIT TOKEN (same strategy as master)
// ══════════════════════════════════════════════════════════════════════
const WS_INTERCEPT_SCRIPT = `
(function() {
  if (window.__livekitTokenCaptured) return;
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, ...args) {
    if (typeof url === 'string' && url.includes('meet-em.ble.ir')) {
      console.log('[VPN-TOKEN] LiveKit WS URL:', url.slice(0, 120));
      window.__livekitWsUrl = url;
      const m = url.match(/access_token=([^&]+)/);
      if (m) { window.__livekitToken = m[1]; window.__livekitTokenCaptured = true; }
    }
    return new OrigWS(url, ...args);
  };
  Object.assign(window.WebSocket, OrigWS);
  window.WebSocket.prototype = OrigWS.prototype;
})();
`;

// Bale call button selectors (derived from HAR: animated_speaking.lottie loads on call UI)
const CALL_BTN_SELECTORS = [
  '[data-testid="voice-call-button"]',
  '[data-testid="call-button"]',
  'button[title="Voice call"]',
  'button[title="Call"]',
  '[aria-label="Voice call"]',
  '[aria-label="Call"]',
  '[class*="VoiceCall"]',
  '[class*="call-btn"]',
  '.call-button',
];

const SEARCH_SELECTORS = [
  '[data-testid="search"]',
  'input[placeholder*="Search"]',
  'input[placeholder*="جستجو"]',
  '.search-input',
  '[class*="SearchInput"]',
];

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
  log(tag('token'), 'LiveKit token saved.');
}

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
    log(tag('session'), 'Session saved.');
  } catch (_) {}
}

async function acquireTokenViaBrowser() {
  log(tag('token'), 'Launching Chromium to capture LiveKit token …');

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

  await page.evaluateOnNewDocument(WS_INTERCEPT_SCRIPT);
  await page.goto(CFG.BALE_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Restore session or manual login
  const session = loadSavedSession();
  if (session) {
    await restoreSession(page, session);
    await page.reload({ waitUntil: 'networkidle2' });
  }

  log(tag('token'), '─────────────────────────────────────────────────────');
  log(tag('token'), ' ACTION REQUIRED:');
  log(tag('token'), '  1. Log in to Bale if not already logged in.');
  log(tag('token'), '  2. Open the chat with MASTER phone: ' + CFG.MASTER_BALE_PHONE);
  log(tag('token'), '  3. Start a voice call to the master.');
  log(tag('token'), '  4. Once call is ringing, press ENTER here.');
  log(tag('token'), '─────────────────────────────────────────────────────');

  // Try to automate: search for master and click call
  if (CFG.MASTER_BALE_PHONE) {
    await sleep(2000);
    log(tag('token'), 'Trying to auto-open master chat …');

    // Click search
    for (const sel of SEARCH_SELECTORS) {
      try { await page.click(sel, { timeout: 1500 }); break; } catch (_) {}
    }
    await sleep(500);
    await page.keyboard.type(CFG.MASTER_BALE_PHONE, { delay: 80 });
    await sleep(1500);

    // Click first result
    const resultSels = [
      '[data-testid="search-result-item"]',
      '[class*="SearchResult"]',
      '[class*="contact"]',
      '[class*="Chat"]',
    ];
    for (const sel of resultSels) {
      try { await page.click(sel, { timeout: 1500 }); break; } catch (_) {}
    }
    await sleep(1000);

    // Click call button
    log(tag('token'), 'Trying to auto-click call button …');
    let called = false;
    for (const sel of CALL_BTN_SELECTORS) {
      try {
        await page.click(sel, { timeout: 1500 });
        called = true;
        log(tag('token'), '✓ Call button clicked');
        break;
      } catch (_) {}
    }
    if (!called) {
      log(tag('token'), 'Could not auto-click call button. Please click it manually.');
    }
  }

  await promptEnter('Press ENTER after the call is ringing/connected …');
  await saveCurrentSession(page);

  // Wait for token
  log(tag('token'), 'Waiting for LiveKit token …');
  let token = null, url = null;
  for (let i = 0; i < 60; i++) {
    const r = await page.evaluate(() => ({
      token: window.__livekitToken,
      url:   window.__livekitWsUrl,
    }));
    if (r.token) { token = r.token; url = r.url; break; }
    await sleep(500);
  }

  await browser.close();

  if (!token) {
    throw new Error(
      'No LiveKit token captured.\n' +
      'Make sure the call started and the browser connected to wss://meet-em.ble.ir.\n' +
      'Check browser console for [VPN-TOKEN] log.'
    );
  }

  const baseUrl = url ? url.split('?')[0].replace('/rtc', '') : CFG.LIVEKIT_URL;
  saveToken(token, baseUrl);
  return { token, url: baseUrl };
}

// ══════════════════════════════════════════════════════════════════════
// 5. LIVEKIT ROOM
// ══════════════════════════════════════════════════════════════════════
async function connectAndTunnel(livekitUrl, token) {
  log(tag('lk'), `Connecting to LiveKit: ${livekitUrl}`);

  lkRoom = new Room();

  // Receive packets from master → write to TUN (which routes to hotspot clients)
  lkRoom.on(RoomEvent.DataReceived, (data, participant, kind, topic) => {
    if (topic !== 'vpn') return;
    writeToTun(Buffer.from(data));
  });

  lkRoom.on(RoomEvent.Connected, () => {
    log(tag('lk'), '✓ Connected to LiveKit room:', lkRoom.name);
    log(tag('lk'), '  Local participant:', lkRoom.localParticipant.identity);
  });

  lkRoom.on(RoomEvent.Disconnected, (reason) => {
    log(tag('lk'), 'Disconnected:', DisconnectReason[reason] || reason);
    setTimeout(() => connectAndTunnel(livekitUrl, token), 3000);
  });

  lkRoom.on(RoomEvent.ParticipantConnected, (p) => {
    log(tag('lk'), 'Participant joined:', p.identity, '(master?)');
  });

  await lkRoom.connect(livekitUrl, token, { autoSubscribe: true });

  // Start TUN and forward packets to master via LiveKit data track
  startTun((pkt) => {
    if (lkRoom.state !== 'connected') return;
    lkRoom.localParticipant.publishData(
      new Uint8Array(pkt),
      { reliable: false, topic: 'vpn' }
    ).catch(() => {});
  });

  // Configure routing after TUN is up
  await sleep(1000);
  configureTunRouting();

  // Launch WiFi hotspot AFTER routing is configured
  startHotspot();

  log(tag('slave'), '');
  log(tag('slave'), '══════════════════════════════════════════════════');
  log(tag('slave'), ' TUNNEL + HOTSPOT ACTIVE                          ');
  log(tag('slave'), `  SSID    : ${CFG.HOTSPOT_SSID}`);
  log(tag('slave'), `  Password: ${CFG.HOTSPOT_PASS}`);
  log(tag('slave'), '  Connect any device → full internet via master   ');
  log(tag('slave'), '══════════════════════════════════════════════════');
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
  log('║   BALE VPN TUNNEL — SLAVE NODE   (v2 LiveKit)    ║');
  log('╚══════════════════════════════════════════════════╝');
  log('  Bale uses LiveKit SFU (meet-em.ble.ir)           ');
  log('  Data channel: canPublishData=true                ');
  log();

  let tokenInfo = loadSavedToken();
  if (!tokenInfo) {
    log(tag('token'), 'No saved token — starting browser to capture one.');
    tokenInfo = await acquireTokenViaBrowser();
  } else {
    log(tag('token'), 'Using saved LiveKit token.');
  }

  await connectAndTunnel(tokenInfo.url, tokenInfo.token);

  const shutdown = async () => {
    if (lkRoom) await lkRoom.disconnect();
    if (tunProc) tunProc.kill();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT',  shutdown);

  await new Promise(() => {}); // run forever
}

main().catch((e) => { err('[FATAL]', e); process.exit(1); });

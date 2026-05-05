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

const PHONE_INPUT_SELECTORS = [
  'input[type="tel"]',
  'input[inputmode="tel"]',
  'input[autocomplete="tel"]',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
  'input[placeholder*="phone" i]',
  'input[placeholder*="mobile" i]',
];

const OTP_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[type="number"]',
  'input[name*="otp" i]',
  'input[name*="code" i]',
  'input[id*="otp" i]',
  'input[id*="code" i]',
  'input[placeholder*="code" i]',
];

const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  '[data-testid*="submit" i]',
  '[data-testid*="continue" i]',
  '[data-testid*="login" i]',
];

const LOGGED_IN_SELECTORS = [
  '[data-testid="search"]',
  '[data-testid="chat-list"]',
  '[aria-label*="chat" i]',
  '[class*="ChatList"]',
  '[class*="Sidebar"]',
  '.search-input',
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

async function isVisibleHandle(handle) {
  try {
    return await handle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' &&
        rect.width > 0 && rect.height > 0 && !el.disabled;
    });
  } catch (_) {
    return false;
  }
}

async function findVisibleHandle(page, selectors, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const handles = await page.$$(selector);
        for (const handle of handles) {
          if (await isVisibleHandle(handle)) return handle;
          await handle.dispose().catch(() => {});
        }
      } catch (_) {}
    }
    await sleep(300);
  }
  return null;
}

async function findInputByKind(page, kind, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle((inputKind) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' &&
          rect.width > 0 && rect.height > 0 && !el.disabled;
      };
      const scoreInput = (el) => {
        const attrs = [
          el.type,
          el.name,
          el.id,
          el.placeholder,
          el.autocomplete,
          el.inputMode,
          el.getAttribute('aria-label') || '',
        ].join(' ').toLowerCase();
        let score = 0;
        if (inputKind === 'phone') {
          if (el.type === 'tel' || el.inputMode === 'tel') score += 8;
          if (attrs.includes('phone') || attrs.includes('mobile') || attrs.includes('tel')) score += 6;
          if (el.autocomplete === 'tel') score += 4;
        } else {
          if (el.autocomplete === 'one-time-code') score += 10;
          if (el.inputMode === 'numeric' || el.type === 'number' || el.type === 'tel') score += 6;
          if (attrs.includes('otp') || attrs.includes('code') || attrs.includes('verify')) score += 6;
          if (el.maxLength > 0 && el.maxLength <= 8) score += 3;
        }
        return score;
      };

      const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      const ranked = inputs
        .map((input) => ({ input, score: scoreInput(input) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      return ranked[0]?.input || null;
    }, kind);
    const element = handle.asElement();
    if (element) return element;
    await handle.dispose().catch(() => {});
    await sleep(300);
  }
  return null;
}

async function hasAnyVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        if (await isVisibleHandle(handle)) return true;
        await handle.dispose().catch(() => {});
      }
    } catch (_) {}
  }
  return false;
}

async function detectAuthState(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasAnyVisible(page, LOGGED_IN_SELECTORS)) return 'logged-in';
    if (await findVisibleHandle(page, OTP_INPUT_SELECTORS, 500) || await findInputByKind(page, 'otp', 500)) return 'otp';
    if (await findVisibleHandle(page, PHONE_INPUT_SELECTORS, 500) || await findInputByKind(page, 'phone', 500)) return 'phone';
    await sleep(500);
  }
  return 'unknown';
}

async function clearAndType(handle, value) {
  await handle.click({ clickCount: 3 });
  await handle.press('Backspace').catch(() => {});
  await handle.type(value, { delay: 35 });
}

async function submitCurrentForm(page) {
  const button = await findVisibleHandle(page, SUBMIT_BUTTON_SELECTORS, 800);
  if (button) await button.click().catch(() => {});
  else await page.keyboard.press('Enter').catch(() => {});
  await sleep(800);
}

async function visibleOtpInputs(page) {
  const handles = [];
  for (const selector of OTP_INPUT_SELECTORS) {
    try {
      const found = await page.$$(selector);
      for (const handle of found) {
        if (await isVisibleHandle(handle)) handles.push(handle);
        else await handle.dispose().catch(() => {});
      }
    } catch (_) {}
  }
  return handles;
}

async function clearOtpInputs(page) {
  const inputs = await visibleOtpInputs(page);
  for (const input of inputs) {
    try {
      await input.click({ clickCount: 3 });
      await input.press('Backspace');
    } catch (_) {}
  }
}

async function typeOtpCode(page, code) {
  const inputs = await visibleOtpInputs(page);
  if (inputs.length > 1 && code.length >= inputs.length) {
    for (let i = 0; i < inputs.length && i < code.length; i++) {
      await clearAndType(inputs[i], code[i]);
    }
  } else {
    const input = inputs[0] || await findInputByKind(page, 'otp', 10_000);
    if (!input) throw new Error('Could not find Bale OTP input.');
    await clearAndType(input, code);
  }
  await submitCurrentForm(page);
}

async function waitForLoggedIn(page, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await detectAuthState(page, 1_000);
    if (state === 'logged-in') return true;
    if (state === 'unknown') {
      const hasLoginInput = await findVisibleHandle(page, PHONE_INPUT_SELECTORS, 500) ||
        await findVisibleHandle(page, OTP_INPUT_SELECTORS, 500);
      if (!hasLoginInput) return true;
    }
    await sleep(500);
  }
  return false;
}

async function ensureBaleLogin(page) {
  let state = await detectAuthState(page, 15_000);
  if (state === 'logged-in') {
    log(tag('login'), 'Existing Bale session is active.');
    return;
  }

  if (!CFG.BALE_PHONE) {
    CFG.BALE_PHONE = await promptText('Enter Bale phone number');
  }
  if (!CFG.BALE_PHONE) throw new Error('BALE_PHONE is required for Bale login.');

  if (state === 'phone' || state === 'unknown') {
    log(tag('login'), 'Submitting Bale phone number.');
    const phoneInput = await findVisibleHandle(page, PHONE_INPUT_SELECTORS, 10_000) ||
      await findInputByKind(page, 'phone', 20_000);
    if (!phoneInput && state === 'unknown') {
      log(tag('login'), 'Could not identify login form; continuing with current Bale session.');
      return;
    }
    if (!phoneInput) throw new Error('Could not find Bale phone-number input.');
    await clearAndType(phoneInput, CFG.BALE_PHONE);
    await submitCurrentForm(page);
    state = await detectAuthState(page, 60_000);
  }

  if (state !== 'otp') {
    if (await waitForLoggedIn(page, 10_000)) {
      log(tag('login'), 'Bale login completed.');
      await saveCurrentSession(page);
      return;
    }
    throw new Error('Bale did not show an OTP input after phone submission.');
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    const code = await promptSecret(`Enter Bale SMS code${attempt > 1 ? ' (retry)' : ''}`);
    if (!code) continue;
    await typeOtpCode(page, code);
    if (await waitForLoggedIn(page, 25_000)) {
      log(tag('login'), 'Bale login completed.');
      await saveCurrentSession(page);
      return;
    }
    log(tag('login'), 'That code did not complete login. Please try the latest SMS code.');
    await clearOtpInputs(page);
  }

  throw new Error('Bale login did not complete after OTP retries.');
}

async function clickFirstSelector(page, selectors, timeoutMs = 10_000) {
  const handle = await findVisibleHandle(page, selectors, timeoutMs);
  if (!handle) return false;
  await handle.click().catch(() => {});
  return true;
}

async function clickByText(page, patterns) {
  return await page.evaluate((sources) => {
    const regexes = sources.map(([source, flags]) => new RegExp(source, flags));
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' &&
        rect.width > 0 && rect.height > 0 && !el.disabled;
    };
    const candidates = Array.from(document.querySelectorAll('button,[role="button"],a,div[tabindex]'));
    for (const el of candidates) {
      if (!visible(el)) continue;
      const label = [
        el.textContent || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.className || '',
      ].join(' ');
      if (regexes.some((regex) => regex.test(label))) {
        el.click();
        return true;
      }
    }
    return false;
  }, patterns.map((regex) => [regex.source, regex.flags]));
}

async function waitForLiveKitToken(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => ({
      token: window.__livekitToken,
      url:   window.__livekitWsUrl,
    }));
    if (result.token) return result;
    await sleep(500);
  }
  return { token: null, url: null };
}

async function autoStartCallToMaster(page) {
  if (!CFG.MASTER_BALE_PHONE) {
    log(tag('token'), 'MASTER_BALE_PHONE is empty. Please open the master chat and start a call manually.');
    return false;
  }

  log(tag('token'), 'Opening master chat: ' + CFG.MASTER_BALE_PHONE);
  const searchClicked = await clickFirstSelector(page, SEARCH_SELECTORS, 15_000);
  if (!searchClicked) {
    log(tag('token'), 'Could not find Bale search field.');
    return false;
  }

  await sleep(500);
  await page.keyboard.down('Control').catch(() => {});
  await page.keyboard.press('KeyA').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await page.keyboard.type(CFG.MASTER_BALE_PHONE, { delay: 60 });
  await sleep(2_000);

  const resultClicked = await clickFirstSelector(page, [
    '[data-testid="search-result-item"]',
    '[data-testid*="search-result" i]',
    '[class*="SearchResult"]',
    '[class*="contact"]',
    '[class*="Chat"]',
    '[role="option"]',
  ], 10_000) || await clickByText(page, [new RegExp(CFG.MASTER_BALE_PHONE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))]);

  if (!resultClicked) {
    log(tag('token'), 'Could not select the master contact from search results.');
    return false;
  }

  await sleep(1_500);
  log(tag('token'), 'Clicking Bale voice-call button.');
  const callClicked = await clickFirstSelector(page, CALL_BTN_SELECTORS, 10_000) ||
    await clickByText(page, [/voice\s*call/i, /\bcall\b/i]);
  if (!callClicked) {
    log(tag('token'), 'Could not auto-click call button. Please click it manually.');
    return false;
  }

  log(tag('token'), 'Call started; waiting for LiveKit token.');
  return true;
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

  await ensureBaleLogin(page);

  const callStarted = await autoStartCallToMaster(page);
  if (!callStarted) {
    await promptEnter('Open the master chat and start the voice call, then press ENTER ...');
  }

  await saveCurrentSession(page);
  log(tag('token'), 'Waiting for LiveKit token ...');
  const captured = await waitForLiveKitToken(page, 90_000);

  await browser.close();

  if (!captured.token) {
    throw new Error(
      'No LiveKit token captured.\n' +
      'Make sure the call started and the browser connected to wss://meet-em.ble.ir.\n' +
      'Check browser console for [VPN-TOKEN] log.'
    );
  }

  const capturedBaseUrl = captured.url ? captured.url.split('?')[0].replace('/rtc', '') : CFG.LIVEKIT_URL;
  saveToken(captured.token, capturedBaseUrl);
  return { token: captured.token, url: capturedBaseUrl };

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

function promptText(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg + '\n', (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

function promptSecret(msg) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const originalWrite = rl._writeToOutput;
    rl.stdoutMuted = false;
    rl._writeToOutput = function writeToOutput(str) {
      if (rl.stdoutMuted) {
        rl.output.write('*'.repeat(str.length));
      } else {
        originalWrite.call(rl, str);
      }
    };
    rl.question(msg + '\n', (answer) => {
      rl.history = [];
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
    rl.stdoutMuted = true;
  });
}

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

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = __dirname;

function ask(question, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve((answer.trim() || defaultValue).trim());
    });
  });
}

async function chooseRole() {
  while (true) {
    const answer = (await ask('Run this machine as master or slave')).toLowerCase();
    if (['master', 'm'].includes(answer)) return 'master';
    if (['slave', 's'].includes(answer)) return 'slave';
    console.log('Please enter "master" or "slave".');
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeEnvFile(role, values) {
  const envPath = path.join(ROOT, role, '.env');
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  fs.writeFileSync(envPath, `${lines.join('\n')}\n`);
  return envPath;
}

function dockerPath(hostPath) {
  return path.resolve(hostPath).replace(/\\/g, '/');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
      ...options,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('\nBale VPN Tunnel setup\n');

  const role = await chooseRole();
  const roleDir = path.join(ROOT, role);
  const sessionDir = path.join(roleDir, 'session');
  const tokenFile = path.join(sessionDir, 'livekit_token.json');
  ensureDir(sessionDir);

  const balePhone = await ask('Bale phone number for this account');
  if (!balePhone) throw new Error('A Bale phone number is required.');

  const env = {
    BALE_PHONE: balePhone,
    SESSION_FILE: `/app/session/${role}_session.json`,
    TOKEN_FILE: '/app/session/livekit_token.json',
  };

  if (role === 'master') {
    env.INTERNET_IFACE = await ask('Internet interface on this machine', 'eth0');
  } else {
    env.MASTER_BALE_PHONE = await ask("Master's Bale phone number to call");
    if (!env.MASTER_BALE_PHONE) throw new Error("Master's Bale phone number is required for the slave.");
    env.WIFI_IFACE = await ask('WiFi interface for the hotspot', 'wlan0');
    env.HOTSPOT_SSID = await ask('Hotspot SSID', 'BaleTunnel');
    env.HOTSPOT_PASS = await ask('Hotspot password', 'tunnel1234');
  }

  const hasSavedToken = fs.existsSync(tokenFile);
  env.HEADLESS = hasSavedToken ? 'true' : 'false';

  const envPath = writeEnvFile(role, env);
  const image = `bale-vpn-${role}:latest`;

  console.log(`\nSaved configuration to ${path.relative(ROOT, envPath)}`);
  console.log(hasSavedToken
    ? 'Saved LiveKit token found; starting headless.'
    : 'No saved LiveKit token found; first run will perform Bale login and OTP verification.');

  console.log(`\nBuilding ${image}...\n`);
  await run('docker', ['build', '-t', image, `./${role}`]);

  const dockerArgs = [
    'run',
    '--rm',
    '-it',
    '--privileged',
    '--cap-add', 'NET_ADMIN',
    '--device', '/dev/net/tun',
    '--env-file', envPath,
    '-e', `HEADLESS=${env.HEADLESS}`,
    '-v', `${dockerPath(sessionDir)}:/app/session`,
  ];

  if (role === 'slave') {
    dockerArgs.push('--network', 'host');
  }

  dockerArgs.push(image);

  console.log(`\nStarting ${role}. Keep this terminal open for OTP prompts and logs.\n`);
  await run('docker', dockerArgs);
}

main().catch((error) => {
  console.error('\nSetup failed:', error.message);
  process.exit(1);
});

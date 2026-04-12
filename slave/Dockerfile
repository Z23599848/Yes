# ── Bale VPN Tunnel — SLAVE Dockerfile ───────────────────────────────
FROM ubuntu:22.04

LABEL maintainer="bale-vpn-tunnel"
LABEL description="Slave node: restricted internet, WiFi hotspot, WebRTC VPN client"

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# ── System packages ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates \
    # Networking
    iproute2 iptables net-tools wireless-tools rfkill iw \
    # WiFi hotspot
    hostapd dnsmasq \
    # TUN
    kmod \
    # Puppeteer / Chromium runtime deps
    chromium-browser \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    xvfb x11-utils dbus-x11 \
    # Python
    python3 python3-pip \
    bash procps less \
 && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS ────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# ── App directory ─────────────────────────────────────────────────────
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY tunnel.js      ./
COPY tun_manager.py ./
COPY hotspot.sh     ./
RUN chmod +x hotspot.sh

VOLUME ["/app/session"]

CMD ["bash", "-c", \
  "modprobe tun 2>/dev/null || true; \
   Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & \
   export DISPLAY=:99; \
   sleep 1; \
   exec node tunnel.js"]

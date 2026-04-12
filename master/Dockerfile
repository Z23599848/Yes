# ── Bale VPN Tunnel — MASTER Dockerfile ──────────────────────────────
FROM ubuntu:22.04

LABEL maintainer="bale-vpn-tunnel"
LABEL description="Master node: internet gateway + WebRTC data-channel VPN via Bale"

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# ── System packages ────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Node.js via NodeSource
    curl gnupg ca-certificates \
    # Networking tools
    iproute2 iptables net-tools \
    # TUN device module
    kmod \
    # Puppeteer / Chromium runtime deps
    chromium-browser \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libgdk-pixbuf2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    xvfb x11-utils dbus-x11 \
    # Python for TUN manager
    python3 python3-pip \
    # Utilities
    bash procps less \
 && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 LTS ─────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

# ── App directory ──────────────────────────────────────────────────────
WORKDIR /app

# Install Node dependencies
COPY package.json ./
RUN npm install --omit=dev

# Install Puppeteer's bundled Chromium (or use system one below)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copy application files
COPY tunnel.js      ./
COPY tun_manager.py ./
COPY gateway.sh     ./
RUN chmod +x gateway.sh

# Session volume (persistent login)
VOLUME ["/app/session"]

# Load TUN kernel module at start (requires privileged / NET_ADMIN)
# Expose nothing — all traffic flows through TUN device internally
# ──────────────────────────────────────────────────────────────────────
# Run Xvfb + app
CMD ["bash", "-c", \
  "modprobe tun 2>/dev/null || true; \
   Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & \
   export DISPLAY=:99; \
   sleep 1; \
   exec node tunnel.js"]

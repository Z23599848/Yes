#!/bin/bash
# gateway.sh - MASTER: Enable IP forwarding and NAT for the VPN clients
set -e

IFACE_OUT=${1:-eth0}   # outbound internet interface
TUN_IFACE=${2:-tun0}   # TUN interface from slave

echo "[GW] Setting up IP forwarding and NAT on master"
echo "[GW]   Internet interface : $IFACE_OUT"
echo "[GW]   TUN interface      : $TUN_IFACE"

# Enable IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward
sysctl -w net.ipv4.ip_forward=1 > /dev/null 2>&1 || true

# Flush old VPN rules (idempotent re-runs)
iptables -t nat  -F
iptables -t filter -F FORWARD 2>/dev/null || true

# NAT: masquerade all traffic from tun0 out through eth0
iptables -t nat -A POSTROUTING -o "$IFACE_OUT" -j MASQUERADE

# Allow forwarding from TUN → internet and established replies back
iptables -A FORWARD -i "$TUN_IFACE" -o "$IFACE_OUT" -j ACCEPT
iptables -A FORWARD -i "$IFACE_OUT" -o "$TUN_IFACE" \
         -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

# Also allow loopback and established local traffic
iptables -A FORWARD -i lo -j ACCEPT

echo "[GW] NAT/forwarding rules applied successfully."
echo "[GW] The slave's routed traffic will now reach the internet."

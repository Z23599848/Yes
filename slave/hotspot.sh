#!/bin/bash
# hotspot.sh - SLAVE: Create a WiFi Access Point and route its traffic through tun0
# Requires: hostapd, dnsmasq, iw, rfkill, iptables
# The WiFi NIC must be passed into the container (--device or --network host)

set -e

WIFI_IFACE=${WIFI_IFACE:-wlan0}      # physical WiFi adapter
TUN_IFACE=${TUN_IFACE:-tun0}         # TUN interface leading to VPN
AP_IP=${AP_IP:-192.168.77.1}         # gateway IP for connected devices
DHCP_START=${DHCP_START:-192.168.77.10}
DHCP_END=${DHCP_END:-192.168.77.100}
SSID=${HOTSPOT_SSID:-BaleTunnel}
PASS=${HOTSPOT_PASS:-tunnel1234}

echo "[HOTSPOT] Configuring WiFi hotspot on $WIFI_IFACE"
echo "[HOTSPOT]   SSID  : $SSID"
echo "[HOTSPOT]   GW IP : $AP_IP"
echo "[HOTSPOT]   TUN   : $TUN_IFACE"

# Unblock WiFi (rfkill)
rfkill unblock wifi 2>/dev/null || true

# Bring up WiFi interface
ip link set "$WIFI_IFACE" up || {
    echo "[HOTSPOT] ERROR: Cannot bring up $WIFI_IFACE"
    echo "[HOTSPOT] Make sure you passed the WiFi device to the container."
    echo "[HOTSPOT] Try: docker run --device /dev/<wifi> ... or use --network host"
    exit 1
}

# Check AP mode support
if ! iw phy 2>/dev/null | grep -q "AP"; then
    echo "[HOTSPOT] WARNING: WiFi card may not support AP mode."
    echo "[HOTSPOT]   Check with: iw phy phy0 info | grep -A 5 'Supported interface modes'"
fi

# Assign AP IP
ip addr flush dev "$WIFI_IFACE" 2>/dev/null || true
ip addr add "$AP_IP/24" dev "$WIFI_IFACE"

# IP forwarding
echo 1 > /proc/sys/net/ipv4/ip_forward

# Route hotspot traffic through TUN interface
iptables -t nat  -F
iptables -t filter -F FORWARD 2>/dev/null || true

iptables -t nat -A POSTROUTING -o "$TUN_IFACE" -j MASQUERADE
iptables -A FORWARD -i "$WIFI_IFACE" -o "$TUN_IFACE" -j ACCEPT
iptables -A FORWARD -i "$TUN_IFACE" -o "$WIFI_IFACE" \
         -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

echo "[HOTSPOT] iptables NAT rules applied: $WIFI_IFACE → $TUN_IFACE"

# Write hostapd config dynamically
cat > /tmp/hostapd.conf <<EOF
interface=$WIFI_IFACE
driver=nl80211
ssid=$SSID
hw_mode=g
channel=6
auth_algs=1
wpa=2
wpa_passphrase=$PASS
wpa_key_mgmt=WPA-PSK
wpa_pairwise=CCMP
rsn_pairwise=CCMP
ignore_broadcast_ssid=0
EOF

# Write dnsmasq config dynamically
cat > /tmp/dnsmasq.conf <<EOF
interface=$WIFI_IFACE
bind-interfaces
dhcp-range=$DHCP_START,$DHCP_END,12h
dhcp-option=3,$AP_IP
dhcp-option=6,8.8.8.8,1.1.1.1
domain-needed
bogus-priv
EOF

# Kill any running copies
pkill hostapd  2>/dev/null || true
pkill dnsmasq  2>/dev/null || true
sleep 0.5

# Start hostapd in background
hostapd /tmp/hostapd.conf -B -P /tmp/hostapd.pid 2>&1 | sed 's/^/[HOSTAPD] /' &

# Start dnsmasq in background
dnsmasq --conf-file=/tmp/dnsmasq.conf --pid-file=/tmp/dnsmasq.pid 2>&1 | sed 's/^/[DNSMASQ] /' &

echo "[HOTSPOT] ✓ WiFi hotspot '$SSID' is now active on $WIFI_IFACE"
echo "[HOTSPOT] ✓ Devices connecting to '$SSID' (pass: $PASS) will be tunneled through Bale"

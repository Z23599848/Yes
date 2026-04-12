#!/usr/bin/env python3
"""
TUN Device Manager - MASTER
Reads/writes raw IP packets between the TUN interface and the tunnel process.
Communicates via stdin/stdout using 2-byte big-endian length-prefixed frames.
"""

import os
import sys
import fcntl
import struct
import threading
import socket
import signal
import time

# ioctl constants for Linux TUN/TAP
TUNSETIFF   = 0x400454ca
TUNSETOWNER = 0x400454cc
IFF_TUN     = 0x0001
IFF_NO_PI   = 0x1000   # No packet information header

TUN_DEV     = '/dev/net/tun'
TUN_NAME    = 'tun0'
MTU         = 1400

def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)
    sys.stderr.flush()

def create_tun(name: str = TUN_NAME) -> 'file':
    """Open /dev/net/tun and bind it to a named interface."""
    tun = open(TUN_DEV, 'r+b', buffering=0)
    # ifreq: 16-byte name + 2-byte flags, padded to 40 bytes
    ifr = struct.pack('16sH22s', name.encode(), IFF_TUN | IFF_NO_PI, b'\x00' * 22)
    fcntl.ioctl(tun, TUNSETIFF, ifr)
    return tun

def configure_tun(name: str, ip: str, peer_ip: str):
    """Configure the TUN interface with IP addresses and routes."""
    os.system(f'ip link set {name} mtu {MTU}')
    os.system(f'ip addr add {ip}/30 peer {peer_ip} dev {name}')
    os.system(f'ip link set {name} up')
    eprint(f'[TUN] {name} configured: local={ip}, peer={peer_ip}, mtu={MTU}')

def main():
    local_ip = sys.argv[1] if len(sys.argv) > 1 else '10.0.0.1'
    peer_ip  = sys.argv[2] if len(sys.argv) > 2 else '10.0.0.2'

    eprint(f'[TUN] Starting TUN manager (local={local_ip}, peer={peer_ip})')

    try:
        tun = create_tun(TUN_NAME)
    except PermissionError:
        eprint('[TUN] ERROR: Not enough permissions. Run as root or with CAP_NET_ADMIN.')
        sys.exit(1)
    except FileNotFoundError:
        eprint('[TUN] ERROR: /dev/net/tun not found. Is TUN module loaded?')
        sys.exit(1)

    configure_tun(TUN_NAME, local_ip, peer_ip)

    stdin_bin  = sys.stdin.buffer
    stdout_bin = sys.stdout.buffer
    running    = True

    def handle_sigterm(sig, frame):
        nonlocal running
        running = False
        eprint('[TUN] Caught SIGTERM, shutting down')

    signal.signal(signal.SIGTERM, handle_sigterm)

    def tun_to_stdout():
        """Read packets from TUN → write to stdout (with 2-byte length prefix)."""
        while running:
            try:
                packet = tun.read(65535)
                if not packet:
                    time.sleep(0.001)
                    continue
                frame = struct.pack('>H', len(packet)) + packet
                stdout_bin.write(frame)
                stdout_bin.flush()
            except Exception as e:
                if running:
                    eprint(f'[TUN→STDOUT] Error: {e}')
                break

    def stdin_to_tun():
        """Read packets from stdin (2-byte prefix) → write to TUN."""
        while running:
            try:
                hdr = stdin_bin.read(2)
                if not hdr or len(hdr) < 2:
                    time.sleep(0.001)
                    continue
                length = struct.unpack('>H', hdr)[0]
                if length == 0 or length > 65535:
                    continue
                packet = stdin_bin.read(length)
                if len(packet) == length:
                    tun.write(packet)
            except Exception as e:
                if running:
                    eprint(f'[STDIN→TUN] Error: {e}')
                break

    t1 = threading.Thread(target=tun_to_stdout, daemon=True, name='tun→stdout')
    t2 = threading.Thread(target=stdin_to_tun,  daemon=True, name='stdin→tun')
    t1.start()
    t2.start()

    eprint('[TUN] Both bridges active. Ctrl+C to stop.')

    try:
        t1.join()
    except KeyboardInterrupt:
        running = False

    eprint('[TUN] Exiting.')

if __name__ == '__main__':
    main()

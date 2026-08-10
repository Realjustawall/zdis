#!/usr/bin/env bash
set -Eeuo pipefail

# VPN clients commonly install a higher-priority default route. Docker media
# packets retain their container source address until NAT post-routing, so
# replies from LiveKit/Coturn can otherwise leave through the VPN and become
# asymmetric. Route only the published WebRTC/TURN source ports via the main
# table; leave all other container traffic on its existing policy.
replace_rule() {
  local priority="$1"
  shift
  while ip rule del priority "$priority" 2>/dev/null; do :; done
  ip rule add priority "$priority" "$@" lookup main
}

replace_rule 80 ipproto udp sport 50000-50100
replace_rule 81 ipproto tcp sport 7881
replace_rule 82 ipproto udp sport 3478
replace_rule 83 ipproto tcp sport 3478
replace_rule 84 ipproto udp sport 49160-49200

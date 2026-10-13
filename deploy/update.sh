#!/usr/bin/env bash
# 새 버전 올린 뒤 서버에서 실행 — 압축 풀고 다시 켠다
#
#   sudo bash /opt/feral/deploy/update.sh ~/feral.tgz
set -euo pipefail
PKG="${1:-$HOME/feral.tgz}"
cd /opt/feral
rm -rf dist
tar -xzf "$PKG"
npm ci --omit=dev
chown -R root:root /opt/feral
systemctl restart feral
echo "업데이트 끝"

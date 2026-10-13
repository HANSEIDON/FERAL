#!/usr/bin/env bash
# FERAL 서버 설치 — Oracle Cloud Ubuntu 서버에서 한 번 실행한다.
#
#   sudo bash setup.sh feral.duckdns.org [https포트]
#
# https포트 — 기본 443. VPN(Amnezia XRay)처럼 443 을 이미 쓰는 서버면 8443 등으로.
#            인증서는 80 번으로 받으므로 80 은 비어 있어야 한다.
#
# 하는 일
#   1. Node 22 · Caddy(HTTPS 자동 인증서) 설치
#   2. Oracle 우분투 기본 방화벽(iptables)에 80 · 443 열기 — 콘솔의 보안 목록과 별개라 둘 다 열어야 한다
#      (Oracle 처럼 막는 규칙이 있을 때만 건드린다 — 구글 클라우드 · VPN 이 쓰는 규칙은 그대로 둔다)
#   3. 이 폴더(/opt/feral)를 feral 서비스로 등록 — 서버가 재부팅돼도 알아서 켜진다
#   4. https://도메인 → 게임 서버(3000) 로 연결 (웹소켓 포함)
set -euo pipefail

DOMAIN="${1:?도메인을 넣어 주세요 — 예: sudo bash setup.sh feral.duckdns.org}"
APP=/opt/feral
HTTPS_PORT="${2:-443}"
# 게임 서버는 권한 없는 전용 계정으로 돌린다 — 혹시 서버가 뚫려도 sudo · VPN 설정에 못 닿게
RUN_USER=feral
id -u feral >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin feral

echo "== 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl gnupg debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  echo "== 방화벽 80 · 443 (Oracle 기본 차단 규칙이 있다)"
  apt-get install -y iptables-persistent
  for p in 80 "$HTTPS_PORT"; do
    iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport $p -j ACCEPT
  done
  netfilter-persistent save
fi

echo "== 게임 서버"
cd "$APP"
npm ci --omit=dev
chown -R root:root "$APP"            # 코드는 root 소유 — 게임 서버(feral)는 읽기만 한다
cat > /etc/systemd/system/feral.service <<EOF
[Unit]
Description=FERAL game server
After=network.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP
Environment=NODE_ENV=production PORT=3000
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=300M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now feral
systemctl restart feral

SITE="$DOMAIN"; [ "$HTTPS_PORT" = 443 ] || SITE="$DOMAIN:$HTTPS_PORT"
echo "== HTTPS ($SITE)"
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
  encode gzip
  reverse_proxy localhost:3000
}
EOF
systemctl restart caddy

echo
echo "끝 — https://$SITE 으로 접속해 보세요 (인증서 발급에 몇십 초 걸릴 수 있습니다)"
echo "로그 보기: journalctl -u feral -f"

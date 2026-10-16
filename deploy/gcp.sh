#!/usr/bin/env bash
# 구글 클라우드 Cloud Shell 에서 돌리는 FERAL 서버 설치 (VPN 이 돌고 있는 그 VM 에 같이 올린다)
#
#   1단계  bash gcp.sh check              VM 찾기 · 포트 확인 (아무것도 바꾸지 않음)
#   2단계  bash gcp.sh prepare            IP 고정 · 방화벽 80/443 열기 → 고정 IP 를 알려준다
#          (여기서 duckdns.org 에 그 IP 를 넣는다)
#   3단계  bash gcp.sh install 도메인     feral.tgz 를 VM 에 올리고 설치
#   업데이트 bash gcp.sh update           새 feral.tgz 를 올리고 다시 켠다 (접속 한 번)
#            bash gcp.sh reinstall        이미 올라간 feral.tgz 로 설치만 다시
#
# feral.tgz 는 PC 에서 `npm run pack` 으로 만들고, Cloud Shell 오른쪽 위 ⋮ → 업로드로 올린다.
# VM 이 여러 대면 앞에 VM=이름 ZONE=영역 을 붙인다:  VM=vpn ZONE=asia-northeast3-a bash gcp.sh check
# 443 을 VPN 이 쓰고 있으면 PORT=8443 도 붙인다 (prepare · install 둘 다)
set -euo pipefail
PORT="${PORT:-443}"

if [ -z "${VM:-}" ] || [ -z "${ZONE:-}" ]; then
  mapfile -t ROWS < <(gcloud compute instances list --format='value(name,zone.basename())')
  if [ "${#ROWS[@]}" -ne 1 ]; then
    echo "VM 이 ${#ROWS[@]}대입니다 — VM=이름 ZONE=영역 을 붙여서 다시 실행하세요:"; printf '  %s\n' "${ROWS[@]}"; exit 1
  fi
  read -r VM ZONE <<< "${ROWS[0]}"
fi
REGION="${ZONE%-*}"
ssh_vm() { gcloud compute ssh "$VM" --zone "$ZONE" --command "$1"; }
echo "VM: $VM  ($ZONE)"

case "${1:-}" in
check)
  gcloud compute instances describe "$VM" --zone "$ZONE" --format='table(machineType.basename(),status,networkInterfaces[0].accessConfigs[0].natIP:label=IP)'
  ssh_vm 'echo; free -h | head -2; echo; echo "== TCP 로 열려 있는 포트"; sudo ss -tlnp | awk "NR>1{print \$4, \$6}"; echo; echo "== 도커"; sudo docker ps --format "{{.Names}}  {{.Ports}}" 2>/dev/null || true'
  echo
  echo "→ 위 목록에 :80 · :443 이 이미 있으면 알려주세요 (VPN 이 쓰고 있으면 다른 포트로 바꿔야 합니다)"
  ;;
prepare)
  IP=$(gcloud compute instances describe "$VM" --zone "$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
  if ! gcloud compute addresses list --filter="address=$IP" --format='value(name)' | grep -q .; then
    echo "== 지금 IP($IP)를 고정 IP 로 바꿉니다 (VPN 주소도 그대로 유지)"
    gcloud compute addresses create feral-ip --region "$REGION" --addresses "$IP"
  fi
  if ! gcloud compute firewall-rules describe feral-web >/dev/null 2>&1; then
    echo "== 방화벽: 80 · $PORT 열기 (feral 태그가 붙은 VM 만)"
    gcloud compute firewall-rules create feral-web --allow tcp:80,tcp:$PORT --target-tags feral --source-ranges 0.0.0.0/0
  else
    gcloud compute firewall-rules update feral-web --allow tcp:80,tcp:$PORT
  fi
  gcloud compute instances add-tags "$VM" --zone "$ZONE" --tags feral
  echo
  echo "고정 IP: $IP  ← duckdns.org 의 도메인 current ip 에 이걸 넣고 update ip 를 누르세요"
  ;;
install)
  DOMAIN="${2:?도메인을 넣어 주세요 — bash gcp.sh install feral-game.duckdns.org}"
  [ -f feral.tgz ] || { echo "feral.tgz 가 없습니다 — PC 에서 npm run pack 후 Cloud Shell 에 업로드하세요"; exit 1; }
  gcloud compute scp feral.tgz "$VM":~/feral.tgz --zone "$ZONE"
  ssh_vm "sudo mkdir -p /opt/feral && sudo tar -xzf ~/feral.tgz -C /opt/feral && sudo bash /opt/feral/deploy/setup.sh $DOMAIN $PORT"
  ;;
update)
  [ -f feral.tgz ] || { echo "feral.tgz 가 없습니다"; exit 1; }
  # 한 번 접속으로 올리고 설치까지 — 따로 접속하면 그 사이에 서버가 연결을 끊는 일이 있었다 (SSH 공격이 몰릴 때)
  gcloud compute ssh "$VM" --zone "$ZONE" --command 'cat > ~/feral.tgz && sudo bash /opt/feral/deploy/update.sh ~/feral.tgz' < feral.tgz
  ;;
reinstall)
  # 이미 올라가 있는 ~/feral.tgz 로 설치만 다시 (업로드는 됐는데 설치 단계에서 끊겼을 때)
  ssh_vm 'sudo bash /opt/feral/deploy/update.sh ~/feral.tgz'
  ;;
*)
  sed -n '2,12p' "$0"
  ;;
esac

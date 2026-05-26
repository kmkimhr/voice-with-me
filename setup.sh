#!/bin/bash
set -e

# ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "${SCRIPT_DIR}/deploy.env" ]; then
  echo "ERROR: deploy.env not found."
  echo "Copy deploy.env.example and fill in your values:"
  echo "  cp deploy.env.example deploy.env"
  exit 1
fi

source "${SCRIPT_DIR}/deploy.env"

: "${DOMAIN:?DOMAIN is not set in deploy.env}"
: "${EMAIL:?EMAIL is not set in deploy.env}"
: "${PUBLIC_IP:?PUBLIC_IP is not set in deploy.env}"

CERTBOT_CONF="${SCRIPT_DIR}/certbot/conf"
CERTBOT_WWW="${SCRIPT_DIR}/certbot/www"
# ──────────────────────────────────────────────

cd "${SCRIPT_DIR}"

echo "=== [1/5] 설정 파일에 도메인/IP 적용 ==="
echo "    이유: nginx 설정과 sfu 환경파일의 자리표시자(YOUR_DOMAIN 등)를 실제 값으로 치환"
sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" "${SCRIPT_DIR}/nginx/video-chat.conf"
sed -i "s/YOUR_SERVER_PUBLIC_IP/${PUBLIC_IP}/g" "${SCRIPT_DIR}/sfu/.env"

echo "=== [2/5] certbot 디렉토리 준비 ==="
echo "    이유: 인증서(conf)와 ACME 챌린지 파일(www)을 보관할 호스트 디렉토리 생성"
mkdir -p "${CERTBOT_CONF}" "${CERTBOT_WWW}"

if [ -d "${CERTBOT_CONF}/live/${DOMAIN}" ]; then
  echo "=== [3/5] 기존 인증서 갱신 시도 ==="
  echo "    이유: 인증서가 이미 있으므로 신규 발급 대신 갱신만 시도"
  echo "          (certbot renew는 만료 30일 이내일 때만 실제 갱신 → 발급 횟수 제한 회피)"

  echo "--- [3-1] nginx 기동 ---"
  echo "    이유: 갱신이 실제로 일어날 경우 ACME 챌린지에 응답하려면 nginx가 떠 있어야 함"
  docker compose up -d --build nginx

  echo "--- [3-2] 인증서 갱신 시도 ---"
  echo "    이유: 만료가 임박했을 때만 실제로 갱신되고, 아니면 그냥 통과"
  docker compose run --rm certbot renew

  echo "--- [3-3] nginx 재적용(reload) ---"
  echo "    이유: 갱신됐다면 새 인증서를 nginx가 다시 읽도록 reload (미갱신 시에도 무해)"
  docker compose exec nginx nginx -s reload
else
  echo "=== [3/5] SSL 인증서 발급 (docker nginx + certbot webroot) ==="
  echo "    배경: nginx는 인증서 파일이 없으면 기동 실패하고, certbot은 nginx가 떠 있어야"
  echo "          ACME 챌린지에 응답해 발급이 가능 → 순환 문제를 더미 인증서로 풀어냄"

  echo "--- [3-1] 임시 더미 인증서 생성 ---"
  echo "    이유: nginx가 일단 기동할 수 있도록 가짜 인증서를 껍데기로 제공"
  mkdir -p "${CERTBOT_CONF}/live/${DOMAIN}"
  docker compose run --rm --entrypoint sh certbot -c "\
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout /etc/letsencrypt/live/${DOMAIN}/privkey.pem \
      -out /etc/letsencrypt/live/${DOMAIN}/fullchain.pem \
      -subj '/CN=localhost'"

  echo "--- [3-2] nginx 기동 ---"
  echo "    이유: 더미 인증서로라도 떠서 80포트의 ACME 챌린지에 응답하기 위함"
  docker compose up -d --build nginx

  echo "--- [3-3] 더미 인증서 제거 ---"
  echo "    이유: 정식 인증서가 들어갈 자리를 비움"
  docker compose run --rm --entrypoint sh certbot -c "\
    rm -rf /etc/letsencrypt/live/${DOMAIN} \
           /etc/letsencrypt/archive/${DOMAIN} \
           /etc/letsencrypt/renewal/${DOMAIN}.conf"

  echo "--- [3-4] Let's Encrypt 정식 인증서 발급 ---"
  echo "    이유: 떠 있는 nginx를 통해 도메인 소유를 검증받아 진짜 인증서 발급(webroot)"
  docker compose run --rm certbot certonly \
    --webroot -w /var/www/certbot \
    -d "${DOMAIN}" \
    --email "${EMAIL}" \
    --agree-tos \
    --non-interactive

  echo "--- [3-5] nginx 재적용(reload) ---"
  echo "    이유: nginx는 기동 시 더미 인증서를 메모리에 올렸으므로, 디스크의 정식"
  echo "          인증서로 교체된 것을 반영하려면 설정/인증서를 다시 읽어야 함"
  docker compose exec nginx nginx -s reload
fi

echo "=== [4/5] 전체 서비스 기동 ==="
echo "    이유: nginx(정식 인증서 적용 완료) 외에 sfu, turn까지 포함해 전체를 올림"
docker compose up -d --build

echo "=== [5/5] 상태 확인 ==="
echo "    이유: 모든 컨테이너가 정상 기동했는지 최종 점검"
docker compose ps

echo ""
echo "완료! https://${DOMAIN} 에서 확인하세요."
echo "  nginx 로그: docker compose logs -f nginx"
echo "  SFU 로그:   docker compose logs -f sfu"
echo "  TURN 로그:  docker compose logs -f turn"

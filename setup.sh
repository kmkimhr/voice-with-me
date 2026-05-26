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
# ──────────────────────────────────────────────

echo "=== [1/6] nginx 설치 ==="
sudo apt-get update -y
sudo apt-get install -y nginx

echo "=== [2/6] certbot 설치 ==="
sudo apt-get install -y certbot python3-certbot-nginx

echo "=== [3/6] HTTP-only 임시 nginx 설정 (certbot 인증용) ==="
sudo mkdir -p /var/www/certbot

# SSL 인증서가 아직 없으므로 HTTP-only 임시 설정으로 먼저 nginx 기동
sudo tee /etc/nginx/conf.d/video-chat.conf > /dev/null <<NGINX_EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}
NGINX_EOF

# 기존 default 설정 충돌 방지
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

echo "=== [4/6] Let's Encrypt 인증서 발급 ==="
sudo certbot certonly --webroot -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive

echo "=== [3b/6] SSL 포함 최종 nginx 설정 적용 ==="
sudo cp "${SCRIPT_DIR}/nginx/video-chat.conf" /etc/nginx/conf.d/video-chat.conf
sudo sed -i "s/YOUR_DOMAIN/${DOMAIN}/g" /etc/nginx/conf.d/video-chat.conf
sudo nginx -t && sudo systemctl reload nginx

echo "=== [5/6] SFU .env 설정 ==="
sed -i "s/YOUR_SERVER_PUBLIC_IP/${PUBLIC_IP}/g" "${SCRIPT_DIR}/sfu/.env"

echo "=== [6/6] Front 빌드 ==="
cd "${SCRIPT_DIR}/front"
npm install
npm run build

echo "=== nginx 재시작 ==="
sudo systemctl reload nginx

echo "=== Docker Compose 시작 ==="
cd "${SCRIPT_DIR}"
docker compose up -d

echo ""
echo "완료! https://${DOMAIN} 에서 확인하세요."
echo "  SFU 로그: docker compose logs -f sfu"
echo "  TURN 로그: docker compose logs -f turn"

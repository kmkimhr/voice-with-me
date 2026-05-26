#!/bin/bash
set -e

# ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# ──────────────────────────────────────────────

cd "${SCRIPT_DIR}"

echo "=== Docker Compose 서비스 종료 ==="
docker compose down

echo ""
echo "모든 서비스가 종료되었습니다."

#!/usr/bin/env bash
# Deploy por SSH para um servidor Linux sem Docker: envia o código, instala dependências e reinicia pelo watchdog.
# Configuração em deploy/.env.deploy (fora do git), ex.:
#   DEPLOY_HOST=usuario@meu-servidor
#   DEPLOY_SSH_KEY=~/.ssh/id_ed25519
#   DEPLOY_DIR=apps/family-finances      # relativo ao home no servidor
#   DEPLOY_PORT=3010
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/.env.deploy ] && set -a && . deploy/.env.deploy && set +a
: "${DEPLOY_HOST:?defina DEPLOY_HOST em deploy/.env.deploy}"
DIR="${DEPLOY_DIR:-apps/family-finances}"
PORT="${DEPLOY_PORT:-3010}"
SSH=(ssh -o BatchMode=yes)
[ -n "${DEPLOY_SSH_KEY:-}" ] && SSH+=(-i "${DEPLOY_SSH_KEY/#\~/$HOME}")

rsync -az --delete -e "${SSH[*]}" \
  --exclude node_modules --exclude data --exclude .git --exclude deploy/private --exclude deploy/.env.deploy --exclude .env \
  ./ "$DEPLOY_HOST:$DIR/"
"${SSH[@]}" "$DEPLOY_HOST" "set -e; cd ~/$DIR; npm ci --omit=dev --no-audit --no-fund --loglevel=error
  bash deploy/watchdog.sh --restart; sleep 2
  curl -s -o /dev/null -w 'app: HTTP %{http_code}\n' http://127.0.0.1:$PORT/healthz"

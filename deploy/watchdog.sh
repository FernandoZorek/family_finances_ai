#!/usr/bin/env bash
# Mantém o app no ar sem systemd/Docker (ex.: usuário sem sudo). Rode pelo cron a cada 2 min e no @reboot:
#   */2 * * * * bash ~/apps/family-finances/deploy/watchdog.sh
#   @reboot     bash ~/apps/family-finances/deploy/watchdog.sh
# Variáveis do app em $DATA_DIR/.env (veja .env.example). Opcional: túnel Cloudflare em ~/.cloudflared/config.yml.
# --restart: para o app antes (usado pelo deploy).
# padrão: pasta do app = onde este script está; dados em "<pasta do app>-data"
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${DATA_DIR:-$APP_DIR-data}"
TUNNEL_CFG="${TUNNEL_CFG:-$HOME/.cloudflared/config.yml}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/bin/cloudflared}"
TAG="family-finances-server"
mkdir -p "$DATA_DIR/logs" && chmod 700 "$DATA_DIR"

# logs: mantém até ~5 MB
for f in "$DATA_DIR"/logs/*.log; do
  [ -f "$f" ] && [ "$(stat -c %s "$f")" -gt 5242880 ] && tail -c 1048576 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

if [ "${1:-}" = "--restart" ]; then
  pkill -u "$(id -u)" -f "node .*server.js $TAG" || true
  sleep 1
fi

if ! pgrep -u "$(id -u)" -f "node .*server.js $TAG" >/dev/null; then
  ENV_ARG=()
  [ -f "$DATA_DIR/.env" ] && ENV_ARG=(--env-file="$DATA_DIR/.env")
  cd "$APP_DIR" && DATA_DIR="$DATA_DIR" NODE_ENV=production \
    setsid -f node "${ENV_ARG[@]}" server.js "$TAG" >> "$DATA_DIR/logs/app.log" 2>&1 < /dev/null
fi

if [ -f "$TUNNEL_CFG" ] && [ -x "$CLOUDFLARED" ] && ! pgrep -u "$(id -u)" -f "cloudflared --no-autoupdate --config $TUNNEL_CFG tunnel ru[n]" >/dev/null; then
  setsid -f "$CLOUDFLARED" --no-autoupdate --config "$TUNNEL_CFG" tunnel run >> "$DATA_DIR/logs/tunnel.log" 2>&1 < /dev/null
fi

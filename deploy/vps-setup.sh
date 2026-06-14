#!/usr/bin/env bash
# ============================================================================
# CS2 Bet — Instalador para VPS (Debian/Ubuntu, ex.: Contabo)
# ----------------------------------------------------------------------------
# A própria VPS:
#   1. coleta os dados da HLTV e gera o index.html
#   2. serve o site num nginx na porta 80  (http://SEU_IP)
#   3. atualiza sozinho a cada 6 horas (cron)
#
# Uso (cole UMA linha no terminal da VPS, como root/sudo):
#   curl -fsSL https://raw.githubusercontent.com/ericksgarcia/Cs-bet/main/deploy/vps-setup.sh | sudo bash
# ============================================================================
set -euo pipefail

REPO_URL="https://github.com/ericksgarcia/Cs-bet.git"
BRANCH="main"
APP_DIR="/opt/cs-bet"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ Rode como root (use: sudo bash)"; exit 1
fi

echo "==> Instalando dependências do sistema (git, nginx, curl)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git nginx ca-certificates

echo "==> Garantindo Node.js 20..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v) / npm $(npm -v)"

echo "==> Baixando o projeto em $APP_DIR..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --quiet -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo "==> Instalando dependências do Node..."
cd "$APP_DIR"
npm install --no-audit --no-fund

echo "==> Gerando o index.html pela primeira vez..."
NUM_GAMES="8" DELAY_MS="4000" FIRST_MODE="seed" node build.mjs \
  || echo "    (geração inicial falhou — o index.html semente será exibido por enquanto)"

echo "==> Configurando o nginx..."
cat >/etc/nginx/sites-available/cs-bet <<EOF
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;
  root $APP_DIR;
  index index.html;
  location / { try_files \$uri \$uri/ =404; }
}
EOF
ln -sf /etc/nginx/sites-available/cs-bet /etc/nginx/sites-enabled/cs-bet
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

echo "==> Liberando a porta 80 no firewall (se houver)..."
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp || true
fi

echo "==> Agendando atualização automática a cada 6 horas..."
cat >/etc/cron.d/cs-bet <<EOF
# Regenera as previsões CS2 a cada 6 horas
0 */6 * * * root cd $APP_DIR && NUM_GAMES=8 DELAY_MS=4000 FIRST_MODE=seed /usr/bin/node build.mjs >> /var/log/cs-bet.log 2>&1
EOF
chmod 0644 /etc/cron.d/cs-bet

IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo SEU_IP)"
echo ""
echo "==================================================================="
echo "  ✓ Pronto! Seu site está no ar em:"
echo ""
echo "        http://$IP"
echo ""
echo "  • Atualiza sozinho a cada 6h (log em /var/log/cs-bet.log)"
echo "  • Para atualizar agora:  cd $APP_DIR && node build.mjs"
echo "==================================================================="

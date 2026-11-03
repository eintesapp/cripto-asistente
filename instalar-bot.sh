#!/usr/bin/env bash
# Instalador del bot en un servidor Ubuntu (Oracle Cloud).
# Uso:  bash <(curl -fsSL https://raw.githubusercontent.com/eintesapp/cripto-asistente/main/instalar-bot.sh)
set -euo pipefail
REPO="https://github.com/eintesapp/cripto-asistente.git"
DIR="$HOME/cripto-asistente"

echo "== 1/4 Instalando Node.js y git =="
sudo apt-get update -y >/dev/null
sudo apt-get install -y git curl >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== 2/4 Descargando la app desde GitHub =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"

echo "== 3/4 Claves (se guardan SOLO en este servidor, en $DIR/.env) =="
if [ -f .env ] && [ "${1:-}" != "--nuevas-claves" ]; then
  echo "Ya existe .env; lo mantengo. Para cambiar claves: bash instalar-bot.sh --nuevas-claves"
else
  read -rp "Modo (testnet o real) [testnet]: " MODE </dev/tty; MODE=${MODE:-testnet}
  read -rp "Binance API Key: " KEY </dev/tty
  read -rsp "Binance Secret Key (no se verá al escribir; pégala y presiona Enter): " SECRET </dev/tty; echo
  read -rp "Token del bot de Telegram: " TGT </dev/tty
  read -rp "Tu chat ID de Telegram: " TGC </dev/tty
  umask 077
  printf 'BINANCE_MODE=%s\nBINANCE_API_KEY=%s\nBINANCE_API_SECRET=%s\nTELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=%s\n' \
    "$MODE" "$KEY" "$SECRET" "$TGT" "$TGC" > .env
  chmod 600 .env
fi

echo "== 4/4 Creando el servicio (arranca solo y se reinicia si falla) =="
sudo tee /etc/systemd/system/cripto-bot.service >/dev/null <<UNIT
[Unit]
Description=Cripto Senales - bot de trading con confirmacion
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) --env-file=$DIR/.env $DIR/bot.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable cripto-bot >/dev/null
sudo systemctl restart cripto-bot
sleep 4
sudo systemctl --no-pager --lines=8 status cripto-bot || true

echo
echo "Listo. En Telegram deberías recibir: 'Bot iniciado'."
echo "IP pública de este servidor (la usarás para proteger tu clave REAL de Binance):"
curl -fsS https://ifconfig.me || true; echo
echo "Ver el registro en vivo:  journalctl -u cripto-bot -f"

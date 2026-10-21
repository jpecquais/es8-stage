#!/bin/sh
# À lancer sur le Pi, depuis le dossier source (~/es8-stage, avec es8/ dedans) : installe ou met à
# jour es8core, es8ctl et es8stage dans ~/venv, puis le service es8-stage. Sans danger à relancer.
#   ./deploy/pi/install.sh [--midi WIDI] [--ble 20:98:66:65:EA:44]
set -eu
cd "$(dirname "$0")/../.."
ARGS="$*"

if [ ! -x "$HOME/venv/bin/python" ]; then
  sudo apt-get install -y python3-venv python3-mido python3-rtmidi bluez
  python3 -m venv --system-site-packages "$HOME/venv"
fi
"$HOME/venv/bin/pip" install -q --force-reinstall --no-deps ./es8/packages/core ./es8/packages/cli ./packages/stage
"$HOME/venv/bin/pip" install -q typer

# Données de l'ancien service (es8ctl web --stage) : reprises telles quelles.
OLD="$HOME/.local/share/es8ctl" NEW="$HOME/.local/share/es8stage"
if [ -d "$OLD" ] && [ ! -e "$NEW" ]; then mv "$OLD" "$NEW"; fi

if [ -n "$ARGS" ] || [ ! -f /etc/default/es8-stage ]; then
  echo "ES8_STAGE_ARGS=\"${ARGS:---midi WIDI}\"" | sudo tee /etc/default/es8-stage >/dev/null
fi
sudo install -m 644 deploy/pi/es8-stage.service /etc/systemd/system/es8-stage.service
if systemctl list-unit-files es8-web.service >/dev/null 2>&1 && systemctl is-enabled es8-web >/dev/null 2>&1; then
  sudo systemctl disable --now es8-web  # ancien nom du service
fi
sudo systemctl daemon-reload
sudo systemctl enable es8-stage >/dev/null 2>&1
sudo systemctl restart es8-stage
systemctl is-active es8-stage

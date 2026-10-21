#!/bin/sh
# Depuis le Mac : envoie la version commitée (avec le sous-module es8) sur le Pi et l'installe.
#   ./deploy/pi/push.sh [es8@pedalbrain.local] [arguments de install.sh]
set -eu
SSH="${SSH:-ssh}"
cd "$(dirname "$0")/../.."
TARGET="${1:-es8@pedalbrain.local}"
[ $# -gt 0 ] && shift
{ git archive --format=tar HEAD; git -C es8 archive --format=tar --prefix=es8/ HEAD; } \
  | $SSH "$TARGET" 'rm -rf ~/es8-stage.new && mkdir ~/es8-stage.new && cd ~/es8-stage.new && tar -xif - \
      && rm -rf ~/es8-stage && mv ~/es8-stage.new ~/es8-stage'
$SSH "$TARGET" "sh ~/es8-stage/deploy/pi/install.sh $*"

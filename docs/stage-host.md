# Hôte de scène : la Companion sur un Raspberry Pi

Le Pi tient la Companion pendant le concert, seul, sans écran : il avance
dans la setlist, traduit les appuis sur les switches de l'ES-8 et envoie les
messages aux machines. Les tablettes et téléphones du réseau n'en sont que
des écrans (et des télécommandes). Rôles : `docs/companion.md`.

Statut : décidé le 2026-10-20. Pi installé (`pedalbrain`, Raspberry Pi 3
Model B, Raspberry Pi OS Lite 64 bits « Trixie », sans GUI, utilisateur
`es8`, SSH par clé). Liaison avec l'ES-8 : le WIDI Jack en Bluetooth (BLE
MIDI de BlueZ) pour l'instant ; une interface USB-MIDI filaire plus tard.

## Principe

```
ES-8 ──BLE MIDI (WIDI)──▶ Pi : es8ctl stage ──BLE MIDI──▶ ES-8 (Thru) ──▶ machines
                               │  (logique, état, show)
                               └──HTTP + WebSocket──▶ Companion dans un navigateur (affichage, télécommande)
```

- **Le Pi est la seule Companion qui parle à l'ES-8.** Les navigateurs ne
  touchent pas au MIDI : ils affichent l'état que le Pi leur pousse et lui
  envoient les gestes (toucher un pavé, Next à l'écran, changer de setlist).
- Le Pi joue même si aucun écran n'est ouvert, et reprend sa position après
  un redémarrage (sans rien envoyer, comme la Companion).

## Le service `es8ctl stage`

- Commande de la CLI, service systemd au démarrage du Pi.
- **Logique** : `es8core.stage`, en Python, la même que `web/companion/show.js`
  (déplacements, switches, groupes, crans, secours, messages de pas). Les deux
  sont vérifiées sur les mêmes cas (tests), pour qu'elles ne divergent pas.
- **MIDI** : `mido` + `python-rtmidi` (ALSA). Port choisi par son nom
  (« WIDI » par défaut), rouvert tout seul s'il disparaît (Bluetooth).
- **Show** : un fichier sur le Pi (`~/.local/share/es8ctl/show.json`),
  remplacé par un envoi depuis le Designer ou `es8ctl stage push` ; la
  position et l'état sont gardés à côté.
- **HTTP** : sert `web/companion/` et une WebSocket `/stage` :
  - Pi → écrans : `{"type": "state", show, pos, states, backup, traffic, move}`
    à chaque changement ;
  - écrans → Pi : `{"type": "act", action}`, `{"type": "press", key, down}`,
    `{"type": "goto", setlist, step}`, `{"type": "show", show}`.
- **La Companion web** gagne un mode « Pi » : si la page est servie par le
  Pi (ou `?stage=ws://…`), elle ne demande pas le MIDI et passe par la
  WebSocket ; sinon elle fonctionne comme aujourd'hui (navigateur seul).

## Le Pi comme une pédale

1. Démarrage automatique du service ; reconnexion du WIDI.
2. Système en lecture seule (overlayfs) une fois réglé : on peut couper le
   courant n'importe quand. Le show et la position vivent dans une petite
   zone inscriptible (ou sont réécrits à chaque changement de show).
3. Accès : SSH par clé (utilisateur `es8`) ; `pedalbrain.local` sur le réseau.
4. Écran : n'importe quel navigateur du réseau sur `http://pedalbrain.local:8765/`.
   Sur scène, le Pi peut ouvrir son propre point d'accès Wi-Fi (plus tard).

## Ordre de travail

1. BLE MIDI : appairer le WIDI au Pi, vérifier qu'un port ALSA apparaît et
   que les PC passent.
2. `es8core.stage` (logique Python) + tests de parité avec `show.js`.
3. `es8ctl stage` : MIDI, HTTP, WebSocket ; mode « Pi » de la Companion.
4. Installation sur le Pi (systemd), puis lecture seule.

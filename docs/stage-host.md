# Hôte de scène : la Companion sur un Raspberry Pi

Le Pi tient la Companion pendant le concert, seul, sans écran : il avance
dans la setlist, traduit les appuis sur les switches de l'ES-8 et envoie les
messages aux machines. Les tablettes et téléphones du réseau n'en sont que
des écrans (et des télécommandes). Rôles : `docs/companion.md`.

Statut : décidé et codé le 2026-10-20 (`es8core.stage`, `es8ctl/stage_server.py`). Pi installé (`pedalbrain`, Raspberry Pi 3
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
- **HTTP** (`es8ctl web --stage --midi WIDI [--ble <adresse>]`), bibliothèque
  standard seulement :
  - `GET /stage/state` : l'état (show, pos, states, backup, traffic, move,
    midi) ; `GET /stage/events` : le même, poussé à chaque changement
    (Server-Sent Events) ;
  - `POST /stage/act` : `{"type": "act", action}`, `{"type": "press", key,
    down}`, `{"type": "goto", setlist, step}`, `{"type": "resend"}` ;
  - `POST /stage/show.json` : nouveau show, rechargé aussitôt.
- **La Companion web** : si `/stage/state` répond, elle devient l'écran de
  l'hôte (aucun MIDI dans le navigateur, d'où le fonctionnement en HTTP
  simple) ; sinon elle fonctionne comme avant (Web MIDI du navigateur).

## Le Pi, centre de tout (décidé le 2026-10-20)

Le WIDI ne parle qu'à un appareil à la fois : si le Pi le tient, le Designer
et ES8 Control ouverts sur le Mac ne joignent plus l'ES-8. Toutes les apps
tournent donc sur le Pi, et **le Pi est le seul maître du MIDI** ; Mac et
iPad ne sont que des écrans.

### Pont MIDI pour le Designer et ES8 Control

- Le moteur commun (`web/shared/engine.js`, Python dans Pyodide) garde tout
  son travail ; seul le « tuyau » change : Web MIDI du navigateur, ou **MIDI
  du Pi**.
- Pi : `POST /stage/midi` (des messages, SysEx compris, envoyés à l'ES-8) et
  `GET /stage/midi/events` (Server-Sent Events : ce que l'ES-8 répond).
  Même port que la Companion ; la Companion ignore le SysEx.
- Choix automatique : page servie par un hôte de scène → MIDI du Pi.
- **Verrou de scène** : écrire sur l'ES-8 depuis le Designer ou Control
  demande que la Companion soit en pause (bouton « Edit mode » sur l'hôte) ;
  les lectures restent permises.

### Bibliothèque de sets

Sur le Pi (`~/.local/share/es8ctl/library/`) :

- **Projets** (`*.es8project.json`) : le Designer ouvre et enregistre sur le
  Pi au lieu du stockage du navigateur ; le même projet sur Mac et iPad.
- **Shows** : celui joué par la Companion se choisit dans la liste ; le
  bouton Show du Designer en ajoute un.
- **Sauvegardes de l'ES-8** (dumps `.syx`), avec « restaurer ».
- Actions : choisir le show joué, ouvrir, dupliquer, renommer, supprimer,
  importer, télécharger (copie sur le Mac).

### Réseau

- **Chez soi, le Pi rejoint le réseau connu** (Wi-Fi de la maison, de la
  salle de répétition…) ; Mac et iPad le joignent sur `pedalbrain.local`
  sans perdre Internet. **Ailleurs, il crée son réseau `pedalbrain`** (point
  d'accès `hostapd` + `dnsmasq`, Pi = 10.42.0.1 ; NetworkManager ne gère pas
  wlan0, cf. la mise au point de l'iPad). L'Ethernet reste toujours actif.
- Bascule : au démarrage et toutes les minutes sans réseau connu, un service
  cherche les réseaux connus ; trouvé → client (hostapd arrêté) ; perdu ou
  absent → point d'accès. Sur scène, on peut forcer « point d'accès
  seulement ».
- Réglages depuis la page de l'hôte : réseaux connus (ajouter, retirer,
  ordre), nom et mot de passe du point d'accès, état (connecté à, adresse,
  appareils sur le point d'accès).
- **Garde-fou** : un changement de réseau qui coupe l'accès est annulé seul
  au bout de 60 s s'il n'est pas confirmé depuis la page ; le point d'accès
  reste le recours.

### Page de l'hôte (`/host/`)

Bibliothèque, réseau, système (redémarrer le service, redémarrer ou éteindre
proprement le Pi, état du WIDI et reconnexion, lecture seule, mise à jour du
programme). Protégée par un mot de passe (elle peut couper le réseau ou
effacer un set) ; la Companion reste ouverte sans mot de passe.

## Le Pi comme une pédale

1. Démarrage automatique du service ; reconnexion du WIDI.
2. Système en lecture seule (overlayfs) une fois réglé : on peut couper le
   courant n'importe quand. Le show et la position vivent dans une petite
   zone inscriptible (ou sont réécrits à chaque changement de show).
3. Accès : SSH par clé (utilisateur `es8`) ; `pedalbrain.local` sur le réseau.
4. Écran : n'importe quel navigateur du réseau sur `http://pedalbrain.local:8765/`.
   Sur scène, le Pi peut ouvrir son propre point d'accès Wi-Fi (plus tard).

## Ordre de travail

Fait le 2026-10-20 : BLE MIDI du Pi (WIDI appairé), `es8core.stage` et sa
parité avec `show.js`, `es8ctl web --stage`, mode écran de la Companion,
service systemd, point d'accès.

1. **Pont MIDI** + choix automatique dans `engine.js` + verrou de scène :
   le Designer et Control retrouvent l'ES-8 depuis n'importe quel écran.
2. **Bibliothèque** : projets du Designer et shows gardés sur le Pi.
3. **Page de l'hôte** : bibliothèque, système.
4. **Réseau** : bascule réseau connu / point d'accès, réglages et garde-fou.
5. Lecture seule, mise à jour du programme depuis la page.

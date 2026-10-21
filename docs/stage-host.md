# Hôte de scène : la Companion sur un Raspberry Pi

Le Pi tient la Companion pendant le concert, seul, sans écran : il avance
dans la setlist, traduit les appuis sur les switches de l'ES-8 et envoie les
messages aux machines. Les tablettes et téléphones du réseau n'en sont que
des écrans (et des télécommandes). Rôles : `docs/companion.md`.

Statut : décidé et codé le 2026-10-20 (`es8stage.stage`, `es8stage/server/stage_server.py`). Pi installé (`pedalbrain`, Raspberry Pi 3
Model B, Raspberry Pi OS Lite 64 bits « Trixie », sans GUI, utilisateur
`es8`, SSH par clé). Liaison avec l'ES-8 : le WIDI Jack en Bluetooth (BLE
MIDI de BlueZ) pour l'instant ; une interface USB-MIDI filaire plus tard.

## Installation et mise à jour

Depuis le Mac (version commitée, sous-module `es8` compris) :

```sh
deploy/pi/push.sh es8@pedalbrain.local --midi WIDI --ble 20:98:66:65:EA:44
```

Sur le Pi, `deploy/pi/install.sh` installe es8core, es8ctl et es8stage dans `~/venv`
(paquets système `python3-mido`, `python3-rtmidi`), reprend les données de l'ancien
service (`~/.local/share/es8ctl` → `es8stage`) et lance le service `es8-stage`
(`deploy/pi/es8-stage.service`, arguments dans `/etc/default/es8-stage`).

## Avec l'éditeur

ES8 Stage s'appuie sur l'éditeur (dépôt `es8`, sous-module `es8/`) sans le modifier :
le serveur sert ES8 Control et le moteur web (`/control/`, `/shared/`) à côté de ses
applis, et branche le moteur par ses points d'extension (`globalThis.ES8_ENGINE`,
`web/stage-shared/bridge.js`) : module Python `es8stage.webapp` (l'éditeur plus les rigs),
archive `engine.zip` (es8core + es8stage), et transport MIDI de l'hôte de scène. ES8
Control servi par l'hôte reçoit `stage-shared/control.js` (encart du mode édition).

## Principe

```
ES-8 ──BLE MIDI (WIDI)──▶ Pi : es8stage serve ──BLE MIDI──▶ ES-8 (Thru) ──▶ machines
                               │  (logique, état, show)
                               └──HTTP + WebSocket──▶ Companion dans un navigateur (affichage, télécommande)
```

- **Le Pi est la seule Companion qui parle à l'ES-8.** Les navigateurs ne
  touchent pas au MIDI : ils affichent l'état que le Pi leur pousse et lui
  envoient les gestes (toucher un pavé, Next à l'écran, changer de setlist).
- Le Pi joue même si aucun écran n'est ouvert, et reprend sa position après
  un redémarrage (sans rien envoyer, comme la Companion).

## Le service `es8stage serve --stage`

- Commande de la CLI, service systemd au démarrage du Pi.
- **Logique** : `es8stage.stage`, en Python, la même que `web/companion/show.js`
  (déplacements, switches, groupes, crans, secours, messages de pas). Les deux
  sont vérifiées sur les mêmes cas (tests), pour qu'elles ne divergent pas.
- **MIDI** : `mido` + `python-rtmidi` (ALSA). Port choisi par son nom
  (« WIDI » par défaut), rouvert tout seul s'il disparaît (Bluetooth).
- **Show** : un fichier sur le Pi (`~/.local/share/es8stage/show.json`),
  remplacé par un envoi depuis le Designer ou la page de l'hôte ; la
  position et l'état sont gardés à côté.
- **HTTP** (`es8stage serve --stage --midi WIDI [--ble <adresse>]`, `es8stage/server/http.py`), bibliothèque
  standard seulement :
  - `GET /stage/state` : l'état (show, pos, states, backup, traffic, move,
    midi, edit, job, check) ; `GET /stage/events` : le même, poussé à chaque changement
    (Server-Sent Events) ;
  - `POST /stage/act` : `{"type": "act", action}`, `{"type": "press", key,
    down}`, `{"type": "goto", setlist, step}`, `{"type": "resend"}`,
    `{"type": "edit", on}`, `{"type": "check"}` ;
  - `POST /stage/show.json` : nouveau show, rechargé aussitôt.
- **La Companion web** est l'écran de l'hôte (aucun MIDI dans le navigateur,
  d'où le fonctionnement en HTTP simple) ; sans hôte de scène, elle le dit.

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
  demande que la Companion soit en pause (« Edit mode ») ; les lectures
  restent permises. Le mode édition se voit sur la Companion (bandeau,
  « Resume the show ») et **se coupe seul après 10 minutes** sans message
  d'un éditeur vers l'ES-8 (`EDIT_IDLE_S`) : un mode oublié ne laisse pas les
  switches sans effet pendant le concert. Designer et Control suivent l'état
  de l'hôte en direct (`/stage/events`).

### Bibliothèque de sets

Sur le Pi (`~/.local/share/es8stage/library/`) :

- **Projets** (`*.es8project.json`) : le Designer ouvre et enregistre sur le
  Pi au lieu du stockage du navigateur ; le même projet sur Mac et iPad.
- **Shows** : celui joué par la Companion se choisit dans la liste ; le
  bouton Show du Designer en ajoute un.
- **Sauvegardes de l'ES-8** (dumps `.syx`), avec « restaurer ».
- Actions : choisir le show joué, ouvrir, dupliquer, renommer, supprimer,
  importer, télécharger (copie sur le Mac).
- HTTP (`es8stage/server/library.py`, servi par tout `es8stage serve`, pas seulement
  `--stage`) : `GET /library/` (la liste et le show joué) ;
  `GET|PUT|DELETE /library/<projects|shows|backups>/<nom>` (`?download` :
  en pièce jointe ; `PUT …?new` : refusé si le nom existe) ;
  `POST /library/<sorte>/<nom>` `{op: rename, to}`, `{op: duplicate}`,
  `{op: play}` (shows : copié dans `show.json`, noté dans `playing.json`).
- Designer : « Library… » dans le menu ; un projet ouvert depuis la
  bibliothèque y est enregistré à chaque changement (0,8 s après), et repris
  en revenant sur la page s'il a changé ailleurs (le dernier qui écrit gagne).
  Le bouton Show range le show sous le nom du projet et le joue. Companion :
  « Shows in the library » dans les réglages, avec Play.

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

Fait (`web/host/`, `es8stage/server/host_auth.py`) :

- **Mot de passe** : tant qu'il n'y en a pas, la page est ouverte et propose
  d'en choisir un. Gardé haché (PBKDF2) dans `host-auth.json` (600) ;
  session = cookie signé `es8host` (30 jours, survit aux redémarrages ;
  changer le mot de passe ferme les sessions). Exigé pour : les actions de la
  page et la suppression dans la bibliothèque (le Designer renvoie à `/host/`).
- `GET /host/api/status` ; `POST /host/api/` `login`, `logout`, `password`,
  `edit {on}`, `reconnect`, `backup {name?}`, `restore {name}`, `restart`,
  `reboot`, `poweroff` (`sudo -n systemctl …`, 0,7 s après la réponse).
- **Sauvegarde de l'ES-8** par le port de l'hôte : lecture de tout l'ES-8
  (8 pages système + 800 patchs), permise pendant que la scène joue ; le pont
  des éditeurs attend la fin.
- **Restauration** : demande le mode édition (qui reste forcé jusqu'à la fin) ;
  relit l'ES-8 et garde cet état en sauvegarde « Before restore … », n'écrit
  que les pages qui diffèrent, puis les relit et renvoie (comme le Designer).
- Pas sur le site statique (`build-web` l'omet).

## Façade, préparation, vérification (2026-10-21)

- **La Companion est la façade** : `/` l'ouvre ; son menu mène aux shows de
  la bibliothèque, à l'état de l'ES-8, au mode édition, au Designer, à
  Control et à la page de l'hôte (sauvegardes, système, mot de passe).
- **« Send to stage »** (Designer, sur un hôte) : un seul geste. Relit sur
  l'ES-8 le système et les patchs des rigs du projet, compile, écrit ce qui
  diffère en mode édition (pages relues jusqu'à vérification), range le show
  dans la bibliothèque sous le nom du projet et le joue, puis coupe le mode
  édition. Si une page n'est pas vérifiée, le show n'est pas changé.
- **Vérification de la setlist** (`StageServer.check`, lecture seule) : l'hôte
  lit les 8 pages système (quelques secondes) et compare, pour chaque
  setlist jouable, l'empreinte de la `pc_map` de sa banque MIDI avec
  `pc_map` du show, et le canal de réception de l'ES-8 avec celui du show.
  Lancée seule quand l'ES-8 se branche, quand un autre show est joué et à la
  fin du mode édition (jamais pendant) ; « Check now » dans le menu. Le
  résultat (`check` de l'état : `ok`, `mismatch`, `checking`, `error`,
  `unknown`) vaut pour le show et le canal vérifiés. Vérifié sur l'ES-8 le
  2026-10-21 (PULSE, canal 15).
- **Bluetooth** : c'est le lien de scène, il doit marcher seul. Un
  adaptateur BLE MIDI ne parle qu'à un appareil à la fois : constaté le
  2026-10-21, dès que le Pi lâche le WIDI (redémarrage du Bluetooth ou du
  Pi), le Mac qui l'a appairé le reprend, et le WIDI ne s'annonce plus pour
  le Pi. D'où l'ancien « il faut rallumer le WIDI après un redémarrage ».
  L'hôte balaie donc d'abord (6 s) et ne tente la connexion que si
  l'adaptateur s'annonce ; sinon l'état le dit (`midi.ble_seen = false`) et
  les écrans conseillent de le libérer sur l'autre appareil. **Un Mac qui
  passe par le Pi doit oublier le WIDI** dans ses réglages Bluetooth.
  Seconde cause, vérifiée le même jour : une coupure brutale (BlueZ qui
  s'arrête éteint la radio, comme à chaque redémarrage du Pi) laisse le WIDI
  muet jusqu'à ce qu'on le rallume ; une déconnexion propre, non (il se
  réannonce, le Pi le reprend en 11 s). Le service lâche donc le WIDI
  proprement en s'arrêtant (`StageServer.stop`, SIGTERM, unité après
  `bluetooth.service`). Essai : redémarrage complet du Pi, WIDI reconnecté
  3 s après le démarrage du service, setlist vérifiée, sans toucher au WIDI.

## Le Pi comme une pédale

1. Démarrage automatique du service ; reconnexion du WIDI.
2. Système en lecture seule (overlayfs) une fois réglé : on peut couper le
   courant n'importe quand. Le show et la position vivent dans une petite
   zone inscriptible (ou sont réécrits à chaque changement de show).
3. Accès : SSH par clé (utilisateur `es8`) ; `pedalbrain.local` sur le réseau.
4. Écran : n'importe quel navigateur du réseau sur `http://pedalbrain.local/` (port 80).
   Sur scène, le Pi peut ouvrir son propre point d'accès Wi-Fi (plus tard).

## Ordre de travail

Fait le 2026-10-20 : BLE MIDI du Pi (WIDI appairé), `es8stage.stage` et sa
parité avec `show.js`, `es8stage serve --stage`, mode écran de la Companion,
service systemd, point d'accès.

1. ✅ **Pont MIDI** + choix automatique dans `engine.js` + verrou de scène
   (2026-10-20 : ES8 Control ouvert sur le Mac depuis `pedalbrain.local` lit
   l'ES-8 par le Pi en 19 s ; une écriture hors mode édition rend 423).
2. ✅ **Bibliothèque** : projets du Designer et shows gardés sur le Pi
   (2026-10-20 ; sauvegardes `.syx` : rangement et téléchargement seulement,
   « restaurer » viendra avec la page de l'hôte).
3. ✅ **Page de l'hôte** : bibliothèque, système, sauvegarde et restauration
   de l'ES-8, mot de passe (2026-10-20).
4. ✅ **Façade** (2026-10-21) : Companion à la racine, Send to stage,
   vérification de la setlist, mode édition visible et limité, Bluetooth
   tenu ailleurs signalé.
5. **Réseau** : bascule réseau connu / point d'accès, réglages et garde-fou.
6. Lecture seule, mise à jour du programme depuis la page.

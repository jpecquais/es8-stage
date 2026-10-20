# ES8 Companion : l'app de scène

Une app web légère, sur téléphone ou tablette, qui joue une setlist pendant
le concert. Elle reçoit les appuis d'un contrôleur (n'importe lequel),
envoie à l'ES-8 le Program Change du pas voulu, et affiche où on en est :
morceau, pas précédent, en cours et suivant, surface de l'ES-8.

Statut : v1 codée le 2026-10-19 (`web/companion/`, `es8ctl rig show`), pas
encore essayée avec l'ES-8. Maquette d'interface :
https://claude.ai/artifact/2FnJ4veQqMf1vMe9f19kWM. Modèle sur lequel elle
s'appuie : `docs/rig-model.md` (rigs, tracks, setlists, `pc_map`).

## Frontières

| | ES8 Designer | ES8 Companion | ES-8 |
|---|---|---|---|
| Édite pedalboard, rigs, tracks, setlists | oui | non | — |
| Compile et écrit (SysEx) | oui | **non** | stocke les banques et la `pc_map` |
| Pyodide, moteur `es8core` | oui | **non** | — |
| Navigation pendant le concert | — | PC *i* = pas *i* | `pc_map` : PC *i* → patch |

Décisions actées :

- La setlist reste compilée dans la `pc_map` de l'ES-8 (`rig-model.md`). La
  Companion n'est qu'une source de PC parmi d'autres : un contrôleur qui
  compte ses PC joue la même setlist sans elle.
- Facultative : si la tablette lâche, on choisit les patchs sur l'ES-8.
  Aucun système de secours.
- Générique : aucun contrôleur, adaptateur ou appareil n'est privilégié.
  L'ES-8 utilisé comme contrôleur n'est qu'un préréglage d'entrée.
- La Companion ne calcule rien : elle lit un fichier **show** exporté par
  la lib Python et joue sa liste de pas.
- Elle n'affiche aucun état en direct (switches ou loops ON/OFF) : la
  surface est un aide-mémoire de disposition, pas un retour d'état.
- Interface en anglais.

## Flux

```
contrôleur ──(CC, note, touche, écran)──▶ Companion ──PC i──▶ ES-8
(ES-8, pédalier MIDI, pédale BT…)            │              (pc_map → patch)
                                             └─ affichage
Designer / es8ctl ──show.json──▶ Companion   (avant le concert)
```

## Le fichier show (`es8ctl.show/1`)

Calculé par `es8core` (`export_show(project)`), jamais par la Companion.
Autonome : pas de chemin ni de référence à résoudre.

```json
{
  "schema": "es8ctl.show/1",
  "exported": "2026-10-19T12:00:00Z",
  "es8": {"rx_channel": 1},
  "setlists": [
    {
      "id": "november",
      "name": "November show",
      "midi_bank": 0,
      "pc_map": "sha256:3f1a…",
      "songs": [
        {"name": "Opening", "rig": "ambient", "first_step": 0, "steps": 2},
        {"name": "White Night", "rig": "crunch", "first_step": 2, "steps": 6}
      ],
      "steps": [
        {"song": 0, "snapshot": "Intro", "patch": 88, "label": "11-1"},
        {"song": 0, "snapshot": "Swell", "patch": 89, "label": "11-2"},
        {"song": 1, "snapshot": "Verse", "patch": 96, "label": "12-1",
         "backup": {"rig": "GP50 backup", "snapshot": "Crunch", "pc": 127, "label": "40-1"}}
      ]
    }
  ],
  "rigs": {
    "crunch": {
      "name": "Crunch Lead",
      "patches": ["12-1", "12-2", "12-3", "12-4"],
      "snapshots": ["Verse", "Chorus", "Bridge", "Solo"],
      "surface": {
        "name": "Lead 4 + 4",
        "switches": {
          "NUM1": {"label": "Drive", "role": "param", "mode": "toggle", "target": "DAW · Drive"},
          "NUM5": {"label": "Overdrive", "role": "loop", "target": "L2"},
          "NUM8": {"label": "Tap", "role": "tap"}
        }
      },
      "chain": [{"loop": "L2", "device": "Overdrive"}, {"loop": "L5", "device": "Modulation"}],
      "programs": [{"device": "DAW", "program": "Crunch Lead", "pc": 12}],
      "snapshot_programs": {"Solo": [{"device": "DAW", "program": "PC 40", "pc": 40}]}
    }
  },
  "input_preset": {
    "source": "surface Lead 4 + 4",
    "bindings": [
      {"action": "next", "type": "cc", "channel": 16, "number": 80},
      {"action": "prev", "type": "cc", "channel": 16, "number": 81}
    ]
  }
}
```

- **Pas *i* = PC *i*** : l'index dans `steps` est le Program Change à
  envoyer. `steps` est produit par la même fonction que `compile_setlist`
  (voir « Côté modèle ») : le show et la `pc_map` ne peuvent pas diverger.
- `pc_map` : empreinte des 128 entrées compilées de la banque MIDI. La
  Companion l'affiche ; `es8ctl rig status` et Designer peuvent la comparer
  à l'ES-8. La Companion ne lit pas l'ES-8 (pas de SysEx).
- Un show porte toutes les setlists du projet ; il ne contient que ce que
  la Companion affiche.
- `songs[].name` : nom du track ; un morceau écrit sur place dans la
  setlist prend son `name` s'il en a un, sinon le nom du rig.
- `input_preset` : facultatif (voir « L'ES-8 comme contrôleur »).
- `steps[].backup` : facultatif. Le patch de secours du pas et son PC dans
  la même banque MIDI (en haut de la `pc_map`). L'action `backup` de la
  Companion (bouton, switch) bascule : chaque pas envoie alors le PC de son
  secours, jusqu'au prochain appui ; un pas sans secours garde son son.
- `rigs[].patches` : le patch de chaque snapshot (un rig occupe des patchs
  consécutifs, sur plusieurs banques au besoin). `snapshot_programs` :
  seulement les snapshots qui chargent d'autres programmes que le rig.

## Entrée

Trois sources, actives ensemble : un port MIDI d'entrée (choisi par
l'utilisateur, indépendant de la sortie), le clavier (pédales Bluetooth
tourne-page, qui se présentent comme un clavier), l'écran.

**Actions** :

| Action | Effet |
|---|---|
| `next` | pas suivant, en passant au morceau suivant si besoin |
| `prev` | pas précédent, idem en arrière |
| `next_song` | premier pas du morceau suivant |
| `prev_song` | premier pas du morceau précédent |
| `song_start` | premier pas du morceau en cours |
| `backup` | bascule le mode secours : chaque pas envoie le PC de son patch de secours, ou revient au son normal |

L'écran ajoute « aller à » : un morceau dans la liste (son premier pas),
ou un pas dans la vue Setlists.

**Table d'entrée** : une liste de `{action, type, channel, number}` avec
`type` = `cc` | `note` | `key` (pour `key`, `number` est remplacé par le nom
de la touche). Règles :

- Déclenche à l'appui : CC de valeur > 0, note-on de vélocité > 0, touche
  enfoncée. Le relâchement (CC 0, note-off) est ignoré, donc un switch en
  mode toggle (127 puis 0) ne déclenche qu'un appui sur deux : il faut un
  switch momentané.
- Un message n'a qu'une action ; l'apprendre pour une autre le retire de la
  première.
- Apprentissage : le premier message reçu (hors PC, horloge, active sensing,
  SysEx) devient le message de l'action.
- Les PC reçus ne sont jamais des entrées : ce sont ceux que la Companion
  envoie (écho par un ES-8 en Thru, ou boucle).
- Anti-rebond : un même message reçu deux fois en moins de 120 ms ne
  compte qu'une fois.
- La table est stockée sur l'appareil. Le préréglage du show la remplit au
  premier chargement ; « Restore preset » y revient.

## Sortie

- PC *i* sur le canal de réception de l'ES-8 (`es8.rx_channel`, modifiable
  dans les réglages).
- Aux bouts de la setlist, `next` et `prev` ne font rien (rien n'est
  envoyé).
- Après un rechargement de l'app, la position est restaurée **sans rien
  envoyer**. Toucher la carte « Now » renvoie le PC du pas en cours (utile
  après un redémarrage de l'ES-8).
- Chaque pas part en deux messages : Bank Select CC0 = banque MIDI de la
  setlist, puis PC *i*. Toutes les setlists se jouent (CC0 vérifié sur
  l'ES-8 ; CC32 est ignoré). Le CC0 est renvoyé à chaque pas : un autre
  contrôleur a pu changer de banque entre-temps.

## L'ES-8 comme contrôleur (préréglage)

Pour piloter la Companion avec les switches de l'ES-8 :

- Dans la surface, un switch au rôle `companion` avec son action
  (`{"role": "companion", "action": "next"}`). La Companion n'est pas un
  appareil du pedalboard : elle ne fait que recevoir ces CC.
- Le projet fixe le canal et le CC de chaque action (`"companion":
  {"channel": 16, "cc": {"next": 80, …}}`, ces valeurs par défaut) ; le
  canal ne peut être celui d'aucun appareil MIDI.
- Le switch devient un assign momentané. Sur BANK ▲▼, MEM/MAN ou MUTE, sa
  fonction propre est coupée (`ctl_func` OFF) : seule la Companion change
  de patch.
- `export_show` en tire `input_preset` : rien à apprendre pour cet usage.
- Format ancien, encore lu : un appareil MIDI `"companion": true` dont les
  paramètres portent le nom des actions. Le Designer le convertit à
  l'ouverture (aussi un appareil nommé « … Companion » déclaré à la main).

Ce préréglage dépend du test H5 (quels switches envoient un CC en mode
patch) ; la v1 n'en a pas besoin : l'apprentissage couvre tous les
contrôleurs.

## Écrans

Voir la maquette.

- **Stage** (tablette, téléphone vertical, téléphone horizontal) : morceau
  (le titre ouvre la liste des morceaux), déroulé du morceau, cartes
  Previous / Now / Next, gros boutons Previous / Next. Sur tablette, un
  panneau repliable : morceau suivant, switches de l'ES-8 (vue Manual par
  défaut : la surface ; vue Patch : les snapshots de la banque), ordre de la
  chaîne, programmes chargés.
- **Setlists** : onglets par setlist, morceaux et pas (toucher = y aller),
  show chargé.
- **Settings** : sortie (port, canal), entrée (port, clavier), table
  d'actions avec apprentissage, écran (rester allumé, vue des switches par
  défaut).

## Technique

- `web/companion/`, site statique, servi avec les autres apps (même
  origine). Pas de Pyodide, pas d'`engine.js` ; peut reprendre Preact de
  `web/shared/vendor`.
- Web MIDI **sans** SysEx (`requestMIDIAccess({sysex: false})`) : demande
  de permission plus légère.
- Transport isolé derrière une petite interface (`ports()`, `open(in,
  out)`, `send(bytes)`, `onMessage`, `onPortsChange`) : Web MIDI d'abord ;
  un pont natif iOS plus tard sans toucher au reste.
- PWA : manifeste, service worker (fonctionne hors ligne), Screen Wake Lock.
- Stockage local (`localStorage`) : show chargé, position, ports, table
  d'entrée, préférences d'affichage.
- Charger un show : sélecteur de fichier ; ou, sur le même appareil,
  Designer le dépose pour la Companion (même origine).
- Plateformes v1 : navigateurs Chromium (Android, ordinateur). iOS (Safari
  n'a pas Web MIDI) : en attendant, un navigateur Web MIDI de l'App Store
  (MIDIWeb Browser, Web MIDI Browser) ; plus tard, une coquille native fine.
- Essai sur tablette ou téléphone : `es8ctl web --lan` sert aussi sur le
  réseau local et affiche l'adresse. En HTTP simple, ni hors ligne ni
  Wake Lock (contexte non sécurisé) ; pour la scène, le site en HTTPS.

## Côté modèle (`es8core`)

Fait le 2026-10-19 :

1. `setlist_steps(project, setlist, path)` : la mise à plat des pas, seule
   source pour `compile_setlist` (la `pc_map`) et `export_show`.
2. `export_show(project) -> dict` (`es8core/model/show.py`) et la commande
   `es8ctl rig show <setup|projet> -o show.json`. L'id d'un rig est son id
   dans un document projet, sinon le nom de son fichier ; l'id d'une
   setlist, le nom de son fichier, sinon son nom simplifié.
3. Pedalboard : `midi.companion: true` sur un appareil ; ses paramètres
   doivent être des noms d'action (refus sinon).
4. Setlist : `name` facultatif sur un morceau écrit sur place.

5. ES8 Designer : bouton « Show » (pont web `show_export`). Il télécharge
   le show et le dépose pour la Companion ouverte dans le même navigateur
   (clé `es8companion/incoming`), qui l'ouvre seule.
`es8.rx_channel` vaut 1 dans l'export (le projet ne connaît pas le canal de
l'ES-8) ; la Companion le laisse changer.

## Tests matériel

Faits le 2026-10-19 sans intervention humaine, avec deux rigs « sonde »
(banques 97 et 98) dont chaque snapshot envoie CC100 = un numéro propre ;
l'écoute de la sortie MIDI de l'ES-8 dit quel patch s'est chargé. Liste
complète, toutes apps : `docs/hardware-tests.md`.

| | Question | Résultat |
|---|---|---|
| H1 | Un PC reçu en mode patch rappelle-t-il le patch de la `pc_map` ? | **oui**, les 6 pas dans l'ordre, répétitions comprises |
| H1b | Un PC au-delà du dernier pas ? | reste sur le dernier pas (entrées répétées) |
| H2 | Bank Select choisit-il la banque MIDI ? | **CC0 oui**, CC32 ignoré |
| H3 | Un PC reçu en mode manuel est-il suivi ? | à voir (il faut passer en manuel au panneau) |
| H4 | Écho des PC en Thru ? | oui, tout ce qui entre ressort (même canal 2) ; rien en Out. Les messages des patchs sortent dans les deux modes |
| H4b | Ce que l'ES-8 émet au changement de patch | seulement les messages MIDI du patch ; rien qui donne son numéro. Le protocole de l'éditeur sait lire le patch en cours (SysEx) : piste pour un recalage |
| H4c | Le même PC renvoyé pour le patch déjà chargé | rien ne ressort (l'ES-8 ne recharge pas) ; « Now » ne sert donc qu'après un redémarrage ou un autre patch |
| H5 | Quels switches envoient un CC en mode patch ? | à voir (il faut appuyer) ; rigs sonde en place : NUM1, CTL IN 1/2 |
| H6 | Le WIDI accepte-t-il deux appareils à la fois ? | à voir |

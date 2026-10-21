# ES8 Companion : la façade de scène

Pendant le concert, l'hôte de scène (`es8stage serve --stage`, le Raspberry
Pi) avance dans la setlist et traduit les appuis sur les switches de l'ES-8
en messages pour les machines (Ableton, Valeton, Quimera…). ES8 Companion
est son écran, sur une tablette ou un téléphone : où on en est, l'état de
chaque switch, et la porte vers tout le reste (shows, état de l'ES-8,
préparation). Hôte de scène : `docs/stage-host.md`.

Statut : v1 (navigation) vérifiée sur l'ES-8 le 2026-10-19 ; v2 (logique
des switches) le 2026-10-20. **Depuis le 2026-10-21, la Companion n'est plus
que l'écran de l'hôte** : plus de MIDI dans le navigateur, la logique de jeu
n'existe plus qu'en Python (`es8stage.stage`). Pour répéter sans Pi :
`es8stage serve --stage` sur l'ordinateur. Modèle : `docs/rig-model.md`.
Essais matériel : `docs/hardware-tests.md`.

## Partage des rôles (décidé le 2026-10-20)

L'ES-8 ne sait pas servir de pédalier MIDI seul : aucun MIDI en mode
manuel, LED non pilotables, bascules remises à zéro à chaque patch, 12
assignations par patch. La règle :

| Ce qui… | Qui | Comment |
|---|---|---|
| doit être juste **à l'arrivée sur un snapshot** : boucles, programmes, état de départ des paramètres | **ES-8** | messages MIDI du patch, envoyés au rappel ; restent justes si la Companion tombe (rappel au panneau) |
| se passe **pendant le morceau** : avancer, bascules, crans, secours | **Companion** | reçoit les appuis, tient l'état, envoie aux machines, affiche |
| les **switches** | ES-8 | de simples boutons : un CC fixe par switch vers la Companion |

Décisions :

- **La Companion est indispensable pour jouer** (navigation et gestes). Sans
  elle, chaque snapshot reste rappelable au panneau de l'ES-8, avec le bon
  son ; c'est le seul filet, assumé.
- La setlist reste compilée dans la `pc_map` de l'ES-8 (PC *i* = pas *i*).
- Le Designer reste le seul endroit où l'on édite : il range lui-même
  l'état des snapshots dans l'ES-8 et la logique des switches dans le show.
- La Companion ne calcule rien de musical : elle lit le **show** exporté par
  la lib Python.
- Interface en anglais.

## Flux

```
switch de l'ES-8 ──CC (canal Companion, 1 CC par switch)──▶ Companion
Companion ──CC0 + PC i──▶ ES-8 MIDI IN ──(pc_map)──▶ patch : boucles + messages du patch
Companion ──CC des gestes──▶ ES-8 MIDI IN ──Thru──▶ ES-8 MIDI OUT ──▶ machines
Designer ──show.json──▶ Companion   (avant le concert)
```

- Une seule sortie MIDI pour la Companion : la prise MIDI IN de l'ES-8. La
  prise MIDI OUT de l'ES-8 est en **Thru** (réglage écrit par le Designer
  dès qu'une surface passe par la Companion) : elle recopie ce qu'elle
  reçoit et ajoute les messages des patchs (vérifié, D8).
- Le PC *i* sur le canal de l'ES-8 et la Bank Select ressortent aussi en
  Thru : les machines doivent écouter d'autres canaux.

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
          "NUM1": {"label": "Drive", "role": "param", "mode": "toggle", "target": "DAW · Drive",
                   "channel": 1, "cc": 18, "on": 127, "off": 0, "param": "daw.drive"},
          "BANK_U": {"label": "Next", "role": "companion", "target": "next"},
          "NUM5": {"label": "Overdrive", "role": "loop", "target": "L2"},
          "NUM8": {"label": "Tap", "role": "tap"}
        }
      },
      "states": {"Verse": {"daw.drive": 0}, "Solo": {"daw.drive": 127}},
      "chain": [{"loop": "L2", "device": "Overdrive"}, {"loop": "L5", "device": "Modulation"}],
      "programs": [{"device": "DAW", "program": "Crunch Lead", "pc": 12}],
      "snapshot_programs": {"Solo": [{"device": "DAW", "program": "PC 40", "pc": 40}]}
    }
  },
  "controls": {"channel": 16, "switches": {"NUM1": 80, "BANK_U": 91}},
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
  Companion l'affiche ; `es8stage rig status` et Designer peuvent la comparer
  à l'ES-8. La Companion ne lit pas l'ES-8 (pas de SysEx).
- Un show porte toutes les setlists du projet ; il ne contient que ce que
  la Companion affiche.
- `songs[].name` : nom du track ; un morceau écrit sur place dans la
  setlist prend son `name` s'il en a un, sinon le nom du rig.
- `input_preset` : facultatif ; les actions `companion` des surfaces, pour
  les autres sources d'entrée (voir « Entrée »).
- `controls` : canal et CC de chaque switch de l'ES-8 (voir « Les switches
  de l'ES-8 »).
- `rigs[].surface.switches` : pour un `param`, l'appareil, son canal, son CC,
  ses valeurs `on`/`off` et son mode ; `rigs[].states` : l'état de départ de
  chaque paramètre de la surface, par snapshot.
- `steps[].backup` : facultatif. Le patch de secours du pas et son PC dans
  la même banque MIDI (en haut de la `pc_map`). L'action `backup` de la
  Companion (bouton, switch) bascule : chaque pas envoie alors le PC de son
  secours, jusqu'au prochain appui ; un pas sans secours garde son son.
- `rigs[].patches` : le patch de chaque snapshot (un rig occupe des patchs
  consécutifs, sur plusieurs banques au besoin). `snapshot_programs` :
  seulement les snapshots qui chargent d'autres programmes que le rig.

## Entrée

Trois sources : les switches de l'ES-8 (reçus par l'hôte, voir plus bas),
l'écran, et le clavier de l'écran (pédales Bluetooth tourne-page, qui se
présentent comme un clavier). L'écran et le clavier envoient leurs gestes à
l'hôte (`POST /stage/act`).

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

**Touches** : une liste de `{action, type: "key", key}`, gardée sur chaque
écran ; par défaut → et Page Down pour `next`, ← et Page Up pour `prev`.
Déclenche à l'appui ; une touche n'a qu'une action (l'apprendre pour une
autre la retire de la première). L'ancien préréglage d'entrée MIDI du show
(`input_preset`) n'est plus lu.

## Sortie

Par l'hôte (`es8stage.stage`) :

- PC *i* sur le canal de réception de l'ES-8 (`es8.rx_channel`), précédé de
  Bank Select CC0 = banque MIDI de la setlist (vérifié ; CC32 ignoré). Le
  CC0 est renvoyé à chaque pas.
- Aux bouts de la setlist, `next` et `prev` ne font rien.
- Après un redémarrage, la position est restaurée **sans rien envoyer**.
  Toucher « Now » renvoie le PC du pas en cours.
- Gestes : le CC du paramètre sur le canal de son appareil, par la même
  sortie (l'ES-8 le recopie en Thru).

## Les switches de l'ES-8 (v2)

Dans le Designer, une surface donne un rôle à chaque switch. Deux familles :

| Rôle | Tenu par | Sur l'ES-8 |
|---|---|---|
| `param` (bascule ou momentané d'un paramètre MIDI) | Companion | assignation momentanée : CC du switch vers la Companion |
| `companion` (next, prev, next_song, prev_song, song_start, backup) | Companion | idem |
| `loop`, `tap`, `es8` | ES-8 (natif) | inchangé |

- **Un CC fixe par switch**, pas par action : canal `companion.channel`
  (16 par défaut), CC = `companion.first_cc` (80) + rang du switch
  (NUM1…NUM8, MEM/MAN, MUTE, BANK ▼, BANK ▲, CTL IN 1–4 → 80…95). Le même
  switch peut donc faire autre chose dans un autre rig : c'est la Companion
  qui lit son rôle dans le rig en cours.
- L'assignation est momentanée : 127 à l'appui, 0 au relâchement (il faut
  le relâchement pour un paramètre momentané). 1 assignation par switch :
  12 switches au plus par patch.
- La fonction propre du switch est coupée (`ctl_func` OFF) : il ne rappelle
  plus de patch, ne change plus de banque. Mode memory (en manuel, l'ES-8
  n'envoie aucun MIDI).
- Le canal de la Companion ne peut être celui d'aucun appareil MIDI.
- Format ancien (un CC par action, ou un appareil `companion`) : relu et
  converti.

**Ce que fait la Companion d'un appui** (rig du pas en cours) :

- `companion` : l'action (avancer, secours…).
- `param` en bascule : l'état du paramètre passe de off à on (ou l'inverse),
  la Companion envoie `on`/`off` de ce paramètre sur le canal de son
  appareil. Momentané : `on` à l'appui, `off` au relâchement.
- **Groupe** (`group` sur le switch) : allumer un switch du groupe éteint
  les autres switches allumés du même groupe (leur CC off part aussi).
- **Cran** (`value` sur le switch) : plusieurs switches sur un même
  paramètre, chacun avec sa valeur « on » (ex. snapshots du Helix par une
  macro : OD = 24, Big Muff = 40). Le switch est allumé quand le paramètre
  vaut exactement sa valeur ; appuyer choisit ce cran, réappuyer sur le cran
  actif renvoie le off du paramètre (Clean). Crans et groupe se combinent.
- À chaque changement de pas, l'état repart de celui du snapshot (les
  messages du patch ont déjà envoyé ces valeurs).
- Le panneau affiche l'état de chaque switch (allumé / éteint), à la place
  des LED de l'ES-8.

## Écrans

`/` (la racine de l'hôte) ouvre la Companion.

- **Stage** : morceau (le titre ouvre la liste des morceaux), déroulé, cartes
  Previous / Now / Next, gros boutons. Panneau : morceau suivant, **switches
  de l'ES-8 avec leur état** (allumé / éteint) et leur nom dans ce rig, ordre
  de la chaîne, programmes.
- **Switches** (même place que Stage, au choix dans la barre : « Setlist » /
  « Switches ») : la surface de l'ES-8 en grand, dans sa disposition (rangée
  du haut, puis NUM1–6 ; CTL IN à part), chaque switch avec son nom dans le
  rig et allumé quand son paramètre est on. Bandeau : morceau (ouvre la
  liste), son en cours, suivant. Toucher un pavé = l'appui du pied
  (momentané : tant qu'on le tient).
- **Setlists** : onglets par setlist, morceaux et pas (toucher = y aller).
- **Barre** : puce de l'ES-8 (non connecté, mode édition, vérifié, diffère),
  secours, menu.
- **Bandeaux** sous la barre : hôte injoignable ; **mode édition** (les
  switches sont en pause, bouton « Resume the show ») ; ES-8 non connecté
  (et, si l'adaptateur Bluetooth ne s'annonce pas, qu'un autre appareil le
  tient sans doute) ; ES-8 qui ne correspond pas au show.
- **Menu** : le show joué et ceux de la bibliothèque (Play) ; l'ES-8
  (connexion, vérification de la setlist, « Check now », mode édition) ;
  touches des pédales tourne-page ; écran allumé.
- **Bandeau commun** (`web/stage-shared/nav.js`) : la même barre en haut de
  chaque page servie par l'hôte (Companion · Designer · Control · Stage host,
  l'appli en cours en surbrillance, l'état de l'ES-8 à droite, qui ouvre le
  menu de la Companion). Absent quand la page n'est pas servie par un hôte de
  scène ; caché sur les écrans de scène de la Companion.

## Technique

- `web/companion/`, Preact sans compilation. Pas de Pyodide, pas de MIDI.
- État de l'hôte : `GET /stage/state` à l'ouverture, puis `GET /stage/events`
  (Server-Sent Events, reconnexion automatique). Sans hôte de scène, la page
  le dit et réessaie.
- Écran allumé : Screen Wake Lock là où il existe (https, localhost) ; sinon
  (l'iPad sur `http://pedalbrain.local`), une vidéo de 4 s sans image ni son
  jouée en boucle (`keepawake.mp4`), lancée au premier toucher. Le menu
  conseille aussi le réglage de verrouillage automatique de l'iPad.
- `localStorage` : préférences et touches de cet écran seulement.
- Méta « web app » : ajoutée à l'écran d'accueil de l'iPad, la Companion
  s'ouvre en plein écran.
- **Bluetooth sur scène : oui.** Le WIDI (BLE MIDI) est le lien normal avec
  l'ES-8 ; une interface USB-MIDI filaire reste possible (`--midi`).

## Côté modèle (`es8core`)

Fait le 2026-10-19 :

1. `setlist_steps(project, setlist, path)` : la mise à plat des pas, seule
   source pour `compile_setlist` (la `pc_map`) et `export_show`.
2. `export_show(project) -> dict` (`es8core/model/show.py`) et la commande
   `es8stage rig show <setup|projet> -o show.json`. L'id d'un rig est son id
   dans un document projet, sinon le nom de son fichier ; l'id d'une
   setlist, le nom de son fichier, sinon son nom simplifié.
3. Pedalboard : `midi.companion: true` sur un appareil ; ses paramètres
   doivent être des noms d'action (refus sinon).
4. Setlist : `name` facultatif sur un morceau écrit sur place.

5. ES8 Designer : « Send to stage » sur un hôte de scène (voir
   `docs/stage-host.md`) ; ailleurs, « Show » télécharge le show.
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

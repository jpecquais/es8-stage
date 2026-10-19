# Modèle pedalboard → rig → snapshot

Couche d'édition par intention au-dessus des champs de patch : on décrit le
matériel, puis des rigs et leurs snapshots, et un compilateur produit le même
format de changements que `transform` (`{patches, system}`), consommé par
`apply` (CLI) ou `_accept` (web). Aucun nouveau chemin vers l'ES-8.

Statut : compilateur codé le 2026-10-19 (`packages/core/src/es8core/model/`,
`es8ctl rig compile` / `rig status`, tests `tests/test_rig_model.py`), pas
encore essayé sur l'appareil. Restent : `rig import`, l'app web. Maquette d'interface :
https://claude.ai/artifact/2GHaQenYoy9vhSk1RPRMrZ

## Vocabulaire

| Terme | Ce que c'est | Sur l'ES-8 |
|---|---|---|
| **Pedalboard** | Le matériel branché : pédales dans les loops, sorties CTL, entrées, appareils MIDI | rien (fichier seulement) |
| **Rig** | Une configuration jouable : ordre des loops, programme chargé sur chaque appareil, surface | une banque (8 patchs) |
| **Snapshot** | Un état du rig : loops actives, valeurs des paramètres MIDI | un patch |
| **Surface** | Le rôle de chaque switch, partageable entre rigs | assigns, `ctl_func`, `manual_number` |
| **Destination** | Un appareil MIDI du pedalboard (un DAW n'en est qu'un) | slots MIDI des patchs |
| **Track** | Un morceau : un rig et son déroulé (snapshots dans l'ordre joué, répétitions comprises) | rien (fichier seulement) |
| **Setlist** | Un enchaînement de morceaux, dans l'ordre du concert | une banque MIDI de la `pc_map` (système) |

Décisions actées :

- Un rig = une banque, 8 snapshots au plus. Pas de rig sur deux banques en v1.
- Le flux va dans un sens : l'ES-8 détient l'état et pilote les destinations.
  Un changement venu d'une destination (souris dans le DAW) n'est pas renvoyé.
- Un rig, c'est une partie locale (loops, surface) et une partie distante
  (les PC qui chargent le bon programme sur chaque appareil). Les PC du rig
  sont recopiés dans les 8 snapshots : rappeler un snapshot depuis un autre
  rig doit charger les bons programmes.
- Les fichiers sont la vérité ; l'ES-8 est le résultat compilé.

## Fichiers

Tous en JSON, avec un champ `schema` versionné. Les références entre
fichiers sont des chemins relatifs.

### `pedalboard.json`

Une liste d'appareils. Chacun est branché à l'ES-8 dans une boucle (ou
plusieurs), par MIDI, ou les deux : un DAW avec carte son en insert, une
pédale pilotable en MIDI.

```json
{
  "schema": "es8ctl.pedalboard/2",
  "devices": {
    "comp": {"name": "Compresseur", "loops": ["L1"]},
    "volume": {"name": "Pédale de volume", "loops": ["LV"]},
    "daw": {
      "name": "DAW",
      "loops": ["L6"],
      "midi": {
        "channel": 1,
        "program_change": "pc",
        "programs": {"crunch": {"pc": 12, "name": "Crunch Lead"}},
        "params": {
          "drive": {"name": "Drive · On", "cc": 18, "off": 0, "on": 127},
          "delay": {"name": "Delay · On", "cc": 19, "off": 0, "on": 127}
        }
      }
    },
    "reverb": {
      "name": "Pédale reverb",
      "loops": ["L7"],
      "midi": {"channel": 2, "program_change": "pc",
               "programs": {"hall": {"pc": 5, "name": "Hall long"}},
               "params": {"freeze": {"name": "Freeze", "cc": 21, "off": 0, "on": 127}}}
    }
  }
}
```

- Une boucle appartient à un seul appareil.
- `midi.program_change` : `none` | `pc` | `bank_msb_pc` | `bank_lsb_pc` | `bank_msb_lsb_pc`.
- `midi.companion: true` : l'appareil est ES8 Companion (`docs/companion.md`) ;
  ses paramètres portent le nom d'une action (`next`, `prev`, `next_song`,
  `prev_song`, `song_start`) et deviennent le préréglage d'entrée du show.
- Un paramètre est désigné ailleurs par `<appareil>.<param>` (`daw.drive`) ;
  les rigs désignent les boucles par leur numéro (`L6`).
- Les valeurs PC, bank et CC sont celles de l'appareil (0–127) ; dans le
  patch, `midi_pc`, `midi_pc_bank_*` et `midi_ctl*_cc` valent 0 = OFF puis
  valeur + 1, `midi_tx_ch` 0 = OFF puis 1–16 (listes de l'éditeur officiel).
- Le format v1 (`es8ctl.pedalboard/1` : `loops` et `devices` MIDI séparés)
  reste lu ; en interne, le moteur travaille sur cette vue par boucle et par
  appareil MIDI.

### `surface.json`

```json
{
  "schema": "es8ctl.surface/1",
  "name": "Lead 4 + 4",
  "switches": {
    "NUM1": {"label": "Drive", "role": "param", "param": "daw.drive", "mode": "toggle"},
    "NUM4": {"label": "Freeze", "role": "param", "param": "reverb.freeze", "mode": "momentary"},
    "NUM5": {"label": "Overdrive", "role": "loop", "loop": "L2"},
    "NUM8": {"label": "Tap", "role": "tap"}
  }
}
```

Rôles : `param` (CC vers une destination), `loop`, `tap`, `es8` (fonction
native : `MEM_M`, `MUTE`…), absent = inchangé. Les switches s'appliquent au
mode manuel ; en mode patch, NUM1–8 rappellent les snapshots.

### `rigs/<nom>.json`

```json
{
  "schema": "es8ctl.rig/1",
  "name": "Crunch Lead",
  "short": "Crunch",
  "bank": 12,
  "pedalboard": "../pedalboard.json",
  "surface": "../surfaces/lead.json",
  "chain": ["L2", "L5", "L7"],
  "programs": {"daw": "crunch", "reverb": "hall"},
  "snapshots": [
    {"name": "Intro", "loops": ["L5"], "params": {"daw.delay": "on"}},
    {"name": "Chorus", "loops": ["L2", "L5"], "params": {"daw.drive": "on", "daw.delay": "on"}}
  ]
}
```

- `chain` : ordre des loops utilisées, de l'entrée vers la sortie ; les
  loops non citées sont rangées côté entrée, coupées, et V tout au bout s'il
  n'est pas cité. Les montages parallèles passent par la notation de l'écran
  (`routing.py`, de la sortie vers l'entrée) au lieu d'une liste.
- Paramètre absent d'un snapshot = `off`. Une valeur peut être `on`, `off`
  ou un nombre 0–127.
- Nom de patch : `<short> <snapshot>`, 16 caractères au plus (refus sinon).

### `setup.json`

Associe les banques aux rigs et les banques MIDI de la `pc_map` aux setlists :

```json
{"schema": "es8ctl.setup/1", "pedalboard": "pedalboard.json",
 "rigs": {"12": "rigs/crunch-lead.json", "11": "rigs/ambient.json"},
 "setlists": {"0": "setlists/concert-novembre.json"}}
```

### `tracks/<nom>.json`

```json
{"schema": "es8ctl.track/1", "name": "Premier morceau", "rig": "../rigs/crunch-lead.json",
 "sequence": ["Verse", "Chorus", "Verse", "Chorus", "Bridge", "Chorus"]}
```

- `sequence` : noms de snapshots du rig, dans l'ordre joué. Les répétitions
  sont des pas de plus, jamais des patchs de plus.

### `setlists/<nom>.json`

```json
{
  "schema": "es8ctl.setlist/1",
  "name": "Concert novembre",
  "songs": [
    {"track": "../tracks/intro.json"},
    {"track": "../tracks/premier-morceau.json"},
    {"rig": "../rigs/ambient.json", "sequence": ["Pad"]}
  ]
}
```

- Un enchaînement de morceaux ; un morceau peut revenir plus loin. Un
  morceau peut aussi être écrit sur place (`rig` + `sequence`, `name`
  facultatif).
- Ni la setlist ni le morceau ne stockent de patch : ils référencent des
  rigs déjà placés dans une banque par `setup.json`.

### Document projet (`es8ctl.project/1`)

Tout en un fichier, avec des ids au lieu de chemins : `pedalboard`,
`surfaces`, `rigs`, `tracks`, `setlists` (chaque setlist porte sa
`midi_bank`). C'est le format d'ES8 Designer (export) ; `es8ctl rig
compile` l'accepte comme un `setup.json`.

## Compilation

`compile_rig(pedalboard, surface, rig, dump) -> changes` : pur, sans MIDI,
testable sur les fixtures. Chaque élément produit :

| Source | Champs écrits | Patchs |
|---|---|---|
| `short` + nom du snapshot | `name` | chacun |
| `chain` | `loop_chain` | les 8 |
| `snapshot.loops` | `loop_sw` | chacun |
| `programs` | slots MIDI : `midi_tx_ch`, `midi_pc`, `midi_pc_bank_*`, `midi_transmit` | les 8, identiques |
| `snapshot.params` | `midi_ctl1/2_cc`, `midi_ctl1/2_cc_val` des slots | chacun |
| switch `param` | un assign : source `NUMx`, cible `MIDI`, `assign_target_cc_ch/no`, `assign_mode`, min/max | les 8 |
| switch `tap` | `ctl_func[NUM_x] = BPM` | les 8 |
| switch `es8` | `ctl_func` du switch | les 8 |
| switch `loop` | `manual_number<x>` = n° de loop (1–8) | **système** |

Une surface possède les 12 assigns (ceux qu'elle n'utilise pas sont coupés,
avec un avertissement) et `ctl_func` ; sans surface, ni l'un ni l'autre
n'est touché. Seul le rôle `loop` écrit `manual_number` : ce que fait la
valeur OFF (défaut d'usine) reste à observer.

Rangement des slots MIDI (8 par patch, chacun : canal, PC, 2 CC) : par
appareil, le premier slot porte le PC du rig et 2 CC, les suivants (même
canal, sans PC) 2 CC chacun.

Le compilateur rend aussi la liste des champs qu'il possède (`owns`) : badges
dans l'éditeur classique et détection de divergence.

### Setlist → `pc_map`

`compile_setlist(setup, setlist, dump) -> changes` : même principe, ne touche
que le système. Les pas sont mis à plat (morceau après morceau) ; le pas *i*
devient l'entrée *i* de la banque MIDI de la setlist :

| Source | Champ écrit |
|---|---|
| pas *i* = (rig, snapshot) | `pc_map_bank<b>_pc[i]` = numéro du patch du snapshot (0–799) |
| entrées au-delà du dernier pas | numéro du patch du dernier pas (un « suivant » de trop ne sort pas du concert) |

- Navigation : n'importe quelle source de PC sur le canal de réception de
  l'ES-8 (EV-1-WL ou ses footswitches via le WIDI, un DAW, module Pico, iPad).
  PC *i* → pas *i*. Les répétitions (Verse, Chorus, Verse…) coûtent une
  entrée de 10 bits, aucun patch.
- Une banque MIDI = une setlist : 7 setlists de 128 pas au plus, choisies
  par Bank Select. Sans Bank Select (à tester), une seule setlist active en
  banque 0, réécrite pour changer de concert (quelques pages système).
- Les NUMx de l'ES-8 restent libres en mode patch : on peut sauter à un
  snapshot hors déroulé. Un contrôleur qui compte ses PC (PC +1 / −1) ne le
  voit pas et reprend à son propre compteur ; seul un contrôleur qui écoute
  l'ES-8 (Pico, iPad) peut se recaler.
- `owns` : les entrées `pc_map` de la banque de la setlist.

### Vérifications (refus avant toute écriture)

- 8 snapshots au plus ; noms ≤ 16 caractères.
- Assigns ≤ 12, slots MIDI ≤ 8 par patch.
- Loops de la chaîne et des snapshots présentes dans le pedalboard.
- Paramètres et programmes existants ; canaux distincts entre appareils.
- Champs système : deux surfaces en usage ne peuvent pas donner deux valeurs
  au même `manual_number`.
- Setlist : au moins un morceau, 128 pas au plus ; chaque morceau existe et
  a au moins un pas ; son rig est placé dans une banque ; chaque snapshot de
  son déroulé existe dans le rig ; une banque MIDI par setlist.

Avertissements (sans refus) : loop câblée inutilisée, slot de snapshot vide.

Limitation connue, assumée : chaque snapshot renvoie les PC du rig. Passer
d'un snapshot à l'autre du même rig renvoie donc le même PC ; un appareil
qui recharge son programme à chaque PC aura une coupure. Aucun réglage ne
l'évite côté ES-8 (les PC doivent être dans chaque patch pour qu'un
snapshot rappelé depuis un autre rig charge les bons programmes).

### Divergence et import

- **Divergence** : après un `read`, recompiler le rig contre le dump frais.
  Changements vides = synchronisé ; sinon la banque a été modifiée sur la
  pédale. Choix : réappliquer le rig, ou reprendre les valeurs de la pédale.
- **Import** (`es8ctl rig import --bank 12`) : brouillon de rig depuis une
  banque existante. Ce qui est identique dans les 8 patchs remonte au rig
  (chaîne, PC, assigns) ; ce qui varie devient l'état des snapshots. Même
  mécanique que la reprise des valeurs en cas de divergence.

## Interface : une app à part

Deux apps, un moteur :

```
web/
  shared/   engine.js (Pyodide, Web MIDI, lecture, écriture vérifiée), chain.js, describe.js
  control/  ES8 Control, l'éditeur classique (champ par champ)
  designer/ ES8 Designer : Start (introduction), Pedalboard, Surfaces, Rigs, Tracks, Setlists
```

- Toute la logique reste dans la lib Python (`compile_rig`, `_accept`,
  `write_pending`) ; rien n'est réimplémenté en JS.
- Pont web : `stage_rig(json)` → `_accept(compile_rig(...))`. Le résultat
  rejoint les modifications en attente et s'écrit par le même chemin
  (sauvegarde, relecture, renvoi).
- Liens croisés : « ouvrir ce patch dans l'éditeur classique » ; l'éditeur
  classique lit `setup.json` et marque les champs « gérés par le rig X ».
- Une seule app connectée à l'ES-8 à la fois (verrou) : deux connexions
  recevraient les mêmes réponses et deux files d'attente s'écraseraient.

## À tester sur l'appareil avant de coder la compilation

1. Au rappel d'un patch, l'état des toggles du mode manuel repart-il du patch
   (`led_numX`, état des assigns) ou garde-t-il la dernière valeur ?
2. Un assign `NUMx` → `MIDI` en `TGL` : la LED du switch suit-elle l'appui ?
3. L'ES-8 renvoie-t-il un PC identique au changement de patch (moniteur) ?
4. Encodage de `midi_pc` (0 = rien envoyé ?) et de `manual_number` (0–9).
5. Le canal d'écoute de la source d'assign `CC` est-il le canal de réception
   système ? (utile seulement pour un retour visuel piloté de l'extérieur)

Pour la setlist :

6. L'ES-8 applique-t-il le Bank Select (CC0, et/ou CC32) pour choisir la
   banque MIDI de la `pc_map` ? Sinon : une seule setlist active (banque 0).
7. L'ES-8 suit-il un PC reçu en mode manuel, ou seulement en mode patch ?
8. `MEM_U` / `MEM_D` passent-ils d'une banque à la suivante ?
9. L'EV-1-WL sait-elle envoyer PC +1 / −1 sur ses footswitches (Tone Studio) ?
10. Le WIDI Jack accepte-t-il la WL et l'ordinateur (ou un iPad) en même temps ?

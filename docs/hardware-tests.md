# Ce qui reste à valider sur l'ES-8

La liste de référence de ce qui n'a pas encore été vu sur l'appareil, pour
toutes les apps. Chaque ligne indique si on peut la tester sans écrire
(🟢), en écrivant sur une banque sacrifiable (✍️), et si quelqu'un doit
regarder la pédale ou appuyer dessus (👀). ⛔ = bloque une app.

Méthode sans humain : l'ES-8 émet sur sa sortie MIDI les messages de ses
patchs. Des rigs « sonde » dont chaque snapshot envoie un CC de valeur
unique permettent de savoir quel patch s'est chargé en écoutant cette sortie.
Projet et script : `tests/hardware/` (rigs en banques 97–98, setlists en
banques MIDI 0–1) :

```sh
es8ctl rig compile tests/hardware/probe/setup.json -b <lecture complète> -o changes.json
es8ctl apply changes.json -b <lecture complète> --write --port <port> --confirm
uv run python tests/hardware/run_probe.py   # PC / Bank Select → CC100 reçus, en JSON
```

Séance du 2026-10-19 (sans humain) : D1, D4, D5, D8, L1, L2, L4, C1 faits.

Séance du 2026-10-20 (avec l'utilisateur à la pédale, patch sonde 97-1) : switches MIDI et groupes.

- **Mode manuel** : NUM1–8 ne font que commuter des boucles (`manual_number` : 0 = AUTO, la
  boucle du même numéro ; 1–8, V = une autre). Aucune assignation ne part, quelle que soit
  la fonction (`ctl_func` système ignoré pour les NUM). Doc BOSS v2, « Number 1–8 (MAN) ».
- **Mode memory** : un NUM dont la fonction du patch n'est plus `NUM_x` (OFF, CTL_x…) ne
  rappelle plus de patch et ses assignations partent. MOM : max à l'appui, min au
  relâchement ; MOM avec min = max : un cran fixe à chaque appui ; TGL : max puis min.
- **LED** : la cible `LED_NUMx` marche en memory. Un switch en OFF n'allume pas sa LED tout
  seul : TGL `LED_NUMx` 0/1 sur lui-même la fait suivre. MOM 1/1 l'allume (sans jamais
  l'éteindre). MOM 0/0 vers la LED d'un autre switch l'a basculée plutôt qu'éteinte
  (observé, à confirmer).
- **Groupes** : forcer un autre switch n'est pas possible. Les cibles CTL1–6 n'agissent
  pas sur les autres switches (sorties CTL OUT), et chaque assignation TGL garde son état :
  après « B », un appui sur « A » renvoie son min. La source d'assignation CTL1–4 est la
  prise CTL IN (doc BOSS v2) : D7 réglé.
- Une fonction CTL_x sur un switch n'allume pas sa LED.
- La fonction d'un switch vient du patch ou du système (Preference PAT/SYS, `ctl_sw`) ;
  les assignations sont toujours celles du patch courant.
- **Switch MIDI on/off avec LED, et snapshots** (97-1 « Drive off », 97-2 « Drive on ») :
  2 assignations TGL sur le switch (le CC bas/haut, sa LED 0/1). Au rappel d'un patch, la
  LED part de `led_numX` du patch, mais la bascule de l'assignation repart de off : le
  premier appui envoie MAX. Parade vérifiée : dans un patch où le paramètre est on,
  inverser l'assignation (MIN = haut, MAX = bas ; LED MIN = 1, MAX = 0) et `led_numX` = 1 ;
  le premier appui coupe, puis tout bascule. ✅ (MIDI relevé + LED vue par l'utilisateur.)

Balayage des commandes éditeur `7F00`–`7F7F` inconnues (2026-10-20, DT1 de 2 octets en mode
éditeur, donnée = n° du patch sonde, sauvegarde complète avant) : aucune réponse SysEx, rien
d'autre de changé que le patch visé. **`7F02` = initialiser le patch n** (comme `7F21`) :
à ne jamais envoyer. Une fonction CTL1–6, même en TGL, n'allume pas la LED du switch.
Aucune commande LED trouvée côté logiciel ; l'éditeur officiel n'en a pas (il réécrit des
patchs entiers).

## Socle (ES8 Control, Designer, CLI)

| # | Question | Type | État |
|---|---|---|---|
| S1 | Ce que fait l'ES-8 d'une demi-page (écriture coupée entre les deux messages d'une page) | ✍️ | simulé seulement |
| S2 | Champs déduits : `mixer_*`, `midi_clock_out`, `midi_transmit`, extension système v2, affichage des parallèles 13–15 | ✍️ 👀 | ouvert |
| S3 | Retours stéréo des loops 7/8 et nombre de mixers qui en dépend | ✍️ 👀 | ouvert |

## ES8 Designer (rigs)

| # | Question | Type | État |
|---|---|---|---|
| D1 | ⛔ Un rig compilé, écrit, puis relu identique (`rig status` → `in_sync`) | ✍️ | ✅ 2 rigs + 2 setlists écrits (`--confirm` a renvoyé 3 pages perdues), relecture complète `in_sync` |
| D2 | Au rappel d'un patch, les switches du mode manuel reprennent-ils l'état du patch ? | ✍️ 👀 | ✅ en memory : la LED suit `led_numX`, la bascule d'assign repart de off (parade : assign inversé), voir la séance du 2026-10-20 |
| D3 | Un assign `NUMx → MIDI` en `TGL` : la LED suit-elle l'appui ? | ✍️ 👀 | ✅ non toute seule ; oui avec une 2e assign TGL `LED_NUMx` 0/1 sur le switch |
| D4 | Au rappel, les PC et CC attendus sortent-ils ? Un PC identique est-il renvoyé entre snapshots du même rig ? | ✍️ | ✅ PC et CC attendus ; le PC du rig repart à chaque snapshot. Rappeler le patch déjà chargé n'émet rien |
| D5 | Encodages : `midi_pc` = 0 n'envoie rien ? `manual_number` = OFF ? | ✍️ 👀 | `midi_pc` = 0 : ✅ aucun PC, le CC part seul. `manual_number` : à voir |
| D6 | La source d'assign « CC reçu » écoute-t-elle sur le canal de réception système ? | ✍️ | ouvert |
| D7 | Les sources d'assign CTL1–4 sont-elles les jacks CTL IN 1–4 ? | ✍️ 👀 | ✅ oui (doc BOSS v2, exemple « Src CTL1 » = prise CTL1 IN) |
| D8 | ⛔ Prise MIDI OUT en Thru : les messages des patchs sortent-ils ? Sinon, Out est requis | ✍️ | ✅ oui dans les deux modes ; Thru ajoute l'écho de tout ce qui entre |
| D9 | `MEM_U` / `MEM_D` passent-ils d'une banque à la suivante ? | 👀 | ouvert |

## Setlist (écrite par Designer, jouée par la Companion ou un contrôleur)

| # | Question | Type | État |
|---|---|---|---|
| L1 | ⛔ Un PC *i* reçu en mode patch rappelle le patch de la `pc_map` | ✍️ | ✅ 6 pas dans l'ordre, répétitions comprises ; un PC sur un autre canal est ignoré |
| L2 | Bank Select (CC0 et/ou CC32) choisit-il la banque MIDI de la `pc_map` ? | ✍️ | ✅ CC0 oui (aussi collé au PC, comme l'envoie la Companion) ; CC32 ignoré |
| L3 | Un PC reçu en mode manuel est-il suivi ? | 👀 | ouvert |
| L4 | Un PC au-delà du dernier pas reste sur le dernier patch | ✍️ | ✅ (PC 6 et 127) |

## ES8 Companion

| # | Question | Type | État |
|---|---|---|---|
| C1 | En Thru, l'ES-8 renvoie-t-il les PC reçus ? En Out, émet-il quelque chose quand on change de patch au panneau ? | 🟢 👀 | ✅ Thru : écho de tout ; Out : pas d'écho. Au changement de patch (rappel à distance), seuls les messages du patch sortent, jamais son numéro ; le protocole de l'éditeur sait lire le patch en cours. Au panneau : à voir |
| C2 | Quels switches envoient un CC en mode patch : assign NUMx, CTL IN, BANK ▲▼, MEM/MUTE ? | 👀 | rigs sonde en place : NUM1 → CC102 ch15 (TGL), CTL IN 1/2 → CC80/81 ch16 ; il reste à appuyer en écoutant |
| C3 | Le WIDI accepte-t-il deux appareils à la fois ? | 👀 | ouvert |
| C4 | L'EV-1-WL sait-elle envoyer PC +1 / −1 ? | 👀 | ouvert |
| C5 | De bout en bout : Chrome sur Android ou ordinateur → ES-8, hors ligne, écran allumé, pédale tourne-page | 👀 | ouvert |
| C6 | Délai entre l'appui et le changement de patch acceptable sur scène | 👀 | ouvert |
| C7 | Companion v2 : un switch `param` de l'ES-8 (fonction OFF, CC vers la Companion) bascule le paramètre, la Companion envoie son CC qui ressort en Thru vers l'appareil, et le panneau suit ; l'état repart du snapshot au pas suivant | ✍️ 👀 | ✅ 2026-10-20 (Brave, WIDI) : BANK ▲/▼ → CC0 + PC → patch, ses messages suivent ; NUM1 bascule CC20 0/127 ; NUM2 momentané 127/0 ; appui → CC sortant ≈ 40–50 ms par le WIDI aller-retour. Choix auto des ports corrigé (la session réseau macOS était prise) |
| C8 | Projet réel PULSE (14 snapshots en 0-1…1-6, surface NUM1–8 macros Ableton + BANK ▲▼, ES-8 sur le canal 15) joué par la Companion | ✍️ 👀 | ✅ 2026-10-20 : navigation dans les 14 sons, macros basculées et affichées ; chaque snapshot envoie aussi le PC du rig à Ableton (canal 1) |

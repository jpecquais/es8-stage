# Une seule appli pour jouer et éditer (réflexion, 2026-10-22)

Aujourd'hui, sur l'iPad branché au Pi, il y a quatre applis : Companion
(jouer), Designer (construire le set), Control (patchs bruts de l'ES-8), Stage
host (réglages du Pi). Pour passer de l'une à l'autre, on change de page et
d'état d'esprit, et il faut encore « Send to stage » pour que la Companion voie
le travail du Designer. Cette note propose de les fondre en une seule appli.

## Ce que font les autres

Toutes les machines de scène qui se jouent et s'éditent sur le même écran
suivent le même schéma : **un seul document, deux postures**.

- **MainStage** (Apple) : un concert, trois modes dans la même fenêtre :
  Layout (la surface), Edit (patchs, sets), Perform (plein écran, gros
  caractères). On passe de l'un à l'autre d'un clic, sur le patch en cours
  ([guide MainStage](https://support.apple.com/en-in/guide/mainstage/toc/4.3)).
- **Gig Performer** : des rackspaces (le matériel virtuel) avec des
  variations (les sons), des setlists dont les morceaux ont des parties qui
  pointent vers les variations. Le même rackspace sert à plusieurs morceaux.
  On change de partie au pédalier, à la surface ou à l'écran
  ([Synthtopia](https://synthtopia.com/?p=104663), [Sound On Sound](https://www.soundonsound.com/reviews/gig-performer-4)).
  C'est exactement notre modèle : pédalier → rigs → sons → morceaux → setlists.
- **Camelot Pro** : setlists → morceaux → scènes ; on réordonne au glisser
  dans la setlist, un morceau peut servir dans plusieurs setlists. Lecture et
  édition dans la même appli, avec un garde-fou contre l'entrée accidentelle
  en édition pendant le jeu ([Audio Modeling](https://kb.audiomodeling.com/support/solutions/articles/206000053802-camelot-features-setlist-song-and-scene-manager)).
- **Quad Cortex** : on joue sur la grille d'édition ; la **Gig View** (glisser
  vers le haut) est la posture de scène, avec ce que fait chaque footswitch.
  On renomme, copie, colore les scènes depuis la Gig View
  ([Neural DSP](https://neuraldsp.com/news/gig-view-quad-cortex-development-update)).
- **Helix** : même principe ; une modification s'entend tout de suite, un
  repère montre que le preset diffère de ce qui est enregistré, on enregistre
  quand on veut.

Ce qu'on en retient :

1. **Un seul document**, toujours à jour : ce qu'on joue est ce qu'on édite.
   Personne n'« exporte » vers la partie scène.
2. **Deux postures** de la même appli : jouer (gros, lisible de loin, peu de
   gestes possibles) et éditer (dense, précis). On passe de l'une à l'autre
   d'un geste.
3. **L'édition part de ce qu'on joue** : « modifier ce son », « modifier ce
   morceau ». En revenant, on retrouve sa place.
4. **On entend tout de suite**, et un repère dit ce qui n'est pas encore
   enregistré dans la machine.
5. **Un garde-fou** : pendant le jeu, impossible de modifier par accident.

## Proposition pour ES8 Stage

### Une appli, deux postures

```
ES8 Stage (iPad, servie par le Pi)
├── Jouer (par défaut)
│   ├── Accueil ─── favoris (un toucher = le son) · setlists
│   ├── Setlist ─── le déroulé (Previous / Now / Next) ou la vue Switches
│   └── ✎ ───────── passe en édition sur ce qui est joué
└── Éditer
    ├── Pédalier · Footswitches · Sons · Morceaux · Setlists et favoris
    ├── Avancé ──── patchs bruts de l'ES-8 (l'actuel Control)
    └── Réglages ── le Pi, l'ES-8, les sauvegardes (l'actuel Stage host)
```

- Le bouton ✎ du jeu ouvre l'édition **sur l'élément en cours** : le son de
  l'étape jouée, avec en contexte son morceau et sa setlist. « Terminé »
  ramène au jeu, à la même place.
- En édition, le pédalier de l'ES-8 continue de jouer : on peut régler un son
  en jouant (comme sur une Helix). Seul l'envoi à l'ES-8 met la scène en
  pause, le temps d'écrire.
- Le bandeau commun (Companion · Designer · Control · Stage host) disparaît :
  il n'y a plus qu'une appli.

### Un seul monde sur le Pi

- Le Pi garde **un projet**, celui de l'ES-8 : un pédalier, ses rigs, ses
  sons, ses morceaux, ses setlists, ses favoris. On ne « charge » plus un set
  qui remplace l'autre : tout ce qu'on joue est dedans (reprises, compos,
  jams).
- Le show de la Companion n'est plus un fichier qu'on envoie : le Pi le
  calcule à partir du projet, à chaque modification.
- La bibliothèque devient l'historique : des versions datées du projet et des
  sauvegardes de l'ES-8, pour revenir en arrière.

### Modifier, entendre, envoyer

Une modification touche deux choses, qui ne vont pas à la même vitesse :

| Modification | Où elle vit | Quand elle s'applique |
|---|---|---|
| Ordre d'une setlist, favoris, noms | le Pi seulement | tout de suite |
| Ordre des morceaux qui change les PC, nouveau morceau | la table des PC de l'ES-8 | à l'envoi |
| Boucles ou MIDI d'un son | le patch de l'ES-8 | à l'envoi ; on peut l'entendre avant |

- **Entendre avant d'envoyer** : les valeurs MIDI d'un son peuvent partir
  directement aux appareils (CC) pendant qu'on règle. Pour les boucles,
  écrire le seul patch en cours prend moins d'une seconde.
- **Un repère** (un point) sur chaque son, morceau ou setlist qui diffère de
  l'ES-8, et un bouton « Envoyer à l'ES-8 (3) » toujours visible en édition.
  Il n'écrit que ce qui a changé et le vérifie, comme aujourd'hui.

### Le garde-fou

- En posture de jeu, aucun geste ne modifie quoi que ce soit : seuls jouer un
  pas, un favori, un switch.
- Les gestes d'édition (glisser, supprimer) n'existent qu'en posture
  d'édition, derrière « Modifier » comme dans les listes iOS.
- L'envoi à l'ES-8 demande une confirmation s'il se passe pendant qu'un
  morceau est en cours.

## Ordre de travail proposé

1. **La coquille** : une appli à la racine, Jouer (accueil, setlist,
   switches) et Éditer (le Designer tactile), ✎ et « Terminé » qui gardent
   le contexte. Control et Stage host deviennent des rubriques.
2. **Le projet sur le Pi fait foi** : la Companion lit le projet, plus de
   « Send to stage » pour ce qui ne touche pas l'ES-8 (ordre, favoris, noms).
3. **L'envoi à l'ES-8** depuis l'édition, avec les repères de différence.
4. **Entendre en réglant** (CC directs, écriture du seul patch en cours).
5. **L'historique** à la place de la bibliothèque de sets.

## Où on en est (2026-10-22)

Étapes 1 à 5 faites ; l'ancien Designer n'est plus nécessaire pour la scène.

- **`/app/`** (où mène `/`) : `web/app/` monte la Companion (`companion/app.js`) et le
  Designer tactile (`designer-touch/app.js`), chacun dans son shadow DOM avec sa feuille
  de style (mêmes noms de classes des deux côtés). Les deux restent montés : la scène suit
  l'hôte pendant l'édition, l'édition retrouve sa place. `/companion/` et
  `/designer-touch/` marchent toujours seuls (`window.ES8_SHELL` absent).
- **✎ Edit** ouvre le son joué (le favori s'il y en a un) ; sur l'accueil, Setlists &
  favorites. **Done** enregistre et revient au jeu ; le retour du navigateur revient au
  jeu sans enregistrer.
- **Enregistrer le set joué** (`PUT /library/projects/<nom>`, `restage`,
  `StageServer.project_saved`) : mêmes tables de PC et même canal → la scène joue le
  nouveau show tout de suite, à la même place (`"playing"`) ; sinon elle attend l'envoi
  (`"send"`).
- **Send to the ES-8** (`POST /stage/send {project}`, `StageServer.send_project`,
  `EngineHost.send_project`) : c'est l'hôte qui relit les patchs du set et le système,
  compile, écrit en mode édition, relit jusqu'à vérification, puis joue le show en
  gardant la place (même setlist, même morceau par son nom : `stage.follow_position`).
  Suivi comme une sauvegarde (`snap.job`, `kind: "send"`), affiché dans l'édition et en
  bandeau sur la scène. Refusé si ES8 Control a d'autres changements en attente.
- **Ce qui diffère de l'ES-8** : l'édition appelle `rig_preview` sur le moteur de l'hôte
  (rien n'est lu sur l'ES-8, c'est sa dernière lecture) ; un point orange marque les sons,
  rigs, setlists et rubriques qui diffèrent ; le bouton dit combien.
- **Entendre en réglant** : un réglage MIDI du son qui joue part tout de suite
  (`/stage/act {type: "cc"}`) ; « Hear it on the ES-8 » écrit ce seul patch et le
  rappelle (`only`, `kind: "try"`), le show ne change pas.
- **Historique** : chaque enregistrement garde la version remplacée
  (`library/history/<set>/`, 5 min d'écart au moins, 100 au plus) ; Settings › History
  la remet dans l'éditeur (Save la garde).
- **Deux écrans** : `ETag` à la lecture, `If-Match` à l'écriture ; une version changée
  entre-temps est refusée (412) et l'écran demande : garder la sienne, ou charger l'autre.
- **Le Designer tactile fait tout ce que demande la scène** : rigs (patchs, chaîne,
  appareils, programmes, surface, noms de switch, rig de secours), programmes nommés des
  appareils, programme et son de secours d'un son, canaux (Settings). Un set d'une forme
  plus ancienne (morceaux dans la setlist, rig v1) est converti à l'ouverture.
- **Tests navigateur** : `tests/test_web_app.py` (Firefox sans écran, faux ES-8),
  `uv run --with selenium pytest tests/test_web_app.py`.

Laissé de côté, exprès :

- **Plus de 7 setlists** : chaque setlist occupe une banque MIDI de la pc_map, ce qui
  laisse l'ES-8 dérouler la setlist seul si le Pi tombe. Faire rappeler les patchs par le
  Pi (comme les favoris) lèverait la limite mais perdrait ce secours : à décider.
- **LED de l'ES-8 suivies par le Pi** : demande des essais sur l'appareil.
- **Pont du moteur sans XHR synchrone** : seul le Designer de bureau et Control s'en
  servent ; l'appli unifiée n'appelle le moteur qu'en `fetch`. Le changer touche toute
  l'API du moteur (`es8/web/shared/engine.js`).
- **Une seule feuille de style** : jouer (chaud, ambre) et éditer (froid, bleu) gardent
  chacun la leur ; les fondre est un travail de design à part.

## Questions ouvertes

- Faut-il pouvoir éditer **pendant** un concert (régler un son entre deux
  morceaux), ou l'édition est-elle réservée aux répétitions ?
- Garde-t-on le Designer « bureau » sur le Mac, ou la même appli suffit-elle,
  en plus large ?
- Un seul projet sur le Pi : est-ce que ça couvre tous tes usages, ou
  veux-tu parfois repartir d'une ardoise vide (pour un autre guitariste, un
  autre pédalier) ?

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

## Questions ouvertes

- Faut-il pouvoir éditer **pendant** un concert (régler un son entre deux
  morceaux), ou l'édition est-elle réservée aux répétitions ?
- Garde-t-on le Designer « bureau » sur le Mac, ou la même appli suffit-elle,
  en plus large ?
- Un seul projet sur le Pi : est-ce que ça couvre tous tes usages, ou
  veux-tu parfois repartir d'une ardoise vide (pour un autre guitariste, un
  autre pédalier) ?

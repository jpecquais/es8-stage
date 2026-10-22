# ES8 Designer au doigt : structure et choix d'interface

Prototype : `web/designer-touch/` (servi en `/designer-touch/`). Il lit le set
joué par l'hôte de scène et n'enregistre rien.

## Ce qu'on construit

Un set se compose ainsi :

```
Set
├── Setlist(s) ── liste ordonnée de morceaux (un morceau peut revenir)
├── Morceaux ──── ordre de jeu : liste ordonnée d'étapes (Intro → Couplet → Solo…)
│                 chaque étape = un son du rig du morceau
├── Rigs ──────── sons (un patch ES-8 chacun, à la suite) : boucles allumées + valeurs MIDI
├── Surfaces ──── ce que fait chaque footswitch de l'ES-8
└── Pédalier ──── 8 boucles + V, appareils (canal MIDI, paramètres CC)
```

Deux natures de données :

- **Des collections ordonnées ou à parcourir** (setlist, morceaux, étapes,
  sons, appareils, paramètres). On les lit de haut en bas, on les réordonne,
  on y cherche un nom : ce sont des **listes**.
- **Des objets physiques** (le pédalier de l'ES-8, ses boucles). Leur
  disposition a un sens, on la reproduit à l'écran.

## Ce que font les autres

- **Camelot Pro** (iPad, scène) : même hiérarchie Setlist → Song → Scene ;
  les setlists sont des listes réordonnables au glisser, une scène contient
  presets matériels et liaisons MIDI ([Audio Modeling](https://audiomodeling.com/get-ready-for-your-next-show-with-camelot-pro),
  [App Store](https://apps.apple.com/app/camelot-pro/id1326331127)).
- **BandHelper / Set List Maker** (iPad) : répertoire et setlists en listes ;
  le preset MIDI est un réglage du morceau, envoyé quand on choisit le
  morceau ([BandHelper](https://www.bandhelper.com/tutorials/sending_MIDI.html)).
- **Quad Cortex** (écran tactile) : presets rangés en setlists, scènes =
  variations d'un preset ; la vue « Gig View » montre ce que fait chaque
  footswitch, à sa place ([Neural DSP](https://neuraldsp.com/manual/quad-cortex),
  [Gig View](https://neuraldsp.com/news/gig-view-quad-cortex-development-update)).
- **Helix Stadium** (écran tactile, 2025) : salué pour un tactile « immédiat »
  ([Sound On Sound](https://www.soundonsound.com/reviews/line-6-helix-stadium-xl)) ;
  snapshots et affectations de footswitches stockés dans le preset
  ([manuel](https://manuals.line6.com/en/helix-stadium/live/display)).
- **Morningstar** (MC6/MC8, éditeur web et iOS) : banques et presets en
  listes ; un preset porte une liste d'actions MIDI ([guide](https://help.morningstar.io/en/article/editor-user-guide-81kpjn/)).
- **Apple (iPadOS)** : barre latérale pour les rubriques, liste au milieu,
  détail à droite (Mail, Réglages) ; pas plus de deux niveaux dans la barre ;
  la sélection reste surlignée dans chaque colonne ([HIG, Sidebars](https://developer-mdn.apple.com/design/human-interface-guidelines/components/navigation-and-search/sidebars)).
  Listes groupées, chevron pour « aller vers », bouton Modifier pour
  réordonner et supprimer, cibles de 44 points au moins.

## Choix retenus

1. **Trois colonnes en paysage** : rubriques (Setlist, Morceaux, Sons,
   Footswitches, Pédalier) · liste · détail. En portrait, la barre de rubriques
   se replie derrière un bouton ; liste et détail restent côte à côte.
2. **Des listes, pas des cartes**, pour toute collection : lignes de 56 px,
   numéro ou patch à gauche, nom, résumé discret, chevron.
3. **Réordonner et supprimer en mode « Modifier »** (comme iOS) : poignée ≡ à
   droite qu'on glisse, ⊖ rouge à gauche. Aucun geste caché obligatoire.
4. **Le détail est un formulaire en groupes** (comme Réglages) : libellé à
   gauche, valeur à droite ; un choix parmi plusieurs ouvre une liste à coches
   dans la même colonne (retour par « ‹ »), pas une fenêtre par-dessus.
5. **Interrupteurs iOS** pour on/off (boucles d'un son), **segments** pour
   Off / On / Valeur, **− / +** pour les petits nombres (canal, CC).
6. **Le pédalier de l'ES-8 reste spatial** (Footswitches, Boucles) : c'est
   le seul endroit où la grille a un sens, comme la Gig View du Quad Cortex.
7. **« Send to stage » toujours visible**, avec l'état de l'ES-8.

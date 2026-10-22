# Tempo, tonalité et notes par morceau ; annuler pas à pas ; favoris depuis la scène (plan, 2026-10-22)

Trois remarques retenues après la revue « côté guitariste » de l'appli unifiée.

## 1. Tempo, tonalité, notes par morceau

**Besoin.** Entre deux morceaux, on regarde l'écran pour le tempo du décompte, l'accordage
ou le capo, et un rappel (« intro longue, attendre la batterie »). Helix, Quad Cortex et
Gig Performer mettent ces informations sur le morceau, pas sur le son.

**Modèle.** Sur le morceau (`es8ctl.track/1`, et un morceau écrit dans une setlist),
trois champs facultatifs :

| Champ | Forme | Exemple |
|---|---|---|
| `tempo` | entier 20–300 (BPM) | `120` |
| `key` | texte, 24 caractères au plus | `E minor · drop D` |
| `notes` | texte, 500 caractères au plus | `Long intro: wait for drums` |

Ils ne touchent pas la pc_map : un changement est joué tout de suite par la scène à
l'enregistrement, sans envoi à l'ES-8 (`project_saved`, « playing »).

**Show.** Chaque morceau de `setlists[].songs[]` reçoit `tempo`, `key` et `notes` quand
ils existent.

**Scène.**
- Sous le nom du morceau : des pastilles `♩ 120` et `E minor`, et un point qui bat au
  tempo (le décompte).
- Les notes en dessous, sur deux lignes au plus.
- Carte « Next », au dernier pas d'un morceau : le tempo, la tonalité et les notes du
  suivant.
- Vue Switches : les mêmes pastilles près du nom du morceau. Liste des morceaux : tempo et
  tonalité sur chaque ligne.

**Édition.** Dans la fiche d'un morceau, un groupe « On stage » :
- Tempo : un interrupteur, puis − 120 + ;
- Key / tuning : un champ texte ;
- Notes : une zone de texte.

**Pas fait, exprès : envoyer le tempo en MIDI (horloge).** Le BPM de l'ES-8 est un réglage
du patch, que plusieurs morceaux partagent. Une horloge MIDI tenue par le Pi passerait par
le Bluetooth (gigue). Il faudra des essais sur l'appareil.

## 2. Annuler pas à pas

**Besoin.** On règle à l'oreille : on veut revenir sur le dernier changement, pas perdre
tout le travail (« Undo all » seul).

**Comportement**, comme dans les éditeurs habituels :
- ↶ annuler et ↷ rétablir, dans le pied de la colonne des rubriques et dans la barre
  d'outils iPad ;
- au clavier, ⌘Z et ⇧⌘Z (Ctrl sur un autre système), hors champ texte ;
- les changements rapprochés (moins d'une seconde, comme une frappe ou un curseur) ne font
  qu'un pas ; 200 pas au plus ;
- « Undo all », restaurer une version et charger la version d'un autre écran
  s'annulent aussi ;
- la pile repart de zéro quand le set est relu (✎ sans changement en cours).

## 3. Favoris depuis la scène

**Besoin.** « On jamme ? » au milieu du set : aujourd'hui, Accueil puis le favori, et rien
sur l'écran de scène ne dit qu'un favori joue.

**Comportement.**
- Un bouton ★ dans la barre de scène (vues Setlist et Switches) ouvre une feuille avec les
  favoris en gros boutons ; un toucher joue le favori et ferme la feuille.
- Quand un favori joue, la carte « Now » (et son équivalent dans la vue Switches) le
  montre : « ★ Favorite », son nom, son patch, et « Tap to go back to … » ; toucher la
  carte renvoie le pas de la setlist (comme aujourd'hui).
- Next et Previous continuent la setlist depuis sa place.

## Ordre de travail

1. Modèle et show (Python), avec des tests.
2. Scène : pastilles, battement, notes, carte Next, feuille des favoris, carte Now.
3. Édition : groupe « On stage » du morceau, annuler et rétablir.
4. Tests navigateur, captures iPad, installation sur le Pi.

## Fait (2026-10-22)

Les trois points, comme prévus ; tests : `tests/test_show_export.py` (modèle, show),
`tests/test_web_app.py` (navigateur). En passant, les cartes de scène gardent leur texte
dans leur place : un nom long débordait sous Previous/Next sur iPad ; la taille du texte
suit maintenant la carte (unités de conteneur), « Now » reste la plus grande.

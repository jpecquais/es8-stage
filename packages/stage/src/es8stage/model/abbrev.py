"""Noms de patch : `<short> <snapshot>` raccourci aux 16 caractères de l'écran de l'ES-8.

Le nom du snapshot reste libre (morceaux, Companion) ; seul le nom écrit
dans le patch est réduit, par étapes, de la plus lisible à la plus brutale,
en s'arrêtant dès que ça tient :

1. Accents retirés, ponctuation → espace (l'ES-8 n'affiche que l'ASCII).
2. Mots vides retirés (a, the, of, de, la…), sauf le premier et le dernier.
3. Voyelles retirées des mots du milieu, du plus long au plus court
   (« Freedom » → « Frdm ») ; la première lettre reste.
4. Mots du milieu coupés à 3 lettres.
5. Mots du milieu réduits à leurs initiales, collées (« Great Day Freedom » → « GDF »).
6. Voyelles retirées de la section, puis du `short`, puis espaces retirés,
   puis coupe à 16.

Le `short` du rig (premier mot) et le dernier mot du snapshot (la section :
Intro, Solo…) sont gardés le plus longtemps : ce sont eux qu'on cherche des
yeux sur l'écran.
"""

from __future__ import annotations

import re
import unicodedata

from ..names import NAME_LEN

STOP_WORDS = {
    "a", "an", "the", "of", "for", "to", "in", "on", "and", "at", "by", "with",
    "de", "du", "des", "la", "le", "les", "l", "d", "et", "un", "une", "au", "aux", "en",
}
VOWELS = set("aeiouyAEIOUY")


def ascii_words(text: str) -> list[str]:
    """Texte → mots ASCII (accents retirés, ponctuation = séparateur)."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return [w for w in re.split(r"[^A-Za-z0-9]+", folded) if w]


def _devowel(word: str) -> str:
    if len(word) <= 3 or word.isdigit():
        return word
    return word[0] + "".join(c for c in word[1:] if c not in VOWELS)


def abbreviate(short: str, snapshot: str, limit: int = NAME_LEN) -> str:
    """`<short> <snapshot>` réduit à `limit` caractères (voir le module)."""
    head = ascii_words(short)
    words = ascii_words(snapshot)
    full = " ".join(head + words)
    if len(full) <= limit:
        return full
    # Le milieu : les mots du snapshot sauf le dernier (la section), qu'on réduit d'abord.
    # Un numéro final reste avec le mot qui le précède (« Part 2 »).
    keep = 2 if len(words) > 2 and len(words[-1]) <= 2 else 1
    last = words[-keep:]
    middle = words[:-keep]

    def text(mid, sep=" "):
        return sep.join(head + mid + last) if mid else sep.join(head + last)

    def fits(mid):
        return len(text(mid)) <= limit

    mid = [w for w in middle if w.lower() not in STOP_WORDS]
    if fits(mid):
        return text(mid)
    for step in (_devowel, lambda w: w[:3]):
        for i in sorted(range(len(mid)), key=lambda k: -len(mid[k])):
            mid[i] = step(mid[i])
            if fits(mid):
                return text(mid)
    initials = ["".join(w[0].upper() for w in mid)] if mid else []
    if fits(initials):
        return text(initials)
    last = [_devowel(w) for w in last]
    if fits(initials):
        return text(initials)
    head = [_devowel(w) for w in head]
    if fits(initials):
        return text(initials)
    return text(initials, sep="")[:limit]


def patch_names(rig: dict, limit: int = NAME_LEN) -> list[tuple[str, bool]]:
    """Nom écrit dans chaque patch du rig, et s'il a été raccourci automatiquement.

    `patch_name` d'un snapshot l'emporte ; sinon `<short> <snapshot>` s'il
    tient, sinon sa réduction. Deux réductions identiques reçoivent un
    numéro (« … 2 ») pour qu'on les distingue sur l'écran.
    """
    short = rig.get("short", rig.get("name", ""))
    out: list[tuple[str, bool]] = []
    for snap in rig["snapshots"]:
        if snap.get("patch_name"):
            out.append((snap["patch_name"], False))
            continue
        full = f"{short} {snap['name']}".strip()
        if len(full) <= limit and full.isascii():
            out.append((full, False))
        else:
            out.append((abbreviate(short, snap["name"], limit), True))
    seen: dict[str, int] = {}
    for i, (name, auto) in enumerate(out):
        if not auto:
            continue
        n = seen.get(name, 0) + 1
        seen[name] = n
        if n > 1:
            suffix = f" {n}"
            out[i] = (name[: limit - len(suffix)].rstrip() + suffix, True)
    return out

"""Noms de patch : `<short> <snapshot>` compressé aux 16 caractères de l'écran de l'ES-8.

Le nom du snapshot reste libre (morceaux, Companion) ; seul le nom écrit
dans le patch est compressé. Ce n'est pas une coupe : les caractères
disponibles sont répartis entre les mots pour garder le plus d'information
lisible possible.

- Le `short` du rig est gardé tel quel (on le cherche des yeux), sauf s'il
  prend plus de la moitié de l'écran.
- Le snapshot est découpé en titre et section : la section est ce qui suit
  le dernier séparateur (« A Great Day For Freedom - Intro » → « Intro »),
  sinon son dernier mot, avec son numéro (« Part 2 ») ; jamais collée au
  titre. Elle pèse plus que chaque mot du titre : on la garde entière tant
  que possible (Lead, Rythme…).
- Les mots vides (a, the, for, de, la…) sont retirés.
- Chaque mot peut s'écrire en entier, sans ses voyelles intérieures
  (« Freedom » → « Frdm »), par ses premières lettres, par son initiale, ou
  disparaître. Les premiers mots du titre pèsent plus que les suivants.
- Les mots du titre se collent en CamelCase (« GrtDayFrdm ») plutôt que de
  perdre un caractère par espace ; titre et section restent séparés.
- Une recherche exhaustive (programmation dynamique sur le budget de
  caractères) choisit la combinaison qui garde le plus d'information.
- Dans un rig, un même titre s'écrit pareil dans tous ses snapshots
  (« ACY Lead », « ACY Rythme ») : sa place est réservée d'après la plus
  longue de ses sections.
"""

from __future__ import annotations

import re
import unicodedata

from ..names import NAME_LEN

STOP_WORDS = {
    "a", "an", "the", "of", "for", "to", "in", "on", "and", "at", "by", "with", "is", "are", "this", "that",
    "it", "very", "from", "as", "or",
    "de", "du", "des", "la", "le", "les", "l", "d", "et", "un", "une", "au", "aux", "en", "ou", "pour", "sur",
}
VOWELS = set("aeiouyAEIOUY")
SEPARATORS = re.compile(r"\s+[-–—/]\s+|\s*[|:]\s*")


def ascii_words(text: str) -> list[str]:
    """Texte → mots ASCII (accents retirés, ponctuation = séparateur)."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return [w for w in re.split(r"[^A-Za-z0-9]+", folded) if w]


def _devowel(word: str) -> str:
    """Voyelles intérieures retirées (« Freedom » → « Frdm ») ; les nombres et mots courts restent."""
    if len(word) <= 3 or word.isdigit():
        return word
    return word[0] + "".join(c for c in word[1:] if c not in VOWELS)


def _cap(word: str) -> str:
    return word[:1].upper() + word[1:]


def _forms(word: str) -> list[tuple[str, float]]:
    """Écritures possibles d'un mot, et la part d'information qu'elles gardent (1 = le mot entier)."""
    if word.isdigit():
        return [(word, 1.0)]
    forms = {word: 1.0}
    dv = _devowel(word)
    if dv != word:
        forms[dv] = 0.8
        for k in range(2, len(dv)):
            forms.setdefault(dv[:k], min(0.7, 0.2 + 0.13 * k))
    for k in range(2, len(word)):
        forms[word[:k]] = max(forms.get(word[:k], 0), min(0.75, 0.2 + 0.13 * k))
    forms[word[0]] = max(forms.get(word[0], 0), 0.3)
    return list(forms.items())


def _split(snapshot: str) -> tuple[list[str], list[str]]:
    """Snapshot → (mots du titre, mots de la section)."""
    parts = SEPARATORS.split(snapshot.strip())
    if len(parts) > 1 and ascii_words(parts[-1]):
        title, section = ascii_words(" ".join(parts[:-1])), ascii_words(parts[-1])
    else:
        words = ascii_words(snapshot)
        k = len(words) - 1
        if k >= 1 and words[k].isdigit() and len(words[k]) <= 2:
            k -= 1  # « Part 2 », « Verse 1 »
        title, section = (words[:k], words[k:]) if k >= 1 else (words, [])
    kept = [w for w in title if w.lower() not in STOP_WORDS]
    return kept or title[:1], section


def _best(title: list[str], section: list[str], budget: int) -> str:
    """Meilleure écriture « titre section » en `budget` caractères au plus."""
    words = [(w, 1.0 / (1 + 0.3 * i), "t") for i, w in enumerate(title)]
    words += [(w, 2.2 if j == 0 else 1.6, "s") for j, w in enumerate(section)]
    # Pour chaque longueur utilisée : (information gardée, texte, rôle du dernier mot gardé).
    states: dict[int, tuple[float, str, str | None]] = {0: (0.0, "", None)}
    for word, weight, role in words:
        nxt: dict[int, tuple[float, str, str | None]] = {}
        full = _cap(word)

        def keep(length, value, text, last):
            if length <= budget and (length not in nxt or nxt[length][0] < value):
                nxt[length] = (value, text, last)

        for used, (value, text, last) in states.items():
            keep(used, value, text, last)  # le mot disparaît
            for form, quality in _forms(word):
                form = _cap(form)
                if role == "s" and form != full:
                    quality *= 0.6  # la section se garde entière tant que possible
                gain = weight * (0.25 + quality)  # 0.25 : le mot est là, même par son initiale
                if last is None:
                    keep(used + len(form), value + gain, form, role)
                elif last == role == "t":  # dans le titre : CamelCase, ou un espace s'il reste de la place
                    keep(used + len(form), value + gain - 0.02, text + form, role)
                    keep(used + 1 + len(form), value + gain, f"{text} {form}", role)
                else:
                    keep(used + 1 + len(form), value + gain, f"{text} {form}", role)
        states = nxt
    return max(states.values(), key=lambda s: (s[0], -len(s[1])))[1]


def _head(short: str, limit: int) -> str:
    head = " ".join(ascii_words(short))
    if len(head) > limit // 2:  # un `short` trop long ne laisserait rien au snapshot
        head = "".join(_cap(_devowel(w)) for w in ascii_words(short))[: limit // 2]
    return head


def abbreviate(short: str, snapshot: str, limit: int = NAME_LEN, title_room: int | None = None) -> str:
    """`<short> <snapshot>` compressé à `limit` caractères (voir le module).

    `title_room` : place réservée au titre (même titre, même écriture dans un rig).
    """
    full = " ".join(filter(None, [" ".join(ascii_words(short)), " ".join(ascii_words(snapshot))]))
    if len(full) <= limit:
        return full
    head = _head(short, limit)
    budget = limit - len(head) - (1 if head else 0)
    title, section = _split(snapshot)
    if title and section and title_room is not None and 0 < title_room < budget - 1:
        left = _best(title, [], title_room)
        body = f"{left} {_best([], section, budget - len(left) - 1)}"
    else:
        body = _best(title, section, budget)
    return " ".join(filter(None, [head, body]))


def _title_rooms(short: str, names: list[str], limit: int) -> dict[tuple, int]:
    """Place du titre pour chaque titre du rig : ce que laisse sa plus longue section, gardée entière."""
    head = _head(short, limit)
    budget = limit - len(head) - (1 if head else 0)
    longest: dict[tuple, int] = {}
    for name in names:
        title, section = _split(name)
        if title and section:
            key = tuple(w.lower() for w in title)
            longest[key] = max(longest.get(key, 0), len(" ".join(section)))
    return {key: max(3, budget - 1 - n) for key, n in longest.items()}


def patch_names(rig: dict, limit: int = NAME_LEN) -> list[tuple[str, bool]]:
    """Nom écrit dans chaque patch du rig, et s'il a été compressé automatiquement.

    `patch_name` d'un snapshot l'emporte ; sinon `<short> <snapshot>` s'il
    tient, sinon sa compression. Deux compressions identiques reçoivent un
    numéro (« … 2 ») pour qu'on les distingue sur l'écran.
    """
    short = rig.get("short", rig.get("name", ""))
    rooms = _title_rooms(short, [s["name"] for s in rig["snapshots"]], limit)
    out: list[tuple[str, bool]] = []
    for snap in rig["snapshots"]:
        if snap.get("patch_name"):
            out.append((snap["patch_name"], False))
            continue
        full = f"{short} {snap['name']}".strip()
        if len(full) <= limit and full.isascii():
            out.append((full, False))
        else:
            title = tuple(w.lower() for w in _split(snap["name"])[0])
            out.append((abbreviate(short, snap["name"], limit, rooms.get(title)), True))
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

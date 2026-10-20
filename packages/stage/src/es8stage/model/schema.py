"""Fichiers du modèle pedalboard → rig → snapshot : lecture et validation.

Spéc : `docs/rig-model.md`. Les documents restent des dicts JSON (forme du
fichier) ; ce module les vérifie et résout les références entre fichiers.
Toutes les erreurs d'un document sont réunies dans une seule `ModelError`.
Aucune dépendance ni accès MIDI : utilisable tel quel dans Pyodide, où
l'app web passe les documents sans passer par le disque.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from ..codec import CodecError, parse_patch_label, patch_label
from ..names import NAME_LEN

PEDALBOARD_SCHEMA = "es8ctl.pedalboard/1"  # forme de la vue interne
PEDALBOARD_SCHEMA_V2 = "es8ctl.pedalboard/2"  # fichier : une liste d'appareils
SURFACE_SCHEMA = "es8ctl.surface/1"
RIG_SCHEMA = "es8ctl.rig/1"  # une banque, 8 snapshots au plus (`bank`)
RIG_SCHEMA_V2 = "es8ctl.rig/2"  # N snapshots sur des patchs consécutifs (`start`)
SETUP_SCHEMA = "es8ctl.setup/1"
SETLIST_SCHEMA = "es8ctl.setlist/1"
TRACK_SCHEMA = "es8ctl.track/1"
PROJECT_SCHEMA = "es8ctl.project/1"  # tout en un document (app web, export)

LOOP_NAMES = ("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "LV")
PROGRAM_CHANGE_MODES = ("none", "pc", "bank_msb_pc", "bank_lsb_pc", "bank_msb_lsb_pc")
ROLES = ("param", "loop", "tap", "es8")
SWITCH_MODES = ("momentary", "toggle")
# Switches d'une surface : NUM1-8, les switches de mode et les entrées CTL IN.
SWITCHES = (
    "NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8",
    "MEM_M", "MUTE", "BANK_D", "BANK_U", "CTL_IN_1", "CTL_IN_2", "CTL_IN_3", "CTL_IN_4",
)
SNAPSHOTS_PER_RIG = 8  # rig v1 : une banque
BANKS = 100
PATCHES = 800
MIDI_BANKS = 7  # banques MIDI de la pc_map
SETLIST_STEPS = 128
# Actions de ES8 Companion (docs/companion.md) : noms des paramètres d'un appareil `companion`.
COMPANION_ACTIONS = ("next", "prev", "next_song", "prev_song", "song_start", "backup")


class ModelError(CodecError):
    """Document du modèle invalide ; le message réunit tous les problèmes trouvés."""

    def __init__(self, where: str, problems: list[str]):
        self.where = where
        self.problems = problems
        super().__init__(f"{where}: " + " ".join(problems))


def _int(value, lo: int, hi: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and lo <= value <= hi


def _check_schema(doc, schema: str, where: str) -> list[str]:
    if not isinstance(doc, dict):
        raise ModelError(where, ["expected a JSON object."])
    if doc.get("schema") != schema:
        return [f'"schema" must be "{schema}" (got {doc.get("schema")!r}).']
    return []


def loop_name(token) -> str | None:
    """« L3 », « l3 », « 3 », « V », « LV » → nom canonique ; None si inconnu."""
    if isinstance(token, int) and not isinstance(token, bool):
        token = str(token)
    if not isinstance(token, str):
        return None
    token = token.strip().upper()
    if token in ("V", "LV"):
        return "LV"
    if token.isdigit():
        token = f"L{token}"
    return token if token in LOOP_NAMES else None


def _check_midi(midi: dict, at: str, problems: list[str]) -> None:
    """Partie MIDI d'un appareil : canal, mode de program change, programmes, paramètres (CC)."""
    if not _int(midi.get("channel"), 1, 16):
        problems.append(f"{at}.channel: expected 1-16.")
    mode = midi.get("program_change", "pc")
    if mode not in PROGRAM_CHANGE_MODES:
        problems.append(f"{at}.program_change: one of {', '.join(PROGRAM_CHANGE_MODES)}.")
    for prog_id, prog in (midi.get("programs") or {}).items():
        if not isinstance(prog, dict) or not _int(prog.get("pc"), 0, 127):
            problems.append(f"{at}.programs.{prog_id}.pc: expected 0-127.")
            continue
        for bank in ("bank_msb", "bank_lsb"):
            if bank in mode and not _int(prog.get(bank), 0, 127):
                problems.append(f"{at}.programs.{prog_id}.{bank}: expected 0-127 ({mode}).")
    companion = midi.get("companion", False)
    if not isinstance(companion, bool):
        problems.append(f"{at}.companion: expected true or false.")
    for param_id, param in (midi.get("params") or {}).items():
        pat = f"{at}.params.{param_id}"
        if companion is True and param_id not in COMPANION_ACTIONS:
            problems.append(f"{pat}: a companion device's parameters are its actions ({', '.join(COMPANION_ACTIONS)}).")
        if not isinstance(param, dict) or not _int(param.get("cc"), 0, 127):
            problems.append(f"{pat}.cc: expected 0-127.")
            continue
        for end in ("off", "on"):
            if end in param and not _int(param[end], 0, 127):
                problems.append(f"{pat}.{end}: expected 0-127.")


def _from_devices(doc: dict, where: str) -> dict:
    """Pedalboard v2 (appareils, chacun avec ses boucles et/ou son MIDI) → vue par boucle et par appareil MIDI.

    ```
    {"schema": "es8ctl.pedalboard/2",
     "devices": {"daw": {"name": "DAW", "loops": ["L6"], "midi": {"channel": 1, "programs": {…}, "params": {…}}},
                 "comp": {"name": "Compressor", "loops": ["L1"]}}}
    ```

    La vue a la forme v1 : `loops` {L: {name, device}} et `devices` (ceux qui
    reçoivent du MIDI) {id: {name, channel, …}}. Le reste du modèle ne lit que la vue.
    """
    problems: list[str] = []
    devices = doc.get("devices", {})
    if not isinstance(devices, dict):
        raise ModelError(where, ['"devices": expected an object {"id": {...}}.'])
    view = {"schema": PEDALBOARD_SCHEMA, "loops": {}, "devices": {}}
    for dev_id, dev in devices.items():
        at = f"devices.{dev_id}"
        if not isinstance(dev, dict) or not isinstance(dev.get("name"), str):
            problems.append(f'{at}: expected {{"name": …}}.')
            continue
        loops = dev.get("loops", [])
        if not isinstance(loops, list):
            problems.append(f"{at}.loops: expected a list (e.g. [\"L2\"]).")
            loops = []
        for token in loops:
            name = loop_name(token)
            if name is None:
                problems.append(f"{at}.loops: unknown loop {token!r} (L1…L8, LV).")
            elif name in view["loops"]:
                problems.append(f"{at}.loops: {name} is already used by {view['loops'][name]['name']!r}.")
            else:
                view["loops"][name] = {"name": dev["name"], "device": dev_id}
        midi = dev.get("midi")
        if midi is not None:
            if not isinstance(midi, dict):
                problems.append(f"{at}.midi: expected an object.")
                continue
            _check_midi(midi, f"{at}.midi", problems)
            view["devices"][dev_id] = {"name": dev["name"], **midi}
    if problems:
        raise ModelError(where, problems)
    return view


def check_pedalboard(doc: dict, where: str = "pedalboard") -> dict:
    """Valide un pedalboard (v2, ou v1 : boucles et appareils MIDI séparés) ; rend la vue v1."""
    if isinstance(doc, dict) and doc.get("schema") == PEDALBOARD_SCHEMA_V2:
        return _from_devices(doc, where)
    problems = _check_schema(doc, PEDALBOARD_SCHEMA, where)
    loops = doc.get("loops", {})
    if not isinstance(loops, dict):
        problems.append('"loops": expected an object {"L1": {...}}.')
        loops = {}
    for key, loop in loops.items():
        if loop_name(key) != key:
            problems.append(f"loops: unknown loop {key!r} (L1…L8, LV).")
        elif loop is not None and not (isinstance(loop, dict) and isinstance(loop.get("name"), str)):
            problems.append(f'loops.{key}: expected null or {{"name": …}}.')
    devices = doc.get("devices", {})
    if not isinstance(devices, dict):
        problems.append('"devices": expected an object.')
        devices = {}
    for dev_id, dev in devices.items():
        if not isinstance(dev, dict):
            problems.append(f"devices.{dev_id}: expected an object.")
            continue
        _check_midi(dev, f"devices.{dev_id}", problems)
    if problems:
        raise ModelError(where, problems)
    return doc


def device_param(pedalboard: dict, ref: str) -> tuple[str, dict, str, dict] | None:
    """« daw.drive » → (id appareil, appareil, id paramètre, paramètre) ; None si absent."""
    if not isinstance(ref, str) or ref.count(".") != 1:
        return None
    dev_id, param_id = ref.split(".")
    dev = (pedalboard.get("devices") or {}).get(dev_id)
    param = ((dev or {}).get("params") or {}).get(param_id)
    if param is None:
        return None
    return dev_id, dev, param_id, param


def check_surface(doc: dict, pedalboard: dict, where: str = "surface") -> dict:
    problems = _check_schema(doc, SURFACE_SCHEMA, where)
    switches = doc.get("switches", {})
    if not isinstance(switches, dict):
        raise ModelError(where, problems + ['"switches": expected an object {"NUM1": {...}}.'])
    for key, sw in switches.items():
        at = f"switches.{key}"
        if key not in SWITCHES:
            problems.append(f"{at}: unknown switch (one of {', '.join(SWITCHES)}).")
            continue
        if not isinstance(sw, dict) or sw.get("role") not in ROLES:
            problems.append(f"{at}.role: one of {', '.join(ROLES)}.")
            continue
        role = sw["role"]
        if role == "param":
            if device_param(pedalboard, sw.get("param")) is None:
                problems.append(f"{at}.param: {sw.get('param')!r} is not a <device>.<param> of the pedalboard.")
            if sw.get("mode", "toggle") not in SWITCH_MODES:
                problems.append(f"{at}.mode: momentary or toggle.")
        elif role == "loop":
            if not key.startswith("NUM"):
                problems.append(f"{at}: only NUM1-8 can switch a loop in manual mode.")
            name = loop_name(sw.get("loop"))
            if name is None or name == "LV":
                problems.append(f"{at}.loop: expected L1…L8.")
            elif not (pedalboard.get("loops") or {}).get(name):
                problems.append(f"{at}.loop: {name} is not wired in the pedalboard.")
        elif role == "es8":
            from ..names import CTL_FUNCTIONS

            if str(sw.get("function", "")).upper() not in CTL_FUNCTIONS:
                problems.append(f"{at}.function: one of {', '.join(CTL_FUNCTIONS)}.")
    if problems:
        raise ModelError(where, problems)
    return doc


def rig_start(doc: dict) -> int:
    """Premier patch d'un rig (0-799) : `start` (v2, numéro ou « 12-5 »), ou le premier patch de `bank` (v1)."""
    if doc.get("schema") == RIG_SCHEMA:
        return doc["bank"] * SNAPSHOTS_PER_RIG
    start = doc["start"]
    return parse_patch_label(start) if isinstance(start, str) else start


def rig_patches(doc: dict) -> range:
    """Patchs occupés par un rig, un par snapshot."""
    start = rig_start(doc)
    return range(start, start + len(doc["snapshots"]))


def resolve_program(dev: dict, value) -> dict | None:
    """Programme d'un appareil → {"pc", "bank_msb"?, "bank_lsb"?} ; None si invalide.

    Un programme s'écrit par son alias (nom défini dans le pedalboard), par
    son numéro (`12`), ou en entier (`{"pc": 12, "bank_msb": 0}`).
    """
    if isinstance(value, str):
        prog = (dev.get("programs") or {}).get(value)
        return prog if isinstance(prog, dict) and _int(prog.get("pc"), 0, 127) else None
    if _int(value, 0, 127):
        return {"pc": value}
    if isinstance(value, dict) and _int(value.get("pc"), 0, 127) and all(
        _int(value[k], 0, 127) for k in ("bank_msb", "bank_lsb") if k in value
    ):
        return value
    return None


def program_label(dev: dict, value) -> str:
    """Programme tel qu'affiché : son alias s'il en a un, sinon « PC 12 »."""
    if isinstance(value, str):
        prog = (dev.get("programs") or {}).get(value) or {}
        return prog.get("name") or value
    prog = resolve_program(dev, value) or {}
    alias = next((p.get("name") or k for k, p in (dev.get("programs") or {}).items()
                  if p.get("pc") == prog.get("pc") and all(p.get(b) == prog.get(b) for b in ("bank_msb", "bank_lsb"))), None)
    return alias or f"PC {prog.get('pc')}"


def _check_programs(programs, devices: dict, at: str, problems: list[str], allow_none: bool) -> None:
    if not isinstance(programs, dict):
        problems.append(f'{at}: expected an object {{"device": program}}.')
        return
    for dev_id, value in programs.items():
        dev = devices.get(dev_id)
        if dev is None:
            problems.append(f"{at}: unknown device {dev_id!r}.")
        elif value is None and allow_none:
            continue
        elif dev.get("program_change", "pc") == "none":
            problems.append(f"{at}.{dev_id}: this device takes no program change.")
        elif resolve_program(dev, value) is None:
            what = f"unknown program {value!r}" if isinstance(value, str) else f"invalid program {value!r}"
            problems.append(f"{at}.{dev_id}: {what} (an alias of the pedalboard, 0-127 or {{\"pc\": …}}).")


def check_rig(doc: dict, pedalboard: dict, where: str = "rig") -> dict:
    v2 = isinstance(doc, dict) and doc.get("schema") == RIG_SCHEMA_V2
    problems = _check_schema(doc, RIG_SCHEMA_V2 if v2 else RIG_SCHEMA, where)
    if not isinstance(doc.get("name"), str) or not doc["name"].strip():
        problems.append('"name": expected a non-empty string.')
    short = doc.get("short", doc.get("name", ""))
    if not isinstance(short, str):
        problems.append('"short": expected a string.')
        short = ""
    if v2:
        start = doc.get("start")
        if isinstance(start, str):
            try:
                parse_patch_label(start)
            except CodecError:
                problems.append(f'"start": {start!r} is not a patch (0-1 … 99-8).')
        elif not _int(start, 0, PATCHES - 1):
            problems.append(f'"start": expected the first patch, 0-{PATCHES - 1} or a label such as "12-5".')
    elif not _int(doc.get("bank"), 0, BANKS - 1):
        problems.append(f'"bank": expected 0-{BANKS - 1}.')
    wired = {k for k, v in (pedalboard.get("loops") or {}).items() if v}

    chain = doc.get("chain", [])
    chain_loops: set[str] | None = None
    if isinstance(chain, list):
        names = [loop_name(t) for t in chain]
        if None in names:
            problems.append(f'"chain": unknown loop in {chain!r} (L1…L8, LV).')
        elif len(set(names)) != len(names):
            problems.append('"chain": a loop appears twice.')
        else:
            chain_loops = set(names)
            for name in names:
                if name not in wired:
                    problems.append(f'"chain": {name} is not wired in the pedalboard.')
    elif not isinstance(chain, str):
        problems.append('"chain": expected a list of loops (input → output) or the screen notation.')

    devices = pedalboard.get("devices") or {}
    _check_programs(doc.get("programs", {}), devices, "programs", problems, allow_none=False)

    snapshots = doc.get("snapshots", [])
    if not isinstance(snapshots, list) or not snapshots:
        problems.append('"snapshots": expected a non-empty list.')
        snapshots = []
    elif not v2 and len(snapshots) > SNAPSHOTS_PER_RIG:
        problems.append(f'"snapshots": {len(snapshots)} given, {SNAPSHOTS_PER_RIG} at most (one bank; '
                        f'{RIG_SCHEMA_V2} has no such limit).')
    elif v2 and not problems and rig_start(doc) + len(snapshots) > PATCHES:
        problems.append(f'"snapshots": {len(snapshots)} from {patch_label(rig_start(doc))} go past the last patch (99-8).')
    seen: set[str] = set()
    for i, snap in enumerate(snapshots):
        at = f"snapshots[{i}]"
        if not isinstance(snap, dict) or not isinstance(snap.get("name"), str):
            problems.append(f'{at}: expected {{"name": …}}.')
            continue
        name = snap["name"]
        if name in seen:
            problems.append(f"{at}: the name {name!r} is used twice.")
        seen.add(name)
        full = f"{short} {name}".strip()
        if len(full) > NAME_LEN:
            problems.append(f"{at}: patch name {full!r} is {len(full)} characters, {NAME_LEN} at most.")
        if any(not 0x20 <= ord(c) <= 0x7E for c in full):
            problems.append(f"{at}: patch name {full!r} must be plain ASCII.")
        for token in snap.get("loops", []):
            loop = loop_name(token)
            if loop is None:
                problems.append(f"{at}.loops: unknown loop {token!r}.")
            elif loop not in wired:
                problems.append(f"{at}.loops: {loop} is not wired in the pedalboard.")
            elif chain_loops is not None and loop not in chain_loops:
                problems.append(f"{at}.loops: {loop} is not in the rig's chain.")
        if "programs" in snap:
            _check_programs(snap["programs"], devices, f"{at}.programs", problems, allow_none=True)
        for ref, value in (snap.get("params") or {}).items():
            if device_param(pedalboard, ref) is None:
                problems.append(f"{at}.params: {ref!r} is not a <device>.<param> of the pedalboard.")
            elif value not in ("on", "off") and not _int(value, 0, 127):
                problems.append(f"{at}.params.{ref}: on, off or 0-127.")
    if "backup" in doc and not (isinstance(doc["backup"], str) and doc["backup"]):
        problems.append('"backup": expected the backup rig (path, or id in a project).')
    for i, snap in enumerate(snapshots):
        if isinstance(snap, dict) and "backup" in snap:
            if not isinstance(snap["backup"], str):
                problems.append(f"snapshots[{i}].backup: expected a snapshot name of the backup rig.")
            elif "backup" not in doc:
                problems.append(f"snapshots[{i}].backup: the rig has no backup rig.")
    _rig_devices(doc, pedalboard, problems)
    if problems:
        raise ModelError(where, problems)
    return doc


def device_ids(pedalboard: dict) -> list[str]:
    """Appareils du pedalboard : ceux des boucles (v2) et ceux qui reçoivent du MIDI."""
    ids = [loop["device"] for loop in (pedalboard.get("loops") or {}).values() if loop and loop.get("device")]
    return list(dict.fromkeys([*ids, *(pedalboard.get("devices") or {})]))


def _rig_devices(doc: dict, pedalboard: dict, problems: list[str]) -> None:
    """`devices` : les appareils dont le rig se sert ; rien d'autre ne peut y être référencé.

    Absent = tous. Les appareils `companion` (contrôleurs de la Companion) sont toujours permis.
    """
    if "devices" not in doc:
        return
    used = doc["devices"]
    known = device_ids(pedalboard)
    if not isinstance(used, list) or not all(isinstance(d, str) for d in used):
        problems.append('"devices": expected a list of device ids.')
        return
    for dev_id in used:
        if dev_id not in known:
            problems.append(f"devices: unknown device {dev_id!r}.")
    allowed = set(used) | {d for d, dev in (pedalboard.get("devices") or {}).items() if dev.get("companion")}
    loops = pedalboard.get("loops") or {}

    def check(dev_id, what):
        if dev_id and dev_id not in allowed:
            problems.append(f"{what}: device {dev_id!r} is not used by this rig (add it to \"devices\").")

    if isinstance(doc.get("chain"), list):
        for token in doc["chain"]:
            loop = loops.get(loop_name(token) or "")
            if loop:
                check(loop.get("device"), f"chain: {loop_name(token)}")
    for dev_id in doc.get("programs") or {}:
        check(dev_id, "programs")
    for i, snap in enumerate(doc.get("snapshots") or []):
        if not isinstance(snap, dict):
            continue
        for dev_id in snap.get("programs") or {}:
            check(dev_id, f"snapshots[{i}].programs")
        for ref in snap.get("params") or {}:
            check(ref.split(".")[0] if isinstance(ref, str) else None, f"snapshots[{i}].params.{ref}")


def check_track(doc: dict, where: str = "track") -> dict:
    """Un morceau : un rig et son déroulé (noms de snapshots dans l'ordre joué, répétitions comprises)."""
    problems = _check_schema(doc, TRACK_SCHEMA, where)
    if not isinstance(doc.get("name"), str):
        problems.append('"name": expected a string.')
    if not isinstance(doc.get("rig"), str):
        problems.append('"rig": expected the rig (path, or id in a project).')
    sequence = doc.get("sequence", [])
    if not isinstance(sequence, list) or not all(isinstance(n, str) for n in sequence):
        problems.append('"sequence": expected a list of snapshot names.')
    if problems:
        raise ModelError(where, problems)
    return doc


def check_setlist(doc: dict, where: str = "setlist") -> dict:
    """Un enchaînement de morceaux : `{"track": …}`, ou un morceau écrit sur place `{"rig", "sequence"}`."""
    problems = _check_schema(doc, SETLIST_SCHEMA, where)
    songs = doc.get("songs")
    if not isinstance(songs, list):
        problems.append('"songs": expected a list.')
        songs = []
    for i, song in enumerate(songs):
        if isinstance(song, dict) and "name" in song and not isinstance(song["name"], str):
            problems.append(f"songs[{i}].name: expected a string.")
        if isinstance(song, dict) and isinstance(song.get("track"), str):
            continue
        if not isinstance(song, dict) or not isinstance(song.get("rig"), str):
            problems.append(f'songs[{i}]: expected {{"track": …}} or {{"rig": …, "sequence": [...]}}.')
        elif not isinstance(song.get("sequence"), list):
            problems.append(f"songs[{i}].sequence: expected a list of snapshot names.")
    if problems:
        raise ModelError(where, problems)
    return doc


# ---------------------------------------------------------------- projet sur disque


@dataclass
class Rig:
    path: Path
    doc: dict
    surface: dict | None
    pedalboard: dict

    @property
    def start(self) -> int:
        return rig_start(self.doc)

    def patch(self, snapshot: int) -> int:
        return self.start + snapshot


@dataclass
class Project:
    """`setup.json` et tout ce qu'il référence (ou un document `es8ctl.project/1`), validé.

    Sur disque, une référence (morceau d'une setlist, rig d'un morceau) est
    un chemin relatif au fichier qui la contient ; dans un document projet,
    un id.
    """

    path: Path | None
    pedalboard: dict
    rigs: dict[int, Rig] = field(default_factory=dict)  # premier patch → rig
    setlists: dict[int, tuple[Path | None, dict]] = field(default_factory=dict)  # banque MIDI → setlist
    rig_ids: dict[str, Rig] | None = None  # document projet : id → rig
    tracks: dict[str, dict] | None = None  # document projet : id → morceau

    def place(self, rig: Rig, where: str) -> None:
        """Range un rig à son premier patch ; refuse deux rigs sur les mêmes patchs."""
        mine = set(rig_patches(rig.doc))
        for other in self.rigs.values():
            shared = sorted(mine & set(rig_patches(other.doc)))
            if shared:
                raise ModelError(where, [
                    f"patches {patch_label(shared[0])}…{patch_label(shared[-1])} are already used by rig {other.doc['name']!r}."
                ])
        self.rigs[rig.start] = rig

    def backup_for(self, rig: Rig, snapshot: str) -> tuple[Rig, str] | None:
        """Secours d'un snapshot : (rig de secours, snapshot) ; le premier snapshot sans lien propre."""
        if not rig.doc.get("backup"):
            return None
        backup = self.rig_for(rig.doc["backup"], rig.path)
        snap = next(s for s in rig.doc["snapshots"] if s["name"] == snapshot)
        return backup, snap.get("backup") or backup.doc["snapshots"][0]["name"]

    def check_backups(self) -> None:
        """Chaque rig de secours existe, n'est pas le rig lui-même, et contient les snapshots désignés."""
        for rig in self.rigs.values():
            ref = rig.doc.get("backup")
            if not ref:
                continue
            where = f"rig {rig.doc['name']!r}"
            backup = self.rig_for(ref, rig.path)
            if backup is None:
                raise ModelError(where, [f"backup: unknown rig {ref!r}."])
            if backup is rig:
                raise ModelError(where, ["backup: a rig cannot be its own backup."])
            names = [s["name"] for s in backup.doc["snapshots"]]
            missing = [s["backup"] for s in rig.doc["snapshots"] if s.get("backup") and s["backup"] not in names]
            if missing:
                raise ModelError(where, [f"backup: rig {backup.doc['name']!r} has no snapshot {m!r}." for m in missing])

    def rig_for(self, ref: str, from_path: Path | None) -> Rig | None:
        if self.rig_ids is not None:
            return self.rig_ids.get(ref)
        resolved = (Path(from_path).parent / ref).resolve()
        return next((r for r in self.rigs.values() if r.path.resolve() == resolved), None)

    def track_for(self, ref: str, from_path: Path | None) -> tuple[dict, Path | None] | None:
        """Morceau désigné par une setlist : (document, fichier) ; None s'il n'existe pas."""
        if self.tracks is not None:
            track = self.tracks.get(ref)
            return (track, None) if track is not None else None
        path = Path(from_path).parent / ref
        if not path.is_file():
            return None
        return check_track(read_json(path), ref), path


def read_json(path: Path) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ModelError(str(path), ["file not found."]) from None
    except json.JSONDecodeError as exc:
        raise ModelError(str(path), [f"invalid JSON ({exc})."]) from None


def load_rig(path: Path, pedalboard: dict | None = None) -> Rig:
    """Charge un rig et ses références (pedalboard, surface), relatives au fichier du rig."""
    path = Path(path)
    doc = read_json(path)
    if doc.get("pedalboard"):
        pedalboard = check_pedalboard(read_json(path.parent / doc["pedalboard"]), doc["pedalboard"])
    if pedalboard is None:
        raise ModelError(str(path), ['"pedalboard": no pedalboard given.'])
    check_rig(doc, pedalboard, str(path))
    surface = None
    if doc.get("surface"):
        surface = check_surface(read_json(path.parent / doc["surface"]), pedalboard, doc["surface"])
    return Rig(path, doc, surface, pedalboard)


def load_project(path: Path) -> Project:
    path = Path(path)
    doc = read_json(path)
    problems = _check_schema(doc, SETUP_SCHEMA, str(path))
    if problems:
        raise ModelError(str(path), problems)
    if not isinstance(doc.get("pedalboard"), str):
        raise ModelError(str(path), ['"pedalboard": expected a path.'])
    pedalboard = check_pedalboard(read_json(path.parent / doc["pedalboard"]), doc["pedalboard"])
    project = Project(path, pedalboard)
    for key, rel in (doc.get("rigs") or {}).items():
        rig = load_rig(path.parent / rel, pedalboard)
        declared = rig.doc["bank"] if rig.doc["schema"] == RIG_SCHEMA else rig.doc["start"]
        if str(declared) != str(key):
            what = "bank" if rig.doc["schema"] == RIG_SCHEMA else "start"
            raise ModelError(str(path), [f"rigs.{key}: {rel} declares {what} {declared}."])
        project.place(rig, str(path))
    for key, rel in (doc.get("setlists") or {}).items():
        if not (str(key).isdigit() and int(key) < MIDI_BANKS):
            raise ModelError(str(path), [f"setlists.{key}: MIDI bank must be 0-{MIDI_BANKS - 1}."])
        setlist_path = path.parent / rel
        project.setlists[int(key)] = (setlist_path, check_setlist(read_json(setlist_path), rel))
    project.check_backups()
    return project


def project_from_doc(doc: dict, where: str = "project") -> Project:
    """Document `es8ctl.project/1` : pedalboard, surfaces, rigs et setlists par id.

    ```
    {"schema": "es8ctl.project/1", "pedalboard": {...},
     "surfaces": {"lead": {...}}, "rigs": {"crunch": {..., "surface": "lead"}},
     "tracks": {"song-a": {..., "rig": "crunch", "sequence": ["Verse", "Chorus"]}},
     "setlists": {"november": {..., "midi_bank": 1, "songs": [{"track": "song-a"}]}}}
    ```
    """
    problems = _check_schema(doc, PROJECT_SCHEMA, where)
    if problems:
        raise ModelError(where, problems)
    pedalboard = check_pedalboard(doc.get("pedalboard") or {}, f"{where}.pedalboard")
    surfaces = {}
    for sid, surface in (doc.get("surfaces") or {}).items():
        surfaces[sid] = check_surface(surface, pedalboard, f"surface {sid!r}")
    project = Project(None, pedalboard, rig_ids={}, tracks={})
    for rid, rig_doc in (doc.get("rigs") or {}).items():
        check_rig(rig_doc, pedalboard, f"rig {rid!r}")
        sid = rig_doc.get("surface")
        if sid and sid not in surfaces:
            raise ModelError(f"rig {rid!r}", [f"unknown surface {sid!r}."])
        rig = Rig(Path(rid), rig_doc, surfaces.get(sid) if sid else None, pedalboard)
        project.place(rig, f"rig {rid!r}")
        project.rig_ids[rid] = rig
    for tid, track in (doc.get("tracks") or {}).items():
        project.tracks[tid] = check_track(track, f"track {tid!r}")
    for lid, setlist in (doc.get("setlists") or {}).items():
        check_setlist(setlist, f"setlist {lid!r}")
        bank = setlist.get("midi_bank")
        if not _int(bank, 0, MIDI_BANKS - 1):
            raise ModelError(f"setlist {lid!r}", [f'"midi_bank": expected 0-{MIDI_BANKS - 1}.'])
        if bank in project.setlists:
            raise ModelError(f"setlist {lid!r}", [f"MIDI bank {bank} is already used by another setlist."])
        project.setlists[bank] = (None, setlist)
    project.check_backups()
    return project


def load_any(path: Path) -> tuple[str, object]:
    """Fichier donné au CLI : ("project", Project) pour setup.json ou un document projet, ("rig", Rig) sinon."""
    doc = read_json(path)
    if doc.get("schema") == PROJECT_SCHEMA:
        return "project", project_from_doc(doc, str(path))
    if doc.get("schema") == SETUP_SCHEMA:
        return "project", load_project(path)
    return "rig", load_rig(path)

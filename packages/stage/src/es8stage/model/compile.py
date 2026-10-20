"""Compilation rig → banque ES-8, setlist → pc_map.

Produit le même format de changements que `transform` (`{patches, system}`),
consommé par `apply` (CLI) ou `_accept` (web) : aucun nouveau chemin vers
l'ES-8. Ne garde que les vrais changements, donc recompiler un rig contre
un dump relu donne `{}` quand la banque est synchronisée (divergence).

Encodages (listes de valeurs de l'éditeur officiel, es_parameter.js) :
`midi_tx_ch` 0 = OFF, 1-16 ; `midi_pc`, `midi_pc_bank_*` et `midi_ctl*_cc`
0 = OFF, puis valeur + 1 ; `assign_target_cc_ch` 0-15 = canaux 1-16 ;
`assign_mode` 0 = MOM, 1 = TGL. `manual_number*` (Play Option, libellés
OFF, 1-8, défaut 0) : 1-8 pris pour les loops L1-L8 ; ce que fait OFF reste
à observer, donc seul le rôle `loop` l'écrit (test matériel n° 4).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..codec import BulkDump, CodecError, patch_label, unpack_page
from ..names import ASSIGN_SOURCES, ASSIGN_TARGETS, CTL_FUNCTIONS, CTL_SLOTS, LOOPS, NAME_LEN
from ..patch import decode_patch
from ..routing import parse as parse_chain
from ..system import PC_MAP_ENTRIES, decode_system
from .abbrev import patch_names
from .schema import (
    RIG_SCHEMA,
    SNAPSHOTS_PER_RIG,
    ModelError,
    Project,
    Rig,
    check_pedalboard,
    check_rig,
    check_setlist,
    DEFAULT_COMPANION,
    check_surface,
    device_param,
    loop_name,
    resolve_program,
    rig_start,
)

MIDI_SLOTS = 8
ASSIGNS = 12
MIDI_TARGET = ASSIGN_TARGETS.index("MIDI")
BPM = CTL_FUNCTIONS.index("BPM")

# Switch de surface → (index dans ctl_func, source d'assign).
_CTL_SLOT = {f"NUM{i}": CTL_SLOTS.index(f"NUM_{i}") for i in range(1, 9)} | {
    "MEM_M": CTL_SLOTS.index("MEM_MAN"), "MUTE": CTL_SLOTS.index("MUTE"),
    "BANK_D": CTL_SLOTS.index("BANK_D"), "BANK_U": CTL_SLOTS.index("BANK_U"),
} | {f"CTL_IN_{i}": CTL_SLOTS.index(f"CTL_IN_{i}") for i in range(1, 5)}
# Hypothèse : les sources CTL1-4 de l'assign sont les entrées CTL IN 1-4.
_ASSIGN_SOURCE = {f"NUM{i}": ASSIGN_SOURCES.index(f"NUM{i}") for i in range(1, 9)} | {
    k: ASSIGN_SOURCES.index(k) for k in ("MEM_M", "MUTE", "BANK_D", "BANK_U")
} | {f"CTL_IN_{i}": ASSIGN_SOURCES.index(f"CTL{i}") for i in range(1, 5)}
# Fonction par défaut d'un switch (ctl_func d'usine) : rendue quand le rôle le demande.
_DEFAULT_FUNC = {f"NUM{i}": CTL_FUNCTIONS.index(f"NUM_{i}") for i in range(1, 9)}

_MIDI_FIELDS = (
    "midi_tx_ch", "midi_pc_bank_lsb", "midi_pc_bank_msb", "midi_pc",
    "midi_ctl1_cc", "midi_ctl1_cc_val", "midi_ctl2_cc", "midi_ctl2_cc_val", "midi_transmit",
)
_ASSIGN_FIELDS = (
    "assign_source", "assign_mode", "assign_target", "assign_target_cc_ch", "assign_target_cc_no",
    "assign_target_min", "assign_target_max", "assign_act_range_lo", "assign_act_range_hi",
)


@dataclass
class Compiled:
    """Résultat d'une compilation : changements pour `apply`, avertissements, champs possédés."""

    changes: dict
    warnings: list[str] = field(default_factory=list)
    owns: dict = field(default_factory=dict)  # {"patches": {label: [champs]}, "system": [champs]}
    system_wanted: dict = field(default_factory=dict)  # valeurs système voulues, changées ou non


def _off(value) -> int:
    """Valeur d'appareil (0-127) → champ « 0 = OFF »."""
    return 0 if value is None else value + 1


def chain_notation(chain) -> str:
    """Chaîne du rig → notation de l'écran (`loop_chain`).

    Liste = ordre du signal (entrée → sortie) ; la notation va de la sortie
    vers l'entrée. Les loops non citées sont rangées côté entrée (coupées),
    V tout au bout s'il n'est pas cité, comme sur le patch d'usine.
    Une chaîne déjà en notation de l'écran passe telle quelle.
    """
    if isinstance(chain, str):
        return chain
    names = [loop_name(t) for t in chain]
    symbol = {name: ("V" if name == "LV" else name[1]) for name in LOOPS}
    unused = [n for n in reversed(LOOPS[:8]) if n not in names]
    tail = [] if "LV" in names else ["LV"]
    return "".join(symbol[n] for n in [*reversed(names), *unused, *tail])


def _value(param: dict, value) -> int:
    if value == "on":
        return param.get("on", 127)
    if value == "off":
        return param.get("off", 0)
    return value


def snapshot_programs(rig: dict, snapshot: dict) -> dict:
    """Programmes envoyés par un snapshot : ceux du rig, surchargés par les siens (`null` = aucun PC)."""
    merged = {**(rig.get("programs") or {}), **(snapshot.get("programs") or {})}
    return {dev_id: value for dev_id, value in merged.items() if value is not None}


def _midi_slots(pedalboard: dict, rig: dict, snapshot: dict) -> list[dict]:
    """Slots MIDI d'un snapshot : par appareil, son PC (celui du rig ou le sien) puis 2 CC par slot."""
    devices = pedalboard.get("devices") or {}
    programs = snapshot_programs(rig, snapshot)
    used: dict[str, list[str]] = {}  # appareil → paramètres pilotés par au moins un snapshot
    for snap in rig["snapshots"]:
        for ref in snap.get("params") or {}:
            dev_id, _, param_id, _ = device_param(pedalboard, ref)
            used.setdefault(dev_id, [])
            if param_id not in used[dev_id]:
                used[dev_id].append(param_id)
    order = [d for d in devices if d in programs or d in used]
    slots: list[dict] = []
    for dev_id in order:
        dev = devices[dev_id]
        mode = dev.get("program_change", "pc")
        prog = resolve_program(dev, programs[dev_id]) if dev_id in programs else None
        params = sorted(used.get(dev_id, []), key=list(dev.get("params") or {}).index)
        values = snapshot.get("params") or {}
        pairs = [
            (dev["params"][p]["cc"], _value(dev["params"][p], values.get(f"{dev_id}.{p}", "off")))
            for p in params
        ]
        for start in range(0, max(len(pairs), 1), 2):
            first = start == 0
            chunk = pairs[start : start + 2] + [(None, 0)] * (2 - len(pairs[start : start + 2]))
            slots.append({
                "midi_tx_ch": dev["channel"],
                "midi_pc": _off(prog["pc"]) if first and prog else 0,
                "midi_pc_bank_msb": _off(prog.get("bank_msb")) if first and prog and "msb" in mode else 0,
                "midi_pc_bank_lsb": _off(prog.get("bank_lsb")) if first and prog and "lsb" in mode else 0,
                "midi_ctl1_cc": _off(chunk[0][0]), "midi_ctl1_cc_val": chunk[0][1],
                "midi_ctl2_cc": _off(chunk[1][0]), "midi_ctl2_cc_val": chunk[1][1],
                "midi_transmit": 0,  # AUTO : envoyé au rappel du patch
            })
    return slots


def _surface_fields(pedalboard: dict, surface: dict, patch: dict, companion: dict) -> tuple[dict, dict]:
    """Champs de patch (ctl_func, assigns) et système (manual_number) d'une surface.

    Une surface possède les 12 assigns : ceux qu'elle n'utilise pas sont coupés.
    Un switch `companion` est un assign comme un `param` : momentané, il envoie
    le CC de son action sur le canal de la Companion.
    """
    system: dict = {}
    fields: dict = {name: list(patch[name]) for name in _ASSIGN_FIELDS}
    fields["assign_sw"] = [0] * ASSIGNS
    fields["ctl_func"] = list(patch["ctl_func"])
    slot = 0
    for key, sw in surface["switches"].items():
        role = sw["role"]
        if role in ("param", "companion"):
            if role == "param":
                _, dev, _, param = device_param(pedalboard, sw["param"])
                channel, cc, lo, hi, mode = dev["channel"], param["cc"], param.get("off", 0), param.get("on", 127), sw.get("mode", "toggle")
            else:
                channel, cc, lo, hi, mode = companion["channel"], companion["cc"][sw["action"]], 0, 127, "momentary"
            if slot >= ASSIGNS:
                raise ModelError("surface", [f"more than {ASSIGNS} param switches: the ES-8 has {ASSIGNS} assigns."])
            fields["assign_sw"][slot] = 1
            for name, value in (
                ("assign_source", _ASSIGN_SOURCE[key]),
                ("assign_mode", 1 if mode == "toggle" else 0),
                ("assign_target", MIDI_TARGET),
                ("assign_target_cc_ch", channel - 1),
                ("assign_target_cc_no", cc),
                ("assign_target_min", lo),
                ("assign_target_max", hi),
                ("assign_act_range_lo", 0),
                ("assign_act_range_hi", 127),
            ):
                fields[name][slot] = value
            slot += 1
        if key not in _DEFAULT_FUNC:  # switches de mode et CTL IN : pas de manual_number
            if role == "companion":  # BANK ▲ ne doit pas aussi changer de banque : la Companion choisit le patch
                fields["ctl_func"][_CTL_SLOT[key]] = CTL_FUNCTIONS.index("OFF")
            elif role == "tap":
                fields["ctl_func"][_CTL_SLOT[key]] = BPM
            elif role == "es8":
                fields["ctl_func"][_CTL_SLOT[key]] = CTL_FUNCTIONS.index(sw["function"].upper())
            continue
        number = f"manual_number{key[3:]}"
        if role == "loop":
            fields["ctl_func"][_CTL_SLOT[key]] = _DEFAULT_FUNC[key]
            system[number] = LOOPS.index(loop_name(sw["loop"])) + 1
        elif role in ("param", "companion"):
            fields["ctl_func"][_CTL_SLOT[key]] = _DEFAULT_FUNC[key]
        elif role == "tap":
            fields["ctl_func"][_CTL_SLOT[key]] = BPM
        else:
            fields["ctl_func"][_CTL_SLOT[key]] = CTL_FUNCTIONS.index(sw["function"].upper())
    return fields, system


def _patch(dump: BulkDump, index: int) -> dict:
    if index not in dump.patches:
        raise CodecError(f"Patch {patch_label(index)} is missing or incomplete in the dump.")
    return decode_patch(unpack_page(dump.patches[index]))


def _only_changes(wanted: dict, current: dict) -> dict:
    return {k: v for k, v in wanted.items() if current.get(k) != v}


def compile_rig(pedalboard: dict, surface: dict | None, rig: dict, dump: BulkDump, companion: dict | None = None) -> Compiled:
    """Rig → changements de ses patchs (et `manual_number` système). Pur, sans MIDI.

    Sans surface, les switches (ctl_func, assigns) ne sont pas touchés.
    """
    pedalboard = check_pedalboard(pedalboard)
    check_rig(rig, pedalboard)
    if surface is not None:
        check_surface(surface, pedalboard)
    out = Compiled({"patches": {}}, owns={"patches": {}, "system": []})
    names = patch_names(rig)
    notation = chain_notation(rig.get("chain", []))
    disabled: set[int] = set()

    for i, snap in enumerate(rig["snapshots"]):
        index = rig_start(rig) + i
        label = patch_label(index)
        before = _patch(dump, index)
        on = {loop_name(t) for t in snap.get("loops", [])}
        wanted: dict = {
            "name": names[i][0].ljust(NAME_LEN),
            "loop_sw": [int(name in on) for name in LOOPS],
        }
        slots = _midi_slots(pedalboard, rig, snap)
        if len(slots) > MIDI_SLOTS:
            raise ModelError(label, [f"{len(slots)} MIDI slots needed, the ES-8 has {MIDI_SLOTS} per patch."])
        for name in _MIDI_FIELDS:
            wanted[name] = [s[name] for s in slots] + [0] * (MIDI_SLOTS - len(slots))
        if surface is not None:
            fields, out.system_wanted = _surface_fields(pedalboard, surface, before, companion or DEFAULT_COMPANION)
            disabled |= {k for k, v in enumerate(before["assign_sw"]) if v and not fields["assign_sw"][k]}
            wanted.update(fields)

        changed = _only_changes(wanted, before)
        if parse_chain(notation, base=before["loop_position"]) != before["loop_position"]:
            changed["loop_chain"] = notation
        if changed:
            out.changes["patches"][label] = changed
        out.owns["patches"][label] = sorted([*wanted, "loop_chain"])

    if out.system_wanted:
        if dump.system is None:
            raise CodecError("The dump has no system block: the surface's loop switches cannot be set.")
        system = _only_changes(out.system_wanted, decode_system(dump.system))
        if system:
            out.changes["system"] = system
    out.owns["system"] = sorted(out.system_wanted)
    out.warnings += [f"{rig['name']}: {w}" for w in _rig_warnings(pedalboard, rig, disabled)]
    out.warnings += [
        f"{rig['name']}: patch {patch_label(rig_start(rig) + i)} is named {name!r} (shortened from {snap['name']!r})."
        for i, ((name, auto), snap) in enumerate(zip(names, rig["snapshots"])) if auto
    ]
    return out


def _rig_warnings(pedalboard: dict, rig: dict, disabled: set[int]) -> list[str]:
    warnings = []
    if isinstance(rig.get("chain"), list):
        chain = {loop_name(t) for t in rig["chain"]}
        used = rig.get("devices")
        for name, loop in (pedalboard.get("loops") or {}).items():
            if loop and name not in chain and (used is None or loop.get("device") in used):
                warnings.append(f"{name} ({loop['name']}) is wired but not in the chain: it stays off.")
    free = SNAPSHOTS_PER_RIG - len(rig["snapshots"]) if rig["schema"] == RIG_SCHEMA else 0
    if free:
        first = rig["bank"] * SNAPSHOTS_PER_RIG + len(rig["snapshots"])
        warnings.append(
            f"{free} patch(es) of bank {rig['bank']} have no snapshot "
            f"({patch_label(first)}…{rig['bank']}-8): left as they are."
        )
    if disabled:
        warnings.append(f"Assign(s) {', '.join(str(k + 1) for k in sorted(disabled))} were on and are switched off.")
    return warnings


@dataclass
class SetlistStep:
    """Un pas de setlist mis à plat : son morceau (index), le rig, le snapshot et le patch (0-799).

    `backup` : (rig, snapshot, patch) de secours, si le rig en désigne un.
    """

    song: int
    rig: Rig
    snapshot: str
    patch: int
    backup: tuple[Rig, str, int] | None = None


def setlist_steps(project: Project, setlist: dict, setlist_path=None) -> tuple[list[dict], list[SetlistStep]]:
    """Morceaux (`name`, `rig`) et pas d'une setlist, dans l'ordre joué : le pas i est le PC i.

    Seule source de la mise à plat : la `pc_map` (`compile_setlist`) et le
    show de la Companion (`export_show`) ne peuvent pas diverger.
    """
    check_setlist(setlist)
    songs: list[dict] = []
    steps: list[SetlistStep] = []
    problems: list[str] = []
    if not setlist["songs"]:
        problems.append("no track yet.")
    for i, song in enumerate(setlist["songs"]):
        rig_ref, sequence, base, label = song.get("rig"), song.get("sequence"), setlist_path, f"songs[{i}]"
        name = song.get("name")
        if "track" in song:
            found = project.track_for(song["track"], setlist_path)
            if found is None:
                problems.append(f"{label}: unknown track {song['track']!r}.")
                continue
            track, track_path = found
            rig_ref, sequence, label = track["rig"], track.get("sequence", []), f"track {track['name']!r}"
            base, name = track_path or setlist_path, track["name"]
        rig = project.rig_for(rig_ref, base)
        if rig is None:
            problems.append(f"{label}: unknown rig {rig_ref!r}.")
            continue
        if not sequence:
            problems.append(f"{label}: no step in its running order.")
        names = [s["name"] for s in rig.doc["snapshots"]]
        for snap in sequence:
            if snap not in names:
                problems.append(f"{label}: rig {rig.doc['name']!r} has no snapshot {snap!r}.")
            else:
                step = SetlistStep(len(songs), rig, snap, rig.patch(names.index(snap)))
                found = project.backup_for(rig, snap)
                if found:
                    brig, bsnap = found
                    bnames = [s["name"] for s in brig.doc["snapshots"]]
                    step.backup = (brig, bsnap, brig.patch(bnames.index(bsnap)))
                steps.append(step)
        songs.append({"name": name or rig.doc["name"], "rig": rig})
    backups = len(backup_pcs(steps))
    if len(steps) + backups > PC_MAP_ENTRIES:
        problems.append(f"{len(steps)} steps and {backups} backup patches, {PC_MAP_ENTRIES} at most per setlist.")
    if problems:
        raise ModelError(setlist.get("name", "setlist"), problems)
    return songs, steps


def backup_pcs(steps: list[SetlistStep]) -> dict[int, int]:
    """Patch de secours → son PC : rangés en haut de la banque MIDI (127, 126…), dans l'ordre d'apparition."""
    pcs: dict[int, int] = {}
    for step in steps:
        if step.backup and step.backup[2] not in pcs:
            pcs[step.backup[2]] = PC_MAP_ENTRIES - 1 - len(pcs)
    return pcs


def pc_map_entries(steps: list[SetlistStep]) -> list[int]:
    """Les 128 entrées d'une banque MIDI de la pc_map.

    Les pas en bas (PC i = pas i), les patchs de secours en haut (127, 126…) ;
    entre les deux, le dernier pas répété : un « suivant » de trop ne sort pas du concert.
    """
    patches = [s.patch for s in steps]
    entries = patches + [patches[-1]] * (PC_MAP_ENTRIES - len(patches))
    for patch, pc in backup_pcs(steps).items():
        entries[pc] = patch
    return entries


def compile_setlist(project: Project, midi_bank: int, setlist: dict, setlist_path=None) -> Compiled:
    """Setlist → entrées de `pc_map_bank<b>_pc` : le PC i rappelle le pas i.

    Les entrées après le dernier pas le répètent : un « suivant » de trop
    ne sort pas du concert.
    """
    _, steps = setlist_steps(project, setlist, setlist_path)
    name = f"pc_map_bank{midi_bank}_pc"
    return Compiled({"patches": {}}, owns={"patches": {}, "system": [name]}, system_wanted={name: pc_map_entries(steps)})


def compile_project(project: Project, dump: BulkDump) -> Compiled:
    """Tous les rigs et setlists de `setup.json` ; seuls les vrais changements restent.

    Le mode manuel est commun à tout l'ES-8 : deux surfaces ne peuvent pas
    donner deux valeurs au même `manual_number`.
    """
    out = Compiled({"patches": {}}, owns={"patches": {}, "system": []})
    sources: dict[str, str] = {}
    parts = [(r.doc["name"], compile_rig(r.pedalboard, r.surface, r.doc, dump, project.companion)) for r in project.rigs.values()]
    parts += [
        (setlist.get("name", f"setlist {midi_bank}"), compile_setlist(project, midi_bank, setlist, path))
        for midi_bank, (path, setlist) in sorted(project.setlists.items())
    ]
    for source, part in parts:
        out.changes["patches"].update(part.changes["patches"])
        out.owns["patches"].update(part.owns["patches"])
        for key, value in part.system_wanted.items():
            if key in out.system_wanted and out.system_wanted[key] != value:
                raise ModelError("setup", [
                    f"{key}: {sources[key]!r} wants {out.system_wanted[key]}, {source!r} wants {value} "
                    "(manual mode is shared by the whole ES-8)."
                ])
            out.system_wanted[key] = value
            sources[key] = source
        out.warnings += part.warnings
    out.owns["system"] = sorted(out.system_wanted)
    if out.system_wanted:
        if dump.system is None:
            raise CodecError("The dump has no system block: system fields cannot be set.")
        system = _only_changes(out.system_wanted, decode_system(dump.system))
        if system:
            out.changes["system"] = system
    return out

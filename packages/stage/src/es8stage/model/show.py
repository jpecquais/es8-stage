"""Projet → show (`es8ctl.show/1`) : ce que ES8 Companion joue sur scène.

Spéc : `docs/companion.md`. Le show est autonome (aucune référence à
résoudre) et ne contient que ce que la Companion affiche ; les pas viennent
de `setlist_steps`, comme la `pc_map`, donc le PC i du show rappelle bien
le patch du pas i sur l'ES-8.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime

from es8core.codec import patch_label
from .compile import _value, backup_pcs, pc_map_entries, setlist_steps, snapshot_programs
from .schema import (
    COMPANION_ROLES,
    SWITCHES,
    Project,
    Rig,
    device_param,
    loop_name,
    program_label,
    resolve_program,
    switch_cc,
)

SHOW_SCHEMA = "es8ctl.show/1"
COMPANION_LABELS = {"next": "Next", "prev": "Previous", "next_song": "Next song", "prev_song": "Previous song",
                    "song_start": "Song start", "backup": "Backup"}
DEFAULT_RX_CHANNEL = 1  # canal de réception de l'ES-8 d'usine ; la Companion le laisse changer


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "setlist"


def _rig_ids(project: Project) -> dict[int, str]:
    """Premier patch → id du rig dans le show : son id dans un document projet, sinon le nom de son fichier."""
    if project.rig_ids is not None:
        return {rig.start: rid for rid, rig in project.rig_ids.items()}
    ids: dict[int, str] = {}
    for start, rig in sorted(project.rigs.items()):
        rid = rig.path.stem
        ids[start] = rid if rid not in ids.values() else f"{rid}-{start}"
    return ids


def _switch(pedalboard: dict, sw: dict, aliases: dict) -> dict:
    """Switch de surface tel que la Companion l'affiche ; l'alias du rig (« Drive ») l'emporte sur le nom générique."""
    role = sw["role"]
    out = {"role": role}
    if role == "param":
        _, dev, param_id, param = device_param(pedalboard, sw["param"])
        out["mode"] = sw.get("mode", "toggle")
        out["target"] = f"{dev['name']} · {param.get('name', param_id)}"
        # Ce que la Companion envoie quand le switch bascule (elle tient l'état).
        out |= {"param": sw["param"], "channel": dev["channel"], "cc": param["cc"],
                "on": param.get("on", 127), "off": param.get("off", 0)}
        if "value" in sw:  # un cran : allumé seulement quand le paramètre vaut exactement cette valeur
            out |= {"on": sw["value"], "exact": True}
        if sw.get("group"):
            out["group"] = sw["group"]
        label = param.get("name", param_id)
        if aliases.get(sw["param"]):
            return {"label": aliases[sw["param"]], **out}
    elif role == "loop":
        out["target"] = loop_name(sw["loop"])
        label = pedalboard["loops"][out["target"]]["name"]
    elif role == "companion":
        out["target"] = sw["action"]
        label = COMPANION_LABELS[sw["action"]]
    elif role == "es8":
        out["target"] = str(sw["function"]).upper()
        label = out["target"]
    else:
        label = "Tap"
    return {"label": sw.get("label") or label, **out}


def _chain(pedalboard: dict, chain) -> list[dict]:
    """Loops de la chaîne, de l'entrée vers la sortie (la notation de l'écran va dans l'autre sens)."""
    if isinstance(chain, str):
        tokens = [c for c in reversed(chain.upper()) if c in "12345678V"]
    else:
        tokens = list(chain)
    loops = pedalboard.get("loops") or {}
    out = []
    for token in tokens:
        name = loop_name(token)
        if name and loops.get(name):
            out.append({"loop": name, "device": loops[name]["name"]})
    return out


def _program(devices: dict, dev_id: str, value) -> dict:
    dev = devices[dev_id]
    return {"device": dev["name"], "program": program_label(dev, value), "pc": resolve_program(dev, value)["pc"]}


def _rig(rig: Rig) -> dict:
    pedalboard, doc = rig.pedalboard, rig.doc
    devices = pedalboard.get("devices") or {}
    out = {
        "name": doc["name"],
        "patches": [patch_label(rig.patch(i)) for i in range(len(doc["snapshots"]))],
        "snapshots": [s["name"] for s in doc["snapshots"]],
        "chain": _chain(pedalboard, doc.get("chain", [])),
        "programs": [_program(devices, dev_id, value) for dev_id, value in (doc.get("programs") or {}).items()],
    }
    overrides = {
        s["name"]: [_program(devices, dev_id, value) for dev_id, value in snapshot_programs(doc, s).items()]
        for s in doc["snapshots"] if s.get("programs")
    }
    if overrides:
        out["snapshot_programs"] = overrides
    if rig.surface is not None:
        switches = rig.surface.get("switches", {})
        out["surface"] = {
            "name": rig.surface.get("name", ""),
            "switches": {key: _switch(pedalboard, sw, doc.get("aliases") or {}) for key, sw in switches.items()},
        }
        refs = list(dict.fromkeys(sw["param"] for sw in switches.values() if sw["role"] == "param"))
        if refs:
            # État de départ de chaque paramètre piloté par un switch : ce que le patch envoie au rappel.
            out["states"] = {
                snap["name"]: {ref: _value(device_param(pedalboard, ref)[3], (snap.get("params") or {}).get(ref, "off"))
                               for ref in refs}
                for snap in doc["snapshots"]
            }
    return out


def _controls(rigs: list[Rig], companion: dict) -> dict | None:
    """Canal et CC des switches de l'ES-8 dont la Companion tient la logique, dans les rigs du show."""
    keys = [key for rig in rigs if rig.surface is not None
            for key, sw in rig.surface.get("switches", {}).items() if sw["role"] in COMPANION_ROLES]
    if not keys:
        return None
    ordered = [k for k in SWITCHES if k in keys]
    return {"channel": companion["channel"], "switches": {k: switch_cc(companion, k) for k in ordered}}


def _input_preset(rigs: list[Rig], companion: dict) -> dict | None:
    """Format ancien : switches qui pilotent un appareil `companion` → table d'entrée.

    Les switches au rôle `companion` passent par `controls` : la Companion lit leur action dans le rig en cours.
    """
    bindings: list[dict] = []
    sources: list[str] = []
    for rig in rigs:
        if rig.surface is None:
            continue
        for sw in rig.surface.get("switches", {}).values():
            if sw["role"] == "param":
                _, dev, action, param = device_param(rig.pedalboard, sw["param"])
                if not dev.get("companion"):
                    continue
                binding = {"action": action, "type": "cc", "channel": dev["channel"], "number": param["cc"]}
            else:
                continue
            if binding not in bindings:
                bindings.append(binding)
            name = rig.surface.get("name", "")
            if name not in sources:
                sources.append(name)
    if not bindings:
        return None
    return {"source": "surface " + ", ".join(sources), "bindings": bindings}


def export_show(project: Project, exported: str | None = None) -> dict:
    """Toutes les setlists du projet (par banque MIDI), les rigs qu'elles jouent et le préréglage d'entrée."""
    rig_ids = _rig_ids(project)
    setlists, used = [], {}
    for midi_bank, (path, setlist) in sorted(project.setlists.items()):
        songs, steps = setlist_steps(project, setlist, path)
        if not steps:
            continue  # setlist encore vide (créée dans le Designer) : rien à jouer
        firsts: dict[int, int] = {}
        for i, step in enumerate(steps):
            firsts.setdefault(step.song, i)
        entries = pc_map_entries(steps)
        pcs = backup_pcs(steps)
        name = setlist.get("name") or f"Setlist {midi_bank}"
        setlists.append({
            "id": path.stem if path is not None else _slug(name),
            "name": name,
            "midi_bank": midi_bank,
            "pc_map": "sha256:" + hashlib.sha256(bytes(b for e in entries for b in e.to_bytes(2, "big"))).hexdigest(),
            "songs": [
                {"name": song["name"], "rig": rig_ids[song["rig"].start], "first_step": firsts[k],
                 "steps": sum(1 for s in steps if s.song == k)}
                | {key: song[key] for key in ("tempo", "key", "notes") if key in song}
                for k, song in enumerate(songs)
            ],
            "steps": [
                {"song": s.song, "snapshot": s.snapshot, "patch": s.patch, "label": patch_label(s.patch)}
                | ({"backup": {"rig": s.backup[0].doc["name"], "snapshot": s.backup[1], "pc": pcs[s.backup[2]],
                               "label": patch_label(s.backup[2])}} if s.backup else {})
                for s in steps
            ],
        })
        for song in songs:
            used[song["rig"].start] = song["rig"]
    show = {
        "schema": SHOW_SCHEMA,
        "exported": exported or datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "es8": {"rx_channel": project.companion["es8_channel"]},
        "setlists": setlists,
        "rigs": {rig_ids[start]: _rig(rig) for start, rig in sorted(used.items())},
    }
    controls = _controls([rig for _, rig in sorted(used.items())], project.companion)
    if controls:
        show["controls"] = controls
    preset = _input_preset([rig for _, rig in sorted(used.items())], project.companion)
    if preset:
        show["input_preset"] = preset
    if project.favorites:  # rappelés directement par leur patch (pas par la pc_map)
        show["favorites"] = [
            {"name": sound, "rig": rig.doc["name"],
             "label": patch_label(rig.patch([s["name"] for s in rig.doc["snapshots"]].index(sound)))}
            for rig, sound in project.favorites
        ]
    return show

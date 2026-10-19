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

from ..codec import patch_label
from .compile import pc_map_entries, setlist_steps
from .schema import Project, Rig, device_param, loop_name

SHOW_SCHEMA = "es8ctl.show/1"
DEFAULT_RX_CHANNEL = 1  # canal de réception de l'ES-8 d'usine ; la Companion le laisse changer


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "setlist"


def _rig_ids(project: Project) -> dict[int, str]:
    """Banque → id du rig dans le show : son id dans un document projet, sinon le nom de son fichier."""
    if project.rig_ids is not None:
        return {rig.doc["bank"]: rid for rid, rig in project.rig_ids.items()}
    ids: dict[int, str] = {}
    for bank, rig in sorted(project.rigs.items()):
        rid = rig.path.stem
        ids[bank] = rid if rid not in ids.values() else f"{rid}-{bank}"
    return ids


def _switch(pedalboard: dict, sw: dict) -> dict:
    role = sw["role"]
    out = {"role": role}
    if role == "param":
        _, dev, param_id, param = device_param(pedalboard, sw["param"])
        out["mode"] = sw.get("mode", "toggle")
        out["target"] = f"{dev['name']} · {param.get('name', param_id)}"
        label = param.get("name", param_id)
    elif role == "loop":
        out["target"] = loop_name(sw["loop"])
        label = pedalboard["loops"][out["target"]]["name"]
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


def _rig(rig: Rig) -> dict:
    pedalboard, doc = rig.pedalboard, rig.doc
    devices = pedalboard.get("devices") or {}
    out = {
        "name": doc["name"],
        "bank": doc["bank"],
        "snapshots": [s["name"] for s in doc["snapshots"]],
        "chain": _chain(pedalboard, doc.get("chain", [])),
        "programs": [
            {"device": devices[dev_id]["name"], "program": devices[dev_id]["programs"][prog_id].get("name", prog_id),
             "pc": devices[dev_id]["programs"][prog_id]["pc"]}
            for dev_id, prog_id in (doc.get("programs") or {}).items()
        ],
    }
    if rig.surface is not None:
        out["surface"] = {
            "name": rig.surface.get("name", ""),
            "switches": {key: _switch(pedalboard, sw) for key, sw in rig.surface.get("switches", {}).items()},
        }
    return out


def _input_preset(rigs: list[Rig]) -> dict | None:
    """Switches de surface qui pilotent un appareil `companion` → table d'entrée toute faite."""
    bindings: list[dict] = []
    sources: list[str] = []
    for rig in rigs:
        if rig.surface is None:
            continue
        for sw in rig.surface.get("switches", {}).values():
            if sw["role"] != "param":
                continue
            _, dev, action, param = device_param(rig.pedalboard, sw["param"])
            if not dev.get("companion"):
                continue
            binding = {"action": action, "type": "cc", "channel": dev["channel"], "number": param["cc"]}
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
        firsts: dict[int, int] = {}
        for i, step in enumerate(steps):
            firsts.setdefault(step.song, i)
        entries = pc_map_entries(steps)
        name = setlist.get("name") or f"Setlist {midi_bank}"
        setlists.append({
            "id": path.stem if path is not None else _slug(name),
            "name": name,
            "midi_bank": midi_bank,
            "pc_map": "sha256:" + hashlib.sha256(bytes(b for e in entries for b in e.to_bytes(2, "big"))).hexdigest(),
            "songs": [
                {"name": song["name"], "rig": rig_ids[song["rig"].doc["bank"]], "first_step": firsts[k],
                 "steps": sum(1 for s in steps if s.song == k)}
                for k, song in enumerate(songs)
            ],
            "steps": [
                {"song": s.song, "snapshot": s.snapshot, "patch": s.patch, "label": patch_label(s.patch)}
                for s in steps
            ],
        })
        for song in songs:
            used[song["rig"].doc["bank"]] = song["rig"]
    show = {
        "schema": SHOW_SCHEMA,
        "exported": exported or datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "es8": {"rx_channel": DEFAULT_RX_CHANNEL},
        "setlists": setlists,
        "rigs": {rig_ids[bank]: _rig(rig) for bank, rig in sorted(used.items())},
    }
    preset = _input_preset([rig for _, rig in sorted(used.items())])
    if preset:
        show["input_preset"] = preset
    return show

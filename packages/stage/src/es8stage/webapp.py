"""Pont Python d'ES8 Designer dans le navigateur (Pyodide) : celui de l'éditeur, plus les rigs.

Le moteur web de l'éditeur (`es8/web/shared/engine.js`) charge ce module à la place de
`es8core.webapp` (point d'extension `ES8_ENGINE.module`) : toutes les fonctions de
l'éditeur restent disponibles (`__getattr__`), et s'y ajoutent :

- `rig_preview(json)`, `rig_stage(json)` : document projet (`es8ctl.project/1`) compilé
  contre l'état lu de l'ES-8 ;
- `patch_names(json)` : noms de patch d'un rig ; `show_export(json)` : show de ES8 Companion.
"""

from __future__ import annotations

import json

from es8core import webapp as core
from es8core.codec import patch_label


def __getattr__(name: str):
    return getattr(core, name)


def _rig_needs(project) -> list[str]:
    """Patchs (et « system ») à lire sur l'ES-8 avant de pouvoir compiler le projet."""
    dump = core.state["dump"]
    needed = [patch_label(rig.patch(i)) for _, rig in sorted(project.rigs.items())
              for i in range(len(rig.doc["snapshots"]))]
    missing = [label for label in needed if dump is None or _index(label) not in dump.patches]
    wants_system = bool(project.setlists) or any(
        r.surface and any(sw.get("role") == "loop" for sw in r.surface.get("switches", {}).values())
        for r in project.rigs.values()
    )
    if wants_system and (dump is None or dump.system is None):
        missing.insert(0, "system")
    return missing


def _index(label: str) -> int:
    from es8core.codec import parse_patch_label

    return parse_patch_label(label)


def _compile_doc(project_json: str):
    from .model import compile_project, project_from_doc

    project = project_from_doc(json.loads(project_json))
    missing = _rig_needs(project)
    if missing:
        return project, None, missing
    return project, compile_project(project, core.state["dump"]), []


def rig_preview(project_json: str) -> str:
    """Compile le projet contre l'appareil (sans les modifications en attente).

    Rend les problèmes (refus), les avertissements, les champs à écrire par
    patch, les patchs à lire d'abord, et `in_sync` quand rien n'est à écrire.
    """
    from es8core.codec import CodecError
    from .model import ModelError

    try:
        _, result, missing = _compile_doc(project_json)
    except ModelError as exc:
        return json.dumps({"error": str(exc), "where": exc.where, "problems": exc.problems})
    except (CodecError, ValueError, KeyError, TypeError) as exc:
        return json.dumps({"error": str(exc), "problems": [str(exc)]})
    if missing:
        return json.dumps({"missing": missing})
    changes = result.changes
    patches = {}
    for label, fields in changes["patches"].items():
        patches[label] = sorted(fields)
    system = sorted(changes.get("system", {}))
    pending_labels = set(core.pending["patches"]) | ({"system"} if core.pending["system"] else set())
    staged = all(
        all(core.pending["patches"].get(label, {}).get(k) == v for k, v in fields.items())
        for label, fields in changes["patches"].items()
    ) and all(core.pending["system"].get(k) == v for k, v in changes.get("system", {}).items())
    return json.dumps({
        "patches": patches, "system": system, "warnings": result.warnings,
        "owns": result.owns, "in_sync": not patches and not system,
        "staged": staged and bool(patches or system),
        "other_pending": sorted(pending_labels - set(patches) - ({"system"} if system else set())),
    })


def rig_stage(project_json: str) -> str:
    """Ajoute la compilation du projet aux modifications en attente (écrites par « Write »)."""
    from es8core.codec import CodecError
    from .model import ModelError

    try:
        _, result, missing = _compile_doc(project_json)
    except (ModelError, CodecError, ValueError, KeyError, TypeError) as exc:
        return json.dumps({"error": str(exc)})
    if missing:
        return json.dumps({"error": f"Read these from the ES-8 first: {', '.join(missing)}."})
    return core._accept(result.changes)


def patch_names(rig_json: str) -> str:
    """Noms de patch d'un rig (16 caractères), et lesquels ont été raccourcis : [[nom, auto], …]."""
    from .model.abbrev import patch_names as names

    try:
        return json.dumps(names(json.loads(rig_json)))
    except (KeyError, TypeError, ValueError, AttributeError):
        return json.dumps([])


def show_export(project_json: str) -> str:
    """Show de ES8 Companion (`es8ctl.show/1`) calculé depuis le projet ; aucun accès à l'ES-8."""
    from es8core.codec import CodecError
    from .model import ModelError, export_show, project_from_doc

    try:
        show = export_show(project_from_doc(json.loads(project_json)))
    except ModelError as exc:
        return json.dumps({"error": str(exc), "where": exc.where, "problems": exc.problems})
    except (CodecError, ValueError, KeyError, TypeError) as exc:
        return json.dumps({"error": str(exc), "problems": [str(exc)]})
    if not show["setlists"]:
        return json.dumps({"error": "This project has no setlist.", "problems": ["This project has no setlist."]})
    return json.dumps({"show": show})

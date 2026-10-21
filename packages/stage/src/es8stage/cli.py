"""CLI es8stage : serve · rig (compile, status, show).

Les rigs se compilent en changements pour `es8ctl apply` (l'éditeur, dépôt es8) : ni nouveau
chemin d'écriture ni nouveau format. Spécs : docs/rig-model.md, docs/companion.md, docs/stage-host.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import typer
from es8core.codec import CodecError
from es8ctl.cli import _emit_changes, _fail, _load_base, _print_json

app = typer.Typer(help="ES Eight Stage: rigs, setlists and the stage apps for the BOSS ES-8.", no_args_is_help=True)
rig_app = typer.Typer(
    help="Rigs (docs/rig-model.md): compile a rig or a whole project into a changes JSON for `es8ctl apply`."
)
app.add_typer(rig_app, name="rig")


def _compile_model(source: Path, base: Path):
    """setup.json ou document projet (rigs + setlists), ou un seul rig, compilé contre le dump."""
    from .model import compile_project, compile_rig, load_any

    dump = _load_base(base)
    try:
        kind, loaded = load_any(source)
        if kind == "project":
            return compile_project(loaded, dump)
        return compile_rig(loaded.pedalboard, loaded.surface, loaded.doc, dump)
    except CodecError as exc:
        _fail(2, error=str(exc), problems=getattr(exc, "problems", None))


@rig_app.command("compile")
def rig_compile(
    source: Path = typer.Argument(..., exists=True, readable=True, help="setup.json, a project file (ES8 Designer export) or a rig file."),
    base: Path = typer.Option(..., "--base", "-b", exists=True, readable=True, help="ES-8 dump."),
    out: Path = typer.Option(None, "--out", "-o", help="Output file (otherwise stdout)."),
) -> None:
    """Compile rigs (and setlists) into the patch and system fields they own."""
    result = _compile_model(source, base)
    _emit_changes(result.changes, out, {"op": "rig compile", "source": str(source),
                                        "system_changed": sorted(result.changes.get("system", {})),
                                        "warnings": result.warnings})


@rig_app.command("status")
def rig_status(
    source: Path = typer.Argument(..., exists=True, readable=True, help="setup.json, a project file (ES8 Designer export) or a rig file."),
    base: Path = typer.Option(..., "--base", "-b", exists=True, readable=True,
                              help="Fresh dump of the ES-8 (es8ctl read)."),
) -> None:
    """Tell whether the ES-8 still matches the files (exit 1 if it has drifted)."""
    result = _compile_model(source, base)
    drift = {label: sorted(fields) for label, fields in result.changes["patches"].items()}
    system = sorted(result.changes.get("system", {}))
    _print_json({"in_sync": not drift and not system, "patches": drift, "system": system,
                 "warnings": result.warnings})
    if drift or system:
        raise typer.Exit(code=1)


@rig_app.command("show")
def rig_show(
    source: Path = typer.Argument(..., exists=True, readable=True, help="setup.json or a project file (ES8 Designer export)."),
    out: Path = typer.Option(None, "--out", "-o", help="Output file (otherwise stdout)."),
) -> None:
    """Export the setlists as a show file for ES8 Companion (docs/companion.md)."""
    from .model import export_show, load_any

    try:
        kind, loaded = load_any(source)
        if kind != "project":
            _fail(2, error="A show needs setlists: give setup.json or a project file, not a rig.")
        show = export_show(loaded)
    except CodecError as exc:
        _fail(2, error=str(exc), problems=getattr(exc, "problems", None))
    if not show["setlists"]:
        _fail(2, error="This project has no setlist.")
    text = json.dumps(show, ensure_ascii=False, indent=2) + "\n"
    if out:
        out.write_text(text, encoding="utf-8")
        _print_json({"show": str(out), "setlists": [s["name"] for s in show["setlists"]],
                     "steps": sum(len(s["steps"]) for s in show["setlists"])})
    else:
        sys.stdout.write(text)


@app.command()
def serve(
    port: int = typer.Option(8765, "--port", help="HTTP port (80 on the Pi)."),
    open_browser: bool = typer.Option(True, "--open/--no-open", help="Open the browser."),
    app_name: str = typer.Option("designer", "--app", help="App to open: designer, companion, host or control."),
    lan: bool = typer.Option(False, "--lan", help="Also serve on the local network (tablet or phone on the same Wi-Fi)."),
    stage: bool = typer.Option(False, "--stage", help="Stage host (docs/stage-host.md): this machine plays the show and "
                               "talks MIDI to the ES-8; every page goes through it. Needs mido + python-rtmidi."),
    midi: str = typer.Option("WIDI", "--midi", help="With --stage: part of the ES-8's MIDI port name."),
    ble: str = typer.Option("", "--ble", help="With --stage: Bluetooth address of a BLE MIDI adapter to reconnect when it drops."),
    data: Path = typer.Option(None, "--data", help="Data folder (show, library, password). Default: ~/.local/share/es8stage."),
) -> None:
    """Serve ES8 Designer, ES8 Companion, the host page and ES8 Control. Ctrl-C to stop."""
    import webbrowser

    from .server.http import data_dir, lan_address, make_server

    data = data or data_dir()
    host = None
    if stage:
        from .server.stage_server import StageServer

        host = StageServer(data / "show.json", midi_match=midi, ble_address=ble or None, log=lambda m: typer.echo(m, err=True))
        host.start()
    server = make_server(port, lan=lan, host=host, data=data)
    typer.echo(f"ES8 Designer: http://localhost:{port}/designer/  ·  ES8 Companion: http://localhost:{port}/companion/"
               f"  ·  host page: http://localhost:{port}/host/  (Ctrl-C to stop)", err=True)
    if lan:
        typer.echo(f"On the network: http://{lan_address()}:{port}/", err=True)
    if open_browser:
        webbrowser.open(f"http://localhost:{port}/{app_name}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    app()


if __name__ == "__main__":
    main()

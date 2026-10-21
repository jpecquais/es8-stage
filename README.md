# ES Eight Stage

Rigs, setlists and a stage companion for the BOSS ES-8 Effects Switching
System, built on [es8](https://github.com/jpecquais/es8) (the ES-8 engine,
`es8ctl` and the ES8 Control editor).

- **ES8 Designer** describes your pedalboard, rigs of N snapshots (loops,
  programs and parameters of every MIDI device), footswitch roles and
  setlists, and writes the ES-8 patches and program-change map for you.
- **ES8 Companion** plays the setlist on stage: it holds the footswitch logic
  (toggles, momentary switches, exclusive groups, selector steps, backup
  rigs) and shows what is on.
- **The stage host** runs everything on a Raspberry Pi next to the ES-8: it
  plays the show on its own, owns the MIDI link, keeps a library of projects,
  shows and ES-8 backups, and serves every app to the tablet, phone or
  computer on its network (host page at `/host/`, password-protected).
- **es8stage**, the command line: `es8stage rig compile | status | show`
  turn rigs into changes for `es8ctl apply`, and `es8stage serve` runs the
  apps.

Status: alpha, used on one rig. Not published as a website yet.

## Run it

```sh
git clone --recurse-submodules https://github.com/jpecquais/es8-stage
cd es8-stage
uv sync
uv run es8stage serve            # http://localhost:8765/designer/
```

On a Raspberry Pi as a stage host (BLE MIDI adapter or USB-MIDI interface to
the ES-8):

```sh
deploy/pi/push.sh es8@pedalbrain.local --midi WIDI --ble <adapter address>
```

## Layout

```
es8/                 the editor (git submodule): es8core, es8ctl, ES8 Control
packages/stage/      es8stage: rig model and compiler, stage logic, server
web/designer/        ES8 Designer
web/companion/       ES8 Companion
web/host/            host page of the stage host
web/stage-shared/    plugs the editor's web engine into es8stage and the host
deploy/pi/           Raspberry Pi service and install scripts
docs/                rig model, Companion, stage host, hardware tests
```

## Specifications

- `docs/rig-model.md`: pedalboard → rig → snapshot, setlists, compilation.
- `docs/companion.md`: the stage app, footswitch roles, show file.
- `docs/stage-host.md`: the Raspberry Pi stage host, library, host page.
- `docs/hardware-tests.md`: what was verified on the ES-8.

## License

GNU Affero General Public License v3.0 or later (`LICENSE`).

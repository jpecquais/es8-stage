// ES8 Companion — l'app de scène (Preact + htm, sans compilation). Textes en
// anglais. Spéc : docs/companion.md. Elle joue un show exporté par la lib :
// une action (contrôleur MIDI, clavier, écran) déplace la position et envoie
// à l'ES-8 le Program Change du pas. Pas de Pyodide, pas de SysEx.

import { html, render, useState, useEffect, useRef } from "../shared/vendor/preact-htm.module.js";
import * as S from "./show.js";
import { openWebMidi } from "./midi.js";

const STORE_KEY = "es8companion";
const INBOX = "es8companion/incoming"; // déposé par ES8 Designer (« Show »)
// Show courant du serveur (es8stage serve, le Pi) : pris à l'ouverture et suivi ; un show chargé ici y est déposé.
// Sans serveur (site statique), ces requêtes échouent en silence et l'app marche comme avant.
const SERVER_SHOW = "../stage/show.json";
const SERVER_POLL_MS = 5000;
// outName / inName : null = jamais choisi (choix automatique), "" = aucun port.
const DEFAULT_PREFS = {
  outName: null, inName: null, channel: 0, keyboard: true, wake: true,
  view: "setlist", panel: true, bindingsCustom: false, // view : setlist | switches (la vue de scène)
};
const NUMS = ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8"];
const ROLE_TAG = { loop: (sw) => sw.target || "LOOP", param: (sw) => (sw.mode === "momentary" ? "MOM" : "CC"), tap: () => "TAP", es8: () => "ES-8", companion: (sw) => sw.target.replace("_", " ").toUpperCase() };

let transport = null;

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
}
function saveStore(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* stockage indisponible : l'app marche sans */ }
}

/** Ports utilisés : ceux choisis, sinon la première sortie et l'entrée du même nom. */
// Ports logiciels que le système crée tout seul (session réseau macOS, IAC, synthé Windows, Midi Through
// Linux) : jamais un appareil, donc écartés du choix automatique.
const VIRTUAL_PORT = /r[ée]seau|network|session|\biac\b|gestionnaire iac|microsoft gs|wavetable|midi through/i;
const firstReal = (ports) => ports.find((p) => !VIRTUAL_PORT.test(p.name)) || ports[0];

function pickPorts(prefs, inputs, outputs) {
  const out = prefs.outName === null ? firstReal(outputs) : outputs.find((p) => p.name === prefs.outName);
  const inp = prefs.inName === null
    ? inputs.find((p) => out && p.name === out.name) || firstReal(inputs)
    : inputs.find((p) => p.name === prefs.inName);
  return { out: out || null, inp: inp || null };
}

const ICONS = {
  left: "M15 18l-6-6 6-6", right: "M9 18l6-6-6-6", down: "M6 9l6 6 6-6", close: "M18 6L6 18M6 6l12 12",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", menu: "M4 6h16M4 12h16M4 18h16",
};
const Icon = ({ name, size = 20 }) => html`
  <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${ICONS[name]} /></svg>`;

// ---------------------------------------------------------------- app

function App() {
  const boot = useRef(null);
  if (boot.current === null) {
    const saved = loadStore();
    const show = saved.show && !S.checkShow(saved.show).length ? saved.show : null;
    boot.current = { ...saved, show, pos: show ? S.validPosition(show, saved.pos) : null };
  }
  const [show, setShow] = useState(boot.current.show);
  const [pos, setPos] = useState(boot.current.pos);
  const [bindings, setBindings] = useState(boot.current.bindings || S.presetBindings(boot.current.show));
  const [prefs, setPrefs] = useState({ ...DEFAULT_PREFS, ...boot.current.prefs });
  const [backup, setBackup] = useState(!!boot.current.backup);
  const [states, setStates] = useState({}); // paramètres pilotés par les switches de l'ES-8, pour le pas en cours
  const [move, setMove] = useState({ n: 0, dir: "" }); // dernier déplacement (animation de la vue Switches)
  const [screen, setScreen] = useState("stage");
  const [songsOpen, setSongsOpen] = useState(false);
  const [browse, setBrowse] = useState(null);
  const [learning, setLearning] = useState(null);
  const [midi, setMidi] = useState({ status: "pending", inputs: [], outputs: [] });
  const [traffic, setTraffic] = useState({ in: "", action: "", out: "" });
  const [error, setError] = useState("");
  const debounce = useRef(S.makeDebounce()).current;
  // Mode « écran d'un hôte de scène » (docs/stage-host.md) : la page servie par un `es8stage serve --stage`
  // ne touche pas au MIDI ; elle affiche l'état poussé par l'hôte et lui envoie les gestes.
  const remote = useRef(false);
  const [host, setHost] = useState(null); // {connected, port} du MIDI de l'hôte
  const post = (cmd) => fetch("../stage/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) }).catch(() => {});

  // Les callbacks MIDI et clavier sont posés une fois : ils lisent l'état ici.
  const live = useRef({});
  live.current = { ...live.current, show, pos, bindings, prefs, learning, backup, states };

  // À chaque pas, l'état repart de celui du snapshot (le patch vient d'envoyer ces valeurs).
  // Avec un hôte de scène, c'est lui qui tient l'état.
  useEffect(() => {
    if (remote.current) return;
    const next = show && pos ? S.startStates(show, pos) : {};
    live.current.states = next;
    setStates(next);
  }, [show, pos && pos.setlist, pos && pos.step]);

  useEffect(() => saveStore({ show, pos, bindings, prefs, backup }), [show, pos, bindings, prefs, backup]);

  const setPref = (patch) => setPrefs((p) => ({ ...p, ...patch }));
  const channel = () => live.current.prefs.channel || (live.current.show && live.current.show.es8 && live.current.show.es8.rx_channel) || 1;

  function sendStep(p) {
    const sl = live.current.show.setlists[p.setlist];
    const play = S.played(sl.steps[p.step], p.step, live.current.backup);
    const sent = !!transport && transport.send(S.stepMessages(channel(), sl.midi_bank, play.pc));
    setTraffic((t) => ({ ...t, out: sent ? `${sl.midi_bank ? `bank ${sl.midi_bank} · ` : ""}PC ${play.pc}${play.backup ? " · backup" : ""}` : "not sent: no output" }));
  }
  function goTo(p, label) {
    if (remote.current) { post({ type: "goto", setlist: p.setlist, step: p.step }); setSongsOpen(false); return; }
    live.current.pos = p;
    setPos(p);
    setMove((m) => ({ n: m.n + 1, dir: "jump", at: Date.now() }));
    sendStep(p);
    setTraffic((t) => ({ ...t, in: "screen", action: label }));
    setSongsOpen(false);
  }
  function act(action, source) {
    if (remote.current) { post({ type: "act", action }); return; }
    const L = live.current;
    if (!L.show) return;
    if (action === "backup") { // bascule : le pas en cours repart sur son secours, ou revient au son normal
      live.current.backup = !L.backup;
      setBackup(live.current.backup);
      setTraffic((t) => ({ ...t, in: source, action: live.current.backup ? "Backup on" : "Backup off" }));
      sendStep(L.pos);
      return;
    }
    const p = S.move(L.show, L.pos, action);
    setTraffic((t) => ({ ...t, in: source, action: S.actionLabel(action) + (p ? "" : " · end") }));
    if (!p) { setMove((m) => ({ n: m.n + 1, dir: "end", at: Date.now() })); return; }
    live.current.pos = p; // un second appui avant le rendu part de la nouvelle position
    setPos(p);
    setMove((m) => ({ n: m.n + 1, dir: action, at: Date.now() }));
    sendStep(p);
  }
  /** Un switch de l'ES-8 : son rôle dans le rig en cours (action, ou paramètre envoyé à sa machine). */
  function handleSwitch(sw) {
    const L = live.current;
    if (!L.show || !L.pos || L.learning) return;
    if (sw.press && !debounce({ type: "cc", channel: 0, number: sw.key }, performance.now())) return;
    const r = S.pressSwitch(L.show, L.pos, sw.key, sw.press, L.states || {});
    if (!r) return;
    if (r.action) { act(r.action, sw.key); return; }
    live.current.states = r.states;
    setStates(r.states);
    const sent = !!transport && r.messages.every((m) => transport.send(m));
    const more = r.messages.length > 1 ? ` (+${r.messages.length - 1} off)` : "";
    setTraffic({ in: sw.key, action: `${r.label} ${r.on ? "on" : "off"}`,
      out: sent ? `ch ${(r.message[0] & 0x0f) + 1} · CC${r.message[1]} = ${r.message[2]}${more}` : "not sent: no output" });
  }

  function handleInput(event, source) {
    if (!event.press) return;
    const L = live.current;
    if (L.learning) {
      const action = L.learning;
      setBindings((b) => S.learn(b, action, event));
      setPref({ bindingsCustom: true });
      live.current.learning = null;
      setLearning(null);
      return;
    }
    if (!debounce(event, performance.now())) return;
    const action = S.actionFor(L.bindings, event);
    if (action) act(action, source);
    else setTraffic((t) => ({ ...t, in: source, action: "not assigned" }));
  }

  useEffect(() => {
    let cancelled = false;
    let events = null;
    const refresh = () => setMidi({ status: "ok", ...transport.ports() });
    const openMidi = () => openWebMidi().then((t) => {
      if (cancelled) return;
      transport = t;
      t.onMessage((data) => {
        const sw = S.switchFromMidi(live.current.show, data);
        if (sw) { handleSwitch(sw); return; }
        const event = S.eventFromMidi(data);
        if (event) handleInput(event, S.describeBinding(event));
      });
      t.onPortsChange(refresh);
      refresh();
    }).catch((err) => setMidi((m) => ({ ...m, status: err.message })));
    // Un hôte de scène répond sur /stage/state : on devient son écran, sinon Web MIDI comme avant.
    let lastMove = null;
    const apply = (snap) => {
      if (snap.show && (!live.current.show || live.current.show.exported !== snap.show.exported)) {
        live.current.show = snap.show;
        setShow(snap.show);
      }
      if (snap.pos) { live.current.pos = snap.pos; setPos(snap.pos); }
      live.current.states = snap.states || {};
      setStates(snap.states || {});
      live.current.backup = !!snap.backup;
      setBackup(!!snap.backup);
      setTraffic(snap.traffic || { in: "", action: "", out: "" });
      if (snap.move && lastMove !== null && snap.move.n !== lastMove) setMove({ ...snap.move, at: Date.now() });
      if (snap.move) lastMove = snap.move.n;
      setHost(snap.midi || null);
    };
    fetch("../stage/state", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((snap) => {
        if (cancelled) return;
        remote.current = true;
        setMidi({ status: "remote", inputs: [], outputs: [] });
        apply(snap);
        events = new EventSource("../stage/events");
        events.onmessage = (e) => { try { apply(JSON.parse(e.data)); } catch { /* message abîmé : le suivant le remplace */ } };
      })
      .catch(() => { if (!cancelled) openMidi(); });
    return () => { cancelled = true; if (events) events.close(); };
  }, []);

  const ports = pickPorts(prefs, midi.inputs, midi.outputs);
  useEffect(() => {
    if (transport) transport.use(ports.inp ? ports.inp.id : "", ports.out ? ports.out.id : "");
  }, [ports.inp && ports.inp.id, ports.out && ports.out.id, midi.status]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest && e.target.closest("input, select, textarea")) return;
      const L = live.current;
      if (L.learning) {
        e.preventDefault();
        if (e.key === "Escape") { live.current.learning = null; setLearning(null); return; }
        handleInput(S.eventFromKey(e.key), `Key ${e.key}`);
        return;
      }
      if (!L.prefs.keyboard) return;
      const action = S.actionFor(L.bindings, S.eventFromKey(e.key));
      if (action) { e.preventDefault(); act(action, S.describeBinding({ type: "key", key: e.key })); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!prefs.wake || !("wakeLock" in navigator)) return;
    let lock = null;
    let stopped = false;
    const acquire = async () => {
      try { lock = await navigator.wakeLock.request("screen"); } catch { /* refusé : l'écran pourra s'éteindre */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible" && !stopped) acquire(); };
    acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (lock) lock.release().catch(() => {});
    };
  }, [prefs.wake]);

  function loadShow(doc, source, { share = true } = {}) {
    const problems = S.checkShow(doc);
    if (problems.length) { setError(`${source}: ${problems.slice(0, 3).join(" ")}`); return; }
    setError("");
    setShow(doc);
    live.current.show = doc;
    setPos(S.startPosition(doc)); // rien n'est envoyé avant la première action
    if (share && !doc.demo) {
      fetch(SERVER_SHOW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) }).catch(() => {});
    }
    if (!live.current.prefs.bindingsCustom) setBindings(S.presetBindings(doc));
    setBrowse(null);
    setScreen("stage");
  }
  async function loadFile(file) {
    if (!file) return;
    let doc;
    try { doc = JSON.parse(await file.text()); } catch { setError(`${file.name}: not valid JSON.`); return; }
    loadShow(doc, file.name);
  }
  async function loadDemo() {
    try { loadShow(await (await fetch("demo-show.json")).json(), "Demo show"); } catch { setError("The demo show could not be loaded."); }
  }
  // « ?demo » dans l'adresse : ouvre directement le show de démo (essai, captures) ;
  // « &view=songs|setlists|settings » ouvre aussi un écran.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const opened = !show && q.has("demo") ? loadDemo() : Promise.resolve();
    const v = q.get("view");
    opened.then(() => {
      if (v === "songs") setSongsOpen(true);
      else if (v === "setlists" || v === "settings") setScreen(v);
    });
  }, []);

  // Show courant du serveur : à l'ouverture, au retour sur la page et toutes les 5 s. Un autre show
  // (autre date d'export) remplace le show affiché ; la position est gardée si elle existe encore.
  useEffect(() => {
    let stopped = false;
    const sync = async () => {
      if (remote.current) return; // l'hôte de scène pousse son show
      let doc;
      try {
        const r = await fetch(SERVER_SHOW, { cache: "no-store" });
        if (!r.ok) return;
        doc = await r.json();
      } catch { return; }
      const cur = live.current.show;
      if (stopped || S.checkShow(doc).length || (cur && !cur.demo && cur.exported === doc.exported)) return;
      if (cur && cur.demo && new URLSearchParams(location.search).has("demo")) return; // ?demo : on reste sur la démo
      setShow(doc);
      live.current.show = doc;
      setPos((p) => S.validPosition(doc, p));
      if (!live.current.prefs.bindingsCustom) setBindings(S.presetBindings(doc));
    };
    sync();
    const timer = setInterval(sync, SERVER_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // Show déposé par ES8 Designer dans ce navigateur (même origine) : pris au démarrage ou à l'arrivée.
  useEffect(() => {
    const take = () => {
      let raw = null;
      try { raw = localStorage.getItem(INBOX); if (raw) localStorage.removeItem(INBOX); } catch { /* stockage indisponible */ }
      if (!raw) return;
      try { loadShow(JSON.parse(raw), "From ES8 Designer"); } catch { setError("The show from ES8 Designer is not valid JSON."); }
    };
    take();
    const onStorage = (e) => { if (e.key === INBOX && e.newValue) take(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const ctx = {
    show, pos, prefs, setPref, bindings, setBindings, learning, setLearning, midi, ports, traffic, error, backup, states, move,
    act, goTo, resend: () => {
      if (remote.current) { post({ type: "resend" }); return; }
      sendStep(live.current.pos); setTraffic((t) => ({ ...t, in: "screen", action: "Resend" }));
    },
    setScreen, songsOpen, setSongsOpen, browse, setBrowse, loadFile, loadDemo, channel: channel(),
    press: (key, down) => (remote.current ? post({ type: "press", key, down }) : handleSwitch({ key, press: down })), // pavé touché = appui du pied
    host, remote: remote.current,
  };
  if (screen === "settings") return html`<${Settings} ...${ctx} />`;
  if (!show) return html`<${Welcome} ...${ctx} />`;
  if (screen === "setlists") return html`<${Setlists} ...${ctx} />`;
  if (prefs.view === "switches") return html`<${SwitchStage} ...${ctx} />`;
  return html`<${Stage} ...${ctx} />`;
}

// ---------------------------------------------------------------- scène

// Disposition de l'ES-8 : rangée du haut, puis NUM1–6 ; les prises CTL IN à part.
const BOARD = [["MEM_M", "MUTE", "BANK_D", "BANK_U", "NUM7", "NUM8"], ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6"]];
const JACKS = ["CTL_IN_1", "CTL_IN_2", "CTL_IN_3", "CTL_IN_4"];
const ACTIVE_ROLES = ["param", "companion"]; // tenus par la Companion : un pavé touché agit

/** Un switch en grand : son nom dans ce rig, son rôle, allumé quand son paramètre est on. */
function BigSwitch({ k, sw, states, press }) {
  const held = useRef(false);
  if (!sw) {
    return html`<div class="bigsw unused"><span class="bigsw-top mono">${SWITCH_NAME[k] || k}</span><span class="bigsw-label">—</span></div>`;
  }
  const on = S.switchIsOn(sw, states);
  const active = ACTIVE_ROLES.includes(sw.role);
  const down = (e) => { if (!active) return; e.preventDefault(); held.current = true; press(k, true); };
  const up = () => { if (held.current) { held.current = false; press(k, false); } };
  return html`<button class=${`bigsw ${on ? "on" : ""} ${active ? "" : "native"}`} aria-pressed=${sw.role === "param" ? on : undefined}
      onPointerDown=${down} onPointerUp=${up} onPointerLeave=${up} onPointerCancel=${up}
      title=${active ? "Tap = press the footswitch" : "Handled by the ES-8 itself"}>
    <span class="bigsw-top mono"><span>${SWITCH_NAME[k] || k}</span><span>${(ROLE_TAG[sw.role] || (() => ""))(sw)}</span></span>
    <span class="bigsw-label">${sw.label}</span>
    ${sw.role === "param" ? html`<span class="bigsw-state mono">${on ? "ON" : "off"}</span>` : null}
  </button>`;
}

/** Vue « Switches » : la surface de l'ES-8 en grand, le morceau et les pas en bandeau. */
function SwitchStage(ctx) {
  const { show, pos, backup, states, press, songsOpen, setSongsOpen, move } = ctx;
  const v = S.view(show, pos);
  const now = S.played(v.step, v.step.index, backup);
  const sws = (v.rig.surface || {}).switches || {};
  // Bannière d'un déplacement : où l'on arrive (et le morceau s'il change), ou « fin de la setlist ».
  const back = ["prev", "prev_song"].includes(move.dir);
  const fresh = move.n && Date.now() - (move.at || 0) < 1500; // pas de bannière en ouvrant la vue après coup
  const flash = !fresh ? null : move.dir === "end"
    ? { cls: "end", text: "End of the setlist" }
    : { cls: back ? "back" : "fwd", arrow: back ? "◀" : "▶", text: now.snapshot,
        song: v.posInSong === 0 || move.dir.includes("song") || move.dir === "jump" ? v.song.name : "" };
  const jacks = JACKS.filter((k) => sws[k]);
  return html`
    <div class="app stage-app switch-app">
      <${StatusBar} ...${ctx} />
      <div class="sw-stage">
        <header class="sw-head">
          <button class="sw-song" aria-expanded=${songsOpen} onClick=${() => setSongsOpen(true)}>
            <span class="eyebrow">Song ${v.songIndex + 1} / ${v.setlist.songs.length} · step ${v.posInSong + 1}/${v.song.steps}</span>
            <span class="sw-song-name">${v.song.name} <${Icon} name="down" size=${20} /></span>
          </button>
          <div class=${`sw-now ${backup ? "on-backup" : ""} ${fresh ? "pulse" : ""}`} key=${`now-${move.n}`}>
            <span class="eyebrow">${backup ? "Backup" : "Now"} · ${now.label}</span>
            <span class="sw-now-name">${now.snapshot}</span>
          </div>
          <div class="sw-next">
            <span class="eyebrow">Next</span>
            <span class="sw-next-name">${v.next ? v.next.snapshot : "End of setlist"}</span>
            ${v.nextIsNewSong ? html`<span class="muted small">${v.setlist.songs[v.next.song].name}</span>` : null}
          </div>
        </header>
        ${flash ? html`<div class=${`step-flash ${flash.cls}`} key=${`flash-${move.n}`} aria-live="polite">
            ${flash.arrow ? html`<span class="arrow">${flash.arrow}</span>` : null}
            <span class="what">${flash.text}</span>${flash.song ? html`<span class="song">${flash.song}</span>` : null}</div>` : null}
        ${v.rig.surface
          ? html`<div class="board">${BOARD.flat().map((k) => html`<${BigSwitch} k=${k} sw=${sws[k]} states=${states || {}} press=${press} />`)}</div>
            ${jacks.length ? html`<div class="board jacks">${jacks.map((k) => html`<${BigSwitch} k=${k} sw=${sws[k]} states=${states || {}} press=${press} />`)}</div>` : null}`
          : html`<p class="muted">The rig “${v.rig.name}” has no surface.</p>`}
      </div>
      ${songsOpen && html`<${SongList} ...${ctx} v=${v} />`}
    </div>`;
}

function StatusBar({ show, pos, midi, ports, traffic, channel, setScreen, backup, act, prefs, setPref, host, remote }) {
  const sl = show.setlists[pos.setlist];
  const ok = midi.status === "ok";
  return html`
    <header class="bar">
      <button class="bar-title" onClick=${() => setScreen("setlists")}>
        <span class="eyebrow">Setlist</span><span class="bar-name">${sl.name}${show.demo ? " · demo" : ""}</span>
      </button>
      <div class="seg view-seg" role="group" aria-label="Stage view">
        <button aria-pressed=${prefs.view !== "switches"} onClick=${() => setPref({ view: "setlist" })}>Setlist</button>
        <button aria-pressed=${prefs.view === "switches"} onClick=${() => setPref({ view: "switches" })}>Switches</button>
      </div>
      <span class="spacer"></span>
      ${remote
        ? html`<span class="chip wide" title="This screen shows the stage host, which talks to the ES-8 itself">
            <span class=${`dot ${host && host.connected ? "ok" : "bad"}`}></span>Stage host · ${host && host.connected ? host.port : "ES-8 not connected"}</span>`
        : html`<span class="chip wide"><span class=${`dot ${ok && ports.inp ? "ok" : "bad"}`}></span>In · ${ports.inp ? ports.inp.name : "none"}</span>
          <span class="chip wide"><span class=${`dot ${ok && ports.out ? "ok" : "bad"}`}></span>Out · ${ports.out ? `${ports.out.name} ch ${channel}` : "none"}</span>`}
      <span class="chip mono traffic">
        ${traffic.action ? html`<span class="muted">in</span> ${traffic.in} <span class="muted">→</span> ${traffic.action}` : html`<span class="muted">waiting</span>`}
        ${traffic.out && html` <span class="muted">out</span> <span class="amber">${traffic.out}</span>`}
      </span>
      <span class=${`dot only-small ${remote ? (host && host.connected ? "ok" : "bad") : ok && ports.out ? "ok" : "bad"}`}></span>
      <button class=${`chip backup-btn ${backup ? "on" : ""}`} aria-pressed=${backup} onClick=${() => act("backup", "screen")}
        title="Switch every step to its backup patch, or back">Backup</button>
      <button class="icon-btn" aria-label="Settings" onClick=${() => setScreen("settings")}><${Icon} name="menu" /></button>
    </header>`;
}

function Stage(ctx) {
  const { show, pos, act, resend, prefs, setPref, songsOpen, setSongsOpen, backup } = ctx;
  const v = S.view(show, pos);
  const now = S.played(v.step, v.step.index, backup);
  const meta = (st) => `PC ${st.index} · ${st.label}`;
  return html`
    <div class=${`app stage-app ${prefs.panel ? "panel-open" : "panel-closed"}`}>
      <${StatusBar} ...${ctx} />
      <div class="stage">
        <section class="center">
          <div class="songhead">
            <span class="eyebrow">Song ${v.songIndex + 1} / ${v.setlist.songs.length}</span>
            <button class="song-title" aria-expanded=${songsOpen} onClick=${() => setSongsOpen(true)}>
              <span>${v.song.name}</span><${Icon} name="down" size=${26} />
            </button>
            <span class="sub">${v.rig.name} · patch ${v.step.label} · step ${v.posInSong + 1}/${v.song.steps}</span>
          </div>
          <ol class="strip" aria-label="Song sequence">
            ${v.strip.map((st) => html`<li class=${`pill ${st.state}`}>${st.snapshot}</li>`)}
          </ol>
          <div class="cards">
            <div class="card prev" aria-label="Previous">
              <span class="eyebrow">Previous</span>
              ${v.prev ? html`<span class="card-name">${v.prev.snapshot}</span><span class="mono meta">${meta(v.prev)}</span>`
                : html`<span class="muted">Start of setlist</span>`}
            </div>
            <button class=${`card now ${backup ? "on-backup" : ""}`} onClick=${resend} title="Tap to send this step again">
              <span class="eyebrow">${backup ? (now.backup ? `Backup · ${now.rig}` : "Backup · none for this step") : "Now"}</span>
              <span class="card-name">${now.snapshot}</span>
              <span class="mono meta">${backup && now.backup ? `PC ${now.pc} · ${now.label} · instead of ${v.step.snapshot}` : meta(v.step)}</span>
            </button>
            <div class="card next" aria-label="Next">
              <span class="eyebrow">Next</span>
              ${v.next ? html`
                ${v.nextIsNewSong && html`<span class="badge">New song · ${v.setlist.songs[v.next.song].name}</span>`}
                <span class="card-name">${v.next.snapshot}</span>
                <span class="mono meta">${meta(v.next)}</span>
                <span class="prev-inline muted">prev · ${v.prev ? v.prev.snapshot : "—"}</span>`
                : html`<span class="muted">End of setlist</span>`}
            </div>
          </div>
        </section>
        <button class="nav nav-prev" onClick=${() => act("prev", "screen")}><${Icon} name="left" size=${30} /><span>Previous</span></button>
        <button class="nav nav-next" onClick=${() => act("next", "screen")}><span>Next</span><${Icon} name="right" size=${30} /></button>
        ${prefs.panel
          ? html`<${Panel} v=${v} prefs=${prefs} setPref=${setPref} states=${ctx.states} />`
          : html`<button class="rail" aria-label="Show side panel" aria-expanded="false" onClick=${() => setPref({ panel: true })}>
              <${Icon} name="left" /><span>Switches · chain · programs</span></button>`}
      </div>
      ${songsOpen && html`<${SongList} ...${ctx} v=${v} />`}
    </div>`;
}

const SWITCH_NAME = { MEM_M: "MEM", BANK_D: "BANK▼", BANK_U: "BANK▲", CTL_IN_1: "CTL1", CTL_IN_2: "CTL2", CTL_IN_3: "CTL3", CTL_IN_4: "CTL4" };

/** Un switch de la surface : son nom dans ce rig, son rôle, et l'état de son paramètre (à la place des LED de l'ES-8). */
function Switch({ k, sw, states }) {
  if (!sw) return html`<div class="sw unused"><span class="sw-top mono">${SWITCH_NAME[k] || k}</span><span class="sw-label">—</span></div>`;
  const on = S.switchIsOn(sw, states);
  return html`<div class=${`sw ${on ? "on" : ""}`} aria-pressed=${sw.role === "param" ? on : undefined}>
    <span class="sw-top mono"><span>${SWITCH_NAME[k] || k}</span><span>${(ROLE_TAG[sw.role] || (() => ""))(sw)}</span></span>
    <span class="sw-label">${sw.label}</span></div>`;
}

function Panel({ v, setPref, states }) {
  const surface = v.rig.surface;
  const extra = surface ? Object.keys(surface.switches).filter((k) => !NUMS.includes(k)) : [];
  return html`
    <aside class="panel">
      <button class="ghost" aria-expanded="true" onClick=${() => setPref({ panel: false })}>Hide panel <${Icon} name="right" size=${18} /></button>
      <section class="box">
        <span class="eyebrow">Next song</span>
        ${v.nextSong
          ? html`<span class="box-title">${v.nextSong.name}</span>`
          : html`<span class="muted">End of the setlist</span>`}
      </section>
      <section class="box">
        <span class="eyebrow">ES-8 switches</span>
        ${surface
          ? html`<div class="switches">${NUMS.map((k) => html`<${Switch} k=${k} sw=${surface.switches[k]} states=${states || {}} />`)}</div>
            ${extra.length > 0 && html`<div class="switches extra">${extra.map((k) => html`<${Switch} k=${k} sw=${surface.switches[k]} states=${states || {}} />`)}</div>`}
            <span class="muted small">Surface “${surface.name}” · lit = on</span>`
          : html`<span class="muted small">This rig has no surface.</span>`}
      </section>
      <section class="box">
        <span class="eyebrow">Chain · input to output</span>
        ${(v.rig.chain || []).map((c) => html`<div class="row"><span class="mono muted">${c.loop}</span><span>${c.device}</span></div>`)}
      </section>
      <section class="box">
        <span class="eyebrow">Programs</span>
        ${v.programs.map((p) => html`<div class="row"><span class="muted">${p.device}</span><span class="grow">${p.program}</span><span class="mono muted">PC ${p.pc}</span></div>`)}
      </section>
    </aside>`;
}

function SongList({ show, pos, goTo, setSongsOpen, setScreen, v }) {
  const sl = v.setlist;
  return html`
    <div class="overlay" onClick=${(e) => { if (e.target === e.currentTarget) setSongsOpen(false); }}>
      <section class="sheet" role="dialog" aria-label="Songs">
        <div class="sheet-head">
          <div class="grow">
            <span class="sheet-title">${sl.name}</span>
            <span class="muted small">${sl.songs.length} songs · ${sl.steps.length} steps</span>
          </div>
          <button class="ghost" onClick=${() => { setSongsOpen(false); setScreen("setlists"); }}>All setlists</button>
          <button class="icon-btn" aria-label="Close" onClick=${() => setSongsOpen(false)}><${Icon} name="close" /></button>
        </div>
        <ol class="songs">
          ${sl.songs.map((song, k) => html`
            <li><button class=${`song ${k === v.songIndex ? "current" : ""}`} aria-current=${k === v.songIndex}
                onClick=${() => goTo(S.goToSong(show, pos.setlist, k), `Song ${k + 1}`)}>
              <span class="song-num">${k + 1}</span>
              <span class="song-text"><span class="song-name">${song.name}</span>
                <span class="muted small">${show.rigs[song.rig].name} · ${sl.steps.slice(song.first_step, song.first_step + song.steps).map((s) => s.snapshot).join(" → ")}</span></span>
            </button></li>`)}
        </ol>
      </section>
    </div>`;
}

// ---------------------------------------------------------------- setlists

function Setlists({ show, pos, goTo, browse, setBrowse, setScreen }) {
  const shown = browse === null ? pos.setlist : browse;
  const sl = show.setlists[shown];
  const playable = S.isPlayable(sl);
  return html`
    <div class="app page">
      <header class="bar">
        <button class="ghost" onClick=${() => setScreen("stage")}><${Icon} name="left" size=${18} /> Stage</button>
        <h1 class="page-title">Setlists</h1>
        <div class="tabs" role="tablist" aria-label="Setlists">
          ${show.setlists.map((s, k) => html`
            <button role="tab" aria-selected=${k === shown} onClick=${() => setBrowse(k)}>
              ${s.name}${k === pos.setlist ? html` <span class="dot amber-dot"></span>` : ""}</button>`)}
        </div>
      </header>
      <div class="page-body">
        ${!playable && html`<p class="notice">“${sl.name}” has no valid MIDI bank (0–6): it can only be browsed.</p>`}
        ${playable && shown !== pos.setlist && html`<p class="muted">Browsing “${sl.name}” (MIDI bank ${sl.midi_bank}).
          Tapping a step switches the show to this setlist.</p>`}
        ${sl.songs.map((song, si) => html`
          <section class="song-block">
            <span class="song-num">${si + 1}</span>
            <div>
              <h2>${song.name} <span class="muted small">${show.rigs[song.rig].name}</span></h2>
              <div class="steps">
                ${sl.steps.slice(song.first_step, song.first_step + song.steps).map((st, j) => {
                  const index = song.first_step + j;
                  const current = shown === pos.setlist && index === pos.step;
                  return html`<button class=${`step ${current ? "current" : ""}`} disabled=${!playable} aria-current=${current}
                      onClick=${() => goTo({ setlist: shown, step: index }, `Step ${index + 1}`)}>
                    <span>${st.snapshot}</span><span class="mono small">PC ${index} · ${st.label}</span></button>`;
                })}
              </div>
            </div>
          </section>`)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- réglages

const MIDI_HELP = {
  pending: "Asking the browser for MIDI access…",
  remote: "This screen shows the stage host (es8stage serve --stage): the host talks MIDI to the ES-8 itself, this screen only shows and controls it.",
  insecure: "No MIDI on this address: browsers give MIDI only to secure pages (https, or localhost). On a stage host the ES-8 is driven by the host itself; this screen only shows and controls it.",
  unsupported: "This browser has no Web MIDI. Use Chrome or Edge (Android, Windows, macOS, Linux). Safari on iPhone and iPad has no Web MIDI.",
  denied: "MIDI access was refused. Allow it in the browser's site settings, then reload.",
};

/** Les shows de la bibliothèque du serveur (es8stage serve, le Pi) : en jouer un le donne à toutes les Companion. */
function LibraryShows() {
  const [listing, setListing] = useState(null);
  const [busy, setBusy] = useState("");
  const refresh = () => fetch("../library/").then((r) => (r.ok ? r.json() : null)).then(setListing).catch(() => setListing(null));
  useEffect(() => { refresh(); }, []);
  if (!listing) return null;
  const play = async (name) => {
    setBusy(name);
    try {
      await fetch(`../library/shows/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"op":"play"}' });
    } finally { setBusy(""); refresh(); }
  };
  return html`
    <div class="lib-shows">
      <h3 class="eyebrow">Shows in the library</h3>
      ${listing.shows.length ? listing.shows.map((it) => html`
        <div class="lib-show">
          <span>${it.name}</span>
          ${it.name === listing.playing ? html`<span class="muted small">playing</span>`
            : html`<button class="ghost" disabled=${!!busy} onClick=${() => play(it.name)}>${busy === it.name ? "…" : "Play"}</button>`}
        </div>`)
        : html`<p class="muted small">None yet: the Show button of ES8 Designer adds one.</p>`}
    </div>`;
}

function Settings(ctx) {
  const { show, prefs, setPref, midi, ports, bindings, setBindings, learning, setLearning, setScreen, loadFile, loadDemo, error } = ctx;
  const fileInput = useRef(null);
  const showChannel = (show && show.es8 && show.es8.rx_channel) || 1;
  const startLearn = (id) => setLearning(learning === id ? null : id);
  return html`
    <div class="app page">
      <header class="bar">
        ${show && html`<button class="ghost" onClick=${() => { setLearning(null); setScreen("stage"); }}><${Icon} name="left" size=${18} /> Stage</button>`}
        <h1 class="page-title">Settings</h1>
      </header>
      <div class="page-body settings">
        <section class="box">
          <h2 class="eyebrow">Show</h2>
          ${show ? html`<p>${show.setlists.map((s) => s.name).join(" · ")}${show.demo ? " (demo)" : ""}</p>
              <p class="muted small">Exported ${show.exported ? new Date(show.exported).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "?"} · ${show.setlists.length} setlist(s)</p>`
            : html`<p class="muted">No show loaded.</p>`}
          <div class="row-wrap">
            <button class="primary" onClick=${() => fileInput.current.click()}>Load a show file…</button>
            <button class="ghost" onClick=${loadDemo}>Try the demo show</button>
            <input ref=${fileInput} type="file" accept=".json,application/json" hidden
              onChange=${(e) => { loadFile(e.target.files[0]); e.target.value = ""; }} />
          </div>
          ${error && html`<p class="notice">${error}</p>`}
          <${LibraryShows} />
        </section>

        <section class="box">
          <h2 class="eyebrow">Output · to the ES-8</h2>
          ${midi.status !== "ok" && html`<p class="notice">${MIDI_HELP[midi.status] || midi.status}</p>`}
          <label class="field">MIDI port
            <select value=${ports.out ? ports.out.name : ""} onChange=${(e) => setPref({ outName: e.target.value })}>
              ${midi.outputs.map((p) => html`<option value=${p.name}>${p.name}</option>`)}
              <option value="">None</option>
            </select>
          </label>
          <label class="field">ES-8 receive channel
            <select value=${prefs.channel} onChange=${(e) => setPref({ channel: Number(e.target.value) })}>
              <option value="0">From the show (${showChannel})</option>
              ${Array.from({ length: 16 }, (_, i) => html`<option value=${i + 1}>${i + 1}</option>`)}
            </select>
          </label>
        </section>

        <section class="box">
          <h2 class="eyebrow">Input · controller</h2>
          <label class="field">MIDI port
            <select value=${ports.inp ? ports.inp.name : ""} onChange=${(e) => setPref({ inName: e.target.value })}>
              ${midi.inputs.map((p) => html`<option value=${p.name}>${p.name}</option>`)}
              <option value="">None</option>
            </select>
          </label>
          <label class="check"><input type="checkbox" checked=${prefs.keyboard} onChange=${(e) => setPref({ keyboard: e.target.checked })} />
            Also accept the keyboard (page-turner pedals)</label>
          <p class="muted small">The Companion sends the PCs. If the controller is also wired straight to the ES-8, its messages arrive twice.</p>
        </section>

        <section class="box actions">
          <div class="box-head">
            <h2 class="eyebrow">Actions</h2>
            <span class="tag">${prefs.bindingsCustom ? "Edited by hand" : show && show.input_preset ? `Preset · ${show.input_preset.source}` : "Default keys"}</span>
            <button class="ghost" onClick=${() => { setBindings(S.presetBindings(show)); setPref({ bindingsCustom: false }); setLearning(null); }}>Restore preset</button>
          </div>
          ${S.ACTIONS.map((a) => {
            const mine = bindings.filter((b) => b.action === a.id);
            return html`<div class="action-row">
              <span class="action-name">${a.label}</span>
              <span class="grow">
                ${learning === a.id
                  ? html`<span class="listening">Listening: press a switch or a key (Esc cancels)</span>`
                  : mine.length ? mine.map((b) => html`<span class="tag mono">${S.describeBinding(b)}</span>`) : html`<span class="muted">not assigned</span>`}
              </span>
              <button class=${learning === a.id ? "primary" : "ghost"} onClick=${() => startLearn(a.id)}>${learning === a.id ? "Cancel" : "Learn"}</button>
              <button class="ghost" disabled=${!mine.length} onClick=${() => { setBindings(S.clearAction(bindings, a.id)); setPref({ bindingsCustom: true }); }}>Clear</button>
            </div>`;
          })}
          <p class="muted small">Triggers on press; releases are ignored, so use momentary switches. A message used by another action is taken from it.
            Incoming Program Changes can't be assigned: they are what the Companion sends.</p>
        </section>

        <section class="box">
          <h2 class="eyebrow">Screen</h2>
          <label class="check"><input type="checkbox" checked=${prefs.wake} onChange=${(e) => setPref({ wake: e.target.checked })} />
            Keep the screen awake</label>
        </section>
      </div>
    </div>`;
}

function Welcome({ setScreen, loadDemo }) {
  return html`
    <div class="app page welcome">
      <div class="welcome-body">
        <h1>ES8 Companion</h1>
        <p>Plays a setlist on a BOSS ES-8 during the show: a controller press moves to the next step and the
          Companion sends its Program Change. Export the show from ES8 Designer or <code>es8ctl</code>, then load it here.</p>
        <div class="row-wrap">
          <button class="primary" onClick=${() => setScreen("settings")}>Load a show…</button>
          <button class="ghost" onClick=${loadDemo}>Try the demo show</button>
        </div>
      </div>
    </div>`;
}

render(html`<${App} />`, document.getElementById("root"));

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* hors ligne indisponible, l'app marche quand même */ });
}

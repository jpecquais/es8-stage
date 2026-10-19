// ES8 Companion — l'app de scène (Preact + htm, sans compilation). Textes en
// anglais. Spéc : docs/companion.md. Elle joue un show exporté par la lib :
// une action (contrôleur MIDI, clavier, écran) déplace la position et envoie
// à l'ES-8 le Program Change du pas. Pas de Pyodide, pas de SysEx.

import { html, render, useState, useEffect, useRef } from "../shared/vendor/preact-htm.module.js";
import * as S from "./show.js";
import { openWebMidi } from "./midi.js";

const STORE_KEY = "es8companion";
const INBOX = "es8companion/incoming"; // déposé par ES8 Designer (« Show »)
// outName / inName : null = jamais choisi (choix automatique), "" = aucun port.
const DEFAULT_PREFS = {
  outName: null, inName: null, channel: 0, keyboard: true, wake: true,
  switchView: "manual", panel: true, bindingsCustom: false,
};
const NUMS = ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8"];
const ROLE_TAG = { loop: (sw) => sw.target || "LOOP", param: (sw) => (sw.mode === "momentary" ? "MOM" : "CC"), tap: () => "TAP", es8: () => "ES-8" };

let transport = null;

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
}
function saveStore(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* stockage indisponible : l'app marche sans */ }
}

/** Ports utilisés : ceux choisis, sinon la première sortie et l'entrée du même nom. */
function pickPorts(prefs, inputs, outputs) {
  const out = prefs.outName === null ? outputs[0] : outputs.find((p) => p.name === prefs.outName);
  const inp = prefs.inName === null
    ? inputs.find((p) => out && p.name === out.name) || inputs[0]
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
  const [screen, setScreen] = useState("stage");
  const [songsOpen, setSongsOpen] = useState(false);
  const [browse, setBrowse] = useState(null);
  const [learning, setLearning] = useState(null);
  const [midi, setMidi] = useState({ status: "pending", inputs: [], outputs: [] });
  const [traffic, setTraffic] = useState({ in: "", action: "", out: "" });
  const [error, setError] = useState("");
  const debounce = useRef(S.makeDebounce()).current;

  // Les callbacks MIDI et clavier sont posés une fois : ils lisent l'état ici.
  const live = useRef({});
  live.current = { ...live.current, show, pos, bindings, prefs, learning };

  useEffect(() => saveStore({ show, pos, bindings, prefs }), [show, pos, bindings, prefs]);

  const setPref = (patch) => setPrefs((p) => ({ ...p, ...patch }));
  const channel = () => live.current.prefs.channel || (live.current.show && live.current.show.es8 && live.current.show.es8.rx_channel) || 1;

  function sendStep(p) {
    const bank = live.current.show.setlists[p.setlist].midi_bank;
    const sent = !!transport && transport.send(S.stepMessages(channel(), bank, p.step));
    setTraffic((t) => ({ ...t, out: sent ? `${bank ? `bank ${bank} · ` : ""}PC ${p.step}` : "not sent: no output" }));
  }
  function goTo(p, label) {
    live.current.pos = p;
    setPos(p);
    sendStep(p);
    setTraffic((t) => ({ ...t, in: "screen", action: label }));
    setSongsOpen(false);
  }
  function act(action, source) {
    const L = live.current;
    if (!L.show) return;
    const p = S.move(L.show, L.pos, action);
    setTraffic((t) => ({ ...t, in: source, action: S.actionLabel(action) + (p ? "" : " · end") }));
    if (!p) return;
    live.current.pos = p; // un second appui avant le rendu part de la nouvelle position
    setPos(p);
    sendStep(p);
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
    const refresh = () => setMidi({ status: "ok", ...transport.ports() });
    openWebMidi().then((t) => {
      if (cancelled) return;
      transport = t;
      t.onMessage((data) => {
        const event = S.eventFromMidi(data);
        if (event) handleInput(event, S.describeBinding(event));
      });
      t.onPortsChange(refresh);
      refresh();
    }).catch((err) => setMidi((m) => ({ ...m, status: err.message })));
    return () => { cancelled = true; };
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

  function loadShow(doc, source) {
    const problems = S.checkShow(doc);
    if (problems.length) { setError(`${source}: ${problems.slice(0, 3).join(" ")}`); return; }
    setError("");
    setShow(doc);
    setPos(S.startPosition(doc)); // rien n'est envoyé avant la première action
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
    show, pos, prefs, setPref, bindings, setBindings, learning, setLearning, midi, ports, traffic, error,
    act, goTo, resend: () => { sendStep(live.current.pos); setTraffic((t) => ({ ...t, in: "screen", action: "Resend" })); },
    setScreen, songsOpen, setSongsOpen, browse, setBrowse, loadFile, loadDemo, channel: channel(),
  };
  if (screen === "settings") return html`<${Settings} ...${ctx} />`;
  if (!show) return html`<${Welcome} ...${ctx} />`;
  if (screen === "setlists") return html`<${Setlists} ...${ctx} />`;
  return html`<${Stage} ...${ctx} />`;
}

// ---------------------------------------------------------------- scène

function StatusBar({ show, pos, midi, ports, traffic, channel, setScreen }) {
  const sl = show.setlists[pos.setlist];
  const ok = midi.status === "ok";
  return html`
    <header class="bar">
      <button class="bar-title" onClick=${() => setScreen("setlists")}>
        <span class="eyebrow">Setlist</span><span class="bar-name">${sl.name}${show.demo ? " · demo" : ""}</span>
      </button>
      <span class="spacer"></span>
      <span class="chip wide"><span class=${`dot ${ok && ports.inp ? "ok" : "bad"}`}></span>In · ${ports.inp ? ports.inp.name : "none"}</span>
      <span class="chip wide"><span class=${`dot ${ok && ports.out ? "ok" : "bad"}`}></span>Out · ${ports.out ? `${ports.out.name} ch ${channel}` : "none"}</span>
      <span class="chip mono traffic">
        ${traffic.action ? html`<span class="muted">in</span> ${traffic.in} <span class="muted">→</span> ${traffic.action}` : html`<span class="muted">waiting</span>`}
        ${traffic.out && html` <span class="muted">out</span> <span class="amber">${traffic.out}</span>`}
      </span>
      <span class=${`dot only-small ${ok && ports.out ? "ok" : "bad"}`}></span>
      <button class="icon-btn" aria-label="Settings" onClick=${() => setScreen("settings")}><${Icon} name="menu" /></button>
    </header>`;
}

function Stage(ctx) {
  const { show, pos, act, resend, prefs, setPref, songsOpen, setSongsOpen } = ctx;
  const v = S.view(show, pos);
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
            <button class="card now" onClick=${resend} title="Tap to send this step again">
              <span class="eyebrow">Now</span>
              <span class="card-name">${v.step.snapshot}</span>
              <span class="mono meta">${meta(v.step)}</span>
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
          ? html`<${Panel} v=${v} prefs=${prefs} setPref=${setPref} />`
          : html`<button class="rail" aria-label="Show side panel" aria-expanded="false" onClick=${() => setPref({ panel: true })}>
              <${Icon} name="left" /><span>Switches · chain · programs</span></button>`}
      </div>
      ${songsOpen && html`<${SongList} ...${ctx} v=${v} />`}
    </div>`;
}

function Panel({ v, prefs, setPref }) {
  const surface = v.rig.surface;
  const manual = prefs.switchView === "manual" && surface;
  const extra = surface ? Object.entries(surface.switches).filter(([k]) => !NUMS.includes(k)) : [];
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
        <div class="box-head">
          <span class="eyebrow">ES-8 switches</span>
          <div class="seg" role="group" aria-label="Switch view">
            <button aria-pressed=${prefs.switchView === "manual"} onClick=${() => setPref({ switchView: "manual" })}>Manual</button>
            <button aria-pressed=${prefs.switchView === "patch"} onClick=${() => setPref({ switchView: "patch" })}>Patch</button>
          </div>
        </div>
        <div class="switches">
          ${NUMS.map((num, k) => {
            if (!manual) {
              const p = v.bank.patches[k];
              return html`<div class=${`sw ${p.current ? "current" : p.snapshot ? "" : "unused"}`}>
                <span class="sw-top mono"><span>${num}</span><span>${p.label}</span></span><span class="sw-label">${p.snapshot || "—"}</span></div>`;
            }
            const sw = surface.switches[num];
            return sw
              ? html`<div class="sw"><span class="sw-top mono"><span>${num}</span><span>${(ROLE_TAG[sw.role] || (() => ""))(sw)}</span></span>
                  <span class="sw-label">${sw.label}</span></div>`
              : html`<div class="sw unused"><span class="sw-top mono">${num}</span><span class="sw-label">—</span></div>`;
          })}
        </div>
        ${manual && extra.length > 0 && html`<p class="muted small">${extra.map(([k, sw]) => `${k}: ${sw.label}`).join(" · ")}</p>`}
        <span class="muted small">${manual ? `Surface “${surface.name}” · manual mode` : `Bank ${v.bank.bank} · NUM1–8 recall its patches`}</span>
        ${prefs.switchView === "manual" && !surface && html`<span class="muted small">This rig has no surface.</span>`}
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
  unsupported: "This browser has no Web MIDI. Use Chrome or Edge (Android, Windows, macOS, Linux). Safari on iPhone and iPad has no Web MIDI.",
  denied: "MIDI access was refused. Allow it in the browser's site settings, then reload.",
};

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
          <label class="field">Switches shown by default
            <select value=${prefs.switchView} onChange=${(e) => setPref({ switchView: e.target.value })}>
              <option value="manual">Manual mode (surface)</option>
              <option value="patch">Patch mode (snapshots)</option>
            </select>
          </label>
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

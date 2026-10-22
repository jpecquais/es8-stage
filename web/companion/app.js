// ES8 Companion — la façade de ES8 Stage (Preact + htm, sans compilation). Textes en anglais.
// Spéc : docs/companion.md, docs/stage-host.md. C'est l'écran de l'hôte de scène (`es8stage serve
// --stage`, le Pi) : l'hôte joue le show et parle MIDI à l'ES-8 ; cette page affiche l'état qu'il pousse
// (Server-Sent Events) et lui envoie les gestes (écran, pédales tourne-page du clavier). Le menu mène aux
// shows de la bibliothèque, à l'état de l'ES-8 (vérification, mode édition) et aux autres applis.

import { html, render, useState, useEffect, useRef } from "../shared/vendor/preact-htm.module.js";
import * as S from "./show.js";
import { mountNav, setNavHidden, es8Status } from "../stage-shared/nav.js";

const STORE_KEY = "es8companion";
const DEFAULT_PREFS = { keyboard: true, wake: true, view: "setlist", panel: true }; // view : setlist | switches
const NUMS = ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6", "NUM7", "NUM8"];
const ROLE_TAG = { loop: (sw) => sw.target || "LOOP", param: (sw) => (sw.mode === "momentary" ? "MOM" : "CC"), tap: () => "TAP", es8: () => "ES-8", companion: (sw) => sw.target.replace("_", " ").toUpperCase() };
const RETRY_MS = 3000;

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
}
function saveStore(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* stockage indisponible : l'app marche sans */ }
}

const ICONS = {
  left: "M15 18l-6-6 6-6", right: "M9 18l6-6-6-6", down: "M6 9l6 6 6-6", close: "M18 6L6 18M6 6l12 12",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", menu: "M4 6h16M4 12h16M4 18h16",
  home: "M3 11l9-8 9 8M5 9v11h5v-6h4v6h5V9",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
};
const Icon = ({ name, size = 20 }) => html`
  <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${ICONS[name]} /></svg>`;

/** Geste ou commande pour l'hôte : {type: act|press|goto|resend|edit|check, …}. */
const post = (cmd) => fetch("../stage/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) })
  .catch(() => {});

// ---------------------------------------------------------------- écran allumé
// Wake Lock n'existe que sur une page sécurisée (https, localhost) : sur l'adresse http du Pi, l'iPad ne
// l'a pas. On joue alors en boucle une courte vidéo sans image ni son, ce qui retient la mise en veille
// (lancée au premier toucher : iOS veut un geste). Rend le moyen employé : "lock" | "video" | "".
function useKeepAwake(on) {
  const [how, setHow] = useState("");
  useEffect(() => {
    if (!on) { setHow(""); return undefined; }
    let stopped = false;
    if ("wakeLock" in navigator) {
      let lock = null;
      const acquire = async () => {
        try { lock = await navigator.wakeLock.request("screen"); setHow("lock"); } catch { setHow(""); }
      };
      const onVisible = () => { if (document.visibilityState === "visible" && !stopped) acquire(); };
      acquire();
      document.addEventListener("visibilitychange", onVisible);
      return () => { stopped = true; document.removeEventListener("visibilitychange", onVisible); if (lock) lock.release().catch(() => {}); };
    }
    const video = document.createElement("video");
    video.src = new URL("keepawake.mp4", import.meta.url).href; // aussi depuis l'appli unifiée (/app/)
    video.loop = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("title", "Keep the screen awake");
    video.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none";
    document.body.append(video);
    const play = () => {
      if (stopped || !video.paused) return;
      video.play().then(() => setHow("video")).catch(() => setHow(""));
    };
    const onVisible = () => { if (document.visibilityState === "visible") play(); };
    play();
    window.addEventListener("pointerdown", play, true);
    window.addEventListener("keydown", play, true);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.removeEventListener("pointerdown", play, true);
      window.removeEventListener("keydown", play, true);
      document.removeEventListener("visibilitychange", onVisible);
      video.pause();
      video.remove();
    };
  }, [on]);
  return how;
}

// ---------------------------------------------------------------- app

/** `shell` : posé par l'appli unifiée (web/app/), qui passe en édition par `shell.edit(cible)`. */
export function App({ shell } = {}) {
  const boot = useRef(null);
  if (boot.current === null) boot.current = loadStore();
  const [snap, setSnap] = useState(null); // état poussé par l'hôte : show, pos, states, backup, traffic, midi, edit, check…
  const [link, setLink] = useState("connecting"); // connecting | ok | lost | none (serveur sans hôte de scène)
  const [prefs, setPrefs] = useState({ ...DEFAULT_PREFS, ...boot.current.prefs });
  const [keys, setKeys] = useState(boot.current.keys || S.DEFAULT_KEY_BINDINGS);
  const [move, setMove] = useState({ n: 0, dir: "" }); // dernier déplacement (animation de la vue Switches)
  const [screen, setScreen] = useState("home"); // home | stage | setlists | menu
  const [songsOpen, setSongsOpen] = useState(false);
  const [browse, setBrowse] = useState(null);
  const [learning, setLearning] = useState(null);
  const awake = useKeepAwake(prefs.wake);

  // Le callback du clavier est posé une fois : il lit l'état ici.
  const live = useRef({});
  live.current = { keys, prefs, learning, shell };

  useEffect(() => saveStore({ prefs, keys }), [prefs, keys]);
  const setPref = (patch) => setPrefs((p) => ({ ...p, ...patch }));

  // Lien avec l'hôte : l'état à l'ouverture, puis le flux. EventSource se reconnecte seul après une coupure.
  useEffect(() => {
    let stopped = false;
    let events = null;
    let timer = null;
    let lastMove = null;
    const apply = (s) => {
      setSnap(s);
      if (s.move && lastMove !== null && s.move.n !== lastMove) setMove({ ...s.move, at: Date.now() });
      if (s.move) lastMove = s.move.n;
    };
    const start = async () => {
      let res;
      try { res = await fetch("../stage/state", { cache: "no-store" }); } catch { res = null; }
      if (stopped) return;
      if (!res || !res.ok) {
        setLink(res && res.status === 404 ? "none" : "lost");
        timer = setTimeout(start, RETRY_MS);
        return;
      }
      apply(await res.json());
      setLink("ok");
      events = new EventSource("../stage/events");
      events.onmessage = (e) => {
        let s;
        try { s = JSON.parse(e.data); } catch { return; } // message abîmé : le suivant le remplace
        setLink("ok");
        apply(s);
      };
      events.onerror = () => {
        setLink("lost");
        if (events.readyState === EventSource.CLOSED) { events.close(); timer = setTimeout(start, RETRY_MS); }
      };
    };
    start();
    return () => { stopped = true; clearTimeout(timer); if (events) events.close(); };
  }, []);

  const act = (action) => post({ type: "act", action });
  const goTo = (p) => { post({ type: "goto", setlist: p.setlist, step: p.step }); setSongsOpen(false); };

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const L = live.current;
      if (L.shell && !L.shell.playing()) return; // l'appli unifiée est en édition
      const target = e.composedPath ? e.composedPath()[0] : e.target; // un champ dans un shadow DOM
      if (target.closest && target.closest("input, select, textarea")) return;
      if (L.learning) {
        e.preventDefault();
        if (e.key !== "Escape") setKeys((k) => S.learn(k, L.learning, S.eventFromKey(e.key)));
        setLearning(null);
        return;
      }
      if (!L.prefs.keyboard) return;
      const action = S.actionFor(L.keys, S.eventFromKey(e.key));
      if (action) { e.preventDefault(); act(action); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // « ?view=songs|setlists|menu » ouvre un écran (essais, captures).
  useEffect(() => {
    const v = new URLSearchParams(location.search).get("view");
    if (v === "songs") setSongsOpen(true);
    else if (v === "setlists" || v === "menu" || v === "stage") setScreen(v);
  }, []);

  // Le bandeau des applis : sur le menu et l'attente, pas sur les écrans de scène.
  const onStage = !!(snap && snap.show) && screen !== "menu" && screen !== "home";
  useEffect(() => setNavHidden(onStage), [onStage]);

  if (!snap) return html`<${NoHost} link=${link} />`;
  const ctx = {
    snap, show: snap.show, pos: snap.pos, states: snap.states || {}, backup: !!snap.backup,
    traffic: snap.traffic || { in: "", action: "", out: "" }, link, move, prefs, setPref, keys, setKeys, learning, setLearning,
    act, goTo, favorite: (index) => post({ type: "favorite", index }), resend: () => post({ type: "resend" }), press: (key, down) => post({ type: "press", key, down }),
    setScreen, songsOpen, setSongsOpen, browse, setBrowse, awake, shell,
  };
  if (screen === "menu" || !snap.show) return html`<${Menu} ...${ctx} />`;
  if (screen === "home") return html`<${Home} ...${ctx} />`;
  if (screen === "setlists") return html`<${Setlists} ...${ctx} />`;
  if (prefs.view === "switches") return html`<${SwitchStage} ...${ctx} />`;
  return html`<${Stage} ...${ctx} />`;
}

/** Bandeaux de scène : hôte injoignable, mode édition (switches sans effet), ES-8 débranché. */
function Banners({ snap, link, setScreen }) {
  const out = [];
  const details = setScreen ? html` <button class="link" onClick=${() => setScreen("menu")}>Details</button>` : null;
  if (link === "lost") out.push(html`<p class="banner bad">The stage host does not answer: reconnecting… The ES-8 keeps its sound.</p>`);
  const job = snap.job;
  if (job && !job.done && (job.kind === "send" || job.kind === "try")) {
    out.push(html`<p class="banner edit"><span><b>Writing the ES-8</b> · ${job.kind === "try" ? "one sound" : "the set"}${job.total ? ` (${Math.round((100 * job.n) / job.total)} %)` : ""}.
      The footswitches are paused until it is done.</span></p>`);
  } else if (snap.edit) {
    out.push(html`<div class="banner edit">
      <span><b>Edit mode</b> · the footswitches are paused while the ES-8 is being edited.</span>
      <button class="primary" onClick=${() => post({ type: "edit", on: false })}>Resume the show</button></div>`);
  } else if (snap.midi && !snap.midi.connected) {
    out.push(html`<p class="banner bad">The ES-8 is not connected to the stage host${snap.midi.ble_seen === false
      ? ": the Bluetooth adapter is not visible, another device (a Mac, a phone) may hold it" : ""}.${details}</p>`);
  } else if (snap.check && snap.check.state === "mismatch") {
    out.push(html`<p class="banner warn">The ES-8 does not match this show: some steps may load the wrong patch.${details}</p>`);
  }
  return out.length ? html`<div class="banners">${out}</div>` : null;
}

/** Puce de l'ES-8 dans la barre : branché, vérifié ; toucher ouvre le menu. */
function ES8Chip({ snap, setScreen }) {
  const m = snap.midi || {};
  const [dot, text] = es8Status(snap);
  return html`<button class="chip es8-chip" onClick=${() => setScreen("menu")} title=${m.port || ""}>
    <span class=${`dot ${dot}`}></span><span class="chip-text">${text}</span></button>`;
}

// ---------------------------------------------------------------- édition (appli unifiée)

/** Ce que ✎ ouvre en édition : le son joué (le favori, ou le pas de la setlist), avec son morceau. */
function editTarget(snap, show, pos) {
  const fav = snap.favorite != null && (show.favorites || [])[snap.favorite];
  if (fav) return { section: "sounds", rigName: fav.rig, sound: fav.name };
  const sl = show.setlists[pos.setlist];
  const step = sl.steps[pos.step];
  const song = sl.songs[step.song];
  return { section: "sounds", rig: song.rig, sound: step.snapshot, song: song.name };
}

const EditButton = ({ shell, target, label = "Edit" }) => html`
  <button class="chip edit-btn" onClick=${() => shell.edit(target)} title="Edit what is playing">
    <${Icon} name="edit" size=${18} /><span class="chip-text">${label}</span></button>`;

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
      <${Banners} ...${ctx} />
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

function StatusBar({ snap, show, pos, traffic, setScreen, backup, act, prefs, setPref, link, shell }) {
  const sl = show.setlists[pos.setlist];
  return html`
    <header class="bar">
      <button class="icon-btn" aria-label="Home" onClick=${() => setScreen("home")}><${Icon} name="home" /></button>
      <button class="bar-title" onClick=${() => setScreen("setlists")}>
        <span class="eyebrow">Setlist</span><span class="bar-name">${sl.name}</span>
      </button>
      <div class="seg view-seg" role="group" aria-label="Stage view">
        <button aria-pressed=${prefs.view !== "switches"} onClick=${() => setPref({ view: "setlist" })}>Setlist</button>
        <button aria-pressed=${prefs.view === "switches"} onClick=${() => setPref({ view: "switches" })}>Switches</button>
      </div>
      <span class="spacer"></span>
      <span class="chip mono traffic">
        ${traffic.action ? html`<span class="muted">in</span> ${traffic.in} <span class="muted">→</span> ${traffic.action}` : html`<span class="muted">waiting</span>`}
        ${traffic.out && html` <span class="muted">out</span> <span class="amber">${traffic.out}</span>`}
      </span>
      ${link === "ok" ? html`<${ES8Chip} snap=${snap} setScreen=${setScreen} />` : html`<span class="chip"><span class="dot bad"></span><span class="chip-text">Host lost</span></span>`}
      <button class=${`chip backup-btn ${backup ? "on" : ""}`} aria-pressed=${backup} onClick=${() => act("backup")}
        title="Switch every step to its backup patch, or back">Backup</button>
      ${shell ? html`<${EditButton} shell=${shell} target=${editTarget(snap, show, pos)} />` : null}
      <button class="icon-btn" aria-label="Menu" onClick=${() => setScreen("menu")}><${Icon} name="menu" /></button>
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
      <${Banners} ...${ctx} />
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
        <button class="nav nav-prev" onClick=${() => act("prev")}><${Icon} name="left" size=${30} /><span>Previous</span></button>
        <button class="nav nav-next" onClick=${() => act("next")}><span>Next</span><${Icon} name="right" size=${30} /></button>
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
                onClick=${() => goTo(S.goToSong(show, pos.setlist, k))}>
              <span class="song-num">${k + 1}</span>
              <span class="song-text"><span class="song-name">${song.name}</span>
                <span class="muted small">${show.rigs[song.rig].name} · ${sl.steps.slice(song.first_step, song.first_step + song.steps).map((s) => s.snapshot).join(" → ")}</span></span>
            </button></li>`)}
        </ol>
      </section>
    </div>`;
}

// ---------------------------------------------------------------- accueil

/**
 * L'accueil : les sons favoris, rappelés d'un geste (jam, réglage, balance), puis les setlists.
 * Toucher la setlist en cours y retourne sans rien envoyer ; une autre la démarre à son premier pas.
 */
function Home({ snap, show, pos, goTo, favorite, setScreen, link, shell }) {
  const favs = show.favorites || [];
  const playingFav = snap.favorite;
  const open = (k) => {
    if (k !== pos.setlist || playingFav != null) goTo({ setlist: k, step: k === pos.setlist ? pos.step : 0 });
    setScreen("stage");
  };
  return html`
    <div class="app page home">
      <header class="bar">
        <h1 class="page-title">ES8 Stage</h1>
        <span class="spacer"></span>
        ${link === "ok" ? html`<${ES8Chip} snap=${snap} setScreen=${setScreen} />` : html`<span class="chip"><span class="dot bad"></span><span class="chip-text">Host lost</span></span>`}
        ${shell ? html`<${EditButton} shell=${shell} target=${{ section: "setlists" }} />` : null}
        <button class="icon-btn" aria-label="Menu" onClick=${() => setScreen("menu")}><${Icon} name="menu" /></button>
      </header>
      <div class="page-body">
        <${Banners} snap=${snap} link=${link} setScreen=${setScreen} />
        <section class="home-group">
          <h2 class="eyebrow">Favorites</h2>
          ${favs.length ? html`<div class="favs">${favs.map((f, i) => html`
            <button class=${`fav ${playingFav === i ? "current" : ""}`} aria-pressed=${playingFav === i} onClick=${() => favorite(i)}>
              <span class="fav-name">${f.name}</span><span class="small">${f.rig} · ${f.label}</span></button>`)}</div>`
          : html`<p class="muted">No favorites yet. ${shell ? "Edit, then star the sounds you want here." : "In ES8 Designer, star the sounds you want here."}</p>`}
        </section>
        <section class="home-group">
          <h2 class="eyebrow">Setlists</h2>
          <div class="rows">${show.setlists.map((sl, k) => {
            const here = k === pos.setlist;
            const step = here ? sl.steps[pos.step] : null;
            return html`<button class=${`home-row ${here && playingFav == null ? "current" : ""}`} disabled=${!S.isPlayable(sl)} onClick=${() => open(k)}>
              <span class="song-text"><span class="song-name">${sl.name}</span>
                <span class="small muted">${sl.songs.length} song${sl.songs.length === 1 ? "" : "s"}${step
                  ? ` · now: ${sl.songs[step.song].name}, ${step.snapshot}` : ""}</span></span>
              <${Icon} name="right" /></button>`;
          })}</div>
        </section>
      </div>
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
                      onClick=${() => goTo({ setlist: shown, step: index })}>
                    <span>${st.snapshot}</span><span class="mono small">PC ${index} · ${st.label}</span></button>`;
                })}
              </div>
            </div>
          </section>`)}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- menu

/** Les shows de la bibliothèque de l'hôte : en jouer un le donne à tous les écrans. */
function Shows({ snap }) {
  const [listing, setListing] = useState(null);
  const [busy, setBusy] = useState("");
  const refresh = () => fetch("../library/", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then(setListing).catch(() => setListing(null));
  useEffect(() => { refresh(); }, [snap.show && snap.show.exported]);
  if (!listing) return html`<p class="muted small">The library does not answer.</p>`;
  const play = async (name) => {
    if (snap.show && !confirm(`Play “${name}”? The stage goes to its first step.`)) return;
    setBusy(name);
    try {
      await fetch(`../library/shows/${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"op":"play"}' });
    } finally { setBusy(""); refresh(); }
  };
  return html`
    <div class="lib-shows">
      ${listing.shows.length ? listing.shows.map((it) => html`
        <div class="lib-show">
          <span>${it.name}</span>
          ${it.name === listing.playing ? html`<span class="tag">playing</span>`
            : html`<button class="ghost" disabled=${!!busy} onClick=${() => play(it.name)}>${busy === it.name ? "…" : "Play"}</button>`}
        </div>`)
        : html`<p class="muted small">None yet: in Edit, “Send to the ES-8” adds the set's show here and plays it.</p>`}
    </div>`;
}

const CHECK_TEXT = {
  ok: "The ES-8 matches this show: every step loads the right patch.",
  mismatch: "The ES-8 does not match this show. In Edit, use “Send to the ES-8”.",
  checking: "Reading the ES-8 settings…",
  error: "The check failed.",
  unknown: "Not checked yet.",
};

function ES8Box({ snap }) {
  const m = snap.midi || {};
  const c = snap.check || { state: "unknown" };
  const busy = snap.job && !snap.job.done;
  return html`
    <section class="box">
      <h2 class="eyebrow">ES-8</h2>
      <p><span class=${`dot ${m.connected ? "ok" : "bad"}`}></span> ${m.connected ? `Connected · ${m.port}` : `Not connected (looking for “${m.match}”)`}</p>
      ${m.connected ? html`
        <p class=${c.state === "mismatch" || c.state === "error" ? "notice" : "muted"}>${CHECK_TEXT[c.state] || c.state}
          ${c.state === "error" && c.error ? ` ${c.error}` : ""}</p>
        ${c.setlists && c.state === "mismatch" ? html`<ul class="small">${c.setlists.map((s) => html`
          <li>${s.name} (MIDI bank ${s.midi_bank}): ${s.ok ? "matches" : "differs"}</li>`)}
          ${c.channel !== c.show_channel ? html`<li>The ES-8 listens on channel ${c.channel}, the show sends on ${c.show_channel}.</li>` : null}</ul>` : null}
        <div class="row-wrap">
          <button class="ghost" disabled=${busy || snap.edit} onClick=${() => post({ type: "check" })}>Check now</button>
        </div>` : m.ble_seen === false ? html`<p class="notice">The Bluetooth adapter (${m.ble}) is not visible. A Bluetooth MIDI adapter
          talks to one device at a time: if a Mac, a phone or a tablet is connected to it, disconnect it there (on a Mac that should not use it,
          forget the device in the Bluetooth settings). The stage host takes it back by itself. Otherwise, switch the adapter (or the ES-8) off and on.</p>`
        : html`<p class="muted small">The stage host reconnects by itself. If it does not after a minute,
          switch the WIDI (or the ES-8) off and on, or use Reconnect on the <a href="../host/">host page</a>.</p>`}
      <label class="check"><input type="checkbox" checked=${!!snap.edit} onChange=${(e) => post({ type: "edit", on: e.target.checked })} />
        <span><b>Edit mode</b> <span class="muted small">pauses the footswitches so that ES8 Designer or ES8 Control can write to the ES-8.
          It turns itself off after 10 minutes without editing.</span></span></label>
    </section>`;
}

function KeysBox({ keys, setKeys, learning, setLearning, prefs, setPref }) {
  return html`
    <section class="box actions">
      <div class="box-head">
        <h2 class="eyebrow">Page-turner pedals · keyboard</h2>
        <button class="ghost" onClick=${() => { setKeys(S.DEFAULT_KEY_BINDINGS); setLearning(null); }}>Default keys</button>
      </div>
      <label class="check"><input type="checkbox" checked=${prefs.keyboard} onChange=${(e) => setPref({ keyboard: e.target.checked })} />
        Accept the keys of a Bluetooth pedal or a keyboard on this screen</label>
      ${S.ACTIONS.map((a) => {
        const mine = keys.filter((b) => b.action === a.id);
        return html`<div class="action-row">
          <span class="action-name">${a.label}</span>
          <span class="grow">
            ${learning === a.id
              ? html`<span class="listening">Press a pedal or a key (Esc cancels)</span>`
              : mine.length ? mine.map((b) => html`<span class="tag mono">${S.describeBinding(b)}</span>`) : html`<span class="muted">none</span>`}
          </span>
          <button class=${learning === a.id ? "primary" : "ghost"} onClick=${() => setLearning(learning === a.id ? null : a.id)}>${learning === a.id ? "Cancel" : "Learn"}</button>
          <button class="ghost" disabled=${!mine.length} onClick=${() => setKeys(S.clearAction(keys, a.id))}>Clear</button>
        </div>`;
      })}
      <p class="muted small">The ES-8 footswitches are set in ES8 Designer (surfaces); these keys only work on this screen.</p>
    </section>`;
}

function Menu(ctx) {
  const { snap, show, setScreen, setLearning, prefs, setPref, awake, link } = ctx;
  return html`
    <div class="app page">
      <header class="bar">
        ${show ? html`<button class="ghost" onClick=${() => { setLearning(null); setScreen("stage"); }}><${Icon} name="left" size=${18} /> Stage</button>` : null}
        <h1 class="page-title">ES8 Companion</h1>
        <span class="spacer"></span>
      </header>
      <div class="page-body settings">
        <${Banners} snap=${snap} link=${link} />
        <section class="box">
          <h2 class="eyebrow">Show</h2>
          ${show ? html`<p class="box-title">${show.setlists.map((s) => s.name).join(" · ")}</p>
              <p class="muted small">Exported ${show.exported ? new Date(show.exported).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "?"}</p>`
            : html`<p>No show is played yet. Choose one below, or prepare a set in Edit and use “Send to the ES-8”.</p>`}
          <${Shows} snap=${snap} />
        </section>
        <${ES8Box} snap=${snap} />
        <${KeysBox} ...${ctx} />
        <section class="box">
          <h2 class="eyebrow">This screen</h2>
          <label class="check"><input type="checkbox" checked=${prefs.wake} onChange=${(e) => setPref({ wake: e.target.checked })} />
            Keep the screen awake</label>
          ${prefs.wake && awake !== "lock" ? html`<p class="muted small">${awake === "video"
            ? "Kept awake by a silent video (this address has no Wake Lock)."
            : "Tap the screen once to keep it awake."} On an iPad, to be sure: Settings › Display & Brightness › Auto-Lock › Never.</p>` : null}
        </section>
      </div>
    </div>`;
}

/** Pas d'hôte de scène (encore) : on attend, ou on explique. */
function NoHost({ link }) {
  return html`
    <div class="app page welcome">
      <div class="welcome-body">
        <h1>ES8 Companion</h1>
        ${link === "none"
          ? html`<p>This server is not a stage host. ES8 Companion is the screen of a stage host, which plays the show
              and talks to the ES-8: run <code>es8stage serve --stage</code> (on the Raspberry Pi, or on this computer to rehearse).</p>`
          : link === "lost"
            ? html`<p>The stage host does not answer. Trying again…</p>`
            : html`<p class="muted">Connecting to the stage host…</p>`}
      </div>
    </div>`;
}

if (!window.ES8_SHELL) { // page seule ; dans l'appli unifiée, c'est elle qui monte la Companion
  render(html`<${App} />`, document.getElementById("root"));
  mountNav("companion");
}

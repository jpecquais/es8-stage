// ES8 Designer, version tactile — prototype (Preact + htm, sans compilation). Textes en anglais.
// Pensé pour le doigt : barre d'onglets en bas, grandes cartes et tuiles, feuilles qui montent du bas pour
// chaque choix, pas à pas − / + et glissière au lieu des champs numériques, appui long pour déplacer.
// Lit le set joué par l'hôte de scène ; les changements restent dans la page (rien n'est enregistré).

import { html, render, useState, useEffect, useRef } from "../shared/vendor/preact-htm.module.js";
import { es8Status } from "../stage-shared/nav.js";

const BOARD = [["MEM_M", "MUTE", "BANK_D", "BANK_U", "NUM7", "NUM8"], ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6"]];
const JACKS = ["CTL_IN_1", "CTL_IN_2", "CTL_IN_3", "CTL_IN_4"];
const SWITCH_NAME = { MEM_M: "MEM/MAN", BANK_D: "BANK ▼", BANK_U: "BANK ▲", CTL_IN_1: "CTL IN 1", CTL_IN_2: "CTL IN 2", CTL_IN_3: "CTL IN 3", CTL_IN_4: "CTL IN 4" };
const COMPANION_ACTIONS = [["next", "Next step"], ["prev", "Previous step"], ["next_song", "Next song"], ["prev_song", "Previous song"], ["song_start", "Song start"]];
const LOOPS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "V"];
const TABS = [
  ["setlist", "Setlist", "M4 6h16M4 12h16M4 18h10"],
  ["tracks", "Songs", "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"],
  ["sounds", "Sounds", "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"],
  ["switches", "Switches", "M7 7h.01M12 7h.01M17 7h.01M7 17h.01M12 17h.01M17 17h.01M3 3h18v18H3z"],
  ["pedalboard", "Pedalboard", "M4 4h6v16H4zM14 4h6v16h-6z"],
];

const clone = (x) => JSON.parse(JSON.stringify(x));
const swName = (key) => SWITCH_NAME[key] || key;
const patchAt = (n) => `${Math.floor(n / 8)}-${(n % 8) + 1}`;
const parseLabel = (t) => { const m = /^\s*(\d{1,2})\s*-\s*([1-8])\s*$/.exec(String(t)); return m ? Number(m[1]) * 8 + Number(m[2]) - 1 : 0; };
const rigStart = (rig) => (typeof rig.start === "string" ? parseLabel(rig.start) : rig.start ?? (rig.bank || 0) * 8);
const patchOf = (rig, i) => patchAt(rigStart(rig) + i);
const newId = (taken, base) => { let id = base, n = 2; while (taken[id]) id = `${base}-${n++}`; return id; };
const slug = (t) => (t || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";

function allParams(doc) {
  const out = [];
  for (const [did, dev] of Object.entries(doc.pedalboard.devices || {})) {
    for (const [pid, p] of Object.entries((dev.midi && dev.midi.params) || {})) out.push({ ref: `${did}.${pid}`, did, pid, dev, p });
  }
  return out;
}
const loopDevice = (doc, loop) => Object.values(doc.pedalboard.devices || {}).find((d) => (d.loops || []).includes(loop));

// ================================================================= données

let toastTimer = null;
function useToast() {
  const [msg, setMsg] = useState("");
  const show = (text) => { setMsg(text); clearTimeout(toastTimer); toastTimer = setTimeout(() => setMsg(""), 2600); };
  return [msg, show];
}

function App() {
  const [loaded, setLoaded] = useState(null); // { name, doc } tel que lu
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [snap, setSnap] = useState(null);
  const [tab, setTab] = useState("setlist");
  const [view, setView] = useState({}); // { track, rig, setlist }
  const [sheet, setSheet] = useState(null);
  const [msg, toast] = useToast();

  useEffect(() => {
    (async () => {
      try {
        const listing = await (await fetch("../library/", { cache: "no-store" })).json();
        const name = listing.playing || (listing.projects[0] || {}).name;
        if (!name) throw new Error("No set in the library yet.");
        const d = await (await fetch(`../library/projects/${encodeURIComponent(name)}`, { cache: "no-store" })).json();
        setLoaded({ name, doc: d });
        setDoc(clone(d));
      } catch (err) { setError(err.message || String(err)); }
    })();
    let events = null;
    fetch("../stage/state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (!s) return;
      setSnap(s);
      events = new EventSource("../stage/events");
      events.onmessage = (e) => { try { setSnap(JSON.parse(e.data)); } catch { /* le suivant */ } };
    }).catch(() => {});
    return () => events && events.close();
  }, []);

  if (error) return html`<div class="loading">${error}</div>`;
  if (!doc) return html`<div class="loading">Loading the set…</div>`;

  const edit = (fn) => setDoc((d) => { const next = clone(d); fn(next); return next; });
  const changed = JSON.stringify(doc) !== JSON.stringify(loaded.doc);
  const ctx = { doc, edit, view, setView, setSheet, toast, go: (t, v = {}) => { setTab(t); setView(v); } };
  const [dot, text] = snap ? es8Status(snap) : ["", "ES-8"];
  const Screen = { setlist: SetlistScreen, tracks: TracksScreen, sounds: SoundsScreen, switches: SwitchesScreen, pedalboard: PedalboardScreen }[tab];

  return html`
    <div class="app">
      <header class="head">
        <div class="set"><small>Set${snap && snap.playing === loaded.name ? " · on stage" : ""}</small><b>${loaded.name}</b></div>
        <span class="chip"><span class=${`dot ${dot}`}></span><span class="txt">${text}</span></span>
        <button class="send" onClick=${() => toast("Prototype: Send to stage is in the regular Designer for now.")}>Send to stage</button>
      </header>
      <div class="proto">Touch prototype: what you change here is not saved.
        ${changed ? html`<button onClick=${() => setDoc(clone(loaded.doc))}>Undo all</button>` : null}
        <a href="../designer/" style="color:inherit;margin-left:auto">Regular Designer</a></div>
      <main class="screen" key=${tab + JSON.stringify(view)}><${Screen} ...${ctx} /></main>
      <nav class="tabbar">${TABS.map(([id, label, d]) => html`
        <button aria-current=${tab === id ? "page" : null} onClick=${() => { setTab(id); setView({}); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d=${d} /></svg>
          ${label}</button>`)}</nav>
      ${sheet ? html`<${Sheet} ...${sheet} ctx=${ctx} close=${() => setSheet(null)} />` : null}
      ${msg ? html`<div class="toast">${msg}</div>` : null}
    </div>`;
}

// ================================================================= liste qu'on réordonne à l'appui long

/** Toucher : `onTap(i)`. Appui long puis glisser : la carte suit le doigt, `onMove(from, to)`. Appui long sans bouger : `onHold(i)`. */
function Sortable({ items, keyOf, card, onTap, onHold, onMove }) {
  const [drag, setDrag] = useState(null); // { from, to, dy }
  const st = useRef({ i: null });
  const list = useRef();
  useEffect(() => {
    // Pendant qu'une carte est levée, la page ne défile pas (iOS : touchmove non passif).
    const block = (e) => { if (st.current.lifted) e.preventDefault(); };
    document.addEventListener("touchmove", block, { passive: false });
    return () => document.removeEventListener("touchmove", block);
  }, []);
  const props = (i) => ({
    onPointerDown: (e) => {
      const s = { i, x0: e.clientX, y0: e.clientY, lifted: false, moved: false, id: e.pointerId, el: e.currentTarget };
      st.current = s;
      s.timer = setTimeout(() => {
        s.lifted = true;
        try { s.el.setPointerCapture(s.id); } catch { /* rien */ }
        if (navigator.vibrate) navigator.vibrate(10);
        s.rects = [...list.current.children].map((c) => c.getBoundingClientRect());
        setDrag({ from: i, to: i, dy: 0 });
      }, 300);
    },
    onPointerMove: (e) => {
      const s = st.current;
      if (s.i !== i) return;
      const dy = e.clientY - s.y0;
      if (!s.lifted) {
        if (Math.abs(dy) > 8 || Math.abs(e.clientX - s.x0) > 8) { clearTimeout(s.timer); s.i = null; } // il défile
        return;
      }
      s.moved = true;
      const mid = s.rects[i].top + s.rects[i].height / 2 + dy;
      let to = s.rects.findIndex((r) => mid < r.bottom);
      if (to < 0) to = s.rects.length - 1;
      setDrag({ from: i, to, dy });
    },
    onPointerUp: () => {
      const s = st.current;
      clearTimeout(s.timer);
      if (s.i !== i) return;
      s.i = null;
      if (!s.lifted) { onTap(i); return; }
      s.lifted = false;
      const d = drag;
      setDrag(null);
      if (s.moved && d && d.to !== d.from) onMove(d.from, d.to);
      else if (!s.moved && onHold) onHold(i);
    },
    onPointerCancel: () => { const s = st.current; clearTimeout(s.timer); s.i = null; s.lifted = false; setDrag(null); },
    onContextMenu: (e) => e.preventDefault(),
  });
  const shift = (i) => {
    if (!drag || i === drag.from) return 0;
    const h = st.current.rects[drag.from].height + 10;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return h;
    return 0;
  };
  return html`<div class="cards" ref=${list}>${items.map((it, i) => {
    const lifted = drag && drag.from === i;
    const style = lifted ? `transform: translateY(${drag.dy}px) scale(1.03)` : shift(i) ? `transform: translateY(${shift(i)}px)` : "";
    return html`<div key=${keyOf(it, i)} role="button" class=${`card ${lifted ? "lifted" : ""}`} style=${style} ...${props(i)}>${card(it, i)}</div>`;
  })}</div>`;
}

const moved = (list, from, to) => { const next = [...list]; const [x] = next.splice(from, 1); next.splice(to, 0, x); return next; };

// ================================================================= setlist

function SetlistScreen({ doc, edit, view, setView, setSheet, go }) {
  const ids = Object.keys(doc.setlists || {});
  const sid = view.setlist && doc.setlists[view.setlist] ? view.setlist : ids[0];
  if (!sid) return html`<h2>Setlist</h2><p class="lead">No setlist yet.</p>`;
  const sl = doc.setlists[sid];
  let pc = 0;
  const rows = sl.songs.map((song) => {
    const tr = doc.tracks[song.track];
    const n = tr ? tr.sequence.length : 0;
    const at = pc;
    pc += n;
    return { song, tr, pc: n > 1 ? `PC ${at}–${at + n - 1}` : `PC ${at}` };
  });
  const setSongs = (fn) => edit((d) => { d.setlists[sid].songs = fn(d.setlists[sid].songs); });
  return html`
    <div class="titlebar"><h2>${sl.name}</h2>
      ${ids.length > 1 ? html`<div class="seg">${ids.map((id) => html`<button aria-pressed=${id === sid} onClick=${() => setView({ setlist: id })}>${doc.setlists[id].name}</button>`)}</div>` : null}</div>
    <p class="lead">${rows.length} songs · ${pc} steps. Touch a song to open it; hold it to move it.</p>
    <${Sortable} items=${rows} keyOf=${(r, i) => `${r.song.track}-${i}`}
      onTap=${(i) => rows[i].tr && go("tracks", { track: rows[i].song.track })}
      onHold=${(i) => setSheet({ kind: "songActions", sid, index: i })}
      onMove=${(from, to) => setSongs((s) => moved(s, from, to))}
      card=${(r, i) => html`
        <span class="num">${i + 1}</span>
        <span><div class="t">${r.tr ? r.tr.name : r.song.track}</div>
          <div class="s">${r.tr ? r.tr.sequence.join(" → ") : "missing song"}</div></span>
        <span class="pc">${r.pc}</span>`} />
    <button class="add" onClick=${() => setSheet({ kind: "addSong", sid })}>+ Add a song</button>`;
}

// ================================================================= morceaux

function TracksScreen(ctx) {
  const { doc, view, setView, setSheet } = ctx;
  if (view.track && doc.tracks[view.track]) return html`<${TrackDetail} ...${ctx} id=${view.track} />`;
  const tracks = Object.entries(doc.tracks || {}).sort((a, b) => a[1].name.localeCompare(b[1].name));
  return html`
    <h2>Songs</h2>
    <p class="lead">Each song plays sounds in an order: Verse, Chorus, Solo…</p>
    <div class="tiles">
      ${tracks.map(([id, tr]) => html`
        <button class="tile" onClick=${() => setView({ track: id })}>
          <span class="k">${(doc.rigs[tr.rig] || {}).short || ""}</span>
          <span class="t">${tr.name}</span>
          <span class="s">${tr.sequence.length} ${tr.sequence.length === 1 ? "step" : "steps"}</span>
        </button>`)}
      <button class="tile add" onClick=${() => setSheet({ kind: "newTrack" })}>+ New song</button>
    </div>`;
}

function TrackDetail({ doc, edit, setView, setSheet, id }) {
  const tr = doc.tracks[id];
  const rig = doc.rigs[tr.rig];
  const inSets = Object.values(doc.setlists || {}).filter((s) => s.songs.some((x) => x.track === id)).map((s) => s.name);
  return html`
    <button class="back" onClick=${() => setView({})}>‹ Songs</button>
    <div class="titlebar"><h2>${tr.name}</h2>
      <button class="ghost" onClick=${() => setSheet({ kind: "rename", title: "Song name", value: tr.name, save: (v) => edit((d) => { d.tracks[id].name = v; }) })}>Rename</button></div>
    <button class="choice" onClick=${() => setSheet({ kind: "trackRig", id })}>Sounds from <b>${rig ? rig.name : "—"}</b><span class="s">change ›</span></button>
    <div class="section-title">Running order</div>
    <p class="hint">Touch a step to change it, move it or remove it.</p>
    <div class="steps">
      ${tr.sequence.map((name, i) => html`
        ${i ? html`<span class="arrow">→</span>` : null}
        <button class="step" onClick=${() => setSheet({ kind: "step", id, index: i })}>
          <span class="k">STEP ${i + 1}${rig ? ` · ${patchOf(rig, Math.max(0, rig.snapshots.findIndex((s) => s.name === name)))}` : ""}</span>
          <span class="t">${name}</span></button>`)}
      <button class="tile add" style="min-width:120px;min-height:96px" onClick=${() => setSheet({ kind: "step", id, index: tr.sequence.length, adding: true })}>+ Step</button>
    </div>
    <p class="hint">${inSets.length ? `In ${inSets.join(", ")}.` : "In no setlist yet."}</p>`;
}

// ================================================================= sons (rigs et snapshots)

function SoundsScreen({ doc, edit, view, setView, setSheet }) {
  const ids = Object.keys(doc.rigs || {});
  const rid = view.rig && doc.rigs[view.rig] ? view.rig : ids[0];
  if (!rid) return html`<h2>Sounds</h2><p class="lead">No rig yet.</p>`;
  const rig = doc.rigs[rid];
  const chain = rig.chain || [];
  return html`
    <div class="titlebar"><h2>Sounds</h2>
      ${ids.length > 1 ? html`<div class="seg">${ids.map((id) => html`<button aria-pressed=${id === rid} onClick=${() => setView({ rig: id })}>${doc.rigs[id].name}</button>`)}</div>` : null}</div>
    <p class="lead">${rig.name}: one ES-8 patch per sound, from ${patchOf(rig, 0)}. Touch a sound to set its loops and MIDI.</p>
    <div class="tiles">
      ${rig.snapshots.map((sn, i) => {
        const midi = Object.values(sn.params || {}).filter((v) => v && v !== "off").length;
        return html`<button class="tile" onClick=${() => setSheet({ kind: "sound", rid, index: i })}>
          <span class="k">${patchOf(rig, i)}</span>
          <span class="t">${sn.name}</span>
          <span class="leds">${chain.map((l) => html`<i class=${(sn.loops || []).includes(l) ? "on" : ""} title=${l}></i>`)}
            ${midi ? html`<span class="s" style="margin-left:6px">${midi} MIDI</span>` : null}</span>
        </button>`;
      })}
      <button class="tile add" onClick=${() => {
        const i = rig.snapshots.length;
        edit((d) => { d.rigs[rid].snapshots.push({ name: `Sound ${i + 1}`, loops: [...chain], params: {} }); });
        setSheet({ kind: "sound", rid, index: i });
      }}>+ New sound</button>
    </div>`;
}

// ================================================================= switches

function switchText(doc, sw) {
  if (!sw || !sw.role) return "—";
  if (sw.label) return sw.label;
  if (sw.role === "param") { const p = allParams(doc).find((x) => x.ref === sw.param); return p ? p.p.name : sw.param; }
  if (sw.role === "companion") return (COMPANION_ACTIONS.find(([a]) => a === sw.action) || [0, sw.action])[1];
  if (sw.role === "loop") return sw.loop;
  if (sw.role === "tap") return "Tap";
  return sw.function || sw.role;
}

function SwitchesScreen({ doc, setSheet }) {
  const sid = Object.keys(doc.surfaces || {})[0];
  if (!sid) return html`<h2>Switches</h2><p class="lead">No surface yet.</p>`;
  const sf = doc.surfaces[sid];
  const pad = (key) => {
    const sw = (sf.switches || {})[key];
    const cls = sw && sw.role === "companion" ? "nav" : sw && sw.role ? "set" : "";
    return html`<button class=${`pad ${cls}`} onClick=${() => setSheet({ kind: "switch", sid, key })}>
      <span class="knob"></span><span class="k">${swName(key)}</span><span class="t">${switchText(doc, sw)}</span></button>`;
  };
  return html`
    <h2>Switches</h2>
    <p class="lead">${sf.name}: touch a footswitch to choose what it does.</p>
    <div class="board">${BOARD.flat().map(pad)}</div>
    <div class="section-title">Pedal jacks</div>
    <div class="ctl-row">${JACKS.map(pad)}</div>`;
}

// ================================================================= pédalier

function PedalboardScreen({ doc, edit, setSheet }) {
  const devices = Object.entries(doc.pedalboard.devices || {});
  return html`
    <h2>Pedalboard</h2>
    <p class="lead">Touch a loop to choose what is plugged in; touch a device for its MIDI.</p>
    <div class="section-title">ES-8 loops</div>
    <div class="loops">${LOOPS.map((l) => {
      const dev = loopDevice(doc, l);
      return html`<button class=${`loop ${dev ? "" : "free"}`} onClick=${() => setSheet({ kind: "loop", loop: l })}>
        <span class="k">${l}</span><span class="t">${dev ? dev.name : "free"}</span></button>`;
    })}</div>
    <div class="section-title">Devices</div>
    <div class="tiles">
      ${devices.map(([id, dev]) => html`
        <button class=${`tile ${dev.midi ? "midi on" : ""}`} onClick=${() => setSheet({ kind: "device", id })}>
          <span class="k">${(dev.loops || []).join(" ") || "no loop"}${dev.midi ? ` · MIDI ch ${dev.midi.channel}` : ""}</span>
          <span class="t">${dev.name}</span>
          <span class="s">${dev.midi ? `${Object.keys(dev.midi.params || {}).length} parameters` : "no MIDI"}</span>
        </button>`)}
      <button class="tile add" onClick=${() => {
        let id = "";
        edit((d) => { id = newId(d.pedalboard.devices, "device"); d.pedalboard.devices[id] = { name: "New device", loops: [] }; });
        setTimeout(() => setSheet({ kind: "device", id }), 0);
      }}>+ New device</button>
    </div>`;
}

// ================================================================= feuilles

function Sheet(props) {
  const { kind, close } = props;
  const S = SHEETS[kind];
  return html`<div class="veil" onPointerDown=${(e) => e.target === e.currentTarget && close()}>
    <div class="sheet" role="dialog"><${S} ...${props} /></div></div>`;
}
const Head = ({ title, close, extra }) => html`<header><h3>${title}</h3>${extra || html`<button class="ghost" onClick=${close}>Close</button>`}</header>`;
const Done = ({ close, children }) => html`<footer>${children}<button class="done" onClick=${close}>Done</button></footer>`;

function Stepper({ value, min, max, onChange, slider = true }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)));
  return html`<div>
    <div class="stepper"><button onClick=${() => set(value - 1)} aria-label="Less">−</button><span class="v">${value}</span>
      <button onClick=${() => set(value + 1)} aria-label="More">+</button></div>
    ${slider ? html`<input class="slider" type="range" min=${min} max=${max} value=${value} onInput=${(e) => set(Number(e.target.value))} />` : null}</div>`;
}

const SHEETS = {
  rename({ title, value, save, close }) {
    const [v, setV] = useState(value);
    const ok = () => { if (v.trim()) save(v.trim()); close(); };
    return html`<${Head} title=${title} close=${close} />
      <div class="body"><input class="namefield" value=${v} autoFocus onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && ok()} /></div>
      <footer><button class="ghost" onClick=${close}>Cancel</button><button class="done" onClick=${ok}>Save</button></footer>`;
  },

  songActions({ ctx, sid, index, close }) {
    const { doc, edit, go } = ctx;
    const songs = doc.setlists[sid].songs;
    const tr = doc.tracks[songs[index].track];
    const mv = (to) => { edit((d) => { d.setlists[sid].songs = moved(d.setlists[sid].songs, index, to); }); close(); };
    return html`<${Head} title=${tr ? tr.name : "Song"} close=${close} />
      <div class="body"><div class="choices">
        <button class="choice" onClick=${() => { close(); go("tracks", { track: songs[index].track }); }}>Open the song</button>
        <button class="choice" disabled=${index === 0} onClick=${() => mv(0)}>Move to the top</button>
        <button class="choice" disabled=${index === songs.length - 1} onClick=${() => mv(songs.length - 1)}>Move to the end</button>
        <button class="choice" onClick=${() => { edit((d) => { d.setlists[sid].songs.splice(index + 1, 0, { ...songs[index] }); }); close(); }}>Play it again later (duplicate)</button>
        <button class="choice danger" onClick=${() => { edit((d) => { d.setlists[sid].songs.splice(index, 1); }); close(); }}>Remove from the setlist</button>
      </div></div>`;
  },

  addSong({ ctx, sid, close }) {
    const { doc, edit, toast } = ctx;
    const tracks = Object.entries(doc.tracks).sort((a, b) => a[1].name.localeCompare(b[1].name));
    const inSet = new Set(doc.setlists[sid].songs.map((s) => s.track));
    return html`<${Head} title="Add a song" close=${close} />
      <div class="body"><div class="choices">${tracks.map(([id, tr]) => html`
        <button class="choice" onClick=${() => { edit((d) => { d.setlists[sid].songs.push({ track: id }); }); toast(`${tr.name} added at the end.`); close(); }}>
          ${tr.name}<span class="s">${inSet.has(id) ? "already in" : `${tr.sequence.length} steps`}</span></button>`)}</div></div>`;
  },

  newTrack({ ctx, close }) {
    const { doc, edit, go } = ctx;
    const [name, setName] = useState("");
    const rigs = Object.entries(doc.rigs);
    const [rid, setRid] = useState(rigs[0] && rigs[0][0]);
    const ok = () => {
      if (!name.trim() || !rid) return;
      let id = "";
      edit((d) => { id = newId(d.tracks, slug(name)); d.tracks[id] = { schema: "es8ctl.track/1", name: name.trim(), rig: rid, sequence: [d.rigs[rid].snapshots[0].name] }; });
      close();
      setTimeout(() => go("tracks", { track: id }), 0);
    };
    return html`<${Head} title="New song" close=${close} />
      <div class="body">
        <input class="namefield" placeholder="Song name" value=${name} autoFocus onInput=${(e) => setName(e.target.value)} />
        <div class="section-title">Sounds from</div>
        <div class="choices">${rigs.map(([id, r]) => html`<button class="choice" aria-pressed=${id === rid} onClick=${() => setRid(id)}>${r.name}<span class="s">${r.snapshots.length} sounds</span></button>`)}</div>
      </div>
      <footer><button class="ghost" onClick=${close}>Cancel</button><button class="done" disabled=${!name.trim()} onClick=${ok}>Create</button></footer>`;
  },

  trackRig({ ctx, id, close }) {
    const { doc, edit } = ctx;
    return html`<${Head} title="Sounds from" close=${close} />
      <div class="body"><div class="choices">${Object.entries(doc.rigs).map(([rid, r]) => html`
        <button class="choice" aria-pressed=${doc.tracks[id].rig === rid} onClick=${() => { edit((d) => {
          d.tracks[id].rig = rid;
          const names = d.rigs[rid].snapshots.map((s) => s.name);
          d.tracks[id].sequence = d.tracks[id].sequence.map((n) => (names.includes(n) ? n : names[0]));
        }); close(); }}>${r.name}<span class="s">${r.snapshots.length} sounds</span></button>`)}</div></div>`;
  },

  step({ ctx, id, index, adding, close }) {
    const { doc, edit } = ctx;
    const tr = doc.tracks[id];
    const rig = doc.rigs[tr.rig];
    const cur = tr.sequence[index];
    const pick = (name) => { edit((d) => { const seq = d.tracks[id].sequence; if (adding) seq.push(name); else seq[index] = name; }); close(); };
    const mv = (to) => { edit((d) => { d.tracks[id].sequence = moved(d.tracks[id].sequence, index, to); }); close(); };
    return html`<${Head} title=${adding ? "Add a step" : `Step ${index + 1}`} close=${close} />
      <div class="body">
        ${adding ? null : html`<div class="seg">
          <button disabled=${index === 0} onClick=${() => mv(index - 1)}>‹ Earlier</button>
          <button disabled=${index === tr.sequence.length - 1} onClick=${() => mv(index + 1)}>Later ›</button>
          <button onClick=${() => { edit((d) => { d.tracks[id].sequence.splice(index + 1, 0, cur); }); close(); }}>Duplicate</button>
          <button style="color:var(--bad)" disabled=${tr.sequence.length < 2} onClick=${() => { edit((d) => { d.tracks[id].sequence.splice(index, 1); }); close(); }}>Remove</button>
        </div>`}
        <div class="section-title">Sound</div>
        <div class="tiles">${(rig ? rig.snapshots : []).map((sn, i) => html`
          <button class=${`tile ${sn.name === cur ? "on" : ""}`} onClick=${() => pick(sn.name)}>
            <span class="k">${patchOf(rig, i)}</span><span class="t">${sn.name}</span></button>`)}</div>
      </div>`;
  },

  sound({ ctx, rid, index, close }) {
    const { doc, edit } = ctx;
    const rig = doc.rigs[rid];
    const sn = rig.snapshots[index];
    const [valueOf, setValueOf] = useState(null);
    if (!sn) return html`<${Head} title="Sound" close=${close} />`;
    const set = (fn) => edit((d) => fn(d.rigs[rid].snapshots[index]));
    const params = allParams(doc).filter((x) => (rig.devices || []).includes(x.did));
    return html`<${Head} title=${patchOf(rig, index)} close=${close} />
      <div class="body">
        <input class="namefield" value=${sn.name} onInput=${(e) => {
          const v = e.target.value;
          edit((d) => {
            const old = d.rigs[rid].snapshots[index].name;
            d.rigs[rid].snapshots[index].name = v;
            Object.values(d.tracks).forEach((t) => { if (t.rig === rid) t.sequence = t.sequence.map((n) => (n === old ? v : n)); });
          });
        }} />
        <div class="section-title">Loops</div>
        <div class="tiles">${(rig.chain || []).map((l) => {
          const on = (sn.loops || []).includes(l);
          const dev = loopDevice(doc, l);
          return html`<button class=${`tile ${on ? "on" : ""}`} onClick=${() => set((s) => { s.loops = on ? s.loops.filter((x) => x !== l) : [...(s.loops || []), l]; })}>
            <span class="k">${l} · ${on ? "ON" : "OFF"}</span><span class="t">${dev ? dev.name : l}</span></button>`;
        })}</div>
        ${params.length ? html`<div class="section-title">MIDI</div>
          <p class="hint">Touch: on / off. Hold: send a value.</p>
          <div class="tiles">${params.map((x) => {
            const v = (sn.params || {})[x.ref];
            const num = typeof v === "number";
            return html`<button class=${`tile midi ${v === "on" ? "on" : ""} ${num ? "val" : ""}`}
              ...${hold(() => setValueOf(x.ref))}
              onClick=${(e) => { if (e.currentTarget.dataset.held) return; set((s) => { s.params = { ...(s.params || {}), [x.ref]: v === "on" ? "off" : "on" }; }); }}>
              <span class="k">${x.dev.name} · CC ${x.p.cc}</span><span class="t">${x.p.name}</span>
              <span class="v">${num ? v : v === "on" ? "ON" : "off"}</span></button>`;
          })}</div>` : null}
        ${valueOf ? html`<div class="section-title">${(params.find((x) => x.ref === valueOf) || {}).p.name} · value</div>
          <${Stepper} value=${typeof (sn.params || {})[valueOf] === "number" ? sn.params[valueOf] : 64} min=${0} max=${127}
            onChange=${(n) => set((s) => { s.params = { ...(s.params || {}), [valueOf]: n }; })} />` : null}
      </div>
      <${Done} close=${close}>
        <button class="ghost danger" disabled=${rig.snapshots.length < 2} onClick=${() => { edit((d) => { d.rigs[rid].snapshots.splice(index, 1); }); close(); }}>Delete sound</button>
      </${Done}>`;
  },

  switch({ ctx, sid, key, close }) {
    const { doc, edit } = ctx;
    const sw = (doc.surfaces[sid].switches || {})[key] || {};
    const put = (next) => edit((d) => {
      const sws = d.surfaces[sid].switches = d.surfaces[sid].switches || {};
      if (next) sws[key] = next; else delete sws[key];
    });
    const params = allParams(doc);
    const loops = Object.values(doc.pedalboard.devices || {}).flatMap((d) => (d.loops || []).map((l) => [l, d.name]));
    return html`<${Head} title=${swName(key)} close=${close} />
      <div class="body">
        <div class="choices"><button class="choice" aria-pressed=${!sw.role} onClick=${() => put(null)}>Nothing</button></div>
        <div class="section-title">Move through the set</div>
        <div class="choices">${COMPANION_ACTIONS.map(([a, label]) => html`
          <button class="choice" aria-pressed=${sw.role === "companion" && sw.action === a} onClick=${() => put({ role: "companion", action: a })}>${label}</button>`)}</div>
        <div class="section-title">Switch a MIDI parameter</div>
        <div class="choices">${params.map((x) => html`
          <button class="choice" aria-pressed=${sw.role === "param" && sw.param === x.ref} onClick=${() => put({ role: "param", param: x.ref, mode: sw.mode || "toggle" })}>
            ${x.p.name}<span class="s">${x.dev.name}</span></button>`)}</div>
        ${sw.role === "param" ? html`<div class="seg">
          <button aria-pressed=${sw.mode !== "momentary"} onClick=${() => put({ ...sw, mode: "toggle" })}>Press on, press off</button>
          <button aria-pressed=${sw.mode === "momentary"} onClick=${() => put({ ...sw, mode: "momentary" })}>On while held</button></div>` : null}
        ${loops.length ? html`<div class="section-title">Switch a loop</div>
          <div class="choices">${loops.map(([l, name]) => html`
            <button class="choice" aria-pressed=${sw.role === "loop" && sw.loop === l} onClick=${() => put({ role: "loop", loop: l })}>${l} · ${name}</button>`)}</div>` : null}
        <div class="choices"><button class="choice" aria-pressed=${sw.role === "tap"} onClick=${() => put({ role: "tap" })}>Tap tempo</button></div>
      </div>
      <${Done} close=${close} />`;
  },

  loop({ ctx, loop, close }) {
    const { doc, edit } = ctx;
    const cur = loopDevice(doc, loop);
    const assign = (id) => edit((d) => {
      Object.values(d.pedalboard.devices).forEach((dev) => { dev.loops = (dev.loops || []).filter((l) => l !== loop); });
      if (id) d.pedalboard.devices[id].loops.push(loop);
    });
    return html`<${Head} title=${`Loop ${loop}`} close=${close} />
      <div class="body"><div class="choices">
        <button class="choice" aria-pressed=${!cur} onClick=${() => { assign(null); close(); }}>Free</button>
        ${Object.entries(doc.pedalboard.devices).map(([id, dev]) => html`
          <button class="choice" aria-pressed=${cur === dev} onClick=${() => { assign(id); close(); }}>${dev.name}
            <span class="s">${(dev.loops || []).join(" ") || "no loop"}</span></button>`)}
      </div></div>`;
  },

  device({ ctx, id, close }) {
    const { doc, edit, setSheet } = ctx;
    const dev = doc.pedalboard.devices[id];
    if (!dev) return html`<${Head} title="Device" close=${close} />`;
    const set = (fn) => edit((d) => fn(d.pedalboard.devices[id]));
    return html`<${Head} title="Device" close=${close} />
      <div class="body">
        <input class="namefield" value=${dev.name} onInput=${(e) => { const v = e.target.value; set((x) => { x.name = v; }); }} />
        <div class="seg">
          <button aria-pressed=${!dev.midi} onClick=${() => set((x) => { delete x.midi; })}>No MIDI</button>
          <button aria-pressed=${!!dev.midi} onClick=${() => set((x) => { x.midi = x.midi || { channel: 1, program_change: "pc", programs: {}, params: {} }; })}>Receives MIDI</button>
        </div>
        ${dev.midi ? html`
          <div class="section-title">MIDI channel</div>
          <${Stepper} value=${dev.midi.channel} min=${1} max=${16} slider=${false} onChange=${(n) => set((x) => { x.midi.channel = n; })} />
          <div class="section-title">Parameters</div>
          <div class="choices">
            ${Object.entries(dev.midi.params || {}).map(([pid, p]) => html`
              <button class="choice" onClick=${() => setSheet({ kind: "param", id, pid })}>${p.name}<span class="s">CC ${p.cc} ›</span></button>`)}
            <button class="choice" style="color:var(--led)" onClick=${() => {
              const pid = newId(dev.midi.params || {}, "parameter");
              const used = new Set(Object.values(dev.midi.params || {}).map((p) => p.cc));
              let cc = 0; while (used.has(cc)) cc += 1;
              set((x) => { x.midi.params = { ...(x.midi.params || {}), [pid]: { name: "Parameter", cc } }; });
              setSheet({ kind: "param", id, pid });
            }}>+ Parameter</button>
          </div>` : null}
      </div>
      <${Done} close=${close}>
        <button class="ghost danger" onClick=${() => { edit((d) => { delete d.pedalboard.devices[id]; }); close(); }}>Delete device</button>
      </${Done}>`;
  },

  param({ ctx, id, pid, close }) {
    const { doc, edit, setSheet } = ctx;
    const p = ((doc.pedalboard.devices[id] || {}).midi || {}).params?.[pid];
    const back = () => setSheet({ kind: "device", id });
    if (!p) return html`<${Head} title="Parameter" close=${back} />`;
    const set = (fn) => edit((d) => fn(d.pedalboard.devices[id].midi.params[pid]));
    return html`<${Head} title="Parameter" close=${back} extra=${html`<button class="ghost" onClick=${back}>‹ Device</button>`} />
      <div class="body">
        <input class="namefield" value=${p.name} onInput=${(e) => { const v = e.target.value; set((x) => { x.name = v; }); }} />
        <div class="section-title">Control change number</div>
        <${Stepper} value=${p.cc} min=${0} max=${127} onChange=${(n) => set((x) => { x.cc = n; })} />
        <div class="section-title">Values sent</div>
        <div class="row-label"><span>Off</span><span class="s">${p.off ?? 0}</span></div>
        <${Stepper} value=${p.off ?? 0} min=${0} max=${127} slider=${false} onChange=${(n) => set((x) => { x.off = n; })} />
        <div class="row-label"><span>On</span><span class="s">${p.on ?? 127}</span></div>
        <${Stepper} value=${p.on ?? 127} min=${0} max=${127} slider=${false} onChange=${(n) => set((x) => { x.on = n; })} />
      </div>
      <footer>
        <button class="ghost danger" onClick=${() => { edit((d) => { delete d.pedalboard.devices[id].midi.params[pid]; }); back(); }}>Delete parameter</button>
        <button class="done" onClick=${back}>Done</button>
      </footer>`;
  },
};

/** Appui long (450 ms) : `fn` ; le clic qui suit est ignoré (`data-held`). */
function hold(fn) {
  let timer = null;
  const stop = () => { clearTimeout(timer); timer = null; };
  return {
    onPointerDown: (e) => { const el = e.currentTarget; delete el.dataset.held; stop(); timer = setTimeout(() => { el.dataset.held = "1"; fn(); }, 450); },
    onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop,
    onContextMenu: (e) => e.preventDefault(),
  };
}

render(html`<${App} />`, document.getElementById("root"));

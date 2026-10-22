// ES8 Designer au doigt — prototype (Preact + htm, sans compilation). Textes en anglais.
// Structure et choix : docs/designer-touch.md. Trois colonnes comme une appli iPad : rubriques · liste ·
// détail. Les collections sont des listes (Modifier pour réordonner ou supprimer), le détail un formulaire
// en groupes ; seul le pédalier de l'ES-8 est dessiné à sa place. Rubriques dans l'ordre où l'on construit :
// le matériel, les footswitches, les sons, les morceaux, puis les setlists et les favoris (l'accueil de la
// Companion). Ouvre le set joué ; « Save » l'enregistre dans la bibliothèque (rien n'est écrit sur l'ES-8).

import { html, render, useState, useEffect, useRef } from "../shared/vendor/preact-htm.module.js";
import { es8Status } from "../stage-shared/nav.js";

const BOARD = [["MEM_M", "MUTE", "BANK_D", "BANK_U", "NUM7", "NUM8"], ["NUM1", "NUM2", "NUM3", "NUM4", "NUM5", "NUM6"]];
const JACKS = ["CTL_IN_1", "CTL_IN_2", "CTL_IN_3", "CTL_IN_4"];
const SWITCH_NAME = { MEM_M: "MEM/MAN", BANK_D: "BANK ▼", BANK_U: "BANK ▲", CTL_IN_1: "CTL IN 1", CTL_IN_2: "CTL IN 2", CTL_IN_3: "CTL IN 3", CTL_IN_4: "CTL IN 4" };
const COMPANION_ACTIONS = [["next", "Next step"], ["prev", "Previous step"], ["next_song", "Next song"], ["prev_song", "Previous song"], ["song_start", "Song start"]];
const LOOPS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "V"];
const SECTIONS = [
  ["pedalboard", "Pedalboard", "M4 4h6v16H4zM14 4h6v16h-6z"],
  ["switches", "Footswitches", "M3 5h18v14H3zM8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"],
  ["sounds", "Sounds", "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"],
  ["songs", "Songs", "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"],
  ["setlists", "Setlists & favorites", "M4 6h16M4 12h16M4 18h10"],
];
const MIDI_BANKS = 7; // setlists que l'ES-8 suit par PC (pc_map) : une banque MIDI chacune

const clone = (x) => JSON.parse(JSON.stringify(x));
const swName = (key) => SWITCH_NAME[key] || key;
const patchAt = (n) => `${Math.floor(n / 8)}-${(n % 8) + 1}`;
const parseLabel = (t) => { const m = /^\s*(\d{1,2})\s*-\s*([1-8])\s*$/.exec(String(t)); return m ? Number(m[1]) * 8 + Number(m[2]) - 1 : 0; };
const rigStart = (rig) => (typeof rig.start === "string" ? parseLabel(rig.start) : rig.start ?? (rig.bank || 0) * 8);
const patchOf = (rig, i) => patchAt(rigStart(rig) + i);
const newId = (taken, base) => { let id = base, n = 2; while (taken[id]) id = `${base}-${n++}`; return id; };
const slug = (t) => (t || "item").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
const moved = (list, from, to) => { const next = [...list]; const [x] = next.splice(from, 1); next.splice(to, 0, x); return next; };
/** L'indice choisi après un déplacement de `a` vers `b` : la sélection suit son élément. */
const follow = (i, a, b) => (i == null ? i : i === a ? b : a < i && i <= b ? i - 1 : b <= i && i < a ? i + 1 : i);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function allParams(doc) {
  const out = [];
  for (const [did, dev] of Object.entries(doc.pedalboard.devices || {})) {
    for (const [pid, p] of Object.entries((dev.midi && dev.midi.params) || {})) out.push({ ref: `${did}.${pid}`, did, pid, dev, p });
  }
  return out;
}
const loopDevice = (doc, loop) => Object.values(doc.pedalboard.devices || {}).find((d) => (d.loops || []).includes(loop));
const favorites = (doc) => doc.favorites || [];
const isFavorite = (doc, rid, name) => favorites(doc).some((f) => f.rig === rid && f.sound === name);
const setlistIds = (doc) => Object.keys(doc.setlists || {}).sort((a, b) => doc.setlists[a].midi_bank - doc.setlists[b].midi_bank);
const sortedTracks = (doc) => Object.entries(doc.tracks || {}).sort((a, b) => a[1].name.localeCompare(b[1].name));

function switchText(doc, sw) {
  if (!sw || !sw.role) return "";
  if (sw.label) return sw.label;
  if (sw.role === "param") { const p = allParams(doc).find((x) => x.ref === sw.param); return p ? p.p.name : sw.param; }
  if (sw.role === "companion") return (COMPANION_ACTIONS.find(([a]) => a === sw.action) || [0, sw.action])[1];
  if (sw.role === "loop") return sw.loop;
  if (sw.role === "tap") return "Tap";
  return sw.function || sw.role;
}

// ================================================================= briques : groupes, lignes, contrôles

const Group = ({ title, foot, tools, children }) => html`<section class="group">
  ${title || tools ? html`<div class="gh" style="display:flex;align-items:center;gap:8px"><span style="flex:1">${title}</span>${tools}</div>` : null}
  <div class="rows">${children}</div>
  ${foot ? html`<div class="gf">${foot}</div>` : null}</section>`;

const Row = ({ lead, title, sub, value, link, current, onTap, children, cls = "" }) => html`
  <${onTap ? "button" : "div"} class=${`row ${link ? "link" : ""} ${cls}`} aria-current=${current ? "true" : null} onClick=${onTap}>
    ${lead != null ? html`<span class="lead">${lead}</span>` : null}
    <span class="main"><span class="title">${title}</span>${sub ? html`<span class="sub">${sub}</span>` : null}</span>
    ${value != null ? html`<span class="value">${value}</span>` : null}
    ${children}
  </${onTap ? "button" : "div"}>`;

const Switch = ({ on, onChange }) => html`<button class="switch" role="switch" aria-checked=${!!on} onClick=${(e) => { e.stopPropagation(); onChange(!on); }}></button>`;
const Seg = ({ value, options, onChange }) => html`<span class="seg">${options.map(([v, label]) => html`
  <button aria-pressed=${value === v} onClick=${(e) => { e.stopPropagation(); onChange(v); }}>${label}</button>`)}</span>`;
const Stepper = ({ value, min, max, onChange }) => {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)));
  return html`<span class="stepper"><button aria-label="Less" onClick=${() => set(value - 1)}>−</button><span>${value}</span>
    <button aria-label="More" onClick=${() => set(value + 1)}>+</button></span>`;
};
const NameRow = ({ value, onChange, placeholder }) => html`<div class="row">
  <input class="text big" value=${value} placeholder=${placeholder} onInput=${(e) => onChange(e.target.value)} /></div>`;

/**
 * Une liste à la iOS. Hors mode Modifier : toucher une ligne la choisit. En mode Modifier : ⊖ (puis
 * « Delete ») à gauche, poignée ≡ à droite qu'on glisse pour réordonner (doigt ou souris).
 */
function EditableRows({ rows, editing, onMove, onDelete }) {
  const [drag, setDrag] = useState(null); // { from, to, dy }
  const [arm, setArm] = useState(null); // ligne dont on confirme la suppression
  const st = useRef({});
  const box = useRef();
  useEffect(() => { if (!editing) setArm(null); }, [editing]);
  const handle = (i) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      st.current = { i, y0: e.clientY, rects: [...box.current.children].map((c) => c.getBoundingClientRect()) };
      setDrag({ from: i, to: i, dy: 0 });
    },
    onPointerMove: (e) => {
      const s = st.current;
      if (s.i !== i) return;
      const dy = e.clientY - s.y0;
      const mid = s.rects[i].top + s.rects[i].height / 2 + dy;
      let to = s.rects.findIndex((r) => mid < r.bottom);
      if (to < 0) to = s.rects.length - 1;
      setDrag({ from: i, to, dy });
    },
    onPointerUp: () => {
      const d = drag;
      st.current = {};
      setDrag(null);
      if (d && d.to !== d.from) onMove(d.from, d.to);
    },
    onPointerCancel: () => { st.current = {}; setDrag(null); },
  });
  const shift = (i) => {
    if (!drag || i === drag.from) return 0;
    const h = st.current.rects ? st.current.rects[drag.from].height : 0;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return h;
    return 0;
  };
  return html`<div class=${`rows ${drag ? "dragging" : ""}`} ref=${box}>${rows.map((r, i) => {
    const lifted = drag && drag.from === i;
    const style = lifted ? `transform: translateY(${drag.dy}px)` : shift(i) ? `transform: translateY(${shift(i)}px)` : "";
    const Tag = editing || !r.onTap ? "div" : "button";
    return html`<${Tag} key=${r.key} class=${`row ${!editing && r.link ? "link" : ""} ${lifted ? "lifted" : ""}`} style=${style}
        aria-current=${!editing && r.current ? "true" : null} onClick=${editing ? null : r.onTap}>
      ${editing && onDelete ? html`<button class="minus" aria-label="Delete" onClick=${() => setArm(arm === i ? null : i)}>−</button>` : null}
      ${r.lead != null ? html`<span class="lead">${r.lead}</span>` : null}
      <span class="main"><span class="title">${r.title}</span>${r.sub ? html`<span class="sub">${r.sub}</span>` : null}</span>
      ${editing && arm === i ? html`<button class="confirm-del" onClick=${() => { setArm(null); onDelete(i); }}>Delete</button>`
        : editing && onMove ? html`<span class="handle" aria-label="Drag to reorder" ...${handle(i)}>≡</span>`
        : r.value != null ? html`<span class="value">${r.value}</span>` : null}
    </${Tag}>`;
  })}</div>`;
}

// ================================================================= appli

let toastTimer = null;

function App() {
  const [loaded, setLoaded] = useState(null);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [snap, setSnap] = useState(null);
  const [section, setSection] = useState("pedalboard");
  const [saving, setSaving] = useState(false);
  const [sel, setSel] = useState({}); // sélection par rubrique
  const [stack, setStack] = useState([]); // écrans poussés dans la colonne détail (listes à cocher, paramètre…)
  const [editing, setEditing] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [msg, setMsg] = useState("");

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

  const toast = (t) => { setMsg(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => setMsg(""), 2600); };
  const edit = (fn) => setDoc((d) => { const next = clone(d); fn(next); return next; });
  const select = (patch) => { setSel((s) => ({ ...s, [section]: patch })); setStack([]); };
  const goTo = (sec, patch) => { setSection(sec); setSel((s) => ({ ...s, [sec]: patch })); setStack([]); setEditing(false); setSideOpen(false); };
  const push = (frame) => setStack((s) => [...s, frame]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const ctx = { doc, edit, sel: sel[section] || {}, select, goTo, push, pop, editing, setEditing, toast };
  const changed = JSON.stringify(doc) !== JSON.stringify(loaded.doc);
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`../library/projects/${encodeURIComponent(loaded.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);
      setLoaded({ name: loaded.name, doc: clone(doc) });
      toast("Saved. Send to stage to give it to the Companion.");
    } catch (err) { toast(`Not saved: ${err.message}`); }
    setSaving(false);
  };
  const [dot, text] = snap ? es8Status(snap) : ["", "ES-8"];
  const counts = { setlists: Object.keys(doc.setlists || {}).length, songs: Object.keys(doc.tracks).length,
    sounds: Object.values(doc.rigs).reduce((n, r) => n + r.snapshots.length, 0), pedalboard: Object.keys(doc.pedalboard.devices).length };
  const S = SCREENS[section];
  const wide = section === "switches" || section === "pedalboard";
  const top = stack[stack.length - 1];

  return html`
    <div class=${`app ${wide ? "wide" : ""}`}>
      <div class=${`veil ${sideOpen ? "open" : ""}`} onClick=${() => setSideOpen(false)}></div>
      <aside class=${`col side ${sideOpen ? "open" : ""}`}>
        <div class="scroll">
          <div class="setname"><small>Set${snap && snap.playing === loaded.name ? " · on stage" : ""}</small><b>${loaded.name}</b></div>
          ${SECTIONS.map(([id, label, d]) => html`
            <button class="nav" aria-current=${section === id ? "true" : null} onClick=${() => goTo(id, sel[id] || {})}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d=${d} /></svg>
              ${label}${counts[id] != null ? html`<span class="n">${counts[id]}</span>` : null}</button>`)}
        </div>
        <div class="side-foot">
          <span class="status"><span class=${`dot ${dot}`}></span>${text}</span>
          ${changed ? html`<button class="save" disabled=${saving} onClick=${save}>${saving ? "Saving…" : "Save"}</button>` : null}
          <span class="proto">Prototype. Send to stage is in the regular Designer for now.${changed ? html` <button onClick=${() => { setDoc(clone(loaded.doc)); setStack([]); }}>Undo all</button>` : null}
            · <a href="../designer/">Regular Designer</a></span>
        </div>
      </aside>
      <section class="col">
        <div class="bar">
          <button class="tool icon menu-btn" aria-label="Sections" onClick=${() => setSideOpen(true)}>☰</button>
          <h1>${S.title(ctx)}</h1>
          ${S.tools ? S.tools(ctx) : null}
        </div>
        <div class="scroll"><${S.List} ...${ctx} /></div>
      </section>
      <section class="col">
        ${top ? html`
          <div class="bar"><button class="back" onClick=${pop}>‹ ${top.back || "Back"}</button><h1>${top.title}</h1></div>
          <div class="scroll"><${FRAMES[top.kind]} ...${ctx} ...${top} /></div>`
        : html`<${S.Detail} ...${ctx} />`}
      </section>
      ${msg ? html`<div class="toast">${msg}</div>` : null}
    </div>`;
}

/** Colonne détail : barre (titre, outils) et formulaire. */
const Detail = ({ title, tools, children }) => html`
  <div class="bar"><h1>${title}</h1>${tools}</div>
  <div class="scroll">${children}</div>`;
const Empty = ({ text }) => html`<div class="bar"></div><div class="empty">${text}</div>`;
const EditTool = ({ editing, setEditing }) => html`<button class=${`tool ${editing ? "on" : ""}`} onClick=${() => setEditing(!editing)}>${editing ? "Done" : "Edit"}</button>`;

// ================================================================= écrans poussés (colonne détail)

const FRAMES = {
  /** Liste à cocher : un choix parmi plusieurs. */
  pick({ options, current, onPick, pop, foot }) {
    return html`<${Group} foot=${foot}>${options.map((o) => html`
      <${Row} title=${o.label} sub=${o.sub} onTap=${() => { onPick(o.value); pop(); }}>
        <span class="check">${o.value === current ? "✓" : ""}</span></${Row}>`)}</${Group}>`;
  },
  /** Plusieurs choix (boucles d'un appareil). */
  multi({ doc, options, get, toggle }) {
    const cur = get(doc);
    return html`<${Group}>${options.map((o) => html`
      <${Row} title=${o.label} sub=${o.sub} onTap=${() => toggle(o.value)}><span class="check">${cur.includes(o.value) ? "✓" : ""}</span></${Row}>`)}</${Group}>`;
  },
  param({ doc, edit, pop, id, pid }) {
    const p = (((doc.pedalboard.devices[id] || {}).midi || {}).params || {})[pid];
    if (!p) return null;
    const set = (fn) => edit((d) => fn(d.pedalboard.devices[id].midi.params[pid]));
    return html`
      <${Group}><${NameRow} value=${p.name} onChange=${(v) => set((x) => { x.name = v; })} /></${Group}>
      <${Group} title="MIDI" foot="The ES-8 sends Off when the parameter is off, On when it is on.">
        <${Row} title="Control change"><${Stepper} value=${p.cc} min=${0} max=${127} onChange=${(n) => set((x) => { x.cc = n; })} /></${Row}>
        <${Row} title="Off value"><${Stepper} value=${p.off ?? 0} min=${0} max=${127} onChange=${(n) => set((x) => { x.off = n; })} /></${Row}>
        <${Row} title="On value"><${Stepper} value=${p.on ?? 127} min=${0} max=${127} onChange=${(n) => set((x) => { x.on = n; })} /></${Row}>
      </${Group}>
      <${Group}><${Row} cls="danger" title="Delete parameter" onTap=${() => { edit((d) => { delete d.pedalboard.devices[id].midi.params[pid]; }); pop(); }} /></${Group}>`;
  },
};

// ================================================================= rubriques

function songDetail(ctx, id, extra) {
  const { doc, edit, push, goTo } = ctx;
  const tr = doc.tracks[id];
  if (!tr) return html`<${Empty} text="Choose a song." />`;
  const rig = doc.rigs[tr.rig];
  const sounds = rig ? rig.snapshots : [];
  const soundPick = (title, current, onPick) => push({ kind: "pick", title, back: tr.name, current,
    options: sounds.map((s, i) => ({ value: s.name, label: s.name, sub: patchOf(rig, i) })), onPick });
  const inSets = Object.entries(doc.setlists || {}).filter(([, s]) => s.songs.some((x) => x.track === id)).map(([sid, s]) => [sid, s.name]);
  return html`<${SongSteps} ...${ctx} id=${id} tr=${tr} rig=${rig} soundPick=${soundPick} inSets=${inSets} extra=${extra} />`;
}

function SongSteps({ doc, edit, push, goTo, id, tr, rig, soundPick, inSets, extra }) {
  const [editSteps, setEditSteps] = useState(false);
  const patch = (name) => { const i = rig ? rig.snapshots.findIndex((s) => s.name === name) : -1; return i < 0 ? "?" : patchOf(rig, i); };
  return html`<${Detail} title=${tr.name}>
    <${Group}><${NameRow} value=${tr.name} onChange=${(v) => edit((d) => { d.tracks[id].name = v; })} /></${Group}>
    <${Group}>
      <${Row} title="Sounds from" value=${rig ? rig.name : "—"} link onTap=${() => push({ kind: "pick", title: "Sounds from", back: tr.name, current: tr.rig,
        options: Object.entries(doc.rigs).map(([rid, r]) => ({ value: rid, label: r.name, sub: plural(r.snapshots.length, "sound") })),
        onPick: (rid) => edit((d) => { const names = d.rigs[rid].snapshots.map((s) => s.name); d.tracks[id].rig = rid; d.tracks[id].sequence = d.tracks[id].sequence.map((n) => (names.includes(n) ? n : names[0])); }) })} />
    </${Group}>
    <${Group} title="Running order" foot="One line per section, in the order you play them. Touch a line to change its sound."
      tools=${html`<button class="tool" style="color:var(--accent);min-height:36px;text-transform:none;letter-spacing:0;font-size:15px" onClick=${() => setEditSteps(!editSteps)}>${editSteps ? "Done" : "Edit"}</button>`}>
      <${EditableRows} editing=${editSteps}
        rows=${tr.sequence.map((name, i) => ({ key: `${i}-${name}`, lead: i + 1, title: name, value: patch(name), link: true,
          onTap: () => soundPick(`Step ${i + 1}`, name, (v) => edit((d) => { d.tracks[id].sequence[i] = v; })) }))}
        onMove=${(a, b) => edit((d) => { d.tracks[id].sequence = moved(d.tracks[id].sequence, a, b); })}
        onDelete=${tr.sequence.length > 1 ? (i) => edit((d) => { d.tracks[id].sequence.splice(i, 1); }) : null} />
    </${Group}>
    <${Group}><${Row} cls="action" title="+ Add a step" onTap=${() => soundPick("Add a step", null, (v) => edit((d) => { d.tracks[id].sequence.push(v); }))} /></${Group}>
    ${extra}
    <${Group} title="In setlists">${inSets.length ? inSets.map(([sid, n]) => html`<${Row} title=${n} link onTap=${() => goTo("setlists", { setlist: sid })} />`)
      : html`<${Row} title="In no setlist yet" />`}</${Group}>
  </${Detail}>`;
}

const SCREENS = {
  songs: {
    title: () => "Songs",
    tools: (ctx) => html`<button class="tool icon" aria-label="New song" onClick=${() => {
      const rid = Object.keys(ctx.doc.rigs)[0];
      if (!rid) return;
      let id = "";
      ctx.edit((d) => { id = newId(d.tracks, "new-song"); d.tracks[id] = { schema: "es8ctl.track/1", name: "New song", rig: rid, sequence: [d.rigs[rid].snapshots[0].name] }; });
      setTimeout(() => ctx.select({ track: id }), 0);
    }}>+</button>`,
    List({ doc, sel, select }) {
      return html`<${Group}>${sortedTracks(doc).map(([id, t]) => html`
        <${Row} title=${t.name} sub=${`${(doc.rigs[t.rig] || {}).name || "?"} · ${plural(t.sequence.length, "step")}`} link
          current=${sel.track === id} onTap=${() => select({ track: id })} />`)}</${Group}>`;
    },
    Detail(ctx) {
      if (!ctx.sel.track) return html`<${Empty} text="Choose a song." />`;
      return songDetail(ctx, ctx.sel.track, html`<${Group}><${Row} cls="danger" title="Delete song"
        onTap=${() => { ctx.edit((d) => { delete d.tracks[ctx.sel.track]; Object.values(d.setlists).forEach((s) => { s.songs = s.songs.filter((x) => x.track !== ctx.sel.track); }); }); ctx.select({}); }} /></${Group}>`);
    },
  },

  sounds: {
    title: ({ doc, sel }) => (doc.rigs[sel.rig] || Object.values(doc.rigs)[0] || {}).name || "Sounds",
    tools: (ctx) => html`<${EditTool} ...${ctx} />
      <button class="tool icon" aria-label="New sound" onClick=${() => {
        const rid = ctx.sel.rig || Object.keys(ctx.doc.rigs)[0];
        const rig = ctx.doc.rigs[rid];
        ctx.edit((d) => { d.rigs[rid].snapshots.push({ name: `Sound ${rig.snapshots.length + 1}`, loops: [...(rig.chain || [])], params: {} }); });
        ctx.select({ rig: rid, index: rig.snapshots.length });
      }}>+</button>`,
    List({ doc, edit, sel, select, editing }) {
      const ids = Object.keys(doc.rigs);
      const rid = sel.rig && doc.rigs[sel.rig] ? sel.rig : ids[0];
      if (!rid) return html`<p class="lead-text">No rig yet.</p>`;
      const rig = doc.rigs[rid];
      return html`
        ${ids.length > 1 ? html`<${Group} title="Rig">${ids.map((id) => html`<${Row} title=${doc.rigs[id].name} onTap=${() => select({ rig: id })}>
          <span class="check">${id === rid ? "✓" : ""}</span></${Row}>`)}</${Group}>` : null}
        <${Group} foot=${`One ES-8 patch per sound, in a row from ${patchOf(rig, 0)}. Moving a sound changes its patch.`}>
          <${EditableRows} editing=${editing}
            rows=${rig.snapshots.map((sn, i) => {
              const midi = Object.values(sn.params || {}).filter((v) => v && v !== "off").length;
              return { key: `${i}-${sn.name}`, lead: patchOf(rig, i), title: sn.name, link: true, value: isFavorite(doc, rid, sn.name) ? "★" : null,
                sub: [(sn.loops || []).join(" ") || "no loop", midi ? `${midi} MIDI` : ""].filter(Boolean).join(" · "),
                current: sel.index === i && (sel.rig || ids[0]) === rid, onTap: () => select({ rig: rid, index: i }) };
            })}
            onMove=${(a, b) => { edit((d) => { d.rigs[rid].snapshots = moved(d.rigs[rid].snapshots, a, b); }); select({ rig: rid, index: follow(sel.index, a, b) }); }}
            onDelete=${rig.snapshots.length > 1 ? (i) => { edit((d) => { d.rigs[rid].snapshots.splice(i, 1); }); select({ rig: rid }); } : null} />
        </${Group}>`;
    },
    Detail({ doc, edit, sel, goTo }) {
      const rid = sel.rig || Object.keys(doc.rigs)[0];
      const rig = doc.rigs[rid];
      const sn = rig && rig.snapshots[sel.index];
      if (!sn) return html`<${Empty} text="Choose a sound." />`;
      const i = sel.index;
      const set = (fn) => edit((d) => fn(d.rigs[rid].snapshots[i]));
      const params = allParams(doc).filter((x) => (rig.devices || []).includes(x.did));
      const usedIn = Object.entries(doc.tracks).filter(([, t]) => t.rig === rid && t.sequence.includes(sn.name));
      return html`<${Detail} title=${sn.name}>
        <${Group}><${NameRow} value=${sn.name} onChange=${(v) => edit((d) => {
          const old = d.rigs[rid].snapshots[i].name;
          d.rigs[rid].snapshots[i].name = v;
          Object.values(d.tracks).forEach((t) => { if (t.rig === rid) t.sequence = t.sequence.map((n) => (n === old ? v : n)); });
          (d.favorites || []).forEach((f) => { if (f.rig === rid && f.sound === old) f.sound = v; });
        })} />
          <${Row} title="ES-8 patch" value=${patchOf(rig, i)} />
          <${Row} title="★ Favorite" sub="On the Companion's home page, one touch away.">
            <${Switch} on=${isFavorite(doc, rid, sn.name)} onChange=${(v) => edit((d) => {
              const rest = (d.favorites || []).filter((f) => !(f.rig === rid && f.sound === sn.name));
              d.favorites = v ? [...rest, { rig: rid, sound: sn.name }] : rest;
            })} /></${Row}></${Group}>
        <${Group} title="Loops" foot="The loops of this rig's signal chain, in order.">
          ${(rig.chain || []).map((l) => {
            const on = (sn.loops || []).includes(l);
            const dev = loopDevice(doc, l);
            return html`<${Row} lead=${l} title=${dev ? dev.name : "—"}>
              <${Switch} on=${on} onChange=${(v) => set((s) => { s.loops = v ? [...(s.loops || []), l] : (s.loops || []).filter((x) => x !== l); })} /></${Row}>`;
          })}
        </${Group}>
        ${params.length ? html`<${Group} title="MIDI" foot="Off and On send the parameter's own values; Value sends the number you choose.">
          ${params.map((x) => {
            const v = (sn.params || {})[x.ref];
            const mode = typeof v === "number" ? "value" : v === "on" ? "on" : "off";
            const put = (nv) => set((s) => { s.params = { ...(s.params || {}), [x.ref]: nv }; });
            return html`<${Row} title=${x.p.name} sub=${`${x.dev.name} · CC ${x.p.cc}`}>
                <${Seg} value=${mode} options=${[["off", "Off"], ["on", "On"], ["value", "Value"]]}
                  onChange=${(m) => put(m === "value" ? (typeof v === "number" ? v : 64) : m)} /></${Row}>
              ${mode === "value" ? html`<${Row} title=${html`<input class="slider" type="range" min="0" max="127" value=${v} onInput=${(e) => put(Number(e.target.value))} />`}>
                <${Stepper} value=${v} min=${0} max=${127} onChange=${put} /></${Row}>` : null}`;
          })}
        </${Group}>` : null}
        <${Group} title="Used in">${usedIn.length ? usedIn.map(([tid, t]) => html`<${Row} title=${t.name} link onTap=${() => goTo("songs", { track: tid })} />`)
          : html`<${Row} title="No song uses this sound yet" />`}</${Group}>
        <${Group}><${Row} cls="danger" title="Delete sound" onTap=${rig.snapshots.length > 1 ? () => edit((d) => { d.rigs[rid].snapshots.splice(i, 1); }) : null} /></${Group}>
      </${Detail}>`;
    },
  },

  switches: {
    title: ({ doc }) => (Object.values(doc.surfaces)[0] || {}).name || "Footswitches",
    List({ doc, sel, select }) {
      const sf = Object.values(doc.surfaces)[0];
      if (!sf) return html`<p class="lead-text">No surface yet.</p>`;
      const pad = (key) => {
        const sw = (sf.switches || {})[key];
        const t = switchText(doc, sw);
        return html`<button class="pad" aria-current=${sel.key === key ? "true" : null} onClick=${() => select({ key })}>
          <span class="knob"></span><span class="k">${swName(key)}</span>
          <span class=${`t ${!t ? "none" : sw.role === "companion" ? "nav" : ""}`}>${t || "—"}</span></button>`;
      };
      return html`<p class="lead-text">The ES-8 as it sits on the floor. Touch a footswitch to choose what it does.</p>
        <div class="board">${BOARD.flat().map(pad)}</div>
        <div class="jacks">${JACKS.map(pad)}</div>`;
    },
    Detail({ doc, edit, sel }) {
      const sid = Object.keys(doc.surfaces)[0];
      if (!sel.key || !sid) return html`<${Empty} text="Touch a footswitch." />`;
      const key = sel.key;
      const sw = (doc.surfaces[sid].switches || {})[key] || {};
      const put = (next) => edit((d) => {
        const sws = d.surfaces[sid].switches = d.surfaces[sid].switches || {};
        if (next) sws[key] = next; else delete sws[key];
      });
      const check = (on) => html`<span class="check">${on ? "✓" : ""}</span>`;
      const loops = Object.values(doc.pedalboard.devices || {}).flatMap((d) => (d.loops || []).map((l) => [l, d.name]));
      return html`<${Detail} title=${swName(key)}>
        <${Group}><${Row} title="Nothing" onTap=${() => put(null)}>${check(!sw.role)}</${Row}></${Group}>
        <${Group} title="Move through the set">${COMPANION_ACTIONS.map(([a, label]) => html`
          <${Row} title=${label} onTap=${() => put({ role: "companion", action: a })}>${check(sw.role === "companion" && sw.action === a)}</${Row}>`)}</${Group}>
        <${Group} title="Switch a MIDI parameter">${allParams(doc).map((x) => html`
          <${Row} title=${x.p.name} sub=${x.dev.name} onTap=${() => put({ role: "param", param: x.ref, mode: sw.mode || "toggle" })}>${check(sw.role === "param" && sw.param === x.ref)}</${Row}>`)}</${Group}>
        ${sw.role === "param" ? html`<${Group} title="Behaviour"><${Row} title="Footswitch">
          <${Seg} value=${sw.mode === "momentary" ? "momentary" : "toggle"} options=${[["toggle", "Press on / off"], ["momentary", "While held"]]}
            onChange=${(m) => put({ ...sw, mode: m })} /></${Row}></${Group}>` : null}
        ${loops.length ? html`<${Group} title="Switch a loop">${loops.map(([l, name]) => html`
          <${Row} lead=${l} title=${name} onTap=${() => put({ role: "loop", loop: l })}>${check(sw.role === "loop" && sw.loop === l)}</${Row}>`)}</${Group}>` : null}
        <${Group}><${Row} title="Tap tempo" onTap=${() => put({ role: "tap" })}>${check(sw.role === "tap")}</${Row}></${Group}>
      </${Detail}>`;
    },
  },

  pedalboard: {
    title: () => "Pedalboard",
    List({ doc, edit, sel, select }) {
      const devices = Object.entries(doc.pedalboard.devices || {});
      return html`
        <p class="lead-text">The ES-8's loops, then the devices plugged in or driven by MIDI.</p>
        <div class="loops">${LOOPS.map((l) => {
          const dev = loopDevice(doc, l);
          return html`<button class=${`loop ${dev ? "" : "free"}`} aria-current=${sel.loop === l ? "true" : null} onClick=${() => select({ loop: l })}>
            <span class="k">${l}</span><span class="t">${dev ? dev.name : "free"}</span></button>`;
        })}</div>
        <${Group} title="Devices">
          ${devices.map(([id, dev]) => html`<${Row} title=${dev.name} link current=${sel.device === id} onTap=${() => select({ device: id })}
            sub=${[(dev.loops || []).join(" ") || "no loop", dev.midi ? `MIDI ch ${dev.midi.channel} · ${plural(Object.keys(dev.midi.params || {}).length, "parameter")}` : "no MIDI"].join(" · ")} />`)}
          <${Row} cls="action" title="+ Add a device" onTap=${() => {
            let id = "";
            edit((d) => { id = newId(d.pedalboard.devices, "device"); d.pedalboard.devices[id] = { name: "New device", loops: [] }; });
            setTimeout(() => select({ device: id }), 0);
          }} />
        </${Group}>`;
    },
    Detail({ doc, edit, sel, select, push }) {
      if (sel.loop) {
        const cur = loopDevice(doc, sel.loop);
        const assign = (id) => edit((d) => {
          Object.values(d.pedalboard.devices).forEach((dev) => { dev.loops = (dev.loops || []).filter((l) => l !== sel.loop); });
          if (id) d.pedalboard.devices[id].loops.push(sel.loop);
        });
        return html`<${Detail} title=${`Loop ${sel.loop}`}>
          <${Group} title="Plugged in" foot="A device can sit in one loop or more.">
            <${Row} title="Nothing (free)" onTap=${() => assign(null)}><span class="check">${cur ? "" : "✓"}</span></${Row}>
            ${Object.entries(doc.pedalboard.devices).map(([id, dev]) => html`
              <${Row} title=${dev.name} onTap=${() => assign(id)}><span class="check">${cur === dev ? "✓" : ""}</span></${Row}>`)}
          </${Group}></${Detail}>`;
      }
      const id = sel.device;
      const dev = id && doc.pedalboard.devices[id];
      if (!dev) return html`<${Empty} text="Touch a loop or a device." />`;
      const set = (fn) => edit((d) => fn(d.pedalboard.devices[id]));
      const params = Object.entries((dev.midi && dev.midi.params) || {});
      return html`<${Detail} title=${dev.name}>
        <${Group}><${NameRow} value=${dev.name} onChange=${(v) => set((x) => { x.name = v; })} />
          <${Row} title="Loops" value=${(dev.loops || []).join(" ") || "none"} link onTap=${() => push({ kind: "multi", title: "Loops", back: dev.name,
            options: LOOPS.map((l) => { const o = loopDevice(doc, l); return { value: l, label: l, sub: o && o !== dev ? `now ${o.name}` : "" }; }),
            get: (d) => (d.pedalboard.devices[id] || {}).loops || [],
            toggle: (l) => edit((d) => {
              const x = d.pedalboard.devices[id];
              const has = (x.loops || []).includes(l);
              Object.values(d.pedalboard.devices).forEach((o) => { o.loops = (o.loops || []).filter((y) => y !== l); });
              x.loops = has ? (x.loops || []).filter((y) => y !== l) : [...(x.loops || []), l];
            }) })} /></${Group}>
        <${Group} title="MIDI">
          <${Row} title="Receives MIDI from the ES-8"><${Switch} on=${!!dev.midi} onChange=${(v) => set((x) => { if (v) x.midi = x.midi || { channel: 1, program_change: "pc", programs: {}, params: {} }; else delete x.midi; })} /></${Row}>
          ${dev.midi ? html`<${Row} title="Channel"><${Stepper} value=${dev.midi.channel} min=${1} max=${16} onChange=${(n) => set((x) => { x.midi.channel = n; })} /></${Row}>` : null}
        </${Group}>
        ${dev.midi ? html`<${Group} title="Parameters">
          ${params.map(([pid, p]) => html`<${Row} title=${p.name} value=${`CC ${p.cc}`} link onTap=${() => push({ kind: "param", title: p.name, back: dev.name, id, pid })} />`)}
          <${Row} cls="action" title="+ Add a parameter" onTap=${() => {
            const pid = newId(dev.midi.params || {}, "parameter");
            const used = new Set(params.map(([, p]) => p.cc));
            let cc = 0; while (used.has(cc)) cc += 1;
            set((x) => { x.midi.params = { ...(x.midi.params || {}), [pid]: { name: "Parameter", cc } }; });
            push({ kind: "param", title: "Parameter", back: dev.name, id, pid });
          }} />
        </${Group}>` : null}
        <${Group}><${Row} cls="danger" title="Delete device" onTap=${() => { edit((d) => { delete d.pedalboard.devices[id]; }); select({}); }} /></${Group}>
      </${Detail}>`;
    },
  },
};

// ================================================================= setlists et favoris

/** Tous les sons du set, groupés par rig : pour choisir un favori. */
const soundOptions = (doc) => Object.entries(doc.rigs).flatMap(([rid, rig]) => rig.snapshots.map((sn, i) => ({
  value: `${rid}\u0000${sn.name}`, label: sn.name, sub: `${rig.name} · ${patchOf(rig, i)}`, rid, name: sn.name })));

const SETLISTS = {
  title: () => "Setlists & favorites",
  tools: (ctx) => html`<${EditTool} ...${ctx} />
    <button class="tool icon" aria-label="New setlist" onClick=${() => {
      const used = new Set(Object.values(ctx.doc.setlists || {}).map((s) => s.midi_bank));
      let bank = 0; while (used.has(bank)) bank += 1;
      if (bank >= MIDI_BANKS) { ctx.toast(`The ES-8 follows ${MIDI_BANKS} setlists at most for now.`); return; }
      let id = "";
      ctx.edit((d) => { d.setlists = d.setlists || {}; id = newId(d.setlists, "setlist"); d.setlists[id] = { schema: "es8ctl.setlist/1", name: "New setlist", midi_bank: bank, songs: [] }; });
      setTimeout(() => ctx.select({ setlist: id }), 0);
    }}>+</button>`,
  List({ doc, edit, sel, select, editing }) {
    const ids = setlistIds(doc);
    return html`
      <${Group} title="Companion home page">
        <${Row} title="★ Favorites" sub="Sounds one touch away, outside any setlist" value=${favorites(doc).length} link
          current=${!!sel.favorites} onTap=${() => select({ favorites: true })} />
      </${Group}>
      <${Group} title="Setlists" foot=${ids.length ? "Touch a setlist to see its songs." : "No setlist yet: + creates one."}>
        <${EditableRows} editing=${editing}
          rows=${ids.map((sid) => {
            const sl = doc.setlists[sid];
            const steps = sl.songs.reduce((n, x) => n + ((doc.tracks[x.track] || { sequence: [] }).sequence.length), 0);
            return { key: sid, title: sl.name, sub: `${plural(sl.songs.length, "song")} · ${plural(steps, "step")}`, link: true,
              current: sel.setlist === sid, onTap: () => select({ setlist: sid }) };
          })}
          onDelete=${(i) => { edit((d) => { delete d.setlists[ids[i]]; }); select({}); }} />
      </${Group}>`;
  },
  Detail(ctx) {
    if (ctx.sel.favorites) return html`<${FavoritesDetail} ...${ctx} />`;
    const sl = ctx.sel.setlist && (ctx.doc.setlists || {})[ctx.sel.setlist];
    if (!sl) return html`<${Empty} text="Choose a setlist, or the favorites." />`;
    return html`<${SetlistDetail} ...${ctx} sid=${ctx.sel.setlist} sl=${sl} />`;
  },
};

function SetlistDetail({ doc, edit, push, goTo, select, sid, sl }) {
  const [editSongs, setEditSongs] = useState(false);
  let pc = 0;
  const rows = sl.songs.map((song, i) => {
    const tr = doc.tracks[song.track];
    const n = tr ? tr.sequence.length : 0;
    const at = pc;
    pc += n;
    return { key: `${i}-${song.track}`, lead: i + 1, title: tr ? tr.name : song.track, sub: tr ? tr.sequence.join(" → ") : "missing song",
      value: n > 1 ? `PC ${at}–${at + n - 1}` : `PC ${at}`, link: true, onTap: () => goTo("songs", { track: song.track }) };
  });
  return html`<${Detail} title=${sl.name}>
    <${Group}><${NameRow} value=${sl.name} onChange=${(v) => edit((d) => { d.setlists[sid].name = v; })} /></${Group}>
    <${Group} title="Songs, in the order of the gig" foot=${`${plural(rows.length, "song")} · ${plural(pc, "step")}. A song can come back later in the set.`}
      tools=${html`<button class="tool" style="color:var(--accent);min-height:36px;text-transform:none;letter-spacing:0;font-size:15px" onClick=${() => setEditSongs(!editSongs)}>${editSongs ? "Done" : "Edit"}</button>`}>
      <${EditableRows} rows=${rows} editing=${editSongs}
        onMove=${(a, b) => edit((d) => { d.setlists[sid].songs = moved(d.setlists[sid].songs, a, b); })}
        onDelete=${(i) => edit((d) => { d.setlists[sid].songs.splice(i, 1); })} />
    </${Group}>
    <${Group}><${Row} cls="action" title="+ Add a song" onTap=${() => push({ kind: "pick", title: "Add a song", back: sl.name, current: null,
      options: sortedTracks(doc).map(([id, t]) => ({ value: id, label: t.name, sub: plural(t.sequence.length, "step") })),
      onPick: (id) => edit((d) => { d.setlists[sid].songs.push({ track: id }); }) })} /></${Group}>
    <${Group}><${Row} cls="danger" title="Delete setlist" onTap=${() => { edit((d) => { delete d.setlists[sid]; }); select({}); }} /></${Group}>
  </${Detail}>`;
}

function FavoritesDetail({ doc, edit, push, goTo }) {
  const [editFavs, setEditFavs] = useState(false);
  const favs = favorites(doc);
  const where = (f) => { const rig = doc.rigs[f.rig]; const i = rig ? rig.snapshots.findIndex((s) => s.name === f.sound) : -1; return [rig, i]; };
  return html`<${Detail} title="★ Favorites">
    <${Group} title="In the order of the home page" foot="Touching a favorite on the Companion recalls its patch at once; the setlist keeps its place."
      tools=${html`<button class="tool" style="color:var(--accent);min-height:36px;text-transform:none;letter-spacing:0;font-size:15px" onClick=${() => setEditFavs(!editFavs)}>${editFavs ? "Done" : "Edit"}</button>`}>
      ${favs.length ? html`<${EditableRows} editing=${editFavs}
        rows=${favs.map((f, i) => { const [rig, k] = where(f); return { key: `${f.rig}-${f.sound}`, lead: i + 1, title: f.sound,
          sub: rig ? rig.name : "missing rig", value: rig && k >= 0 ? patchOf(rig, k) : "?", link: true,
          onTap: () => goTo("sounds", { rig: f.rig, index: k }) }; })}
        onMove=${(a, b) => edit((d) => { d.favorites = moved(d.favorites, a, b); })}
        onDelete=${(i) => edit((d) => { d.favorites.splice(i, 1); })} />` : html`<${Row} title="No favorite yet" />`}
    </${Group}>
    <${Group}><${Row} cls="action" title="+ Add a favorite" onTap=${() => push({ kind: "pick", title: "Add a favorite", back: "Favorites", current: null,
      options: soundOptions(doc).filter((o) => !isFavorite(doc, o.rid, o.name)),
      onPick: (v) => { const [rid, name] = v.split("\u0000"); edit((d) => { d.favorites = [...(d.favorites || []), { rig: rid, sound: name }]; }); } })} /></${Group}>
  </${Detail}>`;
}

SCREENS.setlists = SETLISTS;

render(html`<${App} />`, document.getElementById("root"));

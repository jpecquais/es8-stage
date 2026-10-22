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
  ["settings", "Settings", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"],
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

/**
 * Un set d'une forme plus ancienne, mis à la forme que cette appli édite (comme le Designer de bureau) :
 * les morceaux écrits dans une setlist deviennent des morceaux (tracks), les rigs v1 (une banque) passent en v2.
 */
function normalize(d) {
  d.tracks = d.tracks || {};
  d.setlists = d.setlists || {};
  d.surfaces = d.surfaces || {};
  d.rigs = d.rigs || {};
  d.pedalboard.devices = d.pedalboard.devices || {};
  Object.values(d.rigs).forEach((r) => {
    if (r.schema !== "es8ctl.rig/1") return;
    r.schema = "es8ctl.rig/2";
    r.start = `${r.bank}-1`;
    delete r.bank;
  });
  Object.values(d.setlists).forEach((sl) => {
    sl.songs = (sl.songs || []).map((song) => {
      if (song.track) return song;
      const name = song.name || (d.rigs[song.rig] || {}).name || "Song";
      const same = Object.entries(d.tracks).find(([, t]) => t.name === name && t.rig === song.rig && JSON.stringify(t.sequence) === JSON.stringify(song.sequence));
      if (same) return { track: same[0] };
      const id = newId(d.tracks, slug(name));
      d.tracks[id] = { schema: "es8ctl.track/1", name, rig: song.rig, sequence: [...song.sequence] };
      return { track: id };
    });
  });
  return d;
}

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

/** Ce qu'enregistrer le set joué a fait sur la scène (réponse du PUT : {stage}), dit à l'utilisateur. */
const SAVED = {
  playing: "Saved. The stage plays it now.",
  unchanged: "Saved.",
  send: "Saved. The ES-8 must be updated before the stage plays it: Send to the ES-8.",
  invalid: "Saved, but something is wrong: the stage keeps the previous version.",
};
const PHASES = { start: "Starting", read: "Reading the ES-8", refresh: "Reading the ES-8", send: "Writing", resend: "Writing again" };

/** Le son que l'ES-8 joue en ce moment ({rid, name}), d'après la scène : le favori, ou le pas de la setlist. */
function playingSound(snap, doc) {
  const show = snap && snap.show;
  if (!show || !snap.pos || !doc) return null;
  if (snap.favorite != null) {
    const f = (show.favorites || [])[snap.favorite];
    const rid = f && Object.keys(doc.rigs).find((id) => doc.rigs[id].name === f.rig);
    return rid ? { rid, name: f.name } : null;
  }
  const sl = show.setlists[snap.pos.setlist];
  const st = sl && sl.steps[snap.pos.step];
  return st ? { rid: sl.songs[st.song].rig, name: st.snapshot } : null;
}

/**
 * Ce qui diffère entre le set et l'ES-8, d'après la dernière lecture de l'ES-8 par l'hôte (rig_preview du
 * moteur, sur le Pi ; rien n'est lu sur l'ES-8). null : pas d'hôte ; {unknown} : pas encore lu ;
 * {problems} : le set a une erreur ; sinon {patches: Set de « 3-1 », system: [champs], count}.
 */
function useDiff(doc, snap) {
  const [diff, setDiff] = useState(null);
  const host = !!snap;
  const busy = !!(snap && snap.job && !snap.job.done);
  useEffect(() => {
    if (!host || !doc || busy) return undefined;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("../stage/engine", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fn: "rig_preview", args: [JSON.stringify(doc)] }) });
        if (!res.ok) { setDiff(null); return; }
        const pv = JSON.parse((await res.json()).result);
        if (pv.error) setDiff({ problems: pv.problems || [pv.error] });
        else if (pv.missing) setDiff({ unknown: true });
        else setDiff({ patches: new Set(Object.keys(pv.patches)), system: pv.system, count: Object.keys(pv.patches).length + (pv.system.length ? 1 : 0) });
      } catch { setDiff(null); }
    }, 700);
    return () => clearTimeout(t);
  }, [doc, host, busy]);
  return diff;
}

/**
 * `shell` : posé par l'appli unifiée (web/app/) ; « Done » enregistre et rend la main au jeu. `target`,
 * à chaque ✎ (`nonce` change), ouvre ce qui est joué : {section, rig | rigName, sound} ou {section}.
 */
export function App({ shell, target, nonce } = {}) {
  const [loaded, setLoaded] = useState(null); // {name, doc, etag} : le set tel qu'enregistré
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
  const diff = useDiff(doc, snap);

  const cur = useRef({});
  cur.current = { doc, loaded };
  // Annuler pas à pas : les versions précédentes du set ; des changements à moins d'une seconde font un pas.
  const undo = useRef({ past: [], future: [], at: 0 });
  const open = async () => {
    try {
      const listing = await (await fetch("../library/", { cache: "no-store" })).json();
      const name = listing.playing || (listing.projects[0] || {}).name;
      if (!name) throw new Error("Nothing saved on the stage host yet.");
      const res = await fetch(`../library/projects/${encodeURIComponent(name)}`, { cache: "no-store" });
      const d = normalize(await res.json());
      setLoaded({ name, doc: d, etag: (res.headers.get("ETag") || "").replace(/"/g, "") || null });
      setDoc(clone(d));
      undo.current = { past: [], future: [], at: 0 };
      setError("");
    } catch (err) { setError(err.message || String(err)); }
  };

  useEffect(() => {
    open();
    let events = null;
    fetch("../stage/state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (!s) return;
      setSnap(s);
      events = new EventSource("../stage/events");
      events.onmessage = (e) => { try { setSnap(JSON.parse(e.data)); } catch { /* le suivant */ } };
    }).catch(() => {});
    return () => events && events.close();
  }, []);

  // ✎ dans le jeu : relit le set s'il n'y a rien en cours ici (il a pu changer ailleurs), puis ouvre ce qui est joué.
  useEffect(() => {
    if (!nonce) return;
    const { doc: d, loaded: l } = cur.current;
    if (l && JSON.stringify(d) === JSON.stringify(l.doc)) open();
    setEditing(false);
    setStack([]);
  }, [nonce]);
  useEffect(() => {
    if (!nonce || !doc || !target) return;
    let patch = {};
    if (target.section === "sounds") {
      const rid = doc.rigs[target.rig] ? target.rig : Object.keys(doc.rigs).find((id) => doc.rigs[id].name === target.rigName);
      const index = rid ? doc.rigs[rid].snapshots.findIndex((x) => x.name === target.sound) : -1;
      if (rid) patch = index >= 0 ? { rig: rid, index } : { rig: rid };
    }
    setSection(target.section);
    setSel((x) => ({ ...x, [target.section]: patch }));
    setSideOpen(false);
  }, [nonce, loaded && loaded.name]);

  // ⌘Z / ⇧⌘Z (Ctrl ailleurs) hors champ texte (le champ annule sa frappe lui-même) ; pas pendant le jeu.
  const keys = useRef({});
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
      if (shell && shell.playing()) return;
      const t = e.composedPath ? e.composedPath()[0] : e.target;
      if (t.closest && t.closest("input, textarea")) return;
      e.preventDefault();
      if (e.shiftKey) keys.current.stepForward && keys.current.stepForward();
      else keys.current.stepBack && keys.current.stepBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fin d'un envoi à l'ES-8 lancé d'ici : le dire.
  const job = snap && snap.job;
  const mine = useRef(false);
  const jobBusy = !!(job && !job.done);
  useEffect(() => {
    if (!job || jobBusy || !mine.current || !["send", "try", "compare"].includes(job.kind)) return;
    mine.current = false;
    if (job.error) toast(`${job.kind === "compare" ? "Not compared" : "Not written"}: ${job.error}`, 8000);
    else if (job.kind === "compare") toast("Compared with the ES-8.");
    else if (!job.result || !job.result.written) toast(job.kind === "try" ? "The ES-8 already has this sound." : "The ES-8 already matched: nothing to write.");
    else toast(job.kind === "try" ? "Written: the ES-8 plays this sound now." : "Written and checked. The stage plays it now.", 4000);
  }, [jobBusy]);

  if (error) return html`<div class="loading">${error}</div>`;
  if (!doc) return html`<div class="loading">Loading…</div>`;

  const toast = (t, ms = 2600) => { setMsg(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => setMsg(""), ms); };
  const remember = (d, merge) => {
    const u = undo.current;
    const now = Date.now();
    if (!(merge && now - u.at < 1000 && u.past.length)) u.past = [...u.past.slice(-199), d];
    u.future = [];
    u.at = merge ? now : 0;
  };
  const edit = (fn) => setDoc((d) => { const next = clone(d); fn(next); remember(d, true); return next; });
  /** Remplace tout le set (Undo all, une version restaurée) : un pas qu'on peut annuler. */
  const replaceDoc = (next) => { remember(doc, false); setDoc(next); };
  const stepBack = () => { const u = undo.current; if (!u.past.length) return; u.future = [...u.future, doc]; u.at = 0; setDoc(u.past[u.past.length - 1]); u.past = u.past.slice(0, -1); };
  const stepForward = () => { const u = undo.current; if (!u.future.length) return; u.past = [...u.past, doc]; u.at = 0; setDoc(u.future[u.future.length - 1]); u.future = u.future.slice(0, -1); };
  keys.current = { stepBack, stepForward };
  const UndoRedo = () => html`<span class="undoredo">
    <button aria-label="Undo" title="Undo (⌘Z)" disabled=${!undo.current.past.length} onClick=${stepBack}>↶</button>
    <button aria-label="Redo" title="Redo (⇧⌘Z)" disabled=${!undo.current.future.length} onClick=${stepForward}>↷</button></span>`;
  const select = (patch) => { setSel((s) => ({ ...s, [section]: patch })); setStack([]); };
  const goTo = (sec, patch) => { setSection(sec); setSel((s) => ({ ...s, [sec]: patch })); setStack([]); setEditing(false); setSideOpen(false); };
  const push = (frame) => setStack((s) => [...s, frame]);
  const pop = () => setStack((s) => s.slice(0, -1));
  const changed = JSON.stringify(doc) !== JSON.stringify(loaded.doc);
  const connected = !!(snap && snap.midi && snap.midi.connected);

  /** Enregistre le set ; rend le message à montrer, ou null si rien n'a été enregistré. */
  const save = async (force = false) => {
    setSaving(true);
    try {
      const headers = { "Content-Type": "application/json" };
      if (loaded.etag && !force) headers["If-Match"] = `"${loaded.etag}"`;
      const res = await fetch(`../library/projects/${encodeURIComponent(loaded.name)}`, { method: "PUT", headers, body: JSON.stringify(doc) });
      if (res.status === 412) { // un autre écran l'a changé depuis qu'on l'a ouvert
        setSaving(false);
        if (confirm("Another screen saved changes since you opened Edit.\n\nOK: replace it with your version.\nCancel: keep the other version (choose next).")) return save(true);
        if (confirm("Load the other version? Your changes here are lost.")) { await open(); setStack([]); }
        return null;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);
      const out = await res.json().catch(() => ({})); // set joué : ce qu'en fait la scène
      setLoaded({ name: loaded.name, doc: clone(doc), etag: out.etag || null });
      return SAVED[out.stage] || "Saved.";
    } catch (err) { toast(`Not saved: ${err.message}`); return null; } finally { setSaving(false); }
  };
  const saveHere = async () => { const t = await save(); if (t) toast(t, t.length > 40 ? 6000 : 2600); };
  const done = async () => {
    if (!changed) { shell.done(); return; }
    const t = await save();
    if (t) shell.done(t);
  };
  /** « Send to the ES-8 » (tout) ou un seul patch (`only`, « 3-1 ») : enregistre d'abord, puis l'hôte écrit. */
  const send = async (only, compare = false) => {
    if (!only && !compare && !confirm(`Write ${diff && diff.count ? plural(diff.count, "change") : "everything"} to the ES-8?\n\nThe footswitches pause while it writes (from a few seconds to a minute), then the stage plays the new version where it was.`)) return;
    if (changed && !(await save())) return;
    const res = await fetch("../stage/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: loaded.name, only: only || null, compare }) });
    if (res.ok) mine.current = true;
    else toast(`Not sent: ${(await res.json().catch(() => ({}))).error || `error ${res.status}`}`, 6000);
  };
  /** Entendre un réglage MIDI : l'hôte envoie le CC tout de suite, si ce son est celui qui joue. */
  const hear = (channel, cc, value) => fetch("../stage/act", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "cc", channel, cc, value }) }).catch(() => {});
  const playing = playingSound(snap, doc);
  const ctx = { doc, edit, sel: sel[section] || {}, select, goTo, push, pop, editing, setEditing, toast, diff, playing, hear, send,
    connected, jobBusy, setName: loaded.name, setDoc: replaceDoc, setStack };

  const [dot, text] = snap ? es8Status(snap) : ["", "ES-8"];
  const counts = { setlists: Object.keys(doc.setlists || {}).length, songs: Object.keys(doc.tracks).length,
    sounds: Object.values(doc.rigs).reduce((n, r) => n + r.snapshots.length, 0), pedalboard: Object.keys(doc.pedalboard.devices).length };
  const marks = { sounds: diffSounds(doc, diff), setlists: diffSetlists(doc, diff) };
  const S = SCREENS[section];
  const wide = section === "switches" || section === "pedalboard";
  const top = stack[stack.length - 1];

  return html`
    <div class=${`app ${wide ? "wide" : ""}`}>
      <div class=${`veil ${sideOpen ? "open" : ""}`} onClick=${() => setSideOpen(false)}></div>
      <aside class=${`col side ${sideOpen ? "open" : ""}`}>
        <div class="scroll">
          ${SECTIONS.map(([id, label, d]) => html`
            <button class="nav" aria-current=${section === id ? "true" : null} onClick=${() => goTo(id, sel[id] || {})}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d=${d} /></svg>
              ${label}${marks[id] ? html`<span class="pend" title="Differs from the ES-8"></span>` : null}${counts[id] != null ? html`<span class="n">${counts[id]}</span>` : null}</button>`)}
        </div>
        <div class="side-foot">
          <span class="status"><span class=${`dot ${dot}`}></span>${text}</span>
          ${snap ? html`<${SendBox} diff=${diff} job=${job} connected=${connected} changed=${changed} send=${send} />` : null}
          ${changed || undo.current.past.length || undo.current.future.length ? html`<div class="save-row">
            ${changed ? html`<button class="save" disabled=${saving} onClick=${saveHere}>${saving ? "Saving…" : "Save"}</button>` : html`<span></span>`}
            <${UndoRedo} /></div>` : null}
          ${changed ? html`<button class="undo" onClick=${() => { replaceDoc(clone(loaded.doc)); setStack([]); }}>Undo all changes since saved</button>` : null}
        </div>
      </aside>
      <section class="col list">
        <div class="bar">
          ${shell ? html`<button class="tool done" disabled=${saving} onClick=${done} title=${changed ? "Save and go back to playing" : "Go back to playing"}>${saving ? "Saving…" : "Done"}</button>` : null}
          <button class="tool icon menu-btn" aria-label="Sections" onClick=${() => setSideOpen(true)}>☰${marks.sounds || marks.setlists ? html`<span class="badge"></span>` : null}</button>
          <h1>${S.title(ctx)}</h1>
          ${S.tools ? S.tools(ctx) : null}
        </div>
        <div class="scroll"><${S.List} ...${ctx} /></div>
        <div class="toolbar">
          ${snap ? html`<${SendBox} diff=${diff} job=${job} connected=${connected} changed=${changed} send=${send} />` : null}
          ${undo.current.past.length || undo.current.future.length ? html`<${UndoRedo} />` : null}
          ${changed ? html`<button class="save" disabled=${saving} onClick=${saveHere}>${saving ? "Saving…" : "Save"}</button>` : null}
        </div>
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

/** Les rigs dont un son diffère de l'ES-8 ; les setlists dont la table des PC diffère. */
function diffSounds(doc, diff) {
  if (!diff || !diff.patches || !diff.patches.size) return 0;
  return Object.values(doc.rigs).reduce((n, rig) => n + rig.snapshots.filter((_, i) => diff.patches.has(patchOf(rig, i))).length, 0);
}
function diffSetlists(doc, diff) {
  if (!diff || !diff.system) return 0;
  return Object.values(doc.setlists || {}).filter((s) => setlistDiffers(s, diff)).length;
}
const setlistDiffers = (sl, diff) => !!(diff && diff.system && diff.system.some((f) => f.startsWith(`pc_map_bank${sl.midi_bank}`)));
const soundDiffers = (rig, i, diff) => !!(diff && diff.patches && diff.patches.has(patchOf(rig, i)));

/** L'état de l'ES-8 face au set, et le bouton pour l'y écrire. */
function SendBox({ diff, job, connected, changed, send }) {
  if (job && !job.done && ["send", "try", "compare", "restore", "backup"].includes(job.kind)) {
    const pct = job.total ? Math.round((100 * job.n) / job.total) : 0;
    return html`<div class="sendbox busy"><span>${job.kind === "backup" ? "Backing up the ES-8" : job.kind === "restore" ? "Restoring the ES-8" : PHASES[job.phase] || job.phase}…</span>
      <span class="meter"><span style=${`width:${pct}%`}></span></span></div>`;
  }
  if (diff && diff.problems) return html`<div class="sendbox warn">Can't send: ${diff.problems[0]}</div>`;
  const pending = diff && diff.count;
  const label = pending ? `Send to the ES-8 · ${pending}` : "Send to the ES-8";
  const note = !connected ? "The ES-8 is not connected."
    : diff && diff.unknown ? "Not compared yet: comparing only reads the ES-8."
      : diff && !pending ? "The ES-8 matches." : "";
  return html`<div class="sendbox">
    ${connected && diff && diff.unknown ? html`<button class="compare" onClick=${() => send(null, true)}>Compare with the ES-8</button>` : null}
    ${connected && (pending || (diff && diff.unknown) || !diff) ? html`<button class="send" onClick=${() => send()}>${label}</button>` : null}
    ${note ? html`<span class=${`note ${diff && !pending && connected ? "ok" : ""}`}>${note}</span>` : null}</div>`;
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
  /** Choisir un programme d'appareil : `unset` (défaut du rig, ou aucun), aucun (null), un nom, ou un numéro. */
  progpick({ doc, edit, id, get, put, unset, allowNull }) {
    const dev = doc.pedalboard.devices[id];
    if (!dev) return null;
    const v = get(doc);
    const progs = Object.entries(((dev.midi || {}).programs) || {});
    const num = typeof v === "number" || (v && typeof v === "object");
    const check = (on) => html`<span class="check">${on ? "✓" : ""}</span>`;
    return html`<${Group} foot=${progs.length ? "" : "Name programs in Pedalboard, on the device, to choose them by name."}>
      ${unset ? html`<${Row} title=${unset} onTap=${() => edit((d) => put(d, undefined))}>${check(v === undefined)}</${Row}>` : null}
      ${allowNull ? html`<${Row} title="No program change" onTap=${() => edit((d) => put(d, null))}>${check(v === null)}</${Row}>` : null}
      ${progs.map(([pid, p]) => html`<${Row} title=${p.name || pid} sub=${`PC ${p.pc}`} onTap=${() => edit((d) => put(d, pid))}>${check(v === pid)}</${Row}>`)}
      <${Row} title="Program number" onTap=${() => { if (!num) edit((d) => put(d, 0)); }}>${check(num)}</${Row}>
      ${num ? html`<${Row} title="PC"><${Stepper} value=${typeof v === "number" ? v : v.pc} min=${0} max=${127} onChange=${(n) => edit((d) => put(d, n))} /></${Row}>` : null}
    </${Group}>`;
  },
  /** Un programme nommé d'un appareil (le pédalier) : nom, PC, banque selon le mode de l'appareil. */
  program({ doc, edit, pop, id, prog }) {
    const dev = doc.pedalboard.devices[id];
    const p = dev && ((dev.midi || {}).programs || {})[prog];
    if (!p) return null;
    const mode = dev.midi.program_change || "pc";
    const set = (fn) => edit((d) => fn(d.pedalboard.devices[id].midi.programs[prog]));
    return html`
      <${Group} foot="Sounds and rigs choose it by this name."><${NameRow} value=${p.name || ""} placeholder=${prog} onChange=${(v) => set((x) => { x.name = v; })} /></${Group}>
      <${Group} title="MIDI">
        <${Row} title="Program change"><${Stepper} value=${p.pc} min=${0} max=${127} onChange=${(n) => set((x) => { x.pc = n; })} /></${Row}>
        ${mode.includes("msb") ? html`<${Row} title="Bank MSB"><${Stepper} value=${p.bank_msb ?? 0} min=${0} max=${127} onChange=${(n) => set((x) => { x.bank_msb = n; })} /></${Row}>` : null}
        ${mode.includes("lsb") ? html`<${Row} title="Bank LSB"><${Stepper} value=${p.bank_lsb ?? 0} min=${0} max=${127} onChange=${(n) => set((x) => { x.bank_lsb = n; })} /></${Row}>` : null}
      </${Group}>
      <${Group} foot="Rigs and sounds that use it keep its number."><${Row} cls="danger" title="Delete program" onTap=${() => {
        edit((d) => {
          const x = d.pedalboard.devices[id].midi.programs[prog];
          const keep = { pc: x.pc, ...(x.bank_msb != null ? { bank_msb: x.bank_msb } : {}), ...(x.bank_lsb != null ? { bank_lsb: x.bank_lsb } : {}) };
          const swap = (o) => { if (o && o[id] === prog) o[id] = Object.keys(keep).length === 1 ? keep.pc : keep; };
          Object.values(d.rigs).forEach((r) => { swap(r.programs); r.snapshots.forEach((sn) => swap(sn.programs)); });
          delete d.pedalboard.devices[id].midi.programs[prog];
        });
        pop();
      }} /></${Group}>`;
  },
  /** Une version gardée du set : la remettre dans l'éditeur (Save la garde). */
  version({ setName, version, setDoc, setStack, toast, doc }) {
    const [v, setV] = useState(null);
    useEffect(() => {
      fetch(`../library/history/${encodeURIComponent(setName)}/${encodeURIComponent(version)}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null)).then(setV).catch(() => setV(null));
    }, [version]);
    if (!v) return html`<${Group}><${Row} title="Loading…" /></${Group}>`;
    return html`
      <${Group} title="This version"><${Row} title=${summary(v)} sub=${Object.values(v.setlists || {}).map((x) => x.name).join(" · ") || "no setlist"} /></${Group}>
      <${Group} title="Now"><${Row} title=${summary(doc)} sub=${Object.values(doc.setlists || {}).map((x) => x.name).join(" · ") || "no setlist"} /></${Group}>
      <${Group} foot="It replaces what you see here; nothing is saved until you Save (or Done). The current version is kept in the history.">
        <${Row} cls="action" title="Restore this version" onTap=${() => { setDoc(clone(v)); setStack([]); toast("Restored here. Save to keep it.", 4000); }} /></${Group}>`;
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
      <${Group}><${Row} cls="danger" title="Delete parameter" onTap=${() => { edit((d) => { forgetParam(d, `${id}.${pid}`); delete d.pedalboard.devices[id].midi.params[pid]; }); pop(); }} /></${Group}>`;
  },
};

// ================================================================= rigs, sons, programmes

const PC_MODES = [["none", "No program change"], ["pc", "Program change"], ["bank_msb_pc", "Bank (MSB) + program"],
  ["bank_lsb_pc", "Bank (LSB) + program"], ["bank_msb_lsb_pc", "Bank MSB + LSB + program"]];
const takesPrograms = (dev) => !!(dev && dev.midi && (dev.midi.program_change || "pc") !== "none");
const rigDevices = (doc, rig) => Object.entries(doc.pedalboard.devices || {}).filter(([id]) => !rig.devices || rig.devices.includes(id));
const rigRange = (rig) => [rigStart(rig), rigStart(rig) + rig.snapshots.length - 1];
const firstFree = (doc) => Object.values(doc.rigs).reduce((n, r) => Math.max(n, rigRange(r)[1] + 1), 0);
const wiredLoops = (doc) => LOOPS.filter((l) => loopDevice(doc, l));

/** Un programme tel qu'affiché : son nom dans l'appareil, sinon « PC 12 » ; null = aucun. */
function programText(dev, value) {
  if (value == null) return value === null ? "None" : "—";
  const progs = ((dev && dev.midi) || {}).programs || {};
  if (typeof value === "string") return progs[value] ? progs[value].name || value : value;
  const pc = typeof value === "number" ? value : value.pc;
  const named = Object.entries(progs).find(([, p]) => p.pc === pc && (typeof value === "number" || ["bank_msb", "bank_lsb"].every((b) => p[b] === value[b])));
  return named ? named[1].name || named[0] : `PC ${pc}`;
}

/** Les rigs dont les sons sont les autres rigs de secours (`backup`) gardent des noms justes. */
function renameSound(d, rid, old, name) {
  Object.values(d.tracks).forEach((t) => { if (t.rig === rid) t.sequence = t.sequence.map((n) => (n === old ? name : n)); });
  (d.favorites || []).forEach((f) => { if (f.rig === rid && f.sound === old) f.sound = name; });
  Object.values(d.rigs).forEach((r) => { if (r.backup === rid) r.snapshots.forEach((s) => { if (s.backup === old) s.backup = name; }); });
}
function deleteSound(d, rid, i) {
  const name = d.rigs[rid].snapshots[i].name;
  d.rigs[rid].snapshots.splice(i, 1);
  const first = d.rigs[rid].snapshots[0].name;
  Object.values(d.tracks).forEach((t) => { if (t.rig === rid) t.sequence = t.sequence.map((n) => (n === name ? first : n)); });
  d.favorites = (d.favorites || []).filter((f) => !(f.rig === rid && f.sound === name));
  Object.values(d.rigs).forEach((r) => { if (r.backup === rid) r.snapshots.forEach((s) => { if (s.backup === name) delete s.backup; }); });
}

/** Une boucle qui n'est plus branchée sort des chaînes, des sons et des switches. */
function forgetLoop(d, loop) {
  Object.values(d.rigs).forEach((r) => {
    r.chain = (r.chain || []).filter((l) => l !== loop);
    r.snapshots.forEach((s) => { s.loops = (s.loops || []).filter((l) => l !== loop); });
  });
  Object.values(d.surfaces || {}).forEach((sf) => Object.entries(sf.switches || {}).forEach(([k, sw]) => { if (sw.role === "loop" && sw.loop === loop) delete sf.switches[k]; }));
}
/** Un paramètre MIDI supprimé sort des sons, des noms de switch et des switches. */
function forgetParam(d, ref) {
  Object.values(d.rigs).forEach((r) => {
    if (r.aliases) delete r.aliases[ref];
    r.snapshots.forEach((s) => { if (s.params) delete s.params[ref]; });
  });
  Object.values(d.surfaces || {}).forEach((sf) => Object.entries(sf.switches || {}).forEach(([k, sw]) => { if (sw.role === "param" && sw.param === ref) delete sf.switches[k]; }));
}
/** Un appareil supprimé (ou retiré d'un rig, `rid`) ne laisse aucune référence derrière lui. */
function forgetDevice(d, id, rid = null) {
  const loops = (d.pedalboard.devices[id] || {}).loops || [];
  Object.entries(d.rigs).forEach(([key, r]) => {
    if (rid && key !== rid) return;
    if (r.devices) r.devices = r.devices.filter((x) => x !== id);
    r.chain = (r.chain || []).filter((l) => !loops.includes(l));
    if (r.programs) delete r.programs[id];
    if (r.aliases) Object.keys(r.aliases).forEach((ref) => { if (ref.split(".")[0] === id) delete r.aliases[ref]; });
    r.snapshots.forEach((s) => {
      s.loops = (s.loops || []).filter((l) => !loops.includes(l));
      if (s.params) Object.keys(s.params).forEach((ref) => { if (ref.split(".")[0] === id) delete s.params[ref]; });
      if (s.programs) delete s.programs[id];
    });
  });
  if (rid) return;
  Object.values(d.surfaces || {}).forEach((sf) => Object.entries(sf.switches || {}).forEach(([k, sw]) => {
    if ((sw.role === "param" && (sw.param || "").split(".")[0] === id) || (sw.role === "loop" && loops.includes(sw.loop))) delete sf.switches[k];
  }));
}

function newRig({ edit, select, doc, toast }) {
  const start = firstFree(doc);
  if (start > 799) { if (toast) toast("The ES-8 has no free patch left after the last rig."); return; }
  let id = "";
  edit((d) => {
    id = newId(d.rigs, "rig");
    const sf = Object.keys(d.surfaces || {})[0];
    d.rigs[id] = { schema: "es8ctl.rig/2", name: "New rig", start: patchAt(start), chain: [], devices: [],
      ...(sf ? { surface: sf } : {}), snapshots: [{ name: "Sound 1", loops: [], params: {} }] };
  });
  setTimeout(() => select({ rig: id, rigInfo: true }), 0);
}

const Hint = ({ children }) => html`<span class="hint">${children}</span>`;

function RigDetail({ doc, edit, push, select, goTo, rid, toast }) {
  const [editChain, setEditChain] = useState(false);
  const rig = doc.rigs[rid];
  const set = (fn) => edit((d) => fn(d.rigs[rid]));
  const [a, b] = rigRange(rig);
  const clash = Object.entries(doc.rigs).filter(([id, r]) => id !== rid && rigRange(r)[0] <= b && a <= rigRange(r)[1]).map(([, r]) => r.name);
  const devices = rigDevices(doc, rig);
  const usedBy = Object.values(doc.tracks).filter((t) => t.rig === rid).length;
  const backupOf = Object.values(doc.rigs).filter((r) => r.backup === rid).length;
  const params = allParams(doc).filter((x) => !rig.devices || rig.devices.includes(x.did));
  const toolStyle = "color:var(--accent);min-height:36px;text-transform:none;letter-spacing:0;font-size:15px";
  return html`<${Detail} title=${rig.name}>
    <${Group} foot="ES-8 patch names are the prefix and the sound's name, shortened to 16 characters.">
      <${NameRow} value=${rig.name} onChange=${(v) => set((r) => { r.name = v; })} />
      <${Row} title="Patch name prefix"><input class="text" value=${rig.short ?? ""} placeholder=${rig.name}
        onInput=${(e) => set((r) => { if (e.target.value) r.short = e.target.value; else delete r.short; })} /></${Row}>
    </${Group}>
    <${Group} title="ES-8 patches" foot=${clash.length ? `⚠ These patches are also used by ${clash.join(", ")}.` : `${plural(rig.snapshots.length, "sound")}, one patch each.`}>
      <${Row} title="First patch"><${PatchStepper} value=${a} max=${800 - rig.snapshots.length} onChange=${(n) => set((r) => { r.start = patchAt(n); delete r.bank; })} /></${Row}>
      <${Row} title="Patches" value=${`${patchAt(a)} → ${patchAt(b)}`} />
      <${Row} cls="action" title="Move to the first free patches" onTap=${() => set((r) => { r.start = patchAt(firstFree({ rigs: Object.fromEntries(Object.entries(doc.rigs).filter(([id]) => id !== rid)) })); })} />
    </${Group}>
    <${Group} title="Signal chain" foot="The loops this rig uses, from the guitar to the amp. Each sound switches them on or off."
      tools=${html`<button class="tool" style=${toolStyle} onClick=${() => setEditChain(!editChain)}>${editChain ? "Done" : "Edit"}</button>`}>
      ${(rig.chain || []).length ? html`<${EditableRows} editing=${editChain}
        rows=${rig.chain.map((l) => ({ key: l, lead: l, title: (loopDevice(doc, l) || {}).name || "—" }))}
        onMove=${(x, y) => set((r) => { r.chain = moved(r.chain, x, y); })}
        onDelete=${(i) => set((r) => { const l = r.chain[i]; r.chain.splice(i, 1); r.snapshots.forEach((s) => { s.loops = (s.loops || []).filter((x) => x !== l); }); })} />`
        : html`<${Row} title="No loop yet" />`}
    </${Group}>
    <${Group}><${Row} cls="action" title="+ Add a loop" onTap=${() => push({ kind: "pick", title: "Add a loop", back: rig.name, current: null,
      options: wiredLoops(doc).filter((l) => !(rig.chain || []).includes(l)).map((l) => ({ value: l, label: l, sub: loopDevice(doc, l).name })),
      foot: "Only the loops with a device plugged in (Pedalboard).",
      onPick: (l) => edit((d) => {
        const r = d.rigs[rid];
        r.chain = [...(r.chain || []), l];
        const owner = Object.entries(d.pedalboard.devices).find(([, x]) => (x.loops || []).includes(l));
        if (r.devices && owner && !r.devices.includes(owner[0])) r.devices.push(owner[0]);
      }) })} /></${Group}>
    <${Group} title="Devices" foot="The devices this rig drives. A device left out cannot be used by its sounds.">
      <${Row} title="Used by this rig" value=${rig.devices ? rig.devices.map((id) => (doc.pedalboard.devices[id] || {}).name || id).join(", ") || "none" : "all"} link
        onTap=${() => push({ kind: "multi", title: "Devices", back: rig.name,
          options: Object.entries(doc.pedalboard.devices).map(([id, x]) => ({ value: id, label: x.name, sub: (x.loops || []).join(" ") })),
          get: (d) => (d.rigs[rid] ? d.rigs[rid].devices || Object.keys(d.pedalboard.devices) : []),
          toggle: (id) => edit((d) => {
            const r = d.rigs[rid];
            const now = r.devices || Object.keys(d.pedalboard.devices);
            if (now.includes(id)) { r.devices = now; forgetDevice(d, id, rid); } else r.devices = [...now, id];
          }) })} />
    </${Group}>
    ${devices.some(([, x]) => takesPrograms(x)) ? html`<${Group} title="Programs" foot="Sent to each device when a sound of this rig is recalled. A sound can choose another one.">
      ${devices.filter(([, x]) => takesPrograms(x)).map(([did, x]) => html`<${Row} title=${x.name} value=${(rig.programs || {})[did] === undefined ? "None" : programText(x, rig.programs[did])} link
        onTap=${() => push({ kind: "progpick", title: x.name, back: rig.name, id: did, unset: "None",
          get: (d) => ((d.rigs[rid] || {}).programs || {})[did],
          put: (d, v) => { const r = d.rigs[rid]; r.programs = { ...(r.programs || {}) }; if (v === undefined) delete r.programs[did]; else r.programs[did] = v; } })} />`)}
    </${Group}>` : null}
    <${Group} title="Footswitches">
      <${Row} title="Surface" value=${rig.surface ? (doc.surfaces[rig.surface] || {}).name || rig.surface : "None"} link onTap=${() => push({ kind: "pick", title: "Surface", back: rig.name, current: rig.surface || "",
        options: [{ value: "", label: "None" }, ...Object.entries(doc.surfaces || {}).map(([id, sf]) => ({ value: id, label: sf.name || id }))],
        onPick: (v) => set((r) => { if (v) r.surface = v; else delete r.surface; }) })} />
    </${Group}>
    ${params.length ? html`<${Group} title="Switch names" foot="How this rig names each MIDI parameter on stage (for example “Drive” instead of “Macro1”). Empty: the parameter's name.">
      ${params.map((x) => html`<${Row} title=${x.p.name} sub=${x.dev.name}><input class="text" value=${(rig.aliases || {})[x.ref] || ""} placeholder=${x.p.name}
        onInput=${(e) => set((r) => { r.aliases = { ...(r.aliases || {}) }; if (e.target.value) r.aliases[x.ref] = e.target.value; else delete r.aliases[x.ref]; })} /></${Row}>`)}
    </${Group}>` : null}
    <${Group} title="Backup" foot="With Backup on, on stage, every sound of this rig is replaced by a sound of the backup rig (another amp, another path).">
      <${Row} title="Backup rig" value=${rig.backup ? (doc.rigs[rig.backup] || {}).name || rig.backup : "None"} link onTap=${() => push({ kind: "pick", title: "Backup rig", back: rig.name, current: rig.backup || "",
        options: [{ value: "", label: "None" }, ...Object.entries(doc.rigs).filter(([id]) => id !== rid).map(([id, r]) => ({ value: id, label: r.name }))],
        onPick: (v) => set((r) => { if (v) r.backup = v; else { delete r.backup; r.snapshots.forEach((s) => { delete s.backup; }); } }) })} />
    </${Group}>
    <${Group} foot=${usedBy || backupOf ? `Used by ${[usedBy ? plural(usedBy, "song") : "", backupOf ? `${plural(backupOf, "rig")} as backup` : ""].filter(Boolean).join(" and ")}: change them first.` : ""}>
      <${Row} cls="danger" title="Delete rig" onTap=${usedBy || backupOf ? null : () => { edit((d) => { delete d.rigs[rid]; d.favorites = (d.favorites || []).filter((f) => f.rig !== rid); }); select({}); }} />
    </${Group}>
  </${Detail}>`;
}

/** − 12-5 + : un patch de l'ES-8, de 0-1 à 99-8. */
const PatchStepper = ({ value, max, onChange }) => {
  const set = (v) => onChange(Math.max(0, Math.min(max, v)));
  return html`<span class="stepper"><button aria-label="Previous bank" onClick=${() => set(value - 8)}>«</button><button aria-label="Previous patch" onClick=${() => set(value - 1)}>−</button>
    <span>${patchAt(value)}</span><button aria-label="Next patch" onClick=${() => set(value + 1)}>+</button><button aria-label="Next bank" onClick=${() => set(value + 8)}>»</button></span>`;
};

function SoundDetail({ doc, edit, goTo, push, rid, i, diff, playing, hear, send, connected, jobBusy }) {
  const rig = doc.rigs[rid];
  const sn = rig.snapshots[i];
  const set = (fn) => edit((d) => fn(d.rigs[rid].snapshots[i]));
  const params = allParams(doc).filter((x) => !rig.devices || rig.devices.includes(x.did));
  const usedIn = Object.entries(doc.tracks).filter(([, t]) => t.rig === rid && t.sequence.includes(sn.name));
  const now = !!(playing && playing.rid === rid && playing.name === sn.name);
  const differs = soundDiffers(rig, i, diff);
  const devices = rigDevices(doc, rig).filter(([, x]) => takesPrograms(x));
  const backupRig = rig.backup && doc.rigs[rig.backup];
  return html`<${Detail} title=${sn.name}>
    <${Group}><${NameRow} value=${sn.name} onChange=${(v) => edit((d) => { const old = d.rigs[rid].snapshots[i].name; d.rigs[rid].snapshots[i].name = v; renameSound(d, rid, old, v); })} />
      <${Row} title="ES-8 patch" sub=${now ? "Playing now" : ""} value=${html`${differs ? html`<span class="pend"></span>differs · ` : null}${patchOf(rig, i)}`} />
      <${Row} title="★ Favorite" sub="On the home page, one touch away.">
        <${Switch} on=${isFavorite(doc, rid, sn.name)} onChange=${(v) => edit((d) => {
          const rest = (d.favorites || []).filter((f) => !(f.rig === rid && f.sound === sn.name));
          d.favorites = v ? [...rest, { rig: rid, sound: sn.name }] : rest;
        })} /></${Row}></${Group}>
    ${differs && connected ? html`<${Group} foot="Writes this sound only to the ES-8 and recalls it. The footswitches pause for a moment.">
      <${Row} cls="action" title=${jobBusy ? "Writing the ES-8…" : "▶ Hear it on the ES-8"} onTap=${jobBusy ? null : () => send(patchOf(rig, i))} /></${Group}>` : null}
    <${Group} title="Loops" foot="The loops of this rig's signal chain, in order.">
      ${(rig.chain || []).length ? rig.chain.map((l) => {
        const on = (sn.loops || []).includes(l);
        const dev = loopDevice(doc, l);
        return html`<${Row} lead=${l} title=${dev ? dev.name : "—"}>
          <${Switch} on=${on} onChange=${(v) => set((s) => { s.loops = v ? rig.chain.filter((x) => x === l || (s.loops || []).includes(x)) : (s.loops || []).filter((x) => x !== l); })} /></${Row}>`;
      }) : html`<${Row} title="This rig's chain has no loop yet" link onTap=${() => goTo("sounds", { rig: rid, rigInfo: true })} />`}
    </${Group}>
    ${params.length ? html`<${Group} title="MIDI" foot=${now ? "This sound is playing: each change is heard at once." : "Off and On send the parameter's own values; Value sends the number you choose."}>
      ${params.map((x) => {
        const v = (sn.params || {})[x.ref];
        const mode = typeof v === "number" ? "value" : v === "on" ? "on" : "off";
        const put = (nv) => {
          set((s) => { s.params = { ...(s.params || {}), [x.ref]: nv }; });
          if (now && x.dev.midi) hear(x.dev.midi.channel, x.p.cc, nv === "on" ? x.p.on ?? 127 : nv === "off" ? x.p.off ?? 0 : nv);
        };
        return html`<${Row} title=${(rig.aliases || {})[x.ref] || x.p.name} sub=${`${x.dev.name} · CC ${x.p.cc}`}>
            <${Seg} value=${mode} options=${[["off", "Off"], ["on", "On"], ["value", "Value"]]}
              onChange=${(m) => put(m === "value" ? (typeof v === "number" ? v : 64) : m)} /></${Row}>
          ${mode === "value" ? html`<${Row} title=${html`<input class="slider" type="range" min="0" max="127" value=${v} onInput=${(e) => put(Number(e.target.value))} />`}>
            <${Stepper} value=${v} min=${0} max=${127} onChange=${put} /></${Row}>` : null}`;
      })}
    </${Group}>` : null}
    ${devices.length ? html`<${Group} title="Programs" foot="By default, the rig's program. A sound can send another one, or none.">
      ${devices.map(([did, x]) => {
        const own = (sn.programs || {})[did];
        const base = (rig.programs || {})[did];
        return html`<${Row} title=${x.name} value=${own === undefined ? `Rig: ${base === undefined ? "none" : programText(x, base)}` : programText(x, own)} link
          onTap=${() => push({ kind: "progpick", title: x.name, back: sn.name, id: did, unset: `Rig's program (${base === undefined ? "none" : programText(x, base)})`, allowNull: true,
            get: (d) => (((d.rigs[rid] || {}).snapshots[i] || {}).programs || {})[did],
            put: (d, nv) => { const s = d.rigs[rid].snapshots[i]; s.programs = { ...(s.programs || {}) }; if (nv === undefined) delete s.programs[did]; else s.programs[did] = nv; if (!Object.keys(s.programs).length) delete s.programs; } })} />`;
      })}
    </${Group}>` : null}
    ${backupRig ? html`<${Group} title="Backup" foot=${`With Backup on, the stage plays this sound of “${backupRig.name}” instead.`}>
      <${Row} title="Backup sound" value=${sn.backup || `${backupRig.snapshots[0].name} (first)`} link onTap=${() => push({ kind: "pick", title: "Backup sound", back: sn.name, current: sn.backup || "",
        options: [{ value: "", label: `${backupRig.snapshots[0].name} (first, default)` }, ...backupRig.snapshots.slice(1).map((s) => ({ value: s.name, label: s.name }))],
        onPick: (v) => set((s) => { if (v) s.backup = v; else delete s.backup; }) })} /></${Group}>` : null}
    <${Group} title="Used in">${usedIn.length ? usedIn.map(([tid, t]) => html`<${Row} title=${t.name} link onTap=${() => goTo("songs", { track: tid })} />`)
      : html`<${Row} title="No song uses this sound yet" />`}</${Group}>
    <${Group}><${Row} cls="danger" title="Delete sound" onTap=${rig.snapshots.length > 1 ? () => edit((d) => deleteSound(d, rid, i)) : null} /></${Group}>
  </${Detail}>`;
}

// ================================================================= réglages

const SETTINGS = {
  title: () => "Settings",
  List({ sel, select, setName }) {
    const go = (path) => () => { window.location.href = path; };
    return html`
      <${Group} title="MIDI">
        <${Row} title="ES-8 and stage channels" link current=${sel.midi} onTap=${() => select({ midi: true })} />
      </${Group}>
      <${Group} title="Saved versions">
        <${Row} title="History" sub="Go back to an earlier save" link current=${sel.history} onTap=${() => select({ history: true })} />
      </${Group}>
      <${Group} title="Other tools" foot="They open in place of this app.">
        <${Row} title="ES-8 patches" sub="Every patch and setting of the ES-8, raw (ES8 Control)" link onTap=${go("../control/")} />
        <${Row} title="Stage host" sub="The Raspberry Pi, the ES-8 connection, backups of the ES-8" link onTap=${go("../host/")} />
        <${Row} title="Desktop Designer" sub="The previous editor, for a large screen" link onTap=${go("../designer/")} />
      </${Group}>`;
  },
  Detail(ctx) {
    if (ctx.sel.midi) return html`<${MidiSettings} ...${ctx} />`;
    if (ctx.sel.history) return html`<${History} ...${ctx} />`;
    return html`<${Empty} text="Choose a setting." />`;
  },
};

function MidiSettings({ doc, edit }) {
  const c = { channel: 16, first_cc: 80, es8_channel: 1, ...(doc.companion || {}) };
  const put = (k) => (n) => edit((d) => { d.companion = { ...c, ...(d.companion || {}), [k]: n }; });
  return html`<${Detail} title="ES-8 and stage channels">
    <${Group} title="ES-8" foot="The channel on which the ES-8 receives the program changes of the setlist (its MIDI Rx channel).">
      <${Row} title="Receives on channel"><${Stepper} value=${c.es8_channel} min=${1} max=${16} onChange=${put("es8_channel")} /></${Row}>
    </${Group}>
    <${Group} title="Footswitches handled by the stage" foot=${`Footswitches set to move through the setlist, or to switch a MIDI parameter, send a control change to the stage on this channel: CC ${c.first_cc} for NUM1, then one per switch. No device may use this channel.`}>
      <${Row} title="Channel"><${Stepper} value=${c.channel} min=${1} max=${16} onChange=${put("channel")} /></${Row}>
      <${Row} title="First CC"><${Stepper} value=${c.first_cc} min=${0} max=${112} onChange=${put("first_cc")} /></${Row}>
    </${Group}>
  </${Detail}>`;
}

const when = (id) => { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d)\.(\d\d)/.exec(id); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : id; };

function History({ setName, push }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    fetch(`../library/history/${encodeURIComponent(setName)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).then(setList).catch(() => setList([]));
  }, [setName]);
  return html`<${Detail} title="History">
    <${Group} title="Earlier versions" foot="A version of everything (pedalboard, sounds, songs, setlists, favorites) is kept each time you save, five minutes apart at least (100 at most). Restoring one brings it back here: Save keeps it.">
      ${list === null ? html`<${Row} title="Loading…" />` : list.length ? list.map((v) => html`<${Row} title=${when(v.id)} link
        onTap=${() => push({ kind: "version", title: when(v.id), back: "History", version: v.id })} />`) : html`<${Row} title="No earlier version yet" />`}
    </${Group}>
  </${Detail}>`;
}

/** Résumé d'un document de set : ce qu'on voit d'un coup d'œil pour reconnaître une version. */
const summary = (d) => [plural(Object.keys(d.rigs || {}).length, "rig"), plural(Object.values(d.rigs || {}).reduce((n, r) => n + r.snapshots.length, 0), "sound"),
  plural(Object.keys(d.tracks || {}).length, "song"), plural(Object.keys(d.setlists || {}).length, "setlist")].join(" · ");

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
    <${SongInfoGroup} tr=${tr} set=${(fn) => edit((d) => fn(d.tracks[id]))} />
    ${extra}
    <${Group} title="In setlists">${inSets.length ? inSets.map(([sid, n]) => html`<${Row} title=${n} link onTap=${() => goTo("setlists", { setlist: sid })} />`)
      : html`<${Row} title="In no setlist yet" />`}</${Group}>
  </${Detail}>`;
}

/** Ce que la scène montre d'un morceau : tempo (le décompte), tonalité ou accordage, notes. */
function SongInfoGroup({ tr, set }) {
  const text = (k) => (e) => set((t) => { if (e.target.value) t[k] = e.target.value; else delete t[k]; });
  return html`<${Group} title="On stage" foot="Shown under the song's name, and on the Next card before it starts. The dot beats at the tempo.">
    <${Row} title="Tempo" sub=${tr.tempo ? "" : "None"}>
      ${tr.tempo ? html`<${Stepper} value=${tr.tempo} min=${20} max=${300} onChange=${(n) => set((t) => { t.tempo = n; })} />` : null}
      <${Switch} on=${!!tr.tempo} onChange=${(v) => set((t) => { if (v) t.tempo = 120; else delete t.tempo; })} /></${Row}>
    <${Row} title="Key / tuning"><input class="text" maxlength="24" value=${tr.key || ""} placeholder="E minor, drop D…" onInput=${text("key")} /></${Row}>
    <div class="row"><textarea class="notes" maxlength="500" rows="3" placeholder="Notes: intro, cues, capo…" value=${tr.notes || ""} onInput=${text("notes")}></textarea></div>
  </${Group}>`;
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
    title: () => "Sounds",
    tools: (ctx) => html`<${EditTool} ...${ctx} />
      <button class="tool icon" aria-label="New sound" onClick=${() => {
        const rid = ctx.sel.rig && ctx.doc.rigs[ctx.sel.rig] ? ctx.sel.rig : Object.keys(ctx.doc.rigs)[0];
        if (!rid) { newRig(ctx); return; }
        const rig = ctx.doc.rigs[rid];
        let n = rig.snapshots.length + 1;
        while (rig.snapshots.some((s) => s.name === `Sound ${n}`)) n += 1;
        ctx.edit((d) => { d.rigs[rid].snapshots.push({ name: `Sound ${n}`, loops: [...(rig.chain || [])], params: {} }); });
        ctx.select({ rig: rid, index: rig.snapshots.length });
      }}>+</button>`,
    List({ doc, edit, sel, select, editing, diff, playing }) {
      const ids = Object.keys(doc.rigs);
      const rid = sel.rig && doc.rigs[sel.rig] ? sel.rig : ids[0];
      const rig = rid && doc.rigs[rid];
      return html`
        <${Group} title="Rigs" foot="A rig is a group of sounds on consecutive ES-8 patches. Touch a rig for its settings.">
          ${ids.map((id) => {
            const r = doc.rigs[id];
            const [a, b] = rigRange(r);
            const pend = r.snapshots.some((_, i) => soundDiffers(r, i, diff));
            return html`<${Row} title=${r.name} sub=${`${plural(r.snapshots.length, "sound")} · ${patchAt(a)} → ${patchAt(b)}`} link
              current=${id === rid && sel.rigInfo} onTap=${() => select({ rig: id, rigInfo: true })}
              value=${html`${pend ? html`<span class="pend"></span>` : null}${id === rid && !sel.rigInfo ? html`<span class="check">✓</span>` : null}`} />`;
          })}
          <${Row} cls="action" title="+ New rig" onTap=${() => newRig({ edit, select, doc })} />
        </${Group}>
        ${rig ? html`<${Group} title=${rig.name} foot=${`One ES-8 patch per sound, in a row from ${patchOf(rig, 0)}. Moving a sound changes its patch.`}>
          <${EditableRows} editing=${editing}
            rows=${rig.snapshots.map((sn, i) => {
              const midi = Object.values(sn.params || {}).filter((v) => v && v !== "off").length;
              const now = playing && playing.rid === rid && playing.name === sn.name;
              return { key: `${i}-${sn.name}`, lead: patchOf(rig, i), title: sn.name, link: true,
                value: html`${soundDiffers(rig, i, diff) ? html`<span class="pend" title="Differs from the ES-8"></span>` : null}${now ? html`<span class="now">▶</span>` : null}${isFavorite(doc, rid, sn.name) ? "★" : null}`,
                sub: [(sn.loops || []).join(" ") || "no loop", midi ? `${midi} MIDI` : ""].filter(Boolean).join(" · "),
                current: !sel.rigInfo && sel.index === i && (sel.rig || ids[0]) === rid, onTap: () => select({ rig: rid, index: i }) };
            })}
            onMove=${(a, b) => { edit((d) => { d.rigs[rid].snapshots = moved(d.rigs[rid].snapshots, a, b); }); select({ rig: rid, index: follow(sel.index, a, b) }); }}
            onDelete=${rig.snapshots.length > 1 ? (i) => { edit((d) => deleteSound(d, rid, i)); select({ rig: rid }); } : null} />
        </${Group}>` : html`<p class="lead-text">No rig yet: + New rig.</p>`}`;
    },
    Detail(ctx) {
      const { doc, sel } = ctx;
      const rid = sel.rig && doc.rigs[sel.rig] ? sel.rig : Object.keys(doc.rigs)[0];
      if (rid && sel.rigInfo) return html`<${RigDetail} ...${ctx} rid=${rid} />`;
      const rig = rid && doc.rigs[rid];
      const sn = rig && rig.snapshots[sel.index];
      if (!sn) return html`<${Empty} text="Choose a sound, or a rig for its settings." />`;
      return html`<${SoundDetail} ...${ctx} rid=${rid} i=${sel.index} />`;
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
        <${Group} title="Move through the setlist">${COMPANION_ACTIONS.map(([a, label]) => html`
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
          else forgetLoop(d, sel.loop);
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
              if (has) forgetLoop(d, l);
            }) })} /></${Group}>
        <${Group} title="MIDI">
          <${Row} title="Receives MIDI from the ES-8"><${Switch} on=${!!dev.midi} onChange=${(v) => edit((d) => {
            const x = d.pedalboard.devices[id];
            if (v) { x.midi = x.midi || { channel: 1, program_change: "pc", programs: {}, params: {} }; return; }
            Object.keys((x.midi && x.midi.params) || {}).forEach((pid) => forgetParam(d, `${id}.${pid}`));
            Object.values(d.rigs).forEach((r) => { if (r.programs) delete r.programs[id]; r.snapshots.forEach((sn) => { if (sn.programs) delete sn.programs[id]; }); });
            delete x.midi;
          })} /></${Row}>
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
        ${dev.midi ? html`<${Group} title="Program change" foot=${takesPrograms(dev) ? "Name the programs you use: rigs and sounds then choose them by name." : ""}>
          <${Row} title="Sends" value=${(PC_MODES.find(([m]) => m === (dev.midi.program_change || "pc")) || [0, "?"])[1]} link onTap=${() => push({ kind: "pick", title: "Program change", back: dev.name,
            current: dev.midi.program_change || "pc", options: PC_MODES.map(([value, label]) => ({ value, label })),
            onPick: (m) => set((x) => { x.midi.program_change = m; if (m === "none") Object.keys(x.midi.programs || {}).length || delete x.midi.programs; }) })} />
          ${takesPrograms(dev) ? Object.entries(dev.midi.programs || {}).map(([prog, p]) => html`<${Row} title=${p.name || prog} value=${`PC ${p.pc}`} link
            onTap=${() => push({ kind: "program", title: p.name || prog, back: dev.name, id, prog })} />`) : null}
          ${takesPrograms(dev) ? html`<${Row} cls="action" title="+ Add a program" onTap=${() => {
            const prog = newId(dev.midi.programs || {}, "program");
            const used = new Set(Object.values(dev.midi.programs || {}).map((p) => p.pc));
            let pc = 0; while (used.has(pc)) pc += 1;
            set((x) => { x.midi.programs = { ...(x.midi.programs || {}), [prog]: { name: `Program ${pc}`, pc } }; });
            push({ kind: "program", title: `Program ${pc}`, back: dev.name, id, prog });
          }} />` : null}
        </${Group}>` : null}
        <${Group} foot="Rigs, sounds and footswitches stop using it."><${Row} cls="danger" title="Delete device" onTap=${() => { edit((d) => { forgetDevice(d, id); delete d.pedalboard.devices[id]; }); select({}); }} /></${Group}>
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
    <${Group} title="Songs, in the order of the gig" foot=${`${plural(rows.length, "song")} · ${plural(pc, "step")}. A song can come back later in the setlist.`}
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
SCREENS.settings = SETTINGS;

if (!window.ES8_SHELL) render(html`<${App} />`, document.getElementById("root")); // page seule

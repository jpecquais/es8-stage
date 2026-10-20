// ES8 Stage Host — la page de l'hôte de scène (docs/stage-host.md) : l'ES-8 et le WIDI, la bibliothèque
// (projets, shows, sauvegardes de l'ES-8), le système du Pi. Protégée par un mot de passe.
import { html, render, useState, useEffect } from "../shared/vendor/preact-htm.module.js";

const API = "api/";
const LIB = "../library/";
const KINDS = [
  ["shows", "Shows", ".show.json", "What ES8 Companion plays. Play one to give it to every open Companion."],
  ["projects", "Projects", ".es8project.json", "ES8 Designer projects. Open them in ES8 Designer (menu · Library…)."],
  ["backups", "ES-8 backups", ".syx", "Whole-ES-8 dumps. Restoring writes only the pages that differ, then checks them."],
];

async function req(url, { method = "GET", body, raw } = {}) {
  const res = await fetch(url, {
    method, credentials: "same-origin",
    headers: body !== undefined && !raw ? { "Content-Type": "application/json" } : {},
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* pas de JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

const libUrl = (kind, name) => `${LIB}${kind}/${encodeURIComponent(name)}`;
const date = (t) => new Date(t * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
const size = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
const duration = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

function App() {
  const [st, setSt] = useState(null);
  const [lib, setLib] = useState(null);
  const [msg, setMsg] = useState(null);
  const [gone, setGone] = useState("");

  const refresh = async () => {
    try {
      const s = await req(API + "status");
      setSt(s);
      if (gone && gone !== "poweroff") setGone("");
      if (!s.auth.set || s.auth.ok) setLib(await req(LIB));
    } catch { setSt((s) => s && { ...s, offline: true }); }
  };
  useEffect(() => {
    refresh();
    const busy = st && st.job && !st.job.done;
    const t = setInterval(refresh, busy ? 1000 : 4000);
    return () => clearInterval(t);
  }, [st && st.job && st.job.done, st && !!st.job, gone]);

  /** Exécute une action ; affiche son erreur ou `done` ; rafraîchit. */
  const run = async (fn, done) => {
    try { await fn(); if (done) setMsg({ text: done, kind: "ok" }); }
    catch (err) { setMsg({ text: err.message, kind: "bad" }); }
    refresh();
  };

  if (!st) return html`<div class="page"><p class="muted">Connecting to the stage host…</p></div>`;
  if (st.auth.set && !st.auth.ok) return html`<${Login} onDone=${refresh} />`;
  const ctx = { st, lib, run, setGone };
  return html`
    <div class="page">
      <header class="bar">
        <div class="title"><h1>${st.system.hostname}</h1><p class="eyebrow">ES8 stage host</p></div>
        <nav class="row-wrap">
          <a class="ghost" href="../companion/">Companion</a>
          <a class="ghost" href="../designer/">Designer</a>
          <a class="ghost" href="../control/">Control</a>
          ${st.auth.set ? html`<button class="ghost" onClick=${() => run(() => req(API + "logout", { method: "POST" }))}>Log out</button>` : null}
        </nav>
      </header>
      ${gone ? html`<p class="notice">${gone === "poweroff"
        ? "The Pi is shutting down. Unplug it once its green light has stopped blinking (about 20 s)."
        : "Restarting… this page comes back by itself."}</p>` : null}
      ${st.offline && !gone ? html`<p class="notice">The stage host does not answer.</p>` : null}
      ${!st.auth.set ? html`<${SetPassword} first run=${run} />` : null}
      ${msg ? html`<p class="toast ${msg.kind}" onClick=${() => setMsg(null)}>${msg.text} <span class="x">×</span></p>` : null}
      <div class="grid">
        ${st.stage ? html`<${ES8} ...${ctx} />` : null}
        <${Library} ...${ctx} />
        <${System} ...${ctx} />
        <section class="box">
          <h2 class="eyebrow">Network</h2>
          <p class="muted small">Known Wi-Fi networks and the pedalbrain hotspot: coming next.</p>
        </section>
        ${st.auth.set ? html`<${SetPassword} run=${run} />` : null}
      </div>
    </div>`;
}

function Login({ onDone }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    try { await req(API + "login", { method: "POST", body: { password: pw } }); onDone(); }
    catch (x) { setErr(x.message); }
  };
  return html`
    <div class="page narrow">
      <form class="box" onSubmit=${submit}>
        <h1>Stage host</h1>
        <label class="field">Password<input type="password" autofocus value=${pw} onInput=${(e) => setPw(e.target.value)} /></label>
        ${err ? html`<p class="bad">${err}</p>` : null}
        <button class="primary" disabled=${!pw}>Log in</button>
      </form>
    </div>`;
}

function SetPassword({ first, run }) {
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const ok = pw.length >= 4 && pw === again;
  return html`
    <form class="box ${first ? "warn" : ""}" onSubmit=${(e) => {
      e.preventDefault();
      run(() => req(API + "password", { method: "POST", body: { password: pw } }), first ? "Password set." : "Password changed.");
      setPw(""); setAgain("");
    }}>
      <h2 class="eyebrow">${first ? "No password yet" : "Password"}</h2>
      ${first ? html`<p class="small">Anyone on the network can use this page, which can shut the Pi down or delete a set. Choose a password.</p>` : null}
      <div class="row-wrap">
        <input type="password" placeholder=${first ? "Password" : "New password"} value=${pw} onInput=${(e) => setPw(e.target.value)} />
        <input type="password" placeholder="Again" value=${again} onInput=${(e) => setAgain(e.target.value)} />
        <button class="primary" disabled=${!ok}>${first ? "Set" : "Change"}</button>
      </div>
      ${pw && again && pw !== again ? html`<p class="small bad">The two passwords differ.</p>` : null}
    </form>`;
}

function Job({ job }) {
  if (!job) return null;
  const what = { backup: "Backing up the ES-8", restore: "Restoring the ES-8" }[job.kind] || job.kind;
  const phase = { start: "starting", read: "reading", send: "writing", resend: "writing again" }[job.phase] || job.phase;
  if (!job.done) {
    return html`<div class="job"><span><b>${what}</b> · ${phase} ${job.total ? `${job.n}/${job.total}` : ""}</span>
      <progress max=${job.total || 1} value=${job.n}></progress></div>`;
  }
  if (job.error) return html`<p class="small bad">${what} failed: ${job.error}</p>`;
  const r = job.result || {};
  return html`<p class="small ok">${job.kind === "backup" ? `Backed up as “${r.name}”.`
    : r.pages === 0 ? `The ES-8 already matched the backup (kept the previous state as “${r.before}”).`
    : `${r.pages} page(s) written${r.confirmed ? " and verified" : ", some could not be verified"}. Previous state kept as “${r.before}”.`}</p>`;
}

function ES8({ st, run }) {
  const m = st.midi || {};
  const busy = st.job && !st.job.done;
  return html`
    <section class="box">
      <h2 class="eyebrow">ES-8</h2>
      <p><span class="dot ${m.connected ? "on" : ""}"></span>${m.connected ? m.port : `Not connected (looking for “${m.match}”${st.ble ? ", Bluetooth " + st.ble : ""})`}</p>
      <div class="row-wrap">
        <button class="ghost" onClick=${() => run(() => req(API + "reconnect", { method: "POST" }), "Reconnecting…")}>Reconnect</button>
      </div>
      <label class="check"><input type="checkbox" checked=${st.edit} disabled=${busy && st.job.kind === "restore"}
        onChange=${(e) => run(() => req(API + "edit", { method: "POST", body: { on: e.target.checked } }))} />
        <span><b>Edit mode</b> <span class="muted small">pauses ES8 Companion and allows writing to the ES-8 (Designer, Control, restore)</span></span></label>
      ${st.show ? html`<p class="small muted">Playing: ${st.show.join(" · ")}${st.pos ? ` · step ${st.pos.step + 1}` : ""}</p>` : null}
      <div class="sep">
        <button class="primary" disabled=${!m.connected || busy}
          onClick=${() => run(() => req(API + "backup", { method: "POST", body: {} }))}>Back up the ES-8 now</button>
        <p class="small muted">Reads the whole ES-8 (about 800 pages, a few minutes); it can play meanwhile.</p>
        <${Job} job=${st.job} />
      </div>
    </section>`;
}

function Library({ st, lib, run }) {
  if (!lib) return null;
  const ask = (name) => { const to = prompt("New name", name); return to && to.trim() && to.trim() !== name ? to.trim() : null; };
  const busy = st.job && !st.job.done;
  const upload = (kind, ext) => (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const name = file.name.endsWith(ext) ? file.name.slice(0, -ext.length) : file.name.replace(/\.[^.]*$/, "");
    run(async () => req(libUrl(kind, name) + "?new", { method: "PUT", raw: await file.arrayBuffer() }), `${name} imported.`);
  };
  return html`
    <section class="box wide">
      <h2 class="eyebrow">Library</h2>
      ${KINDS.map(([kind, title, ext, help]) => html`
        <div class="lib">
          <div class="row-wrap"><h3 class="grow">${title}</h3>
            <label class="ghost small">Import…<input type="file" hidden accept=${kind === "backups" ? ".syx" : ".json"} onChange=${upload(kind, ext)} /></label>
          </div>
          <p class="small muted">${help}</p>
          ${lib[kind].length ? html`<ul>${lib[kind].map((it) => html`
            <li>
              <span class="grow"><b>${it.name}</b> <span class="small muted">${date(it.modified)} · ${size(it.size)}</span></span>
              <span class="acts">
                ${kind === "shows" ? (it.name === lib.playing ? html`<span class="tag">playing</span>`
                  : html`<button class="primary small" onClick=${() => run(() => req(libUrl(kind, it.name), { method: "POST", body: { op: "play" } }), `${it.name} is played now.`)}>Play</button>`) : null}
                ${kind === "backups" && st.stage ? html`<button class="ghost small" disabled=${!st.edit || busy || !(st.midi || {}).connected}
                  title=${st.edit ? "Write this backup to the ES-8" : "Turn Edit mode on first"}
                  onClick=${() => confirm(`Restore “${it.name}” to the ES-8? The current state is backed up first.`)
                    && run(() => req(API + "restore", { method: "POST", body: { name: it.name } }))}>Restore</button>` : null}
                ${kind !== "backups" ? html`<button class="link" onClick=${() => run(() => req(libUrl(kind, it.name), { method: "POST", body: { op: "duplicate" } }))}>Duplicate</button>` : null}
                <button class="link" onClick=${() => { const to = ask(it.name); if (to) run(() => req(libUrl(kind, it.name), { method: "POST", body: { op: "rename", to } })); }}>Rename</button>
                <a class="link" href=${libUrl(kind, it.name) + "?download"} download>Download</a>
                <button class="link bad" onClick=${() => confirm(`Delete “${it.name}”? This cannot be undone.`) && run(() => req(libUrl(kind, it.name), { method: "DELETE" }))}>Delete</button>
              </span>
            </li>`)}</ul>` : html`<p class="small muted">None yet.</p>`}
        </div>`)}
    </section>`;
}

function System({ st, run, setGone }) {
  const s = st.system;
  const act = (what, question, after) => () => {
    if (!confirm(question)) return;
    run(() => req(API + what, { method: "POST" }));
    setGone(after);
  };
  return html`
    <section class="box">
      <h2 class="eyebrow">System</h2>
      <dl class="facts">
        ${s.uptime_s != null ? html`<dt>Up for</dt><dd>${duration(s.uptime_s)}</dd>` : null}
        ${s.temp_c != null ? html`<dt>Temperature</dt><dd>${s.temp_c.toFixed(0)} °C</dd>` : null}
        ${s.load != null ? html`<dt>Load</dt><dd>${s.load.toFixed(2)}</dd>` : null}
        ${s.disk_free != null ? html`<dt>Free space</dt><dd>${size(s.disk_free)} of ${size(s.disk_total)}</dd>` : null}
      </dl>
      ${st.stage ? html`<div class="row-wrap">
        <button class="ghost" onClick=${act("restart", "Restart the stage host service? Screens reconnect by themselves.", "restart")}>Restart the service</button>
        <button class="ghost" onClick=${act("reboot", "Reboot the Pi? About a minute without the stage host.", "reboot")}>Reboot</button>
        <button class="danger" onClick=${act("poweroff", "Shut the Pi down? It stays off until it is unplugged and plugged in again.", "poweroff")}>Shut down</button>
      </div>` : html`<p class="small muted">System actions exist only on a stage host (es8ctl web --stage).</p>`}
    </section>`;
}

render(html`<${App} />`, document.getElementById("root"));

// Le bandeau commun des applis d'un hôte de scène : la même barre en haut de chaque page (Companion,
// Designer, Control, page de l'hôte), l'appli en cours en surbrillance, l'état de l'ES-8 à droite.
// Il ne paraît que si la page est servie par un hôte de scène (`/stage/state` répond) ; la Companion
// le cache sur ses écrans de scène. Sans dépendance : il marche dans n'importe quelle page.

const BASE = new URL("../", import.meta.url); // racine du serveur
export const APPS = [
  ["companion", "Companion"],
  ["designer", "Designer"],
  ["control", "Control"],
  ["host", "Stage host"],
];
const HEIGHT = 40;

/** L'ES-8 vu de l'hôte, pour une puce : [couleur du point (ok|warn|bad), texte]. */
export function es8Status(snap) {
  const m = (snap && snap.midi) || {};
  const c = ((snap && snap.check) || {}).state;
  if (!m.connected) return ["bad", "ES-8 not connected"];
  if (snap.edit) return ["warn", "ES-8 · edit mode"];
  if (c === "ok") return ["ok", "ES-8 · checked"];
  if (c === "mismatch") return ["warn", "ES-8 · differs"];
  if (c === "checking") return ["ok", "ES-8 · checking…"];
  return ["ok", "ES-8"];
}

const CSS = `
#stage-nav { position: sticky; top: 0; z-index: 60; height: ${HEIGHT}px; box-sizing: border-box; flex: none;
  display: flex; align-items: center; gap: 4px; padding: 0 10px; background: #08090b; border-bottom: 1px solid #26282d;
  font: 600 13px/1 "Barlow Condensed", "Arial Narrow", system-ui, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; }
#stage-nav[hidden] { display: none; }
#stage-nav .sn-brand { color: #6d737c; padding-right: 10px; white-space: nowrap; }
#stage-nav a { color: #9aa0a8; text-decoration: none; padding: 7px 10px; border-radius: 6px; white-space: nowrap; }
#stage-nav a:hover { color: #f1f2f4; background: #1b1c20; }
#stage-nav a[aria-current="page"] { color: #f1f2f4; background: #24262b; box-shadow: inset 0 -2px 0 #4f8fe6; }
#stage-nav .sn-grow { flex: 1; }
#stage-nav a.sn-es8 { display: inline-flex; align-items: center; gap: 7px; text-transform: none; letter-spacing: 0.02em;
  font: 500 13px/1 "Barlow", system-ui, sans-serif; }
#stage-nav .sn-dot { width: 8px; height: 8px; border-radius: 50%; background: #6d737c; flex: none; }
#stage-nav .sn-dot.ok { background: #3fc17a; } #stage-nav .sn-dot.warn { background: #f2a93b; } #stage-nav .sn-dot.bad { background: #e5484d; }
body.sn-on { display: flex; flex-direction: column; --stage-nav-h: ${HEIGHT}px; }
body.sn-on > #root { flex: 1 1 auto; min-height: 0; }
@media (max-width: 640px) {
  #stage-nav { gap: 0; padding: 0 4px; overflow-x: auto; }
  #stage-nav .sn-brand { display: none; }
  #stage-nav a { padding: 7px 7px; }
  #stage-nav .sn-es8-text { display: none; }
}`;

let bar = null;
let hidden = false;

/** Cache ou montre le bandeau (la Companion le cache sur ses écrans de scène). */
export function setNavHidden(on) {
  hidden = !!on;
  if (!bar) return;
  bar.hidden = hidden;
  document.body.classList.toggle("sn-on", !hidden);
}

function paint(snap) {
  const [dot, text] = snap ? es8Status(snap) : ["bad", "Stage host not answering"];
  bar.querySelector(".sn-dot").className = `sn-dot ${dot}`;
  bar.querySelector(".sn-es8-text").textContent = text;
  bar.querySelector(".sn-es8").title = text;
}

/** Pose le bandeau en haut de la page si un hôte de scène la sert ; `current` : companion|designer|control|host. */
export async function mountNav(current) {
  if (bar) return;
  let res;
  try { res = await fetch(new URL("stage/state", BASE), { cache: "no-store" }); } catch { return; }
  if (!res.ok || bar) return; // pas d'hôte de scène : pas de bandeau
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  bar = document.createElement("nav");
  bar.id = "stage-nav";
  bar.setAttribute("aria-label", "ES8 Stage");
  const link = ([id, label]) => `<a href="${new URL(`${id}/`, BASE).href}"${id === current ? ' aria-current="page"' : ""}>${label}</a>`;
  bar.innerHTML = `<span class="sn-brand">ES8 Stage</span>${APPS.map(link).join("")}<span class="sn-grow"></span>
    <a class="sn-es8" href="${new URL("companion/?view=menu", BASE).href}"><span class="sn-dot"></span><span class="sn-es8-text"></span></a>`;
  document.body.prepend(bar);
  setNavHidden(hidden);
  try { paint(await res.json()); } catch { /* état illisible : le flux suit */ }
  const events = new EventSource(new URL("stage/events", BASE));
  events.onmessage = (e) => { try { paint(JSON.parse(e.data)); } catch { /* message abîmé : le suivant le remplace */ } };
  events.onerror = () => paint(null);
}

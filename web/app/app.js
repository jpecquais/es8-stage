// ES8 Stage — une seule appli pour jouer et éditer (docs/unified-app.md). Deux postures de la même page :
// Jouer (la Companion : accueil, setlist, switches) et Éditer (le Designer tactile). ✎ passe en édition sur
// ce qui est joué ; « Done » enregistre et revient au jeu, à la même place. Les deux restent montées : la
// scène suit l'hôte pendant qu'on édite, et l'édition retrouve où elle en était.
//
// Chacune garde sa feuille de style, dans son propre shadow DOM (elles emploient les mêmes noms de classes).

import { html, render } from "../shared/vendor/preact-htm.module.js";
import { App as Companion } from "../companion/app.js";
import { App as Designer } from "../designer-touch/app.js";

/** Une feuille écrite pour une page entière, rendue valable dans un shadow DOM. */
const scoped = (css) => css
  .replace(/:root\b/g, ":host")
  .replace(/html,\s*body\s*\{/g, ":host {")
  .replace(/(^|[\s}])body(?=[\s.{])/g, "$1:host")
  .replace(/#root\b/g, ".mount");

async function mountPoint(id, cssUrl, hostCss) {
  const root = document.getElementById(id).attachShadow({ mode: "open" });
  const style = document.createElement("style");
  try { style.textContent = scoped(await (await fetch(cssUrl)).text()) + hostCss; } catch { style.textContent = hostCss; }
  const mount = document.createElement("div");
  mount.className = "mount";
  root.append(style, mount);
  return mount;
}

const state = { mode: "play", target: null, nonce: 0 };
let play = null;
let edit = null;
const toastBox = document.querySelector(".shell-toast");
let toastTimer = null;

function toast(text) {
  toastBox.textContent = text;
  toastBox.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastBox.hidden = true; }, text.length > 40 ? 6000 : 2600);
}

const shell = {
  playing: () => state.mode === "play",
  /** ✎ : l'édition s'ouvre sur `target` (voir designer-touch, App). */
  edit(target) {
    if (state.mode !== "edit") history.pushState({ es8: "edit" }, "", "#edit");
    show("edit", target);
  },
  /** « Done » : retour au jeu ; `message` dit ce que l'enregistrement a fait. */
  done(message) {
    if (history.state && history.state.es8 === "edit") history.back(); // popstate fait le reste
    else { history.replaceState(null, "", location.pathname + location.search); show("play"); }
    if (message) toast(message);
  },
};

async function show(mode, target) {
  state.mode = mode;
  if (mode === "edit") {
    state.target = target || state.target || { section: "setlists" };
    state.nonce += 1;
    if (!edit) edit = await mountPoint("edit", "../designer-touch/style.css", ":host { display: block; height: 100%; } .mount { height: 100%; }");
  }
  document.getElementById("play").hidden = mode !== "play";
  document.getElementById("edit").hidden = mode !== "edit";
  document.body.classList.toggle("editing", mode === "edit");
  paint();
}

function paint() {
  render(html`<${Companion} shell=${shell} />`, play);
  if (edit) render(html`<${Designer} shell=${shell} target=${state.target} nonce=${state.nonce} />`, edit);
}

// Le bouton retour (ou le geste) de l'iPad quitte l'édition, comme « Done » sans enregistrer : l'édition
// garde ses changements, on les retrouve en revenant.
window.addEventListener("popstate", () => { show(history.state && history.state.es8 === "edit" ? "edit" : "play"); });

(async () => {
  play = await mountPoint("play", "../companion/style.css", ":host { display: block; }");
  if (location.hash === "#edit") { history.replaceState({ es8: "edit" }, "", "#edit"); show("edit"); } else paint();
})();

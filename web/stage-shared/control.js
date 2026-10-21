// ES8 Control servi par ES Eight Stage : le serveur ajoute ce module avant celui de l'appli.
// Il branche le moteur sur l'hôte de scène (bridge.js) et, si la page passe par lui, affiche le
// mode édition dans un petit encart (écrire sur l'ES-8 demande de mettre la Companion en pause).
import { store } from "../shared/engine.js";
import { setEditMode } from "./bridge.js";

function render(state) {
  const host = state.stageHost;
  let box = document.getElementById("stage-host-box");
  if (!host) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement("div");
    box.id = "stage-host-box";
    box.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:50;display:flex;gap:8px;align-items:center;"
      + "padding:8px 12px;border-radius:10px;font:13px system-ui,sans-serif;color:#eee;background:#1b1c20e6;"
      + "border:1px solid #3a3d44;box-shadow:0 6px 18px #0006";
    box.innerHTML = `<label style="display:flex;gap:8px;align-items:center;cursor:pointer">
      <input type="checkbox"> <span><b>Stage host</b> · Edit mode <span class="sh-note" style="color:#9aa0a8"></span></span></label>`;
    box.querySelector("input").addEventListener("change", (e) => setEditMode(e.target.checked));
    document.body.append(box);
  }
  box.querySelector("input").checked = host.edit;
  box.querySelector(".sh-note").textContent = !host.connected ? "(ES-8 not connected)"
    : host.edit ? "(Companion paused, writing allowed)" : "(off: reading only)";
}

store.subscribe(render);

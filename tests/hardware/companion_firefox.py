"""Une Companion dans Firefox (sans fenêtre), MIDI autorisé, un show chargé ; écrit son état jusqu'à l'arrêt.

    uv run --with selenium python tests/hardware/companion_firefox.py <show.json> <state.json> [capture.png]

`es8ctl web --port 8771` doit tourner. Le MIDI de Firefox passe par un module d'autorisation ;
les préférences ci-dessous l'ouvrent pour l'automatisation. Arrêt : créer `<state.json>.stop`.
Avec tests/hardware/press_switches.py : essai de bout en bout sans personne à la pédale."""
import json, os, sys, time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
show = json.load(open(sys.argv[1])); state = sys.argv[2]
o = Options(); o.add_argument("--headless"); o.add_argument("--width=1180"); o.add_argument("--height=820")
for k, v in {"dom.webmidi.enabled": True, "dom.webmidi.gated": False, "midi.prompt.testing": True, "media.navigator.permission.disabled": True}.items():
    o.set_preference(k, v)
d = webdriver.Firefox(options=o)
d.get("http://localhost:8771/companion/")
d.execute_script("localStorage.setItem('es8companion', JSON.stringify({show: arguments[0], prefs: {view: 'switches'}}))", show)
# La première demande MIDI de la page est refusée sous automatisation ; une demande faite d'ici passe,
# puis l'autorisation vaut pour la page rechargée.
print("grant:", d.execute_async_script("""const done = arguments[arguments.length-1];
  navigator.requestMIDIAccess({sysex:false}).then(a => done([...a.outputs.values()].map(x=>x.name))).catch(e => done(String(e)));"""), flush=True)
d.get("http://localhost:8771/companion/")
time.sleep(3)
print("ports:", [e.text for e in d.find_elements(By.CSS_SELECTOR, ".chip.wide")], flush=True)
while not os.path.exists(state + ".stop"):
    try:
        lit = [e.find_element(By.CSS_SELECTOR, ".bigsw-label").text for e in d.find_elements(By.CSS_SELECTOR, ".bigsw.on")]
        now = d.find_element(By.CSS_SELECTOR, ".sw-now-name").text
        open(state, "w").write(json.dumps({"now": now, "lit": lit}))
    except Exception as exc:
        open(state, "w").write(json.dumps({"error": str(exc)[:200]}))
    if len(sys.argv) > 3 and not os.path.exists(state + ".shot"):
        d.save_screenshot(sys.argv[3]); open(state + ".shot", "w").write("1")
    time.sleep(0.3)
d.quit()

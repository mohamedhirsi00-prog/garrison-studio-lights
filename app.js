/* The Garrison Studio Lights, phone version (27 Oct 2026): the same scenes as the laptop program, over Web Bluetooth
   in Chrome on Android. Neewer TL60 "Infinity" protocol (from NeewerLite-Python): every command carries the tube's
   own Bluetooth address, which a browser cannot read, so each tube's address comes from config.js (made from the
   laptop's tubes.json) and the phone learns which device is which tube the first time it connects (it flashes the
   tube and asks). Settings changed on the phone are kept on the phone (localStorage). */
"use strict";

const SERVICE = "69400001-b5a3-f393-e0a9-e50e24dcca99";
const WRITE = "69400002-b5a3-f393-e0a9-e50e24dcca99";
const JOBS = { stage_left: "Stage left", stage_right: "Stage right", face: "Face light", off: "Not used" };
const SCENE_JOBS = ["stage_left", "stage_right", "face"];
const STAGE = ["stage_left", "stage_right"];
const FADE_MS = 2500, FADE_STEPS = 14;
const DARK = { mode: "hsi", hue: 0, sat: 0, bri: 0 };

// ---- saved settings -----------------------------------------------------------------------------------------
const store = {
  get(k, d) { try { const v = localStorage.getItem("tgs." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tgs." + k, JSON.stringify(v)); } catch {} },
};
let tubes = store.get("tubes", null) || structuredClone(window.TGS_CONFIG.tubes);   // [{id, name, mac, job}]
let scenes = store.get("scenes", null) || structuredClone(window.TGS_CONFIG.scenes);
const deviceMap = store.get("devices", {});                                          // browser device id -> tube id
const saveTubes = () => store.set("tubes", tubes);
const saveScenes = () => store.set("scenes", scenes);

// ---- the protocol ---------------------------------------------------------------------------------------------
const mac = (t) => t.mac.split(":").map((x) => parseInt(x, 16));
const ck = (b) => new Uint8Array([...b, b.reduce((a, x) => a + x, 0) & 255]);
const cmdPower = (t, on) => ck([120, 141, 8, ...mac(t), 129, on ? 1 : 0]);
const cmdHsi = (t, hue, sat, bri) => { hue = Math.round(((hue % 360) + 360) % 360); return ck([120, 143, 11, ...mac(t), 134, hue & 255, hue >> 8, Math.round(sat), Math.round(bri)]); };
const cmdCct = (t, bri, k) => ck([120, 144, 11, ...mac(t), 135, Math.round(bri), Math.max(25, Math.min(100, Math.round(k / 100))), 50, 4]);

// ---- connections: one GATT link per tube; writes are queued so they never overlap, and while a tube is busy only
// the newest look is kept (sliders and Music mode send many) ------------------------------------------------------
const links = {};          // tube id -> {device, char, busy, next}
const state = {};          // tube id -> {on, look}
let master = 1, baseLooks = {}, fading = false;

function live(id) { const l = links[id]; return !!(l && l.char && l.device.gatt.connected); }

async function write(id, data) {
  const l = links[id];
  if (!live(id)) return;
  if (l.busy) { l.next = data; return; }                 // keep only the newest
  l.busy = true;
  try {
    let d = data;
    while (d) {
      l.next = null;
      if (l.char.writeValueWithoutResponse) await l.char.writeValueWithoutResponse(d); else await l.char.writeValue(d);
      d = l.next;
    }
  } catch (e) { setTube(id, "lost the connection"); }
  finally { l.busy = false; }
}
async function writeNow(id, data) {                      // power and identify must not be dropped: wait for the queue
  for (let i = 0; i < 40 && links[id] && links[id].busy; i++) await sleep(25);
  return write(id, data);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tube = (id) => tubes.find((t) => t.id === id);

function lookCmd(id, look) {
  const t = tube(id), bri = Math.max(0, Math.min(100, Math.round(look.bri * master)));
  return look.mode === "hsi" ? cmdHsi(t, look.hue, look.sat, bri) : cmdCct(t, bri, look.kelvin);
}

async function attach(device, id) {
  const server = await device.gatt.connect();
  const svc = await server.getPrimaryService(SERVICE);
  const char = await svc.getCharacteristic(WRITE);
  links[id] = { device, char, busy: false, next: null };
  if (!device._tgsListening) {
    device.addEventListener("gattserverdisconnected", () => { const k = deviceMap[device.id]; if (k) setTube(k, "disconnected: tap Reconnect"); });
    device._tgsListening = true;
  }
  setTube(id, "connected");
}

async function connectTube(id) {
  if (!bluetoothOk()) return;
  const t = tube(id);
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: "NW-" }], optionalServices: [SERVICE] });
  } catch (e) { return; }                                // the chooser was closed
  try {
    setStatus(`Connecting to ${t.name}…`);
    await attach(device, id);
    await identify(id);
    if (!confirm(`Did ${t.name} just flash white?\n\nOK = yes, it's this one.\nCancel = no (tubes all look alike in the list: try again and pick another).`)) {
      device.gatt.disconnect(); delete links[id]; setTube(id, "not connected");
      setStatus("Try again and pick the other tube in the list."); return;
    }
    deviceMap[device.id] = id; store.set("devices", deviceMap);
    setStatus(`${t.name} connected.`);
    if (baseLooks[t.job] !== undefined) show(id, baseLooks[t.job]);
  } catch (e) { setTube(id, "couldn't connect (on? in range? phone app closed?)"); setStatus(""); }
}

async function reconnectAll() {
  if (!bluetoothOk()) return;
  if (!navigator.bluetooth.getDevices) { setStatus("Tap Connect on each tube."); return; }
  setStatus("Reconnecting…");
  const known = await navigator.bluetooth.getDevices();
  for (const device of known) {
    const id = deviceMap[device.id];
    if (!id || !tube(id) || live(id)) continue;
    try { await attach(device, id); } catch (e) { setTube(id, "not found: tap Connect"); }
  }
  setStatus("Ready.");
}

// ---- looks --------------------------------------------------------------------------------------------------
async function show(id, look) {
  if (!live(id)) return;
  const t = tube(id);
  if (!look || look.bri <= 0) { await writeNow(id, cmdPower(t, false)); state[id] = { on: false, look: { ...DARK } }; return; }
  if (!(state[id] && state[id].on)) await writeNow(id, cmdPower(t, true));
  await write(id, lookCmd(id, look));
  state[id] = { on: true, look: { ...look } };
}

async function fadeTo(scene) {
  fading = true;
  try {
    baseLooks = structuredClone(scene.looks);
    const ids = tubes.filter((t) => live(t.id)).map((t) => t.id);
    const target = Object.fromEntries(ids.map((id) => [id, scene.looks[tube(id).job] || null]));
    for (const id of ids) if (target[id] && target[id].bri > 0 && !(state[id] && state[id].on)) {
      await writeNow(id, cmdPower(tube(id), true)); state[id] = { on: true, look: { ...DARK } };
    }
    const start = Object.fromEntries(ids.map((id) => [id, (state[id] && state[id].look) || { ...DARK }]));
    for (let i = 1; i <= FADE_STEPS; i++) {
      const p = i / FADE_STEPS;
      for (const id of ids) {
        const old = start[id], neu = target[id] || { ...old, bri: 0 };
        let mix;
        if (neu.mode === old.mode) {
          mix = { mode: neu.mode, bri: old.bri + (neu.bri - old.bri) * p };
          if (neu.mode === "hsi") {
            const dh = ((neu.hue - old.hue + 540) % 360) - 180;
            mix.hue = old.hue + dh * p; mix.sat = old.sat + (neu.sat - old.sat) * p;
          } else mix.kelvin = old.kelvin + (neu.kelvin - old.kelvin) * p;
        } else mix = p <= 0.5 ? { ...old, bri: old.bri * (1 - 2 * p) } : { ...neu, bri: neu.bri * (2 * p - 1) };
        write(id, lookCmd(id, mix));
      }
      await sleep(FADE_MS / FADE_STEPS);
    }
    for (const id of ids) {
      const neu = target[id];
      if (!neu || neu.bri <= 0) { await writeNow(id, cmdPower(tube(id), false)); state[id] = { on: false, look: { ...DARK } }; }
      else { await write(id, lookCmd(id, neu)); state[id] = { on: true, look: { ...neu } }; }
    }
    setStatus(`Scene: ${scene.name}`);
  } finally { fading = false; }
}

async function identify(id) {
  if (!live(id)) return;
  const t = tube(id);
  await writeNow(id, cmdPower(t, true));
  for (let i = 0; i < 3; i++) { await writeNow(id, cmdHsi(t, 0, 0, 80)); await sleep(400); await writeNow(id, cmdHsi(t, 0, 0, 5)); await sleep(400); }
  const s = state[id];
  if (s && s.on) await writeNow(id, lookCmd(id, s.look)); else await writeNow(id, cmdPower(t, false));
}

function applyMaster() { for (const [id, s] of Object.entries(state)) if (s.on) write(id, lookCmd(id, s.look)); }

// ---- Music mode: the phone's microphone; level against the last few seconds (works at any volume), a pulse on
// strong low-end beats (40-180 Hz energy jumping above its average); stage tubes only, about 12 updates a second --
let music = null;
const STYLE_HINTS = {
  "Beat colours": "every beat jumps the stage tubes to the next colour",
  "Beat flash": "every beat flashes the stage tubes bright, then they drop",
  "Level bars": "the tubes as a bar meter: green, amber, red",
  "Colour wave": "colours flow from tube to tube, faster when louder",
  "Glow": "gentle: brightness follows the music, in the scene's colours",
};
function palette() {                                     // each stage tube's scene colour, and 35 / 70 degrees around it
  const hues = STAGE.map((j) => baseLooks[j]).filter((l) => l && l.mode === "hsi").map((l) => l.hue);
  return (hues.length ? hues : [30, 45]).flatMap((h) => [h, h + 35, h - 35, h + 70].map((x) => ((x % 360) + 360) % 360));
}
function musicLooks(style, level, pulse, beatNo, wave, t) {
  const out = {};
  if (style === "Level bars") {                          // every tube not set to Not used, in list order, as a bar meter
    const bars = tubes.filter((x) => x.job !== "off"), n = bars.length;
    const lit = level > 0.04 ? Math.min(n, Math.ceil(level * n * 1.35 - 0.1)) : 0;
    bars.forEach((x, i) => {
      const hue = 120 - 120 * (n > 1 ? i / (n - 1) : 0);  // green -> amber -> red
      if (i < lit) { const top = i === lit - 1 && pulse > 0.6; out[x.id] = { mode: "hsi", hue, sat: top ? 0 : 100, bri: top ? 85 : 65 }; }
      else out[x.id] = { mode: "hsi", hue, sat: 100, bri: 2 };
    });
    return out;
  }
  const pal = palette();
  tubes.filter((x) => STAGE.includes(x.job)).forEach((x, n) => {
    const base = baseLooks[x.job];
    if (!base) return;
    const sat = base.mode === "hsi" ? base.sat : 90;
    if (style === "Beat colours") out[x.id] = { mode: "hsi", hue: pal[(beatNo + n * 2) % pal.length], sat, bri: base.bri * (0.45 + 0.55 * level) + 30 * pulse };
    else if (style === "Beat flash") out[x.id] = base.mode === "hsi" ? { ...base, hue: pal[(beatNo + n) % pal.length], bri: 8 + 92 * pulse } : { ...base, bri: 8 + 92 * pulse };
    else if (style === "Colour wave") out[x.id] = { mode: "hsi", hue: (pal[0] + wave + n * 45) % 360, sat, bri: base.bri * (0.4 + 0.6 * level) + 20 * pulse };
    else {                                               // Glow
      const look = { ...base, bri: base.bri * (0.25 + 0.75 * level) + 25 * pulse };
      if (base.mode === "hsi") look.hue = (base.hue + 14 * Math.sin(2 * Math.PI * t / 20 + n * Math.PI) + 8 * level + 360) % 360;
      out[x.id] = look;
    }
  });
  return out;
}
async function startMusic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) { setStatus("Music mode needs the microphone: allow it when Chrome asks."); return false; }
  const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
  an.fftSize = 2048; src.connect(an);
  const td = new Float32Array(an.fftSize), fd = new Float32Array(an.frequencyBinCount);
  const binHz = ctx.sampleRate / an.fftSize, lo = Math.floor(40 / binHz), hi = Math.ceil(180 / binHz);
  let ref = 1e-4, env = 0, lowAvg = 1e-6, pulse = 0, t0 = performance.now(), lastBeat = 0, beats = 0, kicked = 0, wave = 0;
  const sent = {};
  const tick = () => {
    an.getFloatTimeDomainData(td);
    let sum = 0; for (const v of td) sum += v * v;
    const rms = Math.sqrt(sum / td.length);
    ref = Math.max(rms, ref * 0.992, 1e-4);
    const sens = document.getElementById("sens").value / 100;
    const target = Math.min(1, Math.pow(rms / ref, 0.8) * sens);
    env += (target - env) * (target > env ? 0.5 : 0.12);
    an.getFloatFrequencyData(fd);
    let low = 0; for (let i = lo; i <= hi; i++) low += Math.pow(10, fd[i] / 10);
    // a beat: the low end jumps well above its average, not near-silent, and at least 0.25 s since the last one
    const now = performance.now();
    if (low > lowAvg * 2.2 && rms > ref * 0.25 && now - lastBeat > 250) { lastBeat = now; beats++; }
    lowAvg += (low - lowAvg) * 0.08;
    pulse = lastBeat ? Math.exp(-(now - lastBeat) / 180) : 0;      // the beat's glow, fading over about 0.2 s
    const level = rms > 1e-4 ? env : 0;
    document.getElementById("meterBar").style.width = `${Math.round(level * 100)}%`;
    document.getElementById("beat").classList.toggle("on", pulse > 0.5);
    if (!fading) {
      const t = (now - t0) / 1000;
      wave = (wave + 1.5 + 9 * level + (beats !== kicked ? 25 : 0)) % 360; kicked = beats;
      const looks = musicLooks(document.getElementById("style").value, level, pulse, beats, wave, t);
      for (const [id, look] of Object.entries(looks)) {
        if (!live(id)) continue;
        look.bri = Math.max(2, Math.min(100, look.bri));
        const last = sent[id];
        if (!last || last.mode !== look.mode || Math.abs(last.bri - look.bri) >= 1 || Math.abs((last.hue || 0) - (look.hue || 0)) >= 1.5 || last.sat !== look.sat) {
          if (!(state[id] && state[id].on)) { write(id, cmdPower(tube(id), true)); state[id] = { on: true, look: { ...look } }; }
          write(id, lookCmd(id, look)); sent[id] = look;
        }
      }
    }
  };
  music = { stream, ctx, timer: setInterval(tick, 83) };
  return true;
}
function stopMusic() {
  if (!music) return;
  clearInterval(music.timer); music.stream.getTracks().forEach((t) => t.stop()); music.ctx.close(); music = null;
  document.getElementById("meterBar").style.width = "0"; document.getElementById("beat").classList.remove("on");
  for (const t of tubes) { const b = baseLooks[t.job]; if (b && state[t.id] && state[t.id].on) write(t.id, lookCmd(t.id, b)); }
}

// ---- colours on screen ------------------------------------------------------------------------------------------
function hsvHex(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60; s /= 100;
  const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((q) => Math.round((q + m) * 255).toString(16).padStart(2, "0")).join("");
}
const KELVIN = [[2500, [255, 161, 72]], [3200, [255, 187, 120]], [4500, [255, 219, 186]], [5600, [255, 238, 227]], [6500, [255, 249, 253]], [10000, [204, 219, 255]]];
function kelvinHex(k, v = 1) {
  for (let i = 1; i < KELVIN.length; i++) if (k <= KELVIN[i][0] || i === KELVIN.length - 1) {
    const [k0, c0] = KELVIN[i - 1], [k1, c1] = KELVIN[i], t = Math.max(0, Math.min(1, (k - k0) / (k1 - k0)));
    return "#" + c0.map((a, j) => Math.round((a + (c1[j] - a) * t) * v).toString(16).padStart(2, "0")).join("");
  }
}
const lookHex = (l, v = 1) => !l ? "#3a3f46" : l.mode === "hsi" ? hsvHex(l.hue, l.sat, v) : kelvinHex(l.kelvin, v);

// ---- the screen ---------------------------------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function setStatus(t) { $("status").textContent = t; }
const tubeState = {};
function setTube(id, text) { tubeState[id] = text; renderTubes(); }

function bluetoothOk() {
  if (!navigator.bluetooth) {
    showBanner("This phone's browser can't use Bluetooth. Open this page in Chrome on Android.");
    return false;
  }
  return true;
}
function showBanner(text, button) {
  const b = $("banner"); b.hidden = false; b.innerHTML = "";
  const s = document.createElement("span"); s.textContent = text; b.append(s);
  if (button) b.append(button);
}

function renderScenes() {
  const box = $("scenes"); box.innerHTML = "";
  scenes.forEach((sc) => {
    const b = document.createElement("button");
    b.textContent = sc.name; b.style.background = sc.button || "#2E75B6";
    let timer = null, held = false;
    b.addEventListener("pointerdown", () => { held = false; timer = setTimeout(() => { held = true; sceneMenu(sc); }, 600); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, () => clearTimeout(timer)));
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    b.addEventListener("click", () => { if (!held) fadeTo(sc); });
    box.append(b);
  });
}

function renderTubes() {
  const box = $("tubes"); box.innerHTML = "";
  tubes.forEach((t) => {
    const row = document.createElement("div"); row.className = "tube";
    const st = tubeState[t.id] || (live(t.id) ? "connected" : "not connected");
    row.innerHTML = `<div class="top"><span class="name"></span><select></select></div>
      <div class="state ${st === "connected" ? "ok" : ""}"></div>
      <div class="btns"><button data-a="connect">Connect</button><button data-a="identify">Identify</button><button data-a="rename">Rename</button></div>`;
    row.querySelector(".name").textContent = t.name;
    row.querySelector(".state").textContent = st;
    const sel = row.querySelector("select");
    for (const [k, v] of Object.entries(JOBS)) { const o = new Option(v, k, false, t.job === k); sel.append(o); }
    sel.addEventListener("change", () => { t.job = sel.value; saveTubes(); show(t.id, baseLooks[t.job] || null); setStatus(`${t.name} is now: ${JOBS[t.job]}.`); });
    row.querySelector('[data-a="connect"]').addEventListener("click", () => connectTube(t.id));
    row.querySelector('[data-a="identify"]').addEventListener("click", () => identify(t.id));
    row.querySelector('[data-a="rename"]').addEventListener("click", () => {
      const n = prompt("New name for this tube (e.g. Tube 1, Left, Lectern):", t.name);
      if (n && n.trim()) { t.name = n.trim(); saveTubes(); renderTubes(); }
    });
    box.append(row);
  });
}

// ---- press-and-hold menu, scene maker -------------------------------------------------------------------------
function sceneMenu(sc) {
  const d = $("sceneMenu"); $("menuTitle").textContent = sc.name;
  d.onclose = () => {
    if (d.returnValue === "edit") openMaker(sc);
    if (d.returnValue === "delete" && confirm(`Delete the scene “${sc.name}”?`)) { scenes = scenes.filter((s) => s !== sc); saveScenes(); renderScenes(); }
  };
  d.showModal();
}

let makerVars = {}, makerOriginal = null;
function openMaker(scene) {
  makerOriginal = scene ? scene.name : null;
  $("sceneName").value = scene ? scene.name : "";
  const start = scene ? scene.looks : Object.fromEntries(tubes.filter((t) => state[t.id] && state[t.id].on).map((t) => [t.job, state[t.id].look]));
  const box = $("jobPanels"); box.innerHTML = ""; makerVars = {};
  for (const job of SCENE_JOBS) {
    const l = start[job];
    const v = makerVars[job] = { mode: l ? l.mode : "off", hue: l && l.hue !== undefined ? l.hue : 30, sat: l && l.sat !== undefined ? l.sat : 90,
                                 kelvin: l && l.kelvin ? l.kelvin : 3200, bri: l ? l.bri : 40 };
    const doing = tubes.filter((t) => t.job === job).map((t) => t.name).join(", ");
    const p = document.createElement("div"); p.className = "job";
    p.innerHTML = `<div class="head"><strong>${JOBS[job]}</strong><span class="seg">
        <button type="button" data-m="hsi">Colour</button><button type="button" data-m="cct">White</button><button type="button" data-m="off">Off</button></span>
        <span class="swatch"></span><span class="doing">${doing ? "(" + doing + ")" : "(no tube on this job now; saved for later)"}</span></div>
      <div class="hsi"><div class="hue"></div>
        <label class="row"><span>Colour</span><input type="range" min="0" max="359" data-k="hue"></label>
        <label class="row"><span>Strength</span><input type="range" min="0" max="100" data-k="sat"></label></div>
      <div class="cct"><label class="row"><span>Warm ↔ cool</span><input type="range" min="2500" max="10000" step="100" data-k="kelvin"></label></div>
      <div class="bri"><label class="row"><span>Brightness</span><input type="range" min="1" max="100" data-k="bri"></label></div>`;
    p.querySelectorAll("input[data-k]").forEach((inp) => { inp.value = v[inp.dataset.k]; inp.addEventListener("input", () => { v[inp.dataset.k] = +inp.value; refreshJob(job, p); }); });
    p.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => { v.mode = b.dataset.m; refreshJob(job, p); }));
    box.append(p); refreshJob(job, p, true);
  }
  $("maker").showModal();
}
function makerLook(job) {
  const v = makerVars[job];
  if (v.mode === "off") return null;
  return v.mode === "hsi" ? { mode: "hsi", hue: v.hue, sat: v.sat, bri: v.bri } : { mode: "cct", kelvin: v.kelvin, bri: v.bri };
}
function refreshJob(job, p, quiet) {
  const v = makerVars[job];
  p.querySelectorAll("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === v.mode));
  p.querySelector(".hsi").hidden = v.mode !== "hsi"; p.querySelector(".cct").hidden = v.mode !== "cct"; p.querySelector(".bri").hidden = v.mode === "off";
  const look = makerLook(job);
  p.querySelector(".swatch").style.background = look ? lookHex(look, 0.35 + 0.65 * look.bri / 100) : "#000";
  if (!quiet && $("live").checked) tubes.filter((t) => t.job === job).forEach((t) => show(t.id, look));
}
$("copyLR").addEventListener("click", () => {
  makerVars.stage_right = { ...makerVars.stage_left };
  const panels = $("jobPanels").children, p = panels[SCENE_JOBS.indexOf("stage_right")];
  p.querySelectorAll("input[data-k]").forEach((inp) => { inp.value = makerVars.stage_right[inp.dataset.k]; });
  refreshJob("stage_right", p);
});
$("saveScene").addEventListener("click", () => {
  const name = $("sceneName").value.trim();
  if (!name) { alert("Give the scene a name first."); return; }
  const looks = {}; for (const j of SCENE_JOBS) { const l = makerLook(j); if (l) looks[j] = l; }
  const first = looks.stage_left || Object.values(looks)[0];
  const scene = { name, button: lookHex(first, 0.55), looks };
  const i = scenes.findIndex((s) => s.name === name);
  if (i >= 0) {
    if (name !== makerOriginal && !confirm(`There is already a scene called “${name}”. Replace it?`)) return;
    scenes[i] = scene;
  } else {
    const off = scenes.findIndex((s) => s.name === "Off");
    scenes.splice(off >= 0 ? off : scenes.length, 0, scene);
  }
  makerOriginal = name; saveScenes(); renderScenes(); setStatus(`Saved the scene “${name}”.`);
});

// ---- add a tube ---------------------------------------------------------------------------------------------------
$("addTube").addEventListener("click", () => {
  const d = $("addDialog"); $("newName").value = `Tube ${String.fromCharCode(65 + tubes.length)}`; $("newMac").value = "";
  d.onclose = () => {
    if (d.returnValue !== "add") return;
    const m = $("newMac").value.trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(m)) { alert("That address doesn't look right: six pairs like FA:6C:0D:2B:E0:DE."); return; }
    const used = new Set(tubes.map((t) => t.job));
    const job = ["stage_left", "stage_right", "face"].find((j) => !used.has(j)) || "stage_left";
    let n = 1; while (tubes.some((t) => t.id === `t${n}`)) n++;
    tubes.push({ id: `t${n}`, name: $("newName").value.trim() || `Tube ${n}`, mac: m, job });
    saveTubes(); renderTubes(); setStatus("Added. Tap Connect on it.");
  };
  d.showModal();
});

// ---- start ----------------------------------------------------------------------------------------------------------
$("newScene").addEventListener("click", () => openMaker(null));
$("connectAll").addEventListener("click", reconnectAll);
$("master").addEventListener("input", (e) => { $("masterOut").value = e.target.value; master = e.target.value / 100; applyMaster(); });
$("sens").addEventListener("input", (e) => { $("sensOut").value = e.target.value; });
$("style").addEventListener("change", (e) => { $("styleHint").textContent = STYLE_HINTS[e.target.value]; if (music) setStatus(`Music mode: ${e.target.value}.`); });
$("musicBtn").addEventListener("click", async () => {
  const b = $("musicBtn");
  if (music) { stopMusic(); b.textContent = "Music mode: OFF"; b.classList.remove("on"); setStatus("Music mode off."); return; }
  if (await startMusic()) { b.textContent = "Music mode: ON"; b.classList.add("on"); setStatus("Music mode: listening through the microphone."); }
});

renderScenes(); renderTubes();
if (bluetoothOk()) {
  navigator.bluetooth.getAvailability().then((ok) => {
    if (!ok) showBanner("Bluetooth is turned off. Turn on Bluetooth in your phone's settings, then tap Reconnect.");
  }).catch(() => {});
  navigator.bluetooth.addEventListener?.("availabilitychanged", (e) => { if (e.value) { $("banner").hidden = true; reconnectAll(); } else showBanner("Bluetooth is turned off. Turn it on in your phone's settings."); });
  reconnectAll();
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

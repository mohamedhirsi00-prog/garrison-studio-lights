/* The XR18 link, the same as the laptop's mixer.py (28 Oct 2026). OSC over UDP port 10024, sent and received by
   the Android app (native.js); a plain browser can't, so there the Sound tab says to use the app.
   Only what an event needs: the four snapshots, and a level and a mute for Mic A, Mic B, the Announcer, the Music
   and the Main PA. Levels never go above 0 dB (fader 0.75) from here. */
"use strict";
const XR_PORT = 10024;
const STRIPS = [   // key, name, OSC path, which /meters/1 values are its level
  ["mic_a", "Mic A", "/ch/01", [0]], ["mic_b", "Mic B", "/ch/02", [1]], ["announcer", "Announcer", "/ch/03", [2]],
  ["music", "Music", "/rtn/aux", [16, 17]], ["main", "Main PA", "/lr", [36, 37]],
];
const SNAPSHOTS = [[1, "Nasheed", "performers only, Announcer muted"], [2, "Announcements", "all mics set for speech"],
  [3, "Nasheed + Announcer", "the usual one"], [4, "Qari", "Qur'an: longer hall, no music"]];
const FADER_TOP = 0.75;

// ---- OSC --------------------------------------------------------------------------------------------------------
const enc = new TextEncoder(), dec = new TextDecoder();
function oscPad(bytes) { const out = new Uint8Array(Math.floor(bytes.length / 4) * 4 + 4); out.set(bytes); return out; }
function osc(address, ...args) {
  let tags = ",", parts = [];
  for (const a of args) {
    if (Number.isInteger(a) && !(a instanceof Float)) { tags += "i"; const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, a); parts.push(b); }
    else if (a instanceof Float || typeof a === "number") { tags += "f"; const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, +a); parts.push(b); }
    else { tags += "s"; parts.push(oscPad(enc.encode(String(a)))); }
  }
  const all = [oscPad(enc.encode(address)), oscPad(enc.encode(tags)), ...parts];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let i = 0; for (const p of all) { out.set(p, i); i += p.length; }
  return out;
}
class Float { constructor(v) { this.v = v; } valueOf() { return this.v; } }
const f32 = (v) => new Float(v);
function oscParse(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = b.indexOf(0); const address = dec.decode(b.subarray(0, end));
  let i = (Math.floor(end / 4) + 1) * 4;
  if (i >= b.length || b[i] !== 44) return [address, []];
  end = b.indexOf(0, i); const tags = dec.decode(b.subarray(i + 1, end));
  i = (Math.floor(end / 4) + 1) * 4;
  const out = [];
  for (const t of tags) {
    if (t === "i") { out.push(dv.getInt32(i)); i += 4; }
    else if (t === "f") { out.push(dv.getFloat32(i)); i += 4; }
    else if (t === "s") { end = b.indexOf(0, i); out.push(dec.decode(b.subarray(i, end))); i = (Math.floor(end / 4) + 1) * 4; }
    else if (t === "b") { const n = dv.getInt32(i); out.push(b.subarray(i + 4, i + 4 + n)); i += 4 + Math.ceil(n / 4) * 4; }
  }
  return [address, out];
}
function meterLevels(blob) {                              // /meters/1: a count, then levels in 1/256 dB (little-endian)
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength), n = dv.getInt32(0, true), out = [];
  for (let k = 0; k < n; k++) out.push(dv.getInt16(4 + 2 * k, true) / 256);
  return out;
}
function faderDb(pos) {                                   // the Behringer fader curve: 0.75 = 0 dB, 0 = off
  if (pos <= 0) return null;
  if (pos < 0.0625) return pos * 480 - 90;
  if (pos < 0.25) return pos * 160 - 70;
  if (pos < 0.5) return pos * 80 - 50;
  return pos * 40 - 30;
}
function dbText(pos) { const db = faderDb(pos); return db === null || db <= -89.5 ? "off" : Math.abs(db) < 0.5 ? "0 dB" : `${db > 0 ? "+" : ""}${Math.round(db)} dB`; }

// ---- the link: finds the mixer, keeps it alive, reconnects ------------------------------------------------------
const mixer = {
  ip: (() => { try { return localStorage.getItem("tgs.mixerIp"); } catch { return null; } })(),
  connected: false, held: false, values: {}, lastHeard: 0, lastMeters: 0, listeners: [],
  on(fn) { this.listeners.push(fn); },
  say(...msg) { for (const fn of this.listeners) fn(...msg); },
  available() { return !!(window.TGSNative && TGSNative.android); },
  send(address, ...args) { if (this.ip && this.available()) TGSNative.udpSend(this.ip, XR_PORT, osc(address, ...args)); },
  start() {
    if (!this.available()) { this.say("state", false, "needs the Android app"); return; }
    TGSNative.onUdp((bytes, ip) => { try { this.heard(bytes, ip); } catch { /* a message the app doesn't need */ } });
    let lastFind = 0, lastRenew = 0;
    setInterval(() => {
      const now = Date.now();
      if (this.held) return;
      if (this.connected && now - this.lastHeard > 5000) { this.connected = false; this.say("state", false, "Lost the mixer: looking again…"); }
      if (!this.connected && now - lastFind > 3000) {
        lastFind = now;
        const targets = new Set([this.ip, "192.168.1.1", TGSNative.wifiBroadcast(), "255.255.255.255"].filter(Boolean));
        for (const t of targets) TGSNative.udpSend(t, XR_PORT, osc("/xinfo"));    // saved address, its own Wi-Fi, this Wi-Fi
      }
      if (this.connected && now - lastRenew > 8000) { lastRenew = now; this.subscribe(); }
    }, 500);
  },
  subscribe() { this.send("/xremote"); this.send("/meters", "/meters/1"); },
  async refresh() {
    for (const [, , p] of STRIPS) for (const leaf of ["/mix/fader", "/mix/on", "/config/name"]) { this.send(p + leaf); await sleep(5); }
    this.send("/-snap/index");
  },
  heard(bytes, ip) {
    this.lastHeard = Date.now();
    const [address, out] = oscParse(bytes);
    if (address === "/meters/1") {
      if (this.lastHeard - this.lastMeters >= 80) { this.lastMeters = this.lastHeard; this.say("meters", meterLevels(out[0])); }
      return;
    }
    if (address === "/xinfo") {
      if (!this.connected) {
        this.connected = true; this.ip = ip;
        try { localStorage.setItem("tgs.mixerIp", ip); } catch {}
        this.say("state", true, `${out[2] || "XR18"} at ${ip}`);
        this.subscribe(); this.refresh();
      }
      return;
    }
    if (out.length && !(out[0] instanceof Uint8Array)) { this.values[address] = out[0]; this.say("value", address, out[0]); }
  },
  setLevel(key, pos) {
    const p = STRIPS.find((s) => s[0] === key)[2];
    pos = Math.min(FADER_TOP, Math.max(0, pos));
    this.values[p + "/mix/fader"] = pos; this.send(p + "/mix/fader", f32(pos));
  },
  setOn(key, on) {
    const p = STRIPS.find((s) => s[0] === key)[2];
    this.values[p + "/mix/on"] = on ? 1 : 0; this.send(p + "/mix/on", on ? 1 : 0); this.say("value", p + "/mix/on", on ? 1 : 0);
  },
  loadSnapshot(n) {
    this.send("/-snap/load", n); this.values["/-snap/index"] = n; this.say("value", "/-snap/index", n);
    setTimeout(() => this.refresh(), 2500);                // a load takes a moment; then read everything back
  },
  reconnect() { this.held = false; this.connected = false; this.say("state", false, "Looking for the mixer…"); },
  disconnect() { this.held = true; this.connected = false; this.say("state", false, "Disconnected (tap Reconnect)"); },
};

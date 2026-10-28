/* Inside the Android app (The Garrison Studio Control), the phone's own Bluetooth and network take the place of
   Web Bluetooth (28 Oct 2026). Android connects straight to each light by its address, so there is no device list to
   pick from; it also sends and receives the XR18's network messages (see mixer.js). In a plain browser this file
   does nothing and the page uses Web Bluetooth as before. */
"use strict";
(function () {
  const B = window.TGSNativeBridge;
  if (!B) return;
  const pending = {}, devices = {}, udpHandlers = [];
  let next = 0;
  const call = (fn, ...args) => new Promise((resolve, reject) => {
    const id = ++next;
    pending[id] = { resolve, reject };
    B[fn](...args, id);
  });
  const toB64 = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // one stand-in "device" per light, shaped like Web Bluetooth's, so the rest of the page needs no changes
  function device(mac) {
    mac = mac.toUpperCase();
    if (devices[mac]) return devices[mac];
    const d = new EventTarget();
    d.id = mac;
    const char = { writeValueWithoutResponse: (data) => call("bleWrite", mac, toB64(data)) };
    d.gatt = {
      connected: false,
      async connect() {
        await call("bleConnect", mac);
        d.gatt.connected = true;
        return { getPrimaryService: async () => ({ getCharacteristic: async () => char }) };
      },
      disconnect() { d.gatt.connected = false; B.bleDisconnect(mac); },
    };
    devices[mac] = d;
    return d;
  }

  window.TGSNative = {
    android: true,
    _done(id, ok, data) {
      const p = pending[id];
      if (!p) return;
      delete pending[id];
      if (ok) p.resolve(data); else p.reject(new Error(data || "failed"));
    },
    _lost(mac) {                                           // a light dropped: the page reconnects it by itself
      const d = devices[mac];
      if (d) { d.gatt.connected = false; d.dispatchEvent(new Event("gattserverdisconnected")); }
    },
    _permissions() { if (typeof reconnectAll === "function") reconnectAll(false); },
    _udp(b64, ip) { const bytes = fromB64(b64); for (const h of udpHandlers) h(bytes, ip); },
    device,
    async scan(seconds) { return JSON.parse(await call("bleScan", seconds)); },
    onUdp(handler) { udpHandlers.push(handler); B.udpStart(); },
    udpSend(host, port, bytes) { B.udpSend(host, port, toB64(bytes)); },
    wifiBroadcast() { return B.wifiBroadcast(); },
  };

  // what the page calls navigator.bluetooth: every light in the list, by its address
  const bt = new EventTarget();
  bt.getAvailability = async () => B.bleEnabled();
  bt.getDevices = async () => {
    const list = (typeof tubes !== "undefined" ? tubes : []).filter((t) => t.mac);
    for (const t of list) deviceMap[t.mac.toUpperCase()] = t.id;
    return list.map((t) => device(t.mac));
  };
  bt.requestDevice = async () => { throw new Error("not used in the app"); };
  Object.defineProperty(navigator, "bluetooth", { value: bt, configurable: true });
  let wasOn = null;                                        // Bluetooth switched off or on while the app is open
  setInterval(() => {
    const on = B.bleEnabled();
    if (wasOn !== null && on !== wasOn) { const e = new Event("availabilitychanged"); e.value = on; bt.dispatchEvent(e); }
    wasOn = on;
  }, 2000);
})();

/* Blarf OS P2a: Secure Vault. Logins, notes and API keys for Kyle's projects, encrypted on this device.
   Crypto: a random 256-bit master key encrypts the items (AES-GCM, fresh 12-byte IV each save). The master key is
   wrapped by a key derived from the passcode (PBKDF2-SHA256, 600k rounds, 16-byte salt) and, optionally, by a key
   derived (HKDF) from a WebAuthn passkey PRF output (Face ID). Nothing here is ever put in a prompt, a thread or a log;
   Blarf only sees item NAMES Kyle explicitly shares. Provider-key migration is opt-in: keys are decrypted into memory at
   unlock and the stores only ever hold "" for them (see save() in index.html). */
(function () {
  "use strict";
  var doc = document, C = null;
  var ITER = 600000, MIN_ITER = 310000, AAD_MK = "blarf-vault-mk-v1", AAD_DATA = "blarf-vault-data-v1";
  var FIELD_LABEL = { apiKey: "AI provider key", oaiKey: "OpenAI key", elevenKey: "ElevenLabs key", fishKey: "Fish Audio key" };
  var TYPES = { login: { emoji: "🔑", label: "Login" }, apikey: { emoji: "🧬", label: "API key" }, note: { emoji: "🗒️", label: "Secure note" } };

  /* ---------- state (secrets live only in this closure, only while unlocked) ---------- */
  var V = { meta: null, data: null, loaded: false, mkRaw: null, key: null, items: null, last: Date.now(), hiddenAt: 0, view: "list", edit: null, reveal: {}, pendingOk: null, pendingCancel: null, importBox: null, armed: null, q: "", note: "" };

  /* ---------- small helpers ---------- */
  function subtle() { return window.crypto && window.crypto.subtle; }
  function rand(n) { var u = new Uint8Array(n); window.crypto.getRandomValues(u); return u; }
  function enc(s) { return new TextEncoder().encode(s); }
  function dec(b) { return new TextDecoder().decode(b); }
  function b64(buf) { var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), s = ""; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
  function unb64(s) { var b = atob(String(s || "")), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(t) { if (C) C.toast(t); }
  function S() { return C ? C.S : {}; }
  function cfg() {
    var s = S(); if (!s.vaultCfg || typeof s.vaultCfg !== "object") s.vaultCfg = {};
    var c = s.vaultCfg;
    if ([1, 5, 15, 60].indexOf(c.lockMin) < 0) c.lockMin = 5;
    if (typeof c.lockHidden !== "boolean") c.lockHidden = true;
    c.faceId = !!(V.meta && V.meta.bio);
    return c;
  }
  function vkeys() { var s = S(); if (!Array.isArray(s.vaultKeys)) s.vaultKeys = []; return s.vaultKeys; }
  function uid() { return "v" + Date.now().toString(36) + b64(rand(6)).replace(/[^a-z0-9]/gi, "").slice(0, 6); }
  function unlocked() { return !!(V.key && V.items); }

  /* ---------- crypto ---------- */
  function kekFromPass(pass, salt, iter) {
    return subtle().importKey("raw", enc(String(pass).normalize("NFKC")), "PBKDF2", false, ["deriveKey"]).then(function (base) {
      return subtle().deriveKey({ name: "PBKDF2", salt: salt, iterations: Math.max(MIN_ITER, iter || ITER), hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function kekFromPrf(prf, salt) {
    return subtle().importKey("raw", prf, "HKDF", false, ["deriveKey"]).then(function (base) {
      return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt, info: enc("blarf-vault-faceid-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    });
  }
  function seal(key, bytes, aad) {
    var iv = rand(12);
    return subtle().encrypt({ name: "AES-GCM", iv: iv, additionalData: enc(aad) }, key, bytes).then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  function unseal(key, box, aad) {
    return subtle().decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: enc(aad) }, key, unb64(box.ct)).then(function (b) { return new Uint8Array(b); });
  }
  function mkKey(raw) { return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }

  /* ---------- storage: IndexedDB "blarfVault" (ciphertext only), localStorage fallback ---------- */
  var DB = (function () {
    var db = null, state = 0, waiters = [];
    function ready(cb) {
      if (state) return cb();
      waiters.push(cb);
      if (waiters.length > 1) return;
      var done = function (st) { state = st; var w = waiters; waiters = []; w.forEach(function (f) { f(); }); };
      try {
        var rq = indexedDB.open("blarfVault", 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore("kv"); };
        rq.onsuccess = function () { db = rq.result; done(1); };
        rq.onerror = function () { done(-1); };
        setTimeout(function () { if (!state) done(-1); }, 3000);
      } catch (e) { done(-1); }
    }
    function get(k) {
      return new Promise(function (res) {
        ready(function () {
          if (state !== 1) { try { res(JSON.parse(localStorage.getItem("blarf-vault-" + k) || "null")); } catch (e) { res(null); } return; }
          try { var r = db.transaction("kv", "readonly").objectStore("kv").get(k); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; } catch (e) { res(null); }
        });
      });
    }
    function put(k, v) {
      return new Promise(function (res, rej) {
        ready(function () {
          if (state !== 1) { try { if (v == null) localStorage.removeItem("blarf-vault-" + k); else localStorage.setItem("blarf-vault-" + k, JSON.stringify(v)); res(); } catch (e) { rej("Couldn't save the vault on this device."); } return; }
          try {
            var tx = db.transaction("kv", "readwrite"), os = tx.objectStore("kv");
            if (v == null) os["delete"](k); else os.put(v, k);
            tx.oncomplete = function () { res(); }; tx.onerror = function () { rej("Couldn't save the vault on this device."); };
          } catch (e) { rej("Couldn't save the vault on this device."); }
        });
      });
    }
    return { get: get, put: put };
  })();
  function loadAll() {
    return Promise.all([DB.get("meta"), DB.get("data")]).then(function (r) {
      V.meta = r[0] && r[0].wrap ? r[0] : null; V.data = r[1] || null; V.loaded = true;
      /* keys marked as vault-held but no vault on this device (storage wiped): stop pretending */
      if (!V.meta && vkeys().length) { S().vaultKeys = []; if (C) { C.save(); C.repaintKeys(); } toast("Secure Vault data is gone from this device. Re-enter your API keys in Settings."); }
      paintSettings();
    });
  }
  function persist() {
    if (!unlocked()) return Promise.reject("Vault is locked.");
    var items = V.items.slice();
    return seal(V.key, enc(JSON.stringify({ items: items })), AAD_DATA).then(function (box) {
      V.data = box; return DB.put("data", box);
    });
  }

  /* ---------- throttle wrong passcodes ---------- */
  function fails() { try { return JSON.parse(localStorage.getItem("blarf-vault-fails") || "null") || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; } }
  function setFails(f) { try { localStorage.setItem("blarf-vault-fails", JSON.stringify(f)); } catch (e) {} }

  /* ---------- setup / unlock / lock ---------- */
  function setup(pass) {
    if (!subtle()) return Promise.reject("This browser has no WebCrypto here. Open Blarf from your Home Screen (https).");
    if (String(pass).length < 6) return Promise.reject("Use at least 6 characters.");
    var raw = rand(32), salt = rand(16);
    return kekFromPass(pass, salt, ITER).then(function (kek) { return seal(kek, raw, AAD_MK); }).then(function (wrap) {
      return mkKey(raw).then(function (key) {
        V.meta = { v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), wrap: wrap, bio: null, created: new Date().toISOString() };
        V.mkRaw = raw; V.key = key; V.items = [];
        return DB.put("meta", V.meta).then(persist).then(function () { onUnlocked(); });
      });
    });
  }
  function openWith(raw) {
    return mkKey(raw).then(function (key) {
      var items = [];
      var go = V.data ? unseal(key, V.data, AAD_DATA).then(function (b) { var o = JSON.parse(dec(b)); items = Array.isArray(o.items) ? o.items : []; }) : Promise.resolve();
      return go.then(function () { V.mkRaw = raw; V.key = key; V.items = items; onUnlocked(); });
    });
  }
  function unlockPass(pass) {
    if (!V.meta) return Promise.reject("No vault yet.");
    var f = fails(), now = Date.now();
    if (f.until > now) return Promise.reject("Too many tries. Wait " + Math.ceil((f.until - now) / 1000) + " s.");
    return kekFromPass(pass, unb64(V.meta.salt), V.meta.iter).then(function (kek) { return unseal(kek, V.meta.wrap, AAD_MK); }).then(function (raw) {
      setFails({ n: 0, until: 0 });
      return openWith(raw);
    }, function () {
      f.n++; if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60000, 30000 * Math.pow(2, f.n - 5));
      setFails(f);
      throw f.until > Date.now() ? "Wrong passcode. Locked out for " + Math.ceil((f.until - Date.now()) / 1000) + " s." : "Wrong passcode.";
    });
  }
  function onUnlocked() {
    V.last = Date.now(); V.view = "list"; V.reveal = {};
    /* provider keys that live in the vault come back into memory only */
    var s = S();
    vkeys().forEach(function (f) { var it = V.items.filter(function (x) { return x.field === f; })[0]; if (it) s[f] = it.secret || ""; });
    if (C) C.repaintKeys();
    paintSettings(); render();
    var ok = V.pendingOk; V.pendingOk = null; V.pendingCancel = null;
    if (ok) { setSheet(false); setTimeout(ok, 0); }
  }
  function lock(quiet) {
    if (V.mkRaw) { try { V.mkRaw.fill(0); } catch (e) {} }
    var was = unlocked();
    V.mkRaw = null; V.key = null; V.items = null; V.reveal = {}; V.edit = null; V.view = "list";
    var s = S();
    vkeys().forEach(function (f) { s[f] = ""; });
    if (C && was) C.repaintKeys();
    paintSettings(); render();
    if (was && !quiet) toast("🔒 Vault locked");
  }

  /* ---------- Face ID: passkey with the PRF extension; feature-detected, passcode always works ---------- */
  function bioCapable() {
    if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) return Promise.resolve(false);
    var p = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : Promise.resolve(false);
    return Promise.resolve(p).then(function (ok) {
      if (!ok) return false;
      if (PublicKeyCredential.getClientCapabilities) {
        return PublicKeyCredential.getClientCapabilities().then(function (c) { return !c || c["extension:prf"] !== false; }, function () { return true; });
      }
      return true;
    }, function () { return false; });
  }
  function prfGet(id, salt) {
    return navigator.credentials.get({ publicKey: { challenge: rand(32), rpId: location.hostname, allowCredentials: [{ type: "public-key", id: id }], userVerification: "required", timeout: 60000, extensions: { prf: { eval: { first: salt } } } } })
      .then(function (a) {
        var r = a && a.getClientExtensionResults ? a.getClientExtensionResults() : {};
        var out = r && r.prf && r.prf.results && r.prf.results.first;
        if (!out) throw "Face ID unlock isn't supported in this browser. Use your passcode.";
        return new Uint8Array(out);
      });
  }
  function enableBio() {
    if (!unlocked() || !V.mkRaw) return Promise.reject("Unlock the vault first.");
    var salt = rand(32), user = rand(16);
    return navigator.credentials.create({ publicKey: {
      rp: { name: "Blarf Vault", id: location.hostname }, user: { id: user, name: "Blarf Vault", displayName: "Blarf Vault" }, challenge: rand(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
      timeout: 60000, attestation: "none", extensions: { prf: { eval: { first: salt } } } } })
      .then(function (cred) {
        var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
        if (!ext.prf || ext.prf.enabled === false) throw "This iPhone/browser can't do Face ID unlock for web apps yet (no passkey PRF). Passcode it is.";
        var first = ext.prf.results && ext.prf.results.first;
        return (first ? Promise.resolve(new Uint8Array(first)) : prfGet(cred.rawId, salt)).then(function (prf) {
          return kekFromPrf(prf, salt).then(function (kek) { return seal(kek, V.mkRaw, AAD_MK); }).then(function (wrap) {
            V.meta.bio = { cred: b64(cred.rawId), salt: b64(salt), wrap: wrap, added: new Date().toISOString() };
            return DB.put("meta", V.meta);
          });
        });
      }, function (e) { throw typeof e === "string" ? e : e && e.name === "NotAllowedError" ? "Face ID was cancelled." : "Couldn't set up Face ID here."; })
      .then(function () { cfg(); if (C) C.save(); paintSettings(); });
  }
  function unlockBio() {
    if (!V.meta || !V.meta.bio) return Promise.reject("Face ID isn't set up.");
    var b = V.meta.bio;
    return prfGet(unb64(b.cred), unb64(b.salt)).then(function (prf) {
      return kekFromPrf(prf, unb64(b.salt)).then(function (kek) { return unseal(kek, b.wrap, AAD_MK); });
    }).then(openWith, function (e) { throw typeof e === "string" ? e : e && e.name === "NotAllowedError" ? "Face ID was cancelled." : "Face ID didn't unlock it. Use your passcode."; });
  }
  function disableBio() {
    if (!V.meta) return Promise.resolve();
    V.meta.bio = null;
    return DB.put("meta", V.meta).then(function () { cfg(); if (C) C.save(); paintSettings(); });
  }
  function changePass(pass) {
    if (!unlocked() || !V.mkRaw) return Promise.reject("Unlock first.");
    if (String(pass).length < 6) return Promise.reject("Use at least 6 characters.");
    var salt = rand(16);
    return kekFromPass(pass, salt, ITER).then(function (kek) { return seal(kek, V.mkRaw, AAD_MK); }).then(function (wrap) {
      V.meta.salt = b64(salt); V.meta.iter = ITER; V.meta.wrap = wrap; return DB.put("meta", V.meta);
    });
  }

  /* ---------- backup ---------- */
  function exportBackup() {
    if (!unlocked()) return Promise.reject("Unlock first.");
    return persist().then(function () {
      var o = { format: "blarf-vault-backup", v: 1, created: new Date().toISOString(), kdf: V.meta.kdf, iter: V.meta.iter, salt: V.meta.salt, wrap: V.meta.wrap, data: V.data };
      var name = "blarf-vault-backup-" + new Date().toISOString().slice(0, 10) + ".json", body = JSON.stringify(o);
      var file = typeof File !== "undefined" ? new File([body], name, { type: "application/json" }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: "Blarf Vault backup" }).catch(function () {});
      var a = doc.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "application/json" })); a.download = name;
      doc.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return o;
    });
  }
  function parseBackup(text) {
    var o = null; try { o = JSON.parse(text); } catch (e) {}
    if (!o || o.format !== "blarf-vault-backup" || !o.wrap || !o.data || !o.salt) throw "That isn't a Blarf Vault backup.";
    return o;
  }
  /* decrypt a backup with ITS passcode; adopt it when there's no vault, merge it when unlocked */
  function importBackup(o, pass) {
    return kekFromPass(pass, unb64(o.salt), o.iter).then(function (kek) { return unseal(kek, o.wrap, AAD_MK); }, function () { throw "Couldn't read the backup."; })
      .then(function (raw) {
        return mkKey(raw).then(function (key) { return unseal(key, o.data, AAD_DATA); }).then(function (b) {
          var got = (JSON.parse(dec(b)).items || []).filter(function (x) { return x && typeof x === "object" && x.name; });
          if (!V.meta) {
            V.meta = { v: 1, kdf: o.kdf || "PBKDF2-SHA256", iter: o.iter, salt: o.salt, wrap: o.wrap, bio: null, created: new Date().toISOString() };
            V.data = o.data;
            return DB.put("meta", V.meta).then(function () { return DB.put("data", V.data); }).then(function () { return openWith(raw); }).then(function () { return got.length; });
          }
          if (!unlocked()) throw "Unlock your vault first, then import.";
          var n = 0;
          got.forEach(function (it) {
            var same = V.items.filter(function (x) { return x.id === it.id; })[0];
            if (same && same.updated >= it.updated) return;
            if (same) { V.items[V.items.indexOf(same)] = it; n++; return; }
            var copy = Object.assign({}, it); delete copy.field; V.items.push(copy); n++;
          });
          return persist().then(function () { return n; });
        });
      }, function (e) { throw typeof e === "string" && /backup/.test(e) ? e : "Wrong passcode for that backup."; });
  }

  /* ---------- provider keys: opt-in move into the vault, and back ---------- */
  function movableKeys() { var s = S(); return (C ? C.secretFields : []).filter(function (f) { return s[f] && vkeys().indexOf(f) < 0; }); }
  function moveKeysIn() {
    if (!unlocked()) return Promise.reject("Unlock first.");
    var s = S(), list = movableKeys(), now = Date.now();
    if (!list.length) return Promise.resolve(0);
    list.forEach(function (f) {
      V.items = V.items.filter(function (x) { return x.field !== f; });
      V.items.push({ id: uid(), type: "apikey", name: FIELD_LABEL[f] + (f === "apiKey" ? " (" + (s.provider || "xai") + ")" : ""), project: "Blarf", secret: s[f], field: f, created: now, updated: now });
    });
    /* the encrypted copy must land before the plaintext copy goes away */
    return persist().then(function () {
      list.forEach(function (f) { if (vkeys().indexOf(f) < 0) vkeys().push(f); });
      if (C) { C.save(); C.repaintKeys(); }
      paintSettings();
      return list.length;
    });
  }
  function moveKeysOut() {
    if (!unlocked()) return Promise.reject("Unlock first.");
    var s = S(), held = vkeys().slice();
    held.forEach(function (f) { var it = V.items.filter(function (x) { return x.field === f; })[0]; if (it) s[f] = it.secret || ""; });
    S().vaultKeys = [];
    if (C) { C.save(); C.repaintKeys(); }
    V.items = V.items.filter(function (x) { return !x.field; });
    return persist().then(function () { paintSettings(); return held.length; });
  }
  /* called from save(): mirror key edits made in Settings while unlocked; a key typed while locked goes back to normal storage */
  var syncT = null;
  function syncKeys() {
    var held = vkeys(); if (!held.length) return;
    var s = S(), dirty = false;
    held.slice().forEach(function (f) {
      if (!unlocked()) {
        if (s[f]) { held.splice(held.indexOf(f), 1); setTimeout(function () { toast("New key saved on this device (not in the Vault). Move it in again from Settings › Secure Vault."); paintSettings(); }, 0); }
        return;
      }
      var it = V.items.filter(function (x) { return x.field === f; })[0];
      if (!s[f]) { if (it) { V.items.splice(V.items.indexOf(it), 1); dirty = true; } held.splice(held.indexOf(f), 1); return; }
      if (!it) { V.items.push({ id: uid(), type: "apikey", name: FIELD_LABEL[f], project: "Blarf", secret: s[f], field: f, created: Date.now(), updated: Date.now() }); dirty = true; }
      else if (it.secret !== s[f]) { it.secret = s[f]; it.updated = Date.now(); dirty = true; }
    });
    if (dirty) { clearTimeout(syncT); syncT = setTimeout(function () { persist().catch(function () {}); render(); }, 300); }
  }
  function keysLocked() {
    if (unlocked()) return false;
    if (!V.loaded) { var s0 = S(); return vkeys().some(function (f) { return !s0[f]; }); }
    if (!V.meta) return false;
    var s = S();
    return vkeys().some(function (f) { return !s[f]; });
  }

  /* ---------- clipboard: copy, then try to clear after 30 s ---------- */
  function copySecret(val, what) {
    var done = function () { toast((what || "Copied") + " · clears in 30 s"); };
    var clear = function () {
      setTimeout(function () {
        if (!navigator.clipboard || !navigator.clipboard.writeText) return;
        var wipe = function () { navigator.clipboard.writeText("").catch(function () {}); };
        if (navigator.clipboard.readText) navigator.clipboard.readText().then(function (t) { if (t === val) wipe(); }, function () { if (!doc.hasFocus || doc.hasFocus()) wipe(); });
        else wipe();
      }, 30000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(val).then(function () { done(); clear(); }, function () { if (C) C.copyText(val); clear(); });
    else if (C) { C.copyText(val); clear(); }
  }

  /* ---------- what Blarf may know: names Kyle shared, nothing else ---------- */
  function clause() {
    var names = (S().vaultShared || []).filter(Boolean);
    if (!names.length) return "";
    return " Kyle keeps these in his on-device Secure Vault (names only; you never see the values, so never ask him to paste a password or key into chat, just tell him to copy it from the Vault): " + names.slice(0, 12).map(function (n) { return String(n).slice(0, 60); }).join(", ") + ".";
  }
  function shared(it) { return (S().vaultShared || []).indexOf(it.name) >= 0; }
  function setShared(it, on) {
    var s = S(); s.vaultShared = (s.vaultShared || []).filter(function (n) { return n !== it.name; });
    if (on) s.vaultShared.push(it.name);
    if (C) C.save();
  }

  /* ---------- UI: the vault sheet ---------- */
  var sheet, panel, body;
  function build() {
    sheet = doc.createElement("div");
    sheet.className = "x-menu x-vault"; sheet.id = "vault-sheet"; sheet.hidden = true;
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-labelledby", "vault-t");
    sheet.innerHTML = '<button class="x-menu__scrim x-scrim" id="vault-scrim" type="button" aria-label="Close vault" tabindex="-1"></button>' +
      '<div class="x-menu__panel x-crew__panel x-vault__panel" id="vault-panel"><div class="x-grabber" aria-hidden="true"></div>' +
      '<div class="x-crew__head" id="vault-head"><span class="x-crew__emoji" aria-hidden="true">🔐</span><div><h3 id="vault-t">Secure Vault</h3><small id="vault-sub">Encrypted on this iPhone</small></div>' +
      '<button class="btn" id="vault-lock" type="button" hidden>Lock</button><button class="btn" id="vault-done" type="button">Done</button></div>' +
      '<div id="vault-body" class="x-vault__body"></div>' +
      '<input type="file" id="vault-import-file" accept="application/json,.json" class="x-file" tabindex="-1" aria-hidden="true" /></div>';
    doc.body.appendChild(sheet);
    panel = doc.getElementById("vault-panel"); body = doc.getElementById("vault-body");
    doc.getElementById("vault-done").addEventListener("click", function () { setSheet(false); });
    doc.getElementById("vault-scrim").addEventListener("click", function () { setSheet(false); });
    doc.getElementById("vault-lock").addEventListener("click", function () { lock(); });
    if (C) C.sheetDrag(panel, [doc.getElementById("vault-head"), panel.querySelector(".x-grabber")], doc.getElementById("vault-scrim"), function () { setSheet(false); });
    body.addEventListener("click", onClick);
    body.addEventListener("submit", onSubmit);
    body.addEventListener("input", function (e) { if (e.target.id === "vault-q") { V.q = e.target.value; paintList(); } });
    doc.getElementById("vault-import-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; e.target.value = "";
      if (!f) return;
      f.text().then(function (t) {
        try { V.importBox = parseBackup(t); } catch (er) { toast(er); return; }
        V.view = "import"; render();
      });
    });
    sheet.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); setSheet(false); } });
  }
  function setSheet(open) {
    if (!sheet) return;
    if (C) C.layerSheet(sheet, open); else sheet.hidden = !open;
    if (open) { render(); setTimeout(function () { var f = body.querySelector("input[type=password]"); if (f) f.focus({ preventScroll: true }); }, 320); }
    else {
      V.edit = null; V.reveal = {}; V.armed = null; if (V.view !== "import") V.view = "list";
      if (V.pendingCancel) { var c = V.pendingCancel; V.pendingOk = null; V.pendingCancel = null; c(); }
      V.pendingOk = null;
    }
  }
  function field(id, label, val, o) {
    o = o || {};
    return '<div class="x-row"><label for="' + id + '">' + label + '</label><input class="x-field" id="' + id + '" name="' + id + '"' + (o.type ? ' type="' + o.type + '"' : "") +
      ' value="' + esc(val || "") + '" autocomplete="' + (o.ac || "off") + '" autocapitalize="off" spellcheck="false"' + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : "") + (o.max ? ' maxlength="' + o.max + '"' : "") + ' /></div>';
  }
  function render() {
    if (!body) return;
    doc.getElementById("vault-lock").hidden = !unlocked();
    var sub = doc.getElementById("vault-sub");
    sub.textContent = !V.meta ? "Set a passcode to start" : unlocked() ? "Unlocked · locks after " + cfg().lockMin + " min" : "Locked";
    if (V.view === "import" && V.importBox) {
      body.innerHTML = '<form class="x-group x-vault__form" data-form="import"><div class="x-prompt"><label for="vault-ipass">Passcode this backup was made with</label>' +
        '<input class="x-area" id="vault-ipass" type="password" autocomplete="off" /></div><div class="x-vault__save"><button class="btn" type="button" data-act="cancel-import">Cancel</button><button class="btn" type="submit">Import</button></div></form>' +
        '<p class="x-gnote">' + (V.meta ? (unlocked() ? "Items get added to your vault." : "Unlock your vault first, then import.") : "This backup becomes your vault, with that passcode.") + "</p>";
      return;
    }
    if (!V.meta) {
      body.innerHTML = '<div class="x-vault__hero"><p class="x-vault__big">🔐</p><p><b>Logins, notes and API keys for your projects.</b> Encrypted with AES-256 on this iPhone. Never sent to any AI.</p></div>' +
        '<form class="x-group x-vault__form" data-form="setup">' + field("vault-p1", "Passcode", "", { type: "password", ac: "new-password", ph: "6+ characters" }) +
        field("vault-p2", "Again", "", { type: "password", ac: "new-password", ph: "Confirm" }) +
        '<div class="x-vault__save"><button class="btn x-vault__cta" type="submit">Create Vault</button></div></form>' +
        '<p class="x-gnote">Forget the passcode and nobody, not even Blarf, can open it. You can add Face ID after, and export an encrypted backup.</p>' +
        '<div class="x-rowbtns x-vault__foot"><button class="btn" type="button" data-act="import">Import a backup</button></div>';
      return;
    }
    if (!unlocked()) {
      body.innerHTML = (V.pendingOk ? '<p class="x-vault__why">🧬 Your API keys are locked in the Vault. Unlock to keep going.</p>' : "") +
        '<form class="x-group x-vault__form" data-form="unlock">' + field("vault-pass", "Passcode", "", { type: "password", ac: "current-password" }) +
        '<div class="x-vault__save">' + (V.meta.bio ? '<button class="btn" type="button" data-act="bio">Face ID</button>' : "") + '<button class="btn x-vault__cta" type="submit">Unlock</button></div></form>' +
        '<p class="x-gnote" id="vault-err" role="alert">' + esc(V.note) + "</p>" +
        '<div class="x-rowbtns x-vault__foot"><button class="btn" type="button" data-act="import">Import a backup</button></div>';
      V.note = "";
      return;
    }
    if (V.view === "edit") { renderEdit(); return; }
    if (V.view === "pass") {
      body.innerHTML = '<form class="x-group x-vault__form" data-form="pass">' + field("vault-n1", "New passcode", "", { type: "password", ac: "new-password" }) + field("vault-n2", "Again", "", { type: "password", ac: "new-password" }) +
        '<div class="x-vault__save"><button class="btn" type="button" data-act="back">Cancel</button><button class="btn" type="submit">Change</button></div></form>';
      return;
    }
    var mv = movableKeys(), held = vkeys();
    body.innerHTML = '<div class="x-vault__tools"><input class="x-field x-vault__q" id="vault-q" type="search" placeholder="Search vault" value="' + esc(V.q) + '" autocomplete="off" aria-label="Search vault" />' +
      '<button class="btn" type="button" data-act="add">＋ Add</button></div>' +
      '<div class="x-group x-vault__list" id="vault-list" role="list"></div>' +
      '<p class="x-glabel" style="margin-top:18px">Blarf\'s API keys</p><div class="x-group">' +
      (held.length ? '<div class="x-row"><span class="x-twoline">In Vault ✓<small>' + esc(held.map(function (f) { return FIELD_LABEL[f]; }).join(", ")) + "</small></span>" +
        '<button class="btn" type="button" data-act="keys-out">' + (V.armed === "keys-out" ? "Tap to confirm" : "Move back") + "</button></div>" : "") +
      (mv.length ? '<div class="x-row"><span class="x-twoline">Saved on device<small>' + esc(mv.map(function (f) { return FIELD_LABEL[f]; }).join(", ")) + "</small></span>" +
        '<button class="btn" type="button" data-act="keys-in">' + (V.armed === "keys-in" ? "Tap to confirm" : "Move into Vault") + "</button></div>" : "") +
      (!held.length && !mv.length ? '<div class="x-row"><span class="x-keynote">No API keys saved in Settings yet.</span></div>' : "") + "</div>" +
      '<p class="x-gnote">Optional. Keys in the Vault are decrypted into memory when you unlock; if it\'s locked, Blarf asks you to unlock before he talks to the AI.</p>' +
      '<div class="x-rowbtns x-vault__foot"><button class="btn" type="button" data-act="export">Export backup</button><button class="btn" type="button" data-act="import">Import</button><button class="btn" type="button" data-act="pass">Change passcode</button></div>';
    paintList();
  }
  function paintList() {
    var list = doc.getElementById("vault-list"); if (!list || !unlocked()) return;
    var q = V.q.trim().toLowerCase();
    var items = V.items.filter(function (it) { return !q || [it.name, it.project, it.user, it.url].join(" ").toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return String(a.project || "~").localeCompare(String(b.project || "~")) || String(a.name).localeCompare(String(b.name)); });
    if (!items.length) { list.innerHTML = '<p class="x-vault__empty">' + (q ? "Nothing matches." : "Empty. Tap ＋ Add for a login, note or API key.") + "</p>"; return; }
    list.innerHTML = items.map(function (it) {
      var t = TYPES[it.type] || TYPES.note, rev = V.reveal[it.id], open = V.reveal["o" + it.id];
      var secret = it.secret || "";
      return '<div class="x-vitem' + (open ? " is-open" : "") + '" role="listitem" data-id="' + esc(it.id) + '">' +
        '<button class="x-vitem__row" type="button" data-act="toggle" aria-expanded="' + (open ? "true" : "false") + '"><span class="x-vitem__ico" aria-hidden="true">' + t.emoji + '</span>' +
        '<span class="x-vitem__txt"><b>' + esc(it.name) + "</b><small>" + esc([it.project, it.user, it.field ? "used by Blarf" : ""].filter(Boolean).join(" · ") || t.label) + "</small></span>" +
        (shared(it) ? '<span class="x-vitem__tag" title="Name shared with Blarf">👀</span>' : "") + '<span class="x-vitem__chev" aria-hidden="true">›</span></button>' +
        (open ? '<div class="x-vitem__body">' +
          (it.user ? '<div class="x-vrow"><span>Username</span><code>' + esc(it.user) + '</code><button class="btn" type="button" data-act="copy-user">Copy</button></div>' : "") +
          (secret ? '<div class="x-vrow"><span>' + (it.type === "note" ? "Note" : it.type === "apikey" ? "Key" : "Password") + '</span><button class="x-vsecret' + (rev ? " is-shown" : "") + '" type="button" data-act="reveal" aria-label="' + (rev ? "Hide" : "Tap to reveal") + '">' +
            (rev ? esc(secret) : "•".repeat(Math.min(14, Math.max(8, secret.length)))) + '</button><button class="btn" type="button" data-act="copy">Copy</button></div>' : "") +
          (it.url ? '<div class="x-vrow"><span>Site</span><code>' + esc(it.url) + "</code></div>" : "") +
          (it.note && it.type !== "note" ? '<div class="x-vrow x-vrow--note"><span>Notes</span><p>' + esc(it.note) + "</p></div>" : "") +
          '<div class="x-vrow x-vrow--acts"><button class="btn" type="button" data-act="share" aria-pressed="' + (shared(it) ? "true" : "false") + '">' + (shared(it) ? "👀 Name shared" : "Share name with Blarf") + "</button>" +
          '<button class="btn" type="button" data-act="edit">Edit</button><button class="btn x-vdel' + (V.armed === "del" + it.id ? " is-armed" : "") + '" type="button" data-act="del">' + (V.armed === "del" + it.id ? "Delete?" : "Delete") + "</button></div></div>" : "") +
        "</div>";
    }).join("");
  }
  function renderEdit() {
    var it = V.edit || {};
    var type = it.type || "login";
    body.innerHTML = '<form class="x-group x-vault__form" data-form="edit">' +
      '<div class="x-row"><label for="ve-type">Type</label><select class="x-field" id="ve-type" name="ve-type">' +
      Object.keys(TYPES).map(function (k) { return '<option value="' + k + '"' + (k === type ? " selected" : "") + ">" + TYPES[k].emoji + " " + TYPES[k].label + "</option>"; }).join("") + "</select></div>" +
      field("ve-name", "Name", it.name, { ph: "GitHub", max: 80 }) + field("ve-project", "Project", it.project, { ph: "Big Dreams Inc", max: 60 }) +
      '<div data-for="login">' + field("ve-user", "Username", it.user, { ph: "kyle@…", max: 200 }) + "</div>" +
      '<div data-for="login apikey">' + field("ve-secret", type === "apikey" ? "Key" : "Password", it.secret, { type: "password", ac: "new-password", max: 4000 }) + "</div>" +
      '<div data-for="login apikey">' + field("ve-url", "Site", it.url, { ph: "https://…", max: 300 }) + "</div>" +
      '<div class="x-prompt"><label for="ve-note">' + (type === "note" ? "Secure note" : "Notes") + '</label><textarea class="x-area" id="ve-note" rows="4" maxlength="8000" autocomplete="off">' + esc(type === "note" ? it.secret || it.note || "" : it.note || "") + "</textarea></div>" +
      '<div class="x-vault__save"><button class="btn" type="button" data-act="back">Cancel</button><button class="btn x-vault__cta" type="submit">Save</button></div></form>' +
      (it.field ? '<p class="x-gnote">Blarf uses this key. Changing it here changes it in Settings too.</p>' : "");
    var sel = body.querySelector("#ve-type");
    var paint = function () { [].slice.call(body.querySelectorAll("[data-for]")).forEach(function (d) { d.hidden = d.getAttribute("data-for").split(" ").indexOf(sel.value) < 0; }); body.querySelector('label[for="ve-note"]').textContent = sel.value === "note" ? "Secure note" : "Notes"; var sl = body.querySelector('label[for="ve-secret"]'); if (sl) sl.textContent = sel.value === "apikey" ? "Key" : "Password"; };
    sel.addEventListener("change", paint); paint();
  }
  function find(id) { return (V.items || []).filter(function (x) { return x.id === id; })[0]; }
  function busy(btn, on) { if (btn) { btn.disabled = on; btn.setAttribute("aria-busy", on ? "true" : "false"); } }
  function onClick(e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    var act = b.getAttribute("data-act"), row = b.closest(".x-vitem"), it = row ? find(row.getAttribute("data-id")) : null;
    V.last = Date.now();
    if (act !== "del" && act !== "keys-in" && act !== "keys-out") V.armed = null;
    if (act === "toggle" && it) { V.reveal["o" + it.id] = !V.reveal["o" + it.id]; V.reveal[it.id] = false; paintList(); }
    else if (act === "reveal" && it) { V.reveal[it.id] = !V.reveal[it.id]; paintList(); }
    else if (act === "copy" && it) copySecret(it.secret || "", it.type === "login" ? "Password copied" : "Copied");
    else if (act === "copy-user" && it) copySecret(it.user || "", "Username copied");
    else if (act === "share" && it) { setShared(it, !shared(it)); toast(shared(it) ? "Blarf can see the name “" + it.name + "”, never the secret." : "Name hidden from Blarf"); paintList(); }
    else if (act === "edit" && it) { V.edit = Object.assign({}, it); V.view = "edit"; render(); }
    else if (act === "add") { V.edit = { type: "login" }; V.view = "edit"; render(); setTimeout(function () { var n = doc.getElementById("ve-name"); if (n) n.focus(); }, 50); }
    else if (act === "back") { V.edit = null; V.view = "list"; render(); }
    else if (act === "del" && it) {
      if (V.armed !== "del" + it.id) { V.armed = "del" + it.id; paintList(); return; }
      V.armed = null;
      V.items = V.items.filter(function (x) { return x !== it; });
      setShared(it, false);
      if (it.field) { S()[it.field] = ""; S().vaultKeys = vkeys().filter(function (f) { return f !== it.field; }); if (C) { C.save(); C.repaintKeys(); } }
      persist().then(function () { toast("Deleted"); render(); }, function (er) { toast(er); });
    }
    else if (act === "bio") { busy(b, true); unlockBio().catch(function (er) { V.note = er; render(); }); }
    else if (act === "import") doc.getElementById("vault-import-file").click();
    else if (act === "cancel-import") { V.importBox = null; V.view = "list"; render(); }
    else if (act === "export") { busy(b, true); exportBackup().then(function () { busy(b, false); toast("Backup ready. It's encrypted; keep the passcode."); }, function (er) { busy(b, false); toast(er); }); }
    else if (act === "pass") { V.view = "pass"; render(); }
    else if (act === "keys-in" || act === "keys-out") {
      if (V.armed !== act) { V.armed = act; render(); return; }
      V.armed = null; busy(b, true);
      (act === "keys-in" ? moveKeysIn() : moveKeysOut()).then(function (n) { toast(act === "keys-in" ? "🔐 " + n + " key" + (n === 1 ? "" : "s") + " moved into the Vault" : "Keys moved back to normal storage"); render(); }, function (er) { busy(b, false); toast(er); });
    }
  }
  function onSubmit(e) {
    e.preventDefault();
    var f = e.target, kind = f.getAttribute("data-form"), btn = f.querySelector("[type=submit]"), val = function (id) { var x = doc.getElementById(id); return x ? x.value : ""; };
    V.last = Date.now();
    var fail = function (er) { busy(btn, false); V.note = String(er); var n = doc.getElementById("vault-err"); if (n) n.textContent = V.note; toast(String(er)); };
    if (kind === "setup") {
      if (val("vault-p1") !== val("vault-p2")) return fail("Passcodes don't match.");
      busy(btn, true); setup(val("vault-p1")).then(function () { toast("🔐 Vault created. Add Face ID in Settings if you want."); }, fail);
    } else if (kind === "unlock") {
      busy(btn, true); unlockPass(val("vault-pass")).catch(function (er) { busy(btn, false); V.note = er; render(); });
    } else if (kind === "pass") {
      if (val("vault-n1") !== val("vault-n2")) return fail("Passcodes don't match.");
      busy(btn, true); changePass(val("vault-n1")).then(function () { V.view = "list"; render(); toast("Passcode changed"); }, fail);
    } else if (kind === "import") {
      busy(btn, true);
      importBackup(V.importBox, val("vault-ipass")).then(function (n) { V.importBox = null; V.view = "list"; render(); toast("Imported " + n + " item" + (n === 1 ? "" : "s")); paintSettings(); }, fail);
    } else if (kind === "edit") {
      var type = val("ve-type"), name = val("ve-name").trim();
      if (!name) return fail("Give it a name.");
      var now = Date.now(), old = V.edit && V.edit.id ? find(V.edit.id) : null;
      var it = old || { id: uid(), created: now };
      var oldName = old ? old.name : "";
      it.type = TYPES[type] ? type : "note"; it.name = name.slice(0, 80); it.project = val("ve-project").trim().slice(0, 60);
      it.user = type === "login" ? val("ve-user").trim() : "";
      it.secret = type === "note" ? val("ve-note") : val("ve-secret");
      it.url = type === "note" ? "" : val("ve-url").trim();
      it.note = type === "note" ? "" : val("ve-note");
      it.updated = now;
      if (!old) V.items.push(it);
      if (oldName && oldName !== it.name && (S().vaultShared || []).indexOf(oldName) >= 0) { S().vaultShared = S().vaultShared.map(function (n) { return n === oldName ? it.name : n; }); if (C) C.save(); }
      if (it.field) { S()[it.field] = it.secret; if (C) C.repaintKeys(); }
      busy(btn, true);
      persist().then(function () { if (it.field && C) C.save(); V.edit = null; V.view = "list"; V.reveal["o" + it.id] = true; render(); toast("Saved 🔐"); }, fail);
    }
  }

  /* ---------- Settings › Secure Vault ---------- */
  function p2aBox() {
    var box = doc.getElementById("p2a-settings");
    if (box) return box;
    box = doc.createElement("div"); box.id = "p2a-settings"; box.className = "x-p2aset";
    var set = doc.querySelector("#view-settings .x-settings"); if (!set) return null;
    var anchor = [].slice.call(set.querySelectorAll(".x-glabel")).filter(function (l) { return l.textContent.trim() === "Blarf"; })[0];
    var host = anchor ? anchor.parentNode : null;
    if (host && host.parentNode === set) set.insertBefore(box, host); else set.appendChild(box);
    return box;
  }
  function buildSettings() {
    var box = p2aBox(); if (!box) return;
    var d = doc.createElement("div"); d.id = "vault-settings";
    d.innerHTML = '<p class="x-glabel">Secure Vault</p><div class="x-group">' +
      '<div class="x-row"><span class="x-twoline">🔐 Vault<small id="vset-status" aria-live="polite">Not set up</small></span><button class="btn" id="vset-open" type="button">Open</button></div>' +
      '<div class="x-row"><label for="vset-lock">Auto-lock</label><select class="x-field" id="vset-lock"><option value="1">After 1 minute</option><option value="5">After 5 minutes</option><option value="15">After 15 minutes</option><option value="60">After 1 hour</option></select></div>' +
      '<div class="x-row"><span class="x-twoline" id="vset-hidden-l">Lock when Blarf is hidden<small>Switching apps for 15 s+ locks it</small></span><button class="x-switch" id="vset-hidden" type="button" role="switch" aria-checked="true" aria-labelledby="vset-hidden-l"></button></div>' +
      '<div class="x-row"><span class="x-twoline" id="vset-face-l">Face ID unlock<small id="vset-face-s">Passkey; falls back to your passcode</small></span><button class="x-switch" id="vset-face" type="button" role="switch" aria-checked="false" aria-labelledby="vset-face-l"></button></div>' +
      '<div class="x-row"><span class="x-twoline">API keys<small id="vset-keys">Saved on this device</small></span><button class="btn" id="vset-keys-b" type="button">Manage</button></div>' +
      "</div>" + '<p class="x-gnote">AES-256-GCM with a key from your passcode (PBKDF2, 600k rounds). Stays on this iPhone and is never sent to any AI; Blarf only sees names you share. Forget the passcode and it\'s gone, so export a backup.</p>';
    box.appendChild(d);
    var g = function (id) { return doc.getElementById(id); };
    g("vset-open").addEventListener("click", function () { open(); });
    g("vset-keys-b").addEventListener("click", function () { open(); setTimeout(function () { var k = body.querySelector('[data-act="keys-in"],[data-act="keys-out"]'); if (k) k.scrollIntoView({ block: "center" }); }, 350); });
    g("vset-lock").addEventListener("change", function (e) { cfg().lockMin = +e.target.value; if (C) C.save(); paintSettings(); });
    g("vset-hidden").addEventListener("click", function () { var c = cfg(); c.lockHidden = !c.lockHidden; if (C) C.save(); paintSettings(); });
    g("vset-face").addEventListener("click", function () {
      if (!V.meta) { toast("Create the vault first."); open(); return; }
      if (V.meta.bio) { disableBio().then(function () { toast("Face ID unlock off. Passcode only."); }); return; }
      if (!unlocked()) { toast("Unlock the vault, then turn on Face ID."); open(); return; }
      bioCapable().then(function (ok) {
        if (!ok) { toast("Face ID passkeys aren't available here. Open Blarf from your Home Screen in Safari."); return; }
        return enableBio().then(function () { toast("Face ID unlock on ✓"); });
      }).catch(function (er) { toast(String(er)); paintSettings(); });
    });
  }
  function paintSettings() {
    var st = doc.getElementById("vset-status"); if (!st) return;
    var c = cfg();
    st.textContent = !V.loaded ? "Checking…" : !V.meta ? "Not set up" : unlocked() ? "Unlocked · " + V.items.length + " item" + (V.items.length === 1 ? "" : "s") : "Locked";
    doc.getElementById("vset-open").textContent = !V.meta ? "Set up" : unlocked() ? "Open" : "Unlock";
    doc.getElementById("vset-lock").value = String(c.lockMin);
    doc.getElementById("vset-hidden").setAttribute("aria-checked", c.lockHidden ? "true" : "false");
    doc.getElementById("vset-face").setAttribute("aria-checked", V.meta && V.meta.bio ? "true" : "false");
    var held = vkeys(), mv = movableKeys();
    doc.getElementById("vset-keys").textContent = held.length ? "In Vault: " + held.map(function (f) { return FIELD_LABEL[f]; }).join(", ") + (mv.length ? " · " + mv.length + " still on device" : "") : mv.length ? mv.length + " on this device (not in the Vault)" : "None saved yet";
  }

  /* ---------- auto-lock: idle timer + app hidden ---------- */
  function wireLock() {
    ["pointerdown", "keydown"].forEach(function (ev) { doc.addEventListener(ev, function () { V.last = Date.now(); }, true); });
    setInterval(function () { if (unlocked() && Date.now() - V.last > cfg().lockMin * 60000) lock(); }, 10000);
    var hideT = null;
    doc.addEventListener("visibilitychange", function () {
      if (doc.hidden) {
        V.hiddenAt = Date.now();
        clearTimeout(hideT);
        if (cfg().lockHidden) hideT = setTimeout(function () { if (doc.hidden && unlocked()) lock(true); }, 15000);
      } else {
        clearTimeout(hideT);
        if (unlocked() && ((cfg().lockHidden && V.hiddenAt && Date.now() - V.hiddenAt > 15000) || Date.now() - V.last > cfg().lockMin * 60000)) lock();
        V.hiddenAt = 0;
      }
    });
    window.addEventListener("pagehide", function () { if (cfg().lockHidden) lock(true); });
  }

  function open() { if (!sheet) return; if (C) C.setMenu(false, true); setSheet(true); }
  function unlockFor(ok, cancel) {
    if (!V.loaded) { loadAll().then(function () { unlockFor(ok, cancel); }); return; }
    if (unlocked() || !V.meta) { if (ok) ok(); return; }
    V.pendingOk = ok || null; V.pendingCancel = cancel || null;
    setSheet(true);
    /* still inside the tap that asked: Face ID can start right away */
    if (V.meta.bio) unlockBio().catch(function (er) { V.note = er; render(); });
  }

  function init() {
    if (C) return;
    C = window.blarfCore; if (!C) return;
    cfg();
    build(); buildSettings(); wireLock();
    var mv = doc.getElementById("menu-vault");
    if (mv) mv.addEventListener("click", function () { open(); });
    loadAll().then(render);
  }

  window.blarfVault = {
    open: open, lock: function () { lock(); }, unlockFor: unlockFor, keysLocked: keysLocked, syncKeys: syncKeys, clause: clause,
    isUnlocked: unlocked, hasVault: function () { return !!V.meta; }, ready: function () { return V.loaded ? Promise.resolve() : loadAll(); },
    /* for tests and power users; never exposes secrets of a locked vault */
    _t: { setup: setup, unlockPass: unlockPass, unlockBio: unlockBio, enableBio: enableBio, exportBackup: exportBackup, parseBackup: parseBackup, importBackup: importBackup,
      moveKeysIn: moveKeysIn, moveKeysOut: moveKeysOut, items: function () { return V.items; }, meta: function () { return V.meta; }, data: function () { return V.data; },
      add: function (it) { if (!unlocked()) return Promise.reject("locked"); it = Object.assign({ id: uid(), created: Date.now(), updated: Date.now(), type: "login" }, it); V.items.push(it); return persist().then(function () { return it; }); },
      reload: loadAll, copySecret: copySecret, setShared: function (id, on) { var it = find(id); if (it) setShared(it, on); }, ITER: ITER, render: render, view: function () { return V.view; } }
  };
  if (window.blarfCore) init(); else window.addEventListener("blarf-core", init);
})();

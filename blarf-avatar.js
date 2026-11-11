/* Blarf OS P3a: avatar engine switch (Classic 2D / 3D), custom avatar upload, model check, fallback.
   This classic script owns Settings › Look and S.avatar. The heavy part (three.js + the 3D renderer in
   blarf-avatar3d.mjs) is only downloaded when 3D is switched on; sw.js keeps it for offline use.
   If WebGL is missing, the engine can't download, or a model won't load, he drops back to the 2D face with a toast. */
(function () {
  "use strict";
  var doc = document, C = null, eng = null, starting = null, seq = 0, lastCheck = null;
  var FOLDER = "f_avatars", MAX_MB = 60, WARN_MB = 15, EXT = /\.(glb|gltf|vrm)$/i;
  function S() { return C ? C.S : {}; }
  function cfg() {
    var s = S(), a = s.avatar && typeof s.avatar === "object" ? s.avatar : (s.avatar = {});
    if (a.engine !== "3d") a.engine = "2d";
    if (typeof a.model !== "string" || !a.model) a.model = "builtin";
    a.low = !!a.low;
    return a;
  }
  function save() { try { C.save(); } catch (e) {} }
  function toast(t) { try { C.toast(t); } catch (e) {} }
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function lib() { return window.blarfLib || null; }
  function stage() { return doc.getElementById("stage"); }
  function hero() { try { return C.heroSvg ? C.heroSvg() : doc.querySelector("#stage svg.x-hero"); } catch (e) { return null; } }

  /* ---------- capability + lazy module ---------- */
  function webgl() {
    if (window.__blarf3dWebGL !== undefined) return !!window.__blarf3dWebGL;
    try { var c = doc.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); } catch (e) { return false; }
  }
  var modP = null;
  function loadMod() {
    if (modP) return modP;
    var url = new URL("blarf-avatar3d.mjs", doc.baseURI).href;
    var imp = window.__blarf3dImport || function (u) { return (new Function("u", "return import(u)"))(u); };
    modP = new Promise(function (res, rej) {
      var to = setTimeout(function () { rej(new Error("the 3D engine took too long to download")); }, 25000);
      Promise.resolve().then(function () { return imp(url); }).then(function (m) { clearTimeout(to); res(m); }, function (e) {
        clearTimeout(to); rej(new Error(navigator.onLine === false ? "no internet for the first 3D download" : "couldn't download the 3D engine" + (e && e.message ? " (" + e.message + ")" : "")));
      });
    });
    modP.catch(function () { modP = null; });
    return modP;
  }

  /* ---------- start / stop / fall back ---------- */
  function on() { return !!(eng && doc.documentElement.classList.contains("x-3d")); }
  function start() {
    if (eng || starting) return starting || Promise.resolve(eng);
    var my = ++seq;
    paintStatus("Loading 3D…");
    starting = Promise.resolve().then(function () {
      if (!webgl()) throw new Error("this browser has 3D graphics (WebGL) turned off");
      return loadMod();
    }).then(function (M) {
      if (my !== seq) throw "stale";
      window.blarf3DOn = true;
      return M.create({ host: stage(), svg: hero(), lowPower: cfg().low, onFail: function (m) { eng = null; fallback(m); } });
    }).then(function (E) {
      if (my !== seq) { E.dispose(); throw "stale"; }
      eng = E; return loadModel();
    }).then(function () {
      if (my !== seq) return;
      doc.documentElement.classList.add("x-3d");
      starting = null; paint();
    }).catch(function (e) {
      starting = null;
      if (e === "stale") return;
      fallback(e && e.message ? e.message : String(e));
    });
    return starting;
  }
  function stop() {
    seq++; starting = null;
    if (eng) { try { eng.dispose(); } catch (e) {} eng = null; }
    window.blarf3DOn = false;
    doc.documentElement.classList.remove("x-3d");
  }
  function fallback(msg) {
    stop();
    var a = cfg(); a.engine = "2d"; save(); paint();
    paintStatus("Couldn't start 3D: " + msg);
    toast("3D avatar didn't work (" + msg + "). Back to classic 2D.");
  }
  function itemFor(id) { var L = lib(); return L && L.item ? L.item(id) : null; }
  function loadModel() {
    var a = cfg(), my = seq;
    if (!eng) return Promise.resolve();
    if (a.model === "builtin") { lastCheck = eng.loadBuiltin(); paintCheck(); return Promise.resolve(lastCheck); }
    var L = lib(), it = itemFor(a.model);
    if (!L || !it) {
      a.model = "builtin"; save(); toast("That avatar isn't in the Library anymore. Using the built-in 3D Blarf.");
      lastCheck = eng.loadBuiltin(); paintCheck(); paintModels(); return Promise.resolve(lastCheck);
    }
    paintStatus("Loading " + it.name + "…");
    return L.blob(it.id).then(function (b) {
      if (!b) throw new Error("the file is missing from the Library");
      return b.arrayBuffer ? b.arrayBuffer() : new Response(b).arrayBuffer();
    }).then(function (buf) {
      if (my !== seq || !eng) throw "stale";
      return eng.loadBuffer(buf, it.name);
    }).then(function (chk) { lastCheck = chk; paintCheck(); return chk; }, function (e) {
      if (e === "stale") throw e;
      throw new Error(it.name + " wouldn't load: " + (e && e.message ? e.message : String(e)));
    });
  }
  function setEngine(v) {
    var a = cfg(); if (a.engine === v && (v === "2d" || eng || starting)) return;
    a.engine = v === "3d" ? "3d" : "2d"; save(); paint();
    if (a.engine === "3d") start(); else { stop(); paintStatus(""); paintCheck(); }
  }
  function setModel(id) {
    var a = cfg(); a.model = id || "builtin"; save(); paintModels();
    if (a.engine !== "3d") { setEngine("3d"); return; }
    if (!eng) { start(); return; }
    loadModel().then(function () { paint(); }, function (e) { if (e !== "stale") fallback(e && e.message ? e.message : String(e)); });
  }

  /* ---------- upload into Library › Avatars ---------- */
  function upload(file) {
    var L = lib();
    if (!file) return Promise.resolve(null);
    if (!EXT.test(file.name || "")) { toast("Avatars need to be .glb, .gltf or .vrm"); return Promise.resolve(null); }
    var mb = (file.size || 0) / 1048576;
    if (mb > MAX_MB) { toast("That's " + mb.toFixed(0) + " MB. Keep avatars under " + WARN_MB + " MB (max " + MAX_MB + ")."); return Promise.resolve(null); }
    if (!L || !L.addFiles || !L.ensureFolder) { toast("The Library isn't ready yet. Try again in a sec."); return Promise.resolve(null); }
    paintStatus("Saving " + file.name + " to Library › Avatars…");
    return L.ready().then(function () { return L.ensureFolder(FOLDER, "Avatars", true); }).then(function () {
      return L.addFiles([file], FOLDER, { src: "avatar" });
    }).then(function (done) {
      var it = done && done[0]; if (!it) { paintStatus(""); return null; }
      if (mb > WARN_MB) toast("Saved, but " + mb.toFixed(1) + " MB is heavy for an iPhone (aim under " + WARN_MB + " MB).");
      else toast("Saved to Library › Avatars. Loading it…");
      setModel(it.id); return it;
    }, function (e) { paintStatus(""); toast(String(e && e.message || e)); return null; });
  }

  /* ---------- Settings › Look ---------- */
  function buildSettings() {
    if (doc.getElementById("look-settings")) return;
    var set = doc.querySelector("#view-settings .x-settings"); if (!set) return;
    var anchor = [].slice.call(set.querySelectorAll(".x-glabel")).filter(function (l) { return l.textContent.trim() === "Outfit"; })[0];
    var d = doc.createElement("div"); d.id = "look-settings";
    d.innerHTML = '<p class="x-glabel">Look</p><div class="x-group">' +
      '<div class="x-row"><span id="look-eng-l">Avatar</span><div class="x-seg" id="look-eng" role="group" aria-labelledby="look-eng-l">' +
      '<button type="button" data-eng="2d" aria-pressed="true">Classic 2D</button><button type="button" data-eng="3d" aria-pressed="false">3D</button></div></div>' +
      '<div class="x-row look-3d"><label for="look-model">Model</label><select class="x-field" id="look-model"></select></div>' +
      '<div class="x-row look-up"><span class="x-twoline">Upload avatar<small>.glb, .gltf or .vrm · saved in Library › Avatars</small></span>' +
      '<button class="btn" id="look-upbtn" type="button">Choose file</button><input id="look-file" type="file" accept=".glb,.gltf,.vrm,model/gltf-binary,model/gltf+json" hidden /></div>' +
      '<div class="x-row look-3d"><span class="x-twoline" id="look-low-l">Low power<small>30 fps, standard resolution, easier on the battery</small></span>' +
      '<button class="x-switch" id="look-low" type="button" role="switch" aria-checked="false" aria-labelledby="look-low-l"></button></div>' +
      '<div class="x-row look-3d"><span>3D view</span><button class="btn" id="look-reset" type="button">Reset view</button></div>' +
      '<div class="x-row look-checkrow"><div class="look-check" id="look-check" aria-live="polite"><p class="look-check__h">Model check</p><ul id="look-check-list"></ul></div></div>' +
      '<p class="look-status" id="look-status" role="status" hidden></p>' +
      '</div><p class="x-gnote">3D downloads its engine (about 1 MB) the first time, then works offline. On the face screen: pinch to zoom, drag sideways next to him to turn him, ⟲ resets. Pokes, rubs and lip sync work the same in 3D.</p>';
    if (anchor && anchor.parentNode && anchor.parentNode.parentNode === set) set.insertBefore(d, anchor.parentNode); else set.appendChild(d);
    var g = function (id) { return doc.getElementById(id); };
    g("look-eng").addEventListener("click", function (e) { var b = e.target.closest("[data-eng]"); if (b) setEngine(b.getAttribute("data-eng")); });
    g("look-model").addEventListener("change", function (e) { setModel(e.target.value); });
    g("look-upbtn").addEventListener("click", function () { g("look-file").click(); });
    g("look-file").addEventListener("change", function (e) { var f = e.target.files && e.target.files[0]; e.target.value = ""; upload(f); });
    g("look-low").addEventListener("click", function () { var a = cfg(); a.low = !a.low; save(); if (eng) eng.setLowPower(a.low); paint(); });
    g("look-reset").addEventListener("click", function () { if (eng) { eng.resetView(); toast("View reset"); } });
  }
  function paintStatus(t) { var el = doc.getElementById("look-status"); if (!el) return; el.textContent = t || ""; el.hidden = !t; }
  function avatars() { var L = lib(); return L && L.list ? L.list(FOLDER).filter(function (x) { return EXT.test(x.name || ""); }) : []; }
  function paintModels() {
    var sel = doc.getElementById("look-model"); if (!sel) return;
    var a = cfg(), list = avatars();
    sel.innerHTML = '<option value="builtin">Built-in 3D Blarf</option>' + list.map(function (it) {
      return '<option value="' + esc(it.id) + '">' + esc(it.name) + "</option>";
    }).join("");
    sel.value = list.some(function (it) { return it.id === a.model; }) ? a.model : "builtin";
  }
  function paintCheck() {
    var ul = doc.getElementById("look-check-list"), box = doc.getElementById("look-check"); if (!ul || !box) return;
    var a = cfg(), chk = a.engine === "3d" && eng ? (eng.check || lastCheck) : null;
    box.parentNode.hidden = !chk;
    if (!chk) { ul.innerHTML = ""; return; }
    ul.innerHTML = chk.lines.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") +
      (chk.warn || []).map(function (w) { return '<li class="is-warn">⚠️ ' + esc(w) + "</li>"; }).join("");
  }
  function paint() {
    var box = doc.getElementById("look-settings"); if (!box) return;
    var a = cfg();
    [].slice.call(box.querySelectorAll("[data-eng]")).forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-eng") === a.engine ? "true" : "false"); });
    [].slice.call(box.querySelectorAll(".look-3d")).forEach(function (r) { r.hidden = a.engine !== "3d"; });
    var lw = doc.getElementById("look-low"); if (lw) lw.setAttribute("aria-checked", a.low ? "true" : "false");
    if (on() && !starting) paintStatus("");
    paintModels(); paintCheck();
  }

  /* ---------- the hooks index.html calls ---------- */
  window.blarf3D = {
    on: on,
    pick: function (x, y) { return eng ? eng.pick(x, y) : null; },
    gesturing: function (consume) { return eng ? eng.gesturing(consume) : false; },
    start: start, stop: stop, setEngine: setEngine, setModel: setModel, upload: upload,
    engine: function () { return eng; }, check: function () { return eng ? eng.check : null; }, _t: { cfg: cfg, fallback: fallback, loadModel: loadModel }
  };

  function init() {
    if (C || !window.blarfCore) return;
    C = window.blarfCore;
    buildSettings(); paint();
    var L = lib();
    if (L && L.ready) L.ready().then(function () { paintModels(); if (cfg().engine === "3d") start(); }, function () { if (cfg().engine === "3d") start(); });
    else if (cfg().engine === "3d") start();
    /* the Library list can change (deleted or uploaded elsewhere): refresh the picker when Settings opens */
    doc.addEventListener("click", function (e) { if (e.target.closest && e.target.closest('[data-tab="settings"], [data-go="settings"]')) setTimeout(paint, 50); });
  }
  if (window.blarfCore) init(); else window.addEventListener("blarf-core", init);
})();

/* Blarf OS P3b: Studio FX video editor (CapCut-lite). Needs blarf-fx.js (window.blarfFX).
   Export pipeline, chosen for iPhone Safari on GitHub Pages (no COOP/COEP, so no SharedArrayBuffer):
   1) WebCodecs: <video> playback drives frames (requestVideoFrameCallback) -> canvas compose (filters via the shared
      WebGL pass, captions) -> VideoEncoder H.264 Constrained Baseline (iOS 26 hangs on High/Main) + AudioEncoder AAC
      (Safari 26+; WebKit's bad AAC magic cookie is replaced with a proper 2-byte AudioSpecificConfig) -> mp4-muxer 5.2.2
      (self-hosted vendor/mp4-muxer.js, 74 KB, lazy). Audio is mixed offline (OfflineAudioContext) so sync is exact.
   2) Fallback (no WebCodecs / AudioEncoder): canvas.captureStream + MediaRecorder (video/mp4 on Safari), real time.
   ffmpeg.wasm (single-thread core, ~31 MB) was not used: x264 in single-thread wasm runs at a few fps on a phone,
   needs the whole input + output inside a wasm heap that iOS caps well below desktop, and re-decodes everything. */
(function () {
  "use strict";
  var doc = document, FX = null, C = null;
  function $(id) { return doc.getElementById(id); }
  var esc, clamp, uid, toast = function (t) { if (C) C.toast(t); };
  var V = null, M = {}; /* session, media registry by key */
  var MUXER_URL = "vendor/mp4-muxer.js", FPS = 30, MAX_TOTAL = 600, WARN_1080 = 120;
  var TABS = [["clips", "Clips", "🎬"], ["text", "Text", "Aa"], ["music", "Music", "🎵"], ["filters", "Filters", "🎞️"], ["format", "Format", "▭"]];
  var ASPECT = { "9:16": [9, 16], "1:1": [1, 1], "16:9": [16, 9] };
  function fresh() { return { clips: [], caps: [], music: null, aspect: "9:16", fit: "fill", res: 1080 }; }
  function fmtT(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = t - m * 60; return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1); }
  function lens() { return V.st.clips.map(function (c) { return Math.max(0, (c.out - c.in) / c.speed); }); }
  function total() { return lens().reduce(function (a, b) { return a + b; }, 0); }
  function starts() { var s = 0; return lens().map(function (l) { var o = s; s += l; return o; }); }
  function segAt(t) {
    var L = lens(), s = 0;
    for (var i = 0; i < L.length; i++) { if (t < s + L[i] || i === L.length - 1) return { i: i, c: V.st.clips[i], start: s, local: V.st.clips[i].in + clamp(t - s, 0, L[i]) * V.st.clips[i].speed }; s += L[i]; }
    return null;
  }
  function outDims(st) {
    st = st || V.st; var a = ASPECT[st.aspect] || ASPECT["9:16"], short = st.res === 720 ? 720 : 1080;
    var w = a[0] <= a[1] ? short : Math.round(short * a[0] / a[1]), h = a[0] <= a[1] ? Math.round(short * a[1] / a[0]) : short;
    return { w: w - (w % 2), h: h - (h % 2) };
  }

  /* ---------- media registry ---------- */
  /* iOS only decodes reliably for elements in the document: park them in a 1px invisible box */
  function park() {
    var p = $("fxv-media");
    if (!p) { p = doc.createElement("div"); p.id = "fxv-media"; p.setAttribute("aria-hidden", "true"); p.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1"; doc.body.appendChild(p); }
    return p;
  }
  function vidEl(url) {
    var el = doc.createElement("video"); el.preload = "auto"; el.playsInline = true; el.setAttribute("playsinline", ""); el.muted = true; el.crossOrigin = "anonymous"; el.src = url;
    el.style.cssText = "width:1px;height:1px"; park().appendChild(el);
    return el;
  }
  function waitEv(el, ev, ms) {
    return new Promise(function (ok, no) {
      var t = setTimeout(function () { cl(); no("timeout"); }, ms || 15000);
      function on() { cl(); ok(); } function er() { cl(); no("Couldn't read that video."); }
      function cl() { clearTimeout(t); el.removeEventListener(ev, on); el.removeEventListener("error", er); }
      el.addEventListener(ev, on); el.addEventListener("error", er);
    });
  }
  function seekTo(el, t) {
    if (Math.abs(el.currentTime - t) < 0.002 && el.readyState >= 2) return Promise.resolve();
    var p = waitEv(el, "seeked", 8000); el.currentTime = t; return p.catch(function () {});
  }
  function register(blob, name) {
    var key = uid("m"), url = URL.createObjectURL(blob), el = vidEl(url);
    M[key] = { key: key, url: url, blob: blob, el: el, name: name || blob.name || "clip", thumbs: [], audio: undefined };
    return waitEv(el, "loadedmetadata", 20000).then(function () {
      var m = M[key]; m.dur = isFinite(el.duration) ? el.duration : 0; m.w = el.videoWidth; m.h = el.videoHeight;
      if (!m.dur || !m.w) { el.remove(); throw "That video won't open here."; }
      thumbs(m); return m;
    });
  }
  function thumbs(m) {
    var el = vidEl(m.url), n = Math.max(3, Math.min(12, Math.ceil(m.dur / 2))), h = 56, w = Math.round(h * m.w / m.h) || 32, i = 0, cv = FX.canvas(w, h), x = FX.ctx2d(cv);
    if (!x) return;
    function one() {
      if (i >= n || !M[m.key]) { el.removeAttribute("src"); try { el.load(); } catch (e) {} el.remove(); return; }
      var t = Math.min(m.dur - 0.05, (i + 0.5) * m.dur / n);
      seekTo(el, t).then(function () { try { x.drawImage(el, 0, 0, w, h); m.thumbs.push(cv.toDataURL("image/jpeg", 0.6)); } catch (e) {} i++; if (V) paintTimeline(); one(); });
    }
    waitEv(el, "loadeddata", 15000).then(one, function () {});
  }
  var AC = null;
  function audioCtx() { if (!AC) { var A = window.AudioContext || window.webkitAudioContext; if (A) try { AC = new A(); } catch (e) {} } return AC; }
  function decodeAudio(m) {
    if (m.audio !== undefined) return Promise.resolve(m.audio);
    var ac = audioCtx(); if (!ac || !m.blob) { m.audio = null; return Promise.resolve(null); }
    return m.blob.arrayBuffer().then(function (buf) {
      return new Promise(function (ok) { try { var p = ac.decodeAudioData(buf, ok, function () { ok(null); }); if (p && p.then) p.then(ok, function () { ok(null); }); } catch (e) { ok(null); } });
    }).then(function (b) { m.audio = b || null; return m.audio; }, function () { m.audio = null; return null; });
  }

  /* ---------- frame compose (preview + export share this) ---------- */
  var tiny = null, frame = null;
  function clipParams(c) { var p = FX.combine(c.adj, c.filter, (c.famt == null ? 100 : c.famt) / 100); p.seed = 3; return p; }
  function compose(x, W, H, el, clip, t, st) {
    st = st || V.st;
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = "#000"; x.fillRect(0, 0, W, H);
    var vw = el.videoWidth || 16, vh = el.videoHeight || 9;
    if (!frame) frame = FX.canvas(W, H);
    if (frame.width !== W || frame.height !== H) { frame.width = W; frame.height = H; }
    var f = FX.ctx2d(frame); f.setTransform(1, 0, 0, 1, 0, 0); f.fillStyle = "#000"; f.fillRect(0, 0, W, H);
    var cover = Math.max(W / vw, H / vh), contain = Math.min(W / vw, H / vh);
    try {
      if (st.fit === "blur") {
        if (!tiny) tiny = FX.canvas(24, 24);
        var tx = FX.ctx2d(tiny); tx.drawImage(el, 0, 0, 24, 24);
        f.globalAlpha = 0.7; f.drawImage(tiny, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1); f.globalAlpha = 1;
      }
      var k = st.fit === "fill" ? cover : contain, dw = vw * k, dh = vh * k;
      f.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (e) {}
    var P = clipParams(clip), img = FX.isIdentity(P) ? frame : FX.processFrame(frame, W, H, P);
    x.drawImage(img, 0, 0, W, H);
    drawCaps(x, W, H, t, st);
    x.restore();
  }
  function wrap(x, text, maxW) {
    var out = [];
    String(text || "").split("\n").forEach(function (para) {
      var line = ""; para.split(/\s+/).forEach(function (w) { var tryL = line ? line + " " + w : w; if (line && x.measureText(tryL).width > maxW) { out.push(line); line = w; } else line = tryL; });
      out.push(line);
    });
    return out.join("\n");
  }
  function capLayer(cp) { return { kind: "text", text: cp.text, font: cp.font || "bold", color: cp.color || "#ffffff", stroke: cp.style === "label" ? 0 : 2, bg: cp.style === "label", size: cp.size || 0.065, x: 0.5, y: cp.pos === "top" ? 0.16 : cp.pos === "middle" ? 0.5 : 0.8, rot: 0 }; }
  function drawCaps(x, W, H, t, st) {
    (st.caps || []).forEach(function (cp) {
      if (t < cp.start || t >= cp.end || !cp.text) return;
      var l = capLayer(cp), a = Math.min(1, (t - cp.start) / 0.12, (cp.end - t) / 0.12);
      x.font = FX.fontOf(l, l.size * W); l.text = wrap(x, l.text, W * 0.84);
      x.save(); x.globalAlpha = clamp(a, 0, 1); FX.drawLayer(x, l, W, H, false); x.restore();
    });
  }

  /* ---------- UI ---------- */
  function build() {
    var r = doc.createElement("div");
    r.className = "fx fxv"; r.id = "fxv"; r.hidden = true; r.setAttribute("role", "dialog"); r.setAttribute("aria-modal", "true"); r.setAttribute("aria-label", "Studio FX video editor");
    r.innerHTML =
      '<header class="fx-top"><button class="fx-icon" type="button" data-a="close" aria-label="Close editor">×</button>' +
      '<div class="fx-title"><b>Studio FX</b><small id="fxv-sub">Video</small></div>' +
      '<button class="fx-icon" type="button" data-a="undo" aria-label="Undo" disabled>↶</button><button class="fx-icon" type="button" data-a="redo" aria-label="Redo" disabled>↷</button>' +
      '<button class="fx-btn fx-btn--go" type="button" data-a="export">Export</button></header>' +
      '<div class="fx-stage fxv-stage" id="fxv-stage"><canvas id="fxv-cv" aria-label="Video preview"></canvas><div class="fx-say" id="fxv-say" hidden></div></div>' +
      '<div class="fxv-bar"><button class="fx-icon fxv-play" type="button" data-a="play" aria-label="Play">▶</button><span class="fxv-time" id="fxv-time">0:00.0 / 0:00.0</span>' +
      '<button class="fx-icon" type="button" data-a="zout" aria-label="Zoom out timeline">−</button><button class="fx-icon" type="button" data-a="zin" aria-label="Zoom in timeline">＋</button></div>' +
      '<div class="fxv-tlwrap"><div class="fxv-tl" id="fxv-tl"><div class="fxv-track" id="fxv-track"></div></div><div class="fxv-head" aria-hidden="true"></div></div>' +
      '<div class="fx-panel" id="fxv-panel"></div>' +
      '<nav class="fx-tabs" id="fxv-tabs" role="tablist">' + TABS.map(function (t) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="false"><span aria-hidden="true">' + t[2] + "</span>" + t[1] + "</button>"; }).join("") + "</nav>";
    doc.body.appendChild(r);
    r.addEventListener("click", function (e) {
      var b = e.target.closest("[data-a]"); if (!b || !V || b.closest(".fx-pick, .fx-sheet")) return;
      var a = b.getAttribute("data-a");
      if (a === "close") close(); else if (a === "undo") undo(); else if (a === "redo") redo();
      else if (a === "export") startExport(); else if (a === "play") { if (V.playing) pause(); else play(); }
      else if (a === "zin" || a === "zout") { V.pps = clamp(V.pps * (a === "zin" ? 1.5 : 1 / 1.5), 8, 240); paintTimeline(); syncScroll(); }
    });
    r.querySelector("#fxv-tabs").addEventListener("click", function (e) { var b = e.target.closest("[data-tab]"); if (b && V) { V.tab = b.getAttribute("data-tab"); paintTabs(); paintPanel(); } });
    var tl = r.querySelector("#fxv-tl");
    tl.addEventListener("scroll", function () { if (!V || V.autoScroll) return; if (V.playing) pause(); V.t = clamp(tl.scrollLeft / V.pps, 0, total()); paintTime(); seekPreview(); });
    r.querySelector("#fxv-track").addEventListener("pointerdown", onTrackDown);
    window.addEventListener("resize", function () { if (V && !r.hidden) { V.size = null; renderPreview(); paintTimeline(); } });
    doc.addEventListener("visibilitychange", function () { if (doc.hidden && V && V.playing) pause(); });
    return r;
  }
  function root() { return $("fxv") || build(); }
  /* open({ items: [libItem|Blob|File], aspect, caption, music: "beat"|libItem, filter, note }) */
  function open(o) {
    o = o || {};
    FX = window.blarfFX; C = FX && FX.core(); if (!FX) return Promise.resolve(false);
    esc = FX.esc; clamp = FX.clamp; uid = FX.uid;
    var r = root();
    if (V && V.playing) pause();
    V = { st: fresh(), undo: [], redo: [], tab: "clips", sel: null, t: 0, pps: 40, playing: false };
    if (o.aspect && ASPECT[o.aspect]) V.st.aspect = o.aspect;
    V.base = JSON.stringify(V.st);
    FX.openRoot(r); paintTabs(); paintAll();
    if (o.note) say(o.note);
    var items = o.items || [];
    if (!items.length) return Promise.resolve(true);
    return addMedia(items).then(function () {
      if (o.filter && FX.PRESETS.some(function (p) { return p.id === o.filter; })) V.st.clips.forEach(function (c) { c.filter = o.filter; c.famt = 100; });
      if (o.caption) V.st.caps.push({ id: uid("c"), text: String(o.caption).slice(0, 200), start: 0, end: Math.min(total(), 3.5) || 3.5, pos: "bottom", style: "stroke", font: "bold", color: "#ffffff", size: 0.065 });
      var mp = o.music === "beat" ? setMusicBeat() : o.music && o.music.id ? setMusicLib(o.music) : Promise.resolve();
      return mp.then(function () { commit(); paintAll(); return true; });
    });
  }
  function close() {
    if (!V) return;
    var r = root();
    var go = function () { pause(); FX.closeRoot(r, function () { Object.keys(M).forEach(function (k) { try { URL.revokeObjectURL(M[k].url); if (M[k].el && M[k].el.remove) { M[k].el.removeAttribute("src"); M[k].el.remove(); } } catch (e) {} }); M = {}; V = null; }); };
    if (V.exporting) { toast("Cancel the export first."); return; }
    if (!V.undo.length || V.saved) return go();
    FX.confirmBox(r, "Toss this video?", "You haven't exported it.", [{ label: "Keep editing", v: 0 }, { label: "Toss it", v: 1, primary: true }]).then(function (v) { if (v) go(); });
  }
  function say(t) {
    var el = $("fxv-say"); if (!el) return;
    el.innerHTML = '<span class="fx-say__face" aria-hidden="true">😤</span><p>' + esc(t) + '</p><button class="fx-icon" type="button" aria-label="Dismiss">×</button>';
    el.hidden = false; el.querySelector("button").onclick = function () { el.hidden = true; };
    setTimeout(function () { el.hidden = true; }, 12000);
  }
  function commit() { var cur = JSON.stringify(V.st); if (cur === V.base) return false; V.undo.push(V.base); V.base = cur; V.redo = []; V.saved = false; paintHist(); return true; }
  function undo() { if (!V.undo.length) return; pause(); V.redo.push(V.base); V.base = V.undo.pop(); V.st = JSON.parse(V.base); V.sel = null; paintAll(); }
  function redo() { if (!V.redo.length) return; pause(); V.undo.push(V.base); V.base = V.redo.pop(); V.st = JSON.parse(V.base); V.sel = null; paintAll(); }
  function paintHist() { var r = root(); r.querySelector('[data-a="undo"]').disabled = !V.undo.length; r.querySelector('[data-a="redo"]').disabled = !V.redo.length; }
  function paintAll() { V.t = clamp(V.t, 0, total()); paintHist(); paintTimeline(); paintPanel(); paintTime(); V.size = null; seekPreview(); syncScroll(); }
  function paintTabs() { [].slice.call(root().querySelectorAll("#fxv-tabs [data-tab]")).forEach(function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === V.tab ? "true" : "false"); }); }
  function paintTime() {
    var tt = $("fxv-time"); if (tt) tt.textContent = fmtT(V.t) + " / " + fmtT(total());
    var d = outDims(), sub = $("fxv-sub"); if (sub) sub.textContent = V.st.clips.length ? V.st.clips.length + " clip" + (V.st.clips.length === 1 ? "" : "s") + " · " + V.st.aspect + " · " + d.w + "×" + d.h : "Video";
  }
  function syncScroll() { var tl = $("fxv-tl"); if (!tl) return; V.autoScroll = true; tl.scrollLeft = V.t * V.pps; setTimeout(function () { if (V) V.autoScroll = false; }, 60); }

  /* timeline: clips row, captions row, music row */
  function paintTimeline() {
    var tr = $("fxv-track"), tl = $("fxv-tl"); if (!tr || !V) return;
    var half = (tl.clientWidth || 360) / 2, T = total(), pps = V.pps, st = starts(), L = lens();
    tr.style.width = (T * pps + half * 2) + "px"; tr.style.paddingLeft = half + "px"; tr.style.paddingRight = half + "px";
    if (!V.st.clips.length) { tr.innerHTML = '<p class="fxv-empty">Add some clips, kid. ＋ below.</p>'; return; }
    var h = '<div class="fxv-row fxv-row--clips">' + V.st.clips.map(function (c, i) {
      var m = M[c.src] || {}, w = Math.max(18, L[i] * pps), th = m.thumbs || [], n = Math.max(1, Math.ceil(w / 40)), imgs = "";
      for (var k = 0; k < n && th.length; k++) imgs += '<img alt="" src="' + th[Math.min(th.length - 1, Math.floor((c.in + (k + 0.5) / n * (c.out - c.in)) / (m.dur || 1) * th.length))] + '" />';
      return '<div class="fxv-clip' + (V.sel === c.id ? " is-sel" : "") + '" data-clip="' + c.id + '" style="width:' + w + 'px">' + imgs +
        (c.speed !== 1 ? '<b class="fxv-badge">' + c.speed + "×</b>" : "") + (c.filter ? '<b class="fxv-badge fxv-badge--f">🎞️</b>' : "") +
        (V.sel === c.id ? '<i class="fxv-h fxv-h--l" data-h="l"></i><i class="fxv-h fxv-h--r" data-h="r"></i>' : "") + "</div>";
    }).join("") + "</div>";
    h += '<div class="fxv-row fxv-row--caps" style="width:' + T * pps + 'px">' + V.st.caps.map(function (cp) {
      return '<div class="fxv-cap' + (V.sel === cp.id ? " is-sel" : "") + '" data-cap="' + cp.id + '" style="left:' + cp.start * pps + "px;width:" + Math.max(14, (cp.end - cp.start) * pps) + 'px">' + esc(cp.text) + "</div>";
    }).join("") + "</div>";
    h += '<div class="fxv-row fxv-row--music" style="width:' + T * pps + 'px">' + (V.st.music ? '<div class="fxv-mus" data-mus="1">🎵 ' + esc(V.st.music.name) + "</div>" : "") + "</div>";
    tr.innerHTML = h;
    void st;
  }
  function onTrackDown(e) {
    if (!V || V.exporting) return;
    var h = e.target.closest("[data-h]"), cb = e.target.closest("[data-clip]"), cp = e.target.closest("[data-cap]"), mu = e.target.closest("[data-mus]");
    if (h && cb) { trimDrag(e, clipBy(cb.getAttribute("data-clip")), h.getAttribute("data-h")); return; }
    var x0 = e.clientX, moved = false, tl = $("fxv-tl");
    function mv(ev) { if (Math.abs(ev.clientX - x0) > 6) moved = true; }
    function up() {
      tl.removeEventListener("pointermove", mv); tl.removeEventListener("pointerup", up);
      if (moved) return;
      if (cb) { var id = cb.getAttribute("data-clip"); V.sel = V.sel === id ? null : id; V.tab = "clips"; }
      else if (cp) { V.sel = cp.getAttribute("data-cap"); V.tab = "text"; }
      else if (mu) { V.sel = null; V.tab = "music"; }
      else V.sel = null;
      paintTabs(); paintTimeline(); paintPanel();
    }
    tl.addEventListener("pointermove", mv); tl.addEventListener("pointerup", up);
  }
  function trimDrag(e, c, side) {
    e.preventDefault(); e.stopPropagation(); pause();
    var x0 = e.clientX, in0 = c.in, out0 = c.out, m = M[c.src], el = e.target;
    el.setPointerCapture && el.setPointerCapture(e.pointerId);
    function mv(ev) {
      var dt = (ev.clientX - x0) / V.pps * c.speed;
      if (side === "l") c.in = clamp(in0 + dt, 0, c.out - 0.2); else c.out = clamp(out0 + dt, c.in + 0.2, m ? m.dur : out0);
      paintTimeline(); var s = starts()[V.st.clips.indexOf(c)]; V.t = side === "l" ? s : s + (c.out - c.in) / c.speed - 0.01; paintTime(); seekPreview();
    }
    function up() { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); commit(); paintAll(); }
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  }
  function clipBy(id) { return V.st.clips.filter(function (c) { return c.id === id; })[0] || null; }
  function capBy(id) { return V.st.caps.filter(function (c) { return c.id === id; })[0] || null; }

  /* ---------- panels ---------- */
  function paintPanel() {
    var pn = $("fxv-panel"); if (!pn || !V) return;
    var t = V.tab, h = "", c = clipBy(V.sel), cp = capBy(V.sel);
    if (t === "clips") {
      if (c) {
        var sub = V.sub || "";
        h = '<div class="fx-row fx-row--tools">' + [["split", "✂️", "Split"], ["speed", "⏩", "Speed"], ["vol", "🔊", "Volume"], ["trim", "⇤⇥", "Trim"], ["left", "◀", "Move"], ["right", "▶", "Move"], ["dup", "⧉", "Copy"], ["del", "🗑", "Delete"]]
          .map(function (b) { return '<button class="fx-tool' + (sub === b[0] ? " is-on" : "") + '" type="button" data-c="' + b[0] + '"><span>' + b[1] + "</span>" + b[2] + "</button>"; }).join("") + "</div>";
        if (sub === "speed") h += '<p class="fx-cap">Speed ' + c.speed + "×</p>" + FX.sliderHTML("speed", 50, 200, Math.round(c.speed * 100), "Speed") + '<div class="fx-chips">' + [0.5, 0.75, 1, 1.5, 2].map(function (s) { return '<button type="button" class="fx-chip" data-spd="' + s + '" aria-pressed="' + (c.speed === s) + '">' + s + "×</button>"; }).join("") + "</div>";
        if (sub === "vol") h += '<p class="fx-cap">Clip volume</p>' + FX.sliderHTML("vol", 0, 200, c.vol, "Clip volume");
        if (sub === "trim") h += '<p class="fx-cap">Start ' + c.in.toFixed(1) + " s</p>" + FX.sliderHTML("tin", 0, Math.round((M[c.src] ? M[c.src].dur : c.out) * 10), Math.round(c.in * 10), "Trim start") +
          '<p class="fx-cap">End ' + c.out.toFixed(1) + " s</p>" + FX.sliderHTML("tout", 0, Math.round((M[c.src] ? M[c.src].dur : c.out) * 10), Math.round(c.out * 10), "Trim end") + '<p class="fx-note">Or drag the white edges on the clip.</p>';
      } else {
        h = '<div class="fx-row"><button class="fx-btn fx-btn--go" type="button" data-add="dev">＋ From iPhone</button><button class="fx-btn" type="button" data-add="lib">📚 From Library</button></div>' +
          '<p class="fx-note">' + (V.st.clips.length ? "Tap a clip to split, trim, speed it up or move it. Scroll the timeline to scrub." : "Pick a few clips. They play in order; I'll do the rest.") + "</p>";
      }
    } else if (t === "text") {
      if (cp) {
        h = '<input class="fx-ta" id="fxv-captext" maxlength="200" value="' + esc(cp.text) + '" aria-label="Caption text" />' +
          '<p class="fx-cap">Shows ' + fmtT(cp.start) + " → " + fmtT(cp.end) + "</p>" + FX.sliderHTML("cs", 0, Math.round(total() * 10), Math.round(cp.start * 10), "Caption start") + FX.sliderHTML("ce", 0, Math.round(total() * 10), Math.round(cp.end * 10), "Caption end") +
          '<div class="fx-chips">' + ["top", "middle", "bottom"].map(function (p) { return '<button type="button" class="fx-chip" data-pos="' + p + '" aria-pressed="' + (cp.pos === p) + '">' + p[0].toUpperCase() + p.slice(1) + "</button>"; }).join("") +
          '<button type="button" class="fx-chip" data-sty="stroke" aria-pressed="' + (cp.style !== "label") + '">Outline</button><button type="button" class="fx-chip" data-sty="label" aria-pressed="' + (cp.style === "label") + '">Label</button></div>' +
          '<div class="fx-chips">' + FX.FONTS.map(function (f) { return '<button type="button" class="fx-chip" data-font="' + f.id + '" aria-pressed="' + ((cp.font || "bold") === f.id) + '" style="font:' + f.css.replace("{s}", 15) + '">' + f.name + "</button>"; }).join("") + "</div>" +
          '<div class="fx-sw">' + FX.COLORS.map(function (col) { return '<button type="button" data-col="' + col + '" aria-pressed="' + (cp.color === col) + '" aria-label="Color ' + col + '" style="--c:' + col + '"></button>'; }).join("") + "</div>" +
          '<div class="fx-row"><button class="fx-btn fx-btn--warn" type="button" data-capdel>Delete caption</button></div>';
      } else {
        var ck = !!(FX.xaiKey() || FX.oaiKey());
        h = '<div class="fx-row"><button class="fx-btn fx-btn--go" type="button" data-capadd' + (V.st.clips.length ? "" : " disabled") + '>＋ Caption here</button><button class="fx-btn" type="button" data-auto' + (ck && V.st.clips.length ? "" : " disabled") + ">🪄 Auto captions</button></div>" +
          '<p class="fx-note">' + (ck ? "Auto captions send the clips' audio to " + (FX.xaiKey() ? "xAI speech-to-text" : "OpenAI Whisper") + " and time every line." : "Auto captions need an xAI or OpenAI key. Manual captions work anyway.") + "</p>" +
          (V.st.caps.length ? '<p class="fx-note">' + V.st.caps.length + " caption" + (V.st.caps.length === 1 ? "" : "s") + ". Tap one on the timeline to edit.</p>" : "");
      }
    } else if (t === "music") {
      var mu = V.st.music;
      h = '<div class="fx-row"><button class="fx-btn" type="button" data-mus="lib">📚 Library audio</button><button class="fx-btn" type="button" data-mus="beat">🥁 Beat Jam loop</button><button class="fx-btn" type="button" data-mus="dev">📁 From iPhone</button></div>';
      if (mu) h += '<p class="fx-cap">🎵 ' + esc(mu.name) + " · volume</p>" + FX.sliderHTML("mvol", 0, 100, mu.vol, "Music volume") +
        '<p class="fx-cap">Fade in ' + mu.fadeIn + " s</p>" + FX.sliderHTML("fin", 0, 50, Math.round(mu.fadeIn * 10), "Fade in") +
        '<p class="fx-cap">Fade out ' + mu.fadeOut + " s</p>" + FX.sliderHTML("fout", 0, 50, Math.round(mu.fadeOut * 10), "Fade out") +
        (mu.dur > 4 && !mu.loop ? '<p class="fx-cap">Start the song at ' + fmtT(mu.offset) + "</p>" + FX.sliderHTML("moff", 0, Math.round(Math.max(0, mu.dur - 1) * 10), Math.round(mu.offset * 10), "Song start") : "") +
        '<div class="fx-row"><button class="fx-btn fx-btn--warn" type="button" data-mus="rm">Remove music</button></div>';
      else h += '<p class="fx-note">Lay a track under it. Your clips keep their own sound (set per clip in Volume).</p>';
    } else if (t === "filters") {
      var tgt = c || V.st.clips[0], cur = tgt ? tgt.filter : "";
      h = '<div class="fx-filters"><button type="button" class="fx-fil" data-fil="" aria-pressed="' + !cur + '"><canvas width="64" height="64" data-th=""></canvas>Normal</button>' +
        FX.PRESETS.map(function (p) { return '<button type="button" class="fx-fil" data-fil="' + p.id + '" aria-pressed="' + (cur === p.id) + '"><canvas width="64" height="64" data-th="' + p.id + '"></canvas>' + esc(p.name) + "</button>"; }).join("") + "</div>" +
        (tgt && cur ? '<p class="fx-cap">Strength</p>' + FX.sliderHTML("famt", 0, 100, tgt.famt == null ? 100 : tgt.famt, "Filter strength") : "") +
        '<p class="fx-note">' + (c ? "Filtering the selected clip. " : "No clip selected: filters hit every clip. ") + '</p>' + (c ? '<div class="fx-row"><button class="fx-btn" type="button" data-fall>Apply to all clips</button></div>' : "");
    } else if (t === "format") {
      h = '<p class="fx-cap">Shape</p><div class="fx-chips">' + Object.keys(ASPECT).map(function (a) { return '<button type="button" class="fx-chip" data-asp="' + a + '" aria-pressed="' + (V.st.aspect === a) + '">' + a + (a === "9:16" ? " · Reels/TikTok" : a === "1:1" ? " · Square" : " · YouTube") + "</button>"; }).join("") + "</div>" +
        '<p class="fx-cap">Fit</p><div class="fx-chips">' + [["fill", "Fill (crop)"], ["blur", "Fit + blur"], ["black", "Fit + bars"]].map(function (f) { return '<button type="button" class="fx-chip" data-fit="' + f[0] + '" aria-pressed="' + (V.st.fit === f[0]) + '">' + f[1] + "</button>"; }).join("") + "</div>" +
        '<p class="fx-cap">Quality</p><div class="fx-chips">' + [720, 1080].map(function (q) { return '<button type="button" class="fx-chip" data-res="' + q + '" aria-pressed="' + (V.st.res === q) + '">' + q + "p</button>"; }).join("") + "</div>";
    }
    pn.innerHTML = h; wirePanel(pn, t, c, cp);
    if (t === "filters") paintThumbs(pn);
  }
  function wirePanel(pn, t, c, cp) {
    function sl(id, onIn, onCommit) { var el = pn.querySelector('[data-sl="' + id + '"]'); if (el) FX.wireSlider(el, onIn, onCommit || function () { commit(); paintAll(); }); }
    if (c) {
      sl("speed", function (v) { c.speed = Math.round(v / 5) * 5 / 100; paintTimeline(); paintTime(); });
      sl("vol", function (v) { c.vol = v; });
      sl("tin", function (v) { c.in = clamp(v / 10, 0, c.out - 0.2); paintTimeline(); V.t = starts()[V.st.clips.indexOf(c)]; seekPreview(); });
      sl("tout", function (v) { c.out = clamp(v / 10, c.in + 0.2, M[c.src] ? M[c.src].dur : 1e9); paintTimeline(); V.t = starts()[V.st.clips.indexOf(c)] + (c.out - c.in) / c.speed - 0.02; seekPreview(); });
    }
    if (cp) {
      sl("cs", function (v) { cp.start = clamp(v / 10, 0, cp.end - 0.2); paintTimeline(); V.t = cp.start + 0.01; seekPreview(); paintTime(); });
      sl("ce", function (v) { cp.end = clamp(v / 10, cp.start + 0.2, total()); paintTimeline(); V.t = cp.end - 0.02; seekPreview(); paintTime(); });
      var ti = pn.querySelector("#fxv-captext");
      if (ti) { ti.addEventListener("input", function () { cp.text = ti.value; paintTimeline(); renderPreview(); }); ti.addEventListener("change", function () { commit(); }); }
    }
    var mu = V.st.music;
    if (mu) {
      sl("mvol", function (v) { mu.vol = v; });
      sl("fin", function (v) { mu.fadeIn = v / 10; });
      sl("fout", function (v) { mu.fadeOut = v / 10; });
      sl("moff", function (v) { mu.offset = v / 10; });
    }
    sl("famt", function (v) { targets().forEach(function (x) { x.famt = v; }); renderPreview(); }, function () { commit(); });
    pn.onclick = function (e) {
      var b = e.target.closest("button"); if (!b || b.disabled || !V || V.exporting) return;
      var A = function (n) { return b.getAttribute(n); };
      if (A("data-c")) clipCmd(A("data-c"), c);
      else if (A("data-spd")) { c.speed = +A("data-spd"); commit(); paintAll(); }
      else if (A("data-add") === "dev") FX.pickFile("video/*", true).then(function (fs) { if (fs.length) addMedia(fs).then(function () { commit(); paintAll(); }); });
      else if (A("data-add") === "lib") FX.pickFromLibrary(root(), "video", "Pick a video").then(function (it) { if (it) addMedia([it]).then(function () { commit(); paintAll(); }); });
      else if (b.hasAttribute("data-capadd")) { var s = clamp(V.t, 0, Math.max(0, total() - 0.5)); var n = { id: uid("c"), text: "Wicked good", start: s, end: Math.min(total(), s + 2.5), pos: "bottom", style: "stroke", font: "bold", color: "#ffffff", size: 0.065 }; V.st.caps.push(n); V.sel = n.id; commit(); paintAll(); setTimeout(function () { var ti = $("fxv-captext"); if (ti) { ti.focus(); ti.select(); } }, 30); }
      else if (b.hasAttribute("data-auto")) FX.withKeys(autoCaptions);
      else if (b.hasAttribute("data-capdel")) { V.st.caps = V.st.caps.filter(function (x) { return x !== cp; }); V.sel = null; commit(); paintAll(); }
      else if (A("data-pos")) { cp.pos = A("data-pos"); commit(); paintPanel(); renderPreview(); }
      else if (A("data-sty")) { cp.style = A("data-sty"); commit(); paintPanel(); renderPreview(); }
      else if (A("data-font")) { cp.font = A("data-font"); commit(); paintPanel(); renderPreview(); }
      else if (A("data-col")) { cp.color = A("data-col"); commit(); paintPanel(); renderPreview(); }
      else if (A("data-mus") === "lib") FX.pickFromLibrary(root(), "audio", "Pick a track").then(function (it) { if (it) setMusicLib(it).then(function () { commit(); paintAll(); }); });
      else if (A("data-mus") === "beat") setMusicBeat().then(function () { commit(); paintAll(); });
      else if (A("data-mus") === "dev") FX.pickFile("audio/*", false).then(function (fs) { if (fs[0]) setMusicBlob(fs[0], fs[0].name.replace(/\.[a-z0-9]+$/i, "")).then(function () { commit(); paintAll(); }); });
      else if (A("data-mus") === "rm") { V.st.music = null; commit(); paintAll(); }
      else if (A("data-fil") != null) { targets().forEach(function (x) { x.filter = A("data-fil"); x.famt = 100; }); commit(); paintPanel(); renderPreview(); paintTimeline(); }
      else if (b.hasAttribute("data-fall")) { V.st.clips.forEach(function (x) { x.filter = c.filter; x.famt = c.famt; }); commit(); toast("Same look on every clip."); paintTimeline(); }
      else if (A("data-asp")) { V.st.aspect = A("data-asp"); commit(); paintAll(); }
      else if (A("data-fit")) { V.st.fit = A("data-fit"); commit(); paintAll(); }
      else if (A("data-res")) { V.st.res = +A("data-res"); commit(); paintAll(); }
    };
  }
  function targets() { var c = clipBy(V.sel); return c ? [c] : V.st.clips; }
  function clipCmd(cmd, c) {
    var cl = V.st.clips, i = cl.indexOf(c);
    if (cmd === "speed" || cmd === "vol" || cmd === "trim") { V.sub = V.sub === cmd ? "" : cmd; paintPanel(); return; }
    if (cmd === "split") {
      var s = segAt(V.t); if (!s || s.c !== c) { toast("Scrub the playhead onto this clip first."); return; }
      if (s.local - c.in < 0.15 || c.out - s.local < 0.15) { toast("Too close to the edge to split."); return; }
      var b = JSON.parse(JSON.stringify(c)); b.id = uid("v"); b.in = s.local; c.out = s.local; cl.splice(i + 1, 0, b); FX.tick();
    } else if (cmd === "left" && i > 0) { cl.splice(i, 1); cl.splice(i - 1, 0, c); }
    else if (cmd === "right" && i < cl.length - 1) { cl.splice(i, 1); cl.splice(i + 1, 0, c); }
    else if (cmd === "dup") { var d = JSON.parse(JSON.stringify(c)); d.id = uid("v"); cl.splice(i + 1, 0, d); }
    else if (cmd === "del") { cl.splice(i, 1); V.sel = null; }
    else return;
    var T = total(); V.st.caps.forEach(function (cp) { cp.end = Math.min(cp.end, T); cp.start = Math.min(cp.start, Math.max(0, cp.end - 0.2)); });
    V.st.caps = V.st.caps.filter(function (cp) { return cp.end - cp.start > 0.05; });
    commit(); paintAll();
  }
  function paintThumbs(pn) {
    var c = clipBy(V.sel) || V.st.clips[0], m = c && M[c.src]; if (!m || !m.el.videoWidth) return;
    var base = FX.canvas(64, 64), bx = FX.ctx2d(base); if (!bx) return;
    var k = Math.max(64 / m.el.videoWidth, 64 / m.el.videoHeight);
    try { bx.drawImage(m.el, (64 - m.el.videoWidth * k) / 2, (64 - m.el.videoHeight * k) / 2, m.el.videoWidth * k, m.el.videoHeight * k); } catch (e) { return; }
    [].slice.call(pn.querySelectorAll("canvas[data-th]")).forEach(function (cv, i) {
      setTimeout(function () { var p = FX.combine(c.adj, cv.getAttribute("data-th"), 1); var out = FX.processFrame(base, 64, 64, p), x = FX.ctx2d(cv); if (x) x.drawImage(out, 0, 0); }, i * 12);
    });
  }

  /* ---------- media in ---------- */
  function addMedia(list) {
    var r = root(), b = FX.busy(r, true, "Loading clips…"), i = 0, n = list.length;
    function one() {
      if (i >= n) return Promise.resolve();
      var it = list[i++]; b.prog(i / n, "Loading clip " + i + " of " + n + "…");
      var p = it && it.id && window.blarfLib ? window.blarfLib.blob(it.id).then(function (bl) { if (!bl) throw "That Library video is gone."; return register(bl, it.name); }) : register(it, it && it.name);
      return p.then(function (m) {
        V.st.clips.push({ id: uid("v"), src: m.key, name: m.name, in: 0, out: m.dur, speed: 1, vol: 100, filter: "", famt: 100, adj: {} });
      }, function (e) { toast(String(e)); }).then(one);
    }
    return one().then(function () { FX.busy(r, false); var T = total(); if (T > WARN_1080 && V.st.res === 1080) toast("Over 2 minutes: I'd export at 720p so Safari doesn't choke."); });
  }
  function setMusicBuffer(buf, name, loop, key) { V.st.music = { key: key, name: name, vol: 70, fadeIn: loop ? 0 : 1, fadeOut: 2, offset: 0, loop: !!loop, dur: buf ? buf.duration : 0 }; }
  function setMusicBlob(blob, name) {
    var key = uid("a"); M[key] = { key: key, blob: blob, name: name, url: "", audio: undefined };
    return decodeAudio(M[key]).then(function (buf) { if (!buf) { toast("Couldn't read that audio."); return; } setMusicBuffer(buf, name, false, key); });
  }
  function setMusicLib(it) { return window.blarfLib.blob(it.id).then(function (b) { if (!b) { toast("That track is gone."); return; } return setMusicBlob(b, it.name); }); }
  function setMusicBeat() {
    if (!C || !C.beatBuffer) { toast("Beat Jam isn't ready."); return Promise.resolve(); }
    return C.beatBuffer().then(function (buf) {
      if (!buf) { toast("Beat Jam couldn't render."); return; }
      var key = uid("a"); M[key] = { key: key, name: "Beat Jam", audio: buf };
      setMusicBuffer(buf, "Beat Jam loop · " + (C.S.beat ? C.S.beat.bpm : "") + " BPM", true, key);
    });
  }

  /* ---------- preview playback ---------- */
  function stageDims() {
    if (V.size) return V.size;
    var st = $("fxv-stage"), cv = $("fxv-cv"), d = outDims(), aw = (st.clientWidth || 360) - 16, ah = (st.clientHeight || 400) - 16;
    var k = Math.min(aw / d.w, ah / d.h), w = Math.max(40, Math.round(d.w * k)), h = Math.max(40, Math.round(d.h * k)), dpr = Math.min(1.5, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px";
    V.size = { w: cv.width, h: cv.height }; return V.size;
  }
  function renderPreview() {
    if (!V) return;
    var cv = $("fxv-cv"), x = FX.ctx2d(cv); if (!x) return;
    var z = stageDims();
    if (!V.st.clips.length) { x.fillStyle = "#000"; x.fillRect(0, 0, z.w, z.h); return; }
    var s = segAt(V.t); if (!s) return;
    compose(x, z.w, z.h, M[s.c.src].el, s.c, V.t);
  }
  function seekPreview() {
    if (!V || V.playing || !V.st.clips.length) { renderPreview(); return; }
    var s = segAt(V.t), m = s && M[s.c.src]; if (!m) return;
    var tok = (V.seekTok = (V.seekTok || 0) + 1);
    seekTo(m.el, s.local).then(function () { if (V && tok === V.seekTok) renderPreview(); });
  }
  var mAudio = null;
  function musicStart(t) {
    var mu = V.st.music; if (!mu) return;
    var m = M[mu.key]; if (!m || !m.audio) return;
    var ac = audioCtx(); if (!ac) return;
    try { if (ac.state === "suspended") ac.resume(); } catch (e) {}
    musicStop();
    var s = ac.createBufferSource(), g = ac.createGain(); s.buffer = m.audio; s.loop = !!mu.loop;
    var T = total(), v = mu.vol / 100, now = ac.currentTime;
    g.gain.setValueAtTime(t < mu.fadeIn ? v * t / mu.fadeIn : v, now);
    if (t < mu.fadeIn) g.gain.linearRampToValueAtTime(v, now + (mu.fadeIn - t));
    var fo = Math.max(t, T - mu.fadeOut); g.gain.setValueAtTime(v, now + (fo - t)); g.gain.linearRampToValueAtTime(0, now + (T - t));
    s.connect(g); g.connect(ac.destination);
    var off = mu.loop ? (t % m.audio.duration) : mu.offset + t;
    if (off < m.audio.duration || mu.loop) s.start(now, off);
    mAudio = s;
  }
  function musicStop() { if (mAudio) { try { mAudio.stop(); } catch (e) {} mAudio = null; } }
  function play() {
    if (!V.st.clips.length || V.exporting) return;
    if (V.t >= total() - 0.05) V.t = 0;
    V.playing = true; paintPlay();
    var s = segAt(V.t), i = s.i;
    /* inside the tap: give every clip's element a user-gesture play so later clips may play with sound */
    V.st.clips.forEach(function (c, k) { var e = M[c.src] && M[c.src].el; if (!e || k === i || e._unlocked) return; e._unlocked = true; try { var q = e.play(); e.pause(); if (q && q.catch) q.catch(function () {}); } catch (er) {} });
    musicStart(V.t);
    function runClip(idx, from) {
      if (!V || !V.playing) return;
      var c = V.st.clips[idx], m = M[c.src], el = m.el, st0 = starts()[idx];
      seekTo(el, from).then(function () {
        if (!V || !V.playing) return;
        el.muted = c.vol === 0; el.volume = clamp(c.vol / 100, 0, 1); el.playbackRate = c.speed;
        var p = el.play(); if (p && p.catch) p.catch(function () { el.muted = true; var p2 = el.play(); if (p2 && p2.catch) p2.catch(function () { pause(); toast("Tap play again (Safari blocked it)."); }); });
        (function loop() {
          if (!V || !V.playing) { el.pause(); return; }
          V.t = st0 + (el.currentTime - c.in) / c.speed;
          renderPreview(); paintTime(); syncScroll();
          if (el.currentTime >= c.out - 0.03 || el.ended) {
            el.pause();
            if (idx + 1 < V.st.clips.length) runClip(idx + 1, V.st.clips[idx + 1].in);
            else { V.t = total(); pause(); }
            return;
          }
          V.raf = requestAnimationFrame(loop);
        })();
      });
    }
    runClip(i, s.local);
  }
  function pause() {
    if (!V) return;
    V.playing = false; cancelAnimationFrame(V.raf); musicStop();
    Object.keys(M).forEach(function (k) { if (M[k].el) try { M[k].el.pause(); M[k].el.muted = true; } catch (e) {} });
    paintPlay(); paintTime();
  }
  function paintPlay() { var b = root().querySelector('[data-a="play"]'); if (b) { b.textContent = V && V.playing ? "❚❚" : "▶"; b.setAttribute("aria-label", V && V.playing ? "Pause" : "Play"); } }

  /* ---------- audio mix (offline, exact) ---------- */
  function mixAudio(sr, ch, clipsOnly, st) {
    st = st || V.st;
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!OAC) return Promise.resolve(null);
    var T = totalOf(st); if (!T) return Promise.resolve(null);
    var srcs = {}; st.clips.forEach(function (c) { srcs[c.src] = 1; });
    return Promise.all(Object.keys(srcs).map(function (k) { return M[k] ? decodeAudio(M[k]) : null; })).then(function () {
      var oc; try { oc = new OAC(ch, Math.ceil(T * sr), sr); } catch (e) { return null; }
      var any = false, t0 = 0;
      st.clips.forEach(function (c) {
        var m = M[c.src], b = m && m.audio, len = (c.out - c.in) / c.speed;
        if (b && c.vol > 0 && c.in < b.duration) {
          var s = oc.createBufferSource(), g = oc.createGain(); s.buffer = b; s.playbackRate.value = c.speed; g.gain.value = c.vol / 100;
          s.connect(g); g.connect(oc.destination); s.start(t0, c.in, Math.min(c.out, b.duration) - c.in); any = true;
        }
        t0 += len;
      });
      var mu = st.music, mm = mu && M[mu.key];
      if (!clipsOnly && mu && mm && mm.audio && mu.vol > 0) {
        var s2 = oc.createBufferSource(), g2 = oc.createGain(), v = mu.vol / 100; s2.buffer = mm.audio; s2.loop = !!mu.loop;
        g2.gain.setValueAtTime(mu.fadeIn > 0 ? 0 : v, 0); if (mu.fadeIn > 0) g2.gain.linearRampToValueAtTime(v, Math.min(T, mu.fadeIn));
        if (mu.fadeOut > 0) { g2.gain.setValueAtTime(v, Math.max(0, T - mu.fadeOut)); g2.gain.linearRampToValueAtTime(0, T); }
        s2.connect(g2); g2.connect(oc.destination); s2.start(0, mu.loop ? 0 : Math.min(mu.offset, Math.max(0, mm.audio.duration - 0.01))); any = true;
      }
      if (!any) return null;
      return new Promise(function (ok) { oc.oncomplete = function (e) { ok(e.renderedBuffer); }; try { var p = oc.startRendering(); if (p && p.then) p.then(ok, function () { ok(null); }); } catch (e) { ok(null); } });
    });
  }
  function totalOf(st) { return st.clips.reduce(function (a, c) { return a + Math.max(0, (c.out - c.in) / c.speed); }, 0); }
  function wav(buf) {
    var d = buf.getChannelData(0), n = d.length, sr = buf.sampleRate, ab = new ArrayBuffer(44 + n * 2), v = new DataView(ab), o = 0;
    function str(s) { for (var i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i)); }
    function u32(x) { v.setUint32(o, x, true); o += 4; } function u16(x) { v.setUint16(o, x, true); o += 2; }
    str("RIFF"); u32(36 + n * 2); str("WAVE"); str("fmt "); u32(16); u16(1); u16(1); u32(sr); u32(sr * 2); u16(2); u16(16); str("data"); u32(n * 2);
    for (var i = 0; i < n; i++) { var x = Math.max(-1, Math.min(1, d[i])); v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
    return new Blob([ab], { type: "audio/wav" });
  }

  /* ---------- auto captions: xAI grok-voice-transcribe-2.0 (/v1/stt, word timings) or OpenAI whisper-1 verbose_json words ---------- */
  var XAI_STT = "https://api.x.ai/v1/stt", OAI_STT = "https://api.openai.com/v1/audio/transcriptions";
  function groupWords(words, T) {
    var caps = [], cur = null;
    (words || []).forEach(function (w) {
      var tx = String(w.text != null ? w.text : w.word || "").trim(), s = +w.start, e = +w.end; if (!tx || !isFinite(s)) return;
      if (!isFinite(e) || e < s) e = s + 0.3;
      if (cur && (cur.n >= 5 || e - cur.start > 2.6 || s - cur.end > 0.6 || /[.!?]$/.test(cur.text))) { caps.push(cur); cur = null; }
      if (!cur) cur = { start: s, end: e, text: tx, n: 1 }; else { cur.text += " " + tx; cur.end = e; cur.n++; }
    });
    if (cur) caps.push(cur);
    return caps.map(function (c) { return { id: uid("c"), text: c.text, start: Math.max(0, c.start), end: Math.min(T || 1e9, Math.max(c.end, c.start + 0.6)), pos: "bottom", style: "stroke", font: "bold", color: "#ffffff", size: 0.065, auto: true }; });
  }
  function autoCaptions() {
    var r = root(), T = total(); if (!T) return;
    if (T > MAX_TOTAL) { toast("Too long for auto captions (10 min max)."); return; }
    if (FX.offline()) { toast("You're offline."); return; }
    var live = true, ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    FX.busy(r, true, "Listenin' to your clips…", function () { live = false; if (ctrl) ctrl.abort(); FX.busy(r, false); });
    mixAudio(16000, 1, true).then(function (buf) {
      if (!buf) throw "These clips have no sound to caption.";
      var blob = wav(buf), fd = new FormData(), xk = FX.xaiKey(), url, key;
      if (xk) { url = XAI_STT; key = xk; fd.append("model", "grok-voice-transcribe-2.0"); fd.append("format", "true"); fd.append("language", "en"); fd.append("file", blob, "clips.wav"); }
      else { url = OAI_STT; key = FX.oaiKey(); fd.append("model", "whisper-1"); fd.append("response_format", "verbose_json"); fd.append("timestamp_granularities[]", "word"); fd.append("file", blob, "clips.wav"); }
      return FX.fetchJSON(url, { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd }, 180000, ctrl);
    }).then(function (d) {
      if (!live || !V) return; FX.busy(r, false);
      var caps = groupWords(d && d.words, T);
      if (!caps.length) { toast("Didn't hear any words in there."); return; }
      V.st.caps = V.st.caps.filter(function (c) { return !c.auto; }).concat(caps); commit(); paintAll();
      toast("🪄 " + caps.length + " captions. Tap one to fix it.");
    }).catch(function (e) { FX.busy(r, false); if (live) toast(String(e)); });
  }

  /* ---------- export ---------- */
  function loadMuxer() {
    if (window.Mp4Muxer) return Promise.resolve(window.Mp4Muxer);
    return new Promise(function (ok, no) { var s = doc.createElement("script"); s.src = MUXER_URL; s.onload = function () { window.Mp4Muxer ? ok(window.Mp4Muxer) : no("Muxer failed to load."); }; s.onerror = function () { no("Couldn't load the MP4 muxer."); }; doc.head.appendChild(s); });
  }
  var AVC = ["avc1.42E033", "avc1.42E032", "avc1.42E028", "avc1.42E01F"]; /* Constrained Baseline, levels 5.1 / 5.0 / 4.0 / 3.1 */
  function pickVideoCfg(W, H) {
    if (typeof VideoEncoder === "undefined" || !VideoEncoder.isConfigSupported) return Promise.resolve(null);
    var br = W * H >= 1920 * 1080 * 0.9 ? 9e6 : 5e6, i = 0;
    function next() {
      if (i >= AVC.length) return null;
      var cfg = { codec: AVC[i++], width: W, height: H, bitrate: br, framerate: FPS, avc: { format: "avc" }, latencyMode: "quality" };
      return VideoEncoder.isConfigSupported(cfg).then(function (r) { return r && r.supported ? cfg : next(); }, next);
    }
    return Promise.resolve(next());
  }
  function pickAudioCfg(sr, ch) {
    if (typeof AudioEncoder === "undefined" || !AudioEncoder.isConfigSupported) return Promise.resolve(null);
    var list = [{ codec: "mp4a.40.2", sampleRate: sr, numberOfChannels: ch, bitrate: 160000, mux: "aac" }, { codec: "opus", sampleRate: sr, numberOfChannels: ch, bitrate: 128000, mux: "opus" }], i = 0;
    function next() { if (i >= list.length) return null; var c = list[i++]; return AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: sr, numberOfChannels: ch, bitrate: c.bitrate }).then(function (r) { return r && r.supported ? c : next(); }, next); }
    return Promise.resolve(next());
  }
  /* WebKit hands AudioEncoder's AAC description as a full ES_Descriptor (0x03 ...); MP4 needs the bare 2-byte AudioSpecificConfig */
  var SR_IDX = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function aacASC(sr, ch) { var fi = SR_IDX.indexOf(sr); if (fi < 0) fi = 3; var v = (2 << 11) | (fi << 7) | (ch << 3); return new Uint8Array([v >> 8, v & 255]); }
  function fixAacMeta(meta, sr, ch) {
    if (!meta || !meta.decoderConfig) return meta;
    var d = meta.decoderConfig.description, u = d ? (d instanceof Uint8Array ? d : new Uint8Array(d.buffer || d)) : null;
    if (!u || u.length !== 2 || u[0] === 0x03) {
      var dc = {}; for (var k in meta.decoderConfig) dc[k] = meta.decoderConfig[k];
      dc.description = aacASC(sr, ch); return { decoderConfig: dc };
    }
    return meta;
  }
  function startExport() {
    if (!V || V.exporting) return;
    pause();
    var T = total(); if (!T) { toast("Add a clip first."); return; }
    if (T > MAX_TOTAL) { toast("10 minutes max in here. Trim it down."); return; }
    var r = root(), go = function (res) { if (res) { V.st.res = res; commit(); paintAll(); } runExport(); };
    if (V.st.res === 1080 && T > WARN_1080) {
      FX.confirmBox(r, "That's a long one", Math.round(T) + " seconds at 1080p can run Safari out of memory. 720p is way safer.", [{ label: "720p (safe)", v: 720, primary: true }, { label: "Try 1080p", v: -1 }, { label: "Cancel", v: 0 }])
        .then(function (v) { if (v === 720) go(720); else if (v === -1) go(0); });
    } else go(0);
  }
  function runExport() {
    var r = root(), st = JSON.parse(JSON.stringify(V.st)), T = totalOf(st), d = outDims(st), W = d.w, H = d.h;
    V.exporting = true; var job = { stop: false };
    var cancel = function () { job.stop = true; FX.busy(r, true, "Stopping…"); };
    var bz = FX.busy(r, true, "Mixing the audio…", cancel); bz.prog(0);
    var out = FX.canvas(W, H), ox = FX.ctx2d(out);
    if (C && C.act) C.act("onit");
    Promise.all([pickVideoCfg(W, H), mixAudio(48000, 2, false, st)]).then(function (a) {
      var vcfg = a[0], mix = a[1];
      if (job.stop) throw "cancel";
      return (mix ? pickAudioCfg(48000, 2) : Promise.resolve(null)).then(function (acfg) {
        if (vcfg && (!mix || acfg)) return loadMuxer().then(function (Mx) { return webcodecs(Mx, vcfg, acfg, mix, st, T, W, H, out, ox, job, bz); });
        if (typeof MediaRecorder !== "undefined" && out.captureStream) return recorder(mix, st, T, W, H, out, ox, job, bz);
        throw "This browser can't export video (needs iOS 16.4+ / a recent Safari).";
      });
    }).then(function (res) {
      V.exporting = false; FX.busy(r, false);
      if (C && C.act) C.act("proud");
      showResult(res);
    }, function (e) {
      V.exporting = false; FX.busy(r, false);
      Object.keys(M).forEach(function (k) { if (M[k].el) try { M[k].el.pause(); } catch (er) {} });
      if (e !== "cancel" && !job.stop) toast(String(e && e.message || e)); else toast("Export cancelled.");
      seekPreview();
    });
  }
  /* play one clip from in to out, calling onFrame(outT) for every decoded frame */
  function playClip(c, t0, job, onFrame) {
    var m = M[c.src], el = m.el;
    return seekTo(el, c.in).then(function () {
      return new Promise(function (ok, no) {
        var done = false, lastProg = Date.now(), wd;
        el.muted = true; el.playbackRate = c.speed;
        function fin(err) { if (done) return; done = true; clearInterval(wd); try { el.pause(); } catch (e) {} if (err) no(err); else ok(); }
        function frame(mt) {
          if (done) return;
          if (job.stop) return fin("cancel");
          if (mt >= c.out - 0.001 || el.ended) return fin();
          lastProg = Date.now();
          try { onFrame(t0 + Math.max(0, mt - c.in) / c.speed); } catch (e) { fin(e); }
        }
        onFrame(t0);
        if (el.requestVideoFrameCallback) { var cb = function (now, meta) { frame(meta && meta.mediaTime != null ? meta.mediaTime : el.currentTime); if (!done) el.requestVideoFrameCallback(cb); }; el.requestVideoFrameCallback(cb); }
        else (function poll() { if (done) return; frame(el.currentTime); requestAnimationFrame(poll); })();
        wd = setInterval(function () {
          if (el.currentTime >= c.out - 0.05 || el.ended) return fin();
          if (Date.now() - lastProg > 9000) fin(doc.hidden ? "Export stopped: keep Blarf open on screen while it renders." : "Playback stalled on a clip.");
        }, 500);
        var p = el.play(); if (p && p.catch) p.catch(function () { fin("Safari wouldn't play the clip for export."); });
      });
    });
  }
  function webcodecs(Mx, vcfg, acfg, mix, st, T, W, H, out, ox, job, bz) {
    var target = new Mx.ArrayBufferTarget(), muxer = new Mx.Muxer({ target: target, fastStart: "in-memory", firstTimestampBehavior: "offset",
      video: { codec: "avc", width: W, height: H, frameRate: FPS }, audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined });
    var err = null, venc = new VideoEncoder({ output: function (ch, meta) { muxer.addVideoChunk(ch, meta); }, error: function (e) { err = e; } });
    venc.configure({ codec: vcfg.codec, width: W, height: H, bitrate: vcfg.bitrate, framerate: FPS, avc: { format: "avc" }, latencyMode: "quality" });
    var aDone = Promise.resolve();
    if (acfg && mix) {
      bz.prog(0.02, "Encoding the audio…");
      var aenc = new AudioEncoder({ output: function (ch, meta) { muxer.addAudioChunk(ch, acfg.mux === "aac" ? fixAacMeta(meta, 48000, 2) : meta); }, error: function (e) { err = e; } });
      aenc.configure({ codec: acfg.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: acfg.bitrate });
      var L = mix.getChannelData(0), R = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L, N = 4800;
      for (var i = 0; i < mix.length; i += N) {
        var n = Math.min(N, mix.length - i), pl = new Float32Array(n * 2); pl.set(L.subarray(i, i + n), 0); pl.set(R.subarray(i, i + n), n);
        var ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / 48000 * 1e6), data: pl });
        aenc.encode(ad); ad.close();
      }
      aDone = aenc.flush().then(function () { aenc.close(); });
    }
    var next = 0, lastKey = -10, count = 0, dropped = 0, starts0 = [], s = 0;
    st.clips.forEach(function (c) { starts0.push(s); s += (c.out - c.in) / c.speed; });
    function onFrame(c) {
      return function (t) {
        if (err) throw err;
        if (t < next - 0.5 / FPS || t > T) return;
        if (venc.encodeQueueSize > 8) { dropped++; return; }
        compose(ox, W, H, M[c.src].el, c, t, st);
        var f = new VideoFrame(out, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
        var key = t - lastKey >= 2; if (key) lastKey = t;
        venc.encode(f, { keyFrame: key }); f.close(); count++;
        next = t + 1 / FPS;
        bz.prog(0.05 + 0.9 * t / T, "Rendering " + Math.round(100 * t / T) + "% · keep Blarf open");
      };
    }
    var chain = aDone;
    st.clips.forEach(function (c, i) { chain = chain.then(function () { if (job.stop) throw "cancel"; return playClip(c, starts0[i], job, onFrame(c)); }); });
    return chain.then(function () {
      if (err) throw err;
      bz.prog(0.97, "Finishing the MP4…");
      return venc.flush();
    }).then(function () {
      venc.close(); muxer.finalize();
      if (!count) throw "No frames came out. Try 720p.";
      return { blob: new Blob([target.buffer], { type: "video/mp4" }), ext: "mp4", how: "WebCodecs" + (dropped ? " · " + dropped + " frames skipped" : "") };
    }, function (e) { try { venc.close(); } catch (er) {} throw e; });
  }
  function recorder(mix, st, T, W, H, out, ox, job, bz) {
    var mime = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].filter(function (t) { try { return MediaRecorder.isTypeSupported(t); } catch (e) { return false; } })[0] || "";
    var stream = out.captureStream(FPS), ac = null, asrc = null;
    if (mix) {
      var A = window.AudioContext || window.webkitAudioContext;
      try { ac = new A({ sampleRate: 48000 }); } catch (e) { ac = A ? new A() : null; }
      if (ac && ac.createMediaStreamDestination) { var dest = ac.createMediaStreamDestination(); asrc = ac.createBufferSource(); asrc.buffer = mix; asrc.connect(dest); dest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); }); }
    }
    var rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: W * H > 1e6 ? 8e6 : 5e6 } : undefined), chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var stopped = new Promise(function (ok) { rec.onstop = ok; });
    compose(ox, W, H, M[st.clips[0].src].el, st.clips[0], 0, st);
    rec.start(1000);
    var s = 0, chain = Promise.resolve(), started = false;
    st.clips.forEach(function (c) {
      var t0 = s; s += (c.out - c.in) / c.speed;
      chain = chain.then(function () {
        if (job.stop) throw "cancel";
        if (started) { try { rec.pause(); } catch (e) {} if (ac) ac.suspend(); }
        return seekTo(M[c.src].el, c.in).then(function () {
          try { if (rec.state === "paused") rec.resume(); } catch (e) {}
          if (ac) { if (!started && asrc) asrc.start(); ac.resume(); }
          started = true;
          return playClip(c, t0, job, function (t) { compose(ox, W, H, M[c.src].el, c, t, st); bz.prog(t / T, "Recording " + Math.round(100 * t / T) + "% · keep Blarf open"); });
        });
      });
    });
    return chain.then(function () { rec.stop(); return stopped; }, function (e) { try { rec.stop(); } catch (er) {} throw e; }).then(function () {
      if (ac) try { ac.close(); } catch (e) {}
      var type = (mime || "video/mp4").split(";")[0];
      return { blob: new Blob(chunks, { type: type }), ext: /webm/.test(type) ? "webm" : "mp4", how: "Recorder" };
    });
  }
  function showResult(res) {
    var r = root(), sh = doc.createElement("div"), url = URL.createObjectURL(res.blob), name = "blarf-fx-" + FX.stamp() + "." + res.ext;
    sh.className = "fx-sheet";
    sh.innerHTML = '<div class="fx-sheet__card"><div class="fx-pick__head"><b>🎬 It\'s done, kid</b><button class="fx-icon" type="button" data-x aria-label="Close">×</button></div>' +
      '<video class="fxv-result" controls playsinline src="' + url + '"></video><p class="fx-note">' + (res.blob.size / 1048576).toFixed(1) + " MB · " + res.ext.toUpperCase() + " · " + esc(res.how) + "</p>" +
      '<div class="fx-row"><button class="fx-btn fx-btn--go" type="button" data-s="lib">Save to Library</button><button class="fx-btn" type="button" data-s="share">Share…</button></div></div>';
    sh.addEventListener("click", function (e) {
      if (e.target === sh || e.target.closest("[data-x]")) { sh.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); return; }
      var b = e.target.closest("[data-s]"); if (!b) return;
      if (b.getAttribute("data-s") === "lib") FX.saveToLibrary(res.blob, name).then(function () { V.saved = true; toast("🎬 Saved to Library › Studio FX"); b.disabled = true; }, function (er) { toast(String(er)); });
      else FX.shareBlob(res.blob, name, "Blarf Studio FX").then(function (x) { if (x !== "cancel") V.saved = true; }, function () { toast("Share failed."); });
    });
    r.appendChild(sh);
  }

  window.blarfVideo = {
    open: open,
    _t: { V: function () { return V; }, M: function () { return M; }, register: register, total: function () { return total(); }, segAt: segAt, starts: starts, outDims: outDims, clipCmd: clipCmd, commit: function () { return commit(); }, undo: undo, redo: redo,
      groupWords: groupWords, aacASC: aacASC, fixAacMeta: fixAacMeta, mixAudio: mixAudio, compose: compose, startExport: startExport, autoCaptions: autoCaptions, setMusicBeat: setMusicBeat, wrap: wrap, paintPanel: function () { paintPanel(); }, setTab: function (t) { V.tab = t; paintTabs(); paintPanel(); }, select: function (id) { V.sel = id; paintPanel(); } }
  };
})();

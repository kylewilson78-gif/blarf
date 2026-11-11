/* Blarf OS P3b: Studio FX. Shared FX core (adjustments, 12 presets, WebGL renderer with a CPU fallback, overlays)
   + the photo editor. The video editor (blarf-video.js) reuses window.blarfFX. Everything runs on this iPhone;
   only "Ask Blarf to edit", "Blarf's take" and auto captions call Kyle's own AI provider. */
(function () {
  "use strict";
  var doc = document, C = null;
  function $(id) { return doc.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(t) { if (C) C.toast(t); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function uid(p) { return (p || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function S() { return C ? C.S : {}; }
  function calm() { try { return C ? C.calm() : false; } catch (e) { return false; } }
  function tick() { try { if (navigator.vibrate) navigator.vibrate(4); } catch (e) {} }
  var MAX_PX = 16777216; /* iOS Safari canvas area limit (4096²): exports are full-res up to 16 MP */
  var STUDIO = "f-fx";

  /* ---------- adjustments + the 12 presets ---------- */
  var ADJ = [
    { id: "exposure", label: "Exposure", icon: "☀️" }, { id: "contrast", label: "Contrast", icon: "◐" },
    { id: "saturation", label: "Saturation", icon: "🎨" }, { id: "warmth", label: "Warmth", icon: "🌡️" },
    { id: "tint", label: "Tint", icon: "💧" }, { id: "highlights", label: "Highlights", icon: "🔆" },
    { id: "shadows", label: "Shadows", icon: "🌑" }, { id: "vignette", label: "Vignette", icon: "⭕" },
    { id: "sharpen", label: "Sharpen", icon: "🔪", min: 0 }, { id: "grain", label: "Grain", icon: "🎞️", min: 0 }
  ];
  /* p values are -1..1 (same scale as a slider at ±100); split = [shadow rgb, highlight rgb] tint offsets */
  var PRESETS = [
    { id: "southie", name: "Southie", p: { contrast: 0.25, saturation: 0.12, warmth: 0.28, vignette: 0.3, grain: 0.15 } },
    { id: "dotave", name: "Dot Ave", p: { contrast: 0.35, saturation: -0.38, grain: 0.38, vignette: 0.38, sharpen: 0.3, fade: 0.1 } },
    { id: "greenline", name: "Green Line", p: { tint: -0.35, saturation: -0.12, fade: 0.22, contrast: 0.1, split: [-0.04, 0.05, 0.04, 0.03, 0.02, -0.03] } },
    { id: "fenway", name: "Fenway Dusk", p: { saturation: 0.2, warmth: 0.35, tint: 0.15, highlights: -0.1, split: [0.02, -0.02, 0.05, 0.07, 0.02, -0.05] } },
    { id: "masspike", name: "Mass Pike", p: { warmth: -0.35, contrast: 0.2, saturation: -0.1, highlights: -0.2, sharpen: 0.15 } },
    { id: "noreaster", name: "Nor'easter", p: { saturation: -0.6, warmth: -0.4, fade: 0.25, grain: 0.22, exposure: 0.05 } },
    { id: "harborfog", name: "Harbor Fog", p: { fade: 0.45, contrast: -0.2, saturation: -0.25, warmth: -0.1, highlights: 0.15 } },
    { id: "packie", name: "Packie Neon", p: { saturation: 0.5, contrast: 0.3, tint: 0.25, vignette: 0.42, split: [0.05, -0.03, 0.09, -0.04, 0.05, 0.08] } },
    { id: "bigdig", name: "Big Dig", p: { mono: 1, contrast: 0.45, grain: 0.45, sharpen: 0.3, vignette: 0.45 } },
    { id: "chowdah", name: "Chowdah", p: { fade: 0.3, warmth: 0.3, saturation: -0.15, shadows: 0.2, exposure: 0.05 } },
    { id: "dunks", name: "Dunks Run", p: { warmth: 0.2, tint: 0.2, saturation: 0.35, exposure: 0.1, split: [0.06, -0.02, 0.04, 0.08, 0.03, -0.04] } },
    { id: "pissah", name: "Wicked Pissah", p: { contrast: 0.4, saturation: 0.4, shadows: 0.35, highlights: -0.35, sharpen: 0.5, vignette: 0.2 } }
  ];
  var PBY = {}; PRESETS.forEach(function (p) { PBY[p.id] = p; });
  var KEYS = ["exposure", "contrast", "saturation", "warmth", "tint", "highlights", "shadows", "vignette", "sharpen", "grain", "fade", "mono"];
  /* user sliders (-100..100) + preset at amount (0..1) -> one params object for the shader */
  function combine(adj, filter, amt) {
    adj = adj || {}; var pr = PBY[filter], a = amt == null ? 1 : +amt, o = { split: [0, 0, 0, 0, 0, 0] };
    KEYS.forEach(function (k) { o[k] = clamp((+(adj[k] || 0)) / 100 + (pr && pr.p[k] ? pr.p[k] * a : 0), -1, 1); });
    if (pr && pr.p.split) for (var i = 0; i < 6; i++) o.split[i] = pr.p.split[i] * a;
    return o;
  }
  function isIdentity(P) {
    if (!P) return true;
    for (var i = 0; i < KEYS.length; i++) if (Math.abs(P[KEYS[i]] || 0) > 1e-4) return false;
    for (var j = 0; j < 6; j++) if (Math.abs(P.split[j] || 0) > 1e-4) return false;
    return true;
  }

  /* ---------- the pixel math: one GLSL shader, mirrored in JS for no-WebGL / oversized images ---------- */
  var VS = "attribute vec2 p;varying vec2 uv;void main(){uv=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}";
  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\nvarying vec2 uv;uniform sampler2D t;uniform vec2 px;uniform vec2 res;",
    "uniform float ex,co,sa,wa,ti,hi,sh,vi,sp,gr,fa,mo,seed;uniform vec3 sS,sH;",
    "float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}",
    "void main(){vec4 s=texture2D(t,uv);vec3 c=s.rgb;",
    "if(sp>0.){vec3 b=(texture2D(t,uv+vec2(px.x,0.)).rgb+texture2D(t,uv-vec2(px.x,0.)).rgb+texture2D(t,uv+vec2(0.,px.y)).rgb+texture2D(t,uv-vec2(0.,px.y)).rgb)*.25;c+=(c-b)*sp*1.5;}",
    "c*=exp2(ex);float L=clamp(lum(c),0.,1.);",
    "c+=sh*(1.-L)*(1.-L)*.5;c+=hi*L*L*.5;",
    "c=(c-.5)*(1.+co)+.5;",
    "c.r+=wa*.08;c.b-=wa*.08;c.g-=ti*.06;c.r+=ti*.02;c.b+=ti*.02;",
    "L=lum(c);c=mix(vec3(L),c,1.+sa);c=mix(c,vec3(L),mo);",
    "L=clamp(lum(c),0.,1.);c+=sS*(1.-L)+sH*L;",
    "c=c*(1.-fa*.25)+fa*.12;",
    "float d=distance(uv,vec2(.5))*1.2;c*=1.-vi*smoothstep(.25,.85,d);",
    "if(gr>0.){float n=fract(sin(dot(mod(floor(uv*res),256.)+seed,vec2(12.9898,78.233)))*43758.5453);c+=(n-.5)*gr*.18;}",
    "gl_FragColor=vec4(clamp(c,0.,1.),s.a);}"
  ].join("\n");
  function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function fract(x) { return x - Math.floor(x); }
  /* JS twin of FS. d = Uint8ClampedArray RGBA, modified in place */
  function cpuApply(d, w, h, P) {
    var src = P.sharpen > 0 ? new Uint8ClampedArray(d) : d, sp = Math.max(0, P.sharpen), gr = Math.max(0, P.grain);
    var ex = Math.pow(2, P.exposure), co = P.contrast, sa = P.saturation, wa = P.warmth, ti = P.tint, hi = P.highlights, sh = P.shadows,
      vi = P.vignette, fa = P.fade, mo = P.mono, sp6 = P.split, seed = P.seed || 0;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4, r = src[i] / 255, g = src[i + 1] / 255, b = src[i + 2] / 255;
      if (sp > 0) {
        var l = (y * w + Math.max(0, x - 1)) * 4, rr = (y * w + Math.min(w - 1, x + 1)) * 4, u = (Math.max(0, y - 1) * w + x) * 4, dn = (Math.min(h - 1, y + 1) * w + x) * 4;
        r += (r - (src[l] + src[rr] + src[u] + src[dn]) / 1020) * sp * 1.5;
        g += (g - (src[l + 1] + src[rr + 1] + src[u + 1] + src[dn + 1]) / 1020) * sp * 1.5;
        b += (b - (src[l + 2] + src[rr + 2] + src[u + 2] + src[dn + 2]) / 1020) * sp * 1.5;
      }
      r *= ex; g *= ex; b *= ex;
      var L = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1), k = sh * (1 - L) * (1 - L) * 0.5 + hi * L * L * 0.5;
      r += k; g += k; b += k;
      r = (r - 0.5) * (1 + co) + 0.5; g = (g - 0.5) * (1 + co) + 0.5; b = (b - 0.5) * (1 + co) + 0.5;
      r += wa * 0.08 + ti * 0.02; b += -wa * 0.08 + ti * 0.02; g -= ti * 0.06;
      L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = L + (r - L) * (1 + sa); g = L + (g - L) * (1 + sa); b = L + (b - L) * (1 + sa);
      r += (L - r) * mo; g += (L - g) * mo; b += (L - b) * mo;
      L = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      r += sp6[0] * (1 - L) + sp6[3] * L; g += sp6[1] * (1 - L) + sp6[4] * L; b += sp6[2] * (1 - L) + sp6[5] * L;
      r = r * (1 - fa * 0.25) + fa * 0.12; g = g * (1 - fa * 0.25) + fa * 0.12; b = b * (1 - fa * 0.25) + fa * 0.12;
      var ux = (x + 0.5) / w - 0.5, uy = (y + 0.5) / h - 0.5, vv = 1 - vi * smooth(0.25, 0.85, Math.sqrt(ux * ux + uy * uy) * 1.2);
      r *= vv; g *= vv; b *= vv;
      if (gr > 0) { var n = fract(Math.sin(((x % 256) + seed) * 12.9898 + ((y % 256) + seed) * 78.233) * 43758.5453) - 0.5; r += n * gr * 0.18; g += n * gr * 0.18; b += n * gr * 0.18; }
      d[i] = clamp(r, 0, 1) * 255; d[i + 1] = clamp(g, 0, 1) * 255; d[i + 2] = clamp(b, 0, 1) * 255;
    }
    return d;
  }
  function canvas(w, h) { var c = doc.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function ctx2d(c) { try { return c.getContext("2d"); } catch (e) { return null; } }
  var GL = null, glDead = false;
  function glInit() {
    if (GL || glDead) return GL;
    var cv = canvas(2, 2), gl = null;
    try { gl = cv.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }) || cv.getContext("experimental-webgl"); } catch (e) {}
    if (!gl || !gl.createShader) { glDead = true; return null; }
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
    try {
      var pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error("link");
      gl.useProgram(pr);
      var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(function (p) { gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE); });
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      var U = {}; ["t", "px", "res", "ex", "co", "sa", "wa", "ti", "hi", "sh", "vi", "sp", "gr", "fa", "mo", "seed", "sS", "sH"].forEach(function (n) { U[n] = gl.getUniformLocation(pr, n); });
      cv.addEventListener("webglcontextlost", function (e) { e.preventDefault(); glDead = true; GL = null; });
      GL = { cv: cv, gl: gl, U: U, max: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096, 8192) };
    } catch (e) { glDead = true; GL = null; }
    return GL;
  }
  /* src (canvas / img / video) drawn at w×h through the color pass. Returns a canvas (shared: copy it if you keep it) */
  var cpuCv = null; /* (FS lines are joined with \n so the #ifdef above stays on its own line) */
  function processFrame(src, w, h, P) {
    w = Math.round(w); h = Math.round(h);
    var G = isIdentity(P) ? null : glInit();
    if (G && w <= G.max && h <= G.max) {
      var gl = G.gl, U = G.U;
      try {
        if (G.cv.width !== w || G.cv.height !== h) { G.cv.width = w; G.cv.height = h; }
        gl.viewport(0, 0, w, h);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.uniform1i(U.t, 0); gl.uniform2f(U.px, 1 / w, 1 / h); gl.uniform2f(U.res, w, h);
        gl.uniform1f(U.ex, P.exposure); gl.uniform1f(U.co, P.contrast); gl.uniform1f(U.sa, P.saturation); gl.uniform1f(U.wa, P.warmth);
        gl.uniform1f(U.ti, P.tint); gl.uniform1f(U.hi, P.highlights); gl.uniform1f(U.sh, P.shadows); gl.uniform1f(U.vi, P.vignette);
        gl.uniform1f(U.sp, Math.max(0, P.sharpen)); gl.uniform1f(U.gr, Math.max(0, P.grain)); gl.uniform1f(U.fa, P.fade); gl.uniform1f(U.mo, P.mono);
        gl.uniform1f(U.seed, P.seed || 0); gl.uniform3f(U.sS, P.split[0], P.split[1], P.split[2]); gl.uniform3f(U.sH, P.split[3], P.split[4], P.split[5]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return G.cv;
      } catch (e) { /* tainted or lost: CPU below */ }
    }
    if (!cpuCv) cpuCv = canvas(w, h);
    if (cpuCv.width !== w || cpuCv.height !== h) { cpuCv.width = w; cpuCv.height = h; }
    var x = ctx2d(cpuCv); if (!x) return src;
    x.clearRect(0, 0, w, h); x.drawImage(src, 0, 0, w, h);
    if (!isIdentity(P)) {
      try { var im = x.getImageData(0, 0, w, h); cpuApply(im.data, w, h, P); x.putImageData(im, 0, 0); } catch (e) {}
    }
    return cpuCv;
  }

  /* ---------- geometry: rotate / flip in view space, then crop (normalized to the oriented image) ---------- */
  function oriented(sw, sh, rot) { return rot % 180 ? { w: sh, h: sw } : { w: sw, h: sh }; }
  function drawGeo(x, src, sw, sh, st, outW, outH, crop) {
    var o = oriented(sw, sh, st.rot || 0), c = crop || st.crop || { x: 0, y: 0, w: 1, h: 1 };
    x.save();
    x.imageSmoothingEnabled = true; try { x.imageSmoothingQuality = "high"; } catch (e) {}
    x.scale(outW / (c.w * o.w), outH / (c.h * o.h));
    x.translate(-c.x * o.w, -c.y * o.h);
    x.translate(o.w / 2, o.h / 2);
    x.scale(st.fh ? -1 : 1, st.fv ? -1 : 1);
    x.rotate((st.rot || 0) * Math.PI / 180);
    x.drawImage(src, -sw / 2, -sh / 2, sw, sh);
    x.restore();
  }
  function rotCrop(c) { return { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w }; }
  function fitAspect(c, ratio, ow, oh) {
    if (!ratio) return c;
    var cx = (c.x + c.w / 2) * ow, cy = (c.y + c.h / 2) * oh, pw = ow, ph = ow / ratio;
    if (ph > oh) { ph = oh; pw = oh * ratio; }
    var x0 = clamp(cx - pw / 2, 0, ow - pw), y0 = clamp(cy - ph / 2, 0, oh - ph);
    return { x: x0 / ow, y: y0 / oh, w: pw / ow, h: ph / oh };
  }

  /* ---------- overlays: text, stickers, brush strokes (all normalized to the output frame) ---------- */
  var FONTS = [
    { id: "bold", name: "Bold", css: "800 {s}px -apple-system, system-ui, 'Helvetica Neue', Arial, sans-serif" },
    { id: "impact", name: "Meme", css: "900 {s}px Impact, 'Arial Black', 'Helvetica Neue', sans-serif" },
    { id: "marker", name: "Marker", css: "700 {s}px 'Marker Felt', 'Chalkboard SE', 'Comic Sans MS', cursive" },
    { id: "type", name: "Typewriter", css: "600 {s}px 'American Typewriter', 'Courier New', monospace" },
    { id: "serif", name: "Serif", css: "700 {s}px Georgia, 'Times New Roman', serif" },
    { id: "futura", name: "Futura", css: "700 {s}px Futura, 'Avenir Next', 'Trebuchet MS', sans-serif" },
    { id: "chalk", name: "Chalk", css: "400 {s}px 'Chalkduster', 'Chalkboard SE', cursive" }
  ];
  var FBY = {}; FONTS.forEach(function (f) { FBY[f.id] = f; });
  var COLORS = ["#ffffff", "#0b0b0b", "#FFD54F", "#FF5252", "#4FC3F7", "#69F0AE", "#FF4081", "#FF9100", "#B388FF", "#1E88E5"];
  var STICKERS = ["😤", "🦞", "☕", "🍩", "🍕", "🏒", "⚾", "🏈", "🏀", "🍀", "🔥", "💯", "😎", "🤌", "💀", "👑", "🎧", "🎤", "🥁", "🎹", "🚀", "💰", "🎯", "⚡", "💥", "✨", "❤️", "😂", "🙄", "🤬", "👀", "🫡", "🌊", "❄️", "🌃", "🚇"];
  function fontOf(l, px) { return (FBY[l.font] || FONTS[0]).css.replace("{s}", Math.max(1, Math.round(px))); }
  function layerBox(x, l, W, H) {
    var fs = l.size * W, lines = String(l.text || "").split("\n");
    x.font = l.kind === "sticker" ? Math.round(fs) + "px -apple-system, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif" : fontOf(l, fs);
    var w = 0; lines.forEach(function (t) { w = Math.max(w, x.measureText(t).width || t.length * fs * 0.55); });
    return { w: w + fs * (l.bg ? 0.6 : 0.2), h: lines.length * fs * 1.18 + fs * (l.bg ? 0.3 : 0.1), fs: fs, lines: lines };
  }
  function drawLayer(x, l, W, H, sel) {
    var b = layerBox(x, l, W, H);
    x.save();
    x.translate(l.x * W, l.y * H); x.rotate(l.rot || 0);
    x.textAlign = "center"; x.textBaseline = "middle";
    if (l.bg && l.kind !== "sticker") {
      x.fillStyle = l.color === "#0b0b0b" ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.62)";
      var r = b.fs * 0.3; rrect(x, -b.w / 2, -b.h / 2, b.w, b.h, r); x.fill();
    }
    b.lines.forEach(function (t, i) {
      var y = (i - (b.lines.length - 1) / 2) * b.fs * 1.18;
      if (l.kind !== "sticker" && l.stroke) {
        x.lineJoin = "round"; x.miterLimit = 2; x.lineWidth = b.fs * (l.stroke === 2 ? 0.2 : 0.1);
        x.strokeStyle = l.strokeColor || (l.color === "#0b0b0b" ? "#ffffff" : "#0b0b0b"); x.strokeText(t, 0, y);
      }
      x.fillStyle = l.kind === "sticker" ? "#000" : l.color || "#fff"; x.fillText(t, 0, y);
    });
    if (sel) {
      x.setLineDash([8, 6]); x.lineWidth = Math.max(2, W / 400); x.strokeStyle = "#4FC3F7";
      x.strokeRect(-b.w / 2 - 6, -b.h / 2 - 6, b.w + 12, b.h + 12);
    }
    x.restore();
    return b;
  }
  function rrect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function drawStrokes(W, H, strokes, into) {
    var c = into || canvas(W, H); if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    var x = ctx2d(c); if (!x) return c;
    x.clearRect(0, 0, W, H); x.lineCap = "round"; x.lineJoin = "round";
    (strokes || []).forEach(function (s) {
      var p = s.pts; if (!p || !p.length) return;
      x.globalCompositeOperation = s.er ? "destination-out" : "source-over";
      x.strokeStyle = s.c; x.fillStyle = s.c; x.lineWidth = s.s * W;
      if (p.length < 4) { x.beginPath(); x.arc(p[0] * W, p[1] * H, s.s * W / 2, 0, Math.PI * 2); x.fill(); return; }
      x.beginPath(); x.moveTo(p[0] * W, p[1] * H);
      for (var i = 2; i < p.length - 2; i += 2) { var mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2; x.quadraticCurveTo(p[i] * W, p[i + 1] * H, mx * W, my * H); }
      x.lineTo(p[p.length - 2] * W, p[p.length - 1] * H); x.stroke();
    });
    x.globalCompositeOperation = "source-over";
    return c;
  }

  /* ---------- media in / out ---------- */
  function loadImage(src) {
    return new Promise(function (ok, no) {
      var im = new Image(); if (/^https?:/.test(src)) im.crossOrigin = "anonymous";
      im.onload = function () { ok(im); }; im.onerror = function () { no("Couldn't open that picture."); }; im.src = src;
    });
  }
  /* any source -> a canvas capped at 16 MP */
  function toCanvas(img) {
    var w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
    if (!w || !h) return null;
    var k = Math.min(1, Math.sqrt(MAX_PX / (w * h)));
    var c = canvas(w * k, h * k), x = ctx2d(c); if (x) x.drawImage(img, 0, 0, c.width, c.height);
    c.capped = k < 1; return c;
  }
  function srcURL(src) {
    if (!src) return Promise.reject("Nothing to open.");
    if (typeof src === "string") return Promise.resolve({ url: src });
    if (src.libId) return libBlob(src.libId).then(function (b) { if (!b) throw "That Library item is gone."; return { url: URL.createObjectURL(b), tmp: true, blob: b }; });
    if (typeof Blob !== "undefined" && src instanceof Blob) return Promise.resolve({ url: URL.createObjectURL(src), tmp: true, blob: src });
    return Promise.reject("Can't open that.");
  }
  function lib() { return window.blarfLib || null; }
  function libBlob(id) { var L = lib(); return L ? L.blob(id) : Promise.resolve(null); }
  function toBlob(c, type, q) {
    return new Promise(function (ok, no) {
      try {
        if (c.toBlob) c.toBlob(function (b) { if (b) ok(b); else no("Export failed (out of memory?)."); }, type, q);
        else { var d = c.toDataURL(type, q), m = /^data:([^;]+);base64,(.*)$/.exec(d), bin = atob(m[2]), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); ok(new Blob([u], { type: m[1] })); }
      } catch (e) { no("This picture can't be exported (it came from another site)."); }
    });
  }
    function stamp() { var d = new Date(); function p(n) { return (n < 10 ? "0" : "") + n; } return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function saveToLibrary(blob, name) {
    var L = lib(); if (!L) return Promise.reject("Library isn't ready.");
    var file; try { file = new File([blob], name, { type: blob.type }); } catch (e) { file = blob; file.name = name; }
    return L.ensureFolder(STUDIO, "Studio FX", true).then(function () { return L.addFiles([file], STUDIO, { src: "studio" }); }).then(function (d) { return d && d[0]; });
  }
  function shareBlob(blob, name, title) {
    var file = null; try { file = new File([blob], name, { type: blob.type }); } catch (e) {}
    var can = false; try { can = !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) {}
    if (can) return navigator.share({ files: [file], title: title || "Blarf Studio FX" }).then(function () { return "shared"; }, function (e) { if (e && e.name === "AbortError") return "cancel"; throw e; });
    var url = URL.createObjectURL(blob), a = doc.createElement("a"); a.href = url; a.download = name; a.style.display = "none"; doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    return Promise.resolve("downloaded");
  }
  /* keys: the vault may hold them locked */
  function withKeys(fn) {
    var V = window.blarfVault;
    if (V && V.keysLocked && V.keysLocked()) { V.unlockFor(fn); return; }
    fn();
  }
  function xaiKey() { var s = S(); return s.provider === "xai" && s.apiKey ? String(s.apiKey).trim() : ""; }
  function oaiKey() { var s = S(); return s.oaiKey ? String(s.oaiKey).trim() : ""; }
  function offline() { try { return C && C.offline(); } catch (e) { return false; } }
  function apiErr(res, data) {
    if (res.status === 401 || res.status === 403) return "The API key was rejected (" + res.status + "). Check it in Settings.";
    if (res.status === 429) return "Rate limit or quota hit (429). Try again in a bit.";
    if (res.status === 400 && data && data.error && /safety|moderat|policy/i.test(JSON.stringify(data.error))) return "The image model refused that one (content rules).";
    return "The server said " + res.status + (data && data.error && data.error.message ? ": " + String(data.error.message).slice(0, 140) : ".");
  }
  function fetchJSON(url, op, ms, ctrl) {
    ctrl = ctrl || (typeof AbortController !== "undefined" ? new AbortController() : null);
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 120000);
    if (ctrl) op.signal = ctrl.signal;
    return fetch(url, op).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (t) { var d = null; try { d = JSON.parse(t); } catch (e) {} if (!res.ok) throw apiErr(res, d); return d; });
    }, function (e) { clearTimeout(timer); throw e && e.name === "AbortError" ? "Cancelled or timed out." : "Network or CORS block."; });
  }
  /* AI image edit. xAI grok-imagine-image-2.0 via POST /v1/images/edits (JSON, data-URI source), verified on docs.x.ai Nov 2026;
     OpenAI fallback: POST /v1/images/edits multipart with gpt-image-2.5-sunburst (the endpoint's documented default). */
  var XAI_EDIT = "https://api.x.ai/v1/images/edits", OAI_EDIT = "https://api.openai.com/v1/images/edits";
  var XAI_IMG_MODEL = "grok-imagine-image-2.0", OAI_IMG_MODEL = "gpt-image-2.5-sunburst";
  function aiEditRequest(dataUrl, prompt, ctrl) {
    if (offline()) return Promise.reject("You're offline. AI edits need the internet.");
    var xk = xaiKey(), ok = oaiKey();
    if (xk) {
      return fetchJSON(XAI_EDIT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + xk },
        body: JSON.stringify({ model: XAI_IMG_MODEL, prompt: prompt, image: { url: dataUrl, type: "image_url" }, response_format: "b64_json" }) }, 150000, ctrl)
        .then(function (d) { var r = d && d.data && d.data[0]; if (r && r.b64_json) return "data:image/jpeg;base64," + r.b64_json; if (r && r.url) return r.url; throw "The edit came back empty."; });
    }
    if (ok) {
      var m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl), bin = atob(m[2]), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      var fd = new FormData(); fd.append("model", OAI_IMG_MODEL); fd.append("prompt", prompt); fd.append("output_format", "jpeg");
      fd.append("image", new Blob([u], { type: m[1] }), m[1].indexOf("png") >= 0 ? "photo.png" : "photo.jpg");
      return fetchJSON(OAI_EDIT, { method: "POST", headers: { Authorization: "Bearer " + ok }, body: fd }, 180000, ctrl)
        .then(function (d) { var r = d && d.data && d.data[0]; if (r && r.b64_json) return "data:image/jpeg;base64," + r.b64_json; if (r && r.url) return r.url; throw "The edit came back empty."; });
    }
    return Promise.reject("AI edits need an xAI key (provider xAI) or an OpenAI key in Settings.");
  }
  /* Blarf looks at the picture and pitches edits, in character, as JSON */
  function suggestRequest(dataUrl, ctrl) {
    if (offline()) return Promise.reject("You're offline.");
    var s = S(), xk = xaiKey(), ok = oaiKey(), names = PRESETS.map(function (p) { return p.id + " (" + p.name + ")"; }).join(", ");
    var sys = (C && C.character ? C.character({ compact: true, role: "Right now you're Kyle's photo editor in Blarf Studio FX, looking at his picture." }) : "You are Blarf, a grumpy Boston photo editor.") +
      " Look at the photo and pitch edits. Reply with ONLY JSON: {\"line\":\"one short in-character reaction (max 20 words)\",\"looks\":[{\"name\":\"2-3 word name\",\"filter\":\"preset id or empty\",\"adjust\":{\"exposure\":0,\"contrast\":0,\"saturation\":0,\"warmth\":0,\"tint\":0,\"highlights\":0,\"shadows\":0,\"vignette\":0,\"sharpen\":0,\"grain\":0},\"why\":\"max 10 words\"}],\"ai\":\"one AI edit instruction worth trying, max 14 words\"}. Give 3 looks. adjust values are -100..100 (sharpen, grain 0..100), only include the ones you change. Preset ids: " + names + ".";
    var input = [{ role: "system", content: sys }, { role: "user", content: [{ type: "input_text", text: "Here's my picture. What would you do with it?" }, { type: "input_image", image_url: dataUrl, detail: "low" }] }];
    var url, key, model;
    if (xk) { url = "https://api.x.ai/v1/responses"; key = xk; model = (s.visionModel || "").trim() || (s.model || "").trim() || "grok-4.7"; }
    else if (ok) { url = "https://api.openai.com/v1/responses"; key = ok; model = (s.thinkModel || "").trim() || "gpt-6-astra"; }
    else return Promise.reject("Blarf's take needs an xAI or OpenAI key in Settings.");
    var body = { model: model, input: input }; if (xk) body.reasoning = { effort: "low" };
    return fetchJSON(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key }, body: JSON.stringify(body) }, 60000, ctrl).then(function (d) {
      var t = typeof d.output_text === "string" ? d.output_text : "";
      if (!t && Array.isArray(d.output)) d.output.forEach(function (it) { (it && it.content || []).forEach(function (c) { if (c && c.type === "output_text") t += c.text; }); });
      return parseSuggest(t);
    });
  }
  function parseSuggest(t) {
    var m = /\{[\s\S]*\}/.exec(String(t || "")), j = null;
    try { j = m ? JSON.parse(m[0]) : null; } catch (e) {}
    if (!j) throw "Blarf mumbled somethin' unreadable. Try again.";
    var looks = (Array.isArray(j.looks) ? j.looks : []).slice(0, 4).map(function (l) {
      var a = {}; ADJ.forEach(function (d) { var v = l && l.adjust ? +l.adjust[d.id] : 0; if (v) a[d.id] = Math.round(clamp(v, d.min === 0 ? 0 : -100, 100)); });
      return { name: String(l && l.name || "A look").slice(0, 24), filter: PBY[l && l.filter] ? l.filter : "", adjust: a, why: String(l && l.why || "").slice(0, 80) };
    });
    return { line: String(j.line || "").slice(0, 160), looks: looks, ai: String(j.ai || "").slice(0, 140) };
  }
  /* on-device "Cut out person": MediaPipe selfie segmenter (~250 KB model + ~15 MB wasm, lazy, cached by sw.js) */
  var MP_VER = "1.2.2", MP_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" + MP_VER;
  var MP_MODEL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
  var seg = null;
  function cutoutAvailable() { return typeof WebAssembly !== "undefined"; }
  function loadSeg() {
    if (seg) return seg;
    seg = new Function("u", "return import(u)")(MP_BASE + "/vision_bundle.mjs").then(function (mp) {
      return mp.FilesetResolver.forVisionTasks(MP_BASE + "/wasm").then(function (fs) {
        return mp.ImageSegmenter.createFromOptions(fs, { baseOptions: { modelAssetPath: MP_MODEL, delegate: "CPU" }, runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false });
      });
    });
    seg.catch(function () { seg = null; });
    return seg;
  }
  function maskToAlpha(conf, mw, mh) {
    /* single-mask model = person confidence; if the border is more "person" than the middle, it's inverted */
    var edge = 0, mid = 0, ne = 0, nm = 0;
    for (var y = 0; y < mh; y++) for (var x = 0; x < mw; x++) {
      var v = conf[y * mw + x], e = x < mw * 0.08 || x > mw * 0.92 || y < mh * 0.05;
      if (e) { edge += v; ne++; } else if (x > mw * 0.3 && x < mw * 0.7 && y > mh * 0.3) { mid += v; nm++; }
    }
    var inv = ne && nm && edge / ne > mid / nm;
    var c = canvas(mw, mh), x2 = ctx2d(c), im = x2.createImageData(mw, mh);
    for (var i = 0; i < mw * mh; i++) { var a = inv ? 1 - conf[i] : conf[i]; im.data[i * 4 + 3] = smooth(0.35, 0.65, a) * 255; }
    x2.putImageData(im, 0, 0);
    return c;
  }
  function cutout(src) {
    return loadSeg().then(function (sg) {
      var k = Math.min(1, 1024 / Math.max(src.width, src.height)), small = canvas(src.width * k, src.height * k);
      ctx2d(small).drawImage(src, 0, 0, small.width, small.height);
      var r = sg.segment(small), masks = r && r.confidenceMasks;
      if (!masks || !masks.length) throw "Couldn't find a person in this one.";
      var m = masks.length > 1 ? masks[masks.length - 1] : masks[0], conf = m.getAsFloat32Array(), alpha = maskToAlpha(conf, m.width, m.height);
      try { masks.forEach(function (x) { x.close(); }); } catch (e) {}
      var out = canvas(src.width, src.height), x = ctx2d(out);
      x.drawImage(src, 0, 0); x.globalCompositeOperation = "destination-in"; x.imageSmoothingEnabled = true; x.drawImage(alpha, 0, 0, out.width, out.height);
      x.globalCompositeOperation = "source-over"; out.alpha = true;
      return out;
    });
  }

  /* ---------- shared editor chrome ---------- */
  function sliderHTML(id, min, max, val, label) {
    return '<div class="fx-slider" data-sl="' + id + '"><input type="range" min="' + min + '" max="' + max + '" step="1" value="' + val + '" aria-label="' + esc(label) + '" /><output>' + val + "</output></div>";
  }
  /* range with a soft detent at 0 and a tick on crossing it */
  function wireSlider(el, onInput, onCommit) {
    var inp = el.querySelector("input"), out = el.querySelector("output"), last = +inp.value;
    function paint() {
      var v = +inp.value, mn = +inp.min, mx = +inp.max, z = mn < 0 ? (0 - mn) / (mx - mn) : 0, p = (v - mn) / (mx - mn);
      el.style.setProperty("--a", Math.min(z, p) * 100 + "%"); el.style.setProperty("--b", Math.max(z, p) * 100 + "%");
      out.textContent = (v > 0 && mn < 0 ? "+" : "") + v;
    }
    inp.addEventListener("input", function () {
      var v = +inp.value;
      if (+inp.min < 0 && Math.abs(v) <= 3 && v !== 0) { inp.value = 0; v = 0; }
      if ((last < 0) !== (v < 0) || (v === 0) !== (last === 0)) { tick(); el.classList.remove("is-tick"); void el.offsetWidth; el.classList.add("is-tick"); }
      last = v; paint(); onInput(v);
    });
    inp.addEventListener("change", function () { if (onCommit) onCommit(+inp.value); });
    inp.addEventListener("dblclick", function () { inp.value = 0; last = 0; paint(); onInput(0); if (onCommit) onCommit(0); });
    paint();
    return { set: function (v) { inp.value = v; last = +v; paint(); } };
  }
  function busy(root, on, label, cancel) {
    var b = root.querySelector(".fx-busy");
    if (!b) { b = doc.createElement("div"); b.className = "fx-busy"; b.innerHTML = '<div class="fx-busy__card"><span class="fx-spin" aria-hidden="true"></span><p></p><div class="fx-bar"><i></i></div><button class="fx-btn" type="button" data-busy="x">Cancel</button></div>'; root.appendChild(b); }
    b.hidden = !on; b.querySelector("p").textContent = label || "";
    b.querySelector(".fx-bar").hidden = true;
    var cb = b.querySelector("[data-busy]"); cb.hidden = !cancel; cb.onclick = cancel || null;
    return { prog: function (f, txt) { var bar = b.querySelector(".fx-bar"); bar.hidden = false; bar.firstChild.style.width = clamp(f, 0, 1) * 100 + "%"; if (txt) b.querySelector("p").textContent = txt; } };
  }
  /* small modal picker over the editor: Library items of a kind */
  function pickFromLibrary(root, kind, title) {
    return new Promise(function (ok) {
      var L = lib(), items = L && L.items ? L.items(kind) : [];
      var m = doc.createElement("div"); m.className = "fx-pick"; m.setAttribute("role", "dialog"); m.setAttribute("aria-label", title);
      m.innerHTML = '<div class="fx-pick__card"><div class="fx-pick__head"><b>' + esc(title) + '</b><button class="fx-icon" type="button" data-x aria-label="Close">×</button></div>' +
        (items.length ? '<div class="fx-pick__grid">' + items.slice(0, 120).map(function (it) {
          return '<button type="button" class="fx-pick__it" data-id="' + esc(it.id) + '">' + (it.thumb ? '<img alt="" src="' + esc(it.thumb) + '" />' : '<span class="fx-pick__ic">' + (kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "🖼️") + "</span>") + "<small>" + esc(it.name) + "</small></button>";
        }).join("") + "</div>" : '<p class="fx-note">Nothing like that in the Library yet.</p>') + "</div>";
      function done(v) { m.remove(); ok(v); }
      m.addEventListener("click", function (e) {
        if (e.target === m || e.target.closest("[data-x]")) return done(null);
        var b = e.target.closest("[data-id]"); if (b) done(L.item(b.getAttribute("data-id")));
      });
      root.appendChild(m);
    });
  }
  function pickFile(accept, multi, capture) {
    return new Promise(function (ok) {
      var i = doc.createElement("input"); i.type = "file"; i.accept = accept; if (multi) i.multiple = true; if (capture) i.setAttribute("capture", capture);
      i.style.display = "none"; doc.body.appendChild(i);
      i.addEventListener("change", function () { var f = [].slice.call(i.files || []); i.remove(); ok(f); });
      i.click();
    });
  }
  function confirmBox(root, title, text, btns) {
    return new Promise(function (ok) {
      var m = doc.createElement("div"); m.className = "fx-pick"; m.setAttribute("role", "alertdialog");
      m.innerHTML = '<div class="fx-pick__card fx-confirm"><b>' + esc(title) + "</b><p>" + esc(text) + '</p><div class="fx-row">' +
        btns.map(function (b, i) { return '<button class="fx-btn' + (b.primary ? " fx-btn--go" : "") + '" type="button" data-i="' + i + '">' + esc(b.label) + "</button>"; }).join("") + "</div></div>";
      m.addEventListener("click", function (e) { var b = e.target.closest("[data-i]"); if (b) { m.remove(); ok(btns[+b.getAttribute("data-i")].v); } });
      root.appendChild(m);
    });
  }
  function openRoot(root) { root.hidden = false; void root.offsetWidth; root.classList.add("is-open"); doc.documentElement.classList.add("fx-lock"); }
  function closeRoot(root, after) {
    root.classList.remove("is-open"); doc.documentElement.classList.remove("fx-lock");
    setTimeout(function () { root.hidden = true; if (after) after(); }, calm() ? 0 : 260);
  }

  /* ======================= PHOTO EDITOR ======================= */
  var P = null; /* session */
  var TABS = [["crop", "Crop", "⛶"], ["adjust", "Adjust", "🎚️"], ["filters", "Filters", "🎞️"], ["text", "Text", "Aa"], ["stickers", "Stickers", "😤"], ["draw", "Draw", "✍️"], ["ai", "AI", "✨"]];
  var ASPECTS = [["free", "Free", 0], ["orig", "Original", -1], ["1:1", "1:1", 1], ["4:5", "4:5", 0.8], ["9:16", "9:16", 9 / 16], ["16:9", "16:9", 16 / 9], ["3:2", "3:2", 1.5], ["4:3", "4:3", 4 / 3]];
  function freshState(v) { return { v: v || 0, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: "free", rot: 0, fh: false, fv: false, adj: {}, filter: "", famt: 100, layers: [], strokes: [] }; }
  function build() {
    var r = doc.createElement("div");
    r.className = "fx"; r.id = "fx"; r.hidden = true; r.setAttribute("role", "dialog"); r.setAttribute("aria-modal", "true"); r.setAttribute("aria-label", "Studio FX photo editor");
    r.innerHTML =
      '<header class="fx-top"><button class="fx-icon" type="button" data-a="close" aria-label="Close editor">×</button>' +
      '<div class="fx-title"><b>Studio FX</b><small id="fx-sub">Photo</small></div>' +
      '<button class="fx-icon" type="button" data-a="undo" aria-label="Undo" disabled>↶</button><button class="fx-icon" type="button" data-a="redo" aria-label="Redo" disabled>↷</button>' +
      '<button class="fx-icon fx-before" type="button" data-a="before" aria-label="Hold to see the original">◑</button>' +
      '<button class="fx-btn fx-btn--go" type="button" data-a="export">Save</button></header>' +
      '<div class="fx-stage" id="fx-stage"><canvas id="fx-cv" aria-label="Photo preview"></canvas><div class="fx-say" id="fx-say" hidden></div><p class="fx-hint" id="fx-hint" hidden></p></div>' +
      '<div class="fx-panel" id="fx-panel"></div>' +
      '<nav class="fx-tabs" id="fx-tabs" role="tablist">' + TABS.map(function (t) { return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="false"><span aria-hidden="true">' + t[2] + "</span>" + t[1] + "</button>"; }).join("") + "</nav>";
    doc.body.appendChild(r);
    r.addEventListener("click", onTop);
    var bf = r.querySelector('[data-a="before"]');
    function bon(e) { e.preventDefault(); if (P) { P.before = true; draw(); } }
    function boff() { if (P && P.before) { P.before = false; draw(); } }
    bf.addEventListener("pointerdown", bon); ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { bf.addEventListener(ev, boff); });
    r.querySelector("#fx-tabs").addEventListener("click", function (e) { var b = e.target.closest("[data-tab]"); if (b && P && P.srcs.length) setTab(b.getAttribute("data-tab")); });
    wireStage(r.querySelector("#fx-cv"));
    doc.addEventListener("keydown", function (e) {
      if (!P || r.hidden) return;
      if (e.key === "Escape") { if (r.querySelector(".fx-pick, .fx-textedit, .fx-sheet")) return; close(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    });
    window.addEventListener("resize", function () { if (P && !r.hidden) { P.size = null; draw(); } });
    return r;
  }
  function root() { return $("fx") || build(); }
  function onTop(e) {
    var b = e.target.closest("[data-a]"); if (!b || !P) return;
    var a = b.getAttribute("data-a");
    if (a === "close") close();
    else if (a === "undo") undo();
    else if (a === "redo") redo();
    else if (a === "export") { if (P.srcs.length) openExport(); }
  }
  /* open(source, { prompt, note, filter, adjust, name, tab }) */
  function openPhoto(src, o) {
    o = o || {};
    var r = root();
    if (P && P.tmp) P.tmp.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    P = { srcs: [], st: freshState(0), undo: [], redo: [], tab: "adjust", adjSel: "exposure", sel: null, brush: { c: "#FF5252", s: 0.012, er: false }, tmp: [], name: o.name || "", fmt: "jpeg", o: o, cache: {} };
    P.base = JSON.stringify(P.st);
    openRoot(r);
    r.querySelector("#fx-sub").textContent = "Photo";
    if (!src) { startScreen(); return Promise.resolve(true); }
    return loadSource(src).then(function () {
      if (o.filter && PBY[o.filter]) P.st.filter = o.filter;
      if (o.adjust) ADJ.forEach(function (d) { if (o.adjust[d.id]) P.st.adj[d.id] = Math.round(clamp(+o.adjust[d.id], -100, 100)); });
      if (o.filter || o.adjust) commit();
      if (o.note) say(o.note);
      setTab(o.prompt ? "ai" : o.tab || (o.filter ? "filters" : "adjust"));
      if (o.prompt) { var ta = $("fx-ai-in"); if (ta) ta.value = o.prompt; }
      return true;
    }, function (e) { toast(String(e)); startScreen(); return false; });
  }
  function loadSource(src) {
    var r = root(), b = busy(r, true, "Opening…");
    return srcURL(src).then(function (u) {
      if (u.tmp) P.tmp.push(u.url);
      if (!P.name && u.blob && u.blob.name) P.name = u.blob.name.replace(/\.[a-z0-9]+$/i, "");
      return loadImage(u.url);
    }).then(function (im) {
      var c = toCanvas(im); if (!c) throw "That picture is empty.";
      if (c.capped) toast("Big one. Editing at 16 MP (the iPhone canvas limit).");
      P.srcs.push({ c: c, label: "Original" }); P.st = freshState(0); P.base = JSON.stringify(P.st); P.undo = []; P.redo = []; P.size = null;
      busy(r, false); paintHistory(); draw();
    }).catch(function (e) { busy(r, false); throw e; });
  }
  function startScreen() {
    var pn = $("fx-panel");
    setTabsOn(false);
    $("fx-cv").getContext && clearStage();
    pn.innerHTML = '<div class="fx-start"><p class="fx-start__t">What are we fixin\u2019?</p><div class="fx-start__row">' +
      '<button class="fx-big" type="button" data-s="cam"><span>📷</span>Camera</button><button class="fx-big" type="button" data-s="photos"><span>🖼️</span>Photos</button><button class="fx-big" type="button" data-s="lib"><span>📚</span>Library</button></div></div>';
    pn.querySelector(".fx-start").addEventListener("click", function (e) {
      var b = e.target.closest("[data-s]"); if (!b) return;
      var s = b.getAttribute("data-s");
      var p = s === "lib" ? pickFromLibrary(root(), "image", "Pick a picture").then(function (it) { return it ? { libId: it.id, name: it.name } : null; })
        : pickFile("image/*", false, s === "cam" ? "environment" : "").then(function (f) { return f[0] || null; });
      p.then(function (x) {
        if (!x) return;
        if (x.name && !(x instanceof Blob)) P.name = x.name;
        loadSource(x).then(function () { setTabsOn(true); setTab("adjust"); }, function (e) { toast(String(e)); });
      });
    });
  }
  function clearStage() { var cv = $("fx-cv"), x = ctx2d(cv); if (x) x.clearRect(0, 0, cv.width, cv.height); }
  function setTabsOn(on) { [].slice.call(root().querySelectorAll("#fx-tabs [data-tab], .fx-top [data-a='export'], .fx-top [data-a='before']")).forEach(function (b) { b.disabled = !on; }); }
  function close() {
    if (!P) return;
    var r = root(), dirty = P.undo.length > 0 || P.srcs.length > 1;
    var go = function () { closeRoot(r, function () { if (P && P.tmp) P.tmp.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} }); P = null; clearStage(); }); };
    if (!dirty || P.saved) return go();
    confirmBox(r, "Toss your edits?", "You haven't saved this one.", [{ label: "Keep editing", v: 0 }, { label: "Toss 'em", v: 1, primary: true }]).then(function (v) { if (v) go(); });
  }
  function say(t) {
    var el = $("fx-say"); if (!el) return;
    el.innerHTML = '<span class="fx-say__face" aria-hidden="true">😤</span><p>' + esc(t) + '</p><button class="fx-icon" type="button" aria-label="Dismiss">×</button>';
    el.hidden = false; el.querySelector("button").onclick = function () { el.hidden = true; };
    clearTimeout(say.t); say.t = setTimeout(function () { el.hidden = true; }, 12000);
  }
  function hint(t) { var h = $("fx-hint"); if (!h) return; h.textContent = t || ""; h.hidden = !t; }

  /* ---------- history ---------- */
  function commit() {
    var cur = JSON.stringify(P.st);
    if (cur === P.base) return false;
    P.undo.push(P.base); P.base = cur; P.redo = []; P.saved = false; P.exp = null;
    paintHistory(); return true;
  }
  function undo() { if (!P || !P.undo.length) return; P.redo.push(P.base); P.base = P.undo.pop(); P.st = JSON.parse(P.base); P.sel = null; P.exp = null; paintHistory(); setTab(P.tab, true); draw(); }
  function redo() { if (!P || !P.redo.length) return; P.undo.push(P.base); P.base = P.redo.pop(); P.st = JSON.parse(P.base); P.sel = null; P.exp = null; paintHistory(); setTab(P.tab, true); draw(); }
  function paintHistory() {
    var r = root();
    r.querySelector('[data-a="undo"]').disabled = !P.undo.length;
    r.querySelector('[data-a="redo"]').disabled = !P.redo.length;
    var sub = $("fx-sub"); if (sub && P.srcs.length) sub.textContent = (P.srcs.length > 1 ? "v" + (P.st.v + 1) + " of " + P.srcs.length + " · " : "") + outDims().w + "×" + outDims().h;
  }

  /* ---------- rendering ---------- */
  function src() { return P.srcs[P.st.v] ? P.srcs[P.st.v].c : null; }
  function oDims() { var s = src(); return s ? oriented(s.width, s.height, P.st.rot) : { w: 1, h: 1 }; }
  function outDims(crop) { var o = oDims(), c = crop || P.st.crop; return { w: Math.max(1, Math.round(o.w * c.w)), h: Math.max(1, Math.round(o.h * c.h)) }; }
  function params() { var p = combine(P.st.adj, P.st.filter, P.st.famt / 100); p.seed = 7; return p; }
  function stageSize() {
    if (P.size) return P.size;
    var st = $("fx-stage"), cv = $("fx-cv"), w = st.clientWidth || 360, h = st.clientHeight || 480, dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + "px"; cv.style.height = h + "px";
    P.size = { w: w, h: h, dpr: dpr }; return P.size;
  }
  /* where the image sits on the stage, CSS px */
  function fitRect(iw, ih, pad) {
    var z = stageSize(), p = pad == null ? 16 : pad, k = Math.min((z.w - p * 2) / iw, (z.h - p * 2) / ih);
    var w = iw * k, h = ih * k; return { x: (z.w - w) / 2, y: (z.h - h) / 2, w: w, h: h, k: k };
  }
  var raf = 0;
  function draw() { if (!raf) raf = (window.requestAnimationFrame || setTimeout)(function () { raf = 0; drawNow(); }); }
  function drawNow() {
    if (!P || !src()) return;
    var cv = $("fx-cv"), x = ctx2d(cv); if (!x) return;
    var z = stageSize(), dpr = z.dpr, crop = P.tab === "crop" && !P.before;
    x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height);
    if (P.before) {
      var s0 = P.srcs[0].c, rb = fitRect(s0.width, s0.height);
      x.drawImage(s0, rb.x * dpr, rb.y * dpr, rb.w * dpr, rb.h * dpr);
      label(x, "Original", dpr); return;
    }
    var full = { x: 0, y: 0, w: 1, h: 1 }, c = crop ? full : P.st.crop, d = outDims(c), R = fitRect(d.w, d.h, crop ? 28 : 16);
    var pw = Math.round(R.w * dpr), ph = Math.round(R.h * dpr);
    P.view = R;
    var img = previewImage(c, pw, ph);
    if (src().alpha) checker(x, R, dpr);
    x.drawImage(img, R.x * dpr, R.y * dpr, pw, ph);
    if (crop) { cropUI(x, R, dpr); return; }
    /* overlays at preview scale */
    x.save(); x.translate(R.x * dpr, R.y * dpr);
    if (P.st.strokes.length || P.cur) { P.strokeCv = drawStrokes(pw, ph, P.st.strokes.concat(P.cur ? [P.cur] : []), P.strokeCv); x.drawImage(P.strokeCv, 0, 0); }
    P.st.layers.forEach(function (l) { drawLayer(x, l, pw, ph, l.id === P.sel && (P.tab === "text" || P.tab === "stickers")); });
    x.restore();
  }
  function label(x, t, dpr) { x.save(); x.font = "600 " + 12 * dpr + "px -apple-system, system-ui"; x.fillStyle = "rgba(0,0,0,.55)"; var w = x.measureText(t).width + 16 * dpr; rrect(x, 12 * dpr, 12 * dpr, w, 24 * dpr, 12 * dpr); x.fill(); x.fillStyle = "#fff"; x.fillText(t, 20 * dpr, 28 * dpr); x.restore(); }
  function checker(x, R, dpr) {
    x.save(); var s = 10 * dpr; x.beginPath(); x.rect(R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr); x.clip();
    x.fillStyle = "#2a2d33"; x.fillRect(R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr); x.fillStyle = "#3a3e46";
    for (var yy = 0; yy < R.h * dpr; yy += s) for (var xx = (yy / s) % 2 ? s : 0; xx < R.w * dpr; xx += s * 2) x.fillRect(R.x * dpr + xx, R.y * dpr + yy, s, s);
    x.restore();
  }
  /* geometry canvas cached by its inputs; color pass cached by params */
  function previewImage(c, pw, ph) {
    var st = P.st, gk = [st.v, st.rot, st.fh, st.fv, c.x, c.y, c.w, c.h, pw, ph].join("|");
    if (P.cache.gk !== gk) {
      var g = P.cache.geo || canvas(pw, ph); g.width = pw; g.height = ph;
      var gx = ctx2d(g); gx.clearRect(0, 0, pw, ph); drawGeo(gx, src(), src().width, src().height, st, pw, ph, c);
      P.cache.geo = g; P.cache.gk = gk; P.cache.pk = "";
    }
    var pr = params(), pk = gk + JSON.stringify(pr);
    if (P.cache.pk !== pk) {
      var out = processFrame(P.cache.geo, pw, ph, pr), keep = P.cache.col || canvas(pw, ph);
      keep.width = pw; keep.height = ph; var kx = ctx2d(keep); kx.clearRect(0, 0, pw, ph); kx.drawImage(out, 0, 0);
      P.cache.col = keep; P.cache.pk = pk;
    }
    return P.cache.col;
  }
  function cropUI(x, R, dpr) {
    var c = P.st.crop, a = { x: (R.x + c.x * R.w) * dpr, y: (R.y + c.y * R.h) * dpr, w: c.w * R.w * dpr, h: c.h * R.h * dpr };
    x.save(); x.fillStyle = "rgba(0,0,0,.58)";
    x.beginPath(); x.rect(R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr); x.rect(a.x, a.y, a.w, a.h); x.fill("evenodd");
    x.strokeStyle = "rgba(255,255,255,.95)"; x.lineWidth = 1.5 * dpr; x.strokeRect(a.x, a.y, a.w, a.h);
    x.strokeStyle = "rgba(255,255,255,.35)"; x.lineWidth = 1 * dpr; x.beginPath();
    for (var i = 1; i < 3; i++) { x.moveTo(a.x + a.w * i / 3, a.y); x.lineTo(a.x + a.w * i / 3, a.y + a.h); x.moveTo(a.x, a.y + a.h * i / 3); x.lineTo(a.x + a.w, a.y + a.h * i / 3); }
    x.stroke();
    x.strokeStyle = "#fff"; x.lineWidth = 4 * dpr; var L = 18 * dpr;
    [[a.x, a.y, 1, 1], [a.x + a.w, a.y, -1, 1], [a.x, a.y + a.h, 1, -1], [a.x + a.w, a.y + a.h, -1, -1]].forEach(function (p) {
      x.beginPath(); x.moveTo(p[0] + L * p[2], p[1]); x.lineTo(p[0], p[1]); x.lineTo(p[0], p[1] + L * p[3]); x.stroke();
    });
    x.restore();
  }

  /* ---------- stage gestures: crop box, layer drag / pinch / rotate, brush ---------- */
  function wireStage(cv) {
    var ptrs = {}, g = null, lastTap = 0;
    function pos(e) { var b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
    function norm(p) { var R = P.view; return { x: (p.x - R.x) / R.w, y: (p.y - R.y) / R.h }; }
    function hitLayer(p) {
      var R = P.view, x = ctx2d($("fx-cv")); if (!x) return null;
      for (var i = P.st.layers.length - 1; i >= 0; i--) {
        var l = P.st.layers[i], b = layerBox(x, l, R.w, R.h), dx = p.x - (R.x + l.x * R.w), dy = p.y - (R.y + l.y * R.h);
        var cs = Math.cos(-(l.rot || 0)), sn = Math.sin(-(l.rot || 0)), rx = dx * cs - dy * sn, ry = dx * sn + dy * cs;
        if (Math.abs(rx) <= b.w / 2 + 12 && Math.abs(ry) <= b.h / 2 + 12) return l;
      }
      return null;
    }
    cv.addEventListener("pointerdown", function (e) {
      if (!P || !src() || P.before || !P.view) return;
      cv.setPointerCapture && cv.setPointerCapture(e.pointerId);
      var p = pos(e); ptrs[e.pointerId] = p;
      var ids = Object.keys(ptrs);
      if (ids.length === 2 && g && g.layer) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        g = { kind: "pinch", layer: g.layer, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), s0: g.layer.size, r0: g.layer.rot || 0 };
        return;
      }
      if (ids.length > 1) return;
      var n = norm(p);
      if (P.tab === "crop") {
        var c = P.st.crop, R = P.view, hx = 30 / R.w, hy = 30 / R.h, corner = null;
        [["tl", c.x, c.y], ["tr", c.x + c.w, c.y], ["bl", c.x, c.y + c.h], ["br", c.x + c.w, c.y + c.h]].forEach(function (k) { if (Math.abs(n.x - k[1]) < hx && Math.abs(n.y - k[2]) < hy) corner = k[0]; });
        if (corner) g = { kind: "corner", k: corner, c0: JSON.parse(JSON.stringify(c)), n0: n };
        else if (n.x > c.x && n.x < c.x + c.w && n.y > c.y && n.y < c.y + c.h) g = { kind: "move", c0: JSON.parse(JSON.stringify(c)), n0: n };
        return;
      }
      if (P.tab === "draw") {
        P.cur = { c: P.brush.c, s: P.brush.s, er: P.brush.er, pts: [n.x, n.y] }; g = { kind: "draw" }; draw(); return;
      }
      var l = hitLayer(p);
      if (l) {
        var now = Date.now();
        if (P.sel === l.id && now - lastTap < 320 && l.kind === "text") { lastTap = 0; editText(l); return; }
        lastTap = now;
        if (l.kind === "sticker" && P.tab !== "stickers") setTab("stickers", false, true);
        if (l.kind === "text" && P.tab !== "text") setTab("text", false, true);
        P.sel = l.id; g = { kind: "drag", layer: l, n0: n, x0: l.x, y0: l.y }; paintPanel(); draw();
      } else if (P.sel) { P.sel = null; paintPanel(); draw(); }
    });
    cv.addEventListener("pointermove", function (e) {
      if (!P || !ptrs[e.pointerId]) return;
      var p = pos(e); ptrs[e.pointerId] = p;
      if (!g) return;
      var n = norm(p), o = oDims();
      if (g.kind === "pinch") {
        var ids = Object.keys(ptrs); if (ids.length < 2) return;
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        g.layer.size = clamp(g.s0 * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0), 0.02, 1.2);
        g.layer.rot = g.r0 + (Math.atan2(b.y - a.y, b.x - a.x) - g.a0); draw();
      } else if (g.kind === "drag") {
        g.layer.x = clamp(g.x0 + n.x - g.n0.x, -0.1, 1.1); g.layer.y = clamp(g.y0 + n.y - g.n0.y, -0.1, 1.1); draw();
      } else if (g.kind === "draw") {
        P.cur.pts.push(+n.x.toFixed(4), +n.y.toFixed(4)); draw();
      } else if (g.kind === "move") {
        var c = P.st.crop; c.x = clamp(g.c0.x + n.x - g.n0.x, 0, 1 - c.w); c.y = clamp(g.c0.y + n.y - g.n0.y, 0, 1 - c.h); draw();
      } else if (g.kind === "corner") {
        var c0 = g.c0, k = g.k, ratio = aspectRatio(), mn = 0.06;
        var x1 = c0.x, y1 = c0.y, x2 = c0.x + c0.w, y2 = c0.y + c0.h;
        if (k[1] === "l") x1 = clamp(n.x, 0, x2 - mn); else x2 = clamp(n.x, x1 + mn, 1);
        if (k[0] === "t") y1 = clamp(n.y, 0, y2 - mn); else y2 = clamp(n.y, y1 + mn, 1);
        if (ratio) {
          var wpx = (x2 - x1) * o.w, hpx = wpx / ratio;
          if (k[0] === "t") { y1 = y2 - hpx / o.h; if (y1 < 0) { y1 = 0; hpx = y2 * o.h; wpx = hpx * ratio; if (k[1] === "l") x1 = x2 - wpx / o.w; else x2 = x1 + wpx / o.w; } }
          else { y2 = y1 + hpx / o.h; if (y2 > 1) { y2 = 1; hpx = (1 - y1) * o.h; wpx = hpx * ratio; if (k[1] === "l") x1 = x2 - wpx / o.w; else x2 = x1 + wpx / o.w; } }
        }
        P.st.crop = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }; draw();
      }
    });
    function up(e) {
      if (!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId];
      if (!P || !g) return;
      if (g.kind === "pinch") { if (!Object.keys(ptrs).length) { g = null; commit(); } else g = { kind: "none", layer: g.layer }; return; }
      if (Object.keys(ptrs).length) return;
      if (g.kind === "draw" && P.cur) { if (P.cur.pts.length >= 2) P.st.strokes.push(P.cur); P.cur = null; commit(); draw(); }
      else if (g.kind !== "none") { commit(); paintHistory(); }
      g = null;
    }
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.style.touchAction = "none";
  }
  function aspectRatio() {
    var a = P.st.aspect; if (a === "free") return 0;
    if (a === "orig") { var o = oDims(); return o.w / o.h; }
    for (var i = 0; i < ASPECTS.length; i++) if (ASPECTS[i][0] === a) return ASPECTS[i][2];
    return 0;
  }

  /* ---------- tabs ---------- */
  function setTab(t, keep, noSel) {
    if (!P) return;
    var was = P.tab; P.tab = t;
    if (!keep && !noSel && was !== t) P.sel = null;
    [].slice.call(root().querySelectorAll("#fx-tabs [data-tab]")).forEach(function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === t ? "true" : "false"); });
    hint(t === "crop" ? "Drag the corners. Pinch-free, kid." : t === "draw" ? "Draw with your finger." : t === "text" && !P.st.layers.some(function (l) { return l.kind === "text"; }) ? "" : "");
    paintPanel(); draw();
  }
  function paintPanel() {
    var pn = $("fx-panel"); if (!pn || !P) return;
    var t = P.tab, h = "";
    if (t === "crop") {
      h = '<div class="fx-chips" role="group" aria-label="Aspect">' + ASPECTS.map(function (a) { return '<button type="button" class="fx-chip" data-asp="' + a[0] + '" aria-pressed="' + (P.st.aspect === a[0]) + '">' + a[1] + "</button>"; }).join("") + "</div>" +
        '<div class="fx-row fx-row--tools"><button class="fx-tool" type="button" data-c="rot"><span>⟲</span>Rotate</button><button class="fx-tool" type="button" data-c="fh"><span>⇋</span>Flip H</button><button class="fx-tool" type="button" data-c="fv"><span>⇵</span>Flip V</button><button class="fx-tool" type="button" data-c="reset"><span>↺</span>Reset</button></div>';
    } else if (t === "adjust") {
      var d = ADJ.filter(function (a) { return a.id === P.adjSel; })[0] || ADJ[0], v = P.st.adj[d.id] || 0;
      h = '<p class="fx-cap">' + d.icon + " " + d.label + "</p>" + sliderHTML("adj", d.min === 0 ? 0 : -100, 100, v, d.label) +
        '<div class="fx-chips fx-chips--adj">' + ADJ.map(function (a) { var val = P.st.adj[a.id] || 0; return '<button type="button" class="fx-adj' + (val ? " is-set" : "") + '" data-adj="' + a.id + '" aria-pressed="' + (a.id === d.id) + '"><span aria-hidden="true">' + a.icon + "</span>" + a.label + (val ? "<i>" + (val > 0 ? "+" : "") + val + "</i>" : "") + "</button>"; }).join("") + "</div>";
    } else if (t === "filters") {
      h = '<div class="fx-filters" role="group" aria-label="Filters"><button type="button" class="fx-fil" data-fil="" aria-pressed="' + !P.st.filter + '"><canvas width="72" height="72" data-th=""></canvas>Normal</button>' +
        PRESETS.map(function (p) { return '<button type="button" class="fx-fil" data-fil="' + p.id + '" aria-pressed="' + (P.st.filter === p.id) + '"><canvas width="72" height="72" data-th="' + p.id + '"></canvas>' + esc(p.name) + "</button>"; }).join("") + "</div>" +
        (P.st.filter ? '<p class="fx-cap">' + esc(PBY[P.st.filter].name) + " strength</p>" + sliderHTML("famt", 0, 100, P.st.famt, "Filter strength") : '<p class="fx-note">Pick a look. Each one\'s named for somewhere I been.</p>');
    } else if (t === "text") {
      var L = selLayer("text");
      h = '<div class="fx-row"><button class="fx-btn fx-btn--go" type="button" data-t="add">＋ Add text</button>' + (L ? '<button class="fx-btn" type="button" data-t="edit">Edit</button><button class="fx-btn" type="button" data-t="dup">Duplicate</button><button class="fx-btn fx-btn--warn" type="button" data-t="del">Delete</button>' : "") + "</div>" +
        (L ? '<div class="fx-chips" role="group" aria-label="Font">' + FONTS.map(function (f) { return '<button type="button" class="fx-chip" data-font="' + f.id + '" aria-pressed="' + (L.font === f.id) + '" style="font:' + f.css.replace("{s}", 15) + '">' + f.name + "</button>"; }).join("") + "</div>" +
          swatches("col", L.color) +
          '<div class="fx-chips"><button type="button" class="fx-chip" data-stk="0" aria-pressed="' + (!L.stroke) + '">No outline</button><button type="button" class="fx-chip" data-stk="1" aria-pressed="' + (L.stroke === 1) + '">Outline</button><button type="button" class="fx-chip" data-stk="2" aria-pressed="' + (L.stroke === 2) + '">Thick</button><button type="button" class="fx-chip" data-bg="1" aria-pressed="' + (!!L.bg) + '">Label</button></div>'
          : '<p class="fx-note">Drag to move, pinch to size and spin, double-tap to edit.</p>');
    } else if (t === "stickers") {
      var Ls = selLayer("sticker");
      h = (Ls ? '<div class="fx-row"><button class="fx-btn" type="button" data-k="dup">Duplicate</button><button class="fx-btn fx-btn--warn" type="button" data-k="del">Delete</button></div>' : "") +
        '<div class="fx-stickers">' + STICKERS.map(function (s) { return '<button type="button" data-stk-add="' + s + '" aria-label="Add ' + s + '">' + s + "</button>"; }).join("") + "</div>";
    } else if (t === "draw") {
      h = swatches("brush", P.brush.er ? "" : P.brush.c) + '<p class="fx-cap">Brush size</p>' + sliderHTML("bsize", 1, 60, Math.round(P.brush.s * 1000), "Brush size") +
        '<div class="fx-row"><button class="fx-chip" type="button" data-d="er" aria-pressed="' + P.brush.er + '">🧽 Eraser</button><button class="fx-btn" type="button" data-d="clear"' + (P.st.strokes.length ? "" : " disabled") + ">Clear drawing</button></div>";
    } else if (t === "ai") {
      var hasKey = !!(xaiKey() || oaiKey());
      h = '<label class="fx-cap" for="fx-ai-in">✨ Ask Blarf to edit</label><textarea id="fx-ai-in" class="fx-ta" rows="2" maxlength="600" placeholder="e.g. make it a snowy night in Southie"></textarea>' +
        '<div class="fx-chips">' + ["make it night with neon", "add snow", "turn it into a comic", "remove the people in back", "make it look like a 90s disposable"].map(function (q) { return '<button type="button" class="fx-chip" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div>" +
        '<div class="fx-row"><button class="fx-btn fx-btn--go" type="button" data-ai="go"' + (hasKey ? "" : " disabled") + ">Ask Blarf to edit</button>" +
        '<button class="fx-btn" type="button" data-ai="take"' + (hasKey ? "" : " disabled") + ">💡 Blarf's take</button>" +
        (cutoutAvailable() ? '<button class="fx-btn" type="button" data-ai="cut">✂️ Cut out person</button>' : "") + "</div>" +
        (P.srcs.length > 1 ? '<div class="fx-chips" aria-label="Versions">' + P.srcs.map(function (s, i) { return '<button type="button" class="fx-chip" data-ver="' + i + '" aria-pressed="' + (P.st.v === i) + '">' + esc(s.label) + "</button>"; }).join("") + "</div>" : "") +
        (hasKey ? '<p class="fx-note">Sends this picture + your words to ' + (xaiKey() ? "Grok Imagine" : "OpenAI") + ". Comes back as a new version; undo goes back.</p>" : '<p class="fx-note">AI edits need an xAI or OpenAI key in Settings. Cut out runs right on your phone.</p>');
    }
    pn.innerHTML = h;
    pn.setAttribute("data-tab", t);
    wirePanel(pn, t);
    if (t === "filters") paintFilterThumbs(pn);
  }
  function swatches(kind, cur) { return '<div class="fx-sw" role="group" aria-label="Color">' + COLORS.map(function (c) { return '<button type="button" data-' + kind + '="' + c + '" aria-pressed="' + (c === cur) + '" aria-label="Color ' + c + '" style="--c:' + c + '"></button>'; }).join("") + "</div>"; }
  function selLayer(kind) { var l = null; P.st.layers.forEach(function (x) { if (x.id === P.sel && (!kind || x.kind === kind)) l = x; }); return l; }
  function wirePanel(pn, t) {
    var sl = pn.querySelector('[data-sl="adj"]');
    if (sl) wireSlider(sl, function (v) { P.st.adj[P.adjSel] = v; draw(); }, function () { if (commit()) paintAdjChips(pn); });
    var fa = pn.querySelector('[data-sl="famt"]');
    if (fa) wireSlider(fa, function (v) { P.st.famt = v; draw(); }, function () { commit(); });
    var bs = pn.querySelector('[data-sl="bsize"]');
    if (bs) wireSlider(bs, function (v) { P.brush.s = v / 1000; });
    pn.onclick = function (e) {
      var b = e.target.closest("button"); if (!b || b.disabled) return;
      var st = P.st, A = function (n) { return b.getAttribute(n); };
      if (A("data-asp") != null) {
        st.aspect = A("data-asp"); var o = oDims(); st.crop = fitAspect(st.aspect === "free" ? st.crop : { x: 0, y: 0, w: 1, h: 1 }, aspectRatio(), o.w, o.h);
        commit(); paintPanel(); draw(); paintHistory();
      } else if (A("data-c")) {
        var c = A("data-c");
        if (c === "rot") { st.rot = (st.rot + 90) % 360; st.crop = rotCrop(st.crop); }
        else if (c === "fh") { st.fh = !st.fh; st.crop.x = 1 - st.crop.x - st.crop.w; }
        else if (c === "fv") { st.fv = !st.fv; st.crop.y = 1 - st.crop.y - st.crop.h; }
        else if (c === "reset") { st.rot = 0; st.fh = st.fv = false; st.crop = { x: 0, y: 0, w: 1, h: 1 }; st.aspect = "free"; }
        commit(); paintPanel(); draw(); paintHistory();
      } else if (A("data-adj")) { P.adjSel = A("data-adj"); paintPanel(); }
      else if (A("data-fil") != null) { var f = A("data-fil"); if (st.filter !== f) { st.filter = f; st.famt = 100; commit(); } paintPanel(); draw(); }
      else if (A("data-t") === "add") addText();
      else if (A("data-t") === "edit") { var L = selLayer("text"); if (L) editText(L); }
      else if (A("data-t") === "dup" || A("data-k") === "dup") dupLayer();
      else if (A("data-t") === "del" || A("data-k") === "del") delLayer();
      else if (A("data-font")) { var L2 = selLayer(); if (L2) { L2.font = A("data-font"); commit(); paintPanel(); draw(); } }
      else if (A("data-col")) { var L3 = selLayer(); if (L3) { L3.color = A("data-col"); commit(); paintPanel(); draw(); } }
      else if (A("data-stk") != null && t === "text") { var L4 = selLayer(); if (L4) { L4.stroke = +A("data-stk"); commit(); paintPanel(); draw(); } }
      else if (A("data-bg")) { var L5 = selLayer(); if (L5) { L5.bg = !L5.bg; commit(); paintPanel(); draw(); } }
      else if (A("data-stk-add")) addSticker(A("data-stk-add"));
      else if (A("data-brush")) { P.brush.c = A("data-brush"); P.brush.er = false; paintPanel(); }
      else if (A("data-d") === "er") { P.brush.er = !P.brush.er; paintPanel(); }
      else if (A("data-d") === "clear") { st.strokes = []; commit(); paintPanel(); draw(); }
      else if (A("data-q")) { var ta = $("fx-ai-in"); if (ta) { ta.value = A("data-q"); ta.focus(); } }
      else if (A("data-ai") === "go") { var v = ($("fx-ai-in").value || "").trim(); if (!v) { toast("Tell me what to change first."); return; } withKeys(function () { runAiEdit(v); }); }
      else if (A("data-ai") === "take") withKeys(runTake);
      else if (A("data-ai") === "cut") runCutout();
      else if (A("data-ver") != null) { var vi = +A("data-ver"); if (vi !== st.v) { P.st = freshState(vi); commit(); P.cache = {}; paintPanel(); draw(); paintHistory(); } }
    };
  }
  function paintAdjChips(pn) { var keep = P.adjSel; paintPanel(); P.adjSel = keep; }
  function paintFilterThumbs(pn) {
    var s = src(); if (!s) return;
    var k = 72 / Math.min(s.width, s.height), base = canvas(72, 72), bx = ctx2d(base); if (!bx) return;
    var o = { rot: P.st.rot, fh: P.st.fh, fv: P.st.fv }, c = P.st.crop, od = oDims(), side = Math.min(c.w * od.w, c.h * od.h);
    var sq = { x: c.x + (c.w * od.w - side) / 2 / od.w, y: c.y + (c.h * od.h - side) / 2 / od.h, w: side / od.w, h: side / od.h };
    drawGeo(bx, s, s.width, s.height, o, 72, 72, sq);
    [].slice.call(pn.querySelectorAll("canvas[data-th]")).forEach(function (cv, i) {
      setTimeout(function () {
        var id = cv.getAttribute("data-th"), p = combine(P.st.adj, id, 1); p.seed = 7;
        var out = processFrame(base, 72, 72, p), x = ctx2d(cv); if (x) { x.clearRect(0, 0, 72, 72); x.drawImage(out, 0, 0); }
      }, i * 12);
    });
  }
  function addText() {
    var l = { id: uid("l"), kind: "text", text: "", font: "impact", color: "#ffffff", stroke: 1, size: 0.09, x: 0.5, y: 0.5, rot: 0, bg: false };
    editText(l, true);
  }
  function editText(l, isNew) {
    var r = root(), m = doc.createElement("div"); m.className = "fx-textedit";
    m.innerHTML = '<div class="fx-textedit__bar"><button class="fx-btn" type="button" data-x>Cancel</button><button class="fx-btn fx-btn--go" type="button" data-ok>Done</button></div><textarea rows="3" maxlength="300" aria-label="Text" placeholder="Say somethin\'"></textarea>';
    var ta = m.querySelector("textarea"); ta.value = l.text || ""; ta.style.color = l.color === "#0b0b0b" ? "#fff" : l.color;
    function fin(save) {
      m.remove();
      if (!save) return;
      var v = ta.value.replace(/\s+$/, "");
      if (!v) { if (!isNew) { P.st.layers = P.st.layers.filter(function (x) { return x !== l; }); P.sel = null; commit(); } paintPanel(); draw(); return; }
      l.text = v; if (isNew) P.st.layers.push(l);
      P.sel = l.id; commit(); paintPanel(); draw();
    }
    m.querySelector("[data-x]").onclick = function () { fin(false); };
    m.querySelector("[data-ok]").onclick = function () { fin(true); };
    r.appendChild(m); setTimeout(function () { ta.focus(); }, 30);
  }
  function addSticker(e) {
    var l = { id: uid("s"), kind: "sticker", text: e, size: 0.18, x: 0.5 + (Math.random() - 0.5) * 0.2, y: 0.45 + (Math.random() - 0.5) * 0.2, rot: (Math.random() - 0.5) * 0.4 };
    P.st.layers.push(l); P.sel = l.id; commit(); paintPanel(); draw(); tick();
  }
  function dupLayer() { var l = selLayer(); if (!l) return; var c = JSON.parse(JSON.stringify(l)); c.id = uid("l"); c.x = Math.min(1, c.x + 0.05); c.y = Math.min(1, c.y + 0.05); P.st.layers.push(c); P.sel = c.id; commit(); paintPanel(); draw(); }
  function delLayer() { var l = selLayer(); if (!l) return; P.st.layers = P.st.layers.filter(function (x) { return x !== l; }); P.sel = null; commit(); paintPanel(); draw(); }

  /* ---------- full-res render (export, AI input) ---------- */
  function renderFull(maxSide) {
    var s = src(), d = outDims(), k = 1;
    if (d.w * d.h > MAX_PX) k = Math.sqrt(MAX_PX / (d.w * d.h));
    if (maxSide) k = Math.min(k, maxSide / Math.max(d.w, d.h));
    var W = Math.max(1, Math.round(d.w * k)), H = Math.max(1, Math.round(d.h * k));
    var g = canvas(W, H), gx = ctx2d(g); if (!gx) throw "No canvas here.";
    drawGeo(gx, s, s.width, s.height, P.st, W, H);
    var pr = params(), out = processFrame(g, W, H, pr);
    if (out !== g) { gx.clearRect(0, 0, W, H); gx.drawImage(out, 0, 0); }
    if (P.st.strokes.length) gx.drawImage(drawStrokes(W, H, P.st.strokes), 0, 0);
    P.st.layers.forEach(function (l) { drawLayer(gx, l, W, H, false); });
    g.alpha = !!s.alpha;
    return g;
  }
  function openExport() {
    var r = root(), sh = doc.createElement("div"); sh.className = "fx-sheet";
    var d = outDims(), cap = d.w * d.h > MAX_PX, alpha = !!(src() && src().alpha);
    if (alpha) P.fmt = "png";
    sh.innerHTML = '<div class="fx-sheet__card"><div class="fx-pick__head"><b>Save your picture</b><button class="fx-icon" type="button" data-x aria-label="Close">×</button></div>' +
      '<div class="fx-chips"><button type="button" class="fx-chip" data-f="jpeg" aria-pressed="' + (P.fmt === "jpeg") + '">JPEG</button><button type="button" class="fx-chip" data-f="png" aria-pressed="' + (P.fmt === "png") + '">PNG' + (alpha ? " (keeps cutout)" : "") + "</button></div>" +
      '<p class="fx-note" id="fx-exp-info">Rendering full res…</p>' +
      '<div class="fx-row"><button class="fx-btn fx-btn--go" type="button" data-s="lib" disabled>Save to Library</button><button class="fx-btn" type="button" data-s="share" disabled>Share…</button><button class="fx-btn" type="button" data-s="chat" disabled>Send to Blarf</button></div></div>';
    r.appendChild(sh);
    function prep() {
      var info = sh.querySelector("#fx-exp-info"); [].slice.call(sh.querySelectorAll("[data-s]")).forEach(function (b) { b.disabled = true; });
      info.textContent = "Rendering full res…";
      setTimeout(function () {
        var key = P.base + P.fmt;
        var p = P.exp && P.exp.key === key ? Promise.resolve(P.exp) : Promise.resolve().then(function () {
          var c = renderFull(), type = P.fmt === "png" ? "image/png" : "image/jpeg";
          return toBlob(c, type, 0.92).then(function (b) { P.exp = { key: key, blob: b, w: c.width, h: c.height }; return P.exp; });
        });
        p.then(function (x) {
          if (!sh.isConnected) return;
          info.textContent = x.w + "×" + x.h + " · " + (x.blob.size / 1048576).toFixed(1) + " MB" + (cap ? " · capped at 16 MP (iPhone limit)" : "");
          [].slice.call(sh.querySelectorAll("[data-s]")).forEach(function (b) { b.disabled = false; });
        }, function (e) { info.textContent = String(e); });
      }, 30);
    }
    function fname() { return (P.name ? P.name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 40) + "-" : "blarf-fx-") + stamp() + (P.fmt === "png" ? ".png" : ".jpg"); }
    sh.addEventListener("click", function (e) {
      if (e.target === sh || e.target.closest("[data-x]")) { sh.remove(); return; }
      var f = e.target.closest("[data-f]"); if (f) { P.fmt = f.getAttribute("data-f"); [].slice.call(sh.querySelectorAll("[data-f]")).forEach(function (b) { b.setAttribute("aria-pressed", b === f); }); prep(); return; }
      var b = e.target.closest("[data-s]"); if (!b || b.disabled || !P.exp) return;
      var s = b.getAttribute("data-s");
      if (s === "lib") saveToLibrary(P.exp.blob, fname()).then(function () { P.saved = true; toast("🖼️ Saved to Library › Studio FX"); sh.remove(); if (C && C.act) C.act("proud"); }, function (er) { toast(String(er)); });
      else if (s === "share") shareBlob(P.exp.blob, fname()).then(function (r2) { if (r2 !== "cancel") P.saved = true; }, function () { toast("Share failed."); });
      else if (s === "chat") {
        var sm = renderFull(1280), cx = canvas(sm.width, sm.height), xx = ctx2d(cx); xx.fillStyle = "#fff"; xx.fillRect(0, 0, cx.width, cx.height); xx.drawImage(sm, 0, 0);
        var u = cx.toDataURL("image/jpeg", 0.85); P.saved = true; sh.remove();
        closeRoot(root(), function () { P = null; });
        sendToChat(u);
      }
    });
    prep();
  }

  /* ---------- AI ---------- */
  function aiInput() {
    var c = renderFull(1536);
    return c.alpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.9);
  }
  function addVersion(c, label) {
    P.srcs.push({ c: c, label: label });
    P.st = freshState(P.srcs.length - 1); commit(); P.cache = {}; P.size = null; paintHistory(); paintPanel(); draw();
  }
  function runAiEdit(prompt) {
    var r = root(), ctrl = typeof AbortController !== "undefined" ? new AbortController() : null, live = true;
    busy(r, true, "Blarf's workin' on it… (up to a minute)", function () { live = false; if (ctrl) ctrl.abort(); busy(r, false); });
    if (C && C.act) C.act("onit");
    var input; try { input = aiInput(); } catch (e) { busy(r, false); toast(String(e)); return; }
    aiEditRequest(input, prompt, ctrl).then(function (url) {
      if (!live || !P) return;
      if (lib() && lib().onGenerated) lib().onGenerated(url, "Edit: " + prompt);
      return loadImage(url).then(function (im) { var c = toCanvas(im); addVersion(c, "AI " + P.srcs.length); busy(r, false); say("There. " + clip(prompt, 40) + ". Don't say I never did nothin' for ya."); });
    }).catch(function (e) { busy(r, false); if (live) toast(String(e)); });
  }
  function clip(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function runTake() {
    var r = root(), ctrl = typeof AbortController !== "undefined" ? new AbortController() : null, live = true;
    busy(r, true, "Blarf's squintin' at it…", function () { live = false; if (ctrl) ctrl.abort(); busy(r, false); });
    var input; try { var c = renderFull(768); input = c.toDataURL("image/jpeg", 0.8); } catch (e) { busy(r, false); toast(String(e)); return; }
    suggestRequest(input, ctrl).then(function (s) {
      if (!live || !P) return; busy(r, false);
      showTake(s);
    }, function (e) { busy(r, false); if (live) toast(String(e)); });
  }
  function showTake(s) {
    var el = $("fx-say"); if (!el) return;
    el.innerHTML = '<span class="fx-say__face" aria-hidden="true">😤</span><div><p>' + esc(s.line || "Eh. I got ideas.") + '</p><div class="fx-chips">' +
      s.looks.map(function (l, i) { return '<button type="button" class="fx-chip" data-look="' + i + '" title="' + esc(l.why) + '">' + esc(l.name) + "</button>"; }).join("") +
      (s.ai ? '<button type="button" class="fx-chip" data-aiq>✨ ' + esc(clip(s.ai, 40)) + "</button>" : "") + '</div></div><button class="fx-icon" type="button" data-x aria-label="Dismiss">×</button>';
    el.hidden = false; clearTimeout(say.t);
    el.onclick = function (e) {
      if (e.target.closest("[data-x]")) { el.hidden = true; return; }
      var b = e.target.closest("[data-look]");
      if (b) { var l = s.looks[+b.getAttribute("data-look")]; P.st.adj = JSON.parse(JSON.stringify(l.adjust)); P.st.filter = l.filter; P.st.famt = 100; commit(); paintPanel(); draw(); toast(l.name + (l.why ? ": " + l.why : "")); return; }
      if (e.target.closest("[data-aiq]")) { setTab("ai"); var ta = $("fx-ai-in"); if (ta) ta.value = s.ai; }
    };
  }
  function runCutout() {
    var r = root(), live = true;
    busy(r, true, seg ? "Cuttin' you out…" : "Grabbin' the cutout brain (one time, ~15 MB)…", function () { live = false; busy(r, false); });
    var s = src();
    var base = canvas(s.width, s.height), bx = ctx2d(base);
    var st = { rot: 0, fh: false, fv: false };
    bx.drawImage(s, 0, 0);
    cutout(base).then(function (c) {
      if (!live || !P) return; busy(r, false);
      addVersion(c, "Cutout");
      var keep = P.srcs.length - 1; P.st.v = keep; void st;
      P.fmt = "png"; say("Cut ya out. Save as PNG to keep it see-through.");
    }, function (e) { busy(r, false); if (live) toast(typeof e === "string" ? e : "The cutout brain wouldn't load (needs the internet the first time)."); });
  }

  /* ---------- hooks ---------- */
  function sendToChat(u) {
    if (!C) return;
    try { C.go("chat"); C.setSheet(true); if (C.V.chat && C.V.chat.setPend) C.V.chat.setPend(u); setTimeout(function () { C.V.chat.input.focus(); }, 380); } catch (e) {}
  }
  function lastChatImage() {
    var t = (S().threads && S().threads.chat) || [];
    for (var i = t.length - 1; i >= 0; i--) { var m = t[i]; if (m && typeof m.img === "string" && /^(data:image\/|https:\/\/)/.test(m.img)) return m.img; }
    return "";
  }
  function findLib(kind, name) {
    var L = lib(); if (!L || !L.items) return null;
    var items = L.items(kind); if (!items.length) return null;
    if (!name) return items[0];
    var q = String(name).toLowerCase(), best = null;
    items.forEach(function (it) { if (!best && String(it.name).toLowerCase().indexOf(q) >= 0) best = it; });
    return best;
  }
  function chooser() {
    var r = root(); openRoot(r); P = P || null;
    var m = doc.createElement("div"); m.className = "fx-pick";
    m.innerHTML = '<div class="fx-pick__card fx-confirm"><b>🎬 Studio FX</b><p>What are we makin\u2019?</p><div class="fx-start__row"><button class="fx-big" type="button" data-k="p"><span>🖼️</span>Photo</button><button class="fx-big" type="button" data-k="v"><span>🎬</span>Video</button></div><button class="fx-btn" type="button" data-k="x">Never mind</button></div>';
    m.addEventListener("click", function (e) {
      var b = e.target.closest("[data-k]"); if (!b && e.target !== m) return;
      var k = b ? b.getAttribute("data-k") : "x"; m.remove();
      if (k === "p") openPhoto(null);
      else { closeRoot(r); if (k === "v" && window.blarfVideo) window.blarfVideo.open(); }
    });
    r.appendChild(m);
  }
  function init() {
    if (C) return; C = window.blarfCore; if (!C) return;
    /* ⋯ menu */
    var lst = doc.querySelector("#menu .x-menu__list"), libBtn = lst && lst.querySelector('[data-go="library"]');
    if (lst && !$("menu-fx")) {
      var b = doc.createElement("button"); b.className = "x-menu__item"; b.type = "button"; b.id = "menu-fx";
      b.innerHTML = '<span aria-hidden="true">🎬</span><span>Studio FX</span>';
      lst.insertBefore(b, libBtn ? libBtn.nextSibling : null);
      b.addEventListener("click", function () { try { C.setMenu(false, true); } catch (e) {} setTimeout(chooser, 60); });
    }
    /* lightbox: edit Blarf's picture */
    var bar = doc.querySelector("#lbox .x-lbox__bar");
    if (bar && !$("lbox-edit")) {
      var e2 = doc.createElement("button"); e2.className = "btn"; e2.id = "lbox-edit"; e2.type = "button"; e2.textContent = "✏️ Edit";
      bar.insertBefore(e2, bar.firstChild);
      e2.addEventListener("click", function () {
        var im = doc.querySelector("#lbox img"); if (!im || !im.src) return;
        var s = im.src; try { $("lbox-x").click(); } catch (er) {}
        openPhoto(s, { name: "blarf-picture" });
      });
    }
  }
  window.blarfFX = {
    openPhoto: openPhoto, chooser: chooser, lastChatImage: lastChatImage, findLib: findLib,
    /* shared with the video editor */
    ADJ: ADJ, PRESETS: PRESETS, combine: combine, isIdentity: isIdentity, processFrame: processFrame, drawLayer: drawLayer, rrect: rrect, FONTS: FONTS, COLORS: COLORS, fontOf: fontOf,
    canvas: canvas, ctx2d: ctx2d, sliderHTML: sliderHTML, wireSlider: wireSlider, busy: busy, pickFromLibrary: pickFromLibrary, pickFile: pickFile, confirmBox: confirmBox,
    openRoot: openRoot, closeRoot: closeRoot, saveToLibrary: saveToLibrary, shareBlob: shareBlob, stamp: stamp, withKeys: withKeys, xaiKey: xaiKey, oaiKey: oaiKey, fetchJSON: fetchJSON,
    offline: offline, esc: esc, clamp: clamp, uid: uid, tick: tick, core: function () { return C; },
    _t: { cpuApply: cpuApply, rotCrop: rotCrop, fitAspect: fitAspect, parseSuggest: parseSuggest, maskToAlpha: maskToAlpha, aiEditRequest: aiEditRequest, suggestRequest: suggestRequest,
      P: function () { return P; }, commit: function () { return commit(); }, undo: undo, redo: redo, setTab: setTab, renderFull: renderFull, oriented: oriented, drawGeo: drawGeo, addSticker: addSticker,
      runAiEdit: runAiEdit, showTake: showTake, close: close, openExport: openExport, XAI_EDIT: XAI_EDIT, OAI_IMG_MODEL: OAI_IMG_MODEL, MAX_PX: MAX_PX, glInit: glInit }
  };
  if (window.blarfCore) init(); else window.addEventListener("blarf-core", init);
})();

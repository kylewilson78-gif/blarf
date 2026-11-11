/* Blarf OS P2a: Library (Blarf's projects folder) + Knowledge Vault. Everything lives on this device in IndexedDB "blarfLib".
   Folders (linked to memory projects when names match) hold chats, files (text pulled from txt/md/json/csv/code and PDFs via
   pdf.js loaded on demand), images (every picture Blarf draws lands in "Generated") and Builds (code Blarf writes, runnable
   in a sandboxed iframe). "Use in chat" pins items/folders: their text is chunked, and the top chunks for each message
   (embeddings when an OpenAI key is around, BM25 otherwise) ride in the prompt. */
(function () {
  "use strict";
  var doc = document, C = null;
  var GEN = "f-gen", BUILDS = "f-builds", ATTACH = "f-attach";
  var CHUNK = 900, OVERLAP = 120, MAX_CHUNKS = 400, MAX_TEXT = 300000, CLAUSE_MAX = 2600;
  var PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
  var TEXT_EXT = /^(txt|md|markdown|json|csv|tsv|log|xml|yaml|yml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|ini|toml|env|srt|vtt|lrc|rtf)$/i;
  var TYPE_ICON = { folder: "📁", chat: "💬", file: "📄", image: "🖼️", build: "🕹️" };
  var L = { items: [], by: {}, chunks: {}, tk: new Map(), ready: false, folder: "", filter: "all", q: "", sel: null, picker: null, ctx: null, urls: {}, armed: null, est: null, threadSel: null };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(t) { if (C) C.toast(t); }
  function S() { return C ? C.S : {}; }
  function cfg() {
    var s = S(); if (!s.lib || typeof s.lib !== "object") s.lib = {};
    var c = s.lib;
    if (typeof c.autoImg !== "boolean") c.autoImg = true;
    if (typeof c.autoIndex !== "boolean") c.autoIndex = true;
    if (c.view !== "list") c.view = "grid";
    if (["recent", "name", "size", "type"].indexOf(c.sort) < 0) c.sort = "recent";
    return c;
  }
  function uid(p) { return (p || "i") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function clip(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function bytes(n) { n = +n || 0; return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(2) + " GB"; }
  function when(ts) {
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
  }
  function extOf(name) { var m = /\.([a-z0-9]{1,8})$/i.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; }

  /* ---------- IndexedDB: items, blobs (ArrayBuffer + type), chunks ---------- */
  var DB = (function () {
    var db = null, state = 0, wait = [];
    function ready(cb) {
      if (state) return cb();
      wait.push(cb); if (wait.length > 1) return;
      var done = function (st) { state = st; var w = wait; wait = []; w.forEach(function (f) { f(); }); };
      try {
        var rq = indexedDB.open("blarfLib", 1);
        rq.onupgradeneeded = function () {
          var d = rq.result;
          d.createObjectStore("items", { keyPath: "id" });
          d.createObjectStore("blobs", { keyPath: "id" });
          d.createObjectStore("chunks", { keyPath: "id" }).createIndex("item", "item");
        };
        rq.onsuccess = function () { db = rq.result; done(1); };
        rq.onerror = function () { done(-1); };
        setTimeout(function () { if (!state) done(-1); }, 4000);
      } catch (e) { done(-1); }
    }
    function tx(store, mode, fn) {
      return new Promise(function (res, rej) {
        ready(function () {
          if (state !== 1) return rej("The Library needs IndexedDB, which this browser blocked.");
          try {
            var t = db.transaction(store, mode), os = t.objectStore(store), out = fn(os);
            t.oncomplete = function () { res(out && "result" in out ? out.result : undefined); };
            t.onerror = t.onabort = function () { var e = t.error; rej(e && e.name === "QuotaExceededError" ? "Out of storage space on this iPhone." : "Couldn't save to the Library."); };
          } catch (e) { rej("Couldn't reach the Library."); }
        });
      });
    }
    return {
      ok: function () { return state === 1; },
      all: function (store) { return tx(store, "readonly", function (os) { return os.getAll(); }).then(function (r) { return r || []; }); },
      get: function (store, id) { return tx(store, "readonly", function (os) { return os.get(id); }); },
      put: function (store, v) { return tx(store, "readwrite", function (os) { os.put(v); }); },
      putMany: function (store, list) { return tx(store, "readwrite", function (os) { list.forEach(function (v) { os.put(v); }); }); },
      del: function (store, id) { return tx(store, "readwrite", function (os) { os["delete"](id); }); },
      delChunks: function (item) {
        return tx("chunks", "readwrite", function (os) {
          var r = os.index("item").openCursor(IDBKeyRange.only(item));
          r.onsuccess = function () { var c = r.result; if (c) { c["delete"](); c["continue"](); } };
        });
      }
    };
  })();

  /* ---------- quota ---------- */
  function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().then(function (e) { L.est = e; return e; }, function () { return null; });
  }
  function roomFor(size) {
    return estimate().then(function (e) {
      if (e && e.quota && e.usage + size > e.quota * 0.95) throw "Not enough room on this iPhone for that (" + bytes(size) + "). Delete something in the Library first.";
      if (navigator.storage && navigator.storage.persist && !roomFor.asked) { roomFor.asked = true; navigator.storage.persist().catch(function () {}); }
    });
  }
  function libBytes() { return L.items.reduce(function (n, it) { return n + (it.size || 0); }, 0); }

  /* ---------- items ---------- */
  function put(it) { it.updated = it.updated || Date.now(); if (!L.by[it.id]) L.items.push(it); L.by[it.id] = it; return DB.put("items", it); }
  function children(fid) { return L.items.filter(function (x) { return x.folder === fid; }); }
  function descendants(fid) { var out = []; children(fid).forEach(function (x) { out.push(x); if (x.type === "folder") out = out.concat(descendants(x.id)); }); return out; }
  function pathOf(it) { var p = [], f = L.by[it.folder]; while (f) { p.unshift(f.name); f = L.by[f.folder]; } return p.join(" › "); }
  function ensureFolder(id, name, sys) {
    if (L.by[id]) return Promise.resolve(L.by[id]);
    var f = { id: id, type: "folder", name: name, folder: "", created: Date.now(), updated: Date.now(), size: 0, sys: !!sys };
    return put(f).then(function () { return f; });
  }
  function linkProject(f) {
    if (!C || f.type !== "folder") return;
    var best = null, bs = 0;
    C.memProjects().forEach(function (p) {
      var s = C.memKey(p.p.name) === C.memKey(f.name) ? 1 : C.memSim(p.p.name, f.name);
      if (s > bs) { bs = s; best = p; }
    });
    var id = best && bs >= 0.5 ? best.id : "";
    if ((f.project || "") !== id) { f.project = id; DB.put("items", f).catch(function () {}); }
  }
  function projectOf(f) { if (!C || !f || !f.project) return null; return C.memProjects().filter(function (p) { return p.id === f.project; })[0] || null; }
  function newFolder(name, parent) {
    name = clip(name, 60); if (!name) return Promise.reject("Name it something.");
    var f = { id: uid("f"), type: "folder", name: name, folder: parent || "", created: Date.now(), updated: Date.now(), size: 0 };
    linkProject(f);
    return put(f).then(function () { return f; });
  }
  function blobOf(id) {
    return DB.get("blobs", id).then(function (b) { return b && b.buf ? new Blob([b.buf], { type: b.type || "application/octet-stream" }) : null; });
  }
  function urlOf(it) {
    if (L.urls[it.id]) return Promise.resolve(L.urls[it.id]);
    if (it.meta && it.meta.url && !it.hasBlob) return Promise.resolve(it.meta.url);
    return blobOf(it.id).then(function (b) { if (!b) return ""; L.urls[it.id] = URL.createObjectURL(b); return L.urls[it.id]; });
  }
  function remove(it) {
    var list = it.type === "folder" ? descendants(it.id).concat([it]) : [it];
    list.forEach(function (x) {
      L.items = L.items.filter(function (y) { return y !== x; }); delete L.by[x.id]; delete L.chunks[x.id];
      if (L.urls[x.id]) { try { URL.revokeObjectURL(L.urls[x.id]); } catch (e) {} delete L.urls[x.id]; }
    });
    return Promise.all(list.map(function (x) { return Promise.all([DB.del("items", x.id), x.hasBlob ? DB.del("blobs", x.id) : null, DB.delChunks(x.id)]); })).then(function () { L.ctx = null; return list.length; });
  }

  /* ---------- reading files ---------- */
  function readBuf(f) { return f.arrayBuffer ? f.arrayBuffer() : new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsArrayBuffer(f); }); }
  function isText(name, type) { return /^text\//.test(type || "") || /json|xml|csv|javascript|markdown|yaml|x-sh|sql/.test(type || "") || TEXT_EXT.test(extOf(name)); }
  function decodeText(buf) { try { return new TextDecoder("utf-8").decode(buf); } catch (e) { return ""; } }
  function loadPdfjs() {
    if (api._t.pdfLoader) return Promise.resolve(api._t.pdfLoader());
    if (loadPdfjs.p) return loadPdfjs.p;
    loadPdfjs.p = (new Function("u", "return import(u)"))(PDFJS + "pdf.min.mjs").then(function (m) {
      m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs"; return m;
    });
    loadPdfjs.p.catch(function () { loadPdfjs.p = null; });
    return loadPdfjs.p;
  }
  function pdfText(buf) {
    return loadPdfjs().then(function (pdfjs) {
      return pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), isEvalSupported: false }).promise.then(function (pdf) {
        var n = Math.min(pdf.numPages, 300), out = [], i = 0;
        function page() {
          if (++i > n) return { text: out.join("\n\n"), pages: pdf.numPages };
          return pdf.getPage(i).then(function (pg) { return pg.getTextContent(); }).then(function (tc) {
            out.push(tc.items.map(function (x) { return x.str + (x.hasEOL ? "\n" : " "); }).join("").replace(/[ \t]+/g, " ").trim());
            return out.join("").length > MAX_TEXT ? { text: out.join("\n\n"), pages: pdf.numPages } : page();
          });
        }
        return page();
      });
    });
  }
  function thumbFrom(src, max) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () {
        try {
          var k = Math.min(1, (max || 360) / Math.max(im.naturalWidth, im.naturalHeight || 1)), cv = doc.createElement("canvas");
          cv.width = Math.max(1, Math.round(im.naturalWidth * k)); cv.height = Math.max(1, Math.round(im.naturalHeight * k));
          var cx = cv.getContext("2d"); if (!cx) return res({ thumb: "", w: im.naturalWidth, h: im.naturalHeight });
          cx.drawImage(im, 0, 0, cv.width, cv.height);
          res({ thumb: cv.toDataURL("image/jpeg", 0.72), w: im.naturalWidth, h: im.naturalHeight });
        } catch (e) { res({ thumb: "" }); }
      };
      im.onerror = function () { res({ thumb: "" }); };
      im.src = src;
      setTimeout(function () { res({ thumb: "" }); }, 8000);
    });
  }
  function dataToBuf(src) {
    var m = /^data:([^;,]+);base64,(.*)$/.exec(src); if (!m) return null;
    var bin = atob(m[2]), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return { buf: u.buffer, type: m[1] };
  }
  /* one file in: blob saved, text pulled, thumb made, indexed when auto-index is on (or it's pinned) */
  function addFile(file, folder, o) {
    o = o || {};
    var name = clip(file.name || "file", 120), type = file.type || "", size = file.size || 0;
    return roomFor(size).then(function () { return readBuf(file); }).then(function (buf) {
      var kind = /^image\//.test(type) ? "image" : "file";
      var it = { id: uid(kind === "image" ? "m" : "d"), type: kind, name: name, folder: folder || "", created: Date.now(), updated: Date.now(), size: buf.byteLength, mime: type, ext: extOf(name), hasBlob: true, meta: { src: o.src || "upload" } };
      if (kind === "file" && isText(name, type)) it.text = decodeText(buf).slice(0, MAX_TEXT);
      if (kind === "image") {
        var u = URL.createObjectURL(new Blob([buf], { type: type }));
        thumbFrom(u, 360).then(function (t) { URL.revokeObjectURL(u); if (!t.thumb || !L.by[it.id]) return; it.thumb = t.thumb; if (t.w) it.meta.dim = t.w + "×" + t.h; DB.put("items", it).then(paint, function () {}); });
      }
      return DB.put("blobs", { id: it.id, buf: buf, type: type }).then(function () { return put(it); }).then(function () {
        if (o.pin) it.pinned = true;
        if (it.ext === "pdf" || type === "application/pdf") {
          it.meta.pdf = "reading";
          pdfText(buf).then(function (r) {
            it.text = String(r.text || "").slice(0, MAX_TEXT); it.meta.pages = r.pages; it.meta.pdf = it.text.trim().length > 20 ? "ok" : "notext";
            return put(it).then(function () { return maybeIndex(it); });
          }).catch(function () { it.meta.pdf = "failed"; put(it).catch(function () {}); }).then(function () { paint(); });
        }
        return maybeIndex(it).then(function () { return it; });
      });
    });
  }
  function addFiles(list, folder, o) {
    var files = [].slice.call(list || []), done = [], i = 0;
    function one() {
      if (i >= files.length) return Promise.resolve(done);
      return addFile(files[i++], folder, o).then(function (it) { done.push(it); return one(); }, function (e) { toast(String(e)); return one(); });
    }
    return one().then(function (d) { paint(); return d; });
  }

  /* ---------- chats, builds, generated pictures ---------- */
  function saveChat(msgs, name, folder) {
    msgs = (msgs || []).filter(function (x) { return x && typeof x.t === "string" && x.t.trim(); });
    if (!msgs.length) return Promise.reject("Nothing to save.");
    var text = msgs.map(function (x) { return (x.r === "me" ? "Kyle: " : "Blarf: ") + x.t; }).join("\n\n");
    var first = msgs.filter(function (x) { return x.r === "me"; })[0] || msgs[0];
    var it = { id: uid("c"), type: "chat", name: clip(name || first.t, 60), folder: folder || "", created: Date.now(), updated: Date.now(), size: text.length, mime: "text/markdown", text: text.slice(0, MAX_TEXT),
      meta: { msgs: msgs.slice(-300).map(function (x) { return { r: x.r === "me" ? "me" : "bot", t: String(x.t).slice(0, 8000), ts: x.ts || 0 }; }), src: "chat" } };
    return put(it).then(function () { return maybeIndex(it); }).then(function () { paint(); return it; });
  }
  function runnable(src, lang) {
    lang = String(lang || "").toLowerCase();
    if (/^(html?|svg|xhtml)$/.test(lang)) return true;
    if (/^(js|javascript|mjs)$/.test(lang)) return true;
    if (!lang || lang === "xml") return /<(html|body|canvas|script|svg|div)[\s>]/i.test(src || "");
    return false;
  }
  function toHtml(src, lang) {
    lang = String(lang || "").toLowerCase();
    var head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>html,body{margin:0;min-height:100%;background:#111;color:#eee;font-family:-apple-system,system-ui,sans-serif}canvas{display:block;max-width:100%}</style>';
    if (/^(js|javascript|mjs)$/.test(lang) && !/<script[\s>]/i.test(src)) return "<!doctype html><html><head>" + head + '</head><body><canvas id="c" width="360" height="560"></canvas><script>' + String(src).replace(/<\/script/gi, "<\\/script") + "<\/script></body></html>";
    if (/<html[\s>]/i.test(src)) return src;
    return "<!doctype html><html><head>" + head + "</head><body>" + src + "</body></html>";
  }
  function buildName(src, lang) {
    var t = /<title>([^<]{1,60})<\/title>/i.exec(src) || /^\s*(?:\/\/|#|<!--)\s*([^\n]{3,60})/.exec(src);
    return clip(t ? t[1].replace(/-->$/, "") : (lang ? lang.toUpperCase() + " build" : "Build") + " · " + when(Date.now()), 60);
  }
  function saveCode(src, lang, name) {
    var run = runnable(src, lang);
    return ensureFolder(BUILDS, "Builds", true).then(function () {
      var it = { id: uid("b"), type: run ? "build" : "file", name: name || buildName(src, lang), folder: BUILDS, created: Date.now(), updated: Date.now(), size: src.length,
        mime: run ? "text/html" : "text/plain", ext: run ? "html" : (lang || "txt"), text: src.slice(0, MAX_TEXT), meta: { lang: lang || "", src: "blarf" } };
      return put(it).then(function () { return maybeIndex(it); }).then(function () { paint(); return it; });
    });
  }
  function onGenerated(src, prompt) {
    if (!cfg().autoImg || typeof src !== "string") return Promise.resolve(null);
    return ensureFolder(GEN, "Generated", true).then(function () {
      var d = dataToBuf(src), it = { id: uid("g"), type: "image", name: clip(prompt || "Blarf's picture", 60), folder: GEN, created: Date.now(), updated: Date.now(),
        size: d ? d.buf.byteLength : 0, mime: d ? d.type : "image/jpeg", ext: "jpg", text: "Picture Blarf drew: " + String(prompt || ""), hasBlob: !!d, meta: { src: "generated", prompt: String(prompt || "").slice(0, 500) } };
      if (!d) it.meta.url = src;
      return roomFor(it.size).then(function () {
        return (d ? DB.put("blobs", { id: it.id, buf: d.buf, type: d.type }) : Promise.resolve()).then(function () { return put(it); });
      }).then(function () {
        paint();
        /* thumbnail after the save, so a slow decode never loses the picture */
        thumbFrom(src, 360).then(function (t) { if (!t.thumb || !L.by[it.id]) return; it.thumb = t.thumb; if (t.w) it.meta.dim = t.w + "×" + t.h; DB.put("items", it).then(paint, function () {}); });
        return it;
      });
    }).catch(function (e) { toast(String(e)); return null; });
  }

  /* ---------- Knowledge Vault: chunk, embed, retrieve ---------- */
  function chunkText(t) {
    t = String(t || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    var out = [], i = 0;
    while (i < t.length && out.length < MAX_CHUNKS) {
      var end = Math.min(t.length, i + CHUNK);
      if (end < t.length) {
        var cut = Math.max(t.lastIndexOf("\n\n", end), t.lastIndexOf(". ", end), t.lastIndexOf("\n", end));
        if (cut > i + CHUNK * 0.5) end = cut + 1;
      }
      out.push(t.slice(i, end).trim());
      if (end >= t.length) break;
      i = Math.max(i + 1, end - OVERLAP);
    }
    return out.filter(Boolean);
  }
  function wantsIndex(it) { return it.type !== "folder" && !!(it.text && it.text.trim()) && (cfg().autoIndex || isPinned(it)); }
  function maybeIndex(it) { return wantsIndex(it) ? index(it) : Promise.resolve(); }
  function index(it) {
    var parts = chunkText((it.type === "image" ? "" : it.name + "\n") + (it.text || ""));
    var list = parts.map(function (p, i) { return { id: it.id + ":" + i, item: it.id, i: i, n: parts.length, text: p }; });
    L.chunks[it.id] = list; it.indexed = list.length;
    return DB.delChunks(it.id).then(function () { return DB.putMany("chunks", list); }).then(function () { return DB.put("items", it); }).then(function () { embedSoon(); });
  }
  var embBusy = false;
  function embedSoon() { clearTimeout(embedSoon.t); embedSoon.t = setTimeout(embedRun, 400); }
  function embedRun() {
    if (embBusy || !C || !C.embedOK()) return;
    var model = C.embModel(), need = [];
    Object.keys(L.chunks).forEach(function (id) {
      var it = L.by[id]; if (!it || !(isPinned(it) || cfg().autoIndex)) return;
      L.chunks[id].forEach(function (c) { if (c.m !== model && need.length < 48) need.push(c); });
    });
    if (!need.length) return;
    embBusy = true;
    C.embed(need.map(function (c) { return c.text; }), 20000).then(function (vs) {
      need.forEach(function (c, i) { if (vs[i]) { c.v = vs[i]; c.m = model; } });
      return DB.putMany("chunks", need.filter(function (c) { return c.v; }));
    }).then(function () { embBusy = false; if (need.length === 48) setTimeout(embedRun, 600); }, function () { embBusy = false; });
  }
  function isPinned(it) {
    var x = it;
    while (x) { if (x.pinned) return true; x = L.by[x.folder]; }
    return false;
  }
  function pinnedRoots() { return L.items.filter(function (x) { return x.pinned; }); }
  function setPin(it, on) {
    it.pinned = !!on; it.updated = Date.now(); L.ctx = null;
    var all = it.type === "folder" ? descendants(it.id).concat([it]) : [it];
    return DB.put("items", it).then(function () {
      return Promise.all(all.map(function (x) { return x.type !== "folder" && on && x.text && !L.chunks[x.id] ? index(x) : null; }));
    }).then(function () { embedSoon(); paintPins(); });
  }
  function toks(t) { return C ? C.toks(t) : String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; }); }
  function ctoks(c) { var t = L.tk.get(c.id); if (!t) { t = toks(c.text); L.tk.set(c.id, t); } return t; }
  function cos(a, b) { var d = 0, na = 0, nb = 0, n = Math.min(a.length, b.length); for (var i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; }
  /* score every candidate chunk for this message: BM25 + cosine when vectors exist */
  function rank(q, qv) {
    var cands = [];
    Object.keys(L.chunks).forEach(function (id) {
      var it = L.by[id]; if (!it) return;
      var pin = isPinned(it); if (!pin && !cfg().autoIndex) return;
      L.chunks[id].forEach(function (c) { cands.push({ c: c, it: it, pin: pin }); });
    });
    if (!cands.length) return [];
    var qt = toks(q), N = cands.length, df = {}, avg = 0, model = C ? C.embModel() : "";
    cands.forEach(function (x) { var t = ctoks(x.c), seen = {}; avg += t.length; t.forEach(function (w) { if (!seen[w]) { seen[w] = 1; df[w] = (df[w] || 0) + 1; } }); });
    avg = avg / N || 1;
    cands.forEach(function (x) {
      var t = ctoks(x.c), tf = {}, bm = 0;
      t.forEach(function (w) { tf[w] = (tf[w] || 0) + 1; });
      qt.forEach(function (w) { if (!tf[w]) return; var idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5)); bm += idf * (tf[w] * 2.2) / (tf[w] + 1.2 * (0.25 + 0.75 * t.length / avg)); });
      x.bm = bm; x.cos = qv && x.c.v && x.c.m === model ? cos(qv, x.c.v) : -1;
    });
    var maxBm = Math.max.apply(null, cands.map(function (x) { return x.bm; }).concat([0.0001]));
    cands.forEach(function (x) { var b = x.bm / maxBm; x.s = x.cos >= 0 ? 0.35 * b + 0.65 * Math.max(0, (x.cos - 0.15) / 0.55) : b; });
    return cands.sort(function (a, b) { return b.s - a.s; });
  }
  function prepare(text) {
    var q = clip(text, 600);
    if (!L.ready || (!pinnedRoots().length && !cfg().autoIndex)) { L.ctx = { q: q, picks: [] }; return Promise.resolve(); }
    var hasVec = Object.keys(L.chunks).some(function (id) { return L.chunks[id].some(function (c) { return c.v; }); });
    var qv = C ? C.qvec(text) : null;
    var get = !qv && hasVec && C && C.embedOK()
      ? Promise.race([C.embed([q], 5000).then(function (v) { return v[0]; }, function () { return null; }), new Promise(function (r) { setTimeout(function () { r(null); }, 1600); })])
      : Promise.resolve(qv);
    return get.then(function (v) {
      var all = rank(q, v || null), picks = [], used = 0, per = {};
      var take = function (x) {
        if (picks.indexOf(x) >= 0 || (per[x.it.id] || 0) >= 3) return;
        var len = Math.min(x.c.text.length, 900);
        if (used + len > CLAUSE_MAX) return;
        used += len; per[x.it.id] = (per[x.it.id] || 0) + 1; picks.push(x);
      };
      all.filter(function (x) { return x.pin && (x.bm > 0 || x.cos > 0.3); }).slice(0, 5).forEach(take);
      /* pinned but nothing matched the words ("summarize this"): lead with the start of each pinned doc */
      if (!picks.length) all.filter(function (x) { return x.pin && x.c.i === 0; }).slice(0, 3).forEach(take);
      all.filter(function (x) { return !x.pin && (x.cos >= 0.5 || (x.cos < 0 && x.bm >= 4 && x.s >= 0.6)); }).slice(0, 2).forEach(take);
      L.ctx = { q: q, picks: picks };
    });
  }
  function clause() {
    var pins = pinnedRoots(), picks = L.ctx ? L.ctx.picks : [];
    if (!pins.length && !picks.length) return "";
    var names = pins.slice(0, 8).map(function (p) {
      var pr = projectOf(p);
      return (p.type === "folder" ? "folder " : "") + "\"" + clip(p.name, 50) + "\"" + (pr ? " (project " + pr.p.name + ")" : "");
    }).join(", ");
    var s = " KNOWLEDGE VAULT: Kyle saved these in his Library" + (pins.length ? " and pinned them to this chat: " + names : "") + ".";
    if (picks.length) {
      s += " Relevant excerpts (use them when they help, say which file you're drawing from, don't invent beyond them): " + picks.map(function (x) {
        return "[" + clip(x.it.name, 50) + (x.c.n > 1 ? ", part " + (x.c.i + 1) + "/" + x.c.n : "") + (x.pin ? "" : ", from his Library") + "] " + clip(x.c.text, 900);
      }).join(" … ");
    } else if (pins.length) s += " Nothing in them matched this message; if he asks about them, say what you'd need.";
    return s;
  }

  /* ---------- UI ---------- */
  var view, els = {}, sheet, sheetBody, runSheet;
  var ICON_GRID = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
  var ICON_LIST = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>';
  function buildView() {
    view = doc.getElementById("view-library"); if (!view) return;
    view.innerHTML = '<div class="x-scroll" id="lib-scroll"><div class="x-lib">' +
      '<div class="x-lib__top"><h2 id="lib-title">Library</h2><div class="x-lib__acts">' +
      '<button class="x-lib__icon" id="lib-viewbtn" type="button"></button>' +
      '<button class="btn x-lib__selbtn" id="lib-selbtn" type="button">Select</button>' +
      '<button class="x-lib__icon x-lib__plus" id="lib-add" type="button" aria-label="Add to Library" aria-haspopup="dialog">＋</button></div></div>' +
      '<div class="x-lib__pick" id="lib-pickbar" hidden role="status"><span>📎 Pick what Blarf should use in chat</span><button class="btn" id="lib-pickdone" type="button">Done</button></div>' +
      '<div class="x-lib__searchrow"><label class="x-lib__qwrap"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>' +
      '<input class="x-lib__q" id="lib-q" type="search" placeholder="Search files, chats, images" autocomplete="off" aria-label="Search Library" /></label>' +
      '<select class="x-lib__sort" id="lib-sort" aria-label="Sort"><option value="recent">Recent</option><option value="name">Name</option><option value="size">Size</option><option value="type">Kind</option></select></div>' +
      '<div class="x-lib__filters" id="lib-filters" role="group" aria-label="Show">' +
      [["all", "All"], ["pinned", "📌 In chat"], ["chat", "💬 Chats"], ["file", "📄 Files"], ["image", "🖼️ Images"], ["build", "🕹️ Builds"]].map(function (f) { return '<button type="button" data-f="' + f[0] + '" aria-pressed="false">' + f[1] + "</button>"; }).join("") + "</div>" +
      '<nav class="x-lib__crumbs" id="lib-crumbs" aria-label="Folder"></nav>' +
      '<div class="x-lib__sugg" id="lib-sugg" hidden></div>' +
      '<div class="x-lib__items" id="lib-items" role="list" aria-live="polite"></div>' +
      '<div class="x-lib__storage" id="lib-storage"><div class="x-lib__bar" role="progressbar" aria-label="Storage used" aria-valuemin="0" aria-valuemax="100"><i id="lib-bar-i"></i></div><p id="lib-storage-t">Library</p></div>' +
      "</div></div>" +
      '<div class="x-lib__selbar" id="lib-selbar" hidden><span id="lib-selcount">0 selected</span>' +
      '<button type="button" data-sel="pin">📌 Use in chat</button><button type="button" data-sel="move">Move</button><button type="button" data-sel="share">Share</button><button type="button" data-sel="del" class="x-lib__seldel">Delete</button></div>' +
      '<input class="x-file" type="file" id="lib-file" multiple tabindex="-1" aria-hidden="true" />' +
      '<input class="x-file" type="file" id="lib-photo" accept="image/*" multiple tabindex="-1" aria-hidden="true" />';
    ["lib-viewbtn", "lib-selbtn", "lib-add", "lib-q", "lib-sort", "lib-filters", "lib-crumbs", "lib-sugg", "lib-items", "lib-storage-t", "lib-bar-i", "lib-selbar", "lib-selcount", "lib-file", "lib-photo", "lib-pickbar", "lib-title"].forEach(function (id) { els[id] = doc.getElementById(id); });
    els["lib-viewbtn"].addEventListener("click", function () { var c = cfg(); c.view = c.view === "grid" ? "list" : "grid"; C.save(); paint(); });
    els["lib-selbtn"].addEventListener("click", function () { L.sel = L.sel ? null : {}; L.armed = null; paint(); });
    els["lib-add"].addEventListener("click", function () { openAdd(); });
    els["lib-q"].addEventListener("input", function () { L.q = els["lib-q"].value; paintItems(); });
    els["lib-sort"].addEventListener("change", function () { cfg().sort = els["lib-sort"].value; C.save(); paintItems(); });
    els["lib-filters"].addEventListener("click", function (e) { var b = e.target.closest("[data-f]"); if (b) { L.filter = b.getAttribute("data-f"); paint(); } });
    els["lib-crumbs"].addEventListener("click", function (e) { var b = e.target.closest("[data-folder]"); if (b) { L.folder = b.getAttribute("data-folder"); paint(); } else if (e.target.closest("[data-folder-more]")) openDetail(L.by[L.folder]); });
    els["lib-sugg"].addEventListener("click", function (e) {
      var b = e.target.closest("[data-proj]"); if (!b) return;
      newFolder(b.getAttribute("data-proj")).then(function (f) { toast("📁 " + f.name + " folder, linked to the project"); paint(); }, toast);
    });
    els["lib-items"].addEventListener("click", onItemClick);
    var lp = null;
    els["lib-items"].addEventListener("pointerdown", function (e) {
      var card = e.target.closest(".x-li"); if (!card || L.sel) return;
      lp = setTimeout(function () { lp = null; L.sel = {}; L.sel[card.getAttribute("data-id")] = 1; L.suppress = true; paint(); if (navigator.vibrate) navigator.vibrate(10); }, 520);
    });
    ["pointerup", "pointercancel", "pointerleave", "scroll"].forEach(function (ev) { els["lib-items"].addEventListener(ev, function () { clearTimeout(lp); }, true); });
    els["lib-selbar"].addEventListener("click", onSelBar);
    els["lib-file"].addEventListener("change", function () { var fs = els["lib-file"].files; addFiles(fs, curFolder(), {}).then(function (d) { if (d.length) toast("Saved " + d.length + " to the Library"); }); els["lib-file"].value = ""; });
    els["lib-photo"].addEventListener("change", function () { var fs = els["lib-photo"].files; addFiles(fs, curFolder(), {}).then(function (d) { if (d.length) toast("Saved " + d.length + " photo" + (d.length === 1 ? "" : "s")); }); els["lib-photo"].value = ""; });
    doc.getElementById("lib-pickdone").addEventListener("click", finishPick);
  }
  function curFolder() { return L.filter === "all" && !L.q.trim() && L.by[L.folder] ? L.folder : ""; }
  function visible() {
    var q = L.q.trim().toLowerCase(), f = L.filter, list;
    if (q) list = L.items.filter(function (it) { return (it.name + " " + (it.text || "").slice(0, 60000)).toLowerCase().indexOf(q) >= 0; });
    else if (f === "pinned") list = L.items.filter(function (it) { return it.pinned; });
    else if (f !== "all") list = L.items.filter(function (it) { return it.type === f; });
    else list = children(L.folder);
    var s = cfg().sort, order = { folder: 0, build: 1, chat: 2, file: 3, image: 4 };
    return list.sort(function (a, b) {
      var fa = a.type === "folder" ? 0 : 1, fb = b.type === "folder" ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (a.type === "folder" && b.type === "folder" && (a.sys || b.sys) && s === "recent") return (b.sys ? 1 : 0) - (a.sys ? 1 : 0) || a.name.localeCompare(b.name);
      if (s === "name") return a.name.localeCompare(b.name);
      if (s === "size") return (b.type === "folder" ? descendants(b.id).length : b.size || 0) - (a.type === "folder" ? descendants(a.id).length : a.size || 0);
      if (s === "type") return (order[a.type] - order[b.type]) || (b.updated - a.updated);
      return (b.updated || 0) - (a.updated || 0);
    });
  }
  function thumbHTML(it) {
    if (it.type === "image") return it.thumb ? '<img src="' + esc(it.thumb) + '" alt="" loading="lazy" />' : '<img data-lazy="' + esc(it.id) + '" alt="" />';
    if (it.type === "folder") {
      var kids = children(it.id).filter(function (x) { return x.type === "image" && x.thumb; }).slice(0, 3);
      return '<span class="x-li__glyph x-li__glyph--folder" aria-hidden="true">' + (it.id === GEN ? "🎨" : it.id === BUILDS ? "🕹️" : "📁") + "</span>" +
        (kids.length ? '<span class="x-li__peek">' + kids.map(function (k) { return '<img src="' + esc(k.thumb) + '" alt="" />'; }).join("") + "</span>" : "");
    }
    var badge = it.type === "file" ? (it.ext || (it.mime || "").split("/")[1] || "file").slice(0, 4).toUpperCase() : it.type === "build" ? "HTML" : "CHAT";
    var glyph = it.type === "file" && /^audio\//.test(it.mime || "") ? "🎵" : it.type === "file" && /^video\//.test(it.mime || "") ? "🎬" : it.type === "file" && it.ext === "pdf" ? "📕" : TYPE_ICON[it.type];
    var snip = it.type === "chat" || it.type === "build" || (it.text && it.type === "file") ? '<span class="x-li__snip">' + esc(clip(it.text, 140)) + "</span>" : "";
    return snip + '<span class="x-li__glyph" aria-hidden="true">' + glyph + "</span>" + '<span class="x-li__badge">' + esc(badge) + "</span>";
  }
  function metaLine(it) {
    if (it.type === "folder") { var n = descendants(it.id).filter(function (x) { return x.type !== "folder"; }).length; return n + " item" + (n === 1 ? "" : "s") + (projectOf(it) ? " · 🔗 project" : ""); }
    var bits = [when(it.updated || it.created)];
    if (it.type === "chat" && it.meta && it.meta.msgs) bits.push(it.meta.msgs.length + " msgs");
    else if (it.meta && it.meta.pages) bits.push(it.meta.pages + " pages");
    else if (it.size) bits.push(bytes(it.size));
    if (L.q.trim() || L.filter !== "all") { var p = pathOf(it); if (p) bits.push(p); }
    return bits.join(" · ");
  }
  function paintItems() {
    var box = els["lib-items"]; if (!box) return;
    var list = visible(), grid = cfg().view === "grid";
    box.className = "x-lib__items " + (grid ? "is-grid" : "is-list") + (L.sel ? " is-selecting" : "");
    if (!list.length) {
      box.innerHTML = '<div class="x-lib__empty"><p class="x-lib__emptyico" aria-hidden="true">' + (L.q ? "🔎" : "📚") + "</p><p><b>" + (L.q ? "Nothing matches “" + esc(clip(L.q, 40)) + "”" : L.filter === "pinned" ? "Nothing pinned to chat yet" : "Empty in here") + "</b></p><p>" +
        (L.q ? "Try another word." : L.filter === "pinned" ? "Open an item and tap 📌 Use in chat, or use 📎 in the chat box." : "Tap ＋ to add files, photos or a chat. Blarf's pictures land in Generated by themselves.") + "</p></div>";
      return;
    }
    box.innerHTML = list.map(function (it) {
      var sel = L.sel && L.sel[it.id];
      return '<div class="x-li x-li--' + it.type + (sel ? " is-sel" : "") + '" role="listitem" data-id="' + esc(it.id) + '">' +
        '<button class="x-li__hit" type="button" aria-label="' + esc(TYPE_ICON[it.type] + " " + it.name + ", " + metaLine(it)) + '"' + (L.sel ? ' aria-pressed="' + (sel ? "true" : "false") + '"' : "") + ">" +
        '<span class="x-li__thumb">' + thumbHTML(it) + "</span>" +
        '<span class="x-li__txt"><span class="x-li__name">' + esc(it.name) + '</span><span class="x-li__meta">' + esc(metaLine(it)) + "</span></span></button>" +
        (it.pinned ? '<span class="x-li__pin" title="Used in chat" aria-label="Used in chat">📌</span>' : isPinned(it) ? '<span class="x-li__pin is-inherit" aria-hidden="true">📌</span>' : "") +
        (L.sel ? '<span class="x-li__check" aria-hidden="true">' + (sel ? "✓" : "") + "</span>" : "") + "</div>";
    }).join("");
    [].slice.call(box.querySelectorAll("img[data-lazy]")).forEach(function (im) {
      var it = L.by[im.getAttribute("data-lazy")]; if (it) urlOf(it).then(function (u) { if (u) im.src = u; });
    });
  }
  function paint() {
    if (!view || !L.ready) return;
    var c = cfg(), sm = L.sel ? Object.keys(L.sel).length : 0;
    els["lib-viewbtn"].innerHTML = c.view === "grid" ? ICON_LIST : ICON_GRID;
    els["lib-viewbtn"].setAttribute("aria-label", c.view === "grid" ? "Show as list" : "Show as grid");
    els["lib-selbtn"].textContent = L.sel ? "Cancel" : "Select";
    els["lib-selbtn"].hidden = !!L.picker;
    els["lib-add"].hidden = !!L.sel;
    els["lib-sort"].value = c.sort;
    els["lib-pickbar"].hidden = !L.picker;
    if (L.folder && !L.by[L.folder]) L.folder = "";
    [].slice.call(els["lib-filters"].querySelectorAll("[data-f]")).forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-f") === L.filter ? "true" : "false"); });
    /* breadcrumbs */
    var crumbs = [], f = L.by[L.folder];
    while (f) { crumbs.unshift(f); f = L.by[f.folder]; }
    var inFolder = L.filter === "all" && !L.q.trim() && crumbs.length;
    els["lib-crumbs"].hidden = !inFolder;
    if (inFolder) {
      var pr = projectOf(crumbs[crumbs.length - 1]);
      els["lib-crumbs"].innerHTML = '<button type="button" data-folder="">Library</button>' + crumbs.map(function (x, i) { return '<span aria-hidden="true">›</span>' + (i === crumbs.length - 1 ? '<b aria-current="page">' + esc(x.name) + "</b>" : '<button type="button" data-folder="' + esc(x.id) + '">' + esc(x.name) + "</button>"); }).join("") +
        (pr ? '<span class="x-lib__proj" title="' + esc(pr.p.direction || "") + '">🔗 ' + esc(pr.p.name) + "</span>" : "") + '<button type="button" class="x-lib__fmore" data-folder-more="1" aria-label="Folder options">⋯</button>';
    }
    els["lib-title"].textContent = L.picker ? "Pick for chat" : "Library";
    /* folders from memory projects that don't have one yet */
    var sugg = !L.folder && L.filter === "all" && !L.q.trim() && C ? C.memProjects().filter(function (p) {
      return p.p.state !== "done" && !L.items.some(function (x) { return x.type === "folder" && (x.project === p.id || C.memKey(x.name) === C.memKey(p.p.name)); });
    }).slice(0, 4) : [];
    els["lib-sugg"].hidden = !sugg.length;
    els["lib-sugg"].innerHTML = sugg.length ? '<span>From your projects:</span>' + sugg.map(function (p) { return '<button type="button" class="x-lib__chip" data-proj="' + esc(clip(p.p.name, 60)) + '">＋ ' + esc(clip(p.p.name, 28)) + "</button>"; }).join("") : "";
    paintItems();
    els["lib-selbar"].hidden = !L.sel || !!L.picker;
    els["lib-selcount"].textContent = sm + " selected";
    [].slice.call(els["lib-selbar"].querySelectorAll("button")).forEach(function (b) { b.disabled = !sm; });
    var del = els["lib-selbar"].querySelector('[data-sel="del"]'); del.textContent = L.armed === "seldel" ? "Delete " + sm + "?" : "Delete"; del.classList.toggle("is-armed", L.armed === "seldel");
    paintStorage();
    paintPins();
  }
  function paintStorage() {
    var lb = libBytes();
    var draw = function (e) {
      var t = "Library " + bytes(lb) + " · " + L.items.filter(function (x) { return x.type !== "folder"; }).length + " items";
      var pct = 0;
      if (e && e.quota) { pct = Math.min(100, (e.usage / e.quota) * 100); t += " · " + bytes(Math.max(0, e.quota - e.usage)) + " free for Blarf on this iPhone"; }
      els["lib-storage-t"].textContent = t;
      els["lib-bar-i"].style.width = Math.max(e && e.quota ? 1.5 : 0, pct).toFixed(1) + "%";
      els["lib-bar-i"].parentNode.setAttribute("aria-valuenow", Math.round(pct));
      els["lib-bar-i"].classList.toggle("is-high", pct > 85);
      var st = doc.getElementById("lset-storage"); if (st) st.textContent = bytes(lb) + (e && e.quota ? " of " + bytes(e.quota) + " available" : "");
    };
    draw(L.est); estimate().then(draw);
  }
  function onItemClick(e) {
    if (L.suppress) { L.suppress = false; return; }
    var card = e.target.closest(".x-li"); if (!card) return;
    var it = L.by[card.getAttribute("data-id")]; if (!it) return;
    if (L.sel) {
      if (it.type === "folder" && L.picker) { L.folder = it.id; paint(); return; }
      if (L.sel[it.id]) delete L.sel[it.id]; else L.sel[it.id] = 1;
      L.armed = null; paint(); return;
    }
    if (it.type === "folder") { L.folder = it.id; L.filter = "all"; L.q = ""; els["lib-q"].value = ""; paint(); var sc = doc.getElementById("lib-scroll"); if (sc) sc.scrollTop = 0; return; }
    openDetail(it);
  }
  function selected() { return Object.keys(L.sel || {}).map(function (id) { return L.by[id]; }).filter(Boolean); }
  function onSelBar(e) {
    var b = e.target.closest("[data-sel]"); if (!b || !L.sel) return;
    var act = b.getAttribute("data-sel"), list = selected(); if (!list.length) return;
    if (act !== "del") L.armed = null;
    if (act === "pin") {
      var on = !list.every(function (x) { return x.pinned; });
      Promise.all(list.map(function (x) { return setPin(x, on); })).then(function () { toast(on ? "📌 " + list.length + " in chat. Blarf will use them." : "Unpinned"); L.sel = null; paint(); });
    } else if (act === "move") openMove(list);
    else if (act === "share") shareItems(list);
    else if (act === "del") {
      if (L.armed !== "seldel") { L.armed = "seldel"; paint(); return; }
      L.armed = null;
      if (list.some(function (x) { return x.sys; })) { toast("Generated and Builds stay; their contents can go."); list = list.filter(function (x) { return !x.sys; }); }
      Promise.all(list.map(remove)).then(function (n) { toast("Deleted " + n.reduce(function (a, b) { return a + b; }, 0)); L.sel = null; paint(); });
    }
  }

  /* ---------- sheets ---------- */
  function buildSheets() {
    sheet = doc.createElement("div");
    sheet.className = "x-menu x-libsheet"; sheet.id = "lib-sheet"; sheet.hidden = true;
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-label", "Library item");
    sheet.innerHTML = '<button class="x-menu__scrim x-scrim" id="lib-sheet-scrim" type="button" aria-label="Close" tabindex="-1"></button>' +
      '<div class="x-menu__panel x-crew__panel x-libsheet__panel" id="lib-sheet-panel"><div class="x-grabber" aria-hidden="true"></div><div id="lib-sheet-body"></div></div>';
    doc.body.appendChild(sheet);
    sheetBody = doc.getElementById("lib-sheet-body");
    doc.getElementById("lib-sheet-scrim").addEventListener("click", function () { closeSheet(); });
    C.sheetDrag(doc.getElementById("lib-sheet-panel"), [doc.getElementById("lib-sheet-panel").querySelector(".x-grabber")], doc.getElementById("lib-sheet-scrim"), closeSheet);
    sheet.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } });
    runSheet = doc.createElement("div");
    runSheet.className = "x-menu x-librun"; runSheet.id = "lib-run"; runSheet.hidden = true;
    runSheet.setAttribute("role", "dialog"); runSheet.setAttribute("aria-modal", "true"); runSheet.setAttribute("aria-labelledby", "lib-run-t");
    runSheet.innerHTML = '<div class="x-librun__panel"><div class="x-librun__bar"><button class="btn" id="lib-run-x" type="button">Close</button><b id="lib-run-t">Build</b>' +
      '<span class="x-librun__btns"><button class="btn" id="lib-run-reload" type="button" aria-label="Restart">↻</button><button class="btn" id="lib-run-save" type="button">Save</button></span></div>' +
      '<iframe id="lib-run-frame" title="Build preview" sandbox="allow-scripts allow-modals allow-pointer-lock allow-forms" referrerpolicy="no-referrer"></iframe></div>';
    doc.body.appendChild(runSheet);
    doc.getElementById("lib-run-x").addEventListener("click", function () { C.layerSheet(runSheet, false, function () { doc.getElementById("lib-run-frame").srcdoc = ""; }); });
    doc.getElementById("lib-run-reload").addEventListener("click", function () { var fr = doc.getElementById("lib-run-frame"), s = fr.srcdoc; fr.srcdoc = ""; setTimeout(function () { fr.srcdoc = s; }, 30); });
    doc.getElementById("lib-run-save").addEventListener("click", function () {
      var r = runSheet._run; if (!r || r.saved) return;
      saveCode(r.src, r.lang).then(function (it) { r.saved = it.id; doc.getElementById("lib-run-save").hidden = true; toast("🕹️ Saved to Library › Builds"); }, toast);
    });
    runSheet.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); doc.getElementById("lib-run-x").click(); } });
  }
  function openSheet(html, label) {
    sheetBody.innerHTML = html; sheet.setAttribute("aria-label", label || "Library");
    C.layerSheet(sheet, true);
    setTimeout(function () { var f = sheetBody.querySelector("[autofocus], input:not([type=hidden])"); if (f) f.focus({ preventScroll: true }); }, 300);
  }
  function closeSheet() { L.armed = null; if (sheet && !sheet.hidden) C.layerSheet(sheet, false); }
  function sheetHead(emoji, title, sub, extra) {
    return '<div class="x-crew__head"><span class="x-crew__emoji" aria-hidden="true">' + emoji + '</span><div><h3>' + esc(title) + "</h3>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>" + (extra || "") + '<button class="btn" type="button" data-close="1">Done</button></div>';
  }
  function bindClose() { [].slice.call(sheetBody.querySelectorAll("[data-close]")).forEach(function (b) { b.addEventListener("click", closeSheet); }); }
  function openRun(src, lang, name, savedId) {
    runSheet._run = { src: src, lang: lang, saved: savedId || "" };
    doc.getElementById("lib-run-t").textContent = name || buildName(src, lang);
    doc.getElementById("lib-run-save").hidden = !!savedId;
    doc.getElementById("lib-run-frame").srcdoc = toHtml(src, lang);
    C.layerSheet(runSheet, true);
  }

  function openAdd() {
    var f = curFolder();
    openSheet(sheetHead("＋", "Add to Library", f ? "Into " + L.by[f].name : "") +
      '<div class="x-menu__list">' +
      '<button class="x-menu__item" type="button" data-a="files"><span aria-hidden="true">📄</span><span>Files<small class="x-libsheet__sub">PDF, text, markdown, audio, anything</small></span></button>' +
      '<button class="x-menu__item" type="button" data-a="photos"><span aria-hidden="true">🖼️</span><span>Photos</span></button>' +
      '<button class="x-menu__item" type="button" data-a="folder"><span aria-hidden="true">📁</span><span>New folder</span></button>' +
      C.ORDER.map(function (m) { var n = (S().threads[m] || []).filter(function (x) { return x && (x.r === "me" || x.r === "bot") && !x.greet; }).length; return n ? '<button class="x-menu__item" type="button" data-a="chat" data-m="' + m + '"><span aria-hidden="true">💬</span><span>Save ' + esc(m === "chat" ? "Blarf" : C.MODES[m].label) + " chat<small class=\"x-libsheet__sub\">" + n + " messages</small></span></button>" : ""; }).join("") +
      "</div>", "Add to Library");
    bindClose();
    sheetBody.querySelector(".x-menu__list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-a]"); if (!b) return;
      var a = b.getAttribute("data-a");
      if (a === "files") { closeSheet(); els["lib-file"].click(); }
      else if (a === "photos") { closeSheet(); els["lib-photo"].click(); }
      else if (a === "folder") openNameForm("New folder", "", function (name) { return newFolder(name, curFolder()).then(function (fo) { toast("📁 " + fo.name + (fo.project ? " · linked to your project" : "")); }); });
      else if (a === "chat") {
        var m = b.getAttribute("data-m"), msgs = (S().threads[m] || []).filter(function (x) { return x && (x.r === "me" || x.r === "bot") && !x.greet; });
        saveChat(msgs, null, curFolder()).then(function (it) { closeSheet(); toast("💬 Saved “" + it.name + "”"); }, toast);
      }
    });
  }
  function openNameForm(title, val, fn) {
    openSheet(sheetHead("✏️", title) + '<form class="x-group x-libform" id="lib-nameform"><div class="x-row"><label for="lib-name">Name</label><input class="x-field" id="lib-name" maxlength="60" value="' + esc(val) + '" autocomplete="off" /></div>' +
      '<div class="x-libform__save"><button class="btn" type="submit">Save</button></div></form>' + (title === "New folder" ? '<p class="x-gnote">Name it like one of your projects and Blarf links it to what he remembers about that project.</p>' : ""), title);
    bindClose();
    doc.getElementById("lib-nameform").addEventListener("submit", function (e) {
      e.preventDefault();
      var v = doc.getElementById("lib-name").value.trim(); if (!v) return;
      Promise.resolve(fn(v)).then(function () { closeSheet(); paint(); }, toast);
    });
  }
  function openMove(list) {
    var bad = {}; list.forEach(function (x) { bad[x.id] = 1; if (x.type === "folder") descendants(x.id).forEach(function (d) { bad[d.id] = 1; }); });
    var folders = L.items.filter(function (x) { return x.type === "folder" && !bad[x.id]; }).sort(function (a, b) { return pathOf(a).localeCompare(pathOf(b)) || a.name.localeCompare(b.name); });
    openSheet(sheetHead("📁", "Move " + (list.length === 1 ? "“" + clip(list[0].name, 30) + "”" : list.length + " items")) +
      '<div class="x-menu__list" id="lib-movelist"><button class="x-menu__item" type="button" data-to=""><span aria-hidden="true">📚</span><span>Library (top level)</span></button>' +
      folders.map(function (f) { var p = pathOf(f); return '<button class="x-menu__item" type="button" data-to="' + esc(f.id) + '"><span aria-hidden="true">📁</span><span>' + esc(f.name) + (p ? '<small class="x-libsheet__sub">' + esc(p) + "</small>" : "") + "</span></button>"; }).join("") +
      '<button class="x-menu__item" type="button" data-to="__new"><span aria-hidden="true">＋</span><span>New folder…</span></button></div>', "Move");
    bindClose();
    doc.getElementById("lib-movelist").addEventListener("click", function (e) {
      var b = e.target.closest("[data-to]"); if (!b) return;
      var to = b.getAttribute("data-to");
      var go = function (fid) { list.forEach(function (x) { x.folder = fid; x.updated = Date.now(); }); return DB.putMany("items", list).then(function () { L.ctx = null; closeSheet(); L.sel = null; toast("Moved"); paint(); }); };
      if (to === "__new") openNameForm("New folder", "", function (name) { return newFolder(name, "").then(function (f) { return go(f.id); }); });
      else go(to);
    });
  }
  function fileFor(it) {
    if (it.type === "chat") return Promise.resolve(new File(["# " + it.name + "\n\n" + (it.meta && it.meta.msgs ? it.meta.msgs.map(function (x) { return "**" + (x.r === "me" ? "Kyle" : "Blarf") + "**" + (x.ts ? " · " + new Date(x.ts).toLocaleString() : "") + "\n\n" + x.t; }).join("\n\n") : it.text || "")], safeName(it.name) + ".md", { type: "text/markdown" }));
    if (it.type === "build") return Promise.resolve(new File([toHtml(it.text || "", it.meta && it.meta.lang)], safeName(it.name) + ".html", { type: "text/html" }));
    if (!it.hasBlob) return Promise.resolve(it.text ? new File([it.text], safeName(it.name) + "." + (it.ext || "txt"), { type: "text/plain" }) : null);
    return blobOf(it.id).then(function (b) { return b ? new File([b], /\.[a-z0-9]+$/i.test(it.name) ? it.name : safeName(it.name) + "." + (it.ext || (it.type === "image" ? "jpg" : "bin")), { type: b.type }) : null; });
  }
  function safeName(n) { return String(n || "blarf").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60) || "blarf"; }
  function shareItems(list) {
    var files = [];
    list.forEach(function (x) { if (x.type === "folder") descendants(x.id).forEach(function (d) { if (d.type !== "folder") files.push(d); }); else files.push(x); });
    return Promise.all(files.slice(0, 30).map(fileFor)).then(function (fs) {
      fs = fs.filter(Boolean); if (!fs.length) { toast("Nothing to share there."); return; }
      if (navigator.canShare && navigator.share && navigator.canShare({ files: fs })) return navigator.share({ files: fs }).catch(function () {});
      fs.forEach(function (f, i) {
        setTimeout(function () { var a = doc.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; doc.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); }, i * 350);
      });
      toast(fs.length === 1 ? "Downloading " + fs[0].name : "Downloading " + fs.length + " files");
    });
  }

  function openDetail(it) {
    if (!it) return;
    var pinBtn = '<button class="btn x-libpinbtn" type="button" data-d="pin" aria-pressed="' + (it.pinned ? "true" : "false") + '">' + (it.pinned ? "📌 In chat · Unpin" : isPinned(it) ? "📌 In chat (via folder)" : "📌 Use in chat") + "</button>";
    var body = "", sub = "";
    if (it.type === "folder") {
      var pr = projectOf(it), n = descendants(it.id).filter(function (x) { return x.type !== "folder"; }).length;
      sub = n + " item" + (n === 1 ? "" : "s");
      body = pr ? '<div class="x-libproj"><b>🔗 Linked to project “' + esc(pr.p.name) + "”</b>" + (pr.p.direction ? "<p>" + esc(pr.p.direction) + "</p>" : "") + (pr.p.open && pr.p.open.length ? "<p>Still open: " + esc(pr.p.open.slice(0, 3).join(", ")) + "</p>" : "") + "</div>" : '<p class="x-gnote" style="padding:0 4px">Not linked to a project Blarf remembers. Name it like one and it links.</p>';
    } else if (it.type === "image") {
      sub = [it.meta && it.meta.dim, it.size ? bytes(it.size) : "", when(it.created)].filter(Boolean).join(" · ");
      body = '<div class="x-libprev x-libprev--img"><img id="lib-prev-img" alt="' + esc(it.name) + '" /></div>' + (it.meta && it.meta.prompt ? '<p class="x-libnote">🎨 “' + esc(clip(it.meta.prompt, 300)) + "”</p>" : "");
    } else if (it.type === "chat") {
      sub = (it.meta && it.meta.msgs ? it.meta.msgs.length + " messages · " : "") + when(it.created);
      body = '<div class="x-libchat">' + (it.meta && it.meta.msgs || []).slice(0, 80).map(function (x) { return '<p class="x-libchat__m' + (x.r === "me" ? " is-me" : "") + '">' + esc(clip(x.t, 1200)) + "</p>"; }).join("") + "</div>";
    } else if (it.type === "build") {
      sub = (it.meta && it.meta.lang ? it.meta.lang.toUpperCase() + " · " : "") + bytes(it.size) + " · " + when(it.created);
      body = '<button class="x-cta x-librunbtn" type="button" data-d="run">▶ Run it</button><pre class="x-libcode">' + esc((it.text || "").slice(0, 6000)) + "</pre>";
    } else {
      var pdf = it.meta && it.meta.pdf;
      sub = [(it.ext || "").toUpperCase(), it.meta && it.meta.pages ? it.meta.pages + " pages" : "", bytes(it.size), when(it.created)].filter(Boolean).join(" · ");
      var media = /^audio\//.test(it.mime || "") ? '<audio id="lib-prev-media" controls preload="metadata"></audio>' : /^video\//.test(it.mime || "") ? '<video id="lib-prev-media" controls playsinline preload="metadata"></video>' : "";
      var status = pdf === "reading" ? "Reading the PDF…" : pdf === "failed" ? "Couldn't read this PDF's text (needs the internet the first time)." : pdf === "notext" ? "No selectable text in this PDF (scanned?)." : it.text ? (it.indexed ? "Indexed for chat · " + it.indexed + " part" + (it.indexed === 1 ? "" : "s") : "Text ready · indexes when you pin it") : "No text Blarf can read in this one.";
      body = media + '<p class="x-libnote">' + esc(status) + "</p>" + (it.text ? '<pre class="x-libtext">' + esc(it.text.slice(0, 2400)) + (it.text.length > 2400 ? "\n…" : "") + "</pre>" : "");
    }
    var acts = '<div class="x-libacts">' + pinBtn +
      (it.type === "image" ? '<button class="btn" type="button" data-d="ask">👁️ Ask Blarf about it</button>' : "") +
      (it.type === "file" && it.hasBlob ? '<button class="btn" type="button" data-d="open">Open</button>' : "") +
      (it.type === "build" ? '<button class="btn" type="button" data-d="copy">Copy code</button>' : "") +
      '<button class="btn" type="button" data-d="share">' + (it.type === "folder" ? "Share all" : "Share / Export") + "</button>" +
      (!it.sys ? '<button class="btn" type="button" data-d="move">Move</button><button class="btn" type="button" data-d="rename">Rename</button>' : "") +
      (!it.sys ? '<button class="btn x-libdel" type="button" data-d="del">Delete</button>' : "") + "</div>";
    openSheet(sheetHead(TYPE_ICON[it.type], it.name, sub) + body + acts, it.name);
    bindClose();
    if (it.type === "image") urlOf(it).then(function (u) { var im = doc.getElementById("lib-prev-img"); if (im && u) im.src = u; });
    var med = doc.getElementById("lib-prev-media"); if (med) urlOf(it).then(function (u) { if (u) med.src = u; });
    sheetBody.querySelector(".x-libacts").addEventListener("click", function (e) {
      var b = e.target.closest("[data-d]"); if (!b) return;
      var d = b.getAttribute("data-d");
      if (d !== "del") L.armed = null;
      if (d === "pin") setPin(it, !it.pinned).then(function () { toast(it.pinned ? "📌 Blarf will use “" + clip(it.name, 30) + "” in chat" : "Unpinned"); openDetail(it); paint(); });
      else if (d === "share") shareItems([it]);
      else if (d === "move") openMove([it]);
      else if (d === "rename") openNameForm("Rename", it.name, function (v) { it.name = clip(v, 80); it.updated = Date.now(); if (it.type === "folder") linkProject(it); return DB.put("items", it); });
      else if (d === "copy") C.copyText(it.text || "");
      else if (d === "open") urlOf(it).then(function (u) { if (u) window.open(u, "_blank", "noopener"); });
      else if (d === "ask") askAbout(it);
      else if (d === "del") {
        if (L.armed !== "d" + it.id) { L.armed = "d" + it.id; b.textContent = it.type === "folder" ? "Delete folder + " + descendants(it.id).length + "?" : "Tap again to delete"; b.classList.add("is-armed"); return; }
        L.armed = null; remove(it).then(function () { closeSheet(); toast("Deleted"); paint(); });
      }
    });
    var rb = sheetBody.querySelector('[data-d="run"]'); if (rb) rb.addEventListener("click", function () { closeSheet(); openRun(it.text || "", it.meta && it.meta.lang, it.name, it.id); });
  }
  /* photo from the Library into the chat box for the vision brain */
  function askAbout(it) {
    var m = L.lastM || "chat";
    var go = function (src) {
      closeSheet();
      if (m === "chat") { C.go("chat"); C.setSheet(true); } else C.go(m);
      if (C.V[m] && C.V[m].setPend) C.V[m].setPend(src);
      setTimeout(function () { if (C.V[m]) C.V[m].input.focus(); }, 380);
    };
    if (it.meta && it.meta.url && !it.hasBlob) return go(it.meta.url);
    blobOf(it.id).then(function (b) {
      if (!b) return toast("Couldn't load that picture.");
      var u = URL.createObjectURL(b), im = new Image();
      im.onload = function () {
        var k = Math.min(1, 1280 / Math.max(im.naturalWidth, im.naturalHeight || 1)), cv = doc.createElement("canvas");
        cv.width = Math.round(im.naturalWidth * k) || 1; cv.height = Math.round(im.naturalHeight * k) || 1;
        var cx = cv.getContext("2d"); URL.revokeObjectURL(u);
        if (!cx) return toast("Couldn't load that picture.");
        cx.fillStyle = "#fff"; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(im, 0, 0, cv.width, cv.height);
        go(cv.toDataURL("image/jpeg", 0.8));
      };
      im.onerror = function () { URL.revokeObjectURL(u); toast("Couldn't load that picture."); };
      im.src = u;
    });
  }

  /* ---------- composer: 📎 attach + pinned chips ---------- */
  function wireComposers() {
    C.ORDER.forEach(function (m) {
      var v = C.V[m]; if (!v || !v.sec) return;
      var clipBtn = v.sec.querySelector(".x-clip");
      if (clipBtn) clipBtn.addEventListener("click", function () { L.lastM = m; openAttach(m); });
      var row = doc.createElement("div");
      row.className = "x-pend x-libpins"; row.id = "libpins-" + m; row.hidden = true;
      row.innerHTML = '<button class="x-libpins__chip" type="button"><span aria-hidden="true">📚</span><span class="x-libpins__t"></span></button><button class="x-pend__x" type="button" aria-label="Stop using Library items in chat">×</button>';
      v.form.parentNode.insertBefore(row, v.form);
      row.querySelector(".x-libpins__chip").addEventListener("click", function () { L.lastM = m; openAttach(m); });
      row.querySelector(".x-pend__x").addEventListener("click", function () {
        Promise.all(pinnedRoots().map(function (x) { return setPin(x, false); })).then(function () { toast("Library items unpinned from chat"); paint(); });
      });
      var dev = doc.createElement("input");
      dev.type = "file"; dev.multiple = true; dev.className = "x-file"; dev.tabIndex = -1; dev.setAttribute("aria-hidden", "true"); dev.id = "libdev-" + m;
      v.sec.appendChild(dev);
      dev.addEventListener("change", function () {
        var fs = [].slice.call(dev.files || []); dev.value = "";
        if (!fs.length) return;
        ensureFolder(ATTACH, "Attachments").then(function () { return addFiles(fs, ATTACH, { pin: true, src: "attach" }); }).then(function (d) {
          return Promise.all(d.map(function (x) { return setPin(x, true); })).then(function () {
            var img = d.filter(function (x) { return x.type === "image"; })[0];
            if (img && d.length === 1) { L.lastM = m; askAbout(img); }
            if (d.length) toast("📎 " + (d.length === 1 ? "“" + clip(d[0].name, 30) + "”" : d.length + " files") + " saved and in chat");
          });
        });
      });
    });
  }
  function paintPins() {
    if (!C) return;
    var pins = pinnedRoots();
    C.ORDER.forEach(function (m) {
      var row = doc.getElementById("libpins-" + m); if (!row) return;
      row.hidden = !pins.length;
      row.querySelector(".x-libpins__t").textContent = pins.length ? (pins.length === 1 ? clip(pins[0].name, 28) : pins.length + " in chat: " + pins.slice(0, 2).map(function (p) { return clip(p.name, 14); }).join(", ") + (pins.length > 2 ? "…" : "")) : "";
    });
  }
  function openAttach(m) {
    var pins = pinnedRoots();
    openSheet(sheetHead("📎", "Use in chat", "Blarf reads what you pin") +
      '<div class="x-menu__list" id="lib-attach">' +
      '<button class="x-menu__item" type="button" data-at="lib"><span aria-hidden="true">📚</span><span>From Library</span></button>' +
      '<button class="x-menu__item" type="button" data-at="dev"><span aria-hidden="true">📄</span><span>From this iPhone<small class="x-libsheet__sub">Saves to Library › Attachments</small></span></button>' +
      '<button class="x-menu__item" type="button" data-at="cam"><span aria-hidden="true">📷</span><span>Photo for Blarf to look at</span></button></div>' +
      (pins.length ? '<p class="x-glabel" style="margin-top:14px">In chat now</p><div class="x-menu__list" id="lib-pinned">' + pins.map(function (p) {
        return '<div class="x-menu__item x-libpinrow"><span aria-hidden="true">' + TYPE_ICON[p.type] + '</span><span class="x-libpinrow__n">' + esc(p.name) + '</span><button class="x-pend__x" type="button" data-unpin="' + esc(p.id) + '" aria-label="Unpin ' + esc(p.name) + '">×</button></div>';
      }).join("") + "</div>" : '<p class="x-gnote">Pinned files, chats and folders ride along with every message: Blarf pulls the parts that matter.</p>'), "Use in chat");
    bindClose();
    doc.getElementById("lib-attach").addEventListener("click", function (e) {
      var b = e.target.closest("[data-at]"); if (!b) return;
      var a = b.getAttribute("data-at");
      closeSheet();
      if (a === "lib") startPick(m);
      else if (a === "dev") doc.getElementById("libdev-" + m).click();
      else if (a === "cam" && C.V[m]) { C.V[m].file.value = ""; C.V[m].file.click(); }
    });
    var pl = doc.getElementById("lib-pinned");
    if (pl) pl.addEventListener("click", function (e) { var b = e.target.closest("[data-unpin]"); if (!b) return; var it = L.by[b.getAttribute("data-unpin")]; if (it) setPin(it, false).then(function () { openAttach(m); paint(); }); });
  }
  function startPick(m) {
    L.picker = m; L.sel = {}; pinnedRoots().forEach(function (p) { L.sel[p.id] = 1; });
    C.go("library");
  }
  function finishPick() {
    var m = L.picker, want = L.sel || {};
    L.picker = null;
    var changes = L.items.filter(function (x) { return !!want[x.id] !== !!x.pinned && (want[x.id] || x.pinned); });
    L.sel = null;
    Promise.all(changes.map(function (x) { return setPin(x, !!want[x.id]); })).then(function () {
      var n = pinnedRoots().length;
      toast(n ? "📌 " + n + " in chat. Ask away." : "Nothing pinned");
      paint();
      if (m === "chat") { C.go("chat"); C.setSheet(true); } else C.go(m || "chat");
      setTimeout(function () { if (C.V[m || "chat"]) C.V[m || "chat"].input.focus(); }, 380);
    });
  }

  /* ---------- chat bubbles: Save one, or Select several ---------- */
  function bubMsg(msgEl) {
    var bub = msgEl.querySelector(".x-bub"); if (!bub) return null;
    var cl = bub.cloneNode(true);
    [].slice.call(cl.querySelectorAll(".x-code__bar, img")).forEach(function (x) { x.remove(); });
    var t = cl.textContent.trim(); if (!t) return null;
    var tm = msgEl.querySelector(".x-time");
    return { r: msgEl.classList.contains("x-msg--me") ? "me" : "bot", t: t, ts: Date.now(), at: tm ? tm.childNodes[0] && tm.childNodes[0].textContent : "" };
  }
  function threadOf(el) { var th = el.closest(".x-thread"); return th ? th.id.replace("thread-", "") : "chat"; }
  function wireBubbles() {
    var sv = doc.getElementById("pill-save"), se = doc.getElementById("pill-select");
    if (sv) sv.addEventListener("click", function () {
      var p = C.pill(); C.hidePill(); if (!p || !p.bub) return;
      var msg = bubMsg(p.bub.closest(".x-msg")); if (!msg) return;
      saveChat([msg], null, "").then(function (it) { toast("Saved to Library: “" + it.name + "”"); }, toast);
    });
    if (se) se.addEventListener("click", function () {
      var p = C.pill(); C.hidePill(); if (!p || !p.bub) return;
      startThreadSelect(threadOf(p.bub), p.bub.closest(".x-msg"));
    });
  }
  function startThreadSelect(m, first) {
    stopThreadSelect();
    var v = C.V[m]; if (!v) return;
    L.threadSel = { m: m, set: new Set() };
    v.thread.classList.add("is-selecting");
    var bar = doc.createElement("div");
    bar.className = "x-libtsel"; bar.id = "libtsel";
    bar.innerHTML = '<button class="btn" type="button" data-ts="cancel">Cancel</button><span id="libtsel-n">0 selected</span><button class="btn" type="button" data-ts="all">All</button><button class="btn x-libtsel__save" type="button" data-ts="save" disabled>Save to Library</button>';
    v.form.parentNode.insertBefore(bar, v.form);
    v.form.hidden = true;
    var toggle = function (el) {
      if (!el || el.classList.contains("x-typing")) return;
      if (L.threadSel.set.has(el)) { L.threadSel.set.delete(el); el.classList.remove("is-picked"); } else { L.threadSel.set.add(el); el.classList.add("is-picked"); }
      var n = L.threadSel.set.size; doc.getElementById("libtsel-n").textContent = n + " selected"; bar.querySelector('[data-ts="save"]').disabled = !n;
    };
    L.threadSel.onClick = function (e) { var el = e.target.closest(".x-msg"); if (!el) return; e.preventDefault(); e.stopPropagation(); toggle(el); };
    v.thread.addEventListener("click", L.threadSel.onClick, true);
    if (first) toggle(first);
    bar.addEventListener("click", function (e) {
      var b = e.target.closest("[data-ts]"); if (!b) return;
      var a = b.getAttribute("data-ts");
      if (a === "cancel") stopThreadSelect();
      else if (a === "all") [].slice.call(v.thread.querySelectorAll(".x-msg:not(.x-typing)")).forEach(function (el) { if (!L.threadSel.set.has(el)) toggle(el); });
      else if (a === "save") {
        var els2 = [].slice.call(v.thread.querySelectorAll(".x-msg")).filter(function (el) { return L.threadSel.set.has(el); });
        var msgs = els2.map(bubMsg).filter(Boolean);
        saveChat(msgs, null, "").then(function (it) { toast("💬 Saved " + msgs.length + " message" + (msgs.length === 1 ? "" : "s") + " as “" + it.name + "”"); stopThreadSelect(); }, toast);
      }
    });
  }
  function stopThreadSelect() {
    var ts = L.threadSel; if (!ts) return;
    var v = C.V[ts.m];
    v.thread.classList.remove("is-selecting");
    v.thread.removeEventListener("click", ts.onClick, true);
    ts.set.forEach(function (el) { el.classList.remove("is-picked"); });
    var bar = doc.getElementById("libtsel"); if (bar) bar.remove();
    v.form.hidden = false;
    L.threadSel = null;
  }

  /* ---------- code cards: Save / Run ---------- */
  function wireCode() {
    doc.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".x-lsave, .x-lrun"); if (!b) return;
      var card = b.closest(".x-code"), pre = card && card.querySelector("pre"); if (!pre) return;
      var src = pre.textContent, lang = card.getAttribute("data-lang") || "";
      if (b.classList.contains("x-lrun")) { openRun(src, lang, null, card._saved || ""); return; }
      if (card._saved) { toast("Already in Library › Builds"); return; }
      saveCode(src, lang).then(function (it) { card._saved = it.id; b.textContent = "Saved ✓"; toast(it.type === "build" ? "🕹️ Saved to Library › Builds. Tap ▶ Run any time." : "Saved to Library › Builds"); }, toast);
    });
  }

  /* ---------- Settings › Library ---------- */
  function buildSettings() {
    var box = doc.getElementById("p2a-settings");
    if (!box) {
      box = doc.createElement("div"); box.id = "p2a-settings"; box.className = "x-p2aset";
      var set = doc.querySelector("#view-settings .x-settings"); if (!set) return;
      var anchor = [].slice.call(set.querySelectorAll(".x-glabel")).filter(function (l) { return l.textContent.trim() === "Blarf"; })[0];
      if (anchor && anchor.parentNode.parentNode === set) set.insertBefore(box, anchor.parentNode); else set.appendChild(box);
    }
    var d = doc.createElement("div"); d.id = "lib-settings";
    d.innerHTML = '<p class="x-glabel">Library</p><div class="x-group">' +
      '<div class="x-row"><span class="x-twoline">📚 Storage<small id="lset-storage">…</small></span><button class="btn" id="lset-open" type="button">Open</button></div>' +
      '<div class="x-row"><span class="x-twoline" id="lset-img-l">Auto-save generated images<small>Every picture Blarf draws goes to Generated</small></span><button class="x-switch" id="lset-img" type="button" role="switch" aria-checked="true" aria-labelledby="lset-img-l"></button></div>' +
      '<div class="x-row"><span class="x-twoline" id="lset-idx-l">Auto-index files for chat<small>Blarf can pull from any saved file when it really matches</small></span><button class="x-switch" id="lset-idx" type="button" role="switch" aria-checked="true" aria-labelledby="lset-idx-l"></button></div>' +
      "</div>" + '<p class="x-gnote">Stays on this iPhone. Pinned items (📌) always ride along; with auto-index on, other files join in only when they strongly match. Embeddings use your OpenAI key when you have one.</p>';
    box.insertBefore(d, box.firstChild);
    doc.getElementById("lset-open").addEventListener("click", function () { C.go("library"); });
    doc.getElementById("lset-img").addEventListener("click", function () { var c = cfg(); c.autoImg = !c.autoImg; C.save(); paintSettings(); });
    doc.getElementById("lset-idx").addEventListener("click", function () {
      var c = cfg(); c.autoIndex = !c.autoIndex; C.save(); paintSettings(); L.ctx = null;
      if (c.autoIndex) L.items.forEach(function (x) { if (x.type !== "folder" && x.text && !L.chunks[x.id]) index(x).catch(function () {}); });
    });
    paintSettings();
  }
  function paintSettings() {
    var c = cfg(), a = doc.getElementById("lset-img"), b = doc.getElementById("lset-idx");
    if (a) a.setAttribute("aria-checked", c.autoImg ? "true" : "false");
    if (b) b.setAttribute("aria-checked", c.autoIndex ? "true" : "false");
  }

  /* ---------- boot ---------- */
  function load() {
    return Promise.all([DB.all("items"), DB.all("chunks")]).then(function (r) {
      L.items = r[0]; L.by = {}; L.items.forEach(function (x) { L.by[x.id] = x; });
      L.chunks = {};
      r[1].forEach(function (c) { (L.chunks[c.item] = L.chunks[c.item] || []).push(c); });
      Object.keys(L.chunks).forEach(function (k) { if (!L.by[k]) delete L.chunks[k]; else L.chunks[k].sort(function (a, b) { return a.i - b.i; }); });
      return Promise.all([ensureFolder(GEN, "Generated", true), ensureFolder(BUILDS, "Builds", true)]);
    }).then(function () {
      L.items.forEach(function (x) { if (x.type === "folder" && !x.sys) linkProject(x); });
      L.ready = true; paint(); paintPins(); embedSoon();
    }, function (e) { L.ready = true; L.err = String(e); paint(); });
  }
  function init() {
    if (C) return;
    C = window.blarfCore; if (!C) return;
    cfg();
    buildView(); buildSheets(); buildSettings(); wireComposers(); wireBubbles(); wireCode();
    doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && L.threadSel) stopThreadSelect(); });
    load();
  }

  var api = window.blarfLib = {
    paint: function () { if (L.ready) paint(); },
    prepare: prepare, clause: clause, onGenerated: onGenerated, runnable: runnable,
    addFiles: function (fs, folder, o) { return addFiles(fs, folder, o); }, saveChat: saveChat, saveCode: saveCode,
    pin: function (id, on) { var it = L.by[id]; return it ? setPin(it, on !== false) : Promise.reject("not found"); },
    ready: function () { return new Promise(function (r) { (function w() { if (L.ready) r(); else setTimeout(w, 30); })(); }); },
    _t: { L: L, chunkText: chunkText, rank: rank, toHtml: toHtml, newFolder: newFolder, remove: remove, openRun: openRun, openDetail: openDetail, startThreadSelect: startThreadSelect, finishPick: finishPick, startPick: startPick, index: index, pdfLoader: null, reload: load, linkProject: linkProject }
  };
  if (window.blarfCore) init(); else window.addEventListener("blarf-core", init);
})();

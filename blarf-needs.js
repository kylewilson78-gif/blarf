/* Blarf OS P2b: needs (tamagotchi). Hunger, Energy, Mood, Hygiene, Social and Caffeine, 0-100, decaying in real time from
   timestamps (so they keep ticking while the app is closed; the catch-up is capped and never drops a need below a floor).
   No death and no permanent loss: at 0 he just gets dramatic, sulky and sleepy. Care actions animate the SVG face through
   window.blarfAct + props drawn here; the state line rides in blarfCharacter() via clause(), at most one mention per ~10 messages.
   Everything lives in S.needs on this device. */
(function () {
  "use strict";
  var doc = document, C = null;
  var NEEDS = [
    { k: "hunger", label: "Hunger", emoji: "🍩", color: "#FF9F0A", rate: 6, start: 80 },
    { k: "energy", label: "Energy", emoji: "⚡", color: "#FFD60A", rate: 4, start: 85 },
    { k: "mood", label: "Mood", emoji: "😊", color: "#FF375F", rate: 3, start: 75 },
    { k: "hygiene", label: "Hygiene", emoji: "🫧", color: "#64D2FF", rate: 2.5, start: 85 },
    { k: "social", label: "Social", emoji: "💬", color: "#30D158", rate: 5, start: 70 },
    { k: "caffeine", label: "Caffeine", emoji: "☕", color: "#E11383", rate: 8, start: 65 }
  ];
  var BY = {}; NEEDS.forEach(function (d) { BY[d.k] = d; });
  var SPEED = { chill: 0.5, normal: 1, hardcore: 2 };
  var SPEED_LBL = { chill: "Chill", normal: "Normal", hardcore: "Hardcore" };
  var CAP_H = 10, FLOOR = 8, OFFLINE_MS = 5 * 60000, NAP_RATE = 45, LOW = 35, CRIT = 15, REMIND = 20, MENTION_EVERY = 10;
  var REWARDS = [{ care: 7, id: "dunkin", name: "Dunkin' cap", emoji: "🧢" }, { care: 14, id: "bruins", name: "Bruins jersey", emoji: "🏒" }];
  /* each food: stat changes, the act it plays, and his reaction */
  var FOODS = [
    { id: "coffee", name: "Dunkin' coffee", short: "Coffee", d: { caffeine: 60, energy: 15, mood: 8, hunger: 3 }, act: "sip",
      line: "Ohhh yeah. A large regulah. Now I'm a person again.", dirty: "Ohhh hell yeah. A large regulah. Now I'm a goddamn person again." },
    { id: "donut", name: "Boston cream donut", short: "Boston cream", d: { hunger: 25, mood: 12, energy: 5, hygiene: -3 }, act: "eat",
      line: "Boston cream. You DO love me. Don't make it weird.", dirty: "Boston cream. Damn, you DO love me. Don't make it weird." },
    { id: "cannoli", name: "Cannoli", short: "Cannoli", d: { hunger: 20, mood: 15 }, act: "eat",
      line: "Mike's or Modern? ...Don't answer. Just gimme it.", dirty: "Mike's or Modern? ...Don't answer, just gimme the damn thing." },
    { id: "lobster", name: "Lobster roll", short: "Lobster roll", d: { hunger: 45, mood: 10, energy: 5 }, act: "eat",
      line: "A lobstah roll?! Look at Mr. Moneybags over here.", dirty: "A lobstah roll?! Look at Mr. Moneybags over here. Hell yeah." },
    { id: "pizza", name: "Pizza slice", short: "Pizza", d: { hunger: 35, mood: 6, hygiene: -4 }, act: "eat",
      line: "Pizza. Classic. Grease on my face, joy in my heart.", dirty: "Pizza. Classic as hell. Grease on my face, joy in my heart." },
    { id: "fluff", name: "Fluff sandwich", short: "Fluffernutter", d: { hunger: 30, mood: 10, energy: 10, hygiene: -6 }, act: "eat",
      line: "A Fluffernutter. Like I'm eight in Southie again. Wicked.", dirty: "A Fluffernutter. Like I'm eight in Southie again. Wicked pissah." }
  ];
  var FBY = {}; FOODS.forEach(function (f) { FBY[f.id] = f; });
  /* which care covers which need, for the daily perfect-care check */
  var LOW_LINE = {
    hunger: ["absolutely starving, stomach growling like a Zamboni", "hungry"],
    energy: ["wiped out, can barely keep your eyes open", "tired"],
    mood: ["sulky and down in the dumps", "in a bit of a mood"],
    hygiene: ["grimy and you stink (you need a shower bad)", "feeling a little grimy"],
    social: ["feeling ignored, like Kyle forgot you exist", "a little lonely, Kyle's been quiet"],
    caffeine: ["in full caffeine withdrawal, no Dunkin' in forever, extra cranky", "overdue for a Dunkin' coffee, a little cranky"]
  };
  var REMIND_LINE = {
    hunger: "🍩 Blarf's starvin'. Tap his needs pill to feed him.",
    energy: "😴 Blarf's fading. Maybe let him nap.",
    mood: "😤 Blarf's sulkin'. Play with him or give him a rub.",
    hygiene: "🫧 Somethin' stinks. Blarf needs a shower.",
    social: "💬 Blarf feels ignored. Say hi.",
    caffeine: "☕ Blarf's in coffee withdrawal. Get him a Dunkin'."
  };
  var CRIT_FACE = { hunger: "😫", energy: "🥱", mood: "😤", hygiene: "🤢", social: "🥺", caffeine: "😠" };

  function S() { return C ? C.S : (window.__blarfNeedsS || (window.__blarfNeedsS = {})); }
  function clamp(v) { v = +v; return !isFinite(v) ? 0 : v < 0 ? 0 : v > 100 ? 100 : v; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function ymd(d) { return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function today(now) { return ymd(new Date(now || Date.now())); }
  function yesterday(now) { var d = new Date(now || Date.now()); return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)); }
  function toast(t) { if (C && C.toast) C.toast(t); }
  function say(t) { try { if (C && C.grumble) C.grumble(t, true); else if (C && C.setCaption) C.setCaption(t); } catch (e) {} }
  function act(n) { try { return window.blarfAct ? window.blarfAct(n) : false; } catch (e) { return false; } }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 10); } catch (e) {} }
  function swear() { return !!S().swear; }
  function line(clean, dirty) { return swear() && dirty ? dirty : clean; }
  function ago(ts) {
    if (!ts) return "";
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.round(h / 24);
    return d === 1 ? "yesterday" : d + "d ago";
  }

  /* ---------- state ---------- */
  function cfg() {
    var s = S(), n = s.needs;
    if (!n || typeof n !== "object") n = s.needs = {};
    if (typeof n.on !== "boolean") n.on = true;
    if (!SPEED[n.speed]) n.speed = "normal";
    if (typeof n.hud !== "boolean") n.hud = true;
    if (typeof n.remind !== "boolean") n.remind = true;
    if (!n.en || typeof n.en !== "object") n.en = {};
    if (!n.v || typeof n.v !== "object") n.v = {};
    if (!n.last || typeof n.last !== "object") n.last = {};
    if (!n.remindAt || typeof n.remindAt !== "object") n.remindAt = {};
    NEEDS.forEach(function (d) {
      if (typeof n.en[d.k] !== "boolean") n.en[d.k] = true;
      var x = n.v[d.k]; n.v[d.k] = typeof x === "number" && isFinite(x) ? clamp(x) : d.start;
    });
    var now = Date.now();
    if (!(typeof n.t === "number" && n.t > 0) || n.t > now + 60000) n.t = now;
    if (n.nap && !(typeof n.nap.at === "number" && n.nap.at > 0)) n.nap = null;
    var st = n.streak;
    if (!st || typeof st !== "object") st = n.streak = {};
    st.n = typeof st.n === "number" && st.n >= 0 ? Math.floor(st.n) : 0;
    st.best = typeof st.best === "number" && st.best >= 0 ? Math.floor(st.best) : 0;
    if (st.best < st.n) st.best = st.n;
    if (typeof st.day !== "string") st.day = "";
    if (!st.prog || typeof st.prog !== "object" || st.prog.day !== today(now)) st.prog = { day: today(now), done: {} };
    if (!st.prog.done || typeof st.prog.done !== "object") st.prog.done = {};
    if (typeof n.msg !== "number") n.msg = 0;
    if (typeof n.said !== "number") n.said = -99;
    if (typeof n.woke !== "number") n.woke = 0;
    return n;
  }
  function on() { return cfg().on; }
  function live(k) { var n = cfg(); return n.on && !!n.en[k]; }
  function liveNeeds() { var n = cfg(); return n.on ? NEEDS.filter(function (d) { return n.en[d.k]; }) : []; }

  var lastSave = 0;
  function save(force) {
    var now = Date.now();
    if (!force && now - lastSave < 120000) return;
    lastSave = now;
    try { if (C && C.save) C.save(); } catch (e) {}
  }

  /* real-time decay from timestamps; a long gap (app closed) is capped and floored */
  function advance(now, quiet) {
    var n = cfg();
    now = now || Date.now();
    var el = now - n.t;
    if (el <= 0) return;
    if (!n.on) { n.t = now; return; }
    var off = el > OFFLINE_MS, eff = off ? Math.min(el, CAP_H * 3600000) : el;
    var h = eff / 3600000, mult = SPEED[n.speed], fl = off ? FLOOR : 0, napping = !!n.nap, low = 0;
    NEEDS.forEach(function (d) { if (d.k !== "mood" && n.en[d.k] && n.v[d.k] < 25) low++; });
    NEEDS.forEach(function (d) {
      if (!n.en[d.k]) return; /* off = frozen */
      var k = d.k, v = n.v[k], r = d.rate * mult;
      if (k === "energy" && napping) { n.v[k] = clamp(v + NAP_RATE * h); return; }
      if (napping) r *= k === "social" ? 0 : 0.4;
      if (k === "mood") { r *= 1 + 0.4 * low; if (n.en.caffeine && n.v.caffeine < 20) r *= 1.5; }
      var nv = v - r * h;
      if (fl) nv = v > fl ? Math.max(fl, nv) : v; /* offline catch-up never drags a need below the floor */
      n.v[k] = clamp(nv);
    });
    n.t = now;
    if (napping) {
      var napMs = now - n.nap.at;
      if ((n.en.energy && n.v.energy >= 100) || (!n.en.energy && napMs > 20 * 60000) || napMs > 12 * 3600000) endNap(false, quiet || off);
    }
  }

  /* ---------- care streak: a perfect day = every need that's on got cared for at least once ---------- */
  var COVER = { feed: ["hunger"], coffee: ["caffeine", "energy"], nap: ["energy"], shower: ["hygiene"], play: ["mood"], pet: ["mood"], talk: ["social"] };
  function careBest() { return cfg().streak.best; }
  function streakNow() {
    var st = cfg().streak, t = today();
    return st.day === t || st.day === yesterday() ? st.n : 0;
  }
  function markCare(kind) {
    var n = cfg(); if (!n.on) return;
    var st = n.streak, t = today();
    (COVER[kind] || []).forEach(function (k) { st.prog.done[k] = 1; });
    var need = liveNeeds();
    if (!need.length || st.day === t) return;
    if (!need.every(function (d) { return st.prog.done[d.k]; })) return;
    var before = st.best;
    st.n = st.day === yesterday() ? st.n + 1 : 1;
    st.day = t;
    if (st.n > st.best) st.best = st.n;
    var unlocked = REWARDS.filter(function (r) { return before < r.care && st.best >= r.care; });
    if (unlocked.length) {
      var r = unlocked[unlocked.length - 1];
      toast("New outfit unlocked: " + r.name + " " + r.emoji + " Settings > Outfit.");
      try { if (C && C.paintOutfit) C.paintOutfit(); } catch (e) {}
    } else toast("✅ Perfect care day! Streak: " + st.n + (st.n === 1 ? " day" : " days"));
    save(true);
  }

  /* ---------- care actions ---------- */
  function bump(d) {
    var n = cfg();
    Object.keys(d).forEach(function (k) { if (n.en[k]) n.v[k] = clamp(n.v[k] + d[k]); });
  }
  function note(k, what) { cfg().last[k] = { ts: Date.now(), what: what || "" }; }
  function wakeIfNapping() { if (cfg().nap) { endNap(true); return true; } return false; }
  function setFood(id) { var h = hero(); if (h) h.setAttribute("data-food", id); }

  function feed(id) {
    var f = FBY[id], n = cfg(); if (!f || !n.on) return;
    advance(); wakeIfNapping();
    var stuffed = f.id !== "coffee" && n.en.hunger && n.v.hunger > 95;
    var wired = f.id === "coffee" && n.en.caffeine && n.v.caffeine > 92;
    setFood(f.id); act(f.act); buzz(12);
    if (stuffed) {
      bump({ hunger: 2, mood: -3 });
      say(line("I'm stuffed, Boss. One more bite and I'm callin' a priest.", "I'm stuffed, Boss. One more damn bite and I'm callin' a priest."));
    } else if (wired) {
      bump({ caffeine: 8, mood: -2 });
      say(line("Kid, my eye's twitchin'. That's like my fifth coffee.", "Kid, my eye's twitchin' like hell. That's like my fifth coffee."));
    } else {
      bump(f.d);
      say(line(f.line, f.dirty));
    }
    if (f.id === "coffee") { note("caffeine", f.name); markCare("coffee"); }
    else { note("hunger", f.name); markCare("feed"); }
    if (f.d.mood > 0) note("mood", f.name);
    afterCare();
  }
  function startNap() {
    var n = cfg(); if (!n.on) return;
    advance();
    if (n.nap) { endNap(true); afterCare(); return; }
    if (n.en.energy && n.v.energy >= 90) { act("shake"); say(line("I ain't tired. Quit babyin' me.", "I ain't tired. Quit babyin' me, damn it.")); return; }
    n.nap = { at: Date.now() };
    act("yawn"); buzz(8);
    say(line("Fine. Five minutes. Nobody touch me.", "Fine. Five minutes. Nobody touch me or I swear to God."));
    save(true); afterCare(true);
  }
  function endNap(early, quiet) {
    var n = cfg(); if (!n.nap) return;
    var slept = Date.now() - n.nap.at;
    n.nap = null;
    if (slept > 10 * 60000 || (n.en.energy && n.v.energy >= 90)) { note("energy", "Nap"); markCare("nap"); }
    if (early && n.en.energy && n.v.energy < 90) {
      bump({ mood: -8 }); n.woke = Date.now();
      if (!quiet) { act("wake"); buzz(20); say(line("WHAT. I was dreamin' about a large regulah. Thanks a lot.", "What the hell, Boss?! I was dreamin' about a large regulah. Thanks a lot.")); }
    } else if (!quiet) { act("nod"); say("Ahh. Fresh as a daisy, kid. What'd I miss?"); }
    save(true);
  }
  function shower() {
    var n = cfg(); if (!n.on) return;
    advance(); wakeIfNapping();
    var clean = n.en.hygiene && n.v.hygiene > 90;
    act("shower"); buzz(10);
    if (clean) { bump({ hygiene: 5 }); say("I'm already squeaky clean. You tryin' to drown me?"); }
    else { bump({ hygiene: 70, mood: 4 }); say(line("Ack! COLD! ...okay, okay, this is nice. Don't look.", "Ack! Cold as hell! ...okay, okay, this is nice. Don't look.")); }
    note("hygiene", "Shower"); markCare("shower"); afterCare();
  }
  var lastPlay = 0;
  function playCredit(what) {
    var n = cfg(); if (!n.on) return;
    advance(); wakeIfNapping();
    var now = Date.now();
    if (now - lastPlay > 90000) bump({ mood: 12, social: 5, energy: -4, hunger: -2 });
    else bump({ mood: 4 });
    lastPlay = now;
    note("mood", what); markCare("play");
  }
  function rps(pick) {
    if (!on()) return;
    var opts = ["rock", "paper", "scissors"], his = opts[Math.floor(Math.random() * 3)];
    var beats = { rock: "scissors", paper: "rock", scissors: "paper" }, E = { rock: "✊", paper: "✋", scissors: "✌️" };
    playCredit("Rock paper scissors");
    var out;
    if (his === pick) { act("nod"); out = E[pick] + " vs " + E[his] + ". Tie. Again, and this time I'm tryin'."; }
    else if (beats[pick] === his) { act("shake"); out = E[pick] + " vs " + E[his] + ". You won. " + line("Best two outta three. No, best ninety outta a hundred.", "Ah, screw it. Best ninety outta a hundred."); }
    else { act("play"); out = E[pick] + " vs " + E[his] + ". Ha! Wicked easy, Boss."; }
    say(out); buzz(10);
    afterCare();
    return out;
  }
  function pet() {
    var n = cfg(); if (!n.on) return;
    advance(); wakeIfNapping();
    try { if (window.BL && window.BL.grouch) window.BL.grouch.rub(); } catch (e) {}
    act("pet"); buzz(8);
    bump({ mood: 8, social: 2 }); note("mood", "Pet");
    say(line("...fine. That's nice. Don't tell the guys.", "...fine. That's nice. Don't tell the damn guys."));
    markCare("pet"); afterCare();
  }
  function afterCare(noSave) { faceSync(); paintAll(); if (!noSave) save(true); }

  /* ---------- hooks from the app ---------- */
  function onTalk(m, text) {
    var n = cfg(); if (!n.on) return;
    advance();
    n.msg++;
    if (n.nap) endNap(true);
    bump(m === "live" ? { social: 12, mood: 2 } : { social: 6, mood: 1 });
    note("social", m === "live" ? "Live talk" : "Chat");
    markCare("talk");
    faceSync(); paintAll(); save();
  }
  function onPlay(game) {
    if (!on()) return;
    playCredit(game === "poke" ? "Poke the Bear" : game === "trivia" ? "Trivia" : game === "roast" ? "Roast Battle" : "Play");
    faceSync(); paintAll(); save(true);
  }
  function onRub() {
    var n = cfg(); if (!n.on) return;
    advance();
    bump({ mood: 10, social: 3 }); note("mood", "Rub");
    act("pet"); markCare("pet"); faceSync(); paintAll(); save(true);
  }
  /* a tap on his face while he naps wakes him (grumpy if early); returns true when it handled the tap */
  function tapFace() {
    var n = cfg(); if (!n.on || !n.nap) return false;
    advance(); endNap(true); faceSync(); paintAll();
    return true;
  }

  /* ---------- personality: one short state line, mention at most once per ~10 messages ---------- */
  function lows() {
    var n = cfg(), out = [];
    liveNeeds().forEach(function (d) { var v = n.v[d.k]; if (v < LOW) out.push({ k: d.k, v: v }); });
    out.sort(function (a, b) { return a.v - b.v; });
    return out;
  }
  function clause(ctx) {
    var n = cfg(); if (!n.on) return "";
    advance(Date.now(), true);
    ctx = ctx || {};
    var L = lows(), parts = L.slice(0, 3).map(function (x) { return LOW_LINE[x.k][x.v < CRIT ? 0 : 1]; });
    var woke = n.woke && Date.now() - n.woke < 180000;
    if (woke) parts.unshift("groggy and grumpy because Kyle just woke you from a nap");
    if (!parts.length) return "";
    var mention = n.said === n.msg || n.msg - n.said >= MENTION_EVERY;
    if (mention) n.said = n.msg;
    var list = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0];
    if (ctx.compact) return " Right now you're " + list + "." + (mention ? " Gripe about it once, briefly." : " Don't mention it.") + " Always answer fully.";
    return " YOUR STATE RIGHT NOW (your Tamagotchi-style needs): you're " + list + "." +
      (mention ? " Mention it once, briefly (one short in-character aside, like griping you haven't had your coffee), then fully answer what he said."
        : " Let it color your mood a little, but don't bring it up this time.") +
      " Never refuse, stall or shortchange an answer because of it, and don't nag.";
  }

  /* ---------- face: props, states ---------- */
  var FOOD_SVG = {
    coffee: '<path d="M-9 -11L9 -11L7 15L-7 15Z" fill="#fff" stroke="#0b0b0b" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<path d="M-8.2 -1L8.2 -1L7.6 7L-7.6 7Z" fill="#FF6E1B"/><circle cx="0" cy="3" r="2.6" fill="#E11383"/>' +
      '<rect x="-11" y="-16" width="22" height="6" rx="2.5" fill="#6B3F1F" stroke="#0b0b0b" stroke-width="2.4"/><rect x="-3" y="-19" width="6" height="4" rx="1.5" fill="#6B3F1F" stroke="#0b0b0b" stroke-width="2"/>',
    donut: '<circle r="13" fill="#E8B26A" stroke="#0b0b0b" stroke-width="2.4"/>' +
      '<path d="M-12.4 -3C-10 -13 10 -13 12.4 -3C9 -1 7 2 4 0C1 3 -3 1 -5 2C-8 3 -10 0 -12.4 -3Z" fill="#4A2A16" stroke="#0b0b0b" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M-4 12.4Q0 16.5 4 12.4Q2 10.6 0 11Q-2 10.6 -4 12.4Z" fill="#FFE9A8" stroke="#0b0b0b" stroke-width="1.4" stroke-linejoin="round"/><path d="M-6 -8l2 -1M2 -9l2 1" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>',
    cannoli: '<g transform="rotate(-25)"><rect x="-15" y="-6" width="30" height="12" rx="6" fill="#D9A35B" stroke="#0b0b0b" stroke-width="2.4"/>' +
      '<path d="M-8 -6v12M0 -6v12M8 -6v12" stroke="#B57E3A" stroke-width="1.6" opacity="0.7"/>' +
      '<ellipse cx="-15" cy="0" rx="4" ry="6" fill="#FFF5DC" stroke="#0b0b0b" stroke-width="2"/><ellipse cx="15" cy="0" rx="4" ry="6" fill="#FFF5DC" stroke="#0b0b0b" stroke-width="2"/>' +
      '<circle cx="-16" cy="-1" r="1" fill="#3A2210"/><circle cx="15" cy="2" r="1" fill="#3A2210"/></g>',
    lobster: '<rect x="-16" y="-3" width="32" height="12" rx="6" fill="#E8B46A" stroke="#0b0b0b" stroke-width="2.4"/>' +
      '<path d="M-13 -2Q-14 -9 -8 -8Q-6 -13 0 -10Q5 -14 8 -9Q14 -10 13 -2Z" fill="#F26B4A" stroke="#0b0b0b" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M-12 -2Q0 1 12 -2" stroke="#6FBF4A" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M-6 -7q2 1 3 -1M3 -8q2 1 3 -1" stroke="#FFD0C2" stroke-width="1.4" fill="none"/>',
    pizza: '<path d="M-13 -11L13 -11L0 15Z" fill="#F6C453" stroke="#0b0b0b" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<path d="M-14 -13L14 -13L13 -9L-13 -9Z" fill="#C98A3D" stroke="#0b0b0b" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<circle cx="-5" cy="-4" r="2.6" fill="#C0392B"/><circle cx="4" cy="-3" r="2.4" fill="#C0392B"/><circle cx="0" cy="5" r="2.2" fill="#C0392B"/>',
    fluff: '<rect x="-13" y="-14" width="26" height="11" rx="4" fill="#F3D9A4" stroke="#0b0b0b" stroke-width="2.2"/>' +
      '<path d="M-13 -3Q-6 1 0 -2Q6 2 13 -3L13 1L-13 1Z" fill="#fff" stroke="#0b0b0b" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<rect x="-13" y="1" width="26" height="3" fill="#B5733A"/>' +
      '<rect x="-13" y="4" width="26" height="11" rx="4" fill="#F3D9A4" stroke="#0b0b0b" stroke-width="2.2"/>'
  };
  function foodIcon(id) { return '<svg viewBox="-18 -20 36 38" aria-hidden="true" focusable="false">' + FOOD_SVG[id] + "</svg>"; }
  var PROPS = function () {
    var foods = Object.keys(FOOD_SVG).map(function (id) { return '<g class="nd-f nd-f--' + id + '">' + FOOD_SVG[id] + "</g>"; }).join("");
    var bub = "", i;
    var BP = [[40, 60, 7], [160, 50, 6], [52, 30, 5], [150, 22, 8], [30, 110, 5], [172, 105, 6], [96, 18, 6], [120, 40, 4]];
    for (i = 0; i < BP.length; i++) bub += '<circle class="nd-b" cx="' + BP[i][0] + '" cy="' + BP[i][1] + '" r="' + BP[i][2] + '" style="--i:' + i + '"/>';
    var drops = "";
    for (i = 0; i < 9; i++) drops += '<path class="nd-drop" d="M' + (40 + i * 15) + ' -6v10" style="--i:' + i + '"/>';
    return '<g class="nd" aria-hidden="true">' +
      /* stink lines (dirty) */
      '<g class="nd-stink"><path d="M18 70q-6 -8 0 -16t0 -16" /><path d="M30 58q-6 -8 0 -16t0 -16" /><path d="M182 70q6 -8 0 -16t0 -16" /><path d="M170 58q6 -8 0 -16t0 -16" /></g>' +
      /* stomach growl bubble (hungry) */
      '<g class="nd-growl" transform="translate(150 182)"><path d="M-28 -12Q-28 -22 -16 -22H18Q30 -22 30 -12Q30 -2 18 -2H-6L-16 6L-14 -2H-16Q-28 -2 -28 -12Z" fill="#fff" stroke="#0b0b0b" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<text x="1" y="-8" text-anchor="middle" font-size="11" font-weight="800" fill="#0b0b0b" font-family="-apple-system,system-ui,sans-serif">grrrr</text></g>' +
      /* Zzz (napping) */
      '<g class="nd-zzz" font-family="-apple-system,system-ui,sans-serif" font-weight="900" fill="#DCEFFF" stroke="#0b0b0b" stroke-width="1.6" paint-order="stroke">' +
      '<text class="nd-z" x="150" y="52" font-size="16" style="--i:0">Z</text><text class="nd-z" x="162" y="36" font-size="21" style="--i:1">Z</text><text class="nd-z" x="176" y="18" font-size="26" style="--i:2">Z</text></g>' +
      /* food on its way to the mouth */
      '<g class="nd-foodw" transform="translate(112 154)"><g class="nd-food">' + foods + "</g></g>" +
      '<g class="nd-steam" transform="translate(112 132)"><path d="M-4 0q-4 -6 0 -12t0 -12"/><path d="M5 2q-4 -6 0 -12t0 -12"/></g>' +
      /* shower: water drops + bubbles */
      '<g class="nd-shower">' + drops + bub + "</g>" +
      /* pet: hearts */
      '<g class="nd-hearts"><path class="nd-heart" style="--i:0" d="M38 72c-6 -6 -14 1 -7 8l7 6l7 -6c7 -7 -1 -14 -7 -8z"/><path class="nd-heart" style="--i:1" d="M166 66c-5 -5 -12 1 -6 7l6 5l6 -5c6 -6 -1 -12 -6 -7z"/><path class="nd-heart" style="--i:2" d="M150 34c-4 -4 -10 1 -5 6l5 4l5 -4c5 -5 -1 -10 -5 -6z"/></g>' +
      /* play: sparkles */
      '<g class="nd-spark"><path style="--i:0" d="M30 50l3 -9l3 9l9 3l-9 3l-3 9l-3 -9l-9 -3z"/><path style="--i:1" d="M166 40l2.5 -7l2.5 7l7 2.5l-7 2.5l-2.5 7l-2.5 -7l-7 -2.5z"/><path style="--i:2" d="M172 120l2 -6l2 6l6 2l-6 2l-2 6l-2 -6l-6 -2z"/></g>' +
      /* woke up grumpy: anger mark */
      '<g class="nd-vein" transform="translate(160 44)"><path d="M-8 -2q4 0 6 -6M2 -8q0 4 6 6M8 2q-4 0 -6 6M-2 8q0 -4 -6 -6"/></g>' +
      "</g>";
  };
  var OUTFIT_SVG =
    '<g class="f-out f-out--dunkin" transform="rotate(-5 100 24)">' +
    '<path d="M38 34C38 9 68 3 100 3C133 3 162 9 164 33Z" fill="#FF6E1B" stroke="#0b0b0b" stroke-width="5" stroke-linejoin="round"/>' +
    '<path class="o-ink" d="M100 4V33M70 8Q62 20 62 33M130 8Q138 20 140 33" stroke-width="2" opacity="0.45"/>' +
    '<rect x="78" y="10" width="44" height="18" rx="6" fill="#E11383" stroke="#0b0b0b" stroke-width="3"/>' +
    '<text x="100" y="24.5" text-anchor="middle" font-size="14" font-weight="900" fill="#fff" font-family="-apple-system,system-ui,sans-serif" letter-spacing="0.5">DD</text>' +
    '<path d="M30 33Q100 22 172 31L182 43Q100 33 22 45Z" fill="#E11383" stroke="#0b0b0b" stroke-width="5" stroke-linejoin="round"/>' +
    '<circle cx="100" cy="4" r="5" fill="#FF6E1B" stroke="#0b0b0b" stroke-width="3"/></g>' +
    '<g class="f-out f-out--bruins">' +
    '<path d="M14 204C18 186 46 180 76 178L100 192L124 178C154 180 182 186 186 204Z" fill="#111" stroke="#0b0b0b" stroke-width="5" stroke-linejoin="round"/>' +
    '<path d="M20 196C30 188 52 184 76 182L100 196L124 182C148 184 170 188 180 196" fill="none" stroke="#FDB927" stroke-width="5"/>' +
    '<path d="M76 178L100 192L124 178" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>' +
    '<circle cx="146" cy="194" r="8" fill="#FDB927" stroke="#0b0b0b" stroke-width="2.5"/>' +
    '<path d="M146 186v16M138 194h16M140.5 188.5l11 11M151.5 188.5l-11 11" stroke="#0b0b0b" stroke-width="1.2" opacity="0.55"/>' +
    '<text x="146" y="198" text-anchor="middle" font-size="10" font-weight="900" fill="#0b0b0b" font-family="-apple-system,system-ui,sans-serif">B</text></g>';
  function hero() { return doc.querySelector("#stage svg.x-hero") || doc.querySelector("svg.x-hero"); }
  function mountFace() {
    var svg = hero(); if (!svg || svg.querySelector(".nd")) return !!svg;
    var r = svg.querySelector(".f-root"); if (!r) return false;
    var tmp = doc.createElementNS("http://www.w3.org/2000/svg", "g");
    tmp.innerHTML = OUTFIT_SVG;
    while (tmp.lastChild) r.insertBefore(tmp.lastChild, r.firstChild);
    r.insertAdjacentHTML("beforeend", PROPS());
    return true;
  }
  var NFACE = { sleep: false, droop: 0, sulk: 0, ty: 0, rot: 0 };
  function faceSync() {
    var n = cfg(), svg = hero(), bl = doc.getElementById("blarf");
    if (!n.on) {
      window.blarfNeedsFace = null;
      if (svg) ["nd-sleep", "nd-dirty", "nd-hungry"].forEach(function (c) { svg.classList.remove(c); });
      if (bl) bl.classList.remove("x-nd-nap");
      return;
    }
    var v = n.v, sleep = !!n.nap;
    NFACE.sleep = sleep;
    NFACE.droop = !sleep && n.en.energy && v.energy < 30 ? (30 - v.energy) / 30 * 0.5 : 0;
    var sulk = 0;
    if (n.en.mood && v.mood < 25) sulk += (25 - v.mood) / 25 * 0.45;
    if (n.en.caffeine && v.caffeine < 15) sulk += 0.15;
    if (n.en.hunger && v.hunger < 10) sulk += 0.1;
    NFACE.sulk = sleep ? 0 : Math.min(0.6, sulk);
    NFACE.ty = sleep ? 6 : NFACE.droop * 6;
    NFACE.rot = sleep ? -5 : 0;
    window.blarfNeedsFace = NFACE;
    if (svg) {
      svg.classList.toggle("nd-sleep", sleep);
      svg.classList.toggle("nd-dirty", !!(n.en.hygiene && v.hygiene < 25));
      svg.classList.toggle("nd-hungry", !!(!sleep && n.en.hunger && v.hunger < 25));
    }
    if (bl) bl.classList.toggle("x-nd-nap", sleep);
  }

  /* ---------- HUD pill on the face screen ---------- */
  var pill = null;
  function statusFace() {
    var n = cfg();
    if (n.nap) return "😴";
    var L = lows();
    if (L.length && L[0].v < CRIT) return CRIT_FACE[L[0].k];
    if (L.length) return "😒";
    var ok = liveNeeds().every(function (d) { return n.v[d.k] >= 70; });
    return ok ? "😎" : "🙂";
  }
  function statusText() {
    var n = cfg();
    if (n.nap) return "Napping. Tap his face or Wake to wake him (he'll be grumpy).";
    var L = lows();
    if (!L.length) return liveNeeds().every(function (d) { return n.v[d.k] >= 70; }) ? "Livin' large. Fed, caffeinated, happy-ish." : "Doin' alright. For now.";
    var W = { hunger: "Hungry", energy: "Tired", mood: "Sulky", hygiene: "Stinky", social: "Lonely", caffeine: "Needs coffee" };
    return L.slice(0, 3).map(function (x) { return (x.v < CRIT ? "Very " + W[x.k].toLowerCase() : W[x.k]); }).join(" · ");
  }
  function buildPill() {
    var stage = doc.getElementById("stage"); if (!stage || doc.getElementById("needs-pill")) return;
    pill = doc.createElement("button");
    pill.type = "button"; pill.id = "needs-pill"; pill.className = "x-needs";
    pill.setAttribute("aria-haspopup", "dialog"); pill.setAttribute("aria-controls", "needs-sheet");
    stage.appendChild(pill);
    pill.addEventListener("click", function (e) { e.stopPropagation(); open(); });
  }
  function paintPill() {
    if (!pill) return;
    var n = cfg(), list = liveNeeds();
    pill.hidden = !n.on || !n.hud || !list.length;
    if (pill.hidden) return;
    var low = lows(), crit = low.length && low[0].v < REMIND;
    pill.classList.toggle("is-low", !!crit);
    pill.innerHTML = '<span class="x-needs__face" aria-hidden="true">' + statusFace() + '</span><span class="x-needs__rings" aria-hidden="true">' +
      list.map(function (d) {
        var p = Math.round(n.v[d.k]);
        return '<i style="--c:' + d.color + ";--p:" + p + '"' + (p < LOW ? ' class="is-low"' : "") + "></i>";
      }).join("") + "</span>";
    pill.setAttribute("aria-label", "Blarf's needs: " + list.map(function (d) { return d.label + " " + Math.round(n.v[d.k]) + "%"; }).join(", ") + (n.nap ? ". Napping" : "") + ". Open needs");
  }

  /* ---------- needs sheet ---------- */
  var sheet = null, panel = null, body = null, sub = "", openState = false;
  var RC = 2 * Math.PI * 24;
  function buildSheet() {
    if (sheet) return;
    sheet = doc.createElement("div");
    sheet.className = "x-menu x-nd-sheet"; sheet.id = "needs-sheet"; sheet.hidden = true;
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true"); sheet.setAttribute("aria-labelledby", "needs-t");
    sheet.innerHTML = '<button class="x-menu__scrim x-scrim" id="needs-scrim" type="button" aria-label="Close needs" tabindex="-1"></button>' +
      '<div class="x-menu__panel x-crew__panel x-nd__panel" id="needs-panel"><div class="x-grabber" aria-hidden="true"></div>' +
      '<div class="x-crew__head" id="needs-head"><span class="x-crew__emoji" id="needs-face" aria-hidden="true">🙂</span><div><h3 id="needs-t">Blarf\'s needs</h3><small id="needs-sub" aria-live="polite"></small></div>' +
      '<button class="btn" id="needs-done" type="button">Done</button></div>' +
      '<div id="needs-body" class="x-nd__body"></div></div>';
    doc.body.appendChild(sheet);
    panel = doc.getElementById("needs-panel"); body = doc.getElementById("needs-body");
    doc.getElementById("needs-done").addEventListener("click", function () { setOpen(false); });
    doc.getElementById("needs-scrim").addEventListener("click", function () { setOpen(false); });
    if (C && C.sheetDrag) C.sheetDrag(panel, [doc.getElementById("needs-head"), panel.querySelector(".x-grabber")], doc.getElementById("needs-scrim"), function () { setOpen(false); });
    body.addEventListener("click", onSheetClick);
    sheet.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } });
  }
  function setOpen(v) {
    buildSheet();
    openState = !!v;
    if (C && C.layerSheet) C.layerSheet(sheet, v); else sheet.hidden = !v;
    if (v) {
      sub = ""; advance(); render(true);
      setTimeout(function () { var b = body.querySelector(".x-nd__care button"); if (b) b.focus({ preventScroll: true }); }, 320);
    } else { var p = doc.getElementById("needs-pill"); if (p && !p.hidden) p.focus({ preventScroll: true }); }
  }
  function open() {
    var n = cfg();
    if (!n.on) { toast("Needs are off. Settings > Needs."); return; }
    try { if (C && C.setMenu) C.setMenu(false, true); } catch (e) {}
    setOpen(true);
  }
  function lastLine(k) {
    var n = cfg(), l = n.last[k];
    if (k === "energy" && n.nap) return "Napping… " + ago(n.nap.at).replace(" ago", "");
    if (!l || !l.ts) return "Not yet";
    var verb = { hunger: "Fed", energy: "Napped", mood: "", hygiene: "Showered", social: "Talked", caffeine: "Coffee" }[k];
    if (k === "hunger") return "Fed " + ago(l.ts) + (l.what ? " · " + l.what : "");
    if (k === "mood") return (l.what || "Cared") + " · " + ago(l.ts);
    return verb + " " + ago(l.ts);
  }
  function ringHTML(d, intro) {
    var n = cfg(), p = Math.round(n.v[d.k]), off = RC * (1 - p / 100);
    return '<div class="x-nd__ring' + (p < LOW ? " is-low" : "") + '" data-need="' + d.k + '" role="group" aria-label="' + d.label + " " + p + '%">' +
      '<svg viewBox="0 0 60 60" aria-hidden="true"><circle class="x-nd__track" cx="30" cy="30" r="24"/>' +
      '<circle class="x-nd__arc" cx="30" cy="30" r="24" stroke="' + d.color + '" stroke-dasharray="' + RC.toFixed(2) + '" stroke-dashoffset="' + (intro ? RC : off).toFixed(2) + '" data-off="' + off.toFixed(2) + '"/></svg>' +
      '<span class="x-nd__em" aria-hidden="true">' + (d.k === "mood" ? statusFace() : d.emoji) + "</span>" +
      '<b class="x-nd__lbl">' + d.label + ' <span class="x-nd__pct">' + p + "%</span></b>" +
      '<small class="x-nd__last">' + esc(lastLine(d.k)) + "</small></div>";
  }
  function careHTML() {
    var n = cfg();
    var B = [["feed", "🍩", "Feed"], ["nap", n.nap ? "⏰" : "😴", n.nap ? "Wake" : "Nap"], ["shower", "🫧", "Shower"], ["play", "🎮", "Play"], ["talk", "💬", "Talk"], ["pet", "🤚", "Pet"]];
    return '<div class="x-nd__care" role="group" aria-label="Care">' + B.map(function (b) {
      var exp = b[0] === "feed" || b[0] === "play";
      return '<button type="button" data-care="' + b[0] + '"' + (exp ? ' aria-expanded="' + (sub === b[0]) + '"' : "") + (sub === b[0] ? ' class="is-on"' : "") +
        '><span aria-hidden="true">' + b[1] + "</span>" + b[2] + "</button>";
    }).join("") + "</div>";
  }
  function fmtD(d) {
    var I = { hunger: "🍩", energy: "⚡", mood: "😊", hygiene: "🫧", social: "💬", caffeine: "☕" };
    return Object.keys(d).filter(function (k) { return live(k); }).map(function (k) { return (d[k] > 0 ? "+" : "") + d[k] + I[k]; }).join(" ");
  }
  function subHTML() {
    if (sub === "feed") return '<div class="x-nd__sub" role="group" aria-label="Menu"><p class="x-nd__h">What\'s he eatin\'?</p><div class="x-nd__foods">' +
      FOODS.map(function (f) { return '<button type="button" data-food="' + f.id + '">' + foodIcon(f.id) + "<b>" + esc(f.name) + "</b><small>" + esc(fmtD(f.d)) + "</small></button>"; }).join("") + "</div></div>";
    if (sub === "play") return '<div class="x-nd__sub" role="group" aria-label="Play"><p class="x-nd__h">Quick round: rock, paper, scissors</p><div class="x-nd__rps">' +
      [["rock", "✊"], ["paper", "✋"], ["scissors", "✌️"]].map(function (r) { return '<button type="button" data-rps="' + r[0] + '" aria-label="' + r[0] + '">' + r[1] + "</button>"; }).join("") +
      '</div><p class="x-nd__rpsout" id="needs-rps" aria-live="polite"></p><p class="x-nd__h">Or a real game</p><div class="x-nd__games">' +
      '<button type="button" data-game="poke">🐻 Poke the Bear</button><button type="button" data-game="trivia">🧠 Trivia</button><button type="button" data-game="roast">🔥 Roast Battle</button></div></div>';
    return "";
  }
  function streakHTML() {
    var n = cfg(), st = n.streak, cur = streakNow(), list = liveNeeds();
    var perfect = st.day === today();
    var next = REWARDS.filter(function (r) { return st.best < r.care; })[0];
    return '<div class="x-nd__streak"><div class="x-nd__srow"><span class="x-nd__flame" aria-hidden="true">🔥</span><div><b>Care streak: ' + cur + (cur === 1 ? " day" : " days") + "</b>" +
      "<small>Best " + st.best + " · " + (perfect ? "Today's perfect ✓" : "Care for every need today") + "</small></div></div>" +
      '<div class="x-nd__today" aria-label="Today">' + list.map(function (d) {
        var ok = !!st.prog.done[d.k];
        return '<span class="' + (ok ? "is-done" : "") + '">' + (ok ? "✓ " : "") + d.label + "</span>";
      }).join("") + "</div>" +
      '<p class="x-nd__reward">' + (next ? next.emoji + " " + next.name + " unlocks at " + next.care + " perfect days in a row" + (st.best ? " (best so far " + st.best + ")" : "") : "🏆 Dunkin' cap and Bruins jersey unlocked. Wear 'em in Settings > Outfit.") + "</p></div>";
  }
  function render(intro) {
    if (!body) return;
    var list = liveNeeds();
    doc.getElementById("needs-face").textContent = statusFace();
    doc.getElementById("needs-sub").textContent = statusText();
    body.innerHTML = '<div class="x-nd__rings">' + list.map(function (d) { return ringHTML(d, intro); }).join("") + "</div>" +
      careHTML() + subHTML() + streakHTML() +
      '<p class="x-gnote">' + SPEED_LBL[cfg().speed] + ' speed. No death, no lost progress: at zero he just gets dramatic. <button class="x-nd__link" type="button" data-care="settings">Needs settings</button></p>';
    if (intro) requestAnimationFrame(function () { requestAnimationFrame(function () {
      [].slice.call(body.querySelectorAll(".x-nd__arc")).forEach(function (a) { a.setAttribute("stroke-dashoffset", a.getAttribute("data-off")); });
    }); });
  }
  /* live update without rebuilding (keeps focus and the ring transitions) */
  function paintSheet() {
    if (!openState || !body) return;
    var n = cfg();
    doc.getElementById("needs-face").textContent = statusFace();
    doc.getElementById("needs-sub").textContent = statusText();
    [].slice.call(body.querySelectorAll(".x-nd__ring")).forEach(function (el) {
      var k = el.getAttribute("data-need"), d = BY[k]; if (!d) return;
      var p = Math.round(n.v[k]), off = RC * (1 - p / 100), a = el.querySelector(".x-nd__arc");
      a.setAttribute("stroke-dashoffset", off.toFixed(2)); a.setAttribute("data-off", off.toFixed(2));
      el.querySelector(".x-nd__pct").textContent = p + "%";
      el.querySelector(".x-nd__last").textContent = lastLine(k);
      if (k === "mood") el.querySelector(".x-nd__em").textContent = statusFace();
      el.classList.toggle("is-low", p < LOW);
      el.setAttribute("aria-label", d.label + " " + p + "%");
    });
    var napB = body.querySelector('[data-care="nap"]');
    if (napB) napB.innerHTML = '<span aria-hidden="true">' + (n.nap ? "⏰" : "😴") + "</span>" + (n.nap ? "Wake" : "Nap");
    var s = body.querySelector(".x-nd__streak");
    if (s) s.outerHTML = streakHTML();
  }
  function onSheetClick(e) {
    var b = e.target.closest("button"); if (!b) return;
    var c = b.getAttribute("data-care");
    if (c === "feed" || c === "play") { sub = sub === c ? "" : c; render(false); var f = body.querySelector(sub === "feed" ? "[data-food]" : "[data-rps]"); if (f) f.focus({ preventScroll: true }); return; }
    if (c === "nap") { startNap(); paintSheet(); return; }
    if (c === "shower") { shower(); paintSheet(); return; }
    if (c === "pet") { pet(); paintSheet(); return; }
    if (c === "talk") {
      setOpen(false);
      if (cfg().nap) endNap(true);
      try { C.go("chat"); C.setSheet(true); setTimeout(function () { if (C.V && C.V.chat) C.V.chat.input.focus(); }, 380); } catch (er) {}
      return;
    }
    if (c === "settings") { setOpen(false); try { C.setSheet(false); C.go("settings"); setTimeout(function () { var g = doc.getElementById("needs-settings"); if (g) g.scrollIntoView({ block: "start" }); }, 420); } catch (er) {} return; }
    var food = b.getAttribute("data-food");
    if (food) { feed(food); sub = ""; render(false); return; }
    var r = b.getAttribute("data-rps");
    if (r) { var out = rps(r); paintSheet(); var o = doc.getElementById("needs-rps"); if (o) o.textContent = out || ""; return; }
    var g = b.getAttribute("data-game");
    if (g) {
      setOpen(false);
      var mi = doc.querySelector('#menu [data-go="' + g + '"]');
      if (mi) setTimeout(function () { mi.click(); }, 60);
    }
  }

  /* ---------- Settings › Needs ---------- */
  function buildSettings() {
    if (doc.getElementById("needs-settings")) return;
    var set = doc.querySelector("#view-settings .x-settings"); if (!set) return;
    var anchor = [].slice.call(set.querySelectorAll(".x-glabel")).filter(function (l) { return l.textContent.trim() === "Outfit"; })[0];
    var d = doc.createElement("div"); d.id = "needs-settings";
    d.innerHTML = '<p class="x-glabel">Needs</p><div class="x-group">' +
      '<div class="x-row"><span class="x-twoline" id="nset-on-l">Needs<small>Tamagotchi mode: he gets hungry, tired, stinky</small></span><button class="x-switch" id="nset-on" type="button" role="switch" aria-checked="true" aria-labelledby="nset-on-l"></button></div>' +
      NEEDS.map(function (n) {
        return '<div class="x-row nset-need"><span id="nset-' + n.k + '-l">' + n.emoji + " " + n.label + '</span><button class="x-switch" data-need="' + n.k + '" type="button" role="switch" aria-checked="true" aria-labelledby="nset-' + n.k + '-l"></button></div>';
      }).join("") +
      '<div class="x-row nset-more"><label for="nset-speed">Decay speed</label><select class="x-field" id="nset-speed"><option value="chill">Chill</option><option value="normal">Normal</option><option value="hardcore">Hardcore</option></select></div>' +
      '<div class="x-row nset-more"><span id="nset-hud-l">Show needs pill</span><button class="x-switch" id="nset-hud" type="button" role="switch" aria-checked="true" aria-labelledby="nset-hud-l"></button></div>' +
      '<div class="x-row nset-more"><span class="x-twoline" id="nset-rem-l">Reminders<small>A heads-up when a need gets low while the app\'s open</small></span><button class="x-switch" id="nset-rem" type="button" role="switch" aria-checked="true" aria-labelledby="nset-rem-l"></button></div>' +
      '<button class="x-danger nset-more" id="nset-reset" type="button">Reset needs</button>' +
      '</div><p class="x-gnote">No death, no permanent loss. Needs keep ticking while the app is closed, but the catch-up is capped. A need that\'s off is hidden, frozen and doesn\'t affect his mood. Reset keeps your best care streak and outfits.</p>';
    if (anchor && anchor.parentNode && anchor.parentNode.parentNode === set) set.insertBefore(d, anchor.parentNode); else set.appendChild(d);
    var g = function (id) { return doc.getElementById(id); };
    g("nset-on").addEventListener("click", function () {
      var n = cfg(); advance(); n.on = !n.on; n.t = Date.now(); if (!n.on && n.nap) n.nap = null;
      save(true); faceSync(); paintAll();
      toast(n.on ? "Needs on. Feed the beast." : "Needs off. He's just Blarf.");
    });
    d.addEventListener("click", function (e) {
      var b = e.target.closest("[data-need]"); if (!b) return;
      var n = cfg(), k = b.getAttribute("data-need"); advance(); n.en[k] = !n.en[k];
      if (k === "energy" && !n.en.energy && n.nap) n.nap = null;
      save(true); faceSync(); paintAll(); if (openState) render(false);
    });
    g("nset-speed").addEventListener("change", function (e) { var n = cfg(); advance(); n.speed = SPEED[e.target.value] ? e.target.value : "normal"; save(true); paintAll(); });
    g("nset-hud").addEventListener("click", function () { var n = cfg(); n.hud = !n.hud; save(true); paintAll(); });
    g("nset-rem").addEventListener("click", function () { var n = cfg(); n.remind = !n.remind; save(true); paintAll(); });
    var armT = 0;
    g("nset-reset").addEventListener("click", function () {
      var b = g("nset-reset");
      if (!armT) { b.textContent = "Tap again to reset needs"; armT = setTimeout(function () { armT = 0; b.textContent = "Reset needs"; }, 4000); return; }
      clearTimeout(armT); armT = 0; b.textContent = "Reset needs";
      reset(); toast("Needs reset. Fresh start, kid.");
    });
  }
  function reset() {
    var n = cfg();
    NEEDS.forEach(function (d) { n.v[d.k] = d.start; });
    n.t = Date.now(); n.nap = null; n.last = {}; n.remindAt = {}; n.woke = 0; n.said = n.msg - MENTION_EVERY;
    n.streak.prog = { day: today(), done: {} }; n.streak.n = 0; n.streak.day = "";
    save(true); faceSync(); paintAll(); if (openState) render(false);
  }
  function paintSettings() {
    var box = doc.getElementById("needs-settings"); if (!box) return;
    var n = cfg(), sw = function (el, v) { if (el) el.setAttribute("aria-checked", v ? "true" : "false"); };
    sw(doc.getElementById("nset-on"), n.on);
    [].slice.call(box.querySelectorAll("[data-need]")).forEach(function (b) { sw(b, n.en[b.getAttribute("data-need")]); });
    [].slice.call(box.querySelectorAll(".nset-need, .nset-more")).forEach(function (r) { r.hidden = !n.on; });
    var sp = doc.getElementById("nset-speed"); if (sp && doc.activeElement !== sp) sp.value = n.speed;
    sw(doc.getElementById("nset-hud"), n.hud); sw(doc.getElementById("nset-rem"), n.remind);
  }
  function buildMenu() {
    var lib = doc.querySelector('#menu [data-go="library"]');
    if (!lib || doc.getElementById("menu-needs")) return;
    var b = doc.createElement("button");
    b.className = "x-menu__item"; b.type = "button"; b.id = "menu-needs";
    b.innerHTML = '<span aria-hidden="true">🍩</span><span>Needs</span>';
    lib.parentNode.insertBefore(b, lib);
    b.addEventListener("click", function () { try { C.setMenu(false, true); } catch (e) {} if (C.go) C.go("chat"); try { C.setSheet(false); } catch (e) {} setTimeout(open, 60); });
  }
  function paintAll() { paintPill(); paintSheet(); paintSettings(); }

  /* ---------- ticking, reminders, growls ---------- */
  var lastRemind = 0, nextGrowl = 0, prevV = {};
  function tick() {
    if (doc.hidden) return;
    var n = cfg(), now = Date.now();
    advance(now);
    if (n.on) {
      if (n.remind && now - lastRemind > 20 * 60000) {
        var hit = liveNeeds().filter(function (d) {
          var v = n.v[d.k], was = prevV[d.k];
          return v < REMIND && (was === undefined || was >= REMIND || now - (n.remindAt[d.k] || 0) > 2 * 3600000) && now - (n.remindAt[d.k] || 0) > 2 * 3600000;
        })[0];
        if (hit && !(hit.k === "energy" && n.nap)) { n.remindAt[hit.k] = now; lastRemind = now; toast(REMIND_LINE[hit.k]); }
      }
      if (n.en.hunger && n.v.hunger < 20 && !n.nap && now > nextGrowl) {
        var top = doc.getElementById("top"), bl = doc.getElementById("blarf");
        if ((!top || (top.getAttribute("data-tab") || "chat") === "chat") && bl && !bl.classList.contains("is-up")) act("growl");
        nextGrowl = now + 120000 + Math.random() * 90000;
      }
    }
    liveNeeds().forEach(function (d) { prevV[d.k] = n.v[d.k]; });
    faceSync(); paintAll(); save();
  }

  /* ---------- boot ---------- */
  var booted = false;
  function init() {
    if (booted || !window.blarfCore) return;
    booted = true; C = window.blarfCore;
    var n = cfg();
    advance(Date.now(), true);
    liveNeeds().forEach(function (d) { prevV[d.k] = n.v[d.k]; });
    nextGrowl = Date.now() + 45000;
    mountFace(); buildPill(); buildSettings(); buildMenu();
    faceSync(); paintAll();
    try { if (C.paintOutfit) C.paintOutfit(); } catch (e) {}
    setInterval(tick, 15000);
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden) tick(); else { advance(); save(true); } });
    window.addEventListener("pagehide", function () { advance(); save(true); });
  }

  window.blarfNeeds = {
    clause: clause, onTalk: onTalk, onPlay: onPlay, onRub: onRub, tapFace: tapFace, careBest: careBest, open: open,
    feed: feed, nap: startNap, wake: function () { endNap(true); faceSync(); paintAll(); }, shower: shower, pet: pet, rps: rps, reset: reset,
    state: function () { advance(Date.now(), true); return cfg(); }, advance: advance, streak: streakNow, foods: FOODS.map(function (f) { return f.id; }),
    _tick: tick, _remindReset: function () { lastRemind = 0; }
  };
  if (window.blarfCore) init(); else window.addEventListener("blarf-core", init);
})();

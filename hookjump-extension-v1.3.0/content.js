// HookJump content script.
// Watches the player, turns listening behaviour into rewards, learns per-chunk values,
// and shows one hook option per source (You / Community / Heatmap). It only skips by itself
// when Auto-skip (or Hook marathon) is turned on.
(function () {
  "use strict";
  const CFG = HOOKJUMP_CONFIG;
  const Core = HookJumpCore;
  const CH = CFG.CHUNK_SECONDS;
  const R = CFG.REWARDS;
  const SETTLE = CFG.SETTLE_SECONDS;
  const IS_MUSIC = location.hostname === "music.youtube.com";
  const SOURCE_LABEL = { you: "You", community: "Community", heatmap: "Heatmap" };
  const ORDER = ["you", "community", "heatmap"]; // also the auto-skip priority
  const MISSING = { you: "tap 🔥 to teach it", community: "no data yet", heatmap: "not on this video" };
  const AUTO_MINIMIZE_MS = 10000;

  let settings = { enabled: true, share: true, autoSkip: false, marathon: false };
  let S = null; // current song session

  function newSession(id, video) {
    return {
      id: id, video: video, n: 0,
      base: null, local: null, global: null, globalRows: null, heat: null,
      storedLocal: null, localLoaded: false, globalLoaded: false, heatTries: 0,
      acc: {},            // summed reward per chunk for THIS listen (sent once, at the end)
      listened: [], credited: [],
      lastT: 0, ended: false,
      burst: null,        // a run of seeks; only its final settled landing point is learned
      selfSeek: false, jump: null, hookEnd: null, jumped: false,
      picks: {}, presented: false, panelAuto: false, minTimer: null,
      wasAd: false, adEndedAt: 0,
      saveTimer: null, startedAt: Date.now()
    };
  }

  // ---------- helpers ----------
  function videoIdFromUrl() {
    try {
      const u = new URL(location.href);
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function isAd() {
    return !!document.querySelector(".ad-showing, .ad-interrupting");
  }
  function chunkOf(t) {
    if (!S || !S.n) return -1;
    return Math.min(S.n - 1, Math.max(0, Math.floor(t / CH)));
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function fmt(t) {
    t = Math.max(0, Math.floor(t));
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }
  function safeSend(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, function (res) {
        void chrome.runtime.lastError;
        if (cb) cb(res);
      });
    } catch (e) { if (cb) cb(null); } // extension reloaded / context invalidated
  }
  function log() {
    if (CFG.DEBUG) console.log.apply(console, ["[HookJump]"].concat([].slice.call(arguments)));
  }

  // ---------- rewards & learning ----------
  // All rewards for a chunk during one listen are summed and clamped to [-3, 3], then applied
  // as ONE Q update (recomputed from the value the chunk had when the song started), so a
  // listen is one clean observation per chunk, both locally and in the community table.
  function reward(c, r, offset, deliberate) {
    if (!S || !S.local || c < 0 || c >= S.n) return;
    if (deliberate) S.local.k[c] = S.base.k[c] + 1;
    S.acc[c] = (S.acc[c] || 0) + r;
    const total = clamp(S.acc[c], -3, 3);
    S.local.q[c] = S.base.q[c] + CFG.ALPHA * (total - S.base.q[c]);
    S.local.n[c] = S.base.n[c] + 1;
    if (typeof offset === "number") {
      const prev = S.base.o[c];
      const off = clamp(offset, 0, CH - 0.25);
      S.local.o[c] = prev === null ? off : prev + 0.3 * (off - prev);
    }
    log("reward chunk " + c + " (" + c * CH + "s) r=" + r + " total=" + total.toFixed(2) + (typeof offset === "number" ? " land@" + (c * CH + offset).toFixed(1) + "s" : ""));
    scheduleSave();
  }
  function scheduleSave() {
    if (!S || S.saveTimer) return;
    const sess = S;
    sess.saveTimer = setTimeout(function () { sess.saveTimer = null; saveLocal(sess); }, 1500);
  }
  function round(x, d) { const m = Math.pow(10, d); return Math.round(x * m) / m; }
  function saveLocal(sess) {
    if (!sess || !sess.local) return;
    const obj = {};
    obj["q:" + sess.id] = {
      n: sess.n,
      q: sess.local.q.map(function (x) { return round(x, 3); }),
      c: sess.local.n,
      k: sess.local.k,
      o: sess.local.o.map(function (x) { return x === null ? null : round(x, 2); }),
      t: Date.now()
    };
    try { chrome.storage.local.set(obj); } catch (e) { /* ignore */ }
  }
  function flush(sess) {
    const events = Object.keys(sess.acc).map(function (c) {
      return { c: Number(c), r: round(clamp(sess.acc[c], -3, 3), 2) };
    }).filter(function (e) { return e.r !== 0; });
    sess.acc = {};
    if (!settings.share || !events.length) return;
    log("sending " + events.length + " chunk rewards to community");
    for (let i = 0; i < events.length; i += 200) {
      safeSend({ type: "submit", video: sess.id, events: events.slice(i, i + 200) });
    }
  }

  // ---------- seek bursts ----------
  // Scrubbing, arrow keys and small rewinds all belong to one burst. The burst only ends once
  // you listen SETTLE seconds without seeking; then we learn:
  //   * chunks between where you left and where you settled  -> SKIP
  //   * the chunk where you settled                           -> LAND (+ the exact second)
  //   * going back to something you already heard             -> REPLAY
  // Intermediate positions you passed through are ignored.
  function settleBurst() {
    const b = S.burst;
    S.burst = null;
    Object.keys(b.listened).forEach(function (c) { S.listened[c] = (S.listened[c] || 0) + b.listened[c]; });
    const A = b.from, L = b.land;
    const ca = chunkOf(A), cl = chunkOf(L);
    log("settled: left " + fmt(A) + " -> landed " + fmt(L));

    if (b.jump) {
      if (Math.abs(cl - b.jump.chunk) <= 1) log("jump fine-tuned (not a rejection)");
      else rejectJump(b.jump.chunk);
    }
    if (L < 3 || Math.abs(L - A) < 2) return; // restart or no real move
    const off = L - cl * CH;
    if (L > A) {
      if (!b.jump && (S.listened[ca] || 0) < CH * 0.5) reward(ca, R.LEAVE);
      for (let c = ca + 1; c < cl; c++) if (!S.credited[c]) reward(c, R.SKIP);
      reward(cl, R.LAND, off, true);
    } else {
      const heard = S.credited[cl] || (S.listened[cl] || 0) >= CH * 0.5;
      reward(cl, heard ? R.REPLAY : R.LAND, off, true);
    }
    if (S.presented) refreshOptions(false);
  }
  function rejectJump(c) {
    reward(c, R.JUMP_REJECT);
    for (let k = 1; k < CFG.HOOK_CHUNKS; k++) reward(c + k, R.JUMP_REJECT * 0.67);
  }

  // ---------- ads ----------
  function adCheck() {
    if (!S) return isAd();
    const ad = isAd();
    if (ad && !S.wasAd) { S.burst = null; log("ad started: paused learning"); }
    if (!ad && S.wasAd) { S.adEndedAt = Date.now(); S.lastT = S.video.currentTime; log("ad ended"); }
    S.wasAd = ad;
    if (ui) ui.root.classList.toggle("hj-ad", ad);
    return ad;
  }
  function justAfterAd() { return S && Date.now() - S.adEndedAt < 2500; }

  // ---------- player events ----------
  function onTime() {
    if (!S || !S.n || adCheck()) return;
    const v = S.video, t = v.currentTime, d = t - S.lastT;
    const natural = d > 0 && d < 1.5 && !v.paused && !v.seeking;
    if (natural) {
      const c = chunkOf(S.lastT);
      if (S.burst) {
        S.burst.heard += d;
        S.burst.listened[c] = (S.burst.listened[c] || 0) + d;
        if (S.burst.heard >= SETTLE) settleBurst();
      } else {
        S.listened[c] = (S.listened[c] || 0) + d;
        if (!S.credited[c] && S.listened[c] >= CH * 0.8) {
          S.credited[c] = true;
          reward(c, R.LISTEN);
        }
        if (S.jump) {
          S.jump.heard += d;
          if (S.jump.heard >= 10) { reward(S.jump.chunk, R.JUMP_KEEP, undefined, true); S.jump = null; }
        }
      }
    }
    S.lastT = t;

    if (settings.marathon && S.jumped && S.hookEnd !== null && t >= S.hookEnd * CH) {
      S.jumped = false;
      nextSong();
    }
    maybePresent();
  }

  function onSeeking() {
    if (!S || !S.n || adCheck() || justAfterAd()) return;
    if (S.selfSeek) return; // our own jump
    if (!S.burst) {
      S.burst = { from: S.lastT, land: S.video.currentTime, heard: 0, listened: {}, jump: S.jump };
      S.jump = null;
      log("seek burst started at " + fmt(S.lastT));
    } else {
      S.burst.heard = 0;
      S.burst.listened = {};
    }
  }
  function onSeeked() {
    if (!S) return;
    const t = S.video.currentTime;
    if (S.selfSeek) { S.selfSeek = false; S.lastT = t; return; }
    if (S.burst) S.burst.land = t;
    S.lastT = t;
  }
  function onEnded() { if (S) S.ended = true; }

  function nextSong() {
    const btn = document.querySelector(IS_MUSIC ? "ytmusic-player-bar .next-button" : ".ytp-next-button");
    if (btn) btn.click();
  }

  // ---------- knowledge sources ----------
  function loadLocal(sess) {
    try {
      chrome.storage.local.get("q:" + sess.id, function (res) {
        if (sess !== S) return;
        const st = res && res["q:" + sess.id];
        sess.storedLocal = st ? { q: st.q, n: st.c, o: st.o, k: st.k } : null;
        sess.localLoaded = true;
        initTables(sess);
      });
    } catch (e) { sess.localLoaded = true; }
  }
  function loadGlobal(sess) {
    if (!settings.share) { sess.globalLoaded = true; return; }
    safeSend({ type: "getScores", video: sess.id }, function (rows) {
      if (sess !== S) return;
      sess.globalRows = Array.isArray(rows) ? rows : [];
      sess.globalLoaded = true;
      initTables(sess);
    });
    setTimeout(function () { if (!sess.globalLoaded) { sess.globalLoaded = true; initTables(sess); } }, 5000);
  }
  function initTables(sess) {
    if (!sess.n) return;
    if (!sess.local && sess.localLoaded) {
      sess.base = Core.fitTable(sess.storedLocal, sess.n);
      sess.local = Core.cloneTable(sess.base);
    }
    if (!sess.global && sess.globalRows) {
      const g = Core.emptyTable(sess.n);
      sess.globalRows.forEach(function (r) {
        if (r.chunk >= 0 && r.chunk < sess.n) { g.q[r.chunk] = Number(r.q) || 0; g.n[r.chunk] = Number(r.n) || 0; }
      });
      sess.global = g;
    }
  }
  // YouTube's "Most replayed" graph. The current player ("delhi" UI) keeps the data in
  // path.ytp-modern-heat-map; older players used path.ytp-heat-map-path (now often left empty).
  let lastHeat = { vid: null, sig: null };
  function readHeatmap(sess) {
    if (IS_MUSIC || sess.heat || sess.heatTries > 30) return;
    sess.heatTries++;
    let paths = Array.from(document.querySelectorAll("#movie_player .ytp-modern-heat-map"));
    if (!paths.some(function (p) { return (p.getAttribute("d") || "").length > 20; })) {
      paths = Array.from(document.querySelectorAll("#movie_player .ytp-heat-map-path"));
    }
    paths = paths.filter(function (p) { return (p.getAttribute("d") || "").length > 20; });
    if (!paths.length) return;
    const segs = paths.map(function (p) {
      const ch = p.closest(".ytp-heat-map-chapter") || p.parentElement;
      return {
        d: p.getAttribute("d"),
        width: ch ? parseFloat(ch.style.width) || 0 : 0,
        left: ch && ch.style.left !== "" ? parseFloat(ch.style.left) : undefined
      };
    });
    // after clicking to a new song the old song's graph can linger for a moment: wait for it to change
    const sig = segs.map(function (x) { return x.d.length + ":" + x.d.slice(0, 60) + x.d.slice(-60); }).join("|");
    if (lastHeat.vid && lastHeat.vid !== sess.id && lastHeat.sig === sig && sess.heatTries < 8) return;
    sess.heat = Core.parseHeatmap(segs, sess.n);
    lastHeat = { vid: sess.id, sig: sig };
    log("heatmap read: " + (sess.heat ? "ok" : "flat / unusable") + " (" + segs.length + " part" + (segs.length > 1 ? "s" : "") + ")");
    // heatmap arrived after the options were already decided: decide again
    if (sess.heat && sess.presented && !sess.jumped) { sess.presented = false; }
  }
  function sources() { return { local: S.local, global: S.global, heat: S.heat }; }
  function hasLocal() { return !!(S && S.local && S.local.n.some(function (x) { return x > 0; })); }

  // ---------- UI ----------
  let ui = null, hoverTimer = null;
  function ensureUI() {
    const host = document.fullscreenElement || document.body;
    if (ui && ui.root.parentNode === host) return ui;
    if (ui) { host.appendChild(ui.root); return ui; }
    const root = document.createElement("div");
    root.className = "hj-root";
    root.innerHTML =
      '<div class="hj-panel" hidden>' +
        '<div class="hj-head"><span>Hooks in this song <em class="hj-ver"></em></span><button class="hj-x" title="Hide">✕</button></div>' +
        '<div class="hj-opts"></div>' +
        '<div class="hj-empty">Nothing learned yet. Tap 🔥 at the best part.</div>' +
        '<button class="hj-reset" title="Forget your own feedback for this song">↺ Reset my feedback for this song</button>' +
      '</div>' +
      '<div class="hj-toast" hidden></div>' +
      '<div class="hj-fire-wrap"><button class="hj-fire" title="Mark this part as the hook">🔥</button></div>';
    host.appendChild(root);
    ui = {
      root: root,
      panel: root.querySelector(".hj-panel"),
      opts: root.querySelector(".hj-opts"),
      empty: root.querySelector(".hj-empty"),
      reset: root.querySelector(".hj-reset"),
      x: root.querySelector(".hj-x"),
      toast: root.querySelector(".hj-toast"),
      fireWrap: root.querySelector(".hj-fire-wrap"),
      fire: root.querySelector(".hj-fire"),
      hover: false
    };
    try { root.querySelector(".hj-ver").textContent = "v" + chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }
    ui.fire.addEventListener("click", onFire);
    ui.x.addEventListener("click", function () { if (S) S.panelAuto = false; ui.hover = false; renderPanel(); });
    ui.reset.addEventListener("click", resetSong);
    // hover the fire button (or the open panel) to see options; small delay so you can move between them
    [ui.fireWrap, ui.panel].forEach(function (el) {
      el.addEventListener("mouseenter", function () {
        clearTimeout(hoverTimer);
        if (!ui.hover) { ui.hover = true; if (S && S.n) refreshOptions(false); renderPanel(); }
      });
      el.addEventListener("mouseleave", function () {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () { ui.hover = false; renderPanel(); }, 350);
      });
    });
    return ui;
  }

  function available() { return ORDER.filter(function (k) { return S && S.picks[k]; }); }
  function preferred() { const a = available(); return a.length ? S.picks[a[0]] : null; }

  // Three rows (You / Community / Heatmap) always; a source with no data is shown greyed out.
  // Reset is only offered on hover.
  function renderPanel() {
    if (!ui) return;
    const open = !!S && S.n > 0 && (ui.hover || (S.panelAuto && available().length > 0));
    ui.panel.hidden = !open;
    ui.panel.classList.toggle("hj-auto", open && !ui.hover);
    if (!open) return;
    ui.panel.classList.remove("hj-minimize");
    ui.opts.textContent = "";
    const best = preferred();
    ORDER.forEach(function (k) {
      const o = S.picks[k];
      const b = document.createElement("button");
      b.className = "hj-opt" + (o && o === best ? " hj-best" : "");
      b.innerHTML = '<span class="hj-bolt">⚡</span><span class="hj-time"></span><span class="hj-src"></span>' +
        (o && o === best ? '<span class="hj-star" title="Auto-skip would pick this">★</span>' : "");
      b.querySelector(".hj-src").textContent = SOURCE_LABEL[k];
      if (o) {
        const t = jumpTime(o);
        b.querySelector(".hj-time").textContent = fmt(t);
        b.title = "Jump to " + fmt(t) + " (" + SOURCE_LABEL[k].toLowerCase() + " pick)";
        b.addEventListener("click", function () { doJump(o); });
      } else {
        b.disabled = true;
        b.querySelector(".hj-time").textContent = "–";
        b.querySelector(".hj-src").textContent = SOURCE_LABEL[k] + " · " + MISSING[k];
      }
      ui.opts.appendChild(b);
    });
    ui.empty.hidden = true;
    ui.reset.hidden = !ui.hover || !hasLocal();
  }

  // After a few seconds without a click, the auto-popped panel shrinks into the 🔥 button.
  function scheduleMinimize() {
    const sess = S;
    clearTimeout(sess.minTimer);
    sess.minTimer = setTimeout(function () {
      if (sess !== S || !ui || !S.panelAuto) return;
      if (ui.hover) { scheduleMinimize(); return; }
      ui.panel.classList.add("hj-minimize");
      setTimeout(function () {
        if (sess !== S) return;
        S.panelAuto = false;
        renderPanel();
        ui.fire.classList.remove("hj-ping"); void ui.fire.offsetWidth; ui.fire.classList.add("hj-ping");
      }, 380);
    }, AUTO_MINIMIZE_MS);
  }

  function toast(msg) {
    if (!ui) return;
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    ui.toast.classList.remove("hj-toast-in"); void ui.toast.offsetWidth; ui.toast.classList.add("hj-toast-in");
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () { ui.toast.hidden = true; }, 2000);
  }

  function burstFlames() {
    ui.fire.classList.remove("hj-burn"); void ui.fire.offsetWidth; ui.fire.classList.add("hj-burn");
    const ring = document.createElement("span");
    ring.className = "hj-ring";
    ui.fireWrap.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 700);
    for (let i = 0; i < 8; i++) {
      const f = document.createElement("span");
      f.className = "hj-flame";
      f.textContent = "🔥";
      f.style.setProperty("--dx", ((Math.random() * 2 - 1) * 26).toFixed(0) + "px");
      f.style.setProperty("--wave", ((Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 8)).toFixed(0) + "px");
      f.style.setProperty("--s", (0.55 + Math.random() * 0.6).toFixed(2));
      f.style.animationDelay = (i * 45) + "ms";
      ui.fireWrap.appendChild(f);
      setTimeout(function () { f.remove(); }, 1400);
    }
  }

  function onFire() {
    if (!S || !S.n || !S.local || isAd()) return;
    const t = S.video.currentTime, c = chunkOf(t);
    reward(c, R.FIRE, undefined, true);
    if (c > 0) reward(c - 1, R.FIRE * 0.5);
    burstFlames();
    toast("Marked " + fmt(t) + " as a hook");
    refreshOptions(false);
  }

  function resetSong() {
    if (!S || !S.n) return;
    try { chrome.storage.local.remove("q:" + S.id); } catch (e) { /* ignore */ }
    S.storedLocal = null;
    S.base = Core.emptyTable(S.n);
    S.local = Core.emptyTable(S.n);
    S.acc = {};                 // nothing from this listen is sent either
    S.credited = []; S.listened = [];
    S.burst = null; S.jump = null;
    refreshOptions(false);
    toast("Your feedback for this song was reset");
    log("reset local feedback for " + S.id);
  }

  function jumpTime(o) {
    // your own picks jump to the exact second you settled on
    const off = o.source === "you" && S.local && S.local.o[o.start] !== null ? S.local.o[o.start] : 0;
    return o.start * CH + off;
  }

  function refreshOptions(explore) {
    if (!S || !S.local) return;
    S.picks = Core.pickBySource(S.n, sources(), CFG, explore ? Math.random : function () { return 1; });
    renderPanel();
  }

  // Once per song, when all knowledge sources are loaded:
  //   Auto-skip ON  -> jump to You, else Community, else Heatmap
  //   Auto-skip OFF -> pop up the three options; they shrink into 🔥 after 10 s
  function maybePresent() {
    if (!S || S.presented || !S.local || !S.globalLoaded) return;
    if (Date.now() - S.startedAt < 1500) return;
    if (!IS_MUSIC && !S.heat && S.heatTries < 5) return; // give the heatmap a few seconds to render
    S.presented = true;
    refreshOptions(true);
    if (!available().length) return;
    const now = S.video.currentTime;
    if (settings.autoSkip || settings.marathon) {
      const o = preferred();
      if (o && !S.jumped && jumpTime(o) > now + 3) {
        doJump(o);
        toast("Auto-skipped to " + fmt(jumpTime(o)) + " · " + SOURCE_LABEL[o.source]);
      }
      return;
    }
    S.panelAuto = true;
    renderPanel();
    scheduleMinimize();
  }

  function doJump(o) {
    if (!S || !o) return;
    const t = jumpTime(o);
    S.burst = null;
    S.selfSeek = true;
    S.video.currentTime = t;
    S.lastT = t;
    S.jump = { chunk: o.start, t0: t, heard: 0 };
    S.hookEnd = o.end;
    S.jumped = true;
    S.panelAuto = false;
    if (ui) { ui.hover = false; renderPanel(); }
    log("jumped to " + fmt(t) + " (" + o.source + (o.explored ? ", exploring" : "") + ")");
  }

  // ---------- session lifecycle ----------
  function bind(v) {
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("seeking", onSeeking);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("ended", onEnded);
  }
  function unbind(v) {
    v.removeEventListener("timeupdate", onTime);
    v.removeEventListener("seeking", onSeeking);
    v.removeEventListener("seeked", onSeeked);
    v.removeEventListener("ended", onEnded);
  }

  function endSession() {
    if (!S) return;
    const sess = S;
    // Leaving a song early (not mid-scrub) teaches where the hook ends.
    if (!sess.ended && !sess.burst && sess.n && sess.local && sess.lastT < sess.n * CH - 10 && Date.now() - sess.startedAt > 8000) {
      const c = chunkOf(sess.lastT);
      for (let k = 1; k <= 2; k++) if (c + k < sess.n) reward(c + k, R.LEAVE);
    }
    clearTimeout(sess.saveTimer);
    saveLocal(sess);
    flush(sess);
    unbind(sess.video);
    S = null;
    if (ui) { ui.hover = false; renderPanel(); }
  }

  function startSession(id, v) {
    S = newSession(id, v);
    bind(v);
    loadLocal(S);
    loadGlobal(S);
  }

  function alive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  let ticker = null;
  function tick() {
    if (!alive()) {
      // the extension was reloaded/updated: this copy of the script is cut off, so remove it
      clearInterval(ticker);
      if (ui && ui.root) ui.root.remove();
      ui = null; S = null;
      return;
    }
    if (!settings.enabled) {
      if (S) endSession();
      if (ui) ui.root.hidden = true;
      return;
    }
    const id = videoIdFromUrl();
    const v = document.querySelector("video");
    if (S && (S.id !== id || S.video !== v)) endSession();
    if (!S && id && v) startSession(id, v);
    if (!S) { if (ui) ui.root.hidden = true; return; }
    ensureUI();
    ui.root.hidden = false;
    if (adCheck()) return;

    const dur = S.video.duration;
    const durOk = isFinite(dur) && dur > 30 && Date.now() - S.startedAt > 1500;
    if (!S.n && durOk) {
      S.n = Math.ceil(dur / CH);
      S.lastT = S.video.currentTime;
      initTables(S);
    } else if (S.n && durOk && Math.ceil(dur / CH) !== S.n && Date.now() - S.startedAt < 20000) {
      // YouTube swapped the source after navigation: re-fit to the real duration
      S.n = Math.ceil(dur / CH);
      S.base = null; S.local = null; S.global = null; S.heat = null; S.heatTries = 0;
      S.acc = {}; S.listened = []; S.credited = []; S.presented = false; S.picks = {}; S.burst = null;
      initTables(S);
    }
    if (S.n) { initTables(S); readHeatmap(S); }
  }

  // ---------- boot ----------
  try {
    chrome.storage.local.get("settings", function (res) {
      if (res && res.settings) settings = Object.assign(settings, res.settings);
    });
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === "local" && ch.settings && ch.settings.newValue) settings = Object.assign(settings, ch.settings.newValue);
    });
  } catch (e) { /* ignore */ }

  // remove UI left behind by an older version of the extension in this tab
  document.querySelectorAll(".hj-root").forEach(function (el) { el.remove(); });
  document.addEventListener("fullscreenchange", function () { if (ui) ensureUI(); });
  ticker = setInterval(tick, 1000);
  window.addEventListener("pagehide", function () { endSession(); });
})();

// HookJump content script: watches the player, turns listening behaviour into rewards,
// learns per-chunk values, and offers a "Jump to hook" button. It never skips on its own
// unless the user turns on Hook Marathon mode.
(function () {
  "use strict";
  const CFG = HOOKJUMP_CONFIG;
  const Core = HookJumpCore;
  const CH = CFG.CHUNK_SECONDS;
  const R = CFG.REWARDS;
  const IS_MUSIC = location.hostname === "music.youtube.com";

  let settings = { enabled: true, share: true, marathon: false };

  // ---- per-video session state ----
  let S = null;
  function newSession(id, video) {
    return {
      id: id, video: video, n: 0,
      local: null, global: null, heat: null,
      globalLoaded: false, heatTries: 0,
      listened: [], credited: [],
      lastT: 0, ended: false,
      seekFrom: null, seekTimer: null, selfSeek: false,
      jump: null, hook: null, prompted: false,
      pending: [], saveTimer: null, startedAt: Date.now()
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

  // ---------- rewards & learning ----------
  function reward(c, r) {
    if (!S || c < 0 || c >= S.n || !S.local) return;
    if (CFG.DEBUG) console.log("[HookJump] reward chunk " + c + " (" + c * CH + "s) r=" + r + " t=" + S.video.currentTime.toFixed(1));
    Core.update(S.local, c, r, CFG.ALPHA);
    S.pending.push({ c: c, r: Math.round(r * 100) / 100 });
    scheduleSave();
  }
  function scheduleSave() {
    if (!S || S.saveTimer) return;
    const sess = S;
    sess.saveTimer = setTimeout(function () { sess.saveTimer = null; saveLocal(sess); }, 2000);
  }
  function saveLocal(sess) {
    if (!sess || !sess.local) return;
    const obj = {};
    obj["q:" + sess.id] = { n: sess.n, q: sess.local.q.map(function (x) { return Math.round(x * 1000) / 1000; }), c: sess.local.n, t: Date.now() };
    try { chrome.storage.local.set(obj); } catch (e) { /* ignore */ }
  }
  function flush(sess) {
    sess = sess || S;
    if (!sess || !sess.pending.length) return;
    const events = sess.pending.splice(0, sess.pending.length);
    if (!settings.share) return;
    for (let i = 0; i < events.length; i += 200) {
      safeSend({ type: "submit", video: sess.id, events: events.slice(i, i + 200) });
    }
  }

  // ---------- player events ----------
  function onTime() {
    if (!S || !S.n || isAd()) return;
    const v = S.video, t = v.currentTime, d = t - S.lastT;
    if (d > 0 && d < 1.5 && !v.paused && S.seekFrom === null) {
      const c = chunkOf(S.lastT);
      S.listened[c] = (S.listened[c] || 0) + d;
      if (S.jump) S.jump.heard += d;
      if (!S.credited[c] && S.listened[c] >= CH * 0.8) {
        S.credited[c] = true;
        reward(c, R.LISTEN);
      }
    }
    if (S.seekFrom === null) S.lastT = t;

    // Evaluate the agent's last jump: 10 s of real listening after it => kept.
    if (S.jump && S.jump.heard >= 10) {
      reward(S.jump.chunk, R.JUMP_KEEP);
      S.jump = null;
    }
    // Marathon mode: hook finished -> next song.
    if (settings.marathon && S.hook && S.hook.jumped && t >= S.hook.end * CH) {
      S.hook.jumped = false;
      nextSong();
    }
    maybePrompt();
  }

  function onSeeking() {
    if (!S || !S.n || isAd()) return;
    if (S.seekFrom === null) S.seekFrom = S.lastT;
    clearTimeout(S.seekTimer);
  }
  function onSeeked() {
    if (!S || !S.n || isAd()) return;
    clearTimeout(S.seekTimer);
    const sess = S;
    sess.seekTimer = setTimeout(function () { processSeek(sess); }, 400); // debounce scrubbing
  }
  function processSeek(sess) {
    if (sess !== S || sess.seekFrom === null) return;
    const from = sess.seekFrom, to = sess.video.currentTime;
    sess.seekFrom = null;
    sess.lastT = to;
    if (sess.selfSeek) { sess.selfSeek = false; return; } // our own jump

    // The user moved away from the agent's jump quickly => rejected.
    if (sess.jump) {
      reward(sess.jump.chunk, R.JUMP_REJECT);
      for (let k = 1; k < CFG.HOOK_CHUNKS; k++) reward(sess.jump.chunk + k, R.JUMP_REJECT * 0.67);
      sess.jump = null;
    }
    const cf = chunkOf(from), ct = chunkOf(to);
    if (to > from + 2) {
      // forward skip: everything strictly between is unwanted
      if ((sess.listened[cf] || 0) < CH * 0.5) reward(cf, R.LEAVE);
      for (let c = cf + 1; c < ct; c++) reward(c, R.SKIP);
    } else if (to < from - 2 && to > 2 && from - to < 120) {
      // rewind: user wants to hear this part again
      reward(ct, R.REPLAY);
      if (ct + 1 < sess.n) reward(ct + 1, R.REPLAY * 0.5);
    }
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
        sess.storedLocal = st ? { q: st.q, n: st.c } : null;
        sess.localLoaded = true;
        initTablesIfReady(sess);
      });
    } catch (e) { sess.localLoaded = true; }
  }
  function loadGlobal(sess) {
    if (!settings.share) { sess.globalLoaded = true; return; }
    safeSend({ type: "getScores", video: sess.id }, function (rows) {
      if (sess !== S) return;
      sess.globalRows = Array.isArray(rows) ? rows : [];
      sess.globalLoaded = true;
      initTablesIfReady(sess);
    });
    setTimeout(function () { if (!sess.globalLoaded) { sess.globalLoaded = true; initTablesIfReady(sess); } }, 5000);
  }
  function initTablesIfReady(sess) {
    if (!sess.n) return;
    if (!sess.local && sess.localLoaded) sess.local = Core.fitTable(sess.storedLocal, sess.n);
    if (!sess.global && sess.globalRows) {
      const g = Core.emptyTable(sess.n);
      sess.globalRows.forEach(function (r) {
        if (r.chunk >= 0 && r.chunk < sess.n) { g.q[r.chunk] = Number(r.q) || 0; g.n[r.chunk] = Number(r.n) || 0; }
      });
      sess.global = g;
    }
  }
  function readHeatmap(sess) {
    if (IS_MUSIC || sess.heat || sess.heatTries > 20) return;
    sess.heatTries++;
    const paths = Array.from(document.querySelectorAll(".ytp-heat-map-path"));
    if (!paths.length) return;
    const segs = paths.map(function (p) {
      const ch = p.closest(".ytp-heat-map-chapter") || p.parentElement;
      return {
        d: p.getAttribute("d") || "",
        width: ch ? parseFloat(ch.style.width) || 0 : 0,
        left: ch && ch.style.left !== "" ? parseFloat(ch.style.left) : undefined
      };
    });
    sess.heat = Core.parseHeatmap(segs, sess.n);
  }

  // ---------- UI ----------
  let ui = null;
  function ensureUI() {
    if (ui && document.body.contains(ui.root)) return ui;
    const root = document.createElement("div");
    root.className = "hj-root";
    root.innerHTML =
      '<button class="hj-jump" hidden><span class="hj-bolt">⚡</span><span class="hj-text"></span><span class="hj-sub"></span></button>' +
      '<div class="hj-row"><button class="hj-fire" title="This part is the best part">🔥</button><button class="hj-x" title="Hide suggestion" hidden>✕</button></div>';
    document.body.appendChild(root);
    ui = {
      root: root,
      jump: root.querySelector(".hj-jump"),
      text: root.querySelector(".hj-text"),
      sub: root.querySelector(".hj-sub"),
      fire: root.querySelector(".hj-fire"),
      x: root.querySelector(".hj-x")
    };
    ui.jump.addEventListener("click", doJump);
    ui.x.addEventListener("click", hidePrompt);
    ui.fire.addEventListener("click", function () {
      if (!S || !S.n) return;
      const c = chunkOf(S.video.currentTime);
      reward(c, R.FIRE);
      if (c > 0) reward(c - 1, R.FIRE * 0.5);
      ui.fire.classList.remove("hj-pop"); void ui.fire.offsetWidth; ui.fire.classList.add("hj-pop");
    });
    return ui;
  }
  function showUI(on) {
    const u = ensureUI();
    u.root.hidden = !on;
  }
  function hidePrompt() {
    if (!ui) return;
    ui.jump.hidden = true; ui.x.hidden = true;
  }

  function maybePrompt() {
    if (!S || S.prompted || !S.local || !S.globalLoaded) return;
    if (Date.now() - S.startedAt < 1500) return;
    if (!IS_MUSIC && !S.heat && S.heatTries < 5) return; // give the heatmap a few seconds to render
    const src = { local: S.local, global: S.global, heat: S.heat };
    const hook = Core.pickHook(S.n, src, CFG);
    S.prompted = true;
    if (!hook) return;
    const t = hook.start * CH;
    if (t < 8 || S.video.currentTime >= t - 3) return; // already there / hook is at the very start
    S.hook = { start: hook.start, end: hook.end, explored: hook.explored, jumped: false };

    if (settings.marathon) { doJump(); return; }

    const u = ensureUI();
    const parts = [];
    const lc = S.local.n.reduce(function (a, b) { return a + b; }, 0);
    const gc = S.global ? S.global.n.reduce(function (a, b) { return a + b; }, 0) : 0;
    if (lc) parts.push("you");
    if (gc) parts.push(gc + " community signals");
    if (S.heat) parts.push("YouTube heatmap");
    u.text.textContent = "Jump to hook · " + fmt(t);
    u.sub.textContent = "learned from " + parts.join(" + ");
    u.jump.hidden = false; u.x.hidden = false;
    const sess = S;
    setTimeout(function () { if (sess === S) hidePrompt(); }, 15000);
  }

  function doJump() {
    if (!S || !S.hook) return;
    const t = S.hook.start * CH;
    S.selfSeek = true;
    S.video.currentTime = t;
    S.jump = { chunk: S.hook.start, t0: t, heard: 0 };
    S.hook.jumped = true;
    S.lastT = t;
    hidePrompt();
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
    // Leaving a song early teaches where the hook ends.
    if (!sess.ended && sess.n && sess.local && sess.lastT < sess.n * CH - 10 && Date.now() - sess.startedAt > 8000) {
      const c = chunkOf(sess.lastT);
      for (let k = 1; k <= 2; k++) if (c + k < sess.n) reward(c + k, R.LEAVE);
    }
    clearTimeout(sess.seekTimer);
    clearTimeout(sess.saveTimer);
    saveLocal(sess);
    flush(sess);
    unbind(sess.video);
    hidePrompt();
    S = null;
  }

  function startSession(id, v) {
    S = newSession(id, v);
    bind(v);
    loadLocal(S);
    loadGlobal(S);
  }

  function tick() {
    if (!settings.enabled) {
      if (S) endSession();
      if (ui) showUI(false);
      return;
    }
    const id = videoIdFromUrl();
    const v = document.querySelector("video");
    if (S && (S.id !== id || S.video !== v)) endSession();
    if (!S && id && v) startSession(id, v);
    if (!S) { if (ui) showUI(false); return; }
    showUI(true);

    const dur = S.video.duration;
    const durOk = !isAd() && isFinite(dur) && dur > 30 && Date.now() - S.startedAt > 1500;
    if (!S.n && durOk) {
      S.n = Math.ceil(dur / CH);
      S.lastT = S.video.currentTime;
      initTablesIfReady(S);
    } else if (S.n && durOk && Math.ceil(dur / CH) !== S.n && Date.now() - S.startedAt < 20000) {
      // YouTube swapped the source after navigation: re-fit to the real duration
      S.n = Math.ceil(dur / CH);
      S.local = null; S.global = null; S.heat = null; S.heatTries = 0;
      S.listened = []; S.credited = []; S.prompted = false; S.hook = null;
      initTablesIfReady(S);
    }
    if (S.n) { initTablesIfReady(S); readHeatmap(S); }
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

  setInterval(tick, 1000);
  setInterval(function () { flush(); }, 20000);
  window.addEventListener("pagehide", function () { endSession(); });
})();

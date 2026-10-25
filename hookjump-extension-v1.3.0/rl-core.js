// HookJump RL core: pure functions (no DOM, no chrome APIs) so they can be unit tested in Node.
//
// MDP framing used in the report:
//   State  s = a 5-second chunk of a song (video_id, chunk index)
//   Action a = where to start playback (the agent's "jump to hook" suggestion),
//              plus the listener's own play / skip / replay choices that we observe
//   Reward r = derived from human feedback (listen, skip, replay, fire button, keep/reject jump)
//   Value  Q(s) = running estimate of how much listeners want chunk s
//   Update Q(s) <- Q(s) + alpha * (r - Q(s))        (incremental / bandit-style Q update)
//   Policy: epsilon-greedy; sections are scored by a 15 s window of combined value and the
//           jump goes to the most-wanted chunk inside the best window;
//           up to 3 non-overlapping sections are offered as options

var HookJumpCore = (function () {
  // q = value, n = visit count, o = learned landing offset (seconds into the chunk) or null,
  // k = how many times you deliberately picked this chunk (settled here, rewound to it, tapped 🔥, kept a jump)
  function emptyTable(n) {
    return { q: new Array(n).fill(0), n: new Array(n).fill(0), o: new Array(n).fill(null), k: new Array(n).fill(0) };
  }

  // Resize a stored table if the duration estimate changed slightly.
  function fitTable(table, n) {
    if (!table || !Array.isArray(table.q)) return emptyTable(n);
    const t = emptyTable(n);
    for (let i = 0; i < n && i < table.q.length; i++) {
      t.q[i] = Number(table.q[i]) || 0;
      t.n[i] = Number(table.n && table.n[i]) || 0;
      const o = table.o ? table.o[i] : null;
      t.o[i] = typeof o === "number" && isFinite(o) ? o : null;
      // older saves have no k: a learned landing point counts as one deliberate pick
      t.k[i] = table.k ? Number(table.k[i]) || 0 : (t.o[i] !== null ? 1 : 0);
    }
    return t;
  }

  function cloneTable(t) {
    return { q: t.q.slice(), n: t.n.slice(), o: t.o.slice(), k: t.k.slice() };
  }

  function update(table, c, r, alpha) {
    if (!table || c < 0 || c >= table.q.length) return;
    table.q[c] += alpha * (r - table.q[c]);
    table.n[c] += 1;
  }

  // Parse YouTube "Most replayed" heatmap SVG paths into a per-chunk value in [0,1].
  // segments: [{ d: "M 0.0,100.0 C 1.0,89.9 ...", left: px, width: px }]
  // Each path lives in a 1000 x 100 viewBox; smaller y = more replayed.
  function parseHeatmap(segments, nChunks, trimIntro) {
    if (!segments || !segments.length || nChunks <= 0) return null;
    let total = 0;
    segments.forEach(function (s) { total += s.width > 0 ? s.width : 0; });
    const equal = total <= 0;
    if (equal) total = segments.length;

    const samples = []; // {f: fraction of song, v: value 0..1}
    let offset = 0;
    segments.forEach(function (s) {
      const w = equal ? 1 : Math.max(0, s.width);
      const left = equal ? offset : (typeof s.left === "number" && s.left >= 0 ? s.left : offset);
      const nums = (s.d || "").match(/-?\d+(?:\.\d+)?/g);
      if (nums) {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const x = Number(nums[i]);
          const y = Number(nums[i + 1]);
          if (!isFinite(x) || !isFinite(y)) continue;
          const f = (left + (Math.min(Math.max(x, 0), 1000) / 1000) * w) / total;
          samples.push({ f: f, v: (100 - Math.min(Math.max(y, 0), 100)) / 100 });
        }
      }
      offset = left + w;
    });
    if (samples.length < 4) return null;

    const out = new Array(nChunks).fill(null);
    samples.forEach(function (p) {
      const c = Math.min(nChunks - 1, Math.max(0, Math.floor(p.f * nChunks)));
      out[c] = out[c] === null ? p.v : Math.max(out[c], p.v);
    });
    // fill gaps by nearest known neighbour
    for (let i = 0; i < nChunks; i++) {
      if (out[i] !== null) continue;
      let l = i - 1, r = i + 1, val = null;
      while (val === null && (l >= 0 || r < nChunks)) {
        if (l >= 0 && out[l] !== null) val = out[l];
        else if (r < nChunks && out[r] !== null) val = out[r];
        l--; r++;
      }
      out[i] = val === null ? 0 : val;
    }
    // Everyone starts a video at 0:00, so "Most replayed" almost always spikes at the very start.
    // Flatten that opening spike down to its first dip (at most 20% of the song) so the real
    // peaks (chorus / drop) stand out.
    if (trimIntro !== false) {
      const cap = Math.max(2, Math.floor(nChunks * 0.2));
      let i = 0;
      while (i + 1 < cap && out[i + 1] <= out[i]) i++;
      if (i > 0) {
        let floor = Infinity;
        for (let k = i; k < nChunks; k++) floor = Math.min(floor, out[k]);
        for (let k = 0; k < i; k++) out[k] = floor; // the intro gets no heatmap credit
      }
    }
    let mn = Infinity, mx = -Infinity;
    out.forEach(function (v) { mn = Math.min(mn, v); mx = Math.max(mx, v); });
    if (mx - mn < 0.05) return null; // flat = no useful signal
    return out.map(function (v) { return (v - mn) / (mx - mn); });
  }

  function sumN(t) {
    if (!t) return 0;
    return t.n.reduce(function (a, b) { return a + b; }, 0);
  }

  // Weighted contribution of each knowledge source to chunk c.
  function contributions(c, src, cfg) {
    let h = 0, g = 0, p = 0;
    if (src.heat) {
      const mean = src.heat.reduce(function (a, b) { return a + b; }, 0) / src.heat.length;
      // trust the prior less as evidence grows; your own feedback counts LOCAL_TRUST times more
      const seen = sumN(src.global) + cfg.LOCAL_TRUST * sumN(src.local);
      const fade = cfg.HEAT_FADE / (cfg.HEAT_FADE + seen);
      // the heatmap only says "this part is popular"; it never pushes other parts below zero
      h = Math.max(0, src.heat[c] - mean) * cfg.HEAT_SCALE * fade;
    }
    if (src.global && src.global.n[c] > 0) {
      g = src.global.q[c] * (src.global.n[c] / (src.global.n[c] + cfg.GLOBAL_SHRINK));
    }
    if (src.local && src.local.n[c] > 0) p = src.local.q[c];
    return { h: cfg.WEIGHTS.heat * h, g: cfg.WEIGHTS.global * g, p: cfg.WEIGHTS.personal * p };
  }

  // Combined value of chunk c from the three knowledge sources.
  function combinedValue(c, src, cfg) {
    const x = contributions(c, src, cfg);
    return x.h + x.g + x.p;
  }

  function hasSignal(src) {
    const sum = function (t) { return t ? t.n.reduce(function (a, b) { return a + b; }, 0) : 0; };
    return !!src.heat || sum(src.local) > 0 || sum(src.global) >= 3;
  }

  // Up to k distinct hook sections, best first.
  // Option 1 is chosen epsilon-greedily; later options are the next best windows that do
  // not overlap earlier ones (with a 2-chunk margin) and score >= MIN_OPTION_RATIO of the best.
  // Each option: { start, end (exclusive), score, explored, source: "you"|"community"|"heatmap" }
  function pickHooks(nChunks, src, cfg, k, rand) {
    rand = rand || Math.random;
    k = k || cfg.MAX_OPTIONS || 3;
    const H = cfg.HOOK_CHUNKS;
    if (nChunks < H + 2 || !hasSignal(src)) return [];
    const parts = [], v = [];
    for (let c = 0; c < nChunks; c++) {
      const x = contributions(c, src, cfg);
      parts.push(x); v.push(x.h + x.g + x.p);
    }
    const scores = [];
    for (let s = 0; s + H <= nChunks; s++) {
      let sc = 0;
      for (let j = 0; j < H; j++) sc += v[s + j];
      scores.push(sc);
    }
    // "You" picks only come from parts you chose on purpose, never from just letting a song play
    if (src.requireIntent && src.local && src.local.k) {
      for (let s = 0; s < scores.length; s++) {
        let deliberate = false;
        for (let j = 0; j < H; j++) if (src.local.k[s + j] > 0) deliberate = true;
        if (!deliberate) scores[s] = -Infinity;
      }
    }
    const taken = new Array(nChunks).fill(false);
    const free = function (s) { for (let j = 0; j < H; j++) if (taken[s + j]) return false; return true; };
    const out = [];
    let top = null;
    while (out.length < k) {
      let best = -1;
      for (let s = 0; s < scores.length; s++) {
        if (!free(s)) continue;
        if (best < 0 || scores[s] > scores[best]) best = s;
      }
      if (best < 0 || scores[best] <= 0) break;
      if (top === null) top = scores[best];
      else if (scores[best] < cfg.MIN_OPTION_RATIO * top) break;

      // jump to the most-wanted chunk inside the best window (where people actually seek to),
      // not to the window's first chunk
      // ...unless you have a learned landing point (where you settled and started listening)
      // in this window: then that is the start you chose, even if you tapped 🔥 a bit later.
      let start = best, explored = false;
      for (let c = best + 1; c < best + H; c++) if (v[c] > v[start]) start = c;
      if (src.local && src.local.o) {
        for (let c = Math.max(0, best - 1); c < Math.min(nChunks, best + H); c++) {
          if (src.local.o[c] !== null && src.local.o[c] !== undefined && src.local.q[c] > 0) { start = c; break; }
        }
      }
      if (out.length === 0 && rand() < cfg.EPSILON) {
        const alt = start + (rand() < 0.5 ? -1 : 1);
        if (alt >= 0 && alt < nChunks - 1) { start = alt; explored = true; }
      }
      let end = start + H;
      while (end < nChunks && end - start < cfg.MAX_HOOK_CHUNKS && v[end] > 0 && !taken[end]) end++;
      let sh = 0, sg = 0, sp = 0;
      for (let c = start; c < end; c++) { sh += parts[c].h; sg += parts[c].g; sp += parts[c].p; }
      const source = sp >= sg && sp >= sh ? "you" : (sg >= sh ? "community" : "heatmap");
      out.push({ start: start, end: end, score: scores[best], explored: explored, source: source });
      for (let c = Math.max(0, Math.min(start, best) - 2); c < Math.min(nChunks, end + 2); c++) taken[c] = true;
    }
    return out;
  }

  // One suggestion per knowledge source, each computed from that source ALONE
  // (null when the source has nothing useful for this song).
  function pickBySource(nChunks, src, cfg, rand) {
    const one = function (only, r) { const o = pickHooks(nChunks, only, cfg, 1, r); return o.length ? o[0] : null; };
    const greedy = function () { return 1; };
    return {
      // your own pick is an exact second you chose, so it is never explored away from
      you: src.local ? one({ local: src.local, requireIntent: true }, greedy) : null,
      // the crowd's pick is where the agent explores (epsilon-greedy) to refine the start
      community: src.global ? one({ global: src.global }, rand) : null,
      heatmap: src.heat ? one({ heat: src.heat }, greedy) : null // a fixed prior: no exploration
    };
  }

  // Single best hook (kept for tests / marathon mode).
  function pickHook(nChunks, src, cfg, rand) {
    const opts = pickHooks(nChunks, src, cfg, 1, rand);
    return opts.length ? opts[0] : null;
  }

  return {
    emptyTable: emptyTable,
    fitTable: fitTable,
    cloneTable: cloneTable,
    contributions: contributions,
    pickHooks: pickHooks,
    pickBySource: pickBySource,
    update: update,
    parseHeatmap: parseHeatmap,
    combinedValue: combinedValue,
    hasSignal: hasSignal,
    pickHook: pickHook
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = HookJumpCore;

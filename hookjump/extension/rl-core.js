// HookJump RL core: pure functions (no DOM, no chrome APIs) so they can be unit tested in Node.
//
// MDP framing used in the report:
//   State  s = a 5-second chunk of a song (video_id, chunk index)
//   Action a = where to start playback (the agent's "jump to hook" suggestion),
//              plus the listener's own play / skip / replay choices that we observe
//   Reward r = derived from human feedback (listen, skip, replay, fire button, keep/reject jump)
//   Value  Q(s) = running estimate of how much listeners want chunk s
//   Update Q(s) <- Q(s) + alpha * (r - Q(s))        (incremental / bandit-style Q update)
//   Policy: epsilon-greedy over start chunks, scored by a 15 s window of combined value

var HookJumpCore = (function () {
  function emptyTable(n) {
    return { q: new Array(n).fill(0), n: new Array(n).fill(0) };
  }

  // Resize a stored table if the duration estimate changed slightly.
  function fitTable(table, n) {
    if (!table || !Array.isArray(table.q)) return emptyTable(n);
    const t = emptyTable(n);
    for (let i = 0; i < n && i < table.q.length; i++) {
      t.q[i] = Number(table.q[i]) || 0;
      t.n[i] = Number(table.n[i]) || 0;
    }
    return t;
  }

  function update(table, c, r, alpha) {
    if (!table || c < 0 || c >= table.q.length) return;
    table.q[c] += alpha * (r - table.q[c]);
    table.n[c] += 1;
  }

  // Parse YouTube "Most replayed" heatmap SVG paths into a per-chunk value in [0,1].
  // segments: [{ d: "M 0.0,100.0 C 1.0,89.9 ...", left: px, width: px }]
  // Each path lives in a 1000 x 100 viewBox; smaller y = more replayed.
  function parseHeatmap(segments, nChunks) {
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
    let mn = Infinity, mx = -Infinity;
    out.forEach(function (v) { mn = Math.min(mn, v); mx = Math.max(mx, v); });
    if (mx - mn < 0.05) return null; // flat = no useful signal
    return out.map(function (v) { return (v - mn) / (mx - mn); });
  }

  function sumN(t) {
    if (!t) return 0;
    return t.n.reduce(function (a, b) { return a + b; }, 0);
  }

  // Combined value of chunk c from the three knowledge sources.
  function combinedValue(c, src, cfg) {
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
    return cfg.WEIGHTS.heat * h + cfg.WEIGHTS.global * g + cfg.WEIGHTS.personal * p;
  }

  function hasSignal(src) {
    const sum = function (t) { return t ? t.n.reduce(function (a, b) { return a + b; }, 0) : 0; };
    return !!src.heat || sum(src.local) > 0 || sum(src.global) >= 3;
  }

  // Epsilon-greedy choice of the hook start chunk.
  // Returns { start, end, explored, scores } or null when we know nothing useful.
  function pickHook(nChunks, src, cfg, rand) {
    rand = rand || Math.random;
    if (nChunks < cfg.HOOK_CHUNKS + 2 || !hasSignal(src)) return null;
    const v = [];
    for (let c = 0; c < nChunks; c++) v.push(combinedValue(c, src, cfg));
    const scores = [];
    for (let s = 0; s + cfg.HOOK_CHUNKS <= nChunks; s++) {
      let sc = 0;
      for (let k = 0; k < cfg.HOOK_CHUNKS; k++) sc += v[s + k];
      scores.push(sc);
    }
    let best = 0;
    for (let s = 1; s < scores.length; s++) if (scores[s] > scores[best]) best = s;
    if (scores[best] <= 0) return null; // nothing stands out

    let start = best, explored = false;
    if (rand() < cfg.EPSILON) {
      const alt = best + (rand() < 0.5 ? -1 : 1);
      if (alt >= 0 && alt < scores.length) { start = alt; explored = true; }
    }
    let end = start + cfg.HOOK_CHUNKS; // exclusive
    while (end < nChunks && end - start < cfg.MAX_HOOK_CHUNKS && v[end] > 0) end++;
    return { start: start, end: end, explored: explored, scores: scores, values: v };
  }

  return {
    emptyTable: emptyTable,
    fitTable: fitTable,
    update: update,
    parseHeatmap: parseHeatmap,
    combinedValue: combinedValue,
    hasSignal: hasSignal,
    pickHook: pickHook
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = HookJumpCore;

# HookJump ⚡

A browser extension that uses **reinforcement learning from human feedback** to learn the best part (the hook) of every song on YouTube / YouTube Music, and lets you jump straight to it. Everyone who installs it learns together.

## How it works (simple version)
1. Every song is cut into 5-second chunks. Each chunk is a **state**.
2. While you listen, your behaviour becomes **rewards**: listen through (+0.5), skip past (−1), rewind to it (+2), tap 🔥 (+3), leave the song (−0.5).
3. Each chunk keeps a value **Q(s)**, updated with `Q ← Q + α(r − Q)` (α = 0.2).
4. Three knowledge sources are combined: **your own Q**, the **community Q** (Supabase), and YouTube's **"Most replayed" heatmap** as a starting prior that fades as real feedback grows.
5. Next time you open a known song, a **"⚡ Jump to hook"** button appears. The agent picks the start **ε-greedily** (ε = 0.1). If you keep the jump for 10 s it gets +1.5; if you seek away it gets −1.5. Learning is always on; it never skips by itself unless you turn on *Hook marathon*.

## Project layout
```
extension/   the browser extension (Manifest V3)
  config.js     Supabase URL/key + RL hyperparameters
  rl-core.js    Q update, heatmap parser, epsilon-greedy hook picker (pure JS)
  content.js    watches the player, turns behaviour into rewards, shows the button
  background.js talks to Supabase
  popup.*       on/off toggles and stats
supabase/setup.sql   locked-down database + functions
sim/simulate.py      simulated listeners -> report graphs (plots/) + results.md
docs/privacy.html    privacy policy (host on GitHub Pages)
```

## Setup

### 1. Supabase (5 min)
1. Supabase dashboard -> your project -> **SQL Editor** -> New query -> paste all of `supabase/setup.sql` -> **Run**.
2. **Project Settings -> API**: copy the **Project URL** and the **publishable** (or legacy **anon**) key.
3. Put them in `extension/config.js`. Never use the `service_role` / secret key.
4. Free projects pause after ~1 week idle. Open the dashboard and restore it before a demo if needed.

### 2. Try it locally (Chrome / Edge / Brave)
1. Go to `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** -> select the `extension` folder.
3. Play a song on YouTube. Skip the boring parts, rewind to the good part, tap 🔥.
4. Open the same song again: the **⚡ Jump to hook** button appears.

### 3. Report graphs
```
pip install numpy matplotlib
python sim/simulate.py
```

### 4. Publish free on Microsoft Edge Add-ons (hidden listing)
1. Register at Partner Center as an Edge extension developer (free).
2. Zip the **contents** of `extension/` (manifest.json at the zip root).
3. Submit -> Visibility: **Hidden** -> share the listing URL. Review takes up to 7 business days.
4. Privacy policy URL: enable GitHub Pages on this repo and use `.../docs/privacy.html`.
5. Chrome users: download the zip from GitHub Releases and **Load unpacked**. If you pay the one-time $5 Chrome Web Store fee later, the same zip works there unchanged.

## Limitations
- A song is unknown until someone has played it with the extension on.
- Passive listening (no skips or rewinds) gives a weak signal.
- YouTube can change the heatmap's page structure; the extension then simply learns from users only.
- Install IDs are random, so a determined spammer could rotate them; the rate limit and reward clamping reduce the damage.

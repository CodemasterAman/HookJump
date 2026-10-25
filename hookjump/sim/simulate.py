"""
HookJump offline experiment: simulated listeners for the report.

The agent here is a line-by-line port of extension/rl-core.js and uses the same
hyperparameters and rewards as extension/config.js, so the graphs describe the
real extension's learning rule.

Run:  python simulate.py        -> writes plots/*.png and results.md
"""
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------- same values as extension/config.js ----------------
CH = 5
ALPHA = 0.2
EPSILON = 0.1
HOOK_CHUNKS = 3
MAX_HOOK_CHUNKS = 9
R = dict(LISTEN=0.5, SKIP=-1.0, REPLAY=2.0, LEAVE=-0.5, FIRE=3.0, JUMP_KEEP=1.5, JUMP_REJECT=-1.5)
W = dict(heat=1.0, glob=1.0, personal=1.5)
HEAT_SCALE = 4.0
GLOBAL_SHRINK = 3
HEAT_FADE = 30
LOCAL_TRUST = 5

# ---------------- experiment setup ----------------
N_SONGS = 30
N_USERS = 10
ROUNDS = 20
SONGS_PER_USER_PER_ROUND = 6
SEEDS = 10
P_HEATMAP = 0.6        # share of songs that have a YouTube "most replayed" heatmap
P_HEAT_MISLEADING = 0.2  # heatmap peak is somewhere else (viral moment, intro meme...)
P_PASSIVE = 0.15       # user just lets the song play (gives no useful signal)
P_FIRE = 0.3           # user taps the fire button during the hook


class Table:
    def __init__(self, n):
        self.q = np.zeros(n)
        self.n = np.zeros(n, dtype=int)

    def update(self, c, r):
        if 0 <= c < len(self.q):
            self.q[c] += ALPHA * (r - self.q[c])
            self.n[c] += 1


class GlobalTable:
    """Server side: sum of rewards and counts; q = mean (what get_scores returns)."""
    def __init__(self, n):
        self.s = np.zeros(n)
        self.n = np.zeros(n, dtype=int)

    def add(self, c, r):
        if 0 <= c < len(self.s):
            self.s[c] += max(-3, min(3, r))
            self.n[c] += 1

    def view(self):
        t = Table(len(self.s))
        nz = self.n > 0
        t.q[nz] = self.s[nz] / self.n[nz]
        t.n = self.n.copy()
        return t


def combined_values(n, heat, glob, local):
    v = np.zeros(n)
    if heat is not None:
        seen = (glob.n.sum() if glob is not None else 0) + LOCAL_TRUST * (local.n.sum() if local is not None else 0)
        v += W["heat"] * np.maximum(0, heat - heat.mean()) * HEAT_SCALE * HEAT_FADE / (HEAT_FADE + seen)
    if glob is not None:
        g = np.where(glob.n > 0, glob.q * glob.n / (glob.n + GLOBAL_SHRINK), 0.0)
        v += W["glob"] * g
    if local is not None:
        v += W["personal"] * np.where(local.n > 0, local.q, 0.0)
    return v


def has_signal(heat, glob, local):
    return heat is not None or (local is not None and local.n.sum() > 0) or (glob is not None and glob.n.sum() >= 3)


def pick_hook(n, heat, glob, local, rng, eps=EPSILON):
    if n < HOOK_CHUNKS + 2 or not has_signal(heat, glob, local):
        return None
    v = combined_values(n, heat, glob, local)
    scores = np.convolve(v, np.ones(HOOK_CHUNKS), mode="valid")
    best = int(np.argmax(scores))
    if scores[best] <= 0:
        return None
    start = best
    if rng.random() < eps:
        alt = best + (-1 if rng.random() < 0.5 else 1)
        if 0 <= alt < len(scores):
            start = alt
    return start


# ---------------- world ----------------
def make_songs(rng):
    songs = []
    for _ in range(N_SONGS):
        n = int(rng.integers(36, 50))                    # 3:00 - 4:10
        hook_len = int(rng.integers(3, 6))               # 15-25 s hook
        h = int(rng.integers(int(0.25 * n), int(0.7 * n)))
        heat = None
        if rng.random() < P_HEATMAP:
            centre = h + 1 if rng.random() > P_HEAT_MISLEADING else int(rng.integers(2, n - 2))
            x = np.arange(n)
            heat = np.exp(-((x - centre) ** 2) / (2 * 1.5 ** 2)) + rng.normal(0, 0.12, n)
            heat = (heat - heat.min()) / (heat.max() - heat.min())
        songs.append(dict(n=n, h=h, L=hook_len, heat=heat))
    return songs


def listen(song, start, rng, emit):
    """Simulate one human listen. start=None means no jump offered.
    emit(chunk, reward) is called for every observed reward.
    Returns (agent_reward, seconds_until_hook)."""
    n, h, L = song["n"], song["h"], song["L"]
    if rng.random() < P_PASSIVE:                      # noisy user: plays from wherever, no seeking
        s = start if start is not None else 0
        for c in range(s, n):
            emit(c, R["LISTEN"])
        return 0.0, max(0, h - s) * CH

    agent_r = 0.0
    if start is not None and abs(start - h) <= 1:
        agent_r = R["JUMP_KEEP"]
        emit(start, agent_r)
        waited = max(0, h - start) * CH
        pos = start
    else:
        if start is not None:                          # rejected suggestion
            agent_r = R["JUMP_REJECT"]
            emit(start, agent_r)
            for k in range(1, HOOK_CHUNKS):
                emit(start + k, agent_r * 0.67)
            pos, waited = start, 4
        else:                                          # listens to the intro a bit
            intro = int(rng.integers(1, 4))
            for c in range(intro):
                emit(c, R["LISTEN"])
            pos, waited = intro, intro * CH
        target = max(0, h + int(rng.integers(-1, 2)))  # human seek is imprecise
        if target > pos:
            for c in range(pos + 1, target):
                emit(c, R["SKIP"])
        elif target < pos:
            emit(target, R["REPLAY"])
        waited += 3
        pos = target
    for c in range(max(pos, h), min(n, h + L)):        # hook
        emit(c, R["LISTEN"])
    if rng.random() < 0.3:
        emit(h, R["REPLAY"]); emit(h + 1, R["REPLAY"] * 0.5)
    if rng.random() < P_FIRE:
        emit(h + 1, R["FIRE"]); emit(h, R["FIRE"] * 0.5)
    if rng.random() < 0.7:                             # change song after the hook
        for k in (0, 1):
            emit(h + L + k, R["LEAVE"])
    return agent_r, waited


POLICIES = {
    "Random start": dict(kind="random"),
    "Fixed 30% heuristic": dict(kind="fixed"),
    "Heatmap only (no RL)": dict(kind="heat"),
    "Q-learning (personal)": dict(kind="rl", heat=False, glob=False),
    "Q-learning + community": dict(kind="rl", heat=False, glob=True),
    "HookJump (heatmap + community + personal)": dict(kind="rl", heat=True, glob=True),
}


def run(policy, seed, eps=EPSILON):
    rng = np.random.default_rng(seed)
    songs = make_songs(rng)
    glob = [GlobalTable(s["n"]) for s in songs]
    local = [[Table(s["n"]) for s in songs] for _ in range(N_USERS)]
    hit = np.zeros(ROUNDS); rew = np.zeros(ROUNDS); wait = np.zeros(ROUNDS); cnt = np.zeros(ROUNDS)
    for r in range(ROUNDS):
        for u in range(N_USERS):
            for si in rng.choice(N_SONGS, SONGS_PER_USER_PER_ROUND, replace=False):
                s = songs[si]
                k = policy["kind"]
                if k == "random":
                    start = int(rng.integers(0, s["n"] - HOOK_CHUNKS))
                elif k == "fixed":
                    start = int(0.3 * s["n"])
                elif k == "heat":
                    start = pick_hook(s["n"], s["heat"], None, None, rng, eps=0) if s["heat"] is not None else int(0.3 * s["n"])
                else:
                    start = pick_hook(s["n"], s["heat"] if policy["heat"] else None,
                                      glob[si].view() if policy["glob"] else None,
                                      local[u][si], rng, eps)

                def emit(c, rr, si=si, u=u):
                    if k == "rl":
                        local[u][si].update(c, rr)
                        glob[si].add(c, rr)
                ar, w = listen(s, start, rng, emit)
                hit[r] += start is not None and abs(start - s["h"]) <= 1
                rew[r] += ar; wait[r] += w; cnt[r] += 1
    return hit / cnt, rew / cnt, wait / cnt, songs, glob, local


def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plots")
    os.makedirs(out, exist_ok=True)
    plt.rcParams.update({"font.family": "serif", "font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    colors = ["#9e9e9e", "#bdbdbd", "#f2a65a", "#7aa6d6", "#3b6fb6", "#d6336c"]
    x = np.arange(1, ROUNDS + 1)

    results = {}
    for name, pol in POLICIES.items():
        runs = [run(pol, seed) for seed in range(SEEDS)]
        results[name] = dict(hit=np.mean([r[0] for r in runs], 0), rew=np.mean([r[1] for r in runs], 0),
                             wait=np.mean([r[2] for r in runs], 0), example=runs[0])
        print(f"{name:45s} round1 hit={results[name]['hit'][0]:.2f} final hit={results[name]['hit'][-5:].mean():.2f} wait={results[name]['wait'][-5:].mean():.1f}s")

    # 1. hook hit-rate learning curve
    fig, ax = plt.subplots(figsize=(6.4, 4.4))
    for (name, res), c in zip(results.items(), colors):
        ax.plot(x, res["hit"] * 100, label=name, color=c, lw=2.2 if "HookJump" in name else 1.5)
    ax.set_xlabel("Round (each user plays 6 songs per round)"); ax.set_ylabel("Hook hit rate (%)")
    ax.set_title("Jump suggestion lands on the true hook"); ax.set_ylim(0, 100)
    ax.legend(fontsize=7.5, frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2)
    fig.tight_layout(); fig.savefig(os.path.join(out, "1_hook_hit_rate.png"), dpi=200); plt.close(fig)

    # 2. reward curve
    fig, ax = plt.subplots(figsize=(6.4, 4.4))
    for (name, res), c in zip(results.items(), colors):
        ax.plot(x, res["rew"], label=name, color=c, lw=2.2 if "HookJump" in name else 1.5)
    ax.axhline(0, color="#666", lw=0.6)
    ax.set_xlabel("Round"); ax.set_ylabel("Average agent reward per listen")
    ax.set_title("Training curve: reward from human feedback")
    ax.legend(fontsize=7.5, frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2)
    fig.tight_layout(); fig.savefig(os.path.join(out, "2_reward_curve.png"), dpi=200); plt.close(fig)

    # 3. time to hook, final rounds
    fig, ax = plt.subplots(figsize=(6.4, 3.4))
    names = list(results.keys()); vals = [results[n]["wait"][-5:].mean() for n in names]
    ax.barh(names, vals, color=colors); ax.invert_yaxis()
    for i, v in enumerate(vals):
        ax.text(v + 0.5, i, f"{v:.1f}s", va="center", fontsize=8)
    ax.set_xlabel("Seconds until the listener hears the hook (last 5 rounds)")
    ax.set_title("Time wasted before the hook"); ax.tick_params(axis="y", labelsize=8)
    fig.tight_layout(); fig.savefig(os.path.join(out, "3_time_to_hook.png"), dpi=200); plt.close(fig)

    # 4. learned value map for one song that has a heatmap
    _, _, _, songs, glob, local = results["HookJump (heatmap + community + personal)"]["example"]
    si = next(i for i, s in enumerate(songs) if s["heat"] is not None)
    s = songs[si]
    v = combined_values(s["n"], s["heat"], glob[si].view(), local[0][si])
    fig, ax = plt.subplots(figsize=(6.4, 3.8))
    t = np.arange(s["n"]) * CH
    ax.axvspan(s["h"] * CH, (s["h"] + s["L"]) * CH, color="#d6336c", alpha=0.12, label="true hook")
    ax.plot(t, glob[si].view().q, color="#3b6fb6", label="community Q(s)")
    ax.plot(t, np.maximum(0, s["heat"] - s["heat"].mean()) * HEAT_SCALE, color="#f2a65a", ls="--", label="heatmap prior (before fading)")
    ax.plot(t, v, color="#222", lw=1.8, label="combined value")
    ax.set_xlabel("Song time (s)"); ax.set_ylabel("Value"); ax.set_title("Learned value of each 5 s chunk (one song)")
    ax.legend(fontsize=8, frameon=False, ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.2))
    fig.tight_layout(); fig.savefig(os.path.join(out, "4_value_map.png"), dpi=200); plt.close(fig)

    # 5. epsilon sweep
    fig, ax = plt.subplots(figsize=(6.4, 3.4))
    eps_rows = []
    for e, c in zip([0.0, 0.1, 0.3], ["#7aa6d6", "#d6336c", "#f2a65a"]):
        runs = [run(POLICIES["HookJump (heatmap + community + personal)"], seed, eps=e) for seed in range(SEEDS)]
        h = np.mean([r[0] for r in runs], 0)
        eps_rows.append((e, h[-5:].mean()))
        ax.plot(x, h * 100, label=f"epsilon = {e}", color=c)
    ax.set_xlabel("Round"); ax.set_ylabel("Hook hit rate (%)"); ax.set_ylim(0, 100)
    ax.set_title("Exploration vs exploitation"); ax.legend(frameon=False, fontsize=8)
    fig.tight_layout(); fig.savefig(os.path.join(out, "5_epsilon_sweep.png"), dpi=200); plt.close(fig)

    # results table
    with open(os.path.join(os.path.dirname(out), "results.md"), "w") as f:
        f.write(f"# HookJump simulation results\n\n{N_SONGS} songs, {N_USERS} users, {ROUNDS} rounds, "
                f"{SONGS_PER_USER_PER_ROUND} songs/user/round, averaged over {SEEDS} seeds. "
                "Metrics are the mean of the last 5 rounds.\n\n")
        f.write("| Policy | Hit rate, round 1 (cold start) | Hook hit rate | Avg reward | Time to hook |\n|---|---|---|---|---|\n")
        for n_ in names:
            r_ = results[n_]
            f.write(f"| {n_} | {r_['hit'][0]*100:.1f}% | {r_['hit'][-5:].mean()*100:.1f}% | {r_['rew'][-5:].mean():.2f} | {r_['wait'][-5:].mean():.1f}s |\n")
        f.write("\n| Epsilon | Hook hit rate |\n|---|---|\n")
        for e, h in eps_rows:
            f.write(f"| {e} | {h*100:.1f}% |\n")
    print("wrote", out)


if __name__ == "__main__":
    main()

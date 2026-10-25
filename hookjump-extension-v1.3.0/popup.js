const DEFAULTS = { enabled: true, share: true, autoSkip: false, marathon: false };
const ids = ["enabled", "share", "autoSkip", "marathon"];

async function load() {
  const all = await chrome.storage.local.get(null);
  const settings = Object.assign({}, DEFAULTS, all.settings || {});
  ids.forEach((id) => {
    const el = document.getElementById(id);
    el.checked = !!settings[id];
    el.addEventListener("change", async () => {
      const cur = Object.assign({}, DEFAULTS, (await chrome.storage.local.get("settings")).settings || {});
      cur[id] = el.checked;
      await chrome.storage.local.set({ settings: cur });
    });
  });

  document.getElementById("local").textContent = Object.keys(all).filter((k) => k.startsWith("q:")).length;
  document.getElementById("sent").textContent = (all.stats && all.stats.sent) || 0;

  const sync = document.getElementById("sync");
  if (all.sync) {
    const ago = Math.round((Date.now() - all.sync.at) / 60000);
    sync.textContent = all.sync.ok ? `Community sync OK · ${ago} min ago` : `Sync error: ${all.sync.err}`;
    sync.classList.toggle("err", !all.sync.ok);
  } else {
    sync.textContent = "Community sync: waiting for first song";
  }

  chrome.runtime.sendMessage({ type: "communityStats" }, (res) => {
    void chrome.runtime.lastError;
    if (res && res.videos !== undefined) document.getElementById("community").textContent = res.videos;
  });
}

document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;
load();

// HookJump background service worker: the only place that talks to Supabase.
importScripts("config.js");

const CFG = HOOKJUMP_CONFIG;

function configured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(CFG.SUPABASE_URL.replace(/\/$/, "")) &&
    CFG.SUPABASE_KEY && !/YOUR-/.test(CFG.SUPABASE_KEY);
}

function headers() {
  const h = { "Content-Type": "application/json", apikey: CFG.SUPABASE_KEY };
  // Legacy anon keys are JWTs and go in Authorization too; new publishable keys only need apikey.
  if (CFG.SUPABASE_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + CFG.SUPABASE_KEY;
  return h;
}

async function rpc(name, body) {
  const res = await fetch(CFG.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(name + " " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}

async function installId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function setSync(ok, err) {
  await chrome.storage.local.set({ sync: { ok: ok, err: err || null, at: Date.now() } });
}

async function handle(msg) {
  if (!configured()) return null;
  try {
    if (msg.type === "getScores") {
      const rows = await rpc("get_scores", { p_video: msg.video });
      await setSync(true);
      return rows;
    }
    if (msg.type === "submit") {
      const n = await rpc("submit_rewards", { p_install: await installId(), p_video: msg.video, p_events: msg.events });
      const { stats } = await chrome.storage.local.get("stats");
      const s = stats || { sent: 0 };
      s.sent += Number(n) || 0;
      await chrome.storage.local.set({ stats: s });
      await setSync(true);
      return n;
    }
    if (msg.type === "communityStats") {
      const rows = await rpc("get_stats", {});
      return Array.isArray(rows) ? rows[0] : rows;
    }
  } catch (e) {
    await setSync(false, String(e && e.message || e));
    return null;
  }
  return null;
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  handle(msg).then(sendResponse);
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async function () {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: { enabled: true, share: true, autoSkip: false, marathon: false } });
  await installId();
});

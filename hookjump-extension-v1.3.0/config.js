// HookJump configuration.
// Fill these two values from Supabase: Project Settings -> API.
// The publishable / anon key is designed to be public. NEVER put the service_role / secret key here.
var HOOKJUMP_CONFIG = {
  DEBUG: false,          // true = log every reward to the page console
  SUPABASE_URL: "https://voxoockdzlpcklxnxtab.supabase.co",
  SUPABASE_KEY: "sb_publishable_sxQkfgJ-rtD_7EOEL31NGg_2J8DwGUF",

  // RL hyperparameters (kept identical to sim/simulate.py)
  CHUNK_SECONDS: 5,      // each song is split into 5 s chunks = states
  ALPHA: 0.2,            // learning rate
  EPSILON: 0.1,          // exploration rate when suggesting a hook start
  HOOK_CHUNKS: 3,        // window (3 x 5 s = 15 s) scored when picking a start
  MAX_HOOK_CHUNKS: 9,    // longest hook we will play in marathon mode (45 s)
  MAX_OPTIONS: 3,        // show up to 3 different hook sections per song
  MIN_OPTION_RATIO: 0.2, // extra sections must score at least 20% of the best one
  SETTLE_SECONDS: 6,     // a seek "burst" ends once you listen 6 s without seeking; only that landing point is learned
  REWARDS: {
    LISTEN: 0.5,         // chunk listened through naturally
    SKIP: -1.0,          // chunk jumped over (from where you left to where you settled)
    REPLAY: 2.0,         // user went back to a part they had already heard and settled there
    LAND: 2.0,           // user scrubbed around and finally settled here (the start of what they wanted)
    LEAVE: -0.5,         // user left the song right before this chunk
    FIRE: 3.0,           // user pressed the fire button on this part
    JUMP_KEEP: 1.5,      // agent's suggested jump was kept for 10 s
    JUMP_REJECT: -1.5    // user seeked away within 10 s of the agent's jump (next chunks of the window get 2/3 of it)
  },
  WEIGHTS: { heat: 1.0, global: 1.0, personal: 1.5 },
  HEAT_SCALE: 4.0,       // heatmap prior is mapped to roughly [-2, +2]
  HEAT_FADE: 30,         // heatmap weight * 30/(30 + observed signals): the prior fades as real feedback arrives
  LOCAL_TRUST: 5,        // one of your own signals fades the heatmap as much as 5 community signals
  GLOBAL_SHRINK: 3       // q_global * n/(n+3): trust community values more as n grows
};

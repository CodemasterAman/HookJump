-- HookJump community learning backend.
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
--
-- Security model:
--   * Row Level Security is ON and there are NO policies, so the public key cannot read,
--     insert, update or delete table rows directly.
--   * The extension can only call three functions. They validate input, clamp every reward
--     to [-3, 3], cap batch size, and rate-limit each install.
--   * Nothing personal is stored: a YouTube video id, a chunk number, summed rewards, and a
--     random install id (used only for rate limiting).

create table if not exists public.chunk_scores (
  video_id   text    not null,
  chunk      int     not null,
  reward_sum double precision not null default 0,
  n          int     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (video_id, chunk)
);

create table if not exists public.install_usage (
  install_id uuid        not null,
  hour       timestamptz not null,
  events     int         not null default 0,
  primary key (install_id, hour)
);

alter table public.chunk_scores  enable row level security;
alter table public.install_usage enable row level security;
revoke all on public.chunk_scores  from anon, authenticated;
revoke all on public.install_usage from anon, authenticated;

-- Submit a batch of rewards for one video. Returns how many events were accepted.
create or replace function public.submit_rewards(p_install uuid, p_video text, p_events jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_used  int;
begin
  if p_install is null then raise exception 'missing install id'; end if;
  if p_video is null or p_video !~ '^[A-Za-z0-9_-]{11}$' then raise exception 'bad video id'; end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then raise exception 'events must be an array'; end if;

  v_count := jsonb_array_length(p_events);
  if v_count = 0 then return 0; end if;
  if v_count > 200 then raise exception 'too many events in one batch'; end if;

  -- rate limit: max 1000 events per install per hour
  insert into install_usage (install_id, hour, events)
  values (p_install, date_trunc('hour', now()), v_count)
  on conflict (install_id, hour) do update set events = install_usage.events + excluded.events
  returning events into v_used;
  if v_used > 1000 then raise exception 'rate limit exceeded'; end if;

  insert into chunk_scores (video_id, chunk, reward_sum, n)
  select p_video,
         (e->>'c')::int,
         sum(greatest(-3, least(3, (e->>'r')::double precision))),
         count(*)
  from jsonb_array_elements(p_events) as e
  where jsonb_typeof(e) = 'object'
    and (e->>'c') ~ '^[0-9]{1,4}$'
    and (e->>'c')::int < 2000
    and (e->>'r') ~ '^-?[0-9]+(\.[0-9]+)?$'
  group by (e->>'c')::int
  on conflict (video_id, chunk) do update
    set reward_sum = chunk_scores.reward_sum + excluded.reward_sum,
        n          = chunk_scores.n + excluded.n,
        updated_at = now();

  return v_count;
end;
$$;

-- Community value per chunk for one video: q = average reward.
create or replace function public.get_scores(p_video text)
returns table (chunk int, q double precision, n int)
language sql
stable
security definer
set search_path = public
as $$
  select cs.chunk, cs.reward_sum / cs.n, cs.n
  from chunk_scores cs
  where cs.video_id = p_video and cs.n > 0
  order by cs.chunk;
$$;

-- Small public counters for the popup.
create or replace function public.get_stats()
returns table (videos bigint, signals bigint)
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct video_id), coalesce(sum(n), 0) from chunk_scores;
$$;

revoke all on function public.submit_rewards(uuid, text, jsonb) from public;
revoke all on function public.get_scores(text) from public;
revoke all on function public.get_stats() from public;
grant execute on function public.submit_rewards(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.get_scores(text) to anon, authenticated;
grant execute on function public.get_stats() to anon, authenticated;

-- Car Helper: run this once in Supabase (SQL Editor > New query > paste > Run). Safe to run more than once.
-- Use a NEW Supabase project, separate from Points Helper.

create extension if not exists pgcrypto;

-- 1. Invite list. Only these emails can create an account. EDIT THE EMAILS, then run.
create table if not exists public.allowlist (
  email text primary key
);
alter table public.allowlist enable row level security;  -- no policies: nobody can read it from the browser

insert into public.allowlist (email) values
  ('sosiatynski@gmail.com')
on conflict do nothing;

create or replace function public.check_allowlist()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowlist a where lower(a.email) = lower(new.email)) then
    raise exception 'not_invited';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_allowlist on auth.users;
create trigger enforce_allowlist before insert on auth.users
  for each row execute function public.check_allowlist();

-- 2. Cars. Several per person. "decoded" keeps everything NHTSA's VIN decoder returned that we show.
create table if not exists public.cars (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vin text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  nickname text not null default '' check (length(nickname) <= 40),
  year int check (year between 1950 and 2100),
  make text not null default '' check (length(make) <= 40),
  model text not null default '' check (length(model) <= 60),   -- also used for the recall lookup; edit it if recalls don't match
  trim text not null default '' check (length(trim) <= 60),
  engine text not null default '' check (length(engine) <= 80),
  decoded jsonb not null default '{}'::jsonb check (pg_column_size(decoded) < 8000),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cars_user_idx on public.cars (user_id);

-- 3. Odometer readings. The app works out miles per day from these to predict mileage-based due dates.
create table if not exists public.odometer_readings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  car_id uuid not null references public.cars(id) on delete cascade,
  day date not null,
  miles int not null check (miles between 0 and 2000000),
  source text not null default 'manual' check (source in ('manual', 'service', 'added')),
  created_at timestamptz not null default now()
);
create index if not exists odo_car_idx on public.odometer_readings (car_id, day);

-- 4. Maintenance schedule: one row per item per car. Due on whichever comes first, the months or the miles.
create table if not exists public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  car_id uuid not null references public.cars(id) on delete cascade,
  title text not null check (length(title) between 1 and 80),
  every_miles int check (every_miles between 100 and 300000),
  every_months int check (every_months between 1 and 240),
  last_day date,
  last_miles int check (last_miles between 0 and 2000000),
  notes text not null default '' check (length(notes) <= 400),
  source text not null default 'user' check (source in ('ai', 'user')),   -- 'ai' = typical interval drafted by Claude
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sched_car_idx on public.schedule_items (car_id);

-- 5. Service log.
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  car_id uuid not null references public.cars(id) on delete cascade,
  schedule_item_id uuid references public.schedule_items(id) on delete set null,
  title text not null check (length(title) between 1 and 80),
  day date not null,
  miles int check (miles between 0 and 2000000),
  shop text not null default '' check (length(shop) <= 80),
  cost numeric(10,2) check (cost between 0 and 1000000),
  notes text not null default '' check (length(notes) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists services_car_idx on public.services (car_id, day desc);

-- 6. Your status for each recall on each car.
create table if not exists public.recall_status (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  car_id uuid not null references public.cars(id) on delete cascade,
  campaign text not null check (length(campaign) <= 40),
  status text not null default 'open' check (status in ('open', 'done', 'not_mine')),
  updated_at timestamptz not null default now(),
  primary key (car_id, campaign)
);

-- Row-level security: everyone sees and changes only their own rows,
-- and can only attach rows to their own cars.
alter table public.cars enable row level security;
alter table public.odometer_readings enable row level security;
alter table public.schedule_items enable row level security;
alter table public.services enable row level security;
alter table public.recall_status enable row level security;

create or replace function public.owns_car(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cars c where c.id = cid and c.user_id = auth.uid());
$$;
grant execute on function public.owns_car(uuid) to authenticated;

drop policy if exists "own cars" on public.cars;
create policy "own cars" on public.cars for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own odometer" on public.odometer_readings;
create policy "own odometer" on public.odometer_readings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.owns_car(car_id));

drop policy if exists "own schedule" on public.schedule_items;
create policy "own schedule" on public.schedule_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.owns_car(car_id));

drop policy if exists "own services" on public.services;
create policy "own services" on public.services for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.owns_car(car_id));

drop policy if exists "own recall status" on public.recall_status;
create policy "own recall status" on public.recall_status for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.owns_car(car_id));

-- 7. Shared recall list from NHTSA, saved per make + model + year. Signed-in users read; only the server writes.
create table if not exists public.recall_sets (
  vkey text primary key,              -- e.g. "HONDA|CIVIC|2019"
  items jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);
alter table public.recall_sets enable row level security;
drop policy if exists "read recalls" on public.recall_sets;
create policy "read recalls" on public.recall_sets for select to authenticated using (true);

-- 8. Daily AI question counter, so nobody can run up your API credits.
create table if not exists public.ask_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);
alter table public.ask_usage enable row level security;  -- no policies: server only

create or replace function public.bump_ask(uid uuid, lim int)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.ask_usage (user_id, day, count)
  values (uid, (now() at time zone 'America/Chicago')::date, 1)
  on conflict (user_id, day) do update set count = public.ask_usage.count + 1
  returning count into n;
  return n;
end;
$$;
revoke execute on function public.bump_ask(uuid, int) from public, anon, authenticated;

-- 9. Phone notifications. One row per phone or browser that turned reminders on.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own push subscriptions" on public.push_subscriptions;
create policy "own push subscriptions" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Reminders already sent, so the daily job never sends the same one twice. Server only.
create table if not exists public.reminders_sent (
  user_id uuid not null references auth.users(id) on delete cascade,
  tag text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, tag)
);
alter table public.reminders_sent enable row level security;

-- 10. Usage stats. The app logs which features are used, never car details, photos or question text.
create table if not exists public.events (
  id bigserial primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (name in ('app_open','tab_view','ask','car_added','service_logged','odometer','recall_marked','reminders_on','reminders_off','ccd_click')),
  props jsonb not null default '{}'::jsonb check (pg_column_size(props) < 1000),
  created_at timestamptz not null default now()
);
create index if not exists events_created_idx on public.events (created_at);
alter table public.events enable row level security;
drop policy if exists "log own events" on public.events;
create policy "log own events" on public.events for insert to authenticated with check (user_id = auth.uid());

-- Who can see Stats. Only changeable here in the SQL Editor. Edit the email if yours differs.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.admins enable row level security;
-- Run this line again after you've signed in once (your account doesn't exist until then):
insert into public.admins (user_id)
select id from auth.users where lower(email) = lower('sosiatynski@gmail.com')
on conflict do nothing;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
grant execute on function public.is_admin() to authenticated;

create or replace function public.admin_stats(days int default 30)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare since timestamptz := now() - make_interval(days => greatest(1, least(days, 365)));
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  return jsonb_build_object(
    'days', days,
    'members', coalesce((
      select jsonb_agg(m order by m->>'last_active' desc nulls last) from (
        select jsonb_build_object(
          'email', u.email,
          'joined', u.created_at,
          'last_active', (select max(e.created_at) from public.events e where e.user_id = u.id),
          'opens', (select count(*) from public.events e where e.user_id = u.id and e.name = 'app_open' and e.created_at >= since),
          'asks', (select count(*) from public.events e where e.user_id = u.id and e.name = 'ask' and e.created_at >= since),
          'cars', (select count(*) from public.cars c where c.user_id = u.id and not c.archived),
          'services', (select count(*) from public.services s where s.user_id = u.id),
          'reminders', exists (select 1 from public.push_subscriptions p where p.user_id = u.id)
        ) as m
        from auth.users u
      ) x), '[]'::jsonb),
    'active', jsonb_build_object(
      'd1', (select count(distinct user_id) from public.events where created_at >= now() - interval '1 day'),
      'd7', (select count(distinct user_id) from public.events where created_at >= now() - interval '7 days'),
      'd30', (select count(distinct user_id) from public.events where created_at >= now() - interval '30 days')
    ),
    'features', coalesce((
      select jsonb_agg(jsonb_build_object('name', k, 'n', n) order by n desc) from (
        select case when name in ('ask','tab_view') then name || ':' || coalesce(props->>'mode', props->>'tab', '') else name end as k, count(*) as n
        from public.events where created_at >= since group by 1
      ) f), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'active', n) order by d) from (
        select (created_at at time zone 'America/Chicago')::date as d, count(distinct user_id) as n
        from public.events where created_at >= now() - interval '30 days' group by 1
      ) dd), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.admin_stats(int) from public, anon;
grant execute on function public.admin_stats(int) to authenticated;

-- 11. Table permissions. Newer Supabase projects don't grant these automatically.
--     Row-level security above still decides which rows each person can see.
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.cars, public.odometer_readings, public.schedule_items,
  public.services, public.recall_status, public.push_subscriptions to authenticated;
grant select on public.recall_sets to authenticated;
grant insert on public.events to authenticated;
grant usage, select on sequence public.events_id_seq to authenticated;
grant all on public.cars, public.odometer_readings, public.schedule_items, public.services, public.recall_status,
  public.recall_sets, public.ask_usage, public.push_subscriptions, public.reminders_sent, public.events, public.admins to service_role;
grant usage, select on sequence public.events_id_seq to service_role;
grant execute on function public.bump_ask(uuid, int) to service_role;

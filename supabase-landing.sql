-- PIZZA-BAR | מדדי דף הנחיתה
-- להריץ פעם אחת: Supabase → SQL Editor → New query → להדביק → Run
-- יוצר טבלה לאירועי ביקור אנונימיים (בלי שמות ובלי טלפונים).
-- דף הנחיתה יכול רק להוסיף שורות. רק המשתמש המחובר למערכת יכול לקרוא אותן.

create table if not exists public.pb_lp_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  visitor text not null check (char_length(visitor) between 8 and 40),
  session text not null check (char_length(session) between 8 and 40),
  type text not null check (type in ('view', 'section', 'click', 'lead', 'leave')),
  name text check (char_length(name) <= 60),
  value int check (value between 0 and 86400000),
  data jsonb check (pg_column_size(data) <= 2000)
);

create index if not exists pb_lp_events_created_at on public.pb_lp_events (created_at);

alter table public.pb_lp_events enable row level security;

-- דף הנחיתה (ללא כניסה): הוספה בלבד. הבדיקות שבטבלה מגבילות את התוכן.
drop policy if exists "landing page inserts" on public.pb_lp_events;
create policy "landing page inserts" on public.pb_lp_events
  for insert to anon, authenticated
  with check (true);

-- המערכת (משתמש מחובר): קריאה ומחיקה
drop policy if exists "owner reads" on public.pb_lp_events;
create policy "owner reads" on public.pb_lp_events
  for select to authenticated
  using (true);

drop policy if exists "owner deletes" on public.pb_lp_events;
create policy "owner deletes" on public.pb_lp_events
  for delete to authenticated
  using (true);

revoke all on public.pb_lp_events from anon;
grant insert on public.pb_lp_events to anon;
grant select, insert, delete on public.pb_lp_events to authenticated;

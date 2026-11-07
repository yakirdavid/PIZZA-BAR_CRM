-- PIZZA-BAR | הקמת מסד הנתונים ב-Supabase
-- להריץ פעם אחת: Supabase → SQL Editor → New query → להדביק → Run

create table if not exists public.pb_docs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,       -- quote | settings | image | counter
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

-- אבטחה: כל משתמש מחובר רואה ומשנה רק את הנתונים שלו; ללא כניסה – אין גישה
alter table public.pb_docs enable row level security;

drop policy if exists "own rows" on public.pb_docs;
create policy "own rows" on public.pb_docs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- מספור הצעות אוטומטי ואטומי
create or replace function public.pb_next_number(start_at int)
returns int
language plpgsql
security invoker
as $$
declare n int;
begin
  insert into public.pb_docs (user_id, kind, id, data)
  values (auth.uid(), 'counter', 'quote', to_jsonb(start_at))
  on conflict (user_id, kind, id) do update
    set data = to_jsonb(greatest((public.pb_docs.data)::int + 1, start_at)),
        updated_at = now()
  returning (data)::int into n;
  return n;
end;
$$;

grant execute on function public.pb_next_number(int) to authenticated;

-- ---------------------------------------------------------------
-- אחסון קבצי PDF לשליחה ללקוח בוואטסאפ (קישור להורדה)
-- (אפשר להריץ גם לבד – זה התוכן של supabase-storage.sql)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quotes', 'quotes', true, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "pb upload own quote pdfs" on storage.objects;
create policy "pb upload own quote pdfs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'quotes' and (storage.foldername(name))[1] = auth.uid()::text);

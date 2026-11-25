-- PIZZA-BAR | טופס בחירת מנות ללקוח + התראה בוואטסאפ
-- להריץ פעם אחת: Supabase → SQL Editor → New query → להדביק → Run
-- (בטוח להריץ שוב – למשל אחרי עדכון גרסה)
--
-- הלקוח פותח קישור עם קוד אקראי (token). הוא יכול רק לקרוא את הטופס שלו ולשלוח בחירה –
-- דרך שתי פונקציות בלבד. אין לו גישה לטבלה עצמה או לשום נתון אחר.
-- כשמתקבלת בחירה נשלחת התראה בוואטסאפ לבעל העסק (דרך CallMeBot, אם הוגדר במסך ההגדרות).

create extension if not exists pg_net;

create table if not exists public.pb_forms (
  token text primary key check (char_length(token) between 20 and 60),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  quote_id text not null,
  data jsonb not null check (pg_column_size(data) <= 20000),       -- מה שהטופס מציג (שם, מנות, כמויות)
  submission jsonb check (pg_column_size(submission) <= 6000),     -- הבחירה של הלקוח
  submitted_at timestamptz,
  loaded_at timestamptz,                                           -- נטען להזמנה – אי אפשר לשנות יותר
  created_at timestamptz not null default now()
);

create index if not exists pb_forms_quote on public.pb_forms (user_id, quote_id);

alter table public.pb_forms enable row level security;

-- המערכת (משתמש מחובר): גישה מלאה רק לטפסים שלו
drop policy if exists "own forms" on public.pb_forms;
create policy "own forms" on public.pb_forms
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.pb_forms from anon;
grant select, insert, update, delete on public.pb_forms to authenticated;

-- הלקוח: קריאת הטופס לפי הקוד שבקישור
create or replace function public.pb_get_form(form_token text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'data', f.data,
    'submission', f.submission,
    'submitted_at', f.submitted_at,
    'locked', f.loaded_at is not null
  )
  from public.pb_forms f
  where f.token = form_token;
$$;

-- הלקוח: שליחת הבחירה. מותר לעדכן עד שבעל העסק טוען אותה להזמנה.
create or replace function public.pb_submit_form(form_token text, choice jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  f public.pb_forms;
  s jsonb;
  notify jsonb;
  phone text;
  msg text;
  first_time boolean;
begin
  select * into f from public.pb_forms where token = form_token for update;
  if not found then
    raise exception 'form not found';
  end if;
  if f.loaded_at is not null then
    raise exception 'form locked';
  end if;
  if choice is null or jsonb_typeof(choice) <> 'object' or pg_column_size(choice) > 6000 then
    raise exception 'bad choice';
  end if;
  -- לא יותר מנות ממה שנקבע בהצעה
  if jsonb_array_length(coalesce(choice -> 'pizzas', '[]')) > coalesce((f.data -> 'need' ->> 'pizzas')::int, 0)
     or jsonb_array_length(coalesce(choice -> 'starters', '[]')) > coalesce((f.data -> 'need' ->> 'starters')::int, 0)
     or jsonb_array_length(coalesce(choice -> 'desserts', '[]')) > 20 then
    raise exception 'too many dishes';
  end if;

  first_time := f.submitted_at is null;
  update public.pb_forms
    set submission = jsonb_build_object(
          'pizzas', coalesce(choice -> 'pizzas', '[]'),
          'starters', coalesce(choice -> 'starters', '[]'),
          'desserts', coalesce(choice -> 'desserts', '[]'),
          'notes', left(coalesce(choice ->> 'notes', ''), 1000)
        ),
        submitted_at = now()
    where token = form_token;

  -- התראה בוואטסאפ לבעל העסק (CallMeBot). כשל בהתראה לא מבטל את השמירה.
  begin
    select d.data -> 'notify' into notify
      from public.pb_docs d
      where d.user_id = f.user_id and d.kind = 'settings' and d.id = 'main';
    phone := regexp_replace(coalesce(notify ->> 'phone', ''), '\D', '', 'g');
    if phone like '0%' then
      phone := '972' || substr(phone, 2);
    end if;
    if phone <> '' and coalesce(notify ->> 'apikey', '') <> '' then
      msg := case when first_time then '🍕 התקבלה בחירת מנות' else '🍕 עודכנה בחירת מנות' end
        || ' – ' || coalesce(f.data ->> 'name', '')
        || ', הצעה ' || coalesce(f.data ->> 'number', '')
        || coalesce(' (' || nullif(f.data ->> 'date', '') || ')', '')
        || '. פתחו את המערכת ← הזמנות כדי לטעון אותה להזמנה.';
      perform net.http_get(
        url := 'https://api.callmebot.com/whatsapp.php',
        params := jsonb_build_object('phone', phone, 'text', msg, 'apikey', notify ->> 'apikey')
      );
    end if;
  exception when others then
    null;
  end;
  return 'ok';
end;
$$;

revoke all on function public.pb_get_form(text) from public;
revoke all on function public.pb_submit_form(text, jsonb) from public;
grant execute on function public.pb_get_form(text) to anon, authenticated;
grant execute on function public.pb_submit_form(text, jsonb) to anon, authenticated;

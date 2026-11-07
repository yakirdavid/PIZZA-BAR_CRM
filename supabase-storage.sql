-- PIZZA-BAR | אחסון קבצי PDF לשליחה ללקוח בוואטסאפ
-- להריץ פעם אחת: Supabase → SQL Editor → New query → להדביק → Run
-- יוצר תיקיית אחסון "quotes". הקבצים נשמרים בשם אקראי שאי אפשר לנחש,
-- ורק מי שקיבל את הקישור יכול לפתוח אותו. רק המשתמש המחובר יכול להעלות.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quotes', 'quotes', true, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "pb upload own quote pdfs" on storage.objects;
create policy "pb upload own quote pdfs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'quotes' and (storage.foldername(name))[1] = auth.uid()::text);

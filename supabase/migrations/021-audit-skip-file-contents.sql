-- Change history: don't copy uploaded files into it.   4 Nov 2026
--
-- 018 stored a created row's whole data, and a file row's data IS the file (base64). Every upload
-- was written twice and the history table grew by the size of every file. Now a file's entry
-- records only its name. Existing history rows are left as they are (nothing is deleted).
-- Found while checking William Lee's report that uploads to studies weren't working; this is not
-- that cause (an 8 MB upload as Will still completes in ~2 s), but it doubled the work per upload.
-- ROLLBACK: re-run the function from 018.

create or replace function public.audit_items()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
declare
  r  public.items;
  ch jsonb := '{}'::jsonb;
  k  text;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.kind in ('watchFeed', 'watchConfig', 'watchVotes', 'watchKeeps') then return null; end if;
  -- An uploaded file's row holds the whole file. Record that it was added or removed, and its
  -- name, never a second copy of its contents.
  if r.kind = 'file' then
    insert into public.audit_log (actor, actor_email, workspace, item_id, kind, study_id, action, changes)
    values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), r.workspace, r.id, r.kind, null, lower(tg_op),
            jsonb_build_object(case when tg_op = 'DELETE' then '_deleted' when tg_op = 'INSERT' then '_created' else 'name' end,
                               jsonb_build_object('to', jsonb_build_object('name', r.data ->> 'name'))));
    return null;
  end if;

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(coalesce(old.data, '{}'::jsonb) || coalesce(new.data, '{}'::jsonb)) loop
      if (old.data -> k) is distinct from (new.data -> k) then
        ch := ch || jsonb_build_object(k, jsonb_build_object('from', old.data -> k, 'to', new.data -> k));
      end if;
    end loop;
    if new.workspace is distinct from old.workspace then
      ch := ch || jsonb_build_object('_lab', jsonb_build_object('from', old.workspace, 'to', new.workspace));
    end if;
    if ch = '{}'::jsonb then return null; end if;
  elsif tg_op = 'INSERT' then
    ch := jsonb_build_object('_created', jsonb_build_object('to', new.data));
  else
    ch := jsonb_build_object('_deleted', jsonb_build_object('from', old.data));
  end if;

  insert into public.audit_log (actor, actor_email, workspace, item_id, kind, study_id, action, changes)
  values (auth.uid(), nullif(auth.jwt() ->> 'email', ''), r.workspace, r.id, r.kind,
          case when r.kind = 'study' then r.id
               when (r.data ->> 'studyId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then (r.data ->> 'studyId')::uuid end,
          lower(tg_op), ch);
  return null;
end
$$;
revoke all on function public.audit_items() from public;

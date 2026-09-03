create or replace function guard_profile_writes() returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  caller      uuid    := auth.uid();
  wants_admin boolean := coalesce((new.data->>'admin')::boolean, false);
  had_admin   boolean;
  admin_count integer;
begin
  if new.kind is distinct from 'profile' then return new; end if;

  -- What the flag is RIGHT NOW, which is not the same question as what OLD holds.
  --
  -- The app saves through PostgREST's upsert, i.e. INSERT ... ON CONFLICT DO UPDATE. This is a
  -- BEFORE INSERT OR UPDATE trigger, so on that path it fires with tg_op = 'INSERT' and OLD
  -- null EVEN WHEN THE ROW ALREADY EXISTS. The original version assumed "not an UPDATE means
  -- brand new" and defaulted had_admin to false, so an existing admin re-sending their own
  -- profile looked exactly like someone granting themselves admin, and was refused. Effect:
  -- from 2026-08-25 to 2026-09-03 no admin could save their own name, position, degrees or
  -- notification address at all, and because the client logs push failures without showing
  -- them, it failed silently. Read the stored row instead of inferring from tg_op.
  if tg_op = 'UPDATE' then
    had_admin := coalesce((old.data->>'admin')::boolean, false);
  else
    select coalesce((i.data->>'admin')::boolean, false) into had_admin
      from items i where i.id = new.id and i.kind = 'profile';
    had_admin := coalesce(had_admin, false);   -- genuinely new row: no admin to have had
  end if;

  -- A client that omits the key entirely must not silently clear the flag. Treating "absent" as
  -- false would both drop somebody's admin rights and, on the next save, look like a change and
  -- get refused. Carry the stored value forward instead.
  if not (new.data ? 'admin') and had_admin then
    new.data := jsonb_set(new.data, '{admin}', 'true'::jsonb);
    wants_admin := true;
  end if;

  -- caller null == service role or SQL editor. Those are the only writers allowed to move the
  -- admin flag, which is what makes "requests only" real rather than a UI convention.
  if caller is not null then
    -- An identical re-push is a no-op; the app sends every profile on first connect. Checked
    -- against the stored row rather than OLD, for the upsert reason explained above.
    if tg_op = 'UPDATE' then
      if new.data = old.data then return new; end if;
    elsif exists (select 1 from items i where i.id = new.id and i.kind = 'profile' and i.data = new.data) then
      return new;
    end if;

    -- Admins legitimately edit other people's position and reporting line from the org chart,
    -- so they're exempt from the own-row rule. Everyone is still barred from the admin flag
    -- below, which is what keeps "requests only" intact.
    if new.id is distinct from caller and not is_app_admin(caller) then
      raise exception 'Only an admin can change someone else''s profile';
    end if;
    if wants_admin is distinct from had_admin then
      raise exception 'Admin rights are granted by request and approval, not directly';
    end if;
    return new;
  end if;

  -- Service role: keep app_admins in step with the flag being set.
  if wants_admin then
    insert into app_admins (user_id) values (new.id) on conflict (user_id) do nothing;
  elsif had_admin then
    delete from app_admins where user_id = new.id;
    select count(*) into admin_count from app_admins;
    if admin_count = 0 then
      raise exception 'Cannot remove the last admin — promote someone else first';
    end if;
  end if;
  return new;
end;
$$;

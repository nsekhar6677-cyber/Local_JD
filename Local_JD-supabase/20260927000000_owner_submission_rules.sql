-- Owners can only submit a payment (paid = true) when it has an amount above
-- zero, a payment mode and an uploaded screenshot. Admin entries are unchanged.
create or replace function public.jdb_save_payment(p_token text, p_flat_id text, p_month text, p_data jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; ex jdb.payments; d jsonb; path text;
begin
  s := jdb.require_session(p_token);
  if p_month !~ '^\d{4}-\d{2}$' or coalesce(p_flat_id,'') = '' then raise exception 'BAD_INPUT'; end if;
  select * into ex from jdb.payments where flat_id = p_flat_id and month = p_month;
  d := coalesce(p_data, '{}'::jsonb) - 'screenshot' - 'screenshotPath';
  path := p_data->>'screenshotPath';

  if s.role = 'owner' then
    if s.subject <> p_flat_id then raise exception 'FORBIDDEN'; end if;
    if ex.flat_id is not null and coalesce((ex.data->>'verified')::boolean, false) then raise exception 'LOCKED_VERIFIED'; end if;
    if ex.flat_id is not null and coalesce((ex.data->>'waived')::boolean, false) then raise exception 'LOCKED_WAIVED'; end if;
    d := d || jsonb_build_object('waived', false);
    if path is not null and path not like p_flat_id || '/%' then raise exception 'FORBIDDEN'; end if;
    -- an owner's submission must include amount, payment mode and a screenshot
    if coalesce((d->>'paid')::boolean, false) and (
         coalesce(nullif(d->>'amount','')::numeric, 0) <= 0
      or coalesce(btrim(d->>'mode'), '') = ''
      or path is null) then
      raise exception 'INCOMPLETE_SUBMISSION';
    end if;
  end if;

  insert into jdb.payments(flat_id, month, data, screenshot_path, updated_at, updated_by)
  values (p_flat_id, p_month, d, path, now(), s.role || ':' || s.subject)
  on conflict (flat_id, month) do update
    set data = excluded.data, screenshot_path = excluded.screenshot_path,
        updated_at = now(), updated_by = excluded.updated_by;

  insert into jdb.payment_history(flat_id, month, old_data, new_data, changed_by)
  values (p_flat_id, p_month,
          case when ex.flat_id is null then null else ex.data || jsonb_build_object('screenshotPath', ex.screenshot_path) end,
          d || jsonb_build_object('screenshotPath', path), s.role || ':' || s.subject);
  return jsonb_build_object('ok', true);
end $$;

-- =====================================================================
-- Bulk upload (maintenance + expenses) and monthly screenshot clean-up
-- No existing table is altered. Adds functions + one log table.
-- =====================================================================

-- ---------------------------------------------------------------- owner saves keep admin-only fields
-- Imported months may carry `carryInOverride` (opening arrears), `baseOverride`
-- (that month's maintenance share) and `imported`. Owners can never set or
-- remove these; they are copied from the existing row.
create or replace function public.jdb_save_payment(p_token text, p_flat_id text, p_month text, p_data jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; ex jdb.payments; d jsonb; path text; k text;
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
    foreach k in array array['carryInOverride','baseOverride','imported'] loop
      d := d - k;
      if ex.flat_id is not null and ex.data ? k then d := d || jsonb_build_object(k, ex.data->k); end if;
    end loop;
    if path is not null and path not like p_flat_id || '/%' then raise exception 'FORBIDDEN'; end if;
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

-- ---------------------------------------------------------------- bulk maintenance import (admin, all-or-nothing)
-- p_rows: [{ "flatId": "id1", "month": "2026-08", "overwrite": false,
--            "data": { paid, amount, date, mode, verified, waived, baseOverride?, carryInOverride? } }]
create or replace function public.jdb_bulk_import_payments(p_token text, p_rows jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; r jsonb; ex jdb.payments; d jsonb; fid text; mon text;
        n_ins int := 0; n_upd int := 0; n_skip int := 0; who text;
begin
  s := jdb.require_session(p_token, 'admin');
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'BAD_INPUT'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'TOO_MANY_ROWS'; end if;
  who := 'import:' || s.subject;
  for r in select * from jsonb_array_elements(p_rows) loop
    fid := r->>'flatId'; mon := r->>'month';
    if coalesce(fid,'') = '' or coalesce(mon,'') !~ '^\d{4}-\d{2}$' then raise exception 'BAD_INPUT'; end if;
    if not exists (select 1 from jdb.flats where id = fid) then raise exception 'UNKNOWN_FLAT %', fid; end if;
    d := coalesce(r->'data', '{}'::jsonb) - 'screenshot' - 'screenshotPath';
    if coalesce(nullif(d->>'amount','')::numeric, 0) < 0 then raise exception 'BAD_AMOUNT'; end if;
    d := d || jsonb_build_object('imported', true);
    select * into ex from jdb.payments where flat_id = fid and month = mon;
    if ex.flat_id is not null and not coalesce((r->>'overwrite')::boolean, false) then
      n_skip := n_skip + 1; continue;
    end if;
    -- keep an existing screenshot when overwriting
    insert into jdb.payments(flat_id, month, data, screenshot_path, updated_at, updated_by)
    values (fid, mon, d, ex.screenshot_path, now(), who)
    on conflict (flat_id, month) do update
      set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by;
    insert into jdb.payment_history(flat_id, month, old_data, new_data, changed_by)
    values (fid, mon,
            case when ex.flat_id is null then null else ex.data || jsonb_build_object('screenshotPath', ex.screenshot_path) end,
            d || jsonb_build_object('screenshotPath', ex.screenshot_path), who);
    if ex.flat_id is null then n_ins := n_ins + 1; else n_upd := n_upd + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'inserted', n_ins, 'updated', n_upd, 'skipped', n_skip);
end $$;

-- ---------------------------------------------------------------- bulk expense import (admin, all-or-nothing, append)
-- p_items: [{ "month": "2026-08", "force": false,
--             "item": { id, category, paidOn, amount, comment, mode } }]
-- An item identical (month + category + paidOn + amount) to one already saved
-- is skipped unless "force" is true.
create or replace function public.jdb_bulk_add_expenses(p_token text, p_items jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; r jsonb; it jsonb; mon text; cur jsonb; n_add int := 0; n_skip int := 0;
begin
  s := jdb.require_session(p_token, 'admin');
  if jsonb_typeof(p_items) <> 'array' then raise exception 'BAD_INPUT'; end if;
  if jsonb_array_length(p_items) > 2000 then raise exception 'TOO_MANY_ROWS'; end if;
  for r in select * from jsonb_array_elements(p_items) loop
    mon := r->>'month'; it := r->'item';
    if coalesce(mon,'') !~ '^\d{4}-\d{2}$' or jsonb_typeof(it) <> 'object' then raise exception 'BAD_INPUT'; end if;
    if coalesce(btrim(it->>'category'),'') = '' or coalesce(it->>'paidOn','') !~ '^\d{4}-\d{2}-\d{2}$'
       or coalesce(nullif(it->>'amount','')::numeric, 0) <= 0 then raise exception 'INCOMPLETE_ITEM'; end if;
    insert into jdb.expenses(month, data) values (mon, '{"items":[],"openingOverride":null,"maintReceivedOverride":null}'::jsonb)
    on conflict (month) do nothing;
    select data into cur from jdb.expenses where month = mon for update;
    if not coalesce((r->>'force')::boolean, false) and exists (
         select 1 from jsonb_array_elements(coalesce(cur->'items','[]'::jsonb)) e
         where lower(btrim(e->>'category')) = lower(btrim(it->>'category'))
           and e->>'paidOn' = it->>'paidOn'
           and nullif(e->>'amount','')::numeric = (it->>'amount')::numeric) then
      n_skip := n_skip + 1; continue;
    end if;
    update jdb.expenses
       set data = jsonb_set(coalesce(data, '{}'::jsonb), '{items}', coalesce(data->'items','[]'::jsonb) || jsonb_build_array(it)),
           updated_at = now()
     where month = mon;
    n_add := n_add + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', n_add, 'skipped', n_skip);
end $$;

-- ---------------------------------------------------------------- screenshot clean-up
create table if not exists jdb.cleanup_log (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  dry_run boolean not null,
  current_month text not null,
  rows_cleared int not null default 0,
  files_deleted int not null default 0,
  files_failed int not null default 0,
  details jsonb
);
alter table jdb.cleanup_log enable row level security;
revoke all on jdb.cleanup_log from public, anon, authenticated;

-- Decides what to remove. Rules (dates in IST):
--   * current month: never touched
--   * previous month: removed if the payment is verified, or from the 10th day onwards
--   * older months: always removed
--   * files in the bucket that no payment points to: removed if their month is before the current month
-- Unless p_dry_run, clears payments.screenshot_path (nothing else) and returns the file paths to delete.
create or replace function public.jdb_cleanup_prepare(p_dry_run boolean default true, p_now timestamptz default now(), p_grace_day int default 10, p_max int default 2000)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare local_ts timestamp := p_now at time zone 'Asia/Kolkata';
        cur text := to_char(local_ts, 'YYYY-MM');
        prev text := to_char(local_ts - interval '1 month', 'YYYY-MM');
        dom int := extract(day from local_ts)::int;
        rows_ jsonb; orphans jsonb; n int;
begin
  with c as (
    select p.flat_id, p.month, p.screenshot_path
    from jdb.payments p
    where p.screenshot_path is not null
      and p.screenshot_path ~ '^[A-Za-z0-9_-]+/\d{4}-\d{2}/[^/]+$'
      and p.month < cur
      and split_part(p.screenshot_path, '/', 2) < cur
      and (p.month < prev or coalesce((p.data->>'verified')::boolean, false) or dom >= p_grace_day)
    order by p.month, p.flat_id
    limit p_max
  )
  select coalesce(jsonb_agg(jsonb_build_object('flatId', flat_id, 'month', month, 'path', screenshot_path)), '[]'::jsonb) into rows_ from c;

  select coalesce(jsonb_agg(o.name), '[]'::jsonb) into orphans from (
    select so.name from storage.objects so
    where so.bucket_id = 'jdb-screenshots'
      and so.name ~ '^[A-Za-z0-9_-]+/\d{4}-\d{2}/[^/]+$'
      and split_part(so.name, '/', 2) < cur
      and (split_part(so.name, '/', 2) < prev or dom >= p_grace_day)
      and not exists (select 1 from jdb.payments p where p.screenshot_path = so.name)
    order by so.name
    limit p_max
  ) o;

  if not p_dry_run then
    update jdb.payments p set screenshot_path = null, updated_at = now(), updated_by = 'cleanup'
    from jsonb_array_elements(rows_) e
    where p.flat_id = e->>'flatId' and p.month = e->>'month' and p.screenshot_path = e->>'path'
      and p.month < cur;
    get diagnostics n = row_count;
  else
    n := 0;
  end if;

  return jsonb_build_object('currentMonth', cur, 'previousMonth', prev, 'day', dom, 'dryRun', p_dry_run,
                            'rows', rows_, 'rowsCleared', n, 'orphans', orphans);
end $$;

create or replace function public.jdb_cleanup_log(p_entry jsonb) returns void
language sql volatile security definer set search_path = '' as $$
  insert into jdb.cleanup_log(dry_run, current_month, rows_cleared, files_deleted, files_failed, details)
  values (coalesce((p_entry->>'dryRun')::boolean, true), coalesce(p_entry->>'currentMonth',''),
          coalesce((p_entry->>'rowsCleared')::int, 0), coalesce((p_entry->>'filesDeleted')::int, 0),
          coalesce((p_entry->>'filesFailed')::int, 0), p_entry->'details');
$$;

-- only the clean-up Edge Function (service role) may call these
revoke execute on function public.jdb_cleanup_prepare(boolean, timestamptz, int, int) from public, anon, authenticated;
revoke execute on function public.jdb_cleanup_log(jsonb) from public, anon, authenticated;
grant execute on function public.jdb_cleanup_prepare(boolean, timestamptz, int, int) to service_role;
grant execute on function public.jdb_cleanup_log(jsonb) to service_role;

revoke execute on function public.jdb_bulk_import_payments(text, jsonb) from public;
revoke execute on function public.jdb_bulk_add_expenses(text, jsonb) from public;
grant execute on function public.jdb_bulk_import_payments(text, jsonb) to anon, authenticated;
grant execute on function public.jdb_bulk_add_expenses(text, jsonb) to anon, authenticated;

-- diagnostics now also report the last clean-up run
create or replace function public.jdb_diagnostics(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform jdb.require_session(p_token, 'admin');
  return jsonb_build_object(
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'count', c, 'shots', sc) order by month)
                        from (select month, count(*) c, count(screenshot_path) sc from jdb.payments group by month) x), '[]'::jsonb),
    'payments', (select count(*) from jdb.payments),
    'screenshots', (select count(screenshot_path) from jdb.payments),
    'history', (select count(*) from jdb.payment_history),
    'flats', (select count(*) from jdb.flats),
    'admins', (select count(*) from jdb.admins),
    'expenseMonths', (select count(*) from jdb.expenses),
    'lastPaymentChange', (select max(updated_at) from jdb.payments),
    'lastCleanup', (select jsonb_build_object('at', run_at, 'dryRun', dry_run, 'rowsCleared', rows_cleared,
                                              'filesDeleted', files_deleted, 'filesFailed', files_failed)
                    from jdb.cleanup_log order by run_at desc limit 1),
    'serverTime', now());
end $$;

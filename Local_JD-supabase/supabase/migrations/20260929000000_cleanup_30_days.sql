-- Screenshot clean-up rule changed: delete screenshots older than 30 days
-- (by upload time), whatever month they belong to. Screenshots less than
-- 30 days old are never touched. Only payments.screenshot_path is cleared.
drop function if exists public.jdb_cleanup_prepare(boolean, timestamptz, int, int);

create function public.jdb_cleanup_prepare(p_dry_run boolean default true, p_now timestamptz default now(),
                                           p_max_age_days int default 30, p_max int default 2000)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare cutoff timestamptz := p_now - make_interval(days => greatest(p_max_age_days, 1));
        rows_ jsonb; orphans jsonb; n int;
begin
  -- upload time = the storage object's created_at; if the file is already gone, the
  -- millisecond timestamp at the start of the file name (how the app names uploads)
  with refs as (
    select p.flat_id, p.month, p.screenshot_path as path,
           coalesce(so.created_at,
                    case when split_part(p.screenshot_path, '/', 3) ~ '^\d{13}'
                         then to_timestamp(substring(split_part(p.screenshot_path, '/', 3) from '^(\d{13})')::bigint / 1000.0) end) as uploaded
    from jdb.payments p
    left join storage.objects so on so.bucket_id = 'jdb-screenshots' and so.name = p.screenshot_path
    where p.screenshot_path is not null
      and p.screenshot_path ~ '^[A-Za-z0-9_-]+/\d{4}-\d{2}/[^/]+$'
  ), c as (
    select * from refs where uploaded is not null and uploaded < cutoff order by uploaded limit p_max
  )
  select coalesce(jsonb_agg(jsonb_build_object('flatId', flat_id, 'month', month, 'path', path, 'uploaded', uploaded)), '[]'::jsonb)
    into rows_ from c;

  select coalesce(jsonb_agg(o.name), '[]'::jsonb) into orphans from (
    select so.name from storage.objects so
    where so.bucket_id = 'jdb-screenshots'
      and so.name ~ '^[A-Za-z0-9_-]+/\d{4}-\d{2}/[^/]+$'
      and so.created_at < cutoff
      and not exists (select 1 from jdb.payments p where p.screenshot_path = so.name)
    order by so.created_at
    limit p_max
  ) o;

  if not p_dry_run then
    update jdb.payments p set screenshot_path = null, updated_at = now(), updated_by = 'cleanup'
    from jsonb_array_elements(rows_) e
    where p.flat_id = e->>'flatId' and p.month = e->>'month' and p.screenshot_path = e->>'path';
    get diagnostics n = row_count;
  else
    n := 0;
  end if;

  return jsonb_build_object('currentMonth', to_char(p_now at time zone 'Asia/Kolkata', 'YYYY-MM'),
                            'cutoff', cutoff, 'maxAgeDays', p_max_age_days, 'dryRun', p_dry_run,
                            'rows', rows_, 'rowsCleared', n, 'orphans', orphans);
end $$;

revoke execute on function public.jdb_cleanup_prepare(boolean, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.jdb_cleanup_prepare(boolean, timestamptz, int, int) to service_role;

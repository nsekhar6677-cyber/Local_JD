-- =====================================================================
-- Special (one-time) collections, e.g. "Lift repair contribution".
-- Kept completely separate from maintenance: two NEW tables; no existing
-- table changes. Collected amounts count as receipts in the expense report
-- for the collection's month (done in the app).
-- =====================================================================
create table if not exists jdb.collections (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  -- {title, amount, dueDate, note, closed, flats: null (all) | [flatId...], amounts: {flatId: amount}}
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists jdb.collection_payments (
  collection_id text not null references jdb.collections(id) on delete restrict,
  flat_id text not null,
  -- {paid, amount, date, mode, verified, waived}
  data jsonb not null default '{}'::jsonb,
  screenshot_path text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (collection_id, flat_id)
);
alter table jdb.collections enable row level security;
alter table jdb.collection_payments enable row level security;
revoke all on jdb.collections, jdb.collection_payments from public, anon, authenticated;

-- Admin: create or edit a collection
create or replace function public.jdb_save_collection(p_token text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; d jsonb;
begin
  s := jdb.require_session(p_token, 'admin');
  if coalesce(p->>'id','') !~ '^[A-Za-z0-9_-]{1,64}$' or coalesce(p->>'month','') !~ '^\d{4}-\d{2}$'
     or coalesce(btrim(p->>'title'),'') = '' or coalesce(nullif(p->>'amount','')::numeric, 0) <= 0 then
    raise exception 'BAD_INPUT';
  end if;
  d := p - 'id' - 'month' - 'createdAt';
  insert into jdb.collections(id, month, data) values (p->>'id', p->>'month', d)
  on conflict (id) do update set month = excluded.month, data = excluded.data, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Admin: delete a collection — only while nobody has paid towards it
create or replace function public.jdb_delete_collection(p_token text, p_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions;
begin
  s := jdb.require_session(p_token, 'admin');
  if exists (select 1 from jdb.collection_payments where collection_id = p_id
             and (coalesce((data->>'paid')::boolean,false) or coalesce((data->>'verified')::boolean,false))) then
    raise exception 'HAS_PAYMENTS';
  end if;
  delete from jdb.collection_payments where collection_id = p_id;
  delete from jdb.collections where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Save ONE flat's payment for ONE collection (same owner rules as maintenance)
create or replace function public.jdb_save_collection_payment(p_token text, p_collection_id text, p_flat_id text, p_data jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; c jdb.collections; ex jdb.collection_payments; d jsonb; path text;
begin
  s := jdb.require_session(p_token);
  select * into c from jdb.collections where id = p_collection_id;
  if not found or coalesce(p_flat_id,'') = '' then raise exception 'BAD_INPUT'; end if;
  select * into ex from jdb.collection_payments where collection_id = p_collection_id and flat_id = p_flat_id;
  d := coalesce(p_data, '{}'::jsonb) - 'screenshot' - 'screenshotPath';
  path := p_data->>'screenshotPath';

  if s.role = 'owner' then
    if s.subject <> p_flat_id then raise exception 'FORBIDDEN'; end if;
    if jsonb_typeof(c.data->'flats') = 'array' and not (c.data->'flats' ? p_flat_id) then raise exception 'FORBIDDEN'; end if;
    if coalesce((c.data->>'closed')::boolean, false) then raise exception 'COLLECTION_CLOSED'; end if;
    if ex.flat_id is not null and coalesce((ex.data->>'verified')::boolean, false) then raise exception 'LOCKED_VERIFIED'; end if;
    if ex.flat_id is not null and coalesce((ex.data->>'waived')::boolean, false) then raise exception 'LOCKED_WAIVED'; end if;
    d := d || jsonb_build_object('verified', false, 'waived', false);
    if path is not null and path not like p_flat_id || '/%' then raise exception 'FORBIDDEN'; end if;
    if coalesce((d->>'paid')::boolean, false) and (
         coalesce(nullif(d->>'amount','')::numeric, 0) <= 0
      or coalesce(btrim(d->>'mode'), '') = ''
      or path is null) then
      raise exception 'INCOMPLETE_SUBMISSION';
    end if;
  end if;

  insert into jdb.collection_payments(collection_id, flat_id, data, screenshot_path, updated_at, updated_by)
  values (p_collection_id, p_flat_id, d, path, now(), s.role || ':' || s.subject)
  on conflict (collection_id, flat_id) do update
    set data = excluded.data, screenshot_path = excluded.screenshot_path,
        updated_at = now(), updated_by = excluded.updated_by;

  -- audit trail (same table as maintenance, tagged with the collection)
  insert into jdb.payment_history(flat_id, month, old_data, new_data, changed_by)
  values (p_flat_id, c.month,
          case when ex.flat_id is null then null
               else ex.data || jsonb_build_object('screenshotPath', ex.screenshot_path, 'collectionId', p_collection_id) end,
          d || jsonb_build_object('screenshotPath', path, 'collectionId', p_collection_id), s.role || ':' || s.subject);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.jdb_load(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; r jsonb;
begin
  s := jdb.require_session(p_token);
  if s.role = 'admin' then
    r := jsonb_build_object(
      'role', 'admin', 'subject', s.subject,
      'flats', coalesce((select jsonb_agg(jsonb_build_object(
          'id', id, 'flatNo', flat_no, 'owner', owner, 'phone', phone, 'amount', amount, 'pin', pin,
          'recoveryQuestion', recovery_question, 'hasRecoveryAnswer', recovery_answer_hash is not null)
          order by sort_order, id) from jdb.flats), '[]'::jsonb),
      'payments', coalesce((select jsonb_object_agg(flat_id || ':' || month,
          data || jsonb_build_object('screenshotPath', screenshot_path)) from jdb.payments), '{}'::jsonb),
      'expenses', coalesce((select jsonb_object_agg(month, data) from jdb.expenses), '{}'::jsonb),
      'admins', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'phone', phone)
          order by sort_order, id) from jdb.admins), '[]'::jsonb),
      'collections', coalesce((select jsonb_agg(c.data || jsonb_build_object('id', c.id, 'month', c.month, 'createdAt', c.created_at)
          order by c.month, c.created_at) from jdb.collections c), '[]'::jsonb),
      'collectionPayments', coalesce((select jsonb_object_agg(collection_id || ':' || flat_id,
          data || jsonb_build_object('screenshotPath', screenshot_path)) from jdb.collection_payments), '{}'::jsonb),
      'settings', jdb.settings_json());
  else
    r := jsonb_build_object(
      'role', 'owner', 'subject', s.subject,
      -- other flats: only what the society-wide overview needs (no phone/PIN)
      'flats', coalesce((select jsonb_agg(
          case when id = s.subject then jsonb_build_object(
            'id', id, 'flatNo', flat_no, 'owner', owner, 'amount', amount,
            'recoveryQuestion', recovery_question, 'hasRecoveryAnswer', recovery_answer_hash is not null)
          else jsonb_build_object('id', id, 'flatNo', flat_no, 'owner', owner, 'amount', amount) end
          order by sort_order, id) from jdb.flats), '[]'::jsonb),
      -- own payments in full; other flats only paid/amount/verified/waived
      'payments', coalesce((select jsonb_object_agg(flat_id || ':' || month,
          case when flat_id = s.subject then data || jsonb_build_object('screenshotPath', screenshot_path)
          else jsonb_build_object('paid', coalesce(data->'paid','false'::jsonb), 'amount', data->'amount',
                                  'verified', coalesce(data->'verified','false'::jsonb), 'waived', coalesce(data->'waived','false'::jsonb)) end)
          from jdb.payments), '{}'::jsonb),
      -- society funds for the owner's overview: totals only (no category, date, mode or comments)
      'expenses', coalesce((select jsonb_object_agg(month, jsonb_build_object(
          'openingOverride', data->'openingOverride',
          'maintReceivedOverride', data->'maintReceivedOverride',
          'items', coalesce((select jsonb_agg(jsonb_build_object('amount', i->'amount'))
                             from jsonb_array_elements(coalesce(data->'items','[]'::jsonb)) i), '[]'::jsonb)))
          from jdb.expenses), '{}'::jsonb),
      'admins', '[]'::jsonb,
      -- special collections: all titles/amounts (society-wide); own payments in full, others paid/amount/waived only
      'collections', coalesce((select jsonb_agg(c.data || jsonb_build_object('id', c.id, 'month', c.month, 'createdAt', c.created_at)
          order by c.month, c.created_at) from jdb.collections c), '[]'::jsonb),
      'collectionPayments', coalesce((select jsonb_object_agg(collection_id || ':' || flat_id,
          case when flat_id = s.subject then data || jsonb_build_object('screenshotPath', screenshot_path)
          else jsonb_build_object('paid', coalesce(data->'paid','false'::jsonb), 'amount', data->'amount',
                                  'waived', coalesce(data->'waived','false'::jsonb)) end)
          from jdb.collection_payments), '{}'::jsonb),
      'settings', jdb.settings_json() - 'adminPhone');
  end if;
  return r;
end $$;


create or replace function public.jdb_restore(p_token text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; e jsonb; k text; v jsonb; i int := 0; st jsonb;
begin
  s := jdb.require_session(p_token, 'admin');
  if jsonb_typeof(p->'flats') <> 'array' or jsonb_typeof(p->'payments') <> 'object' then raise exception 'BAD_INPUT'; end if;

  delete from jdb.flats;
  for e in select * from jsonb_array_elements(p->'flats') loop
    i := i + 1;
    insert into jdb.flats(id, flat_no, owner, phone, amount, pin, recovery_question, recovery_answer_hash, sort_order)
    values (e->>'id', coalesce(e->>'flatNo',''), coalesce(e->>'owner',''), coalesce(e->>'phone',''),
            nullif(e->>'amount','')::numeric, coalesce(nullif(e->>'pin',''), (1000+i)::text),
            coalesce(e->>'recoveryQuestion',''),
            coalesce(e->>'recoveryAnswerHash',
                     case when coalesce(e->>'recoveryAnswer','') <> '' then jdb.hash(jdb.norm_answer(e->>'recoveryAnswer')) end),
            i);
  end loop;

  delete from jdb.payments;
  for k, v in select * from jsonb_each(p->'payments') loop
    insert into jdb.payments(flat_id, month, data, screenshot_path, updated_by)
    values (left(k, length(k) - position(':' in reverse(k))), right(k, position(':' in reverse(k)) - 1),
            v - 'screenshot' - 'screenshotPath', v->>'screenshotPath', 'restore:' || s.subject);
  end loop;

  delete from jdb.expenses;
  for k, v in select * from jsonb_each(coalesce(p->'expenses','{}'::jsonb)) loop
    insert into jdb.expenses(month, data) values (k, v);
  end loop;

  -- special collections (older backups without them leave collections untouched)
  if jsonb_typeof(p->'collections') = 'array' then
    delete from jdb.collection_payments;
    delete from jdb.collections;
    for e in select * from jsonb_array_elements(p->'collections') loop
      insert into jdb.collections(id, month, data)
      values (e->>'id', e->>'month', e - 'id' - 'month' - 'createdAt');
    end loop;
    for k, v in select * from jsonb_each(coalesce(p->'collectionPayments','{}'::jsonb)) loop
      insert into jdb.collection_payments(collection_id, flat_id, data, screenshot_path, updated_by)
      values (left(k, position(':' in k) - 1), substr(k, position(':' in k) + 1),
              v - 'screenshot' - 'screenshotPath', v->>'screenshotPath', 'restore:' || s.subject);
    end loop;
  end if;

  if jsonb_typeof(p->'admins') = 'array' and jsonb_array_length(p->'admins') > 0 then
    delete from jdb.admins;
    i := 0;
    for e in select * from jsonb_array_elements(p->'admins') loop
      i := i + 1;
      insert into jdb.admins(id, name, phone, password_hash, sort_order)
      values (e->>'id', coalesce(nullif(e->>'name',''),'Admin'), coalesce(e->>'phone',''),
              coalesce(e->>'passwordHash', jdb.hash(coalesce(nullif(e->>'password',''), 'admin123'))), i);
    end loop;
  end if;

  st := coalesce(p->'settings', '{}'::jsonb);
  update jdb.settings set
    society_name = coalesce(nullif(st->>'societyName',''), society_name),
    default_amount = coalesce(nullif(st->>'defaultAmount','')::numeric, default_amount),
    last_check = case when st ? 'lastCheck' then nullif(st->>'lastCheck','')::timestamptz else last_check end,
    admin_recovery_question = coalesce(st->>'adminRecoveryQuestion', admin_recovery_question),
    admin_recovery_answer_hash = coalesce(st->>'adminRecoveryAnswerHash',
        case when coalesce(st->>'adminRecoveryAnswer','') <> '' then jdb.hash(jdb.norm_answer(st->>'adminRecoveryAnswer')) end,
        admin_recovery_answer_hash),
    admin_phone = coalesce(st->>'adminPhone', admin_phone),
    updated_at = now()
  where id = 1;

  -- everyone except whoever still exists re-validates on next call
  delete from jdb.sessions where role = 'owner';
  return jsonb_build_object('ok', true);
end $$;

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
    'collections', (select count(*) from jdb.collections),
    'collectionPayments', (select count(*) from jdb.collection_payments),
    'lastPaymentChange', (select max(updated_at) from jdb.payments),
    'lastCleanup', (select jsonb_build_object('at', run_at, 'dryRun', dry_run, 'rowsCleared', rows_cleared,
                                              'filesDeleted', files_deleted, 'filesFailed', files_failed)
                    from jdb.cleanup_log order by run_at desc limit 1),
    'serverTime', now());
end $$;

create or replace function public.jdb_cleanup_prepare(p_dry_run boolean default true, p_now timestamptz default now(),
                                           p_max_age_days int default 30, p_max int default 2000)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare cutoff timestamptz := p_now - make_interval(days => greatest(p_max_age_days, 1));
        rows_ jsonb; orphans jsonb; n int; m int;
begin
  -- upload time = the storage object's created_at; if the file is already gone, the
  -- millisecond timestamp at the start of the file name (how the app names uploads)
  with allrefs as (
    select 'payment'::text as kind, null::text as collection_id, p.flat_id, p.month, p.screenshot_path
    from jdb.payments p where p.screenshot_path is not null
    union all
    select 'collection', cp.collection_id, cp.flat_id, c.month, cp.screenshot_path
    from jdb.collection_payments cp join jdb.collections c on c.id = cp.collection_id where cp.screenshot_path is not null
  ), refs as (
    select p.kind, p.collection_id, p.flat_id, p.month, p.screenshot_path as path,
           coalesce(so.created_at,
                    case when split_part(p.screenshot_path, '/', 3) ~ '^\d{13}'
                         then to_timestamp(substring(split_part(p.screenshot_path, '/', 3) from '^(\d{13})')::bigint / 1000.0) end) as uploaded
    from allrefs p
    left join storage.objects so on so.bucket_id = 'jdb-screenshots' and so.name = p.screenshot_path
    where p.screenshot_path is not null
      and p.screenshot_path ~ '^[A-Za-z0-9_-]+/\d{4}-\d{2}/[^/]+$'
  ), c as (
    select * from refs where uploaded is not null and uploaded < cutoff order by uploaded limit p_max
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'collectionId', collection_id, 'flatId', flat_id, 'month', month, 'path', path, 'uploaded', uploaded)), '[]'::jsonb)
    into rows_ from c;

  select coalesce(jsonb_agg(o.name), '[]'::jsonb) into orphans from (
    select so.name from storage.objects so
    where so.bucket_id = 'jdb-screenshots'
      and so.name ~ '^[A-Za-z0-9_-]+/\d{4}-\d{2}/[^/]+$'
      and so.created_at < cutoff
      and not exists (select 1 from jdb.payments p where p.screenshot_path = so.name)
      and not exists (select 1 from jdb.collection_payments cp where cp.screenshot_path = so.name)
    order by so.created_at
    limit p_max
  ) o;

  if not p_dry_run then
    update jdb.payments p set screenshot_path = null, updated_at = now(), updated_by = 'cleanup'
    from jsonb_array_elements(rows_) e
    where e->>'kind' = 'payment' and p.flat_id = e->>'flatId' and p.month = e->>'month' and p.screenshot_path = e->>'path';
    get diagnostics n = row_count;
    update jdb.collection_payments cp set screenshot_path = null, updated_at = now(), updated_by = 'cleanup'
    from jsonb_array_elements(rows_) e
    where e->>'kind' = 'collection' and cp.collection_id = e->>'collectionId' and cp.flat_id = e->>'flatId' and cp.screenshot_path = e->>'path';
    get diagnostics m = row_count;
    n := n + m;
  else
    n := 0;
  end if;

  return jsonb_build_object('currentMonth', to_char(p_now at time zone 'Asia/Kolkata', 'YYYY-MM'),
                            'cutoff', cutoff, 'maxAgeDays', p_max_age_days, 'dryRun', p_dry_run,
                            'rows', rows_, 'rowsCleared', n, 'orphans', orphans);
end $$;

revoke execute on function public.jdb_save_collection(text, jsonb) from public;
revoke execute on function public.jdb_delete_collection(text, text) from public;
revoke execute on function public.jdb_save_collection_payment(text, text, text, jsonb) from public;
grant execute on function public.jdb_save_collection(text, jsonb) to anon, authenticated;
grant execute on function public.jdb_delete_collection(text, text) to anon, authenticated;
grant execute on function public.jdb_save_collection_payment(text, text, text, jsonb) to anon, authenticated;
revoke execute on function public.jdb_cleanup_prepare(boolean, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.jdb_cleanup_prepare(boolean, timestamptz, int, int) to service_role;

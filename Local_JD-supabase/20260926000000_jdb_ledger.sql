-- =====================================================================
-- JD Blossom Apartment — Maintenance Tracker: Supabase backend
-- ---------------------------------------------------------------------
-- Security model
--   * All data lives in the private schema `jdb`, which is NOT exposed by
--     the Data API. anon/authenticated have no privileges on it at all.
--   * RLS is enabled on every jdb table with no policies (defence in depth:
--     even if the schema were exposed by mistake, nothing is readable).
--   * The browser only talks to a small set of `public.jdb_*` RPC
--     functions. Every function that reads/writes ledger data requires a
--     session token issued by a successful PIN/password login, and
--     enforces role rules server-side (owners only see/modify their flat).
--   * Admin passwords and all security answers are bcrypt-hashed.
--     Flat PINs stay readable to admins only, because the admin screens
--     (Flats & Access, owner login list) show and edit them.
--   * Brute-force protection: 5 failed attempts per flat/admin per
--     15 minutes locks that login for the rest of the window.
-- =====================================================================

create schema if not exists jdb;
revoke all on schema jdb from public, anon, authenticated;

-- ---------------------------------------------------------------- tables
create table if not exists jdb.settings (
  id int primary key default 1 check (id = 1),
  society_name text not null default 'JD Blossom Apartment',
  default_amount numeric not null default 2000,
  last_check timestamptz,
  admin_recovery_question text not null default '',
  admin_recovery_answer_hash text,
  admin_phone text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists jdb.flats (
  id text primary key,
  flat_no text not null,
  owner text not null default '',
  phone text not null default '',
  amount numeric,
  pin text not null,
  recovery_question text not null default '',
  recovery_answer_hash text,
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists jdb.admins (
  id text primary key,
  name text not null default 'Admin',
  phone text not null default '',
  password_hash text not null,
  sort_order int not null default 0,
  updated_at timestamptz not null default now()
);

-- one row per flat per month (flat_id deliberately has no FK: removing a
-- flat must NOT delete its past payment records)
create table if not exists jdb.payments (
  flat_id text not null,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  data jsonb not null default '{}'::jsonb,
  screenshot_path text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (flat_id, month)
);

-- append-only audit trail of every payment change (financial integrity)
create table if not exists jdb.payment_history (
  id bigint generated always as identity primary key,
  flat_id text not null,
  month text not null,
  old_data jsonb,
  new_data jsonb,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists payment_history_flat_month_idx on jdb.payment_history (flat_id, month);

create table if not exists jdb.expenses (
  month text primary key check (month ~ '^\d{4}-\d{2}$'),
  data jsonb not null default '{"items":[],"openingOverride":null,"maintReceivedOverride":null}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists jdb.sessions (
  token text primary key,
  role text not null check (role in ('admin','owner')),
  subject text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_subject_idx on jdb.sessions (role, subject);

create table if not exists jdb.login_failures (
  id bigint generated always as identity primary key,
  subject text not null,
  at timestamptz not null default now()
);
create index if not exists login_failures_subject_idx on jdb.login_failures (subject, at);

alter table jdb.settings enable row level security;
alter table jdb.flats enable row level security;
alter table jdb.admins enable row level security;
alter table jdb.payments enable row level security;
alter table jdb.payment_history enable row level security;
alter table jdb.expenses enable row level security;
alter table jdb.sessions enable row level security;
alter table jdb.login_failures enable row level security;
revoke all on all tables in schema jdb from public, anon, authenticated;

-- ---------------------------------------------------------------- helpers (private schema)
create or replace function jdb.hash(p text) returns text
language sql volatile set search_path = '' as $$
  select extensions.crypt(p, extensions.gen_salt('bf', 10))
$$;

create or replace function jdb.hash_ok(p text, h text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(h is not null and p is not null and extensions.crypt(p, h) = h, false)
$$;

create or replace function jdb.norm_answer(p text) returns text
language sql immutable set search_path = '' as $$ select lower(btrim(coalesce(p,''))) $$;

create or replace function jdb.digits(p text) returns text
language sql immutable set search_path = '' as $$ select regexp_replace(coalesce(p,''), '[^0-9]', '', 'g') $$;

create or replace function jdb.is_locked(p_subject text) returns boolean
language sql stable set search_path = '' as $$
  select count(*) >= 5 from jdb.login_failures
  where subject = p_subject and at > now() - interval '15 minutes'
$$;

create or replace function jdb.new_session(p_role text, p_subject text) returns text
language plpgsql volatile set search_path = '' as $$
declare t text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from jdb.sessions where expires_at < now();
  delete from jdb.login_failures where at < now() - interval '1 day';
  insert into jdb.sessions(token, role, subject, expires_at)
  values (t, p_role, p_subject, now() + interval '12 hours');
  return t;
end $$;

-- validates a token, slides its expiry, returns the session row
create or replace function jdb.require_session(p_token text, p_role text default null)
returns jdb.sessions
language plpgsql volatile set search_path = '' as $$
declare s jdb.sessions;
begin
  select * into s from jdb.sessions where token = p_token and expires_at > now();
  if not found then raise exception 'SESSION_EXPIRED'; end if;
  if s.role = 'admin' and not exists (select 1 from jdb.admins where id = s.subject) then
    delete from jdb.sessions where token = p_token; raise exception 'SESSION_EXPIRED';
  end if;
  if s.role = 'owner' and not exists (select 1 from jdb.flats where id = s.subject) then
    delete from jdb.sessions where token = p_token; raise exception 'SESSION_EXPIRED';
  end if;
  if p_role is not null and s.role <> p_role then raise exception 'FORBIDDEN'; end if;
  update jdb.sessions set expires_at = now() + interval '12 hours' where token = p_token;
  return s;
end $$;

create or replace function jdb.settings_json() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'societyName', s.society_name,
    'defaultAmount', s.default_amount,
    'lastCheck', s.last_check,
    'adminRecoveryQuestion', s.admin_recovery_question,
    'adminPhone', s.admin_phone)
  from jdb.settings s where s.id = 1
$$;

-- ---------------------------------------------------------------- public RPC API
-- Login screen data: flat numbers + owner names, admin profile names (these
-- are shown in the sign-in dropdowns), society name and the admin recovery
-- question. Nothing secret.
create or replace function public.jdb_public_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'societyName', (select society_name from jdb.settings where id = 1),
    'adminRecoveryQuestion', (select admin_recovery_question from jdb.settings where id = 1),
    'flats', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'flatNo', flat_no, 'owner', owner) order by sort_order, id) from jdb.flats), '[]'::jsonb),
    'admins', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort_order, id) from jdb.admins), '[]'::jsonb)
  )
$$;

create or replace function public.jdb_login_owner(p_flat_id text, p_pin text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare f jdb.flats; subj text := 'owner:' || coalesce(p_flat_id,'');
begin
  if jdb.is_locked(subj) then return jsonb_build_object('ok', false, 'error', 'LOCKED'); end if;
  select * into f from jdb.flats where id = p_flat_id;
  if not found or coalesce(p_pin,'') = '' or f.pin <> btrim(p_pin) then
    insert into jdb.login_failures(subject) values (subj);
    return jsonb_build_object('ok', false, 'error', 'INVALID');
  end if;
  delete from jdb.login_failures where subject = subj;
  return jsonb_build_object('ok', true, 'token', jdb.new_session('owner', f.id));
end $$;

create or replace function public.jdb_login_admin(p_admin_id text, p_password text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare a jdb.admins; subj text := 'admin:' || coalesce(p_admin_id,'');
begin
  if jdb.is_locked(subj) then return jsonb_build_object('ok', false, 'error', 'LOCKED'); end if;
  select * into a from jdb.admins where id = p_admin_id;
  if not found or not jdb.hash_ok(p_password, a.password_hash) then
    insert into jdb.login_failures(subject) values (subj);
    return jsonb_build_object('ok', false, 'error', 'INVALID');
  end if;
  delete from jdb.login_failures where subject = subj;
  return jsonb_build_object('ok', true, 'token', jdb.new_session('admin', a.id));
end $$;

create or replace function public.jdb_logout(p_token text) returns void
language sql volatile security definer set search_path = '' as $$
  delete from jdb.sessions where token = p_token
$$;

-- Everything the signed-in user is allowed to see, in the exact shapes the
-- front-end already uses (flats[], payments{flatId:month}, settings{},
-- expenses{month}, admins[]).
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
      'expenses', '{}'::jsonb,
      'admins', '[]'::jsonb,
      'settings', jdb.settings_json() - 'adminPhone');
  end if;
  return r;
end $$;

-- Admin: upsert changed flats (patch semantics — only keys present are
-- changed) and delete removed ones. Changing a PIN signs that owner out.
create or replace function public.jdb_save_flats(p_token text, p_upserts jsonb, p_deletes text[] default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare e jsonb; ex jdb.flats;
begin
  perform jdb.require_session(p_token, 'admin');
  for e in select * from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) loop
    if coalesce(e->>'id','') = '' then raise exception 'BAD_INPUT'; end if;
    select * into ex from jdb.flats where id = e->>'id';
    if not found then
      insert into jdb.flats(id, flat_no, owner, phone, amount, pin, recovery_question, sort_order)
      values (e->>'id', coalesce(e->>'flatNo','New Flat'), coalesce(e->>'owner',''), coalesce(e->>'phone',''),
              nullif(e->>'amount','')::numeric, coalesce(nullif(e->>'pin',''), '0000'),
              coalesce(e->>'recoveryQuestion',''),
              coalesce((e->>'sort')::int, (select coalesce(max(sort_order),0)+1 from jdb.flats)));
    else
      update jdb.flats set
        flat_no = case when e ? 'flatNo' then coalesce(nullif(btrim(e->>'flatNo'),''), flat_no) else flat_no end,
        owner   = case when e ? 'owner' then coalesce(e->>'owner','') else owner end,
        phone   = case when e ? 'phone' then coalesce(e->>'phone','') else phone end,
        amount  = case when e ? 'amount' then nullif(e->>'amount','')::numeric else amount end,
        pin     = case when e ? 'pin' then coalesce(nullif(btrim(e->>'pin'),''), pin) else pin end,
        sort_order = case when e ? 'sort' then (e->>'sort')::int else sort_order end,
        updated_at = now()
      where id = ex.id;
      if e ? 'pin' and coalesce(nullif(btrim(e->>'pin'),''), ex.pin) <> ex.pin then
        delete from jdb.sessions where role = 'owner' and subject = ex.id;
      end if;
    end if;
  end loop;
  if p_deletes is not null and array_length(p_deletes, 1) > 0 then
    delete from jdb.flats where id = any(p_deletes);
    delete from jdb.sessions where role = 'owner' and subject = any(p_deletes);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Admin: upsert/delete admin profiles. `password` (plain) is hashed here.
create or replace function public.jdb_save_admins(p_token text, p_upserts jsonb, p_deletes text[] default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; e jsonb;
begin
  s := jdb.require_session(p_token, 'admin');
  for e in select * from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) loop
    if coalesce(e->>'id','') = '' then raise exception 'BAD_INPUT'; end if;
    if e ? 'password' and length(coalesce(e->>'password','')) < 4 then raise exception 'PASSWORD_TOO_SHORT'; end if;
    if not exists (select 1 from jdb.admins where id = e->>'id') then
      if not (e ? 'password') then raise exception 'BAD_INPUT'; end if;
      insert into jdb.admins(id, name, phone, password_hash, sort_order)
      values (e->>'id', coalesce(nullif(btrim(e->>'name'),''),'Admin'), coalesce(e->>'phone',''), jdb.hash(e->>'password'),
              coalesce((e->>'sort')::int, (select coalesce(max(sort_order),0)+1 from jdb.admins)));
    else
      update jdb.admins set
        name  = case when e ? 'name' then coalesce(nullif(btrim(e->>'name'),''),'Admin') else name end,
        phone = case when e ? 'phone' then coalesce(e->>'phone','') else phone end,
        password_hash = case when e ? 'password' then jdb.hash(e->>'password') else password_hash end,
        sort_order = case when e ? 'sort' then (e->>'sort')::int else sort_order end,
        updated_at = now()
      where id = e->>'id';
      if e ? 'password' then
        -- sign that admin out everywhere except the device making the change
        delete from jdb.sessions where role = 'admin' and subject = e->>'id' and token <> p_token;
      end if;
    end if;
  end loop;
  if p_deletes is not null and array_length(p_deletes, 1) > 0 then
    if s.subject = any(p_deletes) then raise exception 'CANNOT_DELETE_SELF'; end if;
    if (select count(*) from jdb.admins where not (id = any(p_deletes))) < 1 then raise exception 'LAST_ADMIN'; end if;
    delete from jdb.admins where id = any(p_deletes);
    delete from jdb.sessions where role = 'admin' and subject = any(p_deletes);
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.jdb_save_settings(p_token text, p_patch jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform jdb.require_session(p_token, 'admin');
  update jdb.settings set
    society_name = case when p_patch ? 'societyName' then coalesce(nullif(btrim(p_patch->>'societyName'),''),'JD Blossom Apartment') else society_name end,
    default_amount = case when p_patch ? 'defaultAmount' then coalesce(nullif(p_patch->>'defaultAmount','')::numeric, 0) else default_amount end,
    last_check = case when p_patch ? 'lastCheck' then nullif(p_patch->>'lastCheck','')::timestamptz else last_check end,
    admin_recovery_question = case when p_patch ? 'adminRecoveryQuestion' then coalesce(p_patch->>'adminRecoveryQuestion','') else admin_recovery_question end,
    admin_recovery_answer_hash = case when p_patch ? 'adminRecoveryAnswer' and coalesce(p_patch->>'adminRecoveryAnswer','') <> ''
                                      then jdb.hash(jdb.norm_answer(p_patch->>'adminRecoveryAnswer')) else admin_recovery_answer_hash end,
    admin_phone = case when p_patch ? 'adminPhone' then coalesce(p_patch->>'adminPhone','') else admin_phone end,
    updated_at = now()
  where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Admin: save one or more expense months ({ "YYYY-MM": {...}, ... })
create or replace function public.jdb_save_expenses(p_token text, p_months jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  perform jdb.require_session(p_token, 'admin');
  for k, v in select * from jsonb_each(coalesce(p_months, '{}'::jsonb)) loop
    if k !~ '^\d{4}-\d{2}$' then raise exception 'BAD_INPUT'; end if;
    insert into jdb.expenses(month, data, updated_at) values (k, v, now())
    on conflict (month) do update set data = excluded.data, updated_at = now();
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- Save ONE flat's record for ONE month (row-level, so concurrent saves for
-- different flats can never overwrite each other).
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

-- Owner: set own security question (answer is hashed)
create or replace function public.jdb_owner_set_recovery(p_token text, p_question text, p_answer text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions;
begin
  s := jdb.require_session(p_token, 'owner');
  update jdb.flats set
    recovery_question = coalesce(btrim(p_question), ''),
    recovery_answer_hash = case when coalesce(btrim(p_answer),'') <> '' then jdb.hash(jdb.norm_answer(p_answer)) else recovery_answer_hash end,
    updated_at = now()
  where id = s.subject;
  return jsonb_build_object('ok', true);
end $$;

-- Owner PIN recovery, step 1: phone on file must match -> returns question
create or replace function public.jdb_owner_recover_question(p_flat_id text, p_phone text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare f jdb.flats; subj text := 'recover:' || coalesce(p_flat_id,'');
begin
  if jdb.is_locked(subj) then return jsonb_build_object('ok', false, 'error', 'LOCKED'); end if;
  select * into f from jdb.flats where id = p_flat_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'NO_FLAT'); end if;
  if jdb.digits(f.phone) = '' then return jsonb_build_object('ok', false, 'error', 'NO_PHONE'); end if;
  if jdb.digits(p_phone) = '' or jdb.digits(p_phone) <> jdb.digits(f.phone) then
    insert into jdb.login_failures(subject) values (subj);
    return jsonb_build_object('ok', false, 'error', 'PHONE_MISMATCH');
  end if;
  if coalesce(f.recovery_question,'') = '' or f.recovery_answer_hash is null then
    return jsonb_build_object('ok', false, 'error', 'NO_QUESTION');
  end if;
  return jsonb_build_object('ok', true, 'question', f.recovery_question);
end $$;

-- Owner PIN recovery, step 2 (check answer) and step 3 (p_new_pin not null -> reset)
create or replace function public.jdb_owner_recover_reset(p_flat_id text, p_phone text, p_answer text, p_new_pin text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare f jdb.flats; subj text := 'recover:' || coalesce(p_flat_id,'');
begin
  if jdb.is_locked(subj) then return jsonb_build_object('ok', false, 'error', 'LOCKED'); end if;
  select * into f from jdb.flats where id = p_flat_id;
  if not found or jdb.digits(f.phone) = '' or jdb.digits(p_phone) <> jdb.digits(f.phone) then
    insert into jdb.login_failures(subject) values (subj);
    return jsonb_build_object('ok', false, 'error', 'PHONE_MISMATCH');
  end if;
  if coalesce(btrim(p_answer),'') = '' or not jdb.hash_ok(jdb.norm_answer(p_answer), f.recovery_answer_hash) then
    insert into jdb.login_failures(subject) values (subj);
    return jsonb_build_object('ok', false, 'error', 'BAD_ANSWER');
  end if;
  if p_new_pin is null then return jsonb_build_object('ok', true); end if;
  if length(btrim(p_new_pin)) < 4 then return jsonb_build_object('ok', false, 'error', 'PIN_TOO_SHORT'); end if;
  update jdb.flats set pin = btrim(p_new_pin), updated_at = now() where id = f.id;
  delete from jdb.sessions where role = 'owner' and subject = f.id;
  delete from jdb.login_failures where subject in (subj, 'owner:' || f.id);
  return jsonb_build_object('ok', true);
end $$;

-- Admin password recovery via the shared admin recovery question
create or replace function public.jdb_admin_recover(p_admin_id text, p_answer text, p_new_password text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare st jdb.settings; subj text := 'adminrecover';
begin
  if jdb.is_locked(subj) then return jsonb_build_object('ok', false, 'error', 'LOCKED'); end if;
  select * into st from jdb.settings where id = 1;
  if coalesce(st.admin_recovery_question,'') = '' or st.admin_recovery_answer_hash is null then
    return jsonb_build_object('ok', false, 'error', 'NO_QUESTION');
  end if;
  if coalesce(btrim(p_answer),'') = '' or not jdb.hash_ok(jdb.norm_answer(p_answer), st.admin_recovery_answer_hash) then
    insert into jdb.login_failures(subject) values (subj);
    return jsonb_build_object('ok', false, 'error', 'BAD_ANSWER');
  end if;
  if length(coalesce(p_new_password,'')) < 4 then return jsonb_build_object('ok', false, 'error', 'PASSWORD_TOO_SHORT'); end if;
  if not exists (select 1 from jdb.admins where id = p_admin_id) then return jsonb_build_object('ok', false, 'error', 'NO_ADMIN'); end if;
  update jdb.admins set password_hash = jdb.hash(p_new_password), updated_at = now() where id = p_admin_id;
  delete from jdb.sessions where role = 'admin' and subject = p_admin_id;
  delete from jdb.login_failures where subject in (subj, 'admin:' || p_admin_id);
  return jsonb_build_object('ok', true);
end $$;

-- Admin: full restore from a backup (single transaction — all or nothing)
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

-- Admin: data needed for a complete, self-contained backup (includes the
-- hashes so a restore keeps everyone's passwords/answers working)
create or replace function public.jdb_export(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform jdb.require_session(p_token, 'admin');
  return jsonb_build_object(
    'flatSecrets', coalesce((select jsonb_object_agg(id, recovery_answer_hash) from jdb.flats where recovery_answer_hash is not null), '{}'::jsonb),
    'adminSecrets', coalesce((select jsonb_object_agg(id, password_hash) from jdb.admins), '{}'::jsonb),
    'adminRecoveryAnswerHash', (select admin_recovery_answer_hash from jdb.settings where id = 1));
end $$;

-- Admin: read-only diagnostics
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
    'serverTime', now());
end $$;

-- Used only by the jdb-files Edge Function (service role) to authorise uploads
create or replace function public.jdb_session_info(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions;
begin
  s := jdb.require_session(p_token);
  return jsonb_build_object('role', s.role, 'subject', s.subject);
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on all functions in schema jdb from public, anon, authenticated;
revoke execute on function
  public.jdb_public_info(), public.jdb_login_owner(text,text), public.jdb_login_admin(text,text),
  public.jdb_logout(text), public.jdb_load(text), public.jdb_save_flats(text,jsonb,text[]),
  public.jdb_save_admins(text,jsonb,text[]), public.jdb_save_settings(text,jsonb),
  public.jdb_save_expenses(text,jsonb), public.jdb_save_payment(text,text,text,jsonb),
  public.jdb_owner_set_recovery(text,text,text), public.jdb_owner_recover_question(text,text),
  public.jdb_owner_recover_reset(text,text,text,text), public.jdb_admin_recover(text,text,text),
  public.jdb_restore(text,jsonb), public.jdb_export(text), public.jdb_diagnostics(text),
  public.jdb_session_info(text)
from public;
grant execute on function
  public.jdb_public_info(), public.jdb_login_owner(text,text), public.jdb_login_admin(text,text),
  public.jdb_logout(text), public.jdb_load(text), public.jdb_save_flats(text,jsonb,text[]),
  public.jdb_save_admins(text,jsonb,text[]), public.jdb_save_settings(text,jsonb),
  public.jdb_save_expenses(text,jsonb), public.jdb_save_payment(text,text,text,jsonb),
  public.jdb_owner_set_recovery(text,text,text), public.jdb_owner_recover_question(text,text),
  public.jdb_owner_recover_reset(text,text,text,text), public.jdb_admin_recover(text,text,text),
  public.jdb_restore(text,jsonb), public.jdb_export(text), public.jdb_diagnostics(text)
to anon, authenticated;
grant execute on function public.jdb_session_info(text) to service_role;

-- ---------------------------------------------------------------- storage (private bucket, no public policies:
-- files are only reachable through the jdb-files Edge Function / signed URLs)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jdb-screenshots', 'jdb-screenshots', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------- seed (fresh start: same defaults the app used to create)
insert into jdb.settings(id) values (1) on conflict (id) do nothing;

insert into jdb.admins(id, name, phone, password_hash, sort_order)
select 'admin1', 'Admin', '', jdb.hash('admin123'), 1
where not exists (select 1 from jdb.admins);

insert into jdb.flats(id, flat_no, owner, phone, amount, pin, sort_order)
select 'id' || n, 'f' || ((n-1)/7) || lpad((((n-1)%7)+1)::text, 2, '0'), o.name, o.phone, 2000, (1000+n)::text, n
from (values
 (1,'Kundan Kumar Sigh','+917795681920'),(2,'Manish Kumar','+919108416357'),(3,'Anushree M.','+919148873188'),
 (4,'Shanmukh Rao Subudhi','+918951323159'),(5,'Virender Solanki - Sudeshna','+918095679091'),(6,'Abha Singh','+918707743302'),
 (7,'Maheshwara N.','+919620183269'),(8,'Munisekhar Nimmala','+918197426677'),(9,'Subhish J Pillai','+919620183269'),
 (10,'O. Kathiri Chetty','+919845064751'),(11,'Kheem Singh Bisht','+918553093745'),(12,'Deepak Kumar','+919561725494'),
 (13,'Sindhu Raghavendra','+919686356006'),(14,'Munikrishna N.','+918892208983'),(15,'Pallavi','+919663358058'),
 (16,'Krishnamurthy Kurakula','+919731098098'),(17,'Saran Kumar Reddy V.','+917259824248'),(18,'Anima Remesh','+919449661228'),
 (19,'LR. Umarani Ramesh','+919449446845'),(20,'Anitha Balakrishna','+918317377800'),(21,'Sai Manohar Boidapu','+919686239385'),
 (22,'Swapnil Sunny','+918884898221'),(23,'Mohan Kumar','+919620183269'),(24,'Hari Dindukurthi','+917702115644'),
 (25,'Vineel Kumar G','+919867197773'),(26,'Harendra Kumar','+919035203994'),(27,'Venu Bandi','+914025476081'),
 (28,'Sumukan Setty','+919886655802'),(29,'Shantakumar Banappanavar','+918497009775'),(30,'Lavanya Kumar T','+919480437016'),
 (31,'Avinash Kumar Reddy Eluru','+919533766101'),(32,'Vinjamoori Shankar','+918095323902'),(33,'Deepa Bharath Raj','+919731314929'),
 (34,'Tejeswar Vasupally','+918792646237'),(35,'Chaitanya P','+919620377357')
) as o(n, name, phone)
where not exists (select 1 from jdb.flats);

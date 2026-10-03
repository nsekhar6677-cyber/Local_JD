-- Fix: Restore backup failed on Supabase with "DELETE requires a WHERE clause".
-- Supabase guards requests from the website against unfiltered DELETEs, so the
-- restore's clear-table steps now carry an explicit (always-true) WHERE on the key column. Same behaviour,
-- still one all-or-nothing transaction.
create or replace function public.jdb_restore(p_token text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s jdb.sessions; e jsonb; k text; v jsonb; i int := 0; st jsonb;
begin
  s := jdb.require_session(p_token, 'admin');
  if jsonb_typeof(p->'flats') <> 'array' or jsonb_typeof(p->'payments') <> 'object' then raise exception 'BAD_INPUT'; end if;

  delete from jdb.flats where id is not null;
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

  delete from jdb.payments where flat_id is not null;
  for k, v in select * from jsonb_each(p->'payments') loop
    insert into jdb.payments(flat_id, month, data, screenshot_path, updated_by)
    values (left(k, length(k) - position(':' in reverse(k))), right(k, position(':' in reverse(k)) - 1),
            v - 'screenshot' - 'screenshotPath', v->>'screenshotPath', 'restore:' || s.subject);
  end loop;

  delete from jdb.expenses where month is not null;
  for k, v in select * from jsonb_each(coalesce(p->'expenses','{}'::jsonb)) loop
    insert into jdb.expenses(month, data) values (k, v);
  end loop;

  -- special collections (older backups without them leave collections untouched)
  if jsonb_typeof(p->'collections') = 'array' then
    delete from jdb.collection_payments where collection_id is not null;
    delete from jdb.collections where id is not null;
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
    delete from jdb.admins where id is not null;
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

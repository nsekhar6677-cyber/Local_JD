-- Owners see the society's fund position on their page (balance b/f, expenses,
-- available balance). They get each month's expense AMOUNTS and balance figures
-- only — no category, date, mode or comments. Admin data is unchanged.
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
      -- society funds for the owner's overview: totals only (no category, date, mode or comments)
      'expenses', coalesce((select jsonb_object_agg(month, jsonb_build_object(
          'openingOverride', data->'openingOverride',
          'maintReceivedOverride', data->'maintReceivedOverride',
          'items', coalesce((select jsonb_agg(jsonb_build_object('amount', i->'amount'))
                             from jsonb_array_elements(coalesce(data->'items','[]'::jsonb)) i), '[]'::jsonb)))
          from jdb.expenses), '{}'::jsonb),
      'admins', '[]'::jsonb,
      'settings', jdb.settings_json() - 'adminPhone');
  end if;
  return r;
end $$;

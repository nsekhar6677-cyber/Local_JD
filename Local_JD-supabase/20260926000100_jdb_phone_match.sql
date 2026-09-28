-- Phone numbers on file may be stored with or without the +91 country code
-- ("+919108416357" vs "9108416357"). Compare on the last 10 digits so owners
-- can verify for PIN recovery either way.
create or replace function jdb.digits(p text) returns text
language sql immutable set search_path = '' as $$
  select right(regexp_replace(coalesce(p,''), '[^0-9]', '', 'g'), 10)
$$;

-- Supabase's default privileges grant EXECUTE on new public functions to
-- anon/authenticated directly (not only via PUBLIC). jdb_session_info is for
-- the Edge Function (service role) only.
revoke execute on function public.jdb_session_info(text) from anon, authenticated;

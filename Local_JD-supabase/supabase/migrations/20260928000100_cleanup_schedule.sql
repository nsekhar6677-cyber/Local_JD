-- mock:skip  (needs pg_cron / pg_net / Vault — not available in the local test database)
-- Daily at 00:30 IST (19:00 UTC) the database calls the jdb-cleanup Edge Function.
-- Before applying, store this project's URL once:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'jdb_project_url');
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- random key shared by the scheduler and the Edge Function
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'jdb_cleanup_key')
where not exists (select 1 from vault.secrets where name = 'jdb_cleanup_key');

create or replace function public.jdb_cleanup_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'jdb_cleanup_key' and decrypted_secret = p_key)
$$;
revoke execute on function public.jdb_cleanup_key_ok(text) from public, anon, authenticated;
grant execute on function public.jdb_cleanup_key_ok(text) to service_role;

select cron.unschedule('jdb-screenshot-cleanup') where exists (select 1 from cron.job where jobname = 'jdb-screenshot-cleanup');
select cron.schedule('jdb-screenshot-cleanup', '0 19 * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'jdb_project_url') || '/functions/v1/jdb-cleanup',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cleanup-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jdb_cleanup_key')),
    body := '{"dryRun": false}'::jsonb,
    timeout_milliseconds := 60000)
$job$);

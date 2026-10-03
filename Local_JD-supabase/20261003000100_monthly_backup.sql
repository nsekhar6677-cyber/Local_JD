-- mock:skip  (needs pg_cron / pg_net / Vault / Storage buckets — not in the local test database)
-- Automatic monthly backup: on the 1st of every month at 06:00 IST (00:30 UTC) the database
-- calls the jdb-backup Edge Function, which saves a backup CSV in the private `jdb-backups`
-- bucket and keeps only the newest one. Uses the same Vault secrets as the screenshot clean-up
-- (jdb_project_url, jdb_cleanup_key). Deploy supabase/functions/jdb-backup (verify_jwt off) first.
insert into storage.buckets (id, name, public)
values ('jdb-backups', 'jdb-backups', false)
on conflict (id) do nothing;

select cron.unschedule('jdb-monthly-backup') where exists (select 1 from cron.job where jobname = 'jdb-monthly-backup');
select cron.schedule('jdb-monthly-backup', '30 0 1 * *',
  'select net.http_post(
     url := (select decrypted_secret from vault.decrypted_secrets where name = ''jdb_project_url'') || ''/functions/v1/jdb-backup'',
     headers := jsonb_build_object(''Content-Type'', ''application/json'',
                                   ''x-cleanup-key'', (select decrypted_secret from vault.decrypted_secrets where name = ''jdb_cleanup_key'')),
     body := ''{"action":"run"}''::jsonb,
     timeout_milliseconds := 60000)');

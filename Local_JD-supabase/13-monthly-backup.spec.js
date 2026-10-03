// Automatic monthly backup: same CSV as "Download backup", stored server-side, only the newest
// kept, downloadable from Settings → Data, and restorable with "Restore backup".
import { test, expect } from '@playwright/test';
import { resetDb, sql, openApp, loginAdmin, loginOwner, tab, settle, API } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });
const FULL = ['laptop-1366', 'iphone-14', 'pixel-7'];
const only = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'runs on laptop, iPhone and Android profiles');
const run = (request, now, key = 'test-cleanup-key') =>
  request.post(`${API}/functions/v1/jdb-backup`, { headers: { 'x-cleanup-key': key }, data: { action: 'run', now } });

test('schedule run keeps only the newest backup; wrong key refused', async ({ request }, testInfo) => {
  only(testInfo);
  expect((await run(request, '2026-09-01T00:30:00Z', 'nope')).status()).toBe(401);
  const r1 = await (await run(request, '2026-09-01T00:30:00Z')).json();
  expect(r1.name).toBe('JDB_backup_2026-09-01_0600.csv');
  const r2 = await (await run(request, '2026-10-01T00:30:00Z')).json();
  expect(r2).toMatchObject({ ok: true, name: 'JDB_backup_2026-10-01_0600.csv', removed: 1 });
  expect((await (await request.get(`${API}/__backups`)).json()).names).toEqual(['JDB_backup_2026-10-01_0600.csv']);
});

test('admin sees the latest backup, can back up now, download it and restore from it', async ({ page, request }, testInfo) => {
  only(testInfo);
  await sql(request, `insert into jdb.payments(flat_id, month, data) values ('id1','2026-09','{"paid":true,"amount":2000,"mode":"UPI","verified":true}')`);
  await sql(request, `insert into jdb.collections(id, month, data) values ('c1','2026-09','{"title":"Lift repair","amount":1500,"closed":false,"flats":null,"amounts":{}}')`);
  await sql(request, `insert into jdb.collection_payments(collection_id, flat_id, data) values ('c1','id2','{"paid":true,"amount":1500,"mode":"Cash","verified":true}')`);
  await openApp(page); await loginAdmin(page); await tab(page, 'settings');
  await expect(page.locator('#auto-backup-status')).toContainText('No automatic backup yet');
  await expect(page.locator('#auto-backup-download')).toBeDisabled();
  await page.click('#auto-backup-run');
  await expect(page.locator('#auto-backup-status')).toContainText('Latest: JDB_backup_');
  await expect(page.locator('#auto-backup-download')).toBeEnabled();
  // download the file through the same link the button opens
  const status = await page.evaluate(() => backupApi({ action: 'status' }));
  const csv = await (await request.get(status.latest.url)).text();
  expect(csv).toContain('"meta_source","automatic monthly backup"');
  expect(csv).toContain('Lift repair');
  // data changes after the backup … then restore puts it back
  await sql(request, `delete from jdb.payments where flat_id = 'id1'`);
  await sql(request, `delete from jdb.collection_payments where flat_id = 'id2'`);
  await page.setInputFiles('#import-backup-input', { name: 'auto.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.click('#confirm-modal-yes');
  await expect(page.locator('#backup-note')).toContainText('restored successfully', { timeout: 30_000 });
  expect((await sql(request, `select (data->>'amount')::int a from jdb.payments where flat_id='id1'`))[0].a).toBe(2000);
  expect((await sql(request, `select data->>'mode' m from jdb.collection_payments where flat_id='id2'`))[0].m).toBe('Cash');
  // admin passwords survive the restore
  await page.reload(); await openApp(page); await loginAdmin(page);
});

test('owners cannot run or read backups', async ({ page }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginOwner(page, { flatId: 'id3', pin: '1003' });
  const codes = await page.evaluate(async () => {
    const call = (action) => fetch(`${SUPABASE_URL}/functions/v1/jdb-backup`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, token: sessionToken }) }).then(r => r.status);
    return [await call('status'), await call('run')];
  });
  expect(codes).toEqual([403, 403]);
});

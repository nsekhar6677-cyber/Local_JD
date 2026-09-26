// End-to-end behaviour against the database: every change must survive a
// page reload / new device, and access rules must hold.
import { test, expect } from '@playwright/test';
import { resetDb, sql, month, openApp, loginAdmin, loginOwner, logout, tab, settle, testImage, noHorizontalOverflow, API, ownerUploadShot } from './helpers.js';

// full suite on one laptop, one iPhone and one Android profile; the core
// money-flow tests run on every profile
const FULL = ['laptop-1366', 'iphone-14', 'pixel-7', 'laptop-1366-webkit', 'iphone-14-webkit'];
const full = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'full suite runs on representative profiles');

test.beforeEach(async ({ request }) => { await resetDb(request); });

test('core: admin records a payment, it persists across reload and devices', async ({ page, browser, request }, testInfo) => {
  const m = month();
  await openApp(page);
  // wrong password is rejected by the server
  await page.click('#toggle-admin');
  await page.fill('#admin-pass', 'nope');
  await page.click('#admin-login-btn');
  await expect(page.locator('#admin-login-err')).toContainText('Incorrect password');
  await page.fill('#admin-pass', 'admin123');
  await page.click('#admin-login-btn');
  await expect(page.locator('#dash-stats')).toContainText('35');

  await tab(page, 'entry');
  const row = page.locator('#entry-tbody tr[data-id="id1"]');
  await row.locator('.e-paid').check();
  await settle(page);
  await expect(page.locator('#entry-tbody tr[data-id="id1"] .e-paid')).toBeChecked();
  await page.locator('#entry-tbody tr[data-id="id1"] .e-mode').selectOption('UPI');
  await settle(page);

  const rows = await sql(request, `select data from jdb.payments where flat_id='id1' and month='${m}'`);
  expect(rows[0].data).toMatchObject({ paid: true, amount: 2000, mode: 'UPI' });

  // reload = fresh device: data comes back from the database
  await page.reload();
  await openApp(page);
  await loginAdmin(page);
  await expect(page.locator('#dash-stats .stat').nth(1)).toContainText('1');
  await tab(page, 'entry');
  await expect(page.locator('#entry-tbody tr[data-id="id1"] .e-paid')).toBeChecked();
  await expect(page.locator('#entry-tbody tr[data-id="id1"] .e-mode')).toHaveValue('UPI');

  // a second device (another browser context) sees the same data
  const ctx2 = await browser.newContext({ baseURL: API, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await openApp(p2);
  await loginAdmin(p2);
  await expect(p2.locator('#dash-stats .stat').nth(1)).toContainText('1');
  await ctx2.close();
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('core: owner submits payment with screenshot; admin sees it and verifies', async ({ page, browser, request }) => {
  const m = month();
  await openApp(page);
  await loginOwner(page, { flatId: 'id3', pin: '1003' });
  await expect(page.locator('#my-flat-title')).toContainText('f003');
  await page.fill('#my-pay-amount', '2000');
  await page.selectOption('#my-pay-mode', 'UPI');
  await page.setInputFiles('#my-shot-input', testImage());
  await expect(page.locator('.my-shot-view')).toBeVisible({ timeout: 30_000 });
  await settle(page);
  await page.click('#my-mark-paid-btn');
  await settle(page);
  await expect(page.locator('#my-current-status')).toContainText(/Submitted|Paid & verified/);

  const rows = await sql(request, `select data, screenshot_path from jdb.payments where flat_id='id3' and month='${m}'`);
  expect(rows[0].data.paid).toBe(true);
  expect(rows[0].screenshot_path).toMatch(new RegExp(`^id3/${m}/`));
  const files = await (await request.get(`${API}/__files`)).json();
  expect(files.count).toBe(1);

  // owner reload: screenshot comes back from storage via a signed URL
  await page.reload();
  await openApp(page);
  await loginOwner(page, { flatId: 'id3', pin: '1003' });
  const img = page.locator('.my-shot-view');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate(el => el.naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute('src')).toContain('/storage/id3/');

  // admin on another device sees the submission + screenshot, verifies it
  const ctx = await browser.newContext({ baseURL: API });
  const admin = await ctx.newPage();
  await openApp(admin);
  await loginAdmin(admin);
  await tab(admin, 'entry');
  const arow = admin.locator('#entry-tbody tr[data-id="id3"]');
  await expect(arow.locator('.e-paid')).toBeChecked();
  await expect.poll(() => arow.locator('.e-shot-view').evaluate(el => el.naturalWidth)).toBeGreaterThan(0);
  await arow.locator('.e-verified').check();
  await settle(admin);
  await ctx.close();

  // owner's month is now locked
  await page.reload();
  await openApp(page);
  await loginOwner(page, { flatId: 'id3', pin: '1003' });
  await expect(page.locator('#my-upload-area')).toContainText('Verified by admin');
});

test('core: admin uploads, replaces and removes a screenshot in Entry', async ({ page, request }) => {
  const m = month();
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  await page.locator('#entry-tbody tr[data-id="id2"] .e-shot-input').setInputFiles(testImage('proof'));
  await expect(page.locator('#entry-tbody tr[data-id="id2"] .e-shot-view')).toBeVisible({ timeout: 30_000 });
  await settle(page);
  let rows = await sql(request, `select screenshot_path from jdb.payments where flat_id='id2' and month='${m}'`);
  expect(rows[0].screenshot_path).toMatch(/^id2\//);
  await page.locator('#entry-tbody tr[data-id="id2"] .e-shot-remove').click();
  await page.click('#confirm-modal-yes');
  await expect(page.locator('#entry-tbody tr[data-id="id2"] .e-shot-view')).toHaveCount(0);
  await settle(page);
  rows = await sql(request, `select screenshot_path from jdb.payments where flat_id='id2' and month='${m}'`);
  expect(rows[0].screenshot_path).toBeNull();
  // every change is in the audit trail
  const hist = await sql(request, `select count(*)::int c from jdb.payment_history where flat_id='id2'`);
  expect(hist[0].c).toBeGreaterThanOrEqual(3);
});

test('two devices saving different flats at the same moment never overwrite each other', async ({ browser, request }, testInfo) => {
  full(testInfo);
  const m = month();
  const mk = async () => { const c = await browser.newContext({ baseURL: API }); const p = await c.newPage(); await openApp(p); return { c, p }; };
  const A = await mk(); const B = await mk(); const C = await mk();
  await loginAdmin(A.p); await loginAdmin(B.p); await loginOwner(C.p, { flatId: 'id7', pin: '1007' });
  await tab(A.p, 'entry'); await tab(B.p, 'entry');
  await C.p.selectOption('#my-pay-mode', 'UPI');
  await ownerUploadShot(C.p);
  await request.get(`${API}/__delay?ms=150`); // make requests overlap
  await Promise.all([
    A.p.locator('#entry-tbody tr[data-id="id5"] .e-paid').check(),
    B.p.locator('#entry-tbody tr[data-id="id6"] .e-paid').check(),
    C.p.click('#my-mark-paid-btn'),
  ]);
  await Promise.all([settle(A.p), settle(B.p), settle(C.p)]);
  await request.get(`${API}/__delay?ms=0`);
  const rows = await sql(request, `select flat_id from jdb.payments where month='${m}' and (data->>'paid')::boolean order by flat_id`);
  expect(rows.map(r => r.flat_id)).toEqual(['id5', 'id6', 'id7']);
  for (const x of [A, B, C]) await x.c.close();
});

test('flats & access edits persist; PIN change takes effect immediately', async ({ page, request }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'flats');
  const row = page.locator('#flats-tbody tr[data-id="id5"]');
  await row.locator('input[data-field="owner"]').fill('Renamed Owner');
  await row.locator('input[data-field="owner"]').press('Tab');
  await row.locator('input[data-field="pin"]').fill('7777');
  await row.locator('input[data-field="pin"]').press('Tab');
  await settle(page);
  const r = await sql(request, `select owner, pin from jdb.flats where id='id5'`);
  expect(r[0]).toEqual({ owner: 'Renamed Owner', pin: '7777' });
  await logout(page);
  await expect(page.locator('#owner-flat-select option[value="id5"]')).toContainText('Renamed Owner');
  await page.click('#toggle-owner');
  await page.selectOption('#owner-flat-select', 'id5');
  await page.fill('#owner-pin', '1005');
  await page.click('#owner-login-btn');
  await expect(page.locator('#owner-login-err')).toContainText('Incorrect PIN');
  await page.fill('#owner-pin', '7777');
  await page.click('#owner-login-btn');
  await expect(page.locator('#my-flat-title')).toContainText('Renamed Owner');
});

test('add + remove flat persists', async ({ page, request }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'flats');
  await page.click('#add-flat-btn');
  await settle(page);
  expect((await sql(request, `select count(*)::int c from jdb.flats`))[0].c).toBe(36);
  await page.locator('#flats-tbody tr[data-id="id36"] .del-btn').click();
  await page.click('#confirm-modal-yes');
  await settle(page);
  expect((await sql(request, `select count(*)::int c from jdb.flats`))[0].c).toBe(35);
});

test('expenses, settings and reports persist', async ({ page, request }, testInfo) => {
  full(testInfo);
  const m = month();
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'expenses');
  await page.click('#exp-add-item-btn');
  const item = page.locator('#exp-items-tbody tr[data-id]').first();
  await item.locator('.ei-cat-select').selectOption('Diesel');
  await page.locator('#exp-items-tbody tr[data-id] .ei-amt').first().fill('1500');
  await page.locator('#exp-items-tbody tr[data-id] .ei-amt').first().press('Tab');
  await settle(page);
  const e = await sql(request, `select data from jdb.expenses where month='${m}'`);
  expect(e[0].data.items[0]).toMatchObject({ category: 'Diesel', amount: 1500 });

  await tab(page, 'settings');
  await page.fill('#set-name', 'JD Blossom Apartment Phase 1');
  await page.fill('#set-amount', '2500');
  await page.click('#save-settings-btn');
  await settle(page);
  await expect(page.locator('#settings-saved-note')).toContainText('Saved');
  await page.reload();
  await openApp(page);
  await expect(page.locator('#login-society-title')).toHaveText('JD Blossom Apartment Phase 1');
  await loginAdmin(page);
  await tab(page, 'expenses');
  await expect(page.locator('#exp-summary-wrap')).toContainText('Diesel');
  await expect(page.locator('#exp-payments-total')).toContainText('1,500');
  await tab(page, 'reports');
  await page.click('#rpt-period-btn');
  await expect(page.locator('#rpt-period-output')).toContainText('Period Report');
});

test('admin profiles: add admin, new admin signs in, password change', async ({ page }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'profile');
  await page.click('#add-admin-btn');
  await expect(page.locator('#admins-note')).toContainText('admin1002');
  await settle(page);
  await logout(page);
  await page.click('#toggle-admin');
  const newId = await page.locator('#admin-profile-select option').nth(1).getAttribute('value');
  await loginAdmin(page, { adminId: newId, password: 'admin1002' });
  await tab(page, 'profile');
  await page.fill('#my-admin-newpass', 'better-pass');
  await page.click('#save-my-password-btn');
  await expect(page.locator('#my-password-saved-note')).toContainText('Password updated');
  await settle(page);
  await logout(page);
  await loginAdmin(page, { adminId: newId, password: 'better-pass' });
});

test('owner PIN recovery via security question', async ({ page }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginOwner(page, { flatId: 'id2', pin: '1002' });
  await page.fill('#my-recovery-q', 'First school?');
  await page.fill('#my-recovery-a', 'St Marys');
  await page.click('#save-my-recovery-btn');
  await expect(page.locator('#my-recovery-saved-note')).toContainText('saved');
  await logout(page);
  await page.selectOption('#owner-flat-select', 'id2');
  await page.click('#owner-forgot-link');
  await page.fill('#recover-phone', '9108416357'); // stored as +919108416357
  await page.click('#owner-recover-verify-btn');
  await expect(page.locator('#owner-recover-question')).toHaveText('First school?');
  await page.fill('#owner-recover-answer', 'wrong');
  await page.click('#owner-recover-answer-btn');
  await expect(page.locator('#owner-recover-msg2')).toContainText("doesn't match");
  await page.fill('#owner-recover-answer', ' st marys ');
  await page.click('#owner-recover-answer-btn');
  await page.fill('#recover-newpin', '4321');
  await page.click('#owner-recover-submit');
  await expect(page.locator('#owner-recover-success')).toBeVisible();
  await page.fill('#owner-pin', '4321');
  await page.click('#owner-login-btn');
  await expect(page.locator('#my-flat-title')).toContainText('f002');
});

test('admin password recovery via recovery question', async ({ page }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'settings');
  await page.fill('#set-recovery-q', 'Society founded year?');
  await page.fill('#set-recovery-a', '2012');
  await page.click('#save-recovery-btn');
  await expect(page.locator('#recovery-saved-note')).toContainText('saved');
  await settle(page);
  await logout(page);
  await page.reload();
  await openApp(page);
  await page.click('#toggle-admin');
  await page.click('#admin-forgot-link');
  await expect(page.locator('#admin-recover-question')).toHaveText('Society founded year?');
  await page.fill('#recover-admin-answer', '2012');
  await page.fill('#recover-admin-newpass', 'newpass1');
  await page.click('#admin-recover-submit');
  await expect(page.locator('#admin-recover-msg')).toContainText('Password updated');
  await loginAdmin(page, { password: 'newpass1' });
});

test('brute-force protection locks a flat after 5 wrong PINs', async ({ page }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await page.selectOption('#owner-flat-select', 'id9');
  for (let i = 0; i < 5; i++) {
    await page.fill('#owner-pin', '0000');
    await page.click('#owner-login-btn');
    await expect(page.locator('#owner-login-err')).toContainText('Incorrect PIN');
  }
  await page.fill('#owner-pin', '1009');
  await page.click('#owner-login-btn');
  await expect(page.locator('#owner-login-err')).toContainText('Too many incorrect attempts');
});

test('backup download contains everything and restores cleanly', async ({ page, request }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  await page.locator('#entry-tbody tr[data-id="id4"] .e-shot-input').setInputFiles(testImage());
  await expect(page.locator('#entry-tbody tr[data-id="id4"] .e-shot-view')).toBeVisible({ timeout: 30_000 });
  await page.locator('#entry-tbody tr[data-id="id4"] .e-paid').check();
  await settle(page);
  await tab(page, 'settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup-btn')]);
  const path = await dl.path();
  const fs = await import('node:fs');
  const csv = fs.readFileSync(path, 'utf8');
  expect(csv).toContain('"flats"');
  expect(csv).toContain('data:image/'); // screenshot embedded -> self-contained backup
  expect(csv).not.toContain('admin123');

  // wipe a payment, then restore the backup
  await sql(request, `delete from jdb.payments`);
  page.once('filechooser', () => {});
  await page.setInputFiles('#import-backup-input', { name: 'Jdb_data.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.click('#confirm-modal-yes');
  await expect(page.locator('#backup-note')).toContainText('restored successfully', { timeout: 30_000 });
  const rows = await sql(request, `select flat_id, (data->>'paid')::boolean paid, screenshot_path from jdb.payments`);
  expect(rows).toHaveLength(1);
  expect(rows[0].paid).toBe(true);
  expect(rows[0].screenshot_path).toMatch(/^id4\//);
  // restoring keeps admin password working
  await logout(page);
  await loginAdmin(page);
});

test('legacy backup CSV (old app format with plain passwords) imports', async ({ page, request }, testInfo) => {
  full(testInfo);
  const m = month();
  const legacy = {
    flats: Array.from({ length: 3 }, (_, i) => ({ id: 'id' + (i + 1), flatNo: 'f00' + (i + 1), owner: 'Owner ' + (i + 1), phone: '98450000' + (10 + i), amount: 2000, pin: String(1001 + i), ...(i === 0 ? { recoveryQuestion: 'Pet?', recoveryAnswer: 'Tom' } : {}) })),
    payments: { [`id1:${m}`]: { paid: true, amount: 2000, date: '', mode: 'UPI', verified: false, waived: false, screenshot: 'data:image/png;base64,' + testImage().buffer.toString('base64') } },
    settings: { societyName: 'JD Blossom Apartment', defaultAmount: 2000, adminPassword: 'x', adminRecoveryQuestion: 'Q?', adminRecoveryAnswer: 'A' },
    expenses: {},
    admins: [{ id: 'admin1', name: 'Admin', phone: '', password: 'admin123' }, { id: 'a2', name: 'Krishna', phone: '', password: 'k-pass' }],
  };
  const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
  const csv = [['key', 'value'], ['flats', JSON.stringify(legacy.flats)], ['payments', JSON.stringify(legacy.payments)], ['settings', JSON.stringify(legacy.settings)], ['expenses', '{}'], ['admins', JSON.stringify(legacy.admins)]].map(r => r.map(esc).join(',')).join('\r\n');
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'settings');
  await page.setInputFiles('#import-backup-input', { name: 'Jdb_data.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.click('#confirm-modal-yes');
  await expect(page.locator('#backup-note')).toContainText('restored successfully', { timeout: 30_000 });
  expect((await sql(request, `select count(*)::int c from jdb.flats`))[0].c).toBe(3);
  const hashes = await sql(request, `select password_hash from jdb.admins`);
  hashes.forEach(h => expect(h.password_hash).toMatch(/^\$2/)); // stored hashed, not plain
  await logout(page);
  await loginAdmin(page, { adminId: 'a2', password: 'k-pass' });
});

test('owner cannot see other flats\' PINs, phones or screenshots', async ({ page }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginOwner(page, { flatId: 'id1', pin: '1001' });
  const leaked = await page.evaluate(() => flats.filter(f => f.id !== 'id1').some(f => 'pin' in f || 'phone' in f));
  expect(leaked).toBe(false);
  // direct table access with the public key is impossible
  const r = await page.evaluate(async () => (await fetch(`${SUPABASE_URL}/rest/v1/rpc/jdb_save_flats`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: sessionToken, p_upserts: [{ id: 'id2', pin: '0000' }], p_deletes: [] }) })).status);
  expect(r).toBeGreaterThanOrEqual(400);
});

test('expired session returns to sign-in with a message', async ({ page, request }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  await sql(request, `delete from jdb.sessions`);
  // the next server call (a save, or the background refresh after a tab tap) notices the expiry
  await page.locator('#entry-tbody tr[data-id="id1"] .e-paid').check({ timeout: 5_000 }).catch(() => {});
  await expect(page.locator('#login-screen')).toBeVisible();
  expect((await sql(request, `select count(*)::int c from jdb.payments`))[0].c).toBe(0);
  await expect(page.locator('#admin-login-err')).toContainText('session has expired');
});

test('offline save shows an error instead of silently losing data', async ({ page, request }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  await page.route('**/rest/v1/rpc/jdb_save_payment', r => r.abort('internetdisconnected'));
  await page.locator('#entry-tbody tr[data-id="id8"] .e-paid').check();
  await expect(page.locator('#sync-error')).toContainText('offline');
  await page.unroute('**/rest/v1/rpc/jdb_save_payment');
  // screen re-synced with the server: the unsaved tick is gone
  await expect(page.locator('#entry-tbody tr[data-id="id8"] .e-paid')).not.toBeChecked();
  expect((await sql(request, `select count(*)::int c from jdb.payments`))[0].c).toBe(0);
});

test('diagnostics report reads from the database', async ({ page }, testInfo) => {
  full(testInfo);
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'settings');
  await page.click('#run-diagnostics-btn');
  await expect(page.locator('#diagnostics-output')).toContainText('Supabase — connected');
  await expect(page.locator('#diagnostics-output')).toContainText('Flats currently on file: 35');
});

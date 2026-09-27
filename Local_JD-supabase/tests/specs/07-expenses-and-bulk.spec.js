// Expenses: comments + mandatory fields, bulk expense upload, bulk maintenance
// upload (visible to admin and owner), and the monthly screenshot clean-up.
import { test, expect } from '@playwright/test';
import XLSX from 'xlsx';
import { resetDb, sql, openApp, loginAdmin, loginOwner, tab, settle, ownerUploadShot, API } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });

const FULL = ['laptop-1366', 'iphone-14', 'pixel-7'];
const only = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'runs on laptop, iPhone and Android profiles');

function xlsxFile(aoa, name) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), 'Sheet1');
  return { name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
}
const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day)); // Excel date cell

// same layout as the society's Expense.xlsx
const EXPENSE_FILE = () => xlsxFile([
  ['Category', 'Paid on', 'Amount', 'Comments', 'Maintenance month', 'Mode'],
  ['Power bill', d(2026, 8, 21), 41898, null, 'August', 'UPI'],
  ['Waterbill', d(2026, 8, 21), 20356, null, 'August', 'UPI'],
  ['Repair & Maintenance', d(2026, 8, 16), 1500, 'Terrace pipe repair', 'August', 'UPI'],
  ['Watchman Salary - Deepak', '07-29-2026', 15000, null, 'July', 'Cash'],   // text date, MM-DD-YYYY
  ['Diesel', d(2026, 7, 19), 3000, null, 'July', 'UPI'],
  ['Diesel', d(2026, 7, 19), 3000, null, 'July', 'UPI'],                     // duplicate of the row above
  ['', d(2026, 7, 20), 500, 'no category', 'July', 'UPI'],                    // error: category
  ['Diesel', '13-01-2026', 100, null, 'July', 'UPI'],                         // error: not MM-DD-YYYY
  ['Diesel', d(2026, 7, 21), 0, null, 'July', 'UPI'],                         // error: amount 0
], 'Expense.xlsx');

// same layout as the society's Maintenance_details.xlsx (header on row 2)
const MAINT_FILE = () => xlsxFile([
  [],
  ['Name (Owner)', 'Flat\nNo', 'Flat Type', 'Maintanance \nShare', 'Previous \nbalance', 'Total\nPayable', 'Paid Amt', 'Paid on', 'Balance Payable', 'Maintenance month', 'Mode'],
  ['Kundan Kumar Sigh', '001', '2 BHK', 2000, null, 2000, 2000, d(2026, 7, 2), 0, 'July', 'UPI'],
  ['Manish Kumar', '002', '2 BHK', 2000, null, 2000, 2000, '07-03-2026', 0, 'July', 'Bank transfer'],
  ['Kheem Singh Bisht', 104, '2 BHK', 2000, 3000, 5000, 2000, d(2026, 7, 3), 3000, 'July', 'UPI'],
  ['Kheem Singh Bisht', 104, '2 BHK', 2000, 3000, 5000, 2000, d(2026, 8, 4), 3000, 'August', 'UPI'],
  ['Kundan Kumar Sigh', '001', '2 BHK', 2000, null, 2000, 2000, d(2026, 8, 5), 0, 'August', 'UPI'],
  ['Someone', 999, '2 BHK', 2000, null, 2000, 2000, d(2026, 8, 5), 0, 'August', 'UPI'],       // error: flat
  ['Pallavi', 201, '2 BHK', 2000, null, 2000, 2000, d(2026, 8, 5), 0, 'Augst', 'UPI'],        // error: month
  ['Pallavi', 201, '2 BHK', 2000, null, 2000, 1500, d(2026, 7, 5), 500, 'July', 'Paytm'],     // mode normalised to UPI
], 'Maintenance_details.xlsx');

test('expense: Category, Paid on and Amount are mandatory; comment is optional and saved', async ({ page, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'expenses');
  await page.fill('#exp-month', '2026-09'); await page.dispatchEvent('#exp-month', 'change');
  await expect(page.locator('#exp-items-wrap')).toContainText('Category, Paid on and Amount are mandatory');
  await page.click('#exp-add-item-btn');
  const row = page.locator('#exp-items-tbody tr[data-draft="1"]');
  await row.locator('.ei-amt').fill('750'); await row.locator('.ei-amt').press('Tab');
  await expect(row.locator('.ei-err')).toContainText('Not saved yet — fill Category, Paid on');
  expect((await sql(request, `select count(*)::int c from jdb.expenses`))[0].c).toBe(0); // nothing stored
  await row.locator('.ei-comment').fill('Generator oil top-up'); await row.locator('.ei-comment').press('Tab');
  await row.locator('.ei-cat-select').selectOption('Diesel');
  await row.locator('.ei-date').fill('2026-09-12'); // completes the row → saved (the draft row is replaced)
  await settle(page);
  const saved = page.locator('#exp-items-tbody tr:not([data-draft="1"])').first();
  await expect(saved.locator('.ei-comment')).toHaveValue('Generator oil top-up');
  const it = (await sql(request, `select data->'items'->0 it from jdb.expenses where month='2026-09'`))[0].it;
  expect(it).toMatchObject({ category: 'Diesel', paidOn: '2026-09-12', amount: 750, comment: 'Generator oil top-up' });
  // shown in the monthly summary and the WhatsApp text
  await expect(page.locator('#exp-summary-wrap')).toContainText('Generator oil top-up');
  await page.click('#exp-report-btn');
  await expect(page.locator('#exp-report-output')).toContainText('(Generator oil top-up)');
  // clearing a mandatory field on a saved row is refused; the stored value stays
  await saved.locator('.ei-amt').fill(''); await saved.locator('.ei-amt').press('Tab');
  await expect(saved.locator('.ei-err')).toContainText('Not saved — fill Amount');
  expect((await sql(request, `select (data->'items'->0->>'amount')::int a from jdb.expenses where month='2026-09'`))[0].a).toBe(750);
  // comment edit persists after reload
  await page.reload(); await openApp(page); await loginAdmin(page); await tab(page, 'expenses');
  await page.fill('#exp-month', '2026-09'); await page.dispatchEvent('#exp-month', 'change');
  await expect(page.locator('#exp-items-tbody .ei-comment').first()).toHaveValue('Generator oil top-up');
});

test('expense bulk upload: preview, validation, month split, duplicates, import', async ({ page, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'expenses');
  await page.setInputFiles('#eb-file', EXPENSE_FILE());
  await expect(page.locator('#eb-import')).toBeVisible();
  const stats = page.locator('#eb-preview .stats').first();
  await expect(stats).toContainText('9Rows in file');
  await expect(stats).toContainText('5Will import');
  await expect(stats).toContainText('3Errors');
  const notes = page.locator('#eb-preview tbody');
  await expect(notes).toContainText('"Waterbill" → "Water bill"');
  await expect(notes).toContainText('"Watchman Salary - Deepak" → "Watchman Salary" (+ comment "Deepak")');
  await expect(notes).toContainText('looks like a duplicate of row 6');
  await expect(notes).toContainText('Category is missing');
  await expect(notes).toContainText('not a valid MM-DD-YYYY date');
  await expect(notes).toContainText('Amount must be more than ₹0');
  expect((await sql(request, `select count(*)::int c from jdb.expenses`))[0].c).toBe(0); // preview saves nothing
  await page.click('#eb-import'); await page.click('#confirm-modal-yes');
  await expect(page.locator('#eb-preview')).toContainText('Imported. 5 expenses added');
  const rows = await sql(request, `select month, jsonb_array_length(data->'items') n from jdb.expenses order by month`);
  expect(rows).toEqual([{ month: '2026-07', n: 2 }, { month: '2026-08', n: 3 }]);
  const w = (await sql(request, `select i from jdb.expenses, jsonb_array_elements(data->'items') i where month='2026-07' and i->>'category'='Watchman Salary'`))[0].i;
  expect(w).toMatchObject({ paidOn: '2026-07-29', amount: 15000, comment: 'Deepak', mode: 'Cash' });
  // shows in that month's summary
  await page.fill('#exp-month', '2026-08'); await page.dispatchEvent('#exp-month', 'change');
  await expect(page.locator('#exp-summary-wrap')).toContainText('Terrace pipe repair');
  await expect(page.locator('#exp-payments-total')).toContainText('63,754');
  // uploading the same file again imports nothing by default
  await page.setInputFiles('#eb-file', EXPENSE_FILE());
  await expect(page.locator('#eb-preview .stats').first()).toContainText('0Will import');
  await expect(page.locator('#eb-import')).toBeDisabled();
});

test('maintenance bulk upload: preview, validation, arrears, import; admin and owner both see it', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'entry');
  await page.setInputFiles('#mb-file', MAINT_FILE());
  await expect(page.locator('#mb-import')).toBeVisible();
  const stats = page.locator('#mb-preview .stats').first();
  await expect(stats).toContainText('8Rows in file');
  await expect(stats).toContainText('6Will import');
  await expect(stats).toContainText('2Errors');
  const body = page.locator('#mb-preview tbody');
  await expect(body).toContainText('flat "999" not found');
  await expect(body).toContainText('"Augst" is not a month');
  await expect(body).toContainText('opening arrears ₹3,000 carried into July 2026');
  await page.click('#mb-import'); await page.click('#confirm-modal-yes');
  await expect(page.locator('#mb-preview')).toContainText('Imported. 6 new');
  const rows = await sql(request, `select flat_id, month, data from jdb.payments order by flat_id, month`);
  expect(rows).toHaveLength(6);
  const f104 = rows.filter(r => r.flat_id === 'id11');
  expect(f104[0].data).toMatchObject({ paid: true, amount: 2000, verified: true, carryInOverride: 3000, mode: 'UPI', date: '2026-07-03' });
  expect(rows.find(r => r.flat_id === 'id2').data).toMatchObject({ mode: 'Bank Transfer', date: '2026-07-03' });
  expect(rows.find(r => r.flat_id === 'id15').data).toMatchObject({ mode: 'UPI', amount: 1500 });
  const hist = await sql(request, `select distinct changed_by from jdb.payment_history`);
  expect(hist).toEqual([{ changed_by: 'import:admin1' }]);
  // admin Entry for July reflects it
  await page.fill('#entry-month', '2026-07'); await page.dispatchEvent('#entry-month', 'change');
  await expect(page.locator('#entry-tbody tr[data-id="id11"] .e-paid')).toBeChecked();
  await expect(page.locator('#entry-tbody tr[data-id="id11"] td').nth(3)).toContainText('5,000'); // 2000 + 3000 arrears
  // owner of 104 sees both months in My Ledger, with the arrears carried
  const ctx = await browser.newContext({ baseURL: API });
  const owner = await ctx.newPage();
  await openApp(owner); await loginOwner(owner, { flatId: 'id11', pin: '1011' });
  const hist104 = owner.locator('#my-history-wrap tbody');
  await expect(hist104).toContainText('August 2026');
  await expect(hist104.locator('tr', { hasText: 'July 2026' })).toContainText('Verified');
  await expect(hist104.locator('tr', { hasText: 'July 2026' })).toContainText('₹3,000 owed');
  await ctx.close();
  // re-upload: existing records are skipped unless Overwrite is ticked
  await page.setInputFiles('#mb-file', MAINT_FILE());
  await expect(page.locator('#mb-preview .stats').first()).toContainText('0Will import');
  await page.locator('#mb-preview .mb-over').first().check();
  await expect(page.locator('#mb-preview .stats').first()).toContainText('1Will import');
});

test('screenshot clean-up removes only past months and keeps every payment detail', async ({ page, request }, testInfo) => {
  only(testInfo);
  // current-month screenshot from an owner
  await openApp(page); await loginOwner(page, { flatId: 'id3', pin: '1003' });
  await page.selectOption('#my-pay-mode', 'UPI');
  await ownerUploadShot(page);
  await page.click('#my-mark-paid-btn'); await settle(page);
  const cur = (await sql(request, `select month from jdb.payments where flat_id='id3'`))[0].month;
  const [y, m] = cur.split('-').map(Number);
  const prev = new Date(y, m - 2, 1); const prevM = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const old = new Date(y, m - 3, 1); const oldM = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}`;
  // past-month rows pointing at files (verified previous month, unverified previous month, older month) + an orphan
  await sql(request, `
    insert into storage.objects(bucket_id, name) values
      ('jdb-screenshots','id4/${prevM}/a.jpg'), ('jdb-screenshots','id5/${prevM}/b.jpg'),
      ('jdb-screenshots','id6/${oldM}/c.jpg'), ('jdb-screenshots','id7/${oldM}/orphan.jpg'),
      ('other-bucket','id6/${oldM}/c.jpg')`);
  await sql(request, `
    insert into jdb.payments(flat_id, month, data, screenshot_path) values
      ('id4','${prevM}','{"paid":true,"amount":2000,"verified":true,"mode":"UPI"}','id4/${prevM}/a.jpg'),
      ('id5','${prevM}','{"paid":true,"amount":2000,"verified":false,"mode":"UPI"}','id5/${prevM}/b.jpg'),
      ('id6','${oldM}','{"paid":true,"amount":1800,"verified":false,"mode":"Cash"}','id6/${oldM}/c.jpg')`);
  const run = async (body) => (await request.post(`${API}/functions/v1/jdb-cleanup`, { headers: { 'x-cleanup-key': 'test-cleanup-key' }, data: body })).json();
  // wrong key is refused
  expect((await request.post(`${API}/functions/v1/jdb-cleanup`, { headers: { 'x-cleanup-key': 'nope' }, data: {} })).status()).toBe(401);
  // dry run changes nothing
  const dry = await run({ dryRun: true, now: `${cur}-02T10:00:00+05:30` });
  expect(dry.rowsCleared).toBe(0);
  expect((await sql(request, `select count(screenshot_path)::int c from jdb.payments`))[0].c).toBe(4);
  // on the 2nd: verified previous month + older month + orphan go; unverified previous month stays (grace until the 10th)
  const r1 = await run({ dryRun: false, now: `${cur}-02T10:00:00+05:30` });
  expect(r1.rowsCleared).toBe(2);
  let rows = await sql(request, `select flat_id, month, screenshot_path, data from jdb.payments order by flat_id`);
  const by = id => rows.find(r => r.flat_id === id);
  expect(by('id4').screenshot_path).toBeNull();
  expect(by('id4').data).toMatchObject({ paid: true, amount: 2000, verified: true, mode: 'UPI' }); // details untouched
  expect(by('id5').screenshot_path).toBe(`id5/${prevM}/b.jpg`);
  expect(by('id6').screenshot_path).toBeNull();
  expect(by('id6').data).toMatchObject({ amount: 1800, mode: 'Cash' });
  expect(by('id3').screenshot_path).toMatch(new RegExp(`^id3/${cur}/`)); // current month kept
  const objs = (await sql(request, `select bucket_id, name from storage.objects order by name`)).map(o => o.bucket_id + ':' + o.name);
  expect(objs).toContain(`other-bucket:id6/${oldM}/c.jpg`); // other buckets never touched
  expect(objs).not.toContain(`jdb-screenshots:id7/${oldM}/orphan.jpg`);
  // from the 10th the unverified previous-month screenshot goes too
  const r2 = await run({ dryRun: false, now: `${cur}-10T10:00:00+05:30` });
  expect(r2.rowsCleared).toBe(1);
  rows = await sql(request, `select flat_id, screenshot_path from jdb.payments order by flat_id`);
  expect(rows.find(r => r.flat_id === 'id5').screenshot_path).toBeNull();
  expect(rows.find(r => r.flat_id === 'id3').screenshot_path).not.toBeNull();
  // owner still sees the current screenshot; history rows are unchanged in count
  expect((await sql(request, `select count(*)::int c from jdb.payments`))[0].c).toBe(4);
  const logs = await sql(request, `select dry_run, rows_cleared from jdb.cleanup_log order by id`);
  expect(logs.map(l => l.rows_cleared)).toEqual([0, 2, 1]);
  // diagnostics show the last run
  await page.goto('/'); await openApp(page); await loginAdmin(page); await tab(page, 'settings');
  await page.click('#run-diagnostics-btn');
  await expect(page.locator('#diagnostics-output')).toContainText('Last screenshot clean-up');
});

test('owners cannot call the bulk import or change imported arrears', async ({ page, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'entry');
  await page.setInputFiles('#mb-file', MAINT_FILE());
  await page.click('#mb-import'); await page.click('#confirm-modal-yes');
  await expect(page.locator('#mb-preview')).toContainText('Imported.');
  await page.goto('/'); await openApp(page); await loginOwner(page, { flatId: 'id11', pin: '1011' });
  const res = await page.evaluate(async () => {
    const call = (fn, args) => fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: sessionToken, ...args }) }).then(r => r.status);
    return {
      bulk: await call('jdb_bulk_import_payments', { p_rows: [] }),
      exp: await call('jdb_bulk_add_expenses', { p_items: [] }),
    };
  });
  expect(res.bulk).toBeGreaterThanOrEqual(400);
  expect(res.exp).toBeGreaterThanOrEqual(400);
});

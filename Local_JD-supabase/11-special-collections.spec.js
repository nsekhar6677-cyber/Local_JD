// Special (one-time) collections: kept separate from maintenance, paid by owners
// like maintenance (amount + mode + screenshot), verified by admin, and counted
// as a receipt in the expense report for the collection's month.
import { test, expect } from '@playwright/test';
import { resetDb, sql, month, openApp, loginAdmin, loginOwner, tab, settle, testImage, noHorizontalOverflow, API } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });
const FULL = ['laptop-1366', 'iphone-14', 'pixel-7'];
const only = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'runs on laptop, iPhone and Android profiles');

async function createCollection(page, { title = 'Lift repair contribution', amount = '1500', due = '' } = {}) {
  await tab(page, 'collections');
  await page.fill('#coll-title', title);
  await page.fill('#coll-amount', amount);
  if (due) await page.fill('#coll-due', due);
  await page.fill('#coll-note', 'Lift motor replacement');
  await page.click('#coll-create-btn');
  await settle(page);
}
const row = (page, fid) => page.locator(`#coll-grid-wrap tr[data-fid="${fid}"]`);

test('admin creates a collection; title, month and amount are required', async ({ page, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'collections');
  await page.click('#coll-create-btn');
  await expect(page.locator('#coll-create-msg')).toContainText('Please fill: Title, Amount per flat');
  await createCollection(page);
  await expect(page.locator('#coll-create-msg')).toContainText('Created "Lift repair contribution"');
  await expect(page.locator('#coll-stats')).toContainText('35Flats');
  await expect(page.locator('#coll-stats')).toContainText('₹52,500Expected');
  const rows = await sql(request, `select month, data from jdb.collections`);
  expect(rows).toHaveLength(1);
  expect(rows[0].month).toBe(month());
  expect(rows[0].data).toMatchObject({ title: 'Lift repair contribution', amount: 1500, closed: false, flats: null });
  await noHorizontalOverflow(page);
});

test('owner pays with amount, mode and screenshot (all mandatory); admin verifies; maintenance untouched', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await createCollection(page);
  const o = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(o); await loginOwner(o, { flatId: 'id3', pin: '1003' });
  const item = o.locator('#my-coll-open .coll-item').first();
  await expect(item).toContainText('Lift repair contribution');
  await expect(item).toContainText('₹1,500');
  await item.locator('.mc-amt').fill('');
  await item.locator('.mc-submit').click();
  await expect(item.locator('.mc-msg li')).toHaveText([
    'Amount paid — enter the amount you paid',
    'Mode — choose UPI, Cash, Bank Transfer or Cheque',
    'Payment screenshot — upload a screenshot of your payment',
  ]);
  expect(await sql(request, `select * from jdb.collection_payments`)).toHaveLength(0);
  await item.locator('.mc-amt').fill('1500');
  await item.locator('.mc-mode').selectOption('UPI');
  await item.locator('.mc-shot-input').setInputFiles(testImage());
  await o.locator('#my-coll-open .coll-item').first().locator('.mc-submit').click();
  await expect(o.locator('#my-coll-open .coll-item').first()).toContainText('awaiting verification');
  const cp = (await sql(request, `select flat_id, data, screenshot_path from jdb.collection_payments`))[0];
  expect(cp).toMatchObject({ flat_id: 'id3' });
  expect(cp.data).toMatchObject({ paid: true, amount: 1500, mode: 'UPI', verified: false });
  expect(cp.screenshot_path).toMatch(/^id3\//);
  // maintenance for that flat is not touched
  expect(await sql(request, `select * from jdb.payments`)).toHaveLength(0);
  await expect(o.locator('#my-current-status')).toContainText('Pending');
  // admin verifies
  await page.reload(); await openApp(page); await loginAdmin(page); await tab(page, 'collections');
  await expect(row(page, 'id3')).toContainText('Submitted');
  await row(page, 'id3').locator('.cg-ver').check(); await settle(page);
  await expect(row(page, 'id3')).toContainText('Verified');
  expect((await sql(request, `select (data->>'verified')::boolean v from jdb.collection_payments where flat_id='id3'`))[0].v).toBe(true);
  // owner now sees it locked
  await o.reload(); await openApp(o); await loginOwner(o, { flatId: 'id3', pin: '1003' });
  await expect(o.locator('#my-coll-open')).toContainText('Locked after verification');
  await noHorizontalOverflow(o);
  await o.close();
});

test('collected amount shows in Expenses receipts, Reports, exports and the owner Society funds', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  const m = month();
  await sql(request, `insert into jdb.expenses(month, data) values ('${m}', '{"items":[{"id":"x1","category":"Diesel","paidOn":"${m}-02","amount":5000}],"openingOverride":20000,"maintReceivedOverride":null}')`);
  await openApp(page); await loginAdmin(page); await createCollection(page);
  for (const fid of ['id1', 'id2']) { await row(page, fid).locator('.cg-amt').fill('1500'); await row(page, fid).locator('.cg-amt').press('Tab'); await settle(page); }
  await expect(page.locator('#coll-stats')).toContainText('₹3,000Collected');
  await tab(page, 'expenses');
  await page.fill('#exp-month', m); await page.dispatchEvent('#exp-month', 'change');
  await expect(page.locator('#exp-special')).toContainText('Lift repair contribution ₹3,000');
  await expect(page.locator('#exp-receipts-stats')).toContainText('₹23,000Total receipts');
  await expect(page.locator('#exp-receipts-stats')).toContainText('₹18,000');
  await tab(page, 'reports');
  await page.selectOption('#rpt-period-type', 'monthly');
  await page.fill('#rpt-period-month', m); await page.dispatchEvent('#rpt-period-month', 'change');
  await expect(page.locator('#rpt-exp-table tr.special-row')).toContainText('Special collection: Lift repair contribution');
  await expect(page.locator('#rpt-exp-table tr.receipts-total')).toContainText('23,000');
  await expect(page.locator('#rpt-exp-table tr.balance-row')).toContainText('18,000');
  await expect(page.locator('#rpt-coll-summary')).toContainText('2 of 35 flats paid');
  await page.click('#rpt-wa-btn');
  await expect(page.locator('#rpt-exp-output')).toContainText('Special collection — Lift repair contribution: ₹3,000');
  if (testInfo.project.name === 'laptop-1366') {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rpt-csv-btn')]);
    const fs = await import('fs');
    expect(fs.readFileSync(await dl.path(), 'utf8')).toContain('Special collection: Lift repair contribution');
  }
  // owner society funds include it
  const o = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(o); await loginOwner(o, { flatId: 'id3', pin: '1003' });
  await expect(o.locator('#my-society-funds')).toContainText('₹3,000Special collections');
  await expect(o.locator('#my-society-funds-note')).toContainText('₹20,000 + ₹0 + ₹3,000 − ₹5,000 = ₹18,000');
  await noHorizontalOverflow(o);
  await o.close();
});

test('waive, not-applicable flats, closing and delete rules', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await createCollection(page);
  await row(page, 'id5').locator('.cg-waive').check(); await settle(page);
  await row(page, 'id6').locator('.cg-applies').uncheck(); await settle(page);
  await expect(page.locator('#coll-stats')).toContainText('34Flats');
  await expect(page.locator('#coll-stats')).toContainText('₹49,500Expected'); // 33 × 1,500
  // flat id6 no longer sees the collection
  const o = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(o); await loginOwner(o, { flatId: 'id6', pin: '1006' });
  await expect(o.locator('#my-coll-card')).toBeHidden();
  await o.close();
  // close it: owners can't submit (server refuses)
  await page.click('#coll-close-btn'); await settle(page);
  const cid = (await sql(request, `select id from jdb.collections`))[0].id;
  const o2 = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(o2); await loginOwner(o2, { flatId: 'id3', pin: '1003' });
  await expect(o2.locator('#my-coll-open')).toContainText('Closed by the admin');
  const status = await o2.evaluate(async (cid) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/jdb_save_collection_payment`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: sessionToken, p_collection_id: cid, p_flat_id: 'id3', p_data: { paid: true, amount: 1500, mode: 'UPI', screenshotPath: 'id3/2026-10/x.jpg' } }) });
    return r.text();
  }, cid);
  expect(status).toContain('COLLECTION_CLOSED');
  // an owner can never pay for another flat
  const other = await o2.evaluate(async (cid) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/jdb_save_collection_payment`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: sessionToken, p_collection_id: cid, p_flat_id: 'id4', p_data: { paid: false } }) });
    return r.text();
  }, cid);
  expect(other).toContain('FORBIDDEN');
  await o2.close();
  // reopen, record a payment → delete is refused; without payments delete works
  await page.click('#coll-close-btn'); await settle(page);
  await row(page, 'id1').locator('.cg-amt').fill('1500'); await row(page, 'id1').locator('.cg-amt').press('Tab'); await settle(page);
  await page.click('#coll-del-btn');
  await expect(page.locator('#sync-error')).toContainText("can't be deleted");
  expect(await sql(request, `select id from jdb.collections`)).toHaveLength(1);
  await row(page, 'id1').locator('.cg-amt').fill(''); await row(page, 'id1').locator('.cg-amt').press('Tab'); await settle(page);
  await page.click('#coll-del-btn'); await page.click('#confirm-modal-yes'); await settle(page);
  await expect(page.locator('#coll-manage')).toContainText('No special collections yet');
  expect(await sql(request, `select id from jdb.collections`)).toHaveLength(0);
});

test('owners only see other flats’ paid amount — never their screenshots or modes', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await createCollection(page);
  await row(page, 'id1').locator('.cg-amt').fill('1500'); await row(page, 'id1').locator('.cg-amt').press('Tab'); await settle(page);
  await row(page, 'id1').locator('.cg-mode').selectOption('Cheque'); await settle(page);
  const o = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(o); await loginOwner(o, { flatId: 'id3', pin: '1003' });
  const data = await o.evaluate(async () => (await fetch(`${SUPABASE_URL}/rest/v1/rpc/jdb_load`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: sessionToken }) })).json());
  const otherRow = Object.entries(data.collectionPayments).find(([k]) => k.endsWith(':id1'))[1];
  expect(otherRow).toEqual({ paid: true, amount: 1500, waived: false });
  await o.close();
});

test('owner can remove the screenshot: before submitting, and after (withdraws the submission)', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await createCollection(page);
  const o = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(o); await loginOwner(o, { flatId: 'id3', pin: '1003' });
  const item = () => o.locator('#my-coll-open .coll-item').first();
  // chosen but not submitted → removed straight away, typed values kept
  await item().locator('.mc-mode').selectOption('UPI');
  await item().locator('.mc-shot-input').setInputFiles(testImage());
  await expect(item().locator('.mc-shot-remove')).toBeVisible();
  await item().locator('.mc-shot-remove').click();
  await expect(item().locator('.mc-shot-view')).toHaveCount(0);
  await expect(item().locator('.mc-shot-remove')).toHaveCount(0);
  await expect(item().locator('.mc-mode')).toHaveValue('UPI');
  // submit, then remove → asks, withdraws
  await item().locator('.mc-shot-input').setInputFiles(testImage());
  await item().locator('.mc-submit').click();
  await expect(item()).toContainText('awaiting verification');
  await item().locator('.mc-shot-remove').click();
  await expect(o.locator('#confirm-modal-text')).toContainText('withdraws your submission');
  await o.click('#confirm-modal-yes');
  await expect(item()).not.toContainText('awaiting verification');
  await expect(item().locator('.mc-shot-view')).toHaveCount(0);
  const r = (await sql(request, `select data, screenshot_path from jdb.collection_payments where flat_id='id3'`))[0];
  expect(r.screenshot_path).toBeNull();
  expect(r.data.paid).toBe(false);
  await o.close();
});

test('admin can remove a screenshot in the grid; the payment stays', async ({ page, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await createCollection(page);
  await row(page, 'id2').locator('.cg-amt').fill('1500'); await row(page, 'id2').locator('.cg-amt').press('Tab'); await settle(page);
  await expect(row(page, 'id2').locator('.cg-shot-rm')).toHaveCount(0);
  await row(page, 'id2').locator('.cg-shot-input').setInputFiles(testImage()); await settle(page);
  await expect(row(page, 'id2').locator('.cg-shot-view')).toBeVisible();
  await row(page, 'id2').locator('.cg-shot-rm').click();
  await expect(page.locator('#confirm-modal-text')).toContainText('payment amount and status stay');
  await page.click('#confirm-modal-yes'); await settle(page);
  await expect(row(page, 'id2').locator('.cg-shot-view')).toHaveCount(0);
  const r = (await sql(request, `select data, screenshot_path from jdb.collection_payments where flat_id='id2'`))[0];
  expect(r.screenshot_path).toBeNull();
  expect(r.data).toMatchObject({ paid: true, amount: 1500 });
});

test('pending owners WhatsApp report for a collection', async ({ page, request }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await createCollection(page, { due: `${month()}-15` });
  await row(page, 'id1').locator('.cg-amt').fill('1500'); await row(page, 'id1').locator('.cg-amt').press('Tab'); await settle(page);
  await row(page, 'id2').locator('.cg-waive').check(); await settle(page);
  await page.click('#coll-pending-btn');
  const out = page.locator('#coll-pending-output .report-box');
  await expect(out).toContainText('Lift repair contribution');
  await expect(out).toContainText('Collected: 1/34 flats (₹1,500 of ₹51,000)');
  await expect(out).toContainText('*Pending owners (33):*');
  await expect(out).not.toContainText('f001 —'); // paid
  await expect(out).not.toContainText('f002 —'); // waived
  await expect(out).toContainText('f003 — Anushree M. — ₹1,500 due');
  await expect(page.locator('#coll-wa-btn')).toBeVisible();
  await expect(page.locator('#coll-copy-btn')).toBeVisible();
  await noHorizontalOverflow(page);
});

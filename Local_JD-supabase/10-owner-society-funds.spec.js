// Flat owner page → Society overview → Society funds: previous month balance,
// collected, expenses and available balance for the current month (totals only).
import { test, expect } from '@playwright/test';
import { resetDb, sql, month, openApp, loginOwner, loginAdmin, tab, noHorizontalOverflow } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });
const FULL = ['laptop-1366', 'iphone-14', 'pixel-7'];
const only = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'runs on laptop, iPhone and Android profiles');
const prevOf = m => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 2, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

async function seed(request) {
  const cur = month(), prev = prevOf(cur);
  await sql(request, `insert into jdb.expenses(month, data) values
    ('${prev}', '{"items":[{"id":"p1","category":"Power bill","paidOn":"${prev}-10","amount":20000,"mode":"UPI","comment":"secret vendor note"}],"openingOverride":100000,"maintReceivedOverride":null}'),
    ('${cur}',  '{"items":[{"id":"c1","category":"Diesel","paidOn":"${cur}-05","amount":3000,"mode":"Cash","comment":"generator"},{"id":"c2","category":"Water bill","paidOn":"${cur}-06","amount":7000,"mode":"UPI","comment":""}],"openingOverride":null,"maintReceivedOverride":null}')`);
  // this month: 3 flats paid ₹2,000 each
  await sql(request, `insert into jdb.payments(flat_id, month, data) values
    ('id1','${cur}','{"paid":true,"amount":2000,"verified":true,"mode":"UPI"}'),
    ('id2','${cur}','{"paid":true,"amount":2000,"verified":true,"mode":"UPI"}'),
    ('id4','${cur}','{"paid":true,"amount":2000,"verified":false,"mode":"UPI"}')`);
  return { cur, prev };
}

test('owner sees previous month balance, collected, expenses and available balance', async ({ page, request }, testInfo) => {
  only(testInfo);
  await seed(request);
  await openApp(page); await loginOwner(page, { flatId: 'id3', pin: '1003' });
  await expect(page.locator('#my-society-stats .stat').nth(4)).toContainText('₹6,000');
  await expect(page.locator('#my-society-stats .stat').nth(4)).toContainText('Amount collected');
  const funds = page.locator('#my-society-funds');
  await expect(funds).toBeVisible();
  // prev month: 1,00,000 − 20,000 = 80,000 carried in; this month 80,000 + 6,000 − 10,000 = 76,000
  await expect(funds.locator('.stat').nth(0)).toContainText('₹80,000');
  await expect(funds.locator('.stat').nth(0)).toContainText('Previous month balance');
  await expect(funds.locator('.stat').nth(1)).toContainText('₹6,000');
  await expect(funds.locator('.stat').nth(2)).toContainText('₹10,000');
  await expect(funds.locator('.stat').nth(3)).toContainText('₹76,000');
  await expect(funds.locator('.stat').nth(3)).toContainText('Available balance');
  await expect(page.locator('#my-society-funds-note')).toContainText('₹80,000 + ₹6,000 − ₹10,000 = ₹76,000');
  await noHorizontalOverflow(page);
});

test('owner gets expense totals only — no categories, comments, dates or modes', async ({ page, request }, testInfo) => {
  only(testInfo);
  await seed(request);
  await openApp(page); await loginOwner(page, { flatId: 'id3', pin: '1003' });
  const data = await page.evaluate(async () => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/jdb_load`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: sessionToken }) });
    return r.json();
  });
  const txt = JSON.stringify(data.expenses);
  expect(txt).toContain('20000');
  for (const secret of ['secret vendor note', 'Power bill', 'Diesel', 'generator', 'paidOn', 'mode', 'category']) expect(txt).not.toContain(secret);
  await expect(page.locator('#tab-my')).not.toContainText('secret vendor note');
});

test('owner figures match the admin Expenses receipts; hidden when no expenses exist', async ({ page, browser, request }, testInfo) => {
  only(testInfo);
  // no expense data yet → funds box hidden
  await openApp(page); await loginOwner(page, { flatId: 'id3', pin: '1003' });
  await expect(page.locator('#my-society-stats')).toBeVisible();
  await expect(page.locator('#my-society-funds-wrap')).toBeHidden();
  const { cur } = await seed(request);
  const a = await browser.newPage({ viewport: page.viewportSize() });
  await openApp(a); await loginAdmin(a); await tab(a, 'expenses');
  await a.fill('#exp-month', cur); await a.dispatchEvent('#exp-month', 'change');
  await expect(a.locator('#exp-receipts-stats')).toContainText('76,000');
  await a.close();
  await page.reload(); await openApp(page); await loginOwner(page, { flatId: 'id3', pin: '1003' });
  await expect(page.locator('#my-society-funds .stat').nth(3)).toContainText('₹76,000');
});

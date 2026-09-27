// Reports: combined maintenance + expense summary for a chosen period, with
// Print / Save as PDF, CSV and Excel downloads. Expenses page: simplified
// (receipts with balance c/f, items, bulk upload, totals). Receipts on phones.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import XLSX from 'xlsx';
import { resetDb, sql, openApp, loginAdmin, tab, noHorizontalOverflow } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });

const FULL = ['laptop-1366', 'iphone-14', 'pixel-7'];
const only = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'runs on laptop, iPhone and Android profiles');

const item = (id, category, paidOn, amount, mode, comment) => ({ id, category, paidOn, amount, mode, comment });
async function seed(request) {
  const jul = { items: [item('a1', 'Diesel', '2026-07-19', 3000, 'UPI', 'Generator'), item('a2', 'Power bill', '2026-07-20', 28287, 'Bank Transfer', '')], openingOverride: 10000, maintReceivedOverride: 70000 };
  const aug = { items: [item('b1', 'Repair & Maintenance', '2026-08-16', 1500, 'Cash', 'Terrace pipe repair'), item('b2', 'Power bill', '2026-08-21', 41898, 'UPI', '')], maintReceivedOverride: 68000 };
  await sql(request, `insert into jdb.expenses(month, data) values ('2026-07', '${JSON.stringify(jul)}'), ('2026-08', '${JSON.stringify(aug)}')`);
}
async function customRange(page, from, to) {
  await tab(page, 'reports');
  await page.selectOption('#rpt-period-type', 'custom');
  await page.fill('#rpt-period-from', from); await page.dispatchEvent('#rpt-period-from', 'change');
  await page.fill('#rpt-period-to', to); await page.dispatchEvent('#rpt-period-to', 'change');
}

test('expense page is simplified: old summary/publish cards are gone, receipts show balance c/f', async ({ page, request }, testInfo) => {
  only(testInfo);
  await seed(request);
  await openApp(page); await loginAdmin(page); await tab(page, 'expenses');
  for (const id of ['#exp-summary-wrap', '#exp-report-btn', '#exp-range-btn', '#exp-balance-box', '#exp-print-btn'])
    await expect(page.locator(id)).toHaveCount(0);
  await expect(page.locator('#tab-expenses')).not.toContainText('Publish monthly summary');
  await expect(page.locator('#tab-expenses')).not.toContainText('Publish time-range summary');
  await expect(page.locator('#exp-add-item-btn')).toBeVisible();
  await expect(page.locator('#exp-bulk-card summary')).toContainText('Bulk upload expenses');
  await page.fill('#exp-month', '2026-07'); await page.dispatchEvent('#exp-month', 'change');
  const stats = page.locator('#exp-receipts-stats');
  await expect(stats).toContainText('80,000');   // 10,000 b/f + 70,000 received
  await expect(stats).toContainText('31,287');   // payments
  await expect(stats).toContainText('48,713');   // available funds — balance c/f
  await expect(stats).toContainText(/Available funds/i);
  await expect(page.locator('#exp-items-total')).toContainText('31,287');
  // next month picks up the carried-forward balance automatically
  await page.fill('#exp-month', '2026-08'); await page.dispatchEvent('#exp-month', 'change');
  await expect(page.locator('#exp-opening')).toHaveValue('48713');
  await expect(stats).toContainText('73,315'); // 48,713 + 68,000 − 43,398
  await noHorizontalOverflow(page);
});

test('reports: expense summary for a custom range, with comments, mode and category totals', async ({ page, request }, testInfo) => {
  only(testInfo);
  await seed(request);
  await openApp(page); await loginAdmin(page);
  await tab(page, 'reports');
  await expect(page.locator('#rpt-month')).toHaveCount(0);            // old "Monthly report" removed
  await expect(page.locator('#tab-reports')).not.toContainText('Monthly report');
  await customRange(page, '2026-07', '2026-08');
  const box = page.locator('#rpt-exp-summary');
  await expect(box).toContainText('July 2026 – August 2026');
  await expect(box).toContainText('Terrace pipe repair');
  await expect(box).toContainText('Bank Transfer');
  await expect(box).toContainText('Payments by category');
  await expect(box.locator('tr.receipts-total')).toContainText('1,48,000'); // 10,000 + 70,000 + 68,000
  await expect(box.locator('tr.payments-total')).toContainText('74,685');
  await expect(box.locator('tr.balance-row')).toContainText('73,315');
  // maintenance collection for the same period is on the same page
  await expect(page.locator('#rpt-period-bars')).toContainText('Jul');
  await expect(page.locator('#rpt-period-bars')).toContainText('Aug');
  // single month
  await page.selectOption('#rpt-period-type', 'monthly');
  await page.fill('#rpt-period-month', '2026-07'); await page.dispatchEvent('#rpt-period-month', 'change');
  await expect(box).toContainText('Generator');
  await expect(box).not.toContainText('Terrace pipe repair');
  await expect(box.locator('tr.balance-row')).toContainText('48,713');
  // WhatsApp text
  await page.click('#rpt-wa-btn');
  await expect(page.locator('#rpt-exp-output')).toContainText('(Generator)');
  // invalid range
  await customRange(page, '2026-09', '2026-07');
  await expect(box).toContainText('Pick a valid period');
  await noHorizontalOverflow(page);
});

test('reports: CSV and Excel downloads for the selected range', async ({ page, request }, testInfo) => {
  only(testInfo);
  test.skip(testInfo.project.name !== 'laptop-1366', 'download check on laptop only');
  await seed(request);
  await openApp(page); await loginAdmin(page);
  await customRange(page, '2026-07', '2026-08');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#rpt-csv-btn')]);
  expect(csvDl.suggestedFilename()).toBe('Expense_summary_2026-07_to_2026-08.csv');
  const csv = fs.readFileSync(await csvDl.path(), 'utf8');
  expect(csv).toContain('Comments');
  expect(csv).toContain('Terrace pipe repair');
  expect(csv).toContain('Bank Transfer');
  expect(csv).toMatch(/"Total payments","74685"/);
  const [xDl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#rpt-xlsx-btn')]);
  expect(xDl.suggestedFilename()).toBe('Expense_summary_2026-07_to_2026-08.xlsx');
  const wb = XLSX.read(fs.readFileSync(await xDl.path()));
  expect(wb.SheetNames).toEqual(['Summary', 'Expenses', 'Maintenance']);
  const items = XLSX.utils.sheet_to_json(wb.Sheets.Expenses, { header: 1 });
  expect(items[0]).toEqual(['Month', 'Paid on', 'Category', 'Mode', 'Comments', 'Amount']);
  expect(items.some(r => r.includes('Terrace pipe repair') && r.includes(1500))).toBe(true);
  expect((await sql(request, `select count(*)::int c from jdb.expenses`))[0].c).toBe(2); // exports change nothing
});

test('reports: Print / Save as PDF prints only the expense summary', async ({ page, request }, testInfo) => {
  only(testInfo);
  await seed(request);
  await openApp(page); await loginAdmin(page);
  await customRange(page, '2026-07', '2026-08');
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('#rpt-print-btn');
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#rpt-exp-print')).toBeVisible();
  await expect(page.locator('#rpt-period-stats')).toBeHidden();
  await expect(page.locator('#rpt-exp-print')).toContainText('Terrace pipe repair');
});

test('receipts on phones: fields stack, totals fit on one line each, no sideways scroll', async ({ page, request }, testInfo) => {
  only(testInfo);
  await seed(request);
  await openApp(page); await loginAdmin(page); await tab(page, 'expenses');
  await page.fill('#exp-month', '2026-07'); await page.dispatchEvent('#exp-month', 'change');
  await noHorizontalOverflow(page);
  const box = id => page.locator(id).boundingBox();
  const a = await box('#exp-opening'), b = await box('#exp-maint');
  const phone = (page.viewportSize().width <= 600);
  if (phone) expect(b.y).toBeGreaterThan(a.y + a.height - 1);   // stacked
  else expect(Math.abs(b.y - a.y)).toBeLessThan(2);              // side by side
  // every total value sits on a single line and inside its card
  const vals = await page.$$eval('#exp-receipts-stats .stat', els => els.map(s => {
    const b = s.querySelector('b'), r = b.getBoundingClientRect(), c = s.getBoundingClientRect();
    return { lines: Math.round(r.height / parseFloat(getComputedStyle(b).lineHeight || r.height)), inside: r.right <= c.right + 1 && r.left >= c.left - 1, h: r.height, fs: parseFloat(getComputedStyle(b).fontSize) };
  }));
  expect(vals).toHaveLength(3);
  for (const v of vals) { expect(v.inside).toBe(true); expect(v.h).toBeLessThan(v.fs * 2); }
  // expense summary table fits the phone width too
  await customRange(page, '2026-07', '2026-08');
  const fit = await page.$eval('#rpt-exp-summary', e => e.scrollWidth <= e.clientWidth + 1);
  expect(fit).toBe(true);
});

test('reports: an unpaid balance carried month to month is counted once in the period Expected', async ({ page, request }, testInfo) => {
  only(testInfo);
  // every flat pays its ₹2,000 share for Apr–Sep; flat id11 starts April with ₹3,000 old arrears
  // that stay open; flat id20 skips April and pays ₹4,000 in May
  const rows = [];
  const flats = await sql(request, `select id from jdb.flats order by id`);
  for (const mo of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
    for (const { id } of flats) {
      let amount = 2000;
      if (id === 'id20' && mo === '2026-04') amount = 0;
      if (id === 'id20' && mo === '2026-05') amount = 4000;
      const data = { paid: amount > 0, amount, verified: amount > 0, mode: 'UPI', baseOverride: 2000, imported: true };
      if (id === 'id11' && mo === '2026-04') data.carryInOverride = 3000;
      rows.push(`('${id}','${mo}','${JSON.stringify(data)}')`);
    }
  }
  await sql(request, `insert into jdb.payments(flat_id, month, data) values ${rows.join(',')}`);
  const shares = flats.length * 2000 * 6;
  const fmt = n => n.toLocaleString('en-IN');
  await openApp(page); await loginAdmin(page);
  await customRange(page, '2026-04', '2026-09');
  const stats = page.locator('#rpt-period-stats');
  await expect(stats).toContainText(`₹${fmt(shares)}Collected`);
  await expect(stats).toContainText(`₹${fmt(shares + 3000)}Expected`); // shares + ₹3,000 once (not ₹20,000 extra)
  // single months still show that month's due including the balance brought in
  await customRange(page, '2026-05', '2026-05');
  await expect(stats).toContainText(`₹${fmt(flats.length * 2000 + 3000 + 2000)}Expected`);
  await page.click('#rpt-period-btn');
  await expect(page.locator('#rpt-period-output')).toContainText('TOTAL');
});

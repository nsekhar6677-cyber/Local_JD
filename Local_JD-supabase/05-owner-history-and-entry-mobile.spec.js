// 1) Owner "My payment history" must include (and keep up to date) the current
//    month at any hour — it used to drop the current month between midnight
//    and 5:30 AM IST, and didn't refresh until the owner signed in again.
// 2) Entry on phones: Amount / Date / Mode fields line up at the same size.
import { test, expect } from '@playwright/test';
import { resetDb, sql, openApp, loginAdmin, loginOwner, tab, settle, API, ownerUploadShot } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });

const monthLabel = d => d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

for (const at of ['02:00', '14:00', '23:50']) {
  test(`owner history shows the current month right after submitting (${at} IST)`, async ({ page }) => {
    const now = new Date(`2026-10-01T${at}:00+05:30`); // first day of a month = hardest case
    await page.clock.setFixedTime(now);
    await openApp(page);
    await loginOwner(page, { flatId: 'id3', pin: '1003' });
    await expect(page.locator('#my-month-label')).toHaveText(monthLabel(now));
    const first = page.locator('#my-history-wrap tbody tr').first();
    await expect(first).toContainText(monthLabel(now));
    await expect(first).toContainText('Pending');
    await page.selectOption('#my-pay-mode', 'UPI');
    await ownerUploadShot(page);
    await page.click('#my-mark-paid-btn');
    await settle(page);
    await expect(first).toContainText('Submitted');
    await expect(first).toContainText('UPI');
    await expect(first).toContainText('2026-10-01'); // paid date = local date, not yesterday's UTC date
  });
}

test('owner history updates by itself when the admin verifies on another device', async ({ page, browser, request }) => {
  await page.clock.install({ time: new Date('2026-10-15T11:00:00+05:30') });
  await openApp(page);
  await loginOwner(page, { flatId: 'id4', pin: '1004' });
  await page.selectOption('#my-pay-mode', 'Cash');
  await ownerUploadShot(page);
  await page.click('#my-mark-paid-btn');
  await settle(page);
  const first = page.locator('#my-history-wrap tbody tr').first();
  await expect(first).toContainText('Submitted');

  // admin verifies from a different device
  const ctx = await browser.newContext({ baseURL: API });
  await ctx.clock.setFixedTime(new Date('2026-10-15T11:01:00+05:30'));
  const admin = await ctx.newPage();
  await openApp(admin);
  await loginAdmin(admin);
  await tab(admin, 'entry');
  // Verified needs a screenshot; record it as admin-verified directly (same as ticking Verified)
  await sql(request, `update jdb.payments set data = data || '{"verified":true}' where flat_id='id4'`);
  await ctx.close();

  // owner keeps the page open: within a minute it refreshes on its own
  await page.clock.runFor(61_000);
  await expect(first).toContainText('Verified');
  await expect(page.locator('#my-upload-area')).toContainText('Verified by admin');
});

test('Entry on phones: Amount, Date and Mode fields line up', async ({ page }, testInfo) => {
  const width = testInfo.project.use.viewport?.width ?? 1280;
  test.skip(width >= 768, 'phone-only layout');
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  await page.locator('#entry-tbody tr[data-id="id2"] .e-paid').check();
  await settle(page);
  await page.locator('#entry-tbody tr[data-id="id2"] .e-mode').selectOption('Bank Transfer');
  await settle(page);
  const rows = await page.$$eval('#entry-tbody tr', trs => trs.slice(0, 6).map(tr => {
    const box = s => { const e = tr.querySelector(s); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { top: r.top, h: r.height, w: r.width, fs: parseFloat(cs.fontSize), rowMid: 0 }; };
    const r = tr.getBoundingClientRect();
    return { id: tr.dataset.id, rowMid: r.top + r.height / 2, amount: box('.e-amount'), date: box('.e-date'), mode: box('.e-mode') };
  }));
  for (const r of rows) {
    // same height and same top edge for all three fields
    expect(r.date.h, r.id).toBe(40);
    expect(r.mode.h, r.id).toBe(40);
    expect(r.amount.h, r.id).toBe(40);
    expect(Math.abs(r.date.top - r.mode.top), r.id).toBeLessThanOrEqual(1);
    expect(Math.abs(r.date.top - r.amount.top), r.id).toBeLessThanOrEqual(1);
    // vertically centred in the row
    expect(Math.abs(r.date.top + 20 - r.rowMid), r.id).toBeLessThanOrEqual(2);
    // date and mode columns the same width; "Bank Transfer" fits
    expect(r.date.w).toBe(156);
    expect(r.mode.w).toBe(156);
    // 16px text: iPhone won't zoom the page when the field is tapped
    expect(r.date.fs).toBeGreaterThanOrEqual(16);
    expect(r.mode.fs).toBeGreaterThanOrEqual(16);
    expect(r.amount.fs).toBeGreaterThanOrEqual(16);
  }
  const fits = await page.$eval('#entry-tbody tr[data-id="id2"] .e-mode', el => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);
  expect((await sql(page.request, `select data->>'mode' m from jdb.payments where flat_id='id2'`))[0].m).toBe('Bank Transfer');
});

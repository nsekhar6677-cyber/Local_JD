// Flat owner "Mark as paid & submit": amount, payment mode AND a payment
// screenshot are all required; anything missing shows an error and nothing is saved.
import { test, expect } from '@playwright/test';
import { resetDb, sql, month, openApp, loginOwner, settle, ownerUploadShot, API } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });

const paidRow = async (request, flat) =>
  (await sql(request, `select (data->>'paid')::boolean paid, data->>'mode' mode, (data->>'amount')::numeric amount, screenshot_path from jdb.payments where flat_id='${flat}' and month='${month()}'`))[0];

async function start(page, flatId = 'id3', pin = '1003') {
  await openApp(page);
  await loginOwner(page, { flatId, pin });
}

test('the form clearly marks all three fields as mandatory', async ({ page }) => {
  await start(page);
  await expect(page.locator('#my-required-note')).toContainText('All three are mandatory to submit: Amount paid, Mode and Payment screenshot');
  await expect(page.locator('label[for="my-pay-amount"] .req-star')).toBeVisible();
  await expect(page.locator('label[for="my-pay-mode"] .req-star')).toBeVisible();
  await expect(page.locator('#my-upload-area label', { hasText: 'Payment screenshot' }).locator('.req-star')).toBeVisible();
});

test('all three missing: error lists amount, mode and screenshot; nothing submitted', async ({ page, request }) => {
  await start(page);
  await page.fill('#my-pay-amount', '');
  await page.click('#my-mark-paid-btn');
  const msg = page.locator('#my-submit-msg');
  await expect(msg).toContainText('Not submitted — please fill the mandatory fields below');
  await expect(msg.locator('li')).toHaveText([
    'Amount paid — enter the amount you paid',
    'Mode — choose UPI, Cash, Bank Transfer or Cheque',
    'Payment screenshot — upload a screenshot of your payment',
  ]);
  await expect(page.locator('#my-pay-amount')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#my-pay-mode')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#my-shot-btn')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#my-current-status')).toContainText('Pending');
  expect(await paidRow(request, 'id3')).toBeUndefined();
});

test('screenshot missing only: blocked with a screenshot message', async ({ page, request }) => {
  await start(page);
  await page.selectOption('#my-pay-mode', 'UPI'); // amount is pre-filled with the due
  await page.click('#my-mark-paid-btn');
  await expect(page.locator('#my-submit-msg li')).toHaveText(['Payment screenshot — upload a screenshot of your payment']);
  await expect(page.locator('#my-pay-amount')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#my-pay-mode')).not.toHaveAttribute('aria-invalid', 'true');
  expect(await paidRow(request, 'id3')).toBeUndefined();
});

test('mode missing only: blocked with a mode message', async ({ page, request }) => {
  await start(page);
  await ownerUploadShot(page);
  await page.click('#my-mark-paid-btn');
  await expect(page.locator('#my-submit-msg li')).toHaveText(['Mode — choose UPI, Cash, Bank Transfer or Cheque']);
  const row = await paidRow(request, 'id3');
  expect(row.paid).toBeFalsy(); // screenshot saved, but not submitted
});

test('amount zero or empty: blocked (zero is NOT replaced by the due amount)', async ({ page, request }) => {
  await start(page);
  await ownerUploadShot(page);
  await page.selectOption('#my-pay-mode', 'Cash');
  for (const [v, text] of [['0', 'Amount paid — must be more than ₹0'], ['', 'Amount paid — enter the amount you paid']]) {
    await page.fill('#my-pay-amount', v);
    await page.click('#my-mark-paid-btn');
    await expect(page.locator('#my-submit-msg li')).toHaveText([text]);
    await expect(page.locator('#my-pay-amount')).toHaveValue(v);
    await expect(page.locator('#my-current-status')).toContainText('Pending');
  }
  expect((await paidRow(request, 'id3')).paid).toBeFalsy();
});

test('remove works right after uploading (before submitting)', async ({ page, request }) => {
  await start(page);
  await ownerUploadShot(page);
  expect((await paidRow(request, 'id3')).screenshot_path).toMatch(/^id3\//);
  await page.click('#my-shot-remove');
  await expect(page.locator('#confirm-modal-text')).toHaveText('Remove your uploaded screenshot for this month?');
  await page.click('#confirm-modal-yes');
  await settle(page);
  await expect(page.locator('.my-shot-view')).toHaveCount(0);
  await expect(page.locator('#my-shot-btn')).toHaveText('Upload screenshot');
  expect((await paidRow(request, 'id3')).screenshot_path).toBeNull();
  await expect(page.locator('#sync-error')).toBeHidden();
});

test('fixing the fields clears the error', async ({ page }) => {
  await start(page);
  await page.fill('#my-pay-amount', '');
  await page.click('#my-mark-paid-btn');
  await expect(page.locator('#my-submit-msg')).not.toBeEmpty();
  await page.fill('#my-pay-amount', '2000');
  await expect(page.locator('#my-pay-amount')).not.toHaveAttribute('aria-invalid', 'true');
  await page.selectOption('#my-pay-mode', 'UPI');
  await expect(page.locator('#my-pay-mode')).not.toHaveAttribute('aria-invalid', 'true');
  await ownerUploadShot(page); // re-renders the form; values typed before upload are kept
  await expect(page.locator('#my-pay-amount')).toHaveValue('2000');
  await expect(page.locator('#my-pay-mode')).toHaveValue('UPI');
  await expect(page.locator('#my-submit-msg')).toBeEmpty();
});

test('all three present: submits and is saved', async ({ page, request }) => {
  await start(page);
  await page.fill('#my-pay-amount', '2500');
  await page.selectOption('#my-pay-mode', 'Bank Transfer');
  await ownerUploadShot(page);
  await page.click('#my-mark-paid-btn');
  await settle(page);
  await expect(page.locator('#my-submit-msg')).toBeEmpty();
  await expect(page.locator('#my-current-status')).toContainText(/Submitted|Paid & verified/);
  await expect(page.locator('#my-history-wrap tbody tr').first()).toContainText('Bank Transfer');
  const row = await paidRow(request, 'id3');
  expect(row).toMatchObject({ paid: true, mode: 'Bank Transfer' });
  expect(Number(row.amount)).toBe(2500);
  expect(row.screenshot_path).toMatch(/^id3\//);
});

test('removing the screenshot after submitting withdraws the submission', async ({ page, request }) => {
  await start(page);
  await page.selectOption('#my-pay-mode', 'UPI');
  await ownerUploadShot(page);
  await page.click('#my-mark-paid-btn');
  await settle(page);
  expect((await paidRow(request, 'id3')).paid).toBe(true);
  await page.click('#my-shot-remove');
  await expect(page.locator('#confirm-modal-text')).toContainText('withdraws your submission');
  await page.click('#confirm-modal-yes');
  await settle(page);
  await expect(page.locator('#my-current-status')).toContainText('Pending');
  const row = await paidRow(request, 'id3');
  expect(row.paid).toBe(false);
  expect(row.screenshot_path).toBeNull();
});

test('server also refuses an owner submission without a screenshot', async ({ page }) => {
  await start(page);
  const status = await page.evaluate(async (m) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/jdb_save_payment`, {
      method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: sessionToken, p_flat_id: 'id3', p_month: m, p_data: { paid: true, amount: 2000, mode: 'UPI', screenshotPath: null } }),
    });
    return { status: r.status, body: await r.text() };
  }, month());
  expect(status.status).toBeGreaterThanOrEqual(400);
  expect(status.body).toContain('INCOMPLETE_SUBMISSION');
});

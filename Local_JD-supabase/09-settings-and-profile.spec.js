// Settings and Profile: short, simple cards; "About this app" removed; everything still works.
import { test, expect } from '@playwright/test';
import { resetDb, openApp, loginAdmin, tab, settle, noHorizontalOverflow } from './helpers.js';

test.beforeEach(async ({ request }) => { await resetDb(request); });
const FULL = ['laptop-1366', 'iphone-14', 'pixel-7'];
const only = (testInfo) => test.skip(!FULL.includes(testInfo.project.name), 'runs on laptop, iPhone and Android profiles');

test('settings: three short cards, no app information', async ({ page }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'settings');
  await expect(page.locator('#tab-settings .card h2')).toHaveText(['Society', 'Forgot-password question', 'Data']);
  await expect(page.locator('#tab-settings')).not.toContainText('About this app');
  await expect(page.locator('#tab-settings')).not.toContainText('Heads-up on security');
  await noHorizontalOverflow(page);
  // save still works
  await page.fill('#set-amount', '2100');
  await page.click('#save-settings-btn'); await settle(page);
  await expect(page.locator('#settings-saved-note')).toContainText('Saved');
  await page.fill('#set-recovery-q', 'Office street?'); await page.fill('#set-recovery-a', 'MG Road');
  await page.click('#save-recovery-btn'); await settle(page);
  await expect(page.locator('#recovery-saved-note')).not.toBeEmpty();
  // data check is short and readable
  await page.click('#run-diagnostics-btn');
  const out = page.locator('#diagnostics-output');
  await expect(out).toContainText('Supabase — connected');
  await expect(out).toContainText('Flats currently on file: 35');
  await expect(out).toContainText('Last screenshot clean-up');
  expect((await out.innerText()).split('\n').filter(Boolean).length).toBeLessThanOrEqual(7);
});

test('profile: one account card and the admins list', async ({ page }, testInfo) => {
  only(testInfo);
  await openApp(page); await loginAdmin(page); await tab(page, 'profile');
  await expect(page.locator('#tab-profile .card h2')).toHaveText(['My account', 'Admins']);
  await expect(page.locator('#tab-profile .card').first().locator('#my-admin-newpass')).toBeVisible();
  await expect(page.locator('#admins-tbody tr')).not.toHaveCount(0);
  await page.fill('#my-admin-name', 'Committee Chair');
  await page.click('#save-my-profile-btn'); await settle(page);
  await expect(page.locator('#my-profile-saved-note')).not.toBeEmpty();
  await noHorizontalOverflow(page);
});

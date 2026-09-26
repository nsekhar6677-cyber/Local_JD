// Proves the Supabase version renders pixel-identical screens to the original
// (pre-Supabase) app on every screen profile, and never scrolls sideways.
import { test, expect } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { resetDb, legacyStorageMock, openApp, loginAdmin, loginOwner, tab, noHorizontalOverflow } from './helpers.js';

const SCREENS = [
  { name: 'login-owner', role: null, prep: async () => {} },
  { name: 'login-admin', role: null, prep: async p => { await p.click('#toggle-admin'); } },
  { name: 'login-forgot-pin', role: null, prep: async p => { await p.click('#owner-forgot-link'); } },
  { name: 'user-guide', role: null, prep: async p => { await p.click('#owner-guide-link'); } },
  { name: 'admin-dashboard', role: 'admin', prep: async () => {} },
  { name: 'admin-flats', role: 'admin', prep: async p => tab(p, 'flats') },
  { name: 'admin-entry', role: 'admin', prep: async p => tab(p, 'entry') },
  { name: 'admin-reports', role: 'admin', prep: async p => tab(p, 'reports') },
  { name: 'admin-expenses', role: 'admin', prep: async p => tab(p, 'expenses') },
  { name: 'admin-settings', role: 'admin', prep: async p => tab(p, 'settings') },
  { name: 'admin-profile', role: 'admin', prep: async p => tab(p, 'profile') },
  { name: 'owner-ledger', role: 'owner', prep: async () => {} },
];

async function capture(browser, testInfo, variant, screen) {
  const u = testInfo.project.use;
  const opts = { baseURL: 'http://localhost:54321', timezoneId: 'Asia/Kolkata', locale: 'en-IN' };
  for (const k of ['viewport', 'screen', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent']) if (u[k] !== undefined) opts[k] = u[k];
  const ctx = await browser.newContext(opts);
  if (variant === 'original') await ctx.addInitScript(legacyStorageMock);
  // freeze animations/caret so screenshots are deterministic
  await ctx.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.appendChild(s);
    });
  });
  const page = await ctx.newPage();
  await openApp(page, variant === 'original' ? '/original.html' : '/');
  if (screen.role === 'admin') await loginAdmin(page);
  if (screen.role === 'owner') await loginOwner(page);
  await screen.prep(page);
  await page.waitForTimeout(250);
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  const png = await page.screenshot({ fullPage: true });
  const overflowOk = await noHorizontalOverflow(page);
  await ctx.close();
  return { png, overflowOk };
}

test.describe('design parity with the original app', () => {
  test.beforeAll(async ({ request }) => { await resetDb(request); });

  for (const screen of SCREENS) {
    test(`${screen.name} is identical`, async ({ browser }, testInfo) => {
      const before = await capture(browser, testInfo, 'original', screen);
      const after = await capture(browser, testInfo, 'supabase', screen);
      const a = PNG.sync.read(before.png);
      const b = PNG.sync.read(after.png);
      await testInfo.attach(`${screen.name}-original.png`, { body: before.png, contentType: 'image/png' });
      await testInfo.attach(`${screen.name}-supabase.png`, { body: after.png, contentType: 'image/png' });
      expect(`${b.width}x${b.height}`, 'page size').toBe(`${a.width}x${a.height}`);
      const diff = new PNG({ width: a.width, height: a.height });
      const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
      if (changed) await testInfo.attach(`${screen.name}-diff.png`, { body: PNG.sync.write(diff), contentType: 'image/png' });
      const ratio = changed / (a.width * a.height);
      expect(ratio, `${changed} pixels differ`).toBeLessThanOrEqual(0.001);
      expect(after.overflowOk, 'no sideways page scroll').toBe(before.overflowOk);
      expect.soft(after.overflowOk, 'no sideways page scroll').toBe(true);
    });
  }
});

import { expect } from '@playwright/test';
import { PNG } from 'pngjs';

export const API = 'http://localhost:54321';

export async function resetDb(request) {
  const r = await request.get(`${API}/__reset`);
  expect(r.ok()).toBeTruthy();
}

export async function sql(request, query) {
  const r = await request.post(`${API}/__sql`, { data: query, headers: { 'content-type': 'text/plain' } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).rows;
}

// current month in IST (the app uses the device's local calendar)
export function month() { return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7); }

// In-memory stand-in for the old Claude-artifact `window.storage` API so the
// ORIGINAL app can be rendered side by side for design-parity comparisons.
export const legacyStorageMock = () => {
  const store = new Map();
  window.storage = {
    async get(key) { return store.has(key) ? { key, value: store.get(key) } : null; },
    async set(key, value) { store.set(key, value); return { key, value }; },
    async delete(key) { store.delete(key); return { key, deleted: true }; },
    async list(prefix) { return { keys: [...store.keys()].filter(k => !prefix || k.startsWith(prefix)) }; },
  };
};

export async function openApp(page, path = '/') {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#owner-flat-select option').first()).toBeAttached();
  await expect(page.locator('#admin-profile-select option').first()).toBeAttached();
}

export async function loginAdmin(page, { adminId = 'admin1', password = 'admin123' } = {}) {
  await page.click('#toggle-admin');
  await page.selectOption('#admin-profile-select', adminId);
  await page.fill('#admin-pass', password);
  await page.click('#admin-login-btn');
  await expect(page.locator('#app-screen')).toBeVisible();
  await expect(page.locator('#dash-stats .stat').first()).toBeVisible();
}

export async function loginOwner(page, { flatId = 'id1', pin = '1001' } = {}) {
  await page.click('#toggle-owner');
  await page.selectOption('#owner-flat-select', flatId);
  await page.fill('#owner-pin', pin);
  await page.click('#owner-login-btn');
  await expect(page.locator('#app-screen')).toBeVisible();
  await expect(page.locator('#my-stats .stat').first()).toBeVisible();
}

export async function logout(page) {
  await page.click('#logout-btn');
  await expect(page.locator('#login-screen')).toBeVisible();
}

export async function tab(page, id) {
  await page.click(`#tabs button[data-tab="${id}"]`);
  await expect(page.locator(`#tab-${id}`)).toBeVisible();
}

// waits until every queued save has reached the server
export async function settle(page) {
  await page.waitForFunction(() => new Promise(r => saveChain.then(() => r(true))));
  await page.waitForLoadState('networkidle');
}

// a payment-screenshot-like test image (PNG)
export function testImage(label = 'UPI 2000') {
  const png = new PNG({ width: 320, height: 200 });
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 4;
    const on = (x > 20 && x < 300 && y > 60 && y < 140 && ((x + y) % 7 < 3));
    png.data[i] = on ? 20 : 240; png.data[i + 1] = on ? 90 : 245; png.data[i + 2] = on ? 60 : 240; png.data[i + 3] = 255;
  }
  return { name: `${label.replace(/\s+/g, '_')}.png`, mimeType: 'image/png', buffer: PNG.sync.write(png) };
}

export async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

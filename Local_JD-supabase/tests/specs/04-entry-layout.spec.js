// Entry tab on tablets, laptops and desktops: the whole row must be reachable
// without scrolling to the bottom of the page first — header, Flat column and
// the sideways scrollbar all stay on screen. Phones keep the original layout
// (covered by 01-design-parity).
import { test, expect } from '@playwright/test';
import { resetDb, openApp, loginAdmin, tab, noHorizontalOverflow } from './helpers.js';

const COLUMNS = ['Flat', 'Owner', 'Paid', 'Due (adj.)', 'Amount paid', 'Balance → next', 'Date', 'Mode', 'Proof', 'Auto-check', 'Verified', 'Waived'];

test.beforeEach(async ({ request }) => { await resetDb(request); });

test('Entry shows full rows with header, Flat column and scrollbar in view', async ({ page }, testInfo) => {
  const width = testInfo.project.use.viewport?.width ?? 1280;
  test.skip(width < 768, 'phones keep the original Entry layout');
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  const wrap = page.locator('#entry-table-wrap');
  // bring the table box fully on screen (as a user scrolling down a little would)
  await wrap.evaluate(el => el.scrollIntoView({ block: 'end' }));
  const m = await wrap.evaluate(el => {
    const r = el.getBoundingClientRect();
    const vis = [...el.querySelectorAll('thead th')].map(th => {
      const b = th.getBoundingClientRect();
      return { text: th.textContent.trim(), fullyVisible: b.left >= r.left - 1 && b.right <= r.right + 1 };
    });
    return { boxBottom: r.bottom, boxTop: r.top, vh: innerHeight, scrollW: el.scrollWidth, clientW: el.clientWidth, vis };
  });
  // the table's own scrollbar sits inside the screen, not 30+ rows further down
  expect(m.boxBottom).toBeLessThanOrEqual(m.vh + 1);
  expect(m.boxTop).toBeGreaterThanOrEqual(0);
  expect(m.vis.map(v => v.text)).toEqual(COLUMNS);
  if (width >= 1280) {
    // laptops and desktops: every column visible at once, no sideways scrolling at all
    expect(m.scrollW).toBeLessThanOrEqual(m.clientW + 1);
    expect(m.vis.every(v => v.fullyVisible)).toBe(true);
  }
  // scroll to the far right and further down the list: header + Flat column stay put
  await wrap.evaluate(el => { el.scrollLeft = el.scrollWidth; el.scrollTop = 1500; });
  await page.waitForTimeout(150);
  const s = await wrap.evaluate(el => {
    const r = el.getBoundingClientRect();
    const th = el.querySelector('thead th').getBoundingClientRect();
    const rows = [...el.querySelectorAll('tbody tr')];
    const row = rows.find(tr => { const b = tr.getBoundingClientRect(); return b.top > th.bottom + 5 && b.bottom < r.bottom; });
    const flat = row.querySelector('td').getBoundingClientRect();
    const waived = row.querySelector('.e-waived').getBoundingClientRect();
    return { headerTopOffset: th.top - r.top, flatLeftOffset: flat.left - r.left, flatText: row.querySelector('td').textContent.trim(), waivedVisible: waived.right <= r.right + 1 && waived.left >= r.left };
  });
  expect(Math.abs(s.headerTopOffset)).toBeLessThanOrEqual(2);
  expect(Math.abs(s.flatLeftOffset)).toBeLessThanOrEqual(2);
  expect(s.flatText).toMatch(/^f\d{3}$/);
  expect(s.waivedVisible).toBe(true);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test('Entry still saves from the far-right columns after scrolling', async ({ page }, testInfo) => {
  const width = testInfo.project.use.viewport?.width ?? 1280;
  test.skip(width < 768, 'phones keep the original Entry layout');
  await openApp(page);
  await loginAdmin(page);
  await tab(page, 'entry');
  const row = page.locator('#entry-tbody tr[data-id="id30"]');
  await row.locator('.e-waived').scrollIntoViewIfNeeded();
  await row.locator('.e-waived').check();
  await expect(page.locator('#entry-tbody tr[data-id="id30"] .e-waived')).toBeChecked();
  await expect(page.locator('#entry-tbody tr[data-id="id30"] td').nth(3)).toContainText('Waived');
});

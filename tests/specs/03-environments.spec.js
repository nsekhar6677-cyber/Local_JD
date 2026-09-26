// The live addresses must use the LIVE database; every other address
// (Vercel preview links, other domains) must use the TEST database.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '../../index.html'), 'utf8');
const LIVE_DB = 'https://dzjedqxhtxacchwkwhof.supabase.co';
const TEST_DB = 'https://omxdowsjtcyslfnrxouc.supabase.co';

const cases = [
  ['https://jdblossom-maintenance-tracker.vercel.app/', LIVE_DB, false],
  ['https://local-jd-nsekhar6677-cyber.vercel.app/', LIVE_DB, false],
  ['https://local-jd-git-test-feature-nsekhar6677-cyber.vercel.app/', TEST_DB, true],
  ['https://local-abc123xyz-nsekhar6677-cyber.vercel.app/', TEST_DB, true],
];

for (const [url, expectedDb, tagged] of cases) {
  test(`${new URL(url).hostname} uses the ${expectedDb === LIVE_DB ? 'LIVE' : 'TEST'} database`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'laptop-1366', 'address check only needs one profile');
    const dbCalls = [];
    await page.route('**/*', route => {
      const u = route.request().url();
      if (u === url) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (u.includes('.supabase.co')) { dbCalls.push(new URL(u).origin); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"flats":[],"admins":[]}' }); }
      return route.abort();
    });
    await page.goto(url);
    expect(await page.evaluate(() => SUPABASE_URL)).toBe(expectedDb);
    await expect.poll(() => dbCalls.length).toBeGreaterThan(0);
    expect(new Set(dbCalls)).toEqual(new Set([expectedDb]));
    await expect(page.getByText('TEST DATABASE')).toHaveCount(tagged ? 1 : 0);
    expect((await page.title()).startsWith('[TEST]')).toBe(tagged);
  });
}

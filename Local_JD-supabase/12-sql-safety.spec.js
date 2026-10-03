// Supabase blocks DELETE/UPDATE statements without a WHERE clause when they run through
// the website's API (pg-safeupdate). The local test database doesn't, so this check reads the
// final version of every database function in the migrations and fails if one has a bare
// "delete from x;" or "update x set ...;" (ON CONFLICT DO UPDATE is fine).
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

test('no database function deletes or updates a whole table without WHERE', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'laptop-1366', 'static check, runs once');
  const dir = path.join(process.cwd(), '..', 'supabase', 'migrations');
  const latest = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
    let m;
    while ((m = re.exec(sql))) latest[m[1].toLowerCase()] = { file: f, body: m[3] };
  }
  const bad = [];
  for (const [fn, { file, body }] of Object.entries(latest)) {
    for (const stmt of body.split(';')) {
      const s = stmt.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (/^delete from [\w.]+$/.test(s)) bad.push(`${fn} (${file}): ${s}`);
      if (/^update [\w.]+ (\w+ )?set /.test(s) && !/ where /.test(s) && !/ from /.test(s)) bad.push(`${fn} (${file}): ${s.slice(0, 80)}`);
    }
  }
  expect(bad).toEqual([]);
});

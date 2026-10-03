// Local stand-in for the Supabase project, used for end-to-end tests in a
// sandbox that can't reach supabase.co. It runs the REAL migration SQL inside
// PGlite (Postgres compiled to WASM) and emulates:
//   POST /rest/v1/rpc/<fn>          -> PostgREST RPC (executed as role anon)
//   POST /functions/v1/jdb-files    -> the jdb-files Edge Function (same logic)
//   GET  /storage/<path>?t=...      -> signed-URL downloads
// It also serves the app at / with SUPABASE_URL pointed at this server.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 54321);
const APP = process.env.APP || path.join(here, '../index.html');
const MIGRATIONS = process.env.MIGRATIONS || path.join(here, '../supabase/migrations');
const ORIGINAL = process.env.ORIGINAL || path.join(here, 'baseline/original-index.html'); // pre-Supabase version, for design-parity checks

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema extensions; create extension pgcrypto schema extensions;
  grant usage on schema extensions to public;
  create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id bigint generated always as identity primary key, bucket_id text, name text, created_at timestamptz default now(), metadata jsonb);
  grant usage on schema public to anon, authenticated, service_role;
`);
async function migrate() {
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    const sql = fs.readFileSync(`${MIGRATIONS}/${f}`, 'utf8');
    if (sql.includes('mock:skip')) continue; // needs pg_cron / pg_net / Vault
    await db.exec(sql);
  }
}
await migrate();

const files = new Map(); // path -> {buf, type}
const signed = new Map(); // token -> path
const backups = new Map(); // name -> {csv, at} (jdb-backups bucket)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

let queue = Promise.resolve(); // PGlite is single-connection: serialise
function q(fn) { const r = queue.then(fn); queue = r.catch(() => {}); return r; }

async function callRpc(fn, args, role = 'anon') {
  if (!/^jdb_[a-z_]+$/.test(fn)) throw Object.assign(new Error('not found'), { status: 404 });
  const names = Object.keys(args || {});
  const params = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
  const vals = names.map(n => { const v = args[n]; return (v !== null && typeof v === 'object' && !Array.isArray(v)) || (Array.isArray(v) && n !== 'p_deletes') ? JSON.stringify(v) : v; });
  return q(async () => {
    await db.exec(`set role ${role}`);
    try {
      const r = await db.query(`select public.${fn}(${params}) as r`, vals);
      return r.rows[0].r;
    } finally { await db.exec('reset role'); }
  });
}

let delayMs = Number(process.env.DELAY || 0);
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, 'ok');
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));

    if (req.method === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
      if (!req.headers.apikey) return send(res, 401, { message: 'No API key found in request' });
      const fn = url.pathname.slice('/rest/v1/rpc/'.length);
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const r = await callRpc(fn, body);
        return send(res, 200, r === undefined ? 'null' : JSON.stringify(r));
      } catch (e) {
        return send(res, e.status || 400, { code: 'P0001', message: e.message });
      }
    }

    // emulates the jdb-backup Edge Function (same backup CSV; keeps only the newest)
    if (req.method === 'POST' && url.pathname === '/functions/v1/jdb-backup') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const key = req.headers['x-cleanup-key'];
      if (key) { if (key !== 'test-cleanup-key') return send(res, 401, { error: 'UNAUTHORIZED' }); }
      else {
        const sess = await callRpc('jdb_session_info', { p_token: String(body.token || '') }, 'service_role');
        if (!sess) return send(res, 401, { error: 'SESSION_EXPIRED' });
        if (sess.role !== 'admin') return send(res, 403, { error: 'FORBIDDEN' });
      }
      const action = body.action || (key ? 'run' : 'status');
      if (action === 'run') {
        const all = async (sql) => (await q(() => db.query(sql))).rows;
        const flats = await all(`select id, flat_no, owner, phone, amount, pin, recovery_question, recovery_answer_hash from jdb.flats order by sort_order, id`);
        const pays = await all(`select flat_id, month, data, screenshot_path from jdb.payments`);
        const exps = await all(`select month, data from jdb.expenses`);
        const adm = await all(`select id, name, phone, password_hash from jdb.admins order by sort_order, id`);
        const st = (await all(`select * from jdb.settings where id = 1`))[0] || {};
        const cols = await all(`select id, month, data, created_at from jdb.collections order by month, created_at`);
        const cps = await all(`select collection_id, flat_id, data, screenshot_path from jdb.collection_payments`);
        const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
        const paymentsOut = {}; pays.forEach(p => { paymentsOut[`${p.flat_id}:${p.month}`] = { ...(p.data || {}), screenshotPath: p.screenshot_path ?? null }; });
        const expensesOut = {}; exps.forEach(e => { expensesOut[e.month] = e.data; });
        const cpOut = {}; cps.forEach(p => { cpOut[`${p.collection_id}:${p.flat_id}`] = { ...(p.data || {}), screenshotPath: p.screenshot_path ?? null }; });
        const settingsOut = { societyName: st.society_name, defaultAmount: num(st.default_amount), adminPhone: st.admin_phone || '', adminRecoveryQuestion: st.admin_recovery_question || '', lastCheck: st.last_check || null };
        if (st.admin_recovery_answer_hash) settingsOut.adminRecoveryAnswerHash = st.admin_recovery_answer_hash;
        const rows = [['key', 'value'], ['meta_app', st.society_name || 'JD Blossom Apartment'], ['meta_exportedAt', new Date().toISOString()], ['meta_source', 'automatic monthly backup'],
          ['flats', JSON.stringify(flats.map(f => ({ id: f.id, flatNo: f.flat_no, owner: f.owner, phone: f.phone, amount: num(f.amount), pin: f.pin, recoveryQuestion: f.recovery_question, ...(f.recovery_answer_hash ? { recoveryAnswerHash: f.recovery_answer_hash } : {}) })))],
          ['payments', JSON.stringify(paymentsOut)], ['settings', JSON.stringify(settingsOut)], ['expenses', JSON.stringify(expensesOut)],
          ['admins', JSON.stringify(adm.map(a => ({ id: a.id, name: a.name, phone: a.phone, passwordHash: a.password_hash })))],
          ['collections', JSON.stringify(cols.map(c => ({ ...(c.data || {}), id: c.id, month: c.month, createdAt: c.created_at })))],
          ['collectionPayments', JSON.stringify(cpOut)]];
        const csv = rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
        const now = body.now ? new Date(body.now) : new Date();
        const t = new Date(now.getTime() + 5.5 * 3600e3).toISOString();
        const name = `JDB_backup_${t.slice(0, 10)}_${t.slice(11, 13)}${t.slice(14, 16)}.csv`;
        backups.set(name, { csv, at: now.toISOString() });
        const old = [...backups.keys()].filter(n => n !== name);
        old.forEach(n => backups.delete(n));
        return send(res, 200, { ok: true, name, size: csv.length, removed: old.length });
      }
      if (action === 'status') {
        const names = [...backups.keys()].sort().reverse();
        if (!names.length) return send(res, 200, { latest: null });
        const n = names[0];
        return send(res, 200, { latest: { name: n, createdAt: backups.get(n).at, size: backups.get(n).csv.length, url: `http://localhost:${PORT}/backup-file/${encodeURIComponent(n)}` }, count: names.length });
      }
      return send(res, 400, { error: 'BAD_ACTION' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/backup-file/')) {
      const b = backups.get(decodeURIComponent(url.pathname.slice('/backup-file/'.length)));
      if (!b) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment' }); return res.end(b.csv);
    }
    if (url.pathname === '/__backups') return send(res, 200, { names: [...backups.keys()] });
    if (req.method === 'POST' && url.pathname === '/functions/v1/jdb-files') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sess = await callRpc('jdb_session_info', { p_token: String(body.token || '') }, 'service_role');
      if (!sess) return send(res, 401, { error: 'SESSION_EXPIRED' });
      if (body.action === 'upload') {
        const flatId = String(body.flatId || ''), month = String(body.month || '');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(flatId) || !/^\d{4}-\d{2}$/.test(month)) return send(res, 400, { error: 'BAD_INPUT' });
        if (sess.role === 'owner' && flatId !== sess.subject) return send(res, 403, { error: 'FORBIDDEN' });
        const m = String(body.dataUrl || '').match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return send(res, 400, { error: 'BAD_IMAGE' });
        const buf = Buffer.from(m[3], 'base64');
        const path = `${flatId}/${month}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
        files.set(path, { buf, type: m[1] });
        await q(() => db.query(`insert into storage.objects(bucket_id, name) values ('jdb-screenshots', $1)`, [path]));
        const t = crypto.randomUUID(); signed.set(t, path);
        return send(res, 200, { path, url: `http://localhost:${PORT}/storage/${path}?t=${t}` });
      }
      if (body.action === 'sign') {
        let paths = (body.paths || []).map(String);
        if (sess.role === 'owner') paths = paths.filter(p => p.startsWith(sess.subject + '/'));
        const urls = {};
        for (const p of paths) if (files.has(p)) { const t = crypto.randomUUID(); signed.set(t, p); urls[p] = `http://localhost:${PORT}/storage/${p}?t=${t}`; }
        return send(res, 200, { urls });
      }
      return send(res, 400, { error: 'BAD_ACTION' });
    }

    // emulates the jdb-cleanup Edge Function (same flow; key = "test-cleanup-key")
    if (req.method === 'POST' && url.pathname === '/functions/v1/jdb-cleanup') {
      if (req.headers['x-cleanup-key'] !== 'test-cleanup-key') return send(res, 401, { error: 'UNAUTHORIZED' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const dryRun = body.dryRun !== false;
      const prep = await callRpc('jdb_cleanup_prepare', { p_dry_run: dryRun, ...(body.now ? { p_now: body.now } : {}) }, 'service_role');
      const cur = prep.currentMonth;
      const re = /^[A-Za-z0-9_-]+\/\d{4}-\d{2}\/[^/]+$/;
      const nowMs = body.now ? new Date(body.now).getTime() : Date.now();
      const paths = [...new Set([...(prep.rows || []).map(r => r.path), ...(prep.orphans || [])])].filter(p => {
        if (!re.test(p)) return false;
        const ts = Number((p.split('/')[2].match(/^(\d{13})/) || [])[1]);
        return !ts || nowMs - ts >= 30 * 24 * 3600 * 1000;
      });
      let deleted = 0;
      if (!dryRun) for (const p of paths) { if (files.delete(p)) deleted++; await q(() => db.query(`delete from storage.objects where bucket_id='jdb-screenshots' and name=$1`, [p])); }
      const summary = { dryRun, currentMonth: cur, rowsCleared: prep.rowsCleared || 0, filesDeleted: deleted, filesFailed: 0, details: { candidates: paths.length, sample: paths.slice(0, 20) } };
      await callRpc('jdb_cleanup_log', { p_entry: summary }, 'service_role');
      return send(res, 200, summary);
    }
    if (url.pathname === '/vendor/xlsx.full.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      return res.end(fs.readFileSync(path.join(here, 'node_modules/xlsx/dist/xlsx.full.min.js')));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/storage/')) {
      const p = signed.get(url.searchParams.get('t'));
      if (!p || !files.has(p) || url.pathname !== `/storage/${p}`) return send(res, 400, { error: 'InvalidSignature' });
      const f = files.get(p);
      return send(res, 200, f.buf, { 'Content-Type': f.type });
    }

    // test-only helpers
    if (url.pathname === '/__sql' && req.method === 'POST') {
      const sql = await readBody(req);
      const r = await q(() => db.query(sql));
      return send(res, 200, { rows: r.rows });
    }
    if (url.pathname === '/__reset') {
      await q(async () => { await db.exec(`drop schema jdb cascade; delete from storage.objects;
        do $$ declare r record; begin
          for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'jdb\\_%' loop
            execute 'drop function ' || r.sig || ' cascade';
          end loop; end $$;`); await migrate(); });
      files.clear(); signed.clear(); backups.clear(); delayMs = 0;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__delay') { delayMs = Number(url.searchParams.get('ms') || 0); return send(res, 200, { delayMs }); }
    if (url.pathname === '/__files') return send(res, 200, { count: files.size, paths: [...files.keys()] });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(APP, 'utf8').replace(/'https:\/\/[a-z0-9]+\.supabase\.co'/g, `'http://localhost:${PORT}'`)
        .replace('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', '/vendor/xlsx.full.min.js');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (url.pathname === '/original.html' && ORIGINAL) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(ORIGINAL, 'utf8'));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { message: String(e && e.message || e) });
  }
});
server.listen(PORT, () => console.log(`mock supabase on http://localhost:${PORT}`));

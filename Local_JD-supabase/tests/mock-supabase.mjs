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
  grant usage on schema public to anon, authenticated, service_role;
`);
async function migrate() {
  for (const f of fs.readdirSync(MIGRATIONS).sort()) {
    await db.exec(fs.readFileSync(`${MIGRATIONS}/${f}`, 'utf8'));
  }
}
await migrate();

const files = new Map(); // path -> {buf, type}
const signed = new Map(); // token -> path

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
      await q(async () => { await db.exec('drop schema jdb cascade'); await migrate(); });
      files.clear(); signed.clear(); delayMs = 0;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__delay') { delayMs = Number(url.searchParams.get('ms') || 0); return send(res, 200, { delayMs }); }
    if (url.pathname === '/__files') return send(res, 200, { count: files.size, paths: [...files.keys()] });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(APP, 'utf8').replace("'https://dzjedqxhtxacchwkwhof.supabase.co'", `'http://localhost:${PORT}'`);
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

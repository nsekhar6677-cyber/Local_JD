// jdb-backup — automatic monthly backup for the JD Blossom maintenance tracker.
//
// Makes the SAME backup CSV as Settings → Data → "Download backup" (so "Restore backup"
// accepts it), stores it in the private `jdb-backups` bucket and keeps only the newest
// KEEP files (older ones are deleted after the new one is saved).
//
// Callers:
//   * database scheduler (pg_cron + pg_net) on the 1st of every month — header
//     `x-cleanup-key` must match the Vault secret `jdb_cleanup_key`; action "run"
//   * admins in the app (session token): action "status" (latest backup + short-lived
//     download link) or "run" (back up now)
// Deployed with verify_jwt = false: auth is the cleanup key or the app session token.
// Screenshots are not embedded (they stay in storage and follow the 30-day clean-up);
// the backup keeps their storage paths, like a manual backup whose images are in storage.
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import postgres from "npm:postgres@3.4.4";

const BUCKET = "jdb-backups";
const KEEP = 1; // newest backups to keep
const LINK_SECONDS = 60 * 10;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cleanup-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const csvEscape = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function istStamp(d = new Date()) {
  const t = new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString(); // YYYY-MM-DDTHH:mm
  return t.slice(0, 10) + "_" + t.slice(11, 13) + t.slice(14, 16);
}

async function buildBackupCsv(): Promise<string> {
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL") ?? "", { prepare: false, max: 1 });
  try {
    const [flats, payments, expenses, admins, settingsRows, collections, collPays] = await Promise.all([
      sql`select id, flat_no, owner, phone, amount, pin, recovery_question, recovery_answer_hash from jdb.flats order by sort_order, id`,
      sql`select flat_id, month, data, screenshot_path from jdb.payments`,
      sql`select month, data from jdb.expenses`,
      sql`select id, name, phone, password_hash from jdb.admins order by sort_order, id`,
      sql`select * from jdb.settings where id = 1`,
      sql`select id, month, data, created_at from jdb.collections order by month, created_at`,
      sql`select collection_id, flat_id, data, screenshot_path from jdb.collection_payments`,
    ]);
    const st = settingsRows[0] ?? {};
    const flatsOut = flats.map((f: any) => {
      const o: Record<string, unknown> = { id: f.id, flatNo: f.flat_no, owner: f.owner, phone: f.phone, amount: num(f.amount), pin: f.pin, recoveryQuestion: f.recovery_question };
      if (f.recovery_answer_hash) o.recoveryAnswerHash = f.recovery_answer_hash;
      return o;
    });
    const paymentsOut: Record<string, unknown> = {};
    for (const p of payments as any[]) paymentsOut[`${p.flat_id}:${p.month}`] = { ...(p.data ?? {}), screenshotPath: p.screenshot_path ?? null };
    const expensesOut: Record<string, unknown> = {};
    for (const e of expenses as any[]) expensesOut[e.month] = e.data;
    const settingsOut: Record<string, unknown> = {
      societyName: st.society_name, defaultAmount: num(st.default_amount), adminPhone: st.admin_phone ?? "",
      adminRecoveryQuestion: st.admin_recovery_question ?? "", lastCheck: st.last_check ?? null,
    };
    if (st.admin_recovery_answer_hash) settingsOut.adminRecoveryAnswerHash = st.admin_recovery_answer_hash;
    const adminsOut = admins.map((a: any) => ({ id: a.id, name: a.name, phone: a.phone, passwordHash: a.password_hash }));
    const collectionsOut = collections.map((c: any) => ({ ...(c.data ?? {}), id: c.id, month: c.month, createdAt: c.created_at }));
    const collPaysOut: Record<string, unknown> = {};
    for (const p of collPays as any[]) collPaysOut[`${p.collection_id}:${p.flat_id}`] = { ...(p.data ?? {}), screenshotPath: p.screenshot_path ?? null };
    const rows = [
      ["key", "value"],
      ["meta_app", st.society_name || "JD Blossom Apartment"],
      ["meta_exportedAt", new Date().toISOString()],
      ["meta_source", "automatic monthly backup"],
      ["flats", JSON.stringify(flatsOut)],
      ["payments", JSON.stringify(paymentsOut)],
      ["settings", JSON.stringify(settingsOut)],
      ["expenses", JSON.stringify(expensesOut)],
      ["admins", JSON.stringify(adminsOut)],
      ["collections", JSON.stringify(collectionsOut)],
      ["collectionPayments", JSON.stringify(collPaysOut)],
    ];
    return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }

  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // who is calling: the monthly schedule (key) or a signed-in admin (session token)
  const key = req.headers.get("x-cleanup-key");
  if (key) {
    const { data: ok } = await sb.rpc("jdb_cleanup_key_ok", { p_key: key });
    if (!ok) return json({ error: "UNAUTHORIZED" }, 401);
  } else {
    const { data: sess, error } = await sb.rpc("jdb_session_info", { p_token: String(body.token ?? "") });
    if (error || !sess) return json({ error: "SESSION_EXPIRED" }, 401);
    if (sess.role !== "admin") return json({ error: "FORBIDDEN" }, 403);
  }
  const action = String(body.action ?? (key ? "run" : "status"));

  const listAll = async () => {
    const { data, error } = await sb.storage.from(BUCKET).list("", { limit: 1000, sortBy: { column: "name", order: "desc" } });
    if (error) throw error;
    return (data ?? []).filter((o) => o.name.endsWith(".csv"));
  };

  try {
    if (action === "run") {
      const csv = await buildBackupCsv();
      const name = `JDB_backup_${istStamp()}.csv`;
      const up = await sb.storage.from(BUCKET).upload(name, new Blob([csv], { type: "text/csv" }), { contentType: "text/csv", upsert: true });
      if (up.error) return json({ error: "UPLOAD_FAILED", detail: up.error.message }, 500);
      // only after the new file is safely stored: remove older ones
      const files = await listAll();
      const old = files.filter((f) => f.name !== name).sort((a, b) => b.name.localeCompare(a.name)).slice(Math.max(0, KEEP - 1)).map((f) => f.name);
      if (old.length) await sb.storage.from(BUCKET).remove(old);
      return json({ ok: true, name, size: csv.length, removed: old.length });
    }
    if (action === "status") {
      const files = (await listAll()).sort((a, b) => b.name.localeCompare(a.name));
      const f = files[0];
      if (!f) return json({ latest: null });
      const signed = await sb.storage.from(BUCKET).createSignedUrl(f.name, LINK_SECONDS, { download: f.name });
      return json({ latest: { name: f.name, createdAt: f.created_at, size: (f.metadata as any)?.size ?? null, url: signed.data?.signedUrl ?? null }, count: files.length });
    }
    return json({ error: "BAD_ACTION" }, 400);
  } catch (e) {
    return json({ error: "BACKUP_FAILED", detail: String((e as Error)?.message ?? e) }, 500);
  }
});

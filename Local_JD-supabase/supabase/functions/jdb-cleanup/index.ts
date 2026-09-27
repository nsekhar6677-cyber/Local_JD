// jdb-cleanup — removes payment screenshots older than 30 days.
//
// Called by the database scheduler (pg_cron + pg_net) every day at 00:30 IST.
// Auth: header `x-cleanup-key` must match the Vault secret `jdb_cleanup_key`.
// What gets removed is decided in SQL (public.jdb_cleanup_prepare):
//   * screenshots uploaded more than 30 days ago (and their database links)
//   * unreferenced files older than 30 days
// Anything uploaded within the last 30 days is never touched.
// Order: database links are cleared first, then files deleted, so a failed file
// delete only leaves an unreferenced file that the next run removes.
// Only payments.screenshot_path is cleared — amounts, status, verification and
// history are never touched. Every run is logged in jdb.cleanup_log.
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const BUCKET = "jdb-screenshots";
const PATH_RE = /^[A-Za-z0-9_-]+\/\d{4}-\d{2}\/[^/]+$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const key = req.headers.get("x-cleanup-key") ?? "";
  const { data: keyOk } = await sb.rpc("jdb_cleanup_key_ok", { p_key: key });
  if (!keyOk) return json({ error: "UNAUTHORIZED" }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body = defaults */ }
  const dryRun = body.dryRun !== false; // safe default: dry run unless explicitly false

  const { data: prep, error: prepErr } = await sb.rpc("jdb_cleanup_prepare", { p_dry_run: dryRun });
  if (prepErr || !prep) {
    await sb.rpc("jdb_cleanup_log", { p_entry: { dryRun, currentMonth: "", details: { error: prepErr?.message ?? "prepare failed" } } });
    return json({ error: "PREPARE_FAILED", detail: prepErr?.message }, 500);
  }

  const cur: string = prep.currentMonth;
  const candidates: string[] = [
    ...(prep.rows ?? []).map((r: { path: string }) => r.path),
    ...(prep.orphans ?? []),
  ];
  // last safety net: only our own naming, and never a file whose name says it is under 30 days old
  const minAgeMs = 30 * 24 * 3600 * 1000;
  const paths = [...new Set(candidates)].filter((p) => {
    if (!PATH_RE.test(p)) return false;
    const ts = Number((p.split("/")[2].match(/^(\d{13})/) ?? [])[1]);
    return !ts || Date.now() - ts >= minAgeMs;
  });

  let deleted = 0;
  const failed: string[] = [];
  if (!dryRun) {
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { data, error } = await sb.storage.from(BUCKET).remove(batch);
      if (error) { failed.push(...batch); continue; }
      deleted += (data ?? []).length;
    }
  }

  const summary = {
    dryRun, currentMonth: cur, rowsCleared: prep.rowsCleared ?? 0,
    filesDeleted: deleted, filesFailed: failed.length,
    details: { candidates: paths.length, orphans: (prep.orphans ?? []).length, failed: failed.slice(0, 50), sample: paths.slice(0, 20) },
  };
  await sb.rpc("jdb_cleanup_log", { p_entry: summary });
  return json(summary);
});

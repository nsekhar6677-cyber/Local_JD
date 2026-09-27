// jdb-cleanup — removes payment screenshots from past months.
//
// Called by the database scheduler (pg_cron + pg_net) every day at 00:30 IST.
// Auth: header `x-cleanup-key` must match the Vault secret `jdb_cleanup_key`.
// What gets removed is decided in SQL (public.jdb_cleanup_prepare):
//   * current month: never
//   * previous month: verified payments at once, the rest from the 10th
//   * older months: always
//   * unreferenced files of past months
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
  // last safety net: never delete a current-month file or anything not matching our naming
  const paths = [...new Set(candidates)].filter((p) => PATH_RE.test(p) && p.split("/")[1] < cur);

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

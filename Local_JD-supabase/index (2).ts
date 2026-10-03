// jdb-files — payment screenshot storage for the JD Blossom maintenance tracker.
//
// The browser never gets storage credentials. It sends its app session token
// (issued by public.jdb_login_owner / jdb_login_admin) and this function:
//   * validates the token via public.jdb_session_info (service role only)
//   * action "upload": stores a compressed JPEG/PNG/WEBP data URL in the
//     private `jdb-screenshots` bucket under <flatId>/<YYYY-MM>/..., returns
//     { path, url } (url = short-lived signed URL)
//   * action "sign": returns signed URLs for a list of stored paths
// Owners may only upload/sign files for their own flat; admins for any flat.
//
// Deployed with verify_jwt = false because auth is the app session token
// checked below (the publishable key is not a JWT).
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const BUCKET = "jdb-screenshots";
const SIGN_SECONDS = 60 * 60 * 12; // 12 hours
const MAX_BYTES = 5 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "BAD_INPUT" }, 400);
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: sess, error: sessErr } = await sb.rpc("jdb_session_info", {
    p_token: String(body.token ?? ""),
  });
  if (sessErr || !sess) return json({ error: "SESSION_EXPIRED" }, 401);
  const role = sess.role as string;
  const subject = sess.subject as string;

  if (body.action === "upload") {
    const flatId = String(body.flatId ?? "");
    const month = String(body.month ?? "");
    const dataUrl = String(body.dataUrl ?? "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(flatId) || !/^\d{4}-\d{2}$/.test(month)) {
      return json({ error: "BAD_INPUT" }, 400);
    }
    if (role === "owner" && flatId !== subject) return json({ error: "FORBIDDEN" }, 403);
    const m = dataUrl.match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return json({ error: "BAD_IMAGE" }, 400);
    const bytes = decodeBase64(m[3]);
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return json({ error: "BAD_IMAGE" }, 400);
    const ext = m[2] === "jpeg" ? "jpg" : m[2];
    const path = `${flatId}/${month}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: m[1], upsert: false });
    if (up.error) return json({ error: "UPLOAD_FAILED", detail: up.error.message }, 500);
    const signed = await sb.storage.from(BUCKET).createSignedUrl(path, SIGN_SECONDS);
    return json({ path, url: signed.data?.signedUrl ?? null });
  }

  if (body.action === "sign") {
    const raw = Array.isArray(body.paths) ? body.paths : [];
    let paths = raw.map(String).filter((p) => p && !p.includes("..")).slice(0, 1000);
    if (role === "owner") paths = paths.filter((p) => p.startsWith(subject + "/"));
    if (paths.length === 0) return json({ urls: {} });
    const res = await sb.storage.from(BUCKET).createSignedUrls(paths, SIGN_SECONDS);
    if (res.error) return json({ error: "SIGN_FAILED", detail: res.error.message }, 500);
    const urls: Record<string, string> = {};
    for (const r of res.data ?? []) if (r.path && r.signedUrl) urls[r.path] = r.signedUrl;
    return json({ urls });
  }

  return json({ error: "BAD_ACTION" }, 400);
});

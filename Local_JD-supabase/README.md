# JD Blossom Apartment — Maintenance Tracker

Monthly maintenance dues, payment proofs and society expenses for the 35 flats
of JD Blossom Apartment. One self-contained page (`index.html`), hosted on
**Vercel**, with all data stored in **Supabase**.

| Piece | Where |
|---|---|
| Website | `index.html` → Vercel project `local-jd` (auto-deploys on every push to `main`) |
| Database | Supabase project `JDBLOSSOMAPT`, private schema `jdb` |
| Payment screenshots | Supabase Storage, private bucket `jdb-screenshots` (served only via 12-hour signed links) |
| Screenshot API | Supabase Edge Function `jdb-files` (`supabase/functions/jdb-files`) |
| Database schema + API | `supabase/migrations/*.sql` |
| End-to-end tests | `tests/` (Playwright, 9 screen profiles) |

## How it works

* The page talks only to a small set of database functions (`public.jdb_*`).
  Signing in with a flat PIN or admin password returns a session token
  (valid 12 h, extended while in use); every read/write checks it on the server.
* Owners only receive their own flat's details and screenshots — other flats'
  PINs, phone numbers and proofs never reach an owner's browser.
* Admin passwords and all security answers are stored as bcrypt hashes.
  Flat PINs stay visible to admins (the Flats & Access screen shows/edits them).
* 5 wrong PINs/passwords for the same flat/admin locks that login for 15 minutes.
* Each payment is its own row (flat × month), so two phones saving different flats
  at the same time can never overwrite each other. Every payment change is also
  written to an audit table (`jdb.payment_history`).
* **Settings → Data backup** still downloads one CSV with everything (screenshots
  embedded), and **Restore** accepts both new backups and old-format backups from
  the previous version of the app.

## First sign-in

Fresh database defaults (same as the original app): admin profile **Admin** /
password **admin123**, flats f001–f407 with PINs 1001–1035.
**Change the admin password right away** (Profile → Change password), then
restore your latest backup CSV from Settings → Data backup if you have one.

## Making changes

1. Edit `index.html`, commit, push to `main` → Vercel redeploys automatically.
2. Database changes: add a new file in `supabase/migrations/` and apply it in the
   Supabase dashboard (SQL Editor) or with `supabase db push`.
3. Run the tests before pushing:

```bash
cd tests
npm install
npx playwright install chromium webkit
npm test                 # all 9 screen profiles (Chromium)
WEBKIT=1 npm test        # + real Safari engine for the iPhone/iPad profiles
npm run test:report      # open the HTML report (screenshots side-by-side)
```

The tests start `tests/mock-supabase.mjs`, which runs the real migration SQL in
PGlite (Postgres in WebAssembly) — no internet or Supabase account needed.
`01-design-parity` renders every screen of the original app
(`tests/baseline/original-index.html`) and of the new one, and fails if a single
screen differs by more than 0.1 % of pixels or scrolls sideways.

## Security notes

* The Supabase *publishable* key in `index.html` is meant to be public; it can
  only call the `jdb_*` functions, which enforce the rules above.
* Never commit data exports (`Jdb_data*.csv`) — they contain PINs and phone numbers.

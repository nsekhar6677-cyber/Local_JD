# JD Blossom Apartment — Maintenance Tracker

Monthly maintenance dues, payment proofs and society expenses for the 35 flats
of JD Blossom Apartment. One self-contained page (`index.html`), hosted on
**Vercel**, with all data stored in **Supabase**.

| Piece | Where |
|---|---|
| Website | `index.html` → Vercel project `local-jd` (auto-deploys on every push to `main`) |
| Live database | Supabase project `JDBLOSSOMAPT`, private schema `jdb` — used **only** on the live addresses |
| Test database | Supabase project `JDBLOSSOMAPT-TEST` (same schema) — used on every other address, e.g. Vercel preview links |
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

## Testing a change before it goes live

1. On GitHub, upload the changed files into `Local_JD-supabase/` but choose
   **"Create a new branch for this commit and start a pull request"**.
2. Open the **Preview** link Vercel posts on the pull request. It shows a red
   **TEST DATABASE** tag and uses the test database — try anything, real data is untouched.
3. Happy? **Merge pull request** → live in about a minute. Not happy? Close it.

`LIVE_HOSTS` near the top of the script in `index.html` lists the live addresses.
If you add your own domain, add it there, or it will use the test database.
Database changes (new migration files) must be applied to **both** projects —
test first, then live.

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


## Bulk upload & screenshot clean-up

* **Entry → Bulk upload maintenance (Excel)** — columns: Flat No, Maintenance month, Paid Amt,
  Paid on (MM-DD-YYYY), Mode; optional Name (Owner), Maintenance Share, Previous balance.
  Preview + validation first; Import is one all-or-nothing call (`jdb_bulk_import_payments`).
  Imported rows are marked paid + verified, visible to admins and in the owner's My Ledger.
  "Previous balance" on a flat's earliest month becomes opening arrears (`carryInOverride`).
* **Expenses → Bulk upload expenses (Excel)** — columns: Category, Paid on (MM-DD-YYYY), Amount;
  optional Comments, Maintenance month, Mode. Appended per month (`jdb_bulk_add_expenses`),
  duplicates (same month + category + date + amount) skipped unless ticked.
* **Expense items** now have optional Mode and Comments; Category, Paid on and Amount are mandatory.
* **Screenshot clean-up** — Edge Function `jdb-cleanup`, called daily at 00:30 IST by pg_cron.
  Deletes screenshots uploaded **more than 30 days ago** (from Storage and the dashboard);
  anything newer is never touched. Clears only `payments.screenshot_path` — amounts, status,
  verification and history stay. Runs are logged in `jdb.cleanup_log`
  (last run shown in Settings → Run diagnostics).

## Automatic monthly backup

* On the **1st of every month at 06:00 IST** pg_cron calls the `jdb-backup` Edge Function, which saves the same
  backup CSV as Settings → Data → Download backup into the private Storage bucket `jdb-backups` and deletes older
  files (only the newest is kept). Restore it with Settings → Data → Restore backup.
* Admin → Settings → Data shows the latest automatic backup with **Download latest** and **Back up now**.
  Also visible in the Supabase dashboard → Storage → jdb-backups.
* Setup per project: deploy `supabase/functions/jdb-backup` (JWT verification off), then run
  `supabase/migrations/20261003000100_monthly_backup.sql` (bucket + schedule; uses the clean-up Vault secrets).

## Special (one-time) collections

* **Admin → Collections** — create a collection (title, month, amount per flat, due date, note), then track every
  flat: paid amount, date, mode, screenshot, verify, waive, "Applies" (untick for flats that don't pay).
  Close it to stop submissions; delete is only allowed while nobody has paid.
* **Owners** see open collections under "Special collections" and submit amount + mode + screenshot (all mandatory);
  verified payments are locked. Never part of maintenance dues or carry-forward.
* **Money flow** — collected amounts count as a receipt in the expense report for the collection's month
  (Expenses → Receipts line, Reports summary/CSV/Excel/WhatsApp, owner Society funds) and carry into next month's
  balance. Tables `jdb.collections`, `jdb.collection_payments` (`20261001000000_special_collections.sql`).

## Reports & Expenses

* **Owner page → Society overview** — also shows the amount collected this month and the society funds
  (previous month balance, collected, expenses, available balance). Owners receive expense totals only
  (`20260930000000_owner_society_funds.sql`), never categories, dates, modes or comments.

* **Reports** — one period picker (monthly / quarterly / half-yearly / annual / custom from–to)
  drives both the maintenance collection and the **Expense summary** (receipts, itemised payments
  with mode + comments, category totals, balance c/f). Buttons: Print / Save as PDF (prints only
  the summary), Download CSV, Download Excel (Summary, Expenses, Maintenance sheets), WhatsApp text.
* **Expenses** — Receipts (balance b/f, maintenance received, totals incl. *Available funds —
  balance carried forward*), expense items (add / edit / delete with comments), bulk upload.

### Applying to a Supabase project (test first, then live)
1. Run `supabase/migrations/20260928000000_bulk_upload_and_cleanup.sql`.
2. `select vault.create_secret('https://<project-ref>.supabase.co', 'jdb_project_url');`
3. Run `supabase/migrations/20260928000100_cleanup_schedule.sql` (turns on pg_cron + pg_net).
4. Run `supabase/migrations/20260929000000_cleanup_30_days.sql` (30-day rule).
5. Deploy `supabase/functions/jdb-cleanup` with JWT verification **off** (it checks its own key).

## Security notes

* The Supabase *publishable* key in `index.html` is meant to be public; it can
  only call the `jdb_*` functions, which enforce the rules above.
* Never commit data exports (`Jdb_data*.csv`) — they contain PINs and phone numbers.

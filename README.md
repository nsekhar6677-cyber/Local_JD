Apartment Maintenance Tracker
A multi-tenant maintenance-collection & expense-tracking site. Any number of
apartments/societies can sign up and use the same deployed site — each
apartment only ever sees its own data.
Stack
Next.js 14 (App Router, JavaScript) — pages + API routes
Supabase — Postgres database + private Storage bucket for payment
screenshots (free tier is enough to start)
Vercel — hosting
How multi-tenancy works
Every table has an `apartment_id`. All data access goes through Next.js
server-side API routes using Supabase's service role key — the browser
never talks to Supabase directly, and every query is manually filtered by the
apartment ID stored in the caller's signed session cookie. Row Level Security
is also enabled on every table as a backstop (see `supabase/schema.sql`), so
even a misused key can't read across apartments.
Auth is intentionally simple and self-contained (no email required):
Admins log in with an apartment code + username + password.
Flat owners log in with an apartment code + flat number + PIN. Owners
set their own PIN the first time, verified against the phone number the
admin has on file for their flat.
Forgot password/PIN for both roles works via a security question set
up in Settings/Profile — no email sending required.
1. Set up Supabase
Create a free project at supabase.com.
In the SQL Editor, run the contents of `supabase/schema.sql`. This
creates all tables, locks them down with RLS, and creates the private
`screenshots` storage bucket.
Go to Project Settings → API and copy:
`Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
`service_role` secret key → `SUPABASE_SERVICE_ROLE_KEY`
(⚠️ never expose this key to the browser — it's only used in server
routes in this app)
2. Configure environment variables
Copy `.env.example` to `.env.local` and fill in:
```
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SESSION_SECRET=<any long random string>
SUPABASE_SCREENSHOT_BUCKET=screenshots
```
Generate a `SESSION_SECRET` quickly with: `openssl rand -base64 32`
3. Run locally
```
npm install
npm run dev
```
Visit `http://localhost:3000` → redirects to `/login`. Use `/signup` to
create your first apartment.
4. Deploy to Vercel
Push this repo to GitHub.
Import it into Vercel.
Add the same environment variables from `.env.local` in the Vercel
project's Settings → Environment Variables.
Deploy. The same URL now serves every apartment that signs up.
How a new apartment gets going
An admin visits `/signup` and creates the apartment — this generates a
unique apartment code (e.g. `JDB-4821`). Write this down; it's how
everyone finds their apartment on the shared site.
The admin adds flats one at a time or bulk-imports via CSV
(`Admin → Flats`), with each owner's phone number on file.
Share the apartment code + flat number with each owner. They visit
`/login/first-time`, verify their phone number, and set their own PIN.
From there: owners submit monthly payments + screenshots from `/owner`;
admins verify/waive from `Admin → Verify`, track expenses, and pull
reports.
Notes / things you may want to extend
Screenshots are stored in a private Supabase Storage bucket and only
ever served via short-lived signed URLs — never public links.
The carry-over balance logic (pay less/more than due → rolls to next
month) lives in `lib/dues.js` and looks back up to 24 months by default;
bump `monthsBack` there for very old apartments.
OCR auto-verification (present in the original single-apartment reference)
was intentionally left out per your request — verification is manual only.
Backup/restore in `Admin → Settings` exports/imports flats, payments, and
expenses as JSON (screenshots stay in Storage; restoring re-links by path
rather than re-uploading images).

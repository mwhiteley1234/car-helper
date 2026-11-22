# Car Helper setup (about 30 minutes)

Use **new** Supabase and Netlify projects, separate from Points Helper. You can reuse the same Anthropic API key and VAPID keys, or make new ones.

## 1. Supabase (database and sign-in)
1. supabase.com → **New project**. Region US East or US Central. Save the database password.
2. **SQL Editor → New query**. Open `supabase/schema.sql`, check the email in the `insert into public.allowlist` line (add anyone you invite), paste the whole file, **Run**.
3. **Authentication → Emails → Magic Link** template: add `Your code: {{ .Token }}` so the email carries a 6-digit code. (The Home Screen app can't use the link, because links open in Safari.)
4. **Authentication → URL Configuration**: set **Site URL** to your Netlify address (from step 3) and add it under **Redirect URLs**.
5. **Project Settings → API**: keep the **Project URL**, **anon public** key and **service_role** key handy. The service_role key is secret.

To invite someone later: SQL Editor → `insert into public.allowlist (email) values ('their@email.com');`

## 2. Anthropic API key
Use your existing key or create one named `car-helper` in the Claude Console. Keep a monthly spend limit on.

## 3. Netlify (hosting)
1. **Add new site → Import an existing project → GitHub** → `car-helper`. No build command needed (`netlify.toml` publishes `public/`).
2. **Site configuration → Environment variables**:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `ANTHROPIC_API_KEY` | your Claude API key |
| `VAPID_PUBLIC_KEY` | public VAPID key (step 4) |

   Optional: `DAILY_QUESTION_LIMIT` (default 30 AI questions per person per day; reading a VIN, a dashboard light, a schedule draft and a price check each count as one), `MODEL` (default `claude-sonnet-5-5`).
3. **Deploys → Trigger deploy**. Put the site address into Supabase (step 1.4).
4. Optional: **Domain management** for your own subdomain (for example `car.capitalcitydigital.com`).

## 4. Reminders (GitHub Actions)
1. VAPID keys: reuse Points Helper's, or run `npx web-push generate-vapid-keys` once.
2. GitHub → `car-helper` → **Settings → Secrets and variables → Actions → New repository secret**:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` plus your email).
3. **Actions → Daily recalls and reminders → Run workflow** to test. After that it runs every morning at 8:17 AM Central.

## 5. Sign in and make yourself admin
1. Open the site, enter your email, enter the 6-digit code.
2. Back in SQL Editor, run the admin line again now that your account exists:
   ```sql
   insert into public.admins (user_id) select id from auth.users where lower(email) = lower('sosiatynski@gmail.com') on conflict do nothing;
   ```
   Reload the app; a **Stats** tab appears.

## 6. iPhone
Safari → Share → **Add to Home Screen**. Open **Car Helper** from the Home Screen, sign in with the code, then **Settings → Turn on reminders**.

## Notes
- If recalls come back empty for a car you know has some, NHTSA may spell the model differently (for example `F-150` vs `F150`). Edit the car's model and tap **Check now**.
- Costs: Supabase and Netlify free tiers are plenty. Each AI question is one Claude call; photos are resized to 1600 px before upload.

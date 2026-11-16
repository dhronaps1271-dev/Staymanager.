# StayManager

A responsive accommodation-management web application for a 100-slot resident register. The frontend is React + TypeScript + Vite; authentication, persistent PostgreSQL storage and row-level access control are provided by Supabase.

## What is included

- Permanent resident slots numbered 1–100. Empty slots are retained and can be filled without changing the resident number.
- Inline name editing in the main resident directory, with Save and Cancel.
- Resident profiles with contact, room, bed, notes, category and payment history.
- Working (€70/month), Staying (€180/month) and Custom fee categories.
- Category/fee changes scheduled from the first day of the following calendar month. Each monthly charge is a snapshot, so historical charges are not recalculated when a future rate changes.
- Manual payment ledger with payment amount, payment date, note and billing-month allocation. Payments are append-only in the app to preserve the audit trail.
- Monthly register, search, category/payment filters, status indicators, dashboard summaries and PDF/Excel exports.
- Supabase Auth sign-in and database Row Level Security (RLS) policies.

## 1. Create the cloud database

1. Create a project at [Supabase](https://supabase.com/). Choose an EU region for an Italy-based business where available.
2. Open **SQL Editor** in your Supabase project.
3. Open `supabase/schema.sql` from this project, copy its full contents into the SQL Editor and run it.
4. The script creates the tables, security policies and database functions, and seeds the 100 permanent resident slots. It does not create fake resident names or payments.

## 2. Create the administrator login

1. In Supabase, open **Authentication → Users** and create the administrator user with the intended email and a strong unique password. Do not enable public sign-up for this private business application.
2. Copy that user's UUID from the Authentication users list.
3. In **SQL Editor**, run the following statement after replacing the two values:

```sql
insert into public.profiles (user_id, display_name, role)
values ('PASTE-AUTH-USER-UUID-HERE', 'Accommodation Administrator', 'admin');
```

Only a user with an `admin` record in `public.profiles` can access the business data. The profile row is deliberately created by the project owner, not by a public registration form.

## 3. Configure the frontend

1. Install Node.js (LTS) on your computer.
2. Copy `.env.example` to a new file named `.env` in the project root.
3. In Supabase, open **Project Settings → API** and copy the Project URL and the publishable key (or legacy anon key) into `.env`:

```env
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

4. Install dependencies and start the local development server:

```bash
npm install
npm run dev
```

5. Open the local URL printed by Vite (usually `http://localhost:5173`) and sign in with the administrator account.

## 4. Build and deploy

Build the production frontend with:

```bash
npm run build
```

The static production files are written to `dist/`. Deploy this project to a static hosting provider such as Vercel, Netlify or another HTTPS host. Add the two `VITE_SUPABASE_*` environment variables in that host's project settings, then redeploy. Add the deployed domain to Supabase **Authentication → URL Configuration → Redirect URLs**. Require HTTPS for the deployed site.

## Financial rules and assumptions

- A resident category/fee update is stored as a new schedule entry effective from the first day of the next calendar month. Existing monthly charge snapshots are never rewritten for past months.
- The monthly charge is created when an administrator opens a month in the app. Its default due date is the final calendar day of that billing month. An unpaid balance after that date is labelled **Overdue**. The due-day rule can be changed in the database/function if the business uses another due date.
- Payments are assigned to the billing month selected in the app. The collection KPI uses the actual payment date, while each resident's monthly balance uses the billing-month allocation.
- Payments are not automatically carried forward to another month. Any advance payment should be allocated deliberately to the relevant billing month by the administrator.
- An amount paid equal to or greater than the fee marks the month Paid; the displayed balance never drops below zero. The application does not calculate or apply a credit balance to later months.
- This is a manual payment-recording system. It does not charge bank cards or initiate bank transfers.

## Security and backup checklist before real use

- Keep the Supabase project private and use the publishable/anon key only in the browser. **Never** expose the `service_role` key in frontend code, `.env` variables prefixed with `VITE_`, screenshots or a public repository.
- Disable public sign-ups. Create administrator accounts manually and use strong unique passwords; enable MFA in Supabase for administrator accounts where available.
- Review the RLS policies in `supabase/schema.sql` before adding staff roles or extra access levels. The current app is designed for administrator-only use.
- Confirm your Supabase plan's backup and point-in-time recovery features. Set up an appropriate backup schedule, retain periodic exports in a separate secure location, and test restoring a backup before entering real resident data. Backup availability and retention depend on the Supabase plan.
- Use HTTPS in production and restrict access to the hosting and Supabase project consoles.
- Before using real personal data, prepare the business's privacy notice, retention rules and lawful basis for processing. Confirm GDPR obligations with a qualified professional; this code is not a legal compliance certification.

## Important implementation note

This is a deployable application project, not a hosted website. It becomes a live multi-device system after you create and configure the Supabase project and deploy the frontend. No resident data is included in this source package.

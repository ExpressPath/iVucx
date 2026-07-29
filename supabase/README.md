# Supabase setup and CIC checks

This repo has two Supabase paths:

- Local Supabase for the VSCode extension and local schema checks.
- The deployed Supabase project used by Vercel for real saved CIC rows.

## Local VSCode extension

The VSCode error `Could not connect to local Supabase project. Make sure you've run 'supabase start'!` means the extension is looking for a local Supabase CLI stack.

Prerequisites:

- Docker Desktop is installed and running.
- Supabase CLI is installed and on PATH.

From the repository root:

```powershell
supabase start
supabase db reset
supabase status
```

`supabase db reset` applies the migration files in `supabase/migrations`, which mirror:

- `supabase/blue_mode_auth.sql`
- `supabase/proof_helper.sql`

After `supabase status`, use the local keys it prints for local development:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from supabase status>
```

Studio should be available at:

```text
http://127.0.0.1:54323
```

## Production access contract

Use two separate Supabase access paths:

- App path: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in Vercel. This is for runtime REST access.
- Admin SQL path: `SUPABASE_DB_URL` on the local machine or CI. This is for migrations, grants, schema-cache reloads, and direct diagnostics.

The Vercel app currently reports this production Supabase project ref:

```text
luuhqruederztcljorvk
```

The Supabase Dashboard SQL Editor or `SUPABASE_DB_URL` must target that same project.

To apply the schema, service-role grants, and PostgREST reload to production from PowerShell:

```powershell
$env:SUPABASE_PROJECT_REF="luuhqruederztcljorvk"
$env:SUPABASE_DB_URL="postgresql://..."
powershell -ExecutionPolicy Bypass -File scripts\supabase-remote-access.ps1
```

To run only diagnostics:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase-remote-access.ps1 -CheckOnly
```

To additionally verify the Vercel persistence route by creating or reusing one smoke-test row:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\supabase-remote-access.ps1 -RestSmoke
```

The SQL-only diagnostic file is:

```text
supabase/remote_access_check.sql
```

## Check CIC rows

Final saved CIC rows are stored in:

```text
public.problems
```

Important columns:

- `normalized_format`: should be `cic-v1` for a CIC save.
- `normalized_term`: server-recomputed CIC theorem proposition (`context.type`), never the proof body.
- `adapter_meta`: context, proof term for audit, declarations, metadata, requested/completed format.
- `request_meta`: request metadata such as requested/completed format.

Run this file in Supabase SQL Editor, either local or deployed:

```text
supabase/cic_saved_rows_check.sql
```

For a local schema-only test that leaves no row behind, run:

```text
supabase/cic_persistence_smoke_test.sql
```

If the UI says `Problem saved`, Vercel returned `storage.persisted: true` and a row should exist in `public.problems`.

If `POST /api/helper/persist` returns a schema-cache error after the tables were created, run this in the same Supabase SQL Editor:

```sql
grant usage on schema public to service_role;
grant select, insert, update, delete on public.problems to service_role;
grant select, insert, update, delete on public.helper_jobs to service_role;
grant select, insert, update, delete on public.helper_conversion_plans to service_role;
NOTIFY pgrst, 'reload schema';
```

Then retry the CIC conversion. The UI should only show CIC success after Supabase returns `storage.persisted: true`.

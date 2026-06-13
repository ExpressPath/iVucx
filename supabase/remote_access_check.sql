-- Remote Supabase access check.
-- Run this against the production Supabase Postgres database, not the local stack.

select
  current_database() as database_name,
  current_user as current_user,
  session_user as session_user,
  to_regclass('public.problems') as problems_table,
  to_regclass('public.helper_jobs') as helper_jobs_table,
  to_regclass('public.helper_conversion_plans') as helper_conversion_plans_table,
  has_schema_privilege('service_role', 'public', 'USAGE') as service_role_schema_usage,
  has_table_privilege('service_role', 'public.problems', 'SELECT') as service_role_problems_select,
  has_table_privilege('service_role', 'public.problems', 'INSERT') as service_role_problems_insert,
  has_table_privilege('service_role', 'public.problems', 'UPDATE') as service_role_problems_update,
  has_table_privilege('service_role', 'public.problems', 'DELETE') as service_role_problems_delete;

select
  grantee,
  table_schema,
  table_name,
  privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('problems', 'helper_jobs', 'helper_conversion_plans')
  and grantee = 'service_role'
order by table_name, privilege_type;

select
  count(*) as total_problem_rows,
  count(*) filter (where normalized_format = 'cic-v1') as saved_cic_rows,
  count(*) filter (where request_meta->>'requestedFormat' = 'cic-v1') as requested_cic_rows
from public.problems;

notify pgrst, 'reload schema';

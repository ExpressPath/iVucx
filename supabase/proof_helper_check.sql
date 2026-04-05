select
  to_regclass('public.helper_jobs') as helper_jobs,
  to_regclass('public.helper_conversion_plans') as helper_conversion_plans,
  to_regclass('public.problems') as problems;

select
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('helper_jobs', 'helper_conversion_plans', 'problems')
order by table_name, ordinal_position;

-- CIC persistence check for the connected Supabase project.
-- Run this in Supabase SQL Editor, or against local Supabase after `supabase start`.

select
  to_regclass('public.problems') as problems,
  to_regclass('public.helper_jobs') as helper_jobs,
  to_regclass('public.helper_conversion_plans') as helper_conversion_plans;

select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'problems'
  and column_name in (
    'id',
    'title',
    'language',
    'file_name',
    'source_sha256',
    'proof_state',
    'verification_status',
    'verification_result',
    'normalized_format',
    'normalized_term',
    'adapter_meta',
    'helper_job_id',
    'request_meta',
    'created_at'
  )
order by ordinal_position;

select
  count(*) as total_problem_rows,
  count(*) filter (where normalized_format = 'cic-v1') as saved_cic_rows,
  count(*) filter (where request_meta->>'requestedFormat' = 'cic-v1') as requested_cic_rows,
  count(*) filter (
    where request_meta->'attachmentStorage'->>'count' is not null
      and (request_meta->'attachmentStorage'->>'count')::int > 0
  ) as rows_with_saved_attachments,
  count(*) filter (
    where request_meta->>'requestedFormat' = 'cic-v1'
      and normalized_format <> 'cic-v1'
  ) as cic_requested_but_fell_back_rows
from public.problems;

select
  id,
  created_at,
  title,
  language,
  file_name,
  normalized_format,
  request_meta->>'requestedFormat' as requested_format,
  request_meta->>'completedFormat' as completed_format,
  adapter_meta->>'targetFamily' as target_family,
  helper_job_id,
  verification_status,
  proof_state,
  jsonb_typeof(normalized_term) as normalized_term_type,
  normalized_term->>'kind' as normalized_term_kind,
  request_meta #>> '{cicTarget,source}' as cic_target_source,
  request_meta #>> '{cicTarget,sha256}' as cic_target_sha256,
  jsonb_typeof(adapter_meta->'context') as context_type,
  jsonb_typeof(adapter_meta->'metadata') as metadata_type,
  request_meta->'attachmentStorage' as attachment_storage,
  request_meta->'attachments' as attachments,
  left(normalized_term::text, 600) as normalized_term_preview
from public.problems
where normalized_format = 'cic-v1'
   or request_meta->>'requestedFormat' = 'cic-v1'
order by created_at desc
limit 20;

select
  id,
  created_at,
  title,
  language,
  normalized_format,
  request_meta->>'requestedFormat' as requested_format,
  request_meta->>'completedFormat' as completed_format,
  adapter_meta->>'rawText' as raw_text_preview
from public.problems
where request_meta->>'requestedFormat' = 'cic-v1'
  and normalized_format <> 'cic-v1'
order by created_at desc
limit 20;

-- Local/schema smoke test.
-- This verifies that public.problems accepts a cic-v1 row, then rolls it back.
-- It does not leave test data behind.

begin;

insert into public.problems (
  title,
  language,
  file_name,
  source_code,
  source_sha256,
  proof_state,
  verification_status,
  verification_result,
  normalized_format,
  normalized_term,
  adapter_name,
  adapter_meta,
  helper_job_id,
  request_meta
) values (
  'ivucx CIC smoke test',
  'lean',
  'Smoke.lean',
  'theorem smoke : True := by trivial',
  encode(digest('theorem smoke : True := by trivial', 'sha256'), 'hex'),
  'YY',
  'verified',
  '{"proofCheck":{"ok":true},"planning":null,"helperStorage":null}'::jsonb,
  'cic-v1',
  '{"kind":"const","name":"True.intro","universes":[]}'::jsonb,
  'local-smoke-test',
  '{
    "targetFamily":"cic",
    "requestedFormat":"cic-v1",
    "completedFormat":"cic-v1",
    "context":{"type":{"kind":"sort","level":{"kind":"param","name":"Prop"}}},
    "metadata":{"diagnostic":true}
  }'::jsonb,
  null,
  '{
    "createdBy":"local-smoke-test",
    "requestedFormat":"cic-v1",
    "completedFormat":"cic-v1"
  }'::jsonb
)
returning
  id,
  title,
  normalized_format,
  normalized_term,
  adapter_meta,
  request_meta;

rollback;

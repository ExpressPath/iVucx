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
  '{"kind":"const","name":"True","universes":[]}'::jsonb,
  'local-smoke-test',
  '{
    "targetFamily":"cic",
    "requestedFormat":"cic-v1",
    "completedFormat":"cic-v1",
    "context":{"type":{"kind":"const","name":"True","universes":[]}},
    "proofTerm":{"kind":"const","name":"True.intro","universes":[]},
    "metadata":{"diagnostic":true}
  }'::jsonb,
  null,
  '{
    "createdBy":"local-smoke-test",
    "requestedFormat":"cic-v1",
    "completedFormat":"cic-v1",
    "cicTarget":{
      "version":1,
      "source":"server-recomputed-context.type",
      "sha256":"ae286cc2684e8365b2e08cdf4f814ce9747567674468850be2883eb2916426ec",
      "format":"cic-v1"
    }
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

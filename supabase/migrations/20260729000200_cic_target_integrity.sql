begin;

alter table public.problems
  drop constraint if exists problems_trusted_cic_target_check;

alter table public.problems
  add constraint problems_trusted_cic_target_check
  check (
    lower(coalesce(normalized_format, '')) <> 'cic-v1'
    or (
      jsonb_typeof(normalized_term) = 'object'
      and adapter_meta #> '{context,type}' = normalized_term
      and request_meta #>> '{cicTarget,source}' = 'server-recomputed-context.type'
      and request_meta #>> '{cicTarget,version}' = '1'
      and request_meta #>> '{cicTarget,sha256}' ~ '^[0-9a-f]{64}$'
    )
  ) not valid;

comment on constraint problems_trusted_cic_target_check on public.problems is
  'New cic-v1 rows must store the server-recomputed theorem proposition from context.type, not a client-provided proof term.';

commit;

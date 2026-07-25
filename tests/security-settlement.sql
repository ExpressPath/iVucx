begin;

insert into public.problems(
  id, title, language, file_name, source_code, source_sha256,
  proof_state, verification_status, normalized_term, request_meta
) values
(
  'a0000000-0000-0000-0000-000000000001', 'Atomic problem', 'coq', 'Problem.v',
  'Theorem target : True.', repeat('a', 64), 'NY', 'verified', '{}'::jsonb,
  '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_atomic"}}'::jsonb
),
(
  'a0000000-0000-0000-0000-000000000002', 'Atomic solution', 'coq', 'Main.v',
  'Theorem target : True. Proof. exact I. Qed.', repeat('b', 64), 'YY', 'verified', '{}'::jsonb,
  '{}'::jsonb
),
(
  'b0000000-0000-0000-0000-000000000001', 'Rollback problem', 'lean', 'Problem.lean',
  'theorem target : True', repeat('c', 64), 'NY', 'verified', '{}'::jsonb,
  '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_rollback"}}'::jsonb
),
(
  'b0000000-0000-0000-0000-000000000002', 'Rollback solution', 'lean', 'Main.lean',
  'theorem target : True := by trivial', repeat('d', 64), 'YY', 'verified', '{}'::jsonb,
  '{}'::jsonb
);

do $$
declare
  result jsonb;
  transaction_count integer;
  solver_balance integer;
  conditional_balance integer;
begin
  result := public.settle_problem_solution(
    'a0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_atomic"}}'::jsonb,
    '{"problemKind":"theorem","postKind":"theorem","bounty":{"amountCents":0},"solution":{"solutionProblemId":"a0000000-0000-0000-0000-000000000002","status":"solved"}}'::jsonb,
    '{"problemKind":"theorem","postKind":"theorem","solutionOf":{"problemId":"a0000000-0000-0000-0000-000000000001"}}'::jsonb,
    '[
      {"accountProvider":"google","accountId":"solver@example.test","accountIdHash":"solver-hash","email":"solver@example.test","amountVx":4.5,"amountYen":900,"reason":"problem_bounty_award","idempotencyKey":"atomic-solver"},
      {"accountProvider":"google","accountId":"conditional@example.test","accountIdHash":"conditional-hash","email":"conditional@example.test","amountVx":0.5,"amountYen":100,"reason":"conditional_usage_award","idempotencyKey":"atomic-conditional"}
    ]'::jsonb,
    160,
    now()
  );

  if jsonb_array_length(result) <> 2 then
    raise exception 'Expected two atomic settlement results.';
  end if;
  if (select proof_state from public.problems where id = 'a0000000-0000-0000-0000-000000000001') <> 'YY' then
    raise exception 'Original problem was not converted to a theorem.';
  end if;
  select count(*) into transaction_count
  from public.ivucx_transactions
  where idempotency_key in ('atomic-solver', 'atomic-conditional');
  if transaction_count <> 2 then
    raise exception 'Expected two committed payout transactions.';
  end if;
  select balance_yen into solver_balance
  from public.ivucx_accounts
  where account_provider = 'google' and account_id_hash = 'solver-hash';
  select balance_yen into conditional_balance
  from public.ivucx_accounts
  where account_provider = 'google' and account_id_hash = 'conditional-hash';
  if solver_balance <> 900 or conditional_balance <> 100 then
    raise exception 'Atomic settlement balances are incorrect.';
  end if;
end;
$$;

do $$
declare
  rejected boolean := false;
  transaction_count integer;
begin
  begin
    perform public.settle_problem_solution(
      'b0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000002',
      '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_rollback"}}'::jsonb,
      '{"problemKind":"theorem","postKind":"theorem","bounty":{"amountCents":0},"solution":{"solutionProblemId":"b0000000-0000-0000-0000-000000000002","status":"solved"}}'::jsonb,
      '{"problemKind":"theorem","postKind":"theorem","solutionOf":{"problemId":"b0000000-0000-0000-0000-000000000001"}}'::jsonb,
      '[
        {"accountProvider":"google","accountId":"first@example.test","accountIdHash":"first-hash","amountVx":4.5,"amountYen":900,"reason":"problem_bounty_award","idempotencyKey":"rollback-first"},
        {"accountProvider":"google","accountId":"second@example.test","accountIdHash":"second-hash","amountVx":99,"amountYen":100,"reason":"conditional_usage_award","idempotencyKey":"rollback-invalid"}
      ]'::jsonb,
      160,
      now()
    );
  exception when others then
    rejected := true;
  end;

  if not rejected then
    raise exception 'Invalid settlement was not rejected.';
  end if;
  if (select proof_state from public.problems where id = 'b0000000-0000-0000-0000-000000000001') <> 'NY' then
    raise exception 'Rejected settlement changed the problem state.';
  end if;
  select count(*) into transaction_count
  from public.ivucx_transactions
  where idempotency_key in ('rollback-first', 'rollback-invalid');
  if transaction_count <> 0 then
    raise exception 'Rejected settlement left a partial payout.';
  end if;
end;
$$;

rollback;

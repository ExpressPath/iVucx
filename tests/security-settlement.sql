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
  '{"createdByAccount":{"accountProvider":"google","accountId":"solver@example.test","accountIdHash":"solver-hash"},"solveContext":{"problemId":"a0000000-0000-0000-0000-000000000001","selectedConditionals":[]}}'::jsonb
),
(
  'b0000000-0000-0000-0000-000000000001', 'Rollback problem', 'lean', 'Problem.lean',
  'theorem target : True', repeat('c', 64), 'NY', 'verified', '{}'::jsonb,
  '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_rollback"}}'::jsonb
),
(
  'b0000000-0000-0000-0000-000000000002', 'Rollback solution', 'lean', 'Main.lean',
  'theorem target : True := by trivial', repeat('d', 64), 'YY', 'verified', '{}'::jsonb,
  '{"createdByAccount":{"accountProvider":"google","accountId":"rollback@example.test","accountIdHash":"rollback-hash"},"solveContext":{"problemId":"b0000000-0000-0000-0000-000000000001","selectedConditionals":[]}}'::jsonb
),
(
  'c0000000-0000-0000-0000-000000000001', 'Conditional problem', 'coq', 'Problem.v',
  'Theorem target : True.', repeat('e', 64), 'NY', 'verified', '{}'::jsonb,
  '{
    "problemKind":"problem",
    "bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_conditional_base"},
    "conditionals":[{
      "conditionalProblemId":"c0000000-0000-0000-0000-000000000003",
      "conditionalTitle":"Funded lemma",
      "submitter":{"accountProvider":"google","accountId":"funder@example.test","accountIdHash":"funder-hash"},
      "bounty":{
        "amountYen":200,
        "currency":"jpy",
        "paymentStatus":"paid",
        "serverVerified":true,
        "stripeSessionId":"cs_test_conditional_fund",
        "fundingModel":"final-total-fixed-ratio-v1",
        "existingBountyYen":1000,
        "fixedSharePpm":200000
      }
    }]
  }'::jsonb
),
(
  'c0000000-0000-0000-0000-000000000002', 'Conditional solution', 'coq', 'Main.v',
  'Theorem target : True. Proof. exact I. Qed.', repeat('f', 64), 'YY', 'verified', '{}'::jsonb,
  '{
    "createdByAccount":{"accountProvider":"google","accountId":"final-solver@example.test","accountIdHash":"final-solver-hash"},
    "solveContext":{
      "problemId":"c0000000-0000-0000-0000-000000000001",
      "selectedConditionals":[{"conditionalProblemId":"c0000000-0000-0000-0000-000000000003"}]
    }
  }'::jsonb
),
(
  'c0000000-0000-0000-0000-000000000003', 'Funded lemma', 'coq', 'Conditional.v',
  'Axiom lemma : True.', repeat('0', 64), 'NY', 'verified', '{}'::jsonb,
  '{"problemKind":"conditional"}'::jsonb
),
(
  'd0000000-0000-0000-0000-000000000001', 'Registration problem', 'coq', 'Problem.v',
  'Theorem target : True.', repeat('1', 64), 'NY', 'verified', '{}'::jsonb,
  '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_registration_base"},"conditionals":[]}'::jsonb
),
(
  'd0000000-0000-0000-0000-000000000002', 'Registration lemma', 'coq', 'Conditional.v',
  'Axiom lemma : True.', repeat('2', 64), 'NY', 'verified', '{}'::jsonb,
  '{
    "problemKind":"conditional",
    "createdByAccount":{"accountProvider":"google","accountId":"register@example.test","accountIdHash":"register-hash"},
    "solveContext":{"problemId":"d0000000-0000-0000-0000-000000000001"},
    "conditionalBounty":{
      "amountYen":200,
      "currency":"jpy",
      "paymentStatus":"paid",
      "serverVerified":true,
      "stripeSessionId":"cs_test_registration_fund",
      "fundingModel":"final-total-fixed-ratio-v1"
    }
  }'::jsonb
),
(
  'e0000000-0000-0000-0000-000000000001', 'Free Conditional problem', 'coq', 'Problem.v',
  'Theorem target : True.', repeat('3', 64), 'NY', 'verified', '{}'::jsonb,
  '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_free_base"},"conditionals":[]}'::jsonb
),
(
  'e0000000-0000-0000-0000-000000000002', 'Free lemma', 'coq', 'Conditional.v',
  'Axiom lemma : True.', repeat('4', 64), 'NY', 'verified', '{}'::jsonb,
  '{
    "problemKind":"conditional",
    "createdByAccount":{"accountProvider":"google","accountId":"free@example.test","accountIdHash":"free-hash"},
    "solveContext":{"problemId":"e0000000-0000-0000-0000-000000000001"},
    "conditionalBounty":null
  }'::jsonb
);

insert into public.stripe_session_claims(session_id, problem_id, purpose)
values
  ('cs_test_atomic', 'a0000000-0000-0000-0000-000000000001', 'problem_bounty'),
  ('cs_test_rollback', 'b0000000-0000-0000-0000-000000000001', 'problem_bounty'),
  ('cs_test_conditional_base', 'c0000000-0000-0000-0000-000000000001', 'problem_bounty'),
  ('cs_test_conditional_fund', 'c0000000-0000-0000-0000-000000000003', 'conditional_bounty'),
  ('cs_test_registration_base', 'd0000000-0000-0000-0000-000000000001', 'problem_bounty'),
  ('cs_test_registration_fund', 'd0000000-0000-0000-0000-000000000002', 'conditional_bounty'),
  ('cs_test_free_base', 'e0000000-0000-0000-0000-000000000001', 'problem_bounty');

do $$
declare
  result jsonb;
  expected_original jsonb := '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_registration_base"},"conditionals":[]}'::jsonb;
  expected_conditional jsonb := '{
    "problemKind":"conditional",
    "createdByAccount":{"accountProvider":"google","accountId":"register@example.test","accountIdHash":"register-hash"},
    "solveContext":{"problemId":"d0000000-0000-0000-0000-000000000001"},
    "conditionalBounty":{
      "amountYen":200,
      "currency":"jpy",
      "paymentStatus":"paid",
      "serverVerified":true,
      "stripeSessionId":"cs_test_registration_fund",
      "fundingModel":"final-total-fixed-ratio-v1"
    }
  }'::jsonb;
  funded_bounty jsonb := '{
    "amountYen":200,
    "currency":"jpy",
    "paymentStatus":"paid",
    "serverVerified":true,
    "stripeSessionId":"cs_test_registration_fund",
    "fundingModel":"final-total-fixed-ratio-v1",
    "existingBountyYen":1000,
    "fixedSharePpm":200000
  }'::jsonb;
  final_original jsonb;
  final_conditional jsonb;
begin
  final_original := expected_original || jsonb_build_object(
    'conditionals',
    jsonb_build_array(jsonb_build_object(
      'originalProblemId', 'd0000000-0000-0000-0000-000000000001',
      'conditionalProblemId', 'd0000000-0000-0000-0000-000000000002',
      'conditionalTitle', 'Registration lemma',
      'submitter', expected_conditional -> 'createdByAccount',
      'bounty', funded_bounty
    ))
  );
  final_conditional := expected_conditional || jsonb_build_object(
    'conditionalBounty', funded_bounty,
    'conditionalOf', jsonb_build_object(
      'problemId', 'd0000000-0000-0000-0000-000000000001',
      'bounty', funded_bounty
    )
  );

  result := public.register_problem_conditional(
    'd0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002',
    expected_original,
    expected_conditional,
    final_original,
    final_conditional,
    160
  );
  if (result ->> 'fixedSharePpm')::integer <> 200000 then
    raise exception 'Conditional registration did not fix the expected ratio.';
  end if;
  if (select request_meta from public.problems where id = 'd0000000-0000-0000-0000-000000000001') <> final_original
    or (select request_meta from public.problems where id = 'd0000000-0000-0000-0000-000000000002') <> final_conditional then
    raise exception 'Conditional registration did not update both rows atomically.';
  end if;
end;
$$;

do $$
declare
  result jsonb;
  expected_original jsonb := '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_free_base"},"conditionals":[]}'::jsonb;
  expected_conditional jsonb := '{
    "problemKind":"conditional",
    "createdByAccount":{"accountProvider":"google","accountId":"free@example.test","accountIdHash":"free-hash"},
    "solveContext":{"problemId":"e0000000-0000-0000-0000-000000000001"},
    "conditionalBounty":null
  }'::jsonb;
  final_original jsonb;
  final_conditional jsonb;
begin
  final_original := expected_original || jsonb_build_object(
    'conditionals',
    jsonb_build_array(jsonb_build_object(
      'originalProblemId', 'e0000000-0000-0000-0000-000000000001',
      'conditionalProblemId', 'e0000000-0000-0000-0000-000000000002',
      'conditionalTitle', 'Free lemma',
      'submitter', expected_conditional -> 'createdByAccount',
      'payment', jsonb_build_object('required', false)
    ))
  );
  final_conditional := expected_conditional || jsonb_build_object(
    'conditionalOf', jsonb_build_object(
      'problemId', 'e0000000-0000-0000-0000-000000000001',
      'payment', jsonb_build_object('required', false)
    )
  );

  result := public.register_problem_conditional(
    'e0000000-0000-0000-0000-000000000001',
    'e0000000-0000-0000-0000-000000000002',
    expected_original,
    expected_conditional,
    final_original,
    final_conditional,
    160
  );
  if (result ->> 'fixedSharePpm')::integer <> 0 then
    raise exception 'Free Conditional unexpectedly received a return share.';
  end if;
  if (select request_meta from public.problems where id = 'e0000000-0000-0000-0000-000000000001') <> final_original
    or (select request_meta from public.problems where id = 'e0000000-0000-0000-0000-000000000002') <> final_conditional then
    raise exception 'Free Conditional registration did not remain atomic.';
  end if;
end;
$$;

do $$
declare
  result jsonb;
  transaction_count integer;
  solver_balance integer;
begin
  result := public.settle_problem_solution(
    'a0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000002',
    '{"problemKind":"problem","bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_atomic"}}'::jsonb,
    '{"problemKind":"theorem","postKind":"theorem","bounty":{"amountCents":0},"solution":{"solutionProblemId":"a0000000-0000-0000-0000-000000000002","status":"solved"}}'::jsonb,
    '{"problemKind":"theorem","postKind":"theorem","solutionOf":{"problemId":"a0000000-0000-0000-0000-000000000001"},"solveContext":{"problemId":"a0000000-0000-0000-0000-000000000001","selectedConditionals":[]}}'::jsonb,
    '[
      {"accountProvider":"google","accountId":"solver@example.test","accountIdHash":"solver-hash","email":"solver@example.test","amountVx":5,"amountYen":1000,"reason":"problem_bounty_award","idempotencyKey":"problem-solution:a0000000-0000-0000-0000-000000000001:a0000000-0000-0000-0000-000000000002"}
    ]'::jsonb,
    160,
    now()
  );

  if jsonb_array_length(result) <> 1 then
    raise exception 'Expected one atomic settlement result.';
  end if;
  if (select proof_state from public.problems where id = 'a0000000-0000-0000-0000-000000000001') <> 'YY' then
    raise exception 'Original problem was not converted to a theorem.';
  end if;
  select count(*) into transaction_count
  from public.ivucx_transactions
  where idempotency_key = 'problem-solution:a0000000-0000-0000-0000-000000000001:a0000000-0000-0000-0000-000000000002';
  if transaction_count <> 1 then
    raise exception 'Expected one committed payout transaction.';
  end if;
  select balance_yen into solver_balance
  from public.ivucx_accounts
  where account_provider = 'google' and account_id_hash = 'solver-hash';
  if solver_balance <> 1000 then
    raise exception 'Atomic settlement balance is incorrect.';
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
      '{"problemKind":"theorem","postKind":"theorem","solutionOf":{"problemId":"b0000000-0000-0000-0000-000000000001"},"solveContext":{"problemId":"b0000000-0000-0000-0000-000000000001","selectedConditionals":[]}}'::jsonb,
      '[
        {"accountProvider":"google","accountId":"rollback@example.test","accountIdHash":"rollback-hash","amountVx":99,"amountYen":1000,"reason":"problem_bounty_award","idempotencyKey":"problem-solution:b0000000-0000-0000-0000-000000000001:b0000000-0000-0000-0000-000000000002"}
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
  where idempotency_key = 'problem-solution:b0000000-0000-0000-0000-000000000001:b0000000-0000-0000-0000-000000000002';
  if transaction_count <> 0 then
    raise exception 'Rejected settlement left a partial payout.';
  end if;
end;
$$;

do $$
declare
  result jsonb;
  solver_balance integer;
  funder_balance integer;
begin
  result := public.settle_problem_solution(
    'c0000000-0000-0000-0000-000000000001',
    'c0000000-0000-0000-0000-000000000002',
    '{
      "problemKind":"problem",
      "bounty":{"amountCents":1000,"currency":"jpy","paymentStatus":"paid","serverVerified":true,"stripeSessionId":"cs_test_conditional_base"},
      "conditionals":[{
        "conditionalProblemId":"c0000000-0000-0000-0000-000000000003",
        "conditionalTitle":"Funded lemma",
        "submitter":{"accountProvider":"google","accountId":"funder@example.test","accountIdHash":"funder-hash"},
        "bounty":{
          "amountYen":200,
          "currency":"jpy",
          "paymentStatus":"paid",
          "serverVerified":true,
          "stripeSessionId":"cs_test_conditional_fund",
          "fundingModel":"final-total-fixed-ratio-v1",
          "existingBountyYen":1000,
          "fixedSharePpm":200000
        }
      }]
    }'::jsonb,
    '{"problemKind":"theorem","postKind":"theorem","bounty":{"amountCents":0},"solution":{"solutionProblemId":"c0000000-0000-0000-0000-000000000002","status":"solved"}}'::jsonb,
    '{
      "problemKind":"theorem",
      "postKind":"theorem",
      "solutionOf":{"problemId":"c0000000-0000-0000-0000-000000000001"},
      "solveContext":{
        "problemId":"c0000000-0000-0000-0000-000000000001",
        "selectedConditionals":[{"conditionalProblemId":"c0000000-0000-0000-0000-000000000003"}]
      }
    }'::jsonb,
    '[
      {
        "accountProvider":"google",
        "accountId":"final-solver@example.test",
        "accountIdHash":"final-solver-hash",
        "amountVx":4.8,
        "amountYen":960,
        "reason":"problem_bounty_award",
        "idempotencyKey":"problem-solution:c0000000-0000-0000-0000-000000000001:c0000000-0000-0000-0000-000000000002"
      },
      {
        "accountProvider":"google",
        "accountId":"funder@example.test",
        "accountIdHash":"funder-hash",
        "amountVx":1.2,
        "amountYen":240,
        "reason":"conditional_usage_award",
        "idempotencyKey":"problem-solution-conditional:c0000000-0000-0000-0000-000000000001:c0000000-0000-0000-0000-000000000002:c0000000-0000-0000-0000-000000000003",
        "meta":{"conditionalProblemId":"c0000000-0000-0000-0000-000000000003","fixedSharePpm":200000}
      }
    ]'::jsonb,
    160,
    now()
  );

  if jsonb_array_length(result) <> 2 then
    raise exception 'Expected solver and Conditional return settlement results.';
  end if;
  select balance_yen into solver_balance
  from public.ivucx_accounts
  where account_provider = 'google' and account_id_hash = 'final-solver-hash';
  select balance_yen into funder_balance
  from public.ivucx_accounts
  where account_provider = 'google' and account_id_hash = 'funder-hash';
  if solver_balance <> 960 or funder_balance <> 240 then
    raise exception 'Final-total Conditional distribution is incorrect.';
  end if;
end;
$$;

rollback;

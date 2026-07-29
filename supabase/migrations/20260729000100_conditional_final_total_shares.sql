create or replace function public.register_problem_conditional(
  p_original_problem_id uuid,
  p_conditional_problem_id uuid,
  p_expected_original_meta jsonb,
  p_expected_conditional_meta jsonb,
  p_final_original_meta jsonb,
  p_final_conditional_meta jsonb,
  p_usd_jpy_rate numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  original_row public.problems%rowtype;
  conditional_row public.problems%rowtype;
  stored_bounty jsonb;
  conditional_snapshot jsonb;
  conditional_bounty jsonb;
  persisted_conditional_bounty jsonb;
  existing_item jsonb;
  existing_conditional_bounty jsonb;
  stored_amount numeric;
  stored_currency text;
  existing_bounty_yen bigint := 0;
  contribution_yen bigint;
  fixed_share_ppm bigint;
  expected_share_ppm bigint;
  total_share_ppm bigint := 0;
  current_conditionals jsonb;
  final_conditionals jsonb;
  stripe_session_id text;
begin
  if p_original_problem_id is null
    or p_conditional_problem_id is null
    or p_original_problem_id = p_conditional_problem_id then
    raise exception 'Conditional problem IDs are invalid.';
  end if;
  if p_usd_jpy_rate is null or p_usd_jpy_rate < 50 or p_usd_jpy_rate > 500 then
    raise exception 'USD/JPY rate is invalid.';
  end if;

  select * into original_row
  from public.problems
  where id = p_original_problem_id
  for update;
  if not found then raise exception 'Original problem was not found.'; end if;

  select * into conditional_row
  from public.problems
  where id = p_conditional_problem_id
  for update;
  if not found then raise exception 'Conditional proof was not found.'; end if;

  if original_row.proof_state <> 'NY' then
    raise exception 'Original problem is not unresolved.';
  end if;
  if conditional_row.proof_state <> 'NY'
    or lower(coalesce(conditional_row.verification_status, '')) <> 'verified' then
    raise exception 'Conditional proof is not fully verified.';
  end if;
  if coalesce(original_row.request_meta, '{}'::jsonb) <> coalesce(p_expected_original_meta, '{}'::jsonb)
    or coalesce(conditional_row.request_meta, '{}'::jsonb) <> coalesce(p_expected_conditional_meta, '{}'::jsonb) then
    raise exception 'Problem metadata changed while Conditional registration was being prepared.';
  end if;

  current_conditionals := coalesce(original_row.request_meta -> 'conditionals', '[]'::jsonb);
  final_conditionals := coalesce(p_final_original_meta -> 'conditionals', '[]'::jsonb);
  if jsonb_typeof(current_conditionals) <> 'array'
    or jsonb_typeof(final_conditionals) <> 'array'
    or jsonb_array_length(current_conditionals) >= 50
    or jsonb_array_length(final_conditionals) <> jsonb_array_length(current_conditionals) + 1 then
    raise exception 'Conditional list is invalid or full.';
  end if;
  if lower(coalesce(p_final_original_meta ->> 'problemKind', '')) <> 'problem'
    or lower(coalesce(p_final_conditional_meta ->> 'problemKind', '')) <> 'conditional'
    or p_final_conditional_meta #>> '{conditionalOf,problemId}' <> p_original_problem_id::text
    or p_final_conditional_meta #>> '{solveContext,problemId}' <> p_original_problem_id::text then
    raise exception 'Final Conditional metadata is not bound to this problem.';
  end if;

  select value into conditional_snapshot
  from jsonb_array_elements(final_conditionals)
  where value ->> 'conditionalProblemId' = p_conditional_problem_id::text;
  if conditional_snapshot is null then
    raise exception 'Final Conditional snapshot is missing.';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(final_conditionals)
    where value ->> 'conditionalProblemId' = p_conditional_problem_id::text
  ) <> 1 then
    raise exception 'Final Conditional snapshot is duplicated.';
  end if;
  if conditional_snapshot ->> 'originalProblemId' <> p_original_problem_id::text
    or coalesce(conditional_snapshot #>> '{submitter,accountProvider}', '') <> coalesce(conditional_row.request_meta #>> '{createdByAccount,accountProvider}', '')
    or coalesce(conditional_snapshot #>> '{submitter,accountId}', '') <> coalesce(conditional_row.request_meta #>> '{createdByAccount,accountId}', '')
    or coalesce(conditional_snapshot #>> '{submitter,accountIdHash}', '') <> coalesce(conditional_row.request_meta #>> '{createdByAccount,accountIdHash}', '') then
    raise exception 'Conditional snapshot submitter or problem binding is invalid.';
  end if;

  for existing_item in select value from jsonb_array_elements(current_conditionals)
  loop
    if not exists (
      select 1
      from jsonb_array_elements(final_conditionals)
      where value ->> 'conditionalProblemId' = existing_item ->> 'conditionalProblemId'
        and value = existing_item
    ) then
      raise exception 'An existing Conditional snapshot was changed.';
    end if;
  end loop;

  if not (conditional_snapshot ? 'bounty') then
    if lower(coalesce(conditional_snapshot #>> '{payment,required}', 'false')) <> 'false'
      or (
        p_final_conditional_meta ? 'conditionalBounty'
        and jsonb_typeof(p_final_conditional_meta -> 'conditionalBounty') <> 'null'
      ) then
      raise exception 'Free Conditional metadata contains invalid funding.';
    end if;

    update public.problems
    set request_meta = p_final_original_meta, updated_at = now()
    where id = p_original_problem_id;

    update public.problems
    set request_meta = p_final_conditional_meta, updated_at = now()
    where id = p_conditional_problem_id;

    return jsonb_build_object(
      'registered', true,
      'conditionalProblemId', p_conditional_problem_id,
      'fixedSharePpm', 0
    );
  end if;

  conditional_bounty := coalesce(p_final_conditional_meta -> 'conditionalBounty', '{}'::jsonb);
  persisted_conditional_bounty := coalesce(conditional_row.request_meta -> 'conditionalBounty', '{}'::jsonb);
  if conditional_snapshot -> 'bounty' <> conditional_bounty then
    raise exception 'Conditional funding snapshots do not match.';
  end if;
  if lower(coalesce(conditional_bounty ->> 'currency', '')) <> 'jpy'
    or lower(coalesce(conditional_bounty ->> 'paymentStatus', '')) <> 'paid'
    or lower(coalesce(conditional_bounty ->> 'serverVerified', 'false')) <> 'true'
    or coalesce(conditional_bounty ->> 'fundingModel', '') <> 'final-total-fixed-ratio-v1'
    or coalesce(conditional_bounty ->> 'amountYen', '') !~ '^[0-9]+$'
    or coalesce(conditional_bounty ->> 'fixedSharePpm', '') !~ '^[0-9]+$'
    or coalesce(conditional_bounty ->> 'existingBountyYen', '') !~ '^[0-9]+$' then
    raise exception 'Conditional bounty is not funded with a valid fixed share.';
  end if;
  if coalesce(persisted_conditional_bounty ->> 'amountYen', '') <> coalesce(conditional_bounty ->> 'amountYen', '')
    or coalesce(persisted_conditional_bounty ->> 'currency', '') <> coalesce(conditional_bounty ->> 'currency', '')
    or coalesce(persisted_conditional_bounty ->> 'stripeSessionId', '') <> coalesce(conditional_bounty ->> 'stripeSessionId', '')
    or lower(coalesce(persisted_conditional_bounty ->> 'paymentStatus', '')) <> 'paid'
    or lower(coalesce(persisted_conditional_bounty ->> 'serverVerified', 'false')) <> 'true' then
    raise exception 'Conditional funding differs from the persisted verified payment.';
  end if;

  contribution_yen := (conditional_bounty ->> 'amountYen')::bigint;
  fixed_share_ppm := (conditional_bounty ->> 'fixedSharePpm')::bigint;
  stripe_session_id := coalesce(conditional_bounty ->> 'stripeSessionId', '');
  if contribution_yen <= 0 or contribution_yen > 1000000000
    or fixed_share_ppm <= 0 or fixed_share_ppm > 500000
    or stripe_session_id = '' then
    raise exception 'Conditional funding amount or share is out of range.';
  end if;
  if not exists (
    select 1 from public.stripe_session_claims
    where session_id = stripe_session_id
      and problem_id = p_conditional_problem_id
      and purpose = 'conditional_bounty'
  ) then
    raise exception 'Conditional Stripe session claim is missing or bound incorrectly.';
  end if;

  stored_bounty := coalesce(
    original_row.request_meta -> 'originalBounty',
    original_row.request_meta -> 'bounty',
    '{}'::jsonb
  );
  if lower(coalesce(stored_bounty ->> 'paymentStatus', stored_bounty ->> 'payment_status', '')) <> 'paid'
    or lower(coalesce(stored_bounty ->> 'serverVerified', 'false')) <> 'true'
    or coalesce(stored_bounty ->> 'amountCents', '') !~ '^[0-9]+$' then
    raise exception 'Stored problem bounty is not server verified as paid.';
  end if;
  stored_amount := (stored_bounty ->> 'amountCents')::numeric;
  stored_currency := lower(coalesce(stored_bounty ->> 'currency', ''));
  if stored_currency = 'jpy' then
    existing_bounty_yen := round(stored_amount)::bigint;
  elsif stored_currency = 'usd' then
    existing_bounty_yen := round((stored_amount / 100) * p_usd_jpy_rate)::bigint;
  else
    raise exception 'Stored problem bounty currency is invalid.';
  end if;

  for existing_item in select value from jsonb_array_elements(current_conditionals)
  loop
    existing_conditional_bounty := coalesce(existing_item -> 'bounty', '{}'::jsonb);
    if existing_conditional_bounty = '{}'::jsonb then continue; end if;
    if lower(coalesce(existing_conditional_bounty ->> 'currency', '')) <> 'jpy'
      or lower(coalesce(existing_conditional_bounty ->> 'paymentStatus', '')) <> 'paid'
      or lower(coalesce(existing_conditional_bounty ->> 'serverVerified', 'false')) <> 'true'
      or coalesce(existing_conditional_bounty ->> 'fundingModel', '') <> 'final-total-fixed-ratio-v1'
      or coalesce(existing_conditional_bounty ->> 'amountYen', '') !~ '^[0-9]+$'
      or coalesce(existing_conditional_bounty ->> 'fixedSharePpm', '') !~ '^[0-9]+$' then
      raise exception 'An existing Conditional bounty is invalid.';
    end if;
    existing_bounty_yen := existing_bounty_yen + (existing_conditional_bounty ->> 'amountYen')::bigint;
    total_share_ppm := total_share_ppm + (existing_conditional_bounty ->> 'fixedSharePpm')::bigint;
  end loop;

  if existing_bounty_yen <= 0 or existing_bounty_yen > 1000000000 then
    raise exception 'Existing bounty total is out of range.';
  end if;
  if (conditional_bounty ->> 'existingBountyYen')::bigint <> existing_bounty_yen then
    raise exception 'Conditional existing-bounty snapshot is stale.';
  end if;
  expected_share_ppm := round(
    (contribution_yen::numeric * 1000000) / existing_bounty_yen::numeric
  )::bigint;
  if fixed_share_ppm <> expected_share_ppm then
    raise exception 'Conditional fixed share does not match its funding ratio.';
  end if;
  if total_share_ppm + fixed_share_ppm > 500000 then
    raise exception 'Conditional return shares exceed the safe half-total limit.';
  end if;
  if existing_bounty_yen + contribution_yen > 1000000000 then
    raise exception 'Funded bounty total exceeds the supported limit.';
  end if;

  update public.problems
  set request_meta = p_final_original_meta, updated_at = now()
  where id = p_original_problem_id;

  update public.problems
  set request_meta = p_final_conditional_meta, updated_at = now()
  where id = p_conditional_problem_id;

  return jsonb_build_object(
    'registered', true,
    'conditionalProblemId', p_conditional_problem_id,
    'existingBountyYen', existing_bounty_yen,
    'contributionYen', contribution_yen,
    'fixedSharePpm', fixed_share_ppm
  );
end;
$$;

revoke all on function public.register_problem_conditional(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, numeric
) from public, anon, authenticated;
grant execute on function public.register_problem_conditional(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, numeric
) to service_role;

create or replace function public.settle_problem_solution(
  p_original_problem_id uuid,
  p_solution_problem_id uuid,
  p_expected_original_meta jsonb,
  p_final_original_meta jsonb,
  p_final_solution_meta jsonb,
  p_payouts jsonb,
  p_usd_jpy_rate numeric,
  p_settled_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  original_row public.problems%rowtype;
  solution_row public.problems%rowtype;
  stored_bounty jsonb;
  conditional_item jsonb;
  conditional_bounty jsonb;
  selected_item jsonb;
  selected_conditional jsonb;
  payout jsonb;
  matching_payout jsonb;
  stored_amount numeric;
  stored_currency text;
  max_payout_yen bigint;
  contribution_yen bigint;
  fixed_share_ppm bigint;
  registered_share_ppm bigint := 0;
  expected_conditional_yen bigint;
  expected_conditional_total_yen bigint := 0;
  expected_conditional_count integer := 0;
  expected_solver_yen bigint;
  payout_total_yen bigint := 0;
  payout_yen bigint;
  payout_vx numeric;
  expected_vx numeric;
  payout_count integer := 0;
  solver_count integer := 0;
  conditional_count integer := 0;
  selected_conditionals jsonb;
  settlement record;
  results jsonb := '[]'::jsonb;
begin
  select * into original_row
  from public.problems
  where id = p_original_problem_id
  for update;
  if not found then raise exception 'Original problem was not found.'; end if;

  select * into solution_row
  from public.problems
  where id = p_solution_problem_id
  for update;
  if not found then raise exception 'Solution theorem was not found.'; end if;

  if original_row.proof_state <> 'NY' then
    raise exception 'Original problem is not unresolved.';
  end if;
  if solution_row.proof_state <> 'YY'
    or lower(coalesce(solution_row.verification_status, '')) <> 'verified' then
    raise exception 'Solution theorem is not fully verified.';
  end if;
  if coalesce(original_row.request_meta, '{}'::jsonb) <> coalesce(p_expected_original_meta, '{}'::jsonb) then
    raise exception 'Original problem changed while settlement was being prepared.';
  end if;
  if p_final_original_meta #>> '{solution,solutionProblemId}' <> p_solution_problem_id::text
    or lower(coalesce(p_final_original_meta #>> '{solution,status}', '')) <> 'solved'
    or lower(coalesce(p_final_original_meta ->> 'problemKind', '')) <> 'theorem'
    or coalesce(p_final_original_meta #>> '{bounty,amountCents}', '') <> '0' then
    raise exception 'Final problem metadata is not a completed theorem settlement.';
  end if;
  if p_final_solution_meta #>> '{solutionOf,problemId}' <> p_original_problem_id::text
    or p_final_solution_meta #>> '{solveContext,problemId}' <> p_original_problem_id::text then
    raise exception 'Final solution metadata is not bound to the original problem.';
  end if;
  if jsonb_typeof(coalesce(p_payouts, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payouts, '[]'::jsonb)) > 21 then
    raise exception 'Settlement payout list is invalid.';
  end if;
  if p_usd_jpy_rate is null or p_usd_jpy_rate < 50 or p_usd_jpy_rate > 500 then
    raise exception 'USD/JPY rate is invalid.';
  end if;

  stored_bounty := coalesce(
    original_row.request_meta -> 'originalBounty',
    original_row.request_meta -> 'bounty',
    '{}'::jsonb
  );
  if lower(coalesce(stored_bounty ->> 'paymentStatus', stored_bounty ->> 'payment_status', '')) <> 'paid'
    or lower(coalesce(stored_bounty ->> 'serverVerified', 'false')) <> 'true'
    or coalesce(stored_bounty ->> 'amountCents', '') !~ '^[0-9]+$' then
    raise exception 'Stored bounty is not server verified as paid.';
  end if;
  if not exists (
    select 1 from public.stripe_session_claims
    where session_id = coalesce(stored_bounty ->> 'stripeSessionId', '')
      and problem_id = p_original_problem_id
      and purpose in ('problem_bounty', 'original_problem_bounty')
  ) then
    raise exception 'Stored bounty Stripe session claim is missing or bound incorrectly.';
  end if;

  stored_amount := (stored_bounty ->> 'amountCents')::numeric;
  stored_currency := lower(coalesce(stored_bounty ->> 'currency', ''));
  if stored_currency = 'jpy' then
    max_payout_yen := round(stored_amount)::bigint;
  elsif stored_currency = 'usd' then
    max_payout_yen := round((stored_amount / 100) * p_usd_jpy_rate)::bigint;
  else
    raise exception 'Stored bounty currency is invalid.';
  end if;

  for conditional_item in
    select value
    from jsonb_array_elements(coalesce(original_row.request_meta -> 'conditionals', '[]'::jsonb))
  loop
    conditional_bounty := coalesce(conditional_item -> 'bounty', '{}'::jsonb);
    if conditional_bounty = '{}'::jsonb then continue; end if;
    if lower(coalesce(conditional_bounty ->> 'currency', '')) <> 'jpy'
      or lower(coalesce(conditional_bounty ->> 'paymentStatus', '')) <> 'paid'
      or lower(coalesce(conditional_bounty ->> 'serverVerified', 'false')) <> 'true'
      or coalesce(conditional_bounty ->> 'fundingModel', '') <> 'final-total-fixed-ratio-v1'
      or coalesce(conditional_bounty ->> 'amountYen', '') !~ '^[0-9]+$'
      or coalesce(conditional_bounty ->> 'fixedSharePpm', '') !~ '^[0-9]+$' then
      raise exception 'Stored Conditional bounty is invalid.';
    end if;
    contribution_yen := (conditional_bounty ->> 'amountYen')::bigint;
    fixed_share_ppm := (conditional_bounty ->> 'fixedSharePpm')::bigint;
    if contribution_yen <= 0 or contribution_yen > 1000000000
      or fixed_share_ppm <= 0 or fixed_share_ppm > 500000 then
      raise exception 'Stored Conditional bounty is out of range.';
    end if;
    if not exists (
      select 1 from public.stripe_session_claims
      where session_id = coalesce(conditional_bounty ->> 'stripeSessionId', '')
        and problem_id::text = conditional_item ->> 'conditionalProblemId'
        and purpose = 'conditional_bounty'
    ) then
      raise exception 'Conditional Stripe session claim is missing or bound incorrectly.';
    end if;
    max_payout_yen := max_payout_yen + contribution_yen;
    registered_share_ppm := registered_share_ppm + fixed_share_ppm;
  end loop;

  if max_payout_yen <= 0 or max_payout_yen > 1000000000 then
    raise exception 'Final bounty total is out of range.';
  end if;
  if registered_share_ppm > 500000 then
    raise exception 'Registered Conditional shares exceed the safe half-total limit.';
  end if;

  selected_conditionals := coalesce(solution_row.request_meta #> '{solveContext,selectedConditionals}', '[]'::jsonb);
  if jsonb_typeof(selected_conditionals) <> 'array'
    or jsonb_array_length(selected_conditionals) > 20 then
    raise exception 'Selected Conditional list is invalid.';
  end if;
  if selected_conditionals <> coalesce(p_final_solution_meta #> '{solveContext,selectedConditionals}', '[]'::jsonb) then
    raise exception 'Selected Conditional list changed during settlement.';
  end if;

  for selected_item in select value from jsonb_array_elements(selected_conditionals)
  loop
    if coalesce(selected_item ->> 'conditionalProblemId', '') = '' then
      raise exception 'A selected Conditional has no problem ID.';
    end if;
    if (
      select count(*)
      from jsonb_array_elements(selected_conditionals)
      where value ->> 'conditionalProblemId' = selected_item ->> 'conditionalProblemId'
    ) <> 1 then
      raise exception 'Selected Conditional IDs must be unique.';
    end if;
    select value into selected_conditional
    from jsonb_array_elements(coalesce(original_row.request_meta -> 'conditionals', '[]'::jsonb))
    where value ->> 'conditionalProblemId' = selected_item ->> 'conditionalProblemId';
    if selected_conditional is null then
      raise exception 'A selected Conditional is not registered on the problem.';
    end if;
    conditional_bounty := coalesce(selected_conditional -> 'bounty', '{}'::jsonb);
    if conditional_bounty = '{}'::jsonb then continue; end if;

    fixed_share_ppm := (conditional_bounty ->> 'fixedSharePpm')::bigint;
    expected_conditional_yen := round(
      (max_payout_yen::numeric * fixed_share_ppm::numeric) / 1000000
    )::bigint;
    expected_conditional_total_yen := expected_conditional_total_yen + expected_conditional_yen;
    expected_conditional_count := expected_conditional_count + 1;

    select value into matching_payout
    from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb))
    where value ->> 'reason' = 'conditional_usage_award'
      and value #>> '{meta,conditionalProblemId}' = selected_item ->> 'conditionalProblemId';
    if matching_payout is null or (
      select count(*)
      from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb))
      where value ->> 'reason' = 'conditional_usage_award'
        and value #>> '{meta,conditionalProblemId}' = selected_item ->> 'conditionalProblemId'
    ) <> 1 then
      raise exception 'Conditional return payout is missing or duplicated.';
    end if;
    if coalesce(matching_payout ->> 'amountYen', '') !~ '^[0-9]+$'
      or (matching_payout ->> 'amountYen')::bigint <> expected_conditional_yen
      or coalesce(matching_payout #>> '{meta,fixedSharePpm}', '') !~ '^[0-9]+$'
      or (matching_payout #>> '{meta,fixedSharePpm}')::bigint <> fixed_share_ppm
      or coalesce(matching_payout ->> 'accountProvider', '') <> coalesce(selected_conditional #>> '{submitter,accountProvider}', '')
      or coalesce(matching_payout ->> 'accountId', '') <> coalesce(selected_conditional #>> '{submitter,accountId}', '')
      or coalesce(matching_payout ->> 'accountIdHash', '') <> coalesce(selected_conditional #>> '{submitter,accountIdHash}', '')
      or matching_payout ->> 'idempotencyKey' <> concat(
        'problem-solution-conditional:',
        p_original_problem_id::text,
        ':',
        p_solution_problem_id::text,
        ':',
        selected_item ->> 'conditionalProblemId'
      ) then
      raise exception 'Conditional return payout does not match its fixed share.';
    end if;
  end loop;

  expected_solver_yen := max_payout_yen - expected_conditional_total_yen;
  if expected_solver_yen <= 0
    or expected_conditional_total_yen * 2 > max_payout_yen + 20 then
    raise exception 'Conditional returns leave an unsafe solver payout.';
  end if;

  for payout in select value from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb))
  loop
    payout_count := payout_count + 1;
    if coalesce(payout ->> 'amountYen', '') !~ '^[0-9]+$' then
      raise exception 'Settlement payout amount is invalid.';
    end if;
    payout_yen := (payout ->> 'amountYen')::bigint;
    if payout_yen <= 0 or payout_yen > 1000000000 then
      raise exception 'Settlement payout amount is out of range.';
    end if;
    payout_vx := coalesce(nullif(payout ->> 'amountVx', '')::numeric, 0);
    expected_vx := round(payout_yen::numeric / 200, 6);
    if payout_vx <> expected_vx then
      raise exception 'Settlement payout does not use the Vx 1 = JPY 200 rate.';
    end if;
    if coalesce(payout ->> 'accountProvider', '') = ''
      or coalesce(payout ->> 'accountId', '') = ''
      or coalesce(payout ->> 'accountIdHash', '') = ''
      or coalesce(payout ->> 'idempotencyKey', '') = '' then
      raise exception 'Settlement payout identity is incomplete.';
    end if;

    if payout ->> 'reason' = 'problem_bounty_award' then
      solver_count := solver_count + 1;
      if payout_yen <> expected_solver_yen
        or coalesce(payout ->> 'accountProvider', '') <> coalesce(solution_row.request_meta #>> '{createdByAccount,accountProvider}', '')
        or coalesce(payout ->> 'accountId', '') <> coalesce(solution_row.request_meta #>> '{createdByAccount,accountId}', '')
        or coalesce(payout ->> 'accountIdHash', '') <> coalesce(solution_row.request_meta #>> '{createdByAccount,accountIdHash}', '')
        or payout ->> 'idempotencyKey' <> concat(
          'problem-solution:',
          p_original_problem_id::text,
          ':',
          p_solution_problem_id::text
        ) then
        raise exception 'Solver payout does not match the verified solution owner or amount.';
      end if;
    elsif payout ->> 'reason' = 'conditional_usage_award' then
      conditional_count := conditional_count + 1;
    else
      raise exception 'Settlement payout reason is not allowed.';
    end if;
    payout_total_yen := payout_total_yen + payout_yen;
  end loop;

  if solver_count <> 1
    or conditional_count <> expected_conditional_count
    or payout_count <> 1 + expected_conditional_count
    or payout_total_yen <> max_payout_yen then
    raise exception 'Settlement payouts do not match the verified final bounty distribution.';
  end if;

  for payout in select value from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb))
  loop
    select * into settlement
    from public.credit_ivucx_account(
      payout ->> 'accountProvider',
      payout ->> 'accountId',
      payout ->> 'accountIdHash',
      coalesce(payout ->> 'email', ''),
      coalesce(payout ->> 'name', ''),
      (payout ->> 'amountVx')::numeric,
      (payout ->> 'amountYen')::integer,
      'jpy',
      payout ->> 'reason',
      payout ->> 'idempotencyKey',
      p_original_problem_id,
      p_solution_problem_id,
      coalesce(payout -> 'bounty', '{}'::jsonb),
      coalesce(payout -> 'meta', '{}'::jsonb),
      coalesce(p_settled_at, now())
    );
    results := results || jsonb_build_array(jsonb_build_object(
      'idempotencyKey', payout ->> 'idempotencyKey',
      'inserted', settlement.inserted,
      'transactionId', settlement.transaction_id,
      'balanceVx', settlement.balance_vx,
      'balanceYen', settlement.balance_yen
    ));
  end loop;

  update public.problems
  set proof_state = 'YY', request_meta = p_final_original_meta, updated_at = now()
  where id = p_original_problem_id;

  update public.problems
  set request_meta = p_final_solution_meta, updated_at = now()
  where id = p_solution_problem_id;

  return results;
end;
$$;

revoke all on function public.settle_problem_solution(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, numeric, timestamptz
) from public, anon, authenticated;
grant execute on function public.settle_problem_solution(
  uuid, uuid, jsonb, jsonb, jsonb, jsonb, numeric, timestamptz
) to service_role;

insert into public.security_migration_markers(version)
values ('20260729000100')
on conflict (version) do update set applied_at = excluded.applied_at;

notify pgrst, 'reload schema';

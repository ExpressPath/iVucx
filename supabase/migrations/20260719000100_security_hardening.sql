create extension if not exists pgcrypto;

revoke all on public.blue_accounts from public, anon, authenticated;
revoke all on public.blue_sessions from public, anon, authenticated;
revoke all on public.blue_auth_audit_logs from public, anon, authenticated;
revoke all on public.problems from public, anon, authenticated;
revoke all on public.helper_jobs from public, anon, authenticated;
revoke all on public.helper_conversion_plans from public, anon, authenticated;
revoke all on public.ivucx_accounts from public, anon, authenticated;
revoke all on public.ivucx_transactions from public, anon, authenticated;
revoke all on public.ivucx_notifications from public, anon, authenticated;
revoke all on public.search_chat_keeps from public, anon, authenticated;
revoke all on public.proof_ai_agent_accounts from public, anon, authenticated;

grant select, insert, update, delete on public.blue_accounts to service_role;
grant select, insert, update, delete on public.blue_sessions to service_role;
grant select, insert, update, delete on public.blue_auth_audit_logs to service_role;
grant select, insert, update, delete on public.problems to service_role;
grant select, insert, update, delete on public.helper_jobs to service_role;
grant select, insert, update, delete on public.helper_conversion_plans to service_role;
grant select, insert, update, delete on public.ivucx_accounts to service_role;
grant select, insert, update, delete on public.ivucx_transactions to service_role;
grant select, insert, update, delete on public.ivucx_notifications to service_role;
grant select, insert, update, delete on public.search_chat_keeps to service_role;
grant select, insert, update, delete on public.proof_ai_agent_accounts to service_role;

create table if not exists public.email_verification_challenges (
  nonce uuid primary key,
  email_hash text not null,
  code_hash text not null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_email_verification_challenges_expires
  on public.email_verification_challenges(expires_at);

alter table public.email_verification_challenges enable row level security;
revoke all on public.email_verification_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.email_verification_challenges to service_role;

create or replace function public.consume_email_verification_attempt(
  p_nonce uuid,
  p_email_hash text
)
returns table(status text, code_hash text)
language plpgsql
security definer
set search_path = public
as $$
declare
  challenge public.email_verification_challenges%rowtype;
begin
  if mod(hashtextextended(p_nonce::text, 0), 128) = 0 then
    delete from public.email_verification_challenges
    where expires_at < now() - interval '1 day'
       or consumed_at < now() - interval '1 day';
  end if;

  select * into challenge
  from public.email_verification_challenges
  where nonce = p_nonce
  for update;

  if not found or challenge.email_hash <> p_email_hash then
    return query select 'missing'::text, ''::text;
    return;
  end if;
  if challenge.consumed_at is not null then
    return query select 'consumed'::text, ''::text;
    return;
  end if;
  if challenge.expires_at <= now() then
    return query select 'expired'::text, ''::text;
    return;
  end if;
  if challenge.attempts >= challenge.max_attempts then
    return query select 'max_attempts'::text, ''::text;
    return;
  end if;

  update public.email_verification_challenges
  set attempts = attempts + 1
  where nonce = p_nonce;

  return query select 'ok'::text, challenge.code_hash;
end;
$$;

revoke all on function public.consume_email_verification_attempt(uuid, text) from public, anon, authenticated;
grant execute on function public.consume_email_verification_attempt(uuid, text) to service_role;

create table if not exists public.api_rate_limit_buckets (
  bucket_key text not null,
  route text not null,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (bucket_key, route)
);

alter table public.api_rate_limit_buckets enable row level security;
revoke all on public.api_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.api_rate_limit_buckets to service_role;

create or replace function public.consume_api_rate_limit(
  p_bucket_key text,
  p_route text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
  current_window timestamptz;
  bounded_limit integer := greatest(1, least(p_limit, 10000));
  bounded_window integer := greatest(1, least(p_window_seconds, 86400));
begin
  if mod(hashtextextended(p_bucket_key, 0), 128) = 0 then
    delete from public.api_rate_limit_buckets
    where updated_at < now() - interval '2 days';
  end if;

  insert into public.api_rate_limit_buckets(
    bucket_key, route, window_started_at, request_count, updated_at
  ) values (
    p_bucket_key, p_route, now(), 1, now()
  )
  on conflict (bucket_key, route) do update
  set window_started_at = case
        when api_rate_limit_buckets.window_started_at <= now() - make_interval(secs => bounded_window)
          then now()
        else api_rate_limit_buckets.window_started_at
      end,
      request_count = case
        when api_rate_limit_buckets.window_started_at <= now() - make_interval(secs => bounded_window)
          then 1
        else api_rate_limit_buckets.request_count + 1
      end,
      updated_at = now()
  returning request_count, window_started_at into current_count, current_window;

  return query select
    current_count <= bounded_limit,
    greatest(0, bounded_limit - current_count),
    greatest(1, ceil(extract(epoch from (current_window + make_interval(secs => bounded_window) - now())))::integer);
end;
$$;

revoke all on function public.consume_api_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, text, integer, integer) to service_role;

create or replace function public.record_blue_login_failure(
  p_account_id_normalized text,
  p_max_failures integer,
  p_lock_minutes integer
)
returns table(failed_attempts integer, locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  account_row public.blue_accounts%rowtype;
  next_failures integer;
  bounded_max integer := greatest(2, least(p_max_failures, 20));
  bounded_lock integer := greatest(1, least(p_lock_minutes, 1440));
begin
  select * into account_row
  from public.blue_accounts
  where account_id_normalized = p_account_id_normalized
  for update;

  if not found then
    return;
  end if;
  if account_row.locked_until is not null and account_row.locked_until > now() then
    return query select account_row.failed_attempts, account_row.locked_until;
    return;
  end if;

  next_failures := coalesce(account_row.failed_attempts, 0) + 1;
  update public.blue_accounts
  set failed_attempts = case when next_failures >= bounded_max then 0 else next_failures end,
      locked_until = case when next_failures >= bounded_max then now() + make_interval(mins => bounded_lock) else null end,
      updated_at = now()
  where account_id_normalized = p_account_id_normalized
  returning blue_accounts.failed_attempts, blue_accounts.locked_until
  into failed_attempts, locked_until;

  return next;
end;
$$;

revoke all on function public.record_blue_login_failure(text, integer, integer) from public, anon, authenticated;
grant execute on function public.record_blue_login_failure(text, integer, integer) to service_role;

create table if not exists public.stripe_session_claims (
  session_id text primary key,
  helper_job_id text,
  problem_id uuid references public.problems(id) on delete set null,
  purpose text not null default 'problem_bounty',
  claimed_at timestamptz not null default now()
);

alter table public.stripe_session_claims enable row level security;
revoke all on public.stripe_session_claims from public, anon, authenticated;
grant select, insert, update, delete on public.stripe_session_claims to service_role;

insert into public.stripe_session_claims(session_id, helper_job_id, problem_id, purpose)
select distinct
  request_meta #>> '{bounty,stripeSessionId}',
  helper_job_id,
  id,
  'problem_bounty'
from public.problems
where coalesce(request_meta #>> '{bounty,stripeSessionId}', '') <> ''
on conflict (session_id) do nothing;

insert into public.stripe_session_claims(session_id, helper_job_id, problem_id, purpose)
select distinct
  request_meta #>> '{originalBounty,stripeSessionId}',
  helper_job_id,
  id,
  'original_problem_bounty'
from public.problems
where coalesce(request_meta #>> '{originalBounty,stripeSessionId}', '') <> ''
on conflict (session_id) do nothing;

alter table public.ivucx_transactions add column if not exists email text;

create or replace function public.credit_ivucx_account(
  p_account_provider text,
  p_account_id text,
  p_account_id_hash text,
  p_email text,
  p_name text,
  p_amount_vx numeric,
  p_amount_yen integer,
  p_currency text,
  p_reason text,
  p_idempotency_key text,
  p_problem_id uuid,
  p_solution_problem_id uuid,
  p_bounty jsonb,
  p_meta jsonb,
  p_created_at timestamptz
)
returns table(inserted boolean, transaction_id uuid, balance_vx numeric, balance_yen integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_tx public.ivucx_transactions%rowtype;
  new_transaction_id uuid;
  account_row public.ivucx_accounts%rowtype;
begin
  if coalesce(p_account_provider, '') = '' or coalesce(p_account_id, '') = '' or coalesce(p_account_id_hash, '') = '' then
    raise exception 'A complete account identity is required.';
  end if;
  if coalesce(p_idempotency_key, '') = '' then
    raise exception 'An idempotency key is required.';
  end if;
  if coalesce(p_amount_vx, 0) < 0 or coalesce(p_amount_yen, 0) < 0 then
    raise exception 'Credit amounts cannot be negative.';
  end if;

  select * into existing_tx
  from public.ivucx_transactions
  where idempotency_key = p_idempotency_key
  for update;

  if found then
    if existing_tx.account_provider <> p_account_provider
      or existing_tx.account_id_hash <> p_account_id_hash
      or existing_tx.amount_vx <> p_amount_vx
      or existing_tx.amount_yen <> p_amount_yen then
      raise exception 'Idempotency key conflicts with an existing transaction.';
    end if;
    select * into account_row
    from public.ivucx_accounts
    where account_provider = p_account_provider and account_id_hash = p_account_id_hash;
    return query select false, existing_tx.id, coalesce(account_row.balance_vx, 0), coalesce(account_row.balance_yen, 0);
    return;
  end if;

  insert into public.ivucx_accounts(
    account_provider, account_id, account_id_hash, email, name, balance_vx, balance_yen
  ) values (
    p_account_provider, p_account_id, p_account_id_hash, nullif(p_email, ''), nullif(p_name, ''), 0, 0
  )
  on conflict (account_provider, account_id_hash) do update
  set account_id = excluded.account_id,
      email = coalesce(excluded.email, ivucx_accounts.email),
      name = coalesce(excluded.name, ivucx_accounts.name),
      updated_at = now();

  insert into public.ivucx_transactions(
    account_provider, account_id, account_id_hash, email, direction,
    amount_vx, amount_yen, currency, reason, idempotency_key,
    problem_id, solution_problem_id, bounty, meta, created_at
  ) values (
    p_account_provider, p_account_id, p_account_id_hash, nullif(p_email, ''), 'credit',
    p_amount_vx, p_amount_yen, coalesce(nullif(p_currency, ''), 'jpy'), p_reason, p_idempotency_key,
    p_problem_id, p_solution_problem_id, coalesce(p_bounty, '{}'::jsonb), coalesce(p_meta, '{}'::jsonb),
    coalesce(p_created_at, now())
  )
  returning id into new_transaction_id;

  update public.ivucx_accounts as account
  set balance_vx = account.balance_vx + p_amount_vx,
      balance_yen = account.balance_yen + p_amount_yen,
      updated_at = now()
  where account.account_provider = p_account_provider and account.account_id_hash = p_account_id_hash
  returning account.* into account_row;

  return query select true, new_transaction_id, account_row.balance_vx, account_row.balance_yen;
end;
$$;

revoke all on function public.credit_ivucx_account(
  text, text, text, text, text, numeric, integer, text, text, text, uuid, uuid, jsonb, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.credit_ivucx_account(
  text, text, text, text, text, numeric, integer, text, text, text, uuid, uuid, jsonb, jsonb, timestamptz
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
set search_path = public
as $$
declare
  original_row public.problems%rowtype;
  solution_row public.problems%rowtype;
  stored_bounty jsonb;
  stored_amount numeric;
  stored_currency text;
  max_payout_yen integer;
  payout_total_yen numeric := 0;
  payout_count integer := 0;
  payout jsonb;
  payout_yen numeric;
  payout_vx numeric;
  expected_vx numeric;
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
  if solution_row.proof_state <> 'YY' or lower(coalesce(solution_row.verification_status, '')) <> 'verified' then
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
  if p_final_solution_meta #>> '{solutionOf,problemId}' <> p_original_problem_id::text then
    raise exception 'Final solution metadata is not bound to the original problem.';
  end if;
  if jsonb_typeof(coalesce(p_payouts, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payouts, '[]'::jsonb)) > 21 then
    raise exception 'Settlement payout list is invalid.';
  end if;

  stored_bounty := coalesce(
    original_row.request_meta -> 'originalBounty',
    original_row.request_meta -> 'bounty',
    '{}'::jsonb
  );
  if lower(coalesce(stored_bounty ->> 'paymentStatus', stored_bounty ->> 'payment_status', '')) <> 'paid'
    or lower(coalesce(stored_bounty ->> 'serverVerified', 'false')) <> 'true' then
    raise exception 'Stored bounty is not server verified as paid.';
  end if;
  if coalesce(stored_bounty ->> 'amountCents', '') !~ '^[0-9]+$' then
    raise exception 'Stored bounty amount is invalid.';
  end if;
  stored_amount := (stored_bounty ->> 'amountCents')::numeric;
  stored_currency := lower(coalesce(stored_bounty ->> 'currency', ''));
  if stored_currency = 'jpy' then
    max_payout_yen := round(stored_amount)::integer;
  elsif stored_currency = 'usd' and p_usd_jpy_rate between 50 and 500 then
    max_payout_yen := round((stored_amount / 100) * p_usd_jpy_rate)::integer;
  else
    raise exception 'Stored bounty currency or exchange rate is invalid.';
  end if;

  for payout in select value from jsonb_array_elements(coalesce(p_payouts, '[]'::jsonb))
  loop
    payout_count := payout_count + 1;
    if coalesce(payout ->> 'amountYen', '') !~ '^[0-9]+$' then
      raise exception 'Settlement payout amount is invalid.';
    end if;
    payout_yen := (payout ->> 'amountYen')::numeric;
    if payout_yen <= 0 or payout_yen > 1000000000 then
      raise exception 'Settlement payout amount is out of range.';
    end if;
    payout_vx := coalesce(nullif(payout ->> 'amountVx', '')::numeric, 0);
    expected_vx := round(payout_yen / 200, 6);
    if payout_vx <> expected_vx then
      raise exception 'Settlement payout does not use the Vx 1 = JPY 200 rate.';
    end if;
    if coalesce(payout ->> 'accountProvider', '') = ''
      or coalesce(payout ->> 'accountId', '') = ''
      or coalesce(payout ->> 'accountIdHash', '') = ''
      or coalesce(payout ->> 'idempotencyKey', '') = '' then
      raise exception 'Settlement payout identity is incomplete.';
    end if;
    payout_total_yen := payout_total_yen + payout_yen;
  end loop;

  if round(payout_total_yen)::integer <> max_payout_yen then
    raise exception 'Settlement payouts do not equal the verified bounty.';
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

create table if not exists public.security_migration_markers (
  version text primary key,
  applied_at timestamptz not null default now()
);

alter table public.security_migration_markers enable row level security;
revoke all on public.security_migration_markers from public, anon, authenticated;
grant select, insert, update, delete on public.security_migration_markers to service_role;

insert into public.security_migration_markers(version)
values ('20260719000100')
on conflict (version) do update set applied_at = excluded.applied_at;

notify pgrst, 'reload schema';

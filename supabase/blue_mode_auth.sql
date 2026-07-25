-- BlueMode auth schema
-- Run this SQL in Supabase SQL Editor before deploying auth APIs.

create table if not exists public.blue_accounts (
  account_id text primary key,
  account_id_normalized text not null unique,
  recovery_hash text not null,
  rewards jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'disabled')),
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.blue_accounts
  add column if not exists cookie_history_consent text not null default 'unknown'
    check (cookie_history_consent in ('unknown', 'accepted', 'declined'));

alter table public.blue_accounts
  add column if not exists cookie_history_consent_updated_at timestamptz;

create table if not exists public.blue_sessions (
  session_token_hash text primary key,
  account_id text not null references public.blue_accounts(account_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create table if not exists public.blue_auth_audit_logs (
  id bigserial primary key,
  account_id text,
  event text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_blue_sessions_account_id
  on public.blue_sessions(account_id);

create index if not exists idx_blue_sessions_expires_at
  on public.blue_sessions(expires_at);

create index if not exists idx_blue_auth_audit_logs_account_id
  on public.blue_auth_audit_logs(account_id);

create table if not exists public.ivucx_accounts (
  id uuid primary key default gen_random_uuid(),
  account_provider text not null default 'google',
  account_id text not null,
  account_id_hash text not null,
  email text,
  name text,
  balance_vx numeric(18,6) not null default 0,
  balance_yen integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_provider, account_id_hash)
);

create table if not exists public.ivucx_transactions (
  id uuid primary key default gen_random_uuid(),
  account_provider text not null default 'google',
  account_id text not null,
  account_id_hash text not null,
  email text,
  direction text not null check (direction in ('credit', 'debit')),
  amount_vx numeric(18,6) not null default 0,
  amount_yen integer not null default 0,
  currency text not null default 'jpy',
  reason text not null default '',
  idempotency_key text not null,
  problem_id uuid,
  solution_problem_id uuid,
  bounty jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(idempotency_key)
);

alter table public.ivucx_transactions
  add column if not exists email text;

create table if not exists public.ivucx_notifications (
  id uuid primary key default gen_random_uuid(),
  account_provider text not null default 'google',
  account_id text not null,
  account_id_hash text not null,
  type text not null default 'notice',
  title text not null default '',
  message text not null default '',
  problem_id uuid,
  solution_problem_id uuid,
  idempotency_key text not null,
  meta jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(idempotency_key)
);

create index if not exists idx_ivucx_accounts_account
  on public.ivucx_accounts(account_provider, account_id_hash);

create index if not exists idx_ivucx_transactions_account_created
  on public.ivucx_transactions(account_provider, account_id_hash, created_at desc);

create index if not exists idx_ivucx_transactions_email_created
  on public.ivucx_transactions(email, created_at desc);

create index if not exists idx_ivucx_notifications_account_created
  on public.ivucx_notifications(account_provider, account_id_hash, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_blue_accounts_touch_updated_at on public.blue_accounts;
create trigger trg_blue_accounts_touch_updated_at
before update on public.blue_accounts
for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_ivucx_accounts_touch_updated_at on public.ivucx_accounts;
create trigger trg_ivucx_accounts_touch_updated_at
before update on public.ivucx_accounts
for each row execute procedure public.touch_updated_at();

alter table public.blue_accounts enable row level security;
alter table public.blue_sessions enable row level security;
alter table public.blue_auth_audit_logs enable row level security;
alter table public.ivucx_accounts enable row level security;
alter table public.ivucx_transactions enable row level security;
alter table public.ivucx_notifications enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.ivucx_accounts to service_role;
grant select, insert, update, delete on public.ivucx_transactions to service_role;
grant select, insert, update, delete on public.ivucx_notifications to service_role;

-- No policies are created intentionally.
-- Service role key bypasses RLS; anon/authenticated cannot query these tables.
notify pgrst, 'reload schema';

create extension if not exists pgcrypto;

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
  direction text not null check (direction in ('credit', 'debit')),
  amount_vx numeric(18,6) not null default 0,
  amount_yen integer not null default 0,
  currency text not null default 'jpy',
  reason text not null default '',
  idempotency_key text not null,
  problem_id uuid references public.problems(id) on delete set null,
  solution_problem_id uuid references public.problems(id) on delete set null,
  bounty jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(idempotency_key)
);

create table if not exists public.ivucx_notifications (
  id uuid primary key default gen_random_uuid(),
  account_provider text not null default 'google',
  account_id text not null,
  account_id_hash text not null,
  type text not null default 'notice',
  title text not null default '',
  message text not null default '',
  problem_id uuid references public.problems(id) on delete set null,
  solution_problem_id uuid references public.problems(id) on delete set null,
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

create index if not exists idx_ivucx_notifications_account_created
  on public.ivucx_notifications(account_provider, account_id_hash, created_at desc);

drop trigger if exists trg_ivucx_accounts_touch_updated_at on public.ivucx_accounts;
create trigger trg_ivucx_accounts_touch_updated_at
before update on public.ivucx_accounts
for each row execute procedure public.touch_updated_at();

alter table public.ivucx_accounts enable row level security;
alter table public.ivucx_transactions enable row level security;
alter table public.ivucx_notifications enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on public.ivucx_accounts to service_role;
grant select, insert, update, delete on public.ivucx_transactions to service_role;
grant select, insert, update, delete on public.ivucx_notifications to service_role;

notify pgrst, 'reload schema';

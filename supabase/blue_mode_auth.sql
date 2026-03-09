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

alter table public.blue_accounts enable row level security;
alter table public.blue_sessions enable row level security;
alter table public.blue_auth_audit_logs enable row level security;

-- No policies are created intentionally.
-- Service role key bypasses RLS; anon/authenticated cannot query these tables.

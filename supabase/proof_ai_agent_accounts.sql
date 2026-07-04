create table if not exists public.proof_ai_agent_accounts (
  id uuid primary key default gen_random_uuid(),
  account_provider text not null default 'google',
  account_id text not null,
  account_id_hash text not null,
  email text,
  name text,
  provider text not null,
  provider_label text,
  model text,
  context_engine text,
  language text,
  key_source text not null default 'browser-local',
  approved boolean not null default true,
  approved_at timestamptz not null default now(),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_provider, account_id, provider)
);

create index if not exists proof_ai_agent_accounts_account_idx
  on public.proof_ai_agent_accounts(account_provider, account_id);

create index if not exists proof_ai_agent_accounts_provider_idx
  on public.proof_ai_agent_accounts(provider);

alter table public.proof_ai_agent_accounts enable row level security;

comment on table public.proof_ai_agent_accounts is
  'Links logged-in PROVF accounts to approved proof AI providers. API keys are not stored here.';

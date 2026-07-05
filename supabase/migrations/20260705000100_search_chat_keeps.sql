create table if not exists public.search_chat_keeps (
  id uuid primary key default gen_random_uuid(),
  account_provider text not null default 'google',
  account_id text not null,
  account_id_hash text not null,
  email text,
  name text,
  title text not null default 'Search chat',
  system_mode text,
  turn_count integer not null default 0,
  citation_count integer not null default 0,
  conversation jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists search_chat_keeps_account_idx
  on public.search_chat_keeps(account_provider, account_id, created_at desc);

create index if not exists search_chat_keeps_account_hash_idx
  on public.search_chat_keeps(account_id_hash, created_at desc);

create index if not exists search_chat_keeps_conversation_gin_idx
  on public.search_chat_keeps using gin(conversation);

alter table public.search_chat_keeps enable row level security;

comment on table public.search_chat_keeps is
  'Saved PROVF search chat conversations kept by logged-in accounts.';

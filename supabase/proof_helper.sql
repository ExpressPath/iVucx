-- Proof helper schema
-- Run this SQL in Supabase SQL Editor before enabling Railway helper persistence.

create extension if not exists pgcrypto;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.problems (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  language text not null check (language in ('lean', 'coq')),
  file_name text not null default '',
  source_code text not null,
  source_sha256 text not null,
  proof_state text not null check (proof_state in ('YY', 'NY', 'YN', 'NN')),
  verification_status text not null check (verification_status in ('verified', 'failed', 'skipped')),
  verification_result jsonb not null default '{}'::jsonb,
  normalized_format text not null default 'typed-lambda-v1',
  normalized_term jsonb not null,
  adapter_name text not null default '',
  adapter_meta jsonb not null default '{}'::jsonb,
  helper_job_id text,
  request_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.helper_jobs (
  id text primary key,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  title text not null default '',
  language text not null default '',
  file_name text not null default '',
  normalized_format text not null default 'typed-lambda-v1',
  proof_state text,
  verification_status text,
  source_sha256 text,
  result jsonb,
  error jsonb,
  problem_id uuid references public.problems(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_problems_language_created_at
  on public.problems(language, created_at desc);

create index if not exists idx_problems_source_sha256
  on public.problems(source_sha256);

create index if not exists idx_helper_jobs_status_created_at
  on public.helper_jobs(status, created_at desc);

drop trigger if exists trg_problems_touch_updated_at on public.problems;
create trigger trg_problems_touch_updated_at
before update on public.problems
for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_helper_jobs_touch_updated_at on public.helper_jobs;
create trigger trg_helper_jobs_touch_updated_at
before update on public.helper_jobs
for each row execute procedure public.touch_updated_at();

alter table public.problems enable row level security;
alter table public.helper_jobs enable row level security;

-- No policies are created intentionally.
-- Service role key bypasses RLS; anon/authenticated cannot query these tables.

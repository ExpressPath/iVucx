create index if not exists idx_problems_created_at_desc
  on public.problems (created_at desc);

create index if not exists idx_problems_updated_at_desc
  on public.problems (updated_at desc);

create index if not exists idx_search_chat_keeps_account_updated_at
  on public.search_chat_keeps (account_id_hash, updated_at desc);

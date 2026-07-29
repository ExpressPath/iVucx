alter function public.touch_updated_at() set search_path = '';

create index if not exists idx_helper_conversion_plans_problem_id
  on public.helper_conversion_plans(problem_id);
create index if not exists idx_helper_jobs_problem_id
  on public.helper_jobs(problem_id);
create index if not exists idx_ivucx_notifications_problem_id
  on public.ivucx_notifications(problem_id);
create index if not exists idx_ivucx_notifications_solution_problem_id
  on public.ivucx_notifications(solution_problem_id);
create index if not exists idx_ivucx_transactions_problem_id
  on public.ivucx_transactions(problem_id);
create index if not exists idx_ivucx_transactions_solution_problem_id
  on public.ivucx_transactions(solution_problem_id);
create index if not exists idx_stripe_session_claims_problem_id
  on public.stripe_session_claims(problem_id);

insert into public.security_migration_markers(version)
values ('20260729000300')
on conflict (version) do update set applied_at = excluded.applied_at;

notify pgrst, 'reload schema';

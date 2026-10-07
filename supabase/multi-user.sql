-- CodeShelf – upgrade an existing project for multiple users (run once, after schema.sql).
-- Supabase Dashboard → SQL Editor → New query → Run. Safe to run more than once.

-- Users may delete their own rows ("Delete my cloud data" in the extension).
drop policy if exists "Delete own solutions" on public.solutions;
create policy "Delete own solutions" on public.solutions
  for delete to authenticated
  using (user_id = (select auth.uid()));
grant delete on public.solutions to authenticated;

-- Size limits so a single account can't store arbitrarily large rows.
alter table public.solutions drop constraint if exists solutions_size_limits;
alter table public.solutions add constraint solutions_size_limits check (
      length(submission_id) <= 32
  and length(title) <= 300
  and length(slug) <= 200
  and length(url) <= 500
  and coalesce(length(question_id), 0) <= 32
  and length(language) <= 50
  and coalesce(length(language_name), 0) <= 50
  and length(code) <= 100000
  and coalesce(length(runtime), 0) <= 50
  and coalesce(length(memory), 0) <= 50
  and length(code_hash) = 64
  and length(source) <= 50
);

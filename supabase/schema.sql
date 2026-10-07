-- CodeShelf – Supabase schema.
-- Paste into Supabase Dashboard → SQL Editor → New query, and run once.

create table if not exists public.solutions (
  user_id            uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  submission_id      text        not null,
  title              text        not null,
  slug               text        not null,
  url                text        not null,
  question_id        text,
  language           text        not null,  -- LeetCode slug, e.g. "golang"
  language_name      text,                  -- display name, e.g. "Go"
  code               text        not null,
  runtime            text,
  memory             text,
  runtime_percentile double precision,
  memory_percentile  double precision,
  submitted_at       timestamptz,
  judged_at          timestamptz,
  code_hash          text        not null,
  source             text        not null default 'leetcode.com',
  saved_at           timestamptz,
  created_at         timestamptz not null default now(),
  -- One row per submission per user: re-sending the same submission is a no-op.
  primary key (user_id, submission_id)
);

create index if not exists solutions_user_slug_idx on public.solutions (user_id, slug);

-- Row Level Security: each signed-in user can read and add only their own rows.
-- There is deliberately no UPDATE policy: saved solutions can't be modified.
alter table public.solutions enable row level security;

drop policy if exists "Read own solutions" on public.solutions;
create policy "Read own solutions" on public.solutions
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Insert own solutions" on public.solutions;
create policy "Insert own solutions" on public.solutions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

revoke all on public.solutions from anon;
grant select, insert on public.solutions to authenticated;

-- Multi-user additions (delete-own policy, size limits) live in multi-user.sql; run it next.

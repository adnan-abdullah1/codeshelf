-- CodeShelf – remove duplicate solutions (identical code for the same problem and
-- language), keeping the earliest saved copy. Safe to run more than once.
-- Supabase Dashboard → SQL Editor → New query → Run.

-- Preview what will be deleted:
select s.submission_id, s.slug, s.language, s.saved_at
from public.solutions s
join public.solutions keep
  on keep.user_id = s.user_id
 and keep.code_hash = s.code_hash
 and (keep.saved_at, keep.submission_id) < (s.saved_at, s.submission_id);

-- Delete them:
delete from public.solutions s
using public.solutions keep
where keep.user_id = s.user_id
  and keep.code_hash = s.code_hash
  and (keep.saved_at, keep.submission_id) < (s.saved_at, s.submission_id);

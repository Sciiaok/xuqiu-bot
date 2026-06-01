-- Split skill_active by environment so aws-test and aws-online can carry
-- different active commits despite sharing the same Supabase project.
--
-- Existing rows default to 'production' — preserves current behavior for
-- aws-online. aws-test (LEADENGINE_ENV=test) starts with no active row,
-- which the loader falls back to submodule baseline for.
--
-- Idempotent: safe to re-run after a partial failure.

-- 1. environment column (nullable first so backfill works, then NOT NULL).
alter table skill_active add column if not exists environment text;
update skill_active set environment = 'production' where environment is null;
alter table skill_active alter column environment set not null;
alter table skill_active alter column environment set default 'production';

-- 2. enum-style check constraint.
alter table skill_active drop constraint if exists skill_active_environment_chk;
alter table skill_active
  add constraint skill_active_environment_chk
  check (environment in ('test', 'production'));

-- 3. new composite primary key (skill_name, environment).
alter table skill_active drop constraint if exists skill_active_pkey;
alter table skill_active add primary key (skill_name, environment);

-- 4. rebuild the view — must drop because CREATE OR REPLACE VIEW can't
--    rearrange column order (we want environment as the second column).
drop view if exists current_skill;
create view current_skill as
  select sv.skill_name,
         sa.environment,
         sv.commit_sha,
         sv.commit_summary,
         sv.commit_at,
         sv.skill_md,
         sv.refs,
         sa.activated_at
  from skill_versions sv
  join skill_active sa using (skill_name, commit_sha);

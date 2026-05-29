-- skill_versions: cached SKILL.md + references content per (skill_name, commit_sha)
-- skill_active:   pointer to the active commit_sha per skill
-- current_skill:  view joining the two — what loader.js reads at runtime
--
-- All-keep policy: rows in skill_versions are never garbage-collected.

create table if not exists skill_versions (
  skill_name      text         not null,
  commit_sha      text         not null,
  commit_summary  text         not null,
  commit_at       timestamptz  not null,
  skill_md        text         not null,
  refs            jsonb        not null default '{}'::jsonb,  -- {"platforms/meta": "...", ...}
  imported_at     timestamptz  not null default now(),
  imported_by     uuid,
  primary key (skill_name, commit_sha)
);

create table if not exists skill_active (
  skill_name      text         primary key,
  commit_sha      text         not null,
  activated_at    timestamptz  not null default now(),
  activated_by    uuid,
  constraint skill_active_version_fk
    foreign key (skill_name, commit_sha)
    references skill_versions (skill_name, commit_sha)
);

create or replace view current_skill as
  select sv.skill_name,
         sv.commit_sha,
         sv.commit_summary,
         sv.commit_at,
         sv.skill_md,
         sv.refs,
         sa.activated_at
  from skill_versions sv
  join skill_active sa using (skill_name, commit_sha);

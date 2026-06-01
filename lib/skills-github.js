/**
 * GitHub helpers for the admin skill-version switcher.
 *
 * All calls authenticate with GITHUB_TOKEN (fine-grained PAT, read-only to
 * LeadEngine/skills). Used only from the admin API routes — agents read
 * from the DB cache populated by activate().
 */

const REPO = 'LeadEngine/skills';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

// Whitelist — guards path-traversal via skill_name in route params.
export const SKILL_NAMES = ['PromeEngine-ads-skill', 'ai-reception-deal'];

export const SKILL_DISPLAY = {
  'PromeEngine-ads-skill': 'Ogilvy · 出海广告策划 SOP',
  'ai-reception-deal': 'Medici · AI 接待谈单',
};

// Environments share one Supabase project, so version pointers must be
// scoped per env. Default is 'test' so a fresh server (forgot to set the
// var) never accidentally pulls production's active version.
export const ENVIRONMENTS = ['test', 'production'];

export function currentEnv() {
  const env = process.env.LEADENGINE_ENV || 'test';
  if (!ENVIRONMENTS.includes(env)) {
    throw new Error(
      `Invalid LEADENGINE_ENV="${env}". Must be one of: ${ENVIRONMENTS.join(', ')}`,
    );
  }
  return env;
}

function authHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not configured. Add a fine-grained PAT with read access to LeadEngine/skills to .env.local.');
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'leadengine-admin-skills',
  };
}

/**
 * List commits on a given ref (branch name or sha) that touched the skill.
 * Defaults to the repo's default branch when ref is omitted.
 */
export async function listSkillCommits(skillName, { perPage = 50, ref = null } = {}) {
  const params = new URLSearchParams({
    path: skillName + '/',
    per_page: String(perPage),
  });
  if (ref) params.set('sha', ref);
  const url = `${API}/repos/${REPO}/commits?${params}`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error(`GitHub commits API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.map((c) => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    summary: (c.commit.message || '').split('\n')[0].slice(0, 200),
    date: c.commit.author?.date || c.commit.committer?.date,
  }));
}

/**
 * List all branches in the repo, with the default branch first.
 */
export async function listBranches() {
  const [branchesRes, repoRes] = await Promise.all([
    fetch(`${API}/repos/${REPO}/branches?per_page=100`, { headers: authHeaders() }),
    fetch(`${API}/repos/${REPO}`, { headers: authHeaders() }),
  ]);
  if (!branchesRes.ok) throw new Error(`GitHub branches API ${branchesRes.status}: ${await branchesRes.text()}`);
  if (!repoRes.ok) throw new Error(`GitHub repo API ${repoRes.status}: ${await repoRes.text()}`);
  const branches = await branchesRes.json();
  const { default_branch: defaultBranch } = await repoRes.json();
  const names = branches.map((b) => b.name);
  // Hoist default branch to the top
  const ordered = [defaultBranch, ...names.filter((n) => n !== defaultBranch)];
  return { branches: ordered, defaultBranch };
}

export async function getCommitMeta(sha) {
  const r = await fetch(`${API}/repos/${REPO}/commits/${sha}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`GitHub commit ${sha.slice(0, 7)} ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return {
    sha,
    summary: (data.commit.message || '').split('\n')[0].slice(0, 200),
    date: data.commit.author?.date || data.commit.committer?.date,
  };
}

/**
 * Pulls SKILL.md + references/**.md for a given skill at a given commit.
 * Returns { skillMd, refs } where refs is { 'platforms/meta': '<content>', ... }.
 */
export async function fetchSkillBundleAtCommit(skillName, sha) {
  // 1. Tree (recursive) — list every file in the repo at this commit
  const treeUrl = `${API}/repos/${REPO}/git/trees/${sha}?recursive=1`;
  const r = await fetch(treeUrl, { headers: authHeaders() });
  if (!r.ok) throw new Error(`GitHub tree ${sha.slice(0, 7)} ${r.status}: ${await r.text()}`);
  const tree = (await r.json()).tree || [];

  const prefix = skillName + '/';
  const blobs = tree.filter(
    (item) => item.type === 'blob' && item.path.startsWith(prefix) && item.path.endsWith('.md'),
  );
  if (blobs.length === 0) {
    throw new Error(`Commit ${sha.slice(0, 7)} contains no ${skillName}/ markdown files`);
  }

  // 2. Fetch each file in parallel via raw (authenticated)
  const rawAuth = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` };
  const contents = await Promise.all(
    blobs.map(async (item) => {
      const rawUrl = `${RAW}/${REPO}/${sha}/${item.path}`;
      const rr = await fetch(rawUrl, { headers: rawAuth });
      if (!rr.ok) throw new Error(`Raw fetch ${item.path} ${rr.status}`);
      return { path: item.path, content: await rr.text() };
    }),
  );

  // 3. Split SKILL.md from references/
  let skillMd = null;
  const refs = {};
  for (const f of contents) {
    const relative = f.path.slice(prefix.length);
    if (relative === 'SKILL.md') {
      skillMd = f.content;
    } else if (relative.startsWith('references/') && relative.endsWith('.md')) {
      const key = relative.slice('references/'.length, -3);
      refs[key] = f.content;
    }
    // any other .md (README, etc.) — ignore
  }
  if (!skillMd) {
    throw new Error(`Commit ${sha.slice(0, 7)} has no ${skillName}/SKILL.md`);
  }
  return { skillMd, refs };
}

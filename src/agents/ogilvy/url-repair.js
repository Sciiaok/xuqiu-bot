/**
 * URL self-heal for Ogilvy assistant output.
 *
 * Why: under post-2026-05-25 citation discipline (SKILL §2.6.1), the Agent
 * inline-cites web_search source URLs as `[字面值](url)`. Observed in
 * regression testing (test sessions 88083d90 / 80ed7d79): Sonnet occasionally
 * mangles long multilingual URLs during transcription —
 *   `pero-diesel`   → `pero-discord`
 *   `estados-unidos`→ `estados-units`
 * — a token-prediction drift where the model's English-leaning prior
 * substitutes a phonetically/semantically adjacent English token mid-URL.
 *
 * Fix: before persisting an assistant message, scan its markdown links and
 * compare each URL against the known-good URLs the Agent has actually seen
 * this session (collected from web_search tool_result.citations[] and
 * results[]). If a URL doesn't exact-match but has a uniquely close fuzzy
 * match (Levenshtein-derived similarity ≥ 0.92, and ≥ 0.05 above the runner-up),
 * replace it. Otherwise leave it alone but append `#unverified` so the
 * frontend renderer can flag it visually (see OgilvyMarkdown CustomAnchor).
 *
 * The thresholds are intentionally strict to avoid silently rewriting a URL
 * to a wrong-but-similar sibling — a false repair is worse than a 404.
 */

/**
 * Standard Levenshtein distance. O(m*n) time, O(min(m,n)) space.
 * Inputs are short URLs (< 200 chars typically); cost is negligible.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Swap so b is the shorter — keeps the row-length minimized.
  if (m < n) return levenshtein(b, a);
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Normalized similarity in [0,1] — 1 means identical. */
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Walk OpenAI-format history (the same array consumed by the LLM) and
 * collect every URL the Agent has actually seen in web_search tool_results
 * for this session. These are the citation-grade URLs; anything the Agent
 * wrote that doesn't match one is suspect.
 *
 * Accepts either raw tool_result objects (citations / results arrays) or
 * already-stringified content (OpenAI format), so it works equally well
 * with the in-memory `history` from runOgilvy and the persisted DB rows.
 */
export function collectKnownUrls(history) {
  const urls = new Set();
  for (const m of history || []) {
    if (!m) continue;

    // OpenAI-format tool message: content is a JSON string.
    if (m.role === 'tool' && typeof m.content === 'string') {
      let parsed;
      try { parsed = JSON.parse(m.content); } catch { continue; }
      collectFromToolResult(parsed, urls);
      continue;
    }

    // Direct DB-row shape: tool_result is already an object.
    if (m.tool_result && typeof m.tool_result === 'object') {
      collectFromToolResult(m.tool_result, urls);
    }
  }
  return [...urls];
}

function collectFromToolResult(r, urls) {
  if (!r || typeof r !== 'object') return;
  if (Array.isArray(r.citations)) {
    for (const c of r.citations) if (c?.url) urls.add(c.url);
  }
  if (Array.isArray(r.results)) {
    for (const c of r.results) if (c?.url) urls.add(c.url);
  }
}

// Conservative repair thresholds. See file header.
const MIN_SIMILARITY = 0.92;
const MIN_GAP_TO_RUNNER_UP = 0.05;

/**
 * Scan markdown links in `text` and either:
 *   - leave them as-is (URL exact-matches a known-good URL),
 *   - silently rewrite to a uniquely close known URL (high-confidence repair),
 *   - or append `#unverified` to the URL fragment (low-confidence; frontend flags).
 *
 * Returns `{ text, repaired: [...], unverified: [...] }` for logging.
 *
 * The markdown anchor regex handles the typical `[label](https://…)` shape.
 * It does NOT touch bare URLs in prose (those are rare in Ogilvy output and
 * usually intentional) or reference-style links.
 */
export function repairAssistantUrls(text, knownUrls) {
  if (!text || typeof text !== 'string') {
    return { text, repaired: [], unverified: [] };
  }
  if (!Array.isArray(knownUrls) || knownUrls.length === 0) {
    // Nothing to match against — leave text untouched.
    return { text, repaired: [], unverified: [] };
  }

  const knownSet = new Set(knownUrls);
  const repaired = [];
  const unverified = [];

  // Match `[label](url)` where url is non-empty http(s). Greedy label up to
  // the first unescaped `]` — markdown's own rule. We deliberately don't
  // try to handle nested `]` in the label (rare; agent doesn't write that).
  const linkRe = /(\[[^\]]+\]\()(https?:\/\/[^\s)]+?)(\))/g;

  const out = text.replace(linkRe, (full, pre, url, post) => {
    // Strip any prior #unverified marker (defensive — shouldn't normally occur).
    const cleanUrl = url.replace(/#unverified$/, '');

    if (knownSet.has(cleanUrl)) return `${pre}${cleanUrl}${post}`;

    // Find best match.
    let best = null;
    let bestScore = 0;
    let runnerUp = 0;
    for (const k of knownUrls) {
      const s = similarity(cleanUrl, k);
      if (s > bestScore) {
        runnerUp = bestScore;
        bestScore = s;
        best = k;
      } else if (s > runnerUp) {
        runnerUp = s;
      }
    }

    if (bestScore >= MIN_SIMILARITY && bestScore - runnerUp >= MIN_GAP_TO_RUNNER_UP && best) {
      repaired.push({ from: cleanUrl, to: best, score: bestScore });
      return `${pre}${best}${post}`;
    }

    // Can't safely repair — flag for the renderer.
    unverified.push({ url: cleanUrl, bestScore });
    return `${pre}${cleanUrl}#unverified${post}`;
  });

  return { text: out, repaired, unverified };
}

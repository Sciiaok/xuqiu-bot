'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import s from '../ogilvy.module.css';

/**
 * OgilvyMarkdown — Ogilvy-flavored Markdown renderer.
 *
 * Wraps ReactMarkdown with a custom <p> renderer that detects three patterns
 * the global Markdown CSS can't reach via selectors alone:
 *
 *   1. **Status callout** — paragraphs starting with a status emoji
 *      (✅ / ❌ / ⚠️ / 💡 / 🎯 / 🔥 / 📌). AI uses these to surface
 *      "done" / "warning" / "next step" moments. Gets a colored callout
 *      box per emoji family so the user can't miss them.
 *
 *   2. **Micro-heading** — a paragraph whose ONLY child is a <strong>
 *      ending with `:` or `：`. AI consistently writes `**本次方案快速回顾:**`
 *      where structurally it's a section header, but markdown-wise it's a
 *      bold paragraph. We treat it like an h4 visually.
 *
 *   3. **Emoji-lead bullet** — paragraph starting with a generic emoji
 *      (not a status emoji). AI uses these as faux bullet lists
 *      (📱 ... / 🤵 ... / 🤖 ...). Gets a hanging indent so the emoji
 *      column-aligns and the text wraps cleanly underneath.
 *
 * All styles scoped to .aiMsg via ogilvy.module.css — so this wrapper is
 * safe to drop in anywhere inside Ogilvy without affecting global Markdown.
 *
 * Trade-off: pattern detection runs on every <p>. Cost is negligible
 * (it's just AST inspection), and the alternative — getting LLMs to emit
 * "correct" markdown ## headings — is more flaky than fixing the renderer.
 */

const STATUS_EMOJI_MAP = {
  // Success family — green callout
  '✅': 'success',
  '🎉': 'success',
  '✓':  'success',
  // Warning family — amber callout
  '⚠️': 'warn',
  '⚠':  'warn',
  '⛔': 'warn',
  // Danger family — red callout
  '❌': 'danger',
  '🚫': 'danger',
  // Tip/idea family — accent blue callout
  '💡': 'tip',
  '🎯': 'tip',
  '📌': 'tip',
  // Hot/important — accent blue callout (same as tip)
  '🔥': 'tip',
};

// Pull plaintext out of a mdast paragraph node (handles nested strong / em /
// links by recursing). Only used for pattern detection — not rendered.
function nodeText(node) {
  if (!node) return '';
  if (node.value) return node.value;
  if (!Array.isArray(node.children)) return '';
  return node.children.map(nodeText).join('');
}

// Detect if a string starts with one of the status emojis we know.
// Matches at the start of the trimmed string so "✅ 方案..." and "✅方案..." both fire.
function classifyStatus(text) {
  const head = (text || '').trimStart().slice(0, 4);
  for (const emoji of Object.keys(STATUS_EMOJI_MAP)) {
    if (head.startsWith(emoji)) return STATUS_EMOJI_MAP[emoji];
  }
  return null;
}

// Detect generic emoji at paragraph start (not a status emoji).
// Uses Unicode property escapes for "Extended Pictographic" — broad emoji
// coverage, no exhaustive list maintenance. Browsers since 2019 support it.
const GENERIC_EMOJI_RE = /^\s*(\p{Extended_Pictographic}|[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}])/u;

function CustomParagraph({ node, children }) {
  const text = nodeText(node);

  // 1. Status callout — green / amber / red / accent.
  const statusTone = classifyStatus(text);
  if (statusTone) {
    return (
      <p className={`${s.aiCallout} ${s[`aiCallout_${statusTone}`]}`}>
        {children}
      </p>
    );
  }

  // 2. Micro-heading — loosened from R2's "only-strong + colon" to also
  //    accept "starts with strong + short total length + ends with colon/
  //    question/exclamation". Covers cases like `**本次方案快速回顾:**` where
  //    AI uses bold-prefix-sentence as section breaks but doesn't always
  //    nest the whole sentence in strong. Length cap (40 chars) prevents
  //    promoting full sentences with inline strong words to headings.
  //
  //    react-markdown 10 passes HAST nodes (not MDAST) — HAST elements all
  //    have type='element' and identify their tag via `tagName`. Earlier
  //    versions of this check used `type === 'strong'` (MDAST style) and
  //    silently never fired.
  const startsWithStrong =
    Array.isArray(node?.children) &&
    node.children.length > 0 &&
    node.children[0].tagName === 'strong';
  if (startsWithStrong && text.length <= 40 && /[:：?？!！]\s*$/.test(text)) {
    return <p className={s.aiMicroHeading}>{children}</p>;
  }

  // 3. Emoji-lead paragraph — hanging indent.
  if (GENERIC_EMOJI_RE.test(text)) {
    return <p className={s.aiEmojiLead}>{children}</p>;
  }

  return <p>{children}</p>;
}

/**
 * <li> renderer — same emoji-lead detection but for list items. AI often
 * emits `- 📱 ...` which becomes <li>📱 ...</li>; our <p> renderer never sees
 * those. We give the li itself a hanging-indent + tinted bg so emoji
 * column-aligns just like a paragraph-lead.
 */
function CustomListItem({ node, children, ...rest }) {
  const text = nodeText(node);
  if (GENERIC_EMOJI_RE.test(text) && !classifyStatus(text)) {
    // The `checked` prop comes from GFM task-list items (`- [ ]` / `- [x]`).
    // ReactMarkdown passes it through; preserve via spread.
    return <li className={s.aiEmojiLi} {...rest}>{children}</li>;
  }
  return <li {...rest}>{children}</li>;
}

/**
 * <a> renderer — open external links in a new tab + harden rel.
 *
 * Why: under the post-2026-05-25 citation discipline, the Agent inline-cites
 * web_search source URLs as `[字面值](url)`. Without target="_blank" the user
 * has to context-switch away from their Ogilvy session to verify a number; the
 * default `rel` also leaks referrer + lets the opened page navigate back via
 * `window.opener`. Add target + rel + a subtle ↗ glyph so users can spot
 * cited values visually at a glance.
 *
 * `#unverified` fragment: the server-side url-repair pass (see
 * `src/agents/ogilvy/url-repair.js`) appends this marker to any URL the agent
 * wrote but didn't match a known citation (and couldn't safely repair). We
 * strip it for the actual navigation but render the link with a warning
 * class + tooltip so the user knows the URL is suspect — likely a transcription
 * typo, possibly a 404.
 */
function CustomAnchor({ node, href, children, ...rest }) {
  const isExternal = typeof href === 'string' && /^https?:\/\//i.test(href);
  if (!isExternal) {
    return <a href={href} {...rest}>{children}</a>;
  }
  const unverified = href.endsWith('#unverified');
  const cleanHref = unverified ? href.slice(0, -'#unverified'.length) : href;
  const className = unverified
    ? `${s.aiCitationLink} ${s.aiCitationLinkUnverified}`
    : s.aiCitationLink;
  const title = unverified
    ? `⚠️ 此 URL 未在本次会话的 citations 里找到 — 可能是 agent 转写时手误,点击前请核对:\n${cleanHref}`
    : cleanHref;
  return (
    <a
      href={cleanHref}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={className}
      title={title}
      data-verified={unverified ? 'false' : 'true'}
      {...rest}
    >
      {children}
    </a>
  );
}

export default function OgilvyMarkdown({ children }) {
  if (!children) return null;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: CustomParagraph,
        li: CustomListItem,
        a: CustomAnchor,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

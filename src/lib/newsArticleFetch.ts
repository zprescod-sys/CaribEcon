/* newsArticleFetch.ts — deterministic article-body retrieval for the News-digest side path
 * (docs plan §2h). Plain code, no model involved: `fetchArticleText(url)` does a real `fetch()`
 * of a News Hub item's own `link` and reduces the HTML to readable text.
 *
 * IMPORTANT — this is NOT the same rule as news.ts's "never fetch/return article text". Read
 * that carefully, because the two rules look contradictory and are not:
 *
 *   - news.ts governs `N:` refs — the News Hub's OWN STORED metadata (headline / source / date /
 *     link). That module deliberately never fetches or hands out a body, because the hub's
 *     guarantee is "metadata only" and nothing downstream should be able to imply an article was
 *     read when it wasn't.
 *   - THIS file governs a different evidence class entirely: `W:` web evidence
 *     (`WebEvidence.extract` in contracts.ts). When the executor wants richer context on a news
 *     item it already has metadata for, it fetches that item's own `link` directly — for real —
 *     and the resulting text becomes genuinely-retrieved evidence, checkable by `quote_check` and
 *     `web_figure_reconciliation` (grounding.ts) against the actual bytes a real HTTP request
 *     returned. news.ts's guarantee (the News Hub's stored records stay metadata-only) is
 *     completely untouched by this file existing; the two modules simply answer different
 *     questions ("what does the hub say about this story" vs. "what does the story's own page
 *     say").
 *
 * Explicitly NOT Tavily and NOT a model that browses on its own — two options considered and
 * rejected during scoping (see the plan, §2h):
 *   - A model with native browsing would conflict with CLAUDE.md's standing rule ("the research
 *     pipeline plans once and executes in code, never a model tool-loop"), and its self-reported
 *     reading of a page can't be verified against the real page — which breaks the root-of-trust
 *     property `quote_check`/`web_figure_reconciliation` depend on: `extract.text` is checkable
 *     *because* code, not a model, put it there.
 *   - Tavily Extract (webEvidence.ts's `extractWeb`) was the original proposal but is reserved
 *     for plan-authorized `search_web`/`extract_web` steps only. News Hub articles are a distinct,
 *     code-controlled fetch outside that budget and outside Tavily entirely — this path never
 *     calls Tavily.
 *
 * Fails soft, never throws for a normal external-fetch failure — same precedent as verify.ts's
 * header comment (an optional enrichment step degrades the request, it never takes it down).
 * A non-2xx response, a non-HTML content-type, a timeout, a network error, or near-empty content
 * after stripping all return `null`; the caller (the executor's news-digest path) records a miss
 * and simply skips the digest for that article.
 *
 * The HTML-to-text pass below is a genuinely lightweight, DEPENDENCY-FREE parser — a handful of
 * regexes, not a DOM. This project's coding philosophy is "minimize dependencies," so no
 * readability/cheerio/jsdom package was added for this. Honesty about the tradeoff: this is not
 * as good as a dedicated readability library or Tavily's own extraction — some nav/boilerplate
 * text can slip through on sites with unusual markup. That's accepted here because what the
 * grounding gate needs is real, code-fetched, verifiable text; extraction polish is secondary.
 */

import { MAX_EXTRACT_CHARS } from './ai/config.js';

const FETCH_TIMEOUT_MS = 10_000;

// A realistic desktop-browser UA — many news sites block requests with no UA or an obvious
// bot/script default (e.g. Node's own "node-fetch" or bare "undici").
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

// Below this many characters after stripping, treat the result the same as a fetch failure — a
// paywalled or JS-rendered page routinely yields near-nothing (a cookie banner, a single "please
// enable JavaScript" line), and that is not useful evidence.
const MIN_USEFUL_CHARS = 100;

export interface FetchedArticle {
  text: string;
  chars: number;
}

/* Removes every <tagName>...</tagName> block (open tag, content, close tag), case-insensitively.
   Used for elements whose CONTENT must go, not just the tags (script/style bodies are code/CSS,
   nav/header/footer/aside bodies are boilerplate) — unlike the later "strip all remaining tags"
   pass, which keeps the text between tags. */
function stripElementsWithContent(html: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'gi');
  return html.replace(pattern, ' ');
}

/* Returns the content between the first <tagName ...> and its matching closing tag, or null if
   the tag isn't present. Simple, non-nesting-aware scan — adequate for the one-level "find the
   main content container" job this is used for (see the file header on why a full parser is out
   of scope). */
function extractFirstElement(html: string, tagName: string): string | null {
  const openMatch = new RegExp(`<${tagName}[^>]*>`, 'i').exec(html);
  if (!openMatch) return null;
  const closeTag = `</${tagName}>`;
  const closeIndex = html.toLowerCase().indexOf(closeTag, openMatch.index + openMatch[0].length);
  const contentStart = openMatch.index + openMatch[0].length;
  const contentEnd = closeIndex === -1 ? html.length : closeIndex;
  return html.slice(contentStart, contentEnd);
}

// Common named entities plus generic numeric (&#NNN;) and hex (&#xHHH;) entities.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/* Reduces a full HTML document to plain, readable text: prefer the <article> or <main> content
   container if present (common on news sites and usually the actual story, minus chrome), strip
   non-content elements, strip remaining tags, decode entities, and collapse whitespace. */
function htmlToText(html: string): string {
  const container =
    extractFirstElement(html, 'article') ?? extractFirstElement(html, 'main') ?? extractFirstElement(html, 'body') ?? html;

  let cleaned = container;
  for (const tag of ['script', 'style', 'nav', 'header', 'footer', 'aside']) {
    cleaned = stripElementsWithContent(cleaned, tag);
  }

  // Strip every remaining tag, keeping the text between them.
  const withoutTags = cleaned.replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(withoutTags);

  // Collapse runs of whitespace (including newlines) to single spaces, then trim.
  return decoded.replace(/\s+/g, ' ').trim();
}

/* Fetches a News Hub item's own `link` and reduces it to readable text. Never throws for a
   normal external-fetch failure — see the file header's fail-soft note. Returns null when the
   fetch fails, the response isn't HTML, or the extracted text is too short to be useful. */
export async function fetchArticleText(url: string): Promise<FetchedArticle | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // Network error, DNS failure, or timeout — fail soft.
    return null;
  }

  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) return null;

  let html: string;
  try {
    html = await response.text();
  } catch {
    return null;
  }

  const text = htmlToText(html).slice(0, MAX_EXTRACT_CHARS);
  if (text.length < MIN_USEFUL_CHARS) return null;

  return { text, chars: text.length };
}

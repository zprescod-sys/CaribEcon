/* Mechanical, validated file I/O for the news review inbox — the deterministic half of the
 * triage-review-inbox subagent (.claude/agents/triage-review-inbox.md). The agent's job is
 * judgment (reading headlines, deciding publish/drop/escalate); this script's job is making
 * sure that judgment can never corrupt data/news_unclassified.json or silently break the
 * live site build, since the agent runs unattended — no human confirms each write.
 *
 * Two modes:
 *   --list                     print pending rows (never triaged, not already approved) as
 *                               JSON to stdout, for the agent to read and reason over.
 *   --apply <patch-file.json>  apply a JSON array of triage decisions, validate the WHOLE
 *                               resulting file, and only write if every check passes
 *                               (all-or-nothing — a bad patch writes nothing).
 *
 * Reuses validateNewsReviewInbox from build-feeds.mjs — the exact rule dataHub.ts's own
 * "approved row needs a valid category" build-time guard already depends on — so this
 * script can never drift from what a live build already requires. That import is safe only
 * because build-feeds.mjs guards its own top-level fetch/classify pipeline behind an
 * entry-point check (`isMain`); do not remove that guard.
 */
import fs from 'node:fs';
import { NEWS_CATEGORY_GROUPS } from '../src/lib/newsRelevance.mjs';
import { validateNewsReviewInbox } from './build-feeds.mjs';

const INBOX_PATH = './data/news_unclassified.json';
const VALID_CATEGORIES = new Set(Object.keys(NEWS_CATEGORY_GROUPS));

// Fields this script is ever allowed to write. Guards against a patch that — by agent
// mistake, not malice — tries to touch a machine-owned field like `decision`/`reason`.
const TRIAGE_FIELDS = new Set(['approved', 'category', 'triaged', 'escalated', 'reviewNote']);

function fail(msg) {
  console.error(`triage-inbox: ${msg}`);
  process.exit(1);
}

function readInbox() {
  if (!fs.existsSync(INBOX_PATH)) fail(`${INBOX_PATH} does not exist.`);
  let rows;
  try { rows = JSON.parse(fs.readFileSync(INBOX_PATH, 'utf8')); }
  catch (e) { fail(`${INBOX_PATH} is not valid JSON — fix it before running triage.\n${e.message}`); }
  if (!Array.isArray(rows)) fail(`${INBOX_PATH} must contain a JSON array.`);
  return rows;
}

// Atomic write: write to a sibling temp file, then rename over the target. A crash or kill
// mid-write leaves the ORIGINAL file untouched, instead of a half-written JSON that would
// fail the very next `npm run feeds` / `astro build`.
function writeInboxAtomic(rows) {
  const tmpPath = `${INBOX_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(rows, null, 2) + '\n');
  fs.renameSync(tmpPath, INBOX_PATH);
}

// A row is "pending" if no explicit triage decision has been recorded AND it isn't already
// approved. The `approved !== true` half matters: several existing rows were approved by a
// human before the `triaged` field existed, and a human can still approve a row by hand at
// any time (the pre-existing editorial workflow in CLAUDE.md). Without this, every
// legacy/hand-approved row would reappear as "pending" forever.
function isPending(row) {
  return row.triaged !== true && row.approved !== true;
}

function cmdList() {
  const rows = readInbox();
  const pending = rows.filter(isPending);
  const alreadyEscalated = pending.filter(r => r.escalated === true).length;
  console.error(
    `${rows.length} total row(s) in ${INBOX_PATH}, ${pending.length} pending ` +
    `(${alreadyEscalated} already escalated from a prior run — read each row's reviewNote ` +
    `before re-deciding it).`,
  );
  console.log(JSON.stringify(pending, null, 2));
}

function loadPatch(patchPath) {
  if (!fs.existsSync(patchPath)) fail(`patch file not found: ${patchPath}`);
  let patch;
  try { patch = JSON.parse(fs.readFileSync(patchPath, 'utf8')); }
  catch (e) { fail(`${patchPath} is not valid JSON.\n${e.message}`); }
  if (!Array.isArray(patch)) fail(`${patchPath} must contain a JSON array of patch objects.`);
  if (patch.length === 0) fail(`${patchPath} is empty — nothing to apply.`);

  const seenIds = new Set();
  for (const [i, entry] of patch.entries()) {
    const tag = `patch[${i}]`;
    if (!entry?.id || typeof entry.id !== 'string') fail(`${tag} is missing a string "id".`);
    if (seenIds.has(entry.id)) fail(`${tag} ("${entry.id}") is a duplicate id within the same patch.`);
    seenIds.add(entry.id);
    if (typeof entry.approved !== 'boolean') fail(`${tag} ("${entry.id}") "approved" must be true/false.`);
    if (typeof entry.triaged !== 'boolean') fail(`${tag} ("${entry.id}") "triaged" must be true/false.`);
    for (const key of Object.keys(entry)) {
      if (key !== 'id' && !TRIAGE_FIELDS.has(key)) {
        fail(`${tag} ("${entry.id}") sets "${key}", which is not a triage-owned field. ` +
             `Only ${[...TRIAGE_FIELDS].join(', ')} may be set here.`);
      }
    }
    if (entry.category !== undefined && typeof entry.category !== 'string') {
      fail(`${tag} ("${entry.id}") "category" must be a string.`);
    }
    if (entry.reviewNote !== undefined && typeof entry.reviewNote !== 'string') {
      fail(`${tag} ("${entry.id}") "reviewNote" must be a string.`);
    }
    if (entry.escalated !== undefined && typeof entry.escalated !== 'boolean') {
      fail(`${tag} ("${entry.id}") "escalated" must be true/false.`);
    }
    // Early, per-entry check for a better error message pinned to the specific patch entry
    // (validateNewsReviewInbox's own error below references the row's position in the whole
    // file, not its id). The shared validator remains the authoritative gate before any write.
    if (entry.approved === true && !VALID_CATEGORIES.has(entry.category)) {
      fail(`${tag} ("${entry.id}") approves but "category" ("${entry.category}") is not one ` +
           `of NEWS_CATEGORY_GROUPS: ${[...VALID_CATEGORIES].join(', ')}.`);
    }
    // Contradictory terminal states — nothing else in the schema forbids these, so this
    // script is the only place that can catch an agent bug before it's written to disk.
    if (entry.escalated === true && entry.triaged === true) {
      fail(`${tag} ("${entry.id}") sets escalated:true and triaged:true — contradictory. ` +
           `An escalated row must stay triaged:false so it keeps surfacing to a human.`);
    }
    if (entry.escalated === true && entry.approved === true) {
      fail(`${tag} ("${entry.id}") sets escalated:true and approved:true — contradictory. ` +
           `A row awaiting human review can't already be approved/published.`);
    }
  }
  return patch;
}

function cmdApply(patchPath) {
  const patch = loadPatch(patchPath);
  const rows = readInbox();
  const byId = new Map(rows.map(row => [row.id, row]));

  let approved = 0, rejected = 0, escalated = 0;
  for (const entry of patch) {
    const row = byId.get(entry.id);
    if (!row) {
      fail(`patch references id "${entry.id}", which is not in ${INBOX_PATH}. The queue may ` +
           `have changed since --list ran (a cron refresh, or another triage run) — re-run ` +
           `--list and regenerate the patch. Nothing was written.`);
    }
    // Overwrite only the triage-owned fields the patch actually specifies; every other field
    // on the row (title/source/date/decision/reason/classifier/...) is left untouched.
    const patched = { ...row };
    for (const key of TRIAGE_FIELDS) {
      if (key in entry) patched[key] = entry[key];
    }
    byId.set(entry.id, patched);
    if (entry.escalated === true) escalated++;
    else if (entry.approved === true) approved++;
    else rejected++;
  }

  const result = rows.map(row => byId.get(row.id)); // preserve original file order
  try {
    validateNewsReviewInbox(result); // the exact rule dataHub.ts's build-time guard depends on
  } catch (e) {
    fail(`resulting file would fail validation — nothing was written.\n${e.message}`);
  }

  writeInboxAtomic(result);
  console.log(`Applied ${patch.length} decision(s): ${approved} approved, ${rejected} rejected, ${escalated} escalated.`);
  console.log(`${INBOX_PATH} written.`);
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  cmdList();
} else if (args.includes('--apply')) {
  const patchPath = args[args.indexOf('--apply') + 1];
  if (!patchPath) fail('--apply requires a path to a patch JSON file.');
  cmdApply(patchPath);
} else {
  console.error('Usage:\n  node scripts/triage-inbox.mjs --list\n  node scripts/triage-inbox.mjs --apply <patch-file.json>');
  process.exit(1);
}

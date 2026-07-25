/* Mechanical, validated file I/O for the deals review queue — the deterministic half of the
 * triage-review-deals subagent, "warrenb" (.claude/agents/triage-review-deals.md). The agent's
 * job is judgment (reading headlines, fetching sources, drafting parties/value/type, deciding
 * publish/reject/escalate); this script's job is making sure that judgment can never corrupt
 * data/deals_inbox.json or push a malformed deal toward the live Deals & Investment page, since
 * the agent runs unattended — no human confirms each write.
 *
 * Two modes (identical shape to scripts/triage-inbox.mjs, the news sibling):
 *   --list                     print pending rows (never triaged, not already approved) as JSON
 *                               to stdout, for the agent to read and reason over.
 *   --apply <patch-file.json>  apply a JSON array of triage decisions, validate the WHOLE
 *                               resulting file, and only write if every check passes
 *                               (all-or-nothing — a bad patch writes nothing).
 *
 * Reuses DEAL_TYPES + validateDealForPublish from build-feeds.mjs — the exact rules
 * buildDeals()'s promotion guard enforces — so this script can never drift from what promotion
 * to deals.json already requires. That import is safe only because build-feeds.mjs guards its own
 * top-level fetch/classify pipeline behind an entry-point check (`isMain`); do not remove it.
 */
import fs from 'node:fs';
import { DEAL_TYPES, validateDealForPublish } from './build-feeds.mjs';

const INBOX_PATH = './data/deals_inbox.json';

// Fields this script is ever allowed to write. Everything else on a row (id/headline/date/
// country/suggestedType/url/source) is machine-owned and must never be touched by triage.
const TRIAGE_FIELDS = new Set(['parties', 'value', 'type', 'approved', 'triaged', 'escalated', 'reviewNote']);

function fail(msg) {
  console.error(`triage-deals: ${msg}`);
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
// fail the very next `npm run feeds` / `npm run promote`.
function writeInboxAtomic(rows) {
  const tmpPath = `${INBOX_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(rows, null, 2) + '\n');
  fs.renameSync(tmpPath, INBOX_PATH);
}

// A row is "pending" if no explicit triage decision has been recorded AND it isn't already
// approved. The `approved !== true` half matters: a row can be approved by hand (the pre-existing
// editorial workflow) or by a prior warrenb run; without this, every such row would reappear as
// "pending" forever.
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
    for (const strField of ['parties', 'value', 'type', 'reviewNote']) {
      if (entry[strField] !== undefined && typeof entry[strField] !== 'string') {
        fail(`${tag} ("${entry.id}") "${strField}" must be a string.`);
      }
    }
    if (entry.escalated !== undefined && typeof entry.escalated !== 'boolean') {
      fail(`${tag} ("${entry.id}") "escalated" must be true/false.`);
    }
    // A publish decision must carry a valid DealType. parties/value fullness is enforced by
    // validateDealForPublish against the MERGED row below (a patch may set type here while
    // parties/value were drafted onto the row in an earlier pass), so it's not re-checked here.
    if (entry.approved === true && entry.type !== undefined && !DEAL_TYPES.has(entry.type)) {
      fail(`${tag} ("${entry.id}") approves with type "${entry.type}", not one of DealType: ${[...DEAL_TYPES].join(', ')}.`);
    }
    // Contradictory terminal states — nothing else in the schema forbids these, so this script
    // is the only place that can catch an agent bug before it's written to disk.
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
    // Overwrite only the triage-owned fields the patch actually specifies; every other field on
    // the row (headline/source/date/country/suggestedType/url/...) is left untouched.
    const patched = { ...row };
    for (const key of TRIAGE_FIELDS) {
      if (key in entry) patched[key] = entry[key];
    }
    // A row being published must satisfy the exact promotion guard buildDeals() will apply — the
    // authoritative check, run against the MERGED row so a valid type/parties/value drafted in an
    // earlier pass still counts. Fail here (pinned to the id) rather than letting the deal reach
    // deals.json half-formed.
    if (patched.approved === true) {
      try { validateDealForPublish(patched); }
      catch (e) { fail(`entry "${entry.id}" approves but the resulting deal is invalid — nothing was written.\n${e.message}`); }
    }
    byId.set(entry.id, patched);
    if (entry.escalated === true) escalated++;
    else if (entry.approved === true) approved++;
    else rejected++;
  }

  const result = rows.map(row => byId.get(row.id)); // preserve original file order
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
  console.error('Usage:\n  node scripts/triage-deals.mjs --list\n  node scripts/triage-deals.mjs --apply <patch-file.json>');
  process.exit(1);
}

# Feeds pipeline — News & Publications ingestion

How `data/news.json` and `data/publications.json` stay fresh without hand-editing JSON.

```
RSS feeds ──(RSS by Zapier, 1 Zap per feed)──▶ Google Sheet (append buffer)
                                                      │
   GitHub Action (daily cron) ──▶ npm run feeds  (scripts/build-feeds.mjs)
        reads Sheet as public CSV ▶ normalize ▶ validate ▶ write data/*.json
                                                      │
                          git commit if changed ──▶ host auto-deploys
```

Design rules this honors: the front end never calls APIs (it reads committed JSON); **no
API keys** (the sheet is read as public CSV); article **bodies are never stored** (headline +
source + date + link only); **Publications are gated on your manual approval**.

---

## A. Google Sheet (you own this)

One spreadsheet, two tabs. Share it **"Anyone with the link → Viewer"** (the generator reads
the public CSV export — a private sheet returns an error and nothing is overwritten).

**Tab `news_inbox`** — columns (header row, exact lower-case names):

| title | source | date | country | url | tags |
|-------|--------|------|---------|-----|------|

- `country`: one of the 16 codes (`TT GY BB JM BS KY BZ SR GD LC AG KN DM VC TC VG`) or **`ALL`**
  for pan-Caribbean feeds. Multiple codes allowed, comma-separated. Empty → `ALL`.
- `tags`: optional, comma-separated.
- Extra columns (e.g. `notes`) are ignored — the generator reads by header name.

**Tab `pub_inbox`** — columns:

| title | org | date | country | url | feed_summary | type | summary | approved |
|-------|-----|------|---------|-----|--------------|------|---------|----------|

- Zapier fills `title, org, date, country, url, feed_summary`.
- **You** hand-fill `type` and `summary` and set `approved = TRUE`. Only `approved = TRUE` rows publish.
- `type` must be one of: `Article IV`, `World Economic Outlook`, `Staff Report`, `Country Report`,
  `Working Paper`, `Development Report`, `Regional Economic Outlook`, `Other`.
- `summary` is your own 1–2 sentence editorial summary (not the feed blurb — `feed_summary` is ignored).
- `country`: country code(s) or **`REGION`** for regional reports.

### Buffer hygiene (optional, recommended)
Add a Google Apps Script time-driven trigger on `news_inbox` that deletes rows whose `date` is
older than ~120 days (wider than the generator's 90-day read window, so nothing in-window is lost).
Keeps the sheet small. Do **not** prune `pub_inbox` — it's the curated archive.

---

## B. Zapier (you own this)

**One Zap per feed.** Trigger: *RSS by Zapier → New Item in Feed* (built-in per-feed dedup).
Action: *Google Sheets → Create Spreadsheet Row*.

- Map `title`/`url`/`date` from the feed item. Set `source` (news) or `org` (pubs) and `country`
  as **static values per Zap** (one feed ≈ one outlet/country). Use `ALL`/`REGION` for regional feeds.
- Do **not** set `id` — the generator derives a stable id from the URL.
- Institutional feeds (IMF / World Bank) → point the Zap at the **`pub_inbox`** tab.

---

## C. Repo wiring (already built)

- `scripts/build-feeds.mjs` — generator. Reads the sheet (or local fixtures), validates, writes
  `data/news.json` + `data/publications.json` in the existing schema. `npm run feeds`.
- `.github/workflows/feeds.yml` — daily cron (`0 11 * * *`) + manual `workflow_dispatch`. Commits
  only if the JSON changed; the host redeploys on push.
- Fixtures: `scripts/fixtures/{news_inbox,pub_inbox}.sample.csv` for offline testing.

### Going live
1. Set the repo **Variable** `SHEET_ID` (Settings → Secrets and variables → Actions → *Variables*).
   It's a Variable not a Secret — the sheet is public anyway.
2. Local smoke test:  `SHEET_ID=<id> npm run feeds`
3. Run the Action once via **workflow_dispatch** to confirm it commits + the site redeploys.

### Tunables (env / workflow)
- `NEWS_WINDOW_DAYS` (default 90) — drop news older than this.
- `NEWS_MAX` (default 60) — cap to N most-recent after windowing.
- Publications are **not** windowed (curated archive).

### Note on migration
The generator makes the **sheet the source of truth** for these two files — running it replaces
the current hand-curated records. Seed the sheet with any evergreen items you want to keep before
switching the live `SHEET_ID` on.

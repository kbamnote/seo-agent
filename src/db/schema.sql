-- SEO off-page agent — SQLite schema.
-- Applied idempotently by `npm run db:init`. Uses node:sqlite (Node 24 built-in),
-- so there is no native module to compile on Windows.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Clients ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id              TEXT PRIMARY KEY,          -- 'eeetechnologies'
  name            TEXT NOT NULL,
  site_url        TEXT NOT NULL,
  niche           TEXT,
  city            TEXT,
  country         TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  source_sheet_id TEXT,                      -- team's manual tracker, read-only
  agent_sheet_id  TEXT,                      -- sheet the agent owns and writes
  config_json     TEXT NOT NULL,             -- full config/clients/<id>.json
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Keywords and their link targets ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  keyword     TEXT NOT NULL,
  target_url  TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 3,
  anchors_json TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, keyword)
);

-- ── Site catalog ─────────────────────────────────────────────────────────────
-- One row per submission platform. Populated by Phase 1 discovery, and also
-- back-filled from whatever the team already used in the source sheet.
CREATE TABLE IF NOT EXISTS sites (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  domain            TEXT NOT NULL UNIQUE,    -- 'padlet.com' (registrable host)
  name              TEXT,
  home_url          TEXT,
  submit_url        TEXT,
  categories        TEXT,                    -- JSON array: ["bookmarking","profile"]
  authority         INTEGER,                 -- 0-100 estimate, nullable
  score             INTEGER,                 -- 0-100 agent vetting score
  dofollow          INTEGER,                 -- 1 / 0 / NULL = unknown
  requires_account  INTEGER NOT NULL DEFAULT 1,
  requires_captcha  INTEGER,                 -- NULL = not yet observed
  manual_only       INTEGER NOT NULL DEFAULT 0,  -- ToS forbids automation
  blocklisted       INTEGER NOT NULL DEFAULT 0,  -- permanent: vetting may never revive it
  adapter           TEXT,                    -- 'substack' | NULL = generic form filler
  status            TEXT NOT NULL DEFAULT 'candidate',
      -- candidate  not yet vetted
      -- vetted     usable
      -- marginal   the homepage showed no evidence either way; retry or decide by hand
      -- blocked    bot protection or robots.txt turned our crawler away — says
      --            nothing about posting there as a signed-in user
      -- rejected   permanent: parked, link farm, noindex, dead
      -- active     in use for submissions
      -- dead       was working, now gone
  reject_reason     TEXT,
  notes             TEXT,
  discovered_via    TEXT,                    -- footprint or 'source-sheet-import'
  discovered_at     TEXT NOT NULL DEFAULT (datetime('now')),
  vetted_at         TEXT,
  http_status       INTEGER,                 -- status of the last vetting fetch
  final_url         TEXT,                    -- after redirects
  robots_allowed    INTEGER,                 -- 1 / 0 / NULL = unknown
  signals_json      TEXT,                    -- everything the vetter observed
  nofollow_ratio    REAL,                    -- of sampled external links
  external_links    INTEGER,                 -- external links on the sampled page
  captcha_vendor    TEXT,                    -- recaptcha | hcaptcha | turnstile | ...
  language          TEXT,
  last_success_at   TEXT,
  last_failure_at   TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);

-- ── Accounts (passwords encrypted; see src/util/vault.ts) ────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email         TEXT,
  username      TEXT,
  secret_enc    TEXT,                        -- AES-256-GCM, never plaintext
  session_path  TEXT,                        -- Playwright persistent profile dir
  status        TEXT NOT NULL DEFAULT 'unverified',
      -- unverified | active | needs_assist | locked | dead
  verified_at   TEXT,
  last_login_at TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, site_id, username)
);

-- ── Generated content ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  keyword_id  INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,                 -- blog | bookmarking | profile | pdf | ppt | image | mindmap | directory
  title       TEXT,
  body        TEXT,
  asset_path  TEXT,                          -- data/artifacts/<client>/...
  anchor_text TEXT,
  anchor_kind TEXT,                          -- exact | partial | branded | naked
  target_url  TEXT,
  meta_json   TEXT,
  approval    TEXT NOT NULL DEFAULT 'not_required',
      -- not_required | pending | approved | rejected
  used_count  INTEGER NOT NULL DEFAULT 0,
  model       TEXT,
  generator   TEXT,                          -- 'llm' | 'template'
  word_count  INTEGER,
  variation   INTEGER NOT NULL DEFAULT 1,    -- nth asset for this keyword+type
  site_id     INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_approval ON content_items(approval);

-- ── Submissions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_id       INTEGER REFERENCES sites(id) ON DELETE SET NULL,
  keyword_id    INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
  content_id    INTEGER REFERENCES content_items(id) ON DELETE SET NULL,
  account_id    INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  type          TEXT NOT NULL,
  platform_url  TEXT,                        -- sheet column: URL
  submitted_url TEXT,                        -- sheet column: Backlinks
  keyword_text  TEXT,                        -- denormalised for imported rows
  status        TEXT NOT NULL DEFAULT 'queued',
      -- queued | generated | awaiting_approval | manual_queue | submitting
      -- | submitted | verified | failed | lost | unverifiable
  source_status TEXT,                        -- what the team's sheet claimed ('Approved' etc.)
  source_date_raw TEXT,                      -- the date exactly as typed, for the audit
  operator      TEXT,                        -- 'seo-agent' or the human's name
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  source        TEXT NOT NULL DEFAULT 'agent',  -- agent | source-sheet-import
  source_tab    TEXT,                        -- original sheet tab name
  source_row    INTEGER,                     -- original sheet row number
  sheet_row     INTEGER,                     -- row written in the agent sheet
  submitted_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(client_id, status);
CREATE INDEX IF NOT EXISTS idx_sub_type ON submissions(client_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_import
  ON submissions(client_id, source_tab, source_row)
  WHERE source = 'source-sheet-import';

-- ── Verification history ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  http_status   INTEGER,
  link_present  INTEGER,                     -- client link found on the page
  rel           TEXT,                        -- 'dofollow' | 'nofollow' | 'ugc' ...
  anchor_found  TEXT,
  indexed       INTEGER,                     -- NULL = not checked
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_verif_sub ON verifications(submission_id, checked_at);

-- ── Data-quality findings (audit report output) ───────────────────────────────
CREATE TABLE IF NOT EXISTS findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
  severity      TEXT NOT NULL,               -- high | medium | low
  code          TEXT NOT NULL,
  message       TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_findings_client ON findings(client_id, severity);

-- ── Discovery query log ──────────────────────────────────────────────────────
-- Search calls cost money or quota. Logging them stops the same footprint being
-- run twice in a week and makes "where did this site come from" answerable.
CREATE TABLE IF NOT EXISTS discovery_queries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT REFERENCES clients(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  query       TEXT NOT NULL,
  results     INTEGER NOT NULL DEFAULT 0,
  new_sites   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  ran_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queries_recent ON discovery_queries(query, ran_at);

-- ── Run log ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,                 -- import | discover | generate | submit | verify | push
  client_id   TEXT,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  stats_json  TEXT,
  error       TEXT
);

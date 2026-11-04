# SEO Off-Page Agent — Analysis & Implementation Plan

Project: `D:\Print World\tapify\seo-ai-agent`
Source sheet: *EEE Technologies Off Page* (Google Sheets)
Date: 2026-11-02

---

## 1. What the spreadsheet actually is

It is a **manual off-page link-building tracker** for one client — `https://eeetechnologies.in`, an IT training institute in Nagpur — worked by a 5-person team (saurabh, purvanshu, aniket, pranay, shobhit).

### 1.1 Structure

| Tab | Rows with data | Rows with a real backlink URL |
|---|---|---|
| Details (client credentials) | 1 block | — |
| Bookmarking submission | 16 | 16 |
| Profile submission | 1 | 1 |
| Blog submission | 1 | 1 |
| Mindmap Submission | 6 | 0 |
| PPT submission | 5 | 0 |
| Ping Submission | 4 | 0 |
| PDF Submission | 2 | 0 |
| Directory Submission | 3 | 0 |
| Image submission | 2 | 0 |

Every submission tab shares the **same 10-column schema**:

`Sr.no. | URL | Backlinks | Email id | Username | Password | Date | Status | Name | Keywords`

- **URL** = the platform (e.g. `https://padlet.com/`)
- **Backlinks** = the live page that carries the link back to the client
- **Email id / Username / Password** = the account used on that platform
- **Date / Status** (`submitted` / `Approved`)
- **Name** = which team member did it
- **Keywords** = the anchor / target keyword

### 1.2 Keyword set in play

- Full Stack Development in Nagpur
- Data Analysis Course(s) in Nagpur
- Software testing courses in Nagpur
- AI/ML course in Nagpur

### 1.3 Problems found in the data (the agent must not reproduce these)

1. **22 of the 40 rows have no backlink URL at all**, and **15 of those are marked `Approved`**. Those entries are unverifiable — effectively unproven work. (Every row in Mindmap, PPT, Ping, PDF, Directory and Image is in this state.)
2. **Two "backlinks" are not backlinks**: a `whois.com` lookup page and an `ipt.pw` backlink-maker *tool* page. Neither is a link the client owns or that survives.
3. **Date formats are inconsistent**: `22/1/26`, `22/01//26`, `2-2-2026`. One row has a date pasted into the **Status** column.
4. **One row has "EEE Technologies" in the Email id column** instead of an email address.
5. **Duplicate platform rows** (ipt.pw twice, with different passwords).
6. **Passwords are stored in plaintext in a shared Google Sheet**, and they are trivially sequential. One account's password equals its username.
7. **Nobody re-checks whether the link is still live.** Free-tier bookmarking and paste sites delete content routinely; a link marked `Approved` in January may be a 404 today.

> **Honest note on value:** of the nine categories, only *Blog submission*, *Profile submission* on real platforms (Substack, Reddit, Medium, Quora) and genuine *Directory* listings move rankings in 2026. Ping submission has had no effect for years, and low-quality bookmarking/PDF/PPT farms are at best neutral. The plan below builds **all nine**, because that is the workflow you asked for — but it scores sites so effort concentrates where links actually count, and it treats "Ping submission" as what it can actually be — see the correction in section 11, because the original claim here was wrong.

---

## 2. What the agent has to do

1. **Find** submission sites on the internet, per category, per niche.
2. **Vet** them (live, indexed, accepts submissions, dofollow or at least real traffic, not a spam farm).
3. **Hold accounts** per site per client — create where possible, otherwise accept human-created credentials.
4. **Generate** the asset the platform expects: article, bookmark blurb, profile bio, slide deck, PDF, image with metadata, mindmap, directory listing.
5. **Submit** it with the right anchor text and target URL.
6. **Verify** the backlink is actually live on the page, and record `dofollow`/`nofollow`, HTTP status and index state.
7. **Write the row back into the correct Google Sheet tab**, in the exact existing column layout, so your current reporting keeps working.
8. **Re-check** old links on a schedule and flag the dead ones.

---

## 3. Constraints the design has to respect

These are real and they shape the architecture.

| Constraint | Consequence in the design |
|---|---|
| **CAPTCHA / reCAPTCHA / Cloudflare Turnstile** on signup and often on submit | The agent will **not** bypass or solve CAPTCHAs. It pauses in **Assist Mode**: a real browser window opens, a WhatsApp/Telegram ping goes to the operator, a human clears the challenge, the agent resumes and finishes the job. The session cookie is then reused, so a human is needed roughly once per site, not once per link. |
| **Email / OTP verification** on signup | Same Assist Mode, plus an optional IMAP reader on the client mailbox to auto-click verification links where you supply those mailbox credentials. |
| **Terms of Service** — Reddit, Quora, Medium and most forums prohibit automated posting | Those are flagged `manual_only` in the catalog. The agent prepares content, title, anchor and target URL and queues it for a human to post in one click. It does not auto-post there. |
| **Rate limits and footprints** | Per-site and per-client daily quotas, randomised pacing, drip scheduling. Blasting 200 links in a day is how a link profile gets filtered. |
| **Credentials** | Move out of the Google Sheet into a local encrypted vault. The sheet gets the username only; the password column carries a reference token, not the secret. |

---

## 4. Proposed architecture

**Stack:** Node 24 + TypeScript · Playwright (headful-capable) · SQLite via the built-in `node:sqlite` (no native module to compile on Windows) · Google Sheets API v4 · Groq for generation, through an OpenAI-compatible driver so the vendor is one env var · the existing Tapify WhatsApp sender for operator notifications.

Why Node and not Python: your toolchain here is already Node/PHP, and Playwright's Node bindings handle persistent browser profiles and session reuse most cleanly.

```
seo-ai-agent/
├─ config/
│  ├─ clients/eeetechnologies.json      # site, niche, keywords, targets, quotas
│  └─ footprints.json                   # search operators per submission type
├─ data/
│  ├─ agent.db                          # SQLite: catalog, accounts, queue, results
│  ├─ sessions/<site>/                  # Playwright persistent profiles (logged-in state)
│  └─ artifacts/<client>/               # generated PDFs, PPTs, images, articles
├─ src/
│  ├─ cli.ts                            # discover | generate | submit | verify | sync | report
│  ├─ sheets/                           # read + write-back, column mapping, dedupe
│  ├─ discovery/                        # footprint search, candidate harvest
│  ├─ vetting/                          # live check, spam score, dofollow probe, scoring
│  ├─ catalog/                          # site registry + per-site rules
│  ├─ content/                          # article | bookmark | profile | ppt | pdf | image | mindmap
│  ├─ accounts/                         # encrypted vault, signup flows, session reuse
│  ├─ submit/
│  │  ├─ runner.ts                      # queue, quotas, pacing, retries, assist-mode pauses
│  │  ├─ generic-form.ts                # LLM-driven form filler (reads a11y tree, fills, submits)
│  │  └─ adapters/                      # substack, justpaste, pearltrees, diigo, padlet, ...
│  ├─ verify/                           # backlink presence, rel attribute, status, index check
│  ├─ indexing/                         # IndexNow for the CLIENT's own site + indexation checks
│  └─ report/                           # HTML dashboard, dead-link alerts
└─ docs/
```

### 4.1 Data model (SQLite)

- `clients` — site, niche, brand, contact, quotas
- `keywords` — keyword, target URL, anchor variants, priority
- `sites` — platform URL, category, authority estimate, dofollow, requires_account, requires_captcha, manual_only, score, last_success
- `accounts` — client × site, username, encrypted secret, session path, verified_at
- `content_items` — type, keyword, title, body or asset path, used_on
- `submissions` — client, site, keyword, content, submitted_url, status, attempts, operator, sheet_row
- `verifications` — submission, checked_at, http_status, link_present, rel, indexed

### 4.2 Site adapter contract

Each platform gets a small adapter; everything else falls through to the generic LLM form filler.

```ts
interface SiteAdapter {
  id: string;                     // 'substack'
  category: SubmissionType[];     // ['blog','profile']
  requiresAccount: boolean;
  signup?(page, account): Promise<void>;          // may pause for assist mode
  submit(page, payload, account): Promise<{ liveUrl: string }>;
  verify?(liveUrl, targetUrl): Promise<VerifyResult>;
}
```

First-class adapters to build, chosen from what the sheet already uses successfully: **Substack, JustPaste.it, Pearltrees, Diigo, Padlet, Start.me, Flipboard, BuyMeACoffee**. Reddit stays `manual_only`.

---

## 5. Phased plan

### Phase 0 — Scaffold and sheet sync *(about half a day)*
- Project skeleton, TypeScript config, SQLite schema, CLI shell.
- Google service-account auth; read all 10 tabs into SQLite; normalise the messy dates; flag the unverifiable rows and the two fake backlinks in a cleanup report.
- Write-back proven on a scratch copy of the sheet first, never on the live one.
- **Deliverable:** `npm run sync` mirrors the sheet; `npm run report:audit` prints the data-quality findings.

### Phase 1 — Discovery and vetting engine *(1–2 days)*
- Footprint library per category — bookmarking: `"submit a story" inurl:/story`; blog: `"write for us" <niche>`; directory: `"add your business" <city>`; and so on.
- Harvest candidates via search, dedupe against the catalog, then vet each one: resolves, indexed in Google, submission form present, outbound links dofollow, spam signals (link-farm footer, thousands of outbound links, expired domain).
- Score 0–100, with a per-category value multiplier so blog and profile outrank ping and bookmark.
- **Deliverable:** `npm run discover -- --type bookmarking --limit 100` produces vetted, scored catalog rows.

### Phase 2 — Content factory *(1–2 days)*
- Per keyword and per type: title, 700–1100 word unique article, 2–3 line bookmark blurb, profile bio, slide deck (pptxgenjs), PDF (PDFKit — the pattern already used in MRPW), branded image with IPTC/XMP metadata, mindmap (JSON to SVG/PNG).
- Anchor rotation (exact, partial, branded, naked URL) so the anchor profile looks natural.
- Every asset unique per site; no duplicate content reused across platforms.
- **Deliverable:** `npm run generate -- --client eee --keyword "AI/ML course in nagpur"` writes to `data/artifacts/`.

### Phase 3 — Submission engine *(3–4 days, the bulk of the work)*
- Credential vault, Playwright persistent sessions, login reuse.
- Assist Mode: headful pause, WhatsApp ping, resume — for CAPTCHA and OTP.
- Runner with queue, per-site and per-day quotas, randomised delays, retry and backoff, failure classification.
- The eight first-class adapters, plus the generic LLM form filler for the long tail.
- `manual_only` queue export for Reddit, Quora and Medium.
- **Deliverable:** `npm run submit -- --type bookmarking --count 10` produces live URLs.

### Phase 4 — Verification, write-back and indexing *(1–2 days)*
- Fetch each submitted URL, confirm the client link is present, capture `rel`, HTTP status, and whether Google has it indexed.
- Only a **verified** link gets `Status = Approved` written back. Unverified stays `Submitted`; a missing link becomes `Failed`.
- Row written into the correct tab, correct columns, correct Sr.no., normalised date, `Name = seo-agent` or the operator who assisted.
- IndexNow for the client's own URLs, and an indexation check on each backlink page (see the correction in section 11 — third-party URLs cannot be submitted at all).
- **Deliverable:** the sheet fills itself, and every `Approved` row is provably live.

### Phase 5 — Scheduling, monitoring and multi-client *(1–2 days)*
- Daily cron: N submissions per type per client, drip-paced.
- Weekly re-verification sweep of all historical links; dead links raise a WhatsApp alert and flip the sheet status to `Lost`.
- HTML dashboard: links built, verified-live rate, dofollow ratio, anchor distribution, per-keyword progress.
- A second client is onboarded by dropping one JSON file into `config/clients/`, which proves the multi-tenant path for the rest of your Tapify clients.

**Total: roughly 8–12 working days** to a system that runs daily on its own, with a human needed only for CAPTCHAs and the `manual_only` queue.

---

## 6. Decisions — locked 2026-11-02

| # | Decision | Chosen |
|---|---|---|
| 1 | Scope | **Multi-client from day one.** One JSON per client in `config/clients/`. |
| 2 | Autonomy | **Auto-submit everything except blog articles**, which wait in an approval queue. |
| 3 | Runtime | **Windows PC, visible browser** — Assist Mode is a window you click in. |
| 4 | Content LLM | **Groq**, via the same key and OpenAI-compatible driver pattern as `tapify-voice-agent`. |
| 5 | Sheet | **The agent owns a new sheet.** The team's tracker is read-only to the agent; the new sheet keeps the same ten columns and adds verification columns. |
| 6 | Credentials | **Encrypted local vault** (AES-256-GCM in SQLite, key in `.env`). The agent sheet's Password column reads `in vault`. Existing passwords should be rotated. |

---

## 7. Phase 0 — built

Scaffold, SQLite schema, credential vault, date normalisation, read-only source pull, agent-owned sheet creation and push, snapshot import, and the data-quality audit.

```bash
npm install
npm run db:init
npm run import:snapshot -- --client eeetechnologies
npm run report:audit    -- --client eeetechnologies
```

The audit runs with no Google credentials at all: a redacted snapshot of the current tracker is committed at `data/snapshots/eeetechnologies-2026-11-02.json`. Google setup is only needed for the live pull and the agent sheet — see [SETUP-GOOGLE.md](SETUP-GOOGLE.md).

## 8. Phase 1 — built

Footprint library, provider-independent search (serper / Google CSE / Brave), listicle mining, a 37-site curated seed catalog, polite fetching with a robots.txt parser, page analysis, inner-page sampling, two-axis scoring and an LLM editorial judge.

```bash
npm run discover:seed
npm run vet -- --limit 25
npm run catalog -- stats
```

**What the first live run established**

| | |
|---|---|
| 23 sites vetted usable, 11 blocked by bot protection or robots.txt, 3 permanently rejected | |
| `bookmarkrange.com` runs **Kliqqi**, a link-farm CMS | one of the two sites the team actually used |
| `social-bookmarkingsites.com` publishes beard transplants, nautical colleges and Middle East billing software | the other one |
| 8 platforms are `manual_only`, 4 need Assist Mode for CAPTCHA | known before a single submission is attempted |

**Four corrections the live run forced**, each a real defect found by running it rather than reasoning about it:

1. **robots.txt was rejecting good platforms.** Reddit and Diigo disallow crawling, so they were marked unusable — but robots.txt governs crawlers, not a signed-in person posting through a browser. They are now `blocked`, a separate, non-permanent state.
2. **Cloudflare 403 was read as "dead site".** Eleven platforms refuse automated fetches; that is a statement about our crawler, not about them.
3. **A low score was rejecting known-good sites.** justpaste.it, which the team has published on successfully, scored 40 and was discarded. A site with a working adapter or a curated entry now cannot be demoted by a homepage crawl.
4. **The blocklist was overridable.** A re-vet resurrected the whois page and the SEO-tool page, because they score fine as websites. Blocklisting is now a flag that vetting may never touch.

**The honest limit.** Without a paid authority API, a 12-year-old link farm and a 12-year-old real publication look alike: the farm scores 90 on submittability and 75 on authority. The LLM judge is the answer — it reads the published item titles and sees the incoherence instantly — and it is built, wired and waiting for `LLM_API_KEY`. Until that key is set, treat the top of the ranking as "mechanically workable", not "good".

## 9. Phase 2 — built

Anchor rotation, prompt construction with a factual-claims guard, LLM writer with a template fallback, article rendering with deliberate link placement, and four asset builders: PDF (PDFKit), PPTX (pptxgenjs), JPEG with EXIF (sharp), mind map (SVG + PNG + FreeMind `.mm`).

```bash
npm run generate -- --type blog
npm run content -- pending
npm run content -- anchors
```

**Verified by running it**: one asset of all eight types, every file valid — PDF `%PDF`, PPTX a real zip, JPEG 1200x1200 carrying 438 bytes of EXIF with the client name and Software tag, mind map PNG plus importable FreeMind XML.

**Two bugs the run exposed**

1. **Every anchor came out `branded`.** The rotation read the live mix from `submissions`, but the anchor is decided when the asset is *written* and nothing is submitted until Phase 3. The mix stayed empty, so all eight assets picked the same largest deficit — the exact uniformity the module exists to prevent. Now counted from `content_items`, and the profile converges: branded 38%, naked 25%, partial 25%, exact 13% against targets of 35/25/25/15.
2. **Two assets aimed at the same platform.** `suggestSite` excluded sites with recent *submissions* but not sites already holding an unsent asset, so consecutive runs both picked the best site and one was wasted.

**Design decisions worth keeping in mind**

- **The link goes in the middle of the body, never the first or last section.** A link in the opening paragraph reads as an advert and gets moderated out; a link in the closing line is the classic guest-post footprint.
- **The writer may not invent facts about the client.** `content.facts` in the client config is the only permitted source of specifics. It is currently **empty**, so the model is instructed to say nothing specific about the business and write about the subject instead. Filling it in is the single biggest lever on article quality — and it must come from the client, not from a model.
- **Template mode is not publishable.** No key means structural placeholder text, marked `generator: 'template'`, held in the approval queue, refused by `content approve`, and refused by the submission engine. Publishing skeleton text across fifty platforms is the thin-content problem this project exists to avoid.
- **PDF and deck links barely count.** The crawlable link is in the hosting platform's description field, not inside the file, so that description is treated as the real deliverable.
- **The `.mm` export is why mindmap is worth touching at all.** Mind-map platforms are canvas apps behind a login and cannot be automated; nearly all of them import FreeMind XML, which turns a twenty-minute manual rebuild into one upload.

## 10. Phase 3 — built

Persistent browser sessions, Assist Mode, the credential vault wired to signup, the generic form filler, four adapters, the runner with quotas and pacing, the manual queue, and a self-test.

```bash
npm run submit:selftest     # 14/14 against a local fixture
npm run submit -- plan
npm run submit -- run --dry-run
```

**Verified**: the form filler against a local fixture (14 checks, all passing), the planner, the dry run, the manual-queue export and the record-a-human-result path. **Not verified**: a real submission to a real platform — see below.

**Four bugs the runs exposed**

1. **`__name is not defined`** inside every `page.evaluate`. tsx compiles with esbuild's `keepNames`, which wraps functions in a `__name()` helper that exists in Node and not in the browser. Every `evaluate` in this project is now a **string**, with the reason documented at the call site.
2. **`locator.evaluate` with a string returns the function instead of calling it**, because a string is an expression, not a callback — so the element cannot be passed that way at all. Field extraction is now one page-side pass that tags each field with `data-seoagent-field` and returns all descriptors: one round trip instead of sixty, and no serialisation problem.
3. **The runner would have automated `manual_only` platforms.** There was no such filter in `pickWork`, so had Reddit ever been marked `vetted`, the agent would have posted to a platform whose terms forbid it. Now excluded in SQL.
4. **`blocked` sites were excluded from submission entirely.** That wrongly ruled out telegra.ph — the one adapter with no guesswork in it — because a crawler was refused during vetting. Crawlability is irrelevant to an API adapter, so `blocked` is now allowed through for API-only adapters and filtered out only for browser ones.

**What is deliberately not attempted**

No CAPTCHA solving, no fingerprint spoofing, no proxy rotation, no `navigator.webdriver` patching. The agent identifies as an ordinary Chromium, posts to accounts belonging to the client, and when a platform refuses automation it is handed to a human. Payment and government-ID fields are refused outright, as is any button matching pay / buy / checkout / subscribe; both refusals are covered by the self-test.

**Why no live submission yet.** Publishing content to a third-party platform is not reversible and not mine to decide — and the only content currently in the system is template placeholder text, which the engine refuses to send anyway. The telegra.ph path is one command from working once there is real content: `npm run submit -- run -n 1`.

## 11. Phase 4 — built, with a correction

Link scanner, verifier with browser-render fallback, status transitions, re-verification sweep, IndexNow for the client's own site, indexation reporting, and the link report.

```bash
npm run verify -- --limit 20
npm run report:links
npm run cli -- index status
```

### Correction: "IndexNow + sitemap ping for every backlink" was wrong

Phases 0-3 of this document said the agent would replace Ping submission by submitting every new backlink URL to IndexNow and pinging sitemaps. Neither is possible:

1. **IndexNow only accepts URLs on a host whose key file you publish.** The key must live at `https://<host>/<key>.txt`, and every URL in a submission must belong to that host. We do not control telegra.ph or padlet.com, so their URLs can never be submitted by us. IndexNow is useful here for exactly one domain: the client's own.
2. **Sitemap ping no longer exists.** Google retired `/ping?sitemap=` in 2023 and Bing deprecated its equivalent.

So the module does what is actually possible: submits the **client's own** URLs to IndexNow (useful whenever their site gains a page), and for third-party backlinks runs an **indexation check** — because a backlink on a page that was never indexed passes nothing, and knowing which platforms those are is the decision that matters. `index status` lists them.

### What verifying the real tracker found

Run against the 18 imported rows that had a URL:

| | |
|---|---:|
| Verified live, dofollow | **1** |
| Lost (404) | 1 |
| Honestly unknown — platform returned 403 to fetch *and* render | 8 |
| Text mention only, no anchor — passes nothing | 3 |
| Page renders fine, no link to the client | 5 |
| Rows with no URL at all (from the earlier audit) | 22 |

The one verifiable dofollow backlink is on `social-bookmarkingsites.com` — the site the Phase 1 judge flags as a link farm publishing beard transplants and nautical-science colleges.

### Three bugs the live run exposed

1. **Scheme-less URLs failed as "unreachable".** The tracker holds `buymeacoffee.com/eeetechnology` with no `https://`, and `new URL()` threw. Normalised now — and with that fixed the page turns out to be a genuine 404.
2. **403 was being recorded as "the page is gone".** This is the same error the project already made in Phase 1 vetting: a platform refusing our fetcher says nothing about whether the page or the link exists. Only 404 and 410 now mean lost; 403, 429 and 5xx are `inconclusive`, which never changes a status.
3. **The browser fallback almost never fired.** It was gated on a "looks client-rendered" heuristic that large JS shells passed. It now renders whenever a plain fetch finds no link, through one shared browser for the whole run rather than one launch per URL.

### The honest limit

Eight of eighteen links cannot be machine-verified: Substack, Flipboard, Padlet, Diigo and start.me return 403 to headless Chromium, and also to the persistent profile when it holds no login cookie for them. The verifier reports these as unknown rather than guessing in either direction. The realistic unlock is `verify --session` with `HEADLESS=false` on a machine where those accounts are signed in. Defeating the bot protection is not on the table.

## 12. Phase 5 — built

Daily and weekly pipelines, operator alerts, a preflight `doctor`, the HTML dashboard, a Windows Task Scheduler installer, and the multi-client path.

```bash
npm run doctor
npm run daily -- --dry-run
npm run dashboard
```

**Verified**: doctor against the real configuration, dashboard rendered and inspected in a browser, both pipelines dry-run end to end, and the client loader confirmed to ignore `_template.json`.

**Windows Task Scheduler, not cron**, because the locked decision is that this runs on a PC where a person can clear a CAPTCHA. The tasks run as the user, interactively, with a visible window, and without elevation — a hidden task would make Assist Mode useless, since nobody would ever see the browser waiting.

**Two bugs the run exposed**

1. **The pipeline funnel read 0 written → 0 submitted → 1 verified**, which is impossible. It was mixing the agent's own work with the links inherited from the manual tracker. The funnel now counts agent-sourced work only, and says in a note how many inherited URLs sit outside it.
2. **The status palette failed its own adjacency check.** The obvious fill order — good, warning, serious, critical — puts `warning` next to `serious`, and those measure ΔE 13.6 to normal vision, below the 15 floor, so adjacent stacked segments are hard to tell apart even with full colour vision. The validator caught it; reordering to good → warning → critical → serious passes in both light and dark modes. Every figure is also written out and every chart has a table view, which is the required relief for the two status colours that sit below 3:1 on a light surface.

**A failing step never aborts a run.** If generation dies on an LLM quota, verification of yesterday's links still happens — that step protects the asset the client already has. Failures are recorded and alerted per step.

**Alerts are deliberately narrow**: a link that went from live to gone, a submission stuck waiting for a human, and a failed run. Not progress, not quota exhaustion. An alert channel that cries wolf gets muted, and then the real one is missed.

### All five phases are built. What is still missing is not code

| Blocker | Effect | Who can fix it |
|---|---|---|
| `LLM_API_KEY` (Groq) | No publishable content, and the link-farm judge stays idle | You — paste the key |
| Google service-account key | No sheet sync, in either direction | You — `docs/SETUP-GOOGLE.md`, five minutes |
| `content.facts` for the client | Articles must stay general, capping quality | The client |
| Deep link targets per keyword | Every link points at the homepage | You or the client |
| A search API key (optional) | No discovery beyond the 37 curated sites, no index checks | You |

`npm run doctor` reports exactly this list, and exits non-zero while anything blocking remains.

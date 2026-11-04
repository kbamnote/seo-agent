# seo-ai-agent

Off-page SEO agent: finds submission sites, generates the asset each platform
expects, submits it, **verifies the backlink is actually live**, and keeps a
Google Sheet in sync.

Built for the Tapify SEO workflow. Multi-client: one JSON file per client in
`config/clients/`.

Full analysis and roadmap: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md).

---

## Status

| Phase | What | State |
|---|---|---|
| 0 | Scaffold, SQLite schema, vault, sheet sync, data-quality audit | **done** |
| 1 | Site discovery and vetting | **done** |
| 2 | Content factory (article, bookmark, PDF, PPT, image, mindmap) | **done** |
| 3 | Submission engine (Playwright, adapters, Assist Mode) | **done** |
| 4 | Verification, write-back, IndexNow | **done** |
| 5 | Scheduling, monitoring, dashboard | **done** |

Locked decisions: multi-client · auto-submit everything except blog articles ·
runs on Windows with a visible browser · Groq for generation · the agent owns a
separate sheet and never writes the team's manual one · passwords in an
encrypted vault, never in a sheet.

---

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

1. **`VAULT_KEY`** — generate once and keep a backup:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **`LLM_API_KEY`** — the same Groq key the voice agent uses (`gsk_...`).
3. **Google** — only needed for live sheet sync; see
   [docs/SETUP-GOOGLE.md](docs/SETUP-GOOGLE.md). The audit below runs without it.

```bash
npm run db:init
```

---

## Phase 0 commands

```bash
npm run import:snapshot -- --client eeetechnologies
```
Imports the committed snapshot of the existing tracker. No Google credentials
needed — the snapshot is checked in with passwords redacted.

```bash
npm run report:audit -- --client eeetechnologies
```
Writes `data/reports/<client>-audit-<date>.md`: how many rows have no URL at
all, which recorded "backlinks" cannot be backlinks, malformed dates, unmapped
keywords, credential hygiene.

```bash
npm run sync -- --client eeetechnologies
```
Pulls the live tracker (read-only), writes a fresh redacted snapshot, and
encrypts the real passwords into the vault.

```bash
npm run sheet:create -- --client eeetechnologies
npm run sheet:push  -- --client eeetechnologies
```
Creates the agent's own sheet (nine tabs plus Findings, shared with
`SHEET_SHARE_WITH`) and writes the database into it.

```bash
npm run llm:ping
```
Proves the Groq key and model work before Phase 2 depends on them.

---

## Phase 1 commands

```bash
npm run discover:seed
```
Loads the curated catalog — 37 platforms, no search API key needed. Two domains
are **blocklisted permanently**: the whois page and the SEO-tool page that the
old tracker recorded as backlinks. Vetting can never revive them.

```bash
npm run discover -- --type blog --queries 4 --expand-lists
```
Searches for new candidates. `--expand-lists` mines the "Top 50 sites" listicles
those searches return: one fetch yields dozens of candidate domains for one
search call. `--dry-run` prints the queries without spending quota. Needs a
search key (serper, Google CSE or Brave) — see `.env.example`.

```bash
npm run vet -- --limit 25 --judge --check-index
```
Fetches each candidate, samples one inner content page, scores it, and stores
the verdict.

```bash
npm run catalog -- stats
npm run catalog -- list --type blog --status vetted
npm run catalog -- show substack.com
```

### The two numbers

A site gets scored twice, because "can a machine post here" and "is a link from
here worth anything" are different questions, and conflating them is how link
farms end up at the top of a list.

- **sub** (submittability) — https, a reachable submit form, dofollow outbound
  links, sane link volume. Mechanical, measured from the page.
- **auth** (authority) — domain age via RDAP, indexation (`--check-index`,
  one search call), sitemap. Free signals only; weak by design. A Moz or Ahrefs
  key would slot in here later.

Sites are ranked by `0.45*sub + 0.55*auth`, times the category's own worth.

### Why the LLM judge exists

The mechanical scorer gave a generic bookmarking farm **90** and Substack **60**.
The farm does everything right: https, dofollow links, a tidy submit button, a
twelve-year-old domain. What gives it away is what people have published on it —
beard transplants, nautical science colleges, Middle East billing software, all
on one site. No regex catches incoherence.

`--judge` sends the page's title, description and the titles of its published
items to the LLM and asks one question: does anyone exercise editorial control
here? A confident "farm" is a rejection no score can override. Costs one cheap
call per site and needs `LLM_API_KEY`.

---

## Phase 2 commands

```bash
npm run generate -- --type blog
```
Writes one asset. It picks the keyword with the fewest assets so far, picks the
best vetted platform that has not been used in a week, picks the anchor kind the
profile is most short of, and writes something new for it.

```bash
npm run generate -- --type bookmarking --count 3
npm run generate -- --type pdf --site issuu.com
npm run generate -- --type ppt --keyword "AI/ML Course in Nagpur"
npm run content -- pending
npm run content -- show 7
npm run content -- approve 7
npm run content -- anchors
```

### What gets produced per type

| Type | Written | File |
|---|---|---|
| `blog` | 700-1100 word article, 4-6 sections, 3-5 FAQs, one takeaway | `.md` + `.html` |
| `pdf` | the same article, properly typeset, with a real link annotation | `.pdf` |
| `ppt` | 6-8 slide deck, title slide, closing slide with the link | `.pptx` |
| `image` | 1200x1200 JPEG with EXIF (ImageDescription, Copyright, Artist) | `.jpg` |
| `mindmap` | tree diagram, plus **FreeMind `.mm`** so a human can import it in one step | `.png` + `.svg` + `.mm` |
| `bookmarking`, `profile`, `directory`, `ping` | short copy for the platform's own fields | — |

### Anchor rotation

The old tracker used the exact target keyword as the anchor on all sixteen
bookmark submissions. That is the most legible footprint in link building.

Anchors are now chosen to pull the **live** distribution towards a target shape —
branded 35%, naked 25%, partial 25%, exact 15% — so the agent self-corrects and
inherits the skew of whatever was built before it. `npm run content -- anchors`
shows where the profile stands.

### What the writer may and may not say

`config/clients/<id>.json` has a `content` block. Its `facts` array is the **only**
source of specifics the writer may state about the client. With it empty, the
prompt instructs the model to say nothing specific about the business at all and
write about the subject instead.

`forbidden` lists what is never allowed: placement percentages, salary figures,
student counts, fees, testimonials, "best in Nagpur". Inventing a placement rate
would put a false claim on the public internet under the client's name, which is
a liability and not a ranking. **Fill in `facts` from the client** — the article
quality ceiling is set by it.

### Template mode

With no `LLM_API_KEY`, the writer emits structural placeholder text marked
`generator: 'template'`. That exists so the whole pipeline can be exercised
without a key. It is **not publishable**: it always lands in the approval queue,
`content approve` refuses it, and the submission engine will not send it.

---

## Phase 3 commands

```bash
npm run submit:selftest
```
Runs the real form filler against a local fixture file. No network, no third
party, nothing published. 14 checks: field mapping, maxlength, select handling,
submit-button detection, and both safety refusals.

```bash
npm run submit -- plan          # what is ready, and today's quota
npm run submit -- run --dry-run # exactly what would be sent
npm run submit -- run -n 1      # send one
npm run submit -- adapters      # which platforms have a hand-written adapter
npm run submit -- manual        # brief for platforms a human must post to
npm run cli -- submit record 41 "https://..."   # record what the human posted
npm run cli -- submit continue justpaste.it     # unblock a waiting Assist session
npm run cli -- account password justpaste.it    # for finishing a sign-in by hand
```

### Adapters

| Adapter | Confidence | Needs | Platforms |
|---|---|---|---|
| `telegraph` | **api** | nothing | telegra.ph, via its documented public API — no browser, no login, no CAPTCHA |
| `justpaste` | untested | nothing | justpaste.it |
| `writeas` | untested | nothing | write.as |
| `generic` | untested | account | everything else — drives the form filler |

`untested` means the selectors were written from the platform's structure and
have not been watched working. That is an honest label, not a disclaimer: a
selector written without seeing the live DOM is a hypothesis. **Run the first
submission to any such site with `HEADLESS=false`** so a wrong guess is visible
rather than silent.

### Assist Mode

When a CAPTCHA, OTP or sign-in wall appears, the agent stops, tells you what it
needs, optionally WhatsApps you, and waits — up to ten minutes — polling for the
condition to clear. The browser window is already open on the page.

Because the profile in `data/sessions/<domain>/` persists, this is **once per
site, not once per link**. That is the whole reason the arrangement is cheaper
than doing the work by hand.

If the agent doesn't notice you're done:

```bash
npm run cli -- submit continue <domain>
```

### Pacing and quotas

Pacing is survival, not politeness. Forty links in an afternoon from one IP, all
pointing at one domain, is the footprint that gets a profile discounted and
accounts banned. From `config/clients/<id>.json`: 8 submissions a day, per-type
caps, one submission per site per week, 12 minutes between sends — all enforced
in the runner.

### What the submitter refuses to do

- **No CAPTCHA solving.** It hands over to a human instead.
- **No fingerprint spoofing, no proxy rotation, no `navigator.webdriver` patching.**
  It identifies as an ordinary Chromium. A platform that refuses automation gets
  a human, not a workaround.
- **Never fills a payment or government-ID field**, and never clicks a button
  matching pay / buy / checkout / subscribe. A submission form that wants a card
  number is not a submission form. Both refusals are covered by the self-test.
- **Never automates a `manual_only` platform.** Reddit, Quora, Medium, dev.to and
  the phone-verified directories are excluded from the runner in SQL and routed
  to the manual queue.

---

## Phase 4 commands

```bash
npm run verify -- --limit 20            # check submitted URLs for the client link
npm run verify -- --session             # render via the real browser profile (403 platforms)
npm run verify -- --check-index         # also ask whether each page is indexed
npm run verify -- --resweep             # re-check history, including lost links
npm run cli -- verify one 17 --deep     # one submission, fully rendered
npm run report:links                    # what the client actually has
npm run cli -- index status             # verified links that are not indexed
npm run cli -- index submit https://eeetechnologies.in/some-page
```

### What counts as a link

| Verifier outcome | Status | Means |
|---|---|---|
| `<a href>` to the client found | `verified` | The only thing that counts. Records dofollow/nofollow, the anchor text actually used, and whether it sits in content or in a footer. |
| 404 or 410 | `lost` | The page is genuinely gone. |
| 403 / 429 / 5xx, after rendering too | *unchanged* | **Honestly unknown.** The platform refused us; that says nothing about the link. Never recorded as lost. |
| Page fine, no link, recent | `submitted` | Still in moderation. 14-day grace, 3 checks. |
| Page fine, no link, past grace | `lost` | Quietly removed. |
| Was `verified`, link now absent | `lost` | It was there; something took it down. |
| URL as plain text, no anchor | `submitted` + flagged | A **mention**, not a link. Passes nothing. The old tracker counted these as Approved. |

Only this verifier may write `verified`. That rule is what makes the number mean
anything.

---

## Phase 5 — running it unattended

```bash
npm run doctor                    # is this safe to leave running?
npm run daily -- --dry-run        # what the daily run would do
npm run daily                     # generate, submit, verify, sheet, report
npm run weekly                    # re-verify every link, alert on losses
npm run dashboard                 # the HTML dashboard
```

Both pipelines run for **every** configured client unless you pass `--client`.

### Install the schedule (Windows)

```powershell
.\scripts\install-schedule.ps1
```

Registers `SeoAiAgent-Daily` (10:30) and `SeoAiAgent-Weekly` (Sunday 09:00) in
Task Scheduler, logging to `data/schedule.log`. `-DailyAt 18:00`, `-WhatIf` and
`-Uninstall` all work.

The tasks run **as you, interactively, with a visible window** — not hidden, and
not elevated. Assist Mode needs a person to be able to see and click, so a hidden
task would simply time out after ten minutes with nothing submitted. They fire
only while you are logged in; a missed run starts at the next logon.

### What the pipelines do

| Step | Daily | Weekly |
|---|---|---|
| top up content for each type | ✓ | |
| submit within quota, paced | ✓ | |
| export the manual queue | ✓ | |
| verify what was sent | ✓ | |
| re-verify **all** history, including lost | | ✓ |
| push the sheet | ✓ | |
| link report + dashboard | ✓ | ✓ |
| alert on losses and stalls | ✓ | ✓ |

**A failing step does not abort the run.** If generation fails because an LLM
quota ran out, yesterday's links still get verified — that is the step protecting
the asset the client already has. Each step is isolated and its failure is both
recorded and alerted.

### Alerts

WhatsApp through the existing Tapify sender when `OPERATOR_WHATSAPP` and
`TAPIFY_WA_ENDPOINT` are set, console otherwise. It alerts on **a link that went
from live to gone**, **a submission stuck waiting for a human**, and **a run that
failed** — and deliberately not on ordinary progress or quota exhaustion. A
channel that cries wolf gets muted, and then the real alert is missed too.

### Adding the second client

```bash
cp config/clients/_template.json config/clients/acme.json
# edit it: id must match the filename
npm run cli -- client add --client acme
npm run daily                     # now runs for both
```

Files starting with `_` are ignored by the loader, so the template never becomes
a client.

---

## Giving it to your team

The deployed URL **is** the app — UI and API in one service. Nothing else to
host, and nothing for them to install.

Send them the URL, the username and the password, and
[docs/TEAM-GUIDE.md](docs/TEAM-GUIDE.md). Their whole job is two tabs: approve
articles, and work the manual queue. The commands in this README are for
whoever administers it, not for them.

## The web UI

```bash
npm run web
```

Opens on <http://127.0.0.1:4317>. Six views over the same database the CLI uses:

| View | What it is for |
|---|---|
| **Overview** | verified / waiting / lost / unknown, content counts, anchor profile, today's quota |
| **Approvals** | the reason this exists: read an article properly, with the inserted link highlighted, then Approve or Reject |
| **Manual queue** | platforms a human must post to, with copy-title / copy-body buttons and a box to record the URL afterwards |
| **Ready to send** | what the next submission run would pick, and which adapter it would use |
| **Links** | every submission with its latest verification: status, rel, what the checker saw |
| **Catalog** | every platform with both scores; set a site vetted or rejected |

Hosted somewhere (Railway), it needs `WEB_USER` and `WEB_PASSWORD` — the server
refuses to start on a public address without them. See
[DEPLOY-RAILWAY.md](docs/DEPLOY-RAILWAY.md), and note that **Assist Mode cannot
work on a host with no screen**.

### Three things it deliberately does not do

- **It never runs a command.** The first draft had endpoints that spawned the CLI
  so you could click "submit" and watch the output stream back. An HTTP route that
  starts processes is a remote-code-execution surface, and "it's only localhost" is
  how that always gets argued. Generating, submitting and verifying stay in the
  terminal, where they are deliberate. The Overview lists the commands.
- **It never shows a password.** The vault stays behind the CLI.
- **It binds to 127.0.0.1 only**, and that is not configurable.

It is also not the dashboard. `npm run dashboard` writes a read-only snapshot page
you can hand to a client; this is the working tool, with buttons that change things.

### Statuses

| Status | Means |
|---|---|
| `candidate` | found, not yet vetted |
| `vetted` | usable |
| `marginal` | the homepage showed no evidence either way — retry or decide by hand |
| `blocked` | bot protection or robots.txt turned **our crawler** away. Says nothing about posting there as a signed-in user — Phase 3's browser handles these |
| `rejected` | permanent: parked, link farm, noindex, dead |

`blocked` and `rejected` are deliberately different. Reddit and Diigo are
`blocked` on robots.txt; they are still perfectly good places to post.

---

## How to read the status column

The imported rows never arrive as verified, whatever the source sheet says.

| Status in the agent sheet | Means |
|---|---|
| `Approved (verified live)` | A verifier fetched the page and found the link. Only Phase 4 sets this. |
| `Submitted (not yet verified)` | A URL exists; nobody has checked it. |
| `No URL recorded` | The row claims work was done but holds no link. |
| `Needs manual posting` | Platform forbids automation (Reddit, Quora, Medium). Content is ready. |
| `Awaiting your approval` | A blog article is drafted and waiting. |
| `Lost (link gone)` | It was live once and is not any more. |

---

## Layout

```
config/clients/      one JSON per client (keywords, targets, quotas, approval)
data/agent.db        SQLite: catalog, accounts, submissions, verifications
data/snapshots/      redacted copies of source-sheet pulls (safe to commit)
data/reports/        generated audit reports
data/sessions/       Playwright logged-in profiles (Phase 3, never committed)
data/artifacts/      generated PDFs, decks, images (Phase 2)
src/
  config.ts          env + client config, tab mapping, link-value weights
  db/                schema.sql and the SQLite layer (node:sqlite, no native build)
  util/vault.ts      AES-256-GCM credential vault
  util/dates.ts      normalises the four date formats the tracker uses
  sheets/            auth, read-only source pull, agent-owned sheet
  import/            tracker import
  discovery/         footprints, search providers, harvesting, seed catalog
  vetting/           fetch, robots, page analysis, scoring, authority, LLM judge
  catalog/           browse and curate the site catalog
  report/audit.ts    data-quality audit
  llm/               OpenAI-compatible driver (Groq by default)
```

---

## Things worth knowing

- **Passwords never go into a sheet.** The agent sheet's Password column says
  `in vault`. The secrets live AES-encrypted in `data/agent.db`, keyed by
  `VAULT_KEY`. Lose that key and they are unrecoverable.
- **No CAPTCHA solving.** When a challenge appears, Phase 3 opens a real browser
  window, pings the operator, and waits. Session cookies are reused afterwards,
  so a human is needed roughly once per site, not once per link.
- **`node:sqlite`, not `better-sqlite3`.** Node 24 ships a SQLite driver, so
  `npm install` needs no C++ toolchain on Windows.
- **Ping submission is not what it looks like.** IndexNow can only accept URLs on a
  host whose key file you publish, so third-party backlink pages cannot be submitted
  by anyone but their owner — and Google retired sitemap ping in 2023. What the agent
  does instead: IndexNow for the *client's own* site, and an indexation check on each
  backlink, because a backlink on an unindexed page passes nothing. `index status`
  lists the ones to stop bothering with.
- **robots.txt is respected, not worked around.** A site that forbids crawling is
  marked `blocked`, never bypassed. A link placed against a site's stated wishes
  is a link that gets removed, and the account with it.
- **One inner page is sampled per site.** Homepages are poor witnesses: farms keep
  theirs tidy and put the thousand outbound links on the story pages.
- **The anchor mix is read from generated content, not submissions.** The anchor is
  decided when an asset is written; counting submissions kept the mix empty and made
  every anchor identical.
- **`content.facts` in the client config is empty.** Until it is filled from the
  client, articles stay general by design — the writer is forbidden from inventing
  fees, placement rates or student numbers.

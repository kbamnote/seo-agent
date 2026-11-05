# Hosting the agent on Railway

Railway suits this project where Vercel cannot: it runs a persistent container,
with a real filesystem and processes that live longer than a request. Chromium
fits, SQLite survives, and a submission run can take ten minutes.

Read the "What changes when it is hosted" section before you commit to it. One
thing genuinely stops working.

---

## Steps

### 1. Create the service

New Project → Deploy from GitHub repo → `kbamnote/seo-agent`.

Railway reads `railway.json` and builds from the `Dockerfile`, which is based on
Microsoft's Playwright image. Chromium and its system libraries are already in
that image; installing them onto a bare Node image is the usual way a hosted
browser-automation deploy fails.

### 2. Add a volume — do this before the first real run

Service → Settings → Volumes → New Volume, mount path:

```
/app/data
```

Everything that must survive a redeploy lives under it: the SQLite database,
browser profiles, generated assets, reports. **Without the volume the agent
forgets every link it has ever built on each deploy**, and starts submitting
duplicates.

### 3. Set the variables

| Variable | Value | Why |
|---|---|---|
| `WEB_USER` | a username | the UI approves content and edits the catalog |
| `WEB_PASSWORD` | a long random password | likewise |
| `VAULT_KEY` | your 64-hex key | **the same one as local**, or stored passwords are unreadable |
| `LLM_API_KEY` | the Groq key | content generation |
| `LLM_MODEL` | `openai/gpt-oss-120b` | the default model name is retired |
| `LLM_REASONING_EFFORT` | `low` | reasoning models otherwise spend the token budget thinking |
| `HEADLESS` | `true` | there is no screen |
| `WEB_HOST` | `0.0.0.0` | already set in the Dockerfile |

Optional: `SERPER_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `OPERATOR_WHATSAPP`,
`TAPIFY_WA_ENDPOINT`, `INDEXNOW_KEY`.

`PORT` is supplied by Railway and the server uses it automatically.

**The server refuses to start on a public address without `WEB_USER` and
`WEB_PASSWORD`.** That is deliberate: on a laptop, "only reachable from this
machine" was the entire protection. Hosted, it is gone.

### 4. Generate a domain

Settings → Networking → Generate Domain. Open it, sign in with the credentials
above, and the UI is there.

**Start commands avoid npm on purpose.** The base image ships an npm built for
its own Node, and running that under the Node 24 we install produces
`Class extends value undefined is not a constructor or null`. The build removes
the stale copy, but nothing at runtime should depend on npm being healthy.

In the Console, use the same form:

```bash
node node_modules/tsx/dist/cli.mjs src/cli.ts <command>
```

### 5. Seed the database on first run

The volume starts empty. From Railway's shell, or locally against the same
volume:

```bash
node node_modules/tsx/dist/cli.mjs src/cli.ts db init
node node_modules/tsx/dist/cli.mjs src/cli.ts discover seed
node node_modules/tsx/dist/cli.mjs src/cli.ts vet run --limit 40 --judge
```

### 6. Schedule the runs

The point of this step is that your team logs in each morning and finds work
waiting, instead of someone having to run a command to create it.

Add a **second service** in the same project:

| Setting | Value |
|---|---|
| Source | the same GitHub repo |
| Custom Start Command | `node node_modules/tsx/dist/cli.mjs src/cli.ts daily` |
| Cron Schedule | `0 5 * * *` (05:00 UTC, ~10:30 IST) |
| Volume | the same one, mounted at `/app/data` |
| Variables | the same set as the web service |

Then a **third** for the weekly re-check of every link ever built:

| Setting | Value |
|---|---|
| Custom Start Command | `node node_modules/tsx/dist/cli.mjs src/cli.ts weekly` |
| Cron Schedule | `0 4 * * 0` (Sundays) |
| Volume | the same, at `/app/data` |

Railway starts the container, the command runs, the container exits — which is
exactly how `daily` and `weekly` already behave, so nothing else is needed.

**All three services must share one volume.** They are one installation; give
them separate volumes and the cron jobs write content the web UI cannot see.

Do not use `scripts/install-schedule.ps1` here; that is for a Windows PC.

What the daily job does: tops up content for each type, submits what is ready
within quota, exports the manual queue, verifies what was sent, refreshes the
reports, and alerts on anything lost. A failing step does not stop the rest —
if generation fails on an LLM quota, yesterday's links still get verified.

---

## What changes when it is hosted

### Assist Mode stops working

This is the real cost, and it is not fixable with configuration.

When a platform shows a CAPTCHA, an OTP or a login wall, the agent opens a
browser window and waits for a person to deal with it. On Railway there is no
screen and nobody to look at it.

With `HEADLESS=true` the agent now recognises this and gives up at once,
recording the submission as needing a human rather than waiting ten minutes for
somebody who will never arrive. Before that, a single stuck platform could burn
ten minutes of a cron run, and several could consume the whole thing.

What that means in practice: **only platforms needing no human step can be
automated from Railway.** Everything else has to be either done locally or
routed to the manual queue, which is already how the valuable platforms
(dev.to, WordPress, Reddit, the phone-verified directories) work anyway.

A sensible split, and the one I would run:

- **Railway**: verification, reports, the dashboard, the web UI, the daily
  schedule for platforms that need no login.
- **Your PC**: the first submission to any new platform, where a human can
  clear the challenge once. The session profile persists in the volume
  afterwards — but only if both are using the same volume, which they are not.
  In practice this means accepting a smaller automated set on Railway.

### Everything else carries over

Verification, discovery, vetting, the judge, content generation, the reports and
the web UI all work unchanged, because none of them needs a person watching.

---

## Costs worth knowing

- Railway bills for the container running. The web UI is a long-running service,
  so it bills continuously; the cron services only while they execute.
- The Playwright image is large (~1.5 GB). Build minutes and image storage count.
- If you only want the **dashboard** visible to a client, that is a static file
  and `npm run dashboard:publish` plus Vercel costs nothing. You do not need
  Railway for that.

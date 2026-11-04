# Getting started

The ordered path from "built" to "producing verified backlinks". Each step says
what it unlocks and how to confirm it worked.

Run `npm run doctor` at any point — it reports exactly which of these are done.

The goal to aim at is **one verified live backlink produced by the agent**.
Everything before that is setup; everything after it is volume.

---

## 0. Back up the vault key — do this first

`.env` already contains a generated `VAULT_KEY`. Every platform password the
agent stores is encrypted with it.

Right now nothing is encrypted with it, so it can still be replaced freely. Once
the agent creates its first account, losing that key means losing every stored
password with no way back. Copy the line somewhere safe — a password manager,
not another spreadsheet.

---

## 1. The Groq key — the one that unlocks the most

```
LLM_API_KEY=gsk_...
```

From [console.groq.com/keys](https://console.groq.com/keys). Paste it into `.env`.

**Unlocks three things at once:**

- Real content instead of template placeholder text (which the submitter refuses
  to send, by design).
- The **link-farm judge**, which is what demotes the platforms that currently sit
  at the top of your catalog on mechanical score alone.
- The LLM fallback in the form filler, for submission forms the keyword
  heuristic cannot map.

Confirm:

```bash
npm run llm:ping
```

It should print `ok`. If it returns 404, the model name has been retired — set
`LLM_MODEL` in `.env` to a current one from Groq's model list. The error message
says so explicitly when it happens.

---

## 2. Re-vet with the judge

```bash
npm run vet -- --revet --limit 40 --judge
```

Now that the LLM is available, this re-reads each platform's published item
titles and rules on whether anyone exercises editorial control there.

Expect `social-bookmarkingsites.com` to drop. It scores 90 for submittability and
publishes beard transplants, nautical-science colleges and Middle East billing
software side by side. A confident "farm" verdict is a rejection no score can
override.

Confirm:

```bash
npm run catalog -- stats
```

---

## 3. The facts — this one needs the client, not you

`config/clients/eeetechnologies.json` → `content.facts` is an empty array, and
it is the **only** source of specifics the writer is permitted to state about the
business. While it is empty, the prompt instructs the model to say nothing
specific at all and write about the subject instead.

Ask EEE Technologies for:

- course durations and batch sizes
- modes offered (classroom, online, hybrid)
- certification, if any
- what placement support actually consists of — described, not quantified, unless
  they have a figure they can stand behind
- years in operation
- trainer background

`content.forbidden` already blocks placement percentages, fees, student counts
and testimonials. That is deliberate: inventing a placement rate puts a false
claim on the public internet under your client's name. It is a liability, not a
ranking.

**This is the single biggest lever on article quality.** Everything else is
plumbing.

---

## 4. Deep link targets

Every keyword in the config currently points at `https://eeetechnologies.in`.

```json
{
  "keyword": "Data Analysis Course in Nagpur",
  "targetUrl": "https://eeetechnologies.in/data-analysis-course"
}
```

A link to the page that answers the query is worth considerably more than another
homepage link, and the anchor then matches where it leads. If those pages do not
exist yet, that is an on-page job worth doing before pointing links at them.

---

## 5. First content, then your approval

```bash
npm run generate -- --type bookmarking
npm run content -- pending
npm run content -- show <id>
npm run content -- approve <id>
```

Bookmarks, profiles and directory listings auto-submit. **Blog articles wait for
you** — that is the locked decision, and worth keeping for the first month at
least. Read one article in full before approving it; you are the only check on
whether it reads like something a person would publish.

---

## 6. The first submission — watch this one

```bash
# .env
HEADLESS=false
```

```bash
npm run submit -- plan
npm run submit -- run -n 1
```

Only `telegraph` is an API adapter with nothing to break. `justpaste`, `writeas`
and the generic form filler are marked `untested`: their selectors were written
from each platform's structure without seeing the live DOM, which makes them
hypotheses. Watch the first run of each so a wrong guess is visible rather than
silent.

If a CAPTCHA or sign-in appears, Assist Mode pauses and waits for you — the
window is already open on the right page. The session persists, so that is
**once per platform, not once per link**.

---

## 7. Prove it

```bash
npm run verify
npm run report:links
```

When `verified live` goes from 1 to 2, the agent has produced its first real
backlink. That is the milestone.

---

## 8. Google Sheets — when you want the sheet to fill itself

Five minutes in Google Cloud Console: [SETUP-GOOGLE.md](SETUP-GOOGLE.md).

```bash
npm run sync                      # read the team's tracker (read-only)
npm run sheet:create              # the agent's own sheet, shared with you
npm run sheet:push                # fill it
```

Note `SHEET_SHARE_WITH` — a service account has its own Drive you cannot see, so
without it the sheet exists and is invisible to you.

---

## 9. Optional: a search key

```
SEARCH_PROVIDER=serper
SERPER_API_KEY=...
```

Needed only to find platforms beyond the 37 curated ones, and to check whether a
backlink page is indexed. Without it, discovery is limited to the seed catalog —
which is enough to start.

```bash
npm run discover -- --type blog --queries 4 --expand-lists
```

---

## 10. Alerts, then the schedule

```
OPERATOR_WHATSAPP=...
TAPIFY_WA_ENDPOINT=...
```

Without these, a lost link is logged to a console nobody is reading.

```bash
npm run doctor            # must show 0 blocking
npm run daily -- --dry-run
```

Then, in PowerShell:

```powershell
.\scripts\install-schedule.ps1
```

Daily 10:30, weekly Sunday 09:00, logging to `data/schedule.log`. The tasks run
visibly and as you, because Assist Mode needs someone who can see the window.

---

## What to expect in month one

Honest numbers, not a pitch:

- Roughly 8 submissions a day is the configured ceiling, and most days will be
  fewer because content and vetted platforms run out first.
- A meaningful share of submissions never become verified links: bookmarking and
  directory sites moderate, and some quietly drop submissions. The report counts
  what survived, not what was sent.
- Eight of your existing links cannot be machine-verified at all (Substack,
  Flipboard, Padlet, Diigo, start.me return 403). Those need `verify --session`
  with `HEADLESS=false` on a machine where you are signed in, or a human glance.
- The categories that move rankings are blog, profile and genuine directory
  listings. Bookmarking volume is cheap and close to worthless; the agent builds
  it because the sheet has a tab for it, and scores sites so effort concentrates
  where links count.

# Using the SEO agent — for the team

**Open:** https://seo-agent-production-4d23.up.railway.app

Sign in with the username and password your manager gives you. It works in any
browser, on a phone too.

You do not install anything and you do not run any commands. Everything you need
is on that page.

---

## What the agent does, and what you do

The agent finds platforms, writes the posts, and afterwards checks whether each
link is really live. It cannot do two things, and those two are your job:

1. **Decide whether an article is good enough to publish.**
2. **Post to the platforms that refuse automated posting** — Reddit, dev.to,
   WordPress, Justdial and similar. They block robots on purpose. The agent
   writes the post and hands it to you ready to paste.

---

## Your two daily jobs

### 1. Approvals

The **Approvals** tab shows a number when something is waiting.

Click an article in the left list and read it on the right. The link to the
client's website is highlighted so you can see where it sits.

Ask yourself:

- Does it read like something a person would publish? If it reads like filler,
  reject it.
- Does it say anything the client has not confirmed — a fee, a placement rate,
  a number of students, a promise? **Reject it.** The agent is told never to
  invent those, but you are the last check.
- Does the highlighted link sit naturally in the sentence, or does it look
  bolted on?

Then click **Approve** or **Reject**. Approving means it may be published.
Rejecting costs nothing; another one gets written.

If **Approve** is greyed out, the text is a placeholder draft and cannot be
published. Tell your manager.

### 2. Manual queue

The **Manual queue** tab is posts that a person has to publish.

For each one:

1. **Copy title** and **Copy body** — the buttons put them on your clipboard.
2. Click the platform link to open it, and post there, signed in as the client.
3. Copy the URL of the page you just created.
4. Paste it into the **"Paste the URL you posted it at"** box and click
   **Record**.

Step 4 matters more than it looks. Recording the URL is what lets the agent
check the link later. A post that nobody records is work nobody can prove, and
that is exactly the problem this tool was built to fix.

**Read the platform note on each card before posting.** Reddit removes
promotional posts from new accounts. dev.to removes thin posts. Justdial needs
phone verification once. The note tells you what matters on that platform.

---

## Adding a client (managers)

**Clients** tab → fill in the website, city, what they do, up to four keywords
and the facts the writer may state → **Add client**.

It is stored in the database, not in a file, so it survives a redeploy. Switch
between clients by adding `?client=<id>` to the address.

The **verified facts** box is the one that matters. It is the only source of
specifics the writer may state about the business — leave it empty and every
article stays general, because the writer is forbidden from inventing anything.

## The other tabs, briefly

| Tab | What it tells you |
|---|---|
| **Overview** | how many links are verified live, waiting, or lost; how much content is waiting for approval |
| **Ready to send** | what the agent will publish by itself next |
| **Links** | every link ever submitted and whether it is really live |
| **Catalog** | every platform, scored. You can mark one rejected if you know it is rubbish |

---

## What the words mean

The same list is printed above the Links table in the panel, so you never have
to remember it.

| Word | Meaning | Whose move |
|---|---|---|
| **live** | checked: the link really is on that page. The only number that counts. | nobody's — done |
| **waiting** | posted, not yet confirmed. Many platforms moderate for days. | nobody's — wait |
| **you post it** | the platform blocks robots. It is in your Manual queue. | **yours** |
| **needs sign-in** | the platform wants a login the agent cannot do. | **yours** |
| **failed** | the agent could not post it. It tries again by itself. | nobody's |
| **removed** | it was live, and the platform took it down. | nobody's |
| **no URL** | posted, but nobody saved the URL, so it can never be checked. | avoid this |
| **platform blocked the check** | the site refused our checker. Nobody knows either way; not a failure. | nobody's |
| **text mention, not a link** | the client's address appears as plain text with no link. Worth nothing. | nobody's |

---

## Things to tell your manager, not fix yourself

- An article claims something specific about the client that you cannot verify.
- **Approve** is greyed out.
- The Manual queue is empty for days, or the same item keeps coming back.
- A platform keeps rejecting your posts.
- You get an error on the page, or it will not load.

---

## What this replaces

A spreadsheet where "Approved" meant somebody typed the word Approved. When it
was checked properly, **22 of 40 rows had no link at all**, and 15 of those were
marked Approved.

That is why Record matters, and why "verified live" is the only number anyone
should quote to a client.

# Google Sheets access

The agent reads the team's manual tracker and writes its own sheet. Both go
through a **service account** — a robot Google account with its own key file.
Not OAuth: the agent runs unattended on a schedule, and a human refresh token
expires and needs a browser to renew.

Takes about five minutes, once.

---

## 1. Create the project and service account

1. Open [console.cloud.google.com](https://console.cloud.google.com/).
2. Create a project (or reuse one). Name it anything — `tapify-seo-agent`.
3. **APIs & Services → Library**: enable **Google Sheets API** and
   **Google Drive API**. Both, not just Sheets — the Drive API is what lets the
   agent create a new sheet and share it with you.
4. **APIs & Services → Credentials → Create credentials → Service account**.
   Name it `seo-agent`. Skip the optional role and access steps.
5. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A file downloads.

## 2. Put the key where the agent looks

```bash
mkdir -p secrets
```

Move the downloaded JSON to `secrets/service-account.json`.

`secrets/` is gitignored. Do not commit the key, and do not paste it into a
chat or a sheet — it is a password for your Google project.

In `.env`:

```
GOOGLE_SERVICE_ACCOUNT_JSON=./secrets/service-account.json
```

## 3. Share the sheets with the robot

Open `secrets/service-account.json` and copy the `client_email` value. It looks
like `seo-agent@tapify-seo-agent.iam.gserviceaccount.com`.

- **The team's manual tracker** → Share → add that email as **Viewer**.
  Viewer, not Editor: the agent must not be able to write there even by mistake.
- **The agent's own sheet** is created by the agent and needs no sharing step.

Then set the source sheet id in `.env` (the long id in the sheet's URL):

```
SOURCE_SHEET_ID=1twdRsEZF7P-aH8Ku7BB1YWSuZUo5LBSjzxEhhBCuWGA
```

## 4. Tell it who to share the new sheet with

A service account has its own Drive that **you cannot see**. A sheet it creates
is invisible to you until it is shared. Set your own Google address:

```
SHEET_SHARE_WITH=you@example.com
```

Then:

```bash
npm run sheet:create -- --client eeetechnologies
```

The command prints the URL and stores the id. Paste that id into
`config/clients/eeetechnologies.json` as `agentSheetId` so it survives a
database reset.

---

## Troubleshooting

**`403` / "The caller does not have permission"**
The sheet was not shared with the service account, or the Drive API is not
enabled. Check both — step 3 and step 1.4.

**`404` / "Requested entity was not found"**
Wrong sheet id, or the id of a sheet the service account cannot see.

**The sheet was created but you cannot find it**
`SHEET_SHARE_WITH` was empty. Re-run `sheet:create`, or share it manually from
the Drive of the service account — which you cannot open, so re-running is
easier. Delete the orphan sheet afterwards.

**"Service-account key not found"**
The path in `GOOGLE_SERVICE_ACCOUNT_JSON` is relative to the project root, not
to wherever you ran the command from.

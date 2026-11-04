#!/usr/bin/env tsx
/**
 * seo-ai-agent CLI.
 *
 * Phase 0 commands: schema, client registration, tracker import, sheet pull and
 * push, the data-quality audit, and an LLM connectivity check. Discovery,
 * generation, submission and verification arrive in later phases as their own
 * subcommands.
 */

import { Command } from 'commander';
import 'dotenv/config';
import { closeDb, initSchema, startRun } from './db/index.ts';
import { listClientIds, loadClientConfig, env } from './config.ts';
import { importSnapshot } from './import/snapshot.ts';
import { importRows } from './import/rows.ts';
import { pullSourceSheet, saveSnapshot } from './sheets/source.ts';
import { createAgentSheet, pushClient } from './sheets/agentSheet.ts';
import { auditClient, printAudit } from './report/audit.ts';
import { ping } from './llm/index.ts';
import { vaultReady } from './util/vault.ts';
import { log } from './util/log.ts';
import { seedCatalog } from './discovery/seed.ts';
import { addManual, harvest, harvestHistory } from './discovery/harvest.ts';
import { vetOne, vetPending } from './vetting/vet.ts';
import { catalogStats, listSites, printList, setSiteStatus, showSite } from './catalog/index.ts';
import { generateBatch, suggestSite } from './content/index.ts';
import { listPending, printPending, setApproval, showContent } from './content/approval.ts';
import { printMix } from './content/anchors.ts';
import { llmAvailable } from './content/writer.ts';
import { quotaReport, runBatch, pickWork } from './submit/runner.ts';
import { exportManualQueue, recordManualResult } from './submit/manual.ts';
import { printSelfTest, runSelfTest } from './submit/selftest.ts';
import { listAdapters, adapterFor } from './submit/adapters/index.ts';
import { writeContinue } from './submit/assist.ts';
import { findAccount, reveal } from './submit/accounts.ts';
import { get as dbGet } from './db/index.ts';
import { runVerification, verifyById } from './verify/index.ts';
import { buildLinkReport, printLinkReport } from './report/links.ts';
import { indexationReport, logIndexNow, submitToIndexNow } from './indexing/indexnow.ts';
import { printPipeline, runDaily, runForAll, runWeekly } from './schedule/pipeline.ts';
import { printDoctor, runDoctor } from './report/doctor.ts';
import { startWeb } from './web/server.ts';
import { writeDashboard } from './report/dashboard.ts';
import type { SubmissionType } from './config.ts';

const SUBMISSION_TYPES = [
  'bookmarking',
  'profile',
  'blog',
  'mindmap',
  'ppt',
  'ping',
  'pdf',
  'directory',
  'image',
] as const;

function parseType(value: string): SubmissionType {
  const t = value.trim().toLowerCase();
  if (!(SUBMISSION_TYPES as readonly string[]).includes(t)) {
    throw new Error(`Unknown type "${value}". One of: ${SUBMISSION_TYPES.join(', ')}`);
  }
  return t as SubmissionType;
}

const program = new Command();
program
  .name('seo-ai-agent')
  .description('Off-page SEO agent — discovery, submission, verification, sheet sync')
  .version('0.1.0');

/** Resolves --client, defaulting when exactly one client is configured. */
function resolveClient(id?: string) {
  const ids = listClientIds();
  if (!id) {
    if (ids.length === 1) return loadClientConfig(ids[0]!);
    throw new Error(
      `--client is required. Configured clients: ${ids.join(', ') || '(none in config/clients/)'}`,
    );
  }
  return loadClientConfig(id);
}

// ── db ───────────────────────────────────────────────────────────────────────
const db = program.command('db').description('database maintenance');

db.command('init')
  .description('create or update the SQLite schema')
  .action(() => {
    initSchema();
    if (!vaultReady()) {
      log.warn('VAULT_KEY is not set — passwords cannot be stored yet. See .env.example.');
    }
  });

// ── client ───────────────────────────────────────────────────────────────────
const client = program.command('client').description('client registration');

client
  .command('list')
  .description('list configured clients')
  .action(() => {
    const ids = listClientIds();
    if (!ids.length) {
      console.log('No clients. Add one as config/clients/<id>.json');
      return;
    }
    for (const id of ids) {
      const cfg = loadClientConfig(id);
      console.log(`${id.padEnd(20)} ${cfg.siteUrl}  (${cfg.keywords.length} keywords)`);
    }
  });

client
  .command('add')
  .description('register a client (and its keywords) from its config file')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const stats = importRows(cfg, [], { plaintextPasswords: false });
    log.info(`registered ${cfg.id} with ${cfg.keywords.length} keywords`);
    log.debug(stats);
  });

// ── import ───────────────────────────────────────────────────────────────────
const imp = program.command('import').description('bring existing data in');

imp
  .command('snapshot')
  .description('import a redacted snapshot file (works without Google credentials)')
  .option('-c, --client <id>', 'client id')
  .option('-f, --file <path>', 'snapshot path (defaults to the newest for the client)')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const run_ = startRun('import', cfg.id);
    try {
      const stats = importSnapshot(cfg, opts.file);
      run_.finish(stats);
      log.heading('Import');
      console.table([stats]);
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

// ── sheet ────────────────────────────────────────────────────────────────────
const sheet = program.command('sheet').description('Google Sheets sync');

sheet
  .command('pull')
  .description("read the team's manual tracker (read-only) and import it")
  .option('-c, --client <id>', 'client id')
  .option('--snapshot-only', 'write the snapshot file without importing')
  .action(async (opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const sheetId = cfg.sourceSheetId || env.sourceSheetId;
    if (!sheetId) throw new Error('No source sheet id — set it in the client config or SOURCE_SHEET_ID.');

    const run_ = startRun('pull', cfg.id);
    try {
      const pull = await pullSourceSheet(sheetId);
      const path = saveSnapshot(cfg.id, pull);
      if (opts.snapshotOnly) {
        run_.finish({ rows: pull.rows.length, path });
        return;
      }
      // Live pull carries real passwords: encrypt them into the vault.
      const stats = importRows(cfg, pull.rows, { plaintextPasswords: true });
      run_.finish({ ...stats, path });
      log.heading('Pull');
      console.table([stats]);
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

sheet
  .command('create')
  .description("create the agent's own sheet and share it with you")
  .option('-c, --client <id>', 'client id')
  .action(async (opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const id = await createAgentSheet(cfg.id, cfg.name);
    console.log(`\nAgent sheet: https://docs.google.com/spreadsheets/d/${id}/edit`);
    console.log(`Add it to config/clients/${cfg.id}.json as "agentSheetId", or to .env as AGENT_SHEET_ID.\n`);
  });

sheet
  .command('push')
  .description("write the database into the agent's sheet")
  .option('-c, --client <id>', 'client id')
  .action(async (opts) => {
    const cfg = resolveClient(opts.client);
    const run_ = startRun('push', cfg.id);
    try {
      const out = await pushClient(cfg.id);
      run_.finish(out);
      console.log(`\nhttps://docs.google.com/spreadsheets/d/${out.sheetId}/edit\n`);
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

// ── report ───────────────────────────────────────────────────────────────────
const report = program.command('report').description('reports');

report
  .command('dashboard')
  .description('write the HTML dashboard')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const path = writeDashboard(cfg);
    console.log(`
  open: ${path}
`);
  });

report
  .command('links')
  .description('what the client actually has, backed by verifications')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    printLinkReport(buildLinkReport(cfg.id));
  });

report
  .command('audit')
  .description('data-quality audit over the imported tracker')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    printAudit(auditClient(cfg.id));
  });

// ── discover ─────────────────────────────────────────────────────────────────
const discover = program.command('discover').description('find submission sites');

discover
  .command('seed')
  .description('load the curated catalog (no search API key needed)')
  .action(() => {
    initSchema();
    const stats = seedCatalog();
    console.table([stats]);
  });

discover
  .command('run')
  .description('search for new candidate sites')
  .requiredOption('-t, --type <type>', `submission type (${SUBMISSION_TYPES.join('|')})`)
  .option('-c, --client <id>', 'client id')
  .option('-q, --queries <n>', 'how many footprints to search', '4')
  .option('-n, --per-query <n>', 'results per search', '20')
  .option('--expand-lists', 'mine "top N sites" listicles for candidates', false)
  .option('--provider <id>', 'serper | google_cse | brave')
  .option('--fresh-days <n>', 'skip a footprint searched in the last N days', '7')
  .option('--dry-run', 'print the queries without spending quota', false)
  .action(async (opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const run_ = startRun('discover', cfg.id);
    try {
      const stats = await harvest(cfg, {
        type: parseType(opts.type),
        maxQueries: Number(opts.queries),
        perQuery: Number(opts.perQuery),
        expandLists: Boolean(opts.expandLists),
        provider: opts.provider,
        freshDays: Number(opts.freshDays),
        dryRun: Boolean(opts.dryRun),
      });
      run_.finish(stats);
      if (!opts.dryRun) {
        log.heading('Discovery');
        console.table([stats]);
        console.log('Next: npm run vet -- --type ' + opts.type + '\n');
      }
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

discover
  .command('add')
  .description('add one site to the catalog by hand')
  .argument('<url>', 'site URL or domain')
  .requiredOption('-t, --type <type>', 'submission type')
  .action((url: string, opts) => {
    initSchema();
    const out = addManual(url, parseType(opts.type));
    log.info(`${out.domain} → ${out.outcome}`);
  });

discover
  .command('history')
  .description('what discovery has searched lately')
  .option('-n, --limit <n>', 'rows', '20')
  .action((opts) => {
    initSchema();
    const rows = harvestHistory(Number(opts.limit));
    if (!rows.length) {
      console.log('No searches yet.');
      return;
    }
    for (const r of rows) {
      console.log(
        `${r.ran_at}  ${r.type.padEnd(12)} ${r.provider.padEnd(11)} ` +
          (r.error ? `ERROR ${r.error.slice(0, 60)}` : `${r.results} results, ${r.new_sites} new`) +
          `\n    ${r.query}`,
      );
    }
  });

// ── vet ──────────────────────────────────────────────────────────────────────
const vet = program.command('vet').description('score candidate sites');

vet
  .command('run', { isDefault: true })
  .description('vet unvetted candidates')
  .option('-t, --type <type>', 'restrict to one submission type')
  .option('-n, --limit <n>', 'how many sites', '25')
  .option('--concurrency <n>', 'parallel hosts', '4')
  .option('--revet', 'include sites already vetted', false)
  .option('--include-rejected', 'also re-vet rejected sites', false)
  .option('--check-index', 'spend one search call per site to confirm it is indexed', false)
  .option('--judge', 'spend one LLM call per site to judge editorial control', false)
  .action(async (opts) => {
    initSchema();
    const run_ = startRun('vet');
    try {
      const outcomes = await vetPending({
        type: opts.type ? parseType(opts.type) : undefined,
        limit: Number(opts.limit),
        concurrency: Number(opts.concurrency),
        revet: Boolean(opts.revet),
        includeRejected: Boolean(opts.includeRejected),
        checkIndex: Boolean(opts.checkIndex),
        judge: Boolean(opts.judge),
      });
      const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.status] = (acc[o.status] ?? 0) + 1;
        return acc;
      }, {});
      run_.finish({ checked: outcomes.length, ...tally });
      log.heading('Vetting done');
      console.log(`  checked ${outcomes.length}`);
      for (const [status, n] of Object.entries(tally)) console.log(`  ${status.padEnd(10)} ${n}`);
      console.log('\n  rejected is permanent; blocked and marginal stay eligible for another pass.');
      console.log('  npm run catalog -- stats\n');
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

vet
  .command('one')
  .description('vet a single domain')
  .argument('<domain>')
  .option('--check-index', 'also confirm it is indexed', false)
  .option('--judge', 'also judge editorial control with the LLM', false)
  .action(async (domain: string, opts) => {
    initSchema();
    await vetOne(domain, { checkIndex: Boolean(opts.checkIndex), judge: Boolean(opts.judge) });
    showSite(domain);
  });

// ── catalog ──────────────────────────────────────────────────────────────────
const catalog = program.command('catalog').description('browse the site catalog');

catalog
  .command('list', { isDefault: true })
  .description('list catalog entries')
  .option('-t, --type <type>', 'submission type')
  .option('-s, --status <status>', 'candidate | vetted | rejected | active | blocked | dead')
  .option('--min-score <n>', 'minimum score')
  .option('-n, --limit <n>', 'rows', '50')
  .action((opts) => {
    initSchema();
    printList(
      listSites({
        type: opts.type ? parseType(opts.type) : undefined,
        status: opts.status,
        minScore: opts.minScore === undefined ? undefined : Number(opts.minScore),
        limit: Number(opts.limit),
      }),
    );
  });

catalog
  .command('show')
  .description('everything known about one site')
  .argument('<domain>')
  .action((domain: string) => {
    initSchema();
    showSite(domain);
  });

catalog
  .command('stats')
  .description('catalog summary')
  .action(() => {
    initSchema();
    catalogStats();
  });

catalog
  .command('reject')
  .description('reject a site by hand')
  .argument('<domain>')
  .option('-r, --reason <text>', 'why', 'manual')
  .action((domain: string, opts) => {
    initSchema();
    setSiteStatus(domain, 'rejected', opts.reason);
  });

catalog
  .command('activate')
  .description('mark a vetted site as in use')
  .argument('<domain>')
  .action((domain: string) => {
    initSchema();
    setSiteStatus(domain, 'active');
  });

// ── content ──────────────────────────────────────────────────────────────────
const content = program.command('content').description('generate and approve content');

content
  .command('generate', { isDefault: true })
  .description('write assets for a submission type')
  .requiredOption('-t, --type <type>', `submission type (${SUBMISSION_TYPES.join('|')})`)
  .option('-c, --client <id>', 'client id')
  .option('-k, --keyword <text>', 'keyword (defaults to the one with the fewest assets)')
  .option('-s, --site <domain>', 'platform this asset is for (defaults to the best unused one)')
  .option('--any-site', 'do not tie the asset to a platform', false)
  .option('-n, --count <n>', 'how many to write', '1')
  .option('--anchor <kind>', 'force an anchor kind: exact | partial | branded | naked')
  .action(async (opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const type = parseType(opts.type);

    if (!llmAvailable()) {
      log.warn(
        'No LLM_API_KEY set. Output will be TEMPLATE structure, held in the approval ' +
          'queue and refused by the submission engine. Useful for testing the pipeline only.',
      );
    }

    let site: string | undefined = opts.site;
    if (!site && !opts.anySite) {
      site = suggestSite(cfg.id, type) ?? undefined;
      if (site) log.info(`targeting ${site} (best unused ${type} site)`);
      else log.warn(`no vetted ${type} site available — writing untargeted copy`);
    }

    const run_ = startRun('generate', cfg.id);
    try {
      const results = await generateBatch(cfg, {
        type,
        keyword: opts.keyword,
        siteDomain: site,
        anchorKind: opts.anchor,
        count: Number(opts.count),
      });
      run_.finish({ written: results.length });

      const pending = results.filter((r) => r.approval === 'pending').length;
      log.heading('Written');
      for (const r of results) {
        console.log(`  #${r.contentId}  ${r.title}`);
        for (const f of r.files) console.log(`      ${f}`);
      }
      if (pending) console.log(`
  ${pending} waiting for approval: npm run content -- pending
`);
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

content
  .command('pending')
  .description('what is waiting for approval')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    printPending(listPending(cfg.id));
  });

content
  .command('show')
  .description('read one content item in full')
  .argument('<id>')
  .action((id: string) => {
    initSchema();
    showContent(Number(id));
  });

content
  .command('approve')
  .description('approve a content item for submission')
  .argument('<id>')
  .action((id: string) => {
    initSchema();
    setApproval(Number(id), 'approved');
  });

content
  .command('reject')
  .description('reject a content item')
  .argument('<id>')
  .option('-r, --reason <text>', 'why')
  .action((id: string, opts) => {
    initSchema();
    setApproval(Number(id), 'rejected', opts.reason);
  });

content
  .command('anchors')
  .description('anchor-text distribution against target')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    printMix(cfg.id);
  });

// ── submit ───────────────────────────────────────────────────────────────────
const submit = program.command('submit').description('send content to platforms');

submit
  .command('run', { isDefault: true })
  .description('submit what is ready, respecting quotas and pacing')
  .option('-c, --client <id>', 'client id')
  .option('-t, --type <type>', 'restrict to one submission type')
  .option('-n, --limit <n>', 'maximum submissions this run', '3')
  .option('--dry-run', 'show what would be sent and stop', false)
  .option('--no-pacing', 'skip the wait between submissions (testing only)')
  .action(async (opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const run_ = startRun('submit', cfg.id);
    try {
      const stats = await runBatch(cfg, {
        type: opts.type ? parseType(opts.type) : undefined,
        limit: Number(opts.limit),
        dryRun: Boolean(opts.dryRun),
        ignorePacing: opts.pacing === false,
      });
      run_.finish(stats);
      if (!opts.dryRun && stats.attempted) {
        log.heading('Submission run');
        console.log(`  attempted ${stats.attempted}`);
        console.log(`  submitted ${stats.submitted}`);
        console.log(`  needs a human ${stats.needsAssist}`);
        console.log(`  failed ${stats.failed}`);
        console.log('\n  Nothing is "verified" yet — that is Phase 4.\n');
      }
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

submit
  .command('plan')
  .description("what is ready to go out, and today's quota")
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const q = quotaReport(cfg);

    log.heading("Today's quota");
    console.log(`  used ${q.totalUsed}, ${q.totalLeft} left, ${q.minutesBetween} min between sends`);
    for (const t of q.byType) {
      console.log(`    ${t.type.padEnd(12)} ${t.used}/${t.limit}`);
    }

    const work = pickWork(cfg, { limit: 50 });
    log.heading(`Ready to submit: ${work.length}`);
    for (const w of work) {
      const adapter = adapterFor(w.siteDomain, w.siteAdapter);
      console.log(
        `  ${w.siteDomain.padEnd(26)} ${w.type.padEnd(12)} #${String(w.contentId).padEnd(4)} ` +
          `${adapter.id}${adapter.confidence === 'untested' ? ' (untested)' : ''}`,
      );
    }
    console.log('');
  });

submit
  .command('manual')
  .description('export the brief for platforms a human must post to')
  .option('-c, --client <id>', 'client id')
  .option('-n, --limit <n>', 'maximum items', '20')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const out = exportManualQueue(cfg, Number(opts.limit));
    console.log(`
  ${out.items} item(s) → ${out.path}
`);
  });

submit
  .command('record')
  .description('record the URL a human posted, so it gets verified')
  .argument('<submissionId>')
  .argument('<url>')
  .option('-o, --operator <name>', 'who posted it')
  .action((id: string, url: string, opts) => {
    initSchema();
    recordManualResult(Number(id), url, opts.operator);
  });

submit
  .command('selftest')
  .description('run the form filler against a local fixture — nothing is published')
  .action(async () => {
    const result = await runSelfTest();
    printSelfTest(result);
    if (!result.ok) process.exitCode = 1;
  });

submit
  .command('adapters')
  .description('which platforms have a hand-written adapter')
  .action(() => {
    log.heading('Adapters');
    for (const a of listAdapters()) {
      console.log(
        `  ${a.id.padEnd(12)} ${a.confidence.padEnd(10)}${a.apiOnly ? 'api    ' : 'browser'}  ` +
          `${a.requiresAccount ? 'account' : 'no account'}  ${a.categories.join(',')}`,
      );
    }
    console.log(
      '\n  untested = selectors written from the platform structure, not yet watched\n' +
        '  working. Run the first submission to such a site with HEADLESS=false.\n',
    );
  });

submit
  .command('continue')
  .description('tell a waiting Assist Mode session to carry on')
  .argument('<domain>')
  .action((domain: string) => {
    console.log(`wrote ${writeContinue(domain)}`);
  });

// ── account ──────────────────────────────────────────────────────────────────
const account = program.command('account').description('platform credentials');

account
  .command('password')
  .description('print the stored password for one site (for Assist Mode)')
  .argument('<domain>')
  .option('-c, --client <id>', 'client id')
  .action((domain: string, opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const site = dbGet<{ id: number }>(
      'SELECT id FROM sites WHERE domain = ?',
      domain.replace(/^www\./, ''),
    );
    if (!site) throw new Error(`${domain} is not in the catalog.`);
    const row = findAccount(cfg.id, site.id);
    if (!row) throw new Error(`No account stored for ${domain}.`);
    console.log(`username: ${row.username}`);
    console.log(`email:    ${row.email ?? '-'}`);
    console.log(`password: ${reveal(row)}`);
    console.log('\nShown so you can finish a sign-in by hand. It is not written to any sheet.');
  });

// ── verify ───────────────────────────────────────────────────────────────────
const verify = program.command('verify').description('prove the links are real');

verify
  .command('run', { isDefault: true })
  .description('check submitted URLs for the client link')
  .option('-c, --client <id>', 'client id')
  .option('-n, --limit <n>', 'how many URLs', '25')
  .option('--concurrency <n>', 'parallel hosts', '3')
  .option('--deep', 'always render with a browser, not just as a fallback', false)
  .option('--check-index', 'also check each page is in the search index', false)
  .option('--resweep', 'include links already marked lost', false)
  .option('--session', 'render through the persistent browser profile (for 403 platforms)', false)
  .action(async (opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const run_ = startRun('verify', cfg.id);
    try {
      const stats = await runVerification(cfg, {
        limit: Number(opts.limit),
        concurrency: Number(opts.concurrency),
        deep: Boolean(opts.deep),
        checkIndex: Boolean(opts.checkIndex),
        resweep: Boolean(opts.resweep),
        useSession: Boolean(opts.session),
      });
      run_.finish(stats);
      log.heading('Verification');
      console.log(`  checked ................ ${stats.checked}`);
      console.log(`  verified live .......... ${stats.verified}`);
      console.log(`  lost ................... ${stats.lost}`);
      console.log(`  waiting on moderation .. ${stats.waiting}`);
      console.log(`  could not tell ......... ${stats.inconclusive}`);
      console.log(`  text mentions only ..... ${stats.mentionsOnly}`);
      console.log(`  nofollow ............... ${stats.nofollow}`);
      console.log('');
    } catch (err) {
      run_.fail(err);
      throw err;
    }
  });

verify
  .command('one')
  .description('check a single submission')
  .argument('<submissionId>')
  .option('-c, --client <id>', 'client id')
  .option('--deep', 'render with a browser', false)
  .option('--check-index', 'also check indexation', false)
  .option('--session', 'render through the persistent browser profile', false)
  .action(async (id: string, opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const out = await verifyById(cfg, Number(id), {
      deep: Boolean(opts.deep),
      checkIndex: Boolean(opts.checkIndex),
      useSession: Boolean(opts.session),
    });
    console.log('');
    console.log(`  url .......... ${out.url}`);
    console.log(`  final url .... ${out.result.finalUrl}`);
    console.log(`  http ......... ${out.result.httpStatus}`);
    console.log(`  link present . ${out.result.linkPresent}`);
    console.log(`  mention only . ${out.result.mentionOnly}`);
    console.log(`  rel .......... ${out.result.follow ?? '-'}`);
    console.log(`  anchor ....... ${out.result.anchorFound ?? '-'}`);
    console.log(`  in content ... ${out.result.inContent ?? '-'}`);
    console.log(`  indexed ...... ${out.result.indexed === null ? 'not checked' : out.result.indexed}`);
    console.log(`  method ....... ${out.result.method}`);
    console.log(`  status ....... ${out.before} -> ${out.after}`);
    console.log(`  note ......... ${out.result.note}`);
    console.log('');
  });

// ── index (IndexNow) ─────────────────────────────────────────────────────────
const indexCmd = program.command('index').description("search-engine notification for the client's own site");

indexCmd
  .command('submit')
  .description("submit the client's own URLs to IndexNow")
  .argument('<urls...>')
  .option('-c, --client <id>', 'client id')
  .action(async (urls: string[], opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const result = await submitToIndexNow(cfg, urls);
    logIndexNow(cfg.id, result);
    console.log(`
  ${result.ok ? 'ok' : 'not accepted'} (${result.status}): ${result.message}`);
    console.log(`  submitted ${result.submitted} URL(s)
`);
  });

indexCmd
  .command('status')
  .description('which verified backlinks are not indexed')
  .option('-c, --client <id>', 'client id')
  .action((opts) => {
    initSchema();
    const cfg = resolveClient(opts.client);
    const r = indexationReport(cfg.id);
    log.heading('Indexation of verified links');
    console.log(`  indexed ..... ${r.indexed} of ${r.checked}`);
    console.log(`  not indexed . ${r.notIndexed.length}`);
    console.log(`  not checked . ${r.unknown}`);
    for (const n of r.notIndexed.slice(0, 20)) {
      console.log(`    ${(n.domain ?? '?').padEnd(28)} ${String(n.days).padStart(4)}d  ${n.url}`);
    }
    console.log(
      '\n  IndexNow cannot submit third-party pages — only the host that publishes the\n' +
        '  key file. An unindexed backlink cannot be fixed by us; it is a reason to stop\n' +
        '  using that platform.\n',
    );
  });

// ── scheduled pipelines ──────────────────────────────────────────────────────
program
  .command('daily')
  .description('the scheduled daily run: generate, submit, verify, sheet, report')
  .option('-c, --client <id>', 'client id (default: every configured client)')
  .option('--all', 'every client, explicitly', false)
  .option('--dry-run', 'show what each step would do', false)
  .option('--skip <steps>', 'comma-separated step names to skip')
  .action(async (opts) => {
    initSchema();
    const skip = opts.skip ? String(opts.skip).split(',').map((s: string) => s.trim()) : [];

    if (opts.all || !opts.client) {
      const results = await runForAll('daily', { dryRun: Boolean(opts.dryRun), skip });
      for (const r of results) printPipeline(r);
    } else {
      printPipeline(await runDaily(resolveClient(opts.client), { dryRun: Boolean(opts.dryRun), skip }));
    }
  });

program
  .command('weekly')
  .description('the scheduled weekly run: re-verify every link, alert on losses')
  .option('-c, --client <id>', 'client id (default: every configured client)')
  .option('--all', 'every client, explicitly', false)
  .option('--dry-run', 'show what each step would do', false)
  .action(async (opts) => {
    initSchema();
    if (opts.all || !opts.client) {
      const results = await runForAll('weekly', { dryRun: Boolean(opts.dryRun) });
      for (const r of results) printPipeline(r);
    } else {
      printPipeline(await runWeekly(resolveClient(opts.client), { dryRun: Boolean(opts.dryRun) }));
    }
  });

program
  .command('web')
  .description('open the local web UI (read, approve, work the manual queue)')
  .option('-p, --port <n>', 'port (PORT env wins, for hosts that assign one)')
  .option('--host <addr>', 'bind address (WEB_HOST env; default 127.0.0.1)')
  .action(async (opts) => {
    const port = Number(process.env.PORT || opts.port || 4317);
    const url = await startWeb(port, opts.host);
    console.log(`
  ${url}
`);
    console.log('  Reads the database and records your decisions. It never runs commands and');
    console.log('  never shows a password — generating, submitting and verifying stay in the');
    console.log('  terminal on purpose.\n');
    console.log('  Ctrl+C to stop.\n');
    // Hold the process open for the server.
    await new Promise(() => {});
  });

program
  .command('doctor')
  .description('preflight: is this safe to leave running unattended?')
  .option('-c, --client <id>', 'check one client only')
  .action((opts) => {
    initSchema();
    const result = runDoctor(opts.client);
    printDoctor(result);
    if (result.blocking) process.exitCode = 1;
  });

// ── llm ──────────────────────────────────────────────────────────────────────
program
  .command('llm')
  .argument('<action>', 'ping')
  .description('LLM connectivity check')
  .action(async (action: string) => {
    if (action !== 'ping') throw new Error(`Unknown llm action "${action}".`);
    console.log(`provider: ${env.llm.provider}\nbase url: ${env.llm.baseUrl}\nmodel:    ${env.llm.model}`);
    const reply = await ping();
    console.log(`reply:    ${reply}`);
  });

// ── run ──────────────────────────────────────────────────────────────────────
try {
  await program.parseAsync(process.argv);
} catch (err) {
  log.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  closeDb();
}

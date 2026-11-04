/**
 * Copies the newest generated dashboard into public/ so Vercel can serve it.
 *
 * Only the dashboard goes to Vercel. The agent itself cannot: Chromium does not
 * fit in a serverless function, SQLite writes do not survive one, and Assist
 * Mode needs a browser window a person can see. The dashboard is a single
 * static HTML file with no server behind it, so it deploys anywhere.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reports = join(root, 'data', 'reports');
const out = join(root, 'public');

let files = [];
try {
  files = readdirSync(reports)
    .filter((f) => f.endsWith('-dashboard.html'))
    .map((f) => ({ f, t: statSync(join(reports, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
} catch {
  /* reports/ may not exist yet */
}

if (!files.length) {
  console.error('No dashboard found. Run `npm run dashboard` first.');
  process.exit(1);
}

mkdirSync(out, { recursive: true });
copyFileSync(join(reports, files[0].f), join(out, 'index.html'));

// The dashboard is a client's link report. Keep it out of search results —
// it is meant to be sent to one person, not indexed.
writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

console.log(`public/index.html  <-  ${files[0].f}`);
console.log('Deploy it with:  vercel --prod');

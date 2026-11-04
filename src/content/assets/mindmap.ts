/**
 * Mind map builder: a horizontal tree as SVG, plus a PNG and a FreeMind .mm
 * file.
 *
 * The .mm export exists because most mind-map platforms cannot be automated at
 * all — they are canvas apps behind a login. What they almost all *can* do is
 * import FreeMind XML, which turns a twenty-minute manual rebuild into one
 * upload. That is the difference between the mindmap category being worth
 * touching and not.
 *
 * Honest framing: this is the weakest of the nine categories. It is built
 * because the sheet has a tab for it, not because the links matter.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { ClientConfig } from '../../config.ts';
import type { MindmapOutline } from '../writer.ts';
import { log } from '../../util/log.ts';

const BRANCH_COLOURS = ['#2563EB', '#059669', '#D97706', '#DC2626', '#7C3AED', '#0891B2'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgFor(outline: MindmapOutline, cfg: ClientConfig): { svg: string; width: number; height: number } {
  const rowH = 46;
  const branchGap = 30;

  // Height is driven by content, so nothing ever overlaps.
  let bodyH = 0;
  for (const b of outline.branches) bodyH += rowH + b.children.length * rowH + branchGap;

  const width = 1400;
  const height = Math.max(700, bodyH + 220);
  const rootX = 150;
  const branchX = 520;
  const childX = 760;

  const parts: string[] = [];
  let y = 150;
  const rootY = height / 2;

  outline.branches.forEach((branch, i) => {
    const colour = BRANCH_COLOURS[i % BRANCH_COLOURS.length]!;
    const branchY = y + rowH / 2;

    // Root to branch.
    parts.push(
      `<path d="M ${rootX + 170} ${rootY} C ${rootX + 300} ${rootY}, ${branchX - 150} ${branchY}, ${branchX} ${branchY}" stroke="${colour}" stroke-width="3" fill="none" opacity="0.65"/>`,
    );
    parts.push(
      `<rect x="${branchX}" y="${branchY - 20}" width="220" height="40" rx="20" fill="${colour}"/>` +
        `<text x="${branchX + 110}" y="${branchY + 7}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="bold" fill="#FFFFFF">${esc(
          branch.label.slice(0, 24),
        )}</text>`,
    );

    y += rowH;
    branch.children.forEach((child) => {
      const childY = y + rowH / 2;
      parts.push(
        `<path d="M ${branchX + 220} ${branchY} C ${branchX + 300} ${branchY}, ${childX - 60} ${childY}, ${childX} ${childY}" stroke="${colour}" stroke-width="2" fill="none" opacity="0.45"/>`,
      );
      parts.push(
        `<circle cx="${childX}" cy="${childY}" r="6" fill="${colour}"/>` +
          `<text x="${childX + 20}" y="${childY + 6}" font-family="Arial, Helvetica, sans-serif" font-size="18" fill="#1F2937">${esc(
            child.slice(0, 52),
          )}</text>`,
      );
      y += rowH;
    });
    y += branchGap;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#FFFFFF"/>
  ${parts.join('\n  ')}
  <rect x="${rootX - 20}" y="${rootY - 42}" width="190" height="84" rx="14" fill="#111827"/>
  <text x="${rootX + 75}" y="${rootY - 8}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="bold" fill="#FFFFFF">${esc(
    outline.title.slice(0, 22),
  )}</text>
  <text x="${rootX + 75}" y="${rootY + 18}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="#9CA3AF">${esc(
    cfg.city ?? '',
  )}</text>
  <text x="40" y="${height - 30}" font-family="Arial, Helvetica, sans-serif" font-size="15" fill="#6B7280">${esc(
    cfg.name,
  )} · ${esc(cfg.siteUrl.replace(/^https?:\/\//, ''))}</text>
</svg>`;

  return { svg, width, height };
}

/** FreeMind XML — importable by most mind-map tools, which is the only way a
 *  human can finish the job in one step. */
function freemindFor(outline: MindmapOutline): string {
  const node = (text: string, children = ''): string =>
    `<node TEXT="${esc(text)}">${children}</node>`;
  const branches = outline.branches
    .map((b) => node(b.label, b.children.map((c) => node(c)).join('')))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.0.1">\n  ${node(
    outline.title,
    branches,
  )}\n</map>\n`;
}

export async function buildMindmap(
  outline: MindmapOutline,
  cfg: ClientConfig,
  outPathBase: string,
): Promise<{ primary: string; files: string[] }> {
  mkdirSync(dirname(outPathBase), { recursive: true });
  const { svg } = svgFor(outline, cfg);

  const svgPath = `${outPathBase}.svg`;
  const mmPath = `${outPathBase}.mm`;
  writeFileSync(svgPath, svg, 'utf8');
  writeFileSync(mmPath, freemindFor(outline), 'utf8');

  const files = [svgPath, mmPath];
  let primary = svgPath;

  try {
    const pngPath = `${outPathBase}.png`;
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(pngPath);
    files.unshift(pngPath);
    primary = pngPath;
  } catch (err) {
    log.warn(`mind map PNG skipped (${err instanceof Error ? err.message : err}); SVG written.`);
  }

  return { primary, files };
}

/**
 * Image builder: SVG composed here, rasterised by sharp, with EXIF written in.
 *
 * The metadata is the point. An image on a sharing platform ranks on its alt
 * text, caption and file metadata, and almost every image the old workflow
 * submitted had none of it. ImageDescription, Copyright and Artist cost nothing
 * and survive re-hosting.
 *
 * JPEG rather than PNG because EXIF in PNG is poorly supported by the platforms
 * that read it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { ClientConfig } from '../../config.ts';
import type { AnchorChoice } from '../types.ts';
import { log } from '../../util/log.ts';

const W = 1200;
const H = 1200; // square: the shape that survives every platform's crop

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Greedy wrap by character budget — good enough for a fixed font size. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= perLine) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/[,.:;]$/, '')}...`;
  }
  return lines;
}

export interface ImageSpec {
  title: string;
  points: string[];
  caption: string;
}

function svgFor(spec: ImageSpec, cfg: ClientConfig, anchor: AnchorChoice): string {
  const titleLines = wrap(spec.title, 26, 3);
  const titleY = 220;
  const pointsStart = titleY + titleLines.length * 76 + 90;

  const points = spec.points.slice(0, 5).map((p, i) => {
    const y = pointsStart + i * 118;
    const lines = wrap(p, 44, 2);
    const text = lines
      .map((l, li) => `<tspan x="188" dy="${li === 0 ? 0 : 44}">${esc(l)}</tspan>`)
      .join('');
    return `
      <circle cx="140" cy="${y - 10}" r="13" fill="#2563EB"/>
      <text x="188" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="36" fill="#1F2937">${text}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#F8FAFC"/>
  <rect x="0" y="0" width="${W}" height="18" fill="#2563EB"/>
  <text x="120" y="130" font-family="Arial, Helvetica, sans-serif" font-size="26" letter-spacing="3" fill="#6B7280">${esc(
    (cfg.city ?? '').toUpperCase(),
  )}</text>
  ${titleLines
    .map(
      (l, i) =>
        `<text x="120" y="${titleY + i * 76}" font-family="Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="#111827">${esc(
          l,
        )}</text>`,
    )
    .join('\n  ')}
  <rect x="120" y="${titleY + titleLines.length * 76 + 20}" width="120" height="8" fill="#2563EB"/>
  ${points.join('\n')}
  <text x="120" y="${H - 90}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="bold" fill="#1F2937">${esc(
    cfg.name,
  )}</text>
  <text x="120" y="${H - 48}" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#2563EB">${esc(
    anchor.targetUrl.replace(/^https?:\/\//, ''),
  )}</text>
</svg>`;
}

export async function buildImage(
  spec: ImageSpec,
  anchor: AnchorChoice,
  cfg: ClientConfig,
  outPath: string,
): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });
  const svg = svgFor(spec, cfg, anchor);

  try {
    await sharp(Buffer.from(svg))
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
      .withExif({
        IFD0: {
          ImageDescription: spec.caption.slice(0, 500),
          Copyright: `${new Date().getFullYear()} ${cfg.name}`,
          Artist: cfg.name,
          Software: 'seo-ai-agent',
        },
      })
      .toFile(outPath);
    return outPath;
  } catch (err) {
    // sharp is the one native dependency here. If its binary did not install,
    // the SVG is still a usable asset — several platforms accept it directly —
    // so the run continues with a clear message rather than failing.
    const svgPath = outPath.replace(/\.jpe?g$/i, '.svg');
    writeFileSync(svgPath, svg, 'utf8');
    log.warn(
      `sharp could not rasterise (${err instanceof Error ? err.message : err}). ` +
        `Wrote ${svgPath} instead — no EXIF. Run: npm rebuild sharp`,
    );
    return svgPath;
  }
}

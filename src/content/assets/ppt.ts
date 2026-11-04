/**
 * Slide deck builder (pptxgenjs).
 *
 * Same caveat as the PDF: the crawlable link lives in the hosting platform's
 * description field, not inside the file. The deck still has to be a real deck —
 * SlideShare and Issuu both get genuine search traffic for how-to decks, and a
 * deck of keyword mush gets no views and no links.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import type { ClientConfig } from '../../config.ts';
import type { AnchorChoice } from '../types.ts';
import type { DeckOutline } from '../writer.ts';

const INK = '1F2937';
const ACCENT = '2563EB';
const MUTED = '6B7280';

export async function buildPptx(
  outline: DeckOutline,
  anchor: AnchorChoice,
  cfg: ClientConfig,
  outPath: string,
): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = cfg.name;
  pptx.title = outline.title;
  pptx.subject = anchor.targetUrl;

  // Title slide.
  const title = pptx.addSlide();
  title.background = { color: 'FFFFFF' };
  title.addText(outline.title, {
    x: 0.6,
    y: 1.7,
    w: 8.8,
    h: 1.6,
    fontSize: 36,
    bold: true,
    color: INK,
    fontFace: 'Arial',
  });
  title.addText(cfg.city ? `${cfg.name} · ${cfg.city}` : cfg.name, {
    x: 0.6,
    y: 3.3,
    w: 8.8,
    h: 0.5,
    fontSize: 16,
    color: MUTED,
    fontFace: 'Arial',
  });
  title.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.5, w: 1.2, h: 0.08, fill: { color: ACCENT } });

  for (const slide of outline.slides) {
    const s = pptx.addSlide();
    s.addText(slide.heading, {
      x: 0.6,
      y: 0.5,
      w: 8.8,
      h: 0.9,
      fontSize: 26,
      bold: true,
      color: INK,
      fontFace: 'Arial',
    });
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.35, w: 0.8, h: 0.06, fill: { color: ACCENT } });
    if (slide.bullets.length) {
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.75, y: 1.7, w: 8.5, h: 3.4, fontSize: 17, color: INK, fontFace: 'Arial', lineSpacingMultiple: 1.3 },
      );
    }
    s.addText(cfg.name, { x: 0.6, y: 5.0, w: 4, h: 0.3, fontSize: 10, color: MUTED, fontFace: 'Arial' });
  }

  // Closing slide carries the link.
  const last = pptx.addSlide();
  last.addText(anchor.text, {
    x: 0.6,
    y: 2.0,
    w: 8.8,
    h: 0.8,
    fontSize: 24,
    bold: true,
    color: INK,
    fontFace: 'Arial',
  });
  last.addText(anchor.targetUrl, {
    x: 0.6,
    y: 2.8,
    w: 8.8,
    h: 0.5,
    fontSize: 16,
    color: ACCENT,
    fontFace: 'Arial',
    hyperlink: { url: anchor.targetUrl },
  });
  if (cfg.contact?.phone) {
    last.addText(cfg.contact.phone, {
      x: 0.6,
      y: 3.3,
      w: 8.8,
      h: 0.4,
      fontSize: 13,
      color: MUTED,
      fontFace: 'Arial',
    });
  }

  await pptx.writeFile({ fileName: outPath });
  return outPath;
}

/**
 * PDF builder (PDFKit).
 *
 * Worth being clear about what a PDF submission is and is not: links inside a
 * PDF are followed inconsistently and carry little. The value of publishing one
 * is the host page — its title, its description field and its own link to your
 * site. So the PDF is built properly, with real text and a working link
 * annotation, and the description that goes in the platform's form is treated
 * as the part that matters.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import PDFDocument from 'pdfkit';
import type { ClientConfig } from '../../config.ts';
import type { AnchorChoice, ArticleDraft } from '../types.ts';

export async function buildPdf(
  draft: ArticleDraft,
  anchor: AnchorChoice,
  cfg: ClientConfig,
  outPath: string,
): Promise<string> {
  mkdirSync(dirname(outPath), { recursive: true });

  return new Promise<string>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 64, bottom: 64, left: 64, right: 64 },
      info: {
        Title: draft.title,
        Author: cfg.name,
        Subject: anchor.targetUrl,
        Keywords: draft.title,
      },
    });

    const stream = createWriteStream(outPath);
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
    doc.pipe(stream);

    doc.font('Helvetica-Bold').fontSize(22).text(draft.title, { lineGap: 2 });
    doc.moveDown(0.4);

    if (draft.metaDescription) {
      doc.font('Helvetica-Oblique').fontSize(11).fillColor('#444').text(draft.metaDescription);
      doc.fillColor('#000');
    }
    doc.moveDown(1);

    for (const section of draft.sections) {
      // Keep a heading with at least some of its text rather than orphaning it
      // at the foot of a page.
      if (doc.y > 680) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(14).text(section.heading);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(11);
      for (const p of section.paragraphs) {
        doc.text(p, { align: 'left', lineGap: 1.5 });
        doc.moveDown(0.5);
      }
      doc.moveDown(0.4);
    }

    if (draft.faq.length) {
      if (doc.y > 620) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(14).text('Common questions');
      doc.moveDown(0.4);
      for (const f of draft.faq) {
        doc.font('Helvetica-Bold').fontSize(11).text(f.q);
        doc.font('Helvetica').fontSize(11).text(f.a);
        doc.moveDown(0.5);
      }
    }

    if (draft.takeaway) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).text('In short: ', { continued: true });
      doc.font('Helvetica').text(draft.takeaway);
    }

    // The one link, as a real annotation.
    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(`${cfg.name} — `, { continued: true });
    doc.fillColor('#1155cc').text(anchor.text, {
      link: anchor.targetUrl,
      underline: true,
      continued: false,
    });
    doc.fillColor('#555').fontSize(9).text(anchor.targetUrl);
    if (cfg.city) doc.text(cfg.city);

    doc.end();
  });
}

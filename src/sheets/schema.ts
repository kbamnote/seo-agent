/**
 * Column layout shared by the source tracker and the agent's own sheet.
 *
 * The first ten columns are byte-for-byte the team's existing layout, so a row
 * can be copied between the two sheets without re-arranging anything. The
 * agent sheet then adds the columns the manual process never had — the ones
 * that say whether the link is actually live.
 */

export const SOURCE_COLUMNS = [
  'Sr.no.',
  'URL',
  'Backlinks',
  'Email id',
  'Username',
  'Password',
  'Date',
  'Status',
  'Name',
  'Keywords',
] as const;

export const AGENT_EXTRA_COLUMNS = [
  'Anchor',
  'Anchor Type',
  'Live',
  'Rel',
  'Indexed',
  'Last Checked',
  'Notes',
] as const;

export const AGENT_COLUMNS = [...SOURCE_COLUMNS, ...AGENT_EXTRA_COLUMNS];

/** A row as read from the source sheet, before any cleaning. */
export interface RawRow {
  tab: string;
  rowNumber: number; // 1-based sheet row, so a finding can point at it
  srNo: string;
  platformUrl: string;
  backlink: string;
  email: string;
  username: string;
  password: string;
  date: string;
  status: string;
  name: string;
  keywords: string;
}

export function toRawRow(tab: string, rowNumber: number, cells: unknown[]): RawRow {
  const cell = (i: number) => String(cells[i] ?? '').trim();
  return {
    tab,
    rowNumber,
    srNo: cell(0),
    platformUrl: cell(1),
    backlink: cell(2),
    email: cell(3),
    username: cell(4),
    password: cell(5),
    date: cell(6),
    status: cell(7),
    name: cell(8),
    keywords: cell(9),
  };
}

/** True when the row carries no information at all (spacer rows exist). */
export function isBlankRow(row: RawRow): boolean {
  return !(
    row.srNo ||
    row.platformUrl ||
    row.backlink ||
    row.email ||
    row.username ||
    row.date ||
    row.status ||
    row.name ||
    row.keywords
  );
}

/** Registrable-ish host for catalog keys: 'https://www.diigo.com/x' → 'diigo.com'. */
export function domainOf(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

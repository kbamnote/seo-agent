/**
 * Date normalisation for sheet rows.
 *
 * The source tracker holds `22/1/26`, `22/01//26`, `23/01/26` and `2-2-2026`
 * in the same column, plus one row where a date was typed into Status. Every
 * one of those has to come out as a single comparable ISO date, and anything
 * that cannot be read must say so rather than silently become today.
 *
 * Day-first is assumed throughout (Indian convention, and the data confirms it:
 * `22/1/26` and `27/01/26` are only valid as dd/mm).
 */

export interface ParsedDate {
  iso: string | null;
  raw: string;
  ok: boolean;
  reason?: string;
  ambiguous?: boolean;
}

const MONTHS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fourDigitYear(y: number): number {
  if (y >= 1000) return y;
  // Two-digit years in this data are 25/26/27 — all 2000s.
  return y >= 70 ? 1900 + y : 2000 + y;
}

function valid(d: number, m: number, y: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const max = m === 2 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 28 : MONTHS[m - 1]!;
  return d <= max;
}

export function parseSheetDate(input: unknown): ParsedDate {
  const raw = String(input ?? '').trim();
  if (!raw) return { iso: null, raw, ok: false, reason: 'empty' };

  // Already ISO.
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number) as [number, number, number, number];
    return valid(d, m, y)
      ? { iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, raw, ok: true }
      : { iso: null, raw, ok: false, reason: 'out_of_range' };
  }

  // Collapse the repeated separators seen in the data ("22/01//26") and accept
  // / . or - as the separator.
  const cleaned = raw.replace(/[\/.\-]+/g, '/');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 3) {
    return { iso: null, raw, ok: false, reason: 'unrecognised_format' };
  }

  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n))) {
    return { iso: null, raw, ok: false, reason: 'not_a_date' };
  }
  let [d, m, y] = nums as [number, number, number];
  y = fourDigitYear(y);

  // Day-first, but if the first field cannot be a day and the second can, the
  // row was typed month-first — read it that way and flag it.
  let ambiguous = false;
  if (!valid(d, m, y) && valid(m, d, y)) {
    [d, m] = [m, d];
    ambiguous = true;
  } else if (d <= 12 && m <= 12 && d !== m) {
    // Both readings are valid: dd/mm is assumed, but the row is worth flagging
    // because the sheet mixes conventions.
    ambiguous = true;
  }

  if (!valid(d, m, y)) return { iso: null, raw, ok: false, reason: 'out_of_range' };

  return {
    iso: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    raw,
    ok: true,
    ambiguous,
  };
}

/** Today as yyyy-mm-dd in local time (what the sheet's readers expect). */
export function todayIso(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** True when the string is a date rather than a status word. */
export function looksLikeDate(value: unknown): boolean {
  const s = String(value ?? '').trim();
  if (!s) return false;
  return /^\d{1,4}[\/.\-]+\d{1,2}[\/.\-]+\d{1,4}$/.test(s);
}

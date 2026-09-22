/**
 * Minimal ANSI styling.
 *
 * A dependency for this would be ~30 lines of value; Hairline keeps its
 * runtime dependency list at exactly one package on purpose (ADR-0003), and
 * colour is the easiest place to hold that line.
 */

const ENABLED =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY === true;

/** Written as a code point rather than a raw byte, which would be invisible in the source. */
const ESC = String.fromCharCode(27);

function wrap(open: number, close: number): (text: string) => string {
  const prefix = `${ESC}[${open}m`;
  const suffix = `${ESC}[${close}m`;
  return (text: string) => (ENABLED ? `${prefix}${text}${suffix}` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  enabled: ENABLED,
};

/**
 * Strip control characters from text that came out of a repository.
 *
 * Findings quote identifiers, type renderings and string literal values from
 * code Hairline did not write. A literal containing an escape sequence could
 * otherwise reposition the cursor, recolour the output, or hide lines —
 * letting analysed code forge or conceal parts of the report. Every
 * repository-derived string is passed through this before being printed.
 *
 * C0 controls, DEL and the C1 range are removed; tabs become spaces so
 * alignment survives.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function sanitize(text: string): string {
  return text.replace(/\t/g, '  ').replace(CONTROL_CHARACTERS, '');
}

/** Wrap text to a width, indenting continuation lines. */
export function wrapText(text: string, width: number, indent = ''): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.map((line, i) => (i === 0 ? line : indent + line));
}

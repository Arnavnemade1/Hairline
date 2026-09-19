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

function wrap(open: number, close: number): (text: string) => string {
  const prefix = `[${open}m`;
  const suffix = `[${close}m`;
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

/** Reads a text input as an integer after NFKC, so full-width digits count: undefined when blank, NaN when not an integer. */
export function parseIntegerInput(raw: string): number | undefined {
  const text = raw.normalize('NFKC').trim();
  if (!text) {
    return undefined;
  }
  return /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
}

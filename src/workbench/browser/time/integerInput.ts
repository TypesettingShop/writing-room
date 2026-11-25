/** Text inputs retain native IME behavior and accept full-width integer digits. */
export function parseIntegerInput(raw: string): number | undefined {
  const text = raw.normalize('NFKC').trim();
  if (!text) {
    return undefined;
  }
  return /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
}

export interface IMatch {
  readonly start: number;
  readonly end: number;
}

/** All whitespace-separated terms must occur in at least one field. Offsets index the original text. */
export function createWordMatcher(query: string): (...fields: string[]) => IMatch[][] | undefined {
  const words = query.trim().split(/\s+/u).filter(Boolean)
    .map(word => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'));

  return (...fields) => {
    const matches = fields.map((): IMatch[] => []);
    for (const word of words) {
      let found = false;
      for (const [index, field] of fields.entries()) {
        const match = word.exec(field);
        if (match) {
          matches[index].push({ start: match.index, end: match.index + match[0].length });
          found = true;
        }
      }
      if (!found) {
        return undefined;
      }
    }
    return matches.map(ranges => {
      const merged: IMatch[] = [];
      for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
        const last = merged.at(-1);
        if (last && range.start <= last.end) {
          merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
        } else {
          merged.push(range);
        }
      }
      return merged;
    });
  };
}

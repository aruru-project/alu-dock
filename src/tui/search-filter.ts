export interface SearchableItem {
  value: string;
  label: string;
  description?: string;
}

/** Deterministic fuzzy filtering over the user-visible name, provider/id value and description. */
export function filterSearchableItems<T extends SearchableItem>(
  items: readonly T[],
  query: string,
): T[] {
  const tokens = normalize(query).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return [...items];

  return items
    .map((item, index) => {
      const fields = [item.label, item.value, item.description ?? ""].map(normalize);
      let score = 0;
      for (const token of tokens) {
        const tokenScores = fields.map((field, fieldIndex) => fuzzyTokenScore(field, token, fieldIndex));
        const best = Math.min(...tokenScores);
        if (!Number.isFinite(best)) return undefined;
        score += best;
      }
      return { item, index, score };
    })
    .filter((ranked): ranked is { item: T; index: number; score: number } => ranked !== undefined)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ item }) => item);
}

function fuzzyTokenScore(field: string, token: string, fieldIndex: number): number {
  if (field.length === 0) return Number.POSITIVE_INFINITY;
  if (field === token) return fieldIndex;

  const contiguous = field.indexOf(token);
  if (contiguous >= 0) {
    const boundaryBonus = contiguous === 0 || /[^a-z0-9]/u.test(field[contiguous - 1] ?? "") ? 0 : 4;
    return fieldIndex * 3 + contiguous * 2 + boundaryBonus + Math.max(0, field.length - token.length) / 100;
  }

  let fieldIndexCursor = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (const character of token) {
    const found = field.indexOf(character, fieldIndexCursor);
    if (found < 0) return Number.POSITIVE_INFINITY;
    if (first < 0) first = found;
    if (previous >= 0) gaps += found - previous - 1;
    previous = found;
    fieldIndexCursor = found + 1;
  }
  return 50 + fieldIndex * 3 + first * 2 + gaps * 4;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

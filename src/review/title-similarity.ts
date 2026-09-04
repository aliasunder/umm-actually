const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "not",
  "of",
  "on",
  "or",
  "should",
  "so",
  "than",
  "that",
  "the",
  "then",
  "this",
  "to",
  "was",
  "were",
  "when",
  "will",
  "with",
  "would",
])

export const normalizeTitle = (title: string): string[] => {
  const tokens = title
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
  return [...new Set(tokens)].toSorted()
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. 0 = disjoint, 1 = identical. */
export const titleSimilarity = (
  leftTokens: string[],
  rightTokens: string[],
): number => {
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0
  const rightSet = new Set(rightTokens)
  const intersection = leftTokens.filter((token) => rightSet.has(token)).length
  const union = new Set([...leftTokens, ...rightTokens]).size
  return intersection / union
}

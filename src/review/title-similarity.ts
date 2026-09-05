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

/** Jaccard similarity: |A ∩ B| / |A ∪ B|. 0 = disjoint, 1 = identical.
 *  Deduplicates internally so the result stays in [0, 1] for arbitrary input. */
export const titleSimilarity = ({
  leftTokens,
  rightTokens,
}: {
  leftTokens: string[]
  rightTokens: string[]
}): number => {
  const leftSet = new Set(leftTokens)
  const rightSet = new Set(rightTokens)
  if (leftSet.size === 0 || rightSet.size === 0) return 0
  const intersection = [...leftSet].filter((token) => {
    return rightSet.has(token)
  }).length
  const union = new Set([...leftSet, ...rightSet]).size
  return intersection / union
}

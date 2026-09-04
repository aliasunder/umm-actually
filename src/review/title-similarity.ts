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

export const titleSimilarity = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  const intersection = a.filter((token) => setB.has(token)).length
  const union = new Set([...a, ...b]).size
  return intersection / union
}

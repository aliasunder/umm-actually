/**
 * Matching engines (path.matchesGlob, the ignore package) backtrack
 * exponentially when one segment interleaves several "*" wildcards with
 * literals — a crafted 40+-char filename hangs a single synchronous,
 * unabortable match call for minutes. Both pattern channels (operator
 * input and repo .gitattributes) are bounded by this cap; "**" globstar
 * segments are exempt because globstar traversal does not backtrack.
 */
export const hasExcessiveWildcards = (pattern: string): boolean => {
  return pattern.split("/").some((segment) => {
    if (segment === "**") return false
    const starCount = (segment.match(/\*/g) ?? []).length
    return starCount > 2
  })
}

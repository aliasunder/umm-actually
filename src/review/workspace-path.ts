import { posix } from "node:path"

/** Paths reach the pipeline from operator input, the diff, the workspace
 *  scan, and model output, spelled differently ("./x", "/x", "x/", " x") —
 *  one canonical form so set membership never fails on spelling. */
export const normalizeWorkspacePath = (filePath: string): string => {
  return posix.normalize(filePath.trim()).replace(/^\//, "").replace(/\/+$/, "")
}

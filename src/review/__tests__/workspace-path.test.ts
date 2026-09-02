import { describe, expect, it } from "vitest"
import { normalizeWorkspacePath } from "../workspace-path.js"

describe("normalizeWorkspacePath", () => {
  it("returns a plain relative path unchanged", () => {
    expect(normalizeWorkspacePath("src/greeter.ts")).toBe("src/greeter.ts")
  })

  it("strips a leading ./", () => {
    expect(normalizeWorkspacePath("./src/greeter.ts")).toBe("src/greeter.ts")
  })

  it("strips a leading /", () => {
    expect(normalizeWorkspacePath("/src/greeter.ts")).toBe("src/greeter.ts")
  })

  it("strips trailing slashes", () => {
    expect(normalizeWorkspacePath("docs//")).toBe("docs")
  })

  it("collapses repeated separators", () => {
    expect(normalizeWorkspacePath("src//review///prompt.ts")).toBe(
      "src/review/prompt.ts",
    )
  })

  it("resolves redundant segments", () => {
    expect(normalizeWorkspacePath("src/../src/./greeter.ts")).toBe(
      "src/greeter.ts",
    )
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeWorkspacePath("  src/greeter.ts \n")).toBe("src/greeter.ts")
  })
})

import { describe, expect, it } from "vitest"
import { renderCodeSpan } from "../markdown.js"

describe("renderCodeSpan", () => {
  it.each([
    { label: "a plain path", text: "src/app.ts:12", expected: "`src/app.ts:12`" },
    { label: "a path with one backtick", text: "src/a`b.ts", expected: "``src/a`b.ts``" },
    {
      label: "a path whose longest backtick run is two",
      text: "a`b``c.ts",
      expected: "```a`b``c.ts```",
    },
    { label: "a path that starts with a backtick", text: "`a.ts", expected: "`` `a.ts ``" },
    { label: "a path that ends with a backtick", text: "a.ts`", expected: "`` a.ts` ``" },
    { label: "a path that starts with a space", text: " a.ts", expected: "`  a.ts `" },
    { label: "a path that ends with a space", text: "a.ts ", expected: "` a.ts  `" },
  ])("wraps $label so no backtick inside closes the span", ({ text, expected }) => {
    expect(renderCodeSpan(text)).toBe(expected)
  })

  it("writes a line break as its octal escape so a blank line cannot end the span", () => {
    expect(renderCodeSpan("docs/a\n\n# forged.md")).toBe("`docs/a\\012\\012# forged.md`")
  })
})

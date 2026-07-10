import type { Finding } from "../finding.js"

/** Valid baseline finding; tests override only the fields under test. */
export const makeFinding = (overrides: Partial<Finding> = {}): Finding => ({
  file: "src/greeter.ts",
  line: 145,
  end_line: null,
  category: "correctness",
  severity: "medium",
  confidence: "high",
  title: "Whitespace-only keys pass the empty-key guard",
  description: "The guard rejects only the exact empty string.",
  suggestion: null,
  failure_scenario:
    'register(" ", "value") succeeds and the entry is orphaned.',
  ...overrides,
})

import * as core from "@actions/core"

// Entrypoint stub — the V1 pipeline (orchestrate.ts + I/O clients) lands in
// the next PR. Failing loudly beats silently pretending a review happened.
core.setFailed(
  "umm-actually: review pipeline not yet implemented (scaffold only)",
)

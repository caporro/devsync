import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { test } from "node:test"

const require = createRequire(import.meta.url)
const agentRequire = createRequire(require.resolve("deepagents"))
const micromatch = agentRequire("micromatch")
const braces = createRequire(agentRequire.resolve("micromatch"))("braces")

test("filesystem glob dependencies reject deeply nested patterns before stack exhaustion", () => {
  for (const open of ["{", "("]) {
    const close = open === "{" ? "}" : ")"
    const pattern = open.repeat(4000) + "file" + close.repeat(4000)
    for (const parse of [braces, braces.parse, braces.expand]) {
      assert.throws(() => parse(pattern), /exceeds max depth/)
    }
  }
})

test("guarded glob dependencies preserve normal filesystem patterns", () => {
  assert.deepEqual(braces.expand("work/{draft,final}.md"), ["work/draft.md", "work/final.md"])
  assert.deepEqual(
    micromatch(["resources/input.md", "work/draft.md", "work/final.md", "work/other.txt"], "work/{draft,final}.md"),
    ["work/draft.md", "work/final.md"],
  )
})

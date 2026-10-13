/** The identification benchmark (scripts/evaluate.js) must stay clean on this checkout. */
const { test, after } = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { resetAll } = require("../test-support/helpers")
const { evaluate } = require("../scripts/evaluate")

after(resetAll)

test("benchmark: every case correct, no false positive, no season confusion", async () => {
  const { new: res } = await evaluate({ new: path.resolve(__dirname, "..") })
  const wrong = res.rows.filter((r) => r.outcome !== "correct" && r.outcome !== "correct-empty")
  assert.deepEqual(wrong, [])
  assert.equal(res.summary.falsePositives, 0)
})

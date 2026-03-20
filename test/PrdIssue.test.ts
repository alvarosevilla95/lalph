import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { PrdIssue } from "../src/domain/PrdIssue.ts"

describe("PrdIssue", () => {
  const makeIssue = (overrides?: Partial<PrdIssue>) =>
    new PrdIssue({
      id: "#1",
      title: "Test issue",
      description: "A test description",
      priority: 3,
      estimate: null,
      state: "todo",
      blockedBy: [],
      autoMerge: false,
      ...overrides,
    })

  describe("Schema decoding", () => {
    it.effect("decodes a full issue", () =>
      Effect.gen(function* () {
        const input = {
          id: "#1",
          title: "My issue",
          description: "desc",
          priority: 2,
          estimate: 3,
          state: "in-progress",
          blockedBy: ["#2"],
          autoMerge: true,
        }
        const issue = yield* Schema.decodeEffect(PrdIssue)(input)
        assert.strictEqual(issue.id, "#1")
        assert.strictEqual(issue.title, "My issue")
        assert.strictEqual(issue.description, "desc")
        assert.strictEqual(issue.priority, 2)
        assert.strictEqual(issue.estimate, 3)
        assert.strictEqual(issue.state, "in-progress")
        assert.deepStrictEqual(issue.blockedBy, ["#2"])
        assert.strictEqual(issue.autoMerge, true)
      }),
    )

    it.effect("applies defaults for optional fields", () =>
      Effect.gen(function* () {
        const issue = yield* Schema.decodeEffect(PrdIssue)({
          title: "Minimal issue",
        })
        assert.strictEqual(issue.id, null)
        assert.strictEqual(issue.description, "")
        assert.strictEqual(issue.priority, 3)
        assert.strictEqual(issue.estimate, null)
        assert.strictEqual(issue.state, "todo")
        assert.deepStrictEqual(issue.blockedBy, [])
        assert.strictEqual(issue.autoMerge, false)
      }),
    )

    it.effect("decodes from a plain string via FromInput", () =>
      Effect.gen(function* () {
        const issue = yield* Schema.decodeEffect(PrdIssue.FromInput)(
          "Quick task",
        )
        assert.strictEqual(issue.title, "Quick task")
        assert.strictEqual(issue.state, "todo")
      }),
    )

    it.effect("rejects invalid state values", () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeEffect(PrdIssue)({
          title: "Bad state",
          state: "invalid",
        }).pipe(Effect.asVoid, Effect.flip)
        assert.isTrue("_tag" in result)
      }),
    )
  })

  describe("YAML serialization", () => {
    it("round-trips through YAML", () => {
      const issues = [
        makeIssue({ id: "#1", title: "First" }),
        makeIssue({ id: "#2", title: "Second", state: "in-progress" }),
      ]
      const yaml = PrdIssue.arrayToYaml(issues)
      const parsed = PrdIssue.arrayFromYaml(yaml)
      assert.strictEqual(parsed.length, 2)
      assert.strictEqual(parsed[0]!.id, "#1")
      assert.strictEqual(parsed[0]!.title, "First")
      assert.strictEqual(parsed[1]!.id, "#2")
      assert.strictEqual(parsed[1]!.title, "Second")
      assert.strictEqual(parsed[1]!.state, "in-progress")
    })

    it("preserves blockedBy through YAML round-trip", () => {
      const issues = [makeIssue({ blockedBy: ["#3", "#4"] })]
      const yaml = PrdIssue.arrayToYaml(issues)
      const parsed = PrdIssue.arrayFromYaml(yaml)
      assert.deepStrictEqual(parsed[0]!.blockedBy, ["#3", "#4"])
    })

    it("handles empty array", () => {
      const yaml = PrdIssue.arrayToYaml([])
      const parsed = PrdIssue.arrayFromYaml(yaml)
      assert.deepStrictEqual(parsed, [])
    })
  })

  describe("isChangedComparedTo", () => {
    it("returns false for identical issues", () => {
      const a = makeIssue()
      const b = makeIssue()
      assert.isFalse(a.isChangedComparedTo(b))
    })

    it("detects title change", () => {
      const a = makeIssue()
      const b = makeIssue({ title: "Different" })
      assert.isTrue(a.isChangedComparedTo(b))
    })

    it("detects description change", () => {
      const a = makeIssue()
      const b = makeIssue({ description: "Updated description" })
      assert.isTrue(a.isChangedComparedTo(b))
    })

    it("detects state change", () => {
      const a = makeIssue({ state: "todo" })
      const b = makeIssue({ state: "in-progress" })
      assert.isTrue(a.isChangedComparedTo(b))
    })

    it("detects autoMerge change", () => {
      const a = makeIssue({ autoMerge: false })
      const b = makeIssue({ autoMerge: true })
      assert.isTrue(a.isChangedComparedTo(b))
    })

    it("detects blockedBy change", () => {
      const a = makeIssue({ blockedBy: ["#1"] })
      const b = makeIssue({ blockedBy: ["#2"] })
      assert.isTrue(a.isChangedComparedTo(b))
    })

    it("ignores priority and estimate changes", () => {
      const a = makeIssue({ priority: 1, estimate: 5 })
      const b = makeIssue({ priority: 4, estimate: 10 })
      assert.isFalse(a.isChangedComparedTo(b))
    })
  })

  describe("update", () => {
    it("updates title", () => {
      const issue = makeIssue()
      const updated = issue.update({ title: "New title" })
      assert.strictEqual(updated.title, "New title")
      assert.strictEqual(updated.description, issue.description)
    })

    it("updates state", () => {
      const issue = makeIssue({ state: "todo" })
      const updated = issue.update({ state: "in-review" })
      assert.strictEqual(updated.state, "in-review")
    })

    it("updates blockedBy", () => {
      const issue = makeIssue({ blockedBy: [] })
      const updated = issue.update({ blockedBy: ["#5"] })
      assert.deepStrictEqual(updated.blockedBy, ["#5"])
    })

    it("preserves unchanged fields", () => {
      const issue = makeIssue({
        id: "#99",
        priority: 1,
        estimate: 8,
        autoMerge: true,
      })
      const updated = issue.update({ title: "Changed" })
      assert.strictEqual(updated.id, "#99")
      assert.strictEqual(updated.priority, 1)
      assert.strictEqual(updated.estimate, 8)
      assert.strictEqual(updated.autoMerge, true)
    })
  })

  describe("withAutoMerge", () => {
    it("sets autoMerge to true", () => {
      const issue = makeIssue({ autoMerge: false })
      assert.isTrue(issue.withAutoMerge(true).autoMerge)
    })

    it("sets autoMerge to false", () => {
      const issue = makeIssue({ autoMerge: true })
      assert.isFalse(issue.withAutoMerge(false).autoMerge)
    })
  })
})

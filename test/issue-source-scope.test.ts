import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import {
  scopeIssueSourceToParentIssueSourceId,
  scopeIssueSourceToTopLevelIssues,
} from "../src/IssueSourceScope.ts"
import { IssueSource, IssuesChange } from "../src/IssueSource.ts"
import { PrdIssue } from "../src/domain/PrdIssue.ts"
import { ProjectId } from "../src/domain/Project.ts"

const projectId = ProjectId.makeUnsafe("project-alpha")

const makeIssue = (options: {
  readonly id: string
  readonly title: string
  readonly parentIssueSourceId?: string | undefined
}) =>
  new PrdIssue({
    id: options.id,
    title: options.title,
    description: "",
    priority: 0,
    estimate: null,
    state: "todo",
    blockedBy: [],
    parentIssueSourceId: options.parentIssueSourceId,
    autoMerge: false,
  })

const makeIssueSourceLayer = (
  ref: SubscriptionRef.SubscriptionRef<IssuesChange>,
) =>
  Layer.succeed(
    IssueSource,
    IssueSource.of({
      ref: () => Effect.succeed(ref),
      issues: () =>
        SubscriptionRef.get(ref).pipe(Effect.map((change) => change.issues)),
      findById: (_projectId, issueId) =>
        SubscriptionRef.get(ref).pipe(
          Effect.map(
            (change) =>
              change.issues.find((issue) => issue.id === issueId) ?? null,
          ),
        ),
      createIssue: () => Effect.die("unexpected createIssue"),
      updateIssue: () => Effect.die("unexpected updateIssue"),
      cancelIssue: () => Effect.die("unexpected cancelIssue"),
      reset: Effect.die("unexpected reset"),
      settings: () => Effect.die("unexpected settings"),
      info: () => Effect.die("unexpected info"),
      issueCliAgentPreset: () => Effect.die("unexpected issueCliAgentPreset"),
      updateCliAgentPreset: () => Effect.die("unexpected updateCliAgentPreset"),
      cliAgentPresetInfo: () => Effect.die("unexpected cliAgentPresetInfo"),
      ensureInProgress: () => Effect.die("unexpected ensureInProgress"),
    }),
  )

describe("issue source feature scoping", () => {
  it("filters issues, lookups, and subscription updates to top-level tasks", async () => {
    const upstreamRef = await Effect.runPromise(
      SubscriptionRef.make<IssuesChange>(
        IssuesChange.Internal({
          issues: [
            makeIssue({
              id: "LIN-101",
              title: "top level a",
            }),
            makeIssue({
              id: "LIN-102",
              title: "child a",
              parentIssueSourceId: "LIN-101",
            }),
            makeIssue({
              id: "LIN-103",
              title: "top level b",
            }),
          ],
        }),
      ),
    )

    const layer = scopeIssueSourceToTopLevelIssues().pipe(
      Layer.provide(makeIssueSourceLayer(upstreamRef)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* IssueSource

          const initialIssues = yield* source.issues(projectId)
          const topLevelMatch = yield* source.findById(projectId, "LIN-103")
          const childMiss = yield* source.findById(projectId, "LIN-102")
          const scopedRef = yield* source.ref(projectId)

          yield* SubscriptionRef.set(
            upstreamRef,
            IssuesChange.External({
              issues: [
                makeIssue({
                  id: "LIN-104",
                  title: "top level c",
                }),
                makeIssue({
                  id: "LIN-105",
                  title: "child b",
                  parentIssueSourceId: "LIN-104",
                }),
              ],
            }),
          )

          yield* Effect.sleep("10 millis")

          const nextChange = yield* SubscriptionRef.get(scopedRef)

          return {
            initialIssueIds: initialIssues.map((issue) => issue.id),
            topLevelMatchId: topLevelMatch?.id ?? null,
            childMiss,
            nextChangeTag: nextChange._tag,
            nextIssueIds: nextChange.issues.map((issue) => issue.id),
          }
        }).pipe(Effect.provide(layer)),
      ),
    )

    assert.deepEqual(result.initialIssueIds, ["LIN-101", "LIN-103"])
    assert.equal(result.topLevelMatchId, "LIN-103")
    assert.equal(result.childMiss, null)
    assert.equal(result.nextChangeTag, "External")
    assert.deepEqual(result.nextIssueIds, ["LIN-104"])
  })

  it("filters issues, lookups, and subscription updates to child tasks under one parent", async () => {
    const upstreamRef = await Effect.runPromise(
      SubscriptionRef.make<IssuesChange>(
        IssuesChange.Internal({
          issues: [
            makeIssue({
              id: "LIN-101",
              title: "parent",
            }),
            makeIssue({
              id: "LIN-102",
              title: "child a",
              parentIssueSourceId: "LIN-101",
            }),
            makeIssue({
              id: "LIN-103",
              title: "child b",
              parentIssueSourceId: "LIN-999",
            }),
          ],
        }),
      ),
    )

    const layer = scopeIssueSourceToParentIssueSourceId("LIN-101").pipe(
      Layer.provide(makeIssueSourceLayer(upstreamRef)),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* IssueSource

          const initialIssues = yield* source.issues(projectId)
          const scopedMatch = yield* source.findById(projectId, "LIN-102")
          const scopedMiss = yield* source.findById(projectId, "LIN-103")
          const scopedRef = yield* source.ref(projectId)

          yield* SubscriptionRef.set(
            upstreamRef,
            IssuesChange.External({
              issues: [
                makeIssue({
                  id: "LIN-101",
                  title: "parent",
                }),
                makeIssue({
                  id: "LIN-104",
                  title: "child c",
                  parentIssueSourceId: "LIN-101",
                }),
                makeIssue({
                  id: "LIN-105",
                  title: "other parent child",
                  parentIssueSourceId: "LIN-999",
                }),
              ],
            }),
          )

          yield* Effect.sleep("10 millis")

          const nextChange = yield* SubscriptionRef.get(scopedRef)

          return {
            initialIssueIds: initialIssues.map((issue) => issue.id),
            scopedMatchId: scopedMatch?.id ?? null,
            scopedMiss,
            nextChangeTag: nextChange._tag,
            nextIssueIds: nextChange.issues.map((issue) => issue.id),
          }
        }).pipe(Effect.provide(layer)),
      ),
    )

    assert.deepEqual(result.initialIssueIds, ["LIN-102"])
    assert.equal(result.scopedMatchId, "LIN-102")
    assert.equal(result.scopedMiss, null)
    assert.equal(result.nextChangeTag, "External")
    assert.deepEqual(result.nextIssueIds, ["LIN-104"])
  })
})

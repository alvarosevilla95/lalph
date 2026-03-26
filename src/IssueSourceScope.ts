import { Effect, Layer, ScopedCache, Stream, SubscriptionRef } from "effect"
import { IssuesChange, IssueSource } from "./IssueSource.ts"
import type { PrdIssue } from "./domain/PrdIssue.ts"
import type { ProjectId } from "./domain/Project.ts"

export const filterIssuesByParentIssueSourceId = (
  issues: ReadonlyArray<PrdIssue>,
  parentIssueSourceId: string,
) => issues.filter((issue) => issue.parentIssueSourceId === parentIssueSourceId)

const filterIssuesChangeByParentIssueSourceId = (
  change: IssuesChange,
  parentIssueSourceId: string,
) => {
  const issues = filterIssuesByParentIssueSourceId(
    change.issues,
    parentIssueSourceId,
  )

  return change._tag === "Internal"
    ? IssuesChange.Internal({ issues })
    : IssuesChange.External({ issues })
}

const isChildOfParentIssueSourceId = (
  issue: PrdIssue | null,
  parentIssueSourceId: string,
) => issue?.parentIssueSourceId === parentIssueSourceId

const makeScopedRef = Effect.fnUntraced(function* (
  source: IssueSource["Service"],
  projectId: ProjectId,
  parentIssueSourceId: string,
) {
  const upstream = yield* source.ref(projectId)
  const initial = yield* SubscriptionRef.get(upstream)
  const scoped = yield* SubscriptionRef.make(
    filterIssuesChangeByParentIssueSourceId(initial, parentIssueSourceId),
  )

  yield* SubscriptionRef.changes(upstream).pipe(
    Stream.runForEach((change) =>
      SubscriptionRef.set(
        scoped,
        filterIssuesChangeByParentIssueSourceId(change, parentIssueSourceId),
      ),
    ),
    Effect.forkScoped,
  )

  return scoped
})

export const scopeIssueSourceToParentIssueSourceId = (
  parentIssueSourceId: string,
) =>
  Layer.effect(
    IssueSource,
    Effect.gen(function* () {
      const source = yield* IssueSource
      const refs = yield* ScopedCache.make({
        lookup: (projectId: ProjectId) =>
          makeScopedRef(source, projectId, parentIssueSourceId),
        capacity: Number.MAX_SAFE_INTEGER,
      })

      return IssueSource.of({
        ref: (projectId) => ScopedCache.get(refs, projectId),
        issues: (projectId) =>
          source
            .issues(projectId)
            .pipe(
              Effect.map((issues) =>
                filterIssuesByParentIssueSourceId(issues, parentIssueSourceId),
              ),
            ),
        findById: (projectId, issueId) =>
          source
            .findById(projectId, issueId)
            .pipe(
              Effect.map((issue) =>
                isChildOfParentIssueSourceId(issue, parentIssueSourceId)
                  ? issue
                  : null,
              ),
            ),
        createIssue: (projectId, issue) => source.createIssue(projectId, issue),
        updateIssue: (options) => source.updateIssue(options),
        cancelIssue: (projectId, issueId) =>
          source.cancelIssue(projectId, issueId),
        reset: source.reset,
        settings: (projectId) => source.settings(projectId),
        info: (projectId) => source.info(projectId),
        issueCliAgentPreset: (issue) => source.issueCliAgentPreset(issue),
        updateCliAgentPreset: (preset) => source.updateCliAgentPreset(preset),
        cliAgentPresetInfo: (preset) => source.cliAgentPresetInfo(preset),
        ensureInProgress: (projectId, issueId) =>
          source
            .findById(projectId, issueId)
            .pipe(
              Effect.flatMap((issue) =>
                isChildOfParentIssueSourceId(issue, parentIssueSourceId)
                  ? source.ensureInProgress(projectId, issueId)
                  : Effect.void,
              ),
            ),
      })
    }),
  )

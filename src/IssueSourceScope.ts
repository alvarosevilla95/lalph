import { Effect, Layer, ScopedCache, Stream, SubscriptionRef } from "effect"
import { IssuesChange, IssueSource } from "./IssueSource.ts"
import type { PrdIssue } from "./domain/PrdIssue.ts"
import type { ProjectId } from "./domain/Project.ts"

type IssuePredicate = (issue: PrdIssue) => boolean

const filterIssues = (
  issues: ReadonlyArray<PrdIssue>,
  predicate: IssuePredicate,
) => issues.filter(predicate)

export const filterIssuesByParentIssueSourceId = (
  issues: ReadonlyArray<PrdIssue>,
  parentIssueSourceId: string,
) =>
  filterIssues(
    issues,
    (issue) => issue.parentIssueSourceId === parentIssueSourceId,
  )

export const filterTopLevelIssues = (issues: ReadonlyArray<PrdIssue>) =>
  filterIssues(issues, (issue) => issue.parentIssueSourceId === undefined)

const scopeIssuesChange = (change: IssuesChange, predicate: IssuePredicate) => {
  const issues = filterIssues(change.issues, predicate)

  return change._tag === "Internal"
    ? IssuesChange.Internal({ issues })
    : IssuesChange.External({ issues })
}

const isTopLevelIssue = (issue: PrdIssue | null) =>
  issue?.parentIssueSourceId === undefined

const isChildOfParentIssueSourceId =
  (parentIssueSourceId: string) => (issue: PrdIssue | null) =>
    issue?.parentIssueSourceId === parentIssueSourceId

const makeScopedRef = Effect.fnUntraced(function* (
  source: IssueSource["Service"],
  projectId: ProjectId,
  predicate: IssuePredicate,
) {
  const upstream = yield* source.ref(projectId)
  const initial = yield* SubscriptionRef.get(upstream)
  const scoped = yield* SubscriptionRef.make(
    scopeIssuesChange(initial, predicate),
  )

  yield* SubscriptionRef.changes(upstream).pipe(
    Stream.runForEach((change) =>
      SubscriptionRef.set(scoped, scopeIssuesChange(change, predicate)),
    ),
    Effect.forkScoped,
  )

  return scoped
})

const scopeIssueSource = (
  predicate: IssuePredicate,
  matchesIssue: (issue: PrdIssue | null) => boolean,
) =>
  Layer.effect(
    IssueSource,
    Effect.gen(function* () {
      const source = yield* IssueSource
      const refs = yield* ScopedCache.make({
        lookup: (projectId: ProjectId) =>
          makeScopedRef(source, projectId, predicate),
        capacity: Number.MAX_SAFE_INTEGER,
      })

      return IssueSource.of({
        ref: (projectId) => ScopedCache.get(refs, projectId),
        issues: (projectId) =>
          source
            .issues(projectId)
            .pipe(Effect.map((issues) => filterIssues(issues, predicate))),
        findById: (projectId, issueId) =>
          source
            .findById(projectId, issueId)
            .pipe(Effect.map((issue) => (matchesIssue(issue) ? issue : null))),
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
                matchesIssue(issue)
                  ? source.ensureInProgress(projectId, issueId)
                  : Effect.void,
              ),
            ),
      })
    }),
  )

export const scopeIssueSourceToParentIssueSourceId = (
  parentIssueSourceId: string,
) => {
  const scoped = scopeIssueSource(
    (issue) => issue.parentIssueSourceId === parentIssueSourceId,
    isChildOfParentIssueSourceId(parentIssueSourceId),
  )

  return Layer.effect(
    IssueSource,
    Effect.gen(function* () {
      const source = yield* IssueSource

      return IssueSource.of({
        ...source,
        createIssue: (projectId, issue) =>
          source.createIssue(projectId, issue.update({ parentIssueSourceId })),
      })
    }),
  ).pipe(Layer.provide(scoped))
}

export const scopeIssueSourceToTopLevelIssues = () =>
  scopeIssueSource(
    (issue) => issue.parentIssueSourceId === undefined,
    isTopLevelIssue,
  )

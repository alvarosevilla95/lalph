import { Data, Effect, Option } from "effect"
import type { IssueSelectionMode } from "./domain/Project.ts"
import { ensureGithubParentIssueBinding } from "./GithubParentProject.ts"

export class GithubSubIssueLinkError extends Data.TaggedError(
  "GithubSubIssueLinkError",
)<{
  readonly cause: unknown
  readonly parentIssueNumber: number
  readonly issueNumber: number
  readonly issueUrl: string
}> {
  readonly message = `Created GitHub issue #${this.issueNumber} (${this.issueUrl}) but failed to link it under parent issue #${this.parentIssueNumber}. Link it manually in GitHub and retry.`
}

export type CreatedGithubIssue = {
  readonly number: number
  readonly url: string
}

export type CreateGithubIssueForProjectOptions = {
  readonly projectId: string
  readonly issueSelectionMode: IssueSelectionMode
  readonly githubParentIssueNumber: Option.Option<number>
  readonly title: string
  readonly body: string
  readonly labels: ReadonlyArray<string>
  readonly blockedByNumbers: ReadonlyArray<number>
}

export type CreateGithubIssueForProjectDeps = {
  readonly createGithubIssue: (options: {
    readonly title: string
    readonly body: string
    readonly labels: ReadonlyArray<string>
  }) => Effect.Effect<CreatedGithubIssue, unknown>
  readonly addBlockedByDependency: (options: {
    readonly issueNumber: number
    readonly blockedByNumber: number
  }) => Effect.Effect<void, unknown>
  readonly addGithubSubIssue: (options: {
    readonly issueNumber: number
    readonly subIssueUrl: string
  }) => Effect.Effect<void, unknown>
  readonly sleep: typeof Effect.sleep
}

export const createGithubIssueForProject = Effect.fnUntraced(function* (
  options: CreateGithubIssueForProjectOptions,
  deps: CreateGithubIssueForProjectDeps,
) {
  yield* ensureGithubParentIssueBinding({
    projectId: options.projectId,
    issueSelectionMode: options.issueSelectionMode,
    githubParentIssueNumber: options.githubParentIssueNumber,
    action: "creating GitHub issues for this project",
  })

  const created = yield* deps.createGithubIssue({
    title: options.title,
    body: options.body,
    labels: options.labels,
  })

  if (options.blockedByNumbers.length > 0) {
    yield* Effect.forEach(
      options.blockedByNumbers,
      (dependencyNumber) =>
        deps.addBlockedByDependency({
          issueNumber: created.number,
          blockedByNumber: dependencyNumber,
        }),
      { concurrency: 5, discard: true },
    )
  }

  if (
    options.issueSelectionMode === "github-parent" &&
    Option.isSome(options.githubParentIssueNumber)
  ) {
    const parentIssueNumber = options.githubParentIssueNumber.value

    yield* deps
      .addGithubSubIssue({
        issueNumber: parentIssueNumber,
        subIssueUrl: created.url,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new GithubSubIssueLinkError({
              cause,
              parentIssueNumber,
              issueNumber: created.number,
              issueUrl: created.url,
            }),
        ),
      )
  }

  yield* deps.sleep("2 seconds")

  return {
    id: `#${created.number}`,
    url: created.url,
  } as const
})

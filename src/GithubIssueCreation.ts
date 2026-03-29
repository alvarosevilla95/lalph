import { Data, Effect, Option, Schema } from "effect"

export class GithubIssueCreationParentMissing extends Data.TaggedError(
  "GithubIssueCreationParentMissing",
)<{
  readonly projectId: string
}> {
  readonly message = `Project "${this.projectId}" is configured with issueSelectionMode="github-parent" but has no bound parent issue. Run 'lalph projects edit' to bind one before running 'lalph issue'.`
}

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

export const GithubIssueSelectionMode = Schema.Literals([
  "filtered",
  "github-parent",
])
export type GithubIssueSelectionMode = typeof GithubIssueSelectionMode.Type

export type CreatedGithubIssue = {
  readonly number: number
  readonly url: string
}

export type CreateGithubIssueForProjectOptions = {
  readonly projectId: string
  readonly issueSelectionMode: GithubIssueSelectionMode
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
  if (
    options.issueSelectionMode === "github-parent" &&
    Option.isNone(options.githubParentIssueNumber)
  ) {
    return yield* new GithubIssueCreationParentMissing({
      projectId: options.projectId,
    })
  }

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

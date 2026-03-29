import { Data, Effect, Option } from "effect"
import {
  getProjectIssueSelectionMode,
  type IssueSelectionMode,
  type Project,
} from "./domain/Project.ts"

export type GithubParentBinding = {
  readonly projectId: string
  readonly issueSelectionMode: IssueSelectionMode
  readonly githubParentIssueNumber: Option.Option<number>
}

export class GithubParentProjectUnbound extends Data.TaggedError(
  "GithubParentProjectUnbound",
)<{
  readonly projectId: string
  readonly action: string
}> {
  readonly message = `Project "${this.projectId}" is configured with issueSelectionMode="github-parent" but has no bound parent issue. Run 'lalph projects edit' to bind one before ${this.action}.`
}

export const toGithubParentBinding = (
  project: Project,
): GithubParentBinding => ({
  projectId: project.id,
  issueSelectionMode:
    project.gitFlow === "pr"
      ? getProjectIssueSelectionMode(project)
      : "filtered",
  githubParentIssueNumber: Option.fromUndefinedOr(
    project.githubParentIssueNumber,
  ),
})

export const ensureGithubParentIssueBinding = Effect.fnUntraced(
  function* (options: {
    readonly projectId: GithubParentBinding["projectId"]
    readonly issueSelectionMode: GithubParentBinding["issueSelectionMode"]
    readonly githubParentIssueNumber: GithubParentBinding["githubParentIssueNumber"]
    readonly action: string
  }) {
    if (
      options.issueSelectionMode === "github-parent" &&
      Option.isNone(options.githubParentIssueNumber)
    ) {
      return yield* new GithubParentProjectUnbound({
        projectId: options.projectId,
        action: options.action,
      })
    }
  },
)

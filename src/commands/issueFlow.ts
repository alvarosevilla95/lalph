import { Data } from "effect"
import { isGithubParentProject, type Project } from "../domain/Project.ts"

export class IssueCommandGithubParentMissing extends Data.TaggedError(
  "IssueCommandGithubParentMissing",
)<{
  readonly projectId: Project["id"]
}> {
  readonly message = `Project "${this.projectId}" is configured with issueSelectionMode="github-parent" but has no bound parent issue. Run 'lalph projects edit' to bind one before running 'lalph issue'.`
}

export const assertIssueCommandProjectIsReady = (project: Project): void => {
  if (
    isGithubParentProject(project) &&
    project.githubParentIssueNumber === undefined
  ) {
    throw new IssueCommandGithubParentMissing({
      projectId: project.id,
    })
  }
}

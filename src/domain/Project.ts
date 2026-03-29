import { Schema } from "effect"

export const ProjectId = Schema.String.pipe(Schema.brand("lalph/ProjectId"))
export type ProjectId = typeof ProjectId.Type

export const IssueSelectionMode = Schema.Literals(["filtered", "github-parent"])
export type IssueSelectionMode = typeof IssueSelectionMode.Type

export const getProjectIssueSelectionMode = (project: {
  readonly issueSelectionMode?: IssueSelectionMode | undefined
}): IssueSelectionMode => project.issueSelectionMode ?? "filtered"

export const isGithubParentProject = (project: {
  readonly gitFlow: "pr" | "commit" | "ralph"
  readonly issueSelectionMode?: IssueSelectionMode | undefined
}): boolean =>
  project.gitFlow === "pr" &&
  getProjectIssueSelectionMode(project) === "github-parent"

export const deriveGithubParentTargetBranch = (issueNumber: number): string =>
  `lalph/parent-${issueNumber}`

export class Project extends Schema.Class<Project>("lalph/Project")({
  id: ProjectId,
  enabled: Schema.Boolean,
  targetBranch: Schema.Option(Schema.String),
  concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  gitFlow: Schema.Literals(["pr", "commit", "ralph"]),
  issueSelectionMode: Schema.optional(IssueSelectionMode),
  githubParentIssueNumber: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  specPath: Schema.optional(Schema.String),
  ralphSpec: Schema.optional(Schema.String),
  researchAgent: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  reviewAgent: Schema.Boolean,
}) {
  update(updates: Partial<Project>): Project {
    return new Project({
      ...this,
      ...updates,
    })
  }
}

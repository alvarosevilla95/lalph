import { Array, Data, Effect, Layer, Option, Path, pipe, String } from "effect"
import {
  deriveGithubParentTargetBranch,
  getProjectIssueSelectionMode,
  type IssueSelectionMode,
  Project,
  ProjectId,
} from "./domain/Project.ts"
import { allProjects, CurrentProjectId, Settings } from "./Settings.ts"
import { Prompt } from "effect/unstable/cli"
import { IssueSource } from "./IssueSource.ts"
import { CurrentIssueSource } from "./CurrentIssueSource.ts"
import { findProjectRoot } from "./shared/lalphDirectory.ts"
import { Github } from "./Github.ts"
import { GithubCli } from "./Github/Cli.ts"

export const layerProjectIdPrompt = Layer.effect(
  CurrentProjectId,
  Effect.gen(function* () {
    const project = yield* selectProject
    return project.id
  }),
).pipe(
  Layer.provide(Settings.layer),
  Layer.provide(CurrentIssueSource.layer),
  Layer.provide(Github.layer),
  Layer.provide(GithubCli.layer),
)

export const getAllProjects = Settings.get(allProjects).pipe(
  Effect.map(Option.getOrElse((): ReadonlyArray<Project> => [])),
)

export const projectById = Effect.fnUntraced(function* (projectId: ProjectId) {
  const projects = yield* getAllProjects
  return Array.findFirst(projects, (p) => p.id === projectId)
})

export class ProjectNotFound extends Data.TaggedError("ProjectNotFound")<{
  readonly projectId: ProjectId
}> {
  readonly message = `Project "${this.projectId}" not found`
}

const formatIssueSelectionMode = (issueSelectionMode: IssueSelectionMode) =>
  issueSelectionMode === "filtered" ? "Filtered" : "GitHub parent"

const formatGithubParentIssue = (issueNumber: number | undefined): string =>
  issueNumber === undefined ? "Unbound" : `#${issueNumber}`

const parseGithubIssueNumber = (
  input: string,
): { readonly _tag: "empty" | "invalid" | "some"; readonly value?: number } => {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return { _tag: "empty" }
  }
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return { _tag: "invalid" }
  }
  return { _tag: "some", value: Number(trimmed) }
}

const githubValidationMessage = (cause: unknown, fallback: string): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.length > 0
  ) {
    return cause.message
  }
  return fallback
}

const validateGithubParentIssueNumber = Effect.fnUntraced(function* (
  issueNumber: number,
) {
  const github = yield* Github
  const cli = yield* GithubCli
  const issue = yield* github
    .request((rest) =>
      rest.issues.get({
        owner: cli.owner,
        repo: cli.repo,
        issue_number: issueNumber,
      }),
    )
    .pipe(
      Effect.catchTag("GithubError", ({ cause }) => {
        const notFound =
          typeof cause === "object" &&
          cause !== null &&
          "status" in cause &&
          cause.status === 404
        if (notFound) {
          return Effect.fail(
            `GitHub issue #${issueNumber} was not found in ${cli.owner}/${cli.repo}.`,
          )
        }
        return Effect.fail(
          `Failed to validate GitHub issue #${issueNumber}: ${githubValidationMessage(
            cause,
            "unknown GitHub error",
          )}`,
        )
      }),
    )

  if (issue.data.pull_request !== undefined) {
    return yield* Effect.fail(
      `GitHub issue #${issueNumber} is a pull request and cannot be used as a parent issue.`,
    )
  }
})

const promptGithubParentIssueNumber = Effect.fnUntraced(function* (
  currentIssueNumber: number | undefined,
) {
  while (true) {
    const parentIssueInput = yield* Prompt.text({
      message: "Parent GitHub issue number (leave empty to clear)",
      default: currentIssueNumber?.toString() ?? "",
      validate(input) {
        const parsed = parseGithubIssueNumber(input)
        if (parsed._tag !== "invalid") {
          return Effect.succeed(input)
        }
        return Effect.fail("Parent issue number must be a positive integer.")
      },
    })
    const parsed = parseGithubIssueNumber(parentIssueInput)
    if (parsed._tag === "empty") {
      return undefined
    }
    if (parsed._tag === "invalid") {
      continue
    }

    const issueNumber = parsed.value!
    const validationError = yield* validateGithubParentIssueNumber(
      issueNumber,
    ).pipe(
      Effect.match({
        onFailure: (message) => Option.some(message),
        onSuccess: () => Option.none<string>(),
      }),
    )

    if (Option.isNone(validationError)) {
      return issueNumber
    }

    console.log("")
    console.log(validationError.value)
    console.log("")
  }
})

// Prompts

export const selectProject = Effect.gen(function* () {
  const projects = yield* getAllProjects
  if (projects.length === 0) {
    return yield* welcomeWizard
  } else if (projects.length === 1) {
    const project = projects[0]!
    yield* Effect.log(`Using project: ${project.id}`)
    return project
  }
  const selection = yield* Prompt.autoComplete({
    message: "Select a project:",
    choices: projects.map((p) => ({
      title: p.id,
      value: p,
    })),
  })
  return selection!
})

export const welcomeWizard = Effect.gen(function* () {
  const welcome = [
    "  .--.",
    " |^()^|  lalph",
    "  '--'",
    "",
    "Let's add your first project.",
    "Projects let you configure how lalph runs tasks.",
    "",
  ].join("\n")
  console.log(welcome)
  return yield* addOrUpdateProject()
})

export const addOrUpdateProject = Effect.fnUntraced(function* (
  existing?: Project,
  fromPlanMode = false,
) {
  const pathService = yield* Path.Path
  const currentIssueSource = yield* CurrentIssueSource
  const projects = yield* getAllProjects
  const id = existing
    ? existing.id
    : yield* Prompt.text({
        message: "Project name",
        validate(input) {
          input = input.trim()
          if (input.length === 0) {
            return Effect.fail("Project name cannot be empty")
          } else if (projects.some((p) => p.id === input)) {
            return Effect.fail("Project already exists")
          }
          return Effect.succeed(input)
        },
      })
  const concurrency = yield* Prompt.integer({
    message: "Concurrency (number of tasks to run in parallel)",
    min: 1,
  })
  const targetBranch = pipe(
    yield* Prompt.text({
      message: "Target branch (leave empty to use HEAD)",
      default: existing
        ? Option.getOrElse(existing.targetBranch, () => "")
        : "",
    }),
    String.trim,
    Option.liftPredicate(String.isNonEmpty),
  )
  const gitFlow = yield* Prompt.select({
    message: "Git flow",
    choices: [
      {
        title: "Pull Request",
        description: "Create a pull request for each task",
        value: "pr",
        selected: existing ? existing.gitFlow === "pr" : false,
      },
      {
        title: "Commit",
        description: "Tasks are committed directly to the target branch",
        value: "commit",
        selected: existing ? existing.gitFlow === "commit" : false,
      },
      {
        title: "Ralph",
        description: "Tasks are determined from a spec file",
        value: "ralph",
        selected: existing ? existing.gitFlow === "ralph" : false,
      },
    ] as const,
  })

  let ralphSpec = Option.none<string>()
  if (gitFlow === "ralph" && !fromPlanMode) {
    const cwd = pathService.resolve(".")
    const relativeRoot = pipe(
      yield* findProjectRoot(cwd),
      Option.getOrElse(() => cwd),
    )
    ralphSpec = yield* Prompt.file({
      message: "Path to Ralph spec file",
    }).pipe(
      Effect.fromYieldable,
      Effect.map((selectedPath) =>
        pathService.relative(relativeRoot, selectedPath),
      ),
      Effect.map(Option.some),
    )
  }

  let issueSelectionMode: IssueSelectionMode | undefined = undefined
  if (gitFlow === "pr") {
    if (currentIssueSource.id === "github") {
      issueSelectionMode = yield* Prompt.select({
        message: "Issue selection mode",
        choices: [
          {
            title: "Filtered",
            description: "Use the current GitHub project and label filters",
            value: "filtered",
            selected:
              (existing
                ? getProjectIssueSelectionMode(existing)
                : "filtered") === "filtered",
          },
          {
            title: "GitHub parent",
            description: "Use the direct child issues of one parent issue",
            value: "github-parent",
            selected:
              (existing
                ? getProjectIssueSelectionMode(existing)
                : "filtered") === "github-parent",
          },
        ] as const,
      })
    } else {
      issueSelectionMode = "filtered"
    }
  }

  let githubParentIssueNumber = existing?.githubParentIssueNumber
  if (gitFlow === "pr" && issueSelectionMode === "github-parent") {
    console.log("")
    console.log(
      "GitHub parent mode selects work from the direct child issues of one parent issue.",
    )
    console.log(
      "Leave the parent issue empty to keep the project unbound until plan mode creates one.",
    )
    console.log(
      "Warning: rebinding the parent issue changes future workset membership.",
    )
    console.log("")

    githubParentIssueNumber = yield* promptGithubParentIssueNumber(
      existing?.githubParentIssueNumber,
    )

    if (
      existing?.githubParentIssueNumber !== undefined &&
      existing.githubParentIssueNumber !== githubParentIssueNumber
    ) {
      console.log("")
      console.log(
        githubParentIssueNumber === undefined
          ? "Cleared the parent issue binding. Future runs stay unbound until you attach a new parent issue."
          : `Rebound the parent issue from #${existing.githubParentIssueNumber} to #${githubParentIssueNumber}. Future workset membership will follow the new parent.`,
      )
      console.log("")
    }
  }

  const resolvedTargetBranch =
    gitFlow === "pr" &&
    issueSelectionMode === "github-parent" &&
    githubParentIssueNumber !== undefined &&
    Option.isNone(targetBranch)
      ? Option.some(deriveGithubParentTargetBranch(githubParentIssueNumber))
      : targetBranch

  if (
    gitFlow === "pr" &&
    issueSelectionMode === "github-parent" &&
    githubParentIssueNumber !== undefined &&
    Option.isNone(targetBranch)
  ) {
    console.log(
      `Derived target branch: ${deriveGithubParentTargetBranch(githubParentIssueNumber)}`,
    )
  }

  const researchAgent = yield* Prompt.toggle({
    message: "Enable research agent?",
    initial: existing ? existing.researchAgent : false,
  })
  const reviewAgent = yield* Prompt.toggle({
    message: "Enable review agent?",
    initial: existing ? existing.reviewAgent : false,
  })

  const project = new Project({
    id: ProjectId.makeUnsafe(id),
    enabled: existing ? existing.enabled : true,
    concurrency,
    targetBranch: resolvedTargetBranch,
    gitFlow,
    issueSelectionMode,
    githubParentIssueNumber,
    specPath: existing?.specPath,
    ralphSpec: Option.getOrUndefined(ralphSpec),
    researchAgent,
    reviewAgent,
  })
  yield* Settings.set(
    allProjects,
    Option.some(
      existing
        ? projects.map((p) => (p.id === project.id ? project : p))
        : [...projects, project],
    ),
  )

  const source = yield* IssueSource
  yield* source.reset.pipe(Effect.provideService(CurrentProjectId, project.id))
  if (gitFlow !== "ralph") {
    yield* source.settings(project.id)
  }

  return project
})

export const describeProjectIssueSelectionMode = (
  project: Project,
): string | undefined =>
  project.gitFlow === "pr"
    ? formatIssueSelectionMode(getProjectIssueSelectionMode(project))
    : undefined

export const describeProjectGithubParentIssue = (
  project: Project,
): string | undefined =>
  project.gitFlow === "pr" &&
  getProjectIssueSelectionMode(project) === "github-parent"
    ? formatGithubParentIssue(project.githubParentIssueNumber)
    : undefined

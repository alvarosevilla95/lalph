import {
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  pipe,
  Schema,
} from "effect"
import { PromptGen } from "../PromptGen.ts"
import { Prd } from "../Prd.ts"
import { Worktree } from "../Worktree.ts"
import { Command, Flag } from "effect/unstable/cli"
import { CurrentIssueSource } from "../CurrentIssueSource.ts"
import { commandRoot } from "./root.ts"
import { allProjects, CurrentProjectId, Settings } from "../Settings.ts"
import { addOrUpdateProject, selectProject } from "../Projects.ts"
import { agentPlanner } from "../Agents/planner.ts"
import { agentTasker } from "../Agents/tasker.ts"
import { commandPlanTasks } from "./plan/tasks.ts"
import { Editor } from "../Editor.ts"
import { selectCliAgentPreset } from "../Presets.ts"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { parseBranch } from "../shared/git.ts"
import type { CliAgentPreset } from "../domain/CliAgentPreset.ts"
import { ClankaMuxerLayer } from "../Clanka.ts"
import { createGithubIssue, Github } from "../Github.ts"
import { GithubCli } from "../Github/Cli.ts"
import {
  deriveGithubParentTargetBranch,
  isGithubParentProject,
  type Project,
} from "../domain/Project.ts"

const dangerous = Flag.boolean("dangerous").pipe(
  Flag.withAlias("d"),
  Flag.withDescription(
    "Skip permission prompts while generating the specification from your plan",
  ),
)

const withNewProject = Flag.boolean("new").pipe(
  Flag.withAlias("n"),
  Flag.withDescription(
    "Create a new project (via prompts) before starting plan mode",
  ),
)

const file = Flag.file("file", { mustExist: true }).pipe(
  Flag.withAlias("f"),
  Flag.withDescription(
    "Read the plan from a markdown file instead of opening an editor",
  ),
  Flag.optional,
)

export const commandPlan = Command.make("plan", {
  dangerous,
  withNewProject,
  file,
}).pipe(
  Command.withDescription(
    "Draft a plan in your editor (or use --file); then generate a specification under --specs and create PRD tasks from it. Use --new to create a project first, and --dangerous to skip permission prompts during spec generation.",
  ),
  Command.withHandler(
    Effect.fnUntraced(
      function* ({ dangerous, withNewProject, file }) {
        yield* Effect.gen(function* () {
          const project = withNewProject
            ? yield* addOrUpdateProject(undefined, true)
            : yield* selectProject

          if (
            isGithubParentProject(project) &&
            project.githubParentIssueNumber !== undefined
          ) {
            return yield* new GithubParentPlanAlreadyBound({
              projectId: project.id,
              githubParentIssueNumber: project.githubParentIssueNumber,
            })
          }

          const editor = yield* Editor
          const fs = yield* FileSystem.FileSystem

          const thePlan = yield* Effect.matchEffect(file.asEffect(), {
            onFailure: () => editor.editTemp({ suffix: ".md" }),
            onSuccess: (path) => fs.readFileString(path).pipe(Effect.asSome),
          })

          if (Option.isNone(thePlan)) return

          yield* Effect.addFinalizer((exit) => {
            if (Exit.isSuccess(exit)) return Effect.void
            return pipe(
              editor.saveTemp(thePlan.value, { suffix: ".md" }),
              Effect.flatMap((file) =>
                Effect.log(`Saved your plan to: ${file}`),
              ),
              Effect.ignore,
            )
          })

          const { specsDirectory } = yield* commandRoot
          const preset = yield* selectCliAgentPreset

          yield* plan({
            plan: thePlan.value,
            specsDirectory,
            dangerous,
            preset,
            project,
          }).pipe(Effect.provideService(CurrentProjectId, project.id))
        }).pipe(
          Effect.provide([
            Settings.layer,
            CurrentIssueSource.layer,
            ClankaMuxerLayer,
          ]),
        )
      },
      Effect.scoped,
      Effect.provide(Editor.layer),
    ),
  ),
  Command.withSubcommands([commandPlanTasks]),
)

const plan = Effect.fnUntraced(
  function* (options: {
    readonly plan: string
    readonly specsDirectory: string
    readonly dangerous: boolean
    readonly preset: CliAgentPreset
    readonly project: Project
  }) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const worktree = yield* Worktree
    const projectId = yield* CurrentProjectId
    const ralph = options.project.gitFlow === "ralph"
    const githubParent = isGithubParentProject(options.project)

    yield* agentPlanner({
      plan: options.plan,
      specsDirectory: options.specsDirectory,
      dangerous: options.dangerous,
      preset: options.preset,
      ralph,
    })

    const planDetails = yield* pipe(
      fs.readFileString(
        pathService.join(worktree.directory, ".lalph", "plan.json"),
      ),
      Effect.flatMap(Schema.decodeEffect(PlanDetails)),
      Effect.mapError(() => new SpecNotFound()),
    )

    if (ralph) {
      yield* Settings.update(
        allProjects,
        Option.map((projects) =>
          projects.map((p) =>
            p.id === projectId
              ? p.update({ ralphSpec: planDetails.specification })
              : p,
          ),
        ),
      )
    }

    let targetBranch = options.project.targetBranch

    if (githubParent) {
      const githubParentDetails = yield* createGithubParentPlan({
        plan: options.plan,
        project: options.project,
        specificationPath: planDetails.specification,
      })

      targetBranch = Option.some(githubParentDetails.targetBranch)

      yield* commitAndPushSpecification({
        specsDirectory: options.specsDirectory,
        targetBranch: githubParentDetails.targetBranch,
      })

      yield* bindGithubParentProject({
        projectId,
        githubParentIssueNumber: githubParentDetails.parentIssueNumber,
        specificationPath: planDetails.specification,
        targetBranch: githubParentDetails.targetBranch,
      })
    } else if (Option.isSome(targetBranch)) {
      yield* commitAndPushSpecification({
        specsDirectory: options.specsDirectory,
        targetBranch: targetBranch.value,
      })
    }

    if (!ralph) {
      yield* Effect.log("Converting specification into tasks")

      yield* agentTasker({
        specificationPath: planDetails.specification,
        specsDirectory: options.specsDirectory,
        preset: options.preset,
      })
    }

    if (!worktree.inExisting) {
      yield* pipe(
        fs.copy(
          pathService.join(worktree.directory, options.specsDirectory),
          options.specsDirectory,
          { overwrite: true },
        ),
        Effect.ignore,
      )
    }
  },
  Effect.scoped,
  (effect, options) =>
    Effect.provide(effect, [
      PromptGen.layer,
      options.project.gitFlow === "ralph" ? Prd.layerNoop : Prd.layerProvided,
      Worktree.layer,
      Settings.layer,
      CurrentIssueSource.layer,
    ]),
)

export class SpecNotFound extends Data.TaggedError("SpecNotFound") {
  readonly message = "The AI agent failed to produce a specification."
}

export class GithubParentPlanAlreadyBound extends Data.TaggedError(
  "GithubParentPlanAlreadyBound",
)<{
  readonly projectId: Project["id"]
  readonly githubParentIssueNumber: number
}> {
  readonly message = `Project "${this.projectId}" is already bound to GitHub parent issue #${this.githubParentIssueNumber}. Use 'lalph issue' to add child issues instead of rerunning 'lalph plan'.`
}

export class SpecGitError extends Data.TaggedError("SpecGitError")<{
  readonly message: string
}> {}

const createGithubParentPlan = Effect.fnUntraced(function* (options: {
  readonly plan: string
  readonly project: Project
  readonly specificationPath: string
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const worktree = yield* Worktree

  const specificationContent = yield* fs.readFileString(
    pathService.join(worktree.directory, options.specificationPath),
  )
  const title =
    firstMarkdownHeading(specificationContent) ??
    firstMarkdownHeading(options.plan) ??
    pathService.basename(options.specificationPath, ".md")
  const summary =
    summarizeMarkdownSection(specificationContent, "Summary") ??
    summarizeMarkdown(options.plan)
  const body = [
    `Tracks the implementation plan described in \`${options.specificationPath}\`.`,
    "",
    summary ? `Summary: ${summary}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

  const parentIssue = yield* createGithubIssue({
    title,
    body,
  }).pipe(Effect.provide([Github.layer, GithubCli.layer]))

  return {
    parentIssueNumber: parentIssue.number,
    targetBranch: Option.match(options.project.targetBranch, {
      onNone: () => deriveGithubParentTargetBranch(parentIssue.number),
      onSome: (value) => value,
    }),
  } as const
})

const bindGithubParentProject = Effect.fnUntraced(function* (options: {
  readonly projectId: Project["id"]
  readonly githubParentIssueNumber: number
  readonly specificationPath: string
  readonly targetBranch: string
}) {
  yield* Settings.update(
    allProjects,
    Option.map((projects) =>
      projects.map((project) =>
        project.id === options.projectId
          ? project.update({
              githubParentIssueNumber: options.githubParentIssueNumber,
              specPath: options.specificationPath,
              targetBranch: Option.isSome(project.targetBranch)
                ? project.targetBranch
                : Option.some(options.targetBranch),
            })
          : project,
      ),
    ),
  )
})

const commitAndPushSpecification = Effect.fnUntraced(
  function* (options: {
    readonly specsDirectory: string
    readonly targetBranch: string
  }) {
    const worktree = yield* Worktree
    const pathService = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const absSpecsDirectory = pathService.join(
      worktree.directory,
      options.specsDirectory,
    )

    const git = (args: ReadonlyArray<string>) =>
      ChildProcess.make("git", [...args], {
        cwd: worktree.directory,
        stdout: "inherit",
        stderr: "inherit",
      }).pipe(spawner.exitCode)

    const addCode = yield* git(["add", absSpecsDirectory])
    if (addCode !== 0) {
      return yield* new SpecGitError({
        message: "Failed to stage specification changes.",
      })
    }

    const commitCode = yield* git(["commit", "-m", "Update plan specification"])
    if (commitCode !== 0) {
      return yield* new SpecGitError({
        message: "Failed to commit the generated specification changes.",
      })
    }

    const parsed = parseBranch(options.targetBranch)
    yield* git(["push", parsed.remote, `HEAD:${parsed.branch}`])
  },
  Effect.ignore({ log: "Warn" }),
)

const PlanDetails = Schema.fromJsonString(
  Schema.Struct({
    specification: Schema.String,
  }),
)

const firstMarkdownHeading = (content: string): string | undefined => {
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim()
    }
  }

  return summarizeMarkdown(content, 120)
}

const summarizeMarkdownSection = (
  content: string,
  title: string,
): string | undefined => {
  const lines = content.split("\n")
  const normalizedTitle = title.trim().toLowerCase()
  let inSection = false
  const collected: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (/^##\s+/.test(trimmed)) {
      const heading = trimmed.slice(3).trim().toLowerCase()
      if (inSection) {
        break
      }
      inSection = heading === normalizedTitle
      continue
    }

    if (!inSection) {
      continue
    }

    collected.push(line)
  }

  return summarizeMarkdown(collected.join("\n"))
}

const summarizeMarkdown = (
  content: string,
  maxLength = 280,
): string | undefined => {
  const summary = content
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, ""),
    )
    .filter((line) => line.length > 0 && !line.startsWith("```"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

  if (summary.length === 0) {
    return undefined
  }

  return summary.length <= maxLength
    ? summary
    : `${summary.slice(0, maxLength - 1).trimEnd()}…`
}

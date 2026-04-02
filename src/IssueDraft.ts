import { Data, Effect, Exit, FileSystem, Option, Path, Schema } from "effect"
import * as Yaml from "yaml"
import { Editor } from "./Editor.ts"
import { IssueSource } from "./IssueSource.ts"
import { PrdIssue } from "./domain/PrdIssue.ts"
import type { ProjectId } from "./domain/Project.ts"
import { resolveLalphDirectory } from "./shared/lalphDirectory.ts"
import { Prompt } from "effect/unstable/cli"

export const issueTemplate = `---
title: Issue Title
priority: 3
estimate: null
blockedBy: []
autoMerge: false
---

`

export const issueTitlePlaceholder = "Issue Title"

export const interactiveIssueDraftRelativePath = ".lalph/issue-draft.md"

const FrontMatterSchema = Schema.toCodecJson(
  Schema.Struct({
    title: Schema.String,
    priority: Schema.Finite,
    estimate: Schema.NullOr(Schema.Finite),
    blockedBy: Schema.Array(Schema.String),
    autoMerge: Schema.Boolean,
  }),
)

export class IssueDraftValidationError extends Data.TaggedError(
  "IssueDraftValidationError",
)<{
  readonly message: string
}> {}

export class InteractiveIssueDraftInProgress extends Data.TaggedError(
  "InteractiveIssueDraftInProgress",
)<{
  readonly draftPath: string
}> {
  readonly message = `An interactive issue draft is already in progress at ${this.draftPath}`
}

export class InteractiveIssueDraftMissing extends Data.TaggedError(
  "InteractiveIssueDraftMissing",
)<{
  readonly draftPath: string
}> {
  readonly message = `The interviewer did not create a draft at ${this.draftPath}`
}

export const parseIssueDraft = Effect.fn("parseIssueDraft")(function* (
  content: string,
): Effect.fn.Return<
  {
    readonly content: string
    readonly frontMatter: typeof FrontMatterSchema.Type
    readonly issue: PrdIssue
  },
  IssueDraftValidationError
> {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return yield* new IssueDraftValidationError({
      message: "Issue draft is empty.",
    })
  }

  const lines = trimmed.split("\n")
  if (lines[0]?.trim() !== "---") {
    return yield* new IssueDraftValidationError({
      message:
        "Issue draft must start with YAML front matter delimited by ---.",
    })
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  )
  if (endIndex === -1) {
    return yield* new IssueDraftValidationError({
      message: "Issue draft is missing the closing --- front matter delimiter.",
    })
  }

  const yamlContent = lines.slice(1, endIndex).join("\n")
  const description = lines
    .slice(endIndex + 1)
    .join("\n")
    .trim()

  const parsedYaml = yield* Effect.try({
    try: () => Yaml.parse(yamlContent),
    catch: (cause) =>
      new IssueDraftValidationError({
        message: `Failed to parse issue front matter: ${String(cause)}`,
      }),
  })

  const frontMatter = yield* Schema.decodeEffect(FrontMatterSchema)(
    parsedYaml,
  ).pipe(
    Effect.mapError(
      (cause) =>
        new IssueDraftValidationError({
          message: `Invalid issue front matter: ${String(cause)}`,
        }),
    ),
  )

  return {
    content: trimmed,
    frontMatter,
    issue: new PrdIssue({
      id: null,
      ...frontMatter,
      description,
      state: "todo",
    }),
  }
})

export const createIssueFromDraft = Effect.fn("createIssueFromDraft")(
  function* (options: {
    readonly projectId: ProjectId
    readonly content: string
  }) {
    const source = yield* IssueSource
    const parsed = yield* parseIssueDraft(options.content)
    const created = yield* source.createIssue(options.projectId, parsed.issue)
    return {
      created,
      parsed,
    }
  },
)

export const recoverIssueDraftOnFailure = Effect.fn(
  "recoverIssueDraftOnFailure",
)(function* (content: string) {
  const editor = yield* Editor

  yield* Effect.addFinalizer((exit) => {
    if (Exit.isSuccess(exit) || content.trim().length === 0) {
      return Effect.void
    }

    return editor.saveTemp(content, { suffix: ".md" }).pipe(
      Effect.flatMap((file) => Effect.log(`Saved your issue to: ${file}`)),
      Effect.ignore,
    )
  })
})

export const reviewIssueDraft = Effect.fn("reviewIssueDraft")(
  function* (options: {
    readonly initialContent?: string
    readonly path?: string
  }) {
    const editor = yield* Editor
    const fs = yield* FileSystem.FileSystem

    if (options.path) {
      const exitCode = yield* editor.edit(options.path)
      if (exitCode !== 0) {
        return Option.none<string>()
      }

      const content = (yield* fs.readFileString(options.path)).trim()
      if (content.length === 0) {
        return Option.none<string>()
      }

      return Option.some(content)
    }

    return yield* editor.editTemp({
      suffix: ".md",
      initialContent: options.initialContent ?? issueTemplate,
    })
  },
)

export const reviewIssueDraftFileUntilValid = Effect.fn(
  "reviewIssueDraftFileUntilValid",
)(function* (
  path: string,
  options?: {
    readonly validate?: (parsed: {
      readonly content: string
      readonly frontMatter: typeof FrontMatterSchema.Type
      readonly issue: PrdIssue
    }) => string | undefined
  },
) {
  while (true) {
    const content = yield* reviewIssueDraft({ path })
    if (Option.isNone(content)) {
      return Option.none<{
        readonly content: string
        readonly frontMatter: typeof FrontMatterSchema.Type
        readonly issue: PrdIssue
      }>()
    }

    let validationError: IssueDraftValidationError | undefined = undefined
    const parsed = yield* parseIssueDraft(content.value).pipe(
      Effect.match({
        onFailure: (error) => {
          validationError = error
          return Option.none<{
            readonly content: string
            readonly frontMatter: typeof FrontMatterSchema.Type
            readonly issue: PrdIssue
          }>()
        },
        onSuccess: Option.some,
      }),
    )
    if (Option.isSome(parsed)) {
      const validationMessage = options?.validate?.(parsed.value)
      if (validationMessage === undefined) {
        return parsed
      }
      yield* Effect.logError(validationMessage)
    } else {
      yield* Effect.logError(validationError!.message)
    }
    const reopen = yield* Prompt.toggle({
      message:
        "The issue draft is invalid. Reopen it in your editor to repair it?",
      initial: true,
    })
    if (!reopen) {
      return Option.none()
    }
  }
})

export const prepareInteractiveIssueDraftSession = Effect.fn(
  "prepareInteractiveIssueDraftSession",
)(function* () {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const root = yield* resolveLalphDirectory
  const draftPath = pathService.join(root, interactiveIssueDraftRelativePath)
  const lockPath = `${draftPath}.lock`

  yield* fs.makeDirectory(pathService.dirname(draftPath), {
    recursive: true,
  })

  if (yield* fs.exists(lockPath)) {
    return yield* new InteractiveIssueDraftInProgress({ draftPath })
  }

  if (yield* fs.exists(draftPath)) {
    const recoveredPath = pathService.join(
      pathService.dirname(draftPath),
      `issue-draft.recovered-${new Date().toISOString().replaceAll(":", "-")}.md`,
    )
    yield* fs.copy(draftPath, recoveredPath)
    yield* fs.remove(draftPath)
    yield* Effect.log(
      `Recovered a stale interactive issue draft to: ${recoveredPath}`,
    )
  }

  yield* fs.writeFileString(
    lockPath,
    `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\n`,
  )

  yield* Effect.addFinalizer(() =>
    fs.remove(lockPath, { force: true }).pipe(Effect.ignore),
  )

  return {
    root,
    draftPath,
    deleteDraft: fs.remove(draftPath, { force: true }).pipe(Effect.ignore),
    ensureDraftExists: fs.exists(draftPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? Effect.void
          : Effect.fail(
              new InteractiveIssueDraftMissing({
                draftPath,
              }),
            ),
      ),
    ),
  } as const
})

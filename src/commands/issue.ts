import { Command, Flag, Prompt } from "effect/unstable/cli"
import { CurrentIssueSource } from "../CurrentIssueSource.ts"
import { Effect, Option } from "effect"
import { CurrentProjectId, Settings } from "../Settings.ts"
import { layerProjectIdPrompt, selectProject } from "../Projects.ts"
import { Editor } from "../Editor.ts"
import {
  createIssueFromDraft,
  issueTemplate,
  issueTitlePlaceholder,
  parseIssueDraft,
  prepareInteractiveIssueDraftSession,
  recoverIssueDraftOnFailure,
  reviewIssueDraft,
  reviewIssueDraftFileUntilValid,
} from "../IssueDraft.ts"
import { selectCliAgentPreset } from "../Presets.ts"
import { agentIssueInterviewer } from "../Agents/issueInterviewer.ts"
import { PromptGen } from "../PromptGen.ts"

const interactive = Flag.boolean("interactive").pipe(
  Flag.withAlias("i"),
  Flag.withDescription(
    "Interview with a supported CLI agent to build .lalph/issue-draft.md, then require editor review before creating the issue.",
  ),
)

const printCreatedIssue = (created: {
  readonly id: string
  readonly url: string
}) =>
  Effect.sync(() => {
    console.log(`Created issue with ID: ${created.id}`)
    console.log(`URL: ${created.url}`)
  })

const runStandardIssue = Effect.fnUntraced(function* () {
  const content = yield* reviewIssueDraft({
    initialContent: issueTemplate,
  })
  if (Option.isNone(content)) {
    return
  }

  yield* recoverIssueDraftOnFailure(content.value)
  const projectId = yield* CurrentProjectId
  const parsed = yield* parseIssueDraft(content.value)

  if (parsed.frontMatter.title.trim() === issueTitlePlaceholder) {
    return
  }

  const created = yield* createIssueFromDraft({
    projectId,
    content: content.value,
  })

  yield* printCreatedIssue(created.created)
})

const runInteractiveIssue = Effect.fnUntraced(function* () {
  const project = yield* selectProject
  const sourceMeta = yield* CurrentIssueSource
  const request = yield* Prompt.text({
    message: "What issue do you want to create?",
    validate: (input) =>
      input.trim().length === 0
        ? Effect.fail("The issue request cannot be empty")
        : Effect.succeed(input),
  })
  const preset = yield* selectCliAgentPreset
  const draftSession = yield* prepareInteractiveIssueDraftSession()

  yield* agentIssueInterviewer({
    cwd: draftSession.root,
    projectId: project.id,
    issueSourceName: sourceMeta.name,
    request,
    draftPath: draftSession.draftPath,
    preset,
  })

  yield* draftSession.ensureDraftExists
  const reviewed = yield* reviewIssueDraftFileUntilValid(
    draftSession.draftPath,
    {
      validate: ({ frontMatter }) =>
        frontMatter.title.trim() === issueTitlePlaceholder
          ? "Issue draft title is still the placeholder value. Update the title before creating the issue."
          : undefined,
    },
  )
  if (Option.isNone(reviewed)) {
    yield* Effect.log(
      `Interactive issue draft preserved at: ${draftSession.draftPath}`,
    )
    return
  }

  const created = yield* createIssueFromDraft({
    projectId: project.id,
    content: reviewed.value.content,
  })

  yield* draftSession.deleteDraft
  yield* printCreatedIssue(created.created)
})

export const commandIssue = Command.make("issue", {
  interactive,
}).pipe(
  Command.withDescription(
    "Create a new issue either from your editor template or, with --interactive, by interviewing with a supported CLI agent and then reviewing the generated draft.",
  ),
  Command.withAlias("i"),
  Command.withHandler(
    Effect.fnUntraced(
      function* ({ interactive }) {
        if (interactive) {
          return yield* runInteractiveIssue()
        }

        return yield* runStandardIssue().pipe(
          Effect.provide([layerProjectIdPrompt, CurrentIssueSource.layer]),
        )
      },
      Effect.scoped,
      Effect.provide([
        Editor.layer,
        Settings.layer,
        CurrentIssueSource.layer,
        PromptGen.layer,
      ]),
    ),
  ),
)

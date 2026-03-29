import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Layer } from "effect"
import { CurrentIssueSource } from "../src/CurrentIssueSource.ts"
import { PromptGen } from "../src/PromptGen.ts"
import { PrdIssue } from "../src/domain/PrdIssue.ts"

const specPath = ".specs/github-parent-issue-selection.md"

const makePromptGen = () =>
  Effect.runPromise(
    Effect.provideService(
      PromptGen.make,
      CurrentIssueSource,
      CurrentIssueSource.of({
        id: "github",
        name: "GitHub Issues",
        layer: Layer.empty,
        githubPrInstructions: "Closes {task id}",
      }),
    ),
  )

const task = new PrdIssue({
  id: "#123",
  title: "Update github-parent prompts",
  description: "Thread specPath into worker and reviewer prompts.",
  priority: 3,
  estimate: null,
  state: "todo",
  blockedBy: [],
  autoMerge: false,
})

const gitFlow = {
  requiresGithubPr: true,
  branch: undefined,
  setupInstructions: () =>
    "You are already on a new branch for this task. You do not need to checkout any other branches.",
  commitInstructions: () => "Create a pull request for this task.",
  reviewInstructions:
    "You are already on the PR branch with their changes. After making any changes, commit and push them to the same pull request.",
}

test("github-parent prompts include the project spec when specPath exists", async () => {
  const promptGen = await makePromptGen()

  const workerPrompt = promptGen.prompt({
    task,
    targetBranch: "lalph/parent-77",
    specsDirectory: ".specs",
    githubPrNumber: undefined,
    gitFlow,
    projectSpecPath: specPath,
  })

  assert.match(
    workerPrompt,
    new RegExp(
      `review the project specification at \`${escapeRegExp(specPath)}\` before implementation`,
    ),
  )

  const reviewPrompt = promptGen.promptReview({
    prompt: workerPrompt,
    gitFlow,
    projectSpecPath: specPath,
  })

  assert.match(
    reviewPrompt,
    new RegExp(
      `review the project specification at \`${escapeRegExp(specPath)}\` before reviewing the implementation`,
    ),
  )
})

test("github-parent prompts stay unchanged when specPath is absent", async () => {
  const promptGen = await makePromptGen()

  const workerPrompt = promptGen.prompt({
    task,
    targetBranch: "lalph/parent-77",
    specsDirectory: ".specs",
    githubPrNumber: undefined,
    gitFlow,
  })

  assert.doesNotMatch(workerPrompt, /review the project specification at/)

  const reviewPrompt = promptGen.promptReview({
    prompt: workerPrompt,
    gitFlow,
  })

  assert.doesNotMatch(reviewPrompt, /review the project specification at/)
})

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

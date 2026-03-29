import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Option } from "effect"
import {
  createGithubIssueForProject,
  GithubIssueCreationParentMissing,
  GithubSubIssueLinkError,
} from "../build/GithubIssueCreation.js"
import {
  assertIssueCommandProjectIsReady,
  IssueCommandGithubParentMissing,
} from "../build/commands/issueFlow.js"

test("links created issues under the bound GitHub parent", async () => {
  const blockedByCalls = []
  const subIssueCalls = []

  const created = await Effect.runPromise(
    createGithubIssueForProject(
      {
        projectId: "project-alpha",
        issueSelectionMode: "github-parent",
        githubParentIssueNumber: Option.some(77),
        title: "Add child issue support",
        body: "Implement automatic child linking.",
        labels: ["feature"],
        blockedByNumbers: [12, 18],
      },
      {
        createGithubIssue: () =>
          Effect.succeed({
            number: 145,
            url: "https://github.com/acme/lalph/issues/145",
          }),
        addBlockedByDependency: (options) =>
          Effect.sync(() => {
            blockedByCalls.push(options)
          }),
        addGithubSubIssue: (options) =>
          Effect.sync(() => {
            subIssueCalls.push(options)
          }),
        sleep: () => Effect.void,
      },
    ),
  )

  assert.deepEqual(created, {
    id: "#145",
    url: "https://github.com/acme/lalph/issues/145",
  })
  assert.deepEqual(blockedByCalls, [
    { issueNumber: 145, blockedByNumber: 12 },
    { issueNumber: 145, blockedByNumber: 18 },
  ])
  assert.deepEqual(subIssueCalls, [
    {
      issueNumber: 77,
      subIssueUrl: "https://github.com/acme/lalph/issues/145",
    },
  ])
})

test("fails fast when a github-parent project has no bound parent", async () => {
  assert.throws(
    () =>
      assertIssueCommandProjectIsReady({
        id: "project-alpha",
        enabled: true,
        targetBranch: Option.none(),
        concurrency: 1,
        gitFlow: "pr",
        issueSelectionMode: "github-parent",
        researchAgent: false,
        reviewAgent: false,
      }),
    (error) => {
      assert.ok(error instanceof IssueCommandGithubParentMissing)
      assert.match(error.message, /lalph issue/)
      return true
    },
  )

  await assert.rejects(
    () =>
      Effect.runPromise(
        createGithubIssueForProject(
          {
            projectId: "project-alpha",
            issueSelectionMode: "github-parent",
            githubParentIssueNumber: Option.none(),
            title: "Unbound child issue",
            body: "",
            labels: [],
            blockedByNumbers: [],
          },
          {
            createGithubIssue: () =>
              Effect.die("issue creation should not be attempted"),
            addBlockedByDependency: () => Effect.void,
            addGithubSubIssue: () => Effect.void,
            sleep: () => Effect.void,
          },
        ),
      ),
    (error) => {
      assert.ok(error instanceof GithubIssueCreationParentMissing)
      assert.match(error.message, /lalph projects edit/)
      return true
    },
  )
})

test("reports the created issue when child linking fails", async () => {
  let createCalls = 0

  await assert.rejects(
    () =>
      Effect.runPromise(
        createGithubIssueForProject(
          {
            projectId: "project-alpha",
            issueSelectionMode: "github-parent",
            githubParentIssueNumber: Option.some(77),
            title: "Child that fails to link",
            body: "",
            labels: [],
            blockedByNumbers: [],
          },
          {
            createGithubIssue: () =>
              Effect.sync(() => {
                createCalls += 1
                return {
                  number: 203,
                  url: "https://github.com/acme/lalph/issues/203",
                }
              }),
            addBlockedByDependency: () => Effect.void,
            addGithubSubIssue: () => Effect.fail(new Error("link failed")),
            sleep: () => Effect.void,
          },
        ),
      ),
    (error) => {
      assert.ok(error instanceof GithubSubIssueLinkError)
      assert.equal(error.issueNumber, 203)
      assert.equal(error.parentIssueNumber, 77)
      assert.equal(error.issueUrl, "https://github.com/acme/lalph/issues/203")
      assert.match(error.message, /Link it manually in GitHub and retry\./)
      return true
    },
  )

  assert.equal(createCalls, 1)
})

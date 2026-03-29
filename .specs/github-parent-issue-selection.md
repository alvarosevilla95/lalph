# GitHub Parent Issue Selection Mode

## Summary

Add a GitHub-only project issue-selection mode for PR-flow projects where a
project is bound to a parent GitHub issue and lalph works only on that parent's
direct child issues. `lalph plan` creates the planning spec, creates the parent
issue, creates child issues under it, binds the project to the parent, and
targets a deterministic parent branch. `lalph issue` becomes the lightweight
way to add more child issues to the bound parent later.

## Goals

- Support a GitHub-only project mode that derives work from a bound parent
  issue's direct children instead of the existing filtered issue query.
- Keep normal PR-flow execution semantics for child issues.
- Let `lalph plan` create a new parent/spec/task bundle for this mode.
- Let `lalph issue` create a new child issue under the bound parent.
- Keep the generated planning spec committed on the parent branch.

## Non-Goals

- No Linear support in v1.
- No finalization flow or rollup PR to the default branch.
- No automatic reconciliation against an already-bound parent in `lalph plan`.
- No recursive child traversal; only direct child issues are in scope.
- No attempt to deduplicate, update, or delete existing child issues.
- No change to `commit` or `ralph` git flows.

## Assumptions

- GitHub supports native parent/child issue relationships that can be queried
  live from the current repository.
- Child issues remain self-contained enough to execute, even when a planning
  spec exists on disk.
- The project target branch can be derived deterministically from the parent
  issue number as `lalph/parent-<issueNumber>`.
- The existing PR-flow runner and chooser can remain task-centric once the
  GitHub issue source returns the correct workset.

## Users

- Users running structured feature work that should be grouped under one parent
  GitHub issue.
- Users who want a stable parent branch for related child PRs.
- Users who want to create additional child issues after planning without
  rerunning the planning flow.

## User Stories

- As a user, I can configure a PR-flow project to watch the direct children of
  one parent GitHub issue.
- As a user, I can leave the parent issue empty during setup and let
  `lalph plan` create and bind it later.
- As a user, I can attach an existing parent issue to a project and have lalph
  derive the parent branch automatically.
- As a user, I can run `lalph issue` to create a new child issue under the
  bound parent.
- As a user, I can inspect a project and clearly see that it is operating in
  GitHub parent mode and which parent issue it is bound to.

## Functional Requirements

### Project Model & Validation

- Add an explicit project field describing how issues are selected for the
  project.
- This field is prompted only when `gitFlow === "pr"`.
- Supported v1 values are:
  - `filtered`: existing behavior using issue-source-specific filtering.
  - `github-parent`: derive work from one bound GitHub parent issue.
- `github-parent` is only valid when:
  - the current issue source is GitHub, and
  - the project `gitFlow` is `pr`.
- Add `githubParentIssueNumber` on `Project` as an optional number.
- Add `specPath` on `Project` as an optional string for planning context.
- Do not reuse `ralphSpec` for this mode.
- `projects add/edit` allows `github-parent` projects to leave the parent issue
  empty.
- If a parent issue number is provided in `projects add/edit`, validate it
  immediately against GitHub before saving.
- `projects add/edit` allows clearing the bound parent issue number.
- `projects add/edit` allows rebinding the parent issue number later.
- Rebinding should be treated as a sharp tool with explicit messaging.

### Target Branch Behavior

- In `github-parent` mode, if `targetBranch` is empty and a parent issue number
  is present, derive it as `lalph/parent-<issueNumber>`.
- If `targetBranch` already exists, preserve it rather than overwriting it.
- `lalph plan` should also populate the parent branch when it creates a new
  parent issue and the project has no target branch yet.

### GitHub Issue Discovery

- In `github-parent` mode, the GitHub issue source returns exactly the bound
  parent issue's direct child issues as the project's issue set.
- The parent issue itself is not included in the runnable issue set.
- No recursion: grandchildren and deeper descendants are ignored.
- Closed child issues disappear from the runnable set and count as complete from
  the runner's perspective.
- Dependency handling is unchanged:
  - child issues may still be blocked by issues outside the same parent.
- Membership is read live from GitHub on each issue refresh.
- Membership is not mirrored into local `.lalph` state.
- Pre-work validation does not re-check child membership; discovery/polling is
  the source of truth.
- If the parent issue is closed while child issues remain open, lalph continues
  processing those child issues.

### GitHub Filter Settings

- In `github-parent` mode, GitHub project and label filters are inactive.
- `autoMergeLabel` remains active and keeps its current meaning for child
  issues.
- `projects ls` and GitHub info output should hide inactive filter fields in
  this mode.

### Planning Flow

- `lalph plan` in `github-parent` mode is a create-only flow for unbound
  projects.
- If the project already has a bound parent issue number, `lalph plan` fails
  fast with a clear message directing the user to use `lalph issue` or a future
  workflow.
- For an unbound `github-parent` project, `lalph plan` must:
  - generate the specification file under the normal specs directory,
  - create the parent GitHub issue,
  - derive and set `targetBranch` if missing,
  - commit/push the generated spec to the parent branch using existing plan-mode
    behavior,
  - create child GitHub issues from the generated tasks,
  - link each child issue as a direct child of the parent,
  - set `githubParentIssueNumber` on the project,
  - set `specPath` on the project.
- The parent issue body should contain a concise summary and a reference to the
  generated spec rather than the full spec contents.

### Issue Creation Flow

- In `github-parent` mode with a bound parent issue, `lalph issue` should:
  - create a normal GitHub issue,
  - attach it as a direct child of the bound parent automatically.
- `lalph issue` should not ask the user whether to attach the issue as a child;
  attachment is automatic in this mode.
- If the project is in `github-parent` mode but has no bound parent issue,
  `lalph issue` fails fast with an actionable message.
- If issue creation succeeds but child-linking fails, the command fails loudly
  and reports the created issue so the user can repair it manually.

### Prompting & Runtime Guidance

- `github-parent` mode remains on the standard PR-flow runner path; it is not a
  Ralph-style alternate execution mode.
- Worker/reviewer prompts for child issues in this mode should always instruct
  the agent to review the project spec before implementation when `specPath`
  exists.
- `specPath` is optional at runtime:
  - manually attached parent projects may run without it,
  - prompt enhancements apply only when it is present.

### Project Inspection & Errors

- `lalph projects ls` should clearly show:
  - git flow,
  - issue-selection mode,
  - bound parent issue number if present,
  - target branch.
- Running `lalph` for a `github-parent` project with no bound parent issue
  should fail fast with a clear actionable error.

## Data Model

Extend `Project` with explicit issue-selection and planning context fields:

```ts
type Project = {
  id: ProjectId
  enabled: boolean
  targetBranch: Option<string>
  concurrency: number
  gitFlow: "pr" | "commit" | "ralph"
  issueSelectionMode?: "filtered" | "github-parent"
  githubParentIssueNumber?: number
  specPath?: string
  ralphSpec?: string
  researchAgent: boolean
  reviewAgent: boolean
}
```

Notes:

- `issueSelectionMode` is meaningful only for `gitFlow = "pr"`.
- `githubParentIssueNumber` is GitHub-only v1 metadata, but stored on `Project`
  because root commands, prompts, and listings need first-class access.
- `specPath` is optional planning context for parent-bound projects and must not
  be conflated with `ralphSpec`.

## Runtime Model

- `filtered` mode:
  - current issue-source-specific filtering behavior remains unchanged.
- `github-parent` mode:
  - chooser, worker, review, and PR flow remain task-centric,
  - the GitHub adapter changes the discovered issue set to direct children of
    the bound parent,
  - all child PRs still target the project's configured parent branch.

## Error Handling & Edge Cases

- Invalid parent issue number during `projects add/edit`: reject the save.
- Empty parent issue number in `github-parent` mode: allowed in config, but
  normal runs and `lalph issue` fail until a parent is bound.
- Existing parent + `lalph plan`: reject in v1.
- Parent issue closed with open children: continue processing children.
- Child issue removed from the parent after discovery: it naturally falls out of
  the next refreshed workset.
- Rebinding a project to a different parent changes future workset membership;
  the UI should make that risk clear.

## Acceptance Criteria

- A PR-flow project can be configured in `github-parent` mode.
- `projects add/edit` only shows the issue-selection prompt for PR-flow
  projects.
- `projects add/edit` validates entered parent issue numbers against GitHub.
- A `github-parent` project with a bound parent derives work only from the
  parent's direct child issues.
- Closed child issues disappear from the workset.
- `autoMergeLabel` still applies in `github-parent` mode.
- `lalph plan` on an unbound `github-parent` project creates the spec, parent
  issue, child issues, parent links, and project binding.
- `lalph plan` on an already-bound `github-parent` project fails fast.
- `lalph issue` on a bound `github-parent` project creates and links a child
  issue automatically.
- `lalph issue` with a missing parent issue fails fast.
- `projects ls` clearly shows the mode and parent issue binding.

## Implementation Plan

1. [x] Extend project schema, prompting, validation, and listing:
   - add `issueSelectionMode`, `githubParentIssueNumber`, and `specPath`,
   - conditionally prompt for issue-selection only in PR flow,
   - validate GitHub parent issue numbers,
   - improve `projects ls` output for the new mode,
   - add runtime guards so configured `github-parent` projects do not silently
     fall back to filtered discovery.

2. [ ] Add GitHub parent-child issue discovery:
   - implement a GitHub adapter branch for `filtered` vs `github-parent`,
   - fetch direct child issues of the bound parent and map them to `PrdIssue`,
   - keep `autoMergeLabel` support active in this mode,
   - hide inactive GitHub filter output when parent mode is active.

3. [ ] Update `lalph issue` for bound-parent child creation:
   - auto-link created issues as children of the bound parent,
   - fail loudly if linking does not succeed.

4. [ ] Add `lalph plan` support for creating parent-bound projects:
   - create parent issue,
   - derive/set parent branch,
   - commit/push spec to the parent branch,
   - create and link child issues,
   - bind the project and persist `specPath`,
   - reject reruns for already-bound projects.

5. [ ] Add prompt guidance for parent-bound task execution:
   - always instruct the agent to review the project spec when `specPath`
     exists.

## Implementation Notes

- This change set intentionally covers project configuration and validation
  only. The runner now fails fast for `github-parent` projects instead of
  silently using the existing filtered GitHub discovery path.
- GitHub project and label filter prompts/output are now hidden in
  `github-parent` mode, while `autoMergeLabel` remains configurable.

## Deferred for V2

- Linear support.
- Finalization command and final parent-branch rollup PR.
- Any `lalph plan` update flow for already-bound parents.
- Child issue deduplication/reconciliation.
- Recursive descendant traversal.

# Feature-Driven Execution

## Summary

Introduce a feature-oriented workflow for `lalph` that supports three execution
styles:

- simple top-level issue implementation with PRs to the project base branch
- feature-driven PR execution, where a spec and feature branch coordinate a
  larger body of work tracked in the issue source
- feature-driven Ralph execution, where a spec and feature branch drive direct
  iterative commits without issue-source child tasks

The CLI should expose `features` as the user-facing container for larger work
items and `run` as the active orchestration command. Bare `lalph` should remain
the main daemon-like entrypoint and default to `lalph run all`.

## Goals

- Give users a first-class workflow for creating and running larger feature
  efforts without overloading project-level configuration.
- Preserve the existing simple issue-to-PR workflow for top-level tasks.
- Support a feature-driven PR mode that uses the issue source as the execution
  system of record for child tasks.
- Support a feature-driven Ralph mode that is spec-only for now.
- Make feature setup accessible through a guided CLI wizard.
- Keep feature metadata local to `lalph` while reconciling operational state
  from Git, the issue source, and final integration PRs.
- Make final integration PR creation automatic when a feature becomes ready,
  with a manual escape hatch available later if needed.

## Non-Goals

- No redesign of agent presets, issue-source integrations, or project settings
  beyond what is required to support features.
- No requirement that Ralph mode mirror its execution state into the issue
  source.
- No attempt in this phase to support multiple tracking modes for Ralph.
- No web UI or TUI; CLI only.

## Problem Statement

Users need `lalph` to support both small issue-by-issue execution and larger,
multi-step feature work. Today, larger work is split awkwardly between plan
mode, project configuration, and Ralph mode. There is no first-class concept
for a feature that owns:

- a spec file
- a feature branch
- an execution style
- its integration lifecycle

As a result, the current UX makes it hard to express the intended workflows:

- simple top-level task implementation against the project base branch
- a spec-driven feature that decomposes into issue-source child tasks and PRs
- a spec-driven Ralph loop that executes directly against a feature branch

Users need a coherent model and CLI that treats these as related workflows
instead of unrelated commands and settings.

## Solution

Introduce a first-class `feature` concept distinct from `project`.

- `project` remains long-lived repo configuration.
- `feature` becomes the container for larger work and owns:
  - feature name
  - project association
  - execution mode (`pr` or `ralph`)
  - spec file path
  - project base branch
  - prompted feature branch
  - lifecycle status
  - optional issue-source parent item for PR mode
  - optional final integration PR reference

The CLI should expose:

- `lalph features ...` for feature lifecycle management
- `lalph run ...` for active orchestration

Three workflows should exist:

1. Simple issue mode:
   - issue-source based
   - only top-level tasks with no parent
   - each task opens a PR to the project base branch

2. Feature + PR mode:
   - feature is created from a plan/spec
   - the issue source stores a parent feature item plus child tasks
   - child implementation PRs target the feature branch
   - when child work is complete, `lalph` opens a final integration PR from the
     feature branch to the project base branch

3. Feature + Ralph mode:
   - feature is created from a plan/spec
   - the spec file is the execution source of truth
   - `lalph` runs Ralph iterations directly against the feature branch
   - when the spec is complete, `lalph` opens a final integration PR from the
     feature branch to the project base branch

## Users

- Solo developers who want `lalph` to execute normal issue-source work in the
  background.
- Developers who want a guided way to create and execute larger features.
- Teams using an issue source for feature decomposition and child-task tracking.
- Users who prefer Ralph for spec-driven iterative implementation without
  creating issue-source child tasks.

## User Stories

1. As a developer, I want bare `lalph` to keep processing all active work, so
   that I can treat it like a background orchestrator.
2. As a developer, I want `lalph run issues` to only process top-level issues,
   so that feature work does not interfere with routine issue execution.
3. As a developer, I want `lalph run feature <name>` to focus on one feature,
   so that I can direct effort to a specific body of work.
4. As a developer, I want to create a feature through a wizard, so that I do
   not need to manually stitch together a spec, branch, and execution mode.
5. As a developer, I want the wizard to prompt for a feature branch name, so
   that the branch naming remains explicit and under my control.
6. As a developer, I want a feature to be separate from project configuration,
   so that project settings remain stable while features come and go.
7. As a developer, I want simple top-level tasks to continue creating PRs
   against the project base branch, so that existing lightweight workflows stay
   intact.
8. As a developer, I want PR-mode features to create a parent record in the
   issue source, so that the larger effort is visible in the same place as its
   child tasks.
9. As a developer, I want PR-mode child tasks to target the feature branch, so
   that the entire feature can be integrated as one unit later.
10. As a developer, I want Ralph-mode features to stay spec-only, so that I can
    move quickly without creating issue-source child tasks.
11. As a developer, I want Ralph iterations to push commits to the feature
    branch, so that progress is durable and reviewable.
12. As a developer, I want final integration PRs to open automatically when a
    feature is ready, so that integration is not blocked on an extra manual
    bookkeeping step.
13. As a developer, I want feature completion to be derived from the final PR
    merging, so that feature status reflects reality instead of a manual flag.
14. As a developer, I want to pause or otherwise exclude a feature from global
    execution later, so that I can keep unfinished feature metadata without it
    consuming scheduler time.
15. As a developer, I want `lalph features ls` to show the important feature
    metadata and state, so that I can understand what is active at a glance.
16. As a developer, I want `lalph features show <name>` to explain the current
    state of one feature, so that I can inspect branch, spec, mode, and
    integration state without chasing multiple systems.
17. As a developer, I want the feature metadata to live locally in the repo, so
    that Ralph and PR-mode features share one neutral persistence model.
18. As a developer, I want the spec file to remain the planning artifact, so
    that orchestration metadata does not pollute the body of the spec.
19. As a developer, I want blocked and ready-for-integration to be reflected in
    feature status, so that the CLI communicates operational reality clearly.
20. As a developer, I want the design to leave room for a later manual
    `features finalize` escape hatch, so that automation failures do not trap a
    feature in limbo.

## Implementation Decisions

- Introduce `feature` as a first-class domain object distinct from `project`.
- Keep `project` focused on long-lived repo settings such as issue source,
  presets, default/base branch, and concurrency.
- Treat `feature` as the unit that owns larger work:
  - execution mode: `pr` or `ralph`
  - spec file
  - base branch
  - feature branch
  - lifecycle metadata
- Replace the user-facing concept of `initiative` with `feature`.
- Replace the user-facing concept of `watch` with `run`.
- Bare `lalph` should default to `lalph run all`.
- CLI surface should include:
  - `lalph run issues`
  - `lalph run feature <name>`
  - `lalph run all`
  - `lalph features create`
  - `lalph features ls`
  - `lalph features show <name>`
  - `lalph features edit <name>`
- `lalph features create` should be a wizard that:
  - selects a project
  - selects execution mode
  - captures a feature title/name
  - captures the base branch
  - prompts for the feature branch name
  - captures or generates the spec
  - bootstraps required external state
- PR-mode features are always issue-source based:
  - create a parent feature item in the issue source
  - create/generate child tasks under that parent
  - child PRs target the feature branch
- Ralph-mode features are spec-only for now:
  - no issue-source child tasks
  - the spec file is the execution source of truth
  - each Ralph iteration commits/pushes to the feature branch
- Final integration PR behavior:
  - when a feature becomes ready, `lalph` should automatically create/open the
    final integration PR from feature branch to base branch
  - completion should be derived from the final PR merge state
  - a manual escape hatch may be added later, but is not required for the core
    workflow
- Feature metadata should live locally in `.lalph/features/` as one file per
  feature.
- The feature metadata file should store stable orchestration metadata only and
  should not duplicate derived operational state beyond durable references such
  as a parent issue id or final PR number.
- The spec file remains the planning and execution artifact, especially for
  Ralph mode.
- The system should derive rich display state by reconciling local metadata
  with Git, issue-source state, and final PR state.

## Feature Data Model

Persisted feature metadata should include:

- feature name / identifier
- project id
- execution mode: `pr | ralph`
- spec file path
- base branch
- feature branch
- lifecycle status: `draft | active | paused | complete | cancelled`
- optional parent issue-source identifier for PR mode
- optional final integration PR identifier

Derived display state should include:

- `draft`
- `active`
- `paused`
- `blocked`
- `ready`
- `integrating`
- `complete`
- `cancelled`

Derived state rules should follow these principles:

- `blocked`, `ready`, and `integrating` are observed conditions, not the
  primary persisted lifecycle state
- `complete` is reached when the final integration PR merges
- a feature may move from `integrating` back to `active` if the final PR closes
  unmerged or new work appears

## Feature Lifecycle

Primary persisted lifecycle transitions:

1. `draft -> active`
   - after feature creation succeeds
2. `active -> paused`
   - via explicit user action
3. `paused -> active`
   - via explicit user action
4. `active -> complete`
   - when the final integration PR merges
5. `active | paused -> cancelled`
   - via explicit user action

Derived operational transitions:

- `active -> blocked`
  - unfinished work exists but nothing runnable is currently available
- `blocked -> active`
  - runnable work appears again
- `active -> ready`
  - all feature work is complete and no final integration PR is open
- `ready -> integrating`
  - final integration PR is open
- `integrating -> active`
  - PR closes unmerged or new work is added
- `integrating -> complete`
  - final integration PR merges

## CLI UX

### `lalph`

- Default entrypoint.
- Equivalent to `lalph run all`.

### `lalph run issues`

- Process only top-level issue-source tasks with no parent.
- Ignore all features.

### `lalph run feature <name>`

- Process only one named feature.
- Use the feature's execution mode to determine behavior.

### `lalph run all`

- Process top-level issues and all active features.
- Build one global target list by alternating sorted enabled projects and
  sorted active features where both are available.
- Start with the next sorted project, then the next sorted active feature, and
  drain whichever list still has entries in its own sorted order.

### `lalph features create`

- Guided wizard for creating a new feature.
- Prompts for:
  - project
  - execution mode
  - feature title/name
  - base branch
  - feature branch
  - plan/spec source
- Creates any required external state:
  - feature branch
  - spec file bootstrap
  - parent issue-source item in PR mode

### `lalph features ls`

- Show all features with key metadata:
  - project
  - mode
  - base branch
  - feature branch
  - spec file
  - derived display status

### `lalph features show <name>`

- Show all metadata for one feature and explain its derived current state.

### `lalph features edit <name>`

- Update feature metadata and/or re-open the feature spec for editing.

### `lalph features pause <name>`

- Persist `lifecycleStatus: "paused"` for the named feature.
- Reuse the existing stored-feature not-found behavior.
- Only allow `active -> paused`; do not reopen `draft`, `complete`, or
  `cancelled` features through this shortcut.

### `lalph features resume <name>`

- Persist `lifecycleStatus: "active"` for the named feature.
- Reuse the existing stored-feature not-found behavior.
- Only allow `paused -> active`; do not reopen `draft`, `complete`, or
  `cancelled` features through this shortcut.

## Execution Behavior

### Simple Issue Mode

- Only parentless issue-source tasks are eligible.
- Each task creates a PR to the project base branch.
- This mode should remain lightweight and require no feature object.

### Feature + PR Mode

- The feature owns the feature branch and spec.
- Child tasks are issue-source items under the feature parent.
- Child implementation PRs target the feature branch.
- The feature reaches `ready` when all child work is complete.
- `lalph` should open a final integration PR from feature branch to base branch.

### Feature + Ralph Mode

- The feature owns the feature branch and spec.
- The spec file is the execution source of truth.
- Ralph iterations commit/push directly to the feature branch.
- The feature reaches `ready` when the spec indicates completion.
- `lalph` should open a final integration PR from feature branch to base branch.

## Persistence & Reconciliation

- Feature metadata should be stored locally under `.lalph/features/`.
- One file per feature is preferred over one monolithic file.
- Stable metadata lives locally.
- Operational truth is reconciled from:
  - local feature metadata
  - Git branch state
  - issue-source state for PR-mode features
  - final integration PR state

The spec file should not be the sole source of feature lifecycle metadata.
Keeping metadata separate avoids mixing planning content with orchestration
state and supports both PR-mode and Ralph-mode features uniformly.

## Testing Decisions

- Tests should validate external behavior and state transitions, not internal
  implementation details.
- Good tests should assert:
  - the correct CLI flow is invoked for each command
  - feature lifecycle transitions happen for the right observed reasons
  - PR-mode and Ralph-mode features diverge only where intended
  - final integration PR automation triggers at the right time
  - persisted local metadata remains consistent with derived display state
- Modules that should be designed for isolated testing include:
  - feature metadata persistence
  - feature status derivation/reconciliation
  - CLI command handlers for `features` and `run`
  - feature creation workflow orchestration
  - final integration PR opening logic
- Prior art should come from existing command-level and service-level tests in
  the repo for settings persistence, git-flow handling, and command orchestration.

## Acceptance Criteria

- `feature` is introduced as a first-class concept distinct from `project`.
- Users can create a feature through a guided CLI wizard.
- `lalph features ...` exists as the user-facing feature lifecycle command
  group.
- `lalph run issues`, `lalph run feature <name>`, and `lalph run all` exist.
- Bare `lalph` defaults to `lalph run all`.
- Simple top-level issue execution remains supported without requiring a
  feature.
- PR-mode features create and use an issue-source parent plus child tasks.
- Ralph-mode features are spec-only.
- Feature branch name is explicitly prompted during feature creation.
- Final integration PRs are opened automatically when a feature becomes ready.
- Feature completion is derived from final integration PR merge state.
- Feature metadata is stored locally in `.lalph/features/`.
- The design leaves room for a later manual finalize escape hatch and a later
  scheduler evolution for `run all`.

## Out of Scope

- Finalizing the exact on-disk serialization format (`yaml` vs `json`) for
  feature metadata.
- Shipping pause/resume/finalize commands in the first iteration unless they
  are required to support the core lifecycle.
- Supporting issue-source mirroring for Ralph-mode child work.
- Changing issue-source provider semantics beyond what feature-backed PR mode
  requires.

## Further Notes

- This PRD intentionally keeps the feature lifecycle model small in persisted
  state and richer in derived state.
- Prompting for a feature branch name during creation is preferred to enforcing
  a rigid branch naming convention.
- Implementation note: the task prompt referenced
  `/Users/alvaro/Developer/cloned/lalph/.specs/feature-driven-execution.md`,
  but this checkout only contains the local `.specs/feature-driven-execution.md`
  path; implementation tracking was updated here instead.
- Implementation note: `lalph features create` now bootstraps the feature
  branch before persisting the feature, creates a PR-mode parent issue-source
  item and stores its identifier in `parentIssueSourceId`, and rolls back the
  new spec file plus any newly created branch when bootstrap fails before the
  feature metadata is written.
- Implementation note: `lalph features edit <name>` now re-prompts the stored
  execution mode, spec path, base branch, feature branch, and lifecycle status,
  persists updates through `FeatureStore.update(...)`, and can optionally
  reopen the feature spec in the configured editor after saving metadata.
- Implementation note: `lalph features pause <name>` and `lalph features
resume <name>` now provide dedicated manual lifecycle controls over stored
  feature metadata. They reuse the same not-found error behavior as `show` /
  `edit`, persist only `active -> paused` and `paused -> active`, and reject
  attempts to reopen `draft`, `complete`, or `cancelled` features until a
  broader lifecycle design exists.
- Implementation note: the `lalph run` CLI surface now exists as a distinct
  command group with `run issues`, `run feature <name>`, and `run all`, and
  bare `lalph` now dispatches through the same `run all` entrypoint. The
  current live runtime still only executes the pre-existing top-level issue
  loop; `run feature <name>` resolves stored feature metadata and leaves
  feature-aware execution behavior to the next implementation step.
- Implementation note: `lalph run feature <name>` now routes
  `executionMode: "ralph"` features through the existing Ralph runner, using
  the stored feature `specFilePath` as the spec source and `featureBranch` as
  the Ralph target branch.
- Implementation note: `lalph run feature <name>` now routes
  `executionMode: "pr"` features through the issue-source runner, but only
  after verifying that the stored feature includes `parentIssueSourceId`.
  Feature-scoped PR runs filter issue-source reads and task selection down to
  child tasks whose `parentIssueSourceId` matches the feature parent, and both
  worktree setup and child PR targeting now use the feature's `featureBranch`
  instead of the project base branch.
- Implementation issue discovered: feature-scoped PR execution now scopes
  existing child-task reads correctly, but follow-up child-task creation still
  uses the generic `IssueSource.createIssue(...)` API and therefore does not
  yet force new tasks under the feature parent. That parent-aware task creation
  path should be added in a later follow-up if feature runs are expected to
  spawn additional issue-source tasks.
- Implementation note: feature-scoped Ralph completion must not disable the
  owning project. Project-scoped Ralph runs still disable the project when the
  Ralph spec is exhausted, but named feature runs stop after the feature is
  done without mutating project enablement.
- Implementation note: `lalph run all` now loads stored features from
  `.lalph/features/`, filters them to `lifecycleStatus: "active"`, sorts
  enabled projects by project id and active features by feature name for a
  fair round-robin launch order, alternates between the two work sources where
  possible, and runs both the existing top-level project loops and active
  feature loops from the same global path.
- Implementation note: simple issue execution is now explicitly scoped to
  parentless issue-source tasks. Both `lalph run issues` and the top-level
  project portion of `lalph run all` exclude feature child tasks so feature PR
  work is not double-run by the generic issue loop.
- Implementation note: `lalph features ls` and `lalph features show <name>`
  now resolve a derived display status instead of echoing persisted
  `lifecycleStatus` directly. `features show` keeps the persisted lifecycle
  field in the output separately for debugging mismatches between durable
  metadata and reconciled runtime state.
- Implementation note: final integration PR display state is currently derived
  from `finalIntegrationPrId` values in the `github:<number>` format, using
  GitHub CLI PR state lookup. Open final PRs display as `integrating`, merged
  final PRs display as `complete`, and closed-unmerged PRs fall back to the
  execution-source-derived state.
- Implementation note: ready-feature reconciliation now searches GitHub for
  existing PRs matching the feature/base branch pair before creating anything.
  This lets `lalph run feature <name>` and `lalph run all` reuse open PRs,
  persist missing `finalIntegrationPrId` values, reopen the latest closed PR,
  and avoid duplicate final integration PR creation when metadata is stale or
  missing.
- Implementation note: PR-mode feature display state is now derived from child
  issue-source tasks under `parentIssueSourceId`: all-done child work resolves
  to `ready`, runnable or in-flight work resolves to `active`, and incomplete
  work with nothing runnable resolves to `blocked`.
- Implementation note: Ralph-mode feature display state now reads the feature
  spec's `## Implementation Plan` task list. Checked tasks (`[x]`) count as
  complete, unchecked tasks (`[ ]`) keep the feature `active`, and explicit
  blocked markers (`[-]`, `[~]`, `[!]`, or `[blocked]`) resolve to `blocked`
  when no active tasks remain. Specs without tracked implementation-plan task
  markers currently fall back to `active`.

## Implementation Plan

1. [x] Introduce the feature domain and persistence model.
   - Add local feature metadata storage under `.lalph/features/`.
   - Define the persisted lifecycle fields and references needed by both PR and
     Ralph modes.
   - Completed with a first-pass `Feature` model, file-per-feature persistence,
     and focused persistence tests.
2. [x] Add `lalph features` CLI commands.
   - Implement `create`, `ls`, `show`, and `edit`.
   - Build the guided feature creation wizard.
   - Initial inspection support is now in place via `lalph features ls` and
     `lalph features show <name>`, backed by `FeatureStore.list()` and
     `FeatureStore.load()` with command-level tests.
   - `lalph features create` now guides users through project, execution mode,
     feature name, branches, and spec source/path, bootstraps the configured
     feature branch, creates a PR-mode parent issue-source item when needed,
     persists `parentIssueSourceId`, and bootstraps a new spec file when
     requested.
   - `lalph features edit <name>` now updates stored feature metadata through a
     dedicated edit wizard, preserves non-edited durable references, and can
     optionally reopen the feature spec file in the user's editor.
3. [x] Add `lalph run` command variants.
   - Implement `run issues`, `run feature <name>`, and `run all`.
   - Make bare `lalph` default to `run all`.
   - Command-level dispatch coverage now verifies bare `lalph`, `run issues`,
     `run feature <name>`, and `run all` against a shared run-service boundary.
4. [x] Integrate feature-aware execution behavior.
   - [x] Preserve simple issue execution.
   - [x] Add PR-mode feature execution against issue-source child tasks.
   - [x] Add Ralph-mode feature execution against the spec file and feature branch.
   - `lalph run feature <name>` now dispatches stored Ralph-mode features into
     the existing Ralph execution loop with resolved spec-file paths and the
     stored feature branch as the run target.
   - `lalph run feature <name>` now also dispatches stored PR-mode features
     into the issue-source execution loop, fails clearly when the feature is
     missing `parentIssueSourceId`, scopes task resolution to child tasks under
     that parent, and targets the feature branch for worktree setup and child
     PR creation.
   - `lalph run all` now includes active stored features in addition to enabled
     project execution, while `lalph run issues` remains limited to top-level
     parentless tasks.
5. [x] Add feature status derivation and integration PR automation.
   - [x] Compute derived display status from local + external state.
   - [x] Automatically create/open final integration PRs when features become ready.
   - `src/FeatureStatus.ts` now resolves derived display state for
     `lalph features ls` / `show`, reconciling persisted lifecycle metadata
     with final PR state plus PR-mode child-task state or Ralph spec task
     state.
   - Command-level coverage now verifies that `features ls` and
     `features show <name>` report the derived display status, while resolver
     tests cover `blocked`, `ready`, `integrating`, merged-PR `complete`, and
     Ralph ready state.
   - `src/FeatureFinalIntegration.ts` now reconciles each feature after a run
     loop finishes, creates or reopens the final integration PR when the
     feature becomes `ready`, persists the resulting `finalIntegrationPrId`,
     and reuses the same reconciliation path from both `lalph run feature` and
     `lalph run all`.
   - Command-level coverage now verifies PR-mode creation, Ralph-mode reopen,
     duplicate avoidance for already-integrating features, and persistence of
     stored final PR ids through both named-feature and global run paths.
6. [x] Resolve remaining deferred UX follow-ups.
   - [x] Add dedicated manual pause/resume controls.
   - [x] Finalize `run all` scheduling policy.
   - `lalph run all` now alternates sorted enabled projects and sorted active
     features where possible, with the ordering policy extracted into a small
     helper and covered by dedicated unit tests plus command-level coverage.

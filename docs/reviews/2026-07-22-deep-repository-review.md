# Deep Repository Review — 2026-07-22

## Scope and evidence boundary

This review records the risk-first normalization of `ArchitectureWorld/ai-super-canvas` through Task 3. The Task 3 worktree was based on commit `6a55028` on `feat/risk-first-vertical-slice`. Evidence came from the Git graph, tracked source and configuration, focused tests, the Task 1 and Task 2 verification records, and read-only GitHub API responses captured on 2026-07-22.

Local verification and public GitHub state are deliberately separated. Task 3 does not push, merge, close pull requests, or change repository settings; those operations remain Task 4.

Status meanings:

- **Verified:** observed and recorded; no change implied.
- **Remediated:** fixed on the local integration branch and covered by the cited verification.
- **Deferred:** explicitly outside this merge step or dependent on publication/settings work.

## Branch and pull-request topology

| Evidence | Status | Finding |
| --- | --- | --- |
| `git merge-base --is-ancestor origin/feat/feature-01-mvp origin/feat/risk-first-vertical-slice` | Verified | The command succeeded: the PR #4 branch is fully contained in the PR #5 branch and must not be merged separately. |
| [PR #4](https://github.com/ArchitectureWorld/ai-super-canvas/pull/4) | Verified | Open, non-draft, `feat/feature-01-mvp` → `main`, head `b4c63b1`; it remains to be closed as superseded only after PR #5 is merged. |
| [PR #5](https://github.com/ArchitectureWorld/ai-super-canvas/pull/5) | Verified | Open draft, `feat/risk-first-vertical-slice` → `main`, public head `9dc064e` at audit time. |
| Local integration branch | Verified | Before Task 3, local head `6a55028` was 13 commits ahead of the public PR #5 head and zero commits behind it. No Task 1–3 publication is claimed here. |
| Consolidation plan | Deferred | Task 4 will push the normalized branch, rerun public checks, squash-merge PR #5, then close PR #4 as fully superseded. |

## Findings remediated on the integration branch

| Area | Status | Evidence and result |
| --- | --- | --- |
| Runtime event replay | Remediated | `f64c58e` added a canonical complete-event fingerprint, stable `runtime_event_conflict`, fail-closed legacy backfill, and bounded event reads with default 100 and accepted limits 1–100. |
| Mutable ingestion input | Remediated | Review follow-up `47c25e3` snapshots the complete event before awaiting locks, so fingerprinting and persisted event/message/Run projections use the same immutable value. Focused repository integration: 43/43 passed. |
| Database integration reproducibility | Remediated | `6a55028` added `pnpm test:integration:docker`, which owns isolated Compose cleanup, database start, tracked migration, integration execution, and volume removal. Full integration verification: 68/68 passed. |
| Production dependency advisories | Remediated | pnpm overrides resolve `sharp` 0.35.3 and `postcss` 8.5.21. `pnpm audit --prod --audit-level moderate` reported no known vulnerabilities in the Task 2 verification environment. |
| CI quality gates | Remediated locally | `verify` now includes the production audit; `integration` runs the disposable Docker command. Public execution of the updated workflow remains pending Task 4. |
| Public repository baseline | Remediated locally | Task 3 adds EditorConfig/Git normalization, CODEOWNERS, weekly npm and GitHub Actions Dependabot updates, JavaScript/TypeScript CodeQL, contribution/security policies, operational README guidance, and this review record. Focused standards contract: 9/9 passed. |
| Prototype disclosure | Remediated locally | The README now identifies the browser UI as a `localStorage prototype`, provides exact bootstrap/test/build commands, and does not claim browser E2E success or server-side UI persistence. |

## Verification record

| Check | Environment / scope | Result |
| --- | --- | --- |
| Runtime repository integration | Disposable PostgreSQL Compose stack after `47c25e3` | 43/43 passed |
| Full integration suite | Node 24.18.0 / pnpm 11.12.0 Docker toolchain after `6a55028` | 68/68 passed |
| Full unit suite | Same Task 2 Docker toolchain | 11 files, 155/155 passed |
| Production dependency audit | Same Task 2 Docker toolchain | No known vulnerabilities at moderate severity or above |
| Lint, typecheck, build | Same Task 2 Docker toolchain | Passed; Next.js 16.2.10 production build completed |
| Task 3 standards contract | Focused Vitest run | RED: 9/9 failed because eight required files and both README markers were absent; GREEN: 9/9 passed after implementation |
| Task 3 repository checks | Fresh before the Task 3 commit | `git diff --check`, lint, typecheck, and tracked Markdown link/path validation passed |
| Browser E2E | Playwright | Not claimed as passing; no fresh successful run completed for this review |

Task 3 intentionally did not rerun the broader unit, integration, or build suites because it changes repository policy, workflows, and Markdown rather than runtime behavior. The focused contract, lint, typecheck, diff checks, and tracked-path validation cover its executable change; the broader suites remain part of the Task 4 pre-push gate.

## Public CI and GitHub settings at audit time

The latest public `verify` check on PR #5 head `9dc064e` completed successfully at `2026-07-22T08:33:12Z`. That result predates the 13 local commits through `6a55028`, contains no `integration` job from Task 2, and contains no Task 3 CodeQL workflow. It is historical evidence only, not proof of the normalized branch. A public rerun of `verify`, `integration`, and CodeQL after pushing the current branch is deferred to Task 4.

Read-only GitHub API checks found the following settings absent or disabled on 2026-07-22:

- `main` had no branch protection;
- automatic branch deletion was disabled;
- merge commits and rebase merges were allowed alongside squash merges;
- vulnerability alerts and Dependabot security updates were disabled;
- automated security fixes were disabled;
- secret scanning and push protection were disabled; and
- private vulnerability reporting was disabled.

Task 4 is responsible for applying settings where the repository plan and GitHub permissions allow, configuring required `verify` and `integration` checks, and verifying the final public state. This review does not claim any of those settings are already applied.

## Deferred findings and follow-up gates

| Finding | Status | Follow-up |
| --- | --- | --- |
| Large control-plane modules | Deferred | Split `packages/db/src/repositories/postgres-control-plane-repository.ts` (3,696 lines at audit time) and its integration test (3,862 lines) by bounded responsibility after the concurrency-sensitive branch is integrated. |
| Large Runtime contract suite | Deferred | Split `packages/ai/src/runtime/contract-suite.ts` (2,432 lines) without changing adapter semantics. |
| Browser E2E readiness | Deferred | Build a stable cached Playwright browser image, complete a fresh E2E run, and only then consider E2E a required check. |
| Application readiness semantics | Deferred | `/api/health` currently reports web-process liveness only. Add a separate database-backed readiness endpoint before serving control-plane traffic. |
| Public CI rerun | Deferred to Task 4 | Push the complete branch and require successful fresh `verify`, `integration`, and CodeQL results before merge. |
| GitHub governance | Deferred to Task 4 | Apply and re-read branch protection, merge policy, security features, and private vulnerability reporting; record any plan item GitHub cannot enable. |

## Conclusion

The local integration branch remediates the highest-risk event-consistency, reproducibility, dependency, and public-documentation gaps with focused evidence. Publication, repository settings, public CI confirmation, pull-request consolidation, browser E2E, large-file refactoring, and database readiness remain explicit gates or follow-up work rather than implied successes.

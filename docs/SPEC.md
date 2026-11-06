# Applitools visual review gate: behavior spec

The contract shared by every implementation of the Applitools PR gate: the **Jenkins plugin** (reference implementation, `applitools-jenkins-plugin`) and the planned **GitHub Action**. It describes *what* happens and *why*, independent of the CI system, plus what we learned about the Eyes and GitHub APIs while building and live-testing the plugin (2026-10-19 to 10-21).

Where the plugin's code and this spec disagree, treat it as a bug in one of them and fix it deliberately.

Keywords: **MUST** = required for compatible behavior; **SHOULD** = strongly recommended; **MAY** = optional.

---

## 1. The flow

1. A pull request opens or gets new commits. CI runs the visual tests (any Eyes SDK) inside the gate.
2. The gate sets up Eyes through `APPLITOOLS_*` environment variables, so the batch, branch and key need no test-code changes.
3. When the tests finish, the gate closes the Eyes batch, waits for rendering, reads the results, and posts **Applitools / Visual tests** and **Applitools / Design review** on the PR's head commit. Both link to the batch in Eyes.
4. Reviewers accept or reject changes **in Eyes**; designers never need GitHub or CI. The gate notices (polling or events) and updates both results **without re-running tests**.
5. Adding the PR label `design-review` requires a designer's approval; the gate reacts without re-running tests.
6. When the PR merges, the gate merges the PR's Eyes baseline branch into the target branch's, and posts **Applitools / Baseline merge**.
7. Branch protection requires the first two results, so nothing merges until visual changes are accepted (and, if requested, approved by a designer).

---

## 2. Configuration surface

Implementations SHOULD use these names (Jenkins step options / Action inputs) so documentation transfers.

| Name | Default | Meaning |
| --- | --- | --- |
| `credentialsId` / API key | `applitools-api-key` (Jenkins) | Eyes **run** key: uploads tests, closes batches |
| `readCredentialsId` / read key | `applitools-read-api-key` if present, else the run key | Eyes **read** key: reads results, sessions, teams |
| merge key (global) | `applitools-merge-api-key` if present, else the run key | Eyes **merge** key: baseline merges |
| `serverUrl` | `https://eyes.applitools.com` | Dedicated cloud / on-prem |
| `batchId`, `batchName`, `branchName`, `parentBranchName` | derived (§3) | Overrides; support `${VAR}` |
| `closeBatch` | `true` | Close the batch when the gated block ends |
| `waitForResults` | `true` | Wait for rendering and read results |
| `resultsTimeout` | `300` s | Longest wait for tests still rendering |
| `onChanges` | `SUCCESS` | CI result when changes await review: `SUCCESS` / `UNSTABLE` / `FAILURE`. Default green: the PR results are the gate, and a yellow/red build makes CI's own PR results read as failing |
| `mergeBaselines` (per job) | global setting | Merge Eyes baselines when **this job's PR merges** (only then, never on approval) |
| `judgeDiffs` | `true` | Tell SDKs not to fail the command on diffs (§9) |
| `expectTests` | none | Minimum number of Eyes tests in the batch |
| `expectApps` | none | Eyes app names that must each report at least one test |
| `checks` | `true` | Post PR results at all |
| `designReview` | unset | `true`/`false` forces design review on/off (§6.1) |
| `designReviewLabel` | `design-review` | PR label that requests design review |
| `designers` | empty (anyone) | Comma/newline separated; Eyes emails and/or `team:<Eyes team>` (§6.3) |
| `repo`, `pullRequest`, `commit`, `branch`, `targetBranch` | detected | Explicit PR context (§3.1) |
| `githubCredentialsId`, `githubApiUrl` | none, `https://api.github.com` | Token reporting for non-multibranch jobs (§7.2) |
| global: `githubReporting` | `AUTO` | `AUTO` / `CHECKS` / `STATUSES` (§7) |
| global: `designReviewByDefault` | `false` | Every PR needs design review |
| global: `designReviewCheck` | `true` | Post the Design review result (always, even when skipped) |
| global: `mergeBaselines` | `true` | Merge baselines when a PR merges |

---

## 3. Batch identity and environment

### 3.1 PR context

The gate needs: `owner/repo`, the commit under test, the branch, and for PRs the PR number, target branch and title.

- **The commit MUST be the PR's head commit**, never a synthetic merge commit. CI systems often build "PR merged into target" (Jenkins multibranch default; `GIT_COMMIT` is then a merge commit GitHub has never seen), so a batch or status keyed on it lands nowhere. Jenkins reads the PR hash from the SCM revision; GitHub Actions has `github.event.pull_request.head.sha`.
- Detection order in the plugin: explicit options → multibranch GitHub source → GitHub Pull Request Builder (`ghprbPullId`, `ghprbActualCommit`, `ghprbGhRepository`, `ghprbSourceBranch`, `ghprbTargetBranch`, `ghprbPullTitle`) → generic env (`CHANGE_*`, `GIT_URL`, `GIT_COMMIT`, `BRANCH_NAME`, `GIT_BRANCH`).

### 3.2 Derived values

| Value | PR | Branch build | No SCM info |
| --- | --- | --- | --- |
| Batch ID | head commit SHA | `<commit SHA>-<branch>` | random UUID per block |
| Batch name | `owner/repo PR #N: title` | `owner/repo branch` | `job #build` |
| Branch name | `owner/repo/source-branch`; **fork PRs:** `owner/repo/pr-N` | `owner/repo/branch` | unset |
| Parent branch | `owner/repo/target-branch` | unset | unset |
| Batch sequence | `owner/repo` (or job name) | same | job name |

A branch build's batch ID MUST differ from a PR build's: one commit is often built both ways at once (a push to a PR's branch), or on two branches, and builds sharing a batch close and read each other's results.

Branch names MUST be `owner/repo/branch`: that's the format Eyes' SCM integrations and the merge API use. Without the repo prefix, only the bare branch name is used. A fork's branch name can equal one of the repository's own (a fork's `main`), so fork PRs MUST use `owner/repo/pr-N` instead. Record the branch name used, for the baseline merge (§11).

### 3.3 Environment variables set inside the gated block

| Variable | Value |
| --- | --- |
| `APPLITOOLS_API_KEY` | run key (MUST be masked in logs) |
| `APPLITOOLS_SERVER_URL` | server |
| `APPLITOOLS_BATCH_ID`, `APPLITOOLS_BATCH_NAME`, `APPLITOOLS_BATCH_SEQUENCE` | §3.2 |
| `APPLITOOLS_BRANCH_NAME`, `APPLITOOLS_PARENT_BRANCH_NAME` | §3.2 (only when known) |
| `APPLITOOLS_DONT_CLOSE_BATCHES` | `true`: the gate closes the batch once; SDK runners would otherwise close (and split) it |
| `APPLITOOLS_JENKINS_MANAGED` | `true`; marks that the gate is active (test configs use it; nested blocks reuse the outer batch). An Action SHOULD set an equivalent (e.g. `APPLITOOLS_GATE_MANAGED`) and MAY also set this one for config portability |
| `APPLITOOLS_EXITCODE` | `nodiffs` (if `judgeDiffs` and not already set) |
| `APPLITOOLS_FAIL_CYPRESS_ON_DIFF` | `false` (same condition) |
| `APPLITOOLS_DESIGN_REVIEW` (read, not set) | `true`/`false` forces design review |

**One gated block per batch.** Everything inside shares one batch, one pair of results, one design review. Two blocks in one build would reuse the commit-based batch ID after the first closed it (known gap; workaround: one block).

---

## 4. Lifecycle of one gated run

1. **Start.** Resolve keys (fail with guidance if the run key is missing). Resolve PR context and batch identity. Set env (§3.3). Post Visual tests = *in progress*, "Running visual tests", and (if the Design review result is on) Design review = *in progress*, "Waiting for visual tests", so a re-run never shows the previous build's verdict.
2. **Run tests** (user commands).
3. **Close the batch:** `DELETE /api/sessions/batches/{batchId}/close/bypointerid`. `404` means no tests reported: results are "No Eyes results" (and an unmet `expectTests`/`expectApps` fails). Network errors only warn.
4. **Wait for rendering:** poll `GET /api/sessions/batches/{batchId}/bypointerid` → `runningCount` every 5 s until 0 or `resultsTimeout`.
5. **Read results:** `GET /api/v1/batches/{batchId}` (read key). `401`/`403` → "Couldn't read Eyes results" with a hint to add a read key.
6. **Apply expectations** (§5.2), compute the **outcome** (§5.1).
7. **Record** results for the CI UI; **post** Visual tests (§7); **evaluate and post** Design review (§6); **register** the review for following (§8).
8. **Set the CI result:** always print the verdict line first (`<Outcome>: <summary> → <batch URL>`). Then FAILED → fail; CHANGES → `onChanges` (default: unchanged, i.e. green); PASSED / NO_RESULTS → unchanged. The build only fails when something really failed (rejected or aborted tests, missing results, crashed commands); waiting on reviewers is not a failure. The verdict MUST be printed before failing, because when the test command already failed, CI often reports only the first error.

Problems talking to Eyes or GitHub MUST NOT fail the build by themselves; they're logged, and the PR result reflects them.

---

## 5. Results and outcome

### 5.1 Outcome (first match wins)

1. Expectations unmet → **FAILED**, summary `Missing results: <reason>`
2. `total == 0` → **NO_RESULTS**, "No Eyes tests reported to this batch"
3. `failed > 0` or `aborted > 0` → **FAILED**, `F of T failed` + ` (A aborted before any checkpoint reached Eyes)`
4. `unresolved > 0` → **CHANGES**, `U of T with visual changes to review`
5. else → **PASSED**, `T passed` + ` (N new baselines)`

Counts come from `statistics` (§10.3). Aborted sessions count as failed in Eyes' own stats.

### 5.2 Expectations

- `expectTests: N`: fail if `total < N` ("expected at least N tests, Eyes received M").
- `expectApps: [...]`: fail if any listed app has no test (`tests[].appName`, case-insensitive): "no tests from X".
- Expectations MUST be stored with the followed review and **re-applied on every refresh**, so accepting other suites' diffs can't turn the result green while a suite is missing.

---

## 6. Design review

### 6.1 Is it required? (first match wins)

1. `designReview` option (`true`/`false`)
2. `APPLITOOLS_DESIGN_REVIEW` env (`true`/`false`)
3. PR has the label (case-insensitive name match)
4. global `designReviewByDefault`

When the option or env decides it, label events are ignored for that review.

### 6.2 Verdict (first match wins)

| # | Condition | State | Title |
| --- | --- | --- | --- |
| 1 | not required | NOT_REQUESTED | Not requested (detail: how to add the label) |
| 2 | `failed > 0` and a *changed* test is now failed | CHANGES_REQUESTED | Changes requested |
| 2b | `failed > 0` otherwise | CHANGES_REQUESTED | Visual tests failed |
| 3 | `unresolved > 0` | WAITING | Waiting for design review |
| 4 | no tests changed in this build | APPROVED | No visual changes |
| 5 | designers = anyone | APPROVED | Approved |
| 6 | designers configured but none resolved | WAITING | Designers couldn't be determined (fail closed) |
| 7 | every changed test accepted by a designer | APPROVED | Approved by `a, b` |
| 8 | otherwise | WAITING | Waiting for a designer (detail names non-designer approvers) |

"Changed tests" = tests with status `unresolved` when the build ran (stored with the review).

### 6.3 Designers

- Entries: Eyes login emails, or `team:<Eyes team name or id>`, mixed. Split on **commas and new lines only**: team names contain spaces and apostrophes ("Tim's Eyes Org"). Match emails case-insensitively.
- Teams resolve through Eyes (§10.6). Cache 10 minutes per server + key. Unknown or empty team → a problem string; if nobody resolves, the verdict is row 6.
- **GitHub teams were rejected:** they give GitHub logins, and GitHub Apps generally can't read members' emails, so there's no reliable mapping to the Eyes users who accept changes. Eyes teams use the same identity as approvals.

### 6.4 Who approved

For each changed test (session), once it's no longer unresolved, read `GET /api/sessions/batches/{eyesBatchId}/{sessionId}` and collect `appOutputResolution[].lastAccept.user` where `lastAccept.sessionId == sessionId`. Only needed when designers are configured.

**Don't use `expectedAppOutput[].lastAccept`:** that's the baseline as it was when the test ran, and it names an earlier session. The first implementation did this and could never approve.

---

## 7. Reporting to GitHub

### 7.1 Names and states

Three results, same names as checks or statuses:
- `Applitools / Visual tests`
- `Applitools / Design review` (posted whenever `designReviewCheck` is on, even when skipped, so it can be a required check)
- `Applitools / Baseline merge` (only after a PR merges; don't require it)

| Gate state | Check (status / conclusion) | Commit status |
| --- | --- | --- |
| Visual tests running | `in_progress` | `pending` |
| Design review while this build's tests run | `in_progress` ("Waiting for visual tests"; a new check run per build, so allowed) | `pending` |
| PASSED | `completed` / `success` | `success` |
| CHANGES | `completed` / `action_required` | `pending` |
| FAILED, NO_RESULTS, unreadable results | `completed` / `failure` | `failure` |
| results not collected (`waitForResults: false`) | `completed` / `neutral` | `success` |
| Design review NOT_REQUESTED | `completed` / `skipped` | `success` |
| Design review WAITING | `completed` / `action_required` (**not** `in_progress`, see below) | `pending` |
| Design review APPROVED | `completed` / `success` | `success` |
| Design review CHANGES_REQUESTED | `completed` / `failure` | `failure` |

- **GitHub won't move a completed check back to `in_progress`.** It accepts the new title and keeps the old status. Design review often starts `skipped` and becomes required later via the label, so "waiting" MUST be `completed` + `action_required`. Completed checks MAY change conclusion freely.
- `success`, `neutral` and `skipped` satisfy required checks; everything else blocks the merge.
- Details/target URL = the Eyes batch URL. Check summary: `**[Review in Eyes](url)** · batch name`, the outcome line, then a table `| Test | Browser / device | Status |` with per-session links (escape `|` and new lines in names). Status descriptions are capped at **140 characters** (trim with `…`).

### 7.2 Checks vs statuses

- Checks need a **GitHub App** (Checks API). Personal tokens can only post **commit statuses**.
- Jenkins `AUTO`: checks for GitHub App jobs with the GitHub Checks plugin; statuses otherwise. Token jobs (`githubCredentialsId`) always post statuses via REST.
- **GitHub Actions:** the workflow `GITHUB_TOKEN` with `permissions: checks: write` can create check runs, so an Action SHOULD use checks.

---

## 8. Following reviews after the build

The point of the gate is that results update when reviewers act in Eyes, with no re-run.

### 8.1 What's followed

- Each PR build is registered: job, build, batch ID, server, key IDs, PR (repo + number), design settings, changed test IDs, expectations, label state, last posted states, and GitHub connection (token jobs).
- **One per job/PR:** a newer build replaces the older.
- **Branch builds are not followed** by default (opt-in `followBranchBuilds`): nobody reviews them, so they'd never settle. When followed, they stop once **settled**.
- **Open PRs** stay followed when settled, because a label change or the merge can still affect them, and a reviewer can change their mind in Eyes (re-read every 30 min).
- **Reconciliation on every pass** (no network in the common case): drop when the build is deleted, the job is gone or disabled (closed PR / deleted branch), or the job has a newer finished build. Before dropping a closed PR, **ask GitHub whether it merged**, and if so run the baseline merge (covers missed webhooks). If GitHub can't be reached, retry next pass instead of dropping.
- Dropped when: the PR closes (or merges and its baseline merge succeeds), the build is deleted, after **14 days** (Jenkins: configurable), or past a **cap of 500** (oldest first).

### 8.2 Refresh

Re-read results (read key) → re-apply expectations → if the Visual tests state changed, post it and update the stored results → re-evaluate Design review and post if changed → mark settled. Compare by state + title strings, and only post on change.

### 8.3 Events

| Event | Effect |
| --- | --- |
| PR `labeled` / `unlabeled` with the design label | Set label state (no-op if unchanged), un-settle, refresh now |
| PR `closed`, `merged: true` | Baseline merge (§11); keep the review (settled) until the merge succeeds, so a retry can find it |
| PR `closed`, not merged | Stop following |

Sources: webhooks when available; otherwise **poll the PR** (§10.8). Both MUST run the same handlers. **A webhook is only a prompt:** before merging baselines or changing label state, read the PR from GitHub with the job's own credentials and use that response's `merged`, `head.ref`, `base.ref` and labels. Never act on a payload's values; a forged or replayed webhook (e.g. without a webhook secret) must not be able to merge baselines or switch design review off. Run at most one merge per build at a time.

### 8.4 Polling limits (Jenkins values; an Action will have its own constraints)

| Limit | Value |
| --- | --- |
| Interval by review age | 1 min (first hour) → 5 min (first day) → 30 min by default. Jenkins lets admins set each interval and step (fastest 15 s); a later interval is never shorter than an earlier one |
| Settled open PRs | Re-read every 30 min by default (Jenkins: configurable) |
| Error backoff | Interval doubled per consecutive error, at most 1 hour (or the slowest interval, if longer); reset on success |
| Per-pass time budget | 50 s (Jenkins: ⅚ of the pass interval when under a minute, at least 10 s); least recently polled first |
| Overlap | Never two passes at once |
| Saves | Only when something changed |
| HTTP | One shared client; gzip for Eyes; ETag for GitHub PRs |

Measured costs: an Eyes results poll is 7.6 KB raw / **1.2 KB gzipped** for 10 tests (~120 B per test). A GitHub PR read is ~21 KB (GitHub doesn't compress it), but **`If-None-Match` → `304`, with no body and no rate-limit cost** for unchanged PRs.

---

## 9. SDK interplay

The gate judges diffs, so SDKs shouldn't fail the test command on them, while still failing on real errors.

| SDK | How | Notes |
| --- | --- | --- |
| Storybook (`@applitools/eyes-storybook`) | `APPLITOOLS_EXITCODE=nodiffs` | Any config key is read from `APPLITOOLS_<UPPER_SNAKE>` (`@applitools/utils` `populateConfigParams`; `"false"` → boolean). `nodiffs`: diffs exit 0, errors exit 1. Don't use `false`: it hides launch failures. |
| Cypress (`@applitools/eyes-cypress`) | `APPLITOOLS_FAIL_CYPRESS_ON_DIFF=false` | Same env loader |
| Playwright (`@applitools/eyes-playwright`) | **No env switch.** One config line: `failTestsOnDiff: process.env.APPLITOOLS_JENKINS_MANAGED ? false : undefined` | Default is `afterAll` with `CI` set, else `afterEach`. Worth asking the SDK team for an env var. |
| Others | Code: `getAllTestResults(false)` / `close(false)` | |

**Environment gotchas found live:**
- **Storybook on Linux ARM:** Puppeteer's Chrome download is x86 only. Point `PUPPETEER_EXECUTABLE_PATH` at another Chromium (e.g. the Playwright image's `/ms-playwright/chromium-*/chrome-linux*/chrome`). Newer npm versions also skip Puppeteer's install script.
- **Eyes NLP + Playwright in a container hung** (all sessions aborted, 0 steps, `RequestTimeoutError ... stuck`). Workaround: `eyesConfig.nlpOptions.enabled: false`. Parked for R&D (likely a container/remote-debugging issue).
- **Storybook 9** is the verified version (`eyes-storybook` 3.68 doesn't mention 10).

---

## 10. Eyes API reference (as used and verified)

Auth: header `X-Eyes-Api-Key: <key>` works everywhere we tried (preferred; keeps keys out of URLs). Send `Accept-Encoding: gzip` and decompress (Java's client doesn't do it automatically).

### 10.1 Key types

| Key | Can | Can't |
| --- | --- | --- |
| run (execute) | upload tests, close batches | read results (403), merge (403) |
| read | read results, sessions, admin team list; **check-only** merge (`OnlyCheck=true`) | real merges (403) |
| write | n/a | read probe (403), merge (403) |
| **merge** | merge baselines (requires the "merge" option; tied to a **team and a user**, for an audit trail) | |

### 10.2 Close batch
`DELETE /api/sessions/batches/{pointerId}/close/bypointerid` → 2xx closed, **404 = no tests reported**.

### 10.3 Results
`GET /api/v1/batches/{pointerId}` (also accepts the Eyes batch ID). Header auth only (query `apiKey` → 401).
```json
{"statistics": {"id": "<eyesBatchId>", "pointerId": "...", "name": "...", "passed": 0, "failed": 0,
                "unresolved": 4, "new": 0, "aborted": 0, "empty": 0, "total": 4},
 "batchUrl": "https://eyes.applitools.com/app/test-results/<eyesBatchId>",
 "tests": [{"testId": "<sessionId>", "testName": "...", "appName": "...", "status": "unresolved",
            "branchName": "...", "runBy": "...", "env": {"app": "Chrome 155.0", "os": "Linux",
            "device": "Desktop", "viewport": {"width": 1280, "height": 800}},
            "sessionUrl": "https://eyes.applitools.com/app/test-results/<eyesBatchId>/<sessionId>",
            "steps": []}]}
```
`tests[].status` is lowercase (`passed`, `unresolved`, `failed`, `new`). `steps` came back empty in our account. A reused pointer (re-run of the same commit after close) starts a new batch; the endpoint returns the latest.

### 10.4 Batch status
`GET /api/sessions/batches/{pointerId}/bypointerid` → `id`, `runningCount`, `isReviewed`, `diffResolvedCount`, `unresolvedCount`, … (0.8 KB gzipped).

### 10.5 Session detail (who approved)
`GET /api/sessions/batches/{eyesBatchId}/{sessionId}` → `appOutputResolution[] { lastAccept { user, sessionId, time }, isManuallyRejected, lastUpdatedBy }` once resolved; `expectedAppOutput[]` = run-time snapshot (don't use for approvals); `savedBy`. 8.8 KB raw / 3.3 KB gzipped.

### 10.6 Key info and teams
- `GET /api/v1/auth/api-key-validation` → `{teamId, orgId, user, permissions: ["read"|"write"|"execute"|"merge"], createdBy, purpose}`. `orgId` is returned but isn't in the docs.
- `GET /api/admin/orgs/{orgId}/accounts/?format=json` (**read key is enough**) → `[{id, name, members: {"<login email>": {name, isAdmin, isViewer}}, …}]`. "Accounts" = Eyes teams; member keys are login emails, the same as `lastAccept.user`. ~0.5 KB gzipped. (`/api/admin/orgs/{orgId}/users/` returned `[]` with non-admin keys.) Source: Applitools' `EyesUtilities` (`AdminApi.java`).

### 10.7 Baseline merge
1. `POST /api/baselines/branches/merge?SourceBranch=owner/repo/head&TargetBranch=owner/repo/base&OnlyCheck=false` → **202** + `Location: …/api/tasks/{id}/status`. **The ID arrives URL-encoded** (`…%7e1r`): decode before re-encoding.
2. `GET /api/tasks/{id}/status` → 200 running, **201** done.
3. `GET /api/tasks/{id}/result` → `{merged, conflicts, changes: [...]}`; 404 = a branch doesn't exist.

Results: merged → "Baselines merged into base"; nothing to merge → success; conflicts → failure "N baseline conflicts" (resolve in Eyes: Compare & merge branches); 403 → "Eyes refused the baseline merge" (needs a merge key).

### 10.8 Side-effect-free key probes (for a setup/doctor check)
- Validity / read: `GET /api/sessions/batches/<nonexistent>/bypointerid` → 401 invalid, 403 valid-but-can't-read, **404 can read**.
- Merge: **real** merge of two nonexistent branches → 202 can merge (the task result 404s, so nothing changes), 403 can't. A *check-only* merge is not a valid probe (read keys pass it).
- Or simply read `permissions` from §10.6.

---

## 11. Baseline merge on PR merge

- Trigger: PR closed with `merged: true`, **as read from GitHub** (§8.3); source: the Eyes branch recorded at build time (falling back to `owner/repo/<head.ref>`), target `owner/repo/<base.ref>`.
- Use the merge key (configured → `applitools-merge-api-key` → run key); poll the task every 5 s, for at most 10 min.
- Post **Applitools / Baseline merge** on the PR's last tested commit.
- Keep the review until success, so a redelivered `closed` event (or the next poll) retries after the key or conflicts are fixed.
- Verified live: after merging, the next `main` build passed the accepted Storybook changes instead of flagging them again.

---

## 12. GitHub details

- **Webhook URL needs the trailing slash** (`/github-webhook/` in Jenkins); some relays strip it (smee: add `?relay=smee` to the target). A 302 redirect turns POST into GET → 405.
- **PR state without webhooks:** `GET /repos/{owner}/{repo}/pulls/{n}` → `state`, `merged`, `head.ref`, `base.ref`, `labels[].name`. Send `If-None-Match: <ETag>`; unchanged → `304`, free.
- **Statuses:** `POST /repos/{owner}/{repo}/statuses/{sha}` with `{state, target_url, description, context}`. Token permissions: **Commit statuses: write**, **Pull requests: read**, plus **Contents: read** for private-repo checkout.
- Label webhook delivery can take ~2 minutes through a relay; don't assume seconds.
- **Merged branches:** recommend "Automatically delete head branches", otherwise CI builds the leftover branch as an extra batch.

---

## 13. Setup checks (the "doctor")

The Jenkins setup page checks, live, when an admin clicks **Run checks** (a POST, so following a link can't trigger the requests), and every implementation SHOULD offer the equivalent: the Eyes server is reachable; run/read/merge keys are present and valid, with their permissions (§10.8 / §10.6); designers resolve (show team members); GitHub reporting works (last call OK); webhooks or polling are active; which builds are followed and which are waiting. Each problem comes with the exact fix.

---

## 13a. Security rules

Implementations MUST:

- **Not give fork PRs the key** by default: their test code is untrusted. Refuse with a clear message; allow only by an admin opt-in (then use the fork branch name, §3.2).
- **Confirm webhooks with GitHub** before merging baselines or changing label state (§8.3).
- **Check server URLs** before sending a key: `https` (plain `http` only to the local machine, or by admin opt-in), no user info in the URL, never link-local, unspecified, multicast or cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`).
- **Send keys in headers only.** A query-string fallback for old on-premises servers is admin opt-in.
- **Never echo response content** in errors, logs or PR results: status code and content type only.
- **Cap responses** (Jenkins: 16 MB, before and after decompression).
- **Keep only http(s) links** from Eyes results; show test, batch and environment names as plain text (escape Markdown).
- **Keep the key encrypted** wherever the platform persists state, and mark it secret/sensitive.

Implementations SHOULD offer: an admin lock so the pipeline file can't loosen design review (turn it off, choose designers, change the label, skip results), and an option to leave reviewer emails out of PR results.

---

## 14. Notes for the GitHub Action

| Plugin piece | Action equivalent |
| --- | --- |
| Gated block | A JS action wrapping the test step (or `pre`/`post`): sets env, then closes, waits, reads, posts |
| PR context | `github.event.pull_request.{number, head.sha, head.ref, base.ref, title}`, `github.repository` |
| GitHub App / token | `GITHUB_TOKEN` with `checks: write`, `statuses: write`, `pull-requests: read` |
| Label events | Workflow on `pull_request: [labeled, unlabeled]`: re-evaluate Design review only, no tests |
| Baseline merge | Workflow on `pull_request: [closed]` when `merged == true` |
| Watcher | **No long-running process.** Options: a `schedule` workflow re-checking open PRs (5-minute minimum interval), an Eyes notification → `repository_dispatch`, or `workflow_dispatch` from Eyes. Store per-PR state in the check runs themselves (e.g. an `external_id` or summary metadata) or in an artifact, since there's no registry on disk. |
| Setup page | A `doctor` mode writing §13 to the job summary |
| Secrets | `APPLITOOLS_API_KEY`, `APPLITOOLS_READ_KEY`, `APPLITOOLS_MERGE_KEY` as repo/org secrets |

The Action SHOULD reuse §5–§7 verbatim (outcomes, titles, states) so that PRs look identical whichever CI ran them.

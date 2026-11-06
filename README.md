# Applitools visual review gate

Runs your [Applitools Eyes](https://applitools.com) tests on a pull request and posts two checks on the PR's head commit, keeps them up to date as people review in Eyes, and merges the PR's Eyes baselines when it merges:

| Check | Passes when |
| --- | --- |
| **Applitools / Visual tests** | Every Eyes test passed or created a new baseline. Unreviewed changes are *action required* and link to the batch in Eyes. |
| **Applitools / Design review** | Design review isn't requested (*skipped*), or every visual change was accepted in Eyes, by a designer if you name some. |

Make both required checks, and nothing merges until visual changes are accepted. Reviewers and designers work in Eyes only. You don't need a GitHub App: the workflow's own `GITHUB_TOKEN` posts the checks.

The behavior matches the Applitools Jenkins plugin; [docs/SPEC.md](docs/SPEC.md) is the shared contract.

It has four modes, each a short workflow:

| `mode` | Runs on | Does |
| --- | --- | --- |
| `run` (default) | `pull_request`, and pushes to your main branches | Runs the tests and posts the checks |
| `refresh` | a schedule, by hand, design-review label changes | Updates the checks after reviews in Eyes, without tests |
| `merge` | PR closed | Merges a merged PR's Eyes baselines into its target branch |
| `doctor` | by hand | Checks the setup: Eyes server, keys, designers, token |

## Quick start

1. Add repository (or organization) secrets:
   - `APPLITOOLS_API_KEY`: your Eyes **run** key (uploads tests, closes batches).
   - `APPLITOOLS_READ_KEY`: an Eyes **read** key. Run keys can't read results (Eyes returns 403), so without it the Visual tests check says "Couldn't read Eyes results".
   - `APPLITOOLS_MERGE_KEY`: an Eyes **merge** key (created for a team and a user), for [baseline merges](#merging-baselines-when-a-pr-merges).
2. Wrap your test command:

```yaml
name: Visual tests
on:
  pull_request:
  push:
    branches: [main]     # keeps main's baselines current, and reports baseline merges into it

permissions:
  contents: read
  checks: write          # post the checks
  pull-requests: read    # read labels when the tests finish

jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with: {node-version: 22, cache: npm}
      - run: npm ci
      - uses: applitools/eyes-github-action@v0   # not published yet
        with:
          apiKey: ${{ secrets.APPLITOOLS_API_KEY }}
          readApiKey: ${{ secrets.APPLITOOLS_READ_KEY }}
          run: npx playwright test
```

3. In branch protection (or a ruleset), require **Applitools / Visual tests** and **Applitools / Design review**.

The action sets the batch, branch and key through `APPLITOOLS_*` environment variables, so your tests need no changes (one exception: Playwright, below).

## How a run works

1. Sets `APPLITOOLS_API_KEY`, `APPLITOOLS_SERVER_URL`, `APPLITOOLS_BATCH_ID` (the PR head SHA), `APPLITOOLS_BATCH_NAME` (`owner/repo PR #7: title`), `APPLITOOLS_BATCH_SEQUENCE`, `APPLITOOLS_BRANCH_NAME` (`owner/repo/feature`), `APPLITOOLS_PARENT_BRANCH_NAME` (`owner/repo/main`), `APPLITOOLS_DONT_CLOSE_BATCHES=true`, `APPLITOOLS_GATE_MANAGED=true` (and `APPLITOOLS_JENKINS_MANAGED=true`, so Jenkins-ready configs work unchanged). Posts Visual tests as *in progress*, and Design review as *in progress* ("Waiting for visual tests"), so a re-run never shows the previous run's verdict.
2. Runs `run` with bash (`-eo pipefail`, like a `run:` step). Action inputs, including the GitHub token, are kept out of its environment.
3. Closes the batch, waits for Eyes to finish rendering (up to `resultsTimeout`), and reads the results with the read key.
4. Posts both checks and the job summary, and prints the verdict, e.g. `Changes to review: 2 of 10 with visual changes to review → https://eyes…`.
5. The step fails if the test command failed or Eyes tests failed. Unreviewed changes don't fail it by default (`onChanges: SUCCESS`): the check is the gate, and waiting on reviewers isn't a failure. Problems talking to Eyes or GitHub never fail the step; the checks show them.

It uses the PR's **head commit**, not the merge commit `GITHUB_SHA` points to on `pull_request` events, so the checks land on the commit GitHub shows.

## Updating the checks after a review in Eyes

The checks show what Eyes said when the tests finished. When someone accepts or rejects changes in Eyes later, `mode: refresh` re-reads the batch and updates both checks in place. It runs no tests, so a job takes seconds. Add a second workflow:

```yaml
name: Applitools refresh
on:
  schedule:
    - cron: '7-59/10 * * * 1-5'   # every 10 min on weekdays, off the top of the hour
  workflow_dispatch:
    inputs:
      pr: {description: 'Pull request number (empty: every open PR)', required: false}
  # _target: runs this file as it is on the main branch, with secrets, for fork PRs too. Safe because it never
  # checks out the PR's code; don't add a checkout of it.
  pull_request_target:
    types: [labeled, unlabeled]

permissions:
  checks: write
  pull-requests: read

jobs:
  refresh:
    # Other labels don't need a refresh (a skipped job isn't billed).
    if: github.event_name != 'pull_request_target' || github.event.label.name == 'design-review'
    runs-on: ubuntu-latest
    steps:
      - uses: applitools/eyes-github-action@v0
        with:
          mode: refresh
          readApiKey: ${{ secrets.APPLITOOLS_READ_KEY }}
          pullRequest: ${{ inputs.pr }}
          # Same design review settings as the test workflow:
          # designers: team:Design
```

- **What it reads:** each PR's state comes from the hidden note at the end of its Visual tests check, so there's nothing to store. A PR whose tests are still running, or whose last run had no Eyes results, is skipped.
- **What it posts:** only checks whose state or title changed. The expectations and the list of changed tests are the gated run's, not the refresh workflow's.
- **Labels:** adding or removing the design review label refreshes that PR right away (unless the test workflow forced design review with `designReview` or `APPLITOOLS_DESIGN_REVIEW`).
- **Right away, by hand:** Actions → Applitools refresh → Run workflow, with the PR number.
- **Cost:** a schedule bills at least 1 minute per run in private repos, even with nothing to update: about 1,580 minutes a month for the cron above, 1,060 at every 15 minutes. Public repos are free. See [the proposal](docs/WATCHER-PROPOSAL.md#triggers-compared) for other schedules. Each pass makes 1 GitHub call to list PRs, 2 per PR to read checks, and 1 Eyes read per PR (~1.2 KB gzipped for 10 tests).
- **Verified live** (2026-11-06): after the changes were accepted in Eyes, a label-triggered refresh turned Visual tests from *4 visual changes to review* to *22 passed* and Design review from *Waiting for design review* to *Approved*, in the same check runs, with no test re-run. Each refresh job took seconds.
- **Not possible with `GITHUB_TOKEN`:** a refresh button on the check (GitHub doesn't start workflows from it) and instant updates from Eyes (Eyes has no review webhook yet).

## Merging baselines when a PR merges

Reviewers accept changes on the PR's Eyes branch (`owner/repo/feature`). When the PR merges, `mode: merge` merges that branch into the target's (`owner/repo/main`), so the next `main` build doesn't flag the same changes again. Add a third workflow:

```yaml
name: Applitools baseline merge
on:
  pull_request_target:     # secrets for fork PRs too; safe because it never checks out the PR's code
    types: [closed]

permissions:
  checks: write
  pull-requests: read

# One merge at a time into each branch.
concurrency: applitools-merge-${{ github.event.pull_request.base.ref }}

jobs:
  merge:
    if: github.event.pull_request.merged == true   # closed without merging: nothing to do, nothing billed
    runs-on: ubuntu-latest
    steps:
      - uses: applitools/eyes-github-action@v0
        with:
          mode: merge
          mergeApiKey: ${{ secrets.APPLITOOLS_MERGE_KEY }}
```

Every outcome shows on the PR as **Applitools / Baseline merge** (posted on its last commit, so don't make it required). Anything that needs fixing also fails the job, so it shows as a failed run and GitHub notifies whoever merged.

| Check | Means | What to do |
| --- | --- | --- |
| ✅ Baselines merged into main | N baseline changes now apply to `main` | Nothing |
| ✅ Nothing to merge | The PR's branch had no baseline changes | Nothing |
| ❌ N baseline conflicts | The same checkpoints changed on `main` too | Resolve them in Eyes under **Compare & merge branches**, then re-run the job |
| ❌ Eyes refused the baseline merge | The key isn't a merge key | Add a merge key as `APPLITOOLS_MERGE_KEY`, then re-run the job |
| ❌ Baseline merge skipped | No key at all | Same |
| ❌ Baseline merge timed out | Eyes was still merging after `mergeTimeout` (600 s) | Check the branch in Eyes; the merge may still finish there |
| ❌ Baseline merge failed | Anything else, e.g. Eyes has no such branch | Read the check; re-run the job or merge by hand in Eyes |

- **It reads the PR from GitHub**, not from the event, and merges from the Eyes branch the test run recorded. Fork PRs get their own branch (`owner/repo/pr-N`), so a fork's `main` can't touch yours.
- **The next `main` build waits** up to 60 s for a merge that's still running, then says in its log how each merge into `main` went. A failed one is a warning, also shown in its Visual tests check: until the baselines are merged, that build may flag changes the PR already accepted.
- **Retry** is **Re-run jobs** on the failed merge run, once the key or conflicts are fixed. Or merge by hand in Eyes under **Compare & merge branches**.
- **Cost:** one job per merged PR, usually under a minute: one GitHub read, one Eyes merge request, a status poll every 5 s.

## Checking the setup

`mode: doctor` checks, without changing anything: the Eyes server URL is allowed and answers; the run key can upload, the read key can read, and the merge key can merge (with harmless requests); the designers resolve (Eyes teams, with their members); and the token can read pull requests. Each problem comes with its fix, in the job summary.

```yaml
name: Applitools setup check
on: workflow_dispatch
permissions: {pull-requests: read}
jobs:
  doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: applitools/eyes-github-action@v0
        with:
          mode: doctor
          apiKey: ${{ secrets.APPLITOOLS_API_KEY }}
          readApiKey: ${{ secrets.APPLITOOLS_READ_KEY }}
          mergeApiKey: ${{ secrets.APPLITOOLS_MERGE_KEY }}
          designers: team:Design      # as in your test workflow
```

### SDK setup

So that diffs don't fail the test command (errors still do), the action sets:

| SDK | What |
| --- | --- |
| Storybook | `APPLITOOLS_EXITCODE=nodiffs` (if not already set) |
| Cypress | `APPLITOOLS_FAIL_CYPRESS_ON_DIFF=false` (if not already set) |
| Playwright | No env switch. Add to your Eyes config: `failTestsOnDiff: process.env.APPLITOOLS_GATE_MANAGED ? false : undefined` |
| Others | `getAllTestResults(false)` / `close(false)` |

Turn this off with `judgeDiffs: false`.

## Design review

Design review is required when, first match wins: the `designReview` input is `true`/`false`; the `APPLITOOLS_DESIGN_REVIEW` env var is `true`/`false`; the PR has the `design-review` label (`designReviewLabel`); `designReviewByDefault: true`.

`designers` limits who can approve. Separate entries with commas or new lines (not spaces: team names have them). Each entry is an Eyes login email or `team:<Eyes team name or id>`:

```yaml
          designers: |
            dana@example.com
            team:Tim's Eyes Org
```

Teams are read from Eyes with the read key, so you manage designers in Eyes, where they review. If a team can't be found, nobody from it can approve. Leave `designers` empty to let anyone who reviews in Eyes approve.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | `run` | `run`, `refresh`, `merge` or `doctor` (see above) |
| `run` | required with `mode: run` | Test command (bash) |
| `workingDirectory` | | Where to run it |
| `apiKey` | `$APPLITOOLS_API_KEY` | Eyes run key |
| `readApiKey` | `$APPLITOOLS_READ_KEY`, else the run key | Eyes read key |
| `mergeApiKey` | `$APPLITOOLS_MERGE_KEY`, else the run key | Eyes merge key, for `mode: merge` |
| `mergeTimeout` | `600` | Seconds to wait for Eyes to merge |
| `serverUrl` | `https://eyes.applitools.com` | Dedicated cloud or on-prem |
| `batchId`, `batchName`, `branchName`, `parentBranchName` | derived | Overrides; `${VAR}` is expanded |
| `closeBatch` | `true` | Close the batch after the command |
| `waitForResults` | `true` | Wait for rendering and read results (`false` posts a neutral check) |
| `resultsTimeout` | `300` | Seconds to wait for rendering |
| `onChanges` | `SUCCESS` | Unreviewed changes: `SUCCESS` (step passes), `UNSTABLE` (warning), `FAILURE` (fail the step) |
| `judgeDiffs` | `true` | Set the SDK variables above |
| `expectTests` | | Minimum number of Eyes tests; fewer fails the check |
| `expectApps` | | Eyes app names that must each report a test (comma/newline separated) |
| `checks` | `true` | Post results to the PR |
| `githubReporting` | `CHECKS` | `CHECKS` (`checks: write`) or `STATUSES` (commit statuses, `statuses: write`) |
| `githubToken` | `${{ github.token }}` | Token that posts results |
| `designReview` | | `true`/`false` forces design review |
| `designReviewLabel` | `design-review` | Label that requests design review |
| `designers` | anyone | Emails and/or `team:<Eyes team>` |
| `designReviewByDefault` | `false` | Every PR needs design review |
| `designReviewCheck` | `true` | Post the Design review check (as *skipped* when not requested) |
| `hideReviewers` | `false` | Leave reviewers' and designers' Eyes emails out of PR results ("Approved by a designer") |
| `allowForkPullRequests` | `false` | Run fork PRs' tests, giving their code the run key |
| `allowHttp` | `false` | Allow plain http to an Eyes server other than this machine |
| `apiKeyInQuery` | `false` | Old on-premises servers: retry closing a batch with the key in the URL |
| `repo`, `pullRequest`, `commit`, `branch`, `targetBranch` | from the event | Explicit PR context. With `mode: refresh`, `pullRequest` picks one PR; empty means every open PR |

Outputs: `outcome` (`PASSED`, `CHANGES`, `FAILED`, `NO_RESULTS`), `summary`, `batchId`, `batchUrl`, `designReview` (`NOT_REQUESTED`, `WAITING`, `APPROVED`, `CHANGES_REQUESTED`), `baselineMerge` (`MERGED`, `NOTHING_TO_MERGE`, `CONFLICTS`, `REFUSED`, `NO_KEY`, `TIMED_OUT`, `FAILED`).

## Security

The action follows the plugin's security rules ([SPEC §13a](docs/SPEC.md#13a-security-rules)):

- **Fork PRs** don't run tests with your key: the step stops with an explanation (`allowForkPullRequests: true` to allow it). GitHub withholds secrets from them on `pull_request` anyway.
- **Keys go only to an allowed Eyes server:** `https` (plain `http` only to this machine, or with `allowHttp`), no user name or password in the URL, never a link-local, multicast or cloud metadata address. Keys travel in a header, never in a URL unless `apiKeyInQuery` is set.
- **Eyes responses** are capped at 16 MB and never echoed in errors (status and content type only). Only `http(s)` links from them are kept, and test, batch and environment names show as plain text in PR checks.
- **Reviewer emails** are public on public repositories; `hideReviewers: true` leaves them out.
- **Workflow files are the configuration.** A PR can edit the test workflow it runs, including its design review settings; the plugin's admin lock has no Action equivalent. Protect `.github/workflows/` with CODEOWNERS, and run the refresh and merge workflows on `pull_request_target`, which always uses the main branch's copy.

## Good to know

- **One gated step per batch.** Everything inside `run` shares one batch and one pair of checks. Running the action twice for the same commit reuses the commit-based batch ID.
- **Pull requests from forks** get a read-only `GITHUB_TOKEN` and no secrets on `pull_request`, so their tests and checks can't run. Don't run the *test* workflow on `pull_request_target` to get around it: that would run the fork's code with your secrets.
- **Check runs come from "GitHub Actions"**, so pick that source (or any source) when you require them.
- **The check's "Details" link opens the workflow run**, not Eyes: GitHub replaces the details URL on checks made with `GITHUB_TOKEN`. Use **Review in Eyes** at the top of the check instead.
- **Cost:** the wait for rendering runs on your runner and counts toward Actions minutes, up to `resultsTimeout`. Eyes calls are small: one close, a status poll every 5 s while rendering (~0.8 KB each), one results read (~1.2 KB gzipped for 10 tests). GitHub: 3 API calls per run.
- **Merged branches:** turn on "Automatically delete head branches", or a push build of the leftover branch makes an extra batch.

## Development

```bash
npm ci
npm run all   # typecheck, tests, and rebuild dist/
```

`dist/` is committed (GitHub runs it directly), so rebuild it with every source change. Tests run against a fake Eyes server that mirrors the response shapes in [SPEC §10](docs/SPEC.md#10-eyes-api-reference-as-used-and-verified).

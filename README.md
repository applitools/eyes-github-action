# Applitools visual review gate

Runs your [Applitools Eyes](https://applitools.com) tests on a pull request and posts two checks on the PR's head commit:

| Check | Passes when |
| --- | --- |
| **Applitools / Visual tests** | Every Eyes test passed or created a new baseline. Unreviewed changes are *action required* and link to the batch in Eyes. |
| **Applitools / Design review** | Design review isn't requested (*skipped*), or every visual change was accepted in Eyes, by a designer if you name some. |

Make both required checks, and nothing merges until visual changes are accepted. Reviewers and designers work in Eyes only. You don't need a GitHub App: the workflow's own `GITHUB_TOKEN` posts the checks.

The behavior matches the Applitools Jenkins plugin; [docs/SPEC.md](docs/SPEC.md) is the shared contract.

> **Status: milestone 1.** The gated test run works. Updating the checks after someone reviews in Eyes (without re-running tests), label events, and baseline merging are still to come; see [docs/WATCHER-PROPOSAL.md](docs/WATCHER-PROPOSAL.md). Until then, re-run the job to refresh the checks.

## Quick start

1. Add two repository (or organization) secrets:
   - `APPLITOOLS_API_KEY`: your Eyes **run** key (uploads tests, closes batches).
   - `APPLITOOLS_READ_KEY`: an Eyes **read** key. Run keys can't read results (Eyes returns 403), so without it the Visual tests check says "Couldn't read Eyes results".
2. Wrap your test command:

```yaml
name: Visual tests
on: pull_request

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
      - uses: applitools/visual-review-action@v0   # not published yet
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
| `run` | **required** | Test command (bash) |
| `workingDirectory` | | Where to run it |
| `apiKey` | `$APPLITOOLS_API_KEY` | Eyes run key |
| `readApiKey` | `$APPLITOOLS_READ_KEY`, else the run key | Eyes read key |
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
| `repo`, `pullRequest`, `commit`, `branch`, `targetBranch` | from the event | Explicit PR context |

Outputs: `outcome` (`PASSED`, `CHANGES`, `FAILED`, `NO_RESULTS`), `summary`, `batchId`, `batchUrl`, `designReview` (`NOT_REQUESTED`, `WAITING`, `APPROVED`, `CHANGES_REQUESTED`).

## Good to know

- **One gated step per batch.** Everything inside `run` shares one batch and one pair of checks. Running the action twice for the same commit reuses the commit-based batch ID.
- **Pull requests from forks** get a read-only `GITHUB_TOKEN` and no secrets, so neither the tests nor the checks can run. That's GitHub's rule for `pull_request`; don't switch to `pull_request_target` to get around it unless you trust the code you check out.
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

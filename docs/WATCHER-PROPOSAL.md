# Proposal: updating checks after review in Eyes (SPEC §8, §14)

**Problem.** When someone accepts changes in Eyes, both checks should update without re-running tests. Jenkins keeps a watcher thread polling Eyes. GitHub Actions has no long-running process, so something has to start a short job, and that job needs per-PR state (batch ID, changed tests, expectations) without a disk.

## State: keep it in the check runs (done in milestone 1)

Every gated run writes its state at the end of the **Visual tests** check summary as an HTML comment (`<!-- applitools-gate-state {...} -->`, which GitHub doesn't render) and sets `external_id` to the batch ID. It holds the batch ID, Eyes batch ID, the changed test IDs, `expectTests`/`expectApps`, and whether design review was forced. Designers and the label name come from the follow-up workflow's own inputs.

Why check runs, not the alternatives:

| Store | Verdict |
| --- | --- |
| **Check run summary** | Free, readable with `checks: read`, tied to the exact head SHA (a new push naturally starts over), no retention limit. Needs only `GET /commits/{sha}/check-runs?check_name=…`. |
| Workflow artifact | Expires (90 days max), needs a cross-run download by run ID: awkward. |
| Actions cache | Evictable (10 GB LRU), so state can disappear while a PR is open. |
| Repo variables | `GITHUB_TOKEN` can't write them. |
| PR comment | Visible noise; anyone can edit. |

Not yet verified live: that GitHub returns `output.summary` with the HTML comment intact. Fallback if it doesn't: put the JSON in `output.text`, which is also free-form.

## Triggers compared

| | Scheduled workflow | Eyes → `repository_dispatch` | Manual / PR events only |
| --- | --- | --- | --- |
| Latency | 5 min minimum; GitHub delays scheduled runs under load (worst at the top of the hour) and may drop some | Seconds | Whenever someone acts |
| Setup | Copy one workflow file | Webhook in Eyes plus a GitHub token stored in Eyes, plus probably a relay (see below) | None |
| Works today | Yes | **No.** Eyes notifications are email and Slack, sent when a batch *closes*, not when someone reviews ([docs](https://applitools.com/docs/features/batch-completion-notifications.html)). Needs Eyes R&D. | Yes |
| Actions minutes (private repos) | Each run bills at least 1 minute, even with nothing to do (see below) | ~1 minute per review event | ~1 minute per event |
| Failure mode | Silent delays; GitHub disables schedules after 60 days without repo activity (public repos) | A lost webhook means a stale check until the next event | Stale until someone acts |

**Scheduled cost, by cron (private repos; public repos on standard runners are free):**

| Schedule | Runs/month | Billed minutes/month |
| --- | --- | --- |
| Every 5 min, 24/7 | 8,640 | ~8,640 |
| Every 10 min, 24/7 | 4,320 | ~4,320 |
| Every 10 min, weekdays 12 h | ~1,580 | ~1,580 |
| Every 15 min, weekdays 12 h | ~1,060 | ~1,060 |

For scale: GitHub Free includes 2,000 private-repo minutes a month and Team 3,000. A job can't skip itself before it's billed (a job-level `if:` only sees contexts, not API results), so "nothing pending" still costs a minute.

API load per scheduled pass: 1 `pulls.list` + 1 check-run listing per open PR, and Eyes reads only for PRs whose checks are `action_required` (~1.2 KB gzipped per 10 tests). With 20 open PRs every 10 minutes, that's ~126 GitHub requests/hour, well under `GITHUB_TOKEN`'s 1,000/hour per repo.

**Doesn't work:** check run "Refresh" buttons (`requested_action`). GitHub doesn't trigger workflows from check-run events whose check suite belongs to GitHub Actions, and ours do, because `GITHUB_TOKEN` creates them.

## Recommendation

**Ship a scheduled refresh as the default, with immediate manual triggers. Pursue the Eyes webhook separately.**

1. Add `mode: refresh` to the action (no tests). Without a PR number it lists open PRs. For each, it reads the state from the latest Visual tests check, skips settled PRs (neither check `action_required`), re-reads Eyes, re-applies expectations, and posts only what changed (compare by `conclusion` + title, SPEC §8.2).
2. Ship an example `applitools-refresh.yml` with `schedule: '7-59/10 * * * 1-5'` (off the top of the hour, weekdays) **and** `workflow_dispatch` with an optional PR number, so a designer's "I approved it" can be applied right away from the Actions tab. Document the minute numbers above so teams can choose their cron.
3. Ask Eyes R&D for a webhook on review events (accept/reject/save) with a configurable URL, headers and body. With that, Eyes can call `POST /repos/{owner}/{repo}/dispatches` directly, without a relay, and the same `mode: refresh` handles `repository_dispatch`. Then the schedule becomes a slow safety net (e.g. hourly).

Why not wait for the webhook: it doesn't exist yet, and even with it, users would have to store a GitHub token in Eyes, which makes setup harder than Chromatic's. The schedule works with copy-paste and `GITHUB_TOKEN` only.

## Follow-up workflows (not built yet)

Both reuse the same refresh code and state.

### Label changes: `pull_request: [labeled, unlabeled]`

```yaml
on:
  pull_request:
    types: [labeled, unlabeled]
jobs:
  design-review:
    if: github.event.label.name == 'design-review'
    runs-on: ubuntu-latest
    permissions: {checks: write, pull-requests: read}
    steps:
      - uses: applitools/visual-review-action@v0
        with:
          mode: refresh
          readApiKey: ${{ secrets.APPLITOOLS_READ_KEY }}
          designers: team:Design
```

- Reads the state from the head SHA's Visual tests check. If there's none yet (tests still running), it does nothing: the gated run reads labels when its tests finish (done in milestone 1).
- If design review was forced (`designForced` in state), label events are ignored (SPEC §6.1).
- Re-evaluates and posts **Design review** only; no tests run. Typical job: 10-20 s, billed as 1 minute.
- Keep the `if:` on the job, so other labels skip it without billing.

### Merge: `pull_request: [closed]`

```yaml
on:
  pull_request:
    types: [closed]
jobs:
  baseline-merge:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    permissions: {checks: write}
    steps:
      - uses: applitools/visual-review-action@v0
        with:
          mode: merge
          mergeApiKey: ${{ secrets.APPLITOOLS_MERGE_KEY }}
```

- Merges `owner/repo/<head.ref>` into `owner/repo/<base.ref>` with the merge key (SPEC §10.7, §11). It falls back to the run key and reports "Eyes refused the baseline merge" on 403. The task ID arrives URL-encoded; decode it. It polls every 5 s, for at most 10 min.
- Posts **Applitools / Baseline merge** on the PR's head SHA (not a required check).
- Retry is "Re-run job" after fixing the key or conflicts. There's no redelivery for Actions, so the summary on failure says exactly that.
- Unmerged closes need nothing: the state lives in check runs, so there's nothing to clean up.

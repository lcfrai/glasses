# Bulk discovery

Glasses can scan public sources across tools, components, skills, agent profiles, collections and references. A scan is a saved plan with finite limits, source receipts and resumable cursors. Acquisition adds verified source records to your local catalogue. It does not call a model, install code, execute instructions from a source, or publish the shared catalogue.

## Use the local workspace

Open **Research → Bulk discovery**, choose the resource lanes and candidate limit, then select **Start bulk scan**. While this Research view stays open, it automatically continues ordinary batch-limit pauses in batches of at most 100 scheduling steps. It stops when a configured cap or source outcome is reached, when a new source error or rate limit needs review, or when you leave the view or close the browser. Leaving the view stops further submissions after the current bounded batch; it does not undo acquisition already underway.

After a stop, explicitly select **Resume scan** to continue the saved plan and re-enable automatic continuation. Returning to Research does not restart a scan by itself. **Cancel scan** stops continuation and requests cancellation of the current batch while preserving pending work. **View source receipts** distinguishes added, updated, already catalogued, duplicate, review-required and failed proposals. Enable **Refresh existing sources** before creating a plan to revisit known records for newer source evidence; model classification remains separate.

The defaults give whole tools the largest scheduling share. GitHub searches use descending stars, while registry components are interleaved across providers. A requested lane is not proof that a repository is a tool, skill or agent. Individual guidance requires an actual `SKILL.md` or `.agent.md`, an exact source revision and a verified scoped licence. Unsupported licences or incomplete source evidence remain review-required rather than appearing as successfully imported guidance.

**Classify new results on this page** is a separate explicit action. It sends up to 30 admitted IDs from the displayed receipt page into the existing processing queue, using your saved provider, job-count and dollar limits. Discovery does not reset or bypass those limits. Classification does not establish licence rights or prove compatibility.

Custom source lanes accept JSON using the adapters below. Source changes apply to a new plan; they do not alter the meaning of an existing cursor.

## CLI

Run these commands from the Glasses project directory with Node 24 and the local service running:

```sh
node scripts/bulk-scan.mjs --status
node scripts/bulk-scan.mjs --run --wait
node scripts/bulk-scan.mjs --run --wait --batches=3
node scripts/bulk-scan.mjs --resume=PLAN_ID --wait
node scripts/bulk-scan.mjs --status=PLAN_ID
node scripts/bulk-scan.mjs --cancel=PLAN_ID
node scripts/bulk-scan.mjs --resume=PLAN_ID --retry-failed --wait
```

No arguments means read-only status. `--run` creates a default plan and starts one bounded acquisition batch; `--resume` starts one batch on an existing plan. CLI and direct MCP/API calls do not inherit the Research view's automatic continuation. `--batches=3` explicitly permits at most three ordinary batch-limit batches. It stops for an upstream rate limit, cancellation, a configured cap or source exhaustion. A CLI wait timeout does not cancel work already running in the service.

Use `--url=http://127.0.0.1:4317` to choose a local service, `--max-steps=30` to bound a batch, or `--timeout=180` to bound CLI waiting in seconds. Only loopback service roots are accepted. The CLI obtains the local session token for both read and write API requests and does not print it.

To create a plan without running it, save a JSON file and use:

```sh
node scripts/bulk-scan.mjs --plan=bulk-plan.json
node scripts/bulk-scan.mjs --run --plan=bulk-plan.json --wait
```

Example plan, using all six default lanes:

```json
{
  "name": "Balanced public catalogue scan",
  "maxCandidates": 240,
  "maxPages": 60,
  "pageSize": 20,
  "refreshExisting": false
}
```

To choose sources explicitly, supply a `lanes` array. Each lane contains `resourceType`, optional `weight` and `limit`, and one to eight `sources`:

```json
{
  "name": "Deployment tools and source guidance",
  "maxCandidates": 40,
  "lanes": [
    {
      "resourceType": "tool",
      "weight": 3,
      "limit": 30,
      "sources": [{"adapter": "github-repositories", "query": "topic:deployment stars:>=1000"}]
    },
    {
      "resourceType": "skill",
      "limit": 10,
      "sources": [{"adapter": "github-guidance", "repository": "anthropics/skills"}]
    }
  ]
}
```

Available adapters:

| Adapter | Configuration | Source evidence |
| --- | --- | --- |
| `github-repositories` | `query` | Public repository search, followed by repository metadata on acquisition |
| `registry-components` | none | Exact registry.directory item index; providers interleaved |
| `registry-collections` | none | Exact registry.directory directory index |
| `github-guidance` | `repository: "owner/name"` | Public metadata, branch commit, explicit complete tree, actual guidance path |
| `public-reference` | `url` | Exact public page with observed title/description where available |

Authenticated GitHub requests may reuse an already signed-in `gh` client, restricted to public GET endpoints. Private repository results are rejected. Without that client/authentication, public HTTPS is used and upstream anonymous rate limits may pause a scan.

## Local MCP and API

The local MCP exposes `glasses_bulk_scan`; the shared read-only hosted MCP does not run discovery against somebody else's local catalogue.

```json
{"action":"create","plan":{"name":"Balanced scan","maxCandidates":240}}
{"action":"run","id":"PLAN_ID","maxSteps":30}
{"action":"status","id":"PLAN_ID","offset":0,"limit":50}
{"action":"cancel","id":"PLAN_ID"}
```

`list` returns saved plans and defaults. `run` is asynchronous: acceptance is not completion, so poll `status`. To retry failed candidates, pass `retryFailed:true` to `run`. To increase global caps, use `amend` with `limits:{expectedVersion,maxCandidates,maxPages}`; the current version prevents overwriting a newer plan. Lane quotas or sources require a new plan. Individual source content remains behind explicit source/evidence inspection.

All local API routes require the `X-Glasses-Token` obtained from `/api/session` on loopback:

| Method and route | Effect |
| --- | --- |
| `GET /api/bulk-scans` | Status, defaults and saved plan summaries |
| `POST /api/bulk-scans` | Create a plan from its JSON definition |
| `GET /api/bulk-scans/:id?offset=0&limit=50` | Plan status and paginated receipts |
| `PUT /api/bulk-scans/:id` | Increase global caps using `expectedVersion` |
| `POST /api/bulk-scans/:id/run` | Start one batch with `maxSteps` and optional `retryFailed`; returns 202 after startup validation |
| `POST /api/bulk-scans/:id/cancel` | Request cancellation with `{}` |

Invalid input, an active worker or a durable lease conflict returns an error instead of falsely accepting a new batch. A second local worker cannot own the same acquisition lease concurrently.

## Limits and recovery

Default limits are 240 import attempts, 60 successful source pages, 20 candidates per page and 30 scheduling steps per run. Default operation/run deadlines are 30/120 seconds. Maximum configurable values are 2,000 attempts, 150 pages, 30 candidates per page, 200 steps per run, six lanes and eight sources per lane. Fifty plans are retained. Per-lane quotas and weighted scheduling prevent a large component index from consuming every scan slot.

Plans and cursors persist in SQLite. Cancellation keeps the current candidate pending; resume checks existing identities to avoid duplicate imports. Failures retain source URLs, hashes and messages. Retry does not reset the cumulative caps. A process restart can resume the last committed checkpoint once the previous lease expires. Lease duration is the run deadline plus one operation deadline and 30 seconds of recovery allowance.

Registry and guidance cursors bind to the exact index/tree fingerprint. If a source changes after a cache eviction or process restart, the old cursor is rejected; create a new plan against the new snapshot. The individual guidance identity uses the verified default branch for a stable catalogue URL while acquisition evidence remains pinned to the exact commit and Git blob. No branch name or filename alone establishes source rights.

`paused / batch-limit` is ordinary resumable progress. `paused / upstream-rate-limit` retains the exact pending operation. `paused / run-error` records an unexpected error when storage remains writable. `bounded / configured-cap` means a quota was reached, not that the upstream source is exhausted. `partial` means the scan exhausted its usable sources with historical errors; inspect the receipts because some errors may have been resolved by retry. Review-required entries are not automatically admitted or retried.

## Previews and adoption

**Has preview** filters items with a retained preview image. A preview is a dated static capture with a source link; it is not a live embedded component, installation result or compatibility test. Preview availability is partial. Use the component's linked documentation and parent collection to inspect its actual source and requirements before adoption. Bulk acquisition does not manufacture a working preview or execute arbitrary source code.

The local catalogue and shared public catalogue remain separate: review, classification, strict public projection and explicit publication determine what reaches the shared snapshot.

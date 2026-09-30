# Keeping the catalogue useful

Glasses records two independent decisions: **what a candidate does** and **how to use it**. An office editor can support document editing and collaboration while being installed as a desktop application or self-hosted service. Self-hosting does not make it a deployment platform. Purpose labels are evidence-backed suggestions, not installation approval.

## Refresh an existing entry

The local Research page includes **Keep the catalogue current**. Refresh the next bounded batch there, or call the local MCP tool:

```json
{"name":"glasses_refresh_catalogue","arguments":{"action":"status"}}
{"name":"glasses_refresh_catalogue","arguments":{"action":"run","ids":["CATALOGUE_ID"]}}
```

Omit `ids` to refresh the oldest due repositories. An explicit batch accepts at most30 distinct existing public GitHub IDs. Refresh fetches the repository metadata, current star count, current commit, pinned README and licence evidence. It does not execute upstream code. Identity changes, private repositories and upstream failures retain errors and previous evidence instead of silently replacing a candidate.

Default maintenance is enabled, with a72-hour minimum age and10 repositories per scheduled discovery cycle. The local server and its discovery schedule must be running. This is not an operating-system scheduler or a promise that a public hosted reader performs research. Configure maintenance through the Research controls or `action:configure` with `settings:{enabled,minAgeHours,batchSize}`. Valid ranges are24–2160hours and1–30records. Existing registry discovery continues renewing component metadata.

When automatic classification is enabled, updated candidates enter the ordinary source-aware classification queue. Processing keeps the configured provider, daily job limit and dollar cap. No model call is needed merely to read refresh status.

## Reassessment and corrections

Classification policy `glasses-purpose-v3` expands purpose descriptors and distinguishes application installation, CLI usage, hosted services, API integration and browser extensions. A policy change invalidates the local classification cache even when source bytes are unchanged. Source changes also invalidate it. Existing human corrections stay separate and survive reassessment; provider labels are not allowed to overwrite them.

Imported public assessments are attributed historical labels, not portable local inference-cache entries. The public projection validates source fingerprints and citations. A newer source-safe reassessment can replace an older assessment even if the upstream metadata observation did not change. Older, conflicting or replayed facts remain rejected.

## Publish and receive updates

The shared catalogue is a reviewed public snapshot. Refreshing the local database does not publish local workspaces, outcomes, corrections, research plans, credentials or raw source bodies. The publisher exports and validates only selected public metadata and attributed assessments, tests the website and MCP against the same content hash, then deploys that snapshot.

The hosted MCP at `https://lcfr.ai/api/mcp` reads the deployed snapshot immediately after publication; reconnecting or installing a local server is unnecessary for normal catalogue updates. Local users choose **Import latest catalogue**, or run `npm run catalogue:fetch`. Import is explicit and preserves local overlays. Source release0.3.1 is required to read the expanded adoption values; strict0.3.0 readers must upgrade before importing this newer vocabulary. This is not a forward-compatible change for those older enum validators.

Stars are timestamped observations. Popularity helps discovery order; licences, suitability and compatibility still require inspection. Models can omit useful tags or make mistakes, so descriptions, upstream topics, citations and direct source inspection remain available alongside model labels.

## Collections, source detail and agent guidance

Resource types distinguish Components (individual interface parts), Tools (applications, services and libraries), Skills (reusable agent instructions), Agents (agent profiles or systems), Collections (linked inventories) and References. These source-derived descriptors remain separate from model purpose and adoption assessments. Use `resourceType` to narrow local or public MCP search.

Inspect a collection, then call `glasses_search` with its `parentId`. Hosted search pages with `cursor`; local search pages with `offset`. Parent member counts describe the published inventory, not an assertion that every upstream module was ingested. Components can expose documented use cases, props, dependencies, file counts and source keywords. A source documentation screenshot is a dated illustration, not a test that the component works in your application.

Skills and agent profiles retain stable card identity with pinned source revision and file hashes. Reviewed download bundles preserve upstream files and scoped licence notices; downloading or reading one does not install or execute it. Review its instructions, tools and permissions in your own agent before adoption. Compatibility labels are source declarations unless a separate trial says otherwise. Snapshot updates can revise these details under the same identity. Repository refresh does not automatically rebuild every published skill bundle or screenshot; the publisher must re-fetch, review and publish those artifacts.

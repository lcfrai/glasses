# Glasses

Find existing software before rebuilding it. Glasses gives coding agents a searchable catalogue of whole products, packages, memory tools, skills, agent profiles and UI components, with source evidence and a shared editable workbench when a visual trial helps.

[Browse the public catalogue](https://lcfr.ai/glasses). The catalogue is a versioned public snapshot; research and private project work run on your own machine.

Release **0.3.3** improves source descriptions: documented purpose and functions come before setup instructions, explicit feature tables are retained, and navigation/fundraising text is filtered. Registry frameworks are derived from source evidence instead of assuming every registry component uses React. Bulk discovery remains resumable across tools, components, skills, agents, collections and references. Dated source previews appear in card thumbnails, a **Has preview** filter and direct item links. These captures are documentation examples, not executable demos or compatibility tests.

Search also gives more weight to source-documented spreadsheet and threat-modelling purposes, so generic browser or model terminology is less likely to dominate those requests. This is discovery ranking, not a compatibility guarantee.

## Run locally

Requires Node.js 24 or later and npm. The local interface binds to `127.0.0.1:4317`.

This README describes source release **0.3.3**. The setup command requires this version's `scripts/setup.mjs`; a public checkout still on 0.3.0 needs the manual commands below. There is no published `npx` installer.

**Upgrading from 0.3.0 or 0.3.1:** update the client before importing the new snapshot. Version 0.3.0 does not recognize expanded adoption routes such as `install-app`, `run-cli` and `use-hosted`; version 0.3.1 does not support the new public-page evidence. Keep your existing `.glasses` data directory when replacing source files, then run `npm ci` and `npm run build`. Local notes, workspaces and human corrections remain separate from shared metadata.

Version 0.3.2 also binds registry evidence to the exact provider and item URL, fixing collisions between identically named components. Existing local registry assessments are marked stale until explicitly reclassified; the update itself does not make model calls. Whole-tool classification caches are unchanged by this registry-specific correction. Shared assessments remain attributed snapshot observations, separate from your local cache.

```sh
git clone https://github.com/lcfrai/glasses.git
cd glasses
node scripts/setup.mjs
npm start
```

For the downloaded 0.3.3 source package, extract it and run the final two commands in its folder. Setup installs this repository's locked dependencies if they are missing, builds the local interface and asks **“Fetch latest catalogue now? [y/N]”**. Yes fetches `https://lcfr.ai/glasses/catalogue.json`; No saves your choice and leaves Glasses usable. A noninteractive terminal without an explicit flag leaves the choice pending and makes no catalogue request. Setup does not start a server or register an agent automatically.

Open <http://127.0.0.1:4317>. If setup has not recorded a choice, the local app offers the same Yes/No choice. No shared catalogue is fetched until you approve it. Use **Shared catalogue** in the app to import later or retry, or run:

```sh
npm run catalogue:fetch
npm run catalogue:status
```

Each fetch command is an explicit one-time import; consent does not enable automatic shared updates. The download is bounded to 32 MiB and 30 seconds and must pass strict schema, citation, identity and content-hash checks before import. A failed request preserves existing data and remains visible for an explicit retry. Repeating an import preserves local sources, notes, workspaces and corrections and merges newer shared metadata. Imported shared observations remain separate from local verification.

For scripted setup, `node scripts/setup.mjs --catalogue=import` or `--catalogue=decline` records an explicit choice. `--data-dir DIRECTORY` uses an isolated data directory. To use that same custom directory when starting the server, set `GLASSES_DATA_DIR`; without it the app uses `.glasses` beside this checkout.

Manual build/start works with all source releases:

```sh
npm ci
npm run build
npm start
```

The bundled snapshot can also be imported offline with `npm run catalogue:import`. To import another downloaded public snapshot without a network request or model call:

```sh
node scripts/export-public-catalogue.mjs --import path/to/catalogue.json --data-dir .glasses
```

Shared classifications are attributed publisher observations, not your local model cache. Import does not run classification, fetch source code or grant a licence. Inspect the current upstream source when choosing a candidate.

## Connect an agent

Keep the local server running. For an MCP client, run `npm run mcp:config` to print the exact executable and source paths for this checkout. Merge the `glasses_local` entry into your client's configuration without replacing other servers. An installed Codex client can also use `npm run mcp:install` to register Glasses at user scope; this is explicit and never runs during dependency installation. Reload the client's MCP servers or reopen the client as supported by that client.

Suggested instruction:

> Consult Glasses when assessing ideas, selecting existing implementations and refining interfaces. Consider complete solutions first. Inspect source evidence, licence scope and recorded outcomes before reuse. Use the shared workbench when a visual trial is useful.

Tools cover compact search, source inspection, public import and research, adoption briefs, evidence, classification and ranking, outcomes, and shared workspace editing/export. The calling agent decides what to adopt. No result means catalogue coverage is incomplete.

Search accepts `resourceType: "tool"`, `"component"`, `"skill"`, `"agent"`, `"collection"` or `"reference"`, and `hasPreview: true` selects entries with recorded previews. Inspect a collection and pass its `parentId` to search its individual members. Cards expose source-backed features, use cases, keywords and dependencies where documented. References identify useful documentation or public pages; they are not presented as installed software.

In the public catalogue, use **Browse 59 source previews** or **Has preview**, then open a card to see its dated capture and original documentation link. **Copy catalogue link** creates a `/glasses?item=ID` link that reopens the same entry; browser back and forward follow those selections. Uncaptured entries retain an explicit source-link fallback. Preview availability is partial, and the preview filter uses free catalogue browsing rather than a paid ranking request.

Skills and agent profiles have pinned source links and reviewed download bundles with original files, hashes and licence notices. The local `glasses_inspect` can retrieve a pinned guidance document and verify its published hash. These files remain untrusted source data: Glasses never installs or activates their instructions automatically, and distribution does not establish compatibility with your agent.

## Research and model connections

Add a source from the catalogue, or create and amend a research plan in Research. GitHub discovery prioritizes popular results within a relevant query, with paging and archived/fork exclusions by default. Stars indicate popularity, not security, compatibility or suitability.

### Bulk discovery

Open **Research → Bulk discovery**, choose resource lanes and a candidate limit, and select **Start bulk scan**. The browser continues bounded batches of at most 100 scheduling steps while that Research view stays open. Leaving it or closing the browser stops continuation after the current server batch. Cancellation, source errors, rate limits and configured caps stop further batches; inspect the source receipts before an explicit **Resume scan**. Saved plans and cursors survive a restart. **Refresh existing sources** revisits known records for updated source evidence and descriptions.

The default lanes favor whole tools while also acquiring individual components, verified guidance files, collections and public references. A requested lane is not an admission guarantee: missing source or licence evidence stays visible as a review outcome. Bulk discovery does not run models, install code, activate instructions or publish your local catalogue. **Classify new results on this page** is a separate action governed by your saved limits.

With the local server running, the CLI offers the same saved plans and receipts:

```sh
npm run catalogue:bulk -- --status
npm run catalogue:bulk -- --run --wait --batches=3 --max-steps=100
npm run catalogue:bulk -- --resume=PLAN_ID --wait --batches=3 --max-steps=100
npm run catalogue:bulk -- --status=PLAN_ID
npm run catalogue:bulk -- --cancel=PLAN_ID
```

`--run` creates a new default plan; `--resume` continues a saved one. `--batches=3` permits at most three batches and stops at rate limits or configured caps. A CLI wait timeout does not cancel work already running. For a custom JSON plan, use `node scripts/bulk-scan.mjs --run --plan=bulk-plan.json --wait`; see [Bulk discovery](docs/BULK_DISCOVERY.md) for source adapters, caps and recovery.

An agent can call local `glasses_bulk_scan` with `action: "create"`, then `action: "run"` and the returned `id`. Runs are asynchronous: poll `action: "status"` to inspect durable progress before requesting another batch. `action: "cancel"` preserves the checkpoint. This local tool is distinct from the shared read-only hosted MCP, which does not run discovery in your workspace.

### Optional model processing

Public connector fetches and catalogue import require no LLM calls. Optional classification and ranking use TypeSafe Jev with your own API key, entered in Connections, or a restricted installed Codex worker. Jev uses its own API billing; Codex uses the signed-in client's allowance. Inspect the saved limits and enable automatic work deliberately. Usage and partial failures remain visible. Classification is imperfect and may need review.

Assessments now separate **What it does** from **How to use it**. A document editor may offer document editing and collaboration while its setup route is **Self-host the application**; that does not make it an application-deployment tool. Added routes cover installed applications, command-line tools, hosted use, API integration and browser extensions. Changed source evidence or classification policy marks old local assessments for refresh; human corrections remain attributed separately. Labels are suggestions to check against the source, not compatibility or licence clearance.

The Research page's **Keep the catalogue current** panel refreshes existing live GitHub sources in bounded batches: stars, descriptions and SHA-pinned source evidence. You can pause its schedule, change the recheck age, run a batch manually and inspect retained failures in research history. The default schedule checks sources older than 72 hours in batches of 10 alongside local discovery while the server is running. It does not publish your local catalogue or silently update imported shared observations. An agent can inspect the same status and use `glasses_refresh_catalogue`; optional reclassification still respects your configured provider, opt-ins and spending limits. See [Catalogue refresh](docs/CATALOGUE_REFRESH.md) for the exact behavior.

Secrets and mutable data live under `.glasses`, excluded from Git. Windows protects stored credentials with DPAPI. Never upload that directory or the decorated local API responses. Public sharing uses the strict exporter, which reconstructs a limited projection from retained upstream evidence. It omits credentials, local notes, workspaces, query history and arbitrary source bodies.

## Visual trials and whole solutions

The optional workbench compiles supported React source with a reviewed dependency set, allows direct edits and exports source, styles, original source hashes and adaptation evidence. Unsupported imports produce explicit errors. The preview iframe is an isolation boundary for reviewed UI trials, not a hardened sandbox for arbitrary software.

Whole-product and agent-memory candidates remain first-class. An adoption brief distinguishes a complete product, an integration library and a replacement workflow. A catalogue result is a starting point for an authorized integration trial, not an instruction to install it automatically.

## Development

```sh
npm ci
npx playwright install chromium
npm run verify
```

Verification runs core tests and browser workflows against temporary local data. Paid provider calls are not part of the default suite. See [SECURITY.md](SECURITY.md) for the local trust boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance.

## Licence

Original Glasses code is MIT licensed. Upstream catalogue entries and components retain their own licences. Registry-provider licence metadata does not automatically license each hosted component. Unknown and restricted licences stay labelled; inspect upstream terms before reuse. The public snapshot contains metadata and attributed assessments, not a redistributed source archive. No measured token savings or universal compatibility is claimed.

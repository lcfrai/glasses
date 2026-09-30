# Glasses

Find existing software before rebuilding it. Glasses gives coding agents a searchable catalogue of whole products, packages, memory tools, skills, agent profiles and UI components, with source evidence and a shared editable workbench when a visual trial helps.

[Browse the public catalogue](https://lcfr.ai/glasses). The catalogue is a versioned public snapshot; research and private project work run on your own machine.

## Run locally

Requires Node.js 24 or later and npm. The local interface binds to `127.0.0.1:4317`.

This README describes source release **0.3.1**. The setup command requires this version's `scripts/setup.mjs`; a public checkout still on 0.3.0 needs the manual commands below. There is no published `npx` installer.

**Upgrading from 0.3.0:** update the client before importing a new snapshot with expanded adoption routes. The older validator does not recognize values such as `install-app`, `run-cli` and `use-hosted` and will reject those snapshots. Keep your existing `.glasses` data directory when replacing source files, then run `npm ci` and `npm run build`. Local notes, workspaces and human corrections remain separate from shared metadata.

```sh
git clone https://github.com/lcfrai/glasses.git
cd glasses
node scripts/setup.mjs
npm start
```

For the downloaded 0.3.1 source package, extract it and run the final two commands in its folder. Setup installs this repository's locked dependencies if they are missing, builds the local interface and asks **“Fetch latest catalogue now? [y/N]”**. Yes fetches `https://lcfr.ai/glasses/catalogue.json`; No saves your choice and leaves Glasses usable. A noninteractive terminal without an explicit flag leaves the choice pending and makes no catalogue request. Setup does not start a server or register an agent automatically.

Open <http://127.0.0.1:4317>. If setup has not recorded a choice, the local app offers the same Yes/No choice. No shared catalogue is fetched until you approve it. Use **Shared catalogue** in the app to import later or retry, or run:

```sh
npm run catalogue:fetch
npm run catalogue:status
```

Each fetch command is an explicit one-time import; consent does not enable automatic shared updates. The download is bounded to 32 MiB and 30 seconds and must pass strict schema, citation, identity and content-hash checks before import. A failed request preserves existing data and remains visible for an explicit retry. Repeating an import preserves local sources, notes, workspaces and corrections and merges newer shared metadata. Imported shared observations remain separate from local verification.

For scripted setup, `node scripts/setup.mjs --catalogue=import` or `--catalogue=decline` records an explicit choice. `--data-dir DIRECTORY` uses an isolated data directory. To use that same custom directory when starting the server, set `GLASSES_DATA_DIR`; without it the app uses `.glasses` beside this checkout.

Manual build/start works with both 0.3.0 and 0.3.1:

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

Search accepts a `resourceType` such as `tool`, `component`, `skill` or `agent`. Inspect a collection and pass its `parentId` to search its individual members. Cards expose source-backed features, use cases, keywords and dependencies where documented. Selected visual entries have dated source-demo captures; uncaptured entries link to upstream documentation.

Skills and agent profiles have pinned source links and reviewed download bundles with original files, hashes and licence notices. The local `glasses_inspect` can retrieve a pinned guidance document and verify its published hash. These files remain untrusted source data: Glasses never installs or activates their instructions automatically, and distribution does not establish compatibility with your agent.

## Research and model connections

Add a source from the catalogue, or create and amend a research plan in Research. GitHub discovery prioritizes popular results within a relevant query, with paging and archived/fork exclusions by default. Stars indicate popularity, not security, compatibility or suitability.

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

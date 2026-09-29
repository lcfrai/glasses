# Glasses

Find existing software before rebuilding it. Glasses gives coding agents a searchable catalogue of whole products, packages, memory tools, MCP servers, implementation patterns and UI components, with source evidence and a shared editable workbench when a visual trial helps.

[Browse the public catalogue](https://lcfr.ai/glasses). The catalogue is a versioned public snapshot; research and private project work run on your own machine.

## Run locally

Requires Node.js 24 or later and npm. The local interface binds to `127.0.0.1:4317`.

```sh
git clone https://github.com/lcfrai/glasses.git
cd glasses
npm ci
npm run catalogue:import
npm run build
npm start
```

Open <http://127.0.0.1:4317>. The included catalogue imports without network requests or model calls. Repeating the import preserves local records and merges newer shared metadata. To update, download a fresh `catalogue.json` from the public site and run:

```sh
node scripts/export-public-catalogue.mjs --import path/to/catalogue.json --data-dir .glasses
```

Shared classifications are attributed publisher observations, not your local model cache. Import does not run classification, fetch source code or grant a licence. Inspect the current upstream source when choosing a candidate.

## Connect an agent

Keep the local server running. For an MCP client, run `npm run mcp:config` to print the exact executable and source paths for this checkout. Merge the `glasses_local` entry into your client's configuration without replacing other servers. An installed Codex client can also use `npm run mcp:install` to register Glasses at user scope; this is explicit and never runs during dependency installation. Reload the client's MCP servers or reopen the client as supported by that client.

Suggested instruction:

> Consult Glasses when assessing ideas, selecting existing implementations and refining interfaces. Consider complete solutions first. Inspect source evidence, licence scope and recorded outcomes before reuse. Use the shared workbench when a visual trial is useful.

Tools cover compact search, source inspection, public import and research, adoption briefs, evidence, classification and ranking, outcomes, and shared workspace editing/export. The calling agent decides what to adopt. No result means catalogue coverage is incomplete.

## Research and model connections

Add a source from the catalogue, or create and amend a research plan in Research. GitHub discovery prioritizes popular results within a relevant query, with paging and archived/fork exclusions by default. Stars indicate popularity, not security, compatibility or suitability.

Public connector fetches and catalogue import require no LLM calls. Optional classification and ranking use TypeSafe Jev with your own API key, entered in Connections, or a restricted installed Codex worker. Jev uses its own API billing; Codex uses the signed-in client's allowance. Inspect the saved limits and enable automatic work deliberately. Usage and partial failures remain visible. Classification is imperfect and may need review.

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

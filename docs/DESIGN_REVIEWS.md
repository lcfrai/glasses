# Design Reviews

Design Reviews connects a user's visual choice to the agent implementing it. It is a local brief, a set of source-labelled alternatives, and a versioned decision—not a generic rendering service.

When a visual request leaves the direction open, use this sequence:

1. Search Glasses for suitable existing work. Inspect the strongest candidates, exact source and licence evidence. If the catalogue is insufficient, use bounded external discovery; do not treat an empty result as proof that nothing exists.
2. Build a small set of meaningfully different, working swatches or variants. Show them behind representative content, not only in empty decorative boxes. Verify interaction, responsive behavior and reduced motion. Keep real retrieved source distinct from original composition and record adaptations.
3. Create a review with 2–12 options, the brief, source references, declared settings and actual preview/workspace links. Show the returned review URL to the user. Complete the comparison before asking for a choice.
4. The user tries the variants, edits settings/notes and explicitly chooses in the gallery or native Reviews page. Opening a preview or selecting a draft option is not a decision. Do not automate Choose, submit a decision on the user's behalf, or treat silence as a choice.
5. Read the decision through `glasses_get_design_review`. Implement the selected option and settings while preserving source lineage. If the board is still open, keep the choice pending and continue independent research or verification; do not commit to an arbitrary visual direction.

An already specific brief or prior explicit selection does not require an unnecessary new comparison. A review choice records design intent. It does not establish licence/security approval, authorise a deployment, or prove that a whole product should be installed.

## Local connection and UI

Keep the local Glasses service running with Node.js 24+ and the checkout's locked dependencies. From the checkout, the existing commands are:

```sh
npm ci
npm run build
npm start
```

In a second terminal, `npm run mcp:install` registers the local Codex connection as `glasses_local`, preserving other entries. `npm run mcp:config` prints configuration for other clients. These commands configure the local catalogue product; they do not install or invoke the separate Visual Foundry plugin. Reload the client's MCP connection if it has not loaded the new tool inventory.

The native page is [Reviews](http://127.0.0.1:4317/#reviews); a board deep link is `http://127.0.0.1:4317/#reviews/<review-id>` at the default port. Catalogue remains the primary page. Reviews lists open and decided boards, shows the saved brief and source references, opens supplied previews separately, and links local workspaces when available.

The decision form supports the option's declared string, number, boolean and null settings. Selecting **Review this option** only prepares a draft. **Choose [option]** saves it. The recorded choice, settings, notes and earlier decision history are then visible. **Clear recorded choice** explicitly reopens the board. A stale version shows a conflict and retains draft notes until the user selects **Reload latest review**; it never overwrites newer work automatically.

## Local MCP tools

| Tool | Purpose |
|---|---|
| `glasses_create_design_review` | Save `{title, brief, options}`. Returns `{review, reviewUrl}` with an open board and no choice. |
| `glasses_list_design_reviews` | List compact board summaries: identity, title, status, version, option count and current decision summary. |
| `glasses_get_design_review` | Read `{id}` to obtain the full current board, chosen settings/notes, source snapshot and history. |
| `glasses_update_design_review` | Amend `{id, expectedVersion, title?, brief?, options?}`. Send a whole new options array when revising alternatives. |

There is deliberately **no MCP decision-submission tool**. These four tools create, revise and read the comparison; the human-facing UI submits choices. The local API uses the existing loopback session token, not an identity system that cryptographically distinguishes a person from every local agent.

An argument illustration using real outputs from earlier workspace/evidence calls:

```js
glasses_create_design_review({
  title: "Homepage background direction",
  brief: "Compare legibility behind the existing headline and CTA, in both themes. Preserve keyboard access and a static reduced-motion state.",
  options: [
    {
      id: "grid",
      label: "Interactive grid",
      previewUrl: gridStudy.workbenchUrl,
      workspaceId: gridStudy.id,
      capabilityIds: [gridCandidate.id],
      sourceRefs: [{url: gridEvidence.url, sha256: gridEvidence.sha256, label: "Retained source response"}],
      parameters: {intensity: 0.7, scale: 1, active: true}
    },
    {
      id: "ripple",
      label: "Concentric ripple",
      previewUrl: rippleStudy.workbenchUrl,
      workspaceId: rippleStudy.id,
      capabilityIds: [rippleCandidate.id],
      sourceRefs: [{url: rippleEvidence.url, sha256: rippleEvidence.sha256, label: "Retained source response"}],
      parameters: {intensity: 0.5, scale: 1, active: true}
    }
  ]
})
```

The variables above stand for actual returned objects, not literal tool arguments or invented preview URLs. The agent must first prepare and verify those previews. After the user chooses, read `{id: created.review.id}` with `glasses_get_design_review`; use `review.decision.optionId`, `parameters`, `notes`, `optionSnapshot` and `briefSnapshot`. Do not assume the first option, the last preview opened, or the current draft is the recorded choice.

## Version and evidence contract

Boards persist with `id`, `title`, `brief`, `options`, `version`, `contentHash`, `status`, `decision`, `decisionHistory`, `createdAt` and `updatedAt`. `status` is `open` or `decided`; an open board has `decision: null`.

Each option has a stable `id`, `label`, optional description/preview URL/workspace ID/candidate IDs, `sourceRefs`, and flat primitive parameter defaults. A source reference records its URL, optional label and optional SHA-256. It is metadata: attaching it does not fetch, validate, license or execute the remote content. Attach the hash of the exact response/body identified by that URL, and keep fuller source/adaptation evidence separately.

A decision preserves the chosen option and brief snapshots, parameter values, notes, decision time, reviewed version and content hash. The board's version increments after a saved decision. Previous decisions are preserved as `replaced`, `cleared` or `invalidated` history entries containing the old decision. A title-only edit preserves the current choice; changed brief/options invalidate it and reopen review. Replacing artwork behind an unchanged external URL is not detectable by this metadata store: record changed source hashes/options and request a fresh decision rather than silently reusing the old approval.

Updates and decisions require `expectedVersion`. HTTP 409 means reload current state and resolve the changed context; do not blindly resubmit. Current bounds include 2–12 alternatives, a 200-character title, an 8,000-character brief, a 64 KB board-content limit, up to 24 parameter keys within 4 KB, strings up to 500 characters, finite numbers between ±1e9, and decision notes up to 4,000 characters. Decision values must use declared keys and matching types. History is bounded to 1,000 entries without silently pruning older decisions.

The native client's API routes are GET/POST `/api/design-reviews`, GET/PUT `/api/design-reviews/:id`, and POST `/api/design-reviews/:id/decision`. The decision body is `{expectedVersion, optionId, parameters?, notes?}`; explicit `optionId: null` clears. The create/update endpoints reject forged decision/status fields. These routes are local app capabilities, not additional public hosted MCP tools.

## Preview and publication limits

A board does not automatically generate variants, compile arbitrary source, render every option inline, or apply changed parameters to an external preview. Supply a verified Glasses workspace or a working preview URL. A custom gallery may connect its controls to the same declared settings, but that integration is separate from generic review storage. The native UI records those settings and links the preview; it does not rewrite or remotely control it.

Local workspace and loopback preview URLs are available only where their server is reachable and running. Saving a link does not publish a preview or make it available on another person's computer. Preview URLs are HTTP(S) metadata and open separately; remote pages are not embedded or executed by this workflow. Review records remain local and are not added to the strict shared public catalogue export.

The public hosted endpoint remains the same four read-only tools: `glasses_search`, `glasses_inspect`, `glasses_evidence` and `glasses_status`. It has no review boards, choice submission, workspaces, local source bodies or private research. Use `glasses_local` for this workflow.

## Verification

From a built checkout, `node --test tests/design-reviews.test.mjs` exercises board validation, persistence, source/decision snapshots, concurrency and MCP boundaries. `node tests/design-reviews-e2e.mjs` uses an isolated local database and actual browser UI for draft-versus-choice, readback, version conflict, history, retry and narrow-screen checks. It creates only synthetic review decisions. The broader `npm test` also includes the core tests.

Retain new evidence for each run rather than overwriting prior reports. In the development checkout, the dated baseline is `evidence/site-background-gallery-2026-09-29/`: native UI 12/12, independent browser→API→official MCP 7/7, and source-derived background adapters 9/9. These receipts establish the tested implementation; no user background selection or deployment is implied.

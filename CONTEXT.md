# Harness Browser Workspace

This context defines the product language for extending DeepSeek Harness with trusted browser, Office, and knowledge capabilities without recreating AccrUI as a second application.

## Language

**Harness Workspace**:
The DeepSeek Harness user experience that serves as the product's single agent workspace.
_Avoid_: AccrUI clone, extension UI

**Browser Target**:
The specific browser window, tab, and page context assigned to a Harness Run.
_Avoid_: Active tab, current browser

**Work Tab Roster**:
The checked tabs for this Run, listed by `list_work_tabs`. It is a live tab list (title, URL, editor kind, primary write target), not page bodies.
_Avoid_: Office context, current page dump

**Browser Connector**:
The trusted capability boundary through which a Harness Run reads from and acts on its Browser Target.
_Avoid_: iframe bridge, browser automation backend

**Office Connector**:
The browser capability set for reading, modifying, and verifying supported online documents and spreadsheets.
_Avoid_: WPS script runner, Office iframe hack

**Knowledge Connector**:
The capability set for querying authorized enterprise knowledge and code sources, associating page evidence with repositories, and delivering online documents.
_Avoid_: AccrUI Agent Backend, RAG UI

**Verified Write**:
A mutation that is successful only after the target reports business success and the resulting state is read back from the same target.
_Avoid_: HTTP success, request accepted

**Approval Grant**:
A one-time authorization for a specific mutation against an unchanged Browser Target and resource identity.
_Avoid_: Permission mode, blanket approval

**Connector Credential**:
A secret retained by a Connector and never exposed to the Harness Workspace or model context.
_Avoid_: Harness credential, browser Cookie parameter

**Migration Slice**:
An independently testable end-to-end capability moved from AccrUI into a Connector and verified against a real Browser Target.
_Avoid_: Module port, migration phase

**Parity Gate**:
The real-browser evidence required before a migrated capability can replace its AccrUI counterpart.
_Avoid_: Unit tests passed, build passed

**Resource Identity**:
The stable service-issued identifier for a knowledge domain, repository, parent directory, document, or spreadsheet target; display names are never authoritative.
_Avoid_: Resource name, current page label

**Sourced Answer**:
A knowledge or code answer accompanied by its source identities, repository, matching basis, and truncation status.
_Avoid_: Search response, generated answer

**Partial Delivery**:
A multi-item write outcome that preserves confirmed successes, reports failures separately, and can resume only the unfinished items using the same idempotency identity.
_Avoid_: Failed delivery, rolled-back batch

**Connector Tool**:
A stable, model-facing operation that acts through a Connector and returns a typed result tied to a Browser Target or Resource Identity.
_Avoid_: AccrUI tool, injected script

**Connector Job**:
A cancellable, observable long-running Connector operation whose result remains tied to its initiating Run and Resource Identities.
_Avoid_: Background request, pending tool call

**Bounded Result**:
A Connector result whose model-visible content is intentionally limited, with larger data exposed through controlled pagination or an opaque result handle.
_Avoid_: Full response, truncated answer

**Write Fence**:
The per-resource serialization and version check that prevents concurrent Runs from mutating stale or changed state.
_Avoid_: Write lock, active tab check

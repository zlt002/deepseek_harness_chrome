---
status: accepted
---

# Deliver spreadsheet and presentation Browser Target tools as one verified-write slice

## Context

ADR-0005 narrowed the first Connector milestone and explicitly removed spreadsheet
mutation tools. The current migration has a bounded spreadsheet adapter and a
presentation adapter behind the same fixed Browser Target boundary. Keeping the
old removal decision would leave spreadsheet parity impossible and would make the
spreadsheet and presentation adapters follow different write-safety contracts.

The two capabilities are therefore one Migration Slice for delivery and review:
the slice includes spreadsheet reads and writes, and presentation reads and
writes. A successful build or an MCP response is not a Verified Write. A write is
successful only after the bound target reports business success and the resulting
state is read back structurally from that same target.

## Decision

### One delivery, two capability families

The Connector publishes both families together for a bound Browser Target:

- Spreadsheet tools read context, bounded ranges, and bounded searches. All
  spreadsheet mutations are exposed through `spreadsheet_write_preview` and
  `spreadsheet_write_commit`. The catalog covers every semantic capability in
  the former 107-tool AccrUI spreadsheet profile; related operations may share
  one deep model-facing tool, but none is deferred to a later delivery phase.
- Presentation tools read presentation context, selection, and text boxes. The
  complete named online-presentation adapter surface is exposed through
  `presentation_write_preview` and `presentation_write_commit`, including slide,
  scene, object, table, chart, note, comment, metadata, structure, text-box, and
  save operations. None is deferred to a later delivery phase.

The operation catalog is owned by the Connector and runtime adapters. A listed
operation is not a promise that every WebEdit runtime implements it; the
unsupported rule below applies to every operation. Generic scripts and
model-selected tabs, frames, URLs, or resource identities are not alternate
entry points. Existing light-document Verified Write behavior remains governed
by ADR-0004 and ADR-0006.

Completeness is measured at the semantic-operation boundary rather than by MCP
tool count. Spreadsheet context/range/search/inspection capabilities are folded
into a small read surface, while all mutations are named operations on one
preview tool and one challenge-only commit tool. Presentation capabilities use
the same pattern. Publishing an operation name without a reachable runtime
dispatch, operation-specific preview, and operation-specific readback does not
satisfy this decision.

### Preview before every write

Every spreadsheet or presentation mutation follows this sequence:

1. The Connector resolves the fixed primary Browser Target and reads the current
   resource. The model does not provide a target or choose another tab.
2. The preview operation validates the named operation and exact payload, checks
   the runtime capability, and captures the Connector-resolved `Resource
   Identity` together with the current target generation and write precondition
   (for example, a resource fingerprint or version). Preview is read-only and
   must not invoke a mutation API.
3. The Connector returns a one-time `Approval Grant` challenge tied to that
   immutable preview snapshot. User approval is required before commit.
4. The commit operation accepts only that challenge. It does not accept a second
   operation, payload, target, resource identity, or precondition from the model;
   the Connector retrieves all of them from the preview snapshot.
5. Before mutation, the Connector consumes the challenge once, revalidates the
   Run, Browser Target, `Resource Identity`, target generation, and precondition,
   and enters the per-resource `Write Fence`. A replay, expiry, target change,
   resource drift, or precondition mismatch fails before the mutation API is
   called.

`Resource Identity` is authoritative for the service resource and editor
context; display names are descriptive only. The write precondition is retained
separately so that a matching name cannot authorize a stale write.

### Same-target structured readback is part of success

After the runtime reports business success, the Connector performs a structured
readback through the same Browser Target and same resource. It validates the
operation-specific observed state and the returned resource identity. At a
minimum:

- spreadsheet results include the requested operation/resource and structured
  observed range or operation state with `verified: true`;
- presentation results include the requested operation/resource and structured
  observed presentation context (such as slide/object state) with `verified:
  true`.

Only a result that passes this same-target validation is returned as
`status: verified_write`. Missing readback, a different target/resource,
unverifiable structure, or a readback mismatch is a failed write and must retain
the concrete error. The Write Fence is released on both success and failure.

### Unsupported operations fail closed

If the bound WebEdit iframe is unavailable, the runtime is not ready, a named
public API is absent, the operation is not advertised, or the required
precondition is unavailable, the Connector returns the specific unsupported or
precondition error and does not mutate. It must not fabricate a capability,
silently downgrade to a generic script, open another tab, retry through a
different write tool, or report request acceptance as success. Fingerprint and
target drift are likewise explicit failures; they require a fresh preview and
approval rather than an automatic retry.

This rule is a per-target runtime guard, not a phased-delivery escape hatch. The
implementation must not mark a whole catalog family unsupported merely because
its readback is harder. Structural spreadsheet edits, formatting, comments,
images, transfer operations, charts, pivots, and presentation object operations
all require real dispatch plus their own bounded precondition and readback. A
specific call may still return `unsupported` when the currently bound WebEdit
runtime genuinely lacks the required public API; the error must identify that
missing capability and must occur before mutation whenever the absence is
discoverable.

## Supersession and compatibility

This ADR supersedes only the following sentence in the first paragraph of
ADR-0005:

> Spreadsheet mutation tools, `browser_open_tab`, and `team_doc_create` are
> removed.

The spreadsheet-mutation clause is replaced by the two-family preview/commit
surface defined here. `browser_open_tab` and `team_doc_create` remain removed.
ADR-0005's generic tool-card choice, synchronous-versus-Connector-Job rule, and
other exclusions remain in force unless this ADR explicitly defines a bounded
spreadsheet or presentation capability. In particular, this decision does not
claim Windows parity; that remains separate acceptance work.

## Verification and Parity Gate

The implementation is not accepted on static tests, a build, or an HTTP/MCP
success response alone. Contract and runtime tests must cover both families:

- preview is read-only and binds the exact payload, `Resource Identity`, target,
  and precondition;
- commit accepts only a valid one-time challenge, rejects tampering and replay,
  and enforces the Write Fence;
- target/resource/precondition drift fails before mutation;
- success requires same-target structured readback, while missing or mismatched
  readback fails closed; and
- absent or unadvertised APIs return `unsupported` without invoking a fallback.

The Parity Gate then requires real macOS Edge evidence for both spreadsheet and
presentation Browser Target tools: read, preview-without-mutation, explicit
approval, challenge-only commit, and same-target structured readback, plus
negative cases for drift, replay, unsupported APIs, and target isolation. This
ADR records the required boundary; it does not claim that real Edge acceptance
has passed.

## Consequences

Spreadsheet and presentation writes now share the existing Connector safety
model, making the former spreadsheet-removal decision obsolete without opening a
generic mutation channel. The cost is an extra inspect/approval/readback round
trip and operation-specific adapters: genuinely absent or ambiguous editor APIs
stop with an actionable error instead of being approximated.

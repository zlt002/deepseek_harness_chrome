# DeepSeek Harness upstream contributions

These patches contain only generic Harness extension seams. Product behavior
stays in `packages/`; `upstream/deepseek-harness` remains a clean submodule.
The materializer always applies these patches to a disposable clone; there is
no full-source product overlay mode.

`0001-conversation-composer-above-slot.patch` adds one session-scoped list slot
immediately above the composer card. Floating panels continue to use the
existing `conversation.input.overlay` slot, so no product-specific overlay or
DOM selector enters upstream.

`0002` adds a generic Skill invocation-policy seam, while `0002b` carries its
model-loader and explicit `/name` boundary regressions. `0003` extends the
Skill catalog wire and lets any settings owner explicitly opt its namespace
into configuration-client transports with `configurationExposed`; it contains
no product namespace or product UI.

`0004` keeps that optional settings surface optional inside the ApiProxy plugin
fiber, and adds a runtime-context regression test for describe and mutate.

`0005` invalidates the browser Skill catalog when an exposed settings document
changes, without naming or depending on the AccrUI settings owner.

`0014` exposes the existing pi-ai model `input` field as a per-row checkbox on
the Models settings card. Checking it writes `input: [text, image]`; clearing
it omits `input` so the adapter keeps its catalog-then-text fallback.

`0015` lets an optional `composerFileIntake` service accept the non-image
remainder of composer paste or drop. The official image rail still admits only
PNG, JPEG, WebP, and GIF; without the service a non-image keeps the existing
unsupported-type notice.

`0016` keeps the composer-above strip mounted when a composer-chain takeover
replaces the input card, and lets the generic question card collapse to its
title row.

`0017` provides an ordered composer-submission transform registry. Each
registered transform can enrich the prompt and receives its acknowledgement
only after the host accepts that exact transformed prompt.

`0018` gives finalized assistant message bodies a stable, display-neutral DOM
identity marker so any client plugin can associate a text Range with exactly
one durable assistant message without scanning transcript text.

`0019` exposes a reactive, product-neutral permission-label registry. A
registrant may supply labels for known preset values; unrecognized values keep
the official display formatting.

`0020` shortens the settings document action label to “Configuration file” /
“配置文件” and gives the action a shrinkable ellipsis width so narrow settings
surfaces preserve the navigation icons first.

Verify against the pinned upstream commit:

```sh
git -C upstream/deepseek-harness apply --check \
  ../../upstream-contributions/0001-conversation-composer-above-slot.patch
```

Materialize and build the disposable product tree without changing the
submodule:

```sh
pnpm materialize:harness-product
pnpm build:harness-product
```

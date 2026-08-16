# DeepSeek Harness upstream contributions

These patches contain only generic Harness extension seams. Product behavior
stays in `packages/`; `upstream/deepseek-harness` remains a clean submodule.

`0001-conversation-composer-above-slot.patch` adds one session-scoped list slot
immediately above the composer card. Floating panels continue to use the
existing `conversation.input.overlay` slot, so no product-specific overlay or
DOM selector enters upstream.

`0002` adds a generic Skill invocation-policy seam. `0003` extends the Skill
catalog wire and lets any settings owner explicitly opt its namespace into
configuration-client transports with `configurationExposed`; it contains no
product namespace or product UI.

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

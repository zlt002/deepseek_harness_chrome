# Harness UI Knowledge Scope

AccrUI-owned out-of-tree client plugin for choosing enterprise knowledge
systems and remote code repositories. The extension parent owns scope state;
this plugin only renders a snapshot and sends nonce-bound commands.

Selected source names are preserved in the trigger text. CSS clips the text on
narrow layouts, while `title` and the accessible name retain the full list.

## Required generic upstream seam

Clean upstream must provide one **public** slot before loading this plugin:

1. In `packages/client/ui-conversation/src/client/contract/slots.ts`, declare
   `conversation.composer.above` as a session-scoped list owned by `InputZone`.
   In `packages/client/ui-conversation/src/client/apply.ts`, register that
   slot. In `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`,
   render it as the composer card's preceding sibling.

The clean upstream already owns and renders the card-wide
`conversation.input.overlay` list. The picker uses that existing slot; no new
overlay primitive, DOM query, or component replacement is required.

Until that seam lands, do not load this package in clean upstream. No DOM
selector, component override, or internal `src` import is an acceptable
substitute.

## Runtime contract

React and public `@deepseek-ai/dsh-client-*` modules are supplied by the
Harness runtime. They are intentionally absent from this repository's npm
dependencies so pnpm never tries to fetch unpublished Harness packages.

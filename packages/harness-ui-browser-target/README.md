# Harness UI Browser Target

An AccrUI-owned, out-of-tree Harness web client plugin. It projects the
extension-owned Browser Target into the public composer slots:

- `conversation.input.left` for the compact target button
- `conversation.input.overlay` for the target picker
- `sidebar.footer.action` for the nonce-bound Harness reconnect action

The parent extension remains the authority for tab state and policy. The
plugin accepts only nonce, origin, and monotonically sequenced messages.

## Runtime contract

The Harness runtime that loads this package supplies React plus the public
`@deepseek-ai/dsh-client-*` modules. They are deliberately not npm
dependencies of this extension repository: the extension package must not try
to install unpublished Harness workspace packages from the public registry.

The reconnect action reuses the official footer seat. This keeps the feature
available without copying the former compact-sidebar layout or adding another
upstream seam.

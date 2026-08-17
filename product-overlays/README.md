# Harness latest-source product overlay

This overlay restores the accepted Harness UI and interaction behavior from the
latest independent Harness source commit, while `upstream/deepseek-harness`
remains a clean, upgradeable submodule.

The numbered Base64 parts concatenate to one gzip-compressed Git patch. The
decoded patch is the full source difference from official revision `47f943859b`
to independent Harness revision `e32789808ce5e354cea13991e05d7a5bad7385a3`.
It is applied before any generic seams, because that latest source already
contains its corresponding UI, subagent, scope, settings, and runtime changes.
The generic patches remain in `upstream-contributions/` for a separate rebase;
they are deliberately not silently mixed with this source snapshot.

Current decoded patch SHA-256:

`9e879ae9676e77a88226316ee8ec709bb25a38ce79d1cf65f73956e67f6c5b37`

Do not remove a legacy UI behavior until its out-of-tree replacement has passed
side-by-side browser acceptance. The overlay is applied only to the disposable
`.generated/harness-product` tree; it never modifies the official submodule.
While this snapshot remains active, materialization uses the overlay lockfile
and runs `pnpm install --no-frozen-lockfile` before building.

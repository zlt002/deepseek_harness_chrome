---
status: accepted
---

# Bound sensitive data and fence concurrent writes

Connectors never expose browser Cookies to Harness and keep diagnostic logs to resource identities, operation metadata, and outcomes. Model-visible document and knowledge content is returned as a Bounded Result; larger data is paged or referenced through a controlled handle. Reads may run concurrently, but writes against the same Resource Identity pass through a Write Fence that serializes execution and revalidates the target version or fingerprint immediately before mutation.

Migrated adapters become Connector-owned code with source provenance and behavior tests. They do not automatically mirror subsequent AccrUI changes; later fixes are evaluated and ported deliberately.

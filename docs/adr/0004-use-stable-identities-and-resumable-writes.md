---
status: accepted
---

# Use stable resource identities and resumable verified writes

Connector configuration stores service-issued Resource Identities discovered under the signed-in user's authorization; display names only guide selection. Initial mutations run exclusively against dedicated test resources. Multi-item writes do not automatically delete confirmed successes: they return a Partial Delivery and resume unfinished items with the original idempotency identity. Knowledge and code queries must produce Sourced Answers, while document and spreadsheet mutations must produce Verified Writes.

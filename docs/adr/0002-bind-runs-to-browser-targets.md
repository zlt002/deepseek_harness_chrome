---
status: accepted
---

# Bind each Run to an explicit browser target

Every Harness Run that uses browser capabilities binds to a specific window, tab, page, and relevant document identity instead of repeatedly guessing the active tab. Reads use the browser's existing login state or Connector-managed credentials without exposing Cookies to Harness. Mutations require a one-time Approval Grant in Harness, followed by extension-side target revalidation before execution and a read-back from the same target.

The extension persists a next-tool-turn target policy: follow the active tab, use user-selected pinned tabs with a primary tab, or intentionally bind no Browser Target. Tab activation and creation update only the candidate; they never mutate an in-flight Connector request. At the start of the next browser Connector request, follow mode resolves that candidate and, when it differs, performs an explicit Run-id-bearing transfer confirmed by the Native Host and Connector before reading the page. The selected target remains fixed until that request completes.

Saving this policy never interrupts an in-flight Connector request and does not require reconnecting. Pinned mode exposes every still-valid checked tab in `office_get_context`, marks the selected primary tab, and reports checked tabs that closed or changed without blocking the remaining tabs. Legacy singular `browserTarget` and `officeContext` fields continue to represent that primary tab. The primary remains the default and the only future write target; the model cannot nominate a tab. None mode rejects the next browser tool call. An agent may open an HTTP(S) tab through the `browser_open_tab` Connector Tool. That request is correlated to the Run and its explicit Native transfer, rather than inferred from the resulting tab events.

/**
 * System-prompt section that survives agent-preset persona replacement.
 *
 * This file intentionally imports no Harness package. The generated patch
 * loads it by absolute path, so a packaged Native Host can use the Harness
 * `systemPrompt` service without depending on its launch directory or on
 * sibling source-tree module resolution.
 */

export const name = 'selected-source-routing-prompt'

export const inject = ['systemPrompt']

const ROUTING_RULES = `When a user has enabled and selected enterprise sources, identify source-relevant questions by their subject, not by whether the user writes “remote”, “knowledge base”, or “code search”. Proactively treat an ordinary question about a selected system, its implementation, or its business material as a request about those selected sources.

Use search_selected_remote_code first for questions about implementation, classes, APIs, configuration, errors, business flows, modules, repositories, or “how this system works”. Use search_selected_knowledge first for questions about business rules, product/process documentation, policies, FAQs, or other non-code enterprise material. Prefer the selected remote source whenever either interpretation is plausible; ask a short clarification only when it is genuinely unclear whether the user means the selected enterprise source or the current local workspace.

Do not search selected enterprise sources for casual conversation, writing/translation, or an explicit request to inspect, edit, build, test, or run the current local workspace. Treat the selected remote range as authoritative; never substitute the local workspace, Bash, grep, or Git for it. Give the selected-source tool one focused, bounded question. If that search reports no selected or enabled range, report that limitation instead of falling back to local files, shell, or git.`

/** Register deployment-wide routing that Code preset personas cannot shadow. */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'deployment:selected-source-routing',
    order: 115,
    text: ROUTING_RULES,
  })
}

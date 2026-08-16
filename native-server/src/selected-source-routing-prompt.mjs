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

const ROUTING_RULES = 'For enterprise remote-code requests, call search_selected_remote_code first. For enterprise knowledge requests, call search_selected_knowledge first. Treat the selected remote range as authoritative; never substitute the local workspace, Bash, grep, or Git for it. Give the selected-source tool one focused, bounded question. If that search reports no selected or enabled range, report that limitation instead of falling back to local files, shell, or git.'

/** Register deployment-wide routing that Code preset personas cannot shadow. */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'deployment:selected-source-routing',
    order: 115,
    text: ROUTING_RULES,
  })
}

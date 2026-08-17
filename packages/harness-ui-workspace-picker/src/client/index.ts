import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { CompactWorkspacePicker } from './CompactWorkspacePicker.tsx'

export const inject = ['slots']

/** Fill the workspace owner's compact seat without taking over directory adoption. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.workspaces.compact', () => ctx.slots.register({
    name: 'sidebar.workspaces.compact',
    id: 'accrui-workspace-picker',
    order: 0,
    select: owner => owner,
  }, CompactWorkspacePicker))
}

export { CompactWorkspacePicker } from './CompactWorkspacePicker.tsx'

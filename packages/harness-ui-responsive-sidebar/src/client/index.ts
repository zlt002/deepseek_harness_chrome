import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ResponsiveSidebarPresentation } from './ResponsiveSidebarPresentation.tsx'

export const inject = ['slots']

/** Fill the official responsive seam; session and workspace state stay with ui-sidebar. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.compact.presentation', () => ctx.slots.register({
    name: 'sidebar.compact.presentation',
    id: 'accrui-responsive-sidebar',
    order: 0,
    select: owner => owner,
  }, ResponsiveSidebarPresentation))
}

export { ResponsiveSidebarPresentation } from './ResponsiveSidebarPresentation.tsx'

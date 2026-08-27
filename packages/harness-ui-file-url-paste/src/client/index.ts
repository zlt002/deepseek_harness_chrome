import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { decodePastedFileUrls } from './file-url-paste.js'

export const inject = ['composerPasteTextTransforms']

/** Makes browser-copied local-file URLs readable before they enter a draft. */
export function apply(ctx: ClientContext): void {
  const transforms = ctx.get('composerPasteTextTransforms')!
  ctx.effect(() => transforms.register({
    id: 'accrui-file-url-paste',
    transform: decodePastedFileUrls,
  }), 'accrui-file-url-paste: decode file URLs')
}

export { decodePastedFileUrls } from './file-url-paste.js'

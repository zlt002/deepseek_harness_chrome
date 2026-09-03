import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Conversation shell is a product presentation plugin, not a second conversation controller', async () => {
  const [manifest, hostSource, source, presentation, css, fullscreenControl, fullscreenStore, fullscreenCss, visibilityRow, visibilityStore, settings, overlayHostSeam, permissionLabelSeam, modelOptionSeam, multimodalToggle] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ConversationPresentation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ConversationPresentation.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ComposerFullscreenControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/composer-fullscreen.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ComposerFullscreenControl.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ProcessVisibilitySettingsRow.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/process-visibility.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/presentation-settings.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../upstream-contributions/0013-composer-overlay-host-marker.patch', import.meta.url), 'utf8'),
    readFile(new URL('../../../upstream-contributions/0019-permission-label-registry.patch', import.meta.url), 'utf8'),
    readFile(new URL('../../../upstream-contributions/0025-model-selection-option-trailing-slot.patch', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/CompanyGatewayMultimodalToggle.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-conversation-shell/)
  assert.match(manifest, /@deepseek-ai\/dsh-client-ui-model-selection/)
  assert.match(source, /'permissionLabels'/)
  assert.match(source, /permissionLabels\.register\(permissionLabel\)/)
  assert.match(source, /Chinese permission labels/)
  assert.match(permissionLabelSeam, /permissionLabels\?: PermissionLabelRegistry/)
  assert.match(permissionLabelSeam, /labels\?: PermissionLabelRegistry/)
  assert.match(permissionLabelSeam, /labels = OFFICIAL_PERMISSION_LABELS/)
  // Cordis only exposes a property when it was declared in `inject`. The
  // adapter registers a presentation slot before reading its own services.
  assert.match(source, /export const inject = \['slots', 'connection', 'remote', 'settingsScope', 'settingsQuickActions', 'conversationViewState', 'modelDirectories', 'sessions', 'permissionLabels'\]/)
  assert.match(hostSource, /CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE as SettingsNamespace/)
  assert.match(hostSource, /settingsCtx\.settings\.register\(/)
  assert.match(hostSource, /z\.object\(\{ showProcess: z\.boolean\(\)\.default\(true\) \}\)/)
  assert.match(hostSource, /configurationExposed: true/)
  assert.match(settings, /CONVERSATION_PRESENTATION_SETTINGS_NAMESPACE = 'accrui-conversation-presentation'/)
  assert.match(settings, /showProcess: true/)
  assert.match(source, /ctx\.settingsScope\.bind<ConversationPresentationSettings>/)
  assert.match(source, /name: 'settings\.general\.item'/)
  assert.match(source, /id: 'process-visibility'/)
  assert.match(visibilityRow, /显示会话过程/)
  assert.match(visibilityRow, /type="checkbox"/)
  assert.match(visibilityRow, /\{ useShowProcess, setShowProcess \}/)
  assert.match(visibilityRow, /useShowProcess\(state => state\)/)
  assert.doesNotMatch(visibilityRow, /hooks\.showProcess/)
  assert.match(visibilityStore, /void this\.settings\.set\(SHOW_PROCESS_FIELD, showProcess\)/)
  assert.match(visibilityStore, /createSnapshotStore\(DEFAULT_CONVERSATION_PRESENTATION_SETTINGS\.showProcess\)/)
  assert.match(source, /ctx\.slots\.inject\('conversation\.presentation'/)
  assert.match(source, /ctx\.slots\.inject\('conversation\.input\.right'/)
  assert.match(source, /id: 'composer-fullscreen-control'/)
  assert.match(source, /hooks: \{ composerFullscreen: composerFullscreen\.active \}/)
  assert.match(source, /toggleComposerFullscreen: \(\) => \{ composerFullscreen\.toggle\(\) \}/)
  assert.match(source, /exitComposerFullscreen: \(\) => \{ composerFullscreen\.exit\(\) \}/)
  assert.match(source, /select: owner => owner/)
  assert.match(source, /conversationViewState/)
  assert.match(source, /settingsQuickActions/)
  assert.match(source, /modelDirectories/)
  assert.match(source, /companyGatewayFirst/)
  assert.match(source, /directory\.store\.update/)
  assert.match(source, /model-selection\.option\.trailing/)
  assert.match(source, /company-gateway-multimodal-toggle/)
  assert.match(modelOptionSeam, /model-selection\.option\.trailing/)
  assert.match(modelOptionSeam, /data-model-selection-option-trailing/)
  assert.match(modelOptionSeam, /visibility: hidden/)
  assert.match(modelOptionSeam, /optionTrailing/)
  assert.match(multimodalToggle, /providerId !== COMPANY_GATEWAY_PROVIDER/)
  assert.match(multimodalToggle, /onClick=\{stop\}/)
  assert.match(multimodalToggle, /onMouseDown=\{stop\}/)
  assert.match(multimodalToggle, /setFailure\(result\.error/)
  assert.match(multimodalToggle, /role="alert"/)
  assert.match(source, /id: 'trajectory'/)
  assert.match(source, /id: 'conversation'/)
  assert.match(source, /conversation\.presentation/)
  assert.match(presentation, /matched: ConversationPresentationOwnerProps/)
  assert.match(presentation, /className=\{css\.headerSeat\}[\s\S]*owner\.renderHeader\(\)/)
  assert.match(presentation, /owner\.renderHero\(\)/)
  assert.match(presentation, /owner\.renderSession\(\)/)
  assert.match(presentation, /owner\.renderComposer\(\)/)
  assert.match(presentation, /data-show-process=\{showProcess\}/)
  assert.match(presentation, /data-composer-fullscreen=\{composerFullscreen\}/)
  assert.match(fullscreenControl, /IconFullscreenOutline16/)
  assert.match(fullscreenControl, /IconCloseOutline16/)
  assert.match(fullscreenControl, /event\.key === 'Escape'/)
  assert.match(fullscreenControl, /exitComposerFullscreen\(\)/)
  assert.match(fullscreenControl, /aria-pressed=\{fullscreen\}/)
  assert.match(fullscreenStore, /readonly active: SnapshotStore<boolean> = createSnapshotStore\(false\)/)
  assert.match(fullscreenStore, /toggle\(\)/)
  assert.match(fullscreenStore, /exit\(\)/)
  assert.match(fullscreenCss, /position: absolute/)
  assert.match(css, /\[data-composer-fullscreen='true'\] > :global\(\[data-composer-seat\]\)/)
  assert.match(css, /\[data-composer-fullscreen='true'\] :global\(\[data-composer-card\]\)/)
  assert.match(css, /\[data-composer-fullscreen='true'\] :global\(\[data-input-scroll\]\)/)
  assert.match(css, /:global\(\[data-composer-seat\]\)/)
  assert.match(css, /\[data-show-process='false'\]\s+:global\(\[data-chat-flow-kind='context'\]\),/)
  // A tool-call ChatNode is the stable outer seat for its Read, question,
  // error, and named-tool subrows. Its inner ToolRow publishes the running
  // state, so this hides settled history but leaves the active final call
  // visible until it settles.
  assert.match(
    css,
    /\[data-show-process='false'\]\s+:global\(\[data-chat-flow-kind='tool-call'\]:not\(:has\(\[data-state='running'\]\)\)\)\s*\{/,
  )
  assert.doesNotMatch(css, /\[data-show-process='false'\][\s\S]*\[data-chat-flow-kind='tool-call'\]\)\s*\{/)
  assert.doesNotMatch(css, /data-chat-flow-kind='assistant-step'/)
  assert.doesNotMatch(css, /data-chat-flow-kind='user'/)
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\)/)
  assert.match(
    css,
    /\.root\s*>\s*:global\(\[data-composer-seat\]\)\s+:global\(\[role='status'\]\)\s*\{[\s\S]*?box-sizing:\s*border-box/,
    'composer status notices must use the same border-box sizing as the input card',
  )
  // ChatView's sticky back-to-bottom slot still adds the official composer
  // height inside `[data-conversation-scroll]`. The product footer is a
  // sibling of that scrollport, so the scroll body must zero the inherited
  // seat height or the control sits in the middle of the transcript.
  assert.match(
    css,
    /\.scrollBody\s*\{[\s\S]*--dsh-composer-height:\s*0px/,
    'the product scrollport must not inherit the root composer height',
  )
  // The upstream hero stack carries a 32px centering foot while the active
  // InputBar owns the 8px dock inset. The product presentation keeps the hero
  // title/glow centered, but the complete composer chain must directly use the
  // same dock inset through the public slot and chain wrappers. Both wrappers
  // are `display: contents`, so a shallow seat child selector cannot style the
  // actual composer root.
  assert.match(css, /--dsh-composer-dock-inset:\s*8px/)
  assert.doesNotMatch(
    css,
    /\.root\[data-phase='hero'\]\s*>\s*:global\(\[data-composer-seat\]\)\s*>\s*\*\s*\{/,
    'hero must not stop at the display:contents composer slot wrapper',
  )
  assert.match(
    css,
    /\.root\[data-phase='hero'\]\s*>\s*:global\(\[data-composer-seat\]\)\s+:global\(\[data-composer-stack\]\)\s*\{[\s\S]*?padding-bottom:\s*var\(--dsh-composer-dock-inset\)/,
    'hero must override the generated 32px centering foot on the composer stack after a takeover leaves the stack outside the hidden fallback',
  )
  assert.match(
    css,
    /\.root\s+:global\(\[data-variant='think'\]\)\s*\{[\s\S]*?display:\s*none/,
    'product conversation chrome must hide provider reasoning instead of exposing English reasoning text',
  )
  // The slot anchor carries an inline display value, so the product hides its
  // own seat in compact mode instead of trying to override upstream markup.
  assert.match(css, /\.headerSeat\s*\{\s*display: contents;\s*\}/)
  assert.match(css, /\[data-sidebar-presentation='compact'\][\s\S]*\.headerSeat[\s\S]*display: none/)
  assert.doesNotMatch(css, /@media \(max-width: 999px\)[\s\S]*\.headerSeat[\s\S]*display: none/)
  // The composer is deliberately a sibling of the scrollport.  Its overlay
  // anchor must form an elevated, visible containing block: without this,
  // long transcript scrolling can paint over (or clip) model/permission/
  // context panels.
  assert.match(css, /\.root > :global\(\[data-composer-seat\]\)[\s\S]*position: relative[\s\S]*z-index: 7/)
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\)[\s\S]*position: relative[\s\S]*z-index: 8[\s\S]*height: 0[\s\S]*overflow: visible/)
  assert.match(
    css,
    /calc\(100% - var\(--dsh-composer-side-clearance\) - var\(--dsh-composer-side-clearance\)\)/,
    'Chrome must receive valid subtraction so the shared overlay stays card-wide instead of shrink-to-fit',
  )
  assert.match(
    css,
    /:global\(\[data-composer-overlay-surface\]\)\s*\{[\s\S]*?margin-inline:\s*auto/,
    'the shared overlay surface must center itself independently of its unstyled upstream anchor',
  )
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\) > \[role='dialog'\],[\s\S]*:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\][\s\S]*position: absolute/)
  assert.match(
    css,
    /\[role='dialog'\],[\s\S]*\[role='menu'\][\s\S]*transform:\s*none/,
    'the full-card host must clear trigger-centered transforms or only half the chooser remains visible',
  )
  // `dialog` is the intentionally card-wide class (context/code/knowledge).
  // Compact menus are classified by their menu semantics and direct action
  // rows, not by a fuzzy dialog descendant selector.
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\) > \[role='dialog'\][\s\S]*width:\s*100%/)
  assert.match(
    css,
    /:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\]:has\(> \[role='menuitem'\]\)[\s\S]*width:\s*min\(240px, calc\(100vw - 32px\)\)/,
    'permission menus must remain compact instead of inheriting card-wide width',
  )
  // e327's permission sheets always rise above the card. The product owns
  // this presentation rule because the upstream provider merely supplies one
  // active overlay at a time.
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\][\s\S]*bottom: calc\(100% \+ 8px\)[\s\S]*z-index: 100/)
  assert.match(css, /\[role='menu'\]:has\(> \[role='menuitem'\]\)[\s\S]*padding: 6px[\s\S]*border-radius: 14px[\s\S]*box-shadow: var\(--dsw-shadow-lv3\)/)
  assert.match(css, /\[role='menuitem'\][\s\S]*min-height: 34px[\s\S]*font-size: 13px/)
  assert.match(css, /\[role='menuitem'\]\[aria-checked='true'\][\s\S]*interactive-bg-hover/)
  // The hero permission chip remains icon-first and preserves the old
  // green/blue/warning semantic state colors without relying on CSS hashes.
  assert.match(css, /\.root\[data-phase='hero'\][\s\S]*\[data-permission\][\s\S]*width: 28px/)
  assert.match(css, /\[data-permission='read-only'\][\s\S]*state-success-primary/)
  assert.match(css, /\[data-permission='workspace-write'\][\s\S]*state-business-primary/)
  assert.match(css, /\[data-permission='danger-full-access'\][\s\S]*state-warn-primary/)
  // ModelSelect needs a named product-neutral host so its upward sheet is
  // anchored to the full composer card rather than its tiny trigger.
  assert.match(
    css,
    /\.root\s+:global\(\[data-composer-overlay-host\]\)[\s\S]*position: static/,
    'the product root must raise host specificity above ModelSelect .root regardless of bundle order',
  )
  assert.match(
    css,
    /\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\][\s\S]*width:\s*min\(240px, calc\(100vw - 32px\)\)/,
    'the model menu must use the same compact width contract as permission menus',
  )
  assert.match(
    css,
    /\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\][\s\S]*right:\s*max\([\s\S]*left:\s*auto/,
    'the model menu must preserve its card-right alignment after its vertical anchor moves to the composer seat',
  )
  assert.match(
    css,
    /:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\]\s*\{[\s\S]*?right:\s*auto[\s\S]*?left:\s*0/,
    'permission menus must keep their card-left attachment',
  )
  assert.match(
    css,
    /\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\][\s\S]*height: auto/,
    'the model menu itself carries the generic surface marker, so it must undo the shared zero-height anchor geometry',
  )
  // `conversation.composer.above` is between the shared overlay anchor and
  // the input card.  The model chooser must therefore escape the card's
  // positioning context and use the composer seat just like the permission
  // menu: its bottom then lands above the resource strip instead of covering
  // the "select repository / knowledge scope" row.
  assert.match(
    css,
    /\[data-composer-card\]:has\(\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\]\)[\s\S]*position:\s*static/,
    'the model menu must not use the input card as its positioning context',
  )
  assert.match(
    css,
    /\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\][\s\S]*right:\s*max\(\s*var\(--dsh-composer-side-clearance\),\s*calc\(\(100% - var\(--dsh-composer-card-max-width\)\) \/ 2\)\s*\)/,
    'after anchoring to the composer seat, the model menu must preserve the input card right edge',
  )
  assert.match(overlayHostSeam, /data-composer-overlay-host=\{overlay\.available \|\| undefined\}/)
  for (const name of ['root', 'headerSeat', 'scrollBody', 'heroTitleSeat']) {
    assert.match(presentation, new RegExp(`css\\.${name}`))
    assert.match(css, new RegExp(`\\.${name}(?:[\\s{.:])`))
  }
  assert.doesNotMatch(css, /(?:^|\n)\.(?:header|tabs|viewArea|composerStack|overlayAnchor)\b/m)
  assert.doesNotMatch(`${source}\n${presentation}`, /createChatStore|ConversationController|defineStore|useSession\(/)
})

test('keeps the left composer controls intact while allowing the model name to shrink', async () => {
  const css = await readFile(new URL('../src/client/ConversationPresentation.module.css', import.meta.url), 'utf8')

  assert.match(
    css,
    /\.root\s+:global\(\[data-composer-card\]\s+\*:has\(>\s*\[data-slot='conversation\.input\.left'\]\s+\[data-browser-target-control\]\)\)\s*\{[\s\S]*?flex:\s*0 0 auto[\s\S]*?min-width:\s*max-content/,
    'the left tool group containing Browser Target must not shrink or let its children overlap',
  )
  assert.match(
    css,
    /\.root\s+:global\(\[data-composer-card\]\s+\*:has\(>\s*\[data-slot='conversation\.input\.model'\]\s+\[data-composer-overlay-host\]\)\)\s*\{[\s\S]*?flex:\s*0 1 auto[\s\S]*?min-width:\s*0/,
    'the trailing model group must be allowed to absorb narrow-width pressure',
  )
  assert.match(
    css,
    /\.root\s+:global\(\[data-composer-overlay-host\]\)\s*\{[\s\S]*?flex:\s*0 1 auto[\s\S]*?min-width:\s*0/,
    'the model host must remain shrinkable inside the trailing group',
  )
})

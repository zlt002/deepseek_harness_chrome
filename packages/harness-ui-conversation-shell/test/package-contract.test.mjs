import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Conversation shell is a product presentation plugin, not a second conversation controller', async () => {
  const [manifest, source, presentation, css, overlayHostSeam] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ConversationPresentation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ConversationPresentation.module.css', import.meta.url), 'utf8'),
    readFile(new URL('../../../upstream-contributions/0013-composer-overlay-host-marker.patch', import.meta.url), 'utf8'),
  ])
  assert.match(manifest, /@accrui\/harness-ui-conversation-shell/)
  // Cordis only exposes a property when it was declared in `inject`. The
  // adapter registers a presentation slot before reading its own services.
  assert.match(source, /export const inject = \['slots', 'settingsQuickActions', 'conversationViewState'\]/)
  assert.match(source, /ctx\.slots\.inject\('conversation\.presentation'/)
  assert.match(source, /select: owner => owner/)
  assert.match(source, /conversationViewState/)
  assert.match(source, /settingsQuickActions/)
  assert.match(source, /id: 'trajectory'/)
  assert.match(source, /id: 'conversation'/)
  assert.match(source, /conversation\.presentation/)
  assert.match(presentation, /matched: ConversationPresentationOwnerProps/)
  assert.match(presentation, /owner\.renderHeader\(\)/)
  assert.match(presentation, /owner\.renderHero\(\)/)
  assert.match(presentation, /owner\.renderSession\(\)/)
  assert.match(presentation, /owner\.renderComposer\(\)/)
  assert.match(css, /:global\(\[data-composer-seat\]\)/)
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\)/)
  // The compact product frame replaces the historical upstream header: that
  // one slot contains the title/action row and the conversation/trajectory
  // tablist. Scope the rule to the stable frame marker, not a generic media
  // query, so standalone Harness Web keeps its header at every width.
  assert.match(css, /\[data-sidebar-presentation='compact'\][\s\S]*\[data-slot='conversation\.session\.header'\][\s\S]*display: none/)
  assert.doesNotMatch(css, /@media \(max-width: 999px\)[\s\S]*\[data-slot='conversation\.session\.header'\][\s\S]*display: none/)
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
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\) > \[role='dialog'\],[\s\S]*:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\][\s\S]*position: absolute/)
  assert.match(
    css,
    /\[role='dialog'\],[\s\S]*\[role='menu'\][\s\S]*transform:\s*none/,
    'the full-card host must clear trigger-centered transforms or only half the chooser remains visible',
  )
  // e327's permission and agent-mode sheets always rise above the card.  The
  // product owns this presentation rule because the upstream provider merely
  // supplies one active overlay at a time.
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\][\s\S]*bottom: calc\(100% \+ 8px\)[\s\S]*z-index: 100/)
  assert.match(css, /\[role='menu'\]:has\(> \[role='menuitem'\]\)[\s\S]*padding: 6px[\s\S]*border-radius: 14px/)
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
  assert.match(css, /\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\][\s\S]*width: 100%/)
  assert.match(
    css,
    /\[data-composer-overlay-host\] > \[data-composer-overlay-surface\]\[role='menu'\][\s\S]*height: auto[\s\S]*overflow: hidden/,
    'the model menu itself carries the generic surface marker, so it must undo the shared zero-height anchor geometry',
  )
  assert.match(overlayHostSeam, /data-composer-overlay-host=\{overlay\.available \|\| undefined\}/)
  for (const name of ['root', 'scrollBody', 'heroTitleSeat']) {
    assert.match(presentation, new RegExp(`css\\.${name}`))
    assert.match(css, new RegExp(`\\.${name}(?:[\\s{.:])`))
  }
  assert.doesNotMatch(css, /(?:^|\n)\.(?:header|tabs|viewArea|composerStack|overlayAnchor)\b/m)
  assert.doesNotMatch(`${source}\n${presentation}`, /createChatStore|ConversationController|defineStore|useSession\(/)
})

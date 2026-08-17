import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Conversation shell is a product presentation plugin, not a second conversation controller', async () => {
  const [manifest, source, presentation, css] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ConversationPresentation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/client/ConversationPresentation.module.css', import.meta.url), 'utf8'),
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
  // The compact shell replaces the historical upstream header at side-panel
  // widths.  The public slot marker, rather than an upstream CSS-module name,
  // keeps that product rule stable across Harness upgrades.
  assert.match(css, /@media \(max-width: 999px\)[\s\S]*\[data-slot='conversation\.session\.header'\][\s\S]*display: none/)
  // The composer is deliberately a sibling of the scrollport.  Its overlay
  // anchor must form an elevated, visible containing block: without this,
  // long transcript scrolling can paint over (or clip) model/permission/
  // context panels.
  assert.match(css, /\.root > :global\(\[data-composer-seat\]\)[\s\S]*position: relative[\s\S]*z-index: 7/)
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\)[\s\S]*position: relative[\s\S]*z-index: 8[\s\S]*height: 0[\s\S]*overflow: visible/)
  assert.match(css, /:global\(\[data-composer-overlay-surface\]\) > \[role='dialog'\],[\s\S]*:global\(\[data-composer-overlay-surface\]\) > \[role='menu'\][\s\S]*position: absolute/)
  for (const name of ['root', 'scrollBody', 'heroTitleSeat']) {
    assert.match(presentation, new RegExp(`css\\.${name}`))
    assert.match(css, new RegExp(`\\.${name}(?:[\\s{.:])`))
  }
  assert.doesNotMatch(css, /(?:^|\n)\.(?:header|tabs|viewArea|composerStack|overlayAnchor)\b/m)
  assert.doesNotMatch(`${source}\n${presentation}`, /createChatStore|ConversationController|defineStore|useSession\(/)
})

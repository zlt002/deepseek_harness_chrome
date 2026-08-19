import assert from 'node:assert/strict'
import test from 'node:test'
import { SCOPE_PANEL_GAP_PX, SCOPE_PANEL_MIN_HEIGHT_PX, scopePanelCeiling, scopePanelMaxHeightPx } from '../src/client/panel-geometry.js'

test('prefers the compact workspace/session bar over the conversation column top', () => {
  assert.equal(scopePanelCeiling(48, 12), 48)
  assert.equal(scopePanelCeiling(undefined, 12), 12)
  assert.equal(scopePanelCeiling(undefined, undefined, 0), 0)
})

test('grows a bottom-anchored chooser up to just below the workspace/session bar', () => {
  assert.equal(scopePanelMaxHeightPx(820, 48), 820 - 48 - SCOPE_PANEL_GAP_PX)
})

test('tracks a taller sidebar by using the live panel bottom and header bottom', () => {
  assert.equal(scopePanelMaxHeightPx(1100, 48), 1100 - 48 - SCOPE_PANEL_GAP_PX)
  assert.equal(scopePanelMaxHeightPx(640, 48), 640 - 48 - SCOPE_PANEL_GAP_PX)
})

test('keeps a usable floor when the remaining column is shorter than the list', () => {
  assert.equal(scopePanelMaxHeightPx(120, 48), SCOPE_PANEL_MIN_HEIGHT_PX)
})

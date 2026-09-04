import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BROWSER_TARGET_PANEL_GAP_PX,
  BROWSER_TARGET_PANEL_MIN_HEIGHT_PX,
  browserTargetPanelCeiling,
  browserTargetPanelMaxHeightPx,
} from '../src/client/panel-geometry.js'

test('prefers the compact header bottom over the conversation presentation top', () => {
  assert.equal(browserTargetPanelCeiling(48, 12), 48)
  assert.equal(browserTargetPanelCeiling(undefined, 12), 12)
  assert.equal(browserTargetPanelCeiling(undefined, undefined, 0), 0)
})

test('leaves the required gap between the panel top and compact header', () => {
  assert.equal(browserTargetPanelMaxHeightPx(820, 48), 820 - 48 - BROWSER_TARGET_PANEL_GAP_PX)
})

test('uses the live panel bottom when the sidebar height changes', () => {
  assert.equal(browserTargetPanelMaxHeightPx(1100, 48), 1100 - 48 - BROWSER_TARGET_PANEL_GAP_PX)
  assert.equal(browserTargetPanelMaxHeightPx(640, 48), 640 - 48 - BROWSER_TARGET_PANEL_GAP_PX)
})

test('keeps a usable minimum height when the remaining space is short', () => {
  assert.equal(browserTargetPanelMaxHeightPx(120, 48), BROWSER_TARGET_PANEL_MIN_HEIGHT_PX)
})

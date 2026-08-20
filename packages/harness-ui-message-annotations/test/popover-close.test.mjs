import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldClosePopover } from '../src/client/popover-close.js'

test('closes on Escape', () => {
  assert.equal(shouldClosePopover({ key: 'Escape' }), true)
})

test('closes when the pointer goes outside the panel', () => {
  assert.equal(shouldClosePopover({ targetInsidePanel: false }), true)
})

test('keeps the panel open for a pointer event inside the panel', () => {
  assert.equal(shouldClosePopover({ targetInsidePanel: true }), false)
})

test('closes when the selection range is invalid or has no visible area', () => {
  assert.equal(shouldClosePopover({ rangeRectValid: false }), true)
  assert.equal(shouldClosePopover({ rangeRectValid: true }), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { VIEWPORT_MENU_MARGIN, constrainViewportMenuPosition } from '../src/renderer/src/utils/menuPosition.ts'

test('constrainViewportMenuPosition keeps menu at the requested anchor when enough room exists', () => {
  assert.deepEqual(
    constrainViewportMenuPosition(
      { x: 120, y: 140 },
      { width: 180, height: 220 },
      { width: 1280, height: 800 }
    ),
    { x: 120, y: 140 }
  )
})

test('constrainViewportMenuPosition shifts menus back inside the right and bottom viewport edges', () => {
  assert.deepEqual(
    constrainViewportMenuPosition(
      { x: 760, y: 620 },
      { width: 240, height: 200 },
      { width: 900, height: 760 }
    ),
    {
      x: 900 - 240 - VIEWPORT_MENU_MARGIN,
      y: 760 - 200 - VIEWPORT_MENU_MARGIN
    }
  )
})

test('constrainViewportMenuPosition falls back to the viewport margin when the menu is larger than the viewport', () => {
  assert.deepEqual(
    constrainViewportMenuPosition(
      { x: 40, y: 40 },
      { width: 500, height: 420 },
      { width: 360, height: 280 }
    ),
    { x: VIEWPORT_MENU_MARGIN, y: VIEWPORT_MENU_MARGIN }
  )
})
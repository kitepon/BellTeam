import assert from 'node:assert/strict'
import test from 'node:test'
import { stackLayers, stepIndex } from '../web/image-gallery.js'

test('画像の切り替えは端で止まらず一周する', () => {
  assert.equal(stepIndex(0, 1, 3), 1)
  assert.equal(stepIndex(2, 1, 3), 0)
  assert.equal(stepIndex(0, -1, 3), 2)
  assert.equal(stepIndex(5, 0, 3), 2)
  assert.equal(stepIndex(0, 1, 0), 0)
})

test('重ねたカードは先頭の3枚までを奥から手前の順に並べる', () => {
  assert.deepEqual(stackLayers(['a', 'b']), [{ url: 'b', depth: 1 }, { url: 'a', depth: 0 }])
  assert.deepEqual(stackLayers(['a', 'b', 'c', 'd']).map(layer => layer.url), ['c', 'b', 'a'])
})

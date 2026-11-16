import assert from 'node:assert/strict'
import test from 'node:test'
import { clampView, fileNameOf, nameWithType, pinchView, shareKind, stackLayers, stepIndex, zoomAt } from '../web/image-gallery.js'

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

// ---- a276: zoom / pan / names / share ----
test('zoomAt keeps the point under the pointer fixed, scale is held to 1..8', () => {
  const point = { x: 100, y: -40 }, view = { scale: 2, x: 30, y: 10 }
  const next = zoomAt(view, 4, point)
  // the image point under the pointer before: (point - offset) / scale; it must be the same after
  const under = (v, p) => [(p.x - v.x) / v.scale, (p.y - v.y) / v.scale]
  assert.deepEqual(under(next, point), under(view, point)); assert.equal(next.scale, 4)
  assert.equal(zoomAt(view, 99, point).scale, 8); assert.equal(zoomAt(view, 0.1, point).scale, 1)
})

test('clampView: a small image stays centred, a zoomed one cannot leave the stage', () => {
  const size = { width: 400, height: 300, stageWidth: 800, stageHeight: 600 }
  assert.deepEqual(clampView({ scale: 1, x: 90, y: -70 }, size), { scale: 1, x: 0, y: 0 }, 'fits: centred')
  assert.deepEqual(clampView({ scale: 4, x: 1000, y: -1000 }, size), { scale: 4, x: 400, y: -300 }, '(400*4-800)/2 and (300*4-600)/2')
  assert.deepEqual(clampView({ scale: 4, x: 50, y: 20 }, size), { scale: 4, x: 50, y: 20 }, 'inside: unchanged')
  assert.equal(clampView({ scale: 20, x: 0, y: 0 }, size).scale, 8)
})

test('pinchView scales by the distance ratio and follows the centre', () => {
  const start = { view: { scale: 1, x: 0, y: 0 }, distance: 100, center: { x: 10, y: 20 } }
  const next = pinchView(start, { distance: 300, center: { x: 25, y: 20 } })
  assert.equal(next.scale, 3)
  const under = (v, p) => [(p.x - v.x) / v.scale, (p.y - v.y) / v.scale]
  assert.deepEqual(under(next, { x: 25, y: 20 }).map(Math.round), under(start.view, start.center).map(Math.round), 'the pinched point follows the fingers')
})

test('fileNameOf takes the saved name from the URL; blob and data URLs have none; nameWithType adds the extension only when missing', () => {
  assert.equal(fileNameOf('/api/message-images/owner/abc123.png'), 'abc123.png'); assert.equal(fileNameOf('/api/message-images/o/f.jpg?download=1'), 'f.jpg')
  assert.equal(fileNameOf('blob:http://x/uuid'), ''); assert.equal(fileNameOf('data:image/png;base64,AA'), ''); assert.equal(fileNameOf(undefined), '')
  assert.equal(nameWithType('abc.png', 'image/jpeg'), 'abc.png'); assert.equal(nameWithType('', 'image/jpeg'), 'image.jpg'); assert.equal(nameWithType('shot', 'image/webp'), 'shot.webp'); assert.equal(nameWithType('shot', 'text/plain'), 'shot')
})

test('shareKind: OS share when files can be shared, else copy, else nothing', () => {
  class Clip {}
  const share = { share() {}, canShare: () => true, clipboard: { write() {} } }
  assert.equal(shareKind(share, Clip), 'share')
  assert.equal(shareKind({ share() {}, canShare: () => false, clipboard: { write() {} } }, Clip), 'copy', 'cannot share files')
  assert.equal(shareKind({ clipboard: { write() {} } }, Clip), 'copy'); assert.equal(shareKind({ clipboard: { write() {} } }, undefined), null)
  assert.equal(shareKind({ share() {}, canShare() { throw new Error('x') }, clipboard: { write() {} } }, Clip), 'copy', 'canShare that throws is not a reason to fail')
  assert.equal(shareKind({}, Clip), null); assert.equal(shareKind(undefined, undefined), null)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { supportsServerTransport } from '../web/server-origin.js'

test('HTTPSとlocalhost・LANのHTTPで秘密入力を使える', () => {
  for (const address of ['https://team.example.com', 'http://localhost:18891', 'http://bellteam:18891', 'http://team.local:18891', 'http://192.168.1.2:18891', 'http://10.1.2.3', 'http://172.31.2.3', 'http://127.0.0.1', 'http://[::1]:18891', 'http://[fd00::1]:18891', 'http://[fe80::1]:18891']) {
    assert.equal(supportsServerTransport(address), true, address)
  }
  for (const address of ['http://example.com', 'http://8.8.8.8', 'http://172.32.1.2', 'ftp://localhost', 'invalid']) {
    assert.equal(supportsServerTransport(address), false, address)
  }
})

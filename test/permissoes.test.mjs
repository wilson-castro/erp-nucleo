import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pode } from '../dist/permissoes/index.js'

test('pode() exige true estrito, nao truthiness', () => {
  assert.equal(pode({ editar: true }, 'editar'), true)
  assert.equal(pode({ editar: false }, 'editar'), false)
})

test('valor ausente, herdado ou nao booleano e negado — fail closed', () => {
  assert.equal(pode({}, 'editar'), false)
  assert.equal(pode({ editar: 1 }, 'editar'), false)
  assert.equal(pode({ editar: 'true' }, 'editar'), false)
  assert.equal(pode(null, 'editar'), false)
  assert.equal(pode(undefined, 'editar'), false)
  assert.equal(pode({}, 'toString'), false)
  assert.equal(pode(Object.create({ editar: true }), 'editar'), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pode } from '../dist/permissoes/index.js'

test('pode() exige true estrito, nao truthiness', () => {
  assert.equal(pode({ editar: true, remover_remessa: false, excluir: false, aprovar: false }, 'editar'), true)
  assert.equal(pode({ editar: false, remover_remessa: false, excluir: false, aprovar: false }, 'editar'), false)
})

test('valor ausente ou nao booleano e negado — fail closed', () => {
  // 06-seguranca.md §9.2: qualquer coisa que nao seja exatamente `true` nega.
  assert.equal(pode({}, 'editar'), false)
  assert.equal(pode({ editar: 1 }, 'editar'), false)
  assert.equal(pode({ editar: 'true' }, 'editar'), false)
  assert.equal(pode(null, 'editar'), false)
  assert.equal(pode(undefined, 'editar'), false)
})

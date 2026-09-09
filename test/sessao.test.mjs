import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessaoArquivo } from '../dist/adaptadores/sessao-arquivo.js'
import { identidadeDev } from '../dist/adaptadores/identidade-dev.js'
import { criarNucleo } from '../dist/fabricas/criarNucleo.js'
import { dadosFake } from '../dist/testing/index.js'

const dir = mkdtempSync(join(tmpdir(), 'sessao-'))

test('a sessao gravada por um processo e legivel por outro (arquivo, nao memoria)', async () => {
  const a = sessaoArquivo({ dir })
  const b = sessaoArquivo({ dir })   // instancia distinta = outro "processo"
  await a.gravar('sid-1', { sub: 'gabrigas', roles: ['OPERADOR'],
                            accessToken: 'tk', expiraEm: Date.now() + 60_000 })
  const lida = await b.ler('sid-1')
  assert.equal(lida.sub, 'gabrigas')
})

test('identidadeDev autentica os quatro atores do caso', async () => {
  const idp = identidadeDev()
  for (const u of ['gabrigas', 'marina', 'rafael', 'carla']) {
    const s = await idp.autenticar({ usuario: u })
    assert.equal(s.sub, u)
    assert.ok(s.accessToken.length > 0)
  }
  assert.equal(await idp.autenticar({ usuario: 'ninguem' }), null)
})

test('identidadeDev recusa rodar em producao', async () => {
  const antes = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try { assert.throws(() => identidadeDev(), /producao/i) }
  finally { process.env.NODE_ENV = antes }
})

test('a sessao entregue a aplicacao nao contem token nem grupos', async () => {
  const store = sessaoArquivo({ dir })
  await store.gravar('sid-2', { sub: 'marina', roles: ['OPERADOR'],
                                accessToken: 'token-secreto', expiraEm: Date.now() + 60_000 })
  const nucleo = criarNucleo({
    dados: dadosFake({}),
    sessao: store,
    identidade: identidadeDev(),
    lerCookieDeSessao: async () => 'sid-2',
  })
  const s = await nucleo.sessao.atual()
  assert.deepEqual(Object.keys(s).sort(), ['roles', 'sub'])
  assert.ok(!JSON.stringify(s).includes('token-secreto'))
})

test('sessao expirada e tratada como ausente', async () => {
  const store = sessaoArquivo({ dir })
  await store.gravar('sid-3', { sub: 'carla', roles: [], accessToken: 'tk',
                                expiraEm: Date.now() - 1 })
  const nucleo = criarNucleo({
    dados: dadosFake({}), sessao: store, identidade: identidadeDev(),
    lerCookieDeSessao: async () => 'sid-3',
  })
  assert.equal(await nucleo.sessao.atual(), null)
})

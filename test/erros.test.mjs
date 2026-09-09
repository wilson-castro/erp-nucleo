import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizar, SessaoInvalida, NaoEncontrado, Desatualizado, ErroDeAplicacao }
  from '../dist/interno/erros.js'

const resposta = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

test('401 vira SessaoInvalida', async () => {
  await assert.rejects(() => normalizar(resposta(401)), SessaoInvalida)
})

test('404 vira NaoEncontrado', async () => {
  await assert.rejects(() => normalizar(resposta(404)), NaoEncontrado)
})

test('403 vira OPERACAO_NAO_PERMITIDA', async () => {
  await assert.rejects(() => normalizar(resposta(403)),
    (e) => e instanceof ErroDeAplicacao && e.codigo === 'OPERACAO_NAO_PERMITIDA')
})

test('409 vira Desatualizado preservando supportId', async () => {
  await assert.rejects(
    () => normalizar(resposta(409, { codigo: 'REGISTRO_DESATUALIZADO', supportId: 'abc' })),
    (e) => e instanceof Desatualizado && e.supportId === 'abc')
})

test('500 com corpo do framework nao vaza detalhe interno', async () => {
  // o dominio pode devolver lixo; o BFF normaliza e nao repassa
  await assert.rejects(
    () => normalizar(resposta(500, {
      message: 'org.springframework.NullPointerException at java.base/...',
    })),
    (e) => e instanceof ErroDeAplicacao
        && e.codigo === 'ERRO_INTERNO'
        && !JSON.stringify({ codigo: e.codigo, supportId: e.supportId }).includes('spring'))
})

test('200 devolve corpo e ETag como versao', async () => {
  const r = await normalizar(resposta(200, { id: '8821' }, { etag: '"42"' }))
  assert.equal(r.status, 200)
  assert.equal(r.versao, '"42"')
  assert.deepEqual(r.body, { id: '8821' })
})

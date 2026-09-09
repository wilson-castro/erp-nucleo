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

test('codigo desconhecido do upstream vira ERRO_INTERNO', async () => {
  // o unico teste do ramo !res.ok nao enviava `codigo`, entao a rejeicao de codigo
  // desconhecido nunca era exercitada — o gate funcionava sem nenhuma protecao de regressao
  for (const codigo of ['ADMIN_OVERRIDE', 'DESTINO_INVALIDO', 42, null, { a: 1 }]) {
    await assert.rejects(
      () => normalizar(resposta(500, { codigo })),
      (e) => e instanceof ErroDeAplicacao && e.codigo === 'ERRO_INTERNO',
      `codigo ${JSON.stringify(codigo)} nao deveria atravessar`)
  }
})

test('supportId hostil e DESCARTADO, nao repassado nem truncado', async () => {
  // supportId e o outro campo que atravessa a fronteira. Sem validacao, o dominio poe
  // aqui o stacktrace que o `codigo` impediu de passar.
  const stacktrace = 'org.springframework.NullPointerException at java.base/Foo.bar(Foo.java:42)'
  await assert.rejects(
    () => normalizar(resposta(500, { supportId: stacktrace })),
    (e) => e.supportId === undefined)

  for (const hostil of [{ nested: 'x' }, 12345, ['a'], 'a'.repeat(65), 'com espaco', '']) {
    await assert.rejects(
      () => normalizar(resposta(500, { supportId: hostil })),
      (e) => e.supportId === undefined, `supportId ${JSON.stringify(hostil)} atravessou`)
  }

  // um id opaco legitimo passa
  await assert.rejects(
    () => normalizar(resposta(409, { supportId: 'a1b2-c3d4' })),
    (e) => e instanceof Desatualizado && e.supportId === 'a1b2-c3d4')
})

test('200 devolve corpo e ETag como versao', async () => {
  const r = await normalizar(resposta(200, { id: '8821' }, { etag: '"42"' }))
  assert.equal(r.status, 200)
  assert.equal(r.versao, '"42"')
  assert.deepEqual(r.body, { id: '8821' })
})

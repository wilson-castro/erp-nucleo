import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarNucleoDoShell } from '../dist/fabricas/criarNucleo.js'
import { acessoHttp } from '../dist/adaptadores/acesso-http.js'
import { sessaoMemoria } from '../dist/testing/index.js'
import { identidadeDev } from '../dist/adaptadores/identidade-dev.js'
import { ErroDeAplicacao } from '../dist/interno/erros.js'

const eu = { modulos: [], papeis: [{ papel: 'admin-geral' }] }

function preparar(t, responder, { caminhos = ['/v2/eu'] } = {}) {
  const eventos = []
  const store = sessaoMemoria()
  const identidade = identidadeDev()
  let token
  t.mock.method(identidade, 'concluir', async (...args) => {
    const s = await identidadeDev().concluir(...args)
    token = s?.accessToken
    eventos.push('identidade')
    return s
  })
  t.mock.method(store, 'gravar', async () => { eventos.push('gravar') })
  t.mock.method(store, 'remover', async () => { eventos.push('remover') })
  t.mock.method(globalThis, 'fetch', async (url, op) => {
    eventos.push('acesso')
    assert.deepEqual(eventos, ['identidade', 'acesso'], 'sessao gravada antes da consulta')
    assert.equal(String(url), 'https://acesso.example/v2/eu')
    assert.equal(op.method, 'GET')
    assert.equal(op.headers.get('authorization'), `Bearer ${token}`, 'nao usou o token recem-obtido')
    assert.equal(op.headers.get('x-erp-chamador'), 'shell')
    assert.equal(op.cache, 'no-store')
    assert.equal(op.redirect, 'manual')
    assert.ok(op.signal instanceof AbortSignal)
    return responder(op)
  })
  const n = criarNucleoDoShell({
    app: 'shell', sessao: store, escrita: { store, identidade },
    destinos: { acesso: { origem: 'https://acesso.example', caminhos, metodos: ['GET'], credencial: 'usuario', timeoutMs: 20 } },
    acesso: acessoHttp({ destino: 'acesso' }),
    // Um cookie antigo nao fornece a identidade deste login. Nao deve ser lido.
    lerCookieDeSessao: async () => { assert.fail('consultou cookie antes de gravar') },
    tokenDeServico: () => { assert.fail('consultou token de servico') },
  })
  const login = async () => {
    const { url, idTransacao } = await n.sessao.iniciarLogin('/acesso')
    const busca = new URL(url, 'https://shell.example').searchParams
    return n.sessao.concluirLogin(idTransacao, { state: busca.get('state'), nonce: busca.get('nonce'), usuario: 'carla' })
  }
  return { login, eventos }
}

test('login consulta pelo registro com token novo antes de gravar; administradora sem modulos loga', async (t) => {
  const { login, eventos } = preparar(t, () => Response.json(eu))
  const r = await login()
  assert.deepEqual(eventos, ['identidade', 'acesso', 'gravar'])
  assert.deepEqual(Object.keys(r).sort(), ['destino', 'id'])
  assert.equal(r.destino, '/acesso')
  assert.doesNotMatch(JSON.stringify(r), /dev\.|Token|papeis/)
})

test('login recusado por 401 nao grava nem remove sessao provisoria', async (t) => {
  const { login, eventos } = preparar(t, () => Response.json({ codigo: 'SESSAO_EXPIRADA' }, { status: 401 }))
  assert.equal(await login(), null)
  assert.deepEqual(eventos, ['identidade', 'acesso'])
})

for (const [nome, responder] of [
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://fora.example' } })],
  ['5xx', () => Response.json({ stack: 'secreto', supportId: 'invalido com stack' }, { status: 503 })],
  ['timeout', (op) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(eu)), 1_000)
    op.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('secreto', 'TimeoutError'))
    }, { once: true })
  })],
  ['JSON invalido', () => new Response('secreto', { status: 200 })],
  ['corpo invalido', () => Response.json({ modulos: [], papeis: 'secreto' })],
]) {
  test(`login: ${nome} e erro normalizado sem gravacao`, async (t) => {
    const { login, eventos } = preparar(t, responder)
    await assert.rejects(login(), (e) => e instanceof ErroDeAplicacao && e.codigo === 'ERRO_INTERNO' && !e.message.includes('secreto'))
    assert.deepEqual(eventos, ['identidade', 'acesso'])
  })
}

test('login respeita caminhos do registro: /v2/eu nao declarado nao faz rede nem grava', async (t) => {
  const { login, eventos } = preparar(t, () => { assert.fail('fez rede fora do registro') }, { caminhos: ['/outro'] })
  await assert.rejects(login(), (e) => e.codigo === 'DESTINO_INVALIDO')
  assert.deepEqual(eventos, ['identidade'])
})

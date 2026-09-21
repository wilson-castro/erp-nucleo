import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarFragmento, responderFragmento } from '../dist/fabricas/fragmento.js'
import { NaoEncontrado, SessaoInvalida } from '../dist/interno/erros.js'

// ---------- consumidor: criarFragmento ----------

/** fetch falso que registra a chamada e responde o que o teste mandar. */
function donaFalsa(resposta = () => new Response('<p>ok</p>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) {
  const chamadas = []
  const fetch = async (url, init) => { chamadas.push({ url: String(url), init }); return resposta(url, init) }
  return { fetch, chamadas }
}

const cfg = (extra = {}) => ({
  zonas: { zona2: { origem: 'http://127.0.0.1:3002', fragmentos: ['tarefa'] } },
  lerCookieDeSessao: async () => 'sid-1',
  ...extra,
})

test('busca o fragmento declarado e devolve o HTML', async () => {
  const d = donaFalsa()
  const f = criarFragmento(cfg({ fetch: d.fetch }))
  assert.equal(await f.buscar('zona2', 'tarefa', 't-1'), '<p>ok</p>')
  assert.equal(d.chamadas[0].url, 'http://127.0.0.1:3002/zona2/_fragmento/tarefa/t-1')
})

test('identidade vai so no cookie: sem Authorization, sem cabecalho de usuario', async () => {
  const d = donaFalsa()
  await criarFragmento(cfg({ fetch: d.fetch })).buscar('zona2', 'tarefa', 't-1')
  const h = new Headers(d.chamadas[0].init.headers)
  assert.equal(h.get('cookie'), '__Host-session=sid-1')
  assert.equal(h.get('authorization'), null)
  assert.ok(![...h.keys()].some((k) => /usuario|user|sub/i.test(k)), [...h.keys()].join(','))
  assert.equal(h.get('accept-fragmento-versao'), '1')
  assert.equal(d.chamadas[0].init.redirect, 'manual')
  assert.equal(d.chamadas[0].init.cache, 'no-store')
})

test('sem cookie de sessao nao ha chamada: ausencia', async () => {
  const d = donaFalsa()
  const f = criarFragmento(cfg({ fetch: d.fetch, lerCookieDeSessao: async () => undefined }))
  assert.equal(await f.buscar('zona2', 'tarefa', 't-1'), null)
  assert.equal(d.chamadas.length, 0)
})

test('zona, nome ou id fora da allowlist nunca viram URL', async () => {
  const d = donaFalsa()
  const f = criarFragmento(cfg({ fetch: d.fetch }))
  for (const [z, n, id] of [
    ['zona9', 'tarefa', 't-1'], ['zona2', 'outro', 't-1'], ['__proto__', 'tarefa', 't-1'],
    ['zona2', 'tarefa', '..'], ['zona2', 'tarefa', '.'], ['zona2', 'tarefa', ''],
    ['zona2', 'tarefa', 'a\u0000b'], ['zona2', 'tarefa', 'x'.repeat(257)], ['zona2', 'tarefa', 42],
  ]) {
    assert.equal(await f.buscar(z, n, id), null, `${z}/${n}/${id}`)
  }
  assert.equal(d.chamadas.length, 0)
})

test('id com barra ou travessia e codificado e nao sai do caminho do fragmento', async () => {
  const d = donaFalsa()
  const f = criarFragmento(cfg({ fetch: d.fetch }))
  await f.buscar('zona2', 'tarefa', '../../admin')
  const u = new URL(d.chamadas[0].url)
  assert.equal(u.origin, 'http://127.0.0.1:3002')
  assert.ok(u.pathname.startsWith('/zona2/_fragmento/tarefa/'), u.pathname)
  assert.equal(u.pathname.split('/').length, 5, u.pathname)
})

test('registro invalido falha no boot, nao na requisicao', () => {
  for (const origem of ['ftp://x', 'http://u:p@x', 'http://x/caminho', 'nao-e-url']) {
    assert.throws(() => criarFragmento(cfg({ zonas: { zona2: { origem, fragmentos: ['tarefa'] } } })), /fragmento/i, origem)
  }
  assert.throws(() => criarFragmento(cfg({ zonas: { zona2: { origem: 'http://x', fragmentos: ['a/b'] } } })), /fragmento/i)
})

test('toda falha da dona vira ausencia, nunca excecao', async () => {
  const casos = [
    () => new Response(null, { status: 204 }),
    () => new Response('x', { status: 401 }),
    () => new Response('x', { status: 404 }),
    () => new Response('x', { status: 500 }),
    () => new Response(null, { status: 307, headers: { location: 'http://evil' } }),
    () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    () => { throw new TypeError('fetch failed ECONNREFUSED') },
  ]
  for (const c of casos) {
    const f = criarFragmento(cfg({ fetch: async () => c() }))
    assert.equal(await f.buscar('zona2', 'tarefa', 't-1'), null)
  }
})

test('HTML ativo vindo da dona e recusado tambem na consumidora', async () => {
  for (const html of ['<script>x()</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:x">a</a>', '<iframe src=x></iframe>']) {
    const f = criarFragmento(cfg({ fetch: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) }))
    assert.equal(await f.buscar('zona2', 'tarefa', 't-1'), null, html)
  }
})

test('timeout: dona travada nao pendura a pagina alem do limite', async () => {
  const pendura = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))
  const f = criarFragmento(cfg({ fetch: pendura, timeoutMs: 100 }))
  const t0 = Date.now()
  assert.equal(await f.buscar('zona2', 'tarefa', 't-1'), null)
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`)
})

test('timeout padrao e 2 s', async () => {
  let sinal
  const f = criarFragmento(cfg({ fetch: async (_u, init) => { sinal = init.signal; return new Response(null, { status: 204 }) } }))
  await f.buscar('zona2', 'tarefa', 't-1')
  assert.ok(sinal instanceof AbortSignal)
  // o sinal do AbortSignal.timeout ainda nao disparou logo apos a chamada
  assert.equal(sinal.aborted, false)
})

// ---------- dono: responderFragmento ----------

const pedido = (h = {}) => new Request('http://z/zona2/_fragmento/tarefa/t-1', { headers: h })

test('200 com HTML inerte e cabecalhos obrigatorios', async () => {
  const r = await responderFragmento(pedido(), async () => '<p>tarefa</p>')
  assert.equal(r.status, 200)
  assert.equal(await r.text(), '<p>tarefa</p>')
  assert.equal(r.headers.get('cache-control'), 'private, no-store')
  assert.match(r.headers.get('content-type'), /^text\/html; charset=utf-8$/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
})

test('ausencia (null), modulo negado e sessao invalida: 204 sem corpo, iguais', async () => {
  for (const produzir of [async () => null, async () => { throw new NaoEncontrado() }, async () => { throw new SessaoInvalida() }]) {
    const r = await responderFragmento(pedido(), produzir)
    assert.equal(r.status, 204)
    assert.equal(await r.text(), '')
    assert.equal(r.headers.get('cache-control'), 'private, no-store')
  }
})

test('notFound() do Next dentro do fragmento tambem vira 204, nao 404', async () => {
  const erro = Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  const r = await responderFragmento(pedido(), async () => { throw erro })
  assert.equal(r.status, 204)
})

test('HTML com script no dono vira 500 sem corpo (ADR-0011, decisao 7)', async () => {
  for (const html of ['<script>x()</script>', '<SCRIPT src=a>', '<div onclick="x()">', '<a href=" javascript:x">', '<object data=x>', '<embed src=x>', '<iframe srcdoc="x">']) {
    const r = await responderFragmento(pedido(), async () => html)
    assert.equal(r.status, 500, html)
    assert.equal(await r.text(), '', html)
  }
})

test('erro inesperado vira 500 sem corpo e sem vazar a mensagem', async () => {
  const r = await responderFragmento(pedido(), async () => { throw new Error('ECONNREFUSED dominio-c 10.0.0.3') })
  assert.equal(r.status, 500)
  assert.equal(await r.text(), '')
})

test('navegacao direta do navegador nao alcanca o fragmento: 404', async () => {
  let rodou = false
  for (const dest of ['document', 'iframe', 'frame', 'embed', 'object']) {
    const r = await responderFragmento(pedido({ 'sec-fetch-dest': dest }), async () => { rodou = true; return '<p>x</p>' })
    assert.equal(r.status, 404, dest)
  }
  assert.equal(rodou, false, 'produziu o fragmento para uma navegacao direta')
  const ok = await responderFragmento(pedido({ 'sec-fetch-dest': 'empty' }), async () => '<p>x</p>')
  assert.equal(ok.status, 200)
})

test('versao de contrato desconhecida: 204 sem produzir', async () => {
  let rodou = false
  const r = await responderFragmento(pedido({ 'accept-fragmento-versao': '2' }), async () => { rodou = true; return '<p>x</p>' })
  assert.equal(r.status, 204)
  assert.equal(rodou, false)
  assert.equal((await responderFragmento(pedido({ 'accept-fragmento-versao': '1' }), async () => '<p>x</p>')).status, 200)
})

test('dono e consumidor juntos: o consumidor recebe o que o dono respondeu', async () => {
  const f = criarFragmento(cfg({
    fetch: async (url, init) => responderFragmento(new Request(url, init), async () => '<p>bloco</p>'),
  }))
  assert.equal(await f.buscar('zona2', 'tarefa', 't-1'), '<p>bloco</p>')
  const nega = criarFragmento(cfg({
    fetch: async (url, init) => responderFragmento(new Request(url, init), async () => { throw new NaoEncontrado() }),
  }))
  assert.equal(await nega.buscar('zona2', 'tarefa', 't-1'), null)
})

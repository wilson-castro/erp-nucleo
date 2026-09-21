import { test as testNode, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { criarTransporte, validarRegistro, DestinoInvalido } from '../dist/interno/destinos.js'
import { ErroDeAplicacao, SessaoInvalida } from '../dist/interno/erros.js'

// Timeout por teste e fechamento garantido: um assert que falha não pode deixar a suíte pendurada.
const test = (nome, fn) => testNode(nome, { timeout: 5000 }, fn)
const abertos = []
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close() } })

/** Servidor REAL que registra o que recebeu. Sem ele, um teste passaria por ECONNREFUSED. */
async function servidor(responder = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) {
  const recebidas = []
  const s = createServer((req, res) => { recebidas.push({ metodo: req.method, url: req.url, headers: req.headers }); responder(req, res) })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  abertos.push(s)
  return { origem: `http://127.0.0.1:${s.address().port}`, recebidas, fechar: () => s.close() }
}

/** Uma aplicação com dois domínios, como a zona 1. */
function registro(a, b) {
  return {
    'dominio-a': { origem: a, caminhos: ['/v1/recursos', '/v1/recursos/:id'], metodos: ['GET'], credencial: 'usuario' },
    'dominio-b': { origem: b, caminhos: ['/v1/itens/:id'], metodos: ['GET', 'POST', 'PUT'], credencial: 'usuario', timeoutMs: 300 },
  }
}

function transporte(reg, extra = {}) {
  let chamadasDeRede = 0
  const destino = criarTransporte({
    app: 'zona-teste', registro: reg, obterToken: async () => 'token-do-usuario',
    fetch: (...a) => { chamadasDeRede++; return fetch(...a) }, ...extra,
  })
  return { destino, chamadasDeRede: () => chamadasDeRede }
}

test('cenario 1: zona com dois dominios; caminho nao declarado falha com DestinoInvalido sem sair da rede', async () => {
  const a = await servidor(); const b = await servidor()
  const { destino, chamadasDeRede } = transporte(registro(a.origem, b.origem))
  await destino('dominio-a').get('/v1/recursos/:id', { params: { id: 'r-1' } })
  await destino('dominio-b').get('/v1/itens/:id', { params: { id: '7' } })
  assert.equal(chamadasDeRede(), 2)

  await assert.rejects(() => destino('dominio-a').get('/v1/admin'), DestinoInvalido)
  await assert.rejects(() => destino('dominio-a').get('/v1/itens/:id', { params: { id: '7' } }), DestinoInvalido,
    'modelo de outro destino')
  await assert.rejects(() => destino('dominio-c').get('/v1/recursos'), DestinoInvalido, 'destino nao registrado')
  assert.equal(chamadasDeRede(), 2, 'nenhuma chamada recusada chegou a rede')
  assert.deepEqual(a.recebidas.map((r) => r.url), ['/v1/recursos/r-1'])
  assert.deepEqual(b.recebidas.map((r) => r.url), ['/v1/itens/7'])
  a.fechar(); b.fechar()
})

// Valores que o núcleo TEM de recusar antes da rede: tirariam a chamada do modelo.
for (const [caso, id] of [
  ['segmento ponto', '.'], ['segmento ponto-ponto', '..'], ['vazio', ''],
  ['byte de controle TAB', 'a\tb'], ['byte de controle LF', 'a\nb'], ['byte nulo', 'a\u0000'],
  ['longo demais', 'x'.repeat(257)],
]) {
  test(`parametro hostil (${caso}) e recusado com DestinoInvalido, sem rede`, async () => {
    const a = await servidor()
    const { destino, chamadasDeRede } = transporte(registro(a.origem, a.origem))
    await assert.rejects(() => destino('dominio-a').get('/v1/recursos/:id', { params: { id } }), DestinoInvalido)
    assert.equal(chamadasDeRede(), 0)
  })
}

// Valores que viram UM segmento codificado: chegam ao domínio exatamente dentro do modelo.
for (const [caso, id] of [
  ['barra dupla', '//evil.com'], ['barra', 'a/b'], ['barra invertida', '\\evil.com'],
  ['URL absoluta', 'http://evil.com/x'], ['ponto-ponto codificado', '%2e%2e'],
]) {
  test(`parametro hostil (${caso}) vira um segmento codificado, na origem declarada`, async () => {
    const a = await servidor()
    const { destino } = transporte(registro(a.origem, a.origem))
    await destino('dominio-a').get('/v1/recursos/:id', { params: { id } })
    assert.deepEqual(a.recebidas.map((r) => r.url), [`/v1/recursos/${encodeURIComponent(id)}`])
  })
}

test('metodo nao declarado e recusado sem rede', async () => {
  const a = await servidor()
  const { destino, chamadasDeRede } = transporte(registro(a.origem, a.origem))
  await assert.rejects(() => destino('dominio-a').post('/v1/recursos'), DestinoInvalido)
  assert.equal(chamadasDeRede(), 0)
  a.fechar()
})

test('PUT sem If-Match e recusado (invariante 6); com If-Match passa e envia o cabecalho', async () => {
  const b = await servidor()
  const { destino } = transporte(registro(b.origem, b.origem))
  await assert.rejects(() => destino('dominio-b').put('/v1/itens/:id', { params: { id: '1' }, corpo: {} }), DestinoInvalido)
  await destino('dominio-b').put('/v1/itens/:id', { params: { id: '1' }, corpo: { x: 1 }, ifMatch: '"3"' })
  assert.equal(b.recebidas[0].headers['if-match'], '"3"')
  b.fechar()
})

test('parametro que o modelo nao pede e recusado', async () => {
  const a = await servidor()
  const { destino } = transporte(registro(a.origem, a.origem))
  await assert.rejects(() => destino('dominio-a').get('/v1/recursos', { params: { id: '1' } }), DestinoInvalido)
  a.fechar()
})

test('o nucleo injeta credencial e chamador; o retorno nao carrega o token', async () => {
  const a = await servidor()
  const { destino } = transporte(registro(a.origem, a.origem))
  const r = await destino('dominio-a').get('/v1/recursos')
  assert.equal(a.recebidas[0].headers.authorization, 'Bearer token-do-usuario')
  assert.equal(a.recebidas[0].headers['x-erp-chamador'], 'zona-teste')
  assert.ok(!JSON.stringify(r).includes('token-do-usuario'))
  a.fechar()
})

test('credencial servico usa o token de servico, e sem ele nao sai', async () => {
  const a = await servidor()
  const reg = { reg: { origem: a.origem, caminhos: ['/v1/manifestos'], metodos: ['POST'], credencial: 'servico' } }
  await assert.rejects(() => transporte(reg).destino('reg').post('/v1/manifestos', { corpo: {} }), SessaoInvalida)
  await transporte(reg, { tokenDeServico: () => 'svc' }).destino('reg').post('/v1/manifestos', { corpo: {} })
  assert.equal(a.recebidas.length, 1)
  assert.equal(a.recebidas[0].headers.authorization, 'Bearer svc')
  a.fechar()
})

test('credencial nenhuma nao manda Authorization', async () => {
  const a = await servidor()
  const reg = { pub: { origem: a.origem, caminhos: ['/v1/saude'], metodos: ['GET'], credencial: 'nenhuma' } }
  await transporte(reg).destino('pub').get('/v1/saude')
  assert.equal(a.recebidas[0].headers.authorization, undefined)
  a.fechar()
})

test('redirecionamento do dominio nao e seguido para fora do registro', async () => {
  const fora = await servidor()
  const a = await servidor((req, res) => { res.writeHead(302, { location: `${fora.origem}/roubar` }); res.end() })
  const { destino } = transporte(registro(a.origem, a.origem))
  await assert.rejects(() => destino('dominio-a').get('/v1/recursos'), ErroDeAplicacao)
  assert.equal(fora.recebidas.length, 0, 'o BFF seguiu o redirect')
  a.fechar(); fora.fechar()
})

test('timeout do destino vira ERRO_INTERNO sem detalhe', async () => {
  const b = await servidor(() => { /* nunca responde */ })
  const { destino } = transporte(registro(b.origem, b.origem))
  await assert.rejects(() => destino('dominio-b').get('/v1/itens/:id', { params: { id: '1' } }),
    (e) => e instanceof ErroDeAplicacao && e.codigo === 'ERRO_INTERNO' && !/timeout|abort/i.test(e.message))
  b.fechar()
})

for (const [caso, d] of [
  ['origem com caminho', { origem: 'http://h:1/api' }],
  ['origem com credencial', { origem: 'http://u:p@h:1' }],
  ['origem com esquema estranho', { origem: 'file:///etc' }],
  ['caminho relativo', { caminhos: ['v1/x'] }],
  ['caminho com ponto-ponto', { caminhos: ['/v1/../x'] }],
  ['caminho com barra dupla', { caminhos: ['/v1//x'] }],
  ['metodo inventado', { metodos: ['TRACE'] }],
  ['sem caminhos', { caminhos: [] }],
  ['credencial inventada', { credencial: 'root' }],
]) {
  test(`registro invalido e recusado no boot: ${caso}`, () => {
    const base = { origem: 'http://127.0.0.1:1', caminhos: ['/v1/x'], metodos: ['GET'], credencial: 'usuario' }
    assert.throws(() => validarRegistro({ d: { ...base, ...d } }), /registro de destinos/)
  })
}

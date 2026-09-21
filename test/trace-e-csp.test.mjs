// Núcleo 8 (trace contínuo sem dado pessoal) e a CSP como função pura (ADR-0012, passo 1).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { garantirTraceparent, filhoDe, TRACEPARENT } from '../dist/borda/trace.js'
import { politicaDeSeguranca } from '../dist/borda/csp.js'
import { criarTransporte } from '../dist/interno/destinos.js'

const abertos = []
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close() } })

test('traceparent valido que chega do navegador e mantido', () => {
  const t = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  assert.equal(garantirTraceparent(t), t)
})

test('traceparent ausente, malformado ou com trace zerado vira um novo, valido', () => {
  for (const ruim of [undefined, null, '', 'lixo', '00-ana-00f067aa0ba902b7-01',
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01']) {
    const t = garantirTraceparent(ruim)
    assert.match(t, TRACEPARENT, String(ruim))
    assert.notEqual(t, ruim)
  }
})

test('dois traces novos nunca coincidem', () => {
  assert.notEqual(garantirTraceparent(undefined), garantirTraceparent(undefined))
})

test('filho: mesmo trace, span novo, mesma amostragem', () => {
  const pai = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  const f = filhoDe(pai)
  assert.match(f, TRACEPARENT)
  assert.equal(f.split('-')[1], pai.split('-')[1])
  assert.notEqual(f.split('-')[2], pai.split('-')[2])
  assert.equal(f.split('-')[3], '01')
})

async function dominio() {
  const recebidas = []
  const s = createServer((req, res) => { recebidas.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); abertos.push(s)
  return { origem: `http://127.0.0.1:${s.address().port}`, recebidas }
}

test('toda chamada ao dominio leva traceparent filho do trace da requisicao', async () => {
  const d = await dominio()
  const pai = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  const destino = criarTransporte({
    app: 'z', registro: { a: { origem: d.origem, caminhos: ['/v1/x'], metodos: ['GET'], credencial: 'nenhuma' } },
    obterToken: async () => 't', lerTraceparent: async () => pai,
  })
  await destino('a').get('/v1/x'); await destino('a').get('/v1/x')
  const [t1, t2] = d.recebidas.map((h) => h.traceparent)
  for (const t of [t1, t2]) { assert.match(t, TRACEPARENT); assert.equal(t.split('-')[1], pai.split('-')[1]) }
  assert.notEqual(t1, t2, 'duas chamadas, dois spans')
})

test('sem trace na requisicao, a chamada abre um trace novo; nada de dado pessoal no cabecalho', async () => {
  const d = await dominio()
  const destino = criarTransporte({
    app: 'z', registro: { a: { origem: d.origem, caminhos: ['/v1/x'], metodos: ['GET'], credencial: 'usuario' } },
    obterToken: async () => 'dev.ana.123',
  })
  await destino('a').get('/v1/x')
  const t = d.recebidas[0].traceparent
  assert.match(t, TRACEPARENT)
  assert.ok(!/ana|dev\./.test(t), 'identidade no traceparent')
})

test('traceparent forjado pelo cliente com texto nao chega ao dominio', async () => {
  const d = await dominio()
  const destino = criarTransporte({
    app: 'z', registro: { a: { origem: d.origem, caminhos: ['/v1/x'], metodos: ['GET'], credencial: 'nenhuma' } },
    obterToken: async () => 't', lerTraceparent: async () => '00-ana@email.com-x-01',
  })
  await destino('a').get('/v1/x')
  assert.match(d.recebidas[0].traceparent, TRACEPARENT)
})

test('politicaDeSeguranca: a mesma CSP para shell e zonas, com o nonce', () => {
  const c = politicaDeSeguranca('abc123')
  for (const d of ["default-src 'self'", "script-src 'self' 'nonce-abc123' 'strict-dynamic'", "style-src 'self' 'nonce-abc123'",
    "img-src 'self' data:", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(c.includes(d), `falta ${d}`)
  }
})

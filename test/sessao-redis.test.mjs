import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessaoRedis, sessaoRedisDeEscrita } from '../dist/adaptadores/sessao-redis.js'
import { identidadeDev } from '../dist/adaptadores/identidade-dev.js'
import { criarNucleo, criarNucleoDoShell } from '../dist/fabricas/criarNucleo.js'
import { acessoFake } from '../dist/testing/index.js'
import { ErroDeAplicacao } from '../dist/interno/erros.js'

/** Redis falso com a mesma assinatura do node-redis (`set(k, v, { PX })`) e TTL de verdade. */
function redisFalso({ agora = () => Date.now() } = {}) {
  const dados = new Map()
  const chamadas = []
  return {
    dados, chamadas,
    async get(k) {
      chamadas.push(['get', k])
      const e = dados.get(k)
      if (!e) return null
      if (agora() >= e.expira) { dados.delete(k); return null }
      return e.valor
    },
    async set(k, valor, op) {
      chamadas.push(['set', k, op])
      dados.set(k, { valor, expira: agora() + op.PX })
      return 'OK'
    },
    async del(k) { chamadas.push(['del', k]); return dados.delete(k) ? 1 : 0 },
  }
}

const viva = (sub, ms = 60_000) => ({ sub, nome: sub, accessToken: `tk-${sub}`, expiraEm: Date.now() + ms })

test('a sessao gravada pelo escritor e lida pelo leitor', async () => {
  const r = redisFalso()
  await sessaoRedisDeEscrita({ cliente: r }).gravar('sid-1', viva('ana'))
  assert.equal((await sessaoRedis({ cliente: r }).ler('sid-1')).sub, 'ana')
})

test('o id da sessao nunca vira chave crua: prefixo + sha256', async () => {
  const r = redisFalso()
  await sessaoRedisDeEscrita({ cliente: r }).gravar('sid-secreto', viva('ana'))
  const [chave] = [...r.dados.keys()]
  assert.match(chave, /^erp:sessao:[0-9a-f]{64}$/)
  assert.ok(!chave.includes('sid-secreto'))
})

test('o prefixo e configuravel, para dividir uma instancia entre ambientes', async () => {
  const r = redisFalso()
  await sessaoRedisDeEscrita({ cliente: r, prefixo: 'hml:sessao:' }).gravar('x', viva('ana'))
  assert.match([...r.dados.keys()][0], /^hml:sessao:[0-9a-f]{64}$/)
  assert.equal((await sessaoRedis({ cliente: r, prefixo: 'hml:sessao:' }).ler('x')).sub, 'ana')
  assert.equal(await sessaoRedis({ cliente: r }).ler('x'), null)
})

test('o TTL no Redis acompanha a expiracao da sessao', async () => {
  const r = redisFalso()
  await sessaoRedisDeEscrita({ cliente: r }).gravar('s', viva('ana', 30_000))
  const [, , op] = r.chamadas.find(([c]) => c === 'set')
  assert.ok(op.PX > 29_000 && op.PX <= 30_000, `PX=${op.PX}`)
})

test('sessao ja expirada nao e gravada e apaga a anterior', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r })
  await esc.gravar('s', viva('ana'))
  await esc.gravar('s', viva('ana', -1))
  assert.equal(r.dados.size, 0)
  assert.equal(r.chamadas.filter(([c]) => c === 'set').length, 1)
})

test('o Redis expira a chave sozinho: depois do TTL a leitura e ausente', async () => {
  let t = 1_000_000
  const r = redisFalso({ agora: () => t })
  await sessaoRedisDeEscrita({ cliente: r }).gravar('s', { sub: 'ana', nome: 'ana', accessToken: 'tk', expiraEm: Date.now() + 5_000 })
  t += 6_000
  assert.equal(await sessaoRedis({ cliente: r }).ler('s'), null)
})

test('remover apaga a sessao em todas as leituras seguintes', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r })
  await esc.gravar('s', viva('ana'))
  await esc.remover('s')
  assert.equal(await sessaoRedis({ cliente: r }).ler('s'), null)
})

test('o leitor nao tem como gravar nem remover (N3, invariante 15)', () => {
  assert.deepEqual(Object.keys(sessaoRedis({ cliente: redisFalso() })), ['ler'])
})

test('valor corrompido ou com forma errada e sessao ausente, nao excecao', async () => {
  const r = redisFalso()
  const leitor = sessaoRedis({ cliente: r })
  const esc = sessaoRedisDeEscrita({ cliente: r })
  await esc.gravar('s', viva('ana'))
  const chave = [...r.dados.keys()][0]
  for (const lixo of ['{', 'null', '42', '"texto"', '[]', '{"sub":"ana"}',
    '{"sub":1,"nome":"a","accessToken":"t","expiraEm":9e15}',
    '{"sub":"a","nome":"a","accessToken":"t","expiraEm":"amanha"}']) {
    r.dados.set(chave, { valor: lixo, expira: Infinity })
    assert.equal(await leitor.ler('s'), null, lixo)
  }
})

test('id vazio ou que nao e texto nao chega ao Redis', async () => {
  const r = redisFalso()
  const leitor = sessaoRedis({ cliente: r })
  for (const id of ['', undefined, null, 42]) assert.equal(await leitor.ler(id), null)
  assert.equal(r.chamadas.length, 0)
})

test('Redis fora do ar vira erro normalizado, sem vazar o motivo (invariante 12)', async () => {
  const quebrado = {
    async get() { throw new Error('ECONNREFUSED 10.0.0.7:6379 senha=hunter2') },
    async set() { throw new Error('ECONNREFUSED 10.0.0.7:6379') },
    async del() { throw new Error('ECONNREFUSED 10.0.0.7:6379') },
  }
  for (const f of [
    () => sessaoRedis({ cliente: quebrado }).ler('s'),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).gravar('s', viva('ana')),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).remover('s'),
  ]) {
    await assert.rejects(f, (e) => {
      assert.ok(e instanceof ErroDeAplicacao)
      assert.equal(e.codigo, 'ERRO_INTERNO')
      assert.ok(!/ECONNREFUSED|hunter2|6379/.test(`${e.message}${e.stack}`), 'motivo vazou')
      return true
    })
  }
})

test('shell grava pelo Redis e a zona le a mesma sessao, sem token na leitura publica', async () => {
  const r = redisFalso()
  let cookie
  const shell = criarNucleoDoShell({
    app: 'shell', sessao: sessaoRedis({ cliente: r }), destinos: {}, acesso: acessoFake({ modulos: [], administra: false }),
    lerCookieDeSessao: async () => cookie,
    escrita: { store: sessaoRedisDeEscrita({ cliente: r }), identidade: identidadeDev() },
  })
  cookie = await shell.sessao.entrar({ usuario: 'bruno' })
  const zona = criarNucleo({
    app: 'zona', sessao: sessaoRedis({ cliente: r }), destinos: {}, acesso: acessoFake({ modulos: [], administra: false }),
    lerCookieDeSessao: async () => cookie,
  })
  assert.deepEqual(await zona.sessao.atual(), { sub: 'bruno', nome: 'Bruno Analista' })
  await shell.sessao.encerrar(cookie)
  assert.equal(await zona.sessao.atual(), null)
})

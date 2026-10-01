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
      // NX: só grava se a chave não existe (ou já venceu), e então o Redis responde null
      if (op.NX) {
        const e = dados.get(k)
        if (e && agora() < e.expira) return null
      }
      // XX: só grava se a chave existe e não venceu
      if (op.XX) {
        const e = dados.get(k)
        if (!e || agora() >= e.expira) return null
      }
      dados.set(k, { valor, expira: agora() + op.PX })
      return 'OK'
    },
    async del(k) { chamadas.push(['del', k]); return dados.delete(k) ? 1 : 0 },
    // GETDEL é atômico no Redis: o falso não tem await entre ler e apagar
    async getDel(k) {
      chamadas.push(['getDel', k])
      const e = dados.get(k)
      dados.delete(k)
      if (!e || agora() >= e.expira) return null
      return e.valor
    },
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
    async getDel() { throw new Error('ECONNREFUSED 10.0.0.7:6379') },
  }
  const tx = { id: 't', state: 's', codeVerifier: 'v', nonce: 'n', destino: '/', expiraEm: Date.now() + 60_000 }
  for (const f of [
    () => sessaoRedis({ cliente: quebrado }).ler('s'),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).gravar('s', viva('ana')),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).remover('s'),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).regravar('s', viva('ana')),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).gravarTransacao(tx),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).consumirTransacao('t'),
    () => sessaoRedisDeEscrita({ cliente: quebrado }).adquirirLockRenovacao('s', 1_000),
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
  const { url, idTransacao } = await shell.sessao.iniciarLogin('/')
  const state = new URL(url, 'http://shell.invalid').searchParams
  cookie = (await shell.sessao.concluirLogin(idTransacao, { state: state.get('state'), nonce: state.get('nonce'), usuario: 'bruno' })).id
  const zona = criarNucleo({
    app: 'zona', sessao: sessaoRedis({ cliente: r }), destinos: {}, acesso: acessoFake({ modulos: [], administra: false }),
    lerCookieDeSessao: async () => cookie,
  })
  assert.deepEqual(await zona.sessao.atual(), { sub: 'bruno', nome: 'Bruno Analista' })
  await shell.sessao.encerrarSessao(cookie)
  assert.equal(await zona.sessao.atual(), null)
})

test('valor no Redis sem sujeito ou sem token e dado corrompido: lido como ausente', async () => {
  const r = redisFalso()
  const escritor = sessaoRedisDeEscrita({ cliente: r })
  const leitor = sessaoRedis({ cliente: r })
  for (const [id, s] of [['sem-token', { ...viva('ana'), accessToken: '' }], ['sem-sub', { ...viva('ana'), sub: '' }]]) {
    await escritor.gravar(id, s)
    assert.equal(await leitor.ler(id), null, id)
  }
})

test('o leitor funciona com um cliente que so tem get (o das zonas: auditor_b1_d1_2, V1)', async () => {
  const r = redisFalso()
  await sessaoRedisDeEscrita({ cliente: r }).gravar('sid-leitura', viva('ana'))
  const soLeitura = { get: (k) => r.get(k) }
  assert.equal((await sessaoRedis({ cliente: soLeitura }).ler('sid-leitura')).sub, 'ana')
})

// --- D2: lock de renovação e transação de login (ADR-0013, decisões 3 e 4) ----------------------

const transacao = (extra = {}) => ({
  id: 'tx-secreta', state: 'st', codeVerifier: 'verificador-pkce', nonce: 'nc', destino: '/zona1', expiraEm: Date.now() + 60_000, ...extra,
})

test('adquirirLockRenovacao: o primeiro ganha, o segundo perde enquanto o TTL vale, e o lock vence sozinho', async () => {
  let t = 1_000_000
  const r = redisFalso({ agora: () => t })
  const esc = sessaoRedisDeEscrita({ cliente: r })
  assert.equal(await esc.adquirirLockRenovacao('sid', 15_000), true)
  assert.equal(await esc.adquirirLockRenovacao('sid', 15_000), false)
  assert.equal(await esc.adquirirLockRenovacao('outra', 15_000), true, 'o lock e por sessao')
  t += 14_999
  assert.equal(await esc.adquirirLockRenovacao('sid', 15_000), false)
  t += 2
  assert.equal(await esc.adquirirLockRenovacao('sid', 15_000), true, 'nao ha liberacao explicita: o TTL libera')
})

test('adquirirLockRenovacao usa SET NX PX, com chave por hash fora do prefixo de sessao', async () => {
  const r = redisFalso()
  await sessaoRedisDeEscrita({ cliente: r }).adquirirLockRenovacao('sid-secreto', 15_000)
  const [, chave, op] = r.chamadas.find(([c]) => c === 'set')
  assert.deepEqual(op, { PX: 15_000, NX: true })
  assert.match(chave, /^erp:renovacao:[0-9a-f]{64}$/)
  assert.ok(!chave.includes('sid-secreto'))
  assert.equal(r.chamadas.filter(([c]) => c === 'del').length, 0, 'o lock nunca e liberado explicitamente')
})

test('20 pedidos de lock concorrentes no Redis: exatamente um ganha', async () => {
  const esc = sessaoRedisDeEscrita({ cliente: redisFalso() })
  const r = await Promise.all(Array.from({ length: 20 }, () => esc.adquirirLockRenovacao('sid', 15_000)))
  assert.equal(r.filter(Boolean).length, 1)
})

test('TTL de lock invalido e erro de programacao, nao lock eterno', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r })
  for (const ttl of [0, -1, 1.5, NaN, Infinity, '15000']) {
    await assert.rejects(() => esc.adquirirLockRenovacao('sid', ttl), TypeError, String(ttl))
  }
  assert.equal(r.chamadas.length, 0)
})

test('transacao de login: gravada com TTL da propria validade e consumida uma vez so, por GETDEL', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r })
  await esc.gravarTransacao(transacao({ expiraEm: Date.now() + 30_000 }))
  const [, chave, op] = r.chamadas.find(([c]) => c === 'set')
  assert.match(chave, /^erp:login:[0-9a-f]{64}$/)
  assert.ok(!chave.includes('tx-secreta'))
  assert.ok(op.PX > 29_000 && op.PX <= 30_000, `PX=${op.PX}`)
  const r1 = await Promise.all(Array.from({ length: 10 }, () => esc.consumirTransacao('tx-secreta')))
  assert.equal(r1.filter(Boolean).length, 1)
  assert.equal(r1.find(Boolean).codeVerifier, 'verificador-pkce')
  assert.equal(await esc.consumirTransacao('tx-secreta'), null)
  assert.ok(r.chamadas.some(([c]) => c === 'getDel'))
  assert.ok(!r.chamadas.some(([c]) => c === 'get'), 'consumir com GET + DEL separados nao e atomico')
})

test('transacao vencida, ausente ou corrompida nao e devolvida', async () => {
  let t = 1_000_000
  const r = redisFalso({ agora: () => t })
  const esc = sessaoRedisDeEscrita({ cliente: r })
  await esc.gravarTransacao(transacao({ id: 'curta', expiraEm: Date.now() + 5_000 }))
  t += 6_000
  assert.equal(await esc.consumirTransacao('curta'), null)
  await esc.gravarTransacao(transacao({ id: 'ja-vencida', expiraEm: Date.now() - 1 }))
  assert.equal(r.dados.size, 0, 'transacao vencida nao e gravada')
  for (const id of ['', undefined, 42]) assert.equal(await esc.consumirTransacao(id), null)
  await esc.gravarTransacao(transacao({ id: 'lixo' }))
  for (const lixo of ['{', 'null', '{"id":"lixo"}', '{"id":"lixo","state":"s","codeVerifier":"v","nonce":"n","destino":"/","expiraEm":"amanha"}']) {
    r.dados.set([...r.dados.keys()][0], { valor: lixo, expira: Infinity })
    assert.equal(await esc.consumirTransacao('lixo'), null, lixo)
    await esc.gravarTransacao(transacao({ id: 'lixo' }))
  }
})

test('a zona nao le transacao nem lock: as chaves ficam fora de erp:sessao:* (ACL do usuario zona)', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r })
  await esc.gravarTransacao(transacao())
  await esc.adquirirLockRenovacao('sid', 15_000)
  for (const chave of r.dados.keys()) assert.ok(!chave.startsWith('erp:sessao:'), chave)
  assert.equal(await sessaoRedis({ cliente: r }).ler('tx-secreta'), null)
})

test('prefixos de login e de lock configuraveis, e recusados se cairem dentro do prefixo de sessao', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r, prefixo: 'hml:sessao:', prefixoLogin: 'hml:login:', prefixoLock: 'hml:renovacao:' })
  await esc.gravarTransacao(transacao())
  await esc.adquirirLockRenovacao('sid', 15_000)
  assert.deepEqual([...r.dados.keys()].map((k) => k.replace(/[0-9a-f]{64}$/, '')).sort(), ['hml:login:', 'hml:renovacao:'])
  for (const cfg of [{ prefixoLogin: 'erp:sessao:login:' }, { prefixoLock: 'erp:sessao:' }, { prefixo: 'erp:', prefixoLock: 'erp:lock:' }]) {
    assert.throws(() => sessaoRedisDeEscrita({ cliente: r, ...cfg }), /prefixo/, JSON.stringify(cfg))
  }
})

test('regravar usa SET XX PX: grava sessao existente e nao ressuscita sessao removida', async () => {
  const r = redisFalso()
  const esc = sessaoRedisDeEscrita({ cliente: r })
  const leitor = sessaoRedis({ cliente: r })
  assert.equal(await esc.regravar('nunca', viva('ana')), false)
  assert.equal(await leitor.ler('nunca'), null)
  await esc.gravar('s', viva('ana'))
  assert.equal(await esc.regravar('s', { ...viva('ana'), accessToken: 'tk-novo' }), true)
  assert.equal((await leitor.ler('s')).accessToken, 'tk-novo')
  const [, , op] = r.chamadas.filter(([c]) => c === 'set').at(-1)
  assert.equal(op.XX, true)
  await esc.remover('s')
  assert.equal(await esc.regravar('s', viva('ana')), false)
  assert.equal(await leitor.ler('s'), null)
})

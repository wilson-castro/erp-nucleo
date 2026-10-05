import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { identidadeDev, ATORES_DE_DESENVOLVIMENTO } from '../dist/adaptadores/identidade-dev.js'
import { sessaoArquivo, sessaoArquivoDeEscrita } from '../dist/adaptadores/sessao-arquivo.js'
import { criarNucleoDoShell } from '../dist/fabricas/criarNucleo.js'
import { acessoFake, sessaoMemoria } from '../dist/testing/index.js'
import { sessaoRedis, sessaoRedisDeEscrita } from '../dist/adaptadores/sessao-redis.js'
import { novaTransacao } from '../dist/interno/login.js'
import { comSorteiosRegistrados, conferirQuatroSorteios, conferirSegredosForaDoPublico } from './apoio-transacao.mjs'

/** O retorno que a etapa de login de desenvolvimento manda ao shell (contrato no comentário de identidade-dev.ts). */
const retornoDe = (url, usuario) => {
  const u = new URL(url, 'http://shell.invalid')
  return { state: u.searchParams.get('state'), nonce: u.searchParams.get('nonce'), usuario }
}

// --- porta: identidadeDev -----------------------------------------------------------------------

test('iniciar devolve url e transacao com segredos aleatorios e unicos a cada chamada', async () => {
  const idp = identidadeDev()
  const a = await idp.iniciar('/zona1')
  const b = await idp.iniciar('/zona1')
  for (const campo of ['id', 'state', 'codeVerifier', 'nonce']) {
    assert.equal(typeof a.transacao[campo], 'string', campo)
    assert.ok(a.transacao[campo].length >= 43, `${campo} curto demais: ${a.transacao[campo]}`)
    assert.notEqual(a.transacao[campo], b.transacao[campo], `${campo} repetido`)
  }
  assert.notEqual(a.url, b.url)
  assert.equal(a.transacao.destino, '/zona1')
  assert.ok(a.transacao.expiraEm > Date.now())
  const u = new URL(a.url, 'http://shell.invalid')
  assert.equal(u.pathname, '/login/dev')
  assert.equal(u.searchParams.get('state'), a.transacao.state)
  assert.ok(!a.url.includes(a.transacao.codeVerifier), 'o code_verifier nao pode ir ao navegador')
  // o id (cookie __Host-erp-login) e opaco: nao e o state nem o nonce, e nao vai na URL (ADR-0013, decisao 3)
  const { id, state, nonce, codeVerifier } = a.transacao
  assert.equal(new Set([id, state, nonce, codeVerifier]).size, 4, 'id, state, nonce e code_verifier precisam ser independentes')
  assert.ok(!a.url.includes(id), 'o id da transacao nao pode ir na URL')
})

// O id (cookie __Host-erp-login) e o code_verifier são segredos; state e nonce vão na URL. Valores só
// diferentes entre si não bastam: `id = sha256(state)` ou `codeVerifier = state + '.x'` são diferentes e
// calculáveis por quem vê a URL de retorno. Os quatro precisam ser sorteios independentes (auditor_d2_2).
test('novaTransacao: id, state, codeVerifier e nonce sao quatro sorteios independentes de 32 bytes ou mais', async () => {
  const { resultado: t, sorteios } = await comSorteiosRegistrados(() => novaTransacao('/zona1', 60_000))
  conferirQuatroSorteios(t, sorteios)
  assert.equal(sorteios.length, 4, `sorteios feitos: ${sorteios.length}`)
})

test('identidadeDev.iniciar: os quatro valores da transacao sao sorteios independentes e os segredos nao saem da URL', async () => {
  const { resultado: { url, transacao }, sorteios } = await comSorteiosRegistrados(() => identidadeDev().iniciar('/zona1'))
  conferirQuatroSorteios(transacao, sorteios)
  conferirSegredosForaDoPublico(transacao, url)
})

test('iniciar so aceita destino interno: o resto vira "/" (redirecionamento aberto)', async () => {
  const idp = identidadeDev()
  for (const ruim of [undefined, '', 'https://mal.example', '//mal.example', '/\\mal.example', 'zona1', '/a\nb']) {
    assert.equal((await idp.iniciar(ruim)).transacao.destino, '/', String(ruim))
  }
})

test('a transacao de login vale ERP_LOGIN_TRANSACAO_S (padrao 600 s) e valor invalido e erro na subida', async () => {
  const antes = process.env.ERP_LOGIN_TRANSACAO_S
  try {
    delete process.env.ERP_LOGIN_TRANSACAO_S
    let t = (await identidadeDev().iniciar()).transacao
    assert.ok(Math.abs(t.expiraEm - Date.now() - 600_000) < 2_000, `expiraEm=${t.expiraEm}`)
    process.env.ERP_LOGIN_TRANSACAO_S = '90'
    t = (await identidadeDev().iniciar()).transacao
    assert.ok(Math.abs(t.expiraEm - Date.now() - 90_000) < 2_000, `expiraEm=${t.expiraEm}`)
    for (const ruim of ['0', '-1', 'dez', '3601']) {
      process.env.ERP_LOGIN_TRANSACAO_S = ruim
      assert.throws(() => identidadeDev(), /ERP_LOGIN_TRANSACAO_S/, ruim)
    }
  } finally {
    if (antes === undefined) delete process.env.ERP_LOGIN_TRANSACAO_S
    else process.env.ERP_LOGIN_TRANSACAO_S = antes
  }
})

test('concluir aceita o retorno valido e monta a sessao do ator escolhido', async () => {
  const idp = identidadeDev()
  for (const usuario of ATORES_DE_DESENVOLVIMENTO) {
    const { url, transacao } = await idp.iniciar('/')
    const s = await idp.concluir(retornoDe(url, usuario), transacao)
    assert.equal(s.sub, usuario)
    assert.ok(s.nome.length > 0)
    assert.ok(s.accessToken.length > 0)
    assert.ok(s.refreshToken.length > 0)
    assert.ok(s.tokenExpiraEm > Date.now() && s.tokenExpiraEm <= s.expiraEm)
  }
})

test('concluir recusa state ou nonce adulterados, ausentes ou de outra transacao', async () => {
  const idp = identidadeDev()
  const { url, transacao } = await idp.iniciar('/')
  const outra = await idp.iniciar('/')
  const ok = retornoDe(url, 'ana')
  for (const [nome, p] of [
    ['state trocado', { ...ok, state: outra.transacao.state }],
    ['state com um caractere a mais', { ...ok, state: ok.state + 'x' }],
    ['nonce trocado', { ...ok, nonce: outra.transacao.nonce }],
    ['sem state', { nonce: ok.nonce, usuario: 'ana' }],
    ['sem nonce', { state: ok.state, usuario: 'ana' }],
    ['state que nao e texto', { ...ok, state: 42 }],
  ]) {
    assert.equal(await idp.concluir(p, transacao), null, nome)
  }
  // a transacao certa continua funcionando: a recusa acima nao foi por outro motivo
  assert.equal((await idp.concluir(ok, transacao)).sub, 'ana')
})

test('concluir recusa ator desconhecido e transacao vencida', async () => {
  const idp = identidadeDev()
  const { url, transacao } = await idp.iniciar('/')
  for (const u of ['ninguem', '__proto__', 'constructor', 'toString', undefined]) {
    assert.equal(await idp.concluir(retornoDe(url, u), transacao), null, String(u))
  }
  assert.equal(await idp.concluir(retornoDe(url, 'ana'), { ...transacao, expiraEm: Date.now() - 1 }), null)
})

test('renovar devolve renovada com token e prazos novos, e o refresh token gira', async () => {
  const idp = identidadeDev()
  const { url, transacao } = await idp.iniciar('/')
  const s = await idp.concluir(retornoDe(url, 'bruno'), transacao)
  const velha = { ...s, tokenExpiraEm: Date.now() + 1_000, expiraEm: Date.now() + 5_000 }
  const r = await idp.renovar(velha)
  assert.equal(r.status, 'renovada')
  assert.equal(r.sessao.sub, 'bruno')
  assert.equal(r.sessao.nome, s.nome)
  assert.notEqual(r.sessao.accessToken, s.accessToken)
  assert.notEqual(r.sessao.refreshToken, s.refreshToken)
  assert.ok(r.sessao.tokenExpiraEm > velha.tokenExpiraEm)
  assert.ok(r.sessao.expiraEm > velha.expiraEm, 'inatividade recomeca a cada renovacao')
})

test('renovar devolve revogada quando o refresh token e invalido, de outro sujeito ou vencido', async () => {
  const idp = identidadeDev()
  const { url, transacao } = await idp.iniciar('/')
  const s = await idp.concluir(retornoDe(url, 'ana'), transacao)
  const t2 = await idp.iniciar('/')
  const deOutro = await idp.concluir(retornoDe(t2.url, 'bruno'), t2.transacao)
  for (const [nome, sessao] of [
    ['sem refresh token', { ...s, refreshToken: undefined }],
    ['lixo', { ...s, refreshToken: 'qualquer-coisa' }],
    ['de outro sujeito', { ...s, refreshToken: deOutro.refreshToken }],
    ['sujeito desconhecido', { ...s, sub: 'ninguem', refreshToken: s.refreshToken.replace('.ana.', '.ninguem.') }],
    ['vencido', { ...s, refreshToken: s.refreshToken.replace(/\.(\d+)\./, '.1.') }],
  ]) {
    assert.deepEqual(await idp.renovar(sessao), { status: 'revogada' }, nome)
  }
})

test('encerrar no provedor de desenvolvimento nao tem logout no IdP', async () => {
  const idp = identidadeDev()
  const { url, transacao } = await idp.iniciar('/')
  const s = await idp.concluir(retornoDe(url, 'ana'), transacao)
  assert.deepEqual(await idp.encerrar(s), { urlLogout: null })
})

// --- store: transacao de uso unico (arquivo e memoria; Redis em sessao-redis.test.mjs) -------------

const transacaoFalsa = (extra = {}) => ({
  id: `tx-${Math.random()}`, state: 's', codeVerifier: 'segredo-pkce', nonce: 'n', destino: '/', expiraEm: Date.now() + 60_000, ...extra,
})

for (const [nome, criar] of [
  ['arquivo', () => sessaoArquivoDeEscrita({ dir: mkdtempSync(join(tmpdir(), 'tx-')) })],
  ['memoria', () => sessaoMemoria()],
]) {
  test(`${nome}: a transacao de login e de uso unico, mesmo com consumos concorrentes`, async () => {
    const store = criar()
    const t = transacaoFalsa()
    await store.gravarTransacao(t)
    const resultados = await Promise.all(Array.from({ length: 10 }, () => store.consumirTransacao(t.id)))
    assert.equal(resultados.filter(Boolean).length, 1)
    assert.deepEqual(resultados.find(Boolean), t)
    assert.equal(await store.consumirTransacao(t.id), null)
    assert.equal(await store.consumirTransacao('nunca-gravada'), null)
  })

  test(`${nome}: o lock de renovacao e de quem chega primeiro e vence pelo TTL`, async () => {
    const store = criar()
    assert.equal(await store.adquirirLockRenovacao('sid', 60_000), true)
    assert.equal(await store.adquirirLockRenovacao('sid', 60_000), false)
    assert.equal(await store.adquirirLockRenovacao('outra', 60_000), true, 'o lock e por sessao')
    assert.equal(await store.adquirirLockRenovacao('curto', 20), true)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(await store.adquirirLockRenovacao('curto', 20), true, 'lock vencido pode ser retomado')
  })

  test(`${nome}: 20 pedidos de lock concorrentes, exatamente um ganha`, async () => {
    const store = criar()
    const r = await Promise.all(Array.from({ length: 20 }, () => store.adquirirLockRenovacao('sid', 60_000)))
    assert.equal(r.filter(Boolean).length, 1)
  })
}

test('arquivo: a transacao nao fica no caminho que o leitor das zonas le', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tx-'))
  const store = sessaoArquivoDeEscrita({ dir })
  const t = transacaoFalsa({ id: 'tx-1' })
  await store.gravarTransacao(t)
  assert.equal(await sessaoArquivo({ dir }).ler('tx-1'), null)
})

// --- fábrica do shell: login, renovação e saída ------------------------------------------------

/** Provedor que conta as renovações; `atraso` segura a resposta para a concorrência acontecer. */
function idpContador({ atraso = 20, resultado } = {}) {
  const base = identidadeDev()
  const idp = {
    renovacoes: 0, encerradas: [],
    iniciar: (d) => base.iniciar(d),
    concluir: (p, t) => base.concluir(p, t),
    async renovar(s) {
      idp.renovacoes++
      await new Promise((r) => setTimeout(r, atraso))
      return resultado ?? base.renovar(s)
    },
    async encerrar(s) { idp.encerradas.push(s.sub); return { urlLogout: 'https://idp.example/logout' } },
  }
  return idp
}

const shellCom = (store, identidade, leitor = store) => criarNucleoDoShell({
  app: 'shell', sessao: leitor, destinos: {}, acesso: acessoFake({ modulos: [], administra: false }),
  lerCookieDeSessao: async () => undefined,
  escrita: { store, identidade },
})

async function logar(n, usuario = 'ana', destino = '/zona1') {
  const { url, idTransacao } = await n.sessao.iniciarLogin(destino)
  return n.sessao.concluirLogin(idTransacao, retornoDe(url, usuario))
}

test('o shell tem iniciarLogin, concluirLogin, renovarSessao e encerrarSessao, e mais nada de escrita', () => {
  assert.deepEqual(Object.keys(shellCom(sessaoMemoria(), identidadeDev()).sessao).sort(),
    ['atual', 'concluirLogin', 'encerrarSessao', 'exigir', 'iniciarLogin', 'renovarSessao'])
})

test('iniciarLogin devolve so url e id opaco: state, nonce e code_verifier ficam no store', async () => {
  const n = shellCom(sessaoMemoria(), identidadeDev())
  const r = await n.sessao.iniciarLogin('/zona1')
  assert.deepEqual(Object.keys(r).sort(), ['idTransacao', 'url'])
  assert.equal(typeof r.idTransacao, 'string')
})

test('concluirLogin grava a sessao, devolve so id e destino, e o token nao chega a quem chama', async () => {
  const store = sessaoMemoria()
  const n = shellCom(store, identidadeDev())
  const r = await logar(n, 'carla', '/zona2/x')
  assert.deepEqual(Object.keys(r).sort(), ['destino', 'id'])
  assert.equal(r.destino, '/zona2/x')
  const guardada = await store.ler(r.id)
  assert.equal(guardada.sub, 'carla')
  assert.ok(!r.id.includes(guardada.accessToken) && !JSON.stringify(r).includes('dev.'))
})

test('concluirLogin: a transacao e de uso unico, e id desconhecido, retorno adulterado ou vencido nao loga', async () => {
  const store = sessaoMemoria()
  const n = shellCom(store, identidadeDev())
  const { url, idTransacao } = await n.sessao.iniciarLogin('/')
  const ok = retornoDe(url, 'ana')
  assert.equal(await n.sessao.concluirLogin(idTransacao, { ...ok, state: 'adulterado' }), null)
  // a tentativa adulterada consumiu a transacao: o retorno certo depois dela tambem falha
  assert.equal(await n.sessao.concluirLogin(idTransacao, ok), null)
  assert.equal(await n.sessao.concluirLogin(undefined, ok), null)
  assert.equal(await n.sessao.concluirLogin('nao-existe', ok), null)

  const outra = await n.sessao.iniciarLogin('/')
  assert.ok(await n.sessao.concluirLogin(outra.idTransacao, retornoDe(outra.url, 'ana')))
  assert.equal(await n.sessao.concluirLogin(outra.idTransacao, retornoDe(outra.url, 'ana')), null, 'segundo uso')

  // vencida no store: a fabrica recusa sem depender do provedor conferir a validade
  const base = identidadeDev()
  let chamadas = 0
  const descuidado = { ...base, concluir: async (p, tr) => { chamadas++; return base.concluir(p, { ...tr, expiraEm: Infinity }) } }
  const n2 = shellCom(store, descuidado)
  const t = await n2.sessao.iniciarLogin('/')
  const tx = await store.consumirTransacao(t.idTransacao)
  await store.gravarTransacao({ ...tx, expiraEm: Date.now() - 1 })
  assert.equal(await n2.sessao.concluirLogin(t.idTransacao, retornoDe(t.url, 'ana')), null)
  assert.equal(chamadas, 0)
})

/** Sessão gravada com o token prestes a vencer. */
async function sessaoVencendo(store, idp, usuario = 'ana') {
  const n = shellCom(store, idp)
  const { id } = await logar(n, usuario)
  const s = await store.ler(id)
  await store.gravar(id, { ...s, tokenExpiraEm: Date.now() + 1_000 })
  return { n, id }
}

test('renovarSessao: token longe de vencer nao chama o IdP', async () => {
  const store = sessaoMemoria()
  const idp = idpContador()
  const { id } = await logar(shellCom(store, idp))
  assert.equal(await shellCom(store, idp).sessao.renovarSessao(id), 'em-dia')
  assert.equal(idp.renovacoes, 0)
})

test('renovarSessao: token vencendo e renovado, gravado no store, sem token para quem chama', async () => {
  const store = sessaoMemoria()
  const idp = idpContador()
  const { n, id } = await sessaoVencendo(store, idp)
  const antes = await store.ler(id)
  assert.equal(await n.sessao.renovarSessao(id), 'renovada')
  const depois = await store.ler(id)
  assert.equal(idp.renovacoes, 1)
  assert.notEqual(depois.accessToken, antes.accessToken)
  assert.ok(depois.tokenExpiraEm > antes.tokenExpiraEm)
})

for (const [nome, criar] of [
  ['memoria', () => sessaoMemoria()],
  ['arquivo', () => sessaoArquivoDeEscrita({ dir: mkdtempSync(join(tmpdir(), 'ren-')) })],
]) {
  test(`${nome}: 20 renovacoes concorrentes da mesma sessao chamam o IdP exatamente uma vez, e ninguem espera`, async () => {
    const store = criar()
    const idp = idpContador({ atraso: 300 })
    const { n, id } = await sessaoVencendo(store, idp)
    const inicio = Date.now()
    const perdedores = []
    const todas = Array.from({ length: 20 }, () => n.sessao.renovarSessao(id).then((r) => { if (r !== 'renovada') perdedores.push(Date.now() - inicio); return r }))
    const r = await Promise.all(todas)
    assert.equal(idp.renovacoes, 1)
    assert.equal(r.filter((x) => x === 'renovada').length, 1)
    assert.equal(r.filter((x) => x === 'em-andamento').length, 19)
    assert.ok(perdedores.every((ms) => ms < 200), `perdedor esperou a renovacao: ${perdedores}`)
  })
}

test('renovarSessao rele a sessao depois do lock: renovacao feita por outro nao e repetida', async () => {
  const store = sessaoMemoria()
  const idp = idpContador()
  const { id } = await sessaoVencendo(store, idp)
  const velha = await store.ler(id)
  // outro processo renovou entre a primeira leitura deste e o lock
  const renovada = (await identidadeDev().renovar(velha)).sessao
  await store.gravar(id, renovada)
  // o leitor deste processo ainda devolve a foto velha na PRIMEIRA leitura
  let leituras = 0
  const leitor = { ler: async (k) => (leituras++ === 0 ? velha : store.ler(k)) }
  assert.equal(await shellCom(store, idp, leitor).sessao.renovarSessao(id), 'em-dia')
  assert.equal(idp.renovacoes, 0, 'renovou com o refresh token velho (sem releitura)')
  assert.equal(leituras, 2)
})

test('renovarSessao: revogada remove a sessao; ausente ou vencida nao chama o IdP', async () => {
  const store = sessaoMemoria()
  const idp = idpContador({ resultado: { status: 'revogada' } })
  const { n, id } = await sessaoVencendo(store, idp)
  assert.equal(await n.sessao.renovarSessao(id), 'revogada')
  assert.equal(await store.ler(id), null)
  assert.equal(await n.sessao.renovarSessao(id), 'ausente')
  assert.equal(await n.sessao.renovarSessao(undefined), 'ausente')
  const s2 = await sessaoVencendo(store, idp)
  await store.gravar(s2.id, { ...(await store.ler(s2.id)), expiraEm: Date.now() - 1 })
  assert.equal(await n.sessao.renovarSessao(s2.id), 'ausente')
  assert.equal(idp.renovacoes, 1)
})

test('renovarSessao: IdP devolvendo outro sujeito e tratado como revogacao', async () => {
  const store = sessaoMemoria()
  const base = identidadeDev()
  const idp = idpContador()
  idp.renovar = async (s) => { const r = await base.renovar(s); return { status: 'renovada', sessao: { ...r.sessao, sub: 'bruno' } } }
  const { n, id } = await sessaoVencendo(store, idp)
  assert.equal(await n.sessao.renovarSessao(id), 'revogada')
  assert.equal(await store.ler(id), null)
})

test('renovarSessao: erro transitorio do IdP lanca, mantem a sessao e segura o lock (backoff)', async () => {
  const store = sessaoMemoria()
  const idp = idpContador()
  idp.renovar = async () => { idp.renovacoes++; throw new Error('IdP fora do ar') }
  const { n, id } = await sessaoVencendo(store, idp)
  await assert.rejects(() => n.sessao.renovarSessao(id), /IdP fora do ar/)
  assert.ok(await store.ler(id), 'a sessao foi apagada por um erro transitorio')
  assert.equal(await n.sessao.renovarSessao(id), 'em-andamento', 'o lock foi liberado depois do erro')
  assert.equal(idp.renovacoes, 1)
})

test('a janela e o lock de renovacao vem do ambiente (ERP_RENOVACAO_JANELA_S, ERP_RENOVACAO_LOCK_S)', async () => {
  const antes = { j: process.env.ERP_RENOVACAO_JANELA_S, l: process.env.ERP_RENOVACAO_LOCK_S }
  try {
    process.env.ERP_RENOVACAO_JANELA_S = '600'
    const store = sessaoMemoria()
    const idp = idpContador()
    const { id } = await logar(shellCom(store, idp))
    const s = await store.ler(id)
    await store.gravar(id, { ...s, tokenExpiraEm: Date.now() + 120_000 })
    // com a janela padrao (60 s) estaria em dia; com 600 s, renova
    assert.equal(await shellCom(store, idp).sessao.renovarSessao(id), 'renovada')

    let ttl
    const espiao = { ...store, adquirirLockRenovacao: async (k, ms) => { ttl = ms; return store.adquirirLockRenovacao(k, ms) } }
    process.env.ERP_RENOVACAO_LOCK_S = '7'
    await espiao.gravar(id, { ...(await store.ler(id)), tokenExpiraEm: Date.now() + 1_000 })
    await shellCom(espiao, idp, store).sessao.renovarSessao(id)
    assert.equal(ttl, 7_000)

    for (const [nome, ruim] of [['ERP_RENOVACAO_JANELA_S', '0'], ['ERP_RENOVACAO_LOCK_S', 'x'], ['ERP_RENOVACAO_LOCK_S', '301']]) {
      process.env.ERP_RENOVACAO_JANELA_S = nome === 'ERP_RENOVACAO_JANELA_S' ? ruim : '60'
      process.env.ERP_RENOVACAO_LOCK_S = nome === 'ERP_RENOVACAO_LOCK_S' ? ruim : '15'
      assert.throws(() => shellCom(store, idp), new RegExp(nome), `${nome}=${ruim}`)
    }
  } finally {
    for (const [k, v] of [['ERP_RENOVACAO_JANELA_S', antes.j], ['ERP_RENOVACAO_LOCK_S', antes.l]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
})

test('encerrarSessao remove do store ANTES de pedir a URL de logout ao IdP', async () => {
  const store = sessaoMemoria()
  const idp = idpContador()
  const { id } = await logar(shellCom(store, idp), 'davi')
  let gravadaQuandoPediu
  const encerrar = idp.encerrar
  idp.encerrar = async (s) => { gravadaQuandoPediu = await store.ler(id); return encerrar(s) }
  const r = await shellCom(store, idp).sessao.encerrarSessao(id)
  assert.deepEqual(r, { urlLogout: 'https://idp.example/logout' })
  assert.equal(gravadaQuandoPediu, null)
  assert.deepEqual(idp.encerradas, ['davi'])
  assert.equal(await store.ler(id), null)
  // sem sessão: nada a encerrar no IdP
  assert.deepEqual(await shellCom(store, idp).sessao.encerrarSessao(id), { urlLogout: null })
  assert.deepEqual(await shellCom(store, idp).sessao.encerrarSessao(undefined), { urlLogout: null })
})

/** Redis falso mínimo com SET NX/XX PX, GETDEL e TTL, para rodar a fábrica sobre o adaptador Redis. */
function redisMinimo() {
  const d = new Map()
  const vivo = (k) => { const e = d.get(k); if (e && Date.now() >= e.expira) d.delete(k); return d.get(k) }
  return {
    async get(k) { return vivo(k)?.valor ?? null },
    async set(k, valor, op) {
      if (op.NX && vivo(k)) return null
      if (op.XX && !vivo(k)) return null
      d.set(k, { valor, expira: Date.now() + op.PX }); return 'OK'
    },
    async del(k) { return d.delete(k) ? 1 : 0 },
    async getDel(k) { const e = vivo(k); d.delete(k); return e ? e.valor : null },
  }
}

for (const [nome, criar] of [
  ['memoria', () => { const s = sessaoMemoria(); return { store: s, leitor: s } }],
  ['arquivo', () => { const dir = mkdtempSync(join(tmpdir(), 'corrida-')); return { store: sessaoArquivoDeEscrita({ dir }), leitor: sessaoArquivo({ dir }) } }],
  ['redis', () => { const r = redisMinimo(); return { store: sessaoRedisDeEscrita({ cliente: r }), leitor: sessaoRedis({ cliente: r }) } }],
]) {
  test(`${nome}: encerrarSessao durante uma renovacao em curso nao deixa a sessao voltar`, async () => {
    const { store, leitor } = criar()
    const base = identidadeDev()
    let liberar
    const segurando = new Promise((r) => { liberar = r })
    let chegou
    const naRenovacao = new Promise((r) => { chegou = r })
    const idp = { ...base, renovar: async (s) => { chegou(); await segurando; return base.renovar(s) } }
    const n = shellCom(store, idp, leitor)
    const { id } = await logar(n)
    await store.gravar(id, { ...(await leitor.ler(id)), tokenExpiraEm: Date.now() + 1_000 })

    const renovacao = n.sessao.renovarSessao(id)
    await naRenovacao
    await n.sessao.encerrarSessao(id)
    liberar()
    assert.equal(await renovacao, 'ausente')
    assert.equal(await leitor.ler(id), null, 'a renovacao regravou a sessao encerrada')
  })
}

// --- D19-B: com o token JÁ VENCIDO, quem perde o lock espera a renovação do vencedor ------------------
// Na janela (token ainda válido) quem perde não espera (ADR-0013, decisão 4). Vencido, seguir com o token
// morto leva ao /login com a sessão intacta (DEFERRED.md D19): o perdedor relê a sessão no store, a cada
// ERP_RENOVACAO_ESPERA_PASSO_MS, até ERP_RENOVACAO_ESPERA_MS. A espera nunca chama o IdP.
// O `timeout` de cada teste faz uma espera que trava (ex.: chamar o IdP preso) reprovar em vez de pendurar.

/** Roda `fn` com as variáveis de ambiente dadas (`undefined` apaga) e devolve as de antes. */
async function comAmbiente(vars, fn) {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  const aplicar = (v) => { for (const [k, x] of Object.entries(v)) { if (x === undefined) delete process.env[k]; else process.env[k] = x } }
  aplicar(vars)
  try { return await fn() } finally { aplicar(antes) }
}

const ESPERA_CURTA = { ERP_RENOVACAO_ESPERA_MS: '300', ERP_RENOVACAO_ESPERA_PASSO_MS: '20' }

/** Leitor que conta as leituras, para provar que a espera relê no passo e não em laço sem pausa. */
const contandoLeituras = (leitor) => {
  const l = { leituras: 0, ler: async (k) => { l.leituras++; return leitor.ler(k) } }
  return l
}

/** Sessão logada com o token já vencido (a sessão em si continua válida). */
async function sessaoVencida(n, store, leitor) {
  const { id } = await logar(n)
  await store.gravar(id, { ...(await leitor.ler(id)), tokenExpiraEm: Date.now() - 1_000 })
  return id
}

const tresStores = [
  ['memoria', () => { const s = sessaoMemoria(); return { store: s, leitor: s } }],
  ['arquivo', () => { const dir = mkdtempSync(join(tmpdir(), 'espera-')); return { store: sessaoArquivoDeEscrita({ dir }), leitor: sessaoArquivo({ dir }) } }],
  ['redis', () => { const r = redisMinimo(); return { store: sessaoRedisDeEscrita({ cliente: r }), leitor: sessaoRedis({ cliente: r }) } }],
]

for (const [nome, criar] of tresStores) {
  test(`${nome}: token vencido, 20 renovacoes concorrentes chamam o IdP uma vez e ninguem segue com o token morto`, { timeout: 10_000 }, async () => {
    await comAmbiente({ ERP_RENOVACAO_ESPERA_MS: '2000', ERP_RENOVACAO_ESPERA_PASSO_MS: '20' }, async () => {
      const { store, leitor } = criar()
      const idp = idpContador({ atraso: 150 })
      const n = shellCom(store, idp, leitor)
      const id = await sessaoVencida(n, store, leitor)
      const r = await Promise.all(Array.from({ length: 20 }, () => n.sessao.renovarSessao(id)))
      assert.equal(idp.renovacoes, 1)
      assert.equal(r.filter((x) => x === 'renovada').length, 1)
      assert.equal(r.filter((x) => x === 'em-dia').length, 19, `estados: ${r}`)
      assert.ok(!r.includes('em-andamento'), 'perdedor seguiu com o token vencido')
      assert.ok((await leitor.ler(id)).tokenExpiraEm > Date.now())
    })
  })

  test(`${nome}: token na janela e ainda valido, o perdedor nao espera`, { timeout: 10_000 }, async () => {
    await comAmbiente({ ERP_RENOVACAO_ESPERA_MS: '2000', ERP_RENOVACAO_ESPERA_PASSO_MS: '20' }, async () => {
      const { store, leitor } = criar()
      const idp = idpContador({ atraso: 400 })
      const n = shellCom(store, idp, leitor)
      const { id } = await logar(n)
      await store.gravar(id, { ...(await leitor.ler(id)), tokenExpiraEm: Date.now() + 1_000 })
      const inicio = Date.now()
      const perdedores = []
      const r = await Promise.all(Array.from({ length: 20 }, () => n.sessao.renovarSessao(id)
        .then((x) => { if (x !== 'renovada') perdedores.push(Date.now() - inicio); return x })))
      assert.equal(idp.renovacoes, 1)
      assert.equal(r.filter((x) => x === 'em-andamento').length, 19, `estados: ${r}`)
      assert.ok(perdedores.every((ms) => ms < 200), `perdedor esperou com o token valido: ${perdedores}`)
    })
  })

  test(`${nome}: token vencido e IdP com erro transitorio, o perdedor espera o teto e segue; o IdP e chamado uma vez`, { timeout: 10_000 }, async () => {
    await comAmbiente(ESPERA_CURTA, async () => {
      const { store, leitor } = criar()
      const idp = idpContador()
      idp.renovar = async () => { idp.renovacoes++; await new Promise((r) => setTimeout(r, 30)); throw new Error('IdP fora do ar') }
      const contador = contandoLeituras(leitor)
      const n = shellCom(store, idp, contador)
      const id = await sessaoVencida(n, store, leitor)
      const vencedor = n.sessao.renovarSessao(id)
      const perdedores = Array.from({ length: 5 }, () => {
        const inicio = Date.now()
        return n.sessao.renovarSessao(id).then((estado) => ({ estado, ms: Date.now() - inicio }))
      })
      const leiturasAntes = contador.leituras
      await assert.rejects(vencedor, /IdP fora do ar/)
      for (const { estado, ms } of await Promise.all(perdedores)) {
        assert.equal(estado, 'em-andamento')
        assert.ok(ms >= 300, `voltou antes do teto: ${ms} ms`)
        assert.ok(ms <= 300 + 2 * 20 + 25, `passou do teto mais dois passos: ${ms} ms`)
      }
      assert.equal(idp.renovacoes, 1, 'a espera chamou o IdP')
      assert.ok(await leitor.ler(id), 'a sessao foi apagada por um erro transitorio')
      // releitura no passo, não em laço: 5 perdedores × (300/20 + folga)
      const releituras = contador.leituras - leiturasAntes
      assert.ok(releituras <= 5 * (300 / 20 + 4), `releituras demais: ${releituras}`)
    })
  })

  test(`${nome}: sessao encerrada durante a espera, o perdedor volta ausente sem esperar o teto`, { timeout: 10_000 }, async () => {
    await comAmbiente({ ERP_RENOVACAO_ESPERA_MS: '2000', ERP_RENOVACAO_ESPERA_PASSO_MS: '20' }, async () => {
      const { store, leitor } = criar()
      const base = identidadeDev()
      let liberar
      const segurando = new Promise((r) => { liberar = r })
      let renovacoes = 0
      const idp = { ...base, renovar: async (s) => { renovacoes++; await segurando; return base.renovar(s) } }
      const n = shellCom(store, idp, leitor)
      const id = await sessaoVencida(n, store, leitor)
      const vencedor = n.sessao.renovarSessao(id)
      const inicio = Date.now()
      const perdedor = n.sessao.renovarSessao(id)
      await new Promise((r) => setTimeout(r, 60))
      await n.sessao.encerrarSessao(id)
      assert.equal(await perdedor, 'ausente')
      assert.ok(Date.now() - inicio < 1_000, 'esperou o teto com a sessao encerrada')
      liberar()
      assert.equal(await vencedor, 'ausente')
      assert.equal(renovacoes, 1)
    })
  })

  test(`${nome}: ERP_RENOVACAO_ESPERA_MS=0 desliga a espera (comportamento anterior)`, { timeout: 10_000 }, async () => {
    await comAmbiente({ ERP_RENOVACAO_ESPERA_MS: '0', ERP_RENOVACAO_ESPERA_PASSO_MS: undefined }, async () => {
      const { store, leitor } = criar()
      const idp = idpContador({ atraso: 400 })
      const n = shellCom(store, idp, leitor)
      const id = await sessaoVencida(n, store, leitor)
      const inicio = Date.now()
      const perdedores = []
      const r = await Promise.all(Array.from({ length: 20 }, () => n.sessao.renovarSessao(id)
        .then((x) => { if (x !== 'renovada') perdedores.push(Date.now() - inicio); return x })))
      assert.equal(idp.renovacoes, 1)
      assert.equal(r.filter((x) => x === 'em-andamento').length, 19, `estados: ${r}`)
      assert.ok(perdedores.every((ms) => ms < 200), `esperou com a espera desligada: ${perdedores}`)
    })
  })
}

test('a espera rele no passo configurado (ERP_RENOVACAO_ESPERA_PASSO_MS), nao em laco', { timeout: 10_000 }, async () => {
  await comAmbiente({ ERP_RENOVACAO_ESPERA_MS: '300', ERP_RENOVACAO_ESPERA_PASSO_MS: '100' }, async () => {
    const store = sessaoMemoria()
    const idp = idpContador()
    const contador = contandoLeituras(store)
    const n = shellCom(store, idp, contador)
    const id = await sessaoVencida(n, store, store)
    assert.ok(await store.adquirirLockRenovacao(id, 60_000), 'lock de outro processo')
    const antes = contador.leituras
    const inicio = Date.now()
    assert.equal(await n.sessao.renovarSessao(id), 'em-andamento')
    const ms = Date.now() - inicio
    const releituras = contador.leituras - antes - 1   // a primeira é a leitura de antes do lock
    assert.ok(ms >= 300 && ms <= 300 + 2 * 100 + 25, `tempo fora do teto: ${ms} ms`)
    assert.ok(releituras >= 2 && releituras <= 4, `releituras com passo de 100 ms em 300 ms: ${releituras}`)
    assert.equal(idp.renovacoes, 0, 'o perdedor chamou o IdP')
  })
})

test('ERP_RENOVACAO_ESPERA_MS e ERP_RENOVACAO_ESPERA_PASSO_MS: padrao, teto e recusa na criacao', { timeout: 10_000 }, async () => {
  const store = sessaoMemoria()
  const criar = () => shellCom(store, identidadeDev())
  const limpo = { ERP_RENOVACAO_ESPERA_MS: undefined, ERP_RENOVACAO_ESPERA_PASSO_MS: undefined, ERP_RENOVACAO_LOCK_S: undefined }
  // aceitos
  for (const vars of [
    {}, { ERP_RENOVACAO_ESPERA_MS: '0' }, { ERP_RENOVACAO_ESPERA_MS: '14999' }, { ERP_RENOVACAO_ESPERA_MS: '51' },
    { ERP_RENOVACAO_LOCK_S: '3' }, { ERP_RENOVACAO_ESPERA_MS: '300', ERP_RENOVACAO_ESPERA_PASSO_MS: '10' },
    { ERP_RENOVACAO_ESPERA_MS: '300', ERP_RENOVACAO_ESPERA_PASSO_MS: '299' },
  ]) await comAmbiente({ ...limpo, ...vars }, async () => assert.doesNotThrow(criar, JSON.stringify(vars)))
  // recusados, com o nome da variável culpada
  for (const [vars, culpada] of [
    [{ ERP_RENOVACAO_ESPERA_MS: '-1' }, 'ERP_RENOVACAO_ESPERA_MS'],
    [{ ERP_RENOVACAO_ESPERA_MS: '1.5' }, 'ERP_RENOVACAO_ESPERA_MS'],
    [{ ERP_RENOVACAO_ESPERA_MS: 'dois' }, 'ERP_RENOVACAO_ESPERA_MS'],
    [{ ERP_RENOVACAO_ESPERA_MS: ' ' }, 'ERP_RENOVACAO_ESPERA_MS'],
    // teto: menor que ERP_RENOVACAO_LOCK_S × 1000 (padrão 15 s)
    [{ ERP_RENOVACAO_ESPERA_MS: '15000' }, 'ERP_RENOVACAO_ESPERA_MS'],
    [{ ERP_RENOVACAO_ESPERA_MS: '5000', ERP_RENOVACAO_LOCK_S: '5' }, 'ERP_RENOVACAO_ESPERA_MS'],
    // o padrão (2000) também respeita o teto: com lock de 2 s não cabe
    [{ ERP_RENOVACAO_LOCK_S: '2' }, 'ERP_RENOVACAO_ESPERA_MS'],
    [{ ERP_RENOVACAO_ESPERA_PASSO_MS: '9' }, 'ERP_RENOVACAO_ESPERA_PASSO_MS'],
    [{ ERP_RENOVACAO_ESPERA_PASSO_MS: '0' }, 'ERP_RENOVACAO_ESPERA_PASSO_MS'],
    [{ ERP_RENOVACAO_ESPERA_PASSO_MS: 'x' }, 'ERP_RENOVACAO_ESPERA_PASSO_MS'],
    [{ ERP_RENOVACAO_ESPERA_MS: '300', ERP_RENOVACAO_ESPERA_PASSO_MS: '300' }, 'ERP_RENOVACAO_ESPERA_PASSO_MS'],
    // o padrão do passo (50) tem de ser menor que a espera
    [{ ERP_RENOVACAO_ESPERA_MS: '50' }, 'ERP_RENOVACAO_ESPERA_PASSO_MS'],
  ]) await comAmbiente({ ...limpo, ...vars }, async () => assert.throws(criar, new RegExp(culpada), JSON.stringify(vars)))
})

test('padroes da espera no fonte: 2000 ms e passo de 50 ms (docs/CONFIGURACAO.md §1)', { timeout: 10_000 }, async () => {
  const { readFileSync } = await import('node:fs')
  const fonte = readFileSync(new URL('../src/fabricas/criarNucleo.ts', import.meta.url), 'utf8')
  assert.match(fonte, /ERP_RENOVACAO_ESPERA_MS, 2_000, 'ERP_RENOVACAO_ESPERA_MS'/)
  assert.match(fonte, /ERP_RENOVACAO_ESPERA_PASSO_MS, 50, 'ERP_RENOVACAO_ESPERA_PASSO_MS', 10/)
})

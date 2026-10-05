import { test as testNode, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { identidadeOidc } from '../dist/adaptadores/identidade-oidc.js'
import { ErroDeAplicacao } from '../dist/interno/erros.js'
import { comSorteiosRegistrados, conferirQuatroSorteios, conferirSegredosForaDoPublico } from './apoio-transacao.mjs'

// Timeout por teste e fechamento garantido: um assert que falha não pode deixar a suíte pendurada.
const test = (nome, fn) => testNode(nome, { timeout: 5000 }, fn)
const abertos = []
after(() => { for (const s of abertos) { s.closeAllConnections(); s.close() } })

const CLIENTE = { clienteId: 'erp-shell', clienteSegredo: 'segredo-de-teste' }
const URL_RETORNO = 'http://shell.test/api/auth/retorno'
const URL_POS_LOGOUT = 'http://shell.test/'

// --- IdP falso: discovery, JWKS, token (código e refresh) e logout, com id_token RS256 de verdade ---

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwt(payload) {
  const corpo = `${b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64(payload)}`
  return `${corpo}.${createSign('RSA-SHA256').update(corpo).sign(privateKey, 'base64url')}`
}
const s256 = (v) => createHash('sha256').update(v).digest('base64url')

/**
 * `ajustes` de um login ou de uma renovação: `idToken` e `accessToken` sobrescrevem claims (valor
 * `undefined` apaga a claim), `resposta` sobrescreve campos da resposta do token endpoint.
 */
async function servidorOidc({ metadata = (m) => m } = {}) {
  const estado = {
    descobertas: 0, pedidosToken: [], codigos: new Map(), refresh: new Map(), desvios: 0,
    /** Substitui o token endpoint inteiro: `(req, res, form) => void`. */
    tokenEndpoint: null,
    /** Ajustes aplicados à próxima resposta de refresh. */
    ajustesRefresh: {},
  }
  let origem
  const emissor = () => `${origem}/realms/erp`

  const tokens = (pessoa, nonce, ajustes = {}) => {
    const agora = Math.floor(Date.now() / 1000)
    const limpar = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
    const access = limpar({
      iss: emissor(), sub: pessoa.sub, aud: ['erp-dominios', 'account'], azp: CLIENTE.clienteId,
      preferred_username: pessoa.usuario, iat: agora, exp: agora + 300, jti: randomBytes(8).toString('hex'), ...ajustes.accessToken,
    })
    const id = limpar({
      iss: emissor(), sub: pessoa.sub, aud: CLIENTE.clienteId, azp: CLIENTE.clienteId, nonce,
      preferred_username: pessoa.usuario, name: pessoa.nome, iat: agora, exp: agora + 300, ...ajustes.idToken,
    })
    const refresh = randomBytes(16).toString('base64url')
    estado.refresh.set(refresh, pessoa)
    return limpar({
      access_token: jwt(access), token_type: 'Bearer', expires_in: 300, refresh_expires_in: 1800,
      refresh_token: refresh, id_token: jwt(id), scope: 'openid profile', ...ajustes.resposta,
    })
  }

  const json = (res, status, corpo) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(corpo)) }

  const s = createServer(async (req, res) => {
    const url = new URL(req.url, origem)
    if (req.method === 'GET' && url.pathname === '/realms/erp/.well-known/openid-configuration') {
      estado.descobertas++
      return json(res, 200, metadata({
        issuer: emissor(),
        authorization_endpoint: `${emissor()}/protocol/openid-connect/auth`,
        token_endpoint: `${emissor()}/protocol/openid-connect/token`,
        jwks_uri: `${emissor()}/protocol/openid-connect/certs`,
        end_session_endpoint: `${emissor()}/protocol/openid-connect/logout`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        authorization_response_iss_parameter_supported: true,
      }, origem))
    }
    if (req.method === 'GET' && url.pathname === '/realms/erp/protocol/openid-connect/certs') {
      return json(res, 200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })
    }
    if (url.pathname === '/desvio') { estado.desvios++; return json(res, 200, {}) }
    if (req.method === 'POST' && url.pathname === '/realms/erp/protocol/openid-connect/token') {
      let corpo = ''
      for await (const parte of req) corpo += parte
      const form = Object.fromEntries(new URLSearchParams(corpo))
      estado.pedidosToken.push({ form, authorization: req.headers.authorization })
      if (estado.tokenEndpoint) return estado.tokenEndpoint(req, res, form)
      const basico = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent) : null
      const [id, segredo] = basico ?? [form.client_id, form.client_secret]
      if (id !== CLIENTE.clienteId || segredo !== CLIENTE.clienteSegredo) return json(res, 401, { error: 'invalid_client' })
      if (form.grant_type === 'authorization_code') {
        const c = estado.codigos.get(form.code)
        estado.codigos.delete(form.code)   // uso único
        if (!c || form.redirect_uri !== c.redirectUri || s256(form.code_verifier ?? '') !== c.challenge) {
          return json(res, 400, { error: 'invalid_grant' })
        }
        return json(res, 200, tokens(c.pessoa, c.nonce, c.ajustes))
      }
      if (form.grant_type === 'refresh_token') {
        const pessoa = estado.refresh.get(form.refresh_token)
        estado.refresh.delete(form.refresh_token)   // rotação: o refresh token gasto não vale mais
        if (!pessoa) return json(res, 400, { error: 'invalid_grant', error_description: 'Token is not active' })
        const ajustes = estado.ajustesRefresh
        estado.ajustesRefresh = {}
        return json(res, 200, tokens(pessoa, undefined, { idToken: { nonce: undefined }, ...ajustes }))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    json(res, 404, {})
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  abertos.push(s)
  origem = `http://127.0.0.1:${s.address().port}`

  return {
    estado, origem, emissor: emissor(),
    /** O que o IdP faz depois que a pessoa se autentica: guarda o desafio PKCE e devolve um código. */
    emitirCodigo(urlAutorizacao, ajustes = {}, pessoa = { sub: 'p-123', usuario: 'ana', nome: 'Ana Operadora' }) {
      const u = new URL(urlAutorizacao)
      const code = randomBytes(16).toString('base64url')
      estado.codigos.set(code, {
        challenge: u.searchParams.get('code_challenge'), redirectUri: u.searchParams.get('redirect_uri'),
        nonce: u.searchParams.get('nonce'), pessoa, ajustes,
      })
      return code
    },
    derrubar() { s.closeAllConnections(); s.close() },
  }
}

const novoIdp = (srv, extra = {}) => identidadeOidc({
  emissor: srv.emissor, ...CLIENTE, urlRetorno: URL_RETORNO, urlPosLogout: URL_POS_LOGOUT, ...extra,
})

/** Login completo: iniciar, IdP emite o código, `concluir` com o retorno que o navegador traz. */
async function logar(idp, srv, ajustes, retorno = (code, t) => ({ code, state: t.state, iss: srv.emissor })) {
  const { url, transacao } = await idp.iniciar('/zona1')
  const code = srv.emitirCodigo(url, ajustes)
  const sessao = await idp.concluir(retorno(code, transacao), transacao)
  return { url, transacao, sessao }
}

const comAmbiente = async (vars, fn) => {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

/** Erro normalizado (invariante 12): só o código, sem causa, sem nada do IdP ou da biblioteca. */
function ehErroNormalizado(e) {
  assert.ok(e instanceof ErroDeAplicacao, `esperado ErroDeAplicacao, veio ${e?.name}: ${e?.message}`)
  assert.equal(e.codigo, 'ERRO_INTERNO')
  assert.equal(e.message, 'ERRO_INTERNO')
  assert.equal(e.cause, undefined)
  return true
}

const decodificar = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

// --- iniciar -----------------------------------------------------------------------------------

test('iniciar: URL de autorizacao do discovery com PKCE S256, state e nonce da transacao, sem o verifier', async () => {
  const srv = await servidorOidc()
  const { url, transacao } = await novoIdp(srv).iniciar('/zona1')
  const u = new URL(url)
  assert.equal(`${u.origin}${u.pathname}`, `${srv.emissor}/protocol/openid-connect/auth`)
  const p = u.searchParams
  assert.equal(p.get('response_type'), 'code')
  assert.equal(p.get('client_id'), CLIENTE.clienteId)
  assert.equal(p.get('redirect_uri'), URL_RETORNO)
  assert.ok(p.get('scope').split(' ').includes('openid'), p.get('scope'))
  assert.equal(p.get('code_challenge_method'), 'S256')
  assert.equal(p.get('code_challenge'), s256(transacao.codeVerifier))
  assert.equal(p.get('state'), transacao.state)
  assert.equal(p.get('nonce'), transacao.nonce)
  assert.ok(!url.includes(transacao.codeVerifier), 'o code_verifier nao pode ir ao navegador')
  assert.ok(!url.includes(CLIENTE.clienteSegredo), 'o segredo do cliente nao pode ir ao navegador')
  assert.equal(transacao.destino, '/zona1')
  assert.ok(transacao.codeVerifier.length >= 43)
})

// O id da transação é o valor do cookie __Host-erp-login: opaco, só do navegador (ADR-0013, decisão 3). Se fosse o
// state, iria na URL de autorização e voltaria na de retorno; quem visse `/api/auth/retorno?code&state` teria código
// e cookie. Nonce e state também são valores independentes, nunca derivados um do outro.
test('iniciar: id da transacao (cookie __Host-erp-login) independente de state, nonce e code_verifier, e fora da URL', async () => {
  const srv = await servidorOidc()
  const { url, transacao } = await novoIdp(srv).iniciar('/zona1')
  const valores = { id: transacao.id, state: transacao.state, nonce: transacao.nonce, codeVerifier: transacao.codeVerifier }
  for (const [nome, v] of Object.entries(valores)) assert.ok(typeof v === 'string' && v.length >= 43, `${nome} curto ou ausente`)
  assert.equal(new Set(Object.values(valores)).size, 4, `valores repetidos na transacao: ${JSON.stringify(Object.keys(valores))}`)
  assert.ok(!url.includes(transacao.id), 'o id da transacao nao pode ir na URL de autorizacao')
  for (const [, v] of new URL(url).searchParams) assert.ok(!v.includes(transacao.id), 'id da transacao num parametro da autorizacao')
  // nem calculavel a partir do que vai na URL: contido, sha256 ou sha512 de state, nonce ou parametro
  conferirSegredosForaDoPublico(transacao, url)
})

// Diferentes entre si não bastam: os quatro valores são sorteios independentes de 32 bytes ou mais da fonte
// aleatória, e nenhum é derivado de outro (auditor_d2_2: id = sha256(state), id = state + sufixo e
// codeVerifier = sha256(state) passavam).
test('iniciar: id, state, code_verifier e nonce sao sorteios independentes de 32 bytes ou mais', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  await idp.iniciar('/') // discovery fora da medicao
  const { resultado: { transacao }, sorteios } = await comSorteiosRegistrados(() => idp.iniciar('/zona1'))
  conferirQuatroSorteios(transacao, sorteios)
})

// Rodando sozinho, este arquivo pega valores constantes: duas chamadas a iniciar dao valores diferentes.
test('iniciar: id, state, code_verifier, nonce e a URL mudam a cada chamada', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const a = await idp.iniciar('/zona1')
  const b = await idp.iniciar('/zona1')
  for (const campo of ['id', 'state', 'codeVerifier', 'nonce']) {
    assert.notEqual(a.transacao[campo], b.transacao[campo], `${campo} repetido entre duas chamadas`)
  }
  assert.notEqual(a.url, b.url)
})

test('iniciar: destino externo vira "/" e a transacao vale ERP_LOGIN_TRANSACAO_S', async () => {
  const srv = await servidorOidc()
  await comAmbiente({ ERP_LOGIN_TRANSACAO_S: '90' }, async () => {
    const { transacao } = await novoIdp(srv).iniciar('https://mal.example')
    assert.equal(transacao.destino, '/')
    assert.ok(Math.abs(transacao.expiraEm - Date.now() - 90_000) < 2_000, `expiraEm=${transacao.expiraEm}`)
  })
})

test('discovery uma vez por provedor; falha nao fica guardada e a proxima chamada tenta de novo', async () => {
  let falhar = true
  const srv = await servidorOidc({ metadata: (m) => (falhar ? { ...m, issuer: 'http://outro.example' } : m) })
  const idp = novoIdp(srv)
  await assert.rejects(idp.iniciar('/'), ehErroNormalizado)
  falhar = false
  await idp.iniciar('/')
  await idp.iniciar('/')
  assert.equal(srv.estado.descobertas, 2)
})

test('todo endpoint do discovery tem a origem do emissor (ADR-0013, decisao 5)', async () => {
  for (const campo of ['authorization_endpoint', 'token_endpoint', 'end_session_endpoint', 'jwks_uri']) {
    const srv = await servidorOidc({ metadata: (m) => ({ ...m, [campo]: `http://mal.example/${campo}` }) })
    await assert.rejects(novoIdp(srv).iniciar('/'), ehErroNormalizado, campo)
  }
})

// --- concluir ----------------------------------------------------------------------------------

test('concluir: troca o codigo com o code_verifier e devolve a sessao com sub, nome e tokens', async () => {
  const srv = await servidorOidc()
  const antes = Date.now()
  const { transacao, sessao } = await logar(novoIdp(srv), srv)
  assert.ok(sessao, 'login valido recusado')
  assert.equal(sessao.sub, 'p-123')
  assert.equal(sessao.nome, 'Ana Operadora')
  assert.deepEqual(decodificar(sessao.accessToken).aud, ['erp-dominios', 'account'])
  assert.equal(typeof sessao.refreshToken, 'string')
  assert.equal(decodificar(sessao.idToken).nonce, transacao.nonce)
  // vida do token e da sessão vêm da resposta do IdP (expires_in 300, refresh_expires_in 1800)
  assert.ok(Math.abs(sessao.tokenExpiraEm - antes - 300_000) < 2_000, `tokenExpiraEm=${sessao.tokenExpiraEm}`)
  assert.ok(Math.abs(sessao.expiraEm - antes - 1_800_000) < 2_000, `expiraEm=${sessao.expiraEm}`)
  const [pedido] = srv.estado.pedidosToken
  assert.equal(pedido.form.grant_type, 'authorization_code')
  assert.equal(pedido.form.code_verifier, transacao.codeVerifier)
  assert.equal(pedido.form.redirect_uri, URL_RETORNO)
})

test('concluir: sem name no id_token, o nome e o preferred_username', async () => {
  const srv = await servidorOidc()
  const { sessao } = await logar(novoIdp(srv), srv, { idToken: { name: undefined } })
  assert.equal(sessao.nome, 'ana')
})

test('concluir: sem refresh_expires_in, a sessao vale ERP_SESSAO_INATIVIDADE_S', async () => {
  const srv = await servidorOidc()
  await comAmbiente({ ERP_SESSAO_INATIVIDADE_S: '600' }, async () => {
    const { sessao } = await logar(novoIdp(srv), srv, { resposta: { refresh_expires_in: undefined } })
    assert.ok(Math.abs(sessao.expiraEm - Date.now() - 600_000) < 2_000, `expiraEm=${sessao.expiraEm}`)
  })
})

test('concluir recusa (null) state, iss e nonce divergentes, sem chamar o token endpoint nos dois primeiros', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const casos = {
    state: (code) => ({ code, state: 'outro-state', iss: srv.emissor }),
    iss: (code, t) => ({ code, state: t.state, iss: 'http://mal.example/realms/erp' }),
  }
  for (const [nome, retorno] of Object.entries(casos)) {
    assert.equal((await logar(idp, srv, {}, retorno)).sessao, null, nome)
  }
  assert.equal(srv.estado.pedidosToken.length, 0)
  assert.equal((await logar(idp, srv, { idToken: { nonce: 'outro-nonce' } })).sessao, null, 'nonce')
})

test('concluir recusa (null) erro do IdP no retorno, codigo reusado e transacao vencida', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const negado = await logar(idp, srv, {}, (_code, t) => ({ error: 'access_denied', state: t.state, iss: srv.emissor }))
  assert.equal(negado.sessao, null, 'error=access_denied')

  const { url, transacao } = await idp.iniciar('/')
  const code = srv.emitirCodigo(url)
  assert.ok(await idp.concluir({ code, state: transacao.state, iss: srv.emissor }, transacao))
  assert.equal(await idp.concluir({ code, state: transacao.state, iss: srv.emissor }, transacao), null, 'codigo reusado (invalid_grant)')

  const pedidos = srv.estado.pedidosToken.length
  const outra = await idp.iniciar('/')
  const vencida = { ...outra.transacao, expiraEm: Date.now() - 1 }
  assert.equal(await idp.concluir({ code: srv.emitirCodigo(outra.url), state: vencida.state, iss: srv.emissor }, vencida), null)
  assert.equal(srv.estado.pedidosToken.length, pedidos, 'transacao vencida nao vai ao IdP')
})

test('concluir exige sub e preferred_username no id_token (ator do dominio, ADR-0013)', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  assert.equal((await logar(idp, srv, { idToken: { preferred_username: undefined } })).sessao, null, 'sem preferred_username')
  assert.equal((await logar(idp, srv, { idToken: { preferred_username: '' } })).sessao, null, 'preferred_username vazio')
  assert.equal((await logar(idp, srv, { idToken: { sub: undefined } })).sessao, null, 'sem sub')
})

test('concluir exige aud do access token contendo erp-dominios e o mesmo sub do id_token', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  assert.equal((await logar(idp, srv, { accessToken: { aud: 'account' } })).sessao, null, 'aud sem erp-dominios')
  assert.equal((await logar(idp, srv, { accessToken: { aud: undefined } })).sessao, null, 'sem aud')
  assert.equal((await logar(idp, srv, { accessToken: { sub: 'outra-pessoa' } })).sessao, null, 'sub divergente')
  assert.ok((await logar(idp, srv, { accessToken: { aud: 'erp-dominios' } })).sessao, 'aud em texto simples vale')
  assert.equal((await logar(idp, srv, { resposta: { access_token: 'opaco' } })).sessao, null, 'access token que nao e JWT')
})

test('concluir: erro transitorio do IdP (5xx, rede) lanca normalizado, nao vira recusa silenciosa', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  srv.estado.tokenEndpoint = (_req, res) => { res.writeHead(503); res.end('<html>indisponivel</html>') }
  await assert.rejects(logar(idp, srv), ehErroNormalizado)
  srv.estado.tokenEndpoint = (_req, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"server_error"}') }
  await assert.rejects(logar(idp, srv), ehErroNormalizado)
  const { url, transacao } = await idp.iniciar('/')
  srv.derrubar()
  await assert.rejects(idp.concluir({ code: srv.emitirCodigo(url), state: transacao.state, iss: srv.emissor }, transacao), ehErroNormalizado)
})

// --- renovar -----------------------------------------------------------------------------------

test('renovar: refresh grant com rotacao devolve sessao nova da mesma pessoa', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  const r = await idp.renovar(sessao)
  assert.equal(r.status, 'renovada')
  assert.equal(r.sessao.sub, sessao.sub)
  assert.equal(r.sessao.nome, sessao.nome)
  assert.notEqual(r.sessao.accessToken, sessao.accessToken)
  assert.notEqual(r.sessao.refreshToken, sessao.refreshToken, 'refresh token rotacionado')
  assert.ok(r.sessao.tokenExpiraEm <= r.sessao.expiraEm)
  const pedido = srv.estado.pedidosToken.at(-1)
  assert.equal(pedido.form.grant_type, 'refresh_token')
  assert.equal(pedido.form.refresh_token, sessao.refreshToken)
})

test('renovar: resposta sem id_token nem refresh_token mantem pessoa, id_token e refresh token anteriores', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  srv.estado.ajustesRefresh = { resposta: { id_token: undefined, refresh_token: undefined } }
  const r = await idp.renovar(sessao)
  assert.equal(r.status, 'renovada')
  assert.equal(r.sessao.sub, sessao.sub)
  assert.equal(r.sessao.nome, sessao.nome)
  assert.equal(r.sessao.idToken, sessao.idToken)
  assert.equal(r.sessao.refreshToken, sessao.refreshToken)
})

test('renovar: invalid_grant (refresh token revogado ou ja gasto) e revogada', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  assert.equal((await idp.renovar(sessao)).status, 'renovada')
  // o mesmo refresh token de novo: com rotação, o IdP recusa
  assert.deepEqual(await idp.renovar(sessao), { status: 'revogada' })
})

test('renovar: sessao sem refresh token e revogada sem ir ao IdP', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  const { refreshToken: _r, ...semRefresh } = sessao
  const pedidos = srv.estado.pedidosToken.length
  assert.deepEqual(await idp.renovar(semRefresh), { status: 'revogada' })
  assert.equal(srv.estado.pedidosToken.length, pedidos)
})

test('renovar: 5xx, outro erro OAuth e rede LANCAM normalizado (quem chama mantem a sessao)', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  const respostas = [
    [500, 'application/json', '{"error":"server_error"}'],
    [502, 'text/html', '<html>bad gateway</html>'],
    [503, 'application/json', '{"error":"invalid_grant"}'],   // invalid_grant só conta vindo com 400
    [401, 'application/json', '{"error":"invalid_client"}'],  // configuração errada não derruba a sessão de ninguém
  ]
  for (const [status, tipo, corpo] of respostas) {
    srv.estado.tokenEndpoint = (_req, res) => { res.writeHead(status, { 'content-type': tipo }); res.end(corpo) }
    await assert.rejects(idp.renovar(sessao), ehErroNormalizado, `${status} ${corpo}`)
  }
  srv.derrubar()
  await assert.rejects(idp.renovar(sessao), ehErroNormalizado, 'rede')
})

test('renovar: token novo sem erp-dominios na aud lanca (nao entrega sessao que o dominio recusaria)', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  srv.estado.ajustesRefresh = { accessToken: { aud: 'account' } }
  await assert.rejects(idp.renovar(sessao), ehErroNormalizado)
})

test('timeout ERP_DESTINO_TIMEOUT_MS vale para o IdP: token endpoint parado lanca dentro do prazo', async () => {
  const srv = await servidorOidc()
  await comAmbiente({ ERP_DESTINO_TIMEOUT_MS: '200' }, async () => {
    const idp = novoIdp(srv)
    const { sessao } = await logar(idp, srv)
    srv.estado.tokenEndpoint = () => {}   // nunca responde
    const t0 = Date.now()
    await assert.rejects(idp.renovar(sessao), ehErroNormalizado)
    assert.ok(Date.now() - t0 < 1_500, `demorou ${Date.now() - t0} ms`)
  })
})

test('redirecionamento do IdP nao e seguido (redirect: manual)', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  srv.estado.tokenEndpoint = (_req, res) => { res.writeHead(307, { location: `${srv.origem}/desvio` }); res.end() }
  await assert.rejects(idp.renovar(sessao), ehErroNormalizado)
  assert.equal(srv.estado.desvios, 0)
})

// --- encerrar ----------------------------------------------------------------------------------

test('encerrar: URL de logout do IdP so com client_id e post_logout_redirect_uri, sem token nenhum (vai ao navegador)', async () => {
  const srv = await servidorOidc()
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  assert.ok(sessao.idToken && sessao.accessToken && sessao.refreshToken, 'a sessao do teste precisa ter os tres tokens')
  const { urlLogout } = await idp.encerrar(sessao)
  const u = new URL(urlLogout)
  assert.equal(`${u.origin}${u.pathname}`, `${srv.emissor}/protocol/openid-connect/logout`)
  assert.equal(u.searchParams.get('client_id'), CLIENTE.clienteId)
  assert.equal(u.searchParams.get('post_logout_redirect_uri'), URL_POS_LOGOUT)
  assert.equal(u.searchParams.has('id_token_hint'), false, 'id_token_hint levaria o id_token ao navegador')
  for (const [nome, token] of Object.entries({ idToken: sessao.idToken, accessToken: sessao.accessToken, refreshToken: sessao.refreshToken })) {
    assert.ok(!urlLogout.includes(token) && !urlLogout.includes(encodeURIComponent(token)), `${nome} na URL de logout`)
  }
  assert.ok(!urlLogout.includes('eyJ'), 'nenhum JWT na URL de logout')
})

test('encerrar: IdP sem end_session_endpoint devolve null', async () => {
  const srv = await servidorOidc({ metadata: ({ end_session_endpoint: _e, ...m }) => m })
  const idp = novoIdp(srv)
  const { sessao } = await logar(idp, srv)
  assert.deepEqual(await idp.encerrar(sessao), { urlLogout: null })
})

// --- configuração ------------------------------------------------------------------------------

test('http:// so fora de producao: em producao o provedor recusa existir com emissor ou retorno http', async () => {
  await comAmbiente({ NODE_ENV: 'production' }, async () => {
    const base = { emissor: 'https://idp.example/realms/erp', ...CLIENTE, urlRetorno: 'https://erp.example/api/auth/retorno' }
    assert.doesNotThrow(() => identidadeOidc(base))
    assert.throws(() => identidadeOidc({ ...base, emissor: 'http://idp.example/realms/erp' }), /https/)
    assert.throws(() => identidadeOidc({ ...base, urlRetorno: 'http://erp.example/api/auth/retorno' }), /https/)
    assert.throws(() => identidadeOidc({ ...base, urlPosLogout: 'http://erp.example/' }), /https/)
  })
})

test('configuracao invalida e erro na criacao', () => {
  const base = { emissor: 'http://idp.test/realms/erp', ...CLIENTE, urlRetorno: URL_RETORNO }
  assert.doesNotThrow(() => identidadeOidc(base))
  const ruins = {
    'emissor nao e URL': { emissor: 'idp' },
    'emissor ftp': { emissor: 'ftp://idp.test/realms/erp' },
    'emissor com credencial': { emissor: 'http://u:s@idp.test/realms/erp' },
    'emissor com query': { emissor: 'http://idp.test/realms/erp?x=1' },
    'sem cliente': { clienteId: '' },
    'sem segredo': { clienteSegredo: '' },
    'retorno relativo': { urlRetorno: '/api/auth/retorno' },
    // D20, item 3: o IdP compara a redirect_uri inteira; query ou fragmento é erro de configuração
    'retorno com query': { urlRetorno: `${URL_RETORNO}?x=1` },
    'retorno com fragmento': { urlRetorno: `${URL_RETORNO}#x` },
    // `?` e `#` vazios: `search` e `hash` ficam vazios, mas o IdP compara o texto inteiro
    'retorno com query vazia': { urlRetorno: `${URL_RETORNO}?` },
    'retorno com fragmento vazio': { urlRetorno: `${URL_RETORNO}#` },
  }
  for (const [nome, ajuste] of Object.entries(ruins)) {
    assert.throws(() => identidadeOidc({ ...base, ...ajuste }), Error, nome)
  }
  for (const sufixo of ['?x=1', '#x', '?', '#', '?#']) {
    assert.throws(() => identidadeOidc({ ...base, urlRetorno: URL_RETORNO + sufixo }), /urlRetorno nao pode ter query nem fragmento/, sufixo)
  }
  // a mensagem de erro de configuração nunca carrega o segredo
  try { identidadeOidc({ ...base, emissor: 'idp' }) } catch (e) { assert.ok(!e.message.includes(CLIENTE.clienteSegredo)) }
})

test('ERP_DESTINO_TIMEOUT_MS invalido e erro na criacao', async () => {
  await comAmbiente({ ERP_DESTINO_TIMEOUT_MS: '0' }, async () => {
    assert.throws(() => identidadeOidc({ emissor: 'http://idp.test/realms/erp', ...CLIENTE, urlRetorno: URL_RETORNO }), /ERP_DESTINO_TIMEOUT_MS/)
  })
})

// --- fronteira: openid-client só no shell ------------------------------------------------------

const DIST = new URL('../dist/', import.meta.url).pathname
const arquivosJs = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? arquivosJs(p) : p.endsWith('.js') ? [p] : []
})
const importsDe = (arquivo) => [...readFileSync(arquivo, 'utf8').matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g)]
  .map((m) => m[1] ?? m[2])

test('openid-client so e importado por adaptadores/identidade-oidc e so /shell alcanca esse modulo', () => {
  const quemImporta = arquivosJs(DIST).filter((a) => importsDe(a).some((m) => /^(openid-client|oauth4webapi|jose)(\/|$)/.test(m)))
  assert.deepEqual(quemImporta.map((a) => relative(DIST, a)), ['adaptadores/identidade-oidc.js'])

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const alcancados = (entrada) => {
    const vistos = new Set()
    const pilha = [join(DIST, '..', entrada)]
    while (pilha.length) {
      const a = pilha.pop()
      if (vistos.has(a)) continue
      vistos.add(a)
      for (const m of importsDe(a)) if (m.startsWith('.')) pilha.push(join(a, '..', m))
    }
    return [...vistos].map((a) => relative(DIST, a))
  }
  for (const [subpath, alvo] of Object.entries(pkg.exports)) {
    const chega = alcancados(alvo.default).includes('adaptadores/identidade-oidc.js')
    assert.equal(chega, subpath === './shell', `${subpath} ${chega ? 'alcanca' : 'nao alcanca'} identidade-oidc`)
  }
  assert.equal(pkg.peerDependenciesMeta?.['openid-client']?.optional, true, 'openid-client e peer opcional: zona nao instala')
})

test('/shell publica identidadeOidc', async () => {
  const shell = await import('../dist/shell/index.js')
  assert.equal(shell.identidadeOidc, identidadeOidc)
})

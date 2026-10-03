// ADR-0013, decisão 6: o "Sair" da moldura é um formulário POST, e `sair` responde 303 para o logout
// do IdP. Com `form-action 'self'` o navegador barra esse redirecionamento; a CSP aceita a origem do
// IdP em `form-action`, e só a origem, validada (nada de caminho, curinga, aspas ou `;`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { politicaDeSeguranca, formularioDoLogout } from '../dist/borda/csp.js'

const formAction = (csp) => csp.split('; ').find((d) => d.startsWith('form-action'))

test('sem a opcao, a CSP e a de sempre: form-action so self', () => {
  assert.equal(politicaDeSeguranca('n1'),
    "default-src 'self'; script-src 'self' 'nonce-n1' 'strict-dynamic'; style-src 'self' 'nonce-n1'; " +
    "img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  assert.equal(politicaDeSeguranca('n1', {}), politicaDeSeguranca('n1'))
  assert.equal(politicaDeSeguranca('n1', { formularioPara: [] }), politicaDeSeguranca('n1'))
})

test('formularioPara poe a origem do IdP em form-action, ao lado de self, e nada mais muda', () => {
  const csp = politicaDeSeguranca('n1', { formularioPara: ['https://idp.exemplo:8443'] })
  assert.equal(formAction(csp), "form-action 'self' https://idp.exemplo:8443")
  assert.equal(csp.replace(" https://idp.exemplo:8443", ''), politicaDeSeguranca('n1'))
})

test('formularioPara recusa o que nao e so uma origem http(s): sem injecao na CSP', () => {
  for (const ruim of [
    'https://idp.exemplo/realms/erp', 'https://idp.exemplo/', 'https://idp.exemplo?x=1', 'https://idp.exemplo#x',
    "https://idp.exemplo; script-src 'unsafe-inline'", 'https://idp.exemplo https://mal.exemplo', ' https://idp.exemplo',
    "'unsafe-inline'", "'self'", '*', 'https://*.exemplo', 'https:', 'javascript:alert(1)', 'data:text/html,x',
    'ftp://idp.exemplo', 'https://u:p@idp.exemplo', 'idp.exemplo', '', 42, null,
  ]) {
    assert.throws(() => politicaDeSeguranca('n1', { formularioPara: [ruim] }), TypeError, String(ruim))
  }
})

test('formularioPara: http so fora de producao', () => {
  assert.equal(formAction(politicaDeSeguranca('n1', { formularioPara: ['http://localhost:8080'] })), "form-action 'self' http://localhost:8080")
  const antes = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    assert.throws(() => politicaDeSeguranca('n1', { formularioPara: ['http://localhost:8080'] }), TypeError)
    assert.ok(politicaDeSeguranca('n1', { formularioPara: ['https://idp.exemplo'] }).includes("form-action 'self' https://idp.exemplo;"))
  } finally {
    if (antes === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = antes
  }
})

test('formularioDoLogout: a origem do emissor, ou nada sem OIDC', () => {
  assert.deepEqual(formularioDoLogout(undefined), [])
  assert.deepEqual(formularioDoLogout(''), [])
  assert.deepEqual(formularioDoLogout('http://localhost:8080/realms/erp'), ['http://localhost:8080'])
  assert.deepEqual(formularioDoLogout('https://idp.exemplo/realms/erp'), ['https://idp.exemplo'])
  assert.throws(() => formularioDoLogout('nao e url'), TypeError)
})

// --- a CSP que a zona emite: criarProxy, com o next/server trocado por um falso que guarda os cabeçalhos ---

const FALSO = 'data:text/javascript,' + encodeURIComponent(`
  const resposta = (init) => ({ status: 200, headers: new Headers(), cookies: { set() {} }, init })
  export const NextResponse = { next: (init) => resposta(init), redirect: (url, status) => ({ status, url }) }
  export default {}
`)

async function criarProxyComNextFalso() {
  const ganchos = registerHooks({
    resolve: (esp, ctx, prox) => esp === 'next/server' ? { url: FALSO, shortCircuit: true } : prox(esp, ctx),
  })
  try {
    return (await import(`../dist/fabricas/criarProxy.js?v=${Math.random()}`)).criarProxy
  } finally {
    ganchos.deregister()
  }
}

const pedido = (caminho) => ({
  nextUrl: { pathname: caminho }, url: `http://localhost:3001${caminho}`, headers: new Headers(),
  cookies: { has: () => true, get: () => undefined },
})

async function cspDaZona(emissor) {
  const antes = process.env.IDP_EMISSOR
  if (emissor === undefined) delete process.env.IDP_EMISSOR
  else process.env.IDP_EMISSOR = emissor
  try {
    const criarProxy = await criarProxyComNextFalso()
    const proxy = criarProxy({ prefixo: '/zona1', rotaLogin: '/login' })
    return proxy(pedido('/zona1')).headers.get('content-security-policy')
  } finally {
    if (antes === undefined) delete process.env.IDP_EMISSOR
    else process.env.IDP_EMISSOR = antes
  }
}

test('zona com OIDC (IDP_EMISSOR): a CSP que o criarProxy emite aceita o formulario de logout para o IdP', async () => {
  assert.equal(formAction(await cspDaZona('http://localhost:8080/realms/erp')), "form-action 'self' http://localhost:8080")
})

test('zona sem OIDC: form-action continua so self', async () => {
  assert.equal(formAction(await cspDaZona(undefined)), "form-action 'self'")
})

test('criarProxy recusa formularioPara invalido na criacao, nao na primeira requisicao', async () => {
  const criarProxy = await criarProxyComNextFalso()
  assert.throws(() => criarProxy({ prefixo: '/zona1', rotaLogin: '/login', formularioPara: ["https://x; script-src *"] }), TypeError)
})

// ADR-0013, adendo 2: `http://` em produção só com ERP_PERMITIR_HTTP_LOCAL=1 e só para host de loopback.
// Uma regra só (`borda/http-local.ts`), usada pelo adaptador OIDC e pela CSP do logout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { httpPermitido, ehLoopback } from '../dist/borda/http-local.js'
import { politicaDeSeguranca, formularioDoLogout } from '../dist/borda/csp.js'
import { identidadeOidc } from '../dist/adaptadores/identidade-oidc.js'

const comAmbiente = (vars, fn) => {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    return fn()
  } finally {
    for (const [k, v] of Object.entries(antes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}
const PRODUCAO_COM_FLAG = { NODE_ENV: 'production', ERP_PERMITIR_HTTP_LOCAL: '1' }
const PRODUCAO_SEM_FLAG = { NODE_ENV: 'production', ERP_PERMITIR_HTTP_LOCAL: undefined }

const LOOPBACK = ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080', 'http://localhost', 'http://LOCALHOST:3000']
const FORA_DO_LOOPBACK = [
  'http://idp.exemplo', 'http://127.0.0.1.evil.example', 'http://localhost.example', 'http://localhost.', 'http://localhost@evil.example',
  'http://127.0.0.1@evil.example', 'http://evil.example#@localhost', 'http://[::ffff:127.0.0.1]', 'http://[::2]', 'http://[fe80::1]',
  'http://0.0.0.0', 'http://10.0.0.1', 'http://192.168.0.11', 'http://127.0.0.2.nip.io',
]

test('ehLoopback: so localhost, 127.0.0.1 e ::1, comparados pelo host ja normalizado', () => {
  for (const u of LOOPBACK) assert.equal(ehLoopback(new URL(u).hostname), true, u)
  for (const u of FORA_DO_LOOPBACK) assert.equal(ehLoopback(new URL(u).hostname), false, u)
  // formas que o parser normaliza para o mesmo endereço de loopback
  assert.equal(ehLoopback(new URL('http://[0:0:0:0:0:0:0:1]').hostname), true)
  assert.equal(ehLoopback('evil.example'), false)
  assert.equal(ehLoopback(''), false)
})

test('httpPermitido: fora de producao, http sempre; https sempre', () => {
  comAmbiente({ NODE_ENV: 'development', ERP_PERMITIR_HTTP_LOCAL: undefined }, () => {
    assert.equal(httpPermitido(new URL('http://idp.exemplo')), true)
  })
  comAmbiente(PRODUCAO_SEM_FLAG, () => assert.equal(httpPermitido(new URL('https://idp.exemplo')), true))
})

test('httpPermitido: em producao, sem a flag, nem loopback passa', () => {
  comAmbiente(PRODUCAO_SEM_FLAG, () => {
    for (const u of [...LOOPBACK, ...FORA_DO_LOOPBACK]) assert.equal(httpPermitido(new URL(u)), false, u)
  })
  // so o valor exato 1 liga, como ERP_PERMITIR_IDENTIDADE_DEV
  for (const v of ['true', 'sim', ' 1', '01', '']) {
    comAmbiente({ NODE_ENV: 'production', ERP_PERMITIR_HTTP_LOCAL: v }, () => {
      assert.equal(httpPermitido(new URL('http://127.0.0.1:8080')), false, JSON.stringify(v))
    })
  }
})

test('httpPermitido: em producao, com a flag, so loopback', () => {
  comAmbiente(PRODUCAO_COM_FLAG, () => {
    for (const u of LOOPBACK) assert.equal(httpPermitido(new URL(u)), true, u)
    for (const u of FORA_DO_LOOPBACK) assert.equal(httpPermitido(new URL(u)), false, u)
  })
})

test('CSP formularioPara: com a flag, origem http de loopback aceita em producao; fora do loopback, recusada', () => {
  comAmbiente(PRODUCAO_COM_FLAG, () => {
    assert.ok(politicaDeSeguranca('n', { formularioPara: ['http://127.0.0.1:8080'] }).includes("form-action 'self' http://127.0.0.1:8080;"))
    assert.ok(politicaDeSeguranca('n', { formularioPara: ['http://localhost:8080'] }).includes("form-action 'self' http://localhost:8080;"))
    assert.ok(politicaDeSeguranca('n', { formularioPara: ['http://[::1]:8080'] }).includes("form-action 'self' http://[::1]:8080;"))
    assert.deepEqual(formularioDoLogout('http://127.0.0.1:8080/realms/erp'), ['http://127.0.0.1:8080'])
    for (const o of ['http://idp.exemplo', 'http://127.0.0.1.evil.example', 'http://localhost.example', 'http://10.0.0.1:8080']) {
      assert.throws(() => politicaDeSeguranca('n', { formularioPara: [o] }), TypeError, o)
    }
    assert.throws(() => formularioDoLogout('http://localhost@evil.example/realms/erp'), TypeError)
    // a flag nao afrouxa a forma: credencial, caminho e IPv6 que nao e origem normalizada continuam fora
    for (const o of ['http://u:p@localhost:8080', 'http://localhost:8080/', 'http://[0:0:0:0:0:0:0:1]:8080', 'http://[::1];x']) {
      assert.throws(() => politicaDeSeguranca('n', { formularioPara: [o] }), TypeError, o)
    }
  })
  comAmbiente(PRODUCAO_SEM_FLAG, () => {
    assert.throws(() => politicaDeSeguranca('n', { formularioPara: ['http://127.0.0.1:8080'] }), TypeError)
    assert.throws(() => formularioDoLogout('http://127.0.0.1:8080/realms/erp'), TypeError)
  })
})

test('identidadeOidc: com a flag, emissor, retorno e pos-logout http de loopback aceitos em producao; o resto recusado', () => {
  const CLIENTE = { clienteId: 'erp-shell', clienteSegredo: 'segredo-de-teste' }
  const base = {
    emissor: 'http://127.0.0.1:8080/realms/erp', ...CLIENTE,
    urlRetorno: 'http://localhost:3000/api/auth/retorno', urlPosLogout: 'http://localhost:3000/login',
  }
  comAmbiente(PRODUCAO_COM_FLAG, () => {
    assert.doesNotThrow(() => identidadeOidc(base))
    assert.doesNotThrow(() => identidadeOidc({ ...base, emissor: 'http://[::1]:8080/realms/erp' }))
    for (const [campo, valor] of [
      ['emissor', 'http://idp.exemplo/realms/erp'], ['emissor', 'http://127.0.0.1.evil.example/realms/erp'],
      ['emissor', 'http://localhost@evil.example/realms/erp'], ['urlRetorno', 'http://erp.exemplo/api/auth/retorno'],
      ['urlRetorno', 'http://localhost.example:3000/api/auth/retorno'], ['urlPosLogout', 'http://erp.exemplo/login'],
    ]) {
      assert.throws(() => identidadeOidc({ ...base, [campo]: valor }), /https|credencial/, `${campo}=${valor}`)
    }
  })
  comAmbiente(PRODUCAO_SEM_FLAG, () => {
    assert.throws(() => identidadeOidc(base), /https em producao/)
    assert.throws(() => identidadeOidc({ ...base, emissor: 'https://idp.exemplo/realms/erp', urlPosLogout: undefined }), /urlRetorno.*https em producao/)
    assert.throws(() => identidadeOidc({ ...base, emissor: 'https://idp.exemplo/realms/erp', urlRetorno: 'https://erp.exemplo/api/auth/retorno' }), /urlPosLogout.*https em producao/)
  })
})

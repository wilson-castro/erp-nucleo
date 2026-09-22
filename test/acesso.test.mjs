import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessaoArquivo, sessaoArquivoDeEscrita } from '../dist/adaptadores/sessao-arquivo.js'
import { acessoHttp } from '../dist/adaptadores/acesso-http.js'
import { reduzirEu } from '../dist/interno/acesso-v2.js'
import { criarNucleo } from '../dist/fabricas/criarNucleo.js'
import { acessoFake } from '../dist/testing/index.js'
import { ErroDeAplicacao, NaoEncontrado, SessaoInvalida } from '../dist/interno/erros.js'

const dir = mkdtempSync(join(tmpdir(), 'acesso-'))
const ZONA1 = { id: 'zona1', nome: 'Zona 1', funcionalidades: ['painel.ver'] }
const EU = {
  pessoa: { id: 'p-1', nome: 'Ana', cpf: '52601815906', unidade: 'central', emailFuncional: 'ana@central.exemplo', status: 'ativo' },
  papeis: [],
  modulos: [ZONA1],
}

function nucleo(acesso, cookie = 'sid', destinos = {}) {
  return criarNucleo({ app: 'zona1', sessao: sessaoArquivo({ dir }), destinos, acesso,
                       lerCookieDeSessao: async () => cookie })
}

/**
 * Gestão de acesso falsa: `/v2/eu` responde o que `responder` fizer; `/v1/*` concederia tudo,
 * e cada chamada fica registrada. Fecha sempre, mesmo quando o teste reprova (auditor_b1_d1_2, L5).
 */
async function comGestao(responder, corpo) {
  const vistas = []
  const s = createServer((req, res) => {
    vistas.push({ url: req.url, auth: req.headers.authorization })
    if (req.url.startsWith('/v1/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify([{ id: 'zona1.painel', zona: 'zona1', rotulo: 'P', prefixo: '/zona1' }]))
    }
    responder(req, res)
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  try {
    await sessaoArquivoDeEscrita({ dir }).gravar('sid-http', { sub: 'ana', nome: 'Ana', accessToken: 'tk-ana', expiraEm: Date.now() + 60_000 })
    const n = nucleo(acessoHttp({ destino: 'gestao-acesso' }), 'sid-http', {
      'gestao-acesso': { origem: `http://127.0.0.1:${s.address().port}`, caminhos: ['/v2/eu', '/v1/modulos-permitidos'], metodos: ['GET'], credencial: 'usuario', timeoutMs: 300 },
    })
    await corpo(n, vistas)
  } finally {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
}

const json = (status, corpo) => (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(corpo)) }

test('exigirModulo passa com a funcionalidade e lanca NaoEncontrado (404) para o resto', async () => {
  await sessaoArquivoDeEscrita({ dir }).gravar('sid', { sub: 'ana', nome: 'Ana', accessToken: 't', expiraEm: Date.now() + 60_000 })
  const n = nucleo(acessoFake({ modulos: [ZONA1], administra: false }))
  await n.acesso.exigirModulo('zona1', 'painel.ver')
  await assert.rejects(() => n.acesso.exigirModulo('zona1', 'relatorios.ver'), NaoEncontrado)
  await assert.rejects(() => n.acesso.exigirModulo('zona2', 'tarefas.ver'), NaoEncontrado)
  await assert.rejects(() => n.acesso.exigirModulo('zona1'), TypeError)
  await assert.rejects(() => n.acesso.exigirPapel(), NaoEncontrado)
})

test('sem sessao, o acesso efetivo lanca SessaoInvalida antes de perguntar ao dominio', async () => {
  let perguntou = false
  const n = nucleo(() => ({ acessoEfetivo: async () => { perguntou = true; return { modulos: [], administra: false } } }), 'sid-inexistente')
  await assert.rejects(() => n.acesso.acessoEfetivo(), SessaoInvalida)
  assert.equal(perguntou, false)
})

test('acessoHttp pergunta /v2/eu com a credencial do usuario e guarda so modulos e administra', async () => {
  await comGestao(json(200, { ...EU, papeis: [{ papel: 'admin-geral', escopo: '*' }] }), async (n, vistas) => {
    const a = await n.acesso.acessoEfetivo()
    assert.deepEqual(a, { modulos: [ZONA1], administra: true })
    assert.ok(!JSON.stringify(a).includes('52601815906'), 'CPF chegou ao acesso efetivo')
    assert.ok(!JSON.stringify(a).includes('admin-geral'), 'nome de papel chegou ao acesso efetivo')
    assert.deepEqual(vistas, [{ url: '/v2/eu', auth: 'Bearer tk-ana' }])
  })
})

test('v2 recusa com 401 e a v1 concederia: nega (login) e nunca pergunta a v1', async () => {
  await comGestao(json(401, { codigo: 'SESSAO_EXPIRADA' }), async (n, vistas) => {
    await assert.rejects(() => n.acesso.exigirModulo('zona1', 'painel.ver'), SessaoInvalida)
    assert.deepEqual(vistas.map((v) => v.url), ['/v2/eu'])
  })
})

for (const [nome, responder] of [
  ['403', json(403, { codigo: 'OPERACAO_NAO_PERMITIDA' })],
  ['500', json(500, { codigo: 'ERRO_INTERNO' })],
  ['404 da propria rota (configuracao errada)', json(404, {})],
  ['timeout', () => { /* nunca responde */ }],
  ['corpo sem modulos', json(200, { pessoa: EU.pessoa, papeis: [] })],
  ['modulo com ponto no id', json(200, { ...EU, modulos: [{ ...ZONA1, id: 'zona1.painel' }] })],
  ['funcionalidade fora do formato', json(200, { ...EU, modulos: [{ ...ZONA1, funcionalidades: ['ver'] }] })],
]) {
  test(`v2 com ${nome}: erro, nunca lista, nunca 404, nunca a v1`, async () => {
    await comGestao(responder, async (n, vistas) => {
      await assert.rejects(() => n.acesso.acessoEfetivo(), (e) => e instanceof ErroDeAplicacao && !(e instanceof NaoEncontrado) && !(e instanceof SessaoInvalida))
      await assert.rejects(() => n.acesso.exigirModulo('zona1', 'painel.ver'), (e) => !(e instanceof NaoEncontrado))
      assert.ok(vistas.every((v) => v.url === '/v2/eu'), 'perguntou a v1')
    })
  })
}

test('reduzirEu: papeis vazios nao administram; papeis e modulos mal formados sao erro', () => {
  assert.deepEqual(reduzirEu(EU), { modulos: [ZONA1], administra: false })
  for (const ruim of [null, [], { ...EU, papeis: undefined }, { ...EU, papeis: [{ escopo: '*' }] },
                      { ...EU, modulos: [ZONA1, ZONA1] }, { ...EU, modulos: [{ id: 'zona1', funcionalidades: [] }] }]) {
    assert.throws(() => reduzirEu(ruim), ErroDeAplicacao, JSON.stringify(ruim))
  }
})

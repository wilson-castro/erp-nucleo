import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessaoArquivo, sessaoArquivoDeEscrita } from '../dist/adaptadores/sessao-arquivo.js'
import { identidadeDev } from '../dist/adaptadores/identidade-dev.js'
import { criarNucleo, criarNucleoDoShell } from '../dist/fabricas/criarNucleo.js'
import { acessoFake } from '../dist/testing/index.js'
import { SessaoInvalida } from '../dist/interno/erros.js'

const dir = mkdtempSync(join(tmpdir(), 'sessao-'))
const viva = (sub, extra = {}) => ({ sub, nome: sub, accessToken: `tk-${sub}`, expiraEm: Date.now() + 60_000, ...extra })

const zona = (cookie) => criarNucleo({
  app: 'zona', sessao: sessaoArquivo({ dir }), destinos: {},
  acesso: acessoFake([]), lerCookieDeSessao: async () => cookie,
})
const shell = (cookie) => criarNucleoDoShell({
  app: 'shell', sessao: sessaoArquivo({ dir }), destinos: {}, acesso: acessoFake([]),
  lerCookieDeSessao: async () => cookie,
  escrita: { store: sessaoArquivoDeEscrita({ dir }), identidade: identidadeDev() },
})

test('a sessao gravada pelo shell e lida por uma zona (arquivo, nao memoria)', async () => {
  await sessaoArquivoDeEscrita({ dir }).gravar('sid-1', viva('ana'))
  assert.equal((await zona('sid-1').sessao.atual()).sub, 'ana')
})

test('o store em modo leitura nao tem como gravar nem remover (N3)', () => {
  const leitor = sessaoArquivo({ dir })
  assert.deepEqual(Object.keys(leitor), ['ler'])
})

test('o nucleo de zona nao tem entrar nem encerrar; o do shell tem', () => {
  assert.deepEqual(Object.keys(zona().sessao).sort(), ['atual', 'exigir'])
  // nem com cast: criarNucleo ignora `escrita`
  const forjado = criarNucleo({ app: 'z', sessao: sessaoArquivo({ dir }), destinos: {}, acesso: acessoFake([]),
    lerCookieDeSessao: async () => undefined, escrita: { store: sessaoArquivoDeEscrita({ dir }), identidade: identidadeDev() } })
  assert.deepEqual(Object.keys(forjado.sessao).sort(), ['atual', 'exigir'])
  assert.deepEqual(Object.keys(shell().sessao).sort(), ['atual', 'encerrar', 'entrar', 'exigir'])
})

test('identidadeDev autentica os atores de desenvolvimento e recusa o resto', async () => {
  const idp = identidadeDev()
  for (const u of ['ana', 'bruno', 'carla', 'davi']) {
    const s = await idp.autenticar({ usuario: u })
    assert.equal(s.sub, u)
    assert.ok(s.accessToken.length > 0)
  }
  for (const u of ['ninguem', '__proto__', 'constructor', 'toString']) {
    assert.equal(await idp.autenticar({ usuario: u }), null, u)
  }
})

test('identidadeDev recusa rodar em producao sem opt-in explicito', () => {
  const antes = { ...process.env }
  process.env.NODE_ENV = 'production'
  delete process.env.ERP_PERMITIR_IDENTIDADE_DEV
  try { assert.throws(() => identidadeDev(), /producao/i) }
  finally { process.env.NODE_ENV = antes.NODE_ENV; if (antes.ERP_PERMITIR_IDENTIDADE_DEV) process.env.ERP_PERMITIR_IDENTIDADE_DEV = antes.ERP_PERMITIR_IDENTIDADE_DEV }
})

test('a sessao entregue a aplicacao so tem sub e nome', async () => {
  await sessaoArquivoDeEscrita({ dir }).gravar('sid-2', viva('bruno', { accessToken: 'token-secreto', perfis: ['x'] }))
  const s = await zona('sid-2').sessao.atual()
  assert.deepEqual(Object.keys(s).sort(), ['nome', 'sub'])
  assert.ok(!JSON.stringify(s).includes('token-secreto'))
})

test('entrar() devolve so o id opaco — o token nao chega a quem chama', async () => {
  const n = shell()
  const id = await n.sessao.entrar({ usuario: 'carla' })
  assert.equal(typeof id, 'string')
  assert.ok(!id.includes('dev.'), 'o id nao pode ser o token')
  const guardada = await sessaoArquivo({ dir }).ler(id)
  assert.ok(guardada.accessToken.startsWith('dev.carla.'))
  assert.equal(await n.sessao.entrar({ usuario: 'ninguem' }), null)
})

test('nenhum nucleo expoe store, identidade ou transporte cru', () => {
  for (const n of [zona(), shell()]) {
    assert.deepEqual(Object.keys(n).sort(), ['acesso', 'destino', 'sessao'])
    assert.equal(n.store, undefined)
    assert.equal(n.identidade, undefined)
  }
})

test('encerrar no shell acaba a sessao na zona; exigir destruturado continua funcionando', async () => {
  await sessaoArquivoDeEscrita({ dir }).gravar('sid-9', viva('davi'))
  const { exigir } = zona('sid-9').sessao
  assert.equal((await exigir()).sub, 'davi')
  await shell('sid-9').sessao.encerrar('sid-9')
  await assert.rejects(() => exigir(), SessaoInvalida)
})

test('sessao expirada e tratada como ausente', async () => {
  await sessaoArquivoDeEscrita({ dir }).gravar('sid-3', viva('ana', { expiraEm: Date.now() - 1 }))
  assert.equal(await zona('sid-3').sessao.atual(), null)
})

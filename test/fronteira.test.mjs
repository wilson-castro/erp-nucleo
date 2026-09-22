import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('o pacote publica exatamente cinco subpaths', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(),
                   ['.', './app', './permissoes', './proxy', './shell', './testing'])
})

test('invariante 15: a raiz nao entrega nada que escreva sessao ou autentique', async () => {
  const m = await import('../dist/index.js')
  for (const nome of ['criarNucleoDoShell', 'sessaoArquivoDeEscrita', 'sessaoRedisDeEscrita', 'identidadeDev', 'ATORES_DE_DESENVOLVIMENTO']) {
    assert.equal(m[nome], undefined, `${nome} esta na raiz`)
  }
  const s = await import('../dist/shell/index.js')
  for (const nome of ['criarNucleoDoShell', 'sessaoArquivoDeEscrita', 'sessaoRedisDeEscrita', 'identidadeDev']) {
    assert.equal(typeof s[nome], 'function', `${nome} ausente em /shell`)
  }
})

test('a raiz NAO arrasta next/server — senao o pacote nao carrega fora do Next', async () => {
  // next@16 nao publica campo `exports`, e sob ESM um subpath sem extensao em pacote
  // sem `exports` nao resolve. Com criarProxy na raiz, este proprio import falharia,
  // e com ele todo teste deste pacote.
  await import('../dist/index.js')
  const raiz = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')
  assert.ok(!raiz.includes('next/server'), 'a raiz importa next/server')
})

test('interno e adaptadores nao sao alcancaveis de fora', () => {
  // se algum dia alguem adicionar "./*" aos exports, este teste reprova
  assert.ok(!Object.keys(pkg.exports).some((k) => k.includes('*')),
            'exports com curinga expoe interno/ e adaptadores/')
})

test('a raiz exporta as fabricas e os adaptadores nomeados', async () => {
  const m = await import('../dist/index.js')
  for (const nome of ['criarNucleo', 'acessoHttp', 'sessaoArquivo', 'sessaoRedis', 'criarFragmento', 'responderFragmento', 'ErroDeAplicacao']) {
    assert.equal(typeof m[nome], 'function', `${nome} ausente na raiz`)
  }
})

test('a raiz NAO exporta o transporte cru', async () => {
  const m = await import('../dist/index.js')
  for (const nome of ['criarTransporte', 'montarUrl', 'validarRegistro', 'normalizar']) {
    assert.equal(m[nome], undefined, `${nome} vazou para a superficie publica`)
  }
})

test('o nucleo nao conhece dominio: nenhum arquivo fala de pedido', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = new URL('../src/', import.meta.url).pathname
  const todos = (d) => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? todos(join(d, n)) : [join(d, n)])
  for (const f of todos(src)) {
    assert.ok(!/pedido/i.test(readFileSync(f, 'utf8')), `${f} menciona pedido`)
  }
})

// --- auditor_b1_d1_2: V2 (N38) e V3 (N08, N43) -------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as juntar } from 'node:path'
import { temServerOnly, verificarFronteira } from '../scripts/fronteira.mjs'

const ESCRITORES = ['criarNucleoDoShell', 'sessaoArquivoDeEscrita', 'sessaoRedisDeEscrita', 'identidadeDev', 'ATORES_DE_DESENVOLVIMENTO']

test('invariante 15: NENHUM subpath fora de /shell entrega o que escreve sessao ou autentica', async () => {
  for (const [subpath, alvo] of Object.entries(pkg.exports)) {
    if (subpath === './shell') continue
    const arquivo = new URL(`../${alvo.default}`, import.meta.url)
    let nomes
    try {
      nomes = Object.keys(await import(arquivo.href))
    } catch {
      // ./proxy arrasta next/server, que nao carrega fora do Next: le as reexportacoes do arquivo
      nomes = [...readFileSync(arquivo, 'utf8').matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1])
    }
    for (const nome of ESCRITORES) assert.ok(!nomes.includes(nome), `${nome} esta em ${subpath}`)
  }
})

test('server-only conta so como instrucao de import, nunca em comentario', () => {
  assert.ok(temServerOnly("import 'server-only'\nexport const a = 1"))
  assert.ok(temServerOnly('import "server-only";'))
  for (const falso of [
    "// import 'server-only'\nexport const a = 1",
    "/* import 'server-only' */\nexport const a = 1",
    "/**\n * import 'server-only'\n */",
    "export const a = \"import 'server-only'\"",
  ]) assert.ok(!temServerOnly(falso), falso)
})

test('a fronteira reprova adaptador com server-only so em comentario', () => {
  const src = mkdtempSync(juntar(tmpdir(), 'fronteira-'))
  mkdirSync(juntar(src, 'adaptadores'))
  writeFileSync(juntar(src, 'adaptadores', 'x.ts'), "// sem import 'server-only' aqui\nexport const x = 1\n")
  assert.deepEqual(verificarFronteira(src), ["adaptadores/x.ts: falta import 'server-only'"])
})

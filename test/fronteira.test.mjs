import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('o pacote publica exatamente cinco subpaths', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(),
                   ['.', './permissoes', './proxy', './shell', './testing'])
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
  for (const nome of ['criarNucleo', 'acessoHttp', 'sessaoArquivo', 'sessaoRedis', 'ErroDeAplicacao']) {
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

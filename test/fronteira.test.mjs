import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('o pacote publica exatamente quatro subpaths', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(),
                   ['.', './permissoes', './proxy', './testing'])
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
  for (const nome of ['criarNucleo', 'dadosHttp',
                      'sessaoArquivo', 'identidadeDev', 'ErroDeAplicacao']) {
    assert.equal(typeof m[nome], 'function', `${nome} ausente na raiz`)
  }
})

test('a raiz NAO exporta upstream nem resolverDestino', async () => {
  const m = await import('../dist/index.js')
  assert.equal(m.upstream, undefined, 'upstream vazou para a superficie publica')
  assert.equal(m.resolverDestino, undefined, 'resolverDestino vazou')
})

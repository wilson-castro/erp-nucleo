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

/**
 * Carrega um subpath publicado. `./proxy` arrasta `next/server`, que não carrega fora do Next:
 * um hook de resolução troca só esse módulo por um stub, e o resto do grafo é o `dist` real.
 */
async function carregarSubpath(alvo) {
  const { registerHooks } = await import('node:module')
  const stub = 'data:text/javascript,export const NextResponse = {}; export default {}'
  const ganchos = registerHooks({
    resolve: (especificador, contexto, proximo) => especificador === 'next/server'
      ? { url: stub, shortCircuit: true } : proximo(especificador, contexto),
  })
  try {
    return await import(new URL(`../${alvo.default}`, import.meta.url).href)
  } finally {
    ganchos.deregister()
  }
}

test('invariante 15: NENHUM subpath fora de /shell entrega o que escreve sessao ou autentica', async () => {
  // auditor_b1_d1_3 (V2): comparar por nome deixava passar `sessaoRedisDeEscrita as lojaDeSessao`.
  // Compara-se a IDENTIDADE: nenhum valor exportado por /shell pode sair por outro subpath.
  const doShell = new Map(Object.entries(await import('../dist/shell/index.js')).map(([nome, v]) => [v, nome]))
  assert.ok(doShell.size >= ESCRITORES.length, 'o /shell deveria exportar os escritores')
  for (const [subpath, alvo] of Object.entries(pkg.exports)) {
    if (subpath === './shell') continue
    const m = await carregarSubpath(alvo)
    for (const [nome, valor] of Object.entries(m)) {
      assert.ok(!doShell.has(valor), `${subpath} exporta ${nome}, que e ${doShell.get(valor)} do /shell`)
      assert.ok(!ESCRITORES.includes(nome), `${nome} esta em ${subpath}`)
    }
  }
})

test('o teste de identidade tem dentes: um reexport renomeado de /shell e reconhecido', async () => {
  const shell = await import('../dist/shell/index.js')
  const doShell = new Set(Object.values(shell))
  const renomeado = { lojaDeSessao: shell.sessaoRedisDeEscrita, sessaoArquivoCompleta: shell.sessaoArquivoDeEscrita }
  for (const v of Object.values(renomeado)) assert.ok(doShell.has(v))
  // e o carregador de subpath realmente carrega o ./proxy (senao o laco acima pularia um subpath)
  assert.equal(typeof (await carregarSubpath(pkg.exports['./proxy'])).criarProxy, 'function')
})

test('server-only conta so como instrucao de import, nunca em comentario', () => {
  assert.ok(temServerOnly("import 'server-only'\nexport const a = 1"))
  assert.ok(temServerOnly('import "server-only";'))
  for (const falso of [
    "// import 'server-only'\nexport const a = 1",
    "/* import 'server-only' */\nexport const a = 1",
    "/**\n * import 'server-only'\n */",
    "export const a = \"import 'server-only'\"",
    // auditor_b1_d1_3 (N08b): a linha do meio de um template literal nao e instrucao
    "export const a = `\nimport 'server-only'\n`",
    "if (x) { import('server-only') }",
    "import x from 'server-only'",
  ]) assert.ok(!temServerOnly(falso), falso)
})

test('a fronteira reprova adaptador com server-only so em comentario', () => {
  const src = mkdtempSync(juntar(tmpdir(), 'fronteira-'))
  mkdirSync(juntar(src, 'adaptadores'))
  writeFileSync(juntar(src, 'adaptadores', 'x.ts'), "// sem import 'server-only' aqui\nexport const x = 1\n")
  assert.deepEqual(verificarFronteira(src), ["adaptadores/x.ts: falta import 'server-only'"])
})

test('a fronteira le import com aspas duplas, export…from e import() (auditor_b1_d1_3, V2/N38c)', () => {
  for (const linha of [
    'import { x } from "../fabricas/criarNucleo.js"',
    'export { x } from "../fabricas/criarNucleo.js"',
    'export const y = () => import("../fabricas/criarNucleo.js")',
  ]) {
    const src = mkdtempSync(juntar(tmpdir(), 'fronteira-'))
    mkdirSync(juntar(src, 'portas'))
    mkdirSync(juntar(src, 'fabricas'))
    writeFileSync(juntar(src, 'fabricas', 'criarNucleo.ts'), "import 'server-only'\nexport const x = 1\n")
    writeFileSync(juntar(src, 'portas', 'p.ts'), linha + '\n')
    assert.deepEqual(verificarFronteira(src), ['portas/p.ts: portas/ nao pode importar fabricas/'], linha)
  }
})

// --- auditor_b1_d1_4: V2 (N38d, N38e, N38f) ---
// os símbolos exclusivos vêm do `shell/index.ts` (auditor_b1_d1_8, V4): o src de brinquedo publica o seu
function publicarNoShell(src, nome, de) {
  mkdirSync(juntar(src, 'shell'), { recursive: true })
  writeFileSync(juntar(src, 'shell', 'index.ts'), `export { ${nome} } from '${de}'\n`)
}
test('N38d-f: simbolos exclusivos do shell nao podem ser importados ou embrulhados na raiz ou em app/', () => {
  // N38d: src/index.ts com export const sessaoRedisCompleta = (...a) => sessaoRedisDeEscrita(...a)
  const src1 = mkdtempSync(juntar(tmpdir(), 'fronteira-'))
  mkdirSync(juntar(src1, 'adaptadores'))
  writeFileSync(juntar(src1, 'adaptadores', 'sessao-redis.ts'), "import 'server-only'\nexport function sessaoRedisDeEscrita() {}\n")
  publicarNoShell(src1, 'sessaoRedisDeEscrita', '../adaptadores/sessao-redis.js')
  writeFileSync(juntar(src1, 'index.ts'), "import { sessaoRedisDeEscrita } from './adaptadores/sessao-redis.js'\nexport const sessaoRedisCompleta = (...a: any[]) => sessaoRedisDeEscrita(...a)\n")
  const erros1 = verificarFronteira(src1)
  assert.ok(erros1.some((e) => e.includes("simbolo exclusivo do shell 'sessaoRedisDeEscrita'")), 'deveria barrar embrulho na raiz')

  // N38e: src/app/index.ts com criarNucleoCompleto = (c) => criarNucleoDoShell(c)
  const src2 = mkdtempSync(juntar(tmpdir(), 'fronteira-'))
  mkdirSync(juntar(src2, 'app'))
  mkdirSync(juntar(src2, 'fabricas'))
  writeFileSync(juntar(src2, 'fabricas', 'criarNucleo.ts'), "import 'server-only'\nexport function criarNucleoDoShell() {}\n")
  publicarNoShell(src2, 'criarNucleoDoShell', '../fabricas/criarNucleo.js')
  writeFileSync(juntar(src2, 'app', 'index.ts'), "import 'server-only'\nimport { criarNucleoDoShell } from '../fabricas/criarNucleo.js'\nexport const criarNucleoCompleto = (c: any) => criarNucleoDoShell(c)\n")
  const erros2 = verificarFronteira(src2)
  assert.ok(erros2.some((e) => e.includes("simbolo exclusivo do shell 'criarNucleoDoShell'")), 'deveria barrar embrulho em app/')

  // N38f: src/app/index.ts com kit = { criar: criarNucleoDoShell }
  const src3 = mkdtempSync(juntar(tmpdir(), 'fronteira-'))
  mkdirSync(juntar(src3, 'app'))
  mkdirSync(juntar(src3, 'fabricas'))
  writeFileSync(juntar(src3, 'fabricas', 'criarNucleo.ts'), "import 'server-only'\nexport function criarNucleoDoShell() {}\n")
  publicarNoShell(src3, 'criarNucleoDoShell', '../fabricas/criarNucleo.js')
  writeFileSync(juntar(src3, 'app', 'index.ts'), "import 'server-only'\nimport { criarNucleoDoShell } from '../fabricas/criarNucleo.js'\nexport const kit = { criar: criarNucleoDoShell }\n")
  const erros3 = verificarFronteira(src3)
  assert.ok(erros3.some((e) => e.includes("simbolo exclusivo do shell 'criarNucleoDoShell'")), 'deveria barrar kit em app/')
})


// --- auditor_b1_d1_8: V4 (N38g, N38h, N38i, N38k, N38l; L4/FR2) ---
import { cpSync, readFileSync as ler, appendFileSync } from 'node:fs'
import { simbolosDoShell } from '../scripts/fronteira.mjs'

/** Cópia do `src/` real com as mudanças `{ arquivo: [de, para] | texto a acrescentar }`; devolve a raiz. */
function srcMutado(mudancas) {
  const src = juntar(mkdtempSync(juntar(tmpdir(), 'fronteira-')), 'src')
  cpSync(new URL('../src/', import.meta.url).pathname, src, { recursive: true })
  for (const [arquivo, m] of Object.entries(mudancas)) {
    const f = juntar(src, arquivo)
    if (typeof m === 'string') { appendFileSync(f, m); continue }
    const antes = ler(f, 'utf8')
    assert.equal(antes.split(m[0]).length, 2, `${arquivo}: texto da mutacao nao e unico`)
    writeFileSync(f, antes.replace(m[0], m[1]))
  }
  return src
}

test('V4: os simbolos do shell saem de shell/index.ts, com o definidor de cada um (nada escrito a mao)', () => {
  const s = simbolosDoShell()
  assert.deepEqual([...s.keys()].sort(), ['ATORES_DE_DESENVOLVIMENTO', 'criarNucleoDoShell', 'identidadeDev', 'sessaoArquivoDeEscrita', 'sessaoRedisDeEscrita'])
  assert.equal(s.get('sessaoRedisDeEscrita'), 'adaptadores/sessao-redis.ts')
  assert.deepEqual(verificarFronteira(srcMutado({})), [], 'a copia sem mudanca deveria passar')
})

test('V4 (N38l): escritor novo publicado em /shell e embrulhado em /app reprova sem ninguem mexer numa lista', () => {
  const src = srcMutado({
    'shell/index.ts': "export { renovarSessao } from '../fabricas/renovacao.js'\n",
    'app/index.ts': "import { renovarSessao } from '../fabricas/renovacao.js'\nexport const renovar = (id: string) => renovarSessao(id)\n",
  })
  writeFileSync(juntar(src, 'fabricas', 'renovacao.ts'), "import 'server-only'\nexport async function renovarSessao(id: string): Promise<string | null> { return id }\n")
  const erros = verificarFronteira(src)
  assert.ok(erros.some((e) => e.startsWith("app/index.ts: simbolo exclusivo do shell 'renovarSessao'")), JSON.stringify(erros))
})

test('V4 (N38k): adaptador de escrita novo exportado pela raiz reprova pelo tipo, com qualquer nome', () => {
  const src = srcMutado({ 'index.ts': "export { sessaoCompartilhada } from './adaptadores/sessao-compartilhada.js'\n" })
  writeFileSync(juntar(src, 'adaptadores', 'sessao-compartilhada.ts'),
    "import 'server-only'\nimport type { StoreDeSessao } from '../portas/sessao.js'\n" +
    'export function sessaoCompartilhada(): StoreDeSessao { return { ler: async () => null, gravar: async () => {}, remover: async () => {} } }\n')
  const erros = verificarFronteira(src)
  assert.ok(erros.some((e) => e.startsWith("index.ts: exporta 'sessaoCompartilhada'")), JSON.stringify(erros))
  assert.ok(erros.some((e) => e.startsWith("adaptadores/sessao-compartilhada.ts: exporta 'sessaoCompartilhada'")), JSON.stringify(erros))
})

test('V4 (N38g, N38h): embrulho no proprio arquivo definidor, reexportado por /app ou pela raiz, reprova', () => {
  const g = verificarFronteira(srcMutado({
    'fabricas/criarNucleo.ts': '\nexport const criarNucleoCompleto = (c: ConfigDoNucleoDoShell) => criarNucleoDoShell(c)\n',
    'app/index.ts': "export { criarNucleoCompleto } from '../fabricas/criarNucleo.js'\n",
  }))
  assert.ok(g.some((e) => e.startsWith("fabricas/criarNucleo.ts: simbolo exclusivo do shell 'criarNucleoDoShell'")), JSON.stringify(g))
  assert.ok(g.some((e) => e.startsWith("app/index.ts: exporta 'criarNucleoCompleto'")), JSON.stringify(g))
  const h = verificarFronteira(srcMutado({
    'adaptadores/sessao-redis.ts': '\nexport const sessaoRedisCompleta = sessaoRedisDeEscrita\n',
    'index.ts': "export { sessaoRedisCompleta } from './adaptadores/sessao-redis.js'\n",
  }))
  assert.ok(h.some((e) => e.startsWith("adaptadores/sessao-redis.ts: simbolo exclusivo do shell 'sessaoRedisDeEscrita'")), JSON.stringify(h))
  assert.ok(h.some((e) => e.startsWith("index.ts: exporta 'sessaoRedisCompleta'")), JSON.stringify(h))
})

test('V4 (N38i): o leitor da raiz que devolve o escritor sob uma opcao reprova', () => {
  const erros = verificarFronteira(srcMutado({
    'adaptadores/sessao-redis.ts': ['export function sessaoRedis(cfg: ConfigSessaoRedis<ClienteRedisDeLeitura>): LeitorDeSessao {\n',
      'export function sessaoRedis(cfg: ConfigSessaoRedis<ClienteRedisDeLeitura> & { escrita?: boolean }): LeitorDeSessao {\n' +
      '  if (cfg.escrita) return sessaoRedisDeEscrita(cfg as ConfigSessaoRedis)\n'],
  }))
  assert.ok(erros.some((e) => e.startsWith("adaptadores/sessao-redis.ts: simbolo exclusivo do shell 'sessaoRedisDeEscrita'")), JSON.stringify(erros))
})

test('V4 (N38i, publicado): os leitores da raiz so tem ler, com qualquer opcao a mais', async () => {
  const m = await import('../dist/index.js')
  const cliente = { get: async () => null, set: async () => 'OK', del: async () => 1 }
  assert.deepEqual(Object.keys(m.sessaoRedis({ cliente, escrita: true })), ['ler'])
  assert.deepEqual(Object.keys(m.sessaoArquivo({ dir: mkdtempSync(juntar(tmpdir(), 's-')), escrita: true })), ['ler'])
})

test('LC (auditor_b1_d1_9, N38q): fabrica assincrona Promise<StoreDeSessao> na raiz reprova pelo ramo de Promise', () => {
  const src = srcMutado({ 'index.ts': "export { obterStore } from './adaptadores/obter-store.js'\n" })
  writeFileSync(juntar(src, 'adaptadores', 'obter-store.ts'),
    "import 'server-only'\nimport type { StoreDeSessao } from '../portas/sessao.js'\n" +
    'export async function obterStore(): Promise<StoreDeSessao> { return { ler: async () => null, gravar: async () => {}, remover: async () => {} } }\n')
  const erros = verificarFronteira(src)
  assert.ok(erros.some((e) => e.startsWith("index.ts: exporta 'obterStore'")), JSON.stringify(erros))
  assert.ok(erros.some((e) => e.startsWith("adaptadores/obter-store.ts: exporta 'obterStore'")), JSON.stringify(erros))
})

test('LC (auditor_b1_d1_9, N38r): retorno em uniao (LeitorDeSessao | StoreDeSessao) na raiz reprova pelo ramo de uniao', () => {
  const src = srcMutado({ 'index.ts': "export { sessaoMista } from './adaptadores/sessao-mista.js'\n" })
  writeFileSync(juntar(src, 'adaptadores', 'sessao-mista.ts'),
    "import 'server-only'\nimport type { LeitorDeSessao, StoreDeSessao } from '../portas/sessao.js'\n" +
    'export function sessaoMista(opcao: boolean): LeitorDeSessao | StoreDeSessao {\n' +
    '  return opcao ? { ler: async () => null, gravar: async () => {}, remover: async () => {} } : { ler: async () => null }\n' +
    '}\n')
  const erros = verificarFronteira(src)
  assert.ok(erros.some((e) => e.startsWith("index.ts: exporta 'sessaoMista'")), JSON.stringify(erros))
  assert.ok(erros.some((e) => e.startsWith("adaptadores/sessao-mista.ts: exporta 'sessaoMista'")), JSON.stringify(erros))
})

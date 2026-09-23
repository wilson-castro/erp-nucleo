import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const SRC = new URL('../src/', import.meta.url).pathname

/** camada de origem -> camadas que ela PODE importar */
// `interno` pode ler `portas` porque portas são só tipos: não há código para criar ciclo.
// `borda`: código puro que roda no runtime de proxy do Next (CSP, trace); sem server-only.
const PERMITIDO = {
  borda:       ['borda'],
  interno:     ['interno', 'portas', 'borda'],
  portas:      ['portas'],
  adaptadores: ['adaptadores', 'portas', 'interno'],
  fabricas:    ['fabricas', 'adaptadores', 'portas', 'interno', 'borda'],
  permissoes:  ['permissoes'],
  testing:     ['testing', 'portas', 'interno'],
  shell:       ['fabricas', 'adaptadores', 'portas'],
  app:         ['fabricas', 'portas'],
}

function arquivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? arquivos(p) : p.endsWith('.ts') ? [p] : []
  })
}

const camadaDe = (caminho, src = SRC) => relative(src, caminho).split('/')[0]

const arvore = (texto) => ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)

/**
 * O módulo importa `server-only` como declaração de topo (`import 'server-only'`), lida pela
 * árvore do compilador: comentário, string ou template literal com o texto não contam
 * (auditor_b1_d1_3, V3/N08b).
 */
export const temServerOnly = (texto) => arvore(texto).statements.some((st) =>
  ts.isImportDeclaration(st) && !st.importClause && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === 'server-only')

/** Especificadores relativos que o módulo importa: import, export…from, import() e require(), com qualquer aspa. */
export function importsRelativos(texto) {
  const lista = []
  const literal = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null)
  const visitar = (no) => {
    let mod = null
    if ((ts.isImportDeclaration(no) || ts.isExportDeclaration(no)) && no.moduleSpecifier) mod = literal(no.moduleSpecifier)
    if (ts.isCallExpression(no) && (no.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(no.expression) && no.expression.text === 'require'))) mod = literal(no.arguments[0])
    if (mod?.startsWith('.')) lista.push(mod)
    ts.forEachChild(no, visitar)
  }
  visitar(arvore(texto))
  return lista
}

export function verificarFronteira(src = SRC) {
  const erros = []
  for (const arquivo of arquivos(src)) {
    const origem = camadaDe(arquivo, src)
    if (!(origem in PERMITIDO)) continue
    const texto = readFileSync(arquivo, 'utf8')

    for (const mod of importsRelativos(texto)) {
      const alvo = camadaDe(join(arquivo, '..', mod), src)
      if (!(alvo in PERMITIDO)) continue
      if (!PERMITIDO[origem].includes(alvo)) {
        erros.push(`${relative(src, arquivo)}: ${origem}/ nao pode importar ${alvo}/`)
      }
    }

    const precisaServerOnly = origem === 'interno' || origem === 'adaptadores' || origem === 'fabricas' || origem === 'app'
    const ehTipoPuro = origem === 'portas'
    if (precisaServerOnly && !ehTipoPuro && !temServerOnly(texto)) {
      // criarProxy roda no runtime de proxy do Next, que nao aceita server-only
      if (!arquivo.endsWith('criarProxy.ts')) {
        erros.push(`${relative(src, arquivo)}: falta import 'server-only'`)
      }
    }
    if (origem === 'borda' && temServerOnly(texto)) {
      erros.push(`${relative(src, arquivo)}: borda/ NAO pode ter server-only — roda no runtime de proxy`)
    }
    if (origem === 'permissoes' && temServerOnly(texto)) {
      erros.push(`${relative(src, arquivo)}: permissoes/ NAO pode ter server-only — as ilhas precisam dele`)
    }
  }

  return erros
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const erros = verificarFronteira()
  if (erros.length) {
    console.error('fronteira entre camadas violada:\n' + erros.map((e) => '  ' + e).join('\n'))
    process.exit(1)
  }
  console.log('fronteira entre camadas: ok')
}

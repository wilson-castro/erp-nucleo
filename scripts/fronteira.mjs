import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const SRC = new URL('../src/', import.meta.url).pathname

/** camada de origem -> camadas que ela PODE importar */
// `interno` pode ler `portas` porque portas são só tipos: não há código para criar ciclo.
// `borda`: código puro que roda no runtime de proxy do Next (CSP, trace); sem server-only.
const PERMITIDO = {
  raiz:        ['fabricas', 'adaptadores', 'portas', 'permissoes', 'borda', 'interno'],
  borda:       ['borda'],
  interno:     ['interno', 'portas', 'borda'],
  portas:      ['portas'],
  adaptadores: ['adaptadores', 'portas', 'interno'],
  fabricas:    ['fabricas', 'adaptadores', 'portas', 'interno', 'borda'],
  permissoes:  ['permissoes'],
  testing:     ['testing', 'portas', 'interno'],
  shell:       ['fabricas', 'adaptadores', 'portas', 'shell'],
  app:         ['fabricas', 'portas'],
}

/**
 * Símbolos exclusivos do shell, DERIVADOS de `shell/index.ts` (auditor_b1_d1_8, V4): cada valor que ele
 * reexporta, com o arquivo que o define. Uma lista escrita à mão deixava passar o escritor novo que o D2
 * vai acrescentar (renovação); aqui ele entra sozinho ao ser publicado em `/shell`.
 * Nome → arquivo definidor, relativo a `src`.
 */
export function simbolosDoShell(src = SRC) {
  const indice = join(src, 'shell', 'index.ts')
  const mapa = new Map()
  let sf
  try { sf = arvore(readFileSync(indice, 'utf8')) } catch { return mapa }
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.isTypeOnly || !st.moduleSpecifier || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue
    const definidor = relative(src, join(indice, '..', st.moduleSpecifier.text.replace(/\.js$/, '.ts')))
    for (const e of st.exportClause.elements) {
      if (!e.isTypeOnly) mapa.set((e.propertyName ?? e.name).text, definidor)
    }
  }
  return mapa
}

/** Nomes que, no tipo de um valor, só quem escreve sessão ou autentica tem (portas/sessao.ts, portas/identidade.ts, NucleoDoShell). */
const CAPACIDADES_DE_ESCRITA = new Set([
  'gravar', 'remover', 'regravar', 'gravarTransacao', 'consumirTransacao', 'adquirirLockRenovacao',
  'iniciar', 'concluir', 'renovar', 'encerrar',
  'iniciarLogin', 'concluirLogin', 'renovarSessao', 'encerrarSessao',
  // nomes da porta anterior à 0.10.0: um embrulho que os recriasse continua reprovado
  'autenticar', 'entrar',
])

/** O tipo dá acesso a escrita de sessão ou a autenticação: por propriedade, retorno (inclusive Promise) ou membro de união. */
function temEscrita(checker, tipo, vistos = new Set(), profundidade = 0) {
  if (!tipo || vistos.has(tipo) || profundidade > 6) return false
  vistos.add(tipo)
  if (tipo.isUnionOrIntersection() && tipo.types.some((t) => temEscrita(checker, t, vistos, profundidade + 1))) return true
  const aguardado = checker.getAwaitedType(tipo)
  if (aguardado && aguardado !== tipo && temEscrita(checker, aguardado, vistos, profundidade + 1)) return true
  for (const assinatura of [...tipo.getCallSignatures(), ...tipo.getConstructSignatures()]) {
    if (temEscrita(checker, assinatura.getReturnType(), vistos, profundidade + 1)) return true
  }
  for (const prop of checker.getPropertiesOfType(tipo)) {
    if (CAPACIDADES_DE_ESCRITA.has(prop.name)) return true
    const decl = prop.valueDeclaration ?? prop.declarations?.[0]
    if (decl && temEscrita(checker, checker.getTypeOfSymbolAtLocation(prop, decl), vistos, profundidade + 1)) return true
  }
  return false
}

/**
 * Regra por tipo (auditor_b1_d1_8, V4: N38g, N38h, N38k): fora de `shell/`, nenhum arquivo exporta valor
 * que dê escrita de sessão ou autenticação, venha com o nome que vier. A única exceção é o definidor
 * exportando o próprio símbolo que `/shell` publica. `testing/` fica fora: `sessaoMemoria` grava só num
 * `Map` do próprio processo, nunca no store que o shell usa.
 */
function exportsComEscrita(src, simbolos) {
  const todos = arquivos(src)
  const programa = ts.createProgram({
    rootNames: todos,
    options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, noEmit: true, skipLibCheck: true, types: [] },
  })
  const checker = programa.getTypeChecker()
  const erros = []
  for (const arquivo of todos) {
    const camada = camadaDe(arquivo, src)
    if (camada === 'shell' || camada === 'testing') continue
    const sf = programa.getSourceFile(arquivo)
    const modulo = sf && checker.getSymbolAtLocation(sf)
    if (!modulo) continue
    const rel = relative(src, arquivo)
    for (const exportado of checker.getExportsOfModule(modulo)) {
      const reexport = (exportado.flags & ts.SymbolFlags.Alias) !== 0
      const alvo = reexport ? checker.getAliasedSymbol(exportado) : exportado
      if (!(alvo.flags & ts.SymbolFlags.Value)) continue
      const decl = alvo.valueDeclaration ?? alvo.declarations?.[0]
      if (!decl || !temEscrita(checker, checker.getTypeOfSymbolAtLocation(alvo, decl), new Set())) continue
      const doDefinidor = !reexport && simbolos.get(exportado.name) === rel
      if (!doDefinidor) erros.push(`${rel}: exporta '${exportado.name}', que escreve sessao ou autentica: so /shell publica isso`)
    }
  }
  return erros
}

function arquivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? arquivos(p) : p.endsWith('.ts') ? [p] : []
  })
}

const camadaDe = (caminho, src = SRC) => {
  const rel = relative(src, caminho)
  const primeira = rel.split('/')[0]
  if (primeira.endsWith('.ts')) return 'raiz'
  return primeira
}

const arvore = (texto) => ts.createSourceFile('x.ts', texto, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

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
  const simbolos = simbolosDoShell(src)
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

    if (origem !== 'shell') {
      const relArquivo = relative(src, arquivo)
      const sf = arvore(texto)
      const checarNo = (no) => {
        if (ts.isIdentifier(no) && simbolos.has(no.text)) {
          // no definidor vale só a declaração; embrulho ou reexport ali mesmo reprova (N38g, N38h, N38i)
          const ehDeclaracao = relArquivo === simbolos.get(no.text) && no.parent?.name === no
            && (ts.isFunctionDeclaration(no.parent) || ts.isVariableDeclaration(no.parent) || ts.isClassDeclaration(no.parent))
          if (!ehDeclaracao) {
            erros.push(`${relArquivo}: simbolo exclusivo do shell '${no.text}' nao pode ser importado ou usado fora de shell/`)
          }
        }
        ts.forEachChild(no, checarNo)
      }
      checarNo(sf)
    }
  }

  erros.push(...exportsComEscrita(src, simbolos))
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

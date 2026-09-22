import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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

/** Tira comentários: um comentário que contém o texto do import não é o import (auditor_b1_d1_2, N08). */
export const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')

/** O módulo importa `server-only` como instrução, numa linha própria, fora de comentário. */
export const temServerOnly = (texto) => /^\s*import\s+['"]server-only['"]\s*;?\s*$/m.test(semComentarios(texto))

export function verificarFronteira(src = SRC) {
  const erros = []
  for (const arquivo of arquivos(src)) {
    const origem = camadaDe(arquivo, src)
    if (!(origem in PERMITIDO)) continue
    const texto = semComentarios(readFileSync(arquivo, 'utf8'))

    for (const m of texto.matchAll(/from\s+'(\.[^']+)'/g)) {
      const alvo = camadaDe(join(arquivo, '..', m[1]), src)
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

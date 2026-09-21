import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname

/** camada de origem -> camadas que ela PODE importar */
const PERMITIDO = {
  interno:     ['interno', 'portas'],
  portas:      ['portas'],
  adaptadores: ['adaptadores', 'portas', 'interno'],
  fabricas:    ['fabricas', 'adaptadores', 'portas', 'interno'],
  permissoes:  ['permissoes'],
  testing:     ['testing', 'portas', 'interno'],
}

function arquivos(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? arquivos(p) : p.endsWith('.ts') ? [p] : []
  })
}

const camadaDe = (caminho) => relative(SRC, caminho).split('/')[0]
const erros = []

for (const arquivo of arquivos(SRC)) {
  const origem = camadaDe(arquivo)
  if (!(origem in PERMITIDO)) continue
  const texto = readFileSync(arquivo, 'utf8')

  for (const m of texto.matchAll(/from\s+'(\.[^']+)'/g)) {
    const alvo = camadaDe(join(arquivo, '..', m[1]))
    if (!(alvo in PERMITIDO)) continue
    if (!PERMITIDO[origem].includes(alvo)) {
      erros.push(`${relative(SRC, arquivo)}: ${origem}/ nao pode importar ${alvo}/`)
    }
  }

  const precisaServerOnly = origem === 'interno' || origem === 'adaptadores' || origem === 'fabricas'
  const ehTipoPuro = origem === 'portas'
  if (precisaServerOnly && !ehTipoPuro && !texto.includes("import 'server-only'")) {
    // criarProxy roda no runtime de proxy do Next, que nao aceita server-only
    if (!arquivo.endsWith('criarProxy.ts')) {
      erros.push(`${relative(SRC, arquivo)}: falta import 'server-only'`)
    }
  }
  if (origem === 'permissoes' && texto.includes("import 'server-only'")) {
    erros.push(`${relative(SRC, arquivo)}: permissoes/ NAO pode ter server-only — as ilhas precisam dele`)
  }
}

if (erros.length) {
  console.error('fronteira entre camadas violada:\n' + erros.map((e) => '  ' + e).join('\n'))
  process.exit(1)
}
console.log('fronteira entre camadas: ok')

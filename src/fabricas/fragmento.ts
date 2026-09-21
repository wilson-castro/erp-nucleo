import 'server-only'
import { ErroDeAplicacao } from '../interno/erros.js'

/**
 * Fragmento entre zonas (ADR-0011): uma zona embute no HTML do servidor um bloco que outra
 * zona renderiza. Contrato HTTP em `docs/design-bff/mfe/02-zonas.md` §2.
 */

const VERSAO = '1'
const CABECALHO_VERSAO = 'accept-fragmento-versao'
const TIMEOUT_PADRAO_MS = 2_000
const NOME = /^[a-z0-9][a-z0-9-]*$/
const CONTROLE = /[\u0000-\u001f\u007f]/
/**
 * HTML de fragmento é inerte: sem script, sem manipulador inline, sem URL `javascript:`,
 * sem documento embutido. Cada zona tem o próprio nonce de CSP; script de outra zona
 * rodaria com o nonce errado ou abriria de volta o problema que tirou o Module Federation.
 */
const ATIVO = /<\s*(script|iframe|object|embed|frame)\b|\son[a-z]+\s*=|javascript\s*:|\ssrcdoc\s*=/i

export const ehHtmlInerte = (html: string): boolean => !ATIVO.test(html)

// ---------------------------------------------------------------- consumidor

export type ZonaDona = {
  /** Só origem (`http://zona2.interno:3002`), nunca caminho. Rede interna. */
  origem: string
  /** Nomes de fragmento que esta app pode pedir a essa zona. */
  fragmentos: readonly string[]
}

export type ConfigDoFragmento = {
  /** Registro local da app consumidora: id da zona → origem e fragmentos permitidos. */
  zonas: Readonly<Record<string, ZonaDona>>
  lerCookieDeSessao: () => Promise<string | undefined>
  timeoutMs?: number
  fetch?: typeof fetch
}

export type ClienteDeFragmento = {
  /** HTML inerte, ou `null` para qualquer ausência ou falha. Nunca lança. */
  buscar(zona: string, nome: string, id: string): Promise<string | null>
}

function recusar(zona: string, motivo: string): never {
  throw new Error(`registro de fragmento: "${zona}" ${motivo}`)
}

export function criarFragmento(cfg: ConfigDoFragmento): ClienteDeFragmento {
  const zonas = new Map<string, { url: URL; fragmentos: ReadonlySet<string> }>()
  for (const [id, z] of Object.entries(cfg.zonas)) {
    if (!NOME.test(id)) recusar(id, 'tem id invalido')
    let url: URL
    try { url = new URL(z.origem) } catch { recusar(id, 'tem origem invalida') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') recusar(id, 'precisa de http ou https')
    if (url.username || url.password) recusar(id, 'nao pode carregar credencial na URL')
    if (url.pathname !== '/' || url.search || url.hash) recusar(id, 'deve ser so origem, sem caminho')
    if (!Array.isArray(z.fragmentos) || z.fragmentos.some((n) => !NOME.test(n))) recusar(id, 'tem nome de fragmento invalido')
    zonas.set(id, { url, fragmentos: new Set(z.fragmentos) })
  }
  const buscar = cfg.fetch ?? fetch
  const timeoutMs = cfg.timeoutMs ?? TIMEOUT_PADRAO_MS

  return {
    async buscar(zona, nome, id) {
      // Map, não objeto: `__proto__` e `constructor` não resolvem para nada
      const z = zonas.get(zona)
      if (!z || !z.fragmentos.has(nome)) return null
      if (typeof id !== 'string' || id.length === 0 || id.length > 256 || id === '.' || id === '..' || CONTROLE.test(id)) return null

      try {
        const sessao = await cfg.lerCookieDeSessao()
        if (!sessao) return null
        const caminho = `/${zona}/_fragmento/${nome}/${encodeURIComponent(id)}`
        const url = new URL(caminho, z.url)
        if (url.origin !== z.url.origin || url.pathname !== caminho) return null

        const res = await buscar(url, {
          method: 'GET',
          // a zona dona resolve quem é o usuário pelo cookie; a chamadora nunca afirma identidade
          headers: { cookie: `__Host-session=${sessao}`, accept: 'text/html', [CABECALHO_VERSAO]: VERSAO },
          cache: 'no-store',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (res.status !== 200) return null
        if (!/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) return null
        const html = await res.text()
        return ehHtmlInerte(html) ? html : null
      } catch {
        // queda, timeout ou recusa da dona: o bloco some, a página segue
        return null
      }
    },
  }
}

// ---------------------------------------------------------------- dono

const CABECALHOS_BASE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
const vazio = (status: 204 | 404 | 500) => new Response(null, { status, headers: CABECALHOS_BASE })

/** `notFound()` do Next lança um erro com este `digest`; aqui ele vira ausência. */
const ehNaoEncontradoDoNext = (e: unknown) =>
  typeof (e as { digest?: unknown })?.digest === 'string'
  && (e as { digest: string }).digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404')

/**
 * Responde a rota `app/{zona}/_fragmento/{nome}/[id]/route.ts`. `produzir` verifica sessão e
 * módulo (use `nucleo.acesso.exigirModulo`, que lança `NaoEncontrado`) e devolve o HTML ou `null`.
 */
export async function responderFragmento(
  req: Request, produzir: () => Promise<string | null>,
): Promise<Response> {
  // navegação de documento ou iframe não é composição: o fragmento não existe para o navegador
  const destino = req.headers.get('sec-fetch-dest')
  if (destino !== null && destino !== 'empty') return vazio(404)
  const versao = req.headers.get(CABECALHO_VERSAO)
  if (versao !== null && versao !== VERSAO) return vazio(204)

  let html: string | null
  try {
    html = await produzir()
  } catch (e) {
    // módulo negado, sessão inválida, recurso fora do escopo: a mesma ausência (invariante 8)
    if (e instanceof ErroDeAplicacao || ehNaoEncontradoDoNext(e)) return vazio(204)
    return vazio(500)
  }
  if (html === null) return vazio(204)
  // bug de composição no dono: ruidoso aqui, ausência na consumidora (ADR-0011, decisão 7)
  if (!ehHtmlInerte(html)) return vazio(500)
  return new Response(html, {
    status: 200, headers: { ...CABECALHOS_BASE, 'content-type': 'text/html; charset=utf-8' },
  })
}

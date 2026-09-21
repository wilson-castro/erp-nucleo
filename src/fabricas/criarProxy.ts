import { NextResponse, type NextRequest } from 'next/server'

export type ConfigDoProxy = {
  /** prefixo da aplicação, ex.: '/zona1'. O shell usa '/'. */
  prefixo: string
  /** para onde mandar quem não tem cookie, ex.: '/login' */
  rotaLogin: string
  /** Caminhos que não exigem cookie, por prefixo. O shell põe aqui login e /api/auth/. */
  publicos?: readonly string[]
  /**
   * Prefixos que pertencem a OUTRA aplicação. O shell põe aqui as zonas: a zona aplica
   * o próprio proxy e a própria CSP, e duas CSPs com nonces diferentes bloqueariam os
   * scripts da zona.
   */
  outrasAplicacoes?: readonly string[]
  nomeDoCookie?: string
}

const dentro = (caminho: string, prefixo: string) =>
  prefixo === '/' || caminho === prefixo || caminho.startsWith(prefixo.endsWith('/') ? prefixo : `${prefixo}/`)

/**
 * Camada 1 das quatro verificações — e a única que roda em TODA requisição,
 * inclusive prefetch de `<Link>`. Por isso faz ZERO I/O: só olha se o cookie
 * existe. Um cookie forjado passa daqui, e a camada 2 o rejeita.
 * Ver 06-seguranca.md §2.
 */
export function criarProxy(cfg: ConfigDoProxy) {
  const nome = cfg.nomeDoCookie ?? '__Host-session'
  return function proxy(req: NextRequest): NextResponse {
    const caminho = req.nextUrl.pathname
    // Fora do próprio prefixo, a aplicação não opina.
    if (!dentro(caminho, cfg.prefixo)) return NextResponse.next()
    if (cfg.outrasAplicacoes?.some((p) => dentro(caminho, p))) return NextResponse.next()

    const publico = cfg.publicos?.some((p) => dentro(caminho, p)) ?? false
    if (!publico && !req.cookies.has(nome)) {
      // O Next 16 recusa Location relativo vindo do proxy (`new URL(location)` sem base
      // lança "Invalid URL" e a resposta vira 500). Monta-se a URL sobre a própria
      // requisição, e o Next a devolve RELATIVA quando a origem coincide — assim a
      // origem interna da zona nunca aparece para o navegador, que resolve o caminho
      // contra o documento atual, servido pelo shell.
      const destino = new URL(`${cfg.rotaLogin}?de=${encodeURIComponent(caminho)}`, req.url)
      return NextResponse.redirect(destino, 307)
    }

    const nonce = crypto.randomUUID().replaceAll('-', '')
    const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
      `style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; object-src 'none'; ` +
      `base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
    // O Next lê o nonce do cabeçalho CSP da REQUISIÇÃO para marcar os próprios scripts.
    // Só na resposta, a página chegaria com scripts sem nonce e o navegador os bloquearia.
    const headers = new Headers(req.headers)
    headers.set('x-nonce', nonce)
    headers.set('Content-Security-Policy', csp)
    // Layouts não recebem o caminho; a moldura precisa dele para marcar o módulo ativo.
    headers.set('x-erp-caminho', caminho)
    const res = NextResponse.next({ request: { headers } })
    res.headers.set('Content-Security-Policy', csp)
    return res
  }
}

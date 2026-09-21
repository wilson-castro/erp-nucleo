import { NextResponse, type NextRequest } from 'next/server'

export type ConfigDoProxy = {
  /** prefixo da zona, ex.: '/pedidos' */
  prefixo: string
  /** para onde mandar quem não tem cookie, ex.: '/login' */
  rotaLogin: string
  nomeDoCookie?: string
}

/**
 * Camada 1 das quatro verificações — e a única que roda em TODA requisição,
 * inclusive prefetch de `<Link>`. Por isso faz ZERO I/O: só olha se o cookie
 * existe. Um cookie forjado passa daqui, e a camada 2 o rejeita.
 * Ver 06-seguranca.md §2.
 */
export function criarProxy(cfg: ConfigDoProxy) {
  const nome = cfg.nomeDoCookie ?? '__Host-session'
  return function proxy(req: NextRequest): NextResponse {
    const nonce = crypto.randomUUID().replaceAll('-', '')

    // Fora do próprio prefixo, a zona não opina. O `matcher` já deveria garantir isso;
    // esta linha faz o proxy virar no-op se alguém configurar o matcher errado, em vez
    // de a zona passar a redirecionar rota que não é dela.
    if (!req.nextUrl.pathname.startsWith(cfg.prefixo)) return NextResponse.next()

    if (!req.cookies.has(nome)) {
      // Location RELATIVO, de propósito. `NextResponse.redirect` exige URL absoluta e
      // montaria http://localhost:3001/login — a origem da ZONA, que o navegador nunca
      // deve ver. O usuário fala só com o shell. Um Location relativo é válido em HTTP
      // e o navegador o resolve contra o documento atual, que é o shell.
      const destino = `${cfg.rotaLogin}?de=${encodeURIComponent(req.nextUrl.pathname)}`
      return NextResponse.redirect(new URL(destino, req.url), 307)
    }

    const headers = new Headers(req.headers)
    headers.set('x-nonce', nonce)
    headers.set('x-erp-caminho', req.nextUrl.pathname)
    headers.delete('x-erp-flash')
    const flash = req.cookies.get('__Host-flash')?.value
    if (flash) headers.set('x-erp-flash', flash)

    const res = NextResponse.next({ request: { headers } })
    if (flash) {
      res.cookies.set('__Host-flash', '', { path: '/', maxAge: 0 })
    }
    res.headers.set('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
      `style-src 'self' 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`)
    return res
  }
}

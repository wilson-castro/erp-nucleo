import 'server-only'
import { DestinoInvalido, normalizar, type Resposta } from './erros.js'

export { DestinoInvalido }

/**
 * Elemento 7 do núcleo. Nenhuma parte do destino vem do cliente, e o resultado
 * precisa continuar na mesma origem da base. Exigência da RFC 10017.
 */
export function resolverDestino(base: URL, path: string): URL {
  if (!path.startsWith('/')) throw new DestinoInvalido()
  if (path.startsWith('//') || path.startsWith('/\\')) throw new DestinoInvalido()
  let url: URL
  try { url = new URL(path, base) } catch { throw new DestinoInvalido() }
  if (url.origin !== base.origin) throw new DestinoInvalido()
  return url
}

export type OpcoesUpstream = RequestInit & { ifMatch?: string }

export async function upstream<T>(
  cfg: { base: URL; obterToken: () => Promise<string> },
  path: string,
  init: OpcoesUpstream = {},
): Promise<Resposta<T>> {
  const url = resolverDestino(cfg.base, path)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${await cfg.obterToken()}`)
  headers.set('Accept', 'application/json')
  if (init.body) headers.set('Content-Type', 'application/json')
  if (init.ifMatch) headers.set('If-Match', init.ifMatch)

  const res = await fetch(url, {
    ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  return normalizar<T>(res)
}

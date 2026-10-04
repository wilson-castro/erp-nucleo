/**
 * A regra de `http://` do núcleo, num lugar só (ADR-0013, decisão 5 e adendo 2). Usada pelo adaptador OIDC
 * (emissor, retorno, pós-logout) e pela CSP (`formularioPara`), para os dois nunca discordarem.
 *
 * - Fora de produção: `http://` vale.
 * - Em produção: só com `ERP_PERMITIR_HTTP_LOCAL=1` (valor exato, como `ERP_PERMITIR_IDENTIDADE_DEV`) e só
 *   para host de loopback. Serve para a base verificar o build de produção na máquina local contra o
 *   Keycloak do showcase; quem liga é a tarefa do showcase ou da verificação, nunca o script da app.
 *
 * Em `borda/` (código puro, sem `server-only`) porque a CSP também usa; o adaptador OIDC a recebe por
 * `interno/configuracao.ts`. Lê o ambiente a cada chamada.
 */

/** Hosts de loopback aceitos, já na forma que o parser de URL produz (`URL.hostname`). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * `hostname` é de loopback? Compara com o host já normalizado pelo `URL` (minúsculas, IPv6 comprimido),
 * por igualdade: `127.0.0.1.evil.example`, `localhost.example` e `localhost.` não são loopback, e o
 * `localhost@evil.example` tem `evil.example` como host.
 */
export function ehLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname)
}

/** `url` pode ser usada? `https:` sempre; `http:` fora de produção, ou em produção com a flag e loopback. */
export function httpPermitido(url: URL): boolean {
  if (url.protocol !== 'http:') return true
  if (process.env.NODE_ENV !== 'production') return true
  return process.env.ERP_PERMITIR_HTTP_LOCAL === '1' && ehLoopback(url.hostname)
}

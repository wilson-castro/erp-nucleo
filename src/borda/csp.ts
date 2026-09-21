/**
 * A CSP de toda aplicação da base (ADR-0012). Um lugar só: o shell copiava a política e perdeu
 * `form-action` (que não herda de `default-src`) e `img-src` (reviewer_shell_1, achado 2).
 */
export function politicaDeSeguranca(nonce: string): string {
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
    `style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; object-src 'none'; ` +
    `base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
}

import { httpPermitido } from './http-local.js'

export type OpcoesDaPolitica = {
  /**
   * Origens, além de `'self'`, para onde um formulário pode levar o navegador (`form-action`).
   * É o logout com OIDC (ADR-0013, decisão 6): o "Sair" da moldura é um POST, e o shell responde
   * 303 para o IdP; `form-action` vale também para esse redirecionamento. Só origem `https://`
   * (ou `http://` fora de produção; em produção, só loopback com `ERP_PERMITIR_HTTP_LOCAL=1`, ADR-0013
   * adendo 2), sem caminho, curinga ou credencial: o valor entra no cabeçalho.
   */
  formularioPara?: readonly string[]
}

/**
 * Esquema, host (letras, dígitos, `.` e `-`, ou IPv6 entre colchetes só com dígitos hexadecimais e `:`) e
 * porta opcional. Nada que feche a diretiva.
 */
const ORIGEM = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?$/

function validarOrigem(valor: unknown): string {
  if (typeof valor !== 'string' || !ORIGEM.test(valor)) throw new TypeError(`origem de form-action invalida: ${String(valor)}`)
  let url: URL
  try { url = new URL(valor) } catch { throw new TypeError(`origem de form-action invalida: ${valor}`) }
  if (url.origin !== valor) throw new TypeError(`origem de form-action invalida: ${valor}`)
  if (!httpPermitido(url)) {
    throw new TypeError(`origem de form-action precisa de https em producao: ${valor}`)
  }
  return valor
}

/**
 * A CSP de toda aplicação da base (ADR-0012). Um lugar só: o shell copiava a política e perdeu
 * `form-action` (que não herda de `default-src`) e `img-src` (reviewer_shell_1, achado 2).
 * Origem inválida em `formularioPara` lança `TypeError`: é configuração errada, nunca CSP afrouxada.
 */
export function politicaDeSeguranca(nonce: string, opcoes: OpcoesDaPolitica = {}): string {
  const formularios = (opcoes.formularioPara ?? []).map(validarOrigem)
  const formAction = ["'self'", ...formularios].join(' ')
  return `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
    `style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; object-src 'none'; ` +
    `base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`
}

/**
 * `formularioPara` do logout a partir de `IDP_EMISSOR` (docs/CONFIGURACAO.md §1): a origem do
 * emissor, ou nada sem OIDC. Emissor que não é URL lança `TypeError`.
 */
export function formularioDoLogout(emissor: string | undefined): string[] {
  if (!emissor) return []
  let url: URL
  try { url = new URL(emissor) } catch { throw new TypeError('IDP_EMISSOR nao e URL absoluta') }
  return [validarOrigem(url.origin)]
}

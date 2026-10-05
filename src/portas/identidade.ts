import type { SessaoArmazenada } from './sessao.js'

/**
 * Transação de login (ADR-0013, decisão 3): o que o shell guarda entre mandar o navegador ao IdP e
 * receber o retorno. Fica no store de sessão, com TTL e uso único; o navegador leva só o `id`
 * (cookie `__Host-erp-login`). `codeVerifier` (PKCE) e `nonce` nunca vão ao navegador.
 */
export interface TransacaoDeLogin {
  id: string
  state: string
  codeVerifier: string
  nonce: string
  /** Caminho interno para onde o usuário volta depois do login; nunca URL absoluta. */
  destino: string
  /** Fim da validade, em ms desde a época (`ERP_LOGIN_TRANSACAO_S`). */
  expiraEm: number
}

/** `revogada` é o IdP recusando o refresh token (`invalid_grant`): a sessão acabou. */
export type ResultadoRenovacao =
  | { status: 'renovada'; sessao: SessaoArmazenada }
  | { status: 'revogada' }

/**
 * Ciclo de vida da identidade (ADR-0013, decisão 1). Só o shell usa, pela fábrica
 * `criarNucleoDoShell`, que guarda transação e sessão sem devolver token a quem chama.
 */
export interface ProvedorDeIdentidade {
  /**
   * Cria a transação e a URL para onde mandar o navegador. Erro transitório (IdP fora, discovery
   * falhando) **lança**: quem chama responde erro, sem transação gravada.
   */
  iniciar(destino?: string): Promise<{ url: string; transacao: TransacaoDeLogin }>
  /**
   * Valida o retorno contra a transação (`state`, `nonce`, validade). Recusado: `null`. Erro
   * transitório (rede, 5xx do IdP) **lança**: não é recusa, e quem chama responde erro.
   */
  concluir(parametros: Record<string, string>, transacao: TransacaoDeLogin): Promise<SessaoArmazenada | null>
  /** Erro transitório (rede, 5xx) **lança**: quem chama mantém a sessão e tenta depois. */
  renovar(sessao: SessaoArmazenada): Promise<ResultadoRenovacao>
  /** URL de logout no IdP, ou `null` quando o provedor não tem. */
  encerrar(sessao: SessaoArmazenada): Promise<{ urlLogout: string | null }>
}

/** O que fica no servidor. O `accessToken` nunca sai daqui. */
export type SessaoArmazenada = {
  sub: string
  roles: string[]
  accessToken: string
  expiraEm: number
}

/**
 * O que a aplicação enxerga. Sem token e sem grupos: `roles` monta menu de contingência
 * ou ações de tela; o token nunca é visível para quem consome Sessao.
 */
export type Sessao = { sub: string; nome: string; roles: string[] }

export interface LeitorDeSessao {
  ler(id: string): Promise<SessaoArmazenada | null>
}

export interface StoreDeSessao extends LeitorDeSessao {
  gravar(id: string, s: SessaoArmazenada): Promise<void>
  remover(id: string): Promise<void>
}

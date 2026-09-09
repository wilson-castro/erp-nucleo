/** O que fica no servidor. O `accessToken` nunca sai daqui. */
export type SessaoArmazenada = {
  sub: string
  roles: string[]
  accessToken: string
  expiraEm: number
}

/**
 * O que a aplicação enxerga. Sem token e sem grupos: `roles` monta menu, que é
 * decisão do cliente sobre si mesmo; grupos são insumo de autorização, e
 * autorização é do domínio. Ver 02-nucleo.md §2.1.
 */
export type Sessao = { sub: string; roles: string[] }

export interface StoreDeSessao {
  ler(id: string): Promise<SessaoArmazenada | null>
  gravar(id: string, s: SessaoArmazenada): Promise<void>
  remover(id: string): Promise<void>
}

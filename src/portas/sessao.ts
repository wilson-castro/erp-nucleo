/** O que fica no servidor. O `accessToken` nunca sai daqui. */
export type SessaoArmazenada = {
  sub: string
  nome: string
  accessToken: string
  expiraEm: number
  tokenExpiraEm?: number
  refreshToken?: string
  idToken?: string
}

/**
 * O que a aplicação enxerga. Sem token e sem perfis: perfis são insumo da gestão de
 * acesso, e quem decide módulo é o domínio de gestão de acesso, não a sessão. Ver ADR-0009.
 */
export type Sessao = { sub: string; nome: string }

/** Toda aplicação lê. */
export interface LeitorDeSessao {
  ler(id: string): Promise<SessaoArmazenada | null>
}

/** Só o shell escreve. Uma zona que recebesse isto poderia forjar ou encerrar sessão. */
export interface EscritorDeSessao {
  gravar(id: string, s: SessaoArmazenada): Promise<void>
  remover(id: string): Promise<void>
}

export type StoreDeSessao = LeitorDeSessao & EscritorDeSessao

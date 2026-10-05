import type { TransacaoDeLogin } from './identidade.js'

/**
 * O que fica no servidor. O `accessToken` nunca sai daqui. `expiraEm` é o fim da sessão;
 * `tokenExpiraEm`, `refreshToken` e `idToken` são do escritor, para a renovação (ADR-0013, decisão 2).
 */
export type SessaoArmazenada = {
  sub: string
  nome: string
  accessToken: string
  expiraEm: number
  tokenExpiraEm?: number
  /**
   * Vida do token em ms, medida pelo shell ao gravar (login ou renovação). Limita a janela de renovação
   * desta sessão a metade dela quando `ERP_RENOVACAO_JANELA_S` é grande demais (D20). Ausente quando o
   * token é cortado pelo fim da sessão, ou em sessão gravada antes dela: vale a janela configurada.
   */
  tokenVidaMs?: number
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
  /**
   * Grava só se a sessão ainda existe (`SET XX PX` no Redis); `false` quando não existe mais.
   * É a escrita da renovação: um `remover` (logout) no meio da ida ao IdP não pode ser desfeito.
   */
  regravar(id: string, s: SessaoArmazenada): Promise<boolean>
  /** Guarda a transação de login até `transacao.expiraEm`, fora do alcance do leitor das zonas. */
  gravarTransacao(transacao: TransacaoDeLogin): Promise<void>
  /** Devolve e apaga numa operação só: a mesma transação nunca é devolvida duas vezes. */
  consumirTransacao(id: string): Promise<TransacaoDeLogin | null>
  /**
   * Lock de renovação da sessão `idSessao` por `ttlMs` (`SET NX PX`, ADR-0013, decisão 4).
   * `true` para quem ganhou. Não há liberação explícita: o TTL libera, e serve de backoff.
   */
  adquirirLockRenovacao(idSessao: string, ttlMs: number): Promise<boolean>
}

export type StoreDeSessao = LeitorDeSessao & EscritorDeSessao

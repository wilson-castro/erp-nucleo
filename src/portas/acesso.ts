import type { AcessoEfetivo } from '@erp/contratos'
import type { ClienteDeDestino } from './destinos.js'

/** Pergunta ao domínio de gestão de acesso, com a credencial do usuário. */
export interface PortaDeAcesso {
  acessoEfetivo(): Promise<AcessoEfetivo>
}

export type FabricaDeAcesso = (deps: { destino: (nome: string) => ClienteDeDestino }) => PortaDeAcesso

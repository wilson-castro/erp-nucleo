import type { ModuloPermitido } from '@erp/contratos'
import type { ClienteDeDestino } from './destinos.js'

/** Pergunta ao domínio de gestão de acesso, com a credencial do usuário. */
export interface PortaDeAcesso {
  modulosPermitidos(): Promise<readonly ModuloPermitido[]>
}

export type FabricaDeAcesso = (deps: { destino: (nome: string) => ClienteDeDestino }) => PortaDeAcesso

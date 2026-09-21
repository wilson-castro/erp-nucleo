import 'server-only'
import type { ModuloPermitido } from '@erp/contratos'

export interface PortaDeAcesso {
  modulosPermitidos(): Promise<readonly ModuloPermitido[]>
  exigirModulo(prefixoOuId: string): Promise<ModuloPermitido>
}

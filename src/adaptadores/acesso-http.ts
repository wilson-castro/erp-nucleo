import 'server-only'
import type { ModuloPermitido } from '@erp/contratos'
import type { PortaDeAcesso } from '../portas/acesso.js'
import type { ClienteDestino } from '../portas/destinos.js'
import { NaoEncontrado } from '../interno/erros.js'

export function acessoHttp(destinoAcesso: ClienteDestino | { destino: string }): PortaDeAcesso {
  const cliente = 'get' in destinoAcesso ? destinoAcesso : undefined
  return {
    async modulosPermitidos(): Promise<readonly ModuloPermitido[]> {
      if (!cliente) return []
      const resp = await cliente.get<ModuloPermitido[]>('/v1/modulos-permitidos')
      return resp.body ?? []
    },
    async exigirModulo(prefixoOuId: string): Promise<ModuloPermitido> {
      if (!cliente) throw new NaoEncontrado()
      const resp = await cliente.get<ModuloPermitido[]>('/v1/modulos-permitidos')
      const permitidos = resp.body ?? []
      const achado = permitidos.find(
        (m) => m.id === prefixoOuId || m.prefixo === prefixoOuId || prefixoOuId.startsWith(`${m.prefixo}/`),
      )
      if (!achado) {
        throw new NaoEncontrado()
      }
      return achado
    },
  }
}

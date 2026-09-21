import 'server-only'
import type { ModuloPermitido } from '@erp/contratos'
import type { FabricaDeAcesso } from '../portas/acesso.js'

/**
 * Consulta o domínio de gestão de acesso a cada chamada (decisão D7: medir antes de
 * otimizar). O destino precisa estar no registro da aplicação com credencial `usuario`
 * e o caminho `/v1/modulos-permitidos`.
 */
export function acessoHttp(cfg: { destino: string }): FabricaDeAcesso {
  return ({ destino }) => ({
    async modulosPermitidos() {
      const r = await destino(cfg.destino).get<readonly ModuloPermitido[]>('/v1/modulos-permitidos')
      return Array.isArray(r.body) ? r.body : []
    },
  })
}

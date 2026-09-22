import 'server-only'
import type { ModuloPermitido, Eu } from '@erp/contratos'
import type { FabricaDeAcesso } from '../portas/acesso.js'

/**
 * Consulta o domínio de gestão de acesso a cada chamada (decisão D7: medir antes de
 * otimizar). Prioriza GET /v2/eu (ADR-0014); se a rota não estiver declarada no
 * registro de destinos, faz fallback para GET /v1/modulos-permitidos.
 */
export function acessoHttp(cfg: { destino: string }): FabricaDeAcesso {
  return ({ destino }) => {
    const cliente = destino(cfg.destino)

    async function obterEu(): Promise<Eu | null> {
      try {
        const r = await cliente.get<Eu>('/v2/eu')
        return r.body ?? null
      } catch {
        return null
      }
    }

    async function modulosPermitidos(): Promise<readonly ModuloPermitido[]> {
      try {
        const r = await cliente.get<Eu>('/v2/eu')
        if (r.body?.modulos && Array.isArray(r.body.modulos)) {
          return r.body.modulos.map((m) => ({
            id: m.id,
            zona: m.zona ?? m.id.split('.')[0] ?? '',
            rotulo: m.rotulo ?? m.id,
            prefixo: m.prefixo ?? `/${m.id.replace('.', '/')}`,
            perfis: m.perfis ?? [],
            funcionalidades: m.funcionalidades ?? [],
          }))
        }
      } catch {
        // Rota /v2/eu nao declarada no destino ou erro: fallback para /v1/modulos-permitidos
      }
      const r = await cliente.get<readonly ModuloPermitido[]>('/v1/modulos-permitidos')
      return Array.isArray(r.body) ? r.body : []
    }

    return {
      modulosPermitidos,
      obterEu,
    }
  }
}

import 'server-only'
import { randomUUID } from 'node:crypto'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import type { SessaoArmazenada } from '../portas/sessao.js'

/**
 * Atores de desenvolvimento definidos na arquitetura genérica (repos/erp-dominio-stub).
 * Suporta atores genéricos ('ana', 'bruno', 'carla', 'davi') e mantém compatibilidade
 * com os atores anteriores de desenvolvimento ('gabrigas', 'marina', 'rafael').
 */
const ATORES: Record<string, { roles: string[] }> = {
  ana: { roles: ['OPERADOR'] },
  bruno: { roles: ['ANALISTA'] },
  carla: { roles: ['ADMIN'] },
  davi: { roles: [] },
  gabrigas: { roles: ['OPERADOR'] },
  marina: { roles: ['OPERADOR'] },
  rafael: { roles: ['ADMIN'] },
}

/**
 * Provedor de DESENVOLVIMENTO. Substituído por OIDC em produção.
 * Recusa-se a existir em produção — um IdP que aceita usuário sem senha não pode subir por engano.
 */
export function identidadeDev(): ProvedorDeIdentidade {
  if (process.env.NODE_ENV === 'production' && process.env.ERP_PERMITIR_IDENTIDADE_DEV !== '1') {
    throw new Error('identidadeDev não roda em producao; use o provedor OIDC')
  }
  return {
    async autenticar(credencial) {
      const usuario = (credencial as { usuario?: unknown })?.usuario
      if (typeof usuario !== 'string') return null
      const ator = ATORES[usuario]
      if (!ator) return null
      return {
        sub: usuario,
        roles: ator.roles,
        accessToken: `dev.${usuario}.${randomUUID()}`,
        expiraEm: Date.now() + 30 * 60_000,
      }
    },
  }
}

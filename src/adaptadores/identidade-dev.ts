import 'server-only'
import { randomUUID } from 'node:crypto'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import type { SessaoArmazenada } from '../portas/sessao.js'

/** Os quatro atores de 00-caso.md. Grupos ficam no domínio, não na sessão. */
const ATORES: Record<string, { roles: string[] }> = {
  gabrigas: { roles: ['OPERADOR'] },
  marina:   { roles: ['OPERADOR'] },
  rafael:   { roles: ['ADMIN'] },
  carla:    { roles: ['OPERADOR'] },
}

/**
 * Provedor de DESENVOLVIMENTO. Substituído por OIDC na rodada 2. Recusa-se a
 * existir em produção — um IdP que aceita um nome de usuário sem senha não pode
 * subir por engano.
 */
export function identidadeDev(): ProvedorDeIdentidade {
  if (process.env.NODE_ENV === 'production') {
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

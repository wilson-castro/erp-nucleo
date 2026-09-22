import 'server-only'
import { randomUUID } from 'node:crypto'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'

/**
 * Atores de desenvolvimento. Só nome: perfis e grupos ficam nos domínios (gestão de
 * acesso e cada domínio de negócio), nunca na sessão.
 */
const ATORES: Readonly<Record<string, string>> = {
  ana: 'Ana Operadora',
  bruno: 'Bruno Analista',
  carla: 'Carla Administradora de Acesso',
  davi: 'Davi Sem Perfil',
}

export const ATORES_DE_DESENVOLVIMENTO: readonly string[] = Object.keys(ATORES)

import { lerNumeroPositivo } from '../interno/configuracao.js'

/**
 * Provedor de DESENVOLVIMENTO. Substituído por OIDC antes de produção. Recusa-se a
 * existir em produção — um IdP que aceita um nome de usuário sem senha não pode subir
 * por engano.
 */
export function identidadeDev(): ProvedorDeIdentidade {
  if (process.env.NODE_ENV === 'production' && process.env.ERP_PERMITIR_IDENTIDADE_DEV !== '1') {
    throw new Error('identidadeDev nao roda em producao; use o provedor OIDC')
  }
  const vidaTokenS = lerNumeroPositivo(process.env.ERP_TOKEN_VIDA_S, 300, 'ERP_TOKEN_VIDA_S')

  return {
    async autenticar(credencial) {
      const usuario = (credencial as { usuario?: unknown })?.usuario
      if (typeof usuario !== 'string' || !Object.hasOwn(ATORES, usuario)) return null
      const agora = Date.now()
      return {
        sub: usuario,
        nome: ATORES[usuario]!,
        accessToken: `dev.${usuario}.${randomUUID()}`,
        expiraEm: agora + 30 * 60_000,
        tokenExpiraEm: agora + vidaTokenS * 1_000,
      }
    },
  }
}

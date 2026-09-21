import type { ModuloPermitido } from '@erp/contratos'
import type { FabricaDeAcesso } from '../portas/acesso.js'
import type { StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'

/** Sem rede. Devolve sempre a mesma lista, como o domínio faria para um usuário fixo. */
export function acessoFake(modulos: readonly ModuloPermitido[]): FabricaDeAcesso {
  return () => ({ modulosPermitidos: async () => modulos })
}

/**
 * Store em memória para testes de uma aplicação só. `Map`, não objeto: um id hostil
 * como `__proto__` não pode devolver propriedade herdada.
 */
export function sessaoMemoria(): StoreDeSessao {
  const m = new Map<string, SessaoArmazenada>()
  return {
    ler: async (id) => m.get(id) ?? null,
    gravar: async (id, s) => { m.set(id, s) },
    remover: async (id) => { m.delete(id) },
  }
}

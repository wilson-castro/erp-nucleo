import type { AcessoEfetivo } from '@erp/contratos'
import type { FabricaDeAcesso } from '../portas/acesso.js'
import type { StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'

/** Sem rede. Devolve sempre o mesmo acesso efetivo, como o domínio faria para um usuário fixo. */
export function acessoFake(acesso: AcessoEfetivo): FabricaDeAcesso {
  return () => ({ acessoEfetivo: async () => acesso })
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

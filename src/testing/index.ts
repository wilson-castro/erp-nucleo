import type { AcessoEfetivo } from '@erp/contratos'
import type { FabricaDeAcesso } from '../portas/acesso.js'
import type { StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'
import type { TransacaoDeLogin } from '../portas/identidade.js'

/** Sem rede. Devolve sempre o mesmo acesso efetivo, como o domínio faria para um usuário fixo. */
export function acessoFake(acesso: AcessoEfetivo): FabricaDeAcesso {
  return () => ({ acessoEfetivo: async () => acesso })
}

/**
 * Store em memória para testes de uma aplicação só. `Map`, não objeto: um id hostil
 * como `__proto__` não pode devolver propriedade herdada. Transação e lock seguem o contrato
 * do escritor (uso único; `SET NX PX`), sem TTL ativo: o lock vencido é retomado na próxima tentativa.
 */
export function sessaoMemoria(): StoreDeSessao {
  const m = new Map<string, SessaoArmazenada>()
  const transacoes = new Map<string, TransacaoDeLogin>()
  const locks = new Map<string, number>()
  return {
    ler: async (id) => m.get(id) ?? null,
    gravar: async (id, s) => { m.set(id, s) },
    remover: async (id) => { m.delete(id) },
    gravarTransacao: async (t) => { transacoes.set(t.id, t) },
    consumirTransacao: async (id) => {
      const t = transacoes.get(id) ?? null
      transacoes.delete(id)
      return t
    },
    adquirirLockRenovacao: async (idSessao, ttlMs) => {
      const expira = locks.get(idSessao)
      if (expira !== undefined && Date.now() < expira) return false
      locks.set(idSessao, Date.now() + ttlMs)
      return true
    },
  }
}

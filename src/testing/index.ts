import 'server-only'
import type { ModuloPermitido } from '@erp/contratos'
import type { PortaDeAcesso } from '../portas/acesso.js'
import type {
  PortaDeDestinos,
  ClienteDestino,
  RespostaDestino,
  OpcoesRequisicao,
} from '../portas/destinos.js'
import type { StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'
import { NaoEncontrado, DestinoInvalido } from '../interno/erros.js'

/**
 * Fake in-memory session store para testes unitários de zonas e do shell.
 */
export function sessaoFake(inicial: Record<string, SessaoArmazenada> = {}): StoreDeSessao {
  const store = new Map<string, SessaoArmazenada>(Object.entries(inicial))
  return {
    async ler(id: string) {
      return store.get(id) ?? null
    },
    async gravar(id: string, s: SessaoArmazenada) {
      store.set(id, s)
    },
    async remover(id: string) {
      store.delete(id)
    },
  }
}

/**
 * Fake access port para testes de controle de acesso de zonas.
 */
export function acessoFake(modulos: readonly ModuloPermitido[]): PortaDeAcesso {
  return {
    async modulosPermitidos() {
      return modulos
    },
    async exigirModulo(prefixoOuId: string) {
      const achado = modulos.find(
        (m) => m.id === prefixoOuId || m.prefixo === prefixoOuId || prefixoOuId.startsWith(`${m.prefixo}/`),
      )
      if (!achado) throw new NaoEncontrado()
      return achado
    },
  }
}

export type HandlerDestinoFake = (opcoes: OpcoesRequisicao) => RespostaDestino<unknown> | Promise<RespostaDestino<unknown>>

/**
 * Fake destinations port para testes de integração e unitários de zonas sem rede.
 */
export function destinosFake(
  rotasPorDestino: Record<string, Record<string, HandlerDestinoFake | unknown>>,
): PortaDeDestinos {
  return {
    destino(nome: string): ClienteDestino {
      const rotas = rotasPorDestino[nome]
      if (!rotas) throw new DestinoInvalido()

      async function executar<T>(caminhoModelo: string, opcoes: OpcoesRequisicao = {}): Promise<RespostaDestino<T>> {
        const handler = rotas[caminhoModelo]
        if (handler === undefined) throw new DestinoInvalido()

        if (typeof handler === 'function') {
          const res = await (handler as HandlerDestinoFake)(opcoes)
          return res as RespostaDestino<T>
        }

        return {
          status: 200,
          body: handler as T,
        }
      }

      return {
        requisitar: executar,
        get: executar,
        post: executar,
        put: executar,
        patch: executar,
        delete: executar,
      }
    },
  }
}

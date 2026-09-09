import 'server-only'
import type { PedidoDTO } from '@erp/contratos'
import type { FabricaDeDados, PortaDeDados } from '../portas/dados.js'
import { upstream } from '../interno/upstream.js'
import { NaoEncontrado } from '../interno/erros.js'

export function dadosHttp(cfg: { baseUrl: string }): FabricaDeDados {
  const base = new URL(cfg.baseUrl)
  return ({ obterToken }): PortaDeDados => ({
    async lerPedido(id) {
      // `id` vem da URL, portanto do cliente. Codificar é obrigatório:
      // concatenar permitiria "../../" atravessar o caminho.
      const r = await upstream<PedidoDTO>({ base, obterToken },
                                          `/pedidos/${encodeURIComponent(id)}`)
      if (!r.body) throw new NaoEncontrado()
      return r.versao === undefined
        ? { pedido: r.body }
        : { pedido: r.body, versao: r.versao }
    },
  })
}

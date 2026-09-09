import type { PedidoDTO } from '@erp/contratos'
import type { FabricaDeDados } from '../portas/dados.js'
import { NaoEncontrado } from '../interno/erros.js'

/** Sem rede, sem stub. Para testes que não precisam exercitar HTTP. */
export function dadosFake(pedidos: Record<string, PedidoDTO>): FabricaDeDados {
  return () => ({
    async lerPedido(id) {
      const pedido = pedidos[id]
      if (!pedido) throw new NaoEncontrado()
      return { pedido, versao: `"${pedido.versao}"` }
    },
  })
}

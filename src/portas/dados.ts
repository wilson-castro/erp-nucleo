import type { PedidoDTO } from '@erp/contratos'

export type ObterToken = () => Promise<string>

/**
 * Fatia 1 é somente leitura, e a porta declara isso. Acrescentar mutação aqui
 * exige a rodada 2 — elemento 4 do núcleo, com If-Match. Ver ADR-0008.
 */
export interface PortaDeDados {
  lerPedido(id: string): Promise<{ pedido: PedidoDTO; versao?: string }>
}

export type FabricaDeDados = (deps: { obterToken: ObterToken }) => PortaDeDados

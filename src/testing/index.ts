import type { PedidoDTO } from '@erp/contratos'
import type { FabricaDeDados } from '../portas/dados.js'
import { NaoEncontrado } from '../interno/erros.js'

/**
 * Sem rede, sem stub. Para testes que não precisam exercitar HTTP.
 *
 * O `Map` não é preferência de estilo. `pedidos[id]` com `id` vindo da URL devolve
 * propriedade **herdada** para `__proto__`, `constructor`, `toString` e afins — o fake
 * devolveria lixo em vez de lançar `NaoEncontrado`, divergindo do adaptador HTTP
 * exatamente nos ids que um atacante escolheria. Um fake que não se comporta como o
 * adaptador real destrói o propósito da porta: o teste passa e não prova nada sobre
 * produção.
 */
export function dadosFake(
  pedidos: Record<string, PedidoDTO>,
  opcoes: { omitirVersao?: boolean } = {},
): FabricaDeDados {
  const porId = new Map(Object.entries(pedidos))
  return () => ({
    async lerPedido(id) {
      const pedido = porId.get(id)
      if (!pedido) throw new NaoEncontrado()
      // `omitirVersao` existe porque o adaptador HTTP OMITE a chave quando não há ETag,
      // e `PedidoDTO.versao` é obrigatório — sem esta opção o fake nunca produziria a
      // forma sem `versao`, e um teste que ramifica em `'versao' in resultado` não
      // poderia ser exercitado contra ele. Um fake que não alcança uma das formas do
      // adaptador real não é intercambiável, que é a única coisa que a porta promete.
      return opcoes.omitirVersao ? { pedido } : { pedido, versao: `"${pedido.versao}"` }
    },
  })
}

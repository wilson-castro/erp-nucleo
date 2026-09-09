import 'server-only'
import type { PedidoDTO } from '@erp/contratos'
import type { FabricaDeDados, PortaDeDados } from '../portas/dados.js'
import { upstream } from '../interno/upstream.js'
import { NaoEncontrado } from '../interno/erros.js'

export function dadosHttp(cfg: { baseUrl: string }): FabricaDeDados {
  const base = new URL(cfg.baseUrl)
  return ({ obterToken }): PortaDeDados => ({
    async lerPedido(id) {
      // `id` vem da URL, portanto do cliente.
      //
      // `encodeURIComponent` escapa `/` e `\\`, mas NÃO escapa `.`. Um id `..` produz
      // `/pedidos/..`, que a normalização de URL colapsa para `/` — mesma origem, e
      // fora do namespace `/pedidos/`. O elemento 7 protege a ORIGEM; a seleção de
      // recurso é responsabilidade daqui, e só `.` e `..` exatos disparam a remoção
      // de dot-segment (`...` e `....//` são inertes).
      //
      // `NaoEncontrado`, e não um erro próprio: um id que não nomeia recurso é
      // indistinguível de um recurso que não existe, e essa uniformidade é o que
      // impede enumeração.
      if (id === '.' || id === '..') throw new NaoEncontrado()

      const r = await upstream<PedidoDTO>({ base, obterToken },
                                          `/pedidos/${encodeURIComponent(id)}`)
      if (!r.body) throw new NaoEncontrado()
      return r.versao === undefined
        ? { pedido: r.body }
        : { pedido: r.body, versao: r.versao }
    },
  })
}

import 'server-only'
import type { AcessoEfetivo } from '@erp/contratos'
import type { FabricaDeAcesso } from '../portas/acesso.js'
import { reduzirEu } from '../interno/acesso-v2.js'
import { ErroDeAplicacao, NaoEncontrado } from '../interno/erros.js'

/**
 * Consulta `GET /v2/eu` da gestão de acesso a cada chamada, com a credencial do usuário (decisão
 * D7: medir antes de otimizar; invariante 13: sem cache). Uma autoridade só: não há volta para a
 * v1 (ADR-0014, adendo 1). O fallback da 0.8.x concedia o que a v1 dissesse quando a v2 recusava,
 * inclusive para pessoa desligada (auditor_b1_d1_2, V4).
 *
 * Fail-closed: `401` sobe como `SessaoInvalida` (login); `404` da própria rota é configuração
 * errada, não "sem acesso", e vira erro; 403, 5xx, timeout e corpo fora do esquema viram erro.
 * Nenhum desses caminhos devolve lista.
 */
export function acessoHttp(cfg: { destino: string }): FabricaDeAcesso {
  return ({ destino }) => ({
    async acessoEfetivo(): Promise<AcessoEfetivo> {
      try {
        const r = await destino(cfg.destino).get<unknown>('/v2/eu')
        return reduzirEu(r.body)
      } catch (e) {
        if (e instanceof NaoEncontrado) throw new ErroDeAplicacao('ERRO_INTERNO')
        throw e
      }
    },
  })
}

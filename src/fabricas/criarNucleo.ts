import 'server-only'
import type { FabricaDeDados, PortaDeDados } from '../portas/dados.js'
import type { StoreDeSessao, Sessao, SessaoArmazenada } from '../portas/sessao.js'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import { SessaoInvalida } from '../interno/erros.js'

export type ConfigDoNucleo = {
  dados: FabricaDeDados
  sessao: StoreDeSessao
  identidade: ProvedorDeIdentidade
  /**
   * Injetado em vez de importar `next/headers` aqui: mantém a fábrica testável
   * fora de um contexto de requisição do Next.
   */
  lerCookieDeSessao: () => Promise<string | undefined>
}

/**
 * `store` NÃO é exposto. O shell precisa abrir e encerrar sessão, não lê-la: expor o
 * `StoreDeSessao` inteiro daria a qualquer chamador o `ler()`, que devolve
 * `SessaoArmazenada` — com o `accessToken` dentro. O teste que prova que
 * `sessao.atual()` não vaza token continuaria verde enquanto `nucleo.store.ler()`
 * entregava o token ao lado.
 */
export type Nucleo = {
  dados: PortaDeDados
  sessao: {
    atual(): Promise<Sessao | null>
    exigir(): Promise<Sessao>
    abrir(id: string, s: SessaoArmazenada): Promise<void>
    encerrar(id: string): Promise<void>
  }
  identidade: ProvedorDeIdentidade
}

export function criarNucleo(cfg: ConfigDoNucleo): Nucleo {
  const armazenada = async () => {
    const id = await cfg.lerCookieDeSessao()
    if (!id) return null
    const s = await cfg.sessao.ler(id)
    if (!s) return null
    if (Date.now() >= s.expiraEm) return null   // expirada é ausente
    return s
  }

  const obterToken = async () => {
    const s = await armazenada()
    if (!s) throw new SessaoInvalida()
    return s.accessToken
  }

  return {
    dados: cfg.dados({ obterToken }),
    identidade: cfg.identidade,
    sessao: {
      abrir: (id, s) => cfg.sessao.gravar(id, s),
      encerrar: (id) => cfg.sessao.remover(id),
      async atual() {
        const s = await armazenada()
        // projeta: token e qualquer campo futuro ficam para trás
        return s ? { sub: s.sub, roles: s.roles } : null
      },
      async exigir() {
        const s = await this.atual()
        if (!s) throw new SessaoInvalida()
        return s
      },
    },
  }
}

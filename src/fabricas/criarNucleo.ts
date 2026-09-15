import 'server-only'
import { randomUUID } from 'node:crypto'
import type { FabricaDeDados, PortaDeDados } from '../portas/dados.js'
import type { StoreDeSessao, Sessao } from '../portas/sessao.js'
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
    /** Autentica, cunha o id opaco, grava, e devolve **só o id**. */
    entrar(credencial: unknown): Promise<string | null>
    encerrar(id: string): Promise<void>
  }
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

  // Função nomeada, não método: `exigir` chamava `this.atual()`, e destruturar
  // `const { exigir } = nucleo.sessao` quebrava o `this`. O método que mais provavelmente
  // protege uma rota era o mais frágil do arquivo.
  const atual = async (): Promise<Sessao | null> => {
    const s = await armazenada()
    // projeta: token e qualquer campo futuro ficam para trás
    return s ? { sub: s.sub, roles: s.roles } : null
  }

  return {
    dados: cfg.dados({ obterToken }),
    sessao: {
      atual,
      async exigir() {
        const s = await atual()
        if (!s) throw new SessaoInvalida()
        return s
      },
      /**
       * `identidade` NÃO é exposto no `Nucleo`, e `entrar` é a razão. O provedor devolve
       * `SessaoArmazenada` — com o `accessToken` dentro — e o único chamador legítimo
       * disso é quem vai gravar a sessão. Fazendo a fábrica autenticar, cunhar o id e
       * gravar, o token nunca chega a quem chama: o shell recebe um id opaco e mais nada.
       */
      async entrar(credencial) {
        const s = await cfg.identidade.autenticar(credencial)
        if (!s) return null
        const id = randomUUID()
        await cfg.sessao.gravar(id, s)
        return id
      },
      encerrar: (id) => cfg.sessao.remover(id),
    },
  }
}

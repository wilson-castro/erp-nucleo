import 'server-only'
import { randomUUID } from 'node:crypto'
import type { LeitorDeSessao, StoreDeSessao, Sessao } from '../portas/sessao.js'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import type { PortaDeAcesso } from '../portas/acesso.js'
import type {
  RegistroDeDestinos,
  PortaDeDestinos,
  ClienteDestino,
} from '../portas/destinos.js'
import { SessaoInvalida, DestinoInvalido } from '../interno/erros.js'
import { criarClienteDestino } from '../interno/upstream.js'
import { acessoHttp } from '../adaptadores/acesso-http.js'

export type ConfigDoNucleo = {
  sessao: LeitorDeSessao
  lerCookieDeSessao: () => Promise<string | undefined>
  destinos?: RegistroDeDestinos
  acesso?: PortaDeAcesso | ((destinos: PortaDeDestinos) => PortaDeAcesso)
  tokenServico?: string
  /**
   * Identidade e escrita de sessão são opcionais; usados pelo shell para autenticar.
   */
  identidade?: ProvedorDeIdentidade
}

export type Nucleo = PortaDeDestinos & {
  sessao: {
    atual(): Promise<Sessao | null>
    exigir(): Promise<Sessao>
    entrar(credencial: unknown): Promise<string | null>
    encerrar(id: string): Promise<void>
  }
  acesso?: PortaDeAcesso
}

export function criarNucleo(cfg: ConfigDoNucleo): Nucleo {
  const armazenada = async () => {
    const id = await cfg.lerCookieDeSessao()
    if (!id) return null
    const s = await cfg.sessao.ler(id)
    if (!s) return null
    if (Date.now() >= s.expiraEm) return null
    return s
  }

  const obterToken = async () => {
    const s = await armazenada()
    if (!s) throw new SessaoInvalida()
    return s.accessToken
  }

  const clientes = new Map<string, ClienteDestino>()
  const registros = cfg.destinos ?? {}

  for (const [nome, definicao] of Object.entries(registros)) {
    clientes.set(nome, criarClienteDestino(nome, definicao, obterToken, cfg.tokenServico))
  }

  const portaDestinos: PortaDeDestinos = {
    destino(nome: string): ClienteDestino {
      const c = clientes.get(nome)
      if (!c) throw new DestinoInvalido()
      return c
    },
  }

  let portaAcesso: PortaDeAcesso | undefined
  if (typeof cfg.acesso === 'function') {
    portaAcesso = cfg.acesso(portaDestinos)
  } else if (cfg.acesso) {
    portaAcesso = cfg.acesso
  } else if (clientes.has('gestao-acesso')) {
    portaAcesso = acessoHttp(clientes.get('gestao-acesso')!)
  }

  const atual = async (): Promise<Sessao | null> => {
    const s = await armazenada()
    return s ? { sub: s.sub, roles: s.roles } : null
  }

  const sessaoObj = {
    atual,
    async exigir() {
      const s = await atual()
      if (!s) throw new SessaoInvalida()
      return s
    },
    async entrar(credencial: unknown) {
      if (!cfg.identidade) return null
      const s = await cfg.identidade.autenticar(credencial)
      if (!s) return null
      const id = randomUUID()
      // Apenas stores com gravar (StoreDeSessao) gravam
      const store = cfg.sessao as StoreDeSessao
      if (typeof store.gravar === 'function') {
        await store.gravar(id, s)
        return id
      }
      return null
    },
    async encerrar(id: string) {
      const store = cfg.sessao as StoreDeSessao
      if (typeof store.remover === 'function') {
        await store.remover(id)
      }
    },
  }

  return {
    destino: portaDestinos.destino,
    sessao: sessaoObj,
    ...(portaAcesso ? { acesso: portaAcesso } : {}),
  }
}

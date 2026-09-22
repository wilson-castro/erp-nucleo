import 'server-only'
import { randomUUID } from 'node:crypto'
import { ehFuncionalidade, type AcessoEfetivo } from '@erp/contratos'
import type { LeitorDeSessao, EscritorDeSessao, Sessao } from '../portas/sessao.js'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import type { ClienteDeDestino, RegistroDeDestinos } from '../portas/destinos.js'
import type { FabricaDeAcesso } from '../portas/acesso.js'
import { criarTransporte } from '../interno/destinos.js'
import { NaoEncontrado, SessaoInvalida } from '../interno/erros.js'
import { ID_MODULO } from '../interno/acesso-v2.js'

export type ConfigDoNucleo = {
  /** Nome da aplicação, enviado ao domínio no cabeçalho `x-erp-chamador`. */
  app: string
  sessao: LeitorDeSessao
  destinos: RegistroDeDestinos
  acesso: FabricaDeAcesso
  /**
   * Injetado em vez de importar `next/headers` aqui: mantém a fábrica testável
   * fora de um contexto de requisição do Next.
   */
  lerCookieDeSessao: () => Promise<string | undefined>
  /** Só para destinos com `credencial: 'servico'`, como o registro de manifesto. */
  tokenDeServico?: () => string | undefined
  /** Núcleo 8: lê o `traceparent` que o proxy pôs na requisição (`headers().get('traceparent')`). */
  lerTraceparent?: () => Promise<string | undefined>
}

/** Só o shell passa `escrita`. É o que faz dele o único escritor da sessão (N3). */
export type ConfigDoNucleoDoShell = ConfigDoNucleo & {
  escrita: { store: EscritorDeSessao; identidade: ProvedorDeIdentidade }
}

export type Nucleo = {
  sessao: {
    atual(): Promise<Sessao | null>
    exigir(): Promise<Sessao>
  }
  /** Cliente de um destino declarado. Nome fora do registro lança `DestinoInvalido`. */
  destino(nome: string): ClienteDeDestino
  acesso: {
    /** Módulos efetivos e se a pessoa administra; sem CPF nem papéis (ADR-0014, adendo 1). */
    acessoEfetivo(): Promise<AcessoEfetivo>
    /**
     * Camada 2 (invariante 16): a funcionalidade é obrigatória. Ausente no acesso efetivo lança
     * `NaoEncontrado`, que a aplicação traduz para `notFound()`: recurso restrito não revela que
     * existe (D6). Argumento mal formado é erro de programação e lança `TypeError`.
     */
    exigirModulo(modulo: string, funcionalidade: string): Promise<void>
    /** Só a zona de acesso: 404 para quem não tem papel administrativo. O domínio decide cada ação. */
    exigirPapel(): Promise<void>
  }
}

/**
 * `store` e `identidade` NÃO são expostos. `identidade.autenticar` devolve a sessão com
 * o `accessToken` dentro, e `store.ler` também. Fazendo a fábrica autenticar, cunhar o id
 * e gravar, o token nunca chega a quem chama: o shell recebe um id opaco e mais nada.
 */
export type NucleoDoShell = Omit<Nucleo, 'sessao'> & {
  sessao: Nucleo['sessao'] & {
    /** Autentica, cunha o id opaco, grava, e devolve **só o id**. */
    entrar(credencial: unknown): Promise<string | null>
    /** Remove do store: a sessão acaba em todas as zonas na próxima requisição. */
    encerrar(id: string): Promise<void>
  }
}

/** A forma de dois argumentos é obrigatória: `exigirModulo('zona1')` não pode virar "qualquer funcionalidade". */
export function validarRequisito(modulo: unknown, funcionalidade: unknown): void {
  if (typeof modulo !== 'string' || !ID_MODULO.test(modulo)) throw new TypeError(`modulo invalido: ${String(modulo)}`)
  if (!ehFuncionalidade(funcionalidade)) throw new TypeError(`funcionalidade invalida: ${String(funcionalidade)}`)
}

/**
 * O núcleo de uma aplicação que só LÊ a sessão — toda zona. Mesmo que alguém passe
 * `escrita` com um cast, este caminho não monta `entrar` nem `encerrar`.
 */
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

  // Funções nomeadas, não métodos: destruturar `const { exigir } = nucleo.sessao` não
  // pode quebrar o `this` do método que mais provavelmente protege uma rota.
  const atual = async (): Promise<Sessao | null> => {
    const s = await armazenada()
    // projeta: token e qualquer campo futuro ficam para trás
    return s ? { sub: s.sub, nome: s.nome } : null
  }
  const exigir = async (): Promise<Sessao> => {
    const s = await atual()
    if (!s) throw new SessaoInvalida()
    return s
  }

  const destino = criarTransporte({
    app: cfg.app, registro: cfg.destinos, obterToken, tokenDeServico: cfg.tokenDeServico,
    lerTraceparent: cfg.lerTraceparent,
  })
  const acesso = cfg.acesso({ destino })
  const acessoEfetivo = async (): Promise<AcessoEfetivo> => {
    await exigir()
    return acesso.acessoEfetivo()
  }

  return {
    sessao: { atual, exigir },
    destino,
    acesso: {
      acessoEfetivo,
      async exigirModulo(modulo, funcionalidade) {
        validarRequisito(modulo, funcionalidade)
        const { modulos } = await acessoEfetivo()
        if (!modulos.find((m) => m.id === modulo)?.funcionalidades.includes(funcionalidade)) throw new NaoEncontrado()
      },
      async exigirPapel() {
        if (!(await acessoEfetivo()).administra) throw new NaoEncontrado()
      },
    },
  }
}

/**
 * O núcleo do shell, único escritor da sessão (N3). Publicado só em `@erp/nucleo/shell`.
 */
export function criarNucleoDoShell(cfg: ConfigDoNucleoDoShell): NucleoDoShell {
  const nucleo = criarNucleo(cfg)
  const { store, identidade } = cfg.escrita
  return {
    ...nucleo,
    sessao: {
      ...nucleo.sessao,
      async entrar(credencial) {
        const s = await identidade.autenticar(credencial)
        if (!s) return null
        const id = randomUUID()
        await store.gravar(id, s)
        return id
      },
      encerrar: (id) => store.remover(id),
    },
  }
}

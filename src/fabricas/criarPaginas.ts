import 'server-only'
import type { ModuloPermitido, ModuloEfetivo } from '@erp/contratos'
import type { Sessao } from '../portas/sessao.js'
import { SessaoInvalida } from '../interno/erros.js'

/**
 * O que a app entrega do Next e do React. Injetado para o núcleo não depender de nenhum dos
 * dois e para ser testável fora do Next. Na app: `headers`, `notFound`, `redirect`, `cache`.
 */
export type AdaptadorNext = {
  cabecalho(nome: string): Promise<string | null>
  naoEncontrado(): never
  redirecionar(url: string): never
  /** `cache` do React: layout e página dividem uma leitura por requisição. */
  porRequisicao<F extends (...a: never[]) => Promise<unknown>>(f: F): F
}

export type ConfigDePaginas = {
  /** Hosts do shell que servem esta app ao navegador; os mesmos de `serverActions.allowedOrigins`. */
  hostsPermitidos: readonly string[]
  rotaLogin?: string
  next: AdaptadorNext
}

/** O mínimo do núcleo que as páginas usam; `criarNucleo` e `criarNucleoDoShell` servem. */
export type NucleoDasPaginas = {
  sessao: { atual(): Promise<Sessao | null>; exigir(): Promise<Sessao> }
  acesso: {
    modulosPermitidos(): Promise<readonly (ModuloPermitido | ModuloEfetivo)[]>
    exigirModulo(id: string, funcionalidade?: string): Promise<void>
  }
}

export type MotivoDeNegacao = 'origem' | 'sessao' | 'modulo'

/**
 * Kit de página e de Server Action de toda app (ADR-0012). A decisão de acesso mora aqui, uma
 * vez: antes, cada app tinha uma cópia, e o fail-open de `exigirModulo` entrou nas quatro.
 * O núcleo não conhece toast nem moldura: quem chama decide o que devolver ao negar (`aoNegar`).
 */
export function criarPaginas(nucleo: NucleoDasPaginas, cfg: ConfigDePaginas) {
  const { next } = cfg
  const rotaLogin = cfg.rotaLogin ?? '/login'

  /** Posto pelo proxy; layouts não recebem o caminho de outra forma. */
  const caminhoAtual = async () => (await next.cabecalho('x-erp-caminho')) ?? '/'
  const irParaLogin = async (): Promise<never> =>
    next.redirecionar(`${rotaLogin}?de=${encodeURIComponent(await caminhoAtual())}`)

  /** Camada 2: o cookie existe (camada 1 viu), mas a sessão precisa existir no store. */
  const sessaoDaPagina = next.porRequisicao(async (): Promise<Sessao> =>
    (await nucleo.sessao.atual()) ?? irParaLogin())

  /** Uma consulta à gestão de acesso por requisição (ADR-0009, decisão 7). */
  const modulosPermitidos = next.porRequisicao(async (): Promise<readonly (ModuloPermitido | ModuloEfetivo)[]> => {
    try {
      return await nucleo.acesso.modulosPermitidos()
    } catch (e) {
      if (e instanceof SessaoInvalida) return irParaLogin()
      throw e
    }
  })

  /**
   * Camada 2 de acesso a módulo e funcionalidade (invariante 16, ADR-0014).
   * Negado: 404, sem página de "sem acesso" (invariante 8).
   * **Fail-closed:** se a gestão de acesso falhar, o erro sobe e a página não
   * renderiza; engolir o erro entregava o módulo no payload RSC (gate "Shell novo", V1).
   */
  async function exigirModulo(id: string, funcionalidade?: string): Promise<void> {
    const permitidos = await modulosPermitidos()
    const mod = permitidos.find((m) => m.id === id)
    if (!mod) next.naoEncontrado()
    if (funcionalidade !== undefined) {
      const modEfetivo = mod as { funcionalidades?: readonly string[] }
      if (!Array.isArray(modEfetivo.funcionalidades) || !modEfetivo.funcionalidades.includes(funcionalidade)) {
        next.naoEncontrado()
      }
    }
  }

  /**
   * A checagem de origem do Next deixa passar requisição SEM `Origin` (challenger_base_1);
   * aqui ela é obrigatória. Lista vazia recusa tudo: configuração faltando não abre a porta.
   */
  async function origemPermitida(): Promise<boolean> {
    const site = await next.cabecalho('sec-fetch-site')
    if (site && site !== 'same-origin') return false
    try {
      return cfg.hostsPermitidos.includes(new URL((await next.cabecalho('origin')) ?? '').host)
    } catch {
      return false
    }
  }

  /**
   * Envelope de toda Server Action (invariantes 5 e 16): origem, sessão e módulo, nessa ordem,
   * antes de qualquer efeito. A action é endpoint público e nenhum layout roda antes dela.
   * Negou: devolve o que `aoNegar` produzir. Erro do `corpo` sobe para quem chamou.
   */
  async function acaoProtegida<R>(
    modulo: string,
    corpo: () => Promise<R>,
    aoNegar: (motivo: MotivoDeNegacao) => Promise<R>,
    funcionalidade?: string,
  ): Promise<R> {
    if (!(await origemPermitida())) return aoNegar('origem')
    try {
      await nucleo.sessao.exigir()
    } catch {
      return aoNegar('sessao')
    }
    try {
      await nucleo.acesso.exigirModulo(modulo, funcionalidade)
    } catch (e) {
      if (e instanceof SessaoInvalida) return aoNegar('sessao')
      return aoNegar('modulo')
    }
    return corpo()
  }

  return { caminhoAtual, sessaoDaPagina, modulosPermitidos, exigirModulo, acaoProtegida }
}

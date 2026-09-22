import 'server-only'
import type { AcessoEfetivo } from '@erp/contratos'
import type { Sessao } from '../portas/sessao.js'
import { SessaoInvalida } from '../interno/erros.js'
import { validarRequisito } from './criarNucleo.js'

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
  /**
   * Entrada de menu de quem administra (papel na gestão de acesso), ex.: a zona de acesso.
   * Configuração do kit, não dado do domínio: o que sai do servidor é só `administra`.
   */
  entradaAdministrativa?: ItemDeMenu
  /** Primeira entrada do menu de toda sessão válida (o início do shell). Não é módulo. */
  entradaInicial?: ItemDeMenu
}

/** Item do menu da moldura. Uma entrada por módulo: `prefixo = /<id>`, `rotulo = nome`. */
export type ItemDeMenu = { readonly id: string; readonly rotulo: string; readonly prefixo: string }

/** O que uma Server Action exige: uma funcionalidade de um módulo, ou papel administrativo. */
export type Requisito = { readonly modulo: string; readonly funcionalidade: string } | { readonly administra: true }

/** O mínimo do núcleo que as páginas usam; `criarNucleo` e `criarNucleoDoShell` servem. */
export type NucleoDasPaginas = {
  sessao: { atual(): Promise<Sessao | null>; exigir(): Promise<Sessao> }
  acesso: { acessoEfetivo(): Promise<AcessoEfetivo> }
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

  /** Uma consulta à gestão de acesso por requisição (ADR-0009, decisão 7); `401` vai ao login. */
  const acessoEfetivo = next.porRequisicao(async (): Promise<AcessoEfetivo> => {
    try {
      return await nucleo.acesso.acessoEfetivo()
    } catch (e) {
      if (e instanceof SessaoInvalida) return irParaLogin()
      throw e
    }
  })

  /** Menu da moldura. Gestão de acesso fora: lança, e a moldura mostra "Serviço indisponível". */
  async function modulosPermitidos(): Promise<readonly ItemDeMenu[]> {
    const { modulos, administra } = await acessoEfetivo()
    return [
      ...(cfg.entradaInicial ? [cfg.entradaInicial] : []),
      ...modulos.map((m) => ({ id: m.id, rotulo: m.nome, prefixo: `/${m.id}` })),
      ...(administra && cfg.entradaAdministrativa ? [cfg.entradaAdministrativa] : []),
    ]
  }

  /**
   * Camada 2 de acesso (invariante 16, ADR-0014 adendo 1): módulo E funcionalidade, sempre.
   * Negado: 404, sem página de "sem acesso" (invariante 8).
   * **Fail-closed:** se a gestão de acesso falhar, o erro sobe e a página não
   * renderiza; engolir o erro entregava o módulo no payload RSC (gate "Shell novo", V1).
   */
  async function exigirModulo(modulo: string, funcionalidade: string): Promise<void> {
    validarRequisito(modulo, funcionalidade)
    const { modulos } = await acessoEfetivo()
    if (!modulos.find((m) => m.id === modulo)?.funcionalidades.includes(funcionalidade)) next.naoEncontrado()
  }

  /** Só a zona de acesso: 404 para quem não tem papel. Quem decide cada ação é o domínio (invariante 9). */
  async function exigirPapel(): Promise<void> {
    if (!(await acessoEfetivo()).administra) next.naoEncontrado()
  }

  /** Mesma decisão de `exigirModulo`/`exigirPapel`, sem o `notFound()` do Next. */
  async function permitido(r: Requisito): Promise<boolean> {
    const acesso = await nucleo.acesso.acessoEfetivo()
    if ('administra' in r) return acesso.administra
    return !!acesso.modulos.find((m) => m.id === r.modulo)?.funcionalidades.includes(r.funcionalidade)
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
   * Envelope de toda Server Action (invariantes 5 e 16): origem, sessão e requisito, nessa ordem,
   * antes de qualquer efeito. A action é endpoint público e nenhum layout roda antes dela.
   * Negou: devolve o que `aoNegar` produzir. Erro do `corpo` sobe para quem chamou.
   */
  async function acaoProtegida<R>(
    requisito: Requisito,
    corpo: () => Promise<R>,
    aoNegar: (motivo: MotivoDeNegacao) => Promise<R>,
  ): Promise<R> {
    // argumento mal formado é bug da app: falha alto, antes de olhar a requisição
    if (!('administra' in requisito)) validarRequisito(requisito.modulo, requisito.funcionalidade)
    if (!(await origemPermitida())) return aoNegar('origem')
    try {
      await nucleo.sessao.exigir()
    } catch {
      return aoNegar('sessao')
    }
    let ok: boolean
    try {
      ok = await permitido(requisito)
    } catch (e) {
      if (e instanceof SessaoInvalida) return aoNegar('sessao')
      return aoNegar('modulo')
    }
    return ok ? corpo() : aoNegar('modulo')
  }

  return { caminhoAtual, sessaoDaPagina, acessoEfetivo, modulosPermitidos, exigirModulo, exigirPapel, acaoProtegida }
}

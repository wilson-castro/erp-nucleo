import 'server-only'
import { randomUUID } from 'node:crypto'
import { setTimeout as pausa } from 'node:timers/promises'
import { ehFuncionalidade, type AcessoEfetivo, type CodigoErro } from '@erp/contratos'
import type { LeitorDeSessao, EscritorDeSessao, Sessao, SessaoArmazenada } from '../portas/sessao.js'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import type { ClienteDeDestino, RegistroDeDestinos } from '../portas/destinos.js'
import type { FabricaDeAcesso } from '../portas/acesso.js'
import { criarTransporte } from '../interno/destinos.js'
import { NaoEncontrado, SessaoInvalida } from '../interno/erros.js'
import { ID_MODULO } from '../interno/acesso-v2.js'
import { lerInteiroEntre, lerNumeroPositivo, lerTimeoutDeDestinoMs } from '../interno/configuracao.js'

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

/**
 * Falha registrada no servidor: motivo fixo, código e `supportId`, nunca token nem dado da pessoa (invariante 12).
 * `motivo` nomeia a causa para quem lê o log; `janela-de-renovacao` é `ERP_RENOVACAO_JANELA_S` maior ou igual
 * a metade da vida do token.
 */
export type FalhaDoNucleo = { motivo: 'janela-de-renovacao'; codigo: CodigoErro; supportId: string }

/** Só o shell passa `escrita`. É o que faz dele o único escritor da sessão (N3). */
export type ConfigDoNucleoDoShell = ConfigDoNucleo & {
  escrita: { store: EscritorDeSessao; identidade: ProvedorDeIdentidade }
  /**
   * Onde registrar falha de configuração vista numa sessão (hoje, `ERP_RENOVACAO_JANELA_S` maior ou igual
   * a metade da vida do token). Ausente: uma linha em `console.error`.
   */
  registrarFalha?: (falha: FalhaDoNucleo) => void
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
 * Resultado de `renovarSessao`, sem token: `ausente` (sem sessão válida, ou encerrada durante a
 * espera), `em-dia` (o token não está na janela de renovação, ou outra requisição o renovou enquanto
 * esta esperava), `em-andamento` (outra requisição tem o lock e esta segue sem token novo: com o token
 * ainda válido, sem esperar; com ele vencido, depois de esperar até `ERP_RENOVACAO_ESPERA_MS`),
 * `renovada` (gravada com token novo) ou `revogada` (o IdP recusou; a sessão foi removida).
 */
export type EstadoDaRenovacao = 'ausente' | 'em-dia' | 'em-andamento' | 'renovada' | 'revogada'

/**
 * `store` e `identidade` NÃO são expostos. `identidade.concluir` e `renovar` devolvem a sessão
 * com os tokens dentro, e `store.ler` também; a transação leva o `code_verifier`. Fazendo a
 * fábrica guardar a transação, concluir, cunhar o id e gravar, nada disso chega a quem chama:
 * o shell recebe ids opacos, a URL do IdP e o destino, e mais nada.
 */
export type NucleoDoShell = Omit<Nucleo, 'sessao'> & {
  sessao: Nucleo['sessao'] & {
    /**
     * Cria e guarda a transação de login. `idTransacao` vai no cookie `__Host-erp-login`; `expiraEm`
     * (ms desde a época, `ERP_LOGIN_TRANSACAO_S`) é o fim da transação, para o cookie viver o mesmo.
     */
    iniciarLogin(destino?: string): Promise<{ url: string; idTransacao: string; expiraEm: number }>
    /**
     * Consome a transação (uso único, mesmo se o retorno for recusado), conclui no IdP, cunha
     * um id de sessão NOVO e grava. Devolve só o id e o destino guardado na transação.
     */
    concluirLogin(idTransacao: string | undefined, parametros: Record<string, string>): Promise<{ id: string; destino: string } | null>
    /**
     * Renovação proativa e serializada (ADR-0013, decisão 4): fora da janela, nada; dentro, só
     * quem ganha o lock relê a sessão e chama o IdP. Quem perde o lock com o token ainda válido
     * não espera. Com o token já vencido (D19-B), quem perde relê a sessão no store a cada
     * `ERP_RENOVACAO_ESPERA_PASSO_MS` até `ERP_RENOVACAO_ESPERA_MS`: token válido é `em-dia`, sessão
     * sumida é `ausente`, o teto é `em-andamento`. A espera nunca chama o IdP: o refresh token é gasto
     * uma vez só. Erro transitório do IdP lança, a sessão fica e o lock segura novas tentativas até
     * vencer (backoff); nesse tempo, cada requisição com o token vencido espera o teto.
     */
    renovarSessao(id: string | undefined): Promise<EstadoDaRenovacao>
    /**
     * Remove do store ANTES de pedir ao IdP a URL de logout: a sessão acaba em todas as zonas
     * mesmo se o IdP falhar. `urlLogout` é `null` sem sessão ou sem logout no IdP.
     */
    encerrarSessao(id: string | undefined): Promise<{ urlLogout: string | null }>
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
 * Lê e valida na criação `ERP_RENOVACAO_JANELA_S`, `ERP_RENOVACAO_LOCK_S`, `ERP_RENOVACAO_ESPERA_MS`
 * e `ERP_RENOVACAO_ESPERA_PASSO_MS` (docs/CONFIGURACAO.md §1), e o lock contra `ERP_DESTINO_TIMEOUT_MS`.
 * A janela contra a vida do token só pode ser conferida por sessão, ao receber o token (D20).
 */
export function criarNucleoDoShell(cfg: ConfigDoNucleoDoShell): NucleoDoShell {
  const janelaMs = lerNumeroPositivo(process.env.ERP_RENOVACAO_JANELA_S, 60, 'ERP_RENOVACAO_JANELA_S', 3_600) * 1_000
  const lockMs = lerNumeroPositivo(process.env.ERP_RENOVACAO_LOCK_S, 15, 'ERP_RENOVACAO_LOCK_S', 300) * 1_000
  // D20: o lock tem de durar mais que duas idas ao IdP (discovery e token, cada uma até o timeout). Se vence
  // com a renovação em curso, outra requisição ganha o lock e gasta o mesmo refresh token: com rotação e
  // detecção de reuso, o IdP revoga a sessão.
  const timeoutMs = lerTimeoutDeDestinoMs()
  if (lockMs <= 2 * timeoutMs) {
    throw new Error(`configuracao invalida: ERP_RENOVACAO_LOCK_S x 1000 (${lockMs}) deve ser maior que 2 x ERP_DESTINO_TIMEOUT_MS (${2 * timeoutMs})`)
  }
  // D19-B: espera de quem perde o lock com o token vencido; `0` desliga. Menor que o lock: depois
  // dele, outra requisição pode ganhar o lock, e esperar mais não serve a ninguém.
  const esperaMs = lerInteiroEntre(process.env.ERP_RENOVACAO_ESPERA_MS, 2_000, 'ERP_RENOVACAO_ESPERA_MS', 0, 300_000)
  if (esperaMs >= lockMs) {
    throw new Error(`configuracao invalida: ERP_RENOVACAO_ESPERA_MS deve ser menor que ERP_RENOVACAO_LOCK_S x 1000 (${lockMs}), recebeu "${esperaMs}"`)
  }
  const passoMs = lerInteiroEntre(process.env.ERP_RENOVACAO_ESPERA_PASSO_MS, 50, 'ERP_RENOVACAO_ESPERA_PASSO_MS', 10, 300_000)
  if (esperaMs > 0 && passoMs >= esperaMs) {
    throw new Error(`configuracao invalida: ERP_RENOVACAO_ESPERA_PASSO_MS deve ser menor que ERP_RENOVACAO_ESPERA_MS (${esperaMs}), recebeu "${passoMs}"`)
  }
  const nucleo = criarNucleo(cfg)
  const { store, identidade } = cfg.escrita
  const registrarNoConsole = (f: FalhaDoNucleo) =>
    console.error(`[renovacao] ERP_RENOVACAO_JANELA_S >= metade da vida do token: motivo=${f.motivo} codigo=${f.codigo} supportId=${f.supportId}`)
  // O registro acontece depois da ida ao IdP: se o injetado falha (lança ou rejeita), o login e a renovação
  // seguem e a falha vai ao console. O erro do registro não é impresso: pode carregar o que não deve.
  const registrarFalha = (f: FalhaDoNucleo) => {
    if (!cfg.registrarFalha) return registrarNoConsole(f)
    try {
      const r: unknown = cfg.registrarFalha(f)
      if (r instanceof Promise) r.catch(() => registrarNoConsole(f))
    } catch { registrarNoConsole(f) }
  }

  const valida = async (id: string) => {
    const s = await cfg.sessao.ler(id)
    return s && Date.now() < s.expiraEm ? s : null
  }
  // D20: a janela tem de ser menor que metade da vida do token. Maior que a vida, o token novo já nasce dentro
  // dela e a sessão renova a cada vencimento do lock. A vida só se conhece com o token na mão: quando a regra
  // falha numa sessão, a janela dela vira metade da vida.
  const vidaConhecida = (s: SessaoArmazenada) =>
    typeof s.tokenVidaMs === 'number' && Number.isFinite(s.tokenVidaMs) && s.tokenVidaMs > 0 ? s.tokenVidaMs : undefined
  const janelaDe = (s: SessaoArmazenada) => {
    const vida = vidaConhecida(s)
    return vida === undefined ? janelaMs : Math.min(janelaMs, vida / 2)
  }
  const violaJanela = (s: SessaoArmazenada | null) => {
    const vida = s ? vidaConhecida(s) : undefined
    return vida !== undefined && janelaMs * 2 >= vida
  }
  /**
   * Mede a vida do token recém-recebido e a guarda na sessão. Token cortado pelo fim da sessão
   * (`tokenExpiraEm === expiraEm`) não mede a vida do token: fica sem. Registra a violação uma vez por
   * sessão: no login, ou na renovação que a fez aparecer (`anterior` sem ela).
   */
  const comVidaDoToken = (s: SessaoArmazenada, anterior: SessaoArmazenada | null): SessaoArmazenada => {
    const { tokenVidaMs: _, ...resto } = s
    const medida: SessaoArmazenada = s.tokenExpiraEm !== undefined && s.tokenExpiraEm < s.expiraEm
      ? { ...resto, tokenVidaMs: s.tokenExpiraEm - Date.now() }
      : resto
    if (violaJanela(medida) && !violaJanela(anterior)) registrarFalha({ motivo: 'janela-de-renovacao', codigo: 'ERRO_INTERNO', supportId: randomUUID() })
    return medida
  }

  // sem `tokenExpiraEm` não há o que antecipar: o token vale a sessão inteira
  const emDia = (s: SessaoArmazenada) => s.tokenExpiraEm === undefined || s.tokenExpiraEm - Date.now() > janelaDe(s)
  const tokenVale = (s: SessaoArmazenada) => s.tokenExpiraEm === undefined || Date.now() < s.tokenExpiraEm

  // Só relê o store, nunca o IdP. Volta no máximo um passo depois do teto (a última pausa é cortada nele).
  // Não compara `s.sub` com o `sub` de antes: nenhum caminho troca a pessoa sob o mesmo id. `concluirLogin`
  // cunha um id novo a cada login, e a renovação só regrava com o mesmo `sub` (outro sujeito remove a sessão,
  // e a releitura seguinte volta `ausente`).
  const esperarRenovacao = async (id: string): Promise<EstadoDaRenovacao> => {
    const limite = Date.now() + esperaMs
    while (Date.now() < limite) {
      await pausa(Math.min(passoMs, limite - Date.now()))
      const s = await valida(id)
      if (!s) return 'ausente'
      if (tokenVale(s)) return 'em-dia'
    }
    return 'em-andamento'
  }

  return {
    ...nucleo,
    sessao: {
      ...nucleo.sessao,

      async iniciarLogin(destino) {
        const { url, transacao } = await identidade.iniciar(destino)
        await store.gravarTransacao(transacao)
        return { url, idTransacao: transacao.id, expiraEm: transacao.expiraEm }
      },

      async concluirLogin(idTransacao, parametros) {
        if (typeof idTransacao !== 'string' || idTransacao.length === 0) return null
        const transacao = await store.consumirTransacao(idTransacao)
        if (!transacao || Date.now() >= transacao.expiraEm) return null
        const s = await identidade.concluir(parametros, transacao)
        if (!s) return null
        // id novo a cada login: um id que existisse antes do login não vira sessão autenticada
        const id = randomUUID()
        await store.gravar(id, comVidaDoToken(s, null))
        return { id, destino: transacao.destino }
      },

      async renovarSessao(id) {
        if (typeof id !== 'string' || id.length === 0) return 'ausente'
        const antes = await valida(id)
        if (!antes) return 'ausente'
        if (emDia(antes)) return 'em-dia'
        if (!(await store.adquirirLockRenovacao(id, lockMs))) {
          // Token ainda válido: segue com ele, sem esperar (ADR-0013, decisão 4). Vencido, seguir com
          // ele leva ao login com a sessão intacta (D19): espera o vencedor gravar o token novo.
          return tokenVale(antes) ? 'em-andamento' : esperarRenovacao(id)
        }
        // Relê com o lock na mão: outro processo pode ter renovado entre a leitura e o lock, e o
        // refresh token de antes, com rotação, já foi gasto. Usá-lo derrubaria a sessão no IdP.
        const s = await valida(id)
        if (!s) return 'ausente'
        if (emDia(s)) return 'em-dia'
        const r = await identidade.renovar(s)
        if (r.status === 'renovada' && r.sessao.sub === s.sub) {
          // regravar, não gravar: se a sessão foi encerrada durante a ida ao IdP, ela não volta
          return (await store.regravar(id, comVidaDoToken(r.sessao, s))) ? 'renovada' : 'ausente'
        }
        // revogada, ou o IdP devolveu outra pessoa: a sessão não continua com nenhuma das duas
        await store.remover(id)
        return 'revogada'
      },

      async encerrarSessao(id) {
        if (typeof id !== 'string' || id.length === 0) return { urlLogout: null }
        const s = await cfg.sessao.ler(id)
        await store.remover(id)
        if (!s) return { urlLogout: null }
        return identidade.encerrar(s)
      },
    },
  }
}

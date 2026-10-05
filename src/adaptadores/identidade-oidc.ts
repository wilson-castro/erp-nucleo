import 'server-only'
import * as oidc from 'openid-client'
import type { ProvedorDeIdentidade, ResultadoRenovacao } from '../portas/identidade.js'
import type { SessaoArmazenada } from '../portas/sessao.js'
import { httpPermitido, lerNumeroPositivo, lerTimeoutDeDestinoMs } from '../interno/configuracao.js'
import { ErroDeAplicacao } from '../interno/erros.js'
import { lerVidaDaTransacaoMs, novaTransacao } from '../interno/login.js'

export type ConfigIdentidadeOidc = {
  /** URL do emissor (`IDP_EMISSOR`), a mesma do `iss` dos tokens. */
  emissor: string
  /** Cliente confidencial do shell (`IDP_CLIENTE_ID`). */
  clienteId: string
  /** `IDP_CLIENTE_SEGREDO`: só no servidor, nunca `NEXT_PUBLIC_*` (invariante 11). */
  clienteSegredo: string
  /** URL absoluta de `/api/auth/retorno` do shell, registrada no IdP como `redirect_uri`. */
  urlRetorno: string
  /** Para onde o IdP manda o navegador depois do logout. Ausente: o IdP decide. */
  urlPosLogout?: string
}

/** Audiência que os domínios exigem no access token (ADR-0013, decisão 7). */
const AUDIENCIA_DOMINIOS = 'erp-dominios'
/** `profile` traz o `preferred_username`, que é o ator nos domínios. */
const ESCOPO = 'openid profile'

/** Erro de configuração: lançado na criação do provedor, no boot do shell. Nunca leva o segredo. */
function recusar(campo: string, motivo: string): never {
  throw new Error(`identidadeOidc: ${campo} ${motivo}`)
}

/** `http://` só fora de produção, ou em produção com `ERP_PERMITIR_HTTP_LOCAL=1` e host de loopback (ADR-0013, decisão 5 e adendo 2). */
function validarUrl(campo: string, valor: unknown, soOrigemECaminho = false): URL {
  let url: URL
  try { url = new URL(String(valor)) } catch { recusar(campo, 'nao e URL absoluta') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') recusar(campo, 'precisa de https')
  if (!httpPermitido(url)) recusar(campo, 'precisa de https em producao')
  if (url.username || url.password) recusar(campo, 'nao pode carregar credencial na URL')
  if (soOrigemECaminho && (url.search || url.hash)) recusar(campo, 'nao pode ter query nem fragmento')
  return url
}

/** Payload de um JWT sem verificar a assinatura: só para o access token, que veio direto do token endpoint. */
function payloadDe(token: string): Record<string, unknown> | null {
  const partes = token.split('.')
  if (partes.length !== 3) return null
  try {
    const p: unknown = JSON.parse(Buffer.from(partes[1]!, 'base64url').toString('utf8'))
    return typeof p === 'object' && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : null
  } catch { return null }
}

const texto = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/**
 * Erro transitório: rede, timeout ou 5xx do IdP. Quem chama tenta de novo depois; o resto (recusa
 * OAuth em 4xx, validação de `state`, `iss`, `nonce`, assinatura de claims) é resposta definitiva.
 */
function ehTransitorio(e: unknown): boolean {
  if (e instanceof TypeError) return true   // fetch: conexão recusada, DNS
  if (e instanceof oidc.ResponseBodyError) return e.status >= 500
  if (e instanceof oidc.ClientError) {
    if (e.code === 'OAUTH_TIMEOUT' || e.code === 'OAUTH_ABORT') return true
    return e.cause instanceof Response && e.cause.status >= 500
  }
  return false
}

/**
 * Provedor de identidade OIDC (ADR-0013): código de autorização com PKCE S256, `state` e `nonce`
 * da transação, refresh com rotação. Só o shell usa, por `@erp/nucleo/shell`; `openid-client` é
 * `peerDependency` opcional e só este módulo o importa.
 *
 * - Toda requisição ao IdP passa por um `fetch` com `redirect: 'manual'` e timeout
 *   `ERP_DESTINO_TIMEOUT_MS`; todo endpoint do discovery tem de ter a origem do emissor.
 * - A sessão leva `sub` do id_token (a pessoa) e `nome` (`name`, ou o `preferred_username`). O
 *   `preferred_username` é obrigatório: é o ator nos domínios. O access token tem de ter
 *   `erp-dominios` na `aud` e, se trouxer `sub`, o mesmo do id_token.
 * - Vida: `tokenExpiraEm` vem de `expires_in`; `expiraEm` de `refresh_expires_in` (inatividade,
 *   recomeça a cada renovação), ou `ERP_SESSAO_INATIVIDADE_S` quando o IdP não o informa.
 * - `concluir` devolve `null` para retorno recusado; `renovar` devolve `revogada` só para
 *   `invalid_grant` em 4xx ou sessão sem refresh token. Erro transitório, e no `renovar` qualquer
 *   outro erro (inclusive token novo que não passa nas regras acima), lança
 *   `ErroDeAplicacao('ERRO_INTERNO')`, sem detalhe do IdP nem da biblioteca (invariante 12).
 *
 * - `encerrar` devolve a URL de logout do IdP só com `client_id` e `post_logout_redirect_uri`: ela
 *   vai ao navegador, então nenhum token entra nela.
 *
 * O discovery é feito na primeira chamada e guardado; uma falha não fica guardada.
 */
export function identidadeOidc(config: ConfigIdentidadeOidc): ProvedorDeIdentidade {
  const emissor = validarUrl('emissor', config.emissor, true)
  // o IdP compara a redirect_uri inteira com a registrada; query ou fragmento aqui é erro de configuração
  const urlRetorno = validarUrl('urlRetorno', config.urlRetorno, true).href
  const urlPosLogout = config.urlPosLogout === undefined ? undefined : validarUrl('urlPosLogout', config.urlPosLogout).href
  if (!texto(config.clienteId)) recusar('clienteId', 'e obrigatorio')
  if (!texto(config.clienteSegredo)) recusar('clienteSegredo', 'e obrigatorio')
  const timeoutMs = lerTimeoutDeDestinoMs()
  const inatividadeMs = lerNumeroPositivo(process.env.ERP_SESSAO_INATIVIDADE_S, 1_800, 'ERP_SESSAO_INATIVIDADE_S', 86_400) * 1_000
  const vidaTransacaoMs = lerVidaDaTransacaoMs()

  const buscar: oidc.CustomFetch = (url, { body, duplex, headers, method, signal }) => {
    const limite = AbortSignal.timeout(timeoutMs)
    const init: RequestInit & { duplex?: 'half' } = {
      headers, method,
      // seguir redirecionamento levaria código, verifier ou refresh token a uma origem que ninguém validou
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, limite]) : limite,
    }
    // `Uint8Array<ArrayBufferLike>` do oauth4webapi x `BodyInit` do lib DOM: só diferença de tipos
    if (body !== undefined) init.body = body as BodyInit | null
    if (duplex !== undefined) init.duplex = duplex
    return fetch(url, init)
  }

  let descoberta: Promise<oidc.Configuration> | null = null
  const descobrir = async (): Promise<oidc.Configuration> => {
    const cfg = await oidc.discovery(emissor, config.clienteId, config.clienteSegredo, undefined, {
      [oidc.customFetch]: buscar,
      ...(emissor.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : {}),
    })
    const metadados = cfg.serverMetadata() as Record<string, unknown>
    for (const [campo, valor] of Object.entries(metadados)) {
      if (!campo.endsWith('_endpoint') && campo !== 'jwks_uri') continue
      if (typeof valor !== 'string' || new URL(valor).origin !== emissor.origin) {
        throw new Error(`identidadeOidc: ${campo} fora da origem do emissor`)
      }
    }
    return cfg
  }
  const obter = async (): Promise<oidc.Configuration> => {
    descoberta ??= descobrir()
    try {
      return await descoberta
    } catch {
      descoberta = null
      throw new ErroDeAplicacao('ERRO_INTERNO')
    }
  }

  /** Sessão a partir da resposta do token endpoint. `anterior`: a da renovação, que pode vir sem id_token. */
  const sessaoDe = (
    r: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers, anterior?: SessaoArmazenada,
  ): SessaoArmazenada | null => {
    const claims = r.claims()
    let sub: string
    let nome: string
    if (claims) {
      if (!texto(claims.sub) || !texto(claims.preferred_username)) return null
      sub = claims.sub
      nome = texto(claims.name) ? claims.name : claims.preferred_username
    } else if (anterior) {
      ({ sub, nome } = anterior)
    } else {
      return null
    }

    const acesso = payloadDe(r.access_token)
    if (!acesso) return null
    const aud = acesso.aud
    if (!(aud === AUDIENCIA_DOMINIOS || (Array.isArray(aud) && aud.includes(AUDIENCIA_DOMINIOS)))) return null
    if (acesso.sub !== undefined && acesso.sub !== sub) return null

    const agora = Date.now()
    const refreshExpira = r.refresh_expires_in
    const expiraEm = agora + (typeof refreshExpira === 'number' && refreshExpira > 0 ? refreshExpira * 1_000 : inatividadeMs)
    const sessao: SessaoArmazenada = { sub, nome, accessToken: r.access_token, expiraEm }
    if (typeof r.expires_in === 'number' && r.expires_in > 0) sessao.tokenExpiraEm = Math.min(agora + r.expires_in * 1_000, expiraEm)
    const refreshToken = r.refresh_token ?? anterior?.refreshToken
    if (refreshToken !== undefined) sessao.refreshToken = refreshToken
    const idToken = r.id_token ?? anterior?.idToken
    if (idToken !== undefined) sessao.idToken = idToken
    return sessao
  }

  return {
    async iniciar(destino) {
      const cfg = await obter()
      const transacao = novaTransacao(destino, vidaTransacaoMs)
      const url = oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: urlRetorno,
        scope: ESCOPO,
        code_challenge: await oidc.calculatePKCECodeChallenge(transacao.codeVerifier),
        code_challenge_method: 'S256',
        state: transacao.state,
        nonce: transacao.nonce,
      })
      return { url: url.href, transacao }
    },

    async concluir(parametros, transacao) {
      if (Date.now() >= transacao.expiraEm) return null
      const cfg = await obter()
      const retorno = new URL(urlRetorno)
      for (const [k, v] of Object.entries(parametros ?? {})) if (typeof v === 'string') retorno.searchParams.set(k, v)
      try {
        const r = await oidc.authorizationCodeGrant(cfg, retorno, {
          pkceCodeVerifier: transacao.codeVerifier,
          expectedState: transacao.state,
          expectedNonce: transacao.nonce,
          idTokenExpected: true,
        })
        return sessaoDe(r)
      } catch (e) {
        if (ehTransitorio(e)) throw new ErroDeAplicacao('ERRO_INTERNO')
        return null
      }
    },

    async renovar(sessao): Promise<ResultadoRenovacao> {
      if (!texto(sessao.refreshToken)) return { status: 'revogada' }
      const cfg = await obter()
      let s: SessaoArmazenada | null
      try {
        s = sessaoDe(await oidc.refreshTokenGrant(cfg, sessao.refreshToken), sessao)
      } catch (e) {
        if (e instanceof oidc.ResponseBodyError && e.status >= 400 && e.status < 500 && e.error === 'invalid_grant') {
          return { status: 'revogada' }
        }
        throw new ErroDeAplicacao('ERRO_INTERNO')
      }
      if (!s) throw new ErroDeAplicacao('ERRO_INTERNO')
      return { status: 'renovada', sessao: s }
    },

    // A URL vai ao navegador (303 ou formulário de logout, ADR-0013, decisão 6): leva só `client_id` e
    // `post_logout_redirect_uri`, nunca `id_token_hint` nem outro token (invariante 1). Sem o hint, o
    // IdP pode pedir confirmação ao usuário (OIDC RP-Initiated Logout 1.0); é o preço aceito.
    async encerrar() {
      const cfg = await obter()
      if (!cfg.serverMetadata().end_session_endpoint) return { urlLogout: null }
      const parametros: Record<string, string> = { client_id: config.clienteId }
      if (urlPosLogout) parametros.post_logout_redirect_uri = urlPosLogout
      return { urlLogout: oidc.buildEndSessionUrl(cfg, parametros).href }
    },
  }
}

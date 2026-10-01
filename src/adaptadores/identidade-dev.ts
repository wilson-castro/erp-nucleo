import 'server-only'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'
import type { SessaoArmazenada } from '../portas/sessao.js'
import { lerNumeroPositivo } from '../interno/configuracao.js'
import { lerVidaDaTransacaoMs, mesmoSegredo, novaTransacao } from '../interno/login.js'

/**
 * Atores de desenvolvimento. Só nome: perfis e grupos ficam nos domínios (gestão de
 * acesso e cada domínio de negócio), nunca na sessão.
 */
const ATORES: Readonly<Record<string, string>> = {
  ana: 'Ana Operadora',
  bruno: 'Bruno Analista',
  carla: 'Carla Administradora de Acesso',
  davi: 'Davi Sem Perfil',
  eva: 'Eva Apenas Leitora',
}

export const ATORES_DE_DESENVOLVIMENTO: readonly string[] = Object.keys(ATORES)

const PREFIXO_REFRESH = 'dev-refresh'

/**
 * Provedor de DESENVOLVIMENTO. Substituído por OIDC antes de produção. Recusa-se a
 * existir em produção — um IdP que aceita um nome de usuário sem senha não pode subir
 * por engano.
 *
 * Segue o mesmo ciclo do OIDC (ADR-0013, decisão 1), para a verificação ponta a ponta
 * exercitar o mesmo código de transação no shell. Contrato da etapa de login de dev:
 *
 * - `iniciar(destino)` devolve `url` = `/login/dev?state=<state>&nonce=<nonce>` (relativa ao
 *   shell). A página de login de dev do shell mostra os atores e manda o navegador para o
 *   retorno do shell com os mesmos `state` e `nonce` e o ator escolhido:
 *   `/api/auth/retorno?state=<state>&nonce=<nonce>&usuario=<ator>`.
 * - `concluir({ state, nonce, usuario }, transacao)`: `state` e `nonce` têm de ser os da transação
 *   (comparação em tempo constante), a transação não pode ter vencido e `usuario` tem de ser um
 *   dos `ATORES_DE_DESENVOLVIMENTO`. No OIDC o `nonce` volta dentro do `id_token`; aqui, como
 *   parâmetro, para o mesmo teste valer.
 * - O refresh token é `dev-refresh.<sub>.<expira em ms>.<aleatório>`: sem estado no processo,
 *   porque o proxy e as rotas do shell podem rodar em instâncias de módulo diferentes. Não é
 *   segredo (nada aqui é: o login de dev não tem senha); `renovar` só confere a forma, o sujeito
 *   e a validade, e devolve `revogada` para o resto.
 *
 * Tempos: `ERP_TOKEN_VIDA_S` (vida do access token), `ERP_SESSAO_INATIVIDADE_S` (vida do refresh
 * token e fim da sessão, que recomeça a cada renovação) e `ERP_LOGIN_TRANSACAO_S`.
 */
export function identidadeDev(): ProvedorDeIdentidade {
  if (process.env.NODE_ENV === 'production' && process.env.ERP_PERMITIR_IDENTIDADE_DEV !== '1') {
    throw new Error('identidadeDev nao roda em producao; use o provedor OIDC')
  }
  const vidaTokenMs = lerNumeroPositivo(process.env.ERP_TOKEN_VIDA_S, 300, 'ERP_TOKEN_VIDA_S', 3_600) * 1_000
  const inatividadeMs = lerNumeroPositivo(process.env.ERP_SESSAO_INATIVIDADE_S, 1_800, 'ERP_SESSAO_INATIVIDADE_S', 86_400) * 1_000
  const vidaTransacaoMs = lerVidaDaTransacaoMs()

  const sessaoDe = (sub: string): SessaoArmazenada => {
    const agora = Date.now()
    const expiraEm = agora + inatividadeMs
    return {
      sub,
      nome: ATORES[sub]!,
      accessToken: `dev.${sub}.${randomUUID()}`,
      expiraEm,
      tokenExpiraEm: Math.min(agora + vidaTokenMs, expiraEm),
      refreshToken: `${PREFIXO_REFRESH}.${sub}.${expiraEm}.${randomBytes(16).toString('base64url')}`,
    }
  }

  const ehAtor = (v: unknown): v is string => typeof v === 'string' && Object.hasOwn(ATORES, v)

  return {
    async iniciar(destino) {
      const transacao = novaTransacao(destino, vidaTransacaoMs)
      const busca = new URLSearchParams({ state: transacao.state, nonce: transacao.nonce })
      return { url: `/login/dev?${busca}`, transacao }
    },

    async concluir(parametros, transacao) {
      if (Date.now() >= transacao.expiraEm) return null
      // os dois sempre comparados: sem atalho que diga qual dos dois divergiu
      const stateOk = mesmoSegredo(parametros?.state, transacao.state)
      const nonceOk = mesmoSegredo(parametros?.nonce, transacao.nonce)
      if (!stateOk || !nonceOk) return null
      const usuario = parametros.usuario
      return ehAtor(usuario) ? sessaoDe(usuario) : null
    },

    async renovar(sessao) {
      const partes = typeof sessao.refreshToken === 'string' ? sessao.refreshToken.split('.') : []
      if (partes.length !== 4 || partes[0] !== PREFIXO_REFRESH) return { status: 'revogada' }
      const [, sub, expira] = partes
      if (!ehAtor(sub) || sub !== sessao.sub || !(Number(expira) > Date.now())) return { status: 'revogada' }
      return { status: 'renovada', sessao: sessaoDe(sub) }
    },

    async encerrar() { return { urlLogout: null } },
  }
}

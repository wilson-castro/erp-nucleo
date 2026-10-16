import 'server-only'
import { createHash } from 'node:crypto'
import type { LeitorDeSessao, StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'
import type { TransacaoDeLogin } from '../portas/identidade.js'
import { ErroDeAplicacao } from '../interno/erros.js'
import { ehTransacao, validarTtlDoLock } from '../interno/login.js'

/**
 * O mínimo que o adaptador usa do cliente Redis. É a assinatura do `node-redis` (v4+):
 * `createClient()` serve direto. Com `ioredis`, passe um invólucro curto
 * (`set: (k, v, { PX, NX, XX }) => r.set(k, v, 'PX', PX, ...(NX ? ['NX'] : XX ? ['XX'] : []))`,
 * `getDel: (k) => r.getdel(k)`). O núcleo não depende de nenhum dos dois.
 */
export interface ClienteRedisDeLeitura {
  get(chave: string): Promise<string | null>
}

/**
 * Só o shell tem um cliente com escrita. A zona recebe `ClienteRedisDeLeitura`: sem `set` nem `del`
 * no tipo, e sem permissão no servidor (usuário ACL só com `GET`; auditor_b1_d1_2, V1).
 */
export interface ClienteRedis extends ClienteRedisDeLeitura {
  /**
   * Com `NX: true`, responde `'OK'` só se gravou e `null` se a chave já existia (`SET NX PX`);
   * com `XX: true`, o contrário: só grava se a chave já existe (`SET XX PX`).
   */
  set(chave: string, valor: string, opcoes: { PX: number; NX?: true; XX?: true }): Promise<unknown>
  del(chave: string): Promise<unknown>
  /** `GETDEL` (Redis 6.2+): lê e apaga numa operação atômica. */
  getDel(chave: string): Promise<string | null>
}

export type ConfigSessaoRedis<C extends ClienteRedisDeLeitura = ClienteRedis> = {
  cliente: C
  /** Padrão `erp:sessao:`. Use outro para dividir uma instância entre ambientes. */
  prefixo?: string
}

/**
 * Transação de login, lock de renovação e índice por sujeito têm prefixo próprio, FORA do de sessão:
 * o usuário ACL das zonas só lê `erp:sessao:*` (base/showcase/docker-compose.yml), e a transação leva o
 * `code_verifier` do PKCE. Quem divide a instância entre ambientes troca todos.
 */
export type ConfigSessaoRedisDeEscrita = ConfigSessaoRedis & {
  /** Padrão `erp:login:`. */
  prefixoLogin?: string
  /** Padrão `erp:renovacao:`. */
  prefixoLock?: string
  /** Padrão `erp:sujeito:`. */
  prefixoSujeito?: string
}

const PREFIXO_PADRAO = 'erp:sessao:'
const PREFIXO_LOGIN_PADRAO = 'erp:login:'
const PREFIXO_LOCK_PADRAO = 'erp:renovacao:'
const PREFIXO_SUJEITO_PADRAO = 'erp:sujeito:'

// o id da sessão nunca vira chave crua: quem lista as chaves não ganha cookies válidos
const chaveDe = (prefixo: string) => (id: string) =>
  `${prefixo}${createHash('sha256').update(id).digest('hex')}`

/**
 * Redis inacessível é falha de infraestrutura, não sessão ausente: tratar como ausente
 * mandaria todo usuário para o login, que também falharia ao gravar. O motivo (endereço,
 * senha na URL) não atravessa a fronteira — invariante 12.
 */
async function semVazar<T>(f: () => Promise<T>): Promise<T> {
  try { return await f() } catch { throw new ErroDeAplicacao('ERRO_INTERNO') }
}

function ehSessao(v: unknown): v is SessaoArmazenada {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const s = v as Record<string, unknown>
  // sessão sem sujeito ou sem token é dado corrompido, não sessão (auditor_b1_d1_2, L7)
  return typeof s.sub === 'string' && s.sub.length > 0 && typeof s.nome === 'string'
    && typeof s.accessToken === 'string' && s.accessToken.length > 0 && typeof s.expiraEm === 'number'
}

type EntradaIndiceSujeito = { k: string; expiraEm: number }

function lerIndiceSujeito(bruto: string | null, agora: number): EntradaIndiceSujeito[] {
  if (!bruto) return []
  try {
    const v: unknown = JSON.parse(bruto)
    if (!Array.isArray(v)) return []
    return v.filter((x): x is EntradaIndiceSujeito =>
      typeof x === 'object' && x !== null
      && typeof (x as EntradaIndiceSujeito).k === 'string'
      && typeof (x as EntradaIndiceSujeito).expiraEm === 'number'
      && (x as EntradaIndiceSujeito).expiraEm > agora,
    )
  } catch { return [] }
}

/**
 * Leitor: o que toda aplicação recebe. Não tem `gravar` nem `remover`. Configuração do
 * servidor: uma instância só de sessão, `noeviction`, AOF (ADR-0002, 02-nucleo §2.6).
 */
export function sessaoRedis(cfg: ConfigSessaoRedis<ClienteRedisDeLeitura>): LeitorDeSessao {
  const chave = chaveDe(cfg.prefixo ?? PREFIXO_PADRAO)
  return {
    async ler(id) {
      if (typeof id !== 'string' || id.length === 0) return null
      const bruto = await semVazar(() => cfg.cliente.get(chave(id)))
      if (bruto === null) return null
      try {
        const v: unknown = JSON.parse(bruto)
        return ehSessao(v) ? v : null
      } catch { return null }
    },
  }
}

/**
 * Escritor: só o shell. Publicado apenas em `@erp/nucleo/shell` (invariante 15). A chave
 * expira junto com a sessão, então o Redis limpa sozinho o que o shell não encerrou; o mesmo
 * vale para a transação de login (TTL da própria validade), para o lock (TTL de quem pede) e
 * para o índice de sessões por sujeito (maior TTL entre as sessões ativas do sujeito).
 */
export function sessaoRedisDeEscrita(cfg: ConfigSessaoRedisDeEscrita): StoreDeSessao {
  const prefixo = cfg.prefixo ?? PREFIXO_PADRAO
  const prefixoLogin = cfg.prefixoLogin ?? PREFIXO_LOGIN_PADRAO
  const prefixoLock = cfg.prefixoLock ?? PREFIXO_LOCK_PADRAO
  const prefixoSujeito = cfg.prefixoSujeito ?? PREFIXO_SUJEITO_PADRAO
  for (const [nome, p] of [['prefixoLogin', prefixoLogin], ['prefixoLock', prefixoLock], ['prefixoSujeito', prefixoSujeito]] as const) {
    if (p.startsWith(prefixo) || prefixo.startsWith(p)) {
      throw new Error(`configuracao invalida: ${nome} "${p}" cai dentro do prefixo de sessao "${prefixo}", que as zonas leem`)
    }
  }
  for (const [a, b] of [[prefixoSujeito, prefixoLogin], [prefixoSujeito, prefixoLock]] as const) {
    if (a.startsWith(b) || b.startsWith(a)) {
      throw new Error(`configuracao invalida: prefixoSujeito "${a}" colide com "${b}"`)
    }
  }
  const chave = chaveDe(prefixo)
  const chaveLogin = chaveDe(prefixoLogin)
  const chaveLock = chaveDe(prefixoLock)
  const chaveSujeito = chaveDe(prefixoSujeito)

  async function indexarSujeito(sub: string, kSessao: string, expiraEm: number): Promise<void> {
    if (typeof sub !== 'string' || sub.length === 0) return
    const kSujeito = chaveSujeito(sub)
    const agora = Date.now()
    const atuais = lerIndiceSujeito(await cfg.cliente.get(kSujeito), agora).filter((x) => x.k !== kSessao)
    if (expiraEm > agora) atuais.push({ k: kSessao, expiraEm })
    if (atuais.length === 0) {
      await cfg.cliente.del(kSujeito)
      return
    }
    const maxExpiraEm = Math.max(...atuais.map((x) => x.expiraEm))
    const px = Math.floor(maxExpiraEm - agora)
    if (px <= 0) {
      await cfg.cliente.del(kSujeito)
      return
    }
    await cfg.cliente.set(kSujeito, JSON.stringify(atuais), { PX: px })
  }

  return {
    ...sessaoRedis(cfg),
    async gravar(id, s) {
      const kSessao = chave(id)
      const restante = Math.floor(s.expiraEm - Date.now())
      if (restante <= 0) {
        await semVazar(async () => {
          await cfg.cliente.del(kSessao)
          await indexarSujeito(s.sub, kSessao, s.expiraEm)
        })
        return
      }
      await semVazar(async () => {
        await cfg.cliente.set(kSessao, JSON.stringify(s), { PX: restante })
        await indexarSujeito(s.sub, kSessao, s.expiraEm)
      })
    },
    async remover(id) { await semVazar(() => cfg.cliente.del(chave(id))) },
    async regravar(id, s) {
      const restante = Math.floor(s.expiraEm - Date.now())
      if (restante <= 0) {
        await semVazar(() => cfg.cliente.del(chave(id)))
        return false
      }
      return (await semVazar(() => cfg.cliente.set(chave(id), JSON.stringify(s), { PX: restante, XX: true }))) === 'OK'
    },

    async gravarTransacao(t) {
      const restante = Math.floor(t.expiraEm - Date.now())
      if (restante <= 0) return
      await semVazar(() => cfg.cliente.set(chaveLogin(t.id), JSON.stringify(t), { PX: restante }))
    },
    async consumirTransacao(id) {
      if (typeof id !== 'string' || id.length === 0) return null
      // GETDEL, não GET + DEL: dois retornos concorrentes com o mesmo cookie não levam a mesma transação
      const bruto = await semVazar(() => cfg.cliente.getDel(chaveLogin(id)))
      if (bruto === null) return null
      try {
        const v: unknown = JSON.parse(bruto)
        return ehTransacao(v) && v.id === id ? (v as TransacaoDeLogin) : null
      } catch { return null }
    },
    async adquirirLockRenovacao(idSessao, ttlMs) {
      validarTtlDoLock(ttlMs)
      const r = await semVazar(() => cfg.cliente.set(chaveLock(idSessao), '1', { PX: ttlMs, NX: true }))
      return r === 'OK'
    },
    async removerPorSujeito(sub) {
      if (typeof sub !== 'string' || sub.length === 0) return 0
      return semVazar(async () => {
        const bruto = await cfg.cliente.getDel(chaveSujeito(sub))
        const entradas = lerIndiceSujeito(bruto, Date.now())
        let removidas = 0
        for (const { k } of entradas) {
          if (Number(await cfg.cliente.del(k)) > 0) removidas++
        }
        return removidas
      })
    },
  }
}

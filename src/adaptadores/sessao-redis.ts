import 'server-only'
import { createHash } from 'node:crypto'
import type { LeitorDeSessao, StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'
import { ErroDeAplicacao } from '../interno/erros.js'

/**
 * O mínimo que o adaptador usa do cliente Redis. É a assinatura do `node-redis` (v4+):
 * `createClient()` serve direto. Com `ioredis`, passe um invólucro de três linhas
 * (`set: (k, v, { PX }) => r.set(k, v, 'PX', PX)`). O núcleo não depende de nenhum dos dois.
 */
export interface ClienteRedis {
  get(chave: string): Promise<string | null>
  set(chave: string, valor: string, opcoes: { PX: number }): Promise<unknown>
  del(chave: string): Promise<unknown>
}

export type ConfigSessaoRedis = {
  cliente: ClienteRedis
  /** Padrão `erp:sessao:`. Use outro para dividir uma instância entre ambientes. */
  prefixo?: string
}

const PREFIXO_PADRAO = 'erp:sessao:'

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

/**
 * Leitor: o que toda aplicação recebe. Não tem `gravar` nem `remover`. Configuração do
 * servidor: uma instância só de sessão, `noeviction`, AOF (ADR-0002, 02-nucleo §2.6).
 */
export function sessaoRedis(cfg: ConfigSessaoRedis): LeitorDeSessao {
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
 * expira junto com a sessão, então o Redis limpa sozinho o que o shell não encerrou.
 */
export function sessaoRedisDeEscrita(cfg: ConfigSessaoRedis): StoreDeSessao {
  const chave = chaveDe(cfg.prefixo ?? PREFIXO_PADRAO)
  return {
    ...sessaoRedis(cfg),
    async gravar(id, s) {
      const restante = Math.floor(s.expiraEm - Date.now())
      if (restante <= 0) {
        await semVazar(() => cfg.cliente.del(chave(id)))
        return
      }
      await semVazar(() => cfg.cliente.set(chave(id), JSON.stringify(s), { PX: restante }))
    },
    async remover(id) { await semVazar(() => cfg.cliente.del(chave(id))) },
  }
}

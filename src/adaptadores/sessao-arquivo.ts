import 'server-only'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'

/**
 * Adaptador de DESENVOLVIMENTO. Existe porque shell e zona são dois processos e
 * um store em memória não atravessa essa fronteira. Substituído por `sessaoRedis`
 * na rodada 2 — ADR-0002. Não use em produção: sem TTL ativo, sem replicação.
 */
export function sessaoArquivo(cfg: { dir: string }): StoreDeSessao {
  mkdirSync(cfg.dir, { recursive: true })
  // o id da sessão nunca vira nome de arquivo cru: evita travessia de caminho
  const arquivo = (id: string) =>
    join(cfg.dir, `${createHash('sha256').update(id).digest('hex')}.json`)

  return {
    async ler(id) {
      const f = arquivo(id)
      if (!existsSync(f)) return null
      try { return JSON.parse(readFileSync(f, 'utf8')) as SessaoArmazenada }
      catch { return null }
    },
    async gravar(id, s) { writeFileSync(arquivo(id), JSON.stringify(s), { mode: 0o600 }) },
    async remover(id) { rmSync(arquivo(id), { force: true }) },
  }
}

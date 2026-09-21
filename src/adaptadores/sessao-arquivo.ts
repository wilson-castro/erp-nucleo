import 'server-only'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LeitorDeSessao, StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'

/**
 * Adaptador de DESENVOLVIMENTO. Existe porque shell e zonas são processos distintos e
 * um store em memória não atravessa essa fronteira. Em produção use `sessaoRedis`
 * (ADR-0002). Sem TTL ativo, sem replicação.
 */
const arquivoDe = (dir: string) => (id: string) =>
  // o id da sessão nunca vira nome de arquivo cru: evita travessia de caminho
  join(dir, `${createHash('sha256').update(id).digest('hex')}.json`)

/** Leitor: o que toda aplicação recebe. Não tem `gravar` nem `remover`. */
export function sessaoArquivo(cfg: { dir: string }): LeitorDeSessao {
  mkdirSync(cfg.dir, { recursive: true })
  const arquivo = arquivoDe(cfg.dir)
  return {
    async ler(id) {
      const f = arquivo(id)
      if (!existsSync(f)) return null
      try { return JSON.parse(readFileSync(f, 'utf8')) as SessaoArmazenada }
      catch { return null }
    },
  }
}

/**
 * Escritor: só o shell. Publicado apenas em `@erp/nucleo/shell`, que a verificação estática das
 * zonas (`repos/verificacao`) proíbe importar (invariante 15). Não existe na raiz do pacote.
 */
export function sessaoArquivoDeEscrita(cfg: { dir: string }): StoreDeSessao {
  const arquivo = arquivoDe(cfg.dir)
  return {
    ...sessaoArquivo(cfg),
    async gravar(id, s) { writeFileSync(arquivo(id), JSON.stringify(s), { mode: 0o600 }) },
    async remover(id) { rmSync(arquivo(id), { force: true }) },
  }
}

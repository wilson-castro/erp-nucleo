import 'server-only'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LeitorDeSessao, StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'

/**
 * Adaptador de DESENVOLVIMENTO. Existe porque shell e zonas são processos distintos e
 * um store em memória não atravessa essa fronteira. Substituído por `sessaoRedis` antes
 * de produção — ADR-0002. Sem TTL ativo, sem replicação.
 *
 * `modo` é obrigatório e sem padrão: a zona declara que só lê, e o objeto que ela recebe
 * não tem `gravar` nem `remover` — nem em tempo de compilação, nem em execução.
 */
export function sessaoArquivo(cfg: { dir: string; modo: 'leitura' }): LeitorDeSessao
export function sessaoArquivo(cfg: { dir: string; modo: 'escrita' }): StoreDeSessao
export function sessaoArquivo(cfg: { dir: string; modo: 'leitura' | 'escrita' }): LeitorDeSessao | StoreDeSessao {
  mkdirSync(cfg.dir, { recursive: true })
  // o id da sessão nunca vira nome de arquivo cru: evita travessia de caminho
  const arquivo = (id: string) =>
    join(cfg.dir, `${createHash('sha256').update(id).digest('hex')}.json`)

  const leitor: LeitorDeSessao = {
    async ler(id) {
      const f = arquivo(id)
      if (!existsSync(f)) return null
      try { return JSON.parse(readFileSync(f, 'utf8')) as SessaoArmazenada }
      catch { return null }
    },
  }
  if (cfg.modo === 'leitura') return leitor
  return {
    ...leitor,
    async gravar(id, s) { writeFileSync(arquivo(id), JSON.stringify(s), { mode: 0o600 }) },
    async remover(id) { rmSync(arquivo(id), { force: true }) },
  }
}

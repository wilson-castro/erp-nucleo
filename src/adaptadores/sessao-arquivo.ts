import 'server-only'
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { LeitorDeSessao, StoreDeSessao, SessaoArmazenada } from '../portas/sessao.js'
import type { TransacaoDeLogin } from '../portas/identidade.js'
import { ehTransacao, validarTtlDoLock } from '../interno/login.js'

/**
 * Adaptador de DESENVOLVIMENTO. Existe porque shell e zonas são processos distintos e
 * um store em memória não atravessa essa fronteira. Em produção use `sessaoRedis`
 * (ADR-0002). Sem TTL ativo, sem replicação.
 */
const arquivoDe = (dir: string, extensao = '.json') => (id: string) =>
  // o id da sessão nunca vira nome de arquivo cru: evita travessia de caminho
  join(dir, `${createHash('sha256').update(id).digest('hex')}${extensao}`)

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

const codigo = (e: unknown) => (e as NodeJS.ErrnoException)?.code

/**
 * Tira o arquivo do lugar com `rename`, que é atômico: de dois chamadores concorrentes, só um
 * consegue. Devolve o caminho novo, ou `null` se outro levou antes (ou se nunca existiu).
 */
function tomar(f: string): string | null {
  const tomado = `${f}.${randomUUID()}.tomado`
  try { renameSync(f, tomado); return tomado }
  catch (e) { if (codigo(e) === 'ENOENT') return null; throw e }
}

/**
 * Escritor: só o shell. Publicado apenas em `@erp/nucleo/shell`, que a verificação estática das
 * zonas (`base/verificacao`) proíbe importar (invariante 15). Não existe na raiz do pacote.
 *
 * Transação de login e lock de renovação ficam em subpastas (`login/`, `renovacao/`), fora do
 * caminho que o leitor das zonas monta. Uso único da transação e exclusão do lock vêm do sistema
 * de arquivos (`rename` e criação exclusiva `wx`), não de memória do processo.
 */
export function sessaoArquivoDeEscrita(cfg: { dir: string }): StoreDeSessao {
  const arquivo = arquivoDe(cfg.dir)
  const dirLogin = join(cfg.dir, 'login')
  const dirLock = join(cfg.dir, 'renovacao')
  mkdirSync(dirLogin, { recursive: true, mode: 0o700 })
  mkdirSync(dirLock, { recursive: true, mode: 0o700 })
  const arquivoLogin = arquivoDe(dirLogin)
  const arquivoLock = arquivoDe(dirLock, '.lock')

  const criarLock = (f: string, ttlMs: number) => {
    try { writeFileSync(f, String(Date.now() + ttlMs), { flag: 'wx', mode: 0o600 }); return true }
    catch (e) { if (codigo(e) === 'EEXIST') return false; throw e }
  }

  return {
    ...sessaoArquivo(cfg),
    async gravar(id, s) { writeFileSync(arquivo(id), JSON.stringify(s), { mode: 0o600 }) },
    async remover(id) { rmSync(arquivo(id), { force: true }) },

    async gravarTransacao(t) {
      writeFileSync(arquivoLogin(t.id), JSON.stringify(t), { mode: 0o600 })
    },
    async consumirTransacao(id) {
      if (typeof id !== 'string' || id.length === 0) return null
      const tomado = tomar(arquivoLogin(id))
      if (!tomado) return null
      try {
        const v: unknown = JSON.parse(readFileSync(tomado, 'utf8'))
        return ehTransacao(v) && v.id === id ? (v as TransacaoDeLogin) : null
      } catch { return null }
      finally { rmSync(tomado, { force: true }) }
    },
    async adquirirLockRenovacao(idSessao, ttlMs) {
      validarTtlDoLock(ttlMs)
      const f = arquivoLock(idSessao)
      if (criarLock(f, ttlMs)) return true
      let expira: number
      try { expira = Number(readFileSync(f, 'utf8')) }
      catch (e) { if (codigo(e) === 'ENOENT') return false; throw e }
      if (Date.now() < expira) return false
      // Vencido: quem conseguir tirá-lo do lugar tenta criar o novo; os outros perdem. Se o que
      // saiu do lugar já era o lock novo de outro processo, ele volta (`link` não sobrescreve).
      // No mesmo processo não há corrida: o corpo inteiro é síncrono, sem `await` no meio.
      const tomado = tomar(f)
      if (!tomado) return false
      try {
        if (Date.now() < Number(readFileSync(tomado, 'utf8'))) {
          try { linkSync(tomado, f) } catch { /* outro já criou um lock no lugar */ }
          return false
        }
      } finally { rmSync(tomado, { force: true }) }
      return criarLock(f, ttlMs)
    },
  }
}

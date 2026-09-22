import 'server-only'
import { DestinoInvalido, ErroDeAplicacao, SessaoInvalida, normalizar } from './erros.js'
import { filhoDe } from '../borda/trace.js'
import type {
  ClienteDeDestino, Destino, Metodo, OpcoesDeChamada, RegistroDeDestinos,
} from '../portas/destinos.js'

export { DestinoInvalido }

import { lerNumeroPositivo } from './configuracao.js'

const METODOS: readonly Metodo[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
/** Métodos que alteram um recurso existente: exigem `If-Match` (invariante 6). */
const EXIGEM_VERSAO: readonly Metodo[] = ['PUT', 'PATCH', 'DELETE']
const SEGMENTO_LITERAL = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/
const PARAMETRO = /^:[A-Za-z][A-Za-z0-9]*$/
const CONTROLE = /[\u0000-\u001f\u007f]/
const TIMEOUT_PADRAO_MS = lerNumeroPositivo(process.env.ERP_DESTINO_TIMEOUT_MS, 5_000, 'ERP_DESTINO_TIMEOUT_MS', 60_000)

type DestinoValidado = Destino & { url: URL }

/**
 * Erro de CONFIGURAÇÃO, não de requisição: é lançado no boot, quando a aplicação monta o
 * núcleo, e nunca chega ao usuário. Por isso é `Error`, e não `ErroDeAplicacao`.
 */
function recusar(nome: string, motivo: string): never {
  throw new Error(`registro de destinos: "${nome}" ${motivo}`)
}

export function validarRegistro(registro: RegistroDeDestinos): Map<string, DestinoValidado> {
  const validados = new Map<string, DestinoValidado>()
  for (const [nome, d] of Object.entries(registro)) {
    let url: URL
    try { url = new URL(d.origem) } catch { recusar(nome, 'tem origem invalida') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') recusar(nome, 'precisa de http ou https')
    if (url.username || url.password) recusar(nome, 'nao pode carregar credencial na URL')
    if (url.pathname !== '/' || url.search || url.hash) recusar(nome, 'deve ser so origem, sem caminho')
    if (!Array.isArray(d.caminhos) || d.caminhos.length === 0) recusar(nome, 'precisa declarar caminhos')
    for (const c of d.caminhos) {
      const segs = c.split('/')
      if (segs[0] !== '' || segs.length < 2) recusar(nome, `tem caminho relativo: ${c}`)
      for (const s of segs.slice(1)) {
        if (!(SEGMENTO_LITERAL.test(s) || PARAMETRO.test(s)) || s === '.' || s === '..') {
          recusar(nome, `tem segmento invalido em ${c}`)
        }
      }
    }
    if (!Array.isArray(d.metodos) || d.metodos.length === 0 || d.metodos.some((m) => !METODOS.includes(m))) {
      recusar(nome, 'tem metodo invalido')
    }
    if (!['usuario', 'servico', 'nenhuma'].includes(d.credencial)) recusar(nome, 'tem credencial invalida')
    validados.set(nome, { ...d, url })
  }
  return validados
}

/**
 * Monta a URL a partir de um modelo DECLARADO. O chamador escolhe o modelo e os valores,
 * nunca o caminho: não há como uma zona montar URL, só preencher lacunas que o registro abriu.
 */
export function montarUrl(d: DestinoValidado, modelo: string, op: OpcoesDeChamada = {}): URL {
  if (!d.caminhos.includes(modelo)) throw new DestinoInvalido()
  const params = op.params ?? {}
  const usados = new Set<string>()
  const caminho = modelo.split('/').map((s) => {
    if (!s.startsWith(':')) return s
    const nome = s.slice(1)
    const v = Object.hasOwn(params, nome) ? params[nome] : undefined
    // `.` e `..` exatos disparam remoção de dot-segment e tirariam a chamada do modelo.
    if (typeof v !== 'string' || v.length === 0 || v.length > 256 || v === '.' || v === '..' || CONTROLE.test(v)) {
      throw new DestinoInvalido()
    }
    usados.add(nome)
    return encodeURIComponent(v)
  }).join('/')
  // Parâmetro que o modelo não pede é erro de programação que esconderia um typo.
  if (Object.keys(params).some((k) => !usados.has(k))) throw new DestinoInvalido()

  const url = new URL(caminho, d.url)
  for (const [k, v] of Object.entries(op.query ?? {})) {
    if (typeof v !== 'string' || CONTROLE.test(k) || CONTROLE.test(v)) throw new DestinoInvalido()
    url.searchParams.append(k, v)
  }
  // Redundante com a validação acima, e de propósito: é a única verificação que não
  // depende de acertar o parser. Ver o teste do byte de controle.
  if (url.origin !== d.url.origin || url.pathname !== caminho) throw new DestinoInvalido()
  return url
}

export type ConfigDoTransporte = {
  app: string
  registro: RegistroDeDestinos
  obterToken: () => Promise<string>
  tokenDeServico?: (() => string | undefined) | undefined
  /** O `traceparent` da requisição atual (posto pelo proxy). Ausente: cada chamada abre um trace. */
  lerTraceparent?: (() => Promise<string | undefined>) | undefined
  fetch?: typeof fetch
}

export function criarTransporte(cfg: ConfigDoTransporte): (nome: string) => ClienteDeDestino {
  const destinos = validarRegistro(cfg.registro)
  const buscar = cfg.fetch ?? fetch

  const chamar = async <T>(nome: string, metodo: Metodo, modelo: string, op: OpcoesDeChamada = {}) => {
    const d = destinos.get(nome)
    if (!d || !d.metodos.includes(metodo)) throw new DestinoInvalido()
    if (EXIGEM_VERSAO.includes(metodo) && !op.ifMatch) throw new DestinoInvalido()
    const url = montarUrl(d, modelo, op)

    const headers = new Headers({ Accept: 'application/json', 'x-erp-chamador': cfg.app })
    headers.set('traceparent', filhoDe(await cfg.lerTraceparent?.().catch(() => undefined)))
    if (d.credencial === 'usuario') headers.set('Authorization', `Bearer ${await cfg.obterToken()}`)
    if (d.credencial === 'servico') {
      const token = cfg.tokenDeServico?.()
      if (!token) throw new SessaoInvalida()
      headers.set('Authorization', `Bearer ${token}`)
    }
    if (op.ifMatch) headers.set('If-Match', op.ifMatch)
    let body: string | undefined
    if (op.corpo !== undefined) {
      headers.set('Content-Type', 'application/json')
      body = JSON.stringify(op.corpo)
    }

    let res: Response
    try {
      res = await buscar(url, {
        method: metodo, headers, ...(body === undefined ? {} : { body }),
        cache: 'no-store',
        // Seguir redirecionamento deixaria o domínio mandar o BFF para fora do registro.
        redirect: 'manual',
        signal: AbortSignal.timeout(d.timeoutMs ?? TIMEOUT_PADRAO_MS),
      })
    } catch {
      // timeout, conexão recusada, DNS: o motivo não atravessa a fronteira
      throw new ErroDeAplicacao('ERRO_INTERNO')
    }
    return normalizar<T>(res)
  }

  return (nome) => ({
    get: (m, op) => chamar(nome, 'GET', m, op),
    post: (m, op) => chamar(nome, 'POST', m, op),
    put: (m, op) => chamar(nome, 'PUT', m, op),
    patch: (m, op) => chamar(nome, 'PATCH', m, op),
    delete: (m, op) => chamar(nome, 'DELETE', m, op),
  })
}

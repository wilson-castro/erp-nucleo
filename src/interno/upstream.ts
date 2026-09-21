import 'server-only'
import {
  DestinoInvalido,
  ErroDeAplicacao,
  normalizar,
  type Resposta,
} from './erros.js'

export { DestinoInvalido }
import type {
  DefinicaoDestino,
  MetodoHttp,
  OpcoesRequisicao,
  RegistroDeDestinos,
  ClienteDestino,
} from '../portas/destinos.js'

/**
 * Validação rigorosa do elemento 7 do núcleo e RFC 10017:
 * - path deve começar com '/'
 * - sem caminhos protocolo-relativos (//) ou barra invertida (/\\)
 * - sem URLs absolutas para outro host
 * - mesma origem da base
 * - rejeição de bytes de controle (\t, \r, \n)
 */
export function resolverDestino(base: URL, path: string): URL {
  if (!path.startsWith('/')) throw new DestinoInvalido()
  if (path.startsWith('//') || path.startsWith('/\\')) throw new DestinoInvalido()
  let url: URL
  try {
    url = new URL(path, base)
  } catch {
    throw new DestinoInvalido()
  }
  if (url.origin !== base.origin) throw new DestinoInvalido()
  return url
}

export function montarCaminho(modelo: string, params: Record<string, string | number> = {}): string {
  if (!modelo.startsWith('/')) throw new DestinoInvalido()
  if (modelo.startsWith('//') || modelo.startsWith('/\\')) throw new DestinoInvalido()

  const partes = modelo.split('/')
  const resultado: string[] = []

  for (const parte of partes) {
    if (parte.startsWith(':')) {
      const nomeParam = parte.slice(1)
      const valor = params[nomeParam]
      if (valor === undefined || valor === null) {
        throw new DestinoInvalido()
      }
      const valorStr = String(valor)
      // Dot-segment exato ou travessia
      if (valorStr === '.' || valorStr === '..') {
        throw new DestinoInvalido()
      }
      resultado.push(encodeURIComponent(valorStr))
    } else {
      if (parte === '.' || parte === '..') {
        throw new DestinoInvalido()
      }
      resultado.push(parte)
    }
  }

  return resultado.join('/')
}

export function criarClienteDestino(
  nome: string,
  definicao: DefinicaoDestino,
  obterTokenUsuario: () => Promise<string>,
  tokenServico?: string,
): ClienteDestino {
  let base: URL
  try {
    base = new URL(definicao.origem)
  } catch {
    throw new DestinoInvalido()
  }

  const timeoutMs = definicao.timeoutMs ?? 10_000

  async function requisitar<T>(
    caminhoModelo: string,
    opcoes: OpcoesRequisicao = {},
    metodo: MetodoHttp = 'GET',
  ): Promise<Resposta<T>> {
    if (!definicao.metodos.includes(metodo)) {
      throw new DestinoInvalido()
    }
    if (!definicao.caminhos.includes(caminhoModelo)) {
      throw new DestinoInvalido()
    }

    const caminhoResolvido = montarCaminho(caminhoModelo, opcoes.params)
    let url = resolverDestino(base, caminhoResolvido)

    if (opcoes.query) {
      const sp = new URLSearchParams(url.search)
      for (const [k, v] of Object.entries(opcoes.query)) {
        if (v !== undefined) {
          sp.set(k, String(v))
        }
      }
      url = new URL(`${url.pathname}?${sp.toString()}`, url.origin)
    }

    const headers = new Headers(opcoes.headers)
    headers.set('Accept', 'application/json')

    const credencial = definicao.credencial ?? 'usuario'
    if (credencial === 'usuario') {
      const tk = await obterTokenUsuario()
      headers.set('Authorization', `Bearer ${tk}`)
    } else if (credencial === 'servico') {
      if (tokenServico) {
        headers.set('Authorization', `Bearer ${tokenServico}`)
      }
    }

    let corpo: string | undefined
    const cargaUtil = opcoes.corpo !== undefined ? opcoes.corpo : opcoes.body
    if (cargaUtil !== undefined) {
      headers.set('Content-Type', 'application/json')
      corpo = JSON.stringify(cargaUtil)
    }

    if (opcoes.ifMatch) {
      headers.set('If-Match', opcoes.ifMatch)
    }

    const init: RequestInit = {
      method: metodo,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      ...(corpo !== undefined ? { body: corpo } : {}),
    }

    let res: Response
    try {
      res = await fetch(url, init)
    } catch {
      throw new ErroDeAplicacao('ERRO_INTERNO')
    }

    return normalizar<T>(res)
  }

  return {
    requisitar,
    get: (caminhoModelo, opcoes) => requisitar(caminhoModelo, opcoes, 'GET'),
    post: (caminhoModelo, opcoes) => requisitar(caminhoModelo, opcoes, 'POST'),
    put: (caminhoModelo, opcoes) => requisitar(caminhoModelo, opcoes, 'PUT'),
    patch: (caminhoModelo, opcoes) => requisitar(caminhoModelo, opcoes, 'PATCH'),
    delete: (caminhoModelo, opcoes) => requisitar(caminhoModelo, opcoes, 'DELETE'),
  }
}

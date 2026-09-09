import 'server-only'
import type { CodigoErro } from '@erp/contratos'

export class ErroDeAplicacao extends Error {
  constructor(readonly codigo: CodigoErro, readonly supportId?: string) {
    super(codigo)
    this.name = new.target.name
  }
}

export class SessaoInvalida extends ErroDeAplicacao {
  constructor(supportId?: string) { super('SESSAO_EXPIRADA', supportId) }
}

export class Desatualizado extends ErroDeAplicacao {
  constructor(supportId?: string) { super('REGISTRO_DESATUALIZADO', supportId) }
}

export class DestinoInvalido extends ErroDeAplicacao {
  constructor() { super('DESTINO_INVALIDO') }
}

/**
 * Recurso ausente OU não autorizado — o domínio devolve `404` nos dois casos, e o
 * front-end não distingue. A zona traduz isto para `notFound()`. Ver 06-seguranca.md §
 * "401, 403 ou 404 — o critério".
 */
export class NaoEncontrado extends ErroDeAplicacao {
  constructor() { super('ERRO_INTERNO') }
}

export type Resposta<T> = { status: number; versao?: string; body?: T }

/** Um lugar só decide o que cada status significa. Nada do corpo do domínio atravessa. */
export async function normalizar<T>(res: Response): Promise<Resposta<T>> {
  if (res.status === 401) throw new SessaoInvalida()
  if (res.status === 404) throw new NaoEncontrado()
  if (res.status === 403) throw new ErroDeAplicacao('OPERACAO_NAO_PERMITIDA')
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { codigo?: CodigoErro; supportId?: string }
    if (res.status === 409) throw new Desatualizado(b.supportId)
    // `codigo` só é aceito se for um código conhecido; qualquer outra coisa vira ERRO_INTERNO
    const conhecidos: CodigoErro[] = ['REGISTRO_DESATUALIZADO', 'OPERACAO_NAO_PERMITIDA',
                                      'SESSAO_EXPIRADA', 'DESTINO_INVALIDO', 'ERRO_INTERNO']
    const codigo = b.codigo && conhecidos.includes(b.codigo) ? b.codigo : 'ERRO_INTERNO'
    throw new ErroDeAplicacao(codigo, b.supportId)
  }
  const etag = res.headers.get('etag')
  const body = (await res.json().catch(() => undefined)) as T | undefined

  // Construído por atribuição, não por literal. Sob `exactOptionalPropertyTypes`,
  // `body?: T` recusa um `T | undefined`: a flag distingue "chave ausente" de "chave
  // presente valendo undefined". É a mesma distinção que sustenta a ausência total do
  // bloco sensível em `@erp/contratos`, então desligá-la aqui para simplificar custaria
  // a garantia lá.
  const resposta: Resposta<T> = { status: res.status }
  if (etag !== null) resposta.versao = etag
  if (body !== undefined) resposta.body = body
  return resposta
}

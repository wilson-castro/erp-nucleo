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

/**
 * `supportId` é o SEGUNDO campo que atravessa a fronteira de erro, e o único sem lista
 * fechada. Sem esta validação ele é um canal aberto: o domínio põe ali o stacktrace que
 * o `codigo` impediu de passar, e o teste que prova que `message` não vaza continua verde.
 *
 * Um identificador de suporte é opaco e curto. Qualquer coisa que não seja isso é
 * descartada, não truncada — truncar entregaria os primeiros 64 caracteres do stacktrace.
 */
function sanitizarSupportId(v: unknown): string | undefined {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined
}

/** Um lugar só decide o que cada status significa. Nada do corpo do domínio atravessa. */
export async function normalizar<T>(res: Response): Promise<Resposta<T>> {
  // `redirect: 'manual'` devolve o 3xx cru (ou `opaqueredirect`, status 0). Nenhum dos
  // dois é resposta do recurso solicitado.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new ErroDeAplicacao('ERRO_INTERNO')
  }
  if (res.status === 401) throw new SessaoInvalida()
  if (res.status === 404) throw new NaoEncontrado()
  if (res.status === 403) throw new ErroDeAplicacao('OPERACAO_NAO_PERMITIDA')
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { codigo?: unknown; supportId?: unknown }
    const supportId = sanitizarSupportId(b.supportId)
    if (res.status === 409) throw new Desatualizado(supportId)
    // `DESTINO_INVALIDO` está FORA desta lista de propósito: é código interno do BFF,
    // e o domínio não pode alegar um erro de uma camada que não é a dele.
    const conhecidos: CodigoErro[] = ['REGISTRO_DESATUALIZADO', 'OPERACAO_NAO_PERMITIDA',
                                      'SESSAO_EXPIRADA', 'ERRO_INTERNO']
    const codigo = conhecidos.includes(b.codigo as CodigoErro) ? (b.codigo as CodigoErro) : 'ERRO_INTERNO'
    throw new ErroDeAplicacao(codigo, supportId)
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

export type Metodo = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Um destino de saída declarado pela aplicação: o "CORS de saída" (N8, ADR-0009).
 * Nada fora do que está aqui sai do BFF, e nada daqui vem do cliente.
 */
export type Destino = {
  /** Só esquema, host e porta. Ex.: `http://127.0.0.1:4001`. */
  origem: string
  /** Modelos de caminho aceitos. Segmento literal ou `:parametro`. Ex.: `/v1/recursos/:id`. */
  caminhos: readonly string[]
  metodos: readonly Metodo[]
  /** `usuario`: token da sessão. `servico`: token de serviço da app. `nenhuma`: sem Authorization. */
  credencial: 'usuario' | 'servico' | 'nenhuma'
  timeoutMs?: number
}

export type RegistroDeDestinos = Readonly<Record<string, Destino>>

export type OpcoesDeChamada = {
  params?: Readonly<Record<string, string>>
  query?: Readonly<Record<string, string>>
  corpo?: unknown
  ifMatch?: string
}

export type ClienteDeDestino = {
  get<T>(modelo: string, op?: OpcoesDeChamada): Promise<Resposta<T>>
  post<T>(modelo: string, op?: OpcoesDeChamada): Promise<Resposta<T>>
  put<T>(modelo: string, op?: OpcoesDeChamada): Promise<Resposta<T>>
  patch<T>(modelo: string, op?: OpcoesDeChamada): Promise<Resposta<T>>
  delete<T>(modelo: string, op?: OpcoesDeChamada): Promise<Resposta<T>>
}

/** Mesma forma que `interno/erros.ts` produz; declarada aqui porque portas não importam interno. */
export type Resposta<T> = { status: number; versao?: string; body?: T }

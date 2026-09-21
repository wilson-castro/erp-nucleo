import 'server-only'

export type MetodoHttp = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type TipoCredencial = 'usuario' | 'servico' | 'nenhuma'

export type DefinicaoDestino = {
  origem: string
  caminhos: readonly string[]
  metodos: readonly MetodoHttp[]
  credencial?: TipoCredencial
  timeoutMs?: number
}

export type RegistroDeDestinos = Readonly<Record<string, DefinicaoDestino>>

export type OpcoesRequisicao = {
  params?: Record<string, string | number>
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  ifMatch?: string
  headers?: Record<string, string>
}

export type RespostaDestino<T> = {
  status: number
  versao?: string
  body?: T
}

export interface ClienteDestino {
  requisitar<T>(caminhoModelo: string, opcoes?: OpcoesRequisicao, metodo?: MetodoHttp): Promise<RespostaDestino<T>>
  get<T>(caminhoModelo: string, opcoes?: Omit<OpcoesRequisicao, 'body'>): Promise<RespostaDestino<T>>
  post<T>(caminhoModelo: string, opcoes?: OpcoesRequisicao): Promise<RespostaDestino<T>>
  put<T>(caminhoModelo: string, opcoes?: OpcoesRequisicao): Promise<RespostaDestino<T>>
  patch<T>(caminhoModelo: string, opcoes?: OpcoesRequisicao): Promise<RespostaDestino<T>>
  delete<T>(caminhoModelo: string, opcoes?: Omit<OpcoesRequisicao, 'body'>): Promise<RespostaDestino<T>>
}

export interface PortaDeDestinos {
  destino(nome: string): ClienteDestino
}

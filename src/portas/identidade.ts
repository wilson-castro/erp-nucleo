import 'server-only'
import type { SessaoArmazenada } from './sessao.js'

export interface ProvedorDeIdentidade {
  autenticar(credencial: unknown): Promise<SessaoArmazenada | null>
}

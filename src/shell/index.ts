import 'server-only'
import { criarNucleo, type ConfigDoNucleo, type Nucleo } from '../fabricas/criarNucleo.js'
import { sessaoArquivo } from '../adaptadores/sessao-arquivo.js'
import { identidadeDev as criarIdentidadeDev } from '../adaptadores/identidade-dev.js'
import type { StoreDeSessao } from '../portas/sessao.js'
import type { ProvedorDeIdentidade } from '../portas/identidade.js'

export const ATORES_DE_DESENVOLVIMENTO = ['ana', 'bruno', 'carla', 'davi'] as const

export const sessaoArquivoDeEscrita = sessaoArquivo

export const identidadeDev = criarIdentidadeDev

export type ConfigDoNucleoDoShell = Omit<ConfigDoNucleo, 'identidade'> & {
  app?: string
  escrita: {
    store: StoreDeSessao
    identidade: ProvedorDeIdentidade
  }
}

export function criarNucleoDoShell(cfg: ConfigDoNucleoDoShell): Nucleo {
  return criarNucleo({
    ...cfg,
    identidade: cfg.escrita.identidade,
    sessao: cfg.escrita.store,
  })
}

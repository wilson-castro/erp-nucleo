// Superfície SÓ do shell: o que escreve sessão ou autentica. Uma zona que importe este
// subpath viola o invariante 15, e o lint das zonas recusa o import.
export {
  criarNucleoDoShell, type ConfigDoNucleoDoShell, type NucleoDoShell,
} from '../fabricas/criarNucleo.js'
export { sessaoArquivoDeEscrita } from '../adaptadores/sessao-arquivo.js'
export { identidadeDev, ATORES_DE_DESENVOLVIMENTO } from '../adaptadores/identidade-dev.js'
export type { EscritorDeSessao, StoreDeSessao } from '../portas/sessao.js'
export type { ProvedorDeIdentidade } from '../portas/identidade.js'

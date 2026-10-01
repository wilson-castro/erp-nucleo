// Superfície SÓ do shell: o que escreve sessão ou autentica. Uma zona que importe este
// subpath viola o invariante 15; a verificação estática de `base/verificacao` reprova o import.
export {
  criarNucleoDoShell, type ConfigDoNucleoDoShell, type NucleoDoShell, type EstadoDaRenovacao,
} from '../fabricas/criarNucleo.js'
export { sessaoArquivoDeEscrita } from '../adaptadores/sessao-arquivo.js'
export { sessaoRedisDeEscrita, type ConfigSessaoRedisDeEscrita } from '../adaptadores/sessao-redis.js'
export { identidadeDev, ATORES_DE_DESENVOLVIMENTO } from '../adaptadores/identidade-dev.js'
export type { EscritorDeSessao, StoreDeSessao } from '../portas/sessao.js'
export type { ProvedorDeIdentidade, TransacaoDeLogin, ResultadoRenovacao } from '../portas/identidade.js'

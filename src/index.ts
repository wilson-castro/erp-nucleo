// Entrada raiz do pacote. `criarProxy` NÃO está aqui: ele importa `next/server`,
// que não resolve sob Node ESM puro (next.js não publica `exports`). Ficar fora
// desta entrada é o que mantém `dist/index.js` carregável fora de um bundler —
// inclusive no próprio teste de exports do pacote. Ver ADR da Tarefa 5, achado 2.
// `criarProxy` vive no seu próprio subcaminho, `@erp/nucleo/proxy`.
export type { SessaoArmazenada, Sessao, StoreDeSessao } from './portas/sessao.js'
export type { ProvedorDeIdentidade } from './portas/identidade.js'
export { sessaoArquivo } from './adaptadores/sessao-arquivo.js'
export { identidadeDev } from './adaptadores/identidade-dev.js'
export { pode } from './permissoes/index.js'
export { criarNucleo } from './fabricas/criarNucleo.js'
export type { Nucleo, ConfigDoNucleo } from './fabricas/criarNucleo.js'

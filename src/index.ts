// Superfície pública do núcleo. O que não está aqui não existe para os consumidores.
//
// `criarProxy` NÃO entra aqui: ele importa o runtime do Next (server), e o Next 16 não publica campo
// `exports`, então esse import não resolve sob ESM fora de um bundler. Na raiz, ele
// tornaria o pacote impossível de carregar em Node puro — incluindo nos testes deste
// próprio pacote. Vive em `@erp/nucleo/proxy`.
export { criarNucleo, type ConfigDoNucleo, type Nucleo } from './fabricas/criarNucleo.js'

export { dadosHttp } from './adaptadores/dados-http.js'
export { sessaoArquivo } from './adaptadores/sessao-arquivo.js'
export { identidadeDev } from './adaptadores/identidade-dev.js'

export type { PortaDeDados, FabricaDeDados, ObterToken } from './portas/dados.js'
export type { StoreDeSessao, SessaoArmazenada, Sessao } from './portas/sessao.js'
export type { ProvedorDeIdentidade } from './portas/identidade.js'

export {
  ErroDeAplicacao, SessaoInvalida, Desatualizado, DestinoInvalido, NaoEncontrado,
} from './interno/erros.js'

// `upstream` e `resolverDestino` NÃO são exportados: uma zona que os alcançasse
// contornaria a allowlist do elemento 7.

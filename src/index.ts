// Superfície pública do núcleo. O que não está aqui não existe para os consumidores.
//
// `criarProxy` NÃO entra aqui: ele importa o runtime do Next (server), e o Next 16 não publica campo
// `exports`, então esse import não resolve sob ESM fora de um bundler. Vive em `@erp/nucleo/proxy`.
export {
  criarNucleo, type ConfigDoNucleo, type ConfigDoNucleoDoShell, type Nucleo, type NucleoDoShell,
} from './fabricas/criarNucleo.js'

export { sessaoArquivo } from './adaptadores/sessao-arquivo.js'
export { identidadeDev, ATORES_DE_DESENVOLVIMENTO } from './adaptadores/identidade-dev.js'
export { acessoHttp } from './adaptadores/acesso-http.js'

export type {
  StoreDeSessao, LeitorDeSessao, EscritorDeSessao, SessaoArmazenada, Sessao,
} from './portas/sessao.js'
export type { ProvedorDeIdentidade } from './portas/identidade.js'
export type {
  Destino, RegistroDeDestinos, Metodo, OpcoesDeChamada, ClienteDeDestino, Resposta,
} from './portas/destinos.js'
export type { PortaDeAcesso, FabricaDeAcesso } from './portas/acesso.js'

export {
  ErroDeAplicacao, SessaoInvalida, Desatualizado, DestinoInvalido, NaoEncontrado,
} from './interno/erros.js'

// `criarTransporte`, `montarUrl` e `validarRegistro` NÃO são exportados: uma aplicação
// que os alcançasse montaria cliente fora do registro que o núcleo validou.

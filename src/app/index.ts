import 'server-only'
// Kit de página e de Server Action de toda app (ADR-0012). A app injeta o Next e o React:
//   criarPaginas(nucleo, { hostsPermitidos, next: { cabecalho, naoEncontrado, redirecionar, porRequisicao } })
export {
  criarPaginas,
  type AdaptadorNext, type ConfigDePaginas, type NucleoDasPaginas, type MotivoDeNegacao,
} from '../fabricas/criarPaginas.js'

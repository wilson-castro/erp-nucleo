import 'server-only'
import { ehFuncionalidade, type AcessoEfetivo, type ModuloEfetivo } from '@erp/contratos'
import { ErroDeAplicacao } from './erros.js'

/** Id de módulo = id da zona = nome do serviço (`svc.<zona>`): sem ponto (ADR-0014, adendo 1). */
export const ID_MODULO = /^[a-z][a-z0-9-]{0,31}$/

const invalido = (): never => { throw new ErroDeAplicacao('ERRO_INTERNO') }
const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reduz o corpo de `GET /v2/eu` ao que o BFF pode guardar: módulos efetivos e um booleano de
 * administração. CPF, e-mail e a lista de papéis ficam para trás (invariante 1).
 *
 * Corpo fora do esquema é erro, nunca lista vazia nem lista parcial: uma resposta que o BFF não
 * entende não pode virar "sem acesso" (404) nem "algum acesso" (auditor_b1_d1_2, V4).
 */
export function reduzirEu(corpo: unknown): AcessoEfetivo {
  if (!ehObjeto(corpo) || !Array.isArray(corpo.modulos) || !Array.isArray(corpo.papeis)) return invalido()
  const vistos = new Set<string>()
  const modulos: ModuloEfetivo[] = corpo.modulos.map((m: unknown) => {
    if (!ehObjeto(m) || typeof m.id !== 'string' || !ID_MODULO.test(m.id) || vistos.has(m.id)) return invalido()
    if (typeof m.nome !== 'string' || m.nome.length === 0) return invalido()
    if (!Array.isArray(m.funcionalidades) || !m.funcionalidades.every(ehFuncionalidade)) return invalido()
    vistos.add(m.id)
    return { id: m.id, nome: m.nome, funcionalidades: [...m.funcionalidades] }
  })
  if (!corpo.papeis.every((p: unknown) => ehObjeto(p) && typeof p.papel === 'string' && p.papel.length > 0)) return invalido()
  return { modulos, administra: corpo.papeis.length > 0 }
}

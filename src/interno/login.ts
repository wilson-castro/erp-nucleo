import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { TransacaoDeLogin } from '../portas/identidade.js'
import { lerNumeroPositivo } from './configuracao.js'

/** Validade da transação de login em ms (`ERP_LOGIN_TRANSACAO_S`, docs/CONFIGURACAO.md §1). */
export const lerVidaDaTransacaoMs = (): number =>
  lerNumeroPositivo(process.env.ERP_LOGIN_TRANSACAO_S, 600, 'ERP_LOGIN_TRANSACAO_S', 3_600) * 1_000

/** 32 bytes aleatórios em base64url: 43 caracteres, o tamanho mínimo do `code_verifier` (RFC 7636). */
const aleatorio = () => randomBytes(32).toString('base64url')

/**
 * Só caminho interno: `/x`, nunca `//x`, `/\x`, URL absoluta ou caractere de controle. O destino
 * volta ao navegador num redirecionamento depois do login; aberto, levaria a uma página falsa.
 */
export function destinoInterno(destino: unknown): string {
  if (typeof destino !== 'string' || !destino.startsWith('/') || destino.startsWith('//') || destino.startsWith('/\\')) return '/'
  if (/[\u0000-\u001f\u007f]/.test(destino)) return '/'
  return destino
}

/** Transação nova, com `id`, `state`, `codeVerifier` e `nonce` independentes e aleatórios. */
export function novaTransacao(destino: unknown, vidaMs: number): TransacaoDeLogin {
  return {
    id: aleatorio(), state: aleatorio(), codeVerifier: aleatorio(), nonce: aleatorio(),
    destino: destinoInterno(destino), expiraEm: Date.now() + vidaMs,
  }
}

/**
 * Comparação em tempo constante de um valor recebido com o esperado. Compara os hashes, então
 * tamanhos diferentes não abreviam a comparação nem lançam. Ausente ou não texto é diferente.
 */
export function mesmoSegredo(recebido: unknown, esperado: string): boolean {
  if (typeof recebido !== 'string' || recebido.length === 0 || esperado.length === 0) return false
  const h = (v: string) => createHash('sha256').update(v).digest()
  return timingSafeEqual(h(recebido), h(esperado))
}

/** Forma de uma transação lida do store; qualquer outra coisa é dado corrompido. */
export function ehTransacao(v: unknown): v is TransacaoDeLogin {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const t = v as Record<string, unknown>
  return (['id', 'state', 'codeVerifier', 'nonce', 'destino'] as const).every((c) => typeof t[c] === 'string' && (t[c] as string).length > 0)
    && typeof t.expiraEm === 'number' && Number.isFinite(t.expiraEm)
}

/** TTL do lock de renovação: inteiro positivo em ms. Outro valor é erro de programação, não lock eterno. */
export function validarTtlDoLock(ttlMs: unknown): asserts ttlMs is number {
  if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError(`ttl do lock de renovacao invalido: ${String(ttlMs)}`)
  }
}

/**
 * Núcleo 8 — trace contínuo sem dado pessoal (02-nucleo §2). Cabeçalho W3C `traceparent`:
 * `00-<trace 32 hex>-<span 16 hex>-<flags 2 hex>`. Só identificadores aleatórios: nada de
 * usuário, sessão ou caminho. O proxy garante um por requisição; cada chamada ao domínio leva
 * um filho, e a renderização inteira fica num trace só, do navegador ao domínio.
 */
export const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

// Web Crypto: funciona no runtime do proxy e no Node, sem `node:crypto`
const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
const zerado = (s: string) => /^0+$/.test(s)

/** O `traceparent` recebido, se válido; senão um novo. Texto forjado pelo cliente não passa. */
export function garantirTraceparent(recebido: string | null | undefined): string {
  const m = typeof recebido === 'string' ? TRACEPARENT.exec(recebido) : null
  if (m && !zerado(m[1]!) && !zerado(m[2]!)) return recebido as string
  return `00-${hex(16)}-${hex(8)}-01`
}

/** Mesmo trace e mesma amostragem, span novo: o `traceparent` de uma chamada de saída. */
export function filhoDe(pai: string | null | undefined): string {
  const [, trace, , flags] = TRACEPARENT.exec(garantirTraceparent(pai))!
  return `00-${trace}-${hex(8)}-${flags}`
}

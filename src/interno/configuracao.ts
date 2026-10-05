import 'server-only'

/** Regra de `http://` em produção (ADR-0013, adendo 2); mora em `borda/` porque a CSP também a usa. */
export { httpPermitido } from '../borda/http-local.js'

/**
 * Parâmetro numérico lido do ambiente (docs/CONFIGURACAO.md). Ausente: o padrão. Presente e
 * inválido (não inteiro, zero, negativo, acima do teto): erro na subida, nunca um valor que
 * ninguém escolheu. O teto impede que um erro de digitação vire, por exemplo, timeout de 10 min
 * segurando requisição (auditor_b1_d1_2, L2).
 */
export function lerNumeroPositivo(valor: string | undefined, padrao: number, nome: string, maximo = Number.MAX_SAFE_INTEGER): number {
  if (valor === undefined || valor === '') return padrao
  const n = Number(valor)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`configuracao invalida: ${nome} deve ser inteiro positivo, recebeu "${valor}"`)
  }
  if (n > maximo) throw new Error(`configuracao invalida: ${nome} deve ser no maximo ${maximo}, recebeu "${valor}"`)
  return n
}

/**
 * Como `lerNumeroPositivo`, com piso explícito: serve quando `0` tem significado (ex.: "desligado").
 * Só aceita dígitos: sinal, fração, expoente e espaço são recusados, nunca arredondados para um valor
 * que ninguém escolheu (`' '` viraria `0` com `Number`).
 */
export function lerInteiroEntre(valor: string | undefined, padrao: number, nome: string, minimo: number, maximo: number): number {
  if (valor === undefined || valor === '') return padrao
  const n = /^\d+$/.test(valor) ? Number(valor) : NaN
  if (Number.isNaN(n) || n < minimo) {
    throw new Error(`configuracao invalida: ${nome} deve ser inteiro de no minimo ${minimo}, recebeu "${valor}"`)
  }
  // só dígitos e acima do inteiro seguro também é acima do teto
  if (!Number.isSafeInteger(n) || n > maximo) throw new Error(`configuracao invalida: ${nome} deve ser no maximo ${maximo}, recebeu "${valor}"`)
  return n
}

/** Timeout de uma chamada de saída do núcleo, em ms (`ERP_DESTINO_TIMEOUT_MS`, docs/CONFIGURACAO.md §2): domínio e IdP. */
export const lerTimeoutDeDestinoMs = (): number =>
  lerNumeroPositivo(process.env.ERP_DESTINO_TIMEOUT_MS, 5_000, 'ERP_DESTINO_TIMEOUT_MS', 60_000)

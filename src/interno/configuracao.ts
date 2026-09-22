import 'server-only'

export function lerNumeroPositivo(valor: string | undefined, padrao: number, nome: string): number {
  if (valor === undefined || valor === '') return padrao
  const n = Number(valor)
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`configuracao invalida: ${nome} deve ser inteiro positivo, recebeu "${valor}"`)
  }
  return n
}

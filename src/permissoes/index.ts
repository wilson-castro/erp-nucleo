// SEM 'server-only': as ilhas 'use client' precisam deste módulo para decidir
// se renderizam um botão. É a única exceção do núcleo, e é deliberada.

/**
 * Fail closed. `=== true` e não truthiness: um `1`, uma string `"true"` ou uma
 * chave ausente precisam negar. Ver 06-seguranca.md §9.2.
 */
export function pode(
  permissoes: Record<string, boolean | undefined> | null | undefined,
  acao: string,
): boolean {
  return permissoes?.[acao] === true
}

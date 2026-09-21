// SEM 'server-only': as ilhas 'use client' precisam deste módulo para decidir
// se renderizam um botão. É a única exceção do núcleo, e é deliberada.

/**
 * Fail closed. `=== true` e não truthiness: um `1`, uma string `"true"` ou uma
 * chave ausente precisam negar. `Object.hasOwn` para que `__proto__` ou `toString`
 * nunca respondam por uma ação. Ver 06-seguranca.md §9.2.
 */
export function pode(
  permissoes: Readonly<Record<string, boolean>> | null | undefined,
  acao: string,
): boolean {
  return permissoes != null && Object.hasOwn(permissoes, acao) && permissoes[acao] === true
}

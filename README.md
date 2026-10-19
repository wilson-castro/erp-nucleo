# @erp/nucleo

O **núcleo** compartilhado por shell e zonas: sessão, chamadas a domínio, acesso a módulo, proxy e fragmentos. Não conhece nenhum domínio de negócio.

## Responsabilidades

O que esta parte faz, o que nunca faz e o vocabulário usado aqui (BFF, zona, Server Action…), explicados
do zero: [`docs/RESPONSABILIDADES.md`](https://github.com/ArtroxGabriel/nextjs-mfe/blob/bff-multizone/docs/RESPONSABILIDADES.md)
no repositório principal, seção 7.

## O que tem

| Import | Para quem | O que |
|---|---|---|
| `@erp/nucleo` | todas as apps | `criarNucleo`, registro de destinos, leitores de sessão (`sessaoArquivo`, `sessaoRedis`), `acessoHttp`, fragmentos (`criarFragmento`, `responderFragmento`), erros |
| `@erp/nucleo/proxy` | todas as apps | `criarProxy` (cookie de sessão + CSP) |
| `@erp/nucleo/shell` | **só o shell** | `criarNucleoDoShell`, escritores de sessão, `identidadeDev` |
| `@erp/nucleo/permissoes` | todas | `pode` |
| `@erp/nucleo/testing` | testes | fakes |

Camadas em `src/` (`portas`, `adaptadores`, `interno`, `fabricas`, `shell`): quem importa quem é
verificado por `pnpm fronteira`.

## Versão 0.10.6

Integra a validação do acesso efetivo antes de gravar a sessão de login e a revogação ativa
por sujeito (`removerPorSujeito` / `removerSessoesDoSujeito`, G5). Substitui os dois conteúdos
divergentes publicados como 0.10.5; nenhum deles deve ser republicado (ADR-0010).

## Comandos

```bash
pnpm install
pnpm test         # build + fronteira entre camadas + testes (node --test)
pnpm publicar     # build + publica no Verdaccio local (:4873)
```

**Nunca republique o mesmo número de versão**, nem em outra máquina: mudou, sobe a versão
(ADR-0010 no repositório principal). Ordem de publicação: `erp-contratos` → `erp-nucleo` →
`erp-moldura` → aplicações.

Depende de: `@erp/contratos`; peer `next` e `server-only`.

A base inteira (subir, verificar ponta a ponta) é operada pelo repositório principal `nextjs-mfe`: veja o README de lá.

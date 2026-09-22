import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lerNumeroPositivo } from '../dist/interno/configuracao.js'

test('ausente ou vazio: o padrao', () => {
  assert.equal(lerNumeroPositivo(undefined, 5000, 'X'), 5000)
  assert.equal(lerNumeroPositivo('', 5000, 'X'), 5000)
})

test('inteiro positivo dentro do teto: o valor', () => {
  assert.equal(lerNumeroPositivo('1500', 5000, 'X', 60_000), 1500)
  assert.equal(lerNumeroPositivo('60000', 5000, 'X', 60_000), 60_000)
})

test('invalido ou acima do teto: erro na subida com o nome da variavel, nunca um valor que ninguem escolheu', () => {
  for (const v of ['0', '-1', '1.5', 'abc', 'Infinity', '60001']) {
    assert.throws(() => lerNumeroPositivo(v, 5000, 'ERP_X_MS', 60_000), /ERP_X_MS/, v)
  }
})

test('os timeouts do nucleo tem padrao e teto (docs/CONFIGURACAO.md)', async () => {
  const { readFileSync } = await import('node:fs')
  const fonte = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  assert.match(fonte('interno/destinos.ts'), /ERP_DESTINO_TIMEOUT_MS, 5_000, 'ERP_DESTINO_TIMEOUT_MS', 60_000\)/)
  assert.match(fonte('fabricas/fragmento.ts'), /ERP_FRAGMENTO_TIMEOUT_MS, 2_000, 'ERP_FRAGMENTO_TIMEOUT_MS', 30_000\)/)
  assert.match(fonte('adaptadores/identidade-dev.ts'), /ERP_TOKEN_VIDA_S, 300, 'ERP_TOKEN_VIDA_S', 3_600\)/)
})

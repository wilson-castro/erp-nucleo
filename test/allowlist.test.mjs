import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolverDestino, DestinoInvalido } from '../dist/interno/upstream.js'

const BASE = new URL('http://localhost:4000')

test('aceita caminho absoluto de mesma origem', () => {
  assert.equal(resolverDestino(BASE, '/pedidos/8821').href, 'http://localhost:4000/pedidos/8821')
})

test('recusa URL absoluta para outro host', () => {
  assert.throws(() => resolverDestino(BASE, 'http://evil.com/x'), DestinoInvalido)
})

test('recusa caminho protocolo-relativo', () => {
  // "//evil.com" resolve para http://evil.com — o vetor de SSRF mais comum
  assert.throws(() => resolverDestino(BASE, '//evil.com/x'), DestinoInvalido)
})

test('recusa barra invertida, que alguns parsers tratam como //', () => {
  assert.throws(() => resolverDestino(BASE, '/\\evil.com/x'), DestinoInvalido)
})

test('recusa caminho relativo', () => {
  assert.throws(() => resolverDestino(BASE, '../evil'), DestinoInvalido)
  assert.throws(() => resolverDestino(BASE, 'pedidos/8821'), DestinoInvalido)
})

test('byte de controle vence os guards de prefixo — so a origem salva', () => {
  // O parser WHATWG remove TAB, CR e LF do input INTEIRO antes de parsear. '/\t/evil.com'
  // passa pelos dois guards de prefixo (o segundo caractere nao e / nem \) e so entao
  // vira '//evil.com'. O unico check que reprova e `url.origin !== base.origin`.
  //
  // Este teste existe para que "simplificar" os guards no futuro nao reintroduza o SSRF
  // com a suite verde.
  for (const ctrl of ['\t', '\r', '\n']) {
    assert.throws(() => resolverDestino(BASE, `/${ctrl}/evil.com/x`), DestinoInvalido,
      `byte de controle ${JSON.stringify(ctrl)} atravessou`)
  }
})

test('travessia para cima nao escapa da origem', () => {
  // normaliza para /evil na MESMA origem, o que e aceitavel: continua no dominio
  assert.equal(resolverDestino(BASE, '/pedidos/../evil').origin, BASE.origin)
})

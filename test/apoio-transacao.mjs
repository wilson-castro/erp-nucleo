// Apoio dos testes da transação de login (ADR-0013, decisão 3): de onde vêm `id`, `state`,
// `codeVerifier` e `nonce`, e se um segredo é calculável a partir do que vai na URL.
import assert from 'node:assert/strict'
import crypto, { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'

const CAMPOS = ['id', 'state', 'codeVerifier', 'nonce']

/**
 * Roda `fn` com `crypto.randomBytes` substituído por um registrador que devolve bytes aleatórios
 * de verdade e anota cada sorteio (tamanho e bytes). `syncBuiltinESMExports` propaga a troca para
 * quem importou `{ randomBytes } from 'node:crypto'`, como `dist/interno/login.js`. Devolve o
 * resultado de `fn` e a lista de sorteios.
 */
export async function comSorteiosRegistrados(fn) {
  const original = crypto.randomBytes
  const sorteios = []
  crypto.randomBytes = function randomBytesRegistrado(tamanho, ...resto) {
    if (resto.length > 0) return original.call(crypto, tamanho, ...resto)
    const bytes = original.call(crypto, tamanho)
    sorteios.push({ tamanho, bytes: Buffer.from(bytes) })
    return bytes
  }
  syncBuiltinESMExports()
  try {
    return { resultado: await fn(), sorteios }
  } finally {
    crypto.randomBytes = original
    syncBuiltinESMExports()
  }
}

/**
 * Cada um de `id`, `state`, `codeVerifier` e `nonce` é exatamente a codificação base64url de um
 * sorteio de pelo menos 32 bytes, e os quatro vêm de sorteios distintos. Fecha a classe inteira das
 * derivações (`id = sha256(state)`, `id = state + sufixo`, `codeVerifier = f(state)`...): um campo
 * calculado a partir de outro não é a codificação de um sorteio próprio.
 */
export function conferirQuatroSorteios(transacao, sorteios) {
  const usados = new Map()
  for (const campo of CAMPOS) {
    const valor = transacao[campo]
    const i = sorteios.findIndex((s) => s.bytes.toString('base64url') === valor)
    assert.ok(i >= 0, `${campo} nao e a codificacao base64url de um sorteio de crypto.randomBytes: ${valor}`)
    assert.ok(sorteios[i].tamanho >= 32, `${campo} veio de um sorteio de ${sorteios[i].tamanho} bytes (minimo 32)`)
    assert.ok(!usados.has(i), `${campo} e ${usados.get(i)} vem do mesmo sorteio`)
    usados.set(i, campo)
  }
}

const HASHES = ['sha256', 'sha512']
const CODIFICACOES = ['base64url', 'base64', 'hex']

/**
 * Os segredos (`id`, valor do cookie `__Host-erp-login`, e `codeVerifier`, o verificador PKCE) não
 * são calculáveis a partir do que é público: `state`, `nonce` e todo parâmetro da URL de autorização.
 * Nenhum contém o outro, e o segredo não é sha256 nem sha512 do valor público em base64url, base64
 * ou hex. Valor público curto (menos de 16 caracteres, como `code` ou `S256`) não carrega segredo
 * de 43 caracteres; só se confere que ele não contém o segredo, para o teste não falhar por acaso
 * quando o sorteio contém essa sequência.
 */
export function conferirSegredosForaDoPublico(transacao, url) {
  const publicos = [['state', transacao.state], ['nonce', transacao.nonce]]
  for (const [nome, v] of new URL(url, 'http://shell.invalid').searchParams) publicos.push([`url:${nome}`, v])
  assert.ok(publicos.some(([n]) => n === 'url:state'), 'a URL de autorizacao leva o state')
  for (const segredo of ['id', 'codeVerifier']) {
    const s = transacao[segredo]
    assert.ok(!url.includes(s), `${segredo} na URL de autorizacao`)
    for (const [nome, p] of publicos) {
      assert.ok(!p.includes(s), `${nome} contem ${segredo}`)
      if (p.length >= 16) assert.ok(!s.includes(p), `${segredo} contem ${nome}`)
      for (const h of HASHES) {
        for (const c of CODIFICACOES) {
          assert.notEqual(s, createHash(h).update(p).digest(c), `${segredo} = ${h}(${nome}) em ${c}`)
        }
      }
    }
  }
}

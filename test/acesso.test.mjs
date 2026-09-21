import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessaoArquivo } from '../dist/adaptadores/sessao-arquivo.js'
import { acessoHttp } from '../dist/adaptadores/acesso-http.js'
import { criarNucleo } from '../dist/fabricas/criarNucleo.js'
import { acessoFake } from '../dist/testing/index.js'
import { NaoEncontrado, SessaoInvalida } from '../dist/interno/erros.js'

const dir = mkdtempSync(join(tmpdir(), 'acesso-'))
const PAINEL = { id: 'zona1.painel', zona: 'zona1', rotulo: 'Painel', prefixo: '/zona1' }

function nucleo(acesso, cookie = 'sid', destinos = {}) {
  return criarNucleo({ app: 'zona1', sessao: sessaoArquivo({ dir, modo: 'leitura' }), destinos, acesso,
                       lerCookieDeSessao: async () => cookie })
}

test('exigirModulo passa para modulo permitido e lanca NaoEncontrado (404) para o resto', async () => {
  await sessaoArquivo({ dir, modo: 'escrita' }).gravar('sid', { sub: 'ana', nome: 'Ana', accessToken: 't', expiraEm: Date.now() + 60_000 })
  const n = nucleo(acessoFake([PAINEL]))
  await n.acesso.exigirModulo('zona1.painel')
  await assert.rejects(() => n.acesso.exigirModulo('zona1.relatorios'), NaoEncontrado)
})

test('sem sessao, modulos permitidos lanca SessaoInvalida antes de perguntar ao dominio', async () => {
  let perguntou = false
  const n = nucleo(() => ({ modulosPermitidos: async () => { perguntou = true; return [PAINEL] } }), 'sid-inexistente')
  await assert.rejects(() => n.acesso.modulosPermitidos(), SessaoInvalida)
  assert.equal(perguntou, false)
})

test('acessoHttp pergunta ao dominio de gestao de acesso com a credencial do usuario', async () => {
  const vistas = []
  const s = createServer((req, res) => {
    vistas.push({ url: req.url, auth: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify([PAINEL]))
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  await sessaoArquivo({ dir, modo: 'escrita' }).gravar('sid-http', { sub: 'ana', nome: 'Ana', accessToken: 'tk-ana', expiraEm: Date.now() + 60_000 })
  const n = nucleo(acessoHttp({ destino: 'gestao-acesso' }), 'sid-http', {
    'gestao-acesso': { origem: `http://127.0.0.1:${s.address().port}`, caminhos: ['/v1/modulos-permitidos'], metodos: ['GET'], credencial: 'usuario' },
  })
  assert.deepEqual((await n.acesso.modulosPermitidos()).map((m) => m.id), ['zona1.painel'])
  assert.deepEqual(vistas, [{ url: '/v1/modulos-permitidos', auth: 'Bearer tk-ana' }])
  s.close()
})

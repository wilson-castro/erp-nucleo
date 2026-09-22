import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessaoArquivo, sessaoArquivoDeEscrita } from '../dist/adaptadores/sessao-arquivo.js'
import { acessoHttp } from '../dist/adaptadores/acesso-http.js'
import { criarNucleo } from '../dist/fabricas/criarNucleo.js'
import { acessoFake } from '../dist/testing/index.js'
import { NaoEncontrado, SessaoInvalida } from '../dist/interno/erros.js'

const dir = mkdtempSync(join(tmpdir(), 'acesso-'))
const PAINEL = { id: 'zona1.painel', zona: 'zona1', rotulo: 'Painel', prefixo: '/zona1' }

function nucleo(acesso, cookie = 'sid', destinos = {}) {
  return criarNucleo({ app: 'zona1', sessao: sessaoArquivo({ dir }), destinos, acesso,
                       lerCookieDeSessao: async () => cookie })
}

test('exigirModulo passa para modulo permitido e lanca NaoEncontrado (404) para o resto', async () => {
  await sessaoArquivoDeEscrita({ dir }).gravar('sid', { sub: 'ana', nome: 'Ana', accessToken: 't', expiraEm: Date.now() + 60_000 })
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
  await sessaoArquivoDeEscrita({ dir }).gravar('sid-http', { sub: 'ana', nome: 'Ana', accessToken: 'tk-ana', expiraEm: Date.now() + 60_000 })
  const n = nucleo(acessoHttp({ destino: 'gestao-acesso' }), 'sid-http', {
    'gestao-acesso': { origem: `http://127.0.0.1:${s.address().port}`, caminhos: ['/v1/modulos-permitidos'], metodos: ['GET'], credencial: 'usuario' },
  })
  assert.deepEqual((await n.acesso.modulosPermitidos()).map((m) => m.id), ['zona1.painel'])
  assert.deepEqual(vistas, [{ url: '/v1/modulos-permitidos', auth: 'Bearer tk-ana' }])
  s.close()
})

test('acessoHttp consome /v2/eu e mapeia modulos efetivos e obterEu', async () => {
  const euMock = {
    pessoa: { id: 'p-1', cpf: '12345678901', nome: 'Ana', email: 'ana@empresa.com', vinculo: 'ativo' },
    papeis: ['operador'],
    modulos: [{ id: 'zona1.painel', perfis: ['padrao'], funcionalidades: ['zona1.painel.ver', 'zona1.painel.custo'] }],
  }
  const s = createServer((req, res) => {
    if (req.url === '/v2/eu') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(euMock))
    } else {
      res.writeHead(404); res.end()
    }
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  await sessaoArquivoDeEscrita({ dir }).gravar('sid-v2', { sub: 'ana', nome: 'Ana', accessToken: 'tk-ana', expiraEm: Date.now() + 60_000 })
  const n = nucleo(acessoHttp({ destino: 'gestao-acesso' }), 'sid-v2', {
    'gestao-acesso': { origem: `http://127.0.0.1:${s.address().port}`, caminhos: ['/v2/eu', '/v1/modulos-permitidos'], metodos: ['GET'], credencial: 'usuario' },
  })
  const mods = await n.acesso.modulosPermitidos()
  assert.equal(mods.length, 1)
  assert.equal(mods[0].id, 'zona1.painel')
  assert.deepEqual(mods[0].funcionalidades, ['zona1.painel.ver', 'zona1.painel.custo'])
  const eu = await n.acesso.obterEu()
  assert.equal(eu.pessoa.nome, 'Ana')

  await n.acesso.exigirModulo('zona1.painel', 'zona1.painel.ver')
  await assert.rejects(() => n.acesso.exigirModulo('zona1.painel', 'zona1.painel.editar'), NaoEncontrado)
  s.close()
})


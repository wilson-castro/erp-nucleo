import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dadosHttp } from '../dist/adaptadores/dados-http.js'
import { dadosFake } from '../dist/testing/index.js'
import { NaoEncontrado } from '../dist/interno/erros.js'

const PEDIDO = {
  id: '8821', status: 'ABERTO', versao: 42,
  fornecedor: { id: 'f1', nome: 'Fornecedor Um' },
  itens: [], remessas: [],
  _permissoes: { editar: false, remover_remessa: false, excluir: false, aprovar: false },
}

test('o fake devolve o pedido sem tocar a rede', async () => {
  const dados = dadosFake({ '8821': PEDIDO })({ obterToken: async () => 'irrelevante' })
  const { pedido } = await dados.lerPedido('8821')
  assert.equal(pedido.id, '8821')
})

test('o fake lanca NaoEncontrado para id ausente', async () => {
  const dados = dadosFake({})({ obterToken: async () => 'x' })
  await assert.rejects(() => dados.lerPedido('9999'), NaoEncontrado)
})

test('o fake nao devolve propriedade herdada para id hostil', async () => {
  // um lookup por indice devolveria Object.prototype.toString aqui, e o fake passaria
  // a divergir do adaptador HTTP justamente nos ids que um atacante escolhe
  const dados = dadosFake({ '8821': PEDIDO })({ obterToken: async () => 'x' })
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    await assert.rejects(() => dados.lerPedido(id), NaoEncontrado, `id ${id} vazou`)
  }
})

test('o adaptador HTTP envia Bearer e nunca expoe o token no retorno', async () => {
  let autorizacaoVista = null
  const servidor = (await import('node:http')).createServer((req, res) => {
    autorizacaoVista = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json', etag: '"42"' })
    res.end(JSON.stringify(PEDIDO))
  })
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const porta = servidor.address().port

  const dados = dadosHttp({ baseUrl: `http://127.0.0.1:${porta}` })({
    obterToken: async () => 'token-secreto',
  })
  const { pedido, versao } = await dados.lerPedido('8821')

  assert.equal(autorizacaoVista, 'Bearer token-secreto')
  assert.equal(versao, '"42"')
  assert.ok(!JSON.stringify(pedido).includes('token-secreto'))
  servidor.close()
})

test('o adaptador HTTP recusa id que tenta escapar do caminho', async () => {
  const dados = dadosHttp({ baseUrl: 'http://127.0.0.1:4000' })({ obterToken: async () => 'x' })
  // o id vem da URL, portanto do cliente: precisa ser codificado, nunca concatenado cru
  await assert.rejects(() => dados.lerPedido('../../admin'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { criarNucleo } from '../dist/fabricas/criarNucleo.js'
import { sessaoArquivo } from '../dist/adaptadores/sessao-arquivo.js'
import { identidadeDev } from '../dist/adaptadores/identidade-dev.js'
import { destinosFake, sessaoFake, acessoFake } from '../dist/testing/index.js'
import { DestinoInvalido, NaoEncontrado } from '../dist/interno/erros.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('rotina de zona executa com adaptadores fake do nucleo sem erros de contrato (Cenario 1)', async () => {
  // Arrange: uma zona configurada com adaptadores falsos do nucleo
  const sessaoFalsa = sessaoFake({
    'sid-123': {
      sub: 'operador-1',
      roles: ['OPERADOR'],
      accessToken: 'token-op-1',
      expiraEm: Date.now() + 60_000,
    },
  })

  const acessoFalso = acessoFake([
    { id: 'pedidos.consulta', zona: 'pedidos', rotulo: 'Pedidos', prefixo: '/pedidos' },
    { id: 'estoque.consulta', zona: 'estoque', rotulo: 'Estoque', prefixo: '/estoque' },
  ])

  const destinosFalsos = destinosFake({
    'dominio-pedidos': {
      '/v1/pedidos/:id': (opcoes) => ({
        status: 200,
        versao: '"10"',
        body: { id: opcoes.params?.id, valorTotal: 500, status: 'NOVO' },
      }),
    },
  })

  const nucleo = criarNucleo({
    sessao: sessaoFalsa,
    lerCookieDeSessao: async () => 'sid-123',
    acesso: acessoFalso,
  })

  // Act & Assert 1: Zona verifica sessão
  const sessao = await nucleo.sessao.exigir()
  assert.equal(sessao.sub, 'operador-1')
  assert.deepEqual(sessao.roles, ['OPERADOR'])
  // Garante que o accessToken NUNCA está acessível na camada de apresentação / consumo da zona
  assert.equal('accessToken' in sessao, false)

  // Act & Assert 2: Zona valida acesso ao seu módulo
  const modulo = await nucleo.acesso?.exigirModulo('/pedidos')
  assert.equal(modulo?.id, 'pedidos.consulta')
  assert.equal(modulo?.zona, 'pedidos')

  // Act & Assert 3: Acesso a módulo não concedido rejeita com NaoEncontrado (404 seguro)
  await assert.rejects(
    () => nucleo.acesso.exigirModulo('/financeiro'),
    NaoEncontrado,
  )

  // Act & Assert 4: Zona consome seus domínios através de porta de destinos falsa
  const clienteDestino = destinosFalsos.destino('dominio-pedidos')
  const resposta = await clienteDestino.get(
    '/v1/pedidos/:id',
    { params: { id: 'ped-99' } },
  )

  assert.equal(resposta.status, 200)
  assert.equal(resposta.versao, '"10"')
  assert.equal(resposta.body?.id, 'ped-99')
  assert.equal(resposta.body?.valorTotal, 500)
})

test('zona com destinos reais declarados monta requisicao segura e rejeita saida fora do registro', async () => {
  let cabecalhoAutorizacaoRecebido = ''
  let caminhoRecebido = ''
  let ifMatchRecebido = ''

  const servidor = createServer((req, res) => {
    cabecalhoAutorizacaoRecebido = req.headers.authorization ?? ''
    caminhoRecebido = req.url ?? ''
    ifMatchRecebido = req.headers['if-match'] ?? ''
    res.writeHead(200, { 'content-type': 'application/json', etag: '"v42"' })
    res.end(JSON.stringify({ id: 'item-1', nome: 'Produto A' }))
  })

  await new Promise((r) => servidor.listen(0, '127.0.0.1', r))
  const porta = servidor.address().port
  const baseUrl = `http://127.0.0.1:${porta}`

  const dir = mkdtempSync(join(tmpdir(), 'sessao-destinos-'))
  const store = sessaoArquivo({ dir })
  await store.gravar('sid-abc', {
    sub: 'ana',
    roles: ['OPERADOR'],
    accessToken: 'token-secreto-usuario',
    expiraEm: Date.now() + 60_000,
  })

  const nucleo = criarNucleo({
    sessao: store,
    lerCookieDeSessao: async () => 'sid-abc',
    destinos: {
      'catalogo': {
        origem: baseUrl,
        caminhos: ['/v1/itens/:id', '/v1/itens'],
        metodos: ['GET', 'POST'],
        credencial: 'usuario',
        timeoutMs: 2000,
      },
    },
  })

  // Chamada válida
  const res = await nucleo.destino('catalogo').get(
    '/v1/itens/:id',
    { params: { id: 'item-1' }, ifMatch: '"v41"' },
  )

  assert.equal(res.status, 200)
  assert.equal(res.versao, '"v42"')
  assert.equal(res.body?.nome, 'Produto A')
  assert.equal(cabecalhoAutorizacaoRecebido, 'Bearer token-secreto-usuario')
  assert.equal(caminhoRecebido, '/v1/itens/item-1')
  assert.equal(ifMatchRecebido, '"v41"')

  // Destino não declarado lança DestinoInvalido
  assert.throws(() => nucleo.destino('outro-dominio'), DestinoInvalido)

  // Caminho não declarado lança DestinoInvalido sem sair na rede
  await assert.rejects(
    () => nucleo.destino('catalogo').get('/v1/caminho-proibido'),
    DestinoInvalido,
  )

  // Método não declarado lança DestinoInvalido
  await assert.rejects(
    () => nucleo.destino('catalogo').delete('/v1/itens/:id', { params: { id: 'item-1' } }),
    DestinoInvalido,
  )

  // Parâmetro hostil com dot-segments rejeita sem sair na rede
  for (const hostil of ['.', '..']) {
    await assert.rejects(
      () => nucleo.destino('catalogo').get('/v1/itens/:id', { params: { id: hostil } }),
      DestinoInvalido,
    )
  }

  servidor.close()
})

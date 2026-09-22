// @erp/nucleo/app (ADR-0012): o que as 4 apps copiavam em lib/pagina.ts, com a decisão de acesso
// no núcleo e o Next injetado. Sem Next nem React aqui: tudo por adaptador.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarPaginas } from '../dist/fabricas/criarPaginas.js'
import { NaoEncontrado, SessaoInvalida, ErroDeAplicacao } from '../dist/interno/erros.js'

class Redirecionou extends Error { constructor(url) { super(url); this.url = url } }
class NaoAchou extends Error {}

/** Adaptador do Next falso: cabeçalhos por objeto, notFound/redirect lançam como no Next. */
function next(cabecalhos = {}) {
  return {
    cabecalho: async (n) => cabecalhos[n.toLowerCase()] ?? null,
    naoEncontrado: () => { throw new NaoAchou() },
    redirecionar: (url) => { throw new Redirecionou(url) },
    porRequisicao: (f) => f,
  }
}

/** Núcleo falso com as mesmas funções que `criarNucleo` devolve. */
function nucleo({ sessao = { sub: 'ana', nome: 'Ana' }, modulos = ['zona1.painel'], acessoFora = false } = {}) {
  const chamadas = []
  return {
    chamadas,
    sessao: {
      atual: async () => sessao,
      exigir: async () => { chamadas.push('exigir'); if (!sessao) throw new SessaoInvalida(); return sessao },
    },
    acesso: {
      modulosPermitidos: async () => {
        chamadas.push('modulos')
        if (acessoFora) throw new ErroDeAplicacao('ERRO_INTERNO')
        return modulos.map((id) => ({ id, rotulo: id, prefixo: '/x' }))
      },
      exigirModulo: async (id) => {
        chamadas.push(`exigirModulo:${id}`)
        if (acessoFora) throw new ErroDeAplicacao('ERRO_INTERNO')
        if (!modulos.includes(id)) throw new NaoEncontrado()
      },
    },
  }
}

const cfg = (cabecalhos, extra = {}) => ({ hostsPermitidos: ['localhost:3000'], next: next(cabecalhos), ...extra })

test('exigirModulo: modulo permitido segue; negado e 404 (notFound), sem pagina de "sem acesso"', async () => {
  const p = criarPaginas(nucleo(), cfg())
  await p.exigirModulo('zona1.painel')
  await assert.rejects(p.exigirModulo('zona1.relatorios'), NaoAchou)
})

test('exigirModulo e FAIL-CLOSED: gestao de acesso fora propaga o erro, nunca deixa passar', async () => {
  const p = criarPaginas(nucleo({ acessoFora: true }), cfg())
  await assert.rejects(p.exigirModulo('zona1.painel'), ErroDeAplicacao)
})

test('sessao ausente vai ao login com o caminho atual; sessao invalida na consulta de modulos tambem', async () => {
  const semSessao = criarPaginas(nucleo({ sessao: null }), cfg({ 'x-erp-caminho': '/zona1/relatorios' }))
  await assert.rejects(semSessao.sessaoDaPagina(), (e) => e instanceof Redirecionou && e.url === '/login?de=%2Fzona1%2Frelatorios')
  const n = nucleo(); n.acesso.modulosPermitidos = async () => { throw new SessaoInvalida() }
  await assert.rejects(criarPaginas(n, cfg({ 'x-erp-caminho': '/zona2' })).modulosPermitidos(), (e) => e.url === '/login?de=%2Fzona2')
})

test('caminhoAtual vem do cabecalho posto pelo proxy; sem ele, "/"', async () => {
  assert.equal(await criarPaginas(nucleo(), cfg({ 'x-erp-caminho': '/acesso' })).caminhoAtual(), '/acesso')
  assert.equal(await criarPaginas(nucleo(), cfg()).caminhoAtual(), '/')
})

const origemOk = { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }

test('acaoProtegida: origem, sessao e modulo conferidos NESSA ordem, antes do corpo', async () => {
  const n = nucleo()
  const r = await criarPaginas(n, cfg(origemOk)).acaoProtegida('zona1.painel', async () => 'feito', async (m) => `negou:${m}`)
  assert.equal(r, 'feito')
  assert.deepEqual(n.chamadas, ['exigir', 'exigirModulo:zona1.painel'])
})

test('acaoProtegida: origem ruim nega sem consultar sessao nem modulo, e sem rodar o corpo', async () => {
  for (const cab of [{}, { origin: 'http://evil.com' }, { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }, { origin: 'nao-e-url' }]) {
    const n = nucleo(); let rodou = false
    const r = await criarPaginas(n, cfg(cab)).acaoProtegida('zona1.painel', async () => { rodou = true }, async (m) => m)
    assert.equal(r, 'origem', JSON.stringify(cab)); assert.equal(rodou, false); assert.deepEqual(n.chamadas, [])
  }
})

test('acaoProtegida: sessao invalida e modulo negado negam com o motivo certo, sem rodar o corpo', async () => {
  let rodou = false
  const corpo = async () => { rodou = true }
  assert.equal(await criarPaginas(nucleo({ sessao: null }), cfg(origemOk)).acaoProtegida('zona1.painel', corpo, async (m) => m), 'sessao')
  assert.equal(await criarPaginas(nucleo(), cfg(origemOk)).acaoProtegida('zona2.tarefas', corpo, async (m) => m), 'modulo')
  assert.equal(await criarPaginas(nucleo({ acessoFora: true }), cfg(origemOk)).acaoProtegida('zona1.painel', corpo, async (m) => m), 'modulo')
  assert.equal(rodou, false)
})

test('acaoProtegida: erro do corpo nao vira negacao; sobe para quem chamou', async () => {
  await assert.rejects(criarPaginas(nucleo(), cfg(origemOk)).acaoProtegida('zona1.painel', async () => { throw new ErroDeAplicacao('REGISTRO_DESATUALIZADO') }, async (m) => m),
    (e) => e.codigo === 'REGISTRO_DESATUALIZADO')
})

test('hostsPermitidos vazio recusa toda acao (configuracao faltando nao abre a porta)', async () => {
  const r = await criarPaginas(nucleo(), cfg(origemOk, { hostsPermitidos: [] })).acaoProtegida('zona1.painel', async () => 'feito', async (m) => m)
  assert.equal(r, 'origem')
})

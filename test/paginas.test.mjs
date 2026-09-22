// @erp/nucleo/app (ADR-0012): o que as 4 apps copiavam em lib/pagina.ts, com a decisão de acesso
// no núcleo e o Next injetado. Sem Next nem React aqui: tudo por adaptador.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarPaginas } from '../dist/fabricas/criarPaginas.js'
import { SessaoInvalida, ErroDeAplicacao } from '../dist/interno/erros.js'

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

const ZONA1 = { id: 'zona1', nome: 'Zona 1', funcionalidades: ['painel.ver'] }

/** Núcleo falso com a forma que `criarNucleo` devolve. */
function nucleo({ sessao = { sub: 'ana', nome: 'Ana' }, modulos = [ZONA1], administra = false, acessoFora = false } = {}) {
  const chamadas = []
  return {
    chamadas,
    sessao: {
      atual: async () => sessao,
      exigir: async () => { chamadas.push('exigir'); if (!sessao) throw new SessaoInvalida(); return sessao },
    },
    acesso: {
      acessoEfetivo: async () => {
        chamadas.push('acesso')
        if (acessoFora) throw new ErroDeAplicacao('ERRO_INTERNO')
        return { modulos, administra }
      },
    },
  }
}

const cfg = (cabecalhos, extra = {}) => ({ hostsPermitidos: ['localhost:3000'], next: next(cabecalhos), ...extra })

test('exigirModulo: funcionalidade presente segue; ausente, ou modulo ausente, e 404 (notFound)', async () => {
  const p = criarPaginas(nucleo(), cfg())
  await p.exigirModulo('zona1', 'painel.ver')
  await assert.rejects(p.exigirModulo('zona1', 'relatorios.ver'), NaoAchou)   // † mesmo modulo, outra funcionalidade
  await assert.rejects(p.exigirModulo('zona2', 'tarefas.ver'), NaoAchou)
})

test('exigirModulo exige os dois argumentos: sem funcionalidade, ou modulo com ponto, e erro de programacao', async () => {
  const p = criarPaginas(nucleo(), cfg())
  for (const args of [['zona1'], ['zona1', undefined], ['zona1.painel', 'painel.ver'], ['zona1', 'painel'], ['zona1', 'zona1.painel.ver']]) {
    await assert.rejects(p.exigirModulo(...args), TypeError, JSON.stringify(args))
  }
})

test('exigirModulo e FAIL-CLOSED: gestao de acesso fora propaga o erro, nunca deixa passar nem vira 404', async () => {
  const p = criarPaginas(nucleo({ acessoFora: true }), cfg())
  await assert.rejects(p.exigirModulo('zona1', 'painel.ver'), (e) => e instanceof ErroDeAplicacao)
})

test('exigirPapel: 404 sem papel administrativo; segue com ele', async () => {
  await assert.rejects(criarPaginas(nucleo(), cfg()).exigirPapel(), NaoAchou)   // †
  await criarPaginas(nucleo({ administra: true, modulos: [] }), cfg()).exigirPapel()
})

test('menu: uma entrada por modulo (prefixo /id, rotulo nome); entrada administrativa so para quem administra', async () => {
  const entradaAdministrativa = { id: 'acesso', rotulo: 'Gestão de acesso', prefixo: '/acesso' }
  assert.deepEqual(await criarPaginas(nucleo(), cfg({}, { entradaAdministrativa })).modulosPermitidos(),
    [{ id: 'zona1', rotulo: 'Zona 1', prefixo: '/zona1' }])
  assert.deepEqual(await criarPaginas(nucleo({ administra: true }), cfg({}, { entradaAdministrativa })).modulosPermitidos(),
    [{ id: 'zona1', rotulo: 'Zona 1', prefixo: '/zona1' }, entradaAdministrativa])
})

test('a pagina nunca recebe papeis nem CPF: o acesso efetivo so tem modulos e administra', async () => {
  const p = criarPaginas(nucleo({ administra: true }), cfg())
  assert.deepEqual(Object.keys(await p.acessoEfetivo()).sort(), ['administra', 'modulos'])
})

test('sessao ausente vai ao login com o caminho atual; 401 da gestao de acesso tambem', async () => {
  const semSessao = criarPaginas(nucleo({ sessao: null }), cfg({ 'x-erp-caminho': '/zona1/relatorios' }))
  await assert.rejects(semSessao.sessaoDaPagina(), (e) => e instanceof Redirecionou && e.url === '/login?de=%2Fzona1%2Frelatorios')
  const n = nucleo(); n.acesso.acessoEfetivo = async () => { throw new SessaoInvalida() }
  await assert.rejects(criarPaginas(n, cfg({ 'x-erp-caminho': '/zona2' })).modulosPermitidos(), (e) => e.url === '/login?de=%2Fzona2')
})

test('caminhoAtual vem do cabecalho posto pelo proxy; sem ele, "/"', async () => {
  assert.equal(await criarPaginas(nucleo(), cfg({ 'x-erp-caminho': '/acesso' })).caminhoAtual(), '/acesso')
  assert.equal(await criarPaginas(nucleo(), cfg()).caminhoAtual(), '/')
})

const origemOk = { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }
const PAINEL = { modulo: 'zona1', funcionalidade: 'painel.ver' }

test('acaoProtegida: origem, sessao e requisito conferidos NESSA ordem, antes do corpo', async () => {
  const n = nucleo()
  const r = await criarPaginas(n, cfg(origemOk)).acaoProtegida(PAINEL, async () => 'feito', async (m) => `negou:${m}`)
  assert.equal(r, 'feito')
  assert.deepEqual(n.chamadas, ['exigir', 'acesso'])
})

test('acaoProtegida: origem ruim nega sem consultar sessao nem acesso, e sem rodar o corpo', async () => {
  for (const cab of [{}, { origin: 'http://evil.com' }, { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }, { origin: 'nao-e-url' }]) {
    const n = nucleo(); let rodou = false
    const r = await criarPaginas(n, cfg(cab)).acaoProtegida(PAINEL, async () => { rodou = true }, async (m) => m)
    assert.equal(r, 'origem', JSON.stringify(cab)); assert.equal(rodou, false); assert.deepEqual(n.chamadas, [])
  }
})

test('acaoProtegida: sessao invalida, funcionalidade ausente e acesso fora negam com o motivo certo, sem rodar o corpo', async () => {
  let rodou = false
  const corpo = async () => { rodou = true }
  const nega = (n, req = PAINEL) => criarPaginas(n, cfg(origemOk)).acaoProtegida(req, corpo, async (m) => m)
  assert.equal(await nega(nucleo({ sessao: null })), 'sessao')
  assert.equal(await nega(nucleo(), { modulo: 'zona1', funcionalidade: 'painel.editar' }), 'modulo')   // †
  assert.equal(await nega(nucleo(), { modulo: 'zona2', funcionalidade: 'tarefas.concluir' }), 'modulo')
  assert.equal(await nega(nucleo({ acessoFora: true })), 'modulo')
  assert.equal(await nega(nucleo(), { administra: true }), 'modulo')   // † papel ausente
  assert.equal(rodou, false)
})

test('acaoProtegida: papel administrativo presente executa', async () => {
  const r = await criarPaginas(nucleo({ administra: true, modulos: [] }), cfg(origemOk)).acaoProtegida({ administra: true }, async () => 'feito', async (m) => m)
  assert.equal(r, 'feito')
})

test('acaoProtegida: requisito mal formado e erro de programacao, antes de qualquer efeito', async () => {
  for (const req of [{ modulo: 'zona1' }, { modulo: 'zona1.painel', funcionalidade: 'painel.ver' }, {}]) {
    await assert.rejects(criarPaginas(nucleo(), cfg(origemOk)).acaoProtegida(req, async () => 'feito', async (m) => m), TypeError, JSON.stringify(req))
  }
})

test('acaoProtegida: erro do corpo nao vira negacao; sobe para quem chamou', async () => {
  await assert.rejects(criarPaginas(nucleo(), cfg(origemOk)).acaoProtegida(PAINEL, async () => { throw new ErroDeAplicacao('REGISTRO_DESATUALIZADO') }, async (m) => m),
    (e) => e.codigo === 'REGISTRO_DESATUALIZADO')
})

test('hostsPermitidos vazio recusa toda acao (configuracao faltando nao abre a porta)', async () => {
  const r = await criarPaginas(nucleo(), cfg(origemOk, { hostsPermitidos: [] })).acaoProtegida(PAINEL, async () => 'feito', async (m) => m)
  assert.equal(r, 'origem')
})

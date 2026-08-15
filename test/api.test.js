// ======================================================================
// GC PATRIMONIAL — SUÍTE DE REGRESSÃO DA API
// 11 testes, rodando contra a API real (fronteira preservada:
// FRONTEND -> API -> [respostas brutas + dados estruturados] -> NÚCLEO)
// Executar: npm test  (requer o servidor já rodando — por padrão em
// localhost:3001; após o deploy, aponte via API_BASE_URL sem editar código)
// ======================================================================
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const BASE = process.env.API_BASE_URL || 'http://localhost:3001';
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'gc_patrimonial_app',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ----------------------------------------------------------------------
// Limpeza dos fixtures criados PELA PRÓPRIA SUÍTE — nunca de dados alheios.
// Só recebe IDs capturados durante a execução (nunca um ID fixo/adivinhado),
// e só apaga o que essa cadeia de FK realmente pode conter para um cliente
// criado por este arquivo. Se o cliente não existir (id undefined, teste
// anterior falhou antes de criar), a função simplesmente não faz nada.
// ----------------------------------------------------------------------
async function cleanupClient(clientId) {
  if (!clientId) return;
  const { rows: anamneses } = await pool.query(`SELECT id FROM anamneses WHERE client_id=$1`, [clientId]);
  const anamneseIds = anamneses.map(a => a.id);

  if (anamneseIds.length > 0) {
    await pool.query(`DELETE FROM client_recommendations WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM client_needs WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM client_resolution_logs WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM client_scores WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM rule_execution_logs WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM client_diagnostics WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM client_variables WHERE client_id=$1`, [clientId]);
    await pool.query(`DELETE FROM anamnese_answers WHERE anamnese_id = ANY($1)`, [anamneseIds]);
  }

  await pool.query(`DELETE FROM businesses WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM investments WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM objectives WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM liabilities WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM assets WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM expenses WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM income_sources WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM family_members WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM client_profiles WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM anamneses WHERE client_id=$1`, [clientId]);
  await pool.query(`DELETE FROM clients WHERE id=$1`, [clientId]);
}

function makeClient() {
  let cookie = null;
  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch (e) { /* corpo vazio ou não-JSON */ }
    return { status: res.status, body: json };
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
  };
}

// Valores congelados do Teste 3 (referência para o Teste de Ouro)
const FROZEN = {
  score_geral: 69.0,
  dimensoes: { PROTECAO: 54.5, LIQUIDEZ: 80.0, CONTINUIDADE: 39.5, SUCESSAO: 65.0, APOSENTADORIA: 80.0, DIVERSIFICACAO: 100, ACUMULACAO: 90.0 },
  riscos: ['R01', 'R06', 'R09', 'R10', 'R11', 'R12', 'R16', 'R17'].sort(),
  necessidades: ['N01', 'N02', 'N03', 'N04', 'N06'].sort(),
  consolidadas_total: 21,
};

describe('GC Patrimonial — Regressão da API', () => {
  let prof2ClientId; // capturado no Teste 2, limpo no after() ao final

  after(async () => {
    // Limpeza final — só roda depois de TODOS os testes, e só sobre os IDs
    // que esta própria suíte criou e capturou durante a execução.
    await cleanupClient(prof2ClientId);
    await cleanupClient(clientId);
    await pool.end();
  });

  test('Teste 1 — Autorização', async () => {
    const anon = makeClient();
    let r = await anon.post('/api/auth/login', { email: 'getulio@getuliocoelho.com.br', password: 'senhaerrada' });
    assert.equal(r.status, 401, 'senha errada deve ser rejeitada');

    r = await anon.get('/api/clients');
    assert.equal(r.status, 401, 'rota protegida sem sessão deve ser 401');

    r = await anon.post('/api/auth/login', { email: 'getulio@getuliocoelho.com.br', password: 'senha123' });
    assert.equal(r.status, 200);
    assert.equal(r.body.token, undefined, 'JWT não pode aparecer no corpo da resposta');

    r = await anon.get('/api/clients');
    assert.equal(r.status, 200, 'com sessão válida deve ser 200');
  });

  test('Teste 2 — Isolamento entre profissionais', async () => {
    const prof1 = makeClient();
    const prof2 = makeClient();
    await prof1.post('/api/auth/login', { email: 'getulio@getuliocoelho.com.br', password: 'senha123' });
    await prof2.post('/api/auth/login', { email: 'outro@teste.com', password: 'senha456' });

    const created = await prof2.post('/api/clients', { name: 'Cliente Exclusivo do Prof2' });
    assert.equal(created.status, 201);
    const clientId = created.body.id;
    prof2ClientId = clientId; // guardado para limpeza no after()

    // prof1 NÃO pode ver o cliente do prof2
    let r = await prof1.get(`/api/clients/${clientId}`);
    assert.equal(r.status, 404, 'profissional 1 não pode acessar cliente do profissional 2');

    r = await prof1.get(`/api/clients/${clientId}/anamneses`);
    assert.equal(r.status, 404, 'listar anamneses de cliente alheio deve ser 404, nunca lista vazia');

    // prof2 pode ver o próprio cliente
    r = await prof2.get(`/api/clients/${clientId}`);
    assert.equal(r.status, 200);

    // prof1 não vê o cliente do prof2 na própria listagem
    const list1 = await prof1.get('/api/clients');
    assert.ok(!list1.body.some(c => c.id === clientId), 'lista do prof1 não deve conter cliente do prof2');
  });

  let mainClient, clientId, anamneseId;

  test('Teste 3 — Perguntas aplicáveis (perfil determina o conjunto)', async () => {
    mainClient = makeClient();
    await mainClient.post('/api/auth/login', { email: 'getulio@getuliocoelho.com.br', password: 'senha123' });

    const created = await mainClient.post('/api/clients', {
      name: 'Teste Regressao - Empresario', birth_date: '1980-01-01', marital_status: 'CASADO', profiles: ['EMPRESARIO'],
    });
    assert.equal(created.status, 201);
    clientId = created.body.id;

    const anaRes = await mainClient.post(`/api/clients/${clientId}/anamneses`);
    assert.equal(anaRes.status, 201);
    anamneseId = anaRes.body.id;

    const qs = await mainClient.get(`/api/anamneses/${anamneseId}/questions`);
    assert.equal(qs.status, 200);
    const codes = qs.body.map(q => q.question_code);
    assert.ok(codes.includes('E004'), 'perfil EMPRESARIO deve ver E004');
    assert.ok(codes.includes('E010'), 'perfil EMPRESARIO deve ver E010');
    const u009 = qs.body.find(q => q.question_code === 'U009');
    assert.equal(u009.capture_mode, 'PENDENTE_DE_CONFIGURACAO', 'U009 deve estar marcada como pendente');
  });

  test('Teste 4 — Respostas (CAMPO_UNICO grava; PENDENTE bloqueia)', async () => {
    const qs = await mainClient.get(`/api/anamneses/${anamneseId}/questions`);
    const u001 = qs.body.find(q => q.question_code === 'U001');
    const u009 = qs.body.find(q => q.question_code === 'U009');

    let r = await mainClient.post(`/api/anamneses/${anamneseId}/answers`, { question_id: u001.id, value: '1980-01-01' });
    assert.equal(r.status, 200);

    const detail = await mainClient.get(`/api/clients/${clientId}`);
    assert.equal(detail.body.birth_date.slice(0, 10), '1980-01-01', 'CAMPO_UNICO deve gravar direto em clients.birth_date');

    r = await mainClient.post(`/api/anamneses/${anamneseId}/answers`, { question_id: u009.id, value: 'qualquer coisa' });
    assert.equal(r.status, 400, 'pergunta PENDENTE_DE_CONFIGURACAO não pode ser respondida');
  });

  test('Teste 5 — Coleta estruturada', async () => {
    let r = await mainClient.post(`/api/clients/${clientId}/family-members`, { relationship: 'CONJUGE', monthly_income: 0, financial_dependency: false });
    assert.equal(r.status, 201);
    r = await mainClient.post(`/api/clients/${clientId}/family-members`, { relationship: 'FILHO', monthly_income: 0, financial_dependency: true });
    assert.equal(r.status, 201);
    r = await mainClient.post(`/api/clients/${clientId}/family-members`, { relationship: 'FILHO', monthly_income: 0, financial_dependency: true });
    assert.equal(r.status, 201);
    r = await mainClient.post(`/api/clients/${clientId}/income-sources`, { type: 'PROLABORE', monthly_value: 20000 });
    assert.equal(r.status, 201);
    r = await mainClient.post(`/api/clients/${clientId}/expenses`, { category: 'GERAL', monthly_value: 15000 });
    assert.equal(r.status, 201);
    for (const a of [
      { category: 'INVESTIMENTO', estimated_value: 50000, liquidity: 'ALTA' },
      { category: 'RURAL', estimated_value: 1000000, liquidity: 'BAIXA' },
      { category: 'IMOVEL', estimated_value: 1500000, liquidity: 'BAIXA' },
      { category: 'OUTROS', estimated_value: 100000, liquidity: 'BAIXA' },
      { category: 'OUTROS', estimated_value: 20000, liquidity: 'BAIXA' },
      { category: 'VEICULO', estimated_value: 130000, liquidity: 'MEDIA' },
    ]) {
      r = await mainClient.post(`/api/clients/${clientId}/assets`, a);
      assert.equal(r.status, 201);
    }
    r = await mainClient.post(`/api/clients/${clientId}/businesses`, { name: 'Farmacia', dependency_level: 'ALTA', continuity_plan: false, succession_plan: false });
    assert.equal(r.status, 201);
  });

  test('Teste 6 — Progresso', async () => {
    const r = await mainClient.get(`/api/anamneses/${anamneseId}/progress`);
    assert.equal(r.status, 200);
    assert.equal(r.body.percentage, 100, 'todas as obrigatórias foram respondidas — progresso deve ser 100%');
    assert.deepEqual(r.body.missing, []);
  });

  test('Teste 7 — Conclusão', async () => {
    const r = await mainClient.post(`/api/anamneses/${anamneseId}/complete`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'COMPLETED');
  });

  test('Teste 8 — Bloqueio pós-conclusão', async () => {
    // Regra arquitetural documentada aqui (não é acidente de implementação):
    //   ANAMNESE COMPLETED → respostas de pergunta bloqueadas
    //                      → dados estruturados AINDA podem ser alterados
    //   EXECUTE            → dados estruturados TAMBÉM ficam bloqueados (ver Teste 10)
    // Ou seja: "concluir" trava só a entrevista; "executar" é o verdadeiro
    // ponto de não-retorno para os dados brutos. Intencional — o Teste de
    // Ouro depende exatamente dessa ordem.
    const qs = await mainClient.get(`/api/anamneses/${anamneseId}/questions`);
    const u001 = qs.body.find(q => q.question_code === 'U001');
    let r = await mainClient.post(`/api/anamneses/${anamneseId}/answers`, { question_id: u001.id, value: '1999-01-01' });
    assert.equal(r.status, 409, 'responder pergunta em anamnese COMPLETED deve ser bloqueado');

    r = await mainClient.post(`/api/clients/${clientId}/assets`, { category: 'IMOVEL', estimated_value: 1, liquidity: 'BAIXA' });
    assert.equal(r.status, 201, 'coleta estruturada AINDA é permitida antes de executar (só é travada após execução — ver Teste 9)');
    // remove o ativo de teste para não poluir o Teste de Ouro
    await pool.query(`DELETE FROM assets WHERE client_id=$1 AND estimated_value=1`, [clientId]);
  });

  test('Teste 9 — Execução', async () => {
    const r = await mainClient.post(`/api/anamneses/${anamneseId}/execute`);
    assert.equal(r.status, 200);
    assert.equal(r.body.executed, true);

    const { rows } = await pool.query(`SELECT COUNT(*) FROM client_diagnostics WHERE anamnese_id=$1`, [anamneseId]);
    assert.ok(parseInt(rows[0].count) > 0, 'execução deve gerar ao menos 1 diagnóstico');
  });

  test('Teste 10 — Bloqueio pós-execução', async () => {
    let r = await mainClient.post(`/api/clients/${clientId}/assets`, { category: 'IMOVEL', estimated_value: 1, liquidity: 'BAIXA' });
    assert.equal(r.status, 409, 'coleta estruturada deve ser bloqueada após a última anamnese ter sido executada');

    r = await mainClient.post(`/api/anamneses/${anamneseId}/execute`);
    assert.equal(r.status, 409, 'reexecutar a mesma anamnese deve retornar 409 controlado, nunca 500');
    assert.match(r.body.error, /nova versão/i);
  });

  test('Teste 11 — Teste de Ouro (equivalência total com o resultado congelado)', async () => {
    const { rows: overall } = await pool.query(
      `SELECT overall_score FROM client_scores WHERE anamnese_id=$1 AND score_dimension_id IS NULL`, [anamneseId]);
    assert.equal(parseFloat(overall[0].overall_score), FROZEN.score_geral);

    const { rows: dims } = await pool.query(
      `SELECT sd.code, cs.dimension_score FROM client_scores cs
       JOIN score_dimensions sd ON sd.id=cs.score_dimension_id WHERE cs.anamnese_id=$1`, [anamneseId]);
    for (const [code, expected] of Object.entries(FROZEN.dimensoes)) {
      const found = dims.find(d => d.code === code);
      assert.equal(parseFloat(found.dimension_score), expected, `dimensão ${code} deve bater com o valor congelado`);
    }

    const { rows: risks } = await pool.query(
      `SELECT d.code FROM client_diagnostics cd JOIN knowledge_diagnostics d ON d.id=cd.diagnostic_id
       WHERE cd.anamnese_id=$1 ORDER BY d.code`, [anamneseId]);
    assert.deepEqual(risks.map(r => r.code).sort(), FROZEN.riscos);

    const { rows: needs } = await pool.query(
      `SELECT DISTINCT n.code FROM client_needs cn JOIN knowledge_needs n ON n.id=cn.need_id
       WHERE cn.anamnese_id=$1 ORDER BY n.code`, [anamneseId]);
    assert.deepEqual(needs.map(n => n.code).sort(), FROZEN.necessidades);

    const { rows: cons } = await pool.query(
      `SELECT COUNT(*) FROM v_client_consolidated_recommendations WHERE anamnese_id=$1`, [anamneseId]);
    assert.equal(parseInt(cons[0].count), FROZEN.consolidadas_total);

    const { rows: conv } = await pool.query(
      `SELECT prioridade_consolidada, riscos_convergentes FROM v_client_consolidated_recommendations
       WHERE anamnese_id=$1 AND estrategia_code='E01' AND solucao_code='S01'`, [anamneseId]);
    assert.equal(conv[0].prioridade_consolidada, 'CRITICA');
    assert.deepEqual(conv[0].riscos_convergentes.sort(), ['R01', 'R10']);

    const { rows: gap } = await pool.query(
      `SELECT eh_gap, prioridade_consolidada FROM v_client_consolidated_recommendations
       WHERE anamnese_id=$1 AND estrategia_code='E08'`, [anamneseId]);
    assert.equal(gap[0].eh_gap, true);
    assert.equal(gap[0].prioridade_consolidada, 'CRITICA');
  });
});

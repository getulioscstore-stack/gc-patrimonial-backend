// ======================================================================
// GC PATRIMONIAL — API MVP — ETAPA 1: Autenticação + Clientes + Início da Anamnese
// Nenhuma regra de negócio aqui. Todo endpoint é INSERT/UPDATE/SELECT simples
// ou chamada às funções já congeladas do núcleo (run_full_pipeline,
// resolve_client_recommendations) — que ainda não entram nesta etapa.
// ======================================================================
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('ERRO FATAL: variável de ambiente JWT_SECRET não definida. Encerrando.');
  process.exit(1);
}
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'gc_patrimonial_app',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------
// Middleware de autenticação — toda rota abaixo dele exige sessão válida
// ---------------------------------------------------------------
function requireAuth(req, res, next) {
  const token = req.cookies.session || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sessão inválida' });
  }
}

// ---------------------------------------------------------------
// Helper reutilizado por toda rota que opera sobre um client_id —
// garante isolamento por profissional/organização em um único lugar,
// evitando repetir (e esquecer) a checagem endpoint a endpoint.
// ---------------------------------------------------------------
async function getOwnedClientOrNull(dbConn, clientId, user) {
  const { rows } = await dbConn.query(
    `SELECT id FROM clients WHERE id = $1 AND professional_id = $2 AND organization_id = $3`,
    [clientId, user.professional_id, user.organization_id]);
  return rows[0] || null;
}

// Anamnese só é "possuída" se o cliente dela também for — checagem em cadeia,
// nunca confiando só no anamnese_id vindo da URL.
async function getOwnedAnamneseOrNull(dbConn, anamneseId, user) {
  const { rows } = await dbConn.query(
    `SELECT a.id, a.client_id, a.version, a.status
     FROM anamneses a JOIN clients c ON c.id = a.client_id
     WHERE a.id = $1 AND c.professional_id = $2 AND c.organization_id = $3`,
    [anamneseId, user.professional_id, user.organization_id]);
  return rows[0] || null;
}

// Trava D: uma anamnese já executada (existe client_diagnostics para ela) fica
// congelada — nem resposta nem coleta estruturada podem mais alterá-la.
// Isso vale tanto para a própria anamnese quanto para os dados do cliente
// (que são compartilhados entre versões), evitando drift silencioso.
async function isAnamneseLocked(dbConn, anamneseId) {
  const { rows } = await dbConn.query(
    `SELECT 1 FROM client_diagnostics WHERE anamnese_id = $1 LIMIT 1`, [anamneseId]);
  return rows.length > 0;
}

async function isClientLatestAnamneseLocked(dbConn, clientId) {
  const { rows } = await dbConn.query(
    `SELECT a.id FROM anamneses a WHERE a.client_id = $1 ORDER BY a.version DESC LIMIT 1`, [clientId]);
  if (!rows[0]) return false;
  return isAnamneseLocked(dbConn, rows[0].id);
}

// ---------------------------------------------------------------
// AUTENTICAÇÃO
// ---------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.organization_id, u.password_hash, p.id AS professional_id
     FROM users u LEFT JOIN professionals p ON p.user_id = u.id
     WHERE u.email = $1`, [email]);
  const user = rows[0];
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  const token = jwt.sign({
    user_id: user.id, email: user.email, role: user.role,
    organization_id: user.organization_id, professional_id: user.professional_id,
  }, JWT_SECRET, { expiresIn: '8h' });
  // secure=true em produção (HTTPS) — em dev local (HTTP) fica false
  // automaticamente, senão o cookie nunca seria aceito pelo navegador ali.
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
  res.cookie('session', token, cookieOpts);
  res.json({ ok: true, user: { email: user.email, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});

// Identificação do profissional autenticado — reaproveita req.user, já
// populado por requireAuth a partir do JWT validado. Nenhuma lógica de
// autenticação nova; nunca retorna JWT, senha ou hash.
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email, role: req.user.role });
});

// ---------------------------------------------------------------
// CLIENTES
// ---------------------------------------------------------------
app.get('/api/clients', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.birth_date, c.marital_status, c.status,
            (SELECT MAX(version) FROM anamneses a WHERE a.client_id = c.id) AS ultima_versao_anamnese,
            (SELECT status FROM anamneses a WHERE a.client_id = c.id ORDER BY version DESC LIMIT 1) AS status_anamnese
     FROM clients c
     WHERE c.professional_id = $1 AND c.organization_id = $2 AND c.status != 'ARCHIVED'
     ORDER BY c.name`, [req.user.professional_id, req.user.organization_id]);
  res.json(rows);
});

app.post('/api/clients', requireAuth, async (req, res) => {
  const { name, birth_date, marital_status, family_members, profiles } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO clients (organization_id, professional_id, name, birth_date, marital_status, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE') RETURNING id`,
      [req.user.organization_id, req.user.professional_id, name, birth_date || null, marital_status || null]);
    const clientId = rows[0].id;

    for (const fm of (family_members || [])) {
      await client.query(
        `INSERT INTO family_members (client_id, relationship, monthly_income, financial_dependency)
         VALUES ($1, $2, $3, $4)`,
        [clientId, fm.relationship, fm.monthly_income || 0, fm.financial_dependency || false]);
    }
    for (const profileType of (profiles || [])) {
      await client.query(
        `INSERT INTO client_profiles (client_id, profile_type, primary_profile, source)
         VALUES ($1, $2, $3, 'PROFISSIONAL')`,
        [clientId, profileType, (profiles[0] === profileType)]);
    }
    await client.query('COMMIT');
    res.status(201).json({ id: clientId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/clients/:id', requireAuth, async (req, res) => {
  const owned = await getOwnedClientOrNull(pool, req.params.id, req.user);
  if (!owned) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { rows } = await pool.query(`SELECT * FROM clients WHERE id = $1`, [req.params.id]);
  const { rows: family } = await pool.query(`SELECT * FROM family_members WHERE client_id = $1`, [req.params.id]);
  const { rows: profiles } = await pool.query(`SELECT * FROM client_profiles WHERE client_id = $1`, [req.params.id]);
  res.json({ ...rows[0], family_members: family, profiles });
});

// ---------------------------------------------------------------
// ANAMNESE — só "iniciar" nesta etapa (perguntas/respostas ficam para a Etapa 2)
// ---------------------------------------------------------------
app.post('/api/clients/:id/anamneses', requireAuth, async (req, res) => {
  const clientId = req.params.id;
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const owned = await getOwnedClientOrNull(dbClient, clientId, req.user);
    if (!owned) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente não encontrado' });
    }

    // Trava por cliente (advisory lock, liberada automaticamente no COMMIT/ROLLBACK)
    // — impede que duas requisições concorrentes leiam o mesmo MAX(version) e
    // tentem inserir a mesma próxima versão. Não requer alterar nenhuma tabela.
    await dbClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [clientId]);

    const { rows: maxV } = await dbClient.query(
      `SELECT COALESCE(MAX(version), 0) AS max_version FROM anamneses WHERE client_id = $1`, [clientId]);
    const nextVersion = maxV[0].max_version + 1;

    const { rows } = await dbClient.query(
      `INSERT INTO anamneses (client_id, version, status) VALUES ($1, $2, 'DRAFT') RETURNING id, version, status`,
      [clientId, nextVersion]);

    await dbClient.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (e) {
    await dbClient.query('ROLLBACK');
    // UNIQUE(client_id, version) do núcleo é a segunda linha de defesa, caso a
    // trava advisory falhe por qualquer motivo — nunca duas versões iguais.
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Conflito de versão — tente novamente' });
    }
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

app.get('/api/clients/:id/anamneses', requireAuth, async (req, res) => {
  const owned = await getOwnedClientOrNull(pool, req.params.id, req.user);
  if (!owned) return res.status(404).json({ error: 'Cliente não encontrado' });

  const { rows } = await pool.query(
    `SELECT id, version, status, created_at FROM anamneses WHERE client_id = $1 ORDER BY version DESC`,
    [req.params.id]);
  res.json(rows);
});

// ======================================================================
// ETAPA 2 — PERGUNTAS, RESPOSTAS, COLETA ESTRUTURADA, EXECUÇÃO
// ======================================================================

// Perguntas aplicáveis a uma anamnese, considerando perfil do cliente
app.get('/api/anamneses/:id/questions', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });

  const { rows: profiles } = await pool.query(
    `SELECT profile_type FROM client_profiles WHERE client_id = $1`, [anamnese.client_id]);
  const profileTypes = profiles.map(p => p.profile_type);

  const { rows: questions } = await pool.query(
    `SELECT q.*, aa.id AS answer_id,
            COALESCE(aa.answer_text, aa.answer_numeric::TEXT, aa.answer_boolean::TEXT, aa.answer_date::TEXT) AS current_answer
     FROM questions q
     LEFT JOIN anamnese_answers aa ON aa.question_id = q.id AND aa.anamnese_id = $1
     WHERE q.status = 'ACTIVE'
       AND (q.profile IS NULL OR q.profile = ANY($2::text[]))
     ORDER BY q.order_number`,
    [req.params.id, profileTypes]);

  // Aplica dependência: pergunta com parent_question_id só entra se a condição bater
  // com a resposta já dada à pergunta-pai (checagem simples, mesmos operadores do motor)
  const byId = Object.fromEntries(questions.map(q => [q.id, q]));
  const applicable = questions.filter(q => {
    if (!q.parent_question_id) return true;
    const parent = byId[q.parent_question_id];
    if (!parent || parent.current_answer === null) return false;
    if (!q.condition) return true;
    const cond = q.condition;
    if (cond.operator === 'EQUAL') return String(parent.current_answer) === String(cond.value);
    return true;
  });

  res.json(applicable);
});

// Responder pergunta — só CAMPO_UNICO grava em campo estruturado aqui.
// TABELA_ESTRUTURADA só registra a resposta bruta (trilha B); o dado
// operacional entra pelos endpoints de coleta dedicados (trilha C).
app.post('/api/anamneses/:id/answers', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  if (anamnese.status === 'COMPLETED') {
    return res.status(409).json({ error: 'Anamnese concluída — não pode mais ser editada. Inicie uma nova versão.' });
  }

  const { question_id, value } = req.body;
  const { rows: qRows } = await pool.query(`SELECT * FROM questions WHERE id = $1`, [question_id]);
  const question = qRows[0];
  if (!question) return res.status(404).json({ error: 'Pergunta não encontrada' });
  if (question.capture_mode === 'PENDENTE_DE_CONFIGURACAO') {
    return res.status(400).json({ error: 'Esta pergunta está PENDENTE_DE_CONFIGURACAO — não pode ser respondida nesta versão.' });
  }

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Trilha B: a resposta bruta é sempre gravada, qualquer que seja o destino
    const col = { TEXT: 'answer_text', SELECT: 'answer_text', TEXTAREA: 'answer_text',
                   NUMBER: 'answer_numeric', CURRENCY: 'answer_numeric',
                   BOOLEAN: 'answer_boolean', DATE: 'answer_date',
                   MULTISELECT: 'answer_json' }[question.question_type] || 'answer_text';
    await dbClient.query(
      `INSERT INTO anamnese_answers (anamnese_id, question_id, ${col}, source)
       VALUES ($1, $2, $3, 'PROFESSIONAL')
       ON CONFLICT (anamnese_id, question_id) DO UPDATE SET ${col} = EXCLUDED.${col}, answered_at = now()`,
      [req.params.id, question_id, col === 'answer_json' ? JSON.stringify(value) : value]);

    // Trilha C: só CAMPO_UNICO grava direto num campo estruturado aqui
    if (question.capture_mode === 'CAMPO_UNICO' && question.target_table && question.target_field) {
      if (question.target_table === 'clients') {
        await dbClient.query(
          `UPDATE clients SET ${question.target_field} = $1 WHERE id = $2`,
          [value, anamnese.client_id]);
      }
    }

    if (anamnese.status === 'DRAFT') {
      await dbClient.query(`UPDATE anamneses SET status='IN_PROGRESS' WHERE id=$1`, [req.params.id]);
    }

    await dbClient.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    dbClient.release();
  }
});

// ---------------------------------------------------------------
// COLETA ESTRUTURADA — um endpoint por tabela, todos INSERT simples,
// todos bloqueados se a última anamnese do cliente já foi executada.
// ---------------------------------------------------------------
function structuredCollectionEndpoint(path, table, columns) {
  app.post(path, requireAuth, async (req, res) => {
    const clientId = req.params.id;
    const owned = await getOwnedClientOrNull(pool, clientId, req.user);
    if (!owned) return res.status(404).json({ error: 'Cliente não encontrado' });
    if (await isClientLatestAnamneseLocked(pool, clientId)) {
      return res.status(409).json({ error: 'A última anamnese deste cliente já foi executada — inicie uma nova versão para alterar dados.' });
    }
    const values = columns.map(c => req.body[c]);
    const placeholders = columns.map((_, i) => `$${i + 2}`).join(', ');
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${table} (client_id, ${columns.join(', ')}) VALUES ($1, ${placeholders}) RETURNING id`,
        [clientId, ...values]);
      res.status(201).json({ id: rows[0].id });
    } catch (e) {
      // Nunca expor stack trace, SQL ou nome de constraint ao cliente — só
      // logar no servidor (visível aqui, não na resposta HTTP) e traduzir
      // para um erro genérico e seguro. Nenhuma regra de negócio nova aqui:
      // apenas classificação de erro de persistência já existente no Postgres.
      console.error(`[${table}] erro de persistência:`, e.message);
      if (e.code === '23502' || e.code === '23514' || e.code === '22P02' || e.code === '23503') {
        // not_null_violation / check_violation / invalid_text_representation / foreign_key_violation
        return res.status(400).json({ error: 'Dados inválidos' });
      }
      if (e.code === '23505') {
        // unique_violation
        return res.status(409).json({ error: 'Conflito de dados' });
      }
      return res.status(500).json({ error: 'Não foi possível salvar. Tente novamente.' });
    }
  });
}
structuredCollectionEndpoint('/api/clients/:id/family-members', 'family_members', ['relationship', 'monthly_income', 'financial_dependency']);
structuredCollectionEndpoint('/api/clients/:id/income-sources', 'income_sources', ['type', 'monthly_value']);
structuredCollectionEndpoint('/api/clients/:id/expenses', 'expenses', ['category', 'monthly_value']);
structuredCollectionEndpoint('/api/clients/:id/assets', 'assets', ['category', 'estimated_value', 'liquidity']);
structuredCollectionEndpoint('/api/clients/:id/liabilities', 'liabilities', ['description', 'balance', 'monthly_payment']);
structuredCollectionEndpoint('/api/clients/:id/objectives', 'objectives', ['category', 'target_value', 'monthly_contribution']);
structuredCollectionEndpoint('/api/clients/:id/investments', 'investments', ['type']);
structuredCollectionEndpoint('/api/clients/:id/businesses', 'businesses', ['name', 'dependency_level', 'continuity_plan', 'succession_plan']);

// ---------------------------------------------------------------
// PROGRESSO — calculado a partir das tabelas estruturadas + respostas,
// nunca de um contador solto que possa dessincronizar
// ---------------------------------------------------------------
async function computeProgress(dbConn, anamneseId) {
  const anamnese = (await dbConn.query(`SELECT * FROM anamneses WHERE id=$1`, [anamneseId])).rows[0];
  const { rows: profiles } = await dbConn.query(
    `SELECT profile_type FROM client_profiles WHERE client_id = $1`, [anamnese.client_id]);
  const profileTypes = profiles.map(p => p.profile_type);

  const { rows: required } = await dbConn.query(
    `SELECT * FROM questions WHERE status='ACTIVE' AND feeds_engine=true AND required=true
       AND (profile IS NULL OR profile = ANY($1::text[]))`, [profileTypes]);

  const missing = [];
  for (const q of required) {
    let satisfied = false;
    if (q.capture_mode === 'CAMPO_UNICO') {
      const { rows } = await dbConn.query(
        `SELECT 1 FROM anamnese_answers WHERE anamnese_id=$1 AND question_id=$2`, [anamneseId, q.id]);
      satisfied = rows.length > 0;
    } else if (q.capture_mode === 'TABELA_ESTRUTURADA') {
      const { rows } = await dbConn.query(
        `SELECT 1 FROM ${q.target_table} WHERE client_id=$1 LIMIT 1`, [anamnese.client_id]);
      satisfied = rows.length > 0;
    }
    if (!satisfied) missing.push(q.question_code);
    else if (satisfied) { /* counted */ }
  }
  const percentage = required.length === 0 ? 100 : Math.round(100 * (required.length - missing.length) / required.length);
  return { total_required: required.length, missing, percentage };
}

app.get('/api/anamneses/:id/progress', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  res.json(await computeProgress(pool, req.params.id));
});

// ---------------------------------------------------------------
// CONCLUIR — só permitido com 100% das obrigatórias atendidas
// ---------------------------------------------------------------
app.post('/api/anamneses/:id/complete', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  if (anamnese.status === 'COMPLETED') return res.status(409).json({ error: 'Já concluída' });

  const progress = await computeProgress(pool, req.params.id);
  if (progress.missing.length > 0) {
    return res.status(400).json({ error: 'Perguntas obrigatórias pendentes', missing: progress.missing });
  }
  await pool.query(`UPDATE anamneses SET status='COMPLETED' WHERE id=$1`, [req.params.id]);
  res.json({ ok: true, status: 'COMPLETED' });
});

// ---------------------------------------------------------------
// EXECUTAR — única ação que chama o núcleo congelado. Nada é
// reimplementado aqui; são exatamente as 2 funções já testadas.
// ---------------------------------------------------------------
app.post('/api/anamneses/:id/execute', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  if (anamnese.status !== 'COMPLETED') {
    return res.status(409).json({ error: 'Anamnese precisa estar CONCLUÍDA antes de executar o diagnóstico' });
  }
  // Trava de aplicação (não altera o núcleo): reexecutar run_full_pipeline numa
  // anamnese já resolvida falha por FK (client_needs -> client_diagnostics sem
  // CASCADE) — achado real, reportado, não corrigido no núcleo. Bloqueamos aqui
  // para nunca expor esse erro 500 ao consultor; a via correta é nova versão.
  if (await isAnamneseLocked(pool, req.params.id)) {
    return res.status(409).json({ error: 'Este diagnóstico já foi executado e não pode ser reexecutado nesta mesma versão. Inicie uma nova versão da anamnese.' });
  }
  await pool.query(`SELECT run_full_pipeline($1, $2)`, [anamnese.client_id, req.params.id]);
  await pool.query(`SELECT resolve_client_recommendations($1, $2)`, [anamnese.client_id, req.params.id]);
  res.json({ ok: true, executed: true });
});

// ---------------------------------------------------------------
// LEITURA DE RESULTADOS — puro SELECT nas tabelas/views já congeladas
// ---------------------------------------------------------------
app.get('/api/anamneses/:id/score', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  const { rows } = await pool.query(
    `SELECT sd.code, cs.dimension_score, cs.is_applicable, cs.overall_score
     FROM client_scores cs LEFT JOIN score_dimensions sd ON sd.id = cs.score_dimension_id
     WHERE cs.anamnese_id = $1 ORDER BY sd.code NULLS FIRST`, [req.params.id]);
  res.json(rows);
});

app.get('/api/anamneses/:id/risks', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  const { rows } = await pool.query(
    `SELECT d.code, d.name, cd.severity, cd.penalty_points
     FROM client_diagnostics cd JOIN knowledge_diagnostics d ON d.id = cd.diagnostic_id
     WHERE cd.anamnese_id = $1 ORDER BY d.code`, [req.params.id]);
  res.json(rows);
});

app.get('/api/anamneses/:id/planning', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  const { rows } = await pool.query(`SELECT * FROM v_client_recommendation_detail WHERE anamnese_id = $1`, [req.params.id]);
  res.json(rows);
});

app.get('/api/anamneses/:id/consolidated', requireAuth, async (req, res) => {
  const anamnese = await getOwnedAnamneseOrNull(pool, req.params.id, req.user);
  if (!anamnese) return res.status(404).json({ error: 'Anamnese não encontrada' });
  const { rows } = await pool.query(`SELECT * FROM v_client_consolidated_recommendations WHERE anamnese_id = $1`, [req.params.id]);
  res.json(rows);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GC Patrimonial API rodando na porta ${PORT}`));

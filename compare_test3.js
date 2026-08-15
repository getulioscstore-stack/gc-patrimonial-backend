const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'gc_patrimonial_app',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const NEW_ANAMNESE_ID = process.argv[2];

// Valores CONGELADOS do Teste 3 original (via SQL direto), já validados em etapas anteriores
const FROZEN = {
  score_geral: 69.0,
  dimensoes: { PROTECAO: 54.5, LIQUIDEZ: 80.0, CONTINUIDADE: 39.5, SUCESSAO: 65.0, APOSENTADORIA: 80.0, DIVERSIFICACAO: 100, ACUMULACAO: 90.0 },
  riscos: ['R01','R06','R09','R10','R11','R12','R16','R17'].sort(),
  necessidades: ['N01','N02','N03','N04','N06'].sort(),
  consolidadas_total: 21,
  convergencia_e01_s01: { prioridade: 'CRITICA', riscos: ['R01','R10'].sort() },
  gap_profissionalizacao: { eh_gap: true, prioridade: 'CRITICA' },
};

async function main() {
  let divergencias = [];

  // 1) SCORE GERAL
  const { rows: overall } = await pool.query(
    `SELECT overall_score FROM client_scores WHERE anamnese_id=$1 AND score_dimension_id IS NULL`, [NEW_ANAMNESE_ID]);
  const scoreGeral = parseFloat(overall[0]?.overall_score);
  if (scoreGeral !== FROZEN.score_geral) divergencias.push(`SCORE GERAL: esperado ${FROZEN.score_geral}, obtido ${scoreGeral}`);

  // 2) 7 DIMENSÕES
  const { rows: dims } = await pool.query(
    `SELECT sd.code, cs.dimension_score FROM client_scores cs
     JOIN score_dimensions sd ON sd.id=cs.score_dimension_id WHERE cs.anamnese_id=$1`, [NEW_ANAMNESE_ID]);
  for (const [code, expected] of Object.entries(FROZEN.dimensoes)) {
    const found = dims.find(d => d.code === code);
    const obtained = found ? parseFloat(found.dimension_score) : null;
    if (obtained !== expected) divergencias.push(`DIMENSAO ${code}: esperado ${expected}, obtido ${obtained}`);
  }

  // 3) RISCOS CONFIRMADOS
  const { rows: risks } = await pool.query(
    `SELECT d.code FROM client_diagnostics cd JOIN knowledge_diagnostics d ON d.id=cd.diagnostic_id
     WHERE cd.anamnese_id=$1 ORDER BY d.code`, [NEW_ANAMNESE_ID]);
  const riskCodes = risks.map(r => r.code).sort();
  if (JSON.stringify(riskCodes) !== JSON.stringify(FROZEN.riscos))
    divergencias.push(`RISCOS: esperado [${FROZEN.riscos}], obtido [${riskCodes}]`);

  // 4) NECESSIDADES
  const { rows: needs } = await pool.query(
    `SELECT DISTINCT n.code FROM client_needs cn JOIN knowledge_needs n ON n.id=cn.need_id
     WHERE cn.anamnese_id=$1 ORDER BY n.code`, [NEW_ANAMNESE_ID]);
  const needCodes = needs.map(n => n.code).sort();
  if (JSON.stringify(needCodes) !== JSON.stringify(FROZEN.necessidades))
    divergencias.push(`NECESSIDADES: esperado [${FROZEN.necessidades}], obtido [${needCodes}]`);

  // 5) TOTAL DE LINHAS CONSOLIDADAS
  const { rows: consCount } = await pool.query(
    `SELECT COUNT(*) FROM v_client_consolidated_recommendations WHERE anamnese_id=$1`, [NEW_ANAMNESE_ID]);
  const totalConsolidadas = parseInt(consCount[0].count);
  if (totalConsolidadas !== FROZEN.consolidadas_total)
    divergencias.push(`LINHAS CONSOLIDADAS: esperado ${FROZEN.consolidadas_total}, obtido ${totalConsolidadas}`);

  // 6) CONVERGÊNCIA E01/S01 (prioridade + riscos convergentes)
  const { rows: conv } = await pool.query(
    `SELECT prioridade_consolidada, riscos_convergentes FROM v_client_consolidated_recommendations
     WHERE anamnese_id=$1 AND estrategia_code='E01' AND solucao_code='S01'`, [NEW_ANAMNESE_ID]);
  if (!conv[0]) {
    divergencias.push('CONVERGENCIA E01/S01: não encontrada');
  } else {
    const riscosConv = conv[0].riscos_convergentes.sort();
    if (conv[0].prioridade_consolidada !== FROZEN.convergencia_e01_s01.prioridade)
      divergencias.push(`CONVERGENCIA E01/S01 prioridade: esperado ${FROZEN.convergencia_e01_s01.prioridade}, obtido ${conv[0].prioridade_consolidada}`);
    if (JSON.stringify(riscosConv) !== JSON.stringify(FROZEN.convergencia_e01_s01.riscos))
      divergencias.push(`CONVERGENCIA E01/S01 riscos: esperado [${FROZEN.convergencia_e01_s01.riscos}], obtido [${riscosConv}]`);
  }

  // 7) GAP PROFISSIONALIZAÇÃO
  const { rows: gap } = await pool.query(
    `SELECT eh_gap, prioridade_consolidada FROM v_client_consolidated_recommendations
     WHERE anamnese_id=$1 AND estrategia_code='E08'`, [NEW_ANAMNESE_ID]);
  if (!gap[0]) {
    divergencias.push('GAP PROFISSIONALIZACAO: não encontrado');
  } else {
    if (gap[0].eh_gap !== FROZEN.gap_profissionalizacao.eh_gap)
      divergencias.push(`GAP eh_gap: esperado ${FROZEN.gap_profissionalizacao.eh_gap}, obtido ${gap[0].eh_gap}`);
    if (gap[0].prioridade_consolidada !== FROZEN.gap_profissionalizacao.prioridade)
      divergencias.push(`GAP prioridade: esperado ${FROZEN.gap_profissionalizacao.prioridade}, obtido ${gap[0].prioridade_consolidada}`);
  }

  console.log('='.repeat(70));
  if (divergencias.length === 0) {
    console.log('EQUIVALÊNCIA CONFIRMADA — todos os níveis batem com o resultado congelado.');
  } else {
    console.log('DIVERGÊNCIA DETECTADA:');
    divergencias.forEach(d => console.log('  - ' + d));
  }
  console.log('='.repeat(70));
  process.exit(divergencias.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });

// Rotas do dashboard - KPIs e métricas

import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'

const dashboard = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/dashboard/overview - Visão geral (Torre de Controle)
dashboard.get('/overview', async (c) => {
  const tenant = c.get('tenant')

  const [
    totalVeiculos,
    veiculosOnline,
    veiculosRisco,
    alertasHoje,
    posicoesHoje,
    eventosRecentes
  ] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as total FROM veiculos WHERE tenant_id = ?')
      .bind(tenant.id).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM veiculos WHERE tenant_id = ? AND status_online = 1`)
      .bind(tenant.id).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM veiculos WHERE tenant_id = ? AND risk_nivel = 'vermelho'`)
      .bind(tenant.id).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM alertas WHERE tenant_id = ? AND lido = 0`)
      .bind(tenant.id).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as total FROM posicoes WHERE tenant_id = ? AND date(data_gps) = date('now')`)
      .bind(tenant.id).first<{ total: number }>(),
    c.env.DB.prepare(`
      SELECT p.evento_nome, p.velocidade, p.risk_score, p.data_gps, v.placa, v.descricao
      FROM posicoes p
      JOIN veiculos v ON v.id = p.veiculo_id
      WHERE p.tenant_id = ? AND p.evento_nome IS NOT NULL AND p.risk_score > 0
      ORDER BY p.data_gps DESC
      LIMIT 20
    `).bind(tenant.id).all()
  ])

  // Score médio da frota
  const scoreFreota = await c.env.DB.prepare(`
    SELECT AVG(risk_score) as score_medio, 
           SUM(CASE WHEN risk_nivel = 'verde' THEN 1 ELSE 0 END) as verde,
           SUM(CASE WHEN risk_nivel = 'amarelo' THEN 1 ELSE 0 END) as amarelo,
           SUM(CASE WHEN risk_nivel = 'vermelho' THEN 1 ELSE 0 END) as vermelho
    FROM veiculos WHERE tenant_id = ?
  `).bind(tenant.id).first<any>()

  return c.json({
    kpis: {
      total_veiculos: totalVeiculos?.total || 0,
      veiculos_online: veiculosOnline?.total || 0,
      veiculos_risco: veiculosRisco?.total || 0,
      alertas_nao_lidos: alertasHoje?.total || 0,
      posicoes_hoje: posicoesHoje?.total || 0,
      score_medio_frota: Math.round(scoreFreota?.score_medio || 0),
      distribuicao_risco: {
        verde: scoreFreota?.verde || 0,
        amarelo: scoreFreota?.amarelo || 0,
        vermelho: scoreFreota?.vermelho || 0
      }
    },
    eventos_recentes: eventosRecentes.results
  })
})

// GET /api/dashboard/ranking - Ranking de risco e performance
dashboard.get('/ranking', async (c) => {
  const tenant = c.get('tenant')
  const tipo = c.req.query('tipo') || 'risco'

  let query = ''

  if (tipo === 'risco') {
    query = `
      SELECT v.id, v.placa, v.descricao, v.frota, v.risk_score, v.risk_nivel, v.status_online,
        AVG(p.risk_score) as score_medio_dia,
        COUNT(p.id) as total_eventos_dia,
        MAX(p.velocidade) as pico_velocidade
      FROM veiculos v
      LEFT JOIN posicoes p ON p.veiculo_id = v.id AND date(p.data_gps) = date('now')
      WHERE v.tenant_id = ?
      GROUP BY v.id
      ORDER BY v.risk_score DESC, score_medio_dia DESC
      LIMIT 20
    `
  } else if (tipo === 'velocidade') {
    query = `
      SELECT v.id, v.placa, v.descricao, v.frota, v.risk_score, v.risk_nivel,
        MAX(p.velocidade) as pico_velocidade,
        AVG(p.velocidade) as velocidade_media,
        COUNT(CASE WHEN p.velocidade > 80 THEN 1 END) as momentos_excesso
      FROM veiculos v
      LEFT JOIN posicoes p ON p.veiculo_id = v.id AND date(p.data_gps) = date('now')
      WHERE v.tenant_id = ?
      GROUP BY v.id
      ORDER BY pico_velocidade DESC
      LIMIT 20
    `
  } else if (tipo === 'ociosidade') {
    query = `
      SELECT v.id, v.placa, v.descricao, v.frota,
        SUM(CASE WHEN p.ignicao = 1 AND p.velocidade = 0 THEN 1 ELSE 0 END) as minutos_ocioso,
        SUM(CASE WHEN p.ignicao = 1 THEN 1 ELSE 0 END) as minutos_ligado,
        AVG(p.risk_score) as score_medio
      FROM veiculos v
      LEFT JOIN posicoes p ON p.veiculo_id = v.id AND date(p.data_gps) = date('now')
      WHERE v.tenant_id = ?
      GROUP BY v.id
      ORDER BY minutos_ocioso DESC
      LIMIT 20
    `
  }

  const rows = await c.env.DB.prepare(query).bind(tenant.id).all()
  return c.json({ ranking: rows.results, tipo })
})

// GET /api/dashboard/timeline - Timeline de eventos do dia
dashboard.get('/timeline', async (c) => {
  const tenant = c.get('tenant')
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200)

  const eventos = await c.env.DB.prepare(`
    SELECT p.id, p.evento_nome, p.velocidade, p.risk_score, p.data_gps, 
           p.latitude, p.longitude, p.endereco, p.motorista_nome, p.ignicao,
           v.placa, v.descricao, v.risk_nivel
    FROM posicoes p
    JOIN veiculos v ON v.id = p.veiculo_id
    WHERE p.tenant_id = ? AND p.evento_nome IS NOT NULL
    ORDER BY p.data_gps DESC
    LIMIT ?
  `).bind(tenant.id, limit).all()

  return c.json({ eventos: eventos.results })
})

// GET /api/dashboard/alertas - Alertas não lidos
dashboard.get('/alertas', async (c) => {
  const tenant = c.get('tenant')
  
  const alertas = await c.env.DB.prepare(`
    SELECT a.*, v.placa, v.descricao
    FROM alertas a
    JOIN veiculos v ON v.id = a.veiculo_id
    WHERE a.tenant_id = ?
    ORDER BY a.data_alerta DESC
    LIMIT 50
  `).bind(tenant.id).all()

  return c.json({ alertas: alertas.results })
})

// POST /api/dashboard/alertas/:id/lido
dashboard.post('/alertas/:id/lido', async (c) => {
  const tenant = c.get('tenant')
  const id = c.req.param('id')

  await c.env.DB.prepare(
    'UPDATE alertas SET lido = 1 WHERE id = ? AND tenant_id = ?'
  ).bind(id, tenant.id).run()

  return c.json({ ok: true })
})

// GET /api/dashboard/stats-hora - Atividade por hora do dia
dashboard.get('/stats-hora', async (c) => {
  const tenant = c.get('tenant')

  const stats = await c.env.DB.prepare(`
    SELECT 
      strftime('%H', data_gps) as hora,
      COUNT(*) as total,
      AVG(velocidade) as vel_media,
      AVG(risk_score) as score_medio,
      COUNT(CASE WHEN risk_score >= 61 THEN 1 END) as alertas
    FROM posicoes
    WHERE tenant_id = ? AND date(data_gps) = date('now')
    GROUP BY hora
    ORDER BY hora
  `).bind(tenant.id).all()

  return c.json({ stats: stats.results })
})

export default dashboard

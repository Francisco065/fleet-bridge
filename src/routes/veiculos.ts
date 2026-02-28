// Rotas de veículos

import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'

const veiculos = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/veiculos/mapa/posicoes - Posições atuais para o mapa
veiculos.get('/mapa/posicoes', async (c) => {
  const tenant = c.get('tenant')

  // Última posição de cada veículo
  const rows = await c.env.DB.prepare(`
    SELECT v.id, v.placa, v.descricao, v.modelo, v.marca, v.risk_score, v.risk_nivel, v.status_online, v.frota,
      p.latitude, p.longitude, p.velocidade, p.proa, p.endereco, p.evento_nome, p.motorista_nome,
      p.ignicao, p.data_gps, p.created_at
    FROM veiculos v
    LEFT JOIN posicoes p ON p.id = (
      SELECT id FROM posicoes 
      WHERE veiculo_id = v.id AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    )
    WHERE v.tenant_id = ?
    ORDER BY v.risk_score DESC
  `).bind(tenant.id).all()

  return c.json({ veiculos: rows.results })
})

// GET /api/veiculos - Listar todos os veículos do tenant
veiculos.get('/', async (c) => {
  const tenant = c.get('tenant')
  
  const rows = await c.env.DB.prepare(`
    SELECT v.*,
      (SELECT COUNT(*) FROM posicoes p WHERE p.veiculo_id = v.id AND date(p.data_gps) = date('now')) as posicoes_hoje,
      (SELECT MAX(p.velocidade) FROM posicoes p WHERE p.veiculo_id = v.id AND date(p.data_gps) = date('now')) as pico_velocidade_hoje,
      (SELECT SUM(
        CASE WHEN p.ignicao = 1 THEN 1 ELSE 0 END
      ) * 1.0 / 60 FROM posicoes p WHERE p.veiculo_id = v.id AND date(p.data_gps) = date('now')) as horas_ignicao_hoje
    FROM veiculos v
    WHERE v.tenant_id = ?
    ORDER BY v.risk_score DESC, v.status_online DESC
  `).bind(tenant.id).all()

  return c.json({ veiculos: rows.results })
})

// GET /api/veiculos/:id - Detalhes de um veículo
veiculos.get('/:id', async (c) => {
  const tenant = c.get('tenant')
  const id = c.req.param('id')

  const veiculo = await c.env.DB.prepare(
    'SELECT * FROM veiculos WHERE id = ? AND tenant_id = ?'
  ).bind(id, tenant.id).first()

  if (!veiculo) return c.json({ error: 'Veículo não encontrado' }, 404)

  // Últimas 50 posições
  const posicoes = await c.env.DB.prepare(`
    SELECT * FROM posicoes 
    WHERE veiculo_id = ? AND tenant_id = ?
    ORDER BY data_gps DESC 
    LIMIT 50
  `).bind(id, tenant.id).all()

  // Última posição
  const ultimaPosicao = posicoes.results[0] || null

  return c.json({ veiculo, ultimaPosicao, posicoes: posicoes.results })
})

// GET /api/veiculos/:id/posicoes - Histórico de posições
veiculos.get('/:id/posicoes', async (c) => {
  const tenant = c.get('tenant')
  const id = c.req.param('id')
  const { data_inicio, data_fim, limit = '200' } = c.req.query()

  let query = `
    SELECT * FROM posicoes 
    WHERE veiculo_id = ? AND tenant_id = ?
  `
  const params: any[] = [id, tenant.id]

  if (data_inicio) {
    query += ' AND data_gps >= ?'
    params.push(data_inicio)
  }
  if (data_fim) {
    query += ' AND data_gps <= ?'
    params.push(data_fim)
  }

  query += ` ORDER BY data_gps DESC LIMIT ${Math.min(parseInt(limit), 1000)}`

  const rows = await c.env.DB.prepare(query).bind(...params).all()
  return c.json({ posicoes: rows.results })
})

// GET /api/veiculos/:id/indicadores - Indicadores do dia
veiculos.get('/:id/indicadores', async (c) => {
  const tenant = c.get('tenant')
  const id = c.req.param('id')

  const indicadores = await c.env.DB.prepare(`
    SELECT 
      COUNT(*) as total_posicoes,
      MAX(velocidade) as pico_velocidade,
      AVG(velocidade) as velocidade_media,
      AVG(risk_score) as score_medio,
      SUM(CASE WHEN ignicao = 1 THEN 1 ELSE 0 END) as momentos_ligado,
      SUM(CASE WHEN ignicao = 0 AND velocidade = 0 THEN 1 ELSE 0 END) as momentos_parado,
      COUNT(DISTINCT evento_nome) as tipos_eventos,
      SUM(CASE WHEN risk_score >= 61 THEN 1 ELSE 0 END) as momentos_risco_alto
    FROM posicoes 
    WHERE veiculo_id = ? AND tenant_id = ? AND date(data_gps) = date('now')
  `).bind(id, tenant.id).first<any>()

  // Estimar km rodado (contando posições em movimento)
  const kmEstimado = Math.round((indicadores?.total_posicoes || 0) * 0.033) // aprox

  return c.json({
    ...indicadores,
    km_estimado: kmEstimado
  })
})

export default veiculos

// Rotas de sincronização e configurações

import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { getValidToken, fetchVeiculos, fetchEventos, fetchMotoristas, loginMultiportal } from '../services/multiportal'
import { coletarDadosTenant } from '../services/worker'

const sync = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// POST /api/sync/test-connection - Testar credenciais Multiportal
sync.post('/test-connection', async (c) => {
  const { username, password, appid } = await c.req.json()

  const result = await loginMultiportal(username, password, appid || 'portal')

  if (result) {
    return c.json({ ok: true, message: 'Conexão com Multiportal estabelecida com sucesso!' })
  }

  return c.json({ ok: false, message: 'Falha na conexão. Verifique as credenciais e se seu IP está liberado.' }, 400)
})

// POST /api/sync/credentials - Salvar credenciais Multiportal
sync.post('/credentials', async (c) => {
  const tenant = c.get('tenant')
  const { username, password, appid } = await c.req.json()

  await c.env.DB.prepare(`
    UPDATE tenants SET 
      multiportal_username = ?, 
      multiportal_password = ?,
      multiportal_appid = ?,
      multiportal_token = NULL,
      multiportal_token_expiracao = NULL
    WHERE id = ?
  `).bind(username, password, appid || 'portal', tenant.id).run()

  return c.json({ ok: true, message: 'Credenciais salvas com sucesso!' })
})

// POST /api/sync/veiculos - Sincronizar veículos da Multiportal
sync.post('/veiculos', async (c) => {
  const tenant = c.get('tenant')

  const token = await getValidToken(c.env.DB, tenant)
  if (!token) {
    return c.json({ error: 'Falha ao obter token Multiportal. Verifique as credenciais.' }, 400)
  }

  const veiculos = await fetchVeiculos(token)
  if (!veiculos) {
    return c.json({ error: 'Erro ao buscar veículos da Multiportal' }, 500)
  }

  let criados = 0, atualizados = 0

  for (const v of veiculos) {
    const existing = await c.env.DB.prepare(
      'SELECT id FROM veiculos WHERE tenant_id = ? AND id_multiportal = ?'
    ).bind(tenant.id, String(v.id)).first()

    if (existing) {
      await c.env.DB.prepare(`
        UPDATE veiculos SET 
          placa = ?, modelo = ?, marca = ?, cor = ?, descricao = ?, frota = ?,
          odometro_gps = ?, km_atual = ?
        WHERE tenant_id = ? AND id_multiportal = ?
      `).bind(
        v.placa || '', v.modelo || '', v.marca || '', v.cor || '',
        v.descricao || '', v.frota || '',
        v.odometroGps || 0, v.kmAtual || 0,
        tenant.id, String(v.id)
      ).run()
      atualizados++
    } else {
      await c.env.DB.prepare(`
        INSERT INTO veiculos (tenant_id, id_multiportal, placa, modelo, marca, cor, descricao, frota, odometro_gps, km_atual)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        tenant.id, String(v.id),
        v.placa || '', v.modelo || '', v.marca || '', v.cor || '',
        v.descricao || '', v.frota || '',
        v.odometroGps || 0, v.kmAtual || 0
      ).run()
      criados++
    }
  }

  return c.json({
    ok: true,
    message: `Sincronização concluída: ${criados} criados, ${atualizados} atualizados`,
    total: veiculos.length,
    criados,
    atualizados
  })
})

// POST /api/sync/eventos - Sincronizar eventos/catálogo
sync.post('/eventos', async (c) => {
  const tenant = c.get('tenant')

  const token = await getValidToken(c.env.DB, tenant)
  if (!token) return c.json({ error: 'Token inválido' }, 400)

  const eventos = await fetchEventos(token)
  if (!eventos) return c.json({ error: 'Erro ao buscar eventos' }, 500)

  let criados = 0
  for (const ev of eventos) {
    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO eventos (tenant_id, id_multiportal, nome, peso_risco, categoria, cor, icone)
      VALUES (?, ?, ?, 10, 'info', '#6b7280', 'fas fa-info-circle')
    `).bind(tenant.id, String(ev.id), ev.nome || 'Evento').run()
    criados++
  }

  return c.json({ ok: true, total: eventos.length, criados })
})

// POST /api/sync/motoristas - Sincronizar motoristas
sync.post('/motoristas', async (c) => {
  const tenant = c.get('tenant')

  const token = await getValidToken(c.env.DB, tenant)
  if (!token) return c.json({ error: 'Token inválido' }, 400)

  const motoristas = await fetchMotoristas(token)
  if (!motoristas) return c.json({ error: 'Erro ao buscar motoristas' }, 500)

  let criados = 0
  for (const m of motoristas) {
    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO motoristas (tenant_id, id_multiportal, nome, ibutton, cnh_numero, cnh_categoria, cpf, email, matricula)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tenant.id, String(m.id),
      m.nome || '', m.ibutton || '',
      m.cnh_numero || '', m.cnh_categoria || '',
      m.cpf || '', m.email || '', m.matricula || ''
    ).run()
    criados++
  }

  return c.json({ ok: true, total: motoristas.length, criados })
})

// POST /api/sync/coletar - Forçar coleta manual
sync.post('/coletar', async (c) => {
  const tenant = c.get('tenant')

  const result = await coletarDadosTenant(c.env.DB, tenant)

  return c.json({
    ok: result.status !== 'erro',
    ...result
  })
})

// GET /api/sync/logs - Logs de coleta
sync.get('/logs', async (c) => {
  const tenant = c.get('tenant')

  const logs = await c.env.DB.prepare(`
    SELECT * FROM logs_coleta 
    WHERE tenant_id = ? 
    ORDER BY created_at DESC 
    LIMIT 50
  `).bind(tenant.id).all()

  return c.json({ logs: logs.results })
})

export default sync

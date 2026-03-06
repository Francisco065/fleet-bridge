// Rotas de administração - Gestão de Clientes (Tenants)
// Requer perfil superadmin

import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { hashPassword } from '../utils/helpers'

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ============================================================
// CLIENTES (TENANTS)
// ============================================================

// GET /api/admin/clientes - Listar todos os clientes
admin.get('/clientes', async (c) => {
  try {
    const { search, status, plano, page, limit: limitQ } = c.req.query()
    const pageNum  = Math.max(1, parseInt(page  || '1'))
    const pageSize = Math.min(100, parseInt(limitQ || '20'))
    const offset   = (pageNum - 1) * pageSize

    let where = '1=1'
    const params: any[] = []

    if (search) {
      where += ' AND (t.nome_empresa LIKE ? OR t.email_admin LIKE ? OR t.cnpj LIKE ? OR t.responsavel_nome LIKE ?)'
      const q = '%' + search + '%'
      params.push(q, q, q, q)
    }
    if (status) { where += ' AND t.status = ?'; params.push(status) }
    if (plano)  { where += ' AND t.plano = ?';  params.push(plano) }

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as total FROM tenants t WHERE ${where}`
    ).bind(...params).first<any>()

    const rows = await c.env.DB.prepare(`
      SELECT
        t.*,
        (SELECT COUNT(*) FROM usuarios u WHERE u.tenant_id = t.id AND u.ativo = 1) as total_usuarios,
        (SELECT COUNT(*) FROM veiculos  v WHERE v.tenant_id = t.id) as total_veiculos,
        (SELECT MAX(created_at) FROM logs_coleta l WHERE l.tenant_id = t.id) as ultimo_acesso
      FROM tenants t
      WHERE ${where}
      ORDER BY t.criado_em DESC
      LIMIT ? OFFSET ?
    `).bind(...params, pageSize, offset).all<any>()

    // Remover campos sensíveis
    const clientes = rows.results.map(({ senha_hash, multiportal_password, multiportal_token, ...safe }: any) => safe)

    return c.json({
      clientes,
      pagination: {
        total: countRow?.total || 0,
        page: pageNum,
        limit: pageSize,
        pages: Math.ceil((countRow?.total || 0) / pageSize)
      }
    })
  } catch (err) {
    console.error('[Admin] Erro ao listar clientes:', err)
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// GET /api/admin/clientes/:id - Detalhe de um cliente
admin.get('/clientes/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const tenant = await c.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ?'
    ).bind(id).first<any>()

    if (!tenant) return c.json({ error: 'Cliente não encontrado' }, 404)

    const { senha_hash, multiportal_password, multiportal_token, ...safe } = tenant

    // Buscar usuários do tenant
    const usuarios = await c.env.DB.prepare(
      'SELECT id, nome, email, perfil, ativo, ultimo_login, criado_em FROM usuarios WHERE tenant_id = ? ORDER BY criado_em'
    ).bind(id).all<any>()

    // Stats
    const stats = await c.env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM veiculos  WHERE tenant_id = ?) as total_veiculos,
        (SELECT COUNT(*) FROM motoristas WHERE tenant_id = ?) as total_motoristas,
        (SELECT COUNT(*) FROM posicoes   WHERE tenant_id = ? AND date(created_at) = date('now')) as posicoes_hoje,
        (SELECT COUNT(*) FROM logs_coleta WHERE tenant_id = ? AND status = 'ok') as coletas_ok,
        (SELECT MAX(created_at) FROM logs_coleta WHERE tenant_id = ?) as ultima_coleta
    `).bind(id, id, id, id, id).first<any>()

    return c.json({ cliente: safe, usuarios: usuarios.results, stats })
  } catch (err) {
    console.error('[Admin] Erro ao buscar cliente:', err)
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// POST /api/admin/clientes - Criar novo cliente
admin.post('/clientes', async (c) => {
  try {
    const body = await c.req.json()
    const {
      nome_empresa, email_admin, senha,
      cnpj, telefone,
      responsavel_nome, responsavel_cargo, responsavel_telefone,
      endereco_logradouro, endereco_numero, endereco_complemento,
      endereco_bairro, endereco_cidade, endereco_uf, endereco_cep,
      plano, qtd_veiculos_contrato, data_contrato, data_vencimento,
      observacoes,
      // Dados do usuário admin
      admin_nome
    } = body

    if (!nome_empresa || !email_admin || !senha) {
      return c.json({ error: 'nome_empresa, email_admin e senha são obrigatórios' }, 400)
    }

    // Validar email único
    const existe = await c.env.DB.prepare(
      'SELECT id FROM tenants WHERE email_admin = ?'
    ).bind(email_admin.toLowerCase().trim()).first()
    if (existe) return c.json({ error: 'E-mail já cadastrado' }, 409)

    const senhaHash = await hashPassword(senha)
    const planoFinal = plano || 'basico'

    // Criar tenant
    const result = await c.env.DB.prepare(`
      INSERT INTO tenants (
        nome_empresa, email_admin, senha_hash,
        cnpj, telefone,
        responsavel_nome, responsavel_cargo, responsavel_telefone,
        endereco_logradouro, endereco_numero, endereco_complemento,
        endereco_bairro, endereco_cidade, endereco_uf, endereco_cep,
        plano, qtd_veiculos_contrato, data_contrato, data_vencimento,
        observacoes, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ativo')
    `).bind(
      nome_empresa.trim(), email_admin.toLowerCase().trim(), senhaHash,
      cnpj || null, telefone || null,
      responsavel_nome || null, responsavel_cargo || null, responsavel_telefone || null,
      endereco_logradouro || null, endereco_numero || null, endereco_complemento || null,
      endereco_bairro || null, endereco_cidade || null, endereco_uf || null, endereco_cep || null,
      planoFinal,
      qtd_veiculos_contrato || 0,
      data_contrato || null, data_vencimento || null,
      observacoes || null
    ).run()

    const tenantId = result.meta.last_row_id as number

    // Criar usuário admin do tenant
    await c.env.DB.prepare(`
      INSERT INTO usuarios (tenant_id, nome, email, senha_hash, perfil)
      VALUES (?, ?, ?, ?, 'admin')
    `).bind(tenantId, admin_nome || responsavel_nome || nome_empresa, email_admin.toLowerCase().trim(), senhaHash).run()

    // Criar eventos padrão para o tenant
    const eventos = [
      ['1','Ignição Ligada',0,'info'],['2','Ignição Desligada',0,'info'],
      ['3','Excesso de Velocidade',35,'critico'],['4','Frenagem Brusca',25,'alerta'],
      ['5','Curva Agressiva',20,'alerta'],['6','Aceleração Brusca',20,'alerta'],
      ['7','Veículo Parado',5,'info'],['8','Saída de Cerca',30,'critico'],
      ['9','Entrada de Cerca',5,'info'],['10','Pânico',50,'critico'],
      ['11','Bateria Baixa',15,'alerta'],['12','Jammer',40,'critico'],
    ]
    for (const [eid, nome, peso, cat] of eventos) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO eventos (tenant_id,id_multiportal,nome,peso_risco,categoria) VALUES (?,?,?,?,?)`
      ).bind(tenantId, eid, nome, peso, cat).run()
    }

    return c.json({
      message: 'Cliente criado com sucesso!',
      tenant_id: tenantId,
      email_admin: email_admin.toLowerCase().trim(),
      plano: planoFinal
    }, 201)
  } catch (err) {
    console.error('[Admin] Erro ao criar cliente:', err)
    return c.json({ error: 'Erro ao criar cliente: ' + String(err) }, 500)
  }
})

// PUT /api/admin/clientes/:id - Atualizar cliente
admin.put('/clientes/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const body = await c.req.json()

    const existe = await c.env.DB.prepare('SELECT id FROM tenants WHERE id = ?').bind(id).first()
    if (!existe) return c.json({ error: 'Cliente não encontrado' }, 404)

    const campos: string[] = []
    const valores: any[]   = []

    const editaveis = [
      'nome_empresa','cnpj','telefone',
      'responsavel_nome','responsavel_cargo','responsavel_telefone',
      'endereco_logradouro','endereco_numero','endereco_complemento',
      'endereco_bairro','endereco_cidade','endereco_uf','endereco_cep',
      'plano','qtd_veiculos_contrato','data_contrato','data_vencimento',
      'observacoes','status','logo_url',
      'multiportal_username','multiportal_appid'
    ]

    for (const campo of editaveis) {
      if (body[campo] !== undefined) {
        campos.push(`${campo} = ?`)
        valores.push(body[campo])
      }
    }

    // Atualizar senha se fornecida
    if (body.nova_senha) {
      campos.push('senha_hash = ?')
      valores.push(await hashPassword(body.nova_senha))
    }

    if (campos.length === 0) return c.json({ error: 'Nenhum campo para atualizar' }, 400)

    campos.push('atualizado_em = datetime(\'now\')')
    valores.push(id)

    await c.env.DB.prepare(
      `UPDATE tenants SET ${campos.join(', ')} WHERE id = ?`
    ).bind(...valores).run()

    return c.json({ message: 'Cliente atualizado com sucesso!' })
  } catch (err) {
    console.error('[Admin] Erro ao atualizar cliente:', err)
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// DELETE /api/admin/clientes/:id - Desativar cliente (soft delete)
admin.delete('/clientes/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    if (id === 1) return c.json({ error: 'Não é possível desativar o tenant demo' }, 403)

    await c.env.DB.prepare(
      `UPDATE tenants SET status = 'inativo', atualizado_em = datetime('now') WHERE id = ?`
    ).bind(id).run()

    return c.json({ message: 'Cliente desativado com sucesso!' })
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// POST /api/admin/clientes/:id/reativar
admin.post('/clientes/:id/reativar', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    await c.env.DB.prepare(
      `UPDATE tenants SET status = 'ativo', atualizado_em = datetime('now') WHERE id = ?`
    ).bind(id).run()
    return c.json({ message: 'Cliente reativado!' })
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// ============================================================
// USUÁRIOS DO TENANT
// ============================================================

// GET /api/admin/clientes/:id/usuarios
admin.get('/clientes/:id/usuarios', async (c) => {
  try {
    const tenantId = parseInt(c.req.param('id'))
    const rows = await c.env.DB.prepare(
      'SELECT id, nome, email, perfil, ativo, ultimo_login, criado_em FROM usuarios WHERE tenant_id = ? ORDER BY criado_em'
    ).bind(tenantId).all<any>()
    return c.json({ usuarios: rows.results })
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// POST /api/admin/clientes/:id/usuarios - Criar usuário para tenant
admin.post('/clientes/:id/usuarios', async (c) => {
  try {
    const tenantId = parseInt(c.req.param('id'))
    const { nome, email, senha, perfil } = await c.req.json()

    if (!nome || !email || !senha) {
      return c.json({ error: 'nome, email e senha são obrigatórios' }, 400)
    }

    const existe = await c.env.DB.prepare('SELECT id FROM usuarios WHERE email = ?').bind(email.toLowerCase()).first()
    if (existe) return c.json({ error: 'E-mail já cadastrado' }, 409)

    const senhaHash = await hashPassword(senha)
    const result = await c.env.DB.prepare(
      `INSERT INTO usuarios (tenant_id, nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?, ?)`
    ).bind(tenantId, nome, email.toLowerCase(), senhaHash, perfil || 'operador').run()

    return c.json({ message: 'Usuário criado!', id: result.meta.last_row_id }, 201)
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// PUT /api/admin/usuarios/:id - Atualizar usuário
admin.put('/usuarios/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const { nome, perfil, ativo, nova_senha } = await c.req.json()

    const campos: string[] = []
    const valores: any[]   = []

    if (nome       !== undefined) { campos.push('nome = ?');      valores.push(nome) }
    if (perfil     !== undefined) { campos.push('perfil = ?');    valores.push(perfil) }
    if (ativo      !== undefined) { campos.push('ativo = ?');     valores.push(ativo ? 1 : 0) }
    if (nova_senha !== undefined) { campos.push('senha_hash = ?'); valores.push(await hashPassword(nova_senha)) }

    if (campos.length === 0) return c.json({ error: 'Nenhum campo para atualizar' }, 400)

    valores.push(id)
    await c.env.DB.prepare(`UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`).bind(...valores).run()

    return c.json({ message: 'Usuário atualizado!' })
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// DELETE /api/admin/usuarios/:id
admin.delete('/usuarios/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    await c.env.DB.prepare('UPDATE usuarios SET ativo = 0 WHERE id = ?').bind(id).run()
    return c.json({ message: 'Usuário desativado!' })
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// ============================================================
// PLANOS
// ============================================================
admin.get('/planos', async (c) => {
  try {
    const rows = await c.env.DB.prepare('SELECT * FROM planos WHERE ativo = 1 ORDER BY preco_mensal').all<any>()
    return c.json({ planos: rows.results })
  } catch (err) {
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// ============================================================
// DASHBOARD DO ADMIN - Métricas gerais
// ============================================================
admin.get('/dashboard', async (c) => {
  try {
    const stats = await c.env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tenants WHERE status = 'ativo')     as clientes_ativos,
        (SELECT COUNT(*) FROM tenants WHERE status = 'inativo')   as clientes_inativos,
        (SELECT COUNT(*) FROM tenants)                            as total_clientes,
        (SELECT COUNT(*) FROM usuarios WHERE ativo = 1)           as total_usuarios,
        (SELECT COUNT(*) FROM veiculos)                           as total_veiculos,
        (SELECT COUNT(*) FROM posicoes WHERE date(created_at) = date('now')) as posicoes_hoje,
        (SELECT COUNT(*) FROM tenants WHERE date(criado_em) >= date('now','-30 days')) as novos_30d
    `).first<any>()

    // Crescimento por mês (últimos 6 meses)
    const crescimento = await c.env.DB.prepare(`
      SELECT
        strftime('%Y-%m', criado_em) as mes,
        COUNT(*) as novos_clientes
      FROM tenants
      WHERE criado_em >= date('now', '-6 months')
      GROUP BY mes
      ORDER BY mes
    `).all<any>()

    // Distribuição por plano
    const porPlano = await c.env.DB.prepare(`
      SELECT plano, COUNT(*) as total
      FROM tenants
      WHERE status = 'ativo'
      GROUP BY plano
    `).all<any>()

    // Últimos clientes cadastrados
    const ultimosClientes = await c.env.DB.prepare(`
      SELECT id, nome_empresa, email_admin, plano, status, criado_em
      FROM tenants
      ORDER BY criado_em DESC
      LIMIT 5
    `).all<any>()

    return c.json({
      stats,
      crescimento: crescimento.results,
      por_plano: porPlano.results,
      ultimos_clientes: ultimosClientes.results
    })
  } catch (err) {
    console.error('[Admin] Erro dashboard:', err)
    return c.json({ error: 'Erro interno' }, 500)
  }
})

export default admin

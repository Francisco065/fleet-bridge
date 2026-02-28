// Rotas de autenticação - Login, Logout, Registro

import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { hashPassword, verifyPassword, generateJWT } from '../utils/helpers'

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// POST /api/auth/login
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json()
    const { email, senha } = body

    if (!email || !senha) {
      return c.json({ error: 'Email e senha são obrigatórios' }, 400)
    }

    // Buscar usuário no banco
    const usuario = await c.env.DB.prepare(
      `SELECT u.*, t.nome_empresa, t.status as tenant_status 
       FROM usuarios u 
       JOIN tenants t ON t.id = u.tenant_id 
       WHERE u.email = ? AND u.ativo = 1`
    ).bind(email.toLowerCase().trim()).first<any>()

    if (!usuario) {
      return c.json({ error: 'Credenciais inválidas' }, 401)
    }

    if (usuario.tenant_status !== 'ativo') {
      return c.json({ error: 'Conta da empresa suspensa' }, 401)
    }

    // Verificar senha (suporte a hash SHA256 e senha demo direta)
    const senhaValida = await verifyPassword(senha, usuario.senha_hash) ||
      senha === usuario.senha_hash // suporte demo

    if (!senhaValida) {
      return c.json({ error: 'Credenciais inválidas' }, 401)
    }

    // Gerar JWT
    const secret = c.env.JWT_SECRET || 'fleetbridge_jwt_secret_2024'
    const token = await generateJWT(
      {
        sub: String(usuario.id),
        tid: usuario.tenant_id,
        email: usuario.email,
        nome: usuario.nome,
        perfil: usuario.perfil,
        empresa: usuario.nome_empresa
      },
      secret,
      24
    )

    // Atualizar último login
    await c.env.DB.prepare(
      'UPDATE usuarios SET ultimo_login = datetime("now") WHERE id = ?'
    ).bind(usuario.id).run()

    return c.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        empresa: usuario.nome_empresa,
        tenant_id: usuario.tenant_id
      }
    })
  } catch (err) {
    console.error('[Auth] Erro no login:', err)
    return c.json({ error: 'Erro interno no servidor' }, 500)
  }
})

// POST /api/auth/register - Criar novo tenant
auth.post('/register', async (c) => {
  try {
    const body = await c.req.json()
    const { nome_empresa, email, senha, multiportal_username, multiportal_password, multiportal_appid } = body

    if (!nome_empresa || !email || !senha) {
      return c.json({ error: 'Campos obrigatórios: nome_empresa, email, senha' }, 400)
    }

    // Verificar se email já existe
    const existente = await c.env.DB.prepare(
      'SELECT id FROM usuarios WHERE email = ?'
    ).bind(email.toLowerCase()).first()

    if (existente) {
      return c.json({ error: 'Email já cadastrado' }, 409)
    }

    const senhaHash = await hashPassword(senha)

    // Criar tenant
    const tenantResult = await c.env.DB.prepare(`
      INSERT INTO tenants (nome_empresa, email_admin, senha_hash, multiportal_username, multiportal_password, multiportal_appid, status, plano)
      VALUES (?, ?, ?, ?, ?, ?, 'ativo', 'basico')
    `).bind(
      nome_empresa,
      email.toLowerCase(),
      senhaHash,
      multiportal_username || null,
      multiportal_password || null,
      multiportal_appid || 'portal'
    ).run()

    const tenantId = tenantResult.meta.last_row_id as number

    // Criar usuário admin
    await c.env.DB.prepare(`
      INSERT INTO usuarios (tenant_id, nome, email, senha_hash, perfil)
      VALUES (?, ?, ?, ?, 'admin')
    `).bind(tenantId, nome_empresa, email.toLowerCase(), senhaHash).run()

    return c.json({ 
      message: 'Conta criada com sucesso!',
      tenant_id: tenantId
    }, 201)
  } catch (err) {
    console.error('[Auth] Erro no registro:', err)
    return c.json({ error: 'Erro ao criar conta' }, 500)
  }
})

// GET /api/auth/me
auth.get('/me', async (c) => {
  const payload = c.get('jwtPayload')
  if (!payload) return c.json({ error: 'Não autenticado' }, 401)
  return c.json({ usuario: payload })
})

export default auth

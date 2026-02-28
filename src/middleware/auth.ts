// Middleware de autenticação JWT

import { createMiddleware } from 'hono/factory'
import type { Bindings, Variables } from '../types'
import { verifyJWT } from '../utils/helpers'

export const authMiddleware = createMiddleware<{ Bindings: Bindings; Variables: Variables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')
    const cookieToken = getCookieValue(c.req.raw, 'fleet_token')
    const token = authHeader?.replace('Bearer ', '') || cookieToken

    if (!token) {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Token de autenticação necessário' }, 401)
      }
      return c.redirect('/login')
    }

    const secret = c.env.JWT_SECRET || 'fleetbridge_jwt_secret_2024'
    const payload = await verifyJWT(token, secret)

    if (!payload) {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Token inválido ou expirado' }, 401)
      }
      return c.redirect('/login')
    }

    // Verificar tenant no banco
    const tenant = await c.env.DB.prepare(
      'SELECT * FROM tenants WHERE id = ? AND status = ?'
    ).bind(payload.tid, 'ativo').first()

    if (!tenant) {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Tenant não encontrado ou inativo' }, 401)
      }
      return c.redirect('/login')
    }

    c.set('jwtPayload', payload as any)
    c.set('tenant', tenant as any)

    await next()
  }
)

// Middleware de autorização por perfil
export function requirePerfil(...perfis: string[]) {
  return createMiddleware<{ Bindings: Bindings; Variables: Variables }>(
    async (c, next) => {
      const payload = c.get('jwtPayload')
      if (!payload || !perfis.includes(payload.perfil)) {
        if (c.req.path.startsWith('/api/')) {
          return c.json({ error: 'Acesso não autorizado para este perfil' }, 403)
        }
        return c.html('<h1>403 - Acesso Negado</h1>', 403)
      }
      await next()
    }
  )
}

// Helper para extrair cookie
function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('Cookie')
  if (!cookieHeader) return null

  const cookies = cookieHeader.split(';')
  for (const cookie of cookies) {
    const [key, value] = cookie.trim().split('=')
    if (key === name) return decodeURIComponent(value || '')
  }
  return null
}

// Serviço de integração com a API Multiportal

import type {
  MultiportalHandshake,
  MultiportalToken,
  MultiportalResponse,
  MultiportalVeiculo,
  Tenant,
  Bindings
} from '../types'

const MULTIPORTAL_BASE = 'http://apiv1.multiportal.com.br:9870'
const TOKEN_MARGIN_SECONDS = 300 // Renovar 5min antes de expirar

// Buscar token salvo no banco ou KV
async function getStoredToken(db: D1Database, tenantId: number): Promise<{ token: string; expiracao: number } | null> {
  const row = await db.prepare(
    'SELECT multiportal_token, multiportal_token_expiracao FROM tenants WHERE id = ?'
  ).bind(tenantId).first<{ multiportal_token: string; multiportal_token_expiracao: number }>()

  if (!row || !row.multiportal_token) return null

  const now = Math.floor(Date.now() / 1000)
  if (row.multiportal_token_expiracao && row.multiportal_token_expiracao > now + TOKEN_MARGIN_SECONDS) {
    return { token: row.multiportal_token, expiracao: row.multiportal_token_expiracao }
  }

  return null
}

// Salvar token no banco
async function saveToken(db: D1Database, tenantId: number, token: string, expiracao: number): Promise<void> {
  await db.prepare(
    'UPDATE tenants SET multiportal_token = ?, multiportal_token_expiracao = ? WHERE id = ?'
  ).bind(token, expiracao, tenantId).run()
}

// Fazer login na Multiportal e obter token
export async function loginMultiportal(
  username: string,
  password: string,
  appid: string = 'portal'
): Promise<{ token: string; expiracao: number } | null> {
  try {
    const handshake: MultiportalHandshake = { username, password, appid }

    const response = await fetch(`${MULTIPORTAL_BASE}/seguranca/logon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(handshake),
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      console.error(`[Multiportal] Login HTTP error: ${response.status}`)
      return null
    }

    const data: any = await response.json()

    if (data.status !== 'OK' || !data.object?.token) {
      console.error(`[Multiportal] Login falhou: ${data.status} - ${data.responseMessage}`)
      return null
    }

    return {
      token: data.object.token,
      expiracao: data.object.expiracao || (Math.floor(Date.now() / 1000) + 3600)
    }
  } catch (err) {
    console.error('[Multiportal] Erro no login:', err)
    return null
  }
}

// Obter token válido (com renovação automática)
export async function getValidToken(
  db: D1Database,
  tenant: Tenant
): Promise<string | null> {
  // 1. Tentar token armazenado
  const stored = await getStoredToken(db, tenant.id)
  if (stored) return stored.token

  // 2. Renovar token
  if (!tenant.multiportal_username || !tenant.multiportal_password) {
    console.error(`[Multiportal] Tenant ${tenant.id} sem credenciais configuradas`)
    return null
  }

  const result = await loginMultiportal(
    tenant.multiportal_username,
    tenant.multiportal_password,
    tenant.multiportal_appid || 'portal'
  )

  if (!result) return null

  // Salvar para próximas requisições
  await saveToken(db, tenant.id, result.token, result.expiracao)
  console.log(`[Multiportal] Token renovado para tenant ${tenant.id}`)

  return result.token
}

// Buscar lista de veículos
export async function fetchVeiculos(token: string): Promise<MultiportalVeiculo[] | null> {
  try {
    const response = await fetch(`${MULTIPORTAL_BASE}/veiculos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(30000)
    })

    if (!response.ok) return null

    const data: MultiportalResponse<MultiportalVeiculo[]> = await response.json()
    if (data.status !== 'OK') return null

    return data.object
  } catch (err) {
    console.error('[Multiportal] Erro ao buscar veículos:', err)
    return null
  }
}

// Buscar dados novos (real-time) - coração do sistema
export async function fetchDadosNovos(token: string): Promise<MultiportalVeiculo[] | null> {
  try {
    const response = await fetch(`${MULTIPORTAL_BASE}/integracao/dados_novos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000)
    })

    if (!response.ok) {
      console.error(`[Multiportal] dados_novos HTTP error: ${response.status}`)
      return null
    }

    const data: MultiportalResponse<MultiportalVeiculo[]> = await response.json()

    if (data.status === 'EXPIRADO') {
      console.warn('[Multiportal] Token expirado em dados_novos')
      return null
    }

    if (data.status !== 'OK') {
      console.error(`[Multiportal] dados_novos erro: ${data.status} - ${data.responseMessage}`)
      return []
    }

    return Array.isArray(data.object) ? data.object : []
  } catch (err) {
    console.error('[Multiportal] Erro em dados_novos:', err)
    return null
  }
}

// Buscar lista de eventos
export async function fetchEventos(token: string): Promise<any[] | null> {
  try {
    const response = await fetch(`${MULTIPORTAL_BASE}/info/eventos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) return null

    const data: any = await response.json()
    if (data.status !== 'OK') return null

    return Array.isArray(data.object) ? data.object : []
  } catch (err) {
    console.error('[Multiportal] Erro ao buscar eventos:', err)
    return null
  }
}

// Buscar motoristas
export async function fetchMotoristas(token: string): Promise<any[] | null> {
  try {
    const response = await fetch(`${MULTIPORTAL_BASE}/motoristas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) return null

    const data: any = await response.json()
    if (data.status !== 'OK') return null

    return Array.isArray(data.object) ? data.object : []
  } catch (err) {
    console.error('[Multiportal] Erro ao buscar motoristas:', err)
    return null
  }
}

// Buscar última posição de um veículo
export async function fetchUltimaPosicao(token: string, veiculoId: string): Promise<any | null> {
  try {
    const response = await fetch(`${MULTIPORTAL_BASE}/posicoes/ultimaPosicao`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'token': token
      },
      body: JSON.stringify({ veiculoId }),
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) return null

    const data: any = await response.json()
    if (data.status !== 'OK') return null

    return data.object
  } catch (err) {
    console.error('[Multiportal] Erro na última posição:', err)
    return null
  }
}

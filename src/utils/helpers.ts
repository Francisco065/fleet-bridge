// Utilitários gerais do Fleet Bridge

// Criptografia simples para credenciais (base64 + XOR com chave)
export function encryptCredential(value: string, key: string = 'fleetbridge2024'): string {
  try {
    const keyBytes = Array.from(key).map(c => c.charCodeAt(0))
    const encrypted = Array.from(value).map((char, i) => {
      return char.charCodeAt(0) ^ keyBytes[i % keyBytes.length]
    })
    return btoa(String.fromCharCode(...encrypted))
  } catch {
    return btoa(value)
  }
}

export function decryptCredential(encrypted: string, key: string = 'fleetbridge2024'): string {
  try {
    const decoded = atob(encrypted)
    const keyBytes = Array.from(key).map(c => c.charCodeAt(0))
    const decrypted = Array.from(decoded).map((char, i) => {
      return String.fromCharCode(char.charCodeAt(0) ^ keyBytes[i % keyBytes.length])
    })
    return decrypted.join('')
  } catch {
    return atob(encrypted)
  }
}

// Gerar JWT simples (HS256 com Web Crypto)
export async function generateJWT(
  payload: Record<string, any>,
  secret: string,
  expiresInHours: number = 24
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + (expiresInHours * 3600)
  }

  const encode = (obj: any) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const headerB64 = encode(header)
  const payloadB64 = encode(fullPayload)
  const signingInput = `${headerB64}.${payloadB64}`

  const enc = new TextEncoder()
  const keyData = enc.encode(secret)
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput))
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  return `${signingInput}.${signatureB64}`
}

// Verificar JWT simples
export async function verifyJWT(
  token: string,
  secret: string
): Promise<Record<string, any> | null> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, signatureB64] = parts
    const signingInput = `${headerB64}.${payloadB64}`

    const enc = new TextEncoder()
    const keyData = enc.encode(secret)
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])

    const signatureBytes = Uint8Array.from(
      atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    )

    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, enc.encode(signingInput))
    if (!valid) return null

    const decode = (b64: string) => {
      const padded = b64.replace(/-/g, '+').replace(/_/g, '/')
      const pad = padded.length % 4
      return JSON.parse(atob(pad ? padded + '='.repeat(4 - pad) : padded))
    }

    const payload = decode(payloadB64)
    const now = Math.floor(Date.now() / 1000)

    if (payload.exp && payload.exp < now) return null

    return payload
  } catch {
    return null
  }
}

// Hash de senha simples (SHA-256)
export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(password + 'fleetbridge_salt'))
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password)
  return computed === hash
}

// Formatar data para display
export function formatarData(dateStr: string | null | undefined): string {
  if (!dateStr) return '-'
  try {
    const d = new Date(dateStr)
    return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  } catch {
    return dateStr || '-'
  }
}

// Calcular tempo relativo
export function tempoRelativo(dateStr: string | null | undefined): string {
  if (!dateStr) return 'nunca'
  try {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins = Math.floor(diff / 60000)
    const horas = Math.floor(mins / 60)
    if (mins < 1) return 'agora'
    if (mins < 60) return `${mins}min atrás`
    if (horas < 24) return `${horas}h atrás`
    return `${Math.floor(horas / 24)}d atrás`
  } catch {
    return '-'
  }
}

// Converter graus para direção cardinal
export function proaParaDirecao(proa: number): string {
  const dirs = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO']
  return dirs[Math.round(proa / 45) % 8]
}

// Gerar ID único simples
export function gerarId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2)
}

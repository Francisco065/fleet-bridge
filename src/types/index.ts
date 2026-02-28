// Tipos centrais do Fleet Bridge

export interface Tenant {
  id: number
  nome_empresa: string
  email_admin: string
  multiportal_username?: string
  multiportal_password?: string
  multiportal_appid?: string
  multiportal_token?: string
  multiportal_token_expiracao?: number
  status: string
  plano: string
}

export interface Usuario {
  id: number
  tenant_id: number
  nome: string
  email: string
  perfil: 'admin' | 'operador' | 'visualizacao'
  ativo: number
}

export interface Veiculo {
  id: number
  tenant_id: number
  id_multiportal: string
  placa?: string
  modelo?: string
  marca?: string
  cor?: string
  descricao?: string
  frota?: string
  status_online: number
  odometro_gps?: number
  km_atual?: number
  ultimo_update?: string
  risk_score: number
  risk_nivel: 'verde' | 'amarelo' | 'vermelho'
}

export interface Posicao {
  id?: number
  tenant_id: number
  veiculo_id: number
  id_multiportal_veiculo?: string
  dispositivo_id?: string
  motorista_id?: number
  motorista_nome?: string
  data_gps?: string
  data_equipamento?: string
  latitude?: number
  longitude?: number
  velocidade?: number
  proa?: number
  altitude?: number
  hdop?: number
  satelites?: number
  endereco?: string
  evento_id?: string
  evento_nome?: string
  ignicao?: number
  online?: number
  sequencia?: string
  risk_score?: number
  componentes?: string
}

export interface Evento {
  id: number
  tenant_id: number
  id_multiportal: string
  nome: string
  peso_risco: number
  categoria: string
  cor: string
  icone: string
}

export interface Alerta {
  id: number
  tenant_id: number
  veiculo_id: number
  tipo: string
  mensagem: string
  severity: string
  lido: number
  data_alerta: string
}

// Tipos da API Multiportal
export interface MultiportalHandshake {
  username: string
  password: string
  appid: string
}

export interface MultiportalToken {
  token: string
  expiracao: number
}

export interface MultiportalResponse<T> {
  status: 'OK' | 'INVALIDO' | 'EXPIRADO' | 'ERRO' | 'NAOPERMITIDO'
  responseMessage: string
  object: T
}

export interface MultiportalPosicao {
  online: boolean
  eventoId: number | null
  evento: { id: number; nome: string } | null
  sequencia: string
  referencia?: string
  dataEquipamento: string | null
  dataGPS: string | null
  dataGateway: string | null
  dataProcessamento: string | null
  latitude: number
  longitude: number
  velocidade: number
  proa: number
  altitude: number
  hdop: number | null
  satelites: number | null
  endereco: string | null
  motorista: { id: string; nome: string; ibutton: string } | null
  dispositivoid: string | null
  componentes?: Array<{ id: number; nome: string; valor: string }>
}

export interface MultiportalDispositivo {
  id: string
  fabricanteId: number | null
  numero: string
  serialHexa: string
  chips: any[]
  posicoes: MultiportalPosicao[]
}

export interface MultiportalVeiculo {
  id: string
  codigorf: string | null
  odometroGps: number | null
  kmAtual: number | null
  placa: string | null
  marca: string | null
  modelo: string | null
  cor: string | null
  descricao: string | null
  frota: string | null
  status: string | null
  renavam: string | null
  vin: string | null
  grupos: any[]
  motoristas: any[]
  dispositivos: MultiportalDispositivo[]
}

// Tipos de Risk Score
export interface RiskScoreInput {
  velocidade: number
  evento_nome?: string
  evento_peso?: number
  ignicao?: boolean
  tempo_parado_min?: number
  eventos_recentes?: number
  score_anterior?: number
}

export interface RiskScoreResult {
  score: number
  nivel: 'verde' | 'amarelo' | 'vermelho'
  fatores: string[]
}

// Bindings Cloudflare
export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  JWT_SECRET?: string
  ENCRYPTION_KEY?: string
}

export type Variables = {
  tenant: Tenant
  usuario: Usuario
  jwtPayload: { sub: string; tid: number; email: string; perfil: string }
}

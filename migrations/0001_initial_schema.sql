-- Fleet Bridge - Schema inicial do banco de dados
-- Tabela de Tenants (empresas clientes)
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_empresa TEXT NOT NULL,
  email_admin TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  multiportal_username TEXT,
  multiportal_password TEXT,
  multiportal_appid TEXT DEFAULT 'portal',
  multiportal_token TEXT,
  multiportal_token_expiracao INTEGER,
  status TEXT DEFAULT 'ativo',
  plano TEXT DEFAULT 'basico',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de Usuários do sistema
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  perfil TEXT DEFAULT 'operador',
  ativo INTEGER DEFAULT 1,
  ultimo_login DATETIME,
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Tabela de Veículos
CREATE TABLE IF NOT EXISTS veiculos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  id_multiportal TEXT NOT NULL,
  placa TEXT,
  modelo TEXT,
  marca TEXT,
  cor TEXT,
  descricao TEXT,
  frota TEXT,
  vin TEXT,
  renavam TEXT,
  status_online INTEGER DEFAULT 0,
  odometro_gps REAL DEFAULT 0,
  km_atual REAL DEFAULT 0,
  ultimo_update DATETIME,
  risk_score INTEGER DEFAULT 0,
  risk_nivel TEXT DEFAULT 'verde',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE(tenant_id, id_multiportal)
);

-- Tabela de Motoristas
CREATE TABLE IF NOT EXISTS motoristas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  id_multiportal TEXT NOT NULL,
  nome TEXT,
  ibutton TEXT,
  cnh_numero TEXT,
  cnh_categoria TEXT,
  cnh_validade TEXT,
  cpf TEXT,
  email TEXT,
  matricula TEXT,
  status TEXT DEFAULT 'ativo',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE(tenant_id, id_multiportal)
);

-- Tabela de Eventos (catálogo)
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  id_multiportal TEXT NOT NULL,
  nome TEXT NOT NULL,
  peso_risco INTEGER DEFAULT 10,
  categoria TEXT DEFAULT 'info',
  cor TEXT DEFAULT '#6b7280',
  icone TEXT DEFAULT 'fas fa-info-circle',
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  UNIQUE(tenant_id, id_multiportal)
);

-- Tabela de Posições (telemetria - coração do sistema)
CREATE TABLE IF NOT EXISTS posicoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  veiculo_id INTEGER NOT NULL,
  id_multiportal_veiculo TEXT,
  dispositivo_id TEXT,
  motorista_id INTEGER,
  motorista_nome TEXT,
  data_gps DATETIME,
  data_equipamento DATETIME,
  data_gateway DATETIME,
  data_processamento DATETIME,
  latitude REAL,
  longitude REAL,
  velocidade REAL DEFAULT 0,
  proa INTEGER DEFAULT 0,
  altitude REAL DEFAULT 0,
  hdop REAL,
  satelites INTEGER,
  endereco TEXT,
  evento_id TEXT,
  evento_nome TEXT,
  ignicao INTEGER DEFAULT 0,
  online INTEGER DEFAULT 0,
  sequencia TEXT,
  risk_score INTEGER DEFAULT 0,
  componentes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (veiculo_id) REFERENCES veiculos(id)
);

-- Tabela de Alertas
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  veiculo_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',
  lido INTEGER DEFAULT 0,
  data_alerta DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (veiculo_id) REFERENCES veiculos(id)
);

-- Tabela de Logs de coleta da API
CREATE TABLE IF NOT EXISTS logs_coleta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  mensagem TEXT,
  posicoes_recebidas INTEGER DEFAULT 0,
  duracao_ms INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- Índices críticos para performance
CREATE INDEX IF NOT EXISTS idx_posicoes_veiculo_data ON posicoes(veiculo_id, data_gps DESC);
CREATE INDEX IF NOT EXISTS idx_posicoes_tenant ON posicoes(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posicoes_latlong ON posicoes(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_veiculos_tenant ON veiculos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alertas_tenant_lido ON alertas(tenant_id, lido, data_alerta DESC);
CREATE INDEX IF NOT EXISTS idx_logs_tenant ON logs_coleta(tenant_id, created_at DESC);

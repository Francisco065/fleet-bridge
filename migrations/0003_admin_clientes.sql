-- Fleet Bridge - Migration 0003: Campos adicionais para gestão de clientes
-- Nota: D1 (SQLite) não suporta "IF NOT EXISTS" em ALTER TABLE
-- Usar ADD COLUMN sem verificação (ignorar erro se já existir)

ALTER TABLE tenants ADD COLUMN cnpj TEXT;
ALTER TABLE tenants ADD COLUMN telefone TEXT;
ALTER TABLE tenants ADD COLUMN responsavel_nome TEXT;
ALTER TABLE tenants ADD COLUMN responsavel_cargo TEXT;
ALTER TABLE tenants ADD COLUMN responsavel_telefone TEXT;
ALTER TABLE tenants ADD COLUMN endereco_logradouro TEXT;
ALTER TABLE tenants ADD COLUMN endereco_numero TEXT;
ALTER TABLE tenants ADD COLUMN endereco_complemento TEXT;
ALTER TABLE tenants ADD COLUMN endereco_bairro TEXT;
ALTER TABLE tenants ADD COLUMN endereco_cidade TEXT;
ALTER TABLE tenants ADD COLUMN endereco_uf TEXT;
ALTER TABLE tenants ADD COLUMN endereco_cep TEXT;
ALTER TABLE tenants ADD COLUMN qtd_veiculos_contrato INTEGER DEFAULT 0;
ALTER TABLE tenants ADD COLUMN data_contrato DATE;
ALTER TABLE tenants ADD COLUMN data_vencimento DATE;
ALTER TABLE tenants ADD COLUMN observacoes TEXT;
ALTER TABLE tenants ADD COLUMN logo_url TEXT;

-- Tabela de planos disponíveis
CREATE TABLE IF NOT EXISTS planos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  descricao TEXT,
  max_veiculos INTEGER DEFAULT 10,
  max_usuarios INTEGER DEFAULT 3,
  preco_mensal REAL DEFAULT 0,
  features TEXT,
  ativo INTEGER DEFAULT 1,
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inserir planos padrão
INSERT OR IGNORE INTO planos (codigo, nome, descricao, max_veiculos, max_usuarios, preco_mensal, features) VALUES
  ('basico',      'Básico',      'Até 10 veículos, funcionalidades essenciais',     10,   3,   199.90, '["dashboard","mapa","alertas"]'),
  ('profissional','Profissional','Até 50 veículos, relatórios avançados',           50,  10,   499.90, '["dashboard","mapa","alertas","relatorios","ranking","api"]'),
  ('enterprise',  'Enterprise',  'Veículos ilimitados, suporte dedicado',          999, 100,  1299.90, '["dashboard","mapa","alertas","relatorios","ranking","api","suporte","white-label"]');

-- Tabela de superadmins
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  ativo INTEGER DEFAULT 1,
  ultimo_login DATETIME,
  criado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_plano ON tenants(plano);

-- Seed inicial: Tenant demo + usuário admin
-- Senha hash: SHA-256 de 'demo123' + salt 'fleetbridge_salt'
INSERT OR IGNORE INTO tenants (
  id, nome_empresa, email_admin, senha_hash, 
  multiportal_appid, status, plano
) VALUES (
  1, 
  'Fleet Bridge Demo', 
  'admin@fleetbridge.com.br',
  'd1db0f55855fb340c82daf9d5aaae3dea89292a4b89c374df9486dbc4978f7f7',
  'portal',
  'ativo',
  'enterprise'
);

INSERT OR IGNORE INTO usuarios (
  tenant_id, nome, email, senha_hash, perfil
) VALUES (
  1,
  'Administrador',
  'admin@fleetbridge.com.br',
  'd1db0f55855fb340c82daf9d5aaae3dea89292a4b89c374df9486dbc4978f7f7',
  'admin'
);

-- Eventos padrão de risco para o tenant demo
INSERT OR IGNORE INTO eventos (tenant_id, id_multiportal, nome, peso_risco, categoria, cor, icone) VALUES
  (1, '1', 'Ignição Ligada', 0, 'info', '#10b981', 'fas fa-key'),
  (1, '2', 'Ignição Desligada', 0, 'info', '#6b7280', 'fas fa-key'),
  (1, '3', 'Excesso de Velocidade', 35, 'critico', '#ef4444', 'fas fa-tachometer-alt'),
  (1, '4', 'Frenagem Brusca', 25, 'alerta', '#f59e0b', 'fas fa-exclamation-triangle'),
  (1, '5', 'Curva Agressiva', 20, 'alerta', '#f59e0b', 'fas fa-route'),
  (1, '6', 'Aceleração Brusca', 20, 'alerta', '#f59e0b', 'fas fa-bolt'),
  (1, '7', 'Veículo Parado', 5, 'info', '#3b82f6', 'fas fa-parking'),
  (1, '8', 'Saída de Cerca', 30, 'critico', '#ef4444', 'fas fa-map-marker-alt'),
  (1, '9', 'Entrada de Cerca', 5, 'info', '#10b981', 'fas fa-map-marker-alt'),
  (1, '10', 'Pânico', 50, 'critico', '#dc2626', 'fas fa-exclamation-circle'),
  (1, '11', 'Bateria Baixa', 15, 'alerta', '#f59e0b', 'fas fa-battery-quarter'),
  (1, '12', 'Jammer Detectado', 40, 'critico', '#dc2626', 'fas fa-wifi'),
  (1, '13', 'Movimento sem Ignição', 35, 'critico', '#ef4444', 'fas fa-car'),
  (1, '14', 'Ociosidade', 10, 'alerta', '#f59e0b', 'fas fa-clock'),
  (1, '15', 'GPS Sem Sinal', 5, 'info', '#6b7280', 'fas fa-satellite');

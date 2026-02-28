import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings, Variables } from './types'
import { authMiddleware } from './middleware/auth'
import authRoutes from './routes/auth'
import veiculosRoutes from './routes/veiculos'
import dashboardRoutes from './routes/dashboard'
import syncRoutes from './routes/sync'
import { coletarTodosTenants } from './services/worker'
import { hashPassword } from './utils/helpers'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// CORS
app.use('/api/*', cors({
  origin: ['*'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'token'],
}))

// Arquivos estáticos
app.use('/static/*', serveStatic({ root: './public' }))

// ============================================================
// ROTAS PÚBLICAS (sem autenticação)
// ============================================================

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'Fleet Bridge', version: '1.0.0' }))

// Auth (login e registro não precisam de token)
app.route('/api/auth', authRoutes)

// Setup inicial (público - apenas cria estrutura se não existir)
app.post('/api/setup', async (c) => {
  try {
    const schema = [
      `CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT,nome_empresa TEXT NOT NULL,email_admin TEXT UNIQUE NOT NULL,senha_hash TEXT NOT NULL,multiportal_username TEXT,multiportal_password TEXT,multiportal_appid TEXT DEFAULT 'portal',multiportal_token TEXT,multiportal_token_expiracao INTEGER,status TEXT DEFAULT 'ativo',plano TEXT DEFAULT 'basico',criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,nome TEXT NOT NULL,email TEXT UNIQUE NOT NULL,senha_hash TEXT NOT NULL,perfil TEXT DEFAULT 'operador',ativo INTEGER DEFAULT 1,ultimo_login DATETIME,criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id))`,
      `CREATE TABLE IF NOT EXISTS veiculos (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,id_multiportal TEXT NOT NULL,placa TEXT,modelo TEXT,marca TEXT,cor TEXT,descricao TEXT,frota TEXT,vin TEXT,renavam TEXT,status_online INTEGER DEFAULT 0,odometro_gps REAL DEFAULT 0,km_atual REAL DEFAULT 0,ultimo_update DATETIME,risk_score INTEGER DEFAULT 0,risk_nivel TEXT DEFAULT 'verde',criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id),UNIQUE(tenant_id,id_multiportal))`,
      `CREATE TABLE IF NOT EXISTS motoristas (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,id_multiportal TEXT NOT NULL,nome TEXT,ibutton TEXT,cnh_numero TEXT,cnh_categoria TEXT,cnh_validade TEXT,cpf TEXT,email TEXT,matricula TEXT,status TEXT DEFAULT 'ativo',criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id),UNIQUE(tenant_id,id_multiportal))`,
      `CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,id_multiportal TEXT NOT NULL,nome TEXT NOT NULL,peso_risco INTEGER DEFAULT 10,categoria TEXT DEFAULT 'info',cor TEXT DEFAULT '#6b7280',icone TEXT DEFAULT 'fas fa-info-circle',criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id),UNIQUE(tenant_id,id_multiportal))`,
      `CREATE TABLE IF NOT EXISTS posicoes (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,veiculo_id INTEGER NOT NULL,id_multiportal_veiculo TEXT,dispositivo_id TEXT,motorista_id INTEGER,motorista_nome TEXT,data_gps DATETIME,data_equipamento DATETIME,data_gateway DATETIME,latitude REAL,longitude REAL,velocidade REAL DEFAULT 0,proa INTEGER DEFAULT 0,altitude REAL DEFAULT 0,hdop REAL,satelites INTEGER,endereco TEXT,evento_id TEXT,evento_nome TEXT,ignicao INTEGER DEFAULT 0,online INTEGER DEFAULT 0,sequencia TEXT,risk_score INTEGER DEFAULT 0,componentes TEXT,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id),FOREIGN KEY (veiculo_id) REFERENCES veiculos(id))`,
      `CREATE TABLE IF NOT EXISTS alertas (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,veiculo_id INTEGER NOT NULL,tipo TEXT NOT NULL,mensagem TEXT NOT NULL,severity TEXT DEFAULT 'warning',lido INTEGER DEFAULT 0,data_alerta DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id),FOREIGN KEY (veiculo_id) REFERENCES veiculos(id))`,
      `CREATE TABLE IF NOT EXISTS logs_coleta (id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id INTEGER NOT NULL,status TEXT NOT NULL,mensagem TEXT,posicoes_recebidas INTEGER DEFAULT 0,duracao_ms INTEGER,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY (tenant_id) REFERENCES tenants(id))`,
      `CREATE INDEX IF NOT EXISTS idx_posicoes_veiculo_data ON posicoes(veiculo_id,data_gps DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_posicoes_tenant ON posicoes(tenant_id,created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_veiculos_tenant ON veiculos(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alertas_tenant ON alertas(tenant_id,lido)`,
    ]
    for (const sql of schema) {
      await c.env.DB.prepare(sql).run()
    }
    const senhaHash = await hashPassword('demo123')
    await c.env.DB.prepare(`INSERT OR IGNORE INTO tenants (id,nome_empresa,email_admin,senha_hash,status,plano) VALUES (1,'Fleet Bridge Demo','admin@fleetbridge.com.br',?,'ativo','enterprise')`).bind(senhaHash).run()
    await c.env.DB.prepare(`INSERT OR IGNORE INTO usuarios (tenant_id,nome,email,senha_hash,perfil) VALUES (1,'Administrador','admin@fleetbridge.com.br',?,'admin')`).bind(senhaHash).run()
    // Eventos padrão
    const eventos = [
      ['1','Ignição Ligada',0,'info'],['2','Ignição Desligada',0,'info'],['3','Excesso de Velocidade',35,'critico'],
      ['4','Frenagem Brusca',25,'alerta'],['5','Curva Agressiva',20,'alerta'],['6','Aceleração Brusca',20,'alerta'],
      ['7','Veículo Parado',5,'info'],['8','Saída de Cerca',30,'critico'],['9','Entrada de Cerca',5,'info'],
      ['10','Pânico',50,'critico'],['11','Bateria Baixa',15,'alerta'],['12','Jammer',40,'critico'],
    ]
    for (const [id, nome, peso, cat] of eventos) {
      await c.env.DB.prepare(`INSERT OR IGNORE INTO eventos (tenant_id,id_multiportal,nome,peso_risco,categoria) VALUES (1,?,?,?,?)`).bind(id,nome,peso,cat).run()
    }
    return c.json({ ok: true, message: 'Sistema inicializado!' })
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 500)
  }
})

// Coleta automática via Cron/trigger HTTP (pode ser chamado externamente)
app.post('/api/internal/collect', async (c) => {
  const apiKey = c.req.header('X-API-Key')
  const expectedKey = c.env.KV ? await c.env.KV.get('internal_api_key') : null
  
  // Aceitar sem chave em dev, ou validar em prod
  if (expectedKey && apiKey !== expectedKey) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const results = await coletarTodosTenants(c.env.DB)
  return c.json({ results, timestamp: new Date().toISOString() })
})

// ============================================================
// ROTAS AUTENTICADAS
// ============================================================
app.use('/api/*', authMiddleware)

// Rotas de API
app.route('/api/veiculos', veiculosRoutes)
app.route('/api/dashboard', dashboardRoutes)
app.route('/api/sync', syncRoutes)

// Configuração do tenant
app.get('/api/tenant', async (c) => {
  const tenant = c.get('tenant')
  const { multiportal_password, senha_hash, ...safe } = tenant as any
  return c.json({ tenant: safe })
})

// Informações do usuário logado
app.get('/api/usuario', async (c) => {
  const payload = c.get('jwtPayload')
  const tenant = c.get('tenant')
  return c.json({
    usuario: {
      ...payload,
      empresa: (tenant as any).nome_empresa
    }
  })
})

// ============================================================
// PÁGINAS HTML - Single Page Application
// ============================================================

// Página de Login
app.get('/login', (c) => {
  return c.html(getLoginPage())
})

// Dashboard principal (SPA)
app.get('/', (c) => {
  return c.html(getDashboardPage())
})

app.get('/app', (c) => c.redirect('/'))
app.get('/dashboard', (c) => c.redirect('/'))
app.get('/veiculos', (c) => c.redirect('/'))
app.get('/ranking', (c) => c.redirect('/'))
app.get('/configuracoes', (c) => c.redirect('/'))

// ============================================================
// HTML TEMPLATES
// ============================================================

function getLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Bridge - Login</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    body { background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); }
    .glass { backdrop-filter: blur(20px); background: rgba(30,41,59,0.8); border: 1px solid rgba(148,163,184,0.1); }
    .btn-gradient { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
    .btn-gradient:hover { background: linear-gradient(135deg, #2563eb, #1e40af); }
    @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
    .float { animation: float 3s ease-in-out infinite; }
    input:-webkit-autofill { -webkit-box-shadow: 0 0 0 30px #1e293b inset !important; -webkit-text-fill-color: #e2e8f0 !important; }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <!-- Background decorativo -->
  <div class="fixed inset-0 overflow-hidden pointer-events-none">
    <div class="absolute top-1/4 left-1/4 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
    <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl"></div>
  </div>

  <div class="w-full max-w-md relative">
    <!-- Logo -->
    <div class="text-center mb-8">
      <div class="float inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-2xl shadow-blue-500/30 mb-4">
        <i class="fas fa-route text-white text-3xl"></i>
      </div>
      <h1 class="text-3xl font-bold text-white">Fleet Bridge</h1>
      <p class="text-slate-400 mt-1">Plataforma de Monitoramento Veicular</p>
    </div>

    <!-- Card de login -->
    <div class="glass rounded-2xl p-8 shadow-2xl">
      <h2 class="text-xl font-semibold text-white mb-6">Entrar na plataforma</h2>
      
      <div id="alert" class="hidden mb-4 p-3 rounded-lg text-sm font-medium"></div>

      <form id="loginForm" class="space-y-5">
        <div>
          <label class="block text-sm font-medium text-slate-400 mb-1.5">Email</label>
          <div class="relative">
            <i class="fas fa-envelope absolute left-3.5 top-3.5 text-slate-500 text-sm"></i>
            <input type="email" id="email" name="email" value="admin@fleetbridge.com.br"
              class="w-full bg-slate-800/50 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
              placeholder="seu@email.com.br" required>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-slate-400 mb-1.5">Senha</label>
          <div class="relative">
            <i class="fas fa-lock absolute left-3.5 top-3.5 text-slate-500 text-sm"></i>
            <input type="password" id="senha" name="senha" value="demo123"
              class="w-full bg-slate-800/50 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
              placeholder="••••••••" required>
            <button type="button" onclick="toggleSenha()" class="absolute right-3.5 top-3 text-slate-500 hover:text-slate-300 p-0.5">
              <i class="fas fa-eye" id="eyeIcon"></i>
            </button>
          </div>
        </div>

        <button type="submit" id="btnLogin"
          class="btn-gradient w-full py-3 rounded-xl text-white font-semibold text-sm shadow-lg shadow-blue-500/20 transition-all hover:shadow-blue-500/40 hover:-translate-y-0.5 active:translate-y-0">
          <i class="fas fa-sign-in-alt mr-2"></i>Entrar
        </button>
      </form>

      <div class="mt-6 p-4 rounded-xl bg-slate-800/50 border border-slate-700">
        <p class="text-xs text-slate-400 font-medium mb-2"><i class="fas fa-info-circle mr-1 text-blue-400"></i>Acesso Demo</p>
        <p class="text-xs text-slate-500">Email: <span class="text-slate-300">admin@fleetbridge.com.br</span></p>
        <p class="text-xs text-slate-500">Senha: <span class="text-slate-300">demo123</span></p>
      </div>
    </div>
  </div>

  <script>
    function toggleSenha() {
      const input = document.getElementById('senha')
      const icon = document.getElementById('eyeIcon')
      if (input.type === 'password') {
        input.type = 'text'
        icon.className = 'fas fa-eye-slash'
      } else {
        input.type = 'password'
        icon.className = 'fas fa-eye'
      }
    }

    function showAlert(msg, type = 'error') {
      const el = document.getElementById('alert')
      el.className = 'mb-4 p-3 rounded-lg text-sm font-medium'
      if (type === 'error') el.classList.add('bg-red-500/20', 'text-red-400', 'border', 'border-red-500/30')
      else el.classList.add('bg-green-500/20', 'text-green-400', 'border', 'border-green-500/30')
      el.textContent = msg
      el.classList.remove('hidden')
    }

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault()
      const btn = document.getElementById('btnLogin')
      btn.disabled = true
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Entrando...'

      const email = document.getElementById('email').value
      const senha = document.getElementById('senha').value

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, senha })
        })
        const data = await res.json()

        if (res.ok && data.token) {
          localStorage.setItem('fleet_token', data.token)
          localStorage.setItem('fleet_user', JSON.stringify(data.usuario))
          showAlert('Login realizado! Redirecionando...', 'success')
          setTimeout(() => window.location.href = '/', 500)
        } else {
          showAlert(data.error || 'Erro ao fazer login')
          btn.disabled = false
          btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Entrar'
        }
      } catch (err) {
        showAlert('Erro de conexão. Tente novamente.')
        btn.disabled = false
        btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Entrar'
      }
    })
  </script>
</body>
</html>`
}

function getDashboardPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Bridge - Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-card: #1e2a3a;
      --border: rgba(148,163,184,0.1);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; }
    body { background: var(--bg-primary); color: var(--text-primary); font-family: 'Inter', system-ui, sans-serif; margin: 0; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: var(--bg-secondary); }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
    .sidebar { width: 260px; background: var(--bg-secondary); border-right: 1px solid var(--border); height: 100vh; position: fixed; left: 0; top: 0; display: flex; flex-direction: column; z-index: 100; transition: transform 0.3s; }
    .main-content { margin-left: 260px; min-height: 100vh; }
    .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; }
    .card-glow { box-shadow: 0 0 30px rgba(59,130,246,0.05); }
    .btn-primary { background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-primary:hover { background: linear-gradient(135deg, #2563eb, #1d4ed8); transform: translateY(-1px); }
    .btn-ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); padding: 7px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    .btn-ghost:hover { border-color: var(--accent); color: var(--text-primary); }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-radius: 10px; cursor: pointer; font-size: 13.5px; font-weight: 500; color: var(--text-secondary); transition: all 0.2s; margin: 2px 8px; text-decoration: none; }
    .nav-item:hover { background: rgba(59,130,246,0.1); color: var(--text-primary); }
    .nav-item.active { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .nav-item i { width: 18px; text-align: center; }
    .kpi-card { border-radius: 16px; padding: 20px; position: relative; overflow: hidden; }
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 9999px; font-size: 11px; font-weight: 600; }
    .badge-green { background: rgba(16,185,129,0.15); color: #34d399; }
    .badge-yellow { background: rgba(245,158,11,0.15); color: #fbbf24; }
    .badge-red { background: rgba(239,68,68,0.15); color: #f87171; }
    .badge-blue { background: rgba(59,130,246,0.15); color: #60a5fa; }
    #map { background: #0f172a !important; }
    .leaflet-container { background: #1e293b !important; }
    .vehicle-marker { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.4); cursor: pointer; font-size: 14px; }
    .pulse { animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,0.4)} 50%{box-shadow:0 0 0 8px rgba(16,185,129,0)} }
    .tab-btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; background: transparent; color: var(--text-secondary); border: none; }
    .tab-btn.active { background: rgba(59,130,246,0.15); color: #60a5fa; }
    .tab-btn:hover { color: var(--text-primary); }
    .risk-bar { height: 4px; border-radius: 2px; background: #1e293b; }
    .table-row:hover { background: rgba(59,130,246,0.05); }
    .section { display: none; }
    .section.active { display: block; }
    .modal { display: none; position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); align-items: center; justify-content: center; }
    .modal.open { display: flex; }
    .modal-content { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 20px; padding: 28px; width: 90%; max-width: 540px; max-height: 90vh; overflow-y: auto; }
    .input-field { width: 100%; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; color: var(--text-primary); font-size: 13px; transition: all 0.2s; outline: none; }
    .input-field:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    @media (max-width: 768px) {
      .sidebar { transform: translateX(-260px); }
      .sidebar.open { transform: translateX(0); }
      .main-content { margin-left: 0; }
    }
    .loader { border: 3px solid rgba(59,130,246,0.2); border-top-color: #3b82f6; border-radius: 50%; width: 20px; height: 20px; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .timeline-item { position: relative; padding-left: 24px; }
    .timeline-item::before { content: ''; position: absolute; left: 7px; top: 14px; bottom: -8px; width: 1px; background: var(--border); }
    .timeline-item:last-child::before { display: none; }
    .timeline-dot { position: absolute; left: 0; top: 8px; width: 14px; height: 14px; border-radius: 50%; border: 2px solid; }
  </style>
</head>
<body>
  <!-- Sidebar -->
  <nav class="sidebar" id="sidebar">
    <div class="p-5 border-b border-slate-700/50">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg">
          <i class="fas fa-route text-white text-sm"></i>
        </div>
        <div>
          <div class="font-bold text-white text-sm">Fleet Bridge</div>
          <div class="text-xs text-slate-500" id="empresa-nome">Carregando...</div>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto py-3 px-1">
      <div class="px-4 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wider mb-1">Principal</div>
      
      <a class="nav-item active" onclick="showSection('torre')" href="#torre">
        <i class="fas fa-tower-observation"></i>
        <span>Torre de Controle</span>
        <span id="badge-alertas" class="ml-auto badge badge-red hidden">0</span>
      </a>
      <a class="nav-item" onclick="showSection('mapa')" href="#mapa">
        <i class="fas fa-map-marked-alt"></i>
        <span>Mapa Ao Vivo</span>
      </a>
      <a class="nav-item" onclick="showSection('indicadores')" href="#indicadores">
        <i class="fas fa-chart-bar"></i>
        <span>Indicadores do Dia</span>
      </a>

      <div class="px-4 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wider mt-3 mb-1">Análise</div>
      
      <a class="nav-item" onclick="showSection('ranking')" href="#ranking">
        <i class="fas fa-trophy"></i>
        <span>Rankings</span>
      </a>
      <a class="nav-item" onclick="showSection('veiculos-lista')" href="#veiculos-lista">
        <i class="fas fa-car"></i>
        <span>Veículos</span>
      </a>

      <div class="px-4 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wider mt-3 mb-1">Sistema</div>

      <a class="nav-item" onclick="showSection('config')" href="#config">
        <i class="fas fa-cog"></i>
        <span>Configurações</span>
      </a>
      <a class="nav-item" onclick="showSection('logs')" href="#logs">
        <i class="fas fa-terminal"></i>
        <span>Logs de Coleta</span>
      </a>
    </div>

    <div class="p-4 border-t border-slate-700/50">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center">
          <i class="fas fa-user text-slate-400 text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-slate-300 truncate" id="user-nome">...</div>
          <div class="text-xs text-slate-500" id="user-perfil">...</div>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <div id="status-coleta" class="flex items-center gap-1.5 text-xs text-slate-500">
          <div class="w-2 h-2 rounded-full bg-slate-600" id="dot-status"></div>
          <span id="txt-status">Aguardando</span>
        </div>
        <button onclick="logout()" class="text-xs text-slate-500 hover:text-red-400 transition flex items-center gap-1">
          <i class="fas fa-sign-out-alt"></i> Sair
        </button>
      </div>
    </div>
  </nav>

  <!-- Main Content -->
  <main class="main-content">
    <!-- Topbar -->
    <header class="h-14 bg-slate-900/80 backdrop-blur-sm border-b border-slate-800 flex items-center px-5 sticky top-0 z-50">
      <button class="md:hidden mr-3 text-slate-400" onclick="toggleSidebar()">
        <i class="fas fa-bars"></i>
      </button>
      <div class="flex items-center gap-2">
        <h1 class="text-sm font-semibold text-white" id="page-title">Torre de Controle</h1>
      </div>
      <div class="ml-auto flex items-center gap-3">
        <div class="hidden sm:flex items-center gap-2 text-xs text-slate-500">
          <i class="fas fa-sync-alt" id="sync-icon"></i>
          <span id="last-update">-</span>
        </div>
        <button onclick="coletarDados()" class="btn-primary text-xs py-1.5 px-3">
          <i class="fas fa-sync-alt"></i>
          <span class="hidden sm:inline">Atualizar</span>
        </button>
        <button onclick="showModal('modal-setup')" class="btn-ghost text-xs py-1.5 px-3">
          <i class="fas fa-plug"></i>
          <span class="hidden sm:inline">Conectar</span>
        </button>
      </div>
    </header>

    <div class="p-5 md:p-6">

      <!-- ===== TORRE DE CONTROLE ===== -->
      <section id="sec-torre" class="section active">
        <!-- KPIs -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div class="kpi-card card card-glow" style="background: linear-gradient(135deg, #1e293b, #1e3a5f)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Total Veículos</span>
              <div class="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                <i class="fas fa-car text-blue-400 text-xs"></i>
              </div>
            </div>
            <div class="text-3xl font-bold text-white" id="kpi-total">-</div>
            <div class="text-xs text-slate-500 mt-1">frota cadastrada</div>
          </div>

          <div class="kpi-card card" style="background: linear-gradient(135deg, #1e293b, #052e16)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Online Agora</span>
              <div class="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
                <i class="fas fa-signal text-green-400 text-xs"></i>
              </div>
            </div>
            <div class="text-3xl font-bold text-green-400" id="kpi-online">-</div>
            <div class="text-xs text-slate-500 mt-1" id="kpi-online-pct">transmitindo</div>
          </div>

          <div class="kpi-card card" style="background: linear-gradient(135deg, #1e293b, #2d1515)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Em Risco</span>
              <div class="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                <i class="fas fa-exclamation-triangle text-red-400 text-xs"></i>
              </div>
            </div>
            <div class="text-3xl font-bold text-red-400" id="kpi-risco">-</div>
            <div class="text-xs text-slate-500 mt-1">score ≥ 61</div>
          </div>

          <div class="kpi-card card" style="background: linear-gradient(135deg, #1e293b, #1c1a2e)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Score Médio</span>
              <div class="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <i class="fas fa-shield-alt text-purple-400 text-xs"></i>
              </div>
            </div>
            <div class="text-3xl font-bold" id="kpi-score" style="color:#a78bfa">-</div>
            <div class="text-xs text-slate-500 mt-1">risco da frota</div>
          </div>
        </div>

        <!-- Linha 2: Distribuição + Alertas + Timeline -->
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
          <!-- Distribuição de Risco -->
          <div class="card p-5">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-chart-pie text-blue-400"></i> Distribuição de Risco
            </h3>
            <canvas id="chartRisco" height="180"></canvas>
            <div id="dist-risco" class="mt-4 space-y-2"></div>
          </div>

          <!-- Alertas -->
          <div class="card p-5">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-semibold text-white flex items-center gap-2">
                <i class="fas fa-bell text-yellow-400"></i> Alertas
              </h3>
              <button onclick="marcarTodosLidos()" class="text-xs text-slate-500 hover:text-slate-300">
                Limpar todos
              </button>
            </div>
            <div id="lista-alertas" class="space-y-2 max-h-52 overflow-y-auto">
              <div class="text-slate-500 text-xs text-center py-4">Nenhum alerta</div>
            </div>
          </div>

          <!-- Atividade por hora -->
          <div class="card p-5">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-chart-area text-green-400"></i> Atividade Hoje
            </h3>
            <canvas id="chartHoras" height="180"></canvas>
          </div>
        </div>

        <!-- Timeline de Eventos -->
        <div class="card p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-white flex items-center gap-2">
              <i class="fas fa-stream text-indigo-400"></i> Timeline de Eventos
            </h3>
            <div class="flex items-center gap-1.5 text-xs text-slate-500">
              <div class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
              Tempo Real
            </div>
          </div>
          <div id="timeline" class="space-y-1 max-h-64 overflow-y-auto">
            <div class="text-slate-500 text-xs text-center py-6">Aguardando eventos...</div>
          </div>
        </div>
      </section>

      <!-- ===== MAPA ===== -->
      <section id="sec-mapa" class="section">
        <div class="card overflow-hidden" style="height: calc(100vh - 120px)">
          <div id="map" style="height: 100%; width: 100%;"></div>
        </div>
      </section>

      <!-- ===== INDICADORES ===== -->
      <section id="sec-indicadores" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Indicadores do Dia</h2>
          <div class="text-xs text-slate-500" id="data-hoje"></div>
        </div>
        <div id="indicadores-grid" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div class="text-slate-500 text-sm text-center py-10 col-span-3">Carregando indicadores...</div>
        </div>
      </section>

      <!-- ===== RANKING ===== -->
      <section id="sec-ranking" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Rankings</h2>
          <div class="flex gap-1">
            <button class="tab-btn active" onclick="loadRanking('risco', this)">
              <i class="fas fa-fire mr-1"></i>Risco
            </button>
            <button class="tab-btn" onclick="loadRanking('velocidade', this)">
              <i class="fas fa-tachometer-alt mr-1"></i>Velocidade
            </button>
            <button class="tab-btn" onclick="loadRanking('ociosidade', this)">
              <i class="fas fa-clock mr-1"></i>Ociosidade
            </button>
          </div>
        </div>
        <div class="card overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-800">
                <th class="text-left p-4 text-xs text-slate-500 font-medium">#</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Veículo</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Placa</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Risk Score</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium hidden md:table-cell">Vel. Pico</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium hidden md:table-cell">Status</th>
              </tr>
            </thead>
            <tbody id="ranking-body">
              <tr><td colspan="6" class="text-center p-8 text-slate-500 text-xs">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ===== VEÍCULOS ===== -->
      <section id="sec-veiculos-lista" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Frota</h2>
          <button onclick="showModal('modal-sync')" class="btn-primary text-xs">
            <i class="fas fa-sync-alt"></i> Sincronizar
          </button>
        </div>
        <div id="veiculos-grid" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div class="text-slate-500 text-sm text-center py-10 col-span-3">Carregando veículos...</div>
        </div>
      </section>

      <!-- ===== CONFIGURAÇÕES ===== -->
      <section id="sec-config" class="section">
        <div class="max-w-2xl">
          <h2 class="text-base font-semibold text-white mb-5">Configurações da Conta</h2>

          <div class="card p-6 mb-5">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-plug text-blue-400"></i> Integração Multiportal
            </h3>
            <div class="space-y-4">
              <div>
                <label class="block text-xs text-slate-400 mb-1.5">Usuário Multiportal</label>
                <input type="text" id="cfg-username" class="input-field" placeholder="seu_usuario">
              </div>
              <div>
                <label class="block text-xs text-slate-400 mb-1.5">Senha</label>
                <input type="password" id="cfg-password" class="input-field" placeholder="••••••••">
              </div>
              <div>
                <label class="block text-xs text-slate-400 mb-1.5">AppID</label>
                <input type="text" id="cfg-appid" class="input-field" value="portal" placeholder="portal">
              </div>
              <div class="flex gap-3">
                <button onclick="testarConexao()" class="btn-ghost text-xs">
                  <i class="fas fa-plug"></i> Testar Conexão
                </button>
                <button onclick="salvarCredenciais()" class="btn-primary text-xs">
                  <i class="fas fa-save"></i> Salvar
                </button>
              </div>
              <div id="cfg-result" class="hidden text-xs p-3 rounded-lg"></div>
            </div>
          </div>

          <div class="card p-6">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-sync text-green-400"></i> Sincronização de Dados
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <button onclick="sincronizarVeiculos()" class="btn-ghost justify-center">
                <i class="fas fa-car"></i> Sincronizar Veículos
              </button>
              <button onclick="sincronizarEventos()" class="btn-ghost justify-center">
                <i class="fas fa-list"></i> Sincronizar Eventos
              </button>
              <button onclick="sincronizarMotoristas()" class="btn-ghost justify-center">
                <i class="fas fa-users"></i> Sincronizar Motoristas
              </button>
              <button onclick="coletarDados()" class="btn-primary justify-center">
                <i class="fas fa-play"></i> Coletar Agora
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- ===== LOGS ===== -->
      <section id="sec-logs" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Logs de Coleta</h2>
          <button onclick="loadLogs()" class="btn-ghost text-xs">
            <i class="fas fa-refresh"></i> Atualizar
          </button>
        </div>
        <div class="card overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-800">
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Data/Hora</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Status</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Posições</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium hidden md:table-cell">Duração</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium">Mensagem</th>
              </tr>
            </thead>
            <tbody id="logs-body">
              <tr><td colspan="5" class="text-center p-8 text-slate-500 text-xs">Carregando logs...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

    </div>
  </main>

  <!-- Modal: Configuração rápida -->
  <div class="modal" id="modal-setup">
    <div class="modal-content">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-semibold text-white"><i class="fas fa-plug text-blue-400 mr-2"></i>Conectar à Multiportal</h2>
        <button onclick="closeModal('modal-setup')" class="text-slate-400 hover:text-white">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-slate-400 mb-1.5">Usuário</label>
          <input type="text" id="m-username" class="input-field" placeholder="usuario_multiportal">
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1.5">Senha</label>
          <input type="password" id="m-password" class="input-field" placeholder="••••••••">
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1.5">AppID</label>
          <input type="text" id="m-appid" class="input-field" value="portal">
        </div>
        <div id="m-result" class="hidden text-xs p-3 rounded-lg"></div>
        <div class="flex gap-3 pt-2">
          <button onclick="testarEConectarModal()" class="btn-primary flex-1 justify-center">
            <i class="fas fa-plug"></i> Testar e Salvar
          </button>
          <button onclick="closeModal('modal-setup')" class="btn-ghost">Cancelar</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Modal: Sincronizar -->
  <div class="modal" id="modal-sync">
    <div class="modal-content">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-semibold text-white"><i class="fas fa-sync text-green-400 mr-2"></i>Sincronização</h2>
        <button onclick="closeModal('modal-sync')" class="text-slate-400 hover:text-white"><i class="fas fa-times"></i></button>
      </div>
      <div id="sync-content" class="space-y-3">
        <p class="text-sm text-slate-400">Clique para sincronizar os dados da Multiportal:</p>
        <div class="grid grid-cols-1 gap-3">
          <button onclick="syncAndShow('veiculos')" class="btn-ghost justify-start w-full">
            <i class="fas fa-car text-blue-400"></i> Sincronizar Veículos
          </button>
          <button onclick="syncAndShow('eventos')" class="btn-ghost justify-start w-full">
            <i class="fas fa-list text-yellow-400"></i> Sincronizar Catálogo de Eventos
          </button>
          <button onclick="syncAndShow('motoristas')" class="btn-ghost justify-start w-full">
            <i class="fas fa-users text-green-400"></i> Sincronizar Motoristas
          </button>
        </div>
        <div id="sync-result" class="hidden text-xs p-3 rounded-lg mt-3"></div>
      </div>
    </div>
  </div>

  <script>
    // ============================================================
    // CONFIGURAÇÃO GLOBAL
    // ============================================================
    const token = localStorage.getItem('fleet_token')
    const user = JSON.parse(localStorage.getItem('fleet_user') || '{}')
    let mapInstance = null
    let mapMarkers = {}
    let chartRisco = null
    let chartHoras = null
    let autoRefreshTimer = null
    const AUTO_REFRESH_SEC = 30

    // Verificar autenticação
    if (!token) {
      window.location.href = '/login'
    }

    // Config axios
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + token

    // ============================================================
    // INICIALIZAÇÃO
    // ============================================================
    document.addEventListener('DOMContentLoaded', async () => {
      // Atualizar UI com dados do usuário
      document.getElementById('user-nome').textContent = user.nome || 'Usuário'
      document.getElementById('user-perfil').textContent = user.perfil || 'operador'
      document.getElementById('data-hoje').textContent = new Date().toLocaleDateString('pt-BR', {weekday:'long', year:'numeric', month:'long', day:'numeric'})

      try {
        const res = await axios.get('/api/tenant')
        document.getElementById('empresa-nome').textContent = res.data.tenant?.nome_empresa || 'Fleet Bridge'
      } catch {}

      // Setup inicial do banco
      try {
        await axios.post('/api/setup')
      } catch {}

      // Carregar dados iniciais
      await loadOverview()
      await loadTimeline()
      await loadAlertas()

      // Auto-refresh
      startAutoRefresh()
    })

    // ============================================================
    // NAVEGAÇÃO
    // ============================================================
    function showSection(name) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'))
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))

      const section = document.getElementById('sec-' + name)
      if (section) section.classList.add('active')

      document.querySelectorAll('.nav-item').forEach(n => {
        if (n.getAttribute('href') === '#' + name) n.classList.add('active')
      })

      document.getElementById('page-title').textContent = {
        torre: 'Torre de Controle',
        mapa: 'Mapa Ao Vivo',
        indicadores: 'Indicadores do Dia',
        ranking: 'Rankings',
        'veiculos-lista': 'Frota',
        config: 'Configurações',
        logs: 'Logs de Coleta'
      }[name] || name

      // Lazy load de seções
      if (name === 'mapa') initMap()
      if (name === 'indicadores') loadIndicadores()
      if (name === 'ranking') loadRanking('risco')
      if (name === 'veiculos-lista') loadVeiculos()
      if (name === 'logs') loadLogs()
    }

    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('open')
    }

    // ============================================================
    // OVERVIEW / KPIs
    // ============================================================
    async function loadOverview() {
      try {
        const res = await axios.get('/api/dashboard/overview')
        const { kpis, eventos_recentes } = res.data

        document.getElementById('kpi-total').textContent = kpis.total_veiculos
        document.getElementById('kpi-online').textContent = kpis.veiculos_online
        document.getElementById('kpi-risco').textContent = kpis.veiculos_risco
        document.getElementById('kpi-score').textContent = kpis.score_medio_frota

        const pct = kpis.total_veiculos > 0 ?
          Math.round((kpis.veiculos_online / kpis.total_veiculos) * 100) : 0
        document.getElementById('kpi-online-pct').textContent = pct + '% da frota'

        // Alertas badge
        if (kpis.alertas_nao_lidos > 0) {
          const badgeEl = document.getElementById('badge-alertas')
          badgeEl.textContent = kpis.alertas_nao_lidos
          badgeEl.classList.remove('hidden')
        }

        // Gráfico de risco
        renderChartRisco(kpis.distribuicao_risco)

        // Distribuição textual
        const total = kpis.total_veiculos || 1
        document.getElementById('dist-risco').innerHTML = \`
          <div class="flex items-center gap-3">
            <div class="w-2 h-2 rounded-full bg-green-400 flex-shrink-0"></div>
            <div class="flex-1 risk-bar"><div style="width:\${Math.round((kpis.distribuicao_risco.verde/total)*100)}%;background:#10b981;height:4px;border-radius:2px;"></div></div>
            <span class="text-xs text-slate-400 w-16">\${kpis.distribuicao_risco.verde} baixo</span>
          </div>
          <div class="flex items-center gap-3">
            <div class="w-2 h-2 rounded-full bg-yellow-400 flex-shrink-0"></div>
            <div class="flex-1 risk-bar"><div style="width:\${Math.round((kpis.distribuicao_risco.amarelo/total)*100)}%;background:#f59e0b;height:4px;border-radius:2px;"></div></div>
            <span class="text-xs text-slate-400 w-16">\${kpis.distribuicao_risco.amarelo} médio</span>
          </div>
          <div class="flex items-center gap-3">
            <div class="w-2 h-2 rounded-full bg-red-400 flex-shrink-0"></div>
            <div class="flex-1 risk-bar"><div style="width:\${Math.round((kpis.distribuicao_risco.vermelho/total)*100)}%;background:#ef4444;height:4px;border-radius:2px;"></div></div>
            <span class="text-xs text-slate-400 w-16">\${kpis.distribuicao_risco.vermelho} alto</span>
          </div>
        \`

        // Atualizar timestamp
        document.getElementById('last-update').textContent =
          'Atualizado: ' + new Date().toLocaleTimeString('pt-BR')

      } catch (err) {
        console.error('Erro ao carregar overview:', err)
      }
    }

    function renderChartRisco(dist) {
      const ctx = document.getElementById('chartRisco').getContext('2d')
      if (chartRisco) chartRisco.destroy()
      chartRisco = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Baixo Risco', 'Risco Moderado', 'Alto Risco'],
          datasets: [{
            data: [dist.verde, dist.amarelo, dist.vermelho],
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
            borderWidth: 0,
            hoverOffset: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '65%',
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (i) => \` \${i.label}: \${i.raw} veículos\` } }
          }
        }
      })
    }

    // ============================================================
    // TIMELINE
    // ============================================================
    async function loadTimeline() {
      try {
        const res = await axios.get('/api/dashboard/timeline?limit=30')
        const eventos = res.data.eventos

        const container = document.getElementById('timeline')

        if (!eventos || eventos.length === 0) {
          container.innerHTML = '<div class="text-slate-500 text-xs text-center py-6">Nenhum evento registrado hoje</div>'
          return
        }

        container.innerHTML = eventos.map(ev => {
          const score = ev.risk_score || 0
          const cor = score >= 61 ? '#ef4444' : score >= 31 ? '#f59e0b' : '#10b981'
          const hora = ev.data_gps ? new Date(ev.data_gps).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : '-'
          return \`
            <div class="timeline-item py-2">
              <div class="timeline-dot" style="background:\${cor}25; border-color:\${cor}"></div>
              <div class="flex items-start gap-2 ml-2">
                <span class="text-xs text-slate-600 w-12 flex-shrink-0 mt-0.5">\${hora}</span>
                <div class="flex-1 min-w-0">
                  <span class="text-xs font-medium text-slate-300">\${ev.placa || ev.descricao || '-'}</span>
                  <span class="text-xs text-slate-500 ml-1">\${ev.evento_nome || 'Posição'}</span>
                  \${ev.velocidade > 0 ? \`<span class="text-xs text-slate-600 ml-1">\${ev.velocidade}km/h</span>\` : ''}
                </div>
                <span class="text-xs px-1.5 py-0.5 rounded font-semibold flex-shrink-0" style="color:\${cor};background:\${cor}20">\${score}</span>
              </div>
            </div>
          \`
        }).join('')
      } catch (err) {
        console.error('Erro timeline:', err)
      }
    }

    // ============================================================
    // ALERTAS
    // ============================================================
    async function loadAlertas() {
      try {
        const res = await axios.get('/api/dashboard/alertas')
        const alertas = res.data.alertas?.filter(a => !a.lido) || []

        const container = document.getElementById('lista-alertas')
        if (alertas.length === 0) {
          container.innerHTML = '<div class="text-slate-500 text-xs text-center py-4"><i class="fas fa-check-circle text-green-400 mr-1"></i>Nenhum alerta ativo</div>'
          return
        }

        container.innerHTML = alertas.slice(0, 10).map(a => \`
          <div class="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 cursor-pointer hover:bg-red-500/15 transition"
               onclick="marcarLido(\${a.id})">
            <i class="fas fa-exclamation-triangle text-red-400 text-xs mt-0.5 flex-shrink-0"></i>
            <div class="flex-1 min-w-0">
              <p class="text-xs text-red-300 font-medium truncate">\${a.placa || a.veiculo_id}</p>
              <p class="text-xs text-slate-400 truncate">\${a.mensagem}</p>
            </div>
          </div>
        \`).join('')
      } catch {}
    }

    async function marcarLido(id) {
      await axios.post('/api/dashboard/alertas/' + id + '/lido')
      loadAlertas()
    }

    async function marcarTodosLidos() {
      const res = await axios.get('/api/dashboard/alertas')
      const alertas = res.data.alertas || []
      await Promise.all(alertas.map(a => axios.post('/api/dashboard/alertas/' + a.id + '/lido')))
      loadAlertas()
      document.getElementById('badge-alertas').classList.add('hidden')
    }

    // ============================================================
    // STATS POR HORA
    // ============================================================
    async function loadStatsHora() {
      try {
        const res = await axios.get('/api/dashboard/stats-hora')
        const stats = res.data.stats || []

        const labels = stats.map(s => s.hora + 'h')
        const dataTotal = stats.map(s => s.total || 0)
        const dataAlertas = stats.map(s => s.alertas || 0)

        const ctx = document.getElementById('chartHoras').getContext('2d')
        if (chartHoras) chartHoras.destroy()
        chartHoras = new Chart(ctx, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              {
                label: 'Posições',
                data: dataTotal,
                backgroundColor: 'rgba(59,130,246,0.3)',
                borderColor: '#3b82f6',
                borderWidth: 1,
                borderRadius: 2
              },
              {
                label: 'Alertas',
                data: dataAlertas,
                backgroundColor: 'rgba(239,68,68,0.3)',
                borderColor: '#ef4444',
                borderWidth: 1,
                borderRadius: 2
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } },
              y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } }
            }
          }
        })
      } catch {}
    }

    // ============================================================
    // MAPA
    // ============================================================
    function initMap() {
      if (mapInstance) {
        loadMapaPosicoes()
        return
      }

      mapInstance = L.map('map', { center: [-15.7942, -47.8822], zoom: 5, zoomControl: true })

      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CartoDB',
        maxZoom: 19
      }).addTo(mapInstance)

      loadMapaPosicoes()
    }

    async function loadMapaPosicoes() {
      if (!mapInstance) return
      try {
        const res = await axios.get('/api/veiculos/mapa/posicoes')
        const veiculos = res.data.veiculos || []

        // Remover marcadores antigos
        Object.values(mapMarkers).forEach(m => m.remove())
        mapMarkers = {}

        const bounds = []

        veiculos.forEach(v => {
          if (!v.latitude || !v.longitude) return

          const cor = v.risk_nivel === 'vermelho' ? '#ef4444' :
                      v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981'

          const html = \`
            <div class="vehicle-marker \${v.status_online ? 'pulse' : ''}" style="background:\${cor}30;border-color:\${cor}">
              <i class="fas fa-car" style="color:\${cor};font-size:11px"></i>
            </div>
          \`

          const icon = L.divIcon({ html, className: '', iconSize: [34, 34], iconAnchor: [17, 17] })
          const marker = L.marker([v.latitude, v.longitude], { icon })

          const popup = \`
            <div style="background:#1e293b;color:#f1f5f9;border-radius:10px;padding:12px;min-width:200px;border:1px solid rgba(148,163,184,0.2)">
              <div style="font-weight:700;font-size:14px;margin-bottom:6px">\${v.placa || v.descricao || 'Veículo'}</div>
              <div style="font-size:12px;color:#94a3b8;space-y:4px">
                <div>\${v.modelo || ''} \${v.marca || ''}</div>
                \${v.motorista_nome ? '<div>🧑 ' + v.motorista_nome + '</div>' : ''}
                <div>🚀 \${v.velocidade || 0} km/h | ➡ \${v.proa || 0}°</div>
                <div style="margin-top:6px">
                  <span style="background:\${cor}25;color:\${cor};padding:2px 8px;border-radius:999px;font-weight:600">Score: \${v.risk_score || 0}</span>
                </div>
                \${v.endereco ? '<div style="margin-top:4px;font-size:11px">' + v.endereco.substring(0,50) + '</div>' : ''}
              </div>
            </div>
          \`

          marker.bindPopup(popup, { className: 'dark-popup', maxWidth: 280 })
          marker.addTo(mapInstance)
          mapMarkers[v.id] = marker
          bounds.push([v.latitude, v.longitude])
        })

        if (bounds.length > 0) {
          mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 })
        }
      } catch (err) {
        console.error('Erro mapa:', err)
      }
    }

    // ============================================================
    // INDICADORES
    // ============================================================
    async function loadIndicadores() {
      try {
        const res = await axios.get('/api/veiculos')
        const veiculos = res.data.veiculos || []

        const container = document.getElementById('indicadores-grid')

        if (veiculos.length === 0) {
          container.innerHTML = '<div class="text-slate-500 text-sm text-center py-10 col-span-3"><i class="fas fa-car mr-2"></i>Nenhum veículo cadastrado.<br><br><button onclick="showModal(\'modal-sync\')" class="btn-primary">Sincronizar Veículos</button></div>'
          return
        }

        container.innerHTML = veiculos.map(v => {
          const cor = v.risk_nivel === 'vermelho' ? '#ef4444' : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981'
          const score = v.risk_score || 0
          const pico = Math.round(v.pico_velocidade_hoje || 0)

          return \`
            <div class="card p-5 hover:border-blue-500/30 transition cursor-pointer">
              <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:\${cor}20">
                    <i class="fas fa-car" style="color:\${cor}"></i>
                  </div>
                  <div>
                    <div class="font-semibold text-sm text-white">\${v.placa || v.id_multiportal}</div>
                    <div class="text-xs text-slate-500">\${v.descricao || v.modelo || '-'}</div>
                  </div>
                </div>
                <span class="badge \${v.status_online ? 'badge-green' : 'badge-blue'}">
                  \${v.status_online ? '🟢 Online' : '⚫ Offline'}
                </span>
              </div>

              <div class="grid grid-cols-3 gap-3 text-center mb-4">
                <div class="bg-slate-800/50 rounded-lg p-2">
                  <div class="text-xs text-slate-500">Vel. Pico</div>
                  <div class="text-base font-bold text-white">\${pico}<span class="text-xs font-normal text-slate-500"> km/h</span></div>
                </div>
                <div class="bg-slate-800/50 rounded-lg p-2">
                  <div class="text-xs text-slate-500">Posições</div>
                  <div class="text-base font-bold text-white">\${v.posicoes_hoje || 0}</div>
                </div>
                <div class="bg-slate-800/50 rounded-lg p-2">
                  <div class="text-xs text-slate-500">Score</div>
                  <div class="text-base font-bold" style="color:\${cor}">\${score}</div>
                </div>
              </div>

              <div class="w-full bg-slate-800 rounded-full h-2">
                <div class="h-2 rounded-full transition-all" style="width:\${score}%;background:linear-gradient(90deg,#10b981,\${cor})"></div>
              </div>
              <div class="text-xs text-right mt-1" style="color:\${cor}">\${score <= 30 ? 'Baixo Risco' : score <= 60 ? 'Risco Moderado' : 'Alto Risco'}</div>
            </div>
          \`
        }).join('')
      } catch (err) {
        console.error('Erro indicadores:', err)
      }
    }

    // ============================================================
    // RANKING
    // ============================================================
    async function loadRanking(tipo, btnEl) {
      if (btnEl) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
        btnEl.classList.add('active')
      }

      const body = document.getElementById('ranking-body')
      body.innerHTML = '<tr><td colspan="6" class="text-center p-8"><div class="loader mx-auto"></div></td></tr>'

      try {
        const res = await axios.get('/api/dashboard/ranking?tipo=' + tipo)
        const ranking = res.data.ranking || []

        if (ranking.length === 0) {
          body.innerHTML = '<tr><td colspan="6" class="text-center p-8 text-slate-500 text-xs">Nenhum dado disponível</td></tr>'
          return
        }

        body.innerHTML = ranking.map((v, i) => {
          const cor = v.risk_nivel === 'vermelho' ? '#ef4444' : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981'
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : \`\${i+1}.\`
          return \`
            <tr class="table-row border-b border-slate-800/50">
              <td class="p-4 text-sm font-bold text-slate-400">\${medal}</td>
              <td class="p-4">
                <div class="text-sm font-medium text-white">\${v.descricao || v.id_multiportal || '-'}</div>
                <div class="text-xs text-slate-500">\${v.frota ? 'Frota: ' + v.frota : ''}</div>
              </td>
              <td class="p-4 text-sm text-slate-300 font-mono">\${v.placa || '-'}</td>
              <td class="p-4">
                <div class="flex items-center gap-2">
                  <div class="flex-1 bg-slate-800 rounded-full h-1.5" style="width:80px">
                    <div class="h-1.5 rounded-full" style="width:\${v.risk_score||0}%;background:\${cor}"></div>
                  </div>
                  <span class="text-sm font-bold" style="color:\${cor}">\${v.risk_score || 0}</span>
                </div>
              </td>
              <td class="p-4 text-sm text-slate-300 hidden md:table-cell">\${Math.round(v.pico_velocidade||0)} km/h</td>
              <td class="p-4 hidden md:table-cell">
                <span class="badge \${v.status_online ? 'badge-green' : 'badge-blue'} text-xs">
                  \${v.status_online ? 'Online' : 'Offline'}
                </span>
              </td>
            </tr>
          \`
        }).join('')
      } catch (err) {
        body.innerHTML = '<tr><td colspan="6" class="text-center p-8 text-slate-500 text-xs">Erro ao carregar ranking</td></tr>'
      }
    }

    // ============================================================
    // VEÍCULOS
    // ============================================================
    async function loadVeiculos() {
      try {
        const res = await axios.get('/api/veiculos')
        const veiculos = res.data.veiculos || []
        const container = document.getElementById('veiculos-grid')

        if (veiculos.length === 0) {
          container.innerHTML = \`
            <div class="col-span-3 text-center py-16">
              <div class="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-4">
                <i class="fas fa-car text-slate-500 text-2xl"></i>
              </div>
              <h3 class="text-white font-semibold mb-2">Nenhum veículo cadastrado</h3>
              <p class="text-slate-500 text-sm mb-4">Sincronize com a Multiportal para importar sua frota</p>
              <button onclick="showModal('modal-sync')" class="btn-primary">
                <i class="fas fa-sync-alt"></i> Sincronizar Frota
              </button>
            </div>
          \`
          return
        }

        container.innerHTML = veiculos.map(v => {
          const cor = v.risk_nivel === 'vermelho' ? '#ef4444' : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981'
          return \`
            <div class="card p-5 hover:border-slate-600 transition">
              <div class="flex items-start justify-between mb-3">
                <div class="flex items-center gap-3">
                  <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:\${cor}15;border:1px solid \${cor}30">
                    <i class="fas fa-\${v.status_online ? 'car' : 'parking'}" style="color:\${cor}"></i>
                  </div>
                  <div>
                    <div class="font-bold text-white text-sm">\${v.placa || '-'}</div>
                    <div class="text-xs text-slate-500">\${v.marca || ''} \${v.modelo || ''}</div>
                  </div>
                </div>
                <span class="badge \${v.status_online ? 'badge-green' : 'badge-blue'}">\${v.status_online ? 'Online' : 'Offline'}</span>
              </div>
              <div class="text-xs text-slate-500 mb-3 truncate">\${v.descricao || 'Sem descrição'}</div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-slate-500">Risk Score</span>
                <span class="font-bold" style="color:\${cor}">\${v.risk_score || 0}/100</span>
              </div>
              <div class="w-full bg-slate-800 rounded-full h-1.5 mt-1.5">
                <div class="h-1.5 rounded-full transition-all" style="width:\${v.risk_score||0}%;background:\${cor}"></div>
              </div>
              <div class="flex items-center justify-between mt-3 pt-3 border-t border-slate-800">
                <span class="text-xs text-slate-600">ID: \${v.id_multiportal}</span>
                \${v.frota ? '<span class="text-xs badge badge-blue">' + v.frota + '</span>' : ''}
              </div>
            </div>
          \`
        }).join('')
      } catch (err) {
        console.error('Erro ao carregar veículos:', err)
      }
    }

    // ============================================================
    // LOGS
    // ============================================================
    async function loadLogs() {
      const body = document.getElementById('logs-body')
      body.innerHTML = '<tr><td colspan="5" class="text-center p-8"><div class="loader mx-auto"></div></td></tr>'

      try {
        const res = await axios.get('/api/sync/logs')
        const logs = res.data.logs || []

        if (logs.length === 0) {
          body.innerHTML = '<tr><td colspan="5" class="text-center p-8 text-slate-500 text-xs">Nenhum log encontrado</td></tr>'
          return
        }

        body.innerHTML = logs.map(l => {
          const cor = l.status === 'ok' ? '#10b981' : l.status === 'sem_dados' ? '#f59e0b' : '#ef4444'
          const data = l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '-'
          return \`
            <tr class="table-row border-b border-slate-800/50">
              <td class="p-4 text-xs text-slate-400">\${data}</td>
              <td class="p-4">
                <span class="badge" style="color:\${cor};background:\${cor}20">
                  \${l.status === 'ok' ? '✓ OK' : l.status === 'sem_dados' ? '∅ Sem dados' : '✗ Erro'}
                </span>
              </td>
              <td class="p-4 text-sm font-semibold text-white">\${l.posicoes_recebidas || 0}</td>
              <td class="p-4 text-xs text-slate-500 hidden md:table-cell">\${l.duracao_ms ? l.duracao_ms + 'ms' : '-'}</td>
              <td class="p-4 text-xs text-slate-400 max-w-xs truncate">\${l.mensagem || '-'}</td>
            </tr>
          \`
        }).join('')
      } catch {}
    }

    // ============================================================
    // COLETA / SINCRONIZAÇÃO
    // ============================================================
    async function coletarDados() {
      const icon = document.getElementById('sync-icon')
      const dot = document.getElementById('dot-status')
      const txt = document.getElementById('txt-status')
      
      icon.classList.add('fa-spin')
      dot.style.background = '#f59e0b'
      txt.textContent = 'Coletando...'

      try {
        const res = await axios.post('/api/sync/coletar')
        const r = res.data

        dot.style.background = r.ok ? '#10b981' : '#ef4444'
        txt.textContent = r.ok ? \`\${r.posicoes || 0} pos.\` : 'Erro'

        // Atualizar dados
        await loadOverview()
        await loadTimeline()
        await loadAlertas()
        await loadStatsHora()
        
        if (mapInstance) loadMapaPosicoes()
        
        showToast(r.ok ? \`✓ Coletado: \${r.posicoes || 0} posições\` : '✗ ' + (r.mensagem || 'Erro'), r.ok ? 'success' : 'error')
      } catch (err) {
        dot.style.background = '#ef4444'
        txt.textContent = 'Erro'
        showToast('Erro ao coletar dados', 'error')
      } finally {
        icon.classList.remove('fa-spin')
      }
    }

    async function testarConexao() {
      const username = document.getElementById('cfg-username').value
      const password = document.getElementById('cfg-password').value
      const appid = document.getElementById('cfg-appid').value

      showCfgResult('Testando conexão...', 'info')

      try {
        const res = await axios.post('/api/sync/test-connection', { username, password, appid })
        showCfgResult(res.data.message || 'Conectado!', 'success')
      } catch (err) {
        showCfgResult(err.response?.data?.message || 'Erro de conexão', 'error')
      }
    }

    async function salvarCredenciais() {
      const username = document.getElementById('cfg-username').value
      const password = document.getElementById('cfg-password').value
      const appid = document.getElementById('cfg-appid').value

      try {
        await axios.post('/api/sync/credentials', { username, password, appid })
        showCfgResult('✓ Credenciais salvas com sucesso!', 'success')
        showToast('Credenciais salvas!', 'success')
      } catch {
        showCfgResult('Erro ao salvar', 'error')
      }
    }

    function showCfgResult(msg, type) {
      const el = document.getElementById('cfg-result')
      el.className = 'text-xs p-3 rounded-lg'
      if (type === 'success') el.classList.add('bg-green-500/20', 'text-green-400', 'border', 'border-green-500/30')
      else if (type === 'error') el.classList.add('bg-red-500/20', 'text-red-400', 'border', 'border-red-500/30')
      else el.classList.add('bg-blue-500/20', 'text-blue-400', 'border', 'border-blue-500/30')
      el.textContent = msg
      el.classList.remove('hidden')
    }

    async function testarEConectarModal() {
      const username = document.getElementById('m-username').value
      const password = document.getElementById('m-password').value
      const appid = document.getElementById('m-appid').value

      const resultEl = document.getElementById('m-result')
      resultEl.className = 'text-xs p-3 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30'
      resultEl.textContent = 'Testando conexão...'
      resultEl.classList.remove('hidden')

      try {
        const testRes = await axios.post('/api/sync/test-connection', { username, password, appid })
        
        if (testRes.data.ok) {
          await axios.post('/api/sync/credentials', { username, password, appid })
          resultEl.className = 'text-xs p-3 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30'
          resultEl.textContent = '✓ ' + testRes.data.message
          setTimeout(async () => {
            closeModal('modal-setup')
            showToast('Multiportal conectado! Sincronizando...', 'success')
            await sincronizarVeiculos()
          }, 1000)
        }
      } catch (err) {
        resultEl.className = 'text-xs p-3 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30'
        resultEl.textContent = '✗ ' + (err.response?.data?.message || 'Falha na conexão')
      }
    }

    async function sincronizarVeiculos() {
      showToast('Sincronizando veículos...', 'info')
      try {
        const res = await axios.post('/api/sync/veiculos')
        showToast('✓ ' + res.data.message, 'success')
        loadVeiculos()
        loadOverview()
      } catch (err) {
        showToast('Erro: ' + (err.response?.data?.error || 'Falha'), 'error')
      }
    }

    async function sincronizarEventos() {
      try {
        const res = await axios.post('/api/sync/eventos')
        showToast('✓ Eventos sincronizados: ' + res.data.total, 'success')
      } catch {
        showToast('Erro ao sincronizar eventos', 'error')
      }
    }

    async function sincronizarMotoristas() {
      try {
        const res = await axios.post('/api/sync/motoristas')
        showToast('✓ Motoristas: ' + res.data.total, 'success')
      } catch {
        showToast('Erro ao sincronizar motoristas', 'error')
      }
    }

    async function syncAndShow(tipo) {
      const resultEl = document.getElementById('sync-result')
      resultEl.className = 'text-xs p-3 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30'
      resultEl.textContent = 'Sincronizando...'
      resultEl.classList.remove('hidden')

      try {
        const res = await axios.post('/api/sync/' + tipo)
        resultEl.className = 'text-xs p-3 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30'
        resultEl.textContent = '✓ ' + (res.data.message || JSON.stringify(res.data))
      } catch (err) {
        resultEl.className = 'text-xs p-3 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30'
        resultEl.textContent = '✗ ' + (err.response?.data?.error || 'Erro')
      }
    }

    // ============================================================
    // AUTO REFRESH
    // ============================================================
    function startAutoRefresh() {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer)
      
      autoRefreshTimer = setInterval(async () => {
        const activeSection = document.querySelector('.section.active')?.id

        if (activeSection === 'sec-torre') {
          await loadOverview()
          await loadTimeline()
          await loadAlertas()
          await loadStatsHora()
        } else if (activeSection === 'sec-mapa') {
          loadMapaPosicoes()
        } else if (activeSection === 'sec-indicadores') {
          loadIndicadores()
        }
      }, AUTO_REFRESH_SEC * 1000)
    }

    // ============================================================
    // MODAIS
    // ============================================================
    function showModal(id) {
      document.getElementById(id).classList.add('open')
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('open')
    }

    // Fechar modal clicando fora
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.remove('open')
      })
    })

    // ============================================================
    // TOAST NOTIFICATIONS
    // ============================================================
    function showToast(msg, type = 'info') {
      const existing = document.getElementById('toast')
      if (existing) existing.remove()

      const toast = document.createElement('div')
      toast.id = 'toast'
      
      const colors = {
        success: 'bg-green-500/20 text-green-400 border-green-500/30',
        error: 'bg-red-500/20 text-red-400 border-red-500/30',
        info: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
      }

      toast.className = \`fixed bottom-5 right-5 z-50 px-4 py-3 rounded-xl text-sm font-medium border backdrop-blur-sm shadow-xl transition-all \${colors[type] || colors.info}\`
      toast.textContent = msg
      document.body.appendChild(toast)

      setTimeout(() => toast.remove(), 4000)
    }

    // ============================================================
    // LOGOUT
    // ============================================================
    function logout() {
      localStorage.removeItem('fleet_token')
      localStorage.removeItem('fleet_user')
      window.location.href = '/login'
    }

    // Inicializar stats hora
    setTimeout(loadStatsHora, 500)
  </script>
</body>
</html>`
}

export default app

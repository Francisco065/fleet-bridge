import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import type { Bindings, Variables } from './types'
import { authMiddleware } from './middleware/auth'
import authRoutes from './routes/auth'
import veiculosRoutes from './routes/veiculos'
import dashboardRoutes from './routes/dashboard'
import syncRoutes from './routes/sync'
import adminRoutes from './routes/admin'
import { coletarTodosTenants } from './services/worker'
import { hashPassword, generateJWT, verifyJWT } from './utils/helpers'

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// CORS
app.use('/api/*', cors({
  origin: ['*'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'token'],
}))

// Arquivos estáticos
app.use('/static/*', serveStatic({ root: './public' }))
// Favicon (evitar 404 no console do browser)
app.get('/favicon.ico', (c) => new Response(null, { status: 204 }))

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
    // Garantir que a senha do admin demo está sempre com hash correto
    await c.env.DB.prepare(`UPDATE usuarios SET senha_hash = ? WHERE email = 'admin@fleetbridge.com.br' AND length(senha_hash) < 20`).bind(senhaHash).run()
    // Criar tabela admins e superadmin padrão
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT,nome TEXT NOT NULL,email TEXT UNIQUE NOT NULL,senha_hash TEXT NOT NULL,ativo INTEGER DEFAULT 1,ultimo_login DATETIME,criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)`).run()
    const superHash = await hashPassword('admin@2024')
    await c.env.DB.prepare(`INSERT OR IGNORE INTO admins (nome,email,senha_hash) VALUES ('Superadmin','superadmin@fleetbridge.com.br',?)`).bind(superHash).run()
    // Criar tabela planos se não existir
    await c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS planos (id INTEGER PRIMARY KEY AUTOINCREMENT,codigo TEXT UNIQUE NOT NULL,nome TEXT NOT NULL,descricao TEXT,max_veiculos INTEGER DEFAULT 10,max_usuarios INTEGER DEFAULT 3,preco_mensal REAL DEFAULT 0,features TEXT,ativo INTEGER DEFAULT 1,criado_em DATETIME DEFAULT CURRENT_TIMESTAMP)`).run()
    await c.env.DB.prepare(`INSERT OR IGNORE INTO planos (codigo,nome,descricao,max_veiculos,max_usuarios,preco_mensal,features) VALUES ('basico','Básico','Até 10 veículos',10,3,199.90,'["dashboard","mapa","alertas"]')`).run()
    await c.env.DB.prepare(`INSERT OR IGNORE INTO planos (codigo,nome,descricao,max_veiculos,max_usuarios,preco_mensal,features) VALUES ('profissional','Profissional','Até 50 veículos',50,10,499.90,'["dashboard","mapa","alertas","relatorios","ranking","api"]')`).run()
    await c.env.DB.prepare(`INSERT OR IGNORE INTO planos (codigo,nome,descricao,max_veiculos,max_usuarios,preco_mensal,features) VALUES ('enterprise','Enterprise','Veículos ilimitados',999,100,1299.90,'["dashboard","mapa","alertas","relatorios","ranking","api","suporte","white-label"]')`).run()
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

    // Inserir posições demo para o dia atual se não existirem
    const hoje = new Date().toISOString().slice(0, 10)
    const countPos = await c.env.DB.prepare(`SELECT COUNT(*) as cnt FROM posicoes WHERE tenant_id=1 AND date(data_gps)=?`).bind(hoje).first<any>()
    if (!countPos || countPos.cnt === 0) {
      // Buscar veículos existentes
      const veics = await c.env.DB.prepare(`SELECT id FROM veiculos WHERE tenant_id=1 LIMIT 5`).all<any>()
      if (veics.results && veics.results.length > 0) {
        const agora = new Date()
        const horas = [0,2,4,6,8,10,12,14,16,18,20,22]
        for (const v of veics.results) {
          for (const h of horas) {
            const ts = new Date(agora)
            ts.setHours(h, 0, 0, 0)
            const dt = ts.toISOString().replace('T', ' ').slice(0,19)
            await c.env.DB.prepare(
              `INSERT OR IGNORE INTO posicoes (tenant_id,veiculo_id,data_gps,latitude,longitude,velocidade,ignicao,online,risk_score,evento_nome) VALUES (1,?,?,?,?,?,1,1,?,?)`
            ).bind(v.id, dt, -23.55 + Math.random()*0.1, -46.63 + Math.random()*0.1, Math.floor(Math.random()*80), Math.floor(Math.random()*30), 'Ignição Ligada').run()
          }
        }
      }
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
// AUTENTICAÇÃO DE SUPERADMIN
// ============================================================

// POST /api/admin/auth/login - Login exclusivo para superadmin
app.post('/api/admin/auth/login', async (c) => {
  try {
    const { email, senha } = await c.req.json()
    if (!email || !senha) return c.json({ error: 'Email e senha obrigatórios' }, 400)

    const admin = await c.env.DB.prepare(
      'SELECT * FROM admins WHERE email = ? AND ativo = 1'
    ).bind(email.toLowerCase().trim()).first<any>()

    if (!admin) return c.json({ error: 'Credenciais inválidas' }, 401)

    const { verifyPassword } = await import('./utils/helpers')
    const valida = await verifyPassword(senha, admin.senha_hash) ||
      (admin.senha_hash.length < 20 && senha === admin.senha_hash)

    if (!valida) return c.json({ error: 'Credenciais inválidas' }, 401)

    const secret = c.env.JWT_SECRET || 'fleetbridge_jwt_secret_2024'
    const token = await generateJWT(
      { sub: String(admin.id), email: admin.email, nome: admin.nome, perfil: 'superadmin', tid: 0 },
      secret, 8
    )

    await c.env.DB.prepare('UPDATE admins SET ultimo_login = datetime("now") WHERE id = ?').bind(admin.id).run()

    return c.json({ token, admin: { id: admin.id, nome: admin.nome, email: admin.email, perfil: 'superadmin' } })
  } catch (err) {
    console.error('[Admin Auth]', err)
    return c.json({ error: 'Erro interno' }, 500)
  }
})

// Middleware de autenticação para rotas /api/admin/*
app.use('/api/admin/*', async (c, next) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Token necessário' }, 401)

  const secret = c.env.JWT_SECRET || 'fleetbridge_jwt_secret_2024'
  const payload = await verifyJWT(token, secret)
  if (!payload) return c.json({ error: 'Token inválido ou expirado' }, 401)
  if ((payload as any).perfil !== 'superadmin') return c.json({ error: 'Acesso restrito a administradores' }, 403)

  c.set('jwtPayload', payload as any)
  await next()
})

// Rotas de administração
app.route('/api/admin', adminRoutes)

// ============================================================
// ROTAS AUTENTICADAS (tenant)
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

// Página de Login do sistema
app.get('/login', (c) => c.html(getLoginPage()))

// Página de Login do Admin
app.get('/admin/login', (c) => c.html(getAdminLoginPage()))

// Painel de Administração
app.get('/admin', (c) => c.html(getAdminPage()))
app.get('/admin/clientes', (c) => c.redirect('/admin'))
app.get('/admin/usuarios', (c) => c.redirect('/admin'))

// Dashboard do tenant (SPA)
app.get('/', (c) => c.html(getDashboardPage()))
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
  <script src="https://cdn.tailwindcss.com"><\/script>
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
  <div class="fixed inset-0 overflow-hidden pointer-events-none">
    <div class="absolute top-1/4 left-1/4 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
    <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl"></div>
  </div>
  <div class="w-full max-w-md relative">
    <div class="text-center mb-8">
      <div class="float inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-2xl shadow-blue-500/30 mb-4">
        <i class="fas fa-route text-white text-3xl"></i>
      </div>
      <h1 class="text-3xl font-bold text-white">Fleet Bridge</h1>
      <p class="text-slate-400 mt-1">Plataforma de Monitoramento Veicular</p>
    </div>
    <div class="glass rounded-2xl p-8 shadow-2xl">
      <h2 class="text-xl font-semibold text-white mb-6">Entrar na plataforma</h2>
      <div id="alert" class="hidden mb-4 p-3 rounded-lg text-sm font-medium"></div>
      <form id="loginForm" autocomplete="on" class="space-y-5">
        <div>
          <label class="block text-sm font-medium text-slate-400 mb-1.5">Email</label>
          <div class="relative">
            <i class="fas fa-envelope absolute left-3.5 top-3.5 text-slate-500 text-sm"></i>
            <input type="email" id="email" name="email" autocomplete="email" value="admin@fleetbridge.com.br"
              class="w-full bg-slate-800/50 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
              placeholder="seu@email.com.br" required>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-slate-400 mb-1.5">Senha</label>
          <div class="relative">
            <i class="fas fa-lock absolute left-3.5 top-3.5 text-slate-500 text-sm"></i>
            <input type="password" id="senha" name="senha" autocomplete="current-password" value="demo123"
              class="w-full bg-slate-800/50 border border-slate-700 rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition"
              placeholder="..." required>
            <button type="button" onclick="toggleSenha()" class="absolute right-3.5 top-3 text-slate-500 hover:text-slate-300 p-0.5">
              <i class="fas fa-eye" id="eyeIcon"></i>
            </button>
          </div>
        </div>
        <button type="submit" id="btnLogin"
          class="btn-gradient w-full py-3 rounded-xl text-white font-semibold text-sm shadow-lg transition-all hover:shadow-blue-500/40 hover:-translate-y-0.5 active:translate-y-0">
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
      var input = document.getElementById('senha');
      var icon = document.getElementById('eyeIcon');
      if (input.type === 'password') { input.type = 'text'; icon.className = 'fas fa-eye-slash'; }
      else { input.type = 'password'; icon.className = 'fas fa-eye'; }
    }
    function showAlert(msg, type) {
      var el = document.getElementById('alert');
      el.className = 'mb-4 p-3 rounded-lg text-sm font-medium';
      if (type === 'error') el.classList.add('bg-red-500/20','text-red-400','border','border-red-500/30');
      else el.classList.add('bg-green-500/20','text-green-400','border','border-green-500/30');
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    document.getElementById('loginForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('btnLogin');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Entrando...';
      var email = document.getElementById('email').value;
      var senha = document.getElementById('senha').value;
      try {
        var res = await fetch('/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({email:email, senha:senha}) });
        var data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('fleet_token', data.token);
          localStorage.setItem('fleet_user', JSON.stringify(data.usuario));
          showAlert('Login realizado! Redirecionando...', 'success');
          setTimeout(function() { window.location.href = '/'; }, 500);
        } else {
          showAlert(data.error || 'Erro ao fazer login', 'error');
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Entrar';
        }
      } catch(err) {
        showAlert('Erro de conexão. Tente novamente.', 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>Entrar';
      }
    });
  <\/script>
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
  <script src="https://cdn.tailwindcss.com"><\/script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"><\/script>
  <style>
    :root { --bg-primary: #0f172a; --bg-secondary: #1e293b; --bg-card: #1e2a3a; --border: rgba(148,163,184,0.1); --text-primary: #f1f5f9; --text-secondary: #94a3b8; --accent: #3b82f6; }
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
    @media (max-width: 768px) { .sidebar { transform: translateX(-260px); } .sidebar.open { transform: translateX(0); } .main-content { margin-left: 0; } }
    .loader { border: 3px solid rgba(59,130,246,0.2); border-top-color: #3b82f6; border-radius: 50%; width: 20px; height: 20px; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .timeline-item { position: relative; padding-left: 24px; }
    .timeline-item::before { content: ''; position: absolute; left: 7px; top: 14px; bottom: -8px; width: 1px; background: var(--border); }
    .timeline-item:last-child::before { display: none; }
    .timeline-dot { position: absolute; left: 0; top: 8px; width: 14px; height: 14px; border-radius: 50%; border: 2px solid; }
  </style>
</head>
<body>
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
        <i class="fas fa-tower-observation"></i><span>Torre de Controle</span>
        <span id="badge-alertas" class="ml-auto badge badge-red hidden">0</span>
      </a>
      <a class="nav-item" onclick="showSection('mapa')" href="#mapa">
        <i class="fas fa-map-marked-alt"></i><span>Mapa Ao Vivo</span>
      </a>
      <a class="nav-item" onclick="showSection('indicadores')" href="#indicadores">
        <i class="fas fa-chart-bar"></i><span>Indicadores do Dia</span>
      </a>
      <div class="px-4 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wider mt-3 mb-1">Análise</div>
      <a class="nav-item" onclick="showSection('ranking')" href="#ranking">
        <i class="fas fa-trophy"></i><span>Rankings</span>
      </a>
      <a class="nav-item" onclick="showSection('veiculos-lista')" href="#veiculos-lista">
        <i class="fas fa-car"></i><span>Veículos</span>
      </a>
      <div class="px-4 py-2 text-xs font-semibold text-slate-600 uppercase tracking-wider mt-3 mb-1">Sistema</div>
      <a class="nav-item" onclick="showSection('config')" href="#config">
        <i class="fas fa-cog"></i><span>Configurações</span>
      </a>
      <a class="nav-item" onclick="showSection('logs')" href="#logs">
        <i class="fas fa-terminal"></i><span>Logs de Coleta</span>
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

  <main class="main-content">
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
          <i class="fas fa-sync-alt"></i><span class="hidden sm:inline">Atualizar</span>
        </button>
        <button onclick="showModal('modal-setup')" class="btn-ghost text-xs py-1.5 px-3">
          <i class="fas fa-plug"></i><span class="hidden sm:inline">Conectar</span>
        </button>
      </div>
    </header>

    <div class="p-5 md:p-6">
      <!-- TORRE DE CONTROLE -->
      <section id="sec-torre" class="section active">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div class="kpi-card card card-glow" style="background: linear-gradient(135deg, #1e293b, #1e3a5f)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Total Veículos</span>
              <div class="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center"><i class="fas fa-car text-blue-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold text-white" id="kpi-total">-</div>
            <div class="text-xs text-slate-500 mt-1">frota cadastrada</div>
          </div>
          <div class="kpi-card card" style="background: linear-gradient(135deg, #1e293b, #052e16)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Online Agora</span>
              <div class="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center"><i class="fas fa-signal text-green-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold text-green-400" id="kpi-online">-</div>
            <div class="text-xs text-slate-500 mt-1" id="kpi-online-pct">transmitindo</div>
          </div>
          <div class="kpi-card card" style="background: linear-gradient(135deg, #1e293b, #2d1515)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Em Risco</span>
              <div class="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center"><i class="fas fa-exclamation-triangle text-red-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold text-red-400" id="kpi-risco">-</div>
            <div class="text-xs text-slate-500 mt-1">score maior 61</div>
          </div>
          <div class="kpi-card card" style="background: linear-gradient(135deg, #1e293b, #1c1a2e)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400 font-medium">Score Médio</span>
              <div class="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center"><i class="fas fa-shield-alt text-purple-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold" id="kpi-score" style="color:#a78bfa">-</div>
            <div class="text-xs text-slate-500 mt-1">risco da frota</div>
          </div>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
          <div class="card p-5 flex flex-col">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-chart-pie text-blue-400"></i> Distribuição de Risco
            </h3>
            <div style="height:180px;position:relative;">
              <canvas id="chartRisco" height="180"></canvas>
            </div>
            <div id="dist-risco" class="mt-4 space-y-2.5"></div>
          </div>
          <div class="card p-5 flex flex-col">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-semibold text-white flex items-center gap-2">
                <i class="fas fa-bell text-yellow-400"></i> Alertas
              </h3>
              <button onclick="marcarTodosLidos()" class="text-xs text-slate-500 hover:text-slate-300 transition"><i class="fas fa-check-double mr-1"></i>Limpar todos</button>
            </div>
            <div id="lista-alertas" class="space-y-1 min-h-[180px] max-h-64 overflow-y-auto">
              <div class="text-slate-500 text-xs text-center py-4">Carregando...</div>
            </div>
          </div>
          <div class="card p-5 flex flex-col">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-chart-area text-green-400"></i> Atividade Hoje
            </h3>
            <div style="height:180px;position:relative;">
              <canvas id="chartHoras" height="180"></canvas>
            </div>
          </div>
        </div>
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

      <!-- MAPA -->
      <section id="sec-mapa" class="section">
        <div class="card overflow-hidden" style="height: calc(100vh - 120px)">
          <div id="map" style="height: 100%; width: 100%;"></div>
        </div>
      </section>

      <!-- INDICADORES -->
      <section id="sec-indicadores" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Indicadores do Dia</h2>
          <div class="text-xs text-slate-500" id="data-hoje"></div>
        </div>
        <div id="indicadores-grid" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div class="text-slate-500 text-sm text-center py-10 col-span-3">Carregando indicadores...</div>
        </div>
      </section>

      <!-- RANKING -->
      <section id="sec-ranking" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Rankings</h2>
          <div class="flex gap-1">
            <button class="tab-btn active" onclick="loadRanking('risco', this)"><i class="fas fa-fire mr-1"></i>Risco</button>
            <button class="tab-btn" onclick="loadRanking('velocidade', this)"><i class="fas fa-tachometer-alt mr-1"></i>Velocidade</button>
            <button class="tab-btn" onclick="loadRanking('ociosidade', this)"><i class="fas fa-clock mr-1"></i>Ociosidade</button>
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
                <th class="text-left p-4 text-xs text-slate-500 font-medium hidden md:table-cell">Métrica</th>
                <th class="text-left p-4 text-xs text-slate-500 font-medium hidden md:table-cell">Status</th>
              </tr>
            </thead>
            <tbody id="ranking-body">
              <tr><td colspan="6" class="text-center p-8 text-slate-500 text-xs">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- VEÍCULOS -->
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

      <!-- CONFIGURAÇÕES -->
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
                <input type="password" id="cfg-password" class="input-field" placeholder="...">
              </div>
              <div>
                <label class="block text-xs text-slate-400 mb-1.5">AppID</label>
                <input type="text" id="cfg-appid" class="input-field" value="portal">
              </div>
              <div class="flex gap-3">
                <button onclick="testarConexao()" class="btn-ghost text-xs"><i class="fas fa-plug"></i> Testar</button>
                <button onclick="salvarCredenciais()" class="btn-primary text-xs"><i class="fas fa-save"></i> Salvar</button>
              </div>
              <div id="cfg-result" class="hidden text-xs p-3 rounded-lg"></div>
            </div>
          </div>
          <div class="card p-6">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-sync text-green-400"></i> Sincronização de Dados
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <button onclick="sincronizarVeiculos()" class="btn-ghost justify-center"><i class="fas fa-car"></i> Veículos</button>
              <button onclick="sincronizarEventos()" class="btn-ghost justify-center"><i class="fas fa-list"></i> Eventos</button>
              <button onclick="sincronizarMotoristas()" class="btn-ghost justify-center"><i class="fas fa-users"></i> Motoristas</button>
              <button onclick="coletarDados()" class="btn-primary justify-center"><i class="fas fa-play"></i> Coletar Agora</button>
            </div>
          </div>
        </div>
      </section>

      <!-- LOGS -->
      <section id="sec-logs" class="section">
        <div class="flex items-center justify-between mb-5">
          <h2 class="text-base font-semibold text-white">Logs de Coleta</h2>
          <button onclick="loadLogs()" class="btn-ghost text-xs"><i class="fas fa-refresh"></i> Atualizar</button>
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

  <!-- Modal: Conectar Multiportal -->
  <div class="modal" id="modal-setup">
    <div class="modal-content">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-semibold text-white"><i class="fas fa-plug text-blue-400 mr-2"></i>Conectar Multiportal</h2>
        <button onclick="closeModal('modal-setup')" class="text-slate-400 hover:text-white"><i class="fas fa-times"></i></button>
      </div>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-slate-400 mb-1.5">Usuário</label>
          <input type="text" id="m-username" class="input-field" placeholder="usuario_multiportal">
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1.5">Senha</label>
          <input type="password" id="m-password" class="input-field" placeholder="...">
        </div>
        <div>
          <label class="block text-xs text-slate-400 mb-1.5">AppID</label>
          <input type="text" id="m-appid" class="input-field" value="portal">
        </div>
        <div id="m-result" class="hidden text-xs p-3 rounded-lg"></div>
        <div class="flex gap-3 pt-2">
          <button onclick="testarEConectarModal()" class="btn-primary flex-1 justify-center"><i class="fas fa-plug"></i> Testar e Salvar</button>
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
        <p class="text-sm text-slate-400">Sincronize os dados da Multiportal:</p>
        <div class="grid grid-cols-1 gap-3">
          <button onclick="syncAndShow('veiculos')" class="btn-ghost justify-start w-full"><i class="fas fa-car text-blue-400"></i> Sincronizar Veículos</button>
          <button onclick="syncAndShow('eventos')" class="btn-ghost justify-start w-full"><i class="fas fa-list text-yellow-400"></i> Sincronizar Eventos</button>
          <button onclick="syncAndShow('motoristas')" class="btn-ghost justify-start w-full"><i class="fas fa-users text-green-400"></i> Sincronizar Motoristas</button>
        </div>
        <div id="sync-result" class="hidden text-xs p-3 rounded-lg mt-3"></div>
      </div>
    </div>
  </div>

  <script src="/static/dashboard.js"><\/script>
</body>
</html>`
}

// ============================================================
// ADMIN LOGIN PAGE
// ============================================================
function getAdminLoginPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Bridge · Administração</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body { margin:0; font-family: 'Inter', system-ui, sans-serif; background: #030712; min-height:100vh; display:flex; align-items:center; justify-content:center; }
    .glass { background: rgba(15,23,42,0.85); backdrop-filter: blur(24px); border: 1px solid rgba(148,163,184,0.08); border-radius: 24px; }
    .btn { width:100%; padding:12px; border-radius:12px; border:none; cursor:pointer; font-size:14px; font-weight:600; transition:all .2s; }
    .btn-admin { background: linear-gradient(135deg, #dc2626, #991b1b); color:#fff; }
    .btn-admin:hover { background: linear-gradient(135deg, #b91c1c, #7f1d1d); transform:translateY(-1px); }
    .inp { width:100%; background:rgba(2,6,23,0.7); border:1px solid rgba(148,163,184,0.12); border-radius:10px; padding:11px 14px; color:#f1f5f9; font-size:13px; outline:none; transition:border .2s; }
    .inp:focus { border-color:#dc2626; box-shadow:0 0 0 3px rgba(220,38,38,0.12); }
    .alert { border-radius:10px; padding:10px 14px; font-size:13px; margin-bottom:16px; display:none; }
    .alert-error { background:rgba(220,38,38,0.12); border:1px solid rgba(220,38,38,0.25); color:#f87171; }
    .bg-grid { position:fixed; inset:0; background-image: radial-gradient(circle at 20% 50%, rgba(220,38,38,0.06) 0%, transparent 50%), radial-gradient(circle at 80% 20%, rgba(239,68,68,0.04) 0%, transparent 40%); pointer-events:none; }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="glass w-full max-w-sm mx-4 p-8">
    <div class="flex flex-col items-center mb-8">
      <div class="w-14 h-14 rounded-2xl bg-gradient-to-br from-red-600 to-red-900 flex items-center justify-center shadow-lg mb-4">
        <i class="fas fa-shield-alt text-white text-xl"></i>
      </div>
      <h1 class="text-xl font-bold text-white">Painel Administrativo</h1>
      <p class="text-xs text-slate-500 mt-1">Fleet Bridge · Acesso restrito</p>
    </div>

    <div id="alert" class="alert alert-error"><i class="fas fa-exclamation-circle mr-2"></i><span id="alert-msg"></span></div>

    <form id="form" class="space-y-4">
      <div>
        <label class="block text-xs text-slate-400 mb-1.5 font-medium">E-mail do administrador</label>
        <input type="email" id="email" class="inp" placeholder="admin@fleetbridge.com.br" required autocomplete="email">
      </div>
      <div class="relative">
        <label class="block text-xs text-slate-400 mb-1.5 font-medium">Senha</label>
        <input type="password" id="senha" class="inp" placeholder="••••••••" required autocomplete="current-password">
        <button type="button" onclick="toggleSenha()" class="absolute right-3 top-8 text-slate-500 hover:text-slate-300">
          <i class="fas fa-eye text-xs" id="eye-icon"></i>
        </button>
      </div>
      <button type="submit" class="btn btn-admin mt-2" id="btn-login">
        <i class="fas fa-lock mr-2"></i>Entrar no Painel
      </button>
    </form>

    <div class="mt-6 text-center">
      <a href="/login" class="text-xs text-slate-600 hover:text-slate-400 transition">
        <i class="fas fa-arrow-left mr-1"></i>Voltar ao login de clientes
      </a>
    </div>
  </div>

  <script>
    function toggleSenha() {
      var inp = document.getElementById('senha');
      var ico = document.getElementById('eye-icon');
      if (inp.type === 'password') { inp.type = 'text'; ico.className = 'fas fa-eye-slash text-xs'; }
      else { inp.type = 'password'; ico.className = 'fas fa-eye text-xs'; }
    }

    document.getElementById('form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('btn-login');
      var alertEl = document.getElementById('alert');
      alertEl.style.display = 'none';
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>Autenticando...';

      try {
        var res = await fetch('/api/admin/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('email').value,
            senha: document.getElementById('senha').value
          })
        });
        var data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('admin_token', data.token);
          localStorage.setItem('admin_user', JSON.stringify(data.admin));
          window.location.href = '/admin';
        } else {
          document.getElementById('alert-msg').textContent = data.error || 'Erro ao autenticar';
          alertEl.style.display = 'block';
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Entrar no Painel';
        }
      } catch(err) {
        document.getElementById('alert-msg').textContent = 'Erro de conexão. Tente novamente.';
        alertEl.style.display = 'block';
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-lock mr-2"></i>Entrar no Painel';
      }
    });
  </script>
</body>
</html>`
}

// ============================================================
// ADMIN PANEL PAGE
// ============================================================
function getAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fleet Bridge · Gestão de Clientes</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"><\/script>
  <style>
    :root { --bg: #030712; --card: #0f172a; --card2: #111827; --border: rgba(148,163,184,0.08); --red: #dc2626; --red-light: rgba(220,38,38,0.12); }
    * { box-sizing:border-box; }
    body { margin:0; font-family:'Inter',system-ui,sans-serif; background:var(--bg); color:#f1f5f9; min-height:100vh; }
    ::-webkit-scrollbar { width:5px; } ::-webkit-scrollbar-track { background:#0f172a; } ::-webkit-scrollbar-thumb { background:#1e293b; border-radius:3px; }
    .sidebar { width:240px; background:var(--card); border-right:1px solid var(--border); height:100vh; position:fixed; left:0; top:0; display:flex; flex-direction:column; z-index:100; }
    .main { margin-left:240px; min-height:100vh; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:16px; }
    .card2 { background:var(--card2); border:1px solid var(--border); border-radius:12px; }
    .badge { display:inline-flex; align-items:center; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:600; }
    .badge-green  { background:rgba(16,185,129,.12); color:#34d399; }
    .badge-red    { background:rgba(220,38,38,.12);  color:#f87171; }
    .badge-yellow { background:rgba(245,158,11,.12); color:#fbbf24; }
    .badge-blue   { background:rgba(59,130,246,.12); color:#60a5fa; }
    .badge-purple { background:rgba(139,92,246,.12); color:#a78bfa; }
    .btn-primary { background:linear-gradient(135deg,#dc2626,#991b1b); color:#fff; border:none; padding:8px 16px; border-radius:9px; cursor:pointer; font-size:13px; font-weight:600; transition:all .2s; display:inline-flex; align-items:center; gap:6px; }
    .btn-primary:hover { opacity:.9; transform:translateY(-1px); }
    .btn-ghost { background:transparent; color:#94a3b8; border:1px solid var(--border); padding:7px 14px; border-radius:9px; cursor:pointer; font-size:12px; transition:all .2s; display:inline-flex; align-items:center; gap:6px; }
    .btn-ghost:hover { border-color:#dc2626; color:#f1f5f9; }
    .btn-sm { padding:5px 12px; font-size:11px; border-radius:7px; }
    .nav-item { display:flex; align-items:center; gap:10px; padding:9px 14px; border-radius:9px; cursor:pointer; font-size:13px; font-weight:500; color:#94a3b8; transition:all .2s; margin:2px 8px; text-decoration:none; }
    .nav-item:hover { background:var(--red-light); color:#fca5a5; }
    .nav-item.active { background:var(--red-light); color:#f87171; }
    .inp { width:100%; background:#030712; border:1px solid var(--border); border-radius:9px; padding:9px 12px; color:#f1f5f9; font-size:13px; outline:none; transition:border .2s; }
    .inp:focus { border-color:var(--red); box-shadow:0 0 0 3px rgba(220,38,38,.1); }
    .inp-sm { padding:6px 10px; font-size:12px; border-radius:7px; }
    select.inp { cursor:pointer; }
    .section { display:none; } .section.active { display:block; }
    .modal { display:none; position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,.75); backdrop-filter:blur(6px); align-items:center; justify-content:center; overflow-y:auto; padding:20px; }
    .modal.open { display:flex; }
    .modal-box { background:var(--card); border:1px solid var(--border); border-radius:20px; padding:28px; width:100%; max-width:680px; max-height:90vh; overflow-y:auto; }
    .tab-btn { padding:7px 14px; border-radius:7px; font-size:12px; font-weight:500; cursor:pointer; transition:all .2s; background:transparent; color:#94a3b8; border:none; }
    .tab-btn.active { background:var(--red-light); color:#f87171; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .form-grid.cols3 { grid-template-columns:1fr 1fr 1fr; }
    .form-group { display:flex; flex-direction:column; gap:5px; }
    .form-group.full { grid-column:1/-1; }
    label.form-label { font-size:11px; color:#64748b; font-weight:500; }
    .table-row:hover { background:rgba(220,38,38,0.03); }
    tr.table-row { border-bottom:1px solid var(--border); }
    .stat-card { border-radius:16px; padding:20px; position:relative; overflow:hidden; }
    .kpi-icon { width:38px; height:38px; border-radius:10px; display:flex; align-items:center; justify-content:center; }
    .loader { border:3px solid rgba(220,38,38,0.2); border-top-color:#dc2626; border-radius:50%; width:22px; height:22px; animation:spin .8s linear infinite; display:inline-block; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media(max-width:768px) { .sidebar { transform:translateX(-240px); } .sidebar.open { transform:translateX(0); } .main { margin-left:0; } .form-grid { grid-template-columns:1fr; } }
    .search-box { background:#030712; border:1px solid var(--border); border-radius:9px; padding:8px 12px 8px 34px; color:#f1f5f9; font-size:13px; outline:none; width:220px; }
    .search-box:focus { border-color:var(--red); }
    .empty-state { display:flex; flex-direction:column; align-items:center; padding:60px 20px; gap:12px; }
  </style>
</head>
<body>

  <!-- Sidebar -->
  <nav class="sidebar" id="sidebar">
    <div class="p-5 border-b border-slate-800/50">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-red-600 to-red-900 flex items-center justify-center shadow-lg">
          <i class="fas fa-shield-alt text-white text-sm"></i>
        </div>
        <div>
          <div class="font-bold text-white text-sm">Fleet Bridge</div>
          <div class="text-xs text-red-400 font-semibold">Administração</div>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto py-3 px-1">
      <div class="px-4 py-2 text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">Menu</div>
      <a class="nav-item active" onclick="showSection('dashboard')" href="#dashboard">
        <i class="fas fa-chart-pie w-4 text-center"></i><span>Visão Geral</span>
      </a>
      <a class="nav-item" onclick="showSection('clientes')" href="#clientes">
        <i class="fas fa-building w-4 text-center"></i><span>Clientes</span>
        <span id="badge-total" class="ml-auto badge badge-red text-xs hidden">0</span>
      </a>
      <a class="nav-item" onclick="showSection('planos')" href="#planos">
        <i class="fas fa-layer-group w-4 text-center"></i><span>Planos</span>
      </a>
    </div>

    <div class="p-4 border-t border-slate-800/50">
      <div class="flex items-center gap-3 mb-3">
        <div class="w-8 h-8 rounded-lg bg-red-900/50 flex items-center justify-center">
          <i class="fas fa-user-shield text-red-400 text-xs"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-slate-300 truncate" id="admin-nome">Admin</div>
          <div class="text-xs text-red-400">Superadmin</div>
        </div>
      </div>
      <button onclick="adminLogout()" class="w-full text-xs text-slate-500 hover:text-red-400 transition flex items-center justify-center gap-2 py-1.5">
        <i class="fas fa-sign-out-alt"></i> Sair
      </button>
    </div>
  </nav>

  <!-- Main -->
  <main class="main">
    <header class="h-14 bg-slate-950/80 backdrop-blur-sm border-b border-slate-800/50 flex items-center px-5 sticky top-0 z-50">
      <button class="md:hidden mr-3 text-slate-400" onclick="toggleSidebar()"><i class="fas fa-bars"></i></button>
      <h1 class="text-sm font-semibold text-white" id="page-title">Visão Geral</h1>
      <div class="ml-auto flex items-center gap-3">
        <button onclick="showModal('modal-novo-cliente')" class="btn-primary text-xs py-1.5">
          <i class="fas fa-plus"></i><span class="hidden sm:inline">Novo Cliente</span>
        </button>
      </div>
    </header>

    <div class="p-5 md:p-6">

      <!-- ===== DASHBOARD GERAL ===== -->
      <section id="sec-dashboard" class="section active">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6" id="kpi-grid">
          <div class="stat-card card" style="background:linear-gradient(135deg,#0f172a,#1c0505)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400">Clientes Ativos</span>
              <div class="kpi-icon bg-red-500/15"><i class="fas fa-building text-red-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold text-white" id="k-ativos">-</div>
            <div class="text-xs text-slate-500 mt-1">empresas cadastradas</div>
          </div>
          <div class="stat-card card" style="background:linear-gradient(135deg,#0f172a,#05131c)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400">Total Usuários</span>
              <div class="kpi-icon bg-blue-500/15"><i class="fas fa-users text-blue-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold text-blue-400" id="k-usuarios">-</div>
            <div class="text-xs text-slate-500 mt-1">acessos ativos</div>
          </div>
          <div class="stat-card card" style="background:linear-gradient(135deg,#0f172a,#0a1a06)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400">Total Veículos</span>
              <div class="kpi-icon bg-green-500/15"><i class="fas fa-car text-green-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold text-green-400" id="k-veiculos">-</div>
            <div class="text-xs text-slate-500 mt-1">monitorados</div>
          </div>
          <div class="stat-card card" style="background:linear-gradient(135deg,#0f172a,#0f0a1a)">
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs text-slate-400">Novos (30d)</span>
              <div class="kpi-icon bg-purple-500/15"><i class="fas fa-user-plus text-purple-400 text-xs"></i></div>
            </div>
            <div class="text-3xl font-bold" style="color:#a78bfa" id="k-novos">-</div>
            <div class="text-xs text-slate-500 mt-1">novos clientes</div>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
          <!-- Por plano -->
          <div class="card p-5">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-layer-group text-red-400"></i> Distribuição por Plano
            </h3>
            <div id="dist-planos" class="space-y-3">
              <div class="loader mx-auto"></div>
            </div>
          </div>
          <!-- Últimos clientes -->
          <div class="card p-5">
            <h3 class="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <i class="fas fa-clock text-blue-400"></i> Últimos Cadastros
            </h3>
            <div id="ultimos-clientes" class="space-y-2">
              <div class="loader mx-auto"></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ===== CLIENTES ===== -->
      <section id="sec-clientes" class="section">
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-3 mb-5">
          <div class="relative flex-1 min-w-[200px]">
            <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-600 text-xs"></i>
            <input type="text" id="search-input" class="search-box w-full" placeholder="Buscar empresa, CNPJ, responsável...">
          </div>
          <select id="filter-status" class="inp inp-sm" style="width:auto">
            <option value="">Todos os status</option>
            <option value="ativo">Ativo</option>
            <option value="inativo">Inativo</option>
          </select>
          <select id="filter-plano" class="inp inp-sm" style="width:auto">
            <option value="">Todos os planos</option>
            <option value="basico">Básico</option>
            <option value="profissional">Profissional</option>
            <option value="enterprise">Enterprise</option>
          </select>
          <button onclick="loadClientes()" class="btn-ghost btn-sm"><i class="fas fa-sync-alt"></i> Atualizar</button>
          <button onclick="showModal('modal-novo-cliente')" class="btn-primary btn-sm"><i class="fas fa-plus"></i> Novo Cliente</button>
        </div>

        <!-- Tabela -->
        <div class="card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="border-b border-slate-800/60">
                  <th class="text-left p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Empresa</th>
                  <th class="text-left p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell">Responsável</th>
                  <th class="text-left p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell">Plano</th>
                  <th class="text-left p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden lg:table-cell">Veículos</th>
                  <th class="text-left p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th class="text-left p-4 text-xs font-semibold text-slate-500 uppercase tracking-wider hidden md:table-cell">Cadastro</th>
                  <th class="p-4"></th>
                </tr>
              </thead>
              <tbody id="clientes-tbody">
                <tr><td colspan="7" class="text-center p-10"><div class="loader mx-auto"></div></td></tr>
              </tbody>
            </table>
          </div>
          <!-- Paginação -->
          <div id="pagination" class="flex items-center justify-between p-4 border-t border-slate-800/50 text-xs text-slate-500">
            <span id="pagination-info">-</span>
            <div class="flex gap-2" id="pagination-btns"></div>
          </div>
        </div>
      </section>

      <!-- ===== PLANOS ===== -->
      <section id="sec-planos" class="section">
        <div id="planos-grid" class="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div class="loader mx-auto col-span-3 mt-10"></div>
        </div>
      </section>

    </div>
  </main>

  <!-- ===== MODAL: NOVO / EDITAR CLIENTE ===== -->
  <div class="modal" id="modal-novo-cliente">
    <div class="modal-box">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-base font-semibold text-white flex items-center gap-2">
          <i class="fas fa-building text-red-400"></i>
          <span id="modal-title">Novo Cliente</span>
        </h2>
        <button onclick="closeModal('modal-novo-cliente')" class="text-slate-500 hover:text-white transition"><i class="fas fa-times"></i></button>
      </div>

      <!-- Abas -->
      <div class="flex gap-1 mb-6 border-b border-slate-800 pb-3">
        <button class="tab-btn active" onclick="showTab('empresa')" id="tab-empresa">
          <i class="fas fa-building mr-1"></i>Empresa
        </button>
        <button class="tab-btn" onclick="showTab('responsavel')" id="tab-responsavel">
          <i class="fas fa-user-tie mr-1"></i>Responsável
        </button>
        <button class="tab-btn" onclick="showTab('endereco')" id="tab-endereco">
          <i class="fas fa-map-marker-alt mr-1"></i>Endereço
        </button>
        <button class="tab-btn" onclick="showTab('contrato')" id="tab-contrato">
          <i class="fas fa-file-contract mr-1"></i>Contrato
        </button>
      </div>

      <form id="form-cliente">
        <input type="hidden" id="cliente-id">

        <!-- ABA: EMPRESA -->
        <div id="tab-content-empresa" class="tab-content">
          <div class="form-grid">
            <div class="form-group full">
              <label class="form-label">Razão Social / Nome da Empresa *</label>
              <input type="text" id="f-nome" class="inp" placeholder="Ex: Transportes Silva Ltda" required>
            </div>
            <div class="form-group">
              <label class="form-label">CNPJ</label>
              <input type="text" id="f-cnpj" class="inp" placeholder="00.000.000/0001-00" maxlength="18">
            </div>
            <div class="form-group">
              <label class="form-label">Telefone Comercial</label>
              <input type="text" id="f-telefone" class="inp" placeholder="(11) 99999-9999">
            </div>
            <div class="form-group">
              <label class="form-label">E-mail de Acesso *</label>
              <input type="email" id="f-email" class="inp" placeholder="admin@empresa.com.br" required>
            </div>
            <div class="form-group" id="senha-group">
              <label class="form-label">Senha de Acesso *</label>
              <input type="password" id="f-senha" class="inp" placeholder="Mínimo 6 caracteres">
            </div>
          </div>
        </div>

        <!-- ABA: RESPONSÁVEL -->
        <div id="tab-content-responsavel" class="tab-content hidden">
          <div class="form-grid">
            <div class="form-group full">
              <label class="form-label">Nome do Responsável *</label>
              <input type="text" id="f-resp-nome" class="inp" placeholder="Nome completo do responsável">
            </div>
            <div class="form-group">
              <label class="form-label">Cargo / Função</label>
              <input type="text" id="f-resp-cargo" class="inp" placeholder="Ex: Gerente de Frota">
            </div>
            <div class="form-group">
              <label class="form-label">Telefone do Responsável</label>
              <input type="text" id="f-resp-telefone" class="inp" placeholder="(11) 99999-9999">
            </div>
          </div>
          <div class="mt-4 p-4 rounded-xl" style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.12)">
            <p class="text-xs text-blue-400 flex items-start gap-2">
              <i class="fas fa-info-circle mt-0.5 flex-shrink-0"></i>
              O responsável será vinculado como usuário <strong>admin</strong> da empresa, com acesso ao e-mail cadastrado na aba Empresa.
            </p>
          </div>
        </div>

        <!-- ABA: ENDEREÇO -->
        <div id="tab-content-endereco" class="tab-content hidden">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">CEP</label>
              <input type="text" id="f-cep" class="inp" placeholder="00000-000" maxlength="9" oninput="buscaCep(this.value)">
            </div>
            <div class="form-group full">
              <label class="form-label">Logradouro</label>
              <input type="text" id="f-logradouro" class="inp" placeholder="Rua, Av., etc.">
            </div>
            <div class="form-group">
              <label class="form-label">Número</label>
              <input type="text" id="f-numero" class="inp" placeholder="Nº">
            </div>
            <div class="form-group">
              <label class="form-label">Complemento</label>
              <input type="text" id="f-complemento" class="inp" placeholder="Sala, Bloco...">
            </div>
            <div class="form-group">
              <label class="form-label">Bairro</label>
              <input type="text" id="f-bairro" class="inp" placeholder="Bairro">
            </div>
            <div class="form-group">
              <label class="form-label">Cidade</label>
              <input type="text" id="f-cidade" class="inp" placeholder="Cidade">
            </div>
            <div class="form-group">
              <label class="form-label">UF</label>
              <select id="f-uf" class="inp">
                <option value="">Selecione</option>
                <option>AC</option><option>AL</option><option>AP</option><option>AM</option>
                <option>BA</option><option>CE</option><option>DF</option><option>ES</option>
                <option>GO</option><option>MA</option><option>MT</option><option>MS</option>
                <option>MG</option><option>PA</option><option>PB</option><option>PR</option>
                <option>PE</option><option>PI</option><option>RJ</option><option>RN</option>
                <option>RS</option><option>RO</option><option>RR</option><option>SC</option>
                <option selected>SP</option><option>SE</option><option>TO</option>
              </select>
            </div>
          </div>
        </div>

        <!-- ABA: CONTRATO -->
        <div id="tab-content-contrato" class="tab-content hidden">
          <div class="form-grid">
            <div class="form-group">
              <label class="form-label">Plano Contratado *</label>
              <select id="f-plano" class="inp">
                <option value="basico">Básico — até 10 veículos</option>
                <option value="profissional">Profissional — até 50 veículos</option>
                <option value="enterprise">Enterprise — ilimitado</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Qtd. Veículos no Contrato</label>
              <input type="number" id="f-qtd-veiculos" class="inp" placeholder="0" min="0">
            </div>
            <div class="form-group">
              <label class="form-label">Data de Contrato</label>
              <input type="date" id="f-data-contrato" class="inp">
            </div>
            <div class="form-group">
              <label class="form-label">Data de Vencimento</label>
              <input type="date" id="f-data-vencimento" class="inp">
            </div>
            <div class="form-group full">
              <label class="form-label">Observações Internas</label>
              <textarea id="f-obs" class="inp" rows="3" placeholder="Informações internas sobre o cliente..."></textarea>
            </div>
          </div>
        </div>

        <!-- Resultado / Erro -->
        <div id="form-result" class="hidden mt-4 text-xs p-3 rounded-xl"></div>

        <!-- Botões -->
        <div class="flex gap-3 pt-5 border-t border-slate-800 mt-5">
          <button type="submit" class="btn-primary flex-1 justify-center" id="btn-salvar">
            <i class="fas fa-save"></i> Salvar Cliente
          </button>
          <button type="button" onclick="closeModal('modal-novo-cliente')" class="btn-ghost">Cancelar</button>
        </div>
      </form>
    </div>
  </div>

  <!-- ===== MODAL: DETALHE CLIENTE ===== -->
  <div class="modal" id="modal-detalhe">
    <div class="modal-box" style="max-width:750px">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-semibold text-white" id="detalhe-titulo">Detalhes do Cliente</h2>
        <button onclick="closeModal('modal-detalhe')" class="text-slate-500 hover:text-white"><i class="fas fa-times"></i></button>
      </div>
      <div id="detalhe-content">
        <div class="loader mx-auto"></div>
      </div>
    </div>
  </div>

  <!-- ===== MODAL: NOVO USUÁRIO ===== -->
  <div class="modal" id="modal-novo-usuario">
    <div class="modal-box" style="max-width:440px">
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-base font-semibold text-white"><i class="fas fa-user-plus text-green-400 mr-2"></i>Novo Usuário</h2>
        <button onclick="closeModal('modal-novo-usuario')" class="text-slate-500 hover:text-white"><i class="fas fa-times"></i></button>
      </div>
      <form id="form-usuario" class="space-y-4">
        <input type="hidden" id="nu-tenant-id">
        <div class="form-group">
          <label class="form-label">Nome Completo *</label>
          <input type="text" id="nu-nome" class="inp" placeholder="Nome do usuário" required>
        </div>
        <div class="form-group">
          <label class="form-label">E-mail *</label>
          <input type="email" id="nu-email" class="inp" placeholder="usuario@empresa.com.br" required>
        </div>
        <div class="form-group">
          <label class="form-label">Senha *</label>
          <input type="password" id="nu-senha" class="inp" placeholder="Mínimo 6 caracteres" required>
        </div>
        <div class="form-group">
          <label class="form-label">Perfil</label>
          <select id="nu-perfil" class="inp">
            <option value="admin">Administrador</option>
            <option value="operador" selected>Operador</option>
            <option value="visualizacao">Somente Visualização</option>
          </select>
        </div>
        <div id="nu-result" class="hidden text-xs p-3 rounded-xl"></div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="btn-primary flex-1 justify-center"><i class="fas fa-save"></i> Criar Usuário</button>
          <button type="button" onclick="closeModal('modal-novo-usuario')" class="btn-ghost">Cancelar</button>
        </div>
      </form>
    </div>
  </div>

  <script src="/static/admin.js"><\/script>
</body>
</html>`
}

export default app

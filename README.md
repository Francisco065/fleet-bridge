# Fleet Bridge 🚗

## Plataforma SaaS de Monitoramento Veicular em Tempo Real

### Visão Geral
Fleet Bridge é uma plataforma SaaS profissional para monitoramento de frotas integrada à API Multiportal, com motor próprio de análise de risco e arquitetura multi-tenant escalável.

---

## 🌐 URLs
- **Aplicação**: http://localhost:3000 (sandbox)
- **Login**: http://localhost:3000/login
- **Health**: http://localhost:3000/health

## 🔐 Acesso Demo
- **Email**: `admin@fleetbridge.com.br`
- **Senha**: `demo123`

---

## ✅ Funcionalidades Implementadas

### Backend
- [x] Autenticação JWT com multi-tenant
- [x] Integração completa API Multiportal v1.8
- [x] Gerenciamento automático de token (renovação antes de expirar)
- [x] Worker de coleta em tempo real (`/api/sync/coletar`)
- [x] Motor de Risk Score 0-100 (verde/amarelo/vermelho)
- [x] CRUD completo de veículos, posições, eventos, motoristas
- [x] Sistema de alertas automáticos
- [x] Logs de coleta estruturados
- [x] Banco D1 multi-tenant com migrations

### Frontend
- [x] Dashboard Torre de Controle (KPIs em tempo real)
- [x] Mapa ao vivo com Leaflet (ícones coloridos por risco)
- [x] Indicadores diários por veículo
- [x] Rankings de risco, velocidade e ociosidade
- [x] Timeline de eventos em tempo real
- [x] Sistema de alertas com notificações
- [x] Tela de configurações (credenciais Multiportal)
- [x] Logs de coleta
- [x] Auto-refresh a cada 30 segundos
- [x] Dark mode premium

---

## 🔌 API Endpoints

### Públicos
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/health` | Status do serviço |
| POST | `/api/auth/login` | Login (email, senha) |
| POST | `/api/auth/register` | Criar conta |
| POST | `/api/setup` | Inicializar banco (idempotente) |

### Autenticados (Bearer JWT)
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/dashboard/overview` | KPIs gerais |
| GET | `/api/dashboard/ranking` | Rankings (?tipo=risco/velocidade/ociosidade) |
| GET | `/api/dashboard/timeline` | Eventos recentes |
| GET | `/api/dashboard/alertas` | Lista de alertas |
| GET | `/api/veiculos` | Lista de veículos |
| GET | `/api/veiculos/mapa/posicoes` | Posições para mapa |
| GET | `/api/veiculos/:id` | Detalhes de veículo |
| POST | `/api/sync/coletar` | Forçar coleta manual |
| POST | `/api/sync/veiculos` | Sincronizar frota |
| POST | `/api/sync/credentials` | Salvar credenciais Multiportal |
| POST | `/api/sync/test-connection` | Testar conexão Multiportal |
| GET | `/api/sync/logs` | Logs de coleta |

---

## 🧠 Motor de Risk Score

### Critérios de Pontuação
| Condição | Pontos |
|----------|--------|
| Velocidade > 140km/h | +45 |
| Velocidade > 110km/h | +30 |
| Velocidade > 60km/h | +15 |
| Evento crítico (pânico, jammer) | +40-50 |
| Evento de alerta (frenagem, curva) | +20-25 |
| Ociosidade > 60min | +20 |
| Frequência alta de eventos | +10-20 |
| **Decaimento gradual** | -20% por ciclo sem eventos |

### Classificação
- 🟢 **0-30**: Baixo Risco
- 🟡 **31-60**: Risco Moderado
- 🔴 **61-100**: Alto Risco

---

## 🏗 Arquitetura Técnica

```
fleet-bridge/
├── src/
│   ├── index.tsx          # App principal Hono + páginas HTML
│   ├── types/index.ts     # TypeScript types
│   ├── middleware/auth.ts # JWT middleware
│   ├── routes/
│   │   ├── auth.ts        # Login/Registro
│   │   ├── veiculos.ts    # CRUD veículos
│   │   ├── dashboard.ts   # KPIs e métricas
│   │   └── sync.ts        # Integração Multiportal
│   ├── services/
│   │   ├── multiportal.ts # Cliente API Multiportal
│   │   └── worker.ts      # Worker coleta real-time
│   └── utils/
│       ├── riskScore.ts   # Motor de risco
│       └── helpers.ts     # JWT, hash, formatação
├── migrations/            # Schema D1
└── ecosystem.config.cjs   # PM2 config
```

---

## 📊 Banco de Dados (Cloudflare D1)

### Tabelas
- `tenants` - Empresas clientes
- `usuarios` - Usuários por tenant
- `veiculos` - Frota sincronizada da Multiportal
- `motoristas` - Motoristas da Multiportal
- `eventos` - Catálogo de eventos com pesos de risco
- `posicoes` - Telemetria GPS (tabela crítica)
- `alertas` - Alertas gerados automaticamente
- `logs_coleta` - Logs de cada ciclo de coleta

---

## 🚀 Como Usar

### 1. Setup inicial
```bash
npm install
npm run build
npm run db:migrate:local
pm2 start ecosystem.config.cjs
```

### 2. Conectar Multiportal
1. Acesse `/login` com credenciais demo
2. Clique em **"Conectar"** no header
3. Informe usuário/senha/appid da Multiportal
4. Clique em **"Testar e Salvar"**
5. Aguarde sincronização automática

### 3. Coleta em tempo real
- A coleta pode ser acionada manualmente pelo botão **"Atualizar"**
- O endpoint `/api/internal/collect` pode ser agendado externamente (cron)
- Recomendado: chamar a cada 10-20 segundos via cron externo

---

## ⚙️ Configuração para Produção (Cloudflare Pages)

```bash
# 1. Criar banco D1
npx wrangler d1 create fleet-bridge-production

# 2. Atualizar wrangler.jsonc com o database_id real

# 3. Aplicar migrations em produção
npx wrangler d1 migrations apply fleet-bridge-production

# 4. Deploy
npm run deploy:prod
```

---

## 📦 Stack Tecnológica
- **Backend**: Hono (TypeScript) no Cloudflare Workers
- **Banco**: Cloudflare D1 (SQLite distribuído)
- **Frontend**: HTML/TailwindCSS/Vanilla JS
- **Mapa**: Leaflet.js
- **Gráficos**: Chart.js
- **Autenticação**: JWT (HS256 via Web Crypto API)

---

**Versão**: 1.0.0 | **Última atualização**: 28/02/2026

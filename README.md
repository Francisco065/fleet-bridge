# Fleet Bridge 🚗

## Plataforma SaaS de Monitoramento Veicular em Tempo Real

Fleet Bridge é uma plataforma SaaS profissional para monitoramento de frotas integrada à API Multiportal, com motor próprio de análise de risco e arquitetura multi-tenant escalável.

---

## 🌐 URLs de Produção
- **Aplicação (Tenants)**: https://fleet-bridge.pages.dev
- **Login Tenant**: https://fleet-bridge.pages.dev/login
- **Painel Administrativo**: https://fleet-bridge.pages.dev/admin
- **Login Admin**: https://fleet-bridge.pages.dev/admin/login
- **GitHub**: https://github.com/Francisco065/fleet-bridge

---

## 🔐 Credenciais de Acesso

### Painel Administrativo (Superadmin)
- **URL**: https://fleet-bridge.pages.dev/admin/login
- **Email**: `superadmin@fleetbridge.com.br`
- **Senha**: `admin@2024`

### Tenant Demo (Empresa)
- **URL**: https://fleet-bridge.pages.dev/login
- **Email**: `admin@fleetbridge.com.br`
- **Senha**: `demo123`

---

## ✅ Funcionalidades Implementadas

### Painel Administrativo (/admin)
- ✅ Login exclusivo para superadmin (JWT separado, perfil `superadmin`)
- ✅ Dashboard com KPIs: clientes ativos, usuários, veículos, novos cadastros (30d)
- ✅ Distribuição de clientes por plano (Básico/Profissional/Enterprise)
- ✅ Lista dos últimos cadastros
- ✅ **Gestão de Clientes (Tenants)**: CRUD completo com busca, filtros e paginação
- ✅ **Formulário multi-abas**: Empresa → Responsável → Endereço → Contrato
- ✅ Busca automática de CEP via ViaCEP
- ✅ Modal de detalhe do cliente (stats, responsável, usuários vinculados)
- ✅ **Gestão de Usuários por Tenant**: criação, edição e desativação
- ✅ Visualização de planos disponíveis com features e preços
- ✅ Ativação/desativação de clientes

### Dashboard do Tenant (/)
- ✅ Torre de Controle (KPIs: total, online, em risco, score médio)
- ✅ Gráfico de Distribuição de Risco (Chart.js, doughnut)
- ✅ Gráfico de Atividade Hoje (Chart.js, barras horárias)
- ✅ Alertas em tempo real
- ✅ Timeline de eventos
- ✅ Mapa ao vivo (Leaflet.js, dark theme)
- ✅ Indicadores do Dia por veículo
- ✅ Rankings (risco, velocidade, ociosidade)
- ✅ Lista de Veículos
- ✅ Configurações de integração Multiportal
- ✅ Logs de coleta

### Backend / API
- ✅ Autenticação JWT multi-perfil (admin, operador, superadmin)
- ✅ Motor de risco próprio (score 0-100 com pesos por evento)
- ✅ Integração Multiportal (coleta de posições, veículos, motoristas, eventos)
- ✅ Multi-tenancy completo (segregação total de dados por tenant)
- ✅ D1 Database (Cloudflare SQLite edge)
- ✅ Migrations versionadas (0001, 0002, 0003)

---

## 🏗️ Arquitetura

### Tecnologias
- **Runtime**: Cloudflare Workers (edge)
- **Framework**: Hono v4
- **Banco de Dados**: Cloudflare D1 (SQLite distribuído)
- **Frontend**: HTML + Tailwind CSS (CDN) + Chart.js + Leaflet.js + Axios
- **Build**: Vite + TypeScript

### Estrutura Multi-Tenant
```
Superadmin (admins table)
  └── Tenant A (tenants table)  ← empresa/cliente
        ├── Usuario(s) (usuarios table)
        ├── Veículos (veiculos table)
        ├── Motoristas (motoristas table)
        └── Dados: posicoes, alertas, eventos, logs
  └── Tenant B
        └── ...
```

### Planos Disponíveis
| Plano | Veículos | Usuários | Preço/mês |
|-------|----------|----------|-----------|
| Básico | 10 | 3 | R$ 199,90 |
| Profissional | 50 | 10 | R$ 499,90 |
| Enterprise | Ilimitado | 100 | R$ 1.299,90 |

---

## 🔑 APIs Principais

### Autenticação
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| POST | `/api/auth/login` | Login de tenant |
| POST | `/api/admin/auth/login` | Login de superadmin |
| GET | `/api/auth/me` | Dados do usuário logado |

### Admin (requer perfil superadmin)
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/admin/dashboard` | Métricas gerais |
| GET | `/api/admin/clientes` | Listar clientes (paginado, busca, filtro) |
| POST | `/api/admin/clientes` | Criar novo cliente |
| PUT | `/api/admin/clientes/:id` | Atualizar cliente |
| DELETE | `/api/admin/clientes/:id` | Desativar cliente |
| POST | `/api/admin/clientes/:id/reativar` | Reativar cliente |
| GET | `/api/admin/clientes/:id/usuarios` | Usuários do tenant |
| POST | `/api/admin/clientes/:id/usuarios` | Criar usuário no tenant |
| PUT | `/api/admin/usuarios/:id` | Atualizar usuário |
| GET | `/api/admin/planos` | Listar planos disponíveis |

### Dashboard do Tenant
| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/api/dashboard/overview` | KPIs da frota |
| GET | `/api/dashboard/timeline` | Eventos recentes |
| GET | `/api/dashboard/alertas` | Alertas ativos |
| GET | `/api/dashboard/stats-hora` | Atividade por hora |
| GET | `/api/dashboard/ranking` | Ranking de veículos |
| GET | `/api/veiculos` | Lista de veículos |
| GET | `/api/veiculos/mapa/posicoes` | Posições para o mapa |

---

## 🗄️ Banco de Dados (Migrations)

| Arquivo | Descrição |
|---------|-----------|
| `0001_initial_schema.sql` | Schema completo (tenants, usuarios, veiculos, motoristas, eventos, posicoes, alertas, logs_coleta) |
| `0002_seed.sql` | Dados iniciais e eventos padrão |
| `0003_admin_clientes.sql` | Campos estendidos (CNPJ, telefone, endereço, contrato), tabelas `planos` e `admins` |

---

## 🚀 Deploy

### Produção
```bash
npm run build
npx wrangler pages deploy dist --project-name fleet-bridge
npx wrangler d1 migrations apply fleet-bridge-production --remote
```

### Local (Sandbox)
```bash
npm run build
pm2 start ecosystem.config.cjs
npx wrangler d1 migrations apply fleet-bridge-production --local
```

### Status
- **Plataforma**: Cloudflare Pages ✅
- **Banco (D1)**: fleet-bridge-production ✅
- **Última atualização**: 2026-03-06
- **Commit**: 85b6d6e

---

## 📋 Próximos Passos Sugeridos

- [ ] Dashboard de relatórios (exportação PDF/Excel)
- [ ] Notificações por e-mail (alertas críticos)
- [ ] App mobile (PWA)
- [ ] API pública com autenticação por API key
- [ ] Integração com mais rastreadores (além do Multiportal)
- [ ] Painel financeiro (controle de faturas/cobranças)
- [ ] Geofences configuráveis por tenant

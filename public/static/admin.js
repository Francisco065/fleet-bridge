// Fleet Bridge - Admin Panel JavaScript
// ============================================================
// AUTH CHECK
// ============================================================
let adminToken = localStorage.getItem('admin_token');
let adminUser  = JSON.parse(localStorage.getItem('admin_user') || '{}');

if (!adminToken) {
  window.location.href = '/admin/login';
}

// Config axios
if (window.axios) {
  axios.defaults.headers.common['Authorization'] = 'Bearer ' + adminToken;
}

let currentPage   = 1;
let totalPages    = 1;
let editingId     = null;
let activeSection = 'dashboard';

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', async function() {
  if (window.axios) {
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + adminToken;
  }

  // Exibir nome do admin
  const nomeEl = document.getElementById('admin-nome');
  if (nomeEl) nomeEl.textContent = adminUser.nome || 'Admin';

  // Definir data padrão contrato = hoje
  const today = new Date().toISOString().slice(0, 10);
  const dtContrato = document.getElementById('f-data-contrato');
  if (dtContrato) dtContrato.value = today;

  await loadDashboard();
  showSection('dashboard');

  // Fechar modais ao clicar fora
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
  });

  // Form cliente
  const formCliente = document.getElementById('form-cliente');
  if (formCliente) formCliente.addEventListener('submit', salvarCliente);

  // Form usuário
  const formUsuario = document.getElementById('form-usuario');
  if (formUsuario) formUsuario.addEventListener('submit', salvarUsuario);

  // Busca com debounce
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { currentPage = 1; loadClientes(); }, 400);
    });
  }

  // Filtros
  ['filter-status', 'filter-plano'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { currentPage = 1; loadClientes(); });
  });

  // Máscara CNPJ
  const cnpjInp = document.getElementById('f-cnpj');
  if (cnpjInp) cnpjInp.addEventListener('input', e => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 14);
    v = v.replace(/^(\d{2})(\d)/, '$1.$2')
         .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
         .replace(/\.(\d{3})(\d)/, '.$1/$2')
         .replace(/(\d{4})(\d)/, '$1-$2');
    e.target.value = v;
  });

  // Máscara CEP
  const cepInp = document.getElementById('f-cep');
  if (cepInp) cepInp.addEventListener('input', e => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 8);
    if (v.length > 5) v = v.slice(0,5) + '-' + v.slice(5);
    e.target.value = v;
  });
});

// ============================================================
// NAVEGAÇÃO
// ============================================================
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const sec = document.getElementById('sec-' + name);
  if (sec) sec.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.getAttribute('href') === '#' + name) n.classList.add('active');
  });

  const titles = { dashboard: 'Visão Geral', clientes: 'Gestão de Clientes', planos: 'Planos' };
  const pageTitle = document.getElementById('page-title');
  if (pageTitle) pageTitle.textContent = titles[name] || name;

  activeSection = name;
  if (name === 'clientes') loadClientes();
  if (name === 'planos')   loadPlanos();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

// ============================================================
// DASHBOARD ADMIN
// ============================================================
async function loadDashboard() {
  try {
    const res = await axios.get('/api/admin/dashboard');
    const { stats, por_plano, ultimos_clientes } = res.data;

    setEl('k-ativos',   stats?.clientes_ativos   || 0);
    setEl('k-usuarios', stats?.total_usuarios     || 0);
    setEl('k-veiculos', stats?.total_veiculos     || 0);
    setEl('k-novos',    stats?.novos_30d          || 0);

    // Distribuição por plano
    const distEl = document.getElementById('dist-planos');
    if (distEl && por_plano) {
      const total = por_plano.reduce((s, p) => s + p.total, 0) || 1;
      const colors = { basico: '#3b82f6', profissional: '#f59e0b', enterprise: '#dc2626' };
      const labels = { basico: 'Básico', profissional: 'Profissional', enterprise: 'Enterprise' };
      distEl.innerHTML = por_plano.length === 0
        ? '<p class="text-slate-600 text-xs text-center py-4">Nenhum dado disponível</p>'
        : por_plano.map(p => {
            const cor   = colors[p.plano] || '#94a3b8';
            const label = labels[p.plano] || p.plano;
            const pct   = Math.round((p.total / total) * 100);
            return `<div class="flex items-center gap-3">
              <div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${cor}"></div>
              <div class="flex-1 bg-slate-800 rounded-full h-1.5">
                <div style="width:${pct}%;background:${cor};height:6px;border-radius:999px;transition:width .4s"></div>
              </div>
              <span class="text-xs text-slate-400 w-28 text-right">${p.total} ${label}</span>
            </div>`;
          }).join('');
    }

    // Últimos clientes
    const ultiEl = document.getElementById('ultimos-clientes');
    if (ultiEl && ultimos_clientes) {
      ultiEl.innerHTML = ultimos_clientes.length === 0
        ? '<p class="text-slate-600 text-xs text-center py-4">Nenhum cliente cadastrado</p>'
        : ultimos_clientes.map(c => `
          <div class="flex items-center gap-3 p-2.5 rounded-xl hover:bg-slate-800/40 cursor-pointer transition" onclick="verDetalhe(${c.id})">
            <div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">
              <i class="fas fa-building text-red-400 text-xs"></i>
            </div>
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold text-white truncate">${c.nome_empresa}</div>
              <div class="text-xs text-slate-500 truncate">${c.email_admin}</div>
            </div>
            <div class="text-right">
              ${planoBadge(c.plano)}
              <div class="text-xs text-slate-600 mt-0.5">${formatDate(c.criado_em)}</div>
            </div>
          </div>`).join('');
    }

    // Badge total
    const badgeEl = document.getElementById('badge-total');
    if (badgeEl && stats?.total_clientes) {
      badgeEl.textContent = stats.total_clientes;
      badgeEl.classList.remove('hidden');
    }
  } catch (err) {
    console.error('Erro dashboard admin:', err);
    if (err.response?.status === 401 || err.response?.status === 403) {
      adminLogout();
    }
  }
}

// ============================================================
// CLIENTES
// ============================================================
async function loadClientes() {
  const tbody = document.getElementById('clientes-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="text-center p-10"><div class="loader mx-auto"></div></td></tr>';

  try {
    const search = document.getElementById('search-input')?.value || '';
    const status = document.getElementById('filter-status')?.value || '';
    const plano  = document.getElementById('filter-plano')?.value  || '';

    const params = new URLSearchParams({ page: currentPage, limit: 15 });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (plano)  params.set('plano', plano);

    const res  = await axios.get('/api/admin/clientes?' + params.toString());
    const { clientes, pagination } = res.data;

    totalPages = pagination.pages || 1;

    if (clientes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <div class="w-14 h-14 rounded-2xl bg-slate-800 flex items-center justify-center">
          <i class="fas fa-building text-slate-600 text-xl"></i>
        </div>
        <p class="text-slate-400 text-sm font-medium">Nenhum cliente encontrado</p>
        <p class="text-slate-600 text-xs">Cadastre o primeiro cliente clicando em "+ Novo Cliente"</p>
        <button onclick="showModal('modal-novo-cliente')" class="btn-primary btn-sm mt-2">
          <i class="fas fa-plus"></i> Novo Cliente
        </button>
      </div></td></tr>`;
    } else {
      tbody.innerHTML = clientes.map(c => `
        <tr class="table-row">
          <td class="p-4">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">
                <i class="fas fa-building text-red-400 text-xs"></i>
              </div>
              <div>
                <div class="text-sm font-semibold text-white">${esc(c.nome_empresa)}</div>
                <div class="text-xs text-slate-500">${esc(c.email_admin)}</div>
                ${c.cnpj ? `<div class="text-xs text-slate-600">${esc(c.cnpj)}</div>` : ''}
              </div>
            </div>
          </td>
          <td class="p-4 hidden md:table-cell">
            <div class="text-xs text-slate-300">${esc(c.responsavel_nome || '-')}</div>
            <div class="text-xs text-slate-500">${esc(c.responsavel_cargo || '')}</div>
          </td>
          <td class="p-4 hidden lg:table-cell">${planoBadge(c.plano)}</td>
          <td class="p-4 hidden lg:table-cell">
            <div class="text-sm text-white">${c.total_veiculos || 0}</div>
            <div class="text-xs text-slate-500">cadastrados</div>
          </td>
          <td class="p-4">${statusBadge(c.status)}</td>
          <td class="p-4 hidden md:table-cell">
            <div class="text-xs text-slate-400">${formatDate(c.criado_em)}</div>
          </td>
          <td class="p-4">
            <div class="flex items-center gap-1.5">
              <button onclick="verDetalhe(${c.id})" class="btn-ghost btn-sm" title="Ver detalhes">
                <i class="fas fa-eye"></i>
              </button>
              <button onclick="editarCliente(${c.id})" class="btn-ghost btn-sm" title="Editar">
                <i class="fas fa-edit"></i>
              </button>
              <button onclick="toggleStatus(${c.id}, '${c.status}')" class="btn-ghost btn-sm" title="${c.status === 'ativo' ? 'Desativar' : 'Ativar'}"
                style="${c.status === 'ativo' ? 'color:#f87171' : 'color:#34d399'}">
                <i class="fas fa-${c.status === 'ativo' ? 'ban' : 'check-circle'}"></i>
              </button>
            </div>
          </td>
        </tr>`).join('');
    }

    // Paginação
    renderPagination(pagination);
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center p-8 text-red-400 text-xs"><i class="fas fa-exclamation-circle mr-2"></i>Erro ao carregar clientes</td></tr>';
    console.error(err);
  }
}

function renderPagination(p) {
  const infoEl  = document.getElementById('pagination-info');
  const btnsEl  = document.getElementById('pagination-btns');
  if (!infoEl || !btnsEl) return;

  const start = (p.page - 1) * p.limit + 1;
  const end   = Math.min(p.page * p.limit, p.total);
  infoEl.textContent = p.total > 0 ? `Exibindo ${start}–${end} de ${p.total} clientes` : 'Nenhum resultado';

  btnsEl.innerHTML = '';
  if (p.pages <= 1) return;

  const mkBtn = (label, pg, disabled, active) => {
    const b = document.createElement('button');
    b.className = 'btn-ghost btn-sm' + (active ? ' border-red-500/50 text-red-400' : '');
    b.innerHTML = label;
    b.disabled  = disabled;
    if (!disabled) b.onclick = () => { currentPage = pg; loadClientes(); };
    return b;
  };

  btnsEl.appendChild(mkBtn('<i class="fas fa-chevron-left"></i>', p.page - 1, p.page <= 1));
  for (let i = Math.max(1, p.page - 2); i <= Math.min(p.pages, p.page + 2); i++) {
    btnsEl.appendChild(mkBtn(i, i, false, i === p.page));
  }
  btnsEl.appendChild(mkBtn('<i class="fas fa-chevron-right"></i>', p.page + 1, p.page >= p.pages));
}

// ============================================================
// DETALHE DO CLIENTE
// ============================================================
async function verDetalhe(id) {
  showModal('modal-detalhe');
  const content = document.getElementById('detalhe-content');
  if (content) content.innerHTML = '<div class="loader mx-auto my-10"></div>';

  try {
    const res = await axios.get('/api/admin/clientes/' + id);
    const { cliente: c, usuarios, stats } = res.data;

    document.getElementById('detalhe-titulo').textContent = c.nome_empresa;

    content.innerHTML = `
      <!-- Cabeçalho -->
      <div class="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          ${c.cnpj ? `<div class="text-xs text-slate-500 mb-1"><i class="fas fa-id-card mr-1"></i>${esc(c.cnpj)}</div>` : ''}
          <div class="text-xs text-slate-400">${esc(c.email_admin)}</div>
          ${c.telefone ? `<div class="text-xs text-slate-400"><i class="fas fa-phone mr-1"></i>${esc(c.telefone)}</div>` : ''}
        </div>
        <div class="flex gap-2 flex-wrap">
          ${planoBadge(c.plano)}
          ${statusBadge(c.status)}
        </div>
      </div>

      <!-- Stats -->
      <div class="grid grid-cols-3 gap-3 mb-5">
        <div class="card2 p-3 text-center">
          <div class="text-xl font-bold text-white">${stats?.total_veiculos || 0}</div>
          <div class="text-xs text-slate-500">Veículos</div>
        </div>
        <div class="card2 p-3 text-center">
          <div class="text-xl font-bold text-blue-400">${usuarios?.length || 0}</div>
          <div class="text-xs text-slate-500">Usuários</div>
        </div>
        <div class="card2 p-3 text-center">
          <div class="text-xl font-bold text-green-400">${stats?.coletas_ok || 0}</div>
          <div class="text-xs text-slate-500">Coletas OK</div>
        </div>
      </div>

      <!-- Responsável -->
      ${c.responsavel_nome ? `
      <div class="card2 p-4 mb-4">
        <div class="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Responsável</div>
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-blue-500/10 flex items-center justify-center">
            <i class="fas fa-user-tie text-blue-400 text-xs"></i>
          </div>
          <div>
            <div class="text-sm font-medium text-white">${esc(c.responsavel_nome)}</div>
            <div class="text-xs text-slate-500">${esc(c.responsavel_cargo || '')}${c.responsavel_telefone ? ' · ' + esc(c.responsavel_telefone) : ''}</div>
          </div>
        </div>
      </div>` : ''}

      <!-- Endereço -->
      ${c.endereco_cidade ? `
      <div class="card2 p-4 mb-4">
        <div class="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Endereço</div>
        <div class="text-xs text-slate-300">
          ${[c.endereco_logradouro, c.endereco_numero, c.endereco_complemento, c.endereco_bairro, c.endereco_cidade + (c.endereco_uf ? '/' + c.endereco_uf : ''), c.endereco_cep].filter(Boolean).join(', ')}
        </div>
      </div>` : ''}

      <!-- Contrato -->
      <div class="card2 p-4 mb-5">
        <div class="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Contrato</div>
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div><span class="text-slate-500">Plano:</span> <span class="text-white capitalize">${c.plano || '-'}</span></div>
          <div><span class="text-slate-500">Qtd. Veículos:</span> <span class="text-white">${c.qtd_veiculos_contrato || 0}</span></div>
          <div><span class="text-slate-500">Início:</span> <span class="text-white">${c.data_contrato || '-'}</span></div>
          <div><span class="text-slate-500">Vencimento:</span> <span class="text-white">${c.data_vencimento || '-'}</span></div>
        </div>
        ${c.observacoes ? `<div class="mt-2 text-xs text-slate-400 border-t border-slate-700/50 pt-2">${esc(c.observacoes)}</div>` : ''}
      </div>

      <!-- Usuários -->
      <div class="mb-4">
        <div class="flex items-center justify-between mb-3">
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Usuários (${usuarios?.length || 0})</div>
          <button onclick="abrirNovoUsuario(${c.id})" class="btn-primary btn-sm">
            <i class="fas fa-user-plus"></i> Adicionar Usuário
          </button>
        </div>
        ${usuarios && usuarios.length > 0 ? `
        <div class="space-y-2">
          ${usuarios.map(u => `
          <div class="card2 p-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg ${u.perfil === 'admin' ? 'bg-red-500/10' : 'bg-blue-500/10'} flex items-center justify-center">
                <i class="fas fa-${u.perfil === 'admin' ? 'user-shield' : 'user'} text-${u.perfil === 'admin' ? 'red' : 'blue'}-400 text-xs"></i>
              </div>
              <div>
                <div class="text-xs font-medium text-white">${esc(u.nome)}</div>
                <div class="text-xs text-slate-500">${esc(u.email)}</div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="badge ${u.perfil === 'admin' ? 'badge-red' : 'badge-blue'}">${u.perfil}</span>
              <span class="badge ${u.ativo ? 'badge-green' : 'badge-red'}">${u.ativo ? 'Ativo' : 'Inativo'}</span>
              <button onclick="toggleUsuario(${u.id}, ${u.ativo})" class="btn-ghost btn-sm" style="color:${u.ativo ? '#f87171' : '#34d399'}">
                <i class="fas fa-${u.ativo ? 'ban' : 'check'}"></i>
              </button>
            </div>
          </div>`).join('')}
        </div>` : `<p class="text-slate-600 text-xs text-center py-4 card2 p-4">Nenhum usuário cadastrado</p>`}
      </div>

      <!-- Botões -->
      <div class="flex gap-3 pt-3 border-t border-slate-800">
        <button onclick="editarCliente(${c.id}); closeModal('modal-detalhe')" class="btn-ghost flex-1 justify-center btn-sm">
          <i class="fas fa-edit"></i> Editar
        </button>
        <button onclick="toggleStatus(${c.id}, '${c.status}'); closeModal('modal-detalhe')" 
          class="btn-ghost flex-1 justify-center btn-sm" style="${c.status === 'ativo' ? 'color:#f87171' : 'color:#34d399'}">
          <i class="fas fa-${c.status === 'ativo' ? 'ban' : 'check-circle'}"></i>
          ${c.status === 'ativo' ? 'Desativar' : 'Reativar'}
        </button>
      </div>`;
  } catch (err) {
    if (content) content.innerHTML = '<p class="text-red-400 text-xs text-center py-8"><i class="fas fa-exclamation-circle mr-2"></i>Erro ao carregar detalhes</p>';
  }
}

// ============================================================
// NOVO / EDITAR CLIENTE
// ============================================================
function abrirNovoCliente() {
  editingId = null;
  document.getElementById('modal-title').textContent = 'Novo Cliente';
  document.getElementById('cliente-id').value = '';
  document.getElementById('btn-salvar').innerHTML = '<i class="fas fa-save"></i> Salvar Cliente';

  // Limpar campos
  ['f-nome','f-cnpj','f-telefone','f-email','f-senha',
   'f-resp-nome','f-resp-cargo','f-resp-telefone',
   'f-cep','f-logradouro','f-numero','f-complemento','f-bairro','f-cidade',
   'f-qtd-veiculos','f-obs'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const uf = document.getElementById('f-uf');
  if (uf) uf.value = 'SP';
  const plano = document.getElementById('f-plano');
  if (plano) plano.value = 'basico';

  // Campo senha obrigatório para novo
  const senhaGroup = document.getElementById('senha-group');
  if (senhaGroup) {
    const inp = document.getElementById('f-senha');
    if (inp) inp.required = true;
    senhaGroup.classList.remove('hidden');
  }

  document.getElementById('form-result')?.classList.add('hidden');
  showTab('empresa');
  showModal('modal-novo-cliente');
}

async function editarCliente(id) {
  editingId = id;
  try {
    const res = await axios.get('/api/admin/clientes/' + id);
    const c   = res.data.cliente;

    document.getElementById('modal-title').textContent = 'Editar: ' + c.nome_empresa;
    document.getElementById('cliente-id').value = id;
    document.getElementById('btn-salvar').innerHTML = '<i class="fas fa-save"></i> Atualizar Cliente';

    setVal('f-nome',           c.nome_empresa);
    setVal('f-cnpj',           c.cnpj);
    setVal('f-telefone',       c.telefone);
    setVal('f-email',          c.email_admin);
    setVal('f-resp-nome',      c.responsavel_nome);
    setVal('f-resp-cargo',     c.responsavel_cargo);
    setVal('f-resp-telefone',  c.responsavel_telefone);
    setVal('f-cep',            c.endereco_cep);
    setVal('f-logradouro',     c.endereco_logradouro);
    setVal('f-numero',         c.endereco_numero);
    setVal('f-complemento',    c.endereco_complemento);
    setVal('f-bairro',         c.endereco_bairro);
    setVal('f-cidade',         c.endereco_cidade);
    setVal('f-uf',             c.endereco_uf || 'SP');
    setVal('f-plano',          c.plano || 'basico');
    setVal('f-qtd-veiculos',   c.qtd_veiculos_contrato || 0);
    setVal('f-data-contrato',  c.data_contrato);
    setVal('f-data-vencimento',c.data_vencimento);
    setVal('f-obs',            c.observacoes);

    // Senha não obrigatória na edição
    const senhaGroup = document.getElementById('senha-group');
    const senhaInp   = document.getElementById('f-senha');
    if (senhaGroup && senhaInp) {
      senhaInp.required = false;
      senhaInp.value    = '';
      const label = senhaGroup.querySelector('.form-label');
      if (label) label.textContent = 'Nova Senha (deixe vazio para manter)';
    }

    document.getElementById('form-result')?.classList.add('hidden');
    showTab('empresa');
    showModal('modal-novo-cliente');
  } catch (err) {
    showToast('Erro ao carregar dados do cliente', 'error');
  }
}

async function salvarCliente(e) {
  e.preventDefault();
  const btn  = document.getElementById('btn-salvar');
  const res  = document.getElementById('form-result');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';
  if (res) res.classList.add('hidden');

  const payload = {
    nome_empresa:         document.getElementById('f-nome')?.value?.trim(),
    email_admin:          document.getElementById('f-email')?.value?.trim(),
    cnpj:                 document.getElementById('f-cnpj')?.value?.trim()            || null,
    telefone:             document.getElementById('f-telefone')?.value?.trim()        || null,
    responsavel_nome:     document.getElementById('f-resp-nome')?.value?.trim()       || null,
    responsavel_cargo:    document.getElementById('f-resp-cargo')?.value?.trim()      || null,
    responsavel_telefone: document.getElementById('f-resp-telefone')?.value?.trim()   || null,
    endereco_cep:         document.getElementById('f-cep')?.value?.trim()             || null,
    endereco_logradouro:  document.getElementById('f-logradouro')?.value?.trim()      || null,
    endereco_numero:      document.getElementById('f-numero')?.value?.trim()          || null,
    endereco_complemento: document.getElementById('f-complemento')?.value?.trim()     || null,
    endereco_bairro:      document.getElementById('f-bairro')?.value?.trim()          || null,
    endereco_cidade:      document.getElementById('f-cidade')?.value?.trim()          || null,
    endereco_uf:          document.getElementById('f-uf')?.value                      || null,
    plano:                document.getElementById('f-plano')?.value                   || 'basico',
    qtd_veiculos_contrato: parseInt(document.getElementById('f-qtd-veiculos')?.value) || 0,
    data_contrato:        document.getElementById('f-data-contrato')?.value           || null,
    data_vencimento:      document.getElementById('f-data-vencimento')?.value         || null,
    observacoes:          document.getElementById('f-obs')?.value?.trim()             || null,
  };

  const senha = document.getElementById('f-senha')?.value?.trim();
  if (!editingId && !senha) {
    showFormResult('A senha é obrigatória para novos clientes.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Salvar Cliente';
    return;
  }
  if (senha) payload.senha = senha;

  try {
    let response;
    if (editingId) {
      response = await axios.put('/api/admin/clientes/' + editingId, payload);
    } else {
      response = await axios.post('/api/admin/clientes', payload);
    }
    showFormResult(response.data.message || 'Salvo com sucesso!', 'success');
    setTimeout(() => {
      closeModal('modal-novo-cliente');
      loadDashboard();
      if (activeSection === 'clientes') loadClientes();
      showToast(editingId ? 'Cliente atualizado!' : 'Cliente criado com sucesso!', 'success');
    }, 1200);
  } catch (err) {
    showFormResult(err.response?.data?.error || 'Erro ao salvar. Tente novamente.', 'error');
    btn.disabled = false;
    btn.innerHTML = editingId ? '<i class="fas fa-save"></i> Atualizar Cliente' : '<i class="fas fa-save"></i> Salvar Cliente';
  }
}

// ============================================================
// TOGGLE STATUS
// ============================================================
async function toggleStatus(id, statusAtual) {
  if (!confirm(statusAtual === 'ativo' ? 'Desativar este cliente?' : 'Reativar este cliente?')) return;
  try {
    if (statusAtual === 'ativo') {
      await axios.delete('/api/admin/clientes/' + id);
      showToast('Cliente desativado.', 'info');
    } else {
      await axios.post('/api/admin/clientes/' + id + '/reativar');
      showToast('Cliente reativado!', 'success');
    }
    loadClientes();
    loadDashboard();
  } catch (err) {
    showToast('Erro ao alterar status.', 'error');
  }
}

// ============================================================
// USUÁRIOS
// ============================================================
function abrirNovoUsuario(tenantId) {
  document.getElementById('nu-tenant-id').value = tenantId;
  ['nu-nome','nu-email','nu-senha'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('nu-perfil').value = 'operador';
  document.getElementById('nu-result')?.classList.add('hidden');
  showModal('modal-novo-usuario');
}

async function salvarUsuario(e) {
  e.preventDefault();
  const tenantId = document.getElementById('nu-tenant-id').value;
  const payload  = {
    nome:   document.getElementById('nu-nome').value.trim(),
    email:  document.getElementById('nu-email').value.trim(),
    senha:  document.getElementById('nu-senha').value,
    perfil: document.getElementById('nu-perfil').value
  };
  try {
    await axios.post('/api/admin/clientes/' + tenantId + '/usuarios', payload);
    const res = document.getElementById('nu-result');
    if (res) {
      res.className = 'text-xs p-3 rounded-xl bg-green-500/15 border border-green-500/25 text-green-400';
      res.textContent = '✓ Usuário criado com sucesso!';
      res.classList.remove('hidden');
    }
    setTimeout(() => {
      closeModal('modal-novo-usuario');
      verDetalhe(tenantId);
      showToast('Usuário criado!', 'success');
    }, 1000);
  } catch (err) {
    const res = document.getElementById('nu-result');
    if (res) {
      res.className = 'text-xs p-3 rounded-xl bg-red-500/15 border border-red-500/25 text-red-400';
      res.textContent = err.response?.data?.error || 'Erro ao criar usuário.';
      res.classList.remove('hidden');
    }
  }
}

async function toggleUsuario(id, ativo) {
  try {
    await axios.put('/api/admin/usuarios/' + id, { ativo: !ativo });
    showToast(ativo ? 'Usuário desativado.' : 'Usuário ativado!', ativo ? 'info' : 'success');
  } catch (err) {
    showToast('Erro ao atualizar usuário.', 'error');
  }
}

// ============================================================
// PLANOS
// ============================================================
async function loadPlanos() {
  const grid = document.getElementById('planos-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="loader mx-auto col-span-3 mt-10"></div>';

  try {
    const res = await axios.get('/api/admin/planos');
    const planos = res.data.planos || [];

    const icons = { basico: 'fa-seedling', profissional: 'fa-rocket', enterprise: 'fa-crown' };
    const cores = { basico: '#3b82f6', profissional: '#f59e0b', enterprise: '#dc2626' };

    grid.innerHTML = planos.map(p => {
      const features = JSON.parse(p.features || '[]');
      const cor = cores[p.codigo] || '#6b7280';
      const ico = icons[p.codigo] || 'fa-box';
      return `<div class="card p-6 relative overflow-hidden">
        <div class="absolute top-0 right-0 w-32 h-32 rounded-full opacity-5" style="background:${cor};transform:translate(30%,-30%)"></div>
        <div class="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style="background:${cor}20">
          <i class="fas ${ico}" style="color:${cor}"></i>
        </div>
        <div class="text-lg font-bold text-white mb-1">${p.nome}</div>
        <div class="text-xs text-slate-500 mb-4">${p.descricao || ''}</div>
        <div class="text-2xl font-bold mb-1" style="color:${cor}">R$ ${Number(p.preco_mensal).toFixed(2).replace('.',',')}<span class="text-sm font-normal text-slate-500">/mês</span></div>
        <div class="text-xs text-slate-500 mb-5">Até ${p.max_veiculos >= 999 ? 'ilimitados' : p.max_veiculos} veículos · ${p.max_usuarios >= 100 ? 'ilimitados' : p.max_usuarios} usuários</div>
        <div class="space-y-2">
          ${features.map(f => `<div class="flex items-center gap-2 text-xs text-slate-300">
            <i class="fas fa-check-circle" style="color:${cor};font-size:10px"></i>${f}
          </div>`).join('')}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    grid.innerHTML = '<p class="text-red-400 text-xs text-center col-span-3 py-10">Erro ao carregar planos</p>';
  }
}

// ============================================================
// CEP AUTOPREENCH
// ============================================================
async function buscaCep(val) {
  const cep = val.replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const r = await fetch('https://viacep.com.br/ws/' + cep + '/json/');
    const d = await r.json();
    if (!d.erro) {
      setVal('f-logradouro', d.logradouro);
      setVal('f-bairro',     d.bairro);
      setVal('f-cidade',     d.localidade);
      setVal('f-uf',         d.uf);
    }
  } catch(e) {}
}

// ============================================================
// ABAS DO FORM
// ============================================================
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const content = document.getElementById('tab-content-' + name);
  const btn     = document.getElementById('tab-' + name);
  if (content) content.classList.remove('hidden');
  if (btn)     btn.classList.add('active');
}

// ============================================================
// MODAIS
// ============================================================
function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// ============================================================
// UTILITÁRIOS
// ============================================================
function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }
function setVal(id, val) { const e = document.getElementById(id); if (e) e.value = val || ''; }

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(str) {
  if (!str) return '-';
  try { return new Date(str).toLocaleDateString('pt-BR'); }
  catch(e) { return str; }
}

function planoBadge(plano) {
  const map = {
    basico:       ['badge-blue',   'Básico'],
    profissional: ['badge-yellow', 'Profissional'],
    enterprise:   ['badge-red',    'Enterprise']
  };
  const [cls, label] = map[plano] || ['badge-blue', plano || '-'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function statusBadge(status) {
  return status === 'ativo'
    ? '<span class="badge badge-green">● Ativo</span>'
    : '<span class="badge badge-red">● Inativo</span>';
}

function showFormResult(msg, type) {
  const el = document.getElementById('form-result');
  if (!el) return;
  el.className = 'text-xs p-3 rounded-xl mt-4 ' + (
    type === 'success' ? 'bg-green-500/15 border border-green-500/25 text-green-400' :
    type === 'error'   ? 'bg-red-500/15 border border-red-500/25 text-red-400' :
                         'bg-blue-500/15 border border-blue-500/25 text-blue-400'
  );
  el.innerHTML = (type === 'success' ? '<i class="fas fa-check-circle mr-1"></i>' : '<i class="fas fa-exclamation-circle mr-1"></i>') + esc(msg);
  el.classList.remove('hidden');
}

function showToast(msg, type) {
  type = type || 'info';
  const existing = document.getElementById('admin-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'admin-toast';
  const colors = {
    success: 'background:rgba(16,185,129,.15);color:#34d399;border-color:rgba(16,185,129,.25)',
    error:   'background:rgba(220,38,38,.15);color:#f87171;border-color:rgba(220,38,38,.25)',
    info:    'background:rgba(59,130,246,.15);color:#60a5fa;border-color:rgba(59,130,246,.25)'
  };
  toast.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:9999;padding:10px 16px;border-radius:12px;font-size:13px;font-weight:500;border:1px solid;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,.4);${colors[type]||colors.info}`;
  toast.innerHTML = msg;
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4000);
}

function adminLogout() {
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
  window.location.href = '/admin/login';
}

window.addEventListener('unhandledrejection', e => {
  if (e.reason?.response?.status === 401 || e.reason?.response?.status === 403) {
    adminLogout();
  }
});

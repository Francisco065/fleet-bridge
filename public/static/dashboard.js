// Fleet Bridge Dashboard - JavaScript
// ============================================================
// CONFIGURAÇÃO GLOBAL
// ============================================================
let token = localStorage.getItem('fleet_token');
let user = JSON.parse(localStorage.getItem('fleet_user') || '{}');
let mapInstance = null;
let mapMarkers = {};
let chartRisco = null;
let chartHoras = null;
let autoRefreshTimer = null;
const AUTO_REFRESH_SEC = 30;

// Verificar autenticação
if (!token) {
  window.location.href = '/login';
}

// Config axios - aguardar carregamento do axios
function setupAxios() {
  if (window.axios) {
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
    return true;
  }
  return false;
}

// ============================================================
// INICIALIZAÇÃO - aguardar TODOS os scripts CDN carregarem
// ============================================================
window.addEventListener('load', async function() {
  setupAxios();

  // Atualizar UI com dados do usuário
  const userNome = document.getElementById('user-nome');
  const userPerfil = document.getElementById('user-perfil');
  const dataHoje = document.getElementById('data-hoje');

  if (userNome) userNome.textContent = user.nome || 'Usuário';
  if (userPerfil) userPerfil.textContent = user.perfil || 'operador';
  if (dataHoje) dataHoje.textContent = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  try {
    const res = await axios.get('/api/tenant');
    const empresaNome = document.getElementById('empresa-nome');
    if (empresaNome) empresaNome.textContent = res.data.tenant?.nome_empresa || 'Fleet Bridge';
  } catch(e) {}

  // Setup inicial do banco (silencioso)
  try { await axios.post('/api/setup'); } catch(e) {}

  // Carregar dados iniciais
  await loadOverview();
  await loadTimeline();
  await loadAlertas();
  await loadStatsHora();

  // Auto-refresh
  startAutoRefresh();
});

// ============================================================
// NAVEGAÇÃO
// ============================================================
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const section = document.getElementById('sec-' + name);
  if (section) section.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.getAttribute('href') === '#' + name) n.classList.add('active');
  });

  const titles = {
    torre: 'Torre de Controle',
    mapa: 'Mapa Ao Vivo',
    indicadores: 'Indicadores do Dia',
    ranking: 'Rankings',
    'veiculos-lista': 'Frota',
    config: 'Configurações',
    logs: 'Logs de Coleta'
  };

  const pageTitle = document.getElementById('page-title');
  if (pageTitle) pageTitle.textContent = titles[name] || name;

  if (name === 'mapa') initMap();
  if (name === 'indicadores') loadIndicadores();
  if (name === 'ranking') loadRanking('risco');
  if (name === 'veiculos-lista') loadVeiculos();
  if (name === 'logs') loadLogs();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

// ============================================================
// OVERVIEW / KPIs
// ============================================================
async function loadOverview() {
  try {
    const res = await axios.get('/api/dashboard/overview');
    const { kpis, eventos_recentes } = res.data;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('kpi-total',  kpis.total_veiculos);
    set('kpi-online', kpis.veiculos_online);
    set('kpi-risco',  kpis.veiculos_risco);
    set('kpi-score',  kpis.score_medio_frota);

    const pct = kpis.total_veiculos > 0
      ? Math.round((kpis.veiculos_online / kpis.total_veiculos) * 100) : 0;
    set('kpi-online-pct', pct + '% da frota');

    // Badge de alertas
    if (kpis.alertas_nao_lidos > 0) {
      const badgeEl = document.getElementById('badge-alertas');
      if (badgeEl) { badgeEl.textContent = kpis.alertas_nao_lidos; badgeEl.classList.remove('hidden'); }
    }

    // Gráfico de risco
    renderChartRisco(kpis.distribuicao_risco, kpis.total_veiculos);

    // Distribuição textual
    const total = kpis.total_veiculos || 1;
    const distRisco = document.getElementById('dist-risco');
    if (distRisco) {
      distRisco.innerHTML = [
        ['verde',   '#10b981', 'Baixo Risco',   kpis.distribuicao_risco.verde],
        ['amarelo', '#f59e0b', 'Risco Médio',   kpis.distribuicao_risco.amarelo],
        ['vermelho','#ef4444', 'Alto Risco',    kpis.distribuicao_risco.vermelho],
      ].map(([, cor, label, qtd]) =>
        '<div class="flex items-center gap-3">' +
          '<div class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:' + cor + '"></div>' +
          '<div class="flex-1 bg-slate-800 rounded-full h-1.5">' +
            '<div style="width:' + Math.round((qtd / total) * 100) + '%;background:' + cor + ';height:6px;border-radius:999px;transition:width .4s"></div>' +
          '</div>' +
          '<span class="text-xs text-slate-400 w-20 text-right">' + qtd + ' ' + label + '</span>' +
        '</div>'
      ).join('');
    }

    const lastUpdate = document.getElementById('last-update');
    if (lastUpdate) lastUpdate.textContent = 'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');

  } catch (err) {
    console.error('Erro ao carregar overview:', err);
  }
}

// ============================================================
// GRÁFICO: DISTRIBUIÇÃO DE RISCO
// ============================================================
function renderChartRisco(dist, totalVeiculos) {
  const canvas = document.getElementById('chartRisco');
  if (!canvas) return;
  if (!window.Chart) { setTimeout(() => renderChartRisco(dist, totalVeiculos), 200); return; }

  // Destruir gráfico anterior
  if (chartRisco) { chartRisco.destroy(); chartRisco = null; }

  // Definir dimensões explícitas
  const parent = canvas.parentElement;
  const w = parent ? parent.offsetWidth || 300 : 300;
  canvas.width = w;
  canvas.height = 180;
  canvas.style.width = w + 'px';
  canvas.style.height = '180px';
  canvas.style.display = 'block';

  const semDados = !totalVeiculos || totalVeiculos === 0;

  if (semDados) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    const cx = canvas.width / 2;
    const cy = 90;
    const r = 60;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2, true);
    ctx.fillStyle = 'rgba(51,65,85,0.6)';
    ctx.fill();
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Sem dados', cx, cy - 7);
    ctx.font = '10px system-ui';
    ctx.fillText('ainda', cx, cy + 9);
    ctx.restore();
    const distRisco = document.getElementById('dist-risco');
    if (distRisco) {
      distRisco.innerHTML =
        '<div class="text-xs text-slate-600 text-center py-2 flex items-center justify-center gap-2">' +
          '<i class="fas fa-info-circle text-slate-700"></i>' +
          '<span>Sincronize veículos para ver a distribuição</span>' +
        '</div>';
    }
    return;
  }

  // Com dados: renderizar doughnut
  chartRisco = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: ['Baixo Risco', 'Risco Médio', 'Alto Risco'],
      datasets: [{
        data: [dist.verde || 0, dist.amarelo || 0, dist.vermelho || 0],
        backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
        borderWidth: 0,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          borderColor: 'rgba(148,163,184,0.2)',
          borderWidth: 1,
          callbacks: { label: (i) => '  ' + i.label + ': ' + i.raw + ' veículo(s)' }
        }
      },
      animation: { animateRotate: true, duration: 600 }
    }
  });
}

// ============================================================
// TIMELINE
// ============================================================
async function loadTimeline() {
  const container = document.getElementById('timeline');
  if (!container) return;
  try {
    const res = await axios.get('/api/dashboard/timeline?limit=30');
    const eventos = res.data.eventos || [];

    if (eventos.length === 0) {
      container.innerHTML =
        '<div class="flex flex-col items-center py-8 gap-2">' +
          '<i class="fas fa-stream text-slate-700 text-2xl"></i>' +
          '<span class="text-slate-500 text-xs">Nenhum evento registrado hoje</span>' +
          '<span class="text-slate-700 text-xs">Os eventos aparecerão aqui após a coleta de dados</span>' +
        '</div>';
      return;
    }

    container.innerHTML = eventos.map(ev => {
      const score = ev.risk_score || 0;
      const cor = score >= 61 ? '#ef4444' : score >= 31 ? '#f59e0b' : '#10b981';
      const hora = ev.data_gps
        ? new Date(ev.data_gps).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '-';
      return '<div class="timeline-item py-2">' +
        '<div class="timeline-dot" style="background:' + cor + '25;border-color:' + cor + '"></div>' +
        '<div class="flex items-start gap-2 ml-2">' +
          '<span class="text-xs text-slate-600 w-12 flex-shrink-0 mt-0.5">' + hora + '</span>' +
          '<div class="flex-1 min-w-0">' +
            '<span class="text-xs font-medium text-slate-300">' + (ev.placa || ev.descricao || '-') + '</span>' +
            '<span class="text-xs text-slate-500 ml-1">' + (ev.evento_nome || 'Posição') + '</span>' +
            (ev.velocidade > 0 ? '<span class="text-xs text-slate-600 ml-1">' + ev.velocidade + 'km/h</span>' : '') +
          '</div>' +
          '<span class="text-xs px-1.5 py-0.5 rounded font-semibold flex-shrink-0" style="color:' + cor + ';background:' + cor + '20">' + score + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    console.error('Erro timeline:', err);
    if (container) container.innerHTML =
      '<div class="text-red-400 text-xs text-center py-4"><i class="fas fa-exclamation-circle mr-1"></i>Erro ao carregar eventos</div>';
  }
}

// ============================================================
// ALERTAS
// ============================================================
async function loadAlertas() {
  const container = document.getElementById('lista-alertas');
  if (!container) return;
  try {
    const res = await axios.get('/api/dashboard/alertas');
    const alertas = (res.data.alertas || []).filter(a => !a.lido);

    if (alertas.length === 0) {
      container.innerHTML =
        '<div class="flex flex-col items-center py-6 gap-2">' +
          '<div class="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center">' +
            '<i class="fas fa-check-circle text-green-400 text-base"></i>' +
          '</div>' +
          '<span class="text-slate-400 text-xs font-medium">Nenhum alerta ativo</span>' +
          '<span class="text-slate-600 text-xs">Sua frota está operando normalmente</span>' +
        '</div>';
      return;
    }

    container.innerHTML = alertas.slice(0, 10).map(a => {
      const sevColor = a.severity === 'critical' ? '#ef4444'
        : a.severity === 'high' ? '#f97316' : '#f59e0b';
      const sevIcon = a.severity === 'critical' ? 'fa-radiation'
        : a.severity === 'high' ? 'fa-exclamation-triangle' : 'fa-exclamation-circle';
      return '<div class="flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer hover:opacity-80 transition-opacity mb-1.5 last:mb-0" ' +
        'style="background:' + sevColor + '12;border:1px solid ' + sevColor + '25" ' +
        'onclick="marcarLido(' + a.id + ')" title="Clique para marcar como lido">' +
        '<i class="fas ' + sevIcon + ' text-xs mt-0.5 flex-shrink-0" style="color:' + sevColor + '"></i>' +
        '<div class="flex-1 min-w-0">' +
          '<p class="text-xs font-semibold truncate" style="color:' + sevColor + '">' +
            (a.placa || 'Veículo ' + a.veiculo_id) +
          '</p>' +
          '<p class="text-xs text-slate-400 truncate mt-0.5">' + (a.mensagem || '-') + '</p>' +
          '<p class="text-xs text-slate-600 mt-0.5">' +
            (a.data_alerta ? new Date(a.data_alerta).toLocaleString('pt-BR', {hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'}) : '') +
          '</p>' +
        '</div>' +
        '<i class="fas fa-times text-xs text-slate-700 hover:text-slate-400 flex-shrink-0 mt-0.5 transition-colors"></i>' +
      '</div>';
    }).join('');
  } catch(e) {
    console.error('Erro alertas:', e);
    if (container) container.innerHTML =
      '<div class="text-red-400 text-xs text-center py-4"><i class="fas fa-exclamation-circle mr-1"></i>Erro ao carregar alertas</div>';
  }
}

async function marcarLido(id) {
  try {
    await axios.post('/api/dashboard/alertas/' + id + '/lido');
    loadAlertas();
    loadOverview();
  } catch(e) {}
}

async function marcarTodosLidos() {
  try {
    const res = await axios.get('/api/dashboard/alertas');
    const alertas = res.data.alertas || [];
    await Promise.all(alertas.map(a => axios.post('/api/dashboard/alertas/' + a.id + '/lido')));
    loadAlertas();
    const badge = document.getElementById('badge-alertas');
    if (badge) badge.classList.add('hidden');
    showToast('Todos os alertas foram marcados como lidos', 'success');
  } catch(e) {}
}

// ============================================================
// GRÁFICO: ATIVIDADE HOJE (STATS POR HORA)
// ============================================================
async function loadStatsHora() {
  const canvas = document.getElementById('chartHoras');
  if (!canvas) return;
  if (!window.Chart) { setTimeout(loadStatsHora, 200); return; }

  // Definir dimensões explícitas
  const parent = canvas.parentElement;
  const w = parent ? parent.offsetWidth || 300 : 300;
  canvas.width = w;
  canvas.height = 180;
  canvas.style.width = w + 'px';
  canvas.style.height = '180px';
  canvas.style.display = 'block';

  try {
    const res = await axios.get('/api/dashboard/stats-hora');
    const stats = res.data.stats || [];

    // Destruir gráfico anterior
    if (chartHoras) { chartHoras.destroy(); chartHoras = null; }

    const ctx = canvas.getContext('2d');

    if (stats.length === 0) {
      // Estado vazio: placeholder visual
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      const numBars = 12;
      const barW = Math.floor((canvas.width / numBars) * 0.55);
      const gap = canvas.width / numBars;
      const baseY = canvas.height * 0.72;
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, baseY, canvas.width, 1);
      for (let i = 0; i < numBars; i++) {
        const h = (0.06 + (i % 3) * 0.04) * canvas.height;
        ctx.fillStyle = 'rgba(51,65,85,0.5)';
        ctx.fillRect(i * gap + gap * 0.22, baseY - h, barW, h);
      }
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Sem atividade hoje', canvas.width / 2, canvas.height * 0.35);
      ctx.font = '10px system-ui';
      ctx.fillStyle = '#475569';
      ctx.fillText('Os dados aparecerão após a coleta', canvas.width / 2, canvas.height * 0.35 + 18);
      ctx.restore();
      return;
    }

    // Preencher horas faltantes (0-23) com zeros
    const mapaHoras = {};
    stats.forEach(s => { mapaHoras[parseInt(s.hora)] = s; });
    const horaAtual = new Date().getHours();
    const labels = [];
    const dataTotal = [];
    const dataAlertas = [];

    for (let h = 0; h <= horaAtual; h++) {
      labels.push(String(h).padStart(2, '0') + 'h');
      dataTotal.push(mapaHoras[h]?.total || 0);
      dataAlertas.push(mapaHoras[h]?.alertas || 0);
    }

    chartHoras = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Posições',
            data: dataTotal,
            backgroundColor: 'rgba(59,130,246,0.25)',
            borderColor: '#3b82f6',
            borderWidth: 1.5,
            borderRadius: 3,
            order: 2
          },
          {
            label: 'Alertas',
            data: dataAlertas,
            backgroundColor: 'rgba(239,68,68,0.25)',
            borderColor: '#ef4444',
            borderWidth: 1.5,
            borderRadius: 3,
            order: 1
          }
        ]
      },
      options: {
        responsive: false,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: '#64748b',
              font: { size: 10 },
              boxWidth: 10,
              padding: 8
            }
          },
          tooltip: {
            backgroundColor: '#1e293b',
            borderColor: 'rgba(148,163,184,0.2)',
            borderWidth: 1,
            titleColor: '#94a3b8',
            bodyColor: '#f1f5f9',
            padding: 8
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#475569', font: { size: 10 } }
          },
          y: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#475569', font: { size: 10 }, precision: 0 },
            beginAtZero: true
          }
        },
        animation: { duration: 500 }
      }
    });
  } catch(e) {
    console.error('Erro stats hora:', e);
  }
}

// ============================================================
// MAPA
// ============================================================
function initMap() {
  if (mapInstance) { loadMapaPosicoes(); return; }

  mapInstance = L.map('map', { center: [-15.7942, -47.8822], zoom: 5, zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB', maxZoom: 19
  }).addTo(mapInstance);

  loadMapaPosicoes();
}

async function loadMapaPosicoes() {
  if (!mapInstance) return;
  try {
    const res = await axios.get('/api/veiculos/mapa/posicoes');
    const veiculos = res.data.veiculos || [];

    Object.values(mapMarkers).forEach(m => m.remove());
    mapMarkers = {};
    const bounds = [];

    veiculos.forEach(v => {
      if (!v.latitude || !v.longitude) return;
      const cor = v.risk_nivel === 'vermelho' ? '#ef4444'
        : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981';
      const html = '<div class="vehicle-marker ' + (v.status_online ? 'pulse' : '') + '" style="background:' + cor + '30;border-color:' + cor + '">' +
        '<i class="fas fa-car" style="color:' + cor + ';font-size:11px"></i></div>';
      const icon = L.divIcon({ html, className: '', iconSize: [34, 34], iconAnchor: [17, 17] });
      const marker = L.marker([v.latitude, v.longitude], { icon });
      const popup = '<div style="background:#1e293b;color:#f1f5f9;border-radius:10px;padding:12px;min-width:200px;border:1px solid rgba(148,163,184,0.2)">' +
        '<div style="font-weight:700;font-size:14px;margin-bottom:6px">' + (v.placa || v.descricao || 'Veículo') + '</div>' +
        '<div style="font-size:12px;color:#94a3b8">' +
          (v.modelo ? '<div>' + v.modelo + ' ' + (v.marca || '') + '</div>' : '') +
          (v.motorista_nome ? '<div>&#128100; ' + v.motorista_nome + '</div>' : '') +
          '<div>&#128640; ' + (v.velocidade || 0) + ' km/h</div>' +
          (v.evento_nome ? '<div>&#9889; ' + v.evento_nome + '</div>' : '') +
          '<div style="margin-top:6px"><span style="background:' + cor + '25;color:' + cor + ';padding:2px 8px;border-radius:999px;font-weight:600">Score: ' + (v.risk_score || 0) + '</span></div>' +
          (v.endereco ? '<div style="margin-top:4px;font-size:11px">' + v.endereco.substring(0, 60) + '</div>' : '') +
        '</div></div>';
      marker.bindPopup(popup, { className: 'dark-popup', maxWidth: 280 });
      marker.addTo(mapInstance);
      mapMarkers[v.id] = marker;
      bounds.push([v.latitude, v.longitude]);
    });

    if (bounds.length > 0) mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  } catch (err) { console.error('Erro mapa:', err); }
}

// ============================================================
// INDICADORES
// ============================================================
async function loadIndicadores() {
  const container = document.getElementById('indicadores-grid');
  if (!container) return;
  container.innerHTML = '<div class="col-span-3 text-center py-8"><div class="loader mx-auto"></div></div>';

  try {
    const res = await axios.get('/api/veiculos');
    const veiculos = res.data.veiculos || [];

    if (veiculos.length === 0) {
      container.innerHTML = '<div class="col-span-3 text-center py-16">' +
        '<div class="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-4">' +
          '<i class="fas fa-car text-slate-500 text-2xl"></i>' +
        '</div>' +
        '<h3 class="text-white font-semibold mb-2">Nenhum veículo cadastrado</h3>' +
        '<p class="text-slate-500 text-sm mb-4">Sincronize com a Multiportal para importar sua frota</p>' +
        '<button onclick="showModal(\'modal-sync\')" class="btn-primary"><i class="fas fa-sync-alt"></i> Sincronizar Frota</button>' +
      '</div>';
      return;
    }

    container.innerHTML = veiculos.map(v => {
      const cor = v.risk_nivel === 'vermelho' ? '#ef4444' : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981';
      const score = v.risk_score || 0;
      const pico = Math.round(v.pico_velocidade_hoje || 0);
      const statusBadge = v.status_online
        ? '<span class="badge badge-green">&#128994; Online</span>'
        : '<span class="badge badge-blue">&#9899; Offline</span>';

      return '<div class="card p-5 hover:border-blue-500/30 transition cursor-pointer">' +
        '<div class="flex items-center justify-between mb-4">' +
          '<div class="flex items-center gap-3">' +
            '<div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:' + cor + '20">' +
              '<i class="fas fa-car" style="color:' + cor + '"></i>' +
            '</div>' +
            '<div>' +
              '<div class="font-semibold text-sm text-white">' + (v.placa || v.id_multiportal) + '</div>' +
              '<div class="text-xs text-slate-500">' + (v.descricao || v.modelo || '-') + '</div>' +
            '</div>' +
          '</div>' +
          statusBadge +
        '</div>' +
        '<div class="grid grid-cols-3 gap-3 text-center mb-4">' +
          '<div class="bg-slate-800/50 rounded-lg p-2">' +
            '<div class="text-xs text-slate-500">Vel. Pico</div>' +
            '<div class="text-base font-bold text-white">' + pico + '<span class="text-xs font-normal text-slate-500"> km/h</span></div>' +
          '</div>' +
          '<div class="bg-slate-800/50 rounded-lg p-2">' +
            '<div class="text-xs text-slate-500">Posições</div>' +
            '<div class="text-base font-bold text-white">' + (v.posicoes_hoje || 0) + '</div>' +
          '</div>' +
          '<div class="bg-slate-800/50 rounded-lg p-2">' +
            '<div class="text-xs text-slate-500">Score</div>' +
            '<div class="text-base font-bold" style="color:' + cor + '">' + score + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="w-full bg-slate-800 rounded-full h-2">' +
          '<div class="h-2 rounded-full transition-all" style="width:' + score + '%;background:linear-gradient(90deg,#10b981,' + cor + ')"></div>' +
        '</div>' +
        '<div class="text-xs text-right mt-1" style="color:' + cor + '">' +
          (score <= 30 ? 'Baixo Risco' : score <= 60 ? 'Risco Moderado' : 'Alto Risco') +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    console.error('Erro indicadores:', err);
    if (container) container.innerHTML =
      '<div class="col-span-3 text-red-400 text-sm text-center py-8"><i class="fas fa-exclamation-circle mr-2"></i>Erro ao carregar indicadores</div>';
  }
}

// ============================================================
// RANKING
// ============================================================
async function loadRanking(tipo, btnEl) {
  if (btnEl) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }

  const body = document.getElementById('ranking-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" class="text-center p-8"><div class="loader mx-auto"></div></td></tr>';

  try {
    const res = await axios.get('/api/dashboard/ranking?tipo=' + tipo);
    const ranking = res.data.ranking || [];

    if (ranking.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="text-center p-8 text-slate-500 text-xs">' +
        '<i class="fas fa-chart-bar mr-2"></i>Nenhum dado disponível ainda</td></tr>';
      return;
    }

    body.innerHTML = ranking.map((v, i) => {
      const cor = v.risk_nivel === 'vermelho' ? '#ef4444' : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981';
      const medal = i === 0 ? '&#129351;' : i === 1 ? '&#129352;' : i === 2 ? '&#129353;' : (i + 1) + '.';
      let metricCell = tipo === 'ociosidade'
        ? '<td class="p-4 text-sm text-slate-300 hidden md:table-cell">' + (v.minutos_ocioso || 0) + ' min</td>'
        : '<td class="p-4 text-sm text-slate-300 hidden md:table-cell">' + Math.round(v.pico_velocidade || 0) + ' km/h</td>';

      return '<tr class="table-row border-b border-slate-800/50">' +
        '<td class="p-4 text-sm font-bold text-slate-400">' + medal + '</td>' +
        '<td class="p-4"><div class="text-sm font-medium text-white">' + (v.descricao || v.id_multiportal || '-') + '</div>' +
          '<div class="text-xs text-slate-500">' + (v.frota ? 'Frota: ' + v.frota : '') + '</div></td>' +
        '<td class="p-4 text-sm text-slate-300 font-mono">' + (v.placa || '-') + '</td>' +
        '<td class="p-4"><div class="flex items-center gap-2">' +
          '<div class="flex-1 bg-slate-800 rounded-full h-1.5" style="width:80px">' +
            '<div class="h-1.5 rounded-full" style="width:' + (v.risk_score || 0) + '%;background:' + cor + '"></div>' +
          '</div>' +
          '<span class="text-sm font-bold" style="color:' + cor + '">' + (v.risk_score || 0) + '</span>' +
        '</div></td>' +
        metricCell +
        '<td class="p-4 hidden md:table-cell"><span class="badge ' + (v.status_online ? 'badge-green' : 'badge-blue') + ' text-xs">' +
          (v.status_online ? 'Online' : 'Offline') + '</span></td>' +
      '</tr>';
    }).join('');
  } catch (err) {
    if (body) body.innerHTML = '<tr><td colspan="6" class="text-center p-8 text-red-400 text-xs">' +
      '<i class="fas fa-exclamation-circle mr-2"></i>Erro ao carregar ranking</td></tr>';
  }
}

// ============================================================
// VEÍCULOS
// ============================================================
async function loadVeiculos() {
  const container = document.getElementById('veiculos-grid');
  if (!container) return;
  container.innerHTML = '<div class="col-span-3 text-center py-8"><div class="loader mx-auto"></div></div>';

  try {
    const res = await axios.get('/api/veiculos');
    const veiculos = res.data.veiculos || [];

    if (veiculos.length === 0) {
      container.innerHTML = '<div class="col-span-3 text-center py-16">' +
        '<div class="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center mx-auto mb-4">' +
          '<i class="fas fa-car text-slate-500 text-2xl"></i>' +
        '</div>' +
        '<h3 class="text-white font-semibold mb-2">Nenhum veículo cadastrado</h3>' +
        '<p class="text-slate-500 text-sm mb-4">Sincronize com a Multiportal para importar sua frota</p>' +
        '<button onclick="showModal(\'modal-sync\')" class="btn-primary"><i class="fas fa-sync-alt"></i> Sincronizar Frota</button>' +
      '</div>';
      return;
    }

    container.innerHTML = veiculos.map(v => {
      const cor = v.risk_nivel === 'vermelho' ? '#ef4444' : v.risk_nivel === 'amarelo' ? '#f59e0b' : '#10b981';
      const icon = v.status_online ? 'fa-car' : 'fa-parking';
      return '<div class="card p-5 hover:border-slate-600 transition">' +
        '<div class="flex items-start justify-between mb-3">' +
          '<div class="flex items-center gap-3">' +
            '<div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:' + cor + '15;border:1px solid ' + cor + '30">' +
              '<i class="fas ' + icon + '" style="color:' + cor + '"></i>' +
            '</div>' +
            '<div>' +
              '<div class="font-bold text-white text-sm">' + (v.placa || '-') + '</div>' +
              '<div class="text-xs text-slate-500">' + (v.marca || '') + ' ' + (v.modelo || '') + '</div>' +
            '</div>' +
          '</div>' +
          '<span class="badge ' + (v.status_online ? 'badge-green' : 'badge-blue') + '">' + (v.status_online ? 'Online' : 'Offline') + '</span>' +
        '</div>' +
        '<div class="text-xs text-slate-500 mb-3 truncate">' + (v.descricao || 'Sem descrição') + '</div>' +
        '<div class="flex items-center justify-between text-xs">' +
          '<span class="text-slate-500">Risk Score</span>' +
          '<span class="font-bold" style="color:' + cor + '">' + (v.risk_score || 0) + '/100</span>' +
        '</div>' +
        '<div class="w-full bg-slate-800 rounded-full h-1.5 mt-1.5">' +
          '<div class="h-1.5 rounded-full" style="width:' + (v.risk_score || 0) + '%;background:' + cor + '"></div>' +
        '</div>' +
        '<div class="flex items-center justify-between mt-3 pt-3 border-t border-slate-800">' +
          '<span class="text-xs text-slate-600">ID: ' + (v.id_multiportal || v.id) + '</span>' +
          (v.frota ? '<span class="text-xs badge badge-blue">' + v.frota + '</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    console.error('Erro veículos:', err);
    if (container) container.innerHTML =
      '<div class="col-span-3 text-red-400 text-sm text-center py-8"><i class="fas fa-exclamation-circle mr-2"></i>Erro ao carregar veículos</div>';
  }
}

// ============================================================
// LOGS
// ============================================================
async function loadLogs() {
  const body = document.getElementById('logs-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="5" class="text-center p-8"><div class="loader mx-auto"></div></td></tr>';

  try {
    const res = await axios.get('/api/sync/logs');
    const logs = res.data.logs || [];

    if (logs.length === 0) {
      body.innerHTML = '<tr><td colspan="5" class="text-center p-8 text-slate-500 text-xs">' +
        '<i class="fas fa-terminal mr-2"></i>Nenhum log encontrado</td></tr>';
      return;
    }

    body.innerHTML = logs.map(l => {
      const cor = l.status === 'ok' ? '#10b981' : l.status === 'sem_dados' ? '#f59e0b' : '#ef4444';
      const statusLabel = l.status === 'ok' ? '&#10003; OK' : l.status === 'sem_dados' ? '&#8709; Sem dados' : '&#10007; Erro';
      const data = l.created_at ? new Date(l.created_at).toLocaleString('pt-BR') : '-';
      return '<tr class="table-row border-b border-slate-800/50">' +
        '<td class="p-4 text-xs text-slate-400">' + data + '</td>' +
        '<td class="p-4"><span class="badge" style="color:' + cor + ';background:' + cor + '20">' + statusLabel + '</span></td>' +
        '<td class="p-4 text-sm font-semibold text-white">' + (l.posicoes_recebidas || 0) + '</td>' +
        '<td class="p-4 text-xs text-slate-500 hidden md:table-cell">' + (l.duracao_ms ? l.duracao_ms + 'ms' : '-') + '</td>' +
        '<td class="p-4 text-xs text-slate-400 max-w-xs truncate">' + (l.mensagem || '-') + '</td>' +
      '</tr>';
    }).join('');
  } catch(e) {
    if (body) body.innerHTML = '<tr><td colspan="5" class="text-center p-8 text-red-400 text-xs">' +
      '<i class="fas fa-exclamation-circle mr-2"></i>Erro ao carregar logs</td></tr>';
  }
}

// ============================================================
// COLETA / SINCRONIZAÇÃO
// ============================================================
async function coletarDados() {
  const icon = document.getElementById('sync-icon');
  const dot = document.getElementById('dot-status');
  const txt = document.getElementById('txt-status');

  if (icon) icon.classList.add('fa-spin');
  if (dot) dot.style.background = '#f59e0b';
  if (txt) txt.textContent = 'Coletando...';

  try {
    const res = await axios.post('/api/sync/coletar');
    const r = res.data;

    if (dot) dot.style.background = r.ok ? '#10b981' : '#ef4444';
    if (txt) txt.textContent = r.ok ? (r.posicoes || 0) + ' pos.' : 'Sem config.';

    await loadOverview();
    await loadTimeline();
    await loadAlertas();
    await loadStatsHora();
    if (mapInstance) loadMapaPosicoes();

    if (r.status === 'sem_credenciais') {
      showToast('&#9888; Configure as credenciais da Multiportal primeiro', 'info');
    } else {
      showToast(r.ok
        ? '&#10003; Coletado: ' + (r.posicoes || 0) + ' posições'
        : '&#10007; ' + (r.mensagem || 'Erro na coleta'), r.ok ? 'success' : 'error');
    }
  } catch (err) {
    if (dot) dot.style.background = '#ef4444';
    if (txt) txt.textContent = 'Erro';
    showToast('Erro ao coletar dados', 'error');
  } finally {
    if (icon) icon.classList.remove('fa-spin');
  }
}

async function testarConexao() {
  const username = (document.getElementById('cfg-username') || {}).value || '';
  const password = (document.getElementById('cfg-password') || {}).value || '';
  const appid = (document.getElementById('cfg-appid') || {}).value || 'portal';
  showCfgResult('Testando conexão...', 'info');
  try {
    const res = await axios.post('/api/sync/test-connection', { username, password, appid });
    showCfgResult(res.data.message || 'Conectado!', 'success');
  } catch (err) {
    showCfgResult((err.response?.data?.message) || 'Erro de conexão', 'error');
  }
}

async function salvarCredenciais() {
  const username = (document.getElementById('cfg-username') || {}).value || '';
  const password = (document.getElementById('cfg-password') || {}).value || '';
  const appid = (document.getElementById('cfg-appid') || {}).value || 'portal';
  try {
    await axios.post('/api/sync/credentials', { username, password, appid });
    showCfgResult('&#10003; Credenciais salvas com sucesso!', 'success');
    showToast('Credenciais salvas!', 'success');
  } catch(e) {
    showCfgResult('Erro ao salvar', 'error');
  }
}

function showCfgResult(msg, type) {
  const el = document.getElementById('cfg-result');
  if (!el) return;
  el.className = 'text-xs p-3 rounded-lg';
  if (type === 'success') el.classList.add('bg-green-500/20', 'text-green-400', 'border', 'border-green-500/30');
  else if (type === 'error') el.classList.add('bg-red-500/20', 'text-red-400', 'border', 'border-red-500/30');
  else el.classList.add('bg-blue-500/20', 'text-blue-400', 'border', 'border-blue-500/30');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function testarEConectarModal() {
  const username = (document.getElementById('m-username') || {}).value || '';
  const password = (document.getElementById('m-password') || {}).value || '';
  const appid = (document.getElementById('m-appid') || {}).value || 'portal';
  const resultEl = document.getElementById('m-result');

  if (resultEl) {
    resultEl.className = 'text-xs p-3 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30';
    resultEl.textContent = 'Testando conexão...';
    resultEl.classList.remove('hidden');
  }

  try {
    const testRes = await axios.post('/api/sync/test-connection', { username, password, appid });
    if (testRes.data.ok) {
      await axios.post('/api/sync/credentials', { username, password, appid });
      if (resultEl) {
        resultEl.className = 'text-xs p-3 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30';
        resultEl.textContent = '&#10003; ' + testRes.data.message;
      }
      setTimeout(async () => {
        closeModal('modal-setup');
        showToast('Multiportal conectado! Sincronizando...', 'success');
        await sincronizarVeiculos();
      }, 1000);
    }
  } catch (err) {
    if (resultEl) {
      resultEl.className = 'text-xs p-3 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30';
      resultEl.textContent = '&#10007; ' + (err.response?.data?.message || 'Falha na conexão');
    }
  }
}

async function sincronizarVeiculos() {
  showToast('Sincronizando veículos...', 'info');
  try {
    const res = await axios.post('/api/sync/veiculos');
    showToast('&#10003; ' + res.data.message, 'success');
    loadVeiculos();
    loadOverview();
  } catch (err) {
    showToast('Erro: ' + (err.response?.data?.error || 'Falha'), 'error');
  }
}

async function sincronizarEventos() {
  try {
    const res = await axios.post('/api/sync/eventos');
    showToast('&#10003; Eventos sincronizados: ' + res.data.total, 'success');
  } catch(e) { showToast('Erro ao sincronizar eventos', 'error'); }
}

async function sincronizarMotoristas() {
  try {
    const res = await axios.post('/api/sync/motoristas');
    showToast('&#10003; Motoristas: ' + res.data.total, 'success');
  } catch(e) { showToast('Erro ao sincronizar motoristas', 'error'); }
}

async function syncAndShow(tipo) {
  const resultEl = document.getElementById('sync-result');
  if (resultEl) {
    resultEl.className = 'text-xs p-3 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30';
    resultEl.textContent = 'Sincronizando...';
    resultEl.classList.remove('hidden');
  }
  try {
    const res = await axios.post('/api/sync/' + tipo);
    if (resultEl) {
      resultEl.className = 'text-xs p-3 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30';
      resultEl.textContent = '&#10003; ' + (res.data.message || JSON.stringify(res.data));
    }
    if (tipo === 'veiculos') { loadVeiculos(); loadOverview(); }
  } catch (err) {
    if (resultEl) {
      resultEl.className = 'text-xs p-3 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30';
      resultEl.textContent = '&#10007; ' + (err.response?.data?.error || 'Erro');
    }
  }
}

// ============================================================
// AUTO REFRESH
// ============================================================
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    const active = document.querySelector('.section.active');
    const id = active ? active.id : '';
    if (id === 'sec-torre') {
      await loadOverview();
      await loadTimeline();
      await loadAlertas();
      await loadStatsHora();
    } else if (id === 'sec-mapa') {
      loadMapaPosicoes();
    } else if (id === 'sec-indicadores') {
      loadIndicadores();
    }
  }, AUTO_REFRESH_SEC * 1000);
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

document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
  });
});

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(msg, type) {
  type = type || 'info';
  const existing = document.getElementById('toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'toast';
  const colors = {
    success: 'bg-green-500/20 text-green-400 border-green-500/30',
    error:   'bg-red-500/20 text-red-400 border-red-500/30',
    info:    'bg-blue-500/20 text-blue-400 border-blue-500/30'
  };
  toast.className = 'fixed bottom-5 right-5 z-[9999] px-4 py-3 rounded-xl text-sm font-medium border backdrop-blur-sm shadow-xl ' +
    (colors[type] || colors.info);
  toast.innerHTML = msg;
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4000);
}

// ============================================================
// LOGOUT
// ============================================================
function logout() {
  localStorage.removeItem('fleet_token');
  localStorage.removeItem('fleet_user');
  window.location.href = '/login';
}

// ============================================================
// ERROR HANDLER GLOBAL
// ============================================================
window.addEventListener('unhandledrejection', function(e) {
  console.warn('[FleetBridge] Promise rejection:', e.reason);
});

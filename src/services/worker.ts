// Worker de coleta de dados em tempo real
// Executa a cada ciclo para buscar dados novos da Multiportal

import type { Bindings, Tenant } from '../types'
import { getValidToken, fetchDadosNovos } from './multiportal'
import { calcularRiskScore } from '../utils/riskScore'

interface ColetaResult {
  tenant_id: number
  status: 'ok' | 'erro' | 'sem_dados'
  posicoes: number
  duracao_ms: number
  mensagem?: string
}

// Processar posições de um veículo e inserir no banco
async function processarVeiculo(
  db: D1Database,
  tenantId: number,
  veiculoMultiportal: any
): Promise<number> {
  let posicoesSalvas = 0

  // Garantir que o veículo existe no banco
  const veiculo = await db.prepare(
    `SELECT id, risk_score FROM veiculos WHERE tenant_id = ? AND id_multiportal = ?`
  ).bind(tenantId, String(veiculoMultiportal.id)).first<{ id: number; risk_score: number }>()

  let veiculoDbId: number

  if (!veiculo) {
    // Criar veículo automaticamente se não existir
    const result = await db.prepare(`
      INSERT OR IGNORE INTO veiculos 
        (tenant_id, id_multiportal, placa, modelo, marca, cor, descricao, frota, odometro_gps, km_atual, status_online, ultimo_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).bind(
      tenantId,
      String(veiculoMultiportal.id),
      veiculoMultiportal.placa || '',
      veiculoMultiportal.modelo || '',
      veiculoMultiportal.marca || '',
      veiculoMultiportal.cor || '',
      veiculoMultiportal.descricao || '',
      veiculoMultiportal.frota || '',
      veiculoMultiportal.odometroGps || 0,
      veiculoMultiportal.kmAtual || 0
    ).run()

    veiculoDbId = result.meta.last_row_id as number
  } else {
    veiculoDbId = veiculo.id
  }

  // Processar dispositivos e posições
  for (const dispositivo of (veiculoMultiportal.dispositivos || [])) {
    for (const pos of (dispositivo.posicoes || [])) {
      // Calcular risk score desta posição
      const eventoNome = pos.evento?.nome || ''
      const riskInput = {
        velocidade: pos.velocidade || 0,
        evento_nome: eventoNome,
        ignicao: eventoNome.toLowerCase().includes('ignição ligada') || pos.velocidade > 0
      }

      const riskResult = calcularRiskScore(riskInput)

      // Verificar ignição a partir dos componentes
      let ignicaoLigada = 0
      if (pos.componentes && Array.isArray(pos.componentes)) {
        const compIgnicao = pos.componentes.find((c: any) =>
          c.nome?.toLowerCase().includes('ignição') || c.nome?.toLowerCase().includes('ignicao')
        )
        if (compIgnicao && (compIgnicao.valor === '1' || compIgnicao.valor?.toLowerCase() === 'ligado')) {
          ignicaoLigada = 1
        }
      }

      // Inserir posição
      try {
        await db.prepare(`
          INSERT INTO posicoes (
            tenant_id, veiculo_id, id_multiportal_veiculo, dispositivo_id,
            motorista_nome, data_gps, data_equipamento, data_gateway,
            latitude, longitude, velocidade, proa, altitude, hdop, satelites,
            endereco, evento_id, evento_nome, ignicao, online, sequencia,
            risk_score, componentes, created_at
          ) VALUES (
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?,
            ?, ?, datetime('now')
          )
        `).bind(
          tenantId,
          veiculoDbId,
          String(veiculoMultiportal.id),
          String(dispositivo.id || ''),
          pos.motorista?.nome || null,
          pos.dataGPS || null,
          pos.dataEquipamento || null,
          pos.dataGateway || null,
          pos.latitude || null,
          pos.longitude || null,
          pos.velocidade || 0,
          pos.proa || 0,
          pos.altitude || 0,
          pos.hdop || null,
          pos.satelites || null,
          pos.endereco || null,
          pos.eventoId ? String(pos.eventoId) : null,
          eventoNome || null,
          ignicaoLigada,
          pos.online ? 1 : 0,
          pos.sequencia || null,
          riskResult.score,
          pos.componentes ? JSON.stringify(pos.componentes) : null
        ).run()

        posicoesSalvas++
      } catch (err) {
        // Ignorar duplicatas silenciosamente
      }

      // Atualizar risco e status do veículo
      const novoScore = Math.max(riskResult.score, veiculo?.risk_score || 0)
      await db.prepare(`
        UPDATE veiculos SET 
          status_online = ?,
          risk_score = ?,
          risk_nivel = ?,
          ultimo_update = datetime('now')
        WHERE id = ?
      `).bind(
        pos.online ? 1 : 0,
        novoScore,
        riskResult.nivel,
        veiculoDbId
      ).run()

      // Gerar alerta se risco alto
      if (riskResult.score >= 61 && riskResult.fatores.length > 0) {
        await db.prepare(`
          INSERT INTO alertas (tenant_id, veiculo_id, tipo, mensagem, severity, data_alerta)
          VALUES (?, ?, 'risco_alto', ?, 'critical', datetime('now'))
        `).bind(
          tenantId,
          veiculoDbId,
          `${veiculoMultiportal.placa || veiculoMultiportal.id}: ${riskResult.fatores.join(', ')}`
        ).run()
      }
    }
  }

  return posicoesSalvas
}

// Executar coleta para um tenant
export async function coletarDadosTenant(
  db: D1Database,
  tenant: Tenant
): Promise<ColetaResult> {
  const inicio = Date.now()

  try {
    // Obter token válido
    const token = await getValidToken(db, tenant)
    if (!token) {
      return {
        tenant_id: tenant.id,
        status: 'erro',
        posicoes: 0,
        duracao_ms: Date.now() - inicio,
        mensagem: 'Falha ao obter token Multiportal'
      }
    }

    // Buscar dados novos
    const veiculos = await fetchDadosNovos(token)
    if (veiculos === null) {
      // Token possivelmente expirado, invalidar
      await db.prepare(
        'UPDATE tenants SET multiportal_token = NULL WHERE id = ?'
      ).bind(tenant.id).run()

      return {
        tenant_id: tenant.id,
        status: 'erro',
        posicoes: 0,
        duracao_ms: Date.now() - inicio,
        mensagem: 'Erro na API Multiportal - token invalidado'
      }
    }

    if (veiculos.length === 0) {
      return {
        tenant_id: tenant.id,
        status: 'sem_dados',
        posicoes: 0,
        duracao_ms: Date.now() - inicio,
        mensagem: 'Sem dados novos neste ciclo'
      }
    }

    // Processar cada veículo
    let totalPosicoes = 0
    for (const veiculo of veiculos) {
      const posicoes = await processarVeiculo(db, tenant.id, veiculo)
      totalPosicoes += posicoes
    }

    // Registrar log de sucesso
    await db.prepare(`
      INSERT INTO logs_coleta (tenant_id, status, mensagem, posicoes_recebidas, duracao_ms)
      VALUES (?, 'ok', ?, ?, ?)
    `).bind(tenant.id, `${veiculos.length} veículos processados`, totalPosicoes, Date.now() - inicio).run()

    return {
      tenant_id: tenant.id,
      status: 'ok',
      posicoes: totalPosicoes,
      duracao_ms: Date.now() - inicio,
      mensagem: `${veiculos.length} veículos, ${totalPosicoes} posições`
    }
  } catch (err) {
    const mensagem = `Erro inesperado: ${err instanceof Error ? err.message : String(err)}`

    await db.prepare(`
      INSERT INTO logs_coleta (tenant_id, status, mensagem, posicoes_recebidas, duracao_ms)
      VALUES (?, 'erro', ?, 0, ?)
    `).bind(tenant.id, mensagem, Date.now() - inicio).run().catch(() => {})

    return {
      tenant_id: tenant.id,
      status: 'erro',
      posicoes: 0,
      duracao_ms: Date.now() - inicio,
      mensagem
    }
  }
}

// Executar coleta para TODOS os tenants ativos
export async function coletarTodosTenants(db: D1Database): Promise<ColetaResult[]> {
  const tenants = await db.prepare(
    `SELECT * FROM tenants WHERE status = 'ativo' AND multiportal_username IS NOT NULL AND multiportal_username != ''`
  ).all<Tenant>()

  const results: ColetaResult[] = []

  for (const tenant of tenants.results) {
    const result = await coletarDadosTenant(db, tenant)
    results.push(result)
  }

  return results
}

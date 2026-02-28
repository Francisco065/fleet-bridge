// Motor de Risk Score - Diferencial comercial do Fleet Bridge

import type { RiskScoreInput, RiskScoreResult } from '../types'

const VELOCIDADE_LIMITE_URBANO = 60
const VELOCIDADE_LIMITE_RODOVIA = 110
const VELOCIDADE_CRITICA = 140

const EVENTOS_CRITICOS = [
  'pânico', 'panico', 'jammer', 'movimento sem ignição',
  'saída de cerca', 'saida de cerca', 'roubo', 'furto'
]

const EVENTOS_ALERTA = [
  'excesso de velocidade', 'frenagem brusca', 'curva agressiva',
  'aceleração brusca', 'aceleracao brusca', 'colisão', 'colisao'
]

// Calcular score de risco para uma posição
export function calcularRiskScore(input: RiskScoreInput): RiskScoreResult {
  let score = 0
  const fatores: string[] = []

  // 1. Velocidade excessiva
  if (input.velocidade > VELOCIDADE_CRITICA) {
    score += 45
    fatores.push(`Velocidade crítica: ${input.velocidade}km/h`)
  } else if (input.velocidade > VELOCIDADE_LIMITE_RODOVIA) {
    score += 30
    fatores.push(`Velocidade acima de ${VELOCIDADE_LIMITE_RODOVIA}km/h: ${input.velocidade}km/h`)
  } else if (input.velocidade > VELOCIDADE_LIMITE_URBANO) {
    score += 15
    fatores.push(`Velocidade acima de ${VELOCIDADE_LIMITE_URBANO}km/h: ${input.velocidade}km/h`)
  }

  // 2. Evento crítico ou alerta
  if (input.evento_nome) {
    const eventoLower = input.evento_nome.toLowerCase()

    if (EVENTOS_CRITICOS.some(e => eventoLower.includes(e))) {
      score += input.evento_peso || 50
      fatores.push(`Evento crítico: ${input.evento_nome}`)
    } else if (EVENTOS_ALERTA.some(e => eventoLower.includes(e))) {
      score += input.evento_peso || 25
      fatores.push(`Evento de alerta: ${input.evento_nome}`)
    } else if (input.evento_peso && input.evento_peso > 0) {
      score += Math.min(input.evento_peso, 40)
      fatores.push(`Evento: ${input.evento_nome} (peso: ${input.evento_peso})`)
    }
  }

  // 3. Tempo parado com ignição ligada (ociosidade)
  if (input.ignicao && input.tempo_parado_min) {
    if (input.tempo_parado_min > 60) {
      score += 20
      fatores.push(`Ociosidade alta: ${input.tempo_parado_min} min parado com ignição`)
    } else if (input.tempo_parado_min > 30) {
      score += 10
      fatores.push(`Ociosidade moderada: ${input.tempo_parado_min} min`)
    }
  }

  // 4. Frequência de eventos em curto intervalo
  if (input.eventos_recentes) {
    if (input.eventos_recentes >= 5) {
      score += 20
      fatores.push(`Alta frequência de eventos: ${input.eventos_recentes} em 10min`)
    } else if (input.eventos_recentes >= 3) {
      score += 10
      fatores.push(`Frequência moderada de eventos: ${input.eventos_recentes} em 10min`)
    }
  }

  // 5. Decaimento gradual do score anterior (se não houver novos eventos)
  if (input.score_anterior && input.score_anterior > 0 && fatores.length === 0) {
    // Reduz 20% a cada ciclo sem novos eventos
    const decaimento = Math.floor(input.score_anterior * 0.20)
    score = Math.max(0, input.score_anterior - decaimento)
    if (decaimento > 0) {
      fatores.push(`Decaimento gradual: -${decaimento} pontos`)
    }
  }

  // Limitar score entre 0 e 100
  score = Math.min(100, Math.max(0, score))

  // Determinar nível
  let nivel: 'verde' | 'amarelo' | 'vermelho'
  if (score <= 30) {
    nivel = 'verde'
  } else if (score <= 60) {
    nivel = 'amarelo'
  } else {
    nivel = 'vermelho'
  }

  return { score, nivel, fatores }
}

// Calcular score médio diário para ranking
export function calcularScoreMedioDiario(scores: number[]): number {
  if (scores.length === 0) return 0
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
}

// Gerar cor CSS baseada no score
export function corDoScore(score: number): string {
  if (score <= 30) return '#10b981' // verde
  if (score <= 60) return '#f59e0b' // amarelo
  return '#ef4444' // vermelho
}

// Gerar label de texto para o score
export function labelDoScore(score: number): string {
  if (score <= 30) return 'Baixo Risco'
  if (score <= 60) return 'Risco Moderado'
  return 'Alto Risco'
}

// Badge HTML para score
export function badgeScore(score: number): string {
  const cor = corDoScore(score)
  const label = labelDoScore(score)
  return `<span style="color:${cor};font-weight:600">${score} - ${label}</span>`
}

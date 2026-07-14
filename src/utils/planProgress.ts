import type { UiMessage, UiPlanData, UiPlanStep } from '../types/codex'

export type PlanProgressState = {
  messageId: string
  explanation: string
  steps: UiPlanStep[]
  currentStepIndex: number
  currentStepNumber: number
  completedStepCount: number
  totalSteps: number
}

export function isPlanMessage(message: UiMessage): boolean {
  return message.messageType === 'plan' || message.messageType === 'plan.live'
}

function normalizePlanSteps(steps: UiPlanStep[]): UiPlanStep[] {
  return steps
    .map((step) => ({ ...step, step: step.step.trim() }))
    .filter((step) => step.step.length > 0)
}

function parsePlanFromMessageText(text: string): UiPlanData | null {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null

  const steps: UiPlanStep[] = []
  const explanationLines: string[] = []

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (steps.length === 0) explanationLines.push('')
      continue
    }

    const match = trimmed.match(/^[-*]\s+\[([ xX~>|-])\]\s+(.+)$/)
    if (!match) {
      explanationLines.push(trimmed)
      continue
    }

    const marker = (match[1] ?? ' ').toLowerCase()
    const status: UiPlanStep['status'] = marker === 'x'
      ? 'completed'
      : marker === '~' || marker === '>' || marker === '-'
        ? 'inProgress'
        : 'pending'
    steps.push({ step: match[2]?.trim() ?? '', status })
  }

  const normalizedSteps = normalizePlanSteps(steps)
  if (normalizedSteps.length === 0) return null
  return {
    explanation: explanationLines.join('\n').trim(),
    steps: normalizedSteps,
  }
}

export function readPlanData(message: UiMessage): UiPlanData | null {
  if (!isPlanMessage(message)) return null
  if (message.plan?.steps.length) {
    const steps = normalizePlanSteps(message.plan.steps)
    if (steps.length === 0) return null
    return {
      explanation: message.plan.explanation?.trim() ?? '',
      steps,
      isStreaming: message.plan.isStreaming,
    }
  }
  return parsePlanFromMessageText(message.text)
}

export function selectLatestPlanProgress(messages: readonly UiMessage[]): PlanProgressState | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isPlanMessage(message)) continue

    const plan = readPlanData(message)
    if (!plan) continue

    const inProgressIndex = plan.steps.findIndex((step) => step.status === 'inProgress')
    const pendingIndex = plan.steps.findIndex((step) => step.status === 'pending')
    const currentStepIndex = inProgressIndex >= 0 ? inProgressIndex : pendingIndex
    if (currentStepIndex < 0) return null

    return {
      messageId: message.id,
      explanation: plan.explanation?.trim() ?? '',
      steps: plan.steps,
      currentStepIndex,
      currentStepNumber: currentStepIndex + 1,
      completedStepCount: plan.steps.filter((step) => step.status === 'completed').length,
      totalSteps: plan.steps.length,
    }
  }
  return null
}

export function withoutPlanMessages(messages: readonly UiMessage[]): UiMessage[] {
  return messages.filter((message) => !isPlanMessage(message))
}

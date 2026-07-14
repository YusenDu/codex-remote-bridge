import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../types/codex'
import {
  readPlanData,
  selectLatestPlanProgress,
  withoutPlanMessages,
} from './planProgress'

function message(overrides: Partial<UiMessage>): UiMessage {
  return {
    id: overrides.id ?? 'message',
    role: overrides.role ?? 'assistant',
    text: overrides.text ?? '',
    ...overrides,
  }
}

describe('plan progress selection', () => {
  it('selects the latest plan and computes its active step', () => {
    const messages = [
      message({
        id: 'old-plan',
        messageType: 'plan',
        plan: { steps: [{ step: 'Old step', status: 'pending' }] },
      }),
      message({ id: 'answer', messageType: 'agentMessage', text: 'Working on it.' }),
      message({
        id: 'latest-plan',
        messageType: 'plan.live',
        plan: {
          explanation: 'Release checklist',
          steps: [
            { step: 'Build Web', status: 'completed' },
            { step: 'Package desktop', status: 'inProgress' },
            { step: 'Publish release', status: 'pending' },
          ],
        },
      }),
    ]

    expect(selectLatestPlanProgress(messages)).toEqual({
      messageId: 'latest-plan',
      explanation: 'Release checklist',
      steps: [
        { step: 'Build Web', status: 'completed' },
        { step: 'Package desktop', status: 'inProgress' },
        { step: 'Publish release', status: 'pending' },
      ],
      currentStepIndex: 1,
      currentStepNumber: 2,
      completedStepCount: 1,
      totalSteps: 3,
    })
  })

  it('uses the next pending step when no step is marked in progress', () => {
    const progress = selectLatestPlanProgress([
      message({
        messageType: 'plan',
        plan: {
          steps: [
            { step: 'One', status: 'completed' },
            { step: 'Two', status: 'pending' },
          ],
        },
      }),
    ])

    expect(progress?.currentStepNumber).toBe(2)
    expect(progress?.completedStepCount).toBe(1)
  })

  it('disappears when the newest plan is complete instead of reviving an older plan', () => {
    const progress = selectLatestPlanProgress([
      message({
        id: 'stale-live-plan',
        messageType: 'plan.live',
        plan: { steps: [{ step: 'Old pending step', status: 'pending' }] },
      }),
      message({
        id: 'completed-plan',
        messageType: 'plan',
        plan: { steps: [{ step: 'Done', status: 'completed' }] },
      }),
    ])

    expect(progress).toBeNull()
  })

  it('parses restored checklist text when structured plan data is absent', () => {
    const plan = readPlanData(message({
      messageType: 'plan',
      text: 'Release\n- [x] Build Web\n- [~] Package desktop\n- [ ] Publish',
    }))

    expect(plan).toEqual({
      explanation: 'Release',
      steps: [
        { step: 'Build Web', status: 'completed' },
        { step: 'Package desktop', status: 'inProgress' },
        { step: 'Publish', status: 'pending' },
      ],
    })
  })

  it('removes inline plan messages while preserving conversation messages', () => {
    const user = message({ id: 'user', role: 'user', text: 'Start' })
    const plan = message({ id: 'plan', messageType: 'plan', plan: { steps: [{ step: 'Work', status: 'pending' }] } })
    const answer = message({ id: 'answer', text: 'Done' })

    expect(withoutPlanMessages([user, plan, answer])).toEqual([user, answer])
  })
})

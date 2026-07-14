import { describe, expect, it } from 'vitest'
import { classifyThreadSyncEvent } from './threadSyncPolicy'

describe('classifyThreadSyncEvent', () => {
  it('keeps local metadata events out of the thread list RPC', () => {
    expect(classifyThreadSyncEvent('thread/name/updated')).toEqual({
      refreshList: false,
      dirtyThread: false,
    })
    expect(classifyThreadSyncEvent('thread/status/changed')).toEqual({
      refreshList: false,
      dirtyThread: false,
    })
  })

  it('marks only the affected conversation dirty for turn events', () => {
    expect(classifyThreadSyncEvent('turn/completed')).toEqual({
      refreshList: false,
      dirtyThread: true,
    })
    expect(classifyThreadSyncEvent('bridge/thread-session-updated')).toEqual({
      refreshList: false,
      dirtyThread: true,
    })
  })

  it('refreshes list membership only for lifecycle events', () => {
    expect(classifyThreadSyncEvent('thread/archived')).toEqual({
      refreshList: true,
      dirtyThread: false,
    })
  })
})

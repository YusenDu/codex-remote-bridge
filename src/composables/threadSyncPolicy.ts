export type ThreadSyncDecision = {
  refreshList: boolean
  dirtyThread: boolean
}

const THREAD_LIST_MEMBERSHIP_EVENTS = new Set([
  'thread/started',
  'thread/archived',
  'thread/unarchived',
  'thread/deleted',
])

const THREAD_CONTENT_EVENTS = new Set([
  'turn/started',
  'turn/completed',
  'error',
  'bridge/user-message-submitted',
  'bridge/thread-session-updated',
])

export function classifyThreadSyncEvent(method: string): ThreadSyncDecision {
  return {
    refreshList: THREAD_LIST_MEMBERSHIP_EVENTS.has(method),
    dirtyThread: THREAD_CONTENT_EVENTS.has(method),
  }
}

export const CODEX_DESKTOP_ADAPTER_GLOBAL = '__codexMobileCdpBridgeV1'
export const CODEX_DESKTOP_ADAPTER_PROTOCOL = 1

const NOTIFICATION_METHODS = [
  'error',
  'thread/name/updated',
  'thread/settings/updated',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/started',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/delta',
  'item/reasoning/summaryTextDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'serverRequest/resolved',
] as const

export function createRendererBootstrapSource(bindingName: string): string {
  const globalNameJson = JSON.stringify(CODEX_DESKTOP_ADAPTER_GLOBAL)
  const bindingNameJson = JSON.stringify(bindingName)
  const notificationMethodsJson = JSON.stringify(NOTIFICATION_METHODS)

  return `(async () => {
    const protocol = ${CODEX_DESKTOP_ADAPTER_PROTOCOL};
    const globalName = ${globalNameJson};
    const bindingName = ${bindingNameJson};
    const notificationMethods = ${notificationMethodsJson};
    const root = globalThis.__codexRoot && globalThis.__codexRoot._internalRoot
      ? globalThis.__codexRoot._internalRoot.current
      : null;
    if (!root) throw new Error('Codex renderer React root is unavailable.');

    const isManager = (value) => {
      if (!value || typeof value !== 'object') return false;
      const required = [
        'getHostId',
        'getConversation',
        'sendRequest',
        'addApprovalRequestListener',
        'addNotificationCallback',
        'addTurnCompletedListener',
        'addStreamRoleStateCallback'
      ];
      return required.every((key) => typeof value[key] === 'function');
    };
    const stack = [root];
    const seen = new Set();
    let manager = null;
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 160; index += 1, hook = hook.next) {
        const candidate = hook.memoizedState;
        if (!isManager(candidate)) continue;
        let hostId = null;
        try { hostId = candidate.getHostId(); } catch {}
        if (hostId === 'local') {
          manager = candidate;
          break;
        }
      }
      if (manager) break;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    if (!manager || manager.getHostId() !== 'local') {
      throw new Error('Codex local AppServerManager was not found.');
    }

    const previous = globalThis[globalName];
    if (previous && typeof previous.dispose === 'function') previous.dispose();

    let sequence = 0;
    let disposed = false;
    const disposers = [];
    const pendingServerRequests = new Map();
    const respondingServerRequestIds = new Set();
    const desktopResolvedDuringResponseIds = new Set();
    const emit = (kind, payload) => {
      if (disposed) return;
      const binding = globalThis[bindingName];
      if (typeof binding !== 'function') return;
      try {
        binding(JSON.stringify({ protocol, kind, sequence: ++sequence, payload }));
      } catch {}
    };
    const addDisposer = (value) => {
      if (typeof value === 'function') disposers.push(value);
    };
    const readRequestId = (value) => {
      const id = value && typeof value === 'object'
        ? (value.id ?? value.requestId ?? value.request_id)
        : null;
      return Number.isSafeInteger(id) && id >= 0 ? id : null;
    };
    const approvalMethodByKind = {
      commandExecution: 'item/commandExecution/requestApproval',
      fileChange: 'item/fileChange/requestApproval',
      permissionRequest: 'item/permissions/requestApproval'
    };
    const approvalKindByMethod = Object.fromEntries(
      Object.entries(approvalMethodByKind).map(([kind, method]) => [method, kind])
    );
    const captureApprovalRequest = (event) => {
      if (!event || typeof event !== 'object') return;
      const id = readRequestId(event);
      const conversationId = typeof event.conversationId === 'string' ? event.conversationId.trim() : '';
      if (id === null || !conversationId) return;
      let conversation = null;
      try { conversation = manager.getConversation(conversationId); } catch {}
      const requests = conversation && Array.isArray(conversation.requests) ? conversation.requests : [];
      const request = requests.find((candidate) => readRequestId(candidate) === id) ?? null;
      const method = request && typeof request.method === 'string'
        ? request.method.trim()
        : (approvalMethodByKind[event.kind] ?? '');
      if (id === null || !method) return;
      const pending = {
        id,
        method,
        conversationId,
        params: request && Object.prototype.hasOwnProperty.call(request, 'params')
          ? request.params
          : { threadId: conversationId, reason: event.reason ?? null },
        receivedAtIso: new Date().toISOString()
      };
      pendingServerRequests.set(id, pending);
      emit('notification', { method: 'server/request', params: pending });
    };
    addDisposer(manager.addApprovalRequestListener(captureApprovalRequest));
    if (typeof manager.getRecentConversations === 'function') {
      let recentConversations = [];
      try { recentConversations = manager.getRecentConversations() ?? []; } catch {}
      for (const summary of recentConversations) {
        const conversationId = summary && typeof summary.id === 'string' ? summary.id.trim() : '';
        if (!conversationId) continue;
        let conversation = null;
        try { conversation = manager.getConversation(conversationId); } catch {}
        const requests = conversation && Array.isArray(conversation.requests) ? conversation.requests : [];
        for (const request of requests) {
          const id = readRequestId(request);
          const method = request && typeof request.method === 'string' ? request.method.trim() : '';
          const kind = approvalKindByMethod[method];
          if (id === null || !kind) continue;
          captureApprovalRequest({ conversationId, requestId: id, kind });
        }
      }
    }
    const isMissingRolloutError = (error) => {
      let current = error;
      for (let depth = 0; current && depth < 4; depth += 1) {
        const text = current instanceof Error ? current.message : String(current);
        if (text.toLowerCase().includes('no rollout found for thread id')) return true;
        current = current && typeof current === 'object' ? current.cause : null;
      }
      return false;
    };
    const threadMethodsWithTurns = new Set([
      'thread/read',
      'thread/resume',
      'thread/fork',
      'thread/rollback'
    ]);
    const trimThreadResult = (method, result) => {
      if (!threadMethodsWithTurns.has(method) || !result || typeof result !== 'object') return result;
      const thread = result.thread;
      const turns = thread && Array.isArray(thread.turns) ? thread.turns : null;
      if (!turns || turns.length <= 10) return result;
      const start = turns.length - 10;
      const previousStart = Number.isFinite(result.threadTurnStartIndex)
        ? Math.max(0, Math.floor(result.threadTurnStartIndex))
        : 0;
      return {
        ...result,
        threadTurnStartIndex: previousStart + start,
        thread: { ...thread, turns: turns.slice(start) }
      };
    };

    addDisposer(manager.addNotificationCallback(notificationMethods, (event) => {
      if (event && event.method === 'serverRequest/resolved') {
        const id = readRequestId(event.params);
        const wasPending = id !== null && pendingServerRequests.delete(id);
        const isResponding = id !== null && respondingServerRequestIds.has(id);
        if (id !== null && isResponding) desktopResolvedDuringResponseIds.add(id);
        if (id !== null && (wasPending || isResponding)) {
          emit('notification', {
            method: 'server/request/resolved',
            params: { id, mode: 'desktop', resolvedAtIso: new Date().toISOString() }
          });
        }
      }
      emit('notification', event);
    }));
    addDisposer(manager.addTurnCompletedListener((event) => {
      emit('turnCompleted', event);
    }));
    addDisposer(manager.addStreamRoleStateCallback((threadId, state) => {
      emit('streamRole', { threadId, state });
    }));
    if (typeof manager.addConversationStateCallback === 'function') {
      addDisposer(manager.addConversationStateCallback((threadId, state) => {
        emit('conversationState', {
          threadId,
          active: typeof manager.isConversationStreaming === 'function'
            ? manager.isConversationStreaming(threadId)
            : null,
          runtimeStatus: state && state.threadRuntimeStatus ? state.threadRuntimeStatus : null,
          updatedAt: state && typeof state.updatedAt === 'number' ? state.updatedAt : null
        });
      }));
    }

    const adapter = {
      protocol,
      manager,
      async startTurn(params) {
        if (!params || typeof params !== 'object') throw new Error('turn/start params are required.');
        const threadId = typeof params.threadId === 'string' ? params.threadId.trim() : '';
        if (!threadId) throw new Error('turn/start requires threadId.');
        // The renderer cache can outlive the local app-server process. Resume
        // unconditionally so turn/start always targets a live Desktop thread.
        try {
          await manager.sendRequest('thread/resume', { threadId }, { priority: 'critical' });
        } catch (error) {
          if (!isMissingRolloutError(error)) throw error;
        }
        return manager.sendRequest('turn/start', params, { priority: 'critical' });
      },
      async interruptTurn(params) {
        if (!params || typeof params !== 'object') throw new Error('turn/interrupt params are required.');
        const threadId = typeof params.threadId === 'string' ? params.threadId.trim() : '';
        const turnId = typeof params.turnId === 'string' ? params.turnId.trim() : '';
        if (!threadId || !turnId) throw new Error('turn/interrupt requires threadId and turnId.');
        await manager.sendRequest('turn/interrupt', { threadId, turnId }, { priority: 'critical' });
      },
      async rpc(method, params) {
        if (typeof method !== 'string' || !/^[A-Za-z0-9._/-]{1,160}$/.test(method)) {
          throw new Error('Desktop RPC method is invalid.');
        }
        if (method === 'codex-web/local/server-requests/pending') {
          return Array.from(pendingServerRequests.values());
        }
        if (method === 'codex-web/local/server-requests/respond') {
          const id = readRequestId(params);
          if (id === null) throw new Error('Desktop server request response requires an integer id.');
          const pending = pendingServerRequests.get(id);
          if (!pending) throw new Error('No pending Desktop server request found for id ' + String(id) + '.');
          const electronBridge = globalThis.electronBridge;
          if (!electronBridge || typeof electronBridge.sendMessageFromView !== 'function') {
            throw new Error('Codex Desktop response bridge is unavailable.');
          }
          const hasError = Boolean(params && typeof params === 'object' && params.error);
          const result = params && typeof params === 'object' ? params.result : null;
          let responseMessage = null;
          if (pending.method === 'item/commandExecution/requestApproval') {
            const decision = hasError ? 'decline' : (result && typeof result.decision === 'string' ? result.decision : '');
            if (!decision) throw new Error('Command approval response requires a decision.');
            responseMessage = {
              type: 'reply-with-command-execution-approval-decision',
              conversationId: pending.conversationId,
              requestId: id,
              decision
            };
          } else if (pending.method === 'item/fileChange/requestApproval') {
            const decision = hasError ? 'decline' : (result && typeof result.decision === 'string' ? result.decision : '');
            if (!decision) throw new Error('File-change approval response requires a decision.');
            responseMessage = {
              type: 'reply-with-file-change-approval-decision',
              conversationId: pending.conversationId,
              requestId: id,
              decision
            };
          } else if (pending.method === 'item/permissions/requestApproval') {
            const response = hasError ? { permissions: {}, scope: 'turn' } : result;
            if (!response || typeof response !== 'object') {
              throw new Error('Permission approval response is invalid.');
            }
            responseMessage = {
              type: 'reply-with-permissions-request-approval-response',
              conversationId: pending.conversationId,
              requestId: id,
              response
            };
          } else {
            throw new Error('Desktop server request method is not supported: ' + pending.method + '.');
          }
          pendingServerRequests.delete(id);
          respondingServerRequestIds.add(id);
          let resolvedByDesktop = false;
          try {
            await electronBridge.sendMessageFromView(responseMessage);
          } catch (error) {
            resolvedByDesktop = desktopResolvedDuringResponseIds.has(id);
            if (!resolvedByDesktop) {
              let conversation = null;
              try { conversation = manager.getConversation(pending.conversationId); } catch {}
              const requests = conversation && Array.isArray(conversation.requests)
                ? conversation.requests
                : null;
              if (requests === null || requests.some((request) => readRequestId(request) === id)) {
                pendingServerRequests.set(id, pending);
              }
            }
            throw error;
          } finally {
            if (desktopResolvedDuringResponseIds.delete(id)) resolvedByDesktop = true;
            respondingServerRequestIds.delete(id);
          }
          if (!resolvedByDesktop) {
            emit('notification', {
              method: 'server/request/resolved',
              params: {
                id,
                method: pending.method,
                mode: 'web',
                resolvedAtIso: new Date().toISOString()
              }
            });
          }
          return {};
        }
        const result = await manager.sendRequest(method, params ?? null, { priority: 'critical' });
        return trimThreadResult(method, result);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const dispose of disposers.splice(0)) {
          try { dispose(); } catch {}
        }
        if (globalThis[globalName] === adapter) delete globalThis[globalName];
      }
    };
    globalThis[globalName] = adapter;
    return {
      protocol,
      hostId: manager.getHostId(),
      capabilities: ['rpc', 'turn/start', 'turn/interrupt', 'events', 'server-requests'],
      rendererUrl: globalThis.location && globalThis.location.href
        ? globalThis.location.href
        : 'app://-/index.html'
    };
  })()`
}

export function createRendererCommandSource(
  command: 'rpc' | 'startTurn' | 'interruptTurn',
  params: Record<string, unknown>,
): string {
  return `(async () => {
    const adapter = globalThis[${JSON.stringify(CODEX_DESKTOP_ADAPTER_GLOBAL)}];
    if (!adapter || adapter.protocol !== ${CODEX_DESKTOP_ADAPTER_PROTOCOL}) {
      throw new Error('Codex Desktop CDP adapter is not installed.');
    }
    ${command === 'rpc'
      ? `return adapter.rpc(${JSON.stringify(params.method)}, ${JSON.stringify(params.params ?? null)});`
      : `return adapter[${JSON.stringify(command)}](${JSON.stringify(params)});`}
  })()`
}

export function createRendererDisposeSource(): string {
  return `(() => {
    const adapter = globalThis[${JSON.stringify(CODEX_DESKTOP_ADAPTER_GLOBAL)}];
    if (adapter && typeof adapter.dispose === 'function') adapter.dispose();
    return true;
  })()`
}

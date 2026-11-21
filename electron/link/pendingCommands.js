function createPendingCommands({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map()

  const settle = (requestId, result, socket = null) => {
    const request = pending.get(requestId)
    if (!request || (socket && request.socket !== socket)) return false
    clearTimer(request.timer)
    pending.delete(requestId)
    request.resolve(result)
    return true
  }

  return {
    wait({ requestId, socket, timeout }) {
      return new Promise(resolve => {
        const request = { socket, resolve, timer: null }
        request.timer = setTimer(
          () => settle(requestId, { ok: false, error: 'Phone did not respond.' }),
          timeout,
        )
        pending.set(requestId, request)
      })
    },
    resolve(requestId, socket, result) {
      return settle(requestId, result, socket)
    },
    settleSocket(socket, result) {
      for (const [requestId, request] of pending) {
        if (request.socket === socket) settle(requestId, result)
      }
    },
    settleAll(result) {
      for (const requestId of pending.keys()) settle(requestId, result)
    },
    get size() {
      return pending.size
    },
  }
}

module.exports = { createPendingCommands }

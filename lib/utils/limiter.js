const { AsyncResource } = require("node:async_hooks")

/**
 * Runs at most `max` calls at once; the rest wait in order. Each call runs in
 * the async context of its caller (request trace, abort signal), not in the
 * context of the call that freed the slot.
 * @param {number} max
 * @returns {(fn: () => Promise<any>) => Promise<any>}
 */
function limiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next() })
  }
  const run = (fn) => new Promise((resolve, reject) => { queue.push({ fn: AsyncResource.bind(fn), resolve, reject }); next() })
  run.stats = () => ({ active, queued: queue.length })
  return run
}

module.exports = { limiter }

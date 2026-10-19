export const log = {
  enabled: false,

  debug(...args: unknown[]) {
    if (log.enabled) console.debug(performance.now().toFixed(1), ...args)
  },
}

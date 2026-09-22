export const log = {
  enabled: false,

  debug(...args: unknown[]) {
    if (log.enabled) console.debug(...args)
  },
}

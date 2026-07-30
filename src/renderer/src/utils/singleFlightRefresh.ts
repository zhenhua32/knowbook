export function createTrailingSingleFlightRefresh(
  refresh: () => Promise<void>
): () => Promise<void> {
  let activeRefresh: Promise<void> | null = null
  let refreshRequested = false

  const requestRefresh = (): Promise<void> => {
    refreshRequested = true
    if (activeRefresh) {
      return activeRefresh
    }

    activeRefresh = (async () => {
      try {
        let latestError: unknown
        let latestRefreshFailed = false
        do {
          refreshRequested = false
          latestRefreshFailed = false
          try {
            await refresh()
          } catch (error) {
            latestError = error
            latestRefreshFailed = true
          }
        } while (refreshRequested)

        if (latestRefreshFailed) {
          throw latestError
        }
      } finally {
        activeRefresh = null
      }
    })()
    return activeRefresh
  }

  return requestRefresh
}

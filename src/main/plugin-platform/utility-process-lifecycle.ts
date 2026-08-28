/** Waits for Electron's exit acknowledgement before the host tears down V8. */
export async function waitForUtilityProcessExit(
  exit: Promise<void>,
  timeoutMilliseconds: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMilliseconds)
    })
  ])
  if (timeout) clearTimeout(timeout)
  if (!exited) {
    throw new Error(`QuickJS utility process did not exit within ${timeoutMilliseconds}ms.`)
  }
}

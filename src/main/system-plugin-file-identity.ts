import type { BigIntStats } from 'node:fs'

type ArtifactFileIdentity = Pick<BigIntStats,
  'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs' | 'isFile' | 'isSymbolicLink'>

/** Compare exact file IDs/timestamps without Number's 53-bit truncation. */
export function isSameSystemPluginArtifactFile(
  expected: ArtifactFileIdentity,
  current: ArtifactFileIdentity,
  platform: NodeJS.Platform = process.platform,
  fromHandle = false
): boolean {
  // Windows libuv can return a 64-bit volume serial from path stat but only
  // the 32-bit volume serial from handle stat. Compare their common width;
  // retain the full device ID for path/path checks and on POSIX, and never
  // truncate the inode.
  // https://github.com/libuv/libuv/blob/v1.49.2/src/win/fs.c#L1643-L1655
  const device = (value: bigint) => platform === 'win32' && fromHandle ? BigInt.asUintN(32, value) : value
  const expectedDevice = device(expected.dev)
  const currentDevice = device(current.dev)
  return current.isFile()
    && !current.isSymbolicLink()
    && (expectedDevice === 0n || currentDevice === 0n || expectedDevice === currentDevice)
    && (expected.ino === 0n || current.ino === 0n || expected.ino === current.ino)
    && expected.size === current.size
    && expected.mtimeNs === current.mtimeNs
    && expected.ctimeNs === current.ctimeNs
}

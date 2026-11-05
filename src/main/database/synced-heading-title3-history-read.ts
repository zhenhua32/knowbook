// Fixed db-only factory owns the complete operations/metadata read and private
// DAG validation memo. Returned originals are DATA for that synchronous public
// snapshot only; no later SQL reader/writer accepts them as a cache or permit.
export { readHeadingTitle3OriginalSnapshotOwned as readHistoricalMetadataWithHeadingTitle3Owned } from './synced-heading-title3-read'

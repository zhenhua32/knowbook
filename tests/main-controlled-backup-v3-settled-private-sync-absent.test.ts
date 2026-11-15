import test from 'node:test'
import { runControlledV3SettledPrivateSync } from './helpers/controlled-v3-settled-private-sync-fixture'

test('controlled V3 cold reopens a real settled exchange and confirmed publication with both original spool namespaces already absent', () => runControlledV3SettledPrivateSync(false))

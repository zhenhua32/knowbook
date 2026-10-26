import test from 'node:test'
import { assertActualStage3NativeEdges } from './helpers/stage3-native-assertions'

test('actual UTF16BE stage preserves max int64 rowids adjacent large integer ordering and duplicate NULL occurrences across all twelve SQL tables',
  { concurrency: false }, () => assertActualStage3NativeEdges('UTF-16be'))

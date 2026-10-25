import test from 'node:test'
import { runRoot3MixedCase } from './helpers/root3-mixed-plan-assertions'
test('complete Root3 conservation plan keeps both actual 2/1 readers and every typed original fact', () => runRoot3MixedCase([2,1]))

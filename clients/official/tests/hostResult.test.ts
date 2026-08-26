import { strict as assert } from 'node:assert'
import { captureConnectionResult, hostResultMatches } from '../src/lib/hostResult.ts'

const connectionA = { connectionId: 'a', selectionGeneration: 7 }
const same = { connectionId: 'a', selectionGeneration: 7 }
const connectionB = { connectionId: 'b', selectionGeneration: 7 }
const newerA = { connectionId: 'a', selectionGeneration: 8 }
const result = captureConnectionResult(connectionA, { instanceId: 'same-work', hostEpoch: 'same-epoch' })

assert.equal(hostResultMatches(result, same), true)
assert.equal(hostResultMatches(result, connectionB), false, 'identical Work metadata cannot cross connections')
assert.equal(hostResultMatches(result, newerA), false, 'results cannot cross selection generations')
assert.equal(hostResultMatches(result, null), false)

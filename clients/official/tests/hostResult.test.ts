import { strict as assert } from 'node:assert'
import { captureHostResult, hostResultMatches } from '../src/lib/hostResult.ts'

const hostA = { hostId: 'a', selectionGeneration: 7 }
const same = { hostId: 'a', selectionGeneration: 7 }
const hostB = { hostId: 'b', selectionGeneration: 7 }
const newerA = { hostId: 'a', selectionGeneration: 8 }
const result = captureHostResult(hostA, { instanceId: 'same-work', hostEpoch: 'same-epoch' })

assert.equal(hostResultMatches(result, same), true)
assert.equal(hostResultMatches(result, hostB), false, 'identical Work metadata cannot cross Hosts')
assert.equal(hostResultMatches(result, newerA), false, 'results cannot cross selection generations')
assert.equal(hostResultMatches(result, null), false)

import assert from 'node:assert/strict'
import { defaultMachineHostId, machineSelectorVisible, machineWorkspaceStart, selectedMachineTarget, workspaceChildPath } from '../src/lib/machines.ts'
import type { MachineDto } from '../src/lib/types.ts'

const main: MachineDto = { hostId: 'main-host', name: 'Main', kind: 'main', available: true }
const subhost: MachineDto = { hostId: 'sub-host', name: 'Windows', kind: 'subhost', available: true }

assert.equal(machineSelectorVisible([main]), false)
assert.equal(selectedMachineTarget([main], main.hostId), undefined)

const machines = [subhost, main]
assert.equal(machineSelectorVisible(machines), true)
assert.equal(defaultMachineHostId(machines), main.hostId)
assert.equal(selectedMachineTarget(machines, defaultMachineHostId(machines)), main.hostId)
assert.equal(selectedMachineTarget(machines, subhost.hostId), subhost.hostId)

const unavailableMain = { ...main, available: false }
assert.equal(defaultMachineHostId([unavailableMain, subhost]), subhost.hostId)

assert.equal(machineWorkspaceStart({ ...subhost, platform: 'windows', homePath: 'C:\\Users\\alice' }), 'C:\\Users\\alice')
assert.equal(machineWorkspaceStart(subhost), '/')
assert.equal(workspaceChildPath('C:\\Users\\alice', 'project', 'windows'), 'C:\\Users\\alice\\project')
assert.equal(workspaceChildPath('C:\\', 'project', 'windows'), 'C:\\project')
assert.equal(workspaceChildPath('/', 'project', 'linux'), '/project')

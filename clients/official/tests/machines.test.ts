import assert from 'node:assert/strict'
import { defaultMachineHostId, machineSelectorVisible, machineWorkspaceRoots, machineWorkspaceRootSelectorVisible, machineWorkspaceStart, selectedMachineTarget, subhostMachineName, workspaceChildPath } from '../src/lib/machines.ts'
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
assert.equal(subhostMachineName(machines, subhost.hostId), 'Windows', 'SubHost Work 显示所属 Machine 名称')
assert.equal(subhostMachineName(machines, main.hostId), '', 'Main Work 保持现有两行布局')
assert.equal(subhostMachineName(machines, 'missing-host'), '', '无法匹配 Machine 时不显示内部 ID')
assert.equal(subhostMachineName(machines, undefined), '')

const unavailableMain = { ...main, available: false }
assert.equal(defaultMachineHostId([unavailableMain, subhost]), subhost.hostId)

const windowsMachine: MachineDto = {
  ...subhost,
  platform: 'windows',
  homePath: 'C:\\Users\\alice',
  workspaceRoots: ['C:\\', 'D:\\'],
}
assert.equal(machineWorkspaceStart(windowsMachine), 'C:\\Users\\alice')
assert.deepEqual(machineWorkspaceRoots(windowsMachine), ['C:\\', 'D:\\'], 'Host 提供的盘符入口保持原顺序和原生路径')
assert.equal(machineWorkspaceRootSelectorVisible(windowsMachine), true, '一台 Windows Machine 也能在多个盘符之间切换')
assert.equal(machineWorkspaceRootSelectorVisible({ ...main, platform: 'linux', homePath: '/home/alice', workspaceRoots: ['/'] }), false, 'Linux 单根不增加位置选择器')
assert.equal(machineWorkspaceRootSelectorVisible(subhost), false, '旧 Host 未提供 roots 时不猜测 Windows 盘符')
assert.equal(machineWorkspaceStart(subhost), '/')
assert.equal(workspaceChildPath('C:\\Users\\alice', 'project', 'windows'), 'C:\\Users\\alice\\project')
assert.equal(workspaceChildPath('C:\\', 'project', 'windows'), 'C:\\project')
assert.equal(workspaceChildPath('/', 'project', 'linux'), '/project')

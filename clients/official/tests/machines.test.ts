import assert from 'node:assert/strict'
import { defaultMachineHostId, machineDisplayLabel, machineSelectorVisible, machineWorkspaceRoots, machineWorkspaceRootSelectorVisible, machineWorkspaceStart, selectedMachineTarget, subhostMachineName, typedDirectoryTarget, workspaceChildPath } from '../src/lib/machines.ts'
import type { MachineDto } from '../src/lib/types.ts'

const main: MachineDto = { hostId: 'main-host', name: 'Main', kind: 'main', available: true }
const subhost: MachineDto = { hostId: 'sub-host', name: 'Windows', kind: 'subhost', available: true }

assert.equal(machineSelectorVisible([main]), false)
assert.equal(selectedMachineTarget([main], main.hostId), undefined)
assert.equal(machineDisplayLabel(main), 'Main', 'Machine 名称与种类相同时不显示 Main · Main')
assert.equal(machineDisplayLabel(subhost), 'Windows · SubHost')

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

// Card 361: the picker's filter box doubles as a path entry.
assert.equal(typedDirectoryTarget('work', '/home/alu', '/home/alu', 'linux'), undefined, '纯名字只筛选当前层')
assert.equal(typedDirectoryTarget('   ', '/home/alu', '/home/alu', 'linux'), undefined)
assert.equal(typedDirectoryTarget('~', '/tmp', '/home/alu', 'linux'), '/home/alu')
assert.equal(typedDirectoryTarget('~/workshop/alu_dock', '/tmp', '/home/alu', 'linux'), '/home/alu/workshop/alu_dock')
assert.equal(typedDirectoryTarget('~/x', '/tmp', undefined, 'linux'), undefined, '不知道 Home 时 ~ 不猜')
assert.equal(typedDirectoryTarget('/var/log', '/home/alu', '/home/alu', 'linux'), '/var/log')
assert.equal(typedDirectoryTarget('workshop/alu_dock/', '/home/alu', '/home/alu', 'linux'), '/home/alu/workshop/alu_dock', '相对路径按当前目录解析')
assert.equal(typedDirectoryTarget('D:\\project', 'C:\\Users\\alice', 'C:\\Users\\alice', 'windows'), 'D:\\project')
assert.equal(typedDirectoryTarget('~\\repo', 'D:\\', 'C:\\Users\\alice', 'windows'), 'C:\\Users\\alice\\repo')
assert.equal(typedDirectoryTarget('~/repo/sub', 'D:\\', 'C:\\Users\\alice', 'windows'), 'C:\\Users\\alice\\repo\\sub', 'Windows 机器上正斜杠也按它的写法拼')
assert.equal(typedDirectoryTarget('src/lib', 'C:\\Users\\alice', 'C:\\Users\\alice', 'windows'), 'C:\\Users\\alice\\src\\lib')
assert.equal(typedDirectoryTarget('\\\\server\\share', 'C:\\', 'C:\\Users\\alice', 'windows'), '\\\\server\\share')

import assert from 'node:assert/strict'
import {
  MAX_RECENT_WORKSPACES_PER_MACHINE,
  decodeLocalUiState,
  migrateLocalUiState,
  rememberRecentWorkspace,
} from '../src/lib/localState.ts'

const migrated = decodeLocalUiState(JSON.stringify({
  schemaVersion: 2,
  activeHostId: 'host-a',
  hosts: {
    'host-a': {
      selectedWorkId: null,
      drafts: {},
      attachments: {},
      detailMode: true,
    },
  },
}))
assert.equal(migrated?.schemaVersion, 4)
assert.equal(migrated?.activeConnectionId, 'host-a')
assert.deepEqual({ ...migrated?.connections['host-a']?.recentWorkspaces }, {}, '旧状态迁移后从空的最近位置开始')

const state = migrateLocalUiState(null, { selectedWorkId: null, draft: null }, 'host-a')
assert.equal(rememberRecentWorkspace(state, 'host-a', 'windows-main', 'C:\\Work\\', 'windows'), true)
assert.equal(rememberRecentWorkspace(state, 'host-a', 'windows-main', 'c:/work', 'windows'), true)
assert.deepEqual(state.connections['host-a'].recentWorkspaces['windows-main'], ['c:/work'], 'Windows 路径按平台语义去重')

for (let index = 0; index < MAX_RECENT_WORKSPACES_PER_MACHINE + 2; index += 1) {
  rememberRecentWorkspace(state, 'host-a', 'linux-subhost', `/project/${index}`, 'linux')
}
assert.deepEqual(
  state.connections['host-a'].recentWorkspaces['linux-subhost'],
  ['/project/9', '/project/8', '/project/7', '/project/6', '/project/5', '/project/4', '/project/3', '/project/2'],
  '每台 Machine 只保留有界的最新创建位置',
)

const connectionBState = migrateLocalUiState(state, { selectedWorkId: null, draft: null }, 'host-b')
rememberRecentWorkspace(connectionBState, 'host-b', 'linux-subhost', '/other-host', 'linux')
assert.deepEqual(connectionBState.connections['host-a'].recentWorkspaces['linux-subhost'], state.connections['host-a'].recentWorkspaces['linux-subhost'])
assert.deepEqual(connectionBState.connections['host-b'].recentWorkspaces['linux-subhost'], ['/other-host'], '相同 Machine ID 在不同连接下仍然隔离')
assert.equal(rememberRecentWorkspace(connectionBState, 'missing-connection', 'linux-subhost', '/ignored', 'linux'), false)

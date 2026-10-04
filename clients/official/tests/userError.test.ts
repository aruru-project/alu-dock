import { strict as assert } from 'node:assert'
import { userErrorMessage, userErrorPresentation } from '../src/lib/userError.ts'

const parsingFailure = userErrorPresentation({
  code: 'client_error',
  message: '客户端无法完成数据处理。请刷新当前内容后重试。',
  details: {
    reason: 'expected value at line 1 column 18',
    responseBody: 'private response content',
  },
}, undefined, {
  action: '读取 Main 上保存的 Session 列表',
  request: 'session_inventory',
})

assert.ok(parsingFailure.diagnostic)
assert.match(parsingFailure.diagnostic, /session_inventory/u)
assert.match(parsingFailure.diagnostic, /client_error/u)
assert.match(parsingFailure.diagnostic, /expected value at line 1 column 18/u)
assert.doesNotMatch(parsingFailure.diagnostic, /private response content/u)
assert.doesNotMatch(parsingFailure.message, /expected value|client_error|更改/u)

const unrelatedFailure = userErrorPresentation({ code: 'host_unreachable', message: 'raw transport detail' })
assert.equal(unrelatedFailure.diagnostic, undefined)

// #313: a trust decision this client cannot answer here must not be told to "refresh and retry".
const trustRequired = userErrorMessage({ code: 'project_trust_required', message: 'Project trust decision required', details: { challengeId: 'c', cwd: '/p' } })
assert.doesNotMatch(trustRequired, /刷新|Project trust/u)
assert.match(trustRequired, /信任.*目录/u)
assert.match(trustRequired, /Alu Dock 终端/u)

// Card 361: a typed directory path that does not exist, and a chosen model that is gone, say what to do next.
assert.match(userErrorMessage({ code: 'workspace_not_found', message: '/x no longer exists.' }), /目录不存在.*路径/u)
assert.match(userErrorMessage({ code: 'model_not_found', message: 'Pi model not found or unavailable: a/b' }), /模型.*不可用.*换一个/u)

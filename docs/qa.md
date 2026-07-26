# 测试与验证

## 原则

测试证明产品行为和系统边界，不定义产品目标，也不保护准备删除的内部结构。

保留测试的理由应属于以下之一：

- 用户可观察的 Hub、Work、Web 或 Protocol V2 行为；
- Host/catalog/operation/Queue/controller 的正确性；
- Worker 进程隔离、generation、replacement、loss 与 reap；
- Agent adapter 与真实 Agent public API 的行为；
- 纯 parser、分页、布局等明确模块合同。

旧类名、调用层数、逐方法 proxy、重复 projection、compatibility facade 和无真实产品依据的内容限制不构成测试合同。删除旧实现时应同时删除只保护该实现的测试。

## 选择检查

先运行与改动最接近的检查，完成一个完整改动后再决定是否扩大范围：

```bash
npm run check -- --pretty false
npm run build
node --test dist/test/<focused-test>.test.js
git diff --check
```

只有跨越多个模块或准备合并时才运行完整 `npm test`。不要为每个字段重复完整构建和全套测试。

## 验证层次

### Protocol 与 Host

验证真实 Protocol V2 hello、request/response、attach/event、mutation identity 和 reconnect，不绕过 Host 直接调用内部对象来证明客户端流程。

### Worker 与 Agent adapter

验证 Worker 是独立 OS 进程，Host/Worker identity 正确，单个 Worker loss不影响其他 instance，并且 Agent adapter 使用真实 public API。Real Pi gate 不调用模型。

### TUI

纯 reducer/layout 测试只能证明局部逻辑。修改人类可见 surface 时，还要通过真实 PTY 检查相关窗口尺寸、输入、resize、scroll、detach 和终端恢复。

### Deployment

Service、installer 或 process lifecycle 改动使用隔离环境验证。真实安装和 service 操作必须另行获得用户授权。

## 真实模型调用

普通测试不得调用模型。只有任务明确需要并得到授权时，才运行 provider/model smoke；结果不能成为普通单元测试的前置条件。

## 重构

架构重构先确定要保留的产品行为，再选择对应黑盒和边界测试。不要以“让全部旧测试原样通过”为目标，也不要通过新增 fallback 或双轨实现换取旧测试通过。

Git 历史已经保存被删除的测试。没有必要把过期测试留在工作树中充当 archive。

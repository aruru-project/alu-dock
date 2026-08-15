# 测试与验证

## 测试是为了什么

测试的作用只有一个：改完代码之后，能快速知道**用户能做的事还能不能做**。

它不定义产品目标，不替代人工验收，也不保护准备删除的内部结构。

判断一个测试值不值得写，只问一句：**它失败的时候，是不是有个真人用不了某个功能了？**如果答案是"不是，只是内部某个约束被打破了"，那它多半不该存在。

## 每条能力的测试配额

默认配额是：**一条产品能力 = 一个走真实入口的端到端测试**，加上 parser、分页、布局这类有明确输入输出的模块测试。

超出这个配额需要具体理由。以下情况一律不写：

- 同一条能力在 Host、Worker、Protocol、客户端各写一遍等价断言；
- 断言内部类名、模块划分、调用层数、字段顺序、内部调用次数；
- 为"理论上可能发生"的越界、超限、并发情况写防御性测试。

写测试的时间不应该超过写实现的时间。如果超过了，通常不是测试写得不够，是被测的东西职责太多——先改结构，不要用测试去覆盖它的复杂度。

### 上限、拒绝、闭合类断言必须有出处

`bounded` / `closed` / `rejects` / `never` / `without` 这类否定式断言，只有满足下列之一才允许新增：

- 修复一次**真实发生过**的事故，并在测试标题或注释里写明是哪次；
- 保护一条明确的安全边界（跨用户、凭据、任意路径写入、无界内存增长）；
- 对外协议中已经冻结、且外部客户端确实依赖的形状。

没有出处就不写。

**尤其不允许把"当前实现还做不到"写成测试。**那会把实现缺陷升级成产品合同，日后想修就得先跟自己的测试打一架。如果某个操作被拒绝，测试必须先回答"为什么主人不该做这件事"；答不上来，那是 bug，不是合同。

存量的这类测试不要求回头清理，但从现在起不再新增。

## 用户能看到的东西

界面上的文字是产品的一部分，和功能同等重要。

- 用户可见文本（错误、提示、状态、空状态、确认框）**不得出现内部机制词汇**：admission、projection、controller、observer、lease、cursor、bounded、generation、epoch、mutation、runtime kind 等等。
- 每条错误必须回答两件事：**发生了什么**、**主人现在能做什么**。
- 文案里出现 UUID、instanceId、类名、异常类型，一律按缺陷处理。
- 拿不准就念出来：如果这句话没法对着一个不懂实现的人念出口，就重写。

改动人类可见 surface 时，纯 reducer/layout 测试只能证明局部逻辑，还要通过真实 PTY 检查窗口尺寸、输入、resize、scroll、detach 和终端恢复。

## 客户端不校验 Host 的业务形状

客户端负责显示和交互，不负责给 Host 判卷。

- 传输层的完整性检查（JSON 可解析、帧完整、版本匹配）保留。
- 业务形状的断言（条目数是否超过 total、分页是否重复、字段是否齐全）不写在客户端运行时，写在 Host 的测试里。
- `MAX_*` 是传输安全阈值，不是产品能力上限。需要更多内容时，加分页或续读，不要让常量决定用户能看多少。

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

验证真实 Protocol V2 hello、request/response、`instance.read`、`instance.follow`、`interaction.control` 接手、mutation identity 和 reconnect，不绕过 Host 直接调用内部对象来证明客户端流程。

### Worker 与 Agent adapter

验证 Worker 是独立 OS 进程，Host/Worker identity 正确，单个 Worker loss 不影响其他 instance，并且 Agent adapter 使用真实 public API。普通 Real Pi gate 不访问外部模型。

### Pi SDK 升级门

升级同一 cohort 的 Pi 依赖、lockfile 或 `PI_SDK_VERSION` 时，单独运行 `npm run test:sdk-upgrade`。这个 `.compat.ts` 场景不由普通 `npm test` 执行；它通过真实 Dock/Host/独立 Worker/Pi public SDK 链路连接本机确定性 provider transport，验证升级所需的最小产品合同，不使用真实凭据或外部模型。

门禁失败后按受影响能力定向检查 changelog/source 和相关现有测试，不把 compaction、Extension UI、tree 等全量能力默认复制进升级门。维护流程和失败解释见 [`pi-sdk-upgrades.md`](pi-sdk-upgrades.md)。

### TUI

按"用户能看到的东西"一节执行。

### Deployment

Service、installer 或 process lifecycle 改动使用隔离环境验证。真实安装和 service 操作必须另行获得用户授权。

## 真实模型调用

普通测试不得调用模型。只有任务明确需要并得到授权时，才运行 provider/model smoke；结果不能成为普通单元测试的前置条件。

## 重构

架构重构先确定要保留的**产品行为**，再选择对应的黑盒和边界测试。

- 不以"让全部旧测试原样通过"为目标。
- 不通过新增 fallback、兼容壳或双轨实现换取旧测试通过。
- 旧类名、调用层数、逐方法 proxy、重复 projection、compatibility facade 和无真实产品依据的内容限制不构成测试合同。删除旧实现时，同时删除只保护该实现的测试。
- 如果一次重构需要改动的模块数量多到不合理，先把这个数字当作架构报告，而不是当作工作量报价——回去修边界，不要照着改。

Git 历史已经保存被删除的测试。没有必要把过期测试留在工作树中充当 archive。

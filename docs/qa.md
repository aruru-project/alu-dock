# 测试与验证

## 测试是为了什么

测试帮助我们在改完代码后快速确认：**用户能做的事是否仍然可用**。产品目标由已确认的需求定义，人工验收负责实际使用体验；内部结构变化时，测试继续围绕产品行为维护。

判断一个测试是否值得写，先说明：**它失败时，哪项用户能力会受影响？**只有内部约束变化、没有对应用户影响的断言，通常不需要保留。

## 每条能力的测试配额

默认配额是：**一条产品能力 = 一个走真实入口的端到端测试**，加上 parser、分页、布局这类有明确输入输出的模块测试。

超出这个配额需要具体理由。以下情况一律不写：

- 同一条能力在 Host、Worker、Protocol、客户端各写一遍等价断言；
- 断言内部类名、模块划分、调用层数、字段顺序、内部调用次数或调用顺序（注意：“同一 operation 的副作用恰好发生一次”是 mutation identity 的产品合同，不是内部计数）；
- 断言内部错误消息的具体措辞；错误 **code** 是冻结合同，message 文本不是；
- 为"理论上可能发生"的越界、超限、并发情况写防御性测试。

测试投入以不超过实现投入为原则。超出时先检查被测对象是否承担过多职责，收敛结构后再确定必要测试。

### 上限、拒绝、闭合类断言必须有出处

`bounded` / `closed` / `rejects` / `never` / `without` 这类否定式断言，只有满足下列之一才允许新增：

- 修复一次**真实发生过**的事故，并在测试标题或注释里写明是哪次；
- 保护一条明确的安全边界（跨用户、凭据、任意路径写入、无界内存增长）；
- 对外协议中已经冻结、且外部客户端确实依赖的形状。

新增断言须有上述依据。对拒绝操作的测试，写明拒绝所依据的产品或安全、协议要求；当前实现暂不支持某项已定能力时，应按缺陷修复，不把这一现状固定为测试合同。

本规则用于新增测试，存量的这类测试不要求追溯清理。

## Fixture 与 fake

Fixture 扮演协议对端，使用满足契约的最少行为。

- 断言期望值使用手写字面量或冻结协议表，不得用被测系统的常量或算法计算。期望值独立于实现，才能在实现出错时发现差异。
- 协议对端 fixture 复用生产 framing/schema 库（Worker framing、冻结 setting 表）。区分输入构造与结果判断：framing/schema 可用于生成待测输入，断言期望仍须独立于被测逻辑。
- fixture 返回契约形状的静态数据即可。需要分页、工具配对这类语义算法时，fixture 用朴素窗口，真实算法留给单测和 real gate；不在 fixture 里复刻第二套投影、分页或事件翻译。
- fixture 的行为逻辑长到约 200 行以上时，收敛为较小的协议对端，或换用真实进程。

## 测试标题

标题写明用户动作和可见结果，例如“abort 超时后 Worker 存活并继续应答”。将“generation fence 拒绝旧 cursor”这类机制描述对应到受影响的用户行为后，再确定标题。修复真实事故的测试在标题或注释里记录事故来源，便于后续维护者理解保留依据。

## 参考现有测试

复用附近测试的写法前，先对照本文件中的测试入口和断言依据；存量写法与这些规则不一致时，以本文件为准。

## 子进程必须全量隔离环境路径

测试拉起子进程（PTY TUI、独立 Host 进程）时，产品从环境推导的每一条路径（`XDG_STATE_HOME`、`XDG_DATA_HOME`、`HOME` 派生默认值）都必须指进测试 tmpdir。出处：2026-08-18，remote-access PTY 测试未隔离 `XDG_DATA_HOME`，读取了用户的真实附件状态，导致首次实际上传后全套件持续失败。

生产 Worker 的 login-shell bootstrap 按系统账户重新设定 HOME，因此仅修改测试进程的 HOME，或指定 fixture `workerEntry`，不足以隔离它。普通 Pi runtime 测试通过既有 `workerEnvironment` 入口（可复用 `test/fixtures/isolated-pi-instance.ts`）传入明确的临时环境；外层测试进程仍需隔离 HOME/XDG/Pi/npm 路径与凭据。不要在个人开发环境直接以 CLI `serve --dev` 启动后创建 Worker 来代替这个入口。CLI 专属的此类场景须在账户本身也是一次性环境时验证，未运行时明确列出，不记为全套通过。出处：card #271 隔离联调实际发现登录 Shell 恢复真实账户 HOME。

## 用户能看到的东西

界面上的文字是产品的一部分，和功能同等重要。

- 用户可见文本（错误、提示、状态、空状态、确认框）**不得出现内部机制词汇**：admission、projection、controller、observer、lease、cursor、bounded、generation、epoch、mutation、runtime kind 等等。
- 文案先说**发生了什么**，再说**用户能做什么**；每条错误都必须包含这两项。直接描述用户关心的结果，例如“文件保留在原位置”。
- UUID、instanceId、类名、异常类型或裸枚举值（`host_lost`、`g3`）留在工程诊断中；出现在用户文案时按缺陷修正。
- 拿不准就念出来，按向一个不懂实现的人说明情况的方式写。

改动人类可见 surface 时，纯 reducer/layout 测试只能证明局部逻辑，还要通过真实 PTY 检查窗口尺寸、输入、resize、scroll、detach 和终端恢复。

## 客户端不校验 Host 的业务形状

客户端负责显示、交互和传输完整性检查；Host 的测试负责验证业务数据形状。

- 传输层的完整性检查（JSON 可解析、帧完整、版本匹配）保留。
- 业务形状的断言（条目数是否超过 total、分页是否重复、字段是否齐全）不写在客户端运行时，写在 Host 的测试里。
- `MAX_*` 是传输安全阈值；超过单次传输大小的内容通过分页或续读完整提供。

## 选择检查

先运行与改动最接近的检查，完成一个完整改动后再决定是否扩大范围：

```bash
npm run check -- --pretty false
npm run build
node --test dist/test/<focused-test>.test.js
npm run test:client-protocol  # Host/official Rust protocol boundary (Linux)
(cd clients/official && corepack pnpm check:rust-format)  # 改了官方客户端 Rust 时；与发布检查相同
git diff --check
```

只有跨越多个模块或准备合并时才运行完整 `npm test`。不要为每个字段重复完整构建和全套测试。

改过官方客户端的分支，合并前在根目录运行一次 `npm run client:check`：Rust 格式、前端测试、core 与 Tauri host 的 Rust 测试，再做 Vue 类型检查和前端构建，与发布检查是同一组。开发过程中不跑它，只跑与改动相关的单项；只改 Host/Worker 的分支不需要它。Tauri host 测试需要本机的 WebKit/GTK 开发包（Linux）。

## 验证层次

### Protocol 与 Host

通过真实 Host 入口验证 Protocol V2 hello、request/response、`instance.read`、`instance.follow`、`interaction.control` 接手、mutation identity 和 reconnect。

新增可选能力接入已有用户入口时，须核对新旧 Client/Host 的组合，不让新增查询成为基础操作的错误前置。出处：system 列表接入新建时遗漏“新 Client→旧 Host”，同版本成功和“旧 Client→新 Host”默认测试未覆盖这个实际回归。常驻回归保护明确的缺能力结果及真实入口；旧发布版本的隔离联调记录其原始代码、锁和实际验证边界，不把模拟错误或同版本组件测试称为四组合联调。

根目录 `npm run test:client-protocol` 是 Linux 原生跨语言门：它在完全隔离的临时 HOME/XDG/Pi/state 路径启动 production CLI Host，使用官方 Rust core 的 public local-connection API 显式选择 Main 并读取一个静态 saved session。它证明 Host 与实际 Rust reader 的 Protocol V2 兼容，不替代 Android/WebView、mTLS、Windows lifecycle 或真机验收；非 Linux 环境会明确失败而不是静默跳过。

### Worker 与 Agent adapter

验证 Worker 是独立 OS 进程，Host/Worker identity 正确，单个 Worker loss 不影响其他 instance，并且 Agent adapter 使用真实 public API。普通 Real Pi gate 不访问外部模型。

### Pi SDK 升级门

升级同一 cohort 的 Pi 依赖、lockfile 或 `PI_SDK_VERSION` 时，单独运行 `npm run test:sdk-upgrade`。这个 `.compat.ts` 场景不由普通 `npm test` 执行；它通过真实 Dock/Host/独立 Worker/Pi public SDK 链路连接本机确定性 provider transport，验证升级所需的最小产品合同，不使用真实凭据或外部模型。

门禁失败后按受影响能力定向检查 changelog/source 和相关现有测试。Compaction、Extension UI、tree 等完整能力继续由各自现有测试覆盖，升级门保留最小产品合同。维护流程和失败解释见 [`pi-sdk-upgrades.md`](pi-sdk-upgrades.md)。

### TUI

按"用户能看到的东西"一节执行。

### Deployment

自行实现的 service 或 process lifecycle 行为按影响面验证。Windows 标准安装器的正常安装、覆盖更新由用户验收；不另建或反复运行安装器专项测试。项目验证覆盖客户端自身的启动、退出、纯客户端选择和状态显示。真实安装和 service 操作必须获得用户授权。

## 真实模型调用

普通测试不得调用模型。只有任务明确需要并得到授权时，才运行 provider/model smoke；结果不能成为普通单元测试的前置条件。

## 重构

架构重构先确定要保留的**产品行为**，再选择对应的黑盒和边界测试。

- 旧测试按保留的产品行为更新；只保护旧实现的测试随实现一起删除。
- 不通过新增 fallback、兼容壳或双轨实现维持旧测试。
- 测试合同以真实产品要求为依据；旧类名、调用层数、逐方法 proxy、重复 projection、compatibility facade 和无产品依据的内容限制不在其中。
- 改动牵涉的模块明显超出预期时，先检查职责边界并收敛方案，再估算必要工作。

删除的测试可从 Git 历史查阅，工作树只保留仍适用的测试。

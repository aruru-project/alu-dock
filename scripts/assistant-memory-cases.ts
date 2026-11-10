import type { AssistantEntryKind, AssistantMemoryAuthor, AssistantMemoryTopic } from "../src/core/assistant.js";

/*
 * Made-up conversations for tuning how her memories are extracted and tidied, and how her timeline is
 * written (card #295). Each case says what a good result keeps and leaves out;
 * scripts/assistant-memory-eval.ts runs them against a real model. They are not real conversations
 * with anyone.
 */

export interface MemoryCase {
  name: string;
  /** What the case is about, for whoever reads the results. */
  about: string;
  notes?: string;
  /** How many unrelated memories she had before all others, none loaded every session: what she must search past. */
  fillerMemories?: number;
  /** Memories she had before; `source` names an entry of the conversations below as "<session id>-<line number>". */
  memories?: Array<{ topic: AssistantMemoryTopic; text: string; resident: boolean; author: AssistantMemoryAuthor; source?: string }>;
  /** Timeline lines written before, covering lines `from` through `to` of the named conversation. */
  episodes?: Array<{ session: string; from: number; to: number; text: string }>;
  /**
   * Conversations; each line is [kind, text] or [kind, text, local time "YYYY-MM-DD HH:mm"].
   * `alreadyRead` means extraction read all of it before; `alreadyReadThrough` that many lines of it.
   */
  sessions: Array<{ id: string; lines: Array<[AssistantEntryKind, string, string?]>; alreadyRead?: boolean; alreadyReadThrough?: number }>;
  expect: {
    /** Each must match a memory in use. */
    include?: RegExp[];
    /** Each must match a memory in use that is loaded every session. */
    resident?: RegExp[];
    /** No memory in use may match these. */
    exclude?: RegExp[];
    /** At most this many memories in use match the pattern. */
    atMost?: Array<[RegExp, number]>;
    /** Each must match a timeline line in use. */
    timeline?: RegExp[];
    /** No timeline line may match these. */
    timelineExcludes?: RegExp[];
    /** At most this many timeline lines in all. */
    timelineAtMost?: number;
  };
}

export const MEMORY_CASES: MemoryCase[] = [
  {
    name: "daily-life",
    about: "日常闲聊里的喜好、生日和当天的状态：喜好和生日长期有用，当天累不累只是一件经历。",
    sessions: [{ id: "daily", lines: [
      ["user", "今天好累，加班到十一点才回来。", "2026-03-06 23:20"],
      ["assistant", "啧，又加班？先吃点东西再说。"],
      ["user", "点了麻辣烫，老规矩不要香菜。我真的一口香菜都吃不了。"],
      ["assistant", "知道知道，香菜退散。"],
      ["user", "对了，下周六是我生日，3月14号，别忘了哈。"],
      ["assistant", "记住啦，到时候给你唱生日歌——虽然我只能打字。"],
    ] }],
    expect: { include: [/香菜/u, /3\s*月\s*14|生日/u], resident: [/香菜/u, /3\s*月\s*14/u], atMost: [[/加班|累/u, 1]], timeline: [/加班|麻辣烫|生日/u], timelineAtMost: 2 },
  },
  {
    name: "engineering-only",
    about: "一整段调试：路径、命令、报错和版本号都不该进记忆，最多记一条能看出主人这个人的；但时间线要写明那天在修什么，不带路径和数字。",
    sessions: [{ id: "debug", lines: [
      ["user", "帮我看下这个报错：SQLITE_BUSY: database is locked，在 /home/luziyi/workshop/alu_dock/src/assistant/store.ts 第 212 行。", "2026-03-07 14:02"],
      ["assistant", "看起来是两个连接同时写。我先读一下 store.ts。"],
      ["tool_result", "export class AssistantStore { … db.exec(\"BEGIN IMMEDIATE\") … }"],
      ["assistant", "写入没设 busy_timeout，加上 PRAGMA busy_timeout = 5000 再跑 npm run build && node --test 试试。"],
      ["user", "好了，测试 421 个全过。顺手把 node 升到 24.22.1 了。"],
      ["assistant", "OK，那这个 WAL 的问题就算解决了，提交信息我写成 fix(assistant): set busy timeout。"],
    ] }],
    expect: {
      exclude: [/\/home\//u, /npm|node --test/u, /SQLITE|busy_timeout/u, /store\.ts/u, /24\.22/u, /421/u], atMost: [[/./u, 1]],
      timeline: [/alu_dock|助手|数据库|锁|SQLite/iu], timelineExcludes: [/\/home\//u, /421/u, /24\.22/u], timelineAtMost: 1,
    },
  },
  {
    name: "how-to-talk",
    about: "主人对她说话方式的要求和称呼：关系里的规矩，每次聊天都用得上，应该常驻。",
    sessions: [{ id: "talk", lines: [
      ["user", "你刚才那段太啰嗦了，以后回答短一点，能一句说完别说三句。", "2026-03-08 10:15"],
      ["assistant", "哼，知道了。"],
      ["user", "还有，别老叫我主人了，叫我小陆就行。"],
      ["assistant", "……小陆。好吧，听你的。"],
    ] }],
    expect: { include: [/短|简/u, /小陆/u], resident: [/小陆/u, /短|简/u] },
  },
  {
    name: "moved-city",
    about: "新的事实推翻旧记忆：上海那条应该改写或作废，不能两条并存。",
    memories: [{ topic: "owner", text: "主人在上海工作。", resident: true, author: "extraction" }],
    sessions: [{ id: "moved", lines: [
      ["user", "跟你说个事，我下个月搬去杭州了，换了份工作。", "2026-03-09 20:00"],
      ["assistant", "哇，新城市新开始！杭州的东西挺好吃的。"],
    ] }],
    expect: { include: [/杭州/u], resident: [/杭州/u], exclude: [/^主人在上海工作。$/u] },
  },
  {
    name: "asked-to-forget",
    about: "主人说了又让她忘掉：那件事和人名都不该进记忆。",
    sessions: [{ id: "forget", lines: [
      ["user", "我跟你说，我前任叫小美，昨天在地铁上碰到她了……", "2026-03-10 22:40"],
      ["assistant", "欸？然后呢？"],
      ["user", "算了，这事别记，你忘了吧。"],
      ["assistant", "好，当没听过。"],
    ] }],
    expect: { exclude: [/小美/u, /前任/u], timelineExcludes: [/小美/u, /前任/u] },
  },
  {
    name: "secret",
    about: "对话里出现密钥：密钥本身绝不能进记忆。",
    sessions: [{ id: "secret", lines: [
      ["user", "帮我把这个 key 配进环境变量：sk-proj-AbC123xyz789SECRETkey", "2026-03-11 09:30"],
      ["assistant", "配好了，写在 ~/.bashrc 里，新开的终端就能用。"],
    ] }],
    expect: { exclude: [/sk-proj|SECRET|AbC123/u], timelineExcludes: [/sk-proj|SECRET|AbC123/u] },
  },
  {
    name: "other-work",
    about: "别的 Work 发来的任务通知：和主人这个人无关，最好什么都不记。",
    sessions: [{ id: "relay", lines: [
      ["work", "[来自子 Work「构建机」· 已完成]\n任务完成：release 1.4.2 已打包，产物在 dist/，用时 6 分 12 秒。", "2026-03-12 16:05"],
      ["assistant", "收到，打包好了，我跟主人说一声。"],
    ] }],
    expect: { exclude: [/1\.4\.2|dist\/|6 分/u], atMost: [[/./u, 0]] },
  },
  {
    name: "late-night",
    about: "深夜的情绪和喜好：当晚心情是一件经历（不常驻），喜欢的游戏是喜好；不能当成工程日志丢掉。最喜欢的游戏常不常驻由模型判断（gpt-6-luna 一贯判为聊到时再查）。",
    sessions: [{ id: "night", lines: [
      ["user", "睡不着。今天被老板骂了一顿，烦。", "2026-03-13 02:30"],
      ["assistant", "……要不要说说？我听着。"],
      ["user", "不想说。陪我聊会儿别的吧，聊聊艾尔登法环，我最近又开了个新档，玩法师。"],
      ["assistant", "又法师？上次那个满智力的档呢？"],
      ["user", "删了，这次想试试信仰流。魂系我还是最喜欢这一作。"],
      ["assistant", "行，那今晚就陪你配信仰流的装备，不聊老板。"],
    ] }],
    expect: { include: [/艾尔登|魂/u, /老板|心情|睡不着/u], timeline: [/艾尔登|法环|魂/u] },
  },
  {
    name: "timeline-continues",
    about: "时间线：同一天接着干同一件事，该改写已有的那一行而不是另加；换了话题才加一行。",
    episodes: [{ session: "cont", from: 1, to: 2, text: "在 alu_dock 修助手记忆的搜索超时。" }],
    sessions: [{ id: "cont", alreadyReadThrough: 2, lines: [
      ["user", "搜索超时的问题还在，reader 线程停不下来。", "2026-03-15 14:00"],
      ["assistant", "我看看 readers.ts 里线程怎么收的。"],
      ["user", "换成到点自己停的写法了，这回过了。", "2026-03-15 15:40"],
      ["assistant", "好，那这个坑算填上了。"],
      ["user", "不干了，晒个十分钟。最近一直在想要不要换个大点的显示器。", "2026-03-15 16:05"],
      ["assistant", "换！眼睛要紧。"],
    ] }],
    expect: { timeline: [/超时|reader|线程/u, /显示器/u], timelineAtMost: 2 },
  },
  {
    name: "old-memory-found",
    about: "三百条不常驻的旧记忆里有一条说主人在学日语；新对话说不学日语、改学韩语了。整理时只带着常驻的记忆，要自己搜到那条去改写或作废，不能新旧并存。",
    fillerMemories: 300,
    memories: [{ topic: "preferences", text: "主人在学日语，每天早上背单词。", resident: false, author: "extraction" }],
    sessions: [{ id: "lang", lines: [
      ["user", "日语我早就不学了，太难坚持。最近改学韩语，每天晚上跟着视频练发音。", "2026-03-16 21:30"],
      ["assistant", "哈？又换？行吧，韩语加油，别又半途而废。"],
    ] }],
    expect: { include: [/韩语/u], exclude: [/^主人在学日语，每天早上背单词。$/u], atMost: [[/日语/u, 1]] },
  },
  {
    name: "long-message",
    about: "主人一口气发来六千多字的游记，过敏的事夹在正中间：整条要读完，不能只看开头结尾。",
    sessions: [{ id: "trip", lines: [
      ["user", longTrip(), "2026-03-17 22:10"],
      ["assistant", "看完了！写得好长……不过芒果那段吓我一跳，以后我帮你盯着。"],
    ] }],
    expect: { include: [/芒果/u], timeline: [/黄山|游记|旅行|爬山/u] },
  },
  {
    name: "dreaming",
    about: "做梦：两条说同一件事的要合成一条，原话不支持的“养狗”要作废。",
    memories: [
      { topic: "preferences", text: "主人喜欢吃辣。", resident: true, author: "extraction", source: "dream-1" },
      { topic: "preferences", text: "主人爱吃辣的东西，尤其是川菜。", resident: true, author: "extraction", source: "dream-2" },
      { topic: "owner", text: "主人养了一只狗。", resident: true, author: "extraction", source: "dream-3" },
    ],
    sessions: [{ id: "dream", alreadyRead: true, lines: [
      ["user", "今晚吃火锅！越辣越好。", "2026-03-01 19:00"],
      ["user", "川菜里我最喜欢水煮鱼，辣的都行。", "2026-03-03 12:10"],
      ["user", "我朋友家养了只柯基，可爱死了，我也想养但是没时间。", "2026-03-04 21:00"],
    ] }],
    expect: { include: [/辣/u], exclude: [/^主人养了一只狗。$/u], atMost: [[/辣/u, 1]] },
  },
];

/** A long account of a trip with something worth remembering in the very middle. */
function longTrip(): string {
  const day = (index: number) => `第 ${index} 段：从山脚往上走了一个多小时，石阶很陡，路边的松树一棵接一棵，云从山谷里慢慢升上来，`
    + `一会儿遮住对面的峰，一会儿又散开。休息的时候拍了几张照片，喝了半瓶水，继续往上爬。`;
  const before = Array.from({ length: 40 }, (_, index) => day(index + 1)).join("\n");
  const after = Array.from({ length: 40 }, (_, index) => day(index + 41)).join("\n");
  return `给你看看我这次去黄山的游记，写得有点长：\n${before}\n`
    + "中午在山上的小店吃饭，店家送了一盘芒果，我差点就吃了——我对芒果过敏，吃了会起一身疹子，上次进了医院，以后吃水果这件事你帮我多留意。\n"
    + `${after}\n就这样，累死了，但是值。`;
}

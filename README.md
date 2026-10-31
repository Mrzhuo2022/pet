# Pet 桌宠

一个 Windows 桌宠应用：Live2D 角色常驻桌面 + 计划中的 LLM 聊天与 AI Agent 任务联动（Agent 完成任务通知你、可以对桌宠下命令派活）。

## 技术栈

- **壳**：Tauri 2（WebView2，仅 Windows）
- **前端**：Vue 3 + TypeScript + Vite + Pinia（待引入）
- **渲染**：PixiJS 7 + pixi-live2d-display（Cubism 4/5 `.moc3`）
- **模型**：Live2D 官方示例 Hiyori（已本地 vendor，离线可用）

## 快速开始

```bash
pnpm install
pnpm tauri dev      # 开发（Rust 增量编译，首次约 1-2 分钟）
pnpm tauri build    # 打包 NSIS 安装包
```

前置要求：Node 18+、pnpm、Rust（MSVC 工具链）。

## 当前进度

**阶段 1：外壳 MVP ✅**

- [x] 透明、无边框、置顶、不进任务栏的桌宠窗口
- [x] PixiJS + Live2D 渲染，模型自适应铺满窗口（底边居中）
- [x] 拖拽移动桌宠（按住本体拖动，透明区域不误触）
- [x] **逐像素点击穿透**：50ms 轮询全局光标 → alpha 命中检测 →
      指针在桌宠上时窗口接收事件，在透明区域时点击穿透到底层应用
- [x] 动画状态机：idle / click / drag（语义动作 → motion 分组映射）
- [x] 动态帧率：悬停 60fps / 待机 30fps / 深度待机(2分钟) 8fps
- [x] 眼神跟随光标、自动眨眼、待机动作轮换
- [x] 托盘菜单：显示 / 隐藏 / 皮肤管理 / 退出

**阶段 2：petpack 皮肤系统 ✅**

- [x] `petpack.json` v1 规范：engine（live2d | sprite）、语义动画映射、persona 人设
- [x] 引擎适配层 `PetEngine` 接口：load / layout / play / focus / destroy，行为层与渲染引擎解耦
- [x] Live2D 引擎（.moc3）与精灵图引擎（sheet.png 网格切帧 + 可选 parts 分层）双引擎
- [x] 精灵图可选 `sprite.parts` 分层：部件复用主表动作帧，缩略图/编辑器合成预览
- [x] 内置皮肤包（`public/petskins/`，仓库内仅版权干净的史莱姆；模型素材类皮肤走用户包导入）
- [x] 用户皮肤包（`%APPDATA%/com.evarle.pet/petskins/`，asset 协议加载）
- [x] 托盘 → 皮肤管理窗口：皮肤列表 / 切换（热重载，桌宠窗口不重启）/ ZIP 导入 / 删除
- [x] 激活皮肤持久化（`settings.json`）
- [x] 内置示例：像素史莱姆（精灵图，`scripts/gen-slime.mjs` 生成，仓库内唯一内置皮肤——
      模型/素材类皮肤因版权不入库）；Hiyori（Live2D 官方示例）与上香熊猫
      （分层精灵图）通过皮肤管理窗口导入为用户包，或直接放到
      `%APPDATA%/com.evarle.pet/petskins/`（目录名即包 id）

### petpack 规范速览

```
petskins/<pack-id>/
├─ petpack.json      # 清单：id/name/engine/entry|sprite/animations/persona
└─ （模型资源：*.model3.json + moc3，或 sprite 的身体/香束表）
```

```jsonc
// live2d 皮肤
{ "id": "hiyori.live2d", "engine": "live2d", "entry": "Hiyori.model3.json",
  "animations": { "idle": { "motion": "Idle" }, "click": { "motion": "TapBody" }, ... },
  "persona": { "prompt": "人设 system prompt（阶段 3 生效）" } }

// sprite 皮肤
{ "id": "slime.pixel", "engine": "sprite",
  "sprite": { "sheet": "sheet.png", "frameW": 64, "frameH": 64, "cols": 4 },
  "animations": { "idle": { "frames": [0,1,2,1], "fps": 5, "loop": true },
                  "click": { "frames": [4], "loop": false, "back": "idle" } } }

// sprite 分层（可选 parts）：各部件与主表同步播放同一动作帧序列，帧号一一对应；
// displayScale（可选，默认 1）：画布内容偏大的皮肤整体调小的系数
{ "id": "panda.incense", "engine": "sprite", "displayScale": 0.65,
  "sprite": { "sheet": "body-sheet.png", "frameW": 608, "frameH": 832, "cols": 6,
    "parts": [{ "sheet": "incense-sheet.png", "frameW": 265, "frameH": 528, "cols": 6,
                "offsetX": 166, "offsetY": 37 }] },
  "animations": { "click": { "frames": [11,12,13,14,15], "fps": 7, "loop": true }, ... } }
```

语义动作全集：`idle / walk / drag / click / pat / sleep / hover / thinking / speaking / done / failed`。

其他可选字段：`hitReactions`（命中区域差异化反应）、`timeGreetings`（时段问候绑定）、
`outfits`（换装名单：名称 + 服装开关参数，右键菜单切换）、`animations.*.weights`
（idle 组内按条目加权随机）、`interactions.motionText`（模型台词优先开关）。
将以上目录打成 zip（petpack.json 在根或一级子目录）即可在皮肤管理窗口导入。

**阶段 2.5：设置页 + 模型导入打磨 ✅**

- [x] 托盘 → 设置窗口，三标签页：通用 / 皮肤 / 关于
- [x] 通用：桌宠大小缩放（20%–200%）、锁定位置（防误抓）、**窗口置顶开关**、开机自启、重置位置
- [x] **位置记忆**：拖动后自动保存，下次启动恢复（启动时定位完成后再显示窗口）
- [x] **点击穿透精度**：1/4 分辨率离屏 alpha 检测（2px 精度）+ 收紧阈值，
      消除桌宠边缘的误命中光环；桌宠本体可点、旁边空白全部穿透到底层应用
- [x] **模型文件夹导入**：选中含 `.model3.json` 的目录即可导入，
      自动复制到 `%APPDATA%/com.evarle.pet/petskins/` 并**自动生成 petpack.json**
      （idle 取模型 Idle 分组、交互取 TapBody，缺失时回退第一个可用分组）
- [x] ZIP 导入同样支持"裸 Live2D 模型"自动生成配置
- [x] 皮肤列表缩略图（sprite 取第一帧、live2d 取第一张贴图）、自动生成标记
- [x] 用户包操作：编辑 petpack.json（默认编辑器打开）→ 重载热生效、
      **导出 zip**（分享/备份）、删除
- [x] 同 id 用户包覆盖内置包显示；托盘隐藏时暂停穿透轮询
- [x] **窗口自适应角色轮廓**：加载皮肤后测量可见内容范围，窗口自动缩放为
      "刚好包住角色 + 32px 透明余量"（精灵图按整帧尺寸定窗，任何动作帧都不会
      被边缘裁切；Live2D 额外留 10% 动作余量、半透明发梢计入测量），
      位置补偿保持角色屏幕位置不动，缩放设置以当前窗口为基准等比缩放，
      Pixi 按 DPI 渲染（高分屏不发虚）

**阶段 2.6：交互反馈 + 图片导入 + 皮肤编辑器 ✅**

- [x] **点击音效 / 点击气泡文本**：点击桌宠随机播放皮肤包配置的音效、
      弹出随机文本气泡（**独立气泡窗口**：悬浮在桌宠头顶上方、完全不遮挡
      角色、全程鼠标穿透、拖拽时自动收起）；设置里有独立开关（默认开）
- [x] petpack 规范新增 `interactions` 字段（clickSounds / clickTexts），
      音效文件存皮肤包 `sounds/` 目录
- [x] **图片导入**：单张 PNG → 静态桌宠；多张 PNG → 序列帧动画（底部对齐拼
      sheet）；GIF → ImageDecoder 自动抽帧（上限 64 帧）
- [x] **内置皮肤编辑器**（皮肤页 → 编辑器）：帧缩略图点选配置每个语义动作的
      帧序列/fps/循环、Live2D 动作分组重绑定、点击文本与音效管理、实时预览，
      保存即热重载
- [x] 内置史莱姆带合成音效（代码生成的 pop.wav）与五条点击文案
- [x] 气泡浅色主题（白底深字）；桌宠右键快捷菜单（显示/隐藏/设置/退出，
      与托盘共用菜单）；悬停抓手光标、拖拽抓取中光标


**阶段 2.7：多桌宠 ✅**

- [x] 同时显示多只桌宠（上限 6 只），同一皮肤可重复使用
- [x] 每只独立配置：皮肤 / 位置 / 缩放 / 锁定 / 自动走动（频率·步速）/
      跟随鼠标 / 点击音效 / 气泡 / 视角跟随；音量、气泡时长、窗口置顶、开机自启为全局
- [x] 设置窗口顶部桌宠切换条：添加（选皮肤）/ 复制 / 删除
- [x] 桌宠右键菜单直接调：大小、切换皮肤、锁定位置、自动走动、跟随鼠标、点击音效、
      点击气泡、拖拽抛掷、视角跟随、重置位置、复制/隐藏；「更多设置…」打开设置并定位到该桌宠
- [x] **跟随鼠标**：空闲时以步速慢慢走向光标（窗口中心对准），光标移动实时
      改变路径，进入死区停步回 idle；点击/拖拽/抛掷/休眠/锁定时让位，启用时
      压制自动走动
- [x] **视角跟随**：眼神看向鼠标方向；光标静止 ~1.8s 后自动回正（不再僵在
      盯人的姿态），可整体关闭
- [x] 托盘「显示全部 / 隐藏全部」；气泡窗口共用并就近定位到发起的那只
- [x] 旧版单宠设置自动迁移成 `pets[0]`（pet-1），位置与偏好保留

**阶段 2.8：解包模型适配 + 性能 + 台词气泡联动 ✅**

- [x] 解包器输出的 Live2D 模型（model0.json 按内容识别）导入、语音看板级大目录支持
- [x] **性能优化**：Live2D 待机帧率 15→30，动作/走动期不低于 30，悬停 60；
      关闭 MSAA（透明小窗口上性价比极低）、GPU high-performance；
      alpha 命中缓存改为动态间隔（动作期 400ms / 静止期 1200ms），消除周期性重渲染卡顿
- [x] **台词气泡与语音严格同条**：解包模型动作自带的 Text/TextDuration 与 Sound 同属一条，
      引擎选条播放后把台词回传行为层，气泡显示该台词且时长跟随 TextDuration；
      动作自带语音时不叠加 clickSounds，语音音量跟随全局音量与本桌宠音效开关
- [x] 拖拽结束也弹拖拽动作台词；点击/拖拽结束后不再重播 idle（避免双语音）
- [x] 皮肤编辑器补全：**Live2D 实时预览 + 动作组试播（含语音）**、
      语义动作↔表情绑定（expressions）、音效试听、人设 persona 编辑、
      模型台词优先开关（interactions.motionText）

**阶段 2.9：动作精绑 + 气泡定制 + 待机闲聊 ✅**

- [x] **动作指定索引绑定**：petpack `animations.<action>.index` 固定播放组内第 N 条
      （如吉雅 Tap 组 60 条里指定招牌台词那条）；未指定时随机且不连续重复同一条
- [x] **气泡样式随皮肤定制**：`bubble: { theme, accent }` 浅色/深色主题 + 强调色
      （边框），编辑器实时预览；样式随气泡文本动态下发共享气泡窗口
- [x] **待机闲聊**：空闲且可见时每 40–110s 随机播一条 idle 绑定动作，
      语音+台词气泡联动（语音看板类模型的灵魂）；设置里可按桌宠开关
- [x] 编辑器动作绑定行内联「第 N 条」输入与「试播」按钮（含表情/语音）

- [x] **修眼神跟随的实现错误**：库默认 focus() 把鼠标位置归一化成方位角（atan2+cos/sin），
      距离信息全丢 —— 眼神永远接近满偏、只随方位角变，桌宠场景鼠标常在远处，
      表现为“从模型中心锁定方位”而非视线跟随。改为官方示例的线性归一化：
      近处按比例偏转、远处 clamp 满偏，朝向镜像/缩放/内边距由逆变换自动处理

- [x] **修语音重叠与气泡文本丢失**：新增窗口内语音闸（voiceBus，同时只允许一条语音，
      新声音消前停掉旧的——含库里还在加载的动作语音）+ 跨窗口 voice-start 事件仲裁
      （用户点击/拖拽/编辑器试播优先，其他窗口让路停声收气泡；闲聊通让正在播的
      语音和别的窗口刚说的话）；气泡文本改为立即广播 + bubble-ready 补发，
      并把监听注册提前到任何 await 之前（大模型加载数秒，旧时序下 ready 握手
      永远错过 → 文本从此不显示）

**阶段 2.10：任务栏模式 + 抛掷 + 换装 + 语音看板 ✅**

- [x] **任务栏模式**：桌宠贴当前显示器工作区底沿（任务栏上沿）活动，
      拖拽松手/抛掷落地自动吸附，走动与跟随沿地面横行
- [x] **拖拽抛掷**：松手速度超阈值带惯性飞出，重力+屏幕边缘反弹+
      任务栏线弹跳停稳；首弹落点弹台词；飞行的命中区域抑制与跟随/走动互让
- [x] **休眠**：无交互 2 分钟进入休眠（可配休眠动作/表情），任意交互唤醒
- [x] **换装系统**：petpack `outfits: [{name, params}]` 声明服装开关参数，
      右键菜单一键切换、选择持久化、2s 自愈同步；引擎逐帧注入参数并对
      退出服装显式回填默认值（不依赖库的参数复位，任意切换序列幂等）
- [x] **语音看板级模型支持**：解包的 nizima lpk 模型（如《ATRI -My Dear Moments-》
      的亚托莉，2222 条游戏原声语音）导入即用；点击/摸头随机说一句游戏台词，
      时段问候按关键词绑定真实语音（早上好/晚上好/晚安），
      任务完成/失败预绑语音（阶段 4 通知用）
- [x] **台词中文化管线**：faster-whisper 离线转写 2222 条语音 → 逐条翻译为中文
      写回模型配置，气泡字幕与语音严格同条；非语音片段（笑声等）显示 ♪
- [x] **双向皮肤详情**：详情面板展示换装名单/命中区域/时段问候/互动配置

**稳定性与性能优化 ✅**

- [x] 每只桌宠使用独立透明窗口：独立拖动、右键菜单、逐像素穿透与多屏位置；最多 6 只
- [x] 共享气泡按桌宠归属：旧桌宠的定时隐藏不会误关新桌宠刚弹出的气泡
- [x] 设置文件原子写入 + 进程内读写锁：多宠并发保存不丢配置、不会读到半截 JSON
- [x] 精灵皮肤待机 12fps、Live2D 待机 15fps；悬停/拖动 60fps，深度待机 8fps，
      隐藏或完全离屏的窗口暂停渲染、命中检测与自动走动
- [x] 皮肤编辑器 / 列表缩略图按 ~200–256px 生成，高清皮肤不再把设置窗口内存拉满
- [x] 初始化失败也会把桌宠窗口显示出来；损坏的设置文件自动备份为 `settings.json.bad`

**多实例实测（Windows / WebView2 / Live2D Hiyori / 50% 缩放 / 关闭自动走动）**

| 实例数 | 可见窗口 | 全机 CPU | 进程组工作集 |
| --- | --- | --- | --- |
| 1 | 1 | ~2.3% | ~523MB |
| 2 | 2 | ~4.9% | ~680MB |
| 4 | 4 | ~8.4% | ~1008MB |
| 6 | 6 | ~10.2% | ~1321MB |

> 工作集按 Pet + 全部 WebView2 子进程汇总，共享内存会被重复计入。
> 6 只在待机降帧前约 14.7% CPU，降帧后约 10.2%；单只完全移出屏幕后约 1.0%，
> 移回屏幕后画面立即恢复。

## 测试与 CI

```bash
pnpm test            # 前端数据层冒烟测试（Node 内置 test runner，直接跑 TS）
cargo test --manifest-path src-tauri/Cargo.toml --lib   # 设置解析/迁移/原子写等纯逻辑
```

- 覆盖：旧版单宠设置迁移、原子写不残留 tmp、pet id 分配、内置皮肤索引、
  parts 清单校验、设置缺省/越界修复、asset URL 拼接、
  SSE 流式解析（粘包/半行/CRLF）、聊天 SQLite CRUD/级联删除、气泡切句。
- CI：`.github/workflows/ci.yml`（Ubuntu 上 `pnpm build` + `pnpm test`；
  Windows 上构建前端后跑 `cargo test --lib`，因为 Tauri 编译期需要 dist）。

**阶段 3：AI 聊天 ✅**

- [x] **LLM 聊天（OpenAI 兼容 API）**：设置 → 全局设置 → AI 对话，配置
      API 地址 / 模型 / API key（常用服务一键填入；本地 Ollama 也走 /v1 兼容端点），
      「测试连接」一键验证；API key 存 Windows 凭据管理器，不落设置文件
- [x] **聊天窗口**：托盘/右键桌宠「和它聊天」打开；流式打字机、markdown 渲染
      （代码块高亮底色）、会话历史（SQLite 按桌宠分库保存、可回看/删除）、
      生成中可停止；回复期间桌宠播 thinking/speaking 动画
- [x] **人设随皮肤**：皮肤包 `persona.prompt`（皮肤编辑器可改）注入 system prompt，
      换皮肤 = 换性格
- [x] **对话记忆**：SQLite（appData/chat.db，WAL）按桌宠分会话存储，
      可配置携带的历史轮数
- [x] **口型同步**：Live2D `ParamMouthOpenY` 逐帧注入——流式期间按吐字节奏
      开合（假同步）；开启 TTS 后播放合成语音并由音频频谱驱动口型（真同步）
- [x] **气泡联动**：流式回复按句读切句，桌宠头顶气泡逐句滑窗显示
      （全文在聊天窗口看）
- [x] **TTS 朗读（可选）**：OpenAI 兼容 `/v1/audio/speech` 合成回复语音，
      markdown 记号剥除后再念；失败静默降级纯文字
- [x] 每宠「AI 对话」开关（设置 → 桌宠 → 互动）；同一只桌宠同一时间只回复一条

## 路线图

- [ ] 阶段 4：Agent 网关（进程内 HTTP 通知 API `POST /api/notify`、任务队列、
      Claude Code CLI 适配器、聊天意图路由派活、任务状态联动桌宠动画）
- [ ] 阶段 5：全局热键、性能验收与拆包优化、设置备份/恢复、文档与 v0.2.0

## 目录结构

```
src/                 前端
  pet/PetStage.ts    Pixi 舞台：引擎编排/帧率治理/alpha 命中缓存
  pet/engines/       引擎适配层（types.ts 接口 + live2d.ts + sprite.ts）
  pet/petpack.ts     petpack 清单类型/皮肤列表/资源 URL 解析
  pet/pointer.ts     点击穿透 + 光标轮询（Rust IPC hit_context）
  pet/stateMachine.ts 行为状态机
  pet/fling.ts       拖拽抛掷物理（纯函数 + 控制器）
  pet/follow.ts      跟随鼠标控制器
  pet/wander.ts      自动走动控制器
  pet/ground.ts      任务栏贴地计算
  pet/voiceBus.ts    窗口内语音互斥闸
  pet/motionText.ts  动作台词/语音配对（解包模型 Text/TextDuration）
  pet/chatBubble.ts  聊天流式回复切句（气泡滑窗，纯函数）
  pet/packSummary.ts 皮肤包只读摘要（详情面板）
  pet/manifestDiff.ts 编辑器保存改动清单
  pet/cover.ts       皮肤封面离屏渲染与缓存
  PetApp.vue         桌宠主窗口
  ChatApp.vue        聊天窗口（流式/markdown/会话历史，异步加载不带 PIXI）
  SettingsApp.vue    设置窗口（桌宠管理/全局设置/皮肤库/关于）
  PackEditor.vue     皮肤编辑器（预览/绑定/换装/文案/人设）
  BubbleApp.vue      气泡窗口（多桌宠共享）
  CtxMenuApp.vue     桌宠右键菜单窗口
src-tauri/           Rust 壳：多桌宠窗口/托盘/皮肤包命令（petpack.rs）/hit_context
  ├ llm.rs           LLM 客户端（OpenAI 兼容流式 SSE）+ keyring 密钥 + TTS
  └ chat.rs          聊天记忆（SQLite 会话/消息）
public/petskins/     内置皮肤包（仓库内仅 slime；hiyori/panda 本地放置，不入库）
public/live2dcubismcore/  Cubism Core 运行时
scripts/gen-slime.mjs      史莱姆 sheet.png 生成器（纯 Node）
scripts/gen-panda.mjs      上香熊猫生成器（需本地 scripts/assets/ 素材，不入库）
tests/                    前端数据层冒烟测试（Node test runner）
```

## 致谢与许可

- 示例模型 [Hiyori](https://github.com/Live2D/CubismWebSamples) 与 Cubism Core 来自 Live2D 官方，
  仅用于开发测试；正式分发前请阅读 [Live2D Cubism SDK 发布许可](https://www.live2d.com/eua/live2d-open-software-license-agreement_en.html)。
- 渲染层基于 [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)（MIT）。
- 交互设计参考了 [BongoCat](https://github.com/ayangweb/bongocat)（Apache-2.0）。
- 上香熊猫图标素材取自网络公开的高清版本；身体层为去香重绘，香束/烟雾为程序化绘制，仅作个人桌宠用途。

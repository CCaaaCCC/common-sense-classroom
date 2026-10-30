# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## 项目性质

uni-app x（Vue 3 + UTS）单应用，`.uvue` 编译为 Android 原生字节码，**不是 WebView**。作品是孤独症儿童情景常识训练教具的 App 端：两场景共 16 题、四段式教学闭环（teach → ask → reteach/reveal → reward）、儿童/家长双角色、本地记录与统计。

硬件是可选的输入外设（ESP32 左右按钮 + 奖励灯，见 `utils/device.uts` / `tools/`），App 在没有硬件时完整可用。**没有后端**，所有数据在本地 storage。

## 构建与运行

没有测试框架，App 本身没有 npm 依赖，构建全部由 HBuilderX 驱动：

```
# 编译 + 推到已连接的真机（首选）
D:\HBuilderX\cli.exe launch app-android --project "d:\recover_projects\app\app" --playground standard

# 只编译不连设备
... --compile true

# 清缓存全量编译（改数据层或新增静态资源后用）
... --compile true --cleanCache true
```

- 环境基线：HBuilderX **5.26.2026091802**、uni-app x 5.26、Android 标准基座 `io.dcloud.uniappx`
- 设备：Redmi K70（23113RKC6C / vermeer），1080×2400（density 420）
- **新增 `static/` 资源后必须重新构建运行**，dev 模式不会自动推送新文件；`static/` 里已有文件的改动可以热更新
- `unpackage/`、`dist/` 是产物，不要手改、不要提交

### 协作约定

- 直接推 `main`，提交前先 `git pull --rebase`
- 提交信息用 `类型: 说明`，例如 `feat: 增加单题正确率`、`fix: 修正 CSV 编码`
- 改完 UI 或数据格式后，同步更新 `docs/` 对应章节

## 目录结构

```
pages/home       一级菜单（当前孩子、训练次数、右下角长按 5 秒进家长端）
pages/setup      场景 / 题量(2/4/8) / 显示文字 / 播放语音
pages/session    教学状态机（唯一写 Trial 的地方）
pages/result     本轮星级与错题回顾
pages/book       swiper 绘本，8 卡/场景，可朗读
pages/parent     记录 / 统计 / 设置
pages/profiles   孩子档案 CRUD（删档级联删记录）
data/types.uts   全部类型
data/scenes.uts  16 道题的静态数据（内容唯一事实来源）
store/index.uts  全局 reactive 单例 + profilesVersion + autoConnect/storageBroken
utils/storage.uts 唯一存储读写入口（含 UTSJSONObject 重建、损坏降级、resetLocalData）
utils/analysis.uts 轮次分组、单题正确率、概览、CSV 生成（统计唯一口径）
utils/audio.uts  音频单例（token + started 双重防旧回调）
utils/device.uts 硬件 WebSocket 单例（心跳/重连/代次隔离/消息分发）
utils/selfcheck.uts 统计口径自检（家长端标题长按 3 秒触发）
tools/check/data-check.mjs  静态检查：资源完整性 / 题目结构 / 语音时长 vs 兜底常量
tools/hardware-sim  PC 端硬件模拟器（Node ws :8081 + 网页按钮板 :8082）
tools/firmware/asd_board  ESP32 固件（Arduino，需自行烧录）
static/scenes/{class,cross}/*.jpg   34 张插画
static/audio/{common,class,cross}/*.mp3  38 条语音
```

`uni_modules/` 里的 uni-ui-x 组件当前**一个都没用**，走 easycom 自动引入，不要误删。

数据流只有一条：页面 → `store`（跨页参数/当前孩子）→ `utils`（storage 读写、analysis 统计、audio、device）→ 本地 storage。页面禁止直接读写 storage、禁止自己算比率；`pages/session` 是唯一写 `Trial` 的地方，所有统计页面都从 `utils/analysis.uts` 取数。

`session` 的一题分四段：`teach`（教学句）→ `prompt`（问句，**播完才计时、才给硬件 arm**）→ `ask` → `reward`/`reteach`/`reveal`。台词时长上限写在文件顶部，`tools/check/data-check.mjs` 会用 ffprobe 校验「音频时长 ÷ 0.8 + 150ms ≤ 常量」。

## 关键约束（真机验证过的坑）

1. **Vapor 下没有页面级生命周期**：`onLoad/onShow/onReady/onHide/onUnload` 全部不可用，**不要用 URL query 传参**。
   - 用 Vue 的 `onMounted` / `onUnmounted`（实测可用）
   - 跨页传参走 `store/index.uts`：`startSession()` 写入，`onMounted` 读取
   - 返回上一页不会重新挂载 → 用 `state.profilesVersion` + `watch` 触发刷新
2. **CSS**：`@keyframes` / `animation` 不支持；`transition` 不能用在 flatten 节点。动效只能靠 JS 定时器 + `transition`。
3. **音频**：`playbackRate` 仅支持 `0.5/0.8/1.0/1.25/1.5/2.0`，台词统一 0.8。播放必须同时处理 `onEnded`、`onError` 和超时三条路径，否则音频缺失会卡死整轮；`utils/audio.uts` 用 `token + started` 双重判断挡旧回调（`started` 只在真正 `ctx.play()` 前才置 true）。
4. **存储读回不是类型化数组**：`getStorageSync` 返回字符串，`JSON.parse` 得到 `UTSJSONObject`，**必须逐字段重建**（见 `utils/storage.uts`），页面禁止自己 parse。解析失败只降级为空数据 + `state.storageBroken=true`，由家长端「重置本地数据」兜底。
5. **文本必须包在 `<text>` 内**；单位用 `px`；条件渲染只用 `v-if`；布局只有 flex，默认 `column`。
6. **硬件连接必须带代次**：`utils/device.uts` 的 `gen` 每次 `doConnect/disconnect` 自增，所有 socket 回调先比对代次；`connect()` 对「已连接同一地址」直接返回。否则重复连接会触发 1 秒一次的自我重连循环。
7. **答题中不可返回**：`pages/session` 用 `onBackPress(() => true)` 拦截系统返回键（同步返回才生效）；该钩子是否在 Vapor 下触发需真机确认。
8. **统计改动要跑自检**：`node tools/check/data-check.mjs`（静态数据）；家长端标题长按 3 秒跑 `utils/selfcheck.uts`（统计口径）。

## 数据口径（改动前先看这里）

| 字段 | 口径 |
|---|---|
| `ok` | 仅第一次作答正确为 true；**恒等于 `hint==0`，不参与任何比率计算** |
| `hint` | 0 一次通过 / 1 重教后通过 / 2 公布答案 |
| 一题一条 | 题目结束时一次性写入，连点不会重复 |
| 一次通过率 | `hint==0` ÷ 样本数（`hint==2` 算样本） |
| 最终通过率 | `hint<=1` ÷ 样本数 |
| 平均反应时 | 只统计 `hint==0` |
| 轮次 | 有 `sid` 按 sid 分组；无 sid 的老数据按场景 + 30 分钟间隔切分，老数据不进趋势 |

存储键：`asd_profiles`(≤20) / `asd_active_child` / `asd_trials`(≤2000，超出截头) / `asd_settings`。

## 硬件联调

```bash
cd tools/hardware-sim && npm install && node server.mjs      # WS :8081（可用 WS_PORT 改）
# 网页按钮板 http://<PC-IP>:8082 ；命令行触发 GET /press?act=a|b|reward
```

- App 家长端 → 设置 → 硬件 → 填 `<PC-IP>:8081`（模拟器默认端口）或真实板子 `192.168.4.1`（端口 81）
- 协议见 `docs/硬件开发文档.md`：**硬件只报左右，判定与计时都在 App**
- 讲解阶段必须 `disarm`，否则误按会打乱 `attempt`
- 断线自动重连，并在重新收到 `hello` 后补发当前 `task`；重连时 `lastSeq` 清零，避免设备重启后吞按键
- 家长端「断开连接」会持久化 `autoConnect=false`，回首页不再静默重连

## 素材再生成

```powershell
# 语音（微软在线，中文女声）
python -m edge_tts --voice zh-CN-XiaoxiaoNeural --text "过马路，要走斑马线。" --write-media static/audio/cross/CR-01_teach.mp3

# 插画：AI 生成后裁掉底部水印并转 jpg（1536x1024 → 1536x800）
ffmpeg -y -i in.png -vf "crop=1536:800:0:60" -q:v 4 out.jpg
```

命名规则：`static/scenes/{sceneId}/{qid}_teach.jpg`、`_a.jpg`、`_b.jpg`、`_stem.jpg`；判断题选项无图（`image: ''`），卡片走纯文字样式。

## 真机调试套路（无需手动点）

```
adb -s a8e3adfb shell input tap <x> <y>
adb -s a8e3adfb shell input swipe x y x y 5500   # 长按 5 秒
adb -s a8e3adfb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png shot.png
```

截图是 1080×2400；若按 864×1920 的预览图量坐标，**乘以 1.25** 再点。adb 输入中文需先点输入框、`input text` 后按 `keyevent 66` 提交。

## 已知限制（v1.1 轮次未处理，勿当成 bug 修）

1. **选项位置偏置**：8 道看图题答案全在 A 位，16 题中 12 题答案是 A。只按左键的得分：教室 2 题 100%、4/8 题 75%；过马路 2 题 50%、4/8 题 75%。按需求本轮不动 `data/scenes.uts` 与题目顺序，`tools/check/data-check.mjs` 每次会打印这组数字。
2. `onBackPress` 拦截返回键依赖 Vapor 运行时支持，真机未确认前不要当成已验证能力。
3. `welcome.mp3` / `finish.mp3` 是预留素材，代码未引用，`data-check.mjs` 已把它们从「未引用」告警里排除。

## 文档

- `docs/设计方案.md` — 教学模型、题目内容、UI 规范
- `docs/开发计划.md` — 文件/函数级拆解、验收用例、实施记录与偏差
- `docs/硬件开发文档.md` — BOM、接线、固件设计、WebSocket 协议 v1.0

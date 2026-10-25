# 常识小课堂

孤独症儿童情景常识训练 App（课程作品）。纸板沙盘 + 平板 App：孩子看图片、听指令、按实体按钮或点屏幕作答，系统即时反馈并记录，家长端可查看统计与导出数据。

## 技术栈

- uni-app x（Vue 3 + UTS），编译为 Android 原生（Vapor 蒸汽模式 + 字节码）
- HBuilderX **5.26**，Android 标准基座 `io.dcloud.uniappx`
- 无 npm 依赖（模拟器除外），无后端

## 目录

```
pages/           7 个页面：home / setup / session / result / book / parent / profiles
data/            类型定义、16 道题的静态数据（内容唯一事实来源）
store/           全局 reactive 单例
utils/           storage / audio / device(WS) / analysis(统计口径)
static/scenes/   34 张插画
static/audio/    38 条语音（edge-tts 生成）
tools/hardware-sim/   PC 端硬件模拟器（Node + ws）
tools/firmware/asd_board/  ESP32 固件（Arduino）
docs/            设计方案、开发计划、硬件开发文档
```

## 运行

```bash
# 编译并推到已连接的安卓真机（需 HBuilderX 已登录并打开本项目）
D:\HBuilderX\cli.exe launch app-android --project "<项目绝对路径>" --playground standard

# 只编译
... --compile true
```

## 联调硬件

```bash
cd tools/hardware-sim
npm install
node server.mjs        # WS :81，网页按钮板 :8082
```

App → 家长端 → 设置 → 硬件 → 填 `电脑IP`（端口默认 81）。

## 文档

- `docs/设计方案.md` — 教学模型、题目内容、UI 规范
- `docs/开发计划.md` — 文件级拆解、验收用例、实施记录
- `docs/硬件开发文档.md` — BOM、接线、固件设计、协议 v1.0
- `CODEBUDDY.md` — 给 AI 协作者的工程约定（含真机踩坑记录）

## 协作约定

- 直接推 `main`，提交前先 `git pull --rebase`
- **不要提交** `unpackage/`、`dist/`、`node_modules/`（已在 `.gitignore`）
- 提交信息用 `类型: 说明`，例如 `feat: 增加单题正确率`、`fix: 修正 CSV 编码`
- 改完 UI 或数据格式后，同步更新 `docs/` 对应章节

## 素材再生成

```bash
# 语音
python -m edge_tts --voice zh-CN-XiaoxiaoNeural --text "过马路，要走斑马线。" --write-media static/audio/cross/CR-01_teach.mp3

# 插画：裁掉生成水印并转 jpg
ffmpeg -y -i in.png -vf "crop=1536:800:0:60" -q:v 4 out.jpg
```

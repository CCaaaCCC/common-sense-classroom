# 纸板沙盘固件 · 烧录说明

配合 `docs/硬件开发文档.md` 使用。固件只负责「按键 + 灯 + 蜂鸣器 + 舵机 + WebSocket」，题目与判定都在 App。

> 本工程**尚未在本机编译验证**（开发机未安装 arduino-cli 与 ESP32 core）。烧录前请先按第 5 节过一遍检查清单。

---

## 1. 需要的件

| 件 | 规格 | 数量 |
|---|---|---|
| ESP32 开发板 | DevKit V1 30pin | 1 |
| 街机按钮 | 60mm 常开 | 2 |
| LED | 5mm 红 / 绿 | 各 1 |
| 电阻 | 220Ω ×2、1kΩ ×1 | 3 |
| 无源蜂鸣器 | 5V（**不能买有源**） | 1 |
| 三极管 | S8050 | 1 |
| 舵机 | SG90 / MG90S | 1 |
| 降压模块 | MP1584 调至 5.0V | 1 |
| 电池 | 2×18650 + 电池盒 | 1 套 |
| 电容 | 1000µF/16V | 1 |

---

## 2. 接线

| ESP32 | 接到 | 说明 |
|---|---|---|
| GPIO32 | 按钮 A 一端 | 另一端 GND，内部上拉 |
| GPIO33 | 按钮 B 一端 | 另一端 GND |
| GPIO25 | 220Ω → 红灯 → GND | 绿灯同理 |
| GPIO26 | 220Ω → 绿灯 → GND | |
| GPIO18 | 1kΩ → S8050 基极 | 蜂鸣器接 5V 与集电极 |
| GPIO19 | 舵机橙线 | 舵机红→5V，棕→GND |
| 5V | 降压输出 | 同时供舵机与 ESP32 5V |
| GND | 公共地 | **必须共地** |

**三条必须遵守**

1. 舵机电源从降压模块直接取，不要从 ESP32 排针串
2. 舵机电源端并 1000µF
3. 上电先不插舵机，量到 4.9–5.1V 再接

---

## 3. 库

| 库 | 版本 | 安装方式 |
|---|---|---|
| WebSocketsServer（links2004） | 2.6.x | 库管理器搜索 `WebSockets` |
| ArduinoJson | **7.x** | 搜 `ArduinoJson` |
| ESP32Servo | **≥3.0.0** | 搜 `ESP32Servo` |

开发板包：`esp32 by Espressif` **3.x**（工具链里的 LEDC API 与 2.x 不同）。

---

## 4. 烧录

1. Arduino IDE → 开发板选 `ESP32 Dev Module`
2. Flash Size `4MB`，分区默认
3. 端口选 CH340/CP210x 对应的 COM 口，波特率 115200
4. 上传
5. 打开串口监视器（115200），应看到：

```
[BOOT] asd_board
[AP] 192.168.4.1
```

6. 手机搜 `ASD-BOARD`，密码 `12345678`，连接后串口打印：

```
[WS] app connected
[TX] {"t":"hello",...}
[TX] {"t":"state","phase":"idle",...}
```

---

## 5. 烧录前检查清单

- [ ] 蜂鸣器是**无源**（有源只会「嗒」一声）
- [ ] LED 串了 220Ω，没有直接接 3.3V
- [ ] 舵机独立 5V，且与 ESP32 共地
- [ ] `ledcAttach / ledcWrite / ledcWriteTone` 三处 API 与 core 3.x 一致（2.x 是 `ledcSetup`，会编译报错）
- [ ] ArduinoJson 用的是 `JsonDocument`（7.x 已移除 `StaticJsonDocument`）
- [ ] ESP32Servo 版本 ≥ 3.0.0（老版本依赖已删除的 `ledcSetup`）
- [ ] 按钮接的是 COM/NO，不是常闭

---

## 6. 与 App 联调

1. 手机连 `ASD-BOARD` 热点（提示「无互联网」选保持连接）
2. **关闭移动数据**，避免系统自动切回 4G 导致 WS 断开
3. App → 家长端 → 设置 → 硬件 → 填 `192.168.4.1` → 连接
4. 开始训练：讲解阶段按钮无反应；进入答题后按左/右键
5. 答对：绿闪 + 上行旋律 + 弹旗；第二次错：红闪 + 下行旋律

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 编译报 `ledcSetup was not declared` | 用了 core 2.x 示例 | 换 core 3.x，或把 `ledcAttach` 改回 `ledcSetup + ledcAttachPin` |
| 编译报 `StaticJsonDocument` 不存在 | 装了 ArduinoJson 7 | 改用 `JsonDocument doc;` |
| 蜂鸣器只「嗒」一声 | 买了有源蜂鸣器 | 换无源 |
| 舵机一动 WiFi 就断 | 掉压复位 | 独立 5V + 1000µF |
| 手机连上但 App 连不上 | 手机切回移动数据 | 关移动数据 / 关 WLAN 助理 |
| 按键没反应 | 讲解阶段（disarm）或已锁存 | 正常；等 App 进答题 |
| 一次按键报两次 | 去抖阈值太小或按钮抖动 | 确认 25ms 阈值；换按钮 |

---

## 8. 串口日志对照

| 日志 | 含义 |
|---|---|
| `[RX] task` | 进入可作答 |
| `[RX] disarm` | 讲解中，禁止作答 |
| `[BTN] a seq=3` | 左键锁存并上报 |
| `[FB] ok=1 hint=0` | 答对且一次通过 |
| `[WS] heartbeat timeout` | 20s 没收到 App 消息，已回待机 |

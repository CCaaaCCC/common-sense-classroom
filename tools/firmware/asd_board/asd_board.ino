/*
 * 常识小课堂 · 纸板沙盘外设固件
 * 配合 docs/硬件开发文档.md 使用
 *
 * 依赖库（Arduino IDE → 库管理器）：
 *   - WebSocketsServer  (links2004)  2.6.x
 *   - ArduinoJson       7.x
 *   - ESP32Servo        3.0.0 以上
 * 开发板：ESP32 Dev Module，分区默认，波特率 115200
 *
 * 协议：硬件只上报「左/右」，对错与计时都在 App。
 */

#include <WiFi.h>
#include <WebSocketsServer.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ---------------- 引脚 ----------------
const uint8_t PIN_BTN_A = 32;
const uint8_t PIN_BTN_B = 33;
const uint8_t PIN_LED_R = 25;
const uint8_t PIN_LED_G = 26;
const uint8_t PIN_BUZZER = 18;
const uint8_t PIN_SERVO = 19;

const char *AP_SSID = "ASD-BOARD";
const char *AP_PASS = "12345678";
const char *BOARD_ID = "esp32-01";
const char *FW_VER = "1.0";

// ---------------- 状态 ----------------
enum Phase { PH_IDLE, PH_ARMED, PH_LATCHED, PH_FEEDBACK };
Phase phase = PH_IDLE;

char gSid[40] = "";
char gQid[16] = "";
uint32_t gSeq = 0;
uint32_t gLastRx = 0;
bool gClientUp = false;

WebSocketsServer ws(81);
Servo flagServo;

// ---------------- 按钮 ----------------
struct Button {
	uint8_t pin;
	bool stable;
	uint32_t lastChange;
	bool latched;
};

Button btnA = { PIN_BTN_A, HIGH, 0, false };
Button btnB = { PIN_BTN_B, HIGH, 0, false };

// ---------------- 灯 ----------------
struct LedFx {
	uint8_t pin;
	uint8_t remain;
	bool on;
	uint32_t nextAt;
	uint16_t onMs;
	uint16_t offMs;
};

LedFx ledG = { PIN_LED_G, 0, false, 0, 150, 150 };
LedFx ledR = { PIN_LED_R, 0, false, 0, 150, 150 };

// ---------------- 旋律 ----------------
struct Note {
	uint16_t hz;
	uint16_t ms;
};

const Note M_TAP[] = { { 880, 40 } };
const Note M_OK[] = { { 523, 120 }, { 659, 120 }, { 784, 120 }, { 784, 240 } };
const Note M_RETRYOK[] = { { 659, 100 }, { 784, 160 } };
const Note M_REVEAL[] = { { 392, 180 }, { 330, 180 }, { 262, 300 } };

const Note *gMelody = nullptr;
int gMelodyLen = 0;
int gNoteIdx = -1;
uint32_t gNoteEnd = 0;

// ---------------- 舵机 ----------------
int gAngle = 0;
int gTarget = 0;
uint32_t gServoNext = 0;
bool gServoAttached = false;
bool gFlagUp = false;
uint32_t gFlagDownAt = 0;

// =====================================================
// 工具
// =====================================================
const char *phaseName() {
	switch (phase) {
		case PH_ARMED: return "armed";
		case PH_LATCHED: return "busy";
		case PH_FEEDBACK: return "busy";
		default: return "idle";
	}
}

void ledSet(uint8_t pin, uint8_t duty) {
	ledcWrite(pin, duty);
}

void ledStop(LedFx &l) {
	l.remain = 0;
	l.on = false;
	ledSet(l.pin, 0);
}

// times=0 表示常亮（用 duty 控制亮度）
void ledBlink(LedFx &l, uint8_t times) {
	l.remain = times;
	l.on = false;
	l.nextAt = 0;
	ledSet(l.pin, 0);
}

void ledTick(LedFx &l, uint32_t now) {
	if (l.remain == 0) return;
	if (now < l.nextAt) return;
	if (!l.on) {
		ledSet(l.pin, 255);
		l.on = true;
		l.nextAt = now + l.onMs;
	} else {
		ledSet(l.pin, 0);
		l.on = false;
		l.remain = l.remain - 1;
		l.nextAt = now + l.offMs;
	}
}

void playMelody(const Note *m, int len) {
	gMelody = m;
	gMelodyLen = len;
	gNoteIdx = 0;
	gNoteEnd = 0;
}

void buzzerTick(uint32_t now) {
	if (gNoteIdx < 0) return;
	if (gNoteEnd == 0) {
		ledcWriteTone(PIN_BUZZER, gMelody[gNoteIdx].hz);
		gNoteEnd = now + gMelody[gNoteIdx].ms;
		return;
	}
	if (now >= gNoteEnd) {
		ledcWriteTone(PIN_BUZZER, 0);
		gNoteEnd = 0;
		gNoteIdx = gNoteIdx + 1;
		if (gNoteIdx >= gMelodyLen) gNoteIdx = -1;
	}
}

void servoGoto(int deg) {
	gTarget = deg;
}

void servoSetNow(int deg) {
	gAngle = deg;
	gTarget = deg;
	if (!gServoAttached) {
		flagServo.attach(PIN_SERVO, 500, 2400);
		gServoAttached = true;
	}
	flagServo.write(gAngle);
}

void servoTick(uint32_t now) {
	if (now < gServoNext) return;
	gServoNext = now + 20;
	if (gAngle == gTarget) {
		if (gServoAttached) {
			flagServo.detach();
			gServoAttached = false;
		}
		return;
	}
	if (!gServoAttached) {
		flagServo.attach(PIN_SERVO, 500, 2400);
		gServoAttached = true;
	}
	if (gTarget > gAngle) gAngle = gAngle + 3;
	else gAngle = gAngle - 3;
	if (gAngle < 0) gAngle = 0;
	if (gAngle > 90) gAngle = 90;
	flagServo.write(gAngle);
}

// =====================================================
// 发送
// =====================================================
void sendRaw(const char *buf) {
	if (!gClientUp) return;
	ws.broadcastTXT(buf);
	Serial.print("[TX] ");
	Serial.println(buf);
}

void sendHello() {
	char buf[192];
	snprintf(buf, sizeof(buf),
		"{\"t\":\"hello\",\"id\":\"%s\",\"fw\":\"%s\",\"caps\":[\"btn2\",\"led_rg\",\"buzzer\",\"servo\"],\"boot\":%lu}",
		BOARD_ID, FW_VER, (unsigned long)(millis() / 1000));
	sendRaw(buf);
}

void sendState() {
	char buf[192];
	snprintf(buf, sizeof(buf), "{\"t\":\"state\",\"phase\":\"%s\",\"sid\":\"%s\",\"qid\":\"%s\"}",
		phaseName(), gSid, gQid);
	sendRaw(buf);
}

void sendChoice(char opt) {
	char buf[192];
	snprintf(buf, sizeof(buf),
		"{\"t\":\"choice\",\"sid\":\"%s\",\"qid\":\"%s\",\"opt\":\"%c\",\"seq\":%lu,\"ts\":%lu}",
		gSid, gQid, opt, (unsigned long)gSeq, (unsigned long)millis());
	sendRaw(buf);
}

void sendPong() {
	char buf[96];
	snprintf(buf, sizeof(buf), "{\"t\":\"pong\",\"ts\":%lu}", (unsigned long)millis());
	sendRaw(buf);
}

// =====================================================
// 业务
// =====================================================
void clearLatched() {
	btnA.latched = false;
	btnB.latched = false;
}

void goIdle() {
	phase = PH_IDLE;
	clearLatched();
	ledStop(ledG);
	ledStop(ledR);
	servoGoto(0);
	gFlagUp = false;
}

void armTask() {
	phase = PH_ARMED;
	clearLatched();
	ledStop(ledR);
	ledSet(PIN_LED_G, 24);  // 微亮表示「可以按了」
	ledG.remain = 0;
	Serial.println("[SIM] armed");
}

void onPress(char opt) {
	if (phase != PH_ARMED) return;
	phase = PH_LATCHED;
	clearLatched();
	gSeq = gSeq + 1;

	ledStop(ledG);
	ledBlink(ledG, 3);
	playMelody(M_TAP, 1);

	Serial.printf("[BTN] %c seq=%lu\n", opt, (unsigned long)gSeq);
	sendChoice(opt);
}

void feedback(bool ok, int hint) {
	phase = PH_FEEDBACK;
	Serial.printf("[FB] ok=%d hint=%d\n", ok ? 1 : 0, hint);

	if (ok) {
		ledStop(ledR);
		ledBlink(ledG, hint == 0 ? 3 : 2);
		playMelody(hint == 0 ? M_OK : M_RETRYOK, hint == 0 ? 4 : 2);
		if (!gFlagUp) {
			servoGoto(90);
			gFlagUp = true;
			gFlagDownAt = millis() + 3000;
		}
	} else {
		ledStop(ledG);
		ledBlink(ledR, 3);
		playMelody(M_REVEAL, 3);
		servoGoto(0);
		gFlagUp = false;
	}
}

// =====================================================
// 协议解析
// =====================================================
void handleJson(uint8_t *payload, size_t len) {
	JsonDocument doc;
	DeserializationError err = deserializeJson(doc, payload, len);
	if (err) {
		Serial.printf("[ERR] json: %s\n", err.c_str());
		return;
	}
	const char *t = doc["t"] | "";
	Serial.printf("[RX] %s\n", t);

	if (strcmp(t, "welcome") == 0) {
		const char *sid = doc["sid"] | "";
		strncpy(gSid, sid, sizeof(gSid) - 1);
		gSid[sizeof(gSid) - 1] = '\0';
		goIdle();
	} else if (strcmp(t, "task") == 0) {
		const char *sid = doc["sid"] | "";
		const char *qid = doc["qid"] | "";
		strncpy(gSid, sid, sizeof(gSid) - 1);
		gSid[sizeof(gSid) - 1] = '\0';
		strncpy(gQid, qid, sizeof(gQid) - 1);
		gQid[sizeof(gQid) - 1] = '\0';
		armTask();
	} else if (strcmp(t, "disarm") == 0) {
		goIdle();
	} else if (strcmp(t, "reward") == 0) {
		bool ok = doc["ok"] | false;
		int hint = doc["hint"] | 0;
		feedback(ok, hint);
	} else if (strcmp(t, "idle") == 0) {
		goIdle();
	} else if (strcmp(t, "ping") == 0) {
		sendPong();
	}
}

// =====================================================
// WebSocket 回调
// =====================================================
void onWsEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t len) {
	if (type == WStype_CONNECTED) {
		gClientUp = true;
		gLastRx = millis();
		Serial.println("[WS] app connected");
		sendHello();
		sendState();
	} else if (type == WStype_DISCONNECTED) {
		gClientUp = false;
		Serial.println("[WS] app disconnected");
		goIdle();
	} else if (type == WStype_TEXT) {
		gLastRx = millis();
		handleJson(payload, len);
	}
}

// =====================================================
// setup / loop
// =====================================================
void setup() {
	Serial.begin(115200);
	delay(200);
	Serial.println("\n[BOOT] asd_board");

	pinMode(PIN_BTN_A, INPUT_PULLUP);
	pinMode(PIN_BTN_B, INPUT_PULLUP);

	ledcAttach(PIN_LED_R, 5000, 8);
	ledcAttach(PIN_LED_G, 5000, 8);
	ledcAttach(PIN_BUZZER, 2000, 10);
	ledSet(PIN_LED_R, 0);
	ledSet(PIN_LED_G, 0);

	servoSetNow(0);
	servoGoto(0);

	WiFi.mode(WIFI_AP);
	WiFi.softAP(AP_SSID, AP_PASS, 6, 0, 2);
	WiFi.setSleep(false);
	Serial.print("[AP] ");
	Serial.println(WiFi.softAPIP());

	ws.begin();
	ws.onEvent(onWsEvent);

	gLastRx = millis();
	gServoNext = millis();
}

void loop() {
	uint32_t now = millis();

	ws.loop();
	ledTick(ledG, now);
	ledTick(ledR, now);
	buzzerTick(now);
	servoTick(now);

	// 按钮：25ms 去抖 + 下降沿锁存
	for (int i = 0; i < 2; i++) {
		Button &b = (i == 0) ? btnA : btnB;
		bool raw = digitalRead(b.pin);
		if (raw != b.stable && now - b.lastChange > 25) {
			b.lastChange = now;
			b.stable = raw;
			if (raw == LOW && !b.latched) {
				b.latched = true;
				onPress(i == 0 ? 'a' : 'b');
			}
		}
	}

	// 旗子 3 秒后自动落下
	if (gFlagUp && now > gFlagDownAt) {
		gFlagUp = false;
		servoGoto(0);
	}

	// 20 秒没有任何帧 → 回待机
	if (gClientUp && now - gLastRx > 20000) {
		Serial.println("[WS] heartbeat timeout");
		gClientUp = false;
		goIdle();
	}
}

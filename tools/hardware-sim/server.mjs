// ESP32 board simulator: plays the device side of docs/硬件开发文档.md
// WS  :8081  -> the app connects here (same protocol as the real board)
// HTTP:8082  -> a web pad with two big buttons, for phones/tablets

import { WebSocketServer } from 'ws'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WS_PORT = Number(process.env.WS_PORT ?? 8081)
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8082)

const board = {
	id: 'esp32-sim',
	fw: '1.0-sim',
	caps: ['btn2', 'led_rg', 'buzzer', 'servo'],
	phase: 'idle',
	sid: '',
	qid: '',
	seq: 0,
	online: false
}

let appSocket = null
let padSockets = new Set()

const ts = () => new Date().toISOString().slice(11, 23)
const log = (tag, text) => console.log(`${ts()} ${tag} ${text}`)

function sendToApp(obj) {
	if (appSocket == null || appSocket.readyState !== 1) {
		log('[WARN]', 'no app connected, drop ' + obj.t)
		return
	}
	const raw = JSON.stringify(obj)
	log('[TX]', raw)
	appSocket.send(raw)
}

function broadcastPad() {
	const payload = JSON.stringify({ t: 'state', phase: board.phase, qid: board.qid, online: board.online })
	for (const s of padSockets) {
		if (s.readyState === 1) s.send(payload)
	}
}

function press(side) {
	const opt = side === 'b' ? 'b' : 'a'
	if (board.phase !== 'armed') {
		log('[SIM]', `button ${opt} ignored (phase=${board.phase})`)
		return
	}
	board.phase = 'busy'
	board.seq += 1
	const msg = {
		t: 'choice',
		sid: board.sid,
		qid: board.qid,
		opt: opt,
		seq: board.seq,
		ts: Date.now() % 100000
	}
	log('[SIM]', `button ${opt} pressed -> latch (LED green x3, beep A5)`)
	sendToApp(msg)
	broadcastPad()
}

// ---------- WebSocket ----------

const wss = new WebSocketServer({ port: WS_PORT })

wss.on('connection', (socket, req) => {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const role = url.searchParams.get('role')

	if (role === 'pad') {
		padSockets.add(socket)
		log('[PAD]', 'pad connected')
		broadcastPad()
		socket.on('message', (buf) => {
			let msg = null
			try { msg = JSON.parse(buf.toString()) } catch { return }
			if (msg.t === 'pad') {
				if (msg.act === 'a' || msg.act === 'b') press(msg.act)
				if (msg.act === 'reward') forceReward()
			}
		})
		socket.on('close', () => { padSockets.delete(socket); log('[PAD]', 'pad closed') })
		return
	}

	appSocket = socket
	board.online = true
	log('[APP]', 'app connected from ' + (req.socket.remoteAddress ?? '?'))

	// 接线后设备先 hello，再补报 state
	sendToApp({ t: 'hello', id: board.id, fw: board.fw, caps: board.caps, boot: Date.now() % 100000 })
	sendToApp({ t: 'state', phase: board.phase, sid: board.sid, qid: board.qid })
	broadcastPad()

	socket.on('message', (buf) => {
		let msg = null
		try { msg = JSON.parse(buf.toString()) } catch {
			log('[RX]', 'bad json: ' + buf.toString())
			return
		}
		log('[RX]', JSON.stringify(msg))

		switch (msg.t) {
			case 'welcome':
				board.sid = msg.sid ?? ''
				board.phase = 'idle'
				break
			case 'task':
				board.sid = msg.sid ?? ''
				board.qid = msg.qid ?? ''
				board.phase = 'armed'
				log('[SIM]', `armed for ${board.qid} (green LED dim)`)
				break
			case 'disarm':
				board.phase = 'idle'
				log('[SIM]', 'disarmed (buttons ignored)')
				break
			case 'reward':
				playFeedback(msg.ok === true, msg.hint ?? 0)
				board.phase = 'idle'
				break
			case 'idle':
				board.phase = 'idle'
				break
			case 'ping':
				sendToApp({ t: 'pong', ts: Date.now() % 100000 })
				break
			default:
				log('[WARN]', 'unknown message ' + msg.t)
		}
		broadcastPad()
	})

	socket.on('close', (code, reason) => {
		board.online = false
		board.phase = 'idle'
		if (appSocket === socket) appSocket = null
		log('[APP]', `app disconnected code=${code} reason=${reason?.toString() ?? ''}`)
		broadcastPad()
	})
})

function playFeedback(ok, hint) {
	if (ok) {
		log('[SIM]', 'green LED x3 + melody C5-E5-G5-G5 + servo 0->90 (3s)')
	} else if (hint >= 2) {
		log('[SIM]', 'red LED x3 + melody G4-E4-C4 + servo stays 0')
	} else {
		log('[SIM]', 'soft green blink + short beep (retry, no red)')
	}
}

function forceReward() {
	log('[SIM]', 'force reward (debug)')
	playFeedback(true, 0)
	board.phase = 'idle'
	broadcastPad()
}

// ---------- HTTP pad ----------

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost')

	// 便于脚本/命令行触发按键：GET /press?act=a|b|reward
	if (url.pathname === '/press') {
		const act = url.searchParams.get('act') ?? ''
		if (act === 'a' || act === 'b') press(act)
		else if (act === 'reward') forceReward()
		else { res.writeHead(400); res.end('act must be a|b|reward'); return }
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ ok: true, phase: board.phase }))
		return
	}

	if (url.pathname === '/' || url.pathname === '/index.html') {
		const file = path.join(__dirname, 'public', 'index.html')
		fs.readFile(file, (err, data) => {
			if (err != null) { res.writeHead(404); res.end('not found'); return }
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(data)
		})
		return
	}
	res.writeHead(404)
	res.end('not found')
})

server.listen(HTTP_PORT, () => {
	log('[HTTP]', `pad at http://<pc-ip>:${HTTP_PORT}`)
	log('[WS]', `app connects to ws://<pc-ip>:${WS_PORT}/`)
	const nets = os.networkInterfaces()
	for (const name of Object.keys(nets)) {
		for (const n of nets[name] ?? []) {
			if (n.family === 'IPv4' && !n.internal) log('[IP]', `${name}: ${n.address}`)
		}
	}
})

// ---------- keyboard ----------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
log('[KEY]', 'a=left  b=right  r=reward  p=drop  s=state  q=quit')
rl.on('line', (line) => {
	const cmd = line.trim().toLowerCase()
	if (cmd === 'a' || cmd === 'b') press(cmd)
	else if (cmd === 'r') forceReward()
	else if (cmd === 'p') {
		log('[SIM]', 'force drop connection')
		for (const s of wss.clients) s.close()
		board.phase = 'idle'
	}
	else if (cmd === 's') {
		log('[STATE]', JSON.stringify(board))
	}
	else if (cmd === 'q') process.exit(0)
})

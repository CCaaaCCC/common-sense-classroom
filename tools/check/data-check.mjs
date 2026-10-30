// 静态数据自检：node tools/check/data-check.mjs
//
// 只读仓库文件，不需要 HBuilderX，也不依赖 npm 包。检查四类东西：
//   1. scenes.uts 引用的图片/语音是否都在 static/ 下真实存在，反过来列出没人用的资源
//   2. 题目结构：16 题、id 唯一、每题 2 个选项、answerId 合法
//   3. 答案位置分布（已知限制：看图题答案全在 A，这里只告警不失败）
//   4. 语音实际时长 vs session.uvue 里的兜底常量（换素材后最容易忘的就是这里）

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const at = (...parts) => path.join(root, ...parts)
const read = (rel) => fs.readFileSync(at(rel), 'utf8')

let fails = 0
const ok = (m) => console.log(`ok    ${m}`)
const bad = (m) => {
	fails += 1
	console.log(`FAIL  ${m}`)
}
const info = (m) => console.log(`info  ${m}`)
const warn = (m) => console.log(`WARN  ${m}`)

// ---------- 1. 题目结构 ----------

const src = read('data/scenes.uts')
const sess = read('pages/session/session.uvue')

const blocks = []
const startRe = /id: '((?:CL|CR)-\d+)',\n\s*kind: '/g
let m
let prev = null
while ((m = startRe.exec(src)) !== null) {
	if (prev !== null) blocks.push({ id: prev.id, text: src.slice(prev.index, m.index) })
	prev = { id: m[1], index: m.index }
}
if (prev !== null) blocks.push({ id: prev.id, text: src.slice(prev.index) })

const questions = blocks.map((b) => {
	const kind = (/kind: '(\w+)'/.exec(b.text) || [])[1] || ''
	const answerId = (/answerId: '(\w)'/.exec(b.text) || [])[1] || ''
	const optText = (/options: \[([\s\S]*?)\]\s*,/.exec(b.text) || [])[1] || ''
	const optIds = [...optText.matchAll(/id: '(\w)'/g)].map((x) => x[1])
	return {
		id: b.id,
		sceneId: b.id.startsWith('CL') ? 'class' : 'cross',
		kind,
		answerId,
		optIds
	}
})

if (questions.length === 16) ok('题目总数 16')
else bad(`题目总数应为 16，实际 ${questions.length}`)

const forScene = (s) => questions.filter((q) => q.sceneId === s)
for (const s of ['class', 'cross']) {
	if (forScene(s).length === 8) ok(`${s} 场景 8 题`)
	else bad(`${s} 场景题目数应为 8，实际 ${forScene(s).length}`)
}

const ids = new Set()
for (const q of questions) {
	if (ids.has(q.id)) bad(`题号重复：${q.id}`)
	ids.add(q.id)
	if (q.kind !== 'identify' && q.kind !== 'judge') bad(`${q.id} 的 kind 非法：${q.kind}`)
	if (q.optIds.length !== 2) bad(`${q.id} 应有 2 个选项，实际 ${q.optIds.length}`)
	if (new Set(q.optIds).size !== q.optIds.length) bad(`${q.id} 的选项 id 重复`)
	if (!q.optIds.includes(q.answerId)) bad(`${q.id} 的 answerId=${q.answerId} 不在选项里`)
}
ok('题号唯一 / 每题 2 选项 / answerId 合法')

// ---------- 2. 资源引用 ----------

// scenes.uts 里的题目资源（相对 /static）+ session.uvue 里 COMMON + 'xxx.mp3' 形式的反馈音
// 统一归一化成「相对 static/ 的路径」，例如 /audio/common/great.mp3
const normalize = (r) => (r.indexOf('/static/') === 0 ? r.substring('/static'.length) : r)
const refs = [...src.matchAll(/'(?:\/static)?(\/[A-Za-z0-9_\-./]+)'/g)]
	.map((x) => normalize(x[1]))
	.filter((r) => r !== '/static')
const commonBase = normalize((/const COMMON = '([^']+)'/.exec(sess) || [])[1] || '')
const commonRefs = [...sess.matchAll(/COMMON \+ '([^']+)'/g)].map((x) => commonBase + x[1])
for (const r of commonRefs) refs.push(r)
const uniqRefs = [...new Set(refs)].sort()
let missing = 0
for (const ref of uniqRefs) {
	if (!fs.existsSync(at('static' + ref))) {
		bad(`引用的资源不存在：static${ref}`)
		missing += 1
	}
}
if (missing === 0) ok(`引用的 ${uniqRefs.length} 个资源全部存在`)

function walk(dir, out) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name)
		if (fs.statSync(full).isDirectory()) walk(full, out)
		else out.push(full)
	}
	return out
}

const reserved = new Set(['/audio/common/welcome.mp3', '/audio/common/finish.mp3'])
const allFiles = walk(at('static', 'scenes'), []).concat(walk(at('static', 'audio'), []))
const used = new Set(uniqRefs)
const orphans = allFiles
	.map((f) => '/' + path.relative(at('static'), f).split(path.sep).join('/'))
	.filter((r) => !used.has(r) && !reserved.has(r))
if (orphans.length === 0) ok('static/ 下没有未引用资源（welcome/finish 记为预留）')
else for (const o of orphans) warn(`未被引用：static${o}`)

// ---------- 3. 答案位置分布（已知限制，只告警） ----------

const aCount = questions.filter((q) => q.answerId === 'a').length
info(`答案分布：A ${aCount}/${questions.length}，B ${questions.length - aCount}`)
const identify = questions.filter((q) => q.kind === 'identify')
if (identify.length > 0 && identify.every((q) => q.answerId === 'a')) {
	warn('已知限制：所有看图题答案都是 A，只按左键（A 位）也能得分；数据层未改动')
}
for (const s of ['class', 'cross']) {
	for (const n of [2, 4, 8]) {
		const list = forScene(s).slice(0, n)
		const hit = list.filter((q) => q.answerId === 'a').length
		info(`${s} 前 ${n} 题只按左键：${hit}/${list.length} = ${Math.round((hit * 100) / list.length)}%`)
	}
}

// ---------- 4. 语音时长 vs session 兜底常量 ----------

const limits = {}
for (const mm of sess.matchAll(/const (T_[A-Z_]+) = (\d+)/g)) limits[mm[1]] = Number(mm[2])

const expectConst = [
	'T_TEACH_MAX',
	'T_PROMPT_MAX',
	'T_GREAT_MAX',
	'T_AGAIN_OK_MAX',
	'T_LOOK_AGAIN_MAX',
	'T_ANSWER_MAX'
]
const missConst = expectConst.filter((k) => limits[k] === undefined)
if (missConst.length === 0) ok('session.uvue 音频兜底常量齐全')
else bad(`session.uvue 缺少常量：${missConst.join(', ')}`)

function limitKeyFor(file) {
	const base = path.basename(file)
	if (base.endsWith('_teach.mp3')) return 'T_TEACH_MAX'
	if (base.endsWith('_prompt.mp3')) return 'T_PROMPT_MAX'
	if (base === 'great.mp3') return 'T_GREAT_MAX'
	if (base === 'again_ok.mp3') return 'T_AGAIN_OK_MAX'
	if (base === 'look_again.mp3') return 'T_LOOK_AGAIN_MAX'
	if (base === 'answer.mp3') return 'T_ANSWER_MAX'
	return ''
}

function durationMs(file) {
	const out = execFileSync(
		'ffprobe',
		['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
		{ encoding: 'utf8' }
	)
	return Math.round(Number(out.trim()) * 1000)
}

let ffprobeMissing = false
const audioRefs = uniqRefs.filter((r) => r.endsWith('.mp3'))
let checkedAudio = 0
for (const ref of audioRefs) {
	const key = limitKeyFor(ref)
	if (key === '') continue
	const file = at('static' + ref)
	try {
		// 0.8 倍速 → 实际播放时长 = 原始时长 / 0.8
		const playMs = Math.round(durationMs(file) / 0.8)
		const limit = limits[key]
		checkedAudio += 1
		if (playMs + 150 > limit) {
			bad(`static${ref} 播放约 ${playMs}ms，超过 ${key}=${limit}ms（会被 stop() 截断）`)
		}
	} catch (e) {
		if (e && e.code === 'ENOENT') {
			ffprobeMissing = true
			warn('未找到 ffprobe，跳过音频时长校验')
			break
		}
		bad(`ffprobe 解析失败：static${ref}`)
	}
}
if (!ffprobeMissing && checkedAudio > 0) ok(`${checkedAudio} 条语音时长都在兜底常量内`)

// ---------- 5. pages.json 与实际文件 ----------

const pagesJson = JSON.parse(read('pages.json'))
for (const page of pagesJson.pages) {
	if (!fs.existsSync(at(page.path + '.uvue'))) bad(`pages.json 指向不存在的页面：${page.path}.uvue`)
}
ok(`pages.json 的 ${pagesJson.pages.length} 个页面文件都存在`)

// ---------- 收尾 ----------

console.log('')
if (fails > 0) {
	console.log(`FAILED  ${fails} 项检查未通过`)
	process.exit(1)
}
console.log('PASS  全部检查通过')

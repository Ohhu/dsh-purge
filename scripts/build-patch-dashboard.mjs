#!/usr/bin/env node
/**
 * 生成 docs/patch-dashboard.html —— dsh-purge 补丁看板。
 *
 * 数据全部来自代码本身：
 *   - 补丁表：lib/core.js 的 PATCHES / CODE_PATCHES / ENGINE_PATCHES / NEW_TOOL_PATCHES
 *   - 档位：lib/patch-mode.js 的 CORE_PATCH_IDS（core 档只跑这些，其余归 full 档）
 *   - 判读：本文件里的 ANNOTATIONS（性质 / 风险 / 处置建议 / 主题）
 *
 * 这份看板只回答「这条补丁做什么」。它不读取、也不展示任何一台机器上的安装或应用状态，
 * 判读结论随代码版本走，不随机器走。
 *
 * 用法:
 *   node scripts/build-patch-dashboard.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const CORE = path.join(ROOT, 'lib', 'core.js')
const OUT = path.join(ROOT, 'docs', 'patch-dashboard.html')

const { CORE_PATCH_IDS } = await import('../lib/patch-mode.js')

/* ============================ 源码扫描 ============================ */

function makeScanner(text) {
  let i = 0, mode = 'code', esc = false, inClass = false, depth = 0
  return {
    get pos() { return i }, set pos(v) { i = v },
    get depth() { return depth }, get mode() { return mode },
    step() {
      const c = text[i]
      if (mode === 'code') {
        if (c === '"') { mode = 'dq'; i++; return c }
        if (c === "'") { mode = 'sq'; i++; return c }
        if (c === String.fromCharCode(96)) { mode = 'tpl'; i++; return c }
        if (c === '/' && text[i + 1] === '/') { mode = 'lineC'; i += 2; return '' }
        if (c === '/' && text[i + 1] === '*') { mode = 'blockC'; i += 2; return '' }
        if (c === '/') {
          let j = i - 1
          while (j >= 0 && /\s/.test(text[j])) j--
          const p = j >= 0 ? text[j] : ''
          if (j < 0 || /[=(,:[!&|?{}\n;+*%<>~^-]/.test(p)) { mode = 'regex'; inClass = false; i++; return c }
        }
        if ('([{'.includes(c)) depth++
        else if (')]}'.includes(c)) depth--
        i++; return c
      }
      if (mode === 'lineC') { if (c === '\n') mode = 'code'; i++; return '' }
      if (mode === 'blockC') { if (c === '*' && text[i + 1] === '/') { mode = 'code'; i += 2; return '' } i++; return '' }
      if (mode === 'regex') {
        if (esc) { esc = false; i++; return '' }
        if (c === '\\') { esc = true; i++; return '' }
        if (c === '[') inClass = true; else if (c === ']') inClass = false
        else if (c === '/' && !inClass) mode = 'code'
        i++; return ''
      }
      if (esc) { esc = false; i++; return '' }
      if (c === '\\') { esc = true; i++; return '' }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"') || (mode === 'tpl' && c === String.fromCharCode(96))) mode = 'code'
      i++; return ''
    },
  }
}

function findClose(text, open) {
  const s = makeScanner(text)
  s.pos = open
  s.step()
  while (s.pos < text.length) {
    s.step()
    if (s.mode === 'code' && s.depth === 0) return s.pos - 1
  }
  return -1
}

function untilSemicolon(text, from) {
  const s = makeScanner(text)
  s.pos = from
  while (s.pos < text.length) {
    s.step()
    if (s.mode === 'code' && s.depth === 0 && text[s.pos - 1] === ';') return s.pos - 1
  }
  return text.length - 1
}

/** 抓 const NAME = [...] 的数组字面量源码 */
function sliceArray(text, name) {
  const marker = 'const ' + name + ' = ['
  const at = text.indexOf(marker)
  if (at < 0) throw new Error('array not found: ' + name)
  const open = at + marker.length - 1
  const close = findClose(text, open)
  if (close < 0) throw new Error('unbalanced array: ' + name)
  return text.slice(open, close + 1)
}

/** 顶层元素切分（返回每个元素源码，含最外层花括号） */
function splitElements(arrSrc) {
  const out = []
  let i = 0
  while (i < arrSrc.length) {
    while (i < arrSrc.length && /[\s,]/.test(arrSrc[i])) i++
    if (i >= arrSrc.length || arrSrc[i] === ']') break
    const end = arrSrc[i] === '{' || arrSrc[i] === '[' ? findClose(arrSrc, i) : -1
    if (end < 0) break
    out.push(arrSrc.slice(i, end + 1))
    i = end + 1
  }
  return out
}

/** 取对象里某个 key 的表达式源码 */
function fieldExpr(objSrc, key) {
  const re = new RegExp('(?:^|[\\s,{])' + key + '\\s*:')
  const m = re.exec(objSrc)
  if (!m) return null
  let i = m.index + m[0].length
  while (i < objSrc.length && /\s/.test(objSrc[i])) i++
  if ('[{('.includes(objSrc[i])) {
    const end = findClose(objSrc, i)
    return end < 0 ? null : objSrc.slice(i, end + 1)
  }
  const s = makeScanner(objSrc)
  s.pos = i
  const startDepth = s.depth
  while (s.pos < objSrc.length) {
    const c = s.step()
    if (s.mode === 'code' && s.depth === startDepth && (c === ',' || c === '}')) return objSrc.slice(i, s.pos - 1)
  }
  return objSrc.slice(i)
}

/** 把 core.js 里被补丁引用的常量/函数抽出来，供显示时求值 */
function inlineConsts(src, names) {
  const pieces = []
  for (const name of names) {
    const fRe = new RegExp('(?:^|\\n)(?:export\\s+)?function\\s+' + name + '\\s*\\(')
    const fm = fRe.exec(src)
    const cRe = new RegExp('(?:^|\\n)(?:export\\s+)?const\\s+' + name + '\\s*=')
    const cm = cRe.exec(src)
    if (cm && (!fm || cm.index < fm.index)) {
      const eq = cm.index + cm[0].length
      const stop = untilSemicolon(src, eq)
      pieces.push('const ' + name + ' =' + src.slice(eq, stop + 1))
    } else if (fm) {
      const parenOpen = src.indexOf('(', fm.index)
      const parenClose = findClose(src, parenOpen)
      const braceOpen = src.indexOf('{', parenClose)
      const braceClose = findClose(src, braceOpen)
      pieces.push(src.slice(fm.index, braceClose + 1).replace(/^\n/, ''))
    }
  }
  if (!pieces.length) return {}
  try {
    return new Function(pieces.join('\n') + '\nreturn {' + names.join(',') + '};')()
  } catch {
    return {}
  }
}

const CONST_NAMES = [
  'STRONG_INTRO_CORE', 'STRONG_INTRO_AUTHORIZED_TAIL', 'STRONG_INTRO_ANTI_SOFT_TAIL',
  'STRONG_INTRO', 'STRONG_INTRO_V1', 'STRONG_INTRO_V2',
  'OFFICIAL_REPLACEMENT_BODY', 'REPLACEMENT_BASELINE_PREFIX', 'OFFICIAL_SCOPE',
  'SHELL_NETWORK_WEB', 'SHELL_NETWORK_SDK',
  'clearShellNetworkBan', 'quotedConst', 'replacementPrecedenceRewrites',
]

function makeEvalScope(consts) {
  const holder = new Map(Object.entries(consts))
  const mk = (k) => {
    const f = (...a) => '⟦' + k + '⟧(' + a.map(String).join(',') + ')'
    f.toString = () => '⟦' + k + '⟧'
    return f
  }
  return new Proxy({}, {
    has: () => true,
    get: (_t, k) => {
      if (k === Symbol.unscopables) return undefined
      const key = String(k)
      if (holder.has(key)) return holder.get(key)
      return mk(key)
    },
  })
}

function evalExpr(expr, scope) {
  if (!expr) return undefined
  try {
    return new Function('scope', 'with(scope){return (' + expr + ');}')(scope)
  } catch {
    return undefined
  }
}

/* ============================ 读补丁 ============================ */

const SRC = fs.readFileSync(CORE, 'utf8')
const scope = makeEvalScope(inlineConsts(SRC, CONST_NAMES))
const ARRAY_NAMES = ['PATCHES', 'CODE_PATCHES', 'ENGINE_PATCHES', 'NEW_TOOL_PATCHES']

const MAX_CODE = 1600      // 单侧原文截断
const MAX_PAIRS = 6        // 单条补丁最多展开几处

function clip(text, n) {
  const s = String(text == null ? '' : text)
  if (s.length <= n) return { text: s, truncated: false }
  return { text: s.slice(0, n) + '\n… 已截断，原文 ' + s.length + ' 字符', truncated: true }
}

const CORE_SET = new Set(CORE_PATCH_IDS)

function readPatches() {
  const records = []
  for (const arrayName of ARRAY_NAMES) {
    const arrSrc = sliceArray(SRC, arrayName)
    for (const obj of splitElements(arrSrc.slice(1, -1))) {
      const idMatch = /id:\s*(\d+)/.exec(obj)
      if (!idMatch) continue
      const id = Number(idMatch[1])
      const filesRaw = evalExpr(fieldExpr(obj, 'file'), scope)
      const replacements = evalExpr(fieldExpr(obj, 'replacements'), scope)
      const patterns = evalExpr(fieldExpr(obj, 'patterns'), scope)
      const singlePattern = evalExpr(fieldExpr(obj, 'pattern'), scope)
      const singleReplace = evalExpr(fieldExpr(obj, 'replace'), scope)

      let pairs = []
      if (Array.isArray(replacements)) {
        pairs = replacements.map((r) => ({ pattern: r && r.pattern, replace: r && r.replace }))
      } else if (Array.isArray(patterns)) {
        pairs = patterns.map((pt) => ({ pattern: pt, replace: singleReplace }))
      } else if (singlePattern !== undefined || singleReplace !== undefined) {
        pairs = [{ pattern: singlePattern, replace: singleReplace }]
      }

      const flat = pairs.map((pt) => {
        const a = clip(pt.pattern === undefined ? '' : String(pt.pattern), MAX_CODE)
        const b = clip(pt.replace === undefined ? '' : String(pt.replace), MAX_CODE)
        return {
          pattern: a.text,
          replace: b.text,
          truncated: a.truncated || b.truncated,
        }
      })

      records.push({
        id,
        name: String(evalExpr(fieldExpr(obj, 'name'), scope) || ''),
        layer: String(evalExpr(fieldExpr(obj, 'layer'), scope) || ''),
        desc: String(evalExpr(fieldExpr(obj, 'desc'), scope) || ''),
        files: Array.isArray(filesRaw) ? filesRaw.map(String) : filesRaw == null || filesRaw === '' ? [] : [String(filesRaw)],
        pairCount: flat.length,
        pairs: flat.slice(0, MAX_PAIRS),
        mode: CORE_SET.has(id) ? 'core' : 'full',
        optional: /optional:\s*true/.test(obj),
        strictFiles: /strictFiles:\s*true/.test(obj),
        skipIfMarked: /skipIfMarked:\s*true/.test(obj),
        softSettle: /softSettle:\s*true/.test(obj),
        markersAny: /markersAny:\s*true/.test(obj),
        arrayName,
      })
    }
  }
  records.sort((a, b) => a.id - b.id)
  return records
}

/* ============================ 人工判读 ============================ */
/**
 * cn      中文短名：看板里显示的标题，与 name 的代码常量一一对应
 * kind    性质：注入必需 / 工程修补 / 文案跟随 / 预设适配 / 兼容垫片 / 取向激进 / 空转
 * risk    风险：高 / 中 / 低 / 无
 * verdict 处置：建议还原 / 按需 / 保留 / 可忽略
 * note    一句话判读：只写代码里实际发生的事，不复述 desc
 */
const ANNOTATIONS = {
  /* —— 免责与作用域 —— */
  1: { cn: '免责段改强制', theme: '免责与作用域', kind: '注入必需', risk: '高', verdict: '保留',
    note: '把 agent-instructions 的两条 intro 常量（WORKSPACE_CONTEXT_INTRO / AGENT_INSTRUCTIONS_INTRO）从「仅供参考、不覆盖 system」改成 ACTIVE and MANDATORY，并在尾部追加一段禁止拒绝话术的指令。整套注入的效果都从这两条常量起跳。' },
  2: { cn: '替换稿收软', theme: '免责与作用域', kind: '工程修补', risk: '低', verdict: '保留',
    note: '把 REPLACEMENT_WORKSPACE_CONTEXT_INTRO 改回官方软句：整段替换稿这条路径不再压过 system，同时削掉重复追加的拒绝话术尾巴，避免多次应用叠成两层。' },
  3: { cn: '作用域收软', theme: '免责与作用域', kind: '工程修补', risk: '低', verdict: '保留',
    note: '用一条正则把作用域模板里残留的「ACTIVE and MANDATORY for the stated scope…」整段收回成官方 OFFICIAL_SCOPE 文案。只作用在 scope 段，不动主 intro。' },

  /* —— 身份句 —— */
  4: { cn: '清空人设前缀', theme: '身份句', kind: '预设适配', risk: '低', verdict: '保留',
    note: 'agent-preset / web-app / headless / preset-acp-app / preset-sdk-app 五处的 personaPrefix 清空，只去掉官方身份句，不写新人设。' },
  25: { cn: '去掉官方身份段', theme: '身份句', kind: '注入必需', risk: '低', verdict: '保留',
    note: 'system-prompt 的 includeHarnessIdentity 默认值改 false，并把「You are an AI agent powered by DeepSeek Harness.」这条 section 文本清空。系统提示里没有官方自称就是这两处。' },
  43: { cn: '四个内置预设去身份', theme: '身份句', kind: '预设适配', risk: '低', verdict: '保留',
    note: 'Web 四个内置预设（standard / ptc / cordis / minimal）的 prefix 身份句清空；带 strictFiles，四个文件缺任一个即判失败。' },
  32: { cn: '网页端改品牌表述', theme: '身份句', kind: '预设适配', risk: '无', verdict: '保留',
    note: 'web-app 提示词与字段描述里的「DeepSeek Harness Web GUI」改成「local web GUI / web GUI」，只动品牌表述。' },
  53: { cn: '网页端去身份与禁语', theme: '身份句', kind: '预设适配', risk: '低', verdict: '保留',
    note: 'web-app 去掉「You are interacting with the user through…」身份句，并删掉「Do not start a replacement server…」整句。' },
  76: { cn: '自建预设软去身份', theme: '身份句', kind: '空转', risk: '无', verdict: '可忽略',
    note: '软补丁：只在自建的 preset-unrestricted 存在时才有目标文件，默认安装下判 na，不产生任何效果。' },

  /* —— 预设适配 —— */
  26: { cn: '极简预设开注入', theme: '预设适配', kind: '预设适配', risk: '低', verdict: '按需',
    note: '极简预设两处：personaPrefix 清空；complete 从 true 改 false。complete 的语义是「本预设提示词自成一体、别拼外部注入」，不翻 false 的话注入段进不去。' },
  70: { cn: '极简终端去无网句', theme: '预设适配', kind: '预设适配', risk: '低', verdict: '按需',
    note: '极简预设的 pwsh 工具描述删掉「You do not have access to the internet via this tool.」一行；只改描述，不给任何额外网络能力。' },
  24: { cn: '预设打开网页抓取', theme: '预设适配', kind: '工程修补', risk: '无', verdict: '保留',
    note: '六个预设里 tool-web 的 fetch: false 改成 true，打开内置抓取。' },

  /* —— 文案跟随 —— */
  5: { cn: '审批提示改可加宽', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: 'user-approval 里「需要审批的操作会被自动拒绝、别设 sandbox_permissions」改成「以完全访问运行、可自由申请升级」。只改给模型看的话。' },
  11: { cn: '从不分支改放行', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: 'user-approval 代码内同一句的 never 分支改写，措辞换成 approval bypass / auto-granted。' },
  12: { cn: '询问分支改放行', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: 'ask 分支的 ASK_SENTENCE 与原文同时改：从「可能弹窗、无通道则 fail closed」改成「自动放行、可自由申请」。' },
  33: { cn: '终端拒绝话术改可继续', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: 'bash / pwsh 工具描述 11 处：把「这是策略拒绝、不许换路子重试」一类的硬话改成「这是沙箱提示，可以继续」。' },
  34: { cn: '升级提示改自动放行', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: 'escalation 的返回提示：denied 改 limited，升级提示改成 continue + approval is auto-granted。' },
  36: { cn: '文件升级字段去审批', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: 'fs 工具 sandbox_permissions 字段描述去掉「requires justification and user approval」，改成可选加宽。' },
  37: { cn: '子代理权限可加宽', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '保留',
    note: '子代理那句「权限启动时固定、加不宽」改成「本会话可加宽」。' },
  48: { cn: '删路径核对整句', theme: '文案跟随', kind: '文案跟随', risk: '低', verdict: '按需',
    note: 'bash / pwsh 删掉 delete / move 前的「先核对绝对路径」整句，换成「按操作者给定的路径执行」。' },

  /* —— 隔离层 —— */
  6: { cn: '沙箱策略放开写', theme: '隔离层', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: 'sandbox-local 的 profile 规则字符串「(deny file-write*)」改成「(allow file-write*)」。这是 syscall profile，不是文案。' },
  15: { cn: '沙箱封装直通', theme: '隔离层', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: 'sandbox-local 的 confine() 不再把 argv 包进 sandbox runner，三种模式（含 read-only）都按裸命令执行。' },
  16: { cn: '文件围栏短路', theme: '隔离层', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: 'fs-sandbox 的 checkedTarget() 直接返回 target：read-only / workspace-write 的文件围栏被短路，UI 里把权限调小也拦不住写。' },
  17: { cn: '观察策略放行', theme: '隔离层', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: 'fs-observation-policy 的 writeIntent / editIntent 一律返回 undefined：丢掉 replaceIfVersion 乐观锁，也去掉「编辑前必须先读」的门。' },

  /* —— 审批与升级 —— */
  7: { cn: '权限默认完全访问', theme: '审批与升级', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: '只改 base 的 YAML 默认值：mode 默认 workspace-write 改成 danger-full-access。仍尊重 DSH_PERMISSION_MODE，可被设置页切换。' },
  8: { cn: '审批默认从不', theme: '审批与升级', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: 'policy 表达式的默认分支同步改成 danger-full-access 对应 never，与 #7 配对；单独留 #8 只会让审批直接拒绝。' },
  9: { cn: '审批门自动放行', theme: '审批与升级', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: '审批决策函数首行 return allowed-once：不弹窗、不走 approval waterfall、没有通道也不 fail closed。这一条才是「命令不再问你」的实现。' },
  10: { cn: '审批配置默认从不', theme: '审批与升级', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: '审批 Config 的 policy 默认值 ask 改成 never。' },
  13: { cn: '升级阶梯拆报错', theme: '审批与升级', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: '删掉升级链的三道 throw：必须严格更宽、必须有 approver、必须有 agent。' },
  14: { cn: '升级无条件授信', theme: '审批与升级', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: '把 approver.request(...) 包进条件：approver 或 agent 缺一个就直接当 allowed-once；两者都在时仍会问一次。' },
  35: { cn: '升级失败仍授信', theme: '审批与升级', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: '升级结果 switch 的 rejected / cancelled / unavailable 都落到 default 返回 mode，升级请求永不失败。' },
  51: { cn: '新会话钉完全权限', theme: '审批与升级', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: 'permission-presets 两处：新会话改跟随部署的 danger-full-access 而不是 defaultPreset；workspace-write 的描述句改成「加宽自动放行」。注意插件运行时还有一条同名行为的钩子（lib/index.js 的 installFreshFullAccess），补丁档控制不到它。' },
  59: { cn: '自动审查不拦工具', theme: '审批与升级', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: '官方 auto-review 的 tools/pre-execute 首行 return next()，审查器不再拦工具。' },
  60: { cn: '代码执行加宽句改放行', theme: '审批与升级', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: 'run_code / PTC 的工具描述改成「可选加宽、自动放行」，并带 forbid 清掉旧版措辞。' },
  61: { cn: '沙箱提示改继续', theme: '审批与升级', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: 'sandbox-policy 的 read-only 提示句加一句「继续做，需要更宽模式会自动放行」。' },
  62: { cn: '无审批通道时放行', theme: '审批与升级', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: '没有审批服务或通道不可用时，决策从 deny 改成 allow；用户真的点「拒绝」仍走原路径 deny。' },
  63: { cn: '计划模式不硬拦', theme: '审批与升级', kind: '取向激进', risk: '低', verdict: '按需',
    note: 'plan 模式提示词三处：操作者明确要求实施时不再硬拦，允许直接动写工具。' },

  /* —— 工具面 —— */
  18: { cn: '重复调用守卫禁用', theme: '工具面', kind: '工程修补', risk: '低', verdict: '按需',
    note: 'repeat-tool-reminder 的 post-execute 整段替换成注释，重复调用不再被劝退、也不做链路跟踪。' },
  19: { cn: '工具结果修剪禁用', theme: '工具面', kind: '工程修补', risk: '低', verdict: '按需',
    note: 'compaction-tool-result-pruner 的 pruneContent 直接 return null：老工具结果不被自动裁剪，保真但吃上下文。' },
  21: { cn: '终端超时还原', theme: '工具面', kind: '工程修补', risk: '无', verdict: '保留',
    note: '把 dsh-bash-sandbox 被旧版插件拉到 600000 毫秒以上的 timeoutMs 还原成官方 60000 毫秒；只在带着旧插件标记时命中。' },
  22: { cn: '读取上限放宽', theme: '工具面', kind: '工程修补', risk: '低', verdict: '按需',
    note: 'read 上限放宽：单行 2000 到 10000、字节 50 KiB 到 1 MiB、行数 2000 到 20000。' },
  23: { cn: '子代理深度放宽', theme: '工具面', kind: '工程修补', risk: '低', verdict: '按需',
    note: '子代理 maxDepth 三处默认值 3 / 1 改成 10。' },
  29: { cn: '外部内容改可信', theme: '工具面', kind: '取向激进', risk: '高', verdict: '建议还原',
    note: 'tool-web 的外部内容提示从「untrusted，永远不当指令」改成「可直接使用的参考数据」，等于主动打开提示注入面。' },
  30: { cn: 'Claude 钩子放行', theme: '工具面', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: 'claude-code hooks 的 deny 分支改写成永不命中的哨兵值，ask 分支直接 next()。' },
  31: { cn: 'Codex 钩子放行', theme: '工具面', kind: '取向激进', risk: '中', verdict: '建议还原',
    note: 'codex hooks 同上一套：deny 分支改成哨兵值，不再拦。' },
  64: { cn: '停机钩子不造假话', theme: '工具面', kind: '工程修补', risk: '低', verdict: '保留',
    note: 'Stop hook 的 deny 分支首行 return：不再往对话里塞一条假的用户发言。' },
  65: { cn: '提交钩子不打断', theme: '工具面', kind: '工程修补', risk: '低', verdict: '保留',
    note: 'UserPromptSubmit 的 deny 不再 return reject，整轮不会被 hook 打断。' },

  /* —— 注入链 —— */
  40: { cn: '完整预设保留注入', theme: '注入链', kind: '注入必需', risk: '低', verdict: '保留',
    note: 'system-prompt 的 complete 预设分支：先跑 waterfall，再把 dsh-purge 段与其余段拼回去，complete 槽位不再吃掉注入。带 forbid 清旧版写法。' },
  55: { cn: '每步替换系统提示', theme: '注入链', kind: '注入必需', risk: '低', verdict: '保留',
    note: 'agent-loop 的 inHistory 恒为 false：每一步都用当前整段系统提示替换第一条 system，旧提示不会被钉在历史里。' },
  72: { cn: '系统提示取当前值', theme: '注入链', kind: '注入必需', risk: '低', verdict: '保留',
    note: 'Messages 协议的 system 字段取当前系统提示（historySystem），不把后出现的系统提示降级成中途消息。' },
  74: { cn: '首轮前先挂提示词', theme: '注入链', kind: '注入必需', risk: '低', verdict: '保留',
    note: 'agent-loop 在 claim 之后、assemble 之前先调一次 __dshPurgePrepareAssemble，保证每个模式的首次 assemble 之前已经挂上默认提示词。' },
  87: { cn: '空白宿主挂全文', theme: '注入链', kind: '注入必需', risk: '低', verdict: '保留',
    note: '空白宿主先挂全文，再用 LF 归一化后比对头尾，避免 CRLF 误判后又糊一份。三处组装点各一份。' },
  88: { cn: '头尾双检才算挂住', theme: '注入链', kind: '注入必需', risk: '低', verdict: '保留',
    note: '头（ChatML）与尾都在才算挂住；只剩头或只剩尾都重新置顶，修掉半挂状态。' },
  66: { cn: '提示渲染兜底', theme: '注入链', kind: '工程修补', risk: '低', verdict: '保留',
    note: 'renderPrompt / interpolate 对 undefined 的 section.text 兜底成空串，避免第二轮 gateway / internal 抛错。' },
  67: { cn: '消息缺省兜底', theme: '注入链', kind: '工程修补', risk: '低', verdict: '保留',
    note: 'decision.messages 缺省时按空数组处理，agent-loop 的 break 判定不再炸。' },
  68: { cn: '缺正文兜底', theme: '注入链', kind: '工程修补', risk: '低', verdict: '保留',
    note: 'textOf / derive 对缺 content 的 message 兜底，回退后第二轮不再因为 content 为 undefined 抛错。' },

  /* —— 会话与传输 —— */
  56: { cn: '回退只藏该轮', theme: '会话与传输', kind: '工程修补', risk: '无', verdict: '按需',
    note: '回退只隐藏被撤掉的那一轮：按 surfaceOp 的 startSeq / endSeq 算范围，不再按 sourceEventSeqs 连带隐藏别的轮次。' },
  57: { cn: '开发角色限原生端点', theme: '会话与传输', kind: '工程修补', risk: '中', verdict: '保留',
    note: 'developer role 只给 openai.com / azure 原生端点，第三方中转一律回落 system，防 400。换代理后值得复核。' },
  58: { cn: '回退空标记跳过', theme: '会话与传输', kind: '工程修补', risk: '无', verdict: '按需',
    note: 'id 以 rewind- 开头的 user/message 在 derive 里返回 null：回退的空标记不进模型请求。' },
  69: { cn: '快速模型恢复历史内', theme: '会话与传输', kind: '工程修补', risk: '中', verdict: '保留',
    note: 'deepseek-flash 恢复官方 in-history；同时 forbid 掉旧版那个会打成 TRANSPORT 的独立连接补丁。' },
  75: { cn: '回退收回任务清单', theme: '会话与传输', kind: '工程修补', risk: '无', verdict: '按需',
    note: '回退标记到达时把 todos 收回成未开始，已完成任务不再残留。' },
  77: { cn: '回退即刻撤消息', theme: '会话与传输', kind: '工程修补', risk: '无', verdict: '按需',
    note: '回退标记 append 的那一刻就重算窗口，把已发送的消息立刻从当前对话里拿掉。' },
  85: { cn: '提示一律新轮', theme: '会话与传输', kind: '工程修补', risk: '低', verdict: '保留',
    note: 'api-session-controller 的 prompt 一律 followup：UI 发消息永远开新 turn，消掉 steer 到 next-step 的竞态。' },
  86: { cn: '队列插话走新轮', theme: '会话与传输', kind: '工程修补', risk: '低', verdict: '保留',
    note: '队列里的 steer 走 followup，公共 steer() 保持 next-step 给 send_message 用。' },

  /* —— 兼容垫片 —— */
  38: { cn: '人设文本字段兼容', theme: '兼容垫片', kind: '兼容垫片', risk: '无', verdict: '保留',
    note: 'dsh-persona 的 Config：prefix 改为有默认值并新增 text 字段，取值 config.prefix || config.text，旧写法仍能配。' },
  39: { cn: '旧版摘要别名兼容', theme: '兼容垫片', kind: '兼容垫片', risk: '无', verdict: '保留',
    note: 'v0 会话格式：mnemon 摘要不再要求 form 必须是 notice，挂在 instructions / recall 上也接受。' },
  42: { cn: '设置旧接口补回', theme: '兼容垫片', kind: '兼容垫片', risk: '无', verdict: '保留',
    note: 'settings 服务补回 register / get / watch / update / replace 与 commitLegacy，落在 settings-legacy.yaml，并补发 settings/updated 事件、给 mergeLayers 兜空对象。旧插件靠这套 API 才能起来。' },
  47: { cn: '登录不插 Claude 身份', theme: '兼容垫片', kind: '兼容垫片', risk: '无', verdict: '保留',
    note: 'Anthropic OAuth 请求不再强制把 Claude Code 身份插到 system 首段，改用会话自己的 systemPrompt。' },
  49: { cn: '登录不伪装客户端', theme: '兼容垫片', kind: '兼容垫片', risk: '无', verdict: '保留',
    note: 'OAuth 请求头与工具名不再伪装 claude-cli：UA 换成 deepseek-harness/dsh-purge，x-app 改 dsh，toClaudeCodeName 直接返回原名。' },
  50: { cn: '跨会话引用标不可信', theme: '兼容垫片', kind: '工程修补', risk: '低', verdict: '保留',
    note: '跨会话引用回到 0.1.7 的措辞：transcript 与 JSON 快照都标 untrusted、read-only。' },
  54: { cn: '删交付物禁句', theme: '兼容垫片', kind: '工程修补', risk: '无', verdict: '保留',
    note: '交付物提示词去掉「Do not call present just to list edited source files…」整句。' },

  /* —— 桌面宿主 —— */
  45: { cn: '桌面升级改自装', theme: '桌面宿主', kind: '工程修补', risk: '低', verdict: '保留',
    note: '官方桌面升级不再 quitAndInstall 打开旧的解包目录，改走 dshPurgeHandoffDesktopUpdate 交给自己安装已下载的新版本。仅 desktop 面。' },
  46: { cn: '更新脚本转义', theme: '桌面宿主', kind: '工程修补', risk: '低', verdict: '保留',
    note: '交给 WSH 的脚本参数用 dshPurgeWshLiteral 做 ASCII 转义，中文 Windows 不再吞换行。仅 desktop 面。' },
  78: { cn: '缺文件从备份拷回', theme: '桌面宿主', kind: '工程修补', risk: '无', verdict: '保留',
    note: 'app-boot 的 loadOverlayPatches：声明过的补丁文件不见了，先从 .dshpurge.bak 拷回再读。' },
  82: { cn: '兜底桌面档位', theme: '桌面宿主', kind: '工程修补', risk: '无', verdict: '保留',
    note: '桌面壳兜底 DSH_PROFILE=desktop：双击 exe 从 explorer 继承的环境常缺这个变量，缺了 host 直接起不来、插件也就不 activate。仅 desktop 面。' },
  83: { cn: '宿主被杀不报错', theme: '桌面宿主', kind: '工程修补', risk: '无', verdict: '保留',
    note: 'host 被信号杀死（重启换包）时不报错、不弹 crash 对话框。仅 desktop 面。' },
  84: { cn: '正常退出不判失败', theme: '桌面宿主', kind: '工程修补', risk: '无', verdict: '保留',
    note: 'host 以 code=0 正常退出时不判失败，消除 stopped 对话框。仅 desktop 面。' },
}

const VERDICT_ORDER = ['建议还原', '按需', '保留', '可忽略']
const KIND_ORDER = ['注入必需', '工程修补', '文案跟随', '预设适配', '兼容垫片', '取向激进', '空转']
const RISK_ORDER = ['高', '中', '低', '无']

/* ============================ 组装 ============================ */

/** desc 形如「中文 / english」；只在最后一个 " / " 处切，且右侧必须全 ASCII，否则整段当中文。 */
function splitDesc(desc) {
  const at = desc.lastIndexOf(' / ')
  if (at < 0) return desc
  const right = desc.slice(at + 3).trim()
  if (!right || /[^\x00-\x7F]/.test(right)) return desc
  return desc.slice(0, at).trim()
}

/** 中文副标题：与标题重复的部分削掉，剩下的才值得单独一行。 */
function subtitle(cn, zh) {
  const strip = (s) => String(s || '').replace(/[\s·，。；、：,.;:()（）【】\[\]「」"']/g, '')
  const a = strip(cn), b = strip(zh)
  if (!b) return ''
  if (b === a) return ''
  if (cn && String(zh).trim().startsWith(cn)) {
    const rest = String(zh).trim().slice(cn.length).replace(/^[\s·，。；、：,.;:()（）—–-]+/, '')
    return rest.length >= 4 ? rest : ''
  }
  // 副标题只是把标题摊开写（标题每个字按序出现在副标题里、且没多出几个字）→ 不算补充
  if (a) {
    let at = -1, ok = true
    for (const ch of a) {
      const next = b.indexOf(ch, at + 1)
      if (next < 0) { ok = false; break }
      at = next
    }
    if (ok && b.length - a.length <= 8) return ''
  }
  return String(zh).trim()
}

function build() {
  const patches = readPatches()
  const merged = patches.map((p) => {
    const a = ANNOTATIONS[p.id] || {}
    return Object.assign({}, p, {
      theme: a.theme || '未分类',
      kind: a.kind || '未分类',
      risk: a.risk || '无',
      verdict: a.verdict || '按需',
      note: a.note || '',
      zh: subtitle(a.cn || p.name, splitDesc(p.desc)),
      cn: a.cn || p.name,
    })
  })

  const counts = { mode: { core: 0, full: 0 } }
  for (const p of merged) counts.mode[p.mode] += 1

  const annotated = new Set(Object.keys(ANNOTATIONS).map(Number))
  const missing = merged.filter((p) => !annotated.has(p.id)).map((p) => p.id)

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return {
    meta: {
      title: 'dsh-purge 补丁看板',
      pluginVersion: pkg.version,
      dshTarget: pkg.dshTarget || '',
      builtAt: new Date().toISOString(),
      source: 'lib/core.js + lib/patch-mode.js',
      patchCount: merged.length,
      unannotated: missing,
    },
    summary: {
      total: merged.length,
      verdicts: VERDICT_ORDER,
      kinds: KIND_ORDER,
      risks: RISK_ORDER,
      counts,
    },
    patches: merged,
  }
}

/* ============================ 页面样式 ============================ */

const CSS = `
:root{
  /* 面色 */
  --bg:#F5F5F1;
  --surface:#FFFFFF;
  --sunken:#F1F1EC;
  --line:#E5E5DF;
  --line-soft:#EFEFE9;
  --line-strong:#D4D7DC;
  /* 文字：三级足够，第四级只做装饰 */
  --ink:#15181B;
  --ink-2:#3B424A;
  --ink-3:#4E5561;
  --ink-4:#6E7681;
  /* 语义三联：处置色 */
  --clay:#9E4B3E;   --clay-bg:#FBF4F2;  --clay-line:#EEDBD6;
  --ochre:#87631A;  --ochre-bg:#FAF5E8; --ochre-line:#EADFC4;
  --teal:#266055;   --teal-bg:#F0F6F3;  --teal-line:#D6E7E1;
  --slate:#5A616B;  --slate-bg:#F3F4F5; --slate-line:#E2E4E7;
  --mono:"SFMono-Regular",ui-monospace,"JetBrains Mono",Consolas,"Liberation Mono",Menlo,monospace;
  --shadow:0 1px 2px rgba(21,24,27,.05);
}
/* 一处定义，四处消费 */
.v-rv{--v:#9E4B3E;--v-bg:#FBF4F2;--v-line:#EEDBD6}
.v-op{--v:#87631A;--v-bg:#FAF5E8;--v-line:#EADFC4}
.v-kp{--v:#266055;--v-bg:#F0F6F3;--v-line:#D6E7E1}
.v-ig{--v:#5A616B;--v-bg:#F3F4F5;--v-line:#E2E4E7}

*,*::before,*::after{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;overflow:hidden;background:var(--bg);color:var(--ink);
  font:13.5px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
button,input,select{font-family:inherit;font-size:inherit;color:inherit}
::selection{background:#E3E6EA}
:focus-visible{outline:2px solid var(--ink-3);outline-offset:2px;border-radius:6px}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#D9D9D0;border:3px solid transparent;background-clip:content-box;border-radius:6px}
::-webkit-scrollbar-thumb:hover{background:#C4C4BA;border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}

.app{height:100vh;height:100dvh;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--surface)}

/* —— 顶栏 —— */
.topbar{display:flex;align-items:center;gap:14px;height:54px;padding:0 22px;
  border-bottom:1px solid var(--line);background:var(--surface)}
.brand{display:flex;align-items:baseline;gap:8px;min-width:0}
.brand b{font-size:14px;font-weight:650;letter-spacing:-.005em;white-space:nowrap}
.brand span{font-size:12px;color:var(--ink-4);white-space:nowrap;font-variant-numeric:tabular-nums}
.topbar .spacer{flex:1 1 auto}
.railtoggle{display:none;align-items:center;gap:6px;height:30px;padding:0 10px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);
  font-size:12px;color:var(--ink-2);cursor:pointer}
.tbtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink-2);
  font-size:12px;cursor:pointer;transition:border-color .15s,color .15s,background .15s}
.tbtn svg{width:13px;height:13px;opacity:.6}
.tbtn:hover{border-color:var(--line-strong);background:var(--surface-soft);color:var(--ink)}
.tbtn.solid{background:var(--ink);border-color:var(--ink);color:#fff}
.tbtn.solid:hover{background:#262B31;border-color:#262B31}
.tbtn.solid svg{opacity:.85}

/* —— 主体 —— */
.main{display:grid;grid-template-columns:308px minmax(0,1fr);min-height:0}

/* —— 左栏 —— */
.rail{display:flex;flex-direction:column;min-height:0;
  border-right:1px solid var(--line);background:var(--surface-soft)}
.rail-head{padding:16px 14px 12px;border-bottom:1px solid var(--line-soft)}
.search{position:relative;display:block}
.search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);
  width:14px;height:14px;color:var(--ink-4);pointer-events:none}
.search input{width:100%;height:32px;padding:0 10px 0 30px;border:1px solid transparent;
  border-radius:8px;background:var(--sunken);font-size:12.5px;outline:none;
  transition:background .15s,border-color .15s,box-shadow .15s}
.search input::placeholder{color:var(--ink-4)}
.search input:focus{background:var(--surface);border-color:var(--line-strong);box-shadow:var(--shadow)}

.seg{display:flex;gap:2px;margin-top:10px;padding:2px;border-radius:8px;background:var(--sunken)}
.seg button{flex:1;height:26px;border:0;border-radius:6px;background:transparent;color:var(--ink-3);
  font-size:11.5px;cursor:pointer;transition:background .15s,color .15s}
.seg button:hover{color:var(--ink)}
.seg button.on{background:var(--surface);color:var(--ink);box-shadow:var(--shadow)}
.seg button .n{margin-left:4px;font-variant-numeric:tabular-nums;opacity:.65}

.filters{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.fchip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);
  font-size:11.5px;color:var(--ink-3);cursor:pointer;transition:.15s}
.fchip .d{width:5px;height:5px;border-radius:50%;background:var(--v,var(--ink-4))}
.fchip .n{font-variant-numeric:tabular-nums;opacity:.7}
.fchip:hover{border-color:var(--line-strong)}
.fchip:not(.on){color:var(--ink-4);background:transparent;border-color:var(--line-soft)}
.fchip.on{color:var(--v);border-color:var(--v-line);background:var(--v-bg)}

.selrow{margin-top:8px}
.selrow select{-webkit-appearance:none;appearance:none;width:100%;height:28px;padding:0 9px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);
  font-size:11.5px;color:var(--ink-3);cursor:pointer;outline:none}
.selrow select:hover{border-color:var(--line-strong);color:var(--ink-2)}

.list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 10px 10px 8px;scrollbar-gutter:stable}
.li{width:100%;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;
  gap:9px;padding:7px 9px;border:0;border-radius:8px;background:transparent;text-align:left;
  cursor:pointer;transition:background .12s}
.li:hover{background:var(--sunken)}
.li.sel{background:var(--surface);box-shadow:inset 2px 0 0 var(--ink),var(--shadow)}
.li .id{font-family:var(--mono);font-size:11.5px;color:var(--ink-4);font-variant-numeric:tabular-nums}
.li.sel .id{color:var(--ink-2)}
.li .nm{font-size:12.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.li.sel .nm{color:var(--ink)}
.li .pt{width:6px;height:6px;border-radius:50%;background:var(--v,var(--line-strong))}
.rail-foot{display:flex;align-items:center;gap:8px;padding:9px 16px;
  border-top:1px solid var(--line-soft);font-size:11.5px;color:var(--ink-4)}
.rail-foot .link{margin-left:auto;border:0;background:none;padding:0;color:var(--ink-3);
  font-size:11.5px;cursor:pointer}
.rail-foot .link:hover{color:var(--ink);text-decoration:underline}
.empty{padding:24px 14px;font-size:12.5px;color:var(--ink-4);text-align:center}

/* —— 右栏 —— */
.pane{min-height:0;overflow:auto;background:var(--surface)}
.doc{max-width:820px;margin:0 auto;padding:40px 48px 72px}

.eyebrow{display:flex;align-items:center;gap:9px;font-size:11.5px;letter-spacing:.06em;
  color:var(--ink-4);margin-bottom:13px}
.eyebrow .id{font-family:var(--mono);letter-spacing:.03em;color:var(--ink-3)}
.eyebrow .rule{flex:1;height:1px;background:var(--line-soft);min-width:20px}
.eyebrow .code{font-family:var(--mono);font-size:10.5px;letter-spacing:0;text-transform:none;
  color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44%}

h1{font-size:25px;line-height:1.3;letter-spacing:-.018em;font-weight:650;margin:0 0 10px;
  overflow-wrap:anywhere;word-break:break-word}
.lede{font-size:13.5px;line-height:1.75;color:var(--ink-2);margin:0;max-width:68ch}

.meta{display:flex;flex-wrap:wrap;gap:7px;margin:18px 0 0}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface-soft);
  font-size:12px;color:var(--ink-3)}
.badge b{font-weight:600;color:inherit}
.badge.tone{color:var(--v);border-color:var(--v-line);background:var(--v-bg)}
.badge.risk-hi{color:var(--clay);border-color:var(--clay-line);background:var(--clay-bg)}

hr.sep{height:1px;border:0;background:var(--line-soft);margin:26px 0}

h2{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  font-size:11.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-4);margin:0 0 12px}
h2 .cap{letter-spacing:0;text-transform:none;font-size:11.5px;color:var(--ink-4);
  font-weight:400;flex:0 0 auto;font-variant-numeric:tabular-nums}

.note{font-size:13.5px;line-height:1.75;color:var(--ink-2);margin:0;max-width:70ch}
.note b{color:var(--ink);font-weight:600}

.keys{display:flex;flex-wrap:wrap;gap:6px}
.key{display:inline-flex;align-items:center;height:23px;padding:0 8px;border-radius:6px;
  background:var(--surface-soft);border:1px solid var(--line-soft);
  font-family:var(--mono);font-size:11.5px;color:var(--ink-3)}
.flags{margin-top:10px;font-size:12px;color:var(--ink-4);line-height:1.85}
.flags code{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);
  background:var(--surface-soft);border:1px solid var(--line-soft);border-radius:5px;padding:0 4px}

.diff{margin-bottom:14px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}
.diff-top{display:flex;align-items:center;gap:8px;padding:7px 12px;
  border-bottom:1px solid var(--line-soft);background:var(--surface-soft);
  font-size:11.5px;color:var(--ink-4)}
.diff-top .idx{font-family:var(--mono);color:var(--ink-3)}
.diff-top .kind{font-size:10.5px;letter-spacing:.06em;color:var(--ink-4);
  border:1px solid var(--line);border-radius:5px;padding:0 5px;line-height:16px}
.diff-top .sz{margin-left:auto;font-variant-numeric:tabular-nums}
.diff pre{margin:0;padding:11px 13px;font-family:var(--mono);font-size:11.5px;line-height:1.66;
  white-space:pre-wrap;overflow-wrap:anywhere}
.diff pre + pre{border-top:1px solid var(--line-soft)}
.diff .old{color:#7A4238;background:linear-gradient(180deg,rgba(158,75,62,.055),rgba(158,75,62,.016))}
.diff .new{color:#1F564C;background:linear-gradient(180deg,rgba(38,96,85,.055),rgba(38,96,85,.016))}
.diff .tag{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;
  color:var(--ink-4);margin-bottom:7px;user-select:none}
.diff.more{font-size:12px;color:var(--ink-4);border-style:dashed;background:transparent;
  padding:7px 12px;margin-bottom:14px}

.related{display:flex;flex-wrap:wrap;gap:6px}
.relbtn{display:inline-flex;align-items:center;gap:6px;height:25px;padding:0 9px;
  border:1px solid var(--line);border-radius:8px;background:var(--surface);
  font-size:12px;color:var(--ink-3);cursor:pointer;transition:.15s;max-width:100%}
.relbtn:hover{border-color:var(--line-strong);color:var(--ink);background:var(--surface-soft)}
.relbtn .id{font-family:var(--mono);font-size:11.5px;color:var(--ink-4)}
.relbtn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* —— 总览 —— */
.dist{margin:22px 0 0}
.dist-bar{display:flex;height:7px;border-radius:4px;overflow:hidden;background:var(--line-soft)}
.dist-bar i{display:block;height:100%;background:var(--v)}
.dist-legend{display:flex;flex-wrap:wrap;gap:18px;margin-top:11px}
.dist-legend span{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-3)}
.dist-legend .d{width:6px;height:6px;border-radius:50%;background:var(--v)}

.gloss{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px 26px;margin-top:2px}
.gloss div{font-size:12.5px;line-height:1.72;color:var(--ink-3)}
.gloss b{display:block;font-size:12.5px;font-weight:600;color:var(--ink-2);margin-bottom:2px}

.callout{border-left:2px solid var(--line);padding:2px 0 2px 14px;font-size:12.5px;
  line-height:1.75;color:var(--ink-3);margin:0 0 16px;max-width:70ch}
.callout:last-child{margin-bottom:0}
.callout code{font-family:var(--mono);font-size:11.5px;color:var(--ink-2)}

/* —— 打印 —— */
#printRoot{display:none}
@media print{
  body{overflow:visible;background:#fff}
  .app{display:none}
  #printRoot{display:block;padding:0}
  .p-head h1{font-size:17px;margin:0 0 4px}
  .p-head .m{font-size:10.5px;color:#666;margin-bottom:12px}
  .p-tbl{width:100%;border-collapse:collapse;font-size:10.2px}
  .p-tbl th,.p-tbl td{border:1px solid #ddd;padding:4px 5px;text-align:left;vertical-align:top}
  .p-tbl th{background:#F4F5F6;font-weight:600}
  .p-tbl td.n{font-family:var(--mono)}
  .p-note{margin-top:14px;font-size:10.2px;color:#333;line-height:1.6}
  .p-note h2{display:block;font-size:11px;margin:10px 0 4px;letter-spacing:.08em}
  .p-note div{margin-bottom:2px}
}

@media (max-width:900px){
  .main{grid-template-columns:minmax(0,1fr)}
  .rail{position:fixed;inset:54px auto 0 0;width:288px;z-index:20;
    box-shadow:0 0 0 1px var(--line),0 18px 40px -28px rgba(21,24,27,.5);
    transform:translateX(-100%);transition:transform .18s}
  .rail.open{transform:none}
  .doc{padding:28px 22px 60px}
  .railtoggle{display:inline-flex}
}

`;

/* ============================ 页面脚本 ============================ */

const CLIENT_JS = `
(function () {
  var D = JSON.parse(document.getElementById('payload').textContent);
  var P = D.patches, M = D.meta, S = D.summary, CNT = S.counts;
  var byId = {};
  P.forEach(function (p) { byId[p.id] = p; });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function vClass(v) {
    return v === '建议还原' ? 'v-rv' : v === '按需' ? 'v-op' : v === '保留' ? 'v-kp' : 'v-ig';
  }

  var st = { q: '', theme: '', mode: '', v: {} };
  S.verdicts.forEach(function (v) { st.v[v] = true; });
  var sel = '';

  function matches(p, skip) {
    if (skip !== 'mode' && st.mode && p.mode !== st.mode) return false;
    if (st.theme && p.theme !== st.theme) return false;
    if (skip !== 'verdict' && !st.v[p.verdict]) return false;
    if (st.q) {
      var q = st.q.toLowerCase();
      var hay = (p.id + ' ' + p.cn + ' ' + p.name + ' ' + p.desc + ' ' + p.note + ' ' + p.files.join(' ') + ' ' + p.theme + ' ' + p.kind).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }
  function visible() { return P.filter(function (p) { return matches(p, null); }); }

  /* —— 左栏 —— */
  function renderList() {
    var rows = visible();
    document.getElementById('list').innerHTML = rows.length
      ? rows.map(function (p) {
        return '<button type="button" class="li' + (String(p.id) === sel ? ' sel' : '') + '" data-id="' + p.id + '"'
          + ' title="' + esc(p.name) + '">'
          + '<span class="id">' + p.id + '</span>'
          + '<span class="nm">' + esc(p.cn) + '</span>'
          + '<span class="pt ' + vClass(p.verdict) + '" title="' + esc(p.verdict) + '"></span>'
          + '</button>';
      }).join('')
      : '<div class="empty">没有匹配的补丁</div>';
    document.getElementById('fstat').textContent =
      rows.length === P.length ? '' : '筛出 ' + rows.length + ' / ' + P.length;

    var tally = {};
    S.verdicts.forEach(function (v) { tally[v] = 0; });
    P.forEach(function (p) { if (matches(p, 'verdict')) tally[p.verdict] += 1; });
    Array.prototype.forEach.call(document.querySelectorAll('.fchip'), function (b) {
      b.querySelector('.n').textContent = tally[b.dataset.v] || 0;
    });
    var modeTally = { core: 0, full: 0 };
    P.forEach(function (p) { if (matches(p, 'mode')) modeTally[p.mode] += 1; });
    modeTally[''] = modeTally.core + modeTally.full;
    Array.prototype.forEach.call(document.querySelectorAll('#modeseg button'), function (b) {
      b.querySelector('.n').textContent = modeTally[b.dataset.mode];
    });
  }

  /* —— 通用片段 —— */
  function fileKeys(p) {
    if (!p.files.length) return '<span class="key">无 file 字段</span>';
    return p.files.map(function (f) { return '<span class="key">' + esc(f) + '</span>'; }).join('');
  }
  function flagLine(p) {
    var out = [];
    if (p.strictFiles) out.push('<code>strictFiles</code> 少一个文件就算失败');
    if (p.optional) out.push('<code>optional</code> 文件缺失不算失败');
    if (p.skipIfMarked) out.push('<code>skipIfMarked</code> 已有标记就直接算已打');
    if (p.softSettle) out.push('<code>softSettle</code> 按文件布局判定，不靠标记');
    if (p.markersAny) out.push('<code>markersAny</code> 任一标记命中就算已打');
    if (!out.length) return '';
    return '<div class="flags">判定方式：' + out.join('，') + '</div>';
  }
  function relBtn(o) {
    return '<button type="button" class="relbtn" data-goto="' + o.id + '">'
      + '<span class="id">' + o.id + '</span><span class="nm">' + esc(o.cn) + '</span></button>';
  }
  function isRegex(s) {
    return /^\\/[\\s\\S]*\\/[gimsuy]*$/.test(String(s || ''));
  }
  function diffBlock(pair, i, only) {
    var kind = isRegex(pair.pattern) ? '正则匹配' : '字面串';
    return '<div class="diff"><div class="diff-top">'
      + (only ? '' : '<span class="idx">改动 ' + i + '</span>')
      + '<span class="kind">' + kind + '</span>'
      + '<span class="sz">' + (pair.truncated ? '已截断' : '') + '</span></div>'
      + '<pre class="old"><span class="tag">原文</span>' + esc(pair.pattern) + '</pre>'
      + '<pre class="new"><span class="tag">替换为</span>' + esc(pair.replace) + '</pre></div>';
  }

  /* —— 详情 —— */
  function detail(p) {
    var same = P.filter(function (o) { return o.id !== p.id && o.theme === p.theme; });
    var sameIds = {};
    same.forEach(function (o) { sameIds[o.id] = 1; });
    var shared = P.filter(function (o) {
      return o.id !== p.id && !sameIds[o.id]
        && o.files.some(function (f) { return p.files.indexOf(f) >= 0; });
    });

    var h = '<article class="doc">';
    h += '<div class="eyebrow"><span class="id">PATCH ' + p.id + '</span>'
      + '<span>' + esc(p.layer) + '</span>'
      + '<span>' + (p.mode === 'core' ? '核心档' : '完整档') + '</span>'
      + '<span class="code" title="' + esc(p.name) + '">' + esc(p.name) + '</span>'
      + '<span class="rule"></span></div>';
    h += '<h1>' + esc(p.cn) + '</h1>';
    if (p.zh && p.zh !== p.cn) h += '<p class="lede">' + esc(p.zh) + '</p>';
    h += '<div class="meta">'
      + '<span class="badge tone ' + vClass(p.verdict) + '">' + esc(p.verdict) + '</span>'
      + '<span class="badge">' + esc(p.kind) + '</span>'
      + '<span class="badge' + (p.risk === '高' ? ' risk-hi' : '') + '">风险 ' + esc(p.risk) + '</span>'
      + (p.theme === p.kind ? '' : '<span class="badge">' + esc(p.theme) + '</span>')
      + '</div>';
    h += '<hr class="sep">';

    h += '<h2>这条补丁做什么</h2><p class="note">' + esc(p.note || p.desc) + '</p>';
    h += '<hr class="sep">';

    h += '<h2>目标文件</h2><div class="keys">' + fileKeys(p) + '</div>' + flagLine(p);
    h += '<hr class="sep">';

    var cap = p.pairCount > p.pairs.length
      ? '共 ' + p.pairCount + ' 处，显示前 ' + p.pairs.length + ' 处'
      : (p.pairCount ? '共 ' + p.pairCount + ' 处' : '');
    h += '<h2>替换内容<span class="cap">' + esc(cap) + '</span></h2>'
      + (p.pairs.length
        ? p.pairs.map(function (pr, i) { return diffBlock(pr, i + 1, p.pairs.length === 1); }).join('')
        : '<p class="callout">这条补丁没有 pattern / replace 对，改动写在运行时钩子里。</p>');

    if (same.length || shared.length) {
      h += '<hr class="sep">';
      if (same.length) {
        h += '<h2>同主题<span class="cap">' + same.length + ' 条</span></h2><div class="related">'
          + same.map(relBtn).join('') + '</div>';
      }
      if (shared.length) {
        h += '<h2>改同一批文件<span class="cap">' + shared.length + ' 条</span></h2><div class="related">'
          + shared.map(relBtn).join('') + '</div>';
      }
    }
    h += '</article>';
    return h;
  }

  /* —— 总览 —— */
  var VERDICT_GLOSS = [
    ['建议还原', '拆掉了官方的边界（审批、沙箱围栏、外部内容可信度）。还原后功能不受影响。'],
    ['按需', '看你的用法：只在用到对应宿主面或预设时才有意义。'],
    ['保留', '注入链或工程修补依赖它，撤了功能会断。'],
    ['可忽略', '目标文件或预设不存在，改了等于没改。'],
  ];
  var KIND_GLOSS = [
    ['注入必需', '让提示词能在 dsh 0.2 里挂住、不被预设或旧 system message 顶掉。'],
    ['工程修补', '修 agent-loop / rewind / 桌面宿主 / 兼容层的实际缺陷。'],
    ['文案跟随', '只改模型读到的句子，让措辞别和行为互相矛盾。'],
    ['预设适配', '只在特定 preset（minimal / standard / ptc / 第三方）里才有落点。'],
    ['兼容垫片', '给旧版本会话格式、旧插件 API、第三方 OAuth 兜底。'],
    ['取向激进', '拆审批、拆沙箱围栏、放开外部内容可信度，属产品取向。'],
    ['空转', '目标文件或预设不存在，改动无处落地。'],
  ];

  function overview() {
    var byV = {}, byK = {};
    P.forEach(function (p) {
      byV[p.verdict] = (byV[p.verdict] || 0) + 1;
      byK[p.kind] = (byK[p.kind] || 0) + 1;
    });
    var total = P.length || 1;
    var revert = P.filter(function (p) { return p.verdict === '建议还原'; });
    var coreN = CNT.mode.core, fullN = CNT.mode.full, allN = P.length;

    var h = '<article class="doc">';
    h += '<div class="eyebrow"><span class="id">dsh ' + esc(M.dshTarget) + '</span>'
      + '<span class="rule"></span>'
      + '<span>' + esc((M.builtAt || '').slice(0, 10)) + '</span></div>';
    h += '<h1>补丁看板</h1>';
    h += '<p class="lede">' + allN + ' 条清洗补丁：改哪个文件、把什么换成什么、撤掉之后少哪道防线。'
      + '数据读自 <code>' + esc(M.source) + '</code>。</p>';

    h += '<div class="dist"><div class="dist-bar">'
      + S.verdicts.map(function (v) {
        var n = byV[v] || 0;
        return n ? '<i class="' + vClass(v) + '" style="width:' + (n / total * 100).toFixed(2) + '%"></i>' : '';
      }).join('')
      + '</div><div class="dist-legend">'
      + S.verdicts.map(function (v) {
        return '<span><span class="d ' + vClass(v) + '"></span>' + esc(v) + '</span>';
      }).join('')
      + '</div></div>';

    h += '<hr class="sep">';

    h += '<h2>补丁档<span class="cap">换档需要重启宿主</span></h2>';
    h += '<p class="callout"><b>核心档</b> 只跑 ' + coreN + ' 条：注入链、身份与免责文案、系统提示词挂载、会话与传输防崩、桌面壳兼容，不含权限项。'
      + '<b>完整档</b> 跑全部 ' + allN + ' 条（核心 ' + coreN + ' + 额外 ' + fullN + '）。</p>';
    h += '<p class="callout">换档按备份把被清洗文件整体还原，再按目标集合重打一遍，两个方向走同一条路。'
      + '唯一例外：插件运行时钩子 <code>installFreshFullAccess</code> 会把新会话钉成完全权限，它不走补丁表，核心档也拦不住。</p>';

    h += '<hr class="sep">';

    h += '<h2>建议还原</h2>';
    h += '<p class="callout">拆闸门的那一组：默认全权限、审批自动放行、fs 围栏短路、升级链不抛错、hooks deny 改 allow。还原不影响提示词注入。</p>';
    h += '<div class="related">' + revert.map(relBtn).join('') + '</div>';

    h += '<hr class="sep">';

    h += '<h2>处置口径</h2><div class="gloss">'
      + VERDICT_GLOSS.map(function (g) {
        return '<div><b>' + esc(g[0]) + '</b>' + esc(g[1]) + '</div>';
      }).join('')
      + '</div>';

    h += '<hr class="sep">';

    h += '<h2>性质口径</h2><div class="gloss">'
      + KIND_GLOSS.filter(function (g) { return byK[g[0]]; }).map(function (g) {
        return '<div><b>' + esc(g[0]) + '</b>' + esc(g[1]) + '</div>';
      }).join('')
      + '</div>';

    h += '</article>';
    return h;
  }

  function renderPane() {
    var pane = document.getElementById('pane');
    if (!sel) pane.innerHTML = overview();
    else {
      var p = byId[sel];
      if (!p) { sel = ''; return renderPane(); }
      pane.innerHTML = detail(p);
    }
    pane.scrollTop = 0;
  }
  function renderAll() {
    renderList();
    renderPane();
    var cur = document.querySelector('.li.sel');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-id],[data-goto]') : null;
    if (t && t.dataset.id) { sel = String(t.dataset.id); renderAll(); return; }
    if (t && t.dataset.goto) { sel = String(t.dataset.goto); renderAll(); }
  });

  document.getElementById('q').addEventListener('input', function (e) {
    st.q = e.target.value.trim();
    renderList();
  });

  document.getElementById('modeseg').addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b || b.dataset.mode === undefined) return;
    st.mode = b.dataset.mode;
    Array.prototype.forEach.call(this.querySelectorAll('button'), function (x) {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
    renderList();
  });

  document.getElementById('vchips').addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.fchip') : null;
    if (!b) return;
    st.v[b.dataset.v] = !st.v[b.dataset.v];
    b.classList.toggle('on', st.v[b.dataset.v]);
    b.setAttribute('aria-pressed', st.v[b.dataset.v] ? 'true' : 'false');
    renderList();
  });

  document.getElementById('themeSel').addEventListener('change', function (e) {
    st.theme = e.target.value;
    renderList();
  });

  document.getElementById('reset').addEventListener('click', function () {
    st.q = ''; st.theme = ''; st.mode = '';
    S.verdicts.forEach(function (v) { st.v[v] = true; });
    document.getElementById('q').value = '';
    document.getElementById('themeSel').value = '';
    Array.prototype.forEach.call(document.querySelectorAll('#modeseg button'), function (b) {
      var on = b.dataset.mode === '';
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.fchip'), function (b) {
      b.classList.add('on');
      b.setAttribute('aria-pressed', 'true');
    });
    sel = '';
    renderAll();
  });

  var railtoggle = document.getElementById('railtoggle');
  if (railtoggle) railtoggle.addEventListener('click', function () {
    document.querySelector('.rail').classList.toggle('open');
  });

  document.getElementById('expCsv').addEventListener('click', function () {
    var head = ['id', 'cn', 'name', 'mode', 'layer', 'theme', 'kind', 'risk', 'verdict', 'files', 'desc', 'note'];
    var lines = [head.join(',')];
    P.forEach(function (p) {
      var row = [p.id, p.cn, p.name, p.mode, p.layer, p.theme, p.kind, p.risk, p.verdict, p.files.join(' '), p.desc, p.note];
      lines.push(row.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob(['\\ufeff' + lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'dsh-purge-patches-' + M.pluginVersion + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });

  document.getElementById('print').addEventListener('click', function () {
    var rows = visible();
    document.getElementById('printRoot').innerHTML =
      '<div class="p-head"><h1>dsh-purge 补丁看板</h1><div class="m">v' + esc(M.pluginVersion)
      + ' · dsh ' + esc(M.dshTarget) + ' · 构建 ' + esc((M.builtAt || '').slice(0, 10)) + '</div></div>'
      + '<table class="p-tbl"><thead><tr><th>#</th><th>档</th><th>补丁</th><th>性质</th><th>风险</th><th>处置</th><th>目标文件</th></tr></thead><tbody>'
      + rows.map(function (p) {
        return '<tr><td class="n">' + p.id + '</td><td>' + (p.mode === 'core' ? '核心' : '完整')
          + '</td><td>' + esc(p.cn) + '</td><td>' + esc(p.kind) + '</td><td>' + esc(p.risk)
          + '</td><td>' + esc(p.verdict) + '</td><td>' + esc(p.files.join(', ')) + '</td></tr>';
      }).join('') + '</tbody></table>'
      + '<div class="p-note"><h2>判读</h2>'
      + rows.map(function (p) {
        return '<div><b>#' + p.id + ' ' + esc(p.cn) + '</b>（' + esc(p.verdict) + '）：' + esc(p.note || p.desc) + '</div>';
      }).join('') + '</div>';
    window.print();
  });

  document.getElementById('vchips').innerHTML = S.verdicts.map(function (v) {
    return '<button type="button" class="fchip ' + vClass(v) + ' on" data-v="' + esc(v) + '" aria-pressed="true">'
      + '<span class="d"></span>' + esc(v) + '<span class="n">0</span></button>';
  }).join('');

  (function () {
    var themes = {};
    P.forEach(function (p) { themes[p.theme] = 1; });
    document.getElementById('themeSel').innerHTML = '<option value="">全部主题</option>'
      + Object.keys(themes).sort().map(function (k) {
        return '<option value="' + esc(k) + '">' + esc(k) + '</option>';
      }).join('');
  })();

  renderAll();
})();
`;

const DOC_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-purge 补丁看板</title>
<style>__CSS__</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand"><b>dsh-purge</b><span>v__VER__</span></div>
    <button class="railtoggle" id="railtoggle" type="button" aria-label="打开补丁列表">列表</button>
    <div class="spacer"></div>
    <button class="tbtn" id="expCsv" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10"/><path d="M8 10.5l4 4 4-4"/><path d="M5 18h14"/></svg>CSV</button>
    <button class="tbtn solid" id="print" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="2"/><path d="M7 14h10v6H7z"/></svg>打印</button>
  </header>
  <div class="main">
    <aside class="rail">
      <div class="rail-head">
        <label class="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="q" type="search" placeholder="搜 id / 名称 / 文件 / 说明" autocomplete="off" aria-label="搜索补丁">
        </label>
        <div class="seg" id="modeseg" role="tablist" aria-label="按补丁档筛选">
          <button type="button" class="on" data-mode="" role="tab" aria-selected="true">全部<span class="n">0</span></button>
          <button type="button" data-mode="core" role="tab" aria-selected="false">核心<span class="n">0</span></button>
          <button type="button" data-mode="full" role="tab" aria-selected="false">完整<span class="n">0</span></button>
        </div>
        <div class="filters" id="vchips"></div>
        <div class="selrow"><select id="themeSel" aria-label="按主题筛选"></select></div>
      </div>
      <div class="list" id="list"></div>
      <div class="rail-foot"><span id="fstat" aria-live="polite"></span><button class="link" id="reset" type="button">重置</button></div>
    </aside>
    <section class="pane" id="pane"></section>
  </div>
</div>
<div id="printRoot"></div>
<script type="application/json" id="payload">__PAYLOAD__</script>
<script>__CLIENT__</script>
</body>
</html>
`;

function renderHtml(payload) {
  const json = JSON.stringify(payload).replace(/</g, '\u003c');
  return DOC_TEMPLATE
    .split('__CSS__').join(CSS)
    .split('__CLIENT__').join(CLIENT_JS)
    .split('__VER__').join(payload.meta.pluginVersion)
    .split('__PAYLOAD__').join(json);
}

/* ============================ CLI ============================ */

function main() {
  try { new Function(CLIENT_JS); } catch (e) {
    console.error('[fail] CLIENT_JS 语法错误: ' + e.message);
    process.exit(1);
  }
  const payload = build();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const html = renderHtml(payload);
  fs.writeFileSync(OUT, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  const tally = {};
  for (const p of payload.patches) tally[p.verdict] = (tally[p.verdict] || 0) + 1;
  const { mode } = payload.summary.counts;
  console.log('[ok] ' + path.relative(ROOT, OUT) + '  ' + kb + ' KB');
  console.log('     补丁 ' + payload.patches.length + ' 条（核心 ' + mode.core + ' / 完整 ' + mode.full + '）'
    + ' · 建议还原 ' + (tally['建议还原'] || 0) + ' · 按需 ' + (tally['按需'] || 0)
    + ' · 保留 ' + (tally['保留'] || 0) + ' · 可忽略 ' + (tally['可忽略'] || 0));
  if (payload.meta.unannotated.length) {
    console.warn('[warn] 缺少判读的补丁: ' + payload.meta.unannotated.join(', '));
  }
}

main();

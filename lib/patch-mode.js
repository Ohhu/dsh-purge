// 补丁档：core（只做核心注入，不动权限）/ full（完整注入 + 清洗）。
// 与 hooks-deny.js 同一套路：本模块不 import core.js，core 需要时回调本模块。
// 记录按宿主面分开存：桌面端与 dsh web 常共用同一个 DSH_HOME，串档会互相改对方的补丁集。
import fs from "node:fs";
import path from "node:path";

export const PATCH_MODES = Object.freeze(["core", "full"]);

/** 没有记录时的起步档。full = 与历史行为一致，缩减必须是显式动作。 */
export const DEFAULT_PATCH_MODE = "full";

const SETTINGS_FILE = "patch-mode.json";

/**
 * core 档保留的补丁：① 让注入挂得住 ② 让宿主别因为注入挂不住而崩 ③ 身份/免责文案。
 * 不含任何权限项（审批 / 沙箱 / 升级阶梯 / fs 围栏 / hooks / auto-review / plan mode），
 * 也不含工具行为调参（#18/#19/#21/#22/#23/#24）、隐私默认值（#52）与内容判定（#29）。
 */
export const CORE_PATCH_IDS = Object.freeze([
  // 免责句 / 身份句 / 预设适配
  1, 2, 3, 4, 25, 43, 76, 26, 70, 32, 53,
  // 系统提示词挂载
  55, 74, 87, 88, 66, 67, 68, 72,
  // 会话 / 传输防崩
  56, 57, 58, 75, 77, 85, 86, 69,
  // 桌面壳 / 旧版本兼容
  42, 38, 39, 40, 45, 46, 47, 49, 78, 82, 83, 84,
]);

const SURFACES = Object.freeze(["desktop", "web"]);

export function patchModePath(dshHome) {
  return path.join(dshHome, "dsh-purge", SETTINGS_FILE);
}

export function normalizePatchMode(value) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  return PATCH_MODES.includes(text) ? text : "";
}

function readFileModes(dshHome) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(patchModePath(dshHome), "utf8"));
  } catch {
    parsed = null;
  }
  const out = {};
  for (const surface of SURFACES) {
    out[surface] = normalizePatchMode(parsed && typeof parsed === "object" ? parsed[surface] : "") || "";
  }
  return out;
}

/** 全量视图：缺的键补默认值，供 UI 与 CLI 显示。 */
export function loadPatchModes(dshHome) {
  const raw = readFileModes(dshHome);
  const out = {};
  for (const surface of SURFACES) out[surface] = raw[surface] || DEFAULT_PATCH_MODE;
  return out;
}

export function readPatchMode(dshHome, surface, fallback = DEFAULT_PATCH_MODE) {
  const key = SURFACES.includes(surface) ? surface : "desktop";
  const raw = readFileModes(dshHome);
  return raw[key] || normalizePatchMode(fallback) || DEFAULT_PATCH_MODE;
}

/** 原子写（tmp → fsync → rename）：本模块不 import core.js，自己实现一份。 */
function atomicWriteFileSync(fp, content) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    try { fs.fsyncSync(fd); } catch { /* 不支持 fsync 的文件系统忽略 */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function savePatchMode(dshHome, surface, mode) {
  const next = normalizePatchMode(mode);
  if (!next) throw new Error(`invalid patch mode: ${mode}`);
  const key = SURFACES.includes(surface) ? surface : "desktop";
  const modes = loadPatchModes(dshHome);
  modes[key] = next;
  const fp = patchModePath(dshHome);
  atomicWriteFileSync(fp, `${JSON.stringify(modes, null, 2)}\n`);
  return { ok: true, mode: next, surface: key, modes, path: fp };
}

export function selectPatchesByMode(patches, mode) {
  const list = Array.isArray(patches) ? patches : [];
  if (normalizePatchMode(mode) !== "core") return list;
  const keep = new Set(CORE_PATCH_IDS);
  return list.filter((patch) => patch && keep.has(patch.id));
}

export function modeOfPatch(id) {
  return CORE_PATCH_IDS.includes(Number(id)) ? "core" : "full";
}

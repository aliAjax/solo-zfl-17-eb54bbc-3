/* ============================================================
 * 离线胶片放映编排台 —— 纯前端单文件逻辑
 * 数据仅保存在 localStorage，无需网络。
 * ============================================================ */

"use strict";

/* ---------------- 常量 / 示例数据 ---------------- */

const STORAGE_KEY = "film-program-desk-v1";
const HIST_KEY = "film-program-desk-v1::history";

const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36));

function makeSeed() {
  const r1 = uid(), r2 = uid(), r3 = uid(), r4 = uid();
  const room1 = uid(), room2 = uid();
  const c1 = uid(), c2 = uid(), c3 = uid(), c4 = uid(), c5 = uid(), c6 = uid(), c7 = uid(), c8 = uid();
  const s1 = uid();

  const clips = [
    { id: c1, code: "A-001", duration: 12, reelId: r1, altGroup: "G-开场", condition: "完好", note: "城市清晨开场" },
    { id: c2, code: "A-002", duration: 18, reelId: r1, altGroup: "", condition: "轻微划痕", note: "车站送别，左侧细划痕" },
    { id: c3, code: "A-003", duration: 13, reelId: r1, altGroup: "", condition: "完好", note: "雨中长镜头" },
    { id: c4, code: "B-009", duration: 12, reelId: r2, altGroup: "G-开场", condition: "完好", note: "A-001 的修复版替代片头" },
    { id: c5, code: "B-014", duration: 15, reelId: r2, altGroup: "", condition: "接片松动（风险）", note: "段尾接片，换场需检查" },
    { id: c6, code: "B-021", duration: 10, reelId: r2, altGroup: "", condition: "完好", note: "片尾字幕前" },
    { id: c7, code: "C-005", duration: 9, reelId: r3, altGroup: "", condition: "脆化（高风险）", note: "1962 年原底，限放" },
    { id: c8, code: "D-002", duration: 22, reelId: r4, altGroup: "", condition: "完好", note: "加映短片" }
  ];

  const sessions = [
    {
      id: s1,
      name: "早场 · 秋日主题",
      date: "2026-09-20",
      startTime: "09:00",
      roomId: room1,
      gap: 5,
      entries: [
        { id: uid(), clipId: c1, altClipId: null },
        { id: uid(), clipId: c2, altClipId: null },
        { id: uid(), clipId: c3, altClipId: null },
        { id: uid(), clipId: c5, altClipId: null },
        { id: uid(), clipId: c8, altClipId: null }
      ]
    },
    {
      id: uid(),
      name: "午后加映",
      date: "2026-09-20",
      startTime: "13:30",
      roomId: room2,
      gap: 5,
      entries: [
        { id: uid(), clipId: c7, altClipId: null },
        { id: uid(), clipId: c6, altClipId: null }
      ]
    }
  ];

  return {
    reels: [
      { id: r1, name: "原版A卷" },
      { id: r2, name: "修复版B卷" },
      { id: r3, name: "档案C卷（老胶片）" },
      { id: r4, name: "短片D卷" }
    ],
    clips,
    rooms: [
      { id: room1, name: "一号厅" },
      { id: room2, name: "二号厅" }
    ],
    sessions,
    settings: { defaultGap: 5, minReelRest: 30, dailyReelLimit: 4, riskUsageWarn: 2 },
    selectedSessionId: s1
  };
}

/* ---------------- 状态 / 历史 ---------------- */

/** doc：可持久化、可撤销的“正式数据” */
let doc;
/** ui：易失界面状态（当前编辑草稿、当前标签页等） */
let ui = {
  libTab: "clips",
  activeSessionId: null,
  drafts: {}, // sessionId -> 草稿（含 name/date/startTime/roomId/gap/entries）
  pendingSession: null, // 复制/新建后尚未保存的“未登记场次”：通过校验并保存前不进入 doc、不写存档
  clipSearch: "",
  editingClipId: null
};

let history = loadHistory();

function loadDoc() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sessions) && Array.isArray(parsed.clips)) return parsed;
    }
  } catch (err) {
    console.warn("读取存档失败，使用示例数据", err);
  }
  return makeSeed();
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
}

function persistHistory() {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(history));
  } catch (err) {
    console.warn("历史记录过大，未能持久化", err);
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(HIST_KEY);
    if (raw) {
      const h = JSON.parse(raw);
      if (Array.isArray(h.past) && Array.isArray(h.future)) return h;
    }
  } catch (err) { /* ignore */ }
  return { past: [], future: [] };
}

/** 提交一次“有效修改”：先压栈撤销快照，再持久化 */
function commit(label, mutator) {
  const snapshot = JSON.stringify(doc);
  if (mutator) mutator();
  persist();
  history.past.push({ label, snapshot });
  if (history.past.length > 100) history.past.shift();
  history.future = [];
  persistHistory();
  updateUndoRedoButtons();
}

function undo() {
  const prev = history.past.pop();
  if (!prev) return;
  history.future.push({ label: prev.label, snapshot: JSON.stringify(doc) });
  doc = JSON.parse(prev.snapshot);
  // 撤销后草稿可能引用已不存在的场次
  pruneDrafts();
  if (!activeSessionStillExists()) {
    ui.activeSessionId = doc.selectedSessionId && sessionById(doc.selectedSessionId)
      ? doc.selectedSessionId
      : doc.sessions[0]?.id ?? null;
  }
  persist();
  persistHistory();
  renderAll();
  toast(`已撤销：${prev.label}`);
}

function redo() {
  const next = history.future.pop();
  if (!next) return;
  history.past.push({ label: next.label, snapshot: JSON.stringify(doc) });
  doc = JSON.parse(next.snapshot);
  pruneDrafts();
  if (!activeSessionStillExists()) {
    ui.activeSessionId = doc.selectedSessionId && sessionById(doc.selectedSessionId)
      ? doc.selectedSessionId
      : doc.sessions[0]?.id ?? null;
  }
  persist();
  persistHistory();
  renderAll();
  toast(`已重做：${next.label}`);
}

function updateUndoRedoButtons() {
  els.undoBtn.disabled = history.past.length === 0;
  els.redoBtn.disabled = history.future.length === 0;
  els.undoBtn.title = `撤销 (Ctrl+Z)${history.past.length ? "：" + history.past.at(-1).label : ""}`;
  els.redoBtn.title = `重做 (Ctrl+Y)${history.future.length ? "：" + history.future.at(-1).label : ""}`;
}

function pruneDrafts() {
  for (const key of Object.keys(ui.drafts)) {
    if (!doc.sessions.some((s) => s.id === key)) delete ui.drafts[key];
  }
}

/** 当前活动场次是否仍有效（已登记，或未保存的 pending） */
function activeSessionStillExists() {
  const id = ui.activeSessionId;
  if (!id) return false;
  if (doc.sessions.some((s) => s.id === id)) return true;
  return !!(ui.pendingSession && ui.pendingSession.id === id);
}

/* ---------------- 小工具 ---------------- */

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

/** HH:MM -> 分钟；非法返回 NaN */
function parseTime(str) {
  if (typeof str !== "string") return NaN;
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** YYYY-MM-DD -> 自纪元天数（纯数学，避免时区问题） */
function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str ?? "").trim());
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

function fmtClock(totalMin, dayOffset = 0) {
  if (!Number.isFinite(totalMin)) return "--:--";
  let t = totalMin;
  let day = dayOffset;
  while (t >= 1440) { t -= 1440; day += 1; }
  while (t < 0) { t += 1440; day -= 1; }
  const hh = String(Math.floor(t / 60)).padStart(2, "0");
  const mm = String(t % 60).padStart(2, "0");
  return `${hh}:${mm}${day > 0 ? ` (+${day}天)` : ""}`;
}

function fmtDuration(min) {
  const v = Math.max(0, Math.round(min));
  const h = Math.floor(v / 60);
  const m = v % 60;
  if (h === 0) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}
function fmtDurationShort(min) {
  const v = Math.max(0, Math.round(min));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

const reelById = (id) => doc.reels.find((r) => r.id === id);
const clipById = (id) => doc.clips.find((c) => c.id === id);
const roomById = (id) => doc.rooms.find((r) => r.id === id);
const sessionById = (id) => doc.sessions.find((s) => s.id === id);

/** 条目实际使用的片段（考虑替代片段） */
function effectiveClip(entry) {
  return clipById(entry.altClipId || entry.clipId) || null;
}

/** 用于校验的场次视图：未登记场次返回它本身，已登记场次当前有草稿则返回草稿，否则返回正式数据 */
function sessionView(id) {
  if (ui.pendingSession && ui.pendingSession.id === id) return ui.pendingSession;
  if (ui.drafts[id]) return { ...ui.drafts[id], __isDraft: true };
  return sessionById(id) || null;
}

/* ============================================================
 * 时间轴计算
 * ============================================================ */

/**
 * 计算一场内每段的起止时间。
 * 返回 { startAbs, endAbs, rows:[{entry, clip, reelId, start, end, gapBefore, errors:[]}],
 *        totalFilm, totalGap, running, valid, errors:[{entryId,msg}], metaErrors:[] }
 */
function computeTimeline(session) {
  const metaErrors = [];
  const day = parseDate(session.date);
  const startMin = parseTime(session.startTime);
  const gap = Number(session.gap);

  if (Number.isNaN(day)) metaErrors.push("日期无效（应为 YYYY-MM-DD）");
  if (Number.isNaN(startMin)) metaErrors.push("开始时间无效（应为 HH:MM，00:00–23:59）");
  if (!Number.isInteger(gap) || gap < 0) metaErrors.push("换卷间隔必须是不小于 0 的整数（分钟）");
  if (!session.roomId) metaErrors.push("未选择放映室");
  if (!String(session.name || "").trim()) metaErrors.push("场次名称为空");

  const startOk = !Number.isNaN(day) && !Number.isNaN(startMin);
  let cursor = startOk ? day * 1440 + startMin : NaN;
  const startAbs = cursor;

  const seenCodes = new Map(); // 小写编号 -> 第一个条目序号
  const rows = [];
  let totalFilm = 0;
  let totalGap = 0;
  let prevReelId = null;

  session.entries.forEach((entry, idx) => {
    const errors = [];
    const clip = effectiveClip(entry);
    const reelId = clip?.reelId ?? null;

    // 换卷间隔：与上一段不同卷时插入
    let gapBefore = 0;
    if (idx > 0 && startOk) {
      if (reelId && prevReelId && reelId !== prevReelId) gapBefore = Number.isInteger(gap) ? gap : 0;
      cursor += gapBefore;
      totalGap += gapBefore;
    }

    if (!clip) {
      errors.push("引用的片段已从片库删除，需重新选择或移除");
    } else {
      if (!Number.isInteger(clip.duration) || clip.duration <= 0) {
        errors.push(`片长「${clip.duration}」不是正整数（分钟）`);
      }
      const key = String(clip.code || "").trim().toLowerCase();
      if (key) {
        if (seenCodes.has(key)) {
          errors.push(`编号与第 ${seenCodes.get(key)} 段重复（忽略大小写：${key}）`);
        } else {
          seenCodes.set(key, idx + 1);
        }
      } else {
        errors.push("片段编号为空");
      }
      if (Number.isInteger(clip.duration) && clip.duration > 0) totalFilm += clip.duration;
    }

    const start = startOk ? cursor : NaN;
    const end = startOk && clip && Number.isInteger(clip.duration) && clip.duration > 0 ? cursor + clip.duration : NaN;
    if (startOk && clip && Number.isInteger(clip.duration) && clip.duration > 0) cursor = end;
    prevReelId = reelId || prevReelId;

    rows.push({ entry, idx, clip, reelId, start, end, gapBefore, errors });
  });

  if (session.entries.length === 0) metaErrors.push("场次为空，请至少添加一个片段");

  const endAbs = rows.length ? rows.at(-1).end : startAbs;
  const valid = metaErrors.length === 0 && rows.every((r) => r.errors.length === 0);

  return {
    startAbs,
    endAbs,
    day: Number.isNaN(day) ? null : day,
    rows,
    totalFilm,
    totalGap,
    running: Number.isFinite(endAbs) && Number.isFinite(startAbs) ? endAbs - startAbs : NaN,
    endsNextDay: Number.isFinite(endAbs) && Math.floor(endAbs / 1440) > day,
    valid,
    metaErrors
  };
}

/* ============================================================
 * 全局校验：阻断项 / 冲突 / 破损风险
 * ============================================================ */

function overlaps(aStart, aEnd, bStart, bEnd) {
  if ([aStart, aEnd, bStart, bEnd].some((v) => !Number.isFinite(v))) return false;
  return aStart < bEnd && bStart < aEnd; // 端点相接不算冲突
}

function allSessionViews() {
  const views = doc.sessions.map((s) => sessionView(s.id)).filter(Boolean);
  if (ui.pendingSession) views.push(ui.pendingSession);
  return views;
}

/**
 * 返回 { blockers, conflicts, risks, timelines:Map(sessionId, timeline) }
 */
function validateAll() {
  const blockers = [];
  const conflicts = [];
  const risks = [];
  const timelines = new Map();

  const views = allSessionViews();

  for (const sv of views) {
    const tl = computeTimeline(sv);
    timelines.set(sv.id, tl);
    const label = `${sv.name || "未命名场次"}（${sv.date || "??"} ${sv.startTime || "??"}）`;

    for (const msg of tl.metaErrors) {
      blockers.push({
        key: `meta-${sv.id}-${msg}`,
        sessionId: sv.id,
        title: label,
        desc: msg,
        locate: "点击定位到该场次"
      });
    }
    for (const row of tl.rows) {
      for (const msg of row.errors) {
        blockers.push({
          key: `entry-${row.entry.id}-${msg}`,
          sessionId: sv.id,
          entryId: row.entry.id,
          title: `${label} → 第 ${row.idx + 1} 段 ${row.clip ? row.clip.code : "（缺失片段）"}`,
          desc: msg,
          locate: "点击定位到该场次并高亮此段"
        });
      }
    }
  }

  // 两两检查同厅 / 同卷时间重叠（只在时间轴合法的场次之间）
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const a = views[i];
      const b = views[j];
      const ta = timelines.get(a.id);
      const tb = timelines.get(b.id);
      if (!Number.isFinite(ta.startAbs) || !Number.isFinite(tb.startAbs)) continue;
      if (!Number.isFinite(ta.endAbs) || !Number.isFinite(tb.endAbs)) continue;
      if (a.roomId && b.roomId && a.roomId === b.roomId) {
        if (overlaps(ta.startAbs, ta.endAbs, tb.startAbs, tb.endAbs)) {
          conflicts.push({
            key: `room-${a.id}-${b.id}`,
            sessionId: a.id,
            otherSessionId: b.id,
            title: `放映室冲突：${roomById(a.roomId)?.name || "?"}`,
            desc: `「${a.name}」(${a.date} ${fmtClock(ta.startAbs % 1440, Math.floor(ta.startAbs / 1440) - (ta.day ?? 0))}–${fmtClock(ta.endAbs % 1440, Math.floor(ta.endAbs / 1440) - (ta.day ?? 0))}) 与「${b.name}」(${b.date} ${fmtClock(tb.startAbs % 1440, Math.floor(tb.startAbs / 1440) - (tb.day ?? 0))}–${fmtClock(tb.endAbs % 1440, Math.floor(tb.endAbs / 1440) - (tb.day ?? 0))}) 时间重叠`,
            locate: "点击在两场次之间切换定位"
          });
        }
      }

      // 同卷：逐段比对（缓冲不计入卷占用，但片段本体区间是 [start,end]）
      for (const ra of ta.rows) {
        if (!ra.reelId || !Number.isFinite(ra.start)) continue;
        for (const rb of tb.rows) {
          if (ra.reelId !== rb.reelId || !Number.isFinite(rb.start)) continue;
          if (overlaps(ra.start, ra.end, rb.start, rb.end)) {
            conflicts.push({
              key: `reel-${ra.entry.id}-${rb.entry.id}`,
              sessionId: a.id,
              otherSessionId: b.id,
              title: `胶片卷冲突：${reelById(ra.reelId)?.name || "?"}`,
              desc: `「${a.name}」第 ${ra.idx + 1} 段 ${ra.clip.code}(${fmtClock(ra.start % 1440, Math.floor(ra.start / 1440) - (ta.day ?? 0))}–${fmtClock(ra.end % 1440, Math.floor(ra.end / 1440) - (ta.day ?? 0))}) 与「${b.name}」第 ${rb.idx + 1} 段 ${rb.clip.code}(${fmtClock(rb.start % 1440, Math.floor(rb.start / 1440) - (tb.day ?? 0))}–${fmtClock(rb.end % 1440, Math.floor(rb.end / 1440) - (tb.day ?? 0))}) 同时需要同一卷`,
              locate: "点击在两场次之间切换定位"
            });
          }
        }
      }
    }
  }

  // ---------- 破损风险（不阻断导出） ----------
  const dayKey = (abs) => Math.floor(abs / 1440);

  // 1) 片段保存状态风险（每次使用一条）
  for (const sv of views) {
    const tl = timelines.get(sv.id);
    for (const row of tl.rows) {
      const clip = row.clip;
      if (!clip) continue;
      if (clip.condition === "脆化（高风险）") {
        risks.push({
          key: `cond-h-${row.entry.id}`,
          sessionId: sv.id,
          entryId: row.entry.id,
          title: `高破损风险：${clip.code}（${reelById(clip.reelId)?.name || "?"}）`,
          desc: `片段状态为「${clip.condition}」，在「${sv.name}」中使用；建议减少场次或改用同替代组片段。${clip.note ? "备注：" + clip.note : ""}`,
          locate: "点击定位到该场次"
        });
      } else if (clip.condition === "接片松动（风险）" || clip.condition === "齿孔磨损") {
        risks.push({
          key: `cond-m-${row.entry.id}`,
          sessionId: sv.id,
          entryId: row.entry.id,
          title: `破损关注：${clip.code}（${reelById(clip.reelId)?.name || "?"}）`,
          desc: `片段状态为「${clip.condition}」，映前需检查。${clip.note ? "备注：" + clip.note : ""}`,
          locate: "点击定位到该场次"
        });
      }
    }
  }

  // 2) 同一卷同一天使用次数
  const usage = new Map(); // reelId|day -> [{sv,row}]
  for (const sv of views) {
    const tl = timelines.get(sv.id);
    for (const row of tl.rows) {
      if (!row.reelId || !Number.isFinite(row.start)) continue;
      const k = `${row.reelId}|${dayKey(row.start)}`;
      if (!usage.has(k)) usage.set(k, []);
      usage.get(k).push({ sv, row });
    }
  }
  for (const [k, list] of usage) {
    const [reelId] = k.split("|");
    if (list.length >= doc.settings.dailyReelLimit) {
      risks.push({
        key: `daily-${k}`,
        sessionId: list[0].sv.id,
        title: `过劳风险：${reelById(reelId)?.name || "?"} 当日放映 ${list.length} 次`,
        desc: `同一卷同一天计划使用 ${list.length} 次，达到建议上限 ${doc.settings.dailyReelLimit} 次；过度搬运与上片增加划伤概率。场次：${list.map((x) => x.sv.name).join("、")}`,
        locate: "点击定位到第一场"
      });
    }
  }

  // 3) 同卷相邻两次使用间隔不足（需要换片/倒片休整）
  const windows = new Map(); // reelId -> [{start,end,sv}]
  for (const sv of views) {
    const tl = timelines.get(sv.id);
    const byReel = new Map();
    for (const row of tl.rows) {
      if (!row.reelId || !Number.isFinite(row.start)) continue;
      if (!byReel.has(row.reelId)) byReel.set(row.reelId, []);
      byReel.get(row.reelId).push(row);
    }
    for (const [reelId, rows] of byReel) {
      const s = Math.min(...rows.map((r) => r.start));
      const e = Math.max(...rows.map((r) => r.end));
      if (!windows.has(reelId)) windows.set(reelId, []);
      windows.get(reelId).push({ start: s, end: e, sv });
    }
  }
  for (const [reelId, wins] of windows) {
    wins.sort((a, b) => a.start - b.start);
    for (let k = 1; k < wins.length; k++) {
      const gapMin = wins[k].start - wins[k - 1].end;
      if (gapMin < doc.settings.minReelRest) {
        risks.push({
          key: `rest-${reelId}-${wins[k - 1].sv.id}-${wins[k].sv.id}`,
          sessionId: wins[k].sv.id,
          otherSessionId: wins[k - 1].sv.id,
          title: `休整不足：${reelById(reelId)?.name || "?"} 两场间隔仅 ${gapMin} 分钟`,
          desc: `「${wins[k - 1].sv.name}」结束后 ${gapMin} 分钟即要在「${wins[k].sv.name}」使用同一卷，建议至少间隔 ${doc.settings.minReelRest} 分钟用于倒片与检查。`,
          locate: "点击在两场次之间切换定位"
        });
      }
    }
  }

  return { blockers, conflicts, risks, timelines };
}

/* ============================================================
 * DOM 引用
 * ============================================================ */

const els = {
  undoBtn: $("#undoBtn"), redoBtn: $("#redoBtn"), resetDataBtn: $("#resetDataBtn"),
  // library
  clipForm: $("#clipForm"), clipCode: $("#clipCode"), clipDuration: $("#clipDuration"),
  clipReel: $("#clipReel"), clipAlt: $("#clipAlt"), altGroupList: $("#altGroupList"),
  clipCondition: $("#clipCondition"), clipNote: $("#clipNote"), clipFormReset: $("#clipFormReset"),
  clipFormHint: $("#clipFormHint"), clipSearch: $("#clipSearch"), clipList: $("#clipList"),
  reelForm: $("#reelForm"), reelName: $("#reelName"), reelList: $("#reelList"),
  roomForm: $("#roomForm"), roomName: $("#roomName"), roomList: $("#roomList"),
  gapSetting: $("#gapSetting"),
  // sessions
  sessionTabs: $("#sessionTabs"), newSessionBtn: $("#newSessionBtn"),
  copySessionBtn: $("#copySessionBtn"), removeSessionBtn: $("#removeSessionBtn"),
  sessionEditor: $("#sessionEditor"), noSessionHint: $("#noSessionHint"),
  sessionName: $("#sessionName"), sessionDate: $("#sessionDate"), sessionTime: $("#sessionTime"),
  sessionRoom: $("#sessionRoom"), sessionGap: $("#sessionGap"),
  timelineSummary: $("#timelineSummary"), entryList: $("#entryList"),
  addClipSelect: $("#addClipSelect"), addEntryBtn: $("#addEntryBtn"),
  saveSessionBtn: $("#saveSessionBtn"), revertSessionBtn: $("#revertSessionBtn"),
  sessionSaveHint: $("#sessionSaveHint"),
  // check
  summaryCards: $("#summaryCards"), blockerCount: $("#blockerCount"), blockerList: $("#blockerList"),
  conflictCount: $("#conflictCount"), conflictList: $("#conflictList"),
  riskCount: $("#riskCount"), riskList: $("#riskList"),
  exportBtn: $("#exportBtn"), exportHint: $("#exportHint"),
  toast: $("#toast")
};

/* ============================================================
 * 渲染
 * ============================================================ */

let lastValidation = null;
let draggedEntryId = null;

function renderAll() {
  lastValidation = validateAll();
  renderLibrary();
  renderSessionArea();
  renderCheckPanel();
  updateUndoRedoButtons();
}

/* ---------- 左栏：片库 / 卷 / 厅 ---------- */

function renderLibrary() {
  // 片库表单的卷下拉
  els.clipReel.innerHTML = doc.reels.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  els.altGroupList.innerHTML = [...new Set(doc.clips.map((c) => c.altGroup).filter(Boolean))]
    .map((g) => `<option value="${esc(g)}"></option>`).join("");

  const kw = ui.clipSearch.trim().toLowerCase();
  const clips = doc.clips
    .filter((c) => !kw || `${c.code} ${c.note} ${c.altGroup}`.toLowerCase().includes(kw))
    .sort((a, b) => a.code.localeCompare(b.code, "zh"));

  els.clipList.innerHTML =
    clips.map((c) => {
      const reel = reelById(c.reelId);
      const condClass = c.condition.includes("高风险") ? "cond-high" : c.condition === "完好" ? "cond-good" : "cond-risk";
      const used = doc.sessions.reduce(
        (n, s) => n + s.entries.filter((e) => e.clipId === c.id || e.altClipId === c.id).length, 0);
      return `
        <li class="clip-item" data-clip-id="${c.id}">
          <div class="clip-row1">
            <span class="clip-code">${esc(c.code)}</span>
            <span class="row-actions">
              <button class="btn btn-mini" data-clip-edit="${c.id}" type="button">编辑</button>
              <button class="btn btn-mini danger" data-clip-delete="${c.id}" type="button" title="引用它的场次会变成缺失片段">删除</button>
            </span>
          </div>
          <div class="clip-meta">${c.duration} 分钟 · ${esc(reel ? reel.name : "（未归卷）")} · 被 ${used} 个条目引用</div>
          <div class="clip-row1">
            <span>
              <span class="tag ${condClass}">${esc(c.condition)}</span>
              ${c.altGroup ? `<span class="tag alt">替代组 ${esc(c.altGroup)}</span>` : ""}
            </span>
          </div>
          ${c.note ? `<div class="clip-note">${esc(c.note)}</div>` : ""}
        </li>`;
    }).join("") || `<li class="empty-line">没有匹配的片段。</li>`;

  els.reelList.innerHTML = doc.reels.map((r) => {
    const n = doc.clips.filter((c) => c.reelId === r.id).length;
    const used = !!doc.sessions.some((s) =>
      s.entries.some((e) => {
        const clip = effectiveClip(e);
        return clip && clip.reelId === r.id;
      }));
    return `
      <li class="reel-item">
        <div class="clip-row1">
          <strong>${esc(r.name)}</strong>
          <span class="row-actions">
            <button class="btn btn-mini danger" data-reel-delete="${r.id}" type="button">删除</button>
          </span>
        </div>
        <div class="clip-meta">${n} 个片段${used ? " · 正被场次使用" : ""}</div>
      </li>`;
  }).join("") || `<li class="empty-line">还没有胶片卷。</li>`;

  els.roomList.innerHTML = doc.rooms.map((room) => {
    const used = doc.sessions.some((s) => s.roomId === room.id);
    return `
      <li class="room-item">
        <div class="clip-row1">
          <strong>${esc(room.name)}</strong>
          <span class="row-actions">
            <button class="btn btn-mini danger" data-room-delete="${room.id}" type="button">删除</button>
          </span>
        </div>
        <div class="clip-meta">${doc.sessions.filter((s) => s.roomId === room.id).length} 场已排${used ? "" : ""}</div>
      </li>`;
  }).join("") || `<li class="empty-line">还没有放映室。</li>`;

  els.gapSetting.value = doc.settings.defaultGap;
}

/* ---------- 中栏：场次 ---------- */

function sessionStatus(sv, tl) {
  const hasBlock = tl.metaErrors.length > 0 || tl.rows.some((r) => r.errors.length > 0);
  const inConflict = lastValidation.conflicts.some(
    (c) => c.sessionId === sv.id || c.otherSessionId === sv.id);
  if (hasBlock || inConflict) return inConflict ? "danger" : "warn";
  return "ok";
}

function renderSessionArea() {
  const pending = ui.pendingSession;
  // 活动场次必须是已登记场次或未登记场次之一；否则回落到最新已登记场次
  if (!ui.activeSessionId ||
      (!sessionById(ui.activeSessionId) && !(pending && pending.id === ui.activeSessionId))) {
    ui.activeSessionId = doc.sessions.at(-1)?.id ?? (pending ? pending.id : null);
  }

  const tabs = doc.sessions.map((s) => {
    const sv = sessionView(s.id);
    const tl = lastValidation.timelines.get(s.id) || computeTimeline(sv);
    const status = sessionStatus(sv, tl);
    const active = s.id === ui.activeSessionId ? "active" : "";
    const dirty = ui.drafts[s.id] ? "dirty" : "";
    return `
      <button class="session-tab ${active} ${dirty}" data-session-tab="${s.id}" type="button">
        <span class="dot ${status}"></span>${esc(s.name || "未命名场次")}
      </button>`;
  });

  // 未登记场次标签（不写入存档，强制保存/放弃）
  if (pending) {
    const tl = lastValidation.timelines.get(pending.id) || computeTimeline(pending);
    const status = sessionStatus(pending, tl);
    const active = pending.id === ui.activeSessionId ? "active" : "";
    tabs.push(`
      <button class="session-tab ${active} dirty pending" data-session-tab="${pending.id}" type="button"
        title="未保存：保存前不会写入本机存档，刷新或放弃即消失">
        <span class="dot ${status}"></span>${esc(pending.name || "未命名场次")}<span class="unsaved-badge">未保存</span>
      </button>`);
  }
  els.sessionTabs.innerHTML = tabs.join("");

  const sv = ui.activeSessionId ? sessionView(ui.activeSessionId) : null;
  const isPending = !!(pending && sv && pending.id === sv.id);
  els.newSessionBtn.disabled = !!pending;
  els.copySessionBtn.disabled = !sv || !!pending;
  els.removeSessionBtn.disabled = !sv;
  if (!sv) {
    els.sessionEditor.classList.add("hidden");
    els.noSessionHint.classList.remove("hidden");
    return;
  }
  els.sessionEditor.classList.remove("hidden");
  els.noSessionHint.classList.add("hidden");

  els.sessionName.value = sv.name;
  els.sessionDate.value = sv.date;
  els.sessionTime.value = sv.startTime;
  els.sessionRoom.innerHTML =
    doc.rooms.map((r) => `<option value="${r.id}"${r.id === sv.roomId ? " selected" : ""}>${esc(r.name)}</option>`).join("");
  els.sessionGap.value = sv.gap;

  renderTimelineSummary(sv);
  renderEntries(sv);
  renderAddClipSelect(sv);

  // 保存按钮与提示
  const tl = lastValidation.timelines.get(sv.id);
  const inConflict = lastValidation.conflicts.some(
    (c) => c.sessionId === sv.id || c.otherSessionId === sv.id);
  const isDirty = isPending || !!ui.drafts[sv.id];
  els.saveSessionBtn.disabled = !isDirty;
  els.revertSessionBtn.disabled = !isDirty;
  els.saveSessionBtn.textContent = isPending
    ? (ui.pendingKind === "duplicate" ? "保存副本（Ctrl+S）" : "保存新场次（Ctrl+S）")
    : "保存场次（Ctrl+S）";

  const localBlockers = lastValidation.blockers.filter((b) => b.sessionId === sv.id).length;
  if (!isDirty) {
    els.sessionSaveHint.textContent = "所有改动已保存";
    els.sessionSaveHint.className = "form-hint ok";
  } else if (localBlockers || inConflict) {
    const bits = [];
    if (localBlockers) bits.push(`${localBlockers} 个场内问题`);
    if (inConflict) bits.push("存在跨场冲突");
    els.sessionSaveHint.textContent =
      (isPending ? "未保存、未写入存档" : "草稿不能保存") + `：${bits.join("，")}（见右侧核对栏）`;
    els.sessionSaveHint.className = "form-hint error";
  } else {
    els.sessionSaveHint.textContent = isPending
      ? "无阻断与冲突，点击保存才会写入本机存档"
      : "有未保存修改";
    els.sessionSaveHint.className = "form-hint";
  }
}

function renderTimelineSummary(sv) {
  const tl = lastValidation.timelines.get(sv.id) || computeTimeline(sv);
  const dayOffsetStart = tl.day === null ? 0 : 0;
  const startText = Number.isFinite(tl.startAbs)
    ? fmtClock(tl.startAbs % 1440, Math.floor(tl.startAbs / 1440) - (tl.day ?? Math.floor(tl.startAbs / 1440)))
    : "--:--";
  const endText = Number.isFinite(tl.endAbs)
    ? fmtClock(tl.endAbs % 1440, Math.floor(tl.endAbs / 1440) - (tl.day ?? Math.floor(tl.endAbs / 1440)))
    : "--:--";
  const inConflict = lastValidation.conflicts.some(
    (c) => c.sessionId === sv.id || c.otherSessionId === sv.id);

  const items = [
    { label: "开场", value: `${sv.date || "??"} ${startText}`, bad: !Number.isFinite(tl.startAbs) },
    { label: "散场", value: endText + (tl.endsNextDay ? "（跨午夜）" : ""), bad: !Number.isFinite(tl.endAbs) },
    { label: "正片总时长", value: fmtDuration(tl.totalFilm) },
    { label: "换卷缓冲", value: `${tl.rows.filter((r) => r.gapBefore > 0).length} 次 / 共 ${tl.totalGap} 分钟` },
    { label: "占用总时长", value: Number.isFinite(tl.running) ? fmtDuration(tl.running) : "--", bad: !Number.isFinite(tl.running) },
    { label: "跨场冲突", value: inConflict ? "有冲突" : "无", bad: inConflict, good: !inConflict }
  ];
  els.timelineSummary.innerHTML = items.map(
    (it) => `<div class="metric ${it.bad ? "bad" : it.good ? "good" : ""}"><span>${it.label}</span><strong>${esc(it.value)}</strong></div>`
  ).join("");
}

function renderEntries(sv) {
  const tl = lastValidation.timelines.get(sv.id) || computeTimeline(sv);
  const baseDay = tl.day;

  els.entryList.innerHTML = tl.rows.map((row) => {
    const clip = row.clip;
    const reel = clip ? reelById(clip.reelId) : null;
    const startText = Number.isFinite(row.start)
      ? fmtClock(row.start % 1440, Math.floor(row.start / 1440) - (baseDay ?? 0)) : "--:--";
    const endText = Number.isFinite(row.end)
      ? fmtClock(row.end % 1440, Math.floor(row.end / 1440) - (baseDay ?? 0)) : "--:--";

    // 替代片段选择器：同替代组的其他片段
    let altHtml = "";
    if (clip && clip.altGroup) {
      const alts = doc.clips.filter((c) => c.altGroup === clip.altGroup && c.id !== clip.id);
      if (alts.length) {
        altHtml = `
          <label class="inline-alt">替代：
            <select data-alt-select="${row.entry.id}">
              <option value="">使用原片段 ${esc(clip.code)}</option>
              ${alts.map((a) => `<option value="${a.id}"${row.entry.altClipId === a.id ? " selected" : ""}>${esc(a.code)}（${a.duration}分 · ${esc(reelById(a.reelId)?.name || "")}）</option>`).join("")}
            </select>
          </label>`;
      }
    } else if (row.entry.altClipId) {
      altHtml = `<label class="inline-alt">替代：
        <select data-alt-select="${row.entry.id}"><option value="">取消替代（原片段已不在同组）</option></select></label>`;
    }

    return `
      <li class="entry-card ${row.errors.length ? "has-error" : ""}" data-entry-id="${row.entry.id}" draggable="true">
        <div class="reel-grip" title="拖拽换序">⠿</div>
        <div class="entry-main">
          <div class="entry-line1">
            <span class="entry-code">${row.idx + 1}. ${clip ? esc(clip.code) : "（缺失）"}</span>
            <span class="entry-time">${startText} → ${endText}</span>
            ${row.gapBefore > 0 ? `<span class="gap-chip">换卷 +${row.gapBefore} 分</span>` : ""}
            ${altHtml}
          </div>
          <div class="entry-sub">
            ${clip ? `${esc(clip.duration)} 分钟 · ${esc(reel?.name || "未归卷")} · ${esc(clip.condition)}${clip.altGroup ? ` · 替代组 ${esc(clip.altGroup)}` : ""}` : "片段不存在"}
          </div>
          ${row.errors.length ? `<div class="entry-errors">⚠ ${row.errors.map(esc).join("；")}</div>` : ""}
        </div>
        <div class="entry-actions">
          <button class="btn btn-mini" data-entry-up="${row.entry.id}" type="button" title="上移">↑</button>
          <button class="btn btn-mini" data-entry-down="${row.entry.id}" type="button" title="下移">↓</button>
          <button class="btn btn-mini danger" data-entry-del="${row.entry.id}" type="button" title="移除">×</button>
        </div>
      </li>`;
  }).join("") || `<li class="empty-line">本场还没有片段，从下方选择并添加。</li>`;
}

function renderAddClipSelect(sv) {
  const used = new Set(sv.entries.map((e) => (effectiveClip(e) || {}).id));
  els.addClipSelect.innerHTML = doc.clips
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, "zh"))
    .map((c) => {
      const reel = reelById(c.reelId);
      return `<option value="${c.id}">${esc(c.code)} · ${c.duration}分 · ${esc(reel?.name || "未归卷")}${used.has(c.id) ? "（已在本场）" : ""}</option>`;
    }).join("");
}

/* ---------- 右栏：核对 / 导出 ---------- */

function issueHtml(item, cls) {
  return `
    <li class="issue ${cls}" data-issue-session="${item.sessionId}"
        ${item.otherSessionId ? `data-issue-other="${item.otherSessionId}"` : ""}
        ${item.entryId ? `data-issue-entry="${item.entryId}"` : ""}>
      <div class="issue-title">${esc(item.title)}</div>
      <div class="issue-desc">${esc(item.desc)}</div>
      <div class="locate">${esc(item.locate)} ↗</div>
    </li>`;
}

function renderCheckPanel() {
  const { blockers, conflicts, risks, timelines } = lastValidation;

  // 汇总卡
  let filmMin = 0, bufMin = 0;
  for (const s of doc.sessions) {
    const tl = timelines.get(s.id);
    if (tl) { filmMin += tl.totalFilm; bufMin += tl.totalGap; }
  }
  const currentTl = ui.activeSessionId ? timelines.get(ui.activeSessionId) : null;
  const cards = [
    { label: "场次总数", value: doc.sessions.length },
    { label: "当前场总时长", value: currentTl && Number.isFinite(currentTl.running) ? fmtDurationShort(currentTl.running) : "--" },
    { label: "冲突 / 阻断", value: `${conflicts.length} / ${blockers.length}`, hot: blockers.length + conflicts.length > 0 },
    { label: "破损风险", value: risks.length, hot: risks.some((r) => r.title.includes("高")) }
  ];
  els.summaryCards.innerHTML = cards.map(
    (c) => `<div class="summary-card ${c.hot ? "bad" : "good"}"><span>${c.label}</span><strong>${esc(c.value)}</strong></div>`
  ).join("");

  els.blockerCount.textContent = blockers.length;
  els.blockerCount.className = "count-badge" + (blockers.length ? " hot" : "");
  els.blockerList.innerHTML =
    blockers.map((b) => issueHtml(b, "blocker")).join("") ||
    `<li class="empty-line">无阻断项。</li>`;

  els.conflictCount.textContent = conflicts.length;
  els.conflictCount.className = "count-badge" + (conflicts.length ? " hot" : "");
  els.conflictList.innerHTML =
    conflicts.map((c) => issueHtml(c, "conflict")).join("") ||
    `<li class="empty-line">同卷、同厅均无时间重叠。</li>`;

  els.riskCount.textContent = risks.length;
  els.riskCount.className = "count-badge" + (risks.length ? " hot" : "");
  els.riskList.innerHTML =
    risks.map((r) => issueHtml(r, "risk")).join("") ||
    `<li class="empty-line">暂无破损风险。</li>`;

  els.exportBtn.disabled = blockers.length + conflicts.length > 0;

  if (ui.pendingSession) {
    els.exportHint.className = "form-hint";
    els.exportHint.textContent = "有未保存的复制/新建场次，保存后才会进入正式数据与导出文件。";
  }
}

/* ============================================================
 * 草稿机制
 * ============================================================ */

function ensureDraft(sessionId) {
  if (ui.drafts[sessionId]) return ui.drafts[sessionId];
  const s = sessionById(sessionId);
  const draft = JSON.parse(JSON.stringify(s));
  ui.drafts[sessionId] = draft;
  return draft;
}

/** 更新草稿后重算（不写正式数据）；未登记场次直接原地修改 pending */
function mutateDraft(sessionId, fn) {
  if (ui.pendingSession && ui.pendingSession.id === sessionId) {
    fn(ui.pendingSession);
    renderAll();
    return;
  }
  const d = ensureDraft(sessionId);
  fn(d);
  renderAll();
}

/** 校验草稿：无场内阻断、且与其他场次无冲突时允许保存 */
function draftSaveable(sessionId) {
  const v = lastValidation;
  const localBlockers = v.blockers.filter((b) => b.sessionId === sessionId).length;
  const inConflict = v.conflicts.some((c) => c.sessionId === sessionId || c.otherSessionId === sessionId);
  return localBlockers === 0 && !inConflict;
}

function saveDraft() {
  const id = ui.activeSessionId;
  if (!id) return;

  // —— 未登记场次（复制 / 新建产生）：通过校验前绝不进入 doc，保存时才首次入档 ——
  if (ui.pendingSession && ui.pendingSession.id === id) {
    if (!draftSaveable(id)) {
      toast("副本仍有阻断项或冲突，无法保存；解决前不会写入本机存档，右侧核对栏可逐项定位", "error");
      return;
    }
    const data = JSON.parse(JSON.stringify(ui.pendingSession));
    const label = ui.pendingKind === "duplicate"
      ? `复制场次「${ui.pendingSourceName}」`
      : `新建场次「${data.name}」`;
    ui.pendingSession = null;
    ui.pendingKind = null;
    ui.pendingSourceName = null;
    commit(label, () => {
      doc.sessions.push(data);
      doc.selectedSessionId = id;
    });
    renderAll();
    toast(`场次「${data.name}」已保存并写入本机存档`, "ok");
    return;
  }

  // —— 已登记场次的草稿修改 ——
  if (!ui.drafts[id]) return;
  if (!draftSaveable(id)) {
    toast("仍有阻断项或冲突，无法保存；右侧核对栏可逐项定位", "error");
    return;
  }
  const draft = ui.drafts[id];
  commit(`保存场次「${draft.name}」`, () => {
    const idx = doc.sessions.findIndex((s) => s.id === id);
    doc.sessions[idx] = JSON.parse(JSON.stringify(draft));
  });
  delete ui.drafts[id];
  renderAll();
  toast(`场次「${draft.name}」已保存`, "ok");
}

/** 放弃当前编辑：未登记场次直接丢弃（不留副本、不入存档、不进撤销栈）；已登记场次还原到上次保存版本 */
function revertDraft() {
  const id = ui.activeSessionId;
  if (!id) return;
  if (ui.pendingSession && ui.pendingSession.id === id) {
    ui.pendingSession = null;
    ui.pendingKind = null;
    ui.pendingSourceName = null;
    ui.activeSessionId = doc.selectedSessionId && sessionById(doc.selectedSessionId)
      ? doc.selectedSessionId
      : doc.sessions.at(-1)?.id ?? null;
    renderAll();
    toast("已放弃未保存的场次，副本未写入存档");
    return;
  }
  if (!ui.drafts[id]) return;
  delete ui.drafts[id];
  renderAll();
  toast("已还原到上次保存的版本");
}

/* ============================================================
 * 场次：新建 / 复制 / 删除 / 切换
 * ============================================================ */

/** 生成一个“未登记场次”作为 pending：仅存在于内存，保存前不进入 doc、不写 localStorage */
function openPending(session, kind, sourceName = null) {
  // 同时只允许一个未登记场次
  if (ui.pendingSession) {
    toast("请先保存或放弃当前未保存的场次", "error");
    return null;
  }
  ui.pendingSession = session;
  ui.pendingKind = kind;
  ui.pendingSourceName = sourceName;
  ui.activeSessionId = session.id;
  renderAll();
  return session;
}

function createSession() {
  if (ui.pendingSession) { toast("请先保存或放弃当前未保存的场次", "error"); return; }
  const id = uid();
  openPending({
    id,
    name: "新场次",
    date: new Date().toISOString().slice(0, 10),
    startTime: "10:00",
    roomId: doc.rooms[0]?.id || null,
    gap: doc.settings.defaultGap,
    entries: []
  }, "new");
}

function duplicateCurrentSession() {
  if (ui.pendingSession) { toast("请先保存或放弃当前未保存的场次", "error"); return; }
  // 来源必须是已保存的正式场次
  const src = sessionById(ui.activeSessionId);
  if (!src) return;
  // 复制到同厅，开始时间顺延 30 分钟，条目深拷贝、重新生成 entry id、保留替代片段选择
  const startMin = parseTime(src.startTime);
  let newTime = src.startTime;
  let date = src.date;
  if (Number.isFinite(startMin)) {
    const day = parseDate(src.date);
    const abs = day * 1440 + startMin + 30;
    date = new Date(Math.floor(abs / 1440) * 86400000).toISOString().slice(0, 10);
    newTime = fmtClock(abs % 1440);
  }
  const pending = {
    id: uid(),
    name: src.name + " 副本",
    date,
    startTime: newTime,
    roomId: src.roomId,
    gap: src.gap,
    entries: src.entries.map((e) => ({ id: uid(), clipId: e.clipId, altClipId: e.altClipId }))
  };
  openPending(pending, "duplicate", src.name);
  if (ui.pendingSession) {
    toast(`已复制为「${pending.name}」（${date} ${newTime}），保存前不会写入存档`, "ok");
  }
}

function removeCurrentSession() {
  const id = ui.activeSessionId;
  // 未登记场次：直接丢弃，无需确认、不进撤销栈
  if (ui.pendingSession && ui.pendingSession.id === id) {
    revertDraft();
    return;
  }
  const s = sessionById(id);
  if (!s) return;
  if (!window.confirm(`确认移除场次「${s.name}」？该操作可撤销。`)) return;
  commit(`移除场次「${s.name}」`, () => {
    doc.sessions = doc.sessions.filter((x) => x.id !== id);
    if (doc.selectedSessionId === id) doc.selectedSessionId = doc.sessions.at(-1)?.id ?? null;
  });
  delete ui.drafts[id];
  ui.activeSessionId = doc.selectedSessionId;
  renderAll();
  toast("场次已移除（可 Ctrl+Z 撤销）");
}

function switchSession(id) {
  if (id === ui.activeSessionId) return;
  const currentId = ui.activeSessionId;
  // 当前停留在未保存的未登记场次：切换即放弃它（它从未进入存档）
  if (ui.pendingSession && ui.pendingSession.id === currentId) {
    const keep = window.confirm("当前复制/新建的场次尚未保存。\n确定＝放弃它并切换（不会写入存档）；取消＝留在本场次。");
    if (!keep) return;
    ui.pendingSession = null;
    ui.pendingKind = null;
    ui.pendingSourceName = null;
  } else if (currentId && ui.drafts[currentId]) {
    const keep = window.confirm("当前场次有未保存修改。\n确定＝放弃修改并切换；取消＝留在本场次。");
    if (!keep) return;
    delete ui.drafts[currentId];
  }
  ui.activeSessionId = id;
  if (sessionById(id)) {
    doc.selectedSessionId = id;
    persist(); // 选择状态不进入撤销栈
  }
  renderAll();
}

/* ============================================================
 * 片库编辑
 * ============================================================ */

function fillClipForm(clip) {
  ui.editingClipId = clip.id;
  els.clipCode.value = clip.code;
  els.clipDuration.value = clip.duration;
  els.clipReel.value = clip.reelId;
  els.clipAlt.value = clip.altGroup || "";
  els.clipCondition.value = clip.condition;
  els.clipNote.value = clip.note || "";
  els.clipFormHint.textContent = `正在编辑 ${clip.code}，保存后所有引用场次同步更新`;
  els.clipFormHint.className = "form-hint";
  els.clipForm.querySelector("button[type=submit]").textContent = "保存修改";
}

function resetClipForm() {
  ui.editingClipId = null;
  els.clipForm.reset();
  els.clipDuration.value = 10;
  els.clipFormHint.textContent = "";
  els.clipForm.querySelector("button[type=submit]").textContent = "加入片库";
}

function clipFormSubmit(event) {
  event.preventDefault();
  const code = els.clipCode.value.trim();
  const duration = Number(els.clipDuration.value);
  const reelId = els.clipReel.value;
  const altGroup = els.clipAlt.value.trim();
  const condition = els.clipCondition.value;
  const note = els.clipNote.value.trim();

  const errors = [];
  if (!code) errors.push("片段编号不能为空");
  if (!Number.isInteger(duration) || duration <= 0) errors.push("片长必须是正整数（分钟）");
  if (!reelId) errors.push("请先创建并选择胶片卷");

  // 编号在片库中也保持唯一（忽略大小写），便于场次校验语义清晰
  const dup = doc.clips.find(
    (c) => c.code.trim().toLowerCase() === code.toLowerCase() && c.id !== ui.editingClipId);
  if (dup) errors.push(`编号与片库已有片段 ${dup.code} 重复（忽略大小写）`);

  els.clipDuration.classList.toggle("invalid", !Number.isInteger(duration) || duration <= 0);
  els.clipCode.classList.toggle("invalid", !code || !!dup);
  if (errors.length) {
    els.clipFormHint.textContent = "无法保存：" + errors.join("；");
    els.clipFormHint.className = "form-hint error";
    return;
  }

  if (ui.editingClipId) {
    const id = ui.editingClipId;
    const old = clipById(id);
    commit(`编辑片段 ${old.code}`, () => {
      Object.assign(old, { code, duration, reelId, altGroup, condition, note });
    });
    toast(`片段 ${code} 已更新，所有场次同步重算`, "ok");
    resetClipForm();
  } else {
    commit(`新增片段 ${code}`, () => {
      doc.clips.push({ id: uid(), code, duration, reelId, altGroup, condition, note });
    });
    toast(`片段 ${code} 已加入片库`, "ok");
    els.clipForm.reset();
    els.clipDuration.value = 10;
  }
  renderAll();
}

function deleteClip(id) {
  const clip = clipById(id);
  if (!clip) return;
  const used = doc.sessions.reduce(
    (n, s) => n + s.entries.filter((e) => e.clipId === id || e.altClipId === id).length, 0);
  if (!window.confirm(`删除片段 ${clip.code}？${used ? `\n它被 ${used} 个场次条目引用，删除后这些条目会报“缺失片段”阻断。` : ""}\n该操作可撤销。`)) return;
  commit(`删除片段 ${clip.code}`, () => {
    doc.clips = doc.clips.filter((c) => c.id !== id);
  });
  if (ui.editingClipId === id) resetClipForm();
  renderAll();
}

/* ============================================================
 * 导出
 * ============================================================ */

function buildExportText() {
  const { timelines } = lastValidation;
  const lines = [];
  lines.push("══════════════════════════════════════════");
  lines.push("           胶片放映排期表（离线导出）");
  lines.push(`           生成时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push("══════════════════════════════════════════");
  lines.push("");

  const sorted = doc.sessions.slice().sort((a, b) => {
    const da = parseDate(a.date), db = parseDate(b.date);
    return (da - db) || (parseTime(a.startTime) - parseTime(b.startTime));
  });

  for (const s of sorted) {
    const tl = timelines.get(s.id);
    lines.push(`【${s.name}】`);
    lines.push(`  日期/开场：${s.date} ${s.startTime}` + (tl.endsNextDay ? "（散场跨午夜）" : ""));
    lines.push(`  放映室：${roomById(s.roomId)?.name || "（未指定）"}`);
    lines.push(`  散场：${Number.isFinite(tl.endAbs) ? fmtClock(tl.endAbs % 1440, Math.floor(tl.endAbs / 1440) - (tl.day ?? 0)) : "--"}　正片 ${fmtDuration(tl.totalFilm)}　换卷缓冲 ${tl.totalGap} 分钟　总占用 ${Number.isFinite(tl.running) ? fmtDuration(tl.running) : "--"}`);
    lines.push("  节目单：");
    tl.rows.forEach((row) => {
      const startText = Number.isFinite(row.start)
        ? fmtClock(row.start % 1440, Math.floor(row.start / 1440) - (tl.day ?? 0)) : "--:--";
      const endText = Number.isFinite(row.end)
        ? fmtClock(row.end % 1440, Math.floor(row.end / 1440) - (tl.day ?? 0)) : "--:--";
      const gap = row.gapBefore > 0 ? `\n      ↑ 换卷缓冲 ${row.gapBefore} 分钟` : "";
      const c = row.clip;
      lines.push(
        `    ${row.idx + 1}. ${c ? c.code : "（缺失片段）"}  ${startText}–${endText}  ${c ? c.duration + "分" : ""}` +
        `  卷：${c ? reelById(c.reelId)?.name || "?" : "?"}  状态：${c ? c.condition : "?"}${c && c.altGroup ? "  替代组：" + c.altGroup : ""}${gap}`
      );
    });
    lines.push("");
  }

  lines.push("──────────────────────────────────────────");
  lines.push("破损风险提示（不阻断放映，供映前检查）：");
  if (!lastValidation.risks.length) lines.push("  无");
  lastValidation.risks.forEach((r) => lines.push(`  · ${r.title} —— ${r.desc}`));

  return lines.join("\n");
}

function doExport() {
  const nBlock = lastValidation.blockers.length + lastValidation.conflicts.length;
  if (nBlock) {
    els.exportHint.textContent = `导出被阻止：仍有 ${lastValidation.blockers.length} 个阻断项、${lastValidation.conflicts.length} 个冲突，请在上方列表逐项点击定位解决。`;
    els.exportHint.className = "form-hint error";
    toast("导出被阻止，请先解决所有阻断项与冲突", "error");
    return;
  }
  const text = buildExportText();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `胶片放映排期表-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  els.exportHint.textContent = `已导出 ${doc.sessions.length} 场排期。`;
  els.exportHint.className = "form-hint ok";
  toast("排期表已导出", "ok");
}

/* ============================================================
 * Toast
 * ============================================================ */

let toastTimer = null;
function toast(msg, type = "") {
  els.toast.textContent = msg;
  els.toast.className = "toast " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

/* ============================================================
 * 事件绑定
 * ============================================================ */

// 片库标签页
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    ui.libTab = tab.dataset.libTab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll("[data-lib-pane]").forEach(
      (p) => p.classList.toggle("hidden", p.dataset.libPane !== ui.libTab));
  }));

// 片库表单
els.clipForm.addEventListener("submit", clipFormSubmit);
els.clipFormReset.addEventListener("click", resetClipForm);
els.clipSearch.addEventListener("input", (e) => { ui.clipSearch = e.target.value; renderLibrary(); });

els.clipList.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-clip-edit]");
  const del = e.target.closest("[data-clip-delete]");
  if (edit) { fillClipForm(clipById(edit.dataset.clipEdit)); }
  if (del) { deleteClip(del.dataset.clipDelete); }
});

// 卷 / 厅增删
els.reelForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = els.reelName.value.trim();
  if (!name) return;
  if (doc.reels.some((r) => r.name === name)) { toast("已存在同名胶片卷", "error"); return; }
  commit(`新增胶片卷「${name}」`, () => doc.reels.push({ id: uid(), name }));
  els.reelForm.reset();
  renderAll();
});
els.reelList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-reel-delete]");
  if (!btn) return;
  const reel = reelById(btn.dataset.reelDelete);
  const nClips = doc.clips.filter((c) => c.reelId === reel.id).length;
  if (nClips) { toast(`该卷下还有 ${nClips} 个片段，请先移走或删除片段`, "error"); return; }
  if (!window.confirm(`删除胶片卷「${reel.name}」？可撤销。`)) return;
  commit(`删除胶片卷「${reel.name}」`, () => { doc.reels = doc.reels.filter((r) => r.id !== reel.id); });
  renderAll();
});
els.roomForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = els.roomName.value.trim();
  if (!name) return;
  if (doc.rooms.some((r) => r.name === name)) { toast("已存在同名放映室", "error"); return; }
  commit(`新增放映室「${name}」`, () => doc.rooms.push({ id: uid(), name }));
  els.roomForm.reset();
  renderAll();
});
els.roomList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-room-delete]");
  if (!btn) return;
  const room = roomById(btn.dataset.roomDelete);
  const n = doc.sessions.filter((s) => s.roomId === room.id).length;
  if (n) { toast(`该放映室还有 ${n} 场排期，请先移除或改厅`, "error"); return; }
  if (!window.confirm(`删除放映室「${room.name}」？可撤销。`)) return;
  commit(`删除放映室「${room.name}」`, () => { doc.rooms = doc.rooms.filter((r) => r.id !== room.id); });
  renderAll();
});
els.gapSetting.addEventListener("change", (e) => {
  const v = Number(e.target.value);
  if (!Number.isInteger(v) || v < 0) { toast("默认换卷间隔必须是不小于 0 的整数", "error"); e.target.value = doc.settings.defaultGap; return; }
  commit(`修改默认换卷间隔为 ${v} 分钟`, () => { doc.settings.defaultGap = v; });
  renderAll();
});

// 场次标签
els.sessionTabs.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-session-tab]");
  if (tab) switchSession(tab.dataset.sessionTab);
});
els.newSessionBtn.addEventListener("click", () => createSession());
els.copySessionBtn.addEventListener("click", duplicateCurrentSession);
els.removeSessionBtn.addEventListener("click", removeCurrentSession);

// 场次元数据 -> 草稿
els.sessionName.addEventListener("input", () => mutateDraft(ui.activeSessionId, (d) => { d.name = els.sessionName.value; }));
els.sessionDate.addEventListener("change", () => mutateDraft(ui.activeSessionId, (d) => { d.date = els.sessionDate.value; }));
els.sessionTime.addEventListener("change", () => mutateDraft(ui.activeSessionId, (d) => { d.startTime = els.sessionTime.value; }));
els.sessionRoom.addEventListener("change", () => mutateDraft(ui.activeSessionId, (d) => { d.roomId = els.sessionRoom.value; }));
els.sessionGap.addEventListener("input", () => mutateDraft(ui.activeSessionId, (d) => { d.gap = Number(els.sessionGap.value); }));

// 条目操作（全部走草稿；若草稿不存在（如顺序调整）自动创建）
els.entryList.addEventListener("click", (e) => {
  const id = ui.activeSessionId;
  const up = e.target.closest("[data-entry-up]");
  const down = e.target.closest("[data-entry-down]");
  const del = e.target.closest("[data-entry-del]");
  if (up) {
    mutateDraft(id, (d) => {
      const i = d.entries.findIndex((x) => x.id === up.dataset.entryUp);
      if (i > 0) [d.entries[i - 1], d.entries[i]] = [d.entries[i], d.entries[i - 1]];
    });
  } else if (down) {
    mutateDraft(id, (d) => {
      const i = d.entries.findIndex((x) => x.id === down.dataset.entryDown);
      if (i >= 0 && i < d.entries.length - 1) [d.entries[i + 1], d.entries[i]] = [d.entries[i], d.entries[i + 1]];
    });
  } else if (del) {
    mutateDraft(id, (d) => { d.entries = d.entries.filter((x) => x.id !== del.dataset.entryDel); });
  }
});

// 替代片段下拉（change 事件）
els.entryList.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-alt-select]");
  if (!sel) return;
  const id = ui.activeSessionId;
  mutateDraft(id, (d) => {
    const entry = d.entries.find((x) => x.id === sel.dataset.altSelect);
    if (entry) entry.altClipId = sel.value || null;
  });
});

els.addEntryBtn.addEventListener("click", () => {
  const clipId = els.addClipSelect.value;
  if (!clipId) return;
  mutateDraft(ui.activeSessionId, (d) => { d.entries.push({ id: uid(), clipId, altClipId: null }); });
});

// 拖拽换序
els.entryList.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".entry-card");
  if (!card) return;
  draggedEntryId = card.dataset.entryId;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
});
els.entryList.addEventListener("dragend", () => {
  document.querySelectorAll(".entry-card").forEach((c) => c.classList.remove("dragging", "drag-over"));
  draggedEntryId = null;
});
els.entryList.addEventListener("dragover", (e) => {
  const card = e.target.closest(".entry-card");
  if (!card || !draggedEntryId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  card.classList.add("drag-over");
});
els.entryList.addEventListener("dragleave", (e) => {
  const card = e.target.closest(".entry-card");
  if (card) card.classList.remove("drag-over");
});
els.entryList.addEventListener("drop", (e) => {
  const card = e.target.closest(".entry-card");
  if (!card || !draggedEntryId || card.dataset.entryId === draggedEntryId) return;
  e.preventDefault();
  const targetId = card.dataset.entryId;
  mutateDraft(ui.activeSessionId, (d) => {
    const from = d.entries.findIndex((x) => x.id === draggedEntryId);
    const to = d.entries.findIndex((x) => x.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = d.entries.splice(from, 1);
    d.entries.splice(to, 0, moved);
  });
});

// 保存 / 还原
els.saveSessionBtn.addEventListener("click", saveDraft);
els.revertSessionBtn.addEventListener("click", revertDraft);

// 右侧问题：点击定位
function locateIssue(li) {
  let sid = li.dataset.issueSession;
  // 冲突类问题：若已在其中一场，则跳到另一场
  if (li.dataset.issueOther && (sid === ui.activeSessionId)) {
    sid = li.dataset.issueOther;
  }
  if (sid !== ui.activeSessionId) {
    delete ui.drafts[ui.activeSessionId]; // 定位时放弃当前草稿，避免干扰
    ui.activeSessionId = sid;
    renderAll();
  }
  const entryId = li.dataset.issueEntry;
  if (entryId) {
    requestAnimationFrame(() => {
      const card = els.entryList.querySelector(`[data-entry-id="${entryId}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.animate(
          [{ boxShadow: "0 0 0 0 rgba(216,162,74,0)" }, { boxShadow: "0 0 0 4px rgba(216,162,74,.8)" }, { boxShadow: "0 0 0 0 rgba(216,162,74,0)" }],
          { duration: 1400 });
      }
    });
  } else {
    els.sessionName.focus();
  }
}
[els.blockerList, els.conflictList, els.riskList].forEach((list) =>
  list.addEventListener("click", (e) => {
    const li = e.target.closest(".issue");
    if (li) locateIssue(li) ;
  }));

// 撤销 / 重做 / 重置 / 导出
els.undoBtn.addEventListener("click", undo);
els.redoBtn.addEventListener("click", redo);
els.resetDataBtn.addEventListener("click", () => {
  if (!window.confirm("清空全部本机数据并恢复示例数据？此操作不可撤销。")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(HIST_KEY);
  doc = makeSeed();
  history = { past: [], future: [] };
  ui = { libTab: "clips", activeSessionId: doc.selectedSessionId, pendingSession: null, drafts: {}, clipSearch: "", editingClipId: null };
  persist();
  renderAll();
  toast("已恢复示例数据");
});
els.exportBtn.addEventListener("click", doExport);

// 快捷键
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
  else if (k === "s") { e.preventDefault(); saveDraft(); }
});

// 离开页面前提醒未保存草稿或未登记场次（未登记场次刷新即消失）
window.addEventListener("beforeunload", (e) => {
  if (Object.keys(ui.drafts).length || ui.pendingSession) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------------- 启动 ---------------- */

const hadStoredDoc = !!localStorage.getItem(STORAGE_KEY);
doc = loadDoc();
if (!hadStoredDoc) persist(); // 首次打开：把内置示例作为正式数据落盘，保证刷新恢复
ui.activeSessionId = doc.selectedSessionId && sessionById(doc.selectedSessionId)
  ? doc.selectedSessionId
  : doc.sessions[0]?.id ?? null;
renderAll();

// 暴露给浏览器自动化测试
window.__desk = {
  get doc() { return doc; },
  get ui() { return ui; },
  validate: validateAll,
  computeTimeline,
  renderAll,
  commit,
  undo,
  redo,
  reset: () => { localStorage.removeItem(STORAGE_KEY); location.reload(); }
};

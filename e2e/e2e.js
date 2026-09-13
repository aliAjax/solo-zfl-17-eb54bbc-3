/* 真实 Chromium 端到端走查：
 * 1 初始数据  2 复制场次  3 跨场冲突（同厅/同卷，定位+换厅解决）
 * 4 实时统计（按钮+拖拽换序、缓冲）  5 替代片段（跨场消卷冲突）
 * 6 异常时间（非法时间、跨午夜）  7 正整数/重复编号校验
 * 8 撤销/重做（含刷新后历史恢复）  9 刷新完整恢复
 * 10 阻断项定位  11 导出（阻断时禁用+成功导出内容） */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const APP = "file:///workspace/index.html";
const SHOT_DIR = "/tmp/pwtest/shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

async function freshPage(browser) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  page.__errors = errors;
  // 所有 confirm 自动确认
  await page.addInitScript(() => {
    window.confirm = () => true;
    window.alert = () => {};
  });
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector(".session-tab");
  page.__ctx = ctx;
  return page;
}

// 用合成拖拽事件兜底 HTML5 DnD（headless 下 mouse DnD 对 draggable 不稳定）
async function syntheticDrag(page, fromSel, toSel) {
  const ok = await page.evaluate(([fs, ts]) => {
    const from = document.querySelector(fs), to = document.querySelector(ts);
    if (!from || !to) return false;
    let dt = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
    from.dispatchEvent(new DragEvent("dragstart", opts));
    to.dispatchEvent(new DragEvent("dragover", opts));
    to.dispatchEvent(new DropEvent("drop", opts));
    from.dispatchEvent(new DragEvent("dragend", opts));
    return true;
  }, [fromSel, toSel]);
  return ok;
}
// DropEvent 在 Chromium 中可用；兜底构造
async function setupDropEvent(page) {
  await page.evaluate(() => {
    if (typeof window.DropEvent !== "function") {
      window.DropEvent = function (type, init) {
        const e = new DragEvent(type, init);
        return e;
      };
    }
  });
}

async function currentMetrics(page) {
  return await page.evaluate(() => {
    const text = document.querySelector("#timelineSummary").innerText;
    return text.replace(/\n/g, " ");
  });
}

async function entryCodes(page) {
  return await page.$$eval(".entry-card .entry-code", (els) =>
    els.map((e) => e.textContent.replace(/^\d+\.\s*/, "").trim()));
}

async function count(loc) { return await loc.count(); }

// Playwright 的 selectOption 不接受正则，按选项文本包含匹配来选
async function selectByText(page, selector, re) {
  const value = await page.evaluate(([sel, src]) => {
    const selEl = document.querySelector(sel);
    const re = new RegExp(src);
    const opt = [...selEl.options].find((o) => re.test(o.textContent));
    if (!opt) return null;
    selEl.value = opt.value;
    selEl.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.value;
  }, [selector, re.source]);
  if (value === null) throw new Error(`selectByText: 未找到匹配 ${re} 的选项`);
  return value;
}

(async () => {
  const browser = await chromium.launch();

  // ========== 1. 初始数据 ==========
  console.log("\n[1] 初始加载");
  let page = await freshPage(browser);
  await setupDropEvent(page);
  check("2 个示例场次", (await page.locator(".session-tab").count()) === 2);
  check("8 个片库片段", (await page.locator(".clip-item").count()) === 8);
  check("初始无阻断", (await page.locator("#blockerCount").textContent()) === "0");
  check("初始无冲突", (await page.locator("#conflictCount").textContent()) === "0");
  check("破损风险 ≥ 2（C-005 高风险、B-014 接片松动）",
    Number(await page.locator("#riskCount").textContent()) >= 2);
  check("导出按钮可用", await page.locator("#exportBtn").isEnabled());
  check("撤销按钮初始禁用", await page.locator("#undoBtn").isDisabled());
  let m = await currentMetrics(page);
  check("早场正片 80 分钟", m.includes("正片总时长") && /1\s*小时\s*20\s*分/.test(m), m);
  check("换卷缓冲 2 次共 10 分钟", /换卷缓冲\s*2 次 \/ 共 10 分钟/.test(m), m);
  check("总占用 90 分钟（80 正片 + 10 缓冲）", /占用总时长\s*1\s*小时\s*30\s*分/.test(m), m);
  check("页面无 JS 错误", page.__errors.length === 0, JSON.stringify(page.__errors));

  // ========== 2. 复制场次（未保存的 pending，不进正式数据） ==========
  console.log("\n[2] 复制场次：停留在未保存状态");
  await page.click("#copySessionBtn");
  check("标签变为 3 个（含未保存副本）", (await page.locator(".session-tab").count()) === 3);
  check("新副本处于激活状态",
    (await page.locator(".session-tab.active").innerText()).includes("副本"));
  check("副本标签带“未保存”标记",
    (await page.locator(".session-tab.active").innerText()).includes("未保存"));
  check("副本同厅+顺延 30 分钟（开始 09:30）",
    await page.locator("#sessionTime").inputValue() === "09:30");
  check("日期仍为 2026-09-20", await page.locator("#sessionDate").inputValue() === "2026-09-20");
  check("副本条目完整复制（5 段）", await count(page.locator(".entry-card")) === 5);
  check("正式数据 doc.sessions 仍为 2 场（未写入）",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 2);
  check("内存中存在 pendingSession 且保留全部 5 条目",
    await page.evaluate(() => !!(window.__desk.ui.pendingSession &&
      window.__desk.ui.pendingSession.entries.length === 5)));
  check("本机存档中没有副本（仍为 2 场）",
    await page.evaluate(() => JSON.parse(localStorage.getItem("film-program-desk-v1")).sessions.length) === 2);
  check("保存按钮显示“保存副本”",
    (await page.locator("#saveSessionBtn").innerText()).includes("保存副本"));
  check("复制不进撤销栈（撤销按钮仍禁用）", await page.locator("#undoBtn").isDisabled());

  // ========== 3. 跨场冲突：同厅 + 同卷（未保存副本同样参与校验且无法保存） ==========
  console.log("\n[3] 跨场冲突：同厅 + 同卷（阻断副本入档）");
  await page.waitForTimeout(50);
  let conflictText = await page.locator("#conflictList").innerText();
  const nConf = Number(await page.locator("#conflictCount").textContent());
  check("冲突数 ≥ 2（同厅 + 同卷）", nConf >= 2, `实际 ${nConf}`);
  check("包含放映室冲突", conflictText.includes("放映室冲突"));
  check("包含胶片卷冲突（原版A卷）", conflictText.includes("胶片卷冲突") && conflictText.includes("原版A卷"));
  // 编辑 pending（换卷间隔），有冲突时保存仍被拒
  await page.fill("#sessionGap", "6");
  await page.waitForTimeout(50);
  check("有冲突时保存被拒绝（未写入存档）",
    (await page.locator("#sessionSaveHint").innerText()).includes("未写入存档") &&
    (await page.locator("#sessionSaveHint").innerText()).includes("冲突"));
  await page.fill("#sessionGap", "5");
  check("有冲突时导出按钮禁用", await page.locator("#exportBtn").isDisabled());

  // 时间轴仍实时计算：副本 09:30 开始
  m = await currentMetrics(page);
  check("副本总占用仍为 90 分钟（实时显示）", /占用总时长\s*1\s*小时\s*30\s*分/.test(m), m);

  // 冲突项点击定位：点击同厅冲突，应在原场与副本之间跳转
  const roomConflict = page.locator(".issue.conflict", { hasText: "放映室冲突" }).first();
  await roomConflict.click();
  await page.waitForTimeout(50);
  check("点击冲突定位切换到了原早场",
    (await page.locator(".session-tab.active").innerText()).includes("早场") &&
    !(await page.locator(".session-tab.active").innerText()).includes("副本"));
  // 再点一次（回到副本）
  await page.locator(".issue.conflict", { hasText: "放映室冲突" }).first().click();
  await page.waitForTimeout(50);
  check("再次点击回到副本",
    (await page.locator(".session-tab.active").innerText()).includes("副本"));

  // 解决：把副本换到二号厅（同卷冲突仍在，因为同卷跨厅也冲突）
  await page.selectOption("#sessionRoom", { label: "二号厅" });
  await page.waitForTimeout(50);
  conflictText = await page.locator("#conflictList").innerText();
  check("换厅后放映室冲突消失", !conflictText.includes("放映室冲突"), conflictText.slice(0, 80));
  check("同卷冲突依然存在（胶片卷不能同时在两处放）", conflictText.includes("胶片卷冲突"));
  check("仍不能保存", (await page.locator("#sessionSaveHint").innerText()).includes("未写入存档"));
  check("换厅编辑仍未落库（正式数据 2 场）",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 2);

  // 改回一号厅
  await page.selectOption("#sessionRoom", { label: "一号厅" });

  // ========== 4. 实时统计：按钮与拖拽换序、缓冲（均发生在未保存副本上） ==========
  console.log("\n[4] 换序实时统计（按钮 + 拖拽）");
  // 副本当前顺序 A-001 A-002 A-003 B-014 D-002
  let codes = await entryCodes(page);
  check("初始顺序正确", codes.join(",") === "A-001,A-002,A-003,B-014,D-002", codes.join(","));

  // 按钮：把 B-014（第4段）上移到第3段
  const b014Card = page.locator(".entry-card", { hasText: "B-014" });
  await b014Card.locator("[data-entry-up]").click();
  codes = await entryCodes(page);
  check("↑ 按钮换序生效", codes.join(",") === "A-001,A-002,B-014,A-003,D-002", codes.join(","));
  m = await currentMetrics(page);
  // 新顺序：A-001,A-002 同卷(无间隔), B-014 换卷+5, A-003 换卷+5, D-002 换卷+5 => 3 次 15 分
  check("换序后缓冲实时变为 3 次共 15 分", /换卷缓冲\s*3 次 \/ 共 15 分钟/.test(m), m);
  check("正片总时长不变 80 分", /正片总时长\s*1\s*小时\s*20\s*分/.test(m), m);
  check("总占用变为 95 分", /占用总时长\s*1\s*小时\s*35\s*分/.test(m), m);

  // 拖拽：把 D-002（最后一张）拖到第 2 段（A-002）位置
  const dragged = await syntheticDrag(page,
    ".entry-card:nth-child(5)", ".entry-card:nth-child(2)");
  check("合成拖拽事件派发成功", dragged);
  codes = await entryCodes(page);
  // 顺序应为 A-001,D-002,A-002,B-014,A-003
  check("拖拽后顺序 A-001,D-002,A-002,B-014,A-003",
    codes.join(",") === "A-001,D-002,A-002,B-014,A-003", codes.join(","));
  m = await currentMetrics(page);
  // 换卷点：D(短片D卷), A(原版A), B(修复B), A(原版A) = 4 次 20 分
  check("拖拽后缓冲实时变为 4 次共 20 分", /换卷缓冲\s*4 次 \/ 共 20 分钟/.test(m), m);
  check("散场 11:10（09:30 + 100 分钟）", /散场\s*11:10(?!\S)/.test(m), m);

  // 还原：放弃未保存副本，应直接消失、不入正式数据、无撤销栈痕迹
  await page.click("#revertSessionBtn");
  check("还原后副本标签消失（剩 2 场）", (await page.locator(".session-tab").count()) === 2);
  check("还原后 pending 已清空",
    await page.evaluate(() => window.__desk.ui.pendingSession === null));
  check("还原后活动场次回到早场",
    (await page.locator(".session-tab.active").innerText()).includes("早场"));
  check("还原后冲突归零", (await page.locator("#conflictCount").textContent()) === "0");
  check("撤销按钮仍禁用（放弃副本不是一步历史操作）",
    await page.locator("#undoBtn").isDisabled());
  check("本机存档仍为 2 场",
    await page.evaluate(() => JSON.parse(localStorage.getItem("film-program-desk-v1")).sessions.length) === 2);

  // 再复制一次，并演示“移除”也只是丢弃未保存副本
  await page.click("#copySessionBtn");
  check("再次复制出现未保存副本", (await page.locator(".session-tab").count()) === 3);
  await page.click("#removeSessionBtn");
  check("移除未保存副本 → 剩 2 场", (await page.locator(".session-tab").count()) === 2);
  check("移除未保存副本不进撤销栈（撤销按钮仍禁用）",
    await page.locator("#undoBtn").isDisabled());
  check("本机存档仍为 2 场",
    await page.evaluate(() => JSON.parse(localStorage.getItem("film-program-desk-v1")).sessions.length) === 2);

  // ========== 5. 替代片段（未保存新场次：跨场消除同卷冲突后保存入档） ==========
  console.log("\n[5] 替代片段（未保存新场次，保存后才入档）");
  // 新建一场（pending）：2026-09-20 09:00 二号厅，只放 A-001
  await page.click("#newSessionBtn");
  check("新建后为未保存标签",
    (await page.locator(".session-tab.active").innerText()).includes("未保存"));
  check("新建未入正式数据（仍 2 场）",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 2);
  await page.fill("#sessionName", "替代测试场");
  await page.fill("#sessionDate", "2026-09-20");
  await page.fill("#sessionTime", "09:00");
  await page.selectOption("#sessionRoom", { label: "二号厅" });
  await selectByText(page, "#addClipSelect", /A-001/);
  await page.click("#addEntryBtn");
  await page.waitForTimeout(50);
  let conf2 = await page.locator("#conflictList").innerText();
  check("不同厅同卷同时间 → 胶片卷冲突", conf2.includes("胶片卷冲突"), conf2.slice(0, 100));
  check("保存被拒（同卷冲突，未写入存档）",
    (await page.locator("#sessionSaveHint").innerText()).includes("未写入存档"));

  // 条目上出现替代选择器（A-001 属 G-开场，可替成 B-009）
  const altSelect = page.locator(".entry-card select[data-alt-select]");
  check("A-001 显示替代片段下拉", await altSelect.count() === 1);
  const altOptions = await altSelect.locator("option").allInnerTexts();
  check("下拉包含 B-009", altOptions.some((t) => t.includes("B-009")), JSON.stringify(altOptions));
  await selectByText(page, ".entry-card select[data-alt-select]", /B-009/);
  await page.waitForTimeout(50);
  conf2 = await page.locator("#conflictList").innerText();
  check("换成 B-009 后同卷冲突消失", !conf2.includes("胶片卷冲突"), conf2.slice(0, 100));
  check("冲突数为 0", (await page.locator("#conflictCount").textContent()) === "0");
  // 时间实时变化：B-009 也是 12 分，09:00–09:12
  const timeText = await page.locator(".entry-card .entry-time").innerText();
  check("替代后条目时间正常（09:00 → 09:12）", timeText.includes("09:00") && timeText.includes("09:12"), timeText);
  // 卡片显示替代来源信息（下拉文案）
  check("下拉标注“使用原片段 A-001”可切回",
    altOptions.some((t) => t.includes("使用原片段 A-001")));

  // 保存
  await page.click("#saveSessionBtn");
  await page.waitForTimeout(50);
  check("替代场保存成功（提示已保存）",
    (await page.locator("#sessionSaveHint").innerText()).includes("已保存"));
  const dirtyAfterSave = await page.locator(".session-tab.active")
    .evaluate((e) => e.classList.contains("dirty"));
  check("脏标记消失", dirtyAfterSave === false);
  // 持久化检查
  const savedAlt = await page.evaluate(() => {
    const s = window.__desk.doc.sessions.find((x) => x.name === "替代测试场");
    const altId = s.entries[0].altClipId;
    return window.__desk.doc.clips.find((c) => c.id === altId)?.code;
  });
  check("正式数据中条目指向替代片段 B-009", savedAlt === "B-009", savedAlt);

  // ========== 6. 异常时间 ==========
  console.log("\n[6] 异常时间：非法输入与跨午夜");
  // 6a. 非法开始时间：直接把草稿时间改坏（type=time 在浏览器里无法输入非法字符，
  //     这里模拟粘贴/脚本写入非法值，这也是真实中可能被外部数据写入的情形）
  await page.evaluate(() => {
    const el = document.querySelector("#sessionTime");
    el.value = "25:00";
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(50);
  let blockText = await page.locator("#blockerList").innerText();
  check("25:00 被判为阻断（开始时间无效）", blockText.includes("开始时间无效"), blockText.slice(0, 100));
  check("非法时间保存按钮拒绝",
    (await page.locator("#sessionSaveHint").innerText()).includes("不能保存"));
  check("非法时间时导出禁用", await page.locator("#exportBtn").isDisabled());
  check("时间轴显示 --:--", (await currentMetrics(page)).includes("--:--"));

  // 点击该阻断项，定位到替代测试场并聚焦名称框
  await page.locator(".issue.blocker", { hasText: "开始时间无效" }).first().click();
  await page.waitForTimeout(50);
  check("阻断项点击后仍定位在该场次",
    (await page.locator(".session-tab.active").innerText()).includes("替代测试场"));

  // 恢复合法时间并保存
  await page.fill("#sessionTime", "09:00");
  await page.waitForTimeout(50);
  check("改回 09:00 后阻断消失",
    !(await page.locator("#blockerList").innerText()).includes("开始时间无效"));
  await page.click("#saveSessionBtn");

  // 6b. 跨午夜：新建 23:30 场次，一号厅，A-001 + D-002（12 + 5缓冲 + 22 = 39 分 → 次日 00:09）
  await page.click("#newSessionBtn");
  await page.fill("#sessionName", "午夜场");
  await page.fill("#sessionDate", "2026-09-20");
  await page.fill("#sessionTime", "23:30");
  await page.selectOption("#sessionRoom", { label: "一号厅" });
  await selectByText(page, "#addClipSelect", /A-001/);
  await page.click("#addEntryBtn");
  await selectByText(page, "#addClipSelect", /D-002/);
  await page.click("#addEntryBtn");
  await page.waitForTimeout(50);
  m = await currentMetrics(page);
  check("跨午夜场显示“跨午夜”", m.includes("跨午夜"), m);
  const entryTimes = await page.$$eval(".entry-card .entry-time", (els) => els.map((e) => e.textContent));
  check("第 1 段 23:30→23:42", entryTimes[0].includes("23:30") && entryTimes[0].includes("23:42"), JSON.stringify(entryTimes));
  check("第 2 段 23:47→00:09 (+1天)",
    entryTimes[1].includes("23:47") && entryTimes[1].includes("00:09") && entryTimes[1].includes("+1"),
    JSON.stringify(entryTimes));
  // 午夜场与早场不同日，不应有同厅冲突
  const conf3 = await page.locator("#conflictCount").textContent();
  check("跨午夜与当日早场无同厅冲突", conf3 === "0", conf3);
  await page.click("#saveSessionBtn");
  await page.waitForTimeout(50);
  check("跨午夜场可正常保存",
    (await page.locator("#sessionSaveHint").innerText()).includes("已保存"));

  // ========== 7. 片长正整数 / 编号忽略大小写重复 ==========
  console.log("\n[7] 片长与编号校验");
  // 7a. 片库新增：0 与小数都应被拒
  await page.fill("#clipCode", "X-001");
  await page.fill("#clipDuration", "0");
  await page.selectOption("#clipReel", { label: "原版A卷" });
  await page.click(".stack-form button[type=submit]");
  check("片长 0 被拒", (await page.locator("#clipFormHint").innerText()).includes("正整数"));
  check("片库仍是 8 个片段", await count(page.locator(".clip-item")) === 8);
  await page.fill("#clipDuration", "12.5");
  await page.click(".stack-form button[type=submit]");
  check("片长 12.5 被拒", (await page.locator("#clipFormHint").innerText()).includes("正整数"));
  await page.fill("#clipDuration", "-3");
  await page.fill("#clipCode", "X-002");
  await page.click(".stack-form button[type=submit]");
  check("片长 -3 被拒", (await page.locator("#clipFormHint").innerText()).includes("正整数"));

  // 7b. 编号忽略大小写重复（片库层面）
  await page.fill("#clipCode", "a-001");
  await page.fill("#clipDuration", "10");
  await page.click(".stack-form button[type=submit]");
  check("编号 a-001 被判与 A-001 重复",
    (await page.locator("#clipFormHint").innerText()).includes("重复"));
  // 合法新增
  await page.fill("#clipCode", "X-100");
  await page.fill("#clipDuration", "7");
  await page.fill("#clipAlt", "G-开场"); // 加入同一替代组，验证替代选择联动
  await page.click(".stack-form button[type=submit]");
  check("合法片段 X-100 可新增（片库 9 个）",
    await count(page.locator(".clip-item")) === 9,
    await page.locator("#clipFormHint").innerText());

  // 7c. 场次内编号重复（忽略大小写）：午夜场加 A-001，再通过草稿 API 把编号替换成重复不可行，
  //     改为直接把同一片段加两次 —— 第二次应在该场形成编号重复阻断
  // 午夜场已有 A-001；再加一次
  await selectByText(page, "#addClipSelect", /A-001/);
  await page.click("#addEntryBtn");
  await page.waitForTimeout(50);
  let dupText = await page.locator("#blockerList").innerText();
  check("场内第二次使用 A-001 → 编号重复阻断", dupText.includes("编号与第 1 段重复"));
  const dupCard = page.locator(".entry-card.has-error").last();
  check("重复条目卡片标红并显示错误",
    (await dupCard.locator(".entry-errors").innerText()).includes("重复"));
  // 删除重复条目，恢复干净
  await dupCard.locator("[data-entry-del]").click();
  await page.waitForTimeout(50);
  check("删除后编号重复阻断消失",
    !(await page.locator("#blockerList").innerText()).includes("编号与第 1 段重复"));

  // 清理午夜场与替代测试场（通过 UI 移除，两次，走撤销栈但后续重置数据）
  // 先保存午夜场当前干净草稿
  await page.click("#saveSessionBtn");
  await page.waitForTimeout(50);

  // ========== 8. 撤销 / 重做 ==========
  console.log("\n[8] 撤销/重做");
  // 删除片库 X-100（没有场次引用它）
  await page.locator(".clip-item", { hasText: "X-100" }).locator("[data-clip-delete]").click();
  await page.waitForTimeout(50);
  check("X-100 删除后片库 8 个", await count(page.locator(".clip-item")) === 8);
  await page.click("#undoBtn");
  check("撤销删除 → X-100 回来（9 个）", await count(page.locator(".clip-item")) === 9);
  check("撤销按钮 title 记录了操作名",
    (await page.locator("#redoBtn").getAttribute("title")).includes("X-100"));
  await page.click("#redoBtn");
  check("重做 → X-100 再次删除（8 个）", await count(page.locator(".clip-item")) === 8);

  // Ctrl+Z / Ctrl+Y 快捷键
  await page.keyboard.press("Control+z");
  check("Ctrl+Z 撤销生效（9 个）", await count(page.locator(".clip-item")) === 9);
  await page.keyboard.press("Control+y");
  check("Ctrl+Y 重做生效（8 个）", await count(page.locator(".clip-item")) === 8);

  // ========== 9. 刷新完整恢复（数据 + 撤销历史） ==========
  console.log("\n[9] 刷新恢复");
  // 当前已保存场次：早场、午后、替代测试场、午夜场 = 4
  check("刷新前共 4 场", await count(page.locator(".session-tab")) === 4);
  const beforeSnapshot = await page.evaluate(() => JSON.stringify(window.__desk.doc));
  await page.screenshot({ path: path.join(SHOT_DIR, "before-reload.png"), fullPage: true });
  await page.reload();
  await page.waitForSelector(".session-tab");
  check("刷新后仍 4 场", await count(page.locator(".session-tab")) === 4);
  const afterSnapshot = await page.evaluate(() => JSON.stringify(window.__desk.doc));
  check("刷新前后正式数据完全一致", beforeSnapshot === afterSnapshot);
  check("午夜场仍在", await page.locator(".session-tab", { hasText: "午夜场" }).count() === 1);
  check("替代测试场使用 B-009 替代被保留",
    await page.evaluate(() => {
      const s = window.__desk.doc.sessions.find((x) => x.name === "替代测试场");
      const c = window.__desk.doc.clips.find((x) => x.id === s.entries[0].altClipId);
      return c?.code === "B-009";
    }));
  // 撤销历史也恢复：最近一次重做栈顶是“删除 X-100”后的状态，Ctrl+Z 应恢复 X-100
  check("刷新后撤销按钮仍可用（历史已恢复）", await page.locator("#undoBtn").isEnabled());
  await page.keyboard.press("Control+z");
  check("刷新后仍可撤销删除（X-100 恢复，9 个）",
    await count(page.locator(".clip-item")) === 9);
  // 再撤销一步：午夜场保存被撤销，但场次仍在（变为草稿），数据完整
  await page.keyboard.press("Control+z");
  check("再撤销一步：午夜场保存被回滚（4 场仍在，X-100 仍 9 个）",
    await count(page.locator(".session-tab")) === 4 && await count(page.locator(".clip-item")) === 9);
  // 直接重置回干净种子，准备导出验证
  await page.click("#resetDataBtn");
  await page.waitForSelector(".session-tab");
  check("重置后恢复 2 场示例", await count(page.locator(".session-tab")) === 2);
  check("重置后撤销栈清空（按钮禁用）", await page.locator("#undoBtn").isDisabled());
  await page.screenshot({ path: path.join(SHOT_DIR, "clean-seed.png"), fullPage: true });

  // ========== 10. 阻断项定位（独立再验一次缺失片段） ==========
  console.log("\n[10] 阻断项：缺失片段定位");
  // 直接删除被早场引用的 A-001（按编号精确匹配，避免命中备注中含 A-001 的 B-009）
  const a001Item = page.locator(".clip-item", {
    has: page.locator(".clip-code", { hasText: /^A-001$/ })
  });
  check("精确定位到唯一 A-001 片段卡", await count(a001Item) === 1);
  await a001Item.locator("[data-clip-delete]").click();
  await page.waitForTimeout(50);
  const missingBlock = page.locator(".issue.blocker", { hasText: "缺失片段" }).first();
  check("删除被引用片段 → 缺失片段阻断出现", await missingBlock.count() === 1);
  check("阻断说明文字清楚（引用的片段已从片库删除）",
    (await missingBlock.innerText()).includes("已从片库删除"));
  check("导出被禁用", await page.locator("#exportBtn").isDisabled());
  await missingBlock.click();
  await page.waitForTimeout(80);
  check("点击后跳到早场并高亮缺失卡片",
    (await page.locator(".session-tab.active").innerText()).includes("早场") &&
    await page.locator(".entry-card.has-error").first().isVisible());
  // 撤销恢复
  await page.click("#undoBtn");
  await page.waitForTimeout(50);
  check("撤销后阻断消失", (await page.locator("#blockerCount").textContent()) === "0");
  check("导出恢复可用", await page.locator("#exportBtn").isEnabled());

  // ========== 11. 导出 ==========
  console.log("\n[11] 导出");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportBtn")
  ]);
  const outPath = path.join("/tmp/pwtest", download.suggestedFilename());
  await download.saveAs(outPath);
  const text = fs.readFileSync(outPath, "utf8");
  check("导出文件已生成 (.txt)", !!text && text.length > 200, `${text.length} chars`);
  check("含标题", text.includes("胶片放映排期表"));
  check("含早场与时间", text.includes("早场 · 秋日主题") && text.includes("09:00"));
  check("含每段节目行（A-001）", text.includes("A-001"));
  check("含换卷缓冲标注", text.includes("换卷缓冲 5 分钟"));
  check("含放映室（一号厅）", text.includes("一号厅"));
  check("含破损风险区（C-005 高风险）", text.includes("C-005") && text.includes("高破损风险"));
  check("导出成功提示出现", (await page.locator("#exportHint").innerText()).includes("已导出"));
  await page.screenshot({ path: path.join(SHOT_DIR, "exported.png"), fullPage: true });

  check("全程无 JS 错误", page.__errors.length === 0, JSON.stringify(page.__errors));

  // ========== 12. 复制门禁专项：同厅冲突 / 同卷冲突 / 复制后刷新 / 撤销 / 还原 / 正常复制 ==========
  console.log("\n[12] 复制门禁专项（同厅、同卷、刷新、撤销、还原、正常复制）");
  await page.__ctx.close();
  page = await freshPage(browser);
  await setupDropEvent(page);
  const persistedSessions = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("film-program-desk-v1")).sessions.length);

  // 12a. 同厅冲突：复制（顺延 30 分钟）→ 副本停留未保存，存档不被污染，强制保存被拒
  await page.click("#copySessionBtn");
  check("12 同厅冲突：副本带未保存标记",
    (await page.locator(".session-tab.active").innerText()).includes("未保存"));
  check("12 同厅冲突：检出放映室冲突",
    (await page.locator("#conflictList").innerText()).includes("放映室冲突"));
  check("12 同厅冲突：正式数据仍 2 场",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 2);
  check("12 同厅冲突：本机存档仍 2 场（未被污染）", await persistedSessions() === 2);
  await page.click("#saveSessionBtn");
  await page.waitForTimeout(40);
  check("12 同厅冲突：强制保存被拒且仍未入档",
    (await persistedSessions()) === 2 &&
    (await page.locator("#sessionSaveHint").innerText()).includes("未写入存档"));
  check("12 同厅冲突：导出按钮禁用", await page.locator("#exportBtn").isDisabled());

  // 12b. 复制后刷新：未保存副本必须消失
  await page.reload();
  await page.waitForSelector(".session-tab");
  check("12 复制后刷新：副本未残留（2 场）", await count(page.locator(".session-tab")) === 2);
  check("12 复制后刷新：存档无任何副本",
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("film-program-desk-v1")).sessions.every((s) => !s.name.includes("副本"))));
  check("12 复制后刷新：冲突归零", (await page.locator("#conflictCount").textContent()) === "0");

  // 12c. 正常复制：改到不冲突时间后保存 → 正式数据/存档/撤销栈都应有，条目完整
  await page.click("#copySessionBtn");
  await page.fill("#sessionTime", "20:00"); // 20:00–21:30，与 09:00 早场不冲突
  await page.waitForTimeout(50);
  check("12 正常复制：改时间后无冲突", (await page.locator("#conflictCount").textContent()) === "0");
  check("12 正常复制：全部 5 条目保留", await count(page.locator(".entry-card")) === 5);
  check("12 正常复制：替代片段关系仍在（A-001 条目带替代下拉）",
    await count(page.locator(".entry-card select[data-alt-select]")) >= 1);
  check("12 正常复制：时间轴正常（20:00 开场）",
    (await currentMetrics(page)).includes("20:00"));
  await page.click("#saveSessionBtn");
  await page.waitForTimeout(50);
  check("12 正常复制：保存后正式数据 3 场",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 3);
  check("12 正常复制：本机存档 3 场且含副本",
    (await persistedSessions()) === 3 &&
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("film-program-desk-v1")).sessions.some((s) => s.name.includes("副本"))));
  check("12 正常复制：副本 5 条目完整入档",
    await page.evaluate(() =>
      window.__desk.doc.sessions.find((s) => s.name.includes("副本")).entries.length) === 5);
  check("12 正常复制：未保存标记消失",
    !(await page.locator(".session-tab.active").innerText()).includes("未保存"));
  check("12 正常复制：进入撤销栈", await page.locator("#undoBtn").isEnabled());

  // 12d. 撤销 / 重做已保存的复制
  await page.click("#undoBtn");
  await page.waitForTimeout(40);
  check("12 撤销：复制被撤销，正式数据回到 2 场",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 2);
  check("12 撤销：存档同步回到 2 场", await persistedSessions() === 2);
  await page.click("#redoBtn");
  await page.waitForTimeout(40);
  check("12 重做：复制恢复为 3 场",
    await page.evaluate(() => window.__desk.doc.sessions.length) === 3);

  // 12e. 冲突副本点“还原” → 直接丢弃，不入历史
  await page.click("#copySessionBtn"); // 从早场再复制一份 09:30 冲突副本
  check("12 还原：出现第 4 个标签（未保存副本）",
    await count(page.locator(".session-tab")) === 4);
  const undoTitleBefore = await page.locator("#undoBtn").getAttribute("title");
  await page.click("#revertSessionBtn");
  await page.waitForTimeout(40);
  check("12 还原：副本丢弃（剩 3 场）", await count(page.locator(".session-tab")) === 3);
  check("12 还原：本机存档仍 3 场", await persistedSessions() === 3);
  check("12 还原：放弃副本不进撤销栈（栈顶不变）",
    (await page.locator("#undoBtn").getAttribute("title")) === undoTitleBefore);

  // 12f. 同卷冲突（跨厅）：副本换到二号厅 → 同厅消失、同卷仍在，仍不能保存
  await page.click("#copySessionBtn");
  await page.selectOption("#sessionRoom", { label: "二号厅" });
  await page.waitForTimeout(50);
  const confTxt = await page.locator("#conflictList").innerText();
  check("12 跨厅同卷：放映室冲突消失", !confTxt.includes("放映室冲突"));
  check("12 跨厅同卷：胶片卷冲突仍被检出", confTxt.includes("胶片卷冲突"));
  await page.click("#saveSessionBtn");
  await page.waitForTimeout(40);
  check("12 跨厅同卷：保存仍被拒、未入档（仍 3 场）", await persistedSessions() === 3);
  await page.click("#revertSessionBtn");
  check("12 跨厅同卷：还原后回到 3 场", await count(page.locator(".session-tab")) === 3);

  // 12g. 未保存副本期间，撤销其他操作（如片库修改）不能误杀副本，也不能让冲突副本溜进正式数据
  await page.click("#copySessionBtn"); // 09:30 冲突副本（pending）
  check("12 干扰撤销：出现未保存冲突副本",
    (await page.locator(".session-tab.active").innerText()).includes("未保存") &&
    (await page.locator("#conflictCount").textContent()) !== "0");
  // 在片库新增一个片段（产生一条独立历史）
  await page.fill("#clipCode", "T-900");
  await page.fill("#clipDuration", "8");
  await page.selectOption("#clipReel", { label: "原版A卷" });
  await page.click(".stack-form button[type=submit]");
  await page.waitForTimeout(40);
  check("12 干扰撤销：片库新增已提交（9 个片段）",
    await count(page.locator(".clip-item")) === 9);
  check("12 干扰撤销：新增期间冲突副本仍在且未入档",
    await count(page.locator(".session-tab")) === 4 && await persistedSessions() === 3);
  // 撤销片库新增
  await page.click("#undoBtn");
  await page.waitForTimeout(40);
  check("12 干扰撤销：撤销片库新增后片段回到 8 个",
    await count(page.locator(".clip-item")) === 8);
  check("12 干扰撤销：未保存副本仍在（4 个标签）",
    await count(page.locator(".session-tab")) === 4);
  check("12 干扰撤销：副本仍未写入正式数据（3 场）", await persistedSessions() === 3);
  check("12 干扰撤销：冲突仍被检出、保存仍被拒",
    (await page.locator("#conflictCount").textContent()) !== "0" &&
    await page.locator("#exportBtn").isDisabled());
  // 放弃副本，回到干净的 3 场
  await page.click("#revertSessionBtn");
  check("12 干扰撤销：还原后回到 3 场、无冲突",
    await count(page.locator(".session-tab")) === 3 &&
    (await page.locator("#conflictCount").textContent()) === "0");

  check("12 专项全程无 JS 错误", page.__errors.length === 0, JSON.stringify(page.__errors));

  await page.__ctx.close();
  await browser.close();

  console.log(`\n========== 结果：${pass} 通过，${fail} 失败 ==========`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试脚本异常：", e);
  process.exit(2);
});

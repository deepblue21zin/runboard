/* Runboard front end: runs (roster, curves, compare, config), reports, project board. No build step. */
"use strict";

// ============================================================== utils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem("runboard:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("runboard:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function fmtNum(v, d = 3) {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
  return (+v.toFixed(a >= 100 ? 1 : d)).toString();
}
function fmtDuration(s) {
  if (s == null || !isFinite(s)) return "–";
  s = Math.max(0, Math.round(s));
  if (s < 60) return s + "초";
  if (s < 3600) return Math.floor(s / 60) + "분 " + (s % 60) + "초";
  return Math.floor(s / 3600) + "시간 " + Math.floor((s % 3600) / 60) + "분";
}
function fmtAgo(t) {
  if (!t) return "–";
  const s = Date.now() / 1000 - t;
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  return new Date(t * 1000).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}
const fmtDate = (t) => (t ? new Date(t * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
let toastTimer;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// ============================================================== state & api
const MAX_SELECTED = 8;
const STATUS_KO = { running: "학습 중", finished: "완료", failed: "실패", stopped: "중단", stale: "멈춤?", unknown: "알 수 없음" };
const urlParams = new URLSearchParams(location.search);
const state = {
  config: null, project: urlParams.get("project") || store.get("project", ""),
  runs: [], byName: new Map(), folders: [], focus: urlParams.get("run") || null,
  selected: [], loadedOnce: false, query: "", statusFilter: "all", showArchived: false,
  moveSel: new Set(), folderDraft: "", folderClosed: new Set(store.get("folder-closed", [])),
  metrics: new Map(), configs: new Map(), charts: new Map(),
  view: "runs", tab: store.get("tab", "curves"), xKey: store.get("xKey", "step"), smoothing: store.get("smoothing", 0.6),
  group: "all", metricQuery: "", compareMode: "last", diffOnly: true, cfgQuery: "",
  plugins: [], board: null, boardErr: null, boardSaving: false, reports: [], report: null, editing: null,
  boardTab: store.get("board-tab", "overview"), tree: { sel: null, order: store.get("tree-order", "lineage"), archived: false, cfg: new Map(), files: new Map(),
    share: { key: true, fold: true, hideStopped: true, video: true, lang: "ko" } },
};
const withProject = (u) => u + (u.includes("?") ? "&" : "?") + "project=" + encodeURIComponent(state.project);
const runPath = (name) => name.split("/").map(encodeURIComponent).join("/");
async function getJSON(u) { const r = await fetch(withProject(u), { cache: "no-store" }); const b = await r.json(); if (!r.ok) throw new Error(b.error || r.status); return b; }
async function postJSON(u, body, method = "POST") {
  const r = await fetch(withProject(u), { method, headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
  const b = await r.json(); if (!r.ok && r.status !== 409) throw new Error(b.error || r.status); return { status: r.status, body: b };
}
const api = {
  config: () => fetch("api/config", { cache: "no-store" }).then((r) => r.json()),
  runs: () => getJSON("api/runs"),
  metrics: (n, since) => getJSON(`api/runs/${runPath(n)}/metrics?since=${since}`),
  runConfig: (n) => getJSON(`api/runs/${runPath(n)}/config`),
  files: (n) => getJSON(`api/runs/${runPath(n)}/files`),
  saveNotes: (n, notes) => postJSON(`api/runs/${runPath(n)}/notes`, notes).then((r) => r.body),
  folders: () => getJSON("api/folders").then((b) => b.folders || []),
  saveFolders: (list) => postJSON("api/folders", { folders: list }).then((r) => r.body.folders),
  board: () => getJSON("api/board"),
  saveBoard: (rev, doc) => postJSON("api/board", { rev, doc }),
  reports: () => getJSON("api/reports").then((b) => b.reports || []),
  report: (id) => getJSON("api/reports/" + encodeURIComponent(id)),
  saveReport: (id, rec) => postJSON("api/reports" + (id ? "/" + encodeURIComponent(id) : ""), rec).then((r) => r.body),
  deleteReport: (id) => postJSON("api/reports/" + encodeURIComponent(id), null, "DELETE"),
  gpus: () => fetch("api/gpus", { cache: "no-store" }).then((r) => r.json()),
  fileUrl: (run, path) => withProject("files/" + runPath(run) + "/-/" + path.split("/").map(encodeURIComponent).join("/")),
};

// plugin API: plugins call Runboard.registerTab({ id, title, render(el, ctx) })
window.Runboard = {
  registerTab(def) { if (def && def.id && def.render && !state.plugins.some((p) => p.id === def.id)) { state.plugins.push(def); renderTabs(); } },
  api, esc, fmtNum, fmtAgo, toast, get state() { return state; },
};

// ============================================================== colours
function colorOf(name) {
  const r = state.byName.get(name);
  if (r?.notes?.color) return cssVar("--s" + r.notes.color);
  const fixed = new Set(state.selected.map((n) => state.byName.get(n)?.notes?.color).filter(Boolean));
  let k = 1;
  for (const n of state.selected) {
    if (state.byName.get(n)?.notes?.color) continue;
    while (fixed.has(k) && k < 8) k++;
    if (n === name) return cssVar("--s" + k);
    k = (k % 8) + 1;
  }
  return cssVar("--muted");
}

// ============================================================== loading
async function loadConfig() {
  state.config = await api.config();
  const keys = state.config.projects.map((p) => p.key);
  if (!keys.includes(state.project)) state.project = keys[0];
  store.set("project", state.project);
  document.title = state.config.title;
  $("#title").textContent = state.config.title;
  for (const name of state.config.plugins || []) {
    const s = document.createElement("script"); s.src = "static/plugins/" + name + ".js"; document.body.append(s);
  }
  renderProjects();
}
function renderProjects() {
  const ps = state.config?.projects || [];
  $("#projects").hidden = ps.length < 2;
  $("#projects").innerHTML = ps.map((p) => `<a href="?project=${encodeURIComponent(p.key)}${location.hash}" ${p.key === state.project ? 'aria-current="page"' : ""}>${esc(p.title)} <span class="n">${p.runs}</span></a>`).join("");
  const cur = ps.find((p) => p.key === state.project);
  $("#logdir").textContent = cur ? cur.logdir : "";
}
async function refresh() {
  const data = await api.runs();
  state.runs = data.runs;
  state.byName = new Map(data.runs.map((r) => [r.name, r]));
  try { state.folders = await api.folders(); } catch { /* optional */ }
  state.selected = state.selected.filter((n) => state.byName.has(n));
  // only on the first load: later polls must not undo the user's (un)checking
  const first = !state.loadedOnce; state.loadedOnce = true;
  if (!state.focus || !state.byName.has(state.focus)) state.focus = data.runs.find((r) => !r.notes?.archived)?.name || data.runs[0]?.name || null;
  if (first) {
    const saved = store.get("selected:" + state.project, []).filter((n) => state.byName.has(n));
    state.selected = saved.length ? saved : data.runs.filter((r) => !r.notes?.archived).slice(0, 3).map((r) => r.name);
    if (state.focus && !state.selected.includes(state.focus) && state.selected.length < MAX_SELECTED) state.selected.unshift(state.focus);
  }
  persist();
  await Promise.all([...new Set([...state.selected, state.focus].filter(Boolean))].map(loadMetrics));
}
async function loadMetrics(name) {
  const cur = state.metrics.get(name) || { rows: [] };
  try {
    const b = await api.metrics(name, cur.rows.length);
    if (b.total < cur.rows.length) cur.rows = [];       // file was rewritten
    cur.rows = cur.rows.concat(b.rows);
    state.metrics.set(name, cur);
  } catch { /* run vanished */ }
}
function persist() {
  store.set("selected:" + state.project, state.selected);
  const u = new URL(location.href);
  u.searchParams.set("project", state.project);
  if (state.focus) u.searchParams.set("run", state.focus); else u.searchParams.delete("run");
  history.replaceState(null, "", u);
}

// ============================================================== metrics helpers
const META_KEYS = new Set(["step", "time", "it", "iteration", "epoch", "timestamp", "wall_time"]);
const stepOf = (row, i) => ["step", "it", "iteration", "epoch"].map((k) => row[k]).find((v) => typeof v === "number") ?? i;
function metricKeys(names) {
  const keys = new Set();
  for (const n of names) for (const row of (state.metrics.get(n)?.rows || []).slice(-200)) for (const [k, v] of Object.entries(row)) if (!META_KEYS.has(k) && (typeof v === "number" || v === null)) keys.add(k);
  return [...keys].sort((a, b) => a.localeCompare(b));
}
function series(name, key) {
  const rows = state.metrics.get(name)?.rows || [];
  const out = [];
  rows.forEach((r, i) => { const v = r[key]; if (typeof v === "number" && isFinite(v)) out.push({ x: state.xKey === "time" && typeof r.time === "number" ? r.time / 60 : stepOf(r, i), y: v }); });
  return out;
}
function smooth(pts, a) {
  if (!a) return pts;
  let m = null; const out = [];
  for (const p of pts) { m = m == null ? p.y : a * m + (1 - a) * p.y; out.push({ x: p.x, y: m }); }
  return out;
}
function downsample(pts, n = 1500) {
  if (pts.length <= n) return pts;
  const k = pts.length / n, out = [];
  for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * k)]);
  out.push(pts[pts.length - 1]);
  return out;
}
const groupOf = (k) => (k.includes("/") ? k.split("/")[0] : "기타");
function headlineKeys(name) {
  const want = state.config?.headline || [];
  const keys = metricKeys([name]);
  const pick = want.filter((k) => keys.includes(k));
  return (pick.length ? pick : keys).slice(0, 4);
}

// ============================================================== roster
function matches(r, q) {
  if (!q) return true;
  const n = r.notes || {};
  const hay = [r.name, n.goal, n.note, ...(n.tags || []), n.folder].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
}
const isProblem = (r) => ["failed", "stale", "stopped"].includes(r.status);
function renderRoster() {
  const visible = state.runs.filter((r) => !!r.notes?.archived === state.showArchived);
  const counts = { all: visible.length, starred: 0, running: 0, finished: 0, problem: 0 };
  visible.forEach((r) => { if (r.notes?.star) counts.starred++; if (r.status === "running") counts.running++; if (r.status === "finished") counts.finished++; if (isProblem(r)) counts.problem++; });
  $("#status-chips").innerHTML = [["all", "전체"], ["starred", "★ 즐겨찾기"], ["running", "학습 중"], ["finished", "완료"], ["problem", "문제"]]
    .map(([k, l]) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${state.statusFilter === k}">${l}<span class="count num">${counts[k]}</span></button>`).join("");
  const f = state.statusFilter;
  const list = visible.filter((r) => (f === "all" || (f === "starred" && r.notes?.star) || (f === "running" && r.status === "running") || (f === "finished" && r.status === "finished") || (f === "problem" && isProblem(r))) && matches(r, state.query));
  $("#run-count").textContent = `${list.length} / ${state.runs.length}`;
  $("#roster-hint").textContent = state.showArchived ? "보관함: 체크는 폴더로 옮길 실행 고르기" : `체크한 실행을 겹쳐서 비교 (최대 ${MAX_SELECTED}개)`;
  $("#toggle-archived").textContent = state.showArchived ? "← 실행 목록으로" : `보관함 보기 (${state.runs.filter((r) => r.notes?.archived).length})`;
  if (!state.runs.length) {
    const p = state.config?.projects.find((x) => x.key === state.project);
    $("#run-list").innerHTML = `<li class="project-hint">아직 실행이 없습니다. 학습 코드에서 <code>RunLogger("${esc(p?.logdir || "logs")}", name="...")</code>로 기록하면 여기에 나타납니다. README의 "로그 남기기"를 보세요.</li>`;
    return;
  }
  $("#run-list").innerHTML = folderTreeHTML(list) + (list.length ? "" : `<li class="empty-state" style="margin:8px">조건에 맞는 실행이 없습니다</li>`);
}
function runItem(r, depth = -1) {
  const s = r.summary || {}, total = s.total_steps || r.meta?.total_steps, done = s.last_step;
  const pct = total && done != null ? Math.min(100, ((done + 1) / total) * 100) : r.status === "finished" ? 100 : 0;
  const sel = state.selected.includes(r.name), tree = true;
  const check = state.showArchived
    ? `<input class="pick" type="checkbox" aria-label="${esc(r.name)} 옮기기 선택" ${state.moveSel.has(r.name) ? "checked" : ""}>`
    : `<input class="pick" type="checkbox" aria-label="${esc(r.name)} 비교에 포함" ${sel ? "checked" : ""}>`;
  return `<li class="run ${r.name === state.focus ? "focused" : ""} ${depth >= 0 ? "in-folder" : ""}" data-run="${esc(r.name)}" ${tree ? 'draggable="true"' : ""} ${depth >= 0 ? `style="--depth:${depth}"` : ""}>
    ${check}
    <span class="name"><i class="swatch ${sel ? "" : "off"}" style="background:${sel ? colorOf(r.name) : "var(--muted)"}"></i>${r.notes?.star ? '<span class="star" aria-label="즐겨찾기">★</span>' : ""}${esc(r.name)}</span>
    <span class="status ${r.status}">${STATUS_KO[r.status] || esc(r.status)}</span>
    <div class="bar ${r.status}"><i style="width:${pct}%"></i></div>
    <div class="sub"><span class="num">${done != null ? done : "–"}${total ? " / " + total : ""}</span><span>${fmtAgo(r.updated_time)}</span>${(r.notes?.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
  </li>`;
}

// folders: a run points to one through notes.folder ("a/b" nests); empty folders live in the folder list
function allFolders() {
  const set = new Set(state.folders);
  state.runs.forEach((r) => { if (r.notes?.folder) set.add(r.notes.folder); });
  [...set].forEach((f) => { const p = f.split("/"); for (let i = 1; i < p.length; i++) set.add(p.slice(0, i).join("/")); });
  return [...set].sort((a, b) => a.localeCompare(b, "ko"));
}
const folderHidden = (f) => f.split("/").some((_, i, p) => i > 0 && state.folderClosed.has(p.slice(0, i).join("/")));
const pickedForMove = () => state.showArchived ? [...state.moveSel].filter((n) => state.byName.get(n)?.notes?.archived)
  : state.selected.filter((n) => state.byName.has(n) && !state.byName.get(n).notes?.archived);
function folderTreeHTML(list) {
  const folders = allFolders(), known = new Set(folders);
  const by = new Map([["", []], ...folders.map((f) => [f, []])]);
  list.forEach((r) => by.get(known.has(r.notes?.folder) ? r.notes.folder : "")?.push(r));
  const inView = new Set(), anyRun = new Set();
  state.runs.forEach((r) => { const f = r.notes?.folder; if (!f) return; anyRun.add(f); if (!!r.notes?.archived === state.showArchived) inView.add(f); });
  const filtering = !!state.query || state.statusFilter !== "all";
  const picked = pickedForMove();
  const opts = `<option value="">폴더 없음</option>` + folders.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
  let html = `<li class="fold-tools">
    <form class="row" id="fold-new"><input name="name" value="${esc(state.folderDraft)}" placeholder="새 폴더 (예: baseline, ablation/lr)" aria-label="새 폴더 이름" maxlength="120"><button class="btn" type="submit">새 폴더</button></form>
    ${picked.length ? `<div class="row">체크한 ${picked.length}개를 <select id="fold-move-to" aria-label="옮길 폴더">${opts}</select><button class="btn" type="button" data-fold="move">옮기기</button></div>` : ""}
    <div class="hint">실행을 폴더로 끌어다 놓거나, 체크한 뒤 한꺼번에 옮깁니다. 이름에 / 를 넣으면 하위 폴더가 됩니다.</div></li>`;
  for (const f of folders) {
    if (folderHidden(f)) continue;
    const depth = f.split("/").length - 1, closed = state.folderClosed.has(f), runs = by.get(f) || [];
    const sub = folders.filter((x) => x.startsWith(f + "/")).reduce((n, x) => n + (by.get(x) || []).length, 0);
    if (filtering && !runs.length && !sub) continue;
    const used = [...inView].some((x) => x === f || x.startsWith(f + "/")), empty = ![...anyRun].some((x) => x === f || x.startsWith(f + "/"));
    if (!used && !empty) continue;
    html += `<li class="folder" data-folder="${esc(f)}" style="--depth:${depth}">
      <button class="tw" type="button" data-fold="toggle" aria-expanded="${!closed}" aria-label="${esc(f)} ${closed ? "펼치기" : "접기"}">${closed ? "▸" : "▾"}</button>
      <span class="fname" data-fold="toggle" title="${esc(f)}">${esc(f.split("/").pop())}</span><span class="c">${runs.length}${sub ? " +" + sub : ""}</span>
      <button class="fact" type="button" data-fold="rename">이름 바꾸기</button><button class="fact" type="button" data-fold="delete">삭제</button></li>`;
    if (!closed) html += runs.map((r) => runItem(r, depth)).join("");
  }
  const loose = by.get("");
  if (!folders.length) html += loose.map((r) => runItem(r)).join("");
  else if (loose.length) html += `<li class="folder none" data-folder=""><span class="tw"></span><span class="fname">폴더 없음</span><span class="c">${loose.length}</span></li>` + loose.map((r) => runItem(r, 0)).join("");
  return html;
}
async function saveNotes(r, patch) {
  const notes = { star: false, archived: false, tags: [], goal: "", note: "", folder: "", color: null, ...r.notes, ...patch };
  r.notes = await api.saveNotes(r.name, notes);
  return r.notes;
}
async function moveRuns(names, folder) {
  let n = 0;
  for (const name of names) { const r = state.byName.get(name); if (!r) continue; try { await saveNotes(r, { folder }); n++; } catch (e) { toast(`${name}: ${e.message}`); } }
  if (folder && !state.folders.includes(folder)) await saveFolders([...state.folders, folder]);
  return n;
}
async function saveFolders(list) { try { state.folders = await api.saveFolders([...new Set(list)]); } catch (e) { toast("폴더를 저장하지 못했습니다: " + e.message); } }

// ============================================================== focus card
function sparkline(pts, color) {
  if (pts.length < 2) return "";
  const d = downsample(pts, 120), W = 120, H = 26;
  const xs = d.map((p) => p.x), ys = d.map((p) => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const P = d.map((p) => `${((p.x - x0) / (x1 - x0 || 1)) * W},${H - 2 - ((p.y - y0) / (y1 - y0 || 1)) * (H - 4)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" points="${P}"/></svg>`;
}
function renderFocus() {
  const el = $("#focus"), r = state.byName.get(state.focus);
  if (!r) { el.innerHTML = `<div class="empty-state">왼쪽에서 실행을 고르세요</div>`; return; }
  const m = r.meta || {}, s = r.summary || {}, n = r.notes || {}, rows = state.metrics.get(r.name)?.rows || [];
  const total = s.total_steps, done = s.last_step;
  const lastT = rows.length && typeof rows[rows.length - 1].time === "number" ? rows[rows.length - 1].time : (m.end_time || r.updated_time) - (m.start_time || 0);
  const rate = rows.length > 10 && typeof rows[rows.length - 1].time === "number" ? (stepOf(rows[rows.length - 1]) - stepOf(rows[rows.length - 11])) / (rows[rows.length - 1].time - rows[rows.length - 11].time) : null;
  const eta = r.status === "running" && total && rate > 0 ? (total - 1 - done) / rate : null;
  const color = state.selected.includes(r.name) ? colorOf(r.name) : cssVar("--accent");
  const kp = headlineKeys(r.name).map((k) => { const pts = series(r.name, k); const last = pts.length ? pts[pts.length - 1].y : null;
    return `<div class="kpi"><span class="label" title="${esc(k)}">${esc(k)}</span><span class="value">${fmtNum(last)}</span>${sparkline(pts, color)}</div>`; }).join("");
  const staleMin = r.status === "stale" ? Math.round((Date.now() / 1000 - r.updated_time) / 60) : 0;
  el.innerHTML = `
    <div class="focus-head"><h2>${esc(r.name)}</h2><span class="status ${r.status}">${STATUS_KO[r.status] || esc(r.status)}</span></div>
    <div class="meta-line">${m.start_time ? `<span>시작 ${fmtDate(m.start_time)}</span>` : ""}${m.host ? `<span>${esc(m.host)}${m.pid ? " · pid " + esc(m.pid) : ""}</span>` : ""}${m.command ? `<code title="${esc(m.command)}">${esc(m.command.length > 140 ? m.command.slice(0, 140) + "…" : m.command)}</code>` : ""}</div>
    ${staleMin ? `<div class="warnbar">${staleMin}분째 새 기록이 없습니다. 학습이 멈췄거나 종료 기록 없이 끝났을 수 있습니다.</div>` : ""}
    ${m.error ? `<div class="warnbar">오류: ${esc(m.error)}</div>` : ""}
    <div class="kpis">
      <div class="kpi"><span class="label plain">진행</span><span class="value">${done ?? "–"}<small>${total ? "/ " + total : ""}</small></span>
        ${total ? `<div class="progress"><i style="width:${Math.min(100, ((done + 1) / total) * 100)}%"></i></div>` : ""}<span class="hint">${eta != null ? "남은 시간 약 " + fmtDuration(eta) : fmtAgo(r.updated_time) + " 갱신"}</span></div>
      <div class="kpi"><span class="label plain">학습 시간</span><span class="value">${fmtDuration(lastT)}</span><span class="hint">${rate ? fmtNum(rate, 2) + " step/초" : ""}</span></div>
      ${kp}
    </div>
    <div class="manage">
      <span class="eyebrow" style="padding-top:6px">관리</span>
      <div class="ctl">
        <button class="btn" type="button" id="btn-star" aria-pressed="${!!n.star}">${n.star ? "★ 즐겨찾기됨" : "☆ 즐겨찾기"}</button>
        <button class="btn" type="button" id="btn-archive">${n.archived ? "보관 해제" : "보관함으로"}</button>
        <label class="hint" style="display:inline-flex;align-items:center;gap:4px">폴더 <select class="field" id="folder-select" style="width:auto;padding:4px 6px"><option value="">폴더 없음</option>${allFolders().map((f) => `<option value="${esc(f)}" ${n.folder === f ? "selected" : ""}>${esc(f)}</option>`).join("")}</select></label>
        <span class="color-pick" role="group" aria-label="그래프 색">${[1, 2, 3, 4, 5, 6, 7, 8].map((k) => `<button type="button" class="cp" data-color="${k}" style="background:var(--s${k})" aria-label="색 ${k}" aria-pressed="${n.color === k}"></button>`).join("")}<button type="button" class="btn" data-color="0" aria-pressed="${!n.color}" style="padding:2px 8px">자동</button></span>
        <input class="field" id="tags-input" style="max-width:240px" placeholder="태그 (쉼표로 구분)" value="${esc((n.tags || []).join(", "))}">
        <span class="save-state" id="save-state"></span>
      </div>
      <span class="eyebrow" style="padding-top:6px">목적</span>
      <input class="field" id="goal-input" placeholder="이 실행으로 무엇을 확인하나 (한 줄)" value="${esc(n.goal || "")}">
      <span class="eyebrow" style="padding-top:6px">메모</span>
      <textarea class="field" id="note-input" placeholder="바꾼 것, 관찰한 것, 다음에 할 것">${esc(n.note || "")}</textarea>
    </div>`;
}

// ============================================================== tabs
const BUILTIN_TABS = [["curves", "학습 곡선"], ["compare", "실행 비교"], ["config", "설정 차이"]];
function renderTabs() {
  const tabs = [...BUILTIN_TABS, ...state.plugins.map((p) => [p.id, p.title])];
  if (!tabs.some(([id]) => id === state.tab)) state.tab = "curves";
  $("#tabs").innerHTML = tabs.map(([id, t]) => `<button class="tab" role="tab" type="button" data-tab="${esc(id)}" aria-selected="${id === state.tab}">${esc(t)}</button>`).join("");
}
function legendHTML() {
  return `<div class="legend">${state.selected.length ? state.selected.map((n) => `<span class="item"><i style="background:${colorOf(n)}"></i>${esc(n)}</span>`).join("") : '<span class="hint">왼쪽 목록에서 실행을 체크하면 겹쳐서 봅니다</span>'}</div>`;
}
async function renderTab(fromPoll = false) {
  const body = $("#tab-body");
  if (state.tab === "curves") return renderCurves(body, fromPoll);
  destroyCharts();
  if (fromPoll && state.tab !== "compare") return;   // config and plugin tabs do not need a redraw every 5 s
  if (state.tab === "compare") return renderCompare(body);
  if (state.tab === "config") return renderConfigDiff(body);
  const p = state.plugins.find((x) => x.id === state.tab);
  if (p) {
    body.innerHTML = '<div class="empty-state">불러오는 중…</div>';
    try { await p.render(body, { run: state.byName.get(state.focus), selected: state.selected.map((n) => state.byName.get(n)).filter(Boolean), api, esc }); }
    catch (e) { body.innerHTML = `<div class="empty-state">플러그인 오류: ${esc(e.message)}</div>`; }
  }
}
function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts.clear(); }
function renderCurves(body, fromPoll) {
  const keys = metricKeys(state.selected.length ? state.selected : [state.focus].filter(Boolean));
  const groups = [...new Set(keys.map(groupOf))];
  if (state.group !== "all" && !groups.includes(state.group)) state.group = "all";
  const shown = keys.filter((k) => (state.group === "all" || groupOf(k) === state.group) && (!state.metricQuery || k.toLowerCase().includes(state.metricQuery.toLowerCase())));
  const sig = shown.join("|") + "#" + state.selected.join("|") + state.xKey + state.smoothing;
  if (fromPoll && body.dataset.sig === sig) { updateCharts(shown); return; }
  destroyCharts(); body.dataset.sig = sig;
  const names = state.selected.length ? state.selected : [state.focus].filter(Boolean);
  if (!keys.length) { body.innerHTML = `<div class="controls"></div><div class="empty-state">${names.length ? "기록된 지표가 아직 없습니다" : "실행을 고르세요"}</div>`; return; }
  const byGroup = new Map(); shown.slice(0, 80).forEach((k) => { const g = groupOf(k); byGroup.set(g, [...(byGroup.get(g) || []), k]); });
  body.innerHTML = `<div class="controls">
      <label>x축 <select id="x-axis"><option value="step" ${state.xKey === "step" ? "selected" : ""}>step</option><option value="time" ${state.xKey === "time" ? "selected" : ""}>시간 (분)</option></select></label>
      <label>스무딩 <input type="range" id="smoothing" min="0" max="0.98" step="0.02" value="${state.smoothing}"><span class="num" id="smoothing-val">${state.smoothing.toFixed(2)}</span></label>
      <div class="chips">${["all", ...groups].map((g) => `<button class="chip" type="button" data-group="${esc(g)}" aria-pressed="${state.group === g}">${g === "all" ? "전체" : esc(g)}</button>`).join("")}</div>
      <input type="search" id="metric-search" placeholder="지표 이름 검색" value="${esc(state.metricQuery)}">
    </div>${legendHTML()}
    ${[...byGroup].map(([g, ks]) => `${byGroup.size > 1 ? `<h4 class="group-h">${esc(g)}</h4>` : ""}<div class="charts">${ks.map((k) => `<div class="chart"><h3>${esc(k)}</h3><div class="canvas-box"><canvas data-key="${esc(k)}"></canvas></div></div>`).join("")}</div>`).join("")}
    ${shown.length > 80 ? `<p class="hint">지표가 많아 처음 80개만 그렸습니다. 묶음이나 검색으로 좁히세요.</p>` : ""}`;
  $$("canvas[data-key]", body).forEach((cv) => drawChart(cv, cv.dataset.key, names));
}
function datasets(key, names) {
  return names.map((n) => { const raw = series(n, key); return { label: n, data: downsample(smooth(raw, state.smoothing)), borderColor: colorOf(n), backgroundColor: colorOf(n), borderWidth: 1.6, pointRadius: 0, tension: 0 }; });
}
function drawChart(cv, key, names) {
  if (!window.Chart) { cv.parentElement.innerHTML = '<p class="hint">그래프 라이브러리(Chart.js)를 불러오지 못했습니다. 인터넷 연결을 확인하세요.</p>'; return; }
  const grid = cssVar("--line"), tick = cssVar("--muted");
  const chart = new Chart(cv, { type: "line", data: { datasets: datasets(key, names) },
    options: { animation: false, parsing: false, normalized: true, maintainAspectRatio: false, interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: { x: { type: "linear", grid: { color: grid }, ticks: { color: tick, maxTicksLimit: 6 } }, y: { grid: { color: grid }, ticks: { color: tick, maxTicksLimit: 5 } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => (state.xKey === "time" ? "시간 " + fmtNum(it[0].parsed.x, 2) + "분" : "step " + it[0].parsed.x), label: (it) => `${it.dataset.label}: ${fmtNum(it.parsed.y, 4)}` } } } } });
  state.charts.set(key, chart);
}
function updateCharts(keys) {
  const names = state.selected.length ? state.selected : [state.focus].filter(Boolean);
  keys.forEach((k) => { const c = state.charts.get(k); if (c) { c.data.datasets = datasets(k, names); c.update("none"); } });
}
function renderCompare(body) {
  const names = state.selected;
  if (!names.length) { body.innerHTML = `<div class="controls"></div><div class="empty-state">왼쪽 목록에서 비교할 실행을 체크하세요</div>`; return; }
  const keys = metricKeys(names);
  const val = (n, k) => { const pts = series(n, k).map((p) => p.y); if (!pts.length) return null;
    return state.compareMode === "max" ? Math.max(...pts) : state.compareMode === "min" ? Math.min(...pts) : state.compareMode === "tail" ? pts.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, pts.length) : pts[pts.length - 1]; };
  const head = `<tr><th>지표</th>${names.map((n) => `<th class="n"><span style="color:${colorOf(n)}">■</span> ${esc(n)}</th>`).join("")}</tr>`;
  const info = [["상태", (r) => STATUS_KO[r.status] || r.status], ["step", (r) => r.summary?.last_step ?? "–"], ["목적", (r) => r.notes?.goal || "–"]]
    .map(([l, f]) => `<tr><td>${l}</td>${names.map((n) => `<td class="${l === "목적" ? "" : "n"}">${esc(f(state.byName.get(n)))}</td>`).join("")}</tr>`).join("");
  const rows = keys.map((k) => { const vs = names.map((n) => val(n, k)); const ok = vs.filter((v) => v != null);
    const hi = ok.length > 1 ? Math.max(...ok) : null;
    return `<tr><td class="mono">${esc(k)}</td>${vs.map((v) => `<td class="n">${v === hi && v != null ? `<span class="best-mark">${fmtNum(v, 4)}</span>` : fmtNum(v, 4)}</td>`).join("")}</tr>`; }).join("");
  body.innerHTML = `<div class="controls"><label>값 <select id="compare-mode">${[["last", "마지막 값"], ["tail", "마지막 10개 평균"], ["max", "최댓값"], ["min", "최솟값"]].map(([v, l]) => `<option value="${v}" ${state.compareMode === v ? "selected" : ""}>${l}</option>`).join("")}</select></label><span class="hint">▲ 는 그 행에서 가장 큰 값 (좋고 나쁨은 지표마다 다름)</span></div>
    <div class="table-wrap"><table><thead>${head}</thead><tbody>${info}${rows}</tbody></table></div>`;
}
async function renderConfigDiff(body) {
  const names = state.selected.length ? state.selected : [state.focus].filter(Boolean);
  if (!names.length) { body.innerHTML = `<div class="controls"></div><div class="empty-state">실행을 고르세요</div>`; return; }
  body.innerHTML = '<div class="controls"></div><div class="empty-state">불러오는 중…</div>';
  await Promise.all(names.filter((n) => !state.configs.has(n)).map(async (n) => { try { state.configs.set(n, await api.runConfig(n)); } catch { state.configs.set(n, { flat: {} }); } }));
  if (state.tab !== "config") return;
  const cfgs = names.map((n) => state.configs.get(n) || { flat: {} });
  const keys = [...new Set(cfgs.flatMap((c) => Object.keys(c.flat || {})))].sort();
  const str = (v) => (v === undefined ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const differ = (k) => new Set(cfgs.map((c) => str(c.flat?.[k]))).size > 1;
  const shown = keys.filter((k) => (!state.diffOnly || names.length < 2 || differ(k)) && (!state.cfgQuery || k.toLowerCase().includes(state.cfgQuery.toLowerCase())));
  const texts = cfgs.map((c, i) => (c.text ? `<details><summary>${esc(names[i])}: ${esc(c.file)} (원문)</summary><pre class="mono" style="white-space:pre-wrap">${esc(c.text)}</pre></details>` : "")).join("");
  body.innerHTML = `<div class="controls"><label class="toggle"><input type="checkbox" id="cfg-diff" ${state.diffOnly ? "checked" : ""}> 다른 값만</label><input type="search" id="cfg-search" placeholder="설정 이름 검색" value="${esc(state.cfgQuery)}"><span class="hint">${keys.length}개 중 ${shown.length}개 · 설정 파일: config.json (또는 config.yaml)</span></div>
    ${keys.length ? `<div class="table-wrap"><table><thead><tr><th>설정</th>${names.map((n) => `<th><span style="color:${colorOf(n)}">■</span> ${esc(n)}</th>`).join("")}</tr></thead><tbody>
      ${shown.slice(0, 600).map((k) => { const d = names.length > 1 && differ(k); return `<tr><td class="mono">${esc(k)}</td>${cfgs.map((c) => `<td class="mono ${d ? "diff" : ""}">${esc(str(c.flat?.[k]))}</td>`).join("")}</tr>`; }).join("")}
    </tbody></table></div>` : `<div class="empty-state">설정 파일이 없습니다. <code>RunLogger(..., config=cfg)</code>로 남기면 비교할 수 있습니다.</div>`}${texts}`;
}

// ============================================================== report figures (```chart blocks)
// Spec: { title, caption, type: "line"|"scatter", x: {label, min, max}, panels: [{ title, unit, better: "up"|"down",
//   y: {min, max}, series: [{name, color (1-8, 0 = gray), dash, points: [[x, y], ...], labels}], refs: [{y, label}],
//   xrefs: [{x, label}], region: {x: [a, b], y: [c, d], label} }] }
function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag, step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = []; for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return { ticks: out, step };
}
const fmtTick = (v, step) => v.toFixed(Math.min(Math.max(0, -Math.floor(Math.log10(step) + 1e-9)), 4));
const rfColor = (c) => (+c >= 1 && +c <= 8 ? `var(--s${+c})` : "var(--muted)");
function reportPanel(spec, p, single) {
  const W = single ? 560 : 340, H = single ? 300 : 214, line = spec.type !== "scatter";
  const series = (p.series || []).map((s) => ({ ...s, points: (s.points || []).map(([x, y]) => [+x, +y]).filter(([x, y]) => isFinite(x) && isFinite(y)) }));
  const endLabels = line && p.endLabels !== false && series.length <= 4, dots = p.dots ?? series.every((s) => s.points.length <= 40);
  const m = { l: 42, r: endLabels ? 58 : 12, t: 10, b: 32 };
  const xs = series.flatMap((s) => s.points.map((q) => q[0])), ys = series.flatMap((s) => s.points.map((q) => q[1]));
  (p.refs || []).forEach((r) => ys.push(+r.y));
  if (p.region) { xs.push(...p.region.x.map(Number)); ys.push(...p.region.y.map(Number)); }
  const X = spec.x || {}, Y = p.y || {};
  let x0 = X.min ?? Math.min(...xs), x1 = X.max ?? Math.max(...xs), y0 = Y.min ?? Math.min(...ys), y1 = Y.max ?? Math.max(...ys);
  if (!isFinite(x0) || !isFinite(x1)) { x0 = 0; x1 = 1; } if (!isFinite(y0) || !isFinite(y1)) { y0 = 0; y1 = 1; }
  if (Y.min == null || Y.max == null) { const pad = (y1 - y0 || Math.abs(y1) || 1) * 0.08; if (Y.min == null) y0 -= pad; if (Y.max == null) y1 += pad; }
  if (!line && X.min == null) { const pad = (x1 - x0 || 1) * 0.06; x0 -= pad; x1 += pad; }
  const yt = niceTicks(y0, y1, 4), xt = niceTicks(x0, x1, 5);
  if (Y.min == null) y0 = Math.min(y0, yt.ticks[0]); if (Y.max == null) y1 = Math.max(y1, yt.ticks[yt.ticks.length - 1]);
  const sx = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r), sy = (v) => H - m.b - ((v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const unit = p.unit ? " " + p.unit : "", xl = X.label || "";
  let g = "";
  yt.ticks.filter((v) => v >= y0 - 1e-9 && v <= y1 + 1e-9).forEach((v) => { g += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}" class="rf-gl"/><text x="${m.l - 6}" y="${sy(v) + 3.5}" class="rf-tick" text-anchor="end">${fmtTick(v, yt.step)}</text>`; });
  xt.ticks.filter((v) => v >= x0 - 1e-9 && v <= x1 + 1e-9).forEach((v) => { g += `<text x="${sx(v)}" y="${H - m.b + 14}" class="rf-tick" text-anchor="middle">${fmtTick(v, xt.step)}</text>`; });
  g += `<line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" class="rf-axis"/>`;
  if (xl) g += `<text x="${(m.l + W - m.r) / 2}" y="${H - 4}" class="rf-tick" text-anchor="middle">${esc(xl)}</text>`;
  if (p.region) {
    const [a, b] = p.region.x.map(Number), [c, d] = p.region.y.map(Number);
    const rx = sx(Math.max(a, x0)), ry = sy(Math.min(d, y1)), rw = sx(Math.min(b, x1)) - rx, rh = sy(Math.max(c, y0)) - ry;
    g += `<rect x="${rx}" y="${ry}" width="${Math.max(0, rw)}" height="${Math.max(0, rh)}" class="rf-region"/>`;
    if (p.region.label) g += `<text x="${rx + 5}" y="${ry + Math.max(0, rh) - 6}" class="rf-reflabel">${esc(p.region.label)}</text>`;
  }
  (p.refs || []).forEach((r) => { const y = sy(+r.y); g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}" class="rf-ref"/>`; if (r.label) g += `<text x="${m.l + 4}" y="${y - 4}" class="rf-reflabel">${esc(r.label)}</text>`; });
  (p.xrefs || []).forEach((r) => { const x = sx(+r.x); if (!(x >= m.l && x <= W - m.r)) return; g += `<line x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}" class="rf-ref"/>`; if (r.label) g += `<text x="${x + 4}" y="${m.t + 10}" class="rf-reflabel">${esc(r.label)}</text>`; });
  const hits = [], ends = [];
  series.forEach((s) => {
    const col = rfColor(s.color), pts = s.points; if (!pts.length) return;
    if (line) {
      g += `<polyline fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="5 4"' : ""} points="${pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ")}"/>`;
      if (dots) pts.forEach(([x, y]) => { g += `<circle cx="${sx(x)}" cy="${sy(y)}" r="3.5" fill="${col}" class="rf-dot"/>`; });
      if (s.color) ends.push({ y: sy(pts[pts.length - 1][1]), name: s.name });
    } else pts.forEach(([x, y]) => { g += `<circle cx="${sx(x)}" cy="${sy(y)}" r="${s.color ? 4.5 : 5}" fill="${col}" class="rf-dot"/>`; });
    const labels = s.labels || [];
    pts.forEach(([x, y], i) => hits.push({ x: sx(x), y: sy(y), tip: `${s.name}${labels[i] != null ? " · " + labels[i] : ""}\n${xl ? xl + " " : ""}${+x.toFixed(3)} → ${+y.toFixed(3)}${unit}` }));
  });
  if (endLabels) { ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12; ends.forEach((e) => { g += `<text x="${W - m.r + 5}" y="${e.y + 3.5}" class="rf-endlabel">${esc(e.name)}</text>`; }); }
  const step = hits.length > 400 ? Math.ceil(hits.length / 400) : 1;
  g += hits.filter((_, i) => i % step === 0).map((h) => `<circle cx="${h.x}" cy="${h.y}" r="${line && hits.length > 120 ? 5 : 9}" class="rf-hit" data-tip="${esc(h.tip)}"/>`).join("");
  const dir = p.better === "up" ? '<span class="dir">↑ 높을수록 좋음</span>' : p.better === "down" ? '<span class="dir">↓ 낮을수록 좋음</span>' : "";
  return `<div class="rf-panel"><div class="rf-ptitle">${esc(p.title || "")}${unit ? `<span class="rf-unit">${esc(p.unit)}</span>` : ""}${dir}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc((p.title || "") + " " + (spec.title || ""))}">${g}</svg></div>`;
}
function reportFigure(spec) {
  const panels = (spec.panels || []).slice(0, 8);
  if (!panels.length) throw new Error("panels가 비어 있습니다");
  const leg = spec.legend || [...new Map(panels.flatMap((p) => p.series || []).map((s) => [s.name, { name: s.name, color: s.color, dash: s.dash }])).values()];
  const legend = leg.length >= 2 ? `<div class="rf-legend">${leg.map((l) => `<span><i style="background:${rfColor(l.color)}" class="${l.dash ? "dash" : ""}"></i>${esc(l.name)}</span>`).join("")}</div>` : "";
  return `<figure class="rfig">${legend}<div class="rf-grid ${panels.length === 1 ? "one" : ""}">${panels.map((p) => reportPanel(spec, p, panels.length === 1)).join("")}</div>${spec.title || spec.caption ? `<figcaption>${spec.title ? `<b>${esc(spec.title)}</b> ` : ""}${esc(spec.caption || "")}</figcaption>` : ""}</figure>`;
}
(function wireTips() {
  let tip;
  document.addEventListener("mouseover", (e) => { const h = e.target.closest?.(".rf-hit"); if (!h) { if (tip) tip.hidden = true; return; }
    if (!tip) { tip = document.createElement("div"); tip.className = "rf-tip"; document.body.append(tip); }
    tip.textContent = h.dataset.tip; tip.hidden = false; });
  document.addEventListener("mousemove", (e) => { if (tip && !tip.hidden) { tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = e.clientY + 14 + "px"; } });
})();
function md(text) {
  if (!window.marked) return `<pre>${esc(text)}</pre>`;
  const renderer = new marked.Renderer();
  renderer.html = (t) => esc(typeof t === "string" ? t : t.text);           // raw HTML is shown as text
  renderer.code = (code, lang) => {
    const c = typeof code === "object" ? code : { text: code, lang };
    if (c.lang === "chart") { try { return reportFigure(JSON.parse(c.text)); } catch (e) { return `<p class="rfig-err">그래프 블록 오류: ${esc(e.message)}</p>`; } }
    return `<pre><code>${esc(c.text)}</code></pre>`;
  };
  renderer.table = function (...a) { return `<div class="table-wrap">${marked.Renderer.prototype.table.apply(this, a)}</div>`; };
  // report images: report-assets/<file> belongs to the current project
  return marked.parse(String(text || ""), { renderer, gfm: true, breaks: false })
    .replace(/src="report-assets\/([^"?]+)"/g, (m, f) => `src="${withProject("report-assets/" + f)}"`);
}

// ============================================================== reports view
async function renderReports() {
  const root = $("#view-reports");
  try { state.reports = await api.reports(); } catch (e) { root.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
  const [, rid] = location.hash.split("/");
  const id = rid ? decodeURIComponent(rid) : state.reports[0]?.id;
  if (id === "new" || state.editing) return renderEditor(root);
  state.report = id ? await api.report(id).catch(() => null) : null;
  root.innerHTML = `<div class="rep-grid">
    <aside class="panel"><div class="rep-list"><button class="btn primary" type="button" data-act="new-report" style="margin:4px 4px 8px">+ 새 리포트</button>
      ${state.reports.map((r) => `<button type="button" class="rep-item ${r.id === state.report?.id ? "sel" : ""}" data-report="${esc(r.id)}"><b>${esc(r.title)}</b><span>${esc(r.author || "작성자 없음")} · ${fmtDate(r.updated)}</span></button>`).join("") || '<p class="hint" style="padding:8px">아직 리포트가 없습니다</p>'}</div></aside>
    <article class="panel rep-body">${state.report ? `<div class="rep-tools"><span class="hint">${esc(state.report.author || "")} · ${fmtDate(state.report.updated)} 수정</span><span class="spacer"></span><button class="btn" type="button" data-act="edit-report">편집</button><button class="btn danger" type="button" data-act="delete-report">삭제</button></div><div class="md"><h1>${esc(state.report.title)}</h1>${md(state.report.body)}</div>`
      : `<div class="empty-state">리포트를 고르거나 새로 만드세요. 마크다운으로 쓰고, 학습 곡선은 <code>\`\`\`chart</code> 블록으로 넣습니다.</div>`}</article></div>`;
}
function renderEditor(root) {
  const r = state.editing || (state.editing = { id: null, title: "", author: store.get("author", ""), body: "# 제목\n\n## 요약\n\n## 방법\n\n## 결과\n\n## 논의\n" });
  const names = state.runs.map((x) => x.name);
  root.innerHTML = `<div class="panel rep-body">
    <div class="rep-tools"><input class="field" id="rep-title" placeholder="리포트 제목" value="${esc(r.title)}" style="flex:2 1 300px"><input class="field" id="rep-author" placeholder="작성자" value="${esc(r.author)}" style="flex:1 1 140px">
      <button class="btn primary" type="button" data-act="save-report">저장</button><button class="btn" type="button" data-act="cancel-report">취소</button></div>
    <div class="helper"><b style="font-size:13px">그래프 블록 만들기</b>
      <div class="row">실행 <select id="h-runs" multiple size="4" style="min-width:220px">${names.map((n) => `<option ${state.selected.includes(n) ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
        지표 <select id="h-metric"><option value="">(실행을 고르면 나옵니다)</option></select>
        점 개수 <select id="h-bin">${[[20, "약 20"], [40, "약 40"], [80, "약 80"], [0, "전부"]].map(([v, l]) => `<option value="${v}" ${v === 40 ? "selected" : ""}>${l}</option>`).join("")}</select>
        <button class="btn" type="button" data-act="insert-chart">커서 위치에 넣기</button></div>
      <span class="hint">고른 실행들의 학습 곡선을 구간 평균(점 개수만큼)해서 <code>\`\`\`chart</code> 블록으로 넣습니다. 넣은 뒤 제목·설명(caption)·기준선(refs)을 고치면 됩니다.</span></div>
    <div class="editor" style="margin-top:12px"><textarea class="field" id="rep-body" spellcheck="false">${esc(r.body)}</textarea><div class="md" id="rep-preview">${md(r.body)}</div></div></div>`;
  fillHelperMetrics();
}
async function fillHelperMetrics() {
  const sel = $("#h-runs"); if (!sel) return;
  const names = [...sel.selectedOptions].map((o) => o.value);
  await Promise.all(names.map(loadMetrics));
  const keys = metricKeys(names), cur = $("#h-metric").value;
  $("#h-metric").innerHTML = keys.length ? keys.map((k) => `<option ${k === cur ? "selected" : ""}>${esc(k)}</option>`).join("") : '<option value="">(지표 없음)</option>';
}
function chartBlock(names, key, nPts) {
  const sers = names.map((n, i) => { const pts = series(n, key), out = [], bin = nPts ? Math.max(1, Math.ceil(pts.length / nPts)) : 1;
    for (let a = 0; a < pts.length; a += bin) { const c = pts.slice(a, a + bin); out.push([+(c.reduce((s, p) => s + p.x, 0) / c.length).toFixed(3), +(c.reduce((s, p) => s + p.y, 0) / c.length).toPrecision(5)]); }
    const col = state.byName.get(n)?.notes?.color || (i % 8) + 1;
    return { name: n, color: col, points: out }; });
  const spec = { title: `그림. ${key}`, caption: "설명을 쓰세요.", x: { label: state.xKey === "time" ? "시간 (분)" : "step" }, panels: [{ title: key, series: sers }] };
  return "\n```chart\n" + JSON.stringify(spec) + "\n```\n";
}

// ============================================================== project board
const TASK_ST = [["doing", "진행 중"], ["todo", "할 일"], ["blocked", "막힘"], ["done", "완료"]];
const RM_ST = { done: "완료", doing: "진행 중", next: "다음", later: "나중" };
async function loadBoard() {
  try { const b = await api.board(); state.board = { rev: b.rev || 0, updated: b.updated, doc: Object.assign({ goal: "", tasks: [], decisions: [], roadmap: [] }, b.doc || {}) }; state.boardErr = null; }
  catch (e) { state.boardErr = e.message; }
}
let boardTimer;
function saveBoardSoon() { clearTimeout(boardTimer); boardTimer = setTimeout(saveBoard, 400); syncLabel("저장 중…"); }
async function saveBoard() {
  try {
    const { status, body } = await api.saveBoard(state.board.rev, state.board.doc);
    if (status === 409) { state.board = { rev: body.rev, updated: body.updated, doc: Object.assign({ goal: "", tasks: [], decisions: [], roadmap: [] }, body.doc || {}) }; toast(body.error); renderBoard(); return; }
    state.board.rev = body.rev; state.board.updated = body.updated; state.boardErr = null; syncLabel();
  } catch (e) { state.boardErr = "저장하지 못했습니다: " + e.message; syncLabel(); }
}
function syncLabel(text) { const el = $("#sync"); if (!el) return; el.classList.toggle("err", !!state.boardErr); el.textContent = text || state.boardErr || (state.board?.updated ? "저장됨 " + fmtDate(state.board.updated) : ""); }
const runChip = (n) => state.byName.has(n) ? `<a class="runchip" href="?project=${encodeURIComponent(state.project)}&run=${encodeURIComponent(n)}#runs">${esc(n)}</a>` : `<span class="runchip" style="opacity:.6">${esc(n)}</span>`;
const linesOf = (v) => String(v || "").split("\n").map((x) => x.trim()).filter(Boolean);
function renderBoard() {
  const root = $("#view-board");
  if (!state.board) { root.innerHTML = `<div class="empty-state">${esc(state.boardErr || "불러오는 중…")}</div>`; return; }
  const doc = state.board.doc;
  const task = (t) => `<details class="item ${t.status}" data-id="${t.id}"><summary><span class="dot"></span><span class="t">${esc(t.title)}</span><span class="hint">${esc(t.who || "")}</span>
      <span class="meta">${(t.runs || []).map(runChip).join("")}${t.note ? `<span>${esc(t.note.slice(0, 120))}</span>` : ""}</span></summary>
    <div class="edit"><span>제목</span><input class="field" data-f="title" value="${esc(t.title)}"><span>상태</span><select class="field" data-f="status">${TASK_ST.map(([k, l]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      <span>담당</span><input class="field" data-f="who" value="${esc(t.who || "")}"><span>관련 실행</span><input class="field" data-f="runs" value="${esc((t.runs || []).join(", "))}" placeholder="실행 이름, 쉼표로 구분">
      <span>메모</span><textarea class="field" data-f="note">${esc(t.note || "")}</textarea><span></span><span><button class="btn danger" type="button" data-act="del-task">삭제</button></span></div></details>`;
  const dec = (d) => `<div class="dec ${d.choice ? "decided" : ""}" data-id="${d.id}"><span class="q">${esc(d.question)}</span>
    <div class="opts">${(d.options || []).map((o, i) => `<button class="btn opt" type="button" data-act="choose" data-i="${i}" aria-pressed="${d.choice === o}">${esc(o)}</button>`).join("")}</div>
    ${d.note ? `<span class="hint">${esc(d.note)}</span>` : ""}<span class="hint">${d.decided ? esc(d.decided) + " · " : ""}<button class="linkish" type="button" data-act="${d.choice ? "reopen" : "add-opt"}">${d.choice ? "다시 열기" : "+ 선택지"}</button> · <button class="linkish" type="button" data-act="del-dec">삭제</button></span></div>`;
  const round = (r, i) => `<li class="rm-round ${esc(r.status)}" data-id="${r.id}"><div class="rm-rail"><span class="n">${i + 1}</span><span class="ln"></span></div><div class="rm-body">
    <div class="rm-head"><h4>${esc(r.title)}</h4><span class="rm-st">${RM_ST[r.status] || esc(r.status)}</span><button class="linkish" type="button" data-act="edit-round">편집</button></div>
    ${state.editRound === r.id ? roundForm(r) : `<div class="rm-cols"><div><h5>목적</h5><p>${esc(r.goal || "–")}</p>${r.criteria ? `<h5 style="margin-top:6px">판단 기준</h5><p>${esc(r.criteria)}</p>` : ""}${(r.runs || []).length ? `<div class="meta-line" style="margin-top:6px">${r.runs.map(runChip).join("")}</div>` : ""}</div>
      <div><h5>알게 된 것</h5>${(r.learned || []).length ? `<ul>${r.learned.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "<p>–</p>"}${r.then ? `<div class="rm-then">${esc(r.then)}</div>` : ""}</div></div>`}</div></li>`;
  const groups = TASK_ST.map(([k, l]) => { const ts = doc.tasks.filter((t) => t.status === k); return ts.length ? `<p class="group-title">${l} ${ts.length}</p>${ts.map(task).join("")}` : ""; }).join("");
  const tabs = `<div class="board-tabs" role="tablist">${[["overview", "목표·로드맵·할 일"], ["tree", "학습 트리"]].map(([k, l]) => `<button type="button" role="tab" data-board-tab="${k}" aria-selected="${state.boardTab === k}">${l}</button>`).join("")}</div>`;
  if (state.boardTab === "tree") {
    root.innerHTML = `<div class="board board-wide"><div class="board-top"><h2>프로젝트 관리</h2><p>모든 실행을 시간 순 트리로: 어느 실험에서 무엇을 바꿔 다음 실험을 했는지</p><span class="sync" id="sync"></span></div>${tabs}<section class="panel section" id="tree-root"></section></div>`;
    syncLabel(); renderTree(); return;
  }
  root.innerHTML = `<div class="board">
    <div class="board-top"><h2>프로젝트 관리</h2><p>목표, 학습 로드맵, 할 일, 결정할 것을 팀이 함께 봅니다. 바꾼 내용은 서버에 바로 저장됩니다.</p><span class="sync" id="sync"></span></div>${tabs}
    <section class="panel section"><header><h3>목표</h3><p>이 프로젝트가 끝났을 때 무엇이 되어 있어야 하나</p></header><input class="field goal-input" id="board-goal" value="${esc(doc.goal || "")}" placeholder="예: 검증 정확도 90% 이상인 모델을 재현 가능하게 (시드 3개)"></section>
    <section class="panel section"><header><h3>학습 로드맵</h3><p>라운드마다 무엇을 확인하려 했고, 무엇을 알게 됐고, 그래서 다음에 무엇을 했는지</p></header>
      <ol class="rm-list">${doc.roadmap.map(round).join("")}</ol>
      <form class="add-row" id="add-round"><input name="title" placeholder="새 라운드 (예: 기준선 학습)" required><button class="btn" type="submit">추가</button></form></section>
    <div class="board-grid">
      <section class="panel section"><header><h3>할 일</h3></header><form class="add-row" id="add-task"><input name="title" placeholder="새 할 일" required><input name="who" placeholder="담당" style="flex:0 1 110px"><button class="btn primary" type="submit">추가</button></form>${groups || '<div class="empty-state">할 일이 없습니다</div>'}</section>
      <section class="panel section"><header><h3>결정할 것</h3><p>선택지를 누르면 결정으로 기록됩니다</p></header>${doc.decisions.map(dec).join("") || '<div class="empty-state">기록된 결정이 없습니다</div>'}
        <form class="add-row" id="add-dec"><input name="q" placeholder="새로 정할 것" required><input name="opts" placeholder="선택지 (쉼표로 구분)"><button class="btn" type="submit">추가</button></form></section>
    </div></div>`;
  syncLabel();
}
function roundForm(r) {
  return `<div class="rm-form" data-round="${r.id}"><span>제목</span><input class="field" data-r="title" value="${esc(r.title)}"><span>상태</span><select class="field" data-r="status">${Object.entries(RM_ST).map(([k, l]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
    <span>목적</span><textarea class="field" data-r="goal">${esc(r.goal || "")}</textarea><span>판단 기준</span><input class="field" data-r="criteria" value="${esc(r.criteria || "")}">
    <span>관련 실행</span><input class="field" data-r="runs" value="${esc((r.runs || []).join(", "))}" placeholder="쉼표로 구분"><span>알게 된 것</span><textarea class="field" data-r="learned" placeholder="한 줄에 하나">${esc((r.learned || []).join("\n"))}</textarea>
    <span>그래서 →</span><input class="field" data-r="then" value="${esc(r.then || "")}"><span></span><span><button class="btn primary" type="button" data-act="done-round">닫기</button> <button class="btn danger" type="button" data-act="del-round">삭제</button></span></div>`;
}

// ============================================================== 학습 트리
// Every run is a point on a time axis (start -> last update), one row per run, rows grouped by top-level folder
// (colour) and, optionally, by section (config "tree_sections": [{"title", "match": run-name regex}]).
// notes.parent links a run to the run it came from; notes.change says what was changed, notes.verdict how it went.
// The same builder draws the page and the shareable HTML file (Korean or English chrome).
const TREE_PAL = ["#2563eb", "#ea580c", "#16a34a", "#ca8a04", "#db2777", "#0d9488", "#7c3aed", "#dc2626", "#0891b2", "#65a30d", "#9333ea", "#64748b"];
const isSeedChange = (c) => /^(시드|seed|same|같은 설정)/i.test(c || "");
const runStart = (r) => r.meta?.start_time || r.updated_time || 0;
const treeTop = (r) => (r.notes?.folder || "").split("/")[0] || "";
const TREE_T = {
  ko: { noFolder: "폴더 없음", other: "기타", n: (k) => `${k}개`, seedMean: (k) => `(시드 ${k}개 평균)`, parent: "부모", next: "다음", root: "출발점 (부모 없음)", goal: "목적",
    change: "바꾼 것", vsParent: "(부모 대비)", verdict: "결과 평가", results: "핵심 결과 (마지막 20행)", metric: "지표", thisRun: "이 실행", graph: "그래프", files: "파일 (영상·이미지)",
    noFiles: "영상·이미지 파일이 없습니다", note: "메모", sameCfg: "설정은 부모와 같음 (시드·장치·이름 제외)", more: (k) => `외 ${k}개`, seeds: (k) => `같은 설정, 시드 ${k}개`, run: "실행",
    meanSd: "평균 ± 표준편차", plusSeeds: (k) => `+ 시드 ${k}개`, noMetrics: "기록된 지표가 없습니다", locale: "ko-KR" },
  en: { noFolder: "No folder", other: "Other", n: (k) => `${k} runs`, seedMean: (k) => `(mean of ${k} seeds)`, parent: "Parent", next: "Next", root: "Starting point (no parent)", goal: "Goal",
    change: "What changed", vsParent: "(vs parent)", verdict: "Verdict", results: "Key results (last 20 rows)", metric: "Metric", thisRun: "This run", graph: "Chart", files: "Files (video, images)",
    noFiles: "No video or image files", note: "Note", sameCfg: "Settings same as the parent (seed, device and name aside)", more: (k) => `${k} more`, seeds: (k) => `Same setting, ${k} seeds`, run: "Run",
    meanSd: "Mean ± SD", plusSeeds: (k) => `+ ${k} seeds`, noMetrics: "No metrics logged", locale: "en-US" },
};
const treeLin = (runs) => Object.fromEntries(runs.map((r) => [r.name, { parent: r.notes?.parent || "", change: r.notes?.change || "", verdict: r.notes?.verdict || "" }]));
const headKey = (r) => state.config?.headline?.[0] || Object.keys(r?.summary?.last || {}).find((k) => !META_KEYS.has(k));
// o: {sel, order, availW, seeds: Map(head -> [runs]), hasVideo, lang, allGroups}
function treeBuild(runs, lin, o = {}) {
  const T = TREE_T[o.lang || "ko"], byName = new Map(runs.map((r) => [r.name, r])), shown = new Set(byName.keys());
  const top = (r) => treeTop(r) || T.noFolder;
  const secDefs = (state.config?.tree_sections || []).map((s) => ({ title: s.title, re: (() => { try { return new RegExp(s.match); } catch { return null; } })() })).filter((s) => s.re);
  const secOf = (r) => (secDefs.find((s) => s.re.test(r.name))?.title) || (secDefs.length ? T.other : "");
  const parentOf = (r) => { const p = lin[r.name]?.parent; return p && shown.has(p) && secOf(byName.get(p)) === secOf(r) ? p : null; };
  const kids = new Map();
  for (const r of runs) { const p = parentOf(r); if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(r.name); } }
  // depth-first walk: seed repeats first, then follow-ups in the same folder, then the rest, oldest first
  const walk = [], seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return; seen.add(n); walk.push(n);
    const me = byName.get(n);
    (kids.get(n) || []).slice().sort((a, b) => (isSeedChange(lin[b]?.change) - isSeedChange(lin[a]?.change))
      || ((top(byName.get(b)) === top(me)) - (top(byName.get(a)) === top(me))) || runStart(byName.get(a)) - runStart(byName.get(b))).forEach(visit);
  };
  const secTitles = secDefs.length ? [...secDefs.map((s) => s.title), T.other] : [""];
  for (const st of secTitles) runs.filter((r) => secOf(r) === st && !parentOf(r)).sort((a, b) => runStart(a) - runStart(b)).forEach((r) => visit(r.name));
  const order = new Map(walk.map((n, i) => [n, i]));
  const num = (g) => { const m = /^(\d+)/.exec(g); return m ? +m[1] : 1e9; };
  const byNum = (a, b) => num(a) - num(b) || a.localeCompare(b);
  const allGroups = o.allGroups || [...new Set(runs.map(top))].sort(byNum);
  const color = (g) => TREE_PAL[Math.max(0, allGroups.indexOf(g)) % TREE_PAL.length];
  const lineage = o.order !== "folder";
  const sections = secTitles.map((st) => {
    const rs = runs.filter((r) => secOf(r) === st);
    const groups = lineage ? [...new Set(walk.filter((n) => secOf(byName.get(n)) === st).map((n) => top(byName.get(n))))] : [...new Set(rs.map(top))].sort(byNum);
    return { title: st, groups: groups.map((g) => ({ g, runs: rs.filter((r) => top(r) === g).sort((a, b) => lineage ? order.get(a.name) - order.get(b.name) : runStart(a) - runStart(b)) })) };
  }).filter((s) => s.groups.length);
  // the time axis starts right of the longest folder name, so vertical links never run through a name;
  // each folder name has a line of its own above its runs
  const meas = (() => { try { const cx = document.createElement("canvas").getContext("2d"); cx.font = "600 12px sans-serif"; return (t) => cx.measureText(t).width; } catch { return (t) => t.length * 9; } })();
  const gNames = sections.flatMap((s) => s.groups.map((x) => x.g));
  const L = Math.max(220, Math.ceil(Math.max(0, ...gNames.map(meas))) + 44), R = 320, rowH = 26, gGap = 12, gHead = 20, top0 = 36;
  const t0 = Math.min(...runs.map(runStart)), t1 = Math.max(...runs.map((r) => r.updated_time || runStart(r)), t0 + 60);
  const span = t1 - t0, day = 86400, W = Math.max(o.availW || 1200, Math.min(6000, Math.round(span / day * 150)) + L + R);
  const X = (t) => L + (t - t0) / span * (W - L - R);
  const rows = [], gInfo = [], sInfo = []; let y = top0;
  for (const s of sections) {
    const sy = y; if (s.title) y += 28;
    for (const { g, runs: rs } of s.groups) { const y0 = y; y += gHead; rs.forEach((r) => { rows.push({ r, g, y: y + rowH / 2 }); y += rowH; }); gInfo.push({ g, y0, y1: y }); y += gGap; }
    if (s.title) { sInfo.push({ title: s.title, y0: sy, y1: y, n: s.groups.reduce((a, x) => a + x.runs.length, 0) }); y += 18; }
  }
  const H = y + 8, pos = new Map(rows.map((x) => [x.r.name, x]));
  const stepT = span > 2 * day ? day : span > 6 * 3600 ? 3 * 3600 : 3600;
  const g0 = new Date(t0 * 1000); g0.setMinutes(0, 0, 0); if (stepT === day) g0.setHours(0);
  let grid = "";
  for (let t = g0.getTime() / 1000; t <= t1; t += stepT) { const x = X(t); if (x < L - 1) continue;
    grid += `<line x1="${x}" x2="${x}" y1="${top0 - 8}" y2="${H}" class="tr-grid"/><text x="${x + 3}" y="${top0 - 14}" class="tr-axis">${new Date(t * 1000).toLocaleString(T.locale, stepT === day ? { month: "numeric", day: "numeric", weekday: "short" } : { month: "numeric", day: "numeric", hour: "2-digit" })}</text>`; }
  const sel = o.sel && pos.has(o.sel) ? o.sel : null;
  const kin = new Set(); if (sel) { kin.add(sel); const p = lin[sel]?.parent; if (p) kin.add(p); rows.forEach(({ r }) => { if (lin[r.name]?.parent === sel) kin.add(r.name); }); }
  let bands = "", edges = "", pts = "", labels = "";
  for (const s of sInfo) bands += `<rect x="1" y="${s.y0}" width="${W - 2}" height="${s.y1 - s.y0}" rx="10" class="tr-sec"/><text x="14" y="${s.y0 + 19}" class="tr-sec-t">${esc(s.title)} · ${T.n(s.n)}</text>`;
  for (const gi of gInfo) { const c = color(gi.g);
    bands += `<rect x="4" y="${gi.y0 - 4}" width="${W - 8}" height="${gi.y1 - gi.y0 + 8}" rx="8" fill="${c}" fill-opacity=".06"/><rect x="4" y="${gi.y0 - 4}" width="4" height="${gi.y1 - gi.y0 + 8}" rx="2" fill="${c}"/>`;
    labels += `<text x="16" y="${gi.y0 + 13}" class="tr-grp" fill="${c}">${esc(gi.g)}</text>`; }
  for (const { r, y, g } of rows) {
    const p = lin[r.name]?.parent, pp = p && pos.get(p); if (!pp) continue;
    const seed = isSeedChange(lin[r.name]?.change), xa = X(runStart(pp.r)), xb = X(runStart(r)), ya = pp.y, on = sel && kin.has(r.name) && kin.has(p);
    const rr = Math.min(6, Math.abs(y - ya) / 2, Math.max(0, xb - xa) / 2), dy = y > ya ? 1 : -1;
    const d = Math.abs(y - ya) < 1 ? `M${xa},${ya} H${xb}` : xb - xa < 1 ? `M${xa},${ya} V${y}` : `M${xa},${ya} V${y - dy * rr} Q${xa},${y} ${xa + rr},${y} H${xb}`;
    edges += `<path class="tr-edge" data-a="${esc(p)}" data-b="${esc(r.name)}" d="${d}" fill="none" stroke="${color(g)}" stroke-width="${on ? 3 : seed ? 1.2 : 2}" stroke-opacity="${sel && !on ? 0.15 : seed ? 0.5 : 0.8}" ${seed ? 'stroke-dasharray="3 3"' : ""}/>`;
  }
  for (const { r, y, g } of rows) {
    const c = color(g), x = X(runStart(r)), xe = X(r.updated_time || runStart(r)), bad = ["failed", "stopped"].includes(r.status), dim = sel && !kin.has(r.name);
    const heads = [r, ...((o.seeds && o.seeds.get(r.name)) || []).map((n) => state.byName.get(n)).filter(Boolean)], hk = headKey(r);
    const vs = heads.map((h) => h.summary?.last?.[hk]).filter((v) => typeof v === "number");
    const res = vs.length ? `${hk} ${fmtNum(vs.reduce((a, b) => a + b, 0) / vs.length)}${vs.length > 1 ? " " + T.seedMean(vs.length) : ""}` : "";
    const nm = r.name + (heads.length > 1 ? ` ×${heads.length}` : "");
    pts += `<g class="tr-run ${sel === r.name ? "sel" : ""}" data-tree-run="${esc(r.name)}" tabindex="0" role="button" opacity="${dim ? 0.35 : 1}">`
      + `<line x1="${x}" x2="${Math.max(xe, x + 2)}" y1="${y}" y2="${y}" stroke="${c}" stroke-width="5" stroke-opacity=".35" stroke-linecap="round"/>`
      + `<circle class="pt" cx="${x}" cy="${y}" r="6" fill="${bad ? "var(--surface)" : c}" stroke="${c}" stroke-width="2"/>`
      + `<text class="tr-lbl" x="${Math.max(xe, x) + 10}" y="${y + 4}">${esc(nm)}${r.status === "running" ? " ⏳" : ""}${o.hasVideo && o.hasVideo(r.name) ? " ▶" : ""}${res ? `<tspan class="tr-res" dx="14">${esc(res)}</tspan>` : ""}</text>`
      + `<title>${esc(r.name)}${lin[r.name]?.change ? "\n" + esc(lin[r.name].change) : ""}${lin[r.name]?.verdict ? "\n" + esc(lin[r.name].verdict) : ""}</title></g>`;
  }
  return { svg: `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="training tree">${bands}${grid}${edges}${pts}${labels}</svg>`,
    groups: allGroups, color, n: rows.length, order: rows.map((x) => x.r.name), top };
}
function renderTree() {
  const root = $("#tree-root"); if (!root) return;
  const T = state.tree, sh = T.share;
  const runs = state.runs.filter((r) => runStart(r) && (T.archived || !r.notes?.archived));
  if (!runs.length) { root.innerHTML = '<div class="empty-state">실행이 없습니다</div>'; return; }
  const B = treeBuild(runs, treeLin(runs), { sel: T.sel, order: T.order, availW: Math.max(900, root.clientWidth - 34) });
  const sel = T.sel && B.order.includes(T.sel) ? T.sel : null;
  root.innerHTML = `<header><h3>학습 트리 <span class="hint">실행 ${B.n}개</span></h3>
      <p>가로 = 시간 (점은 학습 시작, 막대는 학습 기간), 줄 하나 = 실행 하나, 색 = 폴더. 연결선은 부모 실행에서 무엇을 바꿔 이 실행을 했는지 (실선 = 설정 변경, 점선 = 시드만 변경), 속 빈 점 = 중단·실패. 점을 누르면 목적·바꾼 설정·결과·그래프·파일이 열리고, 거기서 부모·바꾼 것·결과 평가를 적을 수 있습니다.</p></header>
    <div class="tr-legend">${B.groups.map((g) => `<span><i style="background:${B.color(g)}"></i>${esc(g)}</span>`).join("")}
      <span class="tr-ctl"><button class="chip" type="button" data-tree-order="lineage" aria-pressed="${T.order !== "folder"}">계보 순</button><button class="chip" type="button" data-tree-order="folder" aria-pressed="${T.order === "folder"}">폴더 번호 순</button>
      <label class="toggle"><input type="checkbox" id="tree-archived" ${T.archived ? "checked" : ""}> 보관함 실행도</label></span></div>
    <details class="tr-share"><summary>공유용 HTML 받기</summary><div class="tr-share-body">
      <p class="hint">파일 하나로 받아 그대로 보내면 됩니다. 받은 사람은 브라우저로 열어 점을 눌러 설명을 봅니다 (대시보드 접속 필요 없음).</p>
      <label class="toggle"><input type="checkbox" data-share="key" ${sh.key ? "checked" : ""}> 핵심 경로만 <span class="hint">즐겨찾기(★) 실행까지 이어진 줄기 + 거기서 갈라진 한 단계</span></label>
      <label class="toggle"><input type="checkbox" data-share="fold" ${sh.fold ? "checked" : ""}> 시드 반복 접기 <span class="hint">"시드…"로 적은 실행을 부모 한 줄로, 숫자는 평균</span></label>
      <label class="toggle"><input type="checkbox" data-share="hideStopped" ${sh.hideStopped ? "checked" : ""}> 중단된 실행 숨기기 <span class="hint">기록이 없거나 다시 시작한 실행</span></label>
      <label class="toggle"><input type="checkbox" data-share="video" ${sh.video ? "checked" : ""}> 영상 넣기 <span class="hint">설명 패널과 "영상 비교"에 들어감 (파일이 커짐). 이름에 cmp가 들어간 영상을 먼저 씀</span></label>
      <span class="chips" role="group" aria-label="언어">언어 <button class="chip" type="button" data-share-lang="ko" aria-pressed="${sh.lang !== "en"}">한국어</button><button class="chip" type="button" data-share-lang="en" aria-pressed="${sh.lang === "en"}">English</button></span>
      <div><button class="btn primary" type="button" data-tree-export>HTML 받기</button> <span class="hint" id="tree-export-state"></span></div></div></details>
    <div class="tr-canvas">${B.svg}</div>
    <aside class="tr-side" id="tree-side" ${sel ? "" : "hidden"} aria-label="실행 설명"></aside>`;
  if (sel) renderTreeSide(state.byName.get(sel), B.color(B.top(state.byName.get(sel))));
}
function miniChart(series) {
  const all = series.flatMap((s) => s.points); if (!all.length) return "";
  const W = 400, H = 120, l = 40, r = 8, t = 8, b = 18;
  const x0 = Math.min(...all.map((p) => p.x)), x1 = Math.max(...all.map((p) => p.x)), y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
  const X = (v) => l + (v - x0) / (x1 - x0 || 1) * (W - l - r), Y = (v) => t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - t - b);
  return `<svg class="tr-mini" viewBox="0 0 ${W} ${H}" width="100%">${[y0, (y0 + y1) / 2, y1].map((v) => `<line x1="${l}" x2="${W - r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${l - 4}" y="${Y(v) + 3}" text-anchor="end">${fmtNum(v)}</text>`).join("")}
    <text x="${l}" y="${H - 3}">${fmtNum(x0)}</text><text x="${W - r}" y="${H - 3}" text-anchor="end">${fmtNum(x1)}</text>
    ${series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="4 3"' : ""} points="${downsample(s.points, 300).map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}"/>`).join("")}</svg>
    <div class="hint">${series.map((s) => `<span style="color:${s.color}">${s.dash ? "┄" : "━"}</span> ${esc(s.name)}`).join(" &nbsp; ")}</div>`;
}
async function treeFiles(n) { const T = state.tree; if (!T.files.has(n)) { try { T.files.set(n, (await api.files(n)).files || []); } catch { T.files.set(n, []); } } return T.files.get(n); }
const treeVideos = (fs) => fs.filter((f) => /\.(mp4|webm)$/i.test(f.path)).sort((a, b) => (/cmp/i.test(b.path) - /cmp/i.test(a.path)) || (b.mtime || 0) - (a.mtime || 0));
// drawer body as an HTML string; ctx: {lin, shown, seeds, lang, embedVideo(run, file) -> src | null}
async function treeSideHTML(r, c, ctx) {
  const T = TREE_T[ctx.lang || "ko"], lin = ctx.lin, me = lin[r.name] || {}, n = r.notes || {};
  const par = me.parent && state.byName.get(me.parent) ? me.parent : "";
  const kids = Object.entries(lin).filter(([, v]) => v.parent === r.name).map(([k]) => k).filter((k) => !ctx.shown || ctx.shown.has(k));
  const seeds = (ctx.seeds && ctx.seeds.get(r.name)) || [];
  const keys = (state.config?.headline || []).length ? state.config.headline : Object.keys(r.summary?.last || {}).filter((k) => !META_KEYS.has(k)).slice(0, 6);
  const L1 = r.summary?.last || {}, L0 = par ? state.byName.get(par).summary?.last || {} : null;
  let res = keys.length ? `<table class="tr-tbl"><thead><tr><th>${T.metric}</th>${L0 ? `<th>${T.parent}</th>` : ""}<th>${T.thisRun}</th></tr></thead><tbody>${keys.map((k) => `<tr><td class="mono">${esc(k)}</td>${L0 ? `<td>${fmtNum(L0[k])}</td>` : ""}<td><b>${fmtNum(L1[k])}</b></td></tr>`).join("")}</tbody></table>` : `<span class="hint">${T.noMetrics}</span>`;
  if (seeds.length && keys.length) {
    const all = [r, ...seeds.map((x) => state.byName.get(x)).filter(Boolean)];
    const ms = (k) => { const v = all.map((x) => x.summary?.last?.[k]).filter((x) => typeof x === "number"); if (!v.length) return "–"; const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : 0; return `${fmtNum(m)} ± ${fmtNum(sd)}`; };
    res += `<h5>${T.seeds(all.length)}</h5><table class="tr-tbl"><thead><tr><th>${T.run}</th>${keys.slice(0, 3).map((k) => `<th class="mono">${esc(k)}</th>`).join("")}</tr></thead><tbody>${all.map((x) => `<tr><td class="mono">${esc(x.name)}</td>${keys.slice(0, 3).map((k) => `<td>${fmtNum(x.summary?.last?.[k])}</td>`).join("")}</tr>`).join("")}<tr><td><b>${T.meanSd}</b></td>${keys.slice(0, 3).map((k) => `<td><b>${ms(k)}</b></td>`).join("")}</tr></tbody></table>`;
  }
  await Promise.all([loadMetrics(r.name), par ? loadMetrics(par) : null]);
  const pk = keys[0], s1 = pk ? series(r.name, pk) : [], s0 = pk && par ? series(par, pk) : [];
  const plot = s1.length ? `<div class="hint mono">${esc(pk)}</div>` + miniChart([...(s0.length ? [{ name: T.parent + " " + par, color: "#94a3b8", dash: true, points: s0 }] : []), { name: T.thisRun, color: c, points: s1 }]) : `<span class="hint">${T.noMetrics}</span>`;
  let diff = "";
  if (par) {
    const cfgOf = async (x) => { const TT = state.tree; if (!TT.cfg.has(x)) { try { TT.cfg.set(x, (await api.runConfig(x)).flat || {}); } catch { TT.cfg.set(x, {}); } } return TT.cfg.get(x); };
    const [c1, c0] = await Promise.all([cfgOf(r.name), cfgOf(par)]);
    const show = (v) => (v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v));
    const ks = Object.keys({ ...c0, ...c1 }).filter((k) => show(c0[k]) !== show(c1[k]) && !/(^|\.)(seed|device|run_name|name)$/.test(k));
    diff = ks.length ? `<table class="tr-tbl"><tbody>${ks.slice(0, 30).map((k) => `<tr><td class="mono">${esc(k)}</td><td>${esc(show(c0[k]))} → <span class="tr-chg">${esc(show(c1[k]))}</span></td></tr>`).join("")}</tbody></table>${ks.length > 30 ? `<span class="hint">${T.more(ks.length - 30)}</span>` : ""}` : `<span class="hint">${T.sameCfg}</span>`;
  }
  const fs = await treeFiles(r.name), vids = treeVideos(fs), imgs = fs.filter((f) => /\.(png|jpe?g|gif|svg|webp)$/i.test(f.path));
  const vsrc = await Promise.all(vids.slice(0, ctx.videoLimit || 3).map((f) => (ctx.embedVideo ? ctx.embedVideo(r.name, f) : api.fileUrl(r.name, f.path))));
  const files = vids.slice(0, ctx.videoLimit || 3).map((f, i) => (vsrc[i] ? `<video src="${vsrc[i]}" controls preload="metadata" playsinline></video><span class="hint mono">${esc(f.path)}</span>` : "")).join("")
    + (imgs.length && !ctx.noImages ? `<div class="tr-imgs">${imgs.slice(-4).map((f) => `<img src="${api.fileUrl(r.name, f.path)}" alt="${esc(f.path)}" loading="lazy">`).join("")}</div>` : "");
  return `<div class="tr-folder" style="color:${c}">${esc(n.folder || T.noFolder)}</div><h4 class="mono">${esc(r.name)}${seeds.length ? ` <span class="hint">${T.plusSeeds(seeds.length)}</span>` : ""}</h4>
    <div class="tr-nav">${par ? `<span class="hint">${T.parent}</span><button type="button" data-tree-run="${esc(par)}">↑ ${esc(par)}</button>` : `<span class="hint">${T.root}</span>`}${kids.length ? `<span class="hint">${T.next}</span>${kids.map((k) => `<button type="button" data-tree-run="${esc(k)}">↓ ${esc(k)}</button>`).join("")}` : ""}</div>
    ${n.goal ? `<h5>${T.goal}</h5><div class="tr-goal">${esc(n.goal)}</div>` : ""}
    <h5>${T.change} ${par ? `<span class="hint">${T.vsParent}</span>` : ""}</h5><div>${esc(me.change || "–")}</div>${diff}
    <h5>${T.verdict}</h5><div class="tr-verdict">${esc(me.verdict || "–")}</div>
    <h5>${T.results}</h5>${res}
    <h5>${T.graph}</h5><div class="tr-plots">${plot}</div>
    <h5>${T.files}</h5>${files || `<span class="hint">${T.noFiles}</span>`}
    ${n.note ? `<h5>${T.note}</h5><div>${esc(n.note)}</div>` : ""}`;
}
async function renderTreeSide(r, c) {
  const side = $("#tree-side"); if (!side || !r) return;
  const n = r.notes || {};
  side.hidden = false; side.style.setProperty("--trc", c);
  side.innerHTML = `<button class="btn tr-close" type="button" data-tree-close>닫기 ✕</button><span class="hint">불러오는 중…</span>`;
  const body = await treeSideHTML(r, c, { lin: treeLin(state.runs) });
  if (state.tree.sel !== r.name || !$("#tree-side")) return;
  side.innerHTML = `<button class="btn tr-close" type="button" data-tree-close>닫기 ✕</button>${body}
    <details class="tr-edit"><summary>계보·평가 고치기</summary>
      <label>부모 실행<select class="field" id="tree-e-parent"><option value="">(없음: 출발점)</option>${state.runs.filter((x) => x.name !== r.name).map((x) => `<option ${x.name === n.parent ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
      <label>바꾼 것 <span class="hint">"시드만 다름"으로 쓰면 점선</span><input class="field" id="tree-e-change" value="${esc(n.change || "")}" placeholder="예: 학습률 1e-3 → 3e-4"></label>
      <label>결과 평가<textarea class="field" id="tree-e-verdict" placeholder="예: 채택. 검증 정확도 +2%p">${esc(n.verdict || "")}</textarea></label>
      <button class="btn primary" type="button" data-tree-save>저장</button></details>
    <a class="btn" href="?project=${encodeURIComponent(state.project)}&run=${encodeURIComponent(r.name)}#runs">실행 화면에서 보기</a>`;
}
// ---- shareable HTML: one self-contained file (tree + every drawer + optional videos)
async function exportTree(opt) {
  const st = (t) => { const el = $("#tree-export-state"); if (el) el.textContent = t; };
  const lang = opt.lang === "en" ? "en" : "ko", T = TREE_T[lang];
  const all = state.runs.filter((r) => runStart(r) && !r.notes?.archived), byName = new Map(all.map((r) => [r.name, r])), lin0 = treeLin(all);
  let keep = new Set(all.map((r) => r.name));
  if (opt.key) {   // starred runs and their ancestors, + one step of branches off that path, + their seed repeats
    const K = all.filter((r) => r.notes?.star).map((r) => r.name);
    if (K.length) {
      const path = new Set(); for (const k of K) { let n = k; while (n && byName.has(n) && !path.has(n)) { path.add(n); n = lin0[n]?.parent; } }
      keep = new Set(path);
      for (const r of all) { const p = lin0[r.name]?.parent; if (p && path.has(p)) keep.add(r.name); }
      for (let i = 0; i < 3; i++) for (const r of all) { const p = lin0[r.name]?.parent; if (p && keep.has(p) && isSeedChange(lin0[r.name]?.change)) keep.add(r.name); }
    }
  }
  const dead = (r) => ["stopped", "failed"].includes(r.status) && (!r.summary?.rows || all.some((x) => lin0[x.name]?.parent === r.name && /^(같은 설정|same|restart)/i.test(lin0[x.name]?.change || "")));
  if (opt.hideStopped) for (const r of all) if (dead(r)) keep.delete(r.name);
  const seeds = new Map(), folded = new Set();
  if (opt.fold) for (const r of all) {
    if (!keep.has(r.name) || !isSeedChange(lin0[r.name]?.change)) continue;
    let head = lin0[r.name]?.parent; while (head && isSeedChange(lin0[head]?.change) && lin0[head]?.parent) head = lin0[head].parent;
    if (!head || !keep.has(head) || head === r.name) continue;
    folded.add(r.name); if (!seeds.has(head)) seeds.set(head, []); seeds.get(head).push(r.name);
  }
  const shownRuns = all.filter((r) => keep.has(r.name) && !folded.has(r.name)), shown = new Set(shownRuns.map((r) => r.name));
  const lin = {};
  for (const r of shownRuns) { let p = lin0[r.name]?.parent; while (p && !shown.has(p)) p = lin0[p]?.parent; lin[r.name] = { ...lin0[r.name], parent: p || "" }; }
  // videos: fetched once, shared by drawers and the comparison grid
  const V = {};
  if (opt.video) {
    let k = 0;
    for (const r of shownRuns) {
      const f = treeVideos(await treeFiles(r.name))[0]; if (!f) continue;
      st(`${lang === "en" ? "Packing videos" : "영상 넣는 중"} ${++k}…`);
      const b = await (await fetch(api.fileUrl(r.name, f.path))).blob();
      V[r.name] = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
    }
  }
  const B = treeBuild(shownRuns, lin, { order: "lineage", availW: 1400, seeds, hasVideo: (n) => !!V[n], lang });
  const sides = {}; let i = 0;
  for (const r of shownRuns) {
    st(`${lang === "en" ? "Writing details" : "설명 만드는 중"} ${++i}/${shownRuns.length}…`);
    sides[r.name] = await treeSideHTML(r, B.color(B.top(r)), { lin, shown, seeds, lang, videoLimit: 1, noImages: true, embedVideo: (n) => (V[n] ? `__VID__${n}` : null) });
  }
  const vidRuns = B.order.filter((n) => V[n]);
  const card = (n) => { const r = byName.get(n), c = B.color(B.top(r)), hk = headKey(r), hs = [r, ...(seeds.get(n) || []).map((x) => byName.get(x))].map((x) => x?.summary?.last?.[hk]).filter((v) => typeof v === "number");
    return `<figure class="vc" style="--vc:${c}"><figcaption><span class="vc-step" style="color:${c}">${esc(B.top(r))}</span><button type="button" class="vc-name" data-rt="${esc(n)}">${esc(n)}${hs.length > 1 ? ` ×${hs.length}` : ""}</button><span class="vc-chg">${esc(lin[n]?.change || "")}</span></figcaption>
      <video data-vid="${esc(n)}" muted playsinline preload="metadata" controls></video>${hs.length ? `<div class="vc-m"><span class="mono">${esc(hk)}</span> <b>${fmtNum(hs.reduce((a, b) => a + b, 0) / hs.length)}</b>${hs.length > 1 ? ` <span>${T.seedMean(hs.length)}</span>` : ""}</div>` : ""}</figure>`; };
  const cmpHTML = vidRuns.length ? `<section class="cmp"><h2>${lang === "en" ? "Videos side by side" : "영상 비교"}</h2><div class="cmp-ctl"><button type="button" data-cmp="play">${lang === "en" ? "▶ Play all together" : "▶ 모두 같이 재생"}</button><button type="button" data-cmp="pause">${lang === "en" ? "❚❚ Pause all" : "❚❚ 모두 정지"}</button><button type="button" data-cmp="restart">${lang === "en" ? "↺ Back to start" : "↺ 처음으로"}</button></div><div class="vgrid">${vidRuns.map(card).join("")}</div></section>` : "";
  const parents = Object.fromEntries(Object.entries(lin).map(([k, v]) => [k, v.parent]));
  const stamp = new Date().toISOString().slice(0, 10), title = state.config?.title || "Runboard";
  const css = `:root{--bg:#f4f6f8;--surface:#fff;--surface-2:#eef1f4;--fg:#12161c;--fg-2:#4a5462;--muted:#6e7887;--line:#dde2e8;--good:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#121519;--surface:#1a1e23;--surface-2:#22272e;--fg:#eef1f4;--fg-2:#c0c8d2;--muted:#8e98a5;--line:#2c333b;--good:#4ade80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}header{padding:20px 24px 8px;max-width:1200px}h1{font-size:22px;margin:0 0 6px}header p{margin:4px 0;color:var(--fg-2)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--fg-2);padding:6px 24px 10px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.canvas{margin:0 16px 24px;overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--surface)}.canvas svg{display:block}.canvas text{font-family:ui-monospace,monospace;font-size:10.5px;fill:var(--fg-2)}
.tr-grp,.tr-sec-t{font-family:system-ui,sans-serif!important}.tr-grp{font-size:12px!important;font-weight:600}.tr-sec{fill:none;stroke:var(--fg-2);stroke-opacity:.35;stroke-dasharray:6 4}.tr-sec-t{font-size:14px!important;font-weight:700;fill:var(--fg)!important}.tr-grid{stroke:var(--line);stroke-dasharray:2 4}.tr-res,.tr-axis{fill:var(--muted)!important}
.tr-run{cursor:pointer}.tr-run:hover .tr-lbl,.tr-run.sel .tr-lbl{fill:var(--fg);font-weight:600}.tr-run.sel .pt{stroke:var(--fg);stroke-width:2.5}
aside{position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);overflow-y:auto;background:var(--surface);border-left:1px solid var(--line);box-shadow:-8px 0 24px rgba(0,0,0,.15);padding:14px 16px 40px;font-size:13px;display:flex;flex-direction:column;gap:8px;z-index:5}aside[hidden]{display:none}
aside h4{margin:0;font-size:13.5px;overflow-wrap:anywhere}aside h5{margin:6px 0 0;font-size:12px;color:var(--muted)}.close{position:sticky;top:0;align-self:flex-end;margin-bottom:-28px;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:6px;padding:2px 10px;cursor:pointer;font:inherit}
.tr-folder{font-size:12px;font-weight:600}.tr-nav{display:flex;flex-wrap:wrap;gap:4px;align-items:center}.tr-nav button{font:12px ui-monospace,monospace;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:4px;padding:1px 6px;cursor:pointer}
.tr-goal{background:var(--surface-2);border-radius:6px;padding:6px 8px}.tr-verdict{border-left:3px solid var(--trc,var(--fg-2));background:var(--surface-2);border-radius:0 6px 6px 0;padding:4px 8px;white-space:pre-wrap}.tr-chg{color:var(--good);font-weight:600}.hint{font-size:11.5px;color:var(--muted)}.mono{font-family:ui-monospace,monospace}
.tr-tbl{width:100%;border-collapse:collapse;font-size:12.5px}.tr-tbl td,.tr-tbl th{padding:2px 4px;text-align:right;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.tr-tbl td:first-child,.tr-tbl th:first-child{text-align:left}.tr-plots svg{display:block;width:100%;height:auto}.tr-mini text{font-size:10px;fill:var(--muted)}video{width:100%;border-radius:6px;background:#000;display:block}
.cmp{margin:0 16px 48px}.cmp h2{font-size:19px;margin:8px 0}.cmp-ctl{display:flex;gap:6px;margin:8px 0}.cmp-ctl button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--surface);color:var(--fg);border-radius:6px;padding:4px 12px;cursor:pointer}
.vgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.vc{margin:0;background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--vc);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.vc figcaption{display:flex;flex-direction:column;gap:2px}.vc-step{font-size:11.5px;font-weight:600}.vc-name{all:unset;cursor:pointer;font:600 13px ui-monospace,monospace;overflow-wrap:anywhere}.vc-name:hover{text-decoration:underline}.vc-chg{font-size:12.5px;color:var(--fg-2)}.vc-m{font-size:12px;color:var(--fg-2)}.vc-m b{color:var(--fg)}`;
  const script = `const S=${JSON.stringify(sides).replace(/</g, "\\u003c")},P=${JSON.stringify(parents).replace(/</g, "\\u003c")},C=${JSON.stringify(Object.fromEntries(shownRuns.map((r) => [r.name, B.color(B.top(r))])))},V=${JSON.stringify(V)};
const side=document.getElementById("side"),fill=(h)=>h.replace(/__VID__([^"]+)/g,(m,k)=>V[k]||"");
document.querySelectorAll("video[data-vid]").forEach(v=>{v.src=V[v.dataset.vid]||"";v.addEventListener("loadeddata",()=>{if(v.currentTime===0)v.currentTime=1;},{once:true});});
function sel(n){const kin=new Set();if(n){kin.add(n);if(P[n])kin.add(P[n]);for(const k in P)if(P[k]===n)kin.add(k);}
document.querySelectorAll(".tr-run").forEach(g=>{g.setAttribute("opacity",!n||kin.has(g.dataset.treeRun)?1:.3);g.classList.toggle("sel",g.dataset.treeRun===n);});
document.querySelectorAll(".tr-edge").forEach(e=>{const on=n&&kin.has(e.dataset.a)&&kin.has(e.dataset.b);e.style.strokeOpacity=!n?"":on?1:.12;e.style.strokeWidth=on?3:"";});
if(!n){side.hidden=true;return;}side.hidden=false;side.style.setProperty("--trc",C[n]);side.innerHTML='<button class="close" data-close>${lang === "en" ? "Close" : "닫기"} ✕</button>'+fill(S[n]);side.scrollTop=0;}
const vids=()=>[...document.querySelectorAll(".cmp video")];
document.addEventListener("click",e=>{if(e.target.closest("[data-close]"))return sel(null);const c=e.target.closest("[data-cmp]");if(c){const a=c.dataset.cmp;vids().forEach(v=>{if(a!=="pause")v.currentTime=0;if(a==="play")v.play();else v.pause();});return;}
const g=e.target.closest("[data-tree-run],[data-rt]");if(g){const k=g.dataset.treeRun||g.dataset.rt;if(S[k])sel(k);}});
document.addEventListener("keydown",e=>{if(e.key==="Escape")sel(null);const g=e.target.closest&&e.target.closest(".tr-run");if(g&&(e.key==="Enter"||e.key===" ")){e.preventDefault();sel(g.dataset.treeRun);}});`;
  const how = lang === "en"
    ? `<p>Training runs laid out by time and lineage. <b>Click a point</b> for its goal, what was changed, the verdict, key metrics against its parent and a training curve${vidRuns.length ? "; the videos are also side by side below the tree" : ""}.</p><p class="hint">x axis = time (point = start, bar = training span) · row = run · colour = top-level folder · link = made from the parent by changing a setting (dashed: seed only) · ×3 = same setting with 3 seeds (numbers are the mean)</p><p class="hint">${B.n} of ${all.length} runs · exported ${stamp} from ${esc(title)}</p>`
    : `<p>학습 실행을 시간과 계보로 정리했습니다. <b>점을 누르면</b> 목적, 바꾼 것, 결과 평가, 부모 대비 핵심 지표, 학습 곡선이 열립니다${vidRuns.length ? ". 영상은 트리 아래에 나란히도 있습니다" : ""}.</p><p class="hint">가로 = 시간 (점은 시작, 막대는 학습 기간) · 줄 = 실행 · 색 = 맨 앞 폴더 · 연결선 = 부모에서 설정을 바꿔 이 실행을 함 (점선은 시드만 바꿈) · ×3 = 같은 설정을 시드 3개로 (숫자는 평균)</p><p class="hint">실행 ${B.n}개 표시 (전체 ${all.length}개) · ${stamp} ${esc(title)}에서 내보냄</p>`;
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${lang === "en" ? "Training tree" : "학습 트리"} · ${esc(title)}</title><style>${css}</style></head><body>
<header><h1>${lang === "en" ? "Training tree" : "학습 트리"} · ${esc(title)}</h1>${how}</header><div class="legend">${B.groups.map((g) => `<span><i style="background:${B.color(g)}"></i>${esc(g)}</span>`).join("")}</div>
<div class="canvas">${B.svg}</div>${cmpHTML}<aside id="side" hidden></aside><script>${script}<\/script></body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" }), a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${lang === "en" ? "training-tree" : "학습트리"}-${stamp}.html`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  st(`${lang === "en" ? "Downloaded" : "받았습니다"} (${(html.length / 1e6).toFixed(1)} MB, ${B.n} / ${vidRuns.length} ${lang === "en" ? "runs / videos" : "실행 / 영상"})`);
}

// ============================================================== GPUs
async function renderGpus() {
  try {
    const { gpus } = await api.gpus();
    $("#gpus").innerHTML = (gpus || []).map((g) => { const f = g.used / g.total; return `<span class="gpu ${f > 0.9 ? "full" : g.util > 10 ? "busy" : ""}" title="${esc(g.name)} · 메모리 ${(g.used / 1024).toFixed(1)}/${(g.total / 1024).toFixed(0)} GB · ${g.temp}°C">GPU${g.index} ${g.util}% · ${(g.used / 1024).toFixed(1)}G</span>`; }).join("");
  } catch { $("#gpus").innerHTML = ""; }
}

// ============================================================== render & routing
function render(fromPoll = false) {
  renderRoster(); if (!(fromPoll && editing())) renderFocus(); renderTabs(); renderTab(fromPoll);
}
const editing = () => { const a = document.activeElement; return a && a.matches?.("input:not([type=checkbox]):not([type=range]), textarea, select") && a.closest("#focus, #run-list, #view-board, #view-reports, .controls"); };
function applyHash() {
  const v = (location.hash.slice(1).split("/")[0] || "runs");
  state.view = ["runs", "reports", "board"].includes(v) ? v : "runs";
  $$(".views a").forEach((a) => a.dataset.view === state.view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
  $("#view-runs").hidden = state.view !== "runs"; $("#view-reports").hidden = state.view !== "reports"; $("#view-board").hidden = state.view !== "board";
  if (state.view === "reports") renderReports();
  if (state.view === "board") loadBoard().then(renderBoard);
  if (state.view === "runs") render();
}
function applyTheme() {
  const t = store.get("theme", "auto");
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  $("#theme").textContent = { auto: "자동", light: "밝게", dark: "어둡게" }[t];
}

// ============================================================== events
function wire() {
  $("#theme").addEventListener("click", () => { const t = store.get("theme", "auto"); store.set("theme", { auto: "light", light: "dark", dark: "auto" }[t]); applyTheme(); if (state.view === "runs") renderTab(); });
  window.addEventListener("hashchange", applyHash);
  $("#run-search").addEventListener("input", (e) => { state.query = e.target.value; renderRoster(); });
  $("#status-chips").addEventListener("click", (e) => { const b = e.target.closest("[data-filter]"); if (b) { state.statusFilter = b.dataset.filter; renderRoster(); } });
  $("#toggle-archived").addEventListener("click", () => { state.showArchived = !state.showArchived; state.statusFilter = "all"; state.moveSel.clear(); renderRoster(); });

  const list = $("#run-list");
  list.addEventListener("input", (e) => { if (e.target.closest("#fold-new")) state.folderDraft = e.target.value; });
  list.addEventListener("submit", async (e) => {
    if (e.target.id !== "fold-new") return; e.preventDefault();
    const name = e.target.name.value.split("/").map((x) => x.trim()).filter(Boolean).join("/"); if (!name) return;
    if (allFolders().includes(name)) return toast("이미 있는 폴더입니다");
    await saveFolders([...state.folders, name]); state.folderDraft = ""; toast(`"${name}" 폴더를 만들었습니다`); renderRoster();
  });
  list.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-fold]")?.dataset.fold;
    if (act) {
      e.preventDefault(); e.stopPropagation();
      const f = e.target.closest(".folder")?.dataset.folder, inside = (x) => x === f || x.startsWith(f + "/");
      if (act === "toggle") { state.folderClosed.has(f) ? state.folderClosed.delete(f) : state.folderClosed.add(f); store.set("folder-closed", [...state.folderClosed]); return renderRoster(); }
      if (act === "move") { const to = $("#fold-move-to").value, n = await moveRuns(pickedForMove(), to); state.moveSel.clear(); toast(`${n}개를 ${to ? `"${to}"` : "폴더 없음"}으로 옮겼습니다`); return render(); }
      if (act === "rename") {
        const nn = (prompt("새 폴더 이름 (/ 로 하위 폴더)", f) || "").split("/").map((x) => x.trim()).filter(Boolean).join("/");
        if (!nn || nn === f) return; if (allFolders().includes(nn)) return toast("이미 있는 폴더 이름입니다"); if (nn.startsWith(f + "/")) return toast("폴더를 자기 안으로 옮길 수 없습니다");
        const ren = (x) => nn + x.slice(f.length), old = allFolders().filter(inside);
        for (const r of state.runs.filter((r) => r.notes?.folder && inside(r.notes.folder))) await saveNotes(r, { folder: ren(r.notes.folder) });
        await saveFolders(state.folders.filter((x) => !inside(x)).concat(old.map(ren))); toast(`"${f}" → "${nn}"`); return render();
      }
      if (act === "delete") {
        const rs = state.runs.filter((r) => r.notes?.folder && inside(r.notes.folder));
        if (!confirm(`"${f}" 폴더를 삭제할까요?${rs.length ? ` 안의 실행 ${rs.length}개는 '폴더 없음'으로 옮겨집니다 (실행은 지워지지 않습니다).` : ""}`)) return;
        await moveRuns(rs.map((r) => r.name), ""); await saveFolders(state.folders.filter((x) => !inside(x))); toast(`"${f}" 폴더를 삭제했습니다`); return render();
      }
      return;
    }
    const li = e.target.closest(".run"); if (!li) return;
    const name = li.dataset.run;
    if (e.target.classList.contains("pick")) {
      if (state.showArchived) { e.target.checked ? state.moveSel.add(name) : state.moveSel.delete(name); return renderRoster(); }
      if (e.target.checked) { if (state.selected.length >= MAX_SELECTED) { e.target.checked = false; return toast(`한 번에 ${MAX_SELECTED}개까지 비교합니다`); } state.selected.push(name); }
      else state.selected = state.selected.filter((n) => n !== name);
    } else {
      state.focus = name;
      if (!state.selected.includes(name) && state.selected.length < MAX_SELECTED) state.selected.push(name);
    }
    persist(); await loadMetrics(name); render();
  });
  list.addEventListener("dragstart", (e) => { const li = e.target.closest(".run"); if (li) { e.dataTransfer.setData("text/x-run", li.dataset.run); e.dataTransfer.effectAllowed = "move"; } });
  list.addEventListener("dragover", (e) => { const fo = e.target.closest(".folder"); if (!fo || !e.dataTransfer.types.includes("text/x-run")) return; e.preventDefault(); $$(".folder.drop", list).forEach((x) => x !== fo && x.classList.remove("drop")); fo.classList.add("drop"); });
  list.addEventListener("dragleave", (e) => { const fo = e.target.closest(".folder"); if (fo && !fo.contains(e.relatedTarget)) fo.classList.remove("drop"); });
  list.addEventListener("drop", async (e) => {
    const fo = e.target.closest(".folder"); if (!fo) return; e.preventDefault(); fo.classList.remove("drop");
    const name = e.dataTransfer.getData("text/x-run"); if (!name) return;
    const names = pickedForMove().includes(name) ? pickedForMove() : [name];
    const n = await moveRuns(names, fo.dataset.folder); if (names.length > 1) state.moveSel.clear();
    toast(`${n}개를 ${fo.dataset.folder ? `"${fo.dataset.folder}"` : "폴더 없음"}으로 옮겼습니다`); render();
  });

  const focus = $("#focus");
  const save = async (patch) => { const r = state.byName.get(state.focus); if (!r) return; const st = $("#save-state"); if (st) st.textContent = "저장 중…";
    try { await saveNotes(r, patch); const el = $("#save-state"); if (el) el.textContent = "저장됨"; } catch (e) { const el = $("#save-state"); if (el) el.textContent = "저장 실패: " + e.message; } };
  focus.addEventListener("click", async (e) => {
    const r = state.byName.get(state.focus); if (!r) return;
    if (e.target.id === "btn-star") { await save({ star: !r.notes?.star }); renderRoster(); renderFocus(); }
    if (e.target.id === "btn-archive") { const a = !r.notes?.archived; await save({ archived: a }); toast(a ? "보관함으로 옮겼습니다" : "실행 목록으로 되돌렸습니다"); renderRoster(); renderFocus(); }
    const cp = e.target.closest("[data-color]"); if (cp) { const c = +cp.dataset.color; await save({ color: c || null }); render(); }
  });
  focus.addEventListener("change", async (e) => {
    if (e.target.id === "tags-input") { await save({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }); renderRoster(); }
    if (e.target.id === "goal-input") await save({ goal: e.target.value.trim() });
    if (e.target.id === "note-input") await save({ note: e.target.value });
    if (e.target.id === "folder-select") { await moveRuns([state.focus], e.target.value); toast(e.target.value ? `"${e.target.value}" 폴더로 옮겼습니다` : "폴더에서 뺐습니다"); render(); }
  });

  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (!b) return; state.tab = b.dataset.tab; store.set("tab", state.tab); renderTabs(); renderTab(); });
  const body = $("#tab-body");
  body.addEventListener("click", (e) => { const g = e.target.closest("[data-group]"); if (g) { state.group = g.dataset.group; renderTab(); } });
  body.addEventListener("input", (e) => {
    if (e.target.id === "smoothing") { state.smoothing = +e.target.value; $("#smoothing-val").textContent = state.smoothing.toFixed(2); store.set("smoothing", state.smoothing); clearTimeout(wire.t); wire.t = setTimeout(() => renderTab(), 80); }
    if (e.target.id === "metric-search") { state.metricQuery = e.target.value; clearTimeout(wire.m); wire.m = setTimeout(() => { renderTab(); const el = $("#metric-search"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, 250); }
    if (e.target.id === "cfg-search") { state.cfgQuery = e.target.value; clearTimeout(wire.c); wire.c = setTimeout(async () => { await renderTab(); const el = $("#cfg-search"); el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, 250); }
  });
  body.addEventListener("change", (e) => {
    if (e.target.id === "x-axis") { state.xKey = e.target.value; store.set("xKey", state.xKey); renderTab(); }
    if (e.target.id === "compare-mode") { state.compareMode = e.target.value; renderTab(); }
    if (e.target.id === "cfg-diff") { state.diffOnly = e.target.checked; renderTab(); }
  });

  // reports
  const rep = $("#view-reports");
  rep.addEventListener("click", async (e) => {
    const item = e.target.closest("[data-report]"); if (item) { location.hash = "reports/" + encodeURIComponent(item.dataset.report); return; }
    const act = e.target.closest("[data-act]")?.dataset.act; if (!act) return;
    if (act === "new-report") { state.editing = null; location.hash = "reports/new"; if (location.hash === "#reports/new") renderReports(); }
    if (act === "edit-report" && state.report) { state.editing = { ...state.report }; renderEditor(rep); }
    if (act === "cancel-report") { state.editing = null; location.hash = state.report ? "reports/" + encodeURIComponent(state.report.id) : "reports"; renderReports(); }
    if (act === "delete-report" && state.report && confirm(`"${state.report.title}" 리포트를 삭제할까요?`)) { await api.deleteReport(state.report.id); state.report = null; location.hash = "reports"; renderReports(); }
    if (act === "save-report") {
      const r = state.editing; r.title = $("#rep-title").value.trim() || "제목 없음"; r.author = $("#rep-author").value.trim(); r.body = $("#rep-body").value; store.set("author", r.author);
      try { const saved = await api.saveReport(r.id, r); state.editing = null; toast("저장했습니다"); location.hash = "reports/" + encodeURIComponent(saved.id); renderReports(); } catch (err) { toast("저장하지 못했습니다: " + err.message); }
    }
    if (act === "insert-chart") {
      const names = [...$("#h-runs").selectedOptions].map((o) => o.value), key = $("#h-metric").value;
      if (!names.length || !key) return toast("실행과 지표를 고르세요");
      await Promise.all(names.map(loadMetrics));
      const ta = $("#rep-body"), at = ta.selectionStart ?? ta.value.length, block = chartBlock(names, key, +$("#h-bin").value);
      ta.value = ta.value.slice(0, at) + block + ta.value.slice(at); ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); ta.setSelectionRange(at + block.length, at + block.length);
    }
  });
  rep.addEventListener("input", (e) => { if (e.target.id === "rep-body" && state.editing) { state.editing.body = e.target.value; clearTimeout(wire.p); wire.p = setTimeout(() => { $("#rep-preview").innerHTML = md(state.editing.body); }, 250); }
    if (e.target.id === "rep-title" && state.editing) state.editing.title = e.target.value; });
  rep.addEventListener("change", (e) => { if (e.target.id === "h-runs") fillHelperMetrics(); });

  // board
  const board = $("#view-board");
  board.addEventListener("click", async (e) => {
    const bt = e.target.closest("[data-board-tab]"); if (bt) { state.boardTab = bt.dataset.boardTab; store.set("board-tab", state.boardTab); renderBoard(); return; }
    if (e.target.closest("[data-tree-close]")) { state.tree.sel = null; renderTree(); return; }
    const sl = e.target.closest("[data-share-lang]"); if (sl) { state.tree.share.lang = sl.dataset.shareLang; sl.parentElement.querySelectorAll("[data-share-lang]").forEach((x) => x.setAttribute("aria-pressed", x === sl)); return; }
    const ex = e.target.closest("[data-tree-export]"); if (ex) { ex.disabled = true; exportTree(state.tree.share).catch((err) => toast("만들지 못했습니다: " + err.message)).finally(() => { ex.disabled = false; }); return; }
    const to = e.target.closest("[data-tree-order]"); if (to) { state.tree.order = to.dataset.treeOrder; store.set("tree-order", state.tree.order); renderTree(); return; }
    if (e.target.closest("[data-tree-save]")) {
      const r = state.byName.get(state.tree.sel); if (!r) return;
      try { await saveNotes(r, { parent: $("#tree-e-parent").value, change: $("#tree-e-change").value.trim(), verdict: $("#tree-e-verdict").value.trim() }); toast("저장했습니다"); renderTree(); }
      catch (err) { toast("저장하지 못했습니다: " + err.message); }
      return;
    }
    const tr = e.target.closest("[data-tree-run]"); if (tr) { state.tree.sel = tr.dataset.treeRun; renderTree(); }
  });
  board.addEventListener("change", (e) => {
    if (e.target.id === "tree-archived") { state.tree.archived = e.target.checked; renderTree(); }
    if (e.target.dataset?.share) state.tree.share[e.target.dataset.share] = e.target.checked;
  });
  board.addEventListener("keydown", (e) => { const g = e.target.closest?.("[data-tree-run]"); if (g && g.tagName !== "BUTTON" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); state.tree.sel = g.dataset.treeRun; renderTree(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.tree.sel && $("#tree-side")) { state.tree.sel = null; renderTree(); } });
  board.addEventListener("submit", (e) => {
    e.preventDefault(); const doc = state.board.doc, f = e.target;
    if (f.id === "add-task") doc.tasks.push({ id: uid("t"), title: f.title.value.trim(), who: f.who.value.trim(), status: "todo", note: "", runs: [] });
    if (f.id === "add-dec") doc.decisions.push({ id: uid("q"), question: f.q.value.trim(), options: f.opts.value.split(",").map((x) => x.trim()).filter(Boolean), choice: "", note: "" });
    if (f.id === "add-round") { const r = { id: uid("r"), title: f.title.value.trim(), status: "next", goal: "", criteria: "", learned: [], then: "", runs: [] }; doc.roadmap.push(r); state.editRound = r.id; }
    renderBoard(); saveBoardSoon();
  });
  board.addEventListener("change", (e) => {
    const doc = state.board?.doc; if (!doc) return;
    if (e.target.id === "board-goal") { doc.goal = e.target.value; return saveBoardSoon(); }
    const t = e.target.closest(".item"), fld = e.target.dataset.f;
    if (t && fld) { const x = doc.tasks.find((k) => k.id === t.dataset.id); x[fld] = fld === "runs" ? linesOf(e.target.value.replace(/,/g, "\n")) : e.target.value; if (fld === "status") renderBoard(); return saveBoardSoon(); }
    const rf = e.target.closest("[data-round]"), rk = e.target.dataset.r;
    if (rf && rk) { const r = doc.roadmap.find((k) => k.id === rf.dataset.round); r[rk] = rk === "learned" ? linesOf(e.target.value) : rk === "runs" ? linesOf(e.target.value.replace(/,/g, "\n")) : e.target.value; saveBoardSoon(); }
  });
  board.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act; if (!act) return;
    const doc = state.board.doc, t = e.target.closest(".item"), d = e.target.closest(".dec"), r = e.target.closest(".rm-round");
    if (act === "del-task" && t && confirm("이 할 일을 삭제할까요?")) doc.tasks = doc.tasks.filter((x) => x.id !== t.dataset.id);
    const q = d && doc.decisions.find((x) => x.id === d.dataset.id);
    if (act === "choose" && q) { q.choice = q.options[+e.target.closest("[data-i]").dataset.i]; q.decided = new Date().toLocaleDateString("ko-KR") + " 결정"; }
    if (act === "reopen" && q) { q.choice = ""; q.decided = ""; }
    if (act === "add-opt" && q) { const o = (prompt("선택지") || "").trim(); if (o) q.options.push(o); }
    if (act === "del-dec" && q && confirm(`"${q.question}" 결정을 삭제할까요?`)) doc.decisions = doc.decisions.filter((x) => x !== q);
    if (act === "edit-round" && r) state.editRound = state.editRound === r.dataset.id ? null : r.dataset.id;
    if (act === "done-round") state.editRound = null;
    if (act === "del-round" && r && confirm("이 라운드를 삭제할까요?")) { doc.roadmap = doc.roadmap.filter((x) => x.id !== r.dataset.id); state.editRound = null; }
    renderBoard(); if (!["edit-round", "done-round"].includes(act)) saveBoardSoon();
  });
}

// ============================================================== start
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if ($("#auto-refresh").checked && !document.hidden && state.view === "runs" && !editing()) {
      try { await refresh(); render(true); } catch { /* keep polling */ }
    }
    schedulePoll();
  }, 5000);
}
(async function start() {
  applyTheme(); wire();
  try { await loadConfig(); await refresh(); }
  catch (e) { $("#focus").innerHTML = `<div class="empty-state">서버에 연결하지 못했습니다: ${esc(e.message)}</div>`; return; }
  applyHash(); schedulePoll(); renderGpus(); setInterval(renderGpus, 15000);
})();

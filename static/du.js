/* 滴灌均匀度巡检 —— 原生 JS */
(() => {
  "use strict";

  let state = null;
  const filter = { valve_id: null, status: "", round_id: null };
  let selectedConfigId = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const NS = "http://www.w3.org/2000/svg";

  const POS_LABEL = { head: "首", mid: "中", tail: "尾" };
  const POS_ORDER = { head: 0, mid: 1, tail: 2 };
  const POS_ALIAS = {
    "首": "head", "头": "head", "head": "head",
    "中": "mid", "mid": "mid",
    "尾": "tail", "末": "tail", "tail": "tail",
  };
  const JUDGE_CLASS = {
    ok: "j-ok", low_inlet: "j-warn", lateral_loss: "j-bad",
    du_low: "j-warn", low_inlet_du_fail: "j-bad", insufficient_data: "j-none",
  };
  const ROUND_CLASS = {
    normal: "r-normal", shared_supply_anomaly: "r-shared", insufficient: "r-insufficient",
  };

  // ------------------------------------------------------------ 工具

  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = "toast"), 3000);
  }

  async function api(path, options = {}) {
    const opts = { headers: {}, ...options };
    if (opts.body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtTs = (ts) => String(ts || "").replace("T", " ");
  const fmtNum = (v, d = 2) =>
    (v === null || v === undefined) ? "—" : (Math.round(v * 10 ** d) / 10 ** d).toString();
  const fmtPct = (v) => (v === null || v === undefined) ? "—" : `${(v * 100).toFixed(1)}%`;

  function nowLocalInput() {
    const d = new Date();
    d.setSeconds(0, 0);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ------------------------------------------------------------ 加载

  function stateUrl(extra = {}) {
    const p = new URLSearchParams();
    const rid = extra.round_id !== undefined ? extra.round_id : filter.round_id;
    const vid = extra.valve_id !== undefined ? extra.valve_id : filter.valve_id;
    const st = extra.status !== undefined ? extra.status : filter.status;
    if (rid) p.set("round_id", rid);
    if (vid) p.set("valve_id", vid);
    if (st) p.set("status", st);
    const qs = p.toString();
    return "/api/du/state" + (qs ? "?" + qs : "");
  }

  async function load(extra) {
    state = await api(stateUrl(extra));
    if (state.selected_id) filter.round_id = state.selected_id;
    const zones = state.selected ? state.selected.zones : [];
    if (!zones.some((z) => z.config_id === selectedConfigId)) {
      selectedConfigId = zones.length ? zones[0].config_id : null;
    }
    renderAll();
  }

  function renderAll() {
    renderSelectors();
    renderRoundList();
    renderZoneList();
    renderConfigForm();
    renderOverview();
    renderCharts();
    renderZoneTable();
    renderSamples();
  }

  const sel = () => state.selected;
  const selZone = () =>
    (sel() ? sel().zones.find((z) => z.config_id === selectedConfigId) : null) || null;

  // ------------------------------------------------------------ 轮次列表 / 选择器

  function renderRoundList() {
    const ul = $("#round-list");
    ul.innerHTML = "";
    if (!state.rounds.length) {
      ul.innerHTML = `<li class="entity-row" style="color:var(--ink-soft)">` +
        (state.valves.length ? "暂无巡检轮次，请在下方新建" : "请先在轮灌编排台建立阀门与分区") + `</li>`;
      return;
    }
    state.rounds.forEach((r) => {
      const li = document.createElement("li");
      li.className = "entity-row round-item" + (r.id === state.selected_id ? " selected" : "");
      li.innerHTML =
        `<span class="line1">
           <span class="grow name">${escapeHtml(r.name)}</span>
           <span class="valve-chip${r.valve_deleted ? " deleted" : ""}">${escapeHtml(r.valve_name)}${r.valve_deleted ? "（已删除）" : ""}</span>
         </span>
         <span class="meta">
           ${fmtTs(r.inspected_at)} · 有效分区 ${r.valid_zone_count}/${r.zone_count}
           <span class="judge-badge ${ROUND_CLASS[r.status] === "r-shared" ? "j-bad" : ROUND_CLASS[r.status] === "r-normal" ? "j-ok" : "j-none"}">${escapeHtml(r.status_label)}</span>
         </span>`;
      li.addEventListener("click", () => selectRound(r.id));
      ul.appendChild(li);
    });
  }

  function renderSelectors() {
    const fv = $("#filter-valve"), fr = $("#filter-round"), rv = $("#round-valve");
    fv.innerHTML = `<option value="">全部阀门</option>` +
      state.valves.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("");
    fv.value = state.filters.valve_id || "";
    $("#filter-status").value = state.filters.status || "";

    fr.innerHTML = state.rounds.length
      ? state.rounds.map((r) =>
          `<option value="${r.id}"${r.id === state.selected_id ? " selected" : ""}>` +
          `${escapeHtml(r.name)}（${fmtTs(r.inspected_at).slice(0, 10)}）</option>`).join("")
      : `<option value="">（无轮次）</option>`;

    rv.innerHTML = state.valves.length
      ? state.valves.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")
      : `<option value="">（请先建立阀门）</option>`;

    $("#btn-round-delete").disabled = !sel();
    const hasZone = !!selZone();
    $("#config-submit").disabled = !hasZone;
    $("#sample-submit").disabled = !hasZone;
    $("#batch-submit").disabled = !hasZone;
    $("#zone-card").style.opacity = sel() ? "1" : ".55";
    $("#sample-card").style.opacity = hasZone ? "1" : ".55";
  }

  async function selectRound(id) {
    filter.round_id = id;
    try { await load(); } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 分区列表 / 参数表单

  function renderZoneList() {
    const ul = $("#zone-list");
    ul.innerHTML = "";
    const s = sel();
    if (!s) {
      ul.innerHTML = `<li class="entity-row" style="color:var(--ink-soft)">请先选择巡检轮次</li>`;
      return;
    }
    s.zones.forEach((z) => {
      const li = document.createElement("li");
      li.className = "entity-row du-zone-item" +
        (z.config_id === selectedConfigId ? " selected" : "");
      li.innerHTML =
        `<span class="line1">
           <span class="grow name">${escapeHtml(z.zone_name)}${z.zone_deleted ? "（已删除）" : ""}</span>
           <span class="judge-badge ${JUDGE_CLASS[z.judgment]}">${escapeHtml(z.judgment_label)}</span>
         </span>
         <span class="meta">
           样本 ${z.sample_count}/${z.required_samples} · DU ${z.du === null ? "—" : fmtNum(z.du, 3)}
           · 入口 ${fmtNum(z.config.inlet_pressure, 1)}/${fmtNum(z.config.baseline_pressure, 1)} m
         </span>`;
      li.addEventListener("click", () => {
        selectedConfigId = z.config_id;
        renderZoneList();
        renderConfigForm();
        renderCharts();
        renderZoneTable();
        renderSamples();
      });
      ul.appendChild(li);
    });
  }

  function renderConfigForm() {
    const f = $("#config-form");
    const z = selZone();
    if (!z) {
      f.elements.config_id.value = "";
      ["baseline_pressure", "inlet_pressure", "design_flow",
       "du_min", "drop_threshold", "low_flow_ratio"].forEach((k) => { f.elements[k].value = ""; });
      return;
    }
    const c = z.config;
    f.elements.config_id.value = z.config_id;
    f.elements.baseline_pressure.value = c.baseline_pressure;
    f.elements.inlet_pressure.value = c.inlet_pressure;
    f.elements.design_flow.value = c.design_flow;
    f.elements.du_min.value = c.du_min;
    f.elements.drop_threshold.value = c.drop_threshold;
    f.elements.low_flow_ratio.value = c.low_flow_ratio;
  }

  // ------------------------------------------------------------ 总览 / 维护清单

  function renderOverview() {
    const title = $("#du-title"), badge = $("#du-badge");
    const meta = $("#du-meta"), stats = $("#du-stats");
    const basisBox = $("#round-basis"), maintBox = $("#maint-box");
    stats.innerHTML = ""; basisBox.innerHTML = ""; maintBox.innerHTML = "";
    badge.className = "case-badge";
    const s = sel();
    if (!s) {
      title.textContent = "未选择巡检轮次";
      badge.textContent = "";
      meta.textContent = "在左侧新建巡检轮次，或从筛选器中选择历史轮次。";
      return;
    }
    const r = s.result;
    title.textContent = `${s.name}（${s.valve_name}${s.valve_deleted ? " · 阀门已删除" : ""}）`;
    badge.classList.add(ROUND_CLASS[r.status]);
    badge.textContent = r.status_label;
    meta.innerHTML =
      `巡检时间 <b>${fmtTs(s.inspected_at)}</b> · 分区 ${r.zone_count} 个` +
      ` · 创建于 ${fmtTs(s.created)}`;

    const items = [
      ["有效分区", `${r.valid_zone_count}/${r.zone_count}`, "个"],
      ["共享供压信号", r.shared_signal_count, "个分区"],
      ["维护事项", r.maintenance.length, "项"],
    ];
    items.forEach(([label, val, unit]) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="stat-label">${label}</span>` +
        `<span class="stat-val">${escapeHtml(String(val))} <span class="stat-unit">${unit}</span></span>`;
      stats.appendChild(li);
    });

    r.basis.forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      basisBox.appendChild(li);
    });

    const h = document.createElement("p");
    h.className = "maint-title";
    h.textContent = "🛠 维护清单";
    maintBox.appendChild(h);
    if (!r.maintenance.length) {
      const div = document.createElement("div");
      div.className = "maint-empty";
      div.textContent = r.status === "insufficient"
        ? "数据不足，暂无维护结论；请为各分区补足样本。"
        : "本轮未发现需维护事项。";
      maintBox.appendChild(div);
      return;
    }
    r.maintenance.forEach((m) => {
      const div = document.createElement("div");
      div.className = `maint-item ${m.level}`;
      div.innerHTML =
        (m.zone ? `<span class="maint-zone">[${escapeHtml(m.zone)}]</span>` : "") +
        escapeHtml(m.text);
      maintBox.appendChild(div);
    });
  }

  // ------------------------------------------------------------ 图表（内联 SVG）

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function renderCharts() {
    const wrap = $("#du-charts"), subtitle = $("#chart-subtitle");
    wrap.innerHTML = "";
    const s = sel();
    if (!s) {
      subtitle.textContent = "";
      wrap.innerHTML = `<div class="chart-empty">请先选择巡检轮次</div>`;
      return;
    }
    subtitle.textContent = "左：各分区 DU 与下限；右：当前分区滴头流量分布";
    wrap.appendChild(duBarChart(s));
    wrap.appendChild(flowChart(selZone()));
  }

  function duBarChart(s) {
    const zones = s.zones;
    const W = 900, H = 170, PL = 40, PR = 12, PT = 14, PB = 30;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}` });
    const box = document.createElement("div");
    box.className = "chart-box-wide";
    box.innerHTML = `<h3><span>各分区 DU（低四分位均值 ÷ 全样本均值）</span>` +
      `<small>红色刻度线为各区 DU 下限</small></h3>`;

    const drawable = zones.filter((z) => z.du !== null);
    if (!drawable.length) {
      box.appendChild(svg);
      const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-label" });
      t.textContent = "暂无可绘制的 DU（各分区样本均为 0）";
      svg.appendChild(t);
      return box;
    }
    const n = zones.length;
    const bw = (W - PL - PR) / n;
    const hi = Math.max(1, ...zones.map((z) => z.du || 0), ...zones.map((z) => z.config.du_min)) * 1.12;
    const yAt = (v) => PT + (hi - v) * (H - PT - PB) / hi;

    zones.forEach((z, i) => {
      const x = PL + i * bw + bw * 0.18, w = bw * 0.64;
      const jc = JUDGE_CLASS[z.judgment];
      if (z.du !== null) {
        const y = yAt(z.du);
        const rect = el("rect", { x, y, width: w, height: Math.max(0, H - PB - y),
          class: `du-bar ${jc}` });
        rect.appendChild(el("title", {})).textContent =
          `${z.zone_name}\nDU ${fmtNum(z.du, 4)}（下限 ${z.config.du_min}）\n${z.judgment_label}`;
        svg.appendChild(rect);
        const vt = el("text", { x: x + w / 2, y: y - 3, "text-anchor": "middle", class: "chart-label" });
        vt.textContent = fmtNum(z.du, 3);
        svg.appendChild(vt);
      } else {
        const t = el("text", { x: x + w / 2, y: H - PB - 4, "text-anchor": "middle", class: "chart-label" });
        t.textContent = "无样本";
        svg.appendChild(t);
      }
      // DU 下限刻度
      const ym = yAt(z.config.du_min);
      svg.appendChild(el("line", { x1: x - 3, x2: x + w + 3, y1: ym, y2: ym, class: "du-min-tick" }));
      const label = el("text", { x: x + w / 2, y: H - 16, "text-anchor": "middle", class: "chart-label" });
      label.textContent = z.zone_name;
      svg.appendChild(label);
      const jt = el("text", { x: x + w / 2, y: H - 6, "text-anchor": "middle", class: "chart-label" });
      jt.textContent = z.judgment_label;
      svg.appendChild(jt);
    });
    box.appendChild(svg);
    return box;
  }

  function flowChart(z) {
    const W = 900, H = 170, PL = 40, PR = 14, PT = 14, PB = 24;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}` });
    const box = document.createElement("div");
    box.className = "chart-box-wide";
    box.innerHTML = `<h3><span>滴头流量分布${z ? `（${escapeHtml(z.zone_name)}）` : ""}</span>` +
      `<small>蓝虚线设计流量 · 红虚线低流量阈值 · 黄圈为低四分位组</small></h3>`;
    box.appendChild(svg);
    if (!z || !z.samples.length) {
      const t = el("text", { x: W / 2, y: H / 2, "text-anchor": "middle", class: "chart-label" });
      t.textContent = z ? "该分区暂无样本，请在左侧录入" : "请先选择分区";
      svg.appendChild(t);
      return box;
    }
    const pts = z.samples;
    const n = pts.length;
    const xAt = (i) => PL + (n === 1 ? (W - PL - PR) / 2 : i * (W - PL - PR) / (n - 1));
    let lo = Math.min(...pts.map((p) => p.flow), z.low_flow_threshold, z.config.design_flow);
    let hi = Math.max(...pts.map((p) => p.flow), z.config.design_flow);
    const pad = Math.max(0.2, (hi - lo) * 0.15);
    lo = Math.max(0, lo - pad); hi += pad;
    const yAt = (v) => PT + (hi - v) * (H - PT - PB) / (hi - lo);

    // 位置分段参考线 + 标签
    let lastPos = null;
    pts.forEach((p, i) => {
      if (p.position !== lastPos) {
        if (lastPos !== null) {
          const x = (xAt(i - 1) + xAt(i)) / 2;
          svg.appendChild(el("line", { x1: x, x2: x, y1: PT, y2: H - PB, class: "du-seg-line" }));
        }
        const t = el("text", { x: xAt(i), y: H - 6, class: "chart-label" });
        t.textContent = `${POS_LABEL[p.position]}段`;
        svg.appendChild(t);
        lastPos = p.position;
      }
    });

    // 设计流量 / 低流量阈值参考线
    [[z.config.design_flow, "du-flow-line", `设计 ${fmtNum(z.config.design_flow, 2)}`],
     [z.low_flow_threshold, "du-threshold-line", `阈值 ${fmtNum(z.low_flow_threshold, 2)}`]]
      .forEach(([v, cls, txt]) => {
        const y = yAt(v);
        svg.appendChild(el("line", { x1: PL, x2: W - PR, y1: y, y2: y, class: cls }));
        const t = el("text", { x: PL + 2, y: y - 2, class: "chart-label ref" });
        t.textContent = txt;
        svg.appendChild(t);
      });

    pts.forEach((p, i) => {
      const c = el("circle", {
        cx: xAt(i), cy: yAt(p.flow), r: 4,
        class: "du-pt" + (p.below_threshold ? " below" : "") + (p.in_low_quartile ? " low-q" : ""),
      });
      c.appendChild(el("title", {})).textContent =
        `${POS_LABEL[p.position]}段 #${p.seq}\n流量 ${fmtNum(p.flow, 2)} L/h` +
        (p.in_low_quartile ? "\n低四分位组" : "") +
        (p.below_threshold ? `\n低于阈值 ${fmtNum(z.low_flow_threshold, 2)} L/h` : "");
      svg.appendChild(c);
    });
    return box;
  }

  // ------------------------------------------------------------ 分区判定表

  function renderZoneTable() {
    const tbody = $("#zone-rows"), subtitle = $("#zone-subtitle");
    tbody.innerHTML = "";
    const s = sel();
    if (!s) { subtitle.textContent = ""; return; }
    subtitle.textContent =
      `共 ${s.zones.length} 个分区 · 点击行在左侧编辑参数与样本`;
    if (!s.zones.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="10">该轮次没有分区</td></tr>`;
      return;
    }
    s.zones.forEach((z) => {
      const tr = document.createElement("tr");
      tr.className = "zone-pick" + (z.config_id === selectedConfigId ? " selected" : "");
      const duCell = z.du === null ? "—"
        : `<span class="${z.du_ok ? "" : "num-bad"}">${fmtNum(z.du, 4)}</span>`;
      const inletCell =
        `<span class="${z.inlet_ok ? "" : "num-bad"}">${fmtNum(z.config.inlet_pressure, 1)}</span>` +
        ` / ${fmtNum(z.config.baseline_pressure, 1)}`;
      const dropCell = z.tail_drop === null ? "—"
        : `<span class="${z.drop_reached ? "num-bad" : ""}">${fmtPct(z.tail_drop)}</span>` +
          `（阈值 ${fmtPct(z.config.drop_threshold)}）`;
      tr.innerHTML =
        `<td><b>${escapeHtml(z.zone_name)}</b>${z.zone_deleted ? "（已删除）" : ""}</td>` +
        `<td class="${z.valid ? "" : "num-bad"}">${z.sample_count}${z.valid ? "" : `（不足 ${z.required_samples}）`}</td>` +
        `<td>${z.lq_avg === null ? "—" : fmtNum(z.lq_avg, 3)}</td>` +
        `<td>${z.avg_flow === null ? "—" : fmtNum(z.avg_flow, 3)}</td>` +
        `<td>${duCell}</td>` +
        `<td>${fmtNum(z.config.du_min, 2)}</td>` +
        `<td>${inletCell}</td>` +
        `<td>${dropCell}</td>` +
        `<td><span class="judge-badge ${JUDGE_CLASS[z.judgment]}">${escapeHtml(z.judgment_label)}</span></td>` +
        `<td class="basis-cell"><ul>${z.basis.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul></td>`;
      tr.addEventListener("click", () => {
        selectedConfigId = z.config_id;
        renderZoneList();
        renderConfigForm();
        renderCharts();
        renderZoneTable();
        renderSamples();
      });
      tbody.appendChild(tr);
    });
  }

  // ------------------------------------------------------------ 样本明细

  function renderSamples() {
    const tbody = $("#sample-rows"), subtitle = $("#sample-subtitle");
    tbody.innerHTML = "";
    const z = selZone();
    if (!z) {
      subtitle.textContent = "";
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">请先选择分区</td></tr>`;
      return;
    }
    const clogIds = new Set(z.clogs.map((c) => c.id));
    subtitle.textContent =
      `${z.zone_name} · 共 ${z.sample_count} 个样本（低四分位取 ${z.k} 个）` +
      ` · 低流量阈值 ${fmtNum(z.low_flow_threshold, 2)} L/h`;
    if (!z.samples.length) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">暂无样本，请在左侧录入（至少 ${z.required_samples} 个）</td></tr>`;
      return;
    }
    z.samples.forEach((p) => {
      const tr = document.createElement("tr");
      const tags =
        (p.in_low_quartile ? `<span class="tag low-q">低四分位</span>` : "") +
        (p.below_threshold ? `<span class="tag clog">低于阈值${clogIds.has(p.id) ? "·疑似堵塞" : ""}</span>` : "");
      tr.innerHTML =
        `<td>${POS_LABEL[p.position]}段</td><td>#${p.seq}</td>` +
        `<td class="${p.below_threshold ? "num-bad" : ""}">${fmtNum(p.flow, 2)}</td>` +
        `<td>${tags}</td>` +
        `<td><button class="del-btn" title="删除该样本（删除后整轮重算）">🗑</button></td>`;
      tr.querySelector(".del-btn").addEventListener("click", () => removeSample(p));
      tbody.appendChild(tr);
    });
  }

  async function removeSample(p) {
    const z = selZone();
    if (!z) return;
    if (!confirm(`删除 ${z.zone_name} ${POS_LABEL[p.position]}段 #${p.seq} 的样本？删除后整轮重算。`)) return;
    try {
      await api(`/api/du/samples/${p.id}`, { method: "DELETE" });
      await load();
      toast("样本已删除，整轮已重算");
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ 表单

  function bindForms() {
    $("#round-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = {
        name: f.elements.name.value.trim(),
        valve_id: Number(f.elements.valve_id.value),
      };
      if (f.elements.inspected_at.value) body.inspected_at = f.elements.inspected_at.value;
      try {
        const s = await api("/api/du/rounds", { method: "POST", body });
        filter.round_id = s.selected_id;
        selectedConfigId = null;
        f.elements.name.value = "";
        await load();
        toast("巡检轮次已创建，请逐区录入入口压力与滴头样本");
      } catch (err) { toast(err.message, true); }
    });

    $("#btn-round-delete").addEventListener("click", async () => {
      const s = sel();
      if (!s) return;
      if (!confirm(`删除巡检轮次「${s.name}」？全部分区参数与样本将一并删除。`)) return;
      try {
        await api(`/api/du/rounds/${s.id}`, { method: "DELETE" });
        filter.round_id = null;
        selectedConfigId = null;
        await load();
        toast("巡检轮次已删除");
      } catch (err) { toast(err.message, true); }
    });

    $("#config-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const id = f.elements.config_id.value;
      if (!id) { toast("请先选择分区", true); return; }
      const body = {
        baseline_pressure: Number(f.elements.baseline_pressure.value),
        inlet_pressure: Number(f.elements.inlet_pressure.value),
        design_flow: Number(f.elements.design_flow.value),
        du_min: Number(f.elements.du_min.value),
        drop_threshold: Number(f.elements.drop_threshold.value),
        low_flow_ratio: Number(f.elements.low_flow_ratio.value),
      };
      try {
        await api(`/api/du/configs/${id}`, { method: "PUT", body });
        await load();
        toast("参数已保存，整轮已重算");
      } catch (err) { toast(err.message, true); }
    });

    $("#sample-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const z = selZone();
      if (!z) { toast("请先选择分区", true); return; }
      const f = e.target;
      const body = {
        position: f.elements.position.value,
        seq: Number(f.elements.seq.value),
        flow: Number(f.elements.flow.value),
      };
      try {
        await api(`/api/du/configs/${z.config_id}/samples`, { method: "POST", body });
        f.elements.flow.value = "";
        await load();
        toast("样本已录入，整轮已重算");
      } catch (err) { toast(err.message, true); }
    });

    $("#batch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const z = selZone();
      if (!z) { toast("请先选择分区", true); return; }
      const lines = e.target.elements.lines.value.split("\n")
        .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      if (!lines.length) { toast("请先粘贴样本行", true); return; }
      const batch = [];
      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(/[\s,，、]+/).filter(Boolean);
        const pos = POS_ALIAS[(parts[0] || "").toLowerCase()];
        if (!pos || parts.length !== 3 || isNaN(Number(parts[1])) || isNaN(Number(parts[2]))) {
          toast(`第 ${i + 1} 行格式错误：${lines[i]}（应为「位置 编号 流量」）`, true);
          return;
        }
        batch.push({ position: pos, seq: Number(parts[1]), flow: Number(parts[2]) });
      }
      try {
        await api(`/api/du/configs/${z.config_id}/samples`, { method: "POST", body: { batch } });
        e.target.elements.lines.value = "";
        await load();
        toast(`已批量录入 ${batch.length} 个样本，整轮已重算`);
      } catch (err) { toast(err.message, true); }
    });
  }

  // ------------------------------------------------------------ 筛选 / 导出

  function bindFilters() {
    $("#filter-valve").addEventListener("change", async () => {
      filter.valve_id = Number($("#filter-valve").value) || null;
      filter.round_id = null;  // 交给后端按筛选挑默认轮次
      try { await load({ round_id: undefined }); } catch (e) { toast(e.message, true); }
    });
    $("#filter-status").addEventListener("change", async () => {
      filter.status = $("#filter-status").value || "";
      filter.round_id = null;
      try { await load({ round_id: undefined }); } catch (e) { toast(e.message, true); }
    });
    $("#filter-round").addEventListener("change", async () => {
      filter.round_id = Number($("#filter-round").value) || null;
      try { await load(); } catch (e) { toast(e.message, true); }
    });
    $("#btn-export").addEventListener("click", () => {
      if (!state.selected_id) { toast("请先选择巡检轮次", true); return; }
      window.location.href = `/api/du/export?round_id=${state.selected_id}`;
    });
  }

  // ------------------------------------------------------------ 启动

  $("#round-form").elements.inspected_at.value = nowLocalInput();
  bindForms();
  bindFilters();
  load().catch((e) => toast(e.message, true));
})();

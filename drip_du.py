"""滴灌均匀度（DU）巡检核心：低四分位均值法 + 共享供压 / 支管压损 / 疑似堵塞三级判定。

计算规则
--------
- 一次巡检（轮次）选择一条阀门，为该阀门当前绑定的每个分区生成一套判定参数：
  基准入口压力、设计滴头流量、DU 下限、尾首降幅阈值、低流量比例，
  并录入实测入口压力与按「首 / 中 / 尾」编号的滴头实测流量样本。
- 每区至少 8 个样本才参与判定：全部样本按流量升序取 ceil(n/4) 个为低四分位组，
  DU = 低四分位均值 / 全样本均值；DU ≥ DU 下限为合格，入口压力 ≥ 基准为合格。
- 整轮判定：有效分区（样本数达标）中「入口压力低于基准且 DU 合格」的数量
  超过一半 -> 整轮标记「共享供压异常」，低流量归因于泵站 / 主管共享供压，
  不再逐区判定支管压损与堵塞。
- 未触发时逐区判定：
  * 入口压力合格、DU 不合格、且尾段中位数相对首段中位数的降幅达到阈值
    -> 支管压损（低流量沿程分布，归因于支管水头损失）；
  * 其余入口压力合格且非支管压损的分区中，实测流量低于
    「设计流量 × 低流量比例」的采样点列为疑似滴头堵塞；
    支管压损分区的低流量点已由压损解释、入口压力偏低分区的低流量点先归因于
    供压不足，均不重复列入堵塞清单。

补录 / 删除样本、修改参数或入口压力后，调用方取整轮数据整体重算（本模块无状态）。
时间戳与其他模块一致，只接受本地时间 ISO 字符串。
"""

import math
from datetime import datetime

POSITIONS = ("head", "mid", "tail")
POSITION_LABEL = {"head": "首", "mid": "中", "tail": "尾"}
_POSITION_ALIASES = {
    "head": "head", "首": "head",
    "mid": "mid", "中": "mid",
    "tail": "tail", "尾": "tail",
}

MIN_SAMPLES = 8          # 每区参与判定的最少样本数
QUARTILE = 4             # 低四分位：按流量升序取 ceil(n/4) 个

DEFAULT_BASELINE_PRESSURE = 10.0   # 基准入口压力（m，米水柱）
DEFAULT_DESIGN_FLOW = 4.0          # 设计滴头流量（L/h）
DEFAULT_DU_MIN = 0.80              # DU 下限（0~1）
DEFAULT_DROP_THRESHOLD = 0.10      # 尾首降幅阈值（相对首段中位数，0~1）
DEFAULT_LOW_FLOW_RATIO = 0.75      # 低于 设计流量×该比例 判疑似堵塞

PRESSURE_MAX = 1000.0    # 压力物理上限（m）
FLOW_MAX = 1000.0        # 单滴头流量物理上限（L/h）
_EPS = 1e-9

# 整轮状态
R_NORMAL = "normal"                  # 未触发共享供压异常，逐区判定
R_SHARED = "shared_supply_anomaly"   # 共享供压异常
R_INSUFFICIENT = "insufficient"      # 有效分区不足
ROUND_LABEL = {
    R_NORMAL: "逐区判定",
    R_SHARED: "共享供压异常",
    R_INSUFFICIENT: "数据不足",
}
ROUND_STATUSES = (R_NORMAL, R_SHARED, R_INSUFFICIENT)

# 分区判定
J_OK = "ok"
J_LOW_INLET = "low_inlet"
J_LATERAL = "lateral_loss"
J_DU_LOW = "du_low"
J_LOW_INLET_DU_FAIL = "low_inlet_du_fail"
J_INSUFFICIENT = "insufficient_data"
JUDGMENT_LABEL = {
    J_OK: "正常",
    J_LOW_INLET: "入口压力偏低",
    J_LATERAL: "支管压损",
    J_DU_LOW: "均匀度不合格",
    J_LOW_INLET_DU_FAIL: "压力与均匀度双异常",
    J_INSUFFICIENT: "数据不足",
}


# ---------------------------------------------------------------- 时间戳

def parse_ts(raw):
    """解析本地时间戳，返回精确到秒的 'YYYY-MM-DDTHH:MM:SS'（与其他模块一致）。"""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("时间必须为字符串（YYYY-MM-DDTHH:MM:SS）")
    text = raw.strip()
    if len(text) == 10:  # 只有日期
        text = text + "T00:00:00"
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    if text.upper().endswith(("Z", "UTC")) or "+" in text[10:] or "-" in text[10:]:
        raise ValueError("时间不支持时区后缀，请使用本地时间（YYYY-MM-DDTHH:MM:SS）")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError(f"时间格式错误：{raw}（应为 YYYY-MM-DDTHH:MM:SS）")
    if dt.tzinfo is not None:
        raise ValueError("时间不支持时区，请使用本地时间")
    return dt.replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- 参数 / 样本校验

def _num(raw, field):
    if raw in (None, ""):
        raise ValueError(f"缺少字段：{field}")
    try:
        val = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{field} 必须为数字")
    if val != val:  # NaN
        raise ValueError(f"{field} 不能为 NaN")
    if val in (float("inf"), float("-inf")):
        raise ValueError(f"{field} 必须为有限数字")
    return val


def validate_config(raw):
    """校验单区判定参数（含实测入口压力），返回规整后的六项参数。"""
    if not isinstance(raw, dict):
        raise ValueError("请求体必须为 JSON 对象")
    baseline = _num(raw.get("baseline_pressure"), "基准入口压力")
    inlet = _num(raw.get("inlet_pressure"), "实测入口压力")
    design = _num(raw.get("design_flow"), "设计滴头流量")
    du_min = _num(raw.get("du_min"), "DU 下限")
    drop = _num(raw.get("drop_threshold"), "尾首降幅阈值")
    ratio = _num(raw.get("low_flow_ratio"), "低流量比例")
    if not (0 < baseline <= PRESSURE_MAX):
        raise ValueError(f"基准入口压力必须在 0 ~ {PRESSURE_MAX:g} m 之间")
    if not (0 <= inlet <= PRESSURE_MAX):
        raise ValueError(f"实测入口压力必须在 0 ~ {PRESSURE_MAX:g} m 之间")
    if not (0 < design <= FLOW_MAX):
        raise ValueError(f"设计滴头流量必须在 0 ~ {FLOW_MAX:g} L/h 之间")
    if not (0 < du_min <= 1):
        raise ValueError("DU 下限必须在 (0, 1] 之间（如 0.8 表示 80%）")
    if not (0 <= drop < 1):
        raise ValueError("尾首降幅阈值必须在 [0, 1) 之间（如 0.1 表示 10%）")
    if not (0 < ratio <= 1):
        raise ValueError("低流量比例必须在 (0, 1] 之间（如 0.75）")
    return {
        "baseline_pressure": baseline,
        "inlet_pressure": inlet,
        "design_flow": design,
        "du_min": du_min,
        "drop_threshold": drop,
        "low_flow_ratio": ratio,
    }


def _parse_position(raw, where):
    pos = _POSITION_ALIASES.get(str(raw or "").strip().lower())
    if pos is None:
        raise ValueError(f"{where}：位置必须为 首/中/尾（或 head/mid/tail）")
    return pos


def _parse_seq(raw, where):
    try:
        seqf = float(raw)
        seq = int(seqf)
    except (TypeError, ValueError):
        raise ValueError(f"{where}：编号必须为正整数")
    if seq != seqf or not (1 <= seq <= 9999):
        raise ValueError(f"{where}：编号必须为 1~9999 的正整数")
    return seq


def validate_samples(payload):
    """校验样本批次：单条对象、数组或 {'batch': [...]} 均可（支持补录）。

    每条必须含位置（首/中/尾）、编号（正整数）与实测流量（L/h，允许 0 表示完全堵塞）；
    批内「位置 + 编号」重复拒绝。返回按位置、编号排序的 [{position, seq, flow}]。
    与库内已有样本的冲突由调用方靠唯一索引兜底。
    """
    if isinstance(payload, dict) and isinstance(payload.get("batch"), list):
        rows = payload["batch"]
    elif isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = [payload]
    else:
        raise ValueError("批次必须为样本数组，或 {'batch': [...]} 对象")
    if not rows:
        raise ValueError("批次为空")
    cleaned = []
    seen = set()
    for i, row in enumerate(rows):
        where = f"第 {i + 1} 条"
        if not isinstance(row, dict):
            raise ValueError(f"{where}：样本必须为对象")
        pos = _parse_position(row.get("position"), where)
        seq = _parse_seq(row.get("seq"), where)
        flow = _num(row.get("flow"), f"{where}实测流量")
        if not (0 <= flow <= FLOW_MAX):
            raise ValueError(f"{where}实测流量 {flow:g} 超出物理可能范围（0~{FLOW_MAX:g} L/h）")
        key = (pos, seq)
        if key in seen:
            raise ValueError(f"{where}：{POSITION_LABEL[pos]}段 #{seq} 在批次内重复")
        seen.add(key)
        cleaned.append({"position": pos, "seq": seq, "flow": flow})
    cleaned.sort(key=lambda p: (POSITIONS.index(p["position"]), p["seq"]))
    return cleaned


# ---------------------------------------------------------------- 统计工具

def median(values):
    """中位数；空序列返回 None。"""
    s = sorted(values)
    m = len(s)
    if m == 0:
        return None
    mid = m // 2
    return s[mid] if m % 2 else (s[mid - 1] + s[mid]) / 2.0


def _r3(x):
    """输出用：修约到 0.001，避免浮点尾巴。计算全程仍用全精度。"""
    return None if x is None else round(x + 0.0, 3)


def _r4(x):
    """DU 等比值修约到 0.0001。"""
    return None if x is None else round(x + 0.0, 4)


def _pct(x):
    return "—" if x is None else f"{x * 100:.1f}%"


# ---------------------------------------------------------------- 单区计算

def compute_zone(config, samples):
    """单区整体重算。

    config: validate_config 的六项参数；samples: [{id?, position, seq, flow}]。
    返回单区结果（不含整轮级别结论；clogs 由 compute_round 按整轮状态回填）。
    """
    baseline = float(config["baseline_pressure"])
    inlet = float(config["inlet_pressure"])
    design = float(config["design_flow"])
    du_min = float(config["du_min"])
    drop_th = float(config["drop_threshold"])
    ratio = float(config["low_flow_ratio"])

    pts = sorted(
        ({"id": s.get("id"), "position": s["position"], "seq": int(s["seq"]),
          "flow": float(s["flow"])} for s in samples),
        key=lambda p: (POSITIONS.index(p["position"]), p["seq"]))
    n = len(pts)
    k = math.ceil(n / QUARTILE) if n else 0

    # 低四分位组：按流量升序取前 k 个（并列时按位置、编号字典序，保证确定性）
    by_flow = sorted(pts,
                     key=lambda p: (p["flow"], POSITIONS.index(p["position"]), p["seq"]))
    for rank, p in enumerate(by_flow):
        p["in_low_quartile"] = rank < k

    flows = [p["flow"] for p in by_flow]
    avg = sum(flows) / n if n else None
    lq_avg = sum(flows[:k]) / k if k else None
    if avg is not None and avg > _EPS:
        du = lq_avg / avg
    else:
        du = None  # 无样本或全为 0：DU 无法定义

    seg = {}
    for pos in POSITIONS:
        vals = [p["flow"] for p in pts if p["position"] == pos]
        seg[pos] = {"count": len(vals), "median": _r3(median(vals))}

    head_med, tail_med = seg["head"]["median"], seg["tail"]["median"]
    if head_med is not None and tail_med is not None and head_med > _EPS:
        tail_drop = (head_med - tail_med) / head_med
    else:
        tail_drop = None
    drop_reached = None if tail_drop is None else tail_drop >= drop_th - _EPS

    inlet_ok = inlet >= baseline - _EPS
    du_ok = du is not None and du >= du_min - _EPS
    valid = n >= MIN_SAMPLES
    low_flow_threshold = design * ratio
    for p in pts:
        p["below_threshold"] = p["flow"] < low_flow_threshold - _EPS

    if not valid:
        judgment = J_INSUFFICIENT
    elif inlet_ok and du_ok:
        judgment = J_OK
    elif not inlet_ok and du_ok:
        judgment = J_LOW_INLET
    elif inlet_ok and not du_ok:
        judgment = J_LATERAL if drop_reached else J_DU_LOW
    else:
        judgment = J_LOW_INLET_DU_FAIL

    basis = []
    if n == 0:
        basis.append(f"暂无样本（每区至少 {MIN_SAMPLES} 个样本才参与判定）")
    else:
        line = f"样本 {n} 个，按流量升序取 ceil({n}/4)={k} 个计算低四分位均值"
        basis.append(line if valid else
                     line + f"；样本不足 {MIN_SAMPLES} 个，仅展示不参与判定")
        if du is None:
            basis.append("全样本均值为 0，DU 无法定义，按不合格处理")
        else:
            basis.append(
                f"DU = 低四分位均值 {_r3(lq_avg)} ÷ 全样本均值 {_r3(avg)} = {_r4(du)}，"
                f"{'≥' if du_ok else '<'} 下限 {du_min:g} → DU {'合格' if du_ok else '不合格'}")
    basis.append(
        f"入口压力 {inlet:g} m {'≥' if inlet_ok else '<'} 基准 {baseline:g} m → "
        f"{'合格' if inlet_ok else '低于基准'}")
    if valid and inlet_ok and not du_ok:
        if tail_drop is None:
            basis.append("首段或尾段缺少样本，无法计算尾首降幅 → 不满足支管压损条件")
        else:
            basis.append(
                f"尾段中位数 {tail_med:g} 相对首段中位数 {head_med:g} 降幅 "
                f"{_pct(tail_drop)}{'≥' if drop_reached else '<'}阈值 {_pct(drop_th)} "
                f"→ {'达到' if drop_reached else '未达到'}尾首降幅阈值")
    basis.append(f"判定：{JUDGMENT_LABEL[judgment]}")

    return {
        "config": {
            "baseline_pressure": baseline,
            "inlet_pressure": inlet,
            "design_flow": design,
            "du_min": du_min,
            "drop_threshold": drop_th,
            "low_flow_ratio": ratio,
        },
        "sample_count": n,
        "required_samples": MIN_SAMPLES,
        "valid": valid,
        "k": k,
        "avg_flow": _r3(avg),
        "lq_avg": _r3(lq_avg),
        "du": _r4(du),
        "du_ok": du_ok,
        "inlet_ok": inlet_ok,
        "positions": seg,
        "tail_drop": _r4(tail_drop),
        "drop_reached": drop_reached,
        "low_flow_threshold": _r3(low_flow_threshold),
        "judgment": judgment,
        "judgment_label": JUDGMENT_LABEL[judgment],
        "basis": basis,
        "samples": [{
            "id": p["id"],
            "position": p["position"],
            "position_label": POSITION_LABEL[p["position"]],
            "seq": p["seq"],
            "flow": _r3(p["flow"]),
            "in_low_quartile": p["in_low_quartile"],
            "below_threshold": p["below_threshold"],
        } for p in pts],
        "clogs": [],  # 由 compute_round 按整轮状态回填
    }


# ---------------------------------------------------------------- 整轮判定

def compute_round(zones):
    """整轮判定：zones 为 compute_zone 的结果（附加 zone_name），原地回填 clogs。

    返回 {status, status_label, valid_zone_count, shared_signal_count, basis, maintenance}。
    """
    total = len(zones)
    valid = [z for z in zones if z["valid"]]
    v = len(valid)
    shared = [z for z in valid if z["judgment"] == J_LOW_INLET]
    c = len(shared)

    basis = [f"有效分区 {v}/{total} 个（每区至少 {MIN_SAMPLES} 个样本参与判定）",
             f"其中 {c} 个分区同时满足「入口压力低于基准且 DU 合格」"]
    maintenance = []

    if v == 0:
        status = R_INSUFFICIENT
        basis.append("无有效分区，整轮数据不足，无法判定")
    elif c * 2 > v:
        status = R_SHARED
        basis.append(f"{c}/{v} 超过半数 → 整轮判定共享供压异常，"
                     "低流量归因于共享供压，不再逐区判定支管压损与堵塞")
        names = "、".join(z["zone_name"] for z in shared)
        maintenance.append({
            "level": "critical", "kind": "shared_supply", "zone": None,
            "text": f"共享供压异常：{names} 等 {c}/{v} 个分区入口压力低于基准但 DU 合格；"
                    "检查泵站出力、主管沿程损失与总阀开度，恢复供压后复测。",
        })
    else:
        status = R_NORMAL
        basis.append(f"{c}/{v} 未超过半数 → 逐区判定支管压损与疑似滴头堵塞")

    for z in zones:
        z["clogs"] = []
    if status != R_NORMAL:
        return {
            "status": status, "status_label": ROUND_LABEL[status],
            "zone_count": total, "valid_zone_count": v, "shared_signal_count": c,
            "basis": basis, "maintenance": maintenance,
        }

    for z in valid:
        name = z["zone_name"]
        cfg = z["config"]
        j = z["judgment"]
        if j == J_LATERAL:
            seg = z["positions"]
            maintenance.append({
                "level": "critical", "kind": "lateral_loss", "zone": name,
                "text": f"支管压损：尾段中位数 {seg['tail']['median']:g} L/h 较首段 "
                        f"{seg['head']['median']:g} L/h 下降 {_pct(z['tail_drop'])}，"
                        f"≥ 阈值 {_pct(cfg['drop_threshold'])}；"
                        "检查支管 / 毛管沿程阻力、末端堵头与管径匹配。",
            })
        elif j == J_LOW_INLET:
            maintenance.append({
                "level": "warning", "kind": "low_inlet", "zone": name,
                "text": f"入口压力偏低：实测 {cfg['inlet_pressure']:g} m 低于基准 "
                        f"{cfg['baseline_pressure']:g} m（DU 仍合格）；"
                        "检查该区阀门开度与过滤器污堵。",
            })
        elif j == J_LOW_INLET_DU_FAIL:
            maintenance.append({
                "level": "warning", "kind": "low_inlet_du_fail", "zone": name,
                "text": f"压力与均匀度双异常：入口压力 {cfg['inlet_pressure']:g} m 低于基准 "
                        f"{cfg['baseline_pressure']:g} m 且 DU 不合格；"
                        "先恢复供压再复测评估，低流量点暂不列疑似堵塞。",
            })
        else:
            # 正常 / 均匀度不合格（入口压力合格且非支管压损）：低流量点列疑似堵塞
            clogs = [p for p in z["samples"] if p["below_threshold"]]
            z["clogs"] = clogs
            if clogs:
                pts_text = "、".join(
                    f"{p['position_label']}{p['seq']}（{p['flow']:g}）" for p in clogs)
                maintenance.append({
                    "level": "warning", "kind": "clog", "zone": name,
                    "text": f"疑似滴头堵塞 {len(clogs)} 点：{pts_text} L/h，低于阈值 "
                            f"{z['low_flow_threshold']:g} L/h（设计 {cfg['design_flow']:g}"
                            f" × 比例 {cfg['low_flow_ratio']:g}）；建议清洗或更换滴头。",
                })
            elif j == J_DU_LOW:
                maintenance.append({
                    "level": "warning", "kind": "du_low", "zone": name,
                    "text": f"均匀度不合格：DU {z['du']:g} 低于下限 {cfg['du_min']:g}，"
                            "但尾首降幅未达阈值、也无低于低流量阈值的单点；"
                            "建议复测并检查灌水器选型一致性。",
                })
    return {
        "status": status, "status_label": ROUND_LABEL[status],
        "zone_count": total, "valid_zone_count": v, "shared_signal_count": c,
        "basis": basis, "maintenance": maintenance,
    }

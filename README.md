# 温室分区轮灌编排台

基于 **Python Flask + SQLite + 原生 HTML/CSS/JavaScript** 的温室管理工具，包含五个页面：

1. **温室分区轮灌编排台**（`/`）：以 **15 分钟为最小粒度**，在总流量、阀门并发上限、允许灌溉时段和停水时段四类约束下自动生成一天的轮灌计划，并在时间轴上直观标出冲突原因；支持鼠标拖拽与表单两种方式微调单个时段，即时校验，可保存到数据库并导出 JSON。
2. **灌溉水质连续监测**（`/water`）：按水源连续录入带时间戳的 **pH / EC / 浊度 / 硝酸盐** 采样，为每个水源配置各指标正常区间，按「连续两次越界判超标、连续两次回归判恢复」的规则重算状态，支持按水源/日期筛选、最近采样趋势图与 JSON 导出。
3. **病害接触追踪**（`/disease`）：复用现有温室分区，为一次病害确诊登记**可复用工具的分区到访、合格消毒事件及病害确诊**，按时间重放工具—分区之间的污染传播，输出每个分区的**最早暴露时间、最短事件链与待隔离清单**；补录 / 删除事件后自动重算，确认后**冻结案件快照**，支持筛选与 JSON 导出。
4. **作物积温预测**（`/heat`）：复用现有温室分区，为种植批次设置**基温、上限温度、目标积温与允许采样间隔**，录入带时间戳的温度；温度截断后对相邻读数做**梯形积分并按午夜拆分**，间隔超限**只登记缺口、不累计**；补录 / 删除读数后按时间全量重算，给出**每日积温、累计值、首次达标时刻与缺口清单**，未达标时以最近 7 个无缺口完整日的日均积温外推预计日期（样本不足明确不可预测）；页面展示温度 / 累计积温曲线与每日台账，支持按分区、批次筛选及 JSON 导出。
5. **滴灌均匀度巡检**（`/du`）：复用现有阀门与分区，一次巡检选择**一条阀门**，为其下各分区配置**基准入口压力、设计滴头流量、DU 下限、尾首降幅阈值与低流量比例**，录入实测入口压力与按**首 / 中 / 尾**编号的滴头实测流量；每区至少 8 个样本，按流量升序取 `ceil(n/4)` 个计算**低四分位均值**，DU 为其与全样本均值之比；超过半数分区「入口压力低于基准且 DU 合格」时整轮标记**共享供压异常**，否则逐区判定**支管压损**（入口压力合格、DU 不合格且尾首降幅达阈值）并列出**疑似滴头堵塞**点；补录 / 删除样本后整轮重算，给出每区 DU、判定依据与维护清单，支持巡检历史筛选与 JSON 导出。

## 一键启动（Docker Compose）

```bash
docker compose up --build -d
```

启动后访问：

- 轮灌编排台：**http://localhost:8000/**
- 水质监测页：**http://localhost:8000/water**
- 病害追踪页：**http://localhost:8000/disease**
- 积温预测页：**http://localhost:8000/heat**
- 滴灌巡检页：**http://localhost:8000/du**

五个页面顶部有页签可互相跳转。数据通过 Docker 卷 `irrigation-data` 持久化（容器内 `/app/data/irrigation.db`）。停止与清理：

```bash
docker compose down          # 停止（数据保留）
docker compose down -v       # 停止并删除数据卷
```

## 不用 Docker 直接运行

需要 Python 3.10+：

```bash
pip install -r requirements.txt
python app.py
# 访问 http://localhost:8000/ 、/water 、/disease 、/heat 、/du
```

首次启动会自动建库并写入一套内置示例数据（轮灌示例 + 2 个水源的水质历史采样 + 1 个灰霉病病害追踪示例案件 + 2 个作物积温批次 + 2 轮滴灌均匀度巡检）。

## 功能说明

### 数据录入（左侧面板）

- **阀门**：名称、额定流量（L/min）、**并发上限**（同一阀门同时最多开启几路，通常为 1）。
- **分区**：名称、**所需水量（L）**、**所属阀门**、**最早 / 最晚灌溉时段**（15 分钟对齐）。
  - 需要的时长按 `ceil(所需水量 / (阀门额定流量 × 15min))` 个槽位自动计算。
- **停水时段**：泵房检修等全局不可灌溉区间，可添加多条。
- **计划日期 / 总流量上限**（L/min）：顶部栏设置，改动后立即重新校验。

### 自动编排

点击 **「⚙ 自动编排」**，系统按「调度紧迫度」（允许窗口长度 − 需要槽数，越紧越先排，水量大者优先）贪心分配，对每个分区寻找第一个同时满足以下全部约束的连续槽段：

1. **总流量约束**：同一槽位所有开启分区的流量之和 ≤ 总流量上限；
2. **阀门并发约束**：同一阀门同一槽位开启的分区数 ≤ 该阀门并发上限；
3. **不可重叠 / 允许时段**：整块位于该分区最早–最晚时段内；
4. **停水时段约束**：不与任何停水区间相交。

找不到可行位置的分区标记为「未编排」，并给出诊断原因（如“允许时段全部处于停水时段”“总流量超限”等）。

### 时间轴与即时校验

- 每个分区一行，绿色虚线框为允许时段，灰色斜纹为停水覆盖，彩色色块为已排时段（按阀门着色，红色斜纹表示该段有冲突）。
- **拖动色块**即可调整该分区开始时间（自动吸附 15 分钟网格，自动钳制在 00:00–24:00 内），松手即整表重新校验并通过浮层提示结果。
- **点击色块**（或左侧分区条目）在左下角表单中精确修改：分区参数、以及「计划开始时间」字段；提交后按新水量/流量重算时长并即时校验。留空开始时间可取消该分区编排。
- 顶部状态栏显示校验结果与峰值流量；下方冲突面板逐条列出 `分区 + 时间段 + 具体原因`，例如：
  - 超出允许灌溉时段
  - 停水时段
  - 总流量超限（65 > 60 L/min）
  - 阀门 中部干管 并发超限（>1）
- 「💾 保存计划」将当前编排写入 SQLite（拖动/表单调整本身也已即时落库并校验，保存按钮可作为校验检查点）。

### 导出 / 重置

- **「⬇ 导出 JSON」**：下载当前计划（含计划日期、生成时间、流量上限、实际峰值、是否有效、停水时段、各分区起止时间/时长/冲突原因、未编排分区及原因），文件名形如 `irrigation-plan-2026-09-21.json`。
- **「↺ 恢复示例」**：清空并重建内置示例（5 个温室分区、3 条阀门干管、1 条泵房检修停水）。
- **「🗑 清空重置」**：清空全部阀门 / 分区 / 停水时段 / 计划，从零开始。

## 灌溉水质连续监测（/water）

### 数据模型

- **水源**：名称唯一，可带备注（如「1# 机井水」「雨水收集池」）。
- **正常区间**：每个水源独立配置四项指标的下限/上限，默认 pH 5.5~8.5、EC 0~2.0 mS/cm、浊度 0~10 NTU、硝酸盐 0~30 mg/L。修改区间后对该水源全部历史采样**按时间整体重算**。
- **采样**：每条采样带本地时间戳，四项指标缺一不可，指标单位固定（EC 仅接受 `mS/cm`、浊度仅接受 `NTU`、硝酸盐仅接受 `mg/L`、pH 为无量纲值，带任何单位均拒绝）。

### 状态规则（按水源、按指标、按时间）

- 某指标采样值**连续 2 次越出正常区间** → 该指标进入「🔴 超标」；
- 超标后采样值**连续 2 次回到区间内** → 恢复「🟢 正常」；
- 只越界 1 次、或恢复途中只回归 1 次 → 「🟠 观察」；
- 水源整体状态取四项指标中的最差者，观察/超标时**列出触发指标**（如「硝酸盐」「浊度」）。

### 录入校验（拒绝非法请求）

- **拒绝缺项**：四项指标少任意一项、空字符串、非数字、超出物理可能范围（如 pH=15）均返回 400。
- **拒绝非法单位**：只接受上表规定的单位字符串。
- **拒绝乱序批次**：批量提交（`{"batch": [...]}`）时，批内时间戳必须严格递增；首批时间戳不得早于或等于该水源库内最新采样；同一水源同一时间戳唯一。任一条目不合法则**整批回滚**，不会写入半批数据。
- 时间戳只接受**本地时间**（`YYYY-MM-DDTHH:MM:SS`，兼容空格分隔），带 `Z`/`UTC`/时区偏移的一律拒绝，避免跨时区排序歧义。

### 筛选 / 趋势 / 导出

- 顶部可按**水源**与**日期**筛选；默认展示该水源**最近 50 条**采样。
- 四张内联 SVG 趋势图分别绘制四项指标，灰色色带为正常区间，数据点按该指标当时状态着色（绿=正常 / 橙=观察 / 红=超标），悬停可见数值与状态；越界数值在明细表中红色标出。
- **「⬇ 导出 JSON」**按当前筛选条件导出（含各水源当前状态、区间配置、单位、采样明细及每个采样点的指标/整体状态），文件名形如 `water-quality-3-all.json` 或 `water-quality-3-2026-09-21.json`。
- 删除某条采样后同样会按时间重算该水源后续状态。

## 病害接触追踪（/disease）

围绕一次病害确诊开一个**案件**（如「灰霉病」），登记三类事件，系统按时间整体重放：

| 事件 | 必填对象 | 含义 |
|---|---|---|
| 🔴 确诊 `diagnosis` | 分区 | 该分区确诊为污染**源头**，立即具有传染性（不经过潜伏期） |
| 🔵 到访 `visit` | 工具 + 分区 | 可复用工具进入某温室分区的一次到访记录 |
| 🟢 消毒 `disinfection` | 工具 | 标记消毒是否**合格**；只有合格消毒才截断传播 |

### 传播重放规则

- 工具**进入已污染分区**后被污染；该工具**之后到访的分区立即列为暴露**。
- 暴露分区经过案件配置的**潜伏时长**（小时，可改 0 表示立即传染）后，才可继续污染到访的其他工具；确诊源头分区不受潜伏期限制。
- 工具完成**对应病害的合格消毒**后截断其传播链（消毒后到访不再传播，直到再次被污染）；**不合格消毒不截断**。
- **同一时刻按「确诊 → 到访 → 消毒」顺序处理**，同类型事件按事件 ID 排序。
- 循环传播只保留**最早暴露**；暴露时间相同时保留**更短事件链**；等长事件链按**事件 ID** 字典序决胜。

### 结果与操作

- **分区暴露结果表**：每个分区的状态（确诊源头 / 暴露潜伏中 / 已具传染性 / 清洁）、最早暴露时间、具备传染性时间，以及从确诊源头一路展开的**最短事件链**（芯片显示每次到访 / 消毒）。
- **🛑 待隔离清单**：所有暴露分区（含确诊源头），标注最早暴露时间与潜伏期是否已到。
- 表格同时给出工具在「重放截止时间」是否仍携带污染。
- **补录或删除事件**（包括改潜伏时长）后自动按时间整体重算；页面上方的「事件时间线」逐条给出每次事件的推演说明（如「仍在潜伏期中，工具未被污染」「消毒不合格，工具仍携带污染」）。
- **🔒 确认并冻结案件快照**：把当前重算结果（最早暴露、最短事件链、待隔离清单）固化到 SQLite；冻结时同时把各事件引用工具的**编号与名称固化进事件台账**。冻结后案件只读，不能再增删改事件或潜伏时长，导出始终返回冻结时的快照。
- **历史工具引用完整性**：删除工具时，若它仍被**未冻结（开放）案件**的事件引用，接口返回 400 拒绝删除（请先冻结案件）；案件**已冻结**后允许删除该工具，删除**不会**改写冻结案件的历史事件——事件台账、传播链、待隔离清单与 JSON 导出仍保留原工具编号与名称，已删除工具在工具列表中以「已删除 · 冻结案件历史」标记、仍可用于按工具筛选。「已停用（退休）」语义不变：退休只是标记、工具仍在列表中。为保证重启后仍可查询，事件表冗余保存 `tool_name`，旧库启动时自动迁移（见下文复核步骤）。
- 顶部可按**事件类型 / 工具 / 分区**筛选事件与结果，并可勾选「仅看待隔离分区」；**⬇ 导出 JSON** 导出当前案件的案件信息、分区、工具、全部事件与重放结果（已冻结案件导出快照）。

### 操作示例（页面）

1. 在左侧「案件」卡填 **病害名称（灰霉病）+ 潜伏时长（24 小时）→ 新建案件**。
2. 在「可复用工具」卡登记 **修枝剪 A、采收筐 1 号**（直接复用轮灌台已有的番茄区 / 黄瓜区等分区）。
3. 按时间依次登记：
   - `09-24 09:00 确诊 番茄区`
   - `09-24 10:00 到访 修枝剪 A → 番茄区`（进入污染分区，工具被污染）
   - `09-24 11:00 到访 修枝剪 A → 黄瓜区`（黄瓜区立即暴露，链：确诊 ➜ 番茄区到访 ➜ 黄瓜区到访）
   - `09-24 12:00 到访 采收筐 1 号 → 黄瓜区`（黄瓜区仍在 24 h 潜伏期，工具**不**被污染）
   - `09-24 12:30 消毒 修枝剪 A（不合格，不勾选）` → 13:00 再到访叶菜区仍会传播
   - `09-24 16:00 消毒 修枝剪 A（合格，勾选）` → 之后到访育苗区不再传播
4. 把某条合格消毒事件**删除**，可见后续分区的最早暴露时间立即提前、事件链变化。
5. 核对「待隔离清单」与最短事件链无误后点 **🔒 确认并冻结案件快照**，再 **⬇ 导出 JSON** 留档。

### 操作示例（API）

```bash
# 新建案件（潜伏 24 小时）
curl -X POST http://localhost:8000/api/disease/cases \
  -H 'Content-Type: application/json' \
  -d '{"disease_name":"灰霉病","latency_hours":24}'

# 登记确诊 / 到访 / 合格消毒（事件 id 由后端生成，时间为本地时间）
curl -X POST http://localhost:8000/api/disease/cases/1/events -H 'Content-Type: application/json' \
  -d '{"type":"diagnosis","ts":"2026-09-24T09:00:00","zone_id":1}'
curl -X POST http://localhost:8000/api/disease/cases/1/events -H 'Content-Type: application/json' \
  -d '{"type":"visit","ts":"2026-09-24T10:00:00","tool_id":1,"zone_id":1}'
curl -X POST http://localhost:8000/api/disease/cases/1/events -H 'Content-Type: application/json' \
  -d '{"type":"disinfection","ts":"2026-09-24T16:00:00","tool_id":1,"qualified":true}'

# 查看重放结果（每个分区最早暴露 / 最短链 / 待隔离清单）
curl 'http://localhost:8000/api/disease/state?case_id=1'

# 删除事件后自动重算；确认无误冻结快照；导出 JSON
curl -X DELETE http://localhost:8000/api/disease/events/3
curl -X POST http://localhost:8000/api/disease/cases/1/freeze
curl -OJ 'http://localhost:8000/api/disease/export?case_id=1'
```

首次启动内置一套病害示例案件（灰霉病，14 个事件，含潜伏门控、合格 / 不合格消毒、循环只留最早暴露三类情形）。

### 冻结案件删除工具后的复核步骤

沿用 Docker Compose 启动（`docker compose up --build -d`，数据在 `irrigation-data` 卷），依次复核：

```bash
# 1) 准备：新建案件、登记至少一条到访事件后冻结（下例假设案件 id=1、工具 id=1）
curl -X POST http://localhost:8000/api/disease/cases \
  -H 'Content-Type: application/json' -d '{"disease_name":"灰霉病","latency_hours":0}'
curl -X POST http://localhost:8000/api/disease/cases/1/events -H 'Content-Type: application/json' \
  -d '{"type":"diagnosis","ts":"2026-09-26T09:00:00","zone_id":1}'
curl -X POST http://localhost:8000/api/disease/cases/1/events -H 'Content-Type: application/json' \
  -d '{"type":"visit","ts":"2026-09-26T10:00:00","tool_id":1,"zone_id":1}'
curl -X POST http://localhost:8000/api/disease/cases/1/freeze

# 2) 冻结案件的事件台账先记下工具编号与名称
curl -s 'http://localhost:8000/api/disease/state?case_id=1' \
  | python3 -c 'import sys,json; s=json.load(sys.stdin); print([(e["id"],e["tool_id"],e["tool_name"]) for e in s["events"] if e["tool_id"]])'

# 3) 删除工具：冻结案件应 200；若案件未冻结应返回 400
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:8000/api/disease/tools/1   # 期望 200

# 4) 复核四件套均未丢失工具编号/名称：
#    a) 事件台账 tool_id/tool_name 仍在；
#    b) result.zones[*].chain（传播链）芯片仍显示工具名；
#    c) result.quarantine（待隔离清单）与删除前一致；
#    d) 工具列表中该工具带 "deleted": true 标记。
curl -s 'http://localhost:8000/api/disease/state?case_id=1' \
  | python3 -c 'import sys,json; s=json.load(sys.stdin); assert all(e["tool_name"] for e in s["events"] if e["tool_id"]); print("ledger ok"); print("deleted tool:", [t for t in s["tools"] if t.get("deleted")])'

# 5) JSON 导出同样保留
curl -s 'http://localhost:8000/api/disease/export?case_id=1' \
  | python3 -c 'import sys,json; p=json.load(sys.stdin); assert any(e["tool_name"] for e in p["events"]); assert any(t.get("deleted") for t in p["tools"]); print("export ok")'

# 6) 重启后再次查询，结果应与第 4、5 步一致（迁移与冗余名称已持久化）
docker compose restart
curl -s 'http://localhost:8000/api/disease/state?case_id=1' \
  | python3 -c 'import sys,json; s=json.load(sys.stdin); print([(e["id"],e["tool_id"],e["tool_name"]) for e in s["events"] if e["tool_id"]])'
```

页面侧复核：冻结案件后删除其工具，回到 `/disease` 选中该冻结案件——事件明细表「工具」列、时间线标题、分区结果表「最短事件链」芯片、🛑 待隔离清单仍显示原工具名；左侧工具列表该工具显示「已删除 · 冻结案件历史」，顶部「工具」筛选选中它仍能筛出历史事件；事件登记表单的工具下拉不再包含已删除工具。退休（已停用）工具仍在列表、标记不变。

数据库迁移说明：旧版 `disease_events` 表的 `tool_id` 带外键、无 `tool_name` 列；首次启动新版本时按 `PRAGMA user_version` 自动执行一次性迁移——重建表（去掉工具外键、新增 `tool_name` 并从工具表回填名称、保留分区外键与索引），并尽力从已有冻结快照的传播链中还原历史上已被置空的事件引用；迁移幂等，完成后 `user_version=1`。

## 作物积温预测（/heat）

### 数据模型

- **种植批次**：名称 + 所属温室分区（复用轮灌台分区）+ 作物（可空），并为每个批次设置：
  - **基温 Tb**（℃）：低于基温的温度不计积温；
  - **上限温度 Tc**（℃）：高于上限的温度按上限计（封顶）；
  - **目标积温**（℃·日）：首次达到该累计值的时刻即「首次达标时刻」；
  - **允许采样间隔**（小时）：相邻读数间隔超过它即登记缺口。
- **温度读数**：带本地时间戳（`YYYY-MM-DDTHH:MM:SS`），录入**真实温度**；同一批次时间戳唯一，支持**补录历史读数**。

### 计算规则（每次写入 / 删除后按时间全量重算）

1. **温度截断**：每条读数的有效温度 = `min(Tc, max(Tb, temp)) − Tb`，有效积温始终非负。
2. **间隔门控**：相邻读数间隔 **≤ 允许采样间隔**才参与积分；**超过则只在缺口清单登记（起止、时长），缺口区间不累计任何积温**（间隔恰好等于阈值不算缺口）。
3. **梯形积分 + 按午夜拆分**：有效区间按 `两端有效温度均值 × 时长(小时) / 24` 计算 ℃·日；区间跨越午夜时在午夜点按线性插值切分，两段分别计入相邻两个自然日。
4. **首次达标时刻**：按时间顺序在每个子区间内解积分方程（二分求根），精确到秒；结果同时在日台账中标出首次达标日。
5. **每日台账**：每日积温、当日结束累计值、有效覆盖时长、缺口时长 / 段数、是否为**无缺口完整日**（24 小时全部被有效区间覆盖）。
6. **未达标外推**：取**最近 7 个无缺口完整日**的日均积温，从最后一条读数时间线性外推预计达标时刻与日期；完整日不足 7 个、或日均积温为 0 时，页面与 JSON 明确给出**不可预测**原因。

### 页面 / 导出

- 顶部按**分区**与**批次**两级筛选；批次列表卡显示累计 / 目标、缺口数、完整日数、达标状态。
- 三张内联 SVG 图：**温度曲线**（实测蓝线 + 截断后绿虚线，基温 / 上限参考线，红色阴影为缺口区间，越限读数红点）、**累计积温曲线**（目标线、首次达标竖线、外推预计日期标注）、**每日积温柱状图**（黄色柱为含缺口日）。
- **⏭ 缺口清单**、**每日积温台账**与**读数明细**（含截断后有效温度，可逐条删除）。
- **⬇ 导出 JSON**：导出分区、全部批次的参数与汇总、当前批次的完整重算结果（参数、读数、日台账、缺口、首次达标与外推依据），文件名形如 `crop-heat-batch-1.json`。
- **删除保护**：分区下仍有积温批次时，轮灌台删除分区返回 400，提示先删除批次（批次删除级联其读数）。

### 操作示例（API）

```bash
# 1) 新建批次：基温 10、上限 30、目标 150 ℃·日、允许采样间隔 13 小时（挂在分区 1 番茄区）
curl -X POST http://localhost:8000/api/heat/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"越冬番茄一批","crop":"番茄","zone_id":1,
       "base_temp":10,"cap_temp":30,"target_gdd":150,"max_gap_hours":13}'

# 2) 批量录入温度（也可补录历史时间戳；时间戳必须本地时间、批内不重复）
curl -X POST http://localhost:8000/api/heat/batches/1/readings \
  -H 'Content-Type: application/json' \
  -d '{"batch":[
    {"ts":"2026-09-17T08:00:00","temp":8},
    {"ts":"2026-09-17T20:00:00","temp":22},
    {"ts":"2026-09-18T08:00:00","temp":9},
    {"ts":"2026-09-18T20:00:00","temp":24}
  ]}'

# 3) 查看按时间全量重算的结果（按分区筛选加 &zone_id=1）
curl 'http://localhost:8000/api/heat/state?batch_id=1'

# 4) 修改参数（如把上限改为 28 ℃）或删除某条读数 -> 自动全量重算
curl -X PUT http://localhost:8000/api/heat/batches/1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"越冬番茄一批","crop":"番茄","zone_id":1,
       "base_temp":10,"cap_temp":28,"target_gdd":150,"max_gap_hours":13}'
curl -X DELETE http://localhost:8000/api/heat/readings/3

# 5) 导出 JSON（含日台账 / 缺口 / 首次达标 / 外推依据）
curl -OJ 'http://localhost:8000/api/heat/export?batch_id=1'
```

首次启动内置两个积温批次：番茄区批次（每天 08:00 / 20:00 两条、含 32 ℃ 越限截断读数，8 个完整日、未达标，可看到外推预计日期）与黄瓜区补录批（含一个 18 小时漏测缺口、完整日不足 7 个，明确显示不可预测与缺口清单）。

### 复核示例（截断 / 午夜拆分 / 缺口 / 外推）

沿用 Docker Compose 启动（`docker compose up --build -d`），用内置番茄批次复核：

```bash
# 1) 番茄批次（默认 id=1）：未达标、无缺口、完整日 ≥ 7 -> 应返回 predictable=true
curl -s 'http://localhost:8000/api/heat/state?batch_id=1' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]["result"]
print("累计:", s["total_gdd"], "缺口:", s["gap_count"], "完整日:", s["complete_day_count"])
f = s["forecast"]
assert f and f["predictable"], f
print("最近 7 个完整日日均积温:", f["avg_daily_gdd"], "℃·日")
print("预计达标:", f["predicted_date"], f["predicted_at"], "样本:", f["sample_dates"][0], "~", f["sample_dates"][-1])
'

# 2) 手工复核一条跨午夜积分：录入两条恒温 22 ℃、间隔 12 小时（有效温度 12 ℃）
#    当日/次日各分 6 小时 -> 各 +3.0 ℃·日
curl -X POST http://localhost:8000/api/heat/batches/1/readings -H 'Content-Type: application/json' \
  -d '{"ts":"2027-01-10T18:00:00","temp":22}'
curl -X POST http://localhost:8000/api/heat/batches/1/readings -H 'Content-Type: application/json' \
  -d '{"ts":"2027-01-11T06:00:00","temp":22}'
curl -s 'http://localhost:8000/api/heat/state?batch_id=1' | python3 -c '
import sys, json
d = {x["date"]: x for x in json.load(sys.stdin)["selected"]["result"]["daily"]}
assert abs(d["2027-01-10"]["gdd"] - 3.0) < 1e-6 and abs(d["2027-01-11"]["gdd"] - 3.0) < 1e-6
print("午夜拆分复核通过：2027-01-10 +3.0、2027-01-11 +3.0 ℃·日")
'

# 3) 造一个超间隔缺口（间隔 18h > 13h 允许间隔）：缺口登记、区间不累计
curl -X POST http://localhost:8000/api/heat/batches/1/readings -H 'Content-Type: application/json' \
  -d '{"ts":"2027-01-12T06:00:00","temp":24}'   # 与上一条相差正好 24h
curl -s 'http://localhost:8000/api/heat/state?batch_id=1' | python3 -c '
import sys, json
r = json.load(sys.stdin)["selected"]["result"]
g = r["gaps"][-1]
print("缺口:", g["start_ts"], "->", g["end_ts"], g["duration_hours"], "h（不累计积温）")
assert g["duration_hours"] == 24.0
'

# 4) 黄瓜补录批（默认 id=2）：有缺口且完整日 < 7 -> 必须明确不可预测
curl -s 'http://localhost:8000/api/heat/state?batch_id=2' | python3 -c '
import sys, json
f = json.load(sys.stdin)["selected"]["result"]["forecast"]
assert not f["predictable"] and "不足" in f["reason"]
print("样本不足复核通过：", f["reason"])
'

# 5) 把目标积温调到当前累计以下 -> 立即出现首次达标时刻、不再外推；删除读数后又全量重算
curl -s 'http://localhost:8000/api/heat/state?batch_id=1' \
  | python3 -c 'import sys,json;print("当前累计:", json.load(sys.stdin)["selected"]["result"]["total_gdd"])'
curl -OJ 'http://localhost:8000/api/heat/export?batch_id=1'
```

页面侧复核：进入 `/heat`，在左上方筛选器选「黄瓜区」，右侧应出现黄色「⛔ 不可预测：无缺口完整日仅 N 个，不足 7 个，样本不足以外推」，下方「⏭ 缺口清单」列出漏测区间；选回「番茄区」可见绿色外推卡片、温度曲线上的基温/上限虚线与 32 ℃ 红点（按 30 ℃ 截断）、累计曲线上的预计达标标注；在左侧把「目标积温」改小后保存，顶部变为「已达标」并给出首次达标时刻，日台账对应日期高亮。

## 滴灌均匀度巡检（/du）

### 数据模型

- **巡检轮次**：一次巡检选择**一条阀门**（复用轮灌台阀门），含轮次名称与巡检时间；新建时为该阀门**当前绑定的每个分区**生成一套分区判定参数。阀门 / 分区名称随轮次冗余落库，日后阀门或分区被删除 / 改名，历史轮次仍按当时名称展示与导出（列表中以「已删除」标记）。
- **分区判定参数**（每区独立，保存后整轮重算）：
  - **基准入口压力**（m）：该区滴灌支管入口的基准工作压力；
  - **实测入口压力**（m）：本轮实测值，新建轮次时先按基准值填入，请改为实测值；
  - **设计滴头流量**（L/h）：滴头额定流量；
  - **DU 下限**（0~1，如 0.8）：均匀度合格线；
  - **尾首降幅阈值**（0~1，如 0.1 表示 10%）：支管压损的判定阈值；
  - **低流量比例**（0~1，如 0.75）：单点疑似堵塞的流量比例线。
- **滴头流量样本**：按**首 / 中 / 尾**三段编号（位置 + 编号唯一），实测流量（L/h，0 表示完全堵塞），支持单条录入与按「位置 编号 流量」每行一条的批量补录。

### 计算与判定规则（补录 / 删除样本、改参数后整轮重算）

1. **DU（低四分位均值法）**：每区至少 **8 个样本**才参与判定；全部样本按流量升序取 `ceil(n/4)` 个（并列时按位置、编号字典序）计算**低四分位均值**，`DU = 低四分位均值 ÷ 全样本均值`；DU ≥ 下限为合格，入口压力 ≥ 基准为合格。样本不足的区仅展示、不参与判定。
2. **整轮判定（共享供压异常）**：有效分区中同时满足「入口压力低于基准 **且** DU 合格」的数量**超过一半** → 整轮标记 **🔴 共享供压异常**（低压但流量仍均匀，说明问题在泵站 / 主管共享供压而非支管），不再逐区判定支管压损与堵塞。
3. **逐区判定（未触发时）**：
   - 入口压力合格、DU 不合格、且**尾段中位数相对首段中位数的降幅 ≥ 尾首降幅阈值** → **支管压损**（低流量沿程分布，归因于支管水头损失）；
   - 其余**入口压力合格且非支管压损**的分区中，实测流量低于 `设计流量 × 低流量比例` 的采样点列为**疑似滴头堵塞**；支管压损分区的低流量点已由压损解释、入口压力偏低分区的低流量点先归因于供压不足，均不重复列入堵塞清单；
   - 入口压力合格且 DU 合格 → 正常；入口压力偏低但 DU 合格（未超半数）→ 提示检查该区阀门 / 过滤器；入口压力偏低且 DU 不合格 → 先恢复供压再复测。
4. **结果输出**：每区 DU、低四分位均值、全样本均值、尾首降幅、判定结论与**判定依据**（逐步算式），以及整轮**维护清单**（共享供压 / 支管压损 / 疑似堵塞 / 压力关注项）。

### 页面 / 导出

- 顶部按**阀门**与**整轮状态**（逐区判定 / 共享供压异常 / 数据不足）筛选历史轮次；轮次列表显示各轮状态徽章与有效分区数。
- 两张内联 SVG 图：**各分区 DU 柱状图**（按判定着色，红色刻度线为各区 DU 下限）与**当前分区滴头流量分布**（首 / 中 / 尾分段，蓝虚线设计流量、红虚线低流量阈值、黄圈为低四分位组、红点为低于阈值样本）。
- **分区判定结果表**逐区给出 DU、判定徽章与完整判定依据；点击行在左侧编辑该区参数与样本。**样本明细表**标出低四分位组与低于阈值（疑似堵塞）样本，可逐条删除。
- **⬇ 导出 JSON**：导出当前轮次（轮次信息、整轮结论、维护清单、各分区参数 / 样本 / 判定结果与依据），文件名形如 `du-inspection-round-1.json`。
- 删除巡检轮次级联其分区参数与样本；删除分区 / 阀门不影响已落库的历史轮次（名称快照）。

### 操作示例（API）

```bash
# 1) 新建巡检轮次：选择阀门（下例 valve_id=2 中部干管），自动为其下各分区生成默认参数
curl -X POST http://localhost:8000/api/du/rounds \
  -H 'Content-Type: application/json' \
  -d '{"valve_id":2,"name":"10 月上旬巡检","inspected_at":"2026-10-01T09:00"}'

# 2) 修改某分区的判定参数与实测入口压力（config_id 见 state 返回）
curl -X PUT http://localhost:8000/api/du/configs/1 \
  -H 'Content-Type: application/json' \
  -d '{"baseline_pressure":10,"inlet_pressure":10.2,"design_flow":4,
       "du_min":0.8,"drop_threshold":0.1,"low_flow_ratio":0.75}'

# 3) 批量录入滴头样本（位置可用 首/中/尾 或 head/mid/tail；位置+编号唯一）
curl -X POST http://localhost:8000/api/du/configs/1/samples \
  -H 'Content-Type: application/json' \
  -d '{"batch":[
    {"position":"head","seq":1,"flow":4.1},{"position":"head","seq":2,"flow":4.0},
    {"position":"head","seq":3,"flow":3.9},{"position":"mid","seq":1,"flow":3.6},
    {"position":"mid","seq":2,"flow":3.5},{"position":"mid","seq":3,"flow":3.4},
    {"position":"tail","seq":1,"flow":2.9},{"position":"tail","seq":2,"flow":2.8}
  ]}'

# 4) 查看整轮重算结果（每区 DU / 判定依据 / 维护清单；可按 valve_id、status 筛选历史）
curl 'http://localhost:8000/api/du/state?round_id=1'
curl 'http://localhost:8000/api/du/state?status=shared_supply_anomaly'

# 5) 删除样本后整轮重算；导出 JSON 留档
curl -X DELETE http://localhost:8000/api/du/samples/12
curl -OJ 'http://localhost:8000/api/du/export?round_id=1'
```

首次启动内置两轮示例（均挂在「中部干管」）：**9月中旬巡检**（逐区判定：黄瓜区支管压损、草莓区 2 个疑似堵塞点、叶菜区正常）与**9月下旬复检**（2/3 分区入口低压但 DU 合格 → 共享供压异常）。

### 复核示例（DU 计算 / 共享供压 / 支管压损 / 重算）

沿用 Docker Compose 启动（`docker compose up --build -d`），用内置两轮种子数据复核（首次启动时轮次 id 为 1、2，分区参数 config_id 1=黄瓜区、2=草莓区、3=叶菜区）：

```bash
# 1) 轮次 1（9月中旬巡检）：整轮逐区判定
#    黄瓜区：9 样本取 ceil(9/4)=3 个，低四分位均值 2.5 / 全样本均值 3.333 = DU 0.75 < 0.8，
#    入口 10.2 ≥ 基准 10，尾首降幅 (4.1-2.5)/4.1 ≈ 39% ≥ 10% -> 支管压损
#    草莓区：DU≈0.767 不合格、尾首降幅≈2.6% 未达阈值 -> 首3 / 中3 两个疑似堵塞点（< 4×0.75=3.0）
curl -s 'http://localhost:8000/api/du/state?round_id=1' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]
assert s["result"]["status"] == "normal", s["result"]
zones = {z["zone_name"]: z for z in s["zones"]}
h, c = zones["黄瓜区"], zones["草莓区"]
assert abs(h["du"] - 0.75) < 1e-3 and h["judgment"] == "lateral_loss"
assert c["judgment"] == "du_low" and len(c["clogs"]) == 2
assert zones["叶菜区"]["judgment"] == "ok"
print("轮次1 复核通过：黄瓜区 DU=0.75 支管压损；草莓区疑似堵塞",
      [(p["position_label"] + str(p["seq"])) for p in c["clogs"]])
print("维护清单：", [m["kind"] for m in s["result"]["maintenance"]])
'

# 2) 轮次 2（9月下旬复检）：2/3 分区入口低压但 DU 合格，超过半数 -> 共享供压异常
curl -s 'http://localhost:8000/api/du/state?round_id=2' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]
r = s["result"]
assert r["status"] == "shared_supply_anomaly" and r["shared_signal_count"] == 2
assert len(r["maintenance"]) == 1 and r["maintenance"][0]["kind"] == "shared_supply"
print("轮次2 复核通过：", r["basis"][-1])
'

# 3) 补录 / 删除样本后整轮重算：给轮次 1 叶菜区（config_id=3）补一个 2.0 L/h 低流量点
#    -> n=10、k=ceil(10/4)=3，DU 变为 0.853 仍合格，但该点低于阈值 3.0 -> 疑似堵塞 +1
curl -s -X POST http://localhost:8000/api/du/configs/3/samples \
  -H 'Content-Type: application/json' -d '{"position":"mid","seq":9,"flow":2.0}' > /dev/null
curl -s 'http://localhost:8000/api/du/state?round_id=1' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]
y = {z["zone_name"]: z for z in s["zones"]}["叶菜区"]
assert y["sample_count"] == 10 and y["k"] == 3 and len(y["clogs"]) == 1
print("补录复核通过：叶菜区 n=10，DU", y["du"], "，疑似堵塞",
      [(p["position_label"] + str(p["seq"])) for p in y["clogs"]])
'
#    删除该样本后恢复原结论（样本 id 从 state 中查）
SID=$(curl -s 'http://localhost:8000/api/du/state?round_id=1' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]
y = {z["zone_name"]: z for z in s["zones"]}["叶菜区"]
print([p["id"] for p in y["samples"] if p["position"] == "mid" and p["seq"] == 9][0])
')
curl -s -X DELETE "http://localhost:8000/api/du/samples/$SID" > /dev/null
curl -s 'http://localhost:8000/api/du/state?round_id=1' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]
y = {z["zone_name"]: z for z in s["zones"]}["叶菜区"]
assert y["sample_count"] == 9 and y["clogs"] == [] and y["judgment"] == "ok"
print("删除复核通过：叶菜区恢复正常，DU", y["du"])
'

# 4) 把叶菜区实测入口压力改为 8.0（低于基准 10）-> 1/3 未超半数，仅提示压力关注，不触发共享异常
curl -s -X PUT http://localhost:8000/api/du/configs/3 -H 'Content-Type: application/json' \
  -d '{"baseline_pressure":10,"inlet_pressure":8.0,"design_flow":4,
       "du_min":0.8,"drop_threshold":0.1,"low_flow_ratio":0.75}' > /dev/null
curl -s 'http://localhost:8000/api/du/state?round_id=1' | python3 -c '
import sys, json
s = json.load(sys.stdin)["selected"]
r = s["result"]
y = {z["zone_name"]: z for z in s["zones"]}["叶菜区"]
assert r["status"] == "normal" and r["shared_signal_count"] == 1
assert y["judgment"] == "low_inlet"
print("参数复核通过：叶菜区入口压力偏低（1/3 未超半数），维护清单",
      [m["kind"] for m in r["maintenance"]])
'
# 复核完把入口压力改回 10.3
curl -s -X PUT http://localhost:8000/api/du/configs/3 -H 'Content-Type: application/json' \
  -d '{"baseline_pressure":10,"inlet_pressure":10.3,"design_flow":4,
       "du_min":0.8,"drop_threshold":0.1,"low_flow_ratio":0.75}' > /dev/null

# 5) 导出 JSON（含每区 DU、判定依据与维护清单）
curl -OJ 'http://localhost:8000/api/du/export?round_id=1'
```

页面侧复核：进入 `/du`，轮次列表选「9月中旬巡检」，顶部为绿色「逐区判定」徽章，维护清单列出黄瓜区支管压损与草莓区 2 个疑似堵塞点；DU 柱状图中黄瓜区红柱低于其 DU 下限刻度线；点击草莓区行，流量分布图可见首 3 / 中 3 两个红点（低于红色阈值虚线）且样本明细带「疑似堵塞」标记；切到「9月下旬复检」顶部变为红色「共享供压异常」徽章，维护清单只剩共享供压一项；状态筛选选「共享供压异常」应只剩轮次 2。

## 内置示例



| 分区 | 水量 | 阀门（流量） | 允许时段 |
|---|---|---|---|
| 番茄区 | 3000 L | 北侧干管 25 L/min | 06:00–10:00 |
| 黄瓜区 | 2250 L | 中部干管 25 L/min | 18:00–22:00 |
| 草莓区 | 1500 L | 中部干管 25 L/min | 05:30–08:30 |
| 叶菜区 | 750 L | 中部干管 25 L/min | 08:00–11:00 |
| 育苗区 | 450 L | 苗床支管 10 L/min | 07:00–09:00 |

总流量上限 60 L/min，停水 07:30–08:00。可以试试把「番茄区」拖到 07:30 附近或把总流量上限改小，观察冲突标注。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 获取全部数据与校验结果 |
| POST | `/api/generate` | 重新自动编排 |
| PUT | `/api/schedule` | 整表替换编排（拖拽/保存使用） |
| GET | `/api/export` | 导出 JSON 文件 |
| POST | `/api/settings` | 更新日期 / 总流量上限 |
| POST/PUT/DELETE | `/api/valves[/{id}]` | 阀门增改删 |
| POST/PUT/DELETE | `/api/zones[/{id}]` | 分区增改删 |
| POST/PUT/DELETE | `/api/blackouts[/{id}]` | 停水时段增改删 |
| POST | `/api/reset` | 清空（`{"sample":false}`）或恢复示例（`{"sample":true}`） |
| GET | `/water` | 水质监测页面 |
| GET | `/api/water/state` | 水质状态；参数 `source_id`、`date`（YYYY-MM-DD）、`limit`（默认 50，0=全部） |
| GET | `/api/water/export` | 按 `source_id`/`date` 筛选导出 JSON 文件 |
| POST/PUT/DELETE | `/api/water/sources[/{id}]` | 水源增改删（删除级联其区间与采样） |
| PUT | `/api/water/sources/{id}/ranges` | 配置四项指标正常区间并重算状态 |
| POST | `/api/water/sources/{id}/samples` | 录入采样；支持单条对象或 `{"batch":[...]}`（乱序/缺项/非法单位整批拒绝） |
| DELETE | `/api/water/samples/{id}` | 删除单条采样并重算该水源状态 |
| GET | `/disease` | 病害接触追踪页面 |
| GET | `/api/disease/state` | 案件/工具/事件及重放结果；参数 `case_id`（默认最近案件） |
| GET | `/api/disease/export` | 导出当前案件 JSON（已冻结案件导出冻结快照） |
| POST/PUT/DELETE | `/api/disease/tools[/{id}]` | 可复用工具增改删（开放案件引用中的工具禁止删除 400；冻结案件引用中的工具可删，历史事件保留编号+名称） |
| POST/PUT/DELETE | `/api/disease/cases[/{id}]` | 案件增改删；PUT 可改病害名称 / 潜伏时长（冻结案件只读，返回 409） |
| POST | `/api/disease/cases/{id}/events` | 登记确诊 / 到访 / 消毒事件并重算 |
| PUT/DELETE | `/api/disease/events/{id}` | 修改 / 删除单条事件并重算 |
| POST | `/api/disease/cases/{id}/freeze` | 确认冻结，保存案件快照 |
| GET | `/heat` | 作物积温预测页面 |
| GET | `/api/heat/state` | 批次 / 分区及当前批次全量重算结果；参数 `batch_id`、`zone_id`（按分区筛选） |
| GET | `/api/heat/export` | 按 `batch_id` / `zone_id` 导出 JSON 文件（含日台账、缺口、首次达标、外推依据） |
| POST/PUT/DELETE | `/api/heat/batches[/{id}]` | 积温批次增改删（参数保存 / 删除批次后全量重算；分区有批次时删除分区返回 400） |
| POST | `/api/heat/batches/{id}/readings` | 录入温度读数；单条对象或 `{"batch":[...]}`，支持补录（同批次时间戳唯一） |
| DELETE | `/api/heat/readings/{id}` | 删除单条读数并按时间全量重算 |
| GET | `/du` | 滴灌均匀度巡检页面 |
| GET | `/api/du/state` | 轮次列表与当前轮次整轮重算结果；参数 `round_id`、`valve_id`（按阀门筛选）、`status`（normal / shared_supply_anomaly / insufficient） |
| GET | `/api/du/export` | 导出当前轮次 JSON（含每区 DU、判定依据与维护清单） |
| POST/PUT/DELETE | `/api/du/rounds[/{id}]` | 巡检轮次增改删（新建时为阀门下各分区生成默认判定参数；删除级联参数与样本） |
| PUT | `/api/du/configs/{id}` | 修改某分区判定参数与实测入口压力并整轮重算 |
| POST | `/api/du/configs/{id}/samples` | 录入滴头样本；单条对象或 `{"batch":[...]}`，位置 首/中/尾（head/mid/tail）+ 编号唯一 |
| DELETE | `/api/du/samples/{id}` | 删除单条样本并整轮重算 |

## 项目结构

```
├── app.py              # Flask 路由 + SQLite 持久化（轮灌 + 水质 + 病害 + 积温 + 滴灌巡检）
├── scheduler.py        # 轮灌编排与校验引擎（15 分钟槽）
├── water_quality.py    # 水质指标校验与「连续两次」状态机
├── disease_trace.py    # 病害接触追踪：确诊/到访/消毒按时间重放引擎
├── crop_heat.py        # 作物积温：温度截断 / 梯形积分 / 午夜拆分 / 缺口登记 / 7 完整日外推
├── drip_du.py          # 滴灌均匀度：低四分位 DU / 共享供压 / 支管压损 / 疑似堵塞判定
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── data/               # SQLite 数据库（运行时生成）
└── static/
    ├── index.html      # 轮灌台页面结构
    ├── app.js          # 轮灌台渲染 / 表单 / 拖拽 / 即时校验
    ├── water.html      # 水质监测页面结构
    ├── water.js        # 水质录入 / 筛选 / 趋势图 / 导出
    ├── disease.html    # 病害追踪页面结构
    ├── disease.js      # 案件 / 工具 / 事件登记 / 重放结果 / 筛选 / 导出
    ├── heat.html       # 积温预测页面结构
    ├── heat.js         # 批次 / 读数录入 / 曲线 / 日台账 / 缺口 / 外推 / 导出
    ├── du.html         # 滴灌巡检页面结构
    ├── du.js           # 轮次 / 分区参数 / 样本录入 / DU 图表 / 判定表 / 维护清单 / 导出
    ├── du.css          # 滴灌巡检页补充样式
    └── style.css       # 时间轴等样式（water.css、disease.css、heat.css 为对应页面补充样式）
```

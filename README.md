# muse-panels

我用 Muse 搭建的全部面板（Web Artifact）源码归档库 — 六个面板各占一个
子目录，线上托管页面是运行副本、本仓库是源码的版本管理归档；代码与数据
严格分离（见「维护机制」）。

## 面板总览

| 显示名 | 目录 | 用途 | slug |
|---|---|---|---|
| 看板 · 投资组合 | `portfolio-board/` | 多账户美股持仓总览：全局/单账户页签、行情条、集中度、隐私模式、延长时段价格层 | jia-xin-chi-cang-kan-ban |
| 看板 · 投资历史 | `history-board/` | 账户整体总值的每日快照时间序列与曲线，只记总值、不记个股 | zhang-hu-li-shi-kan-ban |
| 看板 · 今日页 | `today-board/` | 静态晨报页：收盘口径的账户总览、昨夜动向、今日事件、金价与其他资产一行 | kan-ban-jin-ri-ye |
| 看板 · 全天动态 | `stream-board/` | 24 小时全资产事件流：七类事件、顶部实时行情条，事件保留 7 天 | kan-ban-quan-tian-dong-tai |
| 看板 · 待办总览 | `todo-board/` | 跨对话待办面板：待拍板 / 进行中 / 已办三区，面板内可拍板、巡检执行回写 | kan-ban-dai-ban-zong-lan |
| 看板 · 事件日历 | `calendar-board/` | 事件单一事实来源：未来 30 天财报 + 宏观日程滚动清单、按周分组、未确认财报日期标注 | kan-ban-shi-jian-ri-li |

每个面板目录下有独立的 README.md，写明该面板的功能、服务端动作清单与
特有维护口径。

## 维护机制

- **运行副本与源码归档分离**：面板在线上托管运行时（Web Artifact）实际
  运行；本仓库只保存源码（`client/` 前端、`server/` 服务端动作、`drizzle/`
  数据库迁移），做归档与版本管理，不直接驱动线上页面。
- **改动流程**：线上修改落地的当时，把源码同步进本仓库的 staging 区 →
  全量消毒扫描（真实持仓代码、金额、券商名、真实事项原文等特征词零命中
  才放行；代码内的种子/示例数据一律替换为虚构中性示例）→ 按功能在本地
  commit → 每日 07:00 由定时任务自动推送到 GitHub；仓库主说「push」时
  也可立即手动推送。
- **代码与数据分离**：运行时数据（持仓、现金、快照、事项、事件等）只
  存在线上运行时的 `app.db` 中，永不入库（`.gitignore` 已排除 `app.db`
  与全部 `*.db`、构建产物与依赖目录）。持仓类个人数据由私有库 muse-data
  每日 06:50 自动备份（导出格式 v2，自带校验和）；本仓库不含任何真实数据。
- **提交规范**：按功能提交，一个 commit 只含一个功能或一组相关改动；
  标题格式「目录名: 简洁描述」（前缀用英文目录名，可带层级，如
  `portfolio-board/server`），标题描述与正文用中文。

## 口径约定（持仓类面板）

- 官方口径一律采用**美股常规时段收盘价**：总值、市值、浮盈亏、占比、
  每日快照都按收盘价计算。
- 盘前 / 盘后 / 夜盘价格只作标注与「实时估算」参考，分时段独立保存、
  互不覆盖，绝不进入官方口径。
- 涨跌配色红涨绿跌；隐私模式遮罩具体金额与当日涨跌额，百分比与公开
  价格保持可见（成本价列不遮罩）。
- 历史看板中截图来源（`source = "screenshot"`）的记录受保护，不会被
  自动同步或重算覆盖。

## 运行环境说明

这套代码是为 Muse 的托管 Web Artifact 运行时（TypeScript space：
`client/` React 前端 + `server/src/actions.ts` 服务端动作 + `drizzle/` 迁移）
编写的。在自己的 Muse 中按同样的 space 结构导入各目录、分别构建即可
运行；行情来自公开数据源，均无需 API Key。迁移到其他运行时需要自行
适配其数据与动作层。

## 目录

```
portfolio-board/   看板 · 投资组合（client / server / drizzle）
history-board/     看板 · 投资历史（client / server / drizzle）
today-board/       看板 · 今日页（client / server / drizzle）
stream-board/      看板 · 全天动态（client / server / drizzle）
todo-board/        看板 · 待办总览（client / server / drizzle）
calendar-board/    看板 · 事件日历（client / server / drizzle）
```

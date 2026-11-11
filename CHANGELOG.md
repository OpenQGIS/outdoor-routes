# 更新日志 (Changelog)

记录 **Outdoor Routes（户外路线图鉴与标注工作台）** 的版本演进与重要功能变更。

---

## [2026-11-11] 浅色主题重构与交互体验优化

### 🎨 视觉与主题重构（Light Theme）
- **全站浅色纸面设计系统**：重写 [base.css](web/css/base.css)、[layout.css](web/css/layout.css)、[home.css](web/css/home.css)、[category.css](web/css/category.css)、[leaderboard.css](web/css/leaderboard.css) 与 [detail.css](web/css/detail.css)，将全局界面从深色切换为高可读性浅色主题（纸面底色 `#f4f6f9`、纯白卡片 `#ffffff`、Slate 深色排版 `#0f172a` / `#1e293b` 与 `#2563eb` 强调色）。
- **首页等高线与剖面图适配**：[contour-bg.js](web/js/contour-bg.js) 与 [elevation-profile.js](web/js/elevation-profile.js) 适配浅色背景网格、坐标轴文字及 POI 标注描边，提升曲线与坡度分段对比度。
- **3D 地形方块舞台浅色化**：[terrain-block-3d.js](web/js/terrain-block-3d.js) 将 3D 场景背景、参考网格 `GridHelper`、悬浮地标牌 `makeSpriteLabel`、分层设色等高线纹理、剖面裙边/底座、POI 标杆及 PNG 快照底部信息栏全面调整为浅色高对比样式。
- **动态 DOM 内联样式统一**：同步修正 [index.html](index.html)、[page-detail.js](web/js/page-detail.js)、[page-leaderboard.js](web/js/page-leaderboard.js) 与 [page-category.js](web/js/page-category.js) 中的深色背景残留文本与状态按钮配色。

### 🧩 详情页模块收敛与质检快捷定位
- **页面架构简化**：基于 [page-detail.js](web/js/page-detail.js) 与 [kmls-app.js](web/js/kmls-app.js) 完成 Page 4 详情页模块化拆分后的交互收口，移除详情页冗余的独立质检 Tab（`page-detail-qc.js`），保留「地形拆解 / POI / 标注与导出」三栏清晰结构。
- **地图直达异常点**：在分类地图页预览卡中保留轨迹质检状态展示，点击异常按钮可直接在二维地图上定位并高亮所有疑似异常轨迹点。

---

## [2026-11-11] 核心架构升级：四页式 SPA、3D 地形拆解、本地拖入预览与轨迹质检

### ✨ 新增功能
- **四页式空间交互架构**：拆分「首页门户 / 分类地图 / 年度榜单 / 3D 地形拆解」四个视图，并按页面模块（`page-home.js`、`page-category.js`、`page-leaderboard.js`、`page-detail.js`、`app-state.js`、`local-import.js`、`route-export.js`）重构前端代码。
- **本地 KML / KMZ / GPX 拖入即看**：支持将任意本地 KML/KMZ/GPX 文件直接拖入浏览器窗口或通过顶部「导入 KML」按钮载入，在「本地预览」页即时渲染轨迹、POI、高程剖面与 3D 地形，无需写回后台即可一键导出规范化文件。
- **3D 地形方块与交互式高程剖面图**：集成 Three.js + 在线 DEM 地形块渲染（支持等高线/卫星贴图切换、地形夸大倍数调节、多视角切换与 PNG 快照导出），并与底部高程剖面图（支持框选区间测坡、鼠标联动 3D 光标）双向联动。
- **轨迹质量检查与异常识别**：新增 [scripts/kml_qc.py](scripts/kml_qc.py) 与 [web/js/kml-qc.js](web/js/kml-qc.js)，支持检测时间倒流、零耗时跳变、高程尖刺与空间跳跃，并在地图上可视化标注异常点。

---

## [2026-11-11] 基础底座与初始路线库建设

- **双模式架构初始化（`511e75a`）**：建立 `master`（纯静态 GitHub Pages 展示）与 `dev`（`server.py` 本地标注工作台）自动识别双模式工作流，实现 KML/KMZ/GPX 无图清洗管线（`scripts/ingest_kml.py`）及单元测试。
- **多底图叠加与卫星图源（`98a9335`）**：接入 Esri / Bing 卫星影像、OpenMap 矢量底图与 Esri 山体阴影叠加层。
- **高德底图客户端纠偏（`eff7049`）**：实现高德瓦片 GCJ-02 → WGS-84 客户端实时投影纠偏，与标准 GPS 轨迹无偏对齐。
- **初始路线入库与规范导出（`cb1a877`）**：入库首批 4 条越野与徒步示范路线（累计 296.9 km），支持在 KML Document 中内嵌路线元数据及导出标准导航 KML。

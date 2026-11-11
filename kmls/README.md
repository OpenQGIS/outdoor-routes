# KML 路线收藏库

用于统一管理 **越野穿越 (`offroad`)**、**自行车 (`cycling`)**、**徒步 (`hiking`)** 三类路线数据。
遵循**原始重文件与展示轻量数据分离**原则：`kmls/inbox/` 与 `kmls/raw/` 仅保存在本地（Git 忽略），而清洗剥离图片与冗余样式后的纯几何 `kmls/normalized/geojson/` 与 `kmls/catalog.json`、`kmls/schema.json` 纳入 Git 版本控制，供 `master` 分支 GitHub Pages 纯静态展示与下载。

## 目录结构

```text
kmls/
├── 启动路线标注.bat         # 一键启动本地服务并打开根目录 index.html
├── inbox/                   # 【待分类暂存区】直接丢入未整理的 .kml / .kmz / .gpx，Git 忽略
├── raw/                     # 原始下载文件（已分类），Git 忽略
│   ├── offroad/<地区>/      # 如：kmls/raw/offroad/川西/甘孜-格聂南线-220km.kmz
│   ├── cycling/<地区>/
│   └── hiking/<地区>/
├── normalized/
│   └── geojson/             # 脚本清洗后输出的纯净 GeoJSON（仅路线 + POI），纳入 Git 供展示站读取
│       ├── offroad/
│       ├── cycling/
│       └── hiking/
├── schema.yaml / .json      # 分类配色、难度等级与 POI 语义映射规范（纳入 Git）
└── catalog.json             # 全库路线索引台账（含里程、爬升、bbox、POI 数量等，纳入 Git）
```

## 日常使用流程

1. **丢入待分类区**：把网上下载、群友转发且尚未整理的文件直接放进 `kmls/inbox/`。
2. **工作台 / AI 辅助分类整理**：
   - 双击 `启动路线标注.bat` 打开本地工作台（`http://127.0.0.1:8766/`），在「待分类 Inbox」标签内预览后一键归档；
   - 或运行 `D:\Miniforge3\python.exe scripts/ingest_kml.py --inspect-inbox` 提取无图摘要，辅助分类并移动到 `kmls/raw/<分类>/<地区>/`。
3. **清洗入库**：运行入库清洗脚本：
   ```powershell
   D:\Miniforge3\python.exe scripts/ingest_kml.py
   ```
   - 自动解压 `.kmz`（跳过内嵌图片文件）、清除 HTML `<img>` 标签与私有样式；
   - 提取路线与 POI 点位（按 `schema.yaml` 自动归类营地/水源/垭口/风险点等 `poi_kind`）；
   - 输出标准 GeoJSON 到 `kmls/normalized/geojson/...`；
   - 更新 `kmls/catalog.json` 与 `kmls/schema.json`（已手动补充的 `difficulty`、`sub_type`、`season`、`status`、`notes` 会被保留）。
4. 若从 `raw/` 中删除了某条路线，可加 `--prune` 清理台账中的失效记录：
   ```powershell
   D:\Miniforge3\python.exe scripts/ingest_kml.py --prune
   ```

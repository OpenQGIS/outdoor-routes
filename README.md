# Outdoor Routes — 户外路线图鉴与标注工作台

面向 **越野穿越 (`offroad`)**、**自行车 (`cycling`)**、**徒步 (`hiking`)** 的开源路线展示库与本地整理工作台，支持 **自动双模式**：
- **`master` 分支（纯静态展示主站）**：零后端依赖，可直接部署到 **GitHub Pages**，自动读取 `kmls/catalog.json`、`kmls/schema.json` 与清洗后的轻量 GeoJSON，支持地图筛选、POI 查看与 **GPX / KML / GeoJSON 一键导出下载**。
- **`dev` 分支（本地标注工作台）**：本地运行 `server.py`，自动激活编辑模式，读取本地 `kmls/inbox/` 与 `kmls/raw/`，支持无图清洗、分类归档、元数据标注与地图交互式 POI 增删改。

## 目录结构

```text
outdoor-routes/
├── index.html               # 展示与标注统一入口（GitHub Pages 根入口，自动识别静态/本地模式）
├── server.py                # 本地 HTTP 服务与路线管理 API（默认端口 8766）
├── 启动路线标注.bat         # 一键启动本地工作台并打开浏览器
├── kmls/
│   ├── schema.yaml / .json  # 分类配色、难度等级与 POI 语义映射规范
│   ├── catalog.json         # 全库路线索引台账（纳入 Git）
│   ├── normalized/geojson/  # 清洗后的纯路线 + POI GeoJSON（纳入 Git 供静态展示）
│   ├── inbox/               # 本地待分类暂存区（Git 忽略）
│   └── raw/                 # 本地原始下载文件（Git 忽略）
├── web/                     # 前端静态资源（Leaflet / CSS / JS）
├── scripts/
│   └── ingest_kml.py        # KML/KMZ/GPX 无图清洗、摘要提取与台账同步脚本
└── tests/
    └── test_ingest_kml.py   # 清洗与分类回归单元测试
```

## 日常双分支工作流

1. **在 `dev` 分支整理与标注本地路线**
   - 把新收集的 `.kml` / `.kmz` / `.gpx` 放入 `kmls/inbox/`。
   - 双击 **`启动路线标注.bat`**（或运行 `D:\Miniforge3\python.exe server.py 8766`），浏览器访问 `http://127.0.0.1:8766/`（自动进入 **🟢 本地标注** 模式）。
   - 预览、分类归档、补充难度/适行季节/备注及 POI 路点，清洗后的轻量化 GeoJSON 会自动输出到 `kmls/normalized/geojson/` 并更新 `kmls/catalog.json`。
   - 也可以命令行批量检查/清洗：
     ```powershell
     D:\Miniforge3\python.exe scripts/ingest_kml.py --inspect-inbox
     D:\Miniforge3\python.exe scripts/ingest_kml.py
     ```
2. **本地预览纯静态展示效果**
   - 访问 `http://127.0.0.1:8766/?mode=static` 即可模拟 GitHub Pages 纯静态只读效果（**🌐 静态展示** 模式）。
3. **发布到 `master` 展示分支**
   ```powershell
   git add kmls/catalog.json kmls/schema.json kmls/normalized/
   git commit -m "chore(routes): update curated routes"
   git checkout master
   git merge dev
   git push origin master
   git checkout dev
   ```

## 运行测试

```powershell
D:\Miniforge3\python.exe -m unittest tests/test_ingest_kml.py -v
```

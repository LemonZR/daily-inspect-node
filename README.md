# 服务器信息采集与留证管理系统

一台中心机通过 SSH（或本机/模拟）对**多台 Linux 服务器**执行各自分配的命令，浏览器可视化管理，实时查看终端原生输出，并按计划定时归档留证（终端截图 + 原始输出 + 校验清单）。

> **项目声明**：本项目为 **AI 辅助开发**，并已在真实生产环境中**实际应用、持续稳定运行**。开源版本已清除所有真实主机、凭据与业务数据，仅保留通用程序与脱敏示例，可安全部署使用。

- **中心端零 npm 依赖**：仅用 Node.js 标准库，前端原生 JS，无框架、无 CDN。
- **被巡检机零安装**：只执行标准 shell 命令，不需要装 agent。
- **截图渲染**：本机 Python + `pyte` + `Pillow` 把终端 ANSI 画面渲染成 PNG，中文不乱码。
- **留证可校验**：每天目录自带 `manifest.csv`（UTF-8 BOM，Excel 直接打开）、`00_summary.json`、`SHA256SUMS`；SQLite 目录索引可随时从原始文件重建。

```
┌──────────────────────────────────────────────┐
│        中心机 (node server.js, 浏览器看板)      │
│  实时看板: 终端样式展示每台机每条命令最新输出     │
│  定时任务: daily/interval 触发全量巡检            │
│  归档: evidence/日期/服务器名称/截图+txt+ansi     │
│  截图: 本机 Python(pyte+Pillow) 渲染终端原生 PNG   │
│  索引: SQLite 目录(可重建) + JSONL 兜底            │
└──────────────────────────────────────────────┘
        │ SSH(密钥/密码)        │ 本机 / 模拟
     生产服务器              演示/自测
```

## 特性

- 🖥️ **前台管理**：浏览器里增删改服务器、命令清单；每台服务器**勾选自己要执行的命令**（不同机器跑不同命令）。
- 📺 **实时查看**：按命令选项卡看各服务器最新输出，含原始 ANSI 颜色、提示符、采集时间。
- ⏰ **定时任务**：每日定点 / 固定间隔自动全量巡检，显示开关、规则、下次/上次执行、执行历史。
- 🗂️ **归档留证**：按**日期 → 服务器名称**组织，截图与 `.txt`/`.ansi` 平铺；同一天多次巡检以 `HHMMSS` 批次前缀区分、不覆盖。
- 📷 **自动截图**：定时巡检时把每条命令的终端画面渲染成 PNG，中英混排（ASCII 等宽字体 + 系统 CJK 字体）。
- 🗃️ **SQLite 目录索引（可重建）**：按服务器/状态/日期/关键字检索历史；索引损坏可一键从原始文件全量重建，不影响留证本体。
- 🛡️ **健壮性**：配置与清单原子写（临时文件 + rename）、单实例锁防重复启动、SQLite 不可用时退到 JSONL、保留期可配置。
- 🔐 **凭据安全**：SSH 密码 AES-256-GCM 加密落盘，页面只收占位符；登录口令 scrypt 加盐哈希，不存明文。
- 👥 **双账号 RBAC**：`admin` 可配置与改密；`viewer` 只读，写操作服务端一律 403。

## 快速开始

### 前置条件

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | 14+（推荐 18.16.0） | 中心端运行时，**零 npm 依赖**，无需 `npm install` |
| Python 3 | 3.8+（可选） | 仅自动截图需要；不装也能巡检与归档，只是不生成 PNG |
| pip | 随 Python 3 | 用于一键安装截图依赖 |

### Linux / macOS

```bash
cd daily-inspect-node
chmod +x install.sh start.sh
./install.sh          # 联网安装 pyte/wcwidth/Pillow 并校验，出现 IMPORT_OK 即成功
./start.sh            # 启动服务
```

浏览器打开 `http://localhost:8082`。端口被占用会自动顺延，以窗口打印地址为准。

> 若系统 Python 处于 PEP 668 外部管理环境（Debian 12 / Ubuntu 22.04+），`install.sh` 会自动追加 `--break-system-packages`。更推荐用虚拟环境隔离：
> `python3 -m venv .venv && source .venv/bin/activate && ./install.sh`。

### Windows 7 / 10 / 11

1. 安装 Node 18.16.0（Win7 实测可用）并加入 PATH。
2. 安装 Python 3（3.8+，勾选 Add to PATH）。
3. 双击 `install.bat` 安装截图依赖，出现 `IMPORT_OK` 即成功。
4. 启动方式三选一：

| 脚本 | 窗口 | 日志 | 适用 |
|---|---|---|---|
| `start_background.vbs` | 无窗口（后台常驻） | `logs/server.log` | 推荐日常部署 |
| `start_background.bat` | 无窗口（后台常驻） | `logs/server.log` | VBS 被组策略/杀毒禁用时 |
| `start.bat` | 保留黑窗口 | 直接打印窗口 | 调试/临时用，关窗口即停 |

后台方式停止：双击 `stop_background.vbs`（只结束本目录的 node，不影响其它 Node 程序）。

> `scripts/launch_hidden.ps1` 与 `scripts/_hidden_worker.cmd` 是后台启动的内部辅助脚本，由上面两个后台入口自动调用，**不需要也不建议手动运行**。其中 PowerShell 负责以隐藏窗口方式分离启动进程，`.cmd` 负责实际执行 `node server.js` 并把输出追加到 `logs/server.log`。

### 首次启动后的初始化

- 首次启动会自动生成 `config/config.json`（含一个**演示节点**，可直接看效果）与 `config/auth.json`；首次保存 SSH 密码时再生成 `config/secret.key`（密码加密密钥）。
- 随机初始口令写入 `config/INITIAL_PASSWORD.txt`。浏览器用该文件里的账号登录（管理员 `admin`，查看用户 `viewer`），**登录后立刻在「配置管理 → 账号设置」改密，然后删除该文件**。
- 以上运行时文件均已在 `.gitignore` 中排除，不会、也不要提交到仓库。配置模板见 `config/config.example.json`。

> 迁移/备份时，`config/secret.key` 必须与 `config/config.json` 一起拷贝；只拷配置不拷密钥会解不开已存 SSH 密码（可在管理面板重新填一次）。

## 目录结构

```
daily-inspect-node/
├── server.js                  中心服务（Node 标准库，零依赖）
├── requirements.txt           Python 截图依赖清单
├── install.sh / install.bat   一键安装依赖（Linux / Windows）
├── start.sh / start.bat       启动脚本（Linux / Windows）
├── scripts/                   内部工具（使用人无需直接运行）
│   ├── render_shot.py         截图渲染器（pyte + Pillow）
│   ├── index_evidence.py      SQLite 目录索引（建库/写入/统计/全量重建）
│   ├── zip_evidence.py        归档打包工具
│   ├── launch_hidden.ps1      后台启动内部辅助（被 start_background.vbs/.bat 调用）
│   ├── _hidden_worker.cmd     后台启动内部辅助（被 launch_hidden.ps1 调用）
│   └── fix_console_font.ps1   控制台字体修正（start.bat 自动调用）
├── config/
│   ├── config.example.json    配置模板（入库）
│   └── config.json            实际配置（自动生成，不入库）
├── public/                    前端 index.html / style.css / app.js / login.*
├── data/                      实时最新结果 + 定时任务状态（自动生成，不入库）
├── evidence/                  归档留证（自动生成，不入库）
│   └── YYYY-MM-DD/
│       ├── 00_summary.json    当天累计汇总 + batches[]
│       ├── manifest.csv       当天全部命令明细（中文表头 + BOM）
│       ├── SHA256SUMS         当天全量校验清单
│       └── <服务器名称>/      该机当天所有 .png / .txt / .ansi
├── logs/                      运行日志（自动生成，不入库）
└── README.md
```

## 使用说明

### 配置服务器与命令

在「⚙ 管理 → 目标服务器」新增服务器，填名称、主机地址、分组，选采集方式（SSH / 本机 / 模拟）与认证方式（密钥 / 密码），并勾选它要执行的命令。「测试连接」可即时验证。

在「命令清单」增删改命令（名称、命令串、超时、启用）。**留证一律保存原始终端输出**，实时看板的 CPU/内存/磁盘数值与告警颜色由程序按命令内容自动识别（`mpstat` / `free` / `df`），无需配置解析规则。

配置保存采用**差异提交**：只上传与加载时基线不同的字段（命令/服务器按 id 生成条目级补丁），既快又避免命令原文与资产清单被整体重传。

### SSH 接入

- **密钥（免密，推荐）**：中心机 `ssh-keygen -t rsa -b 4096`，公钥追加到目标机 `~/.ssh/authorized_keys`；服务器认证方式选「密钥(免密)」，密钥路径填 `~/.ssh/id_rsa`。Windows 下 `~\.ssh\id_rsa`、`%USERPROFILE%\.ssh\id_rsa` 均自动展开。
- **用户名密码**：
  - Linux 中心机需系统安装 `sshpass`（`apt-get install -y sshpass` / `yum install -y sshpass`）。
  - Windows 中心机需安装 PuTTY 的 `plink.exe` 并加入 PATH（首次连新机先命令行接受主机密钥）。
  - 密码加密落盘、页面不回显；密码框留空 = 沿用已存密码。
- 所有 SSH 命令走统一闸门（全局最多 5 并发、同一 `用户@主机:端口` 最多 2），瞬时错误自动重试 2 次。

### 全局设置要点

| 字段 | 默认 | 说明 |
|---|---|---|
| `pollIntervalMs` | 86400000 | 实时轮询间隔(ms)，默认 1 天；**填 0 = 关闭实时轮询**，只对目标机发起定时巡检连接 |
| `historyMaxPoints` / `historyMaxRuns` | 2000 / 2000 | 实时历史点 / 执行历史保留条数 |
| `retainDays` | 0 | 归档保留天数，0=永久 |
| `evidenceImmutable` | true | **仅 Linux**：巡检产物 `.ansi/.txt/.png` 生成后 `chattr +i` 防误删；Windows 自动跳过 |
| `requestTTY` | true | SSH 请求 pty，保留原生提示符/颜色 |
| `shotEnabled` / `shotTheme` / `shotFontSize` | true / dark / 14 | 自动截图开关、主题、字号 |
| `shotFontPath` / `shotCjkFontPath` | auto | 等宽 / 中文 CJK 字体路径（auto 自动探测系统字体） |
| `pythonExe` | 空 | 指定 Python 3 解释器绝对路径；留空则依次探测 |
| `sqliteIndex` | true | 是否写 SQLite 目录索引 |

### 归档结构

```
evidence/2026-01-01/
├── 00_summary.json
├── manifest.csv
├── SHA256SUMS
├── 业务服务器-01/
│   ├── 181956_001_业务服务器-01_主机与时间.png
│   ├── 181956_001_业务服务器-01_主机与时间.txt
│   ├── 181956_001_业务服务器-01_主机与时间.ansi
│   └── ...
└── 数据库服务器-01/ ...
```

- 路径只有 4 层：`evidence/日期/服务器名称/文件`，文件名自带「服务器名称 + 命令名称」。
- 同一天多次巡检以 `HHMMSS_` 批次前缀区分；`manifest.csv` 按批次幂等追加，`00_summary.json` 保留全部批次，`SHA256SUMS` 每次全量重算。
- `.ansi` 是含 ANSI 控制码的**原始终端输出**（留证权威原件、PNG 渲染输入）；`.txt` 是剥离控制码的纯文本；`.png` 是还原终端画面后的截图。三者共用 basename，均受 `SHA256SUMS` 覆盖。
- 清单缺失时（如被手动删除），打开归档列表会自动从现存文件重建并落盘，徽标显示「汇总缺失·已重建」；无法还原的主机/命令原文等字段留空，并在汇总里标记 `recovered`。

### 归档落锁防删除（仅 Linux）

- **自动落锁**：全局设置 `evidenceImmutable=true`（默认）时，每批巡检产物 `.ansi` / `.txt` / `.png` 生成后立即执行 `chattr +i`。普通 `rm` 和页面操作都无法删除；`manifest.csv`、`00_summary.json`、`SHA256SUMS` 因需按批次追加 / 重算，**不参与加锁**。
- **手动上锁 / 解锁**：归档列表每一天在统计数字后显示锁图形——**绿色闭合锁**表示该天全部已上锁，**黄色开锁**表示有未上锁文件；点击即可切换（已锁则解锁、未锁则上锁），均需二次确认。页首「全部留证」锁图形可一键批量切换。手动上锁即使全局开关关闭也会生效。
- **只加标记、不改内容**：上锁只给尚未保护的产物补 `+i`，解锁只解除 `+i`；都不修改文件内容、`manifest.csv`、`SHA256SUMS` 与 zip 缓存，也不改动 `.txt` / `.ansi`。界面用非模态二次确认，避免浏览器原生弹窗藏到窗口后面。
- **与重出截图互斥**：「重出截图」会先临时解锁对应 PNG，渲染替换后再锁回，并同步重算 `SHA256SUMS`、清掉旧 zip 缓存；原始 `.txt` / `.ansi` 始终不动。给旧截图补锁请用归档列表的锁图形，不要用「重出截图」（后者会重渲染 PNG，内容会变）。
- **保留期清理**：`retainDays > 0` 时超期目录会先自动 `chattr -i` 再清理，因此已上锁的旧归档仍可被授权回收。
- **降级与手工操作**：Windows 中心机无 `chattr`，开关与锁图形自动隐藏，接口返回 `supported=false`；无 `chattr`、无 `CAP_LINUX_IMMUTABLE` 或文件系统不支持时自动跳过并只告警一次，不影响巡检。查看标记：`lsattr evidence/2026-01-01/*/*`；手工解除：`find evidence/2026-01-01 -type f -exec chattr -i {} +`。

### HTTP API（部分）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/config` | 读取 / 保存配置（支持 `__patch` 差异提交） |
| POST | `/api/server/test` | 测试服务器连接 |
| GET | `/api/status` | 各服务器各命令最新状态 |
| POST | `/api/schedule/run` | 手动触发全量巡检归档 |
| GET | `/api/evidence` | 按天 → 服务器名称列出归档 |
| GET | `/api/evidence/search` | 历史检索（q/server/status/from/to） |
| POST | `/api/evidence/reindex` | 从原始文件全量重建索引 |
| GET | `/api/health` | 存储健康：占用/磁盘水位/索引统计/失败数 |
| GET | `/api/evidence/download` | 下载归档（`safe=1` 走 base64 安全通道） |
| POST | `/api/evidence/lock` | 给某天 / 全部归档上锁（`{key}` 或 `{all:true}`） |
| POST | `/api/evidence/unlock` | 解除防删除标记（`{key}` 或 `{all:true}`） |

## 日志与排障

- 日志位置：`logs/server.log`，单文件 8MB 上限自动轮转。
- **访问日志**：`[access] 时间 IP 账号/角色 方法 路径 -> 状态码 字节 耗时`；不记请求体与 Cookie/token，query 里的敏感键值脱敏。
- **采集失败分类**：`auth`（登录）、`permission`（目标机权限）、`write`（本机写归档）、`timeout`、`network`、`tool`、`command`、`unknown`，格式如 `[collect][登录/认证失败] 服务器 / 命令 -> 原因`。
- 排障顺序：先看 `[access]` 确认请求到达与状态码 → 再看 `[collect]`/`[sched]` 确认失败分类 → 最后对照归档里的 `failures[]` 与 `manifest.csv` 末两列。
- **截图不可用**：确认 `install.sh` / `install.bat` 出现 `IMPORT_OK`，且安装与运行用同一个 Python 解释器；服务日志会逐条打印每个候选解释器的失败原因。

## 安全说明

- 本项目**不在仓库内保存任何真实凭据、主机地址或归档数据**；这些全部由程序在首次启动时本地生成，并已被 `.gitignore` 排除。
- SSH 密码以 AES-256-GCM 加密落盘，但**有本机目录读取权限的管理员仍可解密**——请控制 `config/` 目录权限，不要共享或外发该目录。
- 管理界面账号口令为 scrypt 加盐哈希；首次登录后请立即改密并删除 `INITIAL_PASSWORD.txt`。
- 归档留证可能包含生产服务器的命令输出（主机名、路径、账号等），请按所在单位的数据管理制度保管与流转。
- 建议不要在公网直接暴露 8082 端口，内网使用或置于反向代理 + 访问控制之后。

## 许可证

MIT License，详见 [LICENSE](LICENSE)。

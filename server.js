/*
 * 每日服务器巡检留证中心 - 中心服务端
 * Node.js 纯标准库, 零依赖, 兼容 Node 14/18/22 (Win7 实测 Node 18.16.0 可用)
 *
 * 架构:
 *   一台中心机, 通过 SSH(密钥/密码) 或 本机 执行各服务器"各自分配"的命令.
 *   - 实时看板: 按 settings.pollIntervalMs 周期采集, 终端原生输出(保留 ANSI)展示.
 *   - 定时任务: 按 schedule(daily/interval) 触发全量巡检, 归档到 evidence/ .
 *   - 留证归档: 每台机每次一条命令 -> .ansi/.txt/.png(同 basename) + manifest + SHA256SUMS.
 *   - 截图: 定时巡检时调用本机 Python(pyte+Pillow) 把终端画面渲染成 PNG, 与 .txt/.ansi 平铺在服务器名称目录。
 *   - 索引: 每批次元数据写入 evidence/index.db(SQLite, 可重建), Python 不可用时退到 index.jsonl。
 *
 * 启动: node server.js   (或 npm start)
 * 访问: 浏览器打开 http://localhost:8082
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { exec, execFile, execFileSync, spawn } = require('child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config', 'config.json');
// 密码加密密钥: 与 config.json 同目录, 迁移配置时必须一起带走; 丢失后需重新填写密码。
const SECRET_PATH = path.join(ROOT, 'config', 'secret.key');
// 管理员登录凭据: 只存用户名 + scrypt 盐值/哈希, 绝不存明文密码。迁移时需随 config 一起带走。
const AUTH_PATH = path.join(ROOT, 'config', 'auth.json');
// 首次启动的随机初始密码写这里(仅此一次), 管理员登录后应立即改密并删除此文件。
// 绝不硬编码弱口令: 安全演练扫描会用 admin/admin123 等字典爆破默认凭据。
const AUTH_INIT_PASS_PATH = path.join(ROOT, 'config', 'INITIAL_PASSWORD.txt');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');
// 归档压缩包缓存: 放在 data/ 下, 不污染 evidence 留证目录(审计原件保持原样)。
const ZIP_DIR = path.join(DATA_DIR, 'zips');
const SCHED_STATE_PATH = path.join(DATA_DIR, 'schedule_state.json');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'server.log');
const TICK_MS = 1000; // 调度器唤醒周期

// ---------- 工具函数 (保守语法, 不用 ?? / ?. / Array.at / replaceAll) ----------
function def(v, d) { return (v === undefined || v === null) ? d : v; }
// 以程序根目录为基准解析路径: 绝对路径原样返回; 相对路径(含 ./ ../)相对 ROOT;
// ~ 展开为用户主目录。保证配置里填相对路径时换目录部署也不失效。
function toAbs(p) {
  if (!p) return p;
  let s = String(p).trim();
  if (s === '~' || s.indexOf('~/') === 0 || s.indexOf('~\\') === 0) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    s = home + s.slice(1);
  }
  s = s.replace(/%USERPROFILE%/gi, process.env.USERPROFILE || '');
  return path.isAbsolute(s) ? s : path.resolve(ROOT, s);
}
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtTs(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function dateStr(ts) { const d = new Date(ts == null ? Date.now() : ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function timeStr(ts) { const d = new Date(ts == null ? Date.now() : ts); return pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()); }
// 批次 tag(123216 / 140002_2) -> 可读时间标签(12:32:16 / 14:00:02 第2次)
function batchLabel(tag) {
  const m = /^(\d{2})(\d{2})(\d{2})(?:_(\d+))?$/.exec(String(tag == null ? '' : tag));
  if (!m) return String(tag == null ? '' : tag);
  return m[1] + ':' + m[2] + ':' + m[3] + (m[4] ? ' 第' + m[4] + '次' : '');
}
function genId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function allSettled(promises) {
  return Promise.all(promises.map(function (p) {
    return Promise.resolve(p).then(function (v) { return { status: 'fulfilled', value: v }; },
      function (e) { return { status: 'rejected', reason: e }; });
  }));
}

// ---------- 文件日志 (Linux) ----------
// Windows 端由 start_background.bat 把 stdout/stderr 重定向到 logs/server.log, 无需此处介入。
// Linux 端 start.sh 是前台 exec、systemd 日志进 journald, 都不会生成实体 logs/server.log,
// 排查问题不便。这里在服务端内部把 console 同步追加到 logs/server.log, 覆盖任意启动方式。
// 只在非 Windows 启用, 避免与 Windows 外部重定向重复写同一文件。
function installFileLogger() {
  if (process.platform === 'win32') return;
  var util = require('util');
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { return; }
  var fd;
  try { fd = fs.openSync(LOG_PATH, 'a'); } catch (e) { return; }
  var MAX_LOG_BYTES = 8 * 1024 * 1024; // 单文件上限 8MB, 超过轮转为 server.log.1, 避免日志无限增长
  var logBytes = 0;
  try { logBytes = fs.statSync(LOG_PATH).size; } catch (e) {}
  function rotate() {
    try { if (fd) fs.closeSync(fd); } catch (e) {}
    try { fs.renameSync(LOG_PATH, LOG_PATH + '.1'); } catch (e) {} // POSIX rename 会覆盖旧 .1
    try { fd = fs.openSync(LOG_PATH, 'a'); logBytes = 0; } catch (e) {}
  }
  function line(args) {
    try {
      var text = util.format.apply(util, args);
      // [access] 行自带时间戳(Windows 外部重定向也能看到), 这里不再重复加前缀。
      var prefix = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(text) ? '' : '[' + fmtTs(Date.now()) + '] ';
      var buf = Buffer.from(prefix + text + '\n', 'utf8');
      if (logBytes + buf.length > MAX_LOG_BYTES) rotate();
      if (fd) { fs.writeSync(fd, buf); logBytes += buf.length; }
    } catch (e) {}
  }
  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      line(args);          // 写文件(带时间戳)
      orig.apply(null, args); // 保留原始终台输出
    };
  });
}

// ---------- SSH 连接闸门 ----------
// sshd 默认 MaxStartups 10:30:100: 同一时刻超过 10 个"未完成认证"的连接就开始随机断开,
// 客户端典型报错 kex_exchange_identification: read: Connection reset by peer / Connection closed.
// 实时轮询(服务器数×命令数) + 定时全量巡检叠加, 或把同一台主机配置两遍, 都很容易撞上。
// 这里统一限流: 全局最多 5 条、同一 用户@主机:端口 最多 2 条, 其余排队; 瞬时失败自动重试。
const SSH_MAX_PARALLEL = 5;
const SSH_PER_HOST_PARALLEL = 2;
const SSH_RETRY_MAX = 2;
const SSH_RETRY_BASE_MS = 500;
let sshActive = 0;
const sshWaiters = [];
const sshHostActive = Object.create(null);

function sshSlotKey(server) {
  const ssh = server.ssh || {};
  return def(ssh.user, 'root') + '@' + String(server.host || '') + ':' + def(ssh.port, 22);
}
function takeSshSlot(key) {
  return new Promise(function (resolve) {
    function tryTake() {
      const perHost = sshHostActive[key] || 0;
      if (sshActive < SSH_MAX_PARALLEL && perHost < SSH_PER_HOST_PARALLEL) {
        sshActive++;
        sshHostActive[key] = perHost + 1;
        resolve();
        return true;
      }
      return false;
    }
    if (!tryTake()) sshWaiters.push(tryTake);
  });
}
function pumpSshWaiters() {
  const retry = [];
  while (sshWaiters.length) {
    const w = sshWaiters.shift();
    if (!w()) retry.push(w); // 单主机限额仍卡住, 留到下次释放再试
  }
  for (let i = 0; i < retry.length; i++) sshWaiters.push(retry[i]);
}
function releaseSshSlot(key) {
  sshActive = Math.max(0, sshActive - 1);
  const left = Math.max(0, (sshHostActive[key] || 1) - 1);
  if (left) sshHostActive[key] = left; else delete sshHostActive[key];
  pumpSshWaiters();
}
function isTransientSshError(msg) {
  // Connection refused 通常是端口/主机确实不可达, 不重试, 避免对示例 IP 每轮刷日志。
  return /kex_exchange_identification|ssh_exchange_identification|Connection reset by peer|Connection closed by[^\n]*port|Software caused connection abort|unexpected EOF|timed out/i.test(String(msg || ''));
}
function sshErrorHint(msg) {
  if (!/kex_exchange_identification|ssh_exchange_identification/i.test(String(msg || ''))) return '';
  return '\n\n提示: 这是 SSH 握手阶段连接被对端断开, 不是私钥/免密失败(私钥错会报 Permission denied (publickey))。\n'
    + '最常见原因是同一主机并发连接过多, 触发服务端 sshd 的 MaxStartups 限制; 也可能是 fail2ban/防火墙/网络抖动。\n'
    + '程序已限制并发并自动重试; 若仍频繁出现, 请把同一主机的命令合并到一条服务器配置, 或在服务端调高 MaxStartups。';
}
// ---------- 采集失败分类 / 日志 ----------
// 旧版失败原因只留在内存 state.error 里, 00_summary.json 只记 failed 数量,
// manifest.csv 没有原因列, 日志文件里更是一条都不打 —— 用户只能看到"失败 N 条",
// 分不清是登录失败、目标机文件权限、还是本机写盘权限。这里统一分类并落日志。
const FAIL_KINDS = {
  auth: '登录/认证失败',
  permission: '目标机文件权限不足',
  write: '本机写归档失败',
  timeout: '连接/命令超时',
  network: '网络不通或连接被重置',
  tool: '采集工具不可用',
  command: '远程命令执行报错',
  unknown: '其他原因'
};
function classifyFailure(err, ctx) {
  const raw = String(err && typeof err.message === 'string' ? err.message : (err || ''));
  const s = raw.toLowerCase();
  if ((ctx && ctx.write) || (err && err.writeError)) return 'write';
  // 认证失败优先: "Permission denied (publickey/password)" 必须归 auth,
  // 不能和命令 stderr 里的 "xxx: Permission denied" 混为一谈。
  if (/permission denied\s*\((publickey|password|keyboard-interactive|gssapi)/i.test(raw)
    || /authentication failed|auth failed|access denied|too many authentication failures/i.test(s)
    || /permission denied,\s*please try again|密码错误|用户名或密码错误/i.test(raw)
    || /ssh 私钥文件无法访问|private key[^\n]*(invalid|unreadable|not found)/i.test(raw)
    || /host key[^\n]*(not cached|verification failed|mismatch)/i.test(raw)) return 'auth';
  if (/permission denied|operation not permitted|read-only file system|权限不够|没有权限|insufficient permission/i.test(raw)) return 'permission';
  // 工具/环境缺失(sshpass/plink 找不到、私钥路径打不开、渲染器不可用)
  if (/sshpass|plink|renderer unavailable|工具不可用|未找到|not found|command not found/i.test(raw)
    && /未找到|不可用|unavailable|无法访问|not found|missing|没有找到/i.test(raw)) return 'tool';
  if (/timed out|timeout|超时|etimedout/i.test(s)) return 'timeout';
  if (/connection refused|connection reset|econnrefused|econnreset|ehostunreach|enetunreach|network is unreachable|no route to host|host is unreachable|kex_exchange_identification|connection closed|socket hang up|getaddrinfo|enotfound|fetch failed/i.test(s)) return 'network';
  // 走到这里且确有错误文本: 基本都是远程命令自身的 stderr(exit != 0)。
  if (raw.trim()) return 'command';
  return 'unknown';
}
const FAIL_LOG_SEEN = Object.create(null);
const FAIL_LOG_TTL = 5 * 60 * 1000; // 实时轮询同一原因 5 分钟内只记一次, 避免刷屏
function logCollectFailure(scope, server, chk, cat, msg) {
  const first = String(msg || '').split('\n')[0].slice(0, 200);
  const key = [scope, server && server.id, chk && chk.id, cat, first].join('|');
  const now = Date.now();
  // 定时/手动巡检每次都记(每次都是独立留证批次); 实时轮询按原因去重。
  if (scope === 'poll' && FAIL_LOG_SEEN[key] && now - FAIL_LOG_SEEN[key] < FAIL_LOG_TTL) return;
  FAIL_LOG_SEEN[key] = now;
  const who = (server && (server.name || server.host)) || '?';
  const what = (chk && (chk.name || chk.id)) || '?';
  console.warn('[collect][' + (FAIL_KINDS[cat] || cat) + '] ' + scope + ' ' + who + ' / ' + what + ' -> ' + first);
}
function quoteArg(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function quoteDbl(s) { return '"' + String(s).replace(/"/g, '\\"') + '"'; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, ''); }
function cleanOutput(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/\n?(Shared )?Connection to [^\n]* closed\.[^\n]*/g, '');
}
function decodeBuf(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) {
    try { return new TextDecoder('gbk').decode(buf); }
    catch (e2) { return Buffer.from(buf).toString('utf8'); }
  }
}
// 原子写: 先写临时文件再 rename, 避免断电/崩溃时留下半截文件 (留证/索引的健壮性关键)。
function atomicWrite(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp' + process.pid + '_' + Date.now();
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
// ---------- 密码加密 (跨平台, Node 内置 crypto, 零外部依赖) ----------
// 密文格式: enc:v1:<base64url(iv)>.<base64url(tag)>.<base64url(ciphertext)>
// 不加密密钥本身: 后台无人值守程序无法要求每次启动输入主口令。密钥文件放 config/ 随配置迁移,
// 目标是避免 config.json / API 响应里出现明文密码; 同时控制该目录的文件权限。
const PW_ENC_PREFIX = 'enc:v1:';
const PW_MASK = '__SAVED__';   // GET /api/config 返回给前端的占位符
const PW_CLEAR = '__CLEAR__';  // 前端"清除已存密码"标记
let _secretKey = null;
let _secretStatus = 'unknown';
// 密钥丢失导致解不开的密文: 原样留存, 避免用户只是保存别的设置就把密码清掉。
let brokenCipher = {};

function getSecret() {
  if (_secretKey) return _secretKey;
  try {
    if (fs.existsSync(SECRET_PATH)) {
      const raw = fs.readFileSync(SECRET_PATH, 'utf8').trim();
      const k = raw ? Buffer.from(raw, 'base64') : null;
      if (k && k.length === 32) { _secretKey = k; _secretStatus = 'ok'; return k; }
    }
  } catch (e) { _secretStatus = 'error: ' + e.message; }
  try {
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
    const key = crypto.randomBytes(32);
    // 0o600 在 Linux 有效; Windows 下由 ACL 决定, 但仍写入以表明意图。
    fs.writeFileSync(SECRET_PATH, key.toString('base64') + '\n', { mode: 0o600 });
    try { fs.chmodSync(SECRET_PATH, 0o600); } catch (e) {} // Windows 忽略, Linux 确保仅属主可读写
    _secretKey = key; _secretStatus = 'ok';
    console.log('[crypto] 已生成密码密钥 ' + SECRET_PATH + '，请随 config 一起备份，勿删除');
    return key;
  } catch (e) {
    _secretStatus = 'error: ' + e.message;
    console.error('[crypto] 密钥文件不可用，密码将退回明文保存: ' + e.message);
    return null;
  }
}
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) {
  let x = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (x.length % 4) x += '=';
  return Buffer.from(x, 'base64');
}
function encryptPassword(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  const key = getSecret();
  if (!key) return String(plain);
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return PW_ENC_PREFIX + b64url(iv) + '.' + b64url(c.getAuthTag()) + '.' + b64url(ct);
  } catch (e) {
    console.error('[crypto] 加密失败: ' + e.message);
    return String(plain);
  }
}
function decryptPassword(stored) {
  if (stored === undefined || stored === null || stored === '') return '';
  const s = String(stored);
  if (s.indexOf(PW_ENC_PREFIX) !== 0) return s; // 兼容旧版明文配置
  const key = getSecret();
  if (!key) { console.warn('[crypto] 密钥不可用，无法解密已保存密码，请重新填写'); return ''; }
  try {
    const parts = s.slice(PW_ENC_PREFIX.length).split('.');
    if (parts.length !== 3) throw new Error('密文格式错误');
    const d = crypto.createDecipheriv('aes-256-gcm', key, unb64url(parts[0]));
    d.setAuthTag(unb64url(parts[1]));
    return Buffer.concat([d.update(unb64url(parts[2])), d.final()]).toString('utf8');
  } catch (e) {
    console.warn('[crypto] 解密失败(密钥文件可能被替换): ' + e.message + '，请重新填写密码');
    return '';
  }
}
function eachServerPassword(cfg, fn) {
  (cfg && cfg.servers || []).forEach(function (s) { if (s && s.ssh) s.ssh.password = fn(s.ssh.password); });
}
function decryptConfigPasswords(cfg) {
  brokenCipher = {};
  ((cfg && cfg.servers) || []).forEach(function (s) {
    if (!s || !s.ssh) return;
    const raw = s.ssh.password;
    if (typeof raw === 'string' && raw.indexOf(PW_ENC_PREFIX) === 0) {
      const dec = decryptPassword(raw);
      if (dec) s.ssh.password = dec;
      else { s.ssh.password = ''; brokenCipher[s.id] = raw; } // 密钥丢失/被替换
    } else s.ssh.password = raw || ''; // 兼容旧明文
  });
}
function encryptConfigPasswords(cfg) { eachServerPassword(cfg, encryptPassword); }
function publicConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg || {}));
  eachServerPassword(out, function (p) { return p ? PW_MASK : ''; });
  return out;
}
// 前端回传的密码合并: 占位符/空=保留原值, __CLEAR__=清空, 其它=用户新填的明文。
function mergeSavedPasswords(incoming, oldCfg) {
  const oldList = (oldCfg && oldCfg.servers) || [];
  ((incoming && incoming.servers) || []).forEach(function (s) {
    if (!s || !s.ssh) return;
    const p = s.ssh.password;
    // enc:v1: 密文(脚本/备份直接 PUT 配置)必须按"沿用已存密码"处理, 否则会被二次加密导致密码失效。
    const alreadyEncrypted = (typeof p === 'string' && p.indexOf(PW_ENC_PREFIX) === 0);
    if (p === PW_MASK || p === '' || p === undefined || p === null || p === PW_CLEAR || alreadyEncrypted) {
      const old = oldList.find(function (x) { return x && x.id === s.id; });
      s.ssh.password = (p === PW_CLEAR) ? '' : ((old && old.ssh) ? decryptPassword(old.ssh.password) : '');
      if (p === PW_CLEAR) delete brokenCipher[s.id];
    } else {
      delete brokenCipher[s.id]; // 用户输入了新密码, 不再保留无法解密的旧密文
    }
  });
}
// 目录占用(字节)与可用空间; 失败返回 null, 不影响主流程。
function diskInfo(dir) {
  const out = { bytes: 0, files: 0, free: null, total: null };
  try {
    (function walk(d) {
      fs.readdirSync(d).forEach(function (n) {
        const f = path.join(d, n);
        const s = fs.statSync(f);
        if (s.isDirectory()) walk(f); else { out.bytes += s.size; out.files += 1; }
      });
    })(dir);
  } catch (e) {}
  try {
    const st = fs.statfsSync ? fs.statfsSync(dir) : null;
    if (st) { out.free = st.bavail * st.bsize; out.total = st.blocks * st.bsize; }
  } catch (e) {}
  // 兜底: 老 Node 没有 statfsSync(或个别内核不支持)时, 用 df -P -k 再算一次。
  // df 的 Available 单位是 1K 块, 乘 1024 还原成字节; 失败保持 null, 页面继续显示 "-"。
  if (out.free == null && process.platform !== 'win32') {
    try {
      const dfOut = execFileSync('df', ['-P', '-k', dir], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      const cols = String(dfOut).trim().split('\n').slice(-1)[0].trim().split(/\s+/);
      if (cols.length >= 5) { out.total = parseInt(cols[1], 10) * 1024; out.free = parseInt(cols[3], 10) * 1024; }
    } catch (e) {}
  }
  return out;
}

// 告警默认阈值(实时看板)。定义在此处以便 DEFAULT_CONFIG 直接引用, 无 const 暂时性死区问题。
const DEFAULT_ALERTS = {
  enabled: true,
  cpu: { enabled: true, warning: 80, critical: 90 },
  mem: { enabled: true, warning: 85, critical: 95 },
  disk: {
    enabled: true, warning: 85, critical: 95,
    // df -P 不输出文件系统类型, 按「文件系统名」和「挂载点前缀」过滤虚拟挂载。
    // 命中的行不参与最大值告警, 但原始输出与归档留证完全不受影响。
    ignoreFs: ['tmpfs', 'devtmpfs', 'ramfs', 'rootfs', 'overlay', 'overlayfs'],
    ignoreMounts: ['/dev/shm', '/run', '/sys/fs/cgroup', '/proc', '/sys']
  }
};

// ---------- 默认配置 ----------
const DEFAULT_CONFIG = {
  listenPort: 8082,
  settings: {
    pollIntervalMs: 86400000, // 默认1天: 基本不做实时轮询, 留证由每天定时巡检负责; 0=彻底关闭实时轮询
    uiRefreshMs: 0, // 页面重绘间隔: 0=关闭自动刷新; 与后端采集轮询完全独立
    historyMaxPoints: 2000,
    historyMaxRuns: 2000, // 执行历史保留条数(每天定时1条约5年); 0 或非法值回退 2000
    requestTTY: true,
    retainDays: 0,
    evidenceImmutable: true, // Linux 下对每次巡检的 .ansi/.txt/.png 执行 chattr +i, 防止误删
    shotEnabled: true,
    shotFontPath: 'auto',
    shotCjkFontPath: 'auto',
    shotFontSize: 14,
    shotTheme: 'dark',
    terminalCols: 132,
    terminalLines: 80,
    remoteCols: 300,
    remoteLines: 60,
    sqliteIndex: true,
    pythonExe: ''
  },
  alerts: JSON.parse(JSON.stringify(DEFAULT_ALERTS)),
  schedule: {
    enabled: true,
    mode: 'daily',
    time: '02:00',
    intervalMinutes: 60,
    runOnStart: false
  },
  servers: [
    { id: 'demo', name: '演示节点(模拟器)', host: 'demo', group: '演示', enabled: true, timeoutMs: 30000,
      commandIds: ['cpu_avg', 'mem', 'disk', 'sysinfo', 'hostname'],
      ssh: { mode: 'demo', auth: 'key', user: 'root', port: 22, keyFile: '', password: '' } }
  ],
  commands: [
    { id: 'hostname', name: '主机与时间', command: 'hostname; date \'+%F %T %Z\'', timeoutMs: 10000, enabled: true },
    { id: 'uptime', name: '运行时长与负载', command: 'uptime', timeoutMs: 10000, enabled: true },
    { id: 'cpu_avg', name: 'CPU平均时间', command: 'mpstat -P ALL 1 1', timeoutMs: 15000, enabled: true },
    { id: 'mem', name: '内存使用情况', command: 'free -b', timeoutMs: 10000, enabled: true },
    { id: 'disk', name: '磁盘空间使用情况', command: 'df -P -B1', timeoutMs: 10000, enabled: true },
    { id: 'sysinfo', name: '系统版本信息', command: 'cat /etc/os-release; uname -a', timeoutMs: 10000, enabled: true },
    { id: 'listening_ports', name: '监听端口', command: 'ss -lntup', timeoutMs: 10000, enabled: true }
  ]
};

let config = null;
const state = new Map(); // serverId -> { server, results: Map(commandId -> entry) }
let sched = { nextRun: 0, lastRun: 0, lastResult: null, running: false, history: [] };

// ---------- 配置读写 ----------
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
      console.log('[config] 已生成默认配置: ' + CONFIG_PATH);
    }
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // 老配置文件没有 alerts 字段: 内存补默认结构(下次保存会落盘), 保证界面可配置。
    config.alerts = normalizeAlerts(config.alerts);
    // 兼容旧版明文密码: 内存解密使用, 磁盘立即改写为密文(密钥可用时)。
    const hasPlain = (config.servers || []).some(function (s) {
      const p = s && s.ssh && s.ssh.password;
      return typeof p === 'string' && p !== '' && p.indexOf(PW_ENC_PREFIX) !== 0;
    });
    decryptConfigPasswords(config);
    if (hasPlain && getSecret()) {
      try {
        const stored = JSON.parse(JSON.stringify(config));
        encryptConfigPasswords(stored);
        atomicWrite(CONFIG_PATH, JSON.stringify(stored, null, 2));
        console.log('[config] 已将明文密码加密写回 ' + CONFIG_PATH + '（旧 config.json.bak 若含明文请手动删除）');
      } catch (e) { console.warn('[config] 明文密码自动加密失败: ' + e.message); }
    }
  } catch (e) {
    console.error('[config] 读取失败, 使用内置默认: ' + e.message);
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}
// 应用前端的条目级数组差异: 只改动的字段覆盖、新增、按 id 删除。
function applyArrayOps(oldArr, ops) {
  let arr = (oldArr || []).map(function (x) { return JSON.parse(JSON.stringify(x)); });
  const o = ops || {};
  (o.del || []).forEach(function (id) { arr = arr.filter(function (x) { return x.id !== id; }); });
  Object.keys(o.patch || {}).forEach(function (id) {
    const it = arr.find(function (x) { return x && x.id === id; });
    if (!it) return;
    Object.keys(o.patch[id] || {}).forEach(function (k) { it[k] = o.patch[id][k]; });
  });
  (o.add || []).forEach(function (item) {
    if (!arr.some(function (x) { return x.id === item.id; })) arr.push(JSON.parse(JSON.stringify(item)));
  });
  return arr;
}
function saveConfig(obj) {
  const t0 = Date.now();
  const src = obj || {};
  // 差异提交: 前端只上传变化的顶层字段(改轮询间隔时只有 settings), 避免把整套
  // shell 命令原文与服务器/SSH 清单反复放到网络上被内容检测设备盯上。
  // 兼容判据: 带 __patch 标记, 或压根没带 servers/commands, 都按补丁合并处理;
  // 旧版前端的完整提交(两者齐全)走原逻辑, 行为不变。
  const patch = !!src.__patch || !Array.isArray(src.servers) || !Array.isArray(src.commands);
  let incoming;
  if (patch) {
    incoming = JSON.parse(JSON.stringify(config)); // 以内存中的现行配置为底
    // 内存 config 里的密码是明文; 未变更的 servers 先换成占位符, 让 mergeSavedPasswords
    // 走"沿用已存密码"分支, 而不是被当成用户新填的密码反复加密/误清 brokenCipher。
    (incoming.servers || []).forEach(function (s) {
      if (s && s.ssh && s.ssh.password) s.ssh.password = PW_MASK;
    });
    const oldServers = incoming.servers || [], oldCommands = incoming.commands || [];
    Object.keys(src).forEach(function (k) {
      if (k === '__patch' || k === 'servers' || k === 'commands') return;
      incoming[k] = JSON.parse(JSON.stringify(src[k]));
    });
    // 数组走条目级差异({__ops:{patch,add,del}}), 也兼容直接给完整数组。
    if (src.servers && src.servers.__ops) incoming.servers = applyArrayOps(oldServers, src.servers.__ops);
    else if (Array.isArray(src.servers)) incoming.servers = JSON.parse(JSON.stringify(src.servers));
    if (src.commands && src.commands.__ops) incoming.commands = applyArrayOps(oldCommands, src.commands.__ops);
    else if (Array.isArray(src.commands)) incoming.commands = JSON.parse(JSON.stringify(src.commands));
  } else {
    incoming = JSON.parse(JSON.stringify(src));
  }
  incoming.alerts = normalizeAlerts(incoming.alerts); // 阈值与磁盘忽略项统一归一化后再落盘
  mergeSavedPasswords(incoming, config); // 占位符还原为已存密码, 避免前端拿到明文
  const stored = JSON.parse(JSON.stringify(incoming));
  encryptConfigPasswords(stored);        // 落盘的一律是密文
  // 密钥丢失且用户没重填的密码: 原样保留旧密文, 避免保存别的设置时把它清掉。
  Object.keys(brokenCipher).forEach(function (sid) {
    const s = (stored.servers || []).find(function (x) { return x && x.id === sid; });
    const mem = (incoming.servers || []).find(function (x) { return x && x.id === sid; });
    if (s && s.ssh && mem && !mem.ssh.password) s.ssh.password = brokenCipher[sid];
  });
  const bak = CONFIG_PATH + '.bak';
  try { if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, bak); } catch (e) {}
  atomicWrite(CONFIG_PATH, JSON.stringify(stored, null, 2));
  config = incoming; // 内存保留明文, 供 SSH 调用使用
  // 保存时只按新配置同步内存状态, 保留已有历史; 不再同步重读 data/*.json。
  // restoreLocal() 全量读盘只在服务启动时做一次, 否则历史点越多保存越慢。
  rebuildState(true);
  reparseCachedResults(); // 忽略项变化后立即重算已缓存 df 卡片的数值, 不等下轮采集
  sched.nextRun = computeNextRun();
  console.log('[config] 配置已保存并应用' + (patch ? '（差异提交）' : '（完整提交）') +
    ', 耗时 ' + (Date.now() - t0) + 'ms, 下次巡检: ' +
    (sched.nextRun ? fmtTs(sched.nextRun) : '未启用'));
  logDuplicateWarnings();
}
function enabledServers() { return (config.servers || []).filter(function (s) { return def(s.enabled, true); }); }
function enabledCommands() { return (config.commands || []).filter(function (c) { return def(c.enabled, true); }); }
function commandsForServer(server) {
  const ids = server.commandIds;
  if (!Array.isArray(ids) || ids.length === 0) return enabledCommands();
  const set = {}; ids.forEach(function (id) { set[id] = true; });
  return enabledCommands().filter(function (c) { return set[c.id]; });
}
function findCommand(id) { return (config.commands || []).find(function (c) { return c.id === id; }); }
// 重复主机提示: 两台配置指向同一 host(忽略大小写)会放大 SSH 并发, 且留证时容易混淆。
// 不阻止运行(可能故意用不同账号), 但在健康面板与启动日志里明确提示。
function duplicateHosts(list) {
  const seen = {}, out = [];
  (list || enabledServers()).forEach(function (s) {
    const h = String(s.host || '').trim().toLowerCase();
    if (!h || h === 'localhost' || h === '127.0.0.1' || (s.ssh && s.ssh.mode === 'demo')) return;
    if (!seen[h]) seen[h] = [];
    seen[h].push(s.name || s.id || h);
  });
  Object.keys(seen).forEach(function (h) {
    const names = seen[h];
    if (names.length > 1) {
      out.push({ host: h, servers: names,
        message: '检测到 ' + names.length + ' 条配置指向同一主机 ' + h + '（' + names.join(' / ') + '）：会加倍 SSH 连接数，建议合并成一条并分配全部命令。' });
    }
  });
  return out;
}
function logDuplicateWarnings() {
  duplicateHosts().forEach(function (w) { console.warn('[config] ' + w.message); });
}

// ---------- 状态初始化 / 本地历史 ----------
// preserve=true: 保存配置时只同步服务器列表, 保留已在内存里的历史结果, 不重读磁盘。
// preserve=false: 服务启动时全新初始化, 随后由 restoreLocal() 读回历史。
function rebuildState(preserve) {
  const keep = Object.create(null);
  (config.servers || []).forEach(function (s) {
    keep[s.id] = true;
    const prev = preserve ? state.get(s.id) : null;
    state.set(s.id, { server: s, results: prev ? prev.results : new Map() });
  });
  Array.from(state.keys()).forEach(function (id) { if (!keep[id]) state.delete(id); });
}
function persistLocal(sid, cid, entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = { latest: entry.latest, series: entry.series, lastFlush: entry.lastFlush || 0 };
    fs.writeFileSync(path.join(DATA_DIR, sid + '__' + cid + '.json'), JSON.stringify(payload));
  } catch (e) { console.error('[persist] ' + e.message); }
}
function restoreLocal() {
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    fs.readdirSync(DATA_DIR).filter(function (f) { return f.endsWith('.json') && f.indexOf('__') > 0; }).forEach(function (f) {
      const base = f.replace(/\.json$/, '');
      const idx = base.indexOf('__');
      const sid = base.slice(0, idx), cid = base.slice(idx + 2);
      const st = state.get(sid);
      if (!st) return;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        const e = st.results.get(cid) || { latest: null, series: [], error: null, lastFlush: 0, lastRun: 0 };
        e.latest = d.latest; e.series = d.series || []; e.lastFlush = d.lastFlush || 0;
        e.online = e.latest ? true : null;
        st.results.set(cid, e);
      } catch (e2) {}
    });
  } catch (e) {}
}
// 关闭实时轮询(pollIntervalMs=0)时, 看板只能依赖巡检采集。服务重启后若 data/*.json
// 只留有部分命令的残留, 看板会出现"部分机器有数据/部分等待首次采集"。这里从最近
// 归档的 manifest.csv 回填缺失(或更旧)的命令结果 —— 纯本地读文件, 不发任何网络连接。
function restoreFromEvidence() {
  try {
    if (!fs.existsSync(EVIDENCE_DIR)) return 0;
    const days = fs.readdirSync(EVIDENCE_DIR)
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort().reverse();
    if (!days.length) return 0;
    const byName = {}, folderToSid = {}, folders = folderNameMap();
    enabledServers().forEach(function (s) { byName[s.name] = s.id; });
    Object.keys(folders).forEach(function (sid) { folderToSid[folders[sid]] = sid; });
    const rootAbs = path.resolve(EVIDENCE_DIR);
    let filled = 0;
    for (let di = 0; di < days.length && di < 7; di++) {
      const dayDir = path.join(EVIDENCE_DIR, days[di]);
      const mf = path.join(dayDir, 'manifest.csv');
      if (!fs.existsSync(mf)) continue;
      const lines = fs.readFileSync(mf, 'utf8').replace(/^\ufeff/, '').split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        const c = parseManifestLine(line);
        if (c.length < 13 || c[8] !== 'ok' || !c[12]) continue;
        const folder = c[12].split('/')[0];
        const sid = byName[c[2]] || folderToSid[folder];
        const st = sid ? state.get(sid) : null;
        if (!st) continue;
        const chk = findCommand(c[4]);
        if (!chk) continue;
        const full = path.resolve(path.join(dayDir, c[12].replace(/\//g, path.sep)));
        if (full.indexOf(rootAbs) !== 0 || !fs.existsSync(full)) continue;
        const ts = fs.statSync(full).mtimeMs;
        const e = st.results.get(chk.id);
        if (e && e.latest && e.latest.ts >= ts) continue; // 已有更新数据(实时采集或更近批次)
        const ansi = fs.readFileSync(full, 'utf8');
        const parsed = parseResult(chk, ansi);
        const ne = e || { latest: null, series: [], error: null, lastFlush: 0, lastRun: 0 };
        ne.latest = { ts: ts, raw: ansi, command: chk.command, name: chk.name, durationMs: 0, parsed: parsed };
        ne.online = true; ne.error = null;
        st.results.set(chk.id, ne);
        filled++;
      }
    }
    if (filled) console.log('[restore] 已从最近归档回填看板 ' + filled + ' 条命令结果(无网络连接)');
    return filled;
  } catch (err) { console.error('[restore] 归档回填失败: ' + err.message); return 0; }
}
function loadScheduleState() {
  try {
    if (fs.existsSync(SCHED_STATE_PATH)) {
      const d = JSON.parse(fs.readFileSync(SCHED_STATE_PATH, 'utf8'));
      sched.lastRun = d.lastRun || 0;
      sched.lastResult = d.lastResult || null;
      sched.history = Array.isArray(d.history) ? d.history : [];
    }
  } catch (e) {}
  sched.nextRun = computeNextRun();
}
// 执行历史保留条数: 默认 2000(约 5 年, 每天定时 1 次), 可通过全局设置 historyMaxRuns 调整。
function schedHistoryMax() {
  const v = parseInt(config && config.settings && config.settings.historyMaxRuns, 10);
  return (isFinite(v) && v > 0) ? v : 2000;
}
function persistScheduleState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SCHED_STATE_PATH, JSON.stringify({ lastRun: sched.lastRun, lastResult: sched.lastResult, history: sched.history.slice(0, schedHistoryMax()) }));
  } catch (e) { console.error('[sched] ' + e.message); }
}

// ---------- 命令执行 ----------
function whichCmd(name) {
  try {
    const out = exec((process.platform === 'win32' ? 'where ' : 'command -v ') + name,
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, encoding: 'utf8' });
    return out && String(out).trim().length ? String(out).trim().split(/\r?\n/)[0] : null;
  } catch (e) { return null; }
}
// 工具解析: 先看系统 PATH；若本地存在 vendor/<平台>/bin/<name> 也兼容（老版本随包布局）。
// 开源版不携带这些二进制，密码登录请自行安装 sshpass / plink（见 README）。
function resolveToolPath(name) {
  const sub = process.platform === 'win32' ? 'win' : (process.platform === 'darwin' ? 'mac' : 'linux');
  const bundled = path.join(ROOT, 'vendor', sub, 'bin', name);
  if (fs.existsSync(bundled)) {
    if (process.platform !== 'win32') { try { fs.chmodSync(bundled, 0o755); } catch (e) {} }
    return bundled;
  }
  return whichCmd(name);
}
function passwordTool() {
  if (process.platform === 'win32') {
    const p = resolveToolPath('plink.exe');
    if (p) return { tool: 'plink', path: p, error: null };
    return { tool: null, path: null, error:
      '未检测到 plink.exe(PuTTY 命令行)。Windows 下密码登录依赖它。\n' +
      '请安装 PuTTY 并把 plink.exe 加入 PATH，或从 https://the.earth.li/~sgtatham/putty/latest/w32/plink.exe 下载。\n' +
      '首次连接新主机若报主机密钥未缓存，先手工跑一次 plink -pw 密码 用户@IP exit。\n' +
      '(若只想用密钥登录, 把该服务器认证方式改为 密钥(免密) 即可。)' };
  }
  const p = resolveToolPath('sshpass');
  if (p) return { tool: 'sshpass', path: p, error: null };
  return { tool: null, path: null, error:
    '未检测到 sshpass。请自行安装: apt-get install -y sshpass 或 yum install -y sshpass。\n(或改用密钥(免密)登录。)' };
}
function resolveKeyPath(key) {
  if (!key) return key;
  let k = String(key).trim().replace(/^"(.*)"$/, '$1');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  // 展开三种写法: ~  /  ~/  ~\
  if (k === '~') k = home;
  else if (k.indexOf('~/') === 0 || k.indexOf('~\\') === 0) k = home + k.slice(1);
  k = k.replace(/%USERPROFILE%/gi, home);
  if (process.platform === 'win32') k = k.replace(/\//g, '\\');
  return k;
}
// 构造 SSH 调用: 返回 {file, args} 直接用 execFile 执行(参数数组, 不经 shell),
// 彻底规避 Windows cmd.exe 不认单引号导致 -i 'C:\...\id_rsa' 找文件失败的问题。
// 密钥登录走 ssh(或 plink 密码), 密码登录 Windows 走 plink / Linux 走 sshpass。
function buildSshInvocation(server, command) {
  const ssh = server.ssh || {};
  const host = server.host;
  const port = def(ssh.port, 22);
  const user = def(ssh.user, 'root');
  const auth = def(ssh.auth, 'key');
  const tty = def(config.settings && config.settings.requestTTY, true);
  const isWin = process.platform === 'win32';
  const nullDev = isWin ? 'NUL' : '/dev/null';
  const cols = def(config.settings && config.settings.remoteCols, 300);
  const rows = def(config.settings && config.settings.remoteLines, 60);
  // 远端 pty 宽度设大, 避免 free/df/ss/mpstat 在 80 列处硬折行; 渲染器再按内容自适应。
  const remote = tty
    ? ('stty cols ' + cols + ' rows ' + rows + ' 2>/dev/null; ' + command)
    : command;

  if (auth === 'password') {
    const pw = def(ssh.password, '');
    if (isWin) {
      const a = ['-batch'];
      if (tty) a.push('-t');
      a.push('-pw', pw);
      if (port) a.push('-P', String(port));
      a.push(user + '@' + host, remote);
      return { file: (resolveToolPath('plink.exe') || 'plink'), args: a };
    }
    const a = ['-p', pw, 'ssh'];
    if (tty) a.push('-tt');
    a.push('-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no',
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + nullDev,
      '-o', 'RequestTTY=' + (tty ? 'force' : 'no'),
      '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=15');
    if (port) a.push('-p', String(port));
    a.push(user + '@' + host, remote);
    return { file: (resolveToolPath('sshpass') || 'sshpass'), args: a };
  }

  const key = resolveKeyPath(def(ssh.keyFile, ssh.key));
  const a = [];
  if (tty) a.push('-tt');
  a.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=' + nullDev,
    '-o', 'ConnectTimeout=10', '-o', 'RequestTTY=' + (tty ? 'force' : 'no'),
    '-o', 'LogLevel=ERROR', '-o', 'ServerAliveInterval=15',
    '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey');
  if (port) a.push('-p', String(port));
  if (key) a.push('-i', key);
  a.push(user + '@' + host, remote);
  return { file: 'ssh', args: a };
}
function keyExists(key) {
  if (!key) return true;
  if (fs.existsSync(key)) return true;
  // 兼容 Windows 用户目录大小写/实际路径
  try {
    const dir = path.dirname(key);
    const base = path.basename(key).toLowerCase();
    if (fs.existsSync(dir)) {
      return fs.readdirSync(dir).some(function (f) { return f.toLowerCase() === base; });
    }
  } catch (e) {}
  return false;
}
// 错误信息脱敏: plink/sshpass 的密码在内存里是明文, 子进程执行失败时
// Node 会把完整 argv 拼进 err.message (形如 "Command failed: plink.exe -pw 明文 ...")。
// 这里在日志/前端回显之前统一替换为 ***, 避免把 SSH 密码漏到页面或日志文件。
function maskSshSecrets(text, ssh, auth) {
  let s = String(text == null ? '' : text);
  const secrets = [];
  const pw = (auth === 'password') ? def((ssh || {}).password, '') : '';
  if (pw) secrets.push(pw);
  const rawKey = def((ssh || {}).keyFile, (ssh || {}).key);
  // 历史配置有人把明文口令误填进 keyFile; 不像路径/密钥文件名的值也一并遮掉。
  if (rawKey && !/[\\/]/.test(rawKey) && !/\.(pem|ppk|key)$/i.test(rawKey)) secrets.push(rawKey);
  secrets.forEach(function (v) {
    if (!v) return;
    try { s = s.split(v).join('***'); } catch (e) {}
  });
  // 兜底: 即使没从配置拿到密码, 也遮掉命令行开关后面的参数。
  if (pw) {
    s = s.replace(/(-pw\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1***');
    s = s.replace(/(sshpass\s+-p\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1***');
  }
  return s;
}
function runCommand(server, chk) {
  return new Promise(function (resolve, reject) {
    const ssh = server.ssh || {};
    const mode = def(ssh.mode, (server.host === 'localhost' || !server.host) ? 'local' : 'ssh');
    const auth = def(ssh.auth, 'key');
    const command = chk.command;
    if (mode === 'demo') return resolve({ ts: Date.now(), raw: demoOutput(command), durationMs: 0 });
    if (mode === 'ssh' && auth === 'password') {
      const pt = passwordTool();
      if (!pt.tool) return reject(new Error(pt.error));
    }
    const rawKey = def(ssh.keyFile, ssh.key);
    const key = resolveKeyPath(rawKey);
    if (mode === 'ssh' && auth === 'key' && key && !keyExists(key)) {
      const home = process.env.USERPROFILE || process.env.HOME || 'C:/Users/<用户名>';
      return reject(new Error('SSH 私钥文件无法访问: ' + key + '\n'
        + '当前用户主目录: ' + home + '\n'
        + '可填绝对路径(如 C:\\Users\\你的用户名\\.ssh\\id_rsa), 或简写 ~/.ssh/id_rsa / ~\\.ssh\\id_rsa, 或改用 用户名密码 登录。'));
    }
    const timeout = def(chk.timeoutMs, def(server.timeoutMs, 30000));
    const optsBase = { maxBuffer: 12 * 1024 * 1024, timeout: timeout, encoding: 'buffer' };

    if (mode === 'local') {
      const t0 = Date.now();
      exec(command, optsBase, function (err, stdout, stderr) {
        if (err) return reject(new Error(decodeBuf(stderr).trim() || ('命令执行失败: ' + command)));
        resolve({ ts: t0, raw: cleanOutput(decodeBuf(stdout)), durationMs: Date.now() - t0 });
      });
      return;
    }

    // SSH: 先拿闸门再发连接。超时从真正连上开始算, 排队时间不计入命令超时。
    const slotKey = sshSlotKey(server);
    takeSshSlot(slotKey).then(function () { attempt(0); }, reject);

    function finish(err, val) {
      releaseSshSlot(slotKey);
      if (err) reject(err); else resolve(val);
    }
    function attempt(n) {
      let inv;
      try { inv = buildSshInvocation(server, command); }
      catch (e) { return finish(e); }
      const started = Date.now();
      const onDone = function (err, stdout, stderr) {
        const durationMs = Date.now() - started;
        if (err) {
          // 必须先脱敏再判断/打印/回传: err.message 里可能带 -pw 后的明文密码。
          let msg = maskSshSecrets(decodeBuf(stderr).trim() || err.message || ('命令执行失败: ' + command), ssh, auth);
          if (isTransientSshError(msg) && n < SSH_RETRY_MAX) {
            const wait = SSH_RETRY_BASE_MS * (n + 1) + Math.floor(Math.random() * 200);
            console.warn('[ssh] 连接瞬时失败, ' + wait + 'ms 后重试(' + (n + 1) + '/' + SSH_RETRY_MAX + '): '
              + (server.name || server.host || slotKey) + ' -> ' + String(msg).split('\n')[0]);
            setTimeout(function () { attempt(n + 1); }, wait);
            return;
          }
          if (process.platform === 'win32' && auth === 'password' && /host key|cache|not cached/i.test(msg)) {
            msg += '\n\n提示: plink 首次连接未知主机会被拒绝。请先命令行执行一次:\n  plink -pw 密码 ' + def(ssh.user, 'root') + '@' + server.host + ' exit';
          }
          msg += sshErrorHint(msg);
          return finish(new Error(maskSshSecrets(msg, ssh, auth)));
        }
        finish(null, { ts: started, raw: cleanOutput(decodeBuf(stdout)), durationMs: durationMs });
      };
      try { execFile(inv.file, inv.args, optsBase, onDone); }
      catch (e) { finish(e); }
    }
  });
}

// ---------- 模拟输出 (无 Linux 环境演示) ----------
function rnd(a, b) { return a + Math.random() * (b - a); }
function isBurst() { return (Math.floor(Date.now() / 15000) % 4) === 0; }
function demoOutput(command) {
  const burst = isBurst();
  if (command.indexOf('mpstat') >= 0) {
    const n = 8; let s = 'Linux 5.4.0 (demo) ' + fmtTs(Date.now()) + ' _x86_64_ (' + n + ' CPU)\n\n';
    s += '15:00:00     CPU    %usr   %nice    %sys %iowait    %irq   %soft  %steal  %guest  %gnice   %idle\n';
    const allUsr = burst ? rnd(70, 92) : rnd(8, 40), allSys = burst ? rnd(8, 20) : rnd(3, 15), allIo = rnd(0, 5);
    const allIdle = clamp(100 - allUsr - allSys - allIo, 1, 99);
    for (let i = 0; i < n; i++) {
      const u = burst ? rnd(60, 95) : rnd(5, 50), sy = burst ? rnd(5, 20) : rnd(2, 18), io = rnd(0, 8), id = clamp(100 - u - sy - io, 1, 99);
      s += '15:00:01      ' + i + '   ' + u.toFixed(2) + '    0.00   ' + sy.toFixed(2) + '   ' + io.toFixed(2) + '    0.00    0.00    0.00    0.00    0.00   ' + id.toFixed(2) + '\n';
    }
    s += 'Average:     all   ' + allUsr.toFixed(2) + '    0.00   ' + allSys.toFixed(2) + '   ' + allIo.toFixed(2) + '    0.00    0.00    0.00    0.00    0.00   ' + allIdle.toFixed(2) + '\n';
    return s;
  }
  if (command.indexOf('free') >= 0) {
    const total = 16708838400, avail = burst ? Math.round(rnd(3e8, 15e8)) : Math.round(rnd(4e9, 12e9)), used = total - avail - rnd(1e9, 3e9);
    return '              total        used        free      shared  buff/cache   available\n' +
      'Mem:      ' + total + '  ' + used + '   ' + (total - used - avail) + '   512000000   ' + avail + '   ' + avail + '\n' +
      'Swap:     4294967296           0  4294967296\n';
  }
  if (command.indexOf('df') >= 0) {
    const dataCap = burst ? Math.round(rnd(88, 98)) : Math.round(rnd(40, 75));
    return 'Filesystem         1-blocks        Used   Available Capacity Mounted on\n' +
      '/dev/sda1   214748364800 ' + Math.round(rnd(8e10, 16e10)) + '  85899345920       ' + Math.round(rnd(40, 70)) + '% /\n' +
      '/dev/sdb1   536870912000 ' + Math.round(rnd(3e11, 5e11)) + '  53687091200       ' + dataCap + '% /data\n';
  }
  if (command.indexOf('os-release') >= 0 || command.indexOf('uname') >= 0) {
    return 'PRETTY_NAME="CentOS Linux 7 (Core)"\nNAME="CentOS Linux"\nVERSION_ID="7"\nID="centos"\n' +
      'Linux demo 3.10.0-1160.el7.x86_64 #1 SMP Mon Oct 19 16:18:59 UTC 2020 x86_64 x86_64 x86_64 GNU/Linux\n';
  }
  if (command.indexOf('hostname') >= 0) return 'demo-host\n' + fmtTs(Date.now()) + ' CST\n';
  if (command.indexOf('uptime') >= 0) return ' ' + fmtTs(Date.now()) + ' up 128 days,  3:21,  2 users,  load average: ' + rnd(0.1, 1.5).toFixed(2) + ', ' + rnd(0.1, 1.5).toFixed(2) + ', ' + rnd(0.1, 1.5).toFixed(2) + '\n';
  if (command.indexOf('ss ') >= 0) return 'State   Recv-Q  Send-Q   Local Address:Port   Peer Address:Port\nLISTEN  0       128          0.0.0.0:22          0.0.0.0:*\nLISTEN  0       128          0.0.0.0:8080        0.0.0.0:*\n';
  return '$ ' + command + '\n(demo) 命令输出示例\n';
}

// ---------- 解析器 (仅用于实时看板的大数值/告警; 归档留证一律保存原始输出) ----------
// 早期版本要求用户为每条命令手选「解析方式」, 但:
//   1) 归档链路里解析结果(value/unit/kv/table)从未写入 manifest/索引/截图/汇总, 属于白算;
//   2) 用户新增命令时根本不知道该选哪个, 选错只会让实时卡片数值异常。
// 现在改为按命令内容自动识别, 不再作为配置项暴露; 留证永远是原始终端输出, 不受影响。
function inferParser(chk) {
  const id = String(chk.id || ''), cmd = String(chk.command || '');
  if (id === 'cpu_avg' || /\bmpstat\b/.test(cmd)) return 'mpstat';
  if (id === 'mem' || /\bfree\b/.test(cmd)) return 'free';
  if (id === 'disk' || /(^|[\s;|&])df\b/.test(cmd)) return 'df';
  if (id === 'sysinfo' || /os-release|uname/.test(cmd)) return 'sysinfo';
  return 'raw';
}
function parseResult(chk, raw) {
  const p = inferParser(chk);
  if (p === 'mpstat') return parseMpstat(raw);
  if (p === 'free') return parseFree(raw);
  if (p === 'df') return parseDf(raw);
  if (p === 'sysinfo') return parseSysinfo(raw);
  return { text: stripAnsi(raw), value: null, unit: '', kv: null, table: null, cores: null };
}
function parseMpstat(raw) {
  const lines = raw.split('\n'); let all = null; const coreMap = {};
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.indexOf('%usr') >= 0) continue;
    const isAvg = t.indexOf('Average:') === 0;
    const rest = isAvg ? t.slice('Average:'.length).trim() : t;
    const parts = rest.split(/\s+/);
    if (parts.length < 11) continue;
    const cpu = parts[0];
    if (cpu !== 'all' && !/^\d+$/.test(cpu)) continue;
    const nums = parts.slice(1).map(Number);
    if (nums.length < 10 || !isFinite(nums[9])) continue;
    const rec = { cpu: cpu, usr: nums[0], nice: nums[1], sys: nums[2], iowait: nums[3], irq: nums[4], soft: nums[5], steal: nums[6], guest: nums[7], gnice: nums[8], idle: nums[9] };
    if (cpu === 'all') { if (isAvg || !all) all = rec; } else { coreMap[cpu] = rec; }
  }
  let allRec = all; const coreKeys = Object.keys(coreMap);
  if (!allRec && coreKeys.length) {
    const sum = { usr: 0, nice: 0, sys: 0, iowait: 0, irq: 0, soft: 0, steal: 0, guest: 0, gnice: 0, idle: 0 };
    coreKeys.forEach(function (k) { Object.keys(sum).forEach(function (f) { sum[f] += coreMap[k][f]; }); });
    allRec = { cpu: 'all' }; Object.keys(sum).forEach(function (f) { allRec[f] = sum[f] / coreKeys.length; });
  }
  const cores = coreKeys.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); }).map(function (k) { return coreMap[k]; });
  const value = allRec ? clamp(100 - allRec.idle, 0, 100) : null;
  const kv = allRec ? { 'CPU总数': cores.length, '平均用户态%': Math.round(allRec.usr * 100) / 100, '平均系统态%': Math.round(allRec.sys * 100) / 100, '平均空闲%': Math.round(allRec.idle * 100) / 100 } : null;
  return { value: value, unit: '%', cores: cores, kv: kv, table: null, text: '' };
}
function parseFree(raw) {
  const lines = raw.trim().split('\n'); let mem = null, swap = null;
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].split(/\s+/);
    if (lines[i].indexOf('Mem:') === 0) mem = { total: +p[1], used: +p[2], free: +p[3], shared: +p[4], buffcache: +p[5], available: +p[6] };
    else if (lines[i].indexOf('Swap:') === 0) swap = { total: +p[1], used: +p[2], free: +p[3] };
  }
  const usedPct = mem && mem.total ? (100 * (mem.total - mem.available) / mem.total) : null;
  return { value: usedPct, unit: '%', kv: { '内存总量': fmtBytes(mem && mem.total), '已用': fmtBytes(mem && mem.used), '可用': fmtBytes(mem && mem.available), 'Swap总量': fmtBytes(swap && swap.total) }, table: null, text: '' };
}
function parseDf(raw, ignoreCfg) {
  const lines = stripAnsi(raw).trim().split('\n'); const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(/\s+/);
    if (p.length >= 6) rows.push({ fs: p[0], size: +p[1], used: +p[2], avail: +p[3], use: parseInt(p[4], 10), mount: p.slice(5).join(' ') });
  }
  // 旧调用不传 ignoreCfg: 用当前配置; 离线自检可显式传一份, 不依赖全局 config。
  const ig = ignoreCfg || normalizeAlerts(config && config.alerts).disk;
  const activeRows = [];
  const table = rows.map(function (r) {
    const ignored = dfRowIgnored(r, ig);
    if (!ignored) activeRows.push(r);
    return { '文件系统': r.fs, '总量': fmtBytes(r.size), '已用': fmtBytes(r.used), '可用': fmtBytes(r.avail),
      '使用率': r.use + '%', '挂载点': r.mount, '告警过滤': ignored ? '已忽略' : '' };
  });
  const maxUse = activeRows.length ? Math.max.apply(null, activeRows.map(function (r) { return r.use; })) : null;
  return { value: maxUse, unit: '%', table: table, kv: null, text: '' };
}
function parseSysinfo(raw) {
  const kv = {}; const lines = stripAnsi(raw).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*)=["']?([^"'\n]*)/);
    if (m) kv[m[1]] = m[2];
    else if (/^Linux \S+ \S+/.test(lines[i])) kv['KERNEL'] = lines[i].trim();
  }
  return { value: null, unit: '', kv: kv, table: null, text: '' };
}
function fmtBytes(b) {
  if (b == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0, x = b;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (Math.round(x * 10) / 10) + ' ' + u[i];
}
// ---------- 告警配置 (实时看板) ----------
// 原实现阈值是硬编码常量, 界面无配置项(死引用), 用户无法启停/调整。
// 现在统一走 config.alerts: 总开关 + CPU/内存/磁盘各自开关与两级阈值, 由配置管理界面配置。
// 告警只影响看板颜色/告警条, 归档留证(原始输出)不受任何影响。
function clampPct(v, fallback) {
  const n = Number(v);
  return (isFinite(n) && n >= 0 && n <= 100) ? n : fallback;
}
// 配置里的忽略项允许数组或逗号分隔字符串(便于脚本直接 PUT JSON); 去重、去空、保留原大小写。
function normalizeAlertList(v, fallback) {
  let arr = v;
  if (typeof arr === 'string') arr = arr.split(/[,，\n]+/);
  if (!Array.isArray(arr)) return (fallback || []).slice();
  const seen = Object.create(null), out = [];
  arr.forEach(function (x) {
    const s = String(x == null ? '' : x).trim();
    const key = s.toLowerCase();
    if (!s || seen[key]) return;
    seen[key] = true; out.push(s);
  });
  return out;
}
// df -P 输出没有文件系统类型列, 因此同时按 fs 名称与挂载点前缀匹配。
// 挂载点按路径边界匹配: /run 命中 /run/user/0, 但不会误伤 /runtime。
function dfRowIgnored(row, cfg) {
  const fsList = normalizeAlertList(cfg && cfg.ignoreFs, DEFAULT_ALERTS.disk.ignoreFs);
  const mountList = normalizeAlertList(cfg && cfg.ignoreMounts, DEFAULT_ALERTS.disk.ignoreMounts);
  const fs = String(row.fs || '').toLowerCase();
  const fsBase = fs.split('/').pop();
  if (fsList.some(function (x) { const t = String(x).toLowerCase(); return fs === t || fsBase === t; })) return true;
  const mount = String(row.mount || '');
  return mountList.some(function (x) {
    const raw = String(x || '').trim();
    if (!raw) return false;
    if (raw === '/') return true; // 显式填 / 表示忽略全部挂载点
    const t = raw.replace(/\/+$/, '');
    if (!t) return false;
    return mount === t || mount.indexOf(t + '/') === 0;
  });
}
// 容错归一化: 老配置无 alerts / 字段缺失 / 阈值非法 / critical<=warning 都能兜住。
function normalizeAlerts(a) {
  const src = (a && typeof a === 'object') ? a : {};
  const out = { enabled: src.enabled !== false, cpu: {}, mem: {}, disk: {} };
  ['cpu', 'mem', 'disk'].forEach(function (k) {
    const d = DEFAULT_ALERTS[k];
    const s = (src[k] && typeof src[k] === 'object') ? src[k] : {};
    const w = clampPct(s.warning, d.warning);
    const c = clampPct(s.critical, d.critical);
    out[k].enabled = s.enabled !== false;
    out[k].warning = w;
    out[k].critical = (c > w) ? c : Math.min(100, w + 1); // critical 必须严格大于 warning
    if (k === 'disk') {
      out.disk.ignoreFs = normalizeAlertList(s.ignoreFs, d.ignoreFs);
      out.disk.ignoreMounts = normalizeAlertList(s.ignoreMounts, d.ignoreMounts);
    }
  });
  return out;
}
function severityOf(chk, value) {
  if (value == null) return 'ok';
  const ac = normalizeAlerts(config.alerts);
  if (!ac.enabled) return 'ok'; // 总开关关闭: 全部不告警
  const p = inferParser(chk);
  let key = null;
  if (p === 'mpstat') key = 'cpu';
  else if (p === 'free') key = 'mem';
  else if (p === 'df') key = 'disk';
  else return 'ok';
  const item = ac[key];
  if (!item.enabled) return 'ok'; // 该指标告警关闭
  if (value >= item.critical) return 'critical';
  if (value >= item.warning) return 'warning';
  return 'ok';
}
// 告警配置变化后重算已缓存 df 结果: 避免"保存了忽略项但卡片还显示旧告警"要等下一轮采集。
// 只改内存中的 parsed.value 与最后一个历史点, 不重新连接目标机、不写盘、不影响归档原文。
function reparseCachedResults() {
  state.forEach(function (st) {
    (st.results || new Map()).forEach(function (e, id) {
      if (!e || !e.latest || !e.latest.raw) return;
      const chk = findCommand(id);
      if (!chk || inferParser(chk) !== 'df') return;
      let parsed;
      try { parsed = parseResult(chk, e.latest.raw); } catch (ignored) { return; }
      e.latest.parsed = parsed;
      if (parsed.value != null && e.series && e.series.length) {
        const last = e.series[e.series.length - 1];
        if (last && last.ts === e.latest.ts) last.value = parsed.value;
      }
    });
  });
}

// ---------- 实时采集调度 ----------
function tick() {
  const now = Date.now();
  const poll = def(config.settings && config.settings.pollIntervalMs, 86400000);
  if (poll <= 0) return; // 0 = 关闭实时轮询, 只保留定时巡检归档, 完全不对目标机发起连接
  const jobs = [];
  enabledServers().forEach(function (server) {
    const st = state.get(server.id);
    if (!st) return;
    commandsForServer(server).forEach(function (chk) {
      const e = st.results.get(chk.id) || { latest: null, series: [], error: null, lastFlush: 0, lastRun: 0 };
      if (now - e.lastRun >= poll) {
        e.lastRun = now; st.results.set(chk.id, e);
        jobs.push(collectOne(st, chk));
      }
    });
  });
  allSettled(jobs).catch(function () {});
}
function collectOne(st, chk) {
  return runCommand(st.server, chk).then(function (out) {
    const parsed = parseResult(chk, out.raw);
    const e = st.results.get(chk.id) || { latest: null, series: [], error: null, lastFlush: 0, lastRun: Date.now() };
    e.latest = { ts: out.ts, raw: out.raw, command: chk.command, name: chk.name, durationMs: out.durationMs, parsed: parsed };
    e.online = true; e.error = null;
    if (parsed.value != null) {
      e.series.push({ ts: out.ts, value: parsed.value });
      const max = def(config.settings && config.settings.historyMaxPoints, 2000);
      if (e.series.length > max) e.series = e.series.slice(e.series.length - max);
    }
    st.results.set(chk.id, e);
    persistLocal(st.server.id, chk.id, e);
  }).catch(function (err) {
    const e = st.results.get(chk.id) || { latest: null, series: [], error: null, lastFlush: 0, lastRun: Date.now() };
    const cat = classifyFailure(err);
    e.online = false; e.error = err.message; e.errorCategory = cat; e.errorAt = Date.now();
    st.results.set(chk.id, e);
    logCollectFailure('poll', st.server, chk, cat, err.message);
  });
}

// ---------- 定时任务调度 ----------
function computeNextRun() {
  const s = config.schedule || {};
  if (!def(s.enabled, true)) return 0;
  const now = new Date();
  if (def(s.mode, 'daily') === 'interval') {
    const mins = def(s.intervalMinutes, 60);
    return Date.now() + mins * 60000;
  }
  const parts = String(def(s.time, '02:00')).split(':');
  const hh = parseInt(parts[0], 10) || 0, mm = parseInt(parts[1], 10) || 0;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function scheduleTick() {
  const s = config.schedule || {};
  if (!def(s.enabled, true) || sched.running) return;
  if (!sched.nextRun || Date.now() >= sched.nextRun) {
    sched.nextRun = computeNextRun();
    if (sched.nextRun && Date.now() >= sched.nextRun - 1000) return; // 防御性: 时间已过去则等下次
    runInspection('scheduled');
  }
}
// ---------- 巡检产物不可变保护 (Linux chattr +i) ----------
// 只锁每次巡检生成的 .ansi/.txt/.png; manifest.csv / 00_summary.json / SHA256SUMS
// 会因同一天多批次追加而被重写, 不能锁。Windows 或无 CAP_LINUX_IMMUTABLE / 不支持的
// 文件系统(overlay/tmpfs/NFS 等)自动跳过, 不影响采集与归档。
let chattrUnavailable = null, chattrWarnOnce = false;
function chattrBatch(files, add, opts) {
  const list = (files || []).filter(function (f) { return typeof f === 'string' && f && fs.existsSync(f); });
  if (!list.length) return 0;
  // force 仅用于「解除历史锁」(清理超期归档、重渲染前临时解锁): 即使当前配置关闭也要能解开旧标记。
  // 它不能反过来绕过关闭开关去新增不可变标记。
  const forceUnlock = !!(opts && opts.force) && !add;
  // manual: 用户在页面上显式点「上锁」时, 即使全局防删除开关关闭也必须生效。
  const manualLock = !!(opts && opts.manual) && add;
  if (!forceUnlock && !manualLock && def(config.settings && config.settings.evidenceImmutable, true) === false) return 0;
  if (process.platform === 'win32') {
    if (!chattrUnavailable) chattrUnavailable = 'Windows 无 chattr';
    if (!forceUnlock && !chattrWarnOnce) { chattrWarnOnce = true; console.log('[immutable] Windows 平台不支持 chattr +i，跳过防删除保护'); }
    return 0;
  }
  if (chattrUnavailable) return 0;
  const flag = add ? '+i' : '-i';
  let done = 0;
  // 分批避免 argv 过长; 单批 200 个路径对几百张截图足够。
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    try {
      execFileSync('chattr', [flag].concat(batch), { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 20000 });
      done += batch.length;
    } catch (e) {
      const text = String((e && e.stderr) || (e && e.message) || '');
      const fatal = (e && (e.code === 'ENOENT' || e.code === 'EPERM' || e.code === 'EACCES'))
        || /Operation not supported|not supported|inappropriate ioctl|权限/i.test(text);
      if (fatal) {
        chattrUnavailable = text.slice(0, 160) || String((e && e.code) || 'unknown');
        console.warn('[immutable] chattr 不可用（' + chattrUnavailable + '），后续自动跳过；可在全局设置关闭 evidenceImmutable');
        return done;
      }
      if (!chattrWarnOnce) { chattrWarnOnce = true; console.warn('[immutable] 部分文件 chattr ' + flag + ' 失败: ' + text.slice(0, 160)); }
    }
  }
  return done;
}
function evidenceArtifactFiles(dir) {
  const out = [];
  try {
    walkFiles(dir).forEach(function (rel) {
      if (/\.(ansi|txt|png)$/i.test(rel)) out.push(path.join(dir, rel));
    });
  } catch (e) {}
  return out;
}

// ---------- 历史归档上锁: 给旧截图/.ansi/.txt 补 chattr +i, 内容一律不动 ----------
// 与"重出截图"共用一把按天互斥锁: 重出要先解锁→渲染→锁回, 期间若另一个请求上锁,
// 渲染器会写不进 PNG。用内存 Set 占位, Node 单进程内即可, 无需文件锁。
const immutBusy = new Set();
function withImmutDay(dayKey, fn) {
  if (immutBusy.has(dayKey)) return Promise.resolve({ ok: false, error: '该日正在执行重出截图或上锁，请稍候再试' });
  immutBusy.add(dayKey);
  return Promise.resolve().then(fn).then(
    function (r) { immutBusy.delete(dayKey); return r; },
    function (e) { immutBusy.delete(dayKey); throw e; }
  );
}
// 检测文件是否已带不可变标记: 用 lsattr, 输出列里含字母 i 即已锁定。
// 返回 { supported, total, locked, unlocked }; 平台不支持时 supported=false。
function immutableStatus(files) {
  const list = (files || []).filter(function (f) { return typeof f === 'string' && f && fs.existsSync(f); });
  const total = list.length;
  if (!total) return { supported: process.platform !== 'win32' && !chattrUnavailable, total: 0, locked: 0, unlocked: 0 };
  if (process.platform === 'win32' || chattrUnavailable) return { supported: false, total: total, locked: 0, unlocked: total };
  let locked = 0;
  for (let i = 0; i < list.length; i += 200) {
    const batch = list.slice(i, i + 200);
    try {
      const out = execFileSync('lsattr', batch, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
      String(out).split(/\r?\n/).forEach(function (line) {
        const col = line.trim().split(/\s+/)[0] || '';
        if (col.indexOf('i') >= 0) locked++;
      });
    } catch (e) {
      const text = String((e && e.stderr) || (e && e.message) || '');
      if (e && (e.code === 'ENOENT' || /not supported|不支持|inappropriate ioctl/i.test(text))) {
        return { supported: false, total: total, locked: 0, unlocked: total };
      }
      // 个别文件失败按未锁处理, 不中断整批
    }
  }
  if (locked > total) locked = total;
  return { supported: true, total: total, locked: locked, unlocked: total - locked };
}
// 归档 key -> 磁盘目录。key 可能是 "2026-11-25" 或 "2026-11-25/<runId>", 必须严格防目录穿越。
function evidenceDirOfKey(key) {
  const k = String(key == null ? '' : key).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = k.split('/').filter(Boolean);
  // 显式拒绝任何 . / .. 段: 审计留证系统不接受被"清洗后放行"的穿越写法。
  if (parts.some(function (p) { return p === '..' || p === '.'; })) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0] || '') || parts.length > 2) return null;
  const dir = path.join.apply(path, [EVIDENCE_DIR].concat(parts));
  const abs = path.resolve(dir);
  if (abs.indexOf(path.resolve(EVIDENCE_DIR) + path.sep) !== 0) return null;
  return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : null;
}
// 给某天(或某批次)上锁。只加 chattr +i: 不改文件、清单、SHA256SUMS、zip 缓存。
function lockEvidenceDay(key) {
  const dir = evidenceDirOfKey(key);
  if (!dir) return Promise.reject(new Error('无效的归档日期: ' + String(key)));
  // 锁的粒度按"天": 同一天的不同批次也视为冲突, 避免与重出截图交错。
  const dayKey = String(key).split('/')[0];
  return withImmutDay(dayKey, function () {
    const files = evidenceArtifactFiles(dir);
    if (!files.length) return { ok: true, supported: true, total: 0, locked: 0, newly: 0, note: '该范围没有可加锁的产物' };
    const before = immutableStatus(files);
    if (!before.supported) return { ok: true, supported: false, total: before.total, locked: 0, newly: 0,
      note: process.platform === 'win32' ? 'Windows 不支持 chattr +i，已跳过' : 'chattr/lsattr 不可用，已跳过' };
    // 只给未锁的补加, 已锁的跳过; +i 本身幂等, 过滤只为统计准确。
    let newly = 0;
    for (let i = 0; i < files.length; i += 200) {
      const batch = files.slice(i, i + 200);
      try {
        const out = execFileSync('lsattr', batch, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
        const unlocked = [];
        String(out).split(/\r?\n/).forEach(function (line, idx) {
          const col = line.trim().split(/\s+/)[0] || '';
          if (col.indexOf('i') < 0 && batch[idx] && fs.existsSync(batch[idx])) unlocked.push(batch[idx]);
        });
        if (unlocked.length) newly += chattrBatch(unlocked, true, { manual: true });
      } catch (e) {
        // lsattr 失败时退化为整批 +i (幂等, 安全), 但 newly 统计按实际成功数计。
        newly += chattrBatch(batch, true, { manual: true });
      }
    }
    const after = immutableStatus(files);
    return { ok: true, supported: true, total: files.length,
      locked: after.locked, unlocked: after.unlocked, newly: newly,
      note: '仅加不可变标记，截图内容、manifest、SHA256SUMS 与压缩包均未改动' };
  });
}
// 给某天(或某批次)单独解锁。用于需要改写/删除留证, 或手动重出截图前。
// 与上锁/重出截图共用同一把按天互斥锁, 避免解锁与渲染写 PNG 交错。
function unlockEvidenceDay(key) {
  const dir = evidenceDirOfKey(key);
  if (!dir) return Promise.reject(new Error('无效的归档日期: ' + String(key)));
  const dayKey = String(key).split('/')[0];
  return withImmutDay(dayKey, function () {
    const files = evidenceArtifactFiles(dir);
    if (!files.length) return { ok: true, supported: true, total: 0, locked: 0, unlocked: 0, removed: 0, note: '该范围没有可解锁的产物' };
    if (process.platform === 'win32' || chattrUnavailable) {
      return { ok: true, supported: false, total: files.length, locked: 0, unlocked: files.length, removed: 0,
        note: process.platform === 'win32' ? 'Windows 无 chattr，无需解锁' : 'chattr 不可用，无需解锁' };
    }
    let removed = 0;
    for (let i = 0; i < files.length; i += 200) {
      const batch = files.slice(i, i + 200);
      try {
        const out = execFileSync('lsattr', batch, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
        const lockedFiles = [];
        String(out).split(/\r?\n/).forEach(function (line, idx) {
          const col = line.trim().split(/\s+/)[0] || '';
          if (col.indexOf('i') >= 0 && batch[idx] && fs.existsSync(batch[idx])) lockedFiles.push(batch[idx]);
        });
        // force 解锁: 即使全局防删除开关关闭, 历史标记也必须能解开。
        if (lockedFiles.length) removed += chattrBatch(lockedFiles, false, { force: true });
      } catch (e) {
        removed += chattrBatch(batch, false, { force: true });
      }
    }
    const after = immutableStatus(files);
    return { ok: true, supported: true, total: files.length,
      locked: after.locked, unlocked: after.unlocked, removed: removed,
      note: '仅解除不可变标记，文件内容未改动' };
  });
}
// 全量解锁: 逐天执行, 单天失败不影响其它天。
function unlockAllEvidence() {
  let days = [];
  try {
    days = fs.readdirSync(EVIDENCE_DIR).filter(function (n) {
      return /^\d{4}-\d{2}-\d{2}$/.test(n) && fs.statSync(path.join(EVIDENCE_DIR, n)).isDirectory();
    }).sort();
  } catch (e) {}
  return Promise.all(days.map(function (d) {
    return unlockEvidenceDay(d).then(function (r) { return { day: d, r: r }; },
      function (e) { return { day: d, r: { ok: false, error: e.message } }; });
  })).then(function (results) {
    let total = 0, unlocked = 0, removed = 0, failed = 0, skipped = 0;
    results.forEach(function (x) {
      if (!x.r.ok) { failed++; return; }
      if (x.r.supported === false) { skipped++; return; }
      total += def(x.r.total, 0); unlocked += def(x.r.unlocked, 0); removed += def(x.r.removed, 0);
    });
    return { ok: true, days: results.length, total: total, unlocked: unlocked, removed: removed,
      failed: failed, skipped: skipped, note: '仅解除不可变标记，文件内容未改动' };
  });
}
// 全量上锁: 逐天执行, 每天一把锁; 单天失败不影响其它天。
function lockAllEvidence() {
  let days = [];
  try {
    days = fs.readdirSync(EVIDENCE_DIR).filter(function (n) {
      return /^\d{4}-\d{2}-\d{2}$/.test(n) && fs.statSync(path.join(EVIDENCE_DIR, n)).isDirectory();
    }).sort();
  } catch (e) {}
  return Promise.all(days.map(function (d) {
    return lockEvidenceDay(d).then(function (r) { return { day: d, r: r }; },
      function (e) { return { day: d, r: { ok: false, error: e.message } }; });
  })).then(function (results) {
    let total = 0, locked = 0, newly = 0, failed = 0, skipped = 0;
    results.forEach(function (x) {
      if (!x.r.ok) { failed++; return; }
      if (x.r.supported === false) { skipped++; return; }
      total += def(x.r.total, 0); locked += def(x.r.locked, 0); newly += def(x.r.newly, 0);
    });
    return { ok: true, days: results.length, total: total, locked: locked, newly: newly, failed: failed, skipped: skipped,
      note: '仅加不可变标记，原始留证内容未改动' };
  });
}
// 全量状态: 归档列表一次拉取, 前端给每天显示"已保护 x/y"。
function allImmutableStatus() {
  let days = [];
  try {
    days = fs.readdirSync(EVIDENCE_DIR).filter(function (n) {
      return /^\d{4}-\d{2}-\d{2}$/.test(n) && fs.statSync(path.join(EVIDENCE_DIR, n)).isDirectory();
    }).sort();
  } catch (e) {}
  const out = {}, dayArr = [], unlockedDays = [];
  let supported = process.platform !== 'win32' && !chattrUnavailable;
  days.forEach(function (d) {
    const st = immutableStatus(evidenceArtifactFiles(path.join(EVIDENCE_DIR, d)));
    out[d] = st;
    dayArr.push({ day: d, total: st.total, locked: st.locked, unlocked: st.unlocked, supported: st.supported });
    if (st.supported && st.unlocked > 0) unlockedDays.push(d);
  });
  if (days.length && !supported) supported = false;
  return { ok: true, supported: supported, days: out, list: dayArr, unlockedDays: unlockedDays };
}
// 全量重算当天目录的校验清单。必须排除清单自身, 否则同一天第二次巡检
// 会把「旧清单的 hash」写进新清单导致校验失败; 重出截图后也要调用, 否则 PNG 换了但哈希还是旧的。
function writeSha256Sums(dir) {
  const sums = [];
  walkFiles(dir).forEach(function (rel) {
    if (rel.indexOf('.tmp') >= 0 || rel.indexOf('_index_spec') >= 0 || rel === 'SHA256SUMS') return;
    sums.push(sha256(fs.readFileSync(path.join(dir, rel))) + '  ' + rel.replace(/\\/g, '/'));
  });
  atomicWrite(path.join(dir, 'SHA256SUMS'), sums.sort().join('\n') + '\n');
}
function runInspection(trigger) {
  if (sched.running) return Promise.resolve({ ok: false, error: '上一次巡检尚未结束' });
  sched.running = true;
  const started = Date.now();
  const day = dateStr(started);
  const runId = day.replace(/-/g, '') + '_' + timeStr(started);
  // 每天一个目录: evidence/YYYY-MM-DD/<服务器名称>/<文件>, 路径最浅、可读性最好。
  const runDir = path.join(EVIDENCE_DIR, day);
  const folders = folderNameMap();
  fs.mkdirSync(runDir, { recursive: true });
  // 每台启用服务器都建目录(即使全部命令失败), 保证当天「服务器名称」清单完整可查
  Object.keys(folders).forEach(function (sid) {
    fs.mkdirSync(path.join(runDir, folders[sid]), { recursive: true });
  });
  // 同一次运行内用 HHMMSS 作文件前缀; 同一天重复巡检自动加 _2/_3, 不覆盖历史留证。
  let batchTag = timeStr(started), k = 2, exist = [];
  try {
    exist = (JSON.parse(fs.readFileSync(path.join(runDir, '00_summary.json'), 'utf8')).batches || [])
      .map(function (b) { return b.tag; });
  } catch (e) {}
  while (exist.indexOf(batchTag) >= 0) { batchTag = timeStr(started) + '_' + k; k++; }
  const jobs = [];
  const shotRows = [];
  enabledServers().forEach(function (server) {
    const folder = folders[server.id];
    const srvDir = path.join(runDir, folder);
    commandsForServer(server).forEach(function (chk, idx) {
      jobs.push(runCommand(server, chk).then(function (out) {
        let seq = String(idx + 1);
        while (seq.length < 3) seq = '0' + seq;
        // 文件名 = 批次_序号_服务器名称_命令名称: 单独拷出一张图也能看懂是哪台机、哪条命令。
        // .ansi / .txt / .png 共用同一 basename, 三者一一对应。
        const base = batchTag + '_' + seq + '_' + fileNamePart(server.name, 30) + '_' + fileNamePart(chk.name, 24);
        // 写盘失败(只读盘/目录权限/磁盘满)要单独归类, 不能误报成"登录失败"。
        try {
          fs.mkdirSync(srvDir, { recursive: true });
          fs.writeFileSync(path.join(srvDir, base + '.ansi'), out.raw, 'utf8');
          fs.writeFileSync(path.join(srvDir, base + '.txt'), stripAnsi(out.raw), 'utf8');
        } catch (we) { we.writeError = true; throw we; }
        // 回写实时看板: pollIntervalMs=0 时巡检是唯一采集来源, 若只写归档不回写,
        // 看板会永远停在"等待首次采集…"(只显示启动时 restoreLocal 读回的残留)。
        // 关键: 回写失败绝不能影响留证/截图 —— 整段包 try/catch, 与下面的 row 构造彻底解耦。
        try {
          const st = state.get(server.id);
          if (st) {
            const parsed = parseResult(chk, out.raw);
            const e = st.results.get(chk.id) || { latest: null, series: [], error: null, lastFlush: 0, lastRun: 0 };
            e.latest = { ts: out.ts, raw: out.raw, command: chk.command, name: chk.name, durationMs: out.durationMs, parsed: parsed };
            e.online = true; e.error = null;
            if (parsed.value != null) {
              e.series.push({ ts: out.ts, value: parsed.value });
              const maxPts = def(config.settings && config.settings.historyMaxPoints, 2000);
              if (e.series.length > maxPts) e.series = e.series.slice(e.series.length - maxPts);
            }
            st.results.set(chk.id, e);
            persistLocal(server.id, chk.id, e);
          }
        } catch (ignored) { /* 看板回写失败不影响留证 */ }
        // 留证只保存原始输出, 不做数值解析(解析结果只属于实时看板, 写入归档从未被任何清单使用)
        const row = {
          seq: seq, serverId: server.id, serverName: server.name, serverFolder: folder,
          batchTag: batchTag, host: server.host,
          commandId: chk.id, commandName: chk.name, command: chk.command,
          ts: out.ts, durationMs: out.durationMs, status: 'ok',
          bytes: Buffer.byteLength(out.raw, 'utf8'),
          base: base, file: folder + '/' + base + '.ansi'
        };
        shotRows.push(row);
        return row;
      }).catch(function (err) {
        let seq = String(idx + 1);
        while (seq.length < 3) seq = '0' + seq;
        const cat = classifyFailure(err, { write: !!err.writeError });
        const msg = (err.writeError ? '写归档失败: ' : '') + err.message;
        const st = state.get(server.id);
        if (st) {
          const e = st.results.get(chk.id) || { latest: null, series: [], error: null, lastFlush: 0, lastRun: 0 };
          e.online = false; e.error = msg; e.errorCategory = cat; e.errorAt = Date.now();
          st.results.set(chk.id, e);
        }
        const row = { seq: seq, serverId: server.id, serverName: server.name, serverFolder: folder,
          batchTag: batchTag, host: server.host, commandId: chk.id, commandName: chk.name,
          command: chk.command, ts: Date.now(), status: 'error', error: msg, category: cat };
        shotRows.push(row);
        logCollectFailure('inspect', server, chk, cat, msg);
        return row;
      }));
    });
  });
  return allSettled(jobs).then(function () {
    shotRows.sort(function (a, b) { return (a.serverFolder + a.seq).localeCompare(b.serverFolder + b.seq); });
    // 1) 自动截图: PNG 与 .txt/.ansi 平铺在同一服务器名称目录
    const shotStat = renderScreenshots(runDir, shotRows, started);
    // 本批次原始输出 + 截图生成完毕后立即加不可变标记; 汇总清单等可追加文件不锁。
    const locked = chattrBatch(evidenceArtifactFiles(runDir), true);
    if (locked) console.log('[immutable] 本批已锁定 ' + locked + ' 个巡检产物 (chattr +i)');
    const byServer = {};
    shotRows.forEach(function (r) { byServer[r.serverFolder] = 1; });
    // 2) manifest.csv: 中文表头 + UTF-8 BOM(Excel 双击不乱码), 按批次幂等追加到当天清单
    appendManifest(runDir, batchTag, shotRows);
    // 3) 00_summary.json: 保留当天所有批次历史, 顶层为累计统计
    const okCount = shotRows.filter(function (r) { return r.status === 'ok'; }).length;
    // 失败明细随批次一起落盘: 页面/审计不再只能看到"失败 N 条"却查不到原因。
    const errorRows = shotRows.filter(function (r) { return r.status === 'error'; });
    const failKinds = {};
    errorRows.forEach(function (r) {
      const k = r.category || 'unknown';
      failKinds[k] = (failKinds[k] || 0) + 1;
    });
    const failures = errorRows.map(function (r) {
      return { serverId: r.serverId, server: r.serverName, commandId: r.commandId, command: r.commandName,
        category: r.category || 'unknown', categoryText: FAIL_KINDS[r.category] || '其他原因', error: r.error };
    });
    const batch = { tag: batchTag, runId: runId, ts: started, trigger: trigger,
      servers: Object.keys(byServer).length, commands: shotRows.length, ok: okCount,
      failed: shotRows.length - okCount, shots: shotStat.ok, durationMs: Date.now() - started,
      failures: failures, failKinds: failKinds };
    if (failures.length) {
      const parts = Object.keys(failKinds).map(function (k) { return (FAIL_KINDS[k] || k) + '×' + failKinds[k]; });
      console.warn('[sched] 本批失败 ' + failures.length + ' 条: ' + parts.join('、')
        + '。明细见 00_summary.json batches[].failures / manifest.csv 末两列 / 本日志上方 [collect] 行');
    }
    let prev = { batches: [] };
    try { prev = JSON.parse(fs.readFileSync(path.join(runDir, '00_summary.json'), 'utf8')); } catch (e) {}
    const batches = (prev.batches || []).filter(function (b) { return b.tag !== batchTag; });
    batches.push(batch);
    batches.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    const totals = batches.reduce(function (t, b) {
      t.commands += def(b.commands, 0); t.ok += def(b.ok, 0);
      t.failed += def(b.failed, 0); t.shots += def(b.shots, 0); return t;
    }, { commands: 0, ok: 0, failed: 0, shots: 0 });
    const summary = { runId: runId, date: day, ts: started, trigger: trigger,
      servers: Object.keys(byServer).length, commands: shotRows.length, ok: okCount,
      failed: shotRows.length - okCount, shots: shotStat.ok,
      shotFailed: shotStat.failed, shotError: shotStat.error || null,
      durationMs: Date.now() - started, batches: batches,
      dayCommands: totals.commands, dayOk: totals.ok, dayFailed: totals.failed, dayShots: totals.shots };
    atomicWrite(path.join(runDir, '00_summary.json'), JSON.stringify(summary, null, 2));
    // 4) SHA256SUMS: 全量重算当天目录(所有批次/所有服务器/所有文件)。
    writeSha256Sums(runDir);
    // sqlite 目录索引(可重建, 不影响留证)
    updateIndex(runDir, summary, shotRows);
    // 清理超过保留期的归档(按天), 默认 0 = 永久保留
    pruneOldEvidence();
    // 更新调度状态
    sched.lastRun = started; sched.lastResult = summary;
    sched.history.unshift(summary); sched.history = sched.history.slice(0, schedHistoryMax());
    sched.nextRun = computeNextRun();
    persistScheduleState();
    console.log('[sched] 巡检完成 ' + runId + ' -> ' + summary.ok + '/' + summary.commands + ' 成功, 截图 ' + summary.shots + ' 张');
    return summary;
  }).catch(function (e) {
    console.error('[sched] 巡检异常: ' + e.message);
    return { ok: false, error: e.message };
  }).then(function (r) { sched.running = false; return r; });
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function safeName(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_'); }
// 文件名片段: 保留中文/括号/连字符等可读字符, 只替换文件系统非法字符与控制字符。
// 与目录名清洗规则一致(去掉首尾空格/点), 再按 maxLen 截断, 避免整条路径超过 Windows 260 字符。
function fileNamePart(s, maxLen) {
  let n = String(s == null ? '' : s).trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
  if (n.length > maxLen) n = n.slice(0, maxLen).replace(/[. ]+$/g, '').trim();
  return n || 'unnamed';
}

// ---------- 归档目录: 用可读的「服务器名称」, 每天一层, 文件平铺 ----------
// 保留中文, 只替换 Windows/Linux 都不能用的字符与控制字符; 去掉首尾空格/点
// (Windows 目录名限制), 限长 60 避免超长路径; 名称为空回退 id; 重名(忽略
// 大小写以兼容 Windows)自动追加 _2/_3, 保证目录名唯一、可整夹拷贝。
function folderNameMap() {
  const used = {}, map = {};
  enabledServers().forEach(function (s) {
    let n = String(s.name || '').trim()
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .trim();
    if (n.length > 60) n = n.slice(0, 60).replace(/[. ]+$/g, '');
    if (!n) n = String(s.id || 'server').replace(/[^A-Za-z0-9_-]/g, '_') || 'server';
    const base = n; let k = 2;
    while (used[n.toLowerCase()]) { n = base + '_' + k; k++; }
    used[n.toLowerCase()] = true;
    map[s.id] = n;
  });
  return map;
}
// manifest.csv 中文表头(UTF-8 BOM 由 appendManifest 前置)。列位与旧版英文表头
// 一一对齐, 前端与索引重建用同一套列索引即可同时兼容新旧两种归档布局。
// 末尾两列「失败分类/失败原因」为后加, 前 13 列位置保持不变:
// 旧归档(13 列)、index_evidence.py(len>=13) 与前端按列号读取都不受影响。
const MANIFEST_HEADER = '批次,序号,服务器名称,主机,命令ID,命令名称,命令,时间,状态,字节数,截图文件,截图字节数,原始文件,失败分类,失败原因\n';
function manifestRow(r, batchTag) {
  return [batchTag, r.seq, r.serverName, r.host, r.commandId, r.commandName, r.command,
    fmtTs(r.ts), r.status, def(r.bytes, 0), def(r.png, ''), def(r.pngBytes, 0), def(r.file, ''),
    r.status === 'error' ? (FAIL_KINDS[r.category] || r.category || '其他原因') : '',
    r.status === 'error' ? def(r.error, '') : '']
    .map(csvCell).join(',') + '\n';
}
// 服务端最小 CSV 行解析(仅用于按批次过滤), 与前端 parseCsv 等价。
function parseManifestLine(line) {
  const out = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === '"') {
      if (inQ && line.charAt(i + 1) === '"') { cur += '"'; i++; } else inQ = !inQ;
      continue;
    }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur); return out;
}
// 同一天多次巡检: 按批次幂等追加到当天的 manifest.csv, 不覆盖历史批次。
function appendManifest(runDir, batchTag, rows) {
  const f = path.join(runDir, 'manifest.csv');
  let kept = [];
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8').replace(/^\ufeff/, '');
    raw.split('\n').forEach(function (l, i) {
      if (!l.trim()) return;
      if (i === 0 && (l.indexOf('server_id') >= 0 || l.indexOf('批次,') === 0)) return; // 旧/新表头
      const c = parseManifestLine(l);
      if (c.length >= 13 && c[0] !== batchTag) kept.push(l);
    });
  }
  const body = (kept.length ? kept.join('\n') + '\n' : '')
    + rows.map(function (r) { return manifestRow(r, batchTag); }).join('');
  atomicWrite(f, '\ufeff' + MANIFEST_HEADER + body);
}
// 按 retainDays 清理旧归档(默认 0=永久保留, 审计留证不建议自动删)。
// 仅在配置显式 >0 时生效; 只删整天目录且早于保留期; 每批最多删 1 天, 避免误删风暴。
function pruneOldEvidence() {
  try {
    const days = Number(def(config.settings && config.settings.retainDays, 0));
    if (!days || days <= 0) return;
    if (!fs.existsSync(EVIDENCE_DIR)) return;
    const today = dateStr(Date.now());
    const cutoff = Date.now() - days * 86400000;
    const olds = fs.readdirSync(EVIDENCE_DIR)
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== today; })
      .filter(function (d) {
        const t = new Date(d + 'T00:00:00').getTime();
        return !isNaN(t) && t < cutoff;
      }).sort();
    if (!olds.length) return;
    const victim = olds[0];
    const vdir = path.join(EVIDENCE_DIR, victim);
    // 双重确认: 必须是 evidence 下的日期目录
    if (path.dirname(vdir) !== path.resolve(EVIDENCE_DIR)) return;
    // 保留期清理是"授权删除": 先解除历史不可变标记, 否则 chattr +i 会让 unlink 全部失败。
    chattrBatch(walkFiles(vdir).map(function (rel) { return path.join(vdir, rel); }), false, { force: true });
    walkFiles(vdir).forEach(function (rel) { try { fs.unlinkSync(path.join(vdir, rel)); } catch (e) {} });
    (function rmdir(d) {
      fs.readdirSync(d).forEach(function (n) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) rmdir(f); });
      try { fs.rmdirSync(d); } catch (e) {}
    })(vdir);
    // 顺带清掉该日期的压缩包副本, 避免留下「能下载但已无留证」的孤儿 zip
    try {
      if (fs.existsSync(ZIP_DIR)) fs.readdirSync(ZIP_DIR).forEach(function (n) {
        if (n.indexOf('archive_' + victim + '_') === 0 || n === 'archive_' + victim + '.zip') {
          try { fs.unlinkSync(path.join(ZIP_DIR, n)); } catch (e) {}
        }
      });
    } catch (e) {}
    console.log('[prune] 已清理超过 ' + days + ' 天的归档: ' + victim);
  } catch (e) { console.error('[prune] ' + e.message); }
}
function walkFiles(dir) {
  const out = [];
  (function walk(d, prefix) {
    fs.readdirSync(d).forEach(function (name) {
      const full = path.join(d, name); const rel = prefix ? prefix + '/' + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, rel); else out.push(rel);
    });
  })(dir, '');
  return out;
}

// ---------- 归档压缩包 (下载 + 定时压缩共用) ----------
// 用 Python 标准库 zipfile 生成标准 zip: 跨平台、零外部命令依赖, Linux 上可直接 unzip 解开,
// 且对中文文件名自动打 UTF-8 标记(bit 11), Windows 资源管理器也不会乱码。
// 压缩包只放 data/zips/, evidence/ 原始留证保持原样不删改(审计可追溯)。
function safeArchiveKey(key) {
  return String(key == null ? '' : key).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(\.\.\/)+/, '');
}
function zipBaseName(key, batch) {
  const k = safeArchiveKey(key).replace(/[^0-9A-Za-z_-]/g, '_');
  const tag = String(batch || '').replace(/[^0-9_]/g, '');
  return 'archive_' + k + (tag ? '_' + tag : '');
}
function zipCachePath(key, batch) { return path.join(ZIP_DIR, zipBaseName(key, batch) + '.zip'); }
function zipDisplayName(key, batch) {
  const k = safeArchiveKey(key).replace(/\//g, '-');
  const tag = String(batch || '').replace(/[^0-9_]/g, '');
  return '巡检留证_' + k + (tag ? '_' + tag : '') + '.zip';
}
function zipIsFresh(zp, col) {
  try {
    const zt = fs.statSync(zp).mtimeMs;
    let newest = 0;
    col.files.forEach(function (f) {
      try { const m = fs.statSync(f.src).mtimeMs; if (m > newest) newest = m; } catch (e) {}
    });
    ['00_summary.json', 'manifest.csv', 'SHA256SUMS'].forEach(function (n) {
      try { const m = fs.statSync(path.join(col.base, n)).mtimeMs; if (m > newest) newest = m; } catch (e) {}
    });
    return zt >= newest;
  } catch (e) { return false; }
}
// 收集待打包文件。batch 非空时只取该批次前缀(<tag>_)的截图/原始输出,
// 并附上整日 00_summary.json + 只含本批次的 manifest.csv / SHA256SUMS。
function collectArchive(key, batch) {
  const rootAbs = path.resolve(EVIDENCE_DIR);
  const rel = safeArchiveKey(key);
  if (!rel) return null;
  const base = path.resolve(rootAbs, rel.replace(/\//g, path.sep));
  if (base.indexOf(rootAbs) !== 0 || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) return null;
  const tag = String(batch || '').replace(/[^0-9_]/g, '');
  const top = rel.replace(/\//g, '-');
  const files = [], texts = [];
  walkFiles(base).forEach(function (r) {
    if (/_index_spec\.json$/.test(r)) return;
    if (tag) {
      // 文件名格式: <批次HHMMSS 或 HHMMSS_2>_<3位序号>_<服务器>_<命令>;
      // 用 3 位序号做锚点(与前端 shotBatchTag 一致), 避免贪婪匹配把序号吞进批次号。
      const m = /^(\d{6}(?:_\d+)?)_\d{3}_/.exec(r.split('/').pop());
      if (!m || m[1] !== tag) return;
    }
    files.push({ src: path.join(base, r.replace(/\//g, path.sep)), arc: top + '/' + r });
  });
  if (tag) {
    const sumPath = path.join(base, '00_summary.json');
    if (fs.existsSync(sumPath)) texts.push({ arc: top + '/00_summary.json', text: fs.readFileSync(sumPath, 'utf8') });
    const mfPath = path.join(base, 'manifest.csv');
    if (fs.existsSync(mfPath)) {
      const lines = fs.readFileSync(mfPath, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/);
      const keep = lines.filter(function (l, i) {
        if (!l.trim()) return false;
        if (i === 0) return true;
        return l.split(',')[0].replace(/^"|"$/g, '').trim() === tag;
      });
      texts.push({ arc: top + '/manifest.csv', text: '\ufeff' + keep.join('\n') + '\n' });
    }
    const shaPath = path.join(base, 'SHA256SUMS');
    if (fs.existsSync(shaPath)) {
      const keep = fs.readFileSync(shaPath, 'utf8').split(/\r?\n/).filter(function (l) {
        return l.trim() && l.indexOf(tag + '_') >= 0;
      });
      if (keep.length) texts.push({ arc: top + '/SHA256SUMS', text: keep.join('\n') + '\n' });
    }
  }
  if (!files.length && !texts.length) return null;
  return { base: base, files: files, texts: texts, tag: tag, top: top };
}
function buildArchiveZip(key, batch, col) {
  col = col || collectArchive(key, batch);
  if (!col) return null;
  const py = detectPython();
  if (!py) return null;
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  const out = zipCachePath(key, batch);
  const specPath = path.join(ZIP_DIR, '_job_' + process.pid + '_' + Date.now().toString(36) + '.json');
  try {
    atomicWrite(specPath, JSON.stringify({ out: out, files: col.files, texts: col.texts }));
    const o = execFileSync(py, [path.join(ROOT, 'scripts', 'zip_evidence.py'), '--jobs', specPath],
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] });
    const r = JSON.parse(String(o).trim().split('\n').slice(-1)[0]);
    if (!r.ok) return null;
    return { path: out, name: zipDisplayName(key, batch), bytes: r.bytes, count: r.files };
  } catch (e) {
    console.error('[zip] 打包失败: ' + e.message);
    return null;
  } finally {
    try { fs.unlinkSync(specPath); } catch (e) {}
  }
}
// 定时压缩: 把「已完结」(非当天)的整日归档预压成 zip, 供页面下载直接复用。
// 每轮最多补 10 天, 避免首次启动时大量积压造成 IO 风暴; 已有 zip 不重复生成。
function zipTick() {
  if (def(config.settings && config.settings.archiveZipDaily, true) === false) return;
  if (!fs.existsSync(EVIDENCE_DIR)) return;
  const today = dateStr(Date.now());
  let days = [];
  try {
    days = fs.readdirSync(EVIDENCE_DIR)
      .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== today; })
      .sort().reverse();
  } catch (e) { return; }
  let done = 0;
  for (let i = 0; i < days.length && done < 10; i++) {
    const d = days[i];
    try { if (fs.existsSync(zipCachePath(d, ''))) continue; } catch (e) { continue; }
    const col = collectArchive(d, '');
    if (!col) continue;
    const r = buildArchiveZip(d, '', col);
    if (r) { console.log('[zip] 定时压缩: ' + d + ' -> ' + r.name + ' (' + r.bytes + ' 字节)'); done++; }
  }
}

// ---------- 自动截图 (调用本机 Python + pyte + Pillow 渲染原生终端画面) ----------
let rendererCache = undefined; // undefined=未探测, null=不可用, string=python 可执行文件
let pyCache = undefined;       // 仅需能跑 sqlite3 的 python(建索引), 不要求 pyte/PIL
// 不能只认 python3: 有的机器只装了 python3.10 但没有 /usr/bin/python3 软链接,
// 或该命令只在交互 shell 的 PATH 里、服务启动时看不到。这里把常见版本名都试一遍。
const PY_CANDIDATES = ['python3', 'python3.10', 'python3.11', 'python3.12', 'python3.13',
  'python3.9', 'python3.8', 'python3.7', 'python', 'py'];
// 找一个可用的 python 解释器 (只验证能 import sqlite3; 用于索引, 与截图解耦)
function detectPython() {
  if (pyCache !== undefined) return pyCache;
  const st = config.settings || {};
  const cands = [];
  if (st.pythonExe) cands.push(/[\\/]/.test(st.pythonExe) ? toAbs(st.pythonExe) : st.pythonExe);
  // python3 优先, 其次枚举具体版本名; 部分 Linux 没有 python3 软链接, 只有 python3.10。
  cands.push.apply(cands, PY_CANDIDATES);
  for (let i = 0; i < cands.length; i++) {
    try { execFileSync(cands[i], ['-c', 'import sys; assert sys.version_info[0] >= 3; import sqlite3'], { stdio: 'ignore', timeout: 10000 }); pyCache = cands[i]; return pyCache; } catch (e) {}
  }
  pyCache = null; return null;
}
// 巡检归档完成后, 把本批次元数据写入 SQLite 索引(evidence/index.db)。
// 索引失败绝不影响留证: 原始文件已落盘, 可用 scripts/index_evidence.py --rebuild 重建。
function updateIndex(runDir, summary, shotRows) {
  let spec = null;
  let specPath = null;
  try {
    const st = config.settings || {};
    if (def(st.sqliteIndex, true) === false) return;
    const py = detectPython();
    const rows = shotRows.map(function (r) {
      // server_id 用「服务器名称目录名」(唯一), 与 --rebuild 从清单反查的结果一致;
      // 原始名称另存 server_name, 检索时两者都可匹配。
      return { seq: r.seq, server_id: r.serverFolder || r.serverId, server_name: r.serverName, host: r.host,
        command_id: r.commandId, command_name: r.commandName, command: r.command,
        status: r.status, bytes: def(r.bytes, 0), png: def(r.png, ''), file: def(r.file, ''),
        ts: r.ts };
    });
    spec = {
      run: { run_id: summary.runId, date: summary.date, ts: summary.ts, trigger: summary.trigger,
        servers: summary.servers, commands: summary.commands, ok: summary.ok, failed: summary.failed,
        shots: summary.shots, duration_ms: summary.durationMs,
        dir: path.relative(EVIDENCE_DIR, runDir).replace(/\\/g, '/') },
      rows: rows
    };
    if (!py) {
      console.warn('[index] 未找到 Python3(含 sqlite3), 跳过 SQLite 索引(装 Python 后可一键重建)');
      appendJsonlIndex(spec);
      return;
    }
    specPath = path.join(runDir, '_index_spec.json');
    atomicWrite(specPath, JSON.stringify(spec));
    const dbPath = path.join(EVIDENCE_DIR, 'index.db');
    const out = execFileSync(py, [path.join(ROOT, 'scripts', 'index_evidence.py'), '--db', dbPath, '--upsert-run', specPath],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    try { fs.unlinkSync(specPath); } catch (e) {}
    console.log('[index] sqlite 索引已更新: ' + String(out).trim());
  } catch (e) {
    console.error('[index] 索引更新失败(不影响留证): ' + e.message);
    if (specPath) { try { fs.unlinkSync(specPath); } catch (e2) {} }
    if (spec) appendJsonlIndex(spec);
  }
}
// 离线兜底: 随包 wheel 已解包到 vendor/pylib/cpXY, 通过 PYTHONPATH 注入,
// 即使 pip 装不上(无 pip / PEP 668 / 只读 HOME)也能 import pyte/PIL。
const _pylibCache = Object.create(null);
function pylibDir(py) {
  if (Object.prototype.hasOwnProperty.call(_pylibCache, py)) return _pylibCache[py];
  let dir = null;
  try {
    const tag = String(execFileSync(py, ['-c', 'import sys; print("cp%d%d" % sys.version_info[:2])'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    // 随包库按平台分家:
    //   Linux  -> vendor/pylib/<tag>            (C 扩展 .so)
    //   Windows-> vendor/pylib/win-<tag>-amd64 / win-<tag>-x86  (C 扩展 .pyd)
    // 绝不能把 Linux 的 .so 注入 Windows(或反之): 会覆盖可用的系统 Pillow,
    // 且 `from PIL import Image` 找不到匹配的 _imaging, 截图全部失败。
    const isWin = process.platform === 'win32';
    const needExt = isWin ? '.pyd' : '.so';
    let cands = [path.join(ROOT, 'vendor', 'pylib', tag)];
    if (isWin) {
      let arch = 'amd64';
      try {
        const bits = String(execFileSync(py, ['-c', 'import struct; print(8 * struct.calcsize("P"))'],
          { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
        if (bits === '32') arch = 'x86';
      } catch (e2) {}
      cands = [path.join(ROOT, 'vendor', 'pylib', 'win-' + tag + '-' + arch)];
    }
    for (let i = 0; i < cands.length; i++) {
      const cand = cands[i];
      const pilDir = path.join(cand, 'PIL');
      let nativeOk = false;
      try {
        nativeOk = fs.existsSync(pilDir) && fs.readdirSync(pilDir).some(function (f) {
          const low = f.toLowerCase();
          return low.indexOf('_imaging') === 0 && low.slice(-needExt.length) === needExt;
        });
      } catch (e3) {}
      if (nativeOk && fs.existsSync(path.join(cand, 'pyte'))) { dir = cand; break; }
    }
    // 无匹配(如 Windows 上 python 3.11 无随包库)时 dir 保持 null,
    // pythonEnv 不注入 PYTHONPATH, 让 Python 使用已装好的系统 site-packages。
  } catch (e) {}
  _pylibCache[py] = dir;
  return dir;
}
function pythonEnv(py) {
  const d = pylibDir(py);
  if (!d) return undefined;
  const env = Object.assign({}, process.env);
  const cur = env.PYTHONPATH || '';
  env.PYTHONPATH = d + (cur ? path.delimiter + cur : '');
  return env;
}
function detectRenderer() {
  if (rendererCache !== undefined) return rendererCache;
  const st = config.settings || {};
  const candidates = [];
  if (st.pythonExe) {
    // 含路径分隔符视为路径(相对 ROOT 解析); 否则当作 PATH 中的命令名
    candidates.push(/[\\/]/.test(st.pythonExe) ? toAbs(st.pythonExe) : st.pythonExe);
  }
  // python3 优先, 其次枚举具体版本名; 且必须是 Python 3。
  candidates.push.apply(candidates, PY_CANDIDATES);
  const reasons = [];
  const seen = Object.create(null);
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    if (seen[cand]) continue;
    seen[cand] = true;
    try {
      // 必须实例化一张图片: 只 `import PIL` 不会加载 C 扩展 _imaging,
      // 会把"只有 Linux .so 的随包 pylib"误判为可用(Windows 上渲染必然失败)。
      execFileSync(cand, ['-c', 'import sys; assert sys.version_info[0] >= 3; import pyte, PIL; from PIL import Image; Image.new("RGB",(1,1)); print(PIL.__version__)'],
        { env: pythonEnv(cand), timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
      rendererCache = cand;
      console.log('[shot] 渲染器就绪: ' + cand + '（本地兜底库: ' + (pylibDir(cand) || '未启用') + '）');
      return rendererCache;
    } catch (e) {
      const raw = ((e.stderr && String(e.stderr)) || e.message || '').trim();
      const detail = raw.split('\n').slice(-2).join(' | ').slice(0, 300) || '无法启动';
      reasons.push(cand + ' -> ' + detail);
    }
  }
  console.error('[shot] 所有 Python 候选都没有可用的 pyte/Pillow：');
  reasons.forEach(function (r) { console.error('[shot]   ' + r); });
  console.error('[shot] 请先运行 install.sh / install.bat 安装截图依赖（pip install -r requirements.txt）。');
  rendererCache = null;
  return null;
}
function renderScreenshots(runDir, shotRows, started) {
  const st = config.settings || {};
  if (def(st.shotEnabled, true) === false) return { enabled: false, ok: 0, failed: 0 };
  const py = detectRenderer();
  if (!py) {
    console.warn('[shot] 未找到含 pyte/Pillow 的 Python, 跳过自动截图。请在中心机安装: pip install pyte==0.8.2 Pillow==9.5.0');
    return { enabled: true, ok: 0, failed: 0, error: 'renderer unavailable' };
  }
  const jobs = [];
  const rowByPng = {};
  shotRows.forEach(function (r) {
    if (r.status !== 'ok' || !r.file) return;
    // r.file 相对 runDir, 例如 业务服务器-01/173207_001_hostname.ansi (文件已平铺)
    const ansiAbs = path.join(runDir, r.file.replace(/\//g, path.sep));
    if (!fs.existsSync(ansiAbs)) return;
    // PNG 与 .ansi/.txt 共用同一 basename(可读的服务器名称+命令名称), 三者一一对应
    const base = r.base || ((r.batchTag || '') + (r.batchTag ? '_' : '') + r.seq + '_' + safeName(r.commandId));
    const pngRel = (r.serverFolder || safeName(r.serverId)) + '/' + base + '.png';
    const pngAbs = path.join(runDir, pngRel.replace(/\//g, path.sep));
    const sshUser = 'root';
    const promptLine = sshUser + '@' + r.serverName + ':~$ ' + r.command;
    const header = sshUser + '@' + r.serverName + '  ' + r.host + '  |  ' + fmtTs(r.ts) + '  |  ' + r.command;
    const key = pngRel;
    jobs.push({ ansi_file: ansiAbs, png_file: pngAbs, prompt_line: promptLine, header: header, command: r.command });
    rowByPng[key] = r;
  });
  if (!jobs.length) return { enabled: true, ok: 0, failed: 0 };
  const fontSetting = def(st.shotFontPath, 'auto');
  const cjkSetting = def(st.shotCjkFontPath, 'auto');
  const spec = {
    font_size: def(st.shotFontSize, 14),
    theme: def(st.shotTheme, 'dark'),
    terminal_cols: def(st.terminalCols, 132),
    terminal_lines: def(st.terminalLines, 80),
    // auto 保留; 相对路径以程序根目录解析, 使字体随程序一起搬运
    font_path: (fontSetting === 'auto' || fontSetting === '') ? fontSetting : toAbs(fontSetting),
    cjk_font_path: (cjkSetting === 'auto' || cjkSetting === '') ? cjkSetting : toAbs(cjkSetting),
    jobs: jobs
  };
  const jobsPath = path.join(runDir, '_render_jobs.json');
  fs.writeFileSync(jobsPath, JSON.stringify(spec, null, 2), 'utf8');
  let result = { enabled: true, ok: 0, failed: 0 };
  try {
    const out = execFileSync(py, [path.join(ROOT, 'scripts', 'render_shot.py'), '--jobs', jobsPath],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: pythonEnv(py) });
    result = JSON.parse(String(out).trim().split('\n').slice(-1)[0]);
  } catch (e) {
    const detail = (e.stderr ? String(e.stderr) : '') || e.message;
    console.error('[shot] 渲染失败: ' + detail.slice(0, 400));
    result = { enabled: true, ok: 0, failed: jobs.length, error: detail.slice(0, 400) };
  }
  try { fs.unlinkSync(jobsPath); } catch (e) {}
  // 回填 PNG 相对路径到对应行(前端据此展示/下载)
  const results = result.results || [];
  results.forEach(function (rr) {
    if (!rr.ok) return;
    const rel = path.relative(runDir, rr.png_file).replace(/\\/g, '/');
    const row = rowByPng[rel];
    if (row) { row.png = rel; row.pngBytes = fs.existsSync(rr.png_file) ? fs.statSync(rr.png_file).size : 0; }
  });
  console.log('[shot] 自动截图 ' + (result.ok || 0) + '/' + jobs.length + ' 张生成');
  return { enabled: true, ok: result.ok || 0, failed: result.failed || 0, error: result.error };
}

// ---------- 重新生成截图: .ansi 原始文件在, 可按当前截图设置重渲染 PNG ----------
// 场景: 调整了终端列宽/最大行数/主题/字号后, 对某天历史归档一键重出图。
// 只重写可再生的 PNG 与 manifest 的截图列; .txt/.ansi 原始留证不动(审计原则)。
// 渲染走异步子进程: 一天可能上百张, 不阻塞 Node 事件循环。
function reshootDay(dayKey) {
  return withImmutDay(String(dayKey).split('/')[0], function () { return reshootDayInner(dayKey); });
}
function reshootDayInner(dayKey) {
  return new Promise(function (resolve, reject) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return reject(new Error('非法日期: ' + dayKey));
    const runDir = path.join(EVIDENCE_DIR, dayKey);
    const mf = path.join(runDir, 'manifest.csv');
    if (!fs.existsSync(mf)) return reject(new Error('该日没有 manifest.csv'));
    const py = detectPython();
    if (!py) return reject(new Error('未找到可用的 Python 渲染器'));
    const st = def(config.settings, {});
    // 解析 manifest → 可重渲染行(状态 ok 且 .ansi 存在; 失败命令无内容可渲染)
    const raw = fs.readFileSync(mf, 'utf8').replace(/^\ufeff/, '');
    const rows = [];
    raw.split('\n').forEach(function (l, i) {
      if (!l.trim()) return;
      if (i === 0 && l.indexOf('批次,') === 0) return;
      const c = parseManifestLine(l);
      if (c.length < 13 || c[8] !== 'ok' || !c[12]) return;
      const fileRel = String(c[12]).replace(/\\/g, '/');
      if (!fileRel || fileRel.indexOf('..') >= 0) return;
      const ansiAbs = path.join(runDir, fileRel.replace(/\//g, path.sep));
      if (!fs.existsSync(ansiAbs)) return;
      rows.push({ c: c, fileRel: fileRel, ansiAbs: ansiAbs,
        base: path.basename(fileRel).replace(/\.ansi$/i, ''),
        serverFolder: fileRel.split('/')[0] });
    });
    if (!rows.length) return reject(new Error('该日没有可重渲染的原始输出(需状态 ok 且 .ansi 存在)'));
    const jobs = rows.map(function (r) {
      const pngRel = r.serverFolder + '/' + r.base + '.png';
      const prompt = 'root@' + r.c[2] + ':~$ ' + r.c[6];
      const header = 'root@' + r.c[2] + '  ' + r.c[3] + '  |  ' + r.c[7] + '  |  ' + r.c[6];
      return { ansi_file: r.ansiAbs, png_file: path.join(runDir, pngRel.replace(/\//g, path.sep)), prompt_line: prompt, header: header };
    });
    const fontSetting = def(st.shotFontPath, 'auto');
    const cjkSetting = def(st.shotCjkFontPath, 'auto');
    const spec = {
      font_size: def(st.shotFontSize, 14), theme: def(st.shotTheme, 'dark'),
      terminal_cols: def(st.terminalCols, 132), terminal_lines: def(st.terminalLines, 80),
      font_path: (fontSetting === 'auto' || fontSetting === '') ? fontSetting : toAbs(fontSetting),
      cjk_font_path: (cjkSetting === 'auto' || cjkSetting === '') ? cjkSetting : toAbs(cjkSetting),
      jobs: jobs
    };
    const jobsPath = path.join(runDir, '_reshoot_jobs.json');
    fs.writeFileSync(jobsPath, JSON.stringify(spec, null, 2), 'utf8');
    // PNG 是「可再生」文件: 已被 chattr +i 锁住时渲染器无法覆盖。
    // 渲染前临时解除这些 PNG 的不可变标记, 结束后再锁回去; .txt/.ansi 原始留证不碰。
    const pngFiles = jobs.map(function (j) { return j.png_file; });
    chattrBatch(pngFiles, false, { force: true });
    const relock = function () { chattrBatch(pngFiles, true); };
    const child = spawn(py, [path.join(ROOT, 'scripts', 'render_shot.py'), '--jobs', jobsPath],
      { env: pythonEnv(py), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errTxt = '';
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { errTxt += d; });
    child.on('error', function (e) { relock(); try { fs.unlinkSync(jobsPath); } catch (e2) {} reject(e); });
    child.on('close', function (code) {
      relock();
      try { fs.unlinkSync(jobsPath); } catch (e) {}
      if (code !== 0) return reject(new Error('渲染进程失败: ' + (errTxt || ('exit ' + code)).slice(0, 300)));
      let result = {};
      try { result = JSON.parse(out.trim().split('\n').slice(-1)[0]); }
      catch (e) { return reject(new Error('渲染输出解析失败')); }
      // 回填 manifest 的「截图文件/截图字节数」列, 其余行原样保留
      const pngInfo = {}; // fileRel -> [pngRel, bytes]
      rows.forEach(function (r) {
        const pngAbs = path.join(runDir, (r.serverFolder + '/' + r.base + '.png').replace(/\//g, path.sep));
        if (fs.existsSync(pngAbs)) pngInfo[r.fileRel] = [r.serverFolder + '/' + r.base + '.png', fs.statSync(pngAbs).size];
      });
      const body = raw.split('\n').map(function (l, i) {
        if (!l.trim()) return '';
        if (i === 0 && l.indexOf('批次,') === 0) return l;
        const c = parseManifestLine(l);
        if (c.length < 13) return l;
        const upd = pngInfo[String(c[12] || '').replace(/\\/g, '/')];
        if (!upd) return l;
        c[10] = upd[0]; c[11] = upd[1];
        return c.map(csvCell).join(',');
      }).filter(function (l) { return l !== ''; }).join('\n');
      atomicWrite(mf, '\ufeff' + body + '\n');
      // PNG 已替换: 同步重算校验清单, 否则 SHA256SUMS 与归档内容对不上
      writeSha256Sums(runDir);
      // 清掉该日 zip 缓存, 下次下载按新截图重新打包
      try {
        fs.readdirSync(ZIP_DIR).forEach(function (n) {
          if (n.indexOf('archive_' + dayKey) === 0) { try { fs.unlinkSync(path.join(ZIP_DIR, n)); } catch (e) {} }
        });
      } catch (e) {}
      console.log('[reshoot] ' + dayKey + ' 重渲染 ' + (result.ok || 0) + '/' + jobs.length + ' 张');
      resolve({ ok: def(result.ok, 0), failed: def(result.failed, 0), total: jobs.length });
    });
  });
}

// ---------- 管理员登录认证 ----------
// 单管理员账号。密码用 scrypt 加盐哈希存 config/auth.json(不可逆, 不落明文)。
// 会话 token 存内存 Map, 重启即失效(需重新登录); token 经 HttpOnly Cookie 传递, 前端拿不到。
const AUTH_DEFAULT_USER = 'admin';
const VIEWER_DEFAULT_USER = 'viewer'; // 查看用户: 除"管理"(含改密)外所有操作可用
const AUTH_COOKIE = 'di_session';
const AUTH_SESSION_MS = 7 * 24 * 3600 * 1000; // 登录有效期 7 天
const sessions = new Map(); // token -> { exp: 过期时间戳 }
const loginFails = new Map(); // IP -> { n: 失败次数, until: 解封时间 }
let adminAuth = null; // { username, salt, hash }

function scryptHash(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt: salt.toString('hex'), hash: hash };
}
// 生成 16 位随机强密码(大小写字母+数字+符号), 避免任何默认弱口令被安全扫描命中。
function randomStrongPassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',      // 去掉易混淆 I O
    'abcdefghijkmnopqrstuvwxyz',      // 去掉 l
    '23456789',                       // 去掉 0 1
    '!@#$%^&*-_=+?'
  ];
  const all = groups.join('');
  const out = [];
  // 每组至少取一个, 保证复杂度; 其余随机。
  groups.forEach(function (g) { out.push(g[crypto.randomBytes(1)[0] % g.length]); });
  while (out.length < 16) out.push(all[crypto.randomBytes(1)[0] % all.length]);
  // Fisher-Yates 洗牌, 避免前几位总是固定类别
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out.join('');
}
function verifyCredential(entry, user, password) {
  if (!entry || String(user || '').trim() !== entry.username) return false;
  const h = scryptHash(password, entry.salt).hash;
  const a = Buffer.from(h, 'hex'), b = Buffer.from(entry.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// 返回 'admin' / 'viewer' / null, 登录与会话都据此带角色
function verifyUser(user, password) {
  if (!adminAuth) return null;
  if (verifyCredential(adminAuth, user, password)) return 'admin';
  if (verifyCredential(adminAuth.viewer, user, password)) return 'viewer';
  return null;
}
function verifyAdmin(user, password) { return verifyUser(user, password) === 'admin'; }
function initialPasswordBlock(username, password) {
  return '用户名: ' + username + '\r\n' +
    '密  码: ' + password + '\r\n' +
    '------------------------------------------------------------\r\n';
}
function writeInitialPasswordFile(username, password) {
  try {
    const head = '每日巡检留证中心 - 首次登录凭据（随机生成的强密码，仅显示一次）\r\n' +
      '============================================================\r\n';
    const tail = '请登录后立即在「配置管理 → 账号设置」中修改，然后删除本文件。\r\n' +
      '本文件含明文初始密码，请勿外传；删除不影响登录。\r\n';
    const old = fs.existsSync(AUTH_INIT_PASS_PATH) ? fs.readFileSync(AUTH_INIT_PASS_PATH, 'utf8') : '';
    atomicWrite(AUTH_INIT_PASS_PATH, (old ? old.replace(/\r?\n$/, '') + '\r\n' : head) +
      initialPasswordBlock(username, password) + tail);
  } catch (e) { console.error('[auth] 初始密码文件写入失败: ' + e.message); }
}
function loadAdminAuth() {
  try {
    if (!fs.existsSync(AUTH_PATH)) {
      const pass = randomStrongPassword();
      const h = scryptHash(pass, null);
      adminAuth = { username: AUTH_DEFAULT_USER, salt: h.salt, hash: h.hash };
      atomicWrite(AUTH_PATH, JSON.stringify(adminAuth, null, 2));
      writeInitialPasswordFile(AUTH_DEFAULT_USER, pass);
      console.log('[auth] 已生成随机初始管理员密码(非弱口令)。请查看: ' + AUTH_INIT_PASS_PATH);
      console.log('[auth] 登录后立即修改密码并删除该文件。凭据目录: ' + AUTH_PATH + ' (迁移时随 config 一起带走)');
    } else {
      adminAuth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
      if (!adminAuth || !adminAuth.username || !adminAuth.salt || !adminAuth.hash) throw new Error('凭据文件格式不完整');
    }
    // 查看用户: 老凭据文件没有该字段时补一个随机密码, 初始凭据一并写入文件, 管理员可在账号设置里改。
    if (!adminAuth.viewer || !adminAuth.viewer.username || !adminAuth.viewer.salt || !adminAuth.viewer.hash) {
      const pass = randomStrongPassword();
      const h = scryptHash(pass, null);
      adminAuth.viewer = { username: VIEWER_DEFAULT_USER, salt: h.salt, hash: h.hash };
      atomicWrite(AUTH_PATH, JSON.stringify(adminAuth, null, 2));
      writeInitialPasswordFile(VIEWER_DEFAULT_USER, pass);
      console.log('[auth] 已生成随机初始查看用户密码, 请查看: ' + AUTH_INIT_PASS_PATH);
    }
  } catch (e) {
    console.error('[auth] 读取凭据失败, 重建随机管理员密码: ' + e.message);
    const pass = randomStrongPassword();
    const h = scryptHash(pass, null);
    adminAuth = { username: AUTH_DEFAULT_USER, salt: h.salt, hash: h.hash };
    const vp = randomStrongPassword(), vh = scryptHash(vp, null);
    adminAuth.viewer = { username: VIEWER_DEFAULT_USER, salt: vh.salt, hash: vh.hash };
    try { atomicWrite(AUTH_PATH, JSON.stringify(adminAuth, null, 2)); } catch (e2) {}
    writeInitialPasswordFile(AUTH_DEFAULT_USER, pass);
    writeInitialPasswordFile(VIEWER_DEFAULT_USER, vp);
    console.log('[auth] 随机初始密码已写入: ' + AUTH_INIT_PASS_PATH + ' —— 登录后请立即修改!');
  }
}
function saveAdminAuth() {
  atomicWrite(AUTH_PATH, JSON.stringify(adminAuth, null, 2));
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  String(raw).split(';').forEach(function (part) {
    const i = part.indexOf('='); if (i < 0) return;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}
function sessionOf(req) {
  const token = parseCookies(req)[AUTH_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(token); return null; }
  return s;
}
function isAuthed(req) { return !!sessionOf(req); }
function sessionRole(req) {
  const s = sessionOf(req);
  return s ? (s.role || 'admin') : null; // 老会话默认管理员, 避免更新后把自己锁在外面
}
function isAdmin(req) { return sessionRole(req) === 'admin'; }
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------- 访问日志 ----------
// 旧版 server.log 只有启动/登录/巡检完成几行, 出事时查不到"谁在什么时候请求了什么"。
// 这里把每个 HTTP 请求记成一行: 时间/IP/账号/方法/路径/状态码/响应字节/耗时。
// 脱敏: 不记 body / Cookie / 认证 token; query 里只有明确敏感的键替换成 ***。
function accessIp(req) {
  const direct = clientIp(req);
  let fwd = '';
  try {
    const x = req.headers && req.headers['x-forwarded-for'];
    if (x) fwd = String(x).split(',')[0].trim();
  } catch (e) {}
  // 常见 IPv4-mapped IPv6, 收敛成可读的 IPv4
  function clean(ip) { return String(ip || '').replace(/^::ffff:/, ''); }
  if (fwd && clean(fwd) !== clean(direct)) return clean(fwd) + '(' + clean(direct) + ')';
  return clean(direct) || 'unknown';
}
function safeRequestUrl(req) {
  let u = String(req.url || '');
  try {
    const q = u.indexOf('?');
    if (q >= 0) {
      const base = u.slice(0, q);
      const parts = u.slice(q + 1).split('&').map(function (kv) {
        const eq = kv.indexOf('=');
        const k = eq < 0 ? kv : kv.slice(0, eq);
        const v = eq < 0 ? '' : kv.slice(eq + 1);
        if (/^(password|passwd|pwd|token|secret|session|auth)$/i.test(k)) return k + '=***';
        if (/^k$/i.test(k) && v.length > 60) return k + '=<b64:' + v.length + '>'; // /api/t 的 base64 参数
        return v.length > 120 ? k + '=' + v.slice(0, 120) + '…' : kv;
      });
      u = base + '?' + parts.join('&');
    }
  } catch (e) {}
  return u.slice(0, 320);
}
function accessLog(req, res) {
  const t0 = Date.now();
  const ip = accessIp(req);
  const method = String(req.method || 'GET');
  const url = safeRequestUrl(req);
  let bytes = 0;
  function addBytes(chunk, enc) {
    try {
      if (chunk == null) return;
      if (Buffer.isBuffer(chunk)) bytes += chunk.length;
      else {
        const cs = (typeof enc === 'string' && /^(utf8|utf-8|ascii|latin1|binary)$/i.test(enc)) ? enc : 'utf8';
        bytes += Buffer.byteLength(String(chunk), cs);
      }
    } catch (e) {}
  }
  const origWrite = res.write, origEnd = res.end;
  res.write = function (chunk, enc, cb) { addBytes(chunk, enc); return origWrite.apply(this, arguments); };
  res.end = function (chunk, enc, cb) { addBytes(chunk, enc); return origEnd.apply(this, arguments); };
  res.once('finish', function () {
    let who = '-';
    try {
      const s = sessionOf(req);
      if (s) who = String(s.user || '-') + '/' + String(s.role || 'admin');
    } catch (e) {}
    const ms = Date.now() - t0;
    // 自带时间戳: Windows 外部重定向与 Linux 内部文件日志格式保持一致
    console.log('[access] ' + fmtTs(Date.now()) + ' ' + ip + ' ' + who + ' ' + method + ' '
      + url + ' -> ' + (res.statusCode || 0) + ' ' + bytes + 'B ' + ms + 'ms');
  });
}
function loginBlocked(ip) {
  const f = loginFails.get(ip);
  return !!(f && f.until > Date.now());
}
function noteLoginFail(ip) {
  let f = loginFails.get(ip);
  // until=0 表示"从未封禁", 不能当成已过期; 否则每次都重建对象导致计数永远停在1。
  if (!f || (f.until > 0 && f.until <= Date.now())) f = { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } // 连续5次失败封60秒
  loginFails.set(ip, f);
}
function noteLoginOk(ip) { loginFails.delete(ip); }
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(AUTH_SESSION_MS / 1000));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}
function createSession(res, role, username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { exp: Date.now() + AUTH_SESSION_MS,
    role: role || 'admin', username: username || (adminAuth && adminAuth.username) || AUTH_DEFAULT_USER });
  setSessionCookie(res, token);
  return token;
}
function destroySession(req, res) {
  const token = parseCookies(req)[AUTH_COOKIE];
  if (token) sessions.delete(token);
  clearSessionCookie(res);
}
// 登录相关接口(免鉴权白名单)
function handleAuthApi(req, res, parsed) {
  const p = parsed.pathname;
  if (p === '/api/auth/status' && req.method === 'GET') {
    const s = sessionOf(req);
    return sendJSON(res, 200, { authenticated: !!s,
      role: s ? (s.role || 'admin') : null, username: s ? s.username : null });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      console.warn('[auth] 已封禁 IP 的登录尝试: ' + accessIp(req));
      return sendJSON(res, 429, { ok: false, error: '登录失败次数过多, 请 1 分钟后再试' });
    }
    return readBody(req, function (body) {
      let obj = {}; try { obj = JSON.parse(body); } catch (e) {}
      const role = verifyUser(obj.username, obj.password);
      if (role) {
        const uname = String(obj.username || '').trim();
        noteLoginOk(ip);
        createSession(res, role, uname);
        console.log('[auth] 登录成功(' + role + '/' + uname + '): ' + accessIp(req));
        return sendJSON(res, 200, { ok: true, role: role, username: uname });
      }
      noteLoginFail(ip);
      // 只记尝试的用户名, 绝不记密码(避免明文密码落盘)
      console.warn('[auth] 登录失败: ' + accessIp(req) + ' 尝试用户=' + JSON.stringify(String(obj.username || '').slice(0, 60)));
      return sendJSON(res, 401, { ok: false, error: '用户名或密码错误' });
    });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    destroySession(req, res);
    return sendJSON(res, 200, { ok: true });
  }
  if (p === '/api/auth/password' && req.method === 'POST') {
    // 改密属于"管理"功能, 仅管理员可用; 改密后其它会话保持有效(只轮换密码, 不强制踢下线)。
    if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: '仅管理员可修改密码' });
    return readBody(req, function (body) {
      let obj = {}; try { obj = JSON.parse(body); } catch (e) {}
      // 直接校验旧密码哈希(此时已登录, 无需再核对用户名)
      const oldHash = scryptHash(obj.oldPassword || '', adminAuth.salt).hash;
      const a = Buffer.from(oldHash, 'hex'), b = Buffer.from(adminAuth.hash, 'hex');
      if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
        return sendJSON(res, 400, { ok: false, error: '原密码不正确' });
      }
      const np = String(obj.newPassword || '');
      if (np.length < 6) return sendJSON(res, 400, { ok: false, error: '新密码至少 6 位' });
      const h = scryptHash(np, null);
      adminAuth.salt = h.salt; adminAuth.hash = h.hash;
      try { saveAdminAuth(); }
      catch (e) { return sendJSON(res, 500, { ok: false, error: '保存失败: ' + e.message }); }
      // 改密成功后自动删除含明文初始密码的文件, 避免留存在磁盘上被扫描/泄露。
      try { if (fs.existsSync(AUTH_INIT_PASS_PATH)) fs.unlinkSync(AUTH_INIT_PASS_PATH); } catch (e) {}
      console.log('[auth] 管理员密码已修改, 初始密码文件已清理');
      return sendJSON(res, 200, { ok: true });
    });
  }
  if (p === '/api/auth/viewer-password' && req.method === 'POST') {
    if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: '仅管理员可设置查看用户密码' });
    return readBody(req, function (body) {
      let obj = {}; try { obj = JSON.parse(body); } catch (e) {}
      const np = String(obj.password || '');
      if (np.length < 6) return sendJSON(res, 400, { ok: false, error: '新密码至少 6 位' });
      const h = scryptHash(np, null);
      adminAuth.viewer = { username: VIEWER_DEFAULT_USER, salt: h.salt, hash: h.hash };
      try { saveAdminAuth(); }
      catch (e) { return sendJSON(res, 500, { ok: false, error: '保存失败: ' + e.message }); }
      try { if (fs.existsSync(AUTH_INIT_PASS_PATH)) fs.unlinkSync(AUTH_INIT_PASS_PATH); } catch (e) {}
      console.log('[auth] 查看用户密码已修改, 初始密码文件已清理');
      return sendJSON(res, 200, { ok: true, username: VIEWER_DEFAULT_USER });
    });
  }
  return sendJSON(res, 404, { error: 'not found' });
}

// ---------- HTTP ----------
// Win7 老机器经 VPN/安全网关访问时, 响应体里出现字面 `\t` 转义序列会被中间设备
// 判为异常并直接 RST 连接(net::ERR_CONNECTION_RESET)。实测: hostname 等响应
// body 无 `\t` 正常, 只有 mpstat 这类含 TAB 的输出(body 里有 `\t`)被重置。
// 发送前把 TAB/垂直TAB/换页/回车统一换成普通空格, 保证网络字节不出现这些转义。
// 保留 \n(换行对终端原文展示有意义, 且实测无害)。非原地修改, 不污染内存里的
// config / state.results / evidence 数据。
function sanitizeJsonWhitespace(v) {
  if (typeof v === 'string') return v.replace(/[\t\v\f\r]/g, ' ');
  if (Array.isArray(v)) return v.map(sanitizeJsonWhitespace);
  if (v && v.constructor === Object) {
    var o = {};
    Object.keys(v).forEach(function (k) { o[k] = sanitizeJsonWhitespace(v[k]); });
    return o;
  }
  return v;
}
function sendJSON(res, code, obj) {
  var body = JSON.stringify(sanitizeJsonWhitespace(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function serveStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(file);
  const ct = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(p));
}
function readBody(req, cb) {
  // 必须按字节收集后一次性 UTF-8 解码: 中文是 3 字节, 若用 `body += d` 逐分片解码,
  // 跨分片边界的那个字会坏成 U+FFFD(例: "主机与时间" 只剩"机"乱码)。
  const chunks = [];
  req.on('data', function (d) { chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
  req.on('end', function () { cb(Buffer.concat(chunks).toString('utf8')); });
}
// 目录结构已升级为「日期/服务器名称/文件平铺」, 但日期目录没有 00_summary.json
// (升级中途生成、上次巡检未跑完、或旧脚本只写了服务器目录)。此时绝不能误判成
// 旧布局「日期/批次/服务器」——那会把服务器 IP 当批次拆成多行, 并让查看归档拼出
// 日期/服务器/服务器 的不存在路径。这里直接从服务器目录 + manifest.csv 恢复出
// 「一天一行、可展开」的数据结构, 不改原始文件。
// 「汇总缺失·已恢复」最初只在内存里拼数据展示, 磁盘上 00_summary.json / manifest.csv /
// SHA256SUMS 仍是缺失的(删批次后常连清单一起删)。这里把恢复真正落盘: 按现存文件
// 重建三个清单文件, 成功后页面走正常读取路径并显示「已重建」。
// 三个文件本就不在 chattr 锁范围(只锁 .ansi/.txt/.png), 直接写即可; 重建只按
// 目录现状统计, 不触碰任何原始留证文件。每个日期只尝试一次(失败不反复打扰)。
// 重建件的局限(审计须知情): manifest 的 主机/命令ID/命令原文/时间/状态/字节数
// 无法从文件名还原, 一律留空; 命令名称只有文件名里的 24 字截断版。
const metaRepairTried = {};
// 触发方式(manual / scheduled / startup)只写在 00_summary.json 的每批次 trigger 里,
// 文件名 HHMMSS 不含任何触发信息 —— 汇总文件一删, 单看归档目录确实无法判断。
// 但两个旁证可能仍留着记录: ① 执行历史 data/schedule_state.json(内存 sched.history);
// ② evidence/index.db 的 runs 表(run_id = 日期_HHMMSS, 带 trigger, 不会随历史裁剪消失)。
// 都查不到就明确标 'unknown', 绝不按批次时间点反推(定时任务改过时间就不准, 审计上不可靠)。
function recoveredTriggers(day, tags) {
  const out = {};
  tags.forEach(function (t) { out[t] = ''; });
  (sched.history || []).forEach(function (h) {
    if (String(h.date) !== day) return;
    (h.batches || []).forEach(function (b) {
      const tag = String(b.tag || '');
      if (out[tag] !== undefined && !out[tag] && b.trigger) out[tag] = String(b.trigger);
    });
    // 早期的 history 项可能没有 batches 数组: 用 runId 后缀 + 顶层 trigger 兜底
    const rid = String(h.runId || '').split('_');
    const tag2 = rid.length > 1 ? rid.slice(1).join('_') : '';
    if (tag2 && out[tag2] !== undefined && !out[tag2] && h.trigger) out[tag2] = String(h.trigger);
  });
  if (tags.some(function (t) { return !out[t]; })) {
    try {
      const py = detectPython();
      const dbPath = path.join(EVIDENCE_DIR, 'index.db');
      if (py && fs.existsSync(dbPath)) {
        const spec = path.join(DATA_DIR, '_trigspec_' + process.pid + '.json');
        const code = 'import json,sqlite3,sys\n'
          + 'p=json.load(open(sys.argv[1],encoding="utf-8"))\n'
          + 'c=sqlite3.connect(p["db"]).cursor()\n'
          + 'rows=c.execute("SELECT run_id,trigger FROM runs WHERE date=?",(p["day"],)).fetchall()\n'
          + 'print(json.dumps(rows))\n';
        atomicWrite(spec, JSON.stringify({ db: dbPath, day: day }));
        const txt = execFileSync(py, ['-c', code, spec], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
        try { fs.unlinkSync(spec); } catch (e) {}
        JSON.parse(String(txt).trim() || '[]').forEach(function (row) {
          const rid = String(row[0] || '').split('_');
          const tag = rid.length > 1 ? rid.slice(1).join('_') : '';
          if (tag && out[tag] !== undefined && !out[tag] && row[1]) out[tag] = String(row[1]);
        });
      }
    } catch (e) {}
  }
  tags.forEach(function (t) { if (!out[t]) out[t] = 'unknown'; });
  return out;
}
function repairDayMeta(day, dayDir) {
  const sumPath = path.join(dayDir, '00_summary.json');
  const needed = !fs.existsSync(sumPath) || !fs.existsSync(path.join(dayDir, 'manifest.csv'))
    || !fs.existsSync(path.join(dayDir, 'SHA256SUMS'));
  if (!needed) return { repaired: false, needed: false };
  if (metaRepairTried[day]) return { repaired: false, needed: true, skipped: true };
  metaRepairTried[day] = true;
  try {
    const batchStats = {}; // tag -> {ts, servers:{}, commands, shots, rows:[]}
    fs.readdirSync(dayDir).forEach(function (srv) {
      const sub = path.join(dayDir, srv);
      let st; try { st = fs.statSync(sub); } catch (e) { return; }
      if (!st.isDirectory()) return;
      let files; try { files = fs.readdirSync(sub); } catch (e) { return; }
      files.forEach(function (f) {
        // 文件名 = <批次HHMMSS[_n]>_<3位序号>_<服务器名30>_<命令名24>.ansi|.png
        const m = /^(\d{6}(?:_\d+)?)_(\d{3})_(.+)\.(ansi|png)$/i.exec(f);
        if (!m) return;
        const tag = m[1], seq = m[2], rest = m[3], ext = m[4].toLowerCase();
        const b = batchStats[tag] || (batchStats[tag] = { ts: 0, servers: {}, commands: 0, shots: 0, rows: [], rowsByCmd: {} });
        let mt = 0; try { mt = fs.statSync(path.join(sub, f)).mtimeMs; } catch (e) {}
        if (mt && (!b.ts || mt < b.ts)) b.ts = mt;
        b.servers[srv] = 1;
        // 服务器目录名就是完整 serverName; 文件名里的是 fileNamePart(server,30) 截断版
        let cmdName = '';
        if (rest.length > srv.length && rest.indexOf(srv) === 0) cmdName = rest.slice(srv.length + 1);
        else if (rest.indexOf('_') >= 0) cmdName = rest.slice(rest.indexOf('_') + 1);
        // 与正常 manifest 一致: 每条命令一行, .ansi 填「原始文件」列、.png 填「截图文件」列。
        const ck = seq + '|' + srv;
        let row = b.rowsByCmd[ck];
        if (!row) {
          // 末两列为「失败分类/失败原因」: 重建只能从现存文件推断, 留空。
          row = [tag, seq, srv, '', '', cmdName, '', '', '', 0, '', 0, '', '', ''];
          b.rowsByCmd[ck] = row;
          b.rows.push(row);
        }
        if (ext === 'ansi') { b.commands++; row[12] = srv + '/' + f; }
        else { b.shots++; row[10] = srv + '/' + f; }
      });
    });
    const tags = Object.keys(batchStats).sort();
    if (!tags.length) return { repaired: false, needed: true, skipped: true, empty: true };
    const trig = recoveredTriggers(day, tags);
    // 1) manifest.csv: 表头/列位与正常清单完全一致, 可还原列填真实值、不可还原列留空
    const rows = [];
    tags.forEach(function (tag) {
      batchStats[tag].rows.forEach(function (r) { rows.push(r.map(csvCell).join(',')); });
    });
    rows.sort();
    atomicWrite(path.join(dayDir, 'manifest.csv'), '\ufeff' + MANIFEST_HEADER + rows.join('\n') + '\n');
    // 2) 00_summary.json: 结构与正常版对齐; ok/failed 无法从文件名还原, 按 commands/0 计
    const batches = tags.map(function (tag) {
      const b = batchStats[tag];
      return { tag: tag, runId: '', ts: b.ts || 0, trigger: trig[tag] || 'unknown',
        servers: Object.keys(b.servers).length, commands: b.commands,
        ok: b.commands, failed: 0, shots: b.shots, durationMs: 0 };
    });
    const totals = batches.reduce(function (t, b) {
      t.commands += b.commands; t.ok += b.ok; t.failed += b.failed; t.shots += b.shots; return t;
    }, { commands: 0, ok: 0, failed: 0, shots: 0 });
    const allServers = {};
    tags.forEach(function (t) { Object.keys(batchStats[t].servers).forEach(function (s) { allServers[s] = 1; }); });
    let dayTs = 0;
    batches.forEach(function (b) { if (b.ts && (!dayTs || b.ts < dayTs)) dayTs = b.ts; });
    atomicWrite(sumPath, JSON.stringify({
      runId: '', date: day, ts: dayTs, trigger: trig[tags[tags.length - 1]] || 'unknown',
      servers: Object.keys(allServers).length, commands: totals.commands, ok: totals.ok,
      failed: totals.failed, shots: totals.shots, shotFailed: 0, shotError: null,
      durationMs: 0, batches: batches,
      dayCommands: totals.commands, dayOk: totals.ok, dayFailed: totals.failed, dayShots: totals.shots,
      recovered: true, recoveredAt: fmtTs(Date.now()),
      triggerUnknown: tags.filter(function (t) { return trig[t] === 'unknown'; })
    }, null, 2));
    // 3) SHA256SUMS: 全量重算(排除清单自身, writeSha256Sums 已处理)
    writeSha256Sums(dayDir);
    console.log('[evidence] ' + day + ' 清单缺失, 已按现存文件重建 manifest.csv / 00_summary.json / SHA256SUMS');
    return { repaired: true, needed: true };
  } catch (e) {
    console.error('[evidence] ' + day + ' 清单重建失败: ' + e.message);
    return { repaired: false, needed: true, error: e.message };
  }
}
function buildFlatDayWithoutSummary(day, dayDir) {
  const servers = [], fileStats = {};
  fs.readdirSync(dayDir).forEach(function (name) {
    const sub = path.join(dayDir, name);
    let st;
    try { st = fs.statSync(sub); } catch (e) { return; }
    if (!st.isDirectory()) return;
    let files;
    try { files = fs.readdirSync(sub); } catch (e) { return; }
    // 新布局: 服务器目录里直接躺着 .ansi/.png; 旧布局的批次目录里只有服务器子目录。
    if (!files.some(function (f) { return /\.(ansi|txt|png)$/i.test(f); })) return;
    servers.push({ name: name, folder: name,
      pngCount: files.filter(function (f) { return /\.png$/i.test(f); }).length });
    files.forEach(function (f) {
      const m = /^(\d{6}(?:_\d+)?)_\d{3}_/.exec(f);
      if (!m) return;
      const tag = m[1];
      if (!fileStats[tag]) fileStats[tag] = { commands: 0, ok: 0, failed: 0, shots: 0 };
      if (/\.ansi$/i.test(f)) fileStats[tag].commands++;
      if (/\.png$/i.test(f)) fileStats[tag].shots++;
    });
  });
  if (!servers.length) return null;
  let stats = null;
  const mf = path.join(dayDir, 'manifest.csv');
  if (fs.existsSync(mf)) {
    try {
      const fromManifest = {};
      fs.readFileSync(mf, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).forEach(function (l, i) {
        if (!l.trim() || (i === 0 && l.indexOf('批次,') === 0)) return;
        const c = parseManifestLine(l);
        if (c.length < 13) return;
        const tag = String(c[0] || '').trim();
        if (!/^\d{6}(?:_\d+)?$/.test(tag)) return;
        if (!fromManifest[tag]) fromManifest[tag] = { commands: 0, ok: 0, failed: 0, shots: 0 };
        const b = fromManifest[tag];
        b.commands++;
        // 重建件的状态列留空(原始执行状态随清单一起被删, 不可考): 按「已产出留证」计 ok,
        // 与重建 summary 的推定保持一致; 正常清单状态列非空, 此分支不影响它们。
        const stt = String(c[8] || '').trim();
        if (!stt || stt === 'ok') b.ok++; else b.failed++;
        if (String(c[10] || '').replace(/\\/g, '/')) b.shots++;
      });
      if (Object.keys(fromManifest).length) stats = fromManifest;
    } catch (e) {}
  }
  const source = stats || fileStats;
  const batches = Object.keys(source).sort().map(function (tag) {
    const b = source[tag];
    return { tag: tag, label: batchLabel(tag), runId: '', ts: 0, trigger: '',
      servers: servers.length, commands: b.commands, ok: stats ? b.ok : b.commands,
      failed: stats ? b.failed : 0, shots: b.shots };
  });
  const total = batches.reduce(function (t, b) {
    t.commands += b.commands; t.ok += b.ok; t.failed += b.failed; t.shots += b.shots; return t;
  }, { commands: 0, ok: 0, failed: 0, shots: 0 });
  return { key: day, date: day, label: day, recovered: true,
    summary: { dayCommands: total.commands, dayOk: total.ok, dayFailed: total.failed, dayShots: total.shots },
    batches: batches, servers: servers };
}
function handleApi(req, res, parsed) {
  const p = parsed.pathname;
  // 查看用户: 只拦"管理界面"的写操作与"立即巡检", 其余(看板/归档/下载/重出截图/重建索引/刷新)均可操作。
  // 前端隐藏按钮只是体验, 这里是真正的权限边界。
  const mgmtWrite = (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE') && (
    p === '/api/config' || p === '/api/server/test' || p === '/api/schedule/run' ||
    p === '/api/schedule/history' ||
    /^\/api\/run\/[^/]+$/.test(p));
  if (mgmtWrite && sessionRole(req) !== 'admin') {
    const ss = sessionOf(req);
    console.warn('[auth] 权限拒绝: ' + accessIp(req) + ' ' + String((ss && ss.username) || '-') + ' ' + req.method + ' ' + p);
    return sendJSON(res, 403, { ok: false, error: '查看用户无权执行此操作' });
  }
  // 配置
  if (p === '/api/config') {
    // 只下发占位符, 绝不把已保存密码的明文送到浏览器
    if (req.method === 'GET') return sendJSON(res, 200, publicConfig(config));
    if (req.method === 'PUT' || req.method === 'POST') {
      return readBody(req, function (body) {
        try {
          const obj = JSON.parse(body);
          // 审计只记"谁 + 哪些顶层字段", 绝不记 body 内容(可能含新填的密码)。
          const ss = sessionOf(req);
          const keys = obj && obj.__patch ? Object.keys(obj).filter(function (k) { return k !== '__patch'; }) : ['(完整配置)'];
          console.log('[audit] 配置保存: ' + accessIp(req) + ' ' + String((ss && ss.username) || '-')
            + ' ' + (obj && obj.__patch ? '差异提交' : '完整提交') + ' 字段=' + keys.join(','));
          saveConfig(obj); return sendJSON(res, 200, { ok: true });
        }
        catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
      });
    }
  }
  // 测试连接
  if (p === '/api/server/test' && req.method === 'POST') {
    return readBody(req, function (body) {
      let srv; try { srv = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      srv = JSON.parse(JSON.stringify(srv || {}));
      const ssh = srv.ssh || {};
      // 页面只拿到占位符, 测试时用内存中的已存密码还原; 用户刚输入的新密码则原样使用。
      if (ssh.password === PW_MASK || ssh.password === PW_CLEAR || !ssh.password) {
        const old = ((config && config.servers) || []).find(function (x) { return x && x.id === srv.id; });
        ssh.password = (old && old.ssh) ? decryptPassword(old.ssh.password) : '';
      }
      const mode = def(ssh.mode, (srv && (srv.host === 'localhost' || !srv.host)) ? 'local' : 'ssh');
      if (mode === 'demo') return sendJSON(res, 200, { ok: true, message: '模拟模式, 无需连接' });
      return runCommand(srv, { command: 'echo __ins_ok__', timeoutMs: 15000 }).then(function (out) {
        const ok = String(out.raw).indexOf('__ins_ok__') >= 0;
        return sendJSON(res, 200, { ok: ok, message: ok ? '连接成功(可执行远程命令)' : ('返回异常: ' + stripAnsi(out.raw).slice(0, 200)) });
      }).catch(function (e) {
        const cat = classifyFailure(e);
        logCollectFailure('test', srv, { id: 'ping', name: '连接测试' }, cat, e.message);
        return sendJSON(res, 200, { ok: false, error: e.message, errorCategory: cat, errorCategoryText: FAIL_KINDS[cat] });
      });
    });
  }
  // 手动执行单条命令
  let mmRun = p.match(/^\/api\/run\/([^/]+)\/([^/]+)$/);
  if (mmRun && req.method === 'POST') {
    const st = state.get(mmRun[1]); const chk = findCommand(mmRun[2]);
    if (!st || !chk) return sendJSON(res, 404, { error: 'unknown server or command' });
    return collectOne(st, chk).then(function () {
      const e = st.results.get(chk.id);
      return sendJSON(res, 200, { ok: !e.error, latest: e.latest, error: e.error, errorCategory: e.errorCategory || null });
    });
  }
  // 实时状态
  if (p === '/api/status') {
    const servers = []; let crit = 0, warn = 0;
    enabledServers().forEach(function (server) {
      const st = state.get(server.id);
      const checks = commandsForServer(server).map(function (chk) {
        const e = st ? st.results.get(chk.id) : null;
        const val = e && e.latest && e.latest.parsed ? e.latest.parsed.value : null;
        const sev = severityOf(chk, val);
        if (sev === 'critical') crit++; else if (sev === 'warning') warn++;
        return { id: chk.id, name: chk.name, command: chk.command,
          value: val, unit: e && e.latest && e.latest.parsed ? e.latest.parsed.unit : '',
          severity: sev, online: e ? e.online : false, error: e ? e.error : null,
          errorCategory: e ? (e.errorCategory || null) : null,
          ts: e && e.latest ? e.latest.ts : 0, hasRaw: !!(e && e.latest && e.latest.raw) };
      });
      servers.push({ id: server.id, name: server.name, host: server.host, group: server.group || '', checks: checks });
    });
    return sendJSON(res, 200, { summary: { servers: servers.length, critical: crit, warning: warn }, servers: servers, now: Date.now(), platform: process.platform });
  }
  // 单命令结果(原始 ANSI + 历史)
  let mm = p.match(/^\/api\/results\/([^/]+)\/([^/]+)$/);
  if (mm) {
    const st = state.get(mm[1]); if (!st) return sendJSON(res, 404, { error: 'unknown server' });
    const e = st.results.get(mm[2]); if (!e) return sendJSON(res, 404, { error: 'unknown command, 可能尚未采集' });
    const chk = findCommand(mm[2]);
    const pval = e.latest && e.latest.parsed ? e.latest.parsed.value : null;
    const sev = chk ? severityOf(chk, pval) : 'ok';
    // lite=1: 只回最新一次终端原文, 不带 series(最多 2000 点)。
    // 看板前端从不使用 series, 但老浏览器/弱链路(Win7→公网)上大响应容易被重置
    // (net::ERR_CONNECTION_RESET), 被误判成"等待首次采集"。默认行为保持不变,
    // 兼容尚未更新的前端。
    const lite = /(?:^|&)lite=1(?:&|$)/.test(parsed.query || '');
    const out = { id: mm[2], latest: e.latest, online: e.online, error: e.error,
      errorCategory: e.errorCategory || null, severity: sev, value: pval };
    if (!lite) out.series = e.series;
    return sendJSON(res, 200, out);
  }
  // ===== 内网安全设备规避通道 /api/t =====
  // 某些内网环境的安全网关会按 URL 关键词(如 cpu_avg)或响应内容特征对常规
  // /api/results 响应直接 RST(net::ERR_CONNECTION_RESET), 即使响应体已无 \t。
  // 该通道: ① URL 不含命令原文(sid/cid 经 base64url 编码藏在 k 参数);
  // ② 响应体整体是一个 base64 字符串(纯 A-Za-z0-9+/=, 无中文/控制字符/表格文本);
  // ③ no-store + 时间戳参数, 避免透明代理缓存旧响应。前端解码后与 results 等价。
  if (p === '/api/t') {
    var tkv = '', tq = parsed.query || '';
    var kpos = tq.indexOf('k=');
    if (kpos >= 0) tkv = tq.slice(kpos + 2).split('&')[0];
    try {
      var dec = tkv.replace(/-/g, '+').replace(/_/g, '/');
      while (dec.length % 4) dec += '=';
      var pair = JSON.parse(Buffer.from(dec, 'base64').toString('utf8'));
      var tst = state.get(pair[0]);
      var te = tst && tst.results.get(pair[1]);
      if (te) {
        var tchk = findCommand(pair[1]);
        var tpval = te.latest && te.latest.parsed ? te.latest.parsed.value : null;
        var tsev = tchk ? severityOf(tchk, tpval) : 'ok';
        var tpayload = JSON.stringify({ id: pair[1], latest: te.latest, online: te.online, error: te.error,
          errorCategory: te.errorCategory || null, severity: tsev, value: tpval });
        var tb64 = Buffer.from(tpayload, 'utf8').toString('base64');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(tb64));
        return;
      }
    } catch (e) {}
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('{"error":"unknown"}');
    return;
  }
  // 定时任务状态
  if (p === '/api/schedule' && req.method === 'GET') {
    return sendJSON(res, 200, { config: config.schedule, nextRun: sched.nextRun, lastRun: sched.lastRun,
      lastResult: sched.lastResult, running: sched.running, history: sched.history });
  }
  // 删除执行历史(仅改内存中的调度历史与其持久化文件, 不动任何归档留证文件)。
  // body: { runId } 删单条 / { all:true } 清空。仅管理员(见上方 mgmtWrite 拦截)。
  if (p === '/api/schedule/history' && req.method === 'POST') {
    if (!isAdmin(req)) return sendJSON(res, 403, { ok: false, error: '仅管理员可删除执行历史' });
    return readBody(req, function (body) {
      var q = {}; try { q = JSON.parse(body) || {}; } catch (e) {}
      var before = sched.history.length, removed = 0;
      if (q.all === true) {
        removed = sched.history.length;
        sched.history = [];
      } else {
        var runId = String(q.runId || '');
        if (!runId) return sendJSON(res, 400, { ok: false, error: '缺少 runId' });
        var next = sched.history.filter(function (h) { return String(h && h.runId) !== runId; });
        removed = before - next.length;
        sched.history = next;
      }
      // 若删掉的是"上次结果"对应批次, 同步清掉 lastResult, 避免状态卡显示已不存在的批次
      if (sched.lastResult && !sched.history.some(function (h) { return h && h.runId === sched.lastResult.runId; })) {
        sched.lastResult = null;
      }
      persistScheduleState();
      return sendJSON(res, 200, { ok: true, removed: removed, remaining: sched.history.length });
    });
  }
  // 手动触发巡检
  if (p === '/api/schedule/run' && req.method === 'POST') {
    return runInspection('manual').then(function (r) { sendJSON(res, 200, r); });
  }
  // 存储健康: 归档占用/可用空间/索引状态 (每天运行需要观察磁盘)
  if (p === '/api/health' && req.method === 'GET') {
    const di = diskInfo(EVIDENCE_DIR);
    const dbPath = path.join(EVIDENCE_DIR, 'index.db');
    let idx = { exists: false, runs: 0, commands: 0, failed: 0 };
    if (fs.existsSync(dbPath)) {
      idx.exists = true; idx.bytes = fs.statSync(dbPath).size;
      const py = detectPython();
      if (py) {
        try {
          const o = execFileSync(py, [path.join(ROOT, 'scripts', 'index_evidence.py'), '--db', dbPath, '--stats'],
            { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
          const s = JSON.parse(String(o).trim().split('\n').slice(-1)[0]);
          idx.runs = s.runs; idx.commands = s.commands; idx.failed = s.failed;
        } catch (e) {}
      }
    }
    let days = 0, runs = 0;
    try {
      if (fs.existsSync(EVIDENCE_DIR)) {
        fs.readdirSync(EVIDENCE_DIR).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).forEach(function (day) {
          days++;
          const flat = path.join(EVIDENCE_DIR, day, '00_summary.json');
          if (fs.existsSync(flat)) {
            // 新布局: 批次数量记录在当天汇总里, 不能把「服务器名称目录」误算成批次
            try { const s = JSON.parse(fs.readFileSync(flat, 'utf8')); runs += (s.batches && s.batches.length) || 1; }
            catch (e) { runs++; }
          } else {
            // 旧布局: 日期下的子目录即批次
            try { runs += fs.readdirSync(path.join(EVIDENCE_DIR, day)).filter(function (r) { return fs.statSync(path.join(EVIDENCE_DIR, day, r)).isDirectory(); }).length; } catch (e) {}
          }
        });
      }
    } catch (e) {}
    let jsonl = { exists: false, bytes: 0, runs: 0 };
    try {
      const jf = path.join(EVIDENCE_DIR, 'index.jsonl');
      if (fs.existsSync(jf)) {
        jsonl.exists = true; jsonl.bytes = fs.statSync(jf).size;
        jsonl.runs = fs.readFileSync(jf, 'utf8').split('\n').filter(function (x) { return x.trim(); }).length;
      }
    } catch (e) {}
    // 压缩包副本状态(定时压缩产出, 存放 data/zips/)
    let zips = { count: 0, bytes: 0, lastAt: 0 };
    try {
      if (fs.existsSync(ZIP_DIR)) fs.readdirSync(ZIP_DIR).forEach(function (n) {
        if (!/\.zip$/i.test(n)) return;
        const st = fs.statSync(path.join(ZIP_DIR, n));
        zips.count++; zips.bytes += st.size;
        if (st.mtimeMs > zips.lastAt) zips.lastAt = st.mtimeMs;
      });
    } catch (e) {}
    return sendJSON(res, 200, { evidence: { days: days, runs: runs, bytes: di.bytes, files: di.files, free: di.free, total: di.total },
      index: idx, jsonl: jsonl, zips: zips, python: detectPython() || null, retainDays: def(config.settings && config.settings.retainDays, 0),
      ssh: { maxParallel: SSH_MAX_PARALLEL, perHost: SSH_PER_HOST_PARALLEL, retryMax: SSH_RETRY_MAX,
        active: sshActive, waiting: sshWaiters.length },
      password: { status: _secretStatus, keyFile: path.relative(ROOT, SECRET_PATH),
        saved: (config.servers || []).filter(function (s) { return s && s.ssh && s.ssh.password; }).length,
        broken: Object.keys(brokenCipher).length },
      warnings: duplicateHosts() });
  }
  // 历史检索: 走 sqlite 索引, 支持按服务器/状态/日期范围/关键字
  if (p === '/api/evidence/search' && req.method === 'GET') {
    const q = url.parse(req.url, true).query;
    const py = detectPython();
    const dbPath = path.join(EVIDENCE_DIR, 'index.db');
    if (!py || !fs.existsSync(dbPath)) return sendJSON(res, 200, searchJsonlFallback(q));
    const where = []; const params = [];
    if (q.server) { where.push('(c.server_id=? OR c.server_name=?)'); params.push(String(q.server), String(q.server)); }
    if (q.status) { where.push('c.status=?'); params.push(String(q.status)); }
    if (q.from) { where.push('r.date>=?'); params.push(String(q.from)); }
    if (q.to) { where.push('r.date<=?'); params.push(String(q.to)); }
    if (q.q) { where.push('(c.command LIKE ? OR c.command_name LIKE ? OR c.server_name LIKE ?)'); const kw = '%' + q.q + '%'; params.push(kw, kw, kw); }
    // 关联 runs 取 date 与 dir, 便于检索结果直接拼出 /shot/ 图片地址(新旧布局通用)。
    const sql = 'SELECT c.run_id, r.date, r.dir, c.seq, c.server_id, c.server_name, c.host, c.command_id, c.command_name, c.command, c.status, c.bytes, c.png, c.file, c.ts'
      + ' FROM cmds c LEFT JOIN runs r ON r.run_id=c.run_id'
      + (where.length ? (' WHERE ' + where.join(' AND ')) : '') + ' ORDER BY c.ts DESC LIMIT 500';
    // 用 python 执行查询(避免在 Node 里再引入 sqlite 驱动), 通过临时脚本传参
    try {
      const qspec = path.join(DATA_DIR, '_qspec_' + process.pid + '.json');
      atomicWrite(qspec, JSON.stringify({ db: dbPath, sql: sql, params: params }));
      const code = 'import json,sqlite3,sys\n'
        + 'p=json.load(open(sys.argv[1],encoding="utf-8"))\n'
        + 'c=sqlite3.connect(p["db"]).cursor()\n'
        + 'cols=[d[0] for d in c.execute(p["sql"],p["params"]).description]\n'
        + 'rows=[dict(zip(cols,r)) for r in c.execute(p["sql"],p["params"]).fetchall()]\n'
        + 'print(json.dumps(rows))\n';  // 纯ASCII输出: python stdout 编码随平台/locale 变化(Windows常GBK, Linux常UTF-8), 而非ASCII字节被Node按UTF-8解码会乱码; \uXXXX 转义由浏览器/Node 还原, 跨平台一致
      const out = execFileSync(py, ['-c', code, qspec], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
      try { fs.unlinkSync(qspec); } catch (e) {}
      return sendJSON(res, 200, { available: true, source: 'sqlite', rows: JSON.parse(String(out).trim() || '[]') });
    } catch (e) {
      return sendJSON(res, 200, Object.assign(searchJsonlFallback(q), { error: e.message }));
    }
  }
  // 重建索引: 从文件全量重建 sqlite (索引损坏/换机时用)
  if (p === '/api/evidence/reindex' && req.method === 'POST') {
    const py = detectPython();
    if (!py) return sendJSON(res, 200, { ok: false, error: '未找到 Python3(含 sqlite3)' });
    try {
      const dbPath = path.join(EVIDENCE_DIR, 'index.db');
      try { fs.unlinkSync(dbPath); } catch (e) {}
      const out = execFileSync(py, [path.join(ROOT, 'scripts', 'index_evidence.py'), '--db', dbPath, '--rebuild', EVIDENCE_DIR],
        { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
      return sendJSON(res, 200, { ok: true, result: JSON.parse(String(out).trim().split('\n').slice(-1)[0]) });
    } catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  // 重新生成某天的归档截图: 从 .ansi 原始文件按当前设置重渲染 PNG(原始留证不动)
  if (p === '/api/evidence/reshoot' && req.method === 'POST') {
    return readBody(req, function (body) {
      let key = '';
      try { key = String((JSON.parse(body) || {}).key || ''); } catch (e) {}
      reshootDay(key).then(function (r) {
        sendJSON(res, 200, { ok: true, result: r });
      }, function (e) {
        sendJSON(res, 200, { ok: false, error: e.message });
      });
    });
  }
  // 历史留证上锁状态: 一次返回所有日期的 .ansi/.txt/.png 保护情况
  if (p === '/api/evidence/immutable-status' && req.method === 'GET') {
    try { return sendJSON(res, 200, allImmutableStatus()); }
    catch (e) { return sendJSON(res, 200, { ok: false, error: e.message }); }
  }
  // 给某天/某批次(或全部)的旧留证补 chattr +i: 只加保护标记, 不改任何内容
  if (p === '/api/evidence/lock' && req.method === 'POST') {
    return readBody(req, function (body) {
      let q = {};
      try { q = JSON.parse(body) || {}; } catch (e) {}
      const all = q.all === true || q.key === 'all' || q.key === '*';
      const task = all ? lockAllEvidence() : lockEvidenceDay(q.key);
      task.then(function (r) { sendJSON(res, 200, r); },
        function (e) { sendJSON(res, 200, { ok: false, error: e.message }); });
    });
  }
  // 给某天/某批次(或全部)单独解锁: 只解除 chattr +i, 不改文件内容
  if (p === '/api/evidence/unlock' && req.method === 'POST') {
    return readBody(req, function (body) {
      let q = {};
      try { q = JSON.parse(body) || {}; } catch (e) {}
      const all = q.all === true || q.key === 'all' || q.key === '*';
      const task = all ? unlockAllEvidence() : unlockEvidenceDay(q.key);
      task.then(function (r) { sendJSON(res, 200, r); },
        function (e) { sendJSON(res, 200, { ok: false, error: e.message }); });
    });
  }
  // 实时看板: 终端画面 PNG — 复用归档渲染管线(同一套列宽/最大行数/主题/字号设置)。
  // 单张渲染约百毫秒, 同步调用可接受; 返回 PNG 二进制。
  if (p === '/api/render-shot' && req.method === 'POST') {
    return readBody(req, function (body) {
      let q = {};
      try { q = JSON.parse(body) || {}; } catch (e) {}
      const raw = String(q.raw == null ? '' : q.raw);
      if (!raw.trim()) return sendJSON(res, 200, { error: '缺少终端输出内容' });
      const py = detectPython();
      if (!py) return sendJSON(res, 200, { error: '未找到可用的 Python 渲染器' });
      const st = def(config.settings, {});
      const tmpDir = path.join(DATA_DIR, 'tmp');
      const id = 'live_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const ansiPath = path.join(tmpDir, id + '.ansi');
      const pngPath = path.join(tmpDir, id + '.png');
      const jobsPath = path.join(tmpDir, id + '.json');
      const name = String(q.name || 'server');
      const command = String(q.command || '');
      const ts = String(q.ts || fmtTs(Date.now()));
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(ansiPath, raw, 'utf8');
        const fontSetting = def(st.shotFontPath, 'auto');
        const cjkSetting = def(st.shotCjkFontPath, 'auto');
        const spec = {
          font_size: def(st.shotFontSize, 14), theme: def(st.shotTheme, 'dark'),
          terminal_cols: def(st.terminalCols, 132), terminal_lines: def(st.terminalLines, 80),
          font_path: (fontSetting === 'auto' || fontSetting === '') ? fontSetting : toAbs(fontSetting),
          cjk_font_path: (cjkSetting === 'auto' || cjkSetting === '') ? cjkSetting : toAbs(cjkSetting),
          jobs: [{
            ansi_file: ansiPath, png_file: pngPath,
            prompt_line: 'root@' + name + ':~$ ' + command,
            header: 'root@' + name + '  ' + String(q.host || '') + '  |  ' + ts + '  |  ' + command
          }]
        };
        fs.writeFileSync(jobsPath, JSON.stringify(spec), 'utf8');
        execFileSync(py, [path.join(ROOT, 'scripts', 'render_shot.py'), '--jobs', jobsPath],
          { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, env: pythonEnv(py) });
        if (!fs.existsSync(pngPath)) throw new Error('渲染未产出 PNG');
        const buf = fs.readFileSync(pngPath);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="terminal.png"' });
        res.end(buf);
      } catch (e) {
        sendJSON(res, 200, { error: '渲染失败: ' + String(e.message || e).slice(0, 300) });
      } finally {
        [ansiPath, pngPath, jobsPath].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
      }
    });
  }
  // 归档列表: 新布局 = 每天一个目录(子目录即服务器名称); 旧布局 = 日期/批次, 只读兼容不改写。
  if (p === '/api/evidence' && req.method === 'GET') {
    const days = [];
    // 新布局一天一行的组装(正常 summary 与重建后的 summary 共用同一读取路径)
    function pushFlatDay(day, dayDir) {
      let sum = {}; try { sum = JSON.parse(fs.readFileSync(path.join(dayDir, '00_summary.json'), 'utf8')); } catch (e) {}
      const servers = fs.readdirSync(dayDir)
        .filter(function (n) { try { return fs.statSync(path.join(dayDir, n)).isDirectory(); } catch (e) { return false; } })
        .sort().map(function (n) {
          let pngCount = 0;
          try { pngCount = fs.readdirSync(path.join(dayDir, n)).filter(function (f) { return /\.png$/i.test(f); }).length; } catch (e) {}
          return { name: n, folder: n, pngCount: pngCount };
        });
      // 批次明细: 供前端按批次展示/下载; tag 即文件名前缀(HHMMSS[/_n])
      const batches = (sum.batches || []).map(function (b) {
        return { tag: String(b.tag || ''), label: batchLabel(b.tag), runId: b.runId || '', ts: b.ts || 0,
          trigger: b.trigger || '', servers: b.servers, commands: b.commands,
          ok: b.ok, failed: b.failed, shots: b.shots };
      });
      days.push({ key: day, date: day, label: day, summary: sum, batches: batches, servers: servers });
    }
    try {
      if (fs.existsSync(EVIDENCE_DIR)) {
        fs.readdirSync(EVIDENCE_DIR).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).sort().reverse().forEach(function (day) {
          const dayDir = path.join(EVIDENCE_DIR, day);
          if (fs.existsSync(path.join(dayDir, '00_summary.json'))) {
            pushFlatDay(day, dayDir);
          } else {
            // 目录已改成「日期/服务器名称/文件平铺」但缺日期汇总: 先按新布局恢复成一天一行。
            const recovered = buildFlatDayWithoutSummary(day, dayDir);
            if (recovered) {
              // 把恢复真正落盘: 重建三个清单文件; 成功则按正常路径读回(页面显示「已重建」),
              // 失败(只读盘/权限等)才退回纯内存展示(「已恢复」, 不写任何文件)。
              if (repairDayMeta(day, dayDir).repaired) { pushFlatDay(day, dayDir); return; }
              days.push(recovered); return;
            }
            // 兼容更早的旧归档: 日期/批次/服务器id/raw|shots
            fs.readdirSync(dayDir)
              .filter(function (r) { return fs.statSync(path.join(dayDir, r)).isDirectory(); })
              .sort().reverse().forEach(function (rid) {
                let sum = {}; try { sum = JSON.parse(fs.readFileSync(path.join(dayDir, rid, '00_summary.json'), 'utf8')); } catch (e) {}
                const servers = [], seen = {}, mf = path.join(dayDir, rid, 'manifest.csv');
                if (fs.existsSync(mf)) {
                  fs.readFileSync(mf, 'utf8').replace(/^\ufeff/, '').split('\n').slice(1).forEach(function (l) {
                    const c = parseManifestLine(l); if (c.length < 13) return;
                    const folder = String(c[10] || c[12] || '').split('/')[0];
                    if (folder && !seen[folder]) { seen[folder] = 1; servers.push({ name: c[2] || folder, folder: folder, pngCount: 0 }); }
                  });
                }
                days.push({ key: day + '/' + rid, date: day, label: day + ' · ' + rid, summary: sum, servers: servers,
                  batches: [{ tag: rid.split('_')[1] || '', label: batchLabel(rid.split('_')[1] || ''), runId: rid,
                    ts: sum.ts || 0, trigger: sum.trigger || '', servers: sum.servers, commands: sum.commands,
                    ok: sum.ok, failed: sum.failed, shots: sum.shots }] });
              });
          }
        });
      }
    } catch (e) {}
    return sendJSON(res, 200, { days: days });
  }
  // 下载归档压缩包: ?key=日期[或 日期/批次]&batch=批次tag(可选)
  // 优先复用定时压缩预生成的 zip; 源文件比 zip 新时自动重建。zip 只放 data/zips/, 不动原始留证。
  if (p === '/api/evidence/download' && req.method === 'GET') {
    const q = url.parse(req.url, true).query;
    const key = String(q.key || ''), batch = String(q.batch || '');
    const col = collectArchive(key, batch);
    if (!col) return sendJSON(res, 404, { error: '该归档不存在或没有可下载的文件' });
    const zp = zipCachePath(key, batch);
    let zipPath = null, zipBytes = 0, zipName = zipDisplayName(key, batch);
    if (fs.existsSync(zp) && zipIsFresh(zp, col)) {
      zipPath = zp; zipBytes = fs.statSync(zp).size;
    } else {
      const built = buildArchiveZip(key, batch, col);
      if (!built) return sendJSON(res, 500, { error: '压缩包生成失败(需 Python3 环境, 见服务日志)' });
      zipPath = built.path; zipBytes = built.bytes;
    }
    // 安全下载通道 safe=1: 内网安全网关会按响应里的明文内容特征(中文命令名,
    // 例如归档文件名里的 "CPU平均时间")或新建连接上的二进制流直接 RST。
    // 与 /api/t 规避通道同一思路 —— 把 zip 整体 base64 成纯 ASCII 文本再发,
    // 网络字节流只剩 A-Za-z0-9+/=, 没有中文/命令名/TAB/二进制特征; 也不发
    // Content-Disposition(里面一长串 %XX 编码同样容易被误判)。前端解码还原成 Blob。
    if (String(q.safe || '') === '1') {
      const b64 = fs.readFileSync(zipPath).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=us-ascii',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(b64, 'ascii')
      });
      res.end(b64);
      return;
    }
    // 中文文件名用 filename* 传递(RFC 5987), filename 给 ASCII 兜底(老前端/直接下载)
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': "attachment; filename=\"archive.zip\"; filename*=UTF-8''" + encodeURIComponent(zipName),
      'Content-Length': zipBytes
    });
    fs.createReadStream(zipPath).pipe(res);
    return;
  }
  // 直接返回归档 PNG 图片 (供 <img> 展示), 路径限 evidence 目录内
  if (p.indexOf('/shot/') === 0 && req.method === 'GET') {
    let rel = p.slice('/shot/'.length).replace(/^\/+/, '');
    rel = decodeURIComponent(rel).replace(/\\/g, '/').replace(/^(\.\.\/)+/, '');
    const full = path.resolve(EVIDENCE_DIR, rel.replace(/\//g, path.sep));
    if (full.indexOf(path.resolve(EVIDENCE_DIR)) !== 0 || !fs.existsSync(full) || !fs.statSync(full).isFile() || path.extname(full).toLowerCase() !== '.png') {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res); return;
  }
  // 直接列出某服务器目录内的 PNG (归档页以磁盘文件为准, 不依赖 manifest.csv 的列格式)
  if (p === '/api/evidence/shots' && req.method === 'GET') {
    const q = url.parse(req.url, true).query;
    const rootAbs = path.resolve(EVIDENCE_DIR);
    const key = String(q.key || '').replace(/\\/g, '/').replace(/^(\.\.\/)+/, '').replace(/^\/+/, '');
    const folder = String(q.folder || '').replace(/[\\/]/g, '');
    if (!folder) return sendJSON(res, 400, { error: 'folder required' });
    const base = path.resolve(rootAbs, key.replace(/\//g, path.sep));
    if (base.indexOf(rootAbs) !== 0 || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      return sendJSON(res, 404, { error: 'archive not found' });
    }
    // 新布局: 日期/服务器名/*.png ; 旧布局: 日期/批次/服务器id/shots|raw/*.png
    let dir = '';
    [path.join(base, folder), path.join(base, folder, 'shots'), path.join(base, folder, 'raw')].some(function (d) {
      if (fs.existsSync(d) && fs.statSync(d).isDirectory()) { dir = d; return true; }
      return false;
    });
    if (!dir || dir.indexOf(rootAbs) !== 0) return sendJSON(res, 200, { shots: [] });
    const shots = fs.readdirSync(dir).filter(function (f) { return /\.png$/i.test(f); }).sort().map(function (f) {
      const full = path.join(dir, f);
      return { name: f, rel: path.relative(rootAbs, full).replace(/\\/g, '/'), bytes: fs.statSync(full).size };
    });
    return sendJSON(res, 200, { shots: shots, dir: path.relative(rootAbs, dir).replace(/\\/g, '/') });
  }
  // 读取归档文件(预览/截图数据)
  if (p === '/api/evidence/read' && req.method === 'GET') {
    const q = url.parse(req.url, true).query;
    let rel = String(q.file || '');
    rel = rel.replace(/\\/g, '/').replace(/^(\.\.\/)+/, '');
    const full = path.join(EVIDENCE_DIR, rel);
    if (full.indexOf(path.resolve(EVIDENCE_DIR)) !== 0 || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return sendJSON(res, 404, { error: 'file not found' });
    }
    const ext = path.extname(full).toLowerCase();
    if (ext === '.json') {
      try { return sendJSON(res, 200, { json: JSON.parse(fs.readFileSync(full, 'utf8')) }); }
      catch (e) { return sendJSON(res, 200, { text: fs.readFileSync(full, 'utf8') }); }
    }
    return sendJSON(res, 200, { text: fs.readFileSync(full, 'utf8') });
  }
  return sendJSON(res, 404, { error: 'not found' });
}
// ---------- 单实例锁 ----------
// 每天运行最怕重复启动: 两套进程会同时巡检、写同一批归档、互相覆盖索引。
// data/server.lock 记录 pid; 陈旧锁(pid 已不存在)自动接管, Windows/Linux 通用。
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
function pidAlive(pid) {
  if (!pid || !isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function acquireInstanceLock() {
  try {
    // 新部署/清理过 data 目录时先建好, 否则锁文件写入失败会导致服务直接退出。
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOCK_FILE)) {
      let old = null;
      try { old = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e) {}
      if (old && old.pid !== process.pid && pidAlive(old.pid)) {
        console.error('[main] 已有巡检中心在运行 (PID ' + old.pid + ', 启动于 ' + def(old.ts, '?') + ')');
        console.error('[main] 请勿重复启动; 需重启请先停止旧进程, 或删除锁文件: ' + LOCK_FILE);
        return false;
      }
      try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: fmtTs(Date.now()) }), { flag: 'wx' });
    return true;
  } catch (e) {
    console.error('[main] 单实例锁获取失败: ' + e.message);
    return false;
  }
}
function releaseInstanceLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return;
    const o = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (o.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (e) {}
}

// ---------- JSONL 兜底索引 ----------
// SQLite 依赖 Python3; 若中心机没有 Python 或索引写入失败, 仍把本批次元数据
// 追加到 evidence/index.jsonl, 保证检索能力不丢。原始留证文件永远是权威数据。
function appendJsonlIndex(spec) {
  try {
    fs.appendFileSync(path.join(EVIDENCE_DIR, 'index.jsonl'), JSON.stringify(spec) + '\n', 'utf8');
    console.warn('[index] 已写入 JSONL 兜底索引 evidence/index.jsonl');
  } catch (e) { console.error('[index] JSONL 兜底写入失败: ' + e.message); }
}
// SQLite 不可用时的检索回退: 从 index.jsonl 展开 cmds 并按同样条件过滤。
function searchJsonlFallback(q) {
  const f = path.join(EVIDENCE_DIR, 'index.jsonl');
  if (!fs.existsSync(f)) return { available: false, rows: [], reason: '索引不可用(缺 Python3 或 index.db), 且无 JSONL 兜底' };
  const rows = [];
  try {
    fs.readFileSync(f, 'utf8').split('\n').forEach(function (line) {
      if (!line.trim()) return;
      let spec; try { spec = JSON.parse(line); } catch (e) { return; }
      const run = spec.run || {};
      (spec.rows || []).forEach(function (r) {
        rows.push({ run_id: run.run_id, date: run.date, dir: run.dir || run.date,
          seq: r.seq, server_id: r.server_id,
          server_name: r.server_name, host: r.host, command_id: r.command_id,
          command_name: r.command_name, command: r.command, status: r.status,
          bytes: r.bytes, png: r.png, file: r.file, ts: r.ts });
      });
    });
  } catch (e) { return { available: false, rows: [], reason: e.message }; }
  function qv(k) { return q[k] ? String(q[k]) : ''; }
  const filtered = rows.filter(function (r) {
    if (qv('server') && r.server_id !== qv('server') && r.server_name !== qv('server')) return false;
    if (qv('status') && r.status !== qv('status')) return false;
    if (qv('from') && String(def(r.date, '')) < qv('from')) return false;
    if (qv('to') && String(def(r.date, '')) > qv('to')) return false;
    if (qv('q')) {
      const kw = qv('q').toLowerCase();
      if ((String(def(r.command, '')) + ' ' + String(def(r.command_name, '')) + ' ' + String(def(r.server_name, ''))).toLowerCase().indexOf(kw) < 0) return false;
    }
    return true;
  }).sort(function (a, b) { return (def(b.ts, 0) - def(a.ts, 0)); }).slice(0, 500);
  return { available: true, source: 'jsonl', rows: filtered };
}

function startServer() {
  const server = http.createServer(function (req, res) {
    accessLog(req, res); // 每个请求的 IP/账号/方法/路径/状态/耗时写入 server.log
    // 安全响应头: 满足安全演练/等保扫描常见检查项
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Cache-Control', 'no-store');
    const parsed = url.parse(req.url);
    const p = parsed.pathname;
    // 白名单: 登录接口 + 登录页及其静态资源(未登录也要能打开登录页)。
    if (p.indexOf('/api/auth/') === 0) return handleAuthApi(req, res, parsed);
    if (p === '/login.html' || p === '/login.js' || p === '/login.css' || p === '/favicon.ico' || p === '/icons.svg') {
      return serveStatic(res, p.replace(/^\//, ''));
    }
    // 其余全部需登录: API 返回 401(前端据此跳登录页), 页面返回 302 到登录页, 截图图片返回 401。
    if (!isAuthed(req)) {
      if (p.indexOf('/api/') === 0 || p.indexOf('/shot/') === 0) {
        return sendJSON(res, 401, { error: '未登录', authRequired: true });
      }
      res.writeHead(302, { 'Location': '/login.html' });
      return res.end();
    }
    if (p.indexOf('/api/') === 0 || p.indexOf('/shot/') === 0) return handleApi(req, res, parsed);
    if (p === '/' || p === '') return serveStatic(res, 'index.html');
    return serveStatic(res, p.replace(/^\//, ''));
  });
  // Node 默认 keepAliveTimeout 仅 5 秒: Win7 老浏览器会复用已被服务端关闭的连接,
  // 下一次请求直接收到 RST(net::ERR_CONNECTION_RESET), 表现就是"部分请求莫名失败"。
  // 放宽到 2 分钟(headersTimeout 必须大于 keepAliveTimeout)。
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  const port = def(config.listenPort, 8082);
  function tryListen(p) {
    server.listen(p, function () {
      config.listenPort = p;
      console.log('[main] 巡检中心已启动: http://localhost:' + p);
      var _pollMs = def(config.settings && config.settings.pollIntervalMs, 86400000);
      console.log('[main] 服务器数: ' + enabledServers().length + ', 命令清单: ' + enabledCommands().length +
        ', 实时轮询: ' + (_pollMs <= 0 ? '已关闭(仅定时巡检采集)' : (_pollMs / 60000) + ' 分钟'));
      console.log('[main] 定时任务: ' + (def(config.schedule && config.schedule.enabled, true) ? ('启用, ' + def(config.schedule.mode, 'daily') + ' ' + def(config.schedule.time, '02:00') + ', 下次 ' + (sched.nextRun ? fmtTs(sched.nextRun) : '-')) : '未启用'));
      console.log('[main] 归档目录: ' + EVIDENCE_DIR);
      if (def(config.schedule && config.schedule.runOnStart, false)) setTimeout(function () { runInspection('startup'); }, 3000);
    });
    server.on('error', function (e) {
      if (e.code === 'EADDRINUSE') { console.warn('[main] 端口 ' + p + ' 被占用, 尝试 ' + (p + 1)); tryListen(p + 1); }
      else { console.error('[main] 启动失败: ' + e.message); process.exit(1); }
    });
  }
  tryListen(port);
}
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 14) console.warn('[提示] Node ' + process.versions.node + ' 版本偏低, 建议 Node 14+ (Win7 可用 18.16.0)。');
}

function main() {
  installFileLogger(); // Linux: 把 console 同步写入 logs/server.log
  // 固定工作目录到程序根目录: 保证从任意 cwd 启动, 相对路径/子进程/归档都一致。
  // 这使整个目录可拷到任意位置部署, 不依赖启动时所在的目录。
  try { process.chdir(ROOT); } catch (e) { console.error('[main] 切换工作目录失败: ' + e.message); }
  checkNodeVersion();
  loadConfig();
  loadAdminAuth();
  logDuplicateWarnings();
  if (!acquireInstanceLock()) process.exit(1);
  process.on('exit', releaseInstanceLock);
  rebuildState();
  restoreLocal();
  restoreFromEvidence();
  reparseCachedResults(); // data/*.json 里可能存着旧忽略规则解析出的 df 数值, 按当前配置重算
  loadScheduleState();
  startServer();
  setInterval(tick, TICK_MS);
  setInterval(scheduleTick, TICK_MS);
  setInterval(zipTick, 30 * 60000);                 // 定时压缩: 每 30 分钟补齐未压缩的历史日期
  setTimeout(zipTick, 15000);                       // 启动后 15 秒先压一轮(避开启动高峰)
  function shutdown() { console.log('\n[main] 退出中...'); releaseInstanceLock(); setTimeout(function () { process.exit(0); }, 300); }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
if (require.main === module) main();

// 供离线自检使用; 正常启动不会走到这里。
module.exports = {
  _test: {
    takeSshSlot: takeSshSlot, releaseSshSlot: releaseSshSlot,
    isTransientSshError: isTransientSshError, sshErrorHint: sshErrorHint,
    duplicateHosts: duplicateHosts, runCommand: runCommand, loadConfig: loadConfig,
    encryptPassword: encryptPassword, decryptPassword: decryptPassword, getSecret: getSecret,
    publicConfig: publicConfig, mergeSavedPasswords: mergeSavedPasswords,
    resolveToolPath: resolveToolPath, passwordTool: passwordTool,
    buildSshInvocation: buildSshInvocation, maskSshSecrets: maskSshSecrets,
    severityOf: severityOf, normalizeAlerts: normalizeAlerts, DEFAULT_ALERTS: DEFAULT_ALERTS,
    parseDf: parseDf, dfRowIgnored: dfRowIgnored, reparseCachedResults: reparseCachedResults,
    chattrBatch: chattrBatch, evidenceArtifactFiles: evidenceArtifactFiles,
    immutableStatus: immutableStatus, immutableStatusAll: allImmutableStatus,
    evidenceDirOfKey: evidenceDirOfKey, lockEvidenceDay: lockEvidenceDay, lockAllEvidence: lockAllEvidence,
    unlockEvidenceDay: unlockEvidenceDay, unlockAllEvidence: unlockAllEvidence,
    withImmutDay: withImmutDay,
    buildFlatDayWithoutSummary: buildFlatDayWithoutSummary, parseManifestLine: parseManifestLine,
    classifyFailure: classifyFailure, FAIL_KINDS: FAIL_KINDS, manifestRow: manifestRow, runInspection: runInspection,
    safeRequestUrl: safeRequestUrl, accessIp: accessIp, accessLog: accessLog, logCollectFailure: logCollectFailure,
    repairDayMeta: repairDayMeta, recoveredTriggers: recoveredTriggers,
    handleApi: handleApi, EVIDENCE_DIR: EVIDENCE_DIR, sched: sched, persistScheduleState: persistScheduleState,
    saveConfig: saveConfig, pylibDir: pylibDir, pythonEnv: pythonEnv, detectRenderer: detectRenderer,
    restoreFromEvidence: restoreFromEvidence, rebuildState: rebuildState, state: state,
    setConfig: function (c) { config = c; },
    // 登录认证自检
    loadAdminAuth: loadAdminAuth, verifyAdmin: verifyAdmin, verifyUser: verifyUser, scryptHash: scryptHash,
    randomStrongPassword: randomStrongPassword,
    isAuthed: isAuthed, sessionOf: sessionOf, sessionRole: sessionRole, isAdmin: isAdmin,
    parseCookies: parseCookies, createSession: createSession,
    handleAuthApi: handleAuthApi, sessions: sessions, AUTH_COOKIE: AUTH_COOKIE,
    getAdminAuth: function () { return adminAuth; },
    PW_MASK: PW_MASK, PW_CLEAR: PW_CLEAR, PW_ENC_PREFIX: PW_ENC_PREFIX,
    installFileLogger: installFileLogger, LOG_PATH: LOG_PATH,
    sshState: function () { return { active: sshActive, waiting: sshWaiters.length, hosts: sshHostActive }; }
  }
};

/* 每日巡检留证中心 - 前端逻辑 (原生 JS, 零依赖, 兼容 Firefox 115 ESR) */

// 统一请求封装: 401(会话过期/未登录) 立即跳登录页, 避免停留在已失效的界面上。
function apiFetch(p, opt) {
  return fetch(p, opt).then(function (r) {
    if (r.status === 401) { try { location.replace('/login.html'); } catch (e) {} throw new Error('未登录'); }
    return r.json();
  });
}
var api = {
  get: function (p) { return apiFetch(p, { method: 'GET' }); },
  put: function (p, b) { return apiFetch(p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); },
  post: function (p, b) { return apiFetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); }
};
// 图标 helper: 引用静态 icons.svg 雪碧图(线性 SVG)。
// Win7 + Firefox 115 ESR 缺彩色 emoji 字体, emoji 会显示成黑白轮廓/豆腐块, 统一改用 SVG。
function ico(name, cls) {
  var h = 'icons.svg#' + name;
  return '<svg class="ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="' + h + '" xlink:href="' + h + '"></use></svg>';
}
// 非模态角标提示: 原生 alert/confirm 偶尔会弹到浏览器窗口后面, 对话框仍在但看不见,
// 整页被锁住点不动(尤其 Win7 + Firefox ESR)。耗时操作一律改用这个, 不拦截点击。
// key 相同的新提示直接替换旧提示, 避免连点刷新时右侧叠一摞;
// 同时全局最多留 4 条, 再多就从最旧的开始淘汰。
function showToast(msg, ms, key) {
  var box = document.getElementById('toastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toastBox';
    box.className = 'toast-box';
    document.body.appendChild(box);
  }
  if (key) {
    var old = box.querySelector('[data-toast-key="' + key + '"]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  var el = document.createElement('div');
  el.className = 'toast';
  if (key) el.setAttribute('data-toast-key', key);
  el.textContent = msg;
  el.title = '点击关闭';
  el.onclick = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  box.appendChild(el);
  while (box.children.length > 4) box.removeChild(box.firstChild);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms || 6000);
}
// 页面内二次确认: 取代原生 confirm(位置在浏览器顶端且样式不可控, 藏到窗口后面还会锁死页面)。
// 小面板锚定在触发按钮下方, 非模态, 点空白/Esc 取消, 确认后才执行。
function askConfirm(opt) {
  var prev = document.getElementById('inlineConfirm');
  if (prev) { if (prev._cleanup) prev._cleanup(); if (prev.parentNode) prev.parentNode.removeChild(prev); }
  var anchor = opt.anchor, box = document.createElement('div');
  box.id = 'inlineConfirm';
  box.className = 'confirm-pop' + (opt.danger ? ' danger' : '');
  box.innerHTML = '<div class="confirm-title">' + esc(opt.title || '请确认') + '</div>' +
    '<div class="confirm-body">' + esc(opt.message || '') + '</div>' +
    '<div class="confirm-actions">' +
      '<button type="button" class="btn tiny ghost" data-act="cancel">' + esc(opt.cancelText || '取消') + '</button>' +
      '<button type="button" class="btn tiny primary" data-act="ok">' + esc(opt.okText || '确定') + '</button>' +
    '</div>';
  document.body.appendChild(box);
  function cleanup() {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (box.parentNode) box.parentNode.removeChild(box);
  }
  function onOutside(e) { if (!box.contains(e.target)) cleanup(); }
  function onKey(e) { if (e.key === 'Escape' || e.keyCode === 27) cleanup(); }
  box._cleanup = cleanup;
  var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 20, bottom: 70, top: 70 };
  var left = Math.max(12, Math.min(r.left, window.innerWidth - box.offsetWidth - 12));
  var top = r.bottom + 8;
  if (top + box.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - box.offsetHeight - 8);
  box.style.left = left + 'px';
  box.style.top = top + 'px';
  box.querySelector('[data-act="cancel"]').onclick = cleanup;
  box.querySelector('[data-act="ok"]').onclick = function () { cleanup(); if (opt.onOk) opt.onOk(); };
  setTimeout(function () {
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

// 终端原文缓存 + 弱链路容错:
// 老浏览器(Win7)经公网访问时, /api/results 的响应会被中间安全设备按 URL 关键词
// (如 cpu_avg)或内容特征直接重置(net::ERR_CONNECTION_RESET), 导致明明已采集却显示
// "等待首次采集"。这里改走 /api/t 规避通道: URL 不含命令原文(sid/cid 经 base64url
// 编码), 响应体整体是 base64(纯字母数字); 前端解码还原。同时用 status 的 check.ts
// 判断是否有新数据, 没更新就复用缓存, 每轮 N 个请求可降为 0; 失败延迟重试一次。
var RESULT_CACHE = {};
// base64url 编码 sid/cid -> k (纯 A-Za-z0-9-_)
function encKey(sid, cid) {
  var s = JSON.stringify([sid, cid]);
  var b;
  try { b = btoa(unescape(encodeURIComponent(s))); } catch (e) { b = btoa(s); }
  return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 服务端返回的是 base64(JSON) 字符串, 解码还原为对象
function decTerm(b64) {
  var bin = atob(b64), i, bytes = new Uint8Array(bin.length);
  for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var txt;
  if (typeof TextDecoder !== 'undefined') txt = new TextDecoder('utf-8').decode(bytes);
  else txt = decodeURIComponent(escape(bin));
  return JSON.parse(txt);
}
function fetchTerm(sid, cid) {
  return apiFetch('/api/t?k=' + encKey(sid, cid) + '&_=' + Date.now(), { method: 'GET' }).then(decTerm);
}
function fetchResult(sid, cid, ts) {
  var key = sid + '/' + cid;
  var hit = RESULT_CACHE[key];
  if (hit && hit.ts === ts && hit.data && hit.data.latest) return Promise.resolve({ s: hit.data, cached: true });
  function once() {
    return fetchTerm(sid, cid);
  }
  return once().catch(function () {
    return new Promise(function (resolve) { setTimeout(function () { resolve(once()); }, 500); });
  }).then(function (r) {
    if (r && r.latest) RESULT_CACHE[key] = { ts: ts, data: r };
    return { s: r, cached: false };
  }).catch(function () {
    // 两次都失败: 有旧内容就继续显示, 否则区分"未采集"与"加载失败"。
    if (hit && hit.data) return { s: hit.data, cached: true, failed: true };
    return { s: null, cached: false, failed: true };
  });
}

var CFG = null, CFG_BASE = null, STATUS = null, SCHED = null, AUTH = null, currentCmd = null, currentView = 'live';
function isAdmin() { return !AUTH || AUTH.role === 'admin'; } // AUTH 未取到时按管理员处理, 避免误锁界面
var refreshTimer = null, lastStatusSig = ''; // 页面自动刷新定时器 + 上次已渲染的状态指纹
var refreshToast = { count: 0, sig: '' }; // 手动刷新提示: 同一批无变化数据只更新计数, 不叠吐司
var detailCtx = { name: '', host: '', command: '', ts: 0, raw: '' };
// 连续新增时插到上一次新增的卡片后面, 并自动滚动/聚焦, 避免每次回顶部点按钮。
var lastAddedCmdId = null, lastAddedSrvId = null;
// 密码只以占位符下发: __SAVED__=已加密保存(留空不修改), __CLEAR__=标记清除。
var PW_SAVED = '__SAVED__', PW_CLEAR = '__CLEAR__';

function def(v, d) { return (v === undefined || v === null) ? d : v; }
function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
// 采集失败分类(与 server.js FAIL_KINDS 保持一致): 让"登录失败"和"文件权限"一眼可分
var FAIL_KINDS = {
  auth: '登录/认证失败', permission: '目标机文件权限不足', write: '本机写归档失败',
  timeout: '连接/命令超时', network: '网络不通或连接被重置', tool: '采集工具不可用',
  command: '远程命令执行报错', unknown: '其他原因'
};
function failKindText(c) { return FAIL_KINDS[c] || '其他原因'; }
function r1(x) { return (x == null) ? '-' : (Math.round(x * 10) / 10); }
function fmtTs(ts) { if (!ts) return '-'; var d = new Date(ts); function p(n){return (n<10?'0':'')+n;} return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }

// ---------------- ANSI -> HTML ----------------
var ANSI_FG = { 30:'#000',31:'#f87171',32:'#4ade80',33:'#facc15',34:'#60a5fa',35:'#c084fc',36:'#22d3ee',37:'#e2e8f0',
  90:'#94a3b8',91:'#fca5a5',92:'#86efac',93:'#fde047',94:'#93c5fd',95:'#d8b4fe',96:'#67e8f9',97:'#fff' };
var ANSI_BG = { 40:'#000',41:'#7f1d1d',42:'#14532d',43:'#713f12',44:'#1e3a8a',45:'#581c87',46:'#164e63',47:'#e2e8f0' };

function ansiToHtml(text) {
  text = def(text, '');
  var out = '', fg = null, bg = null, bold = false, i = 0;
  function wrap(t) {
    var style = '';
    if (fg) style += 'color:' + fg + ';';
    if (bg) style += 'background:' + bg + ';';
    if (bold) style += 'font-weight:bold;';
    return style ? '<span style="' + style + '">' + esc(t) + '</span>' : esc(t);
  }
  while (i < text.length) {
    var c = text.charAt(i);
    if (c === '\x1b' && text.charAt(i + 1) === '[') {
      var j = i + 2;
      while (j < text.length && !/[A-Za-z]/.test(text.charAt(j))) j++;
      var code = text.substring(i + 2, j), cmd = text.charAt(j);
      if (cmd === 'm') {
        var nums = code === '' ? [0] : code.split(';').map(function (x) { return parseInt(x, 10) || 0; });
        nums.forEach(function (n) {
          if (n === 0) { fg = null; bg = null; bold = false; }
          else if (n === 1) bold = true;
          else if (ANSI_FG[n]) fg = ANSI_FG[n];
          else if (ANSI_BG[n]) bg = ANSI_BG[n];
          else if (n === 39) fg = null;
          else if (n === 49) bg = null;
        });
      }
      i = j + 1; continue;
    }
    out += wrap(c); i++;
  }
  return out;
}
function cleanAnsi(text) { return String(def(text, '')).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); }
// 没有单一数值的命令(hostname/mysql/oracle/日志等自定义命令): 从原始输出提取
// 前几行有效文本做摘要, 让看板卡片一眼能看出采到了什么, 而不是空白。
function plainSummary(raw, cmdLine) {
  var text = cleanAnsi(raw).replace(/\r/g, '');
  var lines = text.split('\n');
  var cmd = String(def(cmdLine, '')).trim();
  var out = [];
  for (var i = 0; i < lines.length && out.length < 2; i++) {
    var ln = lines[i].trim();
    if (!ln) continue;
    // 跳过命令回显行(prompt 或恰好等于命令行), 只保留真正的输出
    if (cmd && ln.indexOf(cmd) >= 0) continue;
    if (/^(root@|\[?[^\s]+@[^\s]+[:#\$>]|#\s)/.test(ln)) continue;
    out.push(ln.length > 60 ? ln.slice(0, 60) + '…' : ln);
  }
  return out.join(' · ');
}

// ---------------- 启动 ----------------
async function boot() {
  bindEvents();
  try {
    // 并行拉取, 不再串行 await: Chromium 对每轮新请求的连接开销比 Firefox 高,
    // 串起来会被放大成明显卡顿; 并行后总耗时取最慢的一轮而非累加。
    var pair = await Promise.all([api.get('/api/config'), api.get('/api/status'), api.get('/api/auth/status')]);
    CFG = pair[0]; STATUS = pair[1]; AUTH = pair[2];
    // 保存基线: 保存配置时只上传与它不同的字段, 不把整套命令清单/服务器清单反复传到网络上。
    CFG_BASE = JSON.parse(JSON.stringify(CFG));
    applyRole();
    updateConnStatus(STATUS); // 关掉自动刷新后, 首屏状态必须在这里就更新, 不能只等手动刷新
    renderTabs();
    if ((CFG.commands || []).length) selectCmd(CFG.commands[0].id);
  } catch (e) { console.error('初始化失败:', e); setConnFailed(); }
  refreshSchedule();
  applyUiRefresh();
}
// 查看用户: 隐藏「立即巡检」入口;「配置管理」入口故意保留可见(显得平台有东西),
// 但 switchView 会拦截进入, 服务端敏感接口也返回 403。只是"看得到、进不去"。
function applyRole() {
  var admin = isAdmin();
  var runBtn = document.getElementById('btnRunNow');
  if (runBtn) runBtn.hidden = !admin;
  var lo = document.getElementById('btnLogout');
  if (lo && AUTH && AUTH.username) lo.title = '退出登录（' + AUTH.username + '）';
}
// 页面自动刷新(只重绘, 不触发后端采集): 与 settings.pollIntervalMs 完全独立。
// 0=彻底关闭; 老配置没有该字段也按关闭处理, 不再强制 5 秒重绘。
function applyUiRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  var ms = parseInt((CFG && CFG.settings && CFG.settings.uiRefreshMs), 10);
  if (isNaN(ms) || ms <= 0) return;
  if (ms < 1000) ms = 1000;
  refreshTimer = setInterval(function () { refresh(false); }, ms);
}
// 用状态指纹跳过无变化重绘: 即便开了自动刷新, 只要数据没变就不碰 DOM,
// 避免终端内容被重建导致复制中断/页面闪烁。
function statusSignature(s) {
  var parts = [];
  ((s && s.servers) || []).forEach(function (srv) {
    (srv.checks || []).forEach(function (c) {
      parts.push(srv.id + ':' + c.id + ':' + (c.ts || 0) + ':' +
        (c.value == null ? '' : c.value) + ':' + (c.severity || '') + ':' +
        (c.online ? 1 : 0) + ':' + String(c.error || ''));
    });
  });
  var sum = (s && s.summary) || {};
  parts.push(sum.servers || 0, sum.critical || 0, sum.warning || 0);
  return parts.join('|');
}
function selectionInContent() {
  try {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return false;
    var content = document.getElementById('content');
    var node = sel.anchorNode;
    if (!content || !node) return false;
    return content.contains(node.nodeType === 3 ? node.parentNode : node);
  } catch (e) { return false; }
}
// 顶栏状态: "能否连上"和"指标是否告警"是两回事, 必须分开显示。
// 一台服务器只要有一条命令采集成功就算在线; 全部命令都失败才算离线。
function connStats(s) {
  var servers = (s && s.servers) || [];
  var online = 0;
  servers.forEach(function (srv) {
    if (((srv && srv.checks) || []).some(function (c) { return c.online === true; })) online++;
  });
  var sum = (s && s.summary) || {};
  return { total: servers.length, online: online, offline: servers.length - online,
    critical: sum.critical || 0, warning: sum.warning || 0 };
}
function setConnFailed() {
  var p = document.getElementById('connStatus');
  if (!p) return;
  p.textContent = '连接失败';
  p.className = 'status-pill bad';
  p.title = '浏览器取不到巡检服务状态，请检查服务是否运行';
}
function updateConnStatus(s) {
  var p = document.getElementById('connStatus');
  if (!p) return;
  var v = connStats(s);
  // 分段着色: 在线绿 / 离线灰 / 严重红 / 警告黄。胶囊底色中性, 不再通体红色。
  // 父级颜色只用于前置圆点: 有严重则红点, 否则按警告/离线/在线取色。
  var seg = ['<span class="p-online">在线 ' + v.online + '/' + v.total + '</span>'];
  if (v.offline > 0) seg.push('<span class="p-offline">离线 ' + v.offline + '</span>');
  if (v.critical > 0) seg.push('<span class="p-crit">严重 ' + v.critical + '</span>');
  else if (v.warning > 0) seg.push('<span class="p-warn">警告 ' + v.warning + '</span>');
  p.innerHTML = seg.join('<i>·</i>');
  p.className = 'status-pill ' + (v.critical ? 'bad' : (v.warning || v.offline) ? 'warn' : 'good');
  p.title = '服务器：' + v.online + '/' + v.total + ' 在线' + (v.offline ? '，' + v.offline + ' 台无法采集' : '') +
    '；指标告警：严重 ' + v.critical + '、警告 ' + v.warning + '（红色=严重指标告警）';
}
function refresh(force) {
  return api.get('/api/status').then(function (s) {
    STATUS = s;
    var sig = statusSignature(s);
    var changed = !!force || sig !== lastStatusSig;
    // 用户正在终端里选文字复制时, 不重建 content; 本次不更新指纹,
    // 下次刷新(选区已取消)会补上这次变化, 不会把新数据永久吞掉。
    var skip = currentView === 'live' && currentCmd && selectionInContent();
    if (changed && !skip) {
      lastStatusSig = sig;
      renderTabs();
      if (currentView === 'live' && currentCmd) renderCmd(currentCmd);
    }
    updateConnStatus(s);
  }).catch(function () { setConnFailed(); });
}

// ---------------- 主导航 ----------------
function switchView(view) {
  if (view === 'manage' && !isAdmin()) { showToast('查看用户不能进入「配置管理」'); return; }
  currentView = view;
  var btns = document.querySelectorAll('.mnav');
  btns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === view); });
  document.getElementById('view-live').hidden = view !== 'live';
  document.getElementById('view-schedule').hidden = view !== 'schedule';
  document.getElementById('view-evidence').hidden = view !== 'evidence';
  document.getElementById('view-manage').hidden = view !== 'manage';
  if (view === 'schedule') refreshSchedule();
  if (view === 'evidence') { refreshEvidence(); refreshHealth(); fillSearchServers(); }
  if (view === 'manage') loadManageForm();
}

// ---------------- 选项卡(命令) ----------------
function renderTabs() {
  var bar = document.getElementById('tabBar'); bar.innerHTML = '';
  (CFG.commands || []).forEach(function (c) {
    if (c.enabled === false) return;
    var used = (STATUS.servers || []).some(function (s) { return s.checks.some(function (x) { return x.id === c.id; }); });
    if (!used) return;
    var b = document.createElement('button');
    b.className = 'tab' + (c.id === currentCmd ? ' active' : '');
    b.textContent = c.name;
    b.onclick = function () { selectCmd(c.id); };
    bar.appendChild(b);
  });
  renderAlerts();
}
function selectCmd(id) { currentCmd = id; renderTabs(); renderCmd(id); }

// 告警「关闭提醒」只记在当前浏览器、当前账号下: 不写服务端, 别人没点就不受影响。
// 用本轮所有 check 的最大 ts 作为巡检批次指纹; 一旦有新采集, 指纹变大, 提醒自动恢复。
function alertDismissKey() {
  var u = (AUTH && AUTH.username) ? AUTH.username : 'anon';
  return 'dailyInspection.alertDismiss.v1.' + u;
}
function alertEpoch(s) {
  var max = 0;
  ((s && s.servers) || []).forEach(function (srv) {
    ((srv && srv.checks) || []).forEach(function (c) {
      var ts = parseInt(c && c.ts, 10) || 0;
      if (ts > max) max = ts;
    });
  });
  return max;
}
function alertDismissed(epoch) {
  var raw = '';
  try { raw = localStorage.getItem(alertDismissKey()) || ''; } catch (e) { return false; }
  var d = parseInt(raw, 10) || 0;
  if (!d) return false;
  if (epoch > d) { // 新巡检批次: 清掉旧状态, 重新弹出
    try { localStorage.removeItem(alertDismissKey()); } catch (e2) {}
    return false;
  }
  return epoch === d;
}
function dismissAlerts() {
  try { localStorage.setItem(alertDismissKey(), String(alertEpoch(STATUS))); } catch (e) {}
  var bar = document.getElementById('alertBar');
  if (bar) { bar.hidden = true; bar.style.display = 'none'; } // 双保险: 立即生效, 不等下一次重绘
  showToast('已关闭本批告警提醒；下次巡检会自动恢复。');
}
// 点击告警行: 切到对应命令, 滚动并短暂高亮对应服务器卡片
function focusAlertTarget(sid, cid) {
  var known = !!(CFG && (CFG.commands || []).some(function (c) { return c.id === cid; }));
  if (!cid || !known) { showToast('该告警对应的命令已不存在或已停用'); return; }
  if (currentView !== 'live') switchView('live');
  currentCmd = cid;
  renderTabs();
  renderCmd(cid).then(function () {
    var cards = document.querySelectorAll('#content .card[data-srv-id]');
    var target = null;
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-srv-id') === sid) { target = cards[i]; break; }
    }
    if (!target) { showToast('未找到对应的服务器卡片'); return; }
    try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { target.scrollIntoView(false); }
    target.classList.remove('jump-flash');
    void target.offsetWidth; // 强制重排, 连续点同一告警也能重新播放高亮
    target.classList.add('jump-flash');
    setTimeout(function () { target.classList.remove('jump-flash'); }, 2300);
  });
}
function renderAlerts() {
  var bar = document.getElementById('alertBar');
  bar.hidden = false;
  bar.style.display = '';
  // 告警总开关关闭: 明确提示, 避免与"全部正常"混淆
  if (CFG && CFG.alerts && CFG.alerts.enabled === false) {
    bar.innerHTML = '<div class="alert-item ok">' + ico('ok') + ' 告警已关闭（可在「配置管理 → 告警配置」开启）</div>';
    return;
  }
  var items = [];
  (STATUS.servers || []).forEach(function (s) {
    (s.checks || []).forEach(function (c) {
      if (c.severity === 'critical' || c.severity === 'warning') items.push({ s: s, c: c });
    });
  });
  if (!items.length) { bar.innerHTML = '<div class="alert-item ok">' + ico('ok') + ' 全部服务器指标正常</div>'; return; }
  // 本浏览器已手动关过这一批: 只隐藏提醒元素, 卡片颜色/归档/服务端数据都不动
  if (alertDismissed(alertEpoch(STATUS))) { bar.hidden = true; bar.style.display = 'none'; return; }
  // 汇总行按最高级别着色: 只有警告时不要显示成红色, 避免"通体红"误导。
  var topSev = items.some(function (x) { return x.c.severity === 'critical'; }) ? 'critical' : 'warning';
  var h = '<div class="alert-item ' + topSev + '">' + ico('warn') + '<span>当前告警 ' + items.length + ' 项</span>' +
    '<button type="button" class="alert-close" title="关闭本次告警提醒（下次巡检自动恢复）" aria-label="关闭告警提醒">' + ico('close') + '</button></div>';
  items.forEach(function (it) {
    h += '<div class="alert-item a-row ' + it.c.severity + '" data-sid="' + esc(it.s.id) + '" data-cid="' + esc(it.c.id) +
      '" tabindex="0" role="button" title="点击查看对应服务器与命令"><span class="a-sev">' +
      (it.c.severity === 'critical' ? '严重' : '警告') + '</span>' +
      '<span>' + esc(it.s.name) + '</span><span>' + esc(it.c.name) + '</span>' +
      '<span class="a-val">' + r1(it.c.value) + esc(it.c.unit) + '</span></div>';
  });
  bar.innerHTML = h;
  var closeBtn = bar.querySelector('.alert-close');
  if (closeBtn) closeBtn.onclick = function (e) { e.stopPropagation(); dismissAlerts(); };
  bar.querySelectorAll('.a-row').forEach(function (row) {
    function go(e) {
      if (e && e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      if (e && e.preventDefault) e.preventDefault();
      focusAlertTarget(row.getAttribute('data-sid'), row.getAttribute('data-cid'));
    }
    row.onclick = go;
    row.onkeydown = go;
  });
}

async function renderCmd(cmdId) {
  var cmd = (CFG.commands || []).find(function (c) { return c.id === cmdId; });
  if (!cmd) return;
  var content = document.getElementById('content');
  var servers = (STATUS.servers || []).filter(function (s) { return s.checks.some(function (x) { return x.id === cmdId; }); });
  var cards = await Promise.all(servers.map(function (s) {
    var meta = s.checks.find(function (x) { return x.id === cmdId; }) || {};
    return fetchResult(s.id, cmdId, meta.ts || 0).then(function (o) { return { s: s, r: o.s, failed: o.failed }; });
  }));
  var html = '';
  cards.forEach(function (it) { html += renderCard(cmd, it.s, it.r, it.failed); });
  content.innerHTML = html || '<div class="placeholder">该命令未分配给任何服务器</div>';
}
function renderCard(cmd, srv, res, failed) {
  var meta = srv.checks.find(function (x) { return x.id === cmd.id; }) || {};
  var online = res ? res.online : meta.online;
  var sev = meta.severity || 'ok';
  var stColor = online ? (sev === 'critical' ? '#dc2626' : sev === 'warning' ? '#f59e0b' : '#16a34a') : '#dc2626';
  var stText = online ? (sev === 'critical' ? '告警·严重' : sev === 'warning' ? '告警·警告' : '在线') : '离线';
  var val = meta.value;
  var valHtml = (val != null) ? '<div class="bigval' + (sev === 'critical' ? ' bad' : sev === 'warning' ? ' warn' : '') + '">' + r1(val) + '<span class="unit">' + esc(meta.unit || '') + '</span></div>' : '';
  // 没有单一数值的命令(自定义命令等): 显示原始输出的文本摘要, 避免卡片顶部空白
  var raw = res && res.latest ? res.latest.raw : '';
  var cmdline = res && res.latest ? res.latest.command : cmd.command;
  var summaryHtml = '';
  if (val == null && raw) {
    var sum = plainSummary(raw, cmdline);
    if (sum) summaryHtml = '<div class="valtext" title="' + esc(cleanAnsi(raw).trim()) + '">' + esc(sum) + '</div>';
  }
  var termHtml = '', errHtml = '';
  if (res && res.error) errHtml = '<div class="err">采集失败（' + esc(failKindText(res.errorCategory)) + '）: ' + esc(res.error) + '</div>';
  if (res && res.latest && res.latest.raw) {
    // 传原文给 ansiToHtml(内部逐字符 esc); 提前 esc 会让命令里的 " 显示成字面 &quot;。
    var promptLine = '\x1b[36m[root@' + srv.name + ' ~]#\x1b[0m ' + res.latest.command + '\n';
    termHtml = '<pre class="term">' + ansiToHtml(promptLine + res.latest.raw) + '</pre>';
  } else if (!res || !res.latest) {
    // 有采集时间说明数据其实在, 只是这次没取到; 不再误报"等待首次采集"。
    var hasData = !!(failed && meta.ts);
    termHtml = '<pre class="term">' + (hasData ? '终端内容加载失败，正在自动重试…' : '等待首次采集…') + '</pre>';
  }
  var ts = res && res.latest ? res.latest.ts : 0;
  return '<div class="card' + (sev === 'critical' ? ' sev-critical' : sev === 'warning' ? ' sev-warning' : '') +
    '" data-srv-id="' + esc(srv.id) + '">' +
    '<div class="card-head"><span class="dot" style="background:' + stColor + '"></span>' +
    '<span class="cname">' + esc(srv.name) + '</span><span class="chost">' + esc(srv.host) + '</span>' +
    '<span class="cstat">' + stText + ' · ' + fmtTs(ts) + '</span></div>' +
    '<div class="card-meta">' + valHtml + summaryHtml + '<button class="btn tiny ghost" data-shot="' + srv.id + '" title="下载终端截图">' + ico('camera') + ' 截图</button></div>' +
    errHtml + termHtml + '</div>';
}

// ---------------- 账号与退出 ----------------
function doLogout() {
  api.post('/api/auth/logout').then(function () { location.replace('/login.html'); },
    function () { location.replace('/login.html'); });
}
// 账号设置(配置管理内): 管理员改自己的密码 / 设置查看用户密码, 均不用系统弹窗。
function clearPwFields() {
  ['pwOld', 'pwNew', 'pwNew2', 'vwNew', 'vwNew2'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  ['pwMsg', 'vwMsg'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.textContent = '';
  });
}
function savePw() {
  var oldPw = document.getElementById('pwOld').value;
  var np = document.getElementById('pwNew').value;
  var np2 = document.getElementById('pwNew2').value;
  var msg = document.getElementById('pwMsg');
  if (!oldPw) { msg.textContent = '请输入原密码'; return; }
  if (np.length < 6) { msg.textContent = '新密码至少 6 位'; return; }
  if (np !== np2) { msg.textContent = '两次输入的新密码不一致'; return; }
  var btn = document.getElementById('btnSavePw');
  btn.disabled = true;
  api.post('/api/auth/password', { oldPassword: oldPw, newPassword: np }).then(function (r) {
    btn.disabled = false;
    if (r && r.ok) {
      clearPwFields();
      showToast('管理员密码已修改，初始密码文件已自动清理。');
    } else {
      msg.textContent = (r && r.error) || '修改失败';
    }
  }, function () { btn.disabled = false; msg.textContent = '修改失败, 请重试'; });
}
function saveViewerPw() {
  var np = document.getElementById('vwNew').value;
  var np2 = document.getElementById('vwNew2').value;
  var msg = document.getElementById('vwMsg');
  if (np.length < 6) { msg.textContent = '新密码至少 6 位'; return; }
  if (np !== np2) { msg.textContent = '两次输入的新密码不一致'; return; }
  var btn = document.getElementById('btnSaveViewerPw');
  btn.disabled = true;
  api.post('/api/auth/viewer-password', { password: np }).then(function (r) {
    btn.disabled = false;
    if (r && r.ok) { clearPwFields(); showToast('查看用户 viewer 的密码已修改。'); }
    else { msg.textContent = (r && r.error) || '修改失败'; }
  }, function () { btn.disabled = false; msg.textContent = '修改失败, 请重试'; });
}

function bindEvents() {
  document.querySelectorAll('.mnav').forEach(function (b) { b.onclick = function () { switchView(b.getAttribute('data-view')); }; });
  document.getElementById('btnRefreshNow').onclick = function () {
    // 手动刷新只重拉已采集的状态, 不触发新一轮巡检; 数据没变时页面自然看不出动静,
    // 所以给按钮加旋转 + 角标明确告知结果(以及该怎么拿新数据)。
    var btn = this, icoEl = btn.querySelector('.ico');
    var before = STATUS ? statusSignature(STATUS) : null;
    btn.disabled = true;
    if (icoEl) icoEl.classList.add('spin');
    refresh(true).then(function () {
      btn.disabled = false;
      if (icoEl) icoEl.classList.remove('spin');
      var latest = 0;
      ((STATUS && STATUS.servers) || []).forEach(function (srv) {
        ((srv && srv.checks) || []).forEach(function (c) { if (c.ts > latest) latest = c.ts; });
      });
      var sig = statusSignature(STATUS);
      var changed = before === null || sig !== before;
      // 同一批数据连点刷新: 只把次数 +1, 不再叠一摞提示。文案稍微俏皮一点但不吵。
      if (changed || refreshToast.sig !== sig) refreshToast.count = 1;
      else refreshToast.count++;
      refreshToast.sig = sig;
      var msg = changed
        ? '已刷新 · 数据有更新（最近采集 ' + fmtTs(latest) + '）'
        : '已刷新 ×' + refreshToast.count + ' · 数据纹丝不动（最近采集 ' + fmtTs(latest) + '）' +
          (isAdmin() ? '\n要新数据请点「立即巡检」，刷新只看已采集结果' : '');
      showToast(msg, 4000, 'refresh');
    });
  };
  document.getElementById('btnLogout').onclick = doLogout;
  document.getElementById('btnSavePw').onclick = savePw;
  document.getElementById('btnSaveViewerPw').onclick = saveViewerPw;
  document.getElementById('btnSaveConfig').onclick = saveConfig;
  document.getElementById('btnAddServer').onclick = addServer;
  document.getElementById('btnAddCommand').onclick = addCommand;
  document.getElementById('btnRunNow').onclick = doRunNow;
  document.getElementById('btnCloseDetail').onclick = function () { document.getElementById('detailModal').hidden = true; };
  document.getElementById('btnDownloadShot').onclick = downloadDetailShot;
  document.getElementById('btnRefreshEvidence').onclick = refreshEvidence;
  var lockAllToggle = document.getElementById('btnLockAllToggle');
  if (lockAllToggle) lockAllToggle.onclick = function () {
    if (evLockAllLocked) doUnlockAll(lockAllToggle); else doLockAll(lockAllToggle);
  };
  // 归档记录日期筛选: 变更即时重渲染(数据已缓存, 不重复请求)
  ['evFrom', 'evTo'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.onchange = renderEvidenceList;
  });
  var btnEvClear = document.getElementById('btnEvClear');
  if (btnEvClear) btnEvClear.onclick = function () {
    document.getElementById('evFrom').value = '';
    document.getElementById('evTo').value = '';
    renderEvidenceList();
  };
  document.getElementById('btnRefreshHealth').onclick = refreshHealth;
  document.getElementById('btnReindex').onclick = doReindex;
  document.getElementById('btnSearch').onclick = runSearch;
  document.getElementById('qKeyword').onkeydown = function (e) { if (e.key === 'Enter') runSearch(); };
  document.querySelectorAll('.mtab').forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll('.mtab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      var which = t.getAttribute('data-mt');
      document.querySelectorAll('.mpane').forEach(function (p) { p.hidden = (p.getAttribute('data-pane') !== which); });
      // 账号设置自己有保存按钮, 隐藏底部的"保存配置并应用"整栏
      var bar = document.querySelector('.mgmt-savebar');
      if (bar) bar.hidden = (which === 'account');
    };
  });
  // 归档留证左侧内部导航
  document.querySelectorAll('.ev-nav').forEach(function (t) {
    t.onclick = function () { switchEvidencePane(t.getAttribute('data-ev')); };
  });
}

// 归档留证: 切换三个板块, 一次只显示一个, 各自独立滚动, 不再整页一起滚。
function switchEvidencePane(which) {
  document.querySelectorAll('.ev-nav').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-ev') === which);
  });
  document.querySelectorAll('.ev-pane').forEach(function (p) {
    p.hidden = (p.getAttribute('data-pane') !== which);
  });
}

// 定时任务: 只显示与当前调度模式对应的输入框, 避免"每日时间"和"间隔分钟"同时出现造成歧义。
// hidden 属性与 inline display 同步维护: CSS 有 .form-grid label[hidden]{display:none} 兜底,
// 只清 style.display 而留着 hidden 会让框被 CSS 继续藏住(固定间隔模式曾因此空白)。
function syncSchMode() {
  var mode = document.getElementById('schMode').value;
  var daily = mode !== 'interval';
  var tr = document.getElementById('schTimeRow');
  var ir = document.getElementById('schIntervalRow');
  if (tr) { tr.hidden = !daily; tr.style.display = daily ? 'flex' : 'none'; }
  if (ir) { ir.hidden = daily; ir.style.display = daily ? 'none' : 'flex'; }
}

// 填充配置管理视图的表单。视图的显示/隐藏由 switchView('manage') 负责, 这里只填数据。
function loadManageForm() {
  if (!isAdmin()) return;
  clearPwFields();
  renderServerList(); renderCommandList();
  var s = CFG.schedule || {};
  document.getElementById('schEnabled').value = def(s.enabled, true) ? 'true' : 'false';
  var modeEl = document.getElementById('schMode');
  modeEl.value = def(s.mode, 'daily');
  modeEl.onchange = syncSchMode; // 覆盖式绑定, 避免重复进配置管理叠加监听
  document.getElementById('schTime').value = def(s.time, '02:00');
  document.getElementById('schInterval').value = def(s.intervalMinutes, 60);
  document.getElementById('schRunOnStart').checked = !!s.runOnStart;
  syncSchMode();
  var st = CFG.settings || {};
  document.getElementById('setPoll').value = def(st.pollIntervalMs, 86400000);
  document.getElementById('setUiRefresh').value = def(st.uiRefreshMs, 0);
  document.getElementById('setHistory').value = def(st.historyMaxPoints, 2000);
  document.getElementById('setHistoryRuns').value = def(st.historyMaxRuns, 2000);
  document.getElementById('setRetain').value = def(st.retainDays, 0);
  // chattr +i 只对 Linux 中心机有意义: Windows 上直接隐藏开关, 也不改写已有配置。
  var immutableRow = document.getElementById('immutableRow');
  if (immutableRow) {
    var isWin = !!(STATUS && STATUS.platform === 'win32');
    immutableRow.hidden = isWin;
    document.getElementById('setImmutable').value = def(st.evidenceImmutable, true) ? 'true' : 'false';
  }
  document.getElementById('setTty').value = def(st.requestTTY, true) ? 'true' : 'false';
  document.getElementById('setShot').value = def(st.shotEnabled, true) ? 'true' : 'false';
  document.getElementById('setShotTheme').value = def(st.shotTheme, 'dark');
  document.getElementById('setShotFont').value = def(st.shotFontSize, 14);
  document.getElementById('setCols').value = def(st.terminalCols, 132);
  document.getElementById('setLines').value = def(st.terminalLines, 80);
  document.getElementById('setRemoteCols').value = def(st.remoteCols, 300);
  document.getElementById('setRemoteLines').value = def(st.remoteLines, 60);
  document.getElementById('setSqlite').value = def(st.sqliteIndex, true) ? 'true' : 'false';
  document.getElementById('setFontPath').value = def(st.shotFontPath, 'auto');
  document.getElementById('setCjkFontPath').value = def(st.shotCjkFontPath, 'auto');
  document.getElementById('setPythonExe').value = def(st.pythonExe, '');
  // 告警配置(老配置可能缺字段, 用默认值兜底, 与后端 normalizeAlerts 保持一致)
  var al = CFG.alerts || {};
  var alDef = { enabled: true, cpu: [80, 90], mem: [85, 95], disk: [85, 95] };
  var alDiskDef = { ignoreFs: ['tmpfs', 'devtmpfs', 'ramfs', 'rootfs', 'overlay', 'overlayfs'],
    ignoreMounts: ['/dev/shm', '/run', '/sys/fs/cgroup', '/proc', '/sys'] };
  document.getElementById('alEnabled').value = def(al.enabled, true) ? 'true' : 'false';
  [['cpu', 'alCpu'], ['mem', 'alMem'], ['disk', 'alDisk']].forEach(function (pair) {
    var k = pair[0], pre = pair[1], d = alDef[k], cur = al[k] || {};
    document.getElementById(pre + 'On').value = def(cur.enabled, true) ? 'true' : 'false';
    document.getElementById(pre + 'Warn').value = def(cur.warning, d[0]);
    document.getElementById(pre + 'Crit').value = def(cur.critical, d[1]);
  });
  var ad = al.disk || {};
  document.getElementById('alDiskIgnoreFs').value = (Array.isArray(ad.ignoreFs) ? ad.ignoreFs : alDiskDef.ignoreFs).join(', ');
  document.getElementById('alDiskIgnoreMounts').value = (Array.isArray(ad.ignoreMounts) ? ad.ignoreMounts : alDiskDef.ignoreMounts).join(', ');
}

// 新增后把新卡片带到可视区并聚焦名称框; Firefox 115 ESR 也兼容旧版调用方式。
function revealCfgCard(id) {
  var card = document.querySelector('[data-card-id="' + id + '"]');
  if (!card) return;
  // 用即时定位而非平滑动画: Chromium/Edge 下 smooth 滚动在低性能或远程图形环境
  // 会拖住主线程并延迟随后的 alert/重绘, 看起来像"卡一下"; Firefox 无此问题。
  try { card.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
  catch (e) { try { card.scrollIntoView(false); } catch (e2) {} }
  var input = card.querySelector('input[data-field="name"]');
  if (input) {
    try { input.focus({ preventScroll: true }); } catch (e3) { input.focus(); }
    try { input.select(); } catch (e4) {}
  }
}
function renderCommandList(focusId) {
  var box = document.getElementById('commandList'); box.innerHTML = '';
  (CFG.commands || []).forEach(function (c) {
    var card = document.createElement('div'); card.className = 'cfg-card';
    card.setAttribute('data-card-id', c.id);
    card.innerHTML =
      '<div class="cfg-row"><span class="cfg-id">ID: ' + esc(c.id) + '</span>' +
      '<button class="btn tiny ghost danger" data-delcmd="' + esc(c.id) + '">删除</button></div>' +
      '<div class="cfg-row">' +
      '<label style="flex:2">名称<input data-kind="cmd" data-id="' + esc(c.id) + '" data-field="name" value="' + esc(c.name) + '" /></label>' +
      '<label>超时(ms)<input data-kind="cmd" data-id="' + esc(c.id) + '" data-field="timeoutMs" type="number" value="' + esc(c.timeoutMs) + '" /></label>' +
      '<label class="chk"><input type="checkbox" data-kind="cmd" data-id="' + esc(c.id) + '" data-field="enabled" ' + (c.enabled !== false ? 'checked' : '') + ' />启用</label>' +
      '</div>' +
      '<label>命令<input data-kind="cmd" data-id="' + esc(c.id) + '" data-field="command" value="' + esc(c.command) + '" /></label>';
    box.appendChild(card);
  });
  bindCfgInputs();
  if (focusId) revealCfgCard(focusId);
}

function renderServerList(focusId) {
  var box = document.getElementById('serverList'); box.innerHTML = '';
  (CFG.servers || []).forEach(function (s) {
    var ssh = s.ssh || {};
    var assign = '<div class="cmd-assign">';
    (CFG.commands || []).forEach(function (c) {
      if (c.enabled === false) return; // 未启用的命令不出现在服务器可勾选列表
      var checked = (s.commandIds || []).indexOf(c.id) >= 0;
      assign += '<label><input type="checkbox" data-assign="' + esc(s.id) + '" value="' + esc(c.id) + '"' + (checked ? ' checked' : '') + ' /> ' + esc(c.name) + '</label>';
    });
    assign += '</div>';
    var card = document.createElement('div'); card.className = 'cfg-card';
    card.setAttribute('data-card-id', s.id);
    card.innerHTML =
      '<div class="cfg-row"><span class="cfg-id">ID: ' + esc(s.id) + '</span>' +
      '<button class="btn tiny ghost danger" data-delsrv="' + esc(s.id) + '">删除</button></div>' +
      '<div class="cfg-row">' +
      '<label>名称<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="name" value="' + esc(s.name) + '" /></label>' +
      '<label>主机/IP<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="host" value="' + esc(s.host) + '" /></label>' +
      '<label>分组<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="group" value="' + esc(def(s.group, '')) + '" /></label>' +
      '<label class="chk"><input type="checkbox" data-kind="srv" data-id="' + esc(s.id) + '" data-field="enabled" ' + (s.enabled !== false ? 'checked' : '') + ' />启用</label>' +
      '</div>' +
      '<div class="cfg-row">' +
      '<label>采集方式<select data-kind="srv" data-id="' + esc(s.id) + '" data-field="mode">' + modeOpts(ssh.mode) + '</select></label>' +
      '<label>认证方式<select data-kind="srv" data-id="' + esc(s.id) + '" data-field="auth">' + authOpts(ssh.auth) + '</select></label>' +
      '<label>SSH用户<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="user" value="' + esc(def(ssh.user, 'root')) + '" autocomplete="off" data-lpignore="true" data-1p-ignore="true" spellcheck="false" /></label>' +
      '<label>SSH端口<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="port" type="number" value="' + esc(def(ssh.port, 22)) + '" /></label>' +
      '</div>' +
      '<div class="cfg-row ssh-key"><label>密钥路径<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="keyFile" value="' + esc(def(ssh.keyFile, '')) + '" placeholder="~/.ssh/id_rsa" /></label></div>' +
      '<div class="cfg-row ssh-pass"><label>登录密码<input data-kind="srv" data-id="' + esc(s.id) + '" data-field="password" type="password" autocomplete="new-password" data-lpignore="true" data-1p-ignore="true" spellcheck="false" value="' + (def(ssh.password, '') === PW_SAVED ? '' : esc(def(ssh.password, ''))) + '" placeholder="' + (def(ssh.password, '') === PW_SAVED ? '已加密保存，留空不修改' : '') + '" /></label>' +
      (def(ssh.password, '') === PW_SAVED ? '<button class="btn tiny ghost danger" data-clrpw="' + esc(s.id) + '">清除已存密码</button>' : '') + '</div>' +
      '<div><div class="hint" style="margin-bottom:2px">该服务器执行的命令（可不同）：</div>' + assign + '</div>' +
      '<div class="cfg-row" style="margin-top:8px"><button class="btn tiny" data-test="' + esc(s.id) + '">测试连接</button>' +
      '<span class="test-result hint" data-testres="' + esc(s.id) + '"></span></div>';
    box.appendChild(card);
  });
  // 双保险: 渲染后强制把认证方式 select 设为归一化值, 避免浏览器对 selected 属性解析差异
  document.querySelectorAll('#serverList .cfg-card').forEach(function (card) {
    var sv = CFG.servers.find(function (x) { return x.id === card.getAttribute('data-card-id'); });
    var sel = card.querySelector('[data-field="auth"]');
    if (sv && sv.ssh && sel) sel.value = normAuth(sv.ssh.auth);
  });
  bindCfgInputs(); applySshVisibility();
  if (focusId) revealCfgCard(focusId);
}
function modeOpts(sel) { var o = [['ssh','SSH'],['local','本机'],['demo','模拟']]; return o.map(function(x){return '<option value="'+x[0]+'"'+(x[0]===sel?' selected':'')+'>'+x[1]+'</option>';}).join(''); }
// 归一化认证方式: 配置里可能出现 Password/密码/密钥/空值 等历史写法,
// 严格相等会导致没有任何 option 被 selected, 浏览器默认选中第一项(密钥),
// 出现"实际用密码登录、界面却显示密钥"。这里统一成 'key' / 'password'。
function normAuth(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return (s === 'key' || s === 'pubkey' || s.indexOf('密钥') >= 0) ? 'key' : 'password';
}
function authOpts(sel) {
  var v = normAuth(sel), o = [['key','密钥(免密)'],['password','用户名密码']];
  return o.map(function(x){return '<option value="'+x[0]+'"'+(x[0]===v?' selected':'')+'>'+x[1]+'</option>';}).join('');
}
function applySshVisibility() {
  document.querySelectorAll('#serverList .cfg-card').forEach(function (card) {
    var mode = card.querySelector('[data-field="mode"]').value;
    var auth = card.querySelector('[data-field="auth"]').value;
    var key = card.querySelector('.ssh-key'), pass = card.querySelector('.ssh-pass');
    if (key) key.style.display = (mode === 'ssh' && auth === 'key') ? '' : 'none';
    if (pass) pass.style.display = (mode === 'ssh' && auth === 'password') ? '' : 'none';
  });
}
function bindCfgInputs() {
  document.querySelectorAll('[data-kind="cmd"]').forEach(function (el) {
    el.onchange = function () {
      var c = CFG.commands.find(function (x) { return x.id === el.getAttribute('data-id'); }); if (!c) return;
      var f = el.getAttribute('data-field');
      if (f === 'enabled') c.enabled = el.checked;
      else if (f === 'timeoutMs') c.timeoutMs = parseInt(el.value, 10) || 10000;
      else c[f] = el.value;
    };
  });
  document.querySelectorAll('[data-kind="srv"]').forEach(function (el) {
    el.onchange = function () {
      var s = CFG.servers.find(function (x) { return x.id === el.getAttribute('data-id'); }); if (!s) return;
      if (!s.ssh) s.ssh = {}; var f = el.getAttribute('data-field');
      if (f === 'mode' || f === 'auth') { s.ssh[f] = el.value; applySshVisibility(); }
      else if (f === 'user' || f === 'port' || f === 'keyFile' || f === 'password') {
        s.ssh[f] = (f === 'port' ? (parseInt(el.value,10)||22) : el.value);
        // 用户重新输入了密码: 撤掉"清除已存密码"标记, 以新输入为准
        if (f === 'password' && el.value) {
          var row = el.closest ? el.closest('.cfg-row') : null;
          var cb = row && row.querySelector('[data-clrpw]');
          if (cb && cb.parentNode) cb.parentNode.removeChild(cb);
        }
      }
      else if (f === 'enabled') s.enabled = el.checked;
      else s[f] = el.value;
    };
  });
  document.querySelectorAll('[data-assign]').forEach(function (el) {
    el.onchange = function () {
      var s = CFG.servers.find(function (x) { return x.id === el.getAttribute('data-assign'); }); if (!s) return;
      s.commandIds = s.commandIds || [];
      var id = el.value, idx = s.commandIds.indexOf(id);
      if (el.checked && idx < 0) s.commandIds.push(id);
      else if (!el.checked && idx >= 0) s.commandIds.splice(idx, 1);
    };
  });
  document.querySelectorAll('[data-delcmd]').forEach(function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-delcmd');
      CFG.commands = CFG.commands.filter(function (x) { return x.id !== id; });
      if (lastAddedCmdId === id) lastAddedCmdId = null;
      renderCommandList();
    };
  });
  document.querySelectorAll('[data-delsrv]').forEach(function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-delsrv');
      CFG.servers = CFG.servers.filter(function (x) { return x.id !== id; });
      if (lastAddedSrvId === id) lastAddedSrvId = null;
      renderServerList();
    };
  });
  document.querySelectorAll('[data-clrpw]').forEach(function (b) {
    b.onclick = function () {
      var id = b.getAttribute('data-clrpw');
      var s = CFG.servers.find(function (x) { return x.id === id; });
      if (!s || !s.ssh) return;
      s.ssh.password = PW_CLEAR;
      var row = b.closest ? b.closest('.cfg-row') : null;
      var inp = row && row.querySelector('[data-field="password"]');
      if (inp) { inp.value = ''; inp.placeholder = '已标记清除，保存后生效'; }
      b.textContent = '已标记清除'; b.disabled = true;
    };
  });
  document.querySelectorAll('[data-test]').forEach(function (b) { b.onclick = function () { testServer(b.getAttribute('data-test')); }; });
}
function testServer(id) {
  var s = CFG.servers.find(function (x) { return x.id === id; }); if (!s) return;
  var out = document.querySelector('[data-testres="' + id + '"]');
  out.textContent = '测试中…'; out.style.color = '#888';
  api.post('/api/server/test', s).then(function (r) {
    out.textContent = (r.ok ? '✓ ' : '✗ ')
      + (!r.ok && (r.errorCategoryText || r.errorCategory) ? '[' + esc(r.errorCategoryText || failKindText(r.errorCategory)) + '] ' : '')
      + (r.message || r.error || '');
    out.style.color = r.ok ? '#16a34a' : '#dc2626';
  }).catch(function (e) { out.textContent = '✗ ' + e.message; out.style.color = '#dc2626'; });
}
function indexAfter(list, id) {
  for (var i = 0; i < list.length; i++) { if (list[i].id === id) return i + 1; }
  return list.length;
}
function addServer() {
  CFG.servers = CFG.servers || [];
  var s = { id: genId('srv'), name: '新服务器', host: '', group: '', enabled: true, timeoutMs: 30000, commandIds: [], ssh: { mode: 'ssh', auth: 'password', user: 'root', port: 22, keyFile: '', password: '' } };
  CFG.servers.splice(indexAfter(CFG.servers, lastAddedSrvId), 0, s);
  lastAddedSrvId = s.id;
  renderServerList(s.id);
}
function addCommand() {
  CFG.commands = CFG.commands || [];
  var c = { id: genId('cmd'), name: '新命令', command: '', timeoutMs: 10000, enabled: true };
  CFG.commands.splice(indexAfter(CFG.commands, lastAddedCmdId), 0, c);
  lastAddedCmdId = c.id;
  renderCommandList(c.id);
}
function genId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
// 稳定序列化: 对象键排序后再比较, 避免"重建对象导致键顺序变化"被误判为改动。
function stableStr(v) {
  if (v === null || v === undefined || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stableStr(v[k]); }).join(',') + '}';
}
// 数组按 id 做条目级差异: 只传"哪几条变了 / 变了哪几个字段 / 新增 / 删除"。
// 用户历史上遇到过「CPU 平均使用时间的命令名被拦截, 改个名字就好了」——说明链路是按
// 请求体里的明文内容/名称做特征匹配的。这样改命令名时请求体里只有 {name:"新名"},
// 连 mpstat/awk/su 等命令原文都不会出现, 更不会把没改的十几条命令一起带上去。
function arrayOps(base, cur) {
  base = base || []; cur = cur || [];
  var bmap = {}, cmap = {}, ops = { patch: {}, add: [], del: [] }, k;
  base.forEach(function (x) { bmap[x.id] = x; });
  cur.forEach(function (x) { cmap[x.id] = x; });
  base.forEach(function (x) { if (!cmap[x.id]) ops.del.push(x.id); });
  cur.forEach(function (x) {
    var b = bmap[x.id], diff = {}, keys = {};
    if (!b) { ops.add.push(x); return; }
    Object.keys(b).forEach(function (y) { keys[y] = 1; });
    Object.keys(x).forEach(function (y) { keys[y] = 1; });
    for (k in keys) {
      if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
      if (stableStr(b[k]) !== stableStr(x[k])) diff[k] = x[k];
    }
    if (Object.keys(diff).length) ops.patch[x.id] = diff;
  });
  return ops;
}
// 只挑出与基线不同的顶层字段提交。改一个轮询间隔时请求体里就只有 settings,
// 不再夹带 18 条 shell 命令原文(| ; $() awk grep su 等)和全部服务器/SSH 信息 ——
// 这些正是链路里 IPS/WAF 最容易当成命令注入特征、拖慢甚至拦掉 POST 的内容。
function configPatch() {
  var out = { __patch: true }, keys = {}, k;
  Object.keys(CFG || {}).forEach(function (x) { keys[x] = 1; });
  Object.keys(CFG_BASE || {}).forEach(function (x) { keys[x] = 1; });
  for (k in keys) {
    if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
    if (stableStr(CFG[k]) === stableStr(CFG_BASE ? CFG_BASE[k] : undefined)) continue;
    if (k === 'commands' || k === 'servers') out[k] = { __ops: arrayOps(CFG_BASE ? CFG_BASE[k] : [], CFG[k]) };
    else out[k] = CFG[k];
  }
  return out;
}

function saveConfig() {
  CFG.schedule = {
    enabled: document.getElementById('schEnabled').value === 'true',
    mode: document.getElementById('schMode').value,
    time: document.getElementById('schTime').value || '02:00',
    intervalMinutes: parseInt(document.getElementById('schInterval').value, 10) || 60,
    runOnStart: document.getElementById('schRunOnStart').checked
  };
  CFG.settings = CFG.settings || {};
  // 0 = 关闭实时轮询(仅定时巡检采集); 不能再用 `|| 默认值`, 否则 0 会被吞掉变成高频。
  var pollInput = parseInt(document.getElementById('setPoll').value, 10);
  CFG.settings.pollIntervalMs = isNaN(pollInput) ? 86400000 : Math.max(0, pollInput);
  var uiInput = parseInt(document.getElementById('setUiRefresh').value, 10);
  CFG.settings.uiRefreshMs = (isNaN(uiInput) || uiInput <= 0) ? 0 : Math.max(1000, uiInput);
  CFG.settings.historyMaxPoints = parseInt(document.getElementById('setHistory').value, 10) || 2000;
  var runsInput = parseInt(document.getElementById('setHistoryRuns').value, 10);
  CFG.settings.historyMaxRuns = (isNaN(runsInput) || runsInput < 1) ? 2000 : runsInput;
  CFG.settings.retainDays = parseInt(document.getElementById('setRetain').value, 10) || 0;
  var immutableRow = document.getElementById('immutableRow');
  if (immutableRow && !immutableRow.hidden) {
    CFG.settings.evidenceImmutable = document.getElementById('setImmutable').value === 'true';
  }
  CFG.settings.requestTTY = document.getElementById('setTty').value === 'true';
  CFG.settings.shotEnabled = document.getElementById('setShot').value === 'true';
  CFG.settings.shotTheme = document.getElementById('setShotTheme').value;
  CFG.settings.shotFontSize = parseInt(document.getElementById('setShotFont').value, 10) || 14;
  CFG.settings.terminalCols = parseInt(document.getElementById('setCols').value, 10) || 132;
  CFG.settings.terminalLines = parseInt(document.getElementById('setLines').value, 10) || 80;
  CFG.settings.remoteCols = parseInt(document.getElementById('setRemoteCols').value, 10) || 300;
  CFG.settings.remoteLines = parseInt(document.getElementById('setRemoteLines').value, 10) || 60;
  CFG.settings.sqliteIndex = document.getElementById('setSqlite').value === 'true';
  CFG.settings.shotFontPath = document.getElementById('setFontPath').value || 'auto';
  CFG.settings.shotCjkFontPath = document.getElementById('setCjkFontPath').value || 'auto';
  CFG.settings.pythonExe = document.getElementById('setPythonExe').value || '';
  // 告警配置: 阈值做 0-100 钳制, critical 必须大于 warning(与后端 normalizeAlerts 同规则)
  CFG.alerts = CFG.alerts || {};
  function pct(id, fallback) {
    var n = parseInt(document.getElementById(id).value, 10);
    return isNaN(n) ? fallback : Math.max(0, Math.min(100, n));
  }
  // 兼容中英文逗号/换行; 空串得到空数组, 表示不忽略。
  function splitList(id) {
    return document.getElementById(id).value.split(/[,，\n]+/).map(function (s) { return s.replace(/^\s+|\s+$/g, ''); })
      .filter(function (s) { return !!s; });
  }
  CFG.alerts.enabled = document.getElementById('alEnabled').value === 'true';
  [['cpu', 'alCpu', 80, 90], ['mem', 'alMem', 85, 95], ['disk', 'alDisk', 85, 95]].forEach(function (cfg) {
    var k = cfg[0], pre = cfg[1];
    var w = pct(pre + 'Warn', cfg[2]), c = pct(pre + 'Crit', cfg[3]);
    if (c <= w) c = Math.min(100, w + 1);
    CFG.alerts[k] = { enabled: document.getElementById(pre + 'On').value === 'true', warning: w, critical: c };
  });
  CFG.alerts.disk.ignoreFs = splitList('alDiskIgnoreFs');
  CFG.alerts.disk.ignoreMounts = splitList('alDiskIgnoreMounts');
  // 弱链路上保存可能等很久: 按钮给出"保存中"反馈并防重复提交, 失败必须恢复。
  var saveBtn = document.getElementById('btnSaveConfig');
  var saveOld = saveBtn ? saveBtn.textContent : '';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
  function restoreBtn() { if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveOld; } }
  var patch = configPatch();
  if (Object.keys(patch).length === 1) { // 只有 __patch: 没改动, 连请求都不发
    restoreBtn();
    showToast('没有改动，无需保存', 2500, 'save');
    return;
  }
  api.put('/api/config', patch).then(function (r) {
    restoreBtn();
    if (!r.ok) { showToast('保存失败: ' + (r.error || '未知')); return; }
    CFG_BASE = JSON.parse(JSON.stringify(CFG)); // 成功后更新基线, 下次只传新的改动
    // 保存配置不改变实时采集状态: CFG 就是刚提交的那份, STATUS 仍是最新采集结果,
    // 无需再走 boot() 重拉 config/status/results×N/schedule 一整串。
    showToast('配置已保存并应用。\n可继续修改其它配置项，或点左侧菜单返回看板。', 3500);
    // 告警开关/阈值立即生效: severity 由后端按新配置在 /api/status 里重算,
    // 重新拉一次 status 即可刷新告警条与卡片颜色, 不等下轮采集。
    applyUiRefresh(); // 页面自动刷新间隔可能刚被改过, 先按新值重建定时器
    refresh(true);
    if (currentView === 'schedule') refreshSchedule();
  }).catch(function (e) {
    restoreBtn();
    showToast('保存失败（连接中断或被重置），请重试: ' + (e && e.message ? e.message : ''));
  });
}

// ---------------- 定时任务 ----------------
function doRunNow() {
  if (!isAdmin()) { showToast('查看用户不能执行「立即巡检」'); return; }
  var trigger = this || document.getElementById('btnRunNow');
  askConfirm({
    anchor: trigger,
    title: '立即执行一次全量巡检',
    message: '将对全部启用的服务器执行一遍命令清单，并自动归档留证。\n耗时取决于服务器数量与命令条数，执行期间可继续查看其他页面。',
    okText: '开始巡检',
    onOk: function () {
      var b = document.getElementById('btnRunNow'); var old = b.textContent; b.textContent = '巡检中…'; b.disabled = true;
      api.post('/api/schedule/run', {}).then(function (r) {
        b.textContent = old; b.disabled = false;
        showToast('巡检完成：' + (r.servers || 0) + ' 台 / ' + (r.commands || 0) + ' 条，成功 ' + (r.ok || 0) + ' 条。批次 ' + (r.runId || ''), 6000);
        refreshSchedule();
      }).catch(function (e) { b.textContent = old; b.disabled = false; showToast('触发失败: ' + e.message, 8000); });
    }
  });
}
function refreshSchedule() {
  api.get('/api/schedule').then(function (d) {
    SCHED = d; var s = d.config || {}; var lr = d.lastResult;
    var badge = !s.enabled ? '<span class="badge off">未启用</span>' : d.running ? '<span class="badge run">运行中</span>' : '<span class="badge ok">启用</span>';
    var modeText = def(s.mode, 'daily') === 'daily' ? ('每日 ' + def(s.time, '02:00')) : ('每 ' + def(s.intervalMinutes, 60) + ' 分钟');
    var html = '<div class="kv-grid">' +
      kv('任务状态', badge) + kv('调度规则', modeText) + kv('下次执行', s.enabled ? fmtTs(d.nextRun) : '-') +
      kv('上次执行', fmtTs(d.lastRun)) +
      (lr ? kv('上次结果', lr.ok + '/' + lr.commands + ' 成功') + kv('上次批次', lr.runId || '-') : '') +
      '</div>';
    document.getElementById('schedStatus').innerHTML = html;
    var histMax = parseInt((CFG.settings || {}).historyMaxRuns, 10) || 2000;
    var histHint = histMax >= 365
      ? ('约 ' + Math.round(histMax / 365) + ' 年')
      : ('约 ' + histMax + ' 天');
    var histHead = '<div class="hint" style="margin:0 0 8px">最多保留 ' + histMax + ' 条执行历史（按每天定时巡检 1 次合' + histHint +
      '；归档截图不受此限制，按归档保留天数留存）。点「查看归档」会跳转到归档留证并高亮该批次；删除历史只删记录，不会删除归档截图。' +
      (isAdmin() ? '<button class="btn tiny ghost" id="btnClearHist" style="margin-left:8px">清空历史</button>' : '') + '</div>';
    foldList(document.getElementById('schedHistory'), d.history, 20,
      function (x) {
        return '<div class="hrow" data-hrow="' + esc(x.runId) + '"><span class="time">' + fmtTs(x.ts) + '</span>' +
          '<span class="badge ' + (x.trigger === 'manual' ? 'run' : 'ok') + '">' + (x.trigger === 'manual' ? '手动' : x.trigger === 'scheduled' ? '定时' : '启动') + '</span>' +
          '<span class="nums">' + x.servers + ' 台 · ' + x.commands + ' 条 · 成功 ' + x.ok + '</span>' +
          '<span class="spacer"></span><button class="btn tiny" data-open-ev data-date="' + esc(x.date) + '" data-runid="' + esc(x.runId) + '">查看归档 ›</button>' +
          (isAdmin() ? '<button class="btn tiny ghost" data-del-hist="' + esc(x.runId) + '" title="删除这条执行历史（不删除归档截图）">删除</button>' : '') +
          '</div>';
      },
      '<div class="hint">暂无执行记录。可点右上角「立即巡检」。</div>',
      function (box) {
        box.querySelectorAll('[data-open-ev]').forEach(function (b) {
          b.onclick = function () { openEvidenceFromHistory(b.getAttribute('data-date'), b.getAttribute('data-runid')); };
        });
        box.querySelectorAll('[data-del-hist]').forEach(function (b) {
          b.onclick = function () { deleteHistory(b.getAttribute('data-del-hist'), b); };
        });
        var clear = document.getElementById('btnClearHist');
        if (clear) clear.onclick = function () { deleteHistory(null, clear); };
      },
      histHead);
  });
}
// 删除执行历史: runId 为空表示清空。只删调度历史记录, 不碰归档留证文件。
// 二次确认防误删, 与锁操作同风格(6 秒内点第二次生效)。
var histDelArmed = {};
function deleteHistory(runId, btn) {
  var all = !runId;
  var key = all ? '__all__' : runId;
  var now = Date.now();
  if (!histDelArmed[key] || histDelArmed[key] < now) {
    histDelArmed[key] = now + 6000;
    showToast(all
      ? '再点一次「清空历史」确认；只删除执行历史记录，不会删除任何归档截图或留证文件。6 秒内有效。'
      : '再点一次「删除」确认删除这条执行历史；不会删除对应归档截图。6 秒内有效。');
    return;
  }
  delete histDelArmed[key];
  setBusy(btn, true, '删除中…');
  api.post('/api/schedule/history', all ? { all: true } : { runId: runId }).then(function (r) {
    setBusy(btn, false);
    if (!r.ok) return showToast('删除失败: ' + (r.error || '未知'), 8000);
    showToast('已删除 ' + def(r.removed, 0) + ' 条执行历史，剩余 ' + def(r.remaining, 0) + ' 条（归档未改动）', 6000);
    refreshSchedule();
  }).catch(function (e) {
    setBusy(btn, false);
    showToast('删除失败: ' + (e && e.message ? e.message : e), 8000);
  });
}
function kv(k, v) { return '<div class="kv-item"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }

// 通用折叠列表: 长列表默认只渲染前 pageSize 条, 避免页面被上千行撑得过长。
// items: 数组; rowHtml(item,i): 单条 HTML; emptyHtml: 空态; bindAfter(box): 渲染后重新绑定事件;
// headHtml/tailHtml: 可选包裹(表格用, 让折叠条落在表格外侧)。
function foldList(box, items, pageSize, rowHtml, emptyHtml, bindAfter, headHtml, tailHtml) {
  items = items || [];
  var shown = pageSize, step = pageSize;
  function draw() {
    if (!items.length) { box.innerHTML = emptyHtml || '<div class="hint">暂无记录。</div>'; return; }
    var n = Math.min(shown, items.length), rows = '';
    for (var i = 0; i < n; i++) rows += rowHtml(items[i], i);
    var h = (headHtml || '') + rows + (tailHtml || '');
    if (items.length > pageSize) {
      h += '<div class="fold-bar">';
      if (shown < items.length) h += '<button class="btn small" data-fold="more">展开更多 ▾</button>';
      if (shown > pageSize) h += '<button class="btn small ghost" data-fold="less">收起 ▴</button>';
      h += '<span class="fold-count">显示 ' + n + ' / ' + items.length + ' 条</span></div>';
    }
    box.innerHTML = h;
    var more = box.querySelector('[data-fold="more"]');
    if (more) more.onclick = function () { shown = Math.min(shown + step, items.length); draw(); };
    var less = box.querySelector('[data-fold="less"]');
    if (less) less.onclick = function () { shown = pageSize; draw(); };
    if (bindAfter) bindAfter(box);
  }
  draw();
}

// ---------------- 存储健康 / 历史检索 ----------------
function fmtBytesJS(b) {
  if (b == null) return '-';
  b = Number(b); if (!isFinite(b) || b < 0) return '-';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b : (Math.round(b * 10) / 10)) + ' ' + u[i];
}
function refreshHealth() {
  var box = document.getElementById('healthBox');
  box.innerHTML = '加载中…';
  api.get('/api/health').then(function (h) {
    var e = h.evidence || {}, idx = h.index || {}, jl = h.jsonl || {};
    var usedPct = 0;
    if (e.total > 0 && e.free != null) usedPct = Math.round((e.total - e.free) / e.total * 100);
    var barCls = usedPct >= 90 ? 'bad' : (usedPct >= 75 ? 'warn' : '');
    var out = '<div class="health-grid">';
    out += kv('归档天数 / 批次数', def(e.days, 0) + ' 天 / ' + def(e.runs, 0) + ' 批');
    out += kv('归档占用', fmtBytesJS(e.bytes) + '<span class="s">' + def(e.files, 0) + ' 个文件</span>');
    out += kv('磁盘可用', fmtBytesJS(e.free) + '<span class="s">共 ' + fmtBytesJS(e.total) + '</span>');
    out += kv('索引批次 / 明细', idx.exists ? (def(idx.runs, 0) + ' 批 / ' + def(idx.commands, 0) + ' 条') : '未建立');
    out += kv('索引内失败命令', idx.exists ? (def(idx.failed, 0) + ' 条') : '-');
    var zp = h.zips || {};
    out += kv('压缩包副本', zp.count > 0 ? (zp.count + ' 个 / ' + fmtBytesJS(zp.bytes) +
      '<span class="s">最近 ' + (zp.lastAt ? fmtTs(zp.lastAt) : '-') + '</span>') : '暂无（历史归档每日自动预压）');
    out += kv('保留策略', def(h.retainDays, 0) > 0 ? ('保留 ' + h.retainDays + ' 天') : '永久保留');
    out += '</div>';
    out += '<div class="bar ' + barCls + '"><span style="width:' + usedPct + '%"></span></div>';
    var warns = h.warnings || [];
    if (warns.length) {
      out += '<div class="alert-line">' + ico('warn') + ' ' + esc(warns.map(function (w) { return w.message; }).join(' ')) + '</div>';
    }
    var sh = h.ssh || {};
    out += '<div class="health-note">磁盘已用 ' + usedPct + '% · 索引引擎: ' +
      (h.python ? esc(h.python) : '无 Python3') + ' · 兜底索引: ' +
      (jl.exists ? ('index.jsonl（' + def(jl.runs, 0) + ' 批）') : '无') +
      (idx.exists ? '' : ' · <b>索引尚未建立</b>，点「重建索引」可从归档文件全量生成') +
      '<br>SSH 并发: ' + def(sh.active, 0) + '/' + def(sh.maxParallel, '-') + '（同机上限 ' + def(sh.perHost, '-') +
      '，排队 ' + def(sh.waiting, 0) + '，瞬时失败自动重试 ' + def(sh.retryMax, 0) + ' 次）' + '</div>';
    box.innerHTML = out;
  }).catch(function (err) { box.innerHTML = '<div class="hint">读取失败: ' + esc(err.message) + '</div>'; });
}
function doReindex() {
  var btn = document.getElementById('btnReindex');
  askConfirm({
    anchor: this || btn,
    title: '重建 SQLite 索引',
    message: '从归档文件全量重建可再生的索引目录。\n原始 .txt / .ansi / .png 留证文件不会被改动。',
    okText: '开始重建',
    onOk: function () {
      btn.disabled = true; btn.textContent = '重建中…';
      api.post('/api/evidence/reindex', {}).then(function (r) {
        btn.disabled = false; btn.innerHTML = ico('wrench') + ' 重建索引';
        if (!r.ok) return showToast('重建失败: ' + (r.error || '未知'), 8000);
        showToast('索引重建完成，共 ' + def(r.result && r.result.runs, 0) + ' 个批次', 6000);
        refreshHealth(); refreshEvidence();
      }).catch(function (e) {
        btn.disabled = false; btn.innerHTML = ico('wrench') + ' 重建索引';
        showToast('重建失败: ' + e.message, 8000);
      });
    }
  });
}
function fillSearchServers() {
  var sel = document.getElementById('qServer'), cur = sel.value;
  var h = '<option value="">全部服务器</option>';
  // 归档与索引都按「服务器名称」区分, 检索下拉也用名称(后端同时兼容 id 匹配)
  (CFG.servers || []).forEach(function (s) { h += '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>'; });
  sel.innerHTML = h; sel.value = cur;
}
function runSearch() {
  var box = document.getElementById('searchResult'), qs = [];
  function add(k, v) { if (v) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); }
  add('q', document.getElementById('qKeyword').value.trim());
  add('server', document.getElementById('qServer').value);
  add('status', document.getElementById('qStatus').value);
  add('from', document.getElementById('qFrom').value.trim());
  add('to', document.getElementById('qTo').value.trim());
  box.innerHTML = '<div class="hint">检索中…</div>';
  api.get('/api/evidence/search' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
    if (!d.available) { box.innerHTML = '<div class="hint">索引不可用：' + esc(d.reason || d.error || '请先执行巡检或重建索引') + '</div>'; return; }
    var rows = d.rows || [];
    if (!rows.length) { box.innerHTML = '<div class="hint">没有匹配的记录。</div>'; return; }
    var head = '<div class="hint">命中 ' + rows.length + ' 条' + (d.source === 'jsonl' ? '（来自 JSONL 兜底索引）' : '（SQLite）') + '，最多 500 条。</div>';
    head += '<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>日期 / 批次</th><th>服务器</th><th>命令</th><th>状态</th><th>留证</th></tr></thead><tbody>';
    var tail = '</tbody></table></div>';
    foldList(box, rows, 50,
      function (r) {
        var shot = '';
        if (r.png && (r.dir || r.date)) {
          // dir 由索引 runs 表提供: 新布局=日期, 旧布局=日期/批次, 两种都能直接拼出 /shot/ 地址
          var u = shotUrl(r.dir || (r.date + '/' + (r.run_id || '')), r.png);
          shot = '<a class="sr-shot" href="' + esc(u) + '" target="_blank">' + ico('image') + ' 打开截图</a>';
        } else if (r.file) {
          shot = '<span class="hint" style="margin:0">' + esc(r.file) + '</span>';
        }
        return '<tr><td>' + esc(fmtTs(r.ts)) + '</td><td>' + esc(def(r.date, '-')) + ' / ' + esc(def(r.run_id, '-')) + '</td>' +
          '<td>' + esc(def(r.server_name, r.server_id)) + '</td>' +
          '<td>' + esc(def(r.command_name, r.command_id)) +
          '<div class="hint" style="margin:0;font-family:var(--font-mono)">' + esc(def(r.command, '')) + '</div></td>' +
          '<td><span class="badge ' + (r.status === 'ok' ? 'ok' : 'off') + '">' + (r.status === 'ok' ? '成功' : '失败') + '</span></td>' +
          '<td>' + shot + '</td></tr>';
      },
      '<div class="hint">没有匹配的记录。</div>', null, head, tail);
  }).catch(function (e) { box.innerHTML = '<div class="hint">检索失败: ' + esc(e.message) + '</div>'; });
}

// ---------------- 归档留证 ----------------
// /shot/ 地址按路径段编码, 兼容中文「服务器名称」目录。
// key=日期 或 日期/批次(旧布局); rel 若已是相对归档根的完整路径, 传 key='' 即可。
function shotUrl(key, rel) {
  var s = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (key) s = String(key).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + s;
  return '/shot/' + s.split('/').filter(function (x) { return x; }).map(function (x) { return encodeURIComponent(x); }).join('/');
}
// 从执行历史点「查看归档」: 跳转到归档留证视图, 展开目标日期, 滚动到对应批次并高亮突出显示。
// runId 形如 20261123_233000 (或 _233000_2) -> 批次 233000 / 233000_2, 与 manifest 的批次号一致。
var evFocus = null; // 待定位的目标: { date, batch }; 渲染完成后由 applyEvidenceFocus 消费
function openEvidenceFromHistory(date, runId) {
  var batch = String(runId || '').replace(/^\d{8}_/, ''); // 去掉日期前缀, 保留 HHMMSS[_n]
  // 清除日期筛选, 避免目标日期被筛掉
  var f = document.getElementById('evFrom'), t = document.getElementById('evTo');
  if (f) f.value = '';
  if (t) t.value = '';
  evFocus = { date: date, batch: batch };
  // 尽可能展开目标日期(无论旧布局 key=日期/批次 还是新布局 key=纯日期)
  if (evidenceDays && evidenceDays.length) {
    evidenceDays.forEach(function (day) {
      if (day.key === date || day.date === date || String(day.key || '').indexOf(date + '/') === 0) {
        evOpenDays[day.key] = true;
      }
    });
  } else {
    // 数据还没加载过, 先记下, 等 /api/evidence 回来后再展开(见 renderEvidenceList)
    evOpenDays[date] = true;
  }
  switchView('evidence');
  // 关键: 归档留证内部还有「存储健康/历史检索/归档记录」三个子页,
  // 不显式切过去的话会停留在上次用的(比如历史检索), 看起来就像跳错了。
  switchEvidencePane('archive');
  showToast('已跳转到 ' + date + ' 的归档，正在定位批次 ' + (batch || '-'), 4000);
}
// 归档列表渲染完成后, 定位并高亮从执行历史跳转来的目标批次。
// 由 renderEvidenceList 末尾调用; 找不到目标时展开更多并重试。
function applyEvidenceFocus() {
  if (!evFocus) return;
  var box = document.getElementById('evidenceList');
  if (!box) return;
  var f = evFocus, block = null, i;
  var blocks = box.querySelectorAll('.day-block');
  for (i = 0; i < blocks.length; i++) {
    var head = blocks[i].querySelector('.day-head');
    var dk = head ? head.getAttribute('data-day') : '';
    if (dk === f.date || String(dk || '').indexOf(f.date + '/') === 0) { block = blocks[i]; break; }
  }
  if (!block) {
    // 目标日可能在 foldList 的折叠分页之外, 点"展开更多"后重绘, 再递归定位。
    var more = box.querySelector('[data-fold="more"]');
    if (more) {
      more.click();
      setTimeout(applyEvidenceFocus, 0); // DOM 已重绘, 重新查找目标
      return;
    }
    evFocus = null;
    showToast('未找到 ' + f.date + ' 的归档（可能已过保留期）', 5000);
    return;
  }
  evFocus = null;
  // 目标批次行(按 data-batch-tag 精确匹配), 找不到就高亮整天。
  var target = block;
  if (f.batch) {
    var rows = block.querySelectorAll('.batch-row');
    for (i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-batch-tag') === f.batch) { target = rows[i]; break; }
    }
  }
  target.classList.add('ev-focus');
  try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
  setTimeout(function () { target.classList.remove('ev-focus'); }, 5000);
}
// ---------- 归档记录: 日期筛选 + 按批次展示 + zip 下载 ----------
var evidenceDays = [];   // /api/evidence 原始数据缓存, 筛选只在前端做, 不重复请求
var evOpenDays = {};     // key -> 展开状态; 默认全部折叠, 只显示标题行, 点标题展开
var evLockInfo = { days: {}, supported: true }; // 每日防删除标记状态, 与归档列表一起刷新
var evLockAllLocked = false;                    // 顶部锁图形当前状态: true=全部已上锁
function renderLockAllToggle() {
  var wrap = document.getElementById('lockAllWrap');
  var el = document.getElementById('btnLockAllToggle');
  if (!wrap || !el) return;
  if (!evLockInfo.supported) { wrap.hidden = true; return; }
  wrap.hidden = false;
  var locked = evLockAllLocked;
  el.className = 'lock-toggle ' + (locked ? 'locked' : 'unlocked');
  el.innerHTML = ico(locked ? 'lock' : 'unlock');
  el.title = locked
    ? '全部留证已上锁 · 点击全部解锁'
    : '有留证未上锁 · 点击给全部上锁';
}
function refreshEvidence() {
  api.get('/api/evidence').then(function (d) {
    evidenceDays = d.days || [];
    // 从执行历史跳转来且首次加载: 按 day.key/date 展开目标日(兼容旧布局 key=日期/批次)
    if (evFocus) {
      evidenceDays.forEach(function (day) {
        if (day.key === evFocus.date || day.date === evFocus.date || String(day.key || '').indexOf(evFocus.date + '/') === 0) {
          evOpenDays[day.key] = true;
        }
      });
    }
    renderEvidenceList();
  });
  // 保护状态单独取, 失败不影响归档列表显示
  api.get('/api/evidence/immutable-status').then(function (s) {
    if (s && s.ok) {
      evLockInfo = { days: s.days || {}, supported: s.supported !== false };
      evLockAllLocked = (s.unlockedDays || []).length === 0 && Object.keys(s.days || {}).length > 0;
    }
    renderLockAllToggle();
    renderEvidenceList();
  }).catch(function () {});
}
function triggerText(t) { return t === 'manual' ? '手动' : t === 'scheduled' ? '定时' : t === 'startup' ? '启动' : t === 'unknown' ? '未知' : (t || '-'); }
function renderEvidenceList() {
  var box = document.getElementById('evidenceList');
  var from = String((document.getElementById('evFrom') || {}).value || '').trim();
  var to = String((document.getElementById('evTo') || {}).value || '').trim();
  var days = evidenceDays.filter(function (day) {
    var dd = String(day.date || day.key || '').slice(0, 10);
    if (from && dd < from) return false;
    if (to && dd > to) return false;
    return true;
  });
  var nBatch = 0;
  days.forEach(function (day) { nBatch += (day.batches || []).length || 1; });
  var stat = document.getElementById('evFilterStat');
  if (stat) stat.textContent = '命中 ' + days.length + ' 天 / ' + nBatch + ' 个批次';
  foldList(box, days, 6, renderEvidenceDay,
    from || to
      ? '<div class="hint">所选日期范围内没有归档，可点「清除筛选」查看全部。</div>'
      : '<div class="hint">暂无归档。执行巡检后，截图与原始输出会保存到这里。</div>',
    bindEvidenceDay);
  if (evFocus) applyEvidenceFocus(); // 从执行历史跳转来: 渲染后定位高亮
}
// 锁图形: 已全锁=绿色闭合锁, 未全锁=黄色开锁; 点击直接切换(上锁/解锁)。
function lockIcon(dayKey) {
  if (!evLockInfo.supported) return '';
  var st = evLockInfo.days[String(dayKey).split('/')[0]];
  if (!st || !st.total) return '';
  var locked = st.unlocked === 0;
  var tip = locked
    ? '该日 ' + st.locked + '/' + st.total + ' 个留证已全部上锁 · 点击解锁'
    : '该日 ' + st.locked + '/' + st.total + ' 个留证已上锁 · 点击给未上锁的上锁';
  return '<span class="lock-toggle ' + (locked ? 'locked' : 'unlocked') + '" data-locktoggle="' + esc(dayKey) +
    '" title="' + tip + '">' + ico(locked ? 'lock' : 'unlock') + '</span>';
}
function renderEvidenceDay(day) {
  var s = day.summary || {}, bs = day.batches || [];
  var open = !!evOpenDays[day.key];
  var h = '<div class="day-block' + (open ? ' ev-open' : '') + '">';
  // 标题行(可点击折叠/展开): 箭头 + 日期 + 汇总统计 + 锁图形 + 下载整日
  h += '<div class="day-head" data-day="' + esc(day.key) + '" title="点击展开/收起该日明细">' +
    '<span class="fold-arrow">' + (open ? '▾' : '▸') + '</span>' +
    ico('calendar') + ' <b>' + esc(day.label || day.date) + '</b>' +
    '<span class="nums">' + bs.length + ' 个批次 · ' + def(s.dayCommands, s.commands || '-') + ' 条 · 成功 ' +
    def(s.dayOk, s.ok || '-') + ' · 截图 ' + def(s.dayShots, s.shots || '-') + ' 张</span>' +
    lockIcon(day.key) +
    (day.recovered ? '<span class="badge warn" title="日期汇总文件缺失, 统计仅在页面里按现存文件恢复; 清单未能写回磁盘(只读/权限), 原始留证未改动">汇总缺失·已恢复(仅页面)</span>'
      : (day.summary && day.summary.recovered ? '<span class="badge warn" title="00_summary.json / manifest.csv / SHA256SUMS 已按现存文件重建写回磁盘; manifest 中主机/命令ID/命令原文/时间/状态/字节数无法从文件名还原, 留空; 成功数按现存文件数推定; 触发方式优先查执行历史与索引, 查不到显示「未知」">汇总缺失·已重建</span>' : '')) +
    '<span class="flex-sp"></span>' +
    '<button class="btn tiny ghost" data-dl="' + esc(day.key) + '" data-batch="">' + ico('download') + ' 下载整日</button>' +
    '<button class="btn tiny ghost" data-reshoot="' + esc(day.key) + '" title="从 .ansi 原始输出按当前截图设置(列宽/行数/主题)重新渲染 PNG, 原始留证不动">' + ico('refresh') + ' 重出截图</button>' +
    '</div>';
  if (!open) return h + '</div>';
  // 展开内容统一缩进到 day-detail 里, 与日期标题形成明确的上下级
  h += '<div class="day-detail">';
  // 展开后: 批次明细 + 服务器入口(整日统计已在标题行, 不再重复)
  if (bs.length) {
    h += '<div class="batch-list">';
    bs.forEach(function (b) {
      var shotTxt = def(b.shots, '-') > 0 ? ' · 截图 ' + def(b.shots, 0) : '';
      // 失败原因随批次落盘(failures[]); 悬停"失败 N"即可看到每条的服务器/命令/分类/原因。
      var failTitle = (b.failures || []).map(function (f) {
        return (f.server || '?') + ' / ' + (f.command || '?') + ' [' +
          (f.categoryText || failKindText(f.category)) + '] ' + String(f.error || '').split('\n')[0];
      }).join('\n');
      if (!failTitle) failTitle = '失败 ' + def(b.failed, 0) + ' 条；原因详见 00_summary.json 的 failures 字段、manifest.csv 末两列，或服务端 logs/server.log';
      h += '<div class="batch-row" data-batch-tag="' + esc(b.tag) + '">' +
        '<span class="batch-tag">' + ico('clock') + ' ' + esc(b.label || b.tag) + '</span>' +
        '<span class="badge ' + ((b.ok || 0) > 0 ? 'ok' : 'off') + '">' + ((b.ok || 0) > 0 ? '成功 ' + b.ok : '成功 0') + '</span>' +
        ((b.failed || 0) > 0 ? '<span class="badge off" title="' + esc(failTitle) + '">失败 ' + b.failed + '</span>' : '') +
        '<span class="nums">' + def(b.commands, '-') + ' 条' + shotTxt +
        ' · ' + esc(triggerText(b.trigger)) + '</span>' +
        '<span class="flex-sp"></span>' +
        '<button class="btn tiny ghost" data-dl="' + esc(day.key) + '" data-batch="' + esc(b.tag) + '">' +
        ico('download') + ' 下载本批次</button>' +
        '</div>';
    });
    h += '</div>';
  } else {
    h += '<div class="hint" style="margin:6px 0">该日无批次明细（旧归档），可整日下载。</div>';
  }
  // 服务器入口: 再缩进一级, 与批次形成"天 > 批次 > 服务器"三级
  h += '<div class="srv-label">' + ico('server') + ' 服务器（' + (day.servers || []).length + ' 台）</div>';
  h += '<div class="srv-chips">';
  (day.servers || []).forEach(function (sv) {
    h += '<button class="chip" data-key="' + esc(day.key) + '" data-folder="' + esc(sv.folder) + '" data-name="' + esc(sv.name) + '">' +
      ico('server') + ' ' + esc(sv.name) + ' <span class="hint" style="margin:0">(' + def(sv.pngCount, 0) + ' 张截图)</span></button>';
  });
  if (!(day.servers || []).length) h += '<span class="hint" style="margin:0">该日暂无服务器目录</span>';
  return h + '</div></div></div>';
}
function bindEvidenceDay(b) {
  b.querySelectorAll('[data-key][data-folder]').forEach(function (btn) {
    btn.onclick = function () { openRunServer(btn.getAttribute('data-key'), btn.getAttribute('data-folder'), btn.getAttribute('data-name')); };
  });
  b.querySelectorAll('[data-dl]').forEach(function (btn) {
    btn.onclick = function () {
      downloadArchive(btn.getAttribute('data-dl'), btn.getAttribute('data-batch'), btn);
    };
  });
  b.querySelectorAll('[data-reshoot]').forEach(function (btn) {
    btn.onclick = function () {
      reshootDay(btn.getAttribute('data-reshoot'), btn);
    };
  });
  // 点击锁图形切换上锁/解锁: 已全锁则解锁, 否则上锁
  b.querySelectorAll('[data-locktoggle]').forEach(function (el) {
    el.onclick = function (e) {
      if (e.stopPropagation) e.stopPropagation();
      var key = el.getAttribute('data-locktoggle');
      var st = evLockInfo.days[String(key).split('/')[0]];
      if (st && st.unlocked === 0) doUnlockDay(key, el); else doLockDay(key, el);
    };
  });
  // 标题行折叠/展开: 点按钮(下载/锁图形)不触发切换
  b.querySelectorAll('.day-head').forEach(function (head) {
    head.onclick = function (e) {
      if (e.target.closest && (e.target.closest('button') || e.target.closest('.lock-toggle'))) return;
      var key = head.getAttribute('data-day');
      evOpenDays[key] = !evOpenDays[key];
      renderEvidenceList();
    };
  });
}
// 下载归档压缩包: fetch 带 cookie, 失败可提示; 成功后用 blob 触发浏览器下载。
// 重新生成某天的归档截图: 后端从 .ansi 重渲染 PNG, 原始留证不动。
// 不用原生 confirm/alert: 弹窗若被浏览器藏到后面, 页面会一直被锁住, 看板点不动。
var reshootArmed = {};
function reshootDay(key, btn) {
  var now = Date.now();
  if (!reshootArmed[key] || reshootArmed[key] < now) {
    reshootArmed[key] = now + 6000;
    if (btn) {
      var old = btn.innerHTML, oldTitle = btn.title || '';
      btn.innerHTML = '再点一次确认';
      btn.title = '6 秒内再次点击确认重出截图';
      setTimeout(function () {
        if (document.body.contains(btn) && !btn.disabled && btn.innerHTML === '再点一次确认') {
          btn.innerHTML = old; btn.title = oldTitle;
        }
      }, 6000);
    }
    showToast('再点一次「重出截图」确认执行；6 秒内不操作自动取消。\n将按当前设置替换该日 PNG，原始 .txt/.ansi 不动。');
    return;
  }
  delete reshootArmed[key];
  var oldHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '重渲染中…'; }
  api.post('/api/evidence/reshoot', { key: key }).then(function (r) {
    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
    if (!r.ok) return showToast('重出截图失败: ' + (r.error || '未知'), 8000);
    var st = r.result || {};
    showToast('重出截图完成: 成功 ' + def(st.ok, 0) + ' / 共 ' + def(st.total, 0) + ' 张' +
      (def(st.failed, 0) > 0 ? '\n失败 ' + st.failed + ' 张(详见服务日志)' : ''));
    refreshEvidence(); refreshHealth();
  }).catch(function (e) {
    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
    showToast('重出截图失败: ' + (e && e.message ? e.message : e), 8000);
  });
}

// 锁图形/按钮处理中状态: 锁图形只加 busy 类保留图标, 普通按钮才换文字
function setBusy(el, on, text) {
  if (!el) return;
  var isToggle = el.className && String(el.className).indexOf('lock-toggle') >= 0;
  if (isToggle) {
    if (on) el.className = String(el.className).replace(/\bbusy\b\s*/, '') + ' busy';
    else el.className = String(el.className).replace(/\bbusy\b\s*/, '').trim();
  } else {
    if (on) { el.disabled = true; el.setAttribute('data-busy-html', el.innerHTML); el.innerHTML = text; }
    else { el.disabled = false; var h = el.getAttribute('data-busy-html'); if (h != null) { el.innerHTML = h; el.removeAttribute('data-busy-html'); } }
  }
}
// 历史留证上锁: 只加 chattr +i, 不改内容。二次确认防误点, 与重出截图共用非模态确认。
var lockArmed = {};
function doLockDay(key, btn) {
  var now = Date.now();
  if (!lockArmed[key] || lockArmed[key] < now) {
    lockArmed[key] = now + 6000;
    showToast('再点一次「上锁」确认给 ' + key + ' 的历史留证加防删除标记；\n只加标记，不改截图内容、清单与校验。6 秒内有效。');
    return;
  }
  delete lockArmed[key];
  setBusy(btn, true, '上锁中…');
  api.post('/api/evidence/lock', { key: key }).then(function (r) {
    setBusy(btn, false);
    if (!r.ok) return showToast('上锁失败: ' + (r.error || '未知'), 8000);
    showToast('上锁完成: ' + key + ' · 已保护 ' + def(r.locked, 0) + '/' + def(r.total, 0) +
      '（本次新增 ' + def(r.newly, 0) + '）' + (r.note && r.supported === false ? '\n' + r.note : ''), 8000);
    refreshEvidence();
  }).catch(function (e) {
    setBusy(btn, false);
    showToast('上锁失败: ' + (e && e.message ? e.message : e), 8000);
  });
}
function doLockAll(btn) {
  if (!confirmLockAll()) return;
  setBusy(btn, true, '上锁中…');
  api.post('/api/evidence/lock', { all: true }).then(function (r) {
    setBusy(btn, false);
    if (!r.ok) return showToast('上锁失败: ' + (r.error || '未知'), 8000);
    showToast('上锁完成: ' + def(r.days, 0) + ' 天 · 已保护 ' + def(r.locked, 0) + '/' + def(r.total, 0) +
      '（本次新增 ' + def(r.newly, 0) + '）' +
      (def(r.failed, 0) ? ' · 失败 ' + r.failed + ' 天' : '') +
      (def(r.skipped, 0) ? ' · 不适用 ' + r.skipped + ' 天' : ''), 8000);
    refreshEvidence();
  }).catch(function (e) {
    setBusy(btn, false);
    showToast('上锁失败: ' + (e && e.message ? e.message : e), 8000);
  });
}
var lockAllArmed = 0, lockAllArmedAct = '';
function confirmLockAll(act) {
  act = act || '上锁';
  var now = Date.now();
  if (lockAllArmed > now && lockAllArmedAct === act) { lockAllArmed = 0; lockAllArmedAct = ''; return true; }
  lockAllArmed = now + 6000; lockAllArmedAct = act;
  showToast('再点一次「全部' + act + '」确认；' +
    (act === '解锁' ? '只解除防删除标记，不改任何内容' : '只加防删除标记，不改任何内容') +
    '。6 秒内有效。');
  return false;
}

// 单独解锁: 只解除 chattr +i, 不改内容。二次确认防误点。
var unlockArmed = {};
function doUnlockDay(key, btn) {
  var now = Date.now();
  if (!unlockArmed[key] || unlockArmed[key] < now) {
    unlockArmed[key] = now + 6000;
    showToast('再点一次「解锁」确认解除 ' + key + ' 的防删除标记；\n只解锁，不改文件内容。6 秒内有效。');
    return;
  }
  delete unlockArmed[key];
  setBusy(btn, true, '解锁中…');
  api.post('/api/evidence/unlock', { key: key }).then(function (r) {
    setBusy(btn, false);
    if (!r.ok) return showToast('解锁失败: ' + (r.error || '未知'), 8000);
    showToast('解锁完成: ' + key + ' · 已解除 ' + def(r.removed, 0) + ' 个标记 · 剩余保护 ' + def(r.locked, 0) + '/' + def(r.total, 0), 8000);
    refreshEvidence();
  }).catch(function (e) {
    setBusy(btn, false);
    showToast('解锁失败: ' + (e && e.message ? e.message : e), 8000);
  });
}
function doUnlockAll(btn) {
  if (!confirmLockAll('解锁')) return;
  setBusy(btn, true, '解锁中…');
  api.post('/api/evidence/unlock', { all: true }).then(function (r) {
    setBusy(btn, false);
    if (!r.ok) return showToast('解锁失败: ' + (r.error || '未知'), 8000);
    showToast('解锁完成: ' + def(r.days, 0) + ' 天 · 已解除 ' + def(r.removed, 0) + ' 个标记 · 剩余保护 ' +
      (def(r.total, 0) - def(r.unlocked, 0)) + '/' + def(r.total, 0) +
      (def(r.failed, 0) ? ' · 失败 ' + r.failed + ' 天' : '') +
      (def(r.skipped, 0) ? ' · 不适用 ' + r.skipped + ' 天' : ''), 8000);
    refreshEvidence();
  }).catch(function (e) {
    setBusy(btn, false);
    showToast('解锁失败: ' + (e && e.message ? e.message : e), 8000);
  });
}

// base64 文本还原成 zip Blob(纯 ASCII 网络上传输, 见服务端 safe=1 通道)。
function b64ToBlob(b64) {
  var bin = atob(String(b64).replace(/\s+/g, ''));
  var len = bin.length, arr = new Uint8Array(len), i;
  for (i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: 'application/zip' });
}
// 内网网关会在「新会话 / 新建连接」的前几次请求上按响应特征直接 RST
// (net::ERR_CONNECTION_RESET / fetch failed), 几次之后才进入快速转发, 表现为
// 「首次登录点下载前 2~5 次失败, 之后一直正常」。这里: ① 走 safe=1 纯 ASCII
// 通道让响应不含中文命令名/二进制特征; ② 仅网络中断/5xx 才重试 3 次, 间隔递增。
// 下载闸门: 状态放在全局, 不绑在按钮 DOM 上 —— 归档列表重绘会换掉按钮,
// 只靠 btn.disabled 会失效。同一时刻只允许一条下载链, 同一个归档/批次在途时
// 重复点击直接忽略(零请求)。因此无论用户点多快、页面重绘多少次, 一次交互
// 最多 MAX(=4) 个请求, 不会刷出几十个请求撞上网关的频率封禁。
var DL_GATE = { token: null, busy: false, cooldown: {}, fails: {} };
// 一条链最终失败后同一归档进入冷却, 且连续失败逐轮加倍(6/12/18…上限 30 秒),
// 防止"一直失败 → 一直连点"把 4 次/轮滚成持续刷请求。刷新页面会重置全部状态。
function downloadArchive(key, batch, btn) {
  var taskKey = String(key) + '|' + String(batch || '');
  // ⓪ 失败冷却: 上一条链已用尽重试, 短时间内不再重新发包(刷新页面可立即重置)。
  if (Date.now() < (DL_GATE.cooldown[taskKey] || 0)) {
    showToast('下载刚失败，请稍等几秒再试；刷新页面可立即重试', 3500, 'dl-busy');
    return;
  }
  // ① 同一个下载已在途中(也包括页面重绘后新按钮的重复点击): 不发任何请求。
  if (DL_GATE.token === taskKey) {
    showToast('该归档正在下载中，请稍候', 2500, 'dl-busy');
    return;
  }
  // ② 已有别的下载链在跑: 不排队(排队只会把请求堆进网关的计数窗口), 提示后忽略。
  if (DL_GATE.busy) {
    showToast('已有下载在进行中，请等它完成再点', 3000, 'dl-busy');
    return;
  }
  DL_GATE.busy = true;
  DL_GATE.token = taskKey;

  var base = '/api/evidence/download?key=' + encodeURIComponent(key) +
    (batch ? '&batch=' + encodeURIComponent(batch) : '');
  var fileName = '巡检留证_' + String(key).replace(/\//g, '-') + (batch ? '_' + batch : '') + '.zip';
  var oldHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '打包中…'; }
  var done = false;
  // 必须幂等且覆盖所有出口: 闸门卡住会导致之后再也下载不了, 比多几个请求更糟。
  function finish() {
    if (done) return;
    done = true;
    DL_GATE.busy = false;
    DL_GATE.token = null;
    if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; }
  }
  var MAX = 4, tries = 0; // 共 4 次尝试(1 次正常 + 3 次重试), 硬上限, 不随点击次数放大
  function save(blob) {
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 30000);
    } catch (err) {
      showToast('保存文件失败: ' + (err && err.message ? err.message : err), 8000);
    } finally {
      delete DL_GATE.cooldown[taskKey];
      delete DL_GATE.fails[taskKey];
      finish();
    }
  }
  function attempt() {
    tries++;
    // 时间戳参数避免透明代理复用旧连接/缓存旧响应; no-store 同理。
    var url = base + '&safe=1&_=' + Date.now();
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (r.status === 401) {
        try { location.replace('/login.html'); } catch (e) {}
        var ne = new Error('未登录'); ne.noRetry = true; throw ne;
      }
      if (!r.ok) { var he = new Error('HTTP ' + r.status); he.status = r.status; throw he; }
      var ct = r.headers.get('content-type') || '';
      // 兼容尚未部署 safe 通道的旧服务端: 它直接返回 application/zip 二进制。
      if (ct.indexOf('text/plain') >= 0) return r.text().then(b64ToBlob);
      return r.blob();
    }).then(save, function (e) {
      if (e && e.noRetry) { finish(); return; } // 会话过期直接跳登录, 不重试
      // 只对「连接被重置 / fetch failed」这类网络层中断与服务端 5xx 重试;
      // 4xx(参数错/无权限/文件不存在)重试没意义, 只会白白多打请求。
      var st = e && e.status;
      var retryable = !st || st >= 500;
      if (retryable && tries < MAX) {
        if (btn) btn.innerHTML = '重试 ' + tries + '/' + MAX + '…';
        setTimeout(attempt, 400 + tries * 450); // 850/1300/1750ms, 4 次请求摊在约 4 秒内
      } else {
        finish();
        var fails = (DL_GATE.fails[taskKey] || 0) + 1;
        DL_GATE.fails[taskKey] = fails;
        DL_GATE.cooldown[taskKey] = Date.now() + Math.min(6000 * fails, 30000);
        var em = e && e.message ? e.message : String(e);
        // 无 HTTP 状态码 = 连接层被重置; 此时浏览器连接池里可能全是死连接,
        // 刷新页面重建连接池往往一次就成功, 给出可操作的建议而不是干等。
        showToast('下载失败: ' + em + (st ? '' : '（刷新页面后重试通常可解决）'), 8000);
      }
    });
  }
  attempt();
}
function parseCsv(line) {
  line = String(def(line, '')).replace(/^\ufeff/, ''); // 剥离 Excel 兼容用的 UTF-8 BOM
  var out = '', inQ = false;
  for (var i = 0; i < line.length; i++) { var c = line.charAt(i); if (c === '"') { inQ = !inQ; continue; } if (c === ',' && !inQ) { out += '\u0001'; continue; } out += c; }
  return out.split('\u0001');
}
// 以磁盘上真实存在的 PNG 为准展示归档画面; manifest.csv 仅用于补充命令名/状态。
// 这样即使清单列格式变化、漏写截图列或服务器重名, 也不会出现「有截图却看不到」。
function openRunServer(key, folder, displayName) {
  api.get('/api/evidence/shots?key=' + encodeURIComponent(key) + '&folder=' + encodeURIComponent(folder)).then(function (d) {
    var shots = def(d.shots, []);
    api.get('/api/evidence/read?file=' + encodeURIComponent(key + '/manifest.csv')).then(function (m) {
      renderArchiveShots(shots, parseArchiveMeta(m.text), key, folder, displayName);
    }, function () {
      renderArchiveShots(shots, {}, key, folder, displayName);
    });
  }, function () { showToast('读取归档目录失败'); });
}
// 尽力解析清单, 以截图文件名为键; 任何列缺失都只是少一点说明文字, 不影响图片显示。
function parseArchiveMeta(text) {
  var meta = {};
  String(def(text, '')).replace(/^\ufeff/, '').split('\n').forEach(function (line) {
    if (!line.trim()) return;
    var c = parseCsv(line);
    if (c.length < 13) return;
    var pngName = String(c[10] || '').replace(/\\/g, '/').split('/').pop();
    if (!pngName) pngName = String(c[12] || '').replace(/\\/g, '/').split('/').pop().replace(/\.ansi$/i, '.png');
    if (!pngName) return;
    meta[pngName] = { seq: c[1], commandName: c[5], command: c[6], status: c[8] };
  });
  return meta;
}
function prettyShotName(name, folder) {
  var s = String(name).replace(/\.png$/i, '').replace(/^\d{6}_\d+_/, '');
  if (folder && s.indexOf(folder + '_') === 0) s = s.slice(folder.length + 1);
  return s || name;
}
// 从截图文件名提取批次号: 前缀 HHMMSS 或 HHMMSS_2 (同一天第2次巡检)。
// 无批次前缀(极旧归档)返回 ''。
function shotBatchTag(name) {
  // 文件名格式: <批次HHMMSS 或 HHMMSS_2>_<3位序号>_<服务器>_<命令>.png
  // 序号固定3位, 用它做锚点避免把序号误吞进批次号。
  var m = String(name).match(/^(\d{6}(?:_\d+)?)_\d{3}_/);
  return m ? m[1] : '';
}
function fmtBatchTime(tag) {
  var m = String(tag).match(/^(\d{2})(\d{2})(\d{2})/);
  if (!m) return tag;
  var suffix = String(tag).match(/^(\d{6})_(\d+)$/);
  return m[1] + ':' + m[2] + ':' + m[3] + (suffix ? '（第' + suffix[2] + '次）' : '');
}
function renderArchiveShots(shots, meta, key, folder, displayName, batch) {
  var html = '<div class="hint">以下为巡检时自动生成并落盘的「服务器原生样式」终端截图，与 .txt / .ansi 一起平铺在归档目录 <b>' +
    esc(folder) + '</b> 下，可直接整夹拷贝。点击图片查看大图。</div>';
  if (!shots.length) {
    html += batch
      ? '<div class="hint">该巡检批次（' + ico('clock') + ' ' + esc(fmtBatchTime(batch)) + '）没有生成截图，说明这次巡检没有采集成功任何命令。</div>'
      : '<div class="hint">该目录下未找到 PNG（可能采集时未开启截图，或 Python 渲染失败）。</div>';
  }
  // 按批次号分组: 同一天多次巡检的截图分批展示, 各自标注巡检时间, 不再混在一起。
  var groups = [], byTag = {};
  shots.forEach(function (sh) {
    var tag = shotBatchTag(sh.name);
    if (!byTag[tag]) { byTag[tag] = []; groups.push(tag); }
    byTag[tag].push(sh);
  });
  // 有批次号时按时间正序; 无批次号的旧归档放最后。
  groups.sort(function (a, b) {
    if (!a) return 1; if (!b) return -1; return a < b ? -1 : a > b ? 1 : 0;
  });
  groups.forEach(function (tag) {
    if (tag) {
      html += '<div class="batch-head"><span class="batch-tag">' + ico('clock') + ' 巡检批次 ' + esc(fmtBatchTime(tag)) +
        '</span><span class="batch-count">' + byTag[tag].length + ' 张截图</span></div>';
    }
    byTag[tag].forEach(function (sh) {
      var m = meta[sh.name] || {}, u = shotUrl('', sh.rel);
      html += '<div class="shot-block"><div class="hrow">' +
        '<span class="time">' + esc((m.seq ? m.seq + ' ' : '') + (m.commandName || prettyShotName(sh.name, folder))) + '</span>' +
        (m.status ? '<span class="badge ' + (m.status === 'ok' ? 'ok' : 'off') + '">' + (m.status === 'ok' ? '成功' : '失败') + '</span>' : '') +
        (m.command ? '<span class="nums">' + esc(m.command) + '</span>' : '') + '<span class="spacer"></span>' +
        '<button class="btn tiny" data-imgsrc="' + esc(u) + '">' + ico('search') + ' 查看大图</button>' +
        '<button class="btn tiny" data-dlsrc="' + esc(u) + '">↓ 下载 PNG</button>' +
        '</div><img class="shot-img" src="' + esc(u) + '" alt="' + esc(m.commandName || sh.name) + ' 终端截图" /></div>';
    });
  });
  document.getElementById('detailTitle').textContent = '归档画面 · ' + key + '/' + displayName + (batch ? ' · 批次 ' + fmtBatchTime(batch) : '');
  document.getElementById('detailTerminal').innerHTML = html;
  document.getElementById('detailModal').hidden = false;
  document.getElementById('btnDownloadShot').style.display = 'none';
  document.querySelectorAll('[data-imgsrc]').forEach(function (b) {
    b.onclick = function () { window.open(b.getAttribute('data-imgsrc'), '_blank'); };
  });
  // 下载按钮: 之前用 <a download> 在部分浏览器里不可见, 改成标准 button + 临时链接触发。
  document.querySelectorAll('[data-dlsrc]').forEach(function (b) {
    b.onclick = function () {
      var a = document.createElement('a');
      a.href = b.getAttribute('data-dlsrc');
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
  });
}

// ---------------- 终端画面 PNG 导出 ----------------
function openDetail(name, host, command, ts, raw) {
  detailCtx = { name: name, host: host, command: command, ts: ts, raw: raw };
  document.getElementById('detailTitle').textContent = '终端画面 · ' + name;
  // ansiToHtml 内部已对每个字符做 esc(), 这里必须传原文; 若提前 esc() 会双重转义,
  // 使命令里的 " 变成字面文本 &quot;(PNG 走 canvas fillText 不经 HTML, 故截图正常)。
  document.getElementById('detailTerminal').innerHTML = ansiToHtml('\x1b[36m[root@' + (host || name) + ' ~]#\x1b[0m ' + command + '\n' + raw);
  document.getElementById('btnDownloadShot').style.display = '';
  document.getElementById('detailModal').hidden = false;
}
function downloadDetailShot() { renderTerminalPng(detailCtx); }
// 卡片上的截图按钮
document.addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('[data-shot]') : null;
  if (b && currentCmd) {
    var sid = b.getAttribute('data-shot');
    var srv = (STATUS.servers || []).find(function (s) { return s.id === sid; });
    fetchTerm(sid, currentCmd).then(function (r) {
      if (!r.latest) return showToast('暂无数据');
      openDetail(srv.name, srv.host, r.latest.command, r.latest.ts, r.latest.raw);
    });
  }
});
function renderTerminalPng(ctxInfo) {
  // 统一走后端渲染管线(/api/render-shot): 与归档截图同一套列宽/最大行数/主题/字号设置,
  // 超宽长行折行、超长输出截断提示, 不再前端 Canvas 手绘(旧实现按最长行无限加宽)。
  var btn = document.getElementById('btnDownloadShot');
  var oldHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '渲染中…'; }
  var restore = function () { if (btn) { btn.disabled = false; btn.innerHTML = oldHtml; } };
  fetch('/api/render-shot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: ctxInfo.name, host: ctxInfo.host, command: ctxInfo.command,
      ts: fmtTs(ctxInfo.ts), raw: String(def(ctxInfo.raw, ''))
    })
  }).then(function (r) {
    if (r.status === 401) { try { location.replace('/login.html'); } catch (e) {} throw new Error('未登录'); }
    var ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('json') >= 0) {
      return r.json().then(function (j) {
        // 404 not found = 服务端没有该接口: 前端是新文件但后端还是旧版本, 需部署新版 server.js 并重启
        if (r.status === 404) throw new Error('服务端版本过旧(无此接口), 请部署新版 server.js 后重启服务');
        throw new Error(j.error || '渲染失败');
      });
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }).then(function (blob) {
    var safe = String(ctxInfo.name || 'server').replace(/[\\/:*?"<>|]/g, '_');
    var ts = ctxInfo.ts ? new Date(ctxInfo.ts).toISOString().slice(0, 19).replace(/[:T]/g, '-') : 'shot';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '巡检截图_' + safe + '_' + ts + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 30000);
  }).then(restore, function (e) {
    restore();
    showToast('截图下载失败: ' + (e && e.message ? e.message : e));
  });
}
boot();

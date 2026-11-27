/* 登录页逻辑 - 原生 JS, 零依赖, 兼容 Firefox 115 ESR */
(function () {
  var form = document.getElementById('loginForm');
  var btn = document.getElementById('btnLogin');
  var msg = document.getElementById('msg');
  var userInput = document.getElementById('username');
  var passInput = document.getElementById('password');

  // 已登录则直接进主页(避免登录后手动刷新又回到登录页)
  fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.authenticated) location.replace('/');
  }).catch(function () {});

  function show(text) { msg.textContent = text || ''; }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var u = userInput.value.trim(), p = passInput.value;
    if (!u || !p) { show('请输入用户名和密码'); return; }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>登录中…';
    show('');
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; });
    }).then(function (res) {
      if (res.status === 200 && res.data.ok) {
        location.replace('/');
      } else {
        show(res.data.error || '登录失败, 请重试');
        btn.disabled = false;
        btn.textContent = '登 录';
        passInput.value = '';
        passInput.focus();
      }
    }).catch(function () {
      show('无法连接服务, 请稍后重试');
      btn.disabled = false;
      btn.textContent = '登 录';
    });
  });

  userInput.focus();
})();

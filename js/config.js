/**
 * 安居安全评估 · 配置
 * Key 支持四级覆盖：URL 参数 ?key=xxx&sec=xxx  >  localStorage  >  config.local.js  >  此处默认值
 *
 * 安全提醒（必读）：
 * 1. 前端静态站无法真正藏住 Key——任何写在页面里的 Key 都能被看到。
 *    真正的防线是【高德控制台 → 应用管理 → 该 Key → 域名白名单】，
 *    必须把 Key 限制在自己的域名上，否则任何人都能拿它刷配额、甚至拖到 Key 被封。
 * 2. 本仓库曾把 Key 与安全密钥明文提交过，请务必在高德控制台【轮换】Key 与
 *    securityJsCode，再清理 Git 历史。
 * 3. 想把 Key 完全移出仓库：新建 js/config.local.js（已在 .gitignore 中）
 *       window.RS_LOCAL = { key: '你的Key', sec: '你的安全密钥' };
 *    并把下面两个默认值留空。
 */
(function () {
  var q = new URLSearchParams(location.search);
  var ls = {};
  try { ls = JSON.parse(localStorage.getItem('rentsafe.cfg') || '{}'); } catch (e) {}
  var local = window.RS_LOCAL || {};

  var cfg = {
    // 高德 Web 端(JS API) Key —— 注意：Web 服务 REST 接口不接受此类型 Key
    key: q.get('key') || ls.key || local.key || '190c463e3a7e70c8d2f80a738974ffae',
    securityJsCode: q.get('sec') || ls.sec || local.sec || 'b9eefe6c9c0c5723917926f033747ffd',
    // 检索半径（米）
    radius: 3000,
    // 检索节流：两次请求之间的最小间隔（毫秒）。
    // 实测 200 ms 会被高德限流（15 个请求里 6 个返回 error 并被丢弃），350 ms 可稳定跑满
    gap: 350,
    // 城市限制（留空则全国）
    city: '',
    // 允许携带 Key 访问高德的来源域名（防止整站被搬到别处继续刷这个 Key）
    // 本地调试可用 localStorage: rentsafe.cfg = {"host":"192.168.x.x"} 放行局域网 IP
    allowedHosts: ['lisazhang7711.github.io', 'localhost', '127.0.0.1'].concat(ls.host ? [ls.host] : [])
  };

  cfg.hostAllowed = cfg.allowedHosts.some(function (h) {
    return location.hostname === h || location.hostname.indexOf('.' + h) === location.hostname.length - h.length - 1;
  });

  window.RS = window.RS || {};
  window.RS.cfg = cfg;
  window.RS.saveCfg = function (k, s) {
    try {
      localStorage.setItem('rentsafe.cfg', JSON.stringify({ key: k, sec: s }));
    } catch (e) {}
  };
})();

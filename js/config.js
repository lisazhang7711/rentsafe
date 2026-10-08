/**
 * 安居安全评估 · 配置
 * Key 支持三级覆盖：URL 参数 ?key=xxx&sec=xxx  >  localStorage  >  此处默认值
 * 建议上线前在高德控制台为该 Key 设置「域名白名单」，避免被他人盗用。
 */
(function () {
  var q = new URLSearchParams(location.search);
  var ls = {};
  try { ls = JSON.parse(localStorage.getItem('rentsafe.cfg') || '{}'); } catch (e) {}

  var cfg = {
    // 高德 Web 端(JS API) Key —— 注意：Web 服务 REST 接口不接受此类型 Key
    key: q.get('key') || ls.key || '190c463e3a7e70c8d2f80a738974ffae',
    securityJsCode: q.get('sec') || ls.sec || 'b9eefe6c9c0c5723917926f033747ffd',
    // 检索半径（米）
    radius: 3000,
    // 检索节流：每次请求之间的最小间隔（毫秒）。调大会更慢但更稳
    gap: 260,
    // 城市限制（留空则全国）
    city: ''
  };

  window.RS = window.RS || {};
  window.RS.cfg = cfg;
  window.RS.saveCfg = function (k, s) {
    try {
      localStorage.setItem('rentsafe.cfg', JSON.stringify({ key: k, sec: s }));
    } catch (e) {}
  };
})();

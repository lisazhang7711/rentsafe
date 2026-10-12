/**
 * 安居安全评估 · 工作台交互
 */
(function () {
  var RS = (window.RS = window.RS || {});
  var M = RS.model, G = RS.geo;
  var $ = function (id) { return document.getElementById(id); };
  var esc = RS.render.esc;

  // homeMarker：目标位置那个可拖动的绿点，单独管理（其余点位仍放 state.markers）
  // originPlace：地理编码给出的初始定位，供「恢复初始定位」用
  var state = { mode: 'rent', place: null, result: null, map: null, markers: [],
                homeMarker: null, originPlace: null, adjusted: false };

  // 医疗类噪声：统一用 model 里的那份，避免两边正则不一致导致
  // 「评分取的点」和「算路径的点」不是同一家机构
  var MED_NOISE = RS.model.MED_NOISE;

  // 需要算真实路径的关键点位：消防算「车程」（消防车开过来），其余一律按「步行」——
  // 警务原来也算车程（意图是警力到场），但用户反馈（2026-10-10）：派出所 240 m
  // 却标注「驾车」很奇怪，住户视角就是走过去报警，改回步行。
  var ROUTE_PLAN = [
    { id: 'med',         bag: 'medical',     mode: 'walk',  label: '到医院' },
    { id: 'pharmacy',    bag: 'pharmacy',    mode: 'walk',  label: '到药店' },
    { id: 'supermarket', bag: 'supermarket', mode: 'walk',  label: '到超市' },
    { id: 'market',      bag: 'market',      mode: 'walk',  label: '到菜市场' },
    { id: 'convenience', bag: 'convenience', mode: 'walk',  label: '到便利店' },
    { id: 'shelter',     bag: 'shelter',     mode: 'walk',  label: '到避难开阔地' },
    { id: 'metro',       bag: 'metro',       mode: 'walk',  label: '到地铁站' },
    { id: 'fire',        bag: 'fire',        mode: 'drive', label: '消防车到场' },
    { id: 'police',      bag: 'police',      mode: 'walk',  label: '到警务点' }
  ];

  /* ---------------- toast ---------------- */
  function toast(msg) {
    var t = $('toast') || (function () {
      var d = document.createElement('div'); d.id = 'toast'; d.className = 'toast';
      document.body.appendChild(d); return d;
    })();
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------------- 模式切换 ---------------- */
  function setMode(m) {
    state.mode = m;
    document.querySelectorAll('.modes button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === m);
    });
    // 合租 / 隔断只适用于租房口径
    ['optShare', 'optPartition'].forEach(function (id) {
      var el = $(id); if (!el) return;
      var box = el.closest('.chk') || el.closest('.field');
      if (box) box.style.display = m === 'rent' ? '' : 'none';
    });
    // 模式专项表单：租房显示租约组、买房显示产权组，标题同步
    var isBuy = m === 'buy';
    [['rentOnly', !isBuy], ['buyOnly', isBuy]].forEach(function (p) {
      var el = $(p[0]);
      if (el) el.classList.toggle('hidden', !p[1]);
    });
    var st = $('specTitle');
    if (st) st.textContent = isBuy ? '购房专项 · 产权与资产稳健（占总分 20%）'
                                   : '租房专项 · 租约与租住稳定（占总分 20%）';
    var mh = $('modeHint');
    if (mh) mh.textContent = isBuy
      ? '购房口径会问产权核验、土地剩余年限与周边规划，这一块占总分 20%；嫌恶设施的扣分也按 1.45 倍计入（它影响的是永久估值，不是阶段性体验）。'
      : '租房口径会问租期长短与房东要求的付款方式，这一块占总分 20%；这两个问题决定你能不能安稳住到期、钱会不会被套进去。';
  }

  /* ---------------- 地址联想 ---------------- */
  var acTimer = null, acIdx = -1, acItems = [];
  function bindAC() {
    var inp = $('addrInput'), list = $('acList');
    inp.addEventListener('input', function () {
      var v = inp.value.trim();
      $('btnRun').disabled = !v;
      if (v && state.place && state.place.title !== v) { state.place = null; $('placeCard').classList.add('hidden'); }
      clearTimeout(acTimer);
      var kw = v;
      if (kw.length < 2) return list.classList.remove('show');
      acTimer = setTimeout(function () {
        G.suggest(kw).then(function (items) {
          acItems = items.slice(0, 10); acIdx = -1;
          if (!acItems.length) return list.classList.remove('show');
          list.innerHTML = acItems.map(function (it, i) {
            return '<div class="ac-item" data-i="' + i + '"><div class="n">' + esc(it.name) + '</div>' +
              '<div class="d">' + esc(it.address) + '</div></div>';
          }).join('');
          list.classList.add('show');
        });
      }, 260);
    });
    inp.addEventListener('keydown', function (e) {
      if (!list.classList.contains('show')) return;
      var nodes = list.querySelectorAll('.ac-item');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        acIdx += e.key === 'ArrowDown' ? 1 : -1;
        acIdx = (acIdx + nodes.length) % nodes.length;
        nodes.forEach(function (n, i) { n.classList.toggle('on', i === acIdx); });
      } else if (e.key === 'Enter' && acIdx >= 0) {
        e.preventDefault(); nodes[acIdx].click();
      } else if (e.key === 'Escape') list.classList.remove('show');
    });
    list.addEventListener('click', function (e) {
      var it = e.target.closest('.ac-item'); if (!it) return;
      var d = acItems[+it.dataset.i];
      inp.value = d.name; list.classList.remove('show');
      state.place = { title: d.name, addr: d.address || d.name, lng: d.lng, lat: d.lat };
      afterLocate();
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.ac-wrap')) list.classList.remove('show');
    });
  }

  /* ---------------- 定位后 ---------------- */
  function afterLocate() {
    var p = state.place;
    $('placeCard').classList.remove('hidden');
    $('placeName').textContent = p.title;
    // 把定位精度摆到明面上：偏差多大用户得看得见，才知道要不要拖点校正
    var accTxt = '';
    if (p.locateSource === 'ip') accTxt = '　·　IP 粗定位（仅供参考，误差可达数公里）';
    else if (p.accuracy != null) accTxt = '　·　定位精度 ±' + Math.round(p.accuracy) + ' 米';
    $('placeAddr').textContent = p.addr + accTxt;
    $('btnRun').disabled = false;
    // 换地址（而不是拖动微调）时，重置初始定位基准
    if (!state.originPlace || state.originPlace.title !== p.title) {
      state.originPlace = { title: p.title, addr: p.addr, lng: p.lng, lat: p.lat };
      state.adjusted = false;
    }
    if (state.map) {
      state.map.setCenter([p.lng, p.lat]);
      state.map.setZoom(16);   // 微调要看得清楼栋，比原来的 15 再近一级
      clearMarkers();
      addHomeMarker(p.lng, p.lat, p.title);
    }
  }
  function clearMarkers() {
    state.markers.forEach(function (m) { state.map.remove(m); });
    state.markers = [];
    if (state.homeMarker) {
      try { state.map.remove(state.homeMarker); } catch (e) {}
      state.homeMarker = null;
    }
  }

  /* ---------------- 位置手动调整 ----------------
   * 地理编码经常落在小区门口、路口甚至隔壁街区，直接用它算距离会系统性偏大。
   * 所以目标点做成可拖动的：拖动 / 点地图都能挪，挪完必须重新评估（结果不会自动跟着变）。 */
  function addHomeMarker(lng, lat, title) {
    if (!state.map || !window.AMap) return;
    var mk = new AMap.Marker({
      position: [lng, lat],
      title: title || '目标位置',
      draggable: true,
      offset: new AMap.Pixel(-9, -9),
      zIndex: 200,
      content: '<span title="拖动我微调位置" style="display:inline-block;width:16px;height:16px;border-radius:50%;' +
        'background:#0f6b5c;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:move"></span>'
    });
    mk.on('dragend', function () {
      var p = mk.getPosition();
      if (p) onAdjust(p.getLng ? p.getLng() : p.lng, p.getLat ? p.getLat() : p.lat);
    });
    state.map.add(mk);
    state.homeMarker = mk;
  }
  function moveHome(lng, lat) {
    if (state.homeMarker) state.homeMarker.setPosition([lng, lat]);
    else addHomeMarker(lng, lat, state.place && state.place.title);
    onAdjust(lng, lat);
  }
  function onAdjust(lng, lat) {
    if (!state.place) return;
    state.place.lng = lng; state.place.lat = lat;
    state.place.adjusted = true; state.adjusted = true;
    var bar = $('adjustBar'); if (bar) bar.style.display = 'flex';
    var tip = $('adjustTip');
    if (tip) tip.textContent = '位置已手动调整（' + lng.toFixed(6) + ', ' + lat.toFixed(6) + '）';
    var coord = lng.toFixed(6) + ', ' + lat.toFixed(6);
    $('placeAddr').textContent = '已手动微调 · ' + coord + '（正在取回地址…）';
    G.regeocode(lng, lat).then(function (r) {
      if (state.place && state.place.adjusted) state.place.addr = r.name || state.place.addr;
      $('placeAddr').textContent = '已手动微调 · ' + (r.name || coord);
    }).catch(function () {
      $('placeAddr').textContent = '已手动微调 · ' + coord;
    });
    toast('位置已调整，点「按新位置重算」更新报告');
  }
  function resetPos() {
    if (!state.originPlace) return;
    state.place = { title: state.originPlace.title, addr: state.originPlace.addr,
                    lng: state.originPlace.lng, lat: state.originPlace.lat };
    state.adjusted = false;
    afterLocate();
    var bar = $('adjustBar'); if (bar) bar.style.display = 'none';
    toast('已恢复初始定位');
  }
  function addMarker(lng, lat, title, color) {
    if (!state.map || !window.AMap) return;
    var mk = new AMap.Marker({
      position: [lng, lat],
      title: title,
      offset: new AMap.Pixel(-8, -8),
      content: '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:' +
        color + ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></span>'
    });
    state.map.add(mk); state.markers.push(mk);
  }

  /* ---------------- 浏览器定位 ----------------
   * 旧写法直接用 navigator.geolocation 的返回值：那是 WGS-84（真 GPS），
   * 高德地图要的是 GCJ-02，两者差几百米（北京实测约 550 m），所以「开了定位反而更不准」。
   * 现在统一走 RS.geo.locate()：高德插件优先（自带纠偏），失败降级原生并做坐标转换。 */
  function locateMe() {
    if (!navigator.geolocation) return toast('当前浏览器不支持定位（也需 HTTPS 页面）');
    toast('正在获取高精度位置…');
    RS.geo.locate().then(function (r) {
      state.place = {
        title: r.name || '当前位置',
        addr: r.name || (r.lng.toFixed(5) + ',' + r.lat.toFixed(5)),
        lng: r.lng, lat: r.lat,
        accuracy: r.accuracy, locateSource: r.source
      };
      $('addrInput').value = r.name || '';
      afterLocate();
      if (r.source === 'ip') {
        toast('只拿到 IP 粗定位（城市级，误差可达数公里）——桌面浏览器在国内通常如此。建议直接输入小区名，或用手机打开。');
      } else if (r.accuracy != null && r.accuracy > 200) {
        toast('定位精度约 ±' + Math.round(r.accuracy) + ' 米，偏差偏大：请拖动绿点到实际楼栋后再评估。');
      } else if (r.accuracy != null) {
        toast('定位成功，精度约 ±' + Math.round(r.accuracy) + ' 米');
      }
    }).catch(function (e) {
      toast('定位失败：' + ((e && e.message) || '请检查定位权限') + '。桌面浏览器在国内常拿不到准确定位，建议直接输入小区名。');
    });
  }

  /* ---------------- 主流程 ---------------- */
  function run() {
    var kw = $('addrInput').value.trim();
    if (!kw) return toast('先输入小区名或地址');
    $('btnRun').disabled = true;
    $('progWrap').classList.remove('hidden');
    $('progBar').style.width = '4%';
    $('progText').textContent = '正在定位…';
    $('result').innerHTML = '<div class="card empty-state"><div class="big">◐</div>正在检索周边应急与生活资源…</div>';

    var opt = {
      mode: state.mode,
      floor: $('optFloor').value === '' ? null : $('optFloor').value,
      top: $('optTop').value,
      age: $('optAge').value === '' ? null : $('optAge').value,
      elevator: $('optElevator').value,
      door: $('optDoor').value,
      camera: $('optCamera').value,
      gas: $('optGas').value,
      hydrant: $('optHydrant').value,
      stair2: $('optStair2').value,
      share: $('optShare').checked,
      partition: $('optPartition').checked,
      basement: $('optBasement').checked,
      topfloor: $('optTopFloor').checked,
      ebike: $('optEbike').checked,
      clutter: $('optClutter').checked,
      burglarbar: $('optBurglarBar').checked,
      flood: $('optFlood').checked,
      elderly: $('optElderly').checked,
      toddler: $('optToddler').checked,
      disabled: $('optDisabled').checked,
      device: $('optDevice').checked,
      pet: $('optPet').checked,
      // 模式专项字段：租房问租约与付款，买房问产权与规划，两组问题互不通用
      lease: $('optLease') ? $('optLease').value : 'unk',
      pay: $('optPay') ? $('optPay').value : 'unk',
      title: $('optTitle') ? $('optTitle').value : 'unk',
      tenure: $('optTenure') ? $('optTenure').value : 'unk',
      plan: $('optPlan') ? $('optPlan').value : 'unk'
    };

    // 地址去重拼接，避免出现「北京市朝阳区北京市朝阳区…」
    function composeAddr(g) {
      var parts = [g.province, g.city, g.district, g.township].filter(Boolean);
      var out = [];
      parts.forEach(function (p) {
        if (!out.some(function (o) { return o.indexOf(p) >= 0 || p.indexOf(o) >= 0; })) out.push(p);
      });
      return out.join(' ');
    }

    // 定位：地理编码 -> 再用小区名做一次周边检索精修（geocoder 常落到公交站/道路）
    function resolvePlace(kw) {
      return G.geocode(kw).then(function (g) {
        var base = { title: kw, addr: composeAddr(g), lng: g.lng, lat: g.lat };
        return G.search(kw, g.lng, g.lat, 4000).then(function (list) {
          var hit = list.filter(function (p) {
            return /住宅|小区|公寓|别墅/.test(p.type || '') || /家园|小区|花园|公寓|苑|新村|里$/.test(p.name || '');
          });
          var p = hit.length ? hit[0] : list[0];
          if (p && (p.distance == null || p.distance <= 2500)) {
            return { title: p.name || kw, addr: composeAddr(g) + (p.address ? ' · ' + p.address : ''), lng: p.lng, lat: p.lat };
          }
          return base;
        }).catch(function () { return base; });
      });
    }

    // 只有「标题一致且确实有坐标」才复用上次的定位结果；
    // 否则（比如从候选进入、标题改过、坐标为 null）重新走一次定位，避免后面 place.lng 为空炸掉
    var placeP = (state.place && state.place.lng != null && state.place.lat != null &&
                  $('addrInput').value === state.place.title)
      ? Promise.resolve(state.place)
      : resolvePlace(kw);

    placeP.then(function (place) {
      if (!place || place.lng == null || place.lat == null) {
        throw new Error('没能定位到这个地址，换一个更完整的写法试试（例如：北京市朝阳区北苑家园莲葩园）');
      }
      state.place = place;
      afterLocate();
      $('progText').textContent = '正在检索周边资源 0/' + M.QUERIES.length;
      return G.nearBatch(M.QUERIES, place.lng, place.lat, function (done, total, label) {
        $('progBar').style.width = (4 + (done / total) * 74).toFixed(0) + '%';
        $('progText').textContent = '正在检索：' + label + '（' + done + '/' + total + '）';
      }).then(function (bag) {
        // 距离补全 + 排序 + 去重
        Object.keys(bag).forEach(function (k) {
          bag[k].forEach(function (p) { if (p.distance == null) p.distance = M.haversine(place, p); });
          bag[k].sort(function (a, b) { return a.distance - b.distance; });
          bag[k] = dedupePois(bag[k]);
        });
        // 真实路径规划：步行 / 驾车，串行节流，失败即跳过（报告会明确标注未取到）
        var targets = [];
        ROUTE_PLAN.forEach(function (t) {
          var list = bag[t.bag];
          if (!list || !list.length) return;
          // 医院必须和报告里展示的那家是同一家（否则会出现「直线 1.9km 却步行 1.0km」
          // 这种物理上不可能的组合），其余类别取最近的即可
          var p = t.bag === 'medical' ? M.pickMed(bag) : list[0];
          if (!p) return;
          targets.push({ id: t.id, lng: p.lng, lat: p.lat, mode: t.mode, label: t.label });
        });
        $('progText').textContent = '正在计算实际路径 0/' + targets.length;
        return G.routeBatch(place, targets, function (done, total, label) {
          $('progBar').style.width = (78 + (done / total) * 20).toFixed(0) + '%';
          $('progText').textContent = '正在计算实际路径：' + label + '（' + done + '/' + total + '）';
        }).catch(function () { return {}; }).then(function (routes) {
          return { bag: bag, place: place, routes: routes };
        });
      });
    }).then(function (r) {
      $('progBar').style.width = '100%';
      $('progText').textContent = '检索完成，正在计算评分…';
      opt.routes = r.routes || {};
      var res = M.evaluate(r.bag, opt);
      state.result = res; state.lastPlace = r.place;
      RS.render.report($('result'), res, r.place);
      bindResultActions();
      // 地图上标出关键点位
      if (state.map) {
        clearMarkers();
        addHomeMarker(r.place.lng, r.place.lat, r.place.title);
        var colors = { med: '#b42318', fire: '#c2410c', shelter: '#1a7f37', supermarket: '#0f6b5c', metro: '#1d4ed8', police: '#4338ca' };
        ['med', 'fire', 'shelter', 'supermarket', 'metro', 'police'].forEach(function (k) {
          var f = res.facts[k]; if (f) addMarker(f.lng, f.lat, f.name, colors[k] || '#666');
        });
      }
      $('progWrap').classList.add('hidden');
      $('btnRun').disabled = false;
      // 报告已按当前坐标算完，微调提示条收起
      var ab = $('adjustBar'); if (ab) ab.style.display = 'none';
      try {
        history.replaceState(null, '', '?addr=' + encodeURIComponent($('addrInput').value.trim()) + '&mode=' + state.mode);
      } catch (e) {}
    }).catch(function (err) {
      $('progWrap').classList.add('hidden');
      $('btnRun').disabled = false;
      $('result').innerHTML = '<div class="card pad"><h3>评估失败</h3><p class="muted" style="margin-top:8px">' +
        esc(err && err.message ? err.message : String(err)) + '</p></div>';
    });
  }

  /**
   * 同一类别里，一个 POI 可能被多个近义词同时命中（例如便利蜂既是「便利店」也是「便民商店」）。
   * 优先按高德返回的 POI id 去重；id 缺失时退回「店名 + 粗距离」的近似去重，
   * 否则数量会被重复计数，密度加分和「N 家」都会虚高。
   */
  function dedupePois(list) {
    var byId = {}, seen = {}, out = [];
    list.forEach(function (p) {
      if (p.id && byId[p.id]) return;
      var rough = p.name + '@' + Math.round(p.distance / 50);
      if (seen[rough]) return;
      if (p.id) byId[p.id] = 1;
      seen[rough] = 1;
      out.push(p);
    });
    return out;
  }

  /* ---------------- 结果区按钮 ---------------- */
  function bindResultActions() {
    var bp = $('btn-print'); if (bp) bp.onclick = function () { window.print(); };
    var bc = $('btn-copy');
    if (bc) bc.onclick = function () {
      var txt = RS.render.toText(state.result, state.lastPlace);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { toast('已复制文字版报告'); }, fallback);
      } else fallback();
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = txt; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('已复制文字版报告'); } catch (e) { toast('复制失败'); }
        document.body.removeChild(ta);
      }
    };
    var bs = $('btn-save');
    if (bs) bs.onclick = function () { saveCand(); renderCand(); };
  }

  /* ---------------- 候选与对比 ---------------- */
  function cands() {
    try { return JSON.parse(localStorage.getItem('rentsafe.cand') || '[]'); } catch (e) { return []; }
  }
  function saveCand() {
    if (!state.result || !state.lastPlace) return;
    var arr = cands();
    arr.unshift({
      title: state.lastPlace.title, addr: state.lastPlace.addr,
      lng: state.lastPlace.lng, lat: state.lastPlace.lat,
      score: state.result.score, grade: state.result.grade,
      mode: state.result.mode,
      dims: state.result.dims.map(function (d) { return { name: d.name, score: d.score }; }),
      ts: Date.now()
    });
    arr = arr.slice(0, 8);
    try { localStorage.setItem('rentsafe.cand', JSON.stringify(arr)); } catch (e) {}
    toast('已保存为候选，可开对比');
  }
  function renderCand() {
    var arr = cands(), box = $('candList');
    if (!box) return;
    if (!arr.length) { box.innerHTML = '<p class="small muted">还没有候选。评估完点「保存为候选」，就能横向对比两套房子。</p>'; return; }
    box.innerHTML = arr.map(function (c, i) {
      return '<div class="cand-row"><span class="grade ' + c.grade + '">' + c.grade + '</span>' +
        '<span class="nm" title="' + esc(c.addr) + '">' + esc(c.title) + '</span>' +
        '<span class="sc" style="color:' + M.scoreColor(c.score) + '">' + c.score + '</span>' +
        '<button class="btn sm gray" data-open="' + i + '">看</button>' +
        '<button class="btn sm gray" data-del="' + i + '">×</button></div>';
    }).join('');
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var a = cands(); a.splice(+b.dataset.del, 1);
        localStorage.setItem('rentsafe.cand', JSON.stringify(a)); renderCand();
      };
    });
    box.querySelectorAll('[data-open]').forEach(function (b) {
      b.onclick = function () {
        var c = cands()[+b.dataset.open];
        $('addrInput').value = c.title;
        // 老候选可能没有存坐标（历史 bug），这里能做的最多是别把 null 当成「已定位」
        state.place = { title: c.title, addr: c.addr, lng: c.lng || null, lat: c.lat || null };
        run();
      };
    });
    var cb = $('btnCompare');
    if (cb) cb.style.display = arr.length >= 2 ? '' : 'none';
  }

  function compare() {
    // 与保存上限一致：最多同时对比 8 套（原来只取 3 套，与首页「最多保存 8 套」对不上）
    var arr = cands().slice(0, 8);
    if (arr.length < 2) return toast('至少保存两个候选');
    var names = M.DIMS.map(function (d) { return d.name; });
    var head = '<tr><th>维度</th>' + arr.map(function (c) {
      return '<th>' + esc(c.title.length > 10 ? c.title.slice(0, 10) + '…' : c.title) + '</th>';
    }).join('') + '</tr>';
    /* 按名字取分，不按下标：维度数量变过（六维→五维），老候选仍然是六维数组，
     * 用下标会把「生活保障」的分读到「环境风险」那一行去。 */
    var body = names.map(function (n) {
      return '<tr><td>' + n + '</td>' + arr.map(function (c) {
        var d = (c.dims || []).filter(function (x) { return x.name === n; })[0];
        var v = d ? d.score : '—';
        return '<td class="v" style="color:' + (typeof v === 'number' ? M.scoreColor(v) : '#8b95a3') + '">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('');
    var total = '<tr><td><b>综合</b></td>' + arr.map(function (c) {
      return '<td class="v" style="color:' + M.scoreColor(c.score) + '"><b>' + c.score + '</b></td>';
    }).join('') + '</tr>';
    var html = '<section class="card pad" style="margin-bottom:16px;border-color:#0f6b5c">' +
      '<div class="sec-t">候选横向对比 <span class="muted" style="text-transform:none;letter-spacing:0">（分数越高越安全）</span>' +
      '<button class="btn sm gray" id="cmpClose" style="float:right">关闭</button></div>' +
      '<div style="overflow-x:auto"><table class="cmp-tb"><thead>' + head + '</thead><tbody>' + body + total + '</tbody></table></div></section>';
    $('result').insertAdjacentHTML('afterbegin', html);
    $('cmpClose').onclick = function () { $('cmpClose').closest('section').remove(); };
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    bindAC();
    document.querySelectorAll('.modes button').forEach(function (b) {
      b.onclick = function () { setMode(b.dataset.mode); };
    });
    $('btnRun').onclick = run;
    $('btnLocate').onclick = locateMe;
    $('addrInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !$('acList').classList.contains('show')) run();
    });
    var bc = $('btnCompare'); if (bc) bc.onclick = compare;
    renderCand();
    setMode('rent');

    G.initMap($('miniMap'), 116.4074, 39.9042, 11).then(function (map) {
      state.map = map;
      // 点地图也能挪位置（比拖点更省事），但必须先有目标位置
      map.on('click', function (e) {
        if (!e || !e.lnglat) return;
        if (!state.place) return toast('先输入小区名或地址，再点地图微调');
        moveHome(e.lnglat.getLng(), e.lnglat.getLat());
      });
      if (state.place && state.place.lng) afterLocate();
    }).catch(function () {});

    var br = $('btnRerun'); if (br) br.onclick = function () { run(); };
    var bp2 = $('btnResetPos'); if (bp2) bp2.onclick = resetPos;

    // URL 直达
    var q = new URLSearchParams(location.search).get('addr');
    var m = new URLSearchParams(location.search).get('mode');
    // ?mode= 只认 buy / rent，其他值一律回落 rent（否则权重表为空、总分恒为 0）
    if (m === 'buy' || m === 'rent') setMode(m);
    if (q) { $('addrInput').value = q; setTimeout(run, 300); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

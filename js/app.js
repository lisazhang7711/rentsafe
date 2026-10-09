/**
 * 安居安全评估 · 工作台交互
 */
(function () {
  var RS = (window.RS = window.RS || {});
  var M = RS.model, G = RS.geo;
  var $ = function (id) { return document.getElementById(id); };
  var esc = RS.render.esc;

  var state = { mode: 'rent', place: null, result: null, map: null, markers: [] };

  // 医疗类噪声：统一用 model 里的那份，避免两边正则不一致导致
  // 「评分取的点」和「算路径的点」不是同一家机构
  var MED_NOISE = RS.model.MED_NOISE;

  // 需要算真实路径的关键点位：消防与警务算「车程」，其余算「步行」
  var ROUTE_PLAN = [
    { id: 'med',         bag: 'medical',     mode: 'walk',  label: '到医院' },
    { id: 'pharmacy',    bag: 'pharmacy',    mode: 'walk',  label: '到药店' },
    { id: 'supermarket', bag: 'supermarket', mode: 'walk',  label: '到超市' },
    { id: 'market',      bag: 'market',      mode: 'walk',  label: '到菜市场' },
    { id: 'convenience', bag: 'convenience', mode: 'walk',  label: '到便利店' },
    { id: 'shelter',     bag: 'shelter',     mode: 'walk',  label: '到避难开阔地' },
    { id: 'metro',       bag: 'metro',       mode: 'walk',  label: '到地铁站' },
    { id: 'fire',        bag: 'fire',        mode: 'drive', label: '消防车到场' },
    { id: 'police',      bag: 'police',      mode: 'drive', label: '警力到场' }
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
    ['optShare', 'optPartition'].forEach(function (id) {
      var el = $(id); if (!el) return;
      var box = el.closest('.chk') || el.closest('.field');
      if (box) box.style.display = m === 'rent' ? '' : 'none';
    });
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
    $('placeAddr').textContent = p.addr;
    $('btnRun').disabled = false;
    if (state.map) {
      state.map.setCenter([p.lng, p.lat]);
      state.map.setZoom(15);
      clearMarkers();
      addMarker(p.lng, p.lat, p.title, '#0f6b5c');
    }
  }
  function clearMarkers() {
    state.markers.forEach(function (m) { state.map.remove(m); });
    state.markers = [];
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

  /* ---------------- 浏览器定位 ---------------- */
  function locateMe() {
    if (!navigator.geolocation) return toast('当前浏览器不支持定位');
    toast('正在获取位置…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lng = pos.coords.longitude, lat = pos.coords.latitude;
      G.regeocode(lng, lat).then(function (r) {
        state.place = { title: r.name || '当前位置', addr: r.name, lng: lng, lat: lat };
        $('addrInput').value = r.name || '';
        afterLocate();
      }).catch(function () {
        state.place = { title: '当前位置', addr: lng.toFixed(5) + ',' + lat.toFixed(5), lng: lng, lat: lat };
        afterLocate();
      });
    }, function () { toast('定位被拒绝，请手动输入地址'); }, { timeout: 8000 });
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
      child: $('optChild').checked,
      disabled: $('optDisabled').checked,
      device: $('optDevice').checked,
      pet: $('optPet').checked
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
          var seen = {};
          bag[k] = bag[k].filter(function (p) {
            var key = p.name + '@' + Math.round(p.distance / 30);
            if (seen[key]) return false; seen[key] = 1; return true;
          });
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
        addMarker(r.place.lng, r.place.lat, r.place.title, '#0f6b5c');
        var colors = { med: '#b42318', fire: '#c2410c', shelter: '#1a7f37', supermarket: '#0f6b5c', metro: '#1d4ed8', police: '#4338ca' };
        ['med', 'fire', 'shelter', 'supermarket', 'metro', 'police'].forEach(function (k) {
          var f = res.facts[k]; if (f) addMarker(f.lng, f.lat, f.name, colors[k] || '#666');
        });
      }
      $('progWrap').classList.add('hidden');
      $('btnRun').disabled = false;
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
    var body = names.map(function (n, di) {
      return '<tr><td>' + n + '</td>' + arr.map(function (c) {
        var v = c.dims[di] ? c.dims[di].score : '—';
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
      if (state.place && state.place.lng) afterLocate();
    }).catch(function () {});

    // URL 直达
    var q = new URLSearchParams(location.search).get('addr');
    var m = new URLSearchParams(location.search).get('mode');
    // ?mode= 只认 buy / rent，其他值一律回落 rent（否则权重表为空、总分恒为 0）
    if (m === 'buy' || m === 'rent') setMode(m);
    if (q) { $('addrInput').value = q; setTimeout(run, 300); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

/**
 * 安居安全评估 · 工作台交互
 */
(function () {
  var RS = (window.RS = window.RS || {});
  var M = RS.model, G = RS.geo;
  var $ = function (id) { return document.getElementById(id); };
  var esc = RS.render.esc;

  var state = { mode: 'rent', place: null, result: null, map: null, markers: [] };

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
    $('optShare').closest('.field').style.display = m === 'rent' ? '' : 'none';
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
      age: $('optAge').value === '' ? null : $('optAge').value,
      noElevator: $('optElevator').value === 'no',
      door: $('optDoor').value,
      share: $('optShare').checked,
      basement: $('optBasement').checked
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

    var placeP = state.place && $('addrInput').value === state.place.title
      ? Promise.resolve(state.place)
      : resolvePlace(kw);

    placeP.then(function (place) {
      state.place = place;
      afterLocate();
      $('progText').textContent = '正在检索周边资源 0/' + M.QUERIES.length;
      return G.nearBatch(M.QUERIES, place.lng, place.lat, function (done, total, label) {
        $('progBar').style.width = (6 + (done / total) * 90).toFixed(0) + '%';
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
        return { bag: bag, place: place };
      });
    }).then(function (r) {
      $('progBar').style.width = '100%';
      $('progText').textContent = '检索完成，正在计算评分…';
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
        state.place = { title: c.title, addr: c.addr, lng: null, lat: null };
        if (c.lng) state.place.lng = c.lng;
        run();
      };
    });
    var cb = $('btnCompare');
    if (cb) cb.style.display = arr.length >= 2 ? '' : 'none';
  }

  function compare() {
    var arr = cands().slice(0, 3);
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
      '<table class="cmp-tb"><thead>' + head + '</thead><tbody>' + body + total + '</tbody></table></section>';
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
    if (m) setMode(m);
    if (q) { $('addrInput').value = q; setTimeout(run, 300); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

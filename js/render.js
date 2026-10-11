/**
 * 安居安全评估 · 报告渲染
 */
(function () {
  var RS = (window.RS = window.RS || {});
  var M = RS.model;
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(m) { return M.fmtDist(m); }

  /* 总分环 */
  function ring(score, grade) {
    var R = 70, C = 2 * Math.PI * R;
    var off = C * (1 - score / 100);
    var col = M.scoreColor(score);
    return (
      '<div class="score-ring"><svg width="170" height="170" viewBox="0 0 170 170">' +
      '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="#eceff2" stroke-width="14"/>' +
      '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="' + col + '" stroke-width="14" ' +
      'stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" ' +
      'transform="rotate(-90 85 85)"/>' +
      '</svg><div class="num"><div><b style="color:' + col + '">' + score + '</b><span>综合安全分 / 100</span></div></div></div>'
    );
  }

  /* 六维雷达图
   * 画布比图形大一圈（viewBox 带负偏移），否则左右四个角的标签会被 overflow 裁掉。
   * 侧边角标签排两行（名字一行、分数一行），横向只占 4 个字的宽度，
   * 这样图形本体 R 仍可保持在 110，不必为了塞标签把雷达缩得很小。 */
  function radar(dims) {
    var size = 300, cx = size / 2, cy = size / 2, R = 110, LR = R + 18;
    var n = dims.length, i, a, x, y;
    function pt(idx, r) {
      var ang = -Math.PI / 2 + (idx * 2 * Math.PI) / n;
      return [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
    }
    var g = '';
    for (var lv = 1; lv <= 4; lv++) {
      var rr = (R * lv) / 4, pts = [];
      for (i = 0; i < n; i++) { var p = pt(i, rr); pts.push(p[0].toFixed(1) + ',' + p[1].toFixed(1)); }
      g += '<polygon points="' + pts.join(' ') + '" fill="' + (lv === 4 ? '#fbfcfd' : 'none') + '" stroke="#e3e7ec" stroke-width="1"/>';
    }
    for (i = 0; i < n; i++) {
      var pe = pt(i, R);
      g += '<line x1="' + cx + '" y1="' + cy + '" x2="' + pe[0].toFixed(1) + '" y2="' + pe[1].toFixed(1) + '" stroke="#e3e7ec"/>';
    }
    var dpts = [], dots = '';
    for (i = 0; i < n; i++) {
      var pd = pt(i, (R * Math.max(dims[i].score, 8)) / 100);
      dpts.push(pd[0].toFixed(1) + ',' + pd[1].toFixed(1));
      dots += '<circle cx="' + pd[0].toFixed(1) + '" cy="' + pd[1].toFixed(1) + '" r="3.2" fill="' + M.scoreColor(dims[i].score) + '"/>';
    }
    g += '<polygon points="' + dpts.join(' ') + '" fill="rgba(15,107,92,.14)" stroke="#0f6b5c" stroke-width="2"/>';
    g += dots;
    var labels = '';
    for (i = 0; i < n; i++) {
      var pl = pt(i, LR);
      var side = Math.abs(pl[0] - cx) >= 8;   // 正上/正下以外的四个角
      var anchor = side ? (pl[0] > cx ? 'start' : 'end') : 'middle';
      // 白色描边垫底，避免标签压在网格线上看不清
      var attr = 'text-anchor="' + anchor + '" font-size="12.5" fill="#4a5563" ' +
        'paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round"';
      if (side) {
        // 两行：名字在上、分数在下，横向只占名字宽度
        labels += '<text x="' + pl[0].toFixed(1) + '" y="' + (pl[1] - 3).toFixed(1) + '" ' + attr + '>' +
          esc(dims[i].name) + '</text>' +
          '<text x="' + pl[0].toFixed(1) + '" y="' + (pl[1] + 12).toFixed(1) + '" ' + attr + '>' +
          '<tspan fill="#1b2027" font-weight="650">' + dims[i].score + '</tspan></text>';
      } else {
        labels += '<text x="' + pl[0].toFixed(1) + '" y="' + (pl[1] + 4).toFixed(1) + '" ' + attr + '>' +
          esc(dims[i].name) + ' <tspan fill="#1b2027" font-weight="650">' + dims[i].score + '</tspan></text>';
      }
    }
    return '<svg viewBox="-14 -16 330 310" width="100%" ' +
      'style="max-width:330px;display:block;margin:0 auto;overflow:visible">' + g + labels + '</svg>';
  }

  /* 关键点位表：直线距离 与 实际路网距离/耗时 分列；最后一列给出可点击核查的来源 */
  function poiTable(rows) {
    var h = '<table class="poi"><thead><tr><th>类别</th><th>最近点位</th>' +
      '<th class="d">直线</th><th class="d">实际路径</th><th>来源 / 核查</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var rt = r.r ? M.routeTxt(r.r) : '';
      var modeTxt = r.r && r.r.mode === 'drive'
        ? '<span class="rc drive">驾车</span>'
        : (rt ? '<span class="rc walk">步行</span>' : '');
      h += '<tr><td>' + esc(r.k) + modeTxt + '</td>' +
        '<td>' + (r.v ? esc(r.v) : '<span class="muted">未检索到</span>') + '</td>' +
        '<td class="d">' + (r.d != null ? fmt(r.d) : '—') + '</td>' +
        '<td class="d">' + (rt ? '<b>' + esc(rt) + '</b>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (r.p ? srcLink(r.p, '核查') : '<span class="muted">—</span>') + '</td></tr>';
    });
    return h + '</tbody></table>';
  }

  /* 单条来源：高德 POI 名称/地址/坐标 + 一键在高德地图打开的核查链接 */
  function srcLink(p, label) {
    if (!p || p.lng == null || p.lat == null) return '<span class="muted">—</span>';
    var href = 'https://uri.amap.com/marker?position=' + p.lng + ',' + p.lat +
      '&name=' + encodeURIComponent(p.name || '') + '&coordinate=gaode&callnative=0';
    var tip = [p.name, p.address, p.lng.toFixed(6) + ', ' + p.lat.toFixed(6)].filter(Boolean).join(' ｜ ');
    return '<a class="src" href="' + href + '" target="_blank" rel="noopener" title="' + esc(tip) + '">' +
      (label || '核查') + '</a>';
  }

  /* 各类别实际使用的检索半径（与 model.QUERIES 保持一致，写在报告里便于核查） */
  var SRC_RADIUS = {
    med: '5 km', fire: '6 km', pharmacy: '1.5 km', supermarket: '2 km', market: '2 km',
    convenience: '1.5 km', shelter: '3 km', police: '3 km', metro: '3 km'
  };

  /* 数据来源与核查：把每个结论对应的原始 POI 摊开，能一条条点进去核对 */
  function sourceSec(res, place, stamp) {
    var f = res.facts;
    var items = [
      ['综合医院', f.med, 'med'], ['消防救援站', f.fire, 'fire'], ['药店', f.pharmacy, 'pharmacy'],
      ['超市 / 商场', f.supermarket, 'supermarket'], ['菜市场 / 生鲜', f.market, 'market'],
      ['便利店', f.convenience, 'convenience'], ['应急疏散开阔地', f.shelter, 'shelter'],
      ['警务资源', f.police, 'police'], ['地铁站', f.metro, 'metro']
    ];
    var rows = items.map(function (it) {
      var p = it[1];
      var coord = p && p.lng != null ? p.lng.toFixed(6) + ', ' + p.lat.toFixed(6) : '—';
      return '<tr><td>' + esc(it[0]) + '</td>' +
        '<td>' + (p ? esc(p.name) : '<span class="muted">未检索到</span>') + '</td>' +
        '<td class="mut">' + (p ? esc(p.address || '（高德未返回地址）') : '—') + '</td>' +
        '<td class="d">' + coord + '</td>' +
        '<td class="d">' + (SRC_RADIUS[it[2]] || '—') + '</td>' +
        '<td>' + (p ? srcLink(p, '在高德打开') : '<span class="muted">—</span>') + '</td></tr>';
    }).join('');

    var center = (place.lng != null && place.lat != null)
      ? place.lng.toFixed(6) + ', ' + place.lat.toFixed(6) : '未定位';
    var centerLink = (place.lng != null && place.lat != null)
      ? '　' + srcLink({ lng: place.lng, lat: place.lat, name: place.title, address: place.addr }, '核查评估位置') : '';

    return '<section class="card pad" style="margin-bottom:16px">' +
      '<div class="sec-t">数据来源与核查</div>' +
      '<p class="hint small muted" style="margin:-4px 0 10px">' +
        '这份报告的每一个距离结论都来自下面这条原始记录。点位名称、地址与坐标都是高德返回的原文，' +
        '点「在高德打开」即可跳到高德地图核对，也可以照着地址实地或致电确认。' +
      '</p>' +
      '<table class="poi"><thead><tr><th>类别</th><th>点位名称（高德 POI）</th><th>POI 地址</th>' +
        '<th class="d">坐标 (GCJ-02)</th><th class="d">检索半径</th><th>核查</th></tr></thead><tbody>' +
        rows +
      '</tbody></table>' +
      '<ul class="ev" style="margin:12px 0 0">' +
        '<li><b>数据来源：</b>高德开放平台 —— POI 周边检索（名称 / 地址 / 坐标 / 直线距离）+ 路径规划（步行 / 驾车路网距离与耗时）。</li>' +
        '<li><b>评估位置：</b>' + esc(center) +
          (place.adjusted ? '（<b>已手动微调</b>过，非地理编码原始结果）' : '（地理编码结果，未微调）') +
          centerLink + '</li>' +
        '<li><b>检索时间：</b>' + esc(stamp) + '。POI 数据存在滞后：搬迁、停业、新建未收录都会让结果偏旧，' +
          '消防站与警务点请以官方公布和实地为准。</li>' +
        '<li><b>坐标系：</b>GCJ-02（高德火星坐标）。直接把上面的坐标粘到 GPS / 国外地图会偏移几百米，需先转换。</li>' +
        '<li><b>怎么核查：</b>先看点位名称与地址对不对得上，再看坐标落在哪一栋；' +
          '若与实际不符，拖动左侧小地图的绿点重新定位后重算。</li>' +
      '</ul>' +
    '</section>';
  }

  /* 清单 */
  function checklist(items, idpref) {
    var h = '<ul class="checklist">';
    items.forEach(function (it, i) {
      h += '<li><input type="checkbox" id="' + idpref + i + '"><label for="' + idpref + i +
        '" class="t"><b>' + esc(it.t) + '</b>' + (it.s ? '<span>' + esc(it.s) + '</span>' : '') + '</label></li>';
    });
    return h + '</ul>';
  }

  /** 渲染完整报告 */
  function report(el, res, place) {
    var modeTxt = res.mode === 'rent' ? '租房' : '购房';
    var f = res.facts;
    var rows = [
      { k: '综合医院', v: f.med && f.med.name, d: f.med && f.med.distance, r: f.med && f.med.route, p: f.med },
      { k: '消防救援站', v: f.fire && f.fire.name, d: f.fire && f.fire.distance, r: f.fire && f.fire.route, p: f.fire },
      { k: '药店', v: f.pharmacy && f.pharmacy.name, d: f.pharmacy && f.pharmacy.distance, r: f.pharmacy && f.pharmacy.route, p: f.pharmacy },
      { k: '超市 / 商场', v: f.supermarket && f.supermarket.name, d: f.supermarket && f.supermarket.distance, r: f.supermarket && f.supermarket.route, p: f.supermarket },
      { k: '菜市场 / 生鲜', v: f.market && f.market.name, d: f.market && f.market.distance, r: f.market && f.market.route, p: f.market },
      { k: '便利店', v: f.convenience && f.convenience.name, d: f.convenience && f.convenience.distance, r: f.convenience && f.convenience.route, p: f.convenience },
      { k: '应急疏散开阔地', v: f.shelter && f.shelter.name, d: f.shelter && f.shelter.distance, r: f.shelter && f.shelter.route, p: f.shelter },
      { k: '警务资源', v: f.police && f.police.name, d: f.police && f.police.distance, r: f.police && f.police.route, p: f.police },
      { k: '地铁站', v: f.metro && f.metro.name, d: f.metro && f.metro.distance, r: f.metro && f.metro.route, p: f.metro }
    ];
    var hasRoute = rows.some(function (r) { return r.r && r.r.d; });

    var dimHtml = res.dims.map(function (d) {
      return '<div class="dim"><div class="dh"><span class="dn">' + esc(d.name) + '</span>' +
        '<span class="dv" style="color:' + M.scoreColor(d.score) + '">' + d.score + '</span></div>' +
        '<div class="bar"><i style="width:' + d.score + '%;background:' + M.scoreColor(d.score) + '"></i></div>' +
        '<ul class="ev">' + d.evidences.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>';
    }).join('');

    var riskHtml = res.risks.map(function (r) {
      var cls = r.lv === 'dan' ? 'dan' : r.lv === 'ok' ? 'ok' : 'warn';
      return '<div class="alert ' + cls + '"><b>' + esc(r.t) + '</b> — ' + esc(r.d) + '</div>';
    }).join('');

    /* 模式专项：租房问租约、买房问产权，这一块是两种口径真正的内容差异 */
    var specHtml = res.spec
      ? '<section class="card pad" style="margin-bottom:16px">' +
          '<div class="sec-t">' + esc(modeTxt) + '专项 · ' + esc(res.spec.name) +
            '　<span class="small muted">这项只有' + esc(modeTxt) + '口径才有</span></div>' +
          '<div style="display:flex;align-items:center;gap:12px;margin:2px 0 12px">' +
            '<div style="font-size:26px;font-weight:800;line-height:1;color:' + M.scoreColor(res.spec.score) + '">' +
              res.spec.score + '</div>' +
            '<div class="bar" style="flex:1;margin:0"><i style="width:' + res.spec.score +
              '%;background:' + M.scoreColor(res.spec.score) + '"></i></div>' +
            '<div class="small muted" style="white-space:nowrap">占总分 ' + res.spec.weight + '%</div>' +
          '</div>' +
          '<p class="hint small muted" style="margin:0 0 10px">' + esc(res.spec.intro) + '</p>' +
          '<ul class="ev" style="margin:0">' +
            res.spec.items.map(function (x) {
              return '<li><b>' + esc(x.t) + '</b>' +
                (x.cut ? ' <span style="color:#c2410c;font-weight:600">−' + x.cut + ' 分</span>' : '') +
                '：' + esc(x.s) + '</li>';
            }).join('') +
          '</ul>' +
        '</section>'
      : '';

    var d = new Date();
    var stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    el.innerHTML =
      /* 结论 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="verdict">' + ring(res.score, res.grade) +
          '<div>' +
            '<h3>' + esc(place.title) + ' <span class="grade ' + res.grade + '">' + res.grade + ' 级</span></h3>' +
            '<p>' + esc(res.gradeTxt) + '。本次按「' + modeTxt + '」口径评估，' +
              '共检索分级半径内（' + (RS.model.RADIUS_TXT || '1–6 km') + '）' +
              Object.keys(res.poiBag).length + ' 类生活与应急资源。</p>' +
            '<div class="tagline">' +
              '<span class="tag">优势：' + esc(res.highlights.join(' · ')) + '</span>' +
              '<span class="tag">短板：' + esc(res.gaps.join(' · ')) + '</span>' +
              '<span class="tag">' + esc(place.addr) + '</span>' +
            '</div>' +
            '<div class="actions no-print">' +
              '<button class="btn sm" id="btn-print">导出 / 打印报告</button>' +
              '<button class="btn sm gray" id="btn-copy">复制文字版</button>' +
              '<button class="btn sm gray" id="btn-save">保存为候选</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>' +

      /* 模式专项（租房=租约稳定 / 购房=资产稳健）—— 只有当前口径才有 */
      specHtml +

      /* 雷达 + 维度 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">六维安全结构</div>' +
        '<div class="grid2 radar-row">' +
          '<div>' + radar(res.dims) + '</div>' +
          '<div class="dims dims-2">' + dimHtml + '</div>' +
        '</div>' +
      '</section>' +

      /* 关键点位 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">最近关键点位</div>' +
        '<p class="hint small muted" style="margin:-4px 0 10px">' +
          '「直线」是两点间的空中距离，只用于快速筛选；' +
          '「实际路径」由高德步行 / 驾车路径规划算出，是真正要花的时间。' +
          (hasRoute ? '' : '　<span class="warn-inline">本次未取到路网结果，实际路径列为空，报告中不再出现由直线距离换算的分钟数。</span>') +
        '</p>' + poiTable(rows) +
      '</section>' +

      /* 数据来源与核查（每个结论的原始 POI 都可点开核对） */
      sourceSec(res, place, stamp) +

      (res.notes && res.notes.length
        ? '<section class="card pad" style="margin-bottom:16px">' +
            '<div class="sec-t">你填写的信息如何影响这次评分</div>' +
            '<ul class="ev" style="margin:0">' +
              res.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
            '</ul></section>'
        : '') +

      /* 风险 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">风险提示</div>' + riskHtml +
      '</section>' +

      /* 断电清单 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">断电 72 小时可用性清单</div>' +
        '<p class="hint small muted" style="margin:-4px 0 10px">' +
          '这一份是<b>家庭应急储备清单</b>，和下面的签约清单用途不同：它不需要问任何人，' +
          '是给自己家里备的——把对应物资备在住所内，备好一项就勾一项，勾选只是自己记账。' +
          '其中「补给点」「药品」两行是按本次评估地址自动检索的就近位置，供断电时参考。' +
        '</p>' + checklist(res.power72, 'p72-') +
      '</section>' +

      /* 看房清单 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">' + modeTxt + ' · 看房与签约确认清单</div>' +
        '<p class="hint small muted" style="margin:-4px 0 10px">' +
          '这一份才是<b>问别人核实</b>用的：看房、问物业或房东，逐条确认属实后再勾。' +
        '</p>' + checklist(res.visit, 'vs-') +
      '</section>' +

      /* 页脚 */
      '<div class="foot-note">' +
        '生成时间：' + stamp + '　|　坐标：' +
        (place.lng != null && place.lat != null
          ? place.lng.toFixed(6) + ', ' + place.lat.toFixed(6)
          : '未定位') + '<br>' +
        '数据来源：高德开放平台 POI 检索（' + (RS.model.RADIUS_TXT || '分级半径') + '）与路径规划（步行 / 驾车）。' +
        '「直线」为两点间空中距离，「实际路径」为路网规划结果；未取到路网时不作折算。' +
        '评分为公开数据推导的参考值，不替代消防验收、房屋质量检测与专业评估；' +
        '实际决策请以实地勘察与官方登记信息为准。' +
      '</div>';

    document.title = place.title + ' · 安全评估 ' + res.score + ' 分';
    return el;
  }

  /** 纯文本版本（用于复制） */
  function toText(res, place) {
    var L = [];
    L.push('【' + place.title + '】安全评估报告');
    L.push('地址：' + place.addr + '　口径：' + (res.mode === 'rent' ? '租房' : '购房'));
    L.push('综合得分：' + res.score + ' / 100（' + res.grade + ' 级）— ' + res.gradeTxt);
    L.push('');
    L.push('— 六维得分 —');
    res.dims.forEach(function (d) { L.push(d.name + '：' + d.score + '（占总分 ' + d.weight + '%）'); });
    if (res.spec) {
      L.push(res.spec.name + '：' + res.spec.score + '（' + (res.mode === 'rent' ? '租房' : '购房') + '专项，占总分 ' + res.spec.weight + '%）');
      res.spec.items.forEach(function (x) {
        L.push('　· ' + x.t + (x.cut ? ' −' + x.cut + ' 分' : '') + '：' + x.s);
      });
    }
    L.push('');
    L.push('— 最近关键点位 —');
    [['综合医院', res.facts.med], ['消防救援站', res.facts.fire], ['药店', res.facts.pharmacy],
     ['超市', res.facts.supermarket], ['菜市场', res.facts.market], ['便利店', res.facts.convenience],
     ['应急疏散开阔地', res.facts.shelter], ['警务资源', res.facts.police], ['地铁站', res.facts.metro]
    ].forEach(function (x) {
      var p = x[1];
      if (!p) return L.push('· ' + x[0] + '：未检索到');
      L.push('· ' + x[0] + '：' + p.name + '（直线 ' + fmt(p.distance) +
        (p.route && p.route.d ? '，' + M.routeTxt(p.route) : '') + '）');
    });
    if (res.notes && res.notes.length) {
      L.push('');
      L.push('— 补充信息对评分的影响 —');
      res.notes.forEach(function (n) { L.push('· ' + n); });
    }
    L.push('');
    L.push('— 风险提示 —');
    res.risks.forEach(function (r) { L.push('· ' + r.t + '：' + r.d); });
    L.push('');
    L.push('— 断电 72 小时清单 —');
    res.power72.forEach(function (i) { L.push('□ ' + i.t + (i.s ? '（' + i.s + '）' : '')); });
    L.push('');
    L.push('— 看房确认清单 —');
    res.visit.forEach(function (i) { L.push('□ ' + i.t); });
    L.push('');
    L.push('— 数据来源与核查 —');
    L.push('来源：高德开放平台 POI 周边检索 + 路径规划（步行 / 驾车）');
    L.push('评估位置：' + (place.lng != null ? place.lng.toFixed(6) + ', ' + place.lat.toFixed(6) : '未定位') +
      (place.adjusted ? '（已手动微调）' : '（未微调）'));
    [['综合医院', res.facts.med], ['消防救援站', res.facts.fire], ['药店', res.facts.pharmacy],
     ['超市', res.facts.supermarket], ['菜市场', res.facts.market], ['便利店', res.facts.convenience],
     ['应急疏散开阔地', res.facts.shelter], ['警务资源', res.facts.police], ['地铁站', res.facts.metro]
    ].forEach(function (x) {
      var p = x[1];
      if (!p) return L.push('· ' + x[0] + '：未检索到');
      L.push('· ' + x[0] + '：' + p.name + '｜' + (p.address || '地址未返回') + '｜' +
        p.lng.toFixed(6) + ',' + p.lat.toFixed(6) + '｜直线 ' + fmt(p.distance));
    });
    L.push('坐标系统：GCJ-02（高德），粘到 GPS 或其他地图前需转换。');
    L.push('POI 数据存在滞后，消防站与警务点请以官方公布和实地为准；本报告仅供参考，不替代专业评估。');
    return L.join('\n');
  }

  RS.render = { report: report, toText: toText, ring: ring, radar: radar, esc: esc };
})();

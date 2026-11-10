/**
 * 安居综合评估 · 报告渲染
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

  /* 总分环。label 说明环里这个数是什么分——
   * 2026-11-10 起环里放的是「适配分」（随用途变），不再固定放安全分。
   * 颜色跟等级走（等级按相对位置划），不跟绝对分数走，否则环是青色、徽章却是 A。 */
  function ring(score, label, grade) {
    var R = 70, C = 2 * Math.PI * R;
    var off = C * (1 - score / 100);
    var col = M.gradeColor(grade || M.gradeOf(score));
    return (
      '<div class="score-ring"><svg width="170" height="170" viewBox="0 0 170 170">' +
      '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="#eceff2" stroke-width="14"/>' +
      '<circle cx="85" cy="85" r="' + R + '" fill="none" stroke="' + col + '" stroke-width="14" ' +
      'stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" ' +
      'transform="rotate(-90 85 85)"/>' +
      '</svg><div class="num"><div><b style="color:' + col + '">' + score + '</b><span>' +
      (label || '综合得分 / 100') + '</span></div></div></div>'
    );
  }

  /* 五维雷达图
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

  /* 关键点位表：步行路网距离（主）与直线距离（参考）分列；最后一列给出可点击核查的来源 */
  function poiTable(rows) {
    var h = '<table class="poi"><thead><tr><th>类别</th><th>最近点位</th>' +
      '<th class="d">步行距离</th><th class="d">直线<br><span style="font-weight:500;font-size:10px;color:#8b95a3;letter-spacing:0">参考</span></th>' +
      '<th>来源 / 核查</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      /* 路网结果直接挂在点位上（p.route），opt.routes 只是老接口的副本；
       * 优先取点位上的，避免「点位算过路网但 routes 里没有这一类」时误显示成估算 */
      var rr = (r.p && r.p.route) || r.r || null;
      var rt = rr ? M.routeTxt(rr) : '';
      var modeTxt = rr && rr.mode === 'drive'
        ? '<span class="rc drive">驾车</span>'
        : (rt ? '<span class="rc walk">步行</span>' : '');
      // 主列是步行路网距离（没有路网时退回直线折算并标注），参考列才是两点连线
      var line = r.p && r.p.line != null ? r.p.line : r.d;
      h += '<tr><td>' + esc(r.k) + modeTxt + '</td>' +
        '<td>' + (r.v ? esc(r.v) : '<span class="muted">未检索到</span>') + '</td>' +
        '<td class="d">' + (rt ? '<b>' + esc(rt) + '</b>'
          : (r.d != null ? fmt(r.d) + '<span class="muted" style="font-size:11px"> ' +
              (r.p && r.p.est ? '估算' : '直线') + '</span>' : '—')) + '</td>' +
        '<td class="d muted">' + (line != null ? fmt(line) : '—') + '</td>' +
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
    convenience: '1.5 km', shelter: '3 km', police: '3 km', metro: '3 km', gas: '1.5 km',
    refuse: '1.5 km', substation: '1.5 km', funeral: '3 km'
  };

  /* 数据来源与核查：把每个结论对应的原始 POI 摊开，能一条条点进去核对 */
  function sourceSec(res, place, stamp) {
    var f = res.facts;
    var items = [
      ['综合医院', f.med, 'med'], ['消防救援站', f.fire, 'fire'], ['药店', f.pharmacy, 'pharmacy'],
      ['超市 / 商场', f.supermarket, 'supermarket'], ['菜市场 / 生鲜', f.market, 'market'],
      ['便利店', f.convenience, 'convenience'], ['应急疏散开阔地', f.shelter, 'shelter'],
      ['警务资源', f.police, 'police'], ['地铁站', f.metro, 'metro'],
      ['加油站 / 加气站', f.gas, 'gas']
    ];
    /* 环境影响因素：只在真检索到时才列出来——空行一堆「未检索到」既占版面又让人误以为有风险。
     * 这一组是 2026-10-11 补上的：环境维改了口径（加油站 / 变电站降权），
     * 就更要把原始点位摊开，让人能自己判断扣得对不对。
     * 烈士纪念设施单独一行：它们不是殡葬设施，也不计入环境维扣分，
     * 列出来只是让检索结果透明（用户反馈：日坛公园马骏烈士墓曾被误标为殡葬设施）。 */
    [['垃圾站 / 中转站', 'refuse'], ['变电站', 'substation'], ['殡葬设施', 'funeral'],
     ['烈士纪念设施（纪念设施，不计分）', 'memorial']]
      .forEach(function (it) {
        var p = (res.poiBag[it[1]] || [])[0];
        if (p) items.push([it[0], p, it[1]]);
      });
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
        '<li><b>数据来源：</b>高德开放平台 —— POI 周边检索（名称 / 地址 / 坐标）+ 路径规划（步行路网距离与耗时，消防站为驾车）。报告里的距离取后者：对每类最近的几个点位逐条规划，再按路网距离重排。</li>' +
        '<li><b>评估位置：</b>' + esc(center) +
          (place.adjusted ? '（<b>已手动微调</b>过，非地理编码原始结果）' : '（地理编码结果，未微调）') +
          centerLink + '</li>' +
        '<li><b>检索时间：</b>' + esc(stamp) + '。POI 数据存在滞后：搬迁、停业、新建未收录都会让结果偏旧，' +
          '消防站与警务点请以官方公布和实地为准。</li>' +
        '<li><b>坐标系：</b>GCJ-02（高德火星坐标）。直接把上面的坐标粘到 GPS / 国外地图会偏移几百米，需先转换。</li>' +
        '<li><b>殡葬设施口径：</b>只含殡仪馆（含火化间 / 火葬场）、陵园、公墓等殡仪与安葬设施。它不构成安全风险，计入环境维是因为会影响长期居住的心理感受与二手房估值；火化间的卫生防护距离按 GB 18081 为 300–500 m，本站提示阈值取 400 m；烈士墓、纪念碑等属于<b>纪念设施</b>，不在本口径内、不计分，若检索到会单独列出。</li>' +
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
    /* 头部分数：有适配分就显示适配分（随用途变化），否则退回安全分。
     * 徽章、等级文案、页面标题都跟着这个数走，避免「环里是 86、徽章按 88 判 A」这种自相矛盾。 */
    var FIT = res.fit || null;
    var mainScore = FIT ? FIT.score : res.score;
    var mainGrade = FIT ? FIT.grade : res.grade;
    var mainTxt = FIT ? (FIT.gradeTxt || res.gradeTxt) : res.gradeTxt;
    /* 等级按相对位置划：环与徽章的颜色都取等级色，百分位与档位线并排写出来，
     * 免得用户以为「82 分只是 B」——它在基准里其实优于 88% 的房源。 */
    var CUTS = (FIT && FIT.cuts) || res.cuts || null;
    var mainPctTxt = FIT ? FIT.pctTxt : res.pctTxt;
    var ladder = CUTS
      ? 'A 优于 85% 以上（≥ ' + CUTS.A + ' 分）｜ B 55–85%（' + CUTS.B + '–' + CUTS.A +
        '）｜ C 20–55%（' + CUTS.C + '–' + CUTS.B + '）｜ D 低于 ' + CUTS.C + ' 分'
      : '';
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
      { k: '地铁站', v: f.metro && f.metro.name, d: f.metro && f.metro.distance, r: f.metro && f.metro.route, p: f.metro },
      { k: '加油站 / 加气站', v: f.gas && f.gas.name, d: f.gas && f.gas.distance, r: f.gas && f.gas.route, p: f.gas }
    ];
    var hasRoute = rows.some(function (r) { return (r.p && r.p.route && r.p.route.d) || (r.r && r.r.d); });

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

    /* 生活配套：只列距离明细。
     * 原来这里有一个「便利度」参考分，加进综合适配层之后就不给了——
     * 通勤与采买两个分已经在适配层里按用途加权，再放一个不分用途的总分会打架。 */
    var amenityHtml = res.amenity
      ? '<section class="card pad" style="margin-bottom:16px">' +
          '<div class="sec-t">生活配套 · 距离明细' +
            '<span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500;font-size:12px">　不计入安全分</span>' +
          '</div>' +
          '<p class="hint small muted" style="margin:-2px 0 10px">' +
            '通勤与采买的加权结果在上面的「综合适配」里；这里保留原始距离，方便你按自己的习惯核对。' +
          '</p>' +
          '<ul class="ev" style="margin:0">' +
            res.amenity.evidences.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') +
          '</ul>' +
        '</section>'
      : '';

    /* 综合适配：第二层，按用途给安全 / 通勤 / 采买重新加权。
     * 这一块必须回答三个问题，少一个用户就会觉得「勾了没用」：
     *   ① 按我的用途，这套房多少分；
     *   ② 权重是怎么来的（基准用途 → 每个在意项加减 → 归一化）；
     *   ③ 我在意的那几件事，这套房到底怎么样（逐条分数 + 依据）。
     * 第四件事是「换成别的用途会变成多少」，点一下就能现场切。 */
    var FIT_COL = { safe: '#0f6b5c', go: '#1d4ed8', buy: '#c2410c' };
    var fitHtml = res.fit ? (function () {
      var f = res.fit;

      var wbar = '<div class="wbar">' + f.blocks.map(function (b) {
        return '<i style="width:' + b.weight + '%;background:' + FIT_COL[b.id] + '" title="' +
          esc(b.name) + ' ' + b.weight + '%">' + (b.weight >= 14 ? '<span>' + b.weight + '%</span>' : '') + '</i>';
      }).join('') + '</div>' +
      '<div class="wlegend">' + f.blocks.map(function (b) {
        return '<span><i style="background:' + FIT_COL[b.id] + '"></i>' + esc(b.name) +
          ' <b>' + b.weight + '%</b></span>';
      }).join('') + '</div>';

      var trace = '<table class="wtb"><thead><tr><th>权重来源</th>' +
        '<th class="d">安全</th><th class="d">通勤</th><th class="d">采买</th></tr></thead><tbody>' +
        f.trace.map(function (r) {
          var isNeed = r.kind === 'need';
          function td(v) {
            if (isNeed) {
              if (!v) return '<td class="d mut">—</td>';
              return '<td class="d" style="color:' + (v > 0 ? '#1a7f37' : '#b42318') + '">' +
                (v > 0 ? '+' : '') + v + '</td>';
            }
            return '<td class="d"><b>' + v + '%</b></td>';
          }
          return '<tr class="' + r.kind + '"><td>' + esc(r.label) + '</td>' +
            td(r.v[0]) + td(r.v[1]) + td(r.v[2]) + '</tr>';
        }).join('') + '</tbody></table>' +
        '<p class="hint small muted" style="margin:6px 0 0">' +
          '基准来自你选的用途；每勾一项「在意」，就在基准上加减对应百分点，最后归一化到 100%。' +
          (f.floored ? '　某一层低于 8% 的保底，已按 8% 托底后再归一化。' : '') + '</p>';

      var cx = (f.concerns && f.concerns.length)
        ? '<div class="cs-h">你在意的 ' + f.concerns.length + ' 件事，这套房怎么样</div>' +
          '<div class="cx-wrap">' + f.concerns.map(function (c) {
            var col = M.scoreColor(c.score);
            return '<div class="cx" style="border-left-color:' + col + '">' +
              '<div class="cx-h"><span class="cx-n">' + esc(c.name) + '</span>' +
                '<span class="cx-lv" style="color:' + col + ';border-color:' + col + '">' + esc(c.level) + '</span>' +
                '<span class="cx-sc" style="color:' + col + '">' + c.score + '</span></div>' +
              '<div class="bar"><i style="width:' + c.score + '%;background:' + col + '"></i></div>' +
              '<p class="cx-note">' + esc(c.note) + '</p>' +
              '<ul class="ev">' + c.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' +
            '</div>';
          }).join('') + '</div>'
        : '<p class="hint small muted" style="margin:10px 0 0">' +
          '还没勾「最在意什么」——勾上之后，每一项会在这里单独打分并列出依据，' +
          '不合格的那一项还会进结论句与风险提示。</p>';

      var bsc = f.blocks.map(function (b) { return b.score; }).sort(function (a, b) { return a - b; });
      var alts = '<div class="alts"><span class="alts-t">同一套房，换个用途会是多少：</span>' +
        f.alts.map(function (a) {
          var on = a.key === f.purpose;
          return '<span class="alt' + (on ? ' on' : '') + '"' + (on ? '' : ' data-altp="' + a.key + '"') + '>' +
            esc(a.name) + ' <b>' + a.score + '</b></span>';
        }).join('') +
        (f.alts.length > 1 ? '<span class="alts-hint">（点一下即可切换用途重算）</span>' : '') + '</div>' +
        (f.spread != null && f.spread < 15
          ? '<p class="hint small muted" style="margin:8px 0 0">这套房安全、通勤、采买三块只差 ' + f.spread +
            ' 分（' + bsc[0] + '–' + bsc[bsc.length - 1] + '），所以光换权重时总分变化不大；' +
            '真正拉开差距的是各用途的门槛——上面「用途门槛」那几条决定这个用途到底能不能用。' +
            '三块本身差距大的房源（比如地铁很远但医院很近），换用途的差别会更明显。</p>'
          : '');

      /* 最合适的用途与当前用途差多少：这是「同一地点换用途分数确实不同」最直接的一句 */
      var bestNote = (f.best && f.gapToBest > 0.3)
        ? '<p class="hint small muted" style="margin:8px 0 0">这套房最合「' + esc(f.best.name) + '」（' +
          f.best.score + ' 分），比你现在选的「' + esc(f.purposeName) + '」高 ' + f.gapToBest + ' 分。</p>'
        : '';

      /* 用途门槛：每个用途的硬条件。没通过就明写出来——
       * 「换个用途分数变了」的理由必须能被读到，否则用户只会觉得数字在乱跳。 */
      var gateHtml = '<div style="margin-top:12px;padding:9px 11px;border-radius:9px;background:' +
        ((f.gates && f.gates.length) ? '#fdf1e7' : '#f4f8f6') + '">' +
        '<b class="small">用途门槛' + ((f.gates && f.gates.length) ? ' −' + f.gateCut + ' 分' : '：全部通过') + '</b>' +
        '<ul class="ev" style="margin:5px 0 0">' +
        ((f.gates && f.gates.length)
          ? f.gates.map(function (g) {
              return '<li><b>' + esc(g.t) + '</b>（−' + g.cut + ' 分）：' + esc(g.why) + '</li>';
            }).join('')
          : '<li>这个用途的硬条件（地铁与公交距离、医院距离、环境分、采买分）都达到了，没有额外扣分。</li>') +
        '</ul></div>';

      return '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">综合适配' +
          '<span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500;font-size:12px">　用途：' +
          esc(f.purposeName) + '　权重 ' + f.weights.safe + ' / ' + f.weights.go + ' / ' + f.weights.buy +
          ((f.gates && f.gates.length) ? '　门槛 −' + f.gateCut : '') + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:12px;margin:2px 0 14px">' +
          '<div style="font-size:32px;font-weight:800;line-height:1;color:' + M.gradeColor(f.grade) + '">' +
            f.score + '</div>' +
          '<div class="bar" style="flex:1;margin:0"><i style="width:' + f.score +
            '%;background:' + M.gradeColor(f.grade) + '"></i></div>' +
          '<div class="small muted" style="white-space:nowrap;text-align:right;line-height:1.5">' +
            '加权 ' + f.raw + ((f.gates && f.gates.length) ? '<br>门槛 −' + f.gateCut : '') +
            (f.pctTxt ? '<br>' + esc(f.pctTxt) : '') +
          '</div>' +
        '</div>' +
        wbar +
        f.blocks.map(function (b) {
          return '<div style="display:flex;align-items:center;gap:10px;margin:6px 0">' +
            '<span class="small" style="flex:0 0 46%">' + esc(b.name) + '</span>' +
            '<div class="bar" style="flex:1;margin:0"><i style="width:' + b.score +
              '%;background:' + M.scoreColor(b.score) + '"></i></div>' +
            '<b class="small" style="color:' + M.scoreColor(b.score) + ';flex:0 0 34px;text-align:right">' +
              b.score + '</b>' +
          '</div>';
        }).join('') +
        gateHtml +
        '<div class="alert ' + (f.score >= 70 ? 'ok' : 'warn') + '">' + esc(f.verdict) + '</div>' +
        trace +
        cx +
        alts +
        bestNote +
        '<p class="hint small muted" style="margin:10px 0 0">' + esc(RS.model.FIT.intro) +
          '　' + esc(f.purposeNote) + '</p>' +
      '</section>';
    })() : '';

    var d = new Date();
    var stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    el.innerHTML =
      /* 结论 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="verdict">' + ring(mainScore, FIT ? '适配分 / 100' : '安全分 / 100', mainGrade) +
          '<div>' +
            '<h3>' + esc(place.title) + ' <span class="grade ' + mainGrade + '">' + mainGrade + ' 级</span>' +
              '<span class="small muted" style="font-weight:500;margin-left:6px">' + esc(mainPctTxt) + '</span></h3>' +
            '<p>' +
              (FIT
                ? '按「' + esc(FIT.purposeName) + '」的' + modeTxt + '口径：适配分 <b>' + FIT.score +
                  '</b>，安全分 <b>' + res.score + '</b>（安全分不随用途变化）。换一个用途、或改勾「最在意」，' +
                  '这个数会跟着重算，下面的权重推演里写着每一步。'
                : '本次按「' + modeTxt + '」口径评估。') +
            '</p>' +
            '<p class="small muted" style="margin-top:6px">' + esc(mainTxt) + '。共检索分级半径内（' +
              (RS.model.RADIUS_TXT || '1–6 km') + '）' +
              Object.keys(res.poiBag).length + ' 类生活与应急资源。</p>' +
            '<div class="tagline">' +
              '<span class="tag">优势：' + esc(res.highlights.join(' · ')) + '</span>' +
              '<span class="tag">短板：' + esc(res.gaps.join(' · ')) + '</span>' +
              '<span class="tag">' + esc(place.addr) + '</span>' +
            '</div>' +
            (ladder ? '<p class="hint small muted" style="margin:10px 0 0">等级按<b>相对位置</b>划，不按绝对分数：' +
              ladder + '。参考基准是按城市住宅常见条件设定的估计分布（不是实测抽样），所以改评分口径只会让分数变，' +
              '不会把整体档位一起往下推。</p>' : '') +
            '<div class="actions no-print">' +
              '<button class="btn sm" id="btn-print">导出 / 打印报告</button>' +
              '<button class="btn sm gray" id="btn-copy">复制文字版</button>' +
              '<button class="btn sm gray" id="btn-save">保存为候选</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>' +

      /* 综合适配：按用途加权的第二层 */
      fitHtml +

      /* 模式专项（租房=租约稳定 / 购房=资产稳健）—— 只有当前口径才有 */
      specHtml +

      /* 雷达 + 维度 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">五维安全结构</div>' +
        '<div class="grid2 radar-row">' +
          '<div>' + radar(res.dims) + '</div>' +
          '<div class="dims dims-2">' + dimHtml + '</div>' +
        '</div>' +
      '</section>' +

      /* 生活配套：参考项，明确不计入综合安全分 */
      amenityHtml +

      /* 关键点位 */
      '<section class="card pad" style="margin-bottom:16px">' +
        '<div class="sec-t">最近关键点位</div>' +
        '<p class="hint small muted" style="margin:-4px 0 10px">' +
          '「步行距离」是高德步行路径规划算出的真实路线长度（消防站按消防车驾车路线），' +
          '报告里的分数与结论都按这个数字算；「直线」只是两点连线，用来判断点位是否就在附近。' +
          '拿不到路网时退回「直线 × 1.3 绕行系数」并标注「估算」，不冒充实测。' +
          (hasRoute ? '' : '　<span class="warn-inline">本次一条路网都没取到（多为网络或配额问题），建议稍后重跑一次。</span>') +
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
        '「步行距离」为高德路网规划结果，消防站为驾车；「直线」为两点间空中距离，仅供参考。' +
        '评分为公开数据推导的参考值，不替代消防验收、房屋质量检测与专业评估；' +
        '实际决策请以实地勘察与官方登记信息为准。' +
      '</div>';

    document.title = place.title + ' · 适配 ' + mainScore + ' 分' +
      (FIT ? '（' + FIT.purposeName + '）' : '');
    return el;
  }

  /** 纯文本版本（用于复制） */
  function toText(res, place) {
    var L = [];
    var CUTS = (res.fit && res.fit.cuts) || res.cuts || null;
    L.push('【' + place.title + '】居住条件评估报告');
    L.push('地址：' + place.addr + '　口径：' + (res.mode === 'rent' ? '租房' : '购房'));
    if (res.fit) {
      L.push('综合评分：适配 ' + res.fit.score + ' / 100（' + res.fit.grade + ' 级，' +
        res.fit.pctTxt + '，用途「' +
        res.fit.purposeName + '」）　｜　安全 ' + res.score + ' / 100（' + res.grade + ' 级，' +
        res.pctTxt + '，不随用途变化）');
    } else {
      L.push('综合得分：' + res.score + ' / 100（' + res.grade + ' 级，' + res.pctTxt + '）— ' + res.gradeTxt);
    }
    if (CUTS) {
      L.push('等级按相对位置划（不按绝对分数）：' +
        'A 优于 85% 以上（≥ ' + CUTS.A + '）｜ B 55–85%（' + CUTS.B + '–' + CUTS.A + '）' +
        '｜ C 20–55%（' + CUTS.C + '–' + CUTS.B + '）｜ D 低于 ' + CUTS.C);
    }
    if (res.fit) {
      L.push('（适配分 = 三块加权 ' + res.fit.raw + ' − 门槛 ' + res.fit.gateCut + '）');
      res.fit.blocks.forEach(function (b) {
        L.push('　· ' + b.name + '：' + b.score + '（权重 ' + b.weight + '%）');
      });
      if (res.fit.gates && res.fit.gates.length) {
        res.fit.gates.forEach(function (g) {
          L.push('　· 门槛没过：' + g.t + ' −' + g.cut + ' 分 —— ' + g.why);
        });
      } else {
        L.push('　· 门槛：这个用途的硬条件全部通过');
      }
      if (res.fit.trace) {
        L.push('　权重推演：' + res.fit.trace.map(function (r) {
          return r.label + '〔' + r.v.join(' / ') + '〕';
        }).join(' → ') + '（安全 / 通勤 / 采买）');
      }
      if (res.fit.concerns && res.fit.concerns.length) {
        L.push('　— 你在意的几件事 —');
        res.fit.concerns.forEach(function (c) {
          L.push('　· ' + c.name + '：' + c.score + ' 分（' + c.level + '）— ' + c.note);
          c.evidence.forEach(function (e) { L.push('　　　' + e); });
        });
      }
      if (res.fit.alts && res.fit.alts.length > 1) {
        L.push('　换个用途：' + res.fit.alts.map(function (a) { return a.name + ' ' + a.score; }).join(' · '));
        if (res.fit.best && res.fit.gapToBest > 0.3) {
          L.push('　最合「' + res.fit.best.name + '」（' + res.fit.best.score + ' 分，比当前用途高 ' +
            res.fit.gapToBest + ' 分）');
        }
      }
      L.push('　· ' + res.fit.verdict);
    }
    L.push('');
    L.push('— 五维得分 —');
    res.dims.forEach(function (d) { L.push(d.name + '：' + d.score + '（占总分 ' + d.weight + '%）'); });
    if (res.spec) {
      L.push(res.spec.name + '：' + res.spec.score + '（' + (res.mode === 'rent' ? '租房' : '购房') + '专项，占总分 ' + res.spec.weight + '%）');
      res.spec.items.forEach(function (x) {
        L.push('　· ' + x.t + (x.cut ? ' −' + x.cut + ' 分' : '') + '：' + x.s);
      });
    }
    if (res.amenity) {
      L.push('');
      L.push('— 生活配套（距离明细，不计入安全分）—');
      res.amenity.evidences.forEach(function (e) { L.push('· ' + e); });
    }
    L.push('');
    L.push('— 最近关键点位 —');
    [['综合医院', res.facts.med], ['消防救援站', res.facts.fire], ['药店', res.facts.pharmacy],
     ['超市', res.facts.supermarket], ['菜市场', res.facts.market], ['便利店', res.facts.convenience],
     ['应急疏散开阔地', res.facts.shelter], ['警务资源', res.facts.police], ['地铁站', res.facts.metro],
     ['加油站 / 加气站', res.facts.gas]
    ].forEach(function (x) {
      var p = x[1];
      if (!p) return L.push('· ' + x[0] + '：未检索到');
      L.push('· ' + x[0] + '：' + p.name + '（' + (p.route && p.route.d
        ? M.routeTxt(p.route) + (p.line != null ? '，直线 ' + fmt(p.line) : '')
        : '直线 ' + fmt(p.distance) + '，未取到路网') + '）');
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
     ['应急疏散开阔地', res.facts.shelter], ['警务资源', res.facts.police], ['地铁站', res.facts.metro],
     // 第三位为「搜不到时是否仍要列出」：核心点位要列（说明确实没有），
     // 环境因素不列（搜不到就是没有影响，列一堆「未检索到」反而像在暗示风险）
     ['加油站 / 加气站', res.facts.gas, 1],
     ['垃圾站 / 中转站', (res.poiBag.refuse || [])[0], 0],
     ['变电站', (res.poiBag.substation || [])[0], 0],
     ['殡葬设施', (res.poiBag.funeral || [])[0], 0],
     ['烈士纪念设施（纪念设施，不计分）', (res.poiBag.memorial || [])[0], 0]
    ].forEach(function (x) {
      var p = x[1];
      if (!p) { if (x[2] !== 0) L.push('· ' + x[0] + '：未检索到'); return; }
      L.push('· ' + x[0] + '：' + p.name + '｜' + (p.address || '地址未返回') + '｜' +
        p.lng.toFixed(6) + ',' + p.lat.toFixed(6) + '｜' +
        (p.walk ? (p.via === 'drive' ? '车行 ' : '步行 ') + fmt(p.distance) +
          (p.line != null ? '（直线 ' + fmt(p.line) + '）' : '')
          : '直线 ' + fmt(p.distance)));
    });
    L.push('坐标系统：GCJ-02（高德），粘到 GPS 或其他地图前需转换。');
    L.push('POI 数据存在滞后，消防站与警务点请以官方公布和实地为准；本报告仅供参考，不替代专业评估。');
    return L.join('\n');
  }

  RS.render = { report: report, toText: toText, ring: ring, radar: radar, esc: esc };
})();

/**
 * 安居安全评估 · 高德 JS API 封装
 * 只使用「Web 端(JS API)」能力：地址联想 / 地理编码 / 周边搜索 / 静态小地图。
 * 不调用 Web 服务 REST 接口（该 Key 类型为 Web 端，REST 会返回 USERKEY_PLAT_NOMATCH）。
 */
(function () {
  var RS = (window.RS = window.RS || {});
  var cfg = RS.cfg;
  var loaded = null;

  /** 加载高德 JS API 2.0（含所需插件），返回 Promise */
  function load() {
    if (loaded) return loaded;
    // 来源域名不在白名单里就别把 Key 带出去（防止站点被整站复制后继续刷这个 Key）
    if (!cfg.hostAllowed) {
      loaded = Promise.reject(new Error(
        '当前域名 ' + location.hostname + ' 未在白名单内，已停止调用高德接口。' +
        '如果你是本地调试，可在控制台执行：localStorage.setItem("rentsafe.cfg", JSON.stringify({host:location.hostname}))'));
      return loaded;
    }
    loaded = new Promise(function (resolve, reject) {
      if (window.AMap) return resolve(window.AMap);
      window._AMapSecurityConfig = { securityJsCode: cfg.securityJsCode };
      var s = document.createElement('script');
      s.src =
        'https://webapi.amap.com/maps?v=2.0&key=' +
        encodeURIComponent(cfg.key) +
        '&plugin=AMap.AutoComplete,AMap.PlaceSearch,AMap.Geocoder,AMap.Geolocation,AMap.Scale,AMap.ToolBar,AMap.Walking,AMap.Driving';
      s.onload = function () {
        window.AMap ? resolve(window.AMap) : reject(new Error('AMap 未挂载'));
      };
      s.onerror = function () {
        loaded = null;
        reject(new Error('高德 JS API 加载失败，请检查网络或 Key 是否可用'));
      };
      document.head.appendChild(s);
    });
    return loaded;
  }

  /** 地址联想：输入关键字 -> 候选列表 */
  function suggest(kw, city) {
    return load().then(function (AMap) {
      return new Promise(function (resolve) {
        try {
          var ac = new AMap.AutoComplete({ city: city || cfg.city || '全国', citylimit: false });
          ac.search(kw, function (status, result) {
            if (status === 'complete' && result && result.tips) {
              resolve(
                result.tips
                  .filter(function (t) { return t.location; })
                  .map(function (t) {
                    return {
                      name: t.name,
                      district: t.district || '',
                      address: [t.district, t.address].filter(Boolean).join(' '),
                      lng: t.location.lng,
                      lat: t.location.lat
                    };
                  })
              );
            } else resolve([]);
          });
        } catch (e) { resolve([]); }
      });
    });
  }

  /** 地理编码：地址 -> 坐标（精确匹配，取第一条） */
  function geocode(addr, city) {
    return load().then(function (AMap) {
      return new Promise(function (resolve, reject) {
        var gc = new AMap.Geocoder({ city: city || cfg.city || '全国' });
        gc.getLocation(addr, function (status, result) {
          if (status === 'complete' && result.geocodes && result.geocodes.length) {
            var g = result.geocodes[0];
            resolve({
              name: g.formattedAddress || addr,
              province: g.addressComponent.province || '',
              city: g.addressComponent.city || g.addressComponent.province || '',
              district: g.addressComponent.district || '',
              township: g.addressComponent.township || '',
              lng: g.location.lng,
              lat: g.location.lat,
              level: g.level || ''
            });
          } else reject(new Error('没能定位到这个地址，换一个更完整的写法试试（例如：北京市朝阳区北苑家园莲葩园）'));
        });
      });
    });
  }

  /** 逆地理编码：坐标 -> 结构化地址 */
  function regeocode(lng, lat) {
    return load().then(function (AMap) {
      return new Promise(function (resolve, reject) {
        var gc = new AMap.Geocoder();
        gc.getAddress([lng, lat], function (status, result) {
          if (status === 'complete' && result.regeocode) {
            var c = result.regeocode.addressComponent || {};
            resolve({
              name: result.regeocode.formattedAddress || '',
              province: c.province || '', city: c.city || c.province || '',
              district: c.district || '', township: c.township || '',
              lng: lng, lat: lat, level: ''
            });
          } else reject(new Error('逆地理编码失败'));
        });
      });
    });
  }

  /* 高德 PlaceSearch 单页上限是 50 条；城区里便利店/超市一公里内能上百家，
   * 旧的 pageSize:30 只读第一页 = 系统性丢数据（实测忠实里西区便利店共 64 家，只读回 30 家）。 */
  var MAX_PAGE_SIZE = 50;

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 拉取某一页周边搜索结果 */
  function searchPage(AMap, keyword, lng, lat, radius, pageIndex, pageSize) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = setTimeout(function () {
        if (finished) return; finished = true;
        resolve({ err: 'timeout', pois: [] });
      }, 10000);
      try {
        var ps = new AMap.PlaceSearch({
          pageSize: pageSize, pageIndex: pageIndex, extensions: 'base',
          citylimit: false, autoFitView: false
        });
        ps.searchNearBy(keyword, [lng, lat], radius, function (status, result) {
          if (finished) return; finished = true; clearTimeout(timer);
          if (status === 'complete' && result && result.poiList && result.poiList.pois) {
            resolve({ total: Number(result.poiList.count) || 0, pois: result.poiList.pois });
          } else resolve({ err: status, pois: [] });
        });
      } catch (e) {
        if (!finished) { finished = true; clearTimeout(timer); resolve({ err: String(e), pois: [] }); }
      }
    });
  }

  function toOut(pois) {
    var out = [];
    pois.forEach(function (p) {
      if (!p.location) return;
      out.push({
        id: p.id || '',                 // 供跨关键词去重：同一家店被几个词同时命中时只算一次
        name: p.name, address: p.address || '', type: p.type || '',
        lng: p.location.lng, lat: p.location.lat,
        distance: typeof p.distance === 'number' ? p.distance : null,
        tel: p.tel || ''
      });
    });
    return out;
  }

  /** 串行翻页，直到拿满 maxPage 页或该页为空 */
  function restPages(AMap, keyword, lng, lat, radius, size, maxPage, idx, acc, total) {
    if (idx > maxPage || acc.length >= total) return Promise.resolve(acc);
    return searchPage(AMap, keyword, lng, lat, radius, idx, size).then(function (r) {
      if (r.err || !r.pois.length) return acc;
      return restPages(AMap, keyword, lng, lat, radius, size, maxPage, idx + 1,
        acc.concat(r.pois), total);
    });
  }

  /**
   * 单次周边搜索（失败自动重试 1 次）。
   * pages: 最多翻到第几页，默认 1。设为 2~3 可把高密度类别（便利店、超市）取全。
   */
  function nearOnce(AMap, keyword, lng, lat, radius, pages, tryIdx) {
    pages = Math.max(1, Math.min(3, pages || 1));
    tryIdx = tryIdx || 0;
    return searchPage(AMap, keyword, lng, lat, radius, 1, MAX_PAGE_SIZE).then(function (r) {
      if (r.err) {
        // 只在超时 / error（多为高德 QPS 限流）时补一次，且先退避；正常空结果不重试
        return tryIdx === 0
          ? delay(900).then(function () {
              return nearOnce(AMap, keyword, lng, lat, radius, pages, 1);
            })
          : [];
      }
      var total = r.total || r.pois.length;
      if (pages === 1) return toOut(r.pois);
      return restPages(AMap, keyword, lng, lat, radius, MAX_PAGE_SIZE, pages, 2, r.pois, total)
        .then(function (all) { return toOut(all); });
    });
  }

  /** 单次关键词搜索（供外部调用，如小区名精确定位） */
  function search(kw, lng, lat, radius) {
    return load().then(function (AMap) { return nearOnce(AMap, kw, lng, lat, radius || 3000, 1, 0); });
  }

  /**
   * 周边搜索批处理。
   *
   * 【为什么必须串行】实测同一批 15 个关键词：三路并发时 6 个被高德限流返回 error
   * （这些错误如果不重试就会被静默丢弃，直接表现为报告里整类资源缺失）；
   * 改成单路串行 + 间隔 350 ms 后 15/15 全部成功。所以这里刻意不用并发。
   * 单请求约 0.5 s，一轮 16 类资源约 12-16 秒。
   */
  function nearBatch(queries, lng, lat, onStep) {
    return load().then(function (AMap) {
      var i = 0, done = 0, out = {};
      var gap = cfg.gap || 350;
      return new Promise(function (resolve) {
        function step() {
          if (i >= queries.length) return;
          var q = queries[i++];
          var r = q.radius || cfg.radius;
          nearOnce(AMap, q.kw, lng, lat, r, q.pages || 1, 0)
            .catch(function () { return []; })
            .then(function (list) {
              // 同一 id 的多个结果合并
              out[q.id] = (out[q.id] || []).concat(list.map(function (p) { p.qid = q.id; return p; }));
              done++;
              if (onStep) onStep(done, queries.length, q.label || q.kw);
              if (done === queries.length) resolve(out);
              else setTimeout(step, gap);
            });
        }
        step();
      });
    });
  }

  /* ---------------- 路径规划（真实步行 / 驾车） ---------------- */

  /**
   * 单次路径规划。type: 'walk' | 'drive'
   * 返回 { d: 路径米数, t: 分钟, mode }，失败返回 null。
   * 高德返回的 time 单位在不同版本下可能不一致，这里用距离/速度反推做交叉校验。
   */
  function routeOnce(AMap, type, from, to) {
    return new Promise(function (resolve) {
      var finished = false;
      var timer = setTimeout(function () { if (finished) return; finished = true; resolve(null); }, 9000);
      function done(v) { if (finished) return; finished = true; clearTimeout(timer); resolve(v); }
      try {
        var svc = type === 'drive' ? new AMap.Driving({}) : new AMap.Walking({});
        svc.search(from, to, function (status, result) {
          if (status === 'complete' && result && result.routes && result.routes.length) {
            var r = result.routes[0];
            var dist = Number(r.distance) || 0;
            if (!dist) return done(null);
            // 城市步行约 80 m/min；驾车含红绿灯约 400 m/min
            var speed = type === 'drive' ? 400 : 80;
            var fallback = Math.max(1, Math.round(dist / speed));
            var min = fallback, t = Number(r.time) || 0;
            if (t > 0) {
              var cand = Math.max(1, Math.round(t / 60));
              if (cand >= fallback * 0.4 && cand <= fallback * 3 + 3) min = cand;
            }
            done({ d: dist, t: min, mode: type });
          } else done(null);
        });
      } catch (e) { done(null); }
    });
  }

  /**
   * 串行节流批量路径规划。targets: [{id, lng, lat, mode, label}]
   * 返回 { id: {d,t,mode} }，拿不到的 id 直接不出现（调用方需兜底）。
   */
  function routeBatch(origin, targets, onStep) {
    return load().then(function (AMap) {
      var out = {}, i = 0;
      var gap = Math.max(300, cfg.gap || 260);
      return new Promise(function (resolve) {
        function step() {
          if (i >= targets.length) return resolve(out);
          var t = targets[i++];
          routeOnce(AMap, t.mode || 'walk', [origin.lng, origin.lat], [t.lng, t.lat])
            .catch(function () { return null; })
            .then(function (r) {
              if (r) out[t.id] = r;
              if (onStep) onStep(i, targets.length, t.label || t.id);
              setTimeout(step, gap);
            });
        }
        step();
      });
    });
  }

  /** 初始化小地图容器 */
  function initMap(el, lng, lat, zoom) {
    return load().then(function (AMap) {
      var map = new AMap.Map(el, {
        zoom: zoom || 14,
        center: [lng, lat],
        viewMode: '2D',
        resizeEnable: true
      });
      map.addControl(new AMap.Scale());
      return map;
    });
  }

  RS.geo = {
    load: load, suggest: suggest, geocode: geocode,
    regeocode: regeocode, nearBatch: nearBatch, search: search,
    routeBatch: routeBatch, initMap: initMap
  };
})();

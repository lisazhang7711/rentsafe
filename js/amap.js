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

  /** 单次周边搜索（失败自动重试 1 次） */
  function nearOnce(AMap, keyword, lng, lat, radius, retry) {
    return new Promise(function (resolve) {
      var ps = new AMap.PlaceSearch({
        pageSize: 30, pageIndex: 1, extensions: 'base',
        citylimit: false, autoFitView: false
      });
      var finished = false;
      var timer = setTimeout(function () {
        if (finished) return; finished = true;
        if (retry) { nearOnce(AMap, keyword, lng, lat, radius, false).then(resolve); }
        else resolve([]);
      }, 9000);
      try {
        ps.searchNearBy(keyword, [lng, lat], radius, function (status, result) {
          if (finished) return; finished = true; clearTimeout(timer);
          var out = [];
          if (status === 'complete' && result && result.poiList && result.poiList.pois) {
            result.poiList.pois.forEach(function (p) {
              if (!p.location) return;
              out.push({
                name: p.name, address: p.address || '', type: p.type || '',
                lng: p.location.lng, lat: p.location.lat,
                distance: typeof p.distance === 'number' ? p.distance : null,
                tel: p.tel || ''
              });
            });
          }
          // 只在超时/异常时重试；空结果不重试，避免放大请求量触发限流
          resolve(out);
        });
      } catch (e) { if (!finished) { finished = true; clearTimeout(timer); resolve([]); } }
    });
  }

  /** 单次关键词搜索（供外部调用，如小区名精确定位） */
  function search(kw, lng, lat, radius) {
    return load().then(function (AMap) { return nearOnce(AMap, kw, lng, lat, radius || 3000, true); });
  }

  /**
   * 串行节流批量周边搜索。
   * 高德对单 Key 有 QPS 限制，并发放太猛会大面积返回空/错误，
   * 因此改为「一条接一条 + 固定间隔」的流水线，并配进度回调。
   */
  function nearBatch(queries, lng, lat, onStep) {
    return load().then(function (AMap) {
      var i = 0, done = 0, out = {};
      var gap = cfg.gap || 260;
      /* 两路并发：18 类资源串行约 20 秒，两路约 10 秒。
         仍保留单路节流间隔，不会明显增加对高德的瞬时压力。 */
      var CONC = 2;
      return new Promise(function (resolve) {
        function step() {
          if (i >= queries.length) return;
          var q = queries[i++];
          var r = q.radius || cfg.radius;
          nearOnce(AMap, q.kw, lng, lat, r, true)
            .catch(function () { return []; })
            .then(function (list) {
              // 同一 id 的多个近义词合并
              out[q.id] = (out[q.id] || []).concat(list.map(function (p) { p.qid = q.id; return p; }));
              done++;
              if (onStep) onStep(done, queries.length, q.label || q.kw);
              if (done === queries.length) resolve(out);
              else setTimeout(step, gap);
            });
        }
        for (var w = 0; w < CONC; w++) step();
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

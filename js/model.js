/**
 * 安居安全评估 · 评分模型
 * 输入：周边 POI 检索结果 + 用户补充信息（租/买、楼层、房龄…）
 * 输出：六维得分、总分、等级、结论、清单、风险项
 */
(function () {
  var RS = (window.RS = window.RS || {});

  /* ---------------- 检索清单 ---------------- */
  // 说明：高德周边搜索对 "A|B" 多关键词支持不稳定，改为「一关键词一次请求」，
  // 同语义的多个近义词用多条查询并存到同一 id 下，由代码合并去重。
  var QUERIES = [
    { id: 'medical',      label: '综合医院',        kw: '综合医院',           radius: 5000 },
    { id: 'medical',      label: '医院',            kw: '医院',               radius: 5000 },
    { id: 'clinic',       label: '社区卫生服务中心', kw: '社区卫生服务中心',   radius: 3000 },
    { id: 'pharmacy',     label: '药店',            kw: '药店',               radius: 1500 },
    { id: 'fire',         label: '消防救援站',      kw: '消防救援站',         radius: 6000 },
    { id: 'fire',         label: '消防队',          kw: '消防队',             radius: 6000 },
    { id: 'police',       label: '派出所',          kw: '派出所',             radius: 3000 },
    { id: 'shelter',      label: '公园',            kw: '公园',               radius: 3000 },
    { id: 'supermarket',  label: '超市',            kw: '超市',               radius: 2000 },
    { id: 'convenience',  label: '便利店',          kw: '便利店',             radius: 1500 },
    { id: 'market',       label: '菜市场',          kw: '菜市场',             radius: 2000 },
    { id: 'metro',        label: '地铁站',          kw: '地铁站',             radius: 3000 },
    { id: 'bus',          label: '公交站',          kw: '公交站',             radius: 1000 },
    { id: 'school',       label: '小学',            kw: '小学',               radius: 2000 },
    { id: 'gas',          label: '加油站',          kw: '加油站',             radius: 1500 },
    { id: 'substation',   label: '变电站',          kw: '变电站',             radius: 1500 },
    { id: 'refuse',       label: '垃圾站',          kw: '垃圾站',             radius: 1500 },
    { id: 'funeral',      label: '殡仪馆',          kw: '殡仪馆',             radius: 3000 }
  ];

  // 医疗类噪声：口腔、宠物、美容、门诊等不算可用的综合医疗资源
  var MED_NOISE = /口腔|牙科|宠物|美容|整形|视力|眼镜|体检中心|不孕|男科|中医馆|推拿|按摩/;

  /* ---------------- 维度定义 ---------------- */
  var DIMS = [
    { id: 'em',    name: '应急医疗', icon: '＋', desc: '最近医院、社区卫生服务中心与药店的覆盖' },
    { id: 'fire',  name: '消防安全', icon: '火', desc: '消防站可达性、避难开阔地、楼层与疏散条件' },
    { id: 'power', name: '断电韧性', icon: '电', desc: '停电 72 小时内能否就近获得水、食物与药品' },
    { id: 'safe',  name: '治安门禁', icon: '安', desc: '警务资源距离与小区自身门禁、物业、合租情况' },
    { id: 'life',  name: '生活保障', icon: '居', desc: '通勤、采买、子女就学等日常运转条件' },
    { id: 'env',   name: '环境风险', icon: '环', desc: '加油站、变电站、垃圾站、殡葬等嫌恶设施影响' }
  ];

  var WEIGHT = {
    rent: { em: .20, fire: .18, power: .18, safe: .20, life: .16, env: .08 },
    buy:  { em: .18, fire: .16, power: .14, safe: .14, life: .16, env: .22 }
  };

  /* ---------------- 工具 ---------------- */
  function haversine(a, b) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(s)));
  }
  function fmtDist(m) {
    if (m == null) return '—';
    return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km';
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round(v) { return Math.round(v * 10) / 10; }

  /** 距离 -> 基础分；thresholds 形如 [[800,100],[1500,88],[3000,72],[5000,58]]，超出取 last */
  function distScore(list, thresholds, missScore) {
    if (!list || !list.length) return missScore == null ? 45 : missScore;
    var d = list[0].distance;
    for (var i = 0; i < thresholds.length; i++) {
      if (d <= thresholds[i][0]) return thresholds[i][1];
    }
    return thresholds[thresholds.length - 1][1] - 8;
  }
  /** 数量加成：越多越好，最多 +9 */
  function densityBonus(list, unit, cap) {
    var n = (list || []).length;
    return Math.min(cap == null ? 9 : cap, n * (unit || 1.5));
  }
  function pick(list, n) { return (list || []).slice(0, n || 3); }
  function nearest(list) { return list && list.length ? list[0] : null; }
  function scoreColor(v) {
    if (v >= 85) return '#1a7f37';
    if (v >= 70) return '#0f6b5c';
    if (v >= 55) return '#c2410c';
    return '#b42318';
  }
  // 基层机构不算「医院」：社区卫生服务中心、卫生院、服务站只作补充
  var MED_BASIC = /社区卫生服务中心|卫生院|服务站|卫生室|门诊/;
  function isBigHospital(name) {
    return /三甲|三级|人民|大学|附属|协和|同济|省立|市立|中心|中医|妇幼/.test(name || '');
  }

  /* ---------------- 主评估 ---------------- */
  function evaluate(poiBag, opt) {
    opt = opt || {};
    var mode = opt.mode || 'rent';
    var W = WEIGHT[mode];
    var ev = {};   // 各维度证据
    var S = {};    // 各维度分

    /* —— 应急医疗 —— */
    var med = (poiBag.medical || []).filter(function (p) { return !MED_NOISE.test(p.name); });
    // 真正的医院（排除基层机构），若一个都没有才退回用基层机构
    var hosp = med.filter(function (p) { return !MED_BASIC.test(p.name); });
    var useMed = hosp.length ? hosp : med;
    var bigMed = useMed.filter(function (p) { return isBigHospital(p.name); });
    var useBig = bigMed.length ? bigMed : useMed;
    var medBase = distScore(useBig, [[600, 100], [1200, 88], [2500, 74], [4000, 60]], 40);
    var sEm = clamp(medBase * .55 +
                    distScore(poiBag.clinic, [[500, 100], [1000, 90], [1800, 78]], 52) * .25 +
                    distScore(poiBag.pharmacy, [[200, 100], [500, 90], [1000, 78]], 55) * .20 +
                    densityBonus(poiBag.pharmacy, 1.0, 5), 0, 100);
    ev.em = [
      '最近医院：' + (nearest(useBig) ? nearest(useMed).name + '（' + fmtDist(nearest(useMed).distance) + '）' : '3 km 内未检索到'),
      '社区卫生服务中心：' + (nearest(poiBag.clinic) ? fmtDist(nearest(poiBag.clinic).distance) : '未检索到'),
      '药店：' + (poiBag.pharmacy && poiBag.pharmacy.length
        ? poiBag.pharmacy.length + ' 家，最近 ' + fmtDist(nearest(poiBag.pharmacy).distance)
        : '未检索到')
    ];

    /* —— 消防安全 —— */
    var sFire = clamp(
      distScore(poiBag.fire, [[1200, 100], [2500, 84], [4500, 68]], 44) * .68 +
      distScore(poiBag.shelter, [[400, 100], [1000, 88], [2000, 75]], 48) * .32, 0, 100);
    var f = opt.floor == null ? null : Number(opt.floor);
    if (opt.basement) sFire -= 8;
    if (f != null && f >= 19) sFire -= 7;
    if (f != null && f >= 34) sFire -= 5;              // 超高层
    if (opt.age && Number(opt.age) >= 30) sFire -= 6;  // 老旧管线与消防改造
    sFire = clamp(sFire, 0, 100);
    ev.fire = [
      '最近消防救援站：' + (nearest(poiBag.fire) ? nearest(poiBag.fire).name + '（' + fmtDist(nearest(poiBag.fire).distance) + '）' : '5 km 内未检索到'),
      '最近可疏散开阔地：' + (nearest(poiBag.shelter) ? nearest(poiBag.shelter).name + '（' + fmtDist(nearest(poiBag.shelter).distance) + '）' : '未检索到'),
      '楼层条件：' + (opt.basement ? '地下/半地下' : f != null ? f + ' 层' : '未填写') +
        (f != null && f >= 19 ? '（属高层，云梯覆盖受限）' : '')
    ];

    /* —— 断电韧性 —— */
    var sPower = clamp(
      distScore(poiBag.supermarket, [[400, 100], [800, 88], [1500, 76]], 50) * .34 +
      distScore(poiBag.market, [[500, 100], [1000, 88], [1800, 75]], 48) * .28 +
      distScore(poiBag.convenience, [[200, 100], [500, 88], [1000, 76]], 48) * .26 +
      distScore(poiBag.pharmacy, [[200, 100], [500, 90], [1000, 78]], 52) * .12 +
      densityBonus(poiBag.convenience, 0.8, 4), 0, 100);
    if (opt.noElevator && f != null && f >= 7) sPower -= 9;
    if (opt.age && Number(opt.age) >= 30) sPower -= 5;
    if (opt.basement) sPower -= 6;
    sPower = clamp(sPower, 0, 100);
    ev.power = [
      '最近采买点：' + (nearest(poiBag.supermarket) ? nearest(poiBag.supermarket).name + '（' + fmtDist(nearest(poiBag.supermarket).distance) + '）' : '未检索到'),
      '生鲜/菜市场：' + (nearest(poiBag.market) ? fmtDist(nearest(poiBag.market).distance) : '未检索到'),
      '便利店：' + (poiBag.convenience && poiBag.convenience.length
        ? poiBag.convenience.length + ' 家，最近 ' + fmtDist(nearest(poiBag.convenience).distance)
        : '未检索到')
    ];

    /* —— 治安门禁 —— */
    var doorScore = opt.door === 'yes' ? 88 : opt.door === 'no' ? 52 : 70;
    var sSafe = clamp(
      distScore(poiBag.police, [[600, 100], [1500, 84], [2500, 72]], 48) * .6 + doorScore * .4, 0, 100);
    if (opt.share) sSafe -= 6;
    if (f != null && f <= 2 && mode === 'rent') sSafe -= 5;
    sSafe = clamp(sSafe, 0, 100);
    ev.safe = [
      '最近警务资源：' + (nearest(poiBag.police) ? nearest(poiBag.police).name + '（' + fmtDist(nearest(poiBag.police).distance) + '）' : '3 km 内未检索到'),
      '门禁/物业：' + (opt.door === 'yes' ? '有' : opt.door === 'no' ? '无' : '未填写（按平均水平计）'),
      '居住形态：' + (opt.share ? '合租（人员流动大）' : '整租/自住')
    ];

    /* —— 生活保障 —— */
    var sLife = clamp(
      distScore(poiBag.metro, [[600, 100], [1200, 88], [2000, 74]], 45) * .34 +
      distScore(poiBag.bus, [[200, 100], [400, 88], [700, 76]], 52) * .20 +
      distScore(poiBag.supermarket, [[400, 100], [800, 88], [1500, 76]], 48) * .26 +
      distScore(poiBag.school, [[600, 100], [1200, 86], [2000, 74]], 52) * .20, 0, 100);
    ev.life = [
      '地铁：' + (nearest(poiBag.metro) ? nearest(poiBag.metro).name + '（' + fmtDist(nearest(poiBag.metro).distance) + '）' : '3 km 内未检索到'),
      '公交：' + (nearest(poiBag.bus) ? fmtDist(nearest(poiBag.bus).distance) : '未检索到'),
      '中小学：' + (nearest(poiBag.school) ? nearest(poiBag.school).name + '（' + fmtDist(nearest(poiBag.school).distance) + '）' : '未检索到')
    ];

    /* —— 环境风险（扣分制）—— */
    var sEnv = 100, envHits = [];
    function penalty(list, label, near, mid, maxCut) {
      if (!list || !list.length) return;
      var d = list[0].distance;
      var cut = d <= near ? maxCut : d <= mid ? maxCut * .55 : maxCut * .2;
      sEnv -= cut;
      envHits.push({ label: label, name: list[0].name, distance: d, cut: Math.round(cut) });
    }
    penalty(poiBag.gas, '加油站/加气站', 200, 500, 12);
    penalty(poiBag.substation, '变电站', 150, 400, 14);
    penalty(poiBag.refuse, '垃圾站/污水处理', 150, 400, 16);
    penalty(poiBag.funeral, '殡葬设施', 400, 1000, 10);
    sEnv = clamp(sEnv, 0, 100);
    ev.env = envHits.length
      ? envHits.map(function (h) { return h.label + '：' + h.name + '（' + fmtDist(h.distance) + '）'; })
      : ['1.5 km 内未检索到加油站、变电站、垃圾站、殡葬等嫌恶设施'];

    S = { em: sEm, fire: sFire, power: sPower, safe: sSafe, life: sLife, env: sEnv };

    /* —— 总分 —— */
    var total = 0;
    for (var k in W) total += S[k] * W[k];
    total = round(clamp(total, 0, 100));

    var grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : 'D';
    var GRADE_TXT = {
      A: '整体条件优秀，可以进入砍价/签约环节',
      B: '主体条件可接受，按清单补齐几项即可',
      C: '存在明确短板，务必实地核实后再决定',
      D: '关键保障缺失较多，除非价格极低否则不建议'
    };

    /* —— 排序找出亮点与短板 —— */
    var arr = DIMS.map(function (d) {
      return { id: d.id, name: d.name, score: round(S[d.id]), weight: W[d.id], evidences: ev[d.id], desc: d.desc };
    });
    var sorted = arr.slice().sort(function (a, b) { return b.score - a.score; });
    var highlights = sorted.slice(0, 2).map(function (x) { return x.name + ' ' + x.score + ' 分'; });
    var gaps = sorted.slice(-2).reverse().map(function (x) { return x.name + ' ' + x.score + ' 分'; });

    /* —— 风险项 —— */
    var risks = [];
    var nm = nearest(useBig), nf = nearest(poiBag.fire);
    if (!nm || nm.distance > 3000) risks.push({ lv: 'warn', t: '医疗距离偏远', d: '最近医疗机构超过 3 km，突发疾病时送医时间不可控，家中有老人小孩尤其要谨慎。' });
    if (!nf || nf.distance > 4000) risks.push({ lv: 'dan', t: '消防站覆盖弱', d: '最近消防救援站超过 4 km，高层住宅火灾主要依赖内部消防设施与自救，务必现场确认消火栓、烟感与疏散通道。' });
    if (f != null && f >= 19 && (!nf || nf.distance > 2500)) risks.push({ lv: 'dan', t: '高层 + 消防距离', d: f + ' 层超出多数举高消防车作业高度，疏散只能靠楼梯间，请确认楼梯间是否为防烟楼梯间、有无堆放杂物。' });
    if (!(poiBag.convenience || []).length) risks.push({ lv: 'warn', t: '断电后补给困难', d: '1.5 km 内没有便利店，长时间停电时缺少就近补给点，建议常备 3 天量的水与即食食品。' });
    if (opt.basement) risks.push({ lv: 'dan', t: '地下空间内涝与排烟', d: '地下/半地下在暴雨内涝与火灾排烟上风险显著高于地面，需确认排水泵、挡水板与机械排烟。' });
    if (opt.age && Number(opt.age) >= 30) risks.push({ lv: 'warn', t: '房龄偏老', d: '建成约 ' + opt.age + ' 年，重点关注供电容量、给排水管锈蚀、燃气软管与外墙保温层。' });
    if (opt.share) risks.push({ lv: 'warn', t: '合租安全边界', d: '合租需确认门锁是否可反锁、插座与大功率电器使用规则、陌生人进出管理。' });
    envHits.forEach(function (h) {
      if (h.distance <= (h.label === '殡葬设施' ? 400 : 150)) risks.push({ lv: 'warn', t: '嫌恶设施过近', d: h.label + '「' + h.name + '」距目标约 ' + fmtDist(h.distance) + '，可能影响居住体验与资产估值。' });
    });
    if (!risks.length) risks.push({ lv: 'ok', t: '未发现显著硬伤', d: '关键保障资源齐备，按下方清单做常规核实即可。' });

    /* —— 清单 —— */
    var p72 = buildPower72(poiBag, opt);
    var visit = buildVisit(mode, opt, poiBag);

    return {
      mode: mode, score: total, grade: grade, gradeTxt: GRADE_TXT[grade],
      dims: arr, highlights: highlights, gaps: gaps, risks: risks,
      envHits: envHits, power72: p72, visit: visit,
      facts: {
        med: nm, fire: nf, shelter: nearest(poiBag.shelter),
        market: nearest(poiBag.market),
        supermarket: nearest(poiBag.supermarket),
        convenience: nearest(poiBag.convenience),
        metro: nearest(poiBag.metro),
        police: nearest(poiBag.police),
        pharmacy: nearest(poiBag.pharmacy)
      },
      poiBag: poiBag
    };
  }

  /* ---------------- 断电 72 小时清单 ---------------- */
  function buildPower72(poi, opt) {
    var L = [];
    var f = opt.floor == null ? null : Number(opt.floor);
    L.push({
      t: '储水：按每人每天 3 升备足 3 天',
      s: '电梯停运时高层取水极困难，优先备在住所内而非楼下'
    });
    L.push({
      t: '照明与通信：手电 / 头灯 + 充电宝（≥20000mAh）+ 收音机',
      s: '手机是唯一信息源，关掉非必要后台，只保留通讯与地图'
    });
    if (f != null && f >= 7) {
      L.push({
        t: '高层预案：提前确认楼梯间位置与是否可自然采光',
        s: opt.noElevator ? '无电梯，' + f + ' 层上下一趟体力消耗大，把重物提前分批次备好' : '电梯大概率停运，把必需物品集中在住所内'
      });
    }
    var m = nearest(poi.market), s = nearest(poi.supermarket), c = nearest(poi.convenience);
    var near = [s, m, c].filter(Boolean).sort(function (a, b) { return a.distance - b.distance; })[0];
    L.push({
      t: '补给点：' + (near ? near.name + '（' + fmtDist(near.distance) + '，步行约 ' + Math.max(1, Math.round(near.distance / 80)) + ' 分钟）' : '附近未检索到稳定补给点'),
      s: '断电后多数门店只能现金交易，常备 200–500 元现金零钱'
    });
    L.push({
      t: '药品：退烧、止泻、抗过敏、创可贴、慢性病用药各备一份',
      s: '最近药店：' + (nearest(poi.pharmacy) ? nearest(poi.pharmacy).name + '（' + fmtDist(nearest(poi.pharmacy).distance) + '）' : '未检索到，需自行常备')
    });
    L.push({
      t: '食物：3 天量的即食食品（压缩饼干、罐头、能量棒）',
      s: '优先不需要加热与冷藏的品类，避免依赖冰箱'
    });
    L.push({
      t: '如厕与卫生：备水冲厕方案 + 垃圾袋 + 湿巾',
      s: '停水后高层冲厕是首要难题，提前用容器存水'
    });
    return L;
  }

  /* ---------------- 看房/签约确认清单 ---------------- */
  function buildVisit(mode, opt, poi) {
    var L = [];
    L.push({ t: '夜间走一遍：楼梯间照明、楼道堆物、单元门禁是否常闭', s: '消防通道被占用是老小区最常见的硬伤' });
    L.push({ t: '确认水电燃气：电表容量、燃气软管年限、是否有漏水痕迹', s: '重点看厨卫天花板与外墙内渗水' });
    L.push({ t: '问清物业与停车：物业公司名称、响应时间、车位是否固定', s: '无物业或无门禁的小区，治安维度需自行加权' });
    L.push({ t: '实测通勤：工作日早高峰从门口走到最近地铁站', s: poi.metro && poi.metro.length ? '最近：' + poi.metro[0].name + '（' + fmtDist(poi.metro[0].distance) + '）' : '附近无地铁，需依赖公交或自驾' });
    L.push({ t: '手机信号与电梯：进电梯和地下车库试通话', s: '被困时能否求救取决于这一项' });
    L.push({ t: '查看窗外：是否正对变电站、垃圾站、铁路或主干道', s: '白天看房容易忽略噪音与异味' });
    L.push({ t: '问邻居或保安：近两年是否发生过内涝、停电、入室盗窃', s: '本地经验比任何数据都准' });
    if (mode === 'rent') {
      L.push({ t: '核实房东与合同：房产证、身份证、租期与押金退还条款', s: '拒绝年付与高额定金' });
      L.push({ t: '确认合租现状：现住人数、性别构成、公共区域使用规则', s: '合租纠纷多源于公共区域' });
      L.push({ t: '拍照留存：入住前全屋视频 + 水电表底数', s: '退租押金争议的唯一凭据' });
    } else {
      L.push({ t: '查产权与抵押：不动产权证、抵押查封、土地年限', s: '必须去不动产登记中心核验，不能只听中介' });
      L.push({ t: '查学区与规划：学区是否被划出、周边 3 km 有无新建嫌恶设施规划', s: '规划局官网可查控制性详细规划' });
      L.push({ t: '查楼栋与楼层：是否为设备层/腰线层/顶层，电梯品牌与检修记录', s: '设备层噪音、顶层漏水是高频投诉点' });
    }
    return L;
  }

  RS.model = {
    QUERIES: QUERIES, DIMS: DIMS, WEIGHT: WEIGHT,
    evaluate: evaluate, fmtDist: fmtDist, haversine: haversine,
    scoreColor: scoreColor, clamp: clamp
  };
})();

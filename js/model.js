/**
 * 安居安全评估 · 评分模型
 * 输入：周边 POI 检索结果 + 真实路径规划结果 + 用户补充信息
 * 输出：六维得分、总分、等级、结论、清单、风险项
 *
 * 距离口径说明：
 *   distance —— 高德周边搜索返回的「直线距离」，仅用于快速排序与粗筛；
 *   route    —— AMap.Walking / AMap.Driving 算出的真实路径长度与耗时，
 *               报告里凡出现「步行 X 约 N 分钟 / 驾车 X 约 N 分钟」均来自 route，
 *               绝不由直线距离简单折算。
 */
(function () {
  var RS = (window.RS = window.RS || {});

  /* ---------------- 检索清单 ---------------- */
  // 说明：高德周边搜索对 "A|B" 多关键词支持不稳定，改为「一关键词一次请求」，
  // 同语义的多个近义词用多条查询并存到同一 id 下，由代码合并去重。
  /* 每类资源用「多个近义词 + | 」合成一次请求：实测高德 PlaceSearch 支持 | 分隔的多关键字，
   * OR 召回且结果仍按距离排序，这样既省请求（避免触发 QPS 限流）又显著补回漏掉的点位。
   *
   * 为什么必须多词：高德是「关键词 + 分类」联合召回，单一词汇会系统性漏数据。
   * 实测（忠实里西区）：
   *   只查「便利店」 → 最近一家 537 m；改成「便利店|便民商店|小卖部|食杂店」后，
   *                    门口 16 m 的惠佳美食品店才出现——名字里没"便利店"三个字的
   *                    个体小店靠前者根本查不出来。
   *   只查「小学」   → 查不到 70 m 外的北京市文汇中学；改成「小学|中学|九年一贯制」后，
   *                    文汇中学排第 1、文汇小学排第 3，两所都在。
   * pages:2 用于总数超过单页上限的类别（便利店 1.5 km 内实测 78 家，单页只装得下 50 家）。 */
  /* 每个类别优先按「高德 POI 类型」检索，关键词只作兜底（见 amap.js nearQuery）。
   *
   * 【为什么要按类型检索】高德的关键词召回要求 POI 名字里含有该词，但大量门店
   * 名字里根本没有类型名——便利蜂、京客隆便利店、惠佳美食品店都不含「便利店」，
   * 叮当快药不含「药店」，北京市文汇中学不含「小学」。靠堆品牌词补是补不完的，
   * 而按类型检索能一次性把「名不副实」的门店全部召回。
   *
   * 【关键词串不宜太长】高德对 `A|B|C` 的处理不稳定：实测「物美|便利蜂」两个词
   * 都生效，但「便利蜂|物美|罗森|全家|好邻居」只召回了第一个词。所以每个 kw
   * 控制在 3 个近义词以内，覆盖面主要靠 type 而不是靠长串。
   *
   * 【哪些类有 type】实测可用的类型名：医院 / 卫生院 / 药房 / 公园 / 超级市场 /
   * 便利店 / 地铁站 / 小学 / 中学 / 加油站 / 陵园。
   * 实测 no_data、只能靠关键词的：消防队、消防站、派出所、警务站、体育场、
   * 菜市场、农贸市场、公交站、变电站、垃圾站、环卫设施、殡仪馆。
   * 中小学必须拆两条：高德的「小学」和「中学」是两个独立类型，合不进一次请求。 */
  var QUERIES = [
    /* 医院是唯一不能用 type 检索的类别：高德的「医院」类型把医美、口腔、诊所、
     * 社区卫生服务中心全算进去，5 km 内 600 条，而类型检索是按距离排序的，
     * 前 100 条被近处的诊所填满，真正的大医院一条都进不来（实测 firstBig 为空）。
     * 关键词检索按相关性排序，第一页就能召回「首都医科大学附属首都儿童医学中心」。
     * 同理，MED_NOISE / MED_BASIC / BIG_HOSPITAL 这三层过滤专门为关键词检索设计。 */
    { id: 'medical',      label: '医院',                         kw: '医院',                      radius: 5000, pages: 2 },
    { id: 'clinic',       label: '社区卫生服务', type: '卫生院',   kw: '社区卫生服务中心|社区医院', radius: 3000 },
    { id: 'pharmacy',     label: '药店',         type: '药房',     kw: '药店|药房',                 radius: 1500 },
    { id: 'fire',         label: '消防救援',                       kw: '消防救援站|消防队|消防站',  radius: 6000 },
    { id: 'police',       label: '警务资源',                       kw: '派出所|警务站',              radius: 3000 },
    { id: 'shelter',      label: '开阔地',       type: '公园',     kw: '公园|广场|体育场',          radius: 3000 },
    { id: 'supermarket',  label: '超市',         type: '超级市场', kw: '超市',                      radius: 2000, pages: 2 },
    { id: 'convenience',  label: '便利店',       type: '便利店',   kw: '便利店',                    radius: 1500, pages: 3 },
    { id: 'market',       label: '菜市场',                         kw: '菜市场|农贸市场',            radius: 2000 },
    { id: 'metro',        label: '地铁站',       type: '地铁站',   kw: '地铁站',                    radius: 3000 },
    { id: 'bus',          label: '公交站',                         kw: '公交站',                    radius: 1000 },
    { id: 'school',       label: '小学',         type: '小学',     kw: '小学',                      radius: 2000 },
    { id: 'school',       label: '中学',         type: '中学',     kw: '中学',                      radius: 2000 },
    { id: 'gas',          label: '加油站',       type: '加油站',   kw: '加油站',                    radius: 1500 },
    { id: 'substation',   label: '变电站',                         kw: '变电站|变电所',              radius: 1500 },
    { id: 'refuse',       label: '垃圾站',                         kw: '垃圾站|垃圾中转站',          radius: 1500 },
    { id: 'funeral',      label: '殡葬设施',     type: '陵园',     kw: '殡仪馆|陵园',                radius: 3000 }
  ];

  /* 检索半径是分级配置的（消防 6 km、医院 5 km、地铁/公园 3 km、便利店 1.5 km、公交 1 km），
   * 对外统一说「3 公里」是不准确的，文案一律引用这个常量 */
  var RADIUS_TXT = '分级检索：公交 1 km、便利店与加油站 1.5 km、超市与菜场 2 km、公园与地铁 3 km、医院 5 km、消防 6 km';

  // 医疗类噪声：口腔、宠物、美容、门诊等不算可用的综合医疗资源
  var MED_NOISE = /口腔|牙科|宠物|美容|整形|视力|眼镜|体检|不孕|男科|中医馆|推拿|按摩|健疗|疗养|旗舰|医美|眼科|诊所/;

  /* ---------------- 维度定义 ---------------- */
  var DIMS = [
    { id: 'em',    name: '应急医疗', icon: '＋', desc: '最近医院、社区卫生服务中心与药店的覆盖' },
    { id: 'fire',  name: '消防安全', icon: '火', desc: '消防站车程、避难开阔地、楼层高度与疏散条件' },
    { id: 'power', name: '断电韧性', icon: '电', desc: '停电 72 小时内能否就近获得水、食物与药品' },
    { id: 'safe',  name: '治安门禁', icon: '安', desc: '警务资源距离与小区自身门禁、监控、居住形态' },
    { id: 'life',  name: '生活保障', icon: '居', desc: '通勤、采买、子女就学等日常运转条件' },
    { id: 'env',   name: '环境风险', icon: '环', desc: '加油站、变电站、垃圾站、殡葬、内涝等影响' }
  ];

  /* 六维基准权重（buildWeight 之后归一化，这里不必凑成 1）。
   *
   * 【两种口径的这组权重刻意是一样的】这是个被实测推翻过的设计。
   * 原来的 rent/buy 权重不同（租房 safe .20/env .08，买房 safe .14/env .22），
   * 结果在忠实里这种地方实测下来：买房 91.5 反而高于租房 91.2。原因是加权平均的性质——
   * 六维不可能同时满分，谁把权重压在「当前较弱的维度」上，谁的总分就更低。
   * 忠实里最弱的两维恰好是治安(82.8)和消防(96.2)，而租房最看重的就是治安，于是租房更低。
   * 「买房口径更严格，分数却更高」是讲不通的。
   *
   * 而且回到底层的事实：医疗、消防、断电、治安这些都是**位置**的属性，
   * 不因为你租还是买而变化——它们对租客和业主一样重要。
   * 真正随交易形态变化的是两件事，各自单独处理：
   *   ① 交易层面的风险租房 vs 买房完全不同 → 见下面的 SPEC 模式专项
   *   ② 同样的嫌恶设施，租客承担阶段性体验损失，业主承担永久估值折损 → 见 ENV_MODE_MUL
   * 这样两种口径的总分差就全部来自「交易本身」，方向也永远正确：
   * 买房口径不会比租房更宽松。
   */
  var WEIGHT = {
    rent: { em: .19, fire: .18, power: .18, safe: .19, life: .16, env: .10 },
    buy:  { em: .19, fire: .18, power: .18, safe: .19, life: .16, env: .10 }
  };

  /* 买房对环境嫌恶设施的扣分倍率：同样一间 150 m 外的垃圾站，
   * 对租客是一段时间的体验损失，对业主是永久的估值折损与出手难度。
   *
   * 之所以要配这个倍率：环境这一维是「100 分起步往下扣」的扣分制，
   * 单纯把权重调高，等于给「环境干净」白送一个高分项。实测忠实里（环境几乎满分）时，
   * 旧表 env 权重 .22 vs .08 会让买房反比租房高 1.4 分——口径更严结果分更高，
   * 这是反直觉的。改成「两边权重接近、买房扣分更狠」之后，方向就正常了。
   */
  var ENV_MODE_MUL = { rent: 1, buy: 1.45 };

  /* ---------------- 模式专项：租约稳定 / 资产稳健 ----------------
   * 两种口径真正的差别在这里：租房回答「能不能安稳住到期、钱会不会被套进去」，
   * 买房回答「产权干不干净、会不会砸在手里」。这两组问题互不通用，
   * 不像房龄 / 是否有老人那样两个口径都适用，所以各自构成一个独立的评分块。
   * 未填写一律按「未核验」处理：买房不做产权核验本身就是重大风险，不能默认安全。
   */
  var SPEC_W = .20;
  var SPEC = {
    rent: {
      name: '租约与租住稳定',
      intro: '租房最现实的几个坑：还没住到期就被要求搬走、半年租金一次性套进去退不出来、隔断房被责令整改。这一块买房模式没有——买房不计租约，只计产权。'
    },
    buy: {
      name: '产权与资产稳健',
      intro: '买房的三类硬风险：产权本身带抵押查封、土地年限所剩不多、周边已知有新建嫌恶设施规划。这一块租房模式没有——租客不承担资产贬值与出手难度。'
    }
  };

  /* 返回 {score, items:[{t,s,cut}]}；mode 已归一化 */
  function buildSpec(mode, opt, poiBag) {
    var items = [], base = 100;
    function cut(n, t, s) { base -= n; items.push({ t: t, s: s, cut: n }); }
    function plus(n, t, s) { base = Math.min(100, base + n); items.push({ t: t, s: s, cut: 0 }); }
    function keep(t, s) { items.push({ t: t, s: s, cut: 0 }); }
    function apply(rule) {
      if (!rule || !rule[1]) return;
      if (rule[0] < 0) cut(-rule[0], rule[1], rule[2]);
      else if (rule[0] > 0) plus(rule[0], rule[1], rule[2]);
      else keep(rule[1], rule[2]);
    }

    if (mode === 'rent') {
      apply({
        y2:  [2, '租期 2 年及以上', '租期长且租金锁定，短期内被要求搬走的概率低。'],
        y1:  [0, '一年一签', '最常见的做法，但每年续约都可能被涨价或收房，留意续租条款。'],
        short: [-14, '半年或月付短租', '稳定性最差的一类，房东随时可能收回，不适合需要长期安置的家庭。'],
        unk: [-5, '租期未确定', '没写进合同的租期不受保护，按「有风险」计入，谈合同时务必写死起止日期。']
      }[opt.lease]);
      apply({
        q:   [0, '押一付三 / 季付', '资金敞口可控，是相对安全的付款节奏。'],
        h:   [-5, '半年付', '一次性押付半年，一旦中途出问题，追回租金的难度明显上升。'],
        y:   [-16, '年付或一次性付多年', '租房损失最大的一类：机构跑路、房屋被变卖都可能导致钱房两空，直接列为否决项。'],
        unk: [-5, '付款方式未谈', '尚未确认，按存在资金风险计入。']
      }[opt.pay]);
      if (opt.share) cut(5, '合租形态', '室友变动会直接改变居住体验与安全边界，且主力租客一旦退出，剩下的人要重新承担整套租金。');
      if (opt.partition) cut(10, '隔断 / 群租', '隔断房在多个城市属于违规租赁，被责令整改时可限期搬离，且通常无法索赔。');
    } else {
      apply({
        clear:    [3, '产权已核验无抵押查封', '已到登记机构核验，是买房流程里最该先做的一步。'],
        mortgage: [-14, '有抵押未结清', '带抵押过户时若卖方未能如期解押，房屋可能被查封；合同里必须写明解押时点与违约责任。'],
        unk:      [-14, '产权未核验', '买房不查产权是最大的单点风险，按「存在重大未知」计入，签约前务必去不动产登记中心拉一次产调。']
      }[opt.title]);
      apply({
        fresh: [0, '剩余土地年限 50 年以上', '年限充裕，短期不必担心续期成本与估值折损。'],
        mid:   [-4, '剩余 30–50 年', '中期会碰到年限带来的估值天花板，续期政策细节需留意。'],
        short: [-14, '不足 30 年 / 商住 40–50 年', '年限短的房子二手折价明显、贷款年限也受限，出手难度高。'],
        unk:   [-9, '土地年限未确认', '年限直接影响可贷年限与未来估值，未确认前按有风险计入。']
      }[opt.tenure]);
      apply({
        clear: [2, '已查周边无不利规划', '已核对控制性详细规划，没有新建嫌恶设施的计划。'],
        unk:   [-8, '周边规划未了解', '规划局官网可查控规，未查之前按存在未知计入。'],
        risk:  [-18, '已知有新建嫌恶 / 市政设施规划', '这类规划一旦落地，居住体验与估值同时受损，且业主几乎无法追回差额。']
      }[opt.plan]);
      if (opt.schoolDep) {
        var sc = nearest(poiBag.school);
        if (sc && sc.distance <= 800) plus(2, '学区诉求：对口学校很近', '最近 ' + sc.name + '（' + fmtDist(sc.distance) + '），步行可达。');
        else if (sc && sc.distance <= 1500) keep('学区诉求：学校 1.5 km 内', '最近 ' + sc.name + '（' + fmtDist(sc.distance) + '）。学区以当年教委划片为准，务必核实划片范围，不能只看距离。');
        else if (sc && sc.distance <= 2500) cut(6, '学区诉求：最近学校超过 1.5 km', '最近 ' + sc.name + '（' + fmtDist(sc.distance) + '），通勤成本高，跨片入学通常不可行。');
        else cut(14, '学区诉求：2.5 km 内未检索到中小学', '有学区诉求却检索不到对口资源，说明这个位置不符合需求，且学区随时可能重新划片。');
      }
    }
    items = items.filter(function (x) { return x.t; });
    if (!items.length) keep(mode === 'rent' ? '租约按常规处理' : '购房信息待补充', '这一块没有填到异常项，若有特殊约定请在上方补充后重跑。');
    return { score: clamp(base, 0, 100), items: items };
  }

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
  /** 路径文本：步行 1.2 km 约 15 分钟 / 驾车 3.4 km 约 9 分钟 */
  function routeTxt(r) {
    if (!r || !r.d) return '';
    return (r.mode === 'drive' ? '驾车 ' : '步行 ') + fmtDist(r.d) + ' 约 ' + r.t + ' 分钟';
  }
  /** 点位距离文本：直线距离 + 真实路径（有则附） */
  function distTxt(p, r) {
    if (!p) return '未检索到';
    var s = fmtDist(p.distance);
    var rt = routeTxt(r);
    return rt ? s + '，' + rt : s + '（直线）';
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round(v) { return Math.round(v * 10) / 10; }

  /* ================= 分数区分度参数 =================
   * 这三个常量是「为什么所有城区地址都是 90 分」的直接原因，统一在这里调，
   * 不要在 13 个 distScore 调用点分散改。
   *
   * MISS_SCALE：搜不到某类资源时的兜底分折算系数。原来各处直接给 40~55 分，
   *   意味着「医院、消防、学校一个都搜不到」仍能拿到接近及格的分，
   *   不同地址的分数被压在 90 分一条线上挤成一团。折算后落到 22~30 分区间。
   * EXCEED_CUT：超出最远阈值后的掉档幅度。原来只扣 8 分，
   *   5 km 的医院和 40 km 的医院几乎同分，地址信息全在这一步被抹平。
   * DENSITY_TIERS：数量加成阶梯。原来是「n × unit 封顶」，便利店 5 家即加满，
   *   城区每个地址都白拿同一个满分，密度这一项完全没有区分能力。
   */
  var MISS_SCALE = .55;
  var EXCEED_CUT = 18;
  var DENSITY_TIERS = {
    store: [[0, 0], [1, .6], [4, 1.2], [10, 2.0], [25, 2.8], [60, 4.0]],
    drug:  [[0, 0], [1, 1],  [3, 2.0],  [6, 3.0],  [13, 4.0], [26, 5.0]]
  };
  /** 取 ≤n 的最高一档加成；数组已按 [阈值, 加成] 升序排列 */
  function tierBonus(n, tiers) {
    var v = 0;
    for (var i = 0; i < tiers.length; i++) if (n >= tiers[i][0]) v = tiers[i][1];
    return v;
  }

  /** 距离 -> 基础分；thresholds 形如 [[800,100],[1500,88]]，超出取 last - EXCEED_CUT */
  function distScore(list, thresholds, missScore) {
    if (!list || !list.length) return Math.round((missScore == null ? 45 : missScore) * MISS_SCALE);
    var d = list[0].distance;
    for (var i = 0; i < thresholds.length; i++) {
      if (d <= thresholds[i][0]) return thresholds[i][1];
    }
    return Math.max(0, thresholds[thresholds.length - 1][1] - EXCEED_CUT);
  }
  /** 数量加成：按阶梯取分，越密集越难加满 */
  function densityBonus(list, kind) {
    return tierBonus((list || []).length, DENSITY_TIERS[kind] || DENSITY_TIERS.store);
  }
  function nearest(list) { return list && list.length ? list[0] : null; }
  function scoreColor(v) {
    if (v >= 85) return '#1a7f37';
    if (v >= 70) return '#0f6b5c';
    if (v >= 55) return '#c2410c';
    return '#b42318';
  }
  // 基层机构不算「医院」：社区卫生服务中心、卫生院、服务站只作补充
  var MED_BASIC = /社区卫生服务中心|卫生院|服务站|卫生室|门诊/;
  // 注：不要把「中医」算作综合医院的判定词——中医院与综合医院的急诊/手术能力不同，
  // 混在一起会出现「综合医院一栏写着中医院」这种误导。中医院按普通医疗机构参与评分。
  /* 注：「中心」不能单独作为判定词——「爱康君安健疗国际北京旗舰中心」这类高端体检机构
   * 名字里也带「中心」，一旦匹配上就会被当成最近医院写进报告。必须是「中心医院」。 */
  var BIG_HOSPITAL = /三甲|三级|人民|大学|附属|协和|同济|省立|市立|中心医院|妇幼|急救|医学院/;
  function isBigHospital(name) {
    return BIG_HOSPITAL.test(name || '');
  }

  /**
   * 医院筛选链：去噪声 -> 去基层机构 -> 优先综合医院。
   * 报告里展示的「最近医院」和路径规划的目标点都走这个函数，保证两者是同一家。
   */
  function medChain(bag) {
    var med = (bag.medical || []).filter(function (p) { return !MED_NOISE.test(p.name); });
    var hosp = med.filter(function (p) { return !MED_BASIC.test(p.name); });
    var useMed = hosp.length ? hosp : med;
    var bigMed = useMed.filter(function (p) { return isBigHospital(p.name); });
    return bigMed.length ? bigMed : useMed;      // 已按 distance 升序
  }
  function pickMed(bag) {
    var l = medChain(bag);
    return l.length ? l[0] : null;
  }

  /* ---------------- 楼栋高度解析 ---------------- */
  var TOP_MAP = { 'le6': 6, '7-11': 11, '12-18': 18, '19-33': 33, '34p': 54 };
  function resolveHeight(opt) {
    var f = opt.floor == null || opt.floor === '' ? 0 : Number(opt.floor) || 0;
    var t = TOP_MAP[opt.top] || 0;
    var H = Math.max(t, f);                       // 楼栋总高优先，其次所在楼层
    return {
      H: H, floor: f,
      lv: H >= 34 ? 'super' : H >= 19 ? 'high' : H >= 12 ? 'mid' : H >= 7 ? 'small' : 'low',
      txt: H ? (t ? '楼栋约 ' + (t === 54 ? '34 层以上' : t + ' 层') + (f ? '，本房在 ' + f + ' 层' : '')
                  : '本房在 ' + f + ' 层') : '未填写'
    };
  }

  /* ---------------- 动态权重 ---------------- */
  function buildWeight(mode, o, h) {
    var b = WEIGHT[mode], w = {}, k;
    for (k in b) w[k] = b[k];
    // 有老人 / 幼儿 / 需电设备 —— 医疗与断电的权重上调
    if (o.elderly || o.toddler || o.device) w.em += .05;
    if (o.device) w.power += .04;
    // 楼层越高，消防权重越大
    if (h.lv === 'super') w.fire += .06;
    else if (h.lv === 'high') w.fire += .05;
    else if (h.lv === 'mid') w.fire += .02;
    // 行动不便者住高层，疏散是主要矛盾
    if ((o.elderly || o.disabled) && h.H >= 7) w.fire += .03;
    // 内涝史 / 地下空间 —— 环境风险权重上调
    if (o.basement || o.flood) w.env += .04;
    // 无幼儿时，就学便利的重要性下降
    if (!o.toddler && !o.child) w.life -= .02;
    var sum = 0;
    for (k in w) { w[k] = Math.max(.03, w[k]); sum += w[k]; }
    for (k in w) w[k] = w[k] / sum;
    return w;
  }

  /* ---------------- 主评估 ---------------- */
  function evaluate(bagRaw, opt) {
    opt = opt || {};
    /* 关键词放宽是为了把漏掉的小店补回来，代价是会串进来同名不同类的点
     * （实测查「广场」会命中「崇文门出口(东二环西向)」这种立交桥出口）。
     * 这里按高德返回的 POI 类型收一次口，只对容易串味的类别生效。 */
    var TYPE_KEEP = {
      shelter: /公园|广场|体育场|绿地/,
      school: /小学|中学|学校|九年一贯/
    };
    var poiBag = {};
    Object.keys(bagRaw).forEach(function (k) {
      var re = TYPE_KEEP[k];
      poiBag[k] = re
        ? (bagRaw[k] || []).filter(function (p) { return re.test(p.type || ''); })
        : (bagRaw[k] || []);
    });
    /* 按名字再收一次口。检索放宽后，消防这一类会混进「忠实里社区义务消防队办公室」
     * （居委会的一间办公室，20 m）和「东花市派出所消防监督」（一个岗位，不是站点），
     * 它们按距离排在最前面，会让消防这一项直接拿满分——必须剔掉。 */
    var NAME_DROP = {
      fire: /办公室|消防监督|宣传|体验馆/,
      police: /消防监督|保安|物业|停车/
    };
    Object.keys(NAME_DROP).forEach(function (k) {
      var re = NAME_DROP[k];
      poiBag[k] = (poiBag[k] || []).filter(function (p) { return !re.test(p.name || ''); });
    });
    // 优先取能出警的正规消防站；一个都没有时再退到微型消防站/社区消防工作站
    var fireMain = (poiBag.fire || []).filter(function (p) {
      return /消防救援站|消防中队|消防大队|消防支队/.test(p.name || '');
    });
    if (fireMain.length) poiBag.fire = fireMain;
    // 同理，警务优先取正式派出所/公安分局，其次才是社区警务工作室
    var policeMain = (poiBag.police || []).filter(function (p) {
      return /派出所|公安分局/.test(p.name || '');
    });
    if (policeMain.length) poiBag.police = policeMain;
    // mode 只认两种口径，非法值（?mode=xxx）会让权重表变成 undefined，
    // 总分恒为 0、等级 D、权重列显示 NaN —— 这里直接兜住
    var mode = (opt.mode === 'buy') ? 'buy' : 'rent';
    var R = opt.routes || {};
    var h = resolveHeight(opt), H = h.H, lv = h.lv;
    var W = buildWeight(mode, opt, h);
    var ev = {}, S = {};

    /* —— 应急医疗 —— */
    var useBig = medChain(poiBag);
    var nm = useBig.length ? useBig[0] : null;
    var medBase = distScore(useBig, [[600, 100], [1200, 88], [2500, 74], [4000, 60]], 40);
    // 数量加成单独加在 95 分封顶之外：否则距离分打满时加成被 clamp 吃掉，
    // 两个条件不同的小区都是 100 分，密度这一项就完全失去区分度
    var sEm = clamp(clamp(medBase * .55 +
                    distScore(poiBag.clinic, [[500, 100], [1000, 90], [1800, 78]], 52) * .25 +
                    distScore(poiBag.pharmacy, [[200, 100], [500, 90], [1000, 78]], 55) * .20, 0, 95) +
                    densityBonus(poiBag.pharmacy, 'drug'), 0, 100);
    // 家中有老人 / 需电设备 / 幼儿时，医院远一点更致命
    if ((opt.elderly || opt.device) && nm && nm.distance > 2000) sEm -= 6;
    if (opt.toddler && nm && nm.distance > 3000) sEm -= 4;
    sEm = clamp(sEm, 0, 100);
    ev.em = [
      '最近医院：' + (nm ? nm.name + '（' + distTxt(nm, R.med) + '）' : '5 km 内未检索到'),
      '社区卫生服务中心：' + (nearest(poiBag.clinic) ? fmtDist(nearest(poiBag.clinic).distance) : '未检索到'),
      '药店：' + (poiBag.pharmacy && poiBag.pharmacy.length
        ? poiBag.pharmacy.length + ' 家，最近 ' + distTxt(nearest(poiBag.pharmacy), R.pharmacy)
        : '未检索到')
    ];

    /* —— 消防安全 —— */
    var nf = nearest(poiBag.fire);
    var sFire = clamp(
      distScore(poiBag.fire, [[1200, 100], [2500, 84], [4500, 68]], 44) * .68 +
      distScore(poiBag.shelter, [[400, 100], [1000, 88], [2000, 75]], 48) * .32, 0, 100);
    // 建筑高度
    if (lv === 'mid') sFire -= 4;
    if (lv === 'high') sFire -= 8;
    if (lv === 'super') sFire -= 13;
    // 建筑与消防硬件
    if (opt.basement) sFire -= 8;
    if (opt.ebike) sFire -= 10;                                  // 电动车入户/楼道充电
    if (opt.clutter) sFire -= 8;                                 // 楼道堆物
    if (opt.stair2 === 'no') sFire -= (H >= 7 ? 9 : 5);          // 只有一部楼梯
    if (opt.hydrant === 'no') sFire -= 7;
    if (opt.burglarbar) sFire -= 5;                              // 防盗窗无逃生口
    if (opt.gas === 'bottle') sFire -= 4;                        // 瓶装液化气
    if (opt.partition) sFire -= 5;                               // 隔断房
    if (opt.age != null && Number(opt.age) >= 30) sFire -= 6;
    // 人员结构与疏散能力
    if ((opt.elderly || opt.disabled) && H >= 7) sFire -= 6;
    else if ((opt.elderly || opt.toddler) && H >= 12) sFire -= 3;
    sFire = clamp(sFire, 0, 100);
    ev.fire = [
      '最近消防救援站：' + (nf ? nf.name + '（' + distTxt(nf, R.fire) + '）' : '5 km 内未检索到'),
      '最近可疏散开阔地：' + (nearest(poiBag.shelter) ? nearest(poiBag.shelter).name + '（' + distTxt(nearest(poiBag.shelter), R.shelter) + '）' : '未检索到'),
      '楼层条件：' + (opt.basement ? '地下/半地下' : h.txt) +
        (lv === 'high' ? '（属高层，云梯覆盖受限）' : lv === 'super' ? '（属超高层，主要靠内部疏散）' : ''),
      '疏散与硬件：' + [
        opt.stair2 === 'no' ? '仅一部楼梯' : opt.stair2 === 'yes' ? '有第二疏散楼梯' : '疏散楼梯未确认',
        opt.hydrant === 'no' ? '无消火栓/烟感' : opt.hydrant === 'yes' ? '消火栓与烟感齐全' : '消防设施未确认'
      ].join(' · ') + (opt.ebike ? ' · 存在电动车入户充电' : '')
    ];

    /* —— 断电韧性 —— */
    // 同上：便利店密度加成单独加，避免 100 分封顶后被打平
    var sPower = clamp(clamp(
      distScore(poiBag.supermarket, [[400, 100], [800, 88], [1500, 76]], 50) * .34 +
      distScore(poiBag.market, [[500, 100], [1000, 88], [1800, 75]], 48) * .28 +
      distScore(poiBag.convenience, [[200, 100], [500, 88], [1000, 76]], 48) * .26 +
      distScore(poiBag.pharmacy, [[200, 100], [500, 90], [1000, 78]], 52) * .12, 0, 96) +
      densityBonus(poiBag.convenience, 'store'), 0, 100);
    if (opt.elevator === 'none' && h.floor >= 7) sPower -= 9;
    if (opt.elevator === 'flaky' && h.floor >= 7) sPower -= 5;
    if (opt.age != null && Number(opt.age) >= 30) sPower -= 5;
    if (opt.basement) sPower -= 6;
    if (opt.topfloor) sPower -= 3;          // 顶层：水压与电梯依赖
    if (H >= 19) sPower -= 5;               // 二次供水依赖电
    if (opt.device) sPower -= 8;            // 需电医疗设备，断电容忍度极低
    if (opt.elderly || opt.toddler) sPower -= 3;
    sPower = clamp(sPower, 0, 100);
    ev.power = [
      '最近采买点：' + (nearest(poiBag.supermarket) ? nearest(poiBag.supermarket).name + '（' + distTxt(nearest(poiBag.supermarket), R.supermarket) + '）' : '未检索到'),
      '生鲜/菜市场：' + (nearest(poiBag.market) ? distTxt(nearest(poiBag.market), R.market) : '未检索到'),
      // 列出最近 3 家，方便拿去看房时实地核对（小店往往门脸不起眼，只有名字不好找）
      '便利店：' + (poiBag.convenience && poiBag.convenience.length
        ? '共 ' + poiBag.convenience.length + ' 家，最近 ' +
          poiBag.convenience.slice(0, 3).map(function (p) {
            return p.name + '（' + fmtDist(p.distance) + '）';
          }).join(' · ')
        : '未检索到'),
      '断电容忍：' + (opt.device ? '有需电医疗设备（制氧机/呼吸机/冷藏药品），停电风险被放大' :
                     opt.elderly || opt.toddler ? '有老人或幼儿，对停水停电耐受更差' :
                     H >= 19 ? '高层二次供水与电梯均依赖供电' : '常规耐受')
    ];

    /* —— 治安门禁 —— */
    var doorScore = { yes: 88, part: 72, no: 50, unk: 68 }[opt.door] || 68;
    var camScore = { yes: 84, no: 56, unk: 70 }[opt.camera] || 70;
    var sSafe = clamp(
      distScore(poiBag.police, [[600, 100], [1500, 84], [2500, 72]], 48) * .45 +
      doorScore * .33 + camScore * .22, 0, 100);
    if (opt.share) sSafe -= 6;
    if (opt.partition) sSafe -= 4;
    if (h.floor >= 1 && h.floor <= 2 && mode === 'rent') sSafe -= 5;   // 低层更易入室
    if (opt.camera === 'no' && h.floor >= 1 && h.floor <= 3) sSafe -= 3;
    sSafe = clamp(sSafe, 0, 100);
    ev.safe = [
      '最近警务资源：' + (nearest(poiBag.police) ? nearest(poiBag.police).name + '（' + distTxt(nearest(poiBag.police), R.police) + '）' : '3 km 内未检索到'),
      '门禁/物业：' + ({ yes: '有门禁和物业', part: '有门禁但管理一般', no: '基本没有', unk: '未填写（按平均水平计）' }[opt.door] || '未填写'),
      '监控覆盖：' + ({ yes: '公共区域有监控', no: '基本无监控', unk: '未填写（按平均水平计）' }[opt.camera] || '未填写'),
      '居住形态：' + (opt.partition ? '隔断/群租（人员复杂、消防分隔差）' : opt.share ? '合租（人员流动大）' : '整租/自住')
    ];

    /* —— 生活保障 —— */
    var hasKid = opt.toddler || opt.child;
    var wMetro = hasKid ? .30 : .34, wSchool = hasKid ? .28 : .18;
    var sLife = clamp(
      distScore(poiBag.metro, [[600, 100], [1200, 88], [2000, 74]], 45) * wMetro +
      distScore(poiBag.bus, [[200, 100], [400, 88], [700, 76]], 52) * .20 +
      distScore(poiBag.supermarket, [[400, 100], [800, 88], [1500, 76]], 48) * .26 +
      distScore(poiBag.school, [[600, 100], [1200, 86], [2000, 74]], 52) * wSchool, 0, 100);
    if (opt.elevator === 'none' && h.floor >= 4) sLife -= 6;           // 日常上下楼成本
    sLife = clamp(sLife, 0, 100);
    ev.life = [
      '地铁：' + (nearest(poiBag.metro) ? nearest(poiBag.metro).name + '（' + distTxt(nearest(poiBag.metro), R.metro) + '）' : '3 km 内未检索到'),
      '公交：' + (nearest(poiBag.bus) ? fmtDist(nearest(poiBag.bus).distance) : '未检索到'),
      // 原来只列最近的一所，小学和中学合并检索后会被挤掉看不见；改成列最近 3 所
      '中小学：' + (poiBag.school && poiBag.school.length
        ? poiBag.school.slice(0, 3).map(function (p) {
            return p.name + '（' + fmtDist(p.distance) + '）';
          }).join(' · ')
        : '未检索到') +
        (hasKid ? '（家中有幼儿，此项权重已上调）' : '')
    ];

    /* —— 环境风险（扣分制）——
     * ENV_MODE_MUL：同样的嫌恶设施，买房口径扣得更狠。
     * 注意只对「扣分」生效，不会因为环境干净而给买房额外加分。 */
    var envMul = ENV_MODE_MUL[mode] || 1;
    var sEnv = 100, envHits = [];
    function penalty(list, label, near, mid, maxCut) {
      if (!list || !list.length) return;
      var d = list[0].distance;
      var cut = d <= near ? maxCut : d <= mid ? maxCut * .55 : maxCut * .2;
      cut *= envMul;
      sEnv -= cut;
      envHits.push({ label: label, name: list[0].name, distance: d, cut: Math.round(cut) });
    }
    penalty(poiBag.gas, '加油站/加气站', 200, 500, 12);
    penalty(poiBag.substation, '变电站', 150, 400, 14);
    penalty(poiBag.refuse, '垃圾站/污水处理', 150, 400, 16);
    penalty(poiBag.funeral, '殡葬设施', 400, 1000, 10);
    if (opt.flood) sEnv -= 10 * envMul;         // 曾发生内涝/积水
    if (opt.basement) sEnv -= 4 * envMul;       // 地下空间额外叠加
    if (opt.topfloor && opt.age != null && Number(opt.age) >= 20) sEnv -= 3 * envMul;  // 老房顶层渗漏
    sEnv = clamp(sEnv, 0, 100);
    ev.env = (envHits.length
      ? envHits.map(function (x) { return x.label + '：' + x.name + '（' + fmtDist(x.distance) + '）'; })
      : ['1.5 km 内未检索到加油站、变电站、垃圾站、殡葬等嫌恶设施'])
      .concat(opt.flood ? ['场地历史：该处曾发生内涝或积水（按你填写的信息计入）'] : []);

    S = { em: sEm, fire: sFire, power: sPower, safe: sSafe, life: sLife, env: sEnv };

    /* —— 模式专项（租房=租约稳定 / 买房=资产稳健）—— */
    var spec = buildSpec(mode, opt, poiBag);
    var specName = SPEC[mode].name;

    /* —— 总分 ——
     * 六维占 (1-SPEC_W)，模式专项占 SPEC_W。放在加权和里而不是最后加减，
     * 是为了让专项的影响可以被量化地说出来：「这一块占总分的 15%」。 */
    var baseScore = 0;
    for (var k in W) baseScore += S[k] * W[k];
    var total = round(clamp(baseScore * (1 - SPEC_W) + spec.score * SPEC_W, 0, 100));

    var grade = total >= 85 ? 'A' : total >= 70 ? 'B' : total >= 55 ? 'C' : 'D';
    var GRADE_TXT = {
      A: '整体条件优秀，可以进入砍价/签约环节',
      B: '主体条件可接受，按清单补齐几项即可',
      C: '存在明确短板，务必实地核实后再决定',
      D: '关键保障缺失较多，除非价格极低否则不建议'
    };

    /* —— 排序找出亮点与短板 ——
     * 显示的权重是「在总分里的实际占比」，所以要乘上 (1-SPEC_W)；
     * 剩下的 SPEC_W 归模式专项，六维加起来不再是 100%。 */
    var arr = DIMS.map(function (d) {
      return {
        id: d.id, name: d.name, score: round(S[d.id]),
        weight: Math.round(W[d.id] * (1 - SPEC_W) * 100), evidences: ev[d.id], desc: d.desc
      };
    });
    var sorted = arr.slice().sort(function (a, b) { return b.score - a.score; });
    var highlights = sorted.slice(0, 2).map(function (x) { return x.name + ' ' + x.score + ' 分'; });
    var gaps = sorted.slice(-2).reverse().map(function (x) { return x.name + ' ' + x.score + ' 分'; });
    if (spec.score < 70) gaps.push(specName + ' ' + spec.score + ' 分');

    /* —— 风险项 —— */
    var risks = [];
    function risk(lv, t, d) { risks.push({ lv: lv, t: t, d: d }); }

    if (opt.ebike) risk('dan', '电动车入户或楼道充电', '这是近年住宅火灾最常见也最致命的成因。要求必须在室外集中充电棚充电，楼道内严禁私拉电线；若小区没有充电设施，需把这一项列为否决项。');
    if (opt.clutter) risk('dan', '楼道/消防通道堆物', '火灾时唯一可用的逃生通道被占用，等于把逃生时间让给了杂物。看房当天拍下照片，签约前要求清理并写入合同。');
    if (opt.stair2 === 'no' && H >= 7) risk('dan', '只有一部疏散楼梯', '7 层以上仅一部楼梯，一旦被烟火封堵就无替代路径。务必现场确认楼梯间是否为防烟楼梯间、门是否常闭。');
    if (opt.hydrant === 'no') risk(H >= 12 ? 'dan' : 'warn', '消火栓或烟感缺失', '高层住宅火灾前十分钟主要靠建筑自身设施。打开消火栓箱确认水带水枪齐全、有水压，并查看走廊烟感是否在位。');
    if (opt.burglarbar) risk('warn', '防盗窗无逃生口', '全封闭防盗窗在火灾时会把自己困住。要求改造为带逃生口（不小于 1.0×0.8 m）且可从内部开启的款式，钥匙挂在固定位置。');
    if (opt.device) risk('dan', '家中有需电医疗设备', '制氧机、呼吸机、胰岛素冷藏一旦断电即构成直接健康风险。需准备 UPS 或大容量储能、车载逆变器，并提前向社区/物业报备，确认最近有保障电源的公共场所。');
    if (opt.disabled && H >= 7) risk('dan', '行动不便者住高层', '电梯停运时无法自行上下楼，是疏散场景中最难处置的一类。强烈建议改选 3 层以下，或确认有可协助疏散的邻里/物业机制。');
    else if (opt.elderly && H >= 12) risk('warn', '老人住高层', '断电后电梯停运、二次供水中断，老人上下楼与取水都成问题。优先低层，或把必需物资与常用药集中备在住所内。');
    if (opt.flood) risk('dan', '发生过内涝或积水', '暴雨时首层与地下空间最先受损。确认地下车库挡水板与排水泵是否可用，车辆停放位置，以及是否购买过涉水险。');
    if (opt.gas === 'bottle') risk('warn', '使用瓶装液化气', '瓶装气泄漏与爆燃风险高于管道天然气。确认钢瓶检验期、软管不超过 2 米且未老化，并加装燃气报警器。');
    if (opt.partition) risk('warn', '隔断房 / 群租', '隔断改变了原有防火分隔与疏散路径，且人员流动大。这类房源在很多城市本身属于违规，签约前先确认是否被要求整改过。');
    if (opt.camera === 'no') risk('warn', '公共区域无监控', '缺少监控时，入室盗窃与纠纷取证都靠运气。低层住户建议自行加装门口摄像头并升级门锁。');
    if (opt.topfloor) risk('warn', '顶层漏水与水压', '顶层是渗漏与夏季高温的高发位置，停水时水压也最先断。重点看屋面防水层年份、天花板水渍与顶层隔热。');
    if (opt.elevator === 'flaky' && h.floor >= 7) risk('warn', '电梯经常故障', '高层日常与紧急疏散都依赖电梯，频繁困人说明维保不到位。要求查看最近一次年检标志与维保记录。');

    if (!nm || nm.distance > 3000) risk('warn', '医疗距离偏远', '最近医疗机构超过 3 km，突发疾病时送医时间不可控，家中有老人小孩尤其要谨慎。');
    if (opt.elderly && nm && nm.distance > 2000) risk('warn', '老人就医距离偏长', '最近医院 ' + fmtDist(nm.distance) + '，老人突发状况时每一分钟都很关键。建议确认社区医生上门服务与 120 响应时间。');
    if (!nf || nf.distance > 4000) risk('dan', '消防站覆盖弱', '最近消防救援站超过 4 km，高层住宅火灾主要依赖内部消防设施与自救，务必现场确认消火栓、烟感与疏散通道。');
    // 高层和超高层都要判（原来只写了 high，34 层以上的 super 反而漏掉了）
    if ((lv === 'high' || lv === 'super') && (!nf || nf.distance > 2500))
      risk('dan', '高层 + 消防距离', H + ' 层超出多数举高消防车作业高度，疏散只能靠楼梯间，请确认楼梯间是否为防烟楼梯间、有无堆放杂物。');
    if (!(poiBag.convenience || []).length) risk('warn', '断电后补给困难', '1.5 km 内没有便利店，长时间停电时缺少就近补给点，建议常备 3 天量的水与即食食品。');
    if (opt.basement) risk('dan', '地下空间内涝与排烟', '地下/半地下在暴雨内涝与火灾排烟上风险显著高于地面，需确认排水泵、挡水板与机械排烟。');
    if (opt.age != null && Number(opt.age) >= 30) risk('warn', '房龄偏老', '建成约 ' + opt.age + ' 年，重点关注供电容量、给排水管锈蚀、燃气软管与外墙保温层。');
    if (opt.share) risk('warn', '合租安全边界', '合租需确认门锁是否可反锁、插座与大功率电器使用规则、陌生人进出管理。');
    envHits.forEach(function (x) {
      if (x.distance <= (x.label === '殡葬设施' ? 400 : 150))
        risk('warn', '嫌恶设施过近', x.label + '「' + x.name + '」距目标约 ' + fmtDist(x.distance) +
          '，' + (mode === 'buy' ? '买房口径下按 ' + ENV_MODE_MUL.buy + ' 倍计扣分——它会长期挂在估值上。' : '可能影响居住体验。'));
    });

    /* —— 模式专项带来的风险项（这是两种口径最主要的内容差异）—— */
    spec.items.forEach(function (x) {
      if (x.cut >= 14) risk('dan', specName + '：' + x.t, x.s);
      else if (x.cut >= 5) risk('warn', specName + '：' + x.t, x.s);
    });
    if (mode === 'buy' && opt.title === 'unk')
      risk('dan', '产权未核验', '购房必须先做的一步还没做。拿身份证到不动产登记中心拉一次产调，几十元可查清抵押、查封、异议登记，比任何口头承诺都可靠。');
    if (mode === 'buy' && opt.plan === 'unk')
      risk('warn', '控规未查', '新建变电站、垃圾转运站、高架匝道这类规划一旦落地很难逆转。规划局官网查控制性详细规划，重点看周边 1 km 的市政设施用地。');
    if (mode === 'rent' && opt.pay === 'y')
      risk('dan', '要求年付或一次性付多年', '长租公寓暴雷、二房东卷款跑路的受害者大半栽在这一项上。哪怕月租贵一点也要坚持季付，实在要长付请走资金监管账户。');
    if (mode === 'rent' && opt.lease === 'short')
      risk('warn', '短租 / 月付', '短租意味着你随时要重新找房，也不受「买卖不破租赁」等长期租约的保护，有搬家预算才考虑。');
    if (mode === 'rent' && opt.lease === 'unk' && opt.pay === 'unk')
      risk('warn', '租约条款尚未敲定', '租期与付款方式都没确定就评估，这一块只能按有风险计入；谈拢后重跑一次，分数通常会有变化。');

    if (!risks.length) risk('ok', '未发现显著硬伤', '关键保障资源齐备，按下方清单做常规核实即可。');

    /* —— 补充信息对评分的影响（透明化） —— */
    var notes = [];
    function note(s) { if (s) notes.push(s); }
    if (lv === 'mid') note('楼栋约 ' + H + ' 层：消防安全 −4 分，消防权重小幅上调');
    if (lv === 'high') note('高层（约 ' + H + ' 层）：消防安全 −8 分，消防权重上调，云梯覆盖受限');
    if (lv === 'super') note('超高层：消防安全 −13 分，消防权重显著上调，断电韧性 −5 分（二次供水）');
    if (opt.basement) note('地下/半地下：消防 −8、断电 −6、环境 −4');
    if (opt.topfloor) note('顶层：断电韧性 −3（水压与电梯依赖）');
    if (opt.ebike) note('电动车入户/楼道充电：消防安全 −10');
    if (opt.clutter) note('楼道堆物：消防安全 −8');
    if (opt.stair2 === 'no') note('仅一部疏散楼梯：消防安全 −' + (H >= 7 ? 9 : 5));
    if (opt.hydrant === 'no') note('消火栓/烟感缺失：消防安全 −7');
    if (opt.burglarbar) note('防盗窗无逃生口：消防安全 −5');
    if (opt.gas === 'bottle') note('瓶装液化气：消防安全 −4');
    if (opt.partition) note('隔断/群租：消防 −5、治安 −4');
    if (opt.share) note('合租：治安门禁 −6');
    if (opt.camera === 'no') note('无监控：治安门禁按低分计入');
    if (opt.elevator === 'none' && h.floor >= 7) note('无电梯且住在 ' + h.floor + ' 层：断电韧性 −9、生活保障 −6');
    if (opt.elevator === 'flaky' && h.floor >= 7) note('电梯常故障且住在 ' + h.floor + ' 层：断电韧性 −5');
    if (opt.device) note('需电医疗设备：断电韧性 −8，医疗与断电权重同时上调');
    if (opt.elderly || opt.toddler) note('家中有老人/幼儿：医疗权重上调，断电韧性 −3');
    if (opt.disabled && H >= 7) note('行动不便者住 ' + H + ' 层：消防安全额外 −6，消防权重再上调');
    if (opt.flood) note('曾发生内涝：环境风险 −10，环境权重上调');
    if (opt.age != null && Number(opt.age) >= 30) note('房龄约 ' + opt.age + ' 年：消防 −6、断电 −5');

    /* —— 模式专项对总分的影响（透明化）—— */
    spec.items.forEach(function (x) {
      if (x.cut > 0) note(specName + '：' + x.t + ' −' + x.cut + ' 分（该项占总分 ' + Math.round(SPEC_W * 100) + '%）');
    });
    note('本次口径为「' + (mode === 'rent' ? '租房' : '购房') + '」：' + specName + '这一块占总分 ' +
      Math.round(SPEC_W * 100) + '%，是另一口径没有的评估项。');
    if (mode === 'buy') note('购房口径：环境嫌恶设施按 ' + ENV_MODE_MUL.buy + ' 倍计扣分（对租客是阶段性损失，对业主是永久估值折损）');

    /* —— 清单 —— */
    var p72 = buildPower72(poiBag, opt, R, h);
    var visit = buildVisit(mode, opt, poiBag, R, h);

    function withRoute(p, r) {
      if (!p) return null;
      var o = {};
      for (var k in p) o[k] = p[k];
      o.route = r || null;
      return o;
    }

    return {
      mode: mode, score: total, grade: grade, gradeTxt: GRADE_TXT[grade],
      dims: arr, highlights: highlights, gaps: gaps, risks: risks,
      envHits: envHits, power72: p72, visit: visit, weight: W, env: opt, notes: notes,
      spec: {
        name: specName, intro: SPEC[mode].intro,
        score: round(spec.score), items: spec.items,
        weight: Math.round(SPEC_W * 100)
      },
      baseScore: round(baseScore),
      facts: {
        med: withRoute(nm, R.med),
        fire: withRoute(nf, R.fire),
        shelter: withRoute(nearest(poiBag.shelter), R.shelter),
        market: withRoute(nearest(poiBag.market), R.market),
        supermarket: withRoute(nearest(poiBag.supermarket), R.supermarket),
        convenience: withRoute(nearest(poiBag.convenience), R.convenience),
        metro: withRoute(nearest(poiBag.metro), R.metro),
        police: withRoute(nearest(poiBag.police), R.police),
        pharmacy: withRoute(nearest(poiBag.pharmacy), R.pharmacy)
      },
      poiBag: poiBag
    };
  }

  /* ---------------- 断电 72 小时清单 ---------------- */
  function buildPower72(poi, opt, R, h) {
    var L = [];
    var H = h.H;

    L.push({
      t: '储水：按每人每天 3 升备足 3 天',
      s: H >= 19 ? '高层靠二次供水泵，停电即停水，务必把水备在住所内而非楼下' : '电梯停运时高层取水极困难，优先备在住所内'
    });
    L.push({
      t: '照明与通信：手电 / 头灯 + 充电宝（≥20000mAh）+ 收音机',
      s: '手机是唯一信息源，关掉非必要后台，只保留通讯与地图'
    });

    if (opt.device) {
      L.push({
        t: '生命支持电源：UPS 或储能电源 + 车载逆变器，至少覆盖设备 8 小时',
        s: '提前向社区/物业报备「有需电医疗设备」，问清应急发电机接口或就近可充电的公共场所'
      });
    }
    if (opt.elderly) {
      L.push({
        t: '老人专项：常用药备满 7 天量 + 保暖衣物 + 纸质紧急联系人卡',
        s: '老人对停暖停水耐受差，提前联系邻居或物业约定每日照看'
      });
    }
    if (opt.toddler) {
      L.push({
        t: '婴幼儿专项：奶粉、即饮热水、纸尿裤、常用退烧药各备 3 天量',
        s: '断电后无法烧水，优先准备不需加热的即食型辅食与常温水'
      });
    }
    if (opt.pet) {
      L.push({ t: '宠物：3 天量的粮与水 + 便携猫砂/尿垫', s: '断电后宠物医院多半停诊，外伤与常备药提前备一份' });
    }
    if (H >= 7) {
      L.push({
        t: '高层预案：提前确认楼梯间位置、是否可自然采光',
        s: opt.elevator === 'none' ? '无电梯，' + h.floor + ' 层上下一趟体力消耗大，把重物提前分批次备好'
          : opt.elevator === 'flaky' ? '电梯本就常故障，别把必需物资放在依赖电梯的位置'
          : '电梯大概率停运，把必需物品集中在住所内'
      });
    }
    if (opt.flood || opt.basement) {
      L.push({
        t: '防水：挡水板 / 沙袋 + 重要物品上移 + 车辆提前转移至高处',
        s: '暴雨预警发出后应立刻执行，地下与首层的反应窗口通常只有几十分钟'
      });
    }

    var m = nearest(poi.market), s = nearest(poi.supermarket), c = nearest(poi.convenience);
    var near = [s, m, c].filter(Boolean).sort(function (a, b) { return a.distance - b.distance; })[0];
    var rid = near === s ? 'supermarket' : near === m ? 'market' : 'convenience';
    var rt = R && R[rid];
    L.push({
      t: '补给点：' + (near ? near.name + '（' + (rt ? routeTxt(rt) + '，实测路网距离'
          : '直线 ' + fmtDist(near.distance) + '，按路网折算约 ' + Math.max(1, Math.round(near.distance / 80 * 1.25)) + ' 分钟') + '）'
          : '附近未检索到稳定补给点'),
      s: rt ? '以上为高德实际步行路径，非直线距离换算' : '未取到实际路径，此处的分钟数为直线距离按路网系数折算的估值'
    });
    L.push({
      t: '药品：退烧、止泻、抗过敏、创可贴、慢性病用药各备一份',
      s: '最近药店：' + (nearest(poi.pharmacy) ? nearest(poi.pharmacy).name + '（' + distTxt(nearest(poi.pharmacy), R && R.pharmacy) + '）' : '未检索到，需自行常备')
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
  function buildVisit(mode, opt, poi, R, h) {
    var L = [];
    L.push({ t: '夜间走一遍：楼梯间照明、楼道堆物、单元门禁是否常闭', s: '消防通道被占用是老小区最常见的硬伤' });
    L.push({ t: '确认水电燃气：电表容量、燃气软管年限、是否有漏水痕迹', s: '重点看厨卫天花板与外墙内渗水' });
    L.push({ t: '问清物业与停车：物业公司名称、响应时间、车位是否固定', s: '无物业或无门禁的小区，治安维度需自行加权' });
    L.push({ t: '实测通勤：工作日早高峰从门口走到最近地铁站', s: poi.metro && poi.metro.length ? '最近：' + poi.metro[0].name + '（' + distTxt(poi.metro[0], R && R.metro) + '）' : '附近无地铁，需依赖公交或自驾' });
    L.push({ t: '手机信号与电梯：进电梯和地下车库试通话', s: '被困时能否求救取决于这一项' });
    L.push({ t: '查看窗外：是否正对变电站、垃圾站、铁路或主干道', s: '白天看房容易忽略噪音与异味' });
    L.push({ t: '问邻居或保安：近两年是否发生过内涝、停电、入室盗窃', s: '本地经验比任何数据都准' });

    // —— 消防专项 ——
    if (opt.hydrant !== 'yes') {
      L.push({ t: '打开消火栓箱看一眼：水带水枪是否齐全、有没有水压表读数', s: '顺便按下手动报警按钮，问物业消防控制室多久能确认' });
    }
    if (opt.stair2 !== 'yes') {
      L.push({ t: '从所在楼层走楼梯到地面一次，数一下有几部楼梯、防火门是否常闭', s: '只有一部楼梯的高层，把这一条当作一票否决项' });
    }
    if (opt.ebike) {
      L.push({ t: '看电动自行车管理：有无室外集中充电棚，楼道内有无私拉电线', s: '有集中充电棚的小区可显著降低火灾风险' });
    }
    if (opt.burglarbar) {
      L.push({ t: '确认防盗窗是否有逃生口、能否从内部徒手打开', s: '逃生口不小于 1.0×0.8 m，钥匙要挂在全家都知道的固定位置' });
    }
    if (opt.gas === 'bottle' || opt.gas === 'unk') {
      L.push({ t: '燃气细节：软管是否超过 2 米、有无老化开裂、是否装了燃气报警器', s: '软管建议两年一换，报警器几十块钱能救命' });
    }
    if (opt.elevator !== 'ok') {
      L.push({ t: '看电梯：年检标志有效期、维保单位、最近一次困人记录', s: '问物业电梯是否接双电源，停电时是否有平层装置' });
    }

    // —— 人员结构专项 ——
    if (opt.elderly || opt.disabled) {
      L.push({ t: '无障碍核查：单元门门槛高度、有无坡道、电梯轿厢能否进轮椅', s: '同时确认社区医生上门服务与 120 到该小区的平均时间' });
    }
    if (opt.toddler) {
      L.push({ t: '有幼儿要额外看：阳台栏杆间距、窗户限位器、桌角与插座保护', s: '坠落与触电是幼儿居家最常见的事故' });
    }
    if (opt.device) {
      L.push({ t: '问物业是否配备应急发电机、能否为医疗设备提供临时供电接口', s: '把「有需电医疗设备」写进租赁合同或物业登记，突发停电时会被优先处理' });
    }
    if (opt.flood) {
      L.push({ t: '看防汛：地下车库入口挡水板、排水泵是否可用、有无防汛沙袋', s: '问清历史上最深的一次积水到什么位置' });
    }
    if (opt.topfloor) {
      L.push({ t: '顶层防水：看屋面防水层年份、天花板与墙角有无水渍', s: '雨季看房最能暴露顶层渗漏问题' });
    }

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
    QUERIES: QUERIES, DIMS: DIMS, WEIGHT: WEIGHT, RADIUS_TXT: RADIUS_TXT,
    evaluate: evaluate, fmtDist: fmtDist, haversine: haversine,
    routeTxt: routeTxt, distTxt: distTxt, resolveHeight: resolveHeight,
    MED_NOISE: MED_NOISE, pickMed: pickMed, medChain: medChain,
    scoreColor: scoreColor, clamp: clamp
  };
})();

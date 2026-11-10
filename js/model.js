/**
 * 安居综合评估 · 评分模型
 * 输入：周边 POI 检索结果 + 真实路径规划结果 + 用户补充信息
 * 输出：五维得分（+ 不计分的生活配套参考）、总分、等级、结论、清单、风险项
 *
 * 距离口径说明（2026-11-10 改）：
 *   distance —— 默认就是「步行路网距离」：app.js 用 AMap.Walking 对每类最近的
 *               2–4 个点位算出真实步行路线长度，写回 distance，并按它重排。
 *               消防站例外，按 AMap.Driving 算消防车到场距离。
 *   line     —— 原始的直线距离（高德周边搜索返回），只作参考写在括号里。
 *   route    —— { d, t, mode }，路网距离与耗时；报告里「步行 X 约 N 分钟」用它。
 *   没有算到路网的点位（每类里排在第 4 个之后的）按 line × 1.3 估值并标 est，
 *   它们既不进计分（计分只取最近一个），也不会被写成「实测路网距离」。
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
   * pages:2 用于总数超过单页上限的类别（便利店 1.5 km 内实测 78 家，单页只装得下 50 家）。 */
  /* 每个类别优先按「高德 POI 类型」检索，关键词只作兜底（见 amap.js nearQuery）。
   *
   * 【为什么要按类型检索】高德的关键词召回要求 POI 名字里含有该词，但大量门店
   * 名字里根本没有类型名——便利蜂、京客隆便利店、惠佳美食品店都不含「便利店」，
   * 叮当快药不含「药店」，京客隆便利店不含「便利店」。靠堆品牌词补是补不完的，
   * 而按类型检索能一次性把「名不副实」的门店全部召回。
   *
   * 【关键词串不宜太长】高德对 `A|B|C` 的处理不稳定：实测「物美|便利蜂」两个词
   * 都生效，但「便利蜂|物美|罗森|全家|好邻居」只召回了第一个词。所以每个 kw
   * 控制在 3 个近义词以内，覆盖面主要靠 type 而不是靠长串。
   *
   * 【哪些类有 type】实测可用的类型名：医院 / 卫生院 / 药房 / 公园 / 超级市场 /
   * 便利店 / 地铁站 / 加油站 / 陵园。
   * 实测 no_data、只能靠关键词的：消防队、消防站、派出所、警务站、体育场、
   * 菜市场、农贸市场、公交站、变电站、垃圾站、环卫设施、殡仪馆。 */
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
    // 学校（小学/中学）不检索：本工具只做安全与应急口径，学区与就学不属于评估范围
    { id: 'gas',          label: '加油站',       type: '加油站',   kw: '加油站',                    radius: 1500 },
    { id: 'substation',   label: '变电站',                         kw: '变电站|变电所',              radius: 1500 },
    { id: 'refuse',       label: '垃圾站',                         kw: '垃圾站|垃圾中转站',          radius: 1500 },
    { id: 'funeral',      label: '殡葬设施',     type: '陵园',     kw: '殡仪馆|火葬场|陵园',           radius: 3000 }
  ];

  /* 检索半径是分级配置的（消防 6 km、医院 5 km、地铁/公园 3 km、便利店 1.5 km、公交 1 km），
   * 对外统一说「3 公里」是不准确的，文案一律引用这个常量 */
  var RADIUS_TXT = '分级检索：公交 1 km；便利店、药店、加油站、变电站、垃圾站 1.5 km；超市与菜场 2 km；公园、地铁、警务、殡葬 3 km；医院 5 km；消防 6 km';

  // 医疗类噪声：口腔、宠物、美容、门诊等不算可用的综合医疗资源
  var MED_NOISE = /口腔|牙科|宠物|美容|整形|视力|眼镜|体检|不孕|男科|中医馆|推拿|按摩|健疗|疗养|旗舰|医美|眼科|诊所/;

  /* ---------------- 维度定义 ----------------
   * 【2026-10-11 改版：六维 → 五维】
   * 原来的「生活保障」维（地铁 / 公交 / 采买，占 16%）被拿掉了。理由（用户拍板）：
   *   通勤与采买决定的是「住着累不累」，属于**配套设施**，不构成安全条件，
   *   把它算进「综合安全分」会让分数含义变混——一套地铁口、但消防与医疗都很差的房子，
   *   不该因为通勤方便而在安全评估里拿高分。
   * 处理方式不是删掉信息，而是把它降级成一个**不计入总分**的参考区块（见 AMENITY），
   * 报告里照样给出地铁 / 公交 / 超市菜场 / 便利店 / 加油站的距离，只是不影响分数。
   * 释放出来的 16% 权重按原比例摊回其余四维，环境维保持 .10 不动
   * （因为它的内容在同一轮里也一起瘦身了，见下面 ENV 口径调整）。 */
  var DIMS = [
    { id: 'em',    name: '应急医疗', icon: '＋', desc: '最近医院、社区卫生服务中心与药店的覆盖' },
    { id: 'fire',  name: '消防安全', icon: '火', desc: '消防站车程、避难开阔地、楼层高度与疏散条件' },
    { id: 'power', name: '断电韧性', icon: '电', desc: '停电 72 小时内能否就近获得水、食物与药品' },
    { id: 'safe',  name: '治安门禁', icon: '安', desc: '警务资源距离与小区自身门禁、监控、居住形态' },
    { id: 'env',   name: '环境风险', icon: '环', desc: '垃圾站异味与内涝等长期影响，加油站 / 变电站按低概率事故计' }
  ];

  /* 生活配套：只展示、不计分（原来的「生活保障」维） */
  var AMENITY = {
    name: '生活配套',
    intro: '通勤、采买与加油决定你住着累不累，属于配套设施而不是安全条件，因此不计入综合安全分——这里只作参考，需要通勤便利的话自己看这一块。'
  };
  /* 配套便利度内部构成（仅用于把这个区块排个序，不进总分） */
  var AMENITY_W = { metro: .38, bus: .22, buy: .30, gas: .10 };

  /* 五维基准权重（buildWeight 之后归一化，这里不必凑成 1）。
   *
   * 【两种口径的这组权重刻意是一样的】这是个被实测推翻过的设计。
   * 原来的 rent/buy 权重不同（租房 safe .20/env .08，买房 safe .14/env .22），
   * 结果在忠实里这种地方实测下来：买房 91.5 反而高于租房 91.2。原因是加权平均的性质——
   * 五维不可能同时满分，谁把权重压在「当前较弱的维度」上，谁的总分就更低。
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
    rent: { em: .231, fire: .219, power: .219, safe: .231, env: .100 },
    buy:  { em: .231, fire: .219, power: .219, safe: .231, env: .100 }
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

  /* ---------------- 综合适配：按用途加权的第二层 ----------------
   * 【为什么加这一层（2026-11-10，用户拍板采纳朋友建议）】
   * 上一版把通勤与采买整体降级成「不计分参考」，安全口径是干净了，
   * 但一套地铁口、消防站很远的小区，和一套消防很强、出门要走 1.5 km 的小区，
   * 报告看不出「对谁更合适」——因为用途没进模型。
   * 现在的结构是两层：
   *   第一层 安全分（五维 + 模式专项）：用途变了它也不变，保证横向可比；
   *   第二层 综合适配分：安全 / 通勤 / 采买三块按用途重新加权。
   * 参考的行业做法：贝壳「必看好房」五维 160+ 字段并随城市动态调权，
   * 惠居 HQI 五维品质分加钻石/黄金/白银分级，好房评选六维并输出改进建议。
   * 共同点是「多维度 + 按需求调权 + 分级 + 可执行建议」，这里取前两项。
   *
   * 不加目的地导航：算一条到公司的真实路线要 geocode + route 两次请求，
   * 每个地址多花 2 次配额，对一次评估 20 多次请求的预算不划算。
   * 通勤改用「最近地铁 + 最近公交」代理，报告里说清这是代理口径。
   */
  /* 【2026-11-10 二次改版：用途与「最在意」必须改变结论，而不只是改一个百分数】
   * 上一版把用途做成三块权重的预设，实际用起来有两个问题（用户反馈）：
   *   ① 幅度太小：需求调整只有 ±5~10 个百分点，归一化后常常只剩 2~3 个点，
   *      报告里写着「权重 44%」，看不出自己勾的东西到底起没起作用；
   *   ② 只有权重、没有结论：「怕吵」「有车」这类诉求只影响一个百分数，
   *      报告里从头到尾没有一句话回答「我怕吵，这套房到底吵不吵」。
   * 现在补三件事：
   *   · 权重推演表（trace）：基准用途 → 每条在意项加减 → 归一化，每一步摊开写；
   *   · 在意项逐条打分（concerns）：每个勾选项独立给 0–100 分 + 依据 + 判定（见 buildConcerns）；
   *   · 其它用途对照（alts）：同一套房换成别的用途适配分会变成多少，一键可切。
   * 需求调整幅度放大到 ±6~16 个百分点，保底从 0 提到 8%，
   * 避免「怕吵 + 家有老人」把通勤压到 0 之后报告里连一行都不剩。 */
  var FIT = {
    name: '综合适配',
    intro: '安全分回答「出事时靠不靠得住」，这一层回答「按你的用途合不合适」：安全、通勤、采买三块按用途重新加权，再扣「用途门槛」——每个用途各有几条硬条件（养老看医院距离、通勤看地铁距离、投资看流动性），不达标就扣分并写明是哪一条；你在意的每一项还会单独打分。安全分本身不随用途变化，方便几套房子横向比。通勤用最近地铁与公交的距离代理，没有取到你公司的真实路线。',
    BASE: {
      commute: { name: '上班通勤自住', safe: .40, go: .45, buy: .15, note: '早出晚归，地铁与公交通勤的时间成本最先被感知。' },
      family:  { name: '家庭常住',     safe: .60, go: .20, buy: .20, note: '家里有老人小孩，应急医疗与消防的权重要压过通勤。' },
      invest:  { name: '投资保值',     safe: .35, go: .45, buy: .20, note: '转手时买家先问离地铁多远，通勤与配套决定流动性。' },
      retire:  { name: '养老 / 图安静', safe: .62, go: .13, buy: .25, note: '日常活动半径小，医疗距离与环境安静比通勤重要。' },
      solo:    { name: '独居 / 学习',   safe: .45, go: .30, buy: .25, note: '一个人住，采买与通勤的便利度权重更高。' }
    },
    /* 「最在意」的权重调整：归一化后至少要看得出 5 个百分点以上的变化 */
    NEEDS: {
      commuteDaily: { name: '每天通勤',        go: .16,  safe: -.08, buy: -.08 },
      cook:         { name: '常在家做饭',      buy: .14, safe: -.06, go: -.06 },
      car:          { name: '有车',            go: -.14, buy: .06,  safe: .06 },
      quiet:        { name: '怕吵 / 看重环境', safe: .12, go: -.06, buy: -.06 },
      elder:        { name: '家有老人',        safe: .14, go: -.07, buy: -.07 },
      resale:       { name: '看重转手 / 保值', go: .10,  buy: .04,  safe: -.10 }
    },
    FLOOR: .08
  };

  /* 每个「最在意」项对应一个独立评分卡；分数怎么算见 buildConcerns */
  var CONCERN_DEF = {
    commuteDaily: { name: '每天通勤' },
    cook:         { name: '常在家做饭' },
    car:          { name: '有车' },
    quiet:        { name: '怕吵 / 看重环境' },
    elder:        { name: '家有老人' },
    resale:       { name: '看重转手 / 保值' }
  };
  function levelOf(v) { return v >= 85 ? '满足' : v >= 70 ? '基本满足' : v >= 55 ? '勉强' : '不满足'; }

  /* 等级文案。提到模块作用域是因为现在有两个分数都要用：
   * 安全分（evaluate 里）和综合适配分（buildFit 里）。
   * 头部分数改成适配分之后，徽章与这句话必须跟着适配分走，不能各说各的。 */
  var GRADE_TXT = {
    A: '整体条件优秀，可以进入砍价/签约环节',
    B: '主体条件可接受，按清单补齐几项即可',
    C: '存在明确短板，务必实地核实后再决定',
    D: '关键保障缺失较多，除非价格极低否则不建议'
  };
  function gradeOf(v) { return v >= 85 ? 'A' : v >= 70 ? 'B' : v >= 55 ? 'C' : 'D'; }

  /** 用途 + 需求 -> 最终三块权重（已归一化到 100）与推演过程 */
  function fitWeights(purpose, needs) {
    var key = FIT.BASE[purpose] ? purpose : 'commute';
    var base = FIT.BASE[key];
    var w = { safe: base.safe, go: base.go, buy: base.buy };
    var rows = [{ label: '基准 · ' + base.name, kind: 'base',
      v: [Math.round(base.safe * 100), Math.round(base.go * 100), Math.round(base.buy * 100)] }];
    var used = [], floored = false;
    (needs || []).forEach(function (n) {
      var d = FIT.NEEDS[n]; if (!d) return;
      used.push(n);
      w.safe += d.safe || 0; w.go += d.go || 0; w.buy += d.buy || 0;
      rows.push({ label: '在意 · ' + d.name, kind: 'need',
        v: [Math.round((d.safe || 0) * 100), Math.round((d.go || 0) * 100), Math.round((d.buy || 0) * 100)] });
    });
    var sum = 0;
    ['safe', 'go', 'buy'].forEach(function (k) {
      if (w[k] < FIT.FLOOR) { w[k] = FIT.FLOOR; floored = true; }
      sum += w[k];
    });
    var pct = { safe: w.safe / sum * 100, go: w.go / sum * 100, buy: w.buy / sum * 100 };
    /* 保底要在百分数层面再做一次：归一化会把刚托到 8% 的那一块重新压回 6% 左右，
     * 那样「保底」就只是句口号。这里把低于 8% 的补到 8%，差额按比例从其他两块扣。 */
    for (var guard = 0; guard < 3; guard++) {
      var low = ['safe', 'go', 'buy'].filter(function (k) { return pct[k] < FIT.FLOOR * 100 - .01; });
      if (!low.length) break;
      var deficit = 0;
      low.forEach(function (k) { deficit += FIT.FLOOR * 100 - pct[k]; pct[k] = FIT.FLOOR * 100; floored = true; });
      var others = ['safe', 'go', 'buy'].filter(function (k) { return low.indexOf(k) < 0; });
      var osum = others.reduce(function (s, k) { return s + pct[k]; }, 0);
      if (osum <= 0) break;
      others.forEach(function (k) { pct[k] -= deficit * pct[k] / osum; });
    }
    var out = { safe: Math.round(pct.safe), go: Math.round(pct.go), buy: Math.round(pct.buy) };
    // 四舍五入会让三块加起来不等于 100，差值补在占比最大的那一块上
    var diff = 100 - (out.safe + out.go + out.buy);
    if (diff) {
      var big = ['safe', 'go', 'buy'].sort(function (a, b) { return pct[b] - pct[a]; })[0];
      out[big] += diff;
    }
    rows.push({ label: '归一化后', kind: 'final', v: [out.safe, out.go, out.buy] });
    return { key: key, base: base, used: used, rows: rows, w: out, floored: floored };
  }

  /** 只算分、不生成文案：给「换成别的用途会怎样」用 */
  function fitScoreOf(purpose, needs, safe, go, buy, ctx) {
    var f = fitWeights(purpose, needs);
    var raw = f.w.safe * safe / 100 + f.w.go * go / 100 + f.w.buy * buy / 100;
    return round(clamp(raw - gateSum(purpose, ctx), 0, 100));
  }

  /* ---------------- 用途门槛 ----------------
   * 【为什么光有权重不够（2026-11-10 实测）】
   * 加权平均压不出真正的差别：三块都在 85 分以上时，任何权重组合的结果都落在同一小段里。
   * 实测同一套房五个用途只差 0.2 分（87.3 / 87.1 / …），用户看到的感受就是「换了没反应」。
   * 但现实里换用途是有硬条件的：养老的人不能接受医院在 3 km 外，通勤族不能接受地铁在 2 km 外。
   * 所以每个用途配一组门槛，达不到就扣分，并且把「哪一条没过」写进报告——
   * 换用途改的就不只是一个百分数，还有理由。
   * 门槛封顶 12 分，权重仍然是主导；超了就按比例缩，不改变各条的相对严重程度。 */
  var GATE_CAP = 12;
  function buildGates(purpose, c) {
    var out = [], d = c || {};
    function gate(cut, t, why, hit) { if (hit) out.push({ cut: cut, t: t, why: why }); }
    var none = function (v) { return v == null; };

    if (purpose === 'commute') {
      gate(8, '地铁超过 1.5 km',
        '通勤主要靠地铁，1.5 km 之外的接驳时间常常比坐车本身还长', none(d.metro) || d.metro > 1500);
      gate(4, '公交站超过 800 m',
        '连公交都不在步行舒适范围，雨天和加班晚了最明显', none(d.bus) || d.bus > 800);
    } else if (purpose === 'family') {
      gate(7, '医院超过 2.5 km',
        '小孩发烧、老人急症这类事上，2.5 km 之外每趟都得打车', none(d.med) || d.med > 2500);
      gate(5, '消防站超过 4 km',
        '有小孩的家庭对火灾更敏感，救援半径偏大', none(d.fire) || d.fire > 4000);
    } else if (purpose === 'invest') {
      gate(9, '地铁超过 2 km',
        '转手时买家第一句就问离地铁多远，2 km 之外议价空间明显变大', none(d.metro) || d.metro > 2000);
      gate(6, '环境分低于 70',
        '嫌恶设施会长期压在估值上，买家看房时一定会问', d.env != null && d.env < 70);
    } else if (purpose === 'retire') {
      gate(9, '医院超过 2 km',
        '养老用途就医频次高，2 km 之内才算「随时能去」', none(d.med) || d.med > 2000);
      gate(5, '环境分低于 75',
        '噪声与异味对老人的睡眠和情绪影响更大', d.env != null && d.env < 75);
    } else if (purpose === 'solo') {
      gate(6, '采买分低于 70',
        '一个人住多半没车，米面油全靠步行拎回来', d.buyScore != null && d.buyScore < 70);
      gate(4, '便利店超过 500 m',
        '夜间临时补给要能走着去', none(d.cv) || d.cv > 500);
    }
    var sum = 0;
    out.forEach(function (x) { sum += x.cut; });
    if (sum > GATE_CAP) {
      out.forEach(function (x) { x.cut = round(x.cut * GATE_CAP / sum); });
    }
    return out;
  }
  function gateSum(purpose, c) {
    return buildGates(purpose, c).reduce(function (s, x) { return s + x.cut; }, 0);
  }

  /* ---------------- 最在意项：逐条打分 ----------------
   * 为什么每条都要单独算：三块权重只能表达「更看重哪一块」，
   * 但用户勾「怕吵」时想知道的是「这套房吵不吵」，勾「有车」时想知道「停车难不难」。
   * 权重回答不了这个问题，只能再给每条诉求配一个可解释的分数与依据。
   * 这些分数只用于展示与结论句，不反向参与总分（否则会被用途与需求互相干扰）。 */
  function buildConcerns(c) {
    var opt = c.opt || {}, bag = c.poiBag || {}, R = c.R || {}, h = c.h || { floor: 0, H: 0 };
    var out = [];
    function add(id, score, note, ev) {
      var v = round(clamp(score, 0, 100));
      out.push({ id: id, name: CONCERN_DEF[id].name, score: v, level: levelOf(v),
                 note: note, evidence: (ev || []).filter(Boolean) });
    }
    (opt.needs || []).forEach(function (id) {
      if (!CONCERN_DEF[id]) return;

      if (id === 'commuteDaily') {
        var mt = nearest(bag.metro), bs = nearest(bag.bus);
        add(id, c.sGo,
          (c.sGo >= 85 ? '地铁与公交都在步行可接受范围内，日常通勤不折腾。'
           : c.sGo >= 70 ? '能通勤，但离站还有一段距离，雨天和加班晚了会比较明显。'
           : c.sGo >= 55 ? '通勤偏累：站点不算近，建议工作日早高峰实地走一次再决定。'
           : '通勤这块基本没有便利可言，除非你有车或能接受长距离接驳。'),
          ['地铁：' + (mt ? distTxt(mt, R.metro) : '3 km 内未检索到'),
           '公交：' + (bs ? distTxt(bs, R.bus) : '1 km 内未检索到'),
           '口径：通勤分 = 地铁 60% + 公交 40%。没有接你公司的真实路线，请按上面的距离自己折一次']);
      }

      if (id === 'cook') {
        var mk = nearest(bag.market), sp = nearest(bag.supermarket), cv = nearest(bag.convenience);
        var gasS = ({ pipe: 95, bottle: 72, none: 52, unk: 74 })[opt.gas] || 74;
        var sc = c.sBuy * .7 + gasS * .3;
        add(id, sc,
          (sc >= 85 ? '买菜、买调料、临时补货都在步行范围内，自己开火的成本很低。'
           : sc >= 70 ? '日常做饭没问题，个别食材可能要跑一趟远一点的超市。'
           : sc >= 55 ? '采买不算方便，常做饭的话要提前规划一周的采购。'
           : '采买距离偏远，常做饭很消耗精力，先确认生鲜配送是否覆盖这里。'),
          ['菜市场：' + (mk ? distTxt(mk, R.market) : '2 km 内未检索到'),
           '超市：' + (sp ? distTxt(sp, R.supermarket) : '2 km 内未检索到'),
           '便利店：' + (cv ? distTxt(cv, R.convenience) : '1.5 km 内未检索到'),
           '燃气：' + ({ pipe: '管道天然气（可直接开火）', bottle: '瓶装液化气（要换气，留意软管年限）',
                        none: '无燃气（只能用电磁炉，爆炒受限）', unk: '未确认燃气类型' }[opt.gas] || '未确认')]);
      }

      if (id === 'car') {
        var pk = ({ fixed: 95, street: 54, none: 20, unk: 60 })[opt.parking] || 60;
        var gasN = nearest(bag.gas);
        var gs = distScore(bag.gas, [[800, 100], [1500, 88], [3000, 70]], 55);
        var scCar = pk * .6 + gs * .4;
        add(id, scCar,
          (scCar >= 85 ? '有固定车位、加油也近，用车成本低。'
           : scCar >= 70 ? '用车基本顺手，车位或加油至少占了一样便宜。'
           : scCar >= 55 ? '停车是这一项的短板，老小区尤其要提前问清车位归属与月租。'
           : '车位与加油两项都偏弱，有车的话日常会持续添麻烦。'),
          ['车位：' + ({ fixed: '有固定 / 产权车位', street: '只能路边随停', none: '小区无车位',
                        unk: '未确认（按老小区常见情况估）' }[opt.parking] || '未确认'),
           '加油站：' + (gasN ? distTxt(gasN, R.gas) : '1.5 km 内未检索到'),
           '有车之后地铁不再是唯一选项，报告已按「有车」把通勤权重下调']);
      }

      if (id === 'quiet') {
        var pen = 0, ev3 = [];
        if (opt.street) {
          pen += 18;
          ev3.push('临主干道 / 高架 / 铁路：−18 分——这是夜间最难忍的一类，只有实地听才算数');
        }
        (c.envHits || []).forEach(function (x) {
          var p = 0;
          if (/垃圾/.test(x.label)) { p = Math.min(20, x.cut * 1.25); }
          else if (/变电站/.test(x.label)) { p = Math.min(8, x.cut * 1.6); }
          else if (/加油/.test(x.label)) { p = Math.min(8, x.cut * 1.6); }
          pen += p;
          ev3.push(x.label + '：' + x.name + '（' + shortDist(x) + '）' +
            (p ? '，噪声 / 异味 −' + Math.round(p) + ' 分' : '，不构成噪声干扰'));
        });
        if (h.floor >= 1 && h.floor <= 3) {
          pen += 6;
          ev3.push('住 ' + h.floor + ' 层：地面噪声与灰尘直冲窗口，−6 分');
        }
        if (!ev3.length) ev3.push('1.5–3 km 内没有垃圾站、加油站、变电站、殡葬设施，也没有登记临街信息');
        ev3.push('建议晚上 21:00 之后再来一次：楼上脚步、电梯井、马路低频噪声白天根本听不出来');
        add(id, 100 - pen,
          (100 - pen >= 85 ? '环境安静，近处没有持续噪声源。'
           : 100 - pen >= 70 ? '整体安静，只有一处轻度噪声源，关窗基本能解决。'
           : 100 - pen >= 55 ? '噪声是明显的日常干扰，务必在晚高峰与夜间各去一次。'
           : '噪声与异味会长期影响睡眠，除非你对声音不敏感，否则建议直接放弃。'),
          ev3);
      }

      if (id === 'elder') {
        var vert = opt.elevator === 'ok' ? (h.floor >= 4 ? 88 : 96)
                 : opt.elevator === 'flaky' ? 52
                 : opt.elevator === 'none' ? (h.floor >= 4 ? 22 : 78) : 64;
        var scE = c.sEm * .4 + vert * .3 + c.sFire * .3;
        add(id, scE,
          (scE >= 85 ? '就医近、上下楼方便、消防可达性也好，是适合老人的条件。'
           : scE >= 70 ? '基本合适，但电梯或医疗距离里有一项要盯紧。'
           : scE >= 55 ? '有一项会直接为难老人：优先看低楼层、或离医院更近的房源。'
           : '这套对老人不友好，垂直交通与医疗可达性至少有一项明显不够。'),
          ['最近医院：' + (nearest(medChain(bag)) ? distTxt(nearest(medChain(bag)), R.med) : '5 km 内未检索到'),
           '垂直交通：' + ({ ok: '电梯正常', flaky: '电梯常故障', none: '无电梯', unk: '电梯情况未确认' }[opt.elevator] || '未确认') +
             (h.floor ? '，本房在 ' + h.floor + ' 层' : ''),
           '消防可达性：' + c.sFire + ' 分（' + (nearest(bag.fire) ? '最近站 ' + shortDist(nearest(bag.fire)) : '6 km 内未检索到') + '）',
           '口径：医疗 40% + 垂直交通 30% + 消防疏散 30%']);
      }

      if (id === 'resale') {
        var specPart = c.mode === 'buy' ? c.spec.score : 74;
        var scR = c.sGo * .35 + c.sEnv * .30 + specPart * .20 + c.sBuy * .15;
        add(id, scR,
          (scR >= 85 ? '地铁、环境、产权三样都不拖后腿，转手时议价空间小。'
           : scR >= 70 ? '保值能力正常，短板不在流动性上。'
           : scR >= 55 ? '有一项会压价：买家最容易拿地铁距离和周边嫌恶设施砍价。'
           : '流动性偏弱，将来出手可能要接受更长的挂牌周期或更低的报价。'),
          ['地铁（流动性）：' + (nearest(bag.metro) ? distTxt(nearest(bag.metro), R.metro) : '3 km 内未检索到'),
           '环境风险分：' + round(c.sEnv) + '（嫌恶设施直接压估值）',
           c.mode === 'buy' ? '产权与年限：' + c.spec.score + ' 分'
             : '租房口径不评产权，这一项按中性 74 分计；真要谈保值，切到「买房」口径再跑一次']);
      }
    });
    return out;
  }

  /** 三块分数 -> 按用途与需求加权，再扣用途门槛；返回适配分、权重推演、门槛、在意项评分与其它用途对照 */
  function buildFit(safeScore, goScore, buyScore, opt, concerns, ctx) {
    var f = fitWeights(opt.purpose, opt.needs);
    var base = f.base, w = f.w;
    var raw = clamp(w.safe * safeScore / 100 + w.go * goScore / 100 + w.buy * buyScore / 100, 0, 100);
    var gates = buildGates(f.key, ctx);
    var gateCut = Math.min(GATE_CAP, gates.reduce(function (s, x) { return s + x.cut; }, 0));
    var score = round(clamp(raw - gateCut, 0, 100));
    var blocks = [
      { id: 'safe', name: '安全（五维 + 专项）', score: round(safeScore), weight: w.safe },
      { id: 'go',   name: '通勤（地铁 / 公交）',  score: round(goScore),   weight: w.go },
      { id: 'buy',  name: '采买（超市 / 菜场 / 便利店）', score: round(buyScore), weight: w.buy }
    ];
    var weakest = blocks.slice().sort(function (a, b) { return a.score - b.score; })[0];
    var delta = round(score - safeScore);

    var verdict;
    if (score >= 85) verdict = '按「' + base.name + '」看，这套很匹配，短板也在可接受范围。';
    else if (score >= 70) verdict = '按「' + base.name + '」看基本合适，' + weakest.name + '是最该去现场确认的一块。';
    else if (score >= 55) verdict = '按「' + base.name + '」看有明显不匹配的地方，' + weakest.name + '只有 ' + weakest.score + ' 分。';
    else verdict = '按「' + base.name + '」看不太对得上，' + weakest.name + '拖得很明显，除非价格有优势否则不必花时间。';

    /* 门槛没过是最硬的理由，必须排在结论句前面说清楚 */
    if (gates.length) {
      verdict += ' 硬门槛有一条没过：' + gates[0].t + '（−' + gates[0].cut + ' 分），' +
        '按这个用途看这比其它短板更关键。';
    }

    /* 适配分与安全分差得远的时候必须点出来，否则用户容易把「配套好」误读成「房子安全」 */
    if (!gates.length && delta >= 6) verdict += ' 注意：适配分比安全分高 ' + delta + ' 分，高出的部分来自通勤与采买，安全条件没有变好。';
    else if (!gates.length && delta <= -6) verdict += ' 注意：适配分比安全分低 ' + (-delta) + ' 分，配套拖累了整体，安全条件本身没有那么差。';

    /* 你在意的那几项必须进结论句——否则勾选框看起来像没生效 */
    var worst = null;
    (concerns || []).forEach(function (c) { if (!worst || c.score < worst.score) worst = c; });
    if (worst) {
      if (worst.score < 70) verdict += ' 你在意的「' + worst.name + '」只有 ' + worst.score + ' 分（' + worst.level + '）：' + worst.note;
      else verdict += ' 你在意的几项里最弱的是「' + worst.name + '」，' + worst.score + ' 分（' + worst.level + '）。';
    }

    /* 同一套房换用途会变成多少——这是「用途到底有没有起作用」最直白的证据 */
    var alts = Object.keys(FIT.BASE).map(function (k) {
      return { key: k, name: FIT.BASE[k].name, score: fitScoreOf(k, opt.needs, safeScore, goScore, buyScore, ctx) };
    });
    /* 三块分数的离散程度：分数越接近，换用途对总分的影响就越小。
     * 这不是模型不灵敏，是加权平均的数学性质——报告里要主动说清，
     * 否则用户会以为「换用途没反应」是 bug。 */
    var bmin = Math.min(round(safeScore), round(goScore), round(buyScore));
    var bmax = Math.max(round(safeScore), round(goScore), round(buyScore));
    /* 五个用途里这套房最合适哪一个：用来回答「我换个用途分数会不会不一样」。
     * 差距不到 0.3 分就不必说，否则报告里会出现「低 0.1 分」这种噪声。 */
    var best = alts.slice().sort(function (a, b) { return b.score - a.score; })[0];

    return {
      purpose: f.key, purposeName: base.name, purposeNote: base.note,
      needs: f.used.map(function (n) { return FIT.NEEDS[n].name; }),
      weights: w, score: score,
      grade: gradeOf(score), gradeTxt: GRADE_TXT[gradeOf(score)],
      delta: delta, verdict: verdict, weakest: weakest.name, blocks: blocks,
      trace: f.rows, floored: f.floored, alts: alts, concerns: concerns || [],
      raw: round(raw), gates: gates, gateCut: round(gateCut),
      best: best, gapToBest: round(best.score - score),
      spread: round(bmax - bmin)
    };
  }

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
    var mv = r.mode === 'drive' ? '驾车 ' : '步行 ';
    return mv + fmtDist(r.d) + (r.t ? ' 约 ' + r.t + ' 分钟' : '');
  }
  /**
   * 点位距离文本。默认口径是步行路网距离，直线只作括号里的参考：
   *   「步行 1.2 km 约 15 分钟（直线 0.9 km）」
   * 没算到路网的点位降到 line × 1.3 的估值，会明确写「直线」而不是含糊带过。
   */
  function distTxt(p, r) {
    if (!p) return '未检索到';
    var rt = r || p.route || null;
    // 用逗号而不是嵌套括号：外层调用处已经有一层「（…）」了
    var lineTxt = p.line != null ? '，直线 ' + fmtDist(p.line) : '';
    if (rt && rt.d) return routeTxt(rt) + lineTxt;
    // 老候选（距离口径改版前存的）没有路网，标注「直线」而不是含糊带过
    return fmtDist(p.distance) + (p.est ? '（直线折算，未取到路网）' : '（直线）');
  }
  /** 短距离标签，用在「最近 3 家」这类列表里：步行 180 m / 1.2 km（直线） */
  function shortDist(p) {
    if (!p || p.distance == null) return '—';
    if (p.walk) return (p.via === 'drive' ? '车行 ' : '步行 ') + fmtDist(p.distance);
    return fmtDist(p.distance) + '（直线）';
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round(v) { return Math.round(v * 10) / 10; }

  /* ================= 分数区分度参数 =================
   * 这三个常量是「为什么所有城区地址都是 90 分」的直接原因，统一在这里调，
   * 不要在 13 个 distScore 调用点分散改。
   *
   * MISS_SCALE：搜不到某类资源时的兜底分折算系数。原来各处直接给 40~55 分，
   *   意味着「医院、消防、便利店一个都搜不到」仍能拿到接近及格的分，
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
     * 这里按高德返回的 POI 类型收一次口，只对容易串味的类别生效。
     *
     * 【超市 ≠ 便利店】实测高德的「便利店」类型召回里混着大量名为「XX超市」
     * 「XX烟酒副食超市」的小型超市——高德把这类小超市也归入便利店类目。
     * 用户反馈（2026-10-10）指出报告的「便利店」一行列出来的全是超市，
     * 两者规模与备货逻辑完全不同，必须拆开：便利店只留真正的便利店/便民店，
     * 超市类只留类型串里带「超市」的。注意用过滤后的列表非空才生效，
     * 防止某些城市类型串写法不同导致整类资源被误删归零。 */
    var TYPE_KEEP = {
      shelter: /公园|广场|体育场|绿地/,
      supermarket: /超级市场|超市/,
      convenience: /便利店|便民商店|小卖部|食杂店|烟酒|副食|杂货/
    };
    /* 便利店类里必须剔除的「伪便利店」：名为/类型为超市、商场的点位。
     * 高德把小型超市也归入「便利店」类目，不剔的话报告的便利店一栏全是超市。 */
    var CONV_DROP = /超市|超级市场|商场|购物中心|量贩/;
    var poiBag = {};
    Object.keys(bagRaw).forEach(function (k) {
      var list = bagRaw[k] || [];
      var re = TYPE_KEEP[k];
      if (re) {
        var kept = list.filter(function (p) {
          return re.test(p.type || '') || re.test(p.name || '');
        });
        if (k === 'convenience') {
          var noBig = kept.filter(function (p) { return !CONV_DROP.test(p.type || '') && !CONV_DROP.test(p.name || ''); });
          if (noBig.length) kept = noBig;
        }
        // 过滤后为空说明该地类型串写法不同，退回原列表，避免整类资源被误删归零
        list = kept.length ? kept : list;
      }
      poiBag[k] = list;
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
    /* 殡葬设施口径收口（2026-10-11 用户反馈：日坛公园「马骏烈士之墓」被误标为殡葬设施）。
     * 烈士墓、纪念碑是**纪念设施**，不涉及殡仪服务与日常祭扫车流，不是殡葬设施，
     * 不应计入环境维扣分。判定规则：名字带烈士 / 军人 / 纪念类字样、
     * 且不像真正的墓地（陵园 / 公墓 / 墓园）或殡仪馆的，单独摘到 memorial 留档展示；
     * 「烈士陵园」这类确实是墓地的仍按殡葬设施计。 */
    var MEMORIAL_HINT = /烈士|军人|纪念/;
    var FUNERAL_GROUND = /殡仪馆|陵园|公墓|墓园|骨灰|安息堂|集中安葬/;
    var funeralAll = poiBag.funeral || [];
    poiBag.memorial = funeralAll.filter(function (p) {
      var n = p.name || '';
      return MEMORIAL_HINT.test(n) && !FUNERAL_GROUND.test(n);
    });
    poiBag.funeral = funeralAll.filter(function (p) {
      var n = p.name || '';
      return !(MEMORIAL_HINT.test(n) && !FUNERAL_GROUND.test(n));
    });
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
      '社区卫生服务中心：' + (nearest(poiBag.clinic) ? shortDist(nearest(poiBag.clinic)) : '未检索到'),
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
            return p.name + '（' + shortDist(p) + '）';
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

    /* —— 生活配套（不计入安全总分）——
     * 2026-10-11：这一块从评分维度降级为参考区块。学校（小学/中学）此前已整体下线，
     * 本工具不做学区与就学评估；通勤、采买、加油同理，属配套而非安全。
     * 内部仍然算一个「便利度」便于在报告里排序展示，但它不参与 baseScore。 */
    var sAmen = clamp(
      distScore(poiBag.metro, [[600, 100], [1200, 88], [2000, 74]], 45) * AMENITY_W.metro +
      distScore(poiBag.bus, [[200, 100], [400, 88], [700, 76]], 52) * AMENITY_W.bus +
      distScore(poiBag.supermarket, [[400, 100], [800, 88], [1500, 76]], 48) * AMENITY_W.buy +
      // 加油站：对有车的人是便利，对无车的人基本无感，所以只占配套的一成
      distScore(poiBag.gas, [[800, 100], [1500, 92], [3000, 82]], 62) * AMENITY_W.gas, 0, 100);
    if (opt.elevator === 'none' && h.floor >= 4) sAmen -= 6;           // 日常上下楼成本
    sAmen = clamp(sAmen, 0, 100);
    var amenEv = [
      '地铁：' + (nearest(poiBag.metro) ? nearest(poiBag.metro).name + '（' + distTxt(nearest(poiBag.metro), R.metro) + '）' : '3 km 内未检索到'),
      '公交：' + (nearest(poiBag.bus) ? nearest(poiBag.bus).name + '（' + shortDist(nearest(poiBag.bus)) + '）' : '1 km 内未检索到'),
      // 采买同时关系日常运转与断电补给，列最近 3 家方便拿去看房时实地核对
      '超市/菜场：' + ((poiBag.supermarket || []).length || (poiBag.market || []).length
        ? (poiBag.supermarket || []).concat(poiBag.market || [])
            .sort(function (a, b) { return a.distance - b.distance; })
            .slice(0, 3).map(function (p) { return p.name + '（' + shortDist(p) + '）'; }).join(' · ')
        : '未检索到'),
      '便利店：' + (nearest(poiBag.convenience) ? nearest(poiBag.convenience).name + '（' + shortDist(nearest(poiBag.convenience)) + '）' : '1.5 km 内未检索到'),
      '加油站/加气站：' + (nearest(poiBag.gas) ? nearest(poiBag.gas).name + '（' + shortDist(nearest(poiBag.gas)) + '）' : '1.5 km 内未检索到')
    ];

    /* —— 通勤分与采买分（供综合适配层使用）——
     * 这两块原来合在「生活配套便利度」里，权重是地铁 .38 / 公交 .22 / 采买 .30 / 加油 .10。
     * 拆开是因为适配层要按用途单独调权：通勤族和养老家庭对这两块的看重程度差得远，
     * 合成一个数之后就没法分别加权了。加油并入采买（有车的人才会用到）。
     * 阈值沿用原来的分级，不新增调参点。 */
    var sGo = clamp(
      distScore(poiBag.metro, [[600, 100], [1200, 88], [2000, 74]], 45) * .60 +
      distScore(poiBag.bus, [[200, 100], [400, 88], [700, 76]], 52) * .40, 0, 100);
    var sBuy = clamp(
      distScore(poiBag.supermarket, [[400, 100], [800, 88], [1500, 76]], 48) * .50 +
      distScore(poiBag.market, [[500, 100], [1000, 88], [1800, 75]], 48) * .30 +
      distScore(poiBag.convenience, [[200, 100], [500, 88], [1000, 76]], 48) * .20, 0, 100);
    // 无电梯且住 4 层以上，日常采买搬上楼的成本要算进去
    if (opt.elevator === 'none' && h.floor >= 4) sBuy -= 6;
    sGo = clamp(sGo, 0, 100); sBuy = clamp(sBuy, 0, 100);

    /* —— 环境风险（扣分制）——
     * ENV_MODE_MUL：同样的嫌恶设施，买房口径扣得更狠。
     * 注意只对「扣分」生效，不会因为环境干净而给买房额外加分。
     *
     * 【2026-10-11 口径重估：加油站与变电站从 12 / 14 分降到 5 分】
     * 原先把它们当成「会爆炸的邻居」，查证之后站不住：
     *   加油站：近 20 年国内确有三起波及住宅的事故——2007 上海浦三路加注站检修时
     *     残气爆炸（4 死 40 伤，"石雨"散落 500 m，居民屋顶被砸穿）、2012 湖南永顺
     *     加油站泄漏约 1000 升汽油顺下水道进城区（2 死 10 伤、200 多户房屋损坏、
     *     损失 898 万）、2018 河南濮阳加油站闪爆（周边住宅受损）。
     *     但三起全部源于施工检修违规操作或泄漏，正常运营的加油站几乎不炸。
     *     它更常见的影响是车辆进出噪声、油气异味与夜间照明，属长期低烈度干扰。
     *   变电站：2016 西安南郊 330 kV 主变起火爆炸（8.6 万户停电约 40 分钟，近处门面
     *     玻璃震碎、路边车被砸被引燃，无伤亡）、2023 深圳龙华城中村变压器故障爆炸
     *     （200 余户停电，无伤亡）。没有一起造成住宅结构损伤或居民伤亡——
     *     后果主要是**短时停电**，而停电已经在「断电韧性」那一维里单独评估了；
     *     长期影响居住的是变压器低频嗡鸣噪声。
     * 所以保留在环境维里，但按「低概率事故 + 长期噪声异味」计，扣分量级与垃圾站拉开。
     */
    var envMul = ENV_MODE_MUL[mode] || 1;
    var sEnv = 100, envHits = [];
    /* riskAt：只有贴到这个距离以内才单独出一条风险提示。
     * 加油站与变电站的阈值压得很低（80 / 50 m），因为它们的风险不是「在附近」，
     * 而是「正对着」——隔着一条马路和贴着围墙是两回事。 */
    function penalty(list, label, near, mid, maxCut, riskAt, why) {
      if (!list || !list.length) return;
      var d = list[0].distance;
      var cut = d <= near ? maxCut : d <= mid ? maxCut * .55 : maxCut * .2;
      cut *= envMul;
      sEnv -= cut;
      envHits.push({
        label: label, name: list[0].name, distance: d,
        cut: Math.round(cut), riskAt: riskAt, why: why
      });
    }
    penalty(poiBag.gas, '加油站/加气站', 200, 500, 5, 80,
      '正常运营的加油站几乎不会爆炸，风险主要来自检修施工违规操作与油品泄漏（近 20 年国内有 3 起波及住宅的案例，最严重的一起造成 200 多户房屋损坏）。日常更常见的是车辆进出噪声、油气异味与夜间照明。');
    penalty(poiBag.substation, '变电站', 150, 400, 5, 50,
      '国内变电站起火 / 闪爆案例的常见后果是短时停电与近处玻璃震碎，未见住宅结构损伤或居民伤亡；长期影响居住的是变压器低频嗡鸣噪声，建议夜间实地听一次。');
    penalty(poiBag.refuse, '垃圾站/污水处理', 150, 400, 16, 150,
      '异味、蚊蝇与清运车早间噪声是长期且确定的影响，夏季与低楼层尤其明显；距离越近越难靠关窗解决。');
    penalty(poiBag.funeral, '殡葬设施', 400, 1000, 10, 400,
      '它不构成任何安全威胁——计入环境维不是「有危险」，而是它确实影响长期居住的心理感受与二手房估值（属于「你知道了可能会介意」的信息），介不介意取决于你自己，看房时建议白天与傍晚各去一次。口径只含殡仪馆（含火化间 / 火葬场）、陵园、公墓等殡仪与安葬设施；烈士墓、纪念碑等属于纪念设施，不在此口径内、不计分。');
    if (opt.flood) sEnv -= 10 * envMul;         // 曾发生内涝/积水
    if (opt.basement) sEnv -= 4 * envMul;       // 地下空间额外叠加
    if (opt.topfloor && opt.age != null && Number(opt.age) >= 20) sEnv -= 3 * envMul;  // 老房顶层渗漏
    sEnv = clamp(sEnv, 0, 100);
    ev.env = (envHits.length
      ? envHits.map(function (x) { return x.label + '：' + x.name + '（' + shortDist(x) + '，−' + x.cut + ' 分）'; })
      : ['1.5 km 内未检索到垃圾站、加油站、变电站等环境影响因素；3 km 内未检索到殡葬设施'])
      .concat(opt.flood ? ['场地历史：该处曾发生内涝或积水（按你填写的信息计入，−' + Math.round(10 * envMul) + ' 分）'] : []);

    S = { em: sEm, fire: sFire, power: sPower, safe: sSafe, env: sEnv };

    /* —— 模式专项（租房=租约稳定 / 买房=资产稳健）—— */
    var spec = buildSpec(mode, opt, poiBag);
    var specName = SPEC[mode].name;

    /* —— 总分 ——
     * 五维占 (1-SPEC_W)，模式专项占 SPEC_W。放在加权和里而不是最后加减，
     * 是为了让专项的影响可以被量化地说出来：「这一块占总分的 20%」。
     * 注意 sAmen（生活配套便利度）不在 S 里，因此完全不影响总分。 */
    var baseScore = 0;
    for (var k in W) baseScore += S[k] * W[k];
    var total = round(clamp(baseScore * (1 - SPEC_W) + spec.score * SPEC_W, 0, 100));

    /* 第二层：按用途加权的综合适配（安全分不变，另算一个适配分）
     * 先把「最在意」逐条算成分数，再交给 buildFit 一起组装：
     * 这样报告里既有权重推演，也有「我怕吵，这套房到底吵不吵」的直接回答。 */
    var concerns = buildConcerns({
      opt: opt, poiBag: poiBag, R: R, h: h, mode: mode,
      sEm: sEm, sFire: sFire, sEnv: sEnv, sGo: sGo, sBuy: sBuy,
      envHits: envHits, spec: spec
    });
    /* 用途门槛要用的几个距离与环境 / 采买分：门槛看的是「这个用途能不能用」，不是权重 */
    var nM = nearest(poiBag.metro), nB = nearest(poiBag.bus), nC = nearest(poiBag.convenience);
    var fitCtx = {
      med: nm ? nm.distance : null,
      fire: nf ? nf.distance : null,
      metro: nM ? nM.distance : null,
      bus: nB ? nB.distance : null,
      cv: nC ? nC.distance : null,
      env: sEnv, buyScore: sBuy
    };
    var fit = buildFit(total, sGo, sBuy, opt, concerns, fitCtx);

    var grade = gradeOf(total);

    /* —— 排序找出亮点与短板 ——
     * 显示的权重是「在总分里的实际占比」，所以要乘上 (1-SPEC_W)；
     * 剩下的 SPEC_W 归模式专项，五维加起来不再是 100%。 */
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
    /* 最在意的项不合格，比任何五维短板都更该出现在结论标签里 */
    if (concerns.length) {
      var wc0 = concerns.slice().sort(function (a, b) { return a.score - b.score; })[0];
      if (wc0.score < 70) gaps.push('你在意的「' + wc0.name + '」' + wc0.score + ' 分');
    }

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
    if (opt.elderly && nm && nm.distance > 2000) risk('warn', '老人就医距离偏长', '最近医院 ' + shortDist(nm) + '，老人突发状况时每一分钟都很关键。建议确认社区医生上门服务与 120 响应时间。');
    if (!nf || nf.distance > 4000) risk('dan', '消防站覆盖弱', '最近消防救援站超过 4 km，高层住宅火灾主要依赖内部消防设施与自救，务必现场确认消火栓、烟感与疏散通道。');
    // 高层和超高层都要判（原来只写了 high，34 层以上的 super 反而漏掉了）
    if ((lv === 'high' || lv === 'super') && (!nf || nf.distance > 2500))
      risk('dan', '高层 + 消防距离', H + ' 层超出多数举高消防车作业高度，疏散只能靠楼梯间，请确认楼梯间是否为防烟楼梯间、有无堆放杂物。');
    if (!(poiBag.convenience || []).length) risk('warn', '断电后补给困难', '1.5 km 内没有便利店，长时间停电时缺少就近补给点，建议常备 3 天量的水与即食食品。');
    if (opt.basement) risk('dan', '地下空间内涝与排烟', '地下/半地下在暴雨内涝与火灾排烟上风险显著高于地面，需确认排水泵、挡水板与机械排烟。');
    if (opt.age != null && Number(opt.age) >= 30) risk('warn', '房龄偏老', '建成约 ' + opt.age + ' 年，重点关注供电容量、给排水管锈蚀、燃气软管与外墙保温层。');
    if (opt.share) risk('warn', '合租安全边界', '合租需确认门锁是否可反锁、插座与大功率电器使用规则、陌生人进出管理。');
    /* 环境类风险提示：不再用统一的 150 m 阈值，改用每类自己的 riskAt。
     * 加油站 80 m、变电站 50 m —— 只有「正对着」才提示，隔着一条马路不提示；
     * 垃圾站 150 m、殡葬 400 m —— 这两类的影响半径本来就更远。 */
    envHits.forEach(function (x) {
      if (x.riskAt && x.distance <= x.riskAt) {
        risk('warn', '环境因素过近：' + x.label,
          '「' + x.name + '」距目标约 ' + shortDist(x) + '。' + x.why +
          (mode === 'buy' ? '买房口径下这一类按 ' + ENV_MODE_MUL.buy + ' 倍计扣分——它会长期挂在估值上。' : ''));
      }
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

    /* 你在意的那几项：不满足就进风险提示。
     * 这是整份报告里最该被看见的一节——用户勾「怕吵」，结果比任何维度分都直接。 */
    concerns.forEach(function (c) {
      var why = c.note + ' ' + (c.evidence[0] || '');
      if (c.score < 55) risk('dan', '你在意的「' + c.name + '」不满足', why);
      else if (c.score < 70) risk('warn', '你在意的「' + c.name + '」勉强达标', why);
    });

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
    if (opt.elevator === 'none' && h.floor >= 7) note('无电梯且住在 ' + h.floor + ' 层：断电韧性 −9、生活配套便利度 −6（配套不计入安全分）');
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
    note('生活配套（地铁 / 公交 / 采买 / 加油）不计入综合安全分：通勤与采买决定住着累不累，属配套设施而非安全条件。');
    note('综合适配分是第二层：安全 ' + fit.weights.safe + '%、通勤 ' + fit.weights.go + '%、采买 ' + fit.weights.buy +
      '%（用途「' + fit.purposeName + '」' +
      (fit.needs.length ? '，另按你在意的「' + fit.needs.join('、') + '」调整' : '，没有勾选在意项') +
      '）。安全分不随用途变化，改动用途只会改适配分。');
    if (fit.floored) note('三块权重设了 8% 的保底：你勾的在意项太多时，某一层会被压到下限而不是归零，避免报告里整块消失。');
    if (fit.gates && fit.gates.length) {
      note('用途门槛（「' + fit.purposeName + '」这一档）：' +
        fit.gates.map(function (g) { return g.t + ' −' + g.cut + ' 分'; }).join('；') +
        '。门槛合计最多扣 12 分——它是「这个用途能不能用」的硬条件，和权重不是一回事。');
    }
    if (concerns.length) note('你在意的每一项都单独打了分（' +
      concerns.map(function (c) { return c.name + ' ' + c.score; }).join('、') +
      '），这些分数只用于回答「你在意的这件事这套房做得怎么样」，不反向参与安全分与适配分。');
    if (opt.street) note('临主干道 / 高架 / 铁路：只计入「怕吵」这一项的噪声扣分（−18），不进安全分——它影响的是住着舒不舒服，不是出事时的兜底能力。');
    if (opt.parking) note('停车条件：只计入「有车」这一项（' +
      ({ fixed: '固定车位', street: '路边随停', none: '无车位', unk: '未确认' }[opt.parking] || '未确认') +
      '），不进安全分。');
    note('环境风险按影响确定性分档扣分：垃圾站 16 分（异味、蚊蝇、清运车噪声，长期且确定）；内涝 10 分；加油站与变电站各 5 分（按低概率事故 + 长期噪声计，不按「会爆炸」计——近 20 年国内加油站事故全部源于施工检修违规或泄漏，变电站事故后果主要是短时停电，未见住宅结构损伤或居民伤亡）。');
    note('距离口径：本报告所有距离都是高德步行路网距离（按实际能走的路线算，不是两点连线），消防站按消防车驾车路线算。每类对最近的几个点位逐条规划，算完按路网距离重新排序——所以「直线很近、却要绕一大圈」的点位不会排在前面。括号里的「直线」只作参考。');

    /* —— 清单 —— */
    var p72 = buildPower72(poiBag, opt, R, h);
    var visit = buildVisit(mode, opt, poiBag, R, h);

    function withRoute(p, r) {
      if (!p) return null;
      var o = {};
      for (var k in p) o[k] = p[k];
      // 点位自己已经算过路网（p.route）时不能被空的路由表覆盖掉
      o.route = r || p.route || null;
      return o;
    }

    return {
      mode: mode, score: total, grade: grade, gradeTxt: GRADE_TXT[grade],
      dims: arr, highlights: highlights, gaps: gaps, risks: risks,
      envHits: envHits, power72: p72, visit: visit, weight: W, env: opt, notes: notes,
      /* 第二层：按用途加权的综合适配（安全分不受用途影响） */
      fit: fit,
      spec: {
        name: specName, intro: SPEC[mode].intro,
        score: round(spec.score), items: spec.items,
        weight: Math.round(SPEC_W * 100)
      },
      baseScore: round(baseScore),
      /* 生活配套：参考区块，不参与加权，因此没有 weight 字段 */
      amenity: {
        name: AMENITY.name, intro: AMENITY.intro,
        score: round(sAmen), evidences: amenEv
      },
      facts: {
        med: withRoute(nm, R.med),
        fire: withRoute(nf, R.fire),
        shelter: withRoute(nearest(poiBag.shelter), R.shelter),
        market: withRoute(nearest(poiBag.market), R.market),
        supermarket: withRoute(nearest(poiBag.supermarket), R.supermarket),
        convenience: withRoute(nearest(poiBag.convenience), R.convenience),
        metro: withRoute(nearest(poiBag.metro), R.metro),
        police: withRoute(nearest(poiBag.police), R.police),
        pharmacy: withRoute(nearest(poiBag.pharmacy), R.pharmacy),
        gas: withRoute(nearest(poiBag.gas), R.gas)
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
    var rt = (near && near.route) || (R && R[rid]);
    L.push({
      t: '补给点：' + (near ? near.name + '（' + (rt ? routeTxt(rt)
          : fmtDist(near.distance) + '，未取到路网，按步行折算') + '）'
          : '附近未检索到稳定补给点'),
      s: rt ? '以上为高德实际步行路径长度，不是直线距离' : '未取到路网，此处的分钟数为直线距离按绕行系数折算的估值'
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
      L.push({ t: '查周边规划：周边 3 km 有无新建嫌恶 / 市政设施规划', s: '规划局官网可查控制性详细规划' });
      L.push({ t: '查楼栋与楼层：是否为设备层/腰线层/顶层，电梯品牌与检修记录', s: '设备层噪音、顶层漏水是高频投诉点' });
    }
    return L;
  }

  RS.model = {
    QUERIES: QUERIES, DIMS: DIMS, WEIGHT: WEIGHT, RADIUS_TXT: RADIUS_TXT,
    FIT: FIT, evaluate: evaluate, fmtDist: fmtDist, haversine: haversine,
    routeTxt: routeTxt, distTxt: distTxt, resolveHeight: resolveHeight,
    MED_NOISE: MED_NOISE, pickMed: pickMed, medChain: medChain,
    scoreColor: scoreColor, clamp: clamp
  };
})();

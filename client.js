/* dsh-newswire — 浏览器半边（零构建：单文件、无 import、无 JSX、无 iframe）。
 * 由 window.__ModuleLoader__ 自注册，模块 id == 包名。React 从宿主模块表取。
 * 颜色只用宿主主题变量 var(--dsw-alias-*)（明暗主题自动跟随）；布局按面板自身宽度（容器查询）在双栏 / 单栏之间切换。
 * 五个页签：要闻（事件卡片 + 详情）、时间线（按日期、按轮回看）、条目、数据源（增删改、试抓、软删除）、运行（定时任务、衔接、抓取日志、汇总）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-newswire',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var Component = React.Component

    var PANEL_ID = 'newswire'
    var NS = 'dsh-newswire'
    var TZ = 'Asia/Shanghai'
    var API = {
      summary: '/api/newswire/summary',
      digest: '/api/newswire/digest',
      sources: '/api/newswire/sources',
      items: '/api/newswire/items',
      attempts: '/api/newswire/attempts',
      run: '/api/newswire/run',
      test: '/api/newswire/sources/test',
      taxonomy: '/api/newswire/taxonomy',
      events: '/api/newswire/events',
      event: '/api/newswire/event',
      timeline: '/api/newswire/timeline',
      timelineRun: '/api/newswire/timeline/run',
      schedule: '/api/newswire/schedule',
      edition: '/api/newswire/edition',
      model: '/api/newswire/model',
      follows: '/api/newswire/follows',
      story: '/api/newswire/story',
      daily: '/api/newswire/daily',
      editions: '/api/newswire/editions',
      feedback: '/api/newswire/feedback',
      quality: '/api/newswire/quality',
      track: '/api/newswire/track',
      trackItem: '/api/newswire/track/item',
      storyAnalyze: '/api/newswire/analyze',
      onboard: '/api/newswire/onboard',
      ask: '/api/newswire/ask',
      push: '/api/newswire/push',
      scores: '/api/newswire/sources/scores',
      state: '/api/newswire/sources/state',
      analyze: '/api/newswire/event/analyze',
      updateCheck: '/api/newswire/update-check',
    }
    var PACKAGE = 'dsh-newswire'
    // 宿主远程服务（插件管理器），在 apply 里注入；没有时版本区块只显示、不能一键更新
    var remotes = {}
    var TYPES = ['rss', 'html_index', 'cls_api', 'json_api']
    var CHANNELS = ['browse', 'agent_reach', 'http', 'jina']
    var TIERS = ['primary', 'secondary']
    var HOURS = [6, 12, 24, 48, 72]
    var FACTORS = [['sources', 50], ['weight', 10], ['cross_region', 10], ['authority', 5], ['native', 25], ['speed', 5], ['persistence', 5], ['watch', 5]]

    var DICT = {
      zh: {
        'tk.upToDate': '综述已是最新',
        'tab.track': '追踪', 'tk.title': '追踪', 'tk.dekAll': '持续追踪一家公司、一项技术、一个人或一条主线：相关报道自动挂上，模型把几周来的动态串起来，判断趋势与影响。', 'tk.sug': '值得追踪', 'tk.sugTheme': '版面里串起 {n} 篇报道的主线', 'tk.sugEntity': '近 7 天出现在 {n} 条故事线里（近 3 天 {r} 条）',
        'tk.theme': '主线', 'tk.mentions': '{n} 条', 'tk.addPh': '公司、技术、人物或话题，如：英伟达、固态电池、伊朗战事', 'tk.tickerPh': '股票代码', 'tk.add': '开始追踪', 'tk.none': '还没有追踪的对象：从上面的建议里挑一个，或自己添加。追踪的对象会自动进「我的关注」，有新进展会推送。',
        'tk.kind.company': '公司', 'tk.kind.technology': '技术', 'tk.kind.person': '人物', 'tk.kind.theme': '主线', 'tk.freshN': '{n} 条新进展', 'tk.pending': '综述将在下一份版面后生成', 'tk.storiesN': '{n} 条故事线，近 7 天 {w} 条', 'tk.latest': '最新：{t}',
        'tk.sparkTip': '近 30 天每天的相关报道数', 'tk.back': '‹ 返回追踪', 'tk.stop': '停止追踪', 'tk.delete': '删除追踪', 'tk.confirm': '连同挂上的动态、综述和它加的关注一起删掉？', 'tk.unlink': '不属于这里', 'tk.aliases': '也认：{a}', 'tk.dek': '{n} 条相关故事线 · {t} 起追踪', 'tk.synth': '追踪综述', 'tk.synthMeta': '{t} · 由 {m} 依据 {n} 条故事线写成', 'tk.incremental': '增量更新',
        'tk.trend': '趋势', 'tk.changed': '和上次相比', 'tk.milestones': '关键节点', 'tk.implications': '对股价、行业与技术趋势的影响', 'tk.noSynth': '还没有综述：点下面的按钮生成（约 1–2 分钟）。', 'tk.noSynthEconomy': '综述需要 LLM 模式；下面是挂上的动态。',
        'tk.synthBusy': '模型正在写综述（约 1–2 分钟）…', 'tk.resynth': '更新综述（{n} 条新进展）', 'tk.synthNow': '生成综述', 'tk.timeline': '动态 · {n}', 'tk.empty': '暂时没有相关报道，之后的版面里出现会自动挂上。', 'tk.new': '综述后新增', 'sd.entities': '关键主体', 'tk.trackIt': '追踪', 'ask.track': '追踪这个话题',
        'rt.depth': '模型投入', 'rt.lean': '节省', 'rt.balanced': '均衡', 'rt.deep': '深度', 'rt.depthDesc': '每份版面读 {r} 条、写 {w} 篇、自动分析 {a} 篇影响、译 {t} 条外文标题', 'rt.budget': '每天 token 上限', 'rt.budgetHint': '0 为不限；用完后模型步骤改由程序完成，第二天恢复',
        'rt.today': '今天', 'rt.todayLine': '调用 {c} 次 · 输入 {i} · 输出 {o} · 缓存命中 {k}', 'rt.cacheRate': '输入缓存命中 {p}%', 'rt.est': '（宿主没报用量，按字数估算）', 'rt.ofBudget': '已用上限的 {p}%',
        'rt.speed': '实测：输出约 {t} token/秒，单次中位 {s} 秒', 'rt.conc': '并发 {n}', 'rt.concProbe': '并发待测（下一份版面自动测）', 'rt.probe': '（实测并行效率 {e}）',
        'rt.step.group': '归并', 'rt.step.plan': '统筹', 'rt.step.write': '写稿', 'rt.step.translate': '翻译', 'rt.step.analyze': '影响分析', 'rt.step.ask': '问答', 'rt.step.split': '拆合集', 'rt.step.daily': '日报', 'rt.step.notes': '事件解读', 'rt.step.brief': '简报', 'rt.step.track': '追踪综述', 'rt.step.other': '其它',
        'rd.outletsN': '等 {n} 家', 'ev.indep': '{n} 家独立报道', 'ev.single': '只有一家报道', 'ev.reports': '各家报道 · {n}', 'ev.first': '首报', 'ev.repost': '转载', 'ev.views': '阅读 {n}', 'ev.why': '为什么排在这里（重要度 {n}）',
        'ev.searchPh': '搜标题关键词', 'ev.h6': '6 小时', 'ev.h24': '24 小时', 'ev.h72': '3 天', 'ev.multi': '只看多家报道的', 'ev.moreFilters': '更多筛选', 'ev.hot': '热词：',
        'tl.hint': '每根柱子是一轮抓取，高度是这轮新增的条数；点一根看这一轮抓到了什么。', 'tl.night': '隔夜', 'tl.pushed': '已推送', 'tl.failed': '{n} 源失败', 'tl.gap': '有缺口', 'tl.gaps': '{n} 处缺口', 'tl.barTip': '{t} 这一轮：新增 {n} 条，其中 {m} 件多家报道',
        'tl.round': '{t} 这一轮', 'tl.srcs': '源 {a}/{b}', 'tl.newItems': '新增 {n} 条', 'tl.newEvents': '新事件 {n} 件', 'tl.pushes': '推送 {n} 条',
        'it.kind.promo': '广告/引流', 'it.kind.ticker': '行情', 'it.kind.digest': '合集原稿', 'it.showFiltered': '显示已过滤的',
        'ia.title': '影响与走势', 'ia.horizon': '影响期：{h}', 'ia.spec': '模型推演，非事实，不构成投资建议', 'ia.conf': '把握{c}', 'ia.more': '看完整推演 ›', 'ia.follow': '关注这件事的进展', 'ia.following': '已关注，有进展会推给你',
        'ia.busy': '模型正在分析影响与可能的走向（约 1–2 分钟）…', 'ia.run': '分析影响与走势', 'ia.rerun': '重新分析', 'ia.noModel': '需要 LLM 模式且模型可用', 'ia.impacts': '可能受影响的', 'ia.scenarios': '可能的走向', 'ia.signals': '信号：', 'ia.watch': '接下来留意',
        'ia.disclaimer': '由 {m} 依据这条故事线的报道推演（{t}），不是事实，不构成投资建议。', 'ia.dropped': '有 {n} 条推演与原文核对不上，已删去。', 'ia.newer': '分析之后又有 {n} 篇新报道，可以重新分析。',
        'fl.topHint': '{n} 篇 · 你关注的人、公司与话题',
        'rd.reposts': '另有 {n} 家转载', 'rd.repostsHint': '转载（几乎一字不差、不算独立印证）：{w}', 'sb.reposts': '转载别家 {n}',
        'wl.title': '欢迎使用见微知著：先花 30 秒，告诉它你想看什么', 'wl.dek': '它会从几十个中外媒体抓新闻，归并成「一件事一条」，由模型读完写成版面，并按你的节奏推到手机。', 'wl.topics': '你关心的版块', 'wl.topicsHint': '取消勾选的版块不会出现在版面和推送里，之后可以在「关注与推送」里恢复。', 'wl.study': '留学资讯（单独一组源）',
        'wl.follow': '想重点关注的人、公司或话题（可不填）', 'wl.followPh': '用逗号分隔，如：英伟达、伊朗、美联储', 'wl.push': '推送到手机的节奏', 'wl.c2h': '每 2 小时', 'wl.c3': '早中晚三次', 'wl.cDaily': '只看晚间日报', 'wl.pushHint': '需要在对话里让 Agent 安排一次定时推送（说「每 2 小时推送要闻」即可），之后按这里的节奏推。',
        'wl.start': '开始：抓第一轮', 'wl.busy': '已经有一轮在抓了，稍等片刻再试', 'wl.fetchingH': '正在准备第一份版面', 'wl.fetching': '正在抓取各个源，第一次约 3–5 分钟（已用 {s}）…', 'wl.s1': '抓取各源的最新新闻，去重、识别广告与合集', 'wl.s2': '抓完先出一份程序排的版面，马上能看', 'wl.s3': '模型随后逐篇读、归并、写稿，写好一篇替换一篇',
        'ask.ph': '搜索或提问，如：伊朗局势最近怎么样', 'ask.for': '「{q}」', 'ask.found': '近 {h} 小时找到 {n} 篇相关报道', 'ask.close': '× 回到版面', 'ask.answer': '回答', 'ask.reading': '模型正在读 {n} 篇相关报道作答（约 1 分钟）…', 'ask.notEnough': '找到的报道不足以回答这个问题。',
        'ask.by': '由 {m} 依据下列报道作答，每句标了出处', 'ask.dropped': '{n} 句与原文核对不上，已删去', 'ask.partial': '材料不全，回答可能不完整', 'ask.stories': '相关故事线', 'ask.reports': '{n} 篇', 'ask.items': '相关报道', 'ask.none': '没找到和「{t}」相关的报道。',
        'ps.title': '推送', 'ps.hint': '推到手机的每一条都会打扰你：先定好什么时候推、推多少。节奏会直接改定时任务的时间；每一轮里过了门槛的才推。', 'ps.cadence': '节奏', 'ps.level': '门槛', 'ps.fewer': '少而精', 'ps.normal': '适中', 'ps.more': '多一些', 'ps.limits': '上限', 'ps.perRound': '每轮最多', 'ps.daily': '每天最多',
        'ps.save': '保存', 'ps.saved': '已保存。', 'ps.noSvc': '当前宿主没有定时任务服务，只能保存偏好。', 'ps.noTask': '还没有安排定时推送：在对话里说「每 2 小时推送要闻」即可。', 'ps.task': '定时任务：{s}，下一次 {n}', 'ps.learned': '根据你对推送的反馈，这些版块的门槛已自动提高：{s}',
        'ps.log': '推送记录', 'ps.up': '有用', 'ps.down': '没用', 'ps.none': '还没有推送过。',
        'ed.partial': '模型已归并好版面，正在逐篇写稿（已写 {w}/{n} 篇，头版先写）；没写到的暂用程序稿，写完自动替换',
        'rd.ticks': '行情速览',
        'sb.title': '源的取舍', 'sb.hint': '近 {d} 天每个源带来了什么。开：正常上版与推送；试用：照常抓取、为别家报道提供印证，但不能单独让一件事上版或推送；关：不抓取。', 'sb.sum': '开 {on} · 试用 {trial} · 关 {off}', 'sb.applyAll': '按建议调整（{n} 个）', 'sb.applied': '已按建议调整 {n} 个源，下一轮抓取生效',
        'sb.on': '开', 'sb.trial': '试用', 'sb.off': '关', 'sb.suggest': '建议：{s}', 'sb.advanced': '高级：编辑源配置（地址、类型、通道、权重……）', 'sb.foot': '统计每天随新数据更新；关掉的源没有新数据，评估停在关掉前。不确定的源先「试用」：它只能为别家印证，不会让版面变乱，几天后再看数据决定。',
        'sb.perDay': '日均 {n} 条', 'sb.board': '上版 {n}', 'sb.first': '首报 {n}', 'sb.excl': '独家 {n}', 'sb.corrob': '印证 {n}', 'sb.low': '低价值 {p}%', 'sb.full': '内容完整 {p}%', 'sb.promo': '广告 {n}', 'sb.fetch': '抓取成功 {p}%',
        'sb.v.core': '核心', 'sb.v.support': '印证', 'sb.v.ok': '一般', 'sb.v.low': '低价值', 'sb.v.unstable': '抓取不稳', 'sb.v.insufficient': '数据不足',
        'sb.why.core': '常上版面，或常常最先报道、独家报道，值得保留。', 'sb.why.support': '多为别家的报道提供印证，让可信度判断更准。', 'sb.why.ok': '贡献一般：不常上版，也不常与别家重合。', 'sb.why.low': '绝大多数是低价值内容，几乎不与别家报道重合，开着主要是增加噪声。', 'sb.why.unstable': '近期一半以上的轮次抓取失败，先在下面「高级」里试抓排查。', 'sb.why.insufficient': '数据太少，还看不出价值：可以先试用。',
        'ct.adv.degraded': '页面可能改版了：去「数据源」试抓这个源，看解析结果', 'ct.adv.blocked': '正文被拦截或是动态页面，抓不到：只能提供标题，可考虑停用或换成有全文的源', 'ct.adv.slow': '正文抓得到但慢：只给上版和重点事件补正文', 'ct.adv.fetch': '正文抓得到：新条目每轮逐条补', 'ct.adv.probe': '正在试抓正文，几轮后定下策略', 'ct.adv.none': '付费墙或配置为不抓正文',
        'ct.advice': '建议', 'ct.mode.list': '列表自带', 'ct.mode.fetch': '逐条补', 'ct.mode.slow': '只补重点', 'ct.mode.blocked': '抓不到', 'ct.mode.probe': '试抓中', 'ct.mode.none': '不抓',
        'sd.fromDigest': '摘自《{t}》',
        'ct.title': '内容完整度', 'ct.sum': '近 24 小时 {n} 条 · 完整 {f} · 过滤广告与引流 {p} 条 · 合集 {d} 篇拆出 {i} 条', 'ct.hint': '抓到了但不全比抓不到更难发现：这里按源列出只有标题、摘要被截断的情况。要上版的报道会先去原文补全文；某个源突然只剩标题，多半是页面改版了。',
        'ct.src': '来源', 'ct.state': '状态', 'ct.n': '条数', 'ct.full': '完整', 'ct.trunc': '截断', 'ct.titleOnly': '只有标题', 'ct.bodies': '正文补抓', 'ct.before': '此前 {p}%', 'ct.allOk': '各源内容完整。',
        'ct.st.degraded': '突然变少', 'ct.st.titles_only': '只有标题', 'ct.st.partial': '部分不全', 'ct.st.ok': '正常', 'ct.filtered': '已过滤 {n} 条（近 3 天）', 'ct.digest': '合集已拆条', 'ct.promo': '广告', 'ct.restore': '这是新闻，恢复', 'ct.restored': '已恢复',
        'st.thin': '{s} 内容变少', 'fb.promo': '这是广告或推广', 'fb.promoHint': '整条撤下；之后模型编排时会参照它识别同类内容', 'fb.promoDone': '已撤下，可在「运行 → 内容完整度」里恢复',
        'sd.dek': '{n} 篇报道 · {o} 家媒体 · 始于 {t}', 'sd.why.new': '首次推送', 'sd.why.jumped': '重要度上升', 'sd.why.followup': '关注的故事线有进展', 'sd.why.corroborated': '获多家印证',
        'tab.today': '今日', 'tab.daily': '回顾', 'tab.follows': '关注与推送', 'tab.events': '事件', 'btn.runHint': '立即抓取各数据源并重新编排',
        'st.updated': '{t} 更新', 'st.failed': '{n} 个源失败', 'st.gaps': '{n} 处缺口', 'st.stale': '超过一天未更新',
        'rd.outlets': '{w}等 {n} 家', 'rd.developing': '进展', 'rd.more': '更多：各方说法、影响与来源', 'rd.less': '收起', 'rd.reportHint': '点出有误的那一句，它会立即撤下，下次重写时避开。',
        'rd.asof': '截至 {t}', 'rd.pack': '内容范围', 'rd.allPacks': '全部内容', 'rd.dek': '过去 {h} 小时 · {n} 件事 · 来自 {o} 家媒体',
        'rd.sinceH': '自你上次查看（{t}）', 'rd.sinceNew': '{n} 件新事', 'rd.sinceDev': '{n} 件有进展',
        'rd.about': '关于本期', 'rd.byModel': '由 {m} 阅读并编写', 'rd.byRules': '由程序按规则编排（节省 token 模式）', 'rd.read': '读入近 {h} 小时最重要的 {n} 条报道。', 'rd.checked': '模型写下的 {n} 句含数字或专名的话，{p} 句已与原文逐一核对。',
        'rd.past': '往期版面', 'rd.skim': '本期速览', 'rd.aboutDay': '关于这份回顾', 'rd.dayDek': '今天值得记住的 {n} 件事',
        'nav.panel': '见微知著', 'tab.news': '要闻', 'tab.timeline': '时间线', 'tab.items': '条目', 'tab.sources': '数据源', 'tab.runs': '运行',
        'btn.run': '抓一轮', 'btn.running': '抓取中…', 'btn.reload': '刷新', 'btn.save': '保存数据源', 'btn.add': '新增源', 'btn.more': '加载更多',
        'btn.remove': '删除', 'btn.restore': '恢复', 'btn.test': '试抓', 'btn.testing': '试抓中…', 'btn.back': '← 返回', 'btn.today': '今天',
        'label.enabled': '启用', 'label.name': '名称', 'label.id': 'id', 'label.category': '分类', 'label.type': '类型', 'label.url': '地址',
        'label.channels': '通道', 'label.max': '首轮条数', 'label.note': '备注', 'label.adapter': '适配器', 'label.region': '地区', 'label.weight': '权重',
        'label.tier': '层级', 'label.group': '媒体组', 'label.label': '分类', 'label.hotOnly': '只看热门', 'label.window': '时间', 'label.cred': '可信度',
        'label.source': '来源', 'label.query': '关键词', 'label.kind': '显示',
        'head.health': '健康度', 'head.factors': '打分因子', 'head.members': '各源报道', 'head.trend': '重要度轨迹', 'head.heat': '热度曲线',
        'head.pushes': '推送记录', 'head.dispute': '分歧', 'head.schedule': '定时推送', 'head.continuity': '本轮衔接', 'head.gaps': '最近缺口',
        'head.attempts': '抓取尝试', 'head.digest': '汇总正文', 'head.failed': '失败与降级', 'head.recentPushes': '最近推送',
        'cred.single': '单源', 'cred.corroborated': '已印证', 'cred.confirmed': '权威确认', 'cred.disputed': '存在分歧',
        'cred.any': '全部', 'cred.multi': '多源', 'cred.auth': '权威确认',
        'factor.sources': '独立媒体', 'factor.weight': '源权重', 'factor.cross_region': '国内外同报', 'factor.authority': '权威源', 'factor.native': '源头热度',
        'factor.speed': '跟进速度', 'factor.persistence': '持续', 'factor.watch': '关注词',
        'method.seed': '首报', 'method.title': '标题相同', 'method.title+number': '标题+数字', 'method.entity': '跨语言实体',
        'cont.first': '首轮', 'cont.connected': '衔接', 'cont.connected_time': '按时间衔接', 'cont.gap_filled': '缺口已补', 'cont.gap_partial': '部分补回',
        'cont.gap_open': '缺口未补', 'cont.snapshot': '快照源', 'cont.failed': '失败',
        'kind.events': '新事件', 'kind.items': '新条目',
        'txt.sources': '源', 'txt.new': '新增', 'txt.next': '下一轮', 'txt.noSchedule': '未安排定时推送', 'txt.paused': '定时已暂停', 'txt.linked': '衔接',
        'txt.noRun': '还没有抓取记录', 'txt.noEvents': '这个范围内没有事件', 'txt.pick': '选一个事件查看详情', 'txt.noItems': '没有匹配条目',
        'txt.noRunsDay': '这一天没有运行记录', 'txt.pushed': '已推送', 'txt.notPushed': '未推送', 'txt.approx': '~ 为抓取时间近似', 'txt.rows': '条',
        'txt.config': '配置文件', 'txt.saved': '已保存', 'txt.problems': '配置有问题', 'txt.removed': '已删除（历史保留）', 'txt.signals': '信号',
        'txt.noSignals': '只有位置', 'txt.chain': '通道链', 'txt.parsed': '解析', 'txt.kept': '保留', 'txt.removeHint': '软删除：停止抓取，历史条目保留',
        'txt.runFailed': '抓取失败', 'txt.noFail': '最近一轮没有失败', 'txt.noGaps': '没有缺口', 'txt.overnight': '隔夜', 'txt.importance': '重要度',
        'txt.scheduleHint': '让 Agent 调用 newswire_schedule_setup 创建（默认 07–21 点每 2 小时）', 'txt.noScheduleSvc': '当前宿主没有定时任务服务',
        'txt.digestEmpty': '汇总文件还没生成', 'txt.disclaimer': '标题与摘要来自各源列表页；热度为源头原值；财经内容非投资建议。',
        'ph.query': '标题关键词', 'ph.url': 'https://…', 'sel.all': '全部',
        'head.brief': '简报', 'head.points': '要点', 'head.watch': '值得关注', 'head.notes': '解读', 'head.why': '为什么重要', 'head.next': '接下来看',
        'head.topics': '主题分布', 'head.version': '版本', 'head.ruleTop': '最重要的几件（按规则）',
        'btn.brief': '生成简报', 'btn.rebrief': '重写', 'btn.analyze': '生成解读', 'btn.reanalyze': '重新解读', 'btn.check': '检查更新', 'btn.update': '更新到',
        'btn.approve': '允许并更新', 'btn.cancel': '取消', 'btn.relnotes': '更新说明',
        'txt.briefBusy': '模型正在写简报…（本地模型约需 1–2 分钟）', 'txt.analyzing': '模型解读中…', 'txt.modelBusy': '模型正在处理本轮事件',
        'txt.noModel': '没有可用的模型：在 dsh 里选好默认模型，或在插件设置里指定模型。', 'txt.modelOff': '模型解读已在插件设置里关闭。',
        'txt.noBrief': '这个范围还没有简报。', 'txt.by': '由 {m} 生成', 'txt.modelErr': '上次模型调用失败：', 'txt.noNotes': '这个事件还没有解读。',
        'txt.notesHint': '解读由模型根据各源标题与摘要写成，可能有误，以原文为准。', 'txt.events': '{n} 个事件', 'txt.topicHint': '点主题筛选，再点取消',
        'txt.checking': '检查中…', 'txt.updating': '更新中…', 'txt.upToDate': '已是最新版本', 'txt.newVersion': '有新版本', 'txt.updated': '已更新到',
        'txt.reloading': '即将刷新页面', 'txt.restart': '已安装 v{v}，重启 dsh 后生效。', 'txt.updateFailed': '更新失败', 'txt.checkFailed': '检查失败',
        'txt.localSrc': '本地安装，不检查更新', 'txt.unknownSrc': '安装来源未知，不检查更新', 'txt.hostUpdates': '由 dsh 的插件管理负责更新',
        'txt.npmHint': 'npm 安装请在 dsh 的插件管理里更新。', 'txt.noManager': '当前页面拿不到插件管理服务，请在 dsh 的插件管理里更新。',
        'txt.approveHint': '新版本安装时要运行一次构建脚本（prepare），会在本机执行该仓库的代码。允许这些构建并继续？',
        'txt.newBanner': '有新版本 v{v}', 'txt.goUpdate': '去更新', 'txt.checkedAt': '检查于', 'txt.srcLocal': '本地安装', 'txt.srcUnknown': '来源未知', 'txt.hotN': '重点 {n}',
        'view.edition': '版面', 'view.events': '事件', 'head.front': '今日要点', 'head.verify': '待核实', 'head.model': '模型',
        'ed.lead': '导语', 'ed.points': '要点', 'ed.views': '各方说法', 'ed.impact': '影响', 'ed.sources': '来源', 'ed.original': '原文',
        'ed.read': '阅读 {n} 条', 'ed.hours': '近 {n} 小时', 'ed.byModel': '模型编排 · {m}', 'ed.byRules': '程序编排', 'ed.ruleCopy': '程序稿',
        'ed.redo': '重新编排', 'ed.busy': '正在编排新一期，完成后自动更新', 'ed.none': '还没有版面：抓一轮后自动生成，或点「重新编排」。',
        'ed.fellBack': '模型编排没有完成（{e}），本版由程序编排。', 'ed.hintLlm': '版面由模型阅读本时段新闻后编排，可能有误，以原文为准；可信度按报道家数与权威源计算。',
        'ed.hintRules': '节省 token 模式：版面由程序按规则编排，导语与要点取自各家报道原文。', 'ed.noStories': '这个时段没有够分量的报道。',
        'mode.llm': 'LLM 模式', 'mode.economy': '节省 token', 'mode.llmDesc': '模型阅读每轮新闻，归并、分版、判断重要度并按版式写稿；推送按模型版面。',
        'mode.economyDesc': '不调用模型；版面由程序按规则编排，推送按规则。', 'model.default': 'harness 默认（{m}）', 'model.defaultNone': 'harness 默认模型',
        'model.noService': '当前宿主没有模型服务，LLM 模式会退回程序编排。', 'model.ready': '可用：{m}', 'model.notReady': '模型不可用，LLM 模式会退回程序编排。',
        'model.saved': '已保存', 'ed.preview': '先显示程序排的预览；模型正在编写正式版面，完成后自动替换', 'view.daily': '日报', 'dy.make': '生成日报', 'dy.remake': '重新生成', 'dy.none': '这一天还没有日报，点「生成日报」。', 'dy.busy': '正在写今天的回顾，约 1 分钟',
        'dy.tomorrow': '明日关注', 'dy.stats': '新闻 {i} 条 · 故事线 {s} 条 · 来源 {r} 个 · 推送 {p} 次', 'dy.today': '今天', 'dy.items': '当天 {n} 篇', 'dy.hint': '想每晚收到回顾？在对话里说「每晚推送新闻回顾」。',
        'hs.latest': '最新版面', 'hs.viewing': '正在看历史版面（{t}）', 'fb.report': '报错', 'fb.wrong': '有误', 'fb.note': '哪里不对（可不填）', 'fb.done': '已撤下，下次重写时会避开', 'fb.cancel': '收起',
        'fb.misplaced': '不属于这里', 'fb.moved': '已移出，下次重新归并', 'q.title': '质量', 'q.when': '时间', 'q.mode': '模式', 'q.ms': '耗时', 'q.calls': '调用', 'q.fresh': '新/沿用', 'q.check': '核对', 'q.fallback': '退回', 'q.reported': '报错',
        'q.fb': '读者报错 {n} 条，已处理 {r} 条', 'q.re': '重组', 'sn.banner': '自你上次查看（{t}）以来：{n} 条新故事线，{m} 条有进展', 'sn.first': '这是你第一次打开版面：以后这里会告诉你自上次查看以来的变化。',
        'sn.new': '新', 'sn.added': '+{n} 自上次', 'sn.nothing': '自你上次查看（{t}）以来没有新进展。', 'up.label': '进展', 'sd.back': '‹ 返回', 'sd.timeline': '时间轴', 'sd.reports': '{n} 篇报道',
        'sd.pushed': '已推送到手机 · {r}', 'sd.merged': '并入了：{t}', 'sd.since': '始于 {t}', 'sd.copy': '当前稿件', 'view.follows': '关注', 'fl.section': '我的关注', 'fl.follow': '☆ 关注', 'fl.following': '★ 已关注', 'fl.mute': '屏蔽', 'fl.muted': '已屏蔽，下一份版面起不再出现',
        'fl.saved': '已保存，下一份版面起生效', 'fl.kind.story': '故事线', 'fl.kind.keyword': '关键词', 'fl.kind.topic': '主题', 'fl.kind.source': '来源', 'fl.add': '关注', 'fl.addMute': '屏蔽',
        'fl.ph': '人名、公司或词，别名用 | 分隔，如 英伟达|NVIDIA', 'fl.listFollow': '关注中', 'fl.listMute': '已屏蔽', 'fl.none': '还没有', 'fl.remove': '移除',
        'fl.hint': '关注的人、公司或话题会在「今日」最上方单独成栏，有新进展时优先推送给你；屏蔽的不再出现。也可以直接在对话里说「关注英伟达」。', 'ck.unverified': '待核', 'ck.missing': '材料里找不到：{m}', 'ck.more': '等 {n} 家', 'ck.summary': '核对 {p}/{n}', 'ck.dropped': '丢弃 {n} 句',
        'ck.hint': '模型写的每句话里，数字、外文专名、引号里的词都要在材料里找得到；要点与各方说法找不到的已丢弃，导语找不到的标「待核」。中文人名地名无法自动核对。', 'ed.new': '新', 'ed.updated': '有进展', 'model.incr': '新增 {f} 条 · 沿用 {r} 篇稿', 'model.last': '上次编排', 'model.calls': '{n} 次调用', 'model.busy': '正在编排…', 'model.pick': '使用的模型',
      },
      en: {
        'tk.upToDate': 'Synthesis is up to date',
        'tab.track': 'Tracking', 'tk.title': 'Tracking', 'tk.dekAll': 'Follow a company, technology, person or theme over time: related reports attach automatically, and the model connects weeks of developments to judge the trend and its implications.', 'tk.sug': 'Worth tracking', 'tk.sugTheme': 'a theme linking {n} reports in the edition', 'tk.sugEntity': 'in {n} storylines over 7 days ({r} in the last 3)',
        'tk.theme': 'theme', 'tk.mentions': '{n}', 'tk.addPh': 'Company, technology, person or topic, e.g. Nvidia, solid-state batteries, the Iran war', 'tk.tickerPh': 'Ticker', 'tk.add': 'Track', 'tk.none': 'Nothing tracked yet: pick a suggestion above or add your own. Tracked subjects join Following and new developments are pushed.',
        'tk.kind.company': 'company', 'tk.kind.technology': 'technology', 'tk.kind.person': 'person', 'tk.kind.theme': 'theme', 'tk.freshN': '{n} new', 'tk.pending': 'Synthesis after the next edition', 'tk.storiesN': '{n} storylines, {w} in 7 days', 'tk.latest': 'latest: {t}',
        'tk.sparkTip': 'related reports per day, last 30 days', 'tk.back': '‹ Back to tracking', 'tk.stop': 'Stop tracking', 'tk.delete': 'Delete', 'tk.confirm': 'Delete it with its linked developments, syntheses and the follows it added?', 'tk.unlink': 'Not related', 'tk.aliases': 'also: {a}', 'tk.dek': '{n} related storylines · tracking since {t}', 'tk.synth': 'Synthesis', 'tk.synthMeta': '{t} · by {m} from {n} storylines', 'tk.incremental': 'incremental',
        'tk.trend': 'Trend', 'tk.changed': 'Since last time', 'tk.milestones': 'Milestones', 'tk.implications': 'Implications for stock, industry and technology trends', 'tk.noSynth': 'No synthesis yet: generate one below (1–2 minutes).', 'tk.noSynthEconomy': 'Syntheses need LLM mode; developments are listed below.',
        'tk.synthBusy': 'The model is writing the synthesis (1–2 minutes)…', 'tk.resynth': 'Update synthesis ({n} new)', 'tk.synthNow': 'Write synthesis', 'tk.timeline': 'Developments · {n}', 'tk.empty': 'No related reports yet; they attach automatically when they appear.', 'tk.new': 'new since synthesis', 'sd.entities': 'Key entities', 'tk.trackIt': 'Track', 'ask.track': 'Track this topic',
        'rt.depth': 'Model effort', 'rt.lean': 'Lean', 'rt.balanced': 'Balanced', 'rt.deep': 'Deep', 'rt.depthDesc': 'per edition: reads {r} items, writes {w} stories, analyzes {a} automatically, translates {t} foreign titles', 'rt.budget': 'Daily token limit', 'rt.budgetHint': '0 = no limit; once used up, model steps fall back to the program until tomorrow',
        'rt.today': 'Today', 'rt.todayLine': '{c} calls · input {i} · output {o} · cache hits {k}', 'rt.cacheRate': '{p}% of input from cache', 'rt.est': '(estimated from text length; the host reported no usage)', 'rt.ofBudget': '{p}% of the limit',
        'rt.speed': 'Measured: about {t} output tokens/s, median call {s}s', 'rt.conc': 'concurrency {n}', 'rt.concProbe': 'concurrency not measured yet (next edition)', 'rt.probe': '(parallel efficiency {e})',
        'rt.step.group': 'grouping', 'rt.step.plan': 'planning', 'rt.step.write': 'writing', 'rt.step.translate': 'translation', 'rt.step.analyze': 'impact', 'rt.step.ask': 'Q&A', 'rt.step.split': 'roundups', 'rt.step.daily': 'recap', 'rt.step.notes': 'event notes', 'rt.step.brief': 'briefs', 'rt.step.track': 'tracking', 'rt.step.other': 'other',
        'rd.outletsN': ' and {n} outlets', 'ev.indep': '{n} independent outlets', 'ev.single': 'one outlet only', 'ev.reports': 'Reports · {n}', 'ev.first': 'first', 'ev.repost': 'repost', 'ev.views': '{n} views', 'ev.why': 'Why it ranks here (importance {n})',
        'ev.searchPh': 'Search titles', 'ev.h6': '6 hours', 'ev.h24': '24 hours', 'ev.h72': '3 days', 'ev.multi': 'Several outlets only', 'ev.moreFilters': 'More filters', 'ev.hot': 'Trending: ',
        'tl.hint': 'Each bar is one fetch round; its height is the new items. Click one to see what that round brought.', 'tl.night': 'overnight', 'tl.pushed': 'pushed', 'tl.failed': '{n} failed', 'tl.gap': 'gap', 'tl.gaps': '{n} gaps', 'tl.barTip': 'Round at {t}: {n} new items, {m} stories with several outlets',
        'tl.round': 'Round at {t}', 'tl.srcs': 'sources {a}/{b}', 'tl.newItems': '{n} new items', 'tl.newEvents': '{n} new stories', 'tl.pushes': '{n} pushed',
        'it.kind.promo': 'ad/promo', 'it.kind.ticker': 'market', 'it.kind.digest': 'roundup', 'it.showFiltered': 'Show filtered',
        'ia.title': 'Impact & outlook', 'ia.horizon': 'horizon: {h}', 'ia.spec': 'model speculation, not fact or investment advice', 'ia.conf': '{c} confidence', 'ia.more': 'Full analysis ›', 'ia.follow': 'Follow this story', 'ia.following': 'Following; updates will be pushed',
        'ia.busy': 'The model is analyzing impact and outlook (1–2 minutes)…', 'ia.run': 'Analyze impact & outlook', 'ia.rerun': 'Analyze again', 'ia.noModel': 'Needs LLM mode and an available model', 'ia.impacts': 'Likely affected', 'ia.scenarios': 'Possible paths', 'ia.signals': 'Signals: ', 'ia.watch': 'Watch next',
        'ia.disclaimer': 'Speculation by {m} from this storyline\'s reports ({t}); not fact, not investment advice.', 'ia.dropped': '{n} items did not match the sources and were removed.', 'ia.newer': '{n} new reports since this analysis; you can analyze again.',
        'fl.topHint': '{n} · people, companies and topics you follow',
        'rd.reposts': '{n} more reposted', 'rd.repostsHint': 'Reposts (near-identical, not independent corroboration): {w}', 'sb.reposts': 'reposts {n}',
        'wl.title': 'Welcome: 30 seconds to tell it what you want', 'wl.dek': 'It gathers news from dozens of outlets, groups reports into one story each, has a model read and write the edition, and pushes to your phone on your schedule.', 'wl.topics': 'Sections you care about', 'wl.topicsHint': 'Unchecked sections stay out of the edition and pushes; restore them any time under Follow & push.', 'wl.study': 'Study abroad (a separate set of sources)',
        'wl.follow': 'People, companies or topics to follow closely (optional)', 'wl.followPh': 'comma-separated, e.g. Nvidia, Iran, Fed', 'wl.push': 'Push cadence', 'wl.c2h': 'Every 2 hours', 'wl.c3': 'Three times a day', 'wl.cDaily': 'Evening recap only', 'wl.pushHint': 'Ask the Agent once to schedule pushes (say "push the news every 2 hours"); after that this cadence applies.',
        'wl.start': 'Start: fetch the first round', 'wl.busy': 'A round is already running; try again shortly', 'wl.fetchingH': 'Preparing your first edition', 'wl.fetching': 'Fetching every source; about 3–5 minutes the first time ({s} so far)…', 'wl.s1': 'Fetch the latest from each source, dedupe, spot ads and roundups', 'wl.s2': 'A program-made edition appears as soon as fetching ends', 'wl.s3': 'The model then reads, groups and writes, replacing stories one by one',
        'ask.ph': 'Search or ask, e.g. what is happening with Iran', 'ask.for': '“{q}”', 'ask.found': '{n} related reports in the last {h} hours', 'ask.close': '× Back to edition', 'ask.answer': 'Answer', 'ask.reading': 'The model is reading {n} related reports (about a minute)…', 'ask.notEnough': 'The reports found are not enough to answer this.',
        'ask.by': 'Answered by {m} from the reports below; every sentence is cited', 'ask.dropped': '{n} sentences did not match the sources and were removed', 'ask.partial': 'the material is incomplete', 'ask.stories': 'Related storylines', 'ask.reports': '{n} reports', 'ask.items': 'Related reports', 'ask.none': 'Nothing found for “{t}”.',
        'ps.title': 'Push', 'ps.hint': 'Every push interrupts you, so decide when and how much. Cadence changes the scheduled task itself; within each round only stories over the bar are pushed.', 'ps.cadence': 'Cadence', 'ps.level': 'Bar', 'ps.fewer': 'Fewer', 'ps.normal': 'Normal', 'ps.more': 'More', 'ps.limits': 'Limits', 'ps.perRound': 'Per round', 'ps.daily': 'Per day',
        'ps.save': 'Save', 'ps.saved': 'Saved.', 'ps.noSvc': 'This host has no schedule service; only the preferences are saved.', 'ps.noTask': 'No scheduled push yet: say "push the news every 2 hours" in the chat.', 'ps.task': 'Scheduled task: {s}, next {n}', 'ps.learned': 'From your feedback, these sections now have a higher bar: {s}',
        'ps.log': 'Push history', 'ps.up': 'Useful', 'ps.down': 'Not useful', 'ps.none': 'Nothing pushed yet.',
        'ed.partial': 'The model has laid out the edition and is writing stories ({w}/{n} done, front page first); the rest show program copy until replaced',
        'rd.ticks': 'Markets',
        'sb.title': 'Choosing sources', 'sb.hint': 'What each source brought in the last {d} days. On: in the edition and pushes; Trial: fetched and used to corroborate other outlets, but cannot put a story on the board or in a push alone; Off: not fetched.', 'sb.sum': '{on} on · {trial} on trial · {off} off', 'sb.applyAll': 'Apply suggestions ({n})', 'sb.applied': '{n} sources changed; takes effect next round',
        'sb.on': 'On', 'sb.trial': 'Trial', 'sb.off': 'Off', 'sb.suggest': 'Suggested: {s}', 'sb.advanced': 'Advanced: edit source config (URL, type, channels, weight…)', 'sb.foot': 'Stats update with new data; a source that is off has no new data, so its numbers stop where it was turned off. Not sure? Put it on trial: it only corroborates, so it cannot clutter the edition; decide after a few days.',
        'sb.perDay': '{n}/day', 'sb.board': 'in edition {n}', 'sb.first': 'first {n}', 'sb.excl': 'exclusive {n}', 'sb.corrob': 'corroborates {n}', 'sb.low': 'low value {p}%', 'sb.full': 'complete {p}%', 'sb.promo': 'ads {n}', 'sb.fetch': 'fetch ok {p}%',
        'sb.v.core': 'core', 'sb.v.support': 'corroborates', 'sb.v.ok': 'average', 'sb.v.low': 'low value', 'sb.v.unstable': 'unstable', 'sb.v.insufficient': 'too little data',
        'sb.why.core': 'Often in the edition, or often first or exclusive; worth keeping.', 'sb.why.support': 'Mostly corroborates other outlets, which sharpens credibility.', 'sb.why.ok': 'Average: rarely in the edition, rarely overlaps with others.', 'sb.why.low': 'Mostly low-value items that rarely overlap with other outlets; it mainly adds noise.', 'sb.why.unstable': 'Over half of recent rounds failed to fetch; test it under Advanced.', 'sb.why.insufficient': 'Too little data to judge; try it on trial.',
        'ct.adv.degraded': 'The page may have changed: test this source under Sources and check what it parses', 'ct.adv.blocked': 'Bodies are blocked or rendered by script: titles only; consider disabling it or using a source with full text', 'ct.adv.slow': 'Bodies come through but slowly: fetched only for edition and key stories', 'ct.adv.fetch': 'Bodies come through: every new item is filled each round', 'ct.adv.probe': 'Trying a few bodies; a strategy is set after a few rounds', 'ct.adv.none': 'Paywalled or set not to fetch bodies',
        'ct.advice': 'Advice', 'ct.mode.list': 'in list', 'ct.mode.fetch': 'every item', 'ct.mode.slow': 'key items only', 'ct.mode.blocked': 'blocked', 'ct.mode.probe': 'probing', 'ct.mode.none': 'off',
        'sd.fromDigest': 'from “{t}”',
        'ct.title': 'Content completeness', 'ct.sum': 'last 24h: {n} items · {f} complete · {p} ads and promos filtered · {d} roundups split into {i} items', 'ct.hint': 'Getting partial content is harder to notice than getting nothing. Sources with only titles or cut-off summaries are listed here; stories going into the edition fetch the full article first. A source that suddenly has only titles has probably changed its page.',
        'ct.src': 'Source', 'ct.state': 'State', 'ct.n': 'Items', 'ct.full': 'Full', 'ct.trunc': 'Cut off', 'ct.titleOnly': 'Title only', 'ct.bodies': 'Bodies fetched', 'ct.before': 'was {p}%', 'ct.allOk': 'All sources deliver full content.',
        'ct.st.degraded': 'dropped suddenly', 'ct.st.titles_only': 'titles only', 'ct.st.partial': 'partly cut off', 'ct.st.ok': 'ok', 'ct.filtered': '{n} filtered (last 3 days)', 'ct.digest': 'roundup, split', 'ct.promo': 'ad', 'ct.restore': 'This is news — restore', 'ct.restored': 'restored',
        'st.thin': '{s}: less content', 'fb.promo': 'This is an ad or promotion', 'fb.promoHint': 'removes it; the model uses it as an example to spot similar items', 'fb.promoDone': 'Removed; restore it under Runs → Content completeness',
        'sd.dek': '{n} reports · {o} outlets · since {t}', 'sd.why.new': 'first push', 'sd.why.jumped': 'importance rose', 'sd.why.followup': 'followed storyline developed', 'sd.why.corroborated': 'corroborated',
        'tab.today': 'Today', 'tab.daily': 'Recap', 'tab.follows': 'Follow & push', 'tab.events': 'Events', 'btn.runHint': 'Fetch all sources now and lay out again',
        'st.updated': 'updated {t}', 'st.failed': '{n} sources failed', 'st.gaps': '{n} gaps', 'st.stale': 'not updated for over a day',
        'rd.outlets': '{w} and {n} outlets', 'rd.developing': 'Developing', 'rd.more': 'More: views, impact and sources', 'rd.less': 'Less', 'rd.reportHint': 'Pick the wrong sentence: it is removed now and avoided in the next rewrite.',
        'rd.asof': 'as of {t}', 'rd.pack': 'Scope', 'rd.allPacks': 'Everything', 'rd.dek': 'Last {h} hours · {n} stories · {o} outlets',
        'rd.sinceH': 'Since you last looked ({t})', 'rd.sinceNew': '{n} new', 'rd.sinceDev': '{n} developing',
        'rd.about': 'About this edition', 'rd.byModel': 'Read and written by {m}', 'rd.byRules': 'Laid out by rules (save-tokens mode)', 'rd.read': 'Read the {n} most important reports of the last {h} hours. ', 'rd.checked': '{p} of {n} model sentences with numbers or names were checked against the sources.',
        'rd.past': 'Past editions', 'rd.skim': 'In this edition', 'rd.aboutDay': 'About this recap', 'rd.dayDek': '{n} things worth remembering today',
        'nav.panel': 'Newswire', 'tab.news': 'Top', 'tab.timeline': 'Timeline', 'tab.items': 'Items', 'tab.sources': 'Sources', 'tab.runs': 'Runs',
        'btn.run': 'Fetch now', 'btn.running': 'Fetching…', 'btn.reload': 'Reload', 'btn.save': 'Save sources', 'btn.add': 'Add source', 'btn.more': 'Load more',
        'btn.remove': 'Remove', 'btn.restore': 'Restore', 'btn.test': 'Test', 'btn.testing': 'Testing…', 'btn.back': '← Back', 'btn.today': 'Today',
        'label.enabled': 'On', 'label.name': 'Name', 'label.id': 'id', 'label.category': 'Category', 'label.type': 'Type', 'label.url': 'URL',
        'label.channels': 'Channels', 'label.max': 'First round', 'label.note': 'Note', 'label.adapter': 'Adapter', 'label.region': 'Region', 'label.weight': 'Weight',
        'label.tier': 'Tier', 'label.group': 'Group', 'label.label': 'Topic', 'label.hotOnly': 'Hot only', 'label.window': 'Window', 'label.cred': 'Credibility',
        'label.source': 'Source', 'label.query': 'Keyword', 'label.kind': 'Show',
        'head.health': 'Health', 'head.factors': 'Score factors', 'head.members': 'Coverage', 'head.trend': 'Importance trend', 'head.heat': 'Heat curve',
        'head.pushes': 'Pushes', 'head.dispute': 'Dispute', 'head.schedule': 'Scheduled push', 'head.continuity': 'Continuity', 'head.gaps': 'Recent gaps',
        'head.attempts': 'Fetch attempts', 'head.digest': 'Digest', 'head.failed': 'Failures', 'head.recentPushes': 'Recent pushes',
        'cred.single': 'single', 'cred.corroborated': 'corroborated', 'cred.confirmed': 'confirmed', 'cred.disputed': 'disputed',
        'cred.any': 'all', 'cred.multi': 'multi-source', 'cred.auth': 'confirmed',
        'factor.sources': 'outlets', 'factor.weight': 'weight', 'factor.cross_region': 'cross-region', 'factor.authority': 'authority', 'factor.native': 'native heat',
        'factor.speed': 'speed', 'factor.persistence': 'persistence', 'factor.watch': 'watch words',
        'method.seed': 'first', 'method.title': 'title', 'method.title+number': 'title+number', 'method.entity': 'entities',
        'cont.first': 'first', 'cont.connected': 'linked', 'cont.connected_time': 'linked by time', 'cont.gap_filled': 'gap filled', 'cont.gap_partial': 'partly filled',
        'cont.gap_open': 'gap open', 'cont.snapshot': 'snapshot', 'cont.failed': 'failed',
        'kind.events': 'New events', 'kind.items': 'New items',
        'txt.sources': 'sources', 'txt.new': 'new', 'txt.next': 'next', 'txt.noSchedule': 'No scheduled push', 'txt.paused': 'Schedule paused', 'txt.linked': 'linked',
        'txt.noRun': 'No runs yet — press Fetch now', 'txt.noEvents': 'No events in this range', 'txt.pick': 'Pick an event to see details', 'txt.noItems': 'No matching items',
        'txt.noRunsDay': 'No runs on this day', 'txt.pushed': 'pushed', 'txt.notPushed': 'not pushed', 'txt.approx': '~ = approximated by fetch time', 'txt.rows': 'rows',
        'txt.config': 'Config file', 'txt.saved': 'Saved', 'txt.problems': 'Invalid config', 'txt.removed': 'Removed (history kept)', 'txt.signals': 'Signals',
        'txt.noSignals': 'position only', 'txt.chain': 'Chain', 'txt.parsed': 'parsed', 'txt.kept': 'kept', 'txt.removeHint': 'Soft delete: stop fetching, keep history',
        'txt.runFailed': 'Fetch failed', 'txt.noFail': 'No failures in the latest run', 'txt.noGaps': 'No gaps', 'txt.overnight': 'overnight', 'txt.importance': 'importance',
        'txt.scheduleHint': 'Ask the Agent to call newswire_schedule_setup (default every 2h, 07–21)', 'txt.noScheduleSvc': 'This host has no schedule service',
        'txt.digestEmpty': 'Digest not generated yet', 'txt.disclaimer': 'Titles and summaries come from source list pages; heat is as reported by the source; not investment advice.',
        'ph.query': 'title keyword', 'ph.url': 'https://…', 'sel.all': 'all',
        'head.brief': 'Briefing', 'head.points': 'Key points', 'head.watch': 'Worth watching', 'head.notes': 'Explained', 'head.why': 'Why it matters', 'head.next': 'What to watch',
        'head.topics': 'Topics', 'head.version': 'Version', 'head.ruleTop': 'Most important (by rules)',
        'btn.brief': 'Write briefing', 'btn.rebrief': 'Rewrite', 'btn.analyze': 'Explain', 'btn.reanalyze': 'Re-explain', 'btn.check': 'Check for updates', 'btn.update': 'Update to',
        'btn.approve': 'Allow and update', 'btn.cancel': 'Cancel', 'btn.relnotes': 'Release notes',
        'txt.briefBusy': 'The model is writing the briefing… (1–2 minutes on a local model)', 'txt.analyzing': 'Explaining…', 'txt.modelBusy': 'The model is working on this round',
        'txt.noModel': 'No model available: pick a default model in dsh, or set one in the plugin settings.', 'txt.modelOff': 'Model explanations are turned off in the plugin settings.',
        'txt.noBrief': 'No briefing for this range yet.', 'txt.by': 'by {m}', 'txt.modelErr': 'Last model call failed: ', 'txt.noNotes': 'No explanation for this event yet.',
        'txt.notesHint': 'Written by a model from the outlets\' titles and summaries; it can be wrong — check the articles.', 'txt.events': '{n} events', 'txt.topicHint': 'Click a topic to filter, again to clear',
        'txt.checking': 'Checking…', 'txt.updating': 'Updating…', 'txt.upToDate': 'Up to date', 'txt.newVersion': 'New version', 'txt.updated': 'Updated to',
        'txt.reloading': 'reloading', 'txt.restart': 'Installed v{v}; restart dsh to run it.', 'txt.updateFailed': 'Update failed', 'txt.checkFailed': 'Check failed',
        'txt.localSrc': 'Local install; no update check', 'txt.unknownSrc': 'Unknown install source; no update check', 'txt.hostUpdates': 'Updated by the dsh plugin manager',
        'txt.npmHint': 'Installed from npm: update it in the dsh plugin manager.', 'txt.noManager': 'Plugin management is not available to this page; update in the dsh plugin manager.',
        'txt.approveHint': 'The new version runs its build script (prepare) once while installing, which executes that repository\'s code on this machine. Allow these builds and continue?',
        'txt.newBanner': 'New version v{v}', 'txt.goUpdate': 'Update', 'txt.checkedAt': 'checked', 'txt.srcLocal': 'local install', 'txt.srcUnknown': 'unknown source', 'txt.hotN': '{n} top',
        'view.edition': 'Edition', 'view.events': 'Events', 'head.front': 'Top stories', 'head.verify': 'To verify', 'head.model': 'Model',
        'ed.lead': 'Lead', 'ed.points': 'Key points', 'ed.views': 'What each side says', 'ed.impact': 'Impact', 'ed.sources': 'Sources', 'ed.original': 'Article',
        'ed.read': '{n} items read', 'ed.hours': 'last {n}h', 'ed.byModel': 'laid out by {m}', 'ed.byRules': 'laid out by rules', 'ed.ruleCopy': 'program copy',
        'ed.redo': 'Lay out again', 'ed.busy': 'The model is laying out the edition… (3–8 minutes on a local model; refreshes when done)', 'ed.none': 'No edition yet: one is made after each fetch, or press Lay out again.',
        'ed.fellBack': 'The model layout did not finish ({e}); this edition was laid out by rules.', 'ed.hintLlm': 'Laid out by a model from this period\'s news; it can be wrong — check the articles. Credibility is computed from the outlets.',
        'ed.hintRules': 'Economy mode: laid out by rules; leads and points come from the outlets\' own text.', 'ed.noStories': 'No stories of weight in this period.',
        'mode.llm': 'LLM mode', 'mode.economy': 'Save tokens', 'mode.llmDesc': 'A model reads each round\'s news, groups, sections, ranks and writes it to the layout; pushes follow the model edition.',
        'mode.economyDesc': 'No model calls; the program lays out the edition by rules and pushes by rules.', 'model.default': 'harness default ({m})', 'model.defaultNone': 'harness default model',
        'model.noService': 'This host has no model service; LLM mode falls back to the rules.', 'model.ready': 'Ready: {m}', 'model.notReady': 'No model available; LLM mode falls back to the rules.',
        'model.saved': 'Saved', 'ed.preview': 'This is a quick preview laid out by the program; the model is laying out the edition and it will replace this when done.', 'view.daily': 'Daily', 'dy.make': 'Write digest', 'dy.remake': 'Rewrite', 'dy.none': 'No digest for this day yet; press Write digest.', 'dy.busy': 'The model is writing the digest… (1–2 minutes)',
        'dy.tomorrow': 'Tomorrow', 'dy.stats': '{i} items · {s} storylines · {r} sources · {p} pushes', 'dy.today': 'Today', 'dy.items': '{n} that day', 'dy.hint': 'Want it every evening? Say "push the news recap every night" in the chat.',
        'hs.latest': 'Latest edition', 'hs.viewing': 'Viewing a past edition ({t})', 'fb.report': 'Report', 'fb.wrong': 'Wrong', 'fb.note': 'What is wrong (optional)', 'fb.done': 'Removed; the next rewrite avoids it', 'fb.cancel': 'Close',
        'fb.misplaced': 'Not this story', 'fb.moved': 'Moved out; it will be regrouped', 'q.title': 'Quality', 'q.when': 'Time', 'q.mode': 'Mode', 'q.ms': 'Time taken', 'q.calls': 'Calls', 'q.fresh': 'New/reused', 'q.check': 'Check', 'q.fallback': 'Fallbacks', 'q.reported': 'Reports',
        'q.fb': '{n} reader reports, {r} handled', 'q.re': 'reflow', 'sn.banner': 'Since you last looked ({t}): {n} new storylines, {m} developing', 'sn.first': 'First visit: from now on this shows what changed since you last looked.',
        'sn.new': 'new', 'sn.added': '+{n} since last visit', 'sn.nothing': 'Nothing new since you last looked ({t}).', 'up.label': 'Update', 'sd.back': '‹ Back', 'sd.timeline': 'Timeline', 'sd.reports': '{n} reports',
        'sd.pushed': 'pushed ({r})', 'sd.merged': 'Merged in: {t}', 'sd.since': 'since {t}', 'sd.copy': 'Current copy', 'view.follows': 'Following', 'fl.section': 'Following', 'fl.follow': '☆ Follow', 'fl.following': '★ Following', 'fl.mute': 'Mute', 'fl.muted': 'Muted; gone from the next edition',
        'fl.saved': 'Saved; takes effect from the next edition', 'fl.kind.story': 'storyline', 'fl.kind.keyword': 'keyword', 'fl.kind.topic': 'topic', 'fl.kind.source': 'source', 'fl.add': 'Follow', 'fl.addMute': 'Mute',
        'fl.ph': 'person, company, or term; aliases with |, e.g. 英伟达|NVIDIA', 'fl.listFollow': 'Following', 'fl.listMute': 'Muted', 'fl.none': 'none yet', 'fl.remove': 'Remove',
        'fl.hint': 'People, companies or topics you follow get their own section at the top of Today, and new developments are pushed to you first; muted ones disappear. You can also just say "follow Nvidia" in the chat.', 'ck.unverified': 'unverified', 'ck.missing': 'Not found in the sources: {m}', 'ck.more': '{n} outlets in all', 'ck.summary': 'checked {p}/{n}', 'ck.dropped': '{n} dropped',
        'ck.hint': 'Numbers, foreign names, and quoted terms in every sentence the model wrote must appear in the sources; points and views that fail were dropped, a lead that fails is marked unverified. Chinese names cannot be checked automatically.', 'ed.new': 'new', 'ed.updated': 'developing', 'model.incr': '{f} new items · {r} stories reused', 'model.last': 'Last layout', 'model.calls': '{n} calls', 'model.busy': 'Laying out…', 'model.pick': 'Model',
      },
    }
    var lang = 'zh'
    function t(key, vars) {
      var d = DICT[lang] || DICT.zh
      var s = d[key] || DICT.zh[key] || key
      if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', String(vars[k])) })
      return s
    }

    // ------------------------------------------------------------------ 工具
    function store(key, value) {
      try {
        if (value === undefined) return window.localStorage.getItem(NS + '.' + key)
        window.localStorage.setItem(NS + '.' + key, value)
      } catch (e) { /* 隐私模式等：只是不记住 */ }
      return null
    }
    function toMs(v) {
      if (!v) return NaN
      var s = String(v)
      return Date.parse(s.indexOf('T') >= 0 ? s : s.replace(' ', 'T') + 'Z')
    }
    var fmtCache = {}
    function fmt(ms, opts) {
      var key = JSON.stringify(opts)
      if (!fmtCache[key]) fmtCache[key] = new Intl.DateTimeFormat('zh-CN', Object.assign({ timeZone: TZ, hour12: false }, opts))
      return fmtCache[key].format(new Date(ms)).replace(/\//g, '-')
    }
    function dayOf(ms) { return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date(ms)) }
    /** 今天的只显示时分，昨天写「昨天」，其它日期带月日。 */
    function when(v) {
      var ms = toMs(v)
      if (!isFinite(ms)) return ''
      var d = dayOf(ms)
      if (d === dayOf(Date.now())) return fmt(ms, { hour: '2-digit', minute: '2-digit' })
      if (d === dayOf(Date.now() - 86400000)) return (lang === 'zh' ? '昨天 ' : 'yesterday ') + fmt(ms, { hour: '2-digit', minute: '2-digit' })
      return fmt(ms, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    /** 按时间可信度显示：fetched 加 ~，url_date（链接里只有日期）只显示月日。 */
    function whenC(v, conf) {
      if (conf === 'url_date') { var ms = toMs(v); return isFinite(ms) ? fmt(ms, { month: '2-digit', day: '2-digit' }) : '' }
      return (conf === 'fetched' ? '~' : '') + when(v)
    }
    function hhmm(v) { var ms = toMs(v); return isFinite(ms) ? fmt(ms, { hour: '2-digit', minute: '2-digit' }) : '' }
    function ago(v) {
      var ms = toMs(v)
      if (!isFinite(ms)) return '–'
      var min = Math.round((Date.now() - ms) / 60000)
      if (min < 60) return min + 'm'
      if (min < 2880) return Math.round(min / 60) + 'h'
      return Math.round(min / 1440) + 'd'
    }
    function fmtN(n) {
      if (lang === 'en') return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n)
      return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n)
    }
    var SIG_LABEL = { zh: { views: '阅读', comments: '评论', likes: '赞', shares: '分享', favorites: '收藏', level: '级别', hot: '热门标记', section: '区块', rank: '位置' }, en: { views: 'views', comments: 'comments', likes: 'likes', shares: 'shares', favorites: 'saves', level: 'level', hot: 'hot marks', section: 'section', rank: 'rank' } }
    function sigLabel(k) { return (SIG_LABEL[lang] || SIG_LABEL.zh)[k] || k }
    function shortName(x) { return String((x && (x.name || x.source_id)) || '').replace(/·.*$/, '').replace(/\s+TechFlow$/, '') }
    function addDays(date, n) {
      var p = String(date).split('-').map(Number)
      var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n))
      return d.toISOString().slice(0, 10)
    }
    function request(url, init) {
      return fetch(url, Object.assign({ credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' } }, init || {})).then(function (res) {
        return res.json().catch(function () { return null }).then(function (data) {
          if (!res.ok) { var e = new Error((data && data.error) || ('http_' + res.status)); e.status = res.status; e.data = data; throw e }
          return data
        })
      })
    }
    function getJson(url) { return request(url) }
    function postJson(url, body) { return request(url, { method: 'POST', body: JSON.stringify(body || {}) }) }
    function setIn(setter, patch) { setter(function (prev) { return Object.assign({}, prev, patch) }) }

    // ------------------------------------------------------------------ 原子组件
    function Chip(props) { return h('span', { className: 'nw-chip' + (props.tone ? ' nw-' + props.tone : ''), title: props.title }, props.children) }
    var CRED_TONE = { confirmed: 'ok', corroborated: 'info', disputed: 'warn', single: 'dim' }
    function CredBadge(props) { return h(Chip, { tone: CRED_TONE[props.cred] || 'dim' }, t('cred.' + props.cred) + (props.n > 1 ? ' · ' + props.n : '')) }
    function impTone(x) { return x >= 70 ? 'hi' : x >= 50 ? 'mid' : 'lo' }
    function Empty(props) { return h('div', { className: 'nw-empty' }, props.children) }
    function Section(props) {
      return h('section', { className: 'nw-sec' },
        h('div', { className: 'nw-sec-h' }, h('h4', null, props.title), props.aside || null),
        props.children)
    }
    /** 源头热度信号 → 小标签（只显示源头给了的）。 */
    function SignalChips(sig) {
      if (!sig) return null
      var out = []
      var lab = { views: lang === 'en' ? 'views' : '阅读', comments: lang === 'en' ? 'comments' : '评论', likes: lang === 'en' ? 'likes' : '赞', shares: lang === 'en' ? 'shares' : '分享' }
      ;(sig.hot || []).forEach(function (x) { out.push(h(Chip, { key: 'h' + x, tone: 'hot' }, '🔥 ' + x)) })
      if (sig.level) out.push(h(Chip, { key: 'lv', tone: 'hot' }, (lang === 'en' ? 'level ' : '级别 ') + sig.level))
      ;['views', 'comments', 'likes', 'shares'].forEach(function (k) { if (sig[k] != null && sig[k] > 0) out.push(h(Chip, { key: k }, lab[k] + ' ' + fmtN(sig[k]))) })
      if (sig.section && sig.section !== 'list') out.push(h(Chip, { key: 'sec', tone: 'dim' }, sig.section))
      return out.length ? out : null
    }
    /** 迷你折线（数值序列），无数据时不画。 */
    function Spark(props) {
      var vals = (props.values || []).filter(function (v) { return v != null && isFinite(v) })
      if (vals.length < 2) return h('span', { className: 'nw-muted' }, vals.length ? String(vals[0]) : '–')
      var w = props.width || 160
      var hh = props.height || 32
      var min = Math.min.apply(null, vals)
      var max = Math.max.apply(null, vals)
      var span = max - min || 1
      var pts = vals.map(function (v, i) { return (i * (w - 4) / (vals.length - 1) + 2).toFixed(1) + ',' + (hh - 3 - (v - min) * (hh - 6) / span).toFixed(1) }).join(' ')
      return h('span', { className: 'nw-spark' },
        h('svg', { width: w, height: hh, viewBox: '0 0 ' + w + ' ' + hh, role: 'img', 'aria-label': props.label || '' },
          h('polyline', { points: pts, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round', strokeLinecap: 'round' })),
        h('span', { className: 'nw-muted' }, props.format ? props.format(vals[vals.length - 1]) : String(vals[vals.length - 1])))
    }
    function Seg(props) {
      return h('div', { className: 'nw-seg', role: 'group' }, props.options.map(function (o) {
        return h('button', { key: String(o[0]), className: props.value === o[0] ? 'nw-on' : '', onClick: function () { props.onChange(o[0]) } }, o[1])
      }))
    }
    var TabErrorBoundary = (function () {
      var baseProto = Component && Component.prototype ? Component.prototype : Object.prototype
      function B(props) { this.props = props; this.state = null }
      B.prototype = Object.create(baseProto)
      B.prototype.constructor = B
      B.prototype.componentDidCatch = function (err) { this.setState({ err: err }) }
      B.prototype.render = function () {
        if (this.state && this.state.err) return h('div', { className: 'nw-error' }, 'render error: ' + String(this.state.err && this.state.err.message ? this.state.err.message : this.state.err))
        return this.props.children
      }
      return B
    })()

    // ------------------------------------------------------------------ 事件卡片与详情
    /** 事件一行：重要度用小圆点，标题用中文，下面一行写谁报道、什么时候、可信度。 */
    function EventCard(props) {
      var e = props.ev
      var outs = (e.outlets || []).filter(function (x) { return !x.repost_of })
      var reposts = (e.outlets || []).filter(function (x) { return x.repost_of }).length
      var who = outs.length ? shortName(outs[0]) + (outs.length > 1 ? t('rd.outletsN', { n: outs.length }) : '') : ''
      var meta = [who, when(e.first_seen_at)]
      if (e.credibility === 'confirmed') meta.push(t('cred.confirmed'))
      if (e.credibility === 'disputed') meta.push(t('cred.disputed'))
      if (reposts) meta.push(t('rd.reposts', { n: reposts }))
      if (e.pushed) meta.push(t('txt.pushed'))
      return h('button', { className: 'nw-evrow' + (props.active ? ' nw-active' : ''), onClick: props.onClick, title: t('txt.importance') + ' ' + Math.round(e.importance) },
        h('span', { className: 'nw-evdot nw-evdot-' + impTone(e.importance) }),
        h('span', { className: 'nw-evbody' },
          h('span', { className: 'nw-evtitle' }, e.title),
          e.notes && e.notes.summary ? h('span', { className: 'nw-evsum' }, e.notes.summary) : null,
          h('span', { className: 'nw-evmeta' }, meta.filter(Boolean).join(' · '))))
    }

    function FactorBars(f) {
      return h('div', { className: 'nw-factors' }, FACTORS.map(function (x) {
        var v = Number((f || {})[x[0]] || 0)
        return h('div', { className: 'nw-factor', key: x[0] },
          h('span', { className: 'nw-factor-k' }, t('factor.' + x[0])),
          h('span', { className: 'nw-track' }, h('span', { className: 'nw-fill', style: { width: Math.round(Math.min(1, v / x[1]) * 100) + '%' } })),
          h('span', { className: 'nw-factor-v' }, String(Math.round(v * 10) / 10)))
      }))
    }

    /** 热度曲线：优先有阅读数的成员，其次互动数；全为 0 的不画（如评论数大多为 0 的源）。 */
    function heatSeries(heat) {
      var by = {}
      ;(heat || []).forEach(function (o) {
        var isViews = o.views != null
        var v = isViews ? o.views : (o.likes != null || o.comments != null ? (o.likes || 0) + 3 * (o.comments || 0) : null)
        if (v == null) return
        var cur = (by[o.article_id] = by[o.article_id] || { source_id: o.source_id, vals: [], views: isViews })
        cur.vals.push(v)
      })
      var best = null
      Object.keys(by).forEach(function (k) {
        var c = by[k]
        if (Math.max.apply(null, c.vals) <= 0) return
        if (!best || (c.views && !best.views) || (c.views === best.views && c.vals.length > best.vals.length)) best = c
      })
      return best
    }

    /** 事件详情：先看各家怎么报、谁先报、谁是转载；打分细节收在「为什么排在这里」。 */
    function EventDetailView(props) {
      var e = props.ev
      var wPair = useState(false)
      var why = wPair[0]
      var setWhy = wPair[1]
      if (!e) return Empty({ children: t('txt.pick') })
      var heat = heatSeries(e.heat)
      var members = (e.members || []).slice().sort(function (a, b) { return String(a.published_at || a.joined_at).localeCompare(String(b.published_at || b.joined_at)) })
      var indep = members.filter(function (m) { return !m.repost_of })
      var firstId = indep.length ? indep[0].article_id : null
      var reposts = members.length - indep.length
      var days = []
      members.forEach(function (m) { var ms = toMs(m.published_at || m.joined_at); var day = isFinite(ms) ? dayOf(ms) : ''; if (!days.length || days[days.length - 1].day !== day) days.push({ day: day, list: [] }); days[days.length - 1].list.push(m) })
      return h('div', { className: 'nw-sd nw-evd' },
        props.onBack ? h('button', { className: 'nw-act nw-back-link nw-back', onClick: props.onBack }, t('sd.back')) : null,
        h('header', { className: 'nw-mast' },
          h('span', { className: 'nw-mast-date' }, [(e.labels || []).slice(0, 2).map(function (l) { return (props.names && props.names[l]) || l }).join(' · '), (e.regions || []).slice(0, 3).join(' ')].filter(Boolean).join(' · ')),
          h('a', { className: 'nw-mast-head nw-evd-title', href: e.lead_url || '#', target: '_blank', rel: 'noopener noreferrer' }, e.title),
          h('div', { className: 'nw-mast-dek' }, [t('ev.indep', { n: e.source_count }) + (reposts ? '，' + t('rd.reposts', { n: reposts }) : ''), when(e.first_seen_at) + ' → ' + when(e.last_seen_at), e.credibility !== 'single' ? t('cred.' + e.credibility) : t('ev.single'), e.pushed ? t('txt.pushed') : ''].filter(Boolean).join(' · '))),
        h(NotesBox, { notes: e.notes, analyze: props.onAnalyze, phase: props.analyzePhase, model: props.model }),
        e.dispute ? h('div', { className: 'nw-callout nw-warnbox' }, h('b', null, t('head.dispute') + '（' + e.dispute.kind + '）'), ' ',
          e.dispute.values.map(function (v) { var o = (e.outlets || []).find(function (x) { return x.grp === v.outlet }); return shortName(o || { name: v.outlet }) + ' ' + v.value }).join(' / ')) : null,
        h('section', { className: 'nw-rail-box' }, h('h4', null, t('ev.reports', { n: members.length })),
          days.map(function (g) {
            return h('div', { key: g.day, className: 'nw-tl-day' },
              h('div', { className: 'nw-tl-dh' }, longDate(g.day + 'T12:00:00+08:00')),
              h('ol', { className: 'nw-tl2' }, g.list.map(function (m) {
                var tags = []
                if (m.article_id === firstId && indep.length > 1) tags.push(h('span', { key: 'f', className: 'nw-evtag nw-evtag-first' }, t('ev.first')))
                if (m.repost_of) tags.push(h('span', { key: 'r', className: 'nw-evtag' }, t('ev.repost')))
                if (m.views != null) tags.push(h('span', { key: 'v', className: 'nw-muted nw-xs' }, t('ev.views', { n: fmtN(m.views) })))
                return h('li', { key: m.article_id, className: 'nw-rs' + (m.repost_of ? ' nw-evd-repost' : '') },
                  h('span', { className: 'nw-tl2-t' }, (m.time_confidence === 'fetched' ? '~' : '') + hhmm(m.published_at || m.joined_at)),
                  h('span', { className: 'nw-tl2-body' },
                    h('span', { className: 'nw-tl2-src' }, shortName({ name: m.source_name, source_id: m.source_id })),
                    h('a', { className: 'nw-tl2-a', href: m.url, target: '_blank', rel: 'noopener noreferrer', title: m.title_zh ? m.title : undefined }, m.title_zh || m.title), ' ', tags,
                    m.title_zh ? h('div', { className: 'nw-tl2-orig' }, m.title) : null))
              })))
          })),
        h('button', { className: 'nw-more-btn', onClick: function () { setWhy(!why) } }, (why ? '▾ ' : '▸ ') + t('ev.why', { n: Math.round(e.importance) })),
        why ? h('div', { className: 'nw-detail-grid' },
          h(Section, { title: t('head.factors') }, FactorBars(e.factors)),
          h('div', null,
            h(Section, { title: t('head.trend') }, h(Spark, { values: (e.scores || []).map(function (s) { return s.importance }), label: t('head.trend') })),
            heat ? h(Section, { title: t('head.heat'), aside: h('span', { className: 'nw-muted' }, shortName((e.members || []).find(function (m) { return m.source_id === heat.source_id }) || { source_id: heat.source_id })) }, h(Spark, { values: heat.vals, format: fmtN, label: t('head.heat') })) : null)) : null,
        (e.pushes || []).length ? h('p', { className: 'nw-muted nw-xs' }, t('head.pushes') + '：' + e.pushes.map(function (p) { return when(p.pushed_at) + '（' + (t('sd.why.' + p.reason) !== 'sd.why.' + p.reason ? t('sd.why.' + p.reason) : p.reason) + '）' }).join('、')) : null)
    }

    /** 模型解读：发生了什么 / 为什么重要 / 接下来看；没有时给「生成解读」按钮（有模型才给）。 */
    function NotesBox(props) {
      var n = props.notes
      var m = props.model || {}
      var busy = props.phase === 'busy'
      var btn = props.analyze && m.ready ? h('button', { className: 'nw-btn nw-ghost nw-sm', disabled: busy || Boolean(m.busy), onClick: props.analyze }, busy ? t('txt.analyzing') : n ? t('btn.reanalyze') : t('btn.analyze')) : null
      var err = typeof props.phase === 'string' && props.phase.indexOf('error:') === 0 ? h('div', { className: 'nw-error' }, props.phase.slice(6)) : null
      if (!n) {
        if (!btn && !err) return null
        return h('div', { className: 'nw-notes nw-notes-empty' }, h('span', { className: 'nw-muted' }, m.ready ? t('txt.noNotes') : m.mode === 'economy' ? t('mode.economyDesc') : t('txt.noModel')), btn, err)
      }
      return h('div', { className: 'nw-notes' },
        h('div', { className: 'nw-notes-h' }, h('b', null, '✦ ' + t('head.notes')), btn),
        h('p', { className: 'nw-notes-sum' }, n.summary),
        n.why ? h('div', { className: 'nw-notes-row' }, h('span', { className: 'nw-notes-k' }, t('head.why')), h('span', null, n.why)) : null,
        n.watch ? h('div', { className: 'nw-notes-row' }, h('span', { className: 'nw-notes-k' }, t('head.next')), h('span', null, n.watch)) : null,
        h('div', { className: 'nw-muted nw-xs' }, (n.model ? t('txt.by', { m: n.model }) + ' · ' : '') + (n.at ? when(n.at) + ' · ' : '') + t('txt.notesHint')),
        err)
    }

    function EventDetail(props) {
      var dPair = useState({ phase: 'idle', ev: null })
      var d = dPair[0]
      var setD = dPair[1]
      var aPair = useState('idle')
      var aPhase = aPair[0]
      var setA = aPair[1]
      function analyze() {
        setA('busy')
        postJson(API.analyze, { id: props.id })
          .then(function (res) { setA('idle'); if (res && res.event) setD({ phase: 'ready', ev: res.event }) })
          .catch(function (e) { setA('error:' + ((e.data && e.data.error) || e.message)) })
      }
      useEffect(function () {
        if (!props.id) { setD({ phase: 'idle', ev: null }); return }
        setD({ phase: 'busy', ev: null })
        postJson(API.event, { id: props.id }).then(function (ev) { setD({ phase: 'ready', ev: ev }) }).catch(function (e) { setD({ phase: 'error', ev: null, error: e.message }) })
      }, [props.id])
      if (d.phase === 'busy') return Empty({ children: '…' })
      if (d.phase === 'error') return h('div', { className: 'nw-error' }, d.error)
      return h(EventDetailView, { ev: d.ev, names: props.names, onBack: props.onBack, onAnalyze: analyze, analyzePhase: aPhase, model: props.model })
    }

    // ------------------------------------------------------------------ 版面（分栏报纸式）
    /** 出处小标签：点开原文。refs 是文章 id，对应 story.materials。 */
    // ------------------------------------------------------------------ 阅读版面（读者优先）
    // 原则：正文只放读者要的东西——标题、谁报道、什么时候、导语、要点；分数、核对数、模型名一律收进页脚「关于本期」。
    // 出处用上标数字链到原文；操作（关注 / 屏蔽 / 报错）悬停才出现；各方说法、影响、全部来源折叠在「更多」里。
    function longDate(v) {
      var ms = toMs(v)
      if (!isFinite(ms)) return ''
      return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', { timeZone: TZ, month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(ms))
    }

    /** 出处：上标序号，链到对应原文。序号按该报道材料列表的顺序。 */
    function Refs(props) {
      var mats = props.mats || []
      var idx = (props.refs || []).map(function (id) { return mats.findIndex(function (m) { return m.id === id }) }).filter(function (i, k, a) { return i >= 0 && a.indexOf(i) === k }).sort(function (a, b) { return a - b })
      if (!idx.length) return null
      return h('sup', { className: 'nw-refs' }, idx.map(function (i) {
        var m = mats[i]
        return h('a', { key: m.id, className: 'nw-ref', href: m.url, target: '_blank', rel: 'noopener noreferrer', title: shortName({ name: m.name }) + ' ' + when(m.t) }, String(i + 1))
      }))
    }

    /** 「财联社等 3 家 · 05:46」，权威确认 / 存在分歧单独点出。 */
    function Byline(props) {
      var s = props.story
      var who = (s.outlets || []).map(shortName).filter(Boolean)
      var n = Math.max(s.source_count || 0, who.length)
      var parts = []
      if (who.length) parts.push(n > 1 ? t('rd.outlets', { w: who[0], n: n }) : who[0])
      var tm = when(s.published_at || s.first_seen_at)
      if (tm) parts.push(tm)
      if ((s.reposts || []).length) parts.push(t('rd.reposts', { n: s.reposts.length }))
      return h('span', { className: 'nw-byline', title: (s.reposts || []).length ? t('rd.repostsHint', { w: s.reposts.map(function (x) { return shortName(x) }).join('、') }) : undefined }, parts.join(' · '),
        s.credibility === 'confirmed' ? h('span', { className: 'nw-cred-ok' }, ' · ' + t('cred.confirmed')) : null,
        s.credibility === 'disputed' ? h('span', { className: 'nw-warn' }, ' · ' + t('cred.disputed')) : null)
    }

    // ------------------------------------------------------------------ 追踪
    var TK_KINDS = ['company', 'technology', 'person', 'theme']
    function MiniSpark(props) {
      var v = props.values || []
      var top = Math.max.apply(null, v.concat([1]))
      return h('span', { className: 'nw-tkspark', title: t('tk.sparkTip') }, v.map(function (x, i) { return h('span', { key: i, style: { height: Math.max(2, Math.round(18 * x / top)) + 'px' } }) }))
    }
    function TrackSynthesis(props) {
      var s = props.s
      return h('section', { className: 'nw-rail-box nw-analysis' },
        h('h4', null, t('tk.synth')),
        h('p', { className: 'nw-muted nw-xs' }, t('tk.synthMeta', { t: when(s.at), m: s.model || '', n: s.stories || 0 }) + (s.incremental ? ' · ' + t('tk.incremental') : '') + (s.dropped ? ' · ' + t('ia.dropped', { n: s.dropped }) : '') + ' · ' + t('ia.spec')),
        s.state ? h('p', { className: 'nw-rs-lead' }, s.state) : null,
        s.trend ? h('div', { className: 'nw-rs-block' }, h('div', { className: 'nw-rs-k' }, t('tk.trend')), h('p', { className: 'nw-rs-p nw-tktrend' }, s.trend)) : null,
        s.changed && s.changed !== '首次综述' ? h('div', { className: 'nw-rs-update' }, h('b', null, t('tk.changed')), s.changed) : null,
        (s.milestones || []).length ? [h('div', { key: 'k', className: 'nw-rs-k' }, t('tk.milestones')), h('ol', { key: 'm', className: 'nw-tkmiles' }, s.milestones.map(function (m, i) { return h('li', { key: i }, h('span', { className: 'nw-tl2-t' }, m.date), m.text) }))] : null,
        (s.implications || []).length ? [h('div', { key: 'k2', className: 'nw-rs-k' }, t('tk.implications')), h(ImpactList, { key: 'l', impacts: s.implications })] : null,
        (s.outlook || []).length ? [h('div', { key: 'k3', className: 'nw-rs-k' }, t('ia.scenarios')),
          h('ul', { key: 'o', className: 'nw-imp-list' }, s.outlook.map(function (x, i) { return h('li', { key: i }, h('span', { className: 'nw-scn nw-scn-' + ({ '高': 'hi', '中': 'mid', '低': 'lo' }[x.likelihood] || 'lo') }, x.likelihood), h('span', null, h('b', null, x.name), ' ', x.what, x.signals ? h('div', { className: 'nw-muted nw-xs' }, t('ia.signals') + x.signals) : null)) }))] : null,
        (s.watch || []).length ? [h('div', { key: 'k4', className: 'nw-rs-k' }, t('ia.watch')), h('ul', { key: 'w', className: 'nw-rs-points' }, s.watch.map(function (x, i) { return h('li', { key: i }, x) }))] : null)
    }
    function TrackDetail(props) {
      var dPair = useState({ d: null, busy: false, error: null })
      var st = dPair[0]
      var setSt = dPair[1]
      var load = useCallback(function () { return postJson(API.trackItem, { id: props.id }).then(function (d) { setSt({ d: d, busy: false, error: null }) }).catch(function (e) { setSt({ d: null, busy: false, error: e.message }) }) }, [props.id])
      useEffect(function () { load() }, [load])
      var d = st.d
      var back = h('button', { className: 'nw-act nw-back-link', onClick: props.onBack }, t('tk.back'))
      if (!d) return h('div', { className: 'nw-sd' }, back, st.error ? h('div', { className: 'nw-error' }, st.error) : Empty({ children: '…' }))
      function synth() {
        setIn(setSt, { busy: true, error: null })
        postJson(API.track, { action: 'synth', id: d.id }).then(function () { load() }).catch(function (e) { setIn(setSt, { busy: false, error: e.status === 409 ? t('ia.noModel') : e.message }) })
      }
      var days = []
      d.timeline.forEach(function (x) { var ms = toMs(x.first_at); var day = isFinite(ms) ? dayOf(ms) : ''; if (!days.length || days[days.length - 1].day !== day) days.push({ day: day, list: [] }); days[days.length - 1].list.push(x) })
      return h('div', { className: 'nw-sd nw-tkd' },
        h('div', { className: 'nw-mast-row' }, back,
          st.confirm ? h('span', { className: 'nw-tkconfirm' }, h('span', { className: 'nw-muted nw-xs' }, t('tk.confirm')),
            h('button', { className: 'nw-btn nw-sm nw-danger', onClick: function () { postJson(API.track, { action: 'remove', id: d.id }).then(props.onBack) } }, t('tk.delete')),
            h('button', { className: 'nw-act', onClick: function () { setIn(setSt, { confirm: false }) } }, t('btn.cancel')))
            : h('button', { className: 'nw-act', onClick: function () { setIn(setSt, { confirm: true }) } }, t('tk.delete'))),
        h('header', { className: 'nw-mast' },
          h('span', { className: 'nw-mast-date' }, t('tk.kind.' + d.kind) + (d.ticker ? ' · ' + d.ticker : '') + (d.aliases.length > 1 ? ' · ' + t('tk.aliases', { a: d.aliases.slice(1, 5).join('、') }) : '')),
          h('h1', { className: 'nw-mast-head' }, d.name),
          h('div', { className: 'nw-mast-dek' }, t('tk.dek', { n: d.timeline.length, t: when(d.created_at) }), ' ', h(MiniSpark, { values: d.spark }))),
        d.synthesis ? h(TrackSynthesis, { s: d.synthesis }) : h('p', { className: 'nw-muted' }, d.can_synth ? t('tk.noSynth') : t('tk.noSynthEconomy')),
        h('div', { className: 'nw-impact-acts' },
          d.can_synth ? h('button', { className: 'nw-btn nw-sm' + (d.fresh ? ' nw-primary' : ''), disabled: st.busy || Boolean(d.synthesis && !d.fresh), onClick: synth }, st.busy ? t('tk.synthBusy') : d.synthesis ? (d.fresh ? t('tk.resynth', { n: d.fresh }) : t('tk.upToDate')) : t('tk.synthNow')) : null,
          st.error ? h('span', { className: 'nw-error' }, st.error) : null),
        h('section', { className: 'nw-rail-box' }, h('h4', null, t('tk.timeline', { n: d.timeline.length })),
          !d.timeline.length ? h('p', { className: 'nw-muted' }, t('tk.empty')) : days.map(function (g) {
            return h('div', { key: g.day, className: 'nw-tl-day' }, h('div', { className: 'nw-tl-dh' }, longDate(g.day + 'T12:00:00+08:00')),
              h('ol', { className: 'nw-tl2' }, g.list.map(function (x) {
                return h('li', { key: x.id, className: 'nw-rs' }, h('span', { className: 'nw-tl2-t' }, hhmm(x.first_at)),
                  h('span', { className: 'nw-tl2-body' }, h('button', { className: 'nw-brief-link nw-tkstory', onClick: function () { props.onOpen(x.id) } }, h('b', null, x.title)), h('span', { className: 'nw-muted nw-xs' }, ' · ' + t('ask.reports', { n: x.n }) + (d.synthesis && x.updated_at > d.synthesis.at ? ' · ' + t('tk.new') : '')),
                    h('span', { className: 'nw-acts' }, h('button', { className: 'nw-act', onClick: function () { postJson(API.track, { action: 'unlink', id: d.id, story_id: x.id }).then(load) } }, t('tk.unlink'))),
                    x.update ? h('div', { className: 'nw-muted nw-xs' }, t('up.label') + '：' + x.update) : x.lead ? h('div', { className: 'nw-muted nw-xs nw-tklead' }, x.lead) : null))
              })))
          })))
    }
    function TrackTab(props) {
      var vPair = useState({ list: null, sug: [], can: false, error: null })
      var v = vPair[0]
      var setV = vPair[1]
      var sPair = useState(null)
      var sel = sPair[0]
      var setSel = sPair[1]
      var stPair = useState(null)
      var story = stPair[0]
      var setStory = stPair[1]
      var fPair = useState({ name: '', kind: 'company', ticker: '', note: '' })
      var form = fPair[0]
      var setForm = fPair[1]
      var load = useCallback(function () { return getJson(API.track).then(function (r) { setV({ list: r.trackers || [], sug: r.suggestions || [], can: Boolean(r.can_synth), error: null }) }).catch(function (e) { setV({ list: [], sug: [], can: false, error: e.message }) }) }, [])
      useEffect(function () { load() }, [load, props.stamp])
      function add(body) {
        setForm(Object.assign({}, form, { note: '…' }))
        return postJson(API.track, Object.assign({ action: 'add' }, body)).then(function (r) { setForm({ name: '', kind: form.kind, ticker: '', note: '' }); load(); setSel(r.id) }).catch(function (e) { setForm(Object.assign({}, form, { note: e.message })) })
      }
      if (story) return h('div', { className: 'nw-news' }, h(StoryDetail, { id: story, names: props.names, onBack: function () { setStory(null) } }))
      if (sel) return h(TrackDetail, { id: sel, onBack: function () { setSel(null); load() }, onOpen: setStory })
      if (!v.list) return Empty({ children: '…' })
      return h('div', { className: 'nw-tracking' },
        h('header', { className: 'nw-mast' }, h('h1', { className: 'nw-mast-head' }, t('tk.title')), h('div', { className: 'nw-mast-dek' }, t('tk.dekAll'))),
        v.sug.length ? h('section', { className: 'nw-rail-box' }, h('h4', null, t('tk.sug')),
          h('div', { className: 'nw-tksug' }, v.sug.map(function (x) {
            return h('button', { key: x.kind + x.name, className: 'nw-tksugbtn', title: x.kind === 'theme' ? t('tk.sugTheme', { n: x.stories }) : t('tk.sugEntity', { n: x.stories, r: x.recent }), onClick: function () { add(x.kind === 'theme' ? { name: x.name, kind: 'theme', stories: x.story_ids, origin: 'suggested' } : { name: x.name, kind: x.track_kind || 'company', aliases: x.track_kind === 'theme' ? [x.name] : undefined, origin: 'suggested' }) } },
              h('b', null, '+ ' + x.name), h('span', { className: 'nw-muted nw-xs' }, ' ' + (x.kind === 'theme' ? t('tk.theme') : t('tk.mentions', { n: x.stories })) + (x.rising ? ' ↑' : '')))
          }))) : null,
        h('div', { className: 'nw-tkadd' },
          h('input', { className: 'nw-in nw-fsearch', value: form.name, placeholder: t('tk.addPh'), onChange: function (e) { setForm(Object.assign({}, form, { name: e.target.value })) } }),
          h(Seg, { value: form.kind, onChange: function (k) { setForm(Object.assign({}, form, { kind: k })) }, options: TK_KINDS.map(function (k) { return [k, t('tk.kind.' + k)] }) }),
          form.kind === 'company' ? h('input', { className: 'nw-in nw-num', value: form.ticker, placeholder: t('tk.tickerPh'), onChange: function (e) { setForm(Object.assign({}, form, { ticker: e.target.value.toUpperCase() })) } }) : null,
          h('button', { className: 'nw-btn nw-primary nw-sm', disabled: !form.name.trim(), onClick: function () { add({ name: form.name.trim(), kind: form.kind, ticker: form.ticker || undefined }) } }, t('tk.add')),
          form.note ? h('span', { className: 'nw-muted nw-xs' }, form.note) : null),
        !v.list.length ? h('p', { className: 'nw-muted' }, t('tk.none')) : h('ul', { className: 'nw-tklist' }, v.list.map(function (x) {
          return h('li', { key: x.id }, h('button', { className: 'nw-tkcard', onClick: function () { setSel(x.id) } },
            h('div', { className: 'nw-tkhead' }, h('b', null, x.name), h('span', { className: 'nw-muted nw-xs' }, ' ' + t('tk.kind.' + x.kind) + (x.ticker ? ' · ' + x.ticker : '')), x.fresh && x.synthesis ? h('span', { className: 'nw-rs-tag nw-rs-dev' }, ' ' + t('tk.freshN', { n: x.fresh })) : null, h(MiniSpark, { values: x.spark })),
            x.synthesis && x.synthesis.state ? h('div', { className: 'nw-tkstate' }, x.synthesis.state) : h('div', { className: 'nw-muted nw-xs' }, v.can ? t('tk.pending') : ''),
            h('div', { className: 'nw-muted nw-xs' }, [t('tk.storiesN', { n: x.stories, w: x.week }), x.latest ? t('tk.latest', { t: x.latest.title }) : ''].filter(Boolean).join(' · '))))
        })),
        v.error ? h('div', { className: 'nw-error' }, v.error) : null)
    }

    // ------------------------------------------------------------------ 影响与走势
    var DIR = { '利好': ['▲', 'nw-up'], '利空': ['▼', 'nw-down'], '不确定': ['◆', 'nw-unk'] }
    function ImpactList(props) {
      return h('ul', { className: 'nw-imp-list' }, (props.impacts || []).map(function (x, i) {
        var d = DIR[x.direction] || DIR['不确定']
        return h('li', { key: i }, h('span', { className: 'nw-imp-dir ' + d[1], title: x.direction }, d[0]),
          h('span', null, h('b', null, x.target + (x.ticker ? '（' + x.ticker + '）' : '')), h('span', { className: 'nw-muted nw-xs' }, ' ' + x.area + (x.confidence ? ' · ' + t('ia.conf', { c: x.confidence }) : '')), h('br'), x.why))
      }))
    }
    function ImpactBlock(props) {
      var a = props.analysis
      if (props.busy) return h('div', { className: 'nw-impact' }, h('div', { className: 'nw-working' }, h('span', { className: 'nw-pulse' }), t('ia.busy')))
      if (props.error) return h('div', { className: 'nw-impact' }, h('span', { className: 'nw-error' }, props.error))
      if (!a) return null
      return h('div', { className: 'nw-impact' },
        h('div', { className: 'nw-impact-h' }, h('b', null, t('ia.title')), h('span', { className: 'nw-muted nw-xs' }, ' ' + t('ia.horizon', { h: a.horizon || '短期' }) + ' · ' + t('ia.spec'))),
        a.summary ? h('p', { className: 'nw-rs-p nw-impact-sum' }, a.summary) : null,
        h(ImpactList, { impacts: a.impacts }),
        h('div', { className: 'nw-impact-acts' },
          props.onOpen ? h('button', { className: 'nw-act', onClick: props.onOpen }, t('ia.more')) : null,
          props.onFollow && !props.followed ? h('button', { className: 'nw-act nw-on', onClick: props.onFollow }, '☆ ' + t('ia.follow')) : props.followed ? h('span', { className: 'nw-muted nw-xs' }, '★ ' + t('ia.following')) : null))
    }
    function AnalysisFull(props) {
      var a = props.analysis
      return h('section', { className: 'nw-rail-box nw-analysis' },
        h('h4', null, t('ia.title') + ' · ' + t('ia.horizon', { h: a.horizon || '短期' })),
        h('p', { className: 'nw-muted nw-xs' }, t('ia.disclaimer', { m: a.model || '', t: when(a.created_at) }) + (a.dropped ? ' ' + t('ia.dropped', { n: a.dropped }) : '')),
        a.summary ? h('p', { className: 'nw-rs-lead' }, a.summary) : null,
        (a.impacts || []).length ? [h('div', { key: 'k', className: 'nw-rs-k' }, t('ia.impacts')), h(ImpactList, { key: 'l', impacts: a.impacts })] : null,
        (a.scenarios || []).length ? [h('div', { key: 'k2', className: 'nw-rs-k' }, t('ia.scenarios')),
          h('ul', { key: 's', className: 'nw-imp-list' }, a.scenarios.map(function (x, i) {
            return h('li', { key: i }, h('span', { className: 'nw-scn nw-scn-' + ({ '高': 'hi', '中': 'mid', '低': 'lo' }[x.likelihood] || 'lo') }, x.likelihood), h('span', null, h('b', null, x.name), ' ', x.what, x.signals ? h('div', { className: 'nw-muted nw-xs' }, t('ia.signals') + x.signals) : null))
          }))] : null,
        (a.watch || []).length ? [h('div', { key: 'k3', className: 'nw-rs-k' }, t('ia.watch')), h('ul', { key: 'w', className: 'nw-rs-points' }, a.watch.map(function (x, i) { return h('li', { key: i }, x) }))] : null,
        a.newer ? h('p', { className: 'nw-note' }, t('ia.newer', { n: a.newer })) : null)
    }

    function ReadStory(props) {
      var s = props.story
      var xPair = useState(false)
      var more = xPair[0]
      var setMore = xPair[1]
      var rPair = useState(null)
      var rep = rPair[0]
      var setRep = rPair[1]
      if (!s) return null
      var v = props.variant || 'normal'
      var mats = s.materials || []
      var pt = function (x) { return typeof x === 'string' ? { text: x, refs: [] } : x }
      var points = (s.points || []).map(pt)
      var since = props.since
      var tag = since ? (since.new ? t('sn.new') : since.added ? t('rd.developing') : null)
        : props.hasSeen ? null : s.is_new ? t('ed.new') : s.updated ? t('rd.developing') : null
      var showUpdate = s.update_text && (s.updated || (since && since.added))
      function report(text) {
        postJson(API.feedback, { kind: 'error', story_id: s.id, edition_id: props.editionId, text: text, note: (rep && rep.note) || undefined })
          .then(function () { setRep({ note: '', done: true }); if (props.onChanged) props.onChanged() }).catch(function (e) { setRep({ note: '', error: e.message }) })
      }
      var sentences = [s.lead].concat(points.map(function (x) { return x.text }), (s.views || []).map(function (x) { return x.who + '：' + x.says }), s.impact ? [s.impact] : [], s.update_text ? [s.update_text] : []).filter(Boolean)
      var acts = props.onFollow ? h('span', { className: 'nw-acts' },
        h('button', { className: 'nw-act' + (props.followed ? ' nw-on' : ''), onClick: function () { props.onFollow(props.followed ? 'unfollow' : 'follow', 'story', s.id, s.title) } }, props.followed ? t('fl.following') : t('fl.follow')),
        h('button', { className: 'nw-act', onClick: function () { props.onFollow('mute', 'story', s.id, s.title) } }, t('fl.mute')),
        h('button', { className: 'nw-act', onClick: function () { setRep(rep ? null : { note: '' }) } }, t('fb.report'))) : null
      var repPanel = !rep ? null : h('div', { className: 'nw-report' },
        rep.done ? h('span', { className: 'nw-saved' }, rep.promo ? t('fb.promoDone') : t('fb.done')) : rep.error ? h('span', { className: 'nw-error' }, rep.error) : [
          h('div', { key: 'ad', className: 'nw-report-ad' }, h('button', { className: 'nw-mini', onClick: function () { postJson(API.feedback, { kind: 'promo', story_id: s.id }).then(function () { setRep({ note: '', done: true, promo: true }); if (props.onChanged) props.onChanged() }).catch(function (e) { setRep({ note: '', error: e.message }) }) } }, t('fb.promo')), h('span', { className: 'nw-muted nw-xs' }, ' ' + t('fb.promoHint'))),
          props.mode === 'llm' && s.by === 'llm' ? h('div', { key: 'h', className: 'nw-xs nw-muted' }, t('rd.reportHint')) : null,
          props.mode === 'llm' && s.by === 'llm' ? h('input', { key: 'n', className: 'nw-in', placeholder: t('fb.note'), value: rep.note || '', onChange: function (e) { setRep({ note: e.target.value }) } }) : null,
          props.mode === 'llm' && s.by === 'llm' ? h('ul', { key: 'l' }, sentences.map(function (x, i) { return h('li', { key: i }, h('button', { className: 'nw-mini', onClick: function () { report(x) } }, t('fb.wrong')), ' ', x) })) : null],
        h('button', { className: 'nw-mini', onClick: function () { setRep(null) } }, t('fb.cancel')))
      var lead = s.lead ? h('p', { className: 'nw-rs-lead' }, s.lead,
        v === 'brief' ? null : h(Refs, { refs: s.lead_refs, mats: mats }),
        (s.lead_missing || []).length ? h('span', { className: 'nw-unver', title: t('ck.missing', { m: s.lead_missing.join('、') }) }, t('ck.unverified')) : null) : null
      var nPts = v === 'lead' ? points.length : v === 'normal' ? Math.min(points.length, 4) : 0
      var extra = (s.views || []).length || s.impact || mats.length || points.length > nPts
      var allOpen = v === 'lead' || more
      var body = v === 'brief' || v === 'second' ? null : [
        nPts ? h('ul', { key: 'p', className: 'nw-rs-points' }, points.slice(0, allOpen ? points.length : nPts).map(function (p, i) { return h('li', { key: i }, p.text, h(Refs, { refs: p.refs, mats: mats })) })) : null,
        allOpen && (s.views || []).length ? h('div', { key: 'v', className: 'nw-rs-block' }, h('div', { className: 'nw-rs-k' }, t('ed.views')),
          h('ul', { className: 'nw-rs-views' }, s.views.map(function (x, i) { return h('li', { key: i }, h('b', null, x.who), '　' + x.says, h(Refs, { refs: x.refs, mats: mats })) }))) : null,
        allOpen && s.impact ? h('div', { key: 'i', className: 'nw-rs-block' }, h('div', { className: 'nw-rs-k' }, t('ed.impact')), h('p', { className: 'nw-rs-p' }, s.impact)) : null,
        allOpen && mats.length ? h('ol', { key: 's', className: 'nw-rs-src' }, mats.map(function (m) { return h('li', { key: m.id }, h('a', { className: 'nw-link', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, shortName({ name: m.name })), h('span', { className: 'nw-muted' }, ' ' + hhmm(m.t))) })) : null,
        allOpen && !mats.length && s.url ? h('a', { key: 'o', className: 'nw-link nw-xs', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, t('ed.original') + ' ↗') : null,
        v === 'normal' && extra ? h('button', { key: 'm', className: 'nw-more-btn', onClick: function () { setMore(!more) } }, more ? t('rd.less') : t('rd.more')) : null]
      return h('article', { id: 'nw-s-' + s.id, className: 'nw-rs nw-v-' + v },
        h('div', { className: 'nw-rs-head' },
          tag ? h('span', { className: 'nw-rs-tag' + (tag === t('rd.developing') ? ' nw-rs-dev' : '') }, tag) : null,
          (s.followed || []).length ? h('span', { className: 'nw-rs-star', title: s.followed.join('、') }, '★') : null,
          h('button', { className: 'nw-rs-title', onClick: function () { props.onOpen(s.id) } }, s.title)),
        h('div', { className: 'nw-rs-meta' }, h(Byline, { story: s }), acts),
        repPanel,
        showUpdate ? h('div', { className: 'nw-rs-update' }, h('b', null, t('up.label')), s.update_text) : null,
        lead,
        body,
        (v === 'lead' || v === 'normal' || v === 'second') && (props.analysis || props.analyzing || props.analyzeError) ? h(ImpactBlock, { analysis: props.analysis, busy: props.analyzing, error: props.analyzeError, followed: props.followed || (s.followed || []).length > 0, onOpen: function () { props.onOpen(s.id) }, onFollow: props.onFollow ? function () { props.onFollow('follow', 'story', s.id, s.title) } : null })
          : (v === 'lead' || v === 'normal') && props.canAnalyze && s.importance >= 50 ? h('button', { className: 'nw-more-btn nw-analyze-btn', onClick: function () { props.onAnalyze(s.id) } }, '◇ ' + t('ia.run')) : null)
    }

    /** 侧栏的一个小清单（值得关注 / 待核实）。 */
    function NoteList(props) {
      if (!props.items || !props.items.length) return null
      return h('section', { className: 'nw-rail-box' + (props.tone ? ' nw-rail-' + props.tone : '') },
        h('h4', null, props.title),
        h('ul', null, props.items.map(function (w, i) {
          var id = w.stories && w.stories[0]
          var ok = id && props.stories[id]
          return h('li', { key: i }, ok ? h('button', { className: 'nw-brief-link', onClick: function () { props.onOpen(id) } }, w.text) : w.text)
        })))
    }

    function jumpTo(id) {
      var el = document.getElementById('nw-s-' + id)
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    // ------------------------------------------------------------------ 首次使用
    var ONBOARD_TOPICS = ['politics', 'macro', 'markets', 'industry', 'tech', 'society']
    function Welcome(props) {
      var sPair = useState({ step: 'pick', off: {}, kw: '', study: false, cadence: 'every2h', t0: 0, error: null })
      var st = sPair[0]
      var setSt = sPair[1]
      var tick = useState(0)
      useEffect(function () {
        if (st.step !== 'fetching') return
        var timer = setInterval(function () { tick[1](function (n) { return n + 1 }) }, 1000)
        return function () { clearInterval(timer) }
      }, [st.step])
      function start() {
        var body = { mute_topics: ONBOARD_TOPICS.filter(function (k) { return st.off[k] }), keywords: st.kw.split(/[，,、\s]+/).filter(Boolean), study: st.study, cadence: st.cadence }
        setIn(setSt, { step: 'fetching', t0: Date.now(), error: null })
        postJson(API.onboard, body)
          .then(function () { return postJson(API.run, {}) })
          .then(function () { setIn(setSt, { step: 'done' }); if (props.onDone) props.onDone() })
          .catch(function (e) { setIn(setSt, { step: 'pick', error: e.status === 409 ? t('wl.busy') : e.message }) })
      }
      var names = props.names || {}
      if (st.step === 'fetching') {
        var sec = Math.round((Date.now() - st.t0) / 1000)
        return h('section', { className: 'nw-welcome' },
          h('h1', { className: 'nw-mast-head' }, t('wl.fetchingH')),
          h('div', { className: 'nw-working' }, h('span', { className: 'nw-pulse' }), t('wl.fetching', { s: Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') })),
          h('ol', { className: 'nw-wl-steps' }, [t('wl.s1'), t('wl.s2'), t('wl.s3')].map(function (x, i) { return h('li', { key: i }, x) })))
      }
      return h('section', { className: 'nw-welcome' },
        h('h1', { className: 'nw-mast-head' }, t('wl.title')),
        h('p', { className: 'nw-mast-dek' }, t('wl.dek')),
        h('div', { className: 'nw-wl-block' }, h('h4', null, t('wl.topics')),
          h('div', { className: 'nw-wl-topics' }, ONBOARD_TOPICS.map(function (k) {
            var on = !st.off[k]
            return h('label', { key: k, className: 'nw-ps-opt' + (on ? ' nw-on' : '') }, h('input', { type: 'checkbox', checked: on, onChange: function () { var o = Object.assign({}, st.off); o[k] = on; setIn(setSt, { off: o }) } }), names[k] || k)
          }), h('label', { className: 'nw-ps-opt' + (st.study ? ' nw-on' : '') }, h('input', { type: 'checkbox', checked: st.study, onChange: function () { setIn(setSt, { study: !st.study }) } }), t('wl.study'))),
          h('p', { className: 'nw-muted nw-xs' }, t('wl.topicsHint'))),
        h('div', { className: 'nw-wl-block' }, h('h4', null, t('wl.follow')),
          h('input', { className: 'nw-in nw-wl-kw', value: st.kw, placeholder: t('wl.followPh'), onChange: function (e) { setIn(setSt, { kw: e.target.value }) } })),
        h('div', { className: 'nw-wl-block' }, h('h4', null, t('wl.push')),
          h(Seg, { value: st.cadence, onChange: function (v) { setIn(setSt, { cadence: v }) }, options: [['every2h', t('wl.c2h')], ['thrice', t('wl.c3')], ['daily_only', t('wl.cDaily')]] }),
          h('p', { className: 'nw-muted nw-xs' }, t('wl.pushHint'))),
        st.error ? h('div', { className: 'nw-error' }, st.error) : null,
        h('div', null, h('button', { className: 'nw-btn nw-primary', onClick: start }, t('wl.start'))))
    }

    // ------------------------------------------------------------------ 问新闻
    function AskView(props) {
      var r = props.res
      var a = props.ans
      if (!r) return null
      return h('section', { className: 'nw-ask' },
        h('div', { className: 'nw-mast-row' }, h('span', { className: 'nw-mast-date' }, t('ask.for', { q: r.q }) + ' · ' + t('ask.found', { n: r.total || 0, h: r.hours })),
          h('span', null, (r.terms || []).length ? h('button', { className: 'nw-act', onClick: function (ev) { var b = ev.currentTarget; postJson(API.track, { action: 'add', name: r.terms[0], kind: 'company', aliases: r.terms.slice(1), origin: 'search' }).then(function () { b.textContent = '✓ ' + t('tk.trackIt') + '：' + r.terms[0] }) } }, '◎ ' + t('ask.track')) : null,
            h('button', { className: 'nw-act', onClick: props.onClose }, t('ask.close')))),
        r.can_answer ? h('div', { className: 'nw-ask-ans' },
          h('h4', null, t('ask.answer')),
          !a ? h('div', { className: 'nw-working' }, h('span', { className: 'nw-pulse' }), t('ask.reading', { n: Math.min((r.items || []).length, 14) }))
            : a.error ? h('div', { className: 'nw-error' }, a.error)
            : !a.answer.length ? h('p', { className: 'nw-muted' }, t('ask.notEnough'))
            : [h('div', { key: 'p', className: 'nw-ask-p' }, a.answer.map(function (s, i) {
                return h('span', { key: i }, s.text, s.refs.length ? h('sup', { className: 'nw-refs' }, s.refs.map(function (k) { var m = a.materials[k]; return m ? h('a', { key: k, className: 'nw-ref', href: m.url, target: '_blank', rel: 'noopener noreferrer', title: m.source + ' ' + when(m.t) + ' ' + m.title }, String(k + 1)) : null })) : null)
              })),
              h('div', { key: 'f', className: 'nw-muted nw-xs' }, t('ask.by', { m: a.model || '' }) + (a.dropped ? ' · ' + t('ask.dropped', { n: a.dropped }) : '') + (a.enough ? '' : ' · ' + t('ask.partial'))),
              h('ol', { key: 'm', className: 'nw-rs-src' }, a.materials.map(function (m, i) { return h('li', { key: i }, h('a', { className: 'nw-link', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, m.title), h('span', { className: 'nw-muted' }, ' · ' + m.source + ' ' + when(m.t))) }))]) : null,
        (r.stories || []).length ? h('div', { className: 'nw-rail-box' }, h('h4', null, t('ask.stories')),
          h('ul', null, r.stories.map(function (s) { return h('li', { key: s.id }, h('button', { className: 'nw-brief-link', onClick: function () { props.onOpen(s.id) } }, h('b', null, s.title), h('span', { className: 'nw-muted nw-xs' }, ' · ' + t('ask.reports', { n: s.n }) + ' · ' + when(s.latest))), s.lead ? h('div', { className: 'nw-muted nw-xs' }, s.lead) : null) }))) : null,
        (r.items || []).length ? h('div', { className: 'nw-rail-box' }, h('h4', null, t('ask.items')),
          h('ul', null, r.items.map(function (x) { return h('li', { key: x.id }, h('a', { className: 'nw-tl2-a', href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.original || undefined }, x.title), h('span', { className: 'nw-muted nw-xs' }, ' · ' + x.source + ' ' + when(x.t))) }))) : Empty({ children: t('ask.none', { t: (r.terms || []).join('、') || r.q }) }))
    }

    function EditionView(props) {
      var ePair = useState({ phase: 'idle', ed: null, model: null, error: null, busy: false })
      var e = ePair[0]
      var setE = ePair[1]
      var pack = props.pack || 'all'
      var fPair = useState(null)
      var follows = fPair[0]
      var setFollows = fPair[1]
      var nPair = useState('')
      var flNote = nPair[0]
      var setFlNote = nPair[1]
      useEffect(function () { getJson(API.follows).then(setFollows).catch(function () {}) }, [props.stamp])
      function onFollow(action, kind, value, name) {
        postJson(API.follows, { action: action, kind: kind, value: value, name: name }).then(function (f) { setFollows(f); setFlNote(action === 'mute' ? t('fl.muted') : t('fl.saved')) }).catch(function (e) { setFlNote(e.message) })
      }
      var followedStory = function (id) { return Boolean(follows && follows.follow.some(function (x) { return x.kind === 'story' && x.value === id })) }
      // 「自上次查看」：每次打开版面（换包时也算）只标记一次，这次看到的变化在本次保留
      var sPair = useState(null)
      var since = sPair[0]
      var setSince = sPair[1]
      var markRef = React.useRef ? React.useRef({}) : { current: {} }
      var anPair = useState({})
      var ana = anPair[0]
      var setAna = anPair[1]
      var hPair = useState({ list: [], id: null })
      var hist = hPair[0]
      var setHist = hPair[1]
      useEffect(function () { postJson(API.editions, { pack: pack, limit: 40 }).then(function (r) { setIn(setHist, { list: r.editions || [] }) }).catch(function () {}) }, [pack, props.stamp])
      // 问新闻：先出搜索结果，模型可用时再作答
      var qPair = useState({ text: '', res: null, ans: null })
      var ask = qPair[0]
      var setAsk = qPair[1]
      function runAsk(ev) {
        if (ev && ev.preventDefault) ev.preventDefault()
        var q = ask.text.trim()
        if (!q) return
        setAsk({ text: q, res: { q: q, hours: 72, items: [], stories: [], total: 0 }, ans: null })
        postJson(API.ask, { q: q }).then(function (r) {
          setAsk(function (x) { return Object.assign({}, x, { res: r }) })
          if (r.can_answer && (r.items || []).length) postJson(API.ask, { q: q, answer: true }).then(function (a) { setAsk(function (x) { return x.res && x.res.q === q ? Object.assign({}, x, { ans: a }) : x }) }).catch(function (e) { setAsk(function (x) { return Object.assign({}, x, { ans: { error: e.message, answer: [] } }) }) })
        }).catch(function (e) { setAsk(function (x) { return Object.assign({}, x, { res: null, ans: null }) }) })
      }
      var askBox = h('form', { className: 'nw-askbox', onSubmit: runAsk }, h('input', { className: 'nw-in', type: 'search', value: ask.text, placeholder: t('ask.ph'), onChange: function (e) { var v = e.target.value; setAsk(function (x) { return Object.assign({}, x, { text: v }) }) } }))
      var load = useCallback(function () {
        var mark = !markRef.current[pack]
        markRef.current[pack] = true
        return postJson(API.edition, { pack: pack, mark_seen: mark, id: hist.id || undefined }).then(function (res) {
          if (mark) setSince(res.since || null)
          setE({ phase: 'ready', ed: res.edition || null, model: res.model || null, error: null, busy: Boolean(res.model && res.model.busy) && !/^analyze:/.test(String(res.model.busy)), analyses: res.analyses || {}, canAnalyze: Boolean(res.can_analyze) })
          return res
        }).catch(function (err) { setE({ phase: 'ready', ed: null, model: null, error: err.message, busy: false }) })
      }, [pack, hist.id])
      useEffect(function () { setIn(setE, { phase: 'busy' }); load() }, [load, props.stamp])
      // 模型编排在后台进行：忙时每 5 秒看一次，完成即刷新
      useEffect(function () {
        if (!e.busy) return
        var timer = setInterval(function () { load() }, 5000)
        return function () { clearInterval(timer) }
      }, [e.busy, load])
      function redo() {
        setIn(setE, { busy: true, error: null })
        postJson(API.edition, { pack: pack, refresh: true }).then(function (res) {
          if (res && res.started) setIn(setE, { busy: true, model: res.model })
          else setE({ phase: 'ready', ed: res.edition || null, model: res.model || null, error: null, busy: false })
        }).catch(function (err) { setIn(setE, { busy: Boolean(err.status === 409), error: err.status === 409 ? null : err.message }) })
      }
      var ed = e.ed
      var c = ed && ed.content
      var notes = []
      if (hist.id && ed) notes.push(h('div', { key: 'h', className: 'nw-callout nw-warnbox' }, t('hs.viewing', { t: when(ed.created_at) }), ' ', h('button', { className: 'nw-mini', onClick: function () { setIn(setHist, { id: null }) } }, t('hs.latest'))))
      var cs = (c && c.stats) || {}
      if (e.busy || (!hist.id && (cs.preview || cs.partial))) notes.push(h('div', { key: 'b', className: 'nw-working' }, h('span', { className: 'nw-pulse' }), cs.partial ? t('ed.partial', { w: cs.written || 0, n: cs.to_write || 0 }) : cs.preview ? t('ed.preview') : t('ed.busy')))
      if (flNote) notes.push(h('div', { key: 'fl', className: 'nw-note' }, flNote))
      if (e.error) notes.push(h('div', { key: 'e', className: 'nw-error' }, e.error))
      if (ed && ed.mode === 'rules' && ed.error) notes.push(h('div', { key: 'f', className: 'nw-note' }, t('ed.fellBack', { e: ed.error })))
      if (e.phase === 'busy' && !ed) return h('div', { className: 'nw-edition' }, Empty({ children: '…' }))
      if (!c && props.firstRun) return h('div', { className: 'nw-edition' }, h(Welcome, { names: props.names, onDone: function () { load(); if (props.onReload) props.onReload() } }))
      if (!c) return h('div', { className: 'nw-edition' }, notes, Empty({ children: t('ed.none') }), h('div', null, h('button', { className: 'nw-btn nw-ghost nw-sm', disabled: e.busy, onClick: redo }, t('ed.redo'))))
      var st = c.stories || {}
      var open = props.onOpen
      var sn = (since && since.stories) || {}
      var hasSeen = Boolean(since && since.at)
      // 我的关注放在最上面（有才显示）；关注的不在头版和各版块重复
      var folSec = (c.sections || []).find(function (sec) { return sec.id === 'following' })
      var folIds = folSec ? folSec.stories.filter(function (id) { return st[id] }) : []
      var inFol = {}
      folIds.forEach(function (id) { inFol[id] = true })
      var front = (c.front || []).filter(function (id) { return st[id] && !inFol[id] })
      var inFront = {}
      front.forEach(function (id) { inFront[id] = true })
      // 头版已经登过的不在下面各版再出现
      var sections = (c.sections || []).filter(function (sec) { return sec.id !== 'following' }).map(function (sec) { return Object.assign({}, sec, { stories: sec.stories.filter(function (id) { return st[id] && !inFront[id] && !inFol[id] }) }) }).filter(function (sec) { return sec.stories.length })
      var outlets = {}
      Object.keys(st).forEach(function (id) { (st[id].outlets || []).forEach(function (o) { outlets[shortName(o)] = 1 }) })
      var nStories = Object.keys(st).length
      var snIds = Object.keys(sn).filter(function (id) { return st[id] })
      var snNew = snIds.filter(function (id) { return sn[id].new })
      var snDev = snIds.filter(function (id) { return !sn[id].new && sn[id].added })
      function analyze(id) {
        setAna(function (m) { var n = Object.assign({}, m); n[id] = { busy: true }; return n })
        postJson(API.storyAnalyze, { story_id: id }).then(function (r) { setAna(function (m) { var n = Object.assign({}, m); n[id] = { a: r.analysis }; return n }) })
          .catch(function (err) { setAna(function (m) { var n = Object.assign({}, m); n[id] = { error: err.status === 409 ? t('ia.noModel') : err.message }; return n }) })
      }
      var common = { names: props.names, mode: ed.mode, editionId: ed.id, onChanged: function () { load() }, onOpen: open, onFollow: onFollow, hasSeen: hasSeen, canAnalyze: Boolean(e.canAnalyze), onAnalyze: analyze }
      var story = function (id, variant) { var x = ana[id] || {}; return h(ReadStory, Object.assign({ key: id, story: st[id], variant: variant, since: sn[id], followed: followedStory(id), analysis: x.a || (e.analyses || {})[id], analyzing: x.busy, analyzeError: x.error }, common)) }
      var packs = props.packs || {}
      var packKeys = Object.keys(packs)

      var masthead = h('header', { className: 'nw-mast' },
        h('div', { className: 'nw-mast-row' },
          h('span', { className: 'nw-mast-date' }, longDate(ed.created_at) + ' · ' + t('rd.asof', { t: hhmm(ed.created_at) })),
          askBox,
          packKeys.length > 1 && props.onPack ? h('select', { className: 'nw-in nw-mast-pack', value: props.pack || '', 'aria-label': t('rd.pack'), onChange: function (ev) { props.onPack(ev.target.value) } },
            [h('option', { key: '', value: '' }, t('rd.allPacks'))].concat(packKeys.map(function (k) { return h('option', { key: k, value: k }, (packs[k] && packs[k].title) || k) }))) : null),
        c.headline ? h('h1', { className: 'nw-mast-head' }, c.headline) : null,
        h('div', { className: 'nw-mast-dek' }, t('rd.dek', { h: Math.round(c.hours || 12), n: nStories, o: Object.keys(outlets).length })))

      var sinceBox = !snIds.length ? null : h('section', { className: 'nw-since' },
        h('div', { className: 'nw-since-h' }, t('rd.sinceH', { t: when(since.at) }), h('span', { className: 'nw-muted' }, ' ' + [snNew.length ? t('rd.sinceNew', { n: snNew.length }) : '', snDev.length ? t('rd.sinceDev', { n: snDev.length }) : ''].filter(Boolean).join('，'))),
        h('ul', null, snNew.concat(snDev).sort(function (a, b) { return st[b].importance - st[a].importance }).slice(0, 5).map(function (id) {
          var x = st[id]
          return h('li', { key: id }, h('button', { className: 'nw-brief-link', onClick: function () { jumpTo(id) } },
            h('span', { className: 'nw-rs-tag' + (sn[id].new ? '' : ' nw-rs-dev') }, sn[id].new ? t('sn.new') : t('rd.developing')), x.title,
            x.update_text && !sn[id].new ? h('span', { className: 'nw-muted' }, ' — ' + x.update_text) : null))
        })))

      var folEl = !folIds.length ? null : h('section', { className: 'nw-sec nw-sec-fol nw-fol-top' },
        h('h2', { className: 'nw-sec-h' }, '★ ' + t('fl.section'), h('span', { className: 'nw-muted nw-xs' }, '  ' + t('fl.topHint', { n: folIds.length }))),
        folIds.map(function (id, i) { return story(id, i < 3 ? 'normal' : 'brief') }))

      var frontEl = !front.length ? null : h('section', { className: 'nw-front' },
        story(front[0], 'lead'),
        front.length > 1 ? h('div', { className: 'nw-front-2' }, front.slice(1).map(function (id) { return story(id, 'second') })) : null)

      var body = h('div', { className: 'nw-sections' }, sections.map(function (sec) {
        var fol = sec.id === 'following'
        return h('section', { key: sec.id, className: 'nw-sec' + (fol ? ' nw-sec-fol' : '') },
          h('h2', { className: 'nw-sec-h' }, fol ? '★ ' + t('fl.section') : sec.name),
          // 关注版块条目多且常常是同一话题：只放标题和导语
          sec.stories.map(function (id) { var x = st[id]; return story(id, fol || (ed.mode === 'llm' && x.by !== 'llm') ? 'brief' : 'normal') }))
      }))

      var about = h('section', { className: 'nw-rail-box nw-about' },
        h('h4', null, t('rd.about')),
        h('p', null, ed.mode === 'llm' ? t('rd.byModel', { m: ed.model || '' }) : t('rd.byRules')),
        h('p', null, t('rd.read', { n: c.items_read || 0, h: Math.round(c.hours || 12) }) + (c.stats && c.stats.check && c.stats.check.checked ? t('rd.checked', { p: c.stats.check.passed, n: c.stats.check.checked }) : '')),
        h('p', { className: 'nw-muted' }, ed.mode === 'llm' ? t('ed.hintLlm') : t('ed.hintRules')),
        h('div', { className: 'nw-about-acts' },
          hist.list.length > 1 ? h('select', { className: 'nw-in nw-hist', value: hist.id || '', 'aria-label': t('rd.past'), onChange: function (ev) { setIn(setHist, { id: ev.target.value ? Number(ev.target.value) : null }) } },
            [h('option', { key: '', value: '' }, t('hs.latest'))].concat(hist.list.slice(1).map(function (x) { return h('option', { key: x.id, value: x.id }, when(x.created_at) + ' · ' + String(x.headline || '').slice(0, 20)) }))) : null,
          h('button', { className: 'nw-btn nw-ghost nw-sm', disabled: e.busy || Boolean(hist.id), onClick: redo }, e.busy ? '…' : t('ed.redo'))))

      var skimSecs = (folIds.length ? [{ id: 'following', name: '', stories: folIds }] : []).concat(sections)
      var skim = skimSecs.length ? h('nav', { className: 'nw-rail-box nw-skim', 'aria-label': t('rd.skim') },
        h('h4', null, t('rd.skim')),
        skimSecs.map(function (sec) {
          return h('div', { key: sec.id, className: 'nw-skim-sec' },
            h('div', { className: 'nw-skim-h' }, sec.id === 'following' ? '★ ' + t('fl.section') : sec.name),
            h('ul', null, sec.stories.map(function (id) { return h('li', { key: id }, h('button', { className: 'nw-brief-link', onClick: function () { jumpTo(id) } }, st[id].title)) })))
        })) : null

      if (ask.res) return h('div', { className: 'nw-edition' }, masthead, h(AskView, { res: ask.res, ans: ask.ans, onOpen: open, onClose: function () { setAsk({ text: '', res: null, ans: null }) } }))
      return h('div', { className: 'nw-edition' }, notes, masthead, sinceBox,
        !front.length && !sections.length ? Empty({ children: t('ed.noStories') }) : null,
        h('div', { className: 'nw-read' },
          h('div', { className: 'nw-read-main' }, folEl, frontEl, body),
          h('aside', { className: 'nw-rail' },
            (c.tickers || []).length ? h('section', { className: 'nw-rail-box nw-ticks' }, h('h4', null, t('rd.ticks')),
              h('ul', null, c.tickers.map(function (x) { return h('li', { key: x.instrument }, h('a', { className: 'nw-tick', href: x.url, target: '_blank', rel: 'noopener noreferrer', title: x.source }, h('b', null, x.instrument), h('span', null, x.rest || x.text), h('time', null, hhmm(x.t)))) }))) : null,
            h(NoteList, { title: t('head.watch'), items: c.watch, stories: st, onOpen: open }),
            h(NoteList, { title: t('head.verify'), items: c.verify, stories: st, onOpen: open, tone: 'warn' }),
            skim, about)),
        h('div', { className: 'nw-foot' }, t('txt.disclaimer')))
    }

    /** 主题分布：当前列表里各一级主题的事件数与最高重要度；点一下筛选，再点取消。 */
    function Topics(props) {
      var by = {}
      ;(props.events || []).forEach(function (e) {
        var seen = {}
        ;(e.labels || []).forEach(function (l) {
          var top = String(l).split('.')[0]
          if (seen[top]) return
          seen[top] = true
          var x = (by[top] = by[top] || { id: top, n: 0, max: 0, hot: 0 })
          x.n += 1
          x.max = Math.max(x.max, e.importance || 0)
          if ((e.importance || 0) >= 50) x.hot += 1
        })
      })
      var rows = Object.keys(by).map(function (k) { return by[k] }).sort(function (a, b) { return b.hot - a.hot || b.n - a.n })
      if (rows.length < 2 && !props.active) return null
      var maxN = Math.max.apply(null, rows.map(function (r) { return r.n }).concat([1]))
      return h('div', { className: 'nw-topics', title: t('txt.topicHint') }, rows.slice(0, 10).map(function (r) {
        var on = props.active === r.id || String(props.active || '').indexOf(r.id + '.') === 0
        return h('button', { key: r.id, className: 'nw-topic' + (on ? ' nw-on' : ''), onClick: function () { props.onPick(on ? '' : r.id) } },
          h('span', { className: 'nw-topic-name' }, (props.names && props.names[r.id]) || r.id),
          h('span', { className: 'nw-topic-track' }, h('span', { className: 'nw-topic-fill nw-imp-' + impTone(r.max), style: { width: Math.max(6, Math.round(r.n / maxN * 100)) + '%' } })),
          h('span', { className: 'nw-topic-n', title: t('txt.events', { n: r.n }) }, String(r.n) + (r.hot ? ' · ' + t('txt.hotN', { n: r.hot }) : '')))
      }))
    }

    // ------------------------------------------------------------------ 故事线详情
    function StoryDetail(props) {
      var dPair = useState({ phase: 'busy', st: null, error: null })
      var d = dPair[0]
      var setD = dPair[1]
      useEffect(function () {
        setD({ phase: 'busy', st: null, error: null })
        postJson(API.story, { id: props.id }).then(function (st) { setD({ phase: 'ready', st: st, error: null }) }).catch(function (e) { setD({ phase: 'error', st: null, error: e.message }) })
      }, [props.id])
      var mvPair = useState({})
      var moved = mvPair[0]
      var setMoved = mvPair[1]
      function misplace(aid) {
        postJson(API.feedback, { kind: 'misplaced', story_id: props.id, article_id: aid }).then(function () { setMoved(function (m) { var n = Object.assign({}, m); n[aid] = true; return n }) }).catch(function () {})
      }
      var back = h('button', { className: 'nw-act nw-back-link', onClick: props.onBack }, t('sd.back'))
      if (d.phase === 'busy') return h('div', { className: 'nw-sd' }, back, Empty({ children: '…' }))
      if (!d.st) return h('div', { className: 'nw-sd' }, back, h('div', { className: 'nw-error' }, d.error || 'not found'))
      var st = d.st
      var mats = st.items.map(function (it) { return { id: it.id, name: it.source_name || it.source_id, url: it.url, t: it.published_at || it.first_seen_at } })
      // 时间轴：报道、进展、推送按时间合在一起，按天分组
      var ev = st.items.map(function (it) { return { k: 'i', t: it.published_at || it.first_seen_at, it: it } })
        .concat(st.updates.map(function (u) { return { k: 'u', t: u.at, u: u } }), st.pushes.map(function (x) { return { k: 'p', t: x.pushed_at, p: x } }))
        .sort(function (a, b) { return String(a.t).localeCompare(String(b.t)) })
      var days = []
      ev.forEach(function (x) { var ms = toMs(x.t); var day = isFinite(ms) ? dayOf(ms) : ''; if (!days.length || days[days.length - 1].day !== day) days.push({ day: day, ev: [] }); days[days.length - 1].ev.push(x) })
      var outlets = {}
      st.items.forEach(function (it) { outlets[it.source_name || it.source_id] = 1 })
      var c = st.copy
      var pt = function (x) { return typeof x === 'string' ? { text: x, refs: [] } : x }
      return h('div', { className: 'nw-sd' },
        h('div', { className: 'nw-mast-row' }, back,
          props.onFollow ? h('button', { className: 'nw-act' + (props.followed ? ' nw-on' : ''), onClick: function () { props.onFollow(props.followed ? 'unfollow' : 'follow', 'story', st.id, st.title) } }, props.followed ? t('fl.following') : t('fl.follow')) : null),
        h('header', { className: 'nw-mast' },
          h('span', { className: 'nw-mast-date' }, (props.names && props.names[st.section]) || st.section),
          h('h1', { className: 'nw-mast-head' }, st.title),
          h('div', { className: 'nw-mast-dek' }, t('sd.dek', { n: st.items.length, o: Object.keys(outlets).length, t: when(st.created_at) }) + (st.merged.length ? ' · ' + t('sd.merged', { t: st.merged.map(function (x) { return x.title }).join('、') }) : ''))),
        (st.entities || []).length ? h('div', { className: 'nw-tkents' }, h('span', { className: 'nw-muted nw-xs' }, t('sd.entities') + '：'), st.entities.map(function (x) {
          return x.tracker ? h('span', { key: x.name, className: 'nw-evtag nw-evtag-first' }, '◎ ' + x.name)
            : h('button', { key: x.name, className: 'nw-act', onClick: function () { postJson(API.track, { action: 'add', name: x.name, kind: 'company', origin: 'story' }).then(function (r) { setD(function (y) { return Object.assign({}, y, { st: Object.assign({}, y.st, { entities: y.st.entities.map(function (e) { return e.name === x.name ? Object.assign({}, e, { tracker: r.id }) : e }) }) }) }) }) } }, x.name + ' ＋' + t('tk.trackIt'))
        })) : null,
        st.analysis ? h(AnalysisFull, { analysis: st.analysis }) : null,
        h('div', { className: 'nw-impact-acts' },
          st.can_analyze ? h('button', { className: 'nw-btn nw-sm', disabled: Boolean(d.analyzing), onClick: function () {
            setD(Object.assign({}, d, { analyzing: true }))
            postJson(API.storyAnalyze, { story_id: st.id }).then(function (r) { setD(function (x) { return Object.assign({}, x, { analyzing: false, st: Object.assign({}, x.st, { analysis: Object.assign({ newer: 0 }, r.analysis) }) }) }) }).catch(function (e) { setD(function (x) { return Object.assign({}, x, { analyzing: false, error: e.message }) }) })
          } }, d.analyzing ? t('ia.busy') : st.analysis ? t('ia.rerun') : t('ia.run')) : null,
          st.analysis && props.onFollow && !props.followed ? h('button', { className: 'nw-btn nw-primary nw-sm', onClick: function () { props.onFollow('follow', 'story', st.id, st.title) } }, '☆ ' + t('ia.follow')) : null,
          d.error ? h('span', { className: 'nw-error' }, d.error) : null),
        c && c.lead ? h('section', { className: 'nw-sd-copy' },
          h('p', { className: 'nw-rs-lead' }, c.lead, h(Refs, { refs: c.lead_refs, mats: mats })),
          (c.points || []).length ? h('ul', { className: 'nw-rs-points' }, c.points.map(function (x, i) { var q = pt(x); return h('li', { key: i }, q.text, h(Refs, { refs: q.refs, mats: mats })) })) : null) : null,
        h('section', { className: 'nw-rail-box' }, h('h4', null, t('sd.timeline')),
          days.map(function (g) {
            return h('div', { key: g.day, className: 'nw-tl-day' },
              h('div', { className: 'nw-tl-dh' }, longDate(g.day + 'T12:00:00+08:00')),
              h('ol', { className: 'nw-tl2' }, g.ev.map(function (x, i) {
                if (x.k === 'u') return h('li', { key: i, className: 'nw-tl2-u' }, h('span', { className: 'nw-tl2-t' }, hhmm(x.t)), h('span', null, h('b', null, t('up.label')), x.u.text))
                if (x.k === 'p') return h('li', { key: i, className: 'nw-tl2-p' }, h('span', { className: 'nw-tl2-t' }, hhmm(x.t)), h('span', null, t('sd.pushed', { r: t('sd.why.' + x.p.reason) !== 'sd.why.' + x.p.reason ? t('sd.why.' + x.p.reason) : x.p.reason })))
                var mi = mats.findIndex(function (m) { return m.id === x.it.id })
                return h('li', { key: i, className: 'nw-rs' }, h('span', { className: 'nw-tl2-t' }, (x.it.time_confidence === 'fetched' ? '~' : '') + hhmm(x.t)),
                  h('span', { className: 'nw-tl2-body' }, h('span', { className: 'nw-tl2-src' }, (mi >= 0 ? (mi + 1) + '. ' : '') + shortName({ name: x.it.source_name, source_id: x.it.source_id })),
                    h('a', { className: 'nw-tl2-a', href: x.it.url, target: '_blank', rel: 'noopener noreferrer', title: x.it.title_zh ? x.it.title : undefined }, x.it.title_zh || x.it.title),
                    x.it.title_zh ? h('div', { className: 'nw-tl2-orig' }, x.it.title) : null,
                    x.it.kind === 'digest_item' ? h('span', { className: 'nw-muted nw-xs' }, ' · ' + t('sd.fromDigest', { t: x.it.kind_note || '' })) : null,
                    moved[x.it.id] ? h('span', { className: 'nw-saved' }, ' ' + t('fb.moved')) : h('span', { className: 'nw-acts' }, h('button', { className: 'nw-act', onClick: function () { misplace(x.it.id) } }, t('fb.misplaced')))))
              })))
          })))
    }

    // ------------------------------------------------------------------ 日报
    function DailyView(props) {
      var today = dayOf(Date.now())
      // 回顾是晚间产品：18 点前默认看昨天的
      var bjHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()))
      var dPair = useState({ date: bjHour < 18 ? addDays(today, -1) : today, d: null, dates: [], busy: false, phase: 'busy', error: null })
      var d = dPair[0]
      var setD = dPair[1]
      var pack = props.pack || 'all'
      var load = useCallback(function (date) {
        return postJson(API.daily, { pack: pack, date: date }).then(function (r) { setD(function (prev) { return Object.assign({}, prev, { date: date, d: r.daily, dates: r.dates || [], busy: Boolean(r.model && r.model.busy === 'daily'), phase: 'ready', error: null }) }) })
          .catch(function (e) { setIn(setD, { phase: 'ready', error: e.message }) })
      }, [pack])
      useEffect(function () { load(d.date) }, [load, props.stamp])
      useEffect(function () {
        if (!d.busy) return
        var timer = setInterval(function () { load(d.date) }, 5000)
        return function () { clearInterval(timer) }
      }, [d.busy, d.date, load])
      function make() {
        setIn(setD, { busy: true, error: null })
        postJson(API.daily, { pack: pack, date: d.date, refresh: true }).then(function (r) { if (r && r.started) return; setIn(setD, { busy: false, d: r.daily, dates: r.dates || [] }) })
          .catch(function (e) { setIn(setD, { busy: e.status === 409, error: e.status === 409 ? null : e.message }) })
      }
      var x = d.d
      var nav = h('div', { className: 'nw-mast-row' },
        h('span', { className: 'nw-daynav' },
          h('button', { className: 'nw-act', 'aria-label': '-1', onClick: function () { load(addDays(d.date, -1)) } }, '‹'),
          h('span', { className: 'nw-mast-date' }, longDate(d.date + 'T12:00:00+08:00') + (d.date === today ? ' · ' + t('dy.today') : '')),
          h('button', { className: 'nw-act', 'aria-label': '+1', disabled: d.date >= today, onClick: function () { load(addDays(d.date, 1)) } }, '›'),
          d.date !== today ? h('button', { className: 'nw-act', onClick: function () { load(today) } }, t('dy.today')) : null),
        h('button', { className: 'nw-btn nw-ghost nw-sm', disabled: d.busy, onClick: make }, d.busy ? '…' : x ? t('dy.remake') : t('dy.make')))
      var body
      if (d.phase === 'busy') body = Empty({ children: '…' })
      else if (!x) body = Empty({ children: t('dy.none') })
      else body = h('div', { className: 'nw-read' },
        h('div', { className: 'nw-read-main' },
          h('ol', { className: 'nw-daily-list' }, x.stories.map(function (st, i) {
            return h('li', { key: st.id, className: 'nw-rs' },
              h('div', { className: 'nw-rs-head' }, h('span', { className: 'nw-daily-n' }, String(i + 1)), st.followed ? h('span', { className: 'nw-rs-star' }, '★') : null,
                h('button', { className: 'nw-rs-title', onClick: function () { props.onOpen(st.id) } }, st.title)),
              h('div', { className: 'nw-rs-meta' }, h('span', { className: 'nw-byline' }, [(props.names && props.names[st.section]) || st.section, t('dy.items', { n: st.items_today }), (st.outlets || []).slice(0, 3).join('、')].filter(Boolean).join(' · '))),
              h('p', { className: 'nw-rs-lead' }, st.arc))
          }))),
        h('aside', { className: 'nw-rail' },
          x.tomorrow.length ? h('section', { className: 'nw-rail-box' }, h('h4', null, t('dy.tomorrow')), h('ul', null, x.tomorrow.map(function (w, i) { return h('li', { key: i }, w.text) }))) : null,
          h('section', { className: 'nw-rail-box nw-about' }, h('h4', null, t('rd.aboutDay')),
            h('p', null, t('dy.stats', { i: x.stats.items, s: x.stats.storylines, r: x.stats.sources, p: x.stats.pushes })),
            h('p', null, (x.mode === 'llm' ? t('rd.byModel', { m: x.model || '' }) : t('rd.byRules')) + ' · ' + when(x.created_at)),
            h('p', { className: 'nw-muted' }, t('dy.hint')))))
      return h('div', { className: 'nw-edition' },
        h('header', { className: 'nw-mast' }, nav,
          x && x.headline ? h('h1', { className: 'nw-mast-head' }, x.headline) : null,
          x ? h('div', { className: 'nw-mast-dek' }, t('rd.dayDek', { n: x.stories.length })) : null),
        d.busy ? h('div', { className: 'nw-working' }, h('span', { className: 'nw-pulse' }), t('dy.busy')) : null,
        d.error ? h('div', { className: 'nw-error' }, d.error) : null, body)
    }

    /** 内容健康度：各源近 24 小时的内容是否完整，被过滤的广告与引流（可恢复）。 */
    function ContentCard(props) {
      var qPair = useState(null)
      var q = qPair[0]
      var setQ = qPair[1]
      var rPair = useState({})
      var restored = rPair[0]
      var setRestored = rPair[1]
      useEffect(function () { getJson(API.quality).then(setQ).catch(function () {}) }, [props.stamp])
      if (!q || !q.content) return null
      var c = q.content
      var tt = c.totals || {}
      function restore(id) {
        postJson(API.feedback, { kind: 'not_promo', article_id: id }).then(function () { setRestored(function (m) { var n = Object.assign({}, m); n[id] = true; return n }) }).catch(function () {})
      }
      var pct = function (a, b) { return b ? Math.round(a * 100 / b) + '%' : '–' }
      var bad = (c.sources || []).filter(function (x) { return x.status !== 'ok' })
      return h(Section, { title: t('ct.title'), aside: h('span', { className: 'nw-muted' }, t('ct.sum', { n: tt.items || 0, f: pct(tt.full || 0, tt.items || 0), p: tt.promo || 0, d: tt.digest || 0, i: tt.digest_items || 0 })) },
        h('p', { className: 'nw-muted nw-xs' }, t('ct.hint')),
        bad.length ? h('div', { className: 'nw-table-wrap' }, h('table', { className: 'nw-table' },
          h('thead', null, h('tr', null, ['ct.src', 'ct.state', 'ct.n', 'ct.full', 'ct.trunc', 'ct.titleOnly', 'ct.bodies', 'ct.advice'].map(function (k) { return h('th', { key: k }, t(k)) }))),
          h('tbody', null, bad.map(function (x) {
            return h('tr', { key: x.source_id, className: x.status === 'degraded' ? 'nw-bad' : '' },
              h('td', null, x.name), h('td', null, h('span', { className: x.status === 'degraded' ? 'nw-warn' : 'nw-muted' }, t('ct.st.' + x.status))),
              h('td', null, String(x.n)), h('td', null, String(x.full)), h('td', null, String(x.truncated)), h('td', null, String(x.title_only) + (x.title_only_before != null ? ' (' + t('ct.before', { p: x.title_only_before }) + ')' : '')),
              h('td', null, (x.bodies_tried ? x.bodies_ok + '/' + x.bodies_tried : '–') + (x.body_mode ? ' · ' + t('ct.mode.' + x.body_mode) : '')),
              h('td', { className: 'nw-muted nw-xs' }, x.advice ? t('ct.adv.' + x.advice) : ''))
          })))) : h('div', { className: 'nw-okc nw-xs' }, t('ct.allOk')),
        (q.filtered || []).length ? h('div', { className: 'nw-ct-filtered' },
          h('div', { className: 'nw-rs-k' }, t('ct.filtered', { n: q.filtered.length })),
          h('ul', { className: 'nw-plain' }, q.filtered.slice(0, 30).map(function (x) {
            return h('li', { key: x.id, className: 'nw-rs nw-ct-li' },
              h('span', { className: 'nw-muted nw-xs' }, (x.kind === 'digest' ? t('ct.digest') : x.kind_note || t('ct.promo')) + ' · ' + shortName({ name: x.source_name, source_id: x.source_id }) + ' · '),
              h('a', { className: 'nw-tl2-a', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.title),
              x.kind === 'promo' ? (restored[x.id] ? h('span', { className: 'nw-saved' }, ' ' + t('ct.restored')) : h('span', { className: 'nw-acts' }, h('button', { className: 'nw-act', onClick: function () { restore(x.id) } }, t('ct.restore')))) : null)
          }))) : null)
    }

    /** 质量面板：最近的版面——耗时、调用、新/沿用、核对、退回规则、读者报错。 */
    function QualityCard(props) {
      var qPair = useState(null)
      var q = qPair[0]
      var setQ = qPair[1]
      useEffect(function () { getJson(API.quality).then(setQ).catch(function () {}) }, [props.stamp])
      if (!q || !(q.editions || []).length) return null
      var fb = (q.feedback || []).reduce(function (a, r) { return { n: a.n + r.n, r: a.r + (r.resolved || 0) } }, { n: 0, r: 0 })
      var rows = q.editions.slice(0, 15)
      return h(Section, { title: t('q.title'), aside: fb.n ? h('span', { className: 'nw-muted' }, t('q.fb', { n: fb.n, r: fb.r })) : null },
        h('div', { className: 'nw-model-row' }, h(Spark, { values: rows.slice().reverse().filter(function (r) { return !r.reassembled }).map(function (r) { return Math.round((r.ms || 0) / 1000) }), format: function (v) { return v + 's' }, label: t('q.ms') })),
        h('div', { className: 'nw-table-wrap' }, h('table', { className: 'nw-table' },
          h('thead', null, h('tr', null, ['q.when', 'q.mode', 'q.ms', 'q.calls', 'q.fresh', 'q.check', 'q.fallback', 'q.reported'].map(function (k) { return h('th', { key: k }, t(k)) }))),
          h('tbody', null, rows.map(function (r) {
            var ck = r.check && r.check.checked ? r.check.passed + '/' + r.check.checked : '–'
            return h('tr', { key: r.id, className: r.fallbacks ? 'nw-bad' : '' },
              h('td', null, when(r.created_at)), h('td', null, r.reassembled ? t('q.re') : r.mode === 'llm' ? '✦ ' + (r.model || '') : t('mode.economy')), h('td', null, r.ms != null ? Math.round(r.ms / 1000) + 's' : ''), h('td', null, String(r.calls || 0)),
              h('td', null, (r.fresh ?? '–') + ' / ' + (r.reused ?? '–')), h('td', null, ck), h('td', null, String(r.fallbacks || 0)), h('td', null, String(r.reported || 0)))
          })))))
    }

    // ------------------------------------------------------------------ 推送
    function PushPanel(props) {
      var vPair = useState(null)
      var v = vPair[0]
      var setV = vPair[1]
      var dPair = useState(null)
      var draft = dPair[0]
      var setDraft = dPair[1]
      var nPair = useState('')
      var note = nPair[0]
      var setNote = nPair[1]
      var load = useCallback(function () { return getJson(API.push).then(function (r) { setV(r); setDraft(r.prefs) }).catch(function (e) { setNote(e.message) }) }, [])
      useEffect(function () { load() }, [load, props.stamp])
      if (!v || !draft) return null
      function save() {
        setNote('…')
        postJson(API.push, { prefs: draft }).then(function (r) { setV(r); setDraft(r.prefs); setNote(t('ps.saved') + (r.schedule_note ? ' ' + r.schedule_note : '')) }).catch(function (e) { setNote(e.message) })
      }
      function vote(sid, kind) {
        postJson(API.feedback, { kind: kind, story_id: sid }).then(function () { setV(function (x) { return Object.assign({}, x, { pushes: x.pushes.map(function (p) { return p.story_id === sid ? Object.assign({}, p, { vote: kind }) : p }) }) }) }).catch(function () {})
      }
      var dirty = JSON.stringify(draft) !== JSON.stringify(v.prefs)
      var pen = Object.keys(v.penalties || {})
      return h('section', { className: 'nw-push' },
        h('h2', { className: 'nw-sec-h' }, t('ps.title')),
        h('p', { className: 'nw-muted nw-xs' }, t('ps.hint')),
        h('div', { className: 'nw-ps-grid' },
          h('div', { className: 'nw-ps-k' }, t('ps.cadence')),
          h('div', { className: 'nw-ps-cad' }, Object.keys(v.cadences).map(function (k) {
            return h('label', { key: k, className: 'nw-ps-opt' + (draft.cadence === k ? ' nw-on' : '') }, h('input', { type: 'radio', name: 'nw-cad', checked: draft.cadence === k, onChange: function () { setDraft(Object.assign({}, draft, { cadence: k })) } }), v.cadences[k])
          })),
          h('div', { className: 'nw-ps-k' }, t('ps.level')),
          h(Seg, { value: draft.level, onChange: function (x) { setDraft(Object.assign({}, draft, { level: x })) }, options: [['fewer', t('ps.fewer')], ['normal', t('ps.normal')], ['more', t('ps.more')]] }),
          h('div', { className: 'nw-ps-k' }, t('ps.limits')),
          h('div', { className: 'nw-ps-lim' },
            h('label', null, t('ps.perRound'), ' ', h('input', { className: 'nw-in nw-num', type: 'number', min: 1, max: 15, value: draft.per_round, onChange: function (e) { setDraft(Object.assign({}, draft, { per_round: Number(e.target.value) })) } })),
            h('label', null, t('ps.daily'), ' ', h('input', { className: 'nw-in nw-num', type: 'number', min: 1, max: 100, value: draft.daily_max, onChange: function (e) { setDraft(Object.assign({}, draft, { daily_max: Number(e.target.value) })) } })))),
        h('div', { className: 'nw-model-row' },
          h('button', { className: 'nw-btn nw-primary nw-sm', disabled: !dirty, onClick: save }, t('ps.save')),
          !v.schedule_available ? h('span', { className: 'nw-muted nw-xs' }, t('ps.noSvc')) : !v.task ? h('span', { className: 'nw-muted nw-xs' }, t('ps.noTask')) : h('span', { className: 'nw-muted nw-xs' }, t('ps.task', { s: v.task.status, n: v.task.scheduledAt ? when(v.task.scheduledAt) : '–' })),
          note ? h('span', { className: 'nw-saved' }, note) : null),
        pen.length ? h('p', { className: 'nw-note' }, t('ps.learned', { s: pen.map(function (k) { return ((props.names || {})[k] || k) + ' +' + v.penalties[k] }).join('、') })) : null,
        h('h2', { className: 'nw-sec-h nw-ps-log' }, t('ps.log')),
        (v.pushes || []).length ? h('ul', { className: 'nw-sb-list' }, v.pushes.map(function (x) {
          return h('li', { key: x.id, className: 'nw-sb-row' },
            h('div', { className: 'nw-sb-main' },
              h('div', { className: 'nw-sb-name' }, x.url ? h('a', { className: 'nw-tl2-a', href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.title || '–') : h('span', null, x.title || '–')),
              h('div', { className: 'nw-muted nw-xs' }, [when(x.pushed_at), t('sd.why.' + x.reason) !== 'sd.why.' + x.reason ? t('sd.why.' + x.reason) : x.reason, x.section ? ((props.names || {})[x.section] || x.section) : ''].filter(Boolean).join(' · '))),
            x.story_id ? h('div', { className: 'nw-ps-vote' },
              h('button', { className: 'nw-act' + (x.vote === 'push_up' ? ' nw-on' : ''), onClick: function () { vote(x.story_id, 'push_up') } }, t('ps.up')),
              h('button', { className: 'nw-act' + (x.vote === 'push_down' ? ' nw-on' : ''), onClick: function () { vote(x.story_id, 'push_down') } }, t('ps.down'))) : null)
        })) : Empty({ children: t('ps.none') }))
    }

    // ------------------------------------------------------------------ 关注
    function FollowsView(props) {
      var fPair = useState(null)
      var f = fPair[0]
      var setF = fPair[1]
      var kPair = useState('keyword')
      var kind = kPair[0]
      var setKind = kPair[1]
      var vPair = useState('')
      var val = vPair[0]
      var setVal = vPair[1]
      var nPair = useState('')
      var note = nPair[0]
      var setNote = nPair[1]
      useEffect(function () { getJson(API.follows).then(setF).catch(function (e) { setNote(e.message) }) }, [props.stamp])
      function act(action, k, v, name) {
        postJson(API.follows, { action: action, kind: k, value: v, name: name }).then(function (res) { setF(res); setNote(t('fl.saved')); if (action === 'follow' || action === 'mute') setVal('') }).catch(function (e) { setNote((e.data && e.data.error) || e.message) })
      }
      var tax = props.taxonomy || {}
      var srcs = ((props.sources && props.sources.sources) || []).filter(function (x) { return !x.removed_at })
      var input = kind === 'topic'
        ? h('select', { className: 'nw-in', value: val, onChange: function (e) { setVal(e.target.value) } }, [h('option', { key: '', value: '' }, '—')].concat((tax.labels || []).map(function (top) { return [h('option', { key: top.id, value: top.id }, top.name)].concat((top.children || []).map(function (c) { return h('option', { key: c.id, value: c.id }, '　' + c.name) })) })))
        : kind === 'source'
          ? h('select', { className: 'nw-in', value: val, onChange: function (e) { setVal(e.target.value) } }, [h('option', { key: '', value: '' }, '—')].concat(srcs.map(function (x) { return h('option', { key: x.id, value: x.id }, x.name || x.id) })))
          : h('input', { className: 'nw-in nw-search', value: val, placeholder: t('fl.ph'), onChange: function (e) { setVal(e.target.value) } })
      var nameOf = function (x) {
        if (x.name) return x.name
        if (x.kind === 'topic') return (props.names && props.names[x.value]) || x.value
        if (x.kind === 'source') { var sx = srcs.find(function (y) { return y.id === x.value }); return sx ? sx.name : x.value }
        var al = String(x.value).split('|')
        return al.length > 1 ? al[0] + '（' + al.slice(1).join('、') + '）' : x.value
      }
      var list = function (items, undo) {
        if (!items || !items.length) return Empty({ children: t('fl.none') })
        return h('ul', { className: 'nw-fl-list' }, items.map(function (x) {
          return h('li', { key: x.kind + x.value }, h(Chip, { tone: 'dim' }, t('fl.kind.' + x.kind)), h('span', { className: 'nw-fl-name' }, nameOf(x)),
            h('button', { className: 'nw-mini', onClick: function () { act(undo, x.kind, x.value) } }, t('fl.remove')))
        }))
      }
      return h('div', { className: 'nw-follows' },
        h('div', { className: 'nw-card-static nw-fl-add' },
          h('div', { className: 'nw-model-row' },
            h(Seg, { value: kind, onChange: function (k) { setKind(k); setVal('') }, options: [['keyword', t('fl.kind.keyword')], ['topic', t('fl.kind.topic')], ['source', t('fl.kind.source')]] }),
            input,
            h('button', { className: 'nw-btn nw-primary nw-sm', disabled: !val.trim(), onClick: function () { act('follow', kind, val) } }, t('fl.add')),
            h('button', { className: 'nw-btn nw-ghost nw-sm', disabled: !val.trim(), onClick: function () { act('mute', kind, val) } }, t('fl.addMute'))),
          h('div', { className: 'nw-muted nw-xs' }, t('fl.hint')),
          note ? h('div', { className: 'nw-saved' }, note) : null),
        h(Section, { title: '★ ' + t('fl.listFollow') }, list(f && f.follow, 'unfollow')),
        h(Section, { title: t('fl.listMute') }, list(f && f.mute, 'unmute')),
        h(PushPanel, { stamp: props.stamp, names: props.names }))
    }

    // ------------------------------------------------------------------ 要闻
    function NewsTab(props) {
      var fPair = useState({ hours: Number(store('hours')) || 24, cred: 'any', label: '', region: '', query: '', limit: 60, pack: store('pack') || '' })
      var f = fPair[0]
      var setF = fPair[1]
      var dPair = useState({ phase: 'idle', events: [] })
      var d = dPair[0]
      var setD = dPair[1]
      var selPair = useState(null)
      var sel = selPair[0]
      var setSel = selPair[1]
      var view = props.view || 'edition'
      var fromPair = useState(null)
      var from = fromPair[0]
      var setFrom = fromPair[1]
      var stPair = useState(null)
      var storySel = stPair[0]
      var setStorySel = stPair[1]
      var flPair = useState(null)
      var flw = flPair[0]
      var setFlw = flPair[1]
      useEffect(function () { getJson(API.follows).then(setFlw).catch(function () {}) }, [props.stamp])
      function storyFollow(action, kind, value, name) { postJson(API.follows, { action: action, kind: kind, value: value, name: name }).then(setFlw).catch(function () {}) }
      function openFromEdition(id) { setStorySel(id) }
      function back() { setSel(null); setFrom(null) }
      var load = useCallback(function () {
        setIn(setD, { phase: 'busy' })
        var cred = f.cred === 'multi' ? 'corroborated,confirmed,disputed' : f.cred === 'auth' ? 'confirmed' : undefined
        return postJson(API.events, { hours: f.hours, pack: f.pack || undefined, credibility: cred, label: f.label || undefined, region: f.region || undefined, query: f.query || undefined, limit: f.limit, min_importance: f.cred === 'any' ? 20 : undefined })
          .then(function (res) { setD({ phase: 'ready', events: res.events || [] }) })
          .catch(function (e) { setD({ phase: 'error', events: [], error: e.message }) })
      }, [f.hours, f.cred, f.label, f.region, f.query, f.limit, f.pack])
      useEffect(function () { load() }, [load, props.stamp])
      var tax = props.taxonomy || {}
      var packs = Object.keys(props.packs || {})
      var kw = (props.summary && props.summary.keywords) || []
      var model = props.summary && props.summary.model
      function setPack(v) { store('pack', v); setF(Object.assign({}, f, { pack: v })) }
      if (view === 'follows') return h('div', { className: 'nw-news' }, h(FollowsView, { stamp: props.stamp, taxonomy: props.taxonomy, names: props.names, sources: props.sources }))
      if (view !== 'events' && storySel) return h('div', { className: 'nw-news' }, h(StoryDetail, { id: storySel, names: props.names, onBack: function () { setStorySel(null) }, onFollow: storyFollow, followed: Boolean(flw && flw.follow.some(function (x) { return x.kind === 'story' && x.value === storySel })) }))
      if (view === 'daily') return h('div', { className: 'nw-news' }, h(DailyView, { pack: f.pack || 'all', stamp: props.stamp, names: props.names, onOpen: openFromEdition }))
      if (view === 'edition') return h('div', { className: 'nw-news' }, h(EditionView, { pack: f.pack || 'all', packs: props.packs, onPack: setPack, stamp: props.stamp, names: props.names, onOpen: openFromEdition, firstRun: Boolean(props.ready && !(props.summary && props.summary.latest_run)), onReload: props.reload }))
      var mfPair = useState(false)
      var moreF = mfPair[0]
      var setMoreF = mfPair[1]
      var set = function (patch) { setF(Object.assign({}, f, patch)) }
      return h('div', { className: 'nw-news' + (sel ? ' nw-has-sel' : '') },
        h('div', { className: 'nw-filters nw-filters-1' },
          h('input', { className: 'nw-in nw-search nw-fsearch', type: 'search', value: f.query, placeholder: t('ev.searchPh'), onChange: function (e) { set({ query: e.target.value }) } }),
          h(Seg, { value: f.hours, onChange: function (v) { store('hours', String(v)); set({ hours: v }) }, options: [[6, t('ev.h6')], [24, t('ev.h24')], [72, t('ev.h72')]] }),
          h('label', { className: 'nw-ps-opt' + (f.cred === 'multi' ? ' nw-on' : '') }, h('input', { type: 'checkbox', checked: f.cred === 'multi', onChange: function (e) { set({ cred: e.target.checked ? 'multi' : 'any' }) } }), t('ev.multi')),
          h('button', { className: 'nw-act', onClick: function () { setMoreF(!moreF) } }, (moreF ? '▾ ' : '▸ ') + t('ev.moreFilters') + ((f.label || f.region || f.pack || f.cred === 'auth') ? ' •' : ''))),
        moreF ? h('div', { className: 'nw-filters nw-filters-2' },
          packs.length > 1 ? h(Seg, { value: f.pack, onChange: function (v) { store('pack', v); set({ pack: v }) }, options: [['', t('sel.all')]].concat(packs.map(function (k) { return [k, (props.packs[k] && props.packs[k].title) || k] })) }) : null,
          h('label', { className: 'nw-ps-opt' + (f.cred === 'auth' ? ' nw-on' : '') }, h('input', { type: 'checkbox', checked: f.cred === 'auth', onChange: function (e) { set({ cred: e.target.checked ? 'auth' : 'any' }) } }), t('cred.auth')),
          h('select', { className: 'nw-in', value: f.label, 'aria-label': t('label.label'), onChange: function (e) { set({ label: e.target.value }) } },
            [h('option', { key: '', value: '' }, t('label.label') + '：' + t('sel.all'))].concat((tax.labels || []).map(function (top) {
              return [h('option', { key: top.id, value: top.id }, top.name)].concat((top.children || []).map(function (c) { return h('option', { key: c.id, value: c.id }, '　' + c.name) }))
            }))),
          h('select', { className: 'nw-in', value: f.region, 'aria-label': t('label.region'), onChange: function (e) { set({ region: e.target.value }) } },
            [h('option', { key: '', value: '' }, t('label.region') + '：' + t('sel.all'))].concat((tax.regions || []).map(function (r) { return h('option', { key: r, value: r }, r) })))) : null,
        kw.length ? h('div', { className: 'nw-hotwords' }, h('span', { className: 'nw-muted nw-xs' }, t('ev.hot')), kw.slice(0, 10).map(function (k) {
          return h('button', { key: k.tag, className: 'nw-act' + (f.query === k.tag ? ' nw-on' : ''), onClick: function () { set({ query: f.query === k.tag ? '' : k.tag }) } }, k.tag)
        })) : null,
        h('div', { className: 'nw-split' },
          h('div', { className: 'nw-list' },
            d.phase === 'busy' && !d.events.length ? Empty({ children: '…' }) : null,
            d.phase === 'error' ? h('div', { className: 'nw-error' }, d.error) : null,
            d.phase === 'ready' && !d.events.length ? Empty({ children: t('txt.noEvents') }) : null,
            d.events.map(function (e) { return h(EventCard, { key: e.event_id, ev: e, names: props.names, active: sel === e.event_id, onClick: function () { setSel(e.event_id) } }) }),
            d.events.length >= f.limit ? h('button', { className: 'nw-btn nw-ghost nw-more', onClick: function () { setF(Object.assign({}, f, { limit: f.limit + 60 })) } }, t('btn.more')) : null,
            h('div', { className: 'nw-foot' }, t('txt.disclaimer'))),
          h('div', { className: 'nw-pane' }, h(EventDetail, { id: sel, names: props.names, model: model, onBack: back }))))
    }

    // ------------------------------------------------------------------ 时间线
    function RunBars(props) {
      var runs = props.runs || []
      var top = Math.max.apply(null, runs.map(function (r) { return r.items_new || 0 }).concat([1]))
      return h('div', { className: 'nw-bars', role: 'list' }, runs.map(function (r) {
        var hgt = 6 + Math.round(52 * (r.items_new || 0) / top)
        var night = /overnight/.test(r.notes || '')
        var bad = r.failed > 0 || r.gaps > 0
        return h('button', { key: r.run_id, role: 'listitem', className: 'nw-bar' + (props.value === r.run_id ? ' nw-on' : ''), onClick: function () { props.onPick(r.run_id) },
          title: t('tl.barTip', { t: hhmm(r.started_at), n: r.items_new || 0, m: r.events_multi || 0 }) },
          h('span', { className: 'nw-bar-n' }, String(r.items_new || 0)),
          h('span', { className: 'nw-bar-col' + (bad ? ' nw-bad' : ''), style: { height: hgt + 'px' } }),
          h('span', { className: 'nw-bar-t' }, hhmm(r.started_at)),
          h('span', { className: 'nw-bar-mark' }, [night ? t('tl.night') : '', r.pushes ? t('tl.pushed') : '', r.failed ? t('tl.failed', { n: r.failed }) : r.gaps ? t('tl.gap') : ''].filter(Boolean).join(' ')))
      }))
    }

    function TimelineTab(props) {
      var today = dayOf(Date.now())
      var sPair = useState({ date: today, run: null, kind: 'events' })
      var s = sPair[0]
      var setS = sPair[1]
      var dPair = useState({ phase: 'idle', runs: [], entries: [], run_id: null })
      var d = dPair[0]
      var setD = dPair[1]
      var selPair = useState(null)
      var sel = selPair[0]
      var setSel = selPair[1]
      useEffect(function () {
        setIn(setD, { phase: 'busy' })
        postJson(API.timeline, { date: s.date, run_id: s.run || undefined, kind: s.kind, limit: 60 })
          .then(function (res) { setD({ phase: 'ready', runs: res.runs || [], entries: res.entries || [], run_id: res.run_id, ms: res.ms }) })
          .catch(function (e) { setD({ phase: 'error', runs: [], entries: [], run_id: null, error: e.message }) })
      }, [s.date, s.run, s.kind, props.stamp])
      var cur = (d.runs || []).find(function (r) { return r.run_id === d.run_id })
      return h('div', { className: 'nw-timeline' + (sel ? ' nw-has-sel' : '') },
        h('div', { className: 'nw-filters' },
          h('button', { className: 'nw-btn nw-ghost', 'aria-label': 'prev', onClick: function () { setS({ date: addDays(s.date, -1), run: null, kind: s.kind }) } }, '◀'),
          h('input', { className: 'nw-in', type: 'date', value: s.date, max: today, onChange: function (e) { if (e.target.value) setS({ date: e.target.value, run: null, kind: s.kind }) } }),
          h('button', { className: 'nw-btn nw-ghost', 'aria-label': 'next', disabled: s.date >= today, onClick: function () { setS({ date: addDays(s.date, 1), run: null, kind: s.kind }) } }, '▶'),
          s.date !== today ? h('button', { className: 'nw-btn nw-ghost', onClick: function () { setS({ date: today, run: null, kind: s.kind }) } }, t('btn.today')) : null,
          h(Seg, { value: s.kind, onChange: function (v) { setS(Object.assign({}, s, { kind: v })) }, options: [['events', t('kind.events')], ['items', t('kind.items')]] })),
        d.phase === 'ready' && !d.runs.length ? Empty({ children: t('txt.noRunsDay') }) : h(RunBars, { runs: d.runs, value: d.run_id, onPick: function (id) { setS(Object.assign({}, s, { run: id })) } }),
        h('p', { className: 'nw-muted nw-xs' }, t('tl.hint')),
        cur ? h('div', { className: 'nw-runline' },
          h('b', null, t('tl.round', { t: hhmm(cur.started_at) })), ' ',
          h('span', { className: 'nw-muted' }, [t('tl.srcs', { a: cur.sources_ok || 0, b: cur.sources_total || 0 }), t('tl.newItems', { n: cur.items_new || 0 }), t('tl.newEvents', { n: cur.events_new || 0 }), cur.pushes ? t('tl.pushes', { n: cur.pushes }) : '', /overnight/.test(cur.notes || '') ? t('txt.overnight') : '', cur.failed ? t('tl.failed', { n: cur.failed }) : '', cur.gaps ? t('tl.gaps', { n: cur.gaps }) : ''].filter(Boolean).join(' · '))) : null,
        h('div', { className: 'nw-split' },
          h('div', { className: 'nw-list' },
            d.phase === 'busy' ? Empty({ children: '…' }) : null,
            s.kind === 'events'
              ? d.entries.map(function (e) { return h(EventCard, { key: e.event_id, ev: e, names: props.names, active: sel === e.event_id, onClick: function () { setSel(e.event_id) } }) })
              : d.entries.map(function (r) { return h(ItemRow, { key: r.id, row: { time: r.t, time_confidence: r.time_confidence, source: r.source_name || r.source_id, title: r.title, url: r.url, signals: { hot: r.hot, level: r.level, views: r.views, comments: r.comments, likes: r.likes } } }) }),
            d.phase === 'ready' && d.run_id && !d.entries.length ? Empty({ children: t('txt.noEvents') }) : null),
          h('div', { className: 'nw-pane' }, s.kind === 'events' ? h(EventDetail, { id: sel, names: props.names, onBack: function () { setSel(null) } }) : null)))
    }

    // ------------------------------------------------------------------ 条目
    /** 快讯一行：时间 · 来源 · 标题；摘要最多两行，点开看全；被过滤的标出原因。 */
    function ItemRow(props) {
      var r = props.row
      var oPair = useState(false)
      var open = oPair[0]
      var setOpen = oPair[1]
      var sum = r.summary && r.summary !== r.title ? r.summary : ''
      var kindTag = r.kind && r.kind !== 'news' && r.kind !== 'digest_item' ? t('it.kind.' + r.kind) : ''
      var sig = r.signals || {}
      return h('div', { className: 'nw-itrow' + (kindTag ? ' nw-itrow-off' : '') },
        h('span', { className: 'nw-tl2-t', title: r.time_confidence || '' }, whenC(r.time, r.time_confidence)),
        h('div', { className: 'nw-itbody' },
          h('div', null, h('span', { className: 'nw-tl2-src' }, r.source || ''),
            h('a', { className: 'nw-tl2-a', href: r.url, target: '_blank', rel: 'noopener noreferrer', title: r.title_zh ? r.title : undefined }, r.title_zh || r.title),
            kindTag ? h('span', { className: 'nw-evtag' }, kindTag) : null,
            (sig.hot || []).length ? h('span', { className: 'nw-evtag nw-evtag-first' }, sig.hot[0]) : null,
            sig.views != null ? h('span', { className: 'nw-muted nw-xs' }, ' ' + t('ev.views', { n: fmtN(sig.views) })) : null),
          sum ? h('div', { className: 'nw-itsum' + (open ? ' nw-open' : ''), onClick: function () { setOpen(!open) } }, sum) : null))
    }

    function ItemsTab(props) {
      var srcs = (props.sources && props.sources.sources) || []
      var tax = props.taxonomy || {}
      var fPair = useState({ source: '', query: '', hours: 24, limit: 80, hot: false, label: '', all: false })
      var f = fPair[0]
      var setF = fPair[1]
      var dPair = useState({ phase: 'idle', rows: [], note: '', next: null })
      var d = dPair[0]
      var setD = dPair[1]
      function query(before) {
        return postJson(API.items, { source: f.source || undefined, query: f.query || undefined, hours: f.hours, limit: f.limit, hot_only: f.hot || undefined, label: f.label || undefined, all_kinds: f.all || undefined, before: before || undefined })
      }
      var load = useCallback(function () {
        setD({ phase: 'busy', rows: [], note: '', next: null })
        return query(null)
          .then(function (res) { setD({ phase: 'ready', rows: res.items || [], next: (res.items || []).length >= f.limit ? res.next_before : null, note: (res.count ?? 0) + ' ' + t('txt.rows') + ' · ' + t('txt.approx') }) })
          .catch(function (e) { setD({ phase: 'error', rows: [], note: String(e.message), next: null }) })
      }, [f.source, f.query, f.hours, f.limit, f.hot, f.label, f.all, props.stamp])
      function more() {
        if (!d.next) return
        var prev = d.rows
        setIn(setD, { phase: 'busy' })
        return query(d.next)
          .then(function (res) { var rows = prev.concat(res.items || []); setD({ phase: 'ready', rows: rows, next: (res.items || []).length >= f.limit ? res.next_before : null, note: rows.length + ' ' + t('txt.rows') + ' · ' + t('txt.approx') }) })
          .catch(function (e) { setIn(setD, { phase: 'error', note: String(e.message) }) })
      }
      useEffect(function () { load() }, [load])
      return h('div', null,
        h('div', { className: 'nw-filters nw-filters-1' },
          h('input', { className: 'nw-in nw-search nw-fsearch', type: 'search', value: f.query, placeholder: t('ph.query'), onChange: function (e) { setF(Object.assign({}, f, { query: e.target.value })) } }),
          h(Seg, { value: f.hours, onChange: function (v) { setF(Object.assign({}, f, { hours: v })) }, options: [[6, t('ev.h6')], [24, t('ev.h24')], [72, t('ev.h72')]] }),
          h('select', { className: 'nw-in', value: f.label, 'aria-label': t('label.label'), onChange: function (e) { setF(Object.assign({}, f, { label: e.target.value })) } },
            [h('option', { key: '', value: '' }, t('label.label') + '：' + t('sel.all'))].concat((tax.labels || []).map(function (top) {
              return [h('option', { key: top.id, value: top.id }, top.name)].concat((top.children || []).map(function (c) { return h('option', { key: c.id, value: c.id }, '　' + c.name) }))
            }))),
          h('select', { className: 'nw-in', value: f.source, 'aria-label': t('label.source'), onChange: function (e) { setF(Object.assign({}, f, { source: e.target.value })) } },
            [h('option', { key: '', value: '' }, t('label.source') + '：' + t('sel.all'))].concat(srcs.map(function (s) { return h('option', { key: s.id, value: s.id }, s.name) }))),
          h('label', { className: 'nw-ps-opt' + (f.hot ? ' nw-on' : '') }, h('input', { type: 'checkbox', checked: f.hot, onChange: function (e) { setF(Object.assign({}, f, { hot: e.target.checked })) } }), t('label.hotOnly')),
          h('label', { className: 'nw-ps-opt' + (f.all ? ' nw-on' : '') }, h('input', { type: 'checkbox', checked: f.all, onChange: function (e) { setF(Object.assign({}, f, { all: e.target.checked })) } }), t('it.showFiltered'))),
        h('div', { className: 'nw-muted nw-count' }, d.note),
        d.phase === 'busy' && !d.rows.length ? Empty({ children: '…' }) : null,
        d.rows.length === 0 && d.phase === 'ready' ? Empty({ children: t('txt.noItems') }) : null,
        h('div', { className: 'nw-itlist' }, d.rows.map(function (r, i) { return h(ItemRow, { key: (r.id || r.url) + i, row: r }) })),
        d.next ? h('button', { className: 'nw-btn nw-ghost nw-more', onClick: more, disabled: d.phase === 'busy' }, d.phase === 'busy' ? '…' : t('btn.more')) : null)
    }

    // ------------------------------------------------------------------ 数据源
    // ------------------------------------------------------------------ 源的取舍
    function SourceBoard(props) {
      var sPair = useState(null)
      var list = sPair[0]
      var setList = sPair[1]
      var nPair = useState('')
      var note = nPair[0]
      var setNote = nPair[1]
      var load = useCallback(function () { return getJson(API.scores).then(function (r) { setList(r.sources || []) }).catch(function (e) { setNote(e.message) }) }, [])
      useEffect(function () { load() }, [load, props.stamp])
      function setState(id, state) {
        return postJson(API.state, { id: id, state: state }).then(function () { setList(function (xs) { return (xs || []).map(function (x) { return x.id === id ? Object.assign({}, x, { state: state }) : x }) }) })
      }
      if (!list) return Empty({ children: '…' })
      var todo = list.filter(function (x) { return x.suggest !== x.state })
      function applyAll() {
        setNote('…')
        todo.reduce(function (p, x) { return p.then(function () { return setState(x.id, x.suggest) }) }, Promise.resolve())
          .then(function () { setNote(t('sb.applied', { n: todo.length })); if (props.onChanged) props.onChanged() }).catch(function (e) { setNote(e.message) })
      }
      var count = function (st) { return list.filter(function (x) { return x.state === st }).length }
      return h('section', { className: 'nw-sb' },
        h('div', { className: 'nw-sb-head' },
          h('div', null, h('h2', { className: 'nw-sec-h nw-sb-title' }, t('sb.title')), h('p', { className: 'nw-muted nw-xs' }, t('sb.hint', { d: (list[0] && list[0].days) || 7 }))),
          h('div', { className: 'nw-sb-sum' },
            h('span', { className: 'nw-muted' }, t('sb.sum', { on: count('on'), trial: count('trial'), off: count('off') })),
            todo.length ? h('button', { className: 'nw-btn nw-sm', onClick: applyAll }, t('sb.applyAll', { n: todo.length })) : null)),
        note ? h('div', { className: 'nw-note' }, note) : null,
        h('ul', { className: 'nw-sb-list' }, list.map(function (x) {
          var stats = [t('sb.perDay', { n: x.per_day })]
          if (x.board) stats.push(t('sb.board', { n: x.board }))
          if (x.first) stats.push(t('sb.first', { n: x.first }))
          if (x.exclusive) stats.push(t('sb.excl', { n: x.exclusive }))
          if (x.corrob) stats.push(t('sb.corrob', { n: x.corrob }))
          if (x.n) stats.push(t('sb.low', { p: Math.round(x.low * 100 / x.n) }))
          if (x.n) stats.push(t('sb.full', { p: Math.round(x.full * 100 / x.n) }))
          if (x.promo) stats.push(t('sb.promo', { n: x.promo }))
          if (x.reposts) stats.push(t('sb.reposts', { n: x.reposts }))
          if (x.fetch_ok != null && x.fetch_ok < 90) stats.push(t('sb.fetch', { p: x.fetch_ok }))
          return h('li', { key: x.id, className: 'nw-sb-row' + (x.state === 'off' ? ' nw-sb-off' : '') },
            h('div', { className: 'nw-sb-main' },
              h('div', { className: 'nw-sb-name' }, h('b', null, x.name), h('span', { className: 'nw-sb-v nw-sb-v-' + x.verdict }, t('sb.v.' + x.verdict)), x.pack && x.pack !== 'core' ? h('span', { className: 'nw-muted nw-xs' }, (props.packs && props.packs[x.pack] && props.packs[x.pack].title) || x.pack) : null),
              h('div', { className: 'nw-sb-why' }, t('sb.why.' + x.verdict)),
              h('div', { className: 'nw-muted nw-xs' }, stats.join(' · '))),
            h('div', { className: 'nw-sb-ctl' },
              h(Seg, { value: x.state, onChange: function (v) { setState(x.id, v) }, options: [['on', t('sb.on')], ['trial', t('sb.trial')], ['off', t('sb.off')]] }),
              x.suggest !== x.state ? h('button', { className: 'nw-act nw-sb-sug', onClick: function () { setState(x.id, x.suggest) } }, t('sb.suggest', { s: t('sb.' + x.suggest) })) : null))
        })),
        h('p', { className: 'nw-muted nw-xs' }, t('sb.foot')))
    }

    function SourcesTab(props) {
      var advPair = useState(false)
      var adv = advPair[0]
      var setAdv = advPair[1]
      return h('div', { className: 'nw-sources' },
        h(SourceBoard, { stamp: props.stamp, onChanged: props.reload, packs: props.sources && props.sources.packs }),
        h('button', { className: 'nw-act nw-adv-toggle', onClick: function () { setAdv(!adv) } }, (adv ? '▾ ' : '▸ ') + t('sb.advanced')),
        adv ? h(SourceEditor, props) : null)
    }

    function SourceEditor(props) {
      var docPair = useState(props.sources)
      var doc = docPair[0]
      var setDoc = docPair[1]
      var msgPair = useState(null)
      var msg = msgPair[0]
      var setMsg = msgPair[1]
      var busyPair = useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var testPair = useState({})
      var tests = testPair[0]
      var setTests = testPair[1]

      useEffect(function () { setDoc(props.sources) }, [props.sources])

      function runTest(i) {
        var s = doc.sources[i]
        var key = (s.id || 'x') + i
        setTests(function (prev) { var o = Object.assign({}, prev); o[key] = { phase: 'busy' }; return o })
        var clean = Object.assign({}, s)
        delete clean.health
        return postJson(API.test, { source: clean, max_items: 6 })
          .then(function (res) { setTests(function (prev) { var o = Object.assign({}, prev); o[key] = { phase: 'done', res: res }; return o }) })
          .catch(function (e) { setTests(function (prev) { var o = Object.assign({}, prev); o[key] = { phase: 'done', res: { ok: false, error: (e.data && e.data.problems ? e.data.problems.join('; ') : e.message) } }; return o }) })
      }
      function softRemove(i) {
        var s = doc.sources[i]
        if (!s.health) { remove(i); return }
        patch(i, '__remove', true)
      }

      function patch(i, key, value) {
        var list = doc.sources.map(function (s, j) {
          if (j !== i) return s
          if (key === '__remove') return Object.assign({}, s, { enabled: false, removed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) })
          if (key === '__restore') { var r = Object.assign({}, s, { enabled: true }); delete r.removed_at; return r }
          var o = {}; o[key] = value
          return Object.assign({}, s, o)
        })
        setDoc(Object.assign({}, doc, { sources: list }))
      }
      function toggleChannel(i, ch) {
        var cur = (doc.sources[i].channels || []).slice()
        var at = cur.indexOf(ch)
        if (at >= 0) cur.splice(at, 1); else cur.push(ch)
        patch(i, 'channels', cur)
      }
      function remove(i) { setDoc(Object.assign({}, doc, { sources: doc.sources.filter(function (_, j) { return j !== i }) })) }
      function add() {
        var next = doc.sources.length + 1
        setDoc(Object.assign({}, doc, { sources: doc.sources.concat([{ id: 'source_' + next, name: '新数据源 ' + next, category: (doc.categories[0] || '国际宏观'), type: 'rss', url: '', channels: ['browse', 'agent_reach', 'http'], max_items: 20, enabled: true, region: 'CN', weight: 0.7, tier: 'secondary', pack: 'core' }]) }))
      }
      function save() {
        setBusy(true)
        setMsg(null)
        return postJson(API.sources, { sources: doc.sources.map(function (s) { var c = Object.assign({}, s); delete c.health; return c }) })
          .then(function (res) { setMsg({ ok: true, text: t('txt.saved') + ' · ' + res.count + ' → ' + res.config_path }); props.reload() })
          .catch(function (e) { setMsg({ ok: false, text: t('txt.problems') + ': ' + ((e.data && e.data.problems) || [e.message]).join('; ') }) })
          .then(function () { setBusy(false) })
      }

      if (!doc) return h('div', { className: 'nw-empty' }, '…')
      return h('div', null,
        h('div', { className: 'nw-muted' }, t('txt.config') + ': ' + doc.config_path),
        h('div', { className: 'nw-toolbar' },
          h('button', { className: 'nw-btn', onClick: add }, t('btn.add')),
          h('button', { className: 'nw-btn nw-primary', onClick: save, disabled: busy }, busy ? '…' : t('btn.save'))),
        msg ? h('div', { className: msg.ok ? 'nw-saved' : 'nw-error' }, msg.text) : null,
        h('div', { className: 'nw-srcs' }, doc.sources.map(function (s, i) {
          var key = (s.id || 'x') + i
          var tr = tests[key]
          var adapters = doc.adapters || []
          var chans = doc.channel_choices || CHANNELS
          if (s.removed_at) {
            return h('div', { className: 'nw-src nw-off', key: key },
              h('div', { className: 'nw-src-top' },
                h('span', { className: 'nw-name nw-strike' }, s.name || s.id),
                h('span', { className: 'nw-mono nw-muted' }, s.id),
                h('span', { className: 'nw-muted' }, t('txt.removed') + ' · ' + s.removed_at),
                h('button', { className: 'nw-btn', onClick: function () { patch(i, '__restore', true) } }, t('btn.restore'))))
          }
          return h('div', { className: 'nw-src' + (s.enabled === false ? ' nw-off' : ''), key: key },
            h('div', { className: 'nw-src-top' },
              h('label', { className: 'nw-switch' }, h('input', { type: 'checkbox', checked: s.enabled !== false, onChange: function (e) { patch(i, 'enabled', e.target.checked) } }), t('label.enabled')),
              h('input', { className: 'nw-in nw-name', value: s.name || '', placeholder: t('label.name'), onChange: function (e) { patch(i, 'name', e.target.value) } }),
              h('span', { className: 'nw-mono nw-muted' }, s.id || ''),
              h('label', null, t('label.category'), h('input', { className: 'nw-in nw-cat', list: 'nw-cats', value: s.category || '', onChange: function (e) { patch(i, 'category', e.target.value) } })),
              h('label', null, t('label.type'), h('select', { value: s.type || 'rss', onChange: function (e) { patch(i, 'type', e.target.value) } }, TYPES.map(function (x) { return h('option', { key: x, value: x }, x) }))),
              h('label', null, t('label.adapter'), h('select', { value: s.adapter || '', onChange: function (e) { patch(i, 'adapter', e.target.value || undefined) } }, [h('option', { key: '', value: '' }, '–')].concat(adapters.map(function (x) { return h('option', { key: x, value: x }, x) })))),
              h('label', null, t('label.max'), h('input', { className: 'nw-in nw-num', type: 'number', min: 1, max: 300, value: s.max_items || 20, onChange: function (e) { patch(i, 'max_items', Number(e.target.value)) } })),
              h('button', { className: 'nw-btn', onClick: function () { runTest(i) }, disabled: tr && tr.phase === 'busy' }, tr && tr.phase === 'busy' ? t('btn.testing') : t('btn.test')),
              h('button', { className: 'nw-btn nw-danger', title: t('txt.removeHint'), onClick: function () { softRemove(i) } }, t('btn.remove'))),
            h('div', { className: 'nw-src-top' },
              h('label', null, t('label.region'), h('input', { className: 'nw-in nw-num', value: s.region || '', onChange: function (e) { patch(i, 'region', e.target.value.toUpperCase()) } })),
              h('label', null, t('label.weight'), h('input', { className: 'nw-in nw-num', type: 'number', min: 0, max: 1, step: 0.05, value: s.weight == null ? '' : s.weight, onChange: function (e) { patch(i, 'weight', e.target.value === '' ? undefined : Number(e.target.value)) } })),
              h('label', null, t('label.tier'), h('select', { value: s.tier || '', onChange: function (e) { patch(i, 'tier', e.target.value || undefined) } }, [h('option', { key: '', value: '' }, '–')].concat(TIERS.map(function (x) { return h('option', { key: x, value: x }, x) })))),
              h('label', null, t('label.group'), h('input', { className: 'nw-in nw-cat', value: s.group || '', onChange: function (e) { patch(i, 'group', e.target.value) } }))),
            h('input', { className: 'nw-in nw-url', value: s.url || '', placeholder: t('ph.url'), onChange: function (e) { patch(i, 'url', e.target.value) } }),
            h('div', { className: 'nw-src-ch' },
              h('span', { className: 'nw-muted' }, t('label.channels')),
              chans.map(function (ch) {
                var on = (s.channels || []).indexOf(ch) >= 0
                return h('label', { key: ch, className: 'nw-chip' + (on ? ' nw-on' : '') },
                  h('input', { type: 'checkbox', checked: on, style: { display: 'none' }, onChange: function () { toggleChannel(i, ch) } }), ch)
              })),
            s.note ? h('div', { className: 'nw-muted' }, s.note) : null,
            s.health ? h('div', { className: 'nw-muted' }, t('head.health') + ': ' + s.health.ok + '/' + s.health.tries + (s.health.last_ok_channel ? ' · ✓' + s.health.last_ok_channel : '') + (s.health.last_error_kind ? ' · ✗' + s.health.last_error_kind : '') + (s.health.last_try ? ' · ' + ago(s.health.last_try) : '') + ' · ' + t('txt.signals') + ': ' + ((s.health.signals || []).map(sigLabel).join('/') || t('txt.noSignals'))) : null,
            tr && tr.phase === 'done' ? TestResult(tr.res) : null)
        })),
        h('datalist', { id: 'nw-cats' }, (doc.categories || []).map(function (c) { return h('option', { key: c, value: c }) })))
    }

    function TestResult(r) {
      if (!r) return null
      var sig = Object.keys(r.signals || {})
      return h('div', { className: 'nw-test' + (r.ok ? '' : ' nw-test-bad') },
        h('div', null, (r.ok ? '✓ ' : '✗ ') + t('txt.parsed') + ' ' + (r.parsed ?? 0) + ' · ' + t('txt.kept') + ' ' + (r.kept ?? 0) + (r.parsed_by ? ' · ' + r.parsed_by : '') + (r.error ? ' · ' + r.error : '')),
        (r.attempts || []).length ? h('div', { className: 'nw-muted' }, t('txt.chain') + ': ' + r.attempts.map(function (a) { return a.channel + (a.backend ? '/' + a.backend : '') + '=' + (a.ok ? 'ok' : (a.error_kind || 'fail')) }).join(' → ')) : null,
        h('div', { className: 'nw-muted' }, t('txt.signals') + ': ' + (sig.length ? sig.map(function (k) { return sigLabel(k) + '×' + r.signals[k] }).join(' ') : t('txt.noSignals'))),
        (r.attempts || []).filter(function (a) { return !a.ok && a.hint }).slice(0, 2).map(function (a, i) { return h('div', { key: 'hint' + i, className: 'nw-hint' }, '→ ' + a.channel + ': ' + a.hint) }),
        h('ul', { className: 'nw-test-items' }, (r.items || []).map(function (it, i) {
          return h('li', { key: i }, h('span', { className: 'nw-time' }, (it.published_at || '~') + ' '), h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.title), ' ', SignalChips(it.signals))
        })))
    }


    // ------------------------------------------------------------------ 运行
    function ScheduleCard(props) {
      var s = props.schedule
      var body
      if (!s) body = h('span', { className: 'nw-muted' }, '…')
      else if (!s.available) body = h('span', { className: 'nw-muted' }, t('txt.noScheduleSvc'))
      else {
        var rows = s.tasks && s.tasks.length ? s.tasks : [{ pack: 'core', task: s.task }]
        body = h('div', { className: 'nw-plainrows' }, rows.map(function (r) {
          var name = (props.packs && props.packs[r.pack] && (props.packs[r.pack].title || props.packs[r.pack].name)) || r.pack
          return h('div', { key: r.pack, className: 'nw-card-meta' }, h('b', null, name), r.task
            ? [h(Chip, { key: 'st', tone: r.task.status === 'active' ? 'ok' : 'warn' }, r.task.status), h('span', { key: 'n', className: 'nw-muted' }, t('txt.next') + ' ' + (r.task.scheduledAt ? when(r.task.scheduledAt) : '–'))]
            : h('span', { className: 'nw-muted' }, t('txt.noSchedule') + ' — ' + t('txt.scheduleHint') + (r.pack !== 'core' ? '（pack="' + r.pack + '"）' : '')))
        }))
      }
      return h(Section, { title: t('head.schedule') }, h('div', { className: 'nw-card-static' }, body))
    }

    /** 模型：模式开关（LLM / 节省 token）与 harness 里可用的模型，选了即保存。 */
    function ModelCard(props) {
      var dPair = useState({ phase: 'idle', model: null, providers: [], note: '', error: null })
      var d = dPair[0]
      var setD = dPair[1]
      useEffect(function () {
        getJson(API.model).then(function (res) { setD({ phase: 'ready', model: res.model, providers: res.providers || [], usage: res.usage || null, note: '', error: res.catalog_error || null }) })
          .catch(function (e) { setD({ phase: 'error', model: null, providers: [], note: '', error: e.message }) })
      }, [props.stamp])
      function save(body) {
        setIn(setD, { note: '…' })
        postJson(API.model, body).then(function (res) { setD({ phase: 'ready', model: res.model, providers: res.providers || [], usage: res.usage || null, note: t('model.saved'), error: null }); if (props.onChange) props.onChange() })
          .catch(function (e) { setIn(setD, { note: '', error: (e.data && e.data.error) || e.message }) })
      }
      var m = d.model
      if (!m) return h(Section, { title: t('head.model') }, h('div', { className: 'nw-card-static nw-muted' }, d.error || '…'))
      var def = m.default ? m.default.provider + '/' + m.default.model : null
      var value = m.pinned ? m.pinned.provider + '\u0001' + m.pinned.model : ''
      var options = [h('option', { key: '', value: '' }, def ? t('model.default', { m: def }) : t('model.defaultNone'))].concat((d.providers || []).filter(function (pr) { return pr.models && pr.models.length }).map(function (pr) {
        return h('optgroup', { key: pr.id, label: pr.name }, pr.models.map(function (x) { return h('option', { key: x.id, value: pr.id + '\u0001' + x.id, title: x.description || '' }, x.name) }))
      }))
      if (m.pinned && !(d.providers || []).some(function (pr) { return pr.id === m.pinned.provider && (pr.models || []).some(function (x) { return x.id === m.pinned.model }) })) options.push(h('option', { key: 'cur', value: value }, m.pinned.provider + '/' + m.pinned.model))
      var last = m.last
      return h(Section, { title: t('head.model') }, h('div', { className: 'nw-card-static nw-modelcard' },
        h('div', { className: 'nw-model-row' },
          h(Seg, { value: m.mode, onChange: function (v) { save({ mode: v }) }, options: [['llm', t('mode.llm')], ['economy', t('mode.economy')]] }),
          d.note ? h('span', { className: 'nw-saved' }, d.note) : null),
        h('div', { className: 'nw-muted' }, m.mode === 'llm' ? t('mode.llmDesc') : t('mode.economyDesc')),
        m.mode === 'llm' ? h('label', { className: 'nw-model-row' }, h('span', { className: 'nw-muted' }, t('model.pick')),
          h('select', { className: 'nw-in nw-model-sel', value: value, onChange: function (e) { var v = e.target.value; if (!v) save({ provider: '', model: '' }); else { var parts = v.split('\u0001'); save({ provider: parts[0], model: parts[1] }) } } }, options)) : null,
        m.mode === 'llm' ? h('div', { className: 'nw-xs ' + (m.ready ? 'nw-okc' : 'nw-warn') }, !m.service ? t('model.noService') : m.ready ? '✓ ' + t('model.ready', { m: m.label }) : t('model.notReady')) : null,
        m.mode === 'llm' ? h('div', { className: 'nw-model-row' }, h('span', { className: 'nw-muted' }, t('rt.depth')),
          h(Seg, { value: m.depth, onChange: function (v) { save({ depth: v }) }, options: [['lean', t('rt.lean')], ['balanced', t('rt.balanced')], ['deep', t('rt.deep')]] })) : null,
        m.mode === 'llm' && m.depths && m.depths[m.depth] ? h('div', { className: 'nw-muted nw-xs' }, t('rt.depthDesc', { r: m.depths[m.depth].maxItems, w: m.depths[m.depth].maxStories, a: m.depths[m.depth].autoAnalyze, t: m.depths[m.depth].translate })) : null,
        m.mode === 'llm' ? h('label', { className: 'nw-model-row' }, h('span', { className: 'nw-muted' }, t('rt.budget')),
          h('input', { className: 'nw-in nw-num', type: 'number', min: 0, step: 50000, defaultValue: m.daily_tokens || 0, onBlur: function (e) { var v = Number(e.target.value) || 0; if (v !== (m.daily_tokens || 0)) save({ daily_tokens: v }) } }),
          h('span', { className: 'nw-muted nw-xs' }, t('rt.budgetHint'))) : null,
        d.usage ? h('div', { className: 'nw-usage' },
          h('div', null, h('b', null, t('rt.today')), ' ', t('rt.todayLine', { c: d.usage.calls, i: fmtN(d.usage.tokens_in), o: fmtN(d.usage.tokens_out), k: fmtN(d.usage.tokens_cache) }) + (d.usage.cache_rate != null ? ' · ' + t('rt.cacheRate', { p: d.usage.cache_rate }) : '') + (d.usage.estimated ? ' · ' + t('rt.est') : '') + (m.daily_tokens ? ' · ' + t('rt.ofBudget', { p: Math.round(100 * d.usage.total / m.daily_tokens) }) : '')),
          (d.usage.steps || []).length ? h('div', { className: 'nw-muted nw-xs' }, d.usage.steps.map(function (x) { return t('rt.step.' + x.step) + ' ' + fmtN((x.tin || 0) + (x.tout || 0) + (x.tcache || 0)) }).join(' · ')) : null) : null,
        m.speed && m.speed.calls ? h('div', { className: 'nw-muted nw-xs' }, t('rt.speed', { t: Math.round(m.speed.tps || 0), s: Math.round((m.speed.ms || 0) / 1000) }) + ' · ' + (m.speed.concurrency ? t('rt.conc', { n: m.speed.concurrency }) : t('rt.concProbe')) + (m.speed.probe ? ' ' + t('rt.probe', { e: m.speed.probe.efficiency }) : '')) : null,
        m.busy ? h('div', { className: 'nw-note' }, t('model.busy')) : null,
        last ? h('div', { className: 'nw-muted nw-xs' }, t('model.last') + '：' + [when(last.at), last.model, last.items_read != null ? t('ed.read', { n: last.items_read }) : '', last.calls != null ? t('model.calls', { n: last.calls }) : '', last.fresh_items != null ? t('model.incr', { f: last.fresh_items, r: last.reused || 0 }) : '', last.ms ? Math.round(last.ms / 1000) + 's' : ''].filter(Boolean).join(' · ') + (last.error ? ' · ⚠ ' + last.error : '')) : null,
        d.error ? h('div', { className: 'nw-error' }, d.error) : null))
    }

    function RunsTab(props) {
      var dPair = useState({ phase: 'idle', runs: [], attempts: [], run_id: null, continuity: [], gaps: [], pushes: [] })
      var d = dPair[0]
      var setD = dPair[1]
      var load = useCallback(function (runId) {
        setIn(setD, { phase: 'busy' })
        return postJson(API.attempts, { run_id: runId || undefined, runs: 20, limit: 400 })
          .then(function (res) { setD({ phase: 'ready', runs: res.runs || [], attempts: res.attempts || [], run_id: res.run_id, continuity: res.continuity || [], gaps: res.gaps || [], pushes: res.pushes || [] }) })
          .catch(function (e) { setIn(setD, { phase: 'error', error: e.message }) })
      }, [])
      useEffect(function () { load() }, [props.stamp])
      var s = props.summary
      return h('div', { className: 'nw-runs' },
        h(VersionSection, null),
        h(ModelCard, { stamp: props.stamp }),
        h(ContentCard, { stamp: props.stamp }),
        h(QualityCard, { stamp: props.stamp }),
        h(ScheduleCard, { schedule: props.schedule, packs: props.packs }),
        h(Section, {
          title: t('head.continuity'),
          aside: h('select', { className: 'nw-in', value: d.run_id || '', onChange: function (e) { load(e.target.value) } },
            (d.runs || []).map(function (r) { return h('option', { key: r.run_id, value: r.run_id }, when(r.started_at) + ' · ' + r.mode + ' · ' + (r.sources_ok ?? 0) + '/' + ((r.sources_ok ?? 0) + (r.sources_failed ?? 0))) })),
        },
          (d.continuity || []).length ? h('div', { className: 'nw-chips' }, d.continuity.map(function (c) {
            var tone = c.status === 'gap_open' || c.status === 'failed' ? 'hot' : c.status === 'gap_partial' ? 'warn' : c.status === 'snapshot' ? 'dim' : 'ok'
            return h(Chip, { key: c.source_id, tone: tone, title: c.note || '' }, c.source_id + ' · ' + t('cont.' + c.status) + (c.pages > 1 ? ' · p' + c.pages : '') + (c.backfilled ? ' · +' + c.backfilled : ''))
          })) : Empty({ children: '–' })),
        h(Section, { title: t('head.gaps') },
          (d.gaps || []).length === 0 ? Empty({ children: t('txt.noGaps') }) : h('ul', { className: 'nw-plain' }, d.gaps.map(function (g, i) {
            return h('li', { key: i }, h('b', null, g.source_id), ' ', when(g.gap_from) + ' → ' + when(g.gap_to) + ' · ' + g.status + ' · ' + (g.method || '') + (g.recovered ? ' · +' + g.recovered : ''))
          }))),
        (d.pushes || []).length ? h(Section, { title: t('head.recentPushes') },
          h('ul', { className: 'nw-plain' }, d.pushes.map(function (p, i) {
            return h('li', { key: i }, h('span', { className: 'nw-time' }, when(p.pushed_at) + ' '), h('a', { className: 'nw-link', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, p.title || p.article_id), h('span', { className: 'nw-muted' }, ' · ' + (p.reason || '')))
          }))) : null,
        s && (s.failed || []).length ? h(Section, { title: t('head.failed') },
          h('ul', { className: 'nw-plain' }, s.failed.map(function (f, i) {
            return h('li', { key: i }, h('b', null, f.source_id + ' · ' + f.channel + ' · ' + (f.error_kind || '?')), h('div', { className: 'nw-muted' }, f.error || ''), f.hint ? h('div', { className: 'nw-hint' }, '→ ' + f.hint) : null)
          }))) : null,
        h(Section, { title: t('head.attempts') },
          h('div', { className: 'nw-table-wrap' }, h('table', { className: 'nw-table' },
            h('thead', null, h('tr', null, ['source', 'channel', 'ok', 'http', 'items', 'ms', 'error_kind', 'note / hint'].map(function (k) { return h('th', { key: k }, k) }))),
            h('tbody', null, (d.attempts || []).map(function (a, i) {
              return h('tr', { key: i, className: a.ok ? '' : 'nw-bad' },
                h('td', null, a.source_id), h('td', null, a.channel + (a.backend ? '/' + a.backend : '')), h('td', null, a.ok ? '✓' : '×'),
                h('td', null, a.http_status == null ? '' : String(a.http_status)), h('td', null, a.items == null ? '' : String(a.items)),
                h('td', null, a.latency_ms == null ? '' : String(a.latency_ms)), h('td', null, a.error_kind || ''),
                h('td', { className: 'nw-hintcell' }, a.ok ? (a.note || '') : (a.error || '') + (a.hint ? ' → ' + a.hint : '')))
            }))))),
        h('details', { className: 'nw-details' }, h('summary', null, t('head.digest')), h('pre', { className: 'nw-digest' }, props.digest || t('txt.digestEmpty'))))
    }

    // ------------------------------------------------------------------ 版本与更新（做法同 dsh-switchboard）
    var CHECK_TTL_MS = 60 * 60 * 1000
    var updCache = null
    var updListeners = []
    function checkForUpdate(force) {
      if (!force && updCache && Date.now() - updCache.at < CHECK_TTL_MS) return updCache.value
      var manager = remotes.pluginManager
      var value = Promise.resolve(manager ? manager.listBundles().catch(function () { return null }) : null).then(function (listed) {
        var bundle = listed && listed.ok === true ? (listed.value || []).find(function (x) { return x.name === PACKAGE }) : null
        return postJson(API.updateCheck, Object.assign({ force: Boolean(force) }, bundle && bundle.source ? { source: bundle.source } : {})).then(function (res) {
          return Object.assign({}, res, { hostUpdates: Boolean(bundle && bundle.updatable === true), manager: Boolean(manager) })
        })
      })
      updCache = { at: Date.now(), value: value }
      value.then(function (r) { updListeners.slice().forEach(function (fn) { fn(r) }) }, function () { updCache = null })
      return value
    }
    function useUpdateCheck() {
      var vPair = useState(null)
      useEffect(function () {
        var live = true
        var fn = function (r) { if (live) vPair[1](r) }
        updListeners.push(fn)
        checkForUpdate(false).then(fn, function () {})
        return function () { live = false; updListeners = updListeners.filter(function (x) { return x !== fn }) }
      }, [])
      return vPair[0]
    }
    function applyUpdate(check, approvedBuilds) {
      var manager = remotes.pluginManager
      var latest = check.latest
      if (!manager) return Promise.resolve({ kind: 'failed', message: t('txt.noManager') })
      if (!latest) return Promise.resolve({ kind: 'failed', message: 'no newer release' })
      if (!check.source || check.source.kind !== 'github') return Promise.resolve({ kind: 'failed', message: t('txt.npmHint') })
      var rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)
      return manager.installBundle(latest.spec, Object.assign({ enabled: true, requestId: rid }, approvedBuilds ? { approvedBuilds: approvedBuilds } : {})).then(function (answer) {
        if (!answer || !answer.ok) return { kind: 'failed', message: (answer && answer.error && answer.error.message) || 'install failed' }
        var r = answer.value || {}
        if (r.application === 'applied' || r.application === 'overridden') return { kind: 'applied', version: r.version || latest.version }
        if (r.application === 'restart-required') return { kind: 'restart', version: r.version || latest.version }
        if (r.pendingBuilds && r.pendingBuilds.length && !approvedBuilds) return { kind: 'approval', builds: r.pendingBuilds }
        var out = r.packageResult && r.packageResult.output ? String(r.packageResult.output).trim().split('\n').slice(-3).join('\n') : ''
        return { kind: 'failed', message: [(r.error && (r.error.diagnostic || r.error.code)) || r.application, out].filter(Boolean).join('\n') }
      })
    }

    function VersionSection() {
      var shared = useUpdateCheck()
      var cPair = useState(null)
      var check = cPair[0] || shared
      var setCheck = cPair[1]
      var pPair = useState({ kind: 'idle' })
      var phase = pPair[0]
      var setPhase = pPair[1]
      useEffect(function () {
        if (phase.kind !== 'done') return
        var timer = setTimeout(function () { location.reload() }, 1800)
        return function () { clearTimeout(timer) }
      }, [phase.kind])
      if (!check) return h(Section, { title: t('head.version') }, h('div', { className: 'nw-card-static nw-muted' }, t('txt.checking')))
      function recheck() {
        setPhase({ kind: 'checking' })
        checkForUpdate(true).then(function (v) { setCheck(v); setPhase({ kind: 'idle' }) }, function (e) { setPhase({ kind: 'failed', message: String(e && e.message ? e.message : e) }) })
      }
      function update(approved) {
        setPhase({ kind: 'updating' })
        applyUpdate(check, approved).then(function (o) {
          if (o.kind === 'applied') setPhase({ kind: 'done', version: o.version })
          else if (o.kind === 'restart') setPhase({ kind: 'restart', version: o.version })
          else if (o.kind === 'approval') setPhase({ kind: 'approval', builds: o.builds })
          else setPhase({ kind: 'failed', message: o.message })
        }, function (e) { setPhase({ kind: 'failed', message: String(e && e.message ? e.message : e) }) })
      }
      var src = check.source || { kind: 'unknown' }
      var srcLabel = src.kind === 'github' ? 'GitHub · ' + src.owner + '/' + src.repo : src.kind === 'npm' ? 'npm · ' + src.name : src.kind === 'local' ? t('txt.srcLocal') : t('txt.srcUnknown')
      var latest = check.latest
      var busy = phase.kind === 'checking' || phase.kind === 'updating'
      var status
      if (phase.kind === 'checking') status = h('span', null, t('txt.checking'))
      else if (phase.kind === 'updating') status = h('span', null, t('txt.updating'))
      else if (phase.kind === 'done') status = h('span', { className: 'nw-okc' }, t('txt.updated') + ' v' + phase.version + ' · ' + t('txt.reloading'))
      else if (phase.kind === 'restart') status = h('span', { className: 'nw-warn' }, t('txt.restart', { v: phase.version }))
      else if (phase.kind === 'failed') status = h('span', { className: 'nw-error' }, t('txt.updateFailed') + ': ' + phase.message)
      else if (check.hostUpdates) status = h('span', { className: 'nw-muted' }, t('txt.hostUpdates'))
      else if (check.error) status = h('span', { className: 'nw-error' }, t('txt.checkFailed') + ': ' + check.error)
      else if (src.kind === 'local' || src.kind === 'unknown') status = h('span', { className: 'nw-muted' }, src.kind === 'local' ? t('txt.localSrc') : t('txt.unknownSrc'))
      else if (check.newer && latest) status = h('span', { className: 'nw-newc' }, t('txt.newVersion') + ' v' + latest.version + (latest.summary ? ' · ' + latest.summary : '') + (latest.date ? ' · ' + when(latest.date) : ''))
      else status = h('span', { className: 'nw-okc' }, t('txt.upToDate') + ' · ' + t('txt.checkedAt') + ' ' + hhmm(new Date(check.checkedAt).toISOString()))
      var canUpdate = !check.hostUpdates && src.kind === 'github' && check.newer && latest && phase.kind !== 'done' && phase.kind !== 'approval'
      return h(Section, { title: t('head.version') }, h('div', { className: 'nw-card-static nw-version' },
        h('div', { className: 'nw-version-head' },
          h('span', null, h('b', null, 'v' + check.installed), h('span', { className: 'nw-muted' }, ' · ' + srcLabel)),
          h('span', { className: 'nw-actions' },
            canUpdate ? h('button', { className: 'nw-btn nw-primary nw-sm', disabled: busy, onClick: function () { update() } }, t('btn.update') + ' v' + latest.version) : null,
            latest && check.newer ? h('a', { className: 'nw-btn nw-ghost nw-sm', href: latest.url, target: '_blank', rel: 'noreferrer' }, t('btn.relnotes')) : null,
            h('button', { className: 'nw-btn nw-ghost nw-sm', disabled: busy, onClick: recheck }, t('btn.check')))),
        h('div', { role: 'status', className: 'nw-version-status' }, status),
        src.kind === 'npm' && check.newer && !check.hostUpdates ? h('div', { className: 'nw-muted' }, t('txt.npmHint')) : null,
        phase.kind === 'approval' ? h('div', { className: 'nw-callout nw-warnbox' },
          h('div', null, t('txt.approveHint')),
          h('pre', { className: 'nw-mono nw-xs' }, phase.builds.join('\n')),
          h('span', { className: 'nw-actions' },
            h('button', { className: 'nw-btn nw-primary nw-sm', onClick: function () { update(phase.builds) } }, t('btn.approve')),
            h('button', { className: 'nw-btn nw-ghost nw-sm', onClick: function () { setPhase({ kind: 'idle' }) } }, t('btn.cancel')))) : null))
    }

    /** 顶部的新版本提示：只在 GitHub 安装、有新版本、且宿主不自己管更新时出现。 */
    function UpdateBanner(props) {
      var check = useUpdateCheck()
      if (!check || !check.newer || !check.latest || check.hostUpdates) return null
      return h('div', { className: 'nw-banner' },
        h('span', null, '⬆ ' + t('txt.newBanner', { v: check.latest.version }) + (check.latest.summary ? ' · ' + check.latest.summary : '')),
        h('button', { className: 'nw-btn nw-ghost nw-sm', onClick: props.onGo }, t('txt.goUpdate')))
    }

    // ------------------------------------------------------------------ 页面壳
    /** 顶部一行：什么时候更新的；有问题才说（点一下去「运行」）。细节都在「运行」里。 */
    function StatusLine(props) {
      var s = props.summary
      if (!s || !s.latest_run) return h('span', { className: 'nw-status' }, t('txt.noRun'))
      var r = s.latest_run
      var c = s.continuity || {}
      var gaps = (c.gap_open || 0) + (c.gap_partial || 0)
      var probs = []
      if (r.sources_failed) probs.push(t('st.failed', { n: r.sources_failed }))
      if (gaps) probs.push(t('st.gaps', { n: gaps }))
      if (s.stale) probs.push(t('st.stale'))
      if ((s.content_degraded || []).length) probs.push(t('st.thin', { s: s.content_degraded.slice(0, 2).join('、') }))
      return h('span', { className: 'nw-status' },
        h('span', null, t('st.updated', { t: when(r.finished_at || r.started_at) })),
        probs.length ? h('button', { className: 'nw-st-warn', onClick: props.onGo }, '⚠ ' + probs.join(' · ')) : null)
    }

    var TABS = [['today', 'tab.today'], ['track', 'tab.track'], ['daily', 'tab.daily'], ['follows', 'tab.follows']]
    var TOOL_TABS = [['events', 'tab.events'], ['timeline', 'tab.timeline'], ['items', 'tab.items'], ['sources', 'tab.sources'], ['runs', 'tab.runs']]
    var NEWS_VIEW = { today: 'edition', daily: 'daily', follows: 'follows', events: 'events' }

    function Page() {
      var savedTab = store('tab')
      var tabPair = useState(savedTab === 'news' || !savedTab ? 'today' : savedTab)
      var tab = tabPair[0]
      var setTab = tabPair[1]
      var dataPair = useState({ summary: null, digest: '', sources: null, taxonomy: null, schedule: null, phase: 'loading', error: null, stamp: 0 })
      var data = dataPair[0]
      var setData = dataPair[1]
      var busyPair = useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var notePair = useState('')
      var note = notePair[0]
      var setNote = notePair[1]

      var reload = useCallback(function () {
        return Promise.all([
          getJson(API.summary).catch(function (e) { return { error: e.message } }),
          fetch(API.digest, { credentials: 'include' }).then(function (r) { return r.ok ? r.text() : '' }).catch(function () { return '' }),
          getJson(API.sources).catch(function (e) { return { error: e.message } }),
          getJson(API.taxonomy).catch(function () { return null }),
          getJson(API.schedule).catch(function () { return null }),
        ]).then(function (res) {
          setData(function (prev) {
            return { summary: res[0] && !res[0].error ? res[0] : null, digest: res[1] || '', sources: res[2] && !res[2].error ? res[2] : null, taxonomy: res[3] || null, schedule: res[4] || null, phase: 'ready', error: res[0] ? res[0].error : null, stamp: (prev.stamp || 0) + 1 }
          })
        })
      }, [])

      useEffect(function () { reload() }, [reload])

      function pick(id) { setTab(id); store('tab', id) }
      function runNow() {
        setBusy(true)
        setNote('')
        return postJson(API.run, { window_hours: (data.summary && data.summary.window_hours) || 24 })
          .then(function (res) { setNote(res && res.ok ? '✓ ' + (res.run_id || '') : t('txt.runFailed') + ': ' + ((res && res.stage) || '')) })
          .catch(function (e) { setNote(e.status === 409 ? '⏳ ' + ((e.data && e.data.run_id) || '') : String(e.message)) })
          .then(function () { setBusy(false); return reload() })
      }

      var names = {}
      ;((data.taxonomy && data.taxonomy.labels) || []).forEach(function (top) { names[top.id] = top.name; (top.children || []).forEach(function (c) { names[c.id] = c.name }) })
      var common = { names: names, taxonomy: data.taxonomy, stamp: data.stamp, summary: data.summary, packs: (data.sources && data.sources.packs) || {}, reload: reload, ready: data.phase === 'ready' && !data.error }
      // 宿主的中间列不滚动：外层 .nw-scroll 撑满主面板并自己滚动，里面 .nw-root 居中限宽
      return h('div', { className: 'nw-scroll' }, h('div', { className: 'nw-root' },
        h('header', { className: 'nw-top' },
          h('div', { className: 'nw-title-wrap' }, h('span', { className: 'nw-h1' }, t('nav.panel')), h(StatusLine, { summary: data.summary, schedule: data.schedule, onGo: function () { pick('runs') } })),
          h('div', { className: 'nw-actions' },
            h('button', { className: 'nw-btn nw-ghost nw-sm', onClick: runNow, disabled: busy, title: t('btn.runHint') }, busy ? t('btn.running') : t('btn.run')))),
        h(UpdateBanner, { onGo: function () { pick('runs') } }),
        note ? h('div', { className: 'nw-note' }, note) : null,
        data.error ? h('div', { className: 'nw-error' }, 'host: ' + data.error) : null,
        h('nav', { className: 'nw-tabs', role: 'tablist' },
          TABS.map(function (x) { return h('button', { key: x[0], role: 'tab', 'aria-selected': tab === x[0], className: 'nw-tab' + (tab === x[0] ? ' nw-cur' : ''), onClick: function () { pick(x[0]) } }, t(x[1])) }),
          h('span', { className: 'nw-tabs-gap' }),
          TOOL_TABS.map(function (x) { return h('button', { key: x[0], role: 'tab', 'aria-selected': tab === x[0], className: 'nw-tab nw-tab-tool' + (tab === x[0] ? ' nw-cur' : ''), onClick: function () { pick(x[0]) } }, t(x[1])) })),
        h(TabErrorBoundary, null,
          NEWS_VIEW[tab] ? h(NewsTab, Object.assign({ key: tab, view: NEWS_VIEW[tab], sources: data.sources }, common)) : null,
          tab === 'track' ? h(TrackTab, common) : null,
          tab === 'timeline' ? h(TimelineTab, common) : null,
          tab === 'items' ? h(ItemsTab, Object.assign({ sources: data.sources }, common)) : null,
          tab === 'sources' ? h(SourcesTab, { sources: data.sources, reload: reload }) : null,
          tab === 'runs' ? h(RunsTab, Object.assign({ schedule: data.schedule, digest: data.digest }, common)) : null)))
    }

    function PanelIcon() {
      return h('svg', { viewBox: '0 0 64 64', width: 20, height: 20, fill: 'none', stroke: 'currentColor', strokeWidth: 3 },
        h('rect', { x: 8, y: 12, width: 42, height: 40, rx: 6 }),
        h('path', { d: 'M50 20h6v32a6 6 0 0 1-6 6H14' }),
        h('path', { d: 'M16 22h26M16 30h26M16 38h18' }))
    }

    // ------------------------------------------------------------------ 样式（只用宿主主题变量；括号里的颜色是独立预览时的兜底）
    var C = {
      bg: 'var(--dsw-alias-bg-layer-1,#fff)', bg2: 'var(--dsw-alias-bg-layer-2,#f6f7f9)', line: 'var(--dsw-alias-border-l2,#0000001a)', line1: 'var(--dsw-alias-border-l1,#0000000f)',
      hover: 'var(--dsw-alias-interactive-bg-hover,#0000000a)', active: 'var(--dsw-alias-interactive-bg-active,#00000014)',
      l1: 'var(--dsw-alias-label-primary,#111)', l2: 'var(--dsw-alias-label-secondary,#555)', l3: 'var(--dsw-alias-label-tertiary,#888)',
      accent: 'var(--dsw-alias-state-business-primary,#4d6bfe)', accentBg: 'var(--dsw-alias-state-business-tertiary,#4d6bfe1a)',
      ok: 'var(--dsw-alias-state-success-primary,#1a9f53)', okBg: 'var(--dsw-alias-state-success-tertiary,#1a9f531a)',
      warn: 'var(--dsw-alias-state-warn-primary,#d97706)', warnBg: 'var(--dsw-alias-state-warn-tertiary,#d977061a)',
      err: 'var(--dsw-alias-state-error-primary,#dc2626)', idle: 'var(--dsw-alias-state-idle-primary,#c4c7cc)', link: 'var(--dsw-alias-link,#4d6bfe)',
    }
    var CSS = [
      // 主面板是纵向弹性容器：滚动层占满剩余高度；顶部让出宿主窗口顶条（macOS 桌面版 48px，其它为 0）
      '.nw-scroll{flex:1;min-height:0;min-width:0;overflow-y:auto;overflow-x:hidden;padding-top:var(--dsh-frame-top-clearance,0px);box-sizing:border-box}',
      '.nw-root{container-type:inline-size;display:flex;flex-direction:column;gap:12px;width:100%;max-width:1240px;margin:0 auto;padding:16px clamp(12px,3cqi,24px) 28px;color:' + C.l1 + ';box-sizing:border-box;min-width:0}',
      '.nw-root *{box-sizing:border-box} .nw-root{color-scheme:light} body[data-ds-dark-theme] .nw-root{color-scheme:dark}',
      '.nw-root select,.nw-root input:not([type=checkbox]):not([type=radio]){background:' + C.bg + ';color:inherit;border:1px solid ' + C.line + ';border-radius:6px;padding:4px 6px;font:inherit;font-size:12px;max-width:100%}',
      '.nw-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.nw-title-wrap{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;min-width:0}',
      '.nw-h1{font-size:18px;font-weight:600}',
      '.nw-status{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:' + C.l2 + ';font-variant-numeric:tabular-nums}',
      '.nw-okc{color:' + C.ok + '} .nw-warn{color:' + C.warn + '} .nw-error{color:' + C.err + ';font-size:12px} .nw-note{font-size:12px;color:' + C.l2 + '}',
      '.nw-actions{display:flex;gap:6px}',
      '.nw-btn{border:1px solid ' + C.line + ';background:' + C.bg + ';color:inherit;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;line-height:1.2}',
      '.nw-btn:hover{background:' + C.hover + '} .nw-btn:disabled{opacity:.5;cursor:default}',
      '.nw-primary{background:' + C.accent + ';border-color:transparent;color:#fff} .nw-primary:hover{background:' + C.accent + ';filter:brightness(1.08)}',
      '.nw-ghost{background:transparent} .nw-danger{color:' + C.err + '}',
      '.nw-tabs{display:flex;gap:2px;border-bottom:1px solid ' + C.line + ';overflow-x:auto;scrollbar-width:none}',
      '.nw-tab{border:0;background:transparent;color:' + C.l2 + ';padding:8px 12px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}',
      '.nw-tab:hover{color:' + C.l1 + '} .nw-tab.nw-cur{color:' + C.l1 + ';font-weight:600;border-bottom-color:' + C.accent + '}',
      '.nw-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.nw-in{border:1px solid ' + C.line + ';background:' + C.bg + ';color:inherit;border-radius:8px;padding:5px 8px;font-size:12px;max-width:100%;min-width:0}',
      '.nw-search{flex:1 1 160px}',
      '.nw-seg{display:inline-flex;border:1px solid ' + C.line + ';border-radius:8px;overflow:hidden}',
      '.nw-seg button{border:0;background:' + C.bg + ';color:' + C.l2 + ';padding:5px 10px;font-size:12px;cursor:pointer} .nw-seg button+button{border-left:1px solid ' + C.line + '}',
      '.nw-seg button.nw-on{background:' + C.accentBg + ';color:' + C.accent + ';font-weight:600}',
      '.nw-check{display:inline-flex;gap:4px;align-items:center;font-size:12px;color:' + C.l2 + '}',
      '.nw-kw{display:flex;gap:6px;flex-wrap:wrap}',
      '.nw-chip{display:inline-flex;align-items:center;gap:3px;border:1px solid ' + C.line + ';border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;color:' + C.l2 + ';white-space:nowrap}',
      '.nw-chip-btn{background:transparent;cursor:pointer} .nw-chip-btn:hover{background:' + C.hover + '}',
      '.nw-chip.nw-ok{color:' + C.ok + ';background:' + C.okBg + ';border-color:transparent} .nw-chip.nw-info{color:' + C.accent + ';background:' + C.accentBg + ';border-color:transparent}',
      '.nw-chip.nw-warn{color:' + C.warn + ';background:' + C.warnBg + ';border-color:transparent} .nw-chip.nw-hot{color:' + C.err + ';border-color:transparent;background:' + C.warnBg + '}',
      '.nw-chip.nw-dim{color:' + C.l3 + '} .nw-chip.nw-on{background:' + C.accent + ';color:#fff;border-color:transparent}',
      '.nw-tag{font-size:11px;color:' + C.accent + '} .nw-muted{color:' + C.l3 + ';font-size:12px} .nw-time{font-size:11px;color:' + C.l3 + ';font-variant-numeric:tabular-nums}',
      '.nw-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.nw-empty{color:' + C.l3 + ';font-size:13px;padding:24px 0;text-align:center}',
      '.nw-split{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}',
      '.nw-list{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.nw-pane{display:none;min-width:0}',
      '.nw-has-sel .nw-pane{display:block} .nw-has-sel .nw-list{display:none} .nw-has-sel > .nw-filters, .nw-has-sel > .nw-kw, .nw-has-sel > .nw-bars, .nw-has-sel > .nw-runline{display:none}',
      '@container (min-width: 820px){.nw-split{grid-template-columns:minmax(0,5fr) minmax(0,6fr)} .nw-pane{display:block;position:sticky;top:8px} .nw-has-sel .nw-list{display:flex} .nw-back{display:none} .nw-has-sel > .nw-filters, .nw-has-sel > .nw-kw, .nw-has-sel > .nw-bars, .nw-has-sel > .nw-runline{display:flex}}',
      '.nw-card{display:flex;gap:12px;align-items:flex-start;text-align:left;width:100%;border:1px solid ' + C.line + ';border-left:3px solid ' + C.idle + ';background:' + C.bg + ';color:inherit;border-radius:10px;padding:10px 12px;cursor:pointer;font:inherit}',
      '.nw-card:hover{background:' + C.hover + '} .nw-card.nw-active{background:' + C.active + ';border-color:' + C.accent + '}',
      '.nw-card.nw-imp-hi{border-left-color:' + C.err + '} .nw-card.nw-imp-mid{border-left-color:' + C.warn + '}',
      '.nw-card-score{min-width:28px;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;color:' + C.l2 + ';line-height:1.3}',
      '.nw-card-body{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}',
      '.nw-card-title{font-size:14px;line-height:1.45;color:' + C.l1 + ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.nw-card-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0;font-size:12px}',
      '.nw-more{align-self:center} .nw-foot{font-size:11px;color:' + C.l3 + ';padding:6px 2px}',
      '.nw-detail{display:flex;flex-direction:column;gap:12px;border:1px solid ' + C.line + ';background:' + C.bg + ';border-radius:12px;padding:14px 16px;min-width:0}',
      '.nw-back{align-self:flex-start}',
      '.nw-detail-head{display:flex;gap:12px;align-items:flex-start}',
      '.nw-big-score{font-size:28px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:' + C.l3 + '} .nw-big-score.nw-imp-hi{color:' + C.err + '} .nw-big-score.nw-imp-mid{color:' + C.warn + '}',
      '.nw-detail-title{font-size:16px;font-weight:600;line-height:1.45;color:' + C.l1 + ';text-decoration:none;word-break:break-word;display:block;margin-bottom:6px} .nw-detail-title:hover{text-decoration:underline}',
      '.nw-detail-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}',
      '@container (min-width: 1080px){.nw-detail-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}',
      '.nw-sec{display:flex;flex-direction:column;gap:8px;min-width:0} .nw-sec-h{display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.nw-sec-h h4{margin:0;font-size:12px;font-weight:600;color:' + C.l2 + ';letter-spacing:.02em}',
      '.nw-factors{display:flex;flex-direction:column;gap:5px}',
      '.nw-factor{display:grid;grid-template-columns:72px minmax(0,1fr) 34px;gap:8px;align-items:center;font-size:12px}',
      '.nw-factor-k{color:' + C.l2 + '} .nw-factor-v{text-align:right;font-variant-numeric:tabular-nums;color:' + C.l2 + '}',
      '.nw-track{height:6px;background:' + C.bg2 + ';border-radius:999px;overflow:hidden} .nw-fill{display:block;height:100%;background:' + C.accent + ';border-radius:999px}',
      '.nw-spark{display:inline-flex;align-items:center;gap:8px;color:' + C.accent + '}',
      '.nw-members{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:10px}',
      '.nw-members li{display:flex;flex-direction:column;gap:3px;padding-left:10px;border-left:2px solid ' + C.line + '}',
      '.nw-link{color:' + C.l1 + ';text-decoration:none;font-size:13px;line-height:1.45;word-break:break-word} .nw-link:hover{color:' + C.link + ';text-decoration:underline}',
      '.nw-callout{border-radius:8px;padding:8px 10px;font-size:12px} .nw-warnbox{background:' + C.warnBg + ';color:' + C.warn + '}',
      '.nw-plain{margin:0;padding-left:16px;font-size:12px;display:flex;flex-direction:column;gap:5px;color:' + C.l2 + '} .nw-hint{color:' + C.warn + '}',
      '.nw-items{display:flex;flex-direction:column;gap:8px}',
      '.nw-item{border:1px solid ' + C.line + ';background:' + C.bg + ';border-radius:10px;padding:8px 12px;display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.nw-sum{font-size:12px;color:' + C.l2 + ';line-height:1.5;word-break:break-word} .nw-count{margin:2px 0}',
      '.nw-bars{display:flex;gap:6px;align-items:flex-end;overflow-x:auto;padding:4px 2px 2px;min-height:96px;scrollbar-width:thin}',
      '.nw-bar{display:flex;flex-direction:column;align-items:center;gap:3px;border:0;background:transparent;color:' + C.l2 + ';padding:4px 2px;border-radius:8px;cursor:pointer;min-width:42px;font:inherit}',
      '.nw-bar:hover{background:' + C.hover + '} .nw-bar.nw-on{background:' + C.active + '}',
      '.nw-bar-col{width:18px;border-radius:4px 4px 2px 2px;background:' + C.accent + ';opacity:.75} .nw-bar.nw-on .nw-bar-col{opacity:1} .nw-bar-col.nw-bad{background:' + C.warn + '}',
      '.nw-bar-n{font-size:10px;color:' + C.l3 + ';font-variant-numeric:tabular-nums} .nw-bar-t{font-size:11px;font-variant-numeric:tabular-nums} .nw-bar-mark{font-size:10px;min-height:13px}',
      '.nw-runline{font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.nw-runs{display:flex;flex-direction:column;gap:16px} .nw-plainrows{display:flex;flex-direction:column;gap:6px}',
      '.nw-card-static{border:1px solid ' + C.line + ';background:' + C.bg + ';border-radius:10px;padding:10px 12px;font-size:13px}',
      '.nw-chips{display:flex;gap:6px;flex-wrap:wrap}',
      // 简报、主题分布、解读、版本
      '.nw-sm{padding:3px 9px;font-size:12px} .nw-xs{font-size:11px} .nw-newc{color:' + C.accent + ';font-weight:600}',
      '.nw-brief{border:1px solid ' + C.line + ';background:' + C.bg + ';border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;border-top:3px solid ' + C.accent + '}',
      '.nw-brief-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap} .nw-brief-h b{font-size:13px} .nw-brief-h .nw-btn{margin-left:auto}',
      '.nw-brief-link{display:flex;gap:6px;align-items:flex-start;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:0;line-height:1.5} button.nw-brief-link{cursor:pointer} button.nw-brief-link:hover{color:' + C.link + '}',
      '.nw-topics{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:6px}',
      '.nw-topic{display:grid;grid-template-columns:auto minmax(24px,1fr) auto;gap:6px;align-items:center;border:1px solid ' + C.line1 + ';background:' + C.bg + ';color:inherit;border-radius:8px;padding:4px 8px;font:inherit;font-size:12px;cursor:pointer;text-align:left}',
      '.nw-topic:hover{background:' + C.hover + '} .nw-topic.nw-on{border-color:' + C.accent + ';background:' + C.accentBg + '}',
      '.nw-topic-name{white-space:nowrap;color:' + C.l1 + '} .nw-topic-n{font-variant-numeric:tabular-nums;color:' + C.l3 + ';white-space:nowrap}',
      '.nw-topic-track{height:6px;background:' + C.bg2 + ';border-radius:999px;overflow:hidden} .nw-topic-fill{display:block;height:100%;border-radius:999px;background:' + C.idle + '}',
      '.nw-topic-fill.nw-imp-hi{background:' + C.err + '} .nw-topic-fill.nw-imp-mid{background:' + C.warn + '}',
      '.nw-card-sum{font-size:12px;line-height:1.5;color:' + C.l2 + ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.nw-notes{border-radius:10px;padding:10px 12px;background:' + C.accentBg + ';display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.55}',
      '.nw-notes-empty{background:' + C.bg2 + ';flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap}',
      '.nw-notes-h{display:flex;align-items:center;gap:8px} .nw-notes-h b{color:' + C.accent + ';font-size:12px} .nw-notes-h .nw-btn{margin-left:auto}',
      '.nw-notes-sum{margin:0;color:' + C.l1 + ';font-weight:500} .nw-notes-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;color:' + C.l2 + '} .nw-notes-k{color:' + C.l3 + ';font-size:12px}',
      '.nw-version{display:flex;flex-direction:column;gap:6px} .nw-version-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap} .nw-version-status{font-size:12px}',
      '.nw-version .nw-actions{flex-wrap:wrap} a.nw-btn{text-decoration:none;display:inline-flex;align-items:center}',
      '.nw-banner{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;border-radius:10px;padding:6px 10px;background:' + C.accentBg + ';color:' + C.accent + ';font-size:12px}',
      '.nw-has-sel > .nw-topics{display:none}',
      '@container (min-width: 820px){.nw-has-sel > .nw-topics{display:grid}}',
      // 版面
      '.nw-edition{display:flex;flex-direction:column;gap:14px}',
      '.nw-ed-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap} .nw-ed-head > b{font-size:13px} .nw-ed-head .nw-btn{margin-left:auto}',
      // 版块按两栏瀑布流排（各栏高度更均衡）；窄屏一栏
      '.nw-refs{display:inline-flex;gap:3px;margin-left:4px;vertical-align:1px} .nw-ref{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;background:' + C.bg2 + ';color:' + C.l3 + ';text-decoration:none;white-space:nowrap} .nw-ref:hover{color:' + C.link + '}',
      '.nw-story-acts{display:inline-flex;gap:4px;margin-left:auto} .nw-mini{border:1px solid ' + C.line + ';background:transparent;color:' + C.l3 + ';border-radius:6px;padding:0 6px;font:inherit;font-size:11px;line-height:18px;cursor:pointer} .nw-mini:hover{color:' + C.l1 + ';background:' + C.hover + '} .nw-mini.nw-on{color:' + C.accent + ';border-color:' + C.accent + '}',
      '.nw-follows{display:flex;flex-direction:column;gap:14px} .nw-fl-add{display:flex;flex-direction:column;gap:8px} .nw-fl-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px} .nw-fl-list li{display:flex;gap:8px;align-items:center;font-size:13px} .nw-fl-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.nw-since{border:1px solid ' + C.line + ';border-left:3px solid ' + C.warn + ';background:' + C.bg + ';border-radius:10px;padding:10px 12px;font-size:13px;display:flex;flex-direction:column;gap:6px} .nw-since ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}',
      '.nw-ct-filtered{display:flex;flex-direction:column;gap:4px;margin-top:10px} .nw-ct-filtered ul{margin:0;padding:0;list-style:none} .nw-ct-li{display:block!important;padding:7px 0!important;border-top:1px solid ' + C.line1 + ';font-size:13px;line-height:1.6}',
      '.nw-sources{display:flex;flex-direction:column;gap:14px;padding-top:4px} .nw-sb{display:flex;flex-direction:column;gap:10px;max-width:980px}',
      '.nw-sb-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap} .nw-sb-title{margin:0 0 4px} .nw-sb-head p{margin:0;max-width:640px;line-height:1.6} .nw-sb-sum{display:flex;gap:10px;align-items:center;font-size:12px}',
      '.nw-sb-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}',
      '.nw-sb-row{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid ' + C.line1 + ';flex-wrap:wrap} .nw-sb-off .nw-sb-name b{color:' + C.l3 + '}',
      '.nw-sb-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 360px} .nw-sb-name{display:flex;gap:8px;align-items:baseline;font-size:14px} .nw-sb-why{font-size:13px;color:' + C.l2 + ';line-height:1.6}',
      '.nw-sb-v{font-size:11px;font-weight:600;padding:0 6px;border-radius:4px;background:' + C.hover + ';color:' + C.l2 + '} .nw-sb-v-core{background:' + C.okBg + ';color:' + C.ok + '} .nw-sb-v-support{background:' + C.accentBg + ';color:' + C.accent + '} .nw-sb-v-low,.nw-sb-v-unstable{background:' + C.warnBg + ';color:' + C.warn + '}',
      '.nw-sb-ctl{display:flex;flex-direction:column;align-items:flex-end;gap:4px} .nw-sb-sug{color:' + C.link + '!important;font-size:12px}',
      '.nw-adv-toggle{align-self:flex-start;font-size:13px!important;color:' + C.l2 + '!important;padding-left:0!important}',
      '.nw-tl2-orig{font-size:11px;color:' + C.l3 + ';line-height:1.5}',
      '.nw-ticks ul{gap:6px!important} .nw-tick{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 8px;text-decoration:none;color:inherit;font-size:12px;line-height:1.5} .nw-tick b{font-weight:600;grid-column:1} .nw-tick span{grid-column:1;color:' + C.l2 + '} .nw-tick time{grid-column:2;grid-row:1;color:' + C.l3 + ';font-variant-numeric:tabular-nums} .nw-tick:hover b{color:' + C.link + '}',
      '.nw-push{display:flex;flex-direction:column;gap:10px;margin-top:18px;max-width:980px} .nw-push p{margin:0}',
      '.nw-ps-grid{display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px 14px;align-items:start;font-size:13px} .nw-ps-k{color:' + C.l3 + ';font-size:12px;padding-top:4px}',
      '.nw-ps-cad{display:flex;flex-direction:column;gap:4px} .nw-ps-opt{display:flex;gap:6px;align-items:center;cursor:pointer;color:' + C.l2 + '} .nw-ps-opt.nw-on{color:' + C.l1 + ';font-weight:600}',
      '.nw-ps-lim{display:flex;gap:16px;flex-wrap:wrap;align-items:center} .nw-ps-log{margin-top:14px} .nw-ps-vote{display:flex;gap:4px}',
      '.nw-askbox{flex:1;display:flex;justify-content:flex-end;min-width:200px} .nw-askbox input{width:100%;max-width:360px;border-radius:999px!important;padding:5px 12px!important;font-size:12px!important}',
      '.nw-ask{display:flex;flex-direction:column;gap:22px;max-width:820px} .nw-ask-ans{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:10px;background:' + C.bg + ';border:1px solid ' + C.line + '} .nw-ask-ans h4{margin:0;font-size:12px;letter-spacing:.06em}',
      '.nw-ask-p{font-size:15px;line-height:1.85} .nw-ask-p > span + span{margin-left:2px}',
      '.nw-welcome{display:flex;flex-direction:column;gap:18px;max-width:720px;padding:8px 0 24px} .nw-welcome p{margin:0}',
      '.nw-wl-block{display:flex;flex-direction:column;gap:8px} .nw-wl-block h4{margin:0;font-size:13px} .nw-wl-topics{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:14px} .nw-wl-kw{max-width:520px}',
      '.nw-wl-steps{margin:0;padding-left:1.4em;display:flex;flex-direction:column;gap:6px;font-size:13px;color:' + C.l2 + '}',
      '.nw-fol-top{padding-bottom:20px;border-bottom:1px solid ' + C.line + '}',
      '.nw-impact{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:10px 12px;border-left:3px solid ' + C.accent + ';background:' + C.bg + ';border-radius:0 8px 8px 0} .nw-impact-h{font-size:12px} .nw-impact-sum{color:' + C.l1 + '!important;font-size:13px}',
      '.nw-imp-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.6} .nw-imp-list > li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:4px}',
      '.nw-imp-dir{font-size:12px;padding-top:2px} .nw-up{color:' + C.ok + '} .nw-down{color:' + C.err + '} .nw-unk{color:' + C.l3 + '}',
      '.nw-scn{font-size:11px;font-weight:700;border-radius:4px;padding:0 4px;height:18px;align-self:start;margin-top:2px;text-align:center} .nw-scn-hi{background:' + C.warnBg + ';color:' + C.warn + '} .nw-scn-mid{background:' + C.accentBg + ';color:' + C.accent + '} .nw-scn-lo{background:' + C.hover + ';color:' + C.l3 + '}',
      '.nw-impact-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .nw-analyze-btn{color:' + C.link + '!important} .nw-analysis{max-width:760px}',
      '.nw-filters-1{flex-wrap:wrap} .nw-fsearch{flex:1 1 220px;max-width:420px} .nw-filters-2{padding:8px 0;border-top:1px dashed ' + C.line1 + '} .nw-hotwords{display:flex;gap:2px 4px;flex-wrap:wrap;align-items:center}',
      '.nw-evrow{display:grid;grid-template-columns:14px minmax(0,1fr);gap:8px;width:100%;text-align:left;border:0;border-top:1px solid ' + C.line1 + ';background:transparent;color:inherit;font:inherit;padding:12px 8px;cursor:pointer;border-radius:0} .nw-evrow:hover{background:' + C.hover + '} .nw-evrow.nw-active{background:' + C.accentBg + '}',
      '.nw-evdot{width:8px;height:8px;border-radius:50%;margin-top:7px;background:' + C.idle + '} .nw-evdot-hi{background:' + C.err + '} .nw-evdot-mid{background:' + C.warn + '}',
      '.nw-evbody{display:flex;flex-direction:column;gap:3px;min-width:0} .nw-evtitle{font-size:15px;font-weight:600;line-height:1.5;color:' + C.l1 + '} .nw-evsum{font-size:13px;color:' + C.l2 + ';line-height:1.6} .nw-evmeta{font-size:12px;color:' + C.l3 + '}',
      '.nw-evtag{font-size:11px;color:' + C.l3 + ';border:1px solid ' + C.line + ';border-radius:4px;padding:0 4px;margin-left:4px} .nw-evtag-first{color:' + C.accent + ';border-color:' + C.accent + '} .nw-evd-repost .nw-tl2-a{color:' + C.l3 + '}',
      '.nw-evd-title{text-decoration:none;color:' + C.l1 + ';font-size:clamp(18px,3cqi,24px)!important} .nw-evd-title:hover{text-decoration:underline}',
      '.nw-itlist{display:flex;flex-direction:column} .nw-itrow{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;padding:9px 0;border-top:1px solid ' + C.line1 + ';font-size:13px;line-height:1.65} .nw-itrow-off{opacity:.6}',
      '.nw-itbody{min-width:0} .nw-itsum{color:' + C.l2 + ';font-size:12px;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;margin-top:2px} .nw-itsum.nw-open{display:block}',
      '.nw-usage{display:flex;flex-direction:column;gap:2px;font-size:12px;padding:6px 0;border-top:1px dashed ' + C.line1 + '}',
      '.nw-tracking{display:flex;flex-direction:column;gap:18px;max-width:980px;padding-top:4px} .nw-tksug{display:flex;flex-wrap:wrap;gap:8px} .nw-tksugbtn{border:1px solid ' + C.line + ';background:' + C.bg + ';color:inherit;font:inherit;font-size:13px;border-radius:999px;padding:4px 12px;cursor:pointer} .nw-tksugbtn:hover{border-color:' + C.accent + '}',
      '.nw-tkadd{display:flex;gap:8px;flex-wrap:wrap;align-items:center} .nw-tklist{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:minmax(0,1fr);gap:10px} @container (min-width: 820px){.nw-tklist{grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '.nw-tkcard{width:100%;text-align:left;border:1px solid ' + C.line + ';background:' + C.bg + ';color:inherit;font:inherit;border-radius:10px;padding:12px 14px;cursor:pointer;display:flex;flex-direction:column;gap:6px} .nw-tkcard:hover{border-color:' + C.accent + '}',
      '.nw-tkhead{display:flex;align-items:center;gap:6px} .nw-tkhead b{font-size:15px} .nw-tkhead .nw-tkspark{margin-left:auto} .nw-tkstate{font-size:13px;line-height:1.6;color:' + C.l1 + '}',
      '.nw-tkspark{display:inline-flex;align-items:flex-end;gap:1px;height:18px;vertical-align:middle} .nw-tkspark > span{width:3px;background:' + C.accent + ';opacity:.55;border-radius:1px}',
      '.nw-tkmiles{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:13px} .nw-tkmiles li{display:grid;grid-template-columns:52px minmax(0,1fr);gap:8px} .nw-tktrend{color:' + C.l1 + '!important;font-size:14px}',
      '.nw-tkstory{text-align:left} .nw-tklead{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.nw-tkents{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
      '.nw-tkconfirm{display:inline-flex;gap:6px;align-items:center}',
      '.nw-sd{display:flex;flex-direction:column;gap:20px;max-width:760px;padding-top:4px}',
      '.nw-back-link{padding-left:0!important;font-size:13px!important}',
      '.nw-sd-copy{display:flex;flex-direction:column;gap:8px}',
      '.nw-tl-day{display:flex;flex-direction:column;gap:2px;margin-top:6px} .nw-tl-dh{font-size:12px;font-weight:600;color:' + C.l2 + ';margin:6px 0 2px}',
      '.nw-tl2{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}',
      '.nw-tl2 > li{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px;padding:7px 0;font-size:13px;line-height:1.65;border-top:1px solid ' + C.line1 + '} .nw-tl2 > li.nw-rs{flex-direction:unset}',
      '.nw-tl2-t{color:' + C.l3 + ';font-variant-numeric:tabular-nums;font-size:12px;padding-top:1px}',
      '.nw-tl2-body{display:block;min-width:0} .nw-tl2-src{color:' + C.l2 + ';font-weight:600;font-size:12px;margin-right:8px}',
      '.nw-tl2-a{color:' + C.l1 + ';text-decoration:none;min-width:0;word-break:break-word} .nw-tl2-a:hover{color:' + C.link + ';text-decoration:underline}',
      '.nw-tl2 .nw-acts{margin-left:6px;display:inline}',
      '.nw-tl2-u > span:last-child{background:' + C.accentBg + ';border-radius:6px;padding:4px 10px} .nw-tl2-u b{color:' + C.accent + ';margin-right:8px;font-size:12px}',
      '.nw-tl2-p{color:' + C.l3 + ';font-size:12px!important}',
      // —— 阅读版面 ——
      '.nw-tabs-gap{flex:1;min-width:16px} .nw-tab-tool{font-size:12px;color:' + C.l3 + ';padding:8px 8px}',
      '.nw-status{gap:8px;align-items:center} .nw-st-warn{border:0;background:' + C.warnBg + ';color:' + C.warn + ';border-radius:999px;padding:1px 8px;font:inherit;font-size:11px;cursor:pointer}',
      '.nw-btn.nw-sm{padding:4px 10px;font-size:12px}',
      '.nw-edition{display:flex;flex-direction:column;gap:18px;padding-top:4px}',
      '.nw-working{display:flex;align-items:center;gap:8px;font-size:12px;color:' + C.l2 + '}',
      '.nw-pulse{width:7px;height:7px;border-radius:50%;background:' + C.accent + ';animation:nwpulse 1.4s ease-in-out infinite} @keyframes nwpulse{0%,100%{opacity:.25}50%{opacity:1}}',
      '.nw-mast{display:flex;flex-direction:column;gap:6px;padding-bottom:16px;border-bottom:1px solid ' + C.l1 + '}',
      '.nw-mast-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.nw-mast-date{font-size:12px;color:' + C.l2 + ';letter-spacing:.02em;font-variant-numeric:tabular-nums}',
      '.nw-mast-pack{font-size:12px!important;padding:2px 6px!important;border-color:transparent!important;color:' + C.l2 + '!important;background:transparent!important}',
      '.nw-mast-head{margin:2px 0 0;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;font-size:clamp(22px,4.2cqi,30px);font-weight:700;line-height:1.3;letter-spacing:.01em;color:' + C.l1 + ';text-wrap:balance}',
      '.nw-mast-dek{font-size:13px;color:' + C.l3 + '}',
      '.nw-since{border-left:3px solid ' + C.accent + ';padding:2px 0 2px 12px;display:flex;flex-direction:column;gap:6px}',
      '.nw-since-h{font-size:13px;font-weight:600} .nw-since ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:13px}',
      '.nw-read{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;align-items:start}',
      '@container (min-width: 900px){.nw-read{grid-template-columns:minmax(0,1fr) 260px;gap:36px} .nw-rail{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow-y:auto;scrollbar-width:thin}}',
      '.nw-read-main{display:flex;flex-direction:column;gap:28px;min-width:0;max-width:760px}',
      '.nw-front{display:flex;flex-direction:column;gap:22px;padding-bottom:24px;border-bottom:1px solid ' + C.line + '}',
      '.nw-front-2{display:grid;grid-template-columns:minmax(0,1fr);gap:22px}',
      '@container (min-width: 620px){.nw-front-2{grid-template-columns:repeat(2,minmax(0,1fr));gap:28px} .nw-front-2 > .nw-rs + .nw-rs{border-left:1px solid ' + C.line1 + ';padding-left:28px}}',
      '.nw-sections{display:flex;flex-direction:column;gap:32px}',
      '.nw-sec{display:flex;flex-direction:column;gap:0}',
      '.nw-sec-h{margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:.08em;color:' + C.l1 + ';padding-bottom:8px;border-bottom:2px solid ' + C.l1 + '}',
      '.nw-sec-fol .nw-sec-h{color:' + C.accent + ';border-bottom-color:' + C.accent + '}',
      '.nw-rs{display:flex;flex-direction:column;gap:6px;min-width:0;padding:16px 0;scroll-margin-top:12px}',
      '.nw-sec .nw-rs + .nw-rs{border-top:1px solid ' + C.line1 + '} .nw-front .nw-rs, .nw-daily-list .nw-rs{padding:0}',
      '.nw-rs-head{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '.nw-rs-title{border:0;background:transparent;color:' + C.l1 + ';font:inherit;font-size:16px;font-weight:600;line-height:1.45;text-align:left;padding:0;cursor:pointer;word-break:break-word;min-width:0}',
      '.nw-rs-title:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}',
      '.nw-rs-lead{margin:0;font-size:14px;line-height:1.8;color:' + C.l1 + ';word-break:break-word}',
      '.nw-v-brief .nw-rs-lead, .nw-v-second .nw-rs-lead{color:' + C.l2 + ';display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}',
      '.nw-v-brief .nw-rs-lead{-webkit-line-clamp:2;font-size:13px;line-height:1.7} .nw-v-second .nw-rs-lead{-webkit-line-clamp:5}',
      '.nw-v-brief{padding:12px 0} .nw-v-brief .nw-rs-title{font-size:15px}',
      '.nw-v-second .nw-rs-title{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;font-size:18px;font-weight:700;line-height:1.4}',
      '.nw-v-lead .nw-rs-title{font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;font-size:clamp(20px,3.4cqi,26px);font-weight:700;line-height:1.35}',
      '.nw-v-lead > .nw-rs-lead{font-size:15px;line-height:1.85}',
      '.nw-rs-tag{flex:none;font-size:11px;font-weight:700;color:' + C.err + ';letter-spacing:.04em;transform:translateY(-1px)} .nw-rs-tag.nw-rs-dev{color:' + C.accent + '}',
      '.nw-rs-star{flex:none;color:' + C.accent + ';font-size:12px}',
      '.nw-rs-meta{display:flex;align-items:center;gap:8px;min-height:20px;font-size:12px;color:' + C.l3 + ';font-variant-numeric:tabular-nums}',
      '.nw-byline{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .nw-cred-ok{color:' + C.ok + '}',
      '.nw-acts{margin-left:auto;display:inline-flex;flex:none;white-space:nowrap;gap:2px;opacity:0;transition:opacity .15s} .nw-rs:hover .nw-acts, .nw-rs:focus-within .nw-acts, .nw-acts:has(.nw-on){opacity:1}',
      '@media (hover:none){.nw-acts{opacity:1}}',
      '.nw-act{border:0;background:transparent;color:' + C.l3 + ';font:inherit;font-size:12px;padding:1px 6px;border-radius:4px;cursor:pointer} .nw-act:hover{color:' + C.l1 + ';background:' + C.hover + '} .nw-act.nw-on{color:' + C.accent + '} .nw-act:disabled{opacity:.3;cursor:default}',
      '.nw-rs-points{margin:2px 0 0;padding-left:1.1em;font-size:14px;line-height:1.75;color:' + C.l1 + ';display:flex;flex-direction:column;gap:3px} .nw-rs-points li::marker{color:' + C.l3 + '}',
      '.nw-rs-block{display:flex;flex-direction:column;gap:4px;margin-top:6px} .nw-rs-k{font-size:11px;font-weight:700;letter-spacing:.06em;color:' + C.l3 + '}',
      '.nw-rs-views{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:1.7;color:' + C.l2 + '} .nw-rs-views b{color:' + C.l1 + ';font-weight:600}',
      '.nw-rs-p{margin:0;font-size:13px;line-height:1.7;color:' + C.l2 + '}',
      '.nw-rs-src{margin:6px 0 0;padding-left:1.4em;font-size:12px;line-height:1.7;color:' + C.l3 + ';columns:2;column-gap:20px} .nw-rs-src li::marker{color:' + C.l3 + ';font-variant-numeric:tabular-nums}',
      '.nw-refs{font-size:10px;line-height:0;margin-left:1px;white-space:nowrap} .nw-ref{color:' + C.link + ';text-decoration:none;padding:0 1px} .nw-ref:hover{text-decoration:underline}',
      '.nw-unver{font-size:11px;color:' + C.warn + ';margin-left:6px;border-bottom:1px dotted ' + C.warn + ';cursor:help}',
      '.nw-rs-update{font-size:13px;line-height:1.7;color:' + C.l1 + ';padding:6px 10px;background:' + C.accentBg + ';border-radius:6px} .nw-rs-update b{color:' + C.accent + ';margin-right:8px;font-size:12px}',
      '.nw-more-btn{align-self:flex-start;border:0;background:transparent;color:' + C.l3 + ';font:inherit;font-size:12px;padding:2px 0;cursor:pointer} .nw-more-btn:hover{color:' + C.link + '}',
      '.nw-rail{display:flex;flex-direction:column;gap:22px;min-width:0}',
      '.nw-v-lead{gap:10px} .nw-rail-warn h4{color:' + C.warn + ';border-bottom-color:' + C.warn + '}',
      '.nw-rail-box{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.6}',
      '.nw-rail-box h4{margin:0;font-size:11px;font-weight:700;letter-spacing:.08em;color:' + C.l1 + ';padding-bottom:6px;border-bottom:1px solid ' + C.l1 + '}',
      '.nw-rail-box ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px} .nw-rail-box p{margin:0;color:' + C.l2 + ';font-size:12px}',
      '.nw-skim{display:none} @container (min-width: 900px){.nw-skim{display:flex}}',
      '.nw-skim-sec{display:flex;flex-direction:column;gap:4px} .nw-skim-h{font-size:11px;color:' + C.l3 + ';margin-top:4px} .nw-skim ul{gap:4px;font-size:12px}',
      '.nw-skim .nw-brief-link{color:' + C.l2 + ';display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.nw-about-acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px} .nw-about .nw-hist{max-width:100%;font-size:12px}',
      '.nw-daynav{display:inline-flex;align-items:center;gap:4px} .nw-daynav .nw-act{font-size:16px;line-height:1}',
      '.nw-daily-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:22px}',
      '.nw-daily-n{flex:none;font-family:"Noto Serif SC","Source Han Serif SC","Songti SC","STSong",Georgia,serif;font-size:18px;font-weight:700;color:' + C.l3 + ';min-width:1.4em}',
      '.nw-daily-list .nw-rs-meta, .nw-daily-list .nw-rs-lead{padding-left:calc(1.4em * 18 / 14 + 6px)}',
      '.nw-sd-copy h4,.nw-sd-h{margin:0 0 6px;font-size:12px;color:' + C.l2 + '}',
      '.nw-tl{margin:0;padding:0 0 0 14px;list-style:none;border-left:2px solid ' + C.line + ';display:flex;flex-direction:column;gap:8px} .nw-tl li{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;font-size:13px;line-height:1.5;position:relative}',
      '.nw-tl li::before{content:"";position:absolute;left:-19px;top:6px;width:8px;height:8px;border-radius:999px;background:' + C.idle + '} .nw-tl li.nw-tl-u::before{background:' + C.warn + '} .nw-tl li.nw-tl-p::before{background:' + C.accent + '} .nw-tl-u{color:' + C.warn + '}',
      '.nw-report{display:flex;flex-direction:column;gap:6px;border:1px dashed ' + C.line + ';border-radius:8px;padding:8px;font-size:12px} .nw-report ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}',
      '.nw-tl-x{margin-left:6px;opacity:.6} .nw-tl-x:hover{opacity:1} .nw-hist{max-width:260px}',
      '.nw-dailyview{display:flex;flex-direction:column;gap:12px} .nw-daily-list{margin:0;padding:0 0 0 18px;display:flex;flex-direction:column;gap:12px} .nw-daily-list li{display:flex;flex-direction:column;gap:4px}',
      '.nw-modelcard{display:flex;flex-direction:column;gap:8px} .nw-model-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .nw-model-sel{min-width:220px;max-width:100%}',
      '.nw-table-wrap{overflow-x:auto;border:1px solid ' + C.line + ';border-radius:10px}',
      '.nw-table{width:100%;border-collapse:collapse;font-size:12px} .nw-table th{text-align:left;font-weight:600;color:' + C.l3 + ';border-bottom:1px solid ' + C.line + ';padding:6px 8px;white-space:nowrap}',
      '.nw-table td{border-bottom:1px solid ' + C.line1 + ';padding:5px 8px;vertical-align:top} .nw-table tr.nw-bad td{color:' + C.err + '} .nw-hintcell{min-width:220px;word-break:break-word}',
      '.nw-details summary{cursor:pointer;font-size:12px;color:' + C.l2 + ';font-weight:600}',
      '.nw-digest{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.55;max-height:520px;overflow:auto;border:1px solid ' + C.line + ';border-radius:10px;padding:10px 12px;margin-top:8px;background:' + C.bg + '}',
      // 数据源页
      '.nw-toolbar{display:flex;gap:8px;margin:6px 0 10px}',
      '.nw-srcs{display:flex;flex-direction:column;gap:8px} .nw-src{border:1px solid ' + C.line + ';background:' + C.bg + ';border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.nw-src.nw-off{opacity:.55} .nw-src-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px}',
      '.nw-src-top label{display:inline-flex;gap:4px;align-items:center;color:' + C.l3 + '}',
      '.nw-src .nw-in{padding:4px 6px} .nw-name{min-width:160px} .nw-cat{min-width:100px} .nw-num{width:64px} .nw-src .nw-url{width:100%}',
      '.nw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace} .nw-src-ch{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.nw-switch{display:inline-flex;gap:4px;align-items:center;font-size:12px} .nw-strike{text-decoration:line-through}',
      '.nw-saved{color:' + C.ok + ';font-size:12px}',
      '.nw-test{border-left:3px solid ' + C.ok + ';padding:4px 8px;font-size:12px;display:flex;flex-direction:column;gap:3px} .nw-test.nw-test-bad{border-left-color:' + C.err + '}',
      '.nw-test-items{margin:2px 0 0;padding-left:16px;display:flex;flex-direction:column;gap:2px} .nw-test-items a{color:' + C.l1 + '}',
    ].join('\n')
    function ensureStyle() {
      if (typeof document === 'undefined') return
      var el = document.getElementById(NS + '-style')
      if (!el) { el = document.createElement('style'); el.id = NS + '-style'; document.head.appendChild(el) }
      el.textContent = CSS
    }

    // ------------------------------------------------------------------ 注册
    function apply(ctx) {
      ensureStyle()
      ctx.inject(['locale'], function (c) {
        try { c.locale.register(NS, 'zh', DICT.zh); c.locale.register(NS, 'en', DICT.en) } catch (e) { /* 热更新重复挂载 */ }
        var read = function () {
          var snap = c.locale.getLocale()
          var active = snap && snap.active ? String(snap.active) : 'zh'
          lang = active.indexOf('en') === 0 ? 'en' : 'zh'
        }
        read()
        var off = c.on('locale/change', read)
        return function () { off() }
      })
      ctx.inject(['remote', 'remote.pluginManager'], function (scope) {
        remotes.pluginManager = scope.remote.pluginManager
        return function () { delete remotes.pluginManager }
      })
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 7, label: function () { return t('nav.panel') } }, PanelIcon)
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, Page)
      })
    }

    var plugin = { inject: ['slots'], apply: apply }
    plugin.__test = { DailyView, PushPanel, AskView, Welcome, ImpactBlock, AnalysisFull, TrackTab, TrackDetail, TrackSynthesis, ContentCard, SourceBoard, SourceEditor, QualityCard, StoryDetail, FollowsView, EditionView, ReadStory, NoteList, ModelCard, Topics, NotesBox, VersionSection, UpdateBanner, checkForUpdate, applyUpdate, remotes, Page, NewsTab, TimelineTab, ItemsTab, SourcesTab, RunsTab, EventCard, EventDetailView, EventDetail, RunBars, ScheduleCard, StatusLine, TestResult, SignalChips, Spark, PanelIcon, t, setLang: function (v) { lang = v }, DICT, CSS }
    return plugin
  },
})

/* 撞牌游戏 Version 3 · 界面与流程（Vue 3）
 * 同一张牌桌，每局在三人下完底注后随机抽目标：13「撞庄局」或 22「命中局」。 */
(function () {
  'use strict';
  const { createApp } = Vue;
  const E = window.CollideEngine;
  const S = window.Sound;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ABORT = { abort: true };
  const SEAT_COLORS = ['#E8BE62', '#86D3BF', '#EE9AB3'];
  const CONFIG_KEY = 'collide-game-config-v3';

  const DEFAULT_CONFIG = {
    names: ['玩家一', '玩家二', '玩家三'],
    types: ['human', 'ai', 'ai'],
    startChips: 10000,
    p13: 50, // 抽到目标13的概率（%）
    hints: true,
    speed: 'normal',
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  function loadConfig() {
    const cfg = clone(DEFAULT_CONFIG);
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* 无痕模式等情况下忽略 */ }
    return cfg;
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  // 不需要响应式的本局数据
  const G = { shoe: null, slots: null, handOf: [0, 1, 2], adv: null };
  let logId = 0;

  const STEPS = [
    { key: 'ante', title: '下底注', desc: '目标尚未抽出' },
    { key: 'target', title: '抽目标并发起手牌', desc: '13 或 22，各占一半' },
    { key: 'side', title: '选择边注', desc: '13 开局注，22 终局注' },
    { key: 'reveal', title: '翻开庄家首牌', desc: '13 检查 10 点／10 点' },
    { key: 'lock', title: '继续、加注或弃牌', desc: '三人同时亮出' },
    { key: 'play', title: '玩家补牌', desc: '补来的牌只有自己能看' },
    { key: 'dealer', title: '庄家补牌', desc: '按固定门槛' },
    { key: 'settle', title: '独立比牌结算', desc: '每位玩家分别对庄家A、B' },
  ];

  /* ---------------- 扑克牌组件 ---------------- */
  const PlayCard = {
    props: { card: Object, up: Boolean },
    computed: {
      face() { return this.card && ['J', 'Q', 'K'].includes(this.card.rank); },
    },
    template: `
      <div class="card" :class="{ up: up, red: card && card.color === 'red' }">
        <div class="card-inner">
          <div class="card-face card-front" v-if="card" :aria-hidden="!up">
            <div class="corner tl"><b>{{ card.rank }}</b><i>{{ card.suit }}</i></div>
            <div class="pip" :class="{ court: face }">
              <template v-if="face"><span class="court-letter">{{ card.rank }}</span><span class="court-suit">{{ card.suit }}</span></template>
              <template v-else>{{ card.suit }}</template>
            </div>
            <div class="corner br"><b>{{ card.rank }}</b><i>{{ card.suit }}</i></div>
          </div>
          <div class="card-face card-back" :aria-hidden="up" aria-label="暗牌"><span class="back-seal" aria-hidden="true">撞</span></div>
        </div>
      </div>`,
  };

  createApp({
    components: { PlayCard },
    data() {
      return {
        screen: 'setup',
        config: loadConfig(),
        showAdvanced: false,
        showRules: false,
        showLog: false,
        showHint: false,
        mobileSeat: 0,
        reviewSeat: -1,
        muted: false,
        token: 0,

        players: [],
        dealers: [],
        target: null,
        targetShown: false,
        round: 0,
        order: [0, 1, 2],
        phase: 'idle',
        openCollision: false,
        activeSeat: -1,
        thinking: -1,
        pending: null,
        amount: 0,
        curtain: null,
        banner: null,
        stamps: {},
        log: [],
        stats: { rounds: 0, houseNet: 0, opens: 0, rebuys: 0, r13: 0, r22: 0 },
        hint: null,
        steps: STEPS,
        seatColors: SEAT_COLORS,
        E,
      };
    },

    computed: {
      cfg() { return this.config; },
      T() { return this.targetShown ? E.TARGETS[this.target] : null; },
      humanCount() { return this.players.filter((p) => p.type === 'human').length; },
      stepIndex() { return STEPS.findIndex((s) => s.key === this.phase); },
      maxSlots() { return this.T ? this.T.maxCards : 3; },
      reviewPlayer() { return this.reviewSeat >= 0 ? this.players[this.reviewSeat] : null; },
      comparison() { return this.reviewPlayer && this.reviewPlayer.result && this.reviewPlayer.result.comparison; },
      progressTitle() { return this.phase === 'roundEnd' ? '本局已结算' : (STEPS[this.stepIndex] || {}).title || '准备开始'; },
      comparisonHands() {
        if (!this.comparison) return [];
        const c = this.comparison;
        return [
          { key: 'P', label: this.reviewPlayer.name, distance: c.pd },
          { key: 'A', label: '庄家 A', distance: c.ad },
          { key: 'B', label: '庄家 B', distance: c.bd },
        ];
      },
      feltText() {
        if (!this.T) return '各自对庄家，玩家之间不比牌';
        return this.target === 13
          ? '撞庄局　两庄相撞获胜 2 赔 1　庄家不足 10 必须补牌'
          : '命中局　正好 22 底注 2 赔 1　庄家不足 19 必须补牌';
      },
      pendingPlayer() { return this.pending ? this.players[this.pending.seat] : null; },
      limits() {
        if (!this.pending) return null;
        return this.betLimits(this.pending.kind, this.pending.seat);
      },
      chipButtons() { return [100, 500, 1000, 5000]; },
    },

    watch: {
      muted(v) { S.setMuted(v); },
      activeSeat(seat) {
        if (seat >= 0 && this.players[seat].type === 'human') this.mobileSeat = seat;
      },
    },

    mounted() {
      window.addEventListener('keydown', this.onKey);
    },

    methods: {
      /* ---------- 工具 ---------- */
      money(n) {
        const v = Math.round(n * 100) / 100;
        return (v > 0 ? '+' : '') + v.toLocaleString('zh-CN');
      },
      fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('zh-CN'); },
      pct(x) { return (x * 100).toFixed(1) + '%'; },
      ev(x) { return (x >= 0 ? '+' : '') + (Math.round(x * 10) / 10).toLocaleString('zh-CN'); },
      sp(ms) { return sleep(ms * (this.cfg.speed === 'fast' ? 0.4 : 1)); },
      addLog(text, kind) {
        this.log.unshift({ id: ++logId, round: this.round, text, kind: kind || '' });
        if (this.log.length > 150) this.log.pop();
      },
      flash(text, kind, ms, sub) {
        this.banner = { text, sub: sub || '', kind: kind || '', id: Date.now() + Math.random() };
        const id = this.banner.id;
        setTimeout(() => { if (this.banner && this.banner.id === id) this.banner = null; }, ms || 1500);
      },
      seatName(i) { return this.players[i] ? this.players[i].name : ''; },
      orderPos(seat) { return this.order.indexOf(seat) + 1; },
      floor100(x) { return Math.floor(x / E.UNIT) * E.UNIT; },
      selectSeat(seat) {
        this.mobileSeat = seat;
        if (this.phase === 'roundEnd') this.selectReview(seat);
      },
      selectReview(seat, scroll = false) {
        this.reviewSeat = seat;
        this.mobileSeat = seat;
        const c = this.players[seat].result && this.players[seat].result.comparison;
        if (!c) { this.stamps = this.openCollision ? { A: true, B: true } : {}; return; }
        const stamps = {};
        for (const key of c.collided) stamps[key === 'P' ? 'P' + seat : key] = true;
        this.stamps = stamps;
        if (scroll) this.$nextTick(() => {
          const panel = document.querySelector('.comparison');
          if (panel) panel.scrollIntoView({ block: 'start', behavior: 'auto' });
        });
      },
      seatStatus(p) {
        if (p.result) return this.money(p.net);
        if (this.pending && this.pending.seat === p.seat) return '等你操作';
        if (p.lockShown && p.lock === 'fold') return '已弃牌';
        return p.type === 'human' ? '真人玩家' : '电脑玩家';
      },

      betLimits(kind, seat) {
        const p = this.players[seat];
        if (kind === 'ante') {
          return { min: E.ANTE_MIN, max: Math.max(E.ANTE_MIN, this.floor100(Math.min(E.ANTE_MAX, p.chips))), step: E.UNIT };
        }
        if (kind === 'lock') {
          return { min: E.UNIT, max: this.floor100(Math.min(E.RAISE_CAP * p.ante, p.chips)), step: E.UNIT };
        }
        return null;
      },

      /* ---------- 牌面可见性 ---------- */
      startCount() { return this.T ? this.T.start : 1; },
      cardVisible(seat, i) {
        if (i < this.startCount()) return true; // 起手牌公开
        if (this.phase === 'settle' || this.phase === 'roundEnd') return true;
        const p = this.players[seat];
        if (p.type !== 'human') return false;
        if (this.humanCount === 1) return true; // 只有一名真人：自己的牌一直可见
        return this.phase === 'play' && this.activeSeat === seat && !this.curtain;
      },
      handTotalVisible(seat) {
        const p = this.players[seat];
        return p.cards.every((c, i) => this.cardVisible(seat, i));
      },
      total(cards) { return E.total(cards); },
      dist(cards) { return E.distance(E.total(cards), this.target); },
      lockLabel(p) {
        if (!p.lock) return '';
        if (this.phase === 'lock' && !p.lockShown) return '已锁定';
        return { cont: '继续', raise: `加注 ${this.fmt(p.raise)}`, fold: '弃牌' }[p.lock];
      },

      /* ---------- 大厅 ---------- */
      resetConfig() { this.config = clone(DEFAULT_CONFIG); },
      startGame() {
        const c = this.cfg;
        c.names = c.names.map((n, i) => (n || '').trim() || DEFAULT_CONFIG.names[i]);
        c.startChips = Math.max(1000, this.floor100(Number(c.startChips) || 10000));
        saveConfig(c);
        this.players = [0, 1, 2].map((i) => ({
          seat: i, name: c.names[i], type: c.types[i], chips: c.startChips,
          ante: 0, side: 0, M: 0, raise: 0, paid: 0, cards: [], lock: null, lockShown: false,
          status: '', result: null, net: 0, rebuys: 0,
        }));
        this.stats = { rounds: 0, houseNet: 0, opens: 0, rebuys: 0, r13: 0, r22: 0 };
        this.log = [];
        this.round = 0;
        this.mobileSeat = Math.max(0, this.players.findIndex((p) => p.type === 'human'));
        this.reviewSeat = -1;
        this.showLog = false;
        this.showHint = false;
        this.screen = 'game';
        S.reveal();
        this.$nextTick(() => { window.scrollTo(0, 0); this.startRound(); });
      },
      backToLobby() {
        this.token++;
        this.pending = null; this.curtain = null; this.phase = 'idle';
        this.reviewSeat = -1;
        this.screen = 'setup';
        this.$nextTick(() => window.scrollTo(0, 0));
      },

      /* ---------- 等待真人操作 ---------- */
      ask(kind, seat) {
        return new Promise((resolve) => {
          this.pending = { kind, seat, resolve };
          const lim = this.betLimits(kind, seat);
          if (lim) this.amount = kind === 'lock' ? lim.min : Math.min(lim.max, Math.max(lim.min, this.players[seat].lastAnte || lim.min));
          this.computeHint(kind, seat);
          this.$nextTick(() => {
            if (!window.matchMedia('(max-width: 640px)').matches) return;
            const hand = document.getElementById('seat-panel-' + seat);
            const dock = document.querySelector('.dock');
            if (!hand || !dock) return;
            const overlap = hand.getBoundingClientRect().bottom - dock.getBoundingClientRect().top;
            if (overlap > 0) window.scrollBy(0, overlap + 12);
          });
        });
      },
      answer(value) {
        if (!this.pending) return;
        const r = this.pending.resolve;
        this.pending = null;
        this.hint = null;
        r(value);
      },
      addChip(v) {
        const lim = this.limits; if (!lim) return;
        this.amount = Math.min(lim.max, (this.amount || 0) + v);
        S.chip();
      },
      clampAmount() {
        const lim = this.limits; if (!lim) return 0;
        let a = Math.round(Number(this.amount) / lim.step) * lim.step;
        return Math.max(lim.min, Math.min(lim.max, a));
      },
      confirmAnte() { this.answer(this.clampAmount()); },
      chooseLock(opt) {
        if (opt === 'raise') this.answer({ opt, C: this.clampAmount() });
        else this.answer({ opt, C: 0 });
      },
      onKey(e) {
        if (this.showRules) { if (e.key === 'Escape') this.showRules = false; return; }
        if (this.screen !== 'game' || e.target.tagName === 'INPUT') return;
        const k = e.key.toLowerCase();
        if (this.curtain && (k === 'enter' || k === ' ')) { e.preventDefault(); this.curtain.resolve(); return; }
        if (!this.pending) {
          if (this.phase === 'roundEnd' && k === 'enter') this.startRound();
          return;
        }
        const kind = this.pending.kind;
        if (kind === 'play') {
          if (k === 'h') this.answer('hit');
          if (k === 's') this.answer('stand');
        } else if (kind === 'ante' && k === 'enter') this.confirmAnte();
        else if (kind === 'side') {
          if (k === 'y') this.answer(true);
          if (k === 'n') this.answer(false);
        } else if (kind === 'lock') {
          if (k === 'c') this.chooseLock('cont');
          if (k === 'r' && this.limits.max >= E.UNIT) this.chooseLock('raise');
          if (k === 'f') this.chooseLock('fold');
        }
      },

      /* ---------- 策略参谋 ---------- */
      computeHint(kind, seat) {
        this.hint = null;
        if (!this.cfg.hints) return;
        const p = this.players[seat];
        if (kind === 'ante') {
          this.hint = { kind, text: `目标在三人都下完底注后才抽出：13「撞庄局」机会 ${this.cfg.p13}%，22「命中局」机会 ${100 - this.cfg.p13}%。` };
        } else if (kind === 'side') {
          const amt = E.SIDE_RATE * p.ante;
          if (this.target === 13) {
            const known = new Set();
            for (let h = 0; h < 3; h++) for (let k = 0; k < this.T.start; k++) known.add(G.slots[h][k].id);
            const pool = G.shoe.filter((c) => !known.has(c.id)).map((c) => c.value);
            const pr = E.openCollisionProb(pool);
            const evOne = pr * (1 + E.sideNet(13)) - 1;
            // 开局注从底注划出，要和“留在主注”比较（精确计算见 possibility/01 文件第二节）
            const v = p.cards[0].value, buyBetter = v === 1 || v >= 6;
            this.hint = { kind, text: `庄家首牌 10 点／10 点的概率约 ${this.pct(pr)}，开局注本身每押 1 元期望 ${evOne.toFixed(3)}。但它是从底注划出的：你的首牌是 ${p.cards[0].rank}，${buyBetter ? '这时主注比开局注更不利，按最佳打法建议买' : '这时主游戏对你有利，按最佳打法建议不买'}。` };
          } else {
            const pr = E.P_FINAL_COLLIDE_22;
            const evOne = pr * (1 + E.sideNet(22)) - 1;
            this.hint = { kind, text: `两手庄家终局同距的长期概率估计约 ${this.pct(pr)}。终局注 ${E.sideNet(22)} 赔 1（净赢），另退本金；这 ${this.fmt(amt)} 的期望约 ${this.ev(evOne * amt)}。` };
          }
        } else if (kind === 'lock') {
          const lim = this.betLimits('lock', seat);
          const L = G.adv.lock(E.total(p.cards), p.cards.length, p.M, lim.max);
          this.hint = { kind, L };
        } else if (kind === 'play') {
          const tot = E.total(p.cards), nc = p.cards.length;
          const stand = G.adv.standEV(tot) * p.M;
          const hitRaw = G.adv.hitEV(tot, nc);
          const prob = G.adv.standProb(tot);
          this.hint = { kind, stand, hit: hitRaw == null ? null : hitRaw * p.M, prob, best: hitRaw != null && hitRaw * p.M > stand ? 'hit' : 'stand' };
        }
      },

      /** 锁定提示：按当前选定的加注金额计算三种选择的期望 */
      lockEVs() {
        const h = this.hint; if (!h || h.kind !== 'lock') return null;
        const L = h.L, C = this.limits && this.limits.max >= E.UNIT ? this.clampAmount() : 0;
        const raise = C ? L.M * L.raisePerM + C * L.raisePerC : null;
        const opts = [['fold', L.fold], ['cont', L.cont]];
        if (raise !== null) opts.push(['raise', raise]);
        const best = opts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        return { fold: L.fold, cont: L.cont, raise, C, best };
      },

      /* ---------- 电脑玩家 ---------- */
      aiDecide(kind, seat) {
        const p = this.players[seat];
        if (kind === 'ante') {
          const lim = this.betLimits('ante', seat);
          const pick = [100, 100, 200, 300, 500, 1000][Math.floor(Math.random() * 6)];
          return Math.max(lim.min, Math.min(lim.max, pick));
        }
        // 边注按期望都是负的；电脑玩家当作娱乐型客人，约三成机会购买
        if (kind === 'side') return Math.random() < 0.3;
        if (kind === 'lock') {
          const lim = this.betLimits('lock', seat);
          const L = G.adv.lock(E.total(p.cards), p.cards.length, p.M, lim.max);
          return { opt: L.opt, C: L.C };
        }
        if (kind === 'play') return G.adv.shouldHit(E.total(p.cards), p.cards.length) ? 'hit' : 'stand';
        return null;
      },
      async decide(kind, seat, w) {
        const p = this.players[seat];
        this.activeSeat = seat;
        if (p.type === 'human') return w(this.ask(kind, seat));
        this.thinking = seat;
        await w(this.sp(kind === 'play' ? 700 : 550));
        this.thinking = -1;
        return this.aiDecide(kind, seat);
      },

      /* ---------- 一局完整流程 ---------- */
      async startRound() {
        const tok = ++this.token;
        const w = async (p) => { const v = await p; if (tok !== this.token) throw ABORT; return v; };
        try {
          await this.runRound(w);
        } catch (e) {
          if (e !== ABORT) { console.error(e); this.addLog('程序出错：' + e.message, 'bad'); }
        }
      },

      async runRound(w) {
        const c = this.cfg;
        this.round++;
        this.phase = 'ante';
        this.openCollision = false;
        this.stamps = {};
        this.reviewSeat = -1;
        this.banner = null;
        this.target = null;
        this.targetShown = false;
        this.activeSeat = -1;
        // 每局轮换行动顺序（规则第一节第7条）
        this.order = [0, 1, 2].map((k) => (k + this.round - 1) % 3);
        this.dealers = [
          { key: 'A', name: '庄家 A', cards: [], revealed: false },
          { key: 'B', name: '庄家 B', cards: [], revealed: false },
        ];
        this.players.forEach((p) => {
          Object.assign(p, { ante: 0, side: 0, M: 0, raise: 0, paid: 0, cards: [], lock: null, lockShown: false, status: '', result: null, net: 0 });
          if (p.chips < E.ANTE_MIN) {
            p.chips += c.startChips; p.rebuys++; this.stats.rebuys++;
            this.addLog(`${p.name} 筹码不足，补充 ${this.fmt(c.startChips)}`, 'muted');
          }
        });

        // 洗两副牌，按固定牌位预留
        G.shoe = E.shuffle(E.createShoe());
        G.slots = E.dealSlots(G.shoe);
        G.adv = null;
        this.order.forEach((seat, h) => { G.handOf[seat] = h; });
        this.addLog(`第 ${this.round} 局开始，行动顺序：${this.order.map((s) => this.seatName(s)).join('、')}`, 'head');

        // 第1步：底注
        for (const seat of this.order) {
          const a = await this.decide('ante', seat, w);
          const p = this.players[seat];
          p.ante = a; p.M = a; p.paid = a; p.chips -= a; p.lastAnte = a; S.chip();
          this.addLog(`${p.name} 下底注 ${this.fmt(a)}`);
        }
        this.activeSeat = -1;

        // 第2步：随机抽目标（与牌组无关），再发起手牌
        this.phase = 'target';
        this.target = Math.random() * 100 < c.p13 ? 13 : 22;
        await w(this.sp(400));
        this.targetShown = true;
        if (this.target === 13) this.stats.r13++; else this.stats.r22++;
        S.reveal();
        this.flash(`目标 ${this.target}`, 'gold', 1700, `${this.T.name}：${this.T.bonusText}`);
        this.addLog(`抽出目标 ${this.target}「${this.T.name}」`, 'gold');
        await w(this.sp(1500));
        for (let k = 0; k < this.T.start; k++) {
          for (let h = 0; h < 5; h++) {
            if (h >= 3 && k > 0) continue; // 庄家只有一张起手暗牌
            const card = G.slots[h][k];
            if (h < 3) this.players[this.order[h]].cards.push(card);
            else this.dealers[h - 3].cards.push(card);
            S.deal();
            await w(this.sp(220));
          }
        }

        // 第3步：边注
        this.phase = 'side';
        for (const seat of this.order) {
          const p = this.players[seat];
          const amt = E.SIDE_RATE * p.ante;
          if (this.target === 22 && p.chips < amt) { this.addLog(`${p.name} 筹码不足，不能买终局注`, 'muted'); continue; }
          const buy = await this.decide('side', seat, w);
          if (!buy) { this.addLog(`${p.name} 不买${this.T.sideName}`); continue; }
          p.side = amt;
          if (this.target === 13) { p.M = p.ante - amt; this.addLog(`${p.name} 买开局注 ${this.fmt(amt)}，主注剩 ${this.fmt(p.M)}`); }
          else { p.chips -= amt; p.paid += amt; this.addLog(`${p.name} 买终局注 ${this.fmt(amt)}`); }
          S.chip();
        }
        this.activeSeat = -1;

        // 第4步：翻开庄家首牌
        this.phase = 'reveal';
        await w(this.sp(450));
        this.dealers.forEach((d) => { d.revealed = true; });
        S.flip();
        await w(this.sp(800));
        const a1 = this.dealers[0].cards[0].value, b1 = this.dealers[1].cards[0].value;
        this.addLog(`庄家首牌：A ${this.dealers[0].cards[0].rank}，B ${this.dealers[1].cards[0].rank}`);

        if (E.isOpenCollision(a1, b1, this.target)) {
          // 开局 10 点／10 点：整桌结束
          this.openCollision = true;
          this.stamps = { A: true, B: true };
          S.stamp();
          await w(this.sp(300));
          this.flash('开局 10／10', 'seal', 2200, '整桌结束，主注全退');
          const anyB = this.players.some((p) => p.side > 0);
          if (anyB) { S.jackpot(); this.burst(); } else S.push();
          this.players.forEach((p) => {
            const ret = p.M + (p.side ? p.side * (1 + E.sideNet(13)) : 0);
            p.chips += ret;
            p.net = ret - p.paid;
            p.result = {
              kind: p.side ? 'bonus' : 'push',
              title: p.side ? '开局注中奖' : '开局结束',
              lines: [p.side ? `开局注 ${this.fmt(p.side)} 净赢 9 倍，主注 ${this.fmt(p.M)} 退回` : `主注 ${this.fmt(p.M)} 全额退回`],
            };
            this.stats.houseNet -= p.net;
          });
          this.stats.opens++;
          this.stats.rounds++;
          this.addLog('庄家首牌 10 点／10 点，整桌结束：主注全退，开局注净赢 9 倍', 'good');
          this.phase = 'roundEnd';
          return;
        }
        if (this.target === 13 && this.players.some((p) => p.side)) this.addLog('不是 10 点／10 点，开局注输掉', 'muted');

        // 庄家后续补牌的分布对所有玩家相同，统一估算一次供提示和电脑玩家使用
        const known = new Set();
        for (let h = 0; h < 3; h++) for (let k = 0; k < this.T.start; k++) known.add(G.slots[h][k].id);
        known.add(G.slots[3][0].id); known.add(G.slots[4][0].id);
        const pool = G.shoe.filter((x) => !known.has(x.id)).map((x) => x.value);
        G.adv = E.makeAdvisor({ target: this.target, pool, a: a1, b: b1, samples: 20000 });

        // 第5步：三人同时锁定 继续／加注／弃牌
        this.phase = 'lock';
        for (const seat of this.order) {
          const choice = await this.decide('lock', seat, w);
          const p = this.players[seat];
          p.lock = choice.opt;
          if (choice.opt === 'raise') { p.raise = choice.C; p.chips -= choice.C; p.paid += choice.C; }
          S.tick();
        }
        this.activeSeat = -1;
        await w(this.sp(300));
        this.players.forEach((p) => { p.lockShown = true; });
        S.flip();
        for (const seat of this.order) {
          const p = this.players[seat];
          if (p.lock === 'raise') this.addLog(`${p.name} 加注 ${this.fmt(p.raise)}，主注合计 ${this.fmt(p.M + p.raise)}`);
          else if (p.lock === 'fold') this.addLog(`${p.name} 弃牌，退回 ${this.fmt(p.M * E.FOLD_REFUND)}`);
          else this.addLog(`${p.name} 普通继续`);
        }
        await w(this.sp(900));

        // 第6步：玩家补牌
        this.phase = 'play';
        for (const seat of this.order) {
          const p = this.players[seat];
          if (p.lock === 'fold') continue;
          this.activeSeat = seat;
          if (p.type === 'human' && this.humanCount > 1) {
            this.banner = null;
            await w(new Promise((resolve) => { this.curtain = { seat, resolve: () => { this.curtain = null; resolve(); } }; }));
          }
          if (p.lock === 'raise') {
            await w(this.sp(500));
            p.cards.push(G.slots[G.handOf[seat]][p.cards.length]);
            S.deal();
            p.status = 'stood';
            this.addLog(`${p.name} 加注后补一张，停牌`);
            await w(this.sp(450));
            continue;
          }
          while (p.cards.length < this.T.maxCards) {
            const act = await this.decide('play', seat, w);
            if (act !== 'hit') break;
            p.cards.push(G.slots[G.handOf[seat]][p.cards.length]);
            S.deal();
            this.addLog(`${p.name} 要牌（现在 ${p.cards.length} 张）`);
            await w(this.sp(400));
          }
          p.status = 'stood';
          this.addLog(`${p.name} 停牌，共 ${p.cards.length} 张`);
          await w(this.sp(250));
        }
        this.activeSeat = -1;

        // 第7步：庄家补牌
        this.phase = 'dealer';
        await w(this.sp(450));
        for (let d = 0; d < 2; d++) {
          const dealer = this.dealers[d];
          while (E.dealerMustDraw(dealer.cards.length, E.total(dealer.cards), this.target)) {
            await w(this.sp(550));
            dealer.cards.push(G.slots[3 + d][dealer.cards.length]);
            S.deal();
          }
          this.addLog(`${dealer.name} 停牌，总分 ${E.total(dealer.cards)}，距离 ${this.dist(dealer.cards)}`);
          await w(this.sp(300));
        }

        // 第8步：结算
        this.phase = 'settle';
        S.flip();
        await w(this.sp(900));
        const ad = this.dist(this.dealers[0].cards);
        const bd = this.dist(this.dealers[1].cards);
        const dealersCollide = ad === bd;
        let anyHumanWin = false, anyWin = false, anyBonus = false;
        for (const seat of this.order) {
          const p = this.players[seat];
          let ret = 0;
          let comparison = null;
          const lines = [];
          // 终局注（仅22）
          if (this.target === 22 && p.side) {
            if (dealersCollide) { const r = E.sideReturn(22, p.side); ret += r; lines.push(`终局注8赔1：净赢 ${this.fmt(r - p.side)}，连本金返还 ${this.fmt(r)}`); }
            else lines.push('终局注未中');
          }
          if (this.target === 13 && p.side) lines.push('开局注未中');
          let main;
          if (p.lock === 'fold') {
            const r = p.M * E.FOLD_REFUND;
            ret += r;
            main = { kind: 'fold', title: '已弃牌', text: `退回主注的 60%，即 ${this.fmt(r)}` };
          } else {
            const pd = this.dist(p.cards);
            const res = E.compare(pd, ad, bd);
            main = E.settleMain(this.target, res, pd, p.M, p.raise);
            ret += main.ret;
            const collided = res.caseNo === 4 ? ['P', 'A', 'B']
              : res.caseNo === 3 ? ['A', 'B'] : res.caseNo === 2 ? ['P', res.hitBy] : [];
            comparison = { pd, ad, bd, collided, winner: res.winner };
            if (main.kind === 'win' || main.kind === 'bonus') { anyWin = true; if (p.type === 'human') anyHumanWin = true; }
            if (main.kind === 'bonus') anyBonus = true;
          }
          p.chips += ret;
          p.net = ret - p.paid;
          p.result = { kind: main.kind, title: main.title, lines: [main.text].concat(lines), comparison };
          this.stats.houseNet -= p.net;
          this.addLog(`${p.name}：${main.title}，本局 ${this.money(p.net)}`, p.net > 0 ? 'good' : p.net < 0 ? 'bad' : '');
          this.selectReview(seat);
          if (comparison && comparison.collided.length) S.stamp();
          await w(this.sp(1100));
        }
        this.selectReview(Math.max(0, this.players.findIndex((p) => p.type === 'human')));
        await w(this.sp(350));
        if (anyBonus) {
          const names = this.players.filter((p) => p.result.kind === 'bonus').map((p) => p.name).join('、');
          if (this.target === 13) this.flash('撞庄！2 赔 1', 'seal', 1800, `${names} 各自获胜；其余玩家按各自结果结算`);
          else this.flash('命中 22！', 'gold', 1800, `${names}：底注2赔1，加注1赔1`);
        }
        if (anyHumanWin || (anyWin && this.humanCount === 0)) { S.win(); this.burst(); }
        else if (!anyWin) S.lose();
        else S.push();
        this.stats.rounds++;
        this.phase = 'roundEnd';
      },

      burst() {
        if (typeof confetti !== 'function') return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const colors = ['#D4AF63', '#F3DE9F', '#B3262E', '#2F9C86', '#F5EEDC'];
        confetti({ particleCount: 110, spread: 75, origin: { y: 0.45 }, colors, scalar: 0.9 });
        setTimeout(() => confetti({ particleCount: 60, angle: 60, spread: 55, origin: { x: 0, y: 0.6 }, colors }), 180);
        setTimeout(() => confetti({ particleCount: 60, angle: 120, spread: 55, origin: { x: 1, y: 0.6 }, colors }), 180);
      },

      stepState(i) {
        const cur = this.phase === 'roundEnd' ? STEPS.length : this.stepIndex;
        if (this.openCollision && i >= 4) return 'skipped';
        if (i < cur) return 'done';
        if (i === cur) return 'current';
        return '';
      },
    },
  }).mount('#app');
})();

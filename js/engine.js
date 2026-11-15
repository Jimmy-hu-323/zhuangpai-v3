/*
 * 撞牌游戏 Version 3 · 规则引擎（纯逻辑，不含界面）
 * 对应《撞牌游戏 Version 3——双主题改良版完整规则》：
 *   两副牌、目标13“撞庄局”与目标22“命中局”、固定预留牌位、
 *   开局注B（仅13）、终局注F（仅22）、继续／加注／弃牌、按目标分别加赔。
 * 浏览器中挂在 window.CollideEngine，Node 中可 require()。
 */
(function (root) {
  'use strict';

  const SUITS = [
    { s: '♠', color: 'black' },
    { s: '♥', color: 'red' },
    { s: '♦', color: 'red' },
    { s: '♣', color: 'black' },
  ];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

  /* ---------------- 固定参数（规则第六、九、十三节） ---------------- */
  const DECKS = 2;              // 两副牌，104 张
  const SIDE_RATE = 0.1;        // B、F 都是原底注的 10%
  const SIDE_FEE = 0.1;         // 仅目标13的开局注奖金收10%费用
  const FOLD_REFUND = 0.6;      // 弃牌退回剩余主注的 60%
  const RAISE_CAP = 3;          // 加注上限 3A
  const UNIT = 100;             // 底注、加注以 100 为单位
  const ANTE_MIN = 100, ANTE_MAX = 5000;

  /** 两个目标各自的设定（规则第二节） */
  const TARGETS = {
    13: {
      target: 13, name: '撞庄局', start: 1, maxCards: 3, dealerStand: 10,
      side: 'B', sideName: '开局撞牌注', sideOdds: 10, sideFee: SIDE_FEE,
      bonusName: '撞庄获胜', bonusText: '两庄相撞获胜 2 赔 1（含加注）',
    },
    22: {
      target: 22, name: '命中局', start: 2, maxCards: 4, dealerStand: 19,
      side: 'F', sideName: '终局撞牌注', sideOdds: 8, sideFee: 0, // 净赢8:1，另退本金
      bonusName: '命中 22', bonusText: '正好 22 并获胜，原底注 2 赔 1',
    },
  };
  /** 边注最终净赔：开局注9:1，终局注8:1 */
  const sideNet = (target) => TARGETS[target].sideOdds * (1 - TARGETS[target].sideFee);

  function rankValue(r) {
    if (r === 'A') return 1;
    if (r === '10' || r === 'J' || r === 'Q' || r === 'K') return 10;
    return Number(r);
  }

  /** 两副标准扑克牌混合，不含大小王 */
  function createShoe() {
    const shoe = [];
    let id = 0;
    for (let d = 0; d < DECKS; d++) {
      for (const su of SUITS) {
        for (const r of RANKS) shoe.push({ id: id++, rank: r, suit: su.s, color: su.color, value: rankValue(r) });
      }
    }
    return shoe;
  }

  function shuffle(arr, rng) {
    rng = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /**
   * 固定预留牌位（规则第五节）。手序号 h：0–2 为本局行动顺序中的玩家，3＝庄家A，4＝庄家B。
   * 第1–5张＝各手第一张，第6–10张＝第二张，第11–15张＝第三张，第16–18张＝玩家第四张。
   */
  const slotIndex = (h, k) => (k < 3 ? k * 5 + h : 15 + h);
  function dealSlots(shoe) {
    const slots = [];
    for (let h = 0; h < 5; h++) {
      const n = h < 3 ? 4 : 3;
      const hand = [];
      for (let k = 0; k < n; k++) hand.push(shoe[slotIndex(h, k)]);
      slots.push(hand);
    }
    return slots;
  }

  const total = (cards) => cards.reduce((s, c) => s + (typeof c === 'number' ? c : c.value), 0);
  const distance = (t, target) => Math.abs(t - target);

  /** 庄家补牌：不足 3 张且总分低于停牌门槛必须补牌（规则第十一节） */
  function dealerMustDraw(nCards, tot, target) {
    return nCards < 3 && tot < TARGETS[target].dealerStand;
  }

  /** 开局 10 点／10 点（仅目标13） */
  function isOpenCollision(aVal, bVal, target) {
    return target === 13 && aVal === 10 && bVal === 10;
  }

  /** 只比较一名玩家与庄家A、B。每位玩家重新比较，玩家之间不比牌、不相撞。 */
  function compare(pd, ad, bd) {
    if (pd === ad && pd === bd) return { outcome: 'push', caseNo: 4, winner: null };
    if (ad === bd) return { outcome: 'win', caseNo: 3, winner: 'P' };
    if (pd === ad) return { outcome: 'lose', caseNo: 2, winner: 'B', hitBy: 'A' };
    if (pd === bd) return { outcome: 'lose', caseNo: 2, winner: 'A', hitBy: 'B' };
    const min = Math.min(pd, ad, bd);
    if (min === pd) return { outcome: 'win', caseNo: 1, winner: 'P' };
    return { outcome: 'lose', caseNo: 1, winner: min === ad ? 'A' : 'B' };
  }

  /**
   * 主游戏结算。M＝剩余主注，C＝加注。返回 { ret 总返还, kind, title, text }
   * 目标13：情况3获胜返还 3K，其余获胜 2K；目标22：命中 22 获胜返还 3M＋2C，其余获胜 2K。
   */
  function settleMain(target, res, pd, M, C) {
    const K = M + C;
    if (res.outcome === 'push') return { ret: K, kind: 'push', title: '你与两庄同距', text: '你、庄家A、庄家B同距，退回你的主注（含加注）' };
    if (res.outcome === 'lose') {
      if (res.caseNo === 2) return { ret: 0, kind: 'lose', title: `与庄家${res.hitBy}相撞`, text: `本次比较中，你与庄家${res.hitBy}同距出局，庄家${res.winner}获胜` };
      return { ret: 0, kind: 'lose', title: '主游戏落败', text: `庄家${res.winner}距离最近` };
    }
    if (target === 13 && res.caseNo === 3) return { ret: 3 * K, kind: 'bonus', title: '撞庄获胜', text: '两庄相撞出局，主注 2 赔 1' };
    if (target === 22 && pd === 0) return { ret: 3 * M + 2 * C, kind: 'bonus', title: '命中 22', text: C ? '原底注 2 赔 1，加注 1 赔 1' : '正好 22，主注 2 赔 1' };
    if (res.caseNo === 3) return { ret: 2 * K, kind: 'win', title: '两庄相撞', text: '庄家同距出局，玩家获胜 1 赔 1' };
    return { ret: 2 * K, kind: 'win', title: '主游戏获胜', text: '距离最近，1 赔 1' };
  }

  /** 边注总返还：中奖返还 本金×(1＋净赔) */
  const sideReturn = (target, amount) => amount * (1 + sideNet(target));

  /* ------------------------------------------------------------------
   * 策略参谋（电脑玩家与“胜率提示”共用）
   * 庄家后续补牌与玩家无关：先用蒙特卡洛估计庄家 (距离A, 距离B) 的联合分布，
   * 再对玩家的补牌逐张枚举，求“继续／加注／弃牌”与“要牌／停牌”的期望。
   * ------------------------------------------------------------------ */
  const MAXD = 48;

  function dealerJoint(pool, a, b, target, samples, rng) {
    rng = rng || Math.random;
    samples = samples || 20000;
    const joint = new Float64Array(MAXD * MAXD);
    const p = pool.slice();
    const n = p.length;
    for (let s = 0; s < samples; s++) {
      let idx = 0;
      const draw = () => {
        const j = idx + Math.floor(rng() * (n - idx));
        const t = p[idx]; p[idx] = p[j]; p[j] = t;
        return p[idx++];
      };
      let ta = a, na = 1;
      while (dealerMustDraw(na, ta, target)) { ta += draw(); na++; }
      let tb = b, nb = 1;
      while (dealerMustDraw(nb, tb, target)) { tb += draw(); nb++; }
      joint[Math.min(distance(ta, target), MAXD - 1) * MAXD + Math.min(distance(tb, target), MAXD - 1)] += 1 / samples;
    }
    return joint;
  }

  /**
   * opts: { target, pool:[未知牌点数...], a, b, samples? }
   * 返回参谋对象，金额单位为“元”，A 为原底注。
   */
  function makeAdvisor(opts) {
    const { target, pool, a, b } = opts;
    const cfg = TARGETS[target];
    const joint = dealerJoint(pool, a, b, target, opts.samples);
    // stM：每 1 元原主注 M 的期望；stC：每 1 元加注 C 的期望
    const stM = new Float64Array(MAXD), stC = new Float64Array(MAXD);
    const prob = new Array(MAXD);
    let pCol = 0;
    for (let x = 0; x < MAXD; x++) pCol += joint[x * MAXD + x];
    for (let d = 0; d < MAXD; d++) {
      let em = 0, ec = 0, w = 0, pu = 0, l = 0, bonus = 0;
      for (let x = 0; x < MAXD; x++) {
        for (let y = 0; y < MAXD; y++) {
          const pr = joint[x * MAXD + y];
          if (!pr) continue;
          const r = compare(d, x, y);
          if (r.outcome === 'push') { pu += pr; continue; }
          if (r.outcome === 'lose') { em -= pr; ec -= pr; l += pr; continue; }
          w += pr;
          if (target === 13 && r.caseNo === 3) { em += 2 * pr; ec += 2 * pr; bonus += pr; }
          else if (target === 22 && d === 0) { em += 2 * pr; ec += pr; bonus += pr; }
          else { em += pr; ec += pr; }
        }
      }
      stM[d] = em; stC[d] = ec; prob[d] = { win: w, push: pu, lose: l, bonus };
    }
    const counts = new Array(11).fill(0);
    for (const v of pool) counts[v]++;
    const N = pool.length;
    const pv = counts.map((c) => c / N);
    const dIdx = (tot) => Math.min(distance(tot, target), MAXD - 1);
    const cache = new Map();

    /** 普通继续：从 (总分, 张数) 起按最佳要牌／停牌，每 1 元 M 的期望 */
    function cont(tot, nc) {
      const k = tot * 8 + nc;
      if (cache.has(k)) return cache.get(k);
      let s = stM[dIdx(tot)];
      if (nc < cfg.maxCards) {
        let h = 0;
        for (let v = 1; v <= 10; v++) if (pv[v]) h += pv[v] * cont(tot + v, nc + 1);
        s = Math.max(s, h);
      }
      cache.set(k, s);
      return s;
    }
    function hitEV(tot, nc) {
      if (nc >= cfg.maxCards) return null;
      let h = 0;
      for (let v = 1; v <= 10; v++) if (pv[v]) h += pv[v] * cont(tot + v, nc + 1);
      return h;
    }
    /** 停牌时的胜／退／负概率 */
    const standProb = (tot) => prob[dIdx(tot)];
    /** 加注：再拿一张后停牌。返回 M 部分与 C 部分每 1 元的期望 */
    function raiseParts(tot) {
      let m = 0, c = 0;
      for (let v = 1; v <= 10; v++) if (pv[v]) { m += pv[v] * stM[dIdx(tot + v)]; c += pv[v] * stC[dIdx(tot + v)]; }
      return { m, c };
    }
    /**
     * 锁定三选一。M＝剩余主注，maxC＝可加注上限（已按筹码和 3A 截断）。
     * 返回 { opt, C, cont, raise, fold, raiseC }，金额为期望净输赢（元）。
     */
    function lock(tot, nc, M, maxC) {
      const evCont = M * cont(tot, nc);
      const r = raiseParts(tot);
      let raiseC = 0, evRaise = -Infinity;
      if (maxC >= UNIT) {
        raiseC = r.c > 0 ? maxC : UNIT; // 加注部分期望为正就加满，否则只考虑最小加注
        evRaise = M * r.m + raiseC * r.c;
      }
      const evFold = -(1 - FOLD_REFUND) * M;
      let opt = 'cont', best = evCont;
      if (evRaise > best) { opt = 'raise'; best = evRaise; }
      if (evFold > best) { opt = 'fold'; best = evFold; }
      return { opt, C: opt === 'raise' ? raiseC : 0, cont: evCont, raise: evRaise, fold: evFold, raiseC, raisePerM: r.m, raisePerC: r.c, M };
    }
    return {
      target, pCol, cont, hitEV, lock, standProb,
      standEV: (tot) => stM[dIdx(tot)],
      shouldHit: (tot, nc) => { const h = hitEV(tot, nc); return h != null && h > stM[dIdx(tot)]; },
    };
  }

  /** 开局 10/10 的条件概率（已知若干张牌被移出） */
  function openCollisionProb(pool) {
    let c = 0;
    for (const v of pool) if (v === 10) c++;
    const N = pool.length;
    return (c / N) * ((c - 1) / (N - 1));
  }

  /** 目标22 两庄终局同距的长期概率（规则第十六节，400 万次模拟） */
  const P_FINAL_COLLIDE_22 = 0.1046;

  const api = {
    SUITS, RANKS, DECKS, SIDE_RATE, SIDE_FEE, FOLD_REFUND, RAISE_CAP, UNIT, ANTE_MIN, ANTE_MAX, TARGETS,
    sideNet, rankValue, createShoe, shuffle, slotIndex, dealSlots, total, distance,
    dealerMustDraw, isOpenCollision, compare, settleMain, sideReturn,
    dealerJoint, makeAdvisor, openCollisionProb, P_FINAL_COLLIDE_22, MAXD,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CollideEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

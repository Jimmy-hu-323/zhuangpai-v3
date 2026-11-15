/*
 * 撞牌 V3 赔率模拟器（可选工具，需要安装 Node.js）
 * 用法：node tools/simulate.js [每个目标的局数]
 * 例：  node tools/simulate.js 200000
 * 玩家按“期望最大化”打法：弃牌／继续／加注按期望选择，要牌按期望选择，不买边注。
 * 边注的赌场优势另外按“每局都买”统计。结果为蒙特卡洛估计，用于课程讨论。
 */
const E = require('../js/engine.js');

const N = Number(process.argv[2] || 100000);
const A = 100;

// 庄家结果分布只依赖 (目标, 庄A首牌, 庄B首牌)，缓存起来加速
const cache = new Map();
function advisorFor(target, a, b) {
  const key = target + ':' + a + ':' + b;
  if (!cache.has(key)) {
    const pool = E.createShoe().map((c) => c.value);
    pool.splice(pool.indexOf(a), 1);
    pool.splice(pool.indexOf(b), 1);
    cache.set(key, E.makeAdvisor({ target, pool, a, b, samples: 60000 }));
  }
  return cache.get(key);
}

for (const target of [13, 22]) {
  const cfg = E.TARGETS[target];
  const st = { wager: 0, net: 0, fold: 0, raise: 0, open: 0, bonus: 0, win: 0, push: 0, lose: 0, sideBet: 0, sideNet: 0 };
  for (let r = 0; r < N; r++) {
    const shoe = E.shuffle(E.createShoe());
    const slots = E.dealSlots(shoe);
    const a = slots[3][0].value, b = slots[4][0].value;
    // 边注（每局都买）单独统计
    const side = E.SIDE_RATE * A;
    st.sideBet += side;
    const dealer = (h) => { const cs = [slots[h][0]]; while (E.dealerMustDraw(cs.length, E.total(cs), target)) cs.push(slots[h][cs.length]); return E.total(cs); };
    if (E.isOpenCollision(a, b, target)) {
      st.open++; st.wager += A; st.sideNet += side * E.sideNet(target);
      continue;
    }
    const ad = E.distance(dealer(3), target), bd = E.distance(dealer(4), target);
    if (target === 13) st.sideNet -= side;
    else st.sideNet += ad === bd ? side * E.sideNet(target) : -side;

    const adv = advisorFor(target, a, b);
    const own = slots[0].slice(0, cfg.start);
    let tot = E.total(own), nc = cfg.start;
    const L = adv.lock(tot, nc, A, E.RAISE_CAP * A);
    if (L.opt === 'fold') { st.fold++; st.wager += A; st.net += -(1 - E.FOLD_REFUND) * A; continue; }
    let C = 0;
    if (L.opt === 'raise') { st.raise++; C = L.C; tot += slots[0][nc].value; nc++; }
    else { while (adv.shouldHit(tot, nc)) { tot += slots[0][nc].value; nc++; } }
    const pd = E.distance(tot, target);
    const res = E.compare(pd, ad, bd);
    const m = E.settleMain(target, res, pd, A, C);
    st[m.kind]++;
    st.wager += A + C;
    st.net += m.ret - A - C;
  }
  const pct = (x) => (x * 100).toFixed(2) + '%';
  console.log(`\n== 目标 ${target}「${cfg.name}」 ${N} 局 ==`);
  console.log(`主游戏赌场优势：${pct(-st.net / st.wager)}（不买边注、按最佳打法；分母为底注＋加注）`);
  console.log(`弃牌 ${pct(st.fold / N)}，加注 ${pct(st.raise / N)}，${cfg.bonusName} ${pct(st.bonus / N)}，普通获胜 ${pct(st.win / N)}，玩家与两庄同距 ${pct(st.push / N)}，输 ${pct(st.lose / N)}${target === 13 ? `，开局10/10结束 ${pct(st.open / N)}` : ''}`);
  console.log(`${cfg.sideName}（每局都买）赌场优势：${pct(-st.sideNet / st.sideBet)}`);
}

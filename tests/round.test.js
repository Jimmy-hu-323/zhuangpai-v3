const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const E = require('../js/engine.js');

// Exercise the actual app round and bankroll updates with predetermined legal cards.
// Only time, browser services, and player choices are replaced.
function makeGame({ target, hands, buy = [true, true, true], locks = ['cont', 'cont', 'fold'], types = ['human','ai','ai'] }) {
  const available = E.createShoe();
  const shoe = [];
  hands.forEach((values, hand) => values.forEach((value, k) => {
    const index = available.findIndex(c => c.value === value);
    assert.notEqual(index, -1);
    shoe[E.slotIndex(hand, k)] = available.splice(index, 1)[0];
  }));
  for (let i = 0; i < 104; i++) if (!shoe[i]) shoe[i] = available.shift();
  let options;
  const errors = [];
  const sound = new Proxy({}, { get: () => () => {} });
  const context = {
    Vue: { createApp: o => { options = o; return { mount() {} }; } },
    window: { CollideEngine: { ...E, shuffle: () => shoe }, Sound: sound, matchMedia: () => ({ matches: true }), scrollTo() {} },
    localStorage: { getItem: () => null, setItem() {} },
    console: { error: e => errors.push(e) },
    setTimeout: fn => { fn(); return 0; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'), context);
  const app = options.data();
  for (const [key, method] of Object.entries(options.methods)) app[key] = method.bind(app);
  for (const [key, getter] of Object.entries(options.computed)) Object.defineProperty(app, key, { get: getter.bind(app) });
  app.$nextTick = () => {};
  app.config.p13 = target === 13 ? 100 : 0;
  app.config.types = types;
  app.startGame();
  app.decide = async (kind, seat) => {
    if (kind === 'ante') return 100;
    if (kind === 'side') return buy[seat];
    if (kind === 'lock') return { opt: locks[seat], C: locks[seat] === 'raise' ? 100 : 0 };
    return 'stand';
  };
  app.assertComplete = () => {
    assert.deepEqual(errors, []);
    assert.equal(app.phase, 'roundEnd');
    assert.equal(app.stats.rounds, 1);
    assert.equal(app.stats.houseNet + app.players.reduce((sum,p) => sum+p.net, 0), 0);
  };
  return app;
}

test('full 22 round: independent push/win/fold, with 8:1 side payouts even after fold', async () => {
  const app = makeGame({ target: 22, hands: [[10,10], [7,8], [8,9], [10,10], [10,10]] });
  await app.startRound();
  app.assertComplete();
  assert.deepEqual(Array.from(app.players, p => p.chips), [10080,10180,10040]);
  assert.deepEqual(Array.from(app.players, p => p.result.kind), ['push','win','fold']);
  assert.equal(app.players[0].result.comparison.pd, 2);
  assert.match(app.players[0].result.lines.join(' '), /净赢 80，连本金返还 90/);
  app.selectReview(0);
  assert.deepEqual(Object.keys(app.stamps).sort(), ['A','B','P0']);
  app.selectReview(1);
  assert.deepEqual(Object.keys(app.stamps).sort(), ['A','B']);
  assert.equal(app.mobileSeat, 1);
  app.selectReview(2);
  assert.deepEqual(Object.keys(app.stamps), []);
  assert.equal(app.comparison, null);
  app.computeHint('side', 0);
  assert.match(app.hint.text, /8 赔 1/);
  assert.match(app.hint.text, /期望约 -0.6/);
});

test('full round: selecting a different player clears the prior collision stamp', async () => {
  const app = makeGame({ target: 22, hands: [[10,10], [8,10], [9,10], [10,10], [10,9]], buy: [false,false,false], locks: ['cont','cont','cont'] });
  await app.startRound();
  app.assertComplete();
  app.selectReview(0);
  assert.deepEqual(Object.keys(app.stamps).sort(), ['A','P0']);
  app.selectReview(1);
  assert.deepEqual(Object.keys(app.stamps), []);
  assert.equal(app.comparison.winner, 'A');
  app.selectReview(2);
  assert.deepEqual(Object.keys(app.stamps).sort(), ['B','P2']);
});

test('full round: raising into 22 preserves the old main-game payout', async () => {
  const app = makeGame({ target: 22, hands: [[10,5,7], [7,8], [8,9], [10,9], [10,10]], buy: [false,false,false], locks: ['raise','fold','fold'] });
  await app.startRound();
  app.assertComplete();
  assert.equal(app.players[0].cards.length, 3);
  assert.equal(app.players[0].result.kind, 'bonus');
  assert.equal(app.players[0].chips, 10300);
});

test('full 13 opening-collision round still refunds main bets and pays 9:1 opening side bet', async () => {
  const app = makeGame({ target: 13, hands: [[4], [5], [6], [10], [10]], buy: [true,false,true] });
  await app.startRound();
  app.assertComplete();
  assert.equal(app.openCollision, true);
  assert.deepEqual(Array.from(app.players, p => p.chips), [10090,10000,10090]);
});

test('shared-device privacy curtain also protects forced draw after a human raise', async () => {
  const app = makeGame({ target:22, hands:[[10,5,7],[7,8],[8,9],[10,9],[10,10]], buy:[false,false,false], locks:['raise','cont','fold'], types:['human','human','ai'] });
  const run = app.startRound();
  const curtains = [];
  for (let tick=0; tick<500 && app.phase !== 'roundEnd'; tick++) {
    await Promise.resolve();
    if (app.curtain) {
      const seat = app.curtain.seat;
      curtains.push(seat);
      assert.equal(app.players[seat].cards.length, 2, 'curtain must precede private draw');
      if (seat === 1) assert.equal(app.cardVisible(0,2), false);
      app.curtain.resolve();
    }
  }
  app.assertComplete();
  await run;
  assert.deepEqual(curtains, [0,1]);
  assert.equal(app.players[0].cards.length, 3);
});

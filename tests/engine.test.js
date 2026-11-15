const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

test('equal-distance players both win independently against more distant dealers', () => {
  // Target 22: players 20 and 24; dealers 19 and 18.
  for (const total of [20, 24]) {
    const result = E.compare(E.distance(total, 22), 3, 4);
    assert.equal(result.outcome, 'win');
    assert.equal(E.settleMain(22, result, 2, 100, 0).ret, 200);
  }
});

test('a player collision does not eliminate a dealer from another player comparison', () => {
  const first = E.compare(2, 2, 3);
  const second = E.compare(4, 2, 3);
  assert.equal(first.hitBy, 'A');
  assert.equal(first.winner, 'B');
  assert.equal(second.winner, 'A');
  assert.equal(second.outcome, 'lose');
  assert.equal(E.compare(1, 2, 3).outcome, 'win');
});

test('dealer collision refunds a matching player but pays other players separately', () => {
  const push = E.compare(5, 5, 5);
  const win = E.compare(4, 5, 5);
  assert.equal(E.settleMain(13, push, 5, 100, 200).ret, 300);
  assert.equal(E.settleMain(13, win, 4, 100, 200).ret, 900);
  assert.equal(E.settleMain(22, win, 4, 100, 200).ret, 600);
});

test('final side bet pays 8 net plus principal; opening side bet stays at 9 net', () => {
  assert.equal(E.sideNet(22), 8);
  assert.equal(E.sideReturn(22, 100), 900);
  assert.equal(E.sideNet(13), 9);
  assert.equal(E.sideReturn(13, 100), 1000);
  assert.equal((1 - E.P_FINAL_COLLIDE_22 * 9).toFixed(4), '0.0586');
});

test('exact 22 still pays the ante at 2:1 and the raise at 1:1', () => {
  const result = E.compare(0, 3, 2);
  assert.equal(E.settleMain(22, result, 0, 100, 300).ret, 900);
  const tie = E.compare(0, 0, 0);
  assert.equal(E.settleMain(22, tie, 0, 100, 300).ret, 400);
});

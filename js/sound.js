/* 音效：全部用 Web Audio 即时合成，不需要任何音频文件 */
(function (root) {
  'use strict';
  let ctx = null;
  let muted = false;

  function ac() {
    if (muted) return null;
    if (!ctx) {
      const C = root.AudioContext || root.webkitAudioContext;
      if (!C) return null;
      try { ctx = new C(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type, vol, when, slideTo) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (when || 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.12, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol, freq, when) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (when || 0);
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = freq || 2000; f.Q.value = 0.8;
    const g = c.createGain(); g.gain.value = vol || 0.2;
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0);
  }

  root.Sound = {
    deal() { noise(0.09, 0.35, 3200); },
    flip() { noise(0.12, 0.3, 1800); tone(520, 0.06, 'triangle', 0.04, 0.03); },
    chip() { tone(2400, 0.07, 'sine', 0.1); tone(3300, 0.06, 'sine', 0.07, 0.035); noise(0.03, 0.12, 5000); },
    reveal() { [392, 523, 659].forEach((f, i) => tone(f, 0.5, 'triangle', 0.08, i * 0.08)); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.32, 'triangle', 0.11, i * 0.09)); },
    jackpot() { [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.4, 'square', 0.05, i * 0.08)); },
    lose() { tone(260, 0.45, 'sawtooth', 0.05, 0, 150); },
    push() { tone(440, 0.25, 'sine', 0.08); tone(440, 0.25, 'sine', 0.06, 0.18); },
    stamp() { tone(110, 0.28, 'sine', 0.35, 0, 55); noise(0.18, 0.4, 700); },
    tick() { tone(1200, 0.03, 'square', 0.03); },
    setMuted(m) { muted = !!m; if (muted && ctx) ctx.suspend(); },
    get muted() { return muted; },
  };
})(window);

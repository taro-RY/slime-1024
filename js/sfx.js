/* Jelly 1024 · 果冻合并 —— 音效
 * 不引任何外部音频文件，用 WebAudio 现场合成。
 * 合并音高随 rank 递增：base * 2^(rank/5)，封顶避免刺耳。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.JellySfx = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function Sfx() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.enabled = true;
  }

  Sfx.prototype.ensure = function () {
    if (this.ctx) return this.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return null; }
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      this.enabled = false;
      return null;
    }
    return this.ctx;
  };

  // 首次用户手势后调用
  Sfx.prototype.unlock = function () {
    var ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  };

  Sfx.prototype.setMuted = function (m) {
    this.muted = !!m;
    if (this.master) {
      this.master.gain.value = this.muted ? 0 : 0.32;
    }
  };

  Sfx.prototype.toggleMute = function () {
    this.setMuted(!this.muted);
    return this.muted;
  };

  // 单个正弦音
  Sfx.prototype.tone = function (freq, dur, type, vol, delay) {
    if (!this.enabled || this.muted) return;
    var ctx = this.ensure();
    if (!ctx) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol == null ? 0.28 : vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  };

  Sfx.prototype.drop = function () {
    this.tone(360, 0.10, 'sine', 0.16);
  };

  // 合并：音高随 rank 递增，双音上行
  Sfx.prototype.merge = function (rank) {
    var f = 420 * Math.pow(2, Math.min(rank, 10) / 5);
    if (f > 1900) f = 1900;
    this.tone(f, 0.16, 'sine', 0.24);
    this.tone(f * 1.5, 0.20, 'triangle', 0.16, 0.055);
  };

  Sfx.prototype.combo = function (combo) {
    var f = 660 + Math.min(combo, 8) * 70;
    this.tone(f, 0.12, 'square', 0.07, 0.02);
  };

  Sfx.prototype.win = function () {
    var notes = [523, 659, 784, 1047, 1319];
    for (var i = 0; i < notes.length; i++) {
      this.tone(notes[i], 0.34, 'triangle', 0.22, i * 0.10);
    }
  };

  Sfx.prototype.lose = function () {
    this.tone(300, 0.26, 'sawtooth', 0.14);
    this.tone(220, 0.36, 'sine', 0.14, 0.13);
  };

  Sfx.prototype.warn = function () {
    this.tone(520, 0.10, 'square', 0.10);
  };

  Sfx.prototype.click = function () {
    this.tone(760, 0.06, 'sine', 0.10);
  };

  return { Sfx: Sfx };
});

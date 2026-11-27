/* Jelly 1024 · 果冻合并 —— 游戏内核
 * 纯逻辑，不依赖 DOM / Canvas / matter.js，便于 Node 无头自测。
 *
 * 负责：事件总线、模式、得分、连击、合并链推进、胜负判定、投放池。
 * 不负责：物理（physics.js）、绘制（render.js）。
 */
(function (root, factory) {
  var Config = (typeof module === 'object' && module.exports)
    ? require('./config.js')
    : root.JellyConfig;
  var mod = factory(Config);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.JellyCore = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Config) {
  'use strict';

  /* ------------------------------------------------------------ 事件 */
  function Emitter() {
    this._handlers = {};
  }
  Emitter.prototype.on = function (evt, fn) {
    (this._handlers[evt] || (this._handlers[evt] = [])).push(fn);
    return this;
  };
  Emitter.prototype.emit = function (evt, payload) {
    var list = this._handlers[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) list[i](payload);
  };

  /* --------------------------------------------------------- 随机源 */
  // 可注入的 RNG，便于测试确定性
  function defaultRng() {
    return Math.random();
  }

  /* ------------------------------------------------------------- 游戏 */
  function Game(options) {
    options = options || {};
    this.emitter = new Emitter();
    this.rng = options.rng || defaultRng;
    this.mode = options.mode || 'single';
    this.reset();
  }

  Game.prototype.on = function (evt, fn) {
    this.emitter.on(evt, fn);
    return this;
  };

  Game.prototype.reset = function () {
    this.state = 'ready';        // ready | running | paused | won | lost
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.lastMergeAt = 0;     // 上一次合并的时刻（连击窗口从它起算）
    this.mergeCount = 0;
    this.dropCount = 0;
    this.maxRank = 0;            // 场上出现过的最高 rank
    this.bestRank = 0;
    this.lastDrop = 0;
    this.nextValue = this.rollValue();
    // 三个救急道具，每局各 1 次（重开才回满，继续无尽不再补）
    this.tools = { shake: 1, absorb: 1, reroll: 1 };
    this.overFrames = 0;         // 连续越线帧数
    this.startedAt = 0;
    this.elapsed = 0;
    return this;
  };

  Game.prototype.start = function (now) {
    if (this.state === 'won' || this.state === 'lost') this.reset();
    this.state = 'running';
    this.startedAt = now || 0;
    this.emitter.emit('state', { state: this.state });
    this.emitter.emit('reset', this.snapshot());
    return this;
  };

  Game.prototype.pause = function () {
    if (this.state !== 'running') return false;
    this.state = 'paused';
    this.emitter.emit('state', { state: this.state });
    return true;
  };

  Game.prototype.resume = function () {
    if (this.state !== 'paused') return false;
    this.state = 'running';
    this.emitter.emit('state', { state: this.state });
    return true;
  };

  Game.prototype.setMode = function (mode) {
    if (!Config.MODES[mode]) return false;
    if (this.mode === mode) return false;
    this.mode = mode;
    this.reset();
    this.emitter.emit('mode', { mode: mode });
    return true;
  };

  // 单局通关后「继续 · 无尽」：换模式，但不清盘、不清分。
  // 与 setMode 的唯一区别就是不做 reset —— 玩家刚花一整局堆出来的球堆和分数，
  // 不该因为点了一颗按钮就消失。
  Game.prototype.continueEndless = function () {
    if (this.mode === 'endless') return false;
    this.mode = 'endless';
    this.state = 'running';
    // 上一局末尾的连击窗口不带到新赛段里
    this.combo = 0;
    this.lastMergeAt = 0;
    this.emitter.emit('mode', { mode: 'endless', keepBoard: true });
    return true;
  };

  // 花掉一次道具。效果本身由 physics / main 执行，这里只管次数与合法性。
  Game.prototype.spendTool = function (name) {
    // 罐子满（dying）时也允许消耗道具救命
    if (this.state !== 'running' && this.state !== 'dying') return false;
    if (!this.tools || !(this.tools[name] > 0)) return false;
    this.tools[name]--;
    return true;
  };

  // 「换一个」：重摇待投放的球
  Game.prototype.rerollNext = function () {
    this.nextValue = this.rollValue();
    return this.nextValue;
  };

  Game.prototype.snapshot = function () {
    return {
      state: this.state,
      mode: this.mode,
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      mergeCount: this.mergeCount,
      dropCount: this.dropCount,
      maxRank: this.maxRank,
      bestRank: this.bestRank,
      nextValue: this.nextValue,
      grade: this.grade()
    };
  };

  /* ------------------------------------------------------- 投放池 */
  Game.prototype.pool = function () {
    // 无尽模式在场上已有较大球时改用更友好的投放池
    if (this.mode === 'endless' && this.maxRank >= 3) return Config.DROP_POOL_EASY;
    return Config.DROP_POOL;
  };

  Game.prototype.rollValue = function () {
    var pool = this.pool();
    var idx = Math.floor(this.rng() * pool.length);
    if (idx < 0) idx = 0;
    if (idx >= pool.length) idx = pool.length - 1;
    return pool[idx];
  };

  // 领取下一个球（投放时调用），并预滚下一个
  Game.prototype.takeDrop = function (now) {
    if (this.state !== 'running') return null;
    if (now - this.lastDrop < Config.PHYSICS.DROP_COOLDOWN_MS) return null;
    var value = this.nextValue;
    this.nextValue = this.rollValue();
    this.lastDrop = now;
    this.dropCount++;
    this.emitter.emit('drop', { value: value, next: this.nextValue, count: this.dropCount });
    return value;
  };

  /* --------------------------------------------------------- 合并 */
  // newRank: 合并后新球的 rank（0..TOP_RANK）。两个同 rank 球合并 => newRank = rank+1
  Game.prototype.merge = function (newRank, now) {
    if (this.state !== 'running') return null;
    if (newRank > Config.TOP_RANK) return null;   // 超出 11 级链，非法
    if (newRank < 1) return null;                 // 1 号球不会由合并产生

    // 连击窗口：距上一次合并超过窗口时间则连击归零
    if (now - this.lastMergeAt > Config.SCORE.COMBO_WINDOW_MS) this.combo = 0;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.lastMergeAt = now;

    var mult = Math.min(this.combo, Config.SCORE.COMBO_MAX);
    var value = Config.valueOfRank(newRank);
    var gained = value * mult;

    this.score += gained;
    this.mergeCount++;
    this.maxRank = Math.max(this.maxRank, newRank);
    this.bestRank = Math.max(this.bestRank, newRank);

    var payload = {
      rank: newRank,
      value: value,
      gained: gained,
      mult: mult,
      combo: this.combo,
      score: this.score
    };
    this.emitter.emit('merge', payload);
    this.emitter.emit('score', { score: this.score, gained: gained });

    // 单局模式：合成 1024 即通关
    if (this.mode === 'single' && newRank === Config.TOP_RANK) {
      this.state = 'won';
      this.emitter.emit('win', this.snapshot());
    }
    return payload;
  };

  /* --------------------------------------------------------- 溢出 */
  // 连续越线帧数的防抖在物理层按球计数（physics.checkOverflow）。
  // 这里只做状态迁移 —— 但分两步：
  //   running --(越线成立)--> dying --(球停稳)--> lost
  // 中间那个 dying 是关键。原来是越线就直接 lost，物理立刻停摆，
  // 球会在半空中被冻住、结算页啪一下弹出来，观感非常突兀。
  // 现在先让物理继续跑，球自己慢慢落定，停稳了才判负。
  Game.prototype.markOverflow = function (over) {
    if (this.state !== 'running') return false;
    if (over) {
      this.state = 'dying';
      this.emitter.emit('dying', this.snapshot());
      return true;
    }
    return false;
  };

  // 收尾结束：球都停稳了（由 main 判定），正式判负
  Game.prototype.finish = function () {
    if (this.state !== 'dying') return false;
    this.state = 'lost';
    this.emitter.emit('over', this.snapshot());
    return true;
  };

  Game.prototype.update = function (dt, now) {
    if (this.state === 'running') {
      this.elapsed += dt;
      // 连击窗口过期归零
      if (this.combo > 0 && now - this.lastMergeAt > Config.SCORE.COMBO_WINDOW_MS) {
        this.combo = 0;
        this.emitter.emit('combo', { combo: 0 });
      }
    }
  };

  Game.prototype.grade = function () {
    if (this.state === 'won') return 'S';
    if (this.state === 'lost') return 'D';
    return Config.gradeOf(this.score);
  };

  Game.prototype.isOver = function () {
    return this.state === 'won' || this.state === 'lost';
  };

  return {
    Emitter: Emitter,
    Game: Game
  };
});

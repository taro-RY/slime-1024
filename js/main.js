/* Jelly 1024 · 果冻合并 —— 主循环 / 输入 / 装配 */
(function (global) {
  'use strict';

  var Config = global.JellyConfig;
  var Core = global.JellyCore;
  var Phys = global.JellyPhysics;
  var Rend = global.JellyRender;
  var SfxMod = global.JellySfx;

  var game, physics, renderer, ui, sfx;
  var previewX = 0;
  var lastTs = 0;
  var rafId = 0;
  var warned = false;
  var hintShown = true;

  /* ------------------------------------------------------------ 启动 */
  function boot() {
    var canvas = document.getElementById('stage');
    renderer = new Rend.Renderer(canvas);
    // 加载 11 张贴图（品红底→抠图），完成前 render.js 会自动回退到过程绘制
    renderer.loadSlimes('assets/slimes/');
    sfx = new SfxMod.Sfx();
    game = new Core.Game({ mode: 'single' });
    physics = new Phys.Physics(global.Matter, { width: 480, height: 760 });

    ui = global.JellyUi.UI.init({
      onMode: onMode,
      onAgain: restart,
      onSound: function () {
        sfx.unlock();
        var m = sfx.toggleMute();
        ui.setSound(m);
        ui.toast(m ? '已静音' : '音效已开');
      },
      onPause: togglePause,
      onTool: useTool,
      onFeel: setFeel,
      onResultClose: closeResult
    });

    layout();
    wireInput();
    wireGame();

    ui.setMode(game.mode);
    ui.setSound(false);
    ui.setNext(game.nextValue);
    ui.setScore(0);
    ui.setCombo(0);
    ui.setMax(0);
    ui.highlightChain(-1);
    ui.setTools(game.tools);

    // 手感：优先用上次存的，没有就用默认档。
    // 必须在 physics / renderer 都建好之后、第一帧之前完成。
    var t0 = loadFeel();
    Config.FEEL.apply(t0);
    ui.setFeel(t0);

    game.start(performance.now());
    lastTs = performance.now();
    rafId = requestAnimationFrame(loop);

    global.Jelly1024App = debugApi();
  }

  /* ------------------------------------------------------------ 布局 */
  function layout() {
    var canvas = document.getElementById('stage');
    var wrap = canvas.parentElement;
    // 画布尺寸必须等于容器的真实尺寸。
    // 之前这里写了 Math.max(240/360, ...) 的下限，矮视口下画布会比容器高一截，
    // 溢出到下面的面板上，罐子也画到画布外面去了（预览球糊在 HUD 上）。
    // 下限交回给物理层 —— 罐子按实际画布高度缩，而不是把画布撑大。
    var w = Math.max(160, wrap.clientWidth);
    var h = Math.max(160, wrap.clientHeight);
    renderer.resize(w, h, window.devicePixelRatio || 1);
    physics.resize(w, h);
    var L = physics.layout;
    previewX = Math.max(L.left + 40, Math.min(L.right - 40, L.left + L.jarW / 2));
  }

  /* ------------------------------------------------------------ 输入 */
  // 竖向滑动阈值（px）：超过它才算「滑」，否则仍是一次点击投放
  var SWIPE_MIN = 22;

  function wireInput() {
    var canvas = document.getElementById('stage');

    window.addEventListener('resize', layout);

    // 指针手势统一走 pointer 事件，鼠标 / 触摸一套代码。
    //  - 鼠标：按下即投放（老手感），拖动只改瞄准位置
    //  - 触摸：抬起才投放；抬手前若竖向滑动超过阈值，则判定为「拉抽屉」手势，不投放
    var down = null;

    canvas.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      var p = canvas.getBoundingClientRect();
      down = {
        id: e.pointerId,
        type: e.pointerType,
        x0: e.clientX,
        y0: e.clientY,
        x: e.clientX,
        y: e.clientY,
        swiped: false
      };
      setPreview(e.clientX - p.left);
      // 鼠标仍旧是「点哪投哪」，按下就投
      if (e.pointerType === 'mouse') {
        down.dropped = true;
        tryDrop();
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      var p = canvas.getBoundingClientRect();
      if (down && e.pointerId === down.id) {
        down.x = e.clientX;
        down.y = e.clientY;
        var dy = down.y - down.y0;
        var dx = down.x - down.x0;
        // 竖向优先：横向分量小、纵向超过阈值 → 认定为抽屉滑动。
        // 只给触摸 / 触控笔认这个手势 —— 鼠标按下时已经投放了，
        // 再把拖拽判成「开面板」就会一边掉球一边开抽屉。
        if (!down.swiped && down.type !== 'mouse' &&
            Math.abs(dy) >= SWIPE_MIN && Math.abs(dy) > Math.abs(dx) * 1.2) {
          down.swiped = true;
        }
      }
      setPreview(e.clientX - p.left);
    });

    canvas.addEventListener('pointerup', function (e) {
      if (!down || e.pointerId !== down.id) return;
      var d = down;
      down = null;

      // 滑动 → 拉/收面板，不投放
      if (d.swiped) {
        var dy = d.y - d.y0;
        if (dy > 0) ui.openPanel();   // 往下滑 → 打开主界面（侧栏 / 抽屉）
        else ui.closePanel();          // 往上滑 → 收起
        return;
      }

      // 触摸：抬起时投放
      if (d.type !== 'mouse') tryDrop();
    });

    canvas.addEventListener('pointercancel', function () { down = null; });
    canvas.addEventListener('pointerleave', function (e) {
      if (down && e.pointerType === 'mouse' && e.pointerId === down.id) down = null;
    });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        // 结算开着 → 关掉（留出看罐子的余地）；结算关着但已结束 → 叫回来；
        // 其余情况才是投放。原来空格在结算时是「重开」，太粗暴了 ——
        // 想看罐子的人会被它直接把这一局抹掉。
        if (ui.isResultOpen()) { closeResult(); return; }
        if (game.isOver()) { openResult(); return; }
        tryDrop();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPreview(previewX - 26);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPreview(previewX + 26);
      } else if (e.key === 'r' || e.key === 'R') {
        restart();
      } else if (e.key === 'p' || e.key === 'P') {
        togglePause();
      } else if (e.code === 'Digit1' || e.key === '1') {
        useTool('shake');
      } else if (e.code === 'Digit2' || e.key === '2') {
        useTool('absorb');
      } else if (e.code === 'Digit3' || e.key === '3') {
        useTool('reroll');
      } else if (e.key === 'm' || e.key === 'M') {
        sfx.unlock();
        var m = sfx.toggleMute();
        ui.setSound(m);
        ui.toast(m ? '已静音' : '音效已开');
      } else if (e.key === 'Escape') {
        // Esc 只关结算，不动这一局。想重开有 R 和「再来一局」。
        if (ui.isResultOpen()) closeResult();
      }
    });

    // 首次手势解锁音频
    var unlock = function () { sfx.unlock(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  function setPreview(x) {
    var L = physics.layout;
    var r = Config.radiusOfRank(Config.rankOf(game.nextValue));
    previewX = Math.max(L.left + r, Math.min(L.right - r, x));
  }

  function tryDrop() {
    // 结算弹窗开着：点不到画布（有遮罩），什么都不做
    if (ui.isResultOpen()) return false;

    // 局面已经结束、但结算被关掉了 —— 再点画面就把结算叫回来。
    // 这是为了能先关掉弹窗看看罐子堆成什么样，而不是被结果页挡住。
    if (game.isOver()) {
      openResult();
      return false;
    }

    if (game.state !== 'running') return false;
    sfx.unlock();
    var now = performance.now();
    var value = game.takeDrop(now);
    if (value == null) return false;
    var rank = Config.rankOf(value);
    var ball = physics.spawn(rank, previewX);
    ball.animAt = now;
    sfx.drop();
    if (hintShown) {
      hintShown = false;
      ui.hideHint();
    }
    return true;
  }

  /* ------------------------------------------------------------ 手感 */
  // 读上次保存的手感；localStorage 在 file:// 下也可能被禁用，所以全程 try 包住
  function loadFeel() {
    try {
      var raw = window.localStorage.getItem(Config.FEEL.KEY);
      if (raw == null) return Config.FEEL.DEFAULT;
      var t = Number(raw);
      if (!isFinite(t)) return Config.FEEL.DEFAULT;
      return Math.max(0, Math.min(1, t));
    } catch (e) {
      return Config.FEEL.DEFAULT;
    }
  }

  function saveFeel(t) {
    try { window.localStorage.setItem(Config.FEEL.KEY, String(t)); } catch (e) { /* 无痕模式等，忽略 */ }
  }

  // 滑块拖动 → 立刻改参数，并当场戳一下罐子里的球，
  // 让"变软/变硬"这件事看得见
  function setFeel(t) {
    Config.FEEL.apply(t);
    saveFeel(t);
    physics.poke(0.7);
  }

  /* ------------------------------------------------------------ 道具 */
  // 三个道具都是一次性的救急手段：用完就没了，重开才回满。
  function useTool(name) {
    // 罐子满了（dying）时也允许用道具 —— 这正是救命的关键时刻
    if ((game.state !== 'running' && game.state !== 'dying') || ui.isResultOpen()) return;
    if (!game.tools || game.tools[name] <= 0) {
      ui.toast('这个道具已经用完了', 900);
      return;
    }
    // 罐子里还是空的，就别白白浪费一次「吸小球」
    if (name === 'absorb' && !physics.balls.length) {
      ui.toast('罐子里还没有球', 900);
      return;
    }
    if (!game.spendTool(name)) return;
    sfx.unlock();

    if (name === 'shake') {
      physics.shake();
      renderer.addShake(12);
      sfx.click();
      ui.toast('摇一摇 · 整罐甩起来重落', 1000);
    } else if (name === 'absorb') {
      var info = physics.absorbSmallest();
      if (info) {
        renderer.burst(info.x, info.y, info.rank, 16);
        renderer.ripple(info.x, info.y, info.r);
        renderer.floatText(info.x, info.y - info.r, '−' + info.value, '#fff');
        sfx.merge(info.rank);
      }
      ui.toast('吸走了最小的一颗', 1000);
    } else if (name === 'reroll') {
      game.rerollNext();
      ui.setNext(game.nextValue);
      sfx.click();
      ui.toast('换了一个球', 900);
    }

    ui.setTools(game.tools);
  }

  /* -------------------------------------------------------- 游戏事件 */
  function wireGame() {
    // 每投一次都要把「下一个」同步到记分牌，否则那里会一直停在开局那个数
    game.on('drop', function (p) {
      ui.setNext(p.next);
    });

    game.on('merge', function (p) {
      sfx.merge(p.rank);
      ui.setScore(p.score);
      ui.setCombo(p.combo);
      if (p.combo > 1) {
        sfx.combo(p.combo);
        ui.toast('连击 ×' + Math.min(p.combo, 5) + '  ' + p.gained + ' 分', 900);
      }
    });

    game.on('win', function (s) {
      sfx.win();
      renderer.addShake(10);
      showResult(s, true);
    });

    // 越线成立了，球正在慢慢落定 —— 这时候先给个话，别让玩家干等
    game.on('dying', function () {
      sfx.warn();
      ui.toast('罐子满了，球落定就结算…', 1800);
    });

    game.on('over', function (s) {
      sfx.lose();
      showResult(s, false);
    });

    game.on('mode', function (p) {
      // 「继续 · 无尽」不清盘，HUD 由 continueEndless() 自己同步，
      // 这里不能走 applyMode()，否则会把场上特效和分数一起抹掉。
      if (p && p.keepBoard) return;
      applyMode();
    });
  }

  function applyMode() {
    ui.setMode(game.mode);
    ui.setNext(game.nextValue);
    ui.setScore(0);
    ui.setCombo(0);
    ui.setMax(0);
    ui.highlightChain(-1);
    ui.setTools(game.tools);
    renderer.clearEffects();
    warned = false;
    dyingStart = 0;   // 收尾计时也要清，否则重开后第一帧就被判超时
    lastResult = null;
    ui.setRvHint(false);
  }

  /* ------------------------------------------------------------ 结算 */
  // 最近一次的结算内容。留着它，玩家把结算关掉看完罐子之后还能再叫回来 ——
  // 否则「关掉」就变成单向操作，再想看只能重开一局。
  var lastResult = null;

  function showResult(s, won) {
    var grade = game.grade();
    var stats = [
      ['得分', s.score],
      ['最大史莱姆', Config.valueOfRank(s.maxRank)],
      ['合成次数', s.mergeCount],
      ['投放次数', s.dropCount],
      ['最高连击', s.maxCombo]
    ];
    var html = '<div class="stat-grid">';
    for (var i = 0; i < stats.length; i++) {
      html += '<div class="stat-cell"><span>' + stats[i][0] + '</span><b>' + stats[i][1] + '</b></div>';
    }
    html += '</div><div class="grade-badge grade-' + grade + '">' + grade + '</div>';

    lastResult = {
      icon: won ? '👑' : '🫧',
      tone: won ? 'win' : 'lose',
      title: won ? '史莱姆之王诞生了！' : '罐子满了',
      desc: won
        ? '你把史莱姆一路喂到了 1024，它戴上了王冠。这一罐还能接着堆，冲个更高的分？'
        : '史莱姆堆过线了，再来一局？',
      altLabel: won ? '继续 · 无尽模式' : '换个模式',
      altPrimary: won,
      statsHtml: html
    };
    ui.showResult(lastResult);
  }

  // 把结算叫回来（关掉之后点画面用）
  function openResult() {
    if (!lastResult || ui.isResultOpen()) return;
    sfx.click();
    ui.showResult(lastResult);
  }

  // 关掉结算：露出罐子本身，并在角落留一个「还能叫回来」的提示
  function closeResult() {
    if (!ui.isResultOpen()) return;
    ui.hideResult();
    ui.setRvHint(true);
  }

  function restart() {
    ui.hideResult();
    physics.clear();
    renderer.clearEffects();
    game.reset();
    game.start(performance.now());
    applyMode();
    warned = false;
  }

  function togglePause() {
    if (game.state === 'running') {
      game.pause();
      ui.toast('已暂停', 900);
    } else if (game.state === 'paused') {
      game.resume();
      ui.toast('继续', 700);
    }
  }

  function onMode(mode) {
    if (mode === 'toggle') {
      // 单局通关后，第二颗按钮的语义是「继续 · 无尽」：
      // 接着这一局的球堆和分数往下打，而不是清盘换模式。
      if (game.mode === 'single' && game.state === 'won') {
        continueEndless();
        return;
      }
      mode = game.mode === 'single' ? 'endless' : 'single';
    }
    if (mode === game.mode) return;
    ui.hideResult();
    physics.clear();
    renderer.clearEffects();
    game.setMode(mode);
    game.start(performance.now());
    applyMode();
    warned = false;
    ui.toast(mode === 'single' ? '单局：合成 1024 通关' : '无尽：冲分模式', 1200);
  }

  // 单局通关 → 接着这局玩无尽：不动物理世界，只把模式与 HUD 同步过来
  function continueEndless() {
    if (!game.continueEndless()) return;
    ui.hideResult();
    ui.setRvHint(false);
    lastResult = null;
    warned = false;
    ui.setMode(game.mode);
    ui.setNext(game.nextValue);
    ui.setCombo(0);
    // 分数、最大球、合并链都保留 —— 这正是「继续」而不是「换模式」的意义
    ui.setScore(game.score);
    ui.setMax(Config.valueOfRank(game.maxRank));
    ui.highlightChain(game.maxRank);
    ui.toast('无尽模式：这堆球接着冲', 1500);
  }

  /* ------------------------------------------------------------ 主循环 */
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    var dt = Math.min(48, ts - lastTs);
    lastTs = ts;

    if (game.state === 'running') {
      physics.step(dt);
      game.update(dt, ts);
      processMerges(ts);
      checkOverflow();
    } else if (game.state === 'dying') {
      // 收尾中：物理继续跑，让球自己落定，但不接受投放、不再判溢出
      physics.step(dt);
      checkSettled(ts);
    }

    renderer.update(dt);
    renderer.draw({
      layout: physics.layout,
      balls: physics.balls,
      preview: game.state === 'running' ? { x: previewX, rank: Config.rankOf(game.nextValue) } : null,
      now: ts
    });
  }

  /* ---------------------------------------------------------- 合并 */
  function processMerges(now) {
    var pairs = physics.findMerges();
    if (!pairs.length) return;
    var consumed = {};
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (consumed[p.a.id] || consumed[p.b.id]) continue;
      consumed[p.a.id] = 1;
      consumed[p.b.id] = 1;

      var newBall = physics.mergePair(p);
      newBall.animAt = now;

      // game.merge 接收「合并后新球的 rank」
      var res = game.merge(newBall.rank, now);
      if (!res) continue;

      renderer.burst(newBall.body.position.x, newBall.body.position.y, newBall.rank, 14);
      renderer.ripple(newBall.body.position.x, newBall.body.position.y, newBall.r);
      renderer.floatText(newBall.body.position.x, newBall.body.position.y - newBall.r,
        '+' + res.gained, '#fff');
      renderer.addShake(Math.min(6, 1.6 + newBall.rank * 0.5));

      ui.setMax(Config.valueOfRank(game.maxRank));
      ui.highlightChain(game.maxRank);
    }
  }

  /* ---------------------------------------------------------- 溢出 */
  function checkOverflow() {
    var res = physics.checkOverflow();
    if (res.any && !warned) {
      warned = true;
      sfx.warn();
      ui.toast('快满啦！', 1000);
    } else if (!res.any) {
      warned = false;
    }
    // 判负由物理层的连续帧防抖决定
    if (res.over) game.markOverflow(true);
  }

  /* -------------------------------------------------------- 收尾判定 */
  // 越线成立后不立刻判负，而是等罐子里的球自己停下来。
  // 两个出口：
  //   1) 所有球都慢下来了（正常情况，通常一两百毫秒）
  //   2) 兜底超时 —— 万一有球卡在角落里一直微动，不能无限等下去
  //
  // 这两个数字都刻意压得很短（1s / 速度阈值 1.4）。收尾只是"让最后一颗球
  // 落到该落的位置"，是半拍的余韵，不是让玩家干等 —— 上一版给到 2.6s，
  // 观感上就是"球在慢慢爬"，那不对。
  var SETTLE_SPEED = 1.4;      // px/step，低于它就算「停了」
  var SETTLE_TIMEOUT = 1000;   // ms
  var dyingStart = 0;

  function checkSettled(ts) {
    if (!dyingStart) { dyingStart = ts; return; }

    var maxSpd = 0;
    for (var i = 0; i < physics.balls.length; i++) {
      var s = physics.balls[i].body.speed || 0;
      if (s > maxSpd) maxSpd = s;
    }

    if (maxSpd < SETTLE_SPEED || ts - dyingStart > SETTLE_TIMEOUT) {
      dyingStart = 0;
      game.finish();
    }
  }

  /* -------------------------------------------------------- 调试接口 */
  function debugApi() {
    return {
      game: game,
      physics: physics,
      renderer: renderer,
      ui: ui,
      sfx: sfx,
      state: function () {
        return {
          state: game.state,
          mode: game.mode,
          score: game.score,
          combo: game.combo,
          maxRank: game.maxRank,
          ballCount: physics.balls.length,
          nextValue: game.nextValue,
          layout: {
            left: physics.layout.left,
            right: physics.layout.right,
            top: physics.layout.top,
            bottom: physics.layout.bottom,
            dangerY: physics.layout.dangerY,
            jarW: physics.layout.jarW,
            jarH: physics.layout.jarH
          }
        };
      },
      dropAt: function (x, value) {
        if (value != null) game.nextValue = value;
        setPreview(x);
        return tryDrop();
      },
      forceMerge: function (rank) {
        // 造两个同 rank 球并立即合并，用于测试
        var L = physics.layout;
        var r = Config.radiusOfRank(rank);
        var a = physics.spawn(rank, L.left + L.jarW * 0.3, L.bottom - r - 2);
        var b = physics.spawn(rank, L.left + L.jarW * 0.7, L.bottom - r - 2);
        var nb = physics.mergePair({ a: a, b: b, rank: rank });
        nb.animAt = performance.now();
        var res = game.merge(nb.rank, performance.now());
        if (res) {
          ui.setScore(game.score);
          ui.setMax(Config.valueOfRank(game.maxRank));
          ui.highlightChain(game.maxRank);
        }
        return res;
      },
      restart: restart,
      setMode: onMode,
      setFeel: setFeel,
      // 当前生效的形变参数，用来断言滑块真的改到了物理层
      feel: function () {
        return {
          stiff: Config.JELLY.SQUASH_STIFF,
          damp: Config.JELLY.SQUASH_DAMP,
          impulse: Config.JELLY.SQUASH_IMPULSE,
          cap: Config.JELLY.CAP,
          idleAmp: Config.JELLY.IDLE_AMP
        };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);

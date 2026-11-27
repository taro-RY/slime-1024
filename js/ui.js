/* Jelly 1024 · 果冻合并 —— DOM / HUD 层 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.JellyUi = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }

  // 面板开合在两套布局里是两件事：桌面是「右侧栏收掉」，移动是「底部抽屉拉出」。
  // 逻辑上只存一个 panelOpen，落到 DOM 上时再按视口翻译成对应的 class。
  var panelOpen = false;
  var NARROW = '(max-width: 900px)';

  function isNarrow() {
    return !!(window.matchMedia && window.matchMedia(NARROW).matches);
  }

  // 窄屏把模式切换挪进底部抽屉 —— 它是「开局前选一次」的东西，
  // 没必要常驻在本来就紧张的顶部。宽屏再挪回 HUD 中间。
  var modeHome = null;

  function syncModeSwitch(narrow) {
    var ms = UI.el.modeWrap;
    if (!ms) return;
    if (narrow) {
      if (modeHome) return;
      var bar = document.getElementById('drawer-top');
      if (!bar) return;
      modeHome = { parent: ms.parentNode, next: ms.nextSibling };
      bar.appendChild(ms);
    } else if (modeHome) {
      modeHome.parent.insertBefore(ms, modeHome.next);
      modeHome = null;
    }
  }

  function applyPanelState() {
    var body = document.body;
    var narrow = isNarrow();
    body.classList.toggle('panel-collapsed', !panelOpen && !narrow);
    body.classList.toggle('panel-open', panelOpen && narrow);
    syncModeSwitch(narrow);
    if (UI.el.panelBtn) {
      UI.el.panelBtn.textContent = panelOpen ? '✕' : '☰';
      UI.el.panelBtn.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
    }
  }

  var UI = {
    el: {},
    handlers: {},
    chainBuilt: false,

    init: function (handlers) {
      this.handlers = handlers || {};
      this.el = {
        canvas: $('#stage'),
        score: $('#hud-score'),
        combo: $('#hud-combo'),
        next: $('#hud-next'),
        chain: $('#chain-list'),
        modeWrap: $('#mode-switch'),
        modeHint: $('#mode-hint'),
        target: $('#hud-target'),
        overlay: $('#overlay'),
        resultIcon: $('#result-icon'),
        resultTitle: $('#result-title'),
        resultDesc: $('#result-desc'),
        resultStats: $('#result-stats'),
        btnAgain: $('#btn-again'),
        btnMode: $('#btn-mode'),
        btnSound: $('#btn-sound'),
        btnPause: $('#btn-pause'),
        hint: $('#hint'),
        toast: $('#toast'),
        tools: $('#tools'),
        feel: $('#feel'),
        feelNow: $('#feel-now'),
        modal: $('#modal'),
        closeResult: $('#btn-close-result'),
        rvHint: $('#rv-hint'),
        maxBall: $('#hud-max'),
        scoreboard: $('#scoreboard'),
        btnScore: $('#btn-score'),
        side: $('#side'),
        panelBtn: $('#btn-panel'),
        drawerHandle: $('#drawer-handle')
      };
      this.bind();
      this.buildChain();
      this.initPanel();
      return this;
    },

    // 初始开合：桌面开着右侧栏，移动端只露把手。
    // 记分板同理 —— 窄屏默认只留「得分」，宽屏默认全展开。
    initPanel: function () {
      panelOpen = !isNarrow();
      applyPanelState();
      if (this.el.scoreboard) {
        this.el.scoreboard.classList.toggle('mini', isNarrow());
      }
      window.addEventListener('resize', function () { applyPanelState(); });
    },

    /* ------------------------------------------------- 面板 / 记分板 */
    openPanel: function () {
      if (panelOpen) return;
      panelOpen = true;
      applyPanelState();
    },
    closePanel: function () {
      if (!panelOpen) return;
      panelOpen = false;
      applyPanelState();
    },
    togglePanel: function () {
      panelOpen = !panelOpen;
      applyPanelState();
    },
    isPanelOpen: function () { return panelOpen; },
    toggleScore: function () {
      if (!this.el.scoreboard) return;
      this.el.scoreboard.classList.toggle('mini');
    },

    bind: function () {
      var self = this;
      var h = this.handlers;

      if (this.el.modeWrap) {
        this.el.modeWrap.addEventListener('click', function (e) {
          var btn = e.target.closest('button[data-mode]');
          if (!btn) return;
          h.onMode && h.onMode(btn.getAttribute('data-mode'));
        });
      }
      this.el.btnAgain.addEventListener('click', function () { h.onAgain && h.onAgain(); });
      this.el.btnMode.addEventListener('click', function () { h.onMode && h.onMode('toggle'); });
      this.el.btnSound.addEventListener('click', function () { h.onSound && h.onSound(); });
      this.el.btnPause.addEventListener('click', function () { h.onPause && h.onPause(); });

      if (this.el.tools) {
        this.el.tools.addEventListener('click', function (e) {
          var btn = e.target.closest('button[data-tool]');
          if (!btn || btn.disabled) return;
          h.onTool && h.onTool(btn.getAttribute('data-tool'));
        });
      }

      // 手感滑块：input 事件是连续的，拖到哪就实时生效到哪
      if (this.el.feel) {
        var self = this;
        this.el.feel.addEventListener('input', function () {
          var v = Number(self.el.feel.value) / 100;
          if (self.el.feelNow) self.el.feelNow.textContent = feelLabel(v);
          h.onFeel && h.onFeel(v);
        });
      }

      // 结算页得能关掉 —— 罐子满了之后有人就想先看看罐子长什么样。
      // 两条路径：右上角的 ✕，和点弹窗外的遮罩。
      if (this.el.closeResult) {
        this.el.closeResult.addEventListener('click', function () {
          h.onResultClose ? h.onResultClose() : UI.hideResult();
        });
      }
      if (this.el.overlay) {
        this.el.overlay.addEventListener('click', function (e) {
          // 只有点在遮罩本身上才算「关」；点弹窗内部不该关
          if (e.target !== self.el.overlay) return;
          h.onResultClose ? h.onResultClose() : UI.hideResult();
        });
      }

      /* -------------------------------------------- 记分板 / 面板开关 */
      // 记分板：得分常驻，连击 + 下一个折进 ▾
      if (this.el.btnScore) {
        this.el.btnScore.addEventListener('click', function (e) {
          e.stopPropagation();
          UI.toggleScore();
        });
      }

      // 侧栏开关按钮：桌面折叠右栏 / 移动端拉出底部抽屉
      if (this.el.panelBtn) {
        this.el.panelBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          UI.togglePanel();
        });
      }

      // 移动端抽屉把手：点一下展开 / 收起
      if (this.el.drawerHandle) {
        this.el.drawerHandle.addEventListener('click', function (e) {
          e.stopPropagation();
          if (UI.isPanelOpen()) UI.closePanel();
          else UI.openPanel();
        });
      }
    },

    /* ------------------------------------------------------ 合并链 */
    buildChain: function () {
      if (!this.el.chain) return;
      var html = '';
      for (var i = 0; i < 11; i++) {
        html += '<li class="chain-item" data-rank="' + i + '">' +
          '<span class="chain-dot"></span>' +
          '<span class="chain-val">' + (1 << i) + '</span>' +
          '</li>';
      }
      this.el.chain.innerHTML = html;
      this.chainBuilt = true;
    },

    // 高亮已达成的链位
    highlightChain: function (rank) {
      if (!this.chainBuilt) return;
      var items = this.el.chain.children;
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('done', i <= rank);
        items[i].classList.toggle('cur', i === rank);
      }
    },

    /* -------------------------------------------------------- HUD */
    setScore: function (score) {
      if (!this.el.score) return;
      var s = String(score);
      var changed = this.el.score.textContent !== s;
      this.el.score.textContent = s;
      // 加分时弹一下（动效只挂在事件上，静止时不动）
      if (changed && score > 0) {
        var el = this.el.score;
        el.classList.remove('bump');
        void el.offsetWidth;          // 强制回流，让动画能重播
        el.classList.add('bump');
        clearTimeout(this._bumpTimer);
        this._bumpTimer = setTimeout(function () { el.classList.remove('bump'); }, 460);
      }
    },

    setCombo: function (combo) {
      if (!this.el.combo) return;
      if (combo > 1) {
        this.el.combo.textContent = '×' + Math.min(combo, 5);
        this.el.combo.classList.add('on');
      } else {
        this.el.combo.textContent = '—';
        this.el.combo.classList.remove('on');
      }
    },

    setNext: function (value) {
      if (!this.el.next) return;
      this.el.next.textContent = String(value);
      this.el.next.className = 'next-val rank-' + rankOf(value);
    },

    setMax: function (value) {
      if (this.el.maxBall) this.el.maxBall.textContent = String(value);
    },

    // 同步三个道具的剩余次数；用完的按钮变灰并置为 disabled
    setTools: function (tools) {
      if (!this.el.tools) return;
      var btns = this.el.tools.querySelectorAll('button[data-tool]');
      for (var i = 0; i < btns.length; i++) {
        var name = btns[i].getAttribute('data-tool');
        var n = (tools && tools[name]) || 0;
        btns[i].disabled = n <= 0;
        btns[i].classList.toggle('used', n <= 0);
        var badge = btns[i].querySelector('.tool-n');
        if (badge) badge.textContent = String(n);
      }
    },

    // 从外部同步手感滑块（启动时读回上次保存的位置）
    setFeel: function (t) {
      if (!this.el.feel) return;
      var pct = Math.round(Math.max(0, Math.min(1, Number(t) || 0)) * 100);
      this.el.feel.value = String(pct);
      if (this.el.feelNow) this.el.feelNow.textContent = feelLabel(pct / 100);
    },

    // 同步模式开关与目标区文案
    setMode: function (mode, target) {
      if (this.el.modeWrap) {
        var btns = this.el.modeWrap.querySelectorAll('button[data-mode]');
        for (var i = 0; i < btns.length; i++) {
          btns[i].classList.toggle('on', btns[i].getAttribute('data-mode') === mode);
        }
      }
      if (this.el.modeHint) {
        this.el.modeHint.textContent = mode === 'single'
          ? '养出史莱姆之王（1024）即通关'
          : '无限冲分，看你能养到多大';
      }
      if (this.el.target) {
        this.el.target.textContent = mode === 'single'
          ? '目标 1024'
          : '无尽模式';
      }
    },

    setSound: function (muted) {
      if (this.el.btnSound) {
        this.el.btnSound.textContent = muted ? '🔇 已静音' : '🔊 音效';
        this.el.btnSound.classList.toggle('off', muted);
      }
    },

    /* ------------------------------------------------------ 提示条 */
    toast: function (text, ms) {
      if (!this.el.toast) return;
      this.el.toast.textContent = text;
      this.el.toast.classList.add('on');
      var self = this;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(function () {
        self.el.toast.classList.remove('on');
      }, ms || 1200);
    },

    hideHint: function () {
      if (this.el.hint) this.el.hint.classList.add('gone');
    },

    /* -------------------------------------------------------- 结算 */
    showResult: function (info) {
      if (!this.el.overlay) return;
      this.el.resultIcon.textContent = info.icon;
      this.el.resultIcon.className = 'result-icon ' + (info.tone || '');
      this.el.resultTitle.textContent = info.title;
      this.el.resultDesc.textContent = info.desc;
      this.el.resultStats.innerHTML = info.statsHtml;
      // 第二颗按钮的语义随结算类型变化：
      //   输掉 → 换个模式；单局通关 → 接着这一局继续冲无尽
      if (this.el.btnMode) this.el.btnMode.textContent = info.altLabel || '换个模式';
      // 通关时把「继续」抬成主按钮 —— 这时候玩家最想干的是接着堆，
      // 「再来一局」反而是那个把刚堆好的球堆扔掉的选择。
      var swap = !!info.altPrimary;
      this.el.btnAgain.classList.toggle('btn-primary', !swap);
      this.el.btnMode.classList.toggle('btn-primary', swap);
      this.el.overlay.classList.add('on');
      this.setRvHint(false);     // 弹窗开着的时候，不需要「点画面看结果」的提示
    },

    hideResult: function () {
      if (!this.el.overlay) return;
      this.el.overlay.classList.remove('on');
    },

    // 「点画面可以再看一次结果」的小提示：只在结算已出、弹窗被关掉时显示
    setRvHint: function (on) {
      if (this.el.rvHint) this.el.rvHint.classList.toggle('on', !!on);
    },

    isResultOpen: function () {
      return !!(this.el.overlay && this.el.overlay.classList.contains('on'));
    }
  };

  function rankOf(value) {
    var n = 0;
    while (n < 10 && (1 << n) < value) n++;
    return n;
  }

  // 滑块位置 → 人话。与 config.FEEL.label 同档，但这里不依赖 config，
  // 免得 ui 层还要为一句文案去 require 整个配置。
  function feelLabel(t) {
    t = Number(t);
    if (!isFinite(t)) t = 0.5;
    if (t < 0.34) return '软糯';
    if (t < 0.66) return '标准';
    if (t < 0.86) return '弹牙';
    return '蹦床';
  }

  return { UI: UI };
});

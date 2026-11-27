/* Jelly 1024 · 果冻合并 —— 常量与配置
 * 纯数据模块，Node 可直接 require（供无头自测）。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.JellyConfig = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------ 合并链 */
  // 11 级：1 → 2 → 4 → … → 1024
  var CHAIN = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

  // 索引即 rank（0 = 数值 1）
  function rankOf(value) {
    var i = CHAIN.indexOf(value);
    return i < 0 ? 0 : i;
  }
  function valueOfRank(rank) {
    return CHAIN[Math.max(0, Math.min(CHAIN.length - 1, rank | 0))];
  }

  /* -------------------------------------------------------------- 容器 */
  // 世界坐标（逻辑单位）固定宽度，高度随视口比例变化
  var WORLD = {
    WIDTH: 480,        // 世界宽（逻辑像素），容器左右墙内侧间距 = 480 - 2*PAD
    HEIGHT: 760,       // 世界高（逻辑像素）
    PAD_X: 26,        // 左右内边距
    TOP: 54,          // 容器顶部（投放线之上留空）
    BOTTOM: 46,       // 容器底部离世界底
    DANGER: 96        // 警戒线距容器顶
  };

  /* -------------------------------------------------------------- 球体 */
  var BALL = {
    // 半径随 rank 线性缓增：R = BASE * (1 + GROW * rank)
    // 不用 sqrt(value)：那样 1024 球半径会是 1 球的 32 倍，容器放不下
    BASE_RADIUS: 21,
    GROW: 0.16,
    // 1 号球在 480 宽的容器里占比
    MIN_RADIUS: 21,
    MAX_RADIUS: 21 * (1 + 0.16 * 10)   // 1024 球 ≈ 54.6，占宽 11.4% < 1/3
  };

  function radiusOfRank(rank) {
    return BALL.BASE_RADIUS * (1 + BALL.GROW * (rank | 0));
  }

  /* ------------------------------------------------------------ 投放池 */
  // 加权随机。期望值 ≈ 9.36，故凑出 1024 约需 110 次投放
  var DROP_POOL = [
    1, 1, 1,
    2, 2,
    4, 4, 4,
    8, 8,
    16, 16,
    32, 32
  ];
  // 无尽模式：场上已有较大球时改用更友好的投放池（期望值 ≈ 5.1）
  var DROP_POOL_EASY = [
    1, 1, 1,
    2, 2, 2,
    4, 4, 4,
    8, 8,
    16
  ];

  /* -------------------------------------------------------------- 物理 */
  var PHYSICS = {
    // ── 掉落手感 ────────────────────────────────────────────────
    // 这三个数决定「球掉下来要多快」，实测落一整罐（约 720px）的耗时：
    //     GRAVITY 0.75 / FRICTION_AIR 0.016 / SPAWN_VY 0  →  1700ms  ← 之前那版，太拖
    //     GRAVITY 1.50 / FRICTION_AIR 0.005 / SPAWN_VY 4  →   920ms  ← 现在
    // 空气阻力是元凶：0.016 太大，球下落几百毫秒就到了终末速度，
    // 之后变成在蜂蜜里匀速往下飘，完全没有「砸下来」的势能感。
    // 重力回到 1.5（matter 默认 1.0 之上）把加速段压短，落得干脆。
    //
    // 注意 MAX_SPEED=14 会把峰值速度钳住 —— 这也是为什么再往上加
    // 重力收益递减（1.6 → 900ms，2.0 → 850ms）。但这个钳制是好事：
    // 它同时保证「撞击速度」不变，所以果冻的形变幅度不受重力影响。
    GRAVITY: 1.5,
    RESTITUTION: 0.12,      // 果冻感：几乎不回弹，落地是「pia」不是「当当」
    FRICTION: 0.06,
    FRICTION_AIR: 0.005,
    DENSITY: 0.0016,
    SLOP: 0.05,             // 允许的穿透量（matter 默认值）：避免求解器抖动
    POSITION_ITERATIONS: 16, // 堆叠求解精度（默认 6）：球堆不互相穿插
    VELOCITY_ITERATIONS: 12,
    MAX_SPEED: 14,          // 单步最大位移（px/step）：防止高速球击穿地板
    FIXED_DT: 1000 / 60,
    MAX_SUBSTEPS: 3,
    MERGE_EPS: 1.0,         // 合并判定额外容差（像素）：太大会导致"未接触就合并"
    OVER_FRAMES: 30,        // 连续多少帧越线才判负（防抖）
    REST_SPEED: 0.8,        // 低于该速度才算「静止在堆里」（px/step）
    DROP_COOLDOWN_MS: 220,  // 两次投放最小间隔
    // 出生就给一点初速度：0 会让球从静止开始掉，起手那几帧软绵绵的。
    // 给一点点，出手就「嗒」一下，干脆很多。
    SPAWN_VY: 4
  };

  /* ------------------------------------------------------------ 果冻形变 */
  // squash & stretch 用「阻尼弹簧」实现：碰撞给冲量 → 形变 → 回弹并轻微过冲
  // 「很软很软的史莱姆」靠四件事：
  //   1. 低刚度 + 极低阻尼 → 撞一下要晃很久才停（不是一次到位）
  //   2. 大 FLATTEN + 大 BULGE → 压下去要往两边鼓，才像软体不是像石头
  //   3. 低恢复系数（见 PHYSICS.RESTITUTION）→ 落地是「pia」不是「当当」
  //   4. IDLE_* 环境呼吸 → 静止时也在微微晃，看起来「活着」
  var JELLY = {
    SQUASH_STIFF: 130,      // 弹簧刚度（越低越软趴趴、振荡越慢）
    SQUASH_DAMP: 3.6,       // 阻尼（越小余振越久，「布灵布灵」地晃）
    SQUASH_IMPULSE: 20,     // 碰撞冲量系数
    SQUASH_MAX: 0.85,       // 形变量上限
    BULGE: 0.15,            // 压扁时横向增宽比例（体积感：压下去往两边鼓）
    FLATTEN: 0.58,          // 压扁时纵向压缩比例
    TALLEN: 0.28,           // 拉伸时纵向拉长比例
    STRETCH_VY: 0.022,      // 下落速度 → 纵向拉伸
    STRETCH_MAX: 0.22,
    CAP: 1.10,              // 视觉半轴上限（相对碰撞半径），再大就会明显陷进邻居
    IDLE_AMP: 0.075,        // 静止时的环境呼吸振幅（史莱姆「活着」的关键）
    IDLE_FREQ: 0.0052,      // 主呼吸频率（rad/ms）
    IDLE_FREQ2: 0.0113,     // 次级抖动频率（双频叠加更像果冻）
    IDLE_SPEED: 0.9,        // 低于该速度（px/step）才启用环境呼吸
    BLOB_BASE: 0.032,       // 轮廓基础起伏振幅
    BLOB_ENERGY: 0.055      // 撞击余能对轮廓抖动的加成
  };

  /* ---------------------------------------------------------- 果冻手感
   * 玩家可以在界面上用滑块自己调：t ∈ [0,1]，0 = 最软糯，1 = 最弹牙。
   * 所有形变参数统一由这一个 t 推导 —— 而不是把五个数字都摊给玩家，
   * 那样一定会调出互相打架的组合（比如「极软 + 极高阻尼」= 一点都不晃）。
   *
   * 实现要点：这里直接改 JELLY 对象自身的字段。physics.js 与 render.js
   * 在加载时就持有了同一个对象的引用，所以改完下一帧立刻生效，
   * 不需要重建物理世界、不需要重挂监听。
   */
  var FEEL = {
    // 默认 = 标准档，也就是「手感滑块加进来之前」那一版的参数。
    // 那一版的手感是对的，所以把它当成基准点，软端与弹端各往两侧推 ——
    // 而不是另发明一组新参数。t = 0.5 时算出来的值，和 JELLY 的出厂初值逐项相等。
    DEFAULT: 0.5,
    KEY: 'jelly1024.feel',   // localStorage 持久化

    // t ∈ [0,1]：0 = 最软糯，0.5 = 基准，1 = 最弹牙
    apply: function (t) {
      t = Number(t);
      if (!isFinite(t)) t = FEEL.DEFAULT;
      t = Math.max(0, Math.min(1, t));
      var k = (t - 0.5) * 2;          // -1 .. 0 .. +1

      // 软端：刚度砍到 42%、阻尼砍到 45% —— 这两个数决定「晃得久不久」
      // 弹端：刚度拉到两倍、阻尼加四成
      JELLY.SQUASH_STIFF = 130 * (k <= 0 ? 1 + k * 0.58 : 1 + k * 1.00);  // 54.6 / 130 / 260
      JELLY.SQUASH_DAMP = 3.6 * (k <= 0 ? 1 + k * 0.55 : 1 + k * 0.40);   // 1.62 / 3.6 / 5.04
      JELLY.SQUASH_IMPULSE = 20 * (k <= 0 ? 1 - k * 0.60 : 1 - k * 0.15); // 32  / 20  / 17

      // 压扁时的体量分配
      JELLY.BULGE = 0.15 * (1 - k * 0.45);        // 0.2175 / 0.15 / 0.0825
      JELLY.FLATTEN = 0.58 * (1 - k * 0.24);      // 0.719  / 0.58 / 0.441

      // 视觉半轴上限：软端放宽一点，但不越过 1.12（再多就会明显陷进邻居）
      var cap = 1.10 - k * 0.02;
      JELLY.CAP = Math.max(1.08, Math.min(1.12, cap));

      // 静止呼吸
      JELLY.IDLE_AMP = 0.075 * (1 - k * 0.50);    // 0.1125 / 0.075 / 0.0375

      // 轮廓起伏
      JELLY.BLOB_BASE = 0.032 * (1 - k * 0.40);   // 0.0448 / 0.032 / 0.0192
      JELLY.BLOB_ENERGY = 0.055 * (1 - k * 0.58); // 0.087  / 0.055 / 0.0231

      return t;
    },

    // 给滑块位置起个人话名字
    label: function (t) {
      t = Number(t);
      if (!isFinite(t)) t = FEEL.DEFAULT;
      if (t < 0.34) return '软糯';
      if (t < 0.66) return '标准';
      if (t < 0.86) return '弹牙';
      return '蹦床';
    }
  };

  /* -------------------------------------------------------------- 配色 */
  // 紫粉系：浅粉 → 浅橙 → 奶黄 → 嫩绿 → 青碧 → 天蓝 → 蓝紫 → 香芋紫 → 玫紫 → 深紫罗兰 → 深紫(1024)
  // 这些颜色同时用于 HUD 合并链圆点、"下一个"数值色、Canvas 回退绘制
  var PALETTE = [
    { fill: '#ffd0e4', deep: '#f0a8c8', light: '#ffeaf2', text: '#7a2a4a' }, // 1   浅粉
    { fill: '#ffd0a8', deep: '#f0a870', light: '#ffe8d0', text: '#7a4010' }, // 2   浅橙
    { fill: '#fff0b8', deep: '#f0d878', light: '#fff8dc', text: '#7a6010' }, // 4   奶黄
    { fill: '#c8f0b8', deep: '#98d078', light: '#e4f8d8', text: '#3a6018' }, // 8   嫩绿
    { fill: '#b8ecd8', deep: '#78c8b0', light: '#d8f4ea', text: '#185a48' }, // 16  青碧
    { fill: '#b8dcff', deep: '#78b0e8', light: '#d8ecff', text: '#18487a' }, // 32  天蓝
    { fill: '#c4bcf0', deep: '#8878d8', light: '#e0daf8', text: '#281878' }, // 64  蓝紫
    { fill: '#d8c0f0', deep: '#a888d8', light: '#ecdcf8', text: '#481878' }, // 128 香芋紫
    { fill: '#e8a8d8', deep: '#c878b0', light: '#f4d4e8', text: '#6a1848' }, // 256 玫紫
    { fill: '#a878c8', deep: '#7848a8', light: '#d0b8e8', text: '#381048' }, // 512 深紫罗兰
    { fill: '#7858a0', deep: '#503878', light: '#b098d0', text: '#e8dcf0' }  // 1024 深紫（金冠）
  ];

  function colorOfRank(rank) {
    return PALETTE[Math.max(0, Math.min(PALETTE.length - 1, rank | 0))];
  }

  /* -------------------------------------------------------------- 得分 */
  var SCORE = {
    BASE: 10,               // 合并基分
    COMBO_WINDOW_MS: 2000,  // 连击窗口
    COMBO_MAX: 5            // 连击倍率上限
  };

  /* -------------------------------------------------------------- 模式 */
  var MODES = {
    single: { id: 'single', name: '单局', target: 1024, desc: '合成 1024 即通关' },
    endless: { id: 'endless', name: '无尽', target: null, desc: '无限冲分，看你能到多大' }
  };

  /* -------------------------------------------------------------- 等级 */
  var GRADES = [
    { min: 0, g: 'C' },
    { min: 2000, g: 'B' },
    { min: 5000, g: 'A' },
    { min: 12000, g: 'S' }
  ];

  function gradeOf(score) {
    var g = 'C';
    for (var i = 0; i < GRADES.length; i++) {
      if (score >= GRADES[i].min) g = GRADES[i].g;
    }
    return g;
  }

  // 装载默认手感：必须在导出之前跑一次，
  // 否则 JELLY 里留着的还是上面那份「出厂初值」，跟实际默认档位对不上。
  FEEL.apply(FEEL.DEFAULT);

  return {
    CHAIN: CHAIN,
    rankOf: rankOf,
    valueOfRank: valueOfRank,
    TOP_RANK: CHAIN.length - 1,
    TOP_VALUE: 1024,
    WORLD: WORLD,
    BALL: BALL,
    radiusOfRank: radiusOfRank,
    DROP_POOL: DROP_POOL,
    DROP_POOL_EASY: DROP_POOL_EASY,
    PHYSICS: PHYSICS,
    JELLY: JELLY,
    FEEL: FEEL,
    PALETTE: PALETTE,
    colorOfRank: colorOfRank,
    SCORE: SCORE,
    MODES: MODES,
    gradeOf: gradeOf
  };
});

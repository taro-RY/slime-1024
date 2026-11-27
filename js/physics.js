/* Jelly 1024 · 果冻合并 —— 物理层（matter.js 封装）
 *
 * 职责
 *  - 维护容器（罐子）的四壁与地面
 *  - 生成 / 移除球体，驱动固定步长物理
 *  - 每帧做 O(n²) 距离判定检测合并（不依赖 collisionStart —— 持续接触只触发一次会漏合并）
 *  - 越线（溢出）检测：单球连续 30 帧越警戒线才判负，避免弹跳瞬时误判
 *  - 窗口 resize：按比例换算球的坐标，不出现球卡在墙外
 *
 * 坐标约定：世界坐标 = 画布 CSS 像素，罐子居中，宽度有上限（宽屏不至于变成扁盘子）。
 */
(function (root, factory) {
  var Config = (typeof module === 'object' && module.exports)
    ? require('./config.js')
    : root.JellyConfig;
  var mod = factory(Config);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.JellyPhysics = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Config) {
  'use strict';

  var P = Config.PHYSICS;
  var J = Config.JELLY;

  /* ---------------------------------------------------------- 布局 */
  // 由画布尺寸推导罐子矩形（世界坐标）
  function computeLayout(width, height) {
    var pad = 18;
    var maxJarW = 560;
    var jarW = Math.min(width - pad * 2, maxJarW);
    if (jarW < 220) jarW = Math.max(200, width - pad * 2);
    if (jarW < 120) jarW = Math.max(60, width);
    // 罐高：既要够玩，也绝不能超过画布。
    // 这里曾经写死 420 的上限 —— 结果宽屏 / 竖屏下画布明明还有一大截高度，
    // 罐子却只有 420，几颗球就顶到警戒线，玩家体感「太容易满了」。
    // 现在按罐宽给一个比例上限（保持罐子不变成细长条），
    // 再和画布实际高度取小 —— 能用的高度全部给玩法。
    var jarHMax = Math.max(420, Math.round(jarW * 1.75));
    var jarH = Math.min(height - pad * 2, jarHMax);
    if (jarH < 200) jarH = Math.max(120, height - pad * 2);
    if (jarH < 120) jarH = 120;
    var jarX = Math.round((width - jarW) / 2);
    // 罐子必须完整落在画布里，上边不留负数
    var jarY = Math.max(0, Math.round((height - jarH) / 2));
    return {
      width: width,
      height: height,
      jarX: jarX,
      jarY: jarY,
      jarW: jarW,
      jarH: jarH,
      left: jarX,
      right: jarX + jarW,
      top: jarY,
      bottom: jarY + jarH,
      // 投放线：罐口内侧一点
      spawnY: jarY + 26,
      // 警戒线
      dangerY: jarY + Config.WORLD.DANGER
    };
  }

  /* ------------------------------------------------------------ 物理 */
  function Physics(Matter, options) {
    options = options || {};
    this.M = Matter;
    this.engine = Matter.Engine.create();
    this.engine.gravity.y = P.GRAVITY;
    this.engine.positionIterations = P.POSITION_ITERATIONS;
    this.engine.velocityIterations = P.VELOCITY_ITERATIONS;
    this.world = this.engine.world;

    this.balls = [];
    this.nextId = 1;
    this.accumulator = 0;
    this.layout = computeLayout(options.width || 480, options.height || 760);
    this.mergedThisFrame = [];
    this.overflowBall = null;

    var self = this;
    this._onCollide = function (ev) {
      for (var i = 0; i < ev.pairs.length; i++) {
        var pair = ev.pairs[i];
        var a = pair.bodyA, b = pair.bodyB;
        var sa = Math.abs(a.velocity.x - b.velocity.x) + Math.abs(a.velocity.y - b.velocity.y);
        var impact = Math.min(1, sa / 10);
        if (a.plugin && a.plugin.ball) self._squash(a, impact);
        if (b.plugin && b.plugin.ball) self._squash(b, impact);
      }
    };
    Matter.Events.on(this.engine, 'collisionStart', this._onCollide);

    this._buildWalls();
  }

  // 碰撞冲量 → squash 弹簧的速度项（不是直接设置位移，才有回弹过冲）
  Physics.prototype._squash = function (body, impact) {
    if (impact <= 0) return;
    var p = body.plugin;
    var v = (p.squashV || 0) + impact * J.SQUASH_IMPULSE;
    if (v > 40) v = 40;
    p.squashV = v;
  };

  Physics.prototype._buildWalls = function () {
    var M = this.M;
    var L = this.layout;
    var opts = { isStatic: true, restitution: 0.1, friction: 0.4 };
    var wallT = 40;
    var self = this;
    this.walls = [
      M.Bodies.rectangle(L.left - wallT / 2, L.top + L.jarH / 2, wallT, L.jarH * 3, opts),
      M.Bodies.rectangle(L.right + wallT / 2, L.top + L.jarH / 2, wallT, L.jarH * 3, opts),
      M.Bodies.rectangle(L.left + L.jarW / 2, L.bottom + wallT / 2, L.jarW + wallT * 2, wallT, opts)
    ];
    this.walls.forEach(function (w) {
      w.plugin = { ball: false };
      self.M.Composite.add(self.world, w);
    });
  };

  /* --------------------------------------------------------- 尺寸 */
  Physics.prototype.resize = function (width, height) {
    var old = this.layout;
    var next = computeLayout(width, height);
    var sx = old.jarW > 0 ? next.jarW / old.jarW : 1;
    var sy = old.jarH > 0 ? next.jarH / old.jarH : 1;

    for (var i = 0; i < this.balls.length; i++) {
      var b = this.balls[i];
      var nx = next.left + (b.body.position.x - old.left) * sx;
      var ny = next.top + (b.body.position.y - old.top) * sy;
      this.M.Body.setPosition(b.body, { x: nx, y: ny });
      this.M.Body.setVelocity(b.body, {
        x: b.body.velocity.x * sx,
        y: b.body.velocity.y * sy
      });
      b.spawnOffsetY = (b.spawnOffsetY || 0) * sy;
    }

    // 拆掉旧墙，按新尺寸重建
    var M = this.M;
    for (var w = 0; w < this.walls.length; w++) M.Composite.remove(this.world, this.walls[w]);
    this.layout = next;
    this._buildWalls();
  };

  /* ---------------------------------------------------------- 球体 */
  Physics.prototype.radiusFor = function (rank) {
    return Config.radiusOfRank(rank);
  };

  Physics.prototype.spawn = function (rank, x, y) {
    var M = this.M;
    var L = this.layout;
    var r = this.radiusFor(rank);
    var px = Math.max(L.left + r, Math.min(L.right - r, x));
    var py = (y == null ? L.spawnY : y);
    var body = M.Bodies.circle(px, py, r, {
      restitution: P.RESTITUTION,
      friction: P.FRICTION,
      frictionAir: P.FRICTION_AIR,
      density: P.DENSITY,
      slop: P.SLOP
    });
    body.plugin = { ball: true, squash: 0, squashV: 0, spawnY: py };
    M.Body.setVelocity(body, { x: (Math.random() - 0.5) * 1.2, y: P.SPAWN_VY });
    M.Composite.add(this.world, body);
    var ball = {
      id: this.nextId++,
      rank: rank,
      value: Config.valueOfRank(rank),
      r: r,
      body: body,
      age: 0,
      overFrames: 0,
      supported: false,
      bornAt: Date.now()
    };
    this.balls.push(ball);
    return ball;
  };

  Physics.prototype.removeBall = function (ball) {
    var idx = this.balls.indexOf(ball);
    if (idx >= 0) this.balls.splice(idx, 1);
    this.M.Composite.remove(this.world, ball.body);
  };

  Physics.prototype.clear = function () {
    for (var i = 0; i < this.balls.length; i++) {
      this.M.Composite.remove(this.world, this.balls[i].body);
    }
    this.balls.length = 0;
    this.accumulator = 0;
  };

  /* ---------------------------------------------------------- 道具 */
  // 摇一摇：把整罐球「甩起来」—— 强力上抛 + 左右乱甩 + 自旋。
  // 球飞起来散开、再落下重新堆，才能真正打破卡死的堆叠、腾出空间。
  // 力度贴近 MAX_SPEED(14) 但留余量，避免击穿地板/侧壁。
  Physics.prototype.shake = function () {
    var M = this.M;
    for (var i = 0; i < this.balls.length; i++) {
      var b = this.balls[i];
      var v = b.body.velocity;
      // 上抛：8~12，每个球略有差异，避免整罐像一块砖一起上下
      var up = -(8 + Math.random() * 4) * (0.85 + Math.random() * 0.3);
      // 左右乱甩：-6 ~ +6，把整齐的堆叠打散
      var side = (Math.random() - 0.5) * 12;
      M.Body.setVelocity(b.body, {
        x: v.x * 0.2 + side,
        y: up
      });
      // 自旋：球转起来，碰撞时更混乱，落位更随机
      M.Body.setAngularVelocity(b.body, (Math.random() - 0.5) * 0.5);
      // 视觉形变：整罐球「啪」地弹一下
      b.body.plugin.squashV += (Math.random() - 0.5) * 12;
    }
  };

  // 戳一下：只给形变速度，不改位置、不改速度。
  // 用来让玩家在拖动「手感」滑块时，当场看到罐子里的球换个软硬再晃一遍 ——
  // 不这么做，空罐子状态下调滑块是完全看不出差别的。
  Physics.prototype.poke = function (power) {
    var k = power || 0.6;
    for (var i = 0; i < this.balls.length; i++) {
      this.balls[i].body.plugin.squashV += (Math.random() < 0.5 ? -1 : 1) * k;
    }
  };

  // 吸小球：移除场上一颗最小的球（同 rank 取最靠上的那颗），返回它用于特效
  Physics.prototype.absorbSmallest = function () {
    var best = null;
    for (var i = 0; i < this.balls.length; i++) {
      var b = this.balls[i];
      if (!best ||
          b.rank < best.rank ||
          (b.rank === best.rank && b.body.position.y < best.body.position.y)) {
        best = b;
      }
    }
    if (!best) return null;
    var info = {
      x: best.body.position.x,
      y: best.body.position.y,
      r: best.r,
      rank: best.rank,
      value: best.value
    };
    this.removeBall(best);
    return info;
  };

  /* ---------------------------------------------------------- 步进 */
  Physics.prototype.step = function (dtMs) {
    var dt = Math.min(50, dtMs);
    this.accumulator += dt;
    var steps = 0;
    var h = P.FIXED_DT / 1000;   // 固定步长（秒）
    while (this.accumulator >= P.FIXED_DT && steps < P.MAX_SUBSTEPS) {
      this.M.Engine.update(this.engine, P.FIXED_DT);
      this.accumulator -= P.FIXED_DT;
      steps++;
      for (var i = 0; i < this.balls.length; i++) {
        this._limitSpeed(this.balls[i].body);
        this._integrateSquash(this.balls[i].body, h);
      }
    }
    if (steps === P.MAX_SUBSTEPS) this.accumulator = 0;

    for (var j = 0; j < this.balls.length; j++) this.balls[j].age++;
  };

  // 限速：单步位移过大时球会"穿过"地板/墙壁
  Physics.prototype._limitSpeed = function (body) {
    var v = body.velocity;
    var sp = Math.sqrt(v.x * v.x + v.y * v.y);
    if (sp > P.MAX_SPEED) {
      var k = P.MAX_SPEED / sp;
      this.M.Body.setVelocity(body, { x: v.x * k, y: v.y * k });
    }
  };

  // 阻尼弹簧：squash 为形变量（正=被压扁，负=被拉伸），squashV 为其速度
  // 碰撞给的是速度冲量，因此形变会自然过冲回弹（果冻的"布灵布灵"）
  Physics.prototype._integrateSquash = function (body, h) {
    var p = body.plugin;
    var x = p.squash || 0;
    var v = p.squashV || 0;
    // 半隐式欧拉：a = -k*x - c*v
    v += (-J.SQUASH_STIFF * x - J.SQUASH_DAMP * v) * h;
    x += v * h;
    if (x > J.SQUASH_MAX) { x = J.SQUASH_MAX; v = 0; }
    else if (x < -J.SQUASH_MAX) { x = -J.SQUASH_MAX; v = 0; }
    p.squash = x;
    p.squashV = v;
  };

  /* ---------------------------------------------------------- 合并 */
  // 返回本帧可合并的球对列表：[{a, b, rank}]
  Physics.prototype.findMerges = function () {
    var list = [];
    var balls = this.balls;
    for (var i = 0; i < balls.length; i++) {
      var a = balls[i];
      if (a.rank >= Config.TOP_RANK) continue;   // 1024 球不参与合并
      for (var j = i + 1; j < balls.length; j++) {
        var b = balls[j];
        if (b.rank !== a.rank) continue;
        var dx = a.body.position.x - b.body.position.x;
        var dy = a.body.position.y - b.body.position.y;
        var reach = a.r + b.r + P.MERGE_EPS;
        if (dx * dx + dy * dy < reach * reach) {
          list.push({ a: a, b: b, rank: a.rank });
        }
      }
    }
    return list;
  };

  // 执行一次合并：移除两球，生成 rank+1 的新球，返回新球与新 rank
  Physics.prototype.mergePair = function (pair) {
    var a = pair.a, b = pair.b;
    var newRank = pair.rank + 1;
    var r = this.radiusFor(newRank);
    var M = this.M;
    var mx = (a.body.position.x + b.body.position.x) / 2;
    var my = (a.body.position.y + b.body.position.y) / 2;
    var vx = (a.body.velocity.x + b.body.velocity.x) / 2;
    var vy = (a.body.velocity.y + b.body.velocity.y) / 2;

    this.removeBall(a);
    this.removeBall(b);

    var L = this.layout;
    var px = Math.max(L.left + r, Math.min(L.right - r, mx));
    // 新球比被合并的两球更大，底边必须钳制在地板之上，否则会穿地
    var py = Math.max(L.top + r, Math.min(L.bottom - r, my));

    var body = M.Bodies.circle(px, py, r, {
      restitution: P.RESTITUTION,
      friction: P.FRICTION,
      frictionAir: P.FRICTION_AIR,
      density: P.DENSITY,
      slop: P.SLOP
    });
    body.plugin = { ball: true, squash: 0.5, squashV: 0, spawnY: py };
    // 合并瞬间不再继续下沉（弹跳观感由渲染层的合并动画负责）
    M.Body.setVelocity(body, { x: vx, y: Math.min(vy, 0) });
    M.Composite.add(this.world, body);

    var ball = {
      id: this.nextId++,
      rank: newRank,
      value: Config.valueOfRank(newRank),
      r: r,
      body: body,
      age: 0,
      overFrames: 0,
      supported: false,
      bornAt: Date.now(),
      isNew: true
    };
    this.balls.push(ball);
    return ball;
  };

  /* ---------------------------------------------------------- 溢出 */
  // 判负条件：球顶越过警戒线，且该球"确实被支撑住"（躺在球堆里而不是空中飞过），
  //           且该状态连续维持 OVER_FRAMES 帧。
  //
  // 注意：不能用"曾经碰撞过"这种一次性标记 —— 球弹跳一次后该标记会一直为真，
  //       导致空中飞过警戒线的球被误判为"堆高了"，白白判负。
  // 因此这里每帧重新计算支撑关系：球与其它球贴合，或贴着罐底，即视为被支撑。
  Physics.prototype._computeSupport = function () {
    var balls = this.balls;
    var L = this.layout;
    for (var i = 0; i < balls.length; i++) {
      var b = balls[i];
      var p = b.body.position;
      var supported = false;

      // 贴着罐底
      if (p.y + b.r >= L.bottom - 3) supported = true;

      if (!supported) {
        for (var j = 0; j < balls.length; j++) {
          if (j === i) continue;
          var o = balls[j];
          var dx = p.x - o.body.position.x;
          var dy = p.y - o.body.position.y;
          var reach = b.r + o.r + 2;
          if (dx * dx + dy * dy < reach * reach) { supported = true; break; }
        }
      }

      // 速度过快说明还在飞行，不算"堆住了"
      b.supported = supported && b.body.speed < P.REST_SPEED;
    }
  };

  // 返回 { over: 是否已满足判负, any: 本帧是否有球越线, ball: 越线球 }
  Physics.prototype.checkOverflow = function () {
    var L = this.layout;
    this._computeSupport();
    var over = null;
    var any = null;
    for (var i = 0; i < this.balls.length; i++) {
      var b = this.balls[i];
      var topY = b.body.position.y - b.r;
      var settled = b.supported && b.age >= 10;
      if (settled && topY < L.dangerY) {
        b.overFrames++;
        if (!any) any = b;
        if (!over || b.overFrames > over.overFrames) over = b;
      } else {
        b.overFrames = 0;
      }
    }
    this.overflowBall = over || any;
    return {
      over: !!over && over.overFrames >= P.OVER_FRAMES,
      any: !!any,
      ball: over || any,
      dangerY: L.dangerY
    };
  };

  /* ---------------------------------------------------------- 统计 */
  Physics.prototype.maxRank = function () {
    var m = -1;
    for (var i = 0; i < this.balls.length; i++) {
      if (this.balls[i].rank > m) m = this.balls[i].rank;
    }
    return m;
  };

  Physics.prototype.dangerY = function () {
    return this.layout.dangerY;
  };

  Physics.prototype.destroy = function () {
    this.M.Events.off(this.engine, 'collisionStart', this._onCollide);
    this.clear();
    for (var i = 0; i < this.walls.length; i++) this.M.Composite.remove(this.world, this.walls[i]);
    this.walls = [];
    this.M.Engine.clear(this.engine);
  };

  return {
    Physics: Physics,
    computeLayout: computeLayout
  };
});

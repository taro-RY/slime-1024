/* Jelly 1024 · 果冻合并 —— 渲染层（Canvas 2D）
 *
 * 美术方向：Miniature dioramas（微缩立体模型）
 *  参考锚点 Tiny Glade（夜色）/ Townscaper（糖果圆角）/ Dorfromantik（大色块）
 *  整套原则只有四条，全部落在这一层：
 *   1. 单一光源（左上）。球的高光、玻璃反光、UI 顶部高光共用同一方向。
 *   2. 柔和接触阴影。球落在罐底/别的球上时投一圈柔和的接触暗；
 *      飞行中的球只有淡而散的投影 —— 这是"微缩模型"最省力也最有效的一笔。
 *   3. 圆润简形 + 克制景深。罐子是厚玻璃（罐口卷边、罐底厚玻璃、侧壁反光条），
 *      内景从上到下渐暗（微缩场景的"远处"），但没有一处炫技式的细节。
 *   4. 球体保留"布灵布灵"的通透感 —— 只是把高光调柔、把描边改成
 *      随光向渐变的亮边，看起来像一颗软糖，而不是一颗抛光的塑料球。
 *
 * 形变
 *  - squash & stretch：下落纵向拉伸，落地横向压扁再回弹
 *  - 合并动画：新球 260ms 内 scale 1.35 → 0.92 → 1.0
 */
(function (root, factory) {
  var Config = (typeof module === 'object' && module.exports)
    ? require('./config.js')
    : root.JellyConfig;
  var mod = factory(Config);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.JellyRender = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Config) {
  'use strict';

  var MERGE_ANIM_MS = 260;
  var J = Config.JELLY;
  // 画布里的数字也走页面同一套圆体字（Nunito 由 @font-face 本地嵌入），
  // 否则页面是圆体、罐子里是等宽体，一眼就"两块东西拼起来的"。
  var NUM_FONT = 'Nunito, "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif';

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.particles = [];
    this.floaters = [];
    this.shake = 0;
    this.ripples = [];
    this.slimeImages = [];      // 11 张抠好图的史莱姆 canvas（按 rank 索引）
    this.slimesReady = false;   // 全部加载+抠图完成才切到贴图模式
  }

  /* ------------------------------------------------------ 史莱姆素材 */
  // 11 张 PNG（品红底）→ 抠掉品红 → 裁到史莱姆边界 → 存入 slimeImages[rank]
  // 抠图用「到品红(255,0,255)的颜色距离」做阈值，边缘带平滑过渡，不会留毛边
  Renderer.prototype.loadSlimes = function (basePath) {
    var self = this;
    var total = 11;
    var loaded = 0;
    for (var rank = 0; rank < total; rank++) {
      (function (r) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () {
          self.slimeImages[r] = self._keySlime(img);
          loaded++;
          if (loaded === total) self.slimesReady = true;
        };
        img.onerror = function () { loaded++; if (loaded === total) self.slimesReady = true; };
        img.src = basePath + 'slime-' + r + '.jpg';
      })(rank);
    }
  };

  // 贴图长边上限。罐里最大球直径约 110 CSS px，3 倍屏下也只要 330，
  // 源图却有 1000~1650px —— 原尺寸抠图会让 11 张 canvas 常驻 ~76MB，
  // 手机上实测 JS 堆冲到 467MB，低端机会直接崩。
  // 缩到 320 后单张 ~410KB，11 张合计约 4.5MB，观感完全看不出差别。
  var TEX_MAX = 320;

  // 品红抠图 + 自动裁边：返回一个只含史莱姆的 canvas
  // 关键：JPG 压缩后背景不是纯 (255,0,255)，蓝通道会掉到 ~140。
  // 所以先从四角采样实际背景色，再按"到背景色的距离"做阈值抠图。
  Renderer.prototype._keySlime = function (img) {
    var nw = img.naturalWidth, nh = img.naturalHeight;
    var sc = Math.min(1, TEX_MAX / Math.max(nw, nh));
    var w = Math.max(32, Math.round(nw * sc));
    var h = Math.max(32, Math.round(nh * sc));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var cx = cv.getContext('2d');
    // 缩放交给 canvas 的双线性插值，省掉一次全尺寸解码后的像素拷贝
    cx.drawImage(img, 0, 0, nw, nh, 0, 0, w, h);
    var data = cx.getImageData(0, 0, w, h);
    var px = data.data;

    // 1) 从四角各采一小块求平均背景色（块大小按缩放后尺寸取，避免小图越界）
    var sr = 0, sg = 0, sb = 0, sn = 0;
    var blk = Math.max(4, Math.min(24, Math.floor(Math.min(w, h) / 8)));
    var corners = [[0,0],[w-blk,0],[0,h-blk],[w-blk,h-blk]];
    for (var ci = 0; ci < 4; ci++) {
      var cx0 = corners[ci][0], cy0 = corners[ci][1];
      for (var yy = 0; yy < blk; yy++) {
        for (var xx = 0; xx < blk; xx++) {
          var ii = ((cy0 + yy) * w + (cx0 + xx)) * 4;
          sr += px[ii]; sg += px[ii+1]; sb += px[ii+2]; sn++;
        }
      }
    }
    var bgR = sr / sn, bgG = sg / sn, bgB = sb / sn;

    // 2) 按到背景色的距离抠图。
    //    用平方距离比较，省掉逐像素开方 —— 几百 KB 像素上这一项就是几 ms。
    var LO2 = 45 * 45, HI2 = 110 * 110;
    var minX = w, minY = h, maxX = 0, maxY = 0, found = false;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var dr = px[i] - bgR, dg = px[i + 1] - bgG, db = px[i + 2] - bgB;
        var d2 = dr * dr + dg * dg + db * db;
        var a;
        if (d2 < LO2) a = 0;
        else if (d2 > HI2) a = 255;
        else a = Math.round((Math.sqrt(d2) - 45) / 65 * 255);
        px[i + 3] = a;
        if (a > 10) {
          found = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    cx.putImageData(data, 0, 0);
    if (!found) return cv;
    // 裁到史莱姆边界，再留一点余量给柔光边缘（别把果冻的光晕裁掉了）。
    // 余量按缩放比例走 —— 固定 16px 在 320 图上等于 5%，球会显得缩水。
    var pad = Math.max(4, Math.round(16 * sc));
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad);
    maxY = Math.min(h - 1, maxY + pad);
    var cw = maxX - minX + 1, ch = maxY - minY + 1;
    var out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(cv, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  };

  /* ------------------------------------------------------------ 尺寸 */
  Renderer.prototype.resize = function (cssW, cssH, dpr) {
    this.dpr = dpr || (window.devicePixelRatio || 1);
    this.width = cssW;
    this.height = cssH;
    this.canvas.width = Math.round(cssW * this.dpr);
    this.canvas.height = Math.round(cssH * this.dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
  };

  /* --------------------------------------------------------- 粒子 */
  Renderer.prototype.burst = function (x, y, rank, count) {
    var c = Config.colorOfRank(rank);
    var n = count || 12;
    for (var i = 0; i < n; i++) {
      var ang = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      var spd = 2.2 + Math.random() * 3.4;
      this.particles.push({
        x: x, y: y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 1.2,
        r: 2 + Math.random() * 3.2,
        life: 1,
        decay: 0.022 + Math.random() * 0.016,
        color: i % 3 === 0 ? c.light : c.fill
      });
    }
  };

  Renderer.prototype.floatText = function (x, y, text, color) {
    this.floaters.push({
      x: x, y: y, text: text, color: color || '#fff',
      life: 1, decay: 0.014
    });
  };

  Renderer.prototype.ripple = function (x, y, r) {
    this.ripples.push({ x: x, y: y, r: r, life: 1 });
  };

  Renderer.prototype.addShake = function (v) {
    this.shake = Math.min(14, this.shake + v);
  };

  /* --------------------------------------------------------- 更新 */
  Renderer.prototype.update = function (dt) {
    var i;
    for (i = this.particles.length - 1; i >= 0; i--) {
      var p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.16;
      p.vx *= 0.985;
      p.life -= p.decay * (dt / 16.67);
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    for (i = this.floaters.length - 1; i >= 0; i--) {
      var f = this.floaters[i];
      f.y -= 0.85 * (dt / 16.67);
      f.life -= f.decay * (dt / 16.67);
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
    for (i = this.ripples.length - 1; i >= 0; i--) {
      var rp = this.ripples[i];
      rp.r += 2.4 * (dt / 16.67);
      rp.life -= 0.03 * (dt / 16.67);
      if (rp.life <= 0) this.ripples.splice(i, 1);
    }
    this.shake *= 0.88;
    if (this.shake < 0.05) this.shake = 0;
  };

  Renderer.prototype.clearEffects = function () {
    this.particles.length = 0;
    this.floaters.length = 0;
    this.ripples.length = 0;
    this.shake = 0;
  };

  /* --------------------------------------------------------- 绘制 */
  Renderer.prototype.draw = function (state) {
    var ctx = this.ctx;
    var dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    // 屏幕震动
    var sx = 0, sy = 0;
    if (this.shake > 0.05) {
      sx = (Math.random() - 0.5) * this.shake;
      sy = (Math.random() - 0.5) * this.shake;
    }
    ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);

    // 绘制顺序 = 微缩模型的空间顺序，从后往前：
    //   底座托盘 → 罐内（景深 + 背壁）→ 警戒线 → 球 → 前玻璃 → 手上的球 → 特效
    this.drawBase(ctx, state);
    this.drawJarBack(ctx, state);
    this.drawDanger(ctx, state);
    this.drawBalls(ctx, state);
    this.drawJarFront(ctx, state);
    this.drawPreview(ctx, state);
    this.drawParticles(ctx);
    this.drawFloaters(ctx);
  };

  /* ------------------------------------------------- 底座托盘（桌面模型） */
  // 罐子不是"悬在页面里的一块玻璃"，而是摆在一块托盘上的模型。
  // 托盘只比罐子宽一点点，露出厚度侧面 + 顶面高光 + 落在桌面上的柔影。
  // 这一块不做任何花纹 —— 微缩模型的底座都不花。
  Renderer.prototype.drawBase = function (ctx, state) {
    var L = state.layout;
    var pw = L.jarW + 26;
    var px = L.left - 13;
    var ph = 22;
    var py = L.bottom - 6;          // 顶面略微高出罐底：罐子像"嵌"在托盘上
    var cx = px + pw / 2;

    // 托盘在桌面上的落影
    ctx.save();
    var sh = ctx.createRadialGradient(cx, py + ph + 4, 6, cx, py + ph + 4, pw * 0.60);
    sh.addColorStop(0, 'rgba(0, 0, 0, 0.52)');
    sh.addColorStop(0.55, 'rgba(0, 0, 0, 0.22)');
    sh.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.ellipse(cx, py + ph + 3, pw * 0.58, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 托盘体：顶面亮、侧面沉（圆润厚片，不是描边方块）
    // 颜色刻意压得比球暗、比背景浊 —— 底座是"台子"，不是"主角"。
    // 微缩模型的底座一旦比上面的东西还鲜，整张图就没有主次了。
    ctx.save();
    roundRect(ctx, px, py, pw, ph, 10);
    var sg = ctx.createLinearGradient(0, py, 0, py + ph);
    sg.addColorStop(0, 'rgba(104, 78, 148, 0.96)');
    sg.addColorStop(0.40, 'rgba(62, 42, 102, 0.97)');
    sg.addColorStop(1, 'rgba(34, 20, 62, 0.98)');
    ctx.fillStyle = sg;
    ctx.fill();

    // 顶面高光（左上光源）
    ctx.save();
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.clip();
    var tg = ctx.createLinearGradient(0, py, 0, py + 8);
    tg.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
    tg.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = tg;
    ctx.fillRect(px, py, pw, 8);
    ctx.restore();

    // 底缘一线微亮：圆润厚片的下沿反光（只 1px，多了就变描边）
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    roundRect(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, 9.5);
    ctx.stroke();
    ctx.restore();
  };

  /* ------------------------------------------------ 罐内（景深 + 背壁） */
  Renderer.prototype.drawJarBack = function (ctx, state) {
    var L = state.layout;
    var x = L.left, y = L.top, w = L.jarW, h = L.jarH;
    var r = 22;

    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();

    // 罐内底色：上（罐口方向）略亮、下（罐底）更暗 —— 微缩场景里的"远处"
    // 同时这层深色挡住背后的插画纹理，玻璃才不会发灰发脏
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, 'rgba(60, 36, 108, 0.62)');
    g.addColorStop(0.34, 'rgba(34, 19, 62, 0.66)');
    g.addColorStop(1, 'rgba(18, 9, 34, 0.78)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    // 罐顶雾光：光从开口洒进来，在上部形成一层薄雾
    var fog = ctx.createLinearGradient(x, y, x, y + 120);
    fog.addColorStop(0, 'rgba(182, 154, 255, 0.17)');
    fog.addColorStop(1, 'rgba(182, 154, 255, 0)');
    ctx.fillStyle = fog;
    ctx.fillRect(x, y, w, 120);

    // 罐底积影：让最底下那层球"坐实"在玻璃上
    var bot = ctx.createLinearGradient(x, y + h - 74, x, y + h);
    bot.addColorStop(0, 'rgba(6, 2, 16, 0)');
    bot.addColorStop(1, 'rgba(6, 2, 16, 0.40)');
    ctx.fillStyle = bot;
    ctx.fillRect(x, y + h - 74, w, 74);

    ctx.restore();
  };

  /* ------------------------------------------------- 前玻璃（罐身外观） */
  Renderer.prototype.drawJarFront = function (ctx, state) {
    var L = state.layout;
    var x = L.left, y = L.top, w = L.jarW, h = L.jarH;
    var r = 22;

    ctx.save();

    // --- 罐底厚玻璃：一条亮带，"这是玻璃容器"最省力也最准的一笔 ---
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    var base = ctx.createLinearGradient(x, y + h - 28, x, y + h);
    base.addColorStop(0, 'rgba(255, 255, 255, 0)');
    base.addColorStop(0.55, 'rgba(214, 222, 255, 0.18)');
    base.addColorStop(1, 'rgba(255, 255, 255, 0.32)');
    ctx.fillStyle = base;
    ctx.fillRect(x, y + h - 28, w, 28);

    // --- 侧壁反光条：同一光源，左强右弱 ---
    streak(ctx, x + 9, y + 14, 9, h - 30, 'rgba(255, 255, 255, 0.21)');
    streak(ctx, x + w - 21, y + 30, 6, h - 66, 'rgba(255, 255, 255, 0.13)');
    ctx.restore();

    // --- 罐壁轮廓：细亮线，而不是 3px 大白描边 ---
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();

    // --- 罐口卷边：厚玻璃唇。刻意做成圆角厚片，而不是一条平线 ---
    var lipX = x - 9, lipY = y - 7, lipW = w + 18, lipH = 15;
    ctx.save();
    // 唇投在罐口下方的一圈暗，让唇有厚度
    roundRect(ctx, lipX + 1, lipY + 6, lipW - 2, lipH, 7);
    ctx.fillStyle = 'rgba(12, 5, 26, 0.34)';
    ctx.fill();
    // 唇体
    roundRect(ctx, lipX, lipY, lipW, lipH, 7);
    var lg = ctx.createLinearGradient(0, lipY, 0, lipY + lipH);
    lg.addColorStop(0, 'rgba(255, 255, 255, 0.52)');
    lg.addColorStop(0.45, 'rgba(226, 232, 255, 0.30)');
    lg.addColorStop(1, 'rgba(178, 186, 240, 0.36)');
    ctx.fillStyle = lg;
    ctx.fill();
    // 开口内侧暗线
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(10, 4, 22, 0.40)';
    roundRect(ctx, lipX + 2, lipY + 2, lipW - 4, lipH - 3, 5);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  };

  /* -------------------------------------------------------- 警戒线 */
  Renderer.prototype.drawDanger = function (ctx, state) {
    var L = state.layout;
    var dy = L.dangerY;
    if (!dy) return;
    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,120,140,0.55)';
    ctx.beginPath();
    ctx.moveTo(L.left, dy);
    ctx.lineTo(L.right, dy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '700 11.5px ' + NUM_FONT;
    ctx.fillStyle = 'rgba(255,140,160,0.78)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('警戒线', L.left + 6, dy - 3);
    ctx.restore();
  };

  /* ---------------------------------------------------------- 球体 */
  Renderer.prototype.drawBalls = function (ctx, state) {
    var balls = state.balls;
    for (var i = 0; i < balls.length; i++) {
      this.drawBall(ctx, balls[i], state.now, state);
    }
  };

  Renderer.prototype.drawBall = function (ctx, ball, now, state) {
    var body = ball.body;
    var pos = body.position;
    var r = ball.r;
    var c = Config.colorOfRank(ball.rank);

    // ---- 形变 ----
    // squash 是弹簧形变量：>0 表示被压扁，<0 表示被拉伸（回弹过冲）
    var sq = body.plugin.squash || 0;

    // 环境呼吸：静止的球也在双频微微膨胀/收缩，球堆因此始终「活着」
    // 这是史莱姆与石头的最大区别 —— 石头不动，史莱姆一直在喘
    if ((body.speed || 0) < J.IDLE_SPEED) {
      var ph = ball.id * 1.73;
      sq += Math.sin(now * J.IDLE_FREQ + ph) * J.IDLE_AMP
          + Math.sin(now * J.IDLE_FREQ2 + ph * 2.31) * J.IDLE_AMP * 0.42;
    }

    var vy = body.velocity.y;
    var drop = Math.max(0, Math.min(J.STRETCH_MAX, vy * J.STRETCH_VY));

    // 压扁：纵向压缩、横向外扩（体积感：压下去要往两边鼓）
    // 拉伸：纵向拉长、横向略微收窄
    var sx = 1 + sq * J.BULGE;
    var sy = 1 - sq * (sq > 0 ? J.FLATTEN : J.TALLEN);
    // 下落时纵向拉伸（速度越快越"长条"）
    sy *= 1 + drop;
    sx *= 1 - drop * 0.35;
    // 硬约束：任何方向都不超出碰撞半径的 CAP 倍
    var cap = J.CAP;
    if (sx > cap) sx = cap;
    if (sy > cap) sy = cap;

    // 「余能」：碰撞后残留的形变 + 形变速度，驱动轮廓抖动
    // 史莱姆的「软」有一大半在"撞完还在抖"这一下 —— 静止只是慢慢喘
    var energy = Math.min(1,
      Math.abs(body.plugin.squash || 0) * 1.7 +
      Math.abs(body.plugin.squashV || 0) * 0.035);

    // 合并动画：1.35 → 0.92 → 1.0
    var anim = 1;
    if (ball.isNew && ball.animAt) {
      var t = (now - ball.animAt) / MERGE_ANIM_MS;
      if (t >= 1) { ball.isNew = false; }
      else if (t < 0.42) {
        anim = 1 + 0.35 * (t / 0.42);
      } else {
        var u = (t - 0.42) / 0.58;
        anim = 0.92 + 0.08 * u + Math.sin(u * Math.PI) * 0.10;
      }
    }
    sx *= anim;
    sy *= anim;

    ctx.save();
    ctx.translate(pos.x, pos.y);

    // ---- 接触阴影（微缩模型最有效的那一笔）----
    // 静止的球 → 深而紧的接触暗；飞行中的球 → 淡而散的投影。
    // 不参与形变，始终保持一个柔和的椭圆（所以不用 ctx.scale(sx,sy)）。
    var spd = body.speed || 0;
    var grounded = Math.max(0, Math.min(1, 1 - spd / 2.6));
    if (ball.supported) grounded = Math.max(grounded, 0.85);
    var lift = 1 - grounded;                       // 1 = 完全离地
    ctx.save();
    ctx.globalAlpha = 0.13 + grounded * 0.30;
    ctx.translate(r * 0.10, r * (0.34 + lift * 0.24));
    ctx.scale(1, 0.34 + lift * 0.18);              // 压扁成椭圆
    var rr = r * (0.78 + lift * 0.34);             // 离得越远，影子越大越散
    var shg = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
    shg.addColorStop(0, 'rgba(16, 5, 34, 0.92)');
    shg.addColorStop(0.55, 'rgba(16, 5, 34, 0.42)');
    shg.addColorStop(1, 'rgba(16, 5, 34, 0)');
    ctx.fillStyle = shg;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 压扁时把球体整体下移，保证「底边」仍停在原处（贴地 / 贴住下方球），不浮空
    // 视觉底边 = pos.y + r*sy + shift，令其等于物理底边 pos.y + r ⇒ shift = r*(1-sy)
    if (sy < 1) ctx.translate(0, r * (1 - sy));

    ctx.scale(sx, sy);

    // ---- 史莱姆贴图 ----
    // 素材已抠好品红底、裁到边界。直接 drawImage，squash&stretch 会让它跟着形变。
    // 画得比碰撞半径大 30% —— 史莱姆的软轮廓和柔光边要溢出碰撞圆，
    // 这样球堆挤在一起时才不会露出明显缝隙。
    var slimeImg = this.slimesReady ? this.slimeImages[ball.rank] : null;
    if (slimeImg) {
      var sz = r * 2 * 1.30;
      ctx.drawImage(slimeImg, -sz / 2, -sz / 2, sz, sz);
    } else {
      // ---- 回退：素材没加载完时用过程绘制 ----
      var g = ctx.createRadialGradient(-r * 0.34, -r * 0.38, r * 0.12, 0, 0, r * 1.06);
      g.addColorStop(0, c.light);
      g.addColorStop(0.42, c.fill);
      g.addColorStop(1, c.deep);
      blobPath(ctx, r, ball.id, energy, now);
      ctx.fillStyle = g;
      ctx.fill();

      // 底部反光
      var g2 = ctx.createRadialGradient(0, r * 0.42, r * 0.05, 0, r * 0.4, r * 0.72);
      g2.addColorStop(0, 'rgba(255,255,255,0.44)');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(0, r * 0.38, r * 0.68, 0, Math.PI * 2);
      ctx.fillStyle = g2;
      ctx.fill();

      // 顶部高光
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.beginPath();
      ctx.ellipse(-r * 0.3, -r * 0.44, r * 0.3, r * 0.19, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 描边
      ctx.lineWidth = Math.max(1.4, r * 0.055);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      blobPath(ctx, r - ctx.lineWidth / 2, ball.id, energy, now);
      ctx.stroke();

      drawFace(ctx, r, ball.id, ball.rank, now);
      if (ball.rank >= Config.TOP_RANK) drawCrown(ctx, r, now);
    }

    ctx.restore();
  };

  /* -------------------------------------------------------- 投放预览 */
  Renderer.prototype.drawPreview = function (ctx, state) {
    if (!state.preview) return;
    var L = state.layout;
    var r = Config.radiusOfRank(state.preview.rank);
    var x = state.preview.x;
    var y = L.spawnY;
    var c = Config.colorOfRank(state.preview.rank);

    ctx.save();
    // 引导线
    ctx.setLineDash([4, 8]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(x, y + r);
    ctx.lineTo(x, L.bottom - 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 半透明球（用贴图或回退过程绘制）
    var previewImg = this.slimesReady ? this.slimeImages[state.preview.rank] : null;
    ctx.globalAlpha = 0.52;
    if (previewImg) {
      var pz = r * 2 * 1.30;
      ctx.drawImage(previewImg, x - pz / 2, y - pz / 2, pz, pz);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      var g = ctx.createRadialGradient(x - r * 0.34, y - r * 0.38, r * 0.12, x, y, r * 1.06);
      g.addColorStop(0, c.light);
      g.addColorStop(0.42, c.fill);
      g.addColorStop(1, c.deep);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.stroke();

      ctx.save();
      ctx.globalAlpha = 0.62;
      ctx.translate(x, y);
      drawFace(ctx, r, state.preview.rank * 31 + 7, state.preview.rank, state.now || 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* ---------------------------------------------------------- 粒子 */
  Renderer.prototype.drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (0.4 + p.life * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    for (var j = 0; j < this.ripples.length; j++) {
      var rp = this.ripples[j];
      ctx.save();
      ctx.globalAlpha = Math.max(0, rp.life) * 0.45;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  };

  /* -------------------------------------------------------- 浮字 */
  Renderer.prototype.drawFloaters = function (ctx) {
    for (var i = 0; i < this.floaters.length; i++) {
      var f = this.floaters[i];
      ctx.save();
      ctx.globalAlpha = Math.max(0, f.life);
      ctx.font = '800 18px ' + NUM_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(40,20,70,0.45)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  };

  /* ------------------------------------------------------- 辅助 */

  /* 「史莱姆」有机轮廓：把圆换成一条会呼吸的闭合曲线
   *  - 三层谐波叠加；相位用 id × 黄金角错开，避免整堆球同频齐动（那样像机器不像生物）
   *  - 振幅 = 基础呼吸 + 撞击余能：静止时慢慢喘，撞完抖一阵才停
   *  - 顶点用中点二次曲线连成平滑闭合路径（不用算贝塞尔控制点）
   * 物理仍是 matter.js 刚体圆，只是「画」成软的 —— 合并/堆叠/判负逻辑完全不受影响
   */
  /* ------------------------------------------------------ 史莱姆的脸 */
  // 参考图里的脸极简：两个小黑点眼 + 一条小嘴 + 两团腮红。
  // 之前那版大白眼仁太"动漫"了，跟软糖质感的身体不搭。改回圆点眼，
  // 才像参考图里那种"呆呆的、想戳一下"的感觉。
  var EYE_Y = -0.16;      // 眼睛中心纵向位置（× r）
  var EYE_DX = 0.22;      // 两眼横向间距（× r，单边）
  var EYE_R = 0.085;      // 眼睛半径（× r）—— 小黑点
  var EYE_MIN = 1.8;      // 最小半径（px）
  var MOUTH_Y = 0.06;     // 嘴纵向位置
  var BLUSH_DX = 0.38;    // 腮红横向位置
  var BLUSH_Y = 0.02;     // 腮红纵向位置

  // 带腮红的等级：暖色/粉色系（参考图里这几颗腮红最明显）
  var BLUSH_RANKS = { 4: true, 5: true, 8: true, 9: true };

  // 调用前请先把 ctx 平移到球心
  function drawFace(ctx, r, id, rank, now) {
    var eyeR = Math.max(EYE_MIN, r * EYE_R);
    var ey = r * EYE_Y;
    var ex = r * EYE_DX;

    // 眨眼：每颗球用自己的周期和相位。整罐球一起眨会很假，像集体眨眼的玩偶。
    var period = 2300 + (id % 9) * 470;
    var tt = (now + id * 947) % period;
    var blink = tt < 160 ? Math.sin((tt / 160) * Math.PI) : 0;
    var sy = 1 - blink * 0.93;      // 闭眼 = 压成一条缝
    if (sy < 0.07) sy = 0.07;

    // 腮红（先画，压在眼睛下面）
    if (BLUSH_RANKS[rank]) {
      var br = Math.max(1.5, r * 0.11);
      ctx.fillStyle = 'rgba(255, 120, 150, 0.45)';
      for (var s = -1; s <= 1; s += 2) {
        ctx.beginPath();
        ctx.arc(s * r * BLUSH_DX, r * BLUSH_Y, br, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 眼睛：两个小黑点 + 左上一点高光（跟全场景光源同方向）
    ctx.fillStyle = '#2a1740';
    for (var s2 = -1; s2 <= 1; s2 += 2) {
      ctx.save();
      ctx.translate(s2 * ex, ey);
      ctx.scale(1, sy);
      ctx.beginPath();
      ctx.arc(0, 0, eyeR, 0, Math.PI * 2);
      ctx.fill();
      if (blink < 0.5) {
        ctx.beginPath();
        ctx.arc(-eyeR * 0.30, -eyeR * 0.30, Math.max(0.5, eyeR * 0.34), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fill();
        ctx.fillStyle = '#2a1740';
      }
      ctx.restore();
    }

    // 嘴：一条小弧线
    ctx.strokeStyle = '#2a1740';
    ctx.lineWidth = Math.max(1, r * 0.038);
    ctx.lineCap = 'round';
    ctx.beginPath();
    var my = r * MOUTH_Y;
    var mw = r * 0.13;
    ctx.arc(0, my - r * 0.02, mw, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  }

  /* -------------------------------------------------- 史莱姆之王的王冠 */
  // 只有 1024（rank 10）戴。它跟着球一起形变 —— 软体顶着一顶跟着晃的王冠，
  // 比硬生生钉在头上更配这个游戏。
  function drawCrown(ctx, r, now) {
    var w = r * 0.92;            // 王冠底宽
    var h = r * 0.54;            // 王冠总高
    var hw = w / 2;
    var baseY = h * 0.66;        // 底座下沿
    var topY = -h * 0.5;         // 中尖的高度

    ctx.save();
    // 坐在球头顶，并轻微上下浮动（王冠也得是活的）
    ctx.translate(0, -r * 0.86 + Math.sin(now * 0.0022) * r * 0.024);

    // 光晕：让它一眼就比别的球「贵重」
    var glow = ctx.createRadialGradient(0, h * 0.3, 0, 0, h * 0.3, w * 0.95);
    glow.addColorStop(0, 'rgba(255, 214, 90, 0.40)');
    glow.addColorStop(1, 'rgba(255, 214, 90, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, h * 0.3, w * 0.95, 0, Math.PI * 2);
    ctx.fill();

    // 冠体：左右各一个尖 + 中间最高那个尖
    ctx.beginPath();
    ctx.moveTo(-hw, baseY);
    ctx.lineTo(-hw, h * 0.06);
    ctx.lineTo(-hw * 0.5, h * 0.34);     // 左凹口
    ctx.lineTo(0, topY);                 // 中尖
    ctx.lineTo(hw * 0.5, h * 0.34);      // 右凹口
    ctx.lineTo(hw, h * 0.06);
    ctx.lineTo(hw, baseY);
    ctx.closePath();

    var cg = ctx.createLinearGradient(0, topY, 0, baseY);
    cg.addColorStop(0, '#fff3b0');
    cg.addColorStop(0.42, '#ffd24a');
    cg.addColorStop(1, '#dd9610');
    ctx.fillStyle = cg;
    ctx.fill();

    // 深色描边：1024 球自己就是金色的，王冠也是金色的 —— 不给一圈暗边，
    // 王冠坐在球顶上那一段会直接糊进背景里，远看就是"球顶上多了一块黄"。
    ctx.lineWidth = Math.max(1, r * 0.045);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(120, 66, 6, 0.72)';
    ctx.stroke();

    // 左上光源的高光（和全场景同一个方向）
    ctx.save();
    ctx.clip();
    var hl = ctx.createLinearGradient(-hw, topY, hw * 0.35, baseY);
    hl.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    hl.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = hl;
    ctx.fillRect(-hw, topY, w, h);
    ctx.restore();

    // 底座压边
    ctx.fillStyle = 'rgba(206, 126, 8, 0.85)';
    ctx.fillRect(-hw, baseY - h * 0.15, w, h * 0.15);

    // 三颗宝石
    var gx = [-hw * 0.9, 0, hw * 0.9];
    var gy = [h * 0.08, topY + h * 0.13, h * 0.08];
    var gr = Math.max(1.5, r * 0.075);
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(gx[i], gy[i], gr, 0, Math.PI * 2);
      ctx.fillStyle = i === 1 ? '#ff5f8f' : '#7fd4ff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(gx[i] - gr * 0.3, gy[i] - gr * 0.3, Math.max(0.6, gr * 0.36), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fill();
    }

    ctx.restore();
  }

  var BLOB_N = 22;
  function blobPath(ctx, r, seed, energy, now) {
    var ph = (seed || 0) * 2.399;                        // 黄金角
    // 起伏幅度随「手感」走：调到软糯时边缘抖得更明显，撞完那一下还在颤
    var amp = J.BLOB_BASE + Math.min(J.BLOB_ENERGY, (energy || 0) * J.BLOB_ENERGY);
    var pts = [];
    for (var i = 0; i < BLOB_N; i++) {
      var a = (i / BLOB_N) * Math.PI * 2;
      var w = Math.sin(2 * a + ph + now * 0.0031) * 0.55
            + Math.sin(3 * a - ph * 1.7 + now * 0.0047) * 0.32
            + Math.sin(5 * a + ph * 2.3 + now * 0.0061) * 0.19;
      // 偏置：起伏主要「向内」，避免球戳穿罐壁、也避免和邻居撞出硬边
      var rad = r * (1 + w * amp - amp * 0.35);
      pts.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad });
    }
    ctx.beginPath();
    var m0x = (pts[0].x + pts[1].x) / 2, m0y = (pts[0].y + pts[1].y) / 2;
    ctx.moveTo(m0x, m0y);
    for (var j = 1; j <= BLOB_N; j++) {
      var p = pts[j % BLOB_N];
      var q = pts[(j + 1) % BLOB_N];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
    }
    ctx.closePath();
  }

  /* 玻璃侧壁反光条：两端渐隐的胶囊形高光。
   * 刻意做成静态 —— 玻璃反光是"材质"，不是"特效"，
   * 让它自己在那儿慢慢闪会让整个画面显得躁。*/
  function streak(ctx, x, y, w, h, color) {
    var g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, 'rgba(255, 255, 255, 0)');
    g.addColorStop(0.20, color);
    g.addColorStop(0.74, color);
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.save();
    ctx.fillStyle = g;
    roundRect(ctx, x, y, w, h, w / 2);
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  return { Renderer: Renderer, MERGE_ANIM_MS: MERGE_ANIM_MS };
});

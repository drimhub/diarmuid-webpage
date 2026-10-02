(function () {
  var meadow = document.getElementById('meadow');
  var emojiBar = document.getElementById('emojis');
  var NS = 'http://www.w3.org/2000/svg';
  var SIZE = { w: 60, h: 66 };

  var SAYINGS = [
    "I'm a young bull! 🐂",
    "I'm a feral hog! 🐗",
    'We love you Lucy! 💖',
    'Reading is fun! 📚'
  ];

  // Pixel-art sprites: each character is a colour from the palette, '.' is empty.
  var SPRITES = {
    bull: {
      palette: { B: '#a0522d', H: '#fff3c4', K: '#222222', P: '#ffb6c1' },
      rows: [
        'H..........H',
        'HH........HH',
        '.HBBBBBBBBH.',
        '..BBBBBBBB..',
        '..BKBBBBKB..',
        '..BBBBBBBB..',
        '..BPPPPPPB..',
        '..PPKPPKPP..',
        '..PPPPPPPP..',
        '..BBBBBBBB..',
        '..BB....BB..'
      ]
    },
    hog: {
      palette: { H: '#ffa8c5', E: '#ff7fa8', S: '#ff8fb0', K: '#222222', W: '#ffffff' },
      rows: [
        '.EE......EE.',
        '.EEE....EEE.',
        '..HHHHHHHH..',
        '.HHHHHHHHHH.',
        '.HHKHHHHKHH.',
        '.HHHHHHHHHH.',
        '.HHSSSSSSHH.',
        '.HHSKSSKSHH.',
        '..WHSSSSHW..',
        '..HHHHHHHH..',
        '..HH....HH..'
      ]
    }
  };

  function sprite(kind) {
    var def = SPRITES[kind];
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 12 11');
    svg.setAttribute('shape-rendering', 'crispEdges');
    def.rows.forEach(function (row, y) {
      for (var x = 0; x < row.length; x++) {
        var colour = def.palette[row[x]];
        if (!colour) continue;
        var r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x);
        r.setAttribute('y', y);
        r.setAttribute('width', 1);
        r.setAttribute('height', 1);
        r.setAttribute('fill', colour);
        svg.appendChild(r);
      }
    });
    return svg;
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function burst(x, y, chars, n) {
    for (var i = 0; i < n; i++) {
      var s = document.createElement('span');
      s.className = 'float';
      s.textContent = chars[Math.floor(Math.random() * chars.length)];
      s.style.left = (x + rand(-24, 24)) + 'px';
      s.style.top = (y + rand(-12, 12)) + 'px';
      meadow.appendChild(s);
      setTimeout(function (el) { el.remove(); }, 1500, s);
    }
  }

  var animals = [];
  ['bull', 'bull', 'hog', 'hog', 'bull', 'hog'].forEach(function (kind) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'animal';
    el.setAttribute('aria-label', kind === 'bull' ? 'Young bull' : 'Feral hog');
    el.appendChild(sprite(kind));
    meadow.appendChild(el);
    var a = {
      el: el, kind: kind,
      x: rand(0, meadow.clientWidth - SIZE.w),
      y: rand(meadow.clientHeight * 0.35, meadow.clientHeight - SIZE.h),
      vx: rand(-40, 40) || 20, vy: rand(-20, 20),
      bubble: null, nextSay: rand(1, 5), cool: 0
    };
    el.addEventListener('click', function () {
      el.classList.remove('hop');
      void el.offsetWidth;
      el.classList.add('hop');
      burst(a.x + SIZE.w / 2, a.y, ['✨', '⭐', '💖', '🌟'], 6);
    });
    animals.push(a);
  });

  function say(a) {
    if (a.bubble) a.bubble.remove();
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = SAYINGS[Math.floor(Math.random() * SAYINGS.length)];
    a.el.appendChild(b);
    a.bubble = b;
    setTimeout(function () {
      b.remove();
      if (a.bubble === b) a.bubble = null;
    }, 2500);
  }

  var last = performance.now();
  function tick(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    var W = meadow.clientWidth - SIZE.w, H = meadow.clientHeight - SIZE.h;
    var top = meadow.clientHeight * 0.3;

    animals.forEach(function (a) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      if (a.x < 0 || a.x > W) { a.vx = -a.vx; a.x = Math.max(0, Math.min(W, a.x)); }
      if (a.y < top || a.y > H) { a.vy = -a.vy; a.y = Math.max(top, Math.min(H, a.y)); }
      if (Math.random() < dt * 0.4) { a.vx += rand(-15, 15); a.vy += rand(-10, 10); }
      a.vx = Math.max(-50, Math.min(50, a.vx));
      a.vy = Math.max(-25, Math.min(25, a.vy));
      a.cool -= dt;
      a.nextSay -= dt;
      if (a.nextSay <= 0) { say(a); a.nextSay = rand(5, 10); }
      a.el.style.transform = 'translate(' + a.x + 'px,' + a.y + 'px)';
      a.el.style.zIndex = Math.round(a.y);
    });

    // Friendly meetings: animals bounce gently apart and trade hearts.
    for (var i = 0; i < animals.length; i++) {
      for (var j = i + 1; j < animals.length; j++) {
        var p = animals[i], q = animals[j];
        if (p.cool > 0 || q.cool > 0) continue;
        if (Math.abs(p.x - q.x) < 40 && Math.abs(p.y - q.y) < 40) {
          var t = p.vx;
          p.vx = -q.vx || 20;
          q.vx = -t || -20;
          p.cool = q.cool = 1.5;
          burst((p.x + q.x) / 2 + SIZE.w / 2, (p.y + q.y) / 2, ['💕', '💖'], 3);
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  ['💖', '✨', '🌸', '🐂', '🐗', '📚', '🌈'].forEach(function (emoji) {
    var count = 0;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Send ' + emoji);
    var face = document.createElement('span');
    face.textContent = emoji;
    var num = document.createElement('b');
    num.textContent = '0';
    btn.appendChild(face);
    btn.appendChild(num);
    btn.addEventListener('click', function () {
      count++;
      num.textContent = count;
      burst(rand(40, meadow.clientWidth - 40), meadow.clientHeight - 40, [emoji], 4);
    });
    emojiBar.appendChild(btn);
  });
})();

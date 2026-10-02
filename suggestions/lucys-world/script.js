(function () {
  var meadow = document.getElementById('meadow');
  var SPARKLES = ['✨', '💖', '⭐', '🌟', '💫'];
  var EMOJIS = ['💖', '✨', '🌈', '🥰', '🎉', '🌸', '🍓', '🐂', '🐗'];

  // Pixel-art sprites (16x9, facing right). Letters map to colours in the palettes.
  var BULL = [
    '...........w..w.',
    '..bbbbbb...wbbw.',
    '.bbbbbbbbbbbbbb.',
    '.bbbbbbbbbbbbeb.',
    'tbbbbbbbbbbbbbpp',
    '.bbbbbbbbbbbbbpp',
    '..bbbbbbbbbbbb..',
    '..bb.bb..bb.bb..',
    '..dd.dd..dd.dd..'
  ];
  var HOG = [
    '..............k.',
    '.............kpk',
    '..hhhhhhhhhhhhh.',
    '.hhhhhhhhhhhhheh',
    'thhhhhhhhhhhhhss',
    '.hhhhhhhhhhhhhss',
    '..hhhhhhhhhhhw..',
    '..hh.hh..hh.hh..',
    '..kk.kk..kk.kk..'
  ];
  var PALETTES = {
    bull: [
      { b: '#a0683c', d: '#5b3a1e', w: '#fff4d6', e: '#2b1b12', p: '#ffb3c7', t: '#5b3a1e' },
      { b: '#f4efe6', d: '#a89c8a', w: '#ffe08a', e: '#2b1b12', p: '#ffb3c7', t: '#a89c8a' },
      { b: '#c9a0ff', d: '#7c52b8', w: '#fff4d6', e: '#2b1b12', p: '#ffb3c7', t: '#7c52b8' }
    ],
    hog: [
      { h: '#7b5a48', k: '#3d2a20', p: '#e8909c', e: '#111111', s: '#e8909c', w: '#fffbe8', t: '#3d2a20' },
      { h: '#ff9ccf', k: '#c2538f', p: '#ffd0e6', e: '#111111', s: '#ffd0e6', w: '#fffbe8', t: '#c2538f' }
    ]
  };

  function spriteSvg(grid, pal) {
    var rects = '';
    grid.forEach(function (row, y) {
      for (var x = 0; x < row.length; x++) {
        var c = pal[row[x]];
        if (c) rects += '<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + c + '"/>';
      }
    });
    return '<svg viewBox="0 0 16 9" xmlns="http://www.w3.org/2000/svg">' + rects + '</svg>';
  }

  var animals = [];
  function spawn(kind, i, small) {
    var pals = PALETTES[kind];
    var el = document.createElement('div');
    el.className = 'animal' + (small ? ' small' : '');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', (small ? 'young ' : '') + (kind === 'bull' ? 'bull' : 'feral hog'));
    el.innerHTML = spriteSvg(kind === 'bull' ? BULL : HOG, pals[i % pals.length]);
    meadow.appendChild(el);
    var a = {
      el: el,
      x: Math.random() * (meadow.clientWidth - 70),
      y: meadow.clientHeight * 0.5 + Math.random() * (meadow.clientHeight * 0.38 - 40),
      vx: (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.4),
      vy: 0
    };
    el.addEventListener('click', function () { hop(a); });
    animals.push(a);
  }
  [0, 1, 2].forEach(function (i) { spawn('bull', i, i > 0); });
  [0, 1, 0, 1].forEach(function (i, n) { spawn('hog', i, n > 1); });

  function burst(x, y, list, n) {
    for (var i = 0; i < n; i++) {
      var s = document.createElement('span');
      s.className = 'fx';
      s.textContent = list[Math.floor(Math.random() * list.length)];
      s.style.left = (x + Math.random() * 50 - 10) + 'px';
      s.style.top = (y + Math.random() * 30 - 20) + 'px';
      s.style.animationDelay = (i * 0.08) + 's';
      meadow.appendChild(s);
      setTimeout(function (e) { e.remove(); }, 2200, s);
    }
  }

  function hop(a) {
    a.el.classList.remove('hop');
    void a.el.offsetWidth;
    a.el.classList.add('hop');
    burst(a.x, a.y - 10, SPARKLES, 4);
  }

  var t = 0;
  function tick() {
    t++;
    var W = meadow.clientWidth, minY = meadow.clientHeight * 0.5, maxY = meadow.clientHeight - 50;
    animals.forEach(function (a) {
      var w = a.el.offsetWidth;
      a.x += a.vx;
      if (a.x < 0 || a.x > W - w) { a.vx = -a.vx; a.x = Math.max(0, Math.min(W - w, a.x)); }
      if (t % 120 === 0 && Math.random() < 0.3) a.vy = (Math.random() - 0.5) * 0.3;
      a.y = Math.max(minY, Math.min(maxY, a.y + a.vy));
      a.el.classList.toggle('flip', a.vx < 0);
      a.el.style.left = a.x + 'px';
      a.el.style.top = a.y + 'px';
      a.el.style.zIndex = Math.round(a.y);
    });
    // friends who bump into each other share a little love
    if (t % 90 === 0) {
      for (var i = 0; i < animals.length; i++) {
        for (var j = i + 1; j < animals.length; j++) {
          var p = animals[i], q = animals[j];
          if (Math.abs(p.x - q.x) < 50 && Math.abs(p.y - q.y) < 30) burst(p.x, p.y - 10, ['💕', '✨'], 2);
        }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Emoji bar (counts last only while the page is open)
  var bar = document.getElementById('emojis');
  EMOJIS.forEach(function (e) {
    var b = document.createElement('button');
    var small = document.createElement('small');
    var count = 0;
    b.type = 'button';
    b.appendChild(document.createTextNode(e));
    b.appendChild(small);
    b.addEventListener('click', function () {
      count++;
      small.textContent = count;
      burst(Math.random() * (meadow.clientWidth - 40), meadow.clientHeight * 0.6, [e, '✨'], 5);
    });
    bar.appendChild(b);
  });

  // Comments: shown as a speech bubble and added to the feed. Text goes in via textContent.
  var feed = document.getElementById('feed');
  document.getElementById('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var msg = document.getElementById('msg'), name = document.getElementById('name');
    var text = msg.value.trim();
    if (!text) return;
    var li = document.createElement('li');
    var b = document.createElement('b');
    b.textContent = (name.value.trim() || 'a friend') + ' ';
    li.appendChild(b);
    li.appendChild(document.createTextNode('✨ ' + text));
    feed.insertBefore(li, feed.firstChild);
    var a = animals[Math.floor(Math.random() * animals.length)];
    var bub = document.createElement('div');
    bub.className = 'bubble';
    bub.textContent = text;
    bub.style.left = Math.max(0, Math.min(meadow.clientWidth - 150, a.x - 20)) + 'px';
    bub.style.top = Math.max(0, a.y - 40) + 'px';
    meadow.appendChild(bub);
    setTimeout(function () { bub.remove(); }, 4200);
    hop(a);
    msg.value = '';
  });
})();

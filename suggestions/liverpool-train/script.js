(function () {
  var train = document.getElementById('train');
  var empty = document.getElementById('empty');
  var cianFace = document.getElementById('cian-face');
  var smoke = document.getElementById('smoke');
  var words = document.getElementById('words');
  var urls = [];
  var cianUrl = null;
  var sounds = ['Choo choo!', 'Chugga chugga!', 'Toot toot!', 'Chuff chuff!'];

  function addCarriage(file) {
    var url = URL.createObjectURL(file);
    urls.push(url);
    empty.hidden = true;
    var car = document.createElement('div');
    car.className = 'carriage';
    var win = document.createElement('div');
    win.className = 'window';
    var img = document.createElement('img');
    img.src = url;
    img.alt = 'Photo from stop ' + (train.querySelectorAll('.carriage').length + 1);
    win.appendChild(img);
    var name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 40;
    name.placeholder = 'Name this stop';
    name.setAttribute('aria-label', 'Stop name');
    car.appendChild(win);
    car.appendChild(name);
    train.appendChild(car);
  }

  document.getElementById('photo-files').addEventListener('change', function (e) {
    Array.prototype.forEach.call(e.target.files, addCarriage);
    e.target.value = '';
  });

  document.getElementById('cian-file').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) { return; }
    if (cianUrl) { URL.revokeObjectURL(cianUrl); }
    cianUrl = URL.createObjectURL(f);
    var img = document.createElement('img');
    img.src = cianUrl;
    img.alt = 'Cian as the conductor';
    cianFace.textContent = '';
    cianFace.appendChild(img);
    e.target.value = '';
  });

  document.getElementById('reset').addEventListener('click', function () {
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
    if (cianUrl) { URL.revokeObjectURL(cianUrl); cianUrl = null; }
    train.querySelectorAll('.carriage').forEach(function (c) { c.remove(); });
    empty.hidden = false;
    cianFace.textContent = '';
    var s = document.createElement('span');
    s.textContent = '🙂';
    cianFace.appendChild(s);
  });

  function puff() {
    var p = document.createElement('div');
    p.className = 'puff';
    p.style.left = (30 + Math.random() * 20) + '%';
    p.style.setProperty('--dx', (Math.random() * 80 - 10) + 'px');
    smoke.appendChild(p);
    setTimeout(function () { p.remove(); }, 3000);
  }

  function say() {
    var w = document.createElement('span');
    w.className = 'word';
    w.textContent = sounds[Math.floor(Math.random() * sounds.length)];
    w.style.left = (10 + Math.random() * 70) + '%';
    words.appendChild(w);
    setTimeout(function () { w.remove(); }, 2400);
  }

  setInterval(puff, 500);
  setInterval(say, 1800);
  document.getElementById('toot').addEventListener('click', function () {
    for (var i = 0; i < 6; i++) { setTimeout(puff, i * 120); }
    say();
  });
})();

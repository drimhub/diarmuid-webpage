(function () {
  var sky = document.getElementById('sky');
  var kiss = document.getElementById('kiss');
  var countEl = document.getElementById('count');
  var input = document.getElementById('photos');
  var clearBtn = document.getElementById('clear');
  var count = 0;
  var photos = []; // object URLs made from files the visitor picks

  var DRIM_SVG = '<svg viewBox="0 0 100 100" aria-label="drim">' +
    '<circle cx="50" cy="50" r="48" fill="#ffd9a8" stroke="#b03a7a" stroke-width="4"/>' +
    '<circle cx="35" cy="42" r="5" fill="#333"/><circle cx="65" cy="42" r="5" fill="#333"/>' +
    '<path d="M32 62 Q50 80 68 62" fill="none" stroke="#333" stroke-width="5" stroke-linecap="round"/>' +
    '<text x="50" y="22" font-size="16" text-anchor="middle" fill="#b03a7a">drim</text></svg>';

  function makeItem() {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'item';
    var drim = Math.random() < 0.4;
    if (drim && photos.length) {
      var img = document.createElement('img');
      img.src = photos[Math.floor(Math.random() * photos.length)];
      img.alt = 'drim';
      el.appendChild(img);
    } else if (drim) {
      el.innerHTML = DRIM_SVG;
    } else {
      el.textContent = Math.random() < 0.5 ? '🐰' : '🐇';
    }
    el.setAttribute('aria-label', drim ? 'Kiss drim' : 'Kiss bunny');
    el.style.setProperty('--h', sky.clientHeight + 'px');
    el.style.setProperty('--r', Math.round(Math.random() * 360 - 180) + 'deg');
    el.style.left = Math.random() * (sky.clientWidth - 56) + 'px';
    el.style.animationDuration = (4 + Math.random() * 4) + 's';
    el.addEventListener('animationend', function () { el.remove(); });
    el.addEventListener('click', function () { giveKiss(el); });
    sky.appendChild(el);
  }

  function giveKiss(el) {
    if (el.classList.contains('kissed')) return;
    var y = el.getBoundingClientRect().top - sky.getBoundingClientRect().top;
    el.style.top = y + 'px';
    el.classList.add('kissed');
    // next frame: fly to Jennifer
    requestAnimationFrame(function () {
      el.style.left = (sky.clientWidth / 2 - 28) + 'px';
      el.style.top = (sky.clientHeight - 80) + 'px';
    });
    setTimeout(function () { el.remove(); }, 450);
    kiss.textContent = '💋';
    kiss.classList.remove('show');
    void kiss.offsetWidth;
    kiss.classList.add('show');
    count++;
    countEl.textContent = count;
  }

  input.addEventListener('change', function () {
    Array.prototype.forEach.call(input.files, function (f) {
      if (/^image\//.test(f.type)) photos.push(URL.createObjectURL(f));
    });
    clearBtn.hidden = !photos.length;
    input.value = '';
  });
  clearBtn.addEventListener('click', function () {
    photos.forEach(function (u) { URL.revokeObjectURL(u); });
    photos = [];
    clearBtn.hidden = true;
  });

  setInterval(function () { if (!document.hidden) makeItem(); }, 700);
  for (var i = 0; i < 4; i++) setTimeout(makeItem, i * 250);
})();

// Settings panel — theme + the three font slots, persisted to localStorage.
// Owns everything that used to be the titlebar theme toggle.
var Settings = (function() {
  var root = document.documentElement;

  var CSS_FAMILY = { ui: '--font-body', editor: '--font-mono', reading: '--font-reading' };

  // ui writes --ui-scale (size / def), the other two write a px var directly.
  var SIZES = {
    ui:      { list: [10, 11, 12, 13, 14, 15, 16], def: 12 },
    editor:  { list: [11, 12, 13, 14, 15, 16, 18, 20, 22, 24], def: 14 },
    reading: { list: [13, 14, 15, 16, 17, 18, 20, 22, 24, 28], def: 16 }
  };

  // [family name, label shown in the dropdown]. Filtered to what is installed.
  var CANDIDATES = {
    ui: [
      ['Microsoft YaHei UI', '微软雅黑 UI'],
      ['Microsoft YaHei', '微软雅黑'],
      ['Segoe UI', 'Segoe UI'],
      ['DengXian', '等线'],
      ['Source Han Sans SC', '思源黑体'],
      ['Noto Sans SC', 'Noto Sans SC'],
      ['HarmonyOS Sans SC', 'HarmonyOS Sans SC'],
      ['PingFang SC', '苹方'],
      ['Inter', 'Inter'],
      ['SimHei', '黑体']
    ],
    editor: [
      ['Cascadia Code', 'Cascadia Code'],
      ['Cascadia Mono', 'Cascadia Mono'],
      ['Consolas', 'Consolas'],
      ['JetBrains Mono', 'JetBrains Mono'],
      ['Fira Code', 'Fira Code'],
      ['Sarasa Mono SC', '更纱黑体 Mono SC'],
      ['Source Code Pro', 'Source Code Pro'],
      ['DejaVu Sans Mono', 'DejaVu Sans Mono'],
      ['Courier New', 'Courier New']
    ],
    reading: [
      ['Georgia', 'Georgia'],
      ['SimSun', '宋体'],
      ['KaiTi', '楷体'],
      ['FangSong', '仿宋'],
      ['Source Han Serif SC', '思源宋体'],
      ['Noto Serif SC', 'Noto Serif SC'],
      ['LXGW WenKai', '霞鹜文楷'],
      ['Microsoft YaHei', '微软雅黑'],
      ['Cambria', 'Cambria'],
      ['Times New Roman', 'Times New Roman']
    ]
  };

  var THEME_LABEL = { light: '白天', dark: '夜间', system: '跟随系统' };

  // Captured before any override lands, so a user pick can be layered on top of
  // the stack declared in style.css instead of duplicating it here.
  var baseFamily = {};
  var computed = getComputedStyle(root);
  for (var slot in CSS_FAMILY) {
    baseFamily[slot] = computed.getPropertyValue(CSS_FAMILY[slot]).trim();
  }

  // ---------- storage ----------

  function read(key, fallback) {
    try {
      var v = localStorage.getItem('peekdown-' + key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem('peekdown-' + key, value); } catch (e) {}
  }

  var prefs = {
    theme: read('theme', 'system'),
    family: {
      ui: read('font-ui', ''),
      editor: read('font-editor', ''),
      reading: read('font-reading', '')
    },
    size: {
      ui: parseFloat(read('size-ui', SIZES.ui.def)) || SIZES.ui.def,
      editor: parseFloat(read('size-editor', SIZES.editor.def)) || SIZES.editor.def,
      reading: parseFloat(read('size-reading', SIZES.reading.def)) || SIZES.reading.def
    }
  };

  if (!THEME_LABEL[prefs.theme]) prefs.theme = 'system';

  // ---------- theme ----------

  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolvedTheme() {
    if (prefs.theme !== 'system') return prefs.theme;
    if (!mql) return 'dark';
    return mql.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    root.setAttribute('data-theme', resolvedTheme());
  }

  if (mql) {
    var onSystemChange = function() { if (prefs.theme === 'system') applyTheme(); };
    if (mql.addEventListener) mql.addEventListener('change', onSystemChange);
    else if (mql.addListener) mql.addListener(onSystemChange);
  }

  // ---------- fonts ----------

  function applyFamily(slot) {
    var pick = prefs.family[slot];
    root.style.setProperty(
      CSS_FAMILY[slot],
      pick ? '"' + pick + '", ' + baseFamily[slot] : baseFamily[slot]
    );
  }

  function applySize(slot) {
    var n = prefs.size[slot];
    if (slot === 'ui') root.style.setProperty('--ui-scale', String(n / SIZES.ui.def));
    else if (slot === 'editor') root.style.setProperty('--font-size-editor', n + 'px');
    else root.style.setProperty('--font-size-preview', n + 'px');
  }

  // Runs at parse time, before first paint, so a stored light theme or font
  // choice does not flash the default first.
  applyTheme();
  ['ui', 'editor', 'reading'].forEach(function(slot) {
    applyFamily(slot);
    applySize(slot);
  });

  // ---------- installed-font detection ----------
  // document.fonts.check() reports true for names that are not installed, so
  // fall back to comparing rendered widths against dissimilar generic families.
  var ctx = null;
  var baselineWidth = {};
  var PROBE = 'WMil中文汉字0189';

  function widthOf(stack) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '72px ' + stack;
    return ctx.measureText(PROBE).width;
  }

  function isInstalled(name) {
    var quoted = '"' + name + '"';
    return ['monospace', 'sans-serif', 'serif'].some(function(generic) {
      if (baselineWidth[generic] === undefined) baselineWidth[generic] = widthOf(generic);
      return widthOf(quoted + ',' + generic) !== baselineWidth[generic];
    });
  }

  // ---------- UI ----------

  var panel = document.getElementById('settings-panel');
  var gear = document.getElementById('btn-settings');
  var isOpen = false;

  function label(slot) {
    var pick = prefs.family[slot];
    var name = '默认';
    if (pick) {
      name = pick;
      CANDIDATES[slot].forEach(function(c) { if (c[0] === pick) name = c[1]; });
    }
    return name + ' · ' + prefs.size[slot];
  }

  function refreshLabels() {
    document.getElementById('theme-value').textContent = THEME_LABEL[prefs.theme];
    ['ui', 'editor', 'reading'].forEach(function(slot) {
      var el = panel.querySelector('[data-value="' + slot + '"]');
      if (el) el.textContent = label(slot);
      var sample = panel.querySelector('[data-sample="' + slot + '"]');
      if (sample) {
        sample.style.fontFamily = 'var(' + CSS_FAMILY[slot] + ')';
        sample.style.fontSize = prefs.size[slot] + 'px';
      }
    });
  }

  function buildSelects() {
    ['ui', 'editor', 'reading'].forEach(function(slot) {
      var familySel = panel.querySelector('[data-family="' + slot + '"]');
      var sizeSel = panel.querySelector('[data-size="' + slot + '"]');

      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '默认';
      familySel.appendChild(opt);

      var seen = false;
      CANDIDATES[slot].forEach(function(c) {
        if (!isInstalled(c[0])) return;
        var o = document.createElement('option');
        o.value = c[0];
        o.textContent = c[1];
        familySel.appendChild(o);
        if (c[0] === prefs.family[slot]) seen = true;
      });

      // A stored font that is no longer installed still round-trips.
      if (prefs.family[slot] && !seen) {
        var missing = document.createElement('option');
        missing.value = prefs.family[slot];
        missing.textContent = prefs.family[slot] + '（未安装）';
        familySel.appendChild(missing);
      }
      familySel.value = prefs.family[slot];

      SIZES[slot].list.forEach(function(n) {
        var o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        sizeSel.appendChild(o);
      });
      if (SIZES[slot].list.indexOf(prefs.size[slot]) === -1) {
        var extra = document.createElement('option');
        extra.value = prefs.size[slot];
        extra.textContent = prefs.size[slot];
        sizeSel.appendChild(extra);
      }
      sizeSel.value = prefs.size[slot];

      familySel.addEventListener('change', function() {
        prefs.family[slot] = familySel.value;
        write('font-' + slot, familySel.value);
        applyFamily(slot);
        refreshLabels();
      });

      sizeSel.addEventListener('change', function() {
        prefs.size[slot] = parseFloat(sizeSel.value);
        write('size-' + slot, sizeSel.value);
        applySize(slot);
        refreshLabels();
      });
    });
  }

  function bindTheme() {
    var radios = panel.querySelectorAll('input[name="pd-theme"]');
    Array.prototype.forEach.call(radios, function(radio) {
      radio.checked = radio.value === prefs.theme;
      radio.addEventListener('change', function() {
        if (!radio.checked) return;
        prefs.theme = radio.value;
        write('theme', radio.value);
        applyTheme();
        refreshLabels();
      });
    });
  }

  function bindCards() {
    var cards = panel.querySelectorAll('.settings-card:not(.static)');
    Array.prototype.forEach.call(cards, function(card) {
      card.querySelector('.settings-card-head').addEventListener('click', function() {
        var wasOpen = card.classList.contains('expanded');
        Array.prototype.forEach.call(cards, function(c) { c.classList.remove('expanded'); });
        if (!wasOpen) card.classList.add('expanded');
      });
    });
  }

  function open() {
    if (typeof closeFind === 'function') closeFind();
    panel.classList.add('visible');
    panel.scrollTop = 0;
    gear.classList.add('active');
    isOpen = true;
    document.getElementById('editor').blur();
    document.getElementById('settings-back').focus();
  }

  function close() {
    panel.classList.remove('visible');
    gear.classList.remove('active');
    isOpen = false;
    if (typeof currentMode !== 'undefined' && currentMode === 'edit') {
      document.getElementById('editor').focus();
    }
  }

  function toggle() { isOpen ? close() : open(); }

  buildSelects();
  bindTheme();
  bindCards();
  refreshLabels();

  gear.addEventListener('click', toggle);
  document.getElementById('settings-back').addEventListener('click', close);

  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      close();
    }
  });

  return { open: open, close: close, toggle: toggle, isOpen: function() { return isOpen; } };
})();

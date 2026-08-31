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

  var ENCODING_LABEL_S = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE' };
  var FORMAT_LABEL = { md: '.md', markdown: '.markdown', txt: '.txt' };
  var DISPLAY_LABEL = { icon: '仅图标', text: '仅文字', both: '图标和文字' };

  var prefs = {
    theme: read('theme', 'system'),
    encoding: read('encoding', 'utf8'),
    format: read('format', 'md'),
    toolbarDisplay: read('toolbar-display', 'icon'),
    // Which buttons are on. Stored as a JSON map so a button added in a later
    // version defaults to visible instead of vanishing for existing users.
    toolbarShown: (function() {
      try { return JSON.parse(read('toolbar-shown', 'null')) || {}; } catch (e) { return {}; }
    })(),
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
  if (!ENCODING_LABEL_S[prefs.encoding]) prefs.encoding = 'utf8';
  if (!FORMAT_LABEL[prefs.format]) prefs.format = 'md';
  if (!DISPLAY_LABEL[prefs.toolbarDisplay]) prefs.toolbarDisplay = 'icon';

  // ---------- toolbar ----------

  function buttonList() {
    return typeof TOOLBAR_BUTTONS !== 'undefined' ? TOOLBAR_BUTTONS : [];
  }

  function isShown(id) {
    // Absent means "never touched" → visible. Only an explicit false hides.
    return prefs.toolbarShown[id] !== false;
  }

  function applyToolbar() {
    document.body.setAttribute('data-toolbar-display', prefs.toolbarDisplay);
    buttonList().forEach(function(b) {
      var el = document.getElementById(b.id);
      if (el) el.style.display = isShown(b.id) ? '' : 'none';
    });
    // The separators would strand themselves against a hidden neighbour, so they
    // only show while something visible sits on each side of them.
    var kids = Array.prototype.slice.call(
      document.querySelectorAll('.titlebar-actions > *'));
    kids.forEach(function(el, i) {
      if (!el.classList.contains('titlebar-sep')) return;
      var before = false, after = false;
      for (var j = i - 1; j >= 0; j--) {
        if (kids[j].classList.contains('titlebar-sep')) break;
        if (kids[j].style.display !== 'none') { before = true; break; }
      }
      for (var k = i + 1; k < kids.length; k++) {
        if (kids[k].classList.contains('titlebar-sep')) break;
        if (kids[k].style.display !== 'none') { after = true; break; }
      }
      el.style.display = (before && after) ? '' : 'none';
    });
  }

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
  applyToolbar();

  // ---------- system font list ----------
  //
  // Rust enumerates the installed families through GDI and hands them over via
  // __setFonts. What came before was a hardcoded list of ~10 guesses per slot,
  // narrowed further by canvas width-probing — so almost nothing on the machine
  // was actually offered, and a font the probe misjudged was unreachable.
  //
  // Fetched on the first settings open, not at startup: enumeration costs a few
  // milliseconds and most sessions never open the panel.
  var systemFonts = null;
  var fontsRequested = false;

  function requestFonts() {
    if (fontsRequested || systemFonts || typeof sendToRust !== 'function') return;
    fontsRequested = true;
    sendToRust('list_fonts');
  }

  // ---------- UI ----------

  var panel = document.getElementById('settings-panel');
  var gear = document.getElementById('btn-settings');
  var isOpen = false;

  function label(slot) {
    // Names arrive localised from Win32, so there is no alias table to consult:
    // a Chinese Windows reports 微软雅黑, not "Microsoft YaHei".
    return (prefs.family[slot] || '默认') + ' · ' + prefs.size[slot];
  }

  function refreshLabels() {
    document.getElementById('theme-value').textContent = THEME_LABEL[prefs.theme];
    document.getElementById('encoding-value').textContent =
      ENCODING_LABEL_S[prefs.encoding] + ' · ' + FORMAT_LABEL[prefs.format];
    var shownCount = buttonList().filter(function(b) { return isShown(b.id); }).length;
    document.getElementById('toolbar-value').textContent =
      DISPLAY_LABEL[prefs.toolbarDisplay] + ' · ' + shownCount + ' 个';
    // The merged card summarises all three slots, so it names the one most people
    // came to change rather than concatenating three font names into an ellipsis.
    document.getElementById('fonts-value').textContent = label('reading');
    ['ui', 'editor', 'reading'].forEach(function(slot) {
      var sample = panel.querySelector('[data-sample="' + slot + '"]');
      if (sample) {
        sample.style.fontFamily = 'var(' + CSS_FAMILY[slot] + ')';
        sample.style.fontSize = prefs.size[slot] + 'px';
      }
    });
  }

  function option(value, text, previewFamily) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    // Chromium draws its own dropdown, so each row can be shown in the family
    // it names — the whole point of picking from a list this long.
    if (previewFamily) o.style.fontFamily = '"' + previewFamily + '"';
    return o;
  }

  function appendGroup(sel, groupLabel, fonts) {
    if (!fonts.length) return;
    var g = document.createElement('optgroup');
    g.label = groupLabel;
    fonts.forEach(function(f) { g.appendChild(option(f.n, f.n, f.n)); });
    sel.appendChild(g);
  }

  function fillFamilySelect(slot) {
    var sel = panel.querySelector('[data-family="' + slot + '"]');
    if (!sel) return;
    var pick = prefs.family[slot];
    sel.innerHTML = '';
    sel.appendChild(option('', '默认'));

    if (!systemFonts) {
      // Still waiting on Rust. The stored pick has to stay selectable, or
      // opening the panel would silently reset it to 默认.
      if (pick) sel.appendChild(option(pick, pick, pick));
      sel.value = pick;
      return;
    }

    if (slot === 'editor') {
      // Monospace on top for the editor: hunting for Consolas among a few
      // hundred proportional families is the one case a flat list hurts.
      appendGroup(sel, '等宽字体', systemFonts.filter(function(f) { return f.m; }));
      appendGroup(sel, '其他字体', systemFonts.filter(function(f) { return !f.m; }));
    } else {
      systemFonts.forEach(function(f) { sel.appendChild(option(f.n, f.n, f.n)); });
    }

    var installed = systemFonts.some(function(f) { return f.n === pick; });
    if (pick && !installed) sel.appendChild(option(pick, pick + '（未安装）'));
    sel.value = pick;
  }

  // Rust's reply to list_fonts.
  window.__setFonts = function(list) {
    if (!list || !list.length) return;
    // Rust sorts by UTF-8 bytes, which files every CJK name after every Latin
    // one; collate here so 中文字体 land in pinyin order.
    systemFonts = list.slice().sort(function(a, b) {
      return a.n.localeCompare(b.n, 'zh-Hans-CN');
    });
    ['ui', 'editor', 'reading'].forEach(fillFamilySelect);
  };

  function buildSelects() {
    ['ui', 'editor', 'reading'].forEach(function(slot) {
      var familySel = panel.querySelector('[data-family="' + slot + '"]');
      var sizeSel = panel.querySelector('[data-size="' + slot + '"]');

      fillFamilySelect(slot);

      SIZES[slot].list.forEach(function(n) {
        sizeSel.appendChild(option(n, n));
      });
      if (SIZES[slot].list.indexOf(prefs.size[slot]) === -1) {
        sizeSel.appendChild(option(prefs.size[slot], prefs.size[slot]));
      }
      sizeSel.value = prefs.size[slot];

      // Bound to the <select>, so rebuilding its options keeps the handler.
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

  function bindToolbar() {
    var display = document.getElementById('toolbar-display');
    display.value = prefs.toolbarDisplay;
    display.addEventListener('change', function() {
      prefs.toolbarDisplay = display.value;
      write('toolbar-display', display.value);
      applyToolbar();
      refreshLabels();
    });

    var host = document.getElementById('toolbar-checks');
    buttonList().forEach(function(b) {
      var row = document.createElement('label');
      row.className = 'settings-check';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = isShown(b.id);
      var text = document.createElement('span');
      text.textContent = b.label;
      row.appendChild(box);
      row.appendChild(text);
      box.addEventListener('change', function() {
        prefs.toolbarShown[b.id] = box.checked;
        write('toolbar-shown', JSON.stringify(prefs.toolbarShown));
        applyToolbar();
        refreshLabels();
      });
      host.appendChild(row);
    });
  }

  function bindEncoding() {
    var enc = document.getElementById('encoding-select');
    var fmt = document.getElementById('format-select');
    enc.value = prefs.encoding;
    fmt.value = prefs.format;

    enc.addEventListener('change', function() {
      prefs.encoding = enc.value;
      write('encoding', enc.value);
      refreshLabels();
      // The status bar shows the default for any buffer with no file behind it.
      if (typeof updateEncodingStatus === 'function') updateEncodingStatus();
    });

    fmt.addEventListener('change', function() {
      prefs.format = fmt.value;
      write('format', fmt.value);
      refreshLabels();
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
    requestFonts();
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
  bindToolbar();
  bindEncoding();
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

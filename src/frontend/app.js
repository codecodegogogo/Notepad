// IPC Bridge
function sendToRust(command, data) {
  var msg = JSON.stringify(Object.assign({ command: command }, data || {}));
  window.ipc.postMessage(msg);
}

// Rust calls this to send events to JS
window.__fromRust = function(event, data) {
  switch (event) {
    case 'file_opened':
      cancelDropFallback();
      addRecentFile(data.path);
      TabManager.createTab(data.path, data.content, null, null, data.encoding);
      break;
    case 'file_saved':
      TabManager.markClean();
      if (data.path) {
        TabManager.updateTabPath(null, data.path);
      }
      // A save-as can change the encoding on disk, so adopt what Rust wrote.
      var savedTab = TabManager.getActiveTab();
      if (savedTab && data.encoding) savedTab.encoding = data.encoding;
      updateEncodingStatus();
      onFileSaved();
      break;
    case 'stdin_opened':
      TabManager.createTab(null, data.content, 'preview', data.title || 'stdin');
      break;
    case 'error':
      showError(data.message);
      break;
  }
};

// Cached DOM refs
var $ = {};
document.addEventListener('DOMContentLoaded', function() {
    $.editor = document.getElementById('editor');
    $.preview = document.getElementById('preview');
    $.previewContainer = document.getElementById('preview-container');
    $.editorContainer = document.getElementById('editor-container');
    $.statusInfo = document.getElementById('status-info');
    $.statusFile = document.getElementById('status-file');
    $.titlebarTitle = document.getElementById('titlebar-title');
    $.dropOverlay = document.getElementById('drop-overlay');
    $.tocPanel = document.getElementById('toc-panel');
    $.tocItems = document.getElementById('toc-list');
    $.findBar = document.getElementById('find-bar');
    $.findInput = document.getElementById('find-input');
    $.findCount = document.getElementById('find-count');
    $.zoomToast = document.getElementById('zoom-toast');
});

// State
var currentMode = 'edit';
var splitMode = false;

// Cross-mode selection helpers
function selectInPreview(text, ratio) {
  var preview = document.getElementById('preview');
  var walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
  var nodes = [], node, fullText = '';
  while (node = walker.nextNode()) {
    nodes.push({ node: node, start: fullText.length });
    fullText += node.textContent;
  }
  if (!nodes.length) return false;
  var textLower = text.toLowerCase(), fullLower = fullText.toLowerCase();
  var occurrences = [], idx = 0;
  while ((idx = fullLower.indexOf(textLower, idx)) !== -1) {
    occurrences.push(idx);
    idx += 1;
  }
  if (!occurrences.length) return false;
  var targetPos = ratio * fullText.length;
  var best = occurrences.reduce(function(a, b) {
    return Math.abs(b - targetPos) < Math.abs(a - targetPos) ? b : a;
  });
  var startPos = best, endPos = best + text.length;
  var startNode, startOffset, endNode, endOffset;
  for (var i = 0; i < nodes.length; i++) {
    var ns = nodes[i].start, ne = ns + nodes[i].node.textContent.length;
    if (!startNode && startPos >= ns && startPos < ne) {
      startNode = nodes[i].node; startOffset = startPos - ns;
    }
    if (endPos >= ns && endPos <= ne) {
      endNode = nodes[i].node; endOffset = endPos - ns;
    }
  }
  if (!startNode || !endNode) return false;
  var range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  if (startNode.parentElement) startNode.parentElement.scrollIntoView({ block: 'center' });
  return true;
}

function selectInEditor(text, ratio) {
  var editor = document.getElementById('editor');
  var valueLower = editor.value.toLowerCase(), textLower = text.toLowerCase();
  var occurrences = [], idx = 0;
  while ((idx = valueLower.indexOf(textLower, idx)) !== -1) {
    occurrences.push(idx);
    idx += 1;
  }
  if (!occurrences.length) return false;
  var targetPos = ratio * editor.value.length;
  var best = occurrences.reduce(function(a, b) {
    return Math.abs(b - targetPos) < Math.abs(a - targetPos) ? b : a;
  });
  editor.selectionStart = best;
  editor.selectionEnd = best + text.length;
  var lines = editor.value.substring(0, best).split('\n');
  var approxLine = lines.length - 1;
  var totalLines = editor.value.split('\n').length;
  editor.scrollTop = (approxLine / totalLines) * editor.scrollHeight - editor.clientHeight / 3;
  return true;
}

// Mode Toggle
function toggleMode() {
  if (splitMode) {
    splitMode = false;
    document.body.classList.remove('split-mode');
    document.getElementById('btn-split').classList.remove('active');
  }

  var iconPreview = document.getElementById('icon-preview');
  var iconEdit = document.getElementById('icon-edit');

  if (currentMode === 'edit') {
    var editor = $.editor || document.getElementById('editor');
    var content = editor.value;
    var selectedText = content.substring(editor.selectionStart, editor.selectionEnd);
    var scrollRatio = content.length > 0 ? editor.selectionStart / content.length : 0;
    var tab = TabManager.getActiveTab();
    var previewEl = $.preview || document.getElementById('preview');
    if (tab && tab.parsedHtml) {
      previewEl.innerHTML = tab.parsedHtml;
    } else {
      var html = marked.parse(content);
      previewEl.innerHTML = html;
      if (tab) tab.parsedHtml = html;
    }
    resolveLocalImages();
    ($.editorContainer || document.getElementById('editor-container')).classList.remove('active');
    ($.previewContainer || document.getElementById('preview-container')).classList.add('active');
    document.getElementById('btn-toggle').classList.add('active');
    document.getElementById('status-mode').textContent = '预览';
    iconPreview.style.display = 'none';
    iconEdit.style.display = '';
    currentMode = 'preview';
    var pc = $.previewContainer || document.getElementById('preview-container');
    setTimeout(function() {
      if (!selectedText || !selectInPreview(selectedText, scrollRatio)) {
        pc.scrollTop = scrollRatio * (pc.scrollHeight - pc.clientHeight);
      }
    }, 0);
    if (findState.open) doFind(($.findInput || document.getElementById('find-input')).value);
  } else {
    var sel = window.getSelection();
    var selectedText = sel.toString();
    var pc = $.previewContainer || document.getElementById('preview-container');
    var scrollRatio = pc.scrollHeight > pc.clientHeight ? pc.scrollTop / (pc.scrollHeight - pc.clientHeight) : 0;
    pc.classList.remove('active');
    ($.editorContainer || document.getElementById('editor-container')).classList.add('active');
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = '编辑';
    iconPreview.style.display = '';
    iconEdit.style.display = 'none';
    currentMode = 'edit';
    var editor = $.editor || document.getElementById('editor');
    editor.focus();
    if (!selectedText || !selectInEditor(selectedText, scrollRatio)) {
      var pos = Math.round(scrollRatio * editor.value.length);
      editor.selectionStart = editor.selectionEnd = pos;
      editor.scrollTop = scrollRatio * (editor.scrollHeight - editor.clientHeight);
    }
    if (findState.open) doFind(($.findInput || document.getElementById('find-input')).value);
  }
}

function setTitle(title) {
  ($.titlebarTitle || document.getElementById('titlebar-title')).textContent = title;
}

// Transient status-bar line. One shared timer so a later message cannot be
// wiped by an earlier one's expiry.
var statusInfoTimer = null;

function showInfo(message, ms) {
  var info = document.getElementById('status-info');
  info.textContent = message;
  info.style.color = '';
  clearTimeout(statusInfoTimer);
  statusInfoTimer = setTimeout(function() { info.textContent = ''; }, ms || 2000);
}

function onFileSaved() {
  showInfo('已保存');
}

function showError(message) {
  var info = document.getElementById('status-info');
  info.textContent = '错误：' + message;
  info.style.color = '#c15050';
  clearTimeout(statusInfoTimer);
  statusInfoTimer = setTimeout(function() { info.textContent = ''; info.style.color = ''; }, 5000);
}

// Split View
function toggleSplit() {
  var iconPreview = document.getElementById('icon-preview');
  var iconEdit = document.getElementById('icon-edit');

  if (splitMode) {
    splitMode = false;
    document.body.classList.remove('split-mode');
    document.getElementById('btn-split').classList.remove('active');
    ($.previewContainer || document.getElementById('preview-container')).classList.remove('active');
    currentMode = 'edit';
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = '编辑';
    iconPreview.style.display = '';
    iconEdit.style.display = 'none';
    ($.editor || document.getElementById('editor')).focus();
  } else {
    splitMode = true;
    document.body.classList.add('split-mode');
    document.getElementById('btn-split').classList.add('active');
    ($.editorContainer || document.getElementById('editor-container')).classList.add('active');
    ($.previewContainer || document.getElementById('preview-container')).classList.add('active');
    var splitTab = TabManager.getActiveTab();
    var splitContent = ($.editor || document.getElementById('editor')).value;
    var splitPreviewEl = $.preview || document.getElementById('preview');
    if (splitTab && splitTab.parsedHtml) {
      splitPreviewEl.innerHTML = splitTab.parsedHtml;
    } else {
      var splitHtml = marked.parse(splitContent);
      splitPreviewEl.innerHTML = splitHtml;
      if (splitTab) splitTab.parsedHtml = splitHtml;
    }
    resolveLocalImages();
    currentMode = 'edit';
    document.getElementById('btn-toggle').classList.remove('active');
    document.getElementById('status-mode').textContent = '分栏';
    iconPreview.style.display = '';
    iconEdit.style.display = 'none';
    document.getElementById('editor').focus();
  }
}

var splitPreviewTimer = null;
function updateSplitPreview() {
  if (!splitMode) return;
  clearTimeout(splitPreviewTimer);
  splitPreviewTimer = setTimeout(function() {
    var tab = TabManager.getActiveTab();
    var content = ($.editor || document.getElementById('editor')).value;
    var html = marked.parse(content);
    ($.preview || document.getElementById('preview')).innerHTML = html;
    if (tab) tab.parsedHtml = html;
    resolveLocalImages();
  }, 150);
}

// Word count. A Chinese paragraph has no spaces, so splitting on /\s+/ alone
// would report 1 - count CJK per character and the rest per whitespace run.
var CJK_CHAR = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/g;
var CJK_PUNCT = /[　-〿＀-￯]/g;

function updateWordCount() {
  var text = ($.editor || document.getElementById('editor')).value;
  var cjk = text.match(CJK_CHAR);
  var rest = text.replace(CJK_CHAR, ' ').replace(CJK_PUNCT, ' ').trim();
  var count = (cjk ? cjk.length : 0) + (rest ? rest.split(/\s+/).length : 0);
  document.getElementById('status-counts').textContent = count + ' 字';
}

// Recent Files
function getRecentFiles() {
  try { return JSON.parse(localStorage.getItem('peekdown-recent')) || []; } catch(e) { return []; }
}

function addRecentFile(path) {
  if (!path) return;
  var recent = getRecentFiles();
  var filename = path.split(/[/\\]/).pop();
  recent = recent.filter(function(r) { return r.path.replace(/\\/g, '/').toLowerCase() !== path.replace(/\\/g, '/').toLowerCase(); });
  recent.unshift({ path: path, filename: filename });
  if (recent.length > 10) recent = recent.slice(0, 10);
  try { localStorage.setItem('peekdown-recent', JSON.stringify(recent)); } catch(e) {}
}

function showRecentPanel() {
  var panel = document.getElementById('recent-panel');
  var tab = TabManager.getActiveTab();
  if (!tab || tab.path || tab.dirty || tab.content !== '') {
    panel.classList.remove('visible');
    return;
  }
  var recent = getRecentFiles();
  if (recent.length === 0) { panel.classList.remove('visible'); return; }
  panel.innerHTML = '';
  var title = document.createElement('div');
  title.className = 'recent-title';
  title.textContent = '最近打开';
  panel.appendChild(title);
  recent.forEach(function(r) {
    var item = document.createElement('div');
    item.className = 'recent-item';
    var name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = r.filename;
    var path = document.createElement('span');
    path.className = 'recent-path';
    path.textContent = r.path;
    item.appendChild(name);
    item.appendChild(path);
    item.addEventListener('click', function() {
      sendToRust('open_file', { path: r.path });
    });
    panel.appendChild(item);
  });
  panel.classList.add('visible');
}

// Table of Contents
var tocOpen = false;

function parseTOC(text) {
  var lines = text.split('\n');
  var headings = [];
  var inCodeBlock = false;
  for (var i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    var match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({ level: match[1].length, text: match[2].replace(/\s+#+\s*$/, '').replace(/[*_`\[\]]/g, '').trim(), line: i });
    }
  }
  return headings;
}

function updateTOC() {
  var list = $.tocItems || document.getElementById('toc-list');
  var text = ($.editor || document.getElementById('editor')).value;
  var headings = parseTOC(text);
  list.innerHTML = '';
  if (headings.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'toc-empty';
    empty.textContent = '没有标题';
    list.appendChild(empty);
    return;
  }
  headings.forEach(function(h, idx) {
    var item = document.createElement('div');
    item.className = 'toc-item toc-h' + h.level;
    item.textContent = h.text;
    item.addEventListener('click', function() {
      if (currentMode === 'edit') {
        scrollEditorToLine(h.line);
      } else {
        scrollPreviewToHeading(idx);
      }
    });
    list.appendChild(item);
  });
}

function scrollEditorToLine(lineNum) {
  var editor = document.getElementById('editor');
  var lines = editor.value.split('\n');
  var pos = 0;
  for (var i = 0; i < lineNum && i < lines.length; i++) {
    pos += lines[i].length + 1;
  }
  editor.focus();
  editor.selectionStart = pos;
  editor.selectionEnd = pos + (lines[lineNum] || '').length;
  var approxLineHeight = editor.scrollHeight / lines.length;
  editor.scrollTop = lineNum * approxLineHeight - editor.clientHeight / 3;
}

function scrollPreviewToHeading(idx) {
  var headings = document.getElementById('preview').querySelectorAll('h1,h2,h3,h4,h5,h6');
  if (headings[idx]) {
    headings[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleTOC() {
  tocOpen = !tocOpen;
  document.getElementById('toc-panel').classList.toggle('open', tocOpen);
  document.getElementById('btn-toc').classList.toggle('active', tocOpen);
  if (tocOpen) updateTOC();
}

// Encoding shown in the status bar. A file that was opened keeps whatever Rust
// detected in it; an untitled buffer shows the configured default, since that is
// what it will be written as.
var ENCODING_LABEL = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE' };

function defaultEncoding() {
  try { return localStorage.getItem('peekdown-encoding') || 'utf8'; } catch (e) { return 'utf8'; }
}

function defaultFormat() {
  try { return localStorage.getItem('peekdown-format') || 'md'; } catch (e) { return 'md'; }
}

function updateEncodingStatus() {
  var tab = TabManager.getActiveTab();
  var enc = (tab && tab.encoding) || defaultEncoding();
  document.getElementById('status-encoding').textContent = ENCODING_LABEL[enc] || enc;
}

function doSave() {
  var tab = TabManager.getActiveTab();
  var data = {
    content: document.getElementById('editor').value,
    // Re-saving keeps the file in the encoding it arrived in; only a brand-new
    // buffer gets the configured default.
    encoding: (tab && tab.encoding) || defaultEncoding(),
    format: defaultFormat()
  };
  if (tab && tab.path) data.path = tab.path;
  sendToRust('save_file', data);
}

function doSaveAs() {
  var tab = TabManager.getActiveTab();
  sendToRust('save_as', {
    content: document.getElementById('editor').value,
    encoding: (tab && tab.encoding) || defaultEncoding(),
    format: defaultFormat()
  });
}

// Zoom
var zoomLevel = 1;
var ZOOM_STEP = 0.1;
var ZOOM_MIN = 0.5;
var ZOOM_MAX = 3;

function applyZoom(level) {
  zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
  document.documentElement.style.setProperty('--zoom', zoomLevel);
  var pct = Math.round(zoomLevel * 100) + '%';
  document.getElementById('status-zoom').textContent = pct;
  var toast = $.zoomToast || document.getElementById('zoom-toast');
  toast.textContent = pct;
  toast.classList.add('visible');
  clearTimeout(applyZoom._timer);
  applyZoom._timer = setTimeout(function() {
    toast.classList.remove('visible');
  }, 800);
}

document.addEventListener('wheel', function(e) {
  if (e.ctrlKey) {
    e.preventDefault();
    applyZoom(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  }
}, { passive: false });

// Preview width resize
(function() {
  var handle = document.getElementById('preview-resize-handle');
  var preview = document.getElementById('preview-wrapper');
  var container = document.getElementById('preview-container');
  var DEFAULT_WIDTH = 720;
  var MIN_WIDTH = 300;

  var saved = null;
  try { saved = localStorage.getItem('peekdown-preview-width'); } catch(e) {}
  if (saved) preview.style.maxWidth = saved + 'px';

  var dragging = false;

  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('preview-resizing');
  });

  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    var containerRect = container.getBoundingClientRect();
    var centerX = containerRect.left + containerRect.width / 2;
    var width = Math.max(MIN_WIDTH, (e.clientX - centerX) * 2);
    width = Math.min(width, containerRect.width);
    preview.style.maxWidth = Math.round(width) + 'px';
  });

  document.addEventListener('mouseup', function() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('preview-resizing');
    try { localStorage.setItem('peekdown-preview-width', parseInt(preview.style.maxWidth)); } catch(e) {}
  });

  handle.addEventListener('dblclick', function() {
    preview.style.maxWidth = DEFAULT_WIDTH + 'px';
    try { localStorage.setItem('peekdown-preview-width', DEFAULT_WIDTH); } catch(e) {}
  });
})();

// Find
var findState = { open: false, matches: [], current: -1, marks: [] };

function openFind() {
  document.getElementById('find-bar').classList.add('open');
  findState.open = true;
  var input = document.getElementById('find-input');
  input.focus();
  input.select();
  if (input.value) doFind(input.value);
}

function closeFind() {
  document.getElementById('find-bar').classList.remove('open');
  findState.open = false;
  findState.matches = [];
  findState.current = -1;
  clearPreviewHighlights();
  document.getElementById('find-count').textContent = '';
  if (currentMode === 'edit') document.getElementById('editor').focus();
}

function doFind(term) {
  findState.matches = [];
  findState.current = -1;
  clearPreviewHighlights();
  if (!term) {
    ($.findCount || document.getElementById('find-count')).textContent = '';
    return;
  }
  if (currentMode === 'edit') {
    var text = ($.editor || document.getElementById('editor')).value.toLowerCase();
    var termLower = term.toLowerCase();
    var idx = 0;
    while ((idx = text.indexOf(termLower, idx)) !== -1) {
      findState.matches.push({ start: idx, end: idx + term.length });
      idx += term.length;
    }
  } else {
    var preview = $.preview || document.getElementById('preview');
    var walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    var node, ranges = [], termLower = term.toLowerCase();
    while (node = walker.nextNode()) {
      var nodeText = node.textContent.toLowerCase();
      var idx = 0;
      while ((idx = nodeText.indexOf(termLower, idx)) !== -1) {
        var range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + term.length);
        ranges.push(range);
        idx += term.length;
      }
    }
    for (var i = ranges.length - 1; i >= 0; i--) {
      var mark = document.createElement('mark');
      mark.className = 'find-match';
      ranges[i].surroundContents(mark);
      findState.marks.unshift(mark);
    }
    findState.matches = findState.marks.map(function(_, i) { return i; });
  }
  if (findState.matches.length > 0) {
    findState.current = 0;
    goToMatch(0);
  }
  updateFindCount();
}

function clearPreviewHighlights() {
  findState.marks.forEach(function(mark) {
    var parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
  findState.marks = [];
}

function goToMatch(idx) {
  findState.current = idx;
  if (currentMode === 'edit') {
    var match = findState.matches[idx];
    var editor = document.getElementById('editor');
    editor.focus();
    editor.selectionStart = match.start;
    editor.selectionEnd = match.end;
  } else {
    findState.marks.forEach(function(m) { m.classList.remove('find-active'); });
    var mark = findState.marks[idx];
    mark.classList.add('find-active');
    mark.scrollIntoView({ block: 'center' });
  }
  updateFindCount();
}

function findNext() {
  if (findState.matches.length === 0) return;
  goToMatch((findState.current + 1) % findState.matches.length);
}

function findPrev() {
  if (findState.matches.length === 0) return;
  goToMatch((findState.current - 1 + findState.matches.length) % findState.matches.length);
}

function updateFindCount() {
  var el = document.getElementById('find-count');
  if (findState.matches.length === 0) {
    el.textContent = document.getElementById('find-input').value ? '无结果' : '';
  } else {
    el.textContent = (findState.current + 1) + ' / ' + findState.matches.length;
  }
}

document.getElementById('find-input').addEventListener('input', function() {
  doFind(this.value);
});
document.getElementById('find-input').addEventListener('keydown', function(e) {
  if (e.key === 'Escape') { closeFind(); e.preventDefault(); }
  else if (e.key === 'Enter' && !e.shiftKey) { findNext(); e.preventDefault(); }
  else if (e.key === 'Enter' && e.shiftKey) { findPrev(); e.preventDefault(); }
});
document.getElementById('find-close').addEventListener('click', closeFind);
document.getElementById('find-next').addEventListener('click', findNext);
document.getElementById('find-prev').addEventListener('click', findPrev);

// Keyboard Shortcuts
document.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    openFind();
  } else if (e.key === 'Escape' && findState.open) {
    e.preventDefault();
    closeFind();
  } else if (e.ctrlKey && e.key === 'o') {
    e.preventDefault();
    sendToRust('open_file');
  } else if (e.ctrlKey && !e.shiftKey && e.key === 's') {
    e.preventDefault();
    doSave();
  } else if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
    e.preventDefault();
    doSaveAs();
  } else if (e.ctrlKey && e.key === 'e') {
    e.preventDefault();
    toggleMode();
  } else if (e.ctrlKey && e.key === 'n') {
    e.preventDefault();
    TabManager.createTab(null, '');
  } else if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    var active = TabManager.getActiveTab();
    if (active) TabManager.closeTab(active.id);
  } else if (e.ctrlKey && !e.shiftKey && e.key === 'Tab') {
    e.preventDefault();
    TabManager.nextTab();
  } else if (e.ctrlKey && e.shiftKey && e.key === 'Tab') {
    e.preventDefault();
    TabManager.prevTab();
  } else if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    applyZoom(zoomLevel + ZOOM_STEP);
  } else if (e.ctrlKey && e.key === '-') {
    e.preventDefault();
    applyZoom(zoomLevel - ZOOM_STEP);
  } else if (e.ctrlKey && e.key === '0') {
    e.preventDefault();
    applyZoom(1);
  } else if (e.ctrlKey && e.key === '\\') {
    e.preventDefault();
    toggleSplit();
  } else if (e.ctrlKey && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
    e.preventDefault();
    toggleTOC();
  }
});

// Window Controls
document.getElementById('btn-minimize').addEventListener('click', function() { sendToRust('window_minimize'); });
document.getElementById('btn-maximize').addEventListener('click', function() { sendToRust('window_maximize'); });
document.getElementById('btn-close').addEventListener('click', function() {
  if (TabManager.hasAnyDirty()) {
    if (!confirm('有未保存的更改，仍要关闭吗？')) return;
  }
  sendToRust('window_close');
});

// Rust owns the maximized flag and pushes it here. Guessing it from the click
// would drift: the titlebar is a drag region, so Windows also maximizes on
// double-click, on Win+Up and on a drag to the top edge, none of which reach JS.
window.__setMaximized = function(maximized) {
  var box = document.getElementById('icon-maximize');
  var stack = document.getElementById('icon-restore');
  if (!box || !stack) return;
  box.style.display = maximized ? 'none' : '';
  stack.style.display = maximized ? '' : 'none';
  document.getElementById('btn-maximize').title = maximized ? '向下还原' : '最大化';
};

// Drag & drop.
//
// Rust's native drop target is the path we want: it reports real filesystem
// paths, so Ctrl+S can write back in place. But if WebView2 claims the drag
// instead, that handler never fires and the drop silently does nothing — which
// is exactly what dropping onto a window that already had a file open looked
// like. So mirror the drag here, and only fall back to reading the File objects
// if Rust stays quiet. Whichever layer wins, one document opens, never two.
var DROP_FALLBACK_MS = 400;
var MAX_DROP_BYTES = 16 * 1024 * 1024;
var dropFallbackTimer = null;
var dragDepth = 0;

function cancelDropFallback() {
  clearTimeout(dropFallbackTimer);
  dropFallbackTimer = null;
}

function showDropOverlay(visible) {
  document.getElementById('drop-overlay').classList.toggle('visible', visible);
}

// dataTransfer.files is empty until the drop itself, so a drag in progress can
// only be recognised by the 'Files' entry in .types.
function dragHasFiles(e) {
  var dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.files && dt.files.length) return true;
  return dt.types ? Array.prototype.indexOf.call(dt.types, 'Files') !== -1 : false;
}

function openDroppedFile(file) {
  if (file.size > MAX_DROP_BYTES) {
    showError('文件过大：' + file.name);
    return;
  }
  var reader = new FileReader();
  reader.onload = function() {
    // The browser sandbox hides the real path, so the tab opens unbound to a
    // file — Ctrl+S will ask where to put it.
    TabManager.createTab(null, reader.result, 'preview', file.name);
  };
  reader.onerror = function() { showError('读取失败：' + file.name); };
  reader.readAsText(file);
}

document.addEventListener('dragenter', function(e) {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  showDropOverlay(true);
});

document.addEventListener('dragover', function(e) {
  if (!dragHasFiles(e)) return;
  e.preventDefault();   // without this Chromium refuses the drop outright
  e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', function(e) {
  if (!dragHasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropOverlay(false);
});

document.addEventListener('drop', function(e) {
  if (!dragHasFiles(e)) return;
  e.preventDefault();   // and without this Chromium navigates away to file://
  dragDepth = 0;
  showDropOverlay(false);
  var files = Array.prototype.slice.call(e.dataTransfer.files || []);
  if (!files.length) return;
  cancelDropFallback();
  dropFallbackTimer = setTimeout(function() {
    dropFallbackTimer = null;
    files.forEach(openDroppedFile);
  }, DROP_FALLBACK_MS);
});

// Toolbar Buttons
//
// TOOLBAR_BUTTONS is the single source of truth for the bar: settings.js reads it
// to build the visibility checkboxes, and the loop below injects each label so the
// text/both display modes have something to show. Keeping the order here means the
// settings list can never drift out of sync with the bar itself.
var TOOLBAR_BUTTONS = [
  { id: 'btn-settings', label: '设置' },
  { id: 'btn-new', label: '新建' },
  { id: 'btn-open', label: '打开' },
  { id: 'btn-save', label: '保存' },
  { id: 'btn-saveas', label: '另存为' },
  { id: 'btn-toggle', label: '预览' },
  { id: 'btn-split', label: '分栏' },
  { id: 'btn-toc', label: '大纲' }
];

TOOLBAR_BUTTONS.forEach(function(b) {
  var el = document.getElementById(b.id);
  if (!el) return;
  var span = document.createElement('span');
  span.className = 'btn-label';
  span.textContent = b.label;
  el.appendChild(span);
});

document.getElementById('btn-new').addEventListener('click', function() { TabManager.createTab(null, ''); });
document.getElementById('btn-open').addEventListener('click', function() { sendToRust('open_file'); });
document.getElementById('btn-save').addEventListener('click', doSave);
document.getElementById('btn-saveas').addEventListener('click', doSaveAs);
document.getElementById('btn-toggle').addEventListener('click', toggleMode);
document.getElementById('btn-split').addEventListener('click', toggleSplit);
document.getElementById('btn-toc').addEventListener('click', toggleTOC);

// Theme, fonts and font sizes live in settings.js

// Init
document.addEventListener('DOMContentLoaded', function() {
  TabManager.createTab(null, '');
  updateWordCount();
  updateEncodingStatus();
  showRecentPanel();
  sendToRust('ready');
});

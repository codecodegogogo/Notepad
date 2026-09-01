(function() {
  var editor = document.getElementById('editor');

  var changeTimer = null;
  editor.addEventListener('input', function() {
    var activeTab = TabManager.getActiveTab();
    if (activeTab) activeTab.parsedHtml = null;
    // Not debounced: the recent-files list sits over the empty page, and waiting
    // 300ms to drop it means the first characters you type appear underneath it.
    if (typeof showRecentPanel === 'function') showRecentPanel();
    if (typeof updateCursorStatus === 'function') updateCursorStatus();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(function() {
      TabManager.markDirty();
      updateWordCount();
      if (typeof tocOpen !== 'undefined' && tocOpen) updateTOC();
    }, 300);
    if (typeof splitMode !== 'undefined' && splitMode) {
      updateSplitPreview();
    }
    // Editing shifts every match offset, so the highlight layer under the
    // textarea would point at stale positions. Re-running the search rebuilds
    // both the offsets and the layer.
    if (typeof findState !== 'undefined' && findState.open && typeof doFind === 'function') {
      doFind(document.getElementById('find-input').value);
    }
  });

  // The caret can move without any text change — arrow keys, a click, a drag
  // selection — so its readout is refreshed on those too, not just on input.
  ['keyup', 'click', 'select', 'focus'].forEach(function(evt) {
    editor.addEventListener(evt, function() {
      if (typeof updateCursorStatus === 'function') updateCursorStatus();
    });
  });

  // Tab key inserts spaces (but not Ctrl+Tab which switches tabs)
  editor.addEventListener('keydown', function(e) {
    if (e.key === 'Tab' && !e.ctrlKey) {
      e.preventDefault();
      var start = editor.selectionStart;
      var end = editor.selectionEnd;
      editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
      editor.selectionStart = editor.selectionEnd = start + 4;
      editor.dispatchEvent(new Event('input'));
      TabManager.markDirty();
      if (typeof splitMode !== 'undefined' && splitMode) updateSplitPreview();
    }
  });
})();

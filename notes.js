/* 本地病理笔记的 Markdown、图片和文本导出工具。 */
(function () {
  'use strict';

  const DB_NAME = 'pathology-note-images-v1';
  const STORE_NAME = 'images';
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const imageUrls = new Map();
  let databasePromise;
  let exportDialog;
  let imageDialog;
  let exportReturnFocus;
  let imageReturnFocus;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function inlineMarkdown(value) {
    let source = value;
    const codeParts = [];
    source = source.replace(/`([^`]+)`/g, function (_, code) {
      codeParts.push(code);
      return '\u0000' + (codeParts.length - 1) + '\u0000';
    });
    source = source.replace(/!\[([^\]]*)\]\(img:([A-Za-z0-9_-]+)\)/g,
      '<img data-img="$2" alt="$1">');
    source = source.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    source = source.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
    source = source.replace(/\u0000(\d+)\u0000/g, function (_, index) {
      return '<code>' + codeParts[Number(index)] + '</code>';
    });
    return source;
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }

  function tableCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
      .map(function (cell) { return inlineMarkdown(cell.trim()); });
  }

  function render(text) {
    if (!text) return '';
    const lines = escapeHtml(text).split(/\r?\n/);
    let output = '';
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      let match;
      if (/^\s*```/.test(line)) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        output += '<pre><code>' + code.join('\n') + '</code></pre>';
        continue;
      }
      if (!line.trim()) { index += 1; continue; }
      match = line.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        const level = Math.min(6, match[1].length);
        output += '<h' + level + '>' + inlineMarkdown(match[2]) + '</h' + level + '>';
        index += 1;
        continue;
      }
      if (/^\s*[-*_]{3,}\s*$/.test(line)) { output += '<hr>'; index += 1; continue; }
      if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        const headings = tableCells(line);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
        output += '<div class="notes-table"><table><thead><tr>' + headings.map(function (cell) { return '<th>' + cell + '</th>'; }).join('') +
          '</tr></thead><tbody>' + rows.map(function (row) { return '<tr>' + row.map(function (cell) { return '<td>' + cell + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
        continue;
      }
      if (/^\s*&gt;\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^\s*&gt;\s?/.test(lines[index])) quote.push(lines[index++].replace(/^\s*&gt;\s?/, ''));
        output += '<blockquote>' + render(quote.join('\n')) + '</blockquote>';
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*+]\s+/, ''));
        output += '<ul>' + items.map(function (item) { return '<li>' + inlineMarkdown(item) + '</li>'; }).join('') + '</ul>';
        continue;
      }
      if (/^\s*\d+[.)、]\s*/.test(line) && /^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+[.)]\s+/, ''));
        output += '<ol>' + items.map(function (item) { return '<li>' + inlineMarkdown(item) + '</li>'; }).join('') + '</ol>';
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s|^\s*```|^\s*&gt;|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[index]) &&
        !(lines[index].includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))) paragraph.push(inlineMarkdown(lines[index++]));
      if (!paragraph.length) paragraph.push(inlineMarkdown(lines[index++]));
      output += '<p>' + paragraph.join('<br>') + '</p>';
    }
    return output;
  }

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise(function (resolve, reject) {
        if (!window.indexedDB) { reject(new Error('浏览器不支持本地图片存储')); return; }
        const request = window.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('无法打开图片存储')); };
      });
    }
    return databasePromise;
  }

  async function putImage(id, blob) {
    const db = await openDatabase();
    return new Promise(function (resolve, reject) {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(blob, id);
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('无法保存图片')); };
      transaction.onabort = function () { reject(transaction.error || new Error('图片保存已取消')); };
    });
  }

  async function getImage(id) {
    const db = await openDatabase();
    return new Promise(function (resolve, reject) {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { reject(request.error || new Error('无法读取图片')); };
    });
  }

  function makeImageId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  async function compressImage(file) {
    if (!file || !/^image\/(jpeg|png|webp|gif|bmp|avif)$/i.test(file.type || '')) throw new Error('请选择有效图片');
    if (!window.createImageBitmap) throw new Error('这个浏览器无法处理本地图片');
    const bitmap = await window.createImageBitmap(file);
    try {
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/webp', 0.82); });
      if (!blob || blob.type !== 'image/webp') blob = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
      if (!blob) throw new Error('图片压缩失败');
      return blob;
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  async function storeImage(file) {
    const blob = await compressImage(file);
    const id = makeImageId();
    await putImage(id, blob);
    imageUrls.set(id, URL.createObjectURL(blob));
    return id;
  }

  function ensureImageDialog() {
    if (imageDialog) return imageDialog;
    imageDialog = document.createElement('dialog');
    imageDialog.className = 'pathology-note-image-dialog';
    imageDialog.setAttribute('aria-label', '查看笔记图片');
    imageDialog.innerHTML = '<form method="dialog"><button type="submit" aria-label="关闭图片">关闭</button></form><img alt="笔记图片放大预览">';
    imageDialog.addEventListener('click', function (event) { if (event.target === imageDialog) imageDialog.close(); });
    imageDialog.addEventListener('close', function () {
      if (imageReturnFocus && imageReturnFocus.isConnected) imageReturnFocus.focus();
      imageReturnFocus = null;
    });
    document.body.appendChild(imageDialog);
    return imageDialog;
  }

  async function hydrate(root) {
    const container = root || document;
    const elements = container.querySelectorAll('img[data-img]:not([src])');
    for (const element of elements) {
      const id = element.getAttribute('data-img');
      try {
        if (!imageUrls.has(id)) {
          const blob = await getImage(id);
          if (blob) imageUrls.set(id, URL.createObjectURL(blob));
        }
        const url = imageUrls.get(id);
        if (!url) {
          const missing = document.createElement('span');
          missing.className = 'note-image-missing';
          missing.textContent = '图片未保存在这台设备上';
          element.replaceWith(missing);
          continue;
        }
        element.src = url;
        element.addEventListener('click', function () {
          const dialog = ensureImageDialog();
          const preview = dialog.querySelector('img');
          imageReturnFocus = element;
          preview.src = url;
          if (typeof dialog.showModal === 'function') dialog.showModal();
        });
      } catch (_) {
        const missing = document.createElement('span');
        missing.className = 'note-image-missing';
        missing.textContent = '浏览器无法读取本地图片';
        element.replaceWith(missing);
      }
    }
  }

  function referencedImageIds(records) {
    const ids = new Set();
    const values = records && typeof records === 'object' ? Object.values(records) : [];
    for (const record of values) {
      const note = record && typeof record.note === 'string' ? record.note : '';
      const matcher = /!\[[^\]]*\]\(img:([A-Za-z0-9_-]+)\)/g;
      let match;
      while ((match = matcher.exec(note))) ids.add(match[1]);
    }
    return ids;
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('无法导出图片')); };
      reader.readAsDataURL(blob);
    });
  }

  async function exportImages(records) {
    const exported = {};
    const missing = [];
    for (const id of referencedImageIds(records)) {
      try {
        const blob = await getImage(id);
        if (!blob) { missing.push(id); continue; }
        exported[id] = await blobToDataUrl(blob);
      } catch (_) { missing.push(id); }
    }
    return { images: exported, missing: missing };
  }

  function decodeImageDataUrl(value) {
    if (typeof value !== 'string') throw new Error('图片数据格式无效');
    const match = value.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (!match || match[2].length % 4 !== 0) throw new Error('仅支持 JPEG、PNG 或 WebP 图片');
    const estimatedBytes = Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (estimatedBytes <= 0 || estimatedBytes > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 12 MB');
    let binary;
    try { binary = atob(match[2]); } catch (_) { throw new Error('图片数据格式无效'); }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const mime = 'image/' + match[1].toLowerCase();
    const signatureMatches = mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
      : mime === 'image/png' ? bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
        : bytes.length >= 12 && String.fromCharCode.apply(null, bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode.apply(null, bytes.slice(8, 12)) === 'WEBP';
    if (!signatureMatches) throw new Error('图片内容与文件类型不匹配');
    return new Blob([bytes], { type: mime });
  }

  async function importImages(images) {
    if (!images || typeof images !== 'object' || Array.isArray(images)) return 0;
    let count = 0;
    for (const id of Object.keys(images)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      try {
        const blob = decodeImageDataUrl(images[id]);
        await putImage(id, blob);
        const oldUrl = imageUrls.get(id);
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        imageUrls.delete(id);
        count += 1;
      } catch (_) { /* 跳过格式错误或超限的单张图片。 */ }
    }
    return count;
  }

  function ensureExportDialog() {
    if (exportDialog) return exportDialog;
    exportDialog = document.createElement('dialog');
    exportDialog.className = 'pathology-note-export-dialog';
    exportDialog.setAttribute('aria-labelledby', 'pathology-note-export-title');
    exportDialog.innerHTML = '<form method="dialog" class="note-export-panel"><h2 id="pathology-note-export-title"></h2><textarea readonly rows="18"></textarea><div class="note-export-actions"><button type="button" data-copy>复制文本</button><button type="button" data-save>保存为 TXT</button><button type="submit">关闭</button></div><p role="status" aria-live="polite"></p></form>';
    exportDialog.addEventListener('click', function (event) { if (event.target === exportDialog) exportDialog.close(); });
    exportDialog.addEventListener('close', function () {
      if (exportReturnFocus && exportReturnFocus.isConnected) exportReturnFocus.focus();
      exportReturnFocus = null;
    });
    exportDialog.querySelector('[data-copy]').addEventListener('click', async function () {
      const textarea = exportDialog.querySelector('textarea');
      const status = exportDialog.querySelector('[role="status"]');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(textarea.value);
        else {
          textarea.focus();
          textarea.select();
          if (!document.execCommand('copy')) throw new Error('copy failed');
        }
        status.textContent = '文本已复制';
      } catch (_) { status.textContent = '无法自动复制，请选中文本后复制'; }
    });
    exportDialog.querySelector('[data-save]').addEventListener('click', function () {
      const text = exportDialog.querySelector('textarea').value;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = (exportDialog.dataset.filename || '笔记') + '.txt';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      exportDialog.querySelector('[role="status"]').textContent = '文本文件已保存';
    });
    document.body.appendChild(exportDialog);
    return exportDialog;
  }

  function showTextExport(text, title) {
    const dialog = ensureExportDialog();
    const safeTitle = String(title || '笔记');
    dialog.querySelector('h2').textContent = safeTitle;
    dialog.querySelector('textarea').value = String(text || '');
    dialog.querySelector('[role="status"]').textContent = '';
    dialog.dataset.filename = safeTitle.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '笔记';
    exportReturnFocus = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    dialog.querySelector('textarea').focus();
    return dialog;
  }

  window.PATHOLOGY_NOTES = {
    render: render,
    hydrate: hydrate,
    storeImage: storeImage,
    exportImages: exportImages,
    importImages: importImages,
    showTextExport: showTextExport
  };
}());

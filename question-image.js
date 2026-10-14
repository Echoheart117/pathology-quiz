/* 将题目内容绘制为独立图片，再交给浏览器剪贴板。 */
(() => {
  'use strict';
  const WIDTH = 880;
  const PADDING = 44;
  const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';

  function capture(card, question) {
    return {
      title: `${question.chapterName} · ${question.language === 'en' ? '英文' : '中文'}第 ${question.number} 题`,
      sharedStem: card.querySelector('.shared-stem')?.innerText || '',
      stem: card.querySelector('.stem')?.innerText || '',
      options: [...card.querySelectorAll('.option')].map(option => ({
        key: option.querySelector('.option-key').innerText,
        text: option.querySelector('.option-text').innerText
      })),
      images: [...card.querySelectorAll('.question-image')].map(figure => ({
        src: figure.querySelector('img').src,
        caption: figure.querySelector('figcaption')?.innerText || ''
      }))
    };
  }

  function wrapText(context, text, width) {
    const lines = [];
    for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
      let line = '';
      const tokens = paragraph.match(/\s+|[A-Za-z0-9][A-Za-z0-9'’._-]*|[^\s]/gu) || [];
      for (const token of tokens) {
        if (context.measureText(line + token).width <= width) {
          line += line ? token : token.trimStart();
          continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = token.trimStart();
        if (context.measureText(line).width > width) {
          let fragment = '';
          for (const character of line) {
            if (context.measureText(fragment + character).width > width && fragment) {
              lines.push(fragment);
              fragment = '';
            }
            fragment += character;
          }
          line = fragment;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  function loadImage(src) {
    const url = new URL(src, location.href);
    if (url.origin !== location.origin) return Promise.reject(new Error('题目配图来源无效。'));
    return new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => { image.src = ''; reject(new Error('题目配图加载超时，请重试。')); }, 15000);
      image.onload = () => { clearTimeout(timeout); resolve(image); };
      image.onerror = () => { clearTimeout(timeout); reject(new Error('题目配图未能加载，请重试。')); };
      image.src = url.href;
    });
  }

  async function render(snapshot) {
    if (document.fonts?.ready) await document.fonts.ready;
    const images = await Promise.all(snapshot.images.map(image => loadImage(image.src)));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法生成题目图片。');
    const instructions = [];
    let y = PADDING;
    function addText(text, size, color, gap = 20, width = WIDTH - PADDING * 2, x = PADDING) {
      context.font = `${size}px ${FONT}`;
      const lines = wrapText(context, text, width);
      const lineHeight = Math.ceil(size * 1.65);
      instructions.push({kind: 'text', lines, size, color, lineHeight, x, y});
      y += lines.length * lineHeight + gap;
    }
    addText(snapshot.title, 17, '#345a88', 22);
    if (snapshot.sharedStem) addText(snapshot.sharedStem, 22, '#52616a');
    addText(snapshot.stem, 25, '#1c292e', 26);
    snapshot.images.forEach((entry, index) => {
      const image = images[index];
      const width = Math.min(WIDTH - PADDING * 2, image.naturalWidth);
      const height = width * image.naturalHeight / image.naturalWidth;
      instructions.push({kind: 'image', image, x: (WIDTH - width) / 2, y, width, height});
      y += height + 12;
      if (entry.caption) addText(entry.caption, 16, '#66767c', 22);
    });
    for (const option of snapshot.options) {
      const start = y;
      y += 15;
      const instructionIndex = instructions.length;
      addText(`${option.key}.  ${option.text}`, 23, '#1c292e', 15, WIDTH - PADDING * 2 - 32, PADDING + 16);
      instructions.splice(instructionIndex, 0, {kind: 'box', x: PADDING, y: start, width: WIDTH - PADDING * 2, height: y - start});
      y += 12;
    }
    const height = Math.ceil(y + PADDING - 12);
    const scale = Math.min(2, 16000 / height);
    if (scale < 1) throw new Error('题目内容过长，无法生成清晰图片。');
    canvas.width = Math.ceil(WIDTH * scale);
    canvas.height = Math.ceil(height * scale);
    context.scale(scale, scale);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, WIDTH, height);
    context.textBaseline = 'top';
    for (const instruction of instructions) {
      if (instruction.kind === 'image') {
        context.drawImage(instruction.image, instruction.x, instruction.y, instruction.width, instruction.height);
      } else if (instruction.kind === 'box') {
        context.strokeStyle = '#d8e0e3';
        context.lineWidth = 1;
        context.strokeRect(instruction.x, instruction.y, instruction.width, instruction.height);
      } else {
        context.font = `${instruction.size}px ${FONT}`;
        context.fillStyle = instruction.color;
        instruction.lines.forEach((line, index) => context.fillText(line, instruction.x, instruction.y + index * instruction.lineHeight));
      }
    }
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('题目图片生成失败，请重试。'));
    }, 'image/png'));
  }

  async function copy(snapshot) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('当前浏览器不支持图片复制，请用新版 Edge 或 Chrome 打开本站。');
    }
    const image = render(snapshot);
    image.catch(() => {});
    // 点击时立即申请写入，图片在加载配图后完成，避免丢失用户操作权限。
    await navigator.clipboard.write([new ClipboardItem({'image/png': image})]);
  }

  window.PATHOLOGY_QUESTION_IMAGE = {capture, render, copy};
})();

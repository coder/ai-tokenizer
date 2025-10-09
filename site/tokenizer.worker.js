import Tokenizer from 'ai-tokenizer';

let currentTokenizer = null;
let currentEncoding = null;

// OffscreenCanvas rendering state
let offscreenCanvas = null;
let ctx = null;
let tokens = [];
let tokenLayouts = new Map();
let scrollTop = 0;
let maxScroll = 0;
let hoveredTokenIndex = -1;
let renderingEnabled = true; // Toggle for debugging

// Rendering config
const fontSize = 16;
const lineHeight = 1.6;
const lineGap = 2; // Vertical gap between lines (matches horizontal spacing)
const padding = 16;
const tokenPadding = 4;
const borderRadius = 4;
const colors = [
  '#3b82f6', '#8b5cf6', '#ec4899', '#fb923c', '#22c55e',
  '#0ea5e9', '#a855f7', '#eab308', '#ef4444', '#14b8a6'
];

let viewportWidth = 0;
let viewportHeight = 0;
let isMobile = false;
let maxRenderTokens = 1000;

// Load encoding dynamically
async function loadEncoding(encodingType) {
  if (currentEncoding === encodingType && currentTokenizer) {
    return;
  }

  let encodingModule;
  switch (encodingType) {
    case 'cl100k_base':
      encodingModule = await import('ai-tokenizer/encoding/cl100k_base');
      break;
    case 'o200k_base':
      encodingModule = await import('ai-tokenizer/encoding/o200k_base');
      break;
    case 'p50k_base':
      encodingModule = await import('ai-tokenizer/encoding/p50k_base');
      break;
    case 'claude':
      encodingModule = await import('ai-tokenizer/encoding/claude');
      break;
    default:
      throw new Error(`Unknown encoding: ${encodingType}`);
  }

  // Construct encoding object from named exports
  const encoding = {
    name: encodingModule.name,
    pat_str: encodingModule.pat_str,
    special_tokens: encodingModule.special_tokens,
    stringEncoder: encodingModule.stringEncoder,
    binaryEncoder: encodingModule.binaryEncoder,
    decoder: encodingModule.decoder
  };

  currentTokenizer = new Tokenizer(encoding);
  currentEncoding = encodingType;
}

self.onmessage = async function(e) {
  const { type, text, encodingType, canvas, width, height, scroll, mouseX, mouseY } = e.data;

  try {
    if (type === 'init-canvas') {
      offscreenCanvas = canvas;
      ctx = offscreenCanvas.getContext('2d', { alpha: false });
      viewportWidth = width;
      viewportHeight = height;
      isMobile = e.data.isMobile || false;
      // Reduce render limit on mobile for better performance
      maxRenderTokens = isMobile ? 500 : 1000;
      // Use lower DPR on mobile for better performance
      const dpr = e.data.dpr || 2;
      offscreenCanvas.width = width * dpr;
      offscreenCanvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      ctx.font = `${fontSize}px 'SF Mono', Monaco, monospace`;
      self.postMessage({ type: 'canvas-ready' });
    } else if (type === 'resize') {
      viewportWidth = width;
      viewportHeight = height;
      isMobile = e.data.isMobile || false;
      // Reduce render limit on mobile for better performance
      maxRenderTokens = isMobile ? 500 : 1000;
      // Use lower DPR on mobile for better performance
      const dpr = e.data.dpr || 2;
      offscreenCanvas.width = width * dpr;
      offscreenCanvas.height = height * dpr;
      ctx.scale(dpr, dpr);
      ctx.font = `${fontSize}px 'SF Mono', Monaco, monospace`;
      tokenLayouts.clear(); // Recalculate layouts
      estimateTotalHeight();
      render();
    } else if (type === 'load') {
      await loadEncoding(encodingType);
      self.postMessage({ type: 'loaded', encodingType });
    } else if (type === 'tokenize') {
      if (!currentTokenizer) {
        throw new Error('Tokenizer not loaded');
      }

      const startTime = performance.now();
      tokens = currentTokenizer.encode(text);
      const encodeTime = performance.now() - startTime;

      // Reset render state
      tokenLayouts.clear();
      scrollTop = 0;
      
      if (ctx && renderingEnabled) {
        estimateTotalHeight();
        render();
      }

      self.postMessage({
        type: 'tokens',
        count: tokens.length,
        encodeTime
      });
      
      // Log performance stats
      if (tokens.length > 100000) {
        console.log(`Worker: ${tokens.length} tokens encoded, rendering ${renderingEnabled ? 'enabled' : 'DISABLED'}`);
      }
    } else if (type === 'scroll') {
      scrollTop = Math.max(0, Math.min(maxScroll, scroll));
      render();
    } else if (type === 'mousemove') {
      const y = mouseY + scrollTop;
      const oldHovered = hoveredTokenIndex;
      hoveredTokenIndex = getTokenAt(mouseX, y);
      
      if (hoveredTokenIndex !== oldHovered) {
        render();
        if (hoveredTokenIndex !== -1) {
          self.postMessage({
            type: 'hover',
            tokenId: tokens[hoveredTokenIndex],
            x: mouseX,
            y: mouseY
          });
        } else {
          self.postMessage({ type: 'hover', tokenId: null });
        }
      }
    } else if (type === 'toggle-render') {
      renderingEnabled = e.data.enabled;
      console.log(`Worker: Rendering ${renderingEnabled ? 'enabled' : 'DISABLED'}`);
      if (renderingEnabled) {
        render(); // Re-render if enabling
      }
    } else if (type === 'clear') {
      tokens = [];
      tokenLayouts.clear();
      scrollTop = 0;
      maxScroll = 0;
      hoveredTokenIndex = -1;
      if (ctx) {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, viewportWidth, viewportHeight);
      }
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error.message
    });
  }
};

function estimateTotalHeight() {
  const avgTokenWidth = 60;
  const lineHeightPx = fontSize * lineHeight;
  const maxWidth = viewportWidth - padding * 2;
  const tokensPerLine = Math.floor(maxWidth / avgTokenWidth);
  const estimatedLines = Math.ceil(tokens.length / tokensPerLine);
  maxScroll = Math.max(0, estimatedLines * lineHeightPx - viewportHeight + padding);
}

function getTokenLayout(index) {
  if (tokenLayouts.has(index)) {
    return tokenLayouts.get(index);
  }

  const lineHeightPx = fontSize * lineHeight;
  
  // Find the last cached layout before this index
  let startIndex = 0;
  let x = padding;
  let y = padding;
  
  for (let i = index; i >= 0; i--) {
    if (tokenLayouts.has(i)) {
      const layout = tokenLayouts.get(i);
      startIndex = i + 1;
      x = layout.x + layout.width + 2;
      y = layout.y;
      break;
    }
  }

  // Calculate layouts from startIndex to index
  for (let i = startIndex; i <= index; i++) {
    const tokenId = tokens[i];
    const text = currentTokenizer.decode([tokenId]);
    const metrics = ctx.measureText(text);
    const width = metrics.width + tokenPadding * 2;
    const height = lineHeightPx;

    if (x + width > viewportWidth - padding && x > padding) {
      x = padding;
      y += lineHeightPx + lineGap;
    }

    const layout = { x, y, width, height };
    tokenLayouts.set(i, layout);

    if (i === index) {
      return layout;
    }

    x += width + 2;
  }
}

function getTokenAt(x, y) {
  for (let i = 0; i < tokens.length; i++) {
    const layout = tokenLayouts.get(i);
    if (!layout) continue;

    if (x >= layout.x && x <= layout.x + layout.width &&
        y >= layout.y && y <= layout.y + layout.height) {
      return i;
    }
  }
  return -1;
}

function render() {
  if (!ctx || !renderingEnabled) return;

  // Clear
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, viewportWidth, viewportHeight);

  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + viewportHeight;

  let rendered = 0;
  for (let i = 0; i < tokens.length && rendered < maxRenderTokens; i++) {
    const layout = getTokenLayout(i);
    if (!layout) continue;

    const { x, y, width, height } = layout;

    if (y + height < visibleTop) continue;
    if (y > visibleBottom) break;

    rendered++;

    const renderY = y - scrollTop;
    const color = colors[i % colors.length];
    const tokenId = tokens[i];
    const text = currentTokenizer.decode([tokenId]);

    // Background
    ctx.fillStyle = color + '4D';
    roundRect(ctx, x, renderY, width, height, borderRadius);
    ctx.fill();

    // Hover highlight
    if (i === hoveredTokenIndex) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      roundRect(ctx, x, renderY, width, height, borderRadius);
      ctx.stroke();
    }

    // Text
    ctx.fillStyle = '#e5e5e5';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + tokenPadding, renderY + height / 2);
  }

  // Scrollbar
  if (maxScroll > 0) {
    const scrollbarWidth = 8;
    const scrollbarHeight = (viewportHeight / (maxScroll + viewportHeight)) * viewportHeight;
    const scrollbarY = (scrollTop / maxScroll) * (viewportHeight - scrollbarHeight);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    roundRect(ctx, viewportWidth - scrollbarWidth - 4, scrollbarY, scrollbarWidth, scrollbarHeight, 4);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}


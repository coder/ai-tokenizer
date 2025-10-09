/**
 * Manages OffscreenCanvas rendering via worker
 */
export class OffscreenCanvasManager {
  constructor(container, worker) {
    this.container = container;
    this.worker = worker;
    
    this.canvas = document.createElement('canvas');
    this.container.appendChild(this.canvas);
    
    this.tooltipEl = null;
    this.setupCanvas();
    this.setupEventListeners();
  }
  
  setupCanvas() {
    const rect = this.container.getBoundingClientRect();
    // Use lower DPR on mobile for better performance
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth < 768;
    const dpr = isMobile ? Math.min(window.devicePixelRatio || 1, 1.5) : Math.min(window.devicePixelRatio || 1, 2);
    
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;
    
    // Transfer canvas control to worker
    const offscreen = this.canvas.transferControlToOffscreen();
    this.worker.postMessage({
      type: 'init-canvas',
      canvas: offscreen,
      width: rect.width,
      height: rect.height,
      dpr: dpr,
      isMobile: isMobile
    }, [offscreen]);
  }
  
  setupEventListeners() {
    // Resize (debounced)
    let resizeTimeout;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        const rect = this.container.getBoundingClientRect();
        // Use lower DPR on mobile for better performance
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth < 768;
        const dpr = isMobile ? Math.min(window.devicePixelRatio || 1, 1.5) : Math.min(window.devicePixelRatio || 1, 2);
        
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;
        
        this.viewportWidth = rect.width;
        this.viewportHeight = rect.height;
        
        this.worker.postMessage({
          type: 'resize',
          width: rect.width,
          height: rect.height,
          dpr: dpr,
          isMobile: isMobile
        });
      }, 150); // Debounce resize events
    };
    window.addEventListener('resize', handleResize);
    
    // Scroll (accumulate deltas, throttled)
    this.scrollTop = 0;
    let scrollTimeout;
    let pendingScroll = null;
    
    const sendScroll = () => {
      if (!scrollTimeout) {
        this.worker.postMessage({
          type: 'scroll',
          scroll: this.scrollTop
        });
        
        scrollTimeout = setTimeout(() => {
          scrollTimeout = null;
          // Send final scroll position if there's a pending one
          if (pendingScroll !== null) {
            this.worker.postMessage({
              type: 'scroll',
              scroll: this.scrollTop
            });
            pendingScroll = null;
          }
        }, 16); // ~60fps
      } else {
        pendingScroll = this.scrollTop;
      }
    };
    
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scrollTop += e.deltaY;
      sendScroll();
    }, { passive: false });
    
    // Touch support for mobile
    let touchStartY = 0;
    let touchStartScrollTop = 0;
    
    this.canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchStartScrollTop = this.scrollTop;
      }
    }, { passive: true });
    
    this.canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        const touchY = e.touches[0].clientY;
        const deltaY = touchStartY - touchY;
        this.scrollTop = touchStartScrollTop + deltaY;
        sendScroll();
      }
    }, { passive: false });
    
    this.canvas.addEventListener('touchend', () => {
      touchStartY = 0;
      touchStartScrollTop = 0;
    }, { passive: true });
    
    // Mouse move for hover (throttled for performance)
    let mouseMoveTimeout;
    let lastMouseMove = 0;
    const throttleMs = 16; // ~60fps
    
    this.canvas.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - lastMouseMove < throttleMs) return;
      lastMouseMove = now;
      
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      this.worker.postMessage({
        type: 'mousemove',
        mouseX: x,
        mouseY: y
      });
    });
    
    this.canvas.addEventListener('mouseleave', () => {
      this.hideTooltip();
    });
    
    // Handle hover messages from worker
    this.worker.addEventListener('message', (e) => {
      if (e.data.type === 'hover') {
        if (e.data.tokenId !== null) {
          this.showTooltip(e.data.x, e.data.y, e.data.tokenId);
        } else {
          this.hideTooltip();
        }
      }
    });
  }
  
  showTooltip(x, y, tokenId) {
    if (!this.tooltipEl) {
      this.tooltipEl = document.createElement('div');
      this.tooltipEl.style.cssText = `
        position: fixed;
        background: #0a0a0a;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 12px;
        font-family: monospace;
        pointer-events: none;
        z-index: 1000;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        color: #e5e5e5;
      `;
      document.body.appendChild(this.tooltipEl);
    }
    
    const rect = this.canvas.getBoundingClientRect();
    this.tooltipEl.textContent = `ID: ${tokenId}`;
    this.tooltipEl.style.left = `${rect.left + x + 10}px`;
    this.tooltipEl.style.top = `${rect.top + y - 30}px`;
    this.tooltipEl.style.display = 'block';
  }
  
  hideTooltip() {
    if (this.tooltipEl) {
      this.tooltipEl.style.display = 'none';
    }
  }
  
  destroy() {
    if (this.tooltipEl) {
      document.body.removeChild(this.tooltipEl);
    }
    this.container.removeChild(this.canvas);
  }
}


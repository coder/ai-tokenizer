import { models } from 'ai-tokenizer';
import { OffscreenCanvasManager } from './offscreen-canvas-manager.js';

// State
let worker = null;
let currentEncoding = null;
let currentTokens = [];
let currentText = '';
let canvasManager = null;
let tokenizationInProgress = false;
let pendingTokenization = null;
let autoTokenizeEnabled = true;
let lastTokenizedText = '';

// DOM elements
const modelSelect = document.getElementById('model-select');
const inputText = document.getElementById('input-text');
const tokensOutput = document.getElementById('tokens-output');
const tokenCount = document.getElementById('token-count');
const charCount = document.getElementById('char-count');
const encodingName = document.getElementById('encoding-name');
const encodeTimeEl = document.getElementById('encode-time');
const timeStatEl = document.getElementById('time-stat');
const clearBtn = document.getElementById('clear-btn');
const tokenizeBtn = document.getElementById('tokenize-btn');
const renderToggle = document.getElementById('render-toggle');
const modelChips = document.querySelectorAll('.model-chip');

// Initialize Web Worker
function initWorker() {
  if (worker) {
    worker.terminate();
  }
  
  worker = new Worker(new URL('./tokenizer.worker.js', import.meta.url), {
    type: 'module'
  });
  
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (error) => {
    console.error('Worker error:', error);
    encodingName.textContent = 'Error';
  };
}

function handleWorkerMessage(e) {
  const { type, count, encodeTime, encodingType, error } = e.data;
  
  if (type === 'loaded') {
    encodingName.textContent = encodingType;
    currentEncoding = encodingType;
    
    // Setup canvas on first load
    if (!canvasManager) {
      setupCanvas();
    }
    
    // Re-tokenize if we have text (force tokenization on model change)
    if (inputText.value) {
      updateTokenization(true); // Force tokenization when encoding loads
    }
  } else if (type === 'canvas-ready') {
    // Canvas is ready for rendering
    console.log('OffscreenCanvas ready');
  } else if (type === 'tokens') {
    tokenizationInProgress = false;
    
    // Update token count
    tokenCount.textContent = count.toLocaleString();
    
    // Show encoding time
    if (encodeTime !== undefined) {
      timeStatEl.style.display = 'flex';
      encodeTimeEl.textContent = `${encodeTime.toFixed(1)}ms`;
      console.log(`Encoded in ${encodeTime.toFixed(2)}ms (rendered in worker)`);
    }
    
    // If there's a pending tokenization, run it now
    if (pendingTokenization) {
      const text = pendingTokenization;
      pendingTokenization = null;
      performTokenization(text);
    }
  } else if (type === 'error') {
    tokenizationInProgress = false;
    console.error('Tokenization error:', error);
    // Don't destroy the canvas - just show error in console and update count
    tokenCount.textContent = 'Error';
    alert('Tokenization error: ' + error);
  }
}

// Populate model dropdown
function populateModels() {
  const modelEntries = Object.entries(models);
  
  // Group models by provider
  const grouped = {};
  modelEntries.forEach(([key, model]) => {
    const [provider] = key.split('/');
    if (!grouped[provider]) {
      grouped[provider] = [];
    }
    grouped[provider].push({ key, model });
  });

  // Sort providers
  const sortedProviders = Object.keys(grouped).sort();

  // Add options
  sortedProviders.forEach(provider => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = provider.charAt(0).toUpperCase() + provider.slice(1);
    
    grouped[provider]
      .sort((a, b) => a.model.name.localeCompare(b.model.name))
      .forEach(({ key, model }) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = model.name;
        optgroup.appendChild(option);
      });
    
    modelSelect.appendChild(optgroup);
  });
}

// Setup canvas manager
function setupCanvas() {
  if (!canvasManager) {
    // Clear any existing content
    tokensOutput.innerHTML = '';
    tokensOutput.style.cssText = '';
    canvasManager = new OffscreenCanvasManager(tokensOutput, worker);
    console.log('Canvas initialized');
  }
}

// Handle model selection
function handleModelChange() {
  const modelKey = modelSelect.value;
  if (!modelKey) {
    currentEncoding = null;
    encodingName.textContent = '-';
    tokenCount.textContent = '0';
    return;
  }

  const model = models[modelKey];
  const encodingType = model.encoding;

  // Show loading state
  encodingName.textContent = 'Loading...';
  tokenCount.textContent = '-';
  
  // Load encoding in worker if not already loaded
  if (currentEncoding !== encodingType) {
    worker.postMessage({
      type: 'load',
      encodingType
    });
    // Don't set currentEncoding yet - wait for 'loaded' message
  } else {
    // Same encoding, just re-tokenize with current encoding
    encodingName.textContent = encodingType;
    if (inputText.value) {
      updateTokenization(true); // Force re-tokenization on model switch
    }
  }
}

// Perform tokenization (skips if already in progress or text unchanged)
function performTokenization(text, force = false) {
  // Skip if text hasn't changed (unless forced)
  if (!force && text === lastTokenizedText) {
    return;
  }
  
  if (tokenizationInProgress) {
    // Queue this tokenization for after the current one finishes
    pendingTokenization = text;
    return;
  }
  
  tokenizationInProgress = true;
  tokenCount.textContent = '-';
  lastTokenizedText = text;
  
  // Send to worker for tokenization
  worker.postMessage({
    type: 'tokenize',
    text,
    encodingType: currentEncoding
  });
}

// Update tokenization output
function updateTokenization(force = false) {
  const text = inputText.value;
  currentText = text;
  charCount.textContent = text.length.toLocaleString();

  if (!currentEncoding || !text) {
    tokenCount.textContent = '0';
    timeStatEl.style.display = 'none';
    tokenizationInProgress = false;
    pendingTokenization = null;
    lastTokenizedText = '';
    return;
  }

  // Only tokenize if auto-tokenize is enabled or forced
  if (autoTokenizeEnabled || force) {
    performTokenization(text, force);
  } else {
    // Show that auto-tokenize is disabled
    if (text !== lastTokenizedText) {
      tokenCount.textContent = 'Ready';
    }
  }
}

// Smart debounce - longer wait for large inputs
function smartDebounce(func) {
  let timeout;
  return function executedFunction(...args) {
    const text = inputText.value;
    // Use longer debounce for large texts (reduces re-tokenization)
    // Auto-disable for very large inputs
    const wait = text.length > 500000 ? 3000 : 
                 text.length > 100000 ? 2000 : 
                 text.length > 10000 ? 500 : 
                 text.length > 1000 ? 300 : 150;
    
    // Suggest disabling auto-tokenize for very large inputs
    if (text.length > 500000 && autoTokenizeEnabled) {
      console.warn(`Large input detected (${text.length} chars). Consider disabling auto-tokenize.`);
    }
    
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}


// Event listeners
modelSelect.addEventListener('change', handleModelChange);

// Use smart debounce for typing, but immediate tokenization on paste
let lastInputWasPaste = false;
inputText.addEventListener('paste', () => {
  lastInputWasPaste = true;
  setTimeout(() => {
    updateTokenization();
    lastInputWasPaste = false;
  }, 10);
});

const debouncedTokenize = smartDebounce(updateTokenization);

// Throttle char count updates for performance with large text
let lastCharCountUpdate = 0;
let charCountTimeout;

inputText.addEventListener('input', (e) => {
  const now = performance.now();
  const length = inputText.value.length;
  
  // Throttle char count updates (update max every 100ms for typing, immediate for paste)
  if (now - lastCharCountUpdate > 100 || lastInputWasPaste) {
    charCount.textContent = length.toLocaleString();
    lastCharCountUpdate = now;
  } else {
    // Queue an update
    clearTimeout(charCountTimeout);
    charCountTimeout = setTimeout(() => {
      charCount.textContent = inputText.value.length.toLocaleString();
    }, 100);
  }
  
  // Show/hide tokenize button for large inputs
  if (length > 500000) {
    tokenizeBtn.style.display = 'inline-block';
    autoTokenizeEnabled = false;
    if (!lastInputWasPaste) {
      tokenCount.textContent = 'Ready';
      return;
    }
  } else {
    tokenizeBtn.style.display = 'none';
    autoTokenizeEnabled = true;
  }
  
  // Skip debounced tokenization if this was a paste event
  if (!lastInputWasPaste) {
    debouncedTokenize();
  }
});

clearBtn.addEventListener('click', () => {
  inputText.value = '';
  currentTokens = [];
  pendingTokenization = null;
  tokenCount.textContent = '0';
  charCount.textContent = '0';
  timeStatEl.style.display = 'none';
  
  // Clear canvas in worker
  if (worker) {
    worker.postMessage({ type: 'clear' });
  }
});

tokenizeBtn.addEventListener('click', () => {
  pendingTokenization = null; // Cancel any pending
  updateTokenization(true); // Force tokenization
});

// Model chips
modelChips.forEach(chip => {
  chip.addEventListener('click', () => {
    const modelKey = chip.dataset.model;
    modelSelect.value = modelKey;
    
    // Update active state
    modelChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    
    handleModelChange();
  });
});

renderToggle.addEventListener('change', (e) => {
  const enabled = e.target.checked;
  console.log(`Rendering ${enabled ? 'enabled' : 'DISABLED'} - this will help identify performance bottleneck`);
  
  // Toggle rendering in worker
  worker.postMessage({
    type: 'toggle-render',
    enabled
  });
  
  // Hide/show canvas
  if (canvasManager) {
    canvasManager.canvas.style.display = enabled ? 'block' : 'none';
  }
});

// Update model chip active state when dropdown changes
modelSelect.addEventListener('change', () => {
  const selectedModel = modelSelect.value;
  modelChips.forEach(chip => {
    if (chip.dataset.model === selectedModel) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
});

// Initialize
initWorker();
populateModels();
// Don't setup canvas until a model is selected

// Set a default model and example text
const defaultModel = 'openai/gpt-5';
if (models[defaultModel]) {
  // Set example text first
  inputText.value = `Hello! This is the AI Tokenizer demo.

Try selecting different models to see how tokenization differs.

Features:
- 70+ AI models supported
- Real-time tokenization
- Canvas-based rendering
- Handles millions of tokens

Performance optimizations:
- Web Worker for tokenization
- OffscreenCanvas rendering
- Virtual scrolling
- Smart debouncing

This tokenizer is 5-7x faster than tiktoken and has >95% accuracy for most models.`;
  
  // Select model and update UI
  modelSelect.value = defaultModel;
  modelChips.forEach(chip => {
    if (chip.dataset.model === defaultModel) {
      chip.classList.add('active');
    }
  });
  handleModelChange();
}


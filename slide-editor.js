(() => {
  const bodyEl = document.body;
  const container = document.getElementById('searchContainer');
  const searchInput = document.getElementById('searchInput');
  const stageHost = document.getElementById('slideStage');
  const slideCanvas = stageHost ? stageHost.closest('.slide-canvas') : null;
  const thumbsEl = document.getElementById('slideThumbs');
  const zoomPill = document.getElementById('slideZoomPill');
  const statusLabel = document.getElementById('slideStatusLabel');
  const metaLabel = document.getElementById('slideMetaLabel');
  const selectionLabel = document.getElementById('slideSelectionLabel');
  const imageInput = document.getElementById('slideImageInput');
  const videoInput = document.getElementById('slideVideoInput');
  const fileInput = document.getElementById('slideFileInput');
  const toolButtons = Array.from(document.querySelectorAll('[data-tool]'));
  const shapeToolButton = document.querySelector('[data-tool="shape"]');
  const lineToolButton = document.querySelector('[data-tool="line"]');
  const actionButtons = Array.from(document.querySelectorAll('[data-action]'));
  const zoomButtons = Array.from(document.querySelectorAll('[data-zoom]'));
  const textPanel = document.getElementById('slideTextPanel');
  const shapePanel = document.getElementById('slideShapePanel');
  const commonPanel = document.getElementById('slideCommonPanel');
  const mediaPanel = document.getElementById('slideMediaPanel');
  const propFont = document.getElementById('propFont');
  const propFontSize = document.getElementById('propFontSize');
  const propFill = document.getElementById('propFill');
  const propAlign = document.getElementById('propAlign');
  const propShapeFill = document.getElementById('propShapeFill');
  const propStroke = document.getElementById('propStroke');
  const propStrokeWidth = document.getElementById('propStrokeWidth');
  const propOpacity = document.getElementById('propOpacity');
  const propAnimType = document.getElementById('propAnimType');
  const propAnimDuration = document.getElementById('propAnimDuration');
  const propAnimDelay = document.getElementById('propAnimDelay');
  const propAnimOrder = document.getElementById('propAnimOrder');
  const propAnimPreview = document.getElementById('propAnimPreview');
  const propVideoAction = document.getElementById('propVideoAction');
  const propVideoSound = document.getElementById('propVideoSound');
  const propVideoLoop = document.getElementById('propVideoLoop');

  if (!container || !stageHost || !thumbsEl || !slideCanvas) return;

  window.slideEditorState = window.slideEditorState || { hasContent: false };

  const SLIDE_WIDTH = 1280;
  const SLIDE_HEIGHT = 720;
  const MIN_SIZE = 20;
  const MIN_TEXT_SIZE = 12;
  const SNAP_THRESHOLD = 8;
  const NUDGE_STEP = 10;
  const NUDGE_FINE_STEP = 1;
  const FILE_SIZE_LIMIT = 20 * 1024 * 1024;
  const SEED_TEXT_WIDTH = 920;
  const SEED_TEXT_MARGIN = 120;
  const MIRROR_SEARCH_INPUT_TO_SLIDES = false;
  const DEFAULT_NODE_ANIMATION = Object.freeze({
    type: 'none',
    duration: 0.6,
    delay: 0,
    order: 0,
    videoAction: 'none',
    videoSound: 'mute',
    videoLoop: true
  });
  const NODE_ANIMATION_TYPES = new Set(['none', 'fade', 'zoom', 'from-left', 'from-right', 'from-top', 'from-bottom', 'draw-arrow']);
  const NODE_ANIMATION_OFFSET = 84;
  const SHAPE_KIND_LABELS = Object.freeze({
    rect: 'Shape',
    ellipse: 'Shape'
  });
  const LINE_KIND_LABELS = Object.freeze({
    line: 'Line',
    arrow: 'Arrow',
    curve: 'Curve',
    'curved-arrow': 'Curved Arrow'
  });
  const VIDEO_ANIMATION_ACTIONS = new Set(['none', 'play', 'pause', 'restart']);
  const VIDEO_SOUND_MODES = new Set(['mute', 'sound']);
  const EQUATION_FONT_STACK = '"Cambria Math","STIX Two Math","Times New Roman",serif';
  const EQUATION_SHORTCUTS = Object.freeze({
    alpha: '\u03B1',
    beta: '\u03B2',
    gamma: '\u03B3',
    delta: '\u03B4',
    epsilon: '\u03B5',
    theta: '\u03B8',
    lambda: '\u03BB',
    mu: '\u03BC',
    pi: '\u03C0',
    sigma: '\u03C3',
    phi: '\u03C6',
    omega: '\u03C9',
    Gamma: '\u0393',
    Delta: '\u0394',
    Theta: '\u0398',
    Lambda: '\u039B',
    Pi: '\u03A0',
    Sigma: '\u03A3',
    Phi: '\u03A6',
    Omega: '\u03A9',
    neq: '\u2260',
    leq: '\u2264',
    geq: '\u2265',
    approx: '\u2248',
    times: '\u00D7',
    div: '\u00F7',
    pm: '\u00B1',
    mp: '\u2213',
    cdot: '\u00B7',
    sum: '\u2211',
    prod: '\u220F',
    int: '\u222B',
    sqrt: '\u221A',
    infty: '\u221E',
    partial: '\u2202',
    forall: '\u2200',
    exists: '\u2203',
    in: '\u2208',
    notin: '\u2209',
    subset: '\u2282',
    subseteq: '\u2286',
    supset: '\u2283',
    supseteq: '\u2287',
    cup: '\u222A',
    cap: '\u2229',
    rightarrow: '\u2192',
    leftarrow: '\u2190',
    leftrightarrow: '\u2194',
    Rightarrow: '\u21D2',
    Leftarrow: '\u21D0',
    Leftrightarrow: '\u21D4'
  });
  const EQUATION_ASCII_REPLACEMENTS = Object.freeze([
    ['<=>', '\u21D4'],
    ['<->', '\u2194'],
    ['=>', '\u21D2'],
    ['<=', '\u2264'],
    ['>=', '\u2265'],
    ['!=', '\u2260'],
    ['->', '\u2192'],
    ['<-', '\u2190']
  ]);
  const SUPERSCRIPT_MAP = Object.freeze({
    '0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074', '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079',
    '+': '\u207A', '-': '\u207B', '=': '\u207C', '(': '\u207D', ')': '\u207E',
    a: '\u1D43', b: '\u1D47', c: '\u1D9C', d: '\u1D48', e: '\u1D49', f: '\u1DA0', g: '\u1D4D', h: '\u02B0', i: '\u2071', j: '\u02B2', k: '\u1D4F', l: '\u02E1',
    m: '\u1D50', n: '\u207F', o: '\u1D52', p: '\u1D56', r: '\u02B3', s: '\u02E2', t: '\u1D57', u: '\u1D58', v: '\u1D5B', w: '\u02B7', x: '\u02E3', y: '\u02B8', z: '\u1DBB'
  });
  const SUBSCRIPT_MAP = Object.freeze({
    '0': '\u2080', '1': '\u2081', '2': '\u2082', '3': '\u2083', '4': '\u2084', '5': '\u2085', '6': '\u2086', '7': '\u2087', '8': '\u2088', '9': '\u2089',
    '+': '\u208A', '-': '\u208B', '=': '\u208C', '(': '\u208D', ')': '\u208E',
    a: '\u2090', e: '\u2091', h: '\u2095', i: '\u1D62', j: '\u2C7C', k: '\u2096', l: '\u2097', m: '\u2098', n: '\u2099', o: '\u2092', p: '\u209A', r: '\u1D63',
    s: '\u209B', t: '\u209C', u: '\u1D64', v: '\u1D65', x: '\u2093'
  });
  const EQUATION_SYMBOL_GROUPS = Object.freeze([
    {
      key: 'greek',
      label: 'Greek',
      symbols: [
        { text: '\u03B1', insert: '\\alpha ' }, { text: '\u03B2', insert: '\\beta ' }, { text: '\u03B3', insert: '\\gamma ' },
        { text: '\u0394', insert: '\\Delta ' }, { text: '\u03BB', insert: '\\lambda ' }, { text: '\u03C0', insert: '\\pi ' },
        { text: '\u03C3', insert: '\\sigma ' }, { text: '\u03C6', insert: '\\phi ' }
      ]
    },
    {
      key: 'operators',
      label: 'Operators',
      symbols: [
        { text: '\u2211', insert: '\\sum ' }, { text: '\u220F', insert: '\\prod ' }, { text: '\u222B', insert: '\\int ' },
        { text: '\u221A', insert: '\\sqrt ' }, { text: '\u221E', insert: '\\infty ' }, { text: '\u2202', insert: '\\partial ' },
        { text: '\u00D7', insert: '\\times ' }, { text: '\u00F7', insert: '\\div ' }
      ]
    },
    {
      key: 'relations',
      label: 'Relations',
      symbols: [
        { text: '=', insert: '=' }, { text: '\u2260', insert: '\\neq ' }, { text: '\u2264', insert: '\\leq ' },
        { text: '\u2265', insert: '\\geq ' }, { text: '\u2248', insert: '\\approx ' }, { text: '\u2208', insert: '\\in ' },
        { text: '\u2282', insert: '\\subset ' }, { text: '\u2286', insert: '\\subseteq ' }
      ]
    },
    {
      key: 'arrows',
      label: 'Arrows',
      symbols: [
        { text: '\u2192', insert: '\\rightarrow ' }, { text: '\u2190', insert: '\\leftarrow ' },
        { text: '\u2194', insert: '\\leftrightarrow ' }, { text: '\u21D2', insert: '\\Rightarrow ' },
        { text: '\u21D0', insert: '\\Leftarrow ' }, { text: '\u21D4', insert: '\\Leftrightarrow ' }
      ]
    }
  ]);
  const EDITOR_DB_NAME = 'ivucxSlideEditorDB';
  const EDITOR_DB_VERSION = 1;
  const EDITOR_DB_STORE = 'editorStates';
  const EDITOR_DB_KEY = 'latest';
  const DEFAULT_ANCHORS = ['top-left','top-center','top-right','middle-left','middle-right','bottom-left','bottom-center','bottom-right'];
  const DANGEROUS_FILE_EXTENSIONS = new Set([
    'ade','adp','apk','app','bat','chm','cmd','com','cpl','dll','dmg','exe','hta','ins','iso',
    'jar','js','jse','lib','lnk','mde','msc','msi','msp','mst','ps1','reg','scr','sct','sh',
    'sys','vb','vbe','vbs','vxd','wsc','wsf','wsh'
  ]);
  const SUPPORTED_FILE_EXTENSIONS = new Set([
    'pdf','txt','md','markdown','json','csv','png','jpg','jpeg','gif','webp'
  ]);

  let stage = null;
  let uiLayer = null;
  let transformer = null;
  let currentLayer = null;
  let currentSlideIndex = 0;
  let currentTool = 'select';
  let currentShapeKind = 'rect';
  let currentLineKind = 'line';
  let zoom = 1;
  let fitScale = 1;
  let selectedNode = null;
  let selectedNodes = [];
  let slides = [];
  let isInitialized = false;
  let isEditorActive = false;
  let lineDraft = null;
  let lineStart = null;
  let lineCurvePoints = [];
  let thumbTimer = null;
  let videoAnimation = null;
  let activeTextEditor = null;
  let activeTextNode = null;
  let activeEquationPopover = null;
  let activeEquationGroup = EQUATION_SYMBOL_GROUPS[0].key;
  let contextMenuEl = null;
  let clipboardNode = null;
  let clipboardNodes = [];
  let guideLines = [];
  let docViewer = null;
  let docTitleEl = null;
  let docTypeEl = null;
  let docScrollEl = null;
  let docDownloadBtn = null;
  let docNavPopup = null;
  let docPrevSlideBtn = null;
  let docNextSlideBtn = null;
  let docNavLabel = null;
  let isPresentationMode = false;
  let objectAnimationTweens = [];
  let presentationAnimationQueue = [];
  let presentationAnimationIndex = 0;
  let selectionMarquee = null;
  let selectionMarqueeStart = null;
  let sessionSeedText = '';
  let sessionBaselineDigest = '';
  let persistTimer = null;
  let persistDbPromise = null;
  let isApplyingPersistedState = false;
  let hasCompletedPersistenceBootstrap = false;

  function hasKonva(){
    return typeof window.Konva !== 'undefined';
  }

  function normalizeLineKind(kind, fallback = 'line'){
    return Object.prototype.hasOwnProperty.call(LINE_KIND_LABELS, kind) ? kind : fallback;
  }

  function normalizeShapeKind(kind, fallback = 'rect'){
    return Object.prototype.hasOwnProperty.call(SHAPE_KIND_LABELS, kind) ? kind : fallback;
  }

  function getShapeKindLabel(kind){
    const normalized = normalizeShapeKind(kind);
    return normalized === 'ellipse' ? 'Ellipse' : 'Rect';
  }

  function getLineKindLabel(kind){
    return LINE_KIND_LABELS[normalizeLineKind(kind)];
  }

  function isCurvedLineKind(kind){
    const normalized = normalizeLineKind(kind);
    return normalized === 'curve' || normalized === 'curved-arrow';
  }

  function isArrowLineKind(kind){
    const normalized = normalizeLineKind(kind);
    return normalized === 'arrow' || normalized === 'curved-arrow';
  }

  function isLineLikeNode(node){
    return !!node && (node.className === 'Line' || node.className === 'Arrow');
  }

  function getNodeLineKind(node){
    if (!isLineLikeNode(node)) return 'line';
    const fallback = node.className === 'Arrow' ? 'arrow' : 'line';
    return normalizeLineKind(node.getAttr ? node.getAttr('lineKind') : '', fallback);
  }

  function getNodeDisplayLabel(node){
    if (!node) return '';
    if (node.className === 'Text' && node.getAttr && node.getAttr('isEquation')){
      return 'Equation';
    }
    if (isVideoNode(node)){
      return 'Video';
    }
    if (node.getAttr && node.getAttr('assetType') === 'image'){
      return 'Image';
    }
    if (node.className === 'Rect' || node.className === 'Ellipse'){
      return 'Shape';
    }
    if (isLineLikeNode(node)){
      return getLineKindLabel(getNodeLineKind(node));
    }
    return node.className || 'Object';
  }

  function updateShapeToolButton(){
    if (!shapeToolButton) return;
    shapeToolButton.textContent = `${getShapeKindLabel(currentShapeKind)}...`;
    shapeToolButton.title = 'Choose rectangle or ellipse.';
  }

  function openShapeToolMenu(){
    if (!shapeToolButton || shapeToolButton.disabled) return;
    const rect = shapeToolButton.getBoundingClientRect();
    showContextMenu([
      {
        label: `${currentShapeKind === 'rect' ? '* ' : ''}${getShapeKindLabel('rect')}`,
        action: () => {
          currentShapeKind = 'rect';
          updateShapeToolButton();
          setTool('shape');
        }
      },
      {
        label: `${currentShapeKind === 'ellipse' ? '* ' : ''}${getShapeKindLabel('ellipse')}`,
        action: () => {
          currentShapeKind = 'ellipse';
          updateShapeToolButton();
          setTool('shape');
        }
      }
    ], rect.left, rect.bottom + 8);
  }

  function updateLineToolButton(){
    if (!lineToolButton) return;
    lineToolButton.textContent = `${getLineKindLabel(currentLineKind)}...`;
    lineToolButton.title = 'Choose line, arrow, curve, or curved arrow. For curves, click to add bends and double-click or press Enter to finish.';
  }

  function openLineToolMenu(){
    if (!lineToolButton || lineToolButton.disabled) return;
    const rect = lineToolButton.getBoundingClientRect();
    showContextMenu([
      {
        label: `${currentLineKind === 'line' ? '* ' : ''}${getLineKindLabel('line')}`,
        action: () => {
          currentLineKind = 'line';
          updateLineToolButton();
          setTool('line');
        }
      },
      {
        label: `${currentLineKind === 'arrow' ? '* ' : ''}${getLineKindLabel('arrow')}`,
        action: () => {
          currentLineKind = 'arrow';
          updateLineToolButton();
          setTool('line');
        }
      },
      {
        label: `${currentLineKind === 'curve' ? '* ' : ''}${getLineKindLabel('curve')} (click bends)`,
        action: () => {
          currentLineKind = 'curve';
          updateLineToolButton();
          setTool('line');
        }
      },
      {
        label: `${currentLineKind === 'curved-arrow' ? '* ' : ''}${getLineKindLabel('curved-arrow')} (click bends)`,
        action: () => {
          currentLineKind = 'curved-arrow';
          updateLineToolButton();
          setTool('line');
        }
      }
    ], rect.left, rect.bottom + 8);
  }

  function buildLinePointsForKind(kind, start, end){
    return [start.x, start.y, end.x, end.y];
  }

  function isVideoNode(node){
    return !!(node && node.getAttr && node.getAttr('assetType') === 'video');
  }

  function getNodeVideoElement(node){
    if (!isVideoNode(node) || !node.image) return null;
    const media = node.image();
    return media instanceof HTMLVideoElement ? media : null;
  }

  function applyVideoNodeSettings(node, config = getNodeAnimationConfig(node)){
    const video = getNodeVideoElement(node);
    if (!video) return null;
    video.muted = config.videoSound !== 'sound';
    video.defaultMuted = video.muted;
    video.loop = !!config.videoLoop;
    video.playsInline = true;
    return video;
  }

  function hasQueuedMediaCue(node, config = getNodeAnimationConfig(node)){
    return isVideoNode(node) && config.videoAction !== 'none';
  }

  function getEquationSource(node){
    if (!node || !node.getAttr) return '';
    return String(node.getAttr('equationSource') || node.text() || '');
  }

  function mapEquationToken(token, mapping){
    let output = '';
    for (const char of String(token || '')){
      const mapped = mapping[char] || mapping[char.toLowerCase()];
      if (!mapped) return '';
      output += mapped;
    }
    return output;
  }

  function applyEquationScripts(text){
    let result = '';
    for (let index = 0; index < text.length; index += 1){
      const marker = text[index];
      if ((marker === '^' || marker === '_') && index + 1 < text.length){
        let token = text[index + 1];
        let endIndex = index + 2;
        if (token === '{'){
          const closingIndex = text.indexOf('}', index + 2);
          if (closingIndex !== -1){
            token = text.slice(index + 2, closingIndex);
            endIndex = closingIndex + 1;
          }
        }
        const mapped = mapEquationToken(token, marker === '^' ? SUPERSCRIPT_MAP : SUBSCRIPT_MAP);
        if (mapped){
          result += mapped;
          index = endIndex - 1;
          continue;
        }
      }
      result += marker;
    }
    return result;
  }

  function renderEquationSource(source){
    let text = String(source || '');
    EQUATION_ASCII_REPLACEMENTS.forEach(([pattern, replacement]) => {
      text = text.split(pattern).join(replacement);
    });
    text = text.replace(/\\([A-Za-z]+)\b/g, (match, symbolName) => EQUATION_SHORTCUTS[symbolName] || match);
    return applyEquationScripts(text);
  }

  function insertIntoTextarea(textarea, snippet){
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.setRangeText(snippet, start, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
  }

  function positionEquationPopover(){
    if (!activeEquationPopover || !activeTextEditor) return;
    const editorRect = activeTextEditor.getBoundingClientRect();
    const popover = activeEquationPopover;
    const measuredHeight = popover.offsetHeight || 180;
    const aboveTop = editorRect.top - measuredHeight - 12;
    const top = aboveTop > 12
      ? aboveTop
      : Math.min(window.innerHeight - measuredHeight - 12, editorRect.bottom + 12);
    const left = Math.max(12, Math.min(editorRect.left, window.innerWidth - (popover.offsetWidth || 420) - 12));
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(12, top)}px`;
  }

  function destroyEquationPopover(){
    if (!activeEquationPopover) return;
    if (activeEquationPopover.parentNode){
      activeEquationPopover.parentNode.removeChild(activeEquationPopover);
    }
    activeEquationPopover = null;
  }

  function renderEquationPopoverSymbols(popover, textarea, groupKey){
    if (!popover) return;
    const symbolsEl = popover.querySelector('.slide-equation-symbols');
    const buttons = popover.querySelectorAll('[data-equation-group]');
    buttons.forEach(button => {
      button.classList.toggle('is-active', button.getAttribute('data-equation-group') === groupKey);
    });
    if (!symbolsEl) return;
    symbolsEl.innerHTML = '';
    const group = EQUATION_SYMBOL_GROUPS.find(item => item.key === groupKey) || EQUATION_SYMBOL_GROUPS[0];
    activeEquationGroup = group.key;
    group.symbols.forEach(symbol => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slide-equation-symbol';
      button.textContent = symbol.text;
      button.title = symbol.insert.trim();
      button.addEventListener('click', () => insertIntoTextarea(textarea, symbol.insert));
      symbolsEl.appendChild(button);
    });
  }

  function createEquationPopover(textarea){
    destroyEquationPopover();
    const popover = document.createElement('div');
    popover.className = 'slide-equation-popover is-active';
    popover.innerHTML = `
      <div class="slide-equation-topbar">
        <div class="slide-equation-title">Equation Toolbar</div>
      </div>
      <div class="slide-equation-group"></div>
      <div class="slide-equation-symbols"></div>
      <div class="slide-equation-hint">Google Docs-like shortcuts are supported here: try \\alpha, \\sum, x^2, x_i, or the symbol chips above.</div>
    `;
    popover.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    const groupEl = popover.querySelector('.slide-equation-group');
    EQUATION_SYMBOL_GROUPS.forEach(group => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = group.label;
      button.setAttribute('data-equation-group', group.key);
      button.addEventListener('click', () => renderEquationPopoverSymbols(popover, textarea, group.key));
      groupEl.appendChild(button);
    });
    document.body.appendChild(popover);
    activeEquationPopover = popover;
    renderEquationPopoverSymbols(popover, textarea, activeEquationGroup);
    positionEquationPopover();
  }

  function openEditorPersistenceDb(){
    if (!window.indexedDB) return Promise.resolve(null);
    if (persistDbPromise) return persistDbPromise;

    persistDbPromise = new Promise(resolve => {
      const request = window.indexedDB.open(EDITOR_DB_NAME, EDITOR_DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EDITOR_DB_STORE)){
          db.createObjectStore(EDITOR_DB_STORE);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });

    return persistDbPromise;
  }

  async function readPersistedEditorRecord(){
    const db = await openEditorPersistenceDb();
    if (!db) return null;

    return new Promise(resolve => {
      const tx = db.transaction(EDITOR_DB_STORE, 'readonly');
      const store = tx.objectStore(EDITOR_DB_STORE);
      const request = store.get(EDITOR_DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async function writePersistedEditorRecord(payload){
    const db = await openEditorPersistenceDb();
    if (!db) return false;

    return new Promise(resolve => {
      const tx = db.transaction(EDITOR_DB_STORE, 'readwrite');
      const store = tx.objectStore(EDITOR_DB_STORE);
      store.put(payload, EDITOR_DB_KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }

  function isEditingText(){
    return !!activeTextEditor;
  }

  function closeActiveTextEditor(commit){
    if (!activeTextEditor || !activeTextNode) return;
    const textarea = activeTextEditor;
    const textNode = activeTextNode;
    if (commit){
      if (textNode.getAttr && textNode.getAttr('isEquation')){
        textNode.setAttr('equationSource', textarea.value);
        textNode.text(renderEquationSource(textarea.value));
      } else {
        textNode.text(textarea.value);
      }
    }
    if (textarea.parentNode){
      textarea.parentNode.removeChild(textarea);
    }
    destroyEquationPopover();
    textNode.show();
    transformer.show();
    uiLayer.draw();
    currentLayer.draw();
    refreshHasContent();
    scheduleThumbUpdate();
    activeTextEditor = null;
    activeTextNode = null;
  }

  function positionTextEditor(){
    if (!activeTextEditor || !activeTextNode || !stage) return;
    const stageBox = stage.container().getBoundingClientRect();
    const absPos = activeTextNode.getAbsolutePosition();
    const absScale = activeTextNode.getAbsoluteScale();
    const rotation = typeof activeTextNode.getAbsoluteRotation === 'function'
      ? activeTextNode.getAbsoluteRotation()
      : activeTextNode.rotation();
    const baseHeight = Math.max(
      activeTextNode.height(),
      activeTextNode.fontSize() * activeTextNode.lineHeight()
    );

    activeTextEditor.style.left = `${stageBox.left + absPos.x}px`;
    activeTextEditor.style.top = `${stageBox.top + absPos.y}px`;
    activeTextEditor.style.width = `${activeTextNode.width() * absScale.x}px`;
    activeTextEditor.style.fontSize = `${activeTextNode.fontSize() * absScale.y}px`;
    activeTextEditor.style.transform = rotation ? `rotate(${rotation}deg)` : '';
    const minHeight = baseHeight * absScale.y;
    activeTextEditor.style.height = 'auto';
    activeTextEditor.style.height = `${Math.max(minHeight, activeTextEditor.scrollHeight)}px`;
    positionEquationPopover();
  }

  function getContentNodes(layer = currentLayer){
    if (!layer) return [];
    return layer.getChildren(node => !node.getAttr('isBackground'));
  }

  function normalizeLayerOrdering(layer = currentLayer){
    if (!layer) return;
    const backgroundNode = getBackgroundNode(layer);
    if (backgroundNode){
      backgroundNode.moveToBottom();
    }
    getContentNodes(layer).forEach(node => node.moveToTop());
  }

  function centerNodeOnSlide(node, layer = currentLayer){
    if (!node || !layer) return;
    const frameRect = getSlideFrameRect(layer);
    const box = node.getClientRect({ relativeTo: layer });
    node.position({
      x: node.x() + (frameRect.x + frameRect.width / 2 - (box.x + box.width / 2)),
      y: node.y() + (frameRect.y + frameRect.height / 2 - (box.y + box.height / 2))
    });
  }

  function fitSeedTextNode(node){
    if (!node) return;
    node.width(Math.min(SEED_TEXT_WIDTH, SLIDE_WIDTH - SEED_TEXT_MARGIN * 2));
    node.align('center');
    node.fontSize(38);
    while (node.height() > SLIDE_HEIGHT - SEED_TEXT_MARGIN * 2 && node.fontSize() > 18){
      node.fontSize(node.fontSize() - 2);
    }
  }

  function createSeedTextNode(text){
    const fontFamily = searchInput
      ? window.getComputedStyle(searchInput).fontFamily
      : 'Arial';
    const node = new Konva.Text({
      x: SEED_TEXT_MARGIN,
      y: SEED_TEXT_MARGIN,
      text,
      fontSize: 38,
      fontFamily,
      fill: '#111111',
      width: Math.min(SEED_TEXT_WIDTH, SLIDE_WIDTH - SEED_TEXT_MARGIN * 2),
      draggable: true,
      align: 'center',
      lineHeight: 1.3
    });
    node.setAttr('seedSource', true);
    fitSeedTextNode(node);
    return node;
  }

  function syncSeedTextFromInput(){
    if (!MIRROR_SEARCH_INPUT_TO_SLIDES) return;
    if (!slides[0] || !searchInput) return;

    const layer = slides[0].layer;
    const text = searchInput.value.trim();
    const nodes = getContentNodes(layer);
    const seedNode = nodes.find(node => node.getAttr && node.getAttr('seedSource'));
    const hasOtherContent = nodes.some(node => !node.getAttr('seedSource'));

    if (!text){
      if (seedNode && !hasOtherContent){
        seedNode.destroy();
        if (currentLayer === layer){
          if (selectedNode === seedNode){
            selectNode(null);
          }
          currentLayer.batchDraw();
          refreshHasContent();
          scheduleThumbUpdate();
        }
      }
      return;
    }

    if (hasOtherContent && !seedNode) return;

    if (seedNode && !hasOtherContent){
      seedNode.text(text);
      fitSeedTextNode(seedNode);
      centerNodeOnSlide(seedNode, layer);
      if (currentLayer === layer){
        currentLayer.batchDraw();
        refreshHasContent();
        if (selectedNode === seedNode){
          updateInspector(seedNode);
        }
        scheduleThumbUpdate();
      }
      return;
    }

    if (!seedNode && nodes.length === 0){
      const node = createSeedTextNode(text);
      addNode(node, currentLayer === layer ? false : true, layer);
      centerNodeOnSlide(node, layer);
      if (currentLayer === layer){
        currentLayer.batchDraw();
        selectNode(node);
        scheduleThumbUpdate();
      }
    }
  }

  function roundMetric(value){
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.round(numeric * 100) / 100;
  }

  function normalizeNodeAnimationConfig(rawConfig){
    const type = rawConfig && NODE_ANIMATION_TYPES.has(rawConfig.type)
      ? rawConfig.type
      : (rawConfig && NODE_ANIMATION_TYPES.has(rawConfig.animType) ? rawConfig.animType : DEFAULT_NODE_ANIMATION.type);
    const durationValue = Number(rawConfig && (rawConfig.duration ?? rawConfig.animDuration));
    const delayValue = Number(rawConfig && (rawConfig.delay ?? rawConfig.animDelay));
    const orderValue = Number(rawConfig && (rawConfig.order ?? rawConfig.animOrder));
    const videoAction = rawConfig && VIDEO_ANIMATION_ACTIONS.has(rawConfig.videoAction)
      ? rawConfig.videoAction
      : (rawConfig && VIDEO_ANIMATION_ACTIONS.has(rawConfig.animVideoAction) ? rawConfig.animVideoAction : 'none');
    const videoSound = rawConfig && VIDEO_SOUND_MODES.has(rawConfig.videoSound)
      ? rawConfig.videoSound
      : (rawConfig && VIDEO_SOUND_MODES.has(rawConfig.animVideoSound) ? rawConfig.animVideoSound : 'mute');
    const videoLoopValue = rawConfig && (rawConfig.videoLoop ?? rawConfig.animVideoLoop);
    const needsOrder = type !== 'none' || videoAction !== 'none';
    return {
      type,
      duration: Number.isFinite(durationValue) ? Math.max(0.1, Math.min(8, roundMetric(durationValue))) : DEFAULT_NODE_ANIMATION.duration,
      delay: Number.isFinite(delayValue) ? Math.max(0, Math.min(8, roundMetric(delayValue))) : DEFAULT_NODE_ANIMATION.delay,
      order: !needsOrder
        ? 0
        : (Number.isFinite(orderValue) ? Math.max(1, Math.min(99, Math.round(orderValue))) : 1),
      videoAction,
      videoSound,
      videoLoop: typeof videoLoopValue === 'boolean'
        ? videoLoopValue
        : !(String(videoLoopValue).toLowerCase() === 'false' || String(videoLoopValue) === '0')
    };
  }

  function getNodeAnimationConfig(node){
    if (!node || !node.getAttr) return { ...DEFAULT_NODE_ANIMATION };
    return normalizeNodeAnimationConfig({
      type: node.getAttr('animType'),
      duration: node.getAttr('animDuration'),
      delay: node.getAttr('animDelay'),
      order: node.getAttr('animOrder'),
      videoAction: node.getAttr('animVideoAction'),
      videoSound: node.getAttr('animVideoSound'),
      videoLoop: node.getAttr('animVideoLoop')
    });
  }

  function setNodeAnimationConfig(node, config){
    if (!node || !node.setAttr) return { ...DEFAULT_NODE_ANIMATION };
    const normalized = normalizeNodeAnimationConfig(config);
    node.setAttr('animType', normalized.type);
    node.setAttr('animDuration', normalized.duration);
    node.setAttr('animDelay', normalized.delay);
    node.setAttr('animOrder', normalized.order);
    node.setAttr('animVideoAction', normalized.videoAction);
    node.setAttr('animVideoSound', normalized.videoSound);
    node.setAttr('animVideoLoop', normalized.videoLoop);
    return normalized;
  }

  function getNodeAnimationLabel(type){
    switch (type){
      case 'fade':
        return 'Fade In';
      case 'zoom':
        return 'Zoom In';
      case 'from-left':
        return 'From Left';
      case 'from-right':
        return 'From Right';
      case 'from-top':
        return 'From Top';
      case 'from-bottom':
        return 'From Bottom';
      case 'draw-arrow':
        return 'Draw From Tail';
      default:
        return 'None';
    }
  }

  function serializeDocumentData(documentData){
    if (!documentData) return null;
    return {
      title: documentData.title || '',
      kind: documentData.kind || '',
      ext: documentData.ext || '',
      mime: documentData.mime || '',
      size: Number(documentData.size) || 0,
      checked: !!documentData.checked,
      url: documentData.url || '',
      text: documentData.text || ''
    };
  }

  function serializeNode(node){
    if (!node) return null;
    const common = {
      className: node.className || '',
      x: roundMetric(node.x ? node.x() : 0),
      y: roundMetric(node.y ? node.y() : 0),
      rotation: roundMetric(node.rotation ? node.rotation() : 0),
      opacity: roundMetric(node.opacity ? node.opacity() : 1),
      seedSource: !!(node.getAttr && node.getAttr('seedSource')),
      assetType: node.getAttr ? (node.getAttr('assetType') || '') : '',
      assetSrc: node.getAttr ? (node.getAttr('assetSrc') || '') : '',
      animation: getNodeAnimationConfig(node)
    };

    if (node.className === 'Text'){
      return {
        ...common,
        text: node.text(),
        width: roundMetric(node.width()),
        fontSize: roundMetric(node.fontSize()),
        fontFamily: node.fontFamily() || '',
        fill: node.fill() || '',
        align: node.align ? (node.align() || 'left') : 'left',
        lineHeight: roundMetric(node.lineHeight ? node.lineHeight() : 1.2),
        isEquation: !!(node.getAttr && node.getAttr('isEquation')),
        equationSource: node.getAttr ? (node.getAttr('equationSource') || '') : ''
      };
    }

    if (node.className === 'Rect' || node.className === 'Image'){
      return {
        ...common,
        width: roundMetric(node.width()),
        height: roundMetric(node.height()),
        fill: node.fill ? (node.fill() || '') : '',
        stroke: node.stroke ? (node.stroke() || '') : '',
        strokeWidth: roundMetric(node.strokeWidth ? node.strokeWidth() : 0),
        cornerRadius: roundMetric(node.cornerRadius ? node.cornerRadius() : 0)
      };
    }

    if (node.className === 'Ellipse'){
      const radius = node.radius ? node.radius() : { x: 0, y: 0 };
      return {
        ...common,
        radiusX: roundMetric(radius.x),
        radiusY: roundMetric(radius.y),
        fill: node.fill ? (node.fill() || '') : '',
        stroke: node.stroke ? (node.stroke() || '') : '',
        strokeWidth: roundMetric(node.strokeWidth ? node.strokeWidth() : 0)
      };
    }

    if (isLineLikeNode(node)){
      return {
        ...common,
        lineKind: getNodeLineKind(node),
        points: (node.points ? node.points() : []).map(point => roundMetric(point)),
        stroke: node.stroke ? (node.stroke() || '') : '',
        strokeWidth: roundMetric(node.strokeWidth ? node.strokeWidth() : 0),
        fill: node.fill ? (node.fill() || '') : '',
        bezier: !!(node.bezier && node.bezier()),
        tension: roundMetric(node.tension ? node.tension() : 0),
        pointerLength: roundMetric(node.pointerLength ? node.pointerLength() : 0),
        pointerWidth: roundMetric(node.pointerWidth ? node.pointerWidth() : 0)
      };
    }

    return common;
  }

  function serializeEditorState(){
    return {
      inputText: searchInput ? searchInput.value : '',
      slides: slides.map(slide => {
        if (slide.type === 'document'){
          return {
            type: 'document',
            document: serializeDocumentData(slide.document)
          };
        }
        return {
          type: 'canvas',
          nodes: getContentNodes(slide.layer).map(serializeNode)
        };
      })
    };
  }

  function getEditorStateDigest(){
    return JSON.stringify(serializeEditorState());
  }

  function buildPersistedEditorRecord(){
    return {
      savedAt: new Date().toISOString(),
      currentSlideIndex,
      zoom,
      editorState: serializeEditorState()
    };
  }

  async function persistEditorStateNow(){
    if (isApplyingPersistedState || !hasCompletedPersistenceBootstrap) return false;
    return writePersistedEditorRecord(buildPersistedEditorRecord());
  }

  function schedulePersistentSave(){
    if (isApplyingPersistedState || !hasCompletedPersistenceBootstrap) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistEditorStateNow();
    }, 320);
  }

  function dispatchSearchInputSync(){
    if (!searchInput) return;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function createRectNodeFromSnapshot(data){
    return new Konva.Rect({
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      width: Math.max(MIN_SIZE, Number(data.width) || MIN_SIZE),
      height: Math.max(MIN_SIZE, Number(data.height) || MIN_SIZE),
      fill: data.fill || '#ffffff',
      stroke: data.stroke || '',
      strokeWidth: Number(data.strokeWidth) || 0,
      cornerRadius: Number(data.cornerRadius) || 0,
      opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
      rotation: Number(data.rotation) || 0,
      strokeScaleEnabled: false
    });
  }

  function createEllipseNodeFromSnapshot(data){
    return new Konva.Ellipse({
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      radius: {
        x: Math.max(MIN_SIZE / 2, Number(data.radiusX) || MIN_SIZE / 2),
        y: Math.max(MIN_SIZE / 2, Number(data.radiusY) || MIN_SIZE / 2)
      },
      fill: data.fill || '#ffffff',
      stroke: data.stroke || '',
      strokeWidth: Number(data.strokeWidth) || 0,
      opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
      rotation: Number(data.rotation) || 0,
      strokeScaleEnabled: false
    });
  }

  function createLineNodeFromSnapshot(data){
    const kind = normalizeLineKind(data.lineKind, data.className === 'Arrow' ? 'arrow' : 'line');
    return createLineNode(
      0,
      0,
      120,
      0,
      kind,
      {
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        points: Array.isArray(data.points) ? data.points.map(point => Number(point) || 0) : undefined,
        stroke: data.stroke || '#111111',
        fill: data.fill || data.stroke || '#111111',
        strokeWidth: Number(data.strokeWidth) || 2,
        bezier: !!data.bezier,
        tension: Number.isFinite(Number(data.tension)) ? Number(data.tension) : undefined,
        pointerLength: Number(data.pointerLength) || 18,
        pointerWidth: Number(data.pointerWidth) || 18,
        opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
        rotation: Number(data.rotation) || 0
      }
    );
  }

  function createTextNodeFromSnapshot(data){
    const isEquation = !!data.isEquation;
    const equationSource = typeof data.equationSource === 'string' ? data.equationSource : '';
    const node = new Konva.Text({
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      text: isEquation ? renderEquationSource(equationSource) : (typeof data.text === 'string' ? data.text : ''),
      width: Math.max(MIN_SIZE, Number(data.width) || 420),
      fontSize: Math.max(MIN_TEXT_SIZE, Number(data.fontSize) || 32),
      fontFamily: isEquation ? EQUATION_FONT_STACK : (data.fontFamily || 'Arial'),
      fill: data.fill || '#111111',
      align: data.align || 'left',
      lineHeight: Number(data.lineHeight) || 1.2,
      opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
      rotation: Number(data.rotation) || 0,
      draggable: true
    });
    if (data.seedSource){
      node.setAttr('seedSource', true);
    }
    if (isEquation){
      node.setAttr('isEquation', true);
      node.setAttr('equationSource', equationSource || data.text || '');
    }
    return node;
  }

  function loadImageElement(src){
    return new Promise(resolve => {
      if (!src){
        resolve(null);
        return;
      }
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = src;
    });
  }

  function loadVideoElement(src){
    return new Promise(resolve => {
      if (!src){
        resolve(null);
        return;
      }
      const video = document.createElement('video');
      video.src = src;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.addEventListener('loadeddata', () => resolve(video), { once: true });
      video.addEventListener('error', () => resolve(null), { once: true });
    });
  }

  async function createImageNodeFromSnapshot(data){
    const media = data.assetType === 'video'
      ? await loadVideoElement(data.assetSrc)
      : await loadImageElement(data.assetSrc);
    if (!media) return null;

    const node = new Konva.Image({
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      image: media,
      width: Math.max(MIN_SIZE, Number(data.width) || MIN_SIZE),
      height: Math.max(MIN_SIZE, Number(data.height) || MIN_SIZE),
      opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
      rotation: Number(data.rotation) || 0,
      stroke: data.stroke || '',
      strokeWidth: Number(data.strokeWidth) || 0,
      cornerRadius: Number(data.cornerRadius) || 0,
      strokeScaleEnabled: false
    });
    if (data.assetType){
      node.setAttr('assetType', data.assetType);
    }
    if (data.assetSrc){
      node.setAttr('assetSrc', data.assetSrc);
    }
    applyVideoNodeSettings(node, data.animation || {});
    return node;
  }

  async function createNodeFromSnapshot(data){
    if (!data || typeof data !== 'object') return null;
    let node = null;
    switch (data.className){
      case 'Text':
        node = createTextNodeFromSnapshot(data);
        break;
      case 'Rect':
        node = createRectNodeFromSnapshot(data);
        break;
      case 'Ellipse':
        node = createEllipseNodeFromSnapshot(data);
        break;
      case 'Line':
      case 'Arrow':
        node = createLineNodeFromSnapshot(data);
        break;
      case 'Image':
        node = await createImageNodeFromSnapshot(data);
        break;
      default:
        node = null;
    }
    if (node){
      setNodeAnimationConfig(node, data.animation);
    }
    return node;
  }

  function clearAllSlides(){
    hideContextMenu();
    clearGuideLines();
    hideSelectionMarquee();
    if (isEditingText()){
      closeActiveTextEditor(false);
    }
    if (selectedNode){
      selectNode(null);
    }
    stopVideoAnimation();
    hideDocumentSlide();
    slides.forEach(destroySlide);
    slides = [];
    currentLayer = null;
    currentSlideIndex = 0;
    clipboardNode = null;
    clipboardNodes = [];
  }

  async function applyPersistedEditorRecord(record){
    if (!record || !record.editorState) return false;
    const persistedState = record.editorState;
    if (!persistedState || !Array.isArray(persistedState.slides)) return false;

    isApplyingPersistedState = true;
    try{
      clearAllSlides();

      if (searchInput){
        searchInput.value = typeof persistedState.inputText === 'string' ? persistedState.inputText : '';
        dispatchSearchInputSync();
      }

      if (persistedState.slides.length === 0){
        createSlide();
      } else {
        for (const persistedSlide of persistedState.slides){
          if (persistedSlide && persistedSlide.type === 'document'){
            createSlide('document', persistedSlide.document ? { ...persistedSlide.document } : null);
            continue;
          }

          createSlide();
          const layer = slides[slides.length - 1].layer;
          const nodes = Array.isArray(persistedSlide && persistedSlide.nodes) ? persistedSlide.nodes : [];
          for (const nodeData of nodes){
            const node = await createNodeFromSnapshot(nodeData);
            if (node){
              addNode(node, true, layer);
            }
          }
        }
      }

      renderThumbs();

      if (typeof record.zoom === 'number'){
        zoom = Math.max(0.5, Math.min(2, record.zoom));
      }

      const safeIndex = Math.max(0, Math.min(slides.length - 1, Number(record.currentSlideIndex) || 0));
      showSlide(safeIndex, { syncSeedFromInput: false });
      updateZoomPill();
      refreshHasContent();
      syncVideoAnimation();
      scheduleThumbUpdate();
      if (isEditorActive){
        startEditorSession();
      }
      return true;
    } finally {
      isApplyingPersistedState = false;
    }
  }

  async function restorePersistedEditorState(){
    const record = await readPersistedEditorRecord();
    if (!record) return false;
    return applyPersistedEditorRecord(record);
  }

  function startEditorSession(){
    sessionSeedText = searchInput ? searchInput.value : '';
    sessionBaselineDigest = getEditorStateDigest();
  }

  function clearEditorSession(){
    sessionSeedText = '';
    sessionBaselineDigest = '';
  }

  function hasPendingEditorChanges(){
    if (!sessionBaselineDigest) return false;
    return getEditorStateDigest() !== sessionBaselineDigest;
  }

  function destroySlide(slide){
    if (!slide || slide.type !== 'canvas' || !slide.layer) return;
    slide.layer.destroy();
  }

  function seedFirstSlideFromText(seedText){
    if (!slides[0] || slides[0].type !== 'canvas') return;
    const text = typeof seedText === 'string' ? seedText.trim() : '';
    if (!text) return;
    const layer = slides[0].layer;
    const node = createSeedTextNode(text);
    addNode(node, currentLayer === layer ? false : true, layer);
    centerNodeOnSlide(node, layer);
    if (currentLayer === layer){
      currentLayer.batchDraw();
      scheduleThumbUpdate();
    }
  }

  function resetSlidesToSeedState(seedText, options = {}){
    const updateInput = options.updateInput !== false;
    hideContextMenu();
    clearGuideLines();

    if (isEditingText()){
      closeActiveTextEditor(false);
    }

    if (selectedNode){
      selectNode(null);
    }

    stopVideoAnimation();
    hideDocumentSlide();

    slides.forEach(destroySlide);
    slides = [];
    currentLayer = null;
    currentSlideIndex = 0;
    clipboardNode = null;
    clipboardNodes = [];

    const normalizedSeedText = typeof seedText === 'string' ? seedText : '';

    if (searchInput && updateInput){
      searchInput.value = normalizedSeedText;
    }

    createSlide();
    showSlide(0, { syncSeedFromInput: updateInput });
    if (updateInput){
      syncSeedTextFromInput();
    } else {
      seedFirstSlideFromText(normalizedSeedText);
    }
    renderThumbs();
    refreshHasContent();
    scheduleThumbUpdate();
  }

  function preserveEditorStateInBackground(){
    hideContextMenu();
    clearGuideLines();
    if (isEditingText()){
      closeActiveTextEditor(true);
    }
    refreshHasContent();
    scheduleThumbUpdate();
    persistEditorStateNow();
    return true;
  }

  function discardEditorState(){
    if (!isInitialized || !stage){
      clearEditorSession();
      return true;
    }
    if (searchInput){
      searchInput.value = '';
      dispatchSearchInputSync();
    }
    resetSlidesToSeedState('', { updateInput: false });
    clearEditorSession();
    persistEditorStateNow();
    return true;
  }

  function requestCloseEditor(){
    if (!isEditorActive && !sessionBaselineDigest) return false;
    if (typeof window.dispatchEvent === 'function'){
      window.dispatchEvent(new CustomEvent('slide-editor:close-requested'));
      return true;
    }
    if (typeof window.closeSlideEditorMode === 'function'){
      window.closeSlideEditorMode();
      return true;
    }
    return false;
  }

  window.slideEditorControls = {
    preserveInBackground: preserveEditorStateInBackground,
    discardEditorState,
    canCycleOutByScrollDirection(deltaY){
      if (!slides.length) return false;
      if (deltaY < 0){
        return currentSlideIndex === 0;
      }
      if (deltaY > 0){
        return currentSlideIndex === slides.length - 1;
      }
      return false;
    },
    requestClose: requestCloseEditor,
    hasPendingChanges: hasPendingEditorChanges
  };

  function resolveSelectableNode(target){
    if (!target || target === stage) return null;
    if (target === transformer || target.getParent && target.getParent() === transformer){
      return selectedNode;
    }
    if (target.getAttr && target.getAttr('isBackground')){
      return null;
    }
    return target;
  }

  function getSelectedNodes(){
    return selectedNodes.slice();
  }

  function hasMultipleSelection(){
    return selectedNodes.length > 1;
  }

  function isNodeSelected(node){
    return !!node && selectedNodes.includes(node);
  }

  function getSelectionBounds(nodes = selectedNodes){
    if (!currentLayer || !nodes.length) return null;
    const boxes = nodes
      .map(node => node.getClientRect({ relativeTo: currentLayer }))
      .filter(box => box && Number.isFinite(box.width) && Number.isFinite(box.height));
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map(box => box.x));
    const top = Math.min(...boxes.map(box => box.y));
    const right = Math.max(...boxes.map(box => box.x + box.width));
    const bottom = Math.max(...boxes.map(box => box.y + box.height));
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }

  function getBackgroundNode(layer = currentLayer){
    if (!layer) return null;
    return layer.getChildren(node => node.getAttr && node.getAttr('isBackground'))[0] || null;
  }

  function ensureSelectionMarquee(){
    if (selectionMarquee || !uiLayer || !hasKonva()) return selectionMarquee;
    selectionMarquee = new Konva.Rect({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fill: 'rgba(26,115,232,0.14)',
      stroke: '#1a73e8',
      strokeWidth: 1,
      dash: [6, 4],
      listening: false,
      visible: false
    });
    uiLayer.add(selectionMarquee);
    if (transformer) transformer.moveToTop();
    return selectionMarquee;
  }

  function hideSelectionMarquee(){
    selectionMarqueeStart = null;
    if (!selectionMarquee) return;
    selectionMarquee.visible(false);
    selectionMarquee.width(0);
    selectionMarquee.height(0);
    uiLayer.batchDraw();
  }

  function openBackgroundColorPicker(layer = currentLayer){
    const backgroundNode = getBackgroundNode(layer);
    if (!backgroundNode) return;
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = normalizeColor(backgroundNode.fill ? backgroundNode.fill() : '', '#ffffff');
    picker.style.position = 'fixed';
    picker.style.opacity = '0';
    picker.style.pointerEvents = 'none';
    picker.style.left = '-9999px';
    document.body.appendChild(picker);

    const cleanup = () => {
      picker.removeEventListener('input', applyColor);
      picker.removeEventListener('change', applyColor);
      if (picker.parentNode) picker.parentNode.removeChild(picker);
    };

    const applyColor = () => {
      backgroundNode.fill(picker.value);
      if (currentLayer === layer){
        currentLayer.batchDraw();
      }
      scheduleThumbUpdate();
      schedulePersistentSave();
    };

    picker.addEventListener('input', applyColor);
    picker.addEventListener('change', applyColor);
    picker.addEventListener('blur', cleanup, { once: true });
    picker.click();
  }

  function getAnimatedNodesInDisplayOrder(layer = currentLayer){
    if (!layer) return [];
    const nodes = getContentNodes(layer)
      .map((node, index) => ({
        node,
        index,
        config: getNodeAnimationConfig(node)
      }))
      .filter(entry => entry.config.type !== 'none' || hasQueuedMediaCue(entry.node, entry.config));

    nodes.sort((a, b) => {
      const aOrder = a.config.order > 0 ? a.config.order : 1000 + a.index;
      const bOrder = b.config.order > 0 ? b.config.order : 1000 + b.index;
      return aOrder - bOrder || a.index - b.index;
    });

    return nodes;
  }

  function getNextAnimationOrder(layer = currentLayer, excludeNode = null){
    const animated = getAnimatedNodesInDisplayOrder(layer)
      .filter(entry => entry.node !== excludeNode)
      .map(entry => entry.config.order)
      .filter(order => order > 0);
    return animated.length ? Math.min(99, Math.max(...animated) + 1) : 1;
  }

  function hideContextMenu(){
    if (!contextMenuEl) return;
    contextMenuEl.hidden = true;
    contextMenuEl.innerHTML = '';
  }

  function ensureContextMenu(){
    if (contextMenuEl) return contextMenuEl;

    const menu = document.createElement('div');
    menu.className = 'slide-context-menu';
    menu.hidden = true;
    document.body.appendChild(menu);

    document.addEventListener('pointerdown', (e) => {
      if (!contextMenuEl || contextMenuEl.hidden) return;
      if (contextMenuEl.contains(e.target)) return;
      hideContextMenu();
    }, true);

    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('resize', hideContextMenu);
    window.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){
        hideContextMenu();
      }
    });

    contextMenuEl = menu;
    return contextMenuEl;
  }

  function createContextMenuItem(def){
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slide-context-menu-item' + (def.danger ? ' is-danger' : '');
    button.textContent = def.label;
    button.addEventListener('click', () => {
      hideContextMenu();
      def.action();
    });
    return button;
  }

  function showContextMenu(items, clientX, clientY){
    if (!items.length){
      hideContextMenu();
      return;
    }
    const menu = ensureContextMenu();
    menu.innerHTML = '';
    items.forEach(item => menu.appendChild(createContextMenuItem(item)));
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';

    const rect = menu.getBoundingClientRect();
    const left = Math.max(12, Math.min(clientX, window.innerWidth - rect.width - 12));
    const top = Math.max(12, Math.min(clientY, window.innerHeight - rect.height - 12));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function clearGuideLines(){
    if (!guideLines.length) return;
    guideLines.forEach(line => line.destroy());
    guideLines = [];
    uiLayer.batchDraw();
  }

  function drawGuideLine(orientation, guide, box){
    if (!uiLayer) return;
    const frameRect = getSlideFrameRect(currentLayer);
    const guideValue = typeof guide.value === 'number' ? guide.value : guide;
    const isCenterGuide = guide && guide.kind === 'slide-center';
    const minBound = orientation === 'vertical' ? frameRect.y : frameRect.x;
    const maxBound = orientation === 'vertical'
      ? frameRect.y + frameRect.height
      : frameRect.x + frameRect.width;
    const start = orientation === 'vertical'
      ? Math.max(minBound, Math.min(maxBound, guide.start ?? minBound))
      : Math.max(minBound, Math.min(maxBound, guide.start ?? minBound));
    const end = orientation === 'vertical'
      ? Math.max(start, Math.min(maxBound, guide.end ?? maxBound))
      : Math.max(start, Math.min(maxBound, guide.end ?? maxBound));
    const points = orientation === 'vertical'
      ? [guideValue, start, guideValue, end]
      : [start, guideValue, end, guideValue];
    const line = new Konva.Line({
      points,
      stroke: isCenterGuide ? '#0b57d0' : '#1a73e8',
      strokeWidth: isCenterGuide ? 1.5 : 1,
      dash: isCenterGuide ? [10, 6] : [6, 4],
      opacity: isCenterGuide ? 0.95 : 0.82,
      listening: false
    });
    guideLines.push(line);
    uiLayer.add(line);
    transformer.moveToTop();
  }

  function getSlideFrameRect(layer = currentLayer){
    if (!layer) return {
      x: 0,
      y: 0,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT
    };

    const backgroundNode = layer.getChildren(node => node.getAttr && node.getAttr('isBackground'))[0];
    if (!backgroundNode){
      return {
        x: 0,
        y: 0,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT
      };
    }

    const box = backgroundNode.getClientRect({ relativeTo: layer });
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height
    };
  }

  function collectSnapGuides(node){
    const frameRect = getSlideFrameRect(currentLayer);
    const vertical = [
      { value: frameRect.x, start: frameRect.y, end: frameRect.y + frameRect.height, kind: 'slide-edge', priority: 8 },
      { value: frameRect.x + frameRect.width / 2, start: frameRect.y, end: frameRect.y + frameRect.height, kind: 'slide-center', priority: 0 },
      { value: frameRect.x + frameRect.width, start: frameRect.y, end: frameRect.y + frameRect.height, kind: 'slide-edge', priority: 8 }
    ];
    const horizontal = [
      { value: frameRect.y, start: frameRect.x, end: frameRect.x + frameRect.width, kind: 'slide-edge', priority: 8 },
      { value: frameRect.y + frameRect.height / 2, start: frameRect.x, end: frameRect.x + frameRect.width, kind: 'slide-center', priority: 0 },
      { value: frameRect.y + frameRect.height, start: frameRect.x, end: frameRect.x + frameRect.width, kind: 'slide-edge', priority: 8 }
    ];

    getContentNodes(currentLayer).forEach(otherNode => {
      if (otherNode === node) return;
      const box = otherNode.getClientRect({ relativeTo: currentLayer });
      vertical.push(
        { value: box.x, start: box.y, end: box.y + box.height, kind: 'object-edge', priority: 6 },
        { value: box.x + box.width / 2, start: box.y, end: box.y + box.height, kind: 'object-center', priority: 2 },
        { value: box.x + box.width, start: box.y, end: box.y + box.height, kind: 'object-edge', priority: 6 }
      );
      horizontal.push(
        { value: box.y, start: box.x, end: box.x + box.width, kind: 'object-edge', priority: 6 },
        { value: box.y + box.height / 2, start: box.x, end: box.x + box.width, kind: 'object-center', priority: 2 },
        { value: box.y + box.height, start: box.x, end: box.x + box.width, kind: 'object-edge', priority: 6 }
      );
    });

    return { vertical, horizontal };
  }

  function areGuidePairCompatible(candidate, guide){
    const candidateKind = candidate && candidate.kind ? candidate.kind : 'edge';
    const guideKind = guide && guide.kind ? guide.kind : 'object-edge';

    if (guideKind === 'slide-center' || guideKind === 'object-center'){
      return candidateKind === 'center';
    }

    if (guideKind === 'slide-edge' || guideKind === 'object-edge'){
      return candidateKind !== 'center';
    }

    return true;
  }

  function findBestGuide(candidates, guides){
    let best = null;
    candidates.forEach(candidate => {
      guides.forEach(guide => {
        if (!areGuidePairCompatible(candidate, guide)) return;
        const delta = guide.value - candidate.value;
        if (Math.abs(delta) > SNAP_THRESHOLD) return;
        const score = (Math.abs(delta) * 100)
          + (candidate.priority || 0)
          + (guide.priority || 0);
        if (!best || score < best.score){
          best = {
            delta,
            guide,
            score
          };
        }
      });
    });
    return best;
  }

  function applySnapGuides(node){
    if (!node || !currentLayer) return;

    clearGuideLines();

    const box = node.getClientRect({ relativeTo: currentLayer });
    const guides = collectSnapGuides(node);
    const verticalMatch = findBestGuide([
      { value: box.x, priority: 6, kind: 'edge-start' },
      { value: box.x + box.width / 2, priority: 0, kind: 'center' },
      { value: box.x + box.width, priority: 6, kind: 'edge-end' }
    ], guides.vertical);
    const horizontalMatch = findBestGuide([
      { value: box.y, priority: 6, kind: 'edge-start' },
      { value: box.y + box.height / 2, priority: 0, kind: 'center' },
      { value: box.y + box.height, priority: 6, kind: 'edge-end' }
    ], guides.horizontal);

    if (!verticalMatch && !horizontalMatch) return;

    node.position({
      x: node.x() + (verticalMatch ? verticalMatch.delta : 0),
      y: node.y() + (horizontalMatch ? horizontalMatch.delta : 0)
    });

    const snappedBox = node.getClientRect({ relativeTo: currentLayer });

    if (verticalMatch){
      drawGuideLine('vertical', verticalMatch.guide, snappedBox);
    }
    if (horizontalMatch){
      drawGuideLine('horizontal', horizontalMatch.guide, snappedBox);
    }

    currentLayer.batchDraw();
    uiLayer.batchDraw();
  }

  function getCurrentSlide(){
    return slides[currentSlideIndex] || null;
  }

  function isDocumentSlide(slide = getCurrentSlide()){
    return !!(slide && slide.type === 'document');
  }

  function updateZoomPill(){
    if (!zoomPill) return;
    zoomPill.textContent = isDocumentSlide() ? 'DOC' : `${Math.round(zoom * 100)}%`;
  }

  function ensureDocViewer(){
    if (docViewer) return docViewer;

    docViewer = document.createElement('div');
    docViewer.className = 'slide-doc-viewer';
    docViewer.addEventListener('pointerdown', () => {
      if (isPresentationMode && typeof slideCanvas.focus === 'function'){
        slideCanvas.focus();
      }
    });

    const shell = document.createElement('div');
    shell.className = 'slide-doc-shell';

    const header = document.createElement('div');
    header.className = 'slide-doc-header';

    const meta = document.createElement('div');
    meta.className = 'slide-doc-meta';

    docTitleEl = document.createElement('div');
    docTitleEl.className = 'slide-doc-title';

    docTypeEl = document.createElement('div');
    docTypeEl.className = 'slide-doc-type';

    meta.append(docTitleEl, docTypeEl);

    docDownloadBtn = document.createElement('button');
    docDownloadBtn.type = 'button';
    docDownloadBtn.className = 'slide-doc-download';
    docDownloadBtn.textContent = 'Download';
    docDownloadBtn.addEventListener('click', () => {
      const slide = getCurrentSlide();
      if (!slide || !slide.document) return;
      downloadDocumentFile(slide.document);
    });

    header.append(meta, docDownloadBtn);

    docScrollEl = document.createElement('div');
    docScrollEl.className = 'slide-doc-scroll';

    docNavPopup = document.createElement('div');
    docNavPopup.className = 'slide-doc-nav';

    docPrevSlideBtn = document.createElement('button');
    docPrevSlideBtn.type = 'button';
    docPrevSlideBtn.textContent = 'Prev';
    docPrevSlideBtn.addEventListener('click', () => moveSlide(-1));

    docNavLabel = document.createElement('div');
    docNavLabel.className = 'slide-doc-nav-label';

    docNextSlideBtn = document.createElement('button');
    docNextSlideBtn.type = 'button';
    docNextSlideBtn.textContent = 'Next';
    docNextSlideBtn.addEventListener('click', () => moveSlide(1));

    docNavPopup.append(docPrevSlideBtn, docNavLabel, docNextSlideBtn);

    shell.append(header, docScrollEl);
    docViewer.append(shell, docNavPopup);
    docViewer.addEventListener('contextmenu', (e) => {
      const slide = getCurrentSlide();
      if (!slide || slide.type !== 'document' || !slide.document) return;
      if (!isEditorActive || isPresentationMode) return;
      e.preventDefault();
      showContextMenu(getDocumentContextMenuItems(currentSlideIndex), e.clientX, e.clientY);
    });
    slideCanvas.appendChild(docViewer);
    return docViewer;
  }

  function downloadDocumentFile(fileInfo){
    if (!fileInfo) return;
    let objectUrl = '';
    const href = fileInfo.url || (
      fileInfo.kind === 'text'
        ? (objectUrl = URL.createObjectURL(new Blob([fileInfo.text || ''], { type: fileInfo.mime || 'text/plain;charset=utf-8' })))
        : ''
    );
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    link.download = fileInfo.title || 'document';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (objectUrl){
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }

  function getDocumentContextMenuItems(index){
    const slide = slides[index];
    if (!slide || slide.type !== 'document' || !slide.document){
      return [];
    }
    return [
      {
        label: 'Download file',
        action: () => downloadDocumentFile(slide.document)
      },
      {
        label: 'Delete slide',
        action: () => deleteSlideAt(index),
        danger: true
      }
    ];
  }

  function getFileExtension(name){
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function startsWithBytes(bytes, signature){
    if (!bytes || bytes.length < signature.length) return false;
    return signature.every((value, index) => bytes[index] === value);
  }

  async function readFileHeader(file, length = 16){
    const buffer = await file.slice(0, length).arrayBuffer();
    return new Uint8Array(buffer);
  }

  function getDocumentKind(file, ext){
    if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
    if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
    if (
      file.type.startsWith('text/') ||
      file.type === 'application/json' ||
      ['txt', 'md', 'markdown', 'json', 'csv'].includes(ext)
    ){
      return 'text';
    }
    return '';
  }

  async function validateFileSignature(file, kind, ext){
    if (kind === 'text') return { ok: true };

    const header = await readFileHeader(file, 16);

    if (kind === 'pdf'){
      return startsWithBytes(header, [0x25, 0x50, 0x44, 0x46, 0x2D])
        ? { ok: true }
        : { ok: false, message: 'PDF signature check failed.' };
    }

    if (kind === 'image'){
      if (ext === 'png'){
        return startsWithBytes(header, [0x89, 0x50, 0x4E, 0x47])
          ? { ok: true }
          : { ok: false, message: 'PNG signature check failed.' };
      }
      if (ext === 'jpg' || ext === 'jpeg'){
        return startsWithBytes(header, [0xFF, 0xD8, 0xFF])
          ? { ok: true }
          : { ok: false, message: 'JPEG signature check failed.' };
      }
      if (ext === 'gif'){
        return startsWithBytes(header, [0x47, 0x49, 0x46, 0x38])
          ? { ok: true }
          : { ok: false, message: 'GIF signature check failed.' };
      }
      if (ext === 'webp'){
        return startsWithBytes(header, [0x52, 0x49, 0x46, 0x46])
          ? { ok: true }
          : { ok: false, message: 'WEBP signature check failed.' };
      }
    }

    return { ok: true };
  }

  async function runFileSafetyChecks(file){
    if (!file) return { ok: false, message: 'No file selected.' };
    const ext = getFileExtension(file.name);
    if (file.size > FILE_SIZE_LIMIT){
      return { ok: false, message: 'Files larger than 20 MB are blocked.' };
    }
    if (DANGEROUS_FILE_EXTENSIONS.has(ext)){
      return { ok: false, message: 'Executable or script-like files are blocked.' };
    }
    if (!SUPPORTED_FILE_EXTENSIONS.has(ext)){
      return { ok: false, message: 'This file type is not supported as a slide page.' };
    }

    const kind = getDocumentKind(file, ext);
    if (!kind){
      return { ok: false, message: 'Could not classify this file safely.' };
    }

    const signature = await validateFileSignature(file, kind, ext);
    if (!signature.ok) return signature;

    return {
      ok: true,
      ext,
      kind
    };
  }

  function readFileAsDataUrl(file){
    return new Promise((resolve, reject) => {
      if (!file){
        resolve('');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(new Error('Could not read file data.'));
      reader.readAsDataURL(file);
    });
  }

  function getDocumentTypeLabel(documentInfo){
    if (!documentInfo) return 'Document';
    const baseLabel = documentInfo.kind === 'pdf'
      ? 'PDF slide'
      : documentInfo.kind === 'image'
        ? 'Image document'
        : 'Text document';
    return documentInfo.checked ? `${baseLabel} - safety checked` : baseLabel;
  }

  async function buildDocumentSlideData(file, verdict){
    const inlineUrl = verdict.kind === 'pdf' || verdict.kind === 'image'
      ? await readFileAsDataUrl(file)
      : '';
    const documentInfo = {
      title: file.name,
      kind: verdict.kind,
      ext: verdict.ext,
      mime: file.type,
      size: file.size,
      url: inlineUrl,
      checked: true,
      text: ''
    };

    if (documentInfo.kind === 'text'){
      documentInfo.text = await file.text();
    }

    return documentInfo;
  }

  function updateDocumentNavPopup(){
    if (!docNavPopup || !docPrevSlideBtn || !docNextSlideBtn || !docNavLabel) return;
    const active = isPresentationMode && isDocumentSlide();
    docNavPopup.classList.toggle('is-active', active);
    if (!active) return;
    docPrevSlideBtn.disabled = currentSlideIndex <= 0;
    docNextSlideBtn.disabled = currentSlideIndex >= slides.length - 1;
    docNavLabel.textContent = `Slide ${currentSlideIndex + 1} / ${slides.length}`;
  }

  function renderDocumentSlide(slide){
    ensureDocViewer();
    if (!slide || !slide.document){
      docViewer.classList.remove('is-active');
      updateDocumentNavPopup();
      return;
    }

    docTitleEl.textContent = slide.document.title;
    docTypeEl.textContent = getDocumentTypeLabel(slide.document);
    docScrollEl.innerHTML = '';

    if (slide.document.kind === 'pdf'){
      const frame = document.createElement('iframe');
      frame.className = 'slide-doc-frame';
      frame.src = slide.document.url;
      frame.title = slide.document.title;
      frame.tabIndex = -1;
      docScrollEl.appendChild(frame);
    } else if (slide.document.kind === 'image'){
      const image = document.createElement('img');
      image.className = 'slide-doc-image';
      image.src = slide.document.url;
      image.alt = slide.document.title;
      docScrollEl.appendChild(image);
    } else if (slide.document.kind === 'text'){
      const pre = document.createElement('pre');
      pre.className = 'slide-doc-text';
      pre.textContent = slide.document.text;
      docScrollEl.appendChild(pre);
    } else {
      const empty = document.createElement('div');
      empty.className = 'slide-doc-empty';
      empty.textContent = 'This document cannot be previewed here.';
      docScrollEl.appendChild(empty);
    }

    docScrollEl.scrollTop = 0;
    docViewer.classList.add('is-active');
    updateDocumentNavPopup();
  }

  function hideDocumentSlide(){
    if (!docViewer) return;
    docViewer.classList.remove('is-active');
    if (docScrollEl){
      docScrollEl.innerHTML = '';
    }
    updateDocumentNavPopup();
  }

  function updateUiForCurrentSlide(){
    const slide = getCurrentSlide();
    const isDoc = !!(slide && slide.type === 'document');

    if (isDoc && currentTool !== 'select' && currentTool !== 'file'){
      setTool('select');
    }

    toolButtons.forEach(btn => {
      const tool = btn.getAttribute('data-tool');
      btn.disabled = isDoc && tool !== 'select' && tool !== 'file';
    });

    actionButtons.forEach(btn => {
      const action = btn.getAttribute('data-action');
      btn.disabled = isDoc && action !== 'duplicate' && action !== 'export' && action !== 'present';
    });

    zoomButtons.forEach(btn => {
      btn.disabled = isDoc;
    });

    if (metaLabel){
      metaLabel.textContent = isDoc ? 'Document slide' : 'Canvas 16:9';
    }

    if (isDoc && selectionLabel){
      selectionLabel.textContent = 'Document slide';
    }

    updateZoomPill();
  }

  function clearObjectAnimationTweens(finalize = true){
    if (!objectAnimationTweens.length){
      if (finalize && presentationAnimationQueue.length){
        presentationAnimationQueue.forEach(entry => {
          if (!entry || !entry.node) return;
          try{
            applyAnimationFinalState(entry.node, entry.config || getNodeAnimationConfig(entry.node));
            const nodeLayer = entry.node.getLayer ? entry.node.getLayer() : null;
            if (nodeLayer) nodeLayer.batchDraw();
          }catch(err){
            // ignore removed nodes
          }
        });
      }
      presentationAnimationQueue = [];
      presentationAnimationIndex = 0;
      return;
    }
    objectAnimationTweens.forEach(entry => {
      if (!entry) return;
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      if (entry.cueTimeoutId) clearTimeout(entry.cueTimeoutId);
      if (entry.rafId) cancelAnimationFrame(entry.rafId);
      if (entry.tween){
        entry.tween.destroy();
      }
      if (finalize && typeof entry.applyFinal === 'function'){
        try{
          entry.applyFinal();
        }catch(err){
          // ignore nodes that are already gone
        }
      }
    });
    objectAnimationTweens = [];
    if (finalize && presentationAnimationQueue.length){
      presentationAnimationQueue.forEach(entry => {
        if (!entry || !entry.node) return;
        try{
          applyAnimationFinalState(entry.node, entry.config || getNodeAnimationConfig(entry.node));
          const nodeLayer = entry.node.getLayer ? entry.node.getLayer() : null;
          if (nodeLayer) nodeLayer.batchDraw();
        }catch(err){
          // ignore removed nodes
        }
      });
    }
    presentationAnimationQueue = [];
    presentationAnimationIndex = 0;
  }

  function buildNodeAnimationStates(node, config){
    const finalState = {
      x: node.x(),
      y: node.y(),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
      opacity: Number.isFinite(Number(node.opacity())) ? Number(node.opacity()) : 1
    };
    const startState = { ...finalState };

    switch (config.type){
      case 'fade':
        startState.opacity = 0;
        break;
      case 'zoom':
        startState.opacity = 0;
        startState.scaleX = finalState.scaleX * 0.82;
        startState.scaleY = finalState.scaleY * 0.82;
        break;
      case 'from-left':
        startState.opacity = 0;
        startState.x = finalState.x - NODE_ANIMATION_OFFSET;
        break;
      case 'from-right':
        startState.opacity = 0;
        startState.x = finalState.x + NODE_ANIMATION_OFFSET;
        break;
      case 'from-top':
        startState.opacity = 0;
        startState.y = finalState.y - NODE_ANIMATION_OFFSET;
        break;
      case 'from-bottom':
        startState.opacity = 0;
        startState.y = finalState.y + NODE_ANIMATION_OFFSET;
        break;
      default:
        break;
    }

    return { startState, finalState };
  }

  function applyNodeAnimationState(node, state){
    node.position({ x: state.x, y: state.y });
    node.scale({ x: state.scaleX, y: state.scaleY });
    node.opacity(state.opacity);
  }

  function getLineRevealPoints(points, progress){
    const source = Array.isArray(points) ? points.slice() : [];
    if (source.length < 4) return source;
    const start = { x: source[0], y: source[1] };
    if (progress <= 0){
      return [start.x, start.y, start.x, start.y];
    }
    if (progress >= 1){
      return source;
    }
    let totalLength = 0;
    for (let index = 0; index < source.length - 2; index += 2){
      totalLength += Math.hypot(source[index + 2] - source[index], source[index + 3] - source[index + 1]);
    }
    if (totalLength <= 0){
      return [start.x, start.y, start.x, start.y];
    }
    const targetLength = totalLength * progress;
    let walked = 0;
    const output = [start.x, start.y];
    for (let index = 0; index < source.length - 2; index += 2){
      const fromX = source[index];
      const fromY = source[index + 1];
      const toX = source[index + 2];
      const toY = source[index + 3];
      const segmentLength = Math.hypot(toX - fromX, toY - fromY);
      if (walked + segmentLength <= targetLength){
        output.push(toX, toY);
        walked += segmentLength;
        continue;
      }
      const remain = Math.max(0, targetLength - walked);
      const ratio = segmentLength > 0 ? remain / segmentLength : 0;
      output.push(
        fromX + (toX - fromX) * ratio,
        fromY + (toY - fromY) * ratio
      );
      break;
    }
    if (output.length < 4){
      output.push(start.x, start.y);
    }
    return output;
  }

  function applyAnimationStartState(node, config){
    if (!node) return;
    if (config.type === 'draw-arrow' && isLineLikeNode(node)){
      const finalPoints = (node.points ? node.points() : []).slice();
      node.setAttr('animFinalPoints', finalPoints);
      node.points(getLineRevealPoints(finalPoints, 0));
      return;
    }
    const states = buildNodeAnimationStates(node, config);
    node.setAttr('animPreparedStartState', states.startState);
    node.setAttr('animPreparedFinalState', states.finalState);
    const { startState } = states;
    applyNodeAnimationState(node, startState);
  }

  function applyAnimationFinalState(node, config){
    if (!node) return;
    if (config.type === 'draw-arrow' && isLineLikeNode(node)){
      const finalPoints = node.getAttr('animFinalPoints');
      if (Array.isArray(finalPoints) && finalPoints.length >= 4){
        node.points(finalPoints.slice());
      }
      node.setAttr('animFinalPoints', null);
      return;
    }
    const preparedFinalState = node.getAttr('animPreparedFinalState');
    const finalState = preparedFinalState && typeof preparedFinalState === 'object'
      ? preparedFinalState
      : buildNodeAnimationStates(node, config).finalState;
    applyNodeAnimationState(node, finalState);
    node.setAttr('animPreparedStartState', null);
    node.setAttr('animPreparedFinalState', null);
  }

  function triggerVideoCue(node, config){
    const video = applyVideoNodeSettings(node, config);
    if (!video || config.videoAction === 'none') return false;
    try{
      switch (config.videoAction){
        case 'pause':
          video.pause();
          break;
        case 'restart':
          video.pause();
          video.currentTime = 0;
          video.play().catch(() => {});
          break;
        case 'play':
          video.play().catch(() => {});
          break;
        default:
          return false;
      }
    }catch(err){
      return false;
    }
    return true;
  }

  function prepareVideoNodesForPresentation(layer = currentLayer){
    if (!layer) return;
    getContentNodes(layer).forEach(node => {
      if (!isVideoNode(node)) return;
      const config = getNodeAnimationConfig(node);
      const video = applyVideoNodeSettings(node, config);
      if (!video) return;
      try{
        if ((config.videoAction === 'play' || config.videoAction === 'restart') && config.order > 0){
          video.pause();
          video.currentTime = 0;
        } else if (config.videoAction === 'pause'){
          video.play().catch(() => {});
        } else {
          video.play().catch(() => {});
        }
      }catch(err){
        // ignore media issues during presentation prep
      }
    });
  }

  function runNodeEntryAnimation(node, options = {}){
    const nodeLayer = node && node.getLayer ? node.getLayer() : currentLayer;
    if (!node || !nodeLayer || !stage || !hasKonva()) return false;
    const config = getNodeAnimationConfig(node);
    const hasVisualAnimation = config.type !== 'none';
    const hasMediaCue = hasQueuedMediaCue(node, config);
    if (!hasVisualAnimation && !hasMediaCue) return false;
    const preparedStartState = node.getAttr('animPreparedStartState');
    const preparedFinalState = node.getAttr('animPreparedFinalState');
    const standardStates = hasVisualAnimation && config.type !== 'draw-arrow'
      ? (
          preparedStartState && preparedFinalState
            ? { startState: preparedStartState, finalState: preparedFinalState }
            : buildNodeAnimationStates(node, config)
        )
      : null;

    const delayOffset = Math.max(0, Number(options.delayOffset) || 0);
    const totalDelay = (options.ignoreDelay ? 0 : config.delay) + delayOffset;
    const delayMs = Math.round(totalDelay * 1000);
    let cueTriggered = false;
    const ensureCue = () => {
      if (!hasMediaCue || cueTriggered) return;
      cueTriggered = true;
      triggerVideoCue(node, config);
    };
    const applyFinal = () => {
      if (standardStates){
        applyNodeAnimationState(node, standardStates.finalState);
        node.setAttr('animPreparedStartState', null);
        node.setAttr('animPreparedFinalState', null);
      } else {
        applyAnimationFinalState(node, config);
      }
      if (nodeLayer){
        nodeLayer.batchDraw();
      }
    };

    if (standardStates){
      applyNodeAnimationState(node, standardStates.startState);
    } else {
      applyAnimationStartState(node, config);
    }
    if (nodeLayer){
      nodeLayer.batchDraw();
    }

    if (!hasVisualAnimation){
      const record = {
        node,
        tween: null,
        timeoutId: null,
        cueTimeoutId: hasMediaCue ? setTimeout(() => ensureCue(), delayMs) : null,
        rafId: null,
        applyFinal
      };
      record.timeoutId = setTimeout(() => {
        applyFinal();
        objectAnimationTweens = objectAnimationTweens.filter(entry => entry !== record);
      }, delayMs + 40);
      objectAnimationTweens.push(record);
      return true;
    }

    if (config.type === 'draw-arrow' && isLineLikeNode(node)){
      const finalPoints = (node.getAttr('animFinalPoints') || (node.points ? node.points() : [])).slice();
      const easing = window.Konva && Konva.Easings
        ? (Konva.Easings.EaseOutCubic || Konva.Easings.StrongEaseOut || Konva.Easings.EaseOut || Konva.Easings.Linear)
        : (value => value);
      const durationMs = Math.max(120, Math.round(config.duration * 1000));
      const startAt = performance.now() + delayMs;
      const record = {
        node,
        tween: null,
        timeoutId: null,
        cueTimeoutId: null,
        rafId: null,
        applyFinal
      };
      const frame = (now) => {
        if (!record) return;
        if (now < startAt){
          record.rafId = requestAnimationFrame(frame);
          return;
        }
        ensureCue();
        const progress = Math.min(1, (now - startAt) / durationMs);
        const eased = typeof easing === 'function' ? easing(progress) : progress;
        node.points(getLineRevealPoints(finalPoints, eased));
        nodeLayer.batchDraw();
        if (progress >= 1){
          applyFinal();
          objectAnimationTweens = objectAnimationTweens.filter(entry => entry !== record);
          return;
        }
        record.rafId = requestAnimationFrame(frame);
      };
      record.rafId = requestAnimationFrame(frame);
      objectAnimationTweens.push(record);
      return true;
    }

    const easing = window.Konva && Konva.Easings
      ? (Konva.Easings.EaseOutCubic || Konva.Easings.StrongEaseOut || Konva.Easings.EaseOut || Konva.Easings.Linear)
      : undefined;

    const tween = new Konva.Tween({
      node,
      duration: config.duration,
      delay: totalDelay,
      x: standardStates.finalState.x,
      y: standardStates.finalState.y,
      scaleX: standardStates.finalState.scaleX,
      scaleY: standardStates.finalState.scaleY,
      opacity: standardStates.finalState.opacity,
      easing
    });

    const record = {
      node,
      tween,
      applyFinal,
      timeoutId: null,
      cueTimeoutId: hasMediaCue ? setTimeout(() => ensureCue(), delayMs + 10) : null,
      rafId: null
    };

    record.timeoutId = setTimeout(() => {
      applyFinal();
      objectAnimationTweens = objectAnimationTweens.filter(entry => entry !== record);
    }, Math.round((totalDelay + config.duration) * 1000) + 40);

    objectAnimationTweens.push(record);
    tween.play();
    return true;
  }

  function playSelectedNodeAnimationPreview(){
    if (!selectedNode || !currentLayer || isDocumentSlide()) return false;
    clearObjectAnimationTweens(true);
    return runNodeEntryAnimation(selectedNode, { ignoreDelay: true });
  }

  function playCurrentSlideAnimations(){
    clearObjectAnimationTweens(true);
    const slide = getCurrentSlide();
    if (!isPresentationMode || !slide || slide.type !== 'canvas' || !currentLayer) return;
    normalizeLayerOrdering(currentLayer);
    presentationAnimationQueue = getAnimatedNodesInDisplayOrder(currentLayer);
    presentationAnimationIndex = 0;
    prepareVideoNodesForPresentation(currentLayer);
    presentationAnimationQueue.forEach(entry => {
      applyAnimationStartState(entry.node, entry.config);
    });
    currentLayer.batchDraw();
  }

  function playNextPresentationAnimation(){
    if (!isPresentationMode) return false;
    if (presentationAnimationIndex >= presentationAnimationQueue.length) return false;
    const entry = presentationAnimationQueue[presentationAnimationIndex];
    presentationAnimationIndex += 1;
    return runNodeEntryAnimation(entry.node);
  }

  function setPresentationMode(active){
    if (active === isPresentationMode) return;
    isPresentationMode = active;
    bodyEl.classList.toggle('slide-presenting', active);
    slideCanvas.classList.toggle('is-presenting', active);
    if (active && typeof slideCanvas.focus === 'function'){
      slideCanvas.focus();
    }
    if (!active){
      clearGuideLines();
    }
    updateDocumentNavPopup();
    resizeStage();
    if (active){
      requestAnimationFrame(() => {
        resizeStage();
        playCurrentSlideAnimations();
      });
      setTimeout(() => resizeStage(), 120);
    } else {
      clearObjectAnimationTweens(true);
    }
  }

  document.addEventListener('fullscreenchange', () => {
    setPresentationMode(document.fullscreenElement === slideCanvas);
  });

  async function enterPresentationMode(){
    if (!slideCanvas.requestFullscreen) return;
    try{
      await slideCanvas.requestFullscreen();
      setPresentationMode(true);
    }catch(err){
      // ignore fullscreen rejections
    }
  }

  function moveSlide(step){
    if (!slides.length) return;
    const nextIndex = Math.max(0, Math.min(slides.length - 1, currentSlideIndex + step));
    if (nextIndex === currentSlideIndex) return;
    showSlide(nextIndex);
    if (isPresentationMode && typeof slideCanvas.focus === 'function'){
      slideCanvas.focus();
    }
  }

  function handlePresentationKeydown(e){
    if (!isPresentationMode) return false;
    const isSpace = e.key === ' ' || e.code === 'Space';

    if (e.key === 'Escape'){
      if (document.fullscreenElement && document.exitFullscreen){
        document.exitFullscreen();
        e.preventDefault();
        return true;
      }
      return false;
    }

    if (isDocumentSlide()){
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || isSpace){
        moveSlide(1);
        e.preventDefault();
        return true;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace'){
        moveSlide(-1);
        e.preventDefault();
        return true;
      }
      if (e.key === 'ArrowDown' && docScrollEl){
        docScrollEl.scrollBy({ top: Math.round(window.innerHeight * 0.72), behavior: 'smooth' });
        e.preventDefault();
        return true;
      }
      if (e.key === 'ArrowUp' && docScrollEl){
        docScrollEl.scrollBy({ top: -Math.round(window.innerHeight * 0.72), behavior: 'smooth' });
        e.preventDefault();
        return true;
      }
      return false;
    }

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || isSpace){
      if (playNextPresentationAnimation()){
        e.preventDefault();
        return true;
      }
      moveSlide(1);
      e.preventDefault();
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Backspace'){
      moveSlide(-1);
      e.preventDefault();
      return true;
    }
    return false;
  }

  function setEditorActive(active){
    if (active === isEditorActive) return;
    if (!active && isEditingText()){
      closeActiveTextEditor(true);
    }
    if (!active){
      hideContextMenu();
      clearEditorSession();
    }
    isEditorActive = active;
    container.classList.toggle('slide-editor-active', active);
    if (active && !isInitialized){
      init();
    }
    if (active){
      syncSeedTextFromInput();
      startEditorSession();
      resizeStage();
    }
  }

  function syncActive(){
    const active = bodyEl.classList.contains('scrolled') && container.classList.contains('expanded');
    setEditorActive(active);
  }

  const observer = new MutationObserver(syncActive);
  observer.observe(bodyEl, { attributes: true, attributeFilter: ['class'] });
  observer.observe(container, { attributes: true, attributeFilter: ['class'] });
  syncActive();

  function init(){
    if (!hasKonva()){
      if (selectionLabel) selectionLabel.textContent = 'Konva not loaded.';
      return;
    }

    slideCanvas.tabIndex = 0;
    ensureDocViewer();

    stage = new Konva.Stage({
      container: stageHost,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT
    });

    uiLayer = new Konva.Layer();
    transformer = new Konva.Transformer({
      rotateEnabled: true,
      rotateAnchorOffset: 28,
      rotationSnaps: [0, 45, 90, 135, 180, 225, 270, 315],
      ignoreStroke: true,
      borderStroke: '#1a73e8',
      borderStrokeWidth: 1.25,
      borderDash: [6, 4],
      anchorStroke: '#1a73e8',
      anchorFill: '#ffffff',
      anchorCornerRadius: 8,
      anchorSize: 12,
      boundBoxFunc: (oldBox, newBox) => {
        if (newBox.width < MIN_SIZE || newBox.height < MIN_SIZE) return oldBox;
        return newBox;
      }
    });
    uiLayer.add(transformer);

    stage.add(uiLayer);
    createSlide();
    showSlide(0);

    updateShapeToolButton();
    updateLineToolButton();
    bindStageEvents();
    bindUiEvents();
    syncSeedTextFromInput();
    resizeStage();
    renderThumbs();

    isInitialized = true;
    restorePersistedEditorState().finally(() => {
      hasCompletedPersistenceBootstrap = true;
      schedulePersistentSave();
    });
  }

  function createSlide(type = 'canvas', payload = null){
    if (type === 'document'){
      slides.push({
        id: `slide-${Date.now()}-${slides.length}`,
        type: 'document',
        layer: null,
        thumbUrl: '',
        document: payload
      });
      return;
    }

    const layer = new Konva.Layer();
    const bg = new Konva.Rect({
      x: 0,
      y: 0,
      width: SLIDE_WIDTH,
      height: SLIDE_HEIGHT,
      fill: '#ffffff',
      listening: false
    });
    bg.setAttr('isBackground', true);
    layer.add(bg);

    slides.push({
      id: `slide-${Date.now()}-${slides.length}`,
      type: 'canvas',
      layer,
      thumbUrl: '',
      document: null
    });
  }

  function showSlide(index, options = {}){
    const syncSeedFromInput = options.syncSeedFromInput !== false;
    if (!slides[index]) return;
    if (lineDraft){
      cancelLineDraft();
    }
    hideSelectionMarquee();
    hideContextMenu();
    clearGuideLines();
    clearObjectAnimationTweens(true);
    if (currentLayer){
      currentLayer.remove();
    }
    currentSlideIndex = index;
    const slide = slides[index];
    currentLayer = slide.type === 'canvas' ? slide.layer : null;

    if (slide.type === 'canvas' && currentLayer){
      hideDocumentSlide();
      stageHost.style.display = '';
      stage.add(currentLayer);
      normalizeLayerOrdering(currentLayer);
      if (uiLayer && uiLayer.getParent()){
        uiLayer.moveToTop();
      }
      stage.draw();
    } else {
      stageHost.style.display = 'none';
      hideContextMenu();
      clearGuideLines();
      renderDocumentSlide(slide);
      stopVideoAnimation();
    }

    selectNode(null);
    if (syncSeedFromInput && index === 0 && slide.type === 'canvas'){
      syncSeedTextFromInput();
    }
    updateStatus();
    refreshHasContent();
    syncVideoAnimation();
    updateUiForCurrentSlide();
    resizeStage();
    if (isPresentationMode){
      playCurrentSlideAnimations();
    }
    scheduleThumbUpdate();
    if (!isPresentationMode){
      schedulePersistentSave();
    }
  }

  function deleteSlideAt(index){
    if (!slides[index]) return;

    if (slides.length === 1){
      resetSlidesToSeedState(searchInput ? searchInput.value : '');
      return;
    }

    hideContextMenu();
    clearGuideLines();

    const isCurrentSlide = index === currentSlideIndex;
    if (isCurrentSlide && isEditingText()){
      closeActiveTextEditor(false);
    }

    if (isCurrentSlide && selectedNode){
      selectNode(null);
    }

    const [removedSlide] = slides.splice(index, 1);
    if (removedSlide && removedSlide.layer === currentLayer){
      currentLayer = null;
    }
    destroySlide(removedSlide);

    const nextIndex = isCurrentSlide
      ? Math.min(index, slides.length - 1)
      : (index < currentSlideIndex ? currentSlideIndex - 1 : currentSlideIndex);

    renderThumbs();
    showSlide(Math.max(0, nextIndex));
  }

  function updateStatus(){
    if (statusLabel){
      statusLabel.textContent = `Slide ${currentSlideIndex + 1} of ${slides.length}`;
    }
    updateDocumentNavPopup();
  }

  function renderThumbs(){
    thumbsEl.innerHTML = '';

    slides.forEach((slide, index) => {
      const thumb = document.createElement('div');
      thumb.className = 'slide-thumb' + (index === currentSlideIndex ? ' is-active' : '');

      const label = document.createElement('div');
      label.className = 'slide-thumb-index';
      label.textContent = String(index + 1);

      const canvas = document.createElement('div');
      canvas.className = 'slide-thumb-canvas';
      if (slide.type === 'document' && slide.document){
        canvas.classList.add('is-document');
        const kind = document.createElement('div');
        kind.className = 'slide-thumb-doc-kind';
        kind.textContent = getDocumentTypeLabel(slide.document);

        const name = document.createElement('div');
        name.className = 'slide-thumb-doc-name';
        name.textContent = slide.document.title;

        canvas.append(kind, name);
      } else if (slide.thumbUrl){
        canvas.style.backgroundImage = `url(${slide.thumbUrl})`;
      }

      thumb.append(label, canvas);
      thumb.addEventListener('click', () => showSlide(index));
      thumb.addEventListener('contextmenu', (e) => {
        if (!isEditorActive) return;
        e.preventDefault();
        const items = slide.type === 'document'
          ? getDocumentContextMenuItems(index)
          : [
              {
                label: 'Delete slide',
                action: () => deleteSlideAt(index),
                danger: true
              }
            ];
        showContextMenu(items, e.clientX, e.clientY);
      });
      thumbsEl.appendChild(thumb);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'slide-thumb-add';
    addBtn.type = 'button';
    addBtn.textContent = '+ New slide';
    addBtn.addEventListener('click', () => {
      createSlide();
      renderThumbs();
      showSlide(slides.length - 1);
    });
    thumbsEl.appendChild(addBtn);
  }

  function scheduleThumbUpdate(){
    if (!stage) return;
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(updateThumbForCurrent, 250);
    schedulePersistentSave();
  }

  function updateThumbForCurrent(){
    const slide = slides[currentSlideIndex];
    if (!slide) return;
    if (slide.type === 'document'){
      renderThumbs();
      return;
    }
    if (!stage) return;
    normalizeLayerOrdering(slide.layer);
    transformer.visible(false);
    uiLayer.draw();
    try{
      slide.thumbUrl = stage.toDataURL({ pixelRatio: 0.2 });
    }catch(err){
      // ignore tainted canvas
    }
    transformer.visible(true);
    uiLayer.draw();
    renderThumbs();
  }

  function refreshHasContent(){
    if (isDocumentSlide()){
      window.slideEditorState.hasContent = true;
      return;
    }
    if (!currentLayer) return;
    const nodes = currentLayer.getChildren(node => !node.getAttr('isBackground'));
    window.slideEditorState.hasContent = nodes.some(node => {
      if (node.className === 'Text'){
        return node.text().trim().length > 0;
      }
      return true;
    });
  }

  function hasVideoContent(){
    if (!currentLayer) return false;
    const nodes = currentLayer.find(node => node.getAttr && node.getAttr('assetType') === 'video');
    return nodes.length > 0;
  }

  function syncVideoAnimation(){
    if (isDocumentSlide()){
      stopVideoAnimation();
      return;
    }
    if (!currentLayer){
      stopVideoAnimation();
      return;
    }
    const nodes = currentLayer.find(node => node.getAttr && node.getAttr('assetType') === 'video');
    nodes.forEach(node => {
      const video = getNodeVideoElement(node);
      if (!video) return;
      if (isPresentationMode){
        applyVideoNodeSettings(node, getNodeAnimationConfig(node));
      } else {
        video.muted = true;
        video.defaultMuted = true;
        video.loop = true;
        video.play().catch(() => {});
      }
    });
    if (nodes.length) startVideoAnimation();
    else stopVideoAnimation();
  }

  function bindStageEvents(){
    stage.on('mousedown touchstart', (e) => {
      if (!isEditorActive) return;
      hideContextMenu();
      const pos = getStagePointer();

      if (currentTool === 'line' && pos){
        if (isCurvedLineKind(currentLineKind)){
          if (!lineDraft){
            lineCurvePoints = [pos.x, pos.y];
            lineDraft = createLineNode(pos.x, pos.y, pos.x, pos.y, currentLineKind, {
              points: [pos.x, pos.y, pos.x, pos.y],
              bezier: false,
              tension: 0.5
            });
            lineDraft.listening(false);
            addNode(lineDraft, true);
          } else if (isCurveDraftActive()){
            lineCurvePoints.push(pos.x, pos.y);
            previewCurveDraft(pos);
          }
          return;
        }

        lineStart = pos;
        lineDraft = createLineNode(pos.x, pos.y, pos.x, pos.y, currentLineKind);
        addNode(lineDraft, true);
        return;
      }

      const target = resolveSelectableNode(e.target);
      const isEmpty = !target;

      if (!isEmpty){
        if (!(currentTool === 'select' && hasMultipleSelection() && isNodeSelected(target))){
          selectNode(target);
        }
        return;
      }

      if (currentTool === 'select' && pos){
        selectionMarqueeStart = pos;
        const marquee = ensureSelectionMarquee();
        marquee.position(pos);
        marquee.width(0);
        marquee.height(0);
        marquee.visible(true);
        uiLayer.batchDraw();
        return;
      }

      if (currentTool === 'text'){
        if (!pos) return;
        const textNode = createTextNode(pos.x, pos.y);
        addNode(textNode);
        editText(textNode);
        setTool('select');
        return;
      }

      if (currentTool === 'equation'){
        if (!pos) return;
        const equationNode = createEquationNode(pos.x, pos.y);
        addNode(equationNode);
        editText(equationNode);
        setTool('select');
        return;
      }

      if (currentTool === 'shape'){
        if (!pos) return;
        const shapeNode = currentShapeKind === 'ellipse'
          ? createEllipseNode(pos.x, pos.y)
          : createRectNode(pos.x, pos.y);
        addNode(shapeNode);
        setTool('select');
        return;
      }

      selectNode(null);
    });

    stage.on('mousemove touchmove', () => {
      if (!isEditorActive) return;
      const pos = getStagePointer();
      if (!pos) return;
      if (selectionMarqueeStart && selectionMarquee){
        const x = Math.min(selectionMarqueeStart.x, pos.x);
        const y = Math.min(selectionMarqueeStart.y, pos.y);
        const width = Math.abs(pos.x - selectionMarqueeStart.x);
        const height = Math.abs(pos.y - selectionMarqueeStart.y);
        selectionMarquee.position({ x, y });
        selectionMarquee.width(width);
        selectionMarquee.height(height);
        uiLayer.batchDraw();
        return;
      }
      if (lineDraft && lineStart){
        updateLineDraftPoints(pos);
        currentLayer.batchDraw();
        return;
      }
      if (isCurveDraftActive()){
        previewCurveDraft(pos);
      }
    });

    stage.on('mouseup touchend', () => {
      if (!isEditorActive) return;
      if (selectionMarqueeStart && selectionMarquee){
        const selectionBox = selectionMarquee.getClientRect({ relativeTo: currentLayer });
        const wasClick = selectionBox.width < 4 && selectionBox.height < 4;
        hideSelectionMarquee();
        if (wasClick){
          selectNode(null);
          return;
        }
        const matches = getContentNodes(currentLayer).filter(node => {
          const box = node.getClientRect({ relativeTo: currentLayer });
          return Konva.Util.haveIntersection(selectionBox, box);
        });
        selectNodes(matches, matches[0] || null);
        return;
      }
      if (!lineDraft || !lineStart) return;
      const completedNode = lineDraft;
      clearLineDraftState();
      selectNode(completedNode);
      setTool('select');
      scheduleThumbUpdate();
      schedulePersistentSave();
    });

    stage.on('dblclick dbltap', () => {
      if (!isEditorActive) return;
      if (!isCurveDraftActive()) return;
      finalizeCurveDraft();
    });

    stage.on('contextmenu', (e) => {
      if (!isEditorActive) return;
      e.evt.preventDefault();

      const target = resolveSelectableNode(e.target);
      const point = getStagePointer();

      if (target){
        if (!isNodeSelected(target)){
          selectNode(target);
        }
      } else {
        selectNode(null);
      }

      const items = [];

      if (target){
        if (target.className === 'Text'){
          items.push({
            label: 'Edit text',
            action: () => editText(target)
          });
        }
        items.push({
          label: 'Larger',
          action: () => resizeNodeByFactor(target, 1.12)
        });
        items.push({
          label: 'Smaller',
          action: () => resizeNodeByFactor(target, 0.88)
        });
        items.push({
          label: 'Center on slide',
          action: () => {
            centerNodeOnSlide(target);
            currentLayer.batchDraw();
            scheduleThumbUpdate();
          }
        });
        items.push({
          label: 'Duplicate',
          action: () => duplicateSelected()
        });
        items.push({
          label: 'Bring to front',
          action: () => handleAction('bring-front')
        });
        items.push({
          label: 'Send to back',
          action: () => handleAction('send-back')
        });
        items.push({
          label: 'Delete',
          action: () => deleteSelected(),
          danger: true
        });
      } else if (point){
        items.push({
          label: 'Edit background color',
          action: () => openBackgroundColorPicker()
        });
        items.push({
          label: 'Add text here',
          action: () => {
            const textNode = createTextNode(point.x, point.y);
            addNode(textNode);
            editText(textNode);
            setTool('select');
          }
        });
        items.push({
          label: 'Add equation',
          action: () => {
            const equationNode = createEquationNode(point.x, point.y);
            addNode(equationNode);
            editText(equationNode);
            setTool('select');
          }
        });
        items.push({
          label: 'Add rectangle',
          action: () => {
            addNode(createRectNode(point.x, point.y));
            setTool('select');
          }
        });
        items.push({
          label: 'Add ellipse',
          action: () => {
            addNode(createEllipseNode(point.x, point.y));
            setTool('select');
          }
        });
        if (imageInput){
          items.push({
            label: 'Insert image',
            action: () => imageInput.click()
          });
        }
        if (videoInput){
          items.push({
            label: 'Insert video',
            action: () => videoInput.click()
          });
        }
      }

      showContextMenu(items, e.evt.clientX, e.evt.clientY);
    });
  }

  function bindUiEvents(){
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const tool = btn.getAttribute('data-tool');
        if (!tool) return;
        hideContextMenu();
        if (tool === 'image'){
          if (imageInput) imageInput.click();
          return;
        }
        if (tool === 'video'){
          if (videoInput) videoInput.click();
          return;
        }
        if (tool === 'file'){
          if (fileInput) fileInput.click();
          return;
        }
        if (tool === 'shape'){
          openShapeToolMenu();
          return;
        }
        if (tool === 'line'){
          openLineToolMenu();
          return;
        }
        setTool(tool);
      });
    });

    actionButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        if (!action) return;
        handleAction(action);
      });
    });

    zoomButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const dir = btn.getAttribute('data-zoom');
        if (dir === 'in') setZoom(zoom + 0.1);
        if (dir === 'out') setZoom(zoom - 0.1);
      });
    });

    if (imageInput){
      imageInput.addEventListener('change', handleImageUpload);
    }

    if (videoInput){
      videoInput.addEventListener('change', handleVideoUpload);
    }

    if (fileInput){
      fileInput.addEventListener('change', handleFileUpload);
    }

    if (searchInput){
      ['input', 'change'].forEach(eventName => {
        searchInput.addEventListener(eventName, () => {
          if (isEditorActive){
            syncSeedTextFromInput();
            schedulePersistentSave();
          }
        });
      });
    }

    bindInspector();

    window.addEventListener('keydown', (e) => {
      if (handlePresentationKeydown(e)) return;
      if (!isEditorActive) return;
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || isEditingText()) return;

      if (isCurveDraftActive()){
        if (e.key === 'Enter'){
          finalizeCurveDraft();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape'){
          cancelLineDraft();
          setTool('select');
          e.preventDefault();
          return;
        }
      }

      const isAccel = e.ctrlKey || e.metaKey;

      if (isAccel && e.key.toLowerCase() === 'c'){
        if (selectedNode){
          copySelected();
          e.preventDefault();
        }
        return;
      }

      if (isAccel && e.key.toLowerCase() === 'v'){
        if (clipboardNode){
          pasteClipboard();
          e.preventDefault();
        }
        return;
      }

      if (isAccel && e.key.toLowerCase() === 'd'){
        if (selectedNode){
          duplicateSelected();
        } else {
          duplicateCurrentSlide();
        }
        e.preventDefault();
        return;
      }

      if (isAccel && e.key.toLowerCase() === 'm'){
        createSlide();
        renderThumbs();
        showSlide(slides.length - 1);
        e.preventDefault();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace'){
        if (selectedNode){
          deleteSelected();
          e.preventDefault();
        }
        return;
      }

      if (!selectedNode) return;

      const step = e.shiftKey ? NUDGE_FINE_STEP : NUDGE_STEP;
      if (e.key === 'ArrowLeft'){
        nudgeSelected(-step, 0);
        e.preventDefault();
      } else if (e.key === 'ArrowRight'){
        nudgeSelected(step, 0);
        e.preventDefault();
      } else if (e.key === 'ArrowUp'){
        nudgeSelected(0, -step);
        e.preventDefault();
      } else if (e.key === 'ArrowDown'){
        nudgeSelected(0, step);
        e.preventDefault();
      }
    });

    const resizeObserver = new ResizeObserver(() => resizeStage());
    resizeObserver.observe(stageHost);
    window.addEventListener('resize', resizeStage);
    if (window.visualViewport){
      window.visualViewport.addEventListener('resize', resizeStage);
    }

    stageHost.addEventListener('contextmenu', (e) => {
      if (isEditorActive){
        e.preventDefault();
      }
    });
  }

  function bindInspector(){
    if (propFont){
      propFont.addEventListener('change', () => {
        if (!selectedNode || selectedNode.className !== 'Text') return;
        if (selectedNode.getAttr && selectedNode.getAttr('isEquation')) return;
        selectedNode.fontFamily(propFont.value);
        currentLayer.batchDraw();
        scheduleThumbUpdate();
      });
    }

    if (propFontSize){
      propFontSize.addEventListener('change', () => {
        if (!selectedNode || selectedNode.className !== 'Text') return;
        const value = Number(propFontSize.value);
        if (!Number.isFinite(value)) return;
        selectedNode.fontSize(Math.max(8, value));
        currentLayer.batchDraw();
        scheduleThumbUpdate();
      });
    }

    if (propFill){
      propFill.addEventListener('input', () => {
        if (!selectedNode || selectedNode.className !== 'Text') return;
        selectedNode.fill(propFill.value);
        currentLayer.batchDraw();
        scheduleThumbUpdate();
      });
    }

    if (propAlign){
      propAlign.addEventListener('change', () => {
        if (!selectedNode || selectedNode.className !== 'Text') return;
        selectedNode.align(propAlign.value);
        currentLayer.batchDraw();
        scheduleThumbUpdate();
      });
    }

    if (propShapeFill){
      propShapeFill.addEventListener('input', () => {
        if (!selectedNode) return;
        if (selectedNode.className === 'Rect' || selectedNode.className === 'Ellipse'){
          selectedNode.fill(propShapeFill.value);
          currentLayer.batchDraw();
          scheduleThumbUpdate();
        }
      });
    }

    if (propStroke){
      propStroke.addEventListener('input', () => {
        if (!selectedNode) return;
        if (selectedNode.className === 'Rect' || selectedNode.className === 'Ellipse' || isLineLikeNode(selectedNode)){
          selectedNode.stroke(propStroke.value);
          if (selectedNode.className === 'Arrow' && selectedNode.fill){
            selectedNode.fill(propStroke.value);
          }
          currentLayer.batchDraw();
          scheduleThumbUpdate();
        }
      });
    }

    if (propStrokeWidth){
      propStrokeWidth.addEventListener('change', () => {
        if (!selectedNode) return;
        if (selectedNode.className === 'Rect' || selectedNode.className === 'Ellipse' || isLineLikeNode(selectedNode)){
          const value = Number(propStrokeWidth.value);
          if (!Number.isFinite(value)) return;
          selectedNode.strokeWidth(Math.max(0, value));
          if (selectedNode.className === 'Arrow'){
            const pointerSize = Math.max(10, value * 6);
            if (selectedNode.pointerLength) selectedNode.pointerLength(pointerSize);
            if (selectedNode.pointerWidth) selectedNode.pointerWidth(pointerSize);
          }
          currentLayer.batchDraw();
          scheduleThumbUpdate();
        }
      });
    }

    if (propOpacity){
      propOpacity.addEventListener('input', () => {
        if (!selectedNode) return;
        const value = Number(propOpacity.value);
        if (!Number.isFinite(value)) return;
        selectedNode.opacity(value);
        currentLayer.batchDraw();
        scheduleThumbUpdate();
      });
    }

    if (propAnimType){
      propAnimType.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection()) return;
        const currentConfig = getNodeAnimationConfig(selectedNode);
        const nextType = propAnimType.value;
        const needsOrder = nextType !== 'none' || currentConfig.videoAction !== 'none';
        setNodeAnimationConfig(selectedNode, {
          type: nextType,
          duration: propAnimDuration ? propAnimDuration.value : undefined,
          delay: propAnimDelay ? propAnimDelay.value : undefined,
          order: needsOrder
            ? (currentConfig.order > 0 ? currentConfig.order : getNextAnimationOrder(currentLayer, selectedNode))
            : 0,
          videoAction: currentConfig.videoAction,
          videoSound: currentConfig.videoSound,
          videoLoop: currentConfig.videoLoop
        });
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propAnimDuration){
      propAnimDuration.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection()) return;
        setNodeAnimationConfig(selectedNode, {
          type: propAnimType ? propAnimType.value : undefined,
          duration: propAnimDuration.value,
          delay: propAnimDelay ? propAnimDelay.value : undefined,
          order: propAnimOrder ? propAnimOrder.value : undefined,
          videoAction: propVideoAction ? propVideoAction.value : undefined,
          videoSound: propVideoSound ? propVideoSound.value : undefined,
          videoLoop: propVideoLoop ? propVideoLoop.checked : undefined
        });
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propAnimDelay){
      propAnimDelay.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection()) return;
        setNodeAnimationConfig(selectedNode, {
          type: propAnimType ? propAnimType.value : undefined,
          duration: propAnimDuration ? propAnimDuration.value : undefined,
          delay: propAnimDelay.value,
          order: propAnimOrder ? propAnimOrder.value : undefined,
          videoAction: propVideoAction ? propVideoAction.value : undefined,
          videoSound: propVideoSound ? propVideoSound.value : undefined,
          videoLoop: propVideoLoop ? propVideoLoop.checked : undefined
        });
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propAnimOrder){
      propAnimOrder.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection()) return;
        setNodeAnimationConfig(selectedNode, {
          type: propAnimType ? propAnimType.value : undefined,
          duration: propAnimDuration ? propAnimDuration.value : undefined,
          delay: propAnimDelay ? propAnimDelay.value : undefined,
          order: propAnimOrder.value,
          videoAction: propVideoAction ? propVideoAction.value : undefined,
          videoSound: propVideoSound ? propVideoSound.value : undefined,
          videoLoop: propVideoLoop ? propVideoLoop.checked : undefined
        });
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propVideoAction){
      propVideoAction.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection() || !isVideoNode(selectedNode)) return;
        const currentConfig = getNodeAnimationConfig(selectedNode);
        const nextAction = propVideoAction.value;
        const needsOrder = currentConfig.type !== 'none' || nextAction !== 'none';
        setNodeAnimationConfig(selectedNode, {
          type: currentConfig.type,
          duration: currentConfig.duration,
          delay: currentConfig.delay,
          order: needsOrder
            ? (currentConfig.order > 0 ? currentConfig.order : getNextAnimationOrder(currentLayer, selectedNode))
            : 0,
          videoAction: nextAction,
          videoSound: propVideoSound ? propVideoSound.value : undefined,
          videoLoop: propVideoLoop ? propVideoLoop.checked : undefined
        });
        applyVideoNodeSettings(selectedNode);
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propVideoSound){
      propVideoSound.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection() || !isVideoNode(selectedNode)) return;
        const currentConfig = getNodeAnimationConfig(selectedNode);
        setNodeAnimationConfig(selectedNode, {
          ...currentConfig,
          videoAction: propVideoAction ? propVideoAction.value : currentConfig.videoAction,
          videoSound: propVideoSound.value,
          videoLoop: propVideoLoop ? propVideoLoop.checked : currentConfig.videoLoop
        });
        applyVideoNodeSettings(selectedNode);
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propVideoLoop){
      propVideoLoop.addEventListener('change', () => {
        if (!selectedNode || hasMultipleSelection() || !isVideoNode(selectedNode)) return;
        const currentConfig = getNodeAnimationConfig(selectedNode);
        setNodeAnimationConfig(selectedNode, {
          ...currentConfig,
          videoAction: propVideoAction ? propVideoAction.value : currentConfig.videoAction,
          videoSound: propVideoSound ? propVideoSound.value : currentConfig.videoSound,
          videoLoop: propVideoLoop.checked
        });
        applyVideoNodeSettings(selectedNode);
        updateInspector(selectedNode);
        scheduleThumbUpdate();
        schedulePersistentSave();
      });
    }

    if (propAnimPreview){
      propAnimPreview.addEventListener('click', () => {
        playSelectedNodeAnimationPreview();
      });
    }
  }

  function setTool(tool){
    const nextTool = tool || 'select';
    if (lineDraft && nextTool !== 'line'){
      cancelLineDraft();
    }
    if (nextTool !== 'select'){
      hideSelectionMarquee();
    }
    currentTool = nextTool;
    toolButtons.forEach(btn => {
      btn.classList.toggle('is-active', btn.getAttribute('data-tool') === currentTool);
    });
  }

  function handleAction(action){
    switch(action){
      case 'delete':
        deleteSelected();
        return;
      case 'duplicate':
        if (selectedNode) duplicateSelected();
        else duplicateCurrentSlide();
        return;
      case 'bring-front':
        getSelectedNodes().forEach(node => node.moveToTop());
        normalizeLayerOrdering(currentLayer);
        currentLayer.draw();
        scheduleThumbUpdate();
        return;
      case 'send-back':
        getSelectedNodes().slice().reverse().forEach(node => {
          node.moveToBottom();
          if (node.zIndex() === 0){
            node.zIndex(1);
          }
        });
        normalizeLayerOrdering(currentLayer);
        currentLayer.draw();
        scheduleThumbUpdate();
        return;
      case 'align-left':
      case 'align-center':
      case 'align-right':
      case 'align-top':
      case 'align-middle':
      case 'align-bottom':
        alignSelected(action);
        return;
      case 'export':
        exportCurrentSlide();
        return;
      case 'present':
        enterPresentationMode();
        return;
      default:
        return;
    }
  }

  function setZoom(value){
    zoom = Math.max(0.5, Math.min(2, value));
    updateZoomPill();
    resizeStage();
    schedulePersistentSave();
  }

  function getPresentationViewportRect(){
    const viewport = window.visualViewport;
    return {
      width: Math.max(
        2,
        Math.round(
          (viewport && viewport.width)
          || window.innerWidth
          || (slideCanvas ? slideCanvas.clientWidth : 0)
          || stageHost.clientWidth
          || SLIDE_WIDTH
        )
      ),
      height: Math.max(
        2,
        Math.round(
          (viewport && viewport.height)
          || window.innerHeight
          || (slideCanvas ? slideCanvas.clientHeight : 0)
          || stageHost.clientHeight
          || SLIDE_HEIGHT
        )
      )
    };
  }

  function resizeStage(){
    if (!stage || !stageHost) return;
    const hostRect = isPresentationMode
      ? getPresentationViewportRect()
      : stageHost.getBoundingClientRect();
    const hostWidth = Math.round(hostRect.width || stageHost.clientWidth || SLIDE_WIDTH);
    const hostHeight = Math.round(hostRect.height || stageHost.clientHeight || SLIDE_HEIGHT);
    if (isPresentationMode){
      stageHost.style.width = `${hostWidth}px`;
      stageHost.style.height = `${hostHeight}px`;
    } else {
      stageHost.style.removeProperty('width');
      stageHost.style.removeProperty('height');
    }
    const w = hostWidth;
    const h = hostHeight;
    if (w < 2 || h < 2) return;
    stage.size({ width: w, height: h });
    fitScale = Math.min(w / SLIDE_WIDTH, h / SLIDE_HEIGHT);
    const effectiveZoom = isPresentationMode ? 1 : zoom;
    const scale = fitScale * effectiveZoom;
    stage.scale({ x: scale, y: scale });
    const x = (w - SLIDE_WIDTH * scale) / 2;
    const y = (h - SLIDE_HEIGHT * scale) / 2;
    stage.position({ x, y });
    stage.batchDraw();
    positionTextEditor();
  }

  function getStagePointer(){
    if (!stage) return null;
    const pos = stage.getPointerPosition();
    if (!pos) return null;
    const transform = stage.getAbsoluteTransform().copy();
    transform.invert();
    return transform.point(pos);
  }

  function selectNodes(nodes, primaryNode = null){
    selectedNodes = Array.from(new Set((nodes || []).filter(Boolean)));
    selectedNode = primaryNode && selectedNodes.includes(primaryNode)
      ? primaryNode
      : (selectedNodes[0] || null);
    clearGuideLines();
    transformer.nodes(selectedNodes);
    applyTransformerConfig(selectedNode);
    uiLayer.batchDraw();
    updateInspector(selectedNode);
  }

  function selectNode(node){
    selectNodes(node ? [node] : [], node || null);
  }

  function applyTransformerConfig(node){
    if (!transformer) return;
    if (!node || hasMultipleSelection()){
      transformer.enabledAnchors(DEFAULT_ANCHORS);
      transformer.keepRatio(false);
      return;
    }
    const isText = node.className === 'Text';
    const isMedia = node.getAttr('assetType') === 'image' || node.getAttr('assetType') === 'video';
    if (isText){
      transformer.enabledAnchors(['middle-left', 'middle-right']);
    } else if (isMedia){
      transformer.enabledAnchors(['top-left', 'top-right', 'bottom-left', 'bottom-right']);
    } else {
      transformer.enabledAnchors(DEFAULT_ANCHORS);
    }
    transformer.keepRatio(isMedia);
  }

  function updateInspector(node){
    if (!selectionLabel) return;
    if (!node){
      selectionLabel.textContent = 'No selection';
      if (textPanel) textPanel.style.display = 'none';
      if (shapePanel) shapePanel.style.display = 'none';
      if (commonPanel) commonPanel.style.display = 'none';
      if (mediaPanel) mediaPanel.style.display = 'none';
      if (propShapeFill) propShapeFill.disabled = false;
      if (propAnimOrder) propAnimOrder.disabled = true;
      if (propAnimPreview) propAnimPreview.disabled = true;
      if (propFont) propFont.disabled = false;
      return;
    }

    if (hasMultipleSelection()){
      selectionLabel.textContent = `${selectedNodes.length} items selected`;
      if (textPanel) textPanel.style.display = 'none';
      if (shapePanel) shapePanel.style.display = 'none';
      if (commonPanel) commonPanel.style.display = 'none';
      if (mediaPanel) mediaPanel.style.display = 'none';
      if (propShapeFill) propShapeFill.disabled = false;
      if (propAnimOrder) propAnimOrder.disabled = true;
      if (propAnimPreview) propAnimPreview.disabled = true;
      if (propFont) propFont.disabled = false;
      return;
    }

    const animationConfig = getNodeAnimationConfig(node);
    const displayLabel = getNodeDisplayLabel(node);
    if (animationConfig.type !== 'none'){
      selectionLabel.textContent = `${displayLabel} - ${getNodeAnimationLabel(animationConfig.type)}`;
    } else if (isVideoNode(node) && animationConfig.videoAction !== 'none'){
      selectionLabel.textContent = `${displayLabel} - ${animationConfig.videoAction} cue`;
    } else {
      selectionLabel.textContent = displayLabel;
    }
    if (commonPanel) commonPanel.style.display = 'flex';

    const isText = node.className === 'Text';
    const isShape = node.className === 'Rect' || node.className === 'Ellipse' || isLineLikeNode(node);
    const isLineLike = isLineLikeNode(node);
    const isEquation = !!(node.getAttr && node.getAttr('isEquation'));
    const isVideo = isVideoNode(node);

    if (textPanel) textPanel.style.display = isText ? 'flex' : 'none';
    if (shapePanel) shapePanel.style.display = isShape ? 'flex' : 'none';
    if (mediaPanel) mediaPanel.style.display = isVideo ? 'flex' : 'none';
    if (propShapeFill && !isShape){
      propShapeFill.disabled = false;
    }

    if (isText){
      if (propFont){
        propFont.value = isEquation ? 'Times New Roman' : (node.fontFamily() || 'Arial');
        propFont.disabled = isEquation;
      }
      if (propFontSize) propFontSize.value = String(Math.round(node.fontSize()));
      if (propFill) propFill.value = normalizeColor(node.fill(), '#111111');
      if (propAlign) propAlign.value = node.align() || 'left';
    } else if (propFont){
      propFont.disabled = false;
    }

    if (isShape){
      if (propShapeFill && node.fill) propShapeFill.value = normalizeColor(node.fill(), '#ffffff');
      if (propStroke && node.stroke) propStroke.value = normalizeColor(node.stroke(), '#111111');
      if (propStrokeWidth && node.strokeWidth) propStrokeWidth.value = String(Math.round(node.strokeWidth()));
      if (propShapeFill){
        propShapeFill.disabled = isLineLike;
      }
    }

    if (propOpacity) propOpacity.value = String(node.opacity() ?? 1);
    if (propAnimType){
      const drawArrowOption = Array.from(propAnimType.options || []).find(option => option.value === 'draw-arrow');
      if (drawArrowOption){
        drawArrowOption.disabled = !isLineLike;
        if (!isLineLike && animationConfig.type === 'draw-arrow'){
          propAnimType.value = 'none';
        } else {
          propAnimType.value = animationConfig.type;
        }
      } else {
        propAnimType.value = animationConfig.type;
      }
    }
    if (propAnimDuration) propAnimDuration.value = String(animationConfig.duration);
    if (propAnimDelay) propAnimDelay.value = String(animationConfig.delay);
    if (propAnimOrder) propAnimOrder.value = String(animationConfig.order > 0 ? animationConfig.order : 1);
    if (propAnimOrder) propAnimOrder.disabled = animationConfig.type === 'none' && animationConfig.videoAction === 'none';
    if (propAnimPreview){
      propAnimPreview.disabled = animationConfig.type === 'none' && animationConfig.videoAction === 'none';
    }
    if (isVideo){
      if (propVideoAction) propVideoAction.value = animationConfig.videoAction;
      if (propVideoSound) propVideoSound.value = animationConfig.videoSound;
      if (propVideoLoop) propVideoLoop.checked = !!animationConfig.videoLoop;
    }
  }

  function normalizeColor(value, fallback){
    if (typeof value === 'string' && value.trim().startsWith('#')) return value.trim();
    return fallback;
  }

  function bindNodeEvents(node){
    node.draggable(true);
    node.on('transformstart dragstart', () => {
      hideContextMenu();
      clearGuideLines();
      if (selectionMarqueeStart){
        hideSelectionMarquee();
      }
      if (node.isDragging && node.isDragging() && hasMultipleSelection() && isNodeSelected(node)){
        const originX = node.x();
        const originY = node.y();
        selectedNodes.forEach(item => {
          item.setAttr('multiDragAnchorX', originX);
          item.setAttr('multiDragAnchorY', originY);
          item.setAttr('multiDragOriginX', item.x());
          item.setAttr('multiDragOriginY', item.y());
        });
      }
    });
    node.on('transform', () => {
      applySnapGuides(node);
      if (selectedNode === node){
        updateInspector(node);
      }
    });
    node.on('dragmove', () => {
      applySnapGuides(node);
      if (hasMultipleSelection() && isNodeSelected(node)){
        const anchorX = Number(node.getAttr('multiDragAnchorX'));
        const anchorY = Number(node.getAttr('multiDragAnchorY'));
        if (Number.isFinite(anchorX) && Number.isFinite(anchorY)){
          const deltaX = node.x() - anchorX;
          const deltaY = node.y() - anchorY;
          selectedNodes.forEach(item => {
            if (item === node) return;
            const startX = Number(item.getAttr('multiDragOriginX'));
            const startY = Number(item.getAttr('multiDragOriginY'));
            if (!Number.isFinite(startX) || !Number.isFinite(startY)) return;
            item.position({ x: startX + deltaX, y: startY + deltaY });
          });
          currentLayer.batchDraw();
        }
      }
      if (selectedNode === node){
        updateInspector(node);
      }
    });
    node.on('transformend', () => {
      clearGuideLines();
      normalizeNode(node);
    });
    node.on('dragend', () => {
      selectedNodes.forEach(item => {
        item.setAttr('multiDragAnchorX', null);
        item.setAttr('multiDragAnchorY', null);
        item.setAttr('multiDragOriginX', null);
        item.setAttr('multiDragOriginY', null);
      });
      clearGuideLines();
      scheduleThumbUpdate();
    });

    if (node.className === 'Text'){
      node.on('dblclick dbltap', () => editText(node));
    }
  }

  function addNode(node, skipSelect = false, layer = currentLayer){
    if (!layer) return;
    bindNodeEvents(node);

    layer.add(node);
    normalizeLayerOrdering(layer);

    if (layer === currentLayer){
      currentLayer.draw();
    }

    if (!skipSelect && layer === currentLayer){
      selectNode(node);
    }

    if (layer === currentLayer){
      refreshHasContent();
      scheduleThumbUpdate();
    }
  }

  function normalizeNode(node){
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    if (node.className === 'Text'){
      node.width(Math.max(MIN_SIZE, node.width() * scaleX));
      node.scaleX(1);
      node.scaleY(1);
    } else if (node.className === 'Rect' || node.className === 'Image'){
      node.width(Math.max(MIN_SIZE, node.width() * scaleX));
      node.height(Math.max(MIN_SIZE, node.height() * scaleY));
      node.scaleX(1);
      node.scaleY(1);
    } else if (node.className === 'Ellipse'){
      const radius = node.radius();
      const nextX = Math.max(MIN_SIZE / 2, radius.x * scaleX);
      const nextY = Math.max(MIN_SIZE / 2, radius.y * scaleY);
      node.radius({ x: nextX, y: nextY });
      node.scaleX(1);
      node.scaleY(1);
    } else if (isLineLikeNode(node)){
      const box = node.getClientRect({ relativeTo: currentLayer });
      const localCenterX = box.x + box.width / 2 - node.x();
      const localCenterY = box.y + box.height / 2 - node.y();
      const points = node.points();
      const newPoints = [];
      for (let i = 0; i < points.length; i += 2){
        newPoints.push(
          localCenterX + (points[i] - localCenterX) * scaleX,
          localCenterY + (points[i + 1] - localCenterY) * scaleY
        );
      }
      node.points(newPoints);
      node.scaleX(1);
      node.scaleY(1);
      const nextBox = node.getClientRect({ relativeTo: currentLayer });
      node.position({
        x: node.x() + ((box.x + box.width / 2) - (nextBox.x + nextBox.width / 2)),
        y: node.y() + ((box.y + box.height / 2) - (nextBox.y + nextBox.height / 2))
      });
    }

    currentLayer.batchDraw();
    if (selectedNode === node){
      updateInspector(node);
    }
    scheduleThumbUpdate();
  }

  function resizeNodeByFactor(node, factor){
    if (!node || !currentLayer) return;

    const box = node.getClientRect({ relativeTo: currentLayer });
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;

    if (node.className === 'Text'){
      node.width(Math.max(MIN_SIZE, node.width() * factor));
      node.fontSize(Math.max(MIN_TEXT_SIZE, node.fontSize() * factor));
    } else if (node.className === 'Rect' || node.className === 'Image'){
      node.width(Math.max(MIN_SIZE, node.width() * factor));
      node.height(Math.max(MIN_SIZE, node.height() * factor));
    } else if (node.className === 'Ellipse'){
      const radius = node.radius();
      node.radius({
        x: Math.max(MIN_SIZE / 2, radius.x * factor),
        y: Math.max(MIN_SIZE / 2, radius.y * factor)
      });
    } else if (isLineLikeNode(node)){
      const points = node.points();
      const localCenterX = centerX - node.x();
      const localCenterY = centerY - node.y();
      const nextPoints = [];
      for (let i = 0; i < points.length; i += 2){
        nextPoints.push(
          localCenterX + (points[i] - localCenterX) * factor,
          localCenterY + (points[i + 1] - localCenterY) * factor
        );
      }
      node.points([
        ...nextPoints
      ]);
      node.strokeWidth(Math.max(1, node.strokeWidth() * factor));
    }

    const nextBox = node.getClientRect({ relativeTo: currentLayer });
    const nextCenterX = nextBox.x + nextBox.width / 2;
    const nextCenterY = nextBox.y + nextBox.height / 2;

    node.position({
      x: node.x() + (centerX - nextCenterX),
      y: node.y() + (centerY - nextCenterY)
    });

    currentLayer.batchDraw();
    if (selectedNode === node){
      updateInspector(node);
    }
    scheduleThumbUpdate();
  }

  function createRectNode(x, y){
    return new Konva.Rect({
      x: x - 150,
      y: y - 90,
      width: 300,
      height: 180,
      fill: '#ffffff',
      stroke: '#111111',
      strokeWidth: 2,
      cornerRadius: 6,
      strokeScaleEnabled: false
    });
  }

  function createEllipseNode(x, y){
    return new Konva.Ellipse({
      x,
      y,
      radius: { x: 140, y: 90 },
      fill: '#ffffff',
      stroke: '#111111',
      strokeWidth: 2,
      strokeScaleEnabled: false
    });
  }

  function createLineNode(x1, y1, x2, y2, kind = currentLineKind, overrides = {}){
    const normalizedKind = normalizeLineKind(kind);
    const points = Array.isArray(overrides.points)
      ? overrides.points.map(point => Number(point) || 0)
      : buildLinePointsForKind(normalizedKind, { x: x1, y: y1 }, { x: x2, y: y2 });
    const common = {
      x: Number(overrides.x) || 0,
      y: Number(overrides.y) || 0,
      points,
      stroke: overrides.stroke || '#111111',
      strokeWidth: Number(overrides.strokeWidth) || 2,
      opacity: Number.isFinite(Number(overrides.opacity)) ? Number(overrides.opacity) : 1,
      rotation: Number(overrides.rotation) || 0,
      lineCap: 'round',
      lineJoin: 'round',
      strokeScaleEnabled: false,
      bezier: Object.prototype.hasOwnProperty.call(overrides, 'bezier')
        ? !!overrides.bezier
        : false,
      tension: Number.isFinite(Number(overrides.tension))
        ? Number(overrides.tension)
        : (isCurvedLineKind(normalizedKind) ? 0.5 : 0)
    };
    const pointerSize = Math.max(10, common.strokeWidth * 6);
    const node = isArrowLineKind(normalizedKind)
      ? new Konva.Arrow({
          ...common,
          fill: overrides.fill || overrides.stroke || '#111111',
          pointerLength: Number(overrides.pointerLength) || pointerSize,
          pointerWidth: Number(overrides.pointerWidth) || pointerSize,
          pointerAtBeginning: false,
          pointerAtEnding: true
        })
      : new Konva.Line(common);
    node.setAttr('lineKind', normalizedKind);
    return node;
  }

  function updateLineDraftPoints(endPos){
    if (!lineDraft || !lineStart || !endPos) return;
    lineDraft.points(buildLinePointsForKind(getNodeLineKind(lineDraft), lineStart, endPos));
    if (lineDraft.className === 'Arrow' && lineDraft.fill){
      lineDraft.fill(lineDraft.stroke() || '#111111');
    }
  }

  function isCurveDraftActive(){
    return !!lineDraft && isCurvedLineKind(getNodeLineKind(lineDraft)) && lineCurvePoints.length >= 2;
  }

  function dedupeLinePoints(points){
    const deduped = [];
    for (let i = 0; i < points.length; i += 2){
      const x = points[i];
      const y = points[i + 1];
      const prevX = deduped[deduped.length - 2];
      const prevY = deduped[deduped.length - 1];
      if (deduped.length && Math.abs(prevX - x) < 0.5 && Math.abs(prevY - y) < 0.5){
        continue;
      }
      deduped.push(x, y);
    }
    return deduped;
  }

  function clearLineDraftState(){
    lineDraft = null;
    lineStart = null;
    lineCurvePoints = [];
  }

  function cancelLineDraft(){
    if (!lineDraft || !currentLayer) {
      clearLineDraftState();
      return;
    }
    const draft = lineDraft;
    clearLineDraftState();
    draft.destroy();
    currentLayer.batchDraw();
    refreshHasContent();
    scheduleThumbUpdate();
  }

  function previewCurveDraft(pos){
    if (!isCurveDraftActive() || !pos) return;
    lineDraft.points([...lineCurvePoints, pos.x, pos.y]);
    currentLayer.batchDraw();
  }

  function finalizeCurveDraft(){
    if (!isCurveDraftActive()) return;
    const nextPoints = dedupeLinePoints(lineCurvePoints);
    if (nextPoints.length < 4){
      cancelLineDraft();
      setTool('select');
      return;
    }
    lineDraft.points(nextPoints);
    lineDraft.listening(true);
    const completedNode = lineDraft;
    clearLineDraftState();
    currentLayer.batchDraw();
    selectNode(completedNode);
    setTool('select');
    refreshHasContent();
    scheduleThumbUpdate();
    schedulePersistentSave();
  }

  function createTextNode(x, y){
    return new Konva.Text({
      x,
      y,
      text: 'Double click to edit',
      fontSize: 32,
      fontFamily: 'Arial',
      fill: '#111111',
      width: 420,
      draggable: true,
      lineHeight: 1.2
    });
  }

  function createEquationNode(x, y, source = 'x^2 + y^2 = z^2'){
    const node = new Konva.Text({
      x,
      y,
      text: renderEquationSource(source),
      fontSize: 38,
      fontFamily: EQUATION_FONT_STACK,
      fill: '#111111',
      width: 520,
      draggable: true,
      align: 'left',
      lineHeight: 1.25
    });
    node.setAttr('isEquation', true);
    node.setAttr('equationSource', source);
    return node;
  }

  async function handleImageUpload(e){
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try{
      const dataUrl = await readFileAsDataUrl(file);
      const img = new Image();
      img.onload = () => {
        const frameRect = getSlideFrameRect(currentLayer);
        const maxW = frameRect.width / 2;
        const maxH = frameRect.height / 2;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const width = img.width * scale;
        const height = img.height * scale;
        const node = new Konva.Image({
          x: frameRect.x + frameRect.width / 2 - width / 2,
          y: frameRect.y + frameRect.height / 2 - height / 2,
          image: img,
          width,
          height,
          strokeScaleEnabled: false
        });
        node.setAttr('assetType', 'image');
        node.setAttr('assetSrc', dataUrl);
        addNode(node);
        setTool('select');
        e.target.value = '';
      };
      img.src = dataUrl;
    }catch(err){
      e.target.value = '';
    }
  }

  async function handleVideoUpload(e){
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try{
      const dataUrl = await readFileAsDataUrl(file);
      const video = document.createElement('video');
      video.src = dataUrl;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.addEventListener('loadeddata', () => {
        const frameRect = getSlideFrameRect(currentLayer);
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 360;
        const maxW = frameRect.width / 2;
        const maxH = frameRect.height / 2;
        const scale = Math.min(maxW / width, maxH / height, 1);
        const fitW = width * scale;
        const fitH = height * scale;
        const node = new Konva.Image({
          x: frameRect.x + frameRect.width / 2 - fitW / 2,
          y: frameRect.y + frameRect.height / 2 - fitH / 2,
          image: video,
          width: fitW,
          height: fitH,
          strokeScaleEnabled: false
        });
        node.setAttr('assetType', 'video');
        node.setAttr('assetSrc', dataUrl);
        applyVideoNodeSettings(node);
        addNode(node);
        syncVideoAnimation();
        video.play().catch(() => {});
        setTool('select');
        e.target.value = '';
      });
    }catch(err){
      e.target.value = '';
    }
  }

  async function handleFileUpload(e){
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try{
      const verdict = await runFileSafetyChecks(file);
      if (!verdict.ok){
        if (selectionLabel){
          selectionLabel.textContent = verdict.message;
        }
        e.target.value = '';
        return;
      }

      const documentInfo = await buildDocumentSlideData(file, verdict);
      createSlide('document', documentInfo);
      renderThumbs();
      showSlide(slides.length - 1);
      setTool('select');
      if (selectionLabel){
        selectionLabel.textContent = `${file.name} passed local safety checks.`;
      }
    }catch(err){
      if (selectionLabel){
        selectionLabel.textContent = 'File processing failed.';
      }
    }finally{
      e.target.value = '';
    }
  }

  function startVideoAnimation(){
    if (videoAnimation || !currentLayer) return;
    videoAnimation = new Konva.Animation(() => {}, currentLayer);
    videoAnimation.start();
  }

  function stopVideoAnimation(){
    if (!videoAnimation) return;
    videoAnimation.stop();
    videoAnimation = null;
  }

  function deleteSelected(){
    const nodes = getSelectedNodes();
    if (!nodes.length) return;
    nodes.forEach(node => node.destroy());
    selectNode(null);
    currentLayer.batchDraw();
    refreshHasContent();
    syncVideoAnimation();
    scheduleThumbUpdate();
  }

  function duplicateSelected(){
    const nodes = getSelectedNodes();
    if (!nodes.length) return;
    const clones = nodes.map(node => node.clone({
      x: node.x() + 20,
      y: node.y() + 20
    }));
    clones.forEach(clone => addNode(clone, true));
    selectNodes(clones, clones[0] || null);
    syncVideoAnimation();
  }

  function copySelected(){
    const nodes = getSelectedNodes();
    if (!nodes.length) return;
    clipboardNodes = nodes.map(node => node.clone());
    clipboardNode = clipboardNodes[0] || null;
  }

  function pasteClipboard(){
    if (!clipboardNodes.length && !clipboardNode) return;
    const sourceNodes = clipboardNodes.length ? clipboardNodes : [clipboardNode];
    const clones = sourceNodes.filter(Boolean).map(node => node.clone({
      x: node.x() + 24,
      y: node.y() + 24
    }));
    clones.forEach(clone => addNode(clone, true));
    selectNodes(clones, clones[0] || null);
    syncVideoAnimation();
  }

  function duplicateCurrentSlide(){
    const slide = getCurrentSlide();
    if (!slide) return;

    if (slide.type === 'document'){
      const duplicateDocument = {
        ...slide.document
      };
      createSlide('document', duplicateDocument);
      renderThumbs();
      showSlide(slides.length - 1);
      return;
    }

    createSlide();
    const duplicateLayer = slides[slides.length - 1].layer;

    getContentNodes(currentLayer).forEach(node => {
      const clone = node.clone();
      bindNodeEvents(clone);
      duplicateLayer.add(clone);
    });
    normalizeLayerOrdering(duplicateLayer);

    renderThumbs();
    showSlide(slides.length - 1);
  }

  function nudgeSelected(dx, dy){
    const nodes = getSelectedNodes();
    if (!nodes.length) return;
    nodes.forEach(node => {
      node.position({
        x: node.x() + dx,
        y: node.y() + dy
      });
    });
    currentLayer.batchDraw();
    updateInspector(selectedNode);
    scheduleThumbUpdate();
  }

  function alignSelected(action){
    const nodes = getSelectedNodes();
    if (!nodes.length) return;
    const frameRect = getSlideFrameRect(currentLayer);
    const box = hasMultipleSelection()
      ? getSelectionBounds(nodes)
      : selectedNode.getClientRect({ relativeTo: currentLayer });
    if (!box) return;
    const delta = { x: 0, y: 0 };

    switch(action){
      case 'align-left':
        delta.x = frameRect.x - box.x;
        break;
      case 'align-center':
        delta.x = frameRect.x + frameRect.width / 2 - (box.x + box.width / 2);
        break;
      case 'align-right':
        delta.x = frameRect.x + frameRect.width - (box.x + box.width);
        break;
      case 'align-top':
        delta.y = frameRect.y - box.y;
        break;
      case 'align-middle':
        delta.y = frameRect.y + frameRect.height / 2 - (box.y + box.height / 2);
        break;
      case 'align-bottom':
        delta.y = frameRect.y + frameRect.height - (box.y + box.height);
        break;
      default:
        return;
    }

    nodes.forEach(node => {
      node.position({
        x: node.x() + delta.x,
        y: node.y() + delta.y
      });
    });
    currentLayer.batchDraw();
    scheduleThumbUpdate();
  }

  function exportCurrentSlide(){
    const slide = getCurrentSlide();
    if (slide && slide.type === 'document'){
      downloadDocumentFile(slide.document);
      return;
    }
    if (!stage) return;
    transformer.visible(false);
    uiLayer.draw();
    let dataUrl = '';
    try{
      dataUrl = stage.toDataURL({ pixelRatio: 2 });
    }catch(err){
      transformer.visible(true);
      uiLayer.draw();
      return;
    }
    transformer.visible(true);
    uiLayer.draw();

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `slide-${currentSlideIndex + 1}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function editText(textNode){
    if (!stage) return;
    if (isEditingText()){
      closeActiveTextEditor(true);
    }
    const isEquation = !!(textNode.getAttr && textNode.getAttr('isEquation'));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.value = isEquation ? getEquationSource(textNode) : textNode.text();
    textarea.style.position = 'absolute';
    textarea.style.boxSizing = 'border-box';
    textarea.style.padding = '0';
    textarea.style.fontFamily = isEquation ? EQUATION_FONT_STACK : textNode.fontFamily();
    textarea.style.lineHeight = textNode.lineHeight();
    textarea.style.color = textNode.fill();
    textarea.style.margin = '0';
    textarea.style.border = '1px solid #1a73e8';
    textarea.style.background = '#ffffff';
    textarea.style.textAlign = textNode.align();
    textarea.style.resize = 'none';
    textarea.style.overflow = 'hidden';
    textarea.style.transformOrigin = 'left top';
    textarea.style.zIndex = 1000;
    textarea.spellcheck = false;

    textNode.hide();
    transformer.hide();
    uiLayer.draw();
    textarea.focus();
    activeTextEditor = textarea;
    activeTextNode = textNode;
    positionTextEditor();
    if (isEquation){
      createEquationPopover(textarea);
      positionEquationPopover();
    }

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){
        e.preventDefault();
        closeActiveTextEditor(false);
      }
    });

    textarea.addEventListener('blur', () => closeActiveTextEditor(true));

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + 3}px`;
      positionEquationPopover();
    });
  }
})();

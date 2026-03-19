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
  const actionButtons = Array.from(document.querySelectorAll('[data-action]'));
  const zoomButtons = Array.from(document.querySelectorAll('[data-zoom]'));
  const textPanel = document.getElementById('slideTextPanel');
  const shapePanel = document.getElementById('slideShapePanel');
  const commonPanel = document.getElementById('slideCommonPanel');
  const propFont = document.getElementById('propFont');
  const propFontSize = document.getElementById('propFontSize');
  const propFill = document.getElementById('propFill');
  const propAlign = document.getElementById('propAlign');
  const propShapeFill = document.getElementById('propShapeFill');
  const propStroke = document.getElementById('propStroke');
  const propStrokeWidth = document.getElementById('propStrokeWidth');
  const propOpacity = document.getElementById('propOpacity');

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
  let zoom = 1;
  let fitScale = 1;
  let selectedNode = null;
  let slides = [];
  let isInitialized = false;
  let isEditorActive = false;
  let lineDraft = null;
  let lineStart = null;
  let thumbTimer = null;
  let videoAnimation = null;
  let activeTextEditor = null;
  let activeTextNode = null;
  let contextMenuEl = null;
  let clipboardNode = null;
  let guideLines = [];
  let docViewer = null;
  let docTitleEl = null;
  let docTypeEl = null;
  let docScrollEl = null;
  let docDownloadBtn = null;
  let isPresentationMode = false;
  let sessionSeedText = '';
  let sessionBaselineDigest = '';
  let persistTimer = null;
  let persistDbPromise = null;
  let isApplyingPersistedState = false;
  let hasCompletedPersistenceBootstrap = false;

  function hasKonva(){
    return typeof window.Konva !== 'undefined';
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
      textNode.text(textarea.value);
    }
    if (textarea.parentNode){
      textarea.parentNode.removeChild(textarea);
    }
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
  }

  function getContentNodes(layer = currentLayer){
    if (!layer) return [];
    return layer.getChildren(node => !node.getAttr('isBackground'));
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
      assetSrc: node.getAttr ? (node.getAttr('assetSrc') || '') : ''
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
        lineHeight: roundMetric(node.lineHeight ? node.lineHeight() : 1.2)
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

    if (node.className === 'Line'){
      return {
        ...common,
        points: (node.points ? node.points() : []).map(point => roundMetric(point)),
        stroke: node.stroke ? (node.stroke() || '') : '',
        strokeWidth: roundMetric(node.strokeWidth ? node.strokeWidth() : 0)
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
    return new Konva.Line({
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      points: Array.isArray(data.points) ? data.points.map(point => Number(point) || 0) : [0, 0, 120, 0],
      stroke: data.stroke || '#111111',
      strokeWidth: Number(data.strokeWidth) || 2,
      opacity: Number.isFinite(Number(data.opacity)) ? Number(data.opacity) : 1,
      rotation: Number(data.rotation) || 0,
      lineCap: 'round',
      lineJoin: 'round',
      strokeScaleEnabled: false
    });
  }

  function createTextNodeFromSnapshot(data){
    const node = new Konva.Text({
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      text: typeof data.text === 'string' ? data.text : '',
      width: Math.max(MIN_SIZE, Number(data.width) || 420),
      fontSize: Math.max(MIN_TEXT_SIZE, Number(data.fontSize) || 32),
      fontFamily: data.fontFamily || 'Arial',
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
    return node;
  }

  async function createNodeFromSnapshot(data){
    if (!data || typeof data !== 'object') return null;
    switch (data.className){
      case 'Text':
        return createTextNodeFromSnapshot(data);
      case 'Rect':
        return createRectNodeFromSnapshot(data);
      case 'Ellipse':
        return createEllipseNodeFromSnapshot(data);
      case 'Line':
        return createLineNodeFromSnapshot(data);
      case 'Image':
        return createImageNodeFromSnapshot(data);
      default:
        return null;
    }
  }

  function clearAllSlides(){
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

    shell.append(header, docScrollEl);
    docViewer.appendChild(shell);
    slideCanvas.appendChild(docViewer);
    return docViewer;
  }

  function downloadDocumentFile(fileInfo){
    if (!fileInfo || !fileInfo.url) return;
    const link = document.createElement('a');
    link.href = fileInfo.url;
    link.download = fileInfo.title || 'document';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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

  function renderDocumentSlide(slide){
    ensureDocViewer();
    if (!slide || !slide.document){
      docViewer.classList.remove('is-active');
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
  }

  function hideDocumentSlide(){
    if (!docViewer) return;
    docViewer.classList.remove('is-active');
    if (docScrollEl){
      docScrollEl.innerHTML = '';
    }
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
    resizeStage();
    if (active){
      requestAnimationFrame(() => resizeStage());
      setTimeout(() => resizeStage(), 120);
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
    hideContextMenu();
    clearGuideLines();
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
    scheduleThumbUpdate();
    schedulePersistentSave();
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
        showContextMenu([
          {
            label: 'Delete slide',
            action: () => deleteSlideAt(index),
            danger: true
          }
        ], e.clientX, e.clientY);
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
    if (hasVideoContent()) startVideoAnimation();
    else stopVideoAnimation();
  }

  function bindStageEvents(){
    stage.on('mousedown touchstart', (e) => {
      if (!isEditorActive) return;
      hideContextMenu();
      const target = resolveSelectableNode(e.target);
      const isEmpty = !target;

      if (!isEmpty){
        selectNode(target);
        return;
      }

      if (currentTool === 'text'){
        const pos = getStagePointer();
        if (!pos) return;
        const textNode = createTextNode(pos.x, pos.y);
        addNode(textNode);
        editText(textNode);
        setTool('select');
        return;
      }

      if (currentTool === 'rect'){
        const pos = getStagePointer();
        if (!pos) return;
        const rect = createRectNode(pos.x, pos.y);
        addNode(rect);
        setTool('select');
        return;
      }

      if (currentTool === 'ellipse'){
        const pos = getStagePointer();
        if (!pos) return;
        const ellipse = createEllipseNode(pos.x, pos.y);
        addNode(ellipse);
        setTool('select');
        return;
      }

      if (currentTool === 'line'){
        const pos = getStagePointer();
        if (!pos) return;
        lineStart = pos;
        lineDraft = createLineNode(pos.x, pos.y, pos.x, pos.y);
        addNode(lineDraft, true);
        return;
      }

      selectNode(null);
    });

    stage.on('mousemove touchmove', () => {
      if (!isEditorActive) return;
      if (!lineDraft || !lineStart) return;
      const pos = getStagePointer();
      if (!pos) return;
      lineDraft.points([lineStart.x, lineStart.y, pos.x, pos.y]);
      currentLayer.batchDraw();
    });

    stage.on('mouseup touchend', () => {
      if (!isEditorActive) return;
      if (!lineDraft) return;
      selectNode(lineDraft);
      lineDraft = null;
      lineStart = null;
      setTool('select');
      scheduleThumbUpdate();
    });

    stage.on('contextmenu', (e) => {
      if (!isEditorActive) return;
      e.evt.preventDefault();

      const target = resolveSelectableNode(e.target);
      const point = getStagePointer();

      if (target){
        selectNode(target);
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
          label: 'Add text here',
          action: () => {
            const textNode = createTextNode(point.x, point.y);
            addNode(textNode);
            editText(textNode);
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
        const tool = btn.getAttribute('data-tool');
        if (!tool) return;
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
        if (selectedNode.className === 'Rect' || selectedNode.className === 'Ellipse' || selectedNode.className === 'Line'){
          selectedNode.stroke(propStroke.value);
          currentLayer.batchDraw();
          scheduleThumbUpdate();
        }
      });
    }

    if (propStrokeWidth){
      propStrokeWidth.addEventListener('change', () => {
        if (!selectedNode) return;
        if (selectedNode.className === 'Rect' || selectedNode.className === 'Ellipse' || selectedNode.className === 'Line'){
          const value = Number(propStrokeWidth.value);
          if (!Number.isFinite(value)) return;
          selectedNode.strokeWidth(Math.max(0, value));
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
  }

  function setTool(tool){
    currentTool = tool || 'select';
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
        if (selectedNode) selectedNode.moveToTop();
        currentLayer.draw();
        scheduleThumbUpdate();
        return;
      case 'send-back':
        if (selectedNode){
          selectedNode.moveToBottom();
          if (selectedNode.zIndex() === 0){
            selectedNode.zIndex(1);
          }
        }
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

  function selectNode(node){
    selectedNode = node || null;
    clearGuideLines();
    transformer.nodes(node ? [node] : []);
    applyTransformerConfig(node);
    uiLayer.batchDraw();
    updateInspector(node);
  }

  function applyTransformerConfig(node){
    if (!transformer) return;
    if (!node){
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
      return;
    }

    selectionLabel.textContent = `${node.className}`;
    if (commonPanel) commonPanel.style.display = 'flex';

    const isText = node.className === 'Text';
    const isShape = node.className === 'Rect' || node.className === 'Ellipse' || node.className === 'Line';

    if (textPanel) textPanel.style.display = isText ? 'flex' : 'none';
    if (shapePanel) shapePanel.style.display = isShape ? 'flex' : 'none';

    if (isText){
      if (propFont) propFont.value = node.fontFamily() || 'Arial';
      if (propFontSize) propFontSize.value = String(Math.round(node.fontSize()));
      if (propFill) propFill.value = normalizeColor(node.fill(), '#111111');
      if (propAlign) propAlign.value = node.align() || 'left';
    }

    if (isShape){
      if (propShapeFill && node.fill) propShapeFill.value = normalizeColor(node.fill(), '#ffffff');
      if (propStroke && node.stroke) propStroke.value = normalizeColor(node.stroke(), '#111111');
      if (propStrokeWidth && node.strokeWidth) propStrokeWidth.value = String(Math.round(node.strokeWidth()));
    }

    if (propOpacity) propOpacity.value = String(node.opacity() ?? 1);
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
    });
    node.on('transform', () => {
      applySnapGuides(node);
      if (selectedNode === node){
        updateInspector(node);
      }
    });
    node.on('dragmove', () => {
      applySnapGuides(node);
      if (selectedNode === node){
        updateInspector(node);
      }
    });
    node.on('transformend', () => {
      clearGuideLines();
      normalizeNode(node);
    });
    node.on('dragend', () => {
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
    } else if (node.className === 'Line'){
      const points = node.points();
      const newPoints = [];
      for (let i = 0; i < points.length; i += 2){
        newPoints.push(points[i] * scaleX, points[i + 1] * scaleY);
      }
      node.points(newPoints);
      node.scaleX(1);
      node.scaleY(1);
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
    } else if (node.className === 'Line'){
      const points = node.points();
      const lineCenterX = (points[0] + points[2]) / 2;
      const lineCenterY = (points[1] + points[3]) / 2;
      node.points([
        lineCenterX + (points[0] - lineCenterX) * factor,
        lineCenterY + (points[1] - lineCenterY) * factor,
        lineCenterX + (points[2] - lineCenterX) * factor,
        lineCenterY + (points[3] - lineCenterY) * factor
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

  function createLineNode(x1, y1, x2, y2){
    return new Konva.Line({
      points: [x1, y1, x2, y2],
      stroke: '#111111',
      strokeWidth: 2,
      lineCap: 'round',
      lineJoin: 'round',
      strokeScaleEnabled: false
    });
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
    if (!selectedNode) return;
    selectedNode.destroy();
    selectNode(null);
    currentLayer.batchDraw();
    refreshHasContent();
    syncVideoAnimation();
    scheduleThumbUpdate();
  }

  function duplicateSelected(){
    if (!selectedNode) return;
    const clone = selectedNode.clone({
      x: selectedNode.x() + 20,
      y: selectedNode.y() + 20
    });
    addNode(clone);
    syncVideoAnimation();
  }

  function copySelected(){
    if (!selectedNode) return;
    clipboardNode = selectedNode.clone();
  }

  function pasteClipboard(){
    if (!clipboardNode) return;
    const clone = clipboardNode.clone({
      x: clipboardNode.x() + 24,
      y: clipboardNode.y() + 24
    });
    addNode(clone);
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

    renderThumbs();
    showSlide(slides.length - 1);
  }

  function nudgeSelected(dx, dy){
    if (!selectedNode) return;
    selectedNode.position({
      x: selectedNode.x() + dx,
      y: selectedNode.y() + dy
    });
    currentLayer.batchDraw();
    updateInspector(selectedNode);
    scheduleThumbUpdate();
  }

  function alignSelected(action){
    if (!selectedNode) return;
    const frameRect = getSlideFrameRect(currentLayer);
    const box = selectedNode.getClientRect({ relativeTo: currentLayer });
    const target = { x: selectedNode.x(), y: selectedNode.y() };

    switch(action){
      case 'align-left':
        target.x = selectedNode.x() + (frameRect.x - box.x);
        break;
      case 'align-center':
        target.x = selectedNode.x() + (frameRect.x + frameRect.width / 2 - (box.x + box.width / 2));
        break;
      case 'align-right':
        target.x = selectedNode.x() + (frameRect.x + frameRect.width - (box.x + box.width));
        break;
      case 'align-top':
        target.y = selectedNode.y() + (frameRect.y - box.y);
        break;
      case 'align-middle':
        target.y = selectedNode.y() + (frameRect.y + frameRect.height / 2 - (box.y + box.height / 2));
        break;
      case 'align-bottom':
        target.y = selectedNode.y() + (frameRect.y + frameRect.height - (box.y + box.height));
        break;
      default:
        return;
    }

    selectedNode.position(target);
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

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.value = textNode.text();
    textarea.style.position = 'absolute';
    textarea.style.boxSizing = 'border-box';
    textarea.style.padding = '0';
    textarea.style.fontFamily = textNode.fontFamily();
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

    textNode.hide();
    transformer.hide();
    uiLayer.draw();
    textarea.focus();
    activeTextEditor = textarea;
    activeTextNode = textNode;
    positionTextEditor();

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
    });
  }
})();

(() => {
  const bodyEl = document.body;
  const container = document.getElementById('searchContainer');
  const searchInput = document.getElementById('searchInput');
  const stageHost = document.getElementById('slideStage');
  const thumbsEl = document.getElementById('slideThumbs');
  const zoomPill = document.getElementById('slideZoomPill');
  const statusLabel = document.getElementById('slideStatusLabel');
  const selectionLabel = document.getElementById('slideSelectionLabel');
  const imageInput = document.getElementById('slideImageInput');
  const videoInput = document.getElementById('slideVideoInput');
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

  if (!container || !stageHost || !thumbsEl) return;

  window.slideEditorState = window.slideEditorState || { hasContent: false };

  const SLIDE_WIDTH = 1280;
  const SLIDE_HEIGHT = 720;
  const MIN_SIZE = 20;
  const MIN_TEXT_SIZE = 12;
  const SNAP_THRESHOLD = 8;
  const NUDGE_STEP = 10;
  const NUDGE_FINE_STEP = 1;
  const SEED_TEXT_WIDTH = 920;
  const SEED_TEXT_MARGIN = 120;
  const DEFAULT_ANCHORS = ['top-left','top-center','top-right','middle-left','middle-right','bottom-left','bottom-center','bottom-right'];

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

  function hasKonva(){
    return typeof window.Konva !== 'undefined';
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
    const box = node.getClientRect({ relativeTo: layer });
    node.position({
      x: node.x() + (SLIDE_WIDTH / 2 - (box.x + box.width / 2)),
      y: node.y() + (SLIDE_HEIGHT / 2 - (box.y + box.height / 2))
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

  function drawGuideLine(orientation, value){
    if (!uiLayer) return;
    const points = orientation === 'vertical'
      ? [value, 0, value, SLIDE_HEIGHT]
      : [0, value, SLIDE_WIDTH, value];
    const line = new Konva.Line({
      points,
      stroke: '#1a73e8',
      strokeWidth: 1,
      dash: [6, 4],
      listening: false
    });
    guideLines.push(line);
    uiLayer.add(line);
    transformer.moveToTop();
  }

  function collectSnapGuides(node){
    const vertical = [0, SLIDE_WIDTH / 2, SLIDE_WIDTH];
    const horizontal = [0, SLIDE_HEIGHT / 2, SLIDE_HEIGHT];

    getContentNodes(currentLayer).forEach(otherNode => {
      if (otherNode === node) return;
      const box = otherNode.getClientRect({ relativeTo: currentLayer });
      vertical.push(box.x, box.x + box.width / 2, box.x + box.width);
      horizontal.push(box.y, box.y + box.height / 2, box.y + box.height);
    });

    return { vertical, horizontal };
  }

  function findBestGuide(candidates, guides){
    let best = null;
    candidates.forEach(candidate => {
      guides.forEach(guide => {
        const delta = guide - candidate.value;
        if (Math.abs(delta) > SNAP_THRESHOLD) return;
        if (!best || Math.abs(delta) < Math.abs(best.delta)){
          best = {
            delta,
            guide
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
      { value: box.x },
      { value: box.x + box.width / 2 },
      { value: box.x + box.width }
    ], guides.vertical);
    const horizontalMatch = findBestGuide([
      { value: box.y },
      { value: box.y + box.height / 2 },
      { value: box.y + box.height }
    ], guides.horizontal);

    if (!verticalMatch && !horizontalMatch) return;

    node.position({
      x: node.x() + (verticalMatch ? verticalMatch.delta : 0),
      y: node.y() + (horizontalMatch ? horizontalMatch.delta : 0)
    });

    if (verticalMatch){
      drawGuideLine('vertical', verticalMatch.guide);
    }
    if (horizontalMatch){
      drawGuideLine('horizontal', horizontalMatch.guide);
    }

    currentLayer.batchDraw();
    uiLayer.batchDraw();
  }

  function setEditorActive(active){
    if (active === isEditorActive) return;
    if (!active && isEditingText()){
      closeActiveTextEditor(true);
    }
    if (!active){
      hideContextMenu();
    }
    isEditorActive = active;
    container.classList.toggle('slide-editor-active', active);
    if (active && !isInitialized){
      init();
    }
    if (active){
      syncSeedTextFromInput();
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

    createSlide();
    showSlide(0);
    stage.add(uiLayer);

    bindStageEvents();
    bindUiEvents();
    syncSeedTextFromInput();
    resizeStage();
    renderThumbs();

    isInitialized = true;
  }

  function createSlide(){
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
      layer,
      thumbUrl: ''
    });
  }

  function showSlide(index){
    if (!slides[index]) return;
    hideContextMenu();
    clearGuideLines();
    if (currentLayer){
      currentLayer.remove();
    }
    currentSlideIndex = index;
    currentLayer = slides[index].layer;
    stage.add(currentLayer);
    uiLayer.moveToTop();
    stage.draw();
    selectNode(null);
    if (index === 0){
      syncSeedTextFromInput();
    }
    updateStatus();
    refreshHasContent();
    syncVideoAnimation();
    scheduleThumbUpdate();
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
      if (slide.thumbUrl){
        canvas.style.backgroundImage = `url(${slide.thumbUrl})`;
      }

      thumb.append(label, canvas);
      thumb.addEventListener('click', () => showSlide(index));
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
  }

  function updateThumbForCurrent(){
    if (!stage || !slides[currentSlideIndex]) return;
    transformer.visible(false);
    uiLayer.draw();
    try{
      slides[currentSlideIndex].thumbUrl = stage.toDataURL({ pixelRatio: 0.2 });
    }catch(err){
      // ignore tainted canvas
    }
    transformer.visible(true);
    uiLayer.draw();
    renderThumbs();
  }

  function refreshHasContent(){
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

    if (searchInput){
      ['input', 'change'].forEach(eventName => {
        searchInput.addEventListener(eventName, () => {
          if (isEditorActive){
            syncSeedTextFromInput();
          }
        });
      });
    }

    bindInspector();

    window.addEventListener('keydown', (e) => {
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
        if (stageHost.requestFullscreen){
          stageHost.requestFullscreen();
        }
        return;
      default:
        return;
    }
  }

  function setZoom(value){
    zoom = Math.max(0.5, Math.min(2, value));
    if (zoomPill){
      zoomPill.textContent = `${Math.round(zoom * 100)}%`;
    }
    resizeStage();
  }

  function resizeStage(){
    if (!stage || !stageHost) return;
    const w = stageHost.clientWidth;
    const h = stageHost.clientHeight;
    if (w < 2 || h < 2) return;
    fitScale = Math.min(w / SLIDE_WIDTH, h / SLIDE_HEIGHT);
    const scale = fitScale * zoom;
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
    node.on('transformend', () => normalizeNode(node));
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

  function handleImageUpload(e){
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxW = SLIDE_WIDTH / 2;
      const maxH = SLIDE_HEIGHT / 2;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const width = img.width * scale;
      const height = img.height * scale;
      const node = new Konva.Image({
        x: SLIDE_WIDTH / 2 - width / 2,
        y: SLIDE_HEIGHT / 2 - height / 2,
        image: img,
        width,
        height,
        strokeScaleEnabled: false
      });
      node.setAttr('assetType', 'image');
      node.setAttr('assetSrc', url);
      addNode(node);
      setTool('select');
      e.target.value = '';
    };
    img.src = url;
  }

  function handleVideoUpload(e){
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.addEventListener('loadeddata', () => {
      const width = video.videoWidth || 640;
      const height = video.videoHeight || 360;
      const maxW = SLIDE_WIDTH / 2;
      const maxH = SLIDE_HEIGHT / 2;
      const scale = Math.min(maxW / width, maxH / height, 1);
      const fitW = width * scale;
      const fitH = height * scale;
      const node = new Konva.Image({
        x: SLIDE_WIDTH / 2 - fitW / 2,
        y: SLIDE_HEIGHT / 2 - fitH / 2,
        image: video,
        width: fitW,
        height: fitH,
        strokeScaleEnabled: false
      });
      node.setAttr('assetType', 'video');
      node.setAttr('assetSrc', url);
      addNode(node);
      syncVideoAnimation();
      video.play().catch(() => {});
      setTool('select');
      e.target.value = '';
    });
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
    if (!currentLayer) return;

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
    const box = selectedNode.getClientRect({ relativeTo: currentLayer });
    const target = { x: selectedNode.x(), y: selectedNode.y() };

    switch(action){
      case 'align-left':
        target.x = selectedNode.x() + (0 - box.x);
        break;
      case 'align-center':
        target.x = selectedNode.x() + (SLIDE_WIDTH / 2 - (box.x + box.width / 2));
        break;
      case 'align-right':
        target.x = selectedNode.x() + (SLIDE_WIDTH - (box.x + box.width));
        break;
      case 'align-top':
        target.y = selectedNode.y() + (0 - box.y);
        break;
      case 'align-middle':
        target.y = selectedNode.y() + (SLIDE_HEIGHT / 2 - (box.y + box.height / 2));
        break;
      case 'align-bottom':
        target.y = selectedNode.y() + (SLIDE_HEIGHT - (box.y + box.height));
        break;
      default:
        return;
    }

    selectedNode.position(target);
    currentLayer.batchDraw();
    scheduleThumbUpdate();
  }

  function exportCurrentSlide(){
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

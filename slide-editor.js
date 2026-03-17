(() => {
  const bodyEl = document.body;
  const container = document.getElementById('searchContainer');
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

  function hasKonva(){
    return typeof window.Konva !== 'undefined';
  }

  function setEditorActive(active){
    if (active === isEditorActive) return;
    isEditorActive = active;
    container.classList.toggle('slide-editor-active', active);
    if (active && !isInitialized){
      init();
    }
    if (active){
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
      ignoreStroke: true,
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
    if (currentLayer){
      currentLayer.remove();
    }
    currentSlideIndex = index;
    currentLayer = slides[index].layer;
    stage.add(currentLayer);
    uiLayer.moveToTop();
    stage.draw();
    selectNode(null);
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
    window.slideEditorState.hasContent = nodes.length > 0;
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
      const target = e.target;
      const isEmpty = target === stage || target.getAttr('isBackground');

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

    bindInspector();

    window.addEventListener('keydown', (e) => {
      if (!isEditorActive) return;
      if (e.key === 'Delete' || e.key === 'Backspace'){
        if (selectedNode){
          deleteSelected();
          e.preventDefault();
        }
      }
    });

    const resizeObserver = new ResizeObserver(() => resizeStage());
    resizeObserver.observe(stageHost);
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
        duplicateSelected();
        return;
      case 'bring-front':
        if (selectedNode) selectedNode.moveToTop();
        currentLayer.draw();
        scheduleThumbUpdate();
        return;
      case 'send-back':
        if (selectedNode) selectedNode.moveToBottom();
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

  function addNode(node, skipSelect = false){
    node.draggable(true);
    node.on('transformend', () => normalizeNode(node));
    node.on('dragend', () => {
      scheduleThumbUpdate();
    });

    if (node.className === 'Text'){
      node.on('dblclick dbltap', () => editText(node));
    }

    currentLayer.add(node);
    currentLayer.draw();
    if (!skipSelect){
      selectNode(node);
    }
    refreshHasContent();
    scheduleThumbUpdate();
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
      const node = new Konva.Image({
        x: SLIDE_WIDTH / 2 - img.width / 4,
        y: SLIDE_HEIGHT / 2 - img.height / 4,
        image: img,
        width: Math.min(img.width, SLIDE_WIDTH / 2),
        height: Math.min(img.height, SLIDE_HEIGHT / 2),
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
      const node = new Konva.Image({
        x: SLIDE_WIDTH / 2 - width / 4,
        y: SLIDE_HEIGHT / 2 - height / 4,
        image: video,
        width: Math.min(width, SLIDE_WIDTH / 2),
        height: Math.min(height, SLIDE_HEIGHT / 2),
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
    const stageBox = stage.container().getBoundingClientRect();
    const textPosition = textNode.absolutePosition();
    const scale = stage.scaleX();
    const areaPosition = {
      x: stageBox.left + textPosition.x * scale + stage.x(),
      y: stageBox.top + textPosition.y * scale + stage.y()
    };

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.value = textNode.text();
    textarea.style.position = 'absolute';
    textarea.style.top = `${areaPosition.y}px`;
    textarea.style.left = `${areaPosition.x}px`;
    textarea.style.width = `${textNode.width() * scale}px`;
    textarea.style.height = `${textNode.height() * scale + 6}px`;
    textarea.style.fontSize = `${textNode.fontSize() * scale}px`;
    textarea.style.fontFamily = textNode.fontFamily();
    textarea.style.lineHeight = textNode.lineHeight();
    textarea.style.color = textNode.fill();
    textarea.style.padding = '4px';
    textarea.style.margin = '0';
    textarea.style.border = '1px solid #1a73e8';
    textarea.style.background = '#ffffff';
    textarea.style.resize = 'none';
    textarea.style.overflow = 'hidden';
    textarea.style.transformOrigin = 'left top';
    textarea.style.transform = `rotate(${textNode.rotation()}deg)`;
    textarea.style.zIndex = 1000;

    textNode.hide();
    transformer.hide();
    uiLayer.draw();
    textarea.focus();

    function removeTextarea(commit){
      if (commit){
        textNode.text(textarea.value);
      }
      textarea.parentNode.removeChild(textarea);
      textNode.show();
      transformer.show();
      uiLayer.draw();
      currentLayer.draw();
      scheduleThumbUpdate();
    }

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape'){
        e.preventDefault();
        removeTextarea(false);
      }
    });

    textarea.addEventListener('blur', () => removeTextarea(true));

    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + 3}px`;
    });
  }
})();

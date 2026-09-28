figma.showUI(__html__, { width: 720, height: 650 });

function sendSelectionToUI() {
  const selectedNodes = figma.currentPage.selection;
  let frames = selectedNodes.filter(node => node.type === 'FRAME') as FrameNode[];
  frames.sort((a, b) => {
    if (Math.abs(a.y - b.y) < 50) return a.x - b.x;
    return a.y - b.y;
  });
  const frameData = frames.map(f => ({ id: f.id, name: f.name }));
  figma.ui.postMessage({ type: 'selection-changed', frames: frameData });
}

figma.on('selectionchange', sendSelectionToUI);
sendSelectionToUI();

function isNodeVisible(node: BaseNode, frame: FrameNode): boolean {
  let current: BaseNode | null = node;
  while (current) {
    if ('visible' in current && current.visible === false) return false;
    if (current === frame) break;
    current = current.parent;
  }
  return true;
}

function hasVisibleGraphic(node: BaseNode): boolean {
  if ('fills' in node || 'strokes' in node || 'effects' in node) {
    const anyNode = node as any;
    const hasFills = Array.isArray(anyNode.fills) && anyNode.fills.some((f: any) => f.visible !== false && f.opacity > 0);
    const hasStrokes = Array.isArray(anyNode.strokes) && anyNode.strokes.some((s: any) => s.visible !== false && s.opacity > 0);
    const hasEffects = Array.isArray(anyNode.effects) && anyNode.effects.some((e: any) => e.visible !== false);
    return hasFills || hasStrokes || hasEffects;
  }
  return false;
}

function checkIsBakedBoundary(node: any, boundaries: string[]): boolean {
  if (!node || !node.name) return false;
  const name = node.name.toLowerCase().trim();
  return boundaries.some((b: string) => name.includes(b));
}

function isIconFontTextNode(node: TextNode): boolean {
  try {
    const iconKeywords = ['fontawesome', 'material', 'icon', 'symbol', 'remix', 'phosphor'];
    if (node.fontName === figma.mixed) {
      for (let i = 0; i < node.characters.length; i++) {
        const font = node.getRangeFontName(i, i + 1);
        if (font !== figma.mixed) {
          const family = (font as FontName).family.toLowerCase().replace(/\s/g, '');
          if (iconKeywords.some(keyword => family.includes(keyword))) return true;
        }
      }
      return false;
    } else {
      const fontName = node.fontName as FontName;
      if (!fontName || !fontName.family) return false;
      const family = fontName.family.toLowerCase().replace(/\s/g, '');
      return iconKeywords.some(keyword => family.includes(keyword));
    }
  } catch (e) {
    return false;
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export-ppt') {
    const { orderedIds, boundaryNames, textKeywords, imageKeywords, tableKeywords, extractNested } = msg;
    const boundaries = boundaryNames.map((b: string) => b.trim().toLowerCase()).filter(Boolean);
    const textKeys = textKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean);
    const imageKeys = imageKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean);
    const tableKeys = tableKeywords ? tableKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean) : [];

    const allSelectedFrames = figma.currentPage.selection.filter(node => node.type === 'FRAME') as FrameNode[];
    let initialFrames = orderedIds.map((id: string) => allSelectedFrames.find(f => f.id === id)).filter(Boolean) as FrameNode[];

    const frames = initialFrames.filter(frame => {
      const hasVisibleText = frame.findAll(node => node.type === 'TEXT' && isNodeVisible(node, frame)).length > 0;
      const hasVisibleImages = frame.children.some(child => isNodeVisible(child, frame));
      return hasVisibleText || hasVisibleImages;
    });

    if (frames.length === 0) {
      figma.notify('변환할 유효한 프레임이 없습니다.');
      figma.ui.postMessage({ type: 'reset-status' });
      return;
    }

    const slidesData = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      figma.ui.postMessage({ type: 'update-progress', current: i + 1, total: frames.length, frameName: frame.name });
      await new Promise(r => setTimeout(r, 10));

      let backgroundColor: string | null = null;
      if (Array.isArray(frame.fills)) {
        for (const fill of frame.fills) {
          if (fill.visible !== false && fill.type === 'SOLID' && (fill.opacity === undefined || fill.opacity > 0)) {
            const toHex = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
            backgroundColor = (toHex(fill.color.r) + toHex(fill.color.g) + toHex(fill.color.b)).toUpperCase();
          }
        }
      }

      const frameBox = frame.absoluteBoundingBox ?? { x: frame.x, y: frame.y, width: frame.width, height: frame.height };

      let currentZIndex = 0;
      const zIndexMap = new Map<string, number>();
      function assignZIndex(n: BaseNode) {
        zIndexMap.set(n.id, currentZIndex++);
        if ('children' in n) {
          for (const child of (n as any).children) { assignZIndex(child); }
        }
      }
      assignZIndex(frame);

      const targetTableNodes = frame.findAll(node => {
        if (!isNodeVisible(node, frame)) return false;
        const name = node.name.toLowerCase().trim();
        return tableKeys.some((k: string) => name.includes(k));
      }) as FrameNode[];

      const targetTextNodes = frame.findAll(node => {
        if (node.type !== 'TEXT') return false;
        if (!isNodeVisible(node, frame)) return false;

        const tNode = node as TextNode;
        if (isIconFontTextNode(tNode)) return false; // 아이콘 폰트는 텍스트 추출에서 강제 제외

        let isDesc = false, inNumbering = false, inBakedBoundary = false, inTable = false;
        let currNode: BaseNode | null = node;
        while (currNode && currNode !== frame) {
          const pName = currNode.name.toLowerCase().trim();
          if (textKeys.some((k: string) => pName.includes(k))) isDesc = true;
          if (imageKeys.some((k: string) => pName.includes(k))) inNumbering = true;
          if (tableKeys.some((k: string) => pName.includes(k))) inTable = true;
          if (checkIsBakedBoundary(currNode, boundaries)) inBakedBoundary = true;
          currNode = currNode.parent;
        }
        if (inTable) return false;
        if (inNumbering) return false;
        if (isDesc) return true;
        return !inBakedBoundary;
      }) as TextNode[];

      const targetImageNodes: SceneNode[] = [];

      function collectImages(node: SceneNode, hasCapturedParent: boolean) {
        if (!isNodeVisible(node, frame)) return;

        const name = node.name.toLowerCase().trim();
        const isTable = tableKeys.some((k: string) => name.includes(k));
        if (isTable) return;

        const isIconFontText = node.type === 'TEXT' && isIconFontTextNode(node as TextNode);

        if (node.type === 'TEXT' && targetTextNodes.includes(node as TextNode)) return;

        const isCustomImageKey = imageKeys.some((k: string) => name.includes(k));
        const isBakedBoundary = checkIsBakedBoundary(node, boundaries);

        let isCapturedHere = false;

        if (isCustomImageKey || isIconFontText) {
          if (!targetImageNodes.includes(node)) targetImageNodes.push(node);
          isCapturedHere = true;
        }
        else if (isBakedBoundary) {
          if (!targetImageNodes.includes(node)) targetImageNodes.push(node);
          isCapturedHere = true;
          if (!extractNested) return;
        }

        if ('children' in node && node.type !== 'BOOLEAN_OPERATION') {
          if (!isCapturedHere && !hasCapturedParent) {
            if (hasVisibleGraphic(node) || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
              if (!targetImageNodes.includes(node)) { targetImageNodes.push(node); isCapturedHere = true; }
            }
          }
          for (const child of node.children) { 
            collectImages(child, hasCapturedParent || isCapturedHere); 
          }
        } else {
          if (!hasCapturedParent && !isCapturedHere) {
            if (hasVisibleGraphic(node) || node.type === 'BOOLEAN_OPERATION') {
              if (!targetImageNodes.includes(node)) { targetImageNodes.push(node); }
            }
          }
        }
      }

      for (const child of frame.children) { collectImages(child, false); }

      const allHiddenImageKeysNodes = frame.findAll(node => {
        if (!isNodeVisible(node, frame)) return false;
        const name = node.name.toLowerCase().trim();
        return imageKeys.some((k: string) => name.includes(k));
      });
      for (const node of allHiddenImageKeysNodes) {
        if (!targetImageNodes.includes(node)) targetImageNodes.push(node);
      }

      const elementsData: any[] = [];

      for (const tableNode of targetTableNodes) {
        const tBox = tableNode.absoluteBoundingBox ?? { x: tableNode.x, y: tableNode.y, width: tableNode.width, height: tableNode.height };
        const tableRowsData = [];

        const rows = tableNode.children.filter(n => n.type === 'FRAME' || n.type === 'GROUP');
        for (const row of rows) {
          const rowCellsData = [];
          const cells = ('children' in row) ? row.children : [];
          for (const cell of cells) {
            let cellText = '';
            let fillColor: string | undefined = undefined;
            let borders: any[] = [ {pt: 1, color: 'CCCCCC'}, {pt: 1, color: 'CCCCCC'}, {pt: 1, color: 'CCCCCC'}, {pt: 1, color: 'CCCCCC'} ];

            if ('fills' in cell && Array.isArray(cell.fills) && cell.fills.length > 0) {
              const fill = cell.fills.find(f => f.type === 'SOLID' && f.visible !== false) as SolidPaint;
              if (fill) {
                const toHex = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                fillColor = (toHex(fill.color.r) + toHex(fill.color.g) + toHex(fill.color.b)).toUpperCase();
              }
            }

            if ('strokeWeight' in cell) {
              const anyCell = cell as any;
              const hasStrokes = Array.isArray(anyCell.strokes) && anyCell.strokes.length > 0 && anyCell.strokes[0].visible !== false;
              if (hasStrokes) {
                let strokeColor = '000000';
                const sPaint = anyCell.strokes[0];
                if (sPaint.type === 'SOLID') {
                  const toHex = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                  strokeColor = (toHex(sPaint.color.r) + toHex(sPaint.color.g) + toHex(sPaint.color.b)).toUpperCase();
                }
                borders = [
                  { pt: anyCell.strokeTopWeight > 0 ? anyCell.strokeTopWeight : 0, color: strokeColor },
                  { pt: anyCell.strokeRightWeight > 0 ? anyCell.strokeRightWeight : 0, color: strokeColor },
                  { pt: anyCell.strokeBottomWeight > 0 ? anyCell.strokeBottomWeight : 0, color: strokeColor },
                  { pt: anyCell.strokeLeftWeight > 0 ? anyCell.strokeLeftWeight : 0, color: strokeColor }
                ];
              } else {
                borders = [ {pt: 0}, {pt: 0}, {pt: 0}, {pt: 0} ];
              }
            }

            const textNode = ('findAll' in cell) ? (cell as any).findAll((n: SceneNode) => n.type === 'TEXT')[0] as TextNode : null;
            if (textNode) cellText = textNode.characters;

            rowCellsData.push({
              text: cellText,
              options: { fill: fillColor, border: borders, margin: 0, valign: 'middle' }
            });
          }
          if (rowCellsData.length > 0) tableRowsData.push(rowCellsData);
        }

        elementsData.push({
          type: 'table',
          zIndex: zIndexMap.get(tableNode.id) || 0,
          rows: tableRowsData,
          x: ((tBox.x - frameBox.x) / frame.width) * 100,
          y: ((tBox.y - frameBox.y) / frame.height) * 100,
          w: (tBox.width / frame.width) * 100,
          h: (tBox.height / frame.height) * 100
        });
      }

      for (const node of targetImageNodes) {
        const nodeBox = node.absoluteBoundingBox ?? { x: node.x, y: node.y, width: node.width, height: node.height };
        const renderBounds = (node as any).absoluteRenderBounds ?? nodeBox;
        if (renderBounds.width <= 0.1 || renderBounds.height <= 0.1) continue;

        const innerNodesToHide = 'findAll' in node
          ? (node as any).findAll((inner: SceneNode) => {
            if (inner === node) return false;
            if (targetImageNodes.includes(inner)) return true;
            if (targetTextNodes.includes(inner as any)) return true;
            return false;
          }) : [];

        const innerOpacityMap = new Map<SceneNode, number>();
        for (const innerNode of innerNodesToHide) { if ('opacity' in innerNode) { innerOpacityMap.set(innerNode, innerNode.opacity); innerNode.opacity = 0; } }

        try {
          const bytes = await node.exportAsync({ format: 'PNG' });
          elementsData.push({
            type: 'image',
            zIndex: zIndexMap.get(node.id) || 0,
            bytes: bytes,
            x: ((renderBounds.x - frameBox.x) / frame.width) * 100,
            y: ((renderBounds.y - frameBox.y) / frame.height) * 100,
            w: (renderBounds.width / frame.width) * 100,
            h: (renderBounds.height / frame.height) * 100
          });
        } catch (e) { console.error("Export failed:", node.name, e); }
        for (const innerNode of innerNodesToHide) { if ('opacity' in innerNode) { innerNode.opacity = innerOpacityMap.get(innerNode) ?? 1; } }
      }

      for (const node of targetTextNodes) {
        const nodeBox = node.absoluteBoundingBox ?? { x: node.x, y: node.y, width: node.width, height: node.height };
        let isDesc = false;
        let currNode: BaseNode | null = node;
        while (currNode && currNode !== frame) {
          const pName = currNode.name.toLowerCase().trim();
          if (textKeys.some((k: string) => pName.includes(k))) isDesc = true;
          currNode = currNode.parent;
        }

        let autoWrap = node.textAutoResize !== 'WIDTH_AND_HEIGHT';

        let align = 'left';
        if (node.textAlignHorizontal === 'CENTER') align = 'center';
        else if (node.textAlignHorizontal === 'RIGHT') align = 'right';

        let valign = 'top';
        if (node.textAlignVertical === 'CENTER') valign = 'middle';
        else if (node.textAlignVertical === 'BOTTOM') valign = 'bottom';

        let figmaLh = 1.2;
        if (node.lineHeight !== figma.mixed) {
          if (node.lineHeight.unit === 'PERCENT') {
            figmaLh = node.lineHeight.value / 100;
          } else if (node.lineHeight.unit === 'PIXELS') {
            const fSize = typeof node.fontSize === 'number' ? node.fontSize : 14;
            figmaLh = node.lineHeight.value / fSize;
          } else if (node.lineHeight.unit === 'AUTO') {
            figmaLh = 1.2;
          }
        }
        let lhMultiple = figmaLh / 1.2;

        const textChunks: any[] = [];
        const chars = node.characters;

        for (let idx = 0; idx < chars.length; idx++) {
          let charColor = '000000';
          let charBold = false;
          let charItalic = false;
          let charStrike = false;
          let charUnderline = false;
          let charFontFamily = 'Arial';
          let charFontSize = node.fontSize !== figma.mixed ? node.fontSize : 14;

          try {
            const charFill = node.getRangeFills(idx, idx + 1);
            if (charFill !== figma.mixed && Array.isArray(charFill) && charFill.length > 0) {
              const fill = charFill.find((f: any) => f.type === 'SOLID' && f.visible !== false) as SolidPaint;
              if (fill) {
                const toHex = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                charColor = (toHex(fill.color.r) + toHex(fill.color.g) + toHex(fill.color.b)).toUpperCase();
              }
            }

            const charFont = node.getRangeFontName(idx, idx + 1);
            if (charFont !== figma.mixed && charFont) {
              charFontFamily = (charFont as FontName).family;
              const style = (charFont as FontName).style.toLowerCase();
              if (style.includes('bold') || style.includes('black')) charBold = true;
              if (style.includes('italic')) charItalic = true;
            }

            const charSize = node.getRangeFontSize(idx, idx + 1);
            if (charSize !== figma.mixed && typeof charSize === 'number') {
              charFontSize = charSize;
            }

            const charDeco = node.getRangeTextDecoration(idx, idx + 1);
            if (charDeco !== figma.mixed) {
              if (charDeco === 'STRIKETHROUGH') charStrike = true;
              if (charDeco === 'UNDERLINE') charUnderline = true;
            }
          } catch (e) { }

          let finalFontSize = charFontSize * 0.75;
          let finalFontFamily = isDesc ? 'Arial' : charFontFamily;

          textChunks.push({
            text: chars[idx],
            options: {
              color: charColor,
              bold: charBold,
              italic: charItalic,
              fontFace: finalFontFamily,
              fontSize: finalFontSize,
              strike: charStrike,
              underline: charUnderline ? { style: 'single' } : false
            }
          });
        }

        const baseZIndex = zIndexMap.get(node.id) || 0;
        const finalZIndex = isDesc ? baseZIndex + 999999 : baseZIndex;

        elementsData.push({
          type: 'text',
          zIndex: finalZIndex,
          textChunks: textChunks,
          x: ((nodeBox.x - frameBox.x) / frame.width) * 100,
          y: ((nodeBox.y - frameBox.y) / frame.height) * 100,
          w: (nodeBox.width / frame.width) * 100,
          h: (nodeBox.height / frame.height) * 100,
          align: align,
          valign: valign,
          isDesc: isDesc,
          autoWrap: autoWrap,
          lhMultiple: lhMultiple
        });
      }
      elementsData.sort((a, b) => a.zIndex - b.zIndex);
      
      slidesData.push({ name: frame.name, width: frame.width, height: frame.height, backgroundColor: backgroundColor, elements: elementsData });
    }
    figma.ui.postMessage({ type: 'generate-pptx', slides: slidesData });
  }
};
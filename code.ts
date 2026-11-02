figma.showUI(__html__, { width: 720, height: 650 });

function getSafeBounds(node: SceneNode) {
  try {
    // 1. 피그마 문서에서 노드가 삭제(파기)되었는지 안전하게 확인
    if (!node || node.removed) return null;

    // 2. absoluteBoundingBox 안전 조회
    const nodeBox = node.absoluteBoundingBox ?? { x: node.x, y: node.y, width: node.width, height: node.height };
    if (!nodeBox || typeof nodeBox.width !== 'number' || typeof nodeBox.height !== 'number') return null;
    if (nodeBox.width <= 0.1 || nodeBox.height <= 0.1) return null;

    const renderBounds = (node as any).absoluteRenderBounds ?? nodeBox;
    return { nodeBox, renderBounds: renderBounds || nodeBox };
  } catch (_err) {
    // 인스턴스 슬롯 노드가 파기되었거나 접근 불가 시 예외 처리
    return null;
  }
}

function sendSelectionToUI() {
  const selectedNodes = figma.currentPage.selection;
  const frames = selectedNodes.filter(node => node.type === 'FRAME' && node.visible !== false) as FrameNode[];
  frames.sort((a, b) => {
    if (Math.abs(a.y - b.y) < 50) return a.x - b.x;
    return a.y - b.y;
  });
  const frameData = frames.map(f => ({ id: f.id, name: f.name }));
  figma.ui.postMessage({ type: 'selection-changed', frames: frameData });
}

figma.on('selectionchange', sendSelectionToUI);
sendSelectionToUI();

function isClippedByAncestor(node: SceneNode, rootFrame: FrameNode): boolean {
  try {
    if (!node || node.removed) return true;
    const nodeBox = node.absoluteBoundingBox;
    if (!nodeBox || nodeBox.width <= 0.1 || nodeBox.height <= 0.1) return true;

    let ancestor: BaseNode | null = node.parent;
    while (ancestor) {
      const anyAncestor = ancestor as any;
      let hasClip = false;

      // 1. 직접 clipsContent 속성 확인 (C++ 프록시 객체 대응 직접 프로퍼티 접근)
      try {
        if (anyAncestor.clipsContent === true) hasClip = true;
      } catch (_e) { /* ignore */ }

      // 2. 인스턴스인 경우 mainComponent의 clipsContent 확인
      if (!hasClip && anyAncestor.type === 'INSTANCE' && anyAncestor.mainComponent) {
        try {
          if (anyAncestor.mainComponent.clipsContent === true) hasClip = true;
        } catch (_e) { /* ignore */ }
      }

      if (hasClip) {
        const clipBox = anyAncestor.absoluteBoundingBox ?? {
          x: anyAncestor.x,
          y: anyAncestor.y,
          width: anyAncestor.width,
          height: anyAncestor.height
        };

        if (clipBox && typeof clipBox.width === 'number' && typeof clipBox.height === 'number') {
          const clipRight = clipBox.x + clipBox.width;
          const clipBottom = clipBox.y + clipBox.height;

          // 1) 완전히 바깥으로 벗어난 경우 (상하좌우 경계)
          if (
            nodeBox.x + nodeBox.width <= clipBox.x + 0.5 ||   // 완전히 왼쪽
            nodeBox.x >= clipRight - 0.5 ||                   // 완전히 오른쪽
            nodeBox.y + nodeBox.height <= clipBox.y + 0.5 ||   // 완전히 위쪽 (스크롤되어 헤더 위로 올라간 경우)
            nodeBox.y >= clipBottom - 0.5                     // 완전히 아래쪽 (카드 바깥 아래로 밀려난 경우)
          ) {
            return true; // 클리핑되어 숨겨짐
          }

          // 2) 교차 영역(Intersection) 계산
          const x1 = Math.max(nodeBox.x, clipBox.x);
          const y1 = Math.max(nodeBox.y, clipBox.y);
          const x2 = Math.min(nodeBox.x + nodeBox.width, clipRight);
          const y2 = Math.min(nodeBox.y + nodeBox.height, clipBottom);

          const overlapW = x2 - x1;
          const overlapH = y2 - y1;

          // 교차 영역이 없거나 0.5px 이하이면 완전히 벗어난 것으로 판정
          if (overlapW <= 0.5 || overlapH <= 0.5) {
            return true;
          }

          // [안전 가드] 슬라이드/컨테이너 경계선에 걸쳐 있는 긴 아코디언, 카드,
          // '다음 슬라이드에서 계속' 영역 등이 과도하게 삭제되지 않도록
          // 중심점 검사 및 50% 교차면적 강제 삭제 로직은 제외함 (화면에 걸쳐 있는 부분은 유지)
        }
      }

      if (ancestor === rootFrame) break;
      ancestor = ancestor.parent;
    }

    return false;
  } catch (_err) {
    return false;
  }
}

function isNodeVisible(node: BaseNode, frame: FrameNode): boolean {
  // 1. 레이어 가시성(visible) 검사 (부모 체인 포함)
  let current: BaseNode | null = node;
  while (current) {
    if ('visible' in current && current.visible === false) return false;
    if (current === frame) break;
    current = current.parent;
  }

  // 2. 넘친 콘텐츠 숨기기(Clip content) 판정
  if ('absoluteBoundingBox' in node) {
    if (isClippedByAncestor(node as SceneNode, frame)) {
      return false;
    }
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
    if (!node || node.removed) return false;

    const chars = node.characters || '';

    // 1. 유니코드 Private Use Area (PUA) 및 특수 아이콘 기호 검사
    // Font Awesome 및 대다수 아이콘 웹폰트는 유니코드 PUA 영역(0xE000~0xF8FF, 0xF0000 이상)에 글리프를 매핑합니다.
    for (let i = 0; i < chars.length; i++) {
      const code = chars.codePointAt(i) || 0;
      // Basic PUA
      if (code >= 0xe000 && code <= 0xf8ff) return true;
      // Supplementary PUA-A & PUA-B
      if (code >= 0xf0000 && code <= 0xffffd) return true;
      if (code >= 0x100000 && code <= 0x10fffd) return true;
      // 딩뱃 및 특수 기호 (체크박스, 체크마크 등)
      if ((code >= 0x2700 && code <= 0x27bf) || (code >= 0x2600 && code <= 0x26ff)) {
        if (chars.trim().length <= 2) return true;
      }
    }

    // 2. 폰트 패밀리 및 폰트 스타일 검사
    const iconFontKeywords = [
      'fontawesome', 'font-awesome', 'awesome', 'fa-', 'fa5', 'fa6', 'fapro', 'fafree',
      'material', 'icon', 'symbol', 'remix', 'phosphor', 'feather', 'lucide',
      'tabler', 'bootstrap', 'heroicon', 'ionicons', 'glyph', 'xeicon', 'lineawesome'
    ];

    const checkFont = (font: FontName): boolean => {
      if (!font || !font.family) return false;
      const family = font.family.toLowerCase().replace(/[\s\-_]/g, '');
      const style = (font.style || '').toLowerCase().replace(/[\s\-_]/g, '');
      const rawFamily = font.family.toLowerCase();

      // 'fa'로 시작하는 폰트명 처리 (예: FA Solid, FA Pro, FA-Regular)
      if (/^fa[\s\-_]/.test(rawFamily) || /^fa[0-9]/.test(rawFamily)) return true;

      return iconFontKeywords.some(keyword => {
        const cleanK = keyword.replace(/[\s\-_]/g, '');
        return family.includes(cleanK) || style.includes(cleanK);
      });
    };

    if (node.fontName === figma.mixed) {
      for (let i = 0; i < chars.length; i++) {
        const font = node.getRangeFontName(i, i + 1);
        if (font !== figma.mixed && font && checkFont(font as FontName)) {
          return true;
        }
      }
    } else if (node.fontName) {
      if (checkFont(node.fontName as FontName)) return true;
    }

    // 3. 레이어 이름(Node Name) 및 부모 노드 이름 기반 아이콘 판정
    const nodeName = (node.name || '').toLowerCase().trim();
    const iconNameKeywords = ['icon', 'ico', 'fa-', 'fa_', 'glyph', 'symbol'];
    const isIconName = iconNameKeywords.some(k => nodeName.includes(k));

    // 4. 체크박스/체크 아이콘 (check, checked, checkbox) 및 합자(Ligature) 판정
    const checkNameKeywords = ['check', 'checked', 'checkbox'];
    const isCheckName = checkNameKeywords.some(k => nodeName.includes(k));

    const trimmedText = chars.trim().toLowerCase();
    const commonLigatures = [
      'check', 'checked', 'check-square', 'check-circle', 'square-check', 'circle-check',
      'checkbox', 'times', 'close', 'plus', 'minus', 'chevron-right', 'chevron-left',
      'chevron-down', 'chevron-up', 'search', 'cog', 'gear', 'user', 'bell', 'star'
    ];
    const isLigatureWord = commonLigatures.includes(trimmedText);

    // 레이어 이름이 아이콘/체크 관련이면서 글자 길이가 짧으면 아이콘으로 판정
    if ((isIconName || isCheckName) && (chars.trim().length <= 15 || isLigatureWord)) {
      return true;
    }

    // 부모 레이어 검사 (예: Checkbox 컴포넌트 내부의 체크 표시)
    if (node.parent) {
      const parentName = (node.parent.name || '').toLowerCase().trim();
      const isParentIcon = iconNameKeywords.some(k => parentName.includes(k)) || checkNameKeywords.some(k => parentName.includes(k));
      if (isParentIcon && (chars.trim().length <= 5 || isLigatureWord)) {
        return true;
      }
    }

    // Font Awesome 등에서 'check'와 같은 합자 단어 단독으로 사용된 경우
    if (isLigatureWord && chars.trim().length <= 15) {
      return true;
    }

    return false;
  } catch (_e) {
    return false;
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'export-ppt') {
    try {
      const { orderedIds, boundaryNames, textKeywords, imageKeywords, tableKeywords, extractNested } = msg;
      const boundaries = boundaryNames.map((b: string) => b.trim().toLowerCase()).filter(Boolean);
      const textKeys = textKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean);
      const imageKeys = imageKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean);
      const tableKeys = tableKeywords ? tableKeywords.map((k: string) => k.trim().toLowerCase()).filter(Boolean) : [];

      const allSelectedFrames = figma.currentPage.selection.filter(node => node.type === 'FRAME' && node.visible !== false) as FrameNode[];
      const initialFrames = orderedIds.map((id: string) => allSelectedFrames.find(f => f.id === id)).filter(Boolean) as FrameNode[];

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
          if (isIconFontTextNode(tNode)) return false;

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
          // 레이어의 visible 속성이 꺼져 있는 경우는 자식도 포함하여 완전히 제외
          let cur: BaseNode | null = node;
          while (cur) {
            if ('visible' in cur && cur.visible === false) return;
            if (cur === frame) break;
            cur = cur.parent;
          }

          const isSelfClipped = isClippedByAncestor(node, frame);

          const name = node.name.toLowerCase().trim();
          const isTable = tableKeys.some((k: string) => name.includes(k));
          if (isTable) return;

          const isIconFontText = node.type === 'TEXT' && isIconFontTextNode(node as TextNode);

          if (node.type === 'TEXT' && targetTextNodes.includes(node as TextNode)) return;

          const isCustomImageKey = imageKeys.some((k: string) => name.includes(k));
          const isBakedBoundary = checkIsBakedBoundary(node, boundaries);

          let isCapturedHere = false;

          // 노드 자체가 클리핑 영역 안에 유효하게 보일 때만 이미지 캡처 대상으로 등록
          if (!isSelfClipped) {
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
            } else {
              if (!hasCapturedParent && !isCapturedHere) {
                if (hasVisibleGraphic(node) || node.type === 'BOOLEAN_OPERATION') {
                  if (!targetImageNodes.includes(node)) { targetImageNodes.push(node); }
                }
              }
            }
          }

          // 자식 노드 순회는 부모의 클리핑 여부와 무관하게 계속 탐색 (화면 안에 보이는 내부 UI 요소 누락 방지)
          if ('children' in node && node.type !== 'BOOLEAN_OPERATION') {
            for (const child of node.children) {
              collectImages(child, hasCapturedParent || isCapturedHere);
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

        const allIconNodes = frame.findAll(node => {
          if (!isNodeVisible(node, frame)) return false;
          return node.type === 'TEXT' && isIconFontTextNode(node as TextNode);
        });
        for (const node of allIconNodes) {
          if (!targetImageNodes.includes(node)) targetImageNodes.push(node);
        }

        const elementsData: any[] = [];

        for (const tableNode of targetTableNodes) {
          if (isClippedByAncestor(tableNode, frame)) continue;
          const bounds = getSafeBounds(tableNode);
          if (!bounds) continue;
          const tBox = bounds.nodeBox;
          const tableRowsData = [];

          const rows = tableNode.children.filter(n => n.type === 'FRAME' || n.type === 'GROUP');
          for (const row of rows) {
            const rowCellsData = [];
            const cells = ('children' in row) ? (row as any).children : [];
            for (const cell of cells) {
              let cellText = '';
              let fillColor = 'FFFFFF';
              let borders: any[] = [{ pt: 0, color: 'FFFFFF' }, { pt: 0, color: 'FFFFFF' }, { pt: 0, color: 'FFFFFF' }, { pt: 0, color: 'FFFFFF' }];

              if ('fills' in cell && Array.isArray(cell.fills) && cell.fills.length > 0) {
                const fill = cell.fills.find((f: any) => f.type === 'SOLID' && f.visible !== false) as SolidPaint;
                if (fill) {
                  const toHex = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                  fillColor = (toHex(fill.color.r) + toHex(fill.color.g) + toHex(fill.color.b)).toUpperCase();
                }
              }

              if ('strokeWeight' in cell) {
                const anyCell = cell as any;
                const hasStrokes = Array.isArray(anyCell.strokes) && anyCell.strokes.length > 0 && anyCell.strokes[0].visible !== false;
                let strokeColor = 'CCCCCC';
                if (hasStrokes) {
                  const sPaint = anyCell.strokes[0];
                  if (sPaint.type === 'SOLID') {
                    const toHex = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                    strokeColor = (toHex(sPaint.color.r) + toHex(sPaint.color.g) + toHex(sPaint.color.b)).toUpperCase();
                  }
                }

                borders = [
                  { pt: anyCell.strokeTopWeight > 0 ? anyCell.strokeTopWeight : 0, color: anyCell.strokeTopWeight > 0 ? strokeColor : 'FFFFFF' },
                  { pt: anyCell.strokeRightWeight > 0 ? anyCell.strokeRightWeight : 0, color: anyCell.strokeRightWeight > 0 ? strokeColor : 'FFFFFF' },
                  { pt: anyCell.strokeBottomWeight > 0 ? anyCell.strokeBottomWeight : 0, color: anyCell.strokeBottomWeight > 0 ? strokeColor : 'FFFFFF' },
                  { pt: anyCell.strokeLeftWeight > 0 ? anyCell.strokeLeftWeight : 0, color: anyCell.strokeLeftWeight > 0 ? strokeColor : 'FFFFFF' }
                ];
              }

              const textNode = ('findAll' in cell) ? (cell as any).findAll((n: SceneNode) => n.type === 'TEXT')[0] as TextNode : null;
              if (textNode) cellText = textNode.characters || '';

              rowCellsData.push({
                text: cellText,
                options: { fill: fillColor, border: borders, margin: 2, valign: 'middle' }
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
          if (isClippedByAncestor(node, frame)) continue;
          const bounds = getSafeBounds(node);
          if (!bounds) continue;
          const { renderBounds } = bounds;

          if (renderBounds.width <= 0.1 || renderBounds.height <= 0.1) continue;

          const innerNodesToHide: SceneNode[] = [];
          if ('findAll' in node) {
            try {
              const found = (node as any).findAll((inner: SceneNode) => {
                if (!inner || inner.removed) return false;
                if (inner === node) return false;
                if (targetImageNodes.includes(inner)) return true;
                if (targetTextNodes.includes(inner as any)) return true;
                return false;
              });
              innerNodesToHide.push(...found);
            } catch (_e) { /* ignore */ }
          }

          const innerOpacityMap = new Map<SceneNode, number>();
          for (const innerNode of innerNodesToHide) {
            if (innerNode && !innerNode.removed && 'opacity' in innerNode) {
              try {
                innerOpacityMap.set(innerNode, innerNode.opacity);
                innerNode.opacity = 0;
              } catch (_e) { /* ignore */ }
            }
          }

          try {
            const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
            elementsData.push({
              type: 'image',
              zIndex: zIndexMap.get(node.id) || 0,
              bytes: bytes,
              x: ((renderBounds.x - frameBox.x) / frame.width) * 100,
              y: ((renderBounds.y - frameBox.y) / frame.height) * 100,
              w: (renderBounds.width / frame.width) * 100,
              h: (renderBounds.height / frame.height) * 100
            });
          } catch (e) {
            console.error("Export failed:", node.name, e);
          } finally {
            for (const innerNode of innerNodesToHide) {
              if (innerNode && !innerNode.removed && 'opacity' in innerNode && innerOpacityMap.has(innerNode)) {
                try {
                  innerNode.opacity = innerOpacityMap.get(innerNode) ?? 1;
                } catch (_e) { /* ignore */ }
              }
            }
          }
        }

        for (const node of targetTextNodes) {
          if (isClippedByAncestor(node, frame)) continue;
          const bounds = getSafeBounds(node);
          if (!bounds) continue;
          const nodeBox = bounds.nodeBox;

          let isDesc = false;
          let currNode: BaseNode | null = node;
          while (currNode && currNode !== frame) {
            const pName = currNode.name.toLowerCase().trim();
            if (textKeys.some((k: string) => pName.includes(k))) isDesc = true;
            currNode = currNode.parent;
          }

          const autoWrap = node.textAutoResize !== 'WIDTH_AND_HEIGHT';

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
          if (!isFinite(lhMultiple) || isNaN(lhMultiple) || lhMultiple <= 0) {
            lhMultiple = 1.0;
          }

          const textChunks: any[] = [];
          const chars = node.characters;
          const toHex2 = (c: number) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };

          // 글자별 스타일을 수집한 뒤 동일 스타일 연속 구간을 하나의 청크로 병합
          interface CharStyle {
            color: string;
            bold: boolean;
            italic: boolean;
            strike: boolean;
            underline: boolean | { style: string };
            fontFace: string;
            fontSize: number;
          }

          const styleOf = (idx: number): CharStyle => {
            let charColor = '000000';
            let charBold = false;
            let charItalic = false;
            let charStrike = false;
            let charUnderline: boolean | { style: string } = false;
            let charFontFamily = 'Arial';
            let charFontSize = node.fontSize !== figma.mixed ? node.fontSize as number : 14;

            try {
              const charFill = node.getRangeFills(idx, idx + 1);
              if (charFill !== figma.mixed && Array.isArray(charFill) && charFill.length > 0) {
                const fill = charFill.find((f: any) => f.type === 'SOLID' && f.visible !== false) as SolidPaint;
                if (fill) {
                  charColor = (toHex2(fill.color.r) + toHex2(fill.color.g) + toHex2(fill.color.b)).toUpperCase();
                }
              }

              const charFont = node.getRangeFontName(idx, idx + 1);
              if (charFont !== figma.mixed && charFont) {
                charFontFamily = isDesc ? 'Arial' : (charFont as FontName).family;
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
                // [스키마 버그 완벽 수정] 파워포인트 DrawingML 규격은 u="sng" 이어야 함 ("single" 방지)
                if (charDeco === 'UNDERLINE') charUnderline = { style: 'sng' };
              }
            } catch (_e) { /* ignore */ }

            return {
              color: charColor,
              bold: charBold,
              italic: charItalic,
              strike: charStrike,
              underline: charUnderline,
              fontFace: charFontFamily,
              fontSize: Math.round(charFontSize * 0.75 * 100) / 100
            };
          };

          const styleKey = (s: CharStyle) =>
            `${s.color}|${s.bold}|${s.italic}|${s.strike}|${JSON.stringify(s.underline)}|${s.fontFace}|${s.fontSize}`;

          const sanitize = (ch: string): string => {
            if (ch === '\u2028' || ch === '\u2029') return '\n';
            // XML 유효 범위 밖의 비표준 제어 문자 필터링
            // eslint-disable-next-line no-control-regex
            ch = ch.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
            if (ch === '<') return '＜';
            if (ch === '>') return '＞';
            if (ch === '&') return '＆';
            if (ch === '"') return '\u201C';
            if (ch === "'") return '\u2019';
            return ch;
          };

          let curStyle: CharStyle | null = null;
          let curText = '';
          let curKey = '';

          for (let idx = 0; idx < chars.length; idx++) {
            const safeChar = sanitize(chars[idx]);
            if (!safeChar) continue;

            const s = styleOf(idx);
            const k = styleKey(s);

            if (curStyle === null || k !== curKey) {
              if (curStyle !== null && curText !== '') {
                textChunks.push({ text: curText, options: curStyle });
              }
              curStyle = s;
              curKey = k;
              curText = safeChar;
            } else {
              curText += safeChar;
            }
          }
          if (curStyle !== null && curText !== '') {
            textChunks.push({ text: curText, options: curStyle });
          }

          const baseZIndex = zIndexMap.get(node.id) || 0;

          elementsData.push({
            type: 'text',
            zIndex: baseZIndex,
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

        elementsData.sort((a, b) => {
          const zDiff = (a.zIndex || 0) - (b.zIndex || 0);
          if (zDiff !== 0) return zDiff;
          const typePriority: { [key: string]: number } = { image: 1, table: 2, text: 3 };
          return (typePriority[a.type] || 0) - (typePriority[b.type] || 0);
        });
        slidesData.push({ name: frame.name, width: frame.width, height: frame.height, backgroundColor: backgroundColor, elements: elementsData });
      }

      const authorName = figma.currentUser ? figma.currentUser.name : 'Figma User';
      figma.ui.postMessage({ type: 'generate-pptx', slides: slidesData, author: authorName });

    } catch (err: any) {
      console.error("Plugin Backend Error:", err);
      figma.ui.postMessage({ type: 'error-occurred', message: err.message || String(err) });
    }
  }
};

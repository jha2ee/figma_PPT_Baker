"use strict";
figma.showUI(__html__, { width: 720, height: 650 });
function getSafeBounds(node) {
    try {
        // 1. 피그마 문서에서 노드가 삭제(파기)되었는지 안전하게 확인
        if (!node || node.removed)
            return null;
        // 2. absoluteBoundingBox 안전 조회
        const nodeBox = node.absoluteBoundingBox ?? { x: node.x, y: node.y, width: node.width, height: node.height };
        if (!nodeBox || typeof nodeBox.width !== 'number' || typeof nodeBox.height !== 'number')
            return null;
        if (nodeBox.width <= 0.1 || nodeBox.height <= 0.1)
            return null;
        const renderBounds = node.absoluteRenderBounds ?? nodeBox;
        return { nodeBox, renderBounds: renderBounds || nodeBox };
    }
    catch (err) {
        // 인스턴스 슬롯 노드가 파기되었거나 접근 불가 시 예외 처리
        return null;
    }
}
function sendSelectionToUI() {
    const selectedNodes = figma.currentPage.selection;
    let frames = selectedNodes.filter(node => node.type === 'FRAME');
    frames.sort((a, b) => {
        if (Math.abs(a.y - b.y) < 50)
            return a.x - b.x;
        return a.y - b.y;
    });
    const frameData = frames.map(f => ({ id: f.id, name: f.name }));
    figma.ui.postMessage({ type: 'selection-changed', frames: frameData });
}
figma.on('selectionchange', sendSelectionToUI);
sendSelectionToUI();
function isClippedByAncestor(node, rootFrame) {
    try {
        if (!node || node.removed)
            return true;
        const nodeBox = node.absoluteBoundingBox;
        if (!nodeBox || nodeBox.width <= 0.1 || nodeBox.height <= 0.1)
            return true;
        let ancestor = node.parent;
        while (ancestor) {
            const anyAncestor = ancestor;
            let hasClip = false;
            // 1. 직접 clipsContent 속성 확인 (C++ 프록시 객체 대응 직접 프로퍼티 접근)
            try {
                if (anyAncestor.clipsContent === true)
                    hasClip = true;
            }
            catch (e) { }
            // 2. 인스턴스인 경우 mainComponent의 clipsContent 확인
            if (!hasClip && anyAncestor.type === 'INSTANCE' && anyAncestor.mainComponent) {
                try {
                    if (anyAncestor.mainComponent.clipsContent === true)
                        hasClip = true;
                }
                catch (e) { }
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
                    if (nodeBox.x + nodeBox.width <= clipBox.x + 0.5 || // 완전히 왼쪽
                        nodeBox.x >= clipRight - 0.5 || // 완전히 오른쪽
                        nodeBox.y + nodeBox.height <= clipBox.y + 0.5 || // 완전히 위쪽 (스크롤되어 헤더 위로 올라간 경우)
                        nodeBox.y >= clipBottom - 0.5 // 완전히 아래쪽 (카드 바깥 아래로 밀려난 경우)
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
                    if (overlapW <= 1 || overlapH <= 1) {
                        return true;
                    }
                    // 3) 중심점(Center) 검사 (중심이 클리핑 상자 밖이면 넘친 콘텐츠로 처리)
                    const centerX = nodeBox.x + nodeBox.width / 2;
                    const centerY = nodeBox.y + nodeBox.height / 2;
                    if (centerX < clipBox.x ||
                        centerX > clipRight ||
                        centerY < clipBox.y ||
                        centerY > clipBottom) {
                        return true;
                    }
                    // 4) 교차 면적 비율 검사 (노드 면적의 50% 이상이 잘려나간 경우)
                    const nodeArea = nodeBox.width * nodeBox.height;
                    const overlapArea = overlapW * overlapH;
                    if (nodeArea > 0 && overlapArea / nodeArea < 0.5) {
                        return true;
                    }
                }
            }
            if (ancestor === rootFrame)
                break;
            ancestor = ancestor.parent;
        }
        return false;
    }
    catch (err) {
        return false;
    }
}
function isNodeVisible(node, frame) {
    // 1. 레이어 가시성(visible) 검사 (부모 체인 포함)
    let current = node;
    while (current) {
        if ('visible' in current && current.visible === false)
            return false;
        if (current === frame)
            break;
        current = current.parent;
    }
    // 2. 넘친 콘텐츠 숨기기(Clip content) 판정
    if ('absoluteBoundingBox' in node) {
        if (isClippedByAncestor(node, frame)) {
            return false;
        }
    }
    return true;
}
function hasVisibleGraphic(node) {
    if ('fills' in node || 'strokes' in node || 'effects' in node) {
        const anyNode = node;
        const hasFills = Array.isArray(anyNode.fills) && anyNode.fills.some((f) => f.visible !== false && f.opacity > 0);
        const hasStrokes = Array.isArray(anyNode.strokes) && anyNode.strokes.some((s) => s.visible !== false && s.opacity > 0);
        const hasEffects = Array.isArray(anyNode.effects) && anyNode.effects.some((e) => e.visible !== false);
        return hasFills || hasStrokes || hasEffects;
    }
    return false;
}
function checkIsBakedBoundary(node, boundaries) {
    if (!node || !node.name)
        return false;
    const name = node.name.toLowerCase().trim();
    return boundaries.some((b) => name.includes(b));
}
function isIconFontTextNode(node) {
    try {
        const iconKeywords = ['fontawesome', 'material', 'icon', 'symbol', 'remix', 'phosphor'];
        if (node.fontName === figma.mixed) {
            for (let i = 0; i < node.characters.length; i++) {
                const font = node.getRangeFontName(i, i + 1);
                if (font !== figma.mixed) {
                    const family = font.family.toLowerCase().replace(/\s/g, '');
                    if (iconKeywords.some(keyword => family.includes(keyword)))
                        return true;
                }
            }
            return false;
        }
        else {
            const fontName = node.fontName;
            if (!fontName || !fontName.family)
                return false;
            const family = fontName.family.toLowerCase().replace(/\s/g, '');
            return iconKeywords.some(keyword => family.includes(keyword));
        }
    }
    catch (e) {
        return false;
    }
}
figma.ui.onmessage = async (msg) => {
    if (msg.type === 'export-ppt') {
        try {
            const { orderedIds, boundaryNames, textKeywords, imageKeywords, tableKeywords, extractNested } = msg;
            const boundaries = boundaryNames.map((b) => b.trim().toLowerCase()).filter(Boolean);
            const textKeys = textKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
            const imageKeys = imageKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
            const tableKeys = tableKeywords ? tableKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean) : [];
            const allSelectedFrames = figma.currentPage.selection.filter(node => node.type === 'FRAME');
            let initialFrames = orderedIds.map((id) => allSelectedFrames.find(f => f.id === id)).filter(Boolean);
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
                let backgroundColor = null;
                if (Array.isArray(frame.fills)) {
                    for (const fill of frame.fills) {
                        if (fill.visible !== false && fill.type === 'SOLID' && (fill.opacity === undefined || fill.opacity > 0)) {
                            const toHex = (c) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                            backgroundColor = (toHex(fill.color.r) + toHex(fill.color.g) + toHex(fill.color.b)).toUpperCase();
                        }
                    }
                }
                const frameBox = frame.absoluteBoundingBox ?? { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
                let currentZIndex = 0;
                const zIndexMap = new Map();
                function assignZIndex(n) {
                    zIndexMap.set(n.id, currentZIndex++);
                    if ('children' in n) {
                        for (const child of n.children) {
                            assignZIndex(child);
                        }
                    }
                }
                assignZIndex(frame);
                const targetTableNodes = frame.findAll(node => {
                    if (!isNodeVisible(node, frame))
                        return false;
                    const name = node.name.toLowerCase().trim();
                    return tableKeys.some((k) => name.includes(k));
                });
                const targetTextNodes = frame.findAll(node => {
                    if (node.type !== 'TEXT')
                        return false;
                    if (!isNodeVisible(node, frame))
                        return false;
                    const tNode = node;
                    if (isIconFontTextNode(tNode))
                        return false;
                    let isDesc = false, inNumbering = false, inBakedBoundary = false, inTable = false;
                    let currNode = node;
                    while (currNode && currNode !== frame) {
                        const pName = currNode.name.toLowerCase().trim();
                        if (textKeys.some((k) => pName.includes(k)))
                            isDesc = true;
                        if (imageKeys.some((k) => pName.includes(k)))
                            inNumbering = true;
                        if (tableKeys.some((k) => pName.includes(k)))
                            inTable = true;
                        if (checkIsBakedBoundary(currNode, boundaries))
                            inBakedBoundary = true;
                        currNode = currNode.parent;
                    }
                    if (inTable)
                        return false;
                    if (inNumbering)
                        return false;
                    if (isDesc)
                        return true;
                    return !inBakedBoundary;
                });
                const targetImageNodes = [];
                function collectImages(node, hasCapturedParent) {
                    if (!isNodeVisible(node, frame))
                        return;
                    const name = node.name.toLowerCase().trim();
                    const isTable = tableKeys.some((k) => name.includes(k));
                    if (isTable)
                        return;
                    const isIconFontText = node.type === 'TEXT' && isIconFontTextNode(node);
                    if (node.type === 'TEXT' && targetTextNodes.includes(node))
                        return;
                    const isCustomImageKey = imageKeys.some((k) => name.includes(k));
                    const isBakedBoundary = checkIsBakedBoundary(node, boundaries);
                    let isCapturedHere = false;
                    if (isCustomImageKey || isIconFontText) {
                        if (!targetImageNodes.includes(node))
                            targetImageNodes.push(node);
                        isCapturedHere = true;
                    }
                    else if (isBakedBoundary) {
                        if (!targetImageNodes.includes(node))
                            targetImageNodes.push(node);
                        isCapturedHere = true;
                        if (!extractNested)
                            return;
                    }
                    if ('children' in node && node.type !== 'BOOLEAN_OPERATION') {
                        if (!isCapturedHere && !hasCapturedParent) {
                            if (hasVisibleGraphic(node) || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
                                if (!targetImageNodes.includes(node)) {
                                    targetImageNodes.push(node);
                                    isCapturedHere = true;
                                }
                            }
                        }
                        for (const child of node.children) {
                            collectImages(child, hasCapturedParent || isCapturedHere);
                        }
                    }
                    else {
                        if (!hasCapturedParent && !isCapturedHere) {
                            if (hasVisibleGraphic(node) || node.type === 'BOOLEAN_OPERATION') {
                                if (!targetImageNodes.includes(node)) {
                                    targetImageNodes.push(node);
                                }
                            }
                        }
                    }
                }
                for (const child of frame.children) {
                    collectImages(child, false);
                }
                const allHiddenImageKeysNodes = frame.findAll(node => {
                    if (!isNodeVisible(node, frame))
                        return false;
                    const name = node.name.toLowerCase().trim();
                    return imageKeys.some((k) => name.includes(k));
                });
                for (const node of allHiddenImageKeysNodes) {
                    if (!targetImageNodes.includes(node))
                        targetImageNodes.push(node);
                }
                const elementsData = [];
                for (const tableNode of targetTableNodes) {
                    if (isClippedByAncestor(tableNode, frame))
                        continue;
                    const bounds = getSafeBounds(tableNode);
                    if (!bounds)
                        continue;
                    const tBox = bounds.nodeBox;
                    const tableRowsData = [];
                    const rows = tableNode.children.filter(n => n.type === 'FRAME' || n.type === 'GROUP');
                    for (const row of rows) {
                        const rowCellsData = [];
                        const cells = ('children' in row) ? row.children : [];
                        for (const cell of cells) {
                            let cellText = '';
                            let fillColor = 'FFFFFF';
                            let borders = [{ pt: 0, color: 'FFFFFF' }, { pt: 0, color: 'FFFFFF' }, { pt: 0, color: 'FFFFFF' }, { pt: 0, color: 'FFFFFF' }];
                            if ('fills' in cell && Array.isArray(cell.fills) && cell.fills.length > 0) {
                                const fill = cell.fills.find(f => f.type === 'SOLID' && f.visible !== false);
                                if (fill) {
                                    const toHex = (c) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                                    fillColor = (toHex(fill.color.r) + toHex(fill.color.g) + toHex(fill.color.b)).toUpperCase();
                                }
                            }
                            if ('strokeWeight' in cell) {
                                const anyCell = cell;
                                const hasStrokes = Array.isArray(anyCell.strokes) && anyCell.strokes.length > 0 && anyCell.strokes[0].visible !== false;
                                let strokeColor = 'CCCCCC';
                                if (hasStrokes) {
                                    const sPaint = anyCell.strokes[0];
                                    if (sPaint.type === 'SOLID') {
                                        const toHex = (c) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
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
                            const textNode = ('findAll' in cell) ? cell.findAll((n) => n.type === 'TEXT')[0] : null;
                            if (textNode)
                                cellText = textNode.characters || '';
                            rowCellsData.push({
                                text: cellText,
                                options: { fill: fillColor, border: borders, margin: 2, valign: 'middle' }
                            });
                        }
                        if (rowCellsData.length > 0)
                            tableRowsData.push(rowCellsData);
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
                    if (isClippedByAncestor(node, frame))
                        continue;
                    const bounds = getSafeBounds(node);
                    if (!bounds)
                        continue;
                    const { nodeBox, renderBounds } = bounds;
                    if (renderBounds.width <= 0.1 || renderBounds.height <= 0.1)
                        continue;
                    const innerNodesToHide = [];
                    if ('findAll' in node) {
                        try {
                            const found = node.findAll((inner) => {
                                if (!inner || inner.removed)
                                    return false;
                                if (inner === node)
                                    return false;
                                if (targetImageNodes.includes(inner))
                                    return true;
                                if (targetTextNodes.includes(inner))
                                    return true;
                                return false;
                            });
                            innerNodesToHide.push(...found);
                        }
                        catch (e) { }
                    }
                    const innerOpacityMap = new Map();
                    for (const innerNode of innerNodesToHide) {
                        if (innerNode && !innerNode.removed && 'opacity' in innerNode) {
                            try {
                                innerOpacityMap.set(innerNode, innerNode.opacity);
                                innerNode.opacity = 0;
                            }
                            catch (e) { }
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
                    }
                    catch (e) {
                        console.error("Export failed:", node.name, e);
                    }
                    finally {
                        for (const innerNode of innerNodesToHide) {
                            if (innerNode && !innerNode.removed && 'opacity' in innerNode && innerOpacityMap.has(innerNode)) {
                                try {
                                    innerNode.opacity = innerOpacityMap.get(innerNode) ?? 1;
                                }
                                catch (e) { }
                            }
                        }
                    }
                }
                for (const node of targetTextNodes) {
                    if (isClippedByAncestor(node, frame))
                        continue;
                    const bounds = getSafeBounds(node);
                    if (!bounds)
                        continue;
                    const nodeBox = bounds.nodeBox;
                    let isDesc = false;
                    let currNode = node;
                    while (currNode && currNode !== frame) {
                        const pName = currNode.name.toLowerCase().trim();
                        if (textKeys.some((k) => pName.includes(k)))
                            isDesc = true;
                        currNode = currNode.parent;
                    }
                    let autoWrap = node.textAutoResize !== 'WIDTH_AND_HEIGHT';
                    let align = 'left';
                    if (node.textAlignHorizontal === 'CENTER')
                        align = 'center';
                    else if (node.textAlignHorizontal === 'RIGHT')
                        align = 'right';
                    let valign = 'top';
                    if (node.textAlignVertical === 'CENTER')
                        valign = 'middle';
                    else if (node.textAlignVertical === 'BOTTOM')
                        valign = 'bottom';
                    let figmaLh = 1.2;
                    if (node.lineHeight !== figma.mixed) {
                        if (node.lineHeight.unit === 'PERCENT') {
                            figmaLh = node.lineHeight.value / 100;
                        }
                        else if (node.lineHeight.unit === 'PIXELS') {
                            const fSize = typeof node.fontSize === 'number' ? node.fontSize : 14;
                            figmaLh = node.lineHeight.value / fSize;
                        }
                        else if (node.lineHeight.unit === 'AUTO') {
                            figmaLh = 1.2;
                        }
                    }
                    let lhMultiple = figmaLh / 1.2;
                    const textChunks = [];
                    const chars = node.characters;
                    const toHex2 = (c) => { const hex = Math.round(c * 255).toString(16); return hex.length === 1 ? '0' + hex : hex; };
                    const styleOf = (idx) => {
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
                                const fill = charFill.find((f) => f.type === 'SOLID' && f.visible !== false);
                                if (fill) {
                                    charColor = (toHex2(fill.color.r) + toHex2(fill.color.g) + toHex2(fill.color.b)).toUpperCase();
                                }
                            }
                            const charFont = node.getRangeFontName(idx, idx + 1);
                            if (charFont !== figma.mixed && charFont) {
                                charFontFamily = isDesc ? 'Arial' : charFont.family;
                                const style = charFont.style.toLowerCase();
                                if (style.includes('bold') || style.includes('black'))
                                    charBold = true;
                                if (style.includes('italic'))
                                    charItalic = true;
                            }
                            const charSize = node.getRangeFontSize(idx, idx + 1);
                            if (charSize !== figma.mixed && typeof charSize === 'number') {
                                charFontSize = charSize;
                            }
                            const charDeco = node.getRangeTextDecoration(idx, idx + 1);
                            if (charDeco !== figma.mixed) {
                                if (charDeco === 'STRIKETHROUGH')
                                    charStrike = true;
                                if (charDeco === 'UNDERLINE')
                                    charUnderline = { style: 'single' };
                            }
                        }
                        catch (e) { }
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
                    const styleKey = (s) => `${s.color}|${s.bold}|${s.italic}|${s.strike}|${JSON.stringify(s.underline)}|${s.fontFace}|${s.fontSize}`;
                    const sanitize = (ch) => {
                        if (ch === '\u2028' || ch === '\u2029')
                            return '\n';
                        ch = ch.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
                        if (ch === '<')
                            return '＜';
                        if (ch === '>')
                            return '＞';
                        if (ch === '&')
                            return '＆';
                        if (ch === '"')
                            return '\u201C';
                        if (ch === "'")
                            return '\u2019';
                        return ch;
                    };
                    let curStyle = null;
                    let curText = '';
                    let curKey = '';
                    for (let idx = 0; idx < chars.length; idx++) {
                        const safeChar = sanitize(chars[idx]);
                        if (!safeChar)
                            continue;
                        const s = styleOf(idx);
                        const k = styleKey(s);
                        if (curStyle === null || k !== curKey) {
                            if (curStyle !== null && curText !== '') {
                                textChunks.push({ text: curText, options: curStyle });
                            }
                            curStyle = s;
                            curKey = k;
                            curText = safeChar;
                        }
                        else {
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
                    if (zDiff !== 0)
                        return zDiff;
                    const typePriority = { image: 1, table: 2, text: 3 };
                    return (typePriority[a.type] || 0) - (typePriority[b.type] || 0);
                });
                slidesData.push({ name: frame.name, width: frame.width, height: frame.height, backgroundColor: backgroundColor, elements: elementsData });
            }
            const authorName = figma.currentUser ? figma.currentUser.name : 'Figma User';
            figma.ui.postMessage({ type: 'generate-pptx', slides: slidesData, author: authorName });
        }
        catch (err) {
            console.error("Plugin Backend Error:", err);
            figma.ui.postMessage({ type: 'error-occurred', message: err.message || String(err) });
        }
    }
};

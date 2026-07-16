# 🍞 Figma PPT Baker (Figma2PPT)

**Figma PPT Baker**는 피그마(Figma)로 작성된 화면 정의서와 기획서를 단 한 번의 클릭으로 완벽한 파워포인트(PPTX) 문서로 변환해 주는 커스텀 피그마 플러그인입니다. 

피그마의 디자인을 PPT로 옮기기 위해 캡처하고 텍스트를 복사 붙여넣기 하던 기획자/디자이너의 단순 반복 업무(노가다)를 0으로 만들어 줍니다.

---

### ✨ 핵심 기능 (Key Features)

* **📏 완벽한 1:1 레이아웃 매칭 엔진**
  * 글로벌 타이포그래피 표준 변환 공식(`1px = 0.75pt`)을 적용하여 피그마 원본과 100% 동일한 글자 크기를 구현합니다.
  * 파워포인트의 자의적인 줄 간격 팽창을 막고, 피그마의 줄 간격(Line Height)을 상대 배율로 정밀하게 동기화합니다.
  * 텍스트가 표 영역을 벗어나지 않도록 PPT 네이티브의 자동 축소(`fit: 'shrink'`) 기능과 완벽하게 연동됩니다.

* **🍕 스마트 하이브리드 추출 (Auto-Baking)**
  * **통이미지 굽기:** 레이어 이름에 특정 키워드(`panel`, `container` 등)가 포함된 경우, 복잡한 표와 하이라이트 도형들을 하나로 병합하여 슬라이드 배경 이미지로 깔끔하게 구워냅니다.
  * **라이브 텍스트 분리:** 기획서 본문(`desc_`, `description`)은 이미지로 굽지 않고 PPT에서 즉시 편집 가능한 진짜 '텍스트 상자'로 추출합니다.
  * **단독 이미지 분리:** 화면 정의서의 번호 뱃지나 아이콘(`numbering`, `icon`) 등은 배경에 섞이지 않고 위치 이동이 가능한 개별 투명 PNG로 추출하여 최상단에 배치합니다.

* **🗂️ 중첩 컨테이너(Nested Container) 인식 옵션**
  * 컨테이너 내부에 또 다른 컨테이너가 있을 경우, 이를 인식하여 각각 독립된 배경 이미지로 정교하게 분리해 내는 옵션을 제공합니다.

* **🖱️ 직관적인 드래그 앤 드롭 UI**
  * 피그마에서 선택한 프레임들의 순서를 변환 전에 UI에서 마우스 드래그로 손쉽게 재배치할 수 있습니다.

---

### 🚀 사용 가이드 (How to Use)

플러그인이 레이어를 똑똑하게 분류할 수 있도록 피그마 레이어 이름을 아래 규칙에 맞게 지정해 주세요. (플러그인 UI에서 키워드는 자유롭게 커스텀 가능합니다.)

1. **`container` 또는 `panel`:** 표 배경, 테두리, 하이라이트 배경색 등 클릭 불가한 배경으로 묶어서 구워버릴 그룹/프레임
2. **`desc_` 또는 `description`:** PPT로 넘어가서 글자를 수정해야 하는 실제 기획 내용 텍스트 상자
3. **`numbering` 또는 `icon`:** 배경에 합치지 않고 텍스트 위에 동동 띄워놓을 번호표나 아이콘

---

### 💻 설치 및 실행 방법 (Installation for Development)

본 플러그인은 로컬 개발 환경에서 실행 가능합니다.

1. 저장소를 로컬 PC로 클론(Clone)합니다.
   ```bash
   git clone [https://github.com/사용자명/figma_PPT_Baker.git](https://github.com/사용자명/figma_PPT_Baker.git)
   cd figma_PPT_Baker
   ```

2. 패키지 의존성을 설치합니다.
   ```bash
   npm install
   ```

3. TypeScript 파일을 JavaScript로 컴파일합니다. (또는 `npm run build` 스크립트 실행)
   ```bash
   npx tsc
   ```

4. Figma 데스크톱 앱을 열고 메뉴에서 **Plugins > Development > Import plugin from manifest...** 를 클릭한 후, 프로젝트 폴더의 `manifest.json` 파일을 선택합니다.

---

### 🛠️ 기술 스택 (Tech Stack)

* **Frontend:** HTML, CSS, Vanilla JavaScript
* **Logic:** TypeScript, Figma Plugin API
* **Library:** PptxGenJS (PPTX 파일 생성 엔진)

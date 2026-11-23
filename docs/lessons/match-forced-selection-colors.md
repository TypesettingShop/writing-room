# 강제 색상에서 선택 배경과 그 위에 그리는 요소의 시스템 색을 맞춘다

## What happened

- Characters의 선택 행은 강제 색상에서 배경을 `Highlight`로 칠했다. 글자와 유형 아이콘은 `HighlightText`를 썼지만, 행의 트리 줄은 일반 행과 같은 `CanvasText`를 썼다. 리뷰에서 선택 행의 트리 줄도 `HighlightText`를 쓰도록 고쳤다.

## Why

- `forced-color-adjust: none`을 적용한 요소는 브라우저의 색 보정을 받지 않는다. 트리 줄의 배경과 마스크의 채움처럼 직접 그리는 요소는 자기 뒤의 표면에 맞춘 전경색을 지정해야 한다.

## Do this instead

- 강제 색상에서 직접 칠하는 표면은 `Canvas`와 `CanvasText`, 선택 표면은 `Highlight`와 `HighlightText`를 한 쌍으로 쓴다.
- 선택 상태의 배경을 바꿀 때 글자뿐 아니라 그 위의 마스크, 유사 요소, 트리 줄도 확인한다. 강제 색상 브라우저에서 같은 요소의 선택 상태와 일반 상태를 모두 확인한다.

Learned in: wr-4snv.kmr

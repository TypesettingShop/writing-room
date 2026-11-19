# 처음 여는 텍스트 모델을 기다리는 e2e는 Monaco 로드를 셈에 넣는다

## What happened

- custom-editor.spec.ts가 Custom Text Editor의 첫 Webview 내용을 expect 기본 5초로 기다렸다. 부하가 높을 때 55행·150행 테스트가 절반쯤 실패했고(wr-epmc, wr-9i4l), 화면에는 "Restoring Webview…"만 보였다.
- 계측하니 멈춤이 아니었다: 공급자에게 묻기 전 `acquireModel`에서 1~4초를 썼다. 텍스트 모델이 Monaco 모델이라 페이지의 첫 모델이 Monaco를 불러오기 때문이다(개발 서버에서 모듈 수백 개).

## Why

- "Custom Editor는 Webview일 뿐"이라는 전제로 시간을 잡았다. 텍스트 종류는 텍스트 에디터와 같은 모델을 쓰므로 첫 텍스트 에디터와 같은 비용을 낸다. 자기 문서를 가진 에디터(Monaco가 필요 없다)는 0.3~0.7초라 같은 파일 안의 다른 테스트는 통과해서 가려졌다.

## Do this instead

- 페이지에서 처음 텍스트 모델을 만드는 단계(텍스트 에디터, Custom Text Editor, 문서를 여는 확장 API)를 기다리는 단언은 `expectEditorText`처럼 20초를 준다.
- 불안정한 대기는 시간을 늘리기 전에 단계마다 `performance.now()`를 찍어 어디서 시간이 가는지 먼저 본다. 멈춤이면 시간을 늘려도 실패하고, 기다림이면 `--repeat-each`로 늘린 시간에서 모두 통과한다.

Learned in: wr-ibv9.j15

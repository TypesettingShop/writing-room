# 워크벤치 키바인딩과 겨루는 키 판정은 물리 키(code)도 본다

## What happened

- Webview 셸이 입력 칸 안의 실행 취소 키를 워크벤치로 보내지 않게 하면서 `event.key`(입력한 글자)만 보았다(wr-wxe1).
- 워크벤치의 키바인딩 서비스는 물리 키(`event.code`)로 맞춘다. 러시아어·그리스어·히브리어 배열에서 Ctrl+Z는 `key`가 'я' 같은 글자라 판정을 빠져나가 워크벤치의 Undo까지 불렀다. 에픽 끝 리뷰 wr-ibv9.j15의 #1.

## Why

- 키를 가로채거나 넘기는 판정이 워크벤치의 판정과 다른 축을 보면, 어떤 배열에서는 둘이 갈린다. 미국 배열에서만 테스트하면 `key`와 `code`가 늘 같이 맞아 드러나지 않는다.

## Do this instead

- 워크벤치 단축키와 같은 키를 거르는 코드는 `event.code`(물리 키)와 `event.key`(글자)를 둘 다 본다: 브라우저나 칸은 글자로, 워크벤치는 물리 키로 반응한다.
- e2e는 배열이 다른 키를 CDP `Input.dispatchKeyEvent`로 보낸다(`key: 'я', code: 'KeyZ'`). `page.keyboard`는 미국 배열 키만 만든다.

Learned in: wr-ibv9.j15

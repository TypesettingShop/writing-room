# 확장 API 값의 RPC 왕복을 검증한다

## What happened

- `RelativePattern`의 `base`와 `baseUri`는 접근자 뒤의 비공개 상태였다. 메시지 포트를 왕복한 값에는 `pattern`만 남았다 (wr-efqx.6ek #19).

## Why

- 구조화 복제는 일반 클래스의 열거 가능한 자체 프로퍼티를 전달한다. 호출자가 직접 읽을 수 있는 속성이라도 프로토타입의 접근자나 비공개 필드에만 있으면 전송 레코드에서 사라질 수 있다.

## Do this instead

- 공용 API 값이 프로세스 경계를 넘을 때 수신자가 사용하는 필드를 전송 형태에 포함한다. 테스트는 실제 메시지 포트와 RPC를 사용해 값과 URI 같은 복원 타입을 함께 확인한다.

Learned in: wr-efqx.6ek

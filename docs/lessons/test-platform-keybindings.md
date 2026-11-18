# 단축키의 플랫폼별 해석을 테스트한다

## What happened

- 사이드바와 패널 토글을 문자열 Ctrl+B/Ctrl+J로 등록했다. Linux Chromium 스펙은 통과했지만 macOS에서 Cmd+B/Cmd+J가 동작하지 않았고, Ctrl+B를 처리할 때 편집기의 기본 이동 단축키를 가로챘다. wr-hze8.zzw의 3번에서 확인했다.

## Why

- 키 문자열의 Ctrl은 물리 수정자다. macOS의 기본 커맨드 수정자에 대응하는 `KeyMod.CtrlCmd`와 현재 플랫폼에서만 같은 결과가 나온다.

## Do this instead

- 기본 커맨드 수정자를 쓸 단축키는 `KeyMod.CtrlCmd`로 선언한다. 브라우저 테스트는 `ControlOrMeta`를 사용하고, 저장소의 키바인딩 리졸버를 macOS와 Linux 설정으로 각각 실행해 등록한 커맨드의 수정자를 단언한다.

Learned in: wr-hze8.zzw

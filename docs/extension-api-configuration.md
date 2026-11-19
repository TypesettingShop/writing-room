# 설정 기여

설정 선언, 값 읽기와 변경 이벤트의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

## 설정이 있는 곳

설정 대상은 사용자 설정 하나다. 원문은 v0.1.0처럼 프로필 스토리지의 `user.settings.json` 키에 JSONC 텍스트로 있고, 편집기에서는 `vscode-userdata:/User/settings.json`(**Preferences: Open User Settings (JSON)**)으로 연다. 워크스페이스 설정 파일과 폴더 설정은 없다.

값은 네 층에서 온다.

| 층 | 어디서 |
| --- | --- |
| 기본 | 워크벤치나 확장이 등록한 속성의 `default`. 확장의 `configurationDefaults`가 일반 키에 준 값이 있으면 그것 |
| 언어별 기본 | 확장의 `configurationDefaults`에 있는 `"[markdown]": { ... }` 같은 언어 구역 |
| 사용자 | `settings.json`의 키 |
| 언어별 사용자 | `settings.json`의 언어 구역. `"[markdown][plaintext]": { ... }`처럼 여러 언어를 한 구역에 적을 수 있고, 같은 언어가 여러 구역에 있으면 뒤의 구역이 이기지만, 언어 하나만 적은 구역(`"[markdown]"`)은 위치와 상관없이 여러 언어를 적은 구역을 이긴다(VS Code와 같다. 확장의 언어별 쓰기는 이 구역에 들어간다) |

언어를 정해 읽으면 그 언어의 값이 모든 언어의 값을 이기고, 같은 종류 안에서는 사용자가 기본을 이긴다. 우선순위는 언어별 사용자, 언어별 기본, 사용자, 기본 순이다. 그래서 확장이 `[markdown]`에 준 `editor.wordWrap: "on"`은 사용자가 모든 언어에 쓴 `"editor.wordWrap": "off"`를 markdown 문서에서 이긴다. 사용자가 markdown에서도 끄려면 `"[markdown]": { "editor.wordWrap": "off" }`를 쓴다. VS Code와 같다.

텍스트 에디터는 보이는 모델의 언어로 `editor.*` 옵션과 탭 크기를 읽는다. 같은 칸이 다른 언어의 모델을 보이거나 모델의 언어가 바뀌면 다시 읽는다. 언어 구역에 쓸 수 있는 워크벤치 설정은 `editor.fontSize`, `editor.tabSize`, `editor.wordWrap`, `editor.lineNumbers`, `editor.minimap.enabled`, `editor.quickSuggestions`다.

## 값의 검사

설정 서비스는 값을 얕게 검사한다: 타입(하나 또는 `["boolean", "integer"]` 같은 목록), `enum`, 수의 `minimum`과 `maximum`. 맞지 않는 사용자 값은 없는 것으로 보고 다음 층이 보인다. `items`, `properties`, `pattern` 같은 나머지 스키마는 `settings.json` 편집기의 진단만 본다.

`settings.json`의 구문이 깨지면 마지막으로 유효했던 값을 계속 쓴다. 아무도 등록하지 않은 키는 원문에 그대로 남고, 나중에 그 키가 등록되면 값이 살아난다. 확장을 제거하면 그 확장이 등록한 키와 기본값이 빠지고 읽기는 `undefined`가 되며, 사용자가 써 둔 값은 원문에 남는다.

## `contributes.configuration`과 `contributes.configurationDefaults`

`configuration`은 객체 하나나 객체 배열이다. 각 마디는 `title`, `order`, `properties`를 갖는다. 속성은 `type`(`string`, `number`, `integer`, `boolean`, `array`, `object`, `null` 또는 그 목록), `default`, `description`, `markdownDescription`, `enum`, `enumDescriptions`, `markdownEnumDescriptions`, `minimum`, `maximum`, `pattern`, `items`, `properties`, `additionalProperties`, `scope`, `deprecationMessage`, `order`를 받는다. `default`가 없으면 첫 타입의 기본(`""`, `0`, `false`, `[]`, `{}`, `null`)이다.

- 다른 확장이나 워크벤치가 이미 등록한 키는 건너뛰고, 확장의 메시지에 `Cannot register '<키>'. This property is already registered by '<먼저 등록한 쪽>'.`을 남긴다. 먼저 등록한 쪽이 이긴다. 내장 확장이 먼저, 그다음 설치 순이다.
- 키에 `__proto__`, `prototype`, `constructor` 조각이 있으면 그 속성만 건너뛰고 경고한다. `default`가 자기 타입에 맞지 않아도(`type: "string"`, `default: null`) VS Code처럼 경고 없이 그 값을 기본으로 등록한다. 키가 `[언어]` 꼴이면 언어 구역은 `configurationDefaults`로 기여하라는 경고와 함께 건너뛴다. 나머지 속성은 등록된다. 마디 자체의 모양이 틀리면(`title`이 문자열이 아니거나 `properties`가 객체가 아니면) 그 마디만 오류로 건너뛴다.
- 메시지는 확장의 상태와 개발자 콘솔에 `contributes.configuration.properties.<키>` 경로로 남는다.

`configurationDefaults`는 일반 키나 언어 구역의 기본값을 바꾼다. 등록된 속성의 타입에 맞지 않는 값은 건너뛰고 경고한다. 아직 등록되지 않은 키의 기본값은 그 키가 등록될 때 적용된다. 여러 확장이 같은 키를 바꾸면 나중에 등록한 쪽이 이긴다.

`settings.json` 편집기의 자동 완성과 진단은 등록된 속성에서 만든 스키마를 쓴다. 언어 구역 안의 키도 안다. 확장을 설치하거나 제거하면 스키마를 다시 만든다. 매니페스트 문자열의 `%키%`는 지역화가 풀기 전에는 원문 그대로 보인다.

## `workspace.getConfiguration`

```js
const lint = vscode.workspace.getConfiguration('markdownlint', document);
const config = lint.get('config');
context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
  if (event.affectsConfiguration('markdownlint', document)) { /* 다시 읽는다 */ }
}));
await vscode.workspace.getConfiguration('markdown.preview').update('fontSize', 16);
```

- 확장 호스트는 설정의 사본을 가진다. 시작할 때 전체를 받고 그 뒤로는 바뀐 키만 받는다. 읽기는 동기다.
- `scope`가 문서나 `{ languageId }`이면 그 언어로 읽는다. `Uri`나 워크스페이스 폴더는 받지만 값에 영향이 없다.
- `get`, `has`, 구역 속성 읽기(`lint.config`)가 돌려주는 값은 깊이 얼린 복제본이다. 고치려 하면 엄격 모드 코드(`"use strict"`로 시작하는 TypeScript 출력 등)에서는 `TypeError`가 나고 엄격 모드가 아니면 조용히 무시되며, 어느 쪽이든 사본과 다음 읽기는 바뀌지 않는다.
- `inspect(key)`는 `defaultValue`, `globalValue`, `defaultLanguageValue`, `globalLanguageValue`, `languageIds`를 채운다. `workspace*` 칸은 늘 `undefined`다.
- `update(key, value, target?, overrideInLanguage?)`는 사용자 설정의 그 키만 고친다. 주석, 끝 쉼표, 모르는 키, 다른 키는 그대로다. `value`가 `undefined`이면 키를 지운다. `target`은 `ConfigurationTarget.Global`, `true`, `null`이거나 없을 때 사용자 설정이다. 언어 범위로 얻은 설정에서 `overrideInLanguage: true`면 언어 구역에, `false`면 모든 언어에 쓰고, 없으면 사용자가 그 언어에 이미 값을 두었을 때만 언어 구역에 쓴다. `await` 뒤의 읽기는 새 값이다.
- 거부되는 쓰기: `ConfigurationTarget.Workspace`, `false`, `ConfigurationTarget.WorkspaceFolder`(`Unable to write to Workspace Settings because this release does not support workspace settings.`), 등록되지 않은 키(`Unable to write to User Settings because <키> is not a registered configuration.`), 스키마의 얕은 검사에 맞지 않는 값, 함수나 순환이 든 값.
- 설정 탭에 저장하지 않은 초안이 있을 때 확장이 쓰면, 저장된 원문은 바뀌고 초안은 그대로 남는다(v0.1.0의 다른 탭 저장과 같다).

## `workspace.onDidChangeConfiguration`

사용자 원문이 바뀌거나 확장의 설치와 제거로 기본값이 바뀌어 값이 달라지면 낸다. 사본을 고친 뒤에 내므로 리스너 안의 `getConfiguration`은 새 값을 본다. `affectsConfiguration(section)`은 바뀐 키가 `section`이거나 그 아래일 때 참이다(`markdown`, `markdown.preview`는 `markdown.preview.fontSize`의 변경을 본다). 범위에 언어를 주면 그 언어로 읽은 값이 실제로 달라졌을 때만 참이다. 비활성화되거나 제거된 확장의 리스너에는 더 이상 이벤트가 가지 않는다.

## Deviations from VS Code

- 설정 대상은 사용자 설정 하나다. `update`의 대상이 없으면 사용자 설정에 쓴다. VS Code는 대상이 없으면 워크스페이스에 쓰고, 워크스페이스가 없으면 오류다 — 이 릴리스에는 워크스페이스 설정이 없다 (wr-jbmd, wr-k5o0.ze2).
- 아무도 등록하지 않은 키는 읽을 수 없다(`undefined`). 원문에는 남는다. VS Code는 등록되지 않은 키의 사용자 값도 돌려준다 — v0.1.0의 "등록된 설정만 적용한다"를 지킨다 (wr-k5o0.242).
- 타입이나 `enum`, 범위에 맞지 않는 사용자 값은 기본값으로 물러서고, 그런 값의 `update`는 거부한다. VS Code는 값을 그대로 쓰고 편집기 진단으로만 알린다 — v0.1.0의 검증 규칙을 유지한다 (wr-k5o0.242).
- 객체 값은 층 사이에서 합치지 않는다. 사용자의 객체가 기본 객체를 통째로 이긴다. VS Code는 객체 값을 층마다 깊이 합친다 — 확장이 읽는 값이 원문과 같게 하려고 플래너가 정했다 (wr-k5o0.242).
- 언어 구역은 등록된 모든 키를 받는다. `settings.json` 스키마도 언어 구역에 모든 속성을 둔다. VS Code의 스키마는 `scope`가 `language-overridable`인 속성만 언어 구역에 둔다 — 읽기 규칙과 스키마를 하나로 맞췄다 (wr-k5o0.xqs).
- `get`과 구역 속성이 돌려주는 객체와 배열은 깊이 얼린 복제본이다. VS Code는 고칠 수 있는 사본(쓰면 복제하는 프록시)을 돌려주므로, 읽은 객체를 고쳐 쓰는 확장은 엄격 모드에서 `TypeError`를 만난다 — 확장이 고쳐도 사본이 바뀌지 않게 했다 (wr-k5o0.ze2).
- 이름 없이 `getConfiguration()`으로 읽은 전체 값에는 `[언어]` 구역이 속성으로 들어 있지 않다. 언어 값은 언어 범위로 읽는다 (wr-k5o0.ze2).

Decided in: wr-efqx.n9k, wr-k5o0

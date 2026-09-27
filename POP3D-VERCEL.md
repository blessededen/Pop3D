# Pop3D GitHub → Vercel 연결 준비

계정 로그인과 프로젝트 저장용 Vercel 함수 진입점, Neon Postgres 어댑터를 준비한 상태다. 실제 GitHub 업로드·Vercel 배포·외부 DB 생성은 아직 하지 않았다. 현재 Git 원격 저장소가 등록되어 있지 않다.

## 준비된 구조

- Vite 정적 화면: `npm run build` → `dist`
- 서버 API: `api/handler.ts` → 기존 `server/api.ts`
- 경로 연결: `vercel.json`의 `/api/:path*` rewrite. 화면은 `#/` 해시 라우터이므로 모든 URL을 HTML로 보내는 rewrite는 추가하지 않는다.
- Node 버전: `package.json`의 `24.x`
- 로컬 저장: `.data/accounts.sqlite`
- 배포 저장: `DATABASE_URL`이 지정한 Neon Postgres. 초기 연결 시 테이블을 생성한다. Pop3D 전용 DB를 사용한다.

## 연결 순서

1. GitHub 저장소를 정하고 현재 프로젝트를 올린다. `.env.local`, `.data`, `.vercel`, `node_modules`, PDF 샘플 출력은 Git에서 제외되어 있다. 실제 키·사용자 DB를 저장소에 넣지 않는다.
2. Vercel에서 해당 GitHub 저장소를 Import한다. Framework는 Vite, Root Directory는 이 프로젝트 루트, Build Command는 `npm run build`, Output Directory는 `dist`, Node는 24.x다.
3. Neon 프로젝트/DB를 마련해 Vercel 프로젝트의 **Environment Variables**에 아래 값을 넣는다. 연결 문자열은 채팅·코드에 붙이지 말고 Vercel 환경변수에 입력한다.
4. 고정된 배포 도메인이 정해지면 카카오 개발자 콘솔의 카카오 로그인 Redirect URI에 `https://배포도메인/api/auth/kakao/callback`을 추가한다. 기존 로컬 URI는 남겨도 된다. 콘솔에서 웹 사이트 도메인을 사용하는 설정에도 배포 origin을 추가한다.
5. 환경변수 변경 후 다시 배포한다. 카카오 시작 주소와 콜백 도메인은 같아야 한다. 매번 바뀌는 Preview 주소보다 고정 Production 주소에서 먼저 확인한다. Preview에서 Production 콜백을 사용하면 로그인도 Production 사이트로 이동한다.

| 서버 환경변수 | 값/용도 |
| --- | --- |
| `DATABASE_URL` | Neon에서 발급한 PostgreSQL 연결 문자열. 계정과 프로젝트의 영구 저장소 |
| `KAKAO_REST_API_KEY` | 기존 카카오 앱의 REST API 키 |
| `KAKAO_CLIENT_SECRET` | 같은 카카오 앱의 Client Secret |
| `KAKAO_REDIRECT_URI` | `https://배포도메인/api/auth/kakao/callback` |
| `POP3D_PUBLIC_URL` | `https://배포도메인` — 공개 origin 및 Secure 세션 쿠키 |

서버 비밀값에 `VITE_` 접두사를 붙이지 않는다. AI 입력 해석을 사용할 때만 선택한 AI 공급자의 서버 환경변수를 추가한다. 프런트 배치 알고리즘과 PDF 생성에는 AI 키가 필수가 아니다.

## 배포 후 실제 확인할 항목

- `/api/health`가 JSON 응답을 반환하고 로그인 화면이 열린다.
- `/api/account/kakao/status`가 `configured: true`를 반환한다. 이는 설정 형식 확인이며 실제 로그인 성공 여부는 다음 단계에서 확인한다.
- 카카오로 로그인 → 프로젝트 생성·편집 → 로그아웃 → 같은 카카오 계정으로 로그인 시 작업이 복원된다.
- 다른 계정은 다른 계정의 작업을 불러오지 않는다.
- 재배포 후에도 기존 계정과 프로젝트를 불러올 수 있다.
- 환경변수가 브라우저 JS에 포함되지 않고, API 오류에 DB 접속 정보가 노출되지 않는다.

현재 로컬 HTTP 및 모의 카카오 응답을 이용한 테스트는 수행했다. **실제 카카오 인증, Neon 연결, Vercel 빌드·라우팅·재배포 보존, 브라우저 화면 검사는 미검증이다.**

## 데이터와 기능 범위

로컬 SQLite와 배포 DB는 별개의 저장소다. 로컬 프로젝트를 배포 DB로 자동 업로드하지 않는다. 기존 작업을 옮길 때는 로그인한 로컬 작업 화면에서 JSON 백업을 내려받고, 배포된 사이트의 원하는 계정으로 로그인해 가져오기를 사용한다. 로컬 사용자 DB를 GitHub에 올리지 않는다.

커스텀 참고 GLB 바이너리는 브라우저 IndexedDB에 있으므로 기기 간 자동 동기화 대상이 아니다. JSON 프로젝트 저장 요청은 4,000,000바이트 제한이며 초과 시 백업·정리를 안내한다.

카카오 **계정 로그인**용 state와 계정 세션은 DB를 사용한다. 기존 **카카오톡 메시지 연결**은 서버 메모리 세션 방식이다. 카카오톡 PDF 발송·공개 보고서 링크·결제는 별도 구현 및 검증이 필요하며 이번 배포 준비로 활성화되지 않는다. Netlify 전용 함수 어댑터도 이번 범위에 포함하지 않았다.

## 공식 참고

- [카카오 로그인 REST API](https://developers.kakao.com/docs/ko/kakaologin/rest-api)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Vercel Node 함수와 요청 본문](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel rewrite 설정](https://vercel.com/docs/project-configuration/vercel-json#rewrites)
- [Vercel 함수 제한 — 요청/응답 최대 4.5MB](https://vercel.com/docs/functions/limitations)
- [Neon 서버리스 드라이버](https://github.com/neondatabase/serverless)

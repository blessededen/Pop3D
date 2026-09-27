import { useRef } from 'react';
import type { Space } from '../domain/types';
import { useStore } from '../store';
import { Field, NumInput, TextInput } from './ui';

const REQUEST_ITEMS: [string, string][] = [
  ['req.drawing', '기준 도면과 벽별 치수'], ['req.fixed', '출입구·기둥·고정 시설 위치'], ['req.height', '천장 높이·설치 범위·전원'],
  ['req.schedule', '행사·반입·철거 일정'], ['req.scope', '자료 사용·공유 범위'],
];
const INTAKE_ITEMS: [string, string][] = [
  ['in.fileOpened', '파일 열림'], ['in.dimsChecked', '치수 대조 완료'], ['in.constraints', '배치 제약 등록 완료'], ['in.vendorReviewed', '업체 검토 완료'],
];
const REQUEST_TEXT = `팝업 배치 검토를 위해 아래 자료를 요청드립니다.
1. 실제 대관 구획의 치수 도면(벽별 길이, 단위, 확인일)
2. 출입구·기둥 위치, 천장 높이, 전원 위치, 집기 설치 제한
3. 내부 사진
4. 기존 3D 자료가 있다면 원본
5. 자료를 모델 제작, 팀 내부 검토, 고객 공유에 사용할 수 있는 범위
도면 치수는 현장 실측과 별도로 대조할 예정입니다.`;

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function SpaceReportFields({ space, onChange }: { space: Space; onChange: (space: Space) => void }) {
  const toast = useStore(state => state.toast);
  const current = useRef(space);
  current.current = space;
  const set = (update: (next: Space) => void) => {
    const next = structuredClone(current.current);
    update(next);
    current.current = next;
    onChange(next);
  };
  const checks = space.status.checks ?? {};
  const toggleCheck = (key: string) => set(next => {
    next.status.checks = { ...(next.status.checks ?? {}) };
    if (next.status.checks[key]) delete next.status.checks[key];
    else next.status.checks[key] = today();
  });

  return <div className="report-space-fields">
    <details className="report-space-section">
      <summary>통로·높이 조건</summary>
      <div className="stack">
        <p className="hint">입력하면 자동 배치와 배치 검사에 적용됩니다. 조건을 바꾼 뒤에는 현재 배치의 검사 결과를 다시 확인하세요.</p>
        <div className="grid2">
          <Field label="집기 사이 최소 간격 (cm)"><NumInput allowNull min={0} max={1000} value={space.rules.minAisle == null ? null : space.rules.minAisle * 100} placeholder="운영자 확인 전" onChange={value => set(next => { next.rules.minAisle = value == null ? null : value / 100; })} /></Field>
          <Field label="최대 설치 높이 (cm)"><NumInput allowNull min={0} max={3000} value={space.rules.maxItemHeight == null ? null : space.rules.maxItemHeight * 100} placeholder="천장 높이 기준" onChange={value => set(next => { next.rules.maxItemHeight = value == null ? null : value / 100; })} /></Field>
        </div>
        <p className="hint">간격은 집기 사이의 거리를 검사하며, 입구부터 출구까지의 연속 이동 경로를 검증하지는 않습니다.</p>
        <Field label="배치 규칙 근거·메모"><TextInput multiline value={space.rules.note} onChange={value => set(next => { next.rules.note = value; })} /></Field>
      </div>
    </details>
    <details className="report-space-section">
      <summary>실측·출처 기록</summary>
      <div className="stack">
        <div className="row wrap">
          <label className="check"><input type="checkbox" checked={space.status.scaleConfirmed} onChange={event => set(next => { next.status.scaleConfirmed = event.target.checked; })} />도면 치수 확인</label>
          <label className="check"><input type="checkbox" checked={space.status.fieldMeasured} onChange={event => set(next => { next.status.fieldMeasured = event.target.checked; })} />현장 실측 대조</label>
          <label className="check"><input type="checkbox" checked={space.isVirtual} onChange={event => set(next => { next.isVirtual = event.target.checked; })} />가상 예시 공간</label>
        </div>
        {!space.status.scaleConfirmed && <p className="hint">도면 치수 확인 전에는 보고서에 ‘축척 미확인 · 참고용’이 표시됩니다.</p>}
        <Field label="주소"><TextInput value={space.address} onChange={value => set(next => { next.address = value; })} /></Field>
        <div className="grid2">
          <Field label="자료 출처"><TextInput value={space.status.source} onChange={value => set(next => { next.status.source = value; })} /></Field>
          <Field label="도면 확인일"><TextInput type="date" value={space.status.drawingDate} onChange={value => set(next => { next.status.drawingDate = value; })} /></Field>
        </div>
        <Field label="자료 사용 범위"><TextInput value={space.status.usageScope} onChange={value => set(next => { next.status.usageScope = value; })} /></Field>
        <Field label="자료 상태 메모"><TextInput multiline value={space.status.note} onChange={value => set(next => { next.status.note = value; })} /></Field>
      </div>
    </details>
    <details className="report-space-section">
      <summary>운영자 자료 요청·확인 기록</summary>
      <div className="stack">
        <p className="hint">요청할 문구를 복사하고, 직접 확인한 항목을 기록하세요. 확인표와 체크 날짜는 브라우저에 보관하는 작업 기록입니다.</p>
        <button className="btn" onClick={() => navigator.clipboard.writeText(REQUEST_TEXT).then(() => toast('요청 문구를 복사했습니다.')).catch(() => toast('클립보드에 접근할 수 없습니다.', 'warn'))}>요청 문구 복사</button>
        <div className="checklist">{[...REQUEST_ITEMS, ...INTAKE_ITEMS].map(([key, label]) => <label key={key}><input type="checkbox" checked={!!checks[key]} onChange={() => toggleCheck(key)} /><span className="grow">{label}</span><small>{checks[key] ?? '미확인'}</small></label>)}</div>
      </div>
    </details>
  </div>;
}

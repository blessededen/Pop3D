import { useEffect, useId, useRef, useState } from 'react';
import type { Space } from '../domain/types';
import '../workflow-sizing.css';

export default function AislePreflightDialog({ space, onClose, onConfirm }: { space: Space; onClose: () => void; onConfirm: (width: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [width, setWidth] = useState(() => String(Math.round((space.rules.minAisle ?? .9) * 100)));
  const [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="aisle-preflight-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      const cm = Number(width);
      if (!width.trim() || !Number.isFinite(cm) || cm < 10 || cm > 1000) { setError('통로 폭을 10~1,000cm 사이로 입력해 주세요.'); return; }
      onConfirm(cm / 100);
    }}>
      <div className="panel-head"><div><span className="eyebrow">배치 전 마지막 확인</span><h2 id={titleId}>통로를 얼마나 비울까요?</h2></div><button type="button" className="btn ghost icon-btn" aria-label="통로 설정 닫기" onClick={onClose}>×</button></div>
      <p id={descriptionId}>사람이 지나는 통로에 적용할 최소 폭을 정하세요. 같은 기준으로 전체 배치를 계산합니다.</p>
      <label className="field"><span>최소 통로 폭 (cm)</span><input autoFocus className="input num" type="number" inputMode="decimal" min="10" max="1000" step="1" required value={width} onChange={event => { setWidth(event.target.value); setError(''); }} /></label>
      <p className="hint">기본 제안은 90cm입니다. 현장 운영 조건에 맞춰 정하세요. 법정 통로 기준의 적합성을 판정하는 값은 아닙니다.</p>
      {error && <p className="note error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="btn" onClick={onClose}>돌아가기</button><button type="submit" className="btn primary">이 폭으로 자동 배치 →</button></div>
    </form>
  </dialog>;
}

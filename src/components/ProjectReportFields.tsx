import { daysInclusive } from '../domain/seed';
import type { Project } from '../domain/types';
import { useStore } from '../store';
import { Field, NumInput, TextInput } from './ui';

export default function ProjectReportFields({ project }: { project: Project }) {
  const update = useStore(s => s.updateProject);
  const event = project.event;
  const rentalDays = daysInclusive(event.startDate, event.endDate);
  const setEvent = (patch: Partial<Project['event']>) => update(p => {
    Object.assign(p.event, patch);
    const days = daysInclusive(p.event.startDate, p.event.endDate);
    if (days != null) p.event.rentalDays = days;
  });

  return <div className="report-project-fields stack">
    <details className="panel report-details">
      <summary>행사·일정 <span className="small muted">· {event.rentalDays}일 대여</span></summary>
      <div className="stack report-details-body">
        <div className="grid2">
          <Field label="행사명"><TextInput value={event.title} onChange={title => setEvent({ title })} /></Field>
          <Field label="브랜드"><TextInput value={event.brand} onChange={brand => setEvent({ brand })} /></Field>
        </div>
        <div className="grid2">
          <Field label="시작일"><TextInput type="date" value={event.startDate} onChange={startDate => setEvent({ startDate })} /></Field>
          <Field label="종료일"><TextInput type="date" value={event.endDate} onChange={endDate => setEvent({ endDate })} /></Field>
        </div>
        <div className="grid2">
          <Field label="대여 일수">
            {rentalDays != null
              ? <output className="input num">{rentalDays}일 (날짜 기준)</output>
              : <NumInput value={event.rentalDays} min={1} max={365} onChange={days => setEvent({ rentalDays: days ?? 1 })} />}
          </Field>
          <Field label="담당 연락처"><TextInput value={event.contact} placeholder="선택" onChange={contact => setEvent({ contact })} /></Field>
        </div>
        <p className="hint">대여 기간을 변경하면 집기 비용도 함께 다시 계산됩니다.</p>
        <div className="grid2">
          <Field label="반입·설치"><TextInput value={event.moveIn} placeholder="예: 시작 전날 오후 8시" onChange={moveIn => setEvent({ moveIn })} /></Field>
          <Field label="철거"><TextInput value={event.teardown} placeholder="예: 종료일 오후 9시" onChange={teardown => setEvent({ teardown })} /></Field>
        </div>
      </div>
    </details>
    <details className="panel report-details">
      <summary>전달 메모</summary>
      <div className="stack report-details-body">
        <Field label="검토·협의 메모"><TextInput multiline value={project.memo} placeholder="사내 검토 또는 업체 협의 사항" onChange={memo => update(p => { p.memo = memo; })} /></Field>
        <Field label="현장 운영 조건"><TextInput multiline value={event.conditions} placeholder="반입 동선, 엘리베이터, 주차 등" onChange={conditions => setEvent({ conditions })} /></Field>
      </div>
    </details>
  </div>;
}

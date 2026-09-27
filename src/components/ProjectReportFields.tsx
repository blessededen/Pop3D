import { daysInclusive } from '../domain/seed';
import type { Project } from '../domain/types';
import { useStore } from '../store';
import { Field, TextInput } from './ui';

export default function ProjectReportFields({ project }: { project: Project }) {
  const update = useStore(s => s.updateProject);
  const event = project.event;
  const eventDays = daysInclusive(event.startDate, event.endDate);
  const setEvent = (patch: Partial<Project['event']>) => update(p => {
    Object.assign(p.event, patch);
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
            <output className="input num">{event.rentalDays}일 · 집기 선택에서 설정</output>
          </Field>
          <Field label="담당 연락처"><TextInput value={event.contact} placeholder="선택" onChange={contact => setEvent({ contact })} /></Field>
        </div>
        <p className="hint">{eventDays != null ? `행사 일정은 ${eventDays}일입니다. ` : ''}대여 기간은 집기 선택 단계의 값을 사용하며, 행사 날짜를 바꿔도 변경되지 않습니다.</p>
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

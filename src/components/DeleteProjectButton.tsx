import type { Project } from '../domain/types';
import { useStore } from '../store';

export default function DeleteProjectButton({ project, disabled }: { project: Project; disabled?: boolean }) {
  return <button className="btn ghost sm danger" disabled={disabled} onClick={() => {
    if (!window.confirm(`‘${project.name}’ 프로젝트와 확정 버전을 삭제할까요?`)) return;
    useStore.getState().deleteProject(project.id);
    window.location.hash = '#/';
  }}>프로젝트 삭제</button>;
}

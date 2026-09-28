import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Vite emits this worker beside the application; no CDN or remote PDF viewer.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function AutoDemoPdfPreview({ url }: { url: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pages, setPages] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current;
    if (!host || !canvas) return;
    const controller = new AbortController();
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let page: PDFPageProxy | undefined;
    let rendering: RenderTask | undefined;
    let frame = 0;
    let revision = 0;
    setPages(0); setReady(false); setError(false);

    const paint = async () => {
      if (cancelled || !page || !host.clientWidth || !host.clientHeight) return;
      const generation = ++revision;
      const previous = rendering;
      previous?.cancel();
      // PDF.js forbids concurrent drawing to one canvas, including cancelled
      // tasks that have not finished unwinding yet.
      await previous?.promise.catch(() => {});
      if (cancelled || generation !== revision) return;
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(1, host.clientWidth - 32) / natural.width, Math.max(1, host.clientHeight - 44) / natural.height);
      const viewport = page.getViewport({ scale });
      const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.ceil(viewport.width * density));
      canvas.height = Math.max(1, Math.ceil(viewport.height * density));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const task = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0], background: '#ffffff' });
      rendering = task;
      try {
        await task.promise;
        if (!cancelled && generation === revision) { setReady(true); setError(false); }
      } catch (cause) {
        if (!cancelled && generation === revision && (cause as Error)?.name !== 'RenderingCancelledException') { setError(true); setReady(false); }
      } finally { if (rendering === task) rendering = undefined; }
    };

    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => { void paint().catch(() => { if (!cancelled) { setError(true); setReady(false); } }); });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);

    void (async () => {
      try {
        const source = new URL(url);
        if (source.protocol !== 'blob:' || source.origin !== window.location.origin) throw new Error('Expected a locally generated report');
        const response = await fetch(source.href, { signal: controller.signal });
        if (!response.ok) throw new Error('Report unavailable');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        loadingTask = getDocument({ data: bytes, useWorkerFetch: false, useWasm: false, stopAtErrors: true });
        const document = await loadingTask.promise;
        if (cancelled) return;
        setPages(document.numPages);
        page = await document.getPage(1);
        if (!cancelled) schedule();
      } catch {
        if (!cancelled) { setError(true); setReady(false); }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      rendering?.cancel();
      void loadingTask?.destroy().catch(() => {});
    };
  }, [url]);

  return <div ref={hostRef} className="auto-demo-pdf-preview" aria-busy={!ready && !error} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
    <canvas ref={canvasRef} className="auto-demo-pdf-canvas" role="img" aria-label={`생성된 기획보고서 첫 페이지${pages ? `, 전체 ${pages}페이지` : ''}`} style={{ position: 'absolute', top: 'calc(50% - 6px)', left: '50%', transform: 'translate(-50%, -50%)', display: 'block', visibility: ready ? 'visible' : 'hidden' }} />
    {!ready && <div className={`auto-demo-loading auto-demo-pdf-message ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'} style={{ position: 'absolute', inset: 0 }}>
      {!error && <span className="auto-demo-orbit" aria-hidden="true" />}
      <span>{error ? 'PDF 미리보기를 열지 못했습니다. 아래 PDF 내려받기로 실제 보고서를 확인해 주세요.' : '생성된 PDF의 첫 페이지를 불러오고 있습니다.'}</span>
    </div>}
    {ready && <span className="auto-demo-pdf-page-count" style={{ position: 'absolute', bottom: 6, right: 14 }} aria-label={`전체 ${pages}페이지 중 첫 페이지`}>1 / {pages} 페이지</span>}
  </div>;
}

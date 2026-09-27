import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { accountStore } from './accountStore.ts';
import type { Env } from './ai.ts';
import type { VersionSnapshot } from '../src/domain/types.ts';

export const REPORT_PDF_LIMIT = 2_500_000;
const TTL = 7 * 24 * 60 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (status: number, code: string) => Object.assign(new Error(code), { status, code });

export function publicReportOrigin(env: Env): string | undefined {
  try {
    const url = new URL(env.POP3D_PUBLIC_URL?.trim() || env.KAKAO_REDIRECT_URI?.trim() || '');
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return;
    return url.origin;
  } catch { return; }
}

async function reports(env: Env) {
  return accountStore(env);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000;
const size = (value: unknown) => finite(value) && (value as number) > 0 && (value as number) <= 200;
const text = (value: unknown) => typeof value === 'string';
const list = (value: unknown, check: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.length <= 500 && value.every(item => record(item) && check(item));

/** Bound geometry before exposing a saved version to the public 2D/3D viewer. */
function usableSnapshot(value: unknown): value is VersionSnapshot {
  if (!record(value) || !text(value.projectName) || !Number.isSafeInteger(value.version) || !text(value.createdAt)) return false;
  const s = value.space, v = value.vendor;
  if (!record(s) || !record(v) || !size(s.width) || !size(s.depth) || !size(s.height) || !record(s.rules) || !record(s.status)) return false;
  const rect = (r: Record<string, unknown>) => text(r.id) && text(r.label) && finite(r.x) && finite(r.y) && size(r.w) && size(r.d);
  if (![s.columns, s.fixtures, s.zones].every(items => list(items, rect))) return false;
  if (!list(s.doors, d => text(d.id) && text(d.label) && ['top', 'right', 'bottom', 'left'].includes(String(d.wall)) && finite(d.offset) && size(d.width) && (d.clearance === null || finite(d.clearance)))) return false;
  if (!list(s.powerPoints, p => text(p.id) && text(p.label) && finite(p.x) && finite(p.y))) return false;
  if (!list(v.items, i => text(i.sku) && text(i.name) && text(i.color) && text(i.category) && size(i.w) && size(i.d) && size(i.h) && record(i.price))) return false;
  const items = v.items as { sku: string; category: string; w: number; h: number }[];
  const skus = new Set(items.map(i => i.sku));
  if (!record(value.event) || !text(value.event.title)) return false;
  if (value.event.brief !== undefined && (!record(value.event.brief) ||
    !['objective', 'audience', 'experience', 'approval'].every(key => text((value.event as Record<string, Record<string, unknown>>).brief[key])))) return false;
  if (!Array.isArray(value.placements)) return false;
  // Procedural hanger garments/shelf levels scale with dimensions. Keep the
  // shared viewer's mesh count bounded even for manually uploaded workspaces.
  let meshCount = 0;
  for (const placement of value.placements) {
    if (!record(placement)) return false;
    const item = items.find(i => i.sku === placement.sku);
    if (!item) return false;
    meshCount += item.category === 'hanger' ? 5 + Math.max(3, Math.floor((item.w - 0.14) / 0.085)) :
      item.category === 'shelf' ? 3 + Math.max(3, Math.round(item.h / 0.4)) : 6;
    if (meshCount > 3000) return false;
  }
  return list(value.placements, p => text(p.id) && skus.has(String(p.sku)) && finite(p.x) && finite(p.y) && finite(p.rot) && typeof p.noOrder === 'boolean') &&
    Array.isArray(value.requirements) && Array.isArray(value.fees) && record(value.event) && record(value.budget) && text(value.memo);
}

export async function prepareReportShare(env: Env, userId: string, input: unknown) {
  if (!record(input) || !text(input.projectId) || (input.projectId as string).length > 200 ||
    !Number.isSafeInteger(input.version) || (input.version as number) < 1 || !text(input.pdfBase64)) throw fail(400, 'invalid_report');
  const encoded = input.pdfBase64 as string;
  if (encoded.length > Math.ceil(REPORT_PDF_LIMIT / 3) * 4) throw fail(413, 'pdf_too_large');
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail(400, 'invalid_pdf');
  const pdf = Buffer.from(encoded, 'base64');
  if (pdf.toString('base64') !== encoded) throw fail(400, 'invalid_pdf');
  if (pdf.length > REPORT_PDF_LIMIT) throw fail(413, 'pdf_too_large');
  if (pdf.length < 12 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-' || !pdf.subarray(-1024).includes(Buffer.from('%%EOF'))) throw fail(400, 'invalid_pdf');
  const origin = publicReportOrigin(env);
  if (!origin) throw fail(409, 'public_url_required');
  const db = await reports(env);
  const workspace = await db.workspace(userId);
  if (!workspace) throw fail(404, 'report_not_found');
  let snapshot: VersionSnapshot | undefined;
  try {
    const saved = JSON.parse(workspace.body) as { projects?: { id: string; versions?: unknown[] }[] };
    const project = saved.projects?.find(p => p.id === input.projectId);
    const candidate = project?.versions?.find(v => record(v) && v.version === input.version);
    if (usableSnapshot(candidate)) snapshot = candidate;
  } catch { /* Invalid saved versions cannot be published. */ }
  if (!snapshot) throw fail(404, 'report_not_found');
  // No reference-model buffers, unrelated projects, or account identity enter the share.
  delete snapshot.space.refModel;
  snapshot.vendor.items = snapshot.vendor.items.map(item => ({ ...item, modelUrl: '' }));
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized) > 500_000) throw fail(413, 'report_too_large');
  const token = randomBytes(32).toString('base64url'), id = randomBytes(16).toString('hex');
  const expires = Date.now() + TTL;
  await db.query('DELETE FROM report_shares WHERE expires <= ?', [Date.now()]);
  const [count] = await db.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM report_shares WHERE user_id = ?', [userId]);
  if (Number(count.count) >= 50) throw fail(429, 'share_limit');
  await db.query('INSERT INTO report_shares (id, token_hash, user_id, project_id, body, pdf, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, digest(token), userId, input.projectId as string, serialized, encoded, expires]);
  return { id, token, url: `${origin}/#/shared/${token}`, title: Array.from(snapshot.projectName).slice(0, 120).join(''), version: snapshot.version, expiresAt: new Date(expires).toISOString() };
}

/** A 256-bit capability grants read-only access to one frozen report for seven days. */
export async function handleReportShare(req: IncomingMessage, res: ServerResponse, env: Env): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://local').pathname;
  if (!path.startsWith('/api/reports/')) return false;
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
  const json = (status: number, body: unknown) => {
    res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); json(405, { error: 'method_not_allowed' }); return true; }
  const match = /^\/api\/reports\/([A-Za-z0-9_-]{43})(\/pdf)?$/.exec(path);
  if (!match) { json(404, { error: 'report_unavailable' }); return true; }
  try {
    const db = await reports(env);
    const [row] = await db.query<{ body: string; pdf: string; expires: number | string }>(
      'SELECT body, pdf, expires FROM report_shares WHERE token_hash = ? AND expires > ?', [digest(match[1]), Date.now()]);
    if (!row) { json(404, { error: 'report_unavailable' }); return true; }
    const snapshot = JSON.parse(row.body) as VersionSnapshot;
    if (match[2]) {
      const name = Array.from(Buffer.from(snapshot.projectName, 'utf8').toString('utf8').replace(/[\x00-\x1f<>:"/\\|?*]/g, '-')).slice(0, 80).join('');
      const filename = `Pop3D-${name}-v${snapshot.version}.pdf`;
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="Pop3D-report.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('content-security-policy', "sandbox; default-src 'none'");
      res.end(Buffer.from(row.pdf, 'base64'));
    } else json(200, { snapshot, expiresAt: new Date(Number(row.expires)).toISOString() });
  } catch { json(503, { error: 'report_unavailable' }); }
  return true;
}

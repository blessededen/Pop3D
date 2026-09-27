// 좌표계: 평면도 기준 미터(m). 원점 = 공간의 왼쪽 위 모서리.
// x → 오른쪽, y → 아래쪽(출입구 쪽). 3D에서는 x → X, y → Z, 높이 → Y.

export type PriceStatus = 'confirmed' | 'estimated' | 'unknown';
export type Wall = 'top' | 'right' | 'bottom' | 'left';

export type Category =
  | 'hanger'
  | 'counter'
  | 'photozone'
  | 'table'
  | 'shelf'
  | 'mirror'
  | 'display'
  | 'light'
  | 'other';

/** 왼쪽 위 모서리(x, y)와 가로(w)·세로(d)로 정의한 축 정렬 사각형 */
export interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  d: number;
  label: string;
}

export interface NoGoZone extends Rect {
  reason: string;
}

export interface Door {
  id: string;
  wall: Wall;
  /** 벽 시작점(위·아래 벽은 왼쪽 끝, 좌·우 벽은 위쪽 끝)에서 문 시작까지 거리 */
  offset: number;
  width: number;
  /** 문 앞 비워 둘 깊이. 운영자에게 받은 값만 넣는다. null = 미확인 */
  clearance: number | null;
  label: string;
}

export interface PowerPoint {
  id: string;
  x: number;
  y: number;
  label: string;
}

export interface SpaceStatus {
  /** 도면 축척(치수) 확인 여부 */
  scaleConfirmed: boolean;
  /** 현장 실측 대조 여부 */
  fieldMeasured: boolean;
  drawingDate: string;
  source: string;
  /** 모델 제작·팀 내부·고객 공유 등 자료 사용 가능 범위 */
  usageScope: string;
  note: string;
  /** 자료 수급·인수 체크 항목 → 확인한 날짜(YYYY-MM-DD). 항목마다 따로 기록한다. */
  checks?: Record<string, string>;
}

export interface RefModelMeta {
  fileName: string;
  scale: number;
  rotY: 0 | 90 | 180 | 270;
  offsetX: number;
  offsetZ: number;
  /** 불러온 원본의 바운딩 박스 크기(m, scale 적용 전) */
  measured: { w: number; d: number; h: number };
  visible: boolean;
}

export interface Space {
  id: string;
  name: string;
  address: string;
  isVirtual: boolean;
  width: number;
  depth: number;
  height: number;
  doors: Door[];
  columns: Rect[];
  zones: NoGoZone[];
  fixtures: Rect[];
  powerPoints: PowerPoint[];
  rules: {
    /** 집기 사이 최소 통로 폭(운영자 확인값). null = 미확인 */
    minAisle: number | null;
    /** 설치 허용 최대 높이. null = 천장 높이만 검사 */
    maxItemHeight: number | null;
    note: string;
  };
  status: SpaceStatus;
  refModel?: RefModelMeta;
}

export interface Price {
  amount: number | null;
  /** 가격 기준 기간(일). 구매 품목이면 null */
  basisDays: number | null;
  vatIncluded: boolean | null;
  status: PriceStatus;
  priceDate: string;
  source: string;
  /** 기준 기간 초과 시 1일당 추가 금액. null = 연장 계산 방식 미확인 */
  extraDayAmount: number | null;
}

export interface CatalogItem {
  /** 새 프로젝트에서 선택할 때 적용할 전원 기본값. */
  needsPower?: boolean;
  sku: string;
  name: string;
  category: Category;
  w: number;
  d: number;
  h: number;
  option: string;
  trade: 'rent' | 'buy';
  price: Price;
  /** 보증금(예치금). 합계에는 넣지 않고 따로 표시한다. null = 미확인 */
  deposit: number | null;
  /** 세트 구성품 설명. 빈 문자열이면 단품 */
  setComponents: string;
  modelUrl: string;
  modelLicense: string;
  color: string;
  note: string;
}

export interface ServiceFee {
  id: string;
  kind: 'transport_install' | 'dismantle' | 'other';
  label: string;
  amount: number | null;
  status: PriceStatus;
  basis: string;
  source: string;
  vatIncluded: boolean | null;
}

export interface Vendor {
  id: string;
  name: string;
  contact: string;
  catalogDate: string;
  isVirtual: boolean;
  items: CatalogItem[];
  services: ServiceFee[];
}

/** 집기 종류(category)별 요구 조건. 같은 종류 안에서 규격(sku)을 고른다. */
export interface Requirement {
  category: Category;
  sku: string;
  required: boolean;
  minQty: number;
  desiredQty: number;
  /** 1이 가장 중요. 예산을 줄일 때 숫자가 큰 항목부터 줄인다. */
  priority: number;
  /** 전원점에 가까운 자리 우선. 생략된 기존 자료는 전원 조건 없음. */
  needsPower?: boolean;
}

export interface Placement {
  id: string;
  sku: string;
  /** 중심 좌표 */
  x: number;
  y: number;
  /** 도 단위 회전. 0 = 정면이 +y(출입구 쪽)를 봄 */
  rot: number;
  /** 참고용 객체(주문 수량에서 제외) */
  noOrder: boolean;
}

export interface PlanningBrief {
  objective: string;
  audience: string;
  experience: string;
  approval: string;
}

export interface EventInfo {
  /** 사내 기획·검토용 요약. 이전 프로젝트는 비어 있는 상태로 호환한다. */
  brief?: PlanningBrief;
  title: string;
  brand: string;
  contact: string;
  startDate: string;
  endDate: string;
  rentalDays: number;
  moveIn: string;
  teardown: string;
  conditions: string;
}

export interface Budget {
  amount: number | null;
  /** fixtures = 집기·운송·설치·철거 예산, event_total = 전체 행사비 */
  scope: 'fixtures' | 'event_total';
}

export interface VendorSnapshot {
  id: string;
  name: string;
  contact: string;
  catalogDate: string;
  isVirtual: boolean;
  items: CatalogItem[];
}

export interface VersionSnapshot {
  version: number;
  createdAt: string;
  hash: string;
  projectName: string;
  space: Space;
  vendor: VendorSnapshot;
  event: EventInfo;
  budget: Budget;
  requirements: Requirement[];
  placements: Placement[];
  fees: ServiceFee[];
  memo: string;
}

export interface Project {
  id: string;
  name: string;
  spaceId: string;
  vendorId: string;
  event: EventInfo;
  budget: Budget;
  requirements: Requirement[];
  placements: Placement[];
  /** 수량·전원 조건 변경 후 새 자동 배치가 필요한 상태. 기존 저장본은 생략 가능. */
  layoutNeedsUpdate?: boolean;
  fees: ServiceFee[];
  memo: string;
  versions: VersionSnapshot[];
  createdAt: string;
  updatedAt: string;
}

/** 계산·검사 함수가 공통으로 받는 입력. 프로젝트 초안과 확정 버전 모두 이 형태로 바꿔서 쓴다. */
export interface LayoutData {
  projectName: string;
  space: Space;
  vendor: VendorSnapshot;
  event: EventInfo;
  budget: Budget;
  requirements: Requirement[];
  placements: Placement[];
  fees: ServiceFee[];
  memo: string;
}

export const CATEGORY_LABEL: Record<Category, string> = {
  hanger: '행거',
  counter: '카운터',
  photozone: '포토존',
  table: '테이블',
  shelf: '선반',
  mirror: '거울',
  display: '진열대',
  light: '조명',
  other: '기타',
};

export const STATUS_LABEL: Record<PriceStatus, string> = {
  confirmed: '확인',
  estimated: '추정',
  unknown: '미확인',
};

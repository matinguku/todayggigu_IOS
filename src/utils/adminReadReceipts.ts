/**
 * 문의 카드 — 관리자가 사용자의 메시지를 마지막으로 "읽은" 시각을 inquiryId 별로
 * 영속 저장한다. MessageScreen 카드의 체크 표시에 쓰인다.
 *
 * 표시 규칙 (MessageScreen 의 카드):
 *   - 기록이 없거나 `readAt < lastMessageAt`  → ✓  (전송: 아직 안 읽음)
 *   - 기록이 있고 `readAt >= lastMessageAt`   → ✓✓ (읽음)
 *
 * 즉 관리자가 읽은 뒤 사용자가 새 메시지를 보내(lastMessageAt 이 readAt 보다
 * 나중이 되)면 다시 ✓(전송) 으로 돌아간다.
 *
 * 데이터 출처: 서버의 `user:inquiry:messages-read` / `user:general-inquiry:messages-read`
 * 소켓 이벤트(readByType === 'admin'). 목록 API 는 읽음 상태를 주지 않으므로
 * 이 이벤트를 받을 때마다 기록하고 AsyncStorage 로 영속화해 앱 재시작 후에도 유지한다.
 *
 * 메모리 + AsyncStorage 동기화. 동기 read 를 지원해 FlatList renderItem 에서 직접 호출 가능.
 * (visitedInquiries.ts 와 동일 패턴)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'admin_read_receipts_v1';

type ReadMap = Record<string, number>; // inquiryId → admin 이 읽은 시각(unix ms)

let cache: ReadMap | null = null;

const loadCache = async (): Promise<ReadMap> => {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      cache =
        typeof parsed === 'object' && parsed != null
          ? Object.fromEntries(
              Object.entries(parsed)
                .filter(([k, v]) => typeof k === 'string' && typeof v === 'number')
                .map(([k, v]) => [k, Number(v)]),
            )
          : {};
      return cache;
    }
    cache = {};
  } catch {
    cache = {};
  }
  return cache;
};

const persist = async (map: ReadMap): Promise<void> => {
  cache = map;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 저장 실패해도 메모리 캐시는 유효 */
  }
};

/**
 * 관리자가 해당 inquiry 의 메시지를 읽었음을 기록. `messages-read` 이벤트 수신 시 호출.
 * 더 늦은(최신) readAt 만 보존한다.
 */
export const recordAdminReadSync = (
  inquiryId: string,
  readAt?: string | number | Date | null,
): void => {
  if (!inquiryId) return;
  const ms =
    readAt == null
      ? Date.now()
      : typeof readAt === 'number'
      ? readAt
      : new Date(readAt).getTime();
  const at = Number.isFinite(ms) ? ms : Date.now();
  if (!cache) {
    // 캐시 미로드 시 부분 데이터로 덮어쓰지 않도록 load 후 병합.
    void loadCache().then((map) => {
      if ((map[inquiryId] ?? 0) < at) void persist({ ...map, [inquiryId]: at });
    });
    return;
  }
  if ((cache[inquiryId] ?? 0) >= at) return;
  void persist({ ...cache, [inquiryId]: at });
};

/** 동기 조회 — 관리자가 읽은 시각(ms). 기록 없으면 0. renderItem 에서 호출(prewarm 후 유효). */
export const getAdminReadAtSync = (inquiryId: string): number => {
  if (!cache || !inquiryId) return 0;
  return cache[inquiryId] || 0;
};

/**
 * 동기 조회 — 관리자가 `lastMessageAt` 시점까지 읽었는지.
 *   - 기록 없으면 false (아직 안 읽음 → ✓)
 *   - readAt >= lastMessageAt 이면 true (읽음 → ✓✓)
 *   - lastMessageAt 이 더 나중이면 false (읽은 뒤 새 메시지 → ✓)
 */
export const isReadByAdminSync = (
  inquiryId: string,
  lastMessageAt: string | number | Date | null | undefined,
): boolean => {
  const readAt = getAdminReadAtSync(inquiryId);
  if (readAt <= 0) return false;
  if (!lastMessageAt) return true;
  const lastMs =
    typeof lastMessageAt === 'number'
      ? lastMessageAt
      : new Date(lastMessageAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return readAt >= lastMs;
};

/** 캐시 prewarm — 화면 mount/focus 시 한 번 호출. */
export const prewarmAdminReadReceipts = async (): Promise<void> => {
  await loadCache();
};

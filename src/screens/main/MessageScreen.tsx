import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  RefreshControl,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import Text from '../../components/Text';
import Icon from '../../components/Icon';
import { COLORS, FONTS, SPACING, BORDER_RADIUS } from '../../constants';
import { useAuth } from '../../context/AuthContext';
import { useGeneralInquiry } from '../../hooks/useGeneralInquiry';
import { useSocket } from '../../context/SocketContext';
import { GeneralInquiry } from '../../services/socketService';
import { inquiryApi } from '../../services/inquiryApi';
import { useAppSelector } from '../../store/hooks';
import { translations } from '../../i18n/translations';
import SearchIcon from '../../assets/icons/SearchIcon';
import { API_BASE_URL } from '../../constants';
import { getStoredToken } from '../../services/authApi';
import { buildSignatureHeaders } from '../../services/signature';
import { getOrderProgressStatusLabel } from '../../utils/orderProgressStatusLabel';
import { useProfileTabletEmbedNavigation } from './profileScreen/ProfileTabletEmbedContext';
import CachedImage from '../../components/CachedImage';
import { SkeletonBlock } from '../../components/Skeleton';
import {
  markInquiryVisited,
  isInquiryConfirmedSync,
  prewarmVisitedInquiries,
  markInquiryVisitedSync,
  clearInquiryVisitedSync,
} from '../../utils/visitedInquiries';
import {
  isReadByAdminSync,
  prewarmAdminReadReceipts,
} from '../../utils/adminReadReceipts';
import {
  hideInquiry,
  isInquiryHiddenSync,
  prewarmHiddenInquiries,
} from '../../utils/hiddenInquiries';
import {
  type OrderInquiryListItem,
  fetchOrderInquiryList,
  formatOrderDisplayNumber,
} from '../../utils/messageInquiryMappers';

type TabType = 'order' | 'general' | 'fileDownload';

// ─── Form File Item ──────────────────────────────────────
interface FormFile {
  _id: string;
  title: { en?: string; ko?: string; zh?: string };
  fileUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageScreenProps {
  initialTabOverride?: TabType;
  /** Profile tablet split panel */
  embedded?: boolean;
  onEmbeddedBack?: () => void;
}

// Map language codes to flag emojis (mirrors ProfileScreen / HomeScreen / CartScreen).
const getMessageLanguageFlag = (locale: string): string => {
  const flags: { [key: string]: string } = {
    en: '🇺🇸',
    ko: '🇰🇷',
    zh: '🇨🇳',
  };
  return flags[locale] || '🇺🇸';
};

const MessageScreen: React.FC<MessageScreenProps> = ({
  initialTabOverride,
  embedded = false,
  onEmbeddedBack,
}) => {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { isAuthenticated } = useAuth();
  const {
    isConnected,
    unreadCount: orderUnreadCount,
    orderInquiryUnreadById,
    inquiryReadReceiptVersion,
    generalInquiryUnreadCount,
    generalInquiryUnreadById,
    getUnreadCounts,
    getGeneralInquiryUnreadCounts,
    markGeneralInquiryAsRead,
    onMessageReceived,
    onGeneralInquiryMessageReceived,
    // BottomBar 배지에 즉시 반영하기 위한 setter (이 화면에서 계산한 값을 push).
    setUnreadCountOverride,
    setGeneralInquiryUnreadCountOverride,
  } = useSocket();
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const { tryEmbedNavigate } = useProfileTabletEmbedNavigation(embedded);

  const openChat = (params: {
    orderId?: string;
    orderNumber?: string;
    inquiryId?: string;
  }) => {
    if (!tryEmbedNavigate('Chat', params)) {
      navigation.navigate('Chat', params);
    }
  };

  const t = (key: string) => {
    const keys = key.split('.');
    let value: any = translations[locale as keyof typeof translations];
    for (const k of keys) { value = value?.[k]; }
    if (typeof value === 'string') return value;
    return undefined;
  };

  // Layout-first paint: render header + tab switcher immediately and defer
  // the heavy FlatList content (inquiries / general / file downloads) to the
  // next frame so the user sees the page composition first. Uses
  // requestAnimationFrame instead of InteractionManager (see ProductDetail).
  const [showHeavyContent, setShowHeavyContent] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShowHeavyContent(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // 관리자 읽음 캐시 prewarm — isReadByAdminSync 가 sync 조회하려면 필요.
  // 로드 완료 후 카운터를 올려 카드(✓/✓✓)를 한 번 다시 그린다.
  const [readCacheReady, setReadCacheReady] = useState(0);
  useEffect(() => {
    let alive = true;
    prewarmAdminReadReceipts().then(() => {
      if (alive) setReadCacheReady((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Redirect to login if not authenticated
  useFocusEffect(
    useCallback(() => {
      if (!isAuthenticated) {
        navigation.navigate('Auth', { screen: 'Login', params: { fromProfile: true } });
      }
    }, [isAuthenticated, navigation])
  );

  const initialTab = initialTabOverride ?? (route.params?.initialTab === 'general' ? 'general' : 'order');
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const activeTabRef = useRef<TabType>(initialTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // If navigated with orderId (from BuyList ? button), go directly to Chat
  useEffect(() => {
    const orderId = route.params?.orderId;
    const orderNumber = route.params?.orderNumber;
    if (orderId && orderNumber) {
      openChat({ orderId, orderNumber });
    }
  }, [route.params?.orderId, route.params?.orderNumber]);

  // ─── Order Inquiry state ──────────────────────────────
  const [orderInquiries, setOrderInquiries] = useState<OrderInquiryListItem[]>([]);
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderRefreshing, setOrderRefreshing] = useState(false);
  // 방문한 inquiry 캐시(AsyncStorage) prewarm 직후 한 번만 증가시켜 카드 리렌더 유도.
  const [, setVisitedTick] = useState(0);

  // ─── General (1:1) Inquiry state ──────────────────────
  const {
    inquiries: generalInquiries,
    isLoading: generalSocketLoading,
    unreadCount: generalUnreadCount,
    getInquiriesList,
    refreshUnreadCounts,
  } = useGeneralInquiry({ autoFetch: false });
  const [generalInquiriesLocal, setGeneralInquiriesLocal] = useState<any[]>([]);
  const [generalLoading, setGeneralLoading] = useState(false);

  // ─── File Download state ──────────────────────────────
  const [formFiles, setFormFiles] = useState<FormFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  const applyOrderUnreadMap = useCallback(
    (items: OrderInquiryListItem[], unreadMap: Record<string, number>) =>
      items.map((inq) => ({
        ...inq,
        unreadCount: unreadMap[inq.inquiryId] ?? inq.unreadCount ?? 0,
      })),
    [],
  );

  const applyGeneralInquiryMeta = useCallback(
    (list: any[]) =>
      list.map((inq) => ({
        ...inq,
        unreadCount: generalInquiryUnreadById[inq._id] ?? inq.unreadCount ?? 0,
        messageCount: inq.messageCount ?? inq.messages?.length ?? 0,
      })),
    [generalInquiryUnreadById],
  );

  // ─── BottomBar 배지용 — 미확인 건수 계산 + SocketContext 에 push ───────
  //
  // 화면에 그려지는 주문문의 카드 중 사용자 방문 기록이 없고 status 가 미확인
  // (`open` / `pending` / `unconfirmed`) 인 항목을 카운트한다. 방문 기록이
  // 있으면 `displayStatus === 'confirmed'` 로 표시되므로 배지에서도 제외.
  // 일반(1:1) 문의는 unreadCount > 0 인 항목 수를 그대로 합산.
  // 의존성: orderInquiries / generalInquiriesLocal — 화면 데이터가 바뀔 때마다
  // 자동으로 다시 세어 즉시 BottomBar 에 반영된다.
  useEffect(() => {
    const orderUnconfirmed = orderInquiries.reduce((acc, item) => {
      // 방문 기록의 visitedAt 이 카드의 lastMessageAt 이상이면 confirmed.
      // 사용자가 본 뒤 admin 이 새 메시지를 보내면 lastMessageAt > visitedAt
      // 이 되어 다시 unconfirmed 로 카운트된다.
      // 카드 라벨과 동일한 기준(visited 로직) 으로 카운트한다. confirmed 가
      // 아니면 미확인으로 카운트. item.status 는 탭 시 'confirmed' 로 바뀌어
      // 새 메시지를 놓치므로 신뢰하지 않는다. (방문 캐시 덕에 과거 확인한 건은
      // visitedAt >= lastMessageAt 으로 confirmed 처리돼 카운트되지 않는다.)
      if (isInquiryConfirmedSync(item.inquiryId, item.lastMessageAt)) return acc;
      return acc + 1;
    }, 0);
    setUnreadCountOverride(orderUnconfirmed);
  }, [orderInquiries, setUnreadCountOverride]);

  useEffect(() => {
    const generalUnread = generalInquiriesLocal.reduce((acc, inq: any) => {
      const c = Number(inq?.unreadCount) || 0;
      return c > 0 ? acc + 1 : acc;
    }, 0);
    setGeneralInquiryUnreadCountOverride(generalUnread);
  }, [generalInquiriesLocal, setGeneralInquiryUnreadCountOverride]);

  // ─── Fetch Order Inquiries (orders-proxy + inquiry API, all orders) ──
  const fetchOrderInquiries = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setOrderLoading(true);
      const items = await fetchOrderInquiryList(locale);
      setOrderInquiries(items);
    } catch (e) {
      if (__DEV__) console.warn('[MessageScreen.fetchOrderInquiries]', e);
    } finally {
      setOrderLoading(false);
    }
  }, [isAuthenticated, locale]);

  // Fetch general (1:1) inquiries via REST API
  const fetchGeneralInquiries = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setGeneralLoading(true);
      console.log('[MessageScreen] Fetching general (1:1) inquiries...');
      const response = await inquiryApi.getGeneralInquiries();
      console.log('[MessageScreen] General inquiries response:', JSON.stringify(response).substring(0, 500));
      if (response.success && response.data) {
        const list = response.data.inquiries || response.data.generalInquiries || [];
        setGeneralInquiriesLocal(applyGeneralInquiryMeta(list));
      } else {
        console.warn('[MessageScreen] General inquiries failed or empty:', response.error);
      }
    } catch (e) {
      if (__DEV__) console.warn('[MessageScreen.fetchGeneralInquiries]', e);
    } finally {
      setGeneralLoading(false);
    }
  }, [isAuthenticated, applyGeneralInquiryMeta]);

  // Fetch form files (GET /v1/form-files)
  const fetchFormFiles = useCallback(async () => {
    try {
      setFilesLoading(true);
      const token = await getStoredToken();
      const url = `${API_BASE_URL}/form-files`;
      const signatureHeaders = await buildSignatureHeaders('GET', url);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true',
          ...signatureHeaders,
        },
      });
      const data = await response.json();
      if (data.status === 'success' && data.data?.formFiles) {
        setFormFiles(data.data.formFiles);
      }
    } catch (e) {
      // silent
    } finally {
      setFilesLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const requestedTab = route.params?.initialTab;
      if (requestedTab === 'order' || requestedTab === 'general' || requestedTab === 'fileDownload') {
        setActiveTab(requestedTab);
      }

      if (isAuthenticated) {
        fetchOrderInquiries();
        fetchGeneralInquiries();
        // 사용자가 한 번이라도 방문한 주문문의는 카드에 "확인완료" 로 표시한다.
        // AsyncStorage 캐시를 prewarm 한 뒤 tick 증가로 리렌더 트리거.
        prewarmVisitedInquiries()
          .then(() => setVisitedTick((t) => t + 1))
          .catch(() => {/* silent */});
        // 사용자가 삭제한 주문문의 카드를 목록에서 제외하기 위해 hidden
        // 캐시도 prewarm. tick 증가로 필터링 리렌더 트리거.
        prewarmHiddenInquiries()
          .then(() => setVisitedTick((t) => t + 1))
          .catch(() => {/* silent */});
        // ▶ 폴링 제거: 이전엔 focus 시마다 `getUnreadCounts()` 와
        //    `getGeneralInquiryUnreadCounts()` 를 socket emit 으로 보냈는데,
        //    이로 인해 카운트가 반복적으로 덮어쓰여 BottomBar 배지가 깜박임.
        //    실시간 갱신은 admin 이 새 메시지를 보낼 때의 socket push
        //    (`user:inquiry:message:received`, `user:general-inquiry:message:received`)
        //    가 자동으로 unreadCount 를 증가시키므로 충분.
        //    카드 status 기반의 정확한 미확인 수는 MessageScreen 의 useEffect
        //    가 setUnreadCountOverride 로 BottomBar 에 push 한다.
      }
      fetchFormFiles();
    }, [
      route.params?.initialTab,
      isAuthenticated,
      isConnected,
      fetchOrderInquiries,
      fetchGeneralInquiries,
      fetchFormFiles,
      getUnreadCounts,
      getGeneralInquiryUnreadCounts,
    ])
  );

  useEffect(() => {
    if (!Object.keys(orderInquiryUnreadById).length) return;
    setOrderInquiries((prev) => applyOrderUnreadMap(prev, orderInquiryUnreadById));
  }, [orderInquiryUnreadById, applyOrderUnreadMap]);

  useEffect(() => {
    if (!Object.keys(generalInquiryUnreadById).length) return;
    setGeneralInquiriesLocal((prev) => applyGeneralInquiryMeta(prev));
  }, [generalInquiryUnreadById, applyGeneralInquiryMeta]);

  // Listen for real-time inquiry messages and update list rows
  useEffect(() => {
    onMessageReceived((data) => {
      if (!data.inquiryId) return;
      // 사용자 본인(senderType:'user') 메시지는 미확인 상태에 영향 주지 않는다.
      // admin 메시지만 lastMessageAt/unreadCount 를 갱신해 "미확인" 으로 만든다.
      const isFromAdmin = data.message?.senderType === 'admin';
      setOrderInquiries((prev) =>
        prev.map((inq) =>
          inq.inquiryId === data.inquiryId
            ? {
                ...inq,
                messageCount: (inq.messageCount || 0) + 1,
                ...(isFromAdmin
                  ? {
                      unreadCount:
                        data.unreadCount !== undefined
                          ? data.unreadCount
                          : activeTabRef.current === 'order'
                            ? inq.unreadCount
                            : (inq.unreadCount || 0) + 1,
                      lastMessageAt: data.message?.timestamp || new Date().toISOString(),
                    }
                  : {}),
              }
            : inq,
        ),
      );
    });
    onGeneralInquiryMessageReceived((data) => {
      if (!data.inquiryId) return;
      setGeneralInquiriesLocal((prev: any[]) =>
        prev.map((inq: any) =>
          inq._id === data.inquiryId
            ? {
                ...inq,
                unreadCount:
                  data.unreadCount !== undefined
                    ? data.unreadCount
                    : activeTabRef.current === 'general'
                      ? inq.unreadCount
                      : (inq.unreadCount || 0) + 1,
                messageCount: (inq.messageCount || 0) + 1,
                lastMessageAt: data.message?.timestamp || new Date().toISOString(),
              }
            : inq,
        ),
      );
    });
  }, [onMessageReceived, onGeneralInquiryMessageReceived]);

  // When the user opens the Order inquiry tab, treat the list as viewed: mark
  // each thread read (REST), zero local badges, refresh socket total for nav tab.
  useEffect(() => {
    if (!isAuthenticated || !showHeavyContent || activeTab !== 'order') return;
    const unreadItems = orderInquiries.filter((i) => i.unreadCount > 0);
    if (unreadItems.length === 0) return;

    let cancelled = false;
    (async () => {
      await Promise.all(
        unreadItems.map((i) => inquiryApi.markAsRead(i.inquiryId).catch(() => {})),
      );
      if (cancelled) return;
      setOrderInquiries((prev) =>
        prev.map((inq) => (inq.unreadCount > 0 ? { ...inq, unreadCount: 0 } : inq)),
      );
      // ▶ socket emit 제거: 로컬 state 가 이미 정확한 값 (모두 0) 으로 갱신됐고,
      //    이걸 MessageScreen 의 별도 useEffect 가 setUnreadCountOverride 로
      //    BottomBar 에 push 한다. socket polling 호출은 깜박임 원인이라 제거.
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    orderInquiries,
    isAuthenticated,
    showHeavyContent,
    isConnected,
    // getUnreadCounts 제거: 더 이상 effect 안에서 호출하지 않음 (폴링 차단).
  ]);

  // When the user opens the 1:1 inquiry tab, mark each unread thread read via
  // socket and refresh the general inquiry total unread count.
  useEffect(() => {
    if (!isAuthenticated || !showHeavyContent || activeTab !== 'general') return;
    const unreadIds = generalInquiriesLocal
      .filter((i: any) => (i.unreadCount || 0) > 0)
      .map((i: any) => i._id as string);
    if (unreadIds.length === 0) return;

    unreadIds.forEach((id) => markGeneralInquiryAsRead(id));
    setGeneralInquiriesLocal((prev: any[]) =>
      prev.map((inq: any) =>
        unreadIds.includes(inq._id) ? { ...inq, unreadCount: 0 } : inq,
      ),
    );

    // ▶ setTimeout 후 socket emit 제거: 로컬 state 가 즉시 0 으로 갱신됐고,
    //    별도 useEffect 가 setGeneralInquiryUnreadCountOverride 로 BottomBar 에
    //    push 하므로 추가 socket 호출 불필요.
  }, [
    activeTab,
    generalInquiriesLocal,
    isAuthenticated,
    showHeavyContent,
    isConnected,
    markGeneralInquiryAsRead,
    // getGeneralInquiryUnreadCounts 제거: effect 안에서 호출 안 함 (폴링 차단).
  ]);

  const handleOrderRefresh = useCallback(async () => {
    setOrderRefreshing(true);
    await fetchOrderInquiries();
    setOrderRefreshing(false);
  }, [fetchOrderInquiries]);

  const handleGeneralRefresh = useCallback(async () => {
    await fetchGeneralInquiries();
  }, [fetchGeneralInquiries]);

  // ─── Format date ──────────────────────────────────────
  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    const d = new Date(dateString);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${day}\n${h}:${min}`;
  };

  // ─── Status label ─────────────────────────────────────
  const getStatusLabel = (status: string) => {
    const statusKeyMap: Record<string, string> = {
      open: 'inquiry.status.open',
      closed: 'inquiry.status.closed',
      resolved: 'inquiry.status.resolved',
      in_progress: 'inquiry.status.inProgress',
      pending: 'inquiry.status.pending',
      confirmed: 'inquiry.status.confirmed',
      unconfirmed: 'inquiry.status.unconfirmed',
      completed: 'inquiry.status.completed',
    };
    const key = statusKeyMap[status];
    return (key && t(key)) || status;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'open':
      case 'pending':
      case 'unconfirmed': return COLORS.red;
      case 'in_progress': return '#FF8C00';
      case 'closed':
      case 'resolved':
      case 'confirmed':
      case 'completed': return '#28A745';
      default: return COLORS.gray[500];
    }
  };

  const getProgressStatusLabel = (status?: string) =>
    getOrderProgressStatusLabel(t, status);

  // ═══════════════════════════════════════════════════════
  // ─── HEADER ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════
  const renderHeader = () => (
    <View style={[styles.header, { paddingTop: insets.top + SPACING.xs }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
        {onEmbeddedBack ? (
          <TouchableOpacity onPress={onEmbeddedBack} accessibilityRole="button" accessibilityLabel="Back">
            <Icon name="arrow-back" size={22} color={COLORS.black} />
          </TouchableOpacity>
        ) : null}
        <Text style={[styles.headerTitle, !!onEmbeddedBack && { marginLeft: SPACING.sm }]}>문의</Text>
      </View>
      <View style={styles.headerRight}>
        <TouchableOpacity
          style={styles.headerIcon}
          onPress={() => navigation.navigate('LanguageSettings')}
          activeOpacity={0.7}
        >
          <Text style={styles.headerLangFlag}>{getMessageLanguageFlag(locale)}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.headerIcon}
          onPress={() => navigation.navigate('Search')}
          activeOpacity={0.7}
        >
          <SearchIcon width={22} height={22} color={COLORS.black} />
        </TouchableOpacity>
      </View>
    </View>
  );

  // ═══════════════════════════════════════════════════════
  // ─── TABS ──────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════
  const tabs: { key: TabType; label: string; icon: string; count?: number; unread?: number }[] = [
    { key: 'order', label: t('home.orderInquiry'), icon: '📋', count: orderInquiries.length, unread: orderUnreadCount },
    { key: 'general', label: t('home.oneToOne'), icon: '👤', unread: generalInquiryUnreadCount },
    { key: 'fileDownload', label: t('home.fileDownload'), icon: '📥' },
  ];

  const renderTabs = () => (
    <View style={styles.tabContainer}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.key;
        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, isActive && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <View>
              <Text style={styles.tabIcon}>{tab.icon}</Text>
              {tab.unread != null && tab.unread > 0 && (
                <View style={styles.tabUnreadBadge}>
                  <Text style={styles.tabUnreadBadgeText}>
                    {tab.unread > 99 ? '99+' : tab.unread}
                  </Text>
                </View>
              )}
            </View>
            <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
              {tab.label}{tab.count != null && tab.count > 0 ? ` (${tab.count})` : ''}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  // ═══════════════════════════════════════════════════════
  // ─── ORDER INQUIRY TAB ─────────────────────────────────
  // ═══════════════════════════════════════════════════════
  const formatMessageCountLabel = (count: number) => {
    const template = t('message.messageCountLabel') || 'Messages {count}';
    return template.replace('{count}', String(count));
  };

  const renderOrderItem = ({ item }: { item: OrderInquiryListItem }) => {
    // 방문 기록의 visitedAt 이 카드의 lastMessageAt 이상이면 "확인완료" 로 표시.
    // 사용자가 본 뒤 admin 이 새 메시지를 보내면 lastMessageAt 이 visitedAt
    // 보다 나중이 되어 다시 미확인으로 돌아간다 (backend status 와 무관).
    const confirmed = isInquiryConfirmedSync(item.inquiryId, item.lastMessageAt);
    // visited 로직이 라벨의 진실의 원천. confirmed 가 아니면(=새 메시지 도착 또는
    // 미방문) 무조건 "미확인". item.status 로 폴백하면, 사용자가 한 번 탭해
    // item.status 가 'confirmed' 로 바뀐 뒤 admin 이 새 메시지를 보냈을 때
    // lastMessageAt 만 갱신되고 status 는 그대로라 "확인완료" 로 잘못 남는다.
    const displayStatus = confirmed ? 'confirmed' : 'unconfirmed';
    // ✓ = 전송 / ✓✓ = 관리자 읽음. readReceiptVersion·readCacheReady 변화 시 재계산.
    const readByAdmin = isReadByAdminSync(item.inquiryId, item.lastMessageAt);

    return (
    <TouchableOpacity
      style={styles.orderItem}
      activeOpacity={0.7}
      onPress={() => {
        // 즉시 로컬 마크 → 카드 라벨 즉시 "확인완료" 로 전환.
        setOrderInquiries((prev) =>
          prev.map((row) =>
            row.inquiryId === item.inquiryId
              ? { ...row, status: 'confirmed', unreadCount: 0 }
              : row,
          ),
        );
        // 영속 저장 — 다음 fetch 가 unconfirmed 로 다시 와도 "확인완료" 유지.
        void markInquiryVisited(item.inquiryId);
        openChat({
          orderId: item.orderId,
          orderNumber: item.orderNumber,
          inquiryId: item.inquiryId,
        });
      }}
    >
      <View>
        {item.imageUrl ? (
          <CachedImage
            uri={item.imageUrl}
            style={styles.orderItemImage}
            resizeMode="cover"
          />
        ) : (
          <Image
            source={require('../../assets/icons/cart_empty.png')}
            style={styles.orderItemImage}
            resizeMode="contain"
          />
        )}
        {item.unreadCount > 0 && (
          <View style={styles.itemUnreadBadge}>
            <Text style={styles.itemUnreadBadgeText}>
              {item.unreadCount > 99 ? '99+' : item.unreadCount}
            </Text>
          </View>
        )}
      </View>
      <View style={styles.orderItemInfo}>
        <Text style={styles.orderItemNumber}>
          {formatOrderDisplayNumber(item.orderNumber, item.orderId)}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={styles.orderItemDate}>{formatDate(item.lastMessageAt || item.createdAt)}</Text>
          <Icon
            name={readByAdmin ? 'checkmark-done' : 'checkmark'}
            size={15}
            color={readByAdmin ? COLORS.red : COLORS.gray[400]}
          />
        </View>
        {item.lastMessagePreview ? (
          <Text style={styles.lastMessagePreview} numberOfLines={1}>
            {item.lastMessagePreview}
          </Text>
        ) : null}
        {item.messageCount > 0 ? (
          <Text style={styles.messageCountText}>{formatMessageCountLabel(item.messageCount)}</Text>
        ) : null}
      </View>
      <View style={styles.orderItemRight}>
        <View style={{ alignItems: 'flex-end' }}>
          {item.progressStatus ? (
            <Text style={[styles.orderItemStatus, { color: COLORS.text.secondary }]}>
              {getProgressStatusLabel(item.progressStatus)}
            </Text>
          ) : null}
          {/* 상태 배지 = 토글 버튼: [확인완료] ↔ [미확인] 수동 전환 */}
          <TouchableOpacity
            style={[styles.statusBadge, { backgroundColor: getStatusColor(displayStatus) + '18' }]}
            activeOpacity={0.7}
            onPress={(e) => {
              e.stopPropagation?.();
              const isConfirmed = displayStatus === 'confirmed';
              if (isConfirmed) {
                // 확인완료 → 미확인
                clearInquiryVisitedSync(item.inquiryId);
                setOrderInquiries((prev) =>
                  prev.map((row) =>
                    row.inquiryId === item.inquiryId ? { ...row, status: 'open' } : row,
                  ),
                );
              } else {
                // 미확인 → 확인완료
                markInquiryVisitedSync(item.inquiryId);
                setOrderInquiries((prev) =>
                  prev.map((row) =>
                    row.inquiryId === item.inquiryId ? { ...row, status: 'confirmed' } : row,
                  ),
                );
              }
            }}
          >
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(displayStatus) }]} />
            <Text style={[styles.statusBadgeText, { color: getStatusColor(displayStatus) }]}>
              {getStatusLabel(displayStatus)}
            </Text>
          </TouchableOpacity>
        </View>
        {/* 카드 삭제 단추 — 클라이언트측 숨김 (백엔드 inquiry 삭제 API 부재).
            상위 TouchableOpacity 의 onPress (= 채팅 열기) 가 같이 발화하지
            않도록 stopPropagation 효과를 위해 별도 TouchableOpacity 로 분리. */}
        <TouchableOpacity
          style={styles.orderItemDeleteButton}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={(e) => {
            e.stopPropagation?.();
            const id = item.inquiryId;
            // 즉시 화면에서 제거 — 영속 저장은 백그라운드로.
            setOrderInquiries((prev) => prev.filter((row) => row.inquiryId !== id));
            void hideInquiry(id);
          }}
          accessibilityRole="button"
          accessibilityLabel="delete"
        >
          <Icon name="trash-outline" size={20} color={COLORS.gray[500]} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
    );
  };

  const renderOrderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Image
        source={require('../../assets/icons/cart_empty.png')}
        style={styles.emptyImage}
        resizeMode="contain"
      />
      <Text style={styles.emptyText}>
        {t('home.noOrderInquiry')}
      </Text>
      <Text style={styles.emptySubtext}>
        {t('message.orderInquiryHint')}
      </Text>
    </View>
  );

  /**
   * 주문문의 카드의 skeleton 행 — 실제 `renderOrderItem` 의 구조와 동일하게
   * 좌측 이미지 자리 (orderItemImage), 가운데 정보 영역 (주문번호 / 날짜 /
   * 마지막 메시지), 우측 상태 영역 (progressStatus + statusBadge) 을 회색
   * 블록으로 표현. SkeletonBlock 의 shimmer 가 자동 적용된다.
   */
  const renderOrderSkeletonRow = (key: string) => (
    <View key={key} style={styles.orderItem}>
      <SkeletonBlock width={56} height={56} borderRadius={8} />
      <View style={styles.orderItemInfo}>
        <SkeletonBlock width={'60%' as any} height={14} borderRadius={3} />
        <View style={{ height: 6 }} />
        <SkeletonBlock width={'40%' as any} height={11} borderRadius={3} />
        <View style={{ height: 6 }} />
        <SkeletonBlock width={'80%' as any} height={12} borderRadius={3} />
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <SkeletonBlock width={64} height={12} borderRadius={3} />
        <View style={{ height: 8 }} />
        <SkeletonBlock width={80} height={22} borderRadius={11} />
      </View>
    </View>
  );

  const renderOrderTab = () => {
    if (orderLoading && orderInquiries.length === 0) {
      // ActivityIndicator 대신 skeleton 행을 6개 표시. 실제 카드 레이아웃과 같은
      // 모양이라 데이터 도착 직후 시각적 점프가 작다.
      return (
        <View>
          {Array.from({ length: 6 }).map((_, i) => renderOrderSkeletonRow(`order-skel-${i}`))}
        </View>
      );
    }
    // 사용자가 카드의 휴지통 단추로 삭제한 inquiryId 는 목록에서 제외.
    const visibleOrderInquiries = orderInquiries.filter(
      (it) => !isInquiryHiddenSync(it.inquiryId),
    );
    return (
      <FlatList
        data={visibleOrderInquiries}
        keyExtractor={(item) => item.inquiryId || item.orderId}
        renderItem={renderOrderItem}
        extraData={`${inquiryReadReceiptVersion}-${readCacheReady}`}
        ListEmptyComponent={renderOrderEmptyState}
        contentContainerStyle={visibleOrderInquiries.length === 0 ? styles.emptyListContent : undefined}
        refreshControl={<RefreshControl refreshing={orderRefreshing} onRefresh={handleOrderRefresh} />}
      />
    );
  };

  // ═══════════════════════════════════════════════════════
  // ─── 1:1 INQUIRY TAB ──────────────────────────────────
  // ═══════════════════════════════════════════════════════
  const renderGeneralItem = ({ item }: { item: GeneralInquiry }) => {
    const isClosed = item.status === 'closed' || item.status === 'resolved';
    const unread = (item as any).unreadCount || 0;
    const messageCount = (item as any).messageCount || item.messages?.length || 0;
    // ✓ = 전송 / ✓✓ = 관리자 읽음.
    const readByAdmin = isReadByAdminSync(item._id, item.lastMessageAt || item.createdAt);

    return (
      <TouchableOpacity
        style={[styles.generalItem, isClosed && styles.generalItemClosed]}
        activeOpacity={0.7}
        onPress={() => navigation.navigate('GeneralInquiryChat', { inquiryId: item._id })}
      >
        <View style={styles.generalItemContent}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.generalItemSubject} numberOfLines={1}>
              {item.subject || t('home.noSubject')}
            </Text>
            {unread > 0 && (
              <View style={styles.itemUnreadBadge}>
                <Text style={styles.itemUnreadBadgeText}>
                  {unread > 99 ? '99+' : unread}
                </Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={styles.generalItemDate}>{formatDate(item.lastMessageAt || item.createdAt)}</Text>
            <Icon
              name={readByAdmin ? 'checkmark-done' : 'checkmark'}
              size={15}
              color={readByAdmin ? COLORS.red : COLORS.gray[400]}
            />
          </View>
          {messageCount > 0 ? (
            <Text style={styles.messageCountText}>{formatMessageCountLabel(messageCount)}</Text>
          ) : null}
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) + '18' }]}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(item.status) }]} />
            <Text style={[styles.statusBadgeText, { color: getStatusColor(item.status) }]}>
              {getStatusLabel(item.status)}
            </Text>
          </View>
        </View>
        {item.status === 'resolved' && (
          <TouchableOpacity style={styles.generalItemClose}>
            <Icon name="close-circle-outline" size={18} color={COLORS.gray[400]} />
          </TouchableOpacity>
        )}
        {/* 카드 삭제 단추 — 주문문의 탭과 동일한 클라이언트측 숨김 패턴.
            상태 라벨 오른쪽 끝에 위치한다. */}
        <TouchableOpacity
          style={styles.orderItemDeleteButton}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={(e) => {
            e.stopPropagation?.();
            const id = item._id;
            setGeneralInquiriesLocal((prev: any[]) =>
              prev.filter((row) => row._id !== id),
            );
            void hideInquiry(id);
          }}
          accessibilityRole="button"
          accessibilityLabel="delete"
        >
          <Icon name="trash-outline" size={20} color={COLORS.gray[500]} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  const renderGeneralEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Image
        source={require('../../assets/icons/cart_empty.png')}
        style={styles.emptyImage}
        resizeMode="contain"
      />
      <Text style={styles.emptyText}>
        {t('home.noGeneralInquiry')}
      </Text>
      <Text style={styles.emptySubtext}>
        {t('home.generalInquiryHint')}
      </Text>
    </View>
  );

  const renderGeneralTab = () => {
    // 삭제(=숨김) 처리된 inquiryId 는 목록에서 제외.
    const data = generalInquiriesLocal.filter((it: any) => !isInquiryHiddenSync(it._id));
    if (generalLoading && data.length === 0) {
      return <View style={styles.loadingContainer}><ActivityIndicator size="large" color={COLORS.red} /></View>;
    }
    return (
      <View style={{ flex: 1 }}>
        <FlatList
          data={data}
          keyExtractor={(item) => item._id}
          renderItem={renderGeneralItem}
          extraData={`${inquiryReadReceiptVersion}-${readCacheReady}`}
          ListEmptyComponent={renderGeneralEmptyState}
          contentContainerStyle={data.length === 0 ? styles.emptyListContent : undefined}
          refreshControl={<RefreshControl refreshing={false} onRefresh={handleGeneralRefresh} />}
        />
        {/* New inquiry button */}
        <TouchableOpacity
          style={styles.newInquiryButton}
          onPress={() => navigation.navigate('GeneralInquiryChat', {})}
        >
          <Text style={styles.newInquiryButtonText}>+ {t('home.newInquiry')}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  // ═══════════════════════════════════════════════════════
  // ─── FILE DOWNLOAD TAB ─────────────────────────────────
  // ═══════════════════════════════════════════════════════
  const getFileExtension = (url: string) => {
    const match = url.match(/\.(\w+)(?:\?|$)/);
    return match ? match[1].toUpperCase() : 'FILE';
  };

  const getFileIcon = (url: string) => {
    const ext = getFileExtension(url).toLowerCase();
    switch (ext) {
      case 'pdf': return 'document-text-outline';
      case 'doc': case 'docx': return 'document-outline';
      case 'xls': case 'xlsx': return 'grid-outline';
      case 'ppt': case 'pptx': return 'easel-outline';
      case 'zip': case 'rar': return 'archive-outline';
      case 'jpg': case 'jpeg': case 'png': case 'gif': return 'image-outline';
      default: return 'document-outline';
    }
  };

  const handleFileDownload = (file: FormFile) => {
    if (file.fileUrl) {
      Linking.openURL(file.fileUrl).catch(() => {});
    }
  };

  const renderFileItem = ({ item }: { item: FormFile }) => {
    const title = item.title?.[locale] || item.title?.en || item.title?.ko || item.title?.zh || 'Untitled';
    const ext = getFileExtension(item.fileUrl);
    const date = new Date(item.createdAt);
    const dateStr = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

    return (
      <TouchableOpacity
        style={styles.fileItem}
        activeOpacity={0.7}
        onPress={() => handleFileDownload(item)}
      >
        <View style={styles.fileIconContainer}>
          <Icon name={getFileIcon(item.fileUrl)} size={28} color={COLORS.red} />
        </View>
        <View style={styles.fileInfo}>
          <Text style={styles.fileTitle} numberOfLines={2}>{title}</Text>
          <Text style={styles.fileMeta}>{ext} · {dateStr}</Text>
        </View>
        <TouchableOpacity style={styles.fileDownloadButton} onPress={() => handleFileDownload(item)}>
          <Icon name="download-outline" size={22} color={COLORS.red} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  const renderFileDownloadTab = () => {
    if (filesLoading && formFiles.length === 0) {
      return <View style={styles.loadingContainer}><ActivityIndicator size="large" color={COLORS.red} /></View>;
    }
    return (
      <FlatList
        data={formFiles}
        keyExtractor={(item) => item._id}
        renderItem={renderFileItem}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Icon name="folder-open-outline" size={64} color={COLORS.gray[300]} />
            <Text style={styles.emptyText}>
              {t('message.noFiles')}
            </Text>
          </View>
        }
        contentContainerStyle={formFiles.length === 0 ? styles.emptyListContent : undefined}
        refreshControl={<RefreshControl refreshing={false} onRefresh={fetchFormFiles} />}
      />
    );
  };

  // ═══════════════════════════════════════════════════════
  // ─── MAIN RENDER ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════
  return (
    <View style={styles.container}>
      {renderHeader()}
      {renderTabs()}
      <View style={styles.content}>
        {showHeavyContent && activeTab === 'order' && renderOrderTab()}
        {showHeavyContent && activeTab === 'general' && renderGeneralTab()}
        {showHeavyContent && activeTab === 'fileDownload' && renderFileDownloadTab()}
      </View>
    </View>
  );
};

// ═══════════════════════════════════════════════════════
// ─── STYLES ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.sm,
    backgroundColor: COLORS.background,
  },
  headerTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  headerIcon: {
    padding: SPACING.xs,
  },
  headerLangFlag: {
    fontSize: 22,
  },

  // Tabs
  tabContainer: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    backgroundColor: COLORS.background,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.xs / 2,
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.red,
  },
  tabIcon: {
    fontSize: 14,
  },
  tabUnreadBadge: {
    position: 'absolute',
    top: -6,
    right: -10,
    backgroundColor: '#FF0000',
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  tabUnreadBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  tabText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '500',
    color: COLORS.gray[500],
  },
  tabTextActive: {
    fontWeight: '700',
    color: COLORS.red,
  },

  // Content
  content: {
    flex: 1,
  },

  // Order inquiry item
  orderItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.smmd,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  orderItemImage: {
    width: 48,
    height: 48,
    borderRadius: BORDER_RADIUS.sm,
    marginRight: SPACING.sm,
    backgroundColor: COLORS.gray[100],
  },
  orderItemInfo: {
    flex: 1,
  },
  orderItemNumber: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  orderItemDate: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
    marginTop: 2,
  },
  lastMessagePreview: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    marginTop: 2,
  },
  messageCountText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[400],
    marginTop: 2,
  },
  orderItemStatus: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '600',
    textAlign: 'right',
  },
  // 카드 오른쪽: 상태 라벨/배지 + 삭제 단추를 가로로 정렬.
  // 삭제 단추는 상태 배지 오른쪽에 위치한다.
  orderItemRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orderItemDeleteButton: {
    marginLeft: SPACING.sm,
    padding: SPACING.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemUnreadBadge: {
    backgroundColor: '#FF0000',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: 5,
  },
  itemUnreadBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700' as const,
  },
  statusBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 4,
    alignSelf: 'flex-end' as const,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 5,
  },
  statusBadgeText: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '600' as const,
  },

  // General inquiry item
  generalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.smmd,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
    backgroundColor: COLORS.white,
  },
  generalItemClosed: {
    backgroundColor: COLORS.gray[50],
  },
  generalItemContent: {
    flex: 1,
  },
  generalItemSubject: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: 2,
  },
  generalItemDate: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
  },
  generalItemStatus: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '600',
    marginTop: 2,
  },
  generalItemClose: {
    padding: SPACING.xs,
    marginLeft: SPACING.xs,
  },

  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
  },
  emptyImage: {
    width: 100,
    height: 100,
    marginBottom: SPACING.md,
    opacity: 0.7,
  },
  emptyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[500],
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[400],
    textAlign: 'center',
    marginTop: SPACING.xs,
  },
  emptyListContent: {
    flexGrow: 1,
  },

  // Loading
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // New inquiry button
  newInquiryButton: {
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.full,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xl,
    alignSelf: 'center',
    marginBottom: SPACING.lg,
  },
  newInquiryButtonText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.white,
  },

  // File download item
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.smmd,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  fileIconContainer: {
    width: 44,
    height: 44,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: '#FFF0F0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
  fileInfo: {
    flex: 1,
  },
  fileTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  fileMeta: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
    marginTop: 2,
  },
  fileDownloadButton: {
    padding: SPACING.sm,
  },
});

export default MessageScreen;

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  FlatList,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
  RefreshControl,
} from 'react-native';
import Icon from '../../../../components/Icon';
import { ScreenSkeleton } from '../../../../components/Skeleton';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../../../constants';
import { RootStackParamList, Product } from '../../../../types';
import { ProductCard, SearchButton } from '../../../../components';
import TuneIcon from '../../../../assets/icons/TuneIcon';
import GridViewIcon from '../../../../assets/icons/GridViewIcon';
import HeartIcon from '../../../../assets/icons/HeartIcon';
import ViewedIcon from '../../../../assets/icons/ViewedIcon';
import OfficialSupportIcon from '../../../../assets/icons/OfficialSupportIcon';
import FeedbackIcon from '../../../../assets/icons/FeedbackIcon';
import CustomerSupportIcon from '../../../../assets/icons/CustomerSupportIcon';
import HeadsetMicIcon from '../../../../assets/icons/HeadsetMicIcon';
import SellerShopIcon from '../../../../assets/icons/SellerShopIcon';
import { OrderFilterModal, BuyListProductSelectionModal } from '../../../../components';
import type { BuyListProductSelectionItem } from '../../../../components/BuyListProductSelectionModal';
import { useGetOrdersMutation } from '../../../../hooks/useGetOrdersMutation';
import { Order as ApiOrder } from '../../../../services/orderApi';
import {
  API_PROGRESS_STATUS_META,
  PURCHASE_DASHBOARD_STATUSES,
  WAREHOUSE_DASHBOARD_STATUSES,
  ERROR_DASHBOARD_STATUSES,
} from '../../../../utils/apiProgressStatus';
import { useToast } from '../../../../context/ToastContext';
import {
  buildEmbedNavigateHelper,
  useProfileTabletEmbed,
} from '../ProfileTabletEmbedContext';
import { useRecommendationsMutation } from '../../../../hooks/useRecommendationsMutation';
import { useWishlistStatus } from '../../../../hooks/useWishlistStatus';
import { useAddToWishlistMutation } from '../../../../hooks/useAddToWishlistMutation';
import { useDeleteFromWishlistMutation } from '../../../../hooks/useDeleteFromWishlistMutation';
import { useAuth } from '../../../../context/AuthContext';
import { usePlatformStore } from '../../../../store/platformStore';
import { useAppSelector } from '../../../../store/hooks';
import {
  coerceDisplayText,
  extractCompanyNameFromProductDetail,
  formatPriceCNY,
  resolveOrderItemCompanyName,
} from '../../../../utils/i18nHelpers';
import { productsApi } from '../../../../services/productsApi';
import { fetchAdditionalServices } from '../../../../services/additionalServicesApi';
import { translations } from '../../../../i18n/translations';
import { useCancelOrderMutation } from '../../../../hooks/useCancelOrderMutation';
import { cartApi } from '../../../../services/cartApi';
import type { ViewFilterType } from '../../../../services/orderApi';
import { inquiryApi } from '../../../../services/inquiryApi';
import { useSocket } from '../../../../context/SocketContext';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../../../../constants';
import PrintIcon from '../../../../assets/icons/PrintIcon';
import ExportOrderIcon from '../../../../assets/icons/ExportOrderIcon';
import HomeIcon from '../../../../assets/icons/HomeIcon';
import AccountIcon from '../../../../assets/icons/AccountIcon';
import MessageIcon from '../../../../assets/icons/MessageIcon';
import ReceiptIcon from '../../../../assets/icons/ReceiptIcon';
import CartIcon from '../../../../assets/icons/CartIcon';
import EditIcon from '../../../../assets/icons/EditIcon';
import { WebView } from 'react-native-webview';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  orderApi,
  mapLocaleToOrdersLang,
  normalizeProgressStatus,
  resolveOrderItemUnitPrice,
  resolveOrderTotalKRW,
  resolveOrderProgressStatus,
  isShippingAgencyOrder,
} from '../../../../services/orderApi';
import {
  computeProgressStatusCounts,
  computeStatusGroupCounts,
} from '../../../../utils/orderCounts';
import {
  buildAddToCartRequestFromDetail,
  buildOrderItemCartFallback,
} from '../../../../utils/buildAddToCartRequest';
import {
  isBankPaymentPendingSync,
  prewarmPendingBankPayments,
  clearBankPaymentPending,
} from '../../../../utils/pendingBankPayments';

type BuyListScreenNavigationProp = StackNavigationProp<RootStackParamList, 'BuyList'>;
type BuyListScreenRouteProp = RouteProp<RootStackParamList, 'BuyList'>;

const resolveOrderAddServiceIconUri = (
  service: { id?: string; imageUrl?: string[] },
  catalogById: Record<string, string>,
): string | undefined => {
  if (service.id && catalogById[service.id]) {
    return catalogById[service.id];
  }
  const uploaded = service.imageUrl?.find((url) => typeof url === 'string' && url.trim());
  return uploaded?.trim() || undefined;
};

interface OrderItem {
  productName: string;
  quantity: number;
  price: number;
  image: string;
  companyName: string;
  companyNameMultiLang?: Record<string, unknown>;
  sellerOpenId: string;
  offerId: string;
  itemId?: string; // MongoDB _id from API
  itemUniqueNo?: number;
  subtotal: number;
  source?: string;
  otherSite?: string;
  specId?: string;
  skuId?: string;
  addServices?: Array<{ id?: string; note?: string; imageUrl?: string[] }>;
  skuAttributes?: {
    attributeId?: number;
    attributeName: string;
    attributeNameTrans: string;
    value: string;
    valueTrans: string;
    skuImageUrl?: string;
  }[];
}

interface Order {
  id: string;
  orderId?: string; // Order ID from API
  orderNumber: string;
  date: string;
  status: 'category' | 'unpaid' | 'progressing' | 'end' | 'pending_review' | 'error' | 'refunds';
  progressStatus: string;
  statusGroup: 'purchase_agency' | 'warehouse' | 'international_shipping' | 'error' | 'other';
  statusTranslationKey: string;
  items: OrderItem[];
  totalAmount: number;
  inquiryId?: string; // Inquiry ID if inquiry exists for this order
  unreadCount?: number; // Unread message count for this inquiry
  shippingAddress?: any; // Address information
  transferMethod?: string;
  firstTierCost?: any;
  trackingNumbers?: string[];
  createdAt?: string;
  paymentMethod?: string;
  paymentStatus?: string;
  orderMainInfo?: any;
}

interface StoreGroup {
  companyName: string;
  sellerOpenId: string;
  items: OrderItem[];
  storeTotal: number;
}

// Map API order status to tab status
const mapOrderStatusToTab = (order: ApiOrder): Order['status'] => {
  console.log('🛒 BuyListScreen: Mapping order status:', {
    progressStatus: order.progressStatus,
    orderStatus: order.orderStatus,
    shippingStatus: order.shippingStatus,
    warehouseStatus: order.warehouseStatus,
    paymentStatus: order.paymentStatus,
  });
  
  // Map based on progressStatus and orderStatus from real API
  if (order.progressStatus === 'P_PENDING' || order.progressStatus === 'BUY_PAY_WAIT') {
    console.log('🛒 BuyListScreen: Mapped to unpaid (payment pending)');
    return 'unpaid';
  }
  if (order.orderStatus === 'completed' || order.shippingStatus === 'delivered') {
    console.log('🛒 BuyListScreen: Mapped to pending_review (delivered)');
    return 'pending_review'; // Orders that are delivered but pending review
  }
  if (order.shippingStatus === 'shipped' || order.warehouseStatus === 'warehoused') {
    console.log('🛒 BuyListScreen: Mapped to progressing (shipped/warehoused)');
    return 'progressing';
  }
  if (order.orderStatus === 'reviewed') {
    console.log('🛒 BuyListScreen: Mapped to end (reviewed)');
    return 'end'; // Orders that have been reviewed
  }
  
  // Additional mappings based on real API response
  if (order.shippingStatus === 'not_shipped' && order.orderStatus === 'confirmed') {
    console.log('🛒 BuyListScreen: Mapped to progressing (confirmed but not shipped)');
    return 'progressing';
  }
  
  console.log('🛒 BuyListScreen: Mapped to category (default)');
  return 'category';
};

const STATUS_GROUPS = [
  {
    key: 'purchase_agency',
    title: '발주관리',
    titleKey: 'pages.orders.groups.purchaseAgency',
    statuses: [...PURCHASE_DASHBOARD_STATUSES],
  },
  {
    key: 'warehouse',
    title: '현지입/출고',
    titleKey: 'pages.orders.groups.warehouse',
    statuses: ['P_RECEIPT_APPLICATION', ...WAREHOUSE_DASHBOARD_STATUSES],
  },
  {
    key: 'international_shipping',
    titleKey: 'pages.orders.groups.internationalShipping',
    title: '국제운송',
    statuses: ['IO_DELIVERY_PROGRESS', 'IO_DELIVERY_COMPLETE', 'ORDER_RECEIVED'],
  },
  {
    key: 'error',
    title: '오류',
    titleKey: 'pages.orders.groups.error',
    statuses: [...ERROR_DASHBOARD_STATUSES],
  },
] as const;

const PROGRESS_STATUS_META: Record<string, {
  tab: Order['status'];
  group: Order['statusGroup'];
  translationKey: string;
}> = API_PROGRESS_STATUS_META as Record<string, {
  tab: Order['status'];
  group: Order['statusGroup'];
  translationKey: string;
}>;

/** Canonical progress status for list filtering (handles P_PENDING → BUY_PAY_WAIT, etc.) */
const getCanonicalOrderProgressStatus = (order: {
  progressStatus?: string | null;
  statusHistory?: ApiOrder['statusHistory'];
  paymentStatus?: string | null;
  firstTierCost?: ApiOrder['firstTierCost'];
  orderMainInfo?: ApiOrder['orderMainInfo'];
  orderType?: string;
  orderNumber?: string;
}): string =>
  resolveOrderProgressStatus({
    progressStatus: order.progressStatus,
    statusHistory: order.statusHistory,
    paymentStatus: order.paymentStatus,
    firstTierCost: order.firstTierCost,
    orderMainInfo: order.orderMainInfo,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
  });

// 출고결제대기(2차)는 백엔드/도메인에 따라 IO_PAY_PENDING 또는
// IO_SHIP_PAY_PENDING 으로 들어온다(orderCounts 도 둘을 합산). 그래서 필터에서도
// 둘을 같은 상태로 취급해야 "카운트엔 N 인데 카드는 0 개"인 불일치가 안 생긴다.
const SHIP_PAY_PENDING_STATUSES = new Set(['IO_PAY_PENDING', 'IO_SHIP_PAY_PENDING']);
const orderMatchesProgressStatus = (order: Order, selected: string): boolean => {
  const orderStatus = getCanonicalOrderProgressStatus(order);
  const target = normalizeProgressStatus(selected);
  if (SHIP_PAY_PENDING_STATUSES.has(target)) {
    return SHIP_PAY_PENDING_STATUSES.has(orderStatus);
  }
  return orderStatus === target;
};

const orderBelongsToStatusGroup = (order: Order, groupKey: string): boolean => {
  const group = STATUS_GROUPS.find((g) => g.key === groupKey);
  if (!group) return order.statusGroup === groupKey;
  const canonical = getCanonicalOrderProgressStatus(order);
  return (group.statuses as readonly string[]).includes(canonical);
};

/**
 * 주문을 4개 사업 도메인(구매대행 / 로켓-3PL / VVIC하이패스 / 배송대행) 중
 * 하나로 분류한다. 우선권은:
 *   1) VVIC하이패스  ← orderMainInfo.transferMethod 또는 shippingMethod 에 'VVIC' 포함
 *   2) 로켓/3PL      ← orderType==='Rocket' 또는 shippingMethod==='로켓배송'
 *   3) 배송대행      ← orderType==='Shipping' (위 1·2 조건이 모두 거짓일 때)
 *   4) 구매대행      ← 그 외 (General 등)
 *
 * 백엔드가 한 항목에 여러 신호를 동시에 줄 수 있어 (예: requestType='Shipping' +
 * transferMethod='VVIC(육로)항공'), VVIC 가 우선이라는 규칙은 응답자료의
 * P00000014 케이스에서 직접 드러난다.
 */
type BuyListBusinessDomain =
  | 'purchase_agency'
  | 'rocket_3pl'
  | 'vvic_hipass'
  | 'shipping_agency';

const resolveOrderBusinessDomain = (order: Order): BuyListBusinessDomain => {
  const info: any = (order as any).orderMainInfo || {};
  const orderType = String((order as any).orderType || '').toLowerCase();
  const transferMethod = String(info.transferMethod || '').toLowerCase();
  const shippingMethod = String(info.shippingMethod || '').toLowerCase();
  const requestType = String(info.requestType || '').toLowerCase();

  // 1) VVIC 하이패스 — 신호가 들어 있으면 무조건 우선.
  if (transferMethod.includes('vvic') || shippingMethod.includes('vvic')) {
    return 'vvic_hipass';
  }
  // 2) 로켓/3PL — orderType / requestType / shippingMethod 중 어디에든 'Rocket' / '로켓배송' 신호.
  if (
    orderType === 'rocket' ||
    requestType === 'rocket' ||
    shippingMethod.includes('로켓') ||
    shippingMethod.includes('rocket')
  ) {
    return 'rocket_3pl';
  }
  // 3) 배송대행 — requestType / orderType 이 Shipping.
  if (orderType === 'shipping' || requestType === 'shipping') {
    return 'shipping_agency';
  }
  // 4) 구매대행 — General / 기본값.
  return 'purchase_agency';
};

const coerceAmount = (value: unknown): number => {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const translateOrderOptionLabel = (value: string, translate: (key: string) => string): string => {
  if (!value) return '';
  const key = `cartOrder.orderModal.optionLabels.${value}`;
  const translated = translate(key);
  return translated !== key ? translated : value;
};

const formatBuyListOrderDate = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
};

const getBusinessDomainBadgeLabel = (
  domain: BuyListBusinessDomain,
  _translate: (key: string) => string,
): string => {
  // 우측 상단 컴팩트 배지에 표시되는 한 글자 식별자.
  //   구매대행 → "구"   /  로켓배송 → "로"
  //   VVIC    → "V"   /  배송대행 → "배"
  if (domain === 'vvic_hipass') return 'V';
  if (domain === 'rocket_3pl') return '로';
  if (domain === 'shipping_agency') return '배';
  return '구';
};

const buildOrderLogisticsSummary = (order: Order, translate: (key: string) => string): string => {
  const info: any = order.orderMainInfo || {};
  const parts = [
    info.logisticsCenter,
    info.shippingMethod || info.transferMethod,
    (order as any).applicationCategory,
    info.businessType || info.recipientType || info.customsType,
  ]
    .map((value) => (value ? translateOrderOptionLabel(String(value), translate) : ''))
    .filter(Boolean);
  return parts.join(' / ');
};

const resolveOrderProductTotalKRW = (order: Order): number => {
  const tier = order.firstTierCost;
  return (
    coerceAmount(tier?.productTotalKRW) ||
    coerceAmount(tier?.realProductTotalKRW) ||
    order.items.reduce((sum, item) => sum + (item.subtotal || item.price * item.quantity), 0)
  );
};

const resolveOrderShippingKRW = (order: Order): number =>
  coerceAmount(order.firstTierCost?.chinaShippingKRW) ||
  coerceAmount(order.firstTierCost?.baseInternationalShippingKRW);

const formatSkuAttributeLines = (skuAttributes?: OrderItem['skuAttributes']): string[] => {
  if (!skuAttributes?.length) return [];
  return skuAttributes
    .map((attr) => {
      const name = attr.attributeNameTrans || attr.attributeName || '';
      const value = attr.valueTrans || attr.value || '';
      if (name && value) return `${name}: ${value}`;
      return value || name;
    })
    .filter(Boolean);
};

const mapOrderStatusMeta = (order: ApiOrder): Pick<Order, 'status' | 'statusGroup' | 'statusTranslationKey' | 'progressStatus'> => {
  const progressStatus = resolveOrderProgressStatus({
    progressStatus: order.progressStatus,
    statusHistory: order.statusHistory,
    paymentStatus: order.paymentStatus,
    firstTierCost: order.firstTierCost,
    orderMainInfo: order.orderMainInfo,
    orderType: order.orderType,
    orderNumber: order.orderNumber,
  });
  const directMeta = PROGRESS_STATUS_META[progressStatus];
  if (directMeta) {
    return {
      status: directMeta.tab,
      statusGroup: directMeta.group,
      statusTranslationKey: directMeta.translationKey,
      progressStatus,
    };
  }

  if (order.orderStatus === 'completed' || order.shippingStatus === 'delivered') {
    return {
      status: 'pending_review',
      statusGroup: 'international_shipping',
      statusTranslationKey: 'pages.orders.status.orderReceived',
      progressStatus,
    };
  }

  if (order.shippingStatus === 'shipped' || order.warehouseStatus === 'warehoused') {
    return {
      status: 'progressing',
      statusGroup: 'warehouse',
      statusTranslationKey: 'pages.orders.status.shipmentComplete',
      progressStatus,
    };
  }

  if (order.orderStatus === 'reviewed') {
    return {
      status: 'end',
      statusGroup: 'international_shipping',
      statusTranslationKey: 'pages.orders.status.orderReceived',
      progressStatus,
    };
  }

  const fallbackNormalized = normalizeProgressStatus(progressStatus);
  const fallbackMeta = PROGRESS_STATUS_META[fallbackNormalized];
  if (fallbackMeta) {
    return {
      status: fallbackMeta.tab,
      statusGroup: fallbackMeta.group,
      statusTranslationKey: fallbackMeta.translationKey,
      progressStatus: fallbackNormalized,
    };
  }

  const history = order.statusHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const fromHistory = normalizeProgressStatus(history[i]?.status);
    const historyMeta = PROGRESS_STATUS_META[fromHistory];
    if (historyMeta) {
      return {
        status: historyMeta.tab,
        statusGroup: historyMeta.group,
        statusTranslationKey: historyMeta.translationKey,
        progressStatus: fromHistory,
      };
    }
  }

  if (/^P_AU_/.test(fallbackNormalized) || /^BUYING_/.test(fallbackNormalized)) {
    return {
      status: 'progressing',
      statusGroup: 'purchase_agency',
      statusTranslationKey: 'pages.orders.status.purchasing',
      progressStatus: fallbackNormalized,
    };
  }

  if (/^IO_/.test(fallbackNormalized)) {
    return {
      status: 'progressing',
      statusGroup: 'warehouse',
      statusTranslationKey: 'pages.orders.status.warehouseProcessing',
      progressStatus: fallbackNormalized,
    };
  }

  if (/^E_/.test(fallbackNormalized) || /^RETURN_/.test(fallbackNormalized)) {
    const refundMeta = PROGRESS_STATUS_META[fallbackNormalized];
    if (refundMeta) {
      return {
        status: refundMeta.tab,
        statusGroup: refundMeta.group,
        statusTranslationKey: refundMeta.translationKey,
        progressStatus: fallbackNormalized,
      };
    }
    return {
      status: 'refunds',
      statusGroup: 'error',
      statusTranslationKey: 'pages.orders.status.userRefundRequest',
      progressStatus: fallbackNormalized,
    };
  }

  if (fallbackNormalized === 'P_TEMPSAVE') {
    return {
      status: 'category',
      statusGroup: 'purchase_agency',
      statusTranslationKey: 'pages.orders.status.tempSave',
      progressStatus: fallbackNormalized,
    };
  }

  if (
    isShippingAgencyOrder({
      orderMainInfo: order.orderMainInfo,
      orderType: order.orderType,
      orderNumber: order.orderNumber,
    })
  ) {
    const receiptMeta = PROGRESS_STATUS_META.P_RECEIPT_APPLICATION;
    return {
      status: receiptMeta.tab,
      statusGroup: receiptMeta.group,
      statusTranslationKey: receiptMeta.translationKey,
      progressStatus: fallbackNormalized || 'P_RECEIPT_APPLICATION',
    };
  }

  return {
    status: 'category',
    statusGroup: 'other',
    statusTranslationKey: 'pages.orders.status.noOrderInfo',
    progressStatus: fallbackNormalized || progressStatus,
  };
};

type BuyListScreenProps = {
  embedded?: boolean;
  embeddedDomain?: BuyListBusinessDomain | 'error_management' | 'refund_management';
  embeddedInitialTab?: string;
  embeddedProgressStatus?: string;
  embeddedUnconfirmedOnly?: boolean;
};

const BuyListScreen: React.FC<BuyListScreenProps> = ({
  embedded = false,
  embeddedDomain,
  embeddedInitialTab,
  embeddedProgressStatus,
  embeddedUnconfirmedOnly,
}) => {
  const navigation = useNavigation<BuyListScreenNavigationProp>();
  const route = useRoute<BuyListScreenRouteProp>();
  const profileEmbed = useProfileTabletEmbed();
  const embedNavigate = useMemo(
    () =>
      buildEmbedNavigateHelper(profileEmbed, embedded, (target, params) => {
        (navigation as any).navigate(target, params);
      }),
    [profileEmbed, embedded, navigation],
  );
  const { showToast } = useToast();
  const { user, isGuest } = useAuth();
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const { selectedPlatform } = usePlatformStore();
  const { isProductLiked } = useWishlistStatus();
  const { onMessageReceived, isConnected, connect, unreadCount: socketUnreadCount, generalInquiryUnreadCount } = useSocket();
  const totalMessageUnread = socketUnreadCount + generalInquiryUnreadCount;
  
  const initialTab =
    (embedded && embeddedInitialTab
      ? embeddedInitialTab
      : route.params?.initialTab) as Order['status'] || 'purchase_agency';
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [selectedStatusGroup, setSelectedStatusGroup] = useState<Order['statusGroup'] | null>(null);
  const [expandedStatusGroup, setExpandedStatusGroup] = useState<Order['statusGroup'] | null>(null);
  // 현재 활성 사업 도메인 — 발주관리 드롭다운에서 선택되거나, 외부(예: ProfileScreen
  // 의 내주문 카드)에서 route.params.domain 으로 진입할 때 결정된다.
  // 'purchase_agency' 가 기본값이며 이때만 기존 BuyListScreen 본문(주문 카드 리스트)
  // 이 그대로 표시된다. 나머지 4개 도메인은 BuyListScreen 안에서 별도의
  // placeholder 대시보드를 렌더한다 (페지 이동 없이 본문만 교체).
  type ErrorSubFilter =
    | 'error_management'
    | 'refund_management'
    | 'shipment_hold'
    | 'problem_product'
    | 'shipping_delay';
  // 'all' = 도메인 필터 없음(전체주문건). 최상단 '전체' 칩이 사용.
  type BusinessDomain = BuyListBusinessDomain | 'all';
  const routeDomain = (embedded ? embeddedDomain : route.params?.domain) as
    | BusinessDomain
    | 'error_management'
    | 'refund_management'
    | undefined;
  const initialDomain: BusinessDomain =
    routeDomain === 'error_management' || routeDomain === 'refund_management'
      ? 'purchase_agency'
      : (routeDomain ?? 'purchase_agency');
  const initialErrorSubFilter: ErrorSubFilter | null =
    routeDomain === 'error_management' || routeDomain === 'refund_management'
      ? routeDomain
      : null;
  const [activeBusinessDomain, setActiveBusinessDomain] = useState<BusinessDomain>(initialDomain);
  const [errorSubFilter, setErrorSubFilter] = useState<ErrorSubFilter | null>(
    initialErrorSubFilter,
  );
  // 발주관리 칩의 화면상 좌표 — 드롭다운을 칩 바로 밑에 띄우기 위해 측정.
  // 화면 회전/스크롤로 위치가 바뀔 수 있으므로 클릭할 때마다 다시 측정한다.
  const [purchaseChipLayout, setPurchaseChipLayout] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const purchaseChipRef = useRef<View | null>(null);
  // 현지입/출고 칩의 화면상 좌표 — 드롭다운을 칩 바로 밑에 띄우고 너비도 칩에 맞춤.
  const [warehouseChipLayout, setWarehouseChipLayout] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const warehouseChipRef = useRef<View | null>(null);
  const [errorChipLayout, setErrorChipLayout] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const errorChipRef = useRef<View | null>(null);
  const [selectedProgressStatus, setSelectedProgressStatus] = useState<string | null>(null);
  // "내 주문 → 미확인" — 라벨 미확인(unreadCount > 0) 주문만 표시하는 필터.
  const [unconfirmedFilter, setUnconfirmedFilter] = useState<boolean>(
    embedded ? !!embeddedUnconfirmedOnly : !!route.params?.unconfirmedOnly,
  );
  // 현지입/출고 드롭다운 필터 — '전체' / '입고' / '출고' 3가지.
  // 'all' 일 때는 현지 그룹 전체, 'in' 은 입고 관련 진행상태, 'out' 은 출고 관련.
  const [warehouseFilter, setWarehouseFilter] = useState<'all' | 'in' | 'out'>('all');
  
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdditionalServices();
      if (cancelled || !res.success || !res.data) return;
      const iconMap: Record<string, string> = {};
      for (const svc of res.data) {
        const iconUri = svc.icon || svc.imageUrl;
        if (iconUri) iconMap[svc.id] = iconUri;
      }
      setAdditionalServiceIconById(iconMap);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Update active tab when route params change
  useEffect(() => {
    if (route.params?.initialTab) {
      setActiveTab(route.params.initialTab as string);
    }
  }, [route.params?.initialTab]);

  useEffect(() => {
    if (!embedded) return;
    if (embeddedInitialTab) {
      setActiveTab(embeddedInitialTab);
    }
  }, [embedded, embeddedInitialTab]);

  useEffect(() => {
    if (!embedded || !embeddedDomain) return;
    setExpandedStatusGroup(null);
    if (
      embeddedDomain === 'error_management' ||
      embeddedDomain === 'refund_management'
    ) {
      setActiveBusinessDomain('purchase_agency');
      setActiveTab('error');
      setErrorSubFilter(embeddedDomain);
      setSelectedProgressStatus(
        embeddedDomain === 'refund_management' ? 'USER_REFUND_REQ' : 'E_ERROR',
      );
      return;
    }
    setActiveBusinessDomain(embeddedDomain);
    setErrorSubFilter(null);
    setSelectedProgressStatus(null);
  }, [embedded, embeddedDomain]);

  // 외부(ProfileScreen 내주문 카드 등)에서 BuyList 라우트에 domain 으로 진입할 때
  // 발주관리 드롭다운에서 그 항목을 직접 '클릭'한 것과 같은 상태가 되도록 부수효과를
  // 모두 적용한다. 단순히 activeBusinessDomain 만 바꾸면 selected 표시는 되지만
  // selectedProgressStatus 같은 부수 필터가 이전 세션 값으로 남아 충돌이 생긴다.
  useEffect(() => {
    const domain = route.params?.domain as
      | BusinessDomain
      | 'error_management'
      | 'refund_management'
      | undefined;
    if (!domain) return;
    setExpandedStatusGroup(null);
    switch (domain) {
      case 'purchase_agency':
        setActiveBusinessDomain(domain);
        setErrorSubFilter(null);
        setSelectedProgressStatus(null);
        break;
      case 'rocket_3pl':
      case 'vvic_hipass':
      case 'shipping_agency':
        setActiveBusinessDomain(domain);
        setErrorSubFilter(null);
        setSelectedProgressStatus(null);
        break;
      case 'error_management':
        setActiveBusinessDomain('purchase_agency');
        setActiveTab('error');
        setErrorSubFilter('error_management');
        setSelectedProgressStatus('E_ERROR');
        break;
      case 'refund_management':
        setActiveBusinessDomain('purchase_agency');
        setActiveTab('error');
        setErrorSubFilter('refund_management');
        setSelectedProgressStatus('USER_REFUND_REQ');
        break;
    }
  }, [route.params?.domain]);

  useEffect(() => {
    const progressStatus =
      (embedded ? embeddedProgressStatus : route.params?.progressStatus) ?? null;
    if (!progressStatus) return;
    setActiveBusinessDomain('purchase_agency');
    setSelectedProgressStatus(progressStatus);
    if (progressStatus === 'P_MA_PROBLEM') {
      setActiveTab('error');
      setErrorSubFilter('problem_product');
    } else if (progressStatus === 'E_SHIPMENT_HOLD') {
      setActiveTab('error');
      setErrorSubFilter('shipment_hold');
    } else if (progressStatus === 'E_ERROR') {
      setActiveTab('error');
      setErrorSubFilter('error_management');
    } else if (progressStatus === 'IO_DELAY') {
      // 현지배송지연 — 다른 오류 항목과 동일하게 오류 탭의 서브필터로 표시.
      setActiveTab('error');
      setErrorSubFilter('shipping_delay');
    }
  }, [embedded, embeddedProgressStatus, route.params?.progressStatus]);

  // "미확인" 파라미터 동기화 — 진입 시 라벨 미확인 필터 on/off.
  useEffect(() => {
    const next = embedded ? !!embeddedUnconfirmedOnly : !!route.params?.unconfirmedOnly;
    setUnconfirmedFilter(next);
  }, [embedded, embeddedUnconfirmedOnly, route.params?.unconfirmedOnly]);

  const [unreadCounts, setUnreadCounts] = useState<{ [inquiryId: string]: number }>({});
  const [selectAll, setSelectAll] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<string>>(new Set());
  const [ordersRefreshing, setOrdersRefreshing] = useState(false);
  const [orderSearchText, setOrderSearchText] = useState('');
  const [showDateModal, setShowDateModal] = useState(false);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [selectedStartDate, setSelectedStartDate] = useState<Date | null>(null);
  const [selectedEndDate, setSelectedEndDate] = useState<Date | null>(null);
  const [pickingEnd, setPickingEnd] = useState(false);
  // Add to cart modal state
  const [productSelectionItems, setProductSelectionItems] = useState<
    BuyListProductSelectionItem[] | null
  >(null);
  const [isRepurchasing, setIsRepurchasing] = useState(false);
  const [additionalServiceIconById, setAdditionalServiceIconById] = useState<
    Record<string, string>
  >({});
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(56);
  const [showNavModal, setShowNavModal] = useState(false);
  const [cancelOrderModal, setCancelOrderModal] = useState<{ orderId: string } | null>(null);
  // cancelReason 은 id 문자열만 저장 ('changedMyMind' / 'incorrectInfo' /
  // 'outOfStock' / 'other'). 표시 라벨은 t() 로 그때그때 번역한다.
  const [cancelReason, setCancelReason] = useState<string>('changedMyMind');
  const [cancelOtherText, setCancelOtherText] = useState('');
  const [showAllFiltersModal, setShowAllFiltersModal] = useState(false);
  const [filterPlatform, setFilterPlatform] = useState<string>('');
  const [showInlineCalendar, setShowInlineCalendar] = useState(false);
  const [inlineCalendarDate, setInlineCalendarDate] = useState(new Date());
  const [inlinePickingEnd, setInlinePickingEnd] = useState(false);
  // Draft states — only applied when user presses Apply
  const [draftPlatform, setDraftPlatform] = useState<string>('');
  const [draftStartDate, setDraftStartDate] = useState<Date | null>(null);
  const [draftEndDate, setDraftEndDate] = useState<Date | null>(null);
  const [refundModalOrder, setRefundModalOrder] = useState<Order | null>(null);
  const [refundSelectedItems, setRefundSelectedItems] = useState<Set<string>>(new Set());
  const [addressModalVisible, setAddressModalVisible] = useState(false);
  const [selectedOrderForAddress, setSelectedOrderForAddress] = useState<Order | null>(null);
  const [isSavingAddress, setIsSavingAddress] = useState(false);
  const [isDefaultAddress, setIsDefaultAddress] = useState(false);
  const [showKakaoAddress, setShowKakaoAddress] = useState(false);
  const [editAddress, setEditAddress] = useState({
    zonecode: '',
    roadAddress: '',
    detailAddress: '',
    recipient: '',
    contact: '',
    customsCode: '',
  });
  const [filters, setFilters] = useState<{ orderNumber: string; startDate: Date | null; endDate: Date | null }>({
    orderNumber: '',
    startDate: null,
    endDate: null,
  });
  const [orders, setOrders] = useState<Order[]>([]);
  // 무통장 결제 후 "결제중" 표시를 위한 리렌더 트리거. AsyncStorage 의 cache 가
  // 동기 read 되므로 prewarm 완료 후 한 번만 증가시키면 카드들이 다시 그려진다.
  const [pendingBankPaymentsTick, setPendingBankPaymentsTick] = useState(0);
  const storeNameCacheRef = useRef<Map<string, string>>(new Map());
  const [viewFilterCounts, setViewFilterCounts] = useState<Record<string, number>>({});
  /** Snapshot for navigation badges — unfiltered fetch so counts stay accurate while filtering the list */
  const [countOrders, setCountOrders] = useState<
    Array<{
      progressStatus: string;
      paymentStatus?: string;
      firstTierCost?: Order['firstTierCost'];
    }>
  >([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  // Recommendations state for "More to Love"
  const [recommendationsProducts, setRecommendationsProducts] = useState<Product[]>([]);
  const [recommendationsOffset, setRecommendationsOffset] = useState(1); // Current page offset
  const [hasMoreRecommendations, setHasMoreRecommendations] = useState(true); // Whether more products exist
  const isRecommendationsRefreshingRef = React.useRef(false); // Prevent loading during refresh
  const currentRecommendationsPageRef = React.useRef<number>(1); // Track current page for callbacks
  const isLoadingMoreRecommendationsRef = React.useRef(false); // Prevent multiple simultaneous loads

  // Translation function
  const t = (key: string) => {
    const keys = key.split('.');
    let value: any = translations[locale as keyof typeof translations];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  };

  const unknownStoreLabel = t('profile.unknownStore');

  const enrichOrderStoreNames = useCallback(
    async (orderList: Order[]) => {
      const pending = new Map<string, { offerId: string; source: string }>();

      for (const order of orderList) {
        for (const item of order.items) {
          if (resolveOrderItemCompanyName(item as unknown as Record<string, unknown>, 'zh')) {
            continue;
          }
          const offerId = String(item.offerId ?? '').trim();
          if (!offerId) continue;
          const source = item.source || '1688';
          const cacheKey = `${source}:${offerId}`;
          if (storeNameCacheRef.current.has(cacheKey) || pending.has(cacheKey)) continue;
          pending.set(cacheKey, { offerId, source });
        }
      }

      if (pending.size === 0) return;

      const fetched = await Promise.all(
        [...pending.entries()].map(async ([cacheKey, { offerId, source }]) => {
          try {
            // 회사이름은 항상 중국어로 표시하므로 'zh' 로 조회/추출.
            const res = await productsApi.getProductDetail(offerId, source, 'zh');
            const name = res.success
              ? extractCompanyNameFromProductDetail(res.data, 'zh')
              : '';
            return { cacheKey, name };
          } catch {
            return { cacheKey, name: '' };
          }
        }),
      );

      let hasNew = false;
      for (const { cacheKey, name } of fetched) {
        if (name) {
          storeNameCacheRef.current.set(cacheKey, name);
          hasNew = true;
        }
      }
      if (!hasNew) return;

      setOrders((prev) =>
        prev.map((order) => ({
          ...order,
          items: order.items.map((item) => {
            const cacheKey = `${item.source || '1688'}:${item.offerId}`;
            const cached = storeNameCacheRef.current.get(cacheKey);
            if (!cached) return item;
            if (resolveOrderItemCompanyName(item as unknown as Record<string, unknown>, 'zh')) {
              return item;
            }
            return { ...item, companyName: cached };
          }),
        })),
      );
    },
    [locale],
  );

  const resolveStoreName = useCallback(
    (value: unknown, item?: OrderItem): string => {
      const fromItem =
        item != null
          ? resolveOrderItemCompanyName(item as unknown as Record<string, unknown>, 'zh')
          : '';
      return (
        fromItem ||
        coerceDisplayText(value, 'zh', '') ||
        unknownStoreLabel
      );
    },
    [unknownStoreLabel],
  );

  // Add to wishlist mutation
  const { mutate: addToWishlist } = useAddToWishlistMutation({
    onSuccess: async (data) => {
      // console.log('Product added to wishlist successfully:', data);
      showToast(t('home.productAddedToWishlist'), 'success');
    },
    onError: (error) => {
      // console.error('Failed to add product to wishlist:', error);
      showToast(error || t('buyList.failedToAddWishlist'), 'error');
    },
  });

  const { mutate: cancelOrder, isLoading: isCancellingOrder } = useCancelOrderMutation({
    onSuccess: () => {
      showToast(t('home.orderCancelled'), 'success');
      fetchOrdersRef.current();
      fetchOrderCountsRef.current?.();
    },
    onError: (err) => {
      showToast(err || t('buyList.failedToCancelOrder'), 'error');
    },
  });

  const handleConfirmReceived = async (orderId: string) => {
    try {
      const { orderApi } = await import('../../../../services/orderApi');
      const res = await orderApi.confirmReceived(orderId);
      if (res.success) {
        showToast(t('profile.confirmReceipt') || 'Order confirmed', 'success');
        fetchOrdersRef.current();
      } else {
        showToast(res.error || 'Failed to confirm receipt', 'error');
      }
    } catch {
      showToast(t('home.failedToConfirmReceipt'), 'error');
    }
  };

  const repurchaseOrderItems = async (order: Order) => {
    let successCount = 0;
    let failCount = 0;

    for (const item of order.items) {
      const source = item.source || '1688';
      const detailRes = await productsApi.getProductDetail(item.offerId, source, locale);
      if (!detailRes.success || !detailRes.data) {
        failCount += 1;
        continue;
      }

      const request = buildAddToCartRequestFromDetail({
        productDetail: detailRes.data,
        quantity: item.quantity,
        locale,
        preferredSkuId: item.skuId,
        preferredSpecId: item.specId,
        orderItemFallback: buildOrderItemCartFallback(item),
      });

      if (!request) {
        failCount += 1;
        continue;
      }

      const response = await cartApi.addToCart(request, locale);
      if (response.success) {
        successCount += 1;
      } else {
        failCount += 1;
      }
    }

    return { successCount, failCount };
  };

  const showRepurchaseResultToast = (successCount: number, failCount: number) => {
    if (successCount > 0 && failCount === 0) {
      showToast(t('product.addedToCart') || 'Added to cart', 'success');
    } else if (successCount > 0) {
      showToast(
        t('buyList.addToCartPartialSuccess') || 'Some items were added to cart',
        'warning',
      );
    } else {
      showToast(t('product.failedToAdd') || 'Failed to add to cart', 'error');
    }
  };

  const handleOrderInquiry = (order: Order) => {
    // Always go to Chat — orders-proxy loads orderNoteLines; new messages create inquiry if needed
    embedNavigate('Chat', {
      inquiryId: order.inquiryId || undefined,
      orderId: order.id || order.orderId,
      orderNumber: order.orderNumber,
    });
  };

  const collectSelectionItemsFromOrders = (
    selectedOrders: Order[],
  ): BuyListProductSelectionItem[] => {
    const items: BuyListProductSelectionItem[] = [];
    const seen = new Set<string>();
    for (const order of selectedOrders) {
      for (const item of order.items) {
        const key = `${item.offerId}:${item.skuId || item.specId || item.itemId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          offerId: item.offerId,
          productName: item.productName,
          image: item.image,
          companyName: item.companyName,
          companyNameMultiLang: item.companyNameMultiLang,
          source: item.source,
          skuId: item.skuId,
          specId: item.specId,
          quantity: item.quantity,
          price: item.price,
        });
      }
    }
    return items;
  };

  // Delete from wishlist mutation
  const { mutate: deleteFromWishlist } = useDeleteFromWishlistMutation({
    onSuccess: async (data) => {
      // console.log('Product removed from wishlist successfully:', data);
      showToast(t('home.productRemovedFromWishlist'), 'success');
    },
    onError: (error) => {
      // console.error('Failed to remove product from wishlist:', error);
      showToast(error || 'Failed to remove product from wishlist', 'error');
    },
  });

  // Toggle wishlist function
  const toggleWishlist = async (product: any) => {
    if (!user || isGuest) {
      showToast(t('home.pleaseLogin') || 'Please login first', 'warning');
      return;
    }

    // Get product external ID - prioritize externalId, never use MongoDB _id
    const externalId = 
      (product as any).externalId?.toString() ||
      (product as any).offerId?.toString() ||
      '';

    if (!externalId) {
      showToast(t('home.invalidProductId'), 'error');
      return;
    }

    const isLiked = isProductLiked(product);
    const source = (product as any).source || selectedPlatform || '1688';
    const country = locale || 'en';

    if (isLiked) {
      deleteFromWishlist(externalId);
    } else {
      const imageUrl = product.image || product.images?.[0] || '';
      const price = product.price || 0;
      const title = product.name || product.title || '';

      if (!imageUrl || !title || price <= 0) {
        showToast(t('home.invalidProductData'), 'error');
        return;
      }

      addToWishlist({ offerId: externalId, platform: source });
    }
  };

  // Helper function to navigate to product detail
  const navigateToProductDetail = async (
    productId: string | number,
    source: string = selectedPlatform,
    country: string = locale
  ) => {
    embedNavigate('ProductDetail', {
      productId: productId.toString(),
      source: source,
      country: country,
    });
  };

  const handleProductPress = async (product: Product) => {
    const offerId = (product as any).offerId;
    const productIdToUse = offerId || product.id;
    await navigateToProductDetail(productIdToUse, selectedPlatform, locale);
  };

  // Recommendations API mutation with infinite scroll support
  const { 
    mutate: fetchRecommendations, 
    isLoading: recommendationsLoading, 
    isError: recommendationsError 
  } = useRecommendationsMutation({
    onSuccess: (data) => {
      // Updated API structure: data.products (not data.recommendations)
      const productsArray = data?.products || [];
      const currentPage = currentRecommendationsPageRef.current;
      
      // Reset loading flag
      isLoadingMoreRecommendationsRef.current = false;
      
      if (productsArray.length > 0) {
        // Map API response to Product format
        const mappedProducts = productsArray.map((item: any) => {
          const price = parseFloat(item.priceInfo?.price || item.priceInfo?.consignPrice || 0);
          const originalPrice = parseFloat(item.priceInfo?.consignPrice || item.priceInfo?.price || 0);
          const discount = originalPrice > price && originalPrice > 0
            ? Math.round(((originalPrice - price) / originalPrice) * 100)
            : 0;
          
          const productData: Product & { source?: string } = {
            id: item.offerId?.toString() || '',
            externalId: item.offerId?.toString() || '',
            offerId: item.offerId?.toString() || '',
            name: locale === 'zh' ? (item.subject || item.subjectTrans || '') : (item.subjectTrans || item.subject || ''),
            image: item.imageUrl || '',
            price: price,
            originalPrice: originalPrice,
            discount: discount,
            description: '',
            category: { id: '', name: '', icon: '', image: '', subcategories: [] },
            subcategory: '',
            brand: '',
            seller: { 
              id: '', 
              name: '', 
              avatar: '', 
              rating: 0, 
              reviewCount: 0,
              isVerified: false,
              followersCount: 0,
              description: '',
              location: '',
              joinedDate: new Date(),
            },
            rating: 0,
            rating_count: 0,
            reviewCount: 0,
            inStock: true,
            stockCount: 0,
            tags: [],
            isNew: false,
            isFeatured: false,
            isOnSale: discount > 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            orderCount: item.monthSold || 0,
            repurchaseRate: item.repurchaseRate || '',
            source: selectedPlatform,
          };
          
          return productData;
        });
        
        // Check pagination - if we got fewer products than pageSize, no more pages
        const pageSize = 20;
        const hasMore = productsArray.length >= pageSize;
        setHasMoreRecommendations(hasMore);
        
        // If it's the first page, replace products, otherwise append
        if (currentPage === 1) {
          setRecommendationsProducts(mappedProducts);
        } else {
          setRecommendationsProducts(prev => [...prev, ...mappedProducts]);
        }
      } else {
        // No products found
        if (currentPage === 1) {
          setRecommendationsProducts([]);
        }
        setHasMoreRecommendations(false);
      }
    },
    onError: (error) => {
      // Reset loading flag
      isLoadingMoreRecommendationsRef.current = false;
      const currentPage = currentRecommendationsPageRef.current;
      if (currentPage === 1) {
        setRecommendationsProducts([]);
      }
      setHasMoreRecommendations(false);
    },
  });

  // Store fetchRecommendations in ref to prevent dependency issues
  const fetchRecommendationsRef = React.useRef(fetchRecommendations);
  React.useEffect(() => {
    fetchRecommendationsRef.current = fetchRecommendations;
  }, [fetchRecommendations]);

  // Load more recommendations when offset changes (infinite scroll)
  React.useEffect(() => {
    // Prevent loading more data when refreshing or already loading
    if (isRecommendationsRefreshingRef.current || isLoadingMoreRecommendationsRef.current) {
      return;
    }
    
    if (recommendationsOffset > 1 && fetchRecommendationsRef.current && hasMoreRecommendations) {
      isLoadingMoreRecommendationsRef.current = true;
      const outMemberId = user?.id?.toString() || 'dferg0001';
      const platform = '1688'; // Always use 1688 for More to Love products
      currentRecommendationsPageRef.current = recommendationsOffset;
      fetchRecommendationsRef.current(locale, outMemberId, recommendationsOffset, 20, platform)
        .finally(() => {
          isLoadingMoreRecommendationsRef.current = false;
        });
    }
  }, [recommendationsOffset, locale, user?.id, hasMoreRecommendations]);

  // Track if initial fetch has been done (prevent real-time updates)
  const hasInitialFetchRef = React.useRef<string | null>(null);

  // Fetch recommendations only once on mount or when locale/user/platform changes (not real-time)
  React.useEffect(() => {
    if (locale && fetchRecommendationsRef.current) {
      const outMemberId = user?.id?.toString() || 'dferg0001';
      const platform = '1688'; // Always use 1688 for More to Love products
      const fetchKey = `${locale}-${outMemberId}-${platform}`;
      
      // Only fetch if this is the first time or locale/user changed
      if (!hasInitialFetchRef.current || hasInitialFetchRef.current !== fetchKey) {
        hasInitialFetchRef.current = fetchKey;
        // Reset pagination state
        setRecommendationsOffset(1);
        setHasMoreRecommendations(true);
        // Clear existing products BEFORE making the API call
        setRecommendationsProducts([]);
        // Fetch first page
        currentRecommendationsPageRef.current = 1;
        fetchRecommendationsRef.current(locale, outMemberId, 1, 20, platform);
      }
    }
  }, [locale, user?.id, fetchRecommendations]);

  // Get orders mutation
  const mapTabToViewFilter = (tab: string): ViewFilterType => {
    // tab is now a STATUS_GROUP key — always fetch all for group-based tabs
    return 'all';
  };

  const getOrdersOptions = useMemo(() => ({
    onSuccess: async (data: any) => {
      if (!data || !data.orders || !Array.isArray(data.orders)) {
        setOrders([]);
        return;
      }
      const mappedOrders = data.orders.map((order: any) => {
        const statusMeta = mapOrderStatusMeta(order);
        const totalAmount = resolveOrderTotalKRW(order);
        return {
          id: order.id,
          orderId: order.id,
          orderNumber: order.orderNumber,
          date: new Date(order.createdAt).toISOString().split('T')[0],
          ...statusMeta,
          items: (order.items || []).map((item: any) => {
            const quantity = item.quantity || 1;
            const unitPrice = resolveOrderItemUnitPrice(item);
            return {
            productName:
              coerceDisplayText(item.subjectMultiLang, locale, '') ||
              coerceDisplayText(item.subjectTrans, locale, '') ||
              coerceDisplayText(item.subject, locale, '') ||
              t('buyList.unknownProduct'),
            quantity,
            price: unitPrice,
            image: item.imageUrl || item.image || '',
            companyName: resolveOrderItemCompanyName(item, 'zh'),
            companyNameMultiLang:
              item.companyNameMultiLang ??
              (typeof item.companyName === 'object' && item.companyName != null
                ? item.companyName
                : undefined),
            sellerOpenId: item.sellerOpenId || '',
            offerId: String(item.offerId ?? ''),
            itemId: item._id || item.id || '',
            itemUniqueNo: item.itemUniqueNo,
            subtotal: item.subtotal ?? unitPrice * quantity,
            skuAttributes: item.skuAttributes || [],
            addServices: item.addServices || [],
            source:
              item.source ||
              (String(item.otherSite ?? '').includes('taobao') ? 'taobao' : '1688'),
            specId: item.specId || '',
            skuId: String(item.skuId ?? ''),
          };
          }),
          totalAmount,
          // Raw API fields for OrderDetailScreen
          shippingAddress: order.shippingAddress,
          firstTierCost: order.firstTierCost,
          trackingNumbers: order.trackingNumbers || [],
          statusHistory: order.statusHistory || [],
          paymentMethod: order.paymentMethod,
          transferMethod: order.transferMethod,
          warehouseCode: order.warehouseCode,
          createdAt: order.createdAt,
          paidAmount: order.paidAmount,
          paymentStatus: order.paymentStatus,
          orderMainInfo: order.orderMainInfo,
          applicationCategory: order.applicationCategory,
        };
      });
      setOrders(mappedOrders);
      setHasMore(data.pagination?.page < data.pagination?.totalPages);
      if (data.viewFilterCounts) setViewFilterCounts(data.viewFilterCounts);

      // Fetch inquiries and unread counts (non-blocking)
      try {
        const [inquiriesResponse, unreadCountsResponse] = await Promise.all([
          inquiryApi.getInquiries(),
          inquiryApi.getUnreadCounts(),
        ]);
        const inquiryMap = new Map<string, string>();
        if (inquiriesResponse.success && inquiriesResponse.data?.inquiries) {
          inquiriesResponse.data.inquiries.forEach((inquiry: any) => {
            const linkedOrderId =
              typeof inquiry.order === 'string'
                ? inquiry.order
                : inquiry.order?._id || inquiry.orderId || inquiry.order?.id;
            if (linkedOrderId) inquiryMap.set(String(linkedOrderId), inquiry._id);
          });
        }
        let unreadCountsMap: { [inquiryId: string]: number } = {};
        if (unreadCountsResponse.success && unreadCountsResponse.data?.inquiries) {
          unreadCountsResponse.data.inquiries.forEach((inq: any) => {
            const inquiryId = inq.inquiryId || inq._id;
            if (inquiryId && inq.unreadCount > 0) {
              unreadCountsMap[inquiryId] = inq.unreadCount;
            }
          });
        }
        setUnreadCounts(unreadCountsMap);
        const ordersWithInquiries = mappedOrders.map((order: any) => ({
          ...order,
          inquiryId: inquiryMap.get(order.id) || null,
          unreadCount: inquiryMap.get(order.id) ? (unreadCountsMap[inquiryMap.get(order.id)!] || 0) : 0,
        }));
        setOrders(ordersWithInquiries);
        void enrichOrderStoreNames(ordersWithInquiries);
        // backend 가 결제완료 / unpaid 가 아닌 다른 상태로 확정한 주문은
        // "결제중" pending mark 가 더 이상 의미 없으므로 정리한다.
        // (P_PAY_COMPLETE 등으로 진행됐거나 admin 이 취소시킨 경우.)
        for (const o of ordersWithInquiries) {
          const status = (o.progressStatus || '').toString();
          const stillPending = o.status === 'unpaid' || status === 'P_PENDING' || status === 'IO_PAY_PENDING';
          if (!stillPending) {
            void clearBankPaymentPending(o.id);
          }
        }
      } catch {
        // silently fail — orders already set
        void enrichOrderStoreNames(mappedOrders);
      }
    },
    onError: (error: string) => {
      console.error('🛒 BuyListScreen: Failed to fetch orders:', error);
      showToast(error || 'Failed to fetch orders', 'error');
      setOrders([]);
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t/unknownStoreLabel stable enough per locale
  }), [locale, enrichOrderStoreNames]);

  const { mutate: getOrders, isLoading } = useGetOrdersMutation(getOrdersOptions);

  const getOrdersRef = useRef(getOrders);
  getOrdersRef.current = getOrders;

  const fetchOrders = useCallback(() => {
    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const searchQuery = (filters.orderNumber || orderSearchText || '').trim();

    // 기간선택 chip 으로 시작/끝 날짜 중 하나라도 사용자가 지정했으면
    // `datePeriod` (last_6_months 같은 프리셋) 를 보내지 않는다. 둘 다 보내면
    // backend 가 프리셋 윈도우와 periodFrom/To 를 충돌 처리해 결과가 엉뚱하게
    // 나오는 경우가 있다. 사용자 선택이 없을 때만 기본 6 개월 윈도우 적용.
    const hasUserPeriod = !!(selectedStartDate || selectedEndDate);

    return getOrdersRef.current({
      page: 1,
      // 상태 필터가 client-side 라, 목록도 카운트 fetch(100)·ProfileScreen(100)
      // 과 동일하게 100 건을 받아야 한다. 50 만 받으면 카운트엔 잡히지만 목록
      // 51~100 위치에 있는 주문(예: 출고결제대기 IO_PAY_PENDING — 보통 오래된
      // 주문이라 뒤쪽)이 빠져, "카운트>0 인데 카드 0개" 불일치가 생긴다.
      // backend 는 pagesize 최대 100 만 허용(200 은 거절) — 100 이 상한.
      pageSize: 100,
      lang: mapLocaleToOrdersLang(locale),
      search: searchQuery || undefined,
      ...(hasUserPeriod ? {} : { datePeriod: 'last_6_months' as const }),
      platform: filterPlatform || undefined,
      viewFilter: 'all',
      // Status filters are applied client-side so API codes like P_PENDING still match BUY_PAY_WAIT
      periodFrom: selectedStartDate ? formatDate(selectedStartDate) : undefined,
      periodTo: selectedEndDate ? formatDate(selectedEndDate) : undefined,
    });
  }, [
    locale,
    filters.orderNumber,
    orderSearchText,
    filterPlatform,
    selectedStartDate,
    selectedEndDate,
  ]);

  const fetchOrdersRef = useRef(fetchOrders);
  fetchOrdersRef.current = fetchOrders;

  const fetchOrderCounts = useCallback(async () => {
    if (isGuest || !user) return;
    try {
      const response = await orderApi.getOrders({
        page: 1,
        pageSize: 100,
        lang: mapLocaleToOrdersLang(locale),
        viewFilter: 'all',
        datePeriod: 'last_6_months',
      });
      if (response.success && response.data?.orders) {
        setCountOrders(
          response.data.orders.map((order) => ({
            progressStatus: resolveOrderProgressStatus({
              progressStatus: order.progressStatus,
              statusHistory: order.statusHistory,
              paymentStatus: order.paymentStatus,
              firstTierCost: order.firstTierCost,
              orderMainInfo: order.orderMainInfo,
              orderType: order.orderType,
              orderNumber: order.orderNumber,
            }),
            paymentStatus: order.paymentStatus,
            firstTierCost: order.firstTierCost,
            orderMainInfo: order.orderMainInfo,
          })),
        );
        if (response.data.viewFilterCounts) {
          setViewFilterCounts(response.data.viewFilterCounts);
        }
      }
    } catch {
      // counts are non-blocking
    }
  }, [isGuest, user, locale]);

  const fetchOrderCountsRef = useRef(fetchOrderCounts);
  fetchOrderCountsRef.current = fetchOrderCounts;

  const onOrdersRefresh = useCallback(async () => {
    if (isGuest || !user) return;
    setOrdersRefreshing(true);
    try {
      await fetchOrdersRef.current();
      await fetchOrderCountsRef.current();
    } catch {
      // onError handler already surfaces failures
    } finally {
      setOrdersRefreshing(false);
    }
  }, [isGuest, user]);

  const progressStatusCounts = useMemo(
    () => computeProgressStatusCounts(countOrders),
    [countOrders],
  );

  const statusGroupCounts = useMemo(
    () => computeStatusGroupCounts(countOrders, STATUS_GROUPS),
    [countOrders],
  );

  // 사업 도메인별 주문 수 — 발주관리 칩의 카운트 배지 등에서 사용.
  // resolveOrderBusinessDomain 은 orderType / orderMainInfo 를 읽으므로
  // countOrders(가벼운 카운트 전용 튜플)가 아닌 전체 orders 배열을 쓴다.
  // 우선권 규칙(VVIC > Rocket > Shipping > Purchase)은 분류기 안에서 처리.
  const businessDomainCounts = useMemo(() => {
    const counts: Record<BuyListBusinessDomain, number> = {
      purchase_agency: 0,
      rocket_3pl: 0,
      vvic_hipass: 0,
      shipping_agency: 0,
    };
    for (const order of orders) {
      const domain = resolveOrderBusinessDomain(order);
      counts[domain] += 1;
    }
    return counts;
  }, [orders]);

  // Fetch orders from API when tab, filters, or platform change (not on every render)
  useEffect(() => {
    if (!isGuest && user) {
      fetchOrders();
      fetchOrderCounts();
    }
  }, [fetchOrders, fetchOrderCounts, isGuest, user]);

  useFocusEffect(
    useCallback(() => {
      if (!isGuest && user) {
        fetchOrdersRef.current();
        fetchOrderCountsRef.current();
        // 무통장 결제 신청한 주문은 admin 입금 확인 전까지 "결제중" 으로 표시.
        // AsyncStorage 캐시를 prewarm 하고 만료된 항목은 정리한다.
        prewarmPendingBankPayments()
          .then(() => setPendingBankPaymentsTick((t) => t + 1))
          .catch(() => {/* silent */});
      }
    }, [isGuest, user]),
  );

  // Ensure socket is connected
  useEffect(() => {
    if (!isConnected) {
      connect();
    }
  }, [isConnected, connect]);

  // Listen to socket events for new messages (works globally, not just in ChatScreen)
  useEffect(() => {
    // console.log('BuyListScreen: Setting up message received listener');
    
    const handleMessageReceived = (data: { 
      message: any; 
      inquiryId: string; 
      unreadCount?: number; 
      totalUnreadCount?: number;
    }) => {
      // console.log('🔔 BuyListScreen: NEW MESSAGE RECEIVED!', {
      //   inquiryId: data.inquiryId,
      //   messageText: data.message?.message || data.message?.text || 'N/A',
      //   unreadCount: data.unreadCount,
      //   totalUnreadCount: data.totalUnreadCount,
      //   fullData: data,
      // });
      
      // Update unread count for this inquiry
      if (data.inquiryId) {
        // If unreadCount is provided, use it; otherwise increment existing count
        setUnreadCounts(prev => {
          const currentCount = prev[data.inquiryId] || 0;
          const newCount = data.unreadCount !== undefined 
            ? data.unreadCount 
            : currentCount + 1;
          
          // console.log(`📊 BuyListScreen: Updating unread count for inquiry ${data.inquiryId}:`, {
          //   previousCount: currentCount,
          //   newCount: newCount,
          //   providedUnreadCount: data.unreadCount,
          // });
          
          const updatedCounts = {
            ...prev,
            [data.inquiryId]: newCount,
          };
          
          // Save to AsyncStorage
          AsyncStorage.setItem(STORAGE_KEYS.INQUIRY_UNREAD_COUNTS, JSON.stringify(updatedCounts))
            .then(() => {
              // console.log('💾 BuyListScreen: Saved unread counts to AsyncStorage');
            })
            .catch((error) => {
              // console.error('Failed to save unread counts:', error);
            });
          
          return updatedCounts;
        });
        
        // Update orders with new unread count
        setOrders(prevOrders => {
          const updatedOrders = prevOrders.map(order => {
            if (order.inquiryId === data.inquiryId) {
              const currentCount = order.unreadCount || 0;
              const newCount = data.unreadCount !== undefined 
                ? data.unreadCount 
                : currentCount + 1;
              // console.log(`✅ BuyListScreen: Updated order ${order.orderNumber} unread count:`, {
              //   previousCount: currentCount,
              //   newCount: newCount,
              // });
              return { ...order, unreadCount: newCount };
            }
            return order;
          });
          return updatedOrders;
        });
      } else {
        // console.warn('⚠️ BuyListScreen: Message received but no inquiryId provided', data);
      }
    };

    onMessageReceived(handleMessageReceived);
    // console.log('✅ BuyListScreen: Message received listener registered');
    
    // Cleanup - note: onMessageReceived doesn't have cleanup, but the callback ref will be replaced
    return () => {
      // console.log('BuyListScreen: Cleaning up message received listener');
    };
  }, [onMessageReceived]);

  // Render More to Love item (same as HomeScreen)
  const renderMoreToLoveItem = React.useCallback(({ item: product, index }: { item: Product; index: number }) => {
    if (!product || !product.id) {
      return null;
    }
    
    const handleLike = async () => {
      if (!user || isGuest) {
        Alert.alert('', t('home.pleaseLogin'));
        return;
      }
      try {
        await toggleWishlist(product);
      } catch (error) {
        // console.error('Error toggling wishlist:', error);
      }
    };
    
    return (
      <ProductCard
        key={`moretolove-${product.id || index}`}
        product={product}
        variant="moreToLove"
        onPress={() => handleProductPress(product)}
        onLikePress={handleLike}
        isLiked={isProductLiked(product)}
        showLikeButton={true}
        showDiscountBadge={true}
        showRating={true}
      />
    );
  }, [user, isGuest, toggleWishlist, handleProductPress, isProductLiked]);

  // Render More to Love section (same as HomeScreen)
  const renderMoreToLove = () => {
    const productsToDisplay = recommendationsProducts;
    
    if (recommendationsLoading && productsToDisplay.length === 0) {
      return (
        <View style={styles.moreToLoveSection}>
          <Text style={styles.sectionTitle}>{t('home.moreToLove')}</Text>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>Loading...</Text>
          </View>
        </View>
      );
    }
    
    if (recommendationsError && productsToDisplay.length === 0) {
      return (
        <View style={styles.moreToLoveSection}>
          <Text style={styles.sectionTitle}>{t('home.moreToLove')}</Text>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>Failed to load recommendations</Text>
          </View>
        </View>
      );
    }
    
    if (!Array.isArray(productsToDisplay) || productsToDisplay.length === 0) {
      return null;
    }
    
    return (
      <View style={styles.moreToLoveSection}>
        <Text style={styles.sectionTitle}>{t('home.moreToLove')}</Text>
        <FlatList
          data={productsToDisplay}
          renderItem={renderMoreToLoveItem}
          keyExtractor={(item, index) => `moretolove-${item.id?.toString() || index}-${index}`}
          numColumns={2}
          scrollEnabled={false}
          nestedScrollEnabled={true}
          columnWrapperStyle={styles.productRow}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={5}
          initialNumToRender={10}
          updateCellsBatchingPeriod={50}
          onEndReached={() => {
            // For nested FlatList with scrollEnabled={false}, onEndReached may not fire reliably
            // Rely on parent ScrollView scroll detection instead
            // This is kept as a backup but parent scroll detection is primary
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={() => {
            if (isLoadingMoreRecommendationsRef.current && productsToDisplay.length > 0) {
              return (
                <View style={styles.loadingMoreContainer}>
                  <ActivityIndicator size="small" color={COLORS.primary} />
                  <Text style={styles.loadingMoreText}>Loading more...</Text>
                </View>
              );
            }
            if (!hasMoreRecommendations && productsToDisplay.length > 0) {
              return (
                <View style={styles.endOfListContainer}>
                  <Text style={styles.endOfListText}>No more products</Text>
                </View>
              );
            }
            return null;
          }}
        />
      </View>
    );
  };

  // Sample products for "More to love" section
  const recommendedProducts: Partial<Product>[] = [
    {
      id: '1',
      name: 'Summer Floral Dress',
      price: 45.99,
      originalPrice: 65.99,
      discount: 30,
      rating: 4.5,
      rating_count: 128,
      image: 'https://picsum.photos/seed/dress1/400/500',
      orderCount: 456,
    },
    {
      id: '2',
      name: 'Wireless Headphones',
      price: 89.99,
      originalPrice: 129.99,
      discount: 31,
      rating: 4.8,
      rating_count: 256,
      image: 'https://picsum.photos/seed/headphones/400/500',
      orderCount: 789,
    },
    {
      id: '3',
      name: 'Smart Watch',
      price: 199.99,
      originalPrice: 299.99,
      discount: 33,
      rating: 4.7,
      rating_count: 512,
      image: 'https://picsum.photos/seed/watch/400/500',
      orderCount: 1234,
    },
    {
      id: '4',
      name: 'Laptop Stand',
      price: 35.99,
      originalPrice: 49.99,
      discount: 28,
      rating: 4.6,
      rating_count: 89,
      image: 'https://picsum.photos/seed/stand/400/500',
      orderCount: 345,
    },
    {
      id: '5',
      name: 'Phone Case',
      price: 15.99,
      originalPrice: 24.99,
      discount: 36,
      rating: 4.9,
      rating_count: 678,
      image: 'https://picsum.photos/seed/case/400/500',
      orderCount: 2345,
    },
    {
      id: '6',
      name: 'USB Cable Set',
      price: 12.99,
      originalPrice: 19.99,
      discount: 35,
      rating: 4.4,
      rating_count: 234,
      image: 'https://picsum.photos/seed/cable/400/500',
      orderCount: 567,
    },
  ];

  const handleApplyFilters = (newFilters: { orderNumber: string; startDate: Date | null; endDate: Date | null }) => {
    setFilters(newFilters);
    // console.log('Filters applied:', newFilters);
    // Here you would filter the orders based on the filters
  };

  // Group order items by store (similar to CartScreen)
  const groupOrderItemsByStore = (items: OrderItem[]): StoreGroup[] => {
    const grouped: { [key: string]: OrderItem[] } = {};
    items.forEach((item) => {
      const storeLabel = resolveStoreName(item.companyName, item);
      const key = `${item.sellerOpenId}_${storeLabel}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    });
    return Object.keys(grouped).map((key) => {
      const storeItems = grouped[key];
      const companyName = resolveStoreName(storeItems[0]?.companyName, storeItems[0]);
      const sellerOpenId = storeItems[0]?.sellerOpenId ?? '';
      const storeTotal = storeItems.reduce((sum, item) => sum + item.subtotal, 0);
      return { companyName, sellerOpenId, items: storeItems, storeTotal };
    });
  };

  const copyOrderNumber = (orderNumber: string) => {
    Clipboard.setString(orderNumber);
    showToast(t('common.copied') || 'Copied', 'success');
  };

  const openOrderDetail = (order: Order) => {
    embedNavigate('OrderDetail', { orderId: order.id, order });
  };

  // "결제중"(무통장 결제 신청) 취소 — POST /orders/:id/cancel-pending-payment
  // body: { parentOrderNumber }. 성공 시 로컬 결제중 마크를 지우고 목록 갱신.
  const [cancelingPaymentId, setCancelingPaymentId] = useState<string | null>(null);
  const handleCancelPendingPayment = async (order: Order) => {
    const orderId = order.id || (order as any).orderId || '';
    const parentOrderNumber = String(
      (order as any).parentOrderNumber || order.orderNumber || '',
    );
    if (!orderId || !parentOrderNumber || cancelingPaymentId) return;
    setCancelingPaymentId(orderId);
    try {
      const res = await orderApi.cancelPendingPayment(orderId, parentOrderNumber);
      if (res.success) {
        await clearBankPaymentPending(orderId);
        setPendingBankPaymentsTick((t) => t + 1);
        showToast(res.message || 'Payment attempt cancelled', 'success');
        fetchOrdersRef.current();
      } else {
        showToast(res.error || t('profile.unitSurvey.paymentConfirmFailed') || 'Failed to cancel', 'error');
      }
    } catch {
      showToast(t('profile.unitSurvey.paymentConfirmFailed') || 'Failed to cancel', 'error');
    } finally {
      setCancelingPaymentId(null);
    }
  };

  const renderOrderProductRow = (
    _order: Order,
    item: OrderItem,
    uniqueKey: string,
  ) => {
    const specLines = formatSkuAttributeLines(item.skuAttributes);
    const addServiceCount = item.addServices?.length ?? 0;
    const lineSubtotal = item.subtotal || item.price * item.quantity;
    // productTotalKRW / shippingKRW 는 이전 "결제 금액" 영역에서 사용했으나
    // 그 블록이 제거되어 더 이상 필요 없음.

    return (
      <View key={uniqueKey} style={styles.productItem}>
        <View style={styles.productMainCol}>
          <Image source={{ uri: item.image }} style={styles.productImage} resizeMode="cover" />
          <View style={styles.productInfo}>
            {/* 상품명 클릭 → 해당 상품 상세 페이지로 이동 */}
            <TouchableOpacity
              activeOpacity={0.6}
              disabled={!String(item.offerId ?? '').trim()}
              onPress={() =>
                void navigateToProductDetail(
                  String(item.offerId ?? '').trim(),
                  item.source || selectedPlatform,
                  locale,
                )
              }
            >
              <Text style={styles.productTitle} numberOfLines={2}>{item.productName}</Text>
            </TouchableOpacity>
            {specLines.map((line, index) => (
              <Text key={`${uniqueKey}-spec-${index}`} style={styles.productSpecs} numberOfLines={1}>
                {line}
              </Text>
            ))}
            <View style={styles.addServicesRow}>
              <Text style={styles.addServicesLabel}>
                {t('cartOrder.extraServiceBar.title')}:
              </Text>
              {addServiceCount > 0 ? (
                <View style={styles.addServicesIcons}>
                  {item.addServices!.slice(0, 6).map((service, index) => {
                    const iconUri = resolveOrderAddServiceIconUri(
                      service,
                      additionalServiceIconById,
                    );
                    return (
                      <View key={`${uniqueKey}-svc-${index}`} style={styles.addServiceIcon}>
                        {iconUri ? (
                          <Image
                            source={{ uri: iconUri }}
                            style={styles.addServiceIconImage}
                            resizeMode="contain"
                          />
                        ) : (
                          <Icon name="cube-outline" size={12} color={COLORS.red} />
                        )}
                      </View>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.addServicesNone}>{t('buyList.additionalServicesNone')}</Text>
              )}
            </View>
          </View>
        </View>

        <View style={styles.productUnitPriceCol}>
          <Text style={styles.unitPriceText}>
            {formatPriceCNY(item.price)} x {item.quantity}
          </Text>
          <Text style={styles.lineSubtotalText}>{formatPriceCNY(lineSubtotal)}</Text>
        </View>
      </View>
    );
  };

  const toggleOrderItemsExpanded = (orderId: string) => {
    setExpandedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const getCollapsedStoreGroups = (storeGroups: StoreGroup[]): StoreGroup[] => {
    if (!storeGroups.length) return [];
    const firstGroup = storeGroups[0];
    if (!firstGroup.items.length) return [];
    return [{ ...firstGroup, items: [firstGroup.items[0]] }];
  };

  // Render order with store grouping
  const renderOrderWithStoreGrouping = (order: Order, showStatusInfo: boolean = false) => {
    const storeGroups = groupOrderItemsByStore(order.items);
    const statusLabel = t(order.statusTranslationKey) || order.progressStatus;
    const domainBadge = getBusinessDomainBadgeLabel(resolveOrderBusinessDomain(order), t);
    const canonicalStatus = getCanonicalOrderProgressStatus(order);
    const logisticsSummary = buildOrderLogisticsSummary(order, t);
    const itemKindCount = order.items.length;
    const hasMultipleItems = itemKindCount > 1;
    const isExpanded = expandedOrderIds.has(order.id);
    const visibleStoreGroups =
      hasMultipleItems && !isExpanded ? getCollapsedStoreGroups(storeGroups) : storeGroups;

    return (
      <View key={`order-${order.id}`} style={styles.orderContainer}>
        {/* 우측 상단 메타 배지 — 도메인 한 글자 + 주문번호 + 복사 단추.
            position: 'absolute' 로 카드의 오른쪽 위 모서리에 띄움. */}
        <View style={styles.orderHeaderMetaCorner}>
          <View style={styles.domainBadge}>
            <Text style={styles.domainBadgeText}>{domainBadge}</Text>
          </View>
          <Text style={styles.orderHeaderNumber}>{order.orderNumber}</Text>
          <TouchableOpacity onPress={() => copyOrderNumber(order.orderNumber)}>
            <Text style={styles.orderCopyText}>{t('buyList.copy')}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.orderHeaderRow}>
          <View style={styles.orderHeaderMain}>
            <TouchableOpacity
              style={[styles.orderCheckbox, selectedOrderIds.has(order.id) && styles.orderCheckboxChecked]}
              onPress={() => {
                setSelectedOrderIds(prev => {
                  const next = new Set(prev);
                  next.has(order.id) ? next.delete(order.id) : next.add(order.id);
                  return next;
                });
              }}
            >
              {selectedOrderIds.has(order.id) && (
                <Icon name="checkmark" size={12} color={COLORS.white} />
              )}
            </TouchableOpacity>
            <Text style={styles.orderStatusText}>{statusLabel}</Text>
          </View>
          <View style={styles.orderHeaderActions}>
            <TouchableOpacity style={styles.orderDetailLink} onPress={() => openOrderDetail(order)}>
              <Icon name="help-circle-outline" size={16} color={COLORS.text.secondary} />
              <Text style={styles.orderDetailLinkText}>{t('profile.unitSurvey.orderDetails')}</Text>
            </TouchableOpacity>
            {/* "주문 세부정보" 우측에 주문 날짜를 가벼운 보조 정보로 함께 표시. */}
            <Text style={styles.orderHeaderDate} numberOfLines={1}>
              {t('profile.unitSurvey.orderDate')} {formatBuyListOrderDate(order.createdAt)}
            </Text>
            <TouchableOpacity
              style={styles.orderInquiryButton}
              onPress={() => handleOrderInquiry(order)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={t('chat.orderInquiry')}
            >
              {/* 주문문의 — 홈 헤더 우측과 동일한 레시바 아이콘(HeadsetMicIcon).
                  텍스트 대신 아이콘만, 기능(채팅 열기)은 동일. */}
              <HeadsetMicIcon width={22} height={22} color={COLORS.red} />
              {order.unreadCount != null && order.unreadCount > 0 && (
                <View style={styles.inquiryUnreadBadge}>
                  <Text style={styles.inquiryUnreadBadgeText}>{order.unreadCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {visibleStoreGroups.map((storeGroup, storeIndex) => (
          <View key={`order-${order.id}-store-${storeIndex}`}>
            <TouchableOpacity
              style={styles.storeHeader}
              activeOpacity={0.7}
              onPress={() => {
                // 회사이름 클릭 → 해당 셀러의 상품 목록(SellerProfile)으로 이동.
                // (주문상세 이동 아님) 1688 셀러상품 API 는 sellerOpenId 로 조회.
                const headerItem = storeGroup.items[0];
                const sellerId =
                  storeGroup.sellerOpenId || headerItem?.sellerOpenId || '';
                if (!sellerId) return;
                const sellerSource =
                  headerItem?.source ||
                  (String(headerItem?.otherSite ?? '').includes('taobao') ? 'taobao' : '1688');
                embedNavigate('SellerProfile', {
                  sellerId,
                  sellerName: resolveStoreName(storeGroup.companyName, headerItem),
                  source: sellerSource,
                  country: locale,
                });
              }}
            >
              <Text style={styles.storeName} numberOfLines={1}>
                {resolveStoreName(storeGroup.companyName, storeGroup.items[0])} {'>'}
              </Text>
            </TouchableOpacity>
            {storeGroup.items.map((item, itemIndex) =>
              renderOrderProductRow(
                order,
                item,
                `order-${order.id}-store-${storeIndex}-item-${itemIndex}`,
              ),
            )}
          </View>
        ))}

        <View style={styles.orderSummaryFooter}>
          <View style={styles.orderSummaryLeftWrap}>
            <Text style={styles.orderSummaryLeft}>
              {hasMultipleItems && !isExpanded ? (
                <>
                  {(t('buyList.totalProductKindsWithMore') ||
                    '총합 {count} 가지 제품, 그리고 {more} 상품 더 있어요')
                    .replace('{count}', String(itemKindCount))
                    .replace('{more}', String(itemKindCount - 1))}
                  {' '}
                  <Text
                    style={styles.seeMoreLink}
                    onPress={() => toggleOrderItemsExpanded(order.id)}
                  >
                    {t('buyList.seeMore') || '더보기'}
                  </Text>
                </>
              ) : (
                <>
                  {(t('buyList.totalProductKinds') || '총합 {count} 가지 제품').replace(
                    '{count}',
                    String(itemKindCount),
                  )}
                  {hasMultipleItems && isExpanded ? (
                    <>
                      {' '}
                      <Text
                        style={styles.seeMoreLink}
                        onPress={() => toggleOrderItemsExpanded(order.id)}
                      >
                        {t('buyList.seeLess') || '접기'}
                      </Text>
                    </>
                  ) : null}
                </>
              )}
            </Text>
          </View>
          <Text style={styles.orderSummaryCenter}>
            {(t('buyList.orderSum') || '주문 합계')} {formatPriceCNY(order.totalAmount)}
          </Text>
          {!!logisticsSummary && (
            <Text style={styles.orderSummaryRight} numberOfLines={2}>
              {logisticsSummary}
            </Text>
          )}
        </View>

        {(canonicalStatus === 'P_PENDING' ||
          canonicalStatus === 'IO_PAY_PENDING') && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.orderActionButtons}
            contentContainerStyle={styles.orderActionButtonsContent}
          >
            {(canonicalStatus === 'P_PENDING' || canonicalStatus === 'IO_PAY_PENDING') &&
              (() => {
                // pendingBankPaymentsTick 를 참조해 useFocusEffect 의 prewarm
                // 직후 강제 리렌더가 정상 트리거되도록 한다 (의존성 캡처).
                void pendingBankPaymentsTick;
                const orderIdForPaying = order.id || (order as any).orderId || '';
                const showPaying = isBankPaymentPendingSync(orderIdForPaying);
                return showPaying ? (
                  <View style={styles.payingRow}>
                    <View style={styles.payingBadge}>
                      <Text style={styles.payingBadgeText}>
                        {t('buyList.paying') || '결제중'}
                      </Text>
                    </View>
                    {/* 결제중 옆 취소 버튼 → cancel-pending-payment */}
                    <TouchableOpacity
                      style={styles.cancelPendingButton}
                      activeOpacity={0.7}
                      disabled={cancelingPaymentId === orderIdForPaying}
                      onPress={() => void handleCancelPendingPayment(order)}
                    >
                      {cancelingPaymentId === orderIdForPaying ? (
                        <ActivityIndicator size="small" color={COLORS.red} />
                      ) : (
                        <Text style={styles.cancelPendingButtonText}>
                          {t('common.cancel') || '취소'}
                        </Text>
                      )}
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => embedNavigate('OrderPayment', { orderId: order.id })}
                  >
                    <Text style={styles.primaryButtonText}>{t('cart.pay') || 'Pay Now'}</Text>
                  </TouchableOpacity>
                );
              })()}
          </ScrollView>
        )}
      </View>
    );
  };

  // Check if a tab has orders with unread messages
  const filteredOrders = useMemo(
    () => {
      let result = orders;
      if (filters.orderNumber.trim()) {
        const q = filters.orderNumber.trim().toLowerCase();
        result = result.filter(order =>
          order.orderNumber?.toLowerCase().includes(q),
        );
      }
      // 기간 필터 — 백엔드가 periodFrom/To 를 무시하거나 datePeriod 와 충돌
      // 처리하는 경우에도 화면엔 사용자가 선택한 범위만 보이도록 client-side
      // 에서 한 번 더 필터링한다. 시간 단위 비교를 위해 시작일은 00:00,
      // 끝일은 23:59:59.999 로 확장 → 그 날 안에 생성된 주문은 모두 포함.
      if (selectedStartDate || selectedEndDate) {
        const startMs = selectedStartDate
          ? new Date(
              selectedStartDate.getFullYear(),
              selectedStartDate.getMonth(),
              selectedStartDate.getDate(),
              0, 0, 0, 0,
            ).getTime()
          : -Infinity;
        const endMs = selectedEndDate
          ? new Date(
              selectedEndDate.getFullYear(),
              selectedEndDate.getMonth(),
              selectedEndDate.getDate(),
              23, 59, 59, 999,
            ).getTime()
          : Infinity;
        result = result.filter((order) => {
          const raw = (order as any).createdAt;
          if (!raw) return false;
          const t = new Date(raw).getTime();
          if (!Number.isFinite(t)) return false;
          return t >= startMs && t <= endMs;
        });
      }
      if (filterPlatform) {
        result = result.filter(order =>
          order.items?.some(item => {
            const site = String((item as any).otherSite ?? item.source ?? '').toLowerCase();
            if (filterPlatform === 'taobao') return site.includes('taobao');
            if (filterPlatform === '1688') return site.includes('1688');
            return true;
          }),
        );
      }
      // 1) 사업 도메인 필터 — 발주관리 드롭다운의 활성 항목으로 1차 필터링.
      //    구매대행/로켓-3PL/VVIC하이패스/배송대행 각 도메인은
      //    resolveOrderBusinessDomain 으로 분류되며 우선권 규칙(VVIC > Rocket > Shipping > Purchase)
      //    을 따른다. 오류/반품관리는 도메인 필터 대신 status 그룹 필터를 따른다.
      if (
        activeTab !== 'error' &&
        (activeBusinessDomain === 'purchase_agency' ||
          activeBusinessDomain === 'rocket_3pl' ||
          activeBusinessDomain === 'vvic_hipass' ||
          activeBusinessDomain === 'shipping_agency')
      ) {
        result = result.filter(
          (order) => resolveOrderBusinessDomain(order) === activeBusinessDomain,
        );
      }

      if (activeTab === 'error') {
        switch (errorSubFilter) {
          case 'refund_management':
            result = result.filter((order) =>
              orderMatchesProgressStatus(order, 'USER_REFUND_REQ'),
            );
            break;
          case 'shipment_hold':
            result = result.filter((order) =>
              orderMatchesProgressStatus(order, 'E_SHIPMENT_HOLD'),
            );
            break;
          case 'problem_product':
            result = result.filter((order) =>
              orderMatchesProgressStatus(order, 'P_MA_PROBLEM'),
            );
            break;
          case 'shipping_delay':
            result = result.filter((order) =>
              orderMatchesProgressStatus(order, 'IO_DELAY'),
            );
            break;
          case 'error_management':
          default:
            result = result.filter((order) =>
              orderMatchesProgressStatus(order, 'E_ERROR'),
            );
            break;
        }
      }

      // 2) activeTab 별 추가 필터. 두 종류가 섞여 들어온다:
      //    - 상태 그룹 키 ('purchase_agency' / 'warehouse' / 'international_shipping' / 'error')
      //    - Order.status 값 ('category' / 'unpaid' / 'progressing' / 'end' / ...)
      //   'purchase_agency' 같은 그룹 키가 들어와도 이미 도메인 필터를 적용했으므로
      //   추가 좁힘 없이 그대로 통과시킨다(이중 필터 방지).
      if (activeTab !== 'all' && activeTab !== 'error') {
        const isKnownGroup = STATUS_GROUPS.some((g) => g.key === activeTab);
        const isKnownStatus = ['category','unpaid','progressing','end','pending_review','error','refunds']
          .includes(activeTab);
        if (isKnownGroup) {
          // 도메인 필터가 이미 처리했으므로 그룹 키는 통과.
          // (단, warehouse·international_shipping 같은 현지 그룹은 그대로 필터.)
          if (activeTab !== 'purchase_agency') {
            result = result.filter(order => orderBelongsToStatusGroup(order, activeTab));
          }
        } else if (isKnownStatus) {
          // ProfileScreen 구매대행 셀 — 견적대기/고객결제는 진행상태 코드로 좁힌다.
          if (activeTab === 'category') {
            result = result.filter(
              (order) => getCanonicalOrderProgressStatus(order) === 'P_QUOTE',
            );
          } else if (activeTab === 'unpaid') {
            result = result.filter(
              (order) => getCanonicalOrderProgressStatus(order) === 'P_PENDING',
            );
          } else {
            result = result.filter((order) => order.status === activeTab);
          }
        }
      }
      // Further filter by selected progress status (canonical codes)
      if (selectedProgressStatus) {
        result = result.filter(order =>
          orderMatchesProgressStatus(order, selectedProgressStatus),
        );
      }
      // "내 주문 → 미확인" — 라벨 미확인(unreadCount > 0) 주문만.
      if (unconfirmedFilter) {
        result = result.filter((order) => ((order as any).unreadCount ?? 0) > 0);
      }
      return result;
    },
    [
      activeTab,
      orders,
      selectedProgressStatus,
      unconfirmedFilter,
      filters.orderNumber,
      filterPlatform,
      activeBusinessDomain,
      errorSubFilter,
      // 기간 필터 — 사용자가 chip 에서 날짜를 바꾸면 즉시 client-side 재필터링.
      selectedStartDate,
      selectedEndDate,
    ],
  );

  const getToolbarSelectedOrders = () =>
    filteredOrders.filter((order) => selectedOrderIds.has(order.id));

  const handleToolbarRepurchase = async () => {
    const selectedOrders = getToolbarSelectedOrders();
    if (selectedOrders.length === 0) {
      showToast(t('buyList.selectOrdersFirst'), 'warning');
      return;
    }
    if (isRepurchasing) return;

    setIsRepurchasing(true);
    let successCount = 0;
    let failCount = 0;
    try {
      for (const order of selectedOrders) {
        const result = await repurchaseOrderItems(order);
        successCount += result.successCount;
        failCount += result.failCount;
      }
      showRepurchaseResultToast(successCount, failCount);
    } finally {
      setIsRepurchasing(false);
    }
  };

  const handleToolbarAddToCart = () => {
    const selectedOrders = getToolbarSelectedOrders();
    if (selectedOrders.length === 0) {
      showToast(t('buyList.selectOrdersFirst'), 'warning');
      return;
    }
    const selectionItems = collectSelectionItemsFromOrders(selectedOrders);
    if (selectionItems.length === 0) {
      showToast(t('buyList.failedToAddCart'), 'error');
      return;
    }
    setProductSelectionItems(selectionItems);
  };

  const groupedOrdersForCategory = useMemo(() => {
    return STATUS_GROUPS.map((group) => {
      const statusSections = group.statuses
        .map((progressStatus) => {
          const meta = PROGRESS_STATUS_META[progressStatus];
          const sectionOrders = filteredOrders.filter(order =>
            orderMatchesProgressStatus(order, progressStatus),
          );
          return {
            progressStatus,
            title: meta ? meta.translationKey : progressStatus,
            orders: sectionOrders,
          };
        })
        .filter(section => section.orders.length > 0);

      return {
        key: group.key,
        title: group.title,
        statusSections,
      };
    }).filter(group => {
      if (selectedStatusGroup && group.key !== selectedStatusGroup) {
        return false;
      }
      return group.statusSections.length > 0;
    });
  }, [filteredOrders, selectedStatusGroup]);

  const hasUnreadInTab = (tab: Order['status']): boolean => {
    return orders.some(order => 
      order.status === tab && (order.unreadCount || 0) > 0
    );
  };

  const getGroupOrderCount = (groupKey: string): number => statusGroupCounts[groupKey] ?? 0;

  const getProgressStatusCount = (progressStatus: string): number =>
    progressStatusCounts[progressStatus] ?? 0;

  /** 오류 드롭다운 4개 항목(오류입고·반품관리·출고보류·문제상품) 합계. */
  const getErrorDropdownTotalCount = (): number =>
    getProgressStatusCount('E_ERROR') +
    getProgressStatusCount('E_CUSTOMER_RETURN_REQ') +
    getProgressStatusCount('E_SHIPMENT_HOLD') +
    getProgressStatusCount('P_MA_PROBLEM');

  /** 오류 칩 배지 — 활성 시 선택 하위 필터, 비활성 시 드롭다운 4항목 합계. */
  const getErrorChipCount = (): number => {
    if (activeTab !== 'error') {
      return getErrorDropdownTotalCount();
    }
    switch (errorSubFilter) {
      case 'refund_management':
        return getProgressStatusCount('E_CUSTOMER_RETURN_REQ');
      case 'shipment_hold':
        return getProgressStatusCount('E_SHIPMENT_HOLD');
      case 'problem_product':
        return getProgressStatusCount('P_MA_PROBLEM');
      case 'error_management':
      default:
        return getProgressStatusCount('E_ERROR');
    }
  };

  const renderCategoryStatusFilters = () => {
    const groups = STATUS_GROUPS.filter(
      (g) => g.key === 'purchase_agency' || g.key === 'warehouse' || g.key === 'error',
    );
    const currentGroup = groups.find((g) => g.key === activeTab);
    const errorGroup = groups.find((g) => g.key === 'error');

    // 발주관리 드롭다운 — 스크린샷의 7개 항목. 각 항목의 onPress 는
    // 해당 도메인 화면으로 분기하거나 현재 BuyList 의 필터 상태를 바꾼다.
    type PurchaseDropdownItem = {
      key: string;
      labelKey: string;
      fallbackLabel: string;
      onSelect: () => void;
      isSelected: () => boolean;
    };
    // 항목 선택 시 페지를 이동하지 않고 같은 BuyListScreen 안에서
    // activeBusinessDomain 만 갱신한다. 본문 영역은 도메인별로 다른
    // 대시보드(주문 카드 리스트 또는 placeholder)를 렌더한다.
    // purchase_agency 도메인의 세부 필터 키들 — 구매대행 셀에서 진입할 때
    // initialTab 으로 전달될 수 있는 모든 값(견적대기='category', 결제대기='unpaid', ...).
    // '전체' 항목이 아니면 모두 구매대행 항목이 selected 로 표시되어야 한다.
    const purchaseAgencyTabs = [
      'purchase_agency',
      'category',
      'unpaid',
      'to_be_shipped',
      'shipped',
      'processed',
      'shipping_delay',
      'end',
    ];

    const purchaseDropdownItems: PurchaseDropdownItem[] = [
      {
        key: 'all',
        labelKey: 'profile.viewAll',
        fallbackLabel: '전체',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('all');
          setSelectedProgressStatus(null);
          setExpandedStatusGroup(null);
        },
        isSelected: () =>
          activeBusinessDomain === 'purchase_agency' && activeTab === 'all',
      },
      {
        key: 'purchase_agency',
        labelKey: 'profile.tabPurchaseAgency',
        fallbackLabel: '구매대행',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('purchase_agency');
          setSelectedProgressStatus(null);
          setExpandedStatusGroup(null);
        },
        // ProfileScreen 카드의 구매대행 셀(견적대기/결제대기/.../완료)에서 들어오면
        // activeTab 이 'category'·'unpaid' 같은 세부 필터로 설정되는데, 그때도
        // 사용자 인식상 도메인은 '구매대행' 이므로 이 항목을 selected 로 표시한다.
        isSelected: () =>
          activeBusinessDomain === 'purchase_agency' &&
          purchaseAgencyTabs.includes(activeTab),
      },
      {
        key: 'rocket_3pl',
        labelKey: 'profile.tabRocket3pl',
        fallbackLabel: '로켓/3PL',
        onSelect: () => {
          setActiveBusinessDomain('rocket_3pl');
          setActiveTab('all');
          setSelectedProgressStatus(null);
          setExpandedStatusGroup(null);
        },
        isSelected: () => activeBusinessDomain === 'rocket_3pl',
      },
      {
        key: 'vvic_hipass',
        labelKey: 'profile.tabVvicHipass',
        fallbackLabel: 'WIC하이패스',
        onSelect: () => {
          setActiveBusinessDomain('vvic_hipass');
          setActiveTab('all');
          setSelectedProgressStatus(null);
          setExpandedStatusGroup(null);
        },
        isSelected: () => activeBusinessDomain === 'vvic_hipass',
      },
      {
        key: 'shipping_agency',
        labelKey: 'profile.tabShippingAgency',
        fallbackLabel: '배송대행',
        onSelect: () => {
          setActiveBusinessDomain('shipping_agency');
          setActiveTab('all');
          setSelectedProgressStatus(null);
          setExpandedStatusGroup(null);
        },
        isSelected: () => activeBusinessDomain === 'shipping_agency',
      },
    ];

    type ErrorDropdownItem = {
      key: ErrorSubFilter;
      labelKey: string;
      fallbackLabel: string;
      onSelect: () => void;
    };
    const errorDropdownItems: ErrorDropdownItem[] = [
      {
        key: 'error_management',
        labelKey: 'profile.toErrorIn',
        fallbackLabel: '오류입고',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('error');
          setErrorSubFilter('error_management');
          setSelectedProgressStatus('E_ERROR');
          setExpandedStatusGroup(null);
        },
      },
      {
        key: 'refund_management',
        labelKey: 'profile.refundManagement',
        fallbackLabel: '반품관리',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('error');
          setErrorSubFilter('refund_management');
          setSelectedProgressStatus('USER_REFUND_REQ');
          setExpandedStatusGroup(null);
        },
      },
      {
        key: 'shipment_hold',
        labelKey: 'profile.toShipmentHold',
        fallbackLabel: '출고보류',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('error');
          setErrorSubFilter('shipment_hold');
          setSelectedProgressStatus('E_SHIPMENT_HOLD');
          setExpandedStatusGroup(null);
        },
      },
      {
        key: 'problem_product',
        labelKey: 'profile.toProblem',
        fallbackLabel: '문제상품',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('error');
          setErrorSubFilter('problem_product');
          setSelectedProgressStatus('P_MA_PROBLEM');
          setExpandedStatusGroup(null);
        },
      },
      {
        key: 'shipping_delay',
        labelKey: 'profile.toShippingDelay',
        fallbackLabel: '현지배송지연',
        onSelect: () => {
          setActiveBusinessDomain('purchase_agency');
          setActiveTab('error');
          setErrorSubFilter('shipping_delay');
          setSelectedProgressStatus('IO_DELAY');
          setExpandedStatusGroup(null);
        },
      },
    ];

    const purchaseBusinessDomains: BusinessDomain[] = [
      'rocket_3pl',
      'vvic_hipass',
      'shipping_agency',
    ];

    const isPurchaseDropdownOpen = expandedStatusGroup === 'purchase_agency';
    const isErrorDropdownOpen = expandedStatusGroup === 'error';

    return (
      <>
        {/* Row 1: Status group tabs (발주관리, 현지입/출고, 오류) */}
        <View style={styles.filterRow1}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow1Content}>
            <TouchableOpacity
              style={[styles.filterChip, activeBusinessDomain === 'all' && styles.filterChipActive]}
              onPress={() => {
                // 전체 = 도메인 필터 없음 + 상태 필터 없음 → 전체주문건 표시.
                setActiveBusinessDomain('all');
                setActiveTab('all');
                setSelectedProgressStatus(null);
                setExpandedStatusGroup(null);
              }}
            >
              <Text style={[styles.filterChipText, activeBusinessDomain === 'all' && styles.filterChipTextActive]}>
                {t('profile.viewAll') || 'All'}
              </Text>
            </TouchableOpacity>
            {groups.map((group) => {
              const isOpen = expandedStatusGroup === group.key;
              const isPurchase = group.key === 'purchase_agency';
              const isWarehouse = group.key === 'warehouse';
              const isError = group.key === 'error';
              let chipLabel = t(group.titleKey) || group.title;
              if (isPurchase) {
                const labelKey =
                  activeBusinessDomain === 'rocket_3pl'
                    ? 'profile.tabRocket3pl'
                    : activeBusinessDomain === 'vvic_hipass'
                      ? 'profile.tabVvicHipass'
                      : activeBusinessDomain === 'shipping_agency'
                        ? 'profile.tabShippingAgency'
                        : null;
                if (labelKey) {
                  chipLabel = t(labelKey) || chipLabel;
                }
              } else if (isError && errorSubFilter) {
                const errorLabelKey =
                  errorSubFilter === 'error_management'
                    ? 'profile.toErrorIn'
                    : errorSubFilter === 'refund_management'
                      ? 'profile.refundManagement'
                      : errorSubFilter === 'shipment_hold'
                        ? 'profile.toShipmentHold'
                        : 'profile.toProblem';
                chipLabel = t(errorLabelKey) || chipLabel;
              }
              const isChipActive = isPurchase
                ? activeTab !== 'error' &&
                  (purchaseBusinessDomains.includes(activeBusinessDomain) ||
                    (activeBusinessDomain === 'purchase_agency' &&
                      purchaseAgencyTabs.includes(activeTab)))
                : activeTab === group.key;
              return (
                <TouchableOpacity
                  key={group.key}
                  // 발주관리·현지입/출고 칩에 측정 ref 를 단다. measureInWindow
                  // 로 화면 절대 좌표를 얻어 드롭다운 위치를 칩 바로 아래로 고정.
                  ref={
                    isPurchase
                      ? (purchaseChipRef as any)
                      : isWarehouse
                        ? (warehouseChipRef as any)
                        : isError
                          ? (errorChipRef as any)
                          : undefined
                  }
                  style={[styles.filterChip, isChipActive && styles.filterChipActive]}
                  onPress={() => {
                    if (isPurchase) {
                      purchaseChipRef.current?.measureInWindow((x, y, width, height) => {
                        setPurchaseChipLayout({ x, y, width, height });
                      });
                      setExpandedStatusGroup(prev => prev === group.key ? null : group.key);
                      return;
                    }
                    if (isWarehouse) {
                      warehouseChipRef.current?.measureInWindow((x, y, width, height) => {
                        setWarehouseChipLayout({ x, y, width, height });
                      });
                    }
                    if (isError) {
                      errorChipRef.current?.measureInWindow((x, y, width, height) => {
                        setErrorChipLayout({ x, y, width, height });
                      });
                    }
                    if (activeTab === group.key) {
                      setExpandedStatusGroup(prev => prev === group.key ? null : group.key);
                    } else {
                      setActiveTab(group.key);
                      setExpandedStatusGroup(group.key);
                      if (isError && !errorSubFilter) {
                        setErrorSubFilter('error_management');
                        setSelectedProgressStatus('E_ERROR');
                      }
                    }
                  }}
                >
                  <Text style={[styles.filterChipText, isChipActive && styles.filterChipTextActive]}>
                    {chipLabel}
                    {' '}
                    <Text style={[styles.filterChipCountBadge, isChipActive && styles.filterChipCountBadgeActive]}>
                      ({isPurchase
                        ? (activeBusinessDomain === 'rocket_3pl'
                            ? businessDomainCounts.rocket_3pl
                            : activeBusinessDomain === 'vvic_hipass'
                              ? businessDomainCounts.vvic_hipass
                              : activeBusinessDomain === 'shipping_agency'
                                ? businessDomainCounts.shipping_agency
                                : businessDomainCounts.purchase_agency)
                        : isError
                          ? getErrorChipCount()
                          : getGroupOrderCount(group.key)})
                    </Text>
                  </Text>
                  <Icon
                    name={isOpen ? 'chevron-up' : 'chevron-down'}
                    size={14}
                    color={isChipActive ? COLORS.red : COLORS.text.primary}
                  />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* 발주관리 드롭다운 — 도메인 선택 목록.
            앵커 좌표는 발주관리 칩의 measureInWindow 결과로부터 계산.
            top  = chip.y + chip.height + 4 (칩 아래 약간 띄움)
            left = chip.x (칩의 좌측에 맞춰 정렬).
            팝오버 느낌을 위해 backdrop 은 투명 — 바깥쪽 탭으로만 닫힘. */}
        <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
          visible={isPurchaseDropdownOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setExpandedStatusGroup(null)}
        >
          <TouchableOpacity
            style={styles.purchaseDropdownBackdrop}
            activeOpacity={1}
            onPress={() => setExpandedStatusGroup(null)}
          >
            <View
              style={[
                styles.purchaseDropdownAnchor,
                purchaseChipLayout && {
                  top: purchaseChipLayout.y + purchaseChipLayout.height + 4,
                  left: purchaseChipLayout.x,
                },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.purchaseDropdownCard}>
                <Text style={styles.purchaseDropdownTitle}>
                  {t('pages.orders.groups.purchaseAgency') || '발주관리'}
                </Text>
                {purchaseDropdownItems.map((item) => {
                  const selected = item.isSelected();
                  return (
                    <TouchableOpacity
                      key={item.key}
                      style={styles.purchaseDropdownItem}
                      activeOpacity={0.7}
                      onPress={item.onSelect}
                    >
                      {/* 좌측 붉은색 활성 표식 */}
                      <View
                        style={[
                          styles.purchaseDropdownBullet,
                          selected && styles.purchaseDropdownBulletActive,
                        ]}
                      />
                      <Text
                        style={[
                          styles.purchaseDropdownText,
                          selected && styles.purchaseDropdownTextActive,
                        ]}
                      >
                        {t(item.labelKey) || item.fallbackLabel}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* 현지입/출고 드롭다운 — 기존 상태 목록.
            발주관리와 같은 앵커링 패턴: 칩 바로 아래에 떠 있고 너비는 칩 너비와 일치.
            top·left·width 모두 칩의 measureInWindow 결과로 인라인 오버라이드. */}
        <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
          visible={!!(currentGroup && expandedStatusGroup === activeTab && activeTab === 'warehouse')}
          transparent
          animationType="fade"
          onRequestClose={() => setExpandedStatusGroup(null)}
        >
          <TouchableOpacity
            style={styles.purchaseDropdownBackdrop}
            activeOpacity={1}
            onPress={() => setExpandedStatusGroup(null)}
          >
            <View
              style={[
                styles.warehouseDropdownAnchor,
                warehouseChipLayout && {
                  top: warehouseChipLayout.y + warehouseChipLayout.height + 4,
                  left: warehouseChipLayout.x,
                  width: warehouseChipLayout.width,
                },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.purchaseDropdownCard}>
                <Text style={styles.purchaseDropdownTitle}>
                  {currentGroup ? (t(currentGroup.titleKey) || currentGroup.title) : ''}
                </Text>
                {/* 현지입/출고 드롭다운 — 전체 / 입고 / 출고 3개 항목.
                    기존 8개 진행상태(접수신청·도착예정·...) 는 사용자 요청으로 모두 제거. */}
                {([
                  { key: 'all', labelKey: 'profile.viewAll', fallbackLabel: '전체' },
                  { key: 'in', labelKey: 'profile.warehouseIn', fallbackLabel: '입고' },
                  { key: 'out', labelKey: 'profile.warehouseOut', fallbackLabel: '출고' },
                ] as const).map((item) => {
                  const selected = warehouseFilter === item.key;
                  return (
                    <TouchableOpacity
                      key={item.key}
                      style={styles.purchaseDropdownItem}
                      activeOpacity={0.7}
                      onPress={() => {
                        setActiveTab('warehouse');
                        setWarehouseFilter(item.key);
                        setSelectedProgressStatus(null);
                        setExpandedStatusGroup(null);
                      }}
                    >
                      <View
                        style={[
                          styles.purchaseDropdownBullet,
                          selected && styles.purchaseDropdownBulletActive,
                        ]}
                      />
                      <Text
                        style={[
                          styles.purchaseDropdownText,
                          selected && styles.purchaseDropdownTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {t(item.labelKey) || item.fallbackLabel}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* 오류 드롭다운 — 오류관리 · 반품관리 · 출고보류 · 문제상품 */}
        <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
          visible={!!(errorGroup && isErrorDropdownOpen && activeTab === 'error')}
          transparent
          animationType="fade"
          onRequestClose={() => setExpandedStatusGroup(null)}
        >
          <TouchableOpacity
            style={styles.purchaseDropdownBackdrop}
            activeOpacity={1}
            onPress={() => setExpandedStatusGroup(null)}
          >
            <View
              style={[
                styles.warehouseDropdownAnchor,
                errorChipLayout && {
                  top: errorChipLayout.y + errorChipLayout.height + 4,
                  left: errorChipLayout.x,
                  width: errorChipLayout.width,
                },
              ]}
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.purchaseDropdownCard}>
                <Text style={styles.purchaseDropdownTitle}>
                  {errorGroup ? (t(errorGroup.titleKey) || errorGroup.title) : ''}
                </Text>
                {errorDropdownItems.map((item) => {
                  const selected = errorSubFilter === item.key;
                  return (
                    <TouchableOpacity
                      key={item.key}
                      style={styles.purchaseDropdownItem}
                      activeOpacity={0.7}
                      onPress={item.onSelect}
                    >
                      <View
                        style={[
                          styles.purchaseDropdownBullet,
                          selected && styles.purchaseDropdownBulletActive,
                        ]}
                      />
                      <Text
                        style={[
                          styles.purchaseDropdownText,
                          selected && styles.purchaseDropdownTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {t(item.labelKey) || item.fallbackLabel}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Row 2: Select all + date */}
        <View style={styles.filterRow2}>
          <TouchableOpacity
            style={styles.selectAllChip}
            onPress={() => {
              if (selectedOrderIds.size === filteredOrders.length && filteredOrders.length > 0) {
                // Deselect all
                setSelectedOrderIds(new Set());
                setSelectAll(false);
              } else {
                // Select all
                setSelectedOrderIds(new Set(filteredOrders.map(o => o.id)));
                setSelectAll(true);
              }
            }}
          >
            <View style={[styles.selectAllCircle, (selectAll || (selectedOrderIds.size > 0 && selectedOrderIds.size === filteredOrders.length)) && styles.selectAllCircleActive]}>
              {(selectAll || (selectedOrderIds.size > 0 && selectedOrderIds.size === filteredOrders.length)) && (
                <Icon name="checkmark" size={12} color={COLORS.white} />
              )}
            </View>
            <Text style={styles.selectAllText}>{t('pages.orders.filters.selectAll') || '전체 선택'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterChip, isRepurchasing && styles.secondaryButtonDisabled]}
            onPress={handleToolbarRepurchase}
            disabled={isRepurchasing}
          >
            {isRepurchasing ? (
              <ActivityIndicator size="small" color={COLORS.text.secondary} />
            ) : (
              <Text style={styles.filterChipText}>
                {t('profile.repurchase') || '재구매'}
              </Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.filterChip}
            onPress={handleToolbarAddToCart}
          >
            <Text style={styles.filterChipText}>
              {t('buyList.addToCart') || '장바구니 담기'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterChip, (selectedStartDate || selectedEndDate) && styles.filterChipActive]}
            onPress={() => setShowDateModal(true)}
          >
            <Text style={[styles.filterChipText, (selectedStartDate || selectedEndDate) && styles.filterChipTextActive]}>
              {selectedStartDate
                ? `${selectedStartDate.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}${selectedEndDate ? ` ~ ${selectedEndDate.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}` : ''}`
                : (t('pages.orders.filters.periodSelect') || '기간선택')}
            </Text>
            <Icon name="calendar-outline" size={14} color={(selectedStartDate || selectedEndDate) ? COLORS.red : COLORS.text.primary} />
          </TouchableOpacity>
        </View>

      </>
    );
  };

  // Kakao address search HTML
  const kakaoPostcodeHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }
    #wrap { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="wrap"></div>
  <script src="https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js"></script>
  <script>
    window.onload = function() {
      new daum.Postcode({
        oncomplete: function(data) {
          var msg = JSON.stringify({
            zonecode: data.zonecode,
            roadAddress: data.roadAddress || data.jibunAddress,
            jibunAddress: data.jibunAddress,
            sido: data.sido,
            sigungu: data.sigungu,
          });
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(msg);
          }
        },
        width: '100%',
        height: '100%',
        maxSuggestItems: 5,
      }).embed(document.getElementById('wrap'), { autoClose: true });
    };
  </script>
</body>
</html>`;

  const screenBody = (
    <>
      {/* Header */}
      <View
        style={[styles.header, embedded && styles.embeddedHeader]}
        onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
      >
        {!embedded && (
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => {
              if (navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('Main' as never);
              }
            }}
          >
            <Icon name="chevron-back" size={24} color={COLORS.text.primary} />
          </TouchableOpacity>
        )}

        {/* Order number search input */}
        <View style={[styles.headerCenter, embedded && styles.embeddedHeaderCenter]}>
          <View style={styles.orderSearchBar}>
            <TextInput
              style={styles.orderSearchInput}
              placeholder={t('profile.searchOrders') || '주문 검색'}
              placeholderTextColor={COLORS.text.secondary}
              value={orderSearchText}
              onChangeText={(text) => {
                setOrderSearchText(text);
                handleApplyFilters({ ...filters, orderNumber: text });
              }}
              returnKeyType="search"
            />
            {!!orderSearchText ? (
              <TouchableOpacity onPress={() => { setOrderSearchText(''); handleApplyFilters({ ...filters, orderNumber: '' }); }}>
                <Icon name="close-circle" size={18} color={COLORS.text.primary} />
              </TouchableOpacity>
            ) : (
              <Icon name="search" size={18} color={COLORS.text.primary} />
            )}
          </View>
        </View>
        
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerActionButton} onPress={() => {
              setShowMoreMenu(false);
              // Initialize drafts from current applied values
              setDraftPlatform(filterPlatform);
              setDraftStartDate(selectedStartDate);
              setDraftEndDate(selectedEndDate);
              setShowInlineCalendar(false);
              setShowAllFiltersModal(true);
            }}>
            <TuneIcon width={24} height={24} color={COLORS.black} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerActionButton} onPress={() => setShowNavModal(true)}>
            <GridViewIcon width={24} height={24} color={COLORS.text.primary} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.headerActionButton}
            onPress={() => setShowMoreMenu(prev => !prev)}
          >
            <Icon name="ellipsis-horizontal" size={24} color={COLORS.text.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {/* More menu — absolute overlay below header */}
      {showMoreMenu && (
        <>
          <TouchableOpacity
            style={{ position: 'absolute', top: headerHeight, left: 0, right: 0, bottom: 0, zIndex: 99, backgroundColor: 'rgba(0,0,0,0.4)' }}
            activeOpacity={1}
            onPress={() => setShowMoreMenu(false)}
          />
          <View style={[styles.moreMenuRow, { top: headerHeight }]}>
            <TouchableOpacity
              style={styles.moreMenuItem}
              onPress={() => {
                setShowMoreMenu(false);
                showToast(t('buyList.moreMenu.exportOrders') || t('home.exportOrders') || 'Export Orders', 'info');
              }}
            >
              <ExportOrderIcon color={COLORS.black} />
              <Text style={styles.moreMenuItemText}>
                {t('buyList.moreMenu.exportOrders') || t('home.exportOrders') || 'Export Orders'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.moreMenuItem}
              onPress={() => {
                setShowMoreMenu(false);
                showToast(t('buyList.moreMenu.print') || t('home.print') || 'Print', 'info');
              }}
            >
              {/* <Icon name="print-outline" size={20} color={COLORS.text.primary} /> */}
              <PrintIcon color={COLORS.black} />
              <Text style={styles.moreMenuItemText}>
                {t('buyList.moreMenu.print') || t('home.print') || 'Print'}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Filter rows — outside ScrollView so modals work */}
      {renderCategoryStatusFilters()}

      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={ordersRefreshing}
            onRefresh={onOrdersRefresh}
            colors={[COLORS.red]}
            tintColor={COLORS.red}
          />
        }
        onScroll={(event) => {
          const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
          const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          if (distanceFromBottom < 200 && hasMoreRecommendations && !recommendationsLoading && !isRecommendationsRefreshingRef.current && !isLoadingMoreRecommendationsRef.current) {
            setRecommendationsOffset(prev => prev + 1);
          }
        }}
        scrollEventThrottle={400}
      >
        <View style={styles.content}>

          {isLoading && orders.length === 0 ? (
            /* Loading State — show a list-shaped skeleton in the body while
               orders are being fetched, so the page never flips back to a
               spinner after the lazy-route skeleton fades out. */
            <ScreenSkeleton variant="list" showHeader={false} />
          ) : (
            <>
              {/* Orders List or Empty State */}
              {filteredOrders.length === 0 && groupedOrdersForCategory.length === 0 ? (
                <View style={styles.emptyState}>
                  <Icon name="basket-outline" size={80} color="#CCC" />
                  <Text style={styles.emptyTitle}>{t('buyList.noOrders')}</Text>
                  <Text style={styles.emptySubtitle}>{t('buyList.noOrdersInCategory')}</Text>
                </View>
              ) : (
                <View style={styles.ordersContainer}>
                  {filteredOrders.map((order) => renderOrderWithStoreGrouping(order, true))}
                </View>
              )}
            </>
          )}

          {/* More to Love Section */}
          {/* {renderMoreToLove()} */}
        </View>
      </ScrollView>

      {/* Filter Modal */}
      <OrderFilterModal
        visible={showFilterModal}
        onClose={() => setShowFilterModal(false)}
        onApply={handleApplyFilters}
      />

      {/* Date Range Picker Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={showDateModal} transparent animationType="fade" onRequestClose={() => setShowDateModal(false)}>
        <TouchableOpacity style={styles.dateModalOverlay} activeOpacity={1} onPress={() => setShowDateModal(false)}>
          <View style={styles.dateModalContent} onStartShouldSetResponder={() => true}>
            {/* Month navigation */}
            <View style={styles.calendarHeader}>
              <TouchableOpacity onPress={() => { const d = new Date(calendarDate); d.setMonth(d.getMonth() - 1); setCalendarDate(d); }}>
                <Icon name="chevron-back" size={20} color={COLORS.text.primary} />
              </TouchableOpacity>
              <Text style={styles.calendarHeaderText}>
                {calendarDate.getFullYear()}년 {calendarDate.getMonth() + 1}월
              </Text>
              <TouchableOpacity onPress={() => { const d = new Date(calendarDate); d.setMonth(d.getMonth() + 1); setCalendarDate(d); }}>
                <Icon name="chevron-forward" size={20} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>
            {/* Day headers */}
            <View style={styles.calendarWeekRow}>
              {['일', '월', '화', '수', '목', '금', '토'].map(d => (
                <Text key={d} style={styles.calendarDayHeader}>{d}</Text>
              ))}
            </View>
            {/* Calendar grid */}
            {(() => {
              const year = calendarDate.getFullYear();
              const month = calendarDate.getMonth();
              const firstDay = new Date(year, month, 1).getDay();
              const daysInMonth = new Date(year, month + 1, 0).getDate();
              const cells: (number | null)[] = Array(firstDay).fill(null);
              for (let i = 1; i <= daysInMonth; i++) cells.push(i);
              while (cells.length % 7 !== 0) cells.push(null);
              const weeks: (number | null)[][] = [];
              for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
              return weeks.map((week, wi) => (
                <View key={wi} style={styles.calendarWeekRow}>
                  {week.map((day, di) => {
                    if (!day) return <View key={di} style={styles.calendarDayCell} />;
                    const date = new Date(year, month, day);
                    const isStart = selectedStartDate && date.toDateString() === selectedStartDate.toDateString();
                    const isEnd = selectedEndDate && date.toDateString() === selectedEndDate.toDateString();
                    const inRange = selectedStartDate && selectedEndDate && date > selectedStartDate && date < selectedEndDate;
                    return (
                      <TouchableOpacity
                        key={di}
                        style={[styles.calendarDayCell, (isStart || isEnd) && styles.calendarDayCellSelected, inRange && styles.calendarDayCellInRange]}
                        onPress={() => {
                          if (!selectedStartDate || (selectedStartDate && selectedEndDate)) {
                            setSelectedStartDate(date);
                            setSelectedEndDate(null);
                            setPickingEnd(true);
                          } else {
                            if (date < selectedStartDate) {
                              setSelectedEndDate(selectedStartDate);
                              setSelectedStartDate(date);
                            } else {
                              setSelectedEndDate(date);
                            }
                            setPickingEnd(false);
                            setShowDateModal(false);
                            handleApplyFilters({ ...filters, startDate: date < selectedStartDate ? date : selectedStartDate, endDate: date < selectedStartDate ? selectedStartDate : date });
                          }
                        }}
                      >
                        <Text style={[styles.calendarDayText, (isStart || isEnd) && styles.calendarDayTextSelected]}>{day}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ));
            })()}
            {/* Hint */}
            <Text style={styles.calendarHint}>
              {!selectedStartDate ? '시작일을 선택하세요' : !selectedEndDate ? '종료일을 선택하세요' : ''}
            </Text>
            {/* Clear */}
            {(selectedStartDate || selectedEndDate) && (
              <TouchableOpacity style={styles.calendarClearButton} onPress={() => { setSelectedStartDate(null); setSelectedEndDate(null); handleApplyFilters({ ...filters, startDate: null, endDate: null }); setShowDateModal(false); }}>
                <Text style={styles.calendarClearText}>초기화</Text>
              </TouchableOpacity>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      <BuyListProductSelectionModal
        visible={productSelectionItems != null && productSelectionItems.length > 0}
        items={productSelectionItems || []}
        onClose={() => setProductSelectionItems(null)}
      />

      {/* Refund Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={!!refundModalOrder} transparent animationType="slide" onRequestClose={() => setRefundModalOrder(null)}>
        <View style={styles.refundModalOverlay}>
          <View style={styles.refundModalContent}>
            {/* Header */}
            <Text style={styles.refundModalTitle}>{t('profile.refund') || 'Refund'}</Text>

            {refundModalOrder && (
              <>
                {/* Order ID + copy */}
                <View style={styles.refundOrderIdRow}>
                  <Text style={styles.refundOrderIdText}>주문ID: {refundModalOrder.orderNumber}</Text>
                  <TouchableOpacity onPress={() => {
                    const Clipboard = require('@react-native-clipboard/clipboard').default;
                    Clipboard.setString(refundModalOrder.orderNumber);
                    showToast(t('common.copied') || 'Copied', 'success');
                  }}>
                    <Text style={styles.refundCopyText}>복사</Text>
                  </TouchableOpacity>
                </View>

                {/* Order status */}
                <Text style={styles.refundStatusText}>{t(refundModalOrder.statusTranslationKey) || refundModalOrder.progressStatus}</Text>

                {/* Select all */}
                <TouchableOpacity
                  style={styles.refundSelectAllRow}
                  onPress={() => {
                    const allIds = new Set(refundModalOrder.items.map((_, i) => String(i)));
                    if (refundSelectedItems.size === refundModalOrder.items.length) {
                      setRefundSelectedItems(new Set());
                    } else {
                      setRefundSelectedItems(allIds);
                    }
                  }}
                >
                  <View style={[styles.refundCheckbox, refundSelectedItems.size === refundModalOrder.items.length && refundModalOrder.items.length > 0 && styles.refundCheckboxChecked]}>
                    {refundSelectedItems.size === refundModalOrder.items.length && refundModalOrder.items.length > 0 && (
                      <Icon name="checkmark" size={12} color={COLORS.white} />
                    )}
                  </View>
                  <Text style={styles.refundSelectAllText}>{t('pages.orders.filters.selectAll') || '전체 선택'}</Text>
                </TouchableOpacity>

                {/* Store groups with items */}
                <ScrollView style={styles.refundItemsScroll} showsVerticalScrollIndicator={false}>
                  {groupOrderItemsByStore(refundModalOrder.items).map((group, gi) => (
                    <View key={gi} style={styles.refundStoreGroup}>
                      <Text style={styles.refundStoreName}>
                        {resolveStoreName(group.companyName, group.items[0])} {'>'}
                      </Text>
                      {group.items.map((item, ii) => {
                        const itemKey = String(gi * 100 + ii);
                        const isSelected = refundSelectedItems.has(itemKey);
                        return (
                          <TouchableOpacity
                            key={ii}
                            style={styles.refundItemRow}
                            onPress={() => {
                              setRefundSelectedItems(prev => {
                                const next = new Set(prev);
                                next.has(itemKey) ? next.delete(itemKey) : next.add(itemKey);
                                return next;
                              });
                            }}
                          >
                            <View style={[styles.refundCheckbox, isSelected && styles.refundCheckboxChecked]}>
                              {isSelected && <Icon name="checkmark" size={12} color={COLORS.white} />}
                            </View>
                            <Image source={{ uri: item.image }} style={styles.refundItemImage} />
                            <View style={{ flex: 1 }}>
                              <Text style={styles.refundItemName} numberOfLines={2}>{item.productName}</Text>
                              <Text style={styles.refundItemPrice}>{formatPriceCNY(item.price)} x{item.quantity}</Text>
                            </View>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ))}
                </ScrollView>
              </>
            )}

            {/* Buttons */}
            <View style={styles.refundButtons}>
              <TouchableOpacity style={styles.refundCancelButton} onPress={() => setRefundModalOrder(null)}>
                <Text style={styles.refundCancelButtonText}>{t('common.cancel') || 'Cancel'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.refundConfirmButton, refundSelectedItems.size === 0 && { opacity: 0.4 }]}
                disabled={refundSelectedItems.size === 0}
                onPress={async () => {
                  if (!refundModalOrder) return;
                  // Build items list from selected indices
                  const allItems: any[] = [];
                  groupOrderItemsByStore(refundModalOrder.items).forEach((group, gi) => {
                    group.items.forEach((item, ii) => {
                      const key = String(gi * 100 + ii);
                      if (refundSelectedItems.has(key)) {
                        allItems.push({ item, key });
                      }
                    });
                  });
                  // Call refund-amount API
                  try {
                    const { orderApi } = await import('../../../../services/orderApi');
                    const refundItems = allItems.map(({ item }) => ({
                      itemId: item.itemId || item.offerId || '',
                      quantity: item.quantity,
                    }));
                    const res = await orderApi.getRefundAmount(refundModalOrder.id, refundItems);
                    setRefundModalOrder(null);
                    embedNavigate('RefundRequest', {
                      orderId: refundModalOrder.id,
                      orderNumber: refundModalOrder.orderNumber,
                      items: allItems.map(({ item }) => item),
                      refundData: res.success ? res.data : null,
                    });
                  } catch {
                    showToast(t('home.failedToGetRefundAmount'), 'error');
                  }
                }}
              >
                <Text style={styles.refundConfirmButtonText}>{t('common.confirm') || 'Confirm'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Cancel Order Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={!!cancelOrderModal} transparent animationType="fade" onRequestClose={() => setCancelOrderModal(null)}>
        <View style={styles.cancelModalOverlay}>
          <View style={styles.cancelModalContent}>
            {/* Header */}
            <View style={styles.cancelModalHeader}>
              <Text style={styles.cancelModalTitle}>{t('cart.cancelOrder') || 'Cancel order'}</Text>
              <TouchableOpacity onPress={() => setCancelOrderModal(null)}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>

            {/* Warning */}
            <View style={styles.cancelWarningBox}>
              <Icon name="alert-circle-outline" size={18} color={COLORS.red} style={{ marginTop: 2 }} />
              <Text style={styles.cancelWarningText}>
                {t('buyList.cancelOrderWarning')}
              </Text>
            </View>

            <Text style={styles.cancelReasonLabel}>
              {t('buyList.cancelOrderSelectReason')}
            </Text>

            {/* Reasons — stable id + localized label. cancelReason 은 id 를 저장하므로
                locale 이 바뀌어도 'Other' 분기가 깨지지 않는다. */}
            {([
              { id: 'changedMyMind', label: t('buyList.changedMyMind') },
              { id: 'incorrectInfo', label: t('buyList.incorrectInfo') },
              { id: 'outOfStock', label: t('buyList.outOfStock') },
              { id: 'other', label: t('buyList.other') },
            ] as const).map((reason) => (
              <TouchableOpacity
                key={reason.id}
                style={styles.cancelReasonRow}
                onPress={() => setCancelReason(reason.id)}
              >
                <View style={[styles.cancelRadio, cancelReason === reason.id && styles.cancelRadioSelected]}>
                  {cancelReason === reason.id && <Icon name="checkmark" size={12} color={COLORS.white} />}
                </View>
                <Text style={styles.cancelReasonText}>{reason.label}</Text>
              </TouchableOpacity>
            ))}

            {/* Other input — id 비교로 locale 무관하게 동작 */}
            {cancelReason === 'other' && (
              <TextInput
                style={styles.cancelOtherInput}
                placeholder={t('buyList.describeReason')}
                placeholderTextColor={COLORS.text.secondary}
                value={cancelOtherText}
                onChangeText={setCancelOtherText}
                multiline
                numberOfLines={3}
              />
            )}

            {/* Buttons */}
            <View style={styles.cancelModalButtons}>
              <TouchableOpacity style={styles.cancelModalCancelBtn} onPress={() => setCancelOrderModal(null)}>
                <Text style={styles.cancelModalCancelText}>{t('common.cancel') || 'Cancel'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.cancelModalConfirmBtn, (cancelReason === 'other' && !cancelOtherText.trim()) && { opacity: 0.4 }]}
                disabled={cancelReason === 'other' && !cancelOtherText.trim()}
                onPress={() => {
                  if (cancelOrderModal) {
                    cancelOrder(cancelOrderModal.orderId);
                    setCancelOrderModal(null);
                  }
                }}
              >
                <Text style={styles.cancelModalConfirmText}>{t('common.confirm') || 'Confirm'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Navigation Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={showNavModal} transparent animationType="fade" onRequestClose={() => setShowNavModal(false)}>
        <TouchableOpacity style={styles.navModalOverlay} activeOpacity={1} onPress={() => setShowNavModal(false)}>
          <View style={styles.navModalContent} onStartShouldSetResponder={() => true}>
            <View style={styles.navModalGrid}>
              {[
                { icon: (
                  <View>
                    <MessageIcon width={28} height={28} color={COLORS.text.primary} />
                    {totalMessageUnread > 0 && (
                      <View style={{ position: 'absolute', top: -4, right: -8, backgroundColor: COLORS.red || '#FF0000', borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{totalMessageUnread > 99 ? '99+' : totalMessageUnread}</Text>
                      </View>
                    )}
                  </View>
                ), key: 'message', label: t('buyList.navMenuModal.message') || 'Message', onPress: () => embedNavigate('Main', { screen: 'Message' }) },
                { icon: <HomeIcon width={28} color={COLORS.text.primary} />, key: 'main', label: t('buyList.navMenuModal.main') || 'Main', onPress: () => navigation.navigate('Main', { screen: 'Home' }) },
                { icon: <AccountIcon width={28} color={COLORS.text.primary} />, key: 'myAccount', label: t('buyList.navMenuModal.myAccount') || 'My Account', onPress: () => embedNavigate('ProfileSettings') },
                { icon: <CartIcon width={28} color={COLORS.text.primary} />, key: 'cart', label: t('buyList.navMenuModal.cart') || 'Cart', onPress: () => embedNavigate('Main', { screen: 'Cart' }) },
                { icon: <ReceiptIcon width={28} color={COLORS.text.primary} />, key: 'myOrders', label: t('buyList.navMenuModal.myOrders') || 'My Orders', onPress: () => profileEmbed?.openSidebarPanel('myOrders') },
                { icon: <ViewedIcon width={28} height={28} color={COLORS.text.primary} />, key: 'viewedProducts', label: t('buyList.navMenuModal.viewedProducts') || 'Viewed Products', onPress: () => embedNavigate('ViewedProducts') },
                { icon: <HeartIcon width={28} height={28} color={COLORS.text.primary} />, key: 'wishList', label: t('buyList.navMenuModal.wishList') || 'WishList', onPress: () => embedNavigate('Wishlist') },
                { icon: <OfficialSupportIcon width={28} height={28} color={COLORS.text.primary} />, key: 'officialSupport', label: t('buyList.navMenuModal.officialSupport') || 'Official Support', onPress: () => embedNavigate('CustomerService') },
                { icon: <FeedbackIcon width={28} height={28} color={COLORS.text.primary} />, key: 'feedback', label: t('buyList.navMenuModal.feedback') || 'Feedback', onPress: () => embedNavigate('Note') },
                { icon: <CustomerSupportIcon width={28} height={28} color={COLORS.text.primary} />, key: 'afterSales', label: t('buyList.navMenuModal.afterSales') || 'After-sales', onPress: () => embedNavigate('CustomerService') },
              ].map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={styles.navModalGridItem}
                  onPress={() => { setShowNavModal(false); item.onPress(); }}
                >
                  <View style={styles.navModalIconBox}>{item.icon}</View>
                  <Text style={styles.navModalItemText} numberOfLines={2}>{item.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity
              style={styles.navModalCancelBtn}
              onPress={() => setShowNavModal(false)}
            >
              <Text style={styles.navModalCancelText}>{t('common.cancel') || 'Cancel'}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* All Filters Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={showAllFiltersModal} transparent animationType="slide" onRequestClose={() => setShowAllFiltersModal(false)}>
        <View style={styles.allFiltersOverlay}>
          <View style={styles.allFiltersContent}>
            <View style={styles.allFiltersHeader}>
              <Text style={styles.allFiltersTitle}>{t('buyList.allFiltersModal.title') || 'Filters'}</Text>
              <TouchableOpacity onPress={() => setShowAllFiltersModal(false)}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Platform */}
              <View style={styles.allFiltersSection}>
                <Text style={styles.allFiltersSectionTitle}>{t('buyList.allFiltersModal.platform') || 'Platform'}</Text>
                <View style={styles.allFiltersChipRow}>
                  {[
                    // '전체' 칩만 i18n 처리. 1688/Taobao 는 브랜드명이라 그대로.
                    { label: t('buyList.allFiltersModal.platformAll') || 'All', value: '' },
                    { label: '1688', value: '1688' },
                    { label: 'Taobao', value: 'taobao' },
                  ].map(p => (
                    <TouchableOpacity
                      key={p.value || 'all'}
                      style={[styles.allFiltersChip, draftPlatform === p.value && styles.allFiltersChipActive]}
                      onPress={() => setDraftPlatform(p.value)}
                    >
                      <Text style={[styles.allFiltersChipText, draftPlatform === p.value && styles.allFiltersChipTextActive]}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Period */}
              <View style={styles.allFiltersSection}>
                <Text style={styles.allFiltersSectionTitle}>{t('pages.orders.filters.periodSelect') || '기간선택'}</Text>
                <TouchableOpacity
                  style={[styles.allFiltersChip, (draftStartDate || draftEndDate) && styles.allFiltersChipActive]}
                  onPress={() => setShowInlineCalendar(prev => !prev)}
                >
                  <Icon name="calendar-outline" size={14} color={(draftStartDate || draftEndDate) ? COLORS.red : COLORS.text.primary} />
                  <Text style={[styles.allFiltersChipText, (draftStartDate || draftEndDate) && styles.allFiltersChipTextActive]}>
                    {draftStartDate
                      ? `${draftStartDate.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}${draftEndDate ? ` ~ ${draftEndDate.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}` : ''}`
                      : (t('pages.orders.filters.periodSelect') || '기간선택')}
                  </Text>
                  <Icon name={showInlineCalendar ? 'chevron-up' : 'chevron-down'} size={14} color={COLORS.text.secondary} />
                </TouchableOpacity>

                {/* Inline calendar */}
                {showInlineCalendar && (
                  <View style={styles.inlineCalendar}>
                    {/* Month nav */}
                    <View style={styles.calendarHeader}>
                      <TouchableOpacity onPress={() => { const d = new Date(inlineCalendarDate); d.setMonth(d.getMonth() - 1); setInlineCalendarDate(d); }}>
                        <Icon name="chevron-back" size={18} color={COLORS.text.primary} />
                      </TouchableOpacity>
                      <Text style={styles.calendarHeaderText}>{inlineCalendarDate.getFullYear()}{t('buyList.allFiltersModal.calendarYearSuffix') || '년 '}{inlineCalendarDate.getMonth() + 1}{t('buyList.allFiltersModal.calendarMonthSuffix') || '월'}</Text>
                      <TouchableOpacity onPress={() => { const d = new Date(inlineCalendarDate); d.setMonth(d.getMonth() + 1); setInlineCalendarDate(d); }}>
                        <Icon name="chevron-forward" size={18} color={COLORS.text.primary} />
                      </TouchableOpacity>
                    </View>
                    {/* Day headers */}
                    <View style={styles.calendarWeekRow}>
                      {[
                        t('buyList.allFiltersModal.weekdayShort0') || '일',
                        t('buyList.allFiltersModal.weekdayShort1') || '월',
                        t('buyList.allFiltersModal.weekdayShort2') || '화',
                        t('buyList.allFiltersModal.weekdayShort3') || '수',
                        t('buyList.allFiltersModal.weekdayShort4') || '목',
                        t('buyList.allFiltersModal.weekdayShort5') || '금',
                        t('buyList.allFiltersModal.weekdayShort6') || '토',
                      ].map((d, i) => (
                        <Text key={i} style={styles.calendarDayHeader}>{d}</Text>
                      ))}
                    </View>
                    {/* Days grid */}
                    {(() => {
                      const year = inlineCalendarDate.getFullYear();
                      const month = inlineCalendarDate.getMonth();
                      const firstDay = new Date(year, month, 1).getDay();
                      const daysInMonth = new Date(year, month + 1, 0).getDate();
                      const cells: (number | null)[] = Array(firstDay).fill(null);
                      for (let i = 1; i <= daysInMonth; i++) cells.push(i);
                      while (cells.length % 7 !== 0) cells.push(null);
                      const weeks: (number | null)[][] = [];
                      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
                      return weeks.map((week, wi) => (
                        <View key={wi} style={styles.calendarWeekRow}>
                          {week.map((day, di) => {
                            if (!day) return <View key={di} style={styles.calendarDayCell} />;
                            const date = new Date(year, month, day);
                            const isStart = draftStartDate && date.toDateString() === draftStartDate.toDateString();
                            const isEnd = draftEndDate && date.toDateString() === draftEndDate.toDateString();
                            const inRange = draftStartDate && draftEndDate && date > draftStartDate && date < draftEndDate;
                            return (
                              <TouchableOpacity
                                key={di}
                                style={[styles.calendarDayCell, (isStart || isEnd) && styles.calendarDayCellSelected, inRange && styles.calendarDayCellInRange]}
                                onPress={() => {
                                  if (!draftStartDate || (draftStartDate && draftEndDate)) {
                                    setDraftStartDate(date);
                                    setDraftEndDate(null);
                                    setInlinePickingEnd(true);
                                  } else {
                                    const start = date < draftStartDate ? date : draftStartDate;
                                    const end = date < draftStartDate ? draftStartDate : date;
                                    setDraftStartDate(start);
                                    setDraftEndDate(end);
                                    setInlinePickingEnd(false);
                                    setShowInlineCalendar(false);
                                  }
                                }}
                              >
                                <Text style={[styles.calendarDayText, (isStart || isEnd) && styles.calendarDayTextSelected]}>{day}</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      ));
                    })()}
                    <Text style={styles.calendarHint}>
                      {!draftStartDate
                        ? (t('buyList.allFiltersModal.selectStartDate') || '시작일을 선택하세요')
                        : !draftEndDate
                          ? (t('buyList.allFiltersModal.selectEndDate') || '종료일을 선택하세요')
                          : ''}
                    </Text>
                    {(draftStartDate || draftEndDate) && (
                      <TouchableOpacity onPress={() => { setDraftStartDate(null); setDraftEndDate(null); setShowInlineCalendar(false); }}>
                        <Text style={{ color: COLORS.red, fontSize: FONTS.sizes.xs, textAlign: 'center', marginTop: 4 }}>{t('buyList.allFiltersModal.clearDates') || '초기화'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            </ScrollView>

            {/* Apply / Reset */}
            <View style={styles.allFiltersButtons}>
              <TouchableOpacity
                style={styles.allFiltersResetBtn}
                onPress={() => {
                  setDraftPlatform('');
                  setDraftStartDate(null);
                  setDraftEndDate(null);
                }}
              >
                <Text style={styles.allFiltersResetText}>{t('buyList.allFiltersModal.reset') || 'Reset'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.allFiltersApplyBtn}
                onPress={() => {
                  // Commit drafts to real filter states (triggers re-fetch via useCallback deps)
                  setFilterPlatform(draftPlatform);
                  setSelectedStartDate(draftStartDate);
                  setSelectedEndDate(draftEndDate);
                  setShowAllFiltersModal(false);
                }}
              >
                <Text style={styles.allFiltersApplyText}>{t('buyList.allFiltersModal.apply') || 'Apply'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Selection bottom bar */}
      {selectedOrderIds.size > 0 && (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionBarText}>
            {selectedOrderIds.size}개 선택됨
          </Text>
          {/* <TouchableOpacity
            style={styles.selectionBarDelete}
            onPress={() => {
              Alert.alert(
                t('common.delete') || 'Delete',
                `${selectedOrderIds.size}개 주문을 삭제하시겠습니까?`,
                [
                  { text: t('common.cancel') || 'Cancel', style: 'cancel' },
                  { text: t('common.confirm') || 'Confirm', onPress: () => setSelectedOrderIds(new Set()) },
                ]
              );
            }}
          >
            <Text style={styles.selectionBarDeleteText}>{t('common.delete') || 'Delete'}</Text>
          </TouchableOpacity> */}
        </View>
      )}

      {/* Edit Address Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={addressModalVisible} transparent animationType="slide" onRequestClose={() => setAddressModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.addressModalContent}>
            <View style={styles.addressModalHeader}>
              <Text style={styles.addressModalTitle}>{t('buyList.editAddressModal.title')}</Text>
              <TouchableOpacity onPress={() => setAddressModalVisible(false)}>
                <Icon name="close" size={24} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.addressModalLabel}>{t('buyList.editAddressModal.currentlyDeliveringTo')}</Text>
              <View style={styles.addressModalRow}>
                <View style={styles.addressModalDropdown}>
                  <Text style={styles.addressModalDropdownText}>{t('buyList.editAddressModal.countryKorea')}</Text>
                  <Icon name="chevron-down" size={20} color={COLORS.gray[600]} />
                </View>
                {/* <TouchableOpacity style={styles.defaultCheckboxRow} onPress={() => setIsDefaultAddress(!isDefaultAddress)}>
                  <Text style={styles.defaultText}>Default</Text>
                  <View style={[styles.checkboxSquare, isDefaultAddress && styles.checkboxSquareChecked]}>
                    {isDefaultAddress && <Icon name="checkmark" size={16} color={COLORS.white} />}
                  </View>
                </TouchableOpacity> */}
              </View>

              <Text style={styles.addressModalLabel}><Text style={styles.addressModalRequired}>* </Text>{t('buyList.editAddressModal.addressInformation')}</Text>
              <TouchableOpacity style={styles.addressSearchBtn} onPress={() => setShowKakaoAddress(true)}>
                <Icon name="search" size={16} color={COLORS.white} />
                <Text style={styles.addressSearchBtnText}>{t('buyList.editAddressModal.searchAddressKakao')}</Text>
              </TouchableOpacity>

              <Text style={styles.addressModalLabel}><Text style={styles.addressModalRequired}>* </Text>{t('buyList.editAddressModal.postalCode')}</Text>
              <TextInput
                style={styles.addressModalInput}
                placeholder={t('buyList.postalCode')}
                placeholderTextColor={COLORS.gray[400]}
                value={editAddress.zonecode}
                onChangeText={(v) => setEditAddress(prev => ({ ...prev, zonecode: v }))}
                keyboardType="number-pad"
              />

              <Text style={styles.addressModalLabel}><Text style={styles.addressModalRequired}>* </Text>{t('buyList.editAddressModal.detailAddress')}</Text>
              <TextInput
                style={styles.addressModalInput}
                placeholder={t('buyList.searchAddress')}
                placeholderTextColor={COLORS.gray[400]}
                value={editAddress.detailAddress}
                onChangeText={(v) => setEditAddress(prev => ({ ...prev, detailAddress: v }))}
              />

              <Text style={styles.addressModalLabel}><Text style={styles.addressModalRequired}>* </Text>{t('buyList.editAddressModal.recipientName')}</Text>
              <TextInput
                style={styles.addressModalInput}
                placeholder={t('buyList.upTo25Chars')}
                placeholderTextColor={COLORS.gray[400]}
                value={editAddress.recipient}
                onChangeText={(v) => setEditAddress(prev => ({ ...prev, recipient: v }))}
                maxLength={25}
              />

              <Text style={styles.addressModalLabel}><Text style={styles.addressModalRequired}>* </Text>{t('buyList.editAddressModal.mobileNumber')}</Text>
              <View style={styles.addressModalPhoneRow}>
                <View style={styles.addressModalPhoneCode}>
                  <Text style={{ fontSize: FONTS.sizes.sm, color: COLORS.text.primary }}>{t('buyList.editAddressModal.koreaDialCode')}</Text>
                  <Icon name="chevron-down" size={20} color={COLORS.gray[600]} />
                </View>
                <TextInput
                  style={[styles.addressModalInput, { flex: 1 }]}
                  value={editAddress.contact}
                  onChangeText={(v) => setEditAddress(prev => ({ ...prev, contact: v }))}
                  keyboardType="phone-pad"
                />
              </View>

              <Text style={styles.addressModalLabel}><Text style={styles.addressModalRequired}>* </Text>{t('buyList.editAddressModal.customsClearanceCode')}</Text>
              <TextInput
                style={styles.addressModalInput}
                placeholder={t('buyList.enterCustomsCode')}
                placeholderTextColor={COLORS.gray[400]}
                value={editAddress.customsCode}
                onChangeText={(v) => setEditAddress(prev => ({ ...prev, customsCode: v }))}
              />

              <TouchableOpacity
                style={styles.addressModalSaveButton}
                disabled={isSavingAddress}
                onPress={async () => {
                  if (!selectedOrderForAddress) return;
                  setIsSavingAddress(true);
                  try {
                    const res = await orderApi.updateShippingAddress(selectedOrderForAddress.id, {
                      recipient: editAddress.recipient,
                      contact: editAddress.contact,
                      detailedAddress: editAddress.detailAddress || editAddress.roadAddress,
                      zipCode: editAddress.zonecode,
                      personalCustomsCode: editAddress.customsCode,
                      country: 'South Korea',
                    });
                    if (res.success) {
                      showToast(t('profile.addressModal.updateSuccess'), 'success');
                      // Update the order in the list with new address
                      setOrders(prevOrders => 
                        prevOrders.map(o => 
                          o.id === selectedOrderForAddress.id 
                            ? {
                                ...o,
                                shippingAddress: {
                                  ...o.shippingAddress,
                                  recipient: editAddress.recipient,
                                  contact: editAddress.contact,
                                  detailedAddress: editAddress.detailAddress || editAddress.roadAddress,
                                  zipCode: editAddress.zonecode,
                                  personalCustomsCode: editAddress.customsCode,
                                } as any
                              }
                            : o
                        )
                      );
                      setAddressModalVisible(false);
                    } else {
                      showToast(res.error || t('buyList.failedToUpdateAddress'), 'error');
                    }
                  } catch (error: any) {
                    console.error('Address update error:', error);
                    showToast(error?.message || t('buyList.failedToUpdateAddress'), 'error');
                  } finally {
                    setIsSavingAddress(false);
                  }
                }}
              >
                {isSavingAddress ? (
                  <ActivityIndicator size="small" color={COLORS.white} />
                ) : (
                  <Text style={styles.addressModalSaveButtonText}>{t('buyList.editAddressModal.save')}</Text>
                )}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Kakao Address Search WebView */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']} visible={showKakaoAddress} transparent animationType="slide" onRequestClose={() => setShowKakaoAddress(false)}>
        <View style={styles.kakaoModalOverlay}>
          <View style={styles.kakaoModalContent}>
            <View style={styles.kakaoModalHeader}>
              <Text style={styles.kakaoModalTitle}>{t('buyList.editAddressModal.kakaoSearchTitle')}</Text>
              <TouchableOpacity onPress={() => setShowKakaoAddress(false)}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>
            <WebView
              source={{ html: kakaoPostcodeHtml, baseUrl: 'https://postcode.map.daum.net' }}
              style={{ flex: 1 }}
              onMessage={(e) => {
                try {
                  const data = JSON.parse(e.nativeEvent.data);
                  setEditAddress(prev => ({
                    ...prev,
                    zonecode: data.zonecode || '',
                    roadAddress: data.roadAddress || '',
                    detailAddress: data.roadAddress || '',
                  }));
                  setShowKakaoAddress(false);
                } catch {}
              }}
              javaScriptEnabled
              domStorageEnabled
              mixedContentMode="always"
              originWhitelist={['*']}
              allowsInlineMediaPlayback
            />
          </View>
        </View>
      </Modal>
    </>
  );

  if (embedded) {
    return (
      <View style={[styles.container, styles.embeddedContainer]}>{screenBody}</View>
    );
  }

  return <SafeAreaView style={styles.container}>{screenBody}</SafeAreaView>;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  embeddedContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  embeddedHeader: {
    paddingTop: SPACING.sm,
  },
  embeddedHeaderCenter: {
    flex: 1,
    marginLeft: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm * 2,
    paddingTop: SPACING.sm,
    backgroundColor: COLORS.white,
    gap: SPACING.sm,
  },
  backButton: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
  },
  orderSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0000000D',
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    // height: 40,
  },
  orderSearchInput: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    padding: 0,

  },
  dateModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  dateModalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.md,
    width: '100%',
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.xs,
  },
  calendarHeaderText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  calendarWeekRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 4,
  },
  calendarDayHeader: {
    flex: 1,
    textAlign: 'center',
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
    paddingVertical: SPACING.xs,
  },
  calendarDayCell: {
    flex: 1,
    aspectRatio: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
  },
  calendarDayCellSelected: {
    backgroundColor: COLORS.red,
  },
  calendarDayCellInRange: {
    backgroundColor: COLORS.lightRed,
    borderRadius: 0,
  },
  calendarDayText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  calendarDayTextSelected: {
    color: COLORS.white,
    fontWeight: '700',
  },
  calendarHint: {
    textAlign: 'center',
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    marginTop: SPACING.sm,
  },
  calendarClearButton: {
    marginTop: SPACING.sm,
    alignSelf: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
  },
  calendarClearText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  headerActions: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  headerActionButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollView: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    paddingBottom: SPACING.xl,
  },
  tabScrollView: {
    marginBottom: SPACING.md,
    marginTop: SPACING.sm,
  },
  tabScrollContent: {
    paddingHorizontal: SPACING.md,
  },
  categoryStatusFilterContainer: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.sm,
    gap: SPACING.sm,
  },
  categoryStatusGroupsRow: {
    gap: SPACING.sm,
  },
  categoryStatusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 999,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  categoryStatusChipActive: {
    backgroundColor: COLORS.primary,
    borderColor: COLORS.primary,
  },
  categoryStatusChipText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  categoryStatusChipTextActive: {
    color: COLORS.white,
  },
  categoryStatusChipArrow: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  categoryStatusDropdown: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.xs,
  },
  categoryStatusOption: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  categoryStatusOptionActive: {
    backgroundColor: COLORS.primary + '12',
  },
  categoryStatusOptionText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  categoryStatusOptionTextActive: {
    color: COLORS.primary,
  },
  categoryStatusOptionCode: {
    marginTop: 2,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  // New filter row styles
  tabBar: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  tabBarContent: {
    paddingHorizontal: SPACING.md,
    gap: SPACING.xs,
  },
  tabBarItem: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabBarItemActive: {
    borderBottomColor: COLORS.red,
  },
  tabBarText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '400',
  },
  tabBarTextActive: {
    color: COLORS.red,
    fontWeight: '700',
  },
  filterRow1: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  filterRow1Content: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    alignItems: 'center',
  },
  filterRow2: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    backgroundColor: COLORS.white,
  },
  filterChipActive: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.lightRed,
  },
  filterChipText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  filterChipTextActive: {
    color: COLORS.red,
    fontWeight: '600',
  },
  filterChipCountBadge: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[600],
    fontWeight: '400',
  },
  filterChipCountBadgeActive: {
    color: COLORS.red,
    fontWeight: '600',
  },
  selectAllChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  selectAllCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: COLORS.gray[400],
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectAllCircleActive: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.red,
  },
  selectAllText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  groupDropdown: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    marginHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    overflow: 'hidden',
  },
  groupDropdownItem: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.gray[100],
  },
  groupDropdownItemActive: {
    backgroundColor: COLORS.lightRed,
  },
  groupDropdownText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  groupDropdownTextActive: {
    color: COLORS.red,
    fontWeight: '600',
  },
  groupDropdownCount: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  dropdownModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  // 발주관리 드롭다운 backdrop — dim 없이 투명. 바깥 탭으로만 닫힘.
  purchaseDropdownBackdrop: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  // 발주관리 드롭다운 — 칩 아래에 떠 있는 카드.
  // top/left 는 발주관리 칩의 measureInWindow 결과로 인라인 오버라이드된다.
  // 측정 전 잠깐 깜박임을 막기 위해 기본값을 화면 밖으로 둔다.
  // 너비는 이전 220px 의 절반인 110px.
  purchaseDropdownAnchor: {
    position: 'absolute',
    top: -1000,
    left: -1000,
    width: 110,
  },
  // 현지입/출고 드롭다운 — 칩 아래에 떠 있고 너비는 칩과 일치.
  // top·left·width 모두 measureInWindow 결과로 인라인 오버라이드된다.
  warehouseDropdownAnchor: {
    position: 'absolute',
    top: -1000,
    left: -1000,
    width: 110,
  },
  purchaseDropdownCard: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    paddingVertical: SPACING.xs,
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  purchaseDropdownTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  purchaseDropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
    paddingRight: SPACING.md,
  },
  purchaseDropdownBullet: {
    width: 3,
    height: 16,
    borderRadius: 1.5,
    backgroundColor: 'transparent',
    marginRight: SPACING.sm,
  },
  purchaseDropdownBulletActive: {
    backgroundColor: COLORS.red,
  },
  purchaseDropdownText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  purchaseDropdownTextActive: {
    color: COLORS.red,
    fontWeight: '700',
  },
  dropdownModalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.xl,
    width: '100%',
    overflow: 'hidden',
    maxHeight: 400,
  },
  dropdownModalTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  tabContainer: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  tab: {
    // paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 0,
    backgroundColor: 'transparent',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: COLORS.red,
  },
  tabText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '400',
    color: COLORS.text.primary,
  },
  tabTextActive: {
    color: COLORS.red,
    fontWeight: '700',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: SPACING.xxl * 2,
    paddingHorizontal: SPACING.lg,
  },
  emptyTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginTop: SPACING.md,
  },
  emptySubtitle: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    marginTop: SPACING.xs,
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.xxl * 2,
    paddingHorizontal: SPACING.lg,
  },
  loadingText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    marginTop: SPACING.md,
  },
  ordersContainer: {
    backgroundColor: COLORS.white,
    // borderRadius: 12,
    padding: SPACING.md,
    overflow: 'hidden',
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  statusSection: {
    marginBottom: SPACING.lg,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
  },
  statusTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.primary,
  },
  orderCard: {
    // marginBottom: SPACING.md,
  },
  storeHeader: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  storeName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  productItem: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  productMainCol: {
    flex: 1,
    flexDirection: 'row',
    gap: SPACING.sm,
    minWidth: 0,
  },
  addServicesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  addServicesLabel: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  addServicesIcons: {
    flexDirection: 'row',
    gap: 4,
  },
  addServiceIcon: {
    width: 18,
    height: 18,
    borderRadius: 3,
    backgroundColor: COLORS.white,
    borderWidth: 1.5,
    borderColor: COLORS.red,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  addServiceIconImage: {
    width: 14,
    height: 14,
  },
  addServicesNone: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  productUnitPriceCol: {
    alignItems: 'flex-end',
    minWidth: 72,
    gap: 2,
  },
  unitPriceText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  lineSubtotalText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.red,
  },
  productPaymentCol: {
    width: 108,
    alignItems: 'flex-end',
    borderLeftWidth: 1,
    borderLeftColor: COLORS.gray[200],
    paddingLeft: SPACING.xs,
    gap: 2,
  },
  paymentColLabel: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  paymentColValue: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  paymentBreakdownText: {
    fontSize: 10,
    color: COLORS.text.secondary,
    textAlign: 'right',
  },
  orderSummaryFooter: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.gray[50],
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    flexWrap: 'wrap',
  },
  orderSummaryLeftWrap: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    minWidth: 0,
    maxWidth: '100%',
  },
  orderSummaryLeft: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.sizes.xs * 18 / 12),
    flexShrink: 1,
  },
  seeMoreLink: {
    fontSize: FONTS.sizes.xs,
    color: '#2563EB',
    fontWeight: '600',
    lineHeight: Math.round(FONTS.sizes.xs * 18 / 12),
  },
  orderSummaryCenter: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    flexShrink: 0,
    textAlign: 'center',
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
    paddingTop: 1,
  },
  orderSummaryRight: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    flexShrink: 0,
    textAlign: 'right',
    lineHeight: Math.round(FONTS.sizes.xs * 18 / 12),
    paddingTop: 1,
    minWidth: 120,
  },
  productImageContainer: {
    position: 'relative',
  },
  productImage: {
    width: 72,
    height: 72,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.gray[100],
  },
  productInfo: {
    flex: 1,
    gap: 4,
  },
  productTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '500',
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
  },
  productSpecs: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  productDescription: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.sizes.xs * 16 / 12),
  },
  productPriceCol: {
    alignItems: 'flex-end',
    gap: 4,
    minWidth: 60,
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  currentPrice: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  originalPrice: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    textDecorationLine: 'line-through',
  },
  quantity: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFF3CD',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: 12,
    marginTop: 4,
  },
  statusBadgeText: {
    fontSize: FONTS.sizes.xs,
    color: '#856404',
    fontWeight: '500',
  },
  shippingInfo: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.gray[50],
  },
  shippingTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.primary,
  },
  shippingDetails: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginTop: 2,
  },
  transitInfo: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.gray[50],
  },
  transitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  transitTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.primary,
  },
  transitDetails: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginTop: 2,
  },
  orderTotal: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    alignItems: 'flex-end',
  },
  totalText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  actionButtons: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
    // borderTopWidth: 1,
    // borderTopColor: COLORS.border,
  },
  secondaryButtonDisabled: {
    opacity: 0.55,
  },
  secondaryButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
    backgroundColor: COLORS.white,
  },
  secondaryButtonText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  primaryButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '600',
  },
  // 무통장 결제 신청 후 admin 입금 확인까지 카드에 표시되는 "결제중" 배지.
  // 결제하기 버튼과 같은 자리에 표시되지만 비활성 (탭 불가) 형태.
  payingBadge: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray?.[200] ?? '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  payingBadgeText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  payingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  cancelPendingButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.red,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 56,
  },
  cancelPendingButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.red,
    fontWeight: '700',
  },
  cancelOrderButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.error,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelOrderButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.error,
    fontWeight: '600',
  },
  additionalActions: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
  },
  additionalActionButton: {
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  additionalActionText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  loadingMoreContainer: {
    paddingVertical: SPACING.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingMoreText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
  },
  endOfListContainer: {
    paddingVertical: SPACING.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endOfListText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  moreToLoveSection: {
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.lg,
  },
  sectionTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
  },
  productGrid: {
    paddingBottom: SPACING.lg,
  },
  productRow: {
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  // New styles for store grouping
  orderContainer: {
    backgroundColor: COLORS.white,
    marginBottom: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    overflow: 'hidden',
  },
  orderHeaderRow: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
    gap: SPACING.xs,
  },
  orderHeaderMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flexWrap: 'wrap',
  },
  orderHeaderDate: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    flexShrink: 1,
  },
  orderHeaderMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flexWrap: 'wrap',
  },
  // 카드의 오른쪽 위 모서리에 absolute 로 띄우는 도메인 배지 + 주문번호 + 복사 묶음.
  // 헤더 row 의 다른 요소들 위에 떠 있도록 zIndex 를 조금 올린다.
  orderHeaderMetaCorner: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    zIndex: 2,
  },
  orderHeaderNumber: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  orderHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
  domainBadge: {
    borderWidth: 1,
    borderColor: COLORS.red,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  domainBadgeText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '600',
  },
  orderDetailLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  orderDetailLinkText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  // 주문문의 = 수화기 아이콘 버튼 (텍스트/테두리 없는 아이콘 형식).
  orderInquiryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  orderInquiryButtonText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '600',
  },
  orderStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  orderStatusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  orderCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: COLORS.gray[400],
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  orderCheckboxChecked: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.red,
  },
  orderStatusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: COLORS.red,
  },
  orderStatusText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.red,
  },
  orderHelpButton: {
    padding: SPACING.xs,
  },
  orderIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  orderIdText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  orderCopyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.red,
    fontWeight: '600',
  },
  orderTotalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
  },
  orderTotalLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  orderTotalValue: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  orderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.gray[50],
    borderRadius: 8,
    marginBottom: SPACING.sm,
  },
  orderNumber: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  orderDate: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  storeTotal: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    alignItems: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  storeTotalText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.primary,
  },
  orderActionButtons: {
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    backgroundColor: COLORS.white,
  },
  orderActionButtonsContent: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    alignItems: 'center',
  },
  orderAdditionalActions: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
    backgroundColor: COLORS.white,
    borderRadius: 8,
    gap: SPACING.md,
    justifyContent: 'center',
  },
  selectionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
    ...SHADOWS.md,
  },
  selectionBarText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  selectionBarDelete: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.md,
  },
  selectionBarDeleteText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.white,
  },
  moreMenuRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    gap: SPACING.xl,
    flexDirection: 'row',
    zIndex: 100,
    elevation: 4,
  },
  moreMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  moreMenuItemText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  allFiltersOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  allFiltersContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.md,
    maxHeight: '80%',
  },
  allFiltersHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  allFiltersTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  allFiltersSection: {
    marginBottom: SPACING.md,
  },
  allFiltersSectionTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: SPACING.sm,
  },
  allFiltersChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  allFiltersChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    backgroundColor: COLORS.white,
  },
  allFiltersChipActive: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.lightRed,
  },
  allFiltersChipText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  allFiltersChipTextActive: {
    color: COLORS.red,
    fontWeight: '600',
  },
  allFiltersButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.md,
  },
  allFiltersResetBtn: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
  },
  allFiltersResetText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  allFiltersApplyBtn: {
    flex: 2,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.red,
    alignItems: 'center',
  },
  allFiltersApplyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '700',
  },
  inlineCalendar: {
    marginTop: SPACING.sm,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    backgroundColor: COLORS.white,
  },
  navModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  navModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    paddingVertical: SPACING.md,
    paddingBottom: SPACING.xl,
    paddingHorizontal: SPACING.md,
  },
  navModalGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  navModalGridItem: {
    width: '20%',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    gap: SPACING.xs,
  },
  navModalIconBox: {
    width: 52,
    height: 52,
    borderRadius: BORDER_RADIUS.full,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  navModalItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.gray[100],
  },
  navModalItemText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '400',
    textAlign: 'center',
  },
  navModalCancelBtn: {
    marginTop: SPACING.sm,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
    alignItems: 'center',
  },
  navModalCancelText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  cancelModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  cancelModalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.md,
    width: '100%',
  },
  cancelModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  cancelModalTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  cancelWarningBox: {
    flexDirection: 'row',
    gap: SPACING.xs,
    backgroundColor: '#FFF3EE',
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    marginBottom: SPACING.md,
  },
  cancelWarningText: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 20 / 14),
  },
  cancelReasonLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginBottom: SPACING.sm,
  },
  cancelReasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  cancelRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: COLORS.gray[400],
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelRadioSelected: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.red,
  },
  cancelReasonText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  cancelOtherInput: {
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    minHeight: 72,
    textAlignVertical: 'top',
    marginTop: SPACING.xs,
  },
  cancelModalButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    paddingTop: SPACING.md,
  },
  cancelModalCancelBtn: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
  },
  cancelModalCancelText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  cancelModalConfirmBtn: {
    flex: 2,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.red,
    alignItems: 'center',
  },
  cancelModalConfirmText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.white,
    fontWeight: '700',
  },
  refundModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  refundModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    padding: SPACING.md,
    maxHeight: '85%',
  },
  refundModalTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  refundOrderIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
    marginBottom: SPACING.xs,
  },
  refundOrderIdText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  refundCopyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.red,
    fontWeight: '600',
  },
  refundStatusText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.red,
    fontWeight: '700',
    marginBottom: SPACING.sm,
  },
  refundSelectAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
    marginBottom: SPACING.sm,
  },
  refundSelectAllText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  refundCheckbox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: COLORS.gray[400],
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  refundCheckboxChecked: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.red,
  },
  refundItemsScroll: {
    maxHeight: 300,
    marginBottom: SPACING.md,
  },
  refundStoreGroup: {
    marginBottom: SPACING.sm,
  },
  refundStoreName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
    marginBottom: SPACING.xs,
  },
  refundItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.gray[100],
  },
  refundItemImage: {
    width: 56,
    height: 56,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.gray[100],
  },
  refundItemName: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
  },
  refundItemPrice: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginTop: 2,
  },
  refundButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  refundCancelButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
  },
  refundCancelButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  refundConfirmButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.red,
    alignItems: 'center',
  },
  refundConfirmButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '700',
  },
  atcModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  atcModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xl,
    maxHeight: '80%',
  },
  atcModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  atcModalTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  atcLoadingContainer: {
    paddingVertical: SPACING.xl * 2,
    alignItems: 'center',
  },
  atcProductRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  atcProductImage: {
    width: 80,
    height: 80,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.gray[100],
  },
  atcProductName: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
    marginBottom: SPACING.xs,
  },
  atcProductPrice: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.red,
  },
  atcSection: {
    marginBottom: SPACING.md,
  },
  atcSectionTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: SPACING.sm,
  },
  atcSkuRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
  atcSkuChip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    backgroundColor: COLORS.white,
  },
  atcSkuChipActive: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.lightRed,
  },
  atcSkuChipText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  atcSkuChipTextActive: {
    color: COLORS.red,
    fontWeight: '600',
  },
  atcSkuChipImage: {
    width: 24,
    height: 24,
    borderRadius: 4,
    marginRight: 4,
  },
  atcQtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  atcQtyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    justifyContent: 'center',
    alignItems: 'center',
  },
  atcQtyText: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
    minWidth: 30,
    textAlign: 'center',
  },
  atcConfirmButtonDisabled: {
    opacity: 0.7,
  },
  atcConfirmButton: {
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.md,
  },
  atcConfirmButtonText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.white,
  },
  // Address modal styles
  modalOverlay: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.5)', 
    justifyContent: 'flex-end' 
  },
  addressModalContent: { 
    backgroundColor: COLORS.white, 
    borderTopLeftRadius: 20, 
    borderTopRightRadius: 20, 
    padding: SPACING.md, 
    maxHeight: '90%' 
  },
  addressModalHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    marginBottom: SPACING.md 
  },
  addressModalTitle: { 
    fontSize: FONTS.sizes.lg, 
    fontWeight: '700', 
    color: COLORS.text.primary 
  },
  addressModalLabel: { 
    fontSize: FONTS.sizes.sm, 
    color: COLORS.text.secondary, 
    marginBottom: SPACING.xs, 
    marginTop: SPACING.sm 
  },
  addressModalRequired: { 
    color: COLORS.red 
  },
  addressModalRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    marginBottom: SPACING.sm 
  },
  addressModalDropdown: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    borderWidth: 1, 
    borderColor: COLORS.gray[300], 
    borderRadius: BORDER_RADIUS.md, 
    paddingHorizontal: SPACING.sm, 
    paddingVertical: SPACING.sm, 
    gap: SPACING.xs, 
    flex: 1 
  },
  addressModalDropdownText: { 
    fontSize: FONTS.sizes.sm, 
    color: COLORS.text.primary, 
    flex: 1 
  },
  defaultCheckboxRow: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: SPACING.xs, 
    marginLeft: SPACING.sm 
  },
  defaultText: { 
    fontSize: FONTS.sizes.sm, 
    color: COLORS.text.primary 
  },
  checkboxSquare: { 
    width: 20, 
    height: 20, 
    borderRadius: 4, 
    borderWidth: 1.5, 
    borderColor: COLORS.gray[400], 
    justifyContent: 'center', 
    alignItems: 'center' 
  },
  checkboxSquareChecked: { 
    borderColor: COLORS.red, 
    backgroundColor: COLORS.red 
  },
  addressModalInput: { 
    borderWidth: 1, 
    borderColor: COLORS.gray[300], 
    borderRadius: BORDER_RADIUS.md, 
    paddingHorizontal: SPACING.sm, 
    paddingVertical: SPACING.sm, 
    fontSize: FONTS.sizes.sm, 
    color: COLORS.text.primary,
    marginBottom: SPACING.sm,
  },
  addressModalPhoneRow: { 
    flexDirection: 'row', 
    gap: SPACING.sm 
  },
  addressModalPhoneCode: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    borderWidth: 1, 
    borderColor: COLORS.gray[300], 
    borderRadius: BORDER_RADIUS.md, 
    paddingHorizontal: SPACING.sm, 
    paddingVertical: SPACING.sm, 
    gap: SPACING.xs, 
    minWidth: 110 
  },
  addressModalSaveButton: { 
    backgroundColor: COLORS.red, 
    borderRadius: BORDER_RADIUS.md, 
    paddingVertical: SPACING.md, 
    alignItems: 'center', 
    marginTop: SPACING.md, 
    marginBottom: SPACING.xl 
  },
  addressModalSaveButtonText: { 
    fontSize: FONTS.sizes.md, 
    fontWeight: '700', 
    color: COLORS.white 
  },
  addressSearchBtn: {
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: SPACING.xs,
    backgroundColor: COLORS.red, 
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md, 
    paddingVertical: SPACING.sm,
    alignSelf: 'flex-start', 
    marginBottom: SPACING.sm,
  },
  addressSearchBtnText: { 
    fontSize: FONTS.sizes.sm, 
    color: COLORS.white, 
    fontWeight: '600' 
  },
  kakaoModalOverlay: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.5)', 
    justifyContent: 'flex-end' 
  },
  kakaoModalContent: { 
    backgroundColor: COLORS.white, 
    borderTopLeftRadius: 20, 
    borderTopRightRadius: 20, 
    height: '80%' 
  },
  kakaoModalHeader: {
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center',
    padding: SPACING.md, 
    borderBottomWidth: 1, 
    borderBottomColor: COLORS.gray[200],
  },
  kakaoModalTitle: { 
    fontSize: FONTS.sizes.md, 
    fontWeight: '700', 
    color: COLORS.text.primary 
  },
  inquiryUnreadBadge: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: COLORS.red,
    borderRadius: 10,
    minWidth: 16,
    height: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  inquiryUnreadBadgeText: {
    fontSize: FONTS.sizes['2xs'],
    fontWeight: '700',
    color: COLORS.white,
  },
});

export default BuyListScreen;

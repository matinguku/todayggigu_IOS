import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Image,
  Alert,
  Modal,
  ActivityIndicator,
  InteractionManager,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, useFocusEffect, RouteProp } from '@react-navigation/native';
import Icon from '../../components/Icon';
import AddNewAddressModal from '../../components/AddNewAddressModal';
import DatePickerModal from '../../components/DatePickerModal';
import PastOrderModal from '../../components/PastOrderModal';
import { COLORS, FONTS, SPACING, BORDER_RADIUS } from '../../constants';
import {
  launchImageLibrary,
  MediaType,
  ImageLibraryOptions,
  ImagePickerResponse,
} from 'react-native-image-picker';
import { requestPhotoLibraryPermission } from '../../utils/permissions';
import { useTranslation } from '../../hooks/useTranslation';
import { openProductDetail } from '../../utils/openProductDetail';
import { useAuth } from '../../context/AuthContext';
import { useCreateOrderMutation } from '../../hooks/useCreateOrderMutation';
import {
  buildOrdersProxyCreateRequest,
  buildOrdersProxyLineItems,
  buildShippingAddressFromAddress,
  mapLocaleToOrdersLang,
  mergeOrderSourceItems,
  orderApi,
  OrdersProxyAddService,
  resolveCheckoutLineUnitPriceKRW,
  validateOrdersProxyLineItems,
} from '../../services/orderApi';
import {
  fetchCenterManageMeta,
  type CenterManageMeta,
} from '../../services/centerManageApi';
import {
  getApplicationCategories,
  getCustomsClearanceOptions,
  getInitialCenterManageSelections,
  getLogisticsCentersForBusiness,
  getTransportMethodsForBusiness,
  profileClearanceToMetaLabel,
  reconcileCenterManageSelections,
  type CenterManageSelections,
} from '../../utils/centerManageMeta';
import { cartApi, CartItem, MultiLang } from '../../services/cartApi';
import {
  getProfile,
  formatProfileAddressLabel,
} from '../../services/authApi';
import { formatPriceKRW } from '../../utils/i18nHelpers';
import { CartScreenParams, MainTabParamList } from '../../types';
import { fetchAdditionalServices } from '../../services/additionalServicesApi';
import { mapAdditionalServicesToCategories } from '../../utils/additionalServices';

interface ExtraService {
  id: string;
  name: string;
  icon?: string;
  iconUrl?: string;
  imageUrl?: string;
  price?: string;
  description?: string;
  required?: boolean;
}

interface ServiceCategory {
  id: string;
  required?: boolean;
  items: ExtraService[];
}

interface CartCard {
  /** API cart row id — used for delete/update calls. */
  id: string;
  /** Stable unique key for React lists (id can repeat across rows). */
  listKey: string;
  index: string;
  offerId: string;
  source: string;
  specId: string;
  skuId: string | number;
  companyName: string;
  productName: string;
  productImage: string | null;
  photoUri: string | null;
  color: string;
  size: string;
  quantity: number;
  unitPrice: number;
  checked: boolean;
  expanded: boolean;
  addedAt: number;
  remarks: string;
  /** UI-only: grouped as a set bundle (세트묶음) */
  bundleId?: string | null;
}

type TabKey = 'past' | 'bundles';

type CartSetBundleMeta = {
  id: string;
  collapsed: boolean;
};

type NegotiationImageEntry = {
  id: string;
  fileUri: string;
  fileName?: string;
  mimeType?: string;
};

const createNegotiationImageEntry = (asset: {
  uri: string;
  fileName?: string;
  type?: string;
}): NegotiationImageEntry => ({
  id: `neg-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  fileUri: asset.uri,
  fileName: asset.fileName,
  mimeType: asset.type,
});


// Pick the string for the active locale from a multi-language field, with fallbacks.
const pickLang = (
  value: string | MultiLang | undefined,
  locale: string,
): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value[locale as keyof MultiLang] || value.en || value.ko || value.zh || '';
};

// Map an API CartItem into the screen's local CartCard shape.
const mapCartItemToCard = (
  item: CartItem,
  index: number,
  locale: string,
): CartCard => {
  const attrs = item.skuInfo?.skuAttributes || [];
  const colorAttr = attrs[0];
  const sizeAttr = attrs[1];
  // Prefer the discounted fenxiao offer price, fall back to sku price.
  const rawPrice =
    item.skuInfo?.fenxiaoPriceInfo?.offerPrice ||
    item.skuInfo?.price ||
    item.skuInfo?.consignPrice ||
    '0';
  const offerId = String(item.offerId ?? (item as { productId?: string | number }).productId ?? '');
  const specId = String(item.skuInfo?.specId ?? '');
  const skuId = String(item.skuInfo?.skuId ?? '');
  const apiId =
    item._id ||
    [offerId, specId, skuId].filter(Boolean).join(':') ||
    offerId;
  return {
    id: apiId,
    listKey: `${apiId}::${index}`,
    index: String(index + 1).padStart(3, '0'),
    offerId,
    source: item.source || '1688',
    specId,
    skuId: item.skuInfo?.skuId ?? '',
    companyName: pickLang(item.companyName, locale),
    productName:
      pickLang(item.subjectMultiLang, locale) ||
      item.subjectTrans ||
      item.subject ||
      '',
    productImage: item.imageUrl || null,
    photoUri: null,
    color: colorAttr ? pickLang(colorAttr.valueMultiLang, locale) || colorAttr.valueTrans || colorAttr.value : '',
    size: sizeAttr ? pickLang(sizeAttr.valueMultiLang, locale) || sizeAttr.valueTrans || sizeAttr.value : '',
    quantity: item.quantity || 1,
    unitPrice: parseFloat(rawPrice) || 0,
    checked: false,
    expanded: false,
    addedAt: item.addedAt ? new Date(item.addedAt).getTime() : Date.now(),
    remarks: '',
    bundleId: null,
  };
};

type ProfileAddress = {
  _id: string;
  recipient?: string;
  mainAddress?: string;
  detailedAddress?: string;
  zipCode?: string;
  contact?: string;
  defaultAddress?: boolean;
  customerClearanceType?: string;
  customMethod?: string;
};

const isProfileAddressBusiness = (addr: ProfileAddress): boolean =>
  addr.customerClearanceType === 'business' || addr.customMethod === 'business';

/** Matches center-manage meta 통관방식 labels (사업자 / 개인). */
const isCustomsClearanceBusiness = (customsClearance: string): boolean => {
  const v = customsClearance.trim();
  if (v === '사업자' || v === 'Business' || v === '企业') return true;
  if (v === '개인' || v === 'Personal' || v === '个人') return false;
  return /business|사업|회사|enterprise/i.test(v);
};

const filterAddressesByCustoms = (
  addresses: ProfileAddress[],
  customsClearance: string,
): ProfileAddress[] =>
  addresses.filter(
    (addr) => isProfileAddressBusiness(addr) === isCustomsClearanceBusiness(customsClearance),
  );

const pickPreferredAddress = (
  addresses: ProfileAddress[],
  preferredId?: string | null,
): ProfileAddress | null => {
  if (addresses.length === 0) return null;
  if (preferredId) {
    const current = addresses.find((a) => a._id === preferredId);
    if (current) return current;
  }
  return addresses.find((a) => a.defaultAddress) || addresses[0];
};

// Map language codes to flag emojis (mirrors ProfileScreen / HomeScreen).
const getCartLanguageFlag = (locale: string): string => {
  const flags: { [key: string]: string } = {
    en: '🇺🇸',
    ko: '🇰🇷',
    zh: '🇨🇳',
  };
  return flags[locale] || '🇺🇸';
};

type CartScreenProps = {
  embedded?: boolean;
};

const CartScreen: React.FC<CartScreenProps> = ({ embedded = false }) => {
  const { t, locale } = useTranslation();
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<MainTabParamList, 'Cart'>>();
  const { isGuest, isAuthenticated } = useAuth();

  const navigateToProductDetail = useCallback(
    (card: CartCard) => {
      const productId = card.offerId || card.id;
      if (!productId) {
        return;
      }
      // Forward the cart row's image so ProductDetailScreen's hero slot
      // paints instantly with the same picture the user tapped.
      openProductDetail(navigation, {
        productId,
        offerId: productId,
        source: card.source || '1688',
        country: locale,
        thumbnailUrl: card.productImage || card.photoUri || undefined,
      });
    },
    [locale, navigation],
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [showPeriodMenu, setShowPeriodMenu] = useState(false);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('past');
  const [showPastOrderModal, setShowPastOrderModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [extraServices, setExtraServices] = useState<ExtraService[]>([]);
  const [pendingServices, setPendingServices] = useState<ExtraService[]>([]);
  const [serviceCategories, setServiceCategories] = useState<ServiceCategory[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [detailService, setDetailService] = useState<ExtraService | null>(null);
  const [otherRequests, setOtherRequests] = useState('');
  const [modalPhotoUri, setModalPhotoUri] = useState<string | null>(null);

  // Label modal state
  const [labelModalCardId, setLabelModalCardId] = useState<string | null>(null);
  const [labelType, setLabelType] = useState<'product' | 'foodInspect'>('product');
  const [labelFormat, setLabelFormat] = useState<'50x80' | '40x60'>('50x80');
  const [labelProductName, setLabelProductName] = useState('제품명 : 자석 선반 대형 2P');
  const [labelContent, setLabelContent] = useState(
    '수입원 : 빅멀티샵\n제조원 : 빅멀티샵 협력사\n제조일자 : 2025.12\n원산지 : 중국\n내용량 : 단품\n재질 : 탄소강',
  );
  const [labelBarcode, setLabelBarcode] = useState('S123456789');
  const [labelFileUri, setLabelFileUri] = useState<string | null>(null);

  // Order modal state
  const [showOrderModal, setShowOrderModal] = useState(false);
  // iOS 는 모달 위에 모달이 안 뜨므로, 배송지/라벨 모달을 열 땐 발주정보 모달을
  // 먼저 닫고 그 모달을 연 뒤, 닫히면 발주정보 모달을 다시 연다. 이 플래그가 '다시 열기' 여부.
  const [reopenOrderModal, setReopenOrderModal] = useState(false);
  const reopenOrderModalIfNeeded = useCallback(() => {
    setReopenOrderModal((should) => {
      if (should) setTimeout(() => setShowOrderModal(true), 350);
      return false;
    });
  }, []);
  const [negotiationContentImages, setNegotiationContentImages] = useState<
    NegotiationImageEntry[]
  >([]);
  const [negotiationNote, setNegotiationNote] = useState('');
  // Per-card data captured INSIDE the order-info modal for the
  // multi-item case. Keyed by cart card id so each product can carry
  // its own extra-services / negotiation note / negotiation images.
  // Empty when the modal is opened with a single selected card (the
  // existing top-level state handles that case for backwards compat).
  const [cardExtraServices, setCardExtraServices] = useState<Record<string, ExtraService[]>>({});
  const [cardNegotiationNote, setCardNegotiationNote] = useState<Record<string, string>>({});
  // 카드의 옵션 드롭다운 펼침 상태 — 카드별로 독립.
  // 사용자가 옵션명(예: "흰색 양말 남성용...") 을 탭하면 해당 카드의 상세
  // (상품명 전체 / 옵션 풀텍스트 / spec 라인들) 가 펼쳐서 표시됨.
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());
  const toggleCardExpanded = useCallback((cardId: string) => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);
  const [cardNegotiationImages, setCardNegotiationImages] = useState<
    Record<string, NegotiationImageEntry[]>
  >({});
  // Which card the (shared) "select extra services" modal is currently
  // editing. `null` means it edits the order-wide `extraServices`
  // (single-card legacy path).
  const [activeServiceCardId, setActiveServiceCardId] = useState<string | null>(null);
  // Card id whose negotiation-image gallery modal is currently open
  // (tap on the "협상내역" label opens the viewer). `null` = closed.
  const [negotiationGalleryCardId, setNegotiationGalleryCardId] = useState<string | null>(null);
  const [showAddNewAddressModal, setShowAddNewAddressModal] = useState(false);
  const [purchasePayment, setPurchasePayment] = useState<'manual' | 'auto'>('manual');
  const [shippingPayment, setShippingPayment] = useState<'manual' | 'auto'>('manual');
  const [showPaymentTooltip, setShowPaymentTooltip] = useState(false);
  const [centerMeta, setCenterMeta] = useState<CenterManageMeta | null>(null);
  const [centerMetaLoading, setCenterMetaLoading] = useState(false);
  const [basicInfoSelections, setBasicInfoSelections] = useState<CenterManageSelections>({
    businessType: '구매대행',
    logisticsCenter: '위해',
    transportMethod: '해운배송',
    applicationCategory: '',
    customsClearance: '사업자',
  });
  const [profileAddresses, setProfileAddresses] = useState<ProfileAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  // 발주모달 내 배송주소 선택 오버레이 표시 여부 (모달 위 모달이 안 떠서 오버레이로 구현).
  const [showAddressSelect, setShowAddressSelect] = useState(false);
  const [depositBalance, setDepositBalance] = useState(0);
  const [profileLoading, setProfileLoading] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  /** Product-detail Buy Now: open order modal after cart item is selected */
  const pendingBuyNowOrderRef = useRef(false);
  const buyNowOrderModalOpenedRef = useRef(false);
  /** setParams after Buy Now retriggers useFocusEffect — skip one loadCart that would clear selection */
  const skipLoadCartOnceRef = useRef(false);

  const { mutate: createOrder, isLoading: isSubmittingOrder } = useCreateOrderMutation({
    onSuccess: () => {
      setShowOrderModal(false);
      Alert.alert(
        t('cartOrder.alerts.notice'),
        t('cartOrder.orderModal.orderSubmitSuccess'),
        [
          {
            text: t('cartOrder.alerts.confirm'),
            onPress: () => {
              loadCart();
              navigation.navigate('BuyList' as never);
            },
          },
        ],
      );
    },
    onError: (error) => {
      Alert.alert(t('cartOrder.alerts.error'), error || t('cartOrder.orderModal.orderSubmitFailed'));
    },
  });

  const catKey = (id: string) => id.replace(/^cat-/, '');
  const tCategoryTitle = (id: string) => t(`cartOrder.serviceModal.categories.${catKey(id)}`);

  const loadAdditionalServices = useCallback(async () => {
    setServicesLoading(true);
    setServicesError(null);
    const res = await fetchAdditionalServices();
    setServicesLoading(false);
    if (!res.success || !res.data) {
      setServicesError(res.message || t('cartOrder.serviceModal.loadFailed'));
      return;
    }
    const categories = mapAdditionalServicesToCategories(
      res.data,
      locale,
      t('cartOrder.serviceModal.quote'),
    );
    setServiceCategories(categories);
    const allItems = categories.flatMap((c) => c.items);
    setDetailService((prev) => {
      if (prev) {
        const match = allItems.find((s) => s.id === prev.id);
        if (match) return match;
      }
      return allItems[0] ?? null;
    });
    setPendingServices((prev) =>
      prev
        .map((p) => allItems.find((s) => s.id === p.id))
        .filter((s): s is ExtraService => !!s),
    );
  }, [locale, t]);

  const [cards, setCards] = useState<CartCard[]>([]);
  const [setBundles, setSetBundles] = useState<CartSetBundleMeta[]>([]);
  const [cartLoading, setCartLoading] = useState(true);
  // pull-to-refresh 전용 상태. cartLoading 과 분리해 본문이 초기 로딩 스피너로
  // 가려지지 않고, 상단에 표준 RefreshControl 인디케이터만 잠깐 보이게 한다.
  const [cartRefreshing, setCartRefreshing] = useState(false);
  const [cartError, setCartError] = useState<string | null>(null);

  useEffect(() => {
    if (showOrderModal) {
      setNegotiationContentImages([]);
      setNegotiationNote('');
      // Per-card data is also wiped each time the modal opens so the
      // shopper starts with a clean state on each new order attempt.
      setCardExtraServices({});
      setCardNegotiationNote({});
      setCardNegotiationImages({});
      setActiveServiceCardId(null);
    }
  }, [showOrderModal]);

  // Fetch the cart from the API and map items into local CartCard shape.
  const loadCart = useCallback(async () => {
    setCartLoading(true);
    setCartError(null);
    if (isGuest || !isAuthenticated) {
      setCards([]);
      setCartLoading(false);
      return;
    }
    try {
      const res = await cartApi.getCart(locale);
      if (res.success && res.data?.cart) {
        const items = res.data.cart.items || [];
        setCards((prev) =>
          items.map((item, idx) => {
            const mapped = mapCartItemToCard(item, idx, locale);
            // Preserve UI-only state (checked / expanded / photo / remarks) across refetches.
            const existing = prev.find((c) => c.id === mapped.id);
            return existing
              ? {
                  ...mapped,
                  checked: existing.checked,
                  expanded: existing.expanded,
                  photoUri: existing.photoUri,
                  remarks: existing.remarks,
                  bundleId: existing.bundleId ?? null,
                }
              : mapped;
          }),
        );
      } else {
        setCards([]);
        const isAuthError =
          res.message?.toLowerCase().includes('authentication') ||
          res.message?.toLowerCase().includes('unauthorized');
        setCartError(isAuthError ? t('cart.loginPrompt') : res.message || 'Failed to load cart');
      }
    } catch (e: any) {
      setCards([]);
      const status = e?.response?.status;
      const isAuthError = status === 401;
      setCartError(isAuthError ? t('cart.loginPrompt') : e?.message || 'Failed to load cart');
    } finally {
      setCartLoading(false);
    }
    // `t` is intentionally excluded — useTranslation returns a new `t` each render,
    // including it here would re-create loadCart every render and loop the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, isGuest, isAuthenticated]);

  // pull-to-refresh — 본문 ScrollView 가 더 이상 위로 못 갈 때 한 번 더 당기면
  // loadCart 를 다시 호출해 장바구니 자료를 새로 받아온다. 초기 로딩 스피너
  // (cartLoading) 와는 별도로 RefreshControl 의 상단 인디케이터만 잠깐 보인다.
  const onCartRefresh = useCallback(async () => {
    setCartRefreshing(true);
    try {
      await loadCart();
    } finally {
      setCartRefreshing(false);
    }
  }, [loadCart]);

  const applyCartFromBuyNowResponse = useCallback(
    (
      cartResponse: CartScreenParams['cartResponse'],
      selectCartItemId?: string,
      offerId?: string,
      openOrderModal = true,
    ) => {
      const items = (cartResponse?.cart?.items || []) as CartItem[];
      const mappedCards = items.map((item, idx) => {
        const mapped = mapCartItemToCard(item, idx, locale);
        const matchesId =
          selectCartItemId &&
          (mapped.id === selectCartItemId ||
            item._id === selectCartItemId);
        const matchesOffer =
          offerId && item.offerId?.toString() === offerId.toString();
        return {
          ...mapped,
          checked: Boolean(matchesId || matchesOffer),
        };
      });

      if (openOrderModal && !mappedCards.some((c) => c.checked) && mappedCards.length > 0) {
        mappedCards[mappedCards.length - 1].checked = true;
      }

      setCards(mappedCards);
      setCartError(null);
      setCartLoading(false);
      if (openOrderModal) {
        pendingBuyNowOrderRef.current = true;
        buyNowOrderModalOpenedRef.current = false;
      }
    },
    [locale],
  );

  useFocusEffect(
    useCallback(() => {
      const params = route.params;
      if (params?.fromBuyNow && params?.cartResponse) {
        applyCartFromBuyNowResponse(
          params.cartResponse,
          params.selectCartItemId,
          params.offerId,
          params.openOrderModal !== false,
        );
        skipLoadCartOnceRef.current = true;
        navigation.setParams({
          fromBuyNow: undefined,
          openOrderModal: undefined,
          cartResponse: undefined,
          selectCartItemId: undefined,
          offerId: undefined,
        });
        return;
      }
      if (skipLoadCartOnceRef.current) {
        skipLoadCartOnceRef.current = false;
        return;
      }
      loadCart();
    }, [applyCartFromBuyNowResponse, loadCart, navigation, route.params]),
  );

  // Format a Date as YYYY-MM-DD for the period range buttons.
  const formatDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Defer Alert.alert past the current render frame so it reliably attaches to the
  // Android Activity (fixes "Tried to show an alert while not attached to an Activity").
  const showAlert = (
    title: string,
    message: string,
    buttons?: Parameters<typeof Alert.alert>[2],
  ) => {
    requestAnimationFrame(() => {
      Alert.alert(title, message, buttons);
    });
  };

  const handleDeleteChecked = () => {
    const checkedIds = cards.filter((c) => c.checked).map((c) => c.id);
    if (checkedIds.length === 0) {
      showAlert(t('cartOrder.alerts.notice'), t('cartOrder.alerts.noItemsSelected'));
      return;
    }
    showAlert(t('cartOrder.alerts.confirm'), t('cartOrder.alerts.deletePrompt'), [
      { text: t('cartOrder.alerts.cancel'), style: 'cancel' },
      {
        text: t('cartOrder.alerts.delete'),
        style: 'destructive',
        onPress: async () => {
          const prev = cards;
          const next = cards.filter((x) => !x.checked);
          setCards(next);
          pruneEmptyBundles(next);
          const res = await cartApi.deleteCartBatch(checkedIds);
          if (!res.success) {
            setCards(prev);
            pruneEmptyBundles(prev);
            showAlert(t('cartOrder.alerts.notice'), res.message || 'Failed to delete items');
          }
        },
      },
    ]);
  };

  const handleDeleteOne = async (id: string) => {
    const prev = cards;
    const next = cards.filter((x) => x.id !== id);
    setCards(next);
    pruneEmptyBundles(next);
    const res = await cartApi.deleteCartItem(id);
    if (!res.success) {
      setCards(prev);
      pruneEmptyBundles(prev);
      showAlert(t('cartOrder.alerts.notice'), res.message || 'Failed to delete item');
    }
  };

  const toggleCheck = (id: string) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, checked: !c.checked } : c)));
  };

  // `openServiceModal(cardId)` opens the extra-service picker scoped
  // to a specific cart card. When `cardId` is null the picker edits
  // the order-wide `extraServices` array (single-card legacy path).
  const openServiceModal = useCallback(
    (cardId: string | null = null) => {
      setActiveServiceCardId(cardId);
      const seed = cardId
        ? cardExtraServices[cardId] || []
        : extraServices;
      setPendingServices(seed);
      setShowServiceModal(true);
      void loadAdditionalServices();
    },
    [cardExtraServices, extraServices, loadAdditionalServices],
  );

  const closeServiceModal = () => {
    setShowServiceModal(false);
    setActiveServiceCardId(null);
  };

  const confirmServiceModal = () => {
    if (activeServiceCardId) {
      // Save into the per-card map; the multi-card UI reads from this.
      setCardExtraServices((prev) => ({
        ...prev,
        [activeServiceCardId]: pendingServices,
      }));
    } else {
      // Legacy: order-wide single list.
      setExtraServices(pendingServices);
    }
    setShowServiceModal(false);
    setActiveServiceCardId(null);
  };

  const togglePendingService = (svc: ExtraService) => {
    setDetailService(svc);
    setPendingServices((prev) => {
      const exists = prev.some((s) => s.id === svc.id);
      return exists ? prev.filter((s) => s.id !== svc.id) : [...prev, svc];
    });
  };

  const openLabelModal = (cardId: string) => {
    // 발주모달 닫고(슬라이드 종료 후) 라벨 모달 연다. 닫히면 발주모달 재오픈.
    setReopenOrderModal(true);
    setShowOrderModal(false);
    setTimeout(() => setLabelModalCardId(cardId), 350);
  };

  const closeLabelModal = () => {
    setLabelModalCardId(null);
    reopenOrderModalIfNeeded();
  };

  const saveLabel = () => {
    setLabelModalCardId(null);
    reopenOrderModalIfNeeded();
  };

  const pickLabelFile = async () => {
    try {
      const granted = await requestPhotoLibraryPermission();
      if (!granted) {
        Alert.alert(t('cartOrder.alerts.permission'), t('cartOrder.alerts.photoPermission'));
        return;
      }
      const options: ImageLibraryOptions = { mediaType: 'photo' as MediaType, quality: 0.7 };
      launchImageLibrary(options, (res: ImagePickerResponse) => {
        if (res.didCancel || res.errorCode) return;
        const uri = res.assets?.[0]?.uri;
        if (uri) setLabelFileUri(uri);
      });
    } catch {
      Alert.alert(t('cartOrder.alerts.error'), t('cartOrder.alerts.galleryFailed'));
    }
  };

  const pickModalPhoto = async () => {
    try {
      const granted = await requestPhotoLibraryPermission();
      if (!granted) {
        Alert.alert(t('cartOrder.alerts.permission'), t('cartOrder.alerts.photoPermission'));
        return;
      }
      const options: ImageLibraryOptions = { mediaType: 'photo' as MediaType, quality: 0.7 };
      launchImageLibrary(options, (res: ImagePickerResponse) => {
        if (res.didCancel || res.errorCode) return;
        const uri = res.assets?.[0]?.uri;
        if (uri) setModalPhotoUri(uri);
      });
    } catch {
      Alert.alert(t('cartOrder.alerts.error'), t('cartOrder.alerts.galleryFailed'));
    }
  };

  const changeQty = async (id: string, delta: number) => {
    const target = cards.find((c) => c.id === id);
    if (!target) return;
    const nextQty = Math.max(1, target.quantity + delta);
    if (nextQty === target.quantity) return;
    const prev = cards;
    setCards((c) =>
      c.map((x) => (x.id === id ? { ...x, quantity: nextQty } : x)),
    ); // optimistic
    const res = await cartApi.updateCartItem(id, nextQty);
    if (!res.success) {
      setCards(prev); // revert
      Alert.alert(t('cartOrder.alerts.notice'), res.message || 'Failed to update quantity');
    }
  };

  // 수량을 임의 값으로 직접 타입했을 때 사용. 화면 입력 중 자유롭게 편집할 수
  // 있도록 텍스트 값을 그대로 받아 정수만 골라낸 뒤 1 미만은 1 로 보정한다.
  // 빈 문자열은 일시적으로 0 으로 두지 않고 1 로 처리해 백엔드 동기화 시
  // updateCartItem 이 잘못된 0 수량을 받는 사태를 방지.
  const updateQty = async (id: string, text: string) => {
    const target = cards.find((c) => c.id === id);
    if (!target) return;
    const clean = text.replace(/[^0-9]/g, '');
    const parsed = clean ? parseInt(clean, 10) : 1;
    const nextQty = Math.max(1, isNaN(parsed) ? 1 : parsed);
    if (nextQty === target.quantity) return;
    const prev = cards;
    setCards((c) =>
      c.map((x) => (x.id === id ? { ...x, quantity: nextQty } : x)),
    );
    const res = await cartApi.updateCartItem(id, nextQty);
    if (!res.success) {
      setCards(prev);
      Alert.alert(t('cartOrder.alerts.notice'), res.message || 'Failed to update quantity');
    }
  };

  const updateUnitPrice = (id: string, text: string) => {
    const clean = text.replace(/[^0-9.]/g, '');
    const value = clean ? parseFloat(clean) : 0;
    setCards((prev) =>
      prev.map((c) => (c.id === id ? { ...c, unitPrice: isNaN(value) ? 0 : value } : c)),
    );
  };

  const pickPhoto = async (id: string) => {
    try {
      const granted = await requestPhotoLibraryPermission();
      if (!granted) {
        Alert.alert(t('cartOrder.alerts.permission'), t('cartOrder.alerts.photoPermission'));
        return;
      }
      const options: ImageLibraryOptions = { mediaType: 'photo' as MediaType, quality: 0.7 };
      launchImageLibrary(options, (res: ImagePickerResponse) => {
        if (res.didCancel || res.errorCode) return;
        const uri = res.assets?.[0]?.uri;
        if (uri) {
          setCards((prev) => prev.map((c) => (c.id === id ? { ...c, photoUri: uri } : c)));
        }
      });
    } catch {
      Alert.alert(t('cartOrder.alerts.error'), t('cartOrder.alerts.galleryFailed'));
    }
  };

  const toggleExtraService = (svc: ExtraService) => {
    setExtraServices((prev) => {
      const exists = prev.some((s) => s.id === svc.id);
      return exists ? prev.filter((s) => s.id !== svc.id) : [...prev, svc];
    });
  };

  /**
   * Per-card row inside the order-info modal when MORE THAN ONE cart
   * card has been selected. Layout (per the user's spec):
   *   ┌────────────────────────────────────────────────────────────┐
   *   │ [img]  product name / options              │ negotiation   │
   *   │                                            │  (top-right)  │
   *   │                                            ├───────────────┤
   *   │                                            │ remarks input │
   *   ├─────── center: extra-service selector ─────────────────────┤
   *   └────────────────────────────────────────────────────────────┘
   * The extra-service section shows the "select" button until any
   * service is picked — after that it shows only the chips (no label),
   * matching the user's request.
   */
  const renderOrderModalCard = (card: CartCard) => {
    const cardSvcs = cardExtraServices[card.id] || [];
    const cardImages = cardNegotiationImages[card.id] || [];
    const hasSvc = cardSvcs.length > 0;
    const optionParts = [
      card.color ? card.color : '',
      card.size ? card.size : '',
    ].filter(Boolean);
    return (
      <View key={`order-card-${card.listKey}`} style={styles.orderModalCard}>
        {/* Top row: left = image + name + options, right = negotiation */}
        <View style={styles.orderModalCardTop}>
          <View style={styles.orderModalCardLeft}>
            {card.productImage ? (
              <Image
                source={{ uri: card.productImage }}
                style={styles.orderModalCardImage}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.orderModalCardImage, styles.orderModalCardImagePlaceholder]} />
            )}
            <View style={styles.orderModalCardInfo}>
              <Text style={styles.orderModalCardName} numberOfLines={2}>
                {card.productName}
              </Text>
              {optionParts.length > 0 ? (
                <Text style={styles.orderModalCardOption} numberOfLines={1}>
                  {optionParts.join(' / ')}
                </Text>
              ) : null}
              <Text style={styles.orderModalCardQty}>
                × {card.quantity}
              </Text>
            </View>
          </View>
          <View style={styles.orderModalCardRight}>
            {/* Negotiation header row: label right-aligned with a "+"
                button next to it. Tapping the LABEL opens the gallery
                modal showing all images added so far for THIS card.
                Tapping the "+" picks a new image via the gallery. */}
            <View style={styles.orderModalCardNegHeader}>
              <TouchableOpacity
                onPress={() => {
                  if (cardImages.length > 0) {
                    setNegotiationGalleryCardId(card.id);
                  }
                }}
                activeOpacity={cardImages.length > 0 ? 0.7 : 1}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Text
                  style={[
                    styles.orderModalCardSectionLabel,
                    styles.orderModalCardNegLabel,
                    cardImages.length > 0 && styles.orderModalCardNegLabelClickable,
                  ]}
                >
                  {t('cartOrder.orderModal.negotiationHistory')}
                  {cardImages.length > 0 ? ` (${cardImages.length})` : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.orderModalCardNegAddBtn}
                onPress={() => pickCardNegotiationAttachment(card.id)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={t('cartOrder.orderModal.negotiationAddAttachment')}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Icon name="add" size={16} color={PRIMARY} />
              </TouchableOpacity>
            </View>
            {/* 비고 TextInput 자리에 수량 stepper + 단가 입력 + 총가격 행을 배치.
                수량은 [−]/[+] 단추 또는 카드의 `quantity` state 직접 변경,
                단가는 ¥ 마크 + 숫자 입력으로 타입 변경.
                오른쪽 끝에는 quantity × unitPrice 의 총가격을 표시한다. */}
            <View style={styles.orderModalCardPriceRow}>
              <View style={styles.orderModalCardQtyControl}>
                <TouchableOpacity
                  style={styles.orderModalCardQtyBtn}
                  onPress={() => changeQty(card.id, -1)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Icon name="remove" size={12} color={COLORS.white} />
                </TouchableOpacity>
                <TextInput
                  style={styles.orderModalCardQtyValue}
                  value={String(card.quantity)}
                  onChangeText={(text) => updateQty(card.id, text)}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />

                <TouchableOpacity
                  style={styles.orderModalCardQtyBtn}
                  onPress={() => changeQty(card.id, 1)}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  <Icon name="add" size={12} color={COLORS.white} />
                </TouchableOpacity>
              </View>
              <View style={styles.orderModalCardUnitPriceBox}>
                <Text style={styles.orderModalCardYenMark}>¥</Text>
                <TextInput
                  style={styles.orderModalCardUnitPriceInput}
                  value={String(card.unitPrice)}
                  onChangeText={(text) => updateUnitPrice(card.id, text)}
                  keyboardType="decimal-pad"
                  selectTextOnFocus
                />
              </View>
              <Text style={styles.orderModalCardTotalPrice} numberOfLines={1}>
                ¥{(card.quantity * card.unitPrice).toFixed(2)}
              </Text>
            </View>
          </View>
        </View>

        {/* 라벨 / 삭제 — 카트 본문 카드와 동일하게 항상 표시 */}
        <View style={styles.orderModalCardExpanded}>
          <View style={styles.bottomActionsCompact}>
            <TouchableOpacity
              style={styles.labelRowBtn}
              onPress={() => openLabelModal(card.id)}
            >
              <Text style={styles.labelRowText}>{t('cartOrder.card.label')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.deleteRowBtn}
              onPress={() => handleDeleteOne(card.id)}
            >
              <Icon name="trash-outline" size={12} color={COLORS.primary} />
              <Text style={styles.deleteRowText}>{t('cartOrder.card.delete')}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Center: extra-service selector. Label hidden once chips exist. */}
        <View style={styles.orderModalCardServiceBar}>
          {hasSvc ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.extraChipsContent}
              style={styles.extraChipsScroll}
            >
              {cardSvcs.map((s) => (
                <View key={s.id} style={styles.extraChip}>
                  <Text style={styles.extraChipText}>{s.name}</Text>
                  <TouchableOpacity
                    onPress={() =>
                      setCardExtraServices((prev) => ({
                        ...prev,
                        [card.id]: (prev[card.id] || []).filter((x) => x.id !== s.id),
                      }))
                    }
                  >
                    <Icon name="close" size={10} color={COLORS.primary} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity
                style={styles.extraSelectBtn}
                onPress={() => openServiceModal(card.id)}
              >
                <Icon name="add" size={12} color={COLORS.white} />
              </TouchableOpacity>
            </ScrollView>
          ) : (
            <TouchableOpacity
              style={styles.orderModalCardServicePicker}
              onPress={() => openServiceModal(card.id)}
              activeOpacity={0.85}
            >
              <Icon name="add" size={14} color={PRIMARY} />
              <Text style={styles.orderModalCardServicePickerText}>
                {t('cartOrder.extraServiceBar.title')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const renderExtraServiceBar = () => (
    <View style={[styles.extraBar, styles.extraBarInOrderModal]}>
      <Text style={styles.extraLabel}>{t('cartOrder.extraServiceBar.title')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.extraChipsScroll}
        contentContainerStyle={styles.extraChipsContent}
      >
        {extraServices.length === 0 ? (
          <Text style={styles.extraPlaceholder}>{t('cartOrder.extraServiceBar.placeholder')}</Text>
        ) : (
          extraServices.map((s) => (
            <View key={s.id} style={styles.extraChip}>
              <Text style={styles.extraChipText}>{s.name}</Text>
              <TouchableOpacity onPress={() => toggleExtraService(s)}>
                <Icon name="close" size={10} color={COLORS.primary} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
      <TouchableOpacity style={styles.extraSelectBtn} onPress={() => openServiceModal(null)}>
        <Icon name="add" size={12} color={COLORS.white} />
        <Text style={styles.extraSelectBtnText}>{t('cartOrder.extraServiceBar.selectBtn')}</Text>
      </TouchableOpacity>
    </View>
  );

  const filteredCards = cards.filter((c) => {
    if (searchQuery && !c.productName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      if (c.addedAt < start.getTime()) return false;
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      if (c.addedAt > end.getTime()) return false;
    }
    return true;
  });

  const pruneEmptyBundles = useCallback((nextCards: CartCard[]) => {
    const activeBundleIds = new Set(
      nextCards.map((c) => c.bundleId).filter((id): id is string => Boolean(id)),
    );
    setSetBundles((prev) => prev.filter((b) => activeBundleIds.has(b.id)));
  }, []);

  const unbundledCards = useMemo(
    () => filteredCards.filter((c) => !c.bundleId),
    [filteredCards],
  );

  const bundledCards = useMemo(
    () => filteredCards.filter((c) => c.bundleId),
    [filteredCards],
  );

  const orderedSetBundles = useMemo(() => {
    const idsInCards = [...new Set(bundledCards.map((c) => c.bundleId!))];
    const orderedIds = [
      ...setBundles.map((b) => b.id).filter((id) => idsInCards.includes(id)),
      ...idsInCards.filter((id) => !setBundles.some((b) => b.id === id)),
    ];
    return orderedIds.map((id, index) => {
      const meta = setBundles.find((b) => b.id === id);
      const items = bundledCards.filter((c) => c.bundleId === id);
      return {
        id,
        index: index + 1,
        collapsed: meta?.collapsed ?? false,
        items,
        totalQty: items.reduce((s, c) => s + c.quantity, 0),
        totalAmount: items.reduce((s, c) => s + c.quantity * c.unitPrice, 0),
        allChecked: items.length > 0 && items.every((c) => c.checked),
      };
    });
  }, [bundledCards, setBundles]);

  const handleBundlesTabPress = useCallback(() => {
    const eligible = cards.filter((c) => c.checked && !c.bundleId);
    if (eligible.length >= 2) {
      const bundleId = `set-${Date.now()}`;
      const selectedIds = new Set(eligible.map((c) => c.id));
      setCards((prev) =>
        prev.map((c) =>
          selectedIds.has(c.id) ? { ...c, bundleId, checked: true } : c,
        ),
      );
      setSetBundles((prev) => [...prev, { id: bundleId, collapsed: false }]);
      setActiveTab('bundles');
      return;
    }
    setActiveTab('bundles');
    if (orderedSetBundles.length === 0) {
      showAlert(t('cartOrder.alerts.notice'), t('cartOrder.bundles.needTwoItems'));
    }
  }, [cards, orderedSetBundles.length, t]);

  const toggleBundleCollapse = useCallback((bundleId: string) => {
    setSetBundles((prev) => {
      const exists = prev.find((b) => b.id === bundleId);
      if (exists) {
        return prev.map((b) =>
          b.id === bundleId ? { ...b, collapsed: !b.collapsed } : b,
        );
      }
      return [...prev, { id: bundleId, collapsed: true }];
    });
  }, []);

  const toggleBundleCheck = useCallback((bundleId: string) => {
    setCards((prev) => {
      const items = prev.filter((c) => c.bundleId === bundleId);
      const allChecked = items.length > 0 && items.every((c) => c.checked);
      return prev.map((c) =>
        c.bundleId === bundleId ? { ...c, checked: !allChecked } : c,
      );
    });
  }, []);

  const totalQty = filteredCards.reduce((s, c) => s + c.quantity, 0);
  const grandTotal = filteredCards.reduce((s, c) => s + c.quantity * c.unitPrice, 0);
  const checkedCards = cards.filter((c) => c.checked);
  const hasSelectedCards = checkedCards.length > 0;
  const allCardsSelected = cards.length > 0 && cards.every((c) => c.checked);
  const checkedQty = checkedCards.reduce((s, c) => s + c.quantity, 0);
  const checkedTotal = checkedCards.reduce((s, c) => s + c.quantity * c.unitPrice, 0);
  const isOrderNowEnabled = hasSelectedCards && !profileLoading;

  const toggleSelectAll = useCallback(() => {
    if (cards.length === 0) return;
    const nextChecked = !allCardsSelected;
    setCards((prev) => prev.map((c) => ({ ...c, checked: nextChecked })));
  }, [allCardsSelected, cards.length]);

  const showOrderModalRef = useRef(showOrderModal);
  showOrderModalRef.current = showOrderModal;

  const orderProfileRefreshInFlightRef = useRef(false);

  const applyProfileFromApi = useCallback(
    (apiUser: Record<string, any>) => {
      const addresses: ProfileAddress[] = (apiUser.addresses || []).map((addr: any) => ({
        _id: addr._id || addr.id || '',
        recipient: addr.recipient,
        mainAddress: addr.mainAddress,
        detailedAddress: addr.detailedAddress,
        zipCode: addr.zipCode,
        contact: addr.contact,
        defaultAddress: addr.defaultAddress,
        customerClearanceType: addr.customerClearanceType || addr.customMethod,
        customMethod: addr.customMethod || addr.customerClearanceType,
      }));

      setProfileAddresses(addresses);
      setDepositBalance(apiUser.depositBalance ?? 0);

      setBasicInfoSelections((prev) => {
        const matching = filterAddressesByCustoms(addresses, prev.customsClearance);
        const preferred = pickPreferredAddress(matching);
        setSelectedAddressId(preferred?._id ?? null);
        return prev;
      });
      // Order modal uses local state only — avoid updateUser() here to prevent
      // auth/socket/focus-effect loops from repeated profile refetches.
    },
    [],
  );

  const addressesForCustoms = useMemo(
    () => filterAddressesByCustoms(profileAddresses, basicInfoSelections.customsClearance),
    [profileAddresses, basicInfoSelections.customsClearance],
  );

  const deliveryAddressLabel = useMemo(() => {
    const addr = pickPreferredAddress(addressesForCustoms, selectedAddressId);
    return addr ? formatProfileAddressLabel(addr) : '';
  }, [addressesForCustoms, selectedAddressId]);

  useEffect(() => {
    if (!showOrderModal) return;
    const preferred = pickPreferredAddress(addressesForCustoms, selectedAddressId);
    const nextId = preferred?._id ?? null;
    if (nextId !== selectedAddressId) {
      setSelectedAddressId(nextId);
    }
  }, [showOrderModal, addressesForCustoms, selectedAddressId]);

  const patchBasicInfoSelection = useCallback(
    (field: keyof CenterManageSelections, value: string) => {
      setBasicInfoSelections((prev) => {
        if (!centerMeta) {
          return { ...prev, [field]: value };
        }
        return reconcileCenterManageSelections(
          centerMeta,
          { ...prev, [field]: value },
          field,
        );
      });
    },
    [centerMeta],
  );

  /**
   * Localise a single chip value coming from `/center-manage/meta`.
   *
   * The backend stores these as Korean strings only (e.g. "구매대행",
   * "위해", "해운배송"), so the chips would otherwise stay Korean even
   * for users on the Chinese or English locale. We look up the value
   * in `cartOrder.orderModal.optionLabels.<korean-value>` and fall back
   * to the original string when no mapping exists.
   *
   * The DISPLAY label is translated, but the underlying `selected`
   * comparison still uses the original Korean string from the API so
   * the selection state and the request payload remain unchanged.
   */
  const localiseOptionLabel = (value: string): string => {
    if (!value) return value;
    const key = `cartOrder.orderModal.optionLabels.${value}`;
    const translated = t(key);
    // `t` returns the key path unchanged when a key is missing —
    // detect that and fall back to the original Korean string.
    return translated && translated !== key ? translated : value;
  };

  const renderBasicInfoPills = (
    label: string,
    options: string[],
    selected: string,
    onSelect: (value: string) => void,
  ) => (
    <View style={styles.orderFieldCol}>
      <Text style={styles.orderFieldLabel}>{label}</Text>
      <View style={styles.pillGroup}>
        {options.map((option) => {
          const rawValue = typeof option === 'string' ? option : String(option ?? '');
          const displayLabel = localiseOptionLabel(rawValue);
          return (
            <TouchableOpacity
              key={rawValue}
              style={[styles.pill, selected === rawValue && styles.pillActive]}
              onPress={() => onSelect(rawValue)}
            >
              <Text style={[styles.pillText, selected === rawValue && styles.pillTextActive]}>
                {displayLabel}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  const refreshOrderProfile = useCallback(async () => {
    if (isGuest || !isAuthenticated || orderProfileRefreshInFlightRef.current) return;
    orderProfileRefreshInFlightRef.current = true;
    try {
      const res = await getProfile();
      if (res.success && res.data?.user) {
        applyProfileFromApi(res.data.user);
      }
    } catch {
      /* profile refresh optional */
    } finally {
      orderProfileRefreshInFlightRef.current = false;
    }
  }, [applyProfileFromApi, isAuthenticated, isGuest]);

  const refreshOrderProfileRef = useRef(refreshOrderProfile);
  refreshOrderProfileRef.current = refreshOrderProfile;

  /** Refresh when screen gains focus (e.g. back from Address Book), not when callbacks change. */
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      if (!showOrderModalRef.current) return;
      void refreshOrderProfileRef.current();
    });
    return unsubscribe;
  }, [navigation]);

  const showRecipientPicker = useCallback(() => {
    if (addressesForCustoms.length === 0) {
      return;
    }
    Alert.alert(
      t('cartOrder.orderModal.selectRecipient'),
      undefined,
      [
        ...addressesForCustoms.map((addr) => ({
          text: formatProfileAddressLabel(addr),
          onPress: () => setSelectedAddressId(addr._id),
        })),
        { text: t('cartOrder.alerts.cancel'), style: 'cancel' as const },
      ],
    );
  }, [addressesForCustoms, t]);

  const handleUseNewAddress = useCallback(() => {
    // 발주모달을 먼저 닫고(슬라이드 종료 후) 새 주소 모달을 연다. 닫히면 발주모달 재오픈.
    setReopenOrderModal(true);
    setShowOrderModal(false);
    setTimeout(() => setShowAddNewAddressModal(true), 350);
  }, []);

  const handleManageAddresses = useCallback(() => {
    navigation.navigate('AddressBook' as never, { fromShippingSettings: true } as never);
  }, [navigation]);

  const pickNegotiationAttachment = useCallback(async () => {
    try {
      const granted = await requestPhotoLibraryPermission();
      if (!granted) {
        Alert.alert(t('cartOrder.alerts.permission'), t('cartOrder.alerts.photoPermission'));
        return;
      }
      const options: ImageLibraryOptions = { mediaType: 'photo' as MediaType, quality: 0.7 };
      launchImageLibrary(options, (res: ImagePickerResponse) => {
        if (res.didCancel || res.errorCode) return;
        const asset = res.assets?.[0];
        const uri = asset?.uri;
        if (!uri) return;
        setNegotiationContentImages((prev) => [
          ...prev,
          createNegotiationImageEntry({
            uri,
            fileName: asset.fileName,
            type: asset.type,
          }),
        ]);
      });
    } catch {
      Alert.alert(t('cartOrder.alerts.error'), t('cartOrder.alerts.galleryFailed'));
    }
  }, [t]);

  const removeNegotiationImage = useCallback((id: string) => {
    setNegotiationContentImages((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  /**
   * Same gallery-pick flow as `pickNegotiationAttachment`, but the
   * picked image is stored on the per-card map keyed by `cardId`.
   * Triggered by the per-card "+" button next to the 협상내역 label
   * in the multi-card order modal.
   */
  const pickCardNegotiationAttachment = useCallback(
    async (cardId: string) => {
      try {
        const granted = await requestPhotoLibraryPermission();
        if (!granted) {
          Alert.alert(t('cartOrder.alerts.permission'), t('cartOrder.alerts.photoPermission'));
          return;
        }
        const options: ImageLibraryOptions = { mediaType: 'photo' as MediaType, quality: 0.7 };
        launchImageLibrary(options, (res: ImagePickerResponse) => {
          if (res.didCancel || res.errorCode) return;
          const asset = res.assets?.[0];
          const uri = asset?.uri;
          if (!uri) return;
          const entry = createNegotiationImageEntry({
            uri,
            fileName: asset.fileName,
            type: asset.type,
          });
          setCardNegotiationImages((prev) => ({
            ...prev,
            [cardId]: [...(prev[cardId] || []), entry],
          }));
        });
      } catch {
        Alert.alert(t('cartOrder.alerts.error'), t('cartOrder.alerts.galleryFailed'));
      }
    },
    [t],
  );

  const openOrderInfoModal = useCallback(async () => {
    if (isGuest || !isAuthenticated) {
      navigation.navigate('Auth' as never, { screen: 'Login' } as never);
      return false;
    }

    setProfileLoading(true);
    setCenterMetaLoading(true);
    try {
      const [profileRes, metaRes] = await Promise.all([
        getProfile(),
        fetchCenterManageMeta(),
      ]);

      if (metaRes.success && metaRes.data) {
        setCenterMeta(metaRes.data);
        let selections = getInitialCenterManageSelections(metaRes.data);
        if (profileRes.success && profileRes.data?.user) {
          const addresses: ProfileAddress[] = (profileRes.data.user.addresses || []).map(
            (addr: Record<string, unknown>) => ({
              _id: String(addr._id || addr.id || ''),
              defaultAddress: Boolean(addr.defaultAddress),
              customerClearanceType: String(
                addr.customerClearanceType || addr.customMethod || '',
              ),
              customMethod: String(addr.customMethod || addr.customerClearanceType || ''),
            }),
          );
          const defaultAddr =
            addresses.find((a) => a.defaultAddress) || addresses[0] || null;
          if (defaultAddr) {
            const isBusiness =
              defaultAddr.customerClearanceType === 'business' ||
              defaultAddr.customMethod === 'business';
            const label = profileClearanceToMetaLabel(isBusiness);
            const customsList = getCustomsClearanceOptions(
              metaRes.data,
              selections.businessType,
              selections.logisticsCenter,
              selections.transportMethod,
              selections.applicationCategory,
            );
            if (customsList.includes(label)) {
              selections = { ...selections, customsClearance: label };
            }
          }
        }
        setBasicInfoSelections(selections);
      } else {
        setCenterMeta(null);
        Alert.alert(
          t('cartOrder.alerts.error'),
          metaRes.message || t('cartOrder.orderModal.orderFailed'),
        );
        return false;
      }

      if (profileRes.success && profileRes.data?.user) {
        applyProfileFromApi(profileRes.data.user);
        setShowOrderModal(true);
        return true;
      }
      Alert.alert(
        t('cartOrder.alerts.error'),
        profileRes.error || t('cartOrder.orderModal.orderFailed'),
      );
      return false;
    } catch {
      Alert.alert(t('cartOrder.alerts.error'), t('cartOrder.orderModal.orderFailed'));
      return false;
    } finally {
      setProfileLoading(false);
      setCenterMetaLoading(false);
    }
  }, [applyProfileFromApi, isAuthenticated, isGuest, navigation, t]);

  const handlePressOrderNow = useCallback(async () => {
    if (checkedCards.length === 0) {
      Alert.alert(
        t('cartOrder.alerts.notice'),
        t('cartOrder.alerts.noItemsSelected'),
        [{ text: t('cartOrder.alerts.confirm') }],
      );
      return;
    }

    await openOrderInfoModal();
  }, [checkedCards.length, openOrderInfoModal, t]);

  /** After product-detail Buy Now: keep item checked and open order modal once */
  useEffect(() => {
    if (!pendingBuyNowOrderRef.current || buyNowOrderModalOpenedRef.current) {
      return;
    }
    if (cartLoading || profileLoading) {
      return;
    }
    if (!cards.some((c) => c.checked)) {
      return;
    }

    buyNowOrderModalOpenedRef.current = true;
    pendingBuyNowOrderRef.current = false;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        void openOrderInfoModal();
      }, 300);
    });

    return () => {
      task.cancel();
      if (timer) clearTimeout(timer);
    };
  }, [cards, cartLoading, openOrderInfoModal, profileLoading]);

  const handleConfirmOrder = useCallback(async () => {
    if (!selectedAddressId || addressesForCustoms.length === 0) {
      Alert.alert(t('cartOrder.alerts.notice'), t('cartOrder.orderModal.noAddress'));
      return;
    }

    const cartItemIds = checkedCards.map((c) => c.id);
    if (cartItemIds.length === 0) {
      Alert.alert(t('cartOrder.alerts.notice'), t('cartOrder.alerts.noItemsSelected'));
      return;
    }

    const quantities: Record<string, number> = {};
    checkedCards.forEach((c) => {
      quantities[c.id] = c.quantity;
    });

    setCheckoutLoading(true);
    try {
      const checkoutRes = await cartApi.checkout(quantities);
      if (!checkoutRes.success || !checkoutRes.data) {
        Alert.alert(
          t('cartOrder.alerts.error'),
          checkoutRes.message || t('cartOrder.orderModal.orderSubmitFailed'),
        );
        return;
      }

      const checkoutData = checkoutRes.data;

      const cartRes = await cartApi.getCart(locale);
      const cartApiItems = cartRes.success && cartRes.data?.cart?.items
        ? cartRes.data.cart.items
        : [];
      const sourceItems = mergeOrderSourceItems(
        cartItemIds,
        checkoutData.selectedItems ?? [],
        cartApiItems,
      );

      const ordersLang = mapLocaleToOrdersLang(locale);
      const fallbackCards = checkedCards.map((c) => {
        const merged = sourceItems.find((entry) => {
          if (!entry || typeof entry !== 'object') return false;
          const row = entry as Record<string, unknown>;
          return row._id === c.id || row.id === c.id;
        }) as Record<string, unknown> | undefined;
        return {
          id: c.id,
          offerId: c.offerId,
          productName: c.productName,
          productImage: c.productImage,
          source: c.source,
          quantity: c.quantity,
          specId: c.specId,
          skuId: c.skuId,
          unitPriceKRW: resolveCheckoutLineUnitPriceKRW(merged, c.unitPrice),
          unitPriceCNY: c.unitPrice,
        };
      });

      // Decide which payload shape to build:
      //   * Single-card order  → top-level addServices/negotiation
      //     (legacy single-card path; preserves existing behaviour).
      //   * Multi-card order   → PER-CARD attachments shipped through
      //     the new `perCart` callback so each line item carries its
      //     own addServices / negotiationContentImages / note (matches
      //     the order-create response sample from the backend, which
      //     shows `items[].addServices` and `items[].negotiationContentImages`
      //     stored independently per item).
      const isMultiCardOrder = checkedCards.length > 1;

      // Container that maps cartItemId → uploaded data for the
      // multi-card path. Populated below by per-card uploads.
      const perCardData: Record<
        string,
        {
          addServices?: OrdersProxyAddService[];
          negotiationContentImages?: string[];
          negotiationNote?: string;
        }
      > = {};

      // Legacy single-card values (only used when not multi-card).
      let negotiationImageUrls: string[] = [];
      let addServiceImageUrls: string[] = [];

      if (isMultiCardOrder) {
        // Upload each card's negotiation images separately so the
        // returned URL groups can be attached to the correct line item.
        for (const card of checkedCards) {
          const images = cardNegotiationImages[card.id] || [];
          let cardNegotiationUrls: string[] = [];
          if (images.length > 0) {
            const uploadRes = await orderApi.uploadOrderImages(
              'negotiationContentImages',
              images.map((img) => ({
                uri: img.fileUri,
                fileName: img.fileName,
                type: img.mimeType,
              })),
              ordersLang,
            );
            if (!uploadRes.success) {
              Alert.alert(
                t('cartOrder.alerts.error'),
                uploadRes.error || t('cartOrder.orderModal.negotiationUploadFailed'),
              );
              return;
            }
            cardNegotiationUrls = uploadRes.data?.urls ?? [];
          }

          const cardSvcs = cardExtraServices[card.id] || [];
          // No per-card extra-service image uploads in the current UI;
          // pass empty array so the payload shape still matches the
          // server contract (`addServices[i].imageUrl: string[]`).
          const addServicesForCard: OrdersProxyAddService[] = cardSvcs.map((svc) => ({
            id: svc.id,
            note: '',
            imageUrl: [],
          }));

          const cardNote = (cardNegotiationNote[card.id] || '').trim();

          perCardData[card.id] = {
            ...(addServicesForCard.length > 0 ? { addServices: addServicesForCard } : {}),
            ...(cardNegotiationUrls.length > 0
              ? { negotiationContentImages: cardNegotiationUrls }
              : {}),
            ...(cardNote ? { negotiationNote: cardNote } : {}),
          };
        }
      } else {
        // Single-card legacy path — keep the old upload flow exactly.
        if (negotiationContentImages.length > 0) {
          const uploadRes = await orderApi.uploadOrderImages(
            'negotiationContentImages',
            negotiationContentImages.map((img) => ({
              uri: img.fileUri,
              fileName: img.fileName,
              type: img.mimeType,
            })),
            ordersLang,
          );
          if (!uploadRes.success) {
            Alert.alert(
              t('cartOrder.alerts.error'),
              uploadRes.error || t('cartOrder.orderModal.negotiationUploadFailed'),
            );
            return;
          }
          negotiationImageUrls = uploadRes.data?.urls ?? [];
        }

        if (modalPhotoUri && extraServices.length > 0) {
          const uploadRes = await orderApi.uploadOrderImages(
            'addServices',
            [{ uri: modalPhotoUri, fileName: `addservice_${Date.now()}.jpg` }],
            ordersLang,
          );
          if (!uploadRes.success) {
            Alert.alert(
              t('cartOrder.alerts.error'),
              uploadRes.error || t('cartOrder.orderModal.negotiationUploadFailed'),
            );
            return;
          }
          addServiceImageUrls = uploadRes.data?.urls ?? [];
        }
      }

      // Single-card addServices payload (unused in multi-card mode).
      const addServicesPayload: OrdersProxyAddService[] = isMultiCardOrder
        ? []
        : extraServices.map((svc) => ({
            id: svc.id,
            note: otherRequests.trim(),
            imageUrl: addServiceImageUrls,
          }));

      const proxyItems = buildOrdersProxyLineItems(
        cartItemIds,
        quantities,
        sourceItems,
        fallbackCards,
        {
          locale,
          ...(isMultiCardOrder
            ? {
                // Per-cart overrides ride entirely through `perCart`;
                // the top-level fields are left empty so they don't
                // accidentally apply to every line item.
                perCart: (cartItemId: string) => perCardData[cartItemId] ?? null,
              }
            : {
                addServices: addServicesPayload.length > 0 ? addServicesPayload : undefined,
                negotiationContentImages:
                  negotiationImageUrls.length > 0 ? negotiationImageUrls : undefined,
                negotiationNote: negotiationNote.trim() || undefined,
              }),
        },
      );

      const lineItemError = validateOrdersProxyLineItems(proxyItems);
      if (lineItemError) {
        Alert.alert(t('cartOrder.alerts.error'), lineItemError);
        return;
      }

      if (!basicInfoSelections.applicationCategory) {
        Alert.alert(t('cartOrder.alerts.notice'), t('cartOrder.orderModal.orderSubmitFailed'));
        return;
      }

      // 선택된 주소 객체 자체를 풀-shape 로 함께 전송 — backend 가 addressId
      // 조회 누락 시에도 주소 보존을 보장.
      const selectedAddrObj = pickPreferredAddress(addressesForCustoms, selectedAddressId);
      const shippingAddress = buildShippingAddressFromAddress(selectedAddrObj, {
        customerClearanceType: selectedAddrObj?.customerClearanceType,
      });

      const proxyRequest = buildOrdersProxyCreateRequest({
        cartItemIds,
        addressId: selectedAddressId,
        shippingAddress,
        businessType: basicInfoSelections.businessType,
        logisticsCenter: basicInfoSelections.logisticsCenter,
        transportMethod: basicInfoSelections.transportMethod,
        applicationCategory: basicInfoSelections.applicationCategory,
        customsClearance: basicInfoSelections.customsClearance,
        purchasePayment,
        shippingPayment,
        items: proxyItems,
        netExpectedTotalKRW: checkoutData.productTotalKRW,
      });

      await createOrder(proxyRequest);
    } catch {
      // onError alert handled by mutation
    } finally {
      setCheckoutLoading(false);
    }
  }, [
    basicInfoSelections,
    checkedCards,
    createOrder,
    extraServices,
    modalPhotoUri,
    otherRequests,
    purchasePayment,
    selectedAddressId,
    shippingPayment,
    locale,
    negotiationContentImages,
    negotiationNote,
    addressesForCustoms.length,
    t,
  ]);

  const renderBundleTableHeader = () => (
    <View style={styles.bundleTableHeader}>
      <View style={styles.bundleItemCheckCol} />
      <View style={styles.bundleTableColInfo}>
        <Text style={[styles.bundleTableHeaderText, styles.bundleTableHeaderTextLeft]}>
          {t('cartOrder.bundles.table.productInfo')}
        </Text>
      </View>
      <View style={styles.bundleTableColQty}>
        <Text style={styles.bundleTableHeaderText}>
          {t('cartOrder.bundles.table.quantity')}
        </Text>
      </View>
      <View style={styles.bundleTableColPrice}>
        <Text style={styles.bundleTableHeaderText}>
          {t('cartOrder.bundles.table.unitPrice')}
        </Text>
      </View>
      <View style={styles.bundleTableColAmount}>
        <Text style={styles.bundleTableHeaderText}>
          {t('cartOrder.bundles.table.productAmount')}
        </Text>
      </View>
      <View style={styles.bundleTableColManage}>
        <Text style={styles.bundleTableHeaderText}>
          {t('cartOrder.bundles.table.manage')}
        </Text>
      </View>
    </View>
  );

  const renderBundleItemRow = (card: CartCard, isLast: boolean) => {
    const subtotal = card.quantity * card.unitPrice;
    const specParts: string[] = [];
    if (card.size) {
      specParts.push(`${t('cartOrder.bundles.spec')}: ${card.size}`);
    }
    if (card.color) {
      specParts.push(`${t('cartOrder.bundles.color')}: ${card.color}`);
    }

    return (
      <View
        key={card.listKey}
        style={[styles.bundleItemRow, !isLast && styles.bundleItemRowBorder]}
      >
        <TouchableOpacity style={styles.bundleItemCheckCol} onPress={() => toggleCheck(card.id)}>
          <View style={[styles.checkBox, card.checked && styles.checkBoxChecked]}>
            {card.checked && <Icon name="checkmark" size={12} color={COLORS.white} />}
          </View>
        </TouchableOpacity>
        <View style={styles.bundleItemInfo}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => navigateToProductDetail(card)}
            style={styles.bundleItemInfoPress}
          >
            {card.productImage ? (
              <Image source={{ uri: card.productImage }} style={styles.bundleItemImage} />
            ) : (
              <View style={[styles.bundleItemImage, styles.productImagePlaceholder]}>
                <Icon name="cube-outline" size={18} color={COLORS.gray[400]} />
              </View>
            )}
            <View style={styles.bundleItemTextWrap}>
              <Text style={styles.bundleItemTitle} numberOfLines={2}>
                {card.productName}
              </Text>
              {specParts.map((line) => (
                <Text key={line} style={styles.bundleItemSpec} numberOfLines={1}>
                  {line}
                </Text>
              ))}
            </View>
          </TouchableOpacity>
        </View>
        <View style={styles.bundleTableColQty}>
          <Text style={styles.bundleItemQty}>{card.quantity}</Text>
        </View>
        <View style={styles.bundleTableColPrice}>
          <Text style={styles.bundleItemUnitPrice}>¥ {card.unitPrice.toFixed(2)}</Text>
        </View>
        <View style={styles.bundleTableColAmount}>
          <Text style={styles.bundleItemAmount}>¥ {subtotal.toFixed(2)}</Text>
        </View>
        <View style={styles.bundleTableColManage}>
          <TouchableOpacity onPress={() => handleDeleteOne(card.id)}>
            <Text style={styles.bundleItemDelete}>{t('cartOrder.card.delete')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderSetBundleGroup = (bundle: (typeof orderedSetBundles)[number]) => (
    <View key={bundle.id} style={styles.bundleGroup}>
      <View style={styles.bundleGroupHeader}>
        <TouchableOpacity
          style={styles.bundleItemCheckCol}
          onPress={() => toggleBundleCheck(bundle.id)}
        >
          <View style={[styles.checkBox, bundle.allChecked && styles.checkBoxChecked]}>
            {bundle.allChecked && <Icon name="checkmark" size={12} color={COLORS.white} />}
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.bundleTableColInfo}
          onPress={() => toggleBundleCollapse(bundle.id)}
        >
          <View style={styles.bundleTitleRow}>
            <Text style={styles.bundleGroupTitle}>
              {t('cartOrder.bundles.setProduct', { n: String(bundle.index) })}
            </Text>
            <Icon
              name={bundle.collapsed ? 'chevron-forward' : 'chevron-down'}
              size={14}
              color={COLORS.text.primary}
            />
          </View>
        </TouchableOpacity>
        <Text style={styles.bundleHeaderQty}>{bundle.totalQty}</Text>
        <Text style={styles.bundleHeaderAmount}>¥ {bundle.totalAmount.toFixed(2)}</Text>
        <View style={styles.bundleTableColManage} />
      </View>
      {!bundle.collapsed &&
        bundle.items.map((card, idx) =>
          renderBundleItemRow(card, idx === bundle.items.length - 1),
        )}
    </View>
  );

  const renderCartListContent = () => {
    if (activeTab === 'bundles') {
      if (orderedSetBundles.length === 0) {
        return (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyText}>{t('cartOrder.bundles.empty')}</Text>
          </View>
        );
      }
      return (
        <>
          {renderBundleTableHeader()}
          {orderedSetBundles.map(renderSetBundleGroup)}
        </>
      );
    }

    if (unbundledCards.length === 0) {
      if (filteredCards.length === 0) {
        return null;
      }
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>{t('cartOrder.empty')}</Text>
        </View>
      );
    }

    return unbundledCards.map(renderCard);
  };

  const renderCard = (card: CartCard) => {
    // 카드 우측 영역에서 더 이상 상품금액(subtotal) 을 표시하지 않으므로 계산
    // 변수 제거. 단가(¥)와 수량만 인라인으로 노출.
    return (
      <TouchableOpacity
        key={card.listKey}
        style={styles.card}
        activeOpacity={1}
      >
        {/* Accent strip */}
        <View style={styles.cardAccent} />

        {/* TOP — 체크박스 + index 배지 + 상품명 (한 줄) */}
        <View style={styles.cardTop}>
          <TouchableOpacity style={styles.checkBtn} onPress={() => toggleCheck(card.id)}>
            <View style={[styles.checkBox, card.checked && styles.checkBoxChecked]}>
              {card.checked && <Icon name="checkmark" size={12} color={COLORS.white} />}
            </View>
          </TouchableOpacity>
          <View style={styles.companyWrap}>
            <Text style={styles.indexBadge}>{card.index}</Text>
            <Text style={styles.companyName} numberOfLines={1}>
              {card.productName}
            </Text>
          </View>
        </View>

        {/* MIDDLE — product row */}
        <View style={styles.cardMiddle}>
          {/* Left: image + info */}
          <View style={styles.middleLeft}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => navigateToProductDetail(card)}
              style={styles.productImagePressable}
            >
              {card.productImage ? (
                <Image source={{ uri: card.productImage }} style={styles.productImage} />
              ) : (
                <View style={[styles.productImage, styles.productImagePlaceholder]}>
                  <Icon name="cube-outline" size={22} color={COLORS.gray[400]} />
                </View>
              )}
            </TouchableOpacity>
            <View style={styles.productInfo}>
              {/* 첫 줄: 옵션명 드롭다운 — 탭하면 해당 카드의 상세를 펼친다. */}
              <TouchableOpacity
                style={styles.productNameBox}
                onPress={() => toggleCardExpanded(card.id)}
                activeOpacity={0.7}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Text style={styles.productName} numberOfLines={1}>
                  {[card.color, card.size].filter(Boolean).join(' ') || card.productName}
                </Text>
                <Icon
                  name={expandedCardIds.has(card.id) ? 'chevron-up' : 'chevron-down'}
                  size={12}
                  color={COLORS.gray[500]}
                />
              </TouchableOpacity>
              {/* 두 번째 줄 이하: spec 칩들 (색상 / 사이즈 / 기타 메타) */}
              <View style={styles.metaRow}>
                {!!card.color && (
                  <Text style={styles.metaTag}>
                    {t('cartOrder.card.color')} {card.color}
                  </Text>
                )}
                {!!card.size && <Text style={styles.metaTag}>{card.size}</Text>}
              </View>
              {/* 펼침 상태: 상품명 풀텍스트 + 옵션 풀텍스트 + spec 라인들. */}
              {expandedCardIds.has(card.id) && (
                <View style={styles.cardExpandedDetails}>
                  <Text style={styles.cardExpandedLabel}>
                    {t('cartOrder.card.productName') || '상품명'}
                  </Text>
                  <Text style={styles.cardExpandedValue}>{card.productName}</Text>

                  {(card.color || card.size) && (
                    <>
                      <Text style={[styles.cardExpandedLabel, { marginTop: 6 }]}>
                        {t('cartOrder.card.options') || '옵션'}
                      </Text>
                      {!!card.color && (
                        <Text style={styles.cardExpandedValue}>
                          {t('cartOrder.card.color')}: {card.color}
                        </Text>
                      )}
                      {!!card.size && (
                        <Text style={styles.cardExpandedValue}>{card.size}</Text>
                      )}
                    </>
                  )}

                  {Array.isArray((card as any).skuAttributes) &&
                    (card as any).skuAttributes.length > 0 && (
                      <>
                        <Text style={[styles.cardExpandedLabel, { marginTop: 6 }]}>
                          {t('cartOrder.card.specs') || '상세'}
                        </Text>
                        {((card as any).skuAttributes as Array<{ attributeName?: string; value?: string }>).map(
                          (attr, idx) => (
                            <Text key={`expandedAttr-${idx}`} style={styles.cardExpandedValue}>
                              {(attr.attributeName || '').trim()}
                              {attr.attributeName && attr.value ? ': ' : ''}
                              {(attr.value || '').trim()}
                            </Text>
                          ),
                        )}
                      </>
                    )}
                </View>
              )}
            </View>
          </View>

          {/* 우측 인라인: 단가 ¥ 표시 + 수량 stepper (한 줄에 나란히) */}
          <View style={styles.middleRightRow}>
            <Text style={styles.unitPriceTextInline}>¥ {card.unitPrice.toFixed(2)}</Text>
            <View style={styles.qtyRow}>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(card.id, -1)}>
                <Icon name="remove" size={14} color={COLORS.white} />
              </TouchableOpacity>
              <Text style={styles.qtyValue}>{card.quantity}</Text>
              <TouchableOpacity style={styles.qtyBtn} onPress={() => changeQty(card.id, 1)}>
                <Icon name="add" size={14} color={COLORS.white} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
        {/* 라벨/삭제 버튼은 사용자 요청으로 제거됨. 라벨 설정은 별도 모달에서,
            삭제는 다중 선택 후 하단 툴바의 휴지통 액션으로 수행 가능. */}
      </TouchableOpacity>
    );
  };

  const cartBody = (
    <>
      <View style={styles.topSection}>
      {/* PAGE TITLE */}
      <View style={styles.pageHeader}>
        <Icon name="cart-outline" size={22} color={COLORS.secondary} />
        <Text style={styles.pageHeaderTitle}>{t('cart.title')}</Text>
        <TouchableOpacity
          style={styles.pageHeaderLangBtn}
          onPress={() => navigation.navigate('LanguageSettings')}
          activeOpacity={0.7}
        >
          <Text style={styles.pageHeaderLangFlag}>{getCartLanguageFlag(locale)}</Text>
        </TouchableOpacity>
      </View>

      {/* HEADER */}
      <View style={styles.header}>
        <View style={styles.searchBar}>
          <Icon name="search" size={14} color={COLORS.gray[500]} />
          <TextInput
            style={styles.searchInput}
            placeholder={t('cartOrder.search')}
            placeholderTextColor={COLORS.gray[400]}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        <View style={styles.periodWrap}>
          <TouchableOpacity
            style={styles.periodBtn}
            onPress={() => setShowPeriodMenu((v) => !v)}
          >
            <Icon name="calendar-outline" size={12} color={COLORS.text.primary} />
            <Text style={styles.periodText} numberOfLines={1}>
              {startDate || endDate
                ? `${startDate ? formatDate(startDate) : ''} ~ ${endDate ? formatDate(endDate) : ''}`
                : t('cartOrder.periodSelect')}
            </Text>
            <Icon name="chevron-down" size={12} color={COLORS.text.primary} />
          </TouchableOpacity>
          {showPeriodMenu && (
            <View style={styles.periodMenu}>
              <TouchableOpacity
                style={styles.periodMenuItem}
                onPress={() => setShowStartPicker(true)}
              >
                <Text style={styles.periodMenuText} numberOfLines={1}>
                  {t('cartOrder.startDate')}: {startDate ? formatDate(startDate) : '—'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.periodMenuItem}
                onPress={() => setShowEndPicker(true)}
              >
                <Text style={styles.periodMenuText} numberOfLines={1}>
                  {t('cartOrder.endDate')}: {endDate ? formatDate(endDate) : '—'}
                </Text>
              </TouchableOpacity>
              {(startDate || endDate) && (
                <TouchableOpacity
                  style={styles.periodMenuItem}
                  onPress={() => {
                    setStartDate(null);
                    setEndDate(null);
                    setShowPeriodMenu(false);
                  }}
                >
                  <Text style={[styles.periodMenuText, { color: COLORS.red }]} numberOfLines={1}>
                    {t('cartOrder.clearDates')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        <TouchableOpacity style={styles.deleteBtn} onPress={handleDeleteChecked}>
          <Icon name="trash-outline" size={14} color={COLORS.white} />
        </TouchableOpacity>
      </View>

      <DatePickerModal
        visible={showStartPicker}
        onClose={() => setShowStartPicker(false)}
        onConfirm={(d) => setStartDate(d)}
        initialDate={startDate || undefined}
        title={t('cartOrder.startDate')}
      />
      <DatePickerModal
        visible={showEndPicker}
        onClose={() => setShowEndPicker(false)}
        onConfirm={(d) => setEndDate(d)}
        initialDate={endDate || undefined}
        title={t('cartOrder.endDate')}
      />

      {/* 과거주문 모달 — orders-proxy 로 과거 주문 목록을 불러와 표시 */}
      <PastOrderModal
        visible={showPastOrderModal}
        onClose={() => setShowPastOrderModal(false)}
      />

      <View style={styles.tabsRow}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'past' && styles.tabBtnActive]}
          onPress={() => {
            setActiveTab('past');
            setShowPastOrderModal(true);
          }}
        >
          <Text style={[styles.tabText, activeTab === 'past' && styles.tabTextActive]}>
            {t('cartOrder.tabs.past')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'bundles' && styles.tabBtnActive]}
          onPress={handleBundlesTabPress}
        >
          <Text style={[styles.tabText, activeTab === 'bundles' && styles.tabTextActive]}>
            {t('cartOrder.tabs.bundles')}
          </Text>
        </TouchableOpacity>
      </View>
      </View>

      {/* BODY — cart list */}
      <View style={styles.body}>
        <ScrollView
          style={styles.cardsList}
          contentContainerStyle={styles.cardsContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={cartRefreshing}
              onRefresh={onCartRefresh}
              colors={[COLORS.red]}
              tintColor={COLORS.red}
            />
          }
        >
          {cartLoading ? (
            <View style={styles.emptyWrap}>
              <ActivityIndicator size="large" color={COLORS.primary} />
            </View>
          ) : cartError ? (
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>{cartError}</Text>
              <TouchableOpacity onPress={loadCart} style={styles.retryButton}>
                <Text style={styles.retryButtonText}>{t('cartOrder.alerts.confirm')}</Text>
              </TouchableOpacity>
            </View>
          ) : filteredCards.length === 0 ? (
            <View style={styles.emptyCartWrap}>
              <Image
                source={require('../../assets/icons/cart_empty.png')}
                style={styles.emptyCartImage}
                resizeMode="contain"
              />
              <Text style={styles.emptyCartTitle}>{t('cart.cartEmptyTitle')}</Text>
              <TouchableOpacity
                style={styles.emptyCartButton}
                activeOpacity={0.85}
                onPress={() => navigation.navigate('Category')}
              >
                <Text style={styles.emptyCartButtonText}>{t('cart.cartEmptyBrowse')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            renderCartListContent()
          )}
        </ScrollView>

        <View style={styles.summaryBar}>
          <Text style={styles.summaryText}>
            {t('cartOrder.summary.totalQty')} {checkedQty > 0 ? checkedQty : totalQty}
          </Text>
          <Text style={styles.summaryTotal}>
            {t('cartOrder.summary.total')} ¥{(checkedQty > 0 ? checkedTotal : grandTotal).toFixed(2)}
          </Text>
          <TouchableOpacity
            style={styles.selectAllToggle}
            onPress={toggleSelectAll}
            disabled={cards.length === 0}
            activeOpacity={0.85}
          >
            <View
              style={[
                styles.selectAllCircle,
                allCardsSelected && styles.selectAllCircleChecked,
              ]}
            >
              {allCardsSelected && (
                <Icon name="checkmark" size={12} color={COLORS.white} />
              )}
            </View>
            <Text style={styles.selectAllText}>{t('cartOrder.summary.selectAll')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.orderBtn,
              hasSelectedCards && styles.orderBtnEnabled,
              !isOrderNowEnabled && styles.orderBtnDisabled,
            ]}
            onPress={handlePressOrderNow}
            disabled={!isOrderNowEnabled}
            activeOpacity={hasSelectedCards ? 0.85 : 1}
          >
            {profileLoading ? (
              <ActivityIndicator size="small" color={COLORS.white} />
            ) : (
              <Text style={styles.orderBtnText}>{t('cartOrder.summary.order')}</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* 발주정보 작성 및 확인 MODAL */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showOrderModal}
        animationType="slide"
        transparent
        onRequestClose={() => setShowOrderModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('cartOrder.orderModal.title')}</Text>
              <TouchableOpacity onPress={() => setShowOrderModal(false)}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.modalBody}
              contentContainerStyle={styles.modalBodyContent}
              showsVerticalScrollIndicator={false}
            >
              {/* 예치금결제 */}
              <View style={styles.orderSection}>
                <View style={styles.orderSectionHead}>
                  <View style={styles.orderSectionBar} />
                  <Text style={styles.orderSectionTitle}>{t('cartOrder.orderModal.depositPayment')}</Text>
                </View>

                <Text style={styles.depositBalanceText}>
                  {t('cartOrder.orderModal.depositBalance')}: {formatPriceKRW(depositBalance)}
                </Text>

                <View style={styles.orderFieldRow}>
                  <Text style={styles.orderFieldLabel}>{t('cartOrder.orderModal.purchasePayment')}</Text>
                  <View style={styles.pillGroup}>
                    <TouchableOpacity
                      style={[styles.pill, purchasePayment === 'manual' && styles.pillActive]}
                      onPress={() => setPurchasePayment('manual')}
                    >
                      <Text style={[styles.pillText, purchasePayment === 'manual' && styles.pillTextActive]}>{t('cartOrder.orderModal.manual')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.pill, purchasePayment === 'auto' && styles.pillActive]}
                      onPress={() => setPurchasePayment('auto')}
                    >
                      <Text style={[styles.pillText, purchasePayment === 'auto' && styles.pillTextActive]}>{t('cartOrder.orderModal.auto')}</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity onPress={() => setShowPaymentTooltip((v) => !v)} style={styles.helpBtn}>
                    <Icon name="help-circle-outline" size={16} color={COLORS.gray[500]} />
                  </TouchableOpacity>
                </View>

                <View style={styles.orderFieldRow}>
                  <Text style={styles.orderFieldLabel}>{t('cartOrder.orderModal.shippingPayment')}</Text>
                  <View style={styles.pillGroup}>
                    <TouchableOpacity
                      style={[styles.pill, shippingPayment === 'manual' && styles.pillActive]}
                      onPress={() => setShippingPayment('manual')}
                    >
                      <Text style={[styles.pillText, shippingPayment === 'manual' && styles.pillTextActive]}>{t('cartOrder.orderModal.manual')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.pill, shippingPayment === 'auto' && styles.pillActive]}
                      onPress={() => setShippingPayment('auto')}
                    >
                      <Text style={[styles.pillText, shippingPayment === 'auto' && styles.pillTextActive]}>{t('cartOrder.orderModal.auto')}</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity onPress={() => setShowPaymentTooltip((v) => !v)} style={styles.helpBtn}>
                    <Icon name="help-circle-outline" size={16} color={COLORS.gray[500]} />
                  </TouchableOpacity>
                </View>

                {showPaymentTooltip && (
                  <View style={styles.tooltipBox}>
                    <Text style={styles.tooltipText}>
                      {t('cartOrder.orderModal.paymentTooltip')}
                    </Text>
                  </View>
                )}
              </View>

              {/* 기본정보 — GET /center-manage/meta (web과 동일 5단계) */}
              <View style={styles.orderSection}>
                <View style={styles.orderSectionHead}>
                  <View style={styles.orderSectionBar} />
                  <Text style={styles.orderSectionTitle}>{t('cartOrder.orderModal.basicInfo')}</Text>
                </View>

                {centerMetaLoading || !centerMeta ? (
                  <View style={styles.centerMetaLoadingWrap}>
                    <ActivityIndicator size="small" color={PRIMARY} />
                    <Text style={styles.centerMetaLoadingText}>
                      {t('cartOrder.orderModal.basicInfoLoading')}
                    </Text>
                  </View>
                ) : (
                  <>
                    {renderBasicInfoPills(
                      t('cartOrder.orderModal.businessTypeField'),
                      centerMeta.businessType,
                      basicInfoSelections.businessType,
                      (v) => patchBasicInfoSelection('businessType', v),
                    )}
                    {renderBasicInfoPills(
                      t('cartOrder.orderModal.logistics'),
                      getLogisticsCentersForBusiness(centerMeta, basicInfoSelections.businessType),
                      basicInfoSelections.logisticsCenter,
                      (v) => patchBasicInfoSelection('logisticsCenter', v),
                    )}
                    {renderBasicInfoPills(
                      t('cartOrder.orderModal.transportMethodField'),
                      getTransportMethodsForBusiness(centerMeta, basicInfoSelections.businessType),
                      basicInfoSelections.transportMethod,
                      (v) => patchBasicInfoSelection('transportMethod', v),
                    )}
                    {renderBasicInfoPills(
                      t('cartOrder.orderModal.applicationCategoryField'),
                      getApplicationCategories(
                        centerMeta,
                        basicInfoSelections.businessType,
                        basicInfoSelections.logisticsCenter,
                        basicInfoSelections.transportMethod,
                      ),
                      basicInfoSelections.applicationCategory,
                      (v) => patchBasicInfoSelection('applicationCategory', v),
                    )}
                    {renderBasicInfoPills(
                      t('cartOrder.orderModal.customs'),
                      getCustomsClearanceOptions(
                        centerMeta,
                        basicInfoSelections.businessType,
                        basicInfoSelections.logisticsCenter,
                        basicInfoSelections.transportMethod,
                        basicInfoSelections.applicationCategory,
                      ),
                      basicInfoSelections.customsClearance,
                      (v) => patchBasicInfoSelection('customsClearance', v),
                    )}
                  </>
                )}
              </View>

              {/* 배송주소확인 — 통관방식(사업자/개인)에 맞는 등록 주소 */}
              <View style={styles.orderSection}>
                <View style={styles.deliveryAddressSection}>
                  <View style={styles.deliveryAddressHeader}>
                    <Text style={styles.deliveryAddressTitle}>
                      {t('cartOrder.orderModal.deliveryAddressConfirm')}
                    </Text>
                    <View style={styles.deliveryAddressActions}>
                      <TouchableOpacity
                        style={styles.deliveryAddressActionBtn}
                        onPress={handleUseNewAddress}
                        activeOpacity={0.7}
                      >
                        <View style={styles.deliveryAddressIconCircle}>
                          <Icon name="add" size={14} color={COLORS.gray[700]} />
                        </View>
                        <Text style={styles.deliveryAddressActionText}>
                          {t('cartOrder.orderModal.useNewAddress')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deliveryAddressActionBtn}
                        onPress={handleManageAddresses}
                        activeOpacity={0.7}
                      >
                        <View style={styles.deliveryAddressIconCircle}>
                          <Icon name="create-outline" size={14} color={COLORS.gray[700]} />
                        </View>
                        <Text style={styles.deliveryAddressActionText}>
                          {t('cartOrder.orderModal.manageAddresses')}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>

                  {addressesForCustoms.length === 0 ? (
                    <View style={styles.deliveryAddressEmptyBox}>
                      <Text style={styles.deliveryAddressEmptyText}>
                        {isCustomsClearanceBusiness(basicInfoSelections.customsClearance)
                          ? t('cartOrder.orderModal.noBusinessAddress')
                          : t('cartOrder.orderModal.noPersonalAddress')}
                      </Text>
                    </View>
                  ) : (
                    <TouchableOpacity
                      style={styles.deliveryAddressFilledBox}
                      onPress={() => setShowAddressSelect(true)}
                      activeOpacity={0.7}
                    >
                      {/* 배송지 탭 → 등록된 배송주소 중 하나를 선택하는 오버레이 표시 */}
                      <Text style={styles.deliveryAddressFilledText} numberOfLines={3}>
                        {deliveryAddressLabel || t('cartOrder.orderModal.selectPlaceholder')}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {/* Order modal — 카드별 협상내역 / 비고 / 부가서비스.
                  선택 카드 수에 관계없이 항상 다중 카드용 레이아웃을 사용한다.
                  즉 한 개를 선택해도 그 카드 안에 자체 부가서비스 chip /
                  협상내역 ⊕ 단추 / 비고 입력칸이 카드별로 배치된다. */}
              <View style={styles.orderModalCardsList}>
                {checkedCards.map((c) => renderOrderModalCard(c))}
              </View>
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.modalFooterBtn, styles.modalCancelBtn]}
                onPress={() => setShowOrderModal(false)}
              >
                <Text style={styles.modalCancelText}>{t('cartOrder.orderModal.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalFooterBtn,
                  styles.modalConfirmBtn,
                  (isSubmittingOrder || checkoutLoading) && styles.orderBtnDisabled,
                ]}
                onPress={handleConfirmOrder}
                disabled={isSubmittingOrder || checkoutLoading}
              >
                {isSubmittingOrder || checkoutLoading ? (
                  <ActivityIndicator size="small" color={COLORS.white} />
                ) : (
                  <Text style={styles.modalConfirmText}>{t('cartOrder.orderModal.orderConfirm')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* 배송주소 선택 오버레이 — iOS 는 모달 위에 모달이 안 떠서 발주모달
              안의 절대위치 오버레이로 구현. 등록 주소를 라디오로 한 개만 선택.
              (이미지 디자인: 제목 + 라디오 목록 + 하단 '취소' 버튼) */}
          {showAddressSelect && (
            <View style={styles.addrSelectOverlay}>
              <TouchableOpacity
                style={styles.addrSelectBackdrop}
                activeOpacity={1}
                onPress={() => setShowAddressSelect(false)}
              />
              <View style={styles.addrSelectCard}>
                <Text style={styles.addrSelectTitle}>
                  {t('cartOrder.orderModal.selectRecipient')}
                </Text>
                <View style={styles.addrSelectDivider} />
                <ScrollView style={styles.addrSelectList} showsVerticalScrollIndicator={false}>
                  {addressesForCustoms.map((addr) => {
                    const selected = addr._id === selectedAddressId;
                    return (
                      <TouchableOpacity
                        key={addr._id}
                        style={styles.addrSelectRow}
                        activeOpacity={0.7}
                        onPress={() => {
                          setSelectedAddressId(addr._id);
                          setShowAddressSelect(false);
                        }}
                      >
                        <View style={[styles.addrRadioOuter, selected && styles.addrRadioOuterOn]}>
                          {selected && <View style={styles.addrRadioInner} />}
                        </View>
                        <Text
                          style={[styles.addrSelectRowText, selected && styles.addrSelectRowTextOn]}
                          numberOfLines={3}
                        >
                          {formatProfileAddressLabel(addr)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                <View style={styles.addrSelectDivider} />
                <TouchableOpacity
                  style={styles.addrSelectCancelBtn}
                  activeOpacity={0.7}
                  onPress={() => setShowAddressSelect(false)}
                >
                  <Text style={styles.addrSelectCancelText}>
                    {t('cartOrder.orderModal.cancel') || '취소'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>

      {/* Per-card negotiation-image gallery viewer. Opens when the
          shopper taps the "협상내역" label on a card row in the order
          modal (only when that card has at least one attachment).
          Each thumb has a small ✕ overlay to let the shopper delete
          the attachment in place. */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={negotiationGalleryCardId !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setNegotiationGalleryCardId(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {t('cartOrder.orderModal.negotiationHistory')}
              </Text>
              <TouchableOpacity onPress={() => setNegotiationGalleryCardId(null)}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.modalBody}
              contentContainerStyle={styles.modalBodyContent}
              showsVerticalScrollIndicator={false}
            >
              {(() => {
                const cardId = negotiationGalleryCardId;
                const images = cardId ? cardNegotiationImages[cardId] || [] : [];
                if (images.length === 0) {
                  return (
                    <Text style={styles.negotiationGalleryEmpty}>
                      {t('cartOrder.orderModal.negotiationRemarksPlaceholder')}
                    </Text>
                  );
                }
                return (
                  <View style={styles.negotiationGalleryGrid}>
                    {images.map((entry) => (
                      <View key={entry.id} style={styles.negotiationGalleryItem}>
                        <Image
                          source={{ uri: entry.fileUri }}
                          style={styles.negotiationGalleryImage}
                          resizeMode="cover"
                        />
                        <TouchableOpacity
                          style={styles.negotiationGalleryRemove}
                          onPress={() =>
                            setCardNegotiationImages((prev) => {
                              if (!cardId) return prev;
                              const next = {
                                ...prev,
                                [cardId]: (prev[cardId] || []).filter((x) => x.id !== entry.id),
                              };
                              // Auto-close the modal if the last image
                              // was just removed.
                              if (next[cardId].length === 0) {
                                setNegotiationGalleryCardId(null);
                              }
                              return next;
                            })
                          }
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Icon name="close" size={14} color={COLORS.white} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                );
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <AddNewAddressModal
        visible={showAddNewAddressModal}
        onClose={() => {
          setShowAddNewAddressModal(false);
          reopenOrderModalIfNeeded();
        }}
        onSuccess={() => {
          void refreshOrderProfile();
        }}
      />

      {/* 라벨설정 MODAL */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={labelModalCardId !== null}
        animationType="slide"
        transparent
        onRequestClose={closeLabelModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('cartOrder.labelModal.title')}</Text>
              <TouchableOpacity onPress={closeLabelModal}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.modalBody}
              contentContainerStyle={styles.modalBodyContent}
              showsVerticalScrollIndicator={false}
            >
              {/* 라벨종류 */}
              <View style={styles.labelSection}>
                <Text style={styles.labelSectionLabel}>{t('cartOrder.labelModal.labelType')}</Text>
                <View style={styles.radioRow}>
                  <TouchableOpacity
                    style={styles.radioOption}
                    onPress={() => setLabelType('product')}
                  >
                    <View style={[styles.radioOuter, labelType === 'product' && styles.radioOuterOn]}>
                      {labelType === 'product' && <View style={styles.radioInner} />}
                    </View>
                    <Text style={styles.radioText}>{t('cartOrder.labelModal.productLabel')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.radioOption}
                    onPress={() => setLabelType('foodInspect')}
                  >
                    <View style={[styles.radioOuter, labelType === 'foodInspect' && styles.radioOuterOn]}>
                      {labelType === 'foodInspect' && <View style={styles.radioInner} />}
                    </View>
                    <Text style={styles.radioText}>{t('cartOrder.labelModal.foodLabel')}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.labelHint}>
                  {t('cartOrder.labelModal.typeHint')}
                </Text>
              </View>

              {/* 라벨양식 */}
              <View style={styles.labelSection}>
                <Text style={styles.labelSectionLabel}>{t('cartOrder.labelModal.labelFormat')}</Text>
                <View style={styles.radioRow}>
                  <TouchableOpacity
                    style={styles.radioOption}
                    onPress={() => setLabelFormat('50x80')}
                  >
                    <View style={[styles.radioOuter, labelFormat === '50x80' && styles.radioOuterOn]}>
                      {labelFormat === '50x80' && <View style={styles.radioInner} />}
                    </View>
                    <Text style={styles.radioText}>{t('cartOrder.labelModal.format5080')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.radioOption}
                    onPress={() => setLabelFormat('40x60')}
                  >
                    <View style={[styles.radioOuter, labelFormat === '40x60' && styles.radioOuterOn]}>
                      {labelFormat === '40x60' && <View style={styles.radioInner} />}
                    </View>
                    <Text style={styles.radioText}>
                      {t('cartOrder.labelModal.format4060')}
                      {labelType === 'foodInspect' && labelFormat === '40x60' ? (
                        <Text style={styles.labelHintInline}> {t('cartOrder.labelModal.noBarcode')}</Text>
                      ) : null}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* PREVIEW — middle section on desktop, top on mobile per spec */}
              <View style={styles.labelSection}>
                <Text style={styles.labelSectionLabel}>{t('cartOrder.labelModal.preview')}</Text>
                <View style={styles.previewWrap}>
                  <View
                    style={[
                      styles.previewCard,
                      labelFormat === '50x80' ? styles.previewCard5080 : styles.previewCard4060,
                    ]}
                  >
                    {labelType === 'foodInspect' && (
                      <View style={styles.foodBadge}>
                        <Icon name="restaurant-outline" size={10} color={COLORS.text.primary} />
                        <Text style={styles.foodBadgeText}>{t('cartOrder.labelModal.foodBadge')}</Text>
                      </View>
                    )}
                    {!(labelType === 'foodInspect' && labelFormat === '40x60') && (
                      <Text style={styles.previewProductName}>{labelProductName}</Text>
                    )}
                    {!(labelType === 'product' && labelFormat === '40x60') && (
                      <Text style={styles.previewContent}>{labelContent}</Text>
                    )}
                    {!(labelType === 'foodInspect' && labelFormat === '40x60') && (
                      <View style={styles.barcodePreview}>
                        <View style={styles.barcodeLines}>
                          {Array.from({ length: 28 }).map((_, i) => (
                            <View
                              key={i}
                              style={[
                                styles.barcodeBar,
                                { width: (i % 3) + 1 },
                                i % 2 === 0 && styles.barcodeBarThick,
                              ]}
                            />
                          ))}
                        </View>
                        <Text style={styles.barcodeText}>{labelBarcode}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.dimensionLabel}>
                    <Text style={styles.dimensionText}>
                      {labelFormat === '50x80' ? t('cartOrder.labelModal.dim5080') : t('cartOrder.labelModal.dim4060')}
                    </Text>
                  </View>
                </View>
              </View>

              {/* INPUTS — right section on desktop, center on mobile per spec */}
              <View style={styles.labelSection}>
                <Text style={styles.labelSectionLabel}>{t('cartOrder.labelModal.labelContent')}</Text>
                <View style={styles.fontToolbar}>
                  <View style={styles.fontChip}><Text style={styles.fontChipText}>{t('cartOrder.labelModal.font')}</Text></View>
                  <View style={styles.fontChip}><Text style={styles.fontChipText}>9pt</Text></View>
                  <View style={styles.fontChip}><Text style={[styles.fontChipText, { fontWeight: '800' }]}>{t('cartOrder.labelModal.gaLetter')}</Text></View>
                  <View style={styles.fontChip}><Text style={[styles.fontChipText, { fontStyle: 'italic' }]}>{t('cartOrder.labelModal.gaLetter')}</Text></View>
                  <View style={styles.fontChip}><Text style={[styles.fontChipText, { textDecorationLine: 'underline' }]}>{t('cartOrder.labelModal.gaLetter')}</Text></View>
                </View>

                {!(labelType === 'foodInspect' && labelFormat === '40x60') && (
                  <>
                    <Text style={styles.labelInputLabel}>{t('cartOrder.labelModal.productName')}</Text>
                    <TextInput
                      style={styles.labelInput}
                      value={labelProductName}
                      onChangeText={setLabelProductName}
                      placeholder={t('cartOrder.labelModal.productNamePlaceholder')}
                      placeholderTextColor={COLORS.gray[400]}
                    />
                  </>
                )}

                {!(labelType === 'product' && labelFormat === '40x60') && (
                  <>
                    <Text style={styles.labelInputLabel}>{t('cartOrder.labelModal.contentInput')}</Text>
                    <TextInput
                      style={styles.labelContentInput}
                      value={labelContent}
                      onChangeText={setLabelContent}
                      multiline
                      placeholder={t('cartOrder.labelModal.contentPlaceholder')}
                      placeholderTextColor={COLORS.gray[400]}
                    />
                  </>
                )}

                {!(labelType === 'foodInspect' && labelFormat === '40x60') && (
                  <>
                    <Text style={styles.labelInputLabel}>{t('cartOrder.labelModal.barcodeNumber')}</Text>
                    <TextInput
                      style={styles.labelInput}
                      value={labelBarcode}
                      onChangeText={setLabelBarcode}
                      placeholder={t('cartOrder.labelModal.barcodePlaceholder')}
                      placeholderTextColor={COLORS.gray[400]}
                    />
                  </>
                )}

                {labelFileUri ? (
                  <View style={styles.labelFilePreviewWrap}>
                    <Image source={{ uri: labelFileUri }} style={styles.labelFilePreview} />
                    <TouchableOpacity
                      style={styles.uploadRemove}
                      onPress={() => setLabelFileUri(null)}
                    >
                      <Icon name="close" size={12} color={COLORS.white} />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            </ScrollView>

            {/* Footer */}
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.modalFooterBtn, styles.modalCancelBtn]}
                onPress={pickLabelFile}
              >
                {/* cloud-upload-outline 은 Icon 레지스트리에 없어 물음표(?)로
                    렌더되던 문제 — 아이콘 제거하고 텍스트만 표시. */}
                <Text style={styles.modalCancelText}>{t('cartOrder.labelModal.fileUpload')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalFooterBtn, styles.modalConfirmBtn]}
                onPress={saveLabel}
              >
                <Text style={styles.modalConfirmText}>{t('cartOrder.labelModal.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 부가서비스선택 MODAL */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showServiceModal}
        animationType="slide"
        transparent
        onRequestClose={closeServiceModal}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('cartOrder.serviceModal.title')}</Text>
              <TouchableOpacity onPress={closeServiceModal}>
                <Icon name="close" size={22} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.modalBody}
              contentContainerStyle={styles.modalBodyContent}
              showsVerticalScrollIndicator={false}
            >
              {/* TOP — product/service detail (middle section) */}
              <View style={styles.detailSection}>
                <View style={styles.detailImageWrap}>
                  {detailService?.imageUrl ? (
                    <Image
                      source={{ uri: detailService.imageUrl }}
                      style={styles.detailServiceImage}
                      resizeMode="contain"
                    />
                  ) : detailService?.iconUrl ? (
                    <Image
                      source={{ uri: detailService.iconUrl }}
                      style={styles.detailServiceIconImage}
                      resizeMode="contain"
                    />
                  ) : (
                    <Icon name="cube-outline" size={72} color={COLORS.gray[300]} />
                  )}
                </View>
                <Text style={styles.detailName}>
                  {detailService?.name || t('cartOrder.serviceModal.selectPrompt')}
                </Text>
                {detailService?.price ? (
                  <Text style={styles.detailPriceRow}>
                    <Text style={styles.detailPriceLabel}>{t('cartOrder.serviceModal.feeLabel')}</Text>
                    <Text style={styles.detailPrice}>{detailService.price}</Text>
                  </Text>
                ) : null}
                {detailService?.description ? (
                  <Text style={styles.detailDescription}>
                    <Text style={styles.detailDescLabel}>{t('cartOrder.serviceModal.descLabel')}</Text>
                    {detailService.description}
                  </Text>
                ) : null}
              </View>

              {/* CENTER — other requests + photo upload (right section) */}
              <View style={styles.requestSection}>
                <Text style={styles.sectionLabel}>{t('cartOrder.serviceModal.otherRequests')}</Text>
                <TextInput
                  style={styles.requestInput}
                  multiline
                  maxLength={200}
                  placeholder={t('cartOrder.serviceModal.otherRequestsPlaceholder')}
                  placeholderTextColor={COLORS.gray[400]}
                  value={otherRequests}
                  onChangeText={setOtherRequests}
                />
                <Text style={styles.requestCounter}>{otherRequests.length}/200</Text>

                <Text style={[styles.sectionLabel, { marginTop: 12 }]}>{t('cartOrder.serviceModal.photoUpload')}</Text>
                <View style={styles.uploadRow}>
                  {modalPhotoUri ? (
                    <View style={styles.uploadPreviewWrap}>
                      <Image source={{ uri: modalPhotoUri }} style={styles.uploadPreview} />
                      <TouchableOpacity
                        style={styles.uploadRemove}
                        onPress={() => setModalPhotoUri(null)}
                      >
                        <Icon name="close" size={12} color={COLORS.white} />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <TouchableOpacity style={styles.uploadBtn} onPress={pickModalPhoto}>
                    <Icon name="add" size={20} color={COLORS.gray[500]} />
                    <Text style={styles.uploadBtnText}>{t('cartOrder.serviceModal.upload')}</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* BOTTOM — service categories (left section) */}
              <View style={styles.categoriesSection}>
                {servicesLoading ? (
                  <View style={styles.servicesLoadingWrap}>
                    <ActivityIndicator size="small" color={PRIMARY} />
                    <Text style={styles.servicesLoadingText}>
                      {t('cartOrder.serviceModal.loading')}
                    </Text>
                  </View>
                ) : servicesError ? (
                  <View style={styles.servicesErrorWrap}>
                    <Text style={styles.servicesErrorText}>{servicesError}</Text>
                    <TouchableOpacity
                      style={styles.servicesRetryBtn}
                      onPress={() => void loadAdditionalServices()}
                    >
                      <Text style={styles.servicesRetryText}>
                        {t('cartOrder.serviceModal.retry')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  serviceCategories.map((cat) => (
                    <View key={cat.id} style={styles.categoryBlock}>
                      <Text style={styles.categoryTitle}>
                        {tCategoryTitle(cat.id)}
                        {cat.required ? (
                          <Text style={styles.categoryRequired}>
                            {' '}
                            {t('cartOrder.serviceModal.required')}
                          </Text>
                        ) : null}
                      </Text>
                      <View style={styles.categoryGrid}>
                        {cat.items.map((svc) => {
                          const selected = pendingServices.some((s) => s.id === svc.id);
                          const focused = detailService?.id === svc.id;
                          return (
                            <TouchableOpacity
                              key={svc.id}
                              style={[
                                styles.serviceTile,
                                selected && styles.serviceTileSelected,
                                focused && !selected && styles.serviceTileFocused,
                              ]}
                              onPress={() => togglePendingService(svc)}
                            >
                              {svc.iconUrl ? (
                                <Image
                                  source={{ uri: svc.iconUrl }}
                                  style={styles.serviceTileIcon}
                                  resizeMode="contain"
                                />
                              ) : (
                                <Icon
                                  name="cube-outline"
                                  size={24}
                                  color={selected ? PRIMARY : COLORS.text.primary}
                                />
                              )}
                              {selected && (
                                <View style={styles.serviceTileCheck}>
                                  <Icon name="checkmark" size={10} color={COLORS.white} />
                                </View>
                              )}
                              <Text
                                style={[
                                  styles.serviceTileText,
                                  selected && styles.serviceTileTextSelected,
                                ]}
                                numberOfLines={2}
                              >
                                {svc.name}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  ))
                )}
              </View>
            </ScrollView>

            {/* Footer actions */}
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.modalFooterBtn, styles.modalCancelBtn]}
                onPress={closeServiceModal}
              >
                <Text style={styles.modalCancelText}>{t('cartOrder.serviceModal.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalFooterBtn, styles.modalConfirmBtn]}
                onPress={confirmServiceModal}
              >
                <Text style={styles.modalConfirmText}>{t('cartOrder.serviceModal.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  if (embedded) {
    return <View style={[styles.container, styles.embeddedContainer]}>{cartBody}</View>;
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {cartBody}
    </SafeAreaView>
  );
};

const PRIMARY = COLORS.red;
const PRIMARY_SOFT = 'rgba(255, 85, 0, 0.10)';

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  embeddedContainer: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  topSection: {
    backgroundColor: COLORS.white,
  },
  // PAGE TITLE
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  pageHeaderTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.secondary,
    marginLeft: 8,
  },
  pageHeaderLangBtn: {
    marginLeft: 'auto',
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pageHeaderLangFlag: {
    fontSize: 24,
  },
  // HEADER
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    zIndex: 10,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.gray[100],
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 36,
  },
  searchInput: {
    flex: 1,
    marginLeft: 6,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    padding: 0,
  },
  periodWrap: {
    marginHorizontal: 8,
    position: 'relative',
  },
  periodBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 10,
    paddingHorizontal: 8,
    height: 36,
  },
  periodText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    marginHorizontal: 4,
    fontWeight: '500',
  },
  periodMenu: {
    position: 'absolute',
    top: 40,
    right: 0,
    backgroundColor: COLORS.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    paddingVertical: 4,
    zIndex: 20,
    minWidth: 100,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  periodMenuItem: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  periodMenuText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  periodMenuTextActive: {
    color: PRIMARY,
    fontWeight: '600',
  },
  deleteBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PRIMARY,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  // 부가서비스 bar (under header)
  extraBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
    zIndex: 9,
  },
  extraLabel: {
    fontSize: FONTS.sizes.xs,
    // 부가서비스 label in the (single-card) order modal — match the
    // project's primary red, same tone as the negotiation header.
    color: PRIMARY,
    fontWeight: '700',
    marginRight: 8,
  },
  extraChipsScroll: {
    flex: 1,
    maxHeight: 28,
  },
  extraChipsContent: {
    alignItems: 'center',
    paddingRight: 8,
  },
  extraPlaceholder: {
    fontSize: 11,
    color: COLORS.gray[400],
    fontStyle: 'italic',
  },
  extraChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY_SOFT,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginRight: 6,
  },
  extraChipText: {
    fontSize: 11,
    color: PRIMARY,
    marginRight: 4,
    fontWeight: '600',
  },
  extraSelectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    shadowColor: PRIMARY,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  extraSelectBtnText: {
    fontSize: 11,
    color: COLORS.white,
    fontWeight: '700',
    marginLeft: 3,
  },
  orderExtraServiceSection: {
    marginTop: SPACING.md,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
  },
  negotiationSection: {
    marginTop: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
  },
  negotiationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.smmd,
    backgroundColor: COLORS.gray[100],
  },
  negotiationHeaderTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    // Project's primary red — keeps the single-card 협상내역 header
    // consistent with the multi-card per-row label.
    color: PRIMARY,
  },
  negotiationAddBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  negotiationBody: {
    padding: SPACING.md,
    gap: SPACING.sm,
    backgroundColor: COLORS.white,
  },
  negotiationImagesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  negotiationThumbWrap: {
    position: 'relative',
  },
  negotiationThumbRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.gray[700],
    alignItems: 'center',
    justifyContent: 'center',
  },
  negotiationInput: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 8,
    paddingHorizontal: SPACING.smmd,
    paddingVertical: SPACING.sm,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    backgroundColor: COLORS.white,
  },
  negotiationThumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  extraBarInOrderModal: {
    borderBottomWidth: 0,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
  },
  // MODAL
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '92%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  modalTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
    color: COLORS.text.primary,
  },
  modalBody: {
    maxHeight: '100%',
  },
  modalBodyContent: {
    paddingBottom: 12,
  },
  // Detail (top)
  detailSection: {
    padding: SPACING.md,
    backgroundColor: COLORS.gray[50],
    alignItems: 'flex-start',
  },
  detailImageWrap: {
    alignSelf: 'center',
    width: '100%',
    height: 160,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  detailServiceImage: {
    width: '100%',
    height: '100%',
  },
  detailServiceIconImage: {
    width: 96,
    height: 96,
  },
  servicesLoadingWrap: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  servicesLoadingText: {
    marginTop: 8,
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[500],
  },
  servicesErrorWrap: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  servicesErrorText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[600],
    textAlign: 'center',
    marginBottom: 12,
  },
  servicesRetryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: PRIMARY,
  },
  servicesRetryText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '700',
  },
  serviceTileIcon: {
    width: 28,
    height: 28,
  },
  detailName: {
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
    color: COLORS.text.primary,
    marginBottom: 6,
  },
  detailPriceRow: {
    marginBottom: 6,
  },
  detailPriceLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  detailPrice: {
    fontSize: FONTS.sizes.sm,
    color: PRIMARY,
    fontWeight: '700',
  },
  detailDescLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  detailDescription: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[600],
    lineHeight: Math.round(FONTS.sizes.sm * 20 / 14),
  },
  // Requests (center)
  requestSection: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  sectionLabel: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: 6,
  },
  requestInput: {
    minHeight: 80,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    textAlignVertical: 'top',
  },
  requestCounter: {
    fontSize: 10,
    color: COLORS.gray[500],
    textAlign: 'right',
    marginTop: 2,
  },
  uploadRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  uploadPreviewWrap: {
    marginRight: 8,
    position: 'relative',
  },
  uploadPreview: {
    width: 64,
    height: 64,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  uploadRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uploadBtn: {
    width: 64,
    height: 64,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.gray[50],
  },
  uploadBtnText: {
    fontSize: 10,
    color: COLORS.gray[500],
    marginTop: 2,
  },
  // Categories (bottom)
  categoriesSection: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  categoryBlock: {
    marginBottom: 16,
  },
  categoryTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.text.primary,
    marginBottom: 8,
  },
  categoryRequired: {
    fontSize: FONTS.sizes.xs,
    color: PRIMARY,
    fontWeight: '700',
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  serviceTile: {
    width: '23%',
    aspectRatio: 1,
    margin: '1%',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    position: 'relative',
  },
  serviceTileSelected: {
    borderColor: PRIMARY,
    backgroundColor: PRIMARY_SOFT,
  },
  serviceTileFocused: {
    borderColor: PRIMARY,
  },
  serviceTileCheck: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceTileText: {
    fontSize: 10,
    color: COLORS.text.primary,
    textAlign: 'center',
    marginTop: 4,
    fontWeight: '500',
  },
  serviceTileTextSelected: {
    color: PRIMARY,
    fontWeight: '700',
  },
  // Footer
  modalFooter: {
    flexDirection: 'row',
    padding: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    backgroundColor: COLORS.white,
  },
  modalFooterBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelBtn: {
    backgroundColor: COLORS.gray[100],
    marginRight: 8,
  },
  modalConfirmBtn: {
    backgroundColor: PRIMARY,
    shadowColor: PRIMARY,
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  modalCancelText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '700',
  },
  modalConfirmText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '800',
  },
  // BODY
  body: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  tabsRow: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    marginHorizontal: 4,
    borderRadius: 10,
    backgroundColor: COLORS.gray[100],
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    alignItems: 'center',
  },
  tabBtnActive: {
    backgroundColor: PRIMARY,
    borderColor: PRIMARY,
    shadowColor: PRIMARY,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  tabText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  tabTextActive: {
    color: COLORS.white,
    fontWeight: '700',
  },
  cardsList: {
    flex: 1,
  },
  cardsContent: {
    paddingHorizontal: SPACING.md,
    paddingTop: 6,
    paddingBottom: SPACING.lg,
  },
  bundleTableHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    marginBottom: 8,
  },
  bundleTableHeaderText: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
    color: COLORS.text.secondary,
    textAlign: 'center',
  },
  bundleTableHeaderTextLeft: {
    textAlign: 'left',
  },
  bundleTableColInfo: {
    flex: 1,
    minWidth: 0,
  },
  bundleTableColQty: {
    width: 36,
    alignItems: 'center',
  },
  bundleTableColPrice: {
    width: 64,
    alignItems: 'flex-end',
  },
  bundleTableColAmount: {
    width: 72,
    alignItems: 'flex-end',
  },
  bundleTableColManage: {
    width: 44,
    alignItems: 'center',
  },
  bundleGroup: {
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 12,
    marginBottom: 14,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
  },
  bundleGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: COLORS.gray[50],
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  bundleTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  bundleGroupTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  bundleHeaderQty: {
    width: 36,
    textAlign: 'center',
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  bundleHeaderAmount: {
    width: 72,
    textAlign: 'right',
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: PRIMARY,
  },
  bundleItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  bundleItemRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.gray[200],
  },
  bundleItemCheckCol: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bundleItemInfo: {
    flex: 1,
    minWidth: 0,
  },
  bundleItemInfoPress: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  bundleItemImage: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: COLORS.gray[100],
  },
  bundleItemTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  bundleItemTitle: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '500',
    lineHeight: Math.round(FONTS.sizes.xs * 16 / 12),
  },
  bundleItemSpec: {
    fontSize: 10,
    color: COLORS.text.secondary,
    marginTop: 2,
  },
  bundleItemQty: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
    textAlign: 'center',
  },
  bundleItemUnitPrice: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    textAlign: 'right',
  },
  bundleItemAmount: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '600',
    color: COLORS.text.primary,
    textAlign: 'right',
  },
  bundleItemDelete: {
    fontSize: FONTS.sizes.xs,
    color: PRIMARY,
    fontWeight: '600',
  },
  // CARD — stylish
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    marginBottom: 12,
    overflow: 'hidden',
    shadowColor: '#1A1A2E',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.03)',
  },
  cardAccent: {
    height: 3,
    backgroundColor: PRIMARY,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  checkBtn: {
    padding: 2,
    marginRight: 8,
  },
  checkBox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
  },
  checkBoxChecked: {
    backgroundColor: PRIMARY,
    borderColor: PRIMARY,
  },
  companyWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  indexBadge: {
    fontSize: 10,
    color: COLORS.white,
    fontWeight: '700',
    backgroundColor: PRIMARY,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 8,
    overflow: 'hidden',
  },
  companyName: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  photoBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: PRIMARY_SOFT,
    borderWidth: 1,
    borderColor: 'rgba(255, 85, 0, 0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPreview: {
    width: 32,
    height: 32,
    borderRadius: 8,
  },
  // MIDDLE
  cardMiddle: {
    flexDirection: 'row',
    // 카드 펼침 시 productInfo 의 높이가 커져도 이미지 / 우측 가격·수량 영역이
    // 가운데로 내려오지 않게 상단 정렬. 펼침 상세는 productInfo 안에서만
    // 아래쪽으로 늘어나고 다른 컬럼은 카드 상단에 고정.
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  middleLeft: {
    flex: 1,
    flexDirection: 'row',
    // 이미지가 productInfo 의 첫 줄(옵션명) 과 같은 라인에 고정되도록 상단 정렬.
    alignItems: 'flex-start',
  },
  productImagePressable: {
    marginRight: 10,
  },
  productImage: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: COLORS.gray[100],
  },
  productImagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  productInfo: {
    flex: 1,
  },
  productNameBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: COLORS.gray[50],
    marginBottom: 6,
  },
  productName: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  metaTag: {
    fontSize: 10,
    color: COLORS.gray[600],
    backgroundColor: COLORS.gray[100],
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginRight: 4,
    marginBottom: 2,
    overflow: 'hidden',
  },
  middleCenter: {
    width: 100,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY_SOFT,
    borderRadius: 999,
    padding: 2,
    marginBottom: 6,
  },
  qtyBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyValue: {
    width: 32,
    textAlign: 'center',
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  unitPriceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 6,
    backgroundColor: COLORS.white,
    paddingHorizontal: 8,
    height: 28,
    width: '100%',
    justifyContent: 'center',
  },
  yenMark: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    marginRight: 2,
    fontWeight: '600',
  },
  unitPriceInput: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    padding: 0,
    textAlign: 'center',
    fontWeight: '600',
  },
  middleRight: {
    width: 84,
    alignItems: 'flex-end',
    paddingLeft: 4,
  },
  // 카드 우측 인라인 영역 — 단가 ¥ 텍스트 + 수량 stepper 를 한 줄에 나란히.
  // 사용자 디자인: " ¥ 1.78   [−] 2 [+] " 형태.
  middleRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 4,
  },
  unitPriceTextInline: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  // 카드의 옵션 드롭다운 펼침 시 표시되는 상세 영역.
  // 메타칩 아래에 짧은 키/값 라인들을 쌓아 보여줌.
  cardExpandedDetails: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    gap: 2,
  },
  cardExpandedLabel: {
    fontSize: 10,
    color: COLORS.gray[500],
    fontWeight: '600',
  },
  cardExpandedValue: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
  },
  rightLabel: {
    fontSize: 10,
    color: COLORS.gray[500],
    marginBottom: 2,
  },
  rightValue: {
    fontSize: FONTS.sizes.md,
    color: PRIMARY,
    fontWeight: '800',
    marginBottom: 8,
  },
  viewMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: PRIMARY_SOFT,
  },
  viewMoreText: {
    fontSize: 10,
    color: PRIMARY,
    fontWeight: '700',
    marginRight: 2,
  },
  // BOTTOM
  cardBottom: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    backgroundColor: COLORS.gray[50],
  },
  remarksLabel: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[600],
    fontWeight: '700',
    marginBottom: 4,
  },
  remarksInput: {
    minHeight: 52,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    textAlignVertical: 'top',
  },
  remarksCounter: {
    fontSize: 10,
    color: COLORS.gray[500],
    textAlign: 'right',
    marginTop: 2,
  },
  bottomActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 8,
  },
  bottomActionsCompact: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  labelRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: PRIMARY,
    marginRight: 6,
  },
  labelRowText: {
    fontSize: 11,
    color: COLORS.white,
    fontWeight: '700',
    marginLeft: 3,
  },
  deleteRowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: PRIMARY_SOFT,
  },
  deleteRowText: {
    fontSize: 11,
    color: PRIMARY,
    fontWeight: '700',
    marginLeft: 3,
  },
  emptyWrap: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.gray[500],
  },
  retryButton: {
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.primary,
    borderRadius: 8,
  },
  retryButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '600',
  },
  // Empty cart state
  emptyCartWrap: {
    marginHorizontal: SPACING.md,
    marginTop: SPACING.xl,
    paddingVertical: SPACING.xl,
    paddingHorizontal: SPACING.lg,
    backgroundColor: COLORS.lightRed,
    borderRadius: 16,
    alignItems: 'center',
  },
  emptyCartImage: {
    width: 98,
    height: 98,
  },
  emptyCartTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
    textAlign: 'center',
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  emptyCartButton: {
    width: '100%',
    paddingVertical: SPACING.md,
    backgroundColor: COLORS.black,
    borderRadius: 12,
    alignItems: 'center',
  },
  emptyCartButtonText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.white,
  },
  // Summary bar
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
  },
  summaryText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    marginRight: 12,
    fontWeight: '500',
  },
  summaryTotal: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: PRIMARY,
    fontWeight: '800',
  },
  orderBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 10,
    shadowColor: PRIMARY,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  selectAllToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: SPACING.sm,
    paddingVertical: 4,
  },
  selectAllCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.gray[400],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    marginRight: 6,
  },
  selectAllCircleChecked: {
    backgroundColor: PRIMARY,
    borderColor: PRIMARY,
  },
  selectAllText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  // Wrapper around the per-card list rendered inside the order
  // modal when 2+ cart cards are selected. Adds a small vertical
  // breathing room above and below the card stack.
  orderModalCardsList: {
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  // Multi-card order modal — per-card row layout. The image+name
  // (left) and negotiation block (right) sit on the top row; the
  // extra-service selector sits underneath as a centred bar.
  orderModalCard: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    padding: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  orderModalCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  orderModalCardLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  orderModalCardImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
  },
  orderModalCardImagePlaceholder: {
    backgroundColor: COLORS.gray[100],
  },
  orderModalCardInfo: {
    flex: 1,
    minWidth: 0,
  },
  orderModalCardName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  orderModalCardOption: {
    marginTop: 2,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  orderModalCardQty: {
    marginTop: 2,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  orderModalCardRight: {
    flex: 1,
    minWidth: 0,
  },
  orderModalCardSectionLabel: {
    fontSize: FONTS.sizes.xs,
    // Project's primary red — used for the "협상내역" label so
    // negotiation / extra-service controls share one consistent
    // brand colour inside the order modal.
    color: PRIMARY,
    marginBottom: 4,
    fontWeight: '700',
  },
  // Header row for the per-card negotiation block:
  //   "협상내역 (n)"  ⊕
  // The label is right-aligned (`flex: 1` + `textAlign: right`) and
  // the "+" sits flush to the rightmost edge of the card's right
  // column, exactly matching the user's spec.
  orderModalCardNegHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    marginBottom: 4,
  },
  orderModalCardNegLabel: {
    textAlign: 'right',
    marginBottom: 0,
  },
  orderModalCardNegLabelClickable: {
    // Same red as the default label (already PRIMARY above), with
    // an underline to indicate "tap to open the image gallery".
    color: PRIMARY,
    textDecorationLine: 'underline',
  },
  orderModalCardNegAddBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    // Red border + red "+" glyph to match the negotiation label.
    borderColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
  },
  // Styles for the negotiation-image gallery modal (opens when the
  // shopper taps the 협상내역 label on a card row).
  negotiationGalleryEmpty: {
    textAlign: 'center',
    paddingVertical: SPACING.lg,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  negotiationGalleryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    padding: SPACING.sm,
  },
  negotiationGalleryItem: {
    width: 96,
    height: 96,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: COLORS.gray[100],
  },
  negotiationGalleryImage: {
    width: '100%',
    height: '100%',
  },
  negotiationGalleryRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderModalCardRemarks: {
    marginTop: 4,
    minHeight: 48,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  // 비고 자리에 들어가는 수량 stepper + 단가 입력 + 총가격 행.
  orderModalCardPriceRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  orderModalCardQtyControl: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY_SOFT,
    borderRadius: 999,
    padding: 2,
  },
  orderModalCardQtyBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderModalCardQtyValue: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
    color: COLORS.text.primary,
    paddingHorizontal: 4,
  },
  orderModalCardUnitPriceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 6,
    backgroundColor: COLORS.white,
    paddingHorizontal: 6,
    height: 26,
    minWidth: 64,
    flexShrink: 1,
  },
  orderModalCardYenMark: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    marginRight: 2,
    fontWeight: '600',
  },
  orderModalCardUnitPriceInput: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    padding: 0,
    textAlign: 'center',
    fontWeight: '600',
  },
  orderModalCardTotalPrice: {
    marginLeft: 'auto',
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: PRIMARY,
  },
  // 더보기/접기 토글 — 카드 우하단. 우측 정렬 + 살구색 톤.
  orderModalCardExpandRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  orderModalCardExpandBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: PRIMARY_SOFT,
    borderRadius: 8,
  },
  orderModalCardExpandText: {
    fontSize: 10,
    color: PRIMARY,
    fontWeight: '600',
  },
  // 펼친 상태의 비고 + 라벨 + 삭제 영역. 카트 본문 카드의 cardBottom 과
  // 시각이 동일하도록 같은 자식 스타일(remarksLabel/Input/Counter/bottomActions/labelRowBtn/deleteRowBtn) 재사용.
  orderModalCardExpanded: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
  },
  orderModalCardNegImagesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 4,
  },
  orderModalCardNegThumbWrap: {
    width: 36,
    height: 36,
    borderRadius: 6,
    overflow: 'hidden',
    position: 'relative',
  },
  orderModalCardNegThumb: {
    width: '100%',
    height: '100%',
  },
  orderModalCardNegThumbRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderModalCardServiceBar: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
  },
  orderModalCardServicePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: SPACING.sm,
    borderRadius: 8,
    borderWidth: 1,
    // Red dashed outline so the "select extra service" affordance
    // visually matches the red 협상내역 label above it.
    borderColor: PRIMARY,
    borderStyle: 'dashed',
    backgroundColor: COLORS.white,
  },
  orderModalCardServicePickerText: {
    fontSize: FONTS.sizes.xs,
    color: PRIMARY,
    fontWeight: '700',
  },
  orderBtnEnabled: {
    backgroundColor: PRIMARY,
    shadowOpacity: 0.55,
    shadowRadius: 12,
    elevation: 6,
  },
  orderBtnText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    fontWeight: '800',
  },
  // Label modal
  labelSection: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  labelSectionLabel: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.text.primary,
    marginBottom: 8,
  },
  labelHint: {
    fontSize: 11,
    color: COLORS.gray[500],
    marginTop: 6,
  },
  labelHintInline: {
    fontSize: 11,
    color: COLORS.gray[500],
  },
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  radioOption: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
    marginBottom: 4,
  },
  radioOuter: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
    backgroundColor: COLORS.white,
  },
  radioOuterOn: {
    borderColor: PRIMARY,
  },
  radioInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: PRIMARY,
  },
  radioText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  previewWrap: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  previewCard: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: 6,
    padding: 10,
    position: 'relative',
  },
  previewCard5080: {
    width: 200,
    height: 320,
  },
  previewCard4060: {
    width: 280,
    height: 180,
  },
  foodBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: 10,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  foodBadgeText: {
    fontSize: 9,
    color: COLORS.text.primary,
    marginLeft: 2,
    fontWeight: '600',
  },
  previewProductName: {
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: 4,
  },
  previewContent: {
    fontSize: 10,
    color: COLORS.text.primary,
    lineHeight: 14,
    marginBottom: 8,
  },
  barcodePreview: {
    marginTop: 'auto',
    alignItems: 'center',
  },
  barcodeLines: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 40,
  },
  barcodeBar: {
    height: '100%',
    backgroundColor: '#000',
    marginRight: 1,
  },
  barcodeBarThick: {
    backgroundColor: '#000',
  },
  barcodeText: {
    fontSize: 10,
    color: '#000',
    marginTop: 2,
    letterSpacing: 1,
  },
  dimensionLabel: {
    marginTop: 8,
  },
  dimensionText: {
    fontSize: 11,
    color: COLORS.gray[500],
    fontWeight: '600',
  },
  fontToolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: COLORS.gray[50],
    borderRadius: 8,
    padding: 4,
    marginBottom: 10,
  },
  fontChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: COLORS.white,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    marginRight: 4,
    marginBottom: 4,
  },
  fontChipText: {
    fontSize: 11,
    color: COLORS.text.primary,
  },
  labelInputLabel: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[600],
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
  },
  labelInput: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  labelContentInput: {
    minHeight: 100,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    textAlignVertical: 'top',
  },
  labelFilePreviewWrap: {
    marginTop: 10,
    width: 80,
    height: 80,
    position: 'relative',
  },
  labelFilePreview: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  // Order modal
  orderSection: {
    paddingHorizontal: SPACING.md,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  centerMetaLoadingWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  centerMetaLoadingText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  orderSectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  orderSectionBar: {
    width: 3,
    height: 14,
    borderRadius: 2,
    backgroundColor: PRIMARY,
    marginRight: 6,
  },
  orderSectionTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.text.primary,
  },
  orderFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  orderFieldCol: {
    marginBottom: 12,
  },
  orderFieldLabel: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
    color: COLORS.text.primary,
    width: 96,
    marginBottom: 4,
  },
  pillGroup: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    backgroundColor: COLORS.white,
    marginRight: 6,
    marginBottom: 6,
  },
  pillActive: {
    borderColor: PRIMARY,
    backgroundColor: PRIMARY_SOFT,
  },
  pillText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  pillTextActive: {
    color: PRIMARY,
    fontWeight: '800',
  },
  helpBtn: {
    padding: 4,
  },
  tooltipBox: {
    backgroundColor: PRIMARY_SOFT,
    borderWidth: 1,
    borderColor: PRIMARY,
    borderRadius: 8,
    padding: 8,
    marginTop: 4,
  },
  tooltipText: {
    fontSize: 11,
    color: PRIMARY,
    lineHeight: 16,
  },
  selectBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: COLORS.white,
  },
  selectBtnText: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  deliveryAddressSection: {
    marginTop: 14,
  },
  deliveryAddressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    marginBottom: 10,
    gap: 8,
  },
  deliveryAddressTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
    color: COLORS.text.primary,
    flexShrink: 0,
  },
  deliveryAddressActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  deliveryAddressActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
  },
  deliveryAddressIconCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.gray[200],
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 5,
  },
  deliveryAddressActionText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  deliveryAddressEmptyBox: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.gray[300],
    borderRadius: 8,
    paddingVertical: 28,
    paddingHorizontal: 14,
    minHeight: 72,
    justifyContent: 'center',
  },
  deliveryAddressEmptyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[400],
  },
  deliveryAddressFilledBox: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.gray[300],
    borderRadius: 8,
    paddingVertical: 20,
    paddingHorizontal: 14,
    minHeight: 72,
    justifyContent: 'center',
  },
  // ── 배송주소 선택 오버레이 (발주모달 내부 절대위치) ─────────────
  addrSelectOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  addrSelectBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  addrSelectCard: {
    width: '86%',
    maxHeight: '70%',
    backgroundColor: COLORS.white,
    borderRadius: 14,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
  },
  addrSelectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  addrSelectTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    textAlign: 'center',
    paddingBottom: SPACING.sm,
  },
  addrSelectDivider: {
    height: 1,
    backgroundColor: COLORS.gray[200],
    marginHorizontal: -SPACING.md,
  },
  addrSelectCancelBtn: {
    paddingVertical: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addrSelectCancelText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  addrSelectList: {
    flexGrow: 0,
  },
  addrSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  addrSelectRowSelected: {
    backgroundColor: COLORS.primary + '10',
    borderRadius: 8,
  },
  addrSelectRowText: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 1.4),
  },
  addrSelectRowTextOn: {
    color: COLORS.primary,
    fontWeight: '700',
  },
  addrRadioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.gray[400],
    alignItems: 'center',
    justifyContent: 'center',
  },
  addrRadioOuterOn: {
    borderColor: COLORS.primary,
  },
  addrRadioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.primary,
  },
  deliveryAddressFilledText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  depositBalanceText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginBottom: SPACING.sm,
    fontWeight: '600',
  },
  orderBtnDisabled: {
    backgroundColor: COLORS.gray[400],
    opacity: 0.85,
    shadowOpacity: 0,
    elevation: 0,
  },
});

export default CartScreen;

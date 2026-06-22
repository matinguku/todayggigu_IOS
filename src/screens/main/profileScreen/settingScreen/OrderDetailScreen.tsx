import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Modal,
  TextInput,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import Icon from '../../../../components/Icon';
import { fetchAdditionalServices } from '../../../../services/additionalServicesApi';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { COLORS, FONTS, SPACING, BORDER_RADIUS } from '../../../../constants';
import { useToast } from '../../../../context/ToastContext';
import {
  coerceDisplayText,
  formatPriceKRW,
  resolveOrderItemCompanyName,
} from '../../../../utils/i18nHelpers';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
  ORDER_DETAIL_TIMELINE_STEPS,
  type OrderDetailTimelineStep,
  resolveOrderDetailStatusSubtitleKey,
  resolveOrderDetailStatusTitleKey,
  resolveOrderDetailStepIndex,
  isShipmentStepBorderActive,
  isCompleteStepBorderActive,
} from '../../../../utils/orderDetailProgress';
import {
  hasOrderItemLabel,
  resolveOrderItemLabel,
  resolveOrderItemNote,
  resolveOrderItemProductStatusLabel,
  type ResolvedOrderItemLabel,
} from '../../../../utils/orderItemLabel';
import {
  Order,
  OrderItem,
  orderApi,
  resolveOrderItemUnitPrice,
  resolveOrderTotalKRW,
} from '../../../../services/orderApi';
import { useProfileTabletEmbedNavigation } from '../ProfileTabletEmbedContext';

type DetailTab = 'products' | 'photos';

const SCREEN_WIDTH = Dimensions.get('window').width;
const INFO_COLUMN_WIDTH = Math.max(168, Math.floor(SCREEN_WIDTH * 0.42));

const formatOrderDateTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
};

const formatCny = (value: number): string => `¥ ${value.toFixed(2)}`;

const translateOrderOptionLabel = (value: string, translate: (key: string) => string): string => {
  if (!value) return '';
  const key = `cartOrder.orderModal.optionLabels.${value}`;
  const translated = translate(key);
  return translated !== key ? translated : value;
};

const paymentMethodLabel = (
  method: string | undefined,
  t: (key: string) => string,
): string => {
  const m = String(method ?? '').toLowerCase();
  if (m === 'deposit') return t('payment.deposit') || 'Deposit';
  if (m === 'bank') return t('profile.unitSurvey.tabBankTransfer') || 'Bank';
  if (m === 'card' || m === 'credit_card') return t('payment.creditCard') || 'Card';
  return method || '';
};

type OrderDetailScreenProps = {
  embedded?: boolean;
  embeddedOrderId?: string;
  embeddedOrder?: Order;
  onEmbeddedBack?: () => void;
};

const OrderDetailScreen: React.FC<OrderDetailScreenProps> = ({
  embedded = false,
  embeddedOrderId,
  embeddedOrder,
  onEmbeddedBack,
}) => {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { t, locale } = useTranslation();
  const { showToast } = useToast();
  const { tryEmbedNavigate } = useProfileTabletEmbedNavigation(embedded);

  const initialOrder = embedded ? embeddedOrder : route.params?.order;
  const orderId =
    (embedded ? embeddedOrderId : route.params?.orderId) || initialOrder?.id;

  const handleBack = () => {
    if (embedded && onEmbeddedBack) {
      onEmbeddedBack();
      return;
    }
    navigation.goBack();
  };

  const [order, setOrder] = useState<any>(initialOrder ?? null);
  const [loading, setLoading] = useState(!initialOrder);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('products');
  const [labelViewer, setLabelViewer] = useState<ResolvedOrderItemLabel | null>(null);
  // 부가서비스 카탈로그 (서비스 id → 아이콘/이름). 주문 아이템의 addServices[].id
  // 를 이 카탈로그와 매핑해 해당 부가서비스 아이콘을 표시한다.
  const [serviceCatalog, setServiceCatalog] = useState<
    Record<string, { icon?: string; imageUrl?: string; name: string }>
  >({});
  // 날짜 클릭 시 뜨는 예정일(업체출고/창고도착/국제출고) 모달.
  const [scheduleModalVisible, setScheduleModalVisible] = useState(false);
  // 입고사진 뷰어 — 관리자가 입고스캔 때 올린 사진을 크게 본다.
  const [inboundPhotoViewer, setInboundPhotoViewer] = useState<string[] | null>(null);

  // 부가서비스 카탈로그 1회 로드 (아이콘 매핑용).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchAdditionalServices();
        if (!alive || !res.success || !Array.isArray(res.data)) return;
        const map: Record<string, { icon?: string; imageUrl?: string; name: string }> = {};
        for (const s of res.data) {
          if (s && s.id != null) {
            map[String(s.id)] = { icon: s.icon, imageUrl: s.imageUrl, name: s.name };
          }
        }
        setServiceCatalog(map);
      } catch {
        /* 카탈로그 로드 실패해도 부가서비스는 "-" 로 표시 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const loadOrder = useCallback(async () => {
    if (!orderId) {
      setLoadError(t('profile.orderNotFound'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await orderApi.getOrderById(orderId, locale);
      if (res.success && res.data?.order) {
        setOrder(res.data.order);
      } else {
        setLoadError(res.error || t('profile.orderDetailPage.loadFailed'));
      }
    } catch {
      setLoadError(t('profile.orderDetailPage.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [orderId, locale, t]);

  useFocusEffect(
    useCallback(() => {
      void loadOrder();
    }, [loadOrder]),
  );

  const dash = t('profile.orderDetailPage.dash');
  const unknownStoreLabel = t('profile.unknownStore');

  const copy = (text: string) => {
    Clipboard.setString(text);
    showToast(t('profile.copied'), 'success');
  };

  const resolveStoreName = (item: OrderItem): string =>
    resolveOrderItemCompanyName(item, locale) ||
    coerceDisplayText(item?.companyName as any, locale, '') ||
    unknownStoreLabel;

  const formatSkuLines = (item: OrderItem): { label: string; value: string }[] => {
    const attrs = item.skuAttributes ?? [];
    const lines: { label: string; value: string }[] = [];
    if (attrs[0]) {
      lines.push({
        label: t('profile.orderDetailPage.color'),
        value:
          coerceDisplayText(attrs[0].valueMultiLang, locale, '') ||
          attrs[0].valueTrans ||
          attrs[0].value ||
          '',
      });
    }
    if (attrs[1]) {
      lines.push({
        label: t('profile.orderDetailPage.size'),
        value:
          coerceDisplayText(attrs[1].valueMultiLang, locale, '') ||
          attrs[1].valueTrans ||
          attrs[1].value ||
          '',
      });
    }
    const addServiceCount = item.addServices?.length ?? 0;
    lines.push({
      label: t('profile.orderDetailPage.additionalService'),
      value:
        addServiceCount > 0
          ? String(addServiceCount)
          : t('profile.orderDetailPage.none'),
    });
    return lines.filter((line) => line.value);
  };

  const stepIndex = useMemo(
    () => resolveOrderDetailStepIndex(order?.progressStatus),
    [order?.progressStatus],
  );

  const shipmentBorderActive = useMemo(
    () => isShipmentStepBorderActive(order?.progressStatus),
    [order?.progressStatus],
  );

  const completeBorderActive = useMemo(
    () => isCompleteStepBorderActive(order?.progressStatus),
    [order?.progressStatus],
  );

  const statusTitle = useMemo(() => {
    const key = resolveOrderDetailStatusTitleKey(order?.progressStatus);
    const label = t(key);
    return label !== key ? label : order?.progressStatus ?? '';
  }, [order?.progressStatus, t]);

  const statusSubtitle = useMemo(() => {
    const key = resolveOrderDetailStatusSubtitleKey(order?.progressStatus);
    const label = t(key);
    return label !== key ? label : '';
  }, [order?.progressStatus, t]);

  const address = order?.shippingAddress;
  // 예정일(업체출고/창고도착/국제출고). Order 는 [key:string]:any 라 백엔드가
  // 어떤 키로 주든 여러 후보를 폴백으로 읽고, 없으면 "-" 로 표시(스크린샷과 동일).
  const pickScheduleDate = (...keys: string[]): string => {
    const o = order as Record<string, any> | null;
    if (!o) return dash;
    for (const k of keys) {
      const v = o[k] ?? o.orderMainInfo?.[k];
      if (v) {
        const d = formatOrderDateTime(v).split(' ')[0];
        if (d) return d;
      }
    }
    return dash;
  };
  const scheduleDates = {
    supplierShip: pickScheduleDate(
      'supplierShipExpectedDate', 'factoryShipExpectedDate',
      'vendorDispatchExpectedDate', 'supplierDispatchExpectedDate', 'supplierShipDate',
    ),
    warehouseArrival: pickScheduleDate(
      'warehouseArrivalExpectedDate', 'warehouseArrivalDate',
      'centerArrivalExpectedDate', 'centerArrivalDate',
    ),
    intlShip: pickScheduleDate(
      'internationalShipExpectedDate', 'intlShipExpectedDate',
      'overseasShipExpectedDate', 'internationalShipDate',
    ),
  };
  const orderMainInfo = order?.orderMainInfo ?? {};
  const firstTier = order?.firstTierCost ?? {};
  const paidPayment = (order?.orderPayments ?? []).find(
    (p: any) => p.status === 'paid',
  );
  const paymentKRW =
    coerceAmount(paidPayment?.amountKRW) ||
    coerceAmount(firstTier.totalKRW) ||
    resolveOrderTotalKRW(order ?? {});

  const totalQty = (order?.items ?? []).reduce(
    (sum: number, item: OrderItem) => sum + (item.quantity || 0),
    0,
  );
  const productTotalCny =
    coerceAmount((order as any)?.sumProductPayment) ||
    coerceAmount(firstTier.totalCNY) ||
    (order?.items ?? []).reduce((sum: number, item: OrderItem) => {
      const unit = resolveOrderItemUnitPrice(item);
      return sum + unit * (item.quantity || 1);
    }, 0);
  const feeCny = coerceAmount((order as any)?.sellerShippingFee) || 0;
  const serviceFeeKrw = coerceAmount(firstTier.serviceFeeAmountKRW) || 0;

  const createdStepDate =
    order?.statusHistory?.[0]?.timestamp || order?.createdAt;

  const logisticsCenter = translateOrderOptionLabel(
    String(orderMainInfo.logisticsCenter ?? ''),
    t,
  );
  const shippingMethodLabel = translateOrderOptionLabel(
    String(orderMainInfo.shippingMethod ?? orderMainInfo.transferMethod ?? ''),
    t,
  );

  const allInboundPhotos = (order?.items ?? []).flatMap(
    (item: OrderItem) => item.incomeImgUrl ?? [],
  );
  const allIssuePhotos = (order?.items ?? []).flatMap(
    (item: OrderItem) => item.issueImgUrl ?? [],
  );

  const handleOrderInquiry = () => {
    if (
      !tryEmbedNavigate('Chat', {
        inquiryId: order?.inquiryId || undefined,
        orderId: order?.id,
        orderNumber: order?.orderNumber,
      })
    ) {
      navigation.navigate('Chat', {
        inquiryId: order?.inquiryId || undefined,
        orderId: order?.id,
        orderNumber: order?.orderNumber,
      });
    }
  };

  const renderSectionHeading = (label: string) => (
    <View style={styles.sectionHeading}>
      <View style={styles.sectionBar} />
      <Text style={styles.sectionHeadingText}>{label}</Text>
    </View>
  );

  const renderInfoField = (label: string, value?: string | number | null) => (
    <View style={styles.infoField}>
      <Text style={styles.infoFieldLabel}>{label}</Text>
      <Text style={styles.infoFieldValue}>
        {value == null || value === '' ? dash : String(value)}
      </Text>
    </View>
  );

  const TIMELINE_ICON_NAMES: Record<OrderDetailTimelineStep['icon'], string> = {
    receipt: 'receipt-outline',
    document: 'document-text-outline',
    card: 'card',
    cart: 'cart-outline',
    warehouse: 'cube',
    truck: 'delivery',
    check: 'checkmark',
  };

  const renderTimelineIcon = (
    icon: OrderDetailTimelineStep['icon'],
    active: boolean,
    borderOnly = false,
  ) => {
    const iconColor = active ? COLORS.white : borderOnly ? COLORS.red : COLORS.gray[400];
    return (
      <View
        style={[
          styles.timelineIconWrap,
          active
            ? styles.timelineIconWrapActive
            : borderOnly
              ? styles.timelineIconWrapBorderActive
              : styles.timelineIconWrapInactive,
        ]}
      >
        <Icon name={TIMELINE_ICON_NAMES[icon]} size={18} color={iconColor} />
      </View>
    );
  };

  const renderProductRow = (item: OrderItem, index: number) => {
    const title =
      coerceDisplayText(item.subjectMultiLang, locale, '') ||
      coerceDisplayText(item.subjectTrans, locale, '') ||
      coerceDisplayText(item.subject, locale, '') ||
      '';
    const unitPrice = resolveOrderItemUnitPrice(item);
    const lineAmount = coerceAmount(item.subtotal) || unitPrice * (item.quantity || 1);
    const specLines = formatSkuLines(item);
    const storeName = resolveStoreName(item);
    const is1688 = String(item.otherSite ?? item.source ?? '').includes('1688');
    const statusText =
      resolveOrderItemProductStatusLabel(item.productStatus, t) || dash;
    const noteText = resolveOrderItemNote(item) || dash;
    const labelConfigured = hasOrderItemLabel(item.barcodeInfo);
    const resolvedLabel = resolveOrderItemLabel(item, title);
    // 부가서비스 목록 — addServices[].id 를 카탈로그와 매핑해 아이콘 표시. 없으면 "-".
    const addServiceList = (Array.isArray(item.addServices) ? item.addServices : []) as Array<{
      id?: string | number;
    }>;
    // 입고사진(관리자가 입고스캔 때 올린 사진). 없으면 "-".
    const inboundPhotos = (Array.isArray(item.incomeImgUrl) ? item.incomeImgUrl : []).filter(
      (u): u is string => typeof u === 'string' && !!u,
    );

    return (
      <View key={item.id || item._id || index} style={styles.productCard}>
        <View style={styles.productCardHeader}>
          {is1688 ? (
            <View style={styles.platformBadge}>
              <Text style={styles.platformBadgeText}>1688</Text>
            </View>
          ) : null}
          <Text style={styles.storeNameText} numberOfLines={1}>
            {storeName}
          </Text>
        </View>
        <View style={styles.productMainRow}>
          <Image
            source={{ uri: item.imageUrl }}
            style={styles.productThumb}
            resizeMode="cover"
          />
          <View style={styles.productMainCol}>
            <Text style={styles.productTitle} numberOfLines={2}>
              {title}
            </Text>
            {specLines.map((line, i) => (
              <Text key={i} style={styles.productSpecLine} numberOfLines={1}>
                {line.label}: {line.value}
              </Text>
            ))}
          </View>
        </View>
        <View style={styles.productMetricsGrid}>
          <View style={styles.metricCell}>
            <Text style={styles.metricLabel}>{t('profile.orderDetailPage.quantity')}</Text>
            <Text style={styles.metricValue}>{item.quantity}</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricLabel}>{t('profile.orderDetailPage.unitPrice')}</Text>
            <Text style={styles.metricValue}>{formatPriceKRW(unitPrice)}</Text>
          </View>
          <View style={styles.metricCell}>
            <Text style={styles.metricLabel}>{t('profile.orderDetailPage.amount')}</Text>
            <Text style={[styles.metricValue, styles.metricValueAccent]}>
              {formatPriceKRW(lineAmount)}
            </Text>
          </View>
        </View>
        {/* 부가서비스 — 없으면 "-", 있으면 해당 부가서비스 아이콘 */}
        <View style={styles.productMetaRow}>
          <Text style={styles.productMetaLabel}>{t('profile.orderDetailPage.additionalService')}</Text>
          {addServiceList.length > 0 ? (
            <View style={styles.addServiceIconRow}>
              {addServiceList.map((svc, i) => {
                const cat = serviceCatalog[String(svc?.id ?? '')];
                const iconUri = cat?.icon || cat?.imageUrl;
                return iconUri ? (
                  <Image
                    key={`${svc?.id ?? i}`}
                    source={{ uri: iconUri }}
                    style={styles.addServiceIcon}
                    resizeMode="contain"
                  />
                ) : (
                  <View key={`${svc?.id ?? i}`} style={styles.addServiceIconFallback}>
                    <Icon name="construct-outline" size={14} color={COLORS.primary} />
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={styles.productMetaValue}>{dash}</Text>
          )}
        </View>
        {/* 상태 — 입고 상태(미입고/입고완료 등) */}
        <View style={styles.productMetaRow}>
          <Text style={styles.productMetaLabel}>{t('profile.orderDetailPage.status')}</Text>
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>{statusText}</Text>
          </View>
        </View>
        {/* 날짜 — 클릭 시 예정일(업체출고/창고도착/국제출고) 모달 */}
        <View style={styles.productMetaRow}>
          <Text style={styles.productMetaLabel}>{t('profile.orderDetailPage.date')}</Text>
          <TouchableOpacity
            onPress={() => setScheduleModalVisible(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.productMetaValue, styles.productMetaDate]}>
              {formatOrderDateTime(order?.createdAt).split(' ')[0] || dash}
            </Text>
          </TouchableOpacity>
        </View>
        {/* 사진 — 관리자 입고사진. 없으면 "-", 있으면 보기 */}
        <View style={styles.productMetaRow}>
          <Text style={styles.productMetaLabel}>{t('profile.orderDetailPage.photo')}</Text>
          {inboundPhotos.length > 0 ? (
            <TouchableOpacity
              onPress={() => setInboundPhotoViewer(inboundPhotos)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.labelCheckLink}>
                {t('profile.orderDetailPage.labelCheckView')}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.productMetaValue}>{dash}</Text>
          )}
        </View>
        {/* 라벨확인 */}
        <View style={styles.productMetaRow}>
          <Text style={styles.productMetaLabel}>{t('profile.orderDetailPage.labelCheck')}</Text>
          {labelConfigured && resolvedLabel ? (
            <TouchableOpacity
              onPress={() => setLabelViewer(resolvedLabel)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.labelCheckLink}>
                {t('profile.orderDetailPage.labelCheckView')}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.productMetaValue}>{dash}</Text>
          )}
        </View>
        {/* 비고 */}
        <View style={styles.productMetaRow}>
          <Text style={styles.productMetaLabel}>{t('profile.orderDetailPage.note')}</Text>
          <Text style={styles.productMetaValue} numberOfLines={2}>
            {noteText}
          </Text>
        </View>
      </View>
    );
  };

  const renderPhotoSection = (
    title: string,
    count: number,
    photos: string[],
  ) => (
    <View style={styles.photoSection}>
      {renderSectionHeading(`${title} ${count}`)}
      {photos.length === 0 ? (
        <View style={styles.emptyPhotoBox}>
          <Icon name="mail-open-outline" size={42} color={COLORS.gray[300]} />
          <Text style={styles.emptyPhotoText}>{t('profile.orderDetailPage.noData')}</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {photos.map((uri, idx) => (
            <Image key={`${uri}-${idx}`} source={{ uri }} style={styles.photoThumb} />
          ))}
        </ScrollView>
      )}
    </View>
  );

  const renderHeader = () => (
    embedded ? (
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Icon name="arrow-back" size={22} color={COLORS.text.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('profile.orderDetails')}</Text>
        <View style={styles.headerSpacer} />
      </View>
    ) : (
      <SafeAreaView style={styles.headerSafeArea} edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} style={styles.backButton}>
            <Icon name="arrow-back" size={22} color={COLORS.text.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('profile.orderDetails')}</Text>
          <View style={styles.headerSpacer} />
        </View>
      </SafeAreaView>
    )
  );

  if (!orderId) {
    return (
      <View style={styles.container}>
        {renderHeader()}
        <View style={styles.centered}>
          <Text style={styles.mutedText}>{t('profile.orderNotFound')}</Text>
        </View>
      </View>
    );
  }

  if (loading && !order) {
    return (
      <View style={styles.container}>
        {renderHeader()}
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.red} />
        </View>
      </View>
    );
  }

  if (loadError && !order) {
    return (
      <View style={styles.container}>
        {renderHeader()}
        <View style={styles.centered}>
          <Text style={styles.mutedText}>{loadError}</Text>
        </View>
      </View>
    );
  }

  if (!order) return null;

  return (
    <View style={styles.container}>
      {renderHeader()}

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Meta row */}
        <View style={styles.metaRow}>
          <View style={styles.metaLeft}>
            <Text style={styles.metaOrderNo}>
              {t('profile.orderNo')} {order.orderNumber}
            </Text>
            {!!logisticsCenter && (
              <View style={styles.metaLocationBadge}>
                <Text style={styles.metaLocationText}>{logisticsCenter}</Text>
              </View>
            )}
            <Text style={styles.metaDate}>{formatOrderDateTime(order.createdAt)}</Text>
          </View>
          <TouchableOpacity style={styles.inquiryBtn} onPress={handleOrderInquiry}>
            <Icon name="chatbubble-outline" size={14} color={COLORS.red} />
            <Text style={styles.inquiryBtnText}>{t('profile.orderDetailPage.orderInquiry')}</Text>
          </TouchableOpacity>
        </View>

        {/* Status + timeline */}
        <View style={styles.statusCard}>
          <View style={styles.statusTitleCol}>
            <Text style={styles.statusTitle}>{statusTitle}</Text>
            {!!statusSubtitle && <Text style={styles.statusSubtitle}>{statusSubtitle}</Text>}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.timelineRow}
          >
            {ORDER_DETAIL_TIMELINE_STEPS.map((step, index) => {
              const active = index <= stepIndex;
              const isCurrent = index === stepIndex;
              const isShipmentStep = step.key === 'shipment';
              const isCompleteStep = step.key === 'complete';
              const borderOnlyActive =
                !active &&
                ((isShipmentStep && shipmentBorderActive) ||
                  (isCompleteStep && completeBorderActive));
              const labelHighlighted = active || borderOnlyActive;
              const labelCurrent = completeBorderActive && isCompleteStep
                ? true
                : isCurrent || borderOnlyActive;
              const nextStepKey = ORDER_DETAIL_TIMELINE_STEPS[index + 1]?.key;
              return (
                <View key={step.key} style={styles.timelineStep}>
                  {renderTimelineIcon(step.icon, active, borderOnlyActive)}
                  <Text
                    style={[
                      styles.timelineLabel,
                      labelHighlighted && styles.timelineLabelActive,
                      labelCurrent && styles.timelineLabelCurrent,
                    ]}
                    numberOfLines={1}
                  >
                    {t(step.labelKey)}
                  </Text>
                  {index === 0 && !!createdStepDate && (
                    <Text style={styles.timelineDate}>{formatOrderDateTime(createdStepDate)}</Text>
                  )}
                  {index < ORDER_DETAIL_TIMELINE_STEPS.length - 1 && (
                    <View
                      style={[
                        styles.timelineConnector,
                        (index < stepIndex ||
                          (shipmentBorderActive && nextStepKey === 'shipment') ||
                          (completeBorderActive && nextStepKey === 'complete')) &&
                          styles.timelineConnectorActive,
                      ]}
                    />
                  )}
                </View>
              );
            })}
          </ScrollView>
        </View>

        {/* Info columns */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.infoColumnsScroll}
        >
          <View style={[styles.infoColumn, { width: INFO_COLUMN_WIDTH }]}>
            {renderSectionHeading(t('profile.orderDetailPage.recipientInfo'))}
            {renderInfoField(
              t('profile.orderDetailPage.nameOrBusiness'),
              address?.recipient,
            )}
            {renderInfoField(
              t('profile.orderDetailPage.customsCode'),
              address?.personalCustomsCode,
            )}
            {renderInfoField(t('profile.orderDetailPage.contact'), address?.contact)}
            {renderInfoField(t('profile.orderDetailPage.address'), address?.detailedAddress)}
            {renderInfoField(
              t('profile.orderDetailPage.shippingMethod'),
              shippingMethodLabel,
            )}
          </View>

          <View style={[styles.infoColumn, { width: INFO_COLUMN_WIDTH }]}>
            {renderSectionHeading(t('profile.orderDetailPage.paymentInfo'))}
            {renderInfoField(
              t('profile.orderDetailPage.paymentAmount'),
              formatPriceKRW(paymentKRW),
            )}
            {renderInfoField(
              t('profile.orderDetailPage.paymentMethod'),
              paidPayment?.paymentMethod
                ? paymentMethodLabel(paidPayment.paymentMethod, t)
                : paymentMethodLabel(order.paymentMethod, t),
            )}
            {renderInfoField(
              t('profile.orderDetailPage.paymentTime'),
              paidPayment?.paidAt ? formatOrderDateTime(paidPayment.paidAt) : undefined,
            )}
          </View>

          <View style={[styles.infoColumn, { width: INFO_COLUMN_WIDTH }]}>
            {renderSectionHeading(t('profile.orderDetailPage.paymentRecord'))}
            {(order.orderPayments ?? []).length === 0 ? (
              <Text style={styles.infoFieldValue}>{dash}</Text>
            ) : (
              (order.orderPayments ?? []).map((p: any, idx: number) => (
                <Text key={p._id || idx} style={styles.paymentRecordLine}>
                  {paymentMethodLabel(p.paymentMethod, t)} {formatPriceKRW(p.amountKRW)}{' '}
                  {p.status === 'paid'
                    ? formatOrderDateTime(p.paidAt)
                    : t('profile.orderDetailPage.dash')}
                </Text>
              ))
            )}
          </View>

          <View style={[styles.infoColumn, { width: INFO_COLUMN_WIDTH }]}>
            {renderSectionHeading(t('profile.orderDetailPage.chinaShipping'))}
            {renderInfoField(
              t('profile.orderDetailPage.trackingNumber'),
              (order.items ?? [])
                .map((item: OrderItem) => item.productOrderNumber)
                .filter(Boolean)
                .join(', ') || undefined,
            )}
          </View>

          <View style={[styles.infoColumn, { width: INFO_COLUMN_WIDTH }]}>
            {renderSectionHeading(t('profile.orderDetailPage.shippingInfo'))}
            {renderInfoField(
              t('profile.orderDetailPage.blNumber'),
              order.trackingNumbers?.[0],
            )}
            {renderInfoField(
              t('profile.orderDetailPage.logisticsMethod'),
              shippingMethodLabel,
            )}
          </View>
        </ScrollView>

        {/* Tabs */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'products' && styles.tabBtnActive]}
            onPress={() => setActiveTab('products')}
          >
            <Text style={[styles.tabBtnText, activeTab === 'products' && styles.tabBtnTextActive]}>
              {t('profile.orderDetailPage.productInfoTab')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'photos' && styles.tabBtnActive]}
            onPress={() => setActiveTab('photos')}
          >
            <Text style={[styles.tabBtnText, activeTab === 'photos' && styles.tabBtnTextActive]}>
              {t('profile.orderDetailPage.photoTab')}
            </Text>
          </TouchableOpacity>
        </View>

        {activeTab === 'products' ? (
          <View style={styles.tabPanel}>
            {(order.items ?? []).map((item: OrderItem, index: number) =>
              renderProductRow(item, index),
            )}
          </View>
        ) : (
          <View style={styles.tabPanel}>
            {renderPhotoSection(
              t('profile.orderDetailPage.inboundPhotos'),
              allInboundPhotos.length,
              allInboundPhotos,
            )}
            {renderPhotoSection(
              t('profile.orderDetailPage.issuePhotos'),
              allIssuePhotos.length,
              allIssuePhotos,
            )}
          </View>
        )}

        {/* Summary footer */}
        <View style={styles.summaryFooter}>
          <View style={styles.summaryTopRow}>
            <Text style={styles.summaryTopText}>
              {t('profile.orderDetailPage.totalQty')} {totalQty}{' '}
              {t('profile.orderDetailPage.itemsUnit')}
            </Text>
            <Text style={styles.summaryTopText}>
              {t('profile.orderDetailPage.totalProductAmount')} {formatCny(productTotalCny)}
            </Text>
          </View>
          <View style={styles.summaryTopRow}>
            <Text style={styles.summaryTopText}>
              {t('profile.orderDetailPage.fee')} {formatCny(feeCny)}
            </Text>
            <Text style={styles.summaryTopText}>
              {t('profile.orderDetailPage.additionalServiceFee')} {formatPriceKRW(serviceFeeKrw)}
            </Text>
          </View>
          <View style={styles.summaryBottomRow}>
            <View style={styles.grandTotalPill}>
              <Text style={styles.grandTotalPillText}>
                {t('profile.orderDetailPage.grandTotal')} {formatCny(productTotalCny + feeCny)}
              </Text>
            </View>
            <TouchableOpacity>
              <Text style={styles.detailedCostsLink}>
                {t('profile.orderDetailPage.detailedCosts')}
              </Text>
            </TouchableOpacity>
            <Text style={styles.finalPaymentText}>
              {t('profile.amountPaid')} {formatPriceKRW(paymentKRW)}
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Label preview modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={labelViewer !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setLabelViewer(null)}
      >
        <View style={styles.labelModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setLabelViewer(null)}
          />
          <View style={styles.labelModalCard}>
            <View style={styles.labelModalHeader}>
              <Text style={styles.labelModalTitle}>
                {t('cartOrder.labelModal.barcodeImageCheck')}
              </Text>
              <TouchableOpacity onPress={() => setLabelViewer(null)}>
                <Icon name="close" size={20} color={COLORS.text.secondary} />
              </TouchableOpacity>
            </View>
            {labelViewer ? (
              <ScrollView
                style={styles.labelModalBody}
                contentContainerStyle={styles.labelModalBodyContent}
                showsVerticalScrollIndicator
              >
                {labelViewer.imageUrl ? (
                  <Image
                    source={{ uri: labelViewer.imageUrl }}
                    style={styles.labelPreviewImage}
                    resizeMode="contain"
                  />
                ) : (
                  <View
                    style={[
                      styles.labelPreviewCard,
                      labelViewer.labelFormat === '50x80'
                        ? styles.labelPreviewCard5080
                        : styles.labelPreviewCard4060,
                    ]}
                  >
                    {labelViewer.labelType === 'foodInspect' && (
                      <Text style={styles.labelFoodBadge}>
                        {t('cartOrder.labelModal.foodBadge')}
                      </Text>
                    )}
                    {!!labelViewer.productName && (
                      <Text style={styles.labelPreviewProductName}>
                        {t('cartOrder.labelModal.productName')}: {labelViewer.productName}
                      </Text>
                    )}
                    {!!labelViewer.content && (
                      <Text style={styles.labelPreviewContent}>{labelViewer.content}</Text>
                    )}
                    {!!labelViewer.barcode && (
                      <Text style={styles.labelPreviewBarcode}>{labelViewer.barcode}</Text>
                    )}
                  </View>
                )}
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* 예정일 모달 — 날짜 클릭 시 표시 */}
      <Modal
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={scheduleModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setScheduleModalVisible(false)}
      >
        <View style={styles.labelModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setScheduleModalVisible(false)}
          />
          <View style={styles.labelModalCard}>
            <View style={styles.labelModalHeader}>
              <Text style={styles.labelModalTitle}>
                {t('profile.orderDetailPage.scheduledDates')}
              </Text>
              <TouchableOpacity onPress={() => setScheduleModalVisible(false)}>
                <Icon name="close" size={20} color={COLORS.text.secondary} />
              </TouchableOpacity>
            </View>
            <View style={styles.scheduleModalBody}>
              <View style={styles.scheduleRow}>
                <Text style={styles.scheduleRowLabel}>
                  {t('profile.orderDetailPage.supplierShipDate')}
                </Text>
                <Text style={styles.scheduleRowValue}>{scheduleDates.supplierShip}</Text>
              </View>
              <View style={styles.scheduleRow}>
                <Text style={styles.scheduleRowLabel}>
                  {t('profile.orderDetailPage.warehouseArrivalDate')}
                </Text>
                <Text style={styles.scheduleRowValue}>{scheduleDates.warehouseArrival}</Text>
              </View>
              <View style={styles.scheduleRow}>
                <Text style={styles.scheduleRowLabel}>
                  {t('profile.orderDetailPage.intlShipDate')}
                </Text>
                <Text style={styles.scheduleRowValue}>{scheduleDates.intlShip}</Text>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* 입고사진 뷰어 — 사진 행의 "보기" 클릭 시 표시 */}
      <Modal
        supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={inboundPhotoViewer !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setInboundPhotoViewer(null)}
      >
        <View style={styles.labelModalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setInboundPhotoViewer(null)}
          />
          <View style={styles.labelModalCard}>
            <View style={styles.labelModalHeader}>
              <Text style={styles.labelModalTitle}>
                {t('profile.orderDetailPage.inboundPhotos')}
              </Text>
              <TouchableOpacity onPress={() => setInboundPhotoViewer(null)}>
                <Icon name="close" size={20} color={COLORS.text.secondary} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.labelModalBody}
              contentContainerStyle={styles.labelModalBodyContent}
              showsVerticalScrollIndicator
            >
              {(inboundPhotoViewer ?? []).map((uri, idx) => (
                <Image
                  key={`${uri}-${idx}`}
                  source={{ uri }}
                  style={styles.inboundPhotoFull}
                  resizeMode="contain"
                />
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
};

function coerceAmount(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F4F5F7' },
  headerSafeArea: { backgroundColor: COLORS.white },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 10,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  backButton: { width: 36, height: 36, justifyContent: 'center' },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  headerSpacer: { width: 36 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  mutedText: { color: COLORS.text.secondary },
  scrollContent: { paddingBottom: SPACING.xl },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  metaLeft: { flex: 1, gap: 4 },
  metaOrderNo: { fontSize: FONTS.sizes.sm, fontWeight: '700', color: COLORS.text.primary },
  metaLocationBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFF1EB',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  metaLocationText: { fontSize: FONTS.sizes.xs, color: COLORS.red, fontWeight: '600' },
  metaDate: { fontSize: FONTS.sizes.xs, color: COLORS.text.secondary },
  inquiryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: COLORS.red,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  inquiryBtnText: { fontSize: FONTS.sizes.xs, color: COLORS.red, fontWeight: '600' },
  statusCard: {
    backgroundColor: COLORS.white,
    padding: SPACING.md,
    marginBottom: SPACING.sm,
    gap: SPACING.md,
  },
  statusTitleCol: { gap: 4 },
  statusTitle: { fontSize: 22, fontWeight: '800', color: COLORS.red },
  statusSubtitle: { fontSize: FONTS.sizes.sm, color: COLORS.text.secondary },
  timelineRow: { paddingVertical: SPACING.xs, alignItems: 'flex-start' },
  timelineStep: {
    width: 78,
    alignItems: 'center',
    position: 'relative',
  },
  timelineIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timelineIconWrapInactive: {
    borderColor: COLORS.gray[300],
    backgroundColor: '#F0F4F8',
  },
  timelineIconWrapActive: {
    backgroundColor: COLORS.red,
    borderColor: COLORS.red,
  },
  timelineIconWrapBorderActive: {
    backgroundColor: COLORS.white,
    borderColor: COLORS.red,
    borderWidth: 2,
  },
  timelineLabel: {
    marginTop: 6,
    fontSize: 10,
    color: COLORS.gray[400],
    textAlign: 'center',
  },
  timelineLabelActive: { color: COLORS.text.primary, fontWeight: '600' },
  timelineLabelCurrent: { color: COLORS.red, fontWeight: '700' },
  timelineDate: { fontSize: 9, color: COLORS.text.secondary, marginTop: 2, textAlign: 'center' },
  timelineConnector: {
    position: 'absolute',
    top: 17,
    left: 52,
    width: 44,
    height: 2,
    backgroundColor: COLORS.gray[200],
    zIndex: -1,
  },
  timelineConnectorActive: { backgroundColor: COLORS.red },
  infoColumnsScroll: {
    paddingHorizontal: SPACING.sm,
    paddingBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  infoColumn: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[100],
    padding: SPACING.sm,
  },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACING.sm },
  sectionBar: { width: 3, height: 14, backgroundColor: COLORS.red, borderRadius: 2 },
  sectionHeadingText: { fontSize: FONTS.sizes.sm, fontWeight: '700', color: COLORS.text.primary },
  infoField: { marginBottom: 8 },
  infoFieldLabel: { fontSize: 11, color: COLORS.text.secondary, marginBottom: 2 },
  infoFieldValue: { fontSize: FONTS.sizes.sm, color: COLORS.text.primary, lineHeight: Math.round(FONTS.sizes.sm * 18 / 14) },
  paymentRecordLine: { fontSize: FONTS.sizes.xs, color: COLORS.text.primary, marginBottom: 4 },
  tabRow: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    paddingHorizontal: SPACING.md,
  },
  tabBtn: { paddingVertical: 12, marginRight: SPACING.lg },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: COLORS.red },
  tabBtnText: { fontSize: FONTS.sizes.sm, color: COLORS.text.secondary, fontWeight: '600' },
  tabBtnTextActive: { color: COLORS.red },
  tabPanel: { backgroundColor: COLORS.white, padding: SPACING.md, gap: SPACING.md },
  productCard: {
    borderWidth: 1,
    borderColor: COLORS.gray[100],
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    gap: SPACING.sm,
  },
  productCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  platformBadge: {
    backgroundColor: '#FF6A00',
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  platformBadgeText: { color: COLORS.white, fontSize: 10, fontWeight: '700' },
  storeNameText: { flex: 1, fontSize: FONTS.sizes.sm, fontWeight: '700', color: COLORS.text.primary },
  productMainRow: { flexDirection: 'row', gap: SPACING.sm },
  productThumb: {
    width: 72,
    height: 72,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.gray[100],
  },
  productMainCol: { flex: 1, gap: 2 },
  productTitle: { fontSize: FONTS.sizes.sm, color: COLORS.text.primary, lineHeight: Math.round(FONTS.sizes.sm * 18 / 14) },
  productSpecLine: { fontSize: FONTS.sizes.xs, color: COLORS.text.secondary },
  productMetricsGrid: { flexDirection: 'row', gap: SPACING.sm },
  metricCell: { flex: 1 },
  metricLabel: { fontSize: 11, color: COLORS.text.secondary },
  metricValue: { fontSize: FONTS.sizes.sm, fontWeight: '700', color: COLORS.text.primary },
  metricValueAccent: { color: COLORS.red },
  productMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  productMetaLabel: { fontSize: FONTS.sizes.xs, color: COLORS.text.secondary },
  productMetaValue: { fontSize: FONTS.sizes.xs, color: COLORS.text.primary },
  labelCheckLink: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  productMetaDate: { color: COLORS.red, textDecorationLine: 'underline' },
  addServiceIconRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  addServiceIcon: {
    width: 22,
    height: 22,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.gray[100],
  },
  addServiceIconFallback: {
    width: 22,
    height: 22,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.primary + '14',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scheduleModalBody: { paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  scheduleRowLabel: { fontSize: FONTS.sizes.sm, color: COLORS.text.primary },
  scheduleRowValue: { fontSize: FONTS.sizes.sm, color: COLORS.text.secondary },
  inboundPhotoFull: {
    width: '100%',
    minHeight: 240,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
  },
  labelModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: SPACING.md,
  },
  labelModalCard: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    maxHeight: '80%',
    overflow: 'hidden',
  },
  labelModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  labelModalTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  labelModalBody: { maxHeight: 420 },
  labelModalBodyContent: {
    padding: SPACING.md,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  labelPreviewImage: {
    width: '100%',
    minHeight: 220,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
  },
  labelPreviewCard: {
    width: '100%',
    maxWidth: 280,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    backgroundColor: COLORS.white,
    gap: 6,
  },
  labelPreviewCard5080: { minHeight: 180 },
  labelPreviewCard4060: { minHeight: 140 },
  labelFoodBadge: {
    alignSelf: 'flex-start',
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '700',
  },
  labelPreviewProductName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  labelPreviewContent: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.sizes.xs * 16 / 12),
  },
  labelPreviewBarcode: {
    marginTop: SPACING.xs,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    letterSpacing: 1,
  },
  statusBadge: {
    backgroundColor: '#E8F8EE',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusBadgeText: { fontSize: 11, color: '#1F9D55', fontWeight: '700' },
  photoSection: { gap: SPACING.sm },
  emptyPhotoBox: {
    minHeight: 120,
    borderWidth: 1,
    borderColor: COLORS.gray[100],
    borderRadius: BORDER_RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FAFAFA',
  },
  emptyPhotoText: { fontSize: FONTS.sizes.sm, color: COLORS.text.secondary },
  photoThumb: {
    width: 88,
    height: 88,
    borderRadius: BORDER_RADIUS.sm,
    marginRight: SPACING.sm,
    backgroundColor: COLORS.gray[100],
  },
  summaryFooter: {
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
    padding: SPACING.md,
    gap: 8,
  },
  summaryTopRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.md },
  summaryTopText: { fontSize: FONTS.sizes.sm, color: COLORS.text.primary },
  summaryBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: 4,
  },
  grandTotalPill: {
    backgroundColor: COLORS.red,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  grandTotalPillText: { color: COLORS.white, fontSize: FONTS.sizes.sm, fontWeight: '700' },
  detailedCostsLink: { fontSize: FONTS.sizes.sm, color: COLORS.text.secondary },
  finalPaymentText: {
    marginLeft: 'auto',
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
    color: COLORS.red,
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  addressModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: SPACING.md,
    maxHeight: '90%',
  },
  addressModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  addressModalTitle: { fontSize: FONTS.sizes.lg, fontWeight: '700', color: COLORS.text.primary },
  addressModalLabel: { fontSize: FONTS.sizes.sm, color: COLORS.text.secondary, marginBottom: 4, marginTop: 8 },
  addressModalInput: {
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  addressModalSaveButton: {
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  addressModalSaveButtonText: { fontSize: FONTS.sizes.md, fontWeight: '700', color: COLORS.white },
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
  addressSearchBtnText: { fontSize: FONTS.sizes.sm, color: COLORS.white, fontWeight: '600' },
  kakaoModalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  kakaoModalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '80%',
  },
  kakaoModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  kakaoModalTitle: { fontSize: FONTS.sizes.md, fontWeight: '700', color: COLORS.text.primary },
});

export default OrderDetailScreen;

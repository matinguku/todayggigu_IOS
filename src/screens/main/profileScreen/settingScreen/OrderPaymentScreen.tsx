import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import ProductImage from '../../../../components/ProductImage';
import { BankPaymentInfoModal, type BankPaymentInfo } from '../../../../components';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRoute, useNavigation } from '@react-navigation/native';
import Icon from '../../../../components/Icon';
import { COLORS, FONTS, SPACING, BORDER_RADIUS } from '../../../../constants';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useAuth } from '../../../../context/AuthContext';
import { useToast } from '../../../../context/ToastContext';
import {
  coerceDisplayText,
  formatPriceCNY,
  resolveOrderItemCompanyName,
} from '../../../../utils/i18nHelpers';
import {
  Order,
  OrderItem,
  orderApi,
  resolveOrderItemUnitPrice,
  resolveOrderTotalKRW,
  resolvePendingOrderPayment,
} from '../../../../services/orderApi';
import { useAppSelector } from '../../../../store/hooks';
import { markBankPaymentPending } from '../../../../utils/pendingBankPayments';
import {
  useProfileTabletEmbed,
  useProfileTabletEmbedNavigation,
} from '../ProfileTabletEmbedContext';

type PaymentTab = 'bank' | 'credit_card' | 'deposit';

export interface OrderPaymentParams {
  orderId: string;
}

const coerceAmount = (value: unknown): number => {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 주문 금액 표시 — 환율 변환계수가 비활성(=1)이라 값들은 사실상 원본 CNY 금액이므로
 * 단위를 ¥(중국 위안)·소수점 2자리로 표기한다. (함수명은 호환을 위해 유지)
 */
const formatOrderKRW = (amount: number): string => {
  if (!Number.isFinite(amount) || amount <= 0) return '¥0.00';
  return formatPriceCNY(amount);
};

/** 2차(출고결제) 비용은 secondTierCost 의 KRW 값(실제 원화)이라 ₩ 로 표기. */
const formatWon = (amount: number): string => {
  const n = Math.round(Number.isFinite(amount) ? amount : 0);
  return `₩${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
};

const resolveProductTotalKRW = (order: Order): number => {
  const tier = order.firstTierCost;
  const fromTier = coerceAmount(tier?.productTotalKRW) || coerceAmount(tier?.realProductTotalKRW);
  if (fromTier > 0) return fromTier;
  return (order.items ?? []).reduce((sum, item) => {
    const qty = coerceAmount(item.quantity) || 1;
    const subtotal = coerceAmount(item.subtotal);
    if (subtotal > 0) return sum + subtotal;
    return sum + resolveOrderItemUnitPrice(item) * qty;
  }, 0);
};

const resolveShippingKRW = (order: Order): number =>
  coerceAmount(order.firstTierCost?.chinaShippingKRW) ||
  coerceAmount(order.firstTierCost?.baseInternationalShippingKRW);

const formatSkuLines = (item: OrderItem, locale: 'en' | 'ko' | 'zh'): string[] => {
  const attrs = item.skuAttributes;
  if (!attrs?.length) return [];
  return attrs
    .map((attr) => {
      const name =
        coerceDisplayText(attr.attributeNameMultiLang, locale, '') ||
        attr.attributeNameTrans ||
        attr.attributeName ||
        '';
      const value =
        coerceDisplayText(attr.valueMultiLang, locale, '') ||
        attr.valueTrans ||
        attr.value ||
        '';
      if (name && value) return `${name}: ${value}`;
      return value || name;
    })
    .filter(Boolean);
};

const resolveItemTitle = (item: OrderItem, locale: 'en' | 'ko' | 'zh'): string =>
  coerceDisplayText(item.subjectMultiLang, locale, '') ||
  coerceDisplayText(item.subjectTrans, locale, '') ||
  coerceDisplayText(item.subject, locale, '') ||
  '';

type OrderPaymentScreenProps = {
  embedded?: boolean;
  embeddedOrderId?: string;
  onEmbeddedBack?: () => void;
};

const OrderPaymentScreen: React.FC<OrderPaymentScreenProps> = ({
  embedded = false,
  embeddedOrderId,
  onEmbeddedBack,
}) => {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const profileEmbed = useProfileTabletEmbed();
  const { tryEmbedNavigate } = useProfileTabletEmbedNavigation(embedded);

  const params = (route.params ?? {}) as OrderPaymentParams;
  const orderId = embedded ? embeddedOrderId : params.orderId;

  const handleBack = () => {
    if (embedded && onEmbeddedBack) {
      onEmbeddedBack();
      return;
    }
    navigation.goBack();
  };

  const [order, setOrder] = useState<Order | null>(null);
  const [depositBalance, setDepositBalance] = useState(0);
  const [memberDisplayName, setMemberDisplayName] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTab, setSelectedTab] = useState<PaymentTab>('bank');
  const [memberName, setMemberName] = useState('');
  const [depositAmount, setDepositAmount] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  // 무통장(PayAction) 입금 안내 모달
  const [bankModalVisible, setBankModalVisible] = useState(false);
  const [bankInfo, setBankInfo] = useState<BankPaymentInfo | null>(null);
  const [bankOrderNumber, setBankOrderNumber] = useState<string | null>(null);

  const fetchOrder = useCallback(async () => {
    if (!orderId) {
      setLoadError(t('payment.orderNotFound'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await orderApi.getOrderById(orderId, locale);
      if (!res.success || !res.data?.order) {
        setLoadError(res.error || t('payment.orderNotFound'));
        setOrder(null);
        return;
      }
      const fetched = res.data.order;
      const userInfo = fetched.userInfo as {
        depositBalance?: number;
        userName?: string;
        name?: string;
      } | undefined;

      setOrder(fetched);
      setDepositBalance(
        coerceAmount(userInfo?.depositBalance) ||
          coerceAmount((user as { depositBalance?: number })?.depositBalance),
      );
      const displayName =
        userInfo?.userName ||
        userInfo?.name ||
        user?.name ||
        (user as { userName?: string })?.userName ||
        user?.email ||
        '';
      setMemberDisplayName(displayName);
      setSelectedTab('bank');
      setMemberName('');
      setDepositAmount('0');
    } catch {
      setLoadError(t('payment.orderNotFound'));
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }, [orderId, locale, t, user]);

  useEffect(() => {
    void fetchOrder();
  }, [fetchOrder]);

  const pendingPayment = useMemo(
    () => (order ? resolvePendingOrderPayment(order) : null),
    [order],
  );

  const productTotalKRW = useMemo(
    () => (order ? resolveProductTotalKRW(order) : 0),
    [order],
  );
  const shippingKRW = useMemo(() => (order ? resolveShippingKRW(order) : 0), [order]);

  // 2차(출고결제대기) 결제 — orderPayments 의 pending 'second' 결제가 있으면
  // secondTierCost(실제 원화)로 금액·요약을 구성한다. 상품 가격이 아니라
  // 제출 시 계산되는 2차(국제배송 등) 비용이며, 실제 값이 있는 항목만 보여준다.
  const secondTier = useMemo(() => {
    if (!order) return null;
    const payments = (order.orderPayments ?? []) as Array<{
      tier?: string;
      amountKRW?: number;
      status?: string;
    }>;
    const pendingSecond = payments.find((p) => p.tier === 'second' && p.status === 'pending');
    if (!pendingSecond) return null;
    const cost = (order as any).secondTierCost as Record<string, unknown> | undefined;
    const totalKRW = coerceAmount(pendingSecond.amountKRW) || coerceAmount(cost?.totalKRW);
    // 무게총금액 = 기본 국제배송비(무게 기준 baseInternationalShippingKRW).
    // 부가서비스 총액 = 그 외 전부(= 합계 − 무게총금액). 개별 부가비용 필드가 0 이어도
    // 합계에 녹아 있는 수수료 등을 포함해 보여주기 위해 차액으로 계산한다(이미지 기준).
    const weightTotalKRW = coerceAmount(cost?.baseInternationalShippingKRW);
    const additionalServicesKRW = Math.max(0, totalKRW - weightTotalKRW);
    return { totalKRW, weightTotalKRW, additionalServicesKRW };
  }, [order]);

  const estimatedTotal = useMemo(() => {
    if (!order) return 0;
    if (secondTier?.totalKRW) return secondTier.totalKRW;
    if (pendingPayment?.amountKRW) return pendingPayment.amountKRW;
    const tierTotal = coerceAmount(order.firstTierCost?.totalKRW);
    if (tierTotal > 0) return tierTotal;
    const resolved = resolveOrderTotalKRW(order);
    if (resolved > 0) return resolved;
    return productTotalKRW + shippingKRW;
  }, [order, secondTier, pendingPayment, productTotalKRW, shippingKRW]);

  const itemCount = order?.items?.length ?? 0;
  const firstItemImage = order?.items?.[0]?.imageUrl;

  const tabs: { id: PaymentTab; label: string }[] = [
    { id: 'bank', label: t('profile.unitSurvey.tabBankTransfer') },
    { id: 'credit_card', label: t('payment.creditCard') },
    { id: 'deposit', label: t('payment.deposit') },
  ];

  const paymentMethodLabel = useMemo(() => {
    if (selectedTab === 'bank') return t('profile.unitSurvey.tabBankTransfer');
    if (selectedTab === 'credit_card') return t('payment.creditCard');
    return t('payment.deposit');
  }, [selectedTab, t]);

  const parsedDepositAmount = Math.min(
    Math.max(0, parseInt(depositAmount.replace(/[^0-9]/g, ''), 10) || 0),
    depositBalance,
    Math.ceil(estimatedTotal),
  );

  const bankPayAmount = Math.max(0, estimatedTotal - parsedDepositAmount);

  const handleUseMemberName = () => {
    if (memberDisplayName) setMemberName(memberDisplayName);
  };

  const handleUseFullDeposit = () => {
    setSelectedTab('deposit');
    setDepositAmount(String(Math.min(depositBalance, Math.ceil(estimatedTotal))));
  };

  // 결제 후 발주관리(구매대행) 목록으로 이동.
  const goToBuyList = useCallback(() => {
    if (embedded && profileEmbed?.isEmbedActive) {
      profileEmbed.replaceRoute({
        type: 'buyList',
        domain: 'purchase_agency',
        initialTab: 'purchase_agency',
      });
    } else {
      (navigation as any).navigate('BuyList', {
        domain: 'purchase_agency',
        initialTab: 'purchase_agency',
      });
    }
  }, [embedded, profileEmbed, navigation]);

  const handleSubmit = async () => {
    if (!orderId || !order || submitting) return;

    if (selectedTab === 'bank' && !memberName.trim()) {
      showToast(t('profile.unitSurvey.depositorNameRequired'), 'error');
      return;
    }

    if (selectedTab === 'deposit') {
      if (parsedDepositAmount <= 0) {
        showToast(t('payment.depositAmountRequired'), 'error');
        return;
      }
      if (parsedDepositAmount > depositBalance) {
        showToast(t('payment.insufficientDeposit'), 'error');
        return;
      }
    }

    setSubmitting(true);
    try {
      const payAmount =
        selectedTab === 'bank'
          ? Math.ceil(bankPayAmount > 0 ? bankPayAmount : estimatedTotal)
          : selectedTab === 'deposit'
            ? Math.ceil(parsedDepositAmount > 0 ? parsedDepositAmount : estimatedTotal)
            : Math.ceil(estimatedTotal);

      // ─── 신용카드 결제: BillGate WebView 흐름 ───
      // 일반 payOrder 대신 prepareBillgatePayment 로 paymentData 를 받아
      // BillgateWebView 화면으로 navigate. WebView 가 BillGate 결제창을 띄우고
      // 완료/취소 시 BuyList 로 돌아오며 결제 결과는 backend 의 RETURN_URL
      // 콜백으로 처리된다.
      if (selectedTab === 'credit_card') {
        const prepareRes = await orderApi.prepareBillgatePayment(orderId, '0900');
        if (!prepareRes.success || !prepareRes.data?.paymentData) {
          showToast(prepareRes.error || t('profile.unitSurvey.paymentConfirmFailed'), 'error');
          setSubmitting(false);
          return;
        }
        const { paymentData, billgateScriptUrl } = prepareRes.data;
        setSubmitting(false);
        (navigation as any).navigate('BillgateWebView', {
          orderId,
          paymentData,
          billgateScriptUrl,
        });
        return;
      }

      // ─── 무통장(PayAction) 입금 흐름 ───
      // POST /orders/checkout { paymentMethod: 'payaction', amount, depositorName }
      // 성공 시 응답의 bankPaymentInfo 로 "무통장입금 안내" 모달을 띄운다.
      if (selectedTab === 'bank') {
        // 2차(출고결제) 무통장 — 부모주문 단위 묶음 2차 무통장 입금.
        // POST /v1/payments/bundle-second-tier/bank { parentOrderNumber, depositorName }
        // 성공 시 data.bankInfo 로 "무통장입금 안내" 모달을 띄운다.
        if (secondTier) {
          const parentNo = (order as any).parentOrderNumber || order.orderNumber;
          const stRes = await orderApi.submitBundleSecondTierBankTransfer(
            parentNo,
            memberName.trim(),
          );
          if (!stRes.success) {
            showToast(stRes.error || t('profile.unitSurvey.paymentConfirmFailed'), 'error');
            setSubmitting(false);
            return;
          }
          // admin 입금 확인 전까지 카드에 "결제중" 표시.
          try {
            await markBankPaymentPending(orderId);
          } catch (markErr) {
            console.warn('[OrderPaymentScreen] markBankPaymentPending failed:', markErr);
          }
          const stInfo = stRes.data?.bankInfo;
          if (stInfo && (stInfo.bankName || stInfo.bankAccount)) {
            setBankInfo({
              bankName: stInfo.bankName || '',
              bankAccount: stInfo.bankAccount || '',
              amountKRW:
                stInfo.amountKRW ?? stRes.data?.amountKRW ?? Math.ceil(estimatedTotal),
              dueDate: stInfo.dueDate,
              dueTime: stInfo.dueTime,
              reference: stInfo.reference ?? stRes.data?.bankReference,
              depositorName: stInfo.depositorName ?? memberName.trim(),
            });
            setBankOrderNumber(stRes.data?.parentOrderNumber ?? parentNo);
            setBankModalVisible(true);
            setSubmitting(false);
            return;
          }
          showToast(stRes.message || t('profile.unitSurvey.paymentConfirmSuccess'), 'success');
          goToBuyList();
          return;
        }

        const res = await orderApi.submitBankTransfer(
          orderId,
          payAmount,
          memberName.trim(),
          locale,
        );
        if (!res.success) {
          showToast(res.error || t('profile.unitSurvey.paymentConfirmFailed'), 'error');
          setSubmitting(false);
          return;
        }
        // admin 입금 확인 전까지 카드에 "결제중" 표시.
        try {
          await markBankPaymentPending(orderId);
        } catch (markErr) {
          console.warn('[OrderPaymentScreen] markBankPaymentPending failed:', markErr);
        }
        const info = res.data?.bankPaymentInfo;
        if (info && (info.bankName || info.bankAccount)) {
          setBankInfo({
            bankName: info.bankName || '',
            bankAccount: info.bankAccount || '',
            amountKRW: info.amountKRW ?? payAmount,
            dueDate: info.dueDate,
            dueTime: info.dueTime,
            reference: info.reference,
            depositorName: info.depositorName,
          });
          setBankOrderNumber(
            ((res.data?.order as any)?.orderNumber as string) ?? order?.orderNumber ?? null,
          );
          setBankModalVisible(true);
          setSubmitting(false);
          return;
        }
        // bankPaymentInfo 가 없으면 기존처럼 토스트 + 목록 이동으로 폴백.
        showToast(res.message || t('profile.unitSurvey.paymentConfirmSuccess'), 'success');
        goToBuyList();
        return;
      }

      // ─── 예치금 결제 흐름 (deposit) ───
      // 추가비용결제 흐름에서도 주문의 현재 shippingAddress 를 backend 에 함께
      // 전송 — backend 가 주소를 갱신/보존하도록 보장.
      const orderShippingAddress = (order as any)?.shippingAddress ?? undefined;

      const res = await orderApi.payOrder(orderId, {
        paymentMethod: selectedTab,
        amountKRW: payAmount,
        lang: locale,
        ...(orderShippingAddress && Object.keys(orderShippingAddress).length > 0
          ? { shippingAddress: orderShippingAddress }
          : {}),
      });

      if (res.success) {
        showToast(t('profile.unitSurvey.paymentConfirmSuccess'), 'success');
        goToBuyList();
      } else {
        showToast(res.error || t('profile.unitSurvey.paymentConfirmFailed'), 'error');
      }
    } catch {
      showToast(t('profile.unitSurvey.paymentConfirmFailed'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backButton} onPress={handleBack}>
        <Icon name="arrow-back" size={20} color={COLORS.black} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{t('profile.unitSurvey.paymentModalTitle')}</Text>
      <View style={styles.headerSpacer} />
    </View>
  );

  const renderScreenShell = (children: React.ReactNode) => (
    <View style={styles.container}>
      <View style={[styles.headerShell, !embedded && { paddingTop: insets.top }]}>
        {renderHeader()}
      </View>
      {children}
    </View>
  );

  if (!orderId) {
    return renderScreenShell(
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{t('payment.orderNotFound')}</Text>
      </View>,
    );
  }

  if (loading) {
    return renderScreenShell(
      <View style={styles.emptyState}>
        <ActivityIndicator size="large" color={COLORS.red} />
      </View>,
    );
  }

  if (loadError || !order) {
    return renderScreenShell(
      <View style={styles.emptyState}>
        <Text style={styles.emptyText}>{loadError || t('payment.orderNotFound')}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => void fetchOrder()}>
          <Text style={styles.retryButtonText}>{t('profile.unitSurvey.retry')}</Text>
        </TouchableOpacity>
      </View>,
    );
  }

  return renderScreenShell(
    <>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={{ paddingBottom: SPACING.xl + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>{t('profile.unitSurvey.paymentModalTitle')}</Text>

          <View style={styles.tabRow}>
            {tabs.map((tab) => {
              const active = selectedTab === tab.id;
              return (
                <TouchableOpacity
                  key={tab.id}
                  style={styles.tabItem}
                  activeOpacity={0.7}
                  onPress={() => setSelectedTab(tab.id)}
                >
                  <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
                  {active && <View style={styles.tabIndicator} />}
                </TouchableOpacity>
              );
            })}
          </View>

          {selectedTab === 'bank' && (
            <View style={styles.inputRow}>
              <TextInput
                style={styles.memberInput}
                value={memberName}
                onChangeText={setMemberName}
                placeholder={t('profile.unitSurvey.depositorNamePlaceholder')}
                placeholderTextColor={COLORS.gray[400]}
              />
              <TouchableOpacity
                style={styles.darkButton}
                activeOpacity={0.85}
                onPress={handleUseMemberName}
              >
                <Text style={styles.darkButtonText}>{t('payment.useMemberName')}</Text>
              </TouchableOpacity>
            </View>
          )}

          <View style={styles.inputRow}>
            <TextInput
              style={styles.depositInput}
              value={depositAmount}
              onChangeText={setDepositAmount}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={COLORS.gray[400]}
            />
            <Text style={styles.balanceText}>
              {t('payment.balance')}: {formatPriceCNY(depositBalance)}
            </Text>
            <TouchableOpacity
              style={styles.darkButton}
              activeOpacity={0.85}
              onPress={handleUseFullDeposit}
            >
              <Text style={styles.darkButtonText}>{t('payment.useFullDeposit')}</Text>
            </TouchableOpacity>
          </View>

          {selectedTab === 'credit_card' && (
            <Text style={styles.creditCardHint}>{t('payment.creditCardComingSoon')}</Text>
          )}
        </View>

        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>{t('payment.confirmOrderDetails')}</Text>

          {secondTier ? (
            // 2차(출고결제) — 묶음(부모)·구매 주문번호 박스. parentOrderNumber 가
            // 있으면 묶음주문번호(부모주문 단위 묶음 결제)를 함께 표시한다.
            <View style={styles.orderNoBox}>
              {(order as any).parentOrderNumber ? (
                <>
                  <View style={styles.orderNoInlineRow}>
                    <Text style={styles.orderNoLabel}>{t('payment.bundleOrderNumber')}</Text>
                    <Text style={styles.orderNoAccent}>
                      {(order as any).parentOrderNumber}
                    </Text>
                    <Text style={styles.orderNoHint}>{t('payment.bundlePaymentHint')}</Text>
                  </View>
                  <View style={styles.orderNoDivider} />
                </>
              ) : null}
              <Text style={styles.orderNoLabel}>{t('payment.purchaseOrderNumber')}</Text>
              <Text style={styles.orderNoValue}>{order.orderNumber}</Text>
            </View>
          ) : null}

          {order.items.map((item, index) => {
            const unitPrice = resolveOrderItemUnitPrice(item);
            const qty = coerceAmount(item.quantity) || 1;
            const lineSubtotal =
              coerceAmount(item.subtotal) > 0 ? coerceAmount(item.subtotal) : unitPrice * qty;
            const productNo = item.itemUniqueNo || item.offerId || '';
            const companyLabel = resolveOrderItemCompanyName(
              item as unknown as Record<string, unknown>,
              locale,
            );
            const specLines = formatSkuLines(item, locale);
            const title = resolveItemTitle(item, locale);

            return (
              <View
                key={item.id || item.offerId || `line-${index}`}
                style={[styles.productCard, index < order.items.length - 1 && styles.productCardBorder]}
              >
                <ProductImage
                  uri={item.imageUrl}
                  style={styles.productImage}
                  resizeMode="cover"
                />
                <View style={styles.productBody}>
                  {productNo ? (
                    <Text style={styles.productNo}>
                      {t('payment.productNumber')} {productNo}
                    </Text>
                  ) : null}
                  <Text style={styles.productName} numberOfLines={2}>
                    {title}
                  </Text>
                  {companyLabel ? (
                    <Text style={styles.companyName} numberOfLines={1}>
                      {companyLabel}
                    </Text>
                  ) : null}
                  {specLines.map((line, specIndex) => (
                    <Text key={`spec-${specIndex}`} style={styles.specText} numberOfLines={1}>
                      {line}
                    </Text>
                  ))}
                  <View style={styles.qtyBadge}>
                    <Text style={styles.qtyText}>{qty}</Text>
                  </View>
                </View>
                <View style={styles.priceCol}>
                  <Text style={styles.unitPrice}>{formatOrderKRW(unitPrice)}</Text>
                  <Text style={styles.qtyMultiplier}>x {qty}</Text>
                  <Text style={styles.lineTotal}>{formatOrderKRW(lineSubtotal)}</Text>
                </View>
              </View>
            );
          })}
        </View>

        <View style={styles.summaryCard}>
          <Text style={styles.sectionTitle}>{t('payment.summary')}</Text>

          {firstItemImage ? (
            <ProductImage uri={firstItemImage} style={styles.summaryThumb} resizeMode="cover" />
          ) : null}

          {secondTier ? (
            // 2차(출고결제) — 무게총금액(기본 국제배송비)·부가서비스 총액(나머지)·합계(₩).
            <>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('payment.weightTotal')}</Text>
                <Text style={styles.summaryValue}>{formatWon(secondTier.weightTotalKRW)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('payment.additionalServicesTotal')}</Text>
                <Text style={styles.summaryValue}>
                  {formatWon(secondTier.additionalServicesKRW)}
                </Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryRow}>
                <Text style={styles.estimatedLabel}>{t('payment.estimatedTotal')}</Text>
                <Text style={styles.estimatedValue}>{formatWon(secondTier.totalKRW)}</Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('profile.productTotal')}</Text>
                <Text style={styles.summaryValue}>{formatOrderKRW(productTotalKRW)}</Text>
              </View>
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>{t('payment.shipping')}</Text>
                <Text style={styles.summaryValue}>{formatOrderKRW(shippingKRW)}</Text>
              </View>
              <View style={styles.summaryDivider} />
              <View style={styles.summaryRow}>
                <Text style={styles.estimatedLabel}>{t('payment.estimatedTotal')}</Text>
                <Text style={styles.estimatedValue}>{formatOrderKRW(estimatedTotal)}</Text>
              </View>
            </>
          )}
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>{paymentMethodLabel}</Text>
            <Text style={styles.summaryValue}>
              {(secondTier ? formatWon : formatOrderKRW)(
                selectedTab === 'deposit' ? parsedDepositAmount : bankPayAmount,
              )}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            activeOpacity={0.85}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={COLORS.white} />
            ) : (
              <Text style={styles.submitButtonText}>
                {t('payment.submit')} ({itemCount})
              </Text>
            )}
          </TouchableOpacity>

          <View style={styles.securityRow}>
            <View style={styles.securityIcon}>
              <Icon name="shield-checkmark-outline" size={22} color={COLORS.red} />
            </View>
            <View style={styles.securityTextCol}>
              <Text style={styles.securityTitle}>{t('payment.securityPrivacy')}</Text>
              <Text style={styles.securitySubtitle}>{t('payment.securePaymentSubtitle')}</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* 무통장입금 안내 모달 — 무통장 제출 성공 시 표시 */}
      <BankPaymentInfoModal
        visible={bankModalVisible}
        bankPaymentInfo={bankInfo}
        orderNumber={bankOrderNumber}
        orderId={orderId}
        onClose={() => setBankModalVisible(false)}
        onConfirmComplete={async () => {
          setBankModalVisible(false);
          goToBuyList();
        }}
      />
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.gray[100],
  },
  headerShell: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.white,
  },
  backButton: {
    padding: SPACING.xs,
  },
  headerTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  headerSpacer: {
    width: 32,
  },
  scrollView: {
    flex: 1,
  },
  sectionCard: {
    backgroundColor: COLORS.white,
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.gray[200],
  },
  sectionTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
  },
  orderNoBox: {
    backgroundColor: COLORS.lightRed,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.md,
  },
  orderNoInlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.xs,
  },
  orderNoLabel: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  orderNoAccent: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.red,
  },
  orderNoHint: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  orderNoValue: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginTop: 2,
  },
  orderNoDivider: {
    height: 1,
    backgroundColor: COLORS.red + '26',
    marginVertical: SPACING.sm,
  },
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    marginBottom: SPACING.md,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingBottom: SPACING.sm,
    position: 'relative',
  },
  tabText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  tabTextActive: {
    color: COLORS.red,
    fontWeight: '700',
  },
  tabIndicator: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -1,
    height: 2,
    backgroundColor: COLORS.red,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
    flexWrap: 'wrap',
  },
  memberInput: {
    flex: 1,
    minWidth: 100,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    paddingVertical: SPACING.xs,
  },
  depositInput: {
    minWidth: 48,
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    paddingVertical: SPACING.xs,
  },
  balanceText: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    textAlign: 'right',
  },
  darkButton: {
    backgroundColor: COLORS.black,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  darkButtonText: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '600',
    color: COLORS.white,
  },
  creditCardHint: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginTop: SPACING.xs,
  },
  productCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
  },
  productCardBorder: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  productImage: {
    width: 72,
    height: 72,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
  },
  productBody: {
    flex: 1,
    gap: 2,
  },
  productNo: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  productName: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
  },
  companyName: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  specText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  qtyBadge: {
    alignSelf: 'flex-start',
    marginTop: SPACING.xs,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
  },
  qtyText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  priceCol: {
    alignItems: 'flex-end',
    minWidth: 72,
    gap: 2,
  },
  unitPrice: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.red,
  },
  qtyMultiplier: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  lineTotal: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  summaryCard: {
    backgroundColor: COLORS.white,
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.gray[200],
  },
  summaryThumb: {
    width: 56,
    height: 56,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
    marginBottom: SPACING.md,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xs,
  },
  summaryLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  summaryValue: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  summaryDivider: {
    height: 1,
    backgroundColor: COLORS.gray[200],
    marginVertical: SPACING.sm,
  },
  estimatedLabel: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  estimatedValue: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  submitButton: {
    marginTop: SPACING.md,
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.white,
  },
  securityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.md,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[100],
  },
  securityIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFF5F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  securityTextCol: {
    flex: 1,
  },
  securityTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  securitySubtitle: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    marginTop: 2,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.xl,
    gap: SPACING.md,
  },
  emptyText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.md,
  },
  retryButtonText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.white,
  },
});

export default OrderPaymentScreen;

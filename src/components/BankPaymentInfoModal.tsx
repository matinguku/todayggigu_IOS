import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Icon from './Icon';
import { COLORS, FONTS, SPACING, BORDER_RADIUS } from '../constants';
import { useAppSelector } from '../store/hooks';
import { translations } from '../i18n/translations';
import { formatPriceKRW } from '../utils/i18nHelpers';

export interface BankPaymentInfo {
  bankName: string;
  bankAccount: string;
  amountKRW: number;
  dueDate?: string;
  dueTime?: string;
  reference?: string;
  depositorName?: string;
}

interface BankPaymentInfoModalProps {
  visible: boolean;
  bankPaymentInfo: BankPaymentInfo | null;
  orderNumber?: string | null;
  orderId?: string | null;
  onClose: () => void;
  onConfirmComplete: (orderId: string) => Promise<void>;
}

function formatDueTime(dueTime?: string): string {
  if (!dueTime) return '';
  const s = String(dueTime).replace(/\D/g, '');
  if (s.length >= 4) {
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
  }
  return dueTime;
}

const BankPaymentInfoModal: React.FC<BankPaymentInfoModalProps> = ({
  visible,
  bankPaymentInfo,
  orderNumber,
  orderId,
  onClose,
  onConfirmComplete,
}) => {
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  const t = useCallback(
    (key: string) => {
      const keys = key.split('.');
      let value: any = translations[locale as keyof typeof translations];
      for (const k of keys) {
        value = value?.[k];
      }
      return typeof value === 'string' ? value : String(value ?? key);
    },
    [locale],
  );

  const depositorName = useMemo(() => {
    if (!bankPaymentInfo) return '';
    return bankPaymentInfo.depositorName ?? bankPaymentInfo.reference ?? '';
  }, [bankPaymentInfo]);

  const dueDisplay = useMemo(() => {
    if (!bankPaymentInfo?.dueDate) return '';
    return bankPaymentInfo.dueTime
      ? `${bankPaymentInfo.dueDate} ${formatDueTime(bankPaymentInfo.dueTime)}`
      : bankPaymentInfo.dueDate;
  }, [bankPaymentInfo?.dueDate, bankPaymentInfo?.dueTime]);

  const copyToClipboard = useCallback((value: string, field: string) => {
    if (!value) return;
    Clipboard.setString(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  }, []);

  const handleCompletePayment = useCallback(async () => {
    if (!orderId) {
      onClose();
      return;
    }
    setIsConfirming(true);
    try {
      await onConfirmComplete(orderId);
    } finally {
      setIsConfirming(false);
    }
  }, [orderId, onClose, onConfirmComplete]);

  const renderCopyButton = (value: string, field: string) => (
    <TouchableOpacity
      style={styles.copyButton}
      onPress={() => copyToClipboard(value, field)}
      activeOpacity={0.7}
    >
      <Text style={styles.copyButtonText}>
        {copiedField === field ? t('payment.bankTransfer.copied') : t('payment.bankTransfer.copy')}
      </Text>
    </TouchableOpacity>
  );

  const renderInfoRow = (
    label: string,
    value: string,
    field: string,
    options?: { mono?: boolean; highlight?: boolean },
  ) => (
    <View style={styles.infoRow}>
      <View style={styles.infoRowContent}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text
          style={[
            styles.infoValue,
            options?.mono && styles.infoValueMono,
            options?.highlight && styles.infoValueHighlight,
          ]}
          selectable
        >
          {value}
        </Text>
      </View>
      {value ? renderCopyButton(value, field) : null}
    </View>
  );

  if (!visible || !bankPaymentInfo) return null;

  return (
    <Modal statusBarTranslucent visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modalCard}>
          <View style={styles.header}>
            <View style={styles.headerTextWrap}>
              <Text style={styles.headerTitle}>{t('payment.bankTransfer.title')}</Text>
              <Text style={styles.headerSubtitle}>{t('payment.bankTransfer.subtitle')}</Text>
            </View>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Icon name="close" size={22} color={COLORS.white} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {orderNumber
              ? renderInfoRow(t('payment.bankTransfer.orderNumber'), orderNumber, 'orderNumber', { mono: true })
              : null}
            {renderInfoRow(t('payment.bankTransfer.bankName'), bankPaymentInfo.bankName || '', 'bankName')}
            {renderInfoRow(
              t('payment.bankTransfer.accountNumber'),
              bankPaymentInfo.bankAccount || '',
              'accountNumber',
              { mono: true },
            )}
            {renderInfoRow(
              t('payment.bankTransfer.amount'),
              formatPriceKRW(bankPaymentInfo.amountKRW ?? 0),
              'amount',
              { highlight: true },
            )}
            {dueDisplay ? (
              <View style={styles.infoRowStatic}>
                <Text style={styles.infoLabel}>{t('payment.bankTransfer.dueDate')}</Text>
                <Text style={styles.infoValue}>{dueDisplay}</Text>
              </View>
            ) : null}
            <View style={styles.infoRow}>
              <View style={styles.infoRowContent}>
                <Text style={styles.infoLabel}>{t('payment.bankTransfer.depositorName')}</Text>
                <Text style={styles.infoValue}>{depositorName}</Text>
                <Text style={styles.infoHint}>{t('payment.bankTransfer.depositorNameHint')}</Text>
              </View>
              {depositorName ? renderCopyButton(depositorName, 'depositorName') : null}
            </View>
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.confirmButton, isConfirming && styles.confirmButtonDisabled]}
              onPress={handleCompletePayment}
              disabled={isConfirming}
              activeOpacity={0.85}
            >
              {isConfirming ? (
                <ActivityIndicator size="small" color={COLORS.white} />
              ) : (
                <Text style={styles.confirmButtonText}>{t('payment.bankTransfer.viewOrder')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
  },
  modalCard: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
    maxHeight: '85%',
  },
  header: {
    backgroundColor: COLORS.red,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  headerTextWrap: {
    flex: 1,
    paddingRight: SPACING.sm,
  },
  headerTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.white,
  },
  headerSubtitle: {
    fontSize: FONTS.sizes.sm,
    color: 'rgba(255,255,255,0.9)',
    marginTop: SPACING.xs,
    lineHeight: 20,
  },
  closeButton: {
    padding: SPACING.xs,
  },
  body: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  infoRowStatic: {
    marginBottom: SPACING.md,
  },
  infoRowContent: {
    flex: 1,
    minWidth: 0,
  },
  infoLabel: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    marginBottom: SPACING.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  infoValue: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  infoValueMono: {
    fontFamily: 'monospace',
  },
  infoValueHighlight: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.red,
  },
  infoHint: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    marginTop: SPACING.xs,
    lineHeight: 18,
  },
  copyButton: {
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    alignSelf: 'flex-start',
  },
  copyButtonText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  footer: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
    paddingTop: SPACING.xs,
  },
  confirmButton: {
    backgroundColor: COLORS.red,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.md,
    alignItems: 'center',
  },
  confirmButtonDisabled: {
    opacity: 0.7,
  },
  confirmButtonText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.white,
  },
});

export default BankPaymentInfoModal;

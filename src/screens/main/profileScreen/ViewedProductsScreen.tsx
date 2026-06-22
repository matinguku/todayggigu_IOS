import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  Modal,
  ActivityIndicator,
  StatusBar,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../../../components/Icon';
import { useNavigation } from '@react-navigation/native';
import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../../constants';
import { useAppSelector } from '../../../store/hooks';
import { translations } from '../../../i18n/translations';
import { productsApi } from '../../../services/productsApi';
import { wishlistApi } from '../../../services/wishlistApi';
import { useToast } from '../../../context/ToastContext';
import ProductShareModal from '../../../components/ProductShareModal';
import { buildProductSharePageUrl } from '../../../utils/productShareLinks';
import {
  formatPriceKRW,
  type RecentlyViewedProduct,
} from '../../../utils/i18nHelpers';
import { normalizeLocale } from '../../../i18n/translate';

type ViewedProductsScreenProps = {
  embedded?: boolean;
};

const ViewedProductsScreen: React.FC<ViewedProductsScreenProps> = ({
  embedded = false,
}) => {
  const navigation = useNavigation();
  const locale = useAppSelector((s) => s.i18n.locale);
  const appLocale = normalizeLocale(locale);
  const { showToast } = useToast();
  const t = (key: string) => {
    const keys = key.split('.');
    let value: any = translations[locale as keyof typeof translations];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  };

  const [filterVisible, setFilterVisible] = useState(false);
  const [isManagementMode, setIsManagementMode] = useState(false);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(new Set());
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [showCalendarModal, setShowCalendarModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [filteredDate, setFilteredDate] = useState<string | null>(null); // Track applied date filter
  const filterButtonRef = useRef<any>(null);
  const [filterButtonLayout, setFilterButtonLayout] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [viewedProducts, setViewedProducts] = useState<RecentlyViewedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const isLoadingMoreRef = useRef(false);
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [shareTarget, setShareTarget] = useState<{
    productUrl: string;
    productName: string;
    shareMessage: string;
  } | null>(null);

  // Fetch viewed products on mount and when app language changes
  useEffect(() => {
    fetchViewedProducts(1, true);
  }, [appLocale]);

  // Load more when currentPage changes
  useEffect(() => {
    if (currentPage > 1 && hasMore && !isLoadingMoreRef.current) {
      fetchViewedProducts(currentPage, false);
    }
  }, [currentPage, hasMore]);

  const fetchViewedProducts = async (page: number, reset: boolean = false) => {
    try {
      if (reset) {
        setLoading(true);
      } else {
        setLoadingMore(true);
        isLoadingMoreRef.current = true;
      }
      
      const limit = 20;
      const response = await productsApi.getRecentlyViewedProducts(limit, appLocale);
      
      if (response.success && response.data) {
        const newProducts = response.data.items;
        
        if (reset) {
          setViewedProducts(newProducts);
        } else {
          setViewedProducts(prev => [...prev, ...newProducts]);
        }
        
        // Check if there are more items to load
        setHasMore(newProducts.length === limit);
      } else {
        showToast(response.message || t('profile.failedToLoadViewedProducts'), 'error');
      }
    } catch (error) {
      showToast(t('profile.failedToLoadViewedProducts'), 'error');
    } finally {
      setLoading(false);
      setLoadingMore(false);
      isLoadingMoreRef.current = false;
    }
  };

  const handleLoadMore = () => {
    if (!loadingMore && hasMore && !loading && !isLoadingMoreRef.current) {
      setCurrentPage(prev => prev + 1);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setCurrentPage(1);
    setHasMore(true);
    await fetchViewedProducts(1, true);
    setRefreshing(false);
  };

  // Filter products by selected date if a filter is applied
  const displayedProducts = filteredDate
    ? viewedProducts.filter(product => product.viewedAt.split('T')[0] === filteredDate)
    : viewedProducts;

  // Group products by date
  const groupedProducts = displayedProducts.reduce((acc, product) => {
    const date = product.viewedAt.split('T')[0]; // Get date part only
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(product);
    return acc;
  }, {} as Record<string, RecentlyViewedProduct[]>);

  // Convert to array and sort by date (newest first)
  const sortedGroups = Object.entries(groupedProducts).sort((a, b) => 
    new Date(b[0]).getTime() - new Date(a[0]).getTime()
  );

  // Check if all products are selected
  const allSelected = viewedProducts.length > 0 && selectedProductIds.size === viewedProducts.length;

  const handleToggleProduct = (productId: string) => {
    setSelectedProductIds(prev => {
      const newSet = new Set(prev);
      const key = productId;
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  };

  const handleToggleAll = () => {
    if (allSelected) {
      setSelectedProductIds(new Set());
    } else {
      setSelectedProductIds(new Set(viewedProducts.map(p => p.productId)));
    }
  };

  const handleAddToWishlist = async () => {
    if (selectedProductIds.size === 0) return;
    
    try {
      const selectedProducts = viewedProducts.filter(p => selectedProductIds.has(p.productId));
      let successCount = 0;
      
      for (const product of selectedProducts) {
        const response = await wishlistApi.addToWishlist({
          offerId: product.productId,
          platform: product.source,
        });
        
        if (response.success) {
          successCount++;
        }
      }
      
      if (successCount > 0) {
        setSuccessMessage(t('profile.addedSuccessfully'));
        setShowSuccessModal(true);
        setTimeout(() => {
          setShowSuccessModal(false);
        }, 2000);
        setSelectedProductIds(new Set());
      }
    } catch (error) {
      showToast(t('profile.failedToAddToWishlist'), 'error');
    }
  };

  const getShareCountry = () => appLocale;

  const handleShare = () => {
    if (selectedProductIds.size === 0) {
      showToast(t('profile.wishlistSelectToShare'), 'warning');
      return;
    }

    const selectedProducts = viewedProducts.filter((p) =>
      selectedProductIds.has(p.productId),
    );
    const product = selectedProducts[0];
    if (!product?.productId || !product.title) {
      showToast(t('product.invalidProductData'), 'error');
      return;
    }

    const source = product.source || product.platform || '1688';
    const productUrl = buildProductSharePageUrl({
      productId: product.productId,
      source,
      country: getShareCountry(),
    });
    const shareMessage = t('product.shareMessage')
      .replace('{productName}', product.title)
      .replace('{price}', formatPriceKRW(product.price || 0));

    setShareTarget({
      productUrl,
      productName: product.title,
      shareMessage,
    });
    setShareModalVisible(true);
  };

  const handleDelete = async () => {
    if (selectedProductIds.size === 0) return;
    
    try {
      const selectedProducts = viewedProducts.filter(p => selectedProductIds.has(p.productId));
      let successCount = 0;
      
      for (const product of selectedProducts) {
        const response = await productsApi.deleteRecentlyViewedProduct(product.productId, product.source);
        
        if (response.success) {
          successCount++;
        }
      }
      
      if (successCount > 0) {
        setSuccessMessage(t('profile.deleteSuccessfully'));
        setShowSuccessModal(true);
        setTimeout(() => {
          setShowSuccessModal(false);
        }, 2000);
        setSelectedProductIds(new Set());
        setCurrentPage(1);
        setHasMore(true);
        await fetchViewedProducts(1, true);
      }
    } catch (error) {
      showToast(t('profile.failedToDeleteProducts'), 'error');
    }
  };

  const handleClearAll = () => {
    setShowDeleteAllModal(true);
  };

  const handleConfirmClearAll = async () => {
    try {
      let successCount = 0;
      
      for (const product of viewedProducts) {
        const response = await productsApi.deleteRecentlyViewedProduct(product.productId, product.source);
        
        if (response.success) {
          successCount++;
        }
      }
      
      if (successCount > 0) {
        showToast(t('profile.allBrowsingHistoryCleared'), 'success');
        setShowDeleteAllModal(false);
        setSelectedProductIds(new Set());
        setIsManagementMode(false);
        setCurrentPage(1);
        setHasMore(true);
        await fetchViewedProducts(1, true);
      }
    } catch (error) {
      showToast(t('profile.failedToClearBrowsingHistory'), 'error');
    }
  };

  const getDateLabel = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return t('profile.today');
    } else if (date.toDateString() === yesterday.toDateString()) {
      return t('profile.yesterday');
    } else {
      return dateString;
    }
  };

  const renderCalendarDays = () => {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth();
    const today = new Date();
    
    // Get first day of month and total days
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    
    // Get unique dates from viewed products for this month
    const viewedDates = new Set(
      viewedProducts
        .map(p => {
          const date = new Date(p.viewedAt);
          if (date.getFullYear() === year && date.getMonth() === month) {
            return date.getDate();
          }
          return null;
        })
        .filter(d => d !== null)
    );
    
    const days = [];
    let dayCounter = 1;
    let nextMonthCounter = 1;
    
    // Generate 6 weeks of days
    for (let week = 0; week < 6; week++) {
      const weekDays = [];
      
      for (let day = 0; day < 7; day++) {
        const dayIndex = week * 7 + day;
        
        if (dayIndex < firstDay) {
          // Previous month days
          const prevMonthDay = daysInPrevMonth - firstDay + dayIndex + 1;
          weekDays.push(
            <View key={`prev-${dayIndex}`} style={styles.calendarDay}>
              <Text style={styles.calendarDayTextInactive}>{prevMonthDay}</Text>
            </View>
          );
        } else if (dayCounter <= daysInMonth) {
          // Current month days
          const currentDay = dayCounter;
          const isToday = 
            year === today.getFullYear() && 
            month === today.getMonth() && 
            currentDay === today.getDate();
          
          // Check if this day has viewed products
          const hasProducts = viewedDates.has(currentDay);
          
          weekDays.push(
            <TouchableOpacity 
              key={`current-${dayCounter}`} 
              style={styles.calendarDay}
              onPress={() => {
                const newDate = new Date(year, month, currentDay);
                setSelectedDate(newDate);
                // Filter products by selected date
                const dateString = `${year}-${String(month + 1).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
                setFilteredDate(dateString);
                setShowCalendarModal(false);
              }}
            >
              <View style={[
                styles.calendarDayCircle,
                isToday && styles.calendarDayCircleToday
              ]}>
                <Text style={[
                  styles.calendarDayText,
                  isToday && styles.calendarDayTextToday
                ]}>
                  {currentDay}
                </Text>
              </View>
              {hasProducts && <View style={styles.calendarDayDot} />}
            </TouchableOpacity>
          );
          dayCounter++;
        } else {
          // Next month days
          weekDays.push(
            <View key={`next-${nextMonthCounter}`} style={styles.calendarDay}>
              <Text style={styles.calendarDayTextInactive}>{nextMonthCounter}</Text>
            </View>
          );
          nextMonthCounter++;
        }
      }
      
      days.push(
        <View key={`week-${week}`} style={styles.calendarWeekRow}>
          {weekDays}
        </View>
      );
    }
    
    return days;
  };

  const renderHeader = () => (
    <View style={[styles.header, embedded && styles.embeddedHeader]}>
      <View style={styles.headerLeft}>
        {!embedded && (
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Icon name="arrow-back" size={20} color={COLORS.text.primary} />
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>{t('profile.viewedProducts')}</Text>
      </View>
      <View style={styles.headerRight}>
        <TouchableOpacity onPress={() => setIsManagementMode(!isManagementMode)}>
          <Text style={styles.managementText}>
            {isManagementMode ? t('profile.done') : t('profile.management')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderFilterButton = () => {
    const formattedFilterDate = filteredDate ? new Date(filteredDate).toLocaleDateString() : null;
    
    return (
      <View
        ref={filterButtonRef}
        onLayout={(event) => {
          const layout = event.nativeEvent.layout;
          // Get the absolute position on screen
          setTimeout(() => {
            filterButtonRef.current?.measure((x: number, y: number, width: number, height: number, pageX: number, pageY: number) => {
              setFilterButtonLayout({ x: pageX, y: pageY, width, height });
            });
          }, 0);
        }}
      >
        <View style={styles.filterButtonContainer}>
          <TouchableOpacity 
            style={[styles.filterButton, filteredDate && styles.filterButtonActive]}
            onPress={() => setShowCalendarModal(!showCalendarModal)}
          >
            <Text style={[styles.filterButtonText, filteredDate && styles.filterButtonTextActive]}>
              {filteredDate ? `${formattedFilterDate}` : t('profile.browseTimeFilter')}
            </Text>
            <Icon name="chevron-down" size={16} color={filteredDate ? COLORS.primary : COLORS.text.primary} />
          </TouchableOpacity>
          {filteredDate && (
            <TouchableOpacity
              style={styles.clearFilterButton}
              onPress={() => setFilteredDate(null)}
            >
              <Icon name="close-circle" size={20} color={COLORS.text.secondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const renderProductItem = ({ item }: { item: RecentlyViewedProduct }) => {
    const isSelected = selectedProductIds.has(item.productId);
    
    return (
      <TouchableOpacity 
        style={styles.productCard}
        onPress={() => {
          if (!isManagementMode) {
            // Navigate to product detail
            const country =
              appLocale === 'ko' ? 'ko' : appLocale === 'zh' ? 'zh' : 'en';
            (navigation as any).navigate('ProductDetail', {
              productId: item.productId,
              source: item.source,
              country: country,
            });
          }
        }}
      >
        <View style={styles.productImageContainer}>
          <Image 
            source={{ uri: item.photoUrl || 'https://via.placeholder.com/300' }} 
            style={styles.productImage} 
          />
          {isManagementMode && (
            <TouchableOpacity 
              style={styles.checkboxOverlay}
              onPress={() => handleToggleProduct(item.productId)}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                {isSelected && (
                  <Icon name="checkmark" size={16} color={COLORS.white} />
                )}
              </View>
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.productInfo}>
          <Text style={styles.productPrice}>¥{item.price}</Text>
          <Text style={styles.productTitle} numberOfLines={1} ellipsizeMode="tail">
            {item.title}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderDateSection = ({ item }: { item: [string, RecentlyViewedProduct[]] }) => {
    const [date, products] = item;
    const dateSelected = products.every(p => selectedProductIds.has(p.productId));
    
    return (
      <View style={styles.dateSection}>
        <View style={styles.dateLabelRow}>
          {isManagementMode && (
            <TouchableOpacity 
              style={styles.dateLabelCheckbox}
              onPress={() => {
                if (dateSelected) {
                  // Deselect all products in this date
                  setSelectedProductIds(prev => {
                    const newSet = new Set(prev);
                    products.forEach(p => newSet.delete(p.productId));
                    return newSet;
                  });
                } else {
                  // Select all products in this date
                  setSelectedProductIds(prev => {
                    const newSet = new Set(prev);
                    products.forEach(p => newSet.add(p.productId));
                    return newSet;
                  });
                }
              }}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, dateSelected && styles.checkboxSelected]}>
                {dateSelected && (
                  <Icon name="checkmark" size={16} color={COLORS.white} />
                )}
              </View>
            </TouchableOpacity>
          )}
          <Text style={styles.dateLabel}>{getDateLabel(date)}</Text>
        </View>
        <FlatList
          data={products}
          renderItem={renderProductItem}
          keyExtractor={(product, index) => `${product.productId}::${index}`}
          numColumns={3}
          scrollEnabled={false}
          columnWrapperStyle={styles.productRow}
        />
      </View>
    );
  };

  return (
    <View style={[styles.container, embedded && styles.embeddedContainer]}>
      {!embedded && (
        <StatusBar
          barStyle="dark-content"
          backgroundColor={COLORS.white}
          translucent={Platform.OS === 'android'}
        />
      )}
      {embedded ? (
        <View style={styles.topSafeArea}>
          {renderHeader()}
          {renderFilterButton()}
        </View>
      ) : (
        <SafeAreaView style={styles.topSafeArea} edges={['top', 'left', 'right']}>
          {renderHeader()}
          {renderFilterButton()}
        </SafeAreaView>
      )}

      <View style={styles.body}>
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.primary} />
          </View>
        ) : viewedProducts.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>{t('profile.noViewedProducts')}</Text>
          </View>
        ) : displayedProducts.length === 0 && filteredDate ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>{t('profile.noProductsOnDate').replace('{date}', new Date(filteredDate).toLocaleDateString())}</Text>
          </View>
        ) : (
          <FlatList
            data={sortedGroups}
            renderItem={renderDateSection}
            keyExtractor={(item) => item[0]}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            refreshing={refreshing}
            onRefresh={handleRefresh}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.loadingMoreContainer}>
                  <ActivityIndicator size="small" color={COLORS.primary} />
                  <Text style={styles.loadingMoreText}>{t('profile.loadingMore')}</Text>
                </View>
              ) : null
            }
          />
        )}
      </View>

      {isManagementMode && viewedProducts.length > 0 && (
        // 앱 루트(App.tsx)가 이미 edges={['bottom']} 로 하단 인셋을 차지하므로
        // 여기서 또 SafeAreaView 를 쓰면 인셋이 이중 적용돼 버튼띠가 화면 밑에서 떠 보였음.
        // 일반 View 로 바꿔 버튼띠를 화면 하단에 바싹 붙인다.
        <View style={styles.footerSafeArea}>
        <View style={styles.footer}>
          {selectedProductIds.size > 0 ? (
            <>
              <View style={styles.footerTopRow}>
                <Text style={styles.selectionText}>
                  {t('profile.selectItems').replace('{count}', selectedProductIds.size.toString())}
                </Text>
                <TouchableOpacity onPress={handleClearAll}>
                  <Text style={styles.clearAllText}>{t('profile.clearAllBrowsingHistory')}</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.footerBottomRow}>
                <TouchableOpacity 
                  style={styles.selectAllButton}
                  onPress={handleToggleAll}
                  activeOpacity={0.7}
                >
                  <View style={[styles.checkbox, allSelected && styles.checkboxSelected]}>
                    {allSelected && (
                      <Icon name="checkmark" size={16} color={COLORS.white} />
                    )}
                  </View>
                  <Text style={styles.selectAllText}>{t('profile.all')}</Text>
                </TouchableOpacity>
                <View style={styles.footerActions}>
                  <TouchableOpacity 
                    style={styles.footerButton}
                    onPress={handleAddToWishlist}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.footerButtonText}>{t('profile.addToWishlist')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.footerButton}
                    onPress={handleShare}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.footerButtonText}>{t('profile.share')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={styles.footerDeleteButton}
                    onPress={handleDelete}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.footerDeleteButtonText}>{t('profile.delete')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.footerSingleRow}>
              <TouchableOpacity 
                style={styles.selectAllButton}
                onPress={handleToggleAll}
                activeOpacity={0.7}
              >
                <View style={[styles.checkbox, allSelected && styles.checkboxSelected]}>
                  {allSelected && (
                    <Icon name="checkmark" size={16} color={COLORS.white} />
                  )}
                </View>
                <Text style={styles.selectAllText}>{t('profile.all')}</Text>
              </TouchableOpacity>
              <View style={styles.footerActions}>
                <TouchableOpacity 
                  style={styles.footerButton}
                  onPress={handleAddToWishlist}
                  activeOpacity={0.7}
                >
                  <Text style={styles.footerButtonText}>{t('profile.addToWishlist')}</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.footerButton}
                  onPress={handleShare}
                  activeOpacity={0.7}
                >
                  <Text style={styles.footerButtonText}>{t('profile.share')}</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={styles.footerDeleteButton}
                  onPress={handleDelete}
                  activeOpacity={0.7}
                >
                  <Text style={styles.footerDeleteButtonText}>{t('profile.delete')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
        </View>
      )}

      {/* Delete All Confirmation Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showDeleteAllModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDeleteAllModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{t('profile.deleteAllInOneClick')}</Text>
            <Text style={styles.modalMessage}>
              {t('profile.confirmClearAllHistory')}
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setShowDeleteAllModal(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.modalCancelText}>{t('profile.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirmButton}
                onPress={handleConfirmClearAll}
                activeOpacity={0.7}
              >
                <Text style={styles.modalConfirmText}>{t('profile.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Calendar Dropdown */}
      {showCalendarModal && (
        <TouchableOpacity 
          style={styles.calendarDropdownOverlay}
          activeOpacity={1}
          onPress={() => setShowCalendarModal(false)}
        >
          <View 
            style={[
              styles.calendarDropdownContent,
              { 
                top: filterButtonLayout.y + 8,
                left: filterButtonLayout.x/2,
                right: filterButtonLayout.x/2,
                // width: filterButtonLayout.width,
              }
            ]}
            onStartShouldSetResponder={() => true}
          >
            {/* Triangle pointer */}
            <View style={styles.calendarTriangle} />
            
            <View style={styles.calendarHeader}>
              <TouchableOpacity 
                onPress={() => {
                  const newDate = new Date(selectedDate);
                  newDate.setMonth(newDate.getMonth() - 1);
                  setSelectedDate(newDate);
                }}
              >
                <Icon name="chevron-back" size={16} color={COLORS.text.primary} />
              </TouchableOpacity>
              <Text style={styles.calendarHeaderText}>
                {selectedDate.getFullYear()}年{selectedDate.getMonth() + 1}月
              </Text>
              <TouchableOpacity 
                onPress={() => {
                  const newDate = new Date(selectedDate);
                  newDate.setMonth(newDate.getMonth() + 1);
                  setSelectedDate(newDate);
                }}
              >
                <Icon name="chevron-forward" size={16} color={COLORS.text.primary} />
              </TouchableOpacity>
            </View>
            
            {/* Calendar Grid */}
            <View style={styles.calendarGrid}>
              {/* Day headers */}
              <View style={styles.calendarWeekRow}>
                {['日', '一', '二', '三', '四', '五', '六'].map((day, index) => (
                  <View key={day} style={styles.calendarDayHeader}>
                    <Text style={styles.calendarDayHeaderText}>{day}</Text>
                  </View>
                ))}
              </View>
              
              {/* Calendar days */}
              {renderCalendarDays()}
            </View>
          </View>
        </TouchableOpacity>
      )}

      {shareTarget && (
        <ProductShareModal
          visible={shareModalVisible}
          onClose={() => setShareModalVisible(false)}
          productUrl={shareTarget.productUrl}
          productName={shareTarget.productName}
          shareMessage={shareTarget.shareMessage}
          onShareError={(msg) => showToast(msg, 'error')}
        />
      )}

      {/* Success Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showSuccessModal}
        transparent
        animationType="fade"
      >
        <View style={styles.successModalOverlay}>
          <View style={styles.successModalContent}>
            <Text style={styles.successModalText}>{successMessage}</Text>
          </View>
        </View>
      </Modal>
    </View>
  );
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
  topSafeArea: {
    backgroundColor: COLORS.white,
  },
  body: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
  },
  emptyText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.white,
    // borderBottomWidth: 1,
    // borderBottomColor: COLORS.gray[200],
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  backButton: {
    padding: SPACING.xs,
  },
  headerTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  managementText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  filterButtonContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xs,
    paddingBottom: SPACING.sm,
    gap: SPACING.sm,
    backgroundColor: COLORS.white,
  },
  footerSafeArea: {
    backgroundColor: COLORS.white,
  },
  filterButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: '#0000000D',
    backgroundColor: COLORS.white,
  },
  filterButtonActive: {
    borderColor: COLORS.primary,
    backgroundColor: '#F0F7FF',
  },
  filterButtonText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  filterButtonTextActive: {
    color: COLORS.primary,
    fontWeight: '600',
  },
  clearFilterButton: {
    padding: SPACING.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: {
    paddingTop: SPACING.xs,
    paddingBottom: SPACING.xl,
  },
  loadingMoreContainer: {
    paddingVertical: SPACING.lg,
    alignItems: 'center',
    gap: SPACING.sm,
  },
  loadingMoreText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  dateSection: {
    marginTop: SPACING.sm,
  },
  dateLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  dateLabelCheckbox: {
    padding: SPACING.xs,
  },
  dateLabel: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  productRow: {
    paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  productCard: {
    flex: 1,
    maxWidth: '32%',
  },
  productImageContainer: {
    position: 'relative',
    width: '100%',
    aspectRatio: 1,
    marginBottom: SPACING.xs,
  },
  productImage: {
    width: '100%',
    height: '100%',
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
  },
  checkboxOverlay: {
    position: 'absolute',
    top: SPACING.xs,
    right: SPACING.xs,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: COLORS.black,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxSelected: {
    backgroundColor: COLORS.red,
    borderColor: COLORS.red,
  },
  productInfo: {
    gap: SPACING.xs / 2,
  },
  productPrice: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.red,
  },
  productTitle: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.black,
    fontWeight: '400',
    lineHeight: Math.round(FONTS.sizes.xs * 16 / 12),
  },
  footer: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
    ...SHADOWS.lg,
  },
  footerSingleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  footerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
  },
  footerBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectionText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  selectionCount: {
    fontWeight: '700',
    color: COLORS.red,
  },
  clearAllText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '400',
  },
  selectAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  selectAllText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  footerButton: {
    padding: SPACING.xssm,
    borderRadius: BORDER_RADIUS.md,
    borderColor: "#0000000D",
    borderWidth: 1,
  },
  footerButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  footerDeleteButton: {
    backgroundColor: '#FFE1D4',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderColor: "#0000000D",
    borderWidth: 1,
  },
  footerDeleteButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.red,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING['2xl'],
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  modalMessage: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    textAlign: 'center',
    marginBottom: SPACING['2xl'],
    lineHeight: Math.round(FONTS.sizes.md * 22 / 16),
  },
  modalButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
    width: '100%',
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.gray[100],
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  modalConfirmButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
  },
  modalConfirmText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.white,
  },
  calendarDropdownOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    zIndex: 1000,
  },
  calendarDropdownContent: {
    position: 'absolute',
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    ...SHADOWS.lg,
    zIndex: 1001,
    minWidth: 350,
  },
  calendarTriangle: {
    position: 'absolute',
    top: -8,
    left: SPACING.md,
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 8,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: COLORS.white,
  },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xl,
    paddingHorizontal: SPACING.md,
    gap: 8,
  },
  calendarHeaderText: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  calendarGrid: {
    gap: SPACING.xs,
  },
  calendarWeekRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: SPACING.xs,
  },
  calendarDayHeader: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calendarDayHeaderText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '400',
  },
  calendarDay: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  calendarDayCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  calendarDayCircleToday: {
    backgroundColor: COLORS.primary,
  },
  calendarDayText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  calendarDayTextToday: {
    color: COLORS.white,
    fontWeight: '600',
  },
  calendarDayTextInactive: {
    fontSize: FONTS.sizes.md,
    color: COLORS.gray[300],
    fontWeight: '400',
  },
  calendarDayDot: {
    position: 'absolute',
    bottom: 4,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLORS.primary,
  },
  successModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  successModalContent: {
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderRadius: BORDER_RADIUS.lg,
    paddingHorizontal: SPACING['2xl'],
    paddingVertical: SPACING.xl,
    maxWidth: '80%',
  },
  successModalText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.white,
    textAlign: 'center',
    lineHeight: Math.round(FONTS.sizes.md * 22 / 16),
  },
});

export default ViewedProductsScreen;

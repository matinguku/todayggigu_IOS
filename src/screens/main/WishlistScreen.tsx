import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Image,
  RefreshControl,
  ActivityIndicator,
  Dimensions,
  ScrollView,
  Modal,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from '../../components/Icon';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import TuneIcon from '../../assets/icons/TuneIcon';
import ImageSearchResultsModal from './searchScreen/ImageSearchResultsModal';

import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants';
import { Product } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { usePlatformStore } from '../../store/platformStore';
import { useAppSelector } from '../../store/hooks';
import { useGetWishlistMutation } from '../../hooks/useGetWishlistMutation';
import { useDeleteFromWishlistMutation } from '../../hooks/useDeleteFromWishlistMutation';
import { useDeleteFromWishlistBatchMutation } from '../../hooks/useDeleteFromWishlistBatchMutation';
import { cartApi, type AddToCartRequest } from '../../services/cartApi';
import {
  normalizeWishlistTimeFilter,
  type WishlistApiTimeFilter,
} from '../../services/wishlistApi';
import { useWishlistStatus } from '../../hooks/useWishlistStatus';
import { useToast } from '../../context/ToastContext';
import { translations } from '../../i18n/translations';
import ProductShareModal from '../../components/ProductShareModal';
import { buildProductSharePageUrl } from '../../utils/productShareLinks';
import {
  formatPriceKRW,
  getLocalizedText,
  resolveViewedProductTitle,
} from '../../utils/i18nHelpers';
import { normalizeLocale } from '../../i18n/translate';

const { width } = Dimensions.get('window');

const WISHLIST_COLLECTION_TIME_KEYS: readonly WishlistApiTimeFilter[] = [
  '7d',
  '30d',
  '90d',
  '6m',
  '1y',
];
type WishlistCollectionTimeKey = WishlistApiTimeFilter;

type WishlistScreenProps = {
  embedded?: boolean;
};

const WishlistScreen: React.FC<WishlistScreenProps> = ({ embedded = false }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // 헤더 위(상태바) 영역을 흰색 헤더가 직접 칠하고 간격도 최소화하기 위한 상단 패딩.
  // SafeAreaView 의 top 인셋을 빼고(아래 edges) 헤더가 그 자리를 흰색으로 덮는다.
  const headerTopStyle = { paddingTop: insets.top + SPACING.sm };
  const { user, isAuthenticated } = useAuth();
  
  // ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS
  // Wishlist state and API
  const [wishlistItems, setWishlistItems] = useState<any[]>([]);
  const [storeGroups, setStoreGroups] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [hasProcessedProductDetail, setHasProcessedProductDetail] = useState(false);
  const [selectedPlatformTab, setSelectedPlatformTab] = useState('All');
  const [showItemStatusModal, setShowItemStatusModal] = useState(false);
  const itemStatusButtonRef = useRef<View>(null);
  const [itemStatusPosition, setItemStatusPosition] = useState({ top: 0, left: 0 });
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const collectionButtonRef = useRef<View>(null);
  const [collectionPosition, setCollectionPosition] = useState({ top: 0, left: 0 });
  const [showAllFiltersModal, setShowAllFiltersModal] = useState(false);
  const [tempFilters, setTempFilters] = useState({
    discoverDeals: [] as string[],
    itemStatus: [] as string[],
    collectionTime: [] as string[],
  });
  const [isManagementMode, setIsManagementMode] = useState(false);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest'>('newest');
  const [showSortModal, setShowSortModal] = useState(false);
  const sortButtonRef = useRef<View>(null);
  const [sortPosition, setSortPosition] = useState({ top: 0, left: 0 });
  const [groupByStore, setGroupByStore] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [similarSearchVisible, setSimilarSearchVisible] = useState(false);
  const [similarSearchBase64, setSimilarSearchBase64] = useState('');
  const [similarSearchUri, setSimilarSearchUri] = useState('');
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [shareTarget, setShareTarget] = useState<{
    productUrl: string;
    productName: string;
    shareMessage: string;
  } | null>(null);
  const [isBulkAddingToCart, setIsBulkAddingToCart] = useState(false);
  
  const { refreshExternalIds } = useWishlistStatus();
  const { showToast } = useToast();
  
  // Get platform and locale (defined early so they can be used in callbacks)
  const { selectedPlatform } = usePlatformStore();
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const appLocale = normalizeLocale(locale);
  
  // Translation function (defined early so it can be used in callbacks)
  const t = useCallback((key: string) => {
    const keys = key.split('.');
    let value: any = translations[locale as keyof typeof translations];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  }, [locale]);

  const formatWithCount = useCallback(
    (key: string, count: number) => (t(key) || key).replace('{count}', String(count)),
    [t],
  );

  const collectionTimeLabel = useCallback(
    (key: WishlistCollectionTimeKey) => {
      const labels: Record<WishlistCollectionTimeKey, string> = {
        '7d': t('profile.wishlistWithin7Days'),
        '30d': t('profile.wishlistWithin30Days'),
        '90d': t('profile.wishlistWithin90Days'),
        '6m': t('profile.wishlistSixMonthsAgo'),
        '1y': t('profile.wishlistOneYearAgo'),
      };
      return labels[key];
    },
    [t],
  );

  // Resolve multilingual object or string to string for current locale (subjectMultiLang, storeNameMultiLang, etc.)
  const resolveText = useCallback((value: unknown): string => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && ('en' in value || 'ko' in value || 'zh' in value)) {
      const o = value as Record<string, string>;
      return getLocalizedText(
        { en: o.en ?? '', ko: o.ko ?? '', zh: o.zh ?? '' },
        locale
      );
    }
    return String(value);
  }, [locale]);

  const resolveWishlistItemTitle = useCallback(
    (item: Record<string, unknown>) => {
      const fromFields = resolveViewedProductTitle(item, appLocale);
      if (fromFields) return fromFields;
      return resolveText(item.subjectMultiLang ?? item.title) || '';
    },
    [appLocale, resolveText],
  );

  const mapWishlistItem = useCallback((item: any) => {
    const raw =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
    const nameStr = resolveWishlistItemTitle(raw);
    const storeNameStr = resolveText(item.storeNameMultiLang ?? item.storeName) || '';
    return {
      id: item.externalId?.toString() || item._id?.toString() || '',
      _id: item._id ?? '',
      externalId: item.externalId?.toString() || '',
      offerId: item.externalId?.toString() || '',
      name: nameStr,
      title: nameStr,
      image: item.imageUrl || '',
      images: item.imageUrl ? [item.imageUrl] : [],
      price: item.price ?? 0,
      originalPrice: item.price ?? 0,
      description: '',
      category: { id: '', name: '', icon: '', image: '', subcategories: [] },
      subcategory: '',
      brand: '',
      seller: { id: item.storeId ?? '', name: storeNameStr, avatar: '', rating: 0, reviewCount: 0, isVerified: false, followersCount: 0, description: '', location: '', joinedDate: new Date() },
      rating: 0, reviewCount: 0, rating_count: 0,
      inStock: !item.isLowStock, stockCount: 0, tags: [],
      isNew: false, isFeatured: false, isOnSale: item.isDiscounted ?? false,
      createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
      updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
      orderCount: 0,
      source: item.source || '1688',
      purchased: item.purchased, isDiscounted: item.isDiscounted,
      isExpired: item.isExpired, isLowStock: item.isLowStock,
      productDetailFetchedAt: item.productDetailFetchedAt,
      storeId: item.storeId, storeName: storeNameStr,
      originalData: item,
    };
  }, [resolveText, resolveWishlistItemTitle]);

  const remapWishlistItemTitles = useCallback(
    (items: any[]) =>
      items.map((product) => {
        const raw = product?.originalData;
        if (!raw || typeof raw !== 'object') return product;
        const nameStr = resolveWishlistItemTitle(raw as Record<string, unknown>);
        return { ...product, name: nameStr, title: nameStr };
      }),
    [resolveWishlistItemTitle],
  );

  useEffect(() => {
    setWishlistItems((prev) => remapWishlistItemTitles(prev));
    setStoreGroups((prev) =>
      prev.map((group) => ({
        ...group,
        items: remapWishlistItemTitles(group.items || []),
      })),
    );
  }, [appLocale, remapWishlistItemTitles]);
  
  const buildAddToCartRequest = useCallback(
    (product: any, quantity: number = 1): AddToCartRequest | null => {
      const offerIdNum = parseInt(
        product.externalId || product.offerId || product.id || '0',
        10,
      );
      if (!offerIdNum) return null;

      const raw = product.originalData;
      const price = product.price ?? raw?.price ?? 0;
      const priceStr = String(price);
      const skuInfoFromApi = raw?.skuInfo;
      const skuInfo = skuInfoFromApi
        ? {
            skuId: skuInfoFromApi.skuId ?? offerIdNum,
            specId: skuInfoFromApi.specId ?? String(offerIdNum),
            price: skuInfoFromApi.price ?? priceStr,
            amountOnSale: skuInfoFromApi.amountOnSale ?? 999999,
            consignPrice:
              skuInfoFromApi.consignPrice ?? skuInfoFromApi.price ?? priceStr,
            cargoNumber: skuInfoFromApi.cargoNumber,
            skuAttributes: (skuInfoFromApi.skuAttributes || []).map(
              (attr: any) => ({
                attributeId: attr.attributeId ?? 0,
                attributeName: attr.attributeName ?? '',
                attributeNameTrans:
                  attr.attributeNameTrans ?? attr.attributeName ?? '',
                value: attr.value ?? '',
                valueTrans: attr.valueTrans ?? attr.value ?? '',
                skuImageUrl: attr.skuImageUrl,
              }),
            ),
            fenxiaoPriceInfo: skuInfoFromApi.fenxiaoPriceInfo || {
              offerPrice: priceStr,
            },
          }
        : {
            skuId: offerIdNum,
            specId: String(offerIdNum),
            price: priceStr,
            amountOnSale: 999999,
            consignPrice: priceStr,
            skuAttributes: [] as Array<{
              attributeId: number;
              attributeName: string;
              attributeNameTrans: string;
              value: string;
              valueTrans: string;
              skuImageUrl?: string;
            }>,
            fenxiaoPriceInfo: { offerPrice: priceStr },
          };

      return {
        offerId: offerIdNum,
        source: product.source || selectedPlatform || '1688',
        categoryId:
          parseInt(raw?.categoryId || product.category?.id || '0', 10) || 0,
        subject: product.name || product.title || raw?.subject || '',
        subjectTrans:
          product.name ||
          product.title ||
          raw?.subjectTrans ||
          raw?.subject ||
          '',
        imageUrl: product.image || product.images?.[0] || raw?.imageUrl || '',
        promotionUrl: raw?.promotionUrl,
        skuInfo,
        companyName:
          product.seller?.name ||
          product.storeName ||
          raw?.storeName ||
          (typeof raw?.companyName === 'string' ? raw.companyName : ''),
        sellerOpenId:
          product.seller?.id ||
          product.storeId ||
          raw?.storeId ||
          raw?.sellerOpenId ||
          '',
        quantity,
        minOrderQuantity:
          raw?.minOrderQuantity ?? product.minOrderQuantity ?? 1,
      };
    },
    [selectedPlatform],
  );

  const addProductToCart = useCallback(
    async (
      product: any,
      quantity: number = 1,
      options?: { silent?: boolean },
    ): Promise<boolean> => {
      const request = buildAddToCartRequest(product, quantity);
      if (!request) {
        if (!options?.silent) {
          showToast(t('product.invalidProductId') || 'Invalid product', 'error');
        }
        return false;
      }

      try {
        const response = await cartApi.addToCart(request);
        if (response.success && response.data) {
          return true;
        }
        if (!options?.silent) {
          showToast(
            response.message ||
              t('product.failedToAdd') ||
              'Failed to add to cart',
            'error',
          );
        }
        return false;
      } catch {
        if (!options?.silent) {
          showToast(
            t('product.failedToAdd') || 'Failed to add to cart',
            'error',
          );
        }
        return false;
      }
    },
    [buildAddToCartRequest, showToast, t],
  );

  const addToCart = useCallback(
    async (product: any, quantity: number = 1) => {
      const ok = await addProductToCart(product, quantity);
      if (ok) {
        showToast(t('product.addedToCart') || 'Added to cart', 'success');
      }
      return ok;
    },
    [addProductToCart, showToast, t],
  );
  
  const buildWishlistParams = useCallback(
    (grouped = groupByStore) => ({
      discounted: false,
      sort: sortBy === 'newest' ? 'recently_saved' : 'earliest',
      timeFilter: normalizeWishlistTimeFilter(
        tempFilters.collectionTime.length > 0
          ? tempFilters.collectionTime[0]
          : '1y',
      ),
      ...(grouped ? { groupByStore: true } : {}),
    }),
    [groupByStore, sortBy, tempFilters.collectionTime],
  );

  // Get wishlist mutation
  const { mutate: fetchWishlist, isLoading: wishlistLoading } = useGetWishlistMutation({
    onSuccess: (data) => {
      const byStore = Array.isArray(data?.wishlistByStore)
        ? data.wishlistByStore
        : [];
      const flat = Array.isArray(data?.wishlist) ? data.wishlist : [];

      // API may return wishlistByStore: [] together with wishlist: [...] — [] is truthy in JS,
      // so only use the grouped branch when it actually has groups (or groupByStore is on).
      if (groupByStore && byStore.length > 0) {
        const mappedGroups = byStore.map((group: any) => ({
          storeId: group.storeId,
          storeName:
            resolveText(group.storeNameMultiLang ?? group.storeName) ||
            group.storeName,
          items: (group.items || []).map((item: any) => mapWishlistItem(item)),
        }));
        setStoreGroups(mappedGroups);
        setWishlistItems(mappedGroups.flatMap((group) => group.items));
        return;
      }

      setStoreGroups([]);
      setWishlistItems(flat.map((item: any) => mapWishlistItem(item)));
    },
    onError: (error) => {
      showToast(error || t('profile.wishlistFailedToFetch'), 'error');
    },
  });

  const fetchWishlistRef = useRef(fetchWishlist);
  fetchWishlistRef.current = fetchWishlist;
  const buildWishlistParamsRef = useRef(buildWishlistParams);
  buildWishlistParamsRef.current = buildWishlistParams;
  const isFetchingWishlistRef = useRef(false);

  const reloadWishlist = useCallback(() => {
    if (!isAuthenticated || isFetchingWishlistRef.current) return;
    isFetchingWishlistRef.current = true;
    fetchWishlistRef
      .current(buildWishlistParamsRef.current())
      .finally(() => {
        isFetchingWishlistRef.current = false;
      });
  }, [isAuthenticated]);

  // Delete from wishlist mutation
  const { mutate: deleteFromWishlist } = useDeleteFromWishlistMutation({
    onSuccess: () => {
      showToast(t('product.productRemovedFromWishlist'), 'success');
      refreshExternalIds();
      reloadWishlist();
    },
    onError: (error) => {
      showToast(error || t('product.failedToRemoveFromWishlist'), 'error');
    },
  });

  // Batch delete from wishlist
  const { mutate: deleteFromWishlistBatch } = useDeleteFromWishlistBatchMutation({
    onSuccess: () => {
      showToast(t('product.productRemovedFromWishlist'), 'success');
      refreshExternalIds();
      reloadWishlist();
      setSelectedItems([]);
    },
    onError: (error) => {
      showToast(error || t('product.failedToRemoveFromWishlist'), 'error');
    },
  });

  const refreshWishlist = () => {
    reloadWishlist();
  };

  const toggleWishlist = async (product: any) => {
    if (!isAuthenticated) {
      return;
    }
    
    // Backend accepts either MongoDB _id or externalId as wishlistId
    const wishlistId =
      (product as any)._id?.toString() ||
      (product as any).externalId?.toString() ||
      (product as any).offerId?.toString() ||
      (product as any).id?.toString() ||
      '';

    if (!wishlistId) {
      showToast(t('product.invalidProductId'), 'error');
      return;
    }

    deleteFromWishlist(wishlistId);
  };
  
  // Product detail mutation removed - stub functions
  const productDetailData = null;
  const productDetailLoading = false;
  const productDetailError = false;
  const productDetailErrorData = null;
  const fetchProductDetail = (_productId: string) => {
    // Product detail API removed
  };
  const fetchProductDetailForNavigation = (productId: string, _source?: string, _country?: string) => {
    // Product detail API removed - navigate directly
    (navigation as any).navigate('ProductDetail', {
      productId: productId,
      source: _source || selectedPlatform,
      country: _country || (locale === 'zh' ? 'zh' : locale === 'ko' ? 'ko' : 'en'),
    });
  };

  const skipFilterReloadRef = useRef(true);

  useFocusEffect(
    useCallback(() => {
      reloadWishlist();
    }, [reloadWishlist]),
  );

  useEffect(() => {
    if (skipFilterReloadRef.current) {
      skipFilterReloadRef.current = false;
      return;
    }
    reloadWishlist();
  }, [sortBy, tempFilters.collectionTime, groupByStore, reloadWishlist]);

  const ScreenWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    embedded ? (
      <View style={[styles.container, styles.embeddedContainer]}>{children}</View>
    ) : (
      <SafeAreaView style={styles.container} edges={['left', 'right', 'bottom']}>
        {children}
      </SafeAreaView>
    );

  // If not authenticated, show login prompt
  if (!isAuthenticated) {
    return (
      <ScreenWrapper>
        <View style={[styles.header, embedded ? styles.embeddedHeader : headerTopStyle]}>
          {!embedded && (
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
              <Icon name="arrow-back" size={24} color={COLORS.text.primary} />
            </TouchableOpacity>
          )}
          <Text style={styles.headerTitle}>{t('profile.wishlistTitle')}</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.emptyContainer}>
          {/* <View style={styles.iconContainer}> */}
            <Image 
              source={require('../../assets/icons/wishlist.png')} 
              style={styles.wishlistImage}
              resizeMode="contain"
            />
          {/* </View> */}
          <Text style={styles.welcomeText}>{t('profile.wishlistWelcome')}</Text>
          <Text style={styles.loginPrompt}>
            {t('profile.wishlistLoginPrompt')}
          </Text>
          <TouchableOpacity
            style={styles.loginButton}
            onPress={() => (navigation as any).navigate('Auth')}
          >
            <Icon name="log-in-outline" size={20} color={COLORS.white} />
            <Text style={styles.loginButtonText}>{t('profile.wishlistLogin')}</Text>
          </TouchableOpacity>
        </View>
      </ScreenWrapper>
    );
  }

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchWishlist(buildWishlistParams());
    setRefreshing(false);
  };

  const handleProductPress = (product: Product) => {
    // Fetch product detail first, then navigate
    const productId = (product as any).offerId || (product as any).externalId || product.id;
    const source = (product as any).source || selectedPlatform || '1688';
    const country = locale === 'zh' ? 'zh' : locale === 'ko' ? 'ko' : 'en';
    fetchProductDetailForNavigation(productId, source, country);
  };

  const handleAddToCartClick = async (product: Product) => {
    // Reset processed flag for new product
    // setHasProcessedProductDetail(false);
    
    // Get product ID (offerId or externalId or id)
    const productId = (product as any).offerId || (product as any).externalId || product.id;
    // const source = (product as any).source || selectedPlatform || '1688';
    // const country = locale === 'zh' ? 'zh' : locale === 'ko' ? 'ko' : 'en';
    
    // if (!productId) {
    //   showToast('This product isn\'t available to add cart now', 'error');
    //   return;
    // }
    
    // Fetch product detail to get variation data
    // fetchProductDetail(productId, source, country);
  };
  
  // Handle product detail data when it's fetched (only process once per fetch)
  // Just add to cart directly without showing modal
  useEffect(() => {
    // Only proceed if product detail is fully loaded (not loading and has data)
    if (!productDetailLoading && productDetailData && !hasProcessedProductDetail) {
      // console.log('Wishlist: Product detail fetched', productDetailData);
      
      // Mark as processed to prevent infinite loop
      setHasProcessedProductDetail(true);
      
      // Add directly to cart without showing variation modal
      // console.log('Wishlist: Adding product to cart directly');
      handleAddToCart(productDetailData, 1);
    }
  }, [productDetailData, productDetailLoading, hasProcessedProductDetail]);
  
  // Handle error state (only show toast once per error)
  // Note: Error toast is already shown in onError callback, this is just a safety check
  useEffect(() => {
    if (productDetailError && !productDetailLoading && !hasProcessedProductDetail) {
      // console.error('Wishlist: Product detail fetch failed (useEffect)', productDetailError);
      // Toast already shown in onError callback, just mark as processed
      setHasProcessedProductDetail(true); // Mark as processed to prevent infinite loop
    }
  }, [productDetailError, productDetailLoading, hasProcessedProductDetail]);

  const handleAddToCart = async (product: Product, quantity: number = 1, selectedColor?: string, selectedSize?: string) => {
    try {
      await addToCart(product, quantity);
      // showToast('Product added to bag!', 'success');
      // Reset processed flag so next product can be added
      setHasProcessedProductDetail(false);
    } catch (error) {
      // showToast('Failed to add product to bag', 'error');
      // Reset processed flag on error so user can retry
      setHasProcessedProductDetail(false);
    }
  };



  const handleRemoveFromWishlist = async (product: any) => {
    if (!isAuthenticated) {
      // showToast('Please login to manage wishlist', 'warning');
      return;
    }
    
    try {
      toggleWishlist(product);
      // showToast('Item removed from wishlist', 'success');
    } catch (error) {
      // showToast('Failed to remove item from wishlist', 'error');
    }
  };

  const renderHeader = () => (
    <View style={[styles.header, embedded ? styles.embeddedHeader : headerTopStyle]}>
      <View style={styles.headerLeft}>
        {!embedded && (
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Icon name="chevron-back" size={24} color={COLORS.black} />
          </TouchableOpacity>
        )}
        <Text style={styles.headerTitle}>
          {t('profile.wishlistTitle')}({wishlistItems.length})
        </Text>
      </View>
      <View style={styles.headerRight}>
        <TouchableOpacity
          style={styles.headerIcon}
          onPress={() => {
            if (isManagementMode) {
              setIsManagementMode(false);
              setSelectedItems([]);
            } else {
              setIsManagementMode(true);
            }
          }}
        >
          <Text style={styles.managementText}>
            {isManagementMode ? t('profile.wishlistExit') : t('profile.wishlistManagement')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderInfoBar = () => (
    <View style={styles.infoBar}>
      <TouchableOpacity
        style={styles.filterButton}
        onPress={() => {
          setSelectedPlatformTab('All');
          setTempFilters({ discoverDeals: [], itemStatus: [], collectionTime: [] });
          setSortBy('newest');
          setGroupByStore(false);
        }}
      >
        <Text style={styles.filterButtonText}>
          {formatWithCount('profile.wishlistTotalItems', wishlistItems.length)}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.filterButton, groupByStore && styles.filterButtonActive]}
        onPress={() => setGroupByStore(prev => !prev)}
      >
        {/* <Icon name="storefront-outline" size={14} color={groupByStore ? COLORS.red : COLORS.text.primary} /> */}
        <Text style={[styles.filterButtonText, groupByStore && styles.filterButtonTextActive]}>
          {t('profile.wishlistItemsInSameStore')}
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderFilterBar = () => {
    return (
      <View style={styles.filterBarContainer}>
        <ScrollView 
          horizontal 
          showsHorizontalScrollIndicator={false}
          style={styles.filterBar}
          contentContainerStyle={styles.filterBarContent}
        >
          {/* <TouchableOpacity 
            style={[styles.filterButton, tempFilters.discoverDeals.includes('Discounted') && styles.filterButtonActive]}
            onPress={() => {
              const newDeals = tempFilters.discoverDeals.includes('Discounted')
                ? tempFilters.discoverDeals.filter(d => d !== 'Discounted')
                : [...tempFilters.discoverDeals, 'Discounted'];
              setTempFilters({ ...tempFilters, discoverDeals: newDeals });
            }}
          >
            <Text style={[
              styles.filterButtonText, 
              tempFilters.discoverDeals.includes('Discounted') && styles.filterButtonTextActive
            ]}>
              Discounted
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            ref={itemStatusButtonRef}
            style={[styles.filterButton, tempFilters.itemStatus.length > 0 && styles.filterButtonActive]}
            onPress={() => {
              itemStatusButtonRef.current?.measureInWindow((x, y, width, height) => {
                setItemStatusPosition({ top: y + height, left: x });
                setShowItemStatusModal(true);
              });
            }}
          >
            <Text style={[
              styles.filterButtonText,
              tempFilters.itemStatus.length > 0 && styles.filterButtonTextActive
            ]}>
              {tempFilters.itemStatus.length > 0 ? tempFilters.itemStatus[0] : 'Item Status'}
            </Text>
            <Icon name="chevron-down" size={16} color={tempFilters.itemStatus.length > 0 ? COLORS.primary : COLORS.text.secondary} />
          </TouchableOpacity> */}
          
          <TouchableOpacity 
            ref={collectionButtonRef}
            style={[styles.filterButton, tempFilters.collectionTime.length > 0 && styles.filterButtonActive]}
            onPress={() => {
              collectionButtonRef.current?.measureInWindow((x, y, width, height) => {
                setCollectionPosition({ top: y + height, left: x });
                setShowCollectionModal(true);
              });
            }}
          >
            <Text style={[
              styles.filterButtonText,
              tempFilters.collectionTime.length > 0 && styles.filterButtonTextActive
            ]}>
              {tempFilters.collectionTime.length > 0
                ? collectionTimeLabel(tempFilters.collectionTime[0] as WishlistCollectionTimeKey)
                : t('profile.wishlistCollectionTime')}
            </Text>
            <Icon name="chevron-down" size={16} color={tempFilters.collectionTime.length > 0 ? COLORS.primary : COLORS.text.secondary} />
          </TouchableOpacity>

          <TouchableOpacity
            ref={sortButtonRef as any}
            style={[styles.filterButton, sortBy !== 'newest' && styles.filterButtonActive]}
            onPress={() => {
              (sortButtonRef.current as any)?.measureInWindow((x: number, y: number, w: number, h: number) => {
                setSortPosition({ top: y + h, left: x });
                setShowSortModal(true);
              });
            }}
          >
            <Text style={[styles.filterButtonText, sortBy !== 'newest' && styles.filterButtonTextActive]}>
              {sortBy === 'newest' ? t('profile.wishlistSortMostRecent') : t('profile.wishlistSortOldest')}
            </Text>
            <Icon name="chevron-down" size={16} color={sortBy !== 'newest' ? COLORS.red : COLORS.text.secondary} />
          </TouchableOpacity>
        </ScrollView>
        
        {/* Filter icon button positioned over the filter bar */}
        {/* <View style={styles.filterIconOverlay}>
          <TouchableOpacity 
            style={styles.filterIconButton}
            onPress={() => setShowAllFiltersModal(true)}
          >
            <TuneIcon width={20} height={20} color={COLORS.black} />
          </TouchableOpacity>
        </View> */}
      </View>
    );
  };

  const hasWishlistContent =
    groupByStore && storeGroups.length > 0
      ? storeGroups.some((group) => (group.items?.length ?? 0) > 0)
      : wishlistItems.length > 0;

  // Filter wishlist items by platform (client-side only — API handles sort/time)
  const filteredItems = wishlistItems
    .filter((item: any) => {
      if (selectedPlatformTab === 'All') return true;
      const itemSource = item.source || '1688';
      if (selectedPlatformTab === 'Company Mall') {
        return itemSource.toLowerCase() === 'companymall' ||
               itemSource.toLowerCase() === 'company mall' ||
               itemSource.toLowerCase() === 'company';
      }
      return itemSource.toLowerCase() === selectedPlatformTab.toLowerCase();
    })
    .sort((a: any, b: any) => {
      const dateA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const dateB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return sortBy === 'newest' ? dateB - dateA : dateA - dateB;
    });

  const findWishlistItemById = useCallback(
    (id: string) => {
      const fromFiltered = filteredItems.find(
        (i: any) => i.id === id || i._id === id,
      );
      if (fromFiltered) return fromFiltered;
      for (const group of storeGroups) {
        const item = group.items?.find(
          (i: any) => i.id === id || i._id === id,
        );
        if (item) return item;
      }
      return wishlistItems.find((i: any) => i.id === id || i._id === id);
    },
    [filteredItems, storeGroups, wishlistItems],
  );

  const handleShare = useCallback(() => {
    if (selectedItems.length === 0) {
      showToast(t('profile.wishlistSelectToShare'), 'warning');
      return;
    }

    const product = findWishlistItemById(selectedItems[0]);
    const productId =
      product?.offerId || product?.externalId || product?.id || '';
    const productName = product?.name || product?.title || '';

    if (!productId || !productName) {
      showToast(t('product.invalidProductData'), 'error');
      return;
    }

    const source = product.source || selectedPlatform || '1688';
    const productUrl = buildProductSharePageUrl({
      productId: String(productId),
      source,
      country: locale,
    });
    const shareMessage = t('product.shareMessage')
      .replace('{productName}', productName)
      .replace('{price}', formatPriceKRW(product.price || 0));

    setShareTarget({ productUrl, productName, shareMessage });
    setShareModalVisible(true);
  }, [
    selectedItems,
    findWishlistItemById,
    selectedPlatform,
    locale,
    t,
    showToast,
  ]);

  const managementVisibleItems = useMemo(() => {
    if (groupByStore && storeGroups.length > 0) {
      return storeGroups.flatMap((group) => group.items || []);
    }
    return filteredItems;
  }, [groupByStore, storeGroups, filteredItems]);

  const handleAddSelectedToCart = useCallback(async () => {
    if (selectedItems.length === 0) {
      showToast(t('profile.wishlistSelectToAddCart'), 'warning');
      return;
    }

    const products = selectedItems
      .map((id) => findWishlistItemById(id))
      .filter(Boolean);

    if (products.length === 0) {
      showToast(t('product.invalidProductData'), 'error');
      return;
    }

    setIsBulkAddingToCart(true);
    let successCount = 0;
    let failCount = 0;

    for (const product of products) {
      const ok = await addProductToCart(product, 1, { silent: true });
      if (ok) {
        successCount += 1;
      } else {
        failCount += 1;
      }
    }

    setIsBulkAddingToCart(false);

    if (successCount > 0 && failCount === 0) {
      showToast(
        formatWithCount('profile.wishlistAddedToCartCount', successCount),
        'success',
      );
    } else if (successCount > 0 && failCount > 0) {
      showToast(
        (t('profile.wishlistPartialAddToCart') || '')
          .replace('{success}', String(successCount))
          .replace('{failed}', String(failCount)),
        'warning',
      );
    } else {
      showToast(
        t('profile.wishlistAddToCartFailed') ||
          t('product.failedToAdd') ||
          'Failed to add to cart',
        'error',
      );
    }
  }, [
    selectedItems,
    findWishlistItemById,
    addProductToCart,
    showToast,
    t,
    formatWithCount,
  ]);

  const renderProductItem = ({ item, index }: { item: any; index: number }) => {
    const isSelected = selectedItems.includes(item.id);
    
    return (
      <View style={styles.productItemContainer}>
        <View style={styles.productCard}>
          {isManagementMode && (
            <TouchableOpacity 
              style={styles.productCheckboxContainer}
              onPress={() => {
                if (isSelected) {
                  setSelectedItems(selectedItems.filter(id => id !== item.id));
                } else {
                  setSelectedItems([...selectedItems, item.id]);
                }
              }}
            >
              <View style={[styles.checkbox, isSelected && styles.checkboxChecked]}>
                {isSelected && <Icon name="checkmark" size={16} color={COLORS.white} />}
              </View>
            </TouchableOpacity>
          )}
          
          <View style={styles.productImageContainer}>
            <TouchableOpacity onPress={() => !isManagementMode && handleProductPress(item)}>
              <Image 
                source={{ uri: item.image || item.imageUrl }} 
                style={styles.productImage}
              />
            </TouchableOpacity>
          </View>
          
          <View style={styles.productInfo}>
            <TouchableOpacity onPress={() => !isManagementMode && handleProductPress(item)}>
              <Text style={styles.productName} numberOfLines={2}>
                {item.name || item.title}
              </Text>
            </TouchableOpacity>
            <Text style={styles.productPrice}>${item.price?.toFixed(2) || '0.00'}</Text>
          </View>
        </View>
        
        <TouchableOpacity
          style={styles.similarItemsButton}
          onPress={async () => {
            const imageUrl = item.image || item.imageUrl || '';
            if (!imageUrl) {
              showToast(t('profile.wishlistNoImage'), 'error');
              return;
            }
            try {
              const RNFS = require('react-native-fs');
              const tempPath = `${RNFS.CachesDirectoryPath}/wishlist_similar_${Date.now()}.jpg`;
              await RNFS.downloadFile({ fromUrl: imageUrl, toFile: tempPath }).promise;
              const base64 = await RNFS.readFile(tempPath, 'base64');
              setSimilarSearchUri(imageUrl);
              setSimilarSearchBase64(base64);
              setSimilarSearchVisible(true);
            } catch {
              showToast(t('profile.wishlistFailedLoadImage'), 'error');
            }
          }}
        >
          <Text style={styles.similarItemsText}>{t('profile.wishlistSimilarItems')}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconContainer}>
        <View style={styles.calendarIcon}>
          <Image source={require('../../assets/icons/wishlist.png')} />
        </View>
      </View>
      <Text style={styles.emptyTitle}>{t('profile.wishlistNothingInWishlist')}</Text>
      <Text style={styles.emptySubtitle}>
        {t('profile.wishlistEmptySubtitle')}
      </Text>
      <TouchableOpacity
        style={styles.startExploringButton}
        onPress={() => navigation.navigate('Main' as never)}
      >
        <Text style={styles.startExploringButtonText}>{t('profile.wishlistStartExploring')}</Text>
      </TouchableOpacity>
    </View>
  );

  // Only show full-screen loading when wishlist data is loading, not when adding to cart
  if (wishlistLoading) {
    return (
      <ScreenWrapper>
        {renderHeader()}
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      </ScreenWrapper>
    );
  }

  return (
    <ScreenWrapper>
      {renderHeader()}
      {renderInfoBar()}
      {renderFilterBar()}
      
      {!hasWishlistContent ? (
        renderEmptyState()
      ) : groupByStore ? (
        // Group by store — use API response
        <ScrollView
          style={styles.productsList}
          contentContainerStyle={styles.productsListContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {storeGroups.map((group) => (
            <View key={group.storeId} style={styles.storeGroup}>
              <View style={styles.storeGroupHeader}>
                {/* <Icon name="storefront-outline" size={16} color={COLORS.text.primary} /> */}
                <Text style={styles.storeGroupName} numberOfLines={1}>{group.storeName}</Text>
                <Text style={styles.storeGroupCount}>({group.items.length})</Text>
              </View>
              {group.items.map((item: any, index: number) => (
                <View key={`store-item-${item.id || item._id || index}`}>
                  {renderProductItem({ item, index })}
                </View>
              ))}
            </View>
          ))}
        </ScrollView>
      ) : (
        <FlatList
          data={filteredItems}
          renderItem={renderProductItem}
          keyExtractor={(item, index) => `product-${item.id}-${index}`}
          style={styles.productsList}
          contentContainerStyle={styles.productsListContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
      )}
      
      {/* Management Mode Footer */}
      {isManagementMode && managementVisibleItems.length > 0 && (
        <View style={styles.managementFooter}>
          <TouchableOpacity 
            style={styles.selectAllButton}
            onPress={() => {
              if (
                selectedItems.length === managementVisibleItems.length &&
                managementVisibleItems.length > 0
              ) {
                setSelectedItems([]);
              } else {
                setSelectedItems(
                  managementVisibleItems.map((item) => item.id),
                );
              }
            }}
          >
            <View style={[styles.checkbox, selectedItems.length === managementVisibleItems.length && managementVisibleItems.length > 0 && styles.checkboxChecked]}>
              {selectedItems.length === managementVisibleItems.length && managementVisibleItems.length > 0 && (
                <Icon name="checkmark" size={16} color={COLORS.white} />
              )}
            </View>
            <Text style={styles.selectAllText}>{t('profile.wishlistSelectAll')}</Text>
          </TouchableOpacity>
          
          <View style={styles.footerActions}>
            <TouchableOpacity
              style={[
                styles.footerButton,
                isBulkAddingToCart && styles.footerButtonDisabled,
              ]}
              disabled={isBulkAddingToCart || selectedItems.length === 0}
              onPress={handleAddSelectedToCart}
            >
              {isBulkAddingToCart ? (
                <ActivityIndicator size="small" color={COLORS.white} />
              ) : (
                <Text style={styles.footerButtonText}>{t('profile.wishlistAddToCart')}</Text>
              )}
            </TouchableOpacity>
            
            <TouchableOpacity
              style={styles.footerButton}
              onPress={handleShare}
            >
              <Text style={styles.footerButtonText}>{t('profile.wishlistShare')}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={styles.deleteFooterButton}
              onPress={() => {
                if (selectedItems.length === 0) {
                  showToast(t('profile.wishlistSelectToDelete'), 'warning');
                } else {
                  setShowDeleteConfirmModal(true);
                }
              }}
            >
              <Text style={styles.deleteFooterButtonText}>{t('profile.wishlistDelete')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      
      {/* Variation Selection Modal removed - adding to cart directly without modal */}
      
      {/* Loading indicator when fetching product detail */}
      {productDetailLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      )}
      
      {/* Item Status Dropdown Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showItemStatusModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowItemStatusModal(false)}
      >
        <TouchableOpacity 
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => setShowItemStatusModal(false)}
        >
          <View 
            style={[
              styles.dropdownMenu,
              {
                top: itemStatusPosition.top + 5,
                left: itemStatusPosition.left,
                minWidth: 150,
              }
            ]}
          >
            {/* Triangle pointer */}
            <View style={[styles.dropdownTriangle, { left: 20 }]} />
            
            {(
              [
                { key: 'purchased', labelKey: 'profile.wishlistPurchased' },
                { key: 'lowStock', labelKey: 'profile.wishlistLowStock' },
                { key: 'expired', labelKey: 'profile.wishlistExpired' },
              ] as const
            ).map(({ key, labelKey }) => (
              <TouchableOpacity
                key={key}
                style={styles.dropdownOption}
                onPress={() => {
                  setTempFilters({ ...tempFilters, itemStatus: [key] });
                  setShowItemStatusModal(false);
                }}
              >
                <Text style={[
                  styles.dropdownOptionText,
                  tempFilters.itemStatus.includes(key) && styles.dropdownOptionTextActive
                ]}>
                  {t(labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
      
      {/* Collection Time Dropdown Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showCollectionModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCollectionModal(false)}
      >
        <TouchableOpacity 
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => setShowCollectionModal(false)}
        >
          <View 
            style={[
              styles.dropdownMenu,
              {
                top: collectionPosition.top + 5,
                left: collectionPosition.left,
                minWidth: 180,
              }
            ]}
          >
            {/* Triangle pointer */}
            <View style={[styles.dropdownTriangle, { left: 20 }]} />
            
            {WISHLIST_COLLECTION_TIME_KEYS.map((timeKey) => (
              <TouchableOpacity
                key={timeKey}
                style={styles.dropdownOption}
                onPress={() => {
                  setTempFilters({ ...tempFilters, collectionTime: [timeKey] });
                  setShowCollectionModal(false);
                }}
              >
                <Text style={[
                  styles.dropdownOptionText,
                  tempFilters.collectionTime.includes(timeKey) && styles.dropdownOptionTextActive
                ]}>
                  {collectionTimeLabel(timeKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
      
      {/* Similar product image search modal */}
      {similarSearchVisible && (
        <ImageSearchResultsModal
          visible={similarSearchVisible}
          onClose={() => setSimilarSearchVisible(false)}
          imageUri={similarSearchUri}
          imageBase64={similarSearchBase64}
        />
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

      {/* Delete Confirm Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showDeleteConfirmModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDeleteConfirmModal(false)}
      >
        <View style={styles.deleteModalOverlay}>
          <View style={styles.deleteModalContent}>
            <Text style={styles.deleteModalTitle}>{t('profile.wishlistDeleteItemsTitle')}</Text>
            <Text style={styles.deleteModalMessage}>
              {formatWithCount('profile.wishlistDeleteConfirm', selectedItems.length)}
            </Text>
            <View style={styles.deleteModalButtons}>
              <TouchableOpacity
                style={styles.deleteModalCancelButton}
                onPress={() => setShowDeleteConfirmModal(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.deleteModalCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteModalConfirmButton}
                onPress={() => {
                  setShowDeleteConfirmModal(false);
                  const idsToDelete = selectedItems.map(id => {
                    const item = filteredItems.find(i => i.id === id || i._id === id);
                    return (item?._id || item?.externalId || item?.id || id) as string;
                  }).filter(Boolean);
                  deleteFromWishlistBatch(idsToDelete);
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.deleteModalConfirmText}>{t('common.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Sort Dropdown Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showSortModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSortModal(false)}
      >
        <TouchableOpacity
          style={styles.dropdownOverlay}
          activeOpacity={1}
          onPress={() => setShowSortModal(false)}
        >
          <View style={[styles.dropdownMenu, { top: sortPosition.top + 5, left: sortPosition.left, minWidth: 150 }]}>
            <View style={[styles.dropdownTriangle, { left: 20 }]} />
            {(['newest', 'oldest'] as const).map((val) => (
              <TouchableOpacity
                key={val}
                style={styles.dropdownOption}
                onPress={() => { setSortBy(val); setShowSortModal(false); }}
              >
                <Text style={[styles.dropdownOptionText, sortBy === val && styles.dropdownOptionTextActive]}>
                  {val === 'newest' ? t('profile.wishlistSortMostRecent') : t('profile.wishlistSortOldest')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* All Filters Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showAllFiltersModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAllFiltersModal(false)}
      >
        <View style={styles.allFiltersModalOverlay}>
          <View style={styles.allFiltersModal}>
            {/* Header */}
            <View style={styles.allFiltersHeader}>
              <TouchableOpacity onPress={() => setShowAllFiltersModal(false)}>
                {/* <Icon name="close" size={24} color={COLORS.black} /> */}
              </TouchableOpacity>
              <Text style={styles.allFiltersTitle}>{t('profile.wishlistAllFilters')}</Text>
              <TouchableOpacity onPress={() => setShowAllFiltersModal(false)}>
                <Icon name="close" size={24} color={COLORS.black} />
              </TouchableOpacity>
            </View>
            
            <ScrollView style={styles.allFiltersContent} showsVerticalScrollIndicator={false}>
              {/* Discover deals */}
              {/* <View style={styles.filterSection}>
                <Text style={styles.filterSectionTitle}>Discover deals</Text>
                <View style={styles.filterOptionsRow}>
                  <TouchableOpacity
                    style={[
                      styles.filterChip,
                      tempFilters.discoverDeals.includes('Discounted') && styles.filterChipActive
                    ]}
                    onPress={() => {
                      const newDeals = tempFilters.discoverDeals.includes('Discounted')
                        ? tempFilters.discoverDeals.filter(d => d !== 'Discounted')
                        : [...tempFilters.discoverDeals, 'Discounted'];
                      setTempFilters({ ...tempFilters, discoverDeals: newDeals });
                    }}
                  >
                    <Text style={[
                      styles.filterChipText,
                      tempFilters.discoverDeals.includes('Discounted') && styles.filterChipTextActive
                    ]}>
                      Discounted
                    </Text>
                  </TouchableOpacity>
                </View>
              </View> */}
              
              {/* Item Status */}
              {/* <View style={styles.filterSection}>
                <Text style={styles.filterSectionTitle}>Item Status</Text>
                <View style={styles.filterOptionsRow}>
                  {['Purchased', 'Low stock', 'Expired'].map((status) => (
                    <TouchableOpacity
                      key={status}
                      style={[
                        styles.filterChip,
                        tempFilters.itemStatus.includes(status) && styles.filterChipActive
                      ]}
                      onPress={() => {
                        const newStatus = tempFilters.itemStatus.includes(status)
                          ? tempFilters.itemStatus.filter(s => s !== status)
                          : [...tempFilters.itemStatus, status];
                        setTempFilters({ ...tempFilters, itemStatus: newStatus });
                      }}
                    >
                      <Text style={[
                        styles.filterChipText,
                        tempFilters.itemStatus.includes(status) && styles.filterChipTextActive
                      ]}>
                        {status}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View> */}
              
              {/* Collection time */}
              <View style={styles.filterSection}>
                <Text style={styles.filterSectionTitle}>{t('profile.wishlistCollectionTimeSection')}</Text>
                <View style={styles.filterOptionsRow}>
                  {WISHLIST_COLLECTION_TIME_KEYS.map((timeKey) => (
                    <TouchableOpacity
                      key={timeKey}
                      style={[
                        styles.filterChip,
                        tempFilters.collectionTime.includes(timeKey) && styles.filterChipActive
                      ]}
                      onPress={() => {
                        const newTime = tempFilters.collectionTime.includes(timeKey)
                          ? tempFilters.collectionTime.filter((k) => k !== timeKey)
                          : [...tempFilters.collectionTime, timeKey];
                        setTempFilters({ ...tempFilters, collectionTime: newTime });
                      }}
                    >
                      <Text style={[
                        styles.filterChipText,
                        tempFilters.collectionTime.includes(timeKey) && styles.filterChipTextActive
                      ]}>
                        {collectionTimeLabel(timeKey)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </ScrollView>
            
            {/* Footer Buttons */}
            <View style={styles.allFiltersFooter}>
              <TouchableOpacity
                style={styles.resetButton}
                onPress={() => {
                  setTempFilters({
                    discoverDeals: [],
                    itemStatus: [],
                    collectionTime: [],
                  });
                }}
              >
                <Text style={styles.resetButtonText}>{t('profile.wishlistReset')}</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={styles.confirmButton}
                onPress={() => {
                  // Apply filters here
                  setShowAllFiltersModal(false);
                }}
              >
                <Text style={styles.confirmButtonText}>{t('common.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScreenWrapper>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  embeddedContainer: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  embeddedHeader: {
    paddingTop: SPACING.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    // 상단 패딩은 headerTopStyle(= 안전영역 top + 약간) 으로 동적 적용 → 상태바 영역을 흰 헤더가 덮고 간격도 최소화.
    backgroundColor: COLORS.white,
    // borderBottomWidth: 1,
    // borderBottomColor: COLORS.gray[200],
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  backButton: {
    padding: SPACING.xs,
  },
  headerTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  headerIcon: {
    padding: SPACING.xs,
  },
  managementText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  platformTabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    backgroundColor: COLORS.white,
  },
  platformTabsContent: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    gap: SPACING.lg,
  },
  platformTab: {
    paddingVertical: SPACING.xs,
    marginHorizontal: SPACING.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  platformTabActive: {
    borderBottomColor: COLORS.red,
  },
  platformTabText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '700',
  },
  platformTabTextActive: {
    color: COLORS.red,
    fontWeight: '600',
  },
  infoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    backgroundColor: COLORS.background,
  },
  infoBarCount: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '400',
  },
  infoBarStoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: '#0000000D',
    backgroundColor: COLORS.white,
  },
  infoBarStoreButtonActive: {
    backgroundColor: COLORS.lightRed,
    borderColor: COLORS.red,
  },
  infoBarStoreText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  infoBarStoreTextActive: {
    color: COLORS.red,
  },
  storeGroup: {
    marginBottom: SPACING.md,
  },
  storeGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.gray[50],
    gap: SPACING.xs,
  },
  storeGroupName: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  storeGroupCount: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  filterBarContainer: {
    position: 'relative',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  filterBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.background,
  },
  filterBarContent: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.md,
    paddingRight: 60, // Space for the filter icon button
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    gap: SPACING.xs,
    backgroundColor: COLORS.white,
    borderColor: '#0000000D',
    borderWidth: 1,    
    borderRadius: BORDER_RADIUS.md,
  },
  filterButtonActive: {
    backgroundColor: COLORS.lightRed,
  },
  filterButtonText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  filterButtonTextActive: {
    color: COLORS.red,
  },
  filterIconOverlay: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingRight: SPACING.md,
    backgroundColor: COLORS.background,
    paddingLeft: SPACING.sm,
  },
  filterIconButton: {
    padding: SPACING.xs,
  },
  productsList: {
    flex: 1,
  },
  productsListContent: {
    paddingBottom: SPACING.xl,
    flexGrow: 1,
  },
  productItemContainer: {
    marginBottom: SPACING.md,
    backgroundColor: COLORS.white,
  },
  storeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  storeName: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  productCard: {
    flexDirection: 'row',
    padding: SPACING.md,
    backgroundColor: COLORS.white,
    gap: SPACING.sm,
    position: 'relative',
  },
  productImageContainer: {
    position: 'relative',
  },
  productImage: {
    width: 100,
    height: 100,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[200],
  },
  logoOverlay: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: COLORS.primary,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  logoText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.white,
    fontWeight: '600',
  },
  productInfo: {
    flex: 1,
    gap: 4,
  },
  productName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '400',
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 20 / 14),
  },
  productSpecs: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  productPrice: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  originalPrice: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    textDecorationLine: 'line-through',
  },
  quantity: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  similarItemsButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    marginRight: SPACING.md,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: BORDER_RADIUS.md,
  },
  similarItemsText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  removeButton: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.sm,
    padding: SPACING.xs,
  },
  addToCartButton: {
    position: 'absolute',
    bottom: SPACING.sm,
    right: SPACING.sm,
  },
  cartIconContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.black,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cartButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.small,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
  },
  emptyIconContainer: {
    marginBottom: SPACING.xl,
    alignItems: 'center',
  },
  calendarIcon: {
    width: 200,
    height: 200,
    position: 'relative',
  },
  emptyTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.text.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    textAlign: 'center',
    lineHeight: Math.round(FONTS.sizes.sm * 22 / 14),
    marginBottom: SPACING.xl,
  },
  startExploringButton: {
    backgroundColor: COLORS.black,
    padding: SPACING.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  startExploringButtonText: {
    fontSize: FONTS.sizes.base,
    fontWeight: '400',
    color: COLORS.white,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
  },
  iconContainer: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: '#FFE4E6',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xl,
  },
  wishlistImage: {
    width: 160,
    height: 200,
  },
  welcomeText: {
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  loginPrompt: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    marginBottom: SPACING.xl,
    textAlign: 'center',
    lineHeight: Math.round(FONTS.sizes.md * 22 / 16),
  },
  loginButton: {
    flexDirection: 'row',
    backgroundColor: '#FF0055',
    borderRadius: 9999,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    width: '100%',
  },
  loginButtonText: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.white,
    letterSpacing: 0.5,
  },
  placeholder: {
    width: 40,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  dropdownOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  dropdownMenu: {
    position: 'absolute',
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.xs,
    ...SHADOWS.md,
    elevation: 5,
    zIndex: 1001,
    marginTop: 8,
  },
  dropdownTriangle: {
    position: 'absolute',
    top: -8,
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
    zIndex: 1002,
  },
  dropdownOption: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    minWidth: 150,
  },
  dropdownOptionText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  dropdownOptionTextActive: {
    color: COLORS.primary,
    fontWeight: '600',
  },
  allFiltersModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  allFiltersModal: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    maxHeight: '80%',
  },
  allFiltersHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    // borderBottomWidth: 1,
    // borderBottomColor: COLORS.gray[200],
  },
  allFiltersTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    textAlign: 'center'
  },
  allFiltersContent: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  filterSection: {
    marginBottom: SPACING.md,
  },
  filterSectionTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
  },
  filterOptionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  filterChip: {
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.background,
    borderWidth: 1,
    borderColor: '#0000000D',
  },
  filterChipActive: {
    backgroundColor: COLORS.lightRed,
  },
  filterChipText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '400',
  },
  filterChipTextActive: {
    color: COLORS.red,
  },
  allFiltersFooter: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.md,
    paddingBottom: SPACING.md,
    gap: SPACING.md,
    // borderTopWidth: 1,
    // borderTopColor: COLORS.gray[200],
  },
  resetButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    backgroundColor: COLORS.white,
    alignItems: 'center',
  },
  resetButtonText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '400',
    color: COLORS.text.primary,
  },
  confirmButton: {
    flex: 1,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.red,
    alignItems: 'center',
  },
  confirmButtonText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.white,
  },
  checkboxContainer: {
    marginRight: SPACING.xs,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: COLORS.gray[400],
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: COLORS.red,
    borderColor: COLORS.red,
  },
  productCheckboxContainer: {
    position: 'absolute',
    top: SPACING.md,
    left: SPACING.md,
    zIndex: 10,
  },
  managementFooter: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING['2xl'],
    paddingTop: SPACING.lg,
    backgroundColor: COLORS.white,
  },
  selectAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  selectAllText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '400',
    color: COLORS.text.primary,
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  footerButton: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
  },
  footerButtonDisabled: {
    opacity: 0.6,
  },
  footerButtonText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '400',
    color: COLORS.text.primary,
  },
  deleteFooterButton: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#FFE1D4',
  },
  deleteFooterButtonText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '400',
    color: COLORS.red,
  },
  deleteModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
  },
  deleteModalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.xl,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.lg,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
  },
  deleteModalTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  deleteModalMessage: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    textAlign: 'center',
    marginBottom: SPACING['2xl'],
    lineHeight: Math.round(FONTS.sizes.md * 22 / 16),
  },
  deleteModalButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
    width: '100%',
  },
  deleteModalCancelButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.gray[100],
    alignItems: 'center',
  },
  deleteModalCancelText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  deleteModalConfirmButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.red,
    alignItems: 'center',
  },
  deleteModalConfirmText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.white,
  },
});

export default WishlistScreen;
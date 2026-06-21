import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  Image,
  Dimensions,
  StatusBar,
  Animated,
  Alert,
  Platform,
  PermissionsAndroid,
  Linking,
  Clipboard,
  Modal,
} from 'react-native';
import { launchCamera, launchImageLibrary, MediaType, ImagePickerResponse, CameraOptions, ImageLibraryOptions } from 'react-native-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../../components/Icon';
import RNFS from 'react-native-fs';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../../utils/permissions';
import LinearGradient from 'react-native-linear-gradient';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../constants';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { RootStackParamList, Product, Story } from '../../types';

import { SearchButton, NotificationBadge, ImagePickerModal, MemberAvatar } from '../../components';
import { usePlatformStore } from '../../store/platformStore';
import { useAppSelector } from '../../store/hooks';
import { translations } from '../../i18n/translations';
import { openProductDetail } from '../../utils/openProductDetail';
import { useResponsive } from '../../hooks/useResponsive';
import HeadsetMicIcon from '../../assets/icons/HeadsetMicIcon';
import MenuIcon from '../../assets/icons/MenuIcon';
import CategoryTabScreen from './CategoryTabScreen';
import TodayGgiguWordmarkIcon from '../../assets/icons/TodayGgiguWordmarkIcon';
import { useWishlistStatus } from '../../hooks/useWishlistStatus';
import { useAddToWishlistMutation } from '../../hooks/useAddToWishlistMutation';
import { useDeleteFromWishlistMutation } from '../../hooks/useDeleteFromWishlistMutation';
import { useSocket } from '../../context/SocketContext';
import { inquiryApi } from '../../services/inquiryApi';
import { orderApi, Order, OrderItem, mapLocaleToOrdersLang } from '../../services/orderApi';
import { productsApi } from '../../services/productsApi';
import Svg, { Circle, Path } from 'react-native-svg';
const LogoImage = require('../../assets/images/logo.png');
const KAKAO_CS_CHANNEL_URL = 'http://pf.kakao.com/_xlXLEX';

/** Figma TG_Main_S393: 393×3140, gutter 16 → content 361. Group 76728: H 472, left 16 */
const HOME_GUTTER = 16;
const HOME_CONTENT_WIDTH = Dimensions.get('window').width - HOME_GUTTER * 2;
// Reserved minimum-height for the guest welcome panel when it hosted
// the 10-orb category grid. Kept defined so the previous design can be
// restored quickly if the panel grows back; not currently referenced.
const GUEST_PROMO_MIN_HEIGHT = 472;
void GUEST_PROMO_MIN_HEIGHT;
const FIGMA_OVERLAY_05 = 'rgba(0,0,0,0.05)';
const FIGMA_OVERLAY_20 = 'rgba(0,0,0,0.2)';
/** Marketing / logistics accent from design reference */
const LOGISTICS_ORANGE = '#FF6600';

const { width: screenWidth } = Dimensions.get('window');
const width = screenWidth - SPACING.sm * 2; // Full width minus horizontal padding
// New In card sizing: 3 items per line, image should be less than 1/3 of mobile width
// Calculate: (width - left padding - right padding - 2 gaps) / 3
// Using smaller padding and gaps to ensure 3 items fit
const pagePadding = SPACING.sm * 2; // Left + right padding
const gaps = SPACING.xs * 2; // 2 gaps between 3 items
const NEW_IN_CARD_WIDTH = Math.floor((width - pagePadding - gaps) / 3);
const NEW_IN_CARD_HEIGHT = Math.floor(NEW_IN_CARD_WIDTH * 1.55);
const GRID_CARD_WIDTH = (width - SPACING.md * 2 - SPACING.md) / 2;

type HomeScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Main'>;

const getHomeMemberDisplayName = (user: {
  userName?: string;
  users_id?: string;
  name?: string;
  email?: string;
}) =>
  user.userName?.trim() ||
  user.users_id?.trim() ||
  user.name?.trim() ||
  user.email?.trim() ||
  'User';

const HomeScreen: React.FC = () => {
  const navigation = useNavigation<HomeScreenNavigationProp>();

  // Responsive layout — recalculates on rotation / split-screen / resize.
  // Phone (<600 short side) keeps the original 2-column layout. Tablet
  // portrait (600–899) shows 3 columns and tablet landscape (≥900 wide)
  // shows 4 columns, with gutters and icons scaled proportionally.
  const responsive = useResponsive();
  // Outer gutter that the section containers use. On tablets we widen
  // the gutter so content doesn't sprawl to the edges of a 10" screen.
  const homeGutter = responsive.isTablet ? responsive.gutter * 1.5 : HOME_GUTTER;
  // Live recalc of the guest-orb cell that the existing JSX consumes
  // (the `cellW` block further down). Forces re-render on rotation.
  const homeContentWidth = responsive.width - homeGutter * 2;

  const { user, isGuest, isAuthenticated } = useAuth();
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  // 주문 카드 하나의 실측 높이 — 2개 이상 주문일 때 스크롤 영역 높이를
  // 정확히 카드 2개분(+ 사이 간격) 으로 고정하기 위해 사용.
  const [uosOrderBlockHeight, setUosOrderBlockHeight] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    if (!isAuthenticated || isGuest) {
      setRecentOrders([]);
      return;
    }
    (async () => {
      const res = await orderApi.getOrders({
        page: 1,
        pageSize: 3,
        lang: mapLocaleToOrdersLang(locale),
      });
      if (cancelled) return;
      if (res.success && res.data?.orders) {
        setRecentOrders(res.data.orders);
      } else {
        setRecentOrders([]);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, isGuest, user?.id, locale]);

  const { showToast } = useToast();
  
  // Use wishlist status hook to check if products are liked based on external IDs
  const { isProductLiked, refreshExternalIds, addExternalId, removeExternalId } = useWishlistStatus();
  const { selectedPlatform, setSelectedPlatform } = usePlatformStore();
  
  // Add to wishlist mutation
  const { mutate: addToWishlist } = useAddToWishlistMutation({
    onSuccess: async (data) => {
      showToast(t('home.productAddedToWishlist'), 'success');
      // Immediately refresh external IDs to update heart icon color
      await refreshExternalIds();
    },
    onError: (error) => {
      showToast(error || t('home.failedToAddToWishlist'), 'error');
    },
  });

  // Delete from wishlist mutation
  const { mutate: deleteFromWishlist } = useDeleteFromWishlistMutation({
    onSuccess: async (data) => {
      showToast(t('home.productRemovedFromWishlist'), 'success');
      // Immediately update external IDs to update heart icon color
      await refreshExternalIds();
    },
    onError: (error) => {
      showToast(error || t('home.failedToRemoveFromWishlist'), 'error');
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
      // Remove from wishlist - optimistic update (removes from state and AsyncStorage immediately)
      await removeExternalId(externalId);
      deleteFromWishlist(externalId);
    } else {
      // Add to wishlist - extract required fields from product
      const imageUrl = product.image || product.images?.[0] || '';
      const price = product.price || 0;
      const title = product.name || product.title || '';

      if (!imageUrl || !title || price <= 0) {
        showToast(t('home.invalidProductData'), 'error');
        return;
      }

      // Optimistic update - add to state and AsyncStorage immediately
      await addExternalId(externalId);
      addToWishlist({ offerId: externalId, platform: source });
    }
  };
  
  const [featuredProducts, setFeaturedProducts] = useState<Product[]>([]);
  const [newProducts, setNewProducts] = useState<Product[]>([]);
  const [newInGridProducts, setNewInGridProducts] = useState<any[]>([]);
  const [saleProducts, setSaleProducts] = useState<Product[]>([]);
  const [trendingProducts, setTrendingProducts] = useState<any[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [initialLoading, setInitialLoading] = useState(true); // New state for initial loading
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  // 베스트상품 카드 우측에 표시할 1등 상품 썸네일. /products/search 응답의
  // products[0].image 를 한 번만 fetch 해서 캐싱한다. fetch 실패 시 null 로
  // 두면 회색 placeholder 가 그대로 노출되어 카드 레이아웃은 깨지지 않는다.
  const [bestProductThumb, setBestProductThumb] = useState<string | null>(null);
  // 신규등록상점 카드 우측에 표시할 첫 번째 상점 이미지.
  // 백엔드 sellers list endpoint 가 없어 동일 /products/search 응답의
  // products[0].image 를 첫 상점의 대표 이미지 proxy 로 사용.
  const [newStoreThumb, setNewStoreThumb] = useState<string | null>(null);
  // 인기업체 카드 우측에 표시할 첫 번째 인기업체 이미지.
  // 동일 응답에서 인기 순위 기준으로 두 번째 항목(products[1]) 을 사용 —
  // 첫 번째는 신규등록상점에서 이미 쓰고 있어서 시각적으로 중복되지 않도록.
  const [popularMerchantThumb, setPopularMerchantThumb] = useState<string | null>(null);
  // 인기검색순위 모달 — 인사이트 카드의 '인기검색순위 Hot10' 단추에서 열림.
  const [showPopularRankingModal, setShowPopularRankingModal] = useState(false);
  const [categoryModalVisible, setCategoryModalVisible] = useState(false);
  const [categoryModalTopOffset, setCategoryModalTopOffset] = useState(0);
  const headerTopRowRef = useRef<View>(null);

  const syncCategoryModalTopOffset = useCallback(() => {
    headerTopRowRef.current?.measureInWindow((_x, y, _w, height) => {
      if (y >= 0 && height > 0) {
        setCategoryModalTopOffset(y + height);
      }
    });
  }, []);

  const openCategoryModal = useCallback(() => {
    syncCategoryModalTopOffset();
    setCategoryModalVisible(true);
  }, [syncCategoryModalTopOffset]);

  useEffect(() => {
    if (!categoryModalVisible) return;
    syncCategoryModalTopOffset();
  }, [categoryModalVisible, responsive.width, responsive.height, syncCategoryModalTopOffset]);

  const { unreadCount: socketUnreadCount, onUnreadCountUpdated } = useSocket(); // Get total unread count from socket context
  const [unreadCount, setUnreadCount] = useState(0); // Local state for unread count (from REST API)
  const platforms = ['1688', 'taobao', 'myCompany'];
  
  // Fetch unread counts from REST API when screen comes into focus (throttled)
  const unreadCountRef = useRef(0);
  const lastFetchTimeRef = useRef(0);
  const FETCH_THROTTLE_MS = 30000; // Only fetch every 30 seconds

  useFocusEffect(
    React.useCallback(() => {
      const now = Date.now();
      if (now - lastFetchTimeRef.current < FETCH_THROTTLE_MS) {
        // Use cached value if recently fetched
        setUnreadCount(unreadCountRef.current);
        return;
      }

      const fetchUnreadCounts = async () => {
        try {
          lastFetchTimeRef.current = now;
          // 단일 합계만 필요하므로 가벼운 `/inquiries/unread-count` 사용.
          // 기존 `getUnreadCounts` (plural) 는 inquiry 별 unread 까지 반환해
          // 페이로드가 더 크다 — nav-bar 배지에는 단일 count 면 충분.
          const response = await inquiryApi.getUnreadCount();
          if (response.success && response.data) {
            unreadCountRef.current = response.data.count;
            setUnreadCount(response.data.count);
          }
        } catch (error) {
          // Failed to fetch unread counts - use cached value
          setUnreadCount(unreadCountRef.current);
        }
      };
      fetchUnreadCounts();
    }, []) // Remove onUnreadCountUpdated dependency to prevent frequent calls
  );
  
  // Update unread count from socket events (real-time updates)
  useEffect(() => {
    setUnreadCount(socketUnreadCount);
  }, [socketUnreadCount]);

  // 베스트상품 카드의 우측 썸네일을 위해 1등 상품 이미지 한 번 fetch.
  // /products/search 의 첫 번째 결과만 사용한다. BestProductsScreen 과 동일한
  // keyword '玩具' 로 호출해 일관성 유지.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 시그니처: keyword, source, country, page, pageSize, sort?, priceStart?,
        // priceEnd?, filter?, requireAuth, sellerOpenId?
        // pageSize=10 으로 1~10등 상품을 받아 10번째(index 9) 이미지를 사용한다.
        const res = await productsApi.searchProductsByKeyword(
          '玩具',
          '1688',
          locale,
          1,
          10,
          undefined, // sort
          undefined, // priceStart
          undefined, // priceEnd
          undefined, // filter
          false,     // requireAuth — 비로그인 게스트 카드에도 표시
        );
        if (cancelled) return;
        const list = res.data?.data?.products ?? [];
        // 10번째 상품을 우선 사용, 응답이 10개 미만이면 가능한 마지막 항목으로 fallback.
        const tenth = list[9] ?? list[list.length - 1];
        if (tenth?.image) setBestProductThumb(tenth.image);
        // 신규등록상점 카드의 우측 이미지 — 첫 번째 상품의 이미지를
        // 상점 대표 이미지의 proxy 로 사용 (전용 sellers endpoint 도입 전).
        const first = list[0];
        if (first?.image) setNewStoreThumb(first.image);
        // 인기업체 카드의 우측 이미지 — 두 번째 상품의 이미지를 첫 번째
        // 인기업체의 대표 이미지 proxy 로 사용. 신규등록상점과 시각적으로
        // 중복되지 않도록 별도 인덱스. 응답이 1개면 첫 번째로 fallback.
        const second = list[1] ?? list[0];
        if (second?.image) setPopularMerchantThumb(second.image);
      } catch {
        // 실패 시 thumb 가 null 로 남아 회색 placeholder 가 나옴 — 별도 알림 X.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);
  
  // Get categories for selected platform (using store instead)
  const getCompanyCategories = () => {
    // Mock data removed - using store instead
    return [];
  };
  
  const [imagePickerModalVisible, setImagePickerModalVisible] = useState(false);

  const [isScrolled, setIsScrolled] = useState(false); // Track if scrolled past threshold

  const scrollViewRef = useRef<ScrollView>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const SCROLL_THRESHOLD = 5; // Very fast animated color change
  
  // State for scroll to top button
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const scrollToTopOpacity = useRef(new Animated.Value(0)).current;
  
  // Translation function
  const t = (key: string) => {
    const keys = key.split('.');
    let value: any = translations[locale as keyof typeof translations];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  };

  // Map language codes to flag emojis
  const getLanguageFlag = (locale: string) => {
    const flags: { [key: string]: string } = {
      'en': '🇺🇸',
      'ko': '🇰🇷',
      'zh': '🇨🇳',
    };
    return flags[locale] || '🇺🇸';
  };

  const isFetchingProductDetail = false;

  // Helper function to navigate to product detail
  const navigateToProductDetail = async (
    productId: string | number,
    source: string = selectedPlatform,
    country: string = locale,
    thumbnailUrl?: string,
  ) => {
    // Centralised entry — prefetches the thumbnail and forwards it to
    // ProductDetailScreen so the hero slot paints instantly.
    openProductDetail(navigation as any, {
      productId: productId.toString(),
      source,
      country,
      thumbnailUrl,
    });
  };
  useEffect(() => {
    loadData();
  }, []);

  // Never block the home UI if startup hooks stall (e.g. slow device / network)
  useEffect(() => {
    const id = setTimeout(() => setInitialLoading(false), 4000);
    return () => clearTimeout(id);
  }, []);

  const loadData = async () => {
    try {
      // Set initial loading state
      if (initialLoading) {
        setLoading(true);
      }
      
      // Set empty stories for now
      setStories([]);
    } catch (error) {
      // Error loading home data
    } finally {
      setLoading(false);
      setInitialLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const scrollToTop = () => {
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
  };

  // Helper function to convert image URI to base64
  const convertUriToBase64 = async (uri: string): Promise<string | null> => {
    try {
      // Remove file:// prefix if present
      const fileUri = uri.startsWith('file://') ? uri.replace('file://', '') : uri;
      const base64 = await RNFS.readFile(fileUri, 'base64');
      return base64;
    } catch (error) {
      // console.error('Error converting URI to base64:', error);
      return null;
    }
  };

  const handleTakePhoto = async () => {
    // Request camera permission
    const granted = await requestCameraPermission();
    if (!granted) {
      Alert.alert(t('home.permissionRequired'), t('home.grantCameraPermission'));
      return;
    }

    const options: CameraOptions = {
      mediaType: 'photo' as MediaType,
      quality: 0.1, // Very low quality to ensure <1.2MB for large images
      saveToPhotos: false,
      includeBase64: true,
    };

    launchCamera(options, async (response: ImagePickerResponse) => {
      if (response.didCancel) {
        return;
      }
      if (response.errorCode) {
        Alert.alert(t('home.error'), response.errorMessage || t('home.failedToTakePhoto'));
        return;
      }
      if (response.assets && response.assets[0]) {
        setImagePickerModalVisible(false);
        let base64Data = response.assets[0].base64;

        // Image is already compressed with quality: 0.5 in camera/gallery options
        // Only compress if base64 is not available (fallback case)
        if (!base64Data && response.assets[0].uri) {
          const { compressImageForSearch } = require('../../utils/imageCompression');
          const compressedBase64 = await compressImageForSearch(response.assets[0].uri);
          if (compressedBase64) {
            base64Data = compressedBase64;
          } else {
            base64Data = await convertUriToBase64(response.assets[0].uri);
          }
        }

        if (!base64Data) {
          showToast(t('home.imageDataUnavailable'), 'error');
          return;
        }

        navigation.navigate('ImageSearch', {
          imageUri: response.assets[0].uri || '',
          imageBase64: base64Data,
        });
      }
    });
  };

  const handleChooseFromGallery = async () => {
    // Request media library permission
    const granted = await requestPhotoLibraryPermission();
    if (!granted) {
      Alert.alert(t('home.permissionRequired'), t('home.grantPhotoLibraryPermission'));
      return;
    }

    const options: ImageLibraryOptions = {
      mediaType: 'photo' as MediaType,
      quality: 0.1, // Very low quality to ensure <1.2MB for large images
      selectionLimit: 1,
      includeBase64: true,
    };

    launchImageLibrary(options, async (response: ImagePickerResponse) => {
      if (response.didCancel) {
        return;
      }
      if (response.errorCode) {
        Alert.alert(t('home.error'), response.errorMessage || t('home.failedToPickImage'));
        return;
      }
      if (response.assets && response.assets[0]) {
        setImagePickerModalVisible(false);
        let base64Data = response.assets[0].base64;

        // Image is already compressed with quality: 0.5 in camera/gallery options
        // Only compress if base64 is not available (fallback case)
        if (!base64Data && response.assets[0].uri) {
          const { compressImageForSearch } = require('../../utils/imageCompression');
          const compressedBase64 = await compressImageForSearch(response.assets[0].uri);
          if (compressedBase64) {
            base64Data = compressedBase64;
          } else {
            base64Data = await convertUriToBase64(response.assets[0].uri);
          }
        }

        if (!base64Data) {
          showToast(t('home.imageDataUnavailable'), 'error');
          return;
        }

        navigation.navigate('ImageSearch', {
          imageUri: response.assets[0].uri || '',
          imageBase64: base64Data,
        });
      }
    });
  };

  // const handleAddToCart = (product: Product) => {
  //   // For home screen items, variation ID is 0
  //   // addToCart(product, 1, undefined, undefined, 0);
  // };

  const handleImageSearch = async () => {
    // Navigate to camera screen
    navigation.navigate('ImageSearchCamera' as never);
  };

  const goGuestAuth = useCallback(() => {
    (navigation as any).navigate('Auth', { screen: 'Login', params: { fromProfile: true } });
  }, [navigation]);

  const renderGuestInsightGrid = () => {
    const insightCardStyle = (extra?: object) => [
      styles.guestInsightCard,
      responsive.isTabletLandscape && styles.guestInsightCardLandscape,
      extra,
    ];
    const insightRowStyle = [
      styles.guestInsightRow,
      responsive.isTabletLandscape && styles.guestInsightRowLandscape,
    ];
    const thumbStyle = [
      styles.bestProductsThumb,
      responsive.isTabletLandscape && styles.bestProductsThumbLandscape,
    ];

    const popularCard = (
        <TouchableOpacity
          style={insightCardStyle()}
          activeOpacity={0.88}
          onPress={() => setShowPopularRankingModal(true)}
        >
          {/* 헤더 — "인기검색순위" + 우측에 작은 붉은 "Hot10" 알약 배지 */}
          <View style={styles.popularCardHeader}>
            <Text style={styles.popularCardTitle} numberOfLines={1}>
              {t('home.popularRankingModal.title')}
            </Text>
            <View style={styles.popularCardHot10Badge}>
              <Text style={styles.popularCardHot10Text}>Hot10</Text>
            </View>
          </View>
          {/* 1행: 🔥 + 붉은 원형 1 + 선물 세트 + ↑ 2 */}
          <View style={styles.popularCardLine}>
            <Text style={styles.popularCardFire}>🔥</Text>
            <View style={styles.popularCardRankBadge}>
              <Text style={styles.popularCardRankText}>1</Text>
            </View>
            <Text style={styles.popularCardItem} numberOfLines={1}>
              {t('home.guestInsightPopularItem1')}
            </Text>
            <Text style={styles.popularCardUp}>{t('home.guestInsightPopularUp1')}</Text>
          </View>
          {/* 2행: 🔥 + 붉은 원형 2 + 가방 + ↑ 10 */}
          <View style={styles.popularCardLine}>
            <Text style={styles.popularCardFire}>🔥</Text>
            <View style={styles.popularCardRankBadge}>
              <Text style={styles.popularCardRankText}>2</Text>
            </View>
            <Text style={styles.popularCardItem} numberOfLines={1}>
              {t('home.guestInsightPopularItem2')}
            </Text>
            <Text style={styles.popularCardUp}>{t('home.guestInsightPopularUp2')}</Text>
          </View>
        </TouchableOpacity>
    );

    const newStoresCard = (
        <TouchableOpacity
          style={insightCardStyle(styles.bestProductsCard)}
          activeOpacity={0.88}
          onPress={() => (navigation as any).navigate('NewStores')}
        >
          {/* 베스트상품 카드와 동일한 layout 패턴 — 좌상단부터 텍스트가 흐르고
              우하단에 absolute 썸네일. 디자인 일관성 + 스타일 재사용. */}
          <Text style={styles.guestInsightTitle}>
            {t('home.guestInsightNewStoresTitle')}
          </Text>
          <Text style={styles.bestProductsSubtitle}>
            {t('home.guestInsightNewStoresSubtitle')}
          </Text>
          <Text style={styles.bestProductsTop10}>
            {t('home.guestInsightNewStoresCount')}
          </Text>
          <Text style={styles.bestProductsCta}>
            {t('home.guestInsightNewStoresCta')}{' '}&gt;
          </Text>
          {/* 첫 번째 상점 이미지 — 카드의 우하단에 absolute 위치.
              fetch 실패 시 회색 placeholder 로 보임. */}
          {newStoreThumb ? (
            <Image
              source={{ uri: newStoreThumb }}
              style={thumbStyle}
              resizeMode="cover"
            />
          ) : (
            <View style={[thumbStyle, styles.bestProductsThumbPlaceholder]} />
          )}
        </TouchableOpacity>
    );

    const merchantsCard = (
        <TouchableOpacity
          style={insightCardStyle(styles.bestProductsCard)}
          activeOpacity={0.88}
          onPress={() => (navigation as any).navigate('PopularMerchants')}
        >
          {/* 베스트상품 / 신규등록상점 카드와 동일한 layout 패턴 — 좌상단부터
              텍스트가 흐르고 우하단에 absolute 썸네일. 디자인 일관성. */}
          <Text style={styles.guestInsightTitle}>
            {t('home.guestInsightMerchantsTitle')}
          </Text>
          <Text style={styles.bestProductsSubtitle}>
            {t('home.guestInsightMerchantsSubtitle')}
          </Text>
          <Text style={styles.bestProductsTop10}>
            {t('home.guestInsightMerchantsTop10')}
          </Text>
          <Text style={styles.bestProductsCta}>
            {t('home.guestInsightMerchantsCta')}{' '}&gt;
          </Text>
          {/* 첫 번째 인기업체 이미지 — 카드의 우하단에 absolute 위치.
              fetch 실패 시 회색 placeholder 로 보임. */}
          {popularMerchantThumb ? (
            <Image
              source={{ uri: popularMerchantThumb }}
              style={thumbStyle}
              resizeMode="cover"
            />
          ) : (
            <View style={[thumbStyle, styles.bestProductsThumbPlaceholder]} />
          )}
        </TouchableOpacity>
    );

    const bestProductsCard = (
        <TouchableOpacity
          style={insightCardStyle(styles.bestProductsCard)}
          activeOpacity={0.88}
          onPress={() => (navigation as any).navigate('BestProducts')}
        >
          {/* 카드 전체를 relative 컨테이너로 두고 썸네일을 우하단에 absolute 배치.
              텍스트들은 좌상단부터 자연스럽게 흐른다 — 스크린샷의 레이아웃과 일치. */}
          <Text style={styles.guestInsightTitle}>
            {t('home.guestInsightBestProductsTitle')}
          </Text>
          <Text style={styles.bestProductsSubtitle}>
            {t('home.guestInsightBestProductsMeta')} Top10
          </Text>
          <Text style={styles.bestProductsTop10}>Top10</Text>
          <Text style={styles.bestProductsCta}>
            {t('home.guestInsightBestProductsCta')}{' '}&gt;
          </Text>
          {/* 1등 상품 썸네일 — 카드의 우하단에 absolute 위치.
              fetch 실패 시 회색 placeholder 로 보임. */}
          {bestProductThumb ? (
            <Image
              source={{ uri: bestProductThumb }}
              style={thumbStyle}
              resizeMode="cover"
            />
          ) : (
            <View style={[thumbStyle, styles.bestProductsThumbPlaceholder]} />
          )}
        </TouchableOpacity>
    );

    if (responsive.isTabletLandscape) {
      return (
        <View style={styles.guestInsightGrid}>
          <View style={insightRowStyle}>
            {popularCard}
            {newStoresCard}
            {merchantsCard}
            {bestProductsCard}
          </View>
        </View>
      );
    }

    return (
      <View style={styles.guestInsightGrid}>
        <View style={insightRowStyle}>
          {popularCard}
          {newStoresCard}
        </View>
        <View style={insightRowStyle}>
          {merchantsCard}
          {bestProductsCard}
        </View>
      </View>
    );
  };

  const renderGuestWelcomePanel = () => (
    <View style={styles.guestWelcomePanel}>
      <View style={styles.guestWelcomeHeadRow}>
        <Image
          source={require('../../assets/icons/mascot.png')}
          style={styles.guestMascot}
          resizeMode="contain"
          accessibilityLabel="mascot"
        />
        <View><View><Text style={styles.guestWelcomeHeadline1}>{t('home.guestWelcomeHeadline1')}</Text></View>
        {/* '안녕하세요!' 밑의 부제(1688 플랫폼 기반...) 제거(사용자 요청) */}
        </View>
      </View>
      <View style={styles.guestQuickStrip}>
        {([
          { icon: 'receipt-outline', label: t('home.guestQuickOrders') },
          { icon: 'cart-outline', label: t('home.guestQuickCart') },
          { icon: 'heart-outline', label: t('home.guestQuickPick') },
          { icon: 'followedstore', label: t('home.guestQuickLikedStores') },
          {
            icon: (
              <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M5.49688 8.32188C5.13021 8.32188 4.81771 8.19271 4.55938 7.93438C4.30104 7.67604 4.17188 7.36354 4.17188 6.99688C4.17188 6.63021 4.30104 6.31771 4.55938 6.05938C4.81771 5.80104 5.13021 5.67188 5.49688 5.67188C5.86354 5.67188 6.17604 5.80104 6.43438 6.05938C6.69271 6.31771 6.82188 6.63021 6.82188 6.99688C6.82188 7.36354 6.69271 7.67604 6.43438 7.93438C6.17604 8.19271 5.86354 8.32188 5.49688 8.32188ZM9.99688 22.3219C8.79688 22.3219 7.77604 21.901 6.93438 21.0594C6.09271 20.2177 5.67188 19.1969 5.67188 17.9969V11.9969C5.67188 10.2302 6.28438 8.73438 7.50938 7.50938C8.73438 6.28438 10.2302 5.67188 11.9969 5.67188H13.8219C15.0552 5.67188 16.1135 6.09271 16.9969 6.93438C17.8802 7.77604 18.3219 8.80521 18.3219 10.0219C18.3219 10.8552 18.0969 11.6177 17.6469 12.3094C17.1969 13.001 16.5969 13.5302 15.8469 13.8969C15.3802 14.1302 15.0094 14.4635 14.7344 14.8969C14.4594 15.3302 14.3219 15.8052 14.3219 16.3219V17.9969C14.3219 19.1969 13.901 20.2177 13.0594 21.0594C12.2177 21.901 11.1969 22.3219 9.99688 22.3219ZM7.99688 6.32188C7.63021 6.32188 7.31771 6.19271 7.05938 5.93438C6.80104 5.67604 6.67188 5.36354 6.67188 4.99688V4.49688C6.67188 4.13021 6.80104 3.81771 7.05938 3.55938C7.31771 3.30104 7.63021 3.17188 7.99688 3.17188C8.36354 3.17188 8.67604 3.30104 8.93438 3.55938C9.19271 3.81771 9.32188 4.13021 9.32188 4.49688V4.99688C9.32188 5.36354 9.19271 5.67604 8.93438 5.93438C8.67604 6.19271 8.36354 6.32188 7.99688 6.32188ZM9.99688 19.6719C10.4635 19.6719 10.8594 19.5094 11.1844 19.1844C11.5094 18.8594 11.6719 18.4635 11.6719 17.9969V16.3219C11.6719 15.2885 11.9469 14.3427 12.4969 13.4844C13.0469 12.626 13.7885 11.9719 14.7219 11.5219C15.0052 11.3885 15.2344 11.1844 15.4094 10.9094C15.5844 10.6344 15.6719 10.3302 15.6719 9.99687C15.6719 9.51354 15.4844 9.11354 15.1094 8.79688C14.7344 8.48021 14.3052 8.32188 13.8219 8.32188H11.9969C10.9802 8.32188 10.1135 8.68021 9.39687 9.39687C8.68021 10.1135 8.32188 10.9802 8.32188 11.9969V17.9969C8.32188 18.4635 8.48438 18.8594 8.80938 19.1844C9.13438 19.5094 9.53021 19.6719 9.99688 19.6719ZM11.1469 5.32188C10.7802 5.32188 10.4677 5.19271 10.2094 4.93438C9.95104 4.67604 9.82188 4.36354 9.82188 3.99688V3.49688C9.82188 3.13021 9.95104 2.81771 10.2094 2.55937C10.4677 2.30104 10.7802 2.17188 11.1469 2.17188C11.5135 2.17188 11.826 2.30104 12.0844 2.55937C12.3427 2.81771 12.4719 3.13021 12.4719 3.49688V3.99688C12.4719 4.36354 12.3427 4.67604 12.0844 4.93438C11.826 5.19271 11.5135 5.32188 11.1469 5.32188ZM14.2969 5.32188C13.9302 5.32188 13.6177 5.19271 13.3594 4.93438C13.101 4.67604 12.9719 4.36354 12.9719 3.99688V2.99688C12.9719 2.63021 13.101 2.31771 13.3594 2.05938C13.6177 1.80104 13.9302 1.67188 14.2969 1.67188C14.6635 1.67188 14.976 1.80104 15.2344 2.05938C15.4927 2.31771 15.6219 2.63021 15.6219 2.99688V3.99688C15.6219 4.36354 15.4927 4.67604 15.2344 4.93438C14.976 5.19271 14.6635 5.32188 14.2969 5.32188ZM17.9469 6.32188C17.4469 6.32188 17.0177 6.14271 16.6594 5.78438C16.301 5.42604 16.1219 4.99688 16.1219 4.49688V3.49688C16.1219 2.99688 16.301 2.56771 16.6594 2.20938C17.0177 1.85104 17.4469 1.67188 17.9469 1.67188C18.4469 1.67188 18.876 1.85104 19.2344 2.20938C19.5927 2.56771 19.7719 2.99688 19.7719 3.49688V4.49688C19.7719 4.99688 19.5927 5.42604 19.2344 5.78438C18.876 6.14271 18.4469 6.32188 17.9469 6.32188Z"
                  fill={COLORS.text.primary}
                />
              </Svg>
            ),
            label: t('home.guestQuickHistory'),
          },
        ] as Array<{ icon: string | React.ReactNode; label: string }>).map((item) => (
          <TouchableOpacity key={item.label} style={styles.guestQuickItem} onPress={goGuestAuth} activeOpacity={0.85}>
            {typeof item.icon === 'string' ? (
              <Icon name={item.icon} size={22} color={COLORS.text.primary} />
            ) : (
              item.icon
            )}
            <Text style={styles.guestQuickLabel} numberOfLines={1}>
              {item.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.guestBulletGrid}>
        {([
          {
            line: t('home.guestBullet1'),
            icon: (
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                <Path
                  d="M6.66927 10.6693C7.78038 10.6693 8.72483 10.2804 9.5026 9.5026C10.2804 8.72483 10.6693 7.78038 10.6693 6.66927C10.6693 5.55816 10.2804 4.61372 9.5026 3.83594C8.72483 3.05816 7.78038 2.66927 6.66927 2.66927C5.55816 2.66927 4.61372 3.05816 3.83594 3.83594C3.05816 4.61372 2.66927 5.55816 2.66927 6.66927C2.66927 7.78038 3.05816 8.72483 3.83594 9.5026C4.61372 10.2804 5.55816 10.6693 6.66927 10.6693ZM5.96927 9.03594L9.73594 5.2526L8.78594 4.3026L5.96927 7.13594L4.5526 5.73594L3.6026 6.66927L5.96927 9.03594ZM6.66927 12.0026C5.18038 12.0026 3.91927 11.4859 2.88594 10.4526C1.8526 9.41927 1.33594 8.15816 1.33594 6.66927C1.33594 5.18038 1.8526 3.91927 2.88594 2.88594C3.91927 1.8526 5.18038 1.33594 6.66927 1.33594C8.15816 1.33594 9.41927 1.8526 10.4526 2.88594C11.4859 3.91927 12.0026 5.18038 12.0026 6.66927C12.0026 7.29149 11.9054 7.8776 11.7109 8.4276C11.5165 8.9776 11.2415 9.48038 10.8859 9.93594L14.6693 13.7359L13.7359 14.6693L9.93594 10.8859C9.48038 11.2415 8.9776 11.5165 8.4276 11.7109C7.8776 11.9054 7.29149 12.0026 6.66927 12.0026Z"
                  fill={LOGISTICS_ORANGE}
                />
              </Svg>
            ),
          },
          {
            line: t('home.guestBullet2'),
            icon: (
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                <Path
                  d="M9.70313 11.0359L7.33646 8.66927V5.33594H8.66979V8.11927L10.6365 10.0859L9.70313 11.0359ZM7.33646 4.0026V2.66927H8.66979V4.0026H7.33646ZM12.0031 8.66927V7.33594H13.3365V8.66927H12.0031ZM7.33646 13.3359V12.0026H8.66979V13.3359H7.33646ZM2.66979 8.66927V7.33594H4.00313V8.66927H2.66979ZM8.0026 14.6693C7.08038 14.6693 6.21372 14.4943 5.4026 14.1443C4.59149 13.7943 3.88594 13.3193 3.28594 12.7193C2.68594 12.1193 2.21094 11.4137 1.86094 10.6026C1.51094 9.79149 1.33594 8.92483 1.33594 8.0026C1.33594 7.08038 1.51094 6.21372 1.86094 5.4026C2.21094 4.59149 2.68594 3.88594 3.28594 3.28594C3.88594 2.68594 4.59149 2.21094 5.4026 1.86094C6.21372 1.51094 7.08038 1.33594 8.0026 1.33594C8.92483 1.33594 9.79149 1.51094 10.6026 1.86094C11.4137 2.21094 12.1193 2.68594 12.7193 3.28594C13.3193 3.88594 13.7943 4.59149 14.1443 5.4026C14.4943 6.21372 14.6693 7.08038 14.6693 8.0026C14.6693 8.92483 14.4943 9.79149 14.1443 10.6026C13.7943 11.4137 13.3193 12.1193 12.7193 12.7193C12.1193 13.3193 11.4137 13.7943 10.6026 14.1443C9.79149 14.4943 8.92483 14.6693 8.0026 14.6693ZM8.0026 13.3359C9.49149 13.3359 10.7526 12.8193 11.7859 11.7859C12.8193 10.7526 13.3359 9.49149 13.3359 8.0026C13.3359 6.51371 12.8193 5.2526 11.7859 4.21927C10.7526 3.18594 9.49149 2.66927 8.0026 2.66927C6.51371 2.66927 5.2526 3.18594 4.21927 4.21927C3.18594 5.2526 2.66927 6.51371 2.66927 8.0026C2.66927 9.49149 3.18594 10.7526 4.21927 11.7859C5.2526 12.8193 6.51371 13.3359 8.0026 13.3359Z"
                  fill={LOGISTICS_ORANGE}
                />
              </Svg>
            ),
          },
          {
            line: t('home.guestBullet3'),
            icon: (
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                <Path
                  d="M3.9974 14.6693C3.63073 14.6693 3.31684 14.5387 3.05573 14.2776C2.79462 14.0165 2.66406 13.7026 2.66406 13.3359V2.66927C2.66406 2.3026 2.79462 1.98872 3.05573 1.7276C3.31684 1.46649 3.63073 1.33594 3.9974 1.33594H11.9974C12.3641 1.33594 12.678 1.46649 12.9391 1.7276C13.2002 1.98872 13.3307 2.3026 13.3307 2.66927V13.3359C13.3307 13.7026 13.2002 14.0165 12.9391 14.2776C12.678 14.5387 12.3641 14.6693 11.9974 14.6693H3.9974ZM3.9974 13.3359H11.9974V2.66927H3.9974V13.3359ZM4.66406 12.0026H11.3307L9.03073 9.0026L7.4974 11.0026L6.46406 9.66927L4.66406 12.0026Z"
                  fill={LOGISTICS_ORANGE}
                />
              </Svg>
            ),
          },
          {
            line: t('home.guestBullet4'),
            icon: (
              <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
                <Path
                  d="M5.73073 15L4.46406 12.8667L2.06406 12.3333L2.29739 9.86667L0.664062 8L2.29739 6.13333L2.06406 3.66667L4.46406 3.13333L5.73073 1L7.99739 1.96667L10.2641 1L11.5307 3.13333L13.9307 3.66667L13.6974 6.13333L15.3307 8L13.6974 9.86667L13.9307 12.3333L11.5307 12.8667L10.2641 15L7.99739 14.0333L5.73073 15ZM6.29739 13.3L7.99739 12.5667L9.73073 13.3L10.6641 11.7L12.4974 11.2667L12.3307 9.4L13.5641 8L12.3307 6.56667L12.4974 4.7L10.6641 4.3L9.69739 2.7L7.99739 3.43333L6.26406 2.7L5.33073 4.3L3.49739 4.7L3.66406 6.56667L2.43073 8L3.66406 9.4L3.49739 11.3L5.33073 11.7L6.29739 13.3ZM7.29739 10.3667L11.0641 6.6L10.1307 5.63333L7.29739 8.46667L5.86406 7.06667L4.93073 8L7.29739 10.3667Z"
                  fill={LOGISTICS_ORANGE}
                />
              </Svg>
            ),
          },
        ] as Array<{ line: string; icon: React.ReactNode }>).map(({ line, icon }) => (
          <View key={line} style={styles.guestBulletCell}>
            {icon}
            <Text style={styles.guestBulletText}>{line}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity style={styles.guestPrimaryLoginBtn} activeOpacity={0.9} onPress={goGuestAuth}>
        <Text style={styles.guestPrimaryLoginText}>
          {String(t('home.guestPrimaryLogin')).replace('{brand}', t('home.logo'))}
        </Text>
      </TouchableOpacity>

      {/* Orb category grid (시장의 카테고리 10개) removed per request.
          The 2 service cards (시장조사 / OEM공장조사) used to live in
          `renderGlobalLogisticsSection` below — they're now rendered
          INSIDE this red welcome panel in their place. */}
      {renderGuestWelcomeServiceCards()}
      {/* Keep `renderGuestOrbGrid` reachable for the linter even
          though it is no longer rendered, so the definition stays
          available for a one-line restore. */}
      {void renderGuestOrbGrid}
    </View>
  );

  /**
   * Two-card row (시장조사 / OEM공장조사) shown inside the red guest
   * welcome panel, replacing the previous orb category grid. Card
   * width is computed from the panel's inner box so the two cards
   * line up flush with the panel's symmetric `padding: SPACING.md`.
   */
  const renderGuestWelcomeServiceCards = () => {
    const cardGap = responsive.isTablet ? SPACING.md : SPACING.sm;
    // Panel inner width = screen − parent guestAboveFold padding
    // − guestWelcomePanel padding (both sides).
    const innerWidth = responsive.width - homeGutter * 2 - SPACING.md * 2;
    const cardWidth = Math.floor((innerWidth - cardGap) / 2);

    // SVG icons (matching the originals from `renderGlobalLogisticsSection`).
    // Defined inline here because the originals are scoped inside that
    // function and not accessible from this helper. Using `Ionicons`-style
    // string names produced a `?` placeholder because the names weren't
    // registered with the icon set; full SVGs render reliably.
    const SurveyIcon = (
      <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
        <Circle cx={24} cy={24} r={23.5} fill="white" stroke={LOGISTICS_ORANGE} />
        <Path
          d="M18.3958 22.8005V17.9339C18.3958 17.2116 18.6486 16.5977 19.1542 16.0922C19.6597 15.5866 20.2736 15.3339 20.9958 15.3339C21.7181 15.3339 22.3319 15.5866 22.8375 16.0922C23.3431 16.5977 23.5958 17.2116 23.5958 17.9339V22.8005C23.5958 23.5227 23.3431 24.1366 22.8375 24.6422C22.3319 25.1477 21.7181 25.4005 20.9958 25.4005C20.2736 25.4005 19.6597 25.1477 19.1542 24.6422C18.6486 24.1366 18.3958 23.5227 18.3958 22.8005ZM25.7292 21.2672V12.4672C25.7292 11.745 25.9819 11.1311 26.4875 10.6255C26.9931 10.12 27.6069 9.86719 28.3292 9.86719C29.0514 9.86719 29.6653 10.12 30.1708 10.6255C30.6764 11.1311 30.9292 11.745 30.9292 12.4672V21.2672C30.9292 22.1339 30.6569 22.7839 30.1125 23.2172C29.5681 23.6505 28.9736 23.8672 28.3292 23.8672C27.6847 23.8672 27.0903 23.6505 26.5458 23.2172C26.0014 22.7839 25.7292 22.1339 25.7292 21.2672ZM11.0625 27.0005V23.4005C11.0625 22.6783 11.3153 22.0644 11.8208 21.5589C12.3264 21.0533 12.9403 20.8005 13.6625 20.8005C14.3847 20.8005 14.9986 21.0533 15.5042 21.5589C16.0097 22.0644 16.2625 22.6783 16.2625 23.4005V27.0005C16.2625 27.8672 15.9903 28.5172 15.4458 28.9505C14.9014 29.3839 14.3069 29.6005 13.6625 29.6005C13.0181 29.6005 12.4236 29.3839 11.8792 28.9505C11.3347 28.5172 11.0625 27.8672 11.0625 27.0005ZM15.4018 36.8005C14.6201 36.8005 14.0792 36.445 13.7792 35.7339C13.4792 35.0227 13.6069 34.3894 14.1625 33.8339L19.7625 28.2339C20.0958 27.9005 20.4908 27.7227 20.9475 27.7005C21.4039 27.6783 21.8089 27.8227 22.1625 28.1339L25.7292 31.2005L34.5958 22.3339H34.4292C33.9403 22.3339 33.5236 22.1616 33.1792 21.8172C32.8347 21.4727 32.6625 21.0561 32.6625 20.5672C32.6625 20.0783 32.8347 19.6616 33.1792 19.3172C33.5236 18.9727 33.9403 18.8005 34.4292 18.8005H38.8292C39.3181 18.8005 39.7347 18.9727 40.0792 19.3172C40.4236 19.6616 40.5958 20.0783 40.5958 20.5672V24.9672C40.5958 25.4561 40.4236 25.8727 40.0792 26.2172C39.7347 26.5616 39.3181 26.7339 38.8292 26.7339C38.3403 26.7339 37.9236 26.5616 37.5792 26.2172C37.2347 25.8727 37.0625 25.4561 37.0625 24.9672V24.8005L27.0958 34.7672C26.7625 35.1005 26.3675 35.2783 25.9108 35.3005C25.4544 35.3227 25.0494 35.1783 24.6958 34.8672L21.1292 31.8005L16.6292 36.3005C16.4514 36.4783 16.2625 36.6061 16.0625 36.6839C15.8625 36.7616 15.6423 36.8005 15.4018 36.8005Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );
    const FactoryIcon = (
      <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
        <Circle cx={24} cy={24} r={23.5} fill="white" stroke={LOGISTICS_ORANGE} />
        <Path
          d="M32.675 29.075H17.7C16.95 29.075 16.3208 28.8208 15.8125 28.3125C15.3042 27.8042 15.05 27.175 15.05 26.425V16.775H14.325C13.9583 16.775 13.6458 16.6458 13.3875 16.3875C13.1292 16.1292 13 15.8167 13 15.45C13 15.0833 13.1292 14.7708 13.3875 14.5125C13.6458 14.2542 13.9583 14.125 14.325 14.125H15.05C15.8 14.125 16.4292 14.3792 16.9375 14.8875C17.4458 15.3958 17.7 16.025 17.7 16.775V26.425H32.675C33.0417 26.425 33.3542 26.5542 33.6125 26.8125C33.8708 27.0708 34 27.3833 34 27.75C34 28.1167 33.8708 28.4292 33.6125 28.6875C33.3542 28.9458 33.0417 29.075 32.675 29.075ZM17.375 34.725C16.7417 34.725 16.1958 34.4958 15.7375 34.0375C15.2792 33.5792 15.05 33.0333 15.05 32.4C15.05 31.7667 15.2792 31.2208 15.7375 30.7625C16.1958 30.3042 16.7417 30.075 17.375 30.075C18.025 30.075 18.575 30.3042 19.025 30.7625C19.475 31.2208 19.7 31.7667 19.7 32.4C19.7 33.0333 19.475 33.5792 19.025 34.0375C18.575 34.4958 18.025 34.725 17.375 34.725ZM20.025 25.425C19.6583 25.425 19.3458 25.2958 19.0875 25.0375C18.8292 24.7792 18.7 24.4667 18.7 24.1V20.1C18.7 19.7333 18.8292 19.4208 19.0875 19.1625C19.3458 18.9042 19.6583 18.775 20.025 18.775H24.025C24.3917 18.775 24.7042 18.9042 24.9625 19.1625C25.2208 19.4208 25.35 19.7333 25.35 20.1V24.1C25.35 24.4667 25.2208 24.7792 24.9625 25.0375C24.7042 25.2958 24.3917 25.425 24.025 25.425H20.025ZM27.675 25.425C27.3083 25.425 26.9958 25.2958 26.7375 25.0375C26.4792 24.7792 26.35 24.4667 26.35 24.1V20.1C26.35 19.7333 26.4792 19.4208 26.7375 19.1625C26.9958 18.9042 27.3083 18.775 27.675 18.775H31.675C32.0417 18.775 32.3542 18.9042 32.6125 19.1625C32.8708 19.4208 33 19.7333 33 20.1V24.1C33 24.4667 32.8708 24.7792 32.6125 25.0375C32.3542 25.2958 32.0417 25.425 31.675 25.425H27.675ZM31.675 34.725C31.0417 34.725 30.4958 34.4958 30.0375 34.0375C29.5792 33.5792 29.35 33.0333 29.35 32.4C29.35 31.7667 29.5792 31.2208 30.0375 30.7625C30.4958 30.3042 31.0417 30.075 31.675 30.075C32.325 30.075 32.875 30.3042 33.325 30.7625C33.775 31.2208 34 31.7667 34 32.4C34 33.0333 33.7708 33.5792 33.3125 34.0375C32.8542 34.4958 32.3083 34.725 31.675 34.725Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    // 카드별 내비게이션 대상 — 시장조사(UnitSurvey)는 설정 → 시장조사 →
    // 단가조사 항목과 같은 페지로 진입한다. OEM공장조사는 그 옆 메뉴 페지.
    const items: {
      title: string;
      d1: string;
      icon: React.ReactNode;
      route: 'UnitSurvey' | 'OEMSurvey';
    }[] = [
      { title: 'home.logisticsCard1Title', d1: 'home.logisticsCard1D1', icon: SurveyIcon, route: 'UnitSurvey' },
      { title: 'home.logisticsCard2Title', d1: 'home.logisticsCard2D1', icon: FactoryIcon, route: 'OEMSurvey' },
    ];
    return (
      <View style={[styles.guestWelcomeServiceCardsRow, { gap: cardGap }]}>
        {items.map((it) => (
          <TouchableOpacity
            key={it.title}
            style={[styles.logisticsServiceCard, { width: cardWidth }]}
            activeOpacity={0.88}
            onPress={() => (navigation as any).navigate(it.route)}
          >
            {it.icon}
            <View style={styles.logisticsServiceTextCol}>
              <Text style={styles.logisticsServiceTitle}>{t(it.title)}</Text>
              <Text style={styles.logisticsServiceDesc}>{t(it.d1)}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderGuestOrbGrid = () => {
    const keys = [
      'guestOrb1',
      'guestOrb2',
      'guestOrb3',
      'guestOrb4',
      'guestOrb5',
      'guestOrb6',
      'guestOrb7',
      'guestOrb8',
      'guestOrb9',
      'guestOrb10',
    ] as const;
    const PriceTagIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M21.1719 32.7781C20.8427 32.7781 20.5156 32.7156 20.1906 32.5906C19.8656 32.4656 19.5698 32.2698 19.3031 32.0031L11.9781 24.6781C11.7086 24.4105 11.512 24.115 11.3884 23.7916C11.2649 23.4683 11.2031 23.1394 11.2031 22.8049C11.2031 22.4704 11.2649 22.1395 11.3884 21.8121C11.512 21.4846 11.7086 21.19 11.9781 20.9281L20.9781 11.9781C21.2281 11.7281 21.5162 11.5365 21.8424 11.4031C22.1684 11.2698 22.5053 11.2031 22.8531 11.2031H30.1531C30.9031 11.2031 31.5323 11.4573 32.0406 11.9656C32.549 12.474 32.8031 13.1031 32.8031 13.8531V21.2031C32.8031 21.5603 32.7357 21.9007 32.6009 22.2244C32.4662 22.548 32.2753 22.8326 32.0281 23.0781L23.0531 32.0031C22.7865 32.2698 22.4885 32.4656 22.1594 32.5906C21.8302 32.7156 21.501 32.7781 21.1719 32.7781ZM21.1781 30.1281L30.1531 21.1531V13.8531H22.8531L13.8531 22.8031L21.1781 30.1281ZM27.3281 18.5031C27.8351 18.5031 28.266 18.3257 28.6209 17.9709C28.9757 17.616 29.1531 17.1851 29.1531 16.6781C29.1531 16.1711 28.9757 15.7402 28.6209 15.3854C28.266 15.0305 27.8351 14.8531 27.3281 14.8531C26.8211 14.8531 26.3902 15.0305 26.0354 15.3854C25.6805 15.7402 25.5031 16.1711 25.5031 16.6781C25.5031 17.1851 25.6805 17.616 26.0354 17.9709C26.3902 18.3257 26.8211 18.5031 27.3281 18.5031Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const ShoppingBagIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M28.6484 30.1531L28.7609 29.1781C28.8359 28.5281 28.9318 27.7448 29.0484 26.8281C29.0651 26.6781 29.0818 26.5365 29.0984 26.4031L29.1484 26.0031C29.1651 25.9365 29.2068 25.5865 29.2734 24.9531C29.3401 24.3198 29.4318 23.5615 29.5484 22.6781C29.6651 21.7448 29.7651 20.9573 29.8484 20.3156L30.1484 18.0031L28.6484 30.1531ZM15.5234 32.8031C14.8234 32.8031 14.2609 32.5365 13.8359 32.0031C13.4109 31.4698 13.1984 30.8531 13.1984 30.1531H28.6484L30.1484 18.0031H27.5734L27.4234 19.0781C27.3734 19.4615 27.2109 19.7781 26.9359 20.0281C26.6609 20.2781 26.3318 20.4031 25.9484 20.4031C25.5984 20.4031 25.3068 20.2698 25.0734 20.0031C24.8401 19.7365 24.7401 19.4281 24.7734 19.0781L24.9234 18.0031H21.5734L21.4234 19.0781C21.3734 19.4615 21.2109 19.7781 20.9359 20.0281C20.6609 20.2781 20.3318 20.4031 19.9484 20.4031C19.5984 20.4031 19.3068 20.2698 19.0734 20.0031C18.8401 19.7365 18.7401 19.4281 18.7734 19.0781L18.9234 18.0031H14.6984C14.7818 17.2531 15.1026 16.624 15.6609 16.1156C16.2193 15.6073 16.8818 15.3531 17.6484 15.3531H19.2234C19.3901 14.0031 19.9026 12.974 20.7609 12.2656C21.6193 11.5573 22.7234 11.2031 24.0734 11.2031C25.2234 11.2031 26.1776 11.6156 26.9359 12.4406C27.6943 13.2656 28.0068 14.2365 27.8734 15.3531H30.4484C31.1484 15.3531 31.7359 15.6198 32.2109 16.1531C32.6859 16.6865 32.8818 17.3031 32.7984 18.0031L31.2984 30.1531C31.2151 30.9031 30.8901 31.5323 30.3234 32.0406C29.7568 32.549 29.0901 32.8031 28.3234 32.8031H15.5234ZM21.8734 15.3531H25.2234C25.2734 14.9365 25.1484 14.5823 24.8484 14.2906C24.5484 13.999 24.1818 13.8531 23.7484 13.8531C23.2318 13.8531 22.8068 13.9781 22.4734 14.2281C22.1401 14.4781 21.9401 14.8531 21.8734 15.3531ZM15.3984 28.1531H11.8484C11.4818 28.1531 11.1693 28.024 10.9109 27.7656C10.6526 27.5073 10.5234 27.1948 10.5234 26.8281C10.5234 26.4615 10.6526 26.149 10.9109 25.8906C11.1693 25.6323 11.4818 25.5031 11.8484 25.5031H15.3984C15.7651 25.5031 16.0776 25.6323 16.3359 25.8906C16.5943 26.149 16.7234 26.4615 16.7234 26.8281C16.7234 27.1948 16.5943 27.5073 16.3359 27.7656C16.0776 28.024 15.7651 28.1531 15.3984 28.1531ZM18.3984 24.0031H13.8484C13.4818 24.0031 13.1693 23.874 12.9109 23.6156C12.6526 23.3573 12.5234 23.0448 12.5234 22.6781C12.5234 22.3115 12.6526 21.999 12.9109 21.7406C13.1693 21.4823 13.4818 21.3531 13.8484 21.3531H18.3984C18.7651 21.3531 19.0776 21.4823 19.3359 21.7406C19.5943 21.999 19.7234 22.3115 19.7234 22.6781C19.7234 23.0448 19.5943 23.3573 19.3359 23.6156C19.0776 23.874 18.7651 24.0031 18.3984 24.0031Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const StoreFlagIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M14.8758 13.25H29.1258C29.4925 13.25 29.805 13.3792 30.0633 13.6375C30.3216 13.8958 30.4508 14.2083 30.4508 14.575C30.4508 14.9417 30.3216 15.2542 30.0633 15.5125C29.805 15.7708 29.4925 15.9 29.1258 15.9H14.8758C14.5091 15.9 14.1966 15.7708 13.9383 15.5125C13.68 15.2542 13.5508 14.9417 13.5508 14.575C13.5508 14.2083 13.68 13.8958 13.9383 13.6375C14.1966 13.3792 14.5091 13.25 14.8758 13.25ZM14.8758 30.75C14.5091 30.75 14.1966 30.6208 13.9383 30.3625C13.68 30.1042 13.5508 29.7917 13.5508 29.425V24.65H13.5258C13.0925 24.65 12.7466 24.4875 12.4883 24.1625C12.23 23.8375 12.1425 23.4667 12.2258 23.05L13.3258 17.95C13.3925 17.65 13.5466 17.4 13.7883 17.2C14.03 17 14.3091 16.9 14.6258 16.9H29.3758C29.6925 16.9 29.9716 17 30.2133 17.2C30.455 17.4 30.6091 17.65 30.6758 17.95L31.7758 23.05C31.8591 23.4667 31.7716 23.8375 31.5133 24.1625C31.255 24.4875 30.9091 24.65 30.4758 24.65H30.4508V29.425C30.4508 29.7917 30.3216 30.1042 30.0633 30.3625C29.805 30.6208 29.4925 30.75 29.1258 30.75C28.7591 30.75 28.4466 30.6208 28.1883 30.3625C27.93 30.1042 27.8008 29.7917 27.8008 29.425V24.65H24.3508V29.425C24.3508 29.7917 24.2216 30.1042 23.9633 30.3625C23.705 30.6208 23.3925 30.75 23.0258 30.75H14.8758ZM16.2008 28.1H21.7008V24.65H16.2008V28.1ZM15.1508 22H28.8508L28.3258 19.55H15.6758L15.1508 22Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const PartyPopperIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M15.7031 31.8031C15.3365 31.8031 15.024 31.674 14.7656 31.4156C14.5073 31.1573 14.3781 30.8448 14.3781 30.4781C14.3781 30.1115 14.5073 29.799 14.7656 29.5406C15.024 29.2823 15.3365 29.1531 15.7031 29.1531H28.3281C28.6948 29.1531 29.0073 29.2823 29.2656 29.5406C29.524 29.799 29.6531 30.1115 29.6531 30.4781C29.6531 30.8448 29.524 31.1573 29.2656 31.4156C29.0073 31.674 28.6948 31.8031 28.3281 31.8031H15.7031ZM16.6781 27.6531C16.0315 27.6531 15.4573 27.4406 14.9556 27.0156C14.454 26.5906 14.1531 26.0531 14.0531 25.4031L13.0281 18.8531C12.5115 18.8531 12.0781 18.673 11.7281 18.3126C11.3781 17.9523 11.2031 17.5148 11.2031 17.0001C11.2031 16.4855 11.3833 16.049 11.7436 15.6906C12.104 15.3323 12.5415 15.1531 13.0561 15.1531C13.5708 15.1531 14.0073 15.333 14.3656 15.6926C14.724 16.0525 14.9031 16.4893 14.9031 17.0031C14.9031 17.1365 14.8856 17.2708 14.8506 17.4061C14.8156 17.5415 14.7748 17.6655 14.7281 17.7781L17.7031 19.1031L20.9781 14.5531C20.7435 14.3923 20.5515 14.1813 20.4021 13.9201C20.2528 13.6588 20.1781 13.3731 20.1781 13.0631C20.1781 12.5465 20.3565 12.1073 20.7134 11.7456C21.0702 11.384 21.5035 11.2031 22.0134 11.2031C22.5232 11.2031 22.9573 11.384 23.3156 11.7456C23.674 12.1073 23.8531 12.5465 23.8531 13.0631C23.8531 13.3731 23.7761 13.662 23.6221 13.9296C23.4681 14.1973 23.2701 14.4135 23.0281 14.5781L26.3281 19.1031L29.3031 17.7781C29.2565 17.6655 29.2156 17.5415 29.1806 17.4061C29.1456 17.2708 29.1281 17.1365 29.1281 17.0031C29.1281 16.4893 29.308 16.0525 29.6676 15.6926C30.0275 15.333 30.4643 15.1531 30.9781 15.1531C31.4851 15.1531 31.916 15.3333 32.2709 15.6936C32.6257 16.054 32.8031 16.4915 32.8031 17.0061C32.8031 17.5208 32.6281 17.9573 32.2781 18.3156C31.9281 18.674 31.5031 18.8531 31.0031 18.8531L29.9531 25.4281C29.8531 26.0781 29.5523 26.6115 29.0506 27.0281C28.549 27.4448 27.9748 27.6531 27.3281 27.6531H16.6781ZM16.6531 25.0031H27.3781L27.9531 21.2531L27.4031 21.5031C26.8198 21.7531 26.2281 21.799 25.6281 21.6406C25.0281 21.4823 24.5448 21.1448 24.1781 20.6281L22.0031 17.6281L19.8531 20.6281C19.4865 21.1448 18.999 21.4865 18.3906 21.6531C17.7823 21.8198 17.1865 21.7698 16.6031 21.5031L16.0781 21.2531L16.6531 25.0031Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const Storefront23Icon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M31.4984 21.2469V28.8469C31.4984 29.5757 31.2389 30.1995 30.7199 30.7184C30.2009 31.2374 29.5771 31.4969 28.8484 31.4969H15.1484C14.4196 31.4969 13.7958 31.2374 13.2769 30.7184C12.7579 30.1995 12.4984 29.5757 12.4984 28.8469V21.2469C12.0151 20.8469 11.6859 20.3385 11.5109 19.7219C11.3359 19.1052 11.3651 18.4469 11.5984 17.7469L12.7534 14.1999C12.9001 13.7479 13.1484 13.3594 13.4984 13.0344C13.8484 12.7094 14.2651 12.5469 14.7484 12.5469H29.2484C29.7388 12.5469 30.1655 12.701 30.5287 13.0094C30.8919 13.3177 31.1484 13.7135 31.2984 14.1969L32.3984 17.7469C32.6318 18.4469 32.6734 19.1219 32.5234 19.7719C32.3734 20.4219 32.0318 20.9135 31.4984 21.2469ZM24.2604 19.6969C24.6024 19.6969 24.8734 19.5927 25.0734 19.3844C25.2734 19.176 25.3484 18.8802 25.2984 18.4969L24.7484 15.1969H23.3484V18.6469C23.3484 18.9295 23.4371 19.1752 23.6144 19.3839C23.7918 19.5925 24.0071 19.6969 24.2604 19.6969ZM19.6609 19.6969C19.9526 19.6969 20.1984 19.5925 20.3984 19.3839C20.5984 19.1752 20.6984 18.9295 20.6984 18.6469V15.1969H19.2484L18.6984 18.4469C18.6151 18.9302 18.6818 19.2594 18.8984 19.4344C19.1151 19.6094 19.3693 19.6969 19.6609 19.6969ZM15.0984 19.6969C15.3318 19.6969 15.5359 19.601 15.7109 19.4094C15.8859 19.2177 15.9984 18.9969 16.0484 18.7469L16.5484 15.1969H15.1984L14.1984 18.3469C14.0818 18.6969 14.1151 19.0094 14.2984 19.2844C14.4818 19.5594 14.7484 19.6969 15.0984 19.6969ZM28.8984 19.6969C29.3318 19.6969 29.6151 19.5594 29.7484 19.2844C29.8818 19.0094 29.8984 18.6969 29.7984 18.3469L28.8484 15.1969H27.4484L27.9484 18.7469C27.9984 18.9969 28.1109 19.2177 28.2859 19.4094C28.4609 19.601 28.6651 19.6969 28.8984 19.6969ZM15.1484 28.8469H28.8484V22.3469C28.3918 22.3469 27.9901 22.2719 27.6434 22.1219C27.2968 21.9719 26.9484 21.7469 26.5984 21.4469C26.2651 21.7469 25.9109 21.9719 25.5359 22.1219C25.1609 22.2719 24.7818 22.3469 24.3984 22.3469C23.8984 22.3469 23.4443 22.2677 23.0359 22.1094C22.6276 21.951 22.2818 21.7302 21.9984 21.4469C21.7484 21.7302 21.4401 21.951 21.0734 22.1094C20.7068 22.2677 20.2831 22.3469 19.8024 22.3469C19.2664 22.3469 18.7984 22.2552 18.3984 22.0719C17.9984 21.8885 17.6484 21.6802 17.3484 21.4469C17.0651 21.7302 16.7651 21.951 16.4484 22.1094C16.1318 22.2677 15.6984 22.3469 15.1484 22.3469V28.8469ZM18.4984 28.1969H20.4984C20.6584 28.1969 20.7984 28.1369 20.9184 28.0169C21.0384 27.8969 21.0984 27.7569 21.0984 27.5969C21.0984 27.4369 21.0384 27.2969 20.9184 27.1769C20.7984 27.0569 20.6584 26.9969 20.4984 26.9969H19.0984V26.1469H20.4984C20.6584 26.1469 20.7984 26.0869 20.9184 25.9669C21.0384 25.8469 21.0984 25.7069 21.0984 25.5469V23.5469C21.0984 23.3869 21.0384 23.2469 20.9184 23.1269C20.7984 23.0069 20.6584 22.9469 20.4984 22.9469H18.4984C18.3384 22.9469 18.1984 23.0069 18.0784 23.1269C17.9584 23.2469 17.8984 23.3869 17.8984 23.5469C17.8984 23.7069 17.9584 23.8469 18.0784 23.9669C18.1984 24.0869 18.3384 24.1469 18.4984 24.1469H19.8984V24.9469H18.4984C18.3384 24.9469 18.1984 25.0069 18.0784 25.1269C17.9584 25.2469 17.8984 25.3869 17.8984 25.5469V27.5969C17.8984 27.7569 17.9584 27.8969 18.0784 28.0169C18.1984 28.1369 18.3384 28.1969 18.4984 28.1969ZM24.9484 26.1969V27.5969C24.9484 27.7569 25.0084 27.8969 25.1284 28.0169C25.2484 28.1369 25.3884 28.1969 25.5484 28.1969C25.7084 28.1969 25.8484 28.1369 25.9684 28.0169C26.0884 27.8969 26.1484 27.7569 26.1484 27.5969V23.5469C26.1484 23.3869 26.0884 23.2469 25.9684 23.1269C25.8484 23.0069 25.7084 22.9469 25.5484 22.9469C25.3884 22.9469 25.2484 23.0069 25.1284 23.1269C25.0084 23.2469 24.9484 23.3869 24.9484 23.5469V24.9969H24.0984V23.5469C24.0984 23.3869 24.0384 23.2469 23.9184 23.1269C23.7984 23.0069 23.6584 22.9469 23.4984 22.9469C23.3384 22.9469 23.1984 23.0069 23.0784 23.1269C22.9584 23.2469 22.8984 23.3869 22.8984 23.5469V25.5969C22.8984 25.7569 22.9584 25.8969 23.0784 26.0169C23.1984 26.1369 23.3384 26.1969 23.4984 26.1969H24.9484Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const HomeAppliancesIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M11.2031 32.8469V30.1969H13.2531V21.6469H13.0031C12.5031 21.6469 12.0781 21.4677 11.7281 21.1094C11.3781 20.751 11.2031 20.3219 11.2031 19.8219C11.2031 19.4552 11.286 19.1114 11.4519 18.7904C11.6177 18.4694 11.8515 18.1965 12.1531 17.9719L20.4781 12.1469C20.7115 11.9802 20.9565 11.8594 21.2134 11.7844C21.4704 11.7094 21.7329 11.6719 22.0009 11.6719C22.269 11.6719 22.5323 11.7094 22.7906 11.7844C23.049 11.8594 23.2948 11.9802 23.5281 12.1469L31.8531 17.9719C32.1548 18.1905 32.3885 18.464 32.5544 18.7921C32.7202 19.1203 32.8031 19.4719 32.8031 19.8469C32.8031 20.3469 32.6281 20.7719 32.2781 21.1219C31.9281 21.4719 31.5031 21.6469 31.0031 21.6469H30.7531V30.1969H32.8031V32.8469H11.2031ZM28.1031 30.1969V18.6469L22.0031 14.3469L15.9031 18.6469V30.1969H28.1031ZM22.0031 26.3469C22.2253 26.3469 22.4309 26.2969 22.6199 26.1969C22.8087 26.0969 22.9698 25.9469 23.1031 25.7469L23.8031 24.6969V27.1219C23.8031 27.4885 23.9323 27.801 24.1906 28.0594C24.449 28.3177 24.7615 28.4469 25.1281 28.4469C25.4948 28.4469 25.8073 28.3177 26.0656 28.0594C26.324 27.801 26.4531 27.4885 26.4531 27.1219V21.7469C26.4531 21.4635 26.349 21.2177 26.1406 21.0094C25.9323 20.801 25.6865 20.6969 25.4031 20.6969H24.4689C24.2972 20.6969 24.1308 20.7385 23.9696 20.8219C23.8086 20.9052 23.6781 21.0219 23.5781 21.1719L22.0031 23.5469L20.4781 21.2719C20.3615 21.0885 20.2094 20.9469 20.0219 20.8469C19.8344 20.7469 19.6365 20.6969 19.4281 20.6969H18.8344C18.4802 20.6969 18.1781 20.8219 17.9281 21.0719C17.6781 21.3219 17.5531 21.6219 17.5531 21.9719V27.1219C17.5531 27.4885 17.6823 27.801 17.9406 28.0594C18.199 28.3177 18.5115 28.4469 18.8781 28.4469C19.2448 28.4469 19.5573 28.3177 19.8156 28.0594C20.074 27.801 20.2031 27.4885 20.2031 27.1219V24.6969L20.9031 25.7469C21.0365 25.9469 21.1975 26.0969 21.3864 26.1969C21.5754 26.2969 21.781 26.3469 22.0031 26.3469Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const StorefrontIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M15.1484 31.4969C14.4196 31.4969 13.7958 31.2374 13.2769 30.7184C12.7579 30.1995 12.4984 29.5757 12.4984 28.8469V21.2469C12.0151 20.8469 11.6859 20.3385 11.5109 19.7219C11.3359 19.1052 11.3651 18.4469 11.5984 17.7469L12.7534 14.1999C12.9001 13.7479 13.1484 13.3594 13.4984 13.0344C13.8484 12.7094 14.2651 12.5469 14.7484 12.5469H29.2484C29.7388 12.5469 30.1655 12.701 30.5287 13.0094C30.8919 13.3177 31.1484 13.7135 31.2984 14.1969L32.3984 17.7469C32.6318 18.4469 32.6734 19.1219 32.5234 19.7719C32.3734 20.4219 32.0318 20.9135 31.4984 21.2469V28.8469C31.4984 29.5757 31.2389 30.1995 30.7199 30.7184C30.2009 31.2374 29.5771 31.4969 28.8484 31.4969H15.1484ZM24.2604 19.6969C24.6024 19.6969 24.8734 19.5927 25.0734 19.3844C25.2734 19.176 25.3484 18.8802 25.2984 18.4969L24.7484 15.1969H23.3484V18.6469C23.3484 18.9295 23.4371 19.1752 23.6144 19.3839C23.7918 19.5925 24.0071 19.6969 24.2604 19.6969ZM19.6609 19.6969C19.9526 19.6969 20.1984 19.5925 20.3984 19.3839C20.5984 19.1752 20.6984 18.9295 20.6984 18.6469V15.1969H19.2484L18.6984 18.4469C18.6151 18.9302 18.6818 19.2594 18.8984 19.4344C19.1151 19.6094 19.3693 19.6969 19.6609 19.6969ZM15.0984 19.6969C15.3318 19.6969 15.5359 19.601 15.7109 19.4094C15.8859 19.2177 15.9984 18.9969 16.0484 18.7469L16.5484 15.1969H15.1984L14.1984 18.3469C14.0818 18.6969 14.1151 19.0094 14.2984 19.2844C14.4818 19.5594 14.7484 19.6969 15.0984 19.6969ZM28.8984 19.6969C29.3318 19.6969 29.6151 19.5594 29.7484 19.2844C29.8818 19.0094 29.8984 18.6969 29.7984 18.3469L28.8484 15.1969H27.4484L27.9484 18.7469C27.9984 18.9969 28.1109 19.2177 28.2859 19.4094C28.4609 19.601 28.6651 19.6969 28.8984 19.6969ZM15.1484 28.8469H28.8484V22.3469C28.3918 22.3469 27.9901 22.2719 27.6434 22.1219C27.2968 21.9719 26.9484 21.7469 26.5984 21.4469C26.2651 21.7469 25.9109 21.9719 25.5359 22.1219C25.1609 22.2719 24.7818 22.3469 24.3984 22.3469C23.8984 22.3469 23.4443 22.2677 23.0359 22.1094C22.6276 21.951 22.2818 21.7302 21.9984 21.4469C21.7484 21.7302 21.4401 21.951 21.0734 22.1094C20.7068 22.2677 20.2831 22.3469 19.8024 22.3469C19.2664 22.3469 18.7984 22.2552 18.3984 22.0719C17.9984 21.8885 17.6484 21.6802 17.3484 21.4469C17.0651 21.7302 16.7651 21.951 16.4484 22.1094C16.1318 22.2677 15.6984 22.3469 15.1484 22.3469V28.8469Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const BookOpenIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M15.8766 32.9484C14.8766 32.9484 14.0182 32.5901 13.3016 31.8734C12.5849 31.1568 12.2266 30.2984 12.2266 29.2984V26.7734C12.2266 26.4068 12.3557 26.0943 12.6141 25.8359C12.8724 25.5776 13.1849 25.4484 13.5516 25.4484H15.2766V12.0484C15.2766 11.8984 15.3474 11.7984 15.4891 11.7484C15.6307 11.6984 15.7516 11.7234 15.8516 11.8234L16.4516 12.4234C16.5849 12.5568 16.7432 12.6234 16.9266 12.6234C17.1099 12.6234 17.2682 12.5568 17.4016 12.4234L18.1016 11.7234C18.2349 11.5901 18.3932 11.5234 18.5766 11.5234C18.7599 11.5234 18.9182 11.5901 19.0516 11.7234L19.7516 12.4234C19.8849 12.5568 20.0432 12.6234 20.2266 12.6234C20.4099 12.6234 20.5682 12.5568 20.7016 12.4234L21.4016 11.7234C21.5349 11.5901 21.6932 11.5234 21.8766 11.5234C22.0599 11.5234 22.2182 11.5901 22.3516 11.7234L23.0516 12.4234C23.1849 12.5568 23.3432 12.6234 23.5266 12.6234C23.7099 12.6234 23.8682 12.5568 24.0016 12.4234L24.7016 11.7234C24.8349 11.5901 24.9932 11.5234 25.1766 11.5234C25.3599 11.5234 25.5182 11.5901 25.6516 11.7234L26.3516 12.4234C26.4849 12.5568 26.6432 12.6234 26.8266 12.6234C27.0099 12.6234 27.1682 12.5568 27.3016 12.4234L28.0016 11.7234C28.1349 11.5901 28.2932 11.5234 28.4766 11.5234C28.6599 11.5234 28.8182 11.5901 28.9516 11.7234L29.6516 12.4234C29.7849 12.5568 29.9432 12.6234 30.1266 12.6234C30.3099 12.6234 30.4682 12.5568 30.6016 12.4234L31.2016 11.8234C31.3016 11.7234 31.4224 11.6984 31.5641 11.7484C31.7057 11.7984 31.7766 11.8984 31.7766 12.0484V29.2984C31.7766 30.2984 31.4182 31.1568 30.7016 31.8734C29.9849 32.5901 29.1266 32.9484 28.1266 32.9484H15.8766ZM28.1266 30.2984C28.4099 30.2984 28.6474 30.2026 28.8391 30.0109C29.0307 29.8193 29.1266 29.5818 29.1266 29.2984V14.9984H17.9266V25.4484H25.8016C26.1682 25.4484 26.4807 25.5776 26.7391 25.8359C26.9974 26.0943 27.1266 26.4068 27.1266 26.7734V29.2984C27.1266 29.5818 27.2224 29.8193 27.4141 30.0109C27.6057 30.2026 27.8432 30.2984 28.1266 30.2984ZM20.0516 16.7484H23.7016C24.0682 16.7484 24.3807 16.8776 24.6391 17.1359C24.8974 17.3943 25.0266 17.7068 25.0266 18.0734C25.0266 18.4401 24.8974 18.7526 24.6391 19.0109C24.3807 19.2693 24.0682 19.3984 23.7016 19.3984H20.0516C19.6849 19.3984 19.3724 19.2693 19.1141 19.0109C18.8557 18.7526 18.7266 18.4401 18.7266 18.0734C18.7266 17.7068 18.8557 17.3943 19.1141 17.1359C19.3724 16.8776 19.6849 16.7484 20.0516 16.7484ZM20.0516 20.1984H23.7016C24.0682 20.1984 24.3807 20.3276 24.6391 20.5859C24.8974 20.8443 25.0266 21.1568 25.0266 21.5234C25.0266 21.8901 24.8974 22.2026 24.6391 22.4609C24.3807 22.7193 24.0682 22.8484 23.7016 22.8484H20.0516C19.6849 22.8484 19.3724 22.7193 19.1141 22.4609C18.8557 22.2026 18.7266 21.8901 18.7266 21.5234C18.7266 21.1568 18.8557 20.8443 19.1141 20.5859C19.3724 20.3276 19.6849 20.1984 20.0516 20.1984ZM26.9516 19.3984C26.5849 19.3984 26.2724 19.2693 26.0141 19.0109C25.7557 18.7526 25.6266 18.4401 25.6266 18.0734C25.6266 17.7068 25.7557 17.3943 26.0141 17.1359C26.2724 16.8776 26.5849 16.7484 26.9516 16.7484C27.3182 16.7484 27.6307 16.8776 27.8891 17.1359C28.1474 17.3943 28.2766 17.7068 28.2766 18.0734C28.2766 18.4401 28.1474 18.7526 27.8891 19.0109C27.6307 19.2693 27.3182 19.3984 26.9516 19.3984ZM26.9516 22.8484C26.5849 22.8484 26.2724 22.7193 26.0141 22.4609C25.7557 22.2026 25.6266 21.8901 25.6266 21.5234C25.6266 21.1568 25.7557 20.8443 26.0141 20.5859C26.2724 20.3276 26.5849 20.1984 26.9516 20.1984C27.3182 20.1984 27.6307 20.3276 27.8891 20.5859C28.1474 20.8443 28.2766 21.1568 28.2766 21.5234C28.2766 21.8901 28.1474 22.2026 27.8891 22.4609C27.6307 22.7193 27.3182 22.8484 26.9516 22.8484ZM15.8766 30.2984H24.4766V28.0984H14.8766V29.2984C14.8766 29.5818 14.9724 29.8193 15.1641 30.0109C15.3557 30.2026 15.5932 30.2984 15.8766 30.2984Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const SoccerBallIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M22.0031 32.8031C20.5031 32.8031 19.099 32.5198 17.7906 31.9531C16.4823 31.3865 15.3406 30.6156 14.3656 29.6406C13.3906 28.6656 12.6198 27.524 12.0531 26.2156C11.4865 24.9073 11.2031 23.5031 11.2031 22.0031C11.2031 20.5031 11.4865 19.099 12.0531 17.7906C12.6198 16.4823 13.3906 15.3406 14.3656 14.3656C15.3406 13.3906 16.4823 12.6198 17.7906 12.0531C19.099 11.4865 20.5031 11.2031 22.0031 11.2031C23.5031 11.2031 24.9073 11.4865 26.2156 12.0531C27.524 12.6198 28.6656 13.3906 29.6406 14.3656C30.6156 15.3406 31.3865 16.4823 31.9531 17.7906C32.5198 19.099 32.8031 20.5031 32.8031 22.0031C32.8031 23.5031 32.5198 24.9073 31.9531 26.2156C31.3865 27.524 30.6156 28.6656 29.6406 29.6406C28.6656 30.6156 27.524 31.3865 26.2156 31.9531C24.9073 32.5198 23.5031 32.8031 22.0031 32.8031ZM27.3031 19.1031L28.4531 18.7031L28.8031 17.5531C28.2698 16.7698 27.6406 16.0948 26.9156 15.5281C26.1906 14.9615 25.4031 14.5365 24.5531 14.2531L23.3531 15.1031V16.3031L27.3031 19.1031ZM16.7031 19.1031L20.6531 16.3031V15.1031L19.4531 14.2531C18.6031 14.5365 17.8073 14.9615 17.0656 15.5281C16.324 16.0948 15.6865 16.7698 15.1531 17.5531L15.5031 18.7031L16.7031 19.1031ZM15.8031 27.2031L16.7031 27.1531L17.3031 25.9031L15.8531 21.6031L14.6531 21.1531L13.8531 21.8031C13.8531 22.8531 14.0073 23.8156 14.3156 24.6906C14.624 25.5656 15.1198 26.4031 15.8031 27.2031ZM22.0031 30.1531C22.4365 30.1531 22.8656 30.1281 23.2906 30.0781C23.7156 30.0281 24.1031 29.9365 24.4531 29.8031L25.0531 28.4531L24.5531 27.5531H19.4531L18.9031 28.4531L19.5531 29.8031C19.9365 29.9365 20.3323 30.0281 20.7406 30.0781C21.149 30.1281 21.5698 30.1531 22.0031 30.1531ZM19.8031 24.9031H24.1531L25.5531 21.1031L22.0031 18.6531L18.5531 21.1031L19.8031 24.9031ZM28.2031 27.2031C28.8865 26.4031 29.3823 25.5656 29.6906 24.6906C29.999 23.8156 30.1531 22.8531 30.1531 21.8031L29.3031 21.2031L28.1531 21.6031L26.7031 25.9031L27.3031 27.1531L28.2031 27.2031Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const GameControllerIcon = (
      <Svg width={52} height={52} viewBox="0 0 44 44" fill="none">
        <Circle cx={22} cy={22} r={21} fill={COLORS.white} />
        <Circle cx={22} cy={22} r={21.5} stroke={COLORS.black} strokeOpacity={0.05} />
        <Path
          d="M14.3469 29.75C13.3636 29.75 12.5677 29.3583 11.9594 28.575C11.3511 27.7917 11.1136 26.8833 11.2469 25.85L12.2969 18.3C12.4469 17.15 12.9624 16.1875 13.8434 15.4125C14.7244 14.6375 15.7589 14.25 16.9469 14.25H27.0469C28.2281 14.25 29.2567 14.6375 30.1329 15.4125C31.0089 16.1875 31.5302 17.15 31.6969 18.3L32.7469 25.85C32.8802 26.85 32.6469 27.75 32.0469 28.55C31.4469 29.35 30.6552 29.75 29.6719 29.75C29.2386 29.75 28.8219 29.6667 28.4219 29.5C28.0219 29.3333 27.6719 29.1 27.3719 28.8L25.2219 26.7H18.7969L16.6469 28.8C16.3469 29.1 15.9969 29.3333 15.5969 29.5C15.1969 29.6667 14.7802 29.75 14.3469 29.75ZM14.7469 26.95L17.6469 24.05H26.3719L29.2711 26.9493C29.305 26.9831 29.4219 27.0333 29.6219 27.1C29.8052 27.1 29.9511 27.0448 30.0594 26.9345C30.1677 26.8243 30.2052 26.6759 30.1719 26.4893L29.0719 18.65C28.9886 18.15 28.7611 17.7333 28.3894 17.4C28.0179 17.0667 27.5787 16.9 27.0719 16.9H16.9469C16.4469 16.9 16.0011 17.0667 15.6094 17.4C15.2177 17.7333 14.9969 18.15 14.9469 18.65L13.8469 26.4893C13.8136 26.6759 13.8511 26.8243 13.9594 26.9345C14.0677 27.0448 14.2136 27.1 14.3969 27.1C14.4636 27.1 14.5802 27.05 14.7469 26.95ZM27.1469 23.15C27.4869 23.15 27.7719 23.035 28.0019 22.805C28.2319 22.575 28.3469 22.29 28.3469 21.95C28.3469 21.61 28.2319 21.325 28.0019 21.095C27.7719 20.865 27.4869 20.75 27.1469 20.75C26.8069 20.75 26.5219 20.865 26.2919 21.095C26.0619 21.325 25.9469 21.61 25.9469 21.95C25.9469 22.29 26.0619 22.575 26.2919 22.805C26.5219 23.035 26.8069 23.15 27.1469 23.15ZM25.0469 20.1C25.3869 20.1 25.6719 19.985 25.9019 19.755C26.1319 19.525 26.2469 19.24 26.2469 18.9C26.2469 18.56 26.1319 18.275 25.9019 18.045C25.6719 17.815 25.3869 17.7 25.0469 17.7C24.7069 17.7 24.4219 17.815 24.1919 18.045C23.9619 18.275 23.8469 18.56 23.8469 18.9C23.8469 19.24 23.9619 19.525 24.1919 19.755C24.4219 19.985 24.7069 20.1 25.0469 20.1ZM17.4469 21.4V22.2C17.4469 22.4745 17.5366 22.7014 17.7161 22.8808C17.8955 23.0603 18.1224 23.15 18.3969 23.15C18.6714 23.15 18.8983 23.0603 19.0776 22.8808C19.2571 22.7014 19.3469 22.4745 19.3469 22.2V21.4H20.1469C20.4214 21.4 20.6483 21.3102 20.8276 21.1307C21.0071 20.9514 21.0969 20.7245 21.0969 20.45C21.0969 20.1755 21.0071 19.9486 20.8276 19.7693C20.6483 19.5898 20.4214 19.5 20.1469 19.5H19.3469V18.7C19.3469 18.4255 19.2571 18.1986 19.0776 18.0193C18.8983 17.8398 18.6714 17.75 18.3969 17.75C18.1224 17.75 17.8955 17.8398 17.7161 18.0193C17.5366 18.1986 17.4469 18.4255 17.4469 18.7V19.5H16.6469C16.3724 19.5 16.1455 19.5898 15.9661 19.7693C15.7866 19.9486 15.6969 20.1755 15.6969 20.45C15.6969 20.7245 15.7866 20.9514 15.9661 21.1307C16.1455 21.3102 16.3724 21.4 16.6469 21.4H17.4469Z"
          fill="#1C1B1F"
        />
      </Svg>
    );

    const icons: Array<string | React.ReactNode> = [
      PriceTagIcon,
      ShoppingBagIcon,
      StoreFlagIcon,
      PartyPopperIcon,
      Storefront23Icon,
      HomeAppliancesIcon,
      StorefrontIcon,
      BookOpenIcon,
      SoccerBallIcon,
      GameControllerIcon,
    ];
    // Guest category orb grid — strictly 5 orbs per row, arranged as
    // 5×2 for 10 items.
    //
    // Hard-won lessons from previous attempts:
    //   * Korean labels like "모르프 특가" don't wrap on a short cell
    //     (no space to break at), so their intrinsic min-width forces
    //     the cell wider than the computed `cellW`. The grid then
    //     fits only 4 cells per row instead of 5.
    //   * Fix: explicitly clamp `maxWidth` on the label to `cellW` so
    //     the text component cannot exceed the cell, combined with
    //     `numberOfLines={1}` + `adjustsFontSizeToFit` so the label
    //     shrinks instead of overflowing.
    //   * `width` is set on the cell explicitly (not flexBasis) so
    //     the row math is fully deterministic.
    //   * Container also gets an explicit `width: homeContentWidth`
    //     so children flex against a known-good box width (some
    //     parent flex contexts give the row "auto" width which
    //     causes weird wrapping).
    // Guest category orb grid — 5 cells per row × 2 rows.
    //
    // Layout strategy that finally gives equal left/right gutters:
    //   * `width: homeContentWidth` on the row — fixes the parent box.
    //   * `flexBasis: cellW` + `maxWidth: cellW` on each cell — caps the
    //     cell so unbreakable Korean labels can't push it wider.
    //   * `justifyContent: 'space-between'` — distributes the leftover
    //     pixels (from floor() rounding) into the inter-cell gaps so
    //     the FIRST cell hugs the left edge and the FIFTH cell hugs
    //     the right edge of the container. Outer margins are then
    //     guaranteed equal because they're produced by the parent's
    //     own `paddingHorizontal: homeGutter`, not by the grid itself.
    //   * `rowGap` is set explicitly so vertical spacing is independent
    //     of the horizontal distribution.
    //   * The text inside each cell uses `adjustsFontSizeToFit` so a
    //     long Korean label shrinks instead of stretching the cell —
    //     prevents the 5-up shape from collapsing back to 4-up.
    // Tablet landscape ONLY: lay out all 10 orbs in a single row.
    // Phone and tablet portrait keep the 5×2 layout (do not change).
    const orbsPerRow = responsive.isTabletLandscape ? 10 : 5;
    const minOrbGap = responsive.isTablet ? SPACING.md : SPACING.smmd;
    // Available width for the orb grid INSIDE its parent chain:
    //   responsive.width
    //   – outer guestAboveFold paddingHorizontal (`homeGutter` × 2)
    //   – guestWelcomePanel padding (`SPACING.md` × 2)
    // i.e. the grid must fit within the welcome panel's inner box, not
    // the full screen-content width. Previously we used
    // `homeContentWidth` which is wider than the panel's interior — the
    // grid then overflowed to the right, making the left margin look
    // larger than the right.
    const gridAvailableWidth =
      responsive.width - homeGutter * 2 - SPACING.md * 2;
    const cellW = Math.floor(
      (gridAvailableWidth - minOrbGap * (orbsPerRow - 1)) / orbsPerRow,
    );
    // Tablet landscape ONLY: use space-between with the cells exactly
    // sized so the gaps end up equal to the panel's side padding —
    // making "side gutter == inter-cell gap" visually true.
    //
    // For the 10-up landscape row we recompute cellW such that:
    //   panel.padding (= SPACING.md) on each side == gap between cells
    // Concretely:
    //   gridAvailableWidth = panel.inner = width − homeGutter*2 − SPACING.md*2
    //   cellW_land = floor((gridAvailableWidth − SPACING.md * 9) / 10)
    //   With `justifyContent: 'space-between'` the 10 cells fill the
    //   grid's full inner width; any rounding remainder is split into
    //   the 9 gaps. The left edge of the first cell still touches the
    //   panel's inner-left edge (= SPACING.md from the panel's outer
    //   left), so the visual outer gutters equal the inter-cell gaps.
    const cellWLandscape = responsive.isTabletLandscape
      ? Math.floor((gridAvailableWidth - SPACING.md * 9) / 10)
      : cellW;
    const finalCellW = responsive.isTabletLandscape ? cellWLandscape : cellW;
    return (
      <View style={styles.guestOrbSection}>
        <View
          style={[
            styles.guestOrbGrid,
            {
              marginLeft: 0,
              // Match the panel's interior width exactly so the grid's
              // first cell touches the panel's inner-left edge and the
              // last cell touches the inner-right edge. Equal left and
              // right gutters come entirely from the panel's symmetric
              // `padding: SPACING.md`.
              width: gridAvailableWidth,
              rowGap: SPACING.md,
              columnGap: 0,
              justifyContent: 'space-between',
              // Landscape only: prevent wrapping so all 10 orbs stay on
              // a single row even with sub-pixel rounding noise.
              ...(responsive.isTabletLandscape ? { flexWrap: 'nowrap' as const } : null),
            },
          ]}
        >
          {keys.map((k, i) => (
            <TouchableOpacity
              key={k}
              style={[
                styles.guestOrbCell,
                { width: finalCellW, maxWidth: finalCellW, flexBasis: finalCellW },
              ]}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('Category' as never)}
            >
              {typeof icons[i] === 'string' ? (
                <View style={styles.guestOrbCircle}>
                  <Icon name={icons[i] as string} size={22} color={COLORS.text.primary} />
                </View>
              ) : (
                <View style={styles.guestOrbCircle}>{icons[i]}</View>
              )}
              <Text
                style={[styles.guestOrbLabel, { maxWidth: finalCellW }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {t(`home.${k}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  };

  const openDial = useCallback((raw: string) => {
    const tel = `tel:${raw.replace(/[^0-9+]/g, '')}`;
    Linking.openURL(tel).catch(() => {});
  }, []);

  const openExternalUrl = useCallback(async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      showToast('Unable to open link', 'error');
    }
  }, [showToast]);

  const formatTrackingDate = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  };

  const formatPriceKRW = (n?: number) => {
    if (typeof n !== 'number' || !isFinite(n)) return '$00.00';
    return `₩${n.toLocaleString('ko-KR')}`;
  };

  const getOrderItemName = (item: OrderItem) => {
    return (
      (item.subjectMultiLang && (item.subjectMultiLang as any)[locale]) ||
      item.subjectTrans ||
      item.subject ||
      ''
    );
  };


  const getStatusText = (order: Order) => {
    const map: Record<string, { en: string; ko: string; zh: string }> = {
      p_quote: { en: 'Quote pending', ko: '견적대기', zh: '待报价' },
      delivered: { en: 'Delivered', ko: '배송 완료', zh: '已签收' },
      shipped: { en: 'Shipped', ko: '발송됨', zh: '已发货' },
      not_shipped: { en: 'Not shipped', ko: '미발송', zh: '未发货' },
      processing: { en: 'Processing', ko: '처리중', zh: '处理中' },
      pending: { en: 'Pending', ko: '대기중', zh: '待处理' },
      quote: { en: 'Quote pending', ko: '견적대기', zh: '待报价' },
      paid: { en: 'Paid', ko: '결제완료', zh: '已支付' },
      cancelled: { en: 'Cancelled', ko: '취소됨', zh: '已取消' },
    };
    const key = (
      order.progressStatus ||
      order.shippingStatus ||
      order.orderStatus ||
      ''
    ).toLowerCase();
    return map[key]?.[locale] || order.progressStatus || order.shippingStatus || order.orderStatus || '';
  };

  const handleCopyTracking = (tracking?: string) => {
    if (!tracking) return;
    Clipboard.setString(tracking);
    showToast(t('home.trackingCopied') || 'Tracking number copied', 'success');
  };

  const renderUserOrderSummaryCard = () => {
    if (!isAuthenticated || isGuest || !user) return null;

    const displayName = getHomeMemberDisplayName(user as any);
    const memberLabel =
      locale === 'ko' ? '회원'
      : locale === 'zh' ? '会员'
      : 'Member';

    const primaryAddress: any =
      (user.addresses || []).find((a: any) => a.isDefault) ||
      (user.addresses || [])[0] ||
      null;

    // (이전 첫/둘째 주문 분리 변수 제거 — 모든 주문을 동일 형식으로 표시)

    // 모든 주문 카드를 동일한 간단 형식으로 렌더 — 상세 (tracking / 상태 /
    // 주소 / 연락처) 는 표시하지 않는다. 이전엔 첫 카드만 상세를 보여줬으나
    // 사용자 요청으로 두번째 카드 형태(이미지+회사명+수량+가격+전체보기) 로 통일.
    const renderOrderBlock = (order: Order, idx: number) => {
      const item = order.items?.[0];
      const itemCount = order.items?.reduce((sum, it) => sum + (it.quantity || 1), 0) || 0;
      const total = order.totalAmount ?? order.firstTierCost?.totalKRW;
      const original = order.firstTierCost?.productTotalKRW;
      const itemsCountLabel =
        locale === 'ko' ? `총 : ${itemCount}건 상품`
        : locale === 'zh' ? `共：${itemCount}件商品`
        : `Total: ${itemCount} item(s)`;

      return (
        <View
          key={order.id}
          style={[styles.uosOrderBlock, idx > 0 && styles.uosOrderBlockSpacer]}
          onLayout={(e) => {
            if (idx === 0) {
              const h = e.nativeEvent.layout.height;
              if (h > 0 && Math.abs(h - uosOrderBlockHeight) > 0.5) {
                setUosOrderBlockHeight(h);
              }
            }
          }}
        >
          <TouchableOpacity
            style={styles.uosProductRow}
            activeOpacity={0.85}
            onPress={() =>
              (navigation as any).navigate('OrderDetail', { orderId: order.id, order })
            }
          >
            <Image
              source={{ uri: item?.imageUrl || 'https://via.placeholder.com/72' }}
              style={styles.uosProductImage}
            />
            <View style={styles.uosProductTextCol}>
              <Text style={styles.uosProductTitle} numberOfLines={2}>
                {order.orderNumber ? `${t('profile.orderNo')} ${order.orderNumber}` : getOrderItemName(item)}
              </Text>
              <View style={styles.uosProductMetaRow}>
                <Text style={styles.uosProductMetaLeft}>{itemsCountLabel}</Text>
                <View style={styles.uosProductPriceCol}>
                  <Text style={styles.uosProductPrice}>{formatPriceKRW(total)}</Text>
                  {original != null && original !== total && (
                    <Text style={styles.uosProductPriceStrike}>{formatPriceKRW(original)}</Text>
                  )}
                </View>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.uosViewAllRow}
            activeOpacity={0.7}
            onPress={() =>
              (navigation as any).navigate('OrderDetail', { orderId: order.id, order })
            }
          >
            <Text style={styles.uosViewAllText}>
              {t('home.viewAllOrderInfo')}
            </Text>
            <Icon name="chevron-forward" size={14} color={COLORS.text.secondary} />
          </TouchableOpacity>
        </View>
      );
    };

    return (
      <View style={[styles.uosOuter, { marginHorizontal: homeGutter }]}>
        {/* User header */}
        <View style={styles.uosUserHeader}>
          <MemberAvatar uri={user.avatar} displayName={displayName} style={styles.uosAvatar} />
          <View style={styles.uosUserNameCol}>
            <Text style={styles.uosUserName} numberOfLines={1}>{displayName}</Text>
            <Text style={styles.uosUserMember}>{memberLabel}</Text>
          </View>
          <TouchableOpacity
            style={styles.uosInquiryBtn}
            onPress={() =>
              // Send the "상담문의 / Inquiry" pill to the Message tab's first
              // tab (order inquiries). The icons elsewhere on this screen
              // route to the 'general' (1:1) tab, so this button intentionally
              // targets 'order' instead.
              (navigation as any).navigate('Main', {
                screen: 'Message',
                params: { initialTab: 'order' },
              })
            }
            activeOpacity={0.85}
          >
            <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
              <Path
                d="M3.89688 12.2682L2.29688 13.8682C2.0191 14.146 1.69965 14.2083 1.33854 14.0552C0.977431 13.9021 0.796875 13.6287 0.796875 13.2349V2.36823C0.796875 1.88245 0.969875 1.46656 1.31588 1.12056C1.66188 0.774563 2.07776 0.601562 2.56354 0.601562H13.4302C13.916 0.601562 14.3319 0.774563 14.6779 1.12056C15.0239 1.46656 15.1969 1.88245 15.1969 2.36823V10.5016C15.1969 10.9875 15.0239 11.4033 14.6779 11.7492C14.3319 12.0952 13.916 12.2682 13.4302 12.2682H3.89688ZM3.16354 10.5016H13.4302V2.36823H2.56354V11.1016L3.16354 10.5016ZM5.26354 7.20156C5.47465 7.20156 5.65521 7.12656 5.80521 6.97656C5.95521 6.82656 6.03021 6.64601 6.03021 6.4349C6.03021 6.22379 5.95521 6.04323 5.80521 5.89323C5.65521 5.74323 5.47465 5.66823 5.26354 5.66823C5.05243 5.66823 4.87188 5.74323 4.72188 5.89323C4.57188 6.04323 4.49688 6.22379 4.49688 6.4349C4.49688 6.64601 4.57188 6.82656 4.72188 6.97656C4.87188 7.12656 5.05243 7.20156 5.26354 7.20156ZM7.99688 7.20156C8.20799 7.20156 8.38854 7.12656 8.53854 6.97656C8.68854 6.82656 8.76354 6.64601 8.76354 6.4349C8.76354 6.22379 8.68854 6.04323 8.53854 5.89323C8.38854 5.74323 8.20799 5.66823 7.99688 5.66823C7.78576 5.66823 7.60521 5.74323 7.45521 5.89323C7.30521 6.04323 7.23021 6.22379 7.23021 6.4349C7.23021 6.64601 7.30521 6.82656 7.45521 6.97656C7.60521 7.12656 7.78576 7.20156 7.99688 7.20156ZM10.7302 7.20156C10.9413 7.20156 11.1219 7.12656 11.2719 6.97656C11.4219 6.82656 11.4969 6.64601 11.4969 6.4349C11.4969 6.22379 11.4219 6.04323 11.2719 5.89323C11.1219 5.74323 10.9413 5.66823 10.7302 5.66823C10.5191 5.66823 10.3385 5.74323 10.1885 5.89323C10.0385 6.04323 9.96354 6.22379 9.96354 6.4349C9.96354 6.64601 10.0385 6.82656 10.1885 6.97656C10.3385 7.12656 10.5191 7.20156 10.7302 7.20156Z"
                fill={COLORS.text.primary}
              />
            </Svg>
            <Text style={styles.uosInquiryText}>
              {locale === 'ko' ? '상담문의' : locale === 'zh' ? '咨询问题' : 'Inquiry'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Order blocks — 모든 주문을 표시. 2개 이상이면 영역 높이를 카드 2개
            높이로 고정하고 내부 스크롤로 나머지 주문을 노출. */}
        {recentOrders.length === 0 ? (
          <View style={styles.uosEmptyState}>
            <Text style={styles.uosEmptyText}>
              {locale === 'ko' ? '진행 중인 주문이 없습니다.'
                : locale === 'zh' ? '暂无进行中的订单。'
                : 'No orders yet.'}
            </Text>
          </View>
        ) : recentOrders.length === 1 ? (
          renderOrderBlock(recentOrders[0], 0)
        ) : (
          <View
            style={
              uosOrderBlockHeight > 0
                ? { height: uosOrderBlockHeight * 2 + SPACING.sm }
                : undefined
            }
          >
            <ScrollView
              showsVerticalScrollIndicator
              nestedScrollEnabled
              contentContainerStyle={{ paddingBottom: SPACING.xs }}
            >
              {recentOrders.map((o, i) => renderOrderBlock(o, i))}
            </ScrollView>
          </View>
        )}

        {/* Category shortcut grid replaced per request — the previous
            10-orb category list was removed and the two service cards
            (시장조사 / OEM공장조사) are shown here instead, matching
            the logged-out guest welcome panel above. */}
        {renderGuestWelcomeServiceCards()}
      </View>
    );
  };

  const renderGlobalLogisticsSection = () => {
    const CircleCheckIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M26.1349 29.8682L23.5016 27.2349C23.1682 26.9016 22.7571 26.7349 22.2682 26.7349C21.7793 26.7349 21.3682 26.9016 21.0349 27.2349C20.7016 27.5682 20.5349 27.9793 20.5349 28.4682C20.5349 28.9571 20.7016 29.3682 21.0349 29.7016L24.9016 33.5682C25.2531 33.9238 25.6632 34.1016 26.1319 34.1016C26.6006 34.1016 27.0127 33.9238 27.3682 33.5682L35.0349 25.9016C35.3682 25.5682 35.5349 25.1571 35.5349 24.6682C35.5349 24.1793 35.3682 23.7682 35.0349 23.4349C34.7016 23.1016 34.2905 22.9349 33.8016 22.9349C33.3127 22.9349 32.9016 23.1016 32.5682 23.4349L26.1349 29.8682ZM28.0016 42.4016C26.0096 42.4016 24.1376 42.0236 22.3856 41.2676C20.6336 40.5116 19.1096 39.4856 17.8136 38.1896C16.5176 36.8936 15.4916 35.3696 14.7356 33.6176C13.9796 31.8656 13.6016 29.9936 13.6016 28.0016C13.6016 26.0038 13.9802 24.1265 14.7376 22.3696C15.4949 20.6125 16.5227 19.0841 17.8209 17.7846C19.1191 16.4848 20.6431 15.4627 22.3929 14.7182C24.1427 13.9738 26.0122 13.6016 28.0016 13.6016C29.9991 13.6016 31.8762 13.9738 33.6329 14.7182C35.3898 15.4627 36.9182 16.4849 38.2182 17.7849C39.5182 19.0849 40.5405 20.6136 41.2849 22.3709C42.0293 24.1285 42.4016 26.0062 42.4016 28.0042C42.4016 30.0025 42.0293 31.8738 41.2849 33.6182C40.5405 35.3627 39.5183 36.884 38.2186 38.1822C36.919 39.4805 35.3907 40.5082 33.6336 41.2656C31.8767 42.0229 29.9993 42.4016 28.0016 42.4016Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const WalletPaymentsIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M15.5958 39.5365C14.5958 39.5365 13.7569 39.1976 13.0792 38.5198C12.4014 37.842 12.0625 37.0031 12.0625 36.0031V22.0365C12.0625 21.5476 12.2347 21.1309 12.5792 20.7865C12.9236 20.442 13.3403 20.2698 13.8292 20.2698C14.3181 20.2698 14.7347 20.442 15.0792 20.7865C15.4236 21.1309 15.5958 21.5476 15.5958 22.0365V36.0031H38.0292C38.5181 36.0031 38.9347 36.1753 39.2792 36.5198C39.6236 36.8642 39.7958 37.2809 39.7958 37.7698C39.7958 38.2587 39.6236 38.6754 39.2792 39.0198C38.9347 39.3642 38.5181 39.5365 38.0292 39.5365H15.5958ZM21.0625 34.1365C20.0625 34.1365 19.2236 33.7976 18.5458 33.1198C17.8681 32.442 17.5292 31.6031 17.5292 30.6031V19.7365C17.5292 18.7365 17.8681 17.8976 18.5458 17.2198C19.2236 16.542 20.0625 16.2031 21.0625 16.2031H40.3958C41.3958 16.2031 42.2347 16.542 42.9125 17.2198C43.5903 17.8976 43.9292 18.7365 43.9292 19.7365V30.6031C43.9292 31.6031 43.5903 32.442 42.9125 33.1198C42.2347 33.7976 41.3958 34.1365 40.3958 34.1365H21.0625ZM24.1292 30.6031C24.1292 29.7598 23.8289 29.0378 23.2285 28.4371C22.6278 27.8367 21.9058 27.5365 21.0625 27.5365V30.6031H24.1292ZM37.3292 30.6031H40.3958V27.5365C39.5514 27.5365 38.8292 27.8367 38.2292 28.4371C37.6292 29.0378 37.3292 29.7598 37.3292 30.6031ZM30.7195 29.1698C31.8371 29.1698 32.7792 28.7777 33.5458 27.9935C34.3125 27.2092 34.6958 26.2569 34.6958 25.1365C34.6958 24.0347 34.3102 23.0981 33.5388 22.3268C32.7675 21.5555 31.8309 21.1698 30.7292 21.1698C29.6087 21.1698 28.6564 21.5531 27.8722 22.3198C27.0879 23.0865 26.6958 24.0286 26.6958 25.1461C26.6958 26.2639 27.0871 27.2139 27.8695 27.9961C28.6517 28.7786 29.6017 29.1698 30.7195 29.1698ZM21.0625 22.8031C21.9058 22.8031 22.6278 22.5028 23.2285 21.9021C23.8289 21.3017 24.1292 20.5798 24.1292 19.7365H21.0625V22.8031ZM40.3958 22.8031V19.7365H37.3292C37.3292 20.5809 37.6295 21.3031 38.2302 21.9031C38.8306 22.5031 39.5525 22.8031 40.3958 22.8031Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const TeamHandshakeIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M12.8984 38.4339V34.4339C12.8984 33.5672 13.204 32.8339 13.8151 32.2339C14.4262 31.6339 15.154 31.3339 15.9984 31.3339H20.3651C20.6984 31.3339 21.0151 31.4116 21.3151 31.5672C21.6151 31.7227 21.8651 31.9561 22.0651 32.2672C22.754 33.245 23.6151 34.0005 24.6484 34.5339C25.6818 35.0672 26.7984 35.3339 27.9984 35.3339C29.1984 35.3339 30.3207 35.0672 31.3651 34.5339C32.4095 34.0005 33.2762 33.245 33.9651 32.2672C34.1651 31.9561 34.4151 31.7227 34.7151 31.5672C35.0151 31.4116 35.3207 31.3339 35.6318 31.3339H39.9984C40.8651 31.3339 41.5984 31.6339 42.1984 32.2339C42.7984 32.8339 43.0984 33.5672 43.0984 34.4339V38.4339C43.0984 38.9227 42.9262 39.3394 42.5818 39.6839C42.2373 40.0283 41.8207 40.2005 41.3318 40.2005H34.6651C34.1762 40.2005 33.7595 40.0283 33.4151 39.6839C33.0707 39.3394 32.8984 38.9227 32.8984 38.4339V37.6672C32.1429 38.045 31.354 38.3394 30.5318 38.5505C29.7095 38.7616 28.8651 38.8672 27.9984 38.8672C27.154 38.8672 26.3207 38.7616 25.4984 38.5505C24.6762 38.3394 23.8762 38.045 23.0984 37.6672V38.4339C23.0984 38.9227 22.9262 39.3394 22.5818 39.6839C22.2373 40.0283 21.8207 40.2005 21.3318 40.2005H14.6651C14.1762 40.2005 13.7595 40.0283 13.4151 39.6839C13.0707 39.3394 12.8984 38.9227 12.8984 38.4339ZM27.9984 33.3339C27.2651 33.3339 26.5707 33.1561 25.9151 32.8005C25.2595 32.445 24.7095 31.9783 24.2651 31.4005C23.8207 30.7561 23.2651 30.2561 22.5984 29.9005C21.9318 29.545 21.2207 29.3561 20.4651 29.3339C21.1762 28.6227 22.2818 28.0394 23.7818 27.5839C25.2818 27.1283 26.6873 26.9005 27.9984 26.9005C29.3318 26.9005 30.7484 27.1283 32.2484 27.5839C33.7484 28.0394 34.854 28.6227 35.5651 29.3339C34.7873 29.3561 34.0707 29.545 33.4151 29.9005C32.7595 30.2561 32.2095 30.7561 31.7651 31.4005C31.3429 32.0005 30.7984 32.4727 30.1318 32.8172C29.4651 33.1616 28.754 33.3339 27.9984 33.3339ZM17.3318 28.6672C16.1095 28.6672 15.0651 28.2339 14.1984 27.3672C13.3318 26.5005 12.8984 25.4561 12.8984 24.2339C12.8984 22.9894 13.3318 21.9394 14.1984 21.0839C15.0651 20.2283 16.1095 19.8005 17.3318 19.8005C18.5762 19.8005 19.6262 20.2283 20.4818 21.0839C21.3373 21.9394 21.7651 22.9894 21.7651 24.2339C21.7651 25.4561 21.3373 26.5005 20.4818 27.3672C19.6262 28.2339 18.5762 28.6672 17.3318 28.6672ZM38.6651 28.6672C37.4429 28.6672 36.3984 28.2339 35.5318 27.3672C34.6651 26.5005 34.2318 25.4561 34.2318 24.2339C34.2318 22.9894 34.6651 21.9394 35.5318 21.0839C36.3984 20.2283 37.4429 19.8005 38.6651 19.8005C39.9095 19.8005 40.9595 20.2283 41.8151 21.0839C42.6707 21.9394 43.0984 22.9894 43.0984 24.2339C43.0984 25.4561 42.6707 26.5005 41.8151 27.3672C40.9595 28.2339 39.9095 28.6672 38.6651 28.6672ZM27.9984 24.2339C26.7762 24.2339 25.7318 23.8005 24.8651 22.9339C23.9984 22.0672 23.5651 21.0227 23.5651 19.8005C23.5651 18.5561 23.9984 17.5061 24.8651 16.6505C25.7318 15.795 26.7762 15.3672 27.9984 15.3672C29.2429 15.3672 30.2929 15.795 31.1484 16.6505C32.004 17.5061 32.4318 18.5561 32.4318 19.8005C32.4318 21.0227 32.004 22.0672 31.1484 22.9339C30.2929 23.8005 29.2429 24.2339 27.9984 24.2339Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const WarehouseIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M18.2979 40.863C17.809 40.863 17.3924 40.6908 17.0479 40.3464C16.7035 40.0019 16.5312 39.5852 16.5312 39.0964V25.3964C16.5312 24.8408 16.659 24.313 16.9146 23.813C17.1701 23.313 17.5201 22.8964 17.9646 22.563L25.8979 16.6297C26.209 16.3852 26.5424 16.2075 26.8979 16.0964C27.2535 15.9852 27.6201 15.9297 27.9979 15.9297C28.3757 15.9297 28.7424 15.9852 29.0979 16.0964C29.4535 16.2075 29.7868 16.3852 30.0979 16.6297L38.0312 22.563C38.4757 22.8964 38.8257 23.313 39.0813 23.813C39.3368 24.313 39.4646 24.8408 39.4646 25.3964V39.0964C39.4646 39.5852 39.2924 40.0019 38.9479 40.3464C38.6035 40.6908 38.1868 40.863 37.6979 40.863H36.3646C35.8757 40.863 35.459 40.6908 35.1146 40.3464C34.7701 40.0019 34.5979 39.5852 34.5979 39.0964V28.4297C34.5979 27.9408 34.4257 27.5241 34.0813 27.1797C33.7368 26.8352 33.3201 26.663 32.8313 26.663H23.1646C22.6757 26.663 22.259 26.8352 21.9146 27.1797C21.5701 27.5241 21.3979 27.9408 21.3979 28.4297V39.0964C21.3979 39.5852 21.2257 40.0019 20.8813 40.3464C20.5368 40.6908 20.1201 40.863 19.6313 40.863H18.2979ZM25.3313 37.3297C24.9535 37.3297 24.6368 37.2019 24.3813 36.9464C24.1257 36.6908 23.9979 36.3741 23.9979 35.9964C23.9979 35.6186 24.1257 35.3019 24.3813 35.0464C24.6368 34.7908 24.9535 34.663 25.3313 34.663H30.6646C31.0424 34.663 31.359 34.7908 31.6146 35.0464C31.8701 35.3019 31.9979 35.6186 31.9979 35.9964C31.9979 36.3741 31.8701 36.6908 31.6146 36.9464C31.359 37.2019 31.0424 37.3297 30.6646 37.3297H25.3313ZM25.3313 31.9964C24.9535 31.9964 24.6368 31.8686 24.3813 31.613C24.1257 31.3575 23.9979 31.0408 23.9979 30.663C23.9979 30.2852 24.1257 29.9686 24.3813 29.713C24.6368 29.4575 24.9535 29.3297 25.3313 29.3297H30.6646C31.0424 29.3297 31.359 29.4575 31.6146 29.713C31.8701 29.9686 31.9979 30.2852 31.9979 30.663C31.9979 31.0408 31.8701 31.3575 31.6146 31.613C31.359 31.8686 31.0424 31.9964 30.6646 31.9964H25.3313Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const ClipboardCheckIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M26.1375 28.7036L23.5042 26.0703C23.1708 25.737 22.7597 25.5703 22.2708 25.5703C21.7819 25.5703 21.3708 25.737 21.0375 26.0703C20.7042 26.4036 20.5375 26.8148 20.5375 27.3036C20.5375 27.7925 20.7042 28.2036 21.0375 28.537L24.9042 32.4036C25.2597 32.7592 25.6708 32.937 26.1375 32.937C26.6042 32.937 27.0153 32.7592 27.3708 32.4036L35.0375 24.737C35.3708 24.4036 35.5375 23.9925 35.5375 23.5036C35.5375 23.0148 35.3708 22.6036 35.0375 22.2703C34.7042 21.937 34.2931 21.7703 33.8042 21.7703C33.3153 21.7703 32.9042 21.937 32.5708 22.2703L26.1375 28.7036ZM18.4708 40.8703C17.4708 40.8703 16.6319 40.5314 15.9542 39.8536C15.2764 39.1759 14.9375 38.337 14.9375 37.337V18.337C14.9375 17.337 15.2764 16.4981 15.9542 15.8203C16.6319 15.1425 17.4708 14.8036 18.4708 14.8036H23.2708C23.7819 13.9814 24.4542 13.3203 25.2875 12.8203C26.1208 12.3203 27.0264 12.0703 28.0042 12.0703C28.9819 12.0703 29.8875 12.3203 30.7208 12.8203C31.5542 13.3203 32.2264 13.9814 32.7375 14.8036H37.5375C38.5375 14.8036 39.3764 15.1425 40.0542 15.8203C40.7319 16.4981 41.0708 17.337 41.0708 18.337V37.337C41.0708 38.337 40.7319 39.1759 40.0542 39.8536C39.3764 40.5314 38.5375 40.8703 37.5375 40.8703H18.4708ZM28.0042 17.137C28.2931 17.137 28.5319 17.0425 28.7208 16.8536C28.9097 16.6648 29.0042 16.4259 29.0042 16.137C29.0042 15.8481 28.9097 15.6092 28.7208 15.4203C28.5319 15.2314 28.2931 15.137 28.0042 15.137C27.7153 15.137 27.4764 15.2314 27.2875 15.4203C27.0986 15.6092 27.0042 15.8481 27.0042 16.137C27.0042 16.4259 27.0986 16.6648 27.2875 16.8536C27.4764 17.0425 27.7153 17.137 28.0042 17.137Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const RoundtripFilesIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M18.9349 35.3682C18.4238 34.7238 17.9849 34.046 17.6182 33.3349C17.2516 32.6238 16.946 31.8682 16.7016 31.0682C16.5682 30.6238 16.646 30.2127 16.9349 29.8349C17.2238 29.4571 17.6098 29.2349 18.0929 29.1682C18.576 29.1016 19.0093 29.2071 19.3929 29.4849C19.7765 29.7627 20.0571 30.1349 20.2349 30.6016C20.3682 30.9793 20.5238 31.3349 20.7016 31.6682C20.8793 32.0016 21.0793 32.3238 21.3016 32.6349C21.5238 32.946 21.7571 33.246 22.0016 33.5349C22.246 33.8238 22.5238 34.0905 22.8349 34.3349C23.2127 34.646 23.4682 35.0349 23.6016 35.5016C23.7349 35.9682 23.6793 36.4238 23.4349 36.8682C23.1905 37.3127 22.8405 37.596 22.3849 37.7182C21.9293 37.8405 21.5127 37.7571 21.1349 37.4682C20.7349 37.1571 20.3462 36.8243 19.9689 36.4699C19.5918 36.1152 19.2471 35.748 18.9349 35.3682ZM28.9016 42.4016C28.1609 42.4016 27.5312 42.1423 27.0126 41.6239C26.4941 41.1052 26.2349 40.4756 26.2349 39.7349V31.7016C26.2349 30.97 26.4941 30.3482 27.0126 29.8362C27.5312 29.3242 28.1609 29.0682 28.9016 29.0682H32.5682C33.0149 29.0682 33.4392 29.169 33.8412 29.3706C34.2432 29.5723 34.5633 29.8605 34.8016 30.2349L35.4019 31.1682H39.7682C40.4998 31.1682 41.1216 31.4242 41.6336 31.9362C42.1456 32.4482 42.4016 33.07 42.4016 33.8016V39.7349C42.4016 40.4756 42.1456 41.1052 41.6336 41.6239C41.1216 42.1423 40.4998 42.4016 39.7682 42.4016H28.9016ZM16.2682 26.9349C15.5276 26.9349 14.8979 26.6757 14.3792 26.1572C13.8608 25.6386 13.6016 25.0089 13.6016 24.2682V16.2349C13.6016 15.5033 13.8608 14.8816 14.3792 14.3696C14.8979 13.8576 15.5276 13.6016 16.2682 13.6016H19.9349C20.3816 13.6016 20.8059 13.7023 21.2079 13.9039C21.6099 14.1057 21.93 14.3938 22.1682 14.7682L22.7686 15.7016H27.1349C27.8665 15.7016 28.4882 15.9576 29.0002 16.4696C29.5122 16.9816 29.7682 17.6033 29.7682 18.3349V24.2682C29.7682 25.0089 29.5122 25.6386 29.0002 26.1572C28.4882 26.6757 27.8665 26.9349 27.1349 26.9349H16.2682ZM34.9682 23.7849C34.7238 23.396 34.4563 23.0238 34.1659 22.6682C33.8757 22.3127 33.5542 21.9793 33.2016 21.6682C32.826 21.3498 32.5877 20.9591 32.4866 20.4962C32.3855 20.0331 32.4571 19.5905 32.7016 19.1682C32.946 18.746 33.296 18.4793 33.7516 18.3682C34.2071 18.2571 34.6238 18.346 35.0016 18.6349C35.4905 19.0127 35.9467 19.4127 36.3702 19.8349C36.7938 20.2571 37.182 20.7127 37.5349 21.2016C38.0682 21.9571 38.513 22.7691 38.8692 23.6376C39.2255 24.5062 39.4696 25.4053 39.6016 26.3349C39.6682 26.7793 39.5379 27.1682 39.2106 27.5016C38.8832 27.8349 38.4777 28.0016 37.9939 28.0016C37.5101 28.0016 37.0905 27.8405 36.7349 27.5182C36.3793 27.196 36.146 26.8016 36.0349 26.3349C35.9238 25.8905 35.7793 25.4516 35.6016 25.0182C35.4238 24.5849 35.2127 24.1738 34.9682 23.7849Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const CalendarCircleIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M31.0755 35.9974C30.0502 35.9974 29.1819 35.6434 28.4708 34.9354C27.7597 34.2274 27.4042 33.3607 27.4042 32.3354C27.4042 31.3101 27.7582 30.4418 28.4662 29.7307C29.1742 29.0196 30.0408 28.6641 31.0662 28.6641C32.0915 28.6641 32.9597 29.0181 33.6708 29.7261C34.3819 30.4341 34.7375 31.3007 34.7375 32.3261C34.7375 33.3514 34.3835 34.2196 33.6755 34.9307C32.9675 35.6418 32.1008 35.9974 31.0755 35.9974ZM18.4708 42.3307C17.4991 42.3307 16.6673 41.9847 15.9755 41.2927C15.2835 40.6007 14.9375 39.7689 14.9375 38.7974V19.7307C14.9375 18.7592 15.2835 17.9274 15.9755 17.2354C16.6673 16.5434 17.4991 16.1974 18.4708 16.1974H18.7375V15.4307C18.7375 14.9418 18.9097 14.5252 19.2542 14.1807C19.5986 13.8363 20.0153 13.6641 20.5042 13.6641C20.9931 13.6641 21.4097 13.8363 21.7542 14.1807C22.0986 14.5252 22.2708 14.9418 22.2708 15.4307V16.1974H33.7375V15.4307C33.7375 14.9418 33.9097 14.5252 34.2542 14.1807C34.5986 13.8363 35.0153 13.6641 35.5042 13.6641C35.9931 13.6641 36.4097 13.8363 36.7542 14.1807C37.0986 14.5252 37.2708 14.9418 37.2708 15.4307V16.1974H37.5375C38.5091 16.1974 39.3408 16.5434 40.0328 17.2354C40.7248 17.9274 41.0708 18.7592 41.0708 19.7307V38.7974C41.0708 39.7689 40.7248 40.6007 40.0328 41.2927C39.3408 41.9847 38.5091 42.3307 37.5375 42.3307H18.4708ZM18.4708 38.7974H37.5375V24.6641H18.4708V38.7974Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const BoxFanIcon = (
      <Svg width={48} height={48} viewBox="0 0 56 56" fill="none">
        <Circle cx={28} cy={28} r={28} fill={LOGISTICS_ORANGE} />
        <Path
          d="M28 42.4682C27.0889 42.4682 26.2 42.3682 25.3334 42.1682C24.4667 41.9682 23.6445 41.6682 22.8667 41.2682C21.7112 41.846 20.6612 42.1905 19.7167 42.3016C18.7723 42.4127 17.7334 42.4682 16.6 42.4682C16.1112 42.4682 15.7 42.296 15.3667 41.9516C15.0334 41.6071 14.8667 41.1905 14.8667 40.7016C14.8667 40.2127 15.0334 39.796 15.3667 39.4516C15.7 39.1071 16.1112 38.9349 16.6 38.9349C17.1334 38.9349 17.6445 38.9238 18.1334 38.9016C18.6223 38.8793 19.1056 38.8293 19.5834 38.7516C20.0612 38.6738 20.5389 38.546 21.0167 38.3682C21.4945 38.1905 21.9667 37.946 22.4334 37.6349C22.5667 37.546 22.7056 37.496 22.85 37.4849C22.9945 37.4738 23.1334 37.5127 23.2667 37.6016C23.9334 38.0238 24.6612 38.3405 25.45 38.5516C26.2389 38.7627 27.0889 38.8682 28 38.8682C28.9112 38.8682 29.7667 38.7627 30.5667 38.5516C31.3667 38.3405 32.0889 38.0238 32.7334 37.6016C32.8667 37.5127 33.0056 37.4682 33.15 37.4682C33.2945 37.4682 33.4223 37.5127 33.5334 37.6016C34.0223 37.9127 34.5 38.1571 34.9667 38.3349C35.4334 38.5127 35.9056 38.646 36.3834 38.7349C36.8612 38.8238 37.3445 38.8793 37.8334 38.9016C38.3223 38.9238 38.8334 38.9349 39.3667 38.9349C39.8556 38.9349 40.2723 39.1071 40.6167 39.4516C40.9612 39.796 41.1334 40.2127 41.1334 40.7016C41.1334 41.1905 40.9612 41.6071 40.6167 41.9516C40.2723 42.296 39.8556 42.4682 39.3667 42.4682C38.2556 42.4682 37.2223 42.4127 36.2667 42.3016C35.3112 42.1905 34.2667 41.846 33.1334 41.2682C32.3556 41.6682 31.5334 41.9682 30.6667 42.1682C29.8 42.3682 28.9112 42.4682 28 42.4682ZM20.7 19.8016V24.5682L27 22.7349C27.3112 22.6238 27.6445 22.5627 28 22.5516C28.3556 22.5405 28.6889 22.5905 29 22.7016L35.3 24.5349V19.8016H20.7ZM28 36.8682C27.0223 36.8682 26.0723 36.7016 25.15 36.3682C24.2278 36.0349 23.4778 35.5793 22.9 35.0016C22.3 35.5349 21.6056 35.9571 20.8167 36.2682C20.0278 36.5793 19.1445 36.7905 18.1667 36.9016C17.6112 36.946 17.1223 36.796 16.7 36.4516C16.2778 36.1071 16 35.6571 15.8667 35.1016L14.4 28.7349C14.2889 28.3349 14.3223 27.9516 14.5 27.5849C14.6778 27.2182 14.9556 26.946 15.3334 26.7682L17.1667 25.8349V19.8016C17.1667 18.8016 17.5056 17.9627 18.1834 17.2849C18.8612 16.6071 19.7 16.2682 20.7 16.2682H23.2334V15.3682C23.2334 14.8793 23.4056 14.4627 23.75 14.1182C24.0945 13.7738 24.5112 13.6016 25 13.6016H31C31.4889 13.6016 31.9056 13.7738 32.25 14.1182C32.5945 14.4627 32.7667 14.8793 32.7667 15.3682V16.2682H35.3C36.3 16.2682 37.1389 16.6071 37.8167 17.2849C38.4945 17.9627 38.8334 18.8016 38.8334 19.8016V25.8349L40.6667 26.7682C41.0445 26.946 41.3223 27.2182 41.5 27.5849C41.6778 27.9516 41.7112 28.3349 41.6 28.7349L40.1334 35.1016C40.0223 35.6349 39.75 36.0793 39.3167 36.4349C38.8834 36.7905 38.3889 36.946 37.8334 36.9016C36.8556 36.7905 35.9723 36.5793 35.1834 36.2682C34.3945 35.9571 33.7 35.5349 33.1 35.0016C32.5223 35.5793 31.7723 36.0349 30.85 36.3682C29.9278 36.7016 28.9778 36.8682 28 36.8682Z"
          fill={COLORS.white}
        />
      </Svg>
    );

    const steps: { icon: string | React.ReactNode; labelKey: string }[] = [
      { icon: CircleCheckIcon, labelKey: 'home.logisticsStep1' },
      { icon: WalletPaymentsIcon, labelKey: 'home.logisticsStep2' },
      { icon: TeamHandshakeIcon, labelKey: 'home.logisticsStep3' },
      { icon: WarehouseIcon, labelKey: 'home.logisticsStep4' },
      { icon: ClipboardCheckIcon, labelKey: 'home.logisticsStep5' },
      { icon: RoundtripFilesIcon, labelKey: 'home.logisticsStep6' },
      { icon: CalendarCircleIcon, labelKey: 'home.logisticsStep7' },
      { icon: BoxFanIcon, labelKey: 'home.logisticsStep8' },
    ];
    const row1 = steps.slice(0, 4);
    const row2 = [steps[7], steps[6], steps[5], steps[4]];

    // Tablet-only width tuning: stretch the 4-step workflow row so it
    // spans the full content width (instead of clustering in the middle
    // of a wide tablet screen). The row has 4 step columns + 3 arrow
    // characters; we give each step column ~22% of the inner width and
    // let `space-between` spread them out.
    const stepColWidth = responsive.isTablet
      ? Math.floor((homeContentWidth - SPACING.lg) / 4)
      : undefined; // fall back to the existing 76px on phones
    const stepCircleSize = responsive.isTablet
      ? Math.round(48 * responsive.scale)
      : 48;
    const stepIconSize = responsive.isTablet
      ? Math.round(22 * responsive.scale)
      : 22;
    const stepLabelFontSize = responsive.isTablet
      ? Math.round(10 * responsive.scale)
      : 10;

    const renderStep = (icon: string | React.ReactNode, label: string, key: string) => (
      <View
        key={key}
        style={[
          styles.logisticsStepCol,
          stepColWidth ? { width: stepColWidth } : null,
        ]}
      >
        {typeof icon === 'string' ? (
          <View
            style={[
              styles.logisticsStepCircle,
              { backgroundColor: LOGISTICS_ORANGE },
              responsive.isTablet
                ? { width: stepCircleSize, height: stepCircleSize, borderRadius: stepCircleSize / 2 }
                : null,
            ]}
          >
            <Icon name={icon} size={stepIconSize} color={COLORS.white} />
          </View>
        ) : (
          icon
        )}
        <Text
          style={[
            styles.logisticsStepLabel,
            responsive.isTablet ? { fontSize: stepLabelFontSize, lineHeight: stepLabelFontSize + 3 } : null,
          ]}
          numberOfLines={2}
        >
          {label}
        </Text>
      </View>
    );

    const renderRow = (rowSteps: typeof row1, arrow: 'forward' | 'back') => (
      <View
        style={[
          styles.logisticsRow,
          // On tablets, push the steps to the row edges so the workflow
          // fills the available width instead of huddling in the middle.
          responsive.isTablet ? { justifyContent: 'space-between' } : null,
        ]}
      >
        {rowSteps.map((s, idx) => (
          <React.Fragment key={s.labelKey}>
            {renderStep(s.icon, t(s.labelKey), s.labelKey)}
            {idx < rowSteps.length - 1 && (
              <Text
                style={[
                  styles.logisticsArrow,
                  responsive.isTablet
                    ? { fontSize: Math.round(FONTS.sizes.sm * responsive.scale) }
                    : null,
                ]}
              >
                {arrow === 'forward' ? '→' : '←'}
              </Text>
            )}
          </React.Fragment>
        ))}
      </View>
    );

    const ChartUpIcon = (
      <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
        <Circle cx={24} cy={24} r={23.5} fill="white" stroke={LOGISTICS_ORANGE} />
        <Path
          d="M18.3958 22.8005V17.9339C18.3958 17.2116 18.6486 16.5977 19.1542 16.0922C19.6597 15.5866 20.2736 15.3339 20.9958 15.3339C21.7181 15.3339 22.3319 15.5866 22.8375 16.0922C23.3431 16.5977 23.5958 17.2116 23.5958 17.9339V22.8005C23.5958 23.5227 23.3431 24.1366 22.8375 24.6422C22.3319 25.1477 21.7181 25.4005 20.9958 25.4005C20.2736 25.4005 19.6597 25.1477 19.1542 24.6422C18.6486 24.1366 18.3958 23.5227 18.3958 22.8005ZM25.7292 21.2672V12.4672C25.7292 11.745 25.9819 11.1311 26.4875 10.6255C26.9931 10.12 27.6069 9.86719 28.3292 9.86719C29.0514 9.86719 29.6653 10.12 30.1708 10.6255C30.6764 11.1311 30.9292 11.745 30.9292 12.4672V21.2672C30.9292 22.1339 30.6569 22.7839 30.1125 23.2172C29.5681 23.6505 28.9736 23.8672 28.3292 23.8672C27.6847 23.8672 27.0903 23.6505 26.5458 23.2172C26.0014 22.7839 25.7292 22.1339 25.7292 21.2672ZM11.0625 27.0005V23.4005C11.0625 22.6783 11.3153 22.0644 11.8208 21.5589C12.3264 21.0533 12.9403 20.8005 13.6625 20.8005C14.3847 20.8005 14.9986 21.0533 15.5042 21.5589C16.0097 22.0644 16.2625 22.6783 16.2625 23.4005V27.0005C16.2625 27.8672 15.9903 28.5172 15.4458 28.9505C14.9014 29.3839 14.3069 29.6005 13.6625 29.6005C13.0181 29.6005 12.4236 29.3839 11.8792 28.9505C11.3347 28.5172 11.0625 27.8672 11.0625 27.0005ZM15.4018 36.8005C14.6201 36.8005 14.0792 36.445 13.7792 35.7339C13.4792 35.0227 13.6069 34.3894 14.1625 33.8339L19.7625 28.2339C20.0958 27.9005 20.4908 27.7227 20.9475 27.7005C21.4039 27.6783 21.8089 27.8227 22.1625 28.1339L25.7292 31.2005L34.5958 22.3339H34.4292C33.9403 22.3339 33.5236 22.1616 33.1792 21.8172C32.8347 21.4727 32.6625 21.0561 32.6625 20.5672C32.6625 20.0783 32.8347 19.6616 33.1792 19.3172C33.5236 18.9727 33.9403 18.8005 34.4292 18.8005H38.8292C39.3181 18.8005 39.7347 18.9727 40.0792 19.3172C40.4236 19.6616 40.5958 20.0783 40.5958 20.5672V24.9672C40.5958 25.4561 40.4236 25.8727 40.0792 26.2172C39.7347 26.5616 39.3181 26.7339 38.8292 26.7339C38.3403 26.7339 37.9236 26.5616 37.5792 26.2172C37.2347 25.8727 37.0625 25.4561 37.0625 24.9672V24.8005L27.0958 34.7672C26.7625 35.1005 26.3675 35.2783 25.9108 35.3005C25.4544 35.3227 25.0494 35.1783 24.6958 34.8672L21.1292 31.8005L16.6292 36.3005C16.4514 36.4783 16.2625 36.6061 16.0625 36.6839C15.8625 36.7616 15.6423 36.8005 15.4018 36.8005Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    const CartGridIcon = (
      <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
        <Circle cx={24} cy={24} r={23.5} fill="white" stroke={LOGISTICS_ORANGE} />
        <Path
          d="M32.675 29.075H17.7C16.95 29.075 16.3208 28.8208 15.8125 28.3125C15.3042 27.8042 15.05 27.175 15.05 26.425V16.775H14.325C13.9583 16.775 13.6458 16.6458 13.3875 16.3875C13.1292 16.1292 13 15.8167 13 15.45C13 15.0833 13.1292 14.7708 13.3875 14.5125C13.6458 14.2542 13.9583 14.125 14.325 14.125H15.05C15.8 14.125 16.4292 14.3792 16.9375 14.8875C17.4458 15.3958 17.7 16.025 17.7 16.775V26.425H32.675C33.0417 26.425 33.3542 26.5542 33.6125 26.8125C33.8708 27.0708 34 27.3833 34 27.75C34 28.1167 33.8708 28.4292 33.6125 28.6875C33.3542 28.9458 33.0417 29.075 32.675 29.075ZM17.375 34.725C16.7417 34.725 16.1958 34.4958 15.7375 34.0375C15.2792 33.5792 15.05 33.0333 15.05 32.4C15.05 31.7667 15.2792 31.2208 15.7375 30.7625C16.1958 30.3042 16.7417 30.075 17.375 30.075C18.025 30.075 18.575 30.3042 19.025 30.7625C19.475 31.2208 19.7 31.7667 19.7 32.4C19.7 33.0333 19.475 33.5792 19.025 34.0375C18.575 34.4958 18.025 34.725 17.375 34.725ZM20.025 25.425C19.6583 25.425 19.3458 25.2958 19.0875 25.0375C18.8292 24.7792 18.7 24.4667 18.7 24.1V20.1C18.7 19.7333 18.8292 19.4208 19.0875 19.1625C19.3458 18.9042 19.6583 18.775 20.025 18.775H24.025C24.3917 18.775 24.7042 18.9042 24.9625 19.1625C25.2208 19.4208 25.35 19.7333 25.35 20.1V24.1C25.35 24.4667 25.2208 24.7792 24.9625 25.0375C24.7042 25.2958 24.3917 25.425 24.025 25.425H20.025ZM27.675 25.425C27.3083 25.425 26.9958 25.2958 26.7375 25.0375C26.4792 24.7792 26.35 24.4667 26.35 24.1V20.1C26.35 19.7333 26.4792 19.4208 26.7375 19.1625C26.9958 18.9042 27.3083 18.775 27.675 18.775H31.675C32.0417 18.775 32.3542 18.9042 32.6125 19.1625C32.8708 19.4208 33 19.7333 33 20.1V24.1C33 24.4667 32.8708 24.7792 32.6125 25.0375C32.3542 25.2958 32.0417 25.425 31.675 25.425H27.675ZM31.675 34.725C31.0417 34.725 30.4958 34.4958 30.0375 34.0375C29.5792 33.5792 29.35 33.0333 29.35 32.4C29.35 31.7667 29.5792 31.2208 30.0375 30.7625C30.4958 30.3042 31.0417 30.075 31.675 30.075C32.325 30.075 32.875 30.3042 33.325 30.7625C33.775 31.2208 34 31.7667 34 32.4C34 33.0333 33.7708 33.5792 33.3125 34.0375C32.8542 34.4958 32.3083 34.725 31.675 34.725Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    const DocumentEditIcon = (
      <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
        <Circle cx={24} cy={24} r={23.5} fill="white" stroke={LOGISTICS_ORANGE} />
        <Path
          d="M15.8042 38.4016C14.4486 38.4016 13.2986 37.9293 12.3542 36.9849C11.4097 36.0405 10.9375 34.8905 10.9375 33.5349V30.4349C10.9375 29.946 11.1097 29.5293 11.4542 29.1849C11.7986 28.8405 12.2153 28.6682 12.7042 28.6682H15.0708V13.1349C15.0708 12.1349 15.4097 11.296 16.0875 10.6182C16.7653 9.94045 17.6042 9.60156 18.6042 9.60156H33.5375C34.5375 9.60156 35.3764 9.94045 36.0542 10.6182C36.7319 11.296 37.0708 12.1349 37.0708 13.1349V20.6682C37.0708 21.1571 36.8986 21.5738 36.5542 21.9182C36.2097 22.2627 35.7931 22.4349 35.3042 22.4349C34.8153 22.4349 34.3986 22.2627 34.0542 21.9182C33.7097 21.5738 33.5375 21.1571 33.5375 20.6682V13.1349H18.6042V28.6682H23.9708C24.7486 28.6682 25.2819 29.0182 25.5708 29.7182C25.8597 30.4182 25.7375 31.046 25.2042 31.6016C24.8931 31.9349 24.6486 32.3182 24.4708 32.7516C24.2931 33.1849 24.2042 33.6349 24.2042 34.1016V36.6349C24.2042 37.1238 24.0319 37.5405 23.6875 37.8849C23.3431 38.2293 22.9264 38.4016 22.4375 38.4016H15.8042ZM26.8708 36.6349V34.4349C26.8708 34.1905 26.9153 33.9627 27.0042 33.7516C27.0931 33.5405 27.2264 33.346 27.4042 33.1682L34.3708 26.2349C34.6153 25.9905 34.8819 25.8127 35.1708 25.7016C35.4597 25.5905 35.7597 25.5349 36.0708 25.5349C36.3819 25.5349 36.6875 25.5905 36.9875 25.7016C37.2875 25.8127 37.5597 25.9905 37.8042 26.2349L39.0375 27.5016C39.2819 27.746 39.4597 28.0127 39.5708 28.3016C39.6819 28.5905 39.7375 28.8905 39.7375 29.2016C39.7375 29.5127 39.6819 29.8182 39.5708 30.1182C39.4597 30.4182 39.2819 30.6905 39.0375 30.9349L32.1042 37.8682C31.9264 38.046 31.7319 38.1793 31.5208 38.2682C31.3097 38.3571 31.0819 38.4016 30.8375 38.4016H28.6375C28.1486 38.4016 27.7319 38.2293 27.3875 37.8849C27.0431 37.5405 26.8708 37.1238 26.8708 36.6349ZM36.3708 30.2016L37.3042 29.2016L36.0708 27.9682L35.1042 28.9349L36.3708 30.2016ZM21.7042 20.6682H30.4375C30.9264 20.6682 31.3431 20.8405 31.6875 21.1849C32.0319 21.5293 32.2042 21.946 32.2042 22.4349C32.2042 22.9238 32.0319 23.3405 31.6875 23.6849C31.3431 24.0293 30.9264 24.2016 30.4375 24.2016H21.7042C21.2153 24.2016 20.7986 24.0293 20.4542 23.6849C20.1097 23.3405 19.9375 22.9238 19.9375 22.4349C19.9375 21.946 20.1097 21.5293 20.4542 21.1849C20.7986 20.8405 21.2153 20.6682 21.7042 20.6682ZM21.7042 15.8016H30.4375C30.9264 15.8016 31.3431 15.9738 31.6875 16.3182C32.0319 16.6627 32.2042 17.0793 32.2042 17.5682C32.2042 18.0571 32.0319 18.4738 31.6875 18.8182C31.3431 19.1627 30.9264 19.3349 30.4375 19.3349H21.7042C21.2153 19.3349 20.7986 19.1627 20.4542 18.8182C20.1097 18.4738 19.9375 18.0571 19.9375 17.5682C19.9375 17.0793 20.1097 16.6627 20.4542 16.3182C20.7986 15.9738 21.2153 15.8016 21.7042 15.8016Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    const BookmarkIcon = (
      <Svg width={48} height={48} viewBox="0 0 48 48" fill="none">
        <Circle cx={24} cy={24} r={23.5} fill="white" stroke={LOGISTICS_ORANGE} />
        <Path
          d="M17.7365 27.063V36.2297C17.7365 36.7186 17.5642 37.1352 17.2198 37.4797C16.8753 37.8241 16.4587 37.9964 15.9698 37.9964C15.4809 37.9964 15.0642 37.8241 14.7198 37.4797C14.3753 37.1352 14.2031 36.7186 14.2031 36.2297V11.6964C14.2031 11.2075 14.3753 10.7908 14.7198 10.4464C15.0642 10.1019 15.4809 9.92969 15.9698 9.92969C16.4587 9.92969 16.8753 10.1019 17.2198 10.4464C17.5642 10.7908 17.7365 11.2075 17.7365 11.6964V12.663H34.3365C34.9587 12.663 35.4476 12.9241 35.8031 13.4464C36.1587 13.9686 36.2142 14.5186 35.9698 15.0964L34.0698 19.863L35.9698 24.6297C36.2142 25.2075 36.1587 25.7575 35.8031 26.2797C35.4476 26.8019 34.9587 27.063 34.3365 27.063H17.7365ZM24.8085 22.9964C25.6716 22.9964 26.4087 22.689 27.0198 22.0744C27.6309 21.4597 27.9365 20.7208 27.9365 19.8577C27.9365 18.9946 27.6291 18.2575 27.0145 17.6464C26.3998 17.0352 25.6609 16.7297 24.7978 16.7297C23.9347 16.7297 23.1976 17.037 22.5865 17.6517C21.9753 18.2664 21.6698 19.0052 21.6698 19.8684C21.6698 20.7315 21.9771 21.4686 22.5918 22.0797C23.2065 22.6908 23.9453 22.9964 24.8085 22.9964Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    // Removed per request: card3 (생산대행) and card4 (원스탑가이드).
    // Their icons (`DocumentEditIcon`, `BookmarkIcon`) remain defined
    // above but unused; keeping them in place so the cards can be
    // re-enabled by uncommenting these lines if needed later.
    const cards: Array<{ title: string; d1: string; icon: string | React.ReactNode }> = [
      { title: 'home.logisticsCard1Title', d1: 'home.logisticsCard1D1', icon: ChartUpIcon },
      { title: 'home.logisticsCard2Title', d1: 'home.logisticsCard2D1', icon: CartGridIcon },
      // { title: 'home.logisticsCard3Title', d1: 'home.logisticsCard3D1', icon: DocumentEditIcon },
      // { title: 'home.logisticsCard4Title', d1: 'home.logisticsCard4D1', icon: BookmarkIcon },
    ];
    // Silence unused-binding hints for icons we intentionally kept.
    void DocumentEditIcon;
    void BookmarkIcon;

    return (
      <View style={[styles.logisticsSection, { paddingHorizontal: homeGutter }]}>
        <Text style={[styles.logisticsSectionTitleOrange, { color: LOGISTICS_ORANGE }]}>
          {t('home.logisticsTitleOrange')}
        </Text>
        <Text style={styles.logisticsSectionTitleBlack}>{t('home.logisticsTitleBlack')}</Text>
        {renderRow(row1, 'forward')}
        <View style={{ height: SPACING.md }} />
        {renderRow(row2, 'back')}
        {/* 2-card row (시장조사 / OEM공장조사) moved to the red guest
            welcome panel above. The `cards` array, icons and the
            `logisticsServiceCard`/`logisticsServiceIconRing` styles
            are kept defined so the cards can be re-enabled here by
            uncommenting the previous JSX block. */}
        {void cards}
      </View>
    );
  };

  const renderIntegratedServicesSection = () => {
    const go = () => navigation.navigate('CustomerService' as never);

    type CornerKey = 'tl' | 'tr' | 'bl' | 'br';
    // Smaller translate = closer to each outer corner (farther from center)
    const CORNER_TRANSLATE_OUTWARD_FACTOR = 0.7;
    const CORNER_TRANSLATE: Record<CornerKey, { x: number; y: number }> = {
      tl: { x: 35.2 * CORNER_TRANSLATE_OUTWARD_FACTOR, y: 31.2 * CORNER_TRANSLATE_OUTWARD_FACTOR },
      tr: { x: -35.2 * CORNER_TRANSLATE_OUTWARD_FACTOR, y: 31.2 * CORNER_TRANSLATE_OUTWARD_FACTOR },
      bl: { x: 35.2 * CORNER_TRANSLATE_OUTWARD_FACTOR, y: -31.2 * CORNER_TRANSLATE_OUTWARD_FACTOR },
      br: { x: -35.2 * CORNER_TRANSLATE_OUTWARD_FACTOR, y: -31.2 * CORNER_TRANSLATE_OUTWARD_FACTOR },
    };

    const cell = (labelKey: string, icon: string | React.ReactNode, large?: boolean, corner?: CornerKey) => (
      <TouchableOpacity
        style={[styles.integratedCell, large && styles.integratedCellLarge]}
        onPress={go}
        activeOpacity={0.88}
      >
        <View style={[styles.integratedCellInner, large && styles.integratedCellInnerLarge]}>
          {!large && corner && (
            <View
              style={[
                styles.integratedCornerInsetGroup,
                { transform: [{ translateX: CORNER_TRANSLATE[corner].x }, { translateY: CORNER_TRANSLATE[corner].y }] },
              ]}
              pointerEvents="none"
            >
              <View style={styles.integratedCornerOverlay} />
              <View style={styles.integratedCornerInsetContent}>
                {typeof icon === 'string'
                  ? <Icon name={icon} size={24} color={LOGISTICS_ORANGE} />
                  : icon}
                <Text style={styles.integratedCellLabel} numberOfLines={3}>
                  {t(labelKey)}
                </Text>
              </View>
            </View>
          )}
          {(large || !corner) && (typeof icon === 'string'
            ? <Icon name={icon} size={large ? 28 : 24} color={LOGISTICS_ORANGE} />
            : icon)}
          {(large || !corner) && (
            <Text style={[styles.integratedCellLabel, large && styles.integratedCellLabelLarge]} numberOfLines={3}>
              {t(labelKey)}
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );

    const ParcelTrackingIcon = (
      <Svg width={32} height={32} viewBox="0 0 48 48" fill="none">
        <Path
          d="M6.50014 36.7031V13.3031L3.30014 6.50312C3.00014 5.83646 2.97514 5.16146 3.22514 4.47812C3.47514 3.79479 3.93348 3.30313 4.60014 3.00313C5.26681 2.70312 5.94181 2.66979 6.62514 2.90313C7.30848 3.13646 7.80014 3.58646 8.10014 4.25313L12.3001 13.2031H35.7001L39.9001 4.25313C40.2001 3.58646 40.6918 3.13646 41.3751 2.90313C42.0585 2.66979 42.7335 2.70312 43.4001 3.00313C44.0668 3.30313 44.5168 3.79479 44.7501 4.47812C44.9835 5.16146 44.9501 5.83646 44.6501 6.50312L41.5001 13.3031V36.7031C41.5001 38.2031 40.9918 39.4615 39.9751 40.4781C38.9585 41.4948 37.7001 42.0031 36.2001 42.0031H11.8001C10.3001 42.0031 9.04181 41.4948 8.02514 40.4781C7.00848 39.4615 6.50014 38.2031 6.50014 36.7031ZM19.9001 27.1031H28.1001C28.8335 27.1031 29.4501 26.8531 29.9501 26.3531C30.4501 25.8531 30.7001 25.2365 30.7001 24.5031C30.7001 23.7698 30.4501 23.1365 29.9501 22.6031C29.4501 22.0698 28.8335 21.8031 28.1001 21.8031H19.9001C19.1668 21.8031 18.5501 22.0698 18.0501 22.6031C17.5501 23.1365 17.3001 23.7698 17.3001 24.5031C17.3001 25.2365 17.5501 25.8531 18.0501 26.3531C18.5501 26.8531 19.1668 27.1031 19.9001 27.1031Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    const CustomsCodeIcon = (
      <Svg width={32} height={32} viewBox="0 0 48 48" fill="none">
        <Path
          d="M10.6516 41.3031V43.1531C10.6516 43.8865 10.3932 44.5115 9.87656 45.0281C9.3599 45.5448 8.7349 45.8031 8.00156 45.8031H6.00156C5.26823 45.8031 4.64323 45.5448 4.12656 45.0281C3.6099 44.5115 3.35156 43.8865 3.35156 43.1531V38.6531C3.35156 37.9198 3.6099 37.2948 4.12656 36.7781C4.64323 36.2615 5.26823 36.0031 6.00156 36.0031H42.0016C42.7349 36.0031 43.3599 36.2615 43.8766 36.7781C44.3932 37.2948 44.6516 37.9198 44.6516 38.6531V43.1531C44.6516 43.8865 44.3932 44.5115 43.8766 45.0281C43.3599 45.5448 42.7349 45.8031 42.0016 45.8031H40.0016C39.2682 45.8031 38.6432 45.5448 38.1266 45.0281C37.6099 44.5115 37.3516 43.8865 37.3516 43.1531V41.3031H27.6516V43.1531C27.6516 43.8865 27.3932 44.5115 26.8766 45.0281C26.3599 45.5448 25.7349 45.8031 25.0016 45.8031H23.0016C22.2682 45.8031 21.6432 45.5448 21.1266 45.0281C20.6099 44.5115 20.3516 43.8865 20.3516 43.1531V41.3031H10.6516ZM12.0016 32.0031C11.2682 32.0031 10.6432 31.7448 10.1266 31.2281C9.6099 30.7115 9.35156 30.0865 9.35156 29.3531V5.35313C9.35156 4.61979 9.6099 3.99479 10.1266 3.47813C10.6432 2.96146 11.2682 2.70312 12.0016 2.70312H36.0016C36.7349 2.70312 37.3599 2.96146 37.8766 3.47813C38.3932 3.99479 38.6516 4.61979 38.6516 5.35313V29.3531C38.6516 30.0865 38.3932 30.7115 37.8766 31.2281C37.3599 31.7448 36.7349 32.0031 36.0016 32.0031H12.0016ZM28.0016 16.0031C28.7349 16.0031 29.3599 15.7448 29.8766 15.2281C30.3932 14.7115 30.6516 14.0865 30.6516 13.3531C30.6516 12.6198 30.3932 11.9948 29.8766 11.4781C29.3599 10.9615 28.7349 10.7031 28.0016 10.7031H20.0016C19.2682 10.7031 18.6432 10.9615 18.1266 11.4781C17.6099 11.9948 17.3516 12.6198 17.3516 13.3531C17.3516 14.0865 17.6099 14.7115 18.1266 15.2281C18.6432 15.7448 19.2682 16.0031 20.0016 16.0031H28.0016Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    const TerminalIcon = (
      <Svg width={32} height={32} viewBox="0 0 48 48" fill="none">
        <Path
          d="M8.00313 41.1969C6.53646 41.1969 5.28646 40.6802 4.25312 39.6469C3.21979 38.6135 2.70312 37.3635 2.70312 35.8969V12.0969C2.70312 10.6302 3.21979 9.38021 4.25312 8.34688C5.28646 7.31354 6.53646 6.79688 8.00313 6.79688H40.0031C41.4698 6.79688 42.7198 7.31354 43.7531 8.34688C44.7865 9.38021 45.3031 10.6302 45.3031 12.0969V35.8969C45.3031 37.3635 44.7865 38.6135 43.7531 39.6469C42.7198 40.6802 41.4698 41.1969 40.0031 41.1969H8.00313ZM8.00313 35.8969H40.0031V16.0969H8.00313V35.8969ZM16.4531 25.9969L13.1031 22.6469C12.5698 22.1135 12.3115 21.4969 12.3281 20.7969C12.3448 20.0969 12.6198 19.4802 13.1531 18.9469C13.6865 18.4469 14.3115 18.1969 15.0281 18.1969C15.7448 18.1969 16.3531 18.4469 16.8531 18.9469L22.0531 24.1469C22.5865 24.6802 22.8531 25.2969 22.8531 25.9969C22.8531 26.6969 22.5865 27.3135 22.0531 27.8469L16.8531 33.0469C16.3531 33.5469 15.7448 33.8052 15.0281 33.8219C14.3115 33.8385 13.6865 33.5802 13.1531 33.0469C12.6531 32.5469 12.4031 31.9302 12.4031 31.1969C12.4031 30.4635 12.6531 29.8469 13.1531 29.3469L16.4531 25.9969ZM26.0031 34.6469C25.2698 34.6469 24.6448 34.3885 24.1281 33.8719C23.6115 33.3552 23.3531 32.7302 23.3531 31.9969C23.3531 31.2635 23.6115 30.6385 24.1281 30.1219C24.6448 29.6052 25.2698 29.3469 26.0031 29.3469H34.0031C34.7365 29.3469 35.3615 29.6052 35.8781 30.1219C36.3948 30.6385 36.6531 31.2635 36.6531 31.9969C36.6531 32.7302 36.3948 33.3552 35.8781 33.8719C35.3615 34.3885 34.7365 34.6469 34.0031 34.6469H26.0031Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    const SupportAgentIcon = (
      <Svg width={32} height={32} viewBox="0 0 48 48" fill="none">
        <Path
          d="M41.0031 34.5031C40.1698 34.5031 39.4615 34.2115 38.8781 33.6281C38.2948 33.0448 38.0031 32.3365 38.0031 31.5031V26.5031C38.0031 25.6698 38.2948 24.9615 38.8781 24.3781C39.4615 23.7948 40.1698 23.5031 41.0031 23.5031C41.8365 23.5031 42.5448 23.7948 43.1281 24.3781C43.7115 24.9615 44.0031 25.6698 44.0031 26.5031V31.5031C44.0031 32.3365 43.7115 33.0448 43.1281 33.6281C42.5448 34.2115 41.8365 34.5031 41.0031 34.5031ZM25.9031 23.4031C23.4031 23.4031 21.2615 22.5115 19.4781 20.7281C17.6948 18.9448 16.8031 16.8031 16.8031 14.3031C16.8031 11.8031 17.6948 9.66146 19.4781 7.87812C21.2615 6.09479 23.4031 5.20312 25.9031 5.20312C28.4031 5.20312 30.5448 6.09479 32.3281 7.87812C34.1115 9.66146 35.0031 11.8031 35.0031 14.3031C35.0031 16.8031 34.1115 18.9448 32.3281 20.7281C30.5448 22.5115 28.4031 23.4031 25.9031 23.4031ZM13.7031 43.0531C12.2031 43.0531 10.9448 42.5448 9.92813 41.5281C8.91146 40.5115 8.40312 39.2531 8.40312 37.7531V35.9531C8.40312 34.6198 8.71979 33.3948 9.35313 32.2781C9.98646 31.1615 10.8698 30.3031 12.0031 29.7031C13.8031 28.7365 15.9031 27.9281 18.3031 27.2781C20.7031 26.6281 23.2365 26.3031 25.9031 26.3031H26.6281C26.8781 26.3031 27.1365 26.3198 27.4031 26.3531C28.0698 26.3865 28.5865 26.7031 28.9531 27.3031C29.3198 27.9031 29.3865 28.5365 29.1531 29.2031C28.8198 30.3365 28.6448 31.4781 28.6281 32.6281C28.6115 33.7781 28.7531 34.8865 29.0531 35.9531C29.2198 36.5531 29.4281 37.1448 29.6781 37.7281C29.9281 38.3115 30.2365 38.8698 30.6031 39.4031C31.1365 40.2031 31.2365 41.0115 30.9031 41.8281C30.5698 42.6448 30.0031 43.0531 29.2031 43.0531H13.7031ZM41.0031 42.7531C40.6365 42.7531 40.3281 42.6281 40.0781 42.3781C39.8281 42.1281 39.7031 41.8198 39.7031 41.4531V39.7031C37.9365 39.4365 36.4281 38.6781 35.1781 37.4281C33.9281 36.1781 33.1531 34.6698 32.8531 32.9031C32.7865 32.5365 32.8781 32.2115 33.1281 31.9281C33.3781 31.6448 33.6865 31.5031 34.0531 31.5031C34.3865 31.5031 34.6865 31.6031 34.9531 31.8031C35.2198 32.0031 35.3865 32.2698 35.4531 32.6031C35.7198 33.9365 36.3698 35.0281 37.4031 35.8781C38.4365 36.7281 39.6365 37.1531 41.0031 37.1531C42.3365 37.1531 43.5281 36.7365 44.5781 35.9031C45.6281 35.0698 46.2865 34.0031 46.5531 32.7031C46.6198 32.3365 46.7865 32.0448 47.0531 31.8281C47.3198 31.6115 47.6365 31.5031 48.0031 31.5031C48.3698 31.5031 48.6781 31.6198 48.9281 31.8531C49.1781 32.0865 49.2698 32.3865 49.2031 32.7531C48.9365 34.5531 48.1698 36.0948 46.9031 37.3781C45.6365 38.6615 44.1031 39.4365 42.3031 39.7031V41.4531C42.3031 41.8198 42.1781 42.1281 41.9281 42.3781C41.6781 42.6281 41.3698 42.7531 41.0031 42.7531ZM7.50313 14.3031C7.50313 13.3698 7.63646 12.4698 7.90312 11.6031C8.16979 10.7365 8.55313 9.91979 9.05313 9.15313C9.55313 8.38646 10.1531 7.72813 10.8531 7.17813C11.5531 6.62812 12.3365 6.18646 13.2031 5.85313C13.7365 5.61979 14.1698 5.75313 14.5031 6.25313C14.8365 6.75313 14.8365 7.28646 14.5031 7.85313C13.9365 8.81979 13.5115 9.85313 13.2281 10.9531C12.9448 12.0531 12.8031 13.1698 12.8031 14.3031C12.8031 15.4365 12.9448 16.5531 13.2281 17.6531C13.5115 18.7531 13.9365 19.7865 14.5031 20.7531C14.8031 21.2865 14.7948 21.8031 14.4781 22.3031C14.1615 22.8031 13.7365 22.9698 13.2031 22.8031C12.3365 22.4698 11.5531 22.0198 10.8531 21.4531C10.1531 20.8865 9.55313 20.2198 9.05313 19.4531C8.55313 18.6865 8.16979 17.8698 7.90312 17.0031C7.63646 16.1365 7.50313 15.2365 7.50313 14.3031ZM-0.796875 37.7531V35.3531C-0.796875 34.3865 -0.555208 33.5115 -0.071875 32.7281C0.411458 31.9448 1.10312 31.2198 2.00312 30.5531C2.16979 30.4198 2.35313 30.3031 2.55313 30.2031C2.75313 30.1031 2.95312 29.9865 3.15313 29.8531C3.81979 29.4865 4.42812 29.5948 4.97813 30.1781C5.52813 30.7615 5.58646 31.4365 5.15313 32.2031C4.91979 32.7698 4.73646 33.3698 4.60313 34.0031C4.46979 34.6365 4.40313 35.2865 4.40313 35.9531V37.7531C4.40313 38.2865 4.45312 38.8448 4.55312 39.4281C4.65312 40.0115 4.80313 40.5865 5.00313 41.1531C5.16979 41.6198 5.12813 42.0615 4.87813 42.4781C4.62813 42.8948 4.26979 43.1031 3.80312 43.1031C2.53646 43.1031 1.45312 42.5615 0.553125 41.4781C-0.346875 40.3948 -0.796875 39.1531 -0.796875 37.7531Z"
          fill={LOGISTICS_ORANGE}
        />
      </Svg>
    );

    return (
      <View style={[styles.integratedSection, { paddingHorizontal: homeGutter }]}>
        <Text style={[styles.logisticsSectionTitleOrange, { color: LOGISTICS_ORANGE }]}>
          {t('home.integratedTitleOrange')}
        </Text>
        <Text style={styles.logisticsSectionTitleBlack}>{t('home.integratedTitleBlack')}</Text>
        <View style={styles.integratedPlus}>
          <View style={styles.integratedCenterOrangeStandalone} pointerEvents="none" />
          <View style={[styles.integratedCornerSlot, { top: 0, left: 0 }]}>
            {cell('home.integratedBtn1', ParcelTrackingIcon, false, 'tl')}
          </View>
          <View style={[styles.integratedCornerSlot, { top: 0, right: 0 }]}>
            {cell('home.integratedBtn2', CustomsCodeIcon, false, 'tr')}
          </View>
          <View style={styles.integratedCenterSlot}>
            <TouchableOpacity style={styles.integratedCenterWhiteCard} onPress={go} activeOpacity={0.88}>
              <View style={styles.integratedCenterContent}>
                <Image
                  source={require('../../assets/icons/kcs-logo.png')}
                  style={styles.integratedUnipassLogo}
                  resizeMode="contain"
                />
                <Text style={[styles.integratedCellLabel, styles.integratedCellLabelLarge]} numberOfLines={3}>
                  {t('home.integratedBtn3')}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
          <View style={[styles.integratedCornerSlot, { bottom: 0, left: 0 }]}>
            {cell('home.integratedBtn4', SupportAgentIcon, false, 'bl')}
          </View>
          <View style={[styles.integratedCornerSlot, { bottom: 0, right: 0 }]}>
            {cell('home.integratedBtn5', TerminalIcon, false, 'br')}
          </View>
        </View>
      </View>
    );
  };

  /** CS Center 하단: 영업시간 → 빠른 연락 → 환율 안내 → 배송 (로그인 화면과 동일 UI, 게스트 하단에도 사용) */
  const renderCsCenterFooter = () => (
    <>
      <Text style={styles.csHours}>{t('home.csHoursLine1')}</Text>
      <Text style={styles.csHours}>{t('home.csHoursLine2')}</Text>
      <Text style={[styles.csHours, styles.csHoursAccent]}>{t('home.csHoursLine3')}</Text>

      <View style={styles.csQuickRow}>
        {([
          {
            title: 'home.csKakaoTitle',
            image: require('../../assets/icons/cs-kakao.png'),
            url: KAKAO_CS_CHANNEL_URL,
          },
          // 위챗 상담신청 카드는 사용자 요청으로 제거됨.
          // 1:1 상담신청 — 메세지 페지의 두 번째 탭(general) 으로 내비게이션.
          {
            title: 'home.csOneTitle',
            image: require('../../assets/icons/cs-one.png'),
            navTarget: 'messageGeneral' as const,
          },
        ] as Array<{
          bg?: string;
          title: string;
          icon?: string;
          image?: any;
          url?: string;
          navTarget?: 'messageGeneral';
        }>).map((q) => (
          <TouchableOpacity
            key={q.title}
            style={styles.csQuickCol}
            onPress={() => {
              if (q.url) {
                openExternalUrl(q.url);
              } else if (q.navTarget === 'messageGeneral') {
                // Main 보텀 탭의 Message 화면을 두 번째 탭(general — 1:1) 으로
                // 진입. 다른 화면들이 쓰는 동일한 패턴.
                (navigation as any).navigate('Main', {
                  screen: 'Message',
                  params: { initialTab: 'general' },
                });
              } else {
                navigation.navigate('CustomerService' as never);
              }
            }}
            activeOpacity={0.88}
          >
            <View style={[styles.csQuickCircle, { backgroundColor: q.bg }]}>
              {q.image ? (
                <Image source={q.image} style={styles.csQuickIconImage} resizeMode="contain" />
              ) : (
                <Icon name={q.icon!} size={26} color={q.bg === '#FEE500' ? COLORS.black : COLORS.white} />
              )}
            </View>
            <Text style={styles.csQuickTitle}>{t(q.title)}</Text>
            <Text style={styles.csQuickGo}>{t('home.csGo')}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.csFxCard}>
        <View style={styles.csFxHeader}>
          <Svg width={20} height={20} viewBox="0 0 16 16" fill="none">
            <Path
              d="M6.16354 10.2302H7.78021C8.02465 10.2302 8.23299 10.1441 8.40521 9.97188C8.57743 9.79965 8.66354 9.59132 8.66354 9.34688C8.66354 9.10243 8.57743 8.8941 8.40521 8.72188C8.23299 8.54965 8.02465 8.46354 7.78021 8.46354H6.19688L6.44688 8.21354C6.61354 8.04688 6.69688 7.84132 6.69688 7.59688C6.69688 7.35243 6.61354 7.14688 6.44688 6.98021C6.28021 6.81354 6.07465 6.73021 5.83021 6.73021C5.58576 6.73021 5.38021 6.81354 5.21354 6.98021L3.44688 8.74688C3.2691 8.92465 3.18021 9.13021 3.18021 9.36354C3.18021 9.59688 3.2691 9.80243 3.44688 9.98021L5.21354 11.7469C5.38021 11.9135 5.58576 11.9969 5.83021 11.9969C6.07465 11.9969 6.28021 11.9135 6.44688 11.7469C6.61354 11.5802 6.69688 11.3747 6.69688 11.1302C6.69688 10.8858 6.61354 10.6802 6.44688 10.5135L6.16354 10.2302ZM9.79688 7.53021L9.54688 7.78021C9.38021 7.94688 9.29688 8.15243 9.29688 8.39688C9.29688 8.64132 9.38021 8.84688 9.54688 9.01354C9.71354 9.18021 9.9191 9.26354 10.1635 9.26354C10.408 9.26354 10.6135 9.18021 10.7802 9.01354L12.5469 7.24688C12.7247 7.0691 12.8135 6.86354 12.8135 6.63021C12.8135 6.39688 12.7247 6.19132 12.5469 6.01354L10.7802 4.24688C10.6135 4.08021 10.408 3.99688 10.1635 3.99688C9.9191 3.99688 9.71354 4.08021 9.54688 4.24688C9.38021 4.41354 9.29688 4.6191 9.29688 4.86354C9.29688 5.10799 9.38021 5.31354 9.54688 5.48021L9.83021 5.76354H8.21354C7.9691 5.76354 7.76076 5.84965 7.58854 6.02188C7.41632 6.1941 7.33021 6.40243 7.33021 6.64688C7.33021 6.89132 7.41632 7.09965 7.58854 7.27188C7.76076 7.4441 7.9691 7.53021 8.21354 7.53021H9.79688ZM7.99688 15.1969C6.99688 15.1969 6.06076 15.008 5.18854 14.6302C4.31632 14.2524 3.55521 13.7385 2.90521 13.0885C2.25521 12.4385 1.74132 11.6774 1.36354 10.8052C0.985764 9.93299 0.796875 8.99688 0.796875 7.99688C0.796875 6.99688 0.985764 6.05799 1.36354 5.18021C1.74132 4.30243 2.25521 3.53854 2.90521 2.88854C3.55521 2.23854 4.31632 1.72743 5.18854 1.35521C6.06076 0.982986 6.99688 0.796875 7.99688 0.796875C8.99688 0.796875 9.93576 0.982986 10.8135 1.35521C11.6913 1.72743 12.4552 2.23854 13.1052 2.88854C13.7552 3.53854 14.2663 4.30243 14.6385 5.18021C15.0108 6.05799 15.1969 6.99688 15.1969 7.99688C15.1969 8.99688 15.0108 9.93299 14.6385 10.8052C14.2663 11.6774 13.7552 12.4385 13.1052 13.0885C12.4552 13.7385 11.6913 14.2524 10.8135 14.6302C9.93576 15.008 8.99688 15.1969 7.99688 15.1969ZM7.99688 13.4302C9.5191 13.4302 10.8052 12.9052 11.8552 11.8552C12.9052 10.8052 13.4302 9.5191 13.4302 7.99688C13.4302 6.47465 12.9052 5.18854 11.8552 4.13854C10.8052 3.08854 9.5191 2.56354 7.99688 2.56354C6.47465 2.56354 5.18854 3.08854 4.13854 4.13854C3.08854 5.18854 2.56354 6.47465 2.56354 7.99688C2.56354 9.5191 3.08854 10.8052 4.13854 11.8552C5.18854 12.9052 6.47465 13.4302 7.99688 13.4302Z"
              fill={LOGISTICS_ORANGE}
            />
          </Svg>
          <Text style={[styles.csFxHeaderTitle, { color: LOGISTICS_ORANGE }]}>{t('home.csFxTitle')}</Text>
        </View>
        {[
          ['home.csFxRow1L', 'home.csFxRow1R'],
          ['home.csFxRow2L', 'home.csFxRow2R'],
          ['home.csFxRow3L', 'home.csFxRow3R'],
          ['home.csFxRow4L', 'home.csFxRow4R'],
        ].map(([l, r]) => (
          <View key={l} style={styles.csFxRow}>
            <Text style={styles.csFxLabel}>{t(l)}</Text>
            <Text style={styles.csFxValue}>{t(r)}</Text>
          </View>
        ))}
      </View>

      {/* Departure schedule card (출항 스케줄) removed per request.
          Styles `csShipCard` / `csShipHeader` etc. and the i18n keys
          `home.csShip*` are intentionally left in place so the card
          can be re-enabled by uncommenting this block. */}
    </>
  );

  const renderCsCenterSection = () => {
    // 한 줄의 전화 항목 — 가운데 정렬된 텍스트 컬럼(전화번호 + 설명) +
    // 오른쪽 전화 아이콘. 카드 안에서 세로로 1~2 개 쌓인다.
    // entries.map() 안에서 호출되므로 key 를 직접 부여한다 — 전화번호는
    // 카드 내에서 유일하므로 phone 자체로 충분히 고유.
    const phoneEntry = (phone: string, tag: string, isLast: boolean) => (
      <TouchableOpacity
        key={phone}
        style={[styles.csPhoneEntry, !isLast && styles.csPhoneEntryDivider]}
        onPress={() => openDial(phone)}
        activeOpacity={0.85}
      >
        <View style={styles.csPhoneEntryTextCol}>
          <Text
            style={styles.csPhoneNumber}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {phone}
          </Text>
          <Text style={styles.csPhoneTag} numberOfLines={1}>{tag}</Text>
        </View>
        <View style={styles.csPhoneEntryIcon}>{PhoneHandsetIcon}</View>
      </TouchableOpacity>
    );

    // 한 카드 = 한 행. 왼쪽에 도시명(세로 중앙), 오른쪽에 전화 항목 1~2 개.
    const cityCard = (
      cityKey: string,
      entries: Array<{ phone: string; tag: string }>,
    ) => (
      <View key={cityKey} style={styles.csCityCardFull}>
        <View style={styles.csCityNameWrap}>
          <Text style={styles.csCityName} numberOfLines={1}>{cityKey}</Text>
        </View>
        <View style={styles.csCityEntriesCol}>
          {entries.map((e, idx) =>
            phoneEntry(e.phone, e.tag, idx === entries.length - 1),
          )}
        </View>
      </View>
    );

    const PhoneHandsetIcon = (
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
        <Path
          d="M20.7531 21.8031C18.4198 21.8031 16.1365 21.3198 13.9031 20.3531C11.6698 19.3865 9.64479 17.9948 7.82812 16.1781C6.01146 14.3781 4.61979 12.3573 3.65313 10.1156C2.68646 7.87396 2.20312 5.58646 2.20312 3.25313C2.20312 2.91979 2.29479 2.66146 2.47813 2.47813C2.66146 2.29479 2.91979 2.20312 3.25313 2.20312H8.25313C8.48646 2.20312 8.69896 2.28229 8.89062 2.44062C9.08229 2.59896 9.20312 2.78646 9.25313 3.00313L10.0031 7.25313C10.0365 7.48646 10.0281 7.69479 9.97813 7.87813C9.92812 8.06146 9.85313 8.20312 9.75313 8.30312L7.10313 11.0031C7.41979 11.5698 7.79479 12.124 8.22813 12.6656C8.66146 13.2073 9.15312 13.7531 9.70312 14.3031C10.2031 14.7865 10.7115 15.2365 11.2281 15.6531C11.7448 16.0698 12.2698 16.4365 12.8031 16.7531L15.5531 14.1031C15.6865 13.9698 15.8365 13.8781 16.0031 13.8281C16.1698 13.7781 16.3365 13.7698 16.5031 13.8031L20.9531 14.7531C21.1865 14.8198 21.3865 14.9406 21.5531 15.1156C21.7198 15.2906 21.8031 15.4865 21.8031 15.7031V20.7531C21.8031 21.0865 21.7115 21.3448 21.5281 21.5281C21.3448 21.7115 21.0865 21.8031 20.7531 21.8031Z"
          fill={COLORS.black}
        />
      </Svg>
    );

    return (
      <View style={[styles.csSection, { paddingHorizontal: homeGutter }]}>
        <Text style={styles.csTitle1}>  
        <Text style={[styles.csTitleOrange, { color: LOGISTICS_ORANGE }]}>{t('home.csTitleOrange')}</Text>
        <Text> </Text>
        <Text style={styles.csTitleBlack}>{t('home.csTitleBlack')}</Text>
        </Text>
        <Text style={styles.csSubtitle1} >
          <Text>{t('home.csSubtitleBefore')}</Text>
          <Text style={{ color: LOGISTICS_ORANGE, fontWeight: '700' }}>{t('home.csSubtitleHighlight')}</Text>
        </Text>
        <Text style={styles.csSubtitle2}>{t('home.csSubtitleAfter')}</Text>

        {(() => {
          // 3-up row of CS-Center city cards that always stays on ONE
          // line, regardless of device width:
          //   1. Container forces `flexWrap: 'nowrap'` and uses
          //      `space-between` so the gaps become equal residual
          //      space between cards.
          //   2. Each card gets an explicit width derived from the live
          //      `homeContentWidth` minus the two inter-card gaps,
          //      divided by 3. `flexShrink: 1` lets the card shrink if
          //      needed (some inner content uses minWidth implicitly).
          //   3. The gap, card padding and a card-only min-width all
          //      scale with the responsive bucket so phones and tablets
          //      both look comfortable.
          // 각 도시 카드가 한 행 전체를 차지. 세로로 쌓아 표시.
          return (
            <View style={styles.csCardsCol}>
              {cityCard(t('home.csWeihai'), [
                { phone: t('home.csPhoneWeihai1'), tag: t('home.csTagWeihai1') },
                { phone: t('home.csPhoneWeihai2'), tag: t('home.csTagWeihai2') },
              ])}
              {cityCard(t('home.csYiwu'), [
                { phone: t('home.csPhoneYiwu'), tag: t('home.csTagYiwu') },
              ])}
              {cityCard(t('home.csGwangju'), [
                { phone: t('home.csPhoneGwangju'), tag: t('home.csTagGwangju') },
              ])}
            </View>
          );
        })()}

        {renderCsCenterFooter()}
      </View>
    );
  };

  const renderHeader = () => {
    const wordmark = String(t('home.guestLogoWordmark'));
    const taglineFull = String(t('home.guestPartnerTagline'));
    const tag1688 = '1688';
    const tag1688Idx = taglineFull.indexOf(tag1688);
    const useTodayGgiguMark = wordmark.toLowerCase() === 'todayggigu';

    const renderTodayGgiguMark = () => {
      if (!useTodayGgiguMark) {
        return (
          <Text style={styles.guestWordmarkPlain} numberOfLines={1}>
            {wordmark}
          </Text>
        );
      }
      return (
        <TodayGgiguWordmarkIcon
          style={styles.guestWordmarkImage}
          accessibilityLabel={wordmark}
        />
      );
    };

    const renderTagline = () =>
      tag1688Idx >= 0 ? (
        <Text style={styles.homeGuestBrandSubDark} numberOfLines={2}>
          {tag1688Idx > 0 ? taglineFull.slice(0, tag1688Idx) : ''}
          <Text style={styles.homeGuestBrand1688}>{taglineFull.slice(tag1688Idx, tag1688Idx + tag1688.length)}</Text>
          {taglineFull.slice(tag1688Idx + tag1688.length)}
        </Text>
      ) : (
        <Text style={styles.homeGuestBrandSubDark} numberOfLines={2}>
          {taglineFull}
        </Text>
      );

    return (
      <View style={[styles.header, styles.headerGuestLight, { paddingHorizontal: homeGutter }]}>
        <View style={styles.headerContent}>
          <StatusBar
            barStyle="dark-content"
            backgroundColor="transparent"
            translucent={Platform.OS === 'android'}
          />
          <View
            ref={headerTopRowRef}
            style={styles.headerGuestTop}
            onLayout={syncCategoryModalTopOffset}
          >
            <TouchableOpacity
              style={styles.headerGuestMenuBtn}
              onPress={openCategoryModal}
              activeOpacity={0.85}
            >
              <MenuIcon width={26} height={26} color={COLORS.black} />
            </TouchableOpacity>
            <View style={styles.homeGuestBrandCenter}>
              {renderTodayGgiguMark()}
              {renderTagline()}
            </View>
            <View style={styles.homeGuestHeaderRight}>
              <TouchableOpacity
                style={styles.headerGuestIconBtn}
                onPress={() => navigation.navigate('LanguageSettings' as never)}
                activeOpacity={0.85}
              >
                <Text style={styles.flagText}>{getLanguageFlag(locale)}</Text>
              </TouchableOpacity>
              <NotificationBadge
                customIcon={<HeadsetMicIcon width={26} height={26} color={COLORS.black} />}
                count={unreadCount}
                badgeColor={LOGISTICS_ORANGE}
                onPress={() =>
                  // Route the header inquiry icon to the Message tab's 1:1
                  // (general) section — same deep-link target as ProductDetail
                  // bottom bar and ProfileScreen header. This file's
                  // navigation prop is loosely typed (`useNavigation<any>`-style
                  // usage elsewhere), so cast through `any` to pass the nested
                  // navigator params object.
                  (navigation as any).navigate('Main', {
                    screen: 'Message',
                    params: { initialTab: 'general' },
                  })
                }
              />
            </View>
          </View>
          <View style={styles.searchButtonContainer}>
            <SearchButton
              placeholder={t('home.guestSearchPlaceholder')}
              onPress={() => navigation.navigate('Search' as never)}
              onCameraPress={handleImageSearch}
              style={styles.searchButtonStyle}
              isHomepage={true}
              hideMenu
              prominentBorder
              showPlaceholderAsBody
              cameraLeading
            />
          </View>
        </View>
      </View>
    );
  };


  // Handle scroll event to detect when user reaches the end
  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: true,
      listener: (event: any) => {
        // Safety check for event
        if (!event || !event.nativeEvent) return;
        
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
        
        // Safety checks for scroll properties
        if (!layoutMeasurement || !contentOffset || !contentSize) return;
        
        const scrollPosition = contentOffset.y;

        // Update isScrolled state based on threshold
        if (scrollPosition > SCROLL_THRESHOLD && !isScrolled) {
          setIsScrolled(true);
        } else if (scrollPosition <= SCROLL_THRESHOLD && isScrolled) {
          setIsScrolled(false);
        }
        
        if (scrollPosition > 300 && !showScrollToTop) {
          setShowScrollToTop(true);
          Animated.timing(scrollToTopOpacity, {
            toValue: 1,
            duration: 200,
            useNativeDriver: true,
          }).start();
        } else if (scrollPosition <= 300 && showScrollToTop) {
          Animated.timing(scrollToTopOpacity, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }).start(() => setShowScrollToTop(false));
        }
        
      }
    }
  );

  if (initialLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <Text>{t('home.loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={[COLORS.white, 'rgba(255,255,255,0)']}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.gradientBackgroundFixed}
        pointerEvents="none"
      />
      <View style={styles.fixedTopBars}>
        <View style={styles.homeHeaderWhiteShell}>
          {renderHeader()}
        </View>
      </View>
      
      <Animated.ScrollView
        ref={scrollViewRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={32}
      >
        <View style={styles.contentWrapper}>
          <View style={[styles.guestAboveFold, { paddingHorizontal: homeGutter }]}>
            {renderGuestInsightGrid()}
          </View>
          {!(user && !isGuest) && (
            <View style={[styles.guestAboveFold, { paddingHorizontal: homeGutter }]}>
              {renderGuestWelcomePanel()}
            </View>
          )}
          {/* {renderQuickCategories()} */}
          {isAuthenticated && !isGuest && user && renderUserOrderSummaryCard()}
          {renderGlobalLogisticsSection()}
          {/* Integrated Services section removed per request — keep the
              renderer/styles in place as dead code so we can re-enable
              quickly if needed. `void` reference silences the "unused"
              hint without re-rendering anything. */}
          {void renderIntegratedServicesSection}
          {renderCsCenterSection()}
          {/* {renderTrendingProducts()} */}
          {/* {renderPopularCategories()} */}
          {/* {renderPromoCards()} */}
          {/* {renderNewInCards()} */}
        </View>
      </Animated.ScrollView>
      
      {/* Scroll to Top Button */}
      {showScrollToTop && (
        <Animated.View
          style={[
            styles.scrollToTopButton,
            { opacity: scrollToTopOpacity }
          ]}
        >
          <TouchableOpacity
            onPress={scrollToTop}
            style={styles.scrollToTopTouchable}
            activeOpacity={0.8}
          >
            <Icon name="chevron-up" size={28} color={COLORS.black} />
          </TouchableOpacity>
        </Animated.View>
      )}
      
      <ImagePickerModal
        visible={imagePickerModalVisible}
        onClose={() => setImagePickerModalVisible(false)}
        onTakePhoto={handleTakePhoto}
        onChooseFromGallery={handleChooseFromGallery}
      />

      {/* 인기검색순위 모달 — 인사이트 카드의 '인기검색순위 Hot10' 단추에서 열림.
          2-열 × 5-행 (총 10개 행) 그리드: 각 행은 [인기 10 | 랜크 번호 | 아이템명 | 상승 N]. */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={categoryModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCategoryModalVisible(false)}
      >
        <View style={styles.categoryModalRoot}>
          <View
            style={[styles.categoryModalHeaderSpacer, { height: categoryModalTopOffset }]}
            pointerEvents="none"
          />
          <View style={styles.categoryModalBody}>
            <TouchableOpacity
              style={styles.categoryModalBackdrop}
              activeOpacity={1}
              onPress={() => setCategoryModalVisible(false)}
            />
            <View
              style={styles.categoryModalPanel}
              onStartShouldSetResponder={() => true}
            >
              <CategoryTabScreen
                hideHeader
                asHomeModal
                onModalClose={() => setCategoryModalVisible(false)}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showPopularRankingModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowPopularRankingModal(false)}
      >
        <TouchableOpacity
          style={styles.popularModalBackdrop}
          activeOpacity={1}
          onPress={() => setShowPopularRankingModal(false)}
        >
          <View
            style={styles.popularModalCard}
            onStartShouldSetResponder={() => true}
          >
            {/* 헤더 — 🔥 인기 검색 순위 */}
            <View style={styles.popularModalHeader}>
              <Text style={styles.popularModalHeaderEmoji}>🔥</Text>
              <Text style={styles.popularModalHeaderText}>
                {t('home.popularRankingModal.title')}
              </Text>
            </View>
            {/* 2-열 × 5-행 그리드 — 10개 순위 항목 */}
            <View style={styles.popularRowsGrid}>
              {Array.from({ length: 10 }).map((_, idx) => (
                <View key={idx} style={styles.popularRowCell}>
                  <View style={styles.popularRow}>
                    <Text style={styles.popularRowLeftLabel}>
                      {t('home.popularRankingModal.popularBadge')}
                    </Text>
                    <View style={styles.popularRowDivider} />
                    <View style={styles.popularRowRankBadge}>
                      <Text style={styles.popularRowRankText}>{idx + 1}</Text>
                    </View>
                    <Text style={styles.popularRowItem} numberOfLines={1}>
                      {t('home.popularRankingModal.itemPlaceholder')}
                    </Text>
                    <Text style={styles.popularRowUp}>
                      {t('home.popularRankingModal.upLabel')} 2
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  gradientBackgroundFixed: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 650, // Shorter gradient coverage
    zIndex: 0,
  },
  gradientFill: {
    flex: 1,
  },
  // ─── 인기검색순위 카드 (홈 인사이트 그리드 좌상단) ──────────────
  popularCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  popularCardTitle: {
    flex: 0,
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.text.primary,
  },
  // 작은 붉은 알약 배지 "Hot10"
  popularCardHot10Badge: {
    backgroundColor: COLORS.red,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  popularCardHot10Text: {
    fontSize: 10,
    fontWeight: '800',
    color: COLORS.white,
  },
  // 1 행 — 🔥 + 붉은 원형 랭크 + 아이템 + 우측 ↑N
  popularCardLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  popularCardFire: {
    fontSize: FONTS.sizes.xs,
    marginRight: 4,
  },
  // 카드용 작은 붉은 원형 랭크 배지 (모달 것보다 작게)
  popularCardRankBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: COLORS.red,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  popularCardRankText: {
    fontSize: 9,
    fontWeight: '800',
    color: COLORS.white,
  },
  popularCardItem: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  popularCardUp: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '700',
    marginLeft: SPACING.xs,
  },
  // ─── 홈 카테고리 모달 (헤더 바로 아래) ───────────────────────────
  categoryModalRoot: {
    flex: 1,
  },
  categoryModalHeaderSpacer: {
    backgroundColor: 'transparent',
  },
  categoryModalBody: {
    flex: 1,
    position: 'relative',
  },
  categoryModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  categoryModalPanel: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.white,
    overflow: 'hidden',
  },
  // ─── 인기검색순위 모달 ──────────────────────────────────────────
  popularModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACING.md,
  },
  popularModalCard: {
    width: '100%',
    maxWidth: 720,
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.md,
  },
  popularModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  popularModalHeaderEmoji: {
    fontSize: FONTS.sizes.lg,
  },
  popularModalHeaderText: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '800',
    color: COLORS.red,
  },
  // 2-열 × 5-행 그리드 — 항목 셀들이 가로/세로로 깔끔히 정렬되도록 flexWrap.
  popularRowsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  popularRowCell: {
    // 2-열 — 부모 gap(SPACING.sm) 을 빼고 50% 폭.
    width: '48.5%',
  },
  popularRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 85, 0, 0.06)',
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
  },
  popularRowLeftLabel: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '700',
    marginRight: SPACING.sm,
  },
  popularRowDivider: {
    width: 1,
    height: 14,
    backgroundColor: COLORS.gray[300],
    marginRight: SPACING.sm,
  },
  popularRowRankBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLORS.red,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
  popularRowRankText: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.white,
  },
  popularRowItem: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  popularRowUp: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.red,
    fontWeight: '700',
    marginLeft: SPACING.sm,
  },
  scrollView: {
    minHeight: '100%',
    backgroundColor: COLORS.background,
  },
  scrollContent: {
    paddingTop: 10,
    paddingBottom: 32,
    backgroundColor: COLORS.background,
    flexGrow: 1,
  },
  fixedTopBars: {
    backgroundColor: 'transparent',
    zIndex: 10,
    // marginBottom: -80,
  },
  homeHeaderWhiteShell: {
    backgroundColor: COLORS.white,
  },
  headerPlaceholder: {
    backgroundColor: COLORS.white,
  },
  contentWrapper: {
    backgroundColor: COLORS.background,
    marginBottom: 100,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    fontWeight: '500',
    marginTop: SPACING.md,
  },
  header: {
    zIndex: 10,
    paddingHorizontal: HOME_GUTTER,
    // SafeAreaView already clears the status bar; keep modest insets (tuned for Android emulator + iOS)
    paddingTop: Platform.OS === 'android' ? 12 : 26,
    paddingBottom: SPACING.sm,
  },
  headerGuestLight: {
    backgroundColor: COLORS.white,
    paddingTop: Platform.OS === 'android' ? 10 : 16,
    paddingBottom: SPACING.sm,
  },
  headerContent: {
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  menuButtonContainer: {
    // width: 80, // Fixed width to balance with right side
    alignItems: 'flex-start',
  },
  logoContainer: {
    flex: 1,
    minWidth: 0,
    alignItems: 'flex-start',
    justifyContent: 'center',
    marginLeft: SPACING.sm,
  },
  homeMemberHeaderMain: {
    marginLeft: 0,
  },
  homeHeaderTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
  },
  homeHeaderAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  homeHeaderAvatarPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  homeHeaderTitleTexts: {
    flex: 1,
    minWidth: 0,
    marginLeft: SPACING.sm,
  },
  homeLoginCta: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs + 2,
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    justifyContent: 'center',
    alignItems: 'center',
    ...(Platform.OS === 'android'
      ? {
          minHeight: 48,
          minWidth: 88,
          paddingHorizontal: SPACING.md + 2,
          borderRadius: BORDER_RADIUS['2xl'],
          elevation: 3,
        }
      : {}),
  },
  homeLoginCtaText: {
    fontSize: Platform.OS === 'android' ? FONTS.sizes.md : FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.red,
  },
  guestWordmarkImage: {
    alignSelf: 'center',
    width: Math.min(200, screenWidth - 148),
    height: 30,
  },
  guestWordmarkPlain: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '800',
    color: COLORS.black,
    textAlign: 'center',
  },
  homeGuestBrandSubDark: {
    marginTop: 4,
    fontSize: FONTS.sizes.xs,
    fontWeight: '500',
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: Math.round(FONTS.sizes.xs * 1.5),
  },
  homeGuestBrand1688: {
    color: LOGISTICS_ORANGE,
    fontWeight: '800',
  },
  headerGuestTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  headerGuestMenuBtn: {
    padding: SPACING.xs,
    marginRight: SPACING.xs,
  },
  homeGuestBrandCenter: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    paddingHorizontal: SPACING.xs,
  },
  homeGuestBrandTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '800',
    color: COLORS.white,
    textAlign: 'center',
  },
  homeGuestBrandSub: {
    marginTop: 2,
    fontSize: FONTS.sizes.xs,
    fontWeight: '500',
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
    lineHeight: Math.round(FONTS.sizes.xs * 1.5),
  },
  homeGuestHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  headerGuestIconBtn: {
    padding: SPACING.xs,
  },
  guestAboveFold: {
    paddingHorizontal: HOME_GUTTER,
    marginBottom: SPACING.sm,
    backgroundColor: COLORS.background,
  },
  guestInsightGrid: {
    marginBottom: SPACING.md,
  },
  guestInsightRow: {
    flexDirection: 'row',
    gap: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  guestInsightRowLandscape: {
    marginBottom: 0,
  },
  guestInsightCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.sm,
    // minHeight 112 → 90 으로 축소. 4장 카드 중 콘텐츠가 가장 적은
    // 인기 검색 순위 카드의 하단 빈 공간을 줄여 나머지 3장(신규등록상점 /
    // 인기업체 / 베스트상품) 의 자연 높이와 시각적으로 동일해지도록 함.
    // 같은 row 안 카드는 default alignItems: 'stretch' 로 더 큰 쪽에 맞춰
    // 자동 동기화되므로, 4장 모두 같은 row 들 안에서 동일 높이가 보장됨.
    minHeight: 90,
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
    ...Platform.select({
      android: { elevation: 2 },
      ios: {
        shadowColor: COLORS.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
      },
    }),
  },
  guestInsightCardLandscape: {
    flex: 1,
    minWidth: 0,
  },
  guestInsightTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
  },
  guestInsightLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  guestInsightRank: {
    width: 18,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  guestInsightItem: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  guestInsightUp: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.error,
    fontWeight: '800',
  },
  guestInsightMeta: {
    marginTop: SPACING.xs,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  guestInsightThumb: {
    marginTop: SPACING.sm,
    height: 44,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[200],
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
  },
  // 베스트상품 카드 — 다른 3개 카드와 동일한 크기 유지(부모 guestInsightCard
  // 의 minHeight: 112 를 그대로 상속). 텍스트가 썸네일과 겹치지 않도록
  // paddingRight 으로 우측 공간 확보, 텍스트 라인 간격은 거의 0 으로 압축해
  // 4줄(타이틀 + 서브 + Top10 + 바로가기) 이 자연스럽게 들어가게 한다.
  bestProductsCard: {
    position: 'relative',
    // 인기 검색 순위 카드(베이스 padding 만 사용) 와 외형 폭을 정확히
    // 일치시키기 위해 paddingRight 오버라이드 제거 — 베이스 guestInsightCard
    // 의 padding: SPACING.sm 을 그대로 상속해 4장 모두 내부/외부 폭이 동일.
  },
  bestProductsSubtitle: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
    marginTop: 0,
  },
  bestProductsTop10: {
    fontSize: FONTS.sizes.md,
    fontWeight: '900',
    color: COLORS.red,
    marginTop: 0,
  },
  bestProductsCta: {
    marginTop: 0,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  // 카드의 우하단에 떠 있는 1등 상품 썸네일 (원래 크기 52×52 유지).
  bestProductsThumb: {
    position: 'absolute',
    right: SPACING.sm,
    bottom: SPACING.sm,
    width: 52,
    height: 52,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
  },
  bestProductsThumbPlaceholder: {
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
  },
  bestProductsThumbLandscape: {
    width: 44,
    height: 44,
  },
  /** Figma Group 76728 — full-width inside 16px gutter, min height 472 */
  guestWelcomePanel: {
    marginBottom: SPACING.md,
    padding: SPACING.md,
    backgroundColor: COLORS.lightRed,
    borderRadius: BORDER_RADIUS.xl,
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_20,
    // `minHeight: GUEST_PROMO_MIN_HEIGHT` removed — the previous 472px
    // minimum was sized for the old 10-orb category grid; with the new
    // 2-card layout the panel now has noticeable empty space below the
    // cards. Letting the panel size to content keeps the bottom gap
    // equal to the panel's own `padding: SPACING.md`.
  },
  guestWelcomeHeadRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  guestMascot: {
    width: 44,
    height: 44,
  },
  guestWelcomeHeadline1: {
    flex: 1,
    fontSize: FONTS.sizes.sm * 1.5,
    fontWeight: '900',
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 30 / 14),
  },
  guestWelcomeHeadline2: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 20 / 14),
  },
  guestQuickStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xs,
    marginBottom: SPACING.md,
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
  },
  guestQuickItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  guestQuickLabel: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '600',
    color: COLORS.text.primary,
    textAlign: 'center',
  },
  guestBulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: 8,
  },
  guestBulletGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  // Row that holds the two service cards (시장조사 / OEM공장조사)
  // inside the red guest welcome panel. `space-between` makes the
  // two cards line up flush with the panel's inner-left and
  // inner-right edges; the explicit `gap` is applied inline.
  guestWelcomeServiceCardsRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    justifyContent: 'space-between',
    marginTop: SPACING.md,
  },
  guestBulletCell: {
    width: '50%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingRight: SPACING.sm,
  },
  guestBulletText: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  guestPrimaryLoginBtn: {
    marginTop: SPACING.sm,
    marginHorizontal: SPACING.md,
    backgroundColor: COLORS.red,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      android: { elevation: 4 },
      ios: {
        shadowColor: COLORS.red,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
    }),
  },
  guestPrimaryLoginText: {
    color: COLORS.white,
    fontWeight: '800',
    fontSize: FONTS.sizes.md,
  },
  guestOrbSection: {
    marginTop: SPACING.md,
    marginBottom: SPACING.xs,
  },
  guestOrbGrid: {
    
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
     gap: SPACING.smmd,
     marginLeft: SPACING.xs,
     marginBottom: SPACING.xs
  },
  guestOrbCell: {
    marginTop: SPACING.xs,
    alignItems: 'center',
    marginBottom: SPACING.xs,
    
  },
  guestOrbCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 6,
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
    ...Platform.select({
      android: { elevation: 2 },
      ios: {
        shadowColor: COLORS.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
    }),
  },
  guestOrbLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: COLORS.text.primary,
    textAlign: 'center',
    paddingHorizontal: 2,
    lineHeight: 13,
  },
  logisticsSection: {
    paddingHorizontal: HOME_GUTTER,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
    backgroundColor: COLORS.background,
  },
  logisticsSectionTitleOrange: {
    textAlign: 'center',
    fontSize: FONTS.sizes.xl,
    fontWeight: '800',
  },
  logisticsSectionTitleBlack: {
    textAlign: 'center',
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.black,
    marginBottom: SPACING.md,
  },
  logisticsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    flexWrap: 'nowrap',
  },
  logisticsStepCol: {
    width: 76,
    alignItems: 'center',
  },
  logisticsStepCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logisticsStepLabel: {
    marginTop: 6,
    fontSize: 10,
    fontWeight: '600',
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: 13,
  },
  logisticsArrow: {
    fontSize: FONTS.sizes.sm,
    color: LOGISTICS_ORANGE,
    fontWeight: '700',
    marginTop: 14,
    paddingHorizontal: 2,
  },
  logisticsCardsGrid: {
    marginTop: SPACING.lg,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    justifyContent: 'space-between',
  },
  logisticsServiceCard: {
    width: (HOME_CONTENT_WIDTH - SPACING.sm) / 2,
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
    ...Platform.select({
      android: { elevation: 2 },
      ios: {
        shadowColor: COLORS.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
      },
    }),
  },
  logisticsServiceIconRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logisticsServiceTextCol: {
    flex: 1,
    minWidth: 0,
    marginLeft: SPACING.sm,
  },
  logisticsServiceTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.black,
    marginBottom: 4,
  },
  logisticsServiceDesc: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.sizes.xs * 1.33),
  },
  integratedSection: {
    paddingHorizontal: HOME_GUTTER,
    paddingBottom: SPACING.lg,
    backgroundColor: COLORS.background,
  },
  integratedPlus: {
    marginTop: SPACING.md,
    alignSelf: 'center',
    width: HOME_CONTENT_WIDTH,
    aspectRatio: 341 / 316,
    position: 'relative',
  },
  integratedRowSpread: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  integratedCenterSlot: {
    position: 'absolute',
    top: `${(74 / 316) * 100}%`,
    left: `${(94 / 341) * 100}%`,
    width: `${(152 / 341) * 100}%`,
    height: `${(152 / 316) * 100}%`,
    zIndex: 2,
  },
  integratedCornerSlot: {
    position: 'absolute',
    width: `${(120 / 341) * 100}%`,
    height: `${(120 / 316) * 100}%`,
    zIndex: 1,
  },
  integratedCell: {
    width: '100%',
    height: '100%',
  },
  integratedCellLarge: {
    width: '100%',
    height: '100%',
  },
  integratedCellInner: {
    flex: 1,
    backgroundColor: 'rgba(255, 85, 0, 0.15)',
    borderRadius: 8,
    padding: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  integratedCornerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: LOGISTICS_ORANGE,
    borderRadius: 8,
    zIndex: 0,
  },
  integratedCenterOverlay: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: LOGISTICS_ORANGE,
    borderRadius: 8,
    zIndex: 5,
  },
  integratedCenterOrangeBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 85, 0, 0.15)',
    borderRadius: 8,
    zIndex: 2,
  },
  integratedCenterOrangeStandalone: {
    position: 'absolute',
    top: `${(74 / 316) * 100}%`,
    left: `${(94 / 341) * 100}%`,
    width: `${(152 / 341) * 100}%`,
    height: `${(152 / 316) * 100}%`,
    backgroundColor: 'rgba(255, 85, 0, 0.15)',
    borderRadius: 8,
    zIndex: 0,
  },
  integratedCenterWhiteCard: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: LOGISTICS_ORANGE,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  integratedCenterContent: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 6,
  },
  integratedCornerInsetGroup: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  integratedCornerInsetContent: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  integratedCellInnerLarge: {
    paddingVertical: SPACING.md,
  },
  integratedCellLabel: {
    marginTop: SPACING.xs,
    fontSize: 11,
    fontWeight: '700',
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: 14,
  },
  integratedCellLabelLarge: {
    fontSize: FONTS.sizes.sm,
  },
  integratedUnipassLogo: {
    width: 44,
    height: 44,
  },
  integratedUnipassMark: {
    fontSize: 28,
    lineHeight: 32,
  },
  csSection: {
    
    paddingHorizontal: HOME_GUTTER,
    paddingBottom: SPACING.lg,
    backgroundColor: COLORS.background,
  },
   csTitle1: {
    textAlign: 'center',
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '800',
  },
  csTitleOrange: {
    
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '800',
  },
  csTitleBlack: {
    
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '800',
    color: COLORS.black,
  },
  csSubtitle1: {
    textAlign: 'center',
    marginTop: SPACING.sm,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 1.57),
    marginBottom: SPACING.xs,
  },
  csSubtitle2: {
    textAlign: 'center',
    marginTop: SPACING.xs,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 22 / 14),
    marginBottom: SPACING.md,
  },
  csCardsRow: {
    textAlign: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.mdlg,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  // 새 레이아웃: 카드들을 세로로 쌓는다 (각 카드 = 한 행).
  csCardsCol: {
    flexDirection: 'column',
    gap: SPACING.sm,
  },
  // 한 카드 = 전체 가로폭. 왼쪽 도시명 + 오른쪽 전화 항목들의 row 구성.
  csCityCardFull: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    ...Platform.select({
      android: { elevation: 2 },
      ios: {
        shadowColor: COLORS.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
    }),
  },
  // 도시명 컬럼 — 카드 왼쪽, 세로 중앙 정렬.
  csCityNameWrap: {
    width: 64,
    justifyContent: 'center',
    alignItems: 'center',
    paddingRight: SPACING.sm,
  },
  // 전화 항목 컬럼 — 카드 오른쪽, 1~2 개의 entry 를 세로로 쌓는다.
  csCityEntriesCol: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
  },
  // 한 전화 항목 (전화번호 + 설명 텍스트 + 전화 아이콘) — 가로 row.
  csPhoneEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.xs,
  },
  // 한 카드 안에 entry 가 2 개일 때 사이의 구분선.
  csPhoneEntryDivider: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  // 전화번호 + 설명 텍스트 컬럼 — 카드의 가로 중심에 위치하도록 flex: 1 + center.
  csPhoneEntryTextCol: {
    flex: 1,
    alignItems: 'center',
  },
  // 전화 아이콘 — 텍스트 오른쪽 끝.
  csPhoneEntryIcon: {
    marginLeft: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  csCityCard: {
    textAlign: 'center',
    alignSelf: 'flex-start',
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.sm,
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
    ...Platform.select({
      android: { elevation: 2 },
      ios: {
        shadowColor: COLORS.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
    }),
  },
  csCityCardTall: {
    justifyContent: 'flex-start',
  },
  csCityName: {
    textAlign: 'center',
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.black,
    marginBottom: SPACING.sm,
  },
  csPhoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  csPhoneTextCol: {
    alignItems: 'center',
  },
  csPhoneNumber: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: LOGISTICS_ORANGE,
    textAlign: 'center',
  },
  csPhoneTag: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    textAlign: 'center',
  },
  csHours: {
    textAlign: 'center',
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    marginTop: SPACING.sm,
  },
  csHoursAccent: {
    color: LOGISTICS_ORANGE,
    fontWeight: '600',
  },
  csQuickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.lg,
    marginBottom: SPACING.lg,
    gap: SPACING.sm,
  },
  csQuickCol: {
    flex: 1,
    alignItems: 'center',
  },
  csQuickCircle: {
    width: 84,
    height: 84,
    borderRadius: 42,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  csQuickIconImage: {
    width: 60,
    height: 60,
  },
  csQuickTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.black,
    textAlign: 'center',
    lineHeight: 20,
  },
  csQuickGo: {
    marginTop: 4,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  csFxCard: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
    marginBottom: SPACING.md,
  },
  csFxHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: '#FFE8DC',
  },
  csFxHeaderTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
  },
  csFxRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: FIGMA_OVERLAY_05,
  },
  csFxLabel: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
  },
  csFxValue: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.black,
  },
  csShipCard: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: FIGMA_OVERLAY_05,
  },
  csShipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: '#E3F2FD',
  },
  csShipHeaderIcon: {
    width: 24,
    height: 20,
  },
  csShipHeaderTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
    color: COLORS.black,
  },
  csShipBody: {
    flexDirection: 'row',
    padding: SPACING.md,
    gap: SPACING.md,
  },
  csShipLeft: {
    flex: 1,
  },
  csShipRight: {
    flex: 1.2,
  },
  csShipWeek: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '800',
    color: COLORS.black,
  },
  csShipWeekSub: {
    marginTop: 4,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  csShipLine: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    marginBottom: 6,
    fontWeight: '600',
  },
  csShipFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: FIGMA_OVERLAY_05,
    gap: SPACING.xs,
  },
  csShipFooterText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  appName: {
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '700',
    color: COLORS.white,
    letterSpacing: 0.5,
  },
  logo: {
    width: 120,
    height: 40,
    minWidth: 120, // Ensure minimum width
    minHeight: 40, // Ensure minimum height
  },
  headerPlatformMenu: {
    marginLeft: SPACING.md,
  },
  headerSpacer: {
    flex: 1,
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  headerIcon: {
    padding: SPACING.xs,
    borderRadius: 20,
    backgroundColor: COLORS.gray[100],
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 36,
    height: 36,
  },
  flagText: {
    fontSize: 24,
  },
  searchButtonContainer: {
    width: '100%',
    flexDirection: 'row',
  },
  searchButtonStyle: {
    flex: 1,
  },
  iconButton: {
    padding: SPACING.xs,
  },
  platformRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  platformButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: SPACING.xs,
  },
  logoTitle: {
    fontSize: Platform.OS === 'android' ? FONTS.sizes.md : FONTS.sizes.sm,
    fontWeight: '900',
    color: COLORS.white,
  },
  logoText: {
    fontSize: Platform.OS === 'android' ? FONTS.sizes.sm : FONTS.sizes.xs,
    fontWeight: '400',
    color: COLORS.white,
    ...(Platform.OS === 'android' ? { lineHeight: 20 } : {}),
  },
  quickCategoriesContainer: {
    backgroundColor: 'transparent',
    paddingVertical: 8,
  },
  quickCategoriesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: SPACING.md,
    justifyContent: 'space-between',
  },
  quickCategoryItem: {
    width: (width - SPACING.lg * 2 - SPACING.sm * 4) / 5,
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  quickCategoryImage: {
    width: (width - SPACING.md * 2 - SPACING.sm * 4) / 5,
    height: (width - SPACING.md * 2 - SPACING.sm * 4) / 5,
    borderRadius: 6,
    marginBottom: SPACING.xs,
  },
  quickCategoryName: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    textAlign: 'center',
    fontWeight: '500',
  },
  section: {
    // backgroundColor: COLORS.background,
    
    paddingVertical: 8,
    paddingBottom: 50,
  },
  sectionTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.text.primary,
    paddingHorizontal: SPACING.sm,
    marginBottom: SPACING.smmd,
    textAlign: 'center',
  },
  newInContainer: {
    // No padding here, handled by page container
  },
  newInPage: {
    width: width,
    flexDirection: 'row',
    paddingHorizontal: SPACING.sm,
    gap: SPACING.xs,
  },
  newInCardWrapper: {
    width: NEW_IN_CARD_WIDTH,
    flexShrink: 0,
  },
  newInCard: {
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
    position: 'relative',
  },
  newInImage: {
    width: '100%',
    height: NEW_IN_CARD_HEIGHT,
    borderRadius: 8,
  },
  newInDiscountBadge: {
    position: 'absolute',
    top: SPACING.xs,
    left: SPACING.xs,
    backgroundColor: COLORS.red,
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
    borderRadius: 4,
  },
  newInDiscountText: {
    color: COLORS.white,
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
  },
  newInLikeButton: {
    position: 'absolute',
    top: SPACING.xs,
    right: SPACING.xs,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  newInInfo: {
    padding: SPACING.xs,
  },
  newInName: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
    minHeight: 36,
  },
  newInPriceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
  },
  newInPrice: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  newInOriginalPrice: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[400],
    textDecorationLine: 'line-through',
  },
  newInRating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  newInRatingText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
  },
  newInOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // height: 48,
    paddingHorizontal: SPACING.md,
    justifyContent: 'flex-end',
    paddingBottom: 16,
  },
  newInTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '400',
    color: COLORS.text.primary,
  },
  newInTitleOverlay: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
    color: COLORS.white,
  },
  newInPreviewRow: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  previewOuterCircle: {
    width: (width - SPACING.md * 2 - SPACING.sm * 2) / 4,
    height: (width - SPACING.md * 2 - SPACING.sm * 2) / 4,
    borderRadius: 45,
    borderWidth: 3,
    borderColor: COLORS.red,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    marginRight: SPACING.md,
  },
  previewOuterCircleGray: {
    width: (width - SPACING.md * 2 - SPACING.sm * 2) / 4,
    height: (width - SPACING.md * 2 - SPACING.sm * 2) / 4,
    borderRadius: 45,
    borderWidth: 2,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
    marginRight: SPACING.md,
  },
  previewInnerCircle: {
    width: (width - SPACING.md * 3 - SPACING.sm * 5) / 4,
    height: (width - SPACING.md * 3 - SPACING.sm * 5) / 4,
    borderRadius: 50,
    backgroundColor: COLORS.white,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewInnerCircleGray: {
    width: (width - SPACING.md * 3 - SPACING.sm * 5) / 4,
    height: (width - SPACING.md * 3 - SPACING.sm * 5) / 4,
    borderRadius: 50,
    backgroundColor: COLORS.gray[50],
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  eventIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  eventIcon: {
  },
  trendingProductsContainer: {
    paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
  },
  trendingProductCard: {
    width: GRID_CARD_WIDTH,
    paddingHorizontal: SPACING.xs,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    // padding: SPACING.sm,
    // ...SHADOWS.md,
  },
  trendingImageWrap: { position: 'relative' },
  trendingProductImage: {
    width: GRID_CARD_WIDTH - SPACING.sm * 2,
    height: (GRID_CARD_WIDTH - SPACING.sm * 2) * 1.2,
    borderRadius: 8,
    marginBottom: SPACING.sm,
    marginRight: 0,
  },
  discountBadge: {
    position: 'absolute',
    left: 8,
    top: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  discountText: { color: COLORS.white, fontSize: 10, fontWeight: '700' },
  trendingHeartBtn: {
    position: 'absolute',
    right: 8,
    bottom: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.white,
  },
  trendingHeartBtnActive: {
    position: 'absolute',
    right: 8,
    bottom: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    // backgroundColor: COLORS.red,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.white,
  },
  trendingProductInfo: {
    flex: 1,
  },
  trendingProductName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '500',
    color: COLORS.text.primary,
    marginBottom: 4,
  },
  trendingProductPrice: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.primary,
    marginBottom: 4,
  },
  trendingProductRating: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
   newInGridContainer: {
    width: '100%',
    paddingHorizontal: SPACING.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: SPACING.sm,
   },
   newInGridCard: {
     width: GRID_CARD_WIDTH,
     marginBottom: SPACING.md,
     backgroundColor: COLORS.white,
     borderRadius: 12,
   },
   newInGridImage: {
     width: GRID_CARD_WIDTH - SPACING.sm * 2,
     height: (GRID_CARD_WIDTH - SPACING.sm * 2) * 1.2,
     borderRadius: 8,
     marginBottom: SPACING.sm,
   },
  ratingText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '500',
    marginLeft: 4,
  },
  soldText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '500',
    marginLeft: 8,
  },
  playIconContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },

  scrollToTopButton: {
    position: 'absolute',
    right: SPACING.lg,
    bottom: 100,
    zIndex: 999,
  },
  scrollToTopTouchable: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.lg,
    elevation: 8,
  },
  popularCategoriesTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.md,
    gap: SPACING.xs,
    justifyContent: 'center',
  },
  popularText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '900',
    color: COLORS.red,
  },
  categoriesText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '900',
    color: COLORS.text.primary,
  },
  fireIcon: {
    fontSize: FONTS.sizes.xl,
  },
  popularCategoriesContainer: {
    flexDirection: 'column',
    flexWrap: 'wrap',
    paddingHorizontal: SPACING.sm,
    gap: SPACING.sm,
    width: '100%',
  },
  popularCategoriesSubContainer: {
    flexDirection: 'column', 
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    width: '100%',
  },
  popularCategoryImageContainer: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  popularCategoryItem: {
    alignItems: 'center',
    // marginBottom: SPACING.md,
  },
  popularCategoryImage: {
    resizeMode: 'contain',
    borderRadius: BORDER_RADIUS.md,
    // marginBottom: SPACING.xs,
  },
  popularCategoryPlatform: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '600',
    color: COLORS.text.red,
    marginTop: SPACING.sm,
    marginVertical: SPACING.xs / 2,
    textAlign: 'left',
  },
  popularCategoryName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '500',
    color: COLORS.text.primary,
    textAlign: 'center',
  },
  promoCardsContainer: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    gap: SPACING.md,
  },
  promoCard: {
    height: 280,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  promoCardBackground: {
    width: '100%',
    height: '100%',
    position: 'absolute',
  },
  promoCardGradientContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
  },
  promoCardInner: {
    position: 'absolute',
    top: 60,
    left: '50%',
    marginLeft: -(width - SPACING.md * 4) / 2, // Half of width (240/2)
    width: width - SPACING.md * 4,
    height: 160,
    backgroundColor: 'transparent',
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.white,
  },
  promoCardContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: SPACING.md,
    justifyContent: 'space-between',
  },
  promoCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  promoCardTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.white,
  },
  promoCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 0.5,
    borderTopColor: '#FFFFFF33',
  },
  promoCardText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.white,
    flex: 1,
  },
  promoCardButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    // backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: SPACING.sm,
  },

  // Live Channel Section Styles
  liveChannelContainer: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  liveChannelCard: {
    // flex: 0.6,
    height: 210,
    borderRadius: BORDER_RADIUS.md,
    overflow: 'hidden',
    backgroundColor: '#FFD9B3',
    position: 'relative',
    width: 163,
  },
  liveChannelImageCarousel: {
    // position: 'absolute',
    // width: '100%',
    // height: '100%',
  },
  liveChannelBackgroundImage: {
    width: 163,
    height: 210,
  },
  liveChannelOverlay: {
    position: 'absolute',
    width: '100%',
    height: '50%',
    borderRadius: BORDER_RADIUS.md,
  },
  liveChannelContent: {
    position: 'absolute',
    width: '100%',
    height: '100%',
    padding: SPACING.smmd,
    justifyContent: 'space-between',
  },
  liveIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  liveIcon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#FF0000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  liveIconText: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '900',
    color: COLORS.black,
    width: '50%',
  },
  liveChannelTextContainer: {
    marginBottom: SPACING.sm,
  },
  liveChannelTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '900',
    color: COLORS.black,
    lineHeight: Math.round(FONTS.sizes.xl * 20 / 20),
  },
  liveChannelSubtitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '900',
    color: '#FF0000',
    marginBottom: SPACING.sm,
  },
  watchNowButton: {
    alignSelf: 'flex-start',
    borderRadius: BORDER_RADIUS.md,
  },
  watchNowButtonText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.black,
  },
  livePaginationContainer: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderColor: COLORS.white,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: SPACING.xs,
    paddingVertical: SPACING.xs / 2,
    backgroundColor: '#0000001A',
  },
  livePaginationContainerFixed: {
    flexDirection: 'row',
    // justifyContent: 'center',
    // alignItems: 'center',
    // paddingVertical: SPACING.xs,
  },
  livePagination: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  promosRightStack: {
    // flex: 0.4,
    gap: SPACING.sm,
    justifyContent: 'space-between',    
    width: '100%',
  },
  liveChannelPromoCard: {
    flex: 1,
    borderRadius: BORDER_RADIUS.md,
    // padding: SPACING.sm,
    justifyContent: 'space-between',
    overflow: 'hidden',
  },
  promoCardTopRowContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
    width: '100%',
  },
  promoCardTopRowIcon: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
    width: '50%',
    paddingTop: SPACING.sm,
    paddingLeft: SPACING.sm,
  },
  promoCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    marginBottom: SPACING.smmd,
  },
  promoCardIcon: {
    fontSize: FONTS.sizes.xs,
  },
  promoCardTitleSmall: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
    color: COLORS.black,
    flex: 1,
  },
  promoCardImages: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginBottom: SPACING.xs,
    flex: 1,
  },
  promoCardSmallImage: {
    width: 44,
    height: 44,
    borderRadius: BORDER_RADIUS.sm,
  },
  promoCardPriceTag: {
    borderRadius: BORDER_RADIUS.sm,
    overflow: 'hidden',
  },
  promoCardPrice: {
    backgroundColor: COLORS.red,
    position: 'absolute',
    bottom: 0,
    width: 85,
    textAlign: 'center',
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
    color: COLORS.white,
    borderBottomLeftRadius: BORDER_RADIUS.sm,
    borderBottomRightRadius: BORDER_RADIUS.sm,
  },

  todaysDealsContainer: {
    // paddingHorizontal: SPACING.md,
    // paddingVertical: SPACING.md,
  },
  todaysDealsSectionTitle: {
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '800',
    color: COLORS.text.primary,
    marginBottom: SPACING.lg,
    textAlign: 'center',
  },
  todaysDealsBlock: {
    marginBottom: SPACING.lg,
    // backgroundColor: COLORS.background,
    position: 'relative',
  },
  todaysDealsBlockTitleContainer: {
    left: 10,
    height: 1,
    width: 100,
    zIndex: 2,
    borderTopWidth: 5,
    // borderTopColor: 'rgba(255, 47, 47, 0.5)',
    padding: SPACING.md,
    maxHeight: 5,
    position: 'absolute',
  },
  todaysDealsBlockTitle: {
    fontSize: FONTS.sizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
    marginTop: SPACING.md,
    marginLeft: SPACING.sm,
  },
  todaysDealsBlockSubtitle: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '400',
    marginBottom: SPACING.sm,
    marginLeft: SPACING.sm,
  },
  todaysDealsProductsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm,
  },
  todaysDealsProductWrap: {
    width: GRID_CARD_WIDTH,
    zIndex: 2,
    gap: SPACING.xs,
  },
  // Live Hot Item card
  liveHotCardGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    padding: SPACING.xs,
    height: 210,
    zIndex: 1,
  },
  liveHotLiveRow: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    alignSelf: 'flex-start',
    gap: 4,
    marginBottom: SPACING.xs,
    width: GRID_CARD_WIDTH,
    borderRadius: 8,
    position: 'absolute',
    overflow: 'hidden',
    bottom: -4,
  },
  liveHotLiveRowIconContainer: {
    flexDirection: 'row',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    alignItems: 'center',
    gap: 4,
  },
  liveHotLiveRowIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.black,
    borderRadius: BORDER_RADIUS.full,
  },
  liveHotLiveRowIconInner: {
    width: 24,
    height: 18,
    backgroundColor: '#FF0000',
    borderRadius: BORDER_RADIUS.full,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveHotLiveText: {
    fontSize: 10,
    fontWeight: '900',
    color: COLORS.white,
    marginRight: SPACING.xs,
  },
  liveHotPointBtn: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: '#FF0000',
    borderRadius: 8,
  },
  liveHotPointBtnText: {
    fontSize: 10,
    fontWeight: '900',
    color: COLORS.white,
  },
  liveHotImage: {
    width: GRID_CARD_WIDTH,
    height: GRID_CARD_WIDTH,
    aspectRatio: 1,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[200],
  },
  liveHotLiveRowUserContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: '#00000080',
    width: '100%',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomLeftRadius: BORDER_RADIUS.md,
    borderBottomRightRadius: BORDER_RADIUS.md,
  },
  liveHotUserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.xs,
    gap: 6,
    width: GRID_CARD_WIDTH,
    position: 'relative',
    overflow: 'hidden',
  },
  liveHotAvatar: {
    width: 32,
    height: 32,
    borderRadius: BORDER_RADIUS.full,
    // backgroundColor: COLORS.white,
  },
  liveHotUserNameContainer: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  liveHotUserName: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    fontWeight: '700',
    color: COLORS.white,
  },
  liveHotViews: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '400',
    color: '#AAAAAA',
  },
  liveHotProductName: {
    fontSize: 12,
    color: COLORS.text.primary,
    marginTop: 4,
    width: GRID_CARD_WIDTH,
  },
  liveHotPrice: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.red,
    marginTop: 2,
    width: GRID_CARD_WIDTH,
  },
  // Today's Hot Deals / Best Sellers product card
  dealProductCard: {
    width: GRID_CARD_WIDTH,
    borderRadius: BORDER_RADIUS.md,
    overflow: 'hidden',
  },
  dealProductImageWrap: {
    width: GRID_CARD_WIDTH,
    flex: 1,
    flexDirection: 'row',
    position: 'relative',
  },
  dealProductBadge: {
    width: GRID_CARD_WIDTH,
    position: 'absolute',
    bottom: 0,
    left: 0,
    zIndex: 2,
  },
  dealProductImage: {
    width: GRID_CARD_WIDTH,
    aspectRatio: 1,
    borderRadius: BORDER_RADIUS.md,
  },
  dealProductName: {
    fontSize: 12,
    color: COLORS.text.primary,
    marginTop: SPACING.xs,
    paddingHorizontal: 2,
  },
  dealProductPrice: {
    fontSize: 20,
    fontWeight: '900',
    color: COLORS.red,
    marginTop: 2,
    paddingHorizontal: 2,
    paddingBottom: SPACING.xs,
  },
  todaysItemsContainer: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  todaysItemsTitle: {
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '800',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  todaysItemsCards: {
    gap: SPACING.md,
  },
  todaysItemCard: {
    height: 240,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  todaysItemCardBackground: {
    width: '100%',
    height: '100%',
    position: 'absolute',
  },
  todaysItemGradientContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: BORDER_RADIUS.lg,
    overflow: 'hidden',
  },
  todaysItemImagesContainer: {
    position: 'absolute',
    top: 65,
    left: SPACING.md,
    right: SPACING.md,
    height: width - SPACING.md * 2,
    borderRadius: BORDER_RADIUS.md,
    overflow: 'hidden',
  },
  todaysItemImagesGrid2x2: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.smmd,
  },
  todaysItemImagesRow: {
    flexDirection: 'row',
    gap: SPACING.smmd,
  },
  todaysItemImage: {
    borderRadius: BORDER_RADIUS.lg,
  },
  todaysItemImage2x2: {
    width: (width - SPACING.md * 4 - SPACING.smmd) / 2,
    height: (width - SPACING.md * 4) / 2,
  },
  todaysItemImageRow: {
    flex: 1,
    height: (width - SPACING.md * 4) / 2,
  },
  todaysItemContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: SPACING.md,
    justifyContent: 'space-between',
  },
  todaysItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  todaysItemTitle: {
    fontSize: FONTS.sizes['2xl'],
    fontWeight: '700',
    color: COLORS.white,
  },
  todaysItemFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#FFFFFF33',
  },
  todaysItemText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.white,
    flex: 1,
  },
  todaysItemButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    // backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: SPACING.sm,
  },
  moreToLoveFooter: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    gap: SPACING.sm,
  },
  moreToLoveFooterText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },

  /* ---------- User Order Summary card (login-only) ---------- */
  uosOuter: {
    marginHorizontal: HOME_GUTTER,
    marginTop: SPACING.md,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.xl,
    borderWidth: 1.5,
    borderColor: LOGISTICS_ORANGE,
    backgroundColor: '#FFF6F0',
  },
  uosUserHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: SPACING.sm,
  },
  uosAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.red,
  },
  uosAvatarFallback: {
    backgroundColor: COLORS.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  uosAvatarFallbackText: {
    color: COLORS.white,
    fontSize: 20,
    fontWeight: '800',
  },
  uosUserNameCol: {
    flex: 1,
    marginLeft: SPACING.sm,
    minWidth: 0,
  },
  uosUserName: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '800',
    color: COLORS.black,
  },
  uosUserMember: {
    marginTop: 2,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  uosInquiryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: 6,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    gap: 4,
  },
  uosInquiryText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  uosOrderBlock: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.sm,
    marginTop: SPACING.sm,
  },
  uosOrderBlockSpacer: {
    marginTop: SPACING.sm,
  },
  uosProductRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  uosProductImage: {
    width: 60,
    height: 60,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.gray[100],
  },
  uosProductTextCol: {
    flex: 1,
    marginLeft: SPACING.sm,
    minWidth: 0,
  },
  uosProductTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.black,
    lineHeight: Math.round(FONTS.sizes.sm * 1.3),
  },
  uosProductMetaRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  uosProductMetaLeft: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  uosProductPriceCol: {
    alignItems: 'flex-end',
  },
  uosProductPrice: {
    fontSize: FONTS.sizes.md,
    fontWeight: '800',
    color: COLORS.black,
  },
  uosProductPriceStrike: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[400],
    textDecorationLine: 'line-through',
    marginTop: 2,
  },
  uosTrackingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: FIGMA_OVERLAY_05,
  },
  uosTrackingCarrier: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.black,
    fontWeight: '600',
  },
  uosTrackingNumber: {
    color: '#1976D2',
    fontWeight: '700',
  },
  uosCopyButton: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 4,
    borderRadius: BORDER_RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    backgroundColor: COLORS.white,
  },
  uosCopyButtonText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    fontWeight: '600',
  },
  uosStatusBlock: {
    marginTop: SPACING.sm,
  },
  uosStatusHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  uosStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: LOGISTICS_ORANGE,
  },
  uosStatusText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '800',
    color: COLORS.black,
  },
  uosStatusTime: {
    marginLeft: 'auto',
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  uosStatusDetail: {
    marginTop: 4,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.sizes.xs * 16 / 12),
  },
  uosLogisticsMoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.sm,
    gap: 6,
  },
  uosLogisticsMoreCircle: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: COLORS.gray[400],
  },
  uosLogisticsMoreText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  uosAddressBlock: {
    marginTop: SPACING.sm,
  },
  uosAddressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
  },
  uosAddressText: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.black,
    fontWeight: '600',
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
  },
  uosAddressContact: {
    marginTop: 4,
    marginLeft: 20,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  uosViewAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: SPACING.sm,
    marginTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: FIGMA_OVERLAY_05,
    gap: 4,
  },
  uosViewAllText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  uosEmptyState: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginTop: SPACING.sm,
    alignItems: 'center',
  },
  uosEmptyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  uosShortcutsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.md,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 102, 0, 0.15)',
  },
  uosShortcutItem: {
    width: '20%',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
  },
  uosShortcutCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.black,
  },
  uosShortcutLabel: {
    marginTop: 4,
    fontSize: 11,
    color: COLORS.black,
    textAlign: 'center',
  },
});

export default HomeScreen;

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Image,
  TouchableOpacity,
  Dimensions,
  FlatList,
  Modal,
  StatusBar,
  Platform,
  Animated,
  InteractionManager,
  Linking,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import { useRoute, useNavigation } from '@react-navigation/native';
import Icon from '../../components/Icon';
// Removed WebView import - using simpler HTML rendering approach
import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS, SERVER_BASE_URL } from '../../constants';
import { useAuth } from '../../context/AuthContext';

import { ProductCard, SearchButton } from '../../components';
import ProductShareModal from '../../components/ProductShareModal';
import { buildProductSharePageUrl } from '../../utils/productShareLinks';
import { PhotoCaptureModal } from '../../components';
import { usePlatformStore } from '../../store/platformStore';
import {
  productPlatformToCompanyTab,
  resolveProductPlatformKey,
  type ProductPlatformKey,
} from '../../utils/productPlatform';
import { useAppSelector } from '../../store/hooks';
import { ActivityIndicator } from 'react-native';
import { ProductDetailBodySkeleton } from '../../components/Skeleton';
import { openProductDetail } from '../../utils/openProductDetail';
import LazyMount from '../../components/LazyMount';
import RevealOnMount from '../../components/RevealOnMount';
import { useGalleryPrefetch, useViewablePrefetch } from '../../hooks/useImagePrefetch';
import { useStaggeredReveal } from '../../hooks/useStaggeredReveal';
import { Product } from '../../types';
import { useProductDetailMutation } from '../../hooks/useProductDetailMutation';
import { useRelatedRecommendationsMutation } from '../../hooks/useRelatedRecommendationsMutation';
import { useSearchProductsMutation } from '../../hooks/useSearchProductsMutation';
import { useAddToCartMutation } from '../../hooks/useAddToCartMutation';
import { AddToCartRequest, cartApi } from '../../services/cartApi';
import { useTranslation } from '../../hooks/useTranslation';
import { useToast } from '../../context/ToastContext';
import { getLocalizedText } from '../../utils/i18nHelpers';

// 상품상세에서는 중국 위안(¥) 단위로 표기 — 가격값 자체는 위안 기준이며
// 단위 기호만 ₩ → ¥ 로 교체. 천단위 콤마 포맷, 소수점 2자리 유지.
const formatPriceCNY = (price: number): string => {
  const n = Number(price) || 0;
  const [intPart, decPart] = n.toFixed(2).split('.');
  const withComma = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `¥${withComma}.${decPart}`;
};
import {
  isTaobaoPlatform,
  normalizeProductImageUrl,
  normalizeProductImageUrls,
  pickTaobaoGalleryImages,
  productImageUrlsMatch,
} from '../../utils/productImageUrl';
import ProductImage from '../../components/ProductImage';
import { useWishlistStatus } from '../../hooks/useWishlistStatus';
import { useAddToWishlistMutation } from '../../hooks/useAddToWishlistMutation';
import { useDeleteFromWishlistMutation } from '../../hooks/useDeleteFromWishlistMutation';
import { useResponsive } from '../../hooks/useResponsive';
import { productsApi } from '../../services/productsApi';
import HeartPlusIcon from '../../assets/icons/HeartPlusIcon';
import FamilyStarIcon from '../../assets/icons/FamilyStarIcon';
import ArrowBackIcon from '../../assets/icons/ArrowBackIcon';
import CartIcon from '../../assets/icons/CartIcon';
import StarIcon from '../../assets/icons/StarIcon';
import StarHalfIcon from '../../assets/icons/StarHalfIcon';
import StarOutlineIcon from '../../assets/icons/StarOutlineIcon';
import DeliveryIcon from '../../assets/icons/DeliveryIcon';
import ArrowRightIcon from '../../assets/icons/ArrowRightIcon';
import HeartIcon from '../../assets/icons/HeartIcon';
import CameraIcon from '../../assets/icons/CameraIcon';
import SupportAgentIcon from '../../assets/icons/SupportAgentIcon';
import ContentCopyIcon from '../../assets/icons/ContentCopyIcon';
import PlusIcon from '../../assets/icons/PlusIcon';
import MinusIcon from '../../assets/icons/MinusIcon';
import ShareAppIcon from '../../assets/icons/ShareAppIcon';
import CheckIcon from '../../assets/icons/CheckIcon';
import ShoppingCreditsIcon from '../../assets/icons/ShoppingCreditsIcon';
import HomeIcon from '../../assets/icons/HomeIcon';
import SellerShopIcon from '../../assets/icons/SellerShopIcon';
import ImageSearchResultsModal from './searchScreen/ImageSearchResultsModal';
import SearchImageIcon from '../../assets/icons/SearchImageIcon';

const { width } = Dimensions.get('window');
const IMAGE_HEIGHT = 400;

const COLOR_VARIATION_PATTERN = /color|colour|颜色|색상|色彩|顏色/i;

const isColorVariationType = (name: string): boolean =>
  COLOR_VARIATION_PATTERN.test(name);

/** SKU swatch for a specific variation value (e.g. color), normalized like the main gallery */
const pickSkuImageForVariation = (
  variant: any,
  typeName: string,
  value: string,
): string => {
  const typeLower = typeName.toLowerCase().trim();
  const attrs = variant.attributes || variant.skuAttributes || [];
  const matchingAttr = attrs.find((a: any) => {
    const attrName = String(
      a.attributeNameTrans || a.attributeName || a.prop_name || '',
    )
      .toLowerCase()
      .trim();
    const attrValue = String(
      a.valueTrans || a.value || a.value_name || a.value_desc || '',
    ).trim();
    const nameMatches =
      attrName === typeLower ||
      (Boolean(attrName && typeLower) &&
        (attrName.includes(typeLower) || typeLower.includes(attrName)));
    return nameMatches && attrValue === value;
  });
  const candidate =
    matchingAttr?.skuImageUrl ||
    matchingAttr?.image ||
    (isColorVariationType(typeName)
      ? attrs.find((a: any) => a.skuImageUrl)?.skuImageUrl
      : undefined) ||
    variant.image;
  return normalizeProductImageUrl(candidate || '');
};

const pickVariantRowImage = (sku: any, galleryFirst: string): string => {
  const attrs = sku.skuAttributes || sku.attributes || [];
  const colorAttr = attrs.find((a: any) =>
    COLOR_VARIATION_PATTERN.test(
      String(a.attributeNameTrans || a.attributeName || a.prop_name || ''),
    ),
  );
  const anySkuImage = attrs.find((a: any) => a.skuImageUrl);
  return normalizeProductImageUrl(
    colorAttr?.skuImageUrl || anySkuImage?.skuImageUrl || galleryFirst,
  );
};

type ProductDetailScreenProps = {
  embedded?: boolean;
  embeddedProductId?: string;
  embeddedSource?: string;
  embeddedCountry?: string;
  onEmbeddedBack?: () => void;
};

const ProductDetailScreen: React.FC<ProductDetailScreenProps> = ({
  embedded = false,
  embeddedProductId,
  embeddedSource,
  embeddedCountry,
  onEmbeddedBack,
}) => {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const routeParams = route.params || {};
  const {
    productId: routeProductId,
    offerId,
    productData: initialProductData,
    source: paramSource,
    country: paramCountry,
    thumbnailUrl: routeThumbnailUrl,
  } = routeParams;
  const productId = embedded ? embeddedProductId : routeProductId;
  const routeSource = embedded ? embeddedSource : paramSource;
  const routeCountry = embedded ? embeddedCountry : paramCountry;

  const handleBack = () => {
    if (embedded && onEmbeddedBack) {
      onEmbeddedBack();
      return;
    }
    navigation.goBack();
  };
  // console.log("[ProductDetailScreen] routeSource:", routeSource);
  
  // ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS OR HOOKS THAT USE THEM
  // Get platform and locale (defined early so they can be used in callbacks)
  const { selectedPlatform, setSelectedPlatform } = usePlatformStore();
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const { t } = useTranslation();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const responsive = useResponsive();
  
  // Use wishlist status hook to check if products are liked based on external IDs
  const { isProductLiked, refreshExternalIds, addExternalId, removeExternalId } = useWishlistStatus();
  const { user, isAuthenticated } = useAuth();
  
  // Use refs to track values (defined early)
  const sourceRef = useRef<string>('1688');
  const countryRef = useRef<string>('en');
  const hasFetchedProductRef = useRef<string | null>(null);

  // Keep refs in sync with route params / store so fetch calls use correct source/country
  useEffect(() => {
    // Prefer explicit route params when provided, otherwise fallback to selectedPlatform/locale
    const rawSource = (route.params?.source as string) || selectedPlatform || '1688';
    sourceRef.current = (rawSource === 'live-commerce' || rawSource === 'companymall' || rawSource === 'myCompany' || rawSource?.toLowerCase() === 'mycompany') ? 'ownmall' : rawSource;
    // Backend rejects `country=zh` on /products/detail and recommendations
    // endpoints (HTTP 500), so we collapse 'zh' → 'en' everywhere this ref
    // is used. The upstream `subject` field already carries the original
    // Chinese text, so Chinese users still see Chinese product titles.
    const rawCountry = (route.params?.country as string) || locale;
    countryRef.current = rawCountry === 'ko' ? 'ko' : 'en';
  }, [route.params?.source, route.params?.country, selectedPlatform, locale]);
  
  // Use product data from navigation params if available, otherwise fetch
  const [product, setProduct] = useState<any>(initialProductData || null);
  const [loading, setLoading] = useState(!initialProductData);
  const [wishlistCount, setWishlistCount] = useState<number | null>(null);
  // If this product already exists in the user's cart, the backend's GET
  // /cart response gives us the EXACT shape it expects on POST /cart for
  // the same offerId (correct {en,ko,zh} `companyName`, `subjectMultiLang`,
  // `categoryName`, the canonical `imageUrl` without size suffix, …).
  // We keep it here and use it as the source of truth when building the
  // add-to-cart payload, bypassing all the lossy product-detail parsing
  // that has been producing Korean text in the `zh` slot.
  const [existingCartItem, setExistingCartItem] = useState<any | null>(null);
  // (Removed: `companyNameZhCache` used to be populated by a secondary
  //  `lang=zh` product-detail fetch, but the backend returns HTTP 500
  //  for `country=zh`, so that fetch was removed. The Chinese company
  //  name now comes exclusively from the existing-cart-row override or
  //  from `_rawCompanyNameCandidates` collected during the primary fetch.)

  // Scroll-based header animation
  const scrollY = useRef(new Animated.Value(0)).current;
  const HEADER_SCROLL_THRESHOLD = 80;
  const headerBg = scrollY.interpolate({
    inputRange: [0, HEADER_SCROLL_THRESHOLD],
    outputRange: ['rgba(255,255,255,0)', COLORS.white],
    extrapolate: 'clamp',
  });
  const searchBarOpacity = scrollY.interpolate({
    inputRange: [HEADER_SCROLL_THRESHOLD * 0.5, HEADER_SCROLL_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const cameraIconOpacity = scrollY.interpolate({
    inputRange: [0, HEADER_SCROLL_THRESHOLD * 0.5],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  // Image search state
  const [shareModalVisible, setShareModalVisible] = useState(false);
  const [similarSearchVisible, setSimilarSearchVisible] = useState(false);
  const [similarSearchBase64, setSimilarSearchBase64] = useState<string>('');
  const [similarSearchUri, setSimilarSearchUri] = useState<string>('');
  const [isFetchingBase64, setIsFetchingBase64] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const imageGalleryScrollRef = useRef<ScrollView>(null);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  const [selectedVariations, setSelectedVariations] = useState<Record<string, string>>({});
  // Initialize quantity with minOrderQuantity if available, otherwise 1
  const [quantity, setQuantity] = useState(() => {
    const minOrderQty = initialProductData?.minOrderQuantity;
    return minOrderQty && minOrderQty > 0 ? minOrderQty : 1;
  });
  
  // Add to wishlist mutation (defined after t and showToast)
  const { mutate: addToWishlist } = useAddToWishlistMutation({
    onSuccess: async (data) => {
      showToast(t('product.productAddedToWishlist'), 'success');
      // Immediately refresh external IDs to update heart icon color
      await refreshExternalIds();
      // Refresh wishlist count
      const externalId = product?.offerId || product?.externalId || product?.id || productId || offerId || '';
      const fetchSource = sourceRef.current;
      if (externalId && fetchSource) {
        try {
          const response = await productsApi.getWishlistCount(externalId.toString(), fetchSource);
          if (response.success && response.data) {
            setWishlistCount(response.data.count || 0);
          }
        } catch (error) {
          // console.error('Failed to refresh wishlist count:', error);
        }
      }
    },
    onError: () => {
      showToast(t('product.failedToAddToWishlist'), 'error');
    },
  });

  // Delete from wishlist mutation
  const { mutate: deleteFromWishlist } = useDeleteFromWishlistMutation({
    onSuccess: async (data) => {
      showToast(t('product.productRemovedFromWishlist'), 'success');
      // Immediately refresh external IDs to update heart icon color
      await refreshExternalIds();
      // Refresh wishlist count
      const externalId = product?.offerId || product?.externalId || product?.id || productId || offerId || '';
      const fetchSource = sourceRef.current;
      if (externalId && fetchSource) {
        try {
          const response = await productsApi.getWishlistCount(externalId.toString(), fetchSource);
          if (response.success && response.data) {
            setWishlistCount(response.data.count || 0);
          }
        } catch (error) {
          // console.error('Failed to refresh wishlist count:', error);
        }
      }
    },
    onError: () => {
      showToast(t('product.failedToRemoveFromWishlist'), 'error');
    },
  });
  
  // Add to cart mutation (for Add to Cart button)
  const { mutate: addToCart, isLoading: isAddingToCart } = useAddToCartMutation({
    onSuccess: () => {
      showToast(t('product.addedToCart'), 'success');
    },
    onError: (error) => {
      // console.error('Failed to add product to cart:', error);
      showToast(error || t('product.failedToAdd'), 'error');
    },
  });
  
  const resolveText = (value: unknown): string => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null && ('en' in value || 'ko' in value || 'zh' in value)) {
      const o = value as Record<string, string>;
      return getLocalizedText({ en: o.en ?? '', ko: o.ko ?? '', zh: o.zh ?? '' }, locale);
    }
    return String(value);
  };

  /**
   * Resolve the company name for DISPLAY in the user's UI locale.
   *
   * Walks every possible upstream location (multilang objects, raw
   * candidates collected during product-detail mapping, seller.name)
   * and returns the slot that matches the current `locale`. When the
   * requested locale's slot is missing — common because the backend
   * rejects `country=zh` so the zh slot is rarely populated for the
   * Chinese UI — we fall through this priority order:
   *
   *   1. Exact `locale` slot in any multilang object.
   *   2. Any candidate string whose character set matches the locale
   *      (Chinese ideographs for 'zh', Hangul for 'ko', ASCII for 'en').
   *   3. Any non-empty multilang slot (en → ko → zh → other).
   *   4. `seller.name` (already locale-resolved via `resolveText`).
   *   5. Literal 'Store' as a last-resort placeholder.
   *
   * The character-set match in step 2 is what makes Chinese UI users
   * see "临沂彩屹商贸有限公司" even when the backend only sent the
   * English `{ en: "..." }` slot — we pick up the original Chinese
   * name from `_rawCompanyNameCandidates` (e.g. `subject` field,
   * `metadata.original1688Data.companyName`).
   */
  const resolveCompanyDisplayName = (): string => {
    if (!product) return '';
    const containsChinese = (s: string) => /[一-鿿]/.test(s);
    const containsHangul = (s: string) => /[가-힯ᄀ-ᇿ㄰-㆏]/.test(s);

    const localeMatches = (s: string, target: 'en' | 'ko' | 'zh'): boolean => {
      if (target === 'zh') return containsChinese(s);
      if (target === 'ko') return containsHangul(s);
      // 'en' → require NEITHER Chinese nor Hangul (Latin / ASCII text).
      return !containsChinese(s) && !containsHangul(s);
    };

    const targetLocale: 'en' | 'ko' | 'zh' =
      locale === 'zh' || locale === 'ko' ? (locale as 'zh' | 'ko') : 'en';

    // 1) Direct multilang objects on the product.
    const multilangSources: unknown[] = [
      (product as any).companyName,
      (product as any).companyNameMultiLang,
      (product as any).metadata?.original1688Data?.companyNameMultiLang,
    ];
    for (const src of multilangSources) {
      if (src && typeof src === 'object') {
        const obj = src as Record<string, unknown>;
        const slot = obj[targetLocale];
        if (typeof slot === 'string' && slot.trim()) return slot.trim();
      }
    }

    // 2) Candidate strings — find one matching the target locale.
    const candidates: unknown[] = (product as any)._rawCompanyNameCandidates || [];
    // Also include common direct paths that may not be in the array.
    // `originalCompanyName` is the backend field that carries the
    // ORIGINAL Chinese name; prioritise it for the Chinese display.
    candidates.push(
      (product as any).originalCompanyName,
      (product as any).metadata?.original1688Data?.companyName,
      (product as any).metadata?.original1688Data?.shopName,
      (product as any).original1688Data?.companyName,
      product.seller?.name,
    );
    for (const cand of candidates) {
      if (typeof cand !== 'string') continue;
      const text = cand.trim();
      if (!text) continue;
      if (localeMatches(text, targetLocale)) return text;
    }

    // 3) Any non-empty slot in the multilang objects (locale fallback).
    for (const src of multilangSources) {
      if (src && typeof src === 'object') {
        const obj = src as Record<string, unknown>;
        for (const key of ['en', 'ko', 'zh'] as const) {
          const slot = obj[key];
          if (typeof slot === 'string' && slot.trim()) return slot.trim();
        }
      }
    }

    // 4) Any candidate string at all (regardless of character set).
    for (const cand of candidates) {
      if (typeof cand === 'string' && cand.trim()) return cand.trim();
    }

    // 5) Last-resort placeholder.
    return resolveText(product.seller?.name ?? '') || 'Store';
  };

  const navigateToCartAfterBuyNow = useCallback(
    (cartResponse: { cart?: { items?: any[] } }) => {
      const cartItems = cartResponse?.cart?.items || [];
      const productIdForUrl = product?.offerId || product?.id || productId || offerId || '';
      const addedCartItem =
        cartItems.find(
          (item: any) =>
            item.offerId?.toString() === productIdForUrl.toString() ||
            item.productId?.toString() === productIdForUrl.toString(),
        ) || (cartItems.length > 0 ? cartItems[cartItems.length - 1] : undefined);

      navigation.navigate('Main', {
        screen: 'Cart',
        params: {
          fromBuyNow: true,
          openOrderModal: true,
          cartResponse,
          selectCartItemId: addedCartItem?._id,
          offerId: productIdForUrl.toString(),
        },
      } as never);
    },
    [navigation, offerId, product, productId],
  );

  const { mutate: addToCartForBuyNow, isLoading: isBuyingNow } = useAddToCartMutation({
    onSuccess: (data) => {
      showToast(t('product.addedToCart'), 'success');
      const cartPayload = data?.cart ? data : { cart: data };
      navigateToCartAfterBuyNow(cartPayload);
    },
    onError: (error) => {
      showToast(error || t('product.failedToProceed'), 'error');
    },
  });

  // Toggle wishlist function
  const toggleWishlist = async (product: any) => {
    if (!user || !isAuthenticated) {
      showToast(t('home.pleaseLogin'), 'warning');
      return;
    }

    // Get product external ID - prioritize externalId, never use MongoDB _id
    const externalId = 
      (product as any).externalId?.toString() ||
      (product as any).offerId?.toString() ||
      '';

    if (!externalId) {
      showToast(t('product.invalidProductId'), 'error');
      return;
    }

    const isLiked = isProductLiked(product);
    const source = (product as any).source || selectedPlatform || '1688';
    const country = locale;

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
        showToast(t('product.invalidProductData'), 'error');
        return;
      }

      // Optimistic update - add to state and AsyncStorage immediately
      await addExternalId(externalId);
      addToWishlist({ offerId: externalId, platform: source });
    }
  };

  // Handle follow/unfollow store
  const handleFollowStore = async () => {
    if (!user || !isAuthenticated) {
      showToast(t('home.pleaseLogin'), 'warning');
      // navigation.navigate()
      return;
    }

    if (isStoreFollowed) {
      // Show unfollow confirmation modal
      setShowUnfollowModal(true);
    } else {
      // Follow directly
      await performFollowAction();
    }
  };

  const performFollowAction = async () => {
    setIsFollowingStore(true);
    try {
      // Locale-aware company name (see `resolveCompanyDisplayName` above).
      const companyName = resolveCompanyDisplayName() || 'Store';

      // Get shop ID and name
      const shopId = product.seller?.id || (product as any).sellerOpenId || '';
      const shopName = companyName;
      
      // Get platform
      const platform = source === 'taobao' ? 'taobao' : '1688';
      
      // Get up to 2 products from the current product
      const products = [
        {
          offerId: product.offerId || product.id || '',
          title: product.name || product.subject || '',
          imageUrl: product.image || product.images?.[0] || '',
          price: product.price || 0,
        }
      ];
      
      const response = await productsApi.followStoreWithProducts(shopId, shopName, products, platform);
      
      if (response.success) {
        setIsStoreFollowed(true);
        showToast(t('live.storeFollowedSuccessfully'), 'success');
      } else {
        showToast(response.message || t('live.failedToFollowStore'), 'error');
      }
    } catch (error) {
      showToast(t('live.failedToFollowStore'), 'error');
    } finally {
      setIsFollowingStore(false);
    }
  };

  const performUnfollowAction = async () => {
    setIsFollowingStore(true);
    try {
      const shopId = product.seller?.id || (product as any).sellerOpenId || '';
      const platform = source === 'taobao' ? 'taobao' : '1688';
      
      const response = await productsApi.toggleFollowStore(shopId, platform, 'unfollow');
      
      if (response.success) {
        setIsStoreFollowed(false);
        showToast(t('live.storeUnfollowedSuccessfully'), 'success');
      } else {
        showToast(response.message || t('live.failedToUnfollowStore'), 'error');
      }
    } catch (error) {
      showToast(t('live.failedToUnfollowStore'), 'error');
    } finally {
      setIsFollowingStore(false);
      setShowUnfollowModal(false);
    }
  };
  
  // Additional state declarations - MUST be before any hooks that use them
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [showFullSpecifications, setShowFullSpecifications] = useState(false);
  // Window count for HTML-description images. Starts at 5 so the initial
  // mount of `renderProductDetails` only touches 5 <ProductImage>'s even
  // when the API returned 30+. A timer (in a useEffect below) grows this
  // by 5 every ~250ms so the rest fill in without blocking the first paint,
  // and the user can also tap "Show more" to jump straight to all of them.
  const [descriptionImagesShown, setDescriptionImagesShown] = useState(5);
  const [currentStatIndex, setCurrentStatIndex] = useState(0);
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [viewerImageIndex, setViewerImageIndex] = useState(0);
  const [isCopied, setIsCopied] = useState(false);
  const [photoCaptureVisible, setPhotoCaptureVisible] = useState(false);
  const [relatedProducts, setRelatedProducts] = useState<Product[]>([]);
  const [relatedProductsPage, setRelatedProductsPage] = useState(1);
  const [relatedProductsHasMore, setRelatedProductsHasMore] = useState(true);
  const [similarProducts, setSimilarProducts] = useState<Product[]>([]);
  const [similarProductsPage, setSimilarProductsPage] = useState(1);
  const [similarProductsHasMore, setSimilarProductsHasMore] = useState(true);
  const [similarProductsLoadingMore, setSimilarProductsLoadingMore] = useState(false);
  const isFetchingSimilarProductsRef = useRef(false);
  const loadedPagesRef = useRef<Set<number>>(new Set());
  const [isStoreFollowed, setIsStoreFollowed] = useState(false);
  const [isFollowingStore, setIsFollowingStore] = useState(false);
  const [showUnfollowModal, setShowUnfollowModal] = useState(false);

  // Use source from route params if available, otherwise use selectedPlatform
  // Memoize to prevent infinite loops - only depend on route params, not store values
  const source = useMemo(() => {
    const raw = routeSource || selectedPlatform || '1688';
    // Normalize ownmall-family sources
    if (raw === 'live-commerce' || raw === 'companymall' || raw === 'myCompany' || raw?.toLowerCase() === 'mycompany') return 'ownmall';
    return raw;
  }, [routeSource, selectedPlatform]);
  const country = useMemo(() => routeCountry || locale, [routeCountry, locale]);

  const productPlatformKey = useMemo((): ProductPlatformKey => {
    const raw =
      (product as any)?.source ||
      routeSource ||
      sourceRef.current ||
      selectedPlatform ||
      '1688';
    return resolveProductPlatformKey(raw);
  }, [product, routeSource, selectedPlatform]);

  const topCategoryLabel = useMemo(() => {
    const i18nKey = productPlatformKey === 'taobao' ? 'taobao' : '1688';
    return t(`home.platforms.${i18nKey}`);
  }, [productPlatformKey, t]);

  const handleOpenPlatformCategory = useCallback(() => {
    // 1688 플랫폼인 경우 — 외부 1688 상품 상세 페이지를 브라우저로 연다.
    // offerId 우선순위: product.offerId → product.id → product.externalId →
    // route 의 productId → route 의 offerId.
    // 숫자만 추출하여 1688 의 offer URL 패턴에 정확히 맞춘다 (offerId 는
    // 항상 숫자 ID).
    if (productPlatformKey === '1688') {
      const rawId =
        (product as any)?.offerId ??
        (product as any)?.id ??
        (product as any)?.externalId ??
        productId ??
        offerId ??
        '';
      const numericId = String(rawId).replace(/[^0-9]/g, '');
      if (numericId) {
        const url = `https://detail.1688.com/offer/${numericId}.html?offerId=${numericId}`;
        Linking.openURL(url).catch(() => {
          // 브라우저 오픈 실패 시 fallback — 기존 카테고리 이동으로 대체.
          const companyTab = productPlatformToCompanyTab(productPlatformKey);
          setSelectedPlatform(productPlatformKey);
          navigation.navigate('Category', { initialCompany: companyTab });
        });
        return;
      }
    }
    const companyTab = productPlatformToCompanyTab(productPlatformKey);
    setSelectedPlatform(productPlatformKey);
    navigation.navigate('Category', { initialCompany: companyTab });
  }, [navigation, offerId, product, productId, productPlatformKey, setSelectedPlatform]);

  // Live stats data - defined before useEffect that uses it
  const liveStats = [
    { icon: 'star', color: '#FFD700', text: '155+ people gave 5-star reviews' },
    { icon: 'cart-outline', color: COLORS.primary, text: '900+ people bought this item' },
    { icon: 'heart-outline', color: COLORS.red, text: '3,000+ people added to cart' },
  ];
  
  // Search products mutation (for Taobao related products) - MUST be before useEffect hooks
  const { mutate: searchProducts, isLoading: searchProductsLoading } = useSearchProductsMutation({
    onSuccess: (data) => {
      if (!data || !data.products || !Array.isArray(data.products)) {
        setRelatedProducts([]);
        setRelatedProductsHasMore(false);
        return;
      }

      // Map search results to Product format
      const mappedProducts: Product[] = data.products.map((item: any) => {
        return {
          id: item.id?.toString() || item.externalId?.toString() || '',
          externalId: item.externalId?.toString() || item.id?.toString() || '',
          offerId: item.offerId?.toString() || item.externalId?.toString() || item.id?.toString() || '',
          name: item.name || item.title || '',
          description: item.description || '',
          images: normalizeProductImageUrls(
            item.images?.length ? item.images : item.image ? [item.image] : [],
          ),
          image: normalizeProductImageUrl(item.image || item.images?.[0] || ''),
          price: item.price || 0,
          originalPrice: item.originalPrice || item.price || 0,
          category: item.category || { id: '', name: '', icon: '', image: '', subcategories: [] },
          subcategory: item.subcategory || { id: '', name: '', icon: '', image: '', subcategories: [] },
          brand: item.brand || '',
          seller: item.seller || { id: '', name: '', avatar: '', rating: 0, reviewCount: 0, isVerified: false, followersCount: 0, description: '', location: '', joinedDate: new Date() },
          rating: item.rating || 0,
          reviewCount: item.reviewCount || 0,
          rating_count: item.rating_count || 0,
          inStock: item.inStock !== undefined ? item.inStock : true,
          stockCount: item.stockCount || 0,
          tags: item.tags || [],
          isNew: item.isNew || false,
          isFeatured: item.isFeatured || false,
          isOnSale: item.isOnSale || false,
          createdAt: item.createdAt || new Date(),
          updatedAt: item.updatedAt || new Date(),
          orderCount: item.orderCount || 0,
          repurchaseRate: item.repurchaseRate || '',
          source: item.source || 'taobao',
        } as Product;
      });

      setRelatedProducts(mappedProducts);
      setRelatedProductsHasMore(
        data.pagination?.pageNo < Math.ceil((data.pagination?.totalRecords || 0) / (data.pagination?.pageSize || 20))
      );
    },
    onError: (error) => {
      // console.error('Failed to search related products:', error);
      setRelatedProducts([]);
      setRelatedProductsHasMore(false);
    },
  });

  // Related recommendations mutation (for non-Taobao products)
  const { mutate: fetchRelatedRecommendations, isLoading: relatedRecommendationsLoading } = useRelatedRecommendationsMutation({
    onSuccess: (data) => {
      if (!data || !data.recommendations) {
        return;
      }

      let mappedProducts: Product[] = [];

      // Non-Taobao related recommendations mapping (1688 and other platforms)
      mappedProducts = data.recommendations.map((rec: any) => ({
          id: rec.offerId?.toString() || '',
          externalId: rec.offerId?.toString() || '',
          offerId: rec.offerId?.toString() || '',
          name: country === 'zh' ? (rec.subject || rec.subjectTrans || '') : (rec.subjectTrans || rec.subject || ''),
          description: '',
          price: parseFloat(rec.priceInfo?.price || 0),
          originalPrice: parseFloat(rec.priceInfo?.price || 0),
          image: rec.imageUrl || '',
          images: rec.imageUrl ? [rec.imageUrl] : [],
          category: {
            id: rec.topCategoryId?.toString() || '',
            name: '',
            icon: '',
            image: '',
            subcategories: [],
          },
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
          reviewCount: 0,
          rating_count: 0,
          inStock: true,
          stockCount: 0,
          tags: [],
          isNew: false,
          isFeatured: false,
          isOnSale: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          orderCount: 0,
          repurchaseRate: '',
          mainVideo: '',
          rawVariants: [],
          attributes: [],
          productSkuInfos: [],
          productSaleInfo: {},
          productShippingInfo: {},
          sellerDataInfo: {},
          minOrderQuantity: 1,
          unitInfo: {},
          categoryId: rec.topCategoryId,
          subject: rec.subject || '',
          subjectTrans: rec.subjectTrans || rec.subject || '',
          promotionUrl: '',
        }));

      setRelatedProducts(mappedProducts);
      setRelatedProductsHasMore(
        data.pagination?.pageNo <
          Math.ceil((data.pagination?.totalRecords || 0) / (data.pagination?.pageSize || 10))
      );
    },
    onError: (error) => {
      // Recommendations are an ancillary section — when the backend
      // returns an error (e.g. 500 from a locale it doesn't support)
      // we silently empty the grid instead of flashing a red toast on
      // top of an otherwise-correct product page. The error is still
      // recorded in __DEV__ logs for diagnostics.
      if (__DEV__) {
        console.warn('🛒 related recommendations failed:', error);
      }
      setRelatedProducts([]);
      setRelatedProductsHasMore(false);
    },
  });

  // Product detail mutation - MUST be called before any useEffect hooks
  const { mutate: fetchProductDetail, isLoading: isFetchingDetail } = useProductDetailMutation({
    onSuccess: (data) => {
      // console.log('📦 [ProductDetailScreen] Product detail fetched successfully:', {
      //   hasData: !!data,
      //   dataKeys: data ? Object.keys(data) : [],
      //   source,
      // });

      // Taobao product detail mapping (use fetch source — route "source" can be stale)
      const fetchSource = sourceRef.current;
      if (isTaobaoPlatform(fetchSource) && data) {
        const taobao = data;

        const images = pickTaobaoGalleryImages(taobao);

        // Build map from sku_id to localized properties if multi_language_info.sku_properties exists
        const localizedSkuPropsMap: Record<string, any[]> = {};
        if (taobao.multi_language_info?.sku_properties && Array.isArray(taobao.multi_language_info.sku_properties)) {
          taobao.multi_language_info.sku_properties.forEach((skuProp: any) => {
            if (skuProp && skuProp.sku_id) {
              localizedSkuPropsMap[skuProp.sku_id.toString()] = skuProp.properties || [];
            }
          });
        }

        // Map SKUs to variants
        const rawVariants = (taobao.sku_list || []).map((sku: any) => {
          const skuId = sku.sku_id?.toString() || '';
          const localizedProps = localizedSkuPropsMap[skuId] || sku.properties || [];

          const name = Array.isArray(localizedProps)
            ? localizedProps
                .map((p: any) => `${p.prop_name || p.propId}: ${p.value_name || p.value_desc || p.valueId}`)
                .join(' / ')
            : '';

          const priceNum = Number(sku.promotion_price ?? sku.price ?? taobao.promotion_price ?? taobao.price ?? 0);
          const price = isNaN(priceNum) ? 0 : priceNum;

          return {
            id: skuId,
            name,
            price,
            stock: sku.quantity || 0,
            image: normalizeProductImageUrl(sku.pic_url || images[0] || ''),
            attributes: localizedProps,
            specId: sku.spec_id || skuId,
            skuId,
          };
        });

        // Map attributes (properties) to simple name/value pairs
        const attributes = (taobao.multi_language_info?.properties || taobao.properties || []).map((attr: any) => ({
          name: attr.prop_name || '',
          value: attr.value_name || '',
        }));

        const priceNum = Number(taobao.promotion_price ?? taobao.price ?? 0);
        const price = isNaN(priceNum) ? 0 : priceNum;

        const mappedProduct = {
          id: taobao.item_id?.toString() || productId?.toString() || '',
          externalId: taobao.item_id?.toString() || '',
          offerId: taobao.item_id?.toString() || '',
          name: taobao.multi_language_info?.title || taobao.title || '',
          description: taobao.description || '',
          images,
          image: images[0] || '',
          price,
          originalPrice: price,
          category: {
            id: taobao.category_id?.toString() || '',
            name: taobao.category_name || '',
            icon: '',
            image: '',
            subcategories: [],
          },
          brand: '',
          seller: {
            id: taobao.shop_id?.toString() || '',
            name: taobao.shop_name || '',
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
          reviewCount: 0,
          rating_count: 0,
          inStock: true,
          stockCount: (taobao.sku_list || []).reduce(
            (sum: number, sku: any) => sum + (sku.quantity || 0),
            0
          ),
          tags: taobao.tags || [],
          isNew: false,
          isFeatured: false,
          isOnSale: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          orderCount: 0,
          repurchaseRate: '',
          // Additional fields to align with 1688 mapping
          mainVideo: '',
          rawVariants,
          attributes,
          productSkuInfos: taobao.sku_list || [],
          productSaleInfo: {},
          productShippingInfo: {},
          sellerDataInfo: {},
          minOrderQuantity: 1,
          unitInfo: {},
          categoryId: taobao.category_id,
          subject: taobao.title || '',
          subjectTrans: taobao.multi_language_info?.title || taobao.title || '',
          promotionUrl: '',
          source: 'taobao',
        };

        setProduct(mappedProduct);
        setLoading(false);

        const currentProductId = productId?.toString() || offerId?.toString() || '';
        if (currentProductId) {
          hasFetchedProductRef.current = currentProductId;
        }
        return;
      }

      // 1688 / default product detail mapping
      if (data && data.product) {
        // Map API response to product format
        const apiProduct = data.product;

        // One-off diagnostic — surface every plausible source of the
        // original Chinese company name in the upstream payload, so we
        // can pick the right path in `buildAddToCartRequest`. Remove
        // once `companyName.zh` is reliably filled.
        if (__DEV__) {
          console.log(
            '🔍 product.companyName probe',
            JSON.stringify({
              companyName: apiProduct?.companyName,
              originalCompanyName: apiProduct?.originalCompanyName,  // ← the key one
              companyNameMultiLang: apiProduct?.companyNameMultiLang,
              sellerLoginId: apiProduct?.sellerLoginId,
              sellerName: apiProduct?.sellerName,
              sellerOpenName: apiProduct?.sellerOpenName,
              shopName: apiProduct?.shopName,
              sellerDataInfo_companyName: apiProduct?.sellerDataInfo?.companyName,
              sellerDataInfo_shopName: apiProduct?.sellerDataInfo?.shopName,
              metadata_keys: apiProduct?.metadata ? Object.keys(apiProduct.metadata) : null,
              original1688Data_companyName: apiProduct?.metadata?.original1688Data?.companyName,
              raw_keys: Object.keys(apiProduct || {}),
            }, null, 2),
          );
        }

        // Extract images from productImage.images
        const images = normalizeProductImageUrls(apiProduct.productImage?.images || []);
        const galleryFirst = images[0] || '';

        // Map SKUs to variants
        const rawVariants = (apiProduct.productSkuInfos || []).map((sku: any) => ({
          id: sku.skuId?.toString() || '',
          name: sku.skuAttributes?.map((attr: any) => 
            `${attr.attributeNameTrans || attr.attributeName}: ${attr.valueTrans || attr.value}`
          ).join(' / ') || '',
          price: parseFloat(sku.price || sku.consignPrice || 0),
          stock: sku.amountOnSale || 0,
          image: pickVariantRowImage(sku, galleryFirst),
          attributes: sku.skuAttributes || [],
          specId: sku.specId || '',
          skuId: sku.skuId?.toString() || '',
        }));
        
        // Map product attributes
        const attributes = (apiProduct.productAttribute || []).map((attr: any) => ({
          name: attr.attributeNameTrans || attr.attributeName,
          value: attr.valueTrans || attr.value,
        }));
        
        // Map product data
        const mappedProduct = {
          id: apiProduct.offerId?.toString() || productId?.toString() || '',
          offerId: apiProduct.offerId?.toString() || '',
          name: resolveText(locale === 'zh' ? (apiProduct.subject || apiProduct.subjectTrans || '') : (apiProduct.subjectTrans || apiProduct.subject || '')),
          description: typeof apiProduct.description === 'string' ? apiProduct.description : '',
          images: images,
          image: images[0] || '',
          price: parseFloat(apiProduct.productSaleInfo?.priceRangeList?.[0]?.price || apiProduct.productSkuInfos?.[0]?.price || 0),
          originalPrice: parseFloat(apiProduct.productSaleInfo?.priceRangeList?.[0]?.price || apiProduct.productSkuInfos?.[0]?.price || 0),
          category: {
            id: apiProduct.categoryId?.toString() || '',
            name: '',
            icon: '',
            image: '',
            subcategories: [],
          },
          brand: '',
          seller: {
            id: apiProduct.sellerOpenId || '',
            name: resolveText(apiProduct.companyName) || '',
            avatar: '',
            rating: parseFloat(apiProduct.sellerDataInfo?.compositeServiceScore || apiProduct.tradeScore || 0),
            reviewCount: 0,
            isVerified: false,
            followersCount: 0,
            description: '',
            location: apiProduct.productShippingInfo?.sendGoodsAddressText || '',
            joinedDate: new Date(),
          },
          rating: parseFloat(apiProduct.tradeScore || 0),
          reviewCount: parseInt(apiProduct.soldOut || '0', 10),
          rating_count: parseInt(apiProduct.soldOut || '0', 10),
          inStock: (apiProduct.productSaleInfo?.amountOnSale || 0) > 0,
          stockCount: apiProduct.productSaleInfo?.amountOnSale || 0,
          tags: [],
          isNew: false,
          isFeatured: false,
          isOnSale: false,
          createdAt: apiProduct.createDate ? new Date(apiProduct.createDate) : new Date(),
          updatedAt: new Date(),
          orderCount: parseInt(apiProduct.soldOut || '0', 10),
          repurchaseRate: apiProduct.sellerDataInfo?.repeatPurchasePercent || '',
          // Additional fields from API
          mainVideo: apiProduct.mainVideo || '',
          rawVariants: rawVariants,
          attributes: attributes,
          productSkuInfos: apiProduct.productSkuInfos || [],
          productSaleInfo: apiProduct.productSaleInfo || {},
          productShippingInfo: apiProduct.productShippingInfo || {},
          sellerDataInfo: apiProduct.sellerDataInfo || {},
          minOrderQuantity: apiProduct.minOrderQuantity || 1,
          unitInfo: apiProduct.productSaleInfo?.unitInfo || {},
          // Additional fields for cart API.
          // IMPORTANT: keep the RAW multi-language objects from the upstream
          // API as well as the flattened/translated strings. The cart
          // backend stores `companyName`/`subjectMultiLang`/`categoryName`
          // as {en, ko, zh} objects (see the known-good response sample),
          // and rejects payloads that send Korean text in the `zh` slot.
          // Without preserving the original Chinese here we'd never be
          // able to fill `companyName.zh` correctly downstream.
          categoryId: apiProduct.categoryId,
          categoryName: apiProduct.categoryName,                      // can be string or {en,ko,zh}
          subject: apiProduct.subject || '',                          // raw upstream (often Chinese)
          subjectTrans: apiProduct.subjectTrans || apiProduct.subject || '',
          subjectMultiLang: apiProduct.subjectMultiLang,              // {en,ko,zh} if present
          companyName: apiProduct.companyName,                        // {en,ko,zh} or string
          companyNameMultiLang: apiProduct.companyNameMultiLang,      // {en,ko,zh} if present
          // Aggressively preserve any field that might hold the ORIGINAL
          // Chinese company name. Different upstream APIs use different
          // keys; `buildAddToCartRequest` will pick the first non-empty
          // one that contains Chinese characters and place it in
          // `companyName.zh`.
          _rawCompanyNameCandidates: [
            // The backend's /products/detail response carries the ORIGINAL
            // Chinese company name in `originalCompanyName` (confirmed by
            // the `🔍 product.companyName probe` log — `raw_keys` includes
            // both "companyName" and "originalCompanyName"). The plain
            // `companyName` field is translated to whatever `country=`
            // we requested, so it cannot be used as the zh source.
            apiProduct.originalCompanyName,
            apiProduct.companyName,
            apiProduct.companyNameMultiLang,
            apiProduct.companyNameOriginal,
            apiProduct.sellerName,
            apiProduct.sellerOpenName,
            apiProduct.shopName,
            apiProduct.sellerDataInfo?.companyName,
            apiProduct.sellerDataInfo?.shopName,
            apiProduct.metadata?.original1688Data?.companyName,
            apiProduct.metadata?.original1688Data?.shopName,
            apiProduct.original1688Data?.companyName,
          ].filter(Boolean),
          // Also stash the original Chinese directly on the product for
          // easy access in display helpers.
          originalCompanyName: apiProduct.originalCompanyName,
          originalSource: apiProduct.originalSource || apiProduct.source,
          promotionUrl: apiProduct.promotionUrl || '',
        };

        setProduct(mappedProduct);
        setLoading(false);
        // Mark this productId as fetched
        const currentProductId = productId?.toString() || offerId?.toString() || '';
        if (currentProductId) {
          hasFetchedProductRef.current = currentProductId;
        }
      }
    },
    onError: (error) => {
      const errorStr = typeof error === 'string' ? error : (error as any)?.message || String(error);
      // console.error('📦 [ProductDetailScreen] Product detail fetch error:', {
      //   error,
      //   errorType: typeof error,
      //   errorMessage: errorStr,
      //   productId,
      //   offerId,
      //   source,
      //   country,
      // });
      setLoading(false);
      // Reset ref on error so we can retry
      hasFetchedProductRef.current = null;
      
      // Check if it's a 404 or "not found" error
      const errorMessage = errorStr.toLowerCase();
      const isNotFound = 
        errorMessage.includes('404') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('no product') ||
        errorMessage.includes('product not found');
      
      if (isNotFound) {
        // Navigate to 404 page after a short delay
        setTimeout(() => {
          navigation.navigate('NotFound', {
            message: t('notFound.productNotFound') || 'The product you are looking for could not be found.',
            title: t('notFound.productTitle') || 'Product Not Found',
          });
        }, 500);
      } else if (!errorMessage.includes('numeric') && !errorMessage.includes('offerid')) {
        showToast(error || t('home.productDetailsError'), 'error');
      }
    },
  });

  // Update quantity when product is loaded/updated with minOrderQuantity
  useEffect(() => {
    if (product?.minOrderQuantity && product.minOrderQuantity > 0) {
      setQuantity(product.minOrderQuantity);
    }
  }, [product?.minOrderQuantity]);

  // Fetch product detail if productId is available and no initialProductData
  // Dedupe key includes locale so a language switch re-fetches with the new language.
  //
  // Important: the backend's `/products/detail` endpoint does NOT accept
  // `country=zh` — it returns HTTP 500 for the Chinese locale. So we
  // collapse `zh` (and any unknown locale) to `en`, which the backend
  // supports and which still returns the original Chinese `subject`
  // alongside the English `subjectTrans`. Chinese UI users will see the
  // original `subject` text, which is more accurate for them anyway.
  const mapCountryForProductDetail = (raw?: string): string => {
    const value = (raw || '').toLowerCase();
    if (value === 'ko' || value === 'en') return value;
    // 'zh', 'kr', '', undefined, etc. all fall through to 'en'.
    return 'en';
  };

  useEffect(() => {
    const requestedCountry = (routeCountry as string) || locale;
    const fetchCountry = mapCountryForProductDetail(requestedCountry);
    if (initialProductData) {
      setProduct(initialProductData);
      setLoading(false);
      const currentProductId = productId?.toString() || offerId?.toString() || '';
      if (currentProductId) {
        hasFetchedProductRef.current = `${currentProductId}|${fetchCountry}`;
      }
    } else {
      const currentProductId = productId?.toString() || offerId?.toString() || '';

      if (currentProductId) {
        const fetchKey = `${currentProductId}|${fetchCountry}`;
        const alreadyFetched = hasFetchedProductRef.current === fetchKey;

        if (!alreadyFetched && !isFetchingDetail) {
          hasFetchedProductRef.current = fetchKey;
          setLoading(true);
          const fetchSource = sourceRef.current;
          fetchProductDetail(currentProductId, fetchSource, fetchCountry);
        } else if (alreadyFetched) {
          setLoading(false);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, offerId, initialProductData, routeSource, routeCountry, locale]);
  
  // Fetch wishlist count when product is loaded.
  // Deferred until after interactions so it never competes with the first
  // paint of the gallery/info sections — the count is a small badge in the
  // bottom bar and can appear a few hundred ms later without being noticed.
  useEffect(() => {
    if (!product) return;

    const handle = InteractionManager.runAfterInteractions(() => {
      const externalId =
        product?.offerId || product?.externalId || product?.id || productId || offerId || '';
      const fetchSource = sourceRef.current;
      if (!externalId || !fetchSource) return;

      productsApi
        .getWishlistCount(externalId.toString(), fetchSource)
        .then((response) => {
          if (response.success && response.data) {
            setWishlistCount(response.data.count || 0);
          } else {
            setWishlistCount(0);
          }
        })
        .catch(() => {
          setWishlistCount(0);
        });
    });

    return () => handle.cancel?.();
  }, [product, productId, offerId, routeSource]);

  // Fetch the current cart once the product is loaded and remember any
  // existing item that matches this offerId. When the user later taps
  // "Add to cart" we forward the canonical fields from that existing
  // cart row (companyName, subjectMultiLang, categoryName, imageUrl, …)
  // verbatim — this guarantees the POST payload matches the shape the
  // backend itself produced via GET /cart, eliminating the 500s caused
  // by mismatched multilang keys.
  useEffect(() => {
    if (!product) return;
    if (!isAuthenticated) return;

    const handle = InteractionManager.runAfterInteractions(() => {
      cartApi
        .getCart(locale)
        .then((res) => {
          if (!res.success || !res.data?.cart) {
            setExistingCartItem(null);
            return;
          }
          const items: any[] = (res.data.cart as any).items || [];
          const currentOfferId =
            product?.offerId?.toString() ||
            product?.id?.toString() ||
            productId?.toString() ||
            offerId?.toString() ||
            '';
          if (!currentOfferId) {
            setExistingCartItem(null);
            return;
          }
          const match = items.find(
            (it) => it?.offerId?.toString() === currentOfferId,
          );
          setExistingCartItem(match || null);
        })
        .catch(() => setExistingCartItem(null));
    });

    return () => handle.cancel?.();
  }, [product, productId, offerId, locale, isAuthenticated]);

  // (Previously: a secondary `lang=zh` product-detail fetch was used here
  //  to recover the Chinese company name. Removed because the backend's
  //  `/products/detail` endpoint returns HTTP 500 for `country=zh`. The
  //  Chinese company name is now sourced from:
  //    1. The existing cart row (GET /cart returns the canonical
  //       `companyName.zh`).
  //    2. The primary `country=en` product-detail response's `subject`
  //       field — which carries the original Chinese title — and
  //       `_rawCompanyNameCandidates`, which includes any zh slot the
  //       backend chose to send along with the English response.)

  // Fetch related products when productId is available.
  // Deferred via InteractionManager so the recommendations grid (the
  // heaviest section by far — 10–20 product cards with images) doesn't
  // delay the user's first interaction. The `<LazyMount>` wrapping in the
  // FlatList layout already keeps it out of the initial render; this also
  // keeps it out of the initial network burst.
  useEffect(() => {
    const currentProductId = productId?.toString() || offerId?.toString() || '';
    if (!currentProductId || !product) return;

    const handle = InteractionManager.runAfterInteractions(() => {
      // Same constraint as the primary product-detail fetch: the
      // recommendations / search endpoints reject `language=zh` with
      // HTTP 500 (which then surfaces as a red toast in the UI when
      // the user opens a product page in the Chinese locale). Map
      // `zh` → `en`; the recommendation cards still render fine and
      // the Chinese user sees the upstream `subject` field anyway.
      const language = locale === 'ko' ? 'ko' : 'en';
      const fetchSource = sourceRef.current;

      if (fetchSource === 'taobao') {
        const searchKeyword = product.category?.name || '';
        if (searchKeyword) {
          searchProducts(
            searchKeyword,
            fetchSource,
            language,
            1,
            20,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          );
        }
      } else {
        fetchRelatedRecommendations(currentProductId, 1, 10, language, fetchSource);
      }
    });

    return () => handle.cancel?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, offerId, locale, product, routeSource]);
  
  // Load more similar products - MUST be before early return
  const loadMoreSimilarProducts = useCallback(() => {
    // Function removed - API integration removed
  }, []);

  // Extract image URLs from HTML description - MUST be before early return
  const extractImagesFromHtml = useCallback((html: string): string[] => {
    if (!html) return [];
    
    // Match all img tags with src attribute
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const images: string[] = [];
    let match;
    
    while ((match = imgRegex.exec(html)) !== null) {
      if (match[1]) {
        images.push(match[1]);
    }
    }
    
    return images;
  }, []);

  // Get product images from API only (not from HTML description)
  const getApiProductImages = useCallback((currentProduct: any): string[] => {
    if (!currentProduct) return [];
    
    // Use images array from API, or fallback to single image
    const apiImages = (currentProduct as any).images || [];
    if (apiImages.length > 0) {
      return normalizeProductImageUrls(apiImages);
    }
    
    // Fallback to single image if images array is empty
    if (currentProduct.image) {
      const uri = normalizeProductImageUrl(currentProduct.image);
      return uri ? [uri] : [];
    }
    
    return [];
  }, []);

  // Parse variation types from variant names
  // Example: "Color: Cat print thickened modal-grey / Specifications: 20*25cm"
  // IMPORTANT: This must be defined before early return to avoid hooks order issues
  const getVariationTypes = useCallback(() => {
    if (!product) return [];
    
    const variationTypesMap = new Map<string, Map<string, { value: string; image?: string; [key: string]: any }>>();
    const galleryFirst =
      getApiProductImages(product)[0] ||
      normalizeProductImageUrl((product as any).image) ||
      '';

    // Get source to determine filtering logic
    const currentSource = (product as any).source || routeSource || selectedPlatform || '1688';
    
    // Check if we have raw variants data (from product detail API)
    const rawVariants = (product as any).rawVariants || [];
    const productSkuInfos = (product as any).productSkuInfos || [];
    
    if (rawVariants.length > 0) {
      // Parse each variant name to extract variation types
      rawVariants.forEach((variant: any) => {
        // Filter out variations based on source
        if (currentSource === '1688') {
          // For 1688, filter out if amountOnSale is 0
          // Check in variant first, then try to find in productSkuInfos
          let amountOnSale = variant.amountOnSale;
          if (amountOnSale === undefined && variant.skuId) {
            const matchingSku = productSkuInfos.find((sku: any) => 
              sku.skuId?.toString() === variant.skuId?.toString() || 
              sku.specId?.toString() === variant.specId?.toString()
            );
            amountOnSale = matchingSku?.amountOnSale;
          }
          if (amountOnSale === 0) {
            return; // Skip this variant
          }
        } else if (currentSource === 'taobao') {
          // For Taobao, filter out if quantity is 0
          const quantity = variant.quantity || variant.stock || 0;
          if (quantity === 0) {
            return; // Skip this variant
          }
        }
        
        const variantName = variant.name || '';
        
        if (!variantName) return;
        
        // Split by "/" to get each variation type
        const parts = variantName.split('/').map((p: string) => p.trim());
        
        parts.forEach((part: string) => {
          // Extract type name (before ":") and value (after ":")
          const colonIndex = part.indexOf(':');
          if (colonIndex === -1) return;
          
          const typeName = part.substring(0, colonIndex).trim();
          const value = part.substring(colonIndex + 1).trim();
          
          if (!typeName || !value) return;
          
          // Initialize map for this variation type if it doesn't exist
          if (!variationTypesMap.has(typeName)) {
            variationTypesMap.set(typeName, new Map());
          }
          
          const optionsMap = variationTypesMap.get(typeName)!;
          
          let imageUri = pickSkuImageForVariation(variant, typeName, value);
          if (!imageUri && isColorVariationType(typeName)) {
            imageUri = galleryFirst;
          }
          if (!imageUri) {
            imageUri = normalizeProductImageUrl(variant.image || '') || galleryFirst;
          }

          if (!optionsMap.has(value)) {
            optionsMap.set(value, {
              value,
              image: imageUri || undefined,
              ...variant,
            });
          } else {
            const existing = optionsMap.get(value)!;
            const existingUri = normalizeProductImageUrl(existing.image || '');
            if (!existingUri && imageUri) {
              optionsMap.set(value, { ...existing, image: imageUri, ...variant });
            }
          }
        });
      });
    }
    
    // Convert map to array format
    const variationTypes: Array<{ name: string; options: Array<{ value: string; image?: string; [key: string]: any }> }> = [];
    
    variationTypesMap.forEach((optionsMap, typeName) => {
      // Options are already filtered at the variant level above
      // Just convert to array and add to variationTypes
      const options = Array.from(optionsMap.values());
      
      if (options.length > 0) {
        variationTypes.push({
          name: typeName,
          options: options,
        });
      }
    });
    
    return variationTypes;
  }, [product, routeSource, selectedPlatform, getApiProductImages]);

  // Check if all variation types are selected
  // IMPORTANT: This must be defined before early return to avoid hooks order issues
  const canAddToCart = useMemo(() => {
    const variationTypes = getVariationTypes();
    
    // If there are no variations, buttons should be enabled
    if (variationTypes.length === 0) {
      return true;
    }
    
    // Check if all variation types have selections
    for (const variationType of variationTypes) {
      const variationName = variationType.name.toLowerCase();
      const selectedValue = selectedVariations[variationName] || 
                           (variationName === 'color' ? selectedColor : null) ||
                           (variationName === 'size' ? selectedSize : null);
      
      if (!selectedValue) {
        return false; // At least one variation is not selected
      }
    }
    
    return true; // All variations are selected
  }, [getVariationTypes, selectedVariations, selectedColor, selectedSize]);

  /** Gallery list; prepends selected color SKU image when it is not already in the API gallery */
  const displayGalleryImages = useMemo(() => {
    const base = getApiProductImages(product);
    if (!product) return base;

    const variationTypes = getVariationTypes();
    const colorType = variationTypes.find((vt) => isColorVariationType(vt.name));
    if (!colorType) return base;

    const colorKey = colorType.name.toLowerCase();
    const selected =
      selectedVariations[colorKey] ||
      (selectedColor && isColorVariationType('color') ? selectedColor : null);
    if (!selected) return base;

    const option = colorType.options.find((o) => o.value === selected);
    const galleryFirst = base[0] || '';
    const colorUri =
      normalizeProductImageUrl(option?.image || '') || galleryFirst;
    if (!colorUri) return base;

    const matchIdx = base.findIndex((img) => productImageUrlsMatch(img, colorUri));
    if (matchIdx >= 0) return base;

    const rest = base.filter((img) => !productImageUrlsMatch(img, colorUri));
    return [colorUri, ...rest];
  }, [
    product,
    selectedVariations,
    selectedColor,
    getVariationTypes,
    getApiProductImages,
  ]);

  // Image prefetch — warm the cache for the neighbours of whichever gallery
  // image is on screen. Inline gallery uses `selectedImageIndex`, the
  // fullscreen viewer uses `viewerImageIndex`; both hooks share the same
  // requested-URL dedupe set internally.
  useGalleryPrefetch(displayGalleryImages, selectedImageIndex, 1);
  useGalleryPrefetch(displayGalleryImages, viewerImageIndex, 1);

  // Prefetch handler for the related-products grid. Fires only for cards
  // that actually enter the viewport, so we don't burn bandwidth on every
  // recommendation up front.
  const handleRelatedViewable = useViewablePrefetch<Product | any>(
    (item) => (item as any)?.image || (item as any)?.imageUrl,
  );

  // Staggered reveal — defeats "everything mounts at once" by spreading
  // section mounts across multiple frames after the product data arrives.
  //
  //   stage 0 : gallery + info + price + variations (critical path)
  //   stage 1 : + seller card
  //   stage 2 : + product details (HTML + description images, heaviest)
  //   stage 3 : + related products grid
  //
  // Each step waits ~120ms so the JS thread can finish layout/paint of the
  // previous step before being asked to mount the next one. The result is
  // that the first frame the user sees only contains the critical sections,
  // and the heavy content fills in progressively without a single big jank.
  const revealStage = useStaggeredReveal(4, 120, !!product);

  // Reset the description-image window whenever the underlying product
  // changes (e.g. pushing into a related product), so the next product also
  // starts from the cheap first-paint window.
  useEffect(() => {
    setDescriptionImagesShown(5);
  }, [product?.id, product?.offerId]);

  // After the details stage is reached, grow the visible description-image
  // window in small batches so the remaining covers stream in without
  // freezing the JS thread. Stops once the window covers everything.
  useEffect(() => {
    if (revealStage < 2) return;
    const total = product?.description
      ? extractImagesFromHtml(product.description).length
      : 0;
    if (descriptionImagesShown >= total) return;

    const id = setTimeout(() => {
      setDescriptionImagesShown((n) => Math.min(total, n + 5));
    }, 250);
    return () => clearTimeout(id);
  }, [revealStage, descriptionImagesShown, product?.description]);

  const resolveGalleryImagesForColorUri = useCallback(
    (colorUri: string): string[] => {
      const normalized = normalizeProductImageUrl(colorUri);
      if (!normalized) return getApiProductImages(product);

      const base = getApiProductImages(product);
      const matchIdx = base.findIndex((img) => productImageUrlsMatch(img, normalized));
      if (matchIdx >= 0) return base;

      const rest = base.filter((img) => !productImageUrlsMatch(img, normalized));
      return [normalized, ...rest];
    },
    [product, getApiProductImages],
  );

  const syncGalleryToColorUri = useCallback(
    (colorUri: string) => {
      const normalized = normalizeProductImageUrl(colorUri);
      if (!normalized) return;

      const images = resolveGalleryImagesForColorUri(normalized);
      const target = images.findIndex((img) => productImageUrlsMatch(img, normalized));
      const index = target >= 0 ? target : 0;
      setSelectedImageIndex(index);
      requestAnimationFrame(() => {
        imageGalleryScrollRef.current?.scrollTo({
          x: index * width,
          animated: true,
        });
      });
    },
    [resolveGalleryImagesForColorUri],
  );

  useEffect(() => {
    if (!product) return;
    const variationTypes = getVariationTypes();
    const colorType = variationTypes.find((vt) => isColorVariationType(vt.name));
    if (!colorType) return;

    const colorKey = colorType.name.toLowerCase();
    const selected = selectedVariations[colorKey] || selectedColor;
    if (!selected) return;

    const option = colorType.options.find((o) => o.value === selected);
    const galleryFirst = getApiProductImages(product)[0] || '';
    const colorUri =
      normalizeProductImageUrl(option?.image || '') || galleryFirst;
    if (!colorUri) return;

    syncGalleryToColorUri(colorUri);
  }, [
    product,
    selectedVariations,
    selectedColor,
    getVariationTypes,
    getApiProductImages,
    syncGalleryToColorUri,
  ]);

  // Get selected variation price - MUST be before early return
  const getSelectedVariationPrice = useMemo(() => {
    if (!product) return { price: 0, originalPrice: 0 };
    
    const source = routeSource || selectedPlatform || '1688';
    
    if (source === 'taobao') {
      // For Taobao, find the selected variation and return its price
      const selectedVariation = product.rawVariants?.find((variant: any) => {
        if (!variant.attributes || !Array.isArray(variant.attributes)) return false;
        
        return Object.keys(selectedVariations).every(variantName => {
          const selectedValue = selectedVariations[variantName];
          return variant.attributes.some((attr: any) => {
            const attrName = attr.prop_name || attr.propId || '';
            const attrValue = attr.value_name || attr.value_desc || attr.valueId || '';
            return attrName === variantName && attrValue === selectedValue;
          });
        });
      });
      
      if (selectedVariation) {
        return {
          price: selectedVariation.price || product.price || 0,
          originalPrice: selectedVariation.price || product.originalPrice || product.price || 0,
        };
      }
    } else {
      // For 1688, find the selected SKU and return its consignPrice
      const productSkuInfos = (product as any).productSkuInfos || [];
      const rawVariants = (product as any).rawVariants || [];
      
      // Find matching variant from rawVariants
      let selectedVariant: any = null;
      if (rawVariants.length > 0 && Object.keys(selectedVariations).length > 0) {
        selectedVariant = rawVariants.find((variant: any) => {
          const variantName = variant.name || '';
          if (!variantName) return false;
          
          return Object.entries(selectedVariations).every(([variationName, selectedValue]) => {
            const searchPattern = `${variationName}: ${selectedValue}`;
            return variantName.toLowerCase().includes(searchPattern.toLowerCase());
          });
        });
      }
      
      // Get skuId from variant if found
      let skuIdFromVariant: string | number | null = null;
      if (selectedVariant) {
        skuIdFromVariant = selectedVariant.skuId || selectedVariant.id || null;
      }
      
      // Find matching SKU from productSkuInfos
      let selectedSku: any = null;
      if (productSkuInfos.length > 0) {
        if (skuIdFromVariant) {
          selectedSku = productSkuInfos.find((sku: any) => 
            sku.skuId?.toString() === skuIdFromVariant?.toString() || 
            sku.specId?.toString() === skuIdFromVariant?.toString()
          );
        }
        
        // If no match by skuId, try to match by attributes
        if (!selectedSku && Object.keys(selectedVariations).length > 0) {
          selectedSku = productSkuInfos.find((sku: any) => {
            const skuAttributes = sku.skuAttributes || [];
            return Object.entries(selectedVariations).every(([variationName, selectedValue]) => {
              return skuAttributes.some((attr: any) => {
                const attrName = (attr.attributeNameTrans || attr.attributeName || '').toLowerCase();
                const attrValue = attr.valueTrans || attr.value || '';
                return attrName === variationName.toLowerCase() && attrValue === selectedValue;
              });
            });
          });
        }
      }
      
      // For 1688, use consignPrice from selectedSku
      if (selectedSku?.consignPrice) {
        return {
          price: parseFloat(selectedSku.consignPrice) || product.price || 0,
          originalPrice: parseFloat(selectedSku.consignPrice) || product.originalPrice || product.price || 0,
        };
      } else if (selectedVariant?.consignPrice) {
        return {
          price: parseFloat(selectedVariant.consignPrice) || product.price || 0,
          originalPrice: parseFloat(selectedVariant.consignPrice) || product.originalPrice || product.price || 0,
        };
      }
    }
    
    return { price: product.price || 0, originalPrice: product.originalPrice || product.price || 0 };
  }, [product, selectedVariations, routeSource, selectedPlatform]);

  // 수량 컨트롤 옆에 표시할 재고 수 — 옵션이 선택된 경우 해당 SKU 의
  // amountOnSale, 아니면 product.stockCount 를 사용. 999999 같은 sentinel
  // (amountOnSale 이 unknown 일 때 buildAddToCartRequest 가 채우는 값) 은 숨김.
  // MUST be before early return — hooks 순서 일관성을 위해 다른 useMemo 들과
  // 같이 여기 둔다.
  const displayStock = useMemo(() => {
    if (!product) return null;
    const productSkuInfos = (product as any).productSkuInfos || [];
    let skuStock: number | null = null;
    if (productSkuInfos.length > 0 && Object.keys(selectedVariations).length > 0) {
      const matched = productSkuInfos.find((sku: any) => {
        const skuAttributes = sku.skuAttributes || [];
        return Object.entries(selectedVariations).every(([variationName, selectedValue]) => {
          return skuAttributes.some((attr: any) => {
            const attrName = (attr.attributeNameTrans || attr.attributeName || '').toLowerCase();
            const attrValue = attr.valueTrans || attr.value || '';
            return attrName === variationName.toLowerCase() && attrValue === selectedValue;
          });
        });
      });
      if (matched) {
        const v = Number(matched.amountOnSale);
        if (Number.isFinite(v)) skuStock = v;
      }
    }
    const fallback = Number((product as any).stockCount);
    const n = skuStock ?? (Number.isFinite(fallback) ? fallback : null);
    if (n == null) return null;
    if (n >= 999999) return null;
    return n;
  }, [product, selectedVariations]);

  // 옵션 변경 등으로 재고가 줄어들 경우, 현재 수량이 새 재고를 초과하면
  // 재고 값으로 끌어내린다. (displayStock 정의 직후에 두어 TDZ 회피.)
  useEffect(() => {
    if (typeof displayStock === 'number' && displayStock > 0) {
      setQuantity(prev => (prev > displayStock ? displayStock : prev));
    }
  }, [displayStock]);

  const handleRelatedProductPress = useCallback((item: Product | any) => {
    const productIdToUse = (item as any).offerId || item.id;
    const itemSource =
      selectedPlatform === 'taobao'
        ? (item as any).source || 'taobao'
        : (item as any).source || selectedPlatform || '1688';
    // zh → en (backend rejects country=zh; the pushed ProductDetail
    // would otherwise 500 just like the current one used to).
    const itemCountry = locale === 'ko' ? 'ko' : 'en';

    navigation.push('ProductDetail', {
      productId: productIdToUse?.toString() || item.id?.toString() || '',
      offerId: (item as any).offerId?.toString(),
      source: itemSource,
      country: itemCountry,
    });
  }, [locale, navigation, selectedPlatform]);

  const renderRelatedProductItem = useCallback(({ item }: { item: Product | any }) => {
    if (selectedPlatform === 'taobao') {
      return (
        <TouchableOpacity
          style={styles.similarProductItem}
          onPress={() => handleRelatedProductPress(item)}
        >
          <View style={styles.simpleTaobaoCard}>
            <ProductImage
              uri={(item as any).image}
              style={styles.simpleTaobaoImage as any}
              resizeMode="cover"
            />
            <Text style={styles.simpleTaobaoTitle} numberOfLines={2}>
              {(item as any).name}
            </Text>
            <Text style={styles.simpleTaobaoPrice}>
              {formatPriceCNY(Number((item as any).price || 0))}
            </Text>
          </View>
        </TouchableOpacity>
      );
    }

    return (
      <View style={styles.similarProductItem}>
        <ProductCard
          product={item}
          variant="moreToLove"
          onPress={() => handleRelatedProductPress(item)}
          onLikePress={() => toggleWishlist(item)}
          isLiked={isProductLiked(item)}
        />
      </View>
    );
  }, [handleRelatedProductPress, isProductLiked, selectedPlatform, toggleWishlist]);

  const relatedProductsKeyExtractor = useCallback(
    (item: Product | any, index: number) =>
      `related-${item.id?.toString() || (item as any).offerId?.toString() || index}-${index}`,
    [],
  );

  const renderSimilarProductItem = useCallback(({ item }: { item: Product }) => (
    <View style={styles.similarProductItem}>
      <ProductCard
        product={item}
        variant="moreToLove"
        onPress={() => navigation.push('ProductDetail', { productId: item.id })}
        onLikePress={() => toggleWishlist(item)}
        isLiked={isProductLiked(item)}
      />
    </View>
  ), [isProductLiked, navigation, toggleWishlist]);

  const similarProductsKeyExtractor = useCallback(
    (item: Product, index: number) => `similar-${item.id?.toString() || index}-${index}`,
    [],
  );

  const renderSimilarProductsFooter = useCallback(() => {
    if (!similarProductsLoadingMore) {
      return null;
    }

    return (
      <View style={styles.loadingMoreContainer}>
        <ActivityIndicator size="small" color={COLORS.primary} />
        <Text style={styles.loadingMoreText}>Loading more...</Text>
      </View>
    );
  }, [similarProductsLoadingMore]);

  const shareProductId = useMemo(
    () =>
      (offerId || productId || product?.offerId || product?.id || '').toString(),
    [offerId, productId, product?.offerId, product?.id],
  );

  const productShareUrl = useMemo(
    () =>
      shareProductId
        ? buildProductSharePageUrl({
            productId: shareProductId,
            source: sourceRef.current,
            country: countryRef.current,
          })
        : '',
    [shareProductId, route.params?.source, route.params?.country, selectedPlatform, locale],
  );

  const productShareMessage = useMemo(() => {
    if (!product?.name) return '';
    return t('product.shareMessage')
      .replace('{productName}', product.name)
      .replace('{price}', formatPriceCNY(product.price || 0));
  }, [product?.name, product?.price, t]);

  // Early return — MUST be after ALL hooks.
  //
  // Critical-path first-paint strategy:
  //   1. If the caller passed a `thumbnailUrl` (via openProductDetail), paint
  //      it RIGHT NOW into the hero slot. The bytes are already in cache
  //      from the prefetch fired at click time, so this is a synchronous
  //      paint — the user sees the same picture they tapped on, instantly.
  //   2. Underneath the hero, draw <ProductDetailBodySkeleton> so the rest
  //      of the page has visible structure while the detail API resolves.
  //   3. Header (back/share) is rendered on top so the user can navigate
  //      back before the data arrives.
  //
  // Once `product` arrives, the full FlatList layout (RecyclerView + LazyMount
  // + Image Prefetch) takes over — the hero we drew here gets replaced by the
  // real <renderImageGallery> ScrollView seamlessly because both use the same
  // <ProductImage> component pointed at the same URL.
  if (loading || !product) {
    return (
      <View style={styles.container}>
        {/* Minimal header — only the back button. The full header (share,
            wishlist count, etc.) needs product data so it's deferred until
            the real render path below. Defining the header inline here also
            avoids forward-referencing `renderHeader`, which is declared
            later in the component body. */}
        <View
          style={[
            styles.safeArea,
            { paddingTop: insets.top, backgroundColor: COLORS.white },
          ]}
          pointerEvents="box-none"
        >
          <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8 }}>
            <TouchableOpacity
              onPress={handleBack}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Icon name="arrow-back" size={24} color={COLORS.text.primary} />
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          scrollEnabled={false}
          contentContainerStyle={{ paddingBottom: 200 + insets.bottom }}
        >
          {routeThumbnailUrl ? (
            <View style={{ width, height: width, backgroundColor: COLORS.gray[100] }}>
              <ProductImage
                uri={routeThumbnailUrl}
                style={{ width, height: width } as any}
                resizeMode="cover"
              />
            </View>
          ) : null}
          <ProductDetailBodySkeleton hasHeroImage={!!routeThumbnailUrl} />
        </ScrollView>
      </View>
    );
  }

  const isLiked = isProductLiked(product);

  const handleQuantityChange = (increment: boolean) => {
    const minOrderQuantity = (product as any)?.minOrderQuantity || 1;
    // 재고 상한 — displayStock 이 null 이면 무제한(=sentinel 또는 미상) 으로 본다.
    const maxStock =
      typeof displayStock === 'number' && displayStock > 0 ? displayStock : Infinity;
    if (increment) {
      setQuantity(prev => Math.min(maxStock, prev + 1));
    } else {
      setQuantity(prev => Math.max(minOrderQuantity, prev - 1));
    }
  };

  // TextInput 으로 직접 타이핑된 수량을 처리. 숫자가 아닌 문자는 제거하고,
  // 재고 상한을 넘으면 재고값으로 클램프. 빈 문자열은 0 으로 두고 onBlur 에서
  // 최소 수량으로 보정.
  const handleQuantityInput = (text: string) => {
    const digits = text.replace(/[^0-9]/g, '');
    if (digits === '') {
      setQuantity(0);
      return;
    }
    const n = parseInt(digits, 10);
    if (!Number.isFinite(n)) return;
    const maxStock =
      typeof displayStock === 'number' && displayStock > 0 ? displayStock : Infinity;
    setQuantity(Math.min(maxStock, n));
  };

  // 포커스 해제 시 최소 주문 수량 이하로 떨어졌으면 끌어올린다.
  const handleQuantityBlur = () => {
    const minOrderQuantity = (product as any)?.minOrderQuantity || 1;
    setQuantity(prev => (prev < minOrderQuantity ? minOrderQuantity : prev));
  };

  const buildAddToCartRequest = (): AddToCartRequest => {
    const productSkuInfos = (product as any).productSkuInfos || [];
    const rawVariants = (product as any).rawVariants || [];
    const source =
      (product as any).source || route.params?.source || selectedPlatform || '1688';
    const minOrderQuantity = (product as any).minOrderQuantity || 1;

    let selectedVariant: any = null;
    let selectedSku: any = null;

    if (rawVariants.length > 0) {
      if (Object.keys(selectedVariations).length > 0) {
        selectedVariant = rawVariants.find((variant: any) => {
          const variantName = variant.name || '';
          if (!variantName) return false;
          return Object.entries(selectedVariations).every(([variationName, selectedValue]) => {
            const searchPattern = `${variationName}: ${selectedValue}`;
            return variantName.toLowerCase().includes(searchPattern.toLowerCase());
          });
        });
      }
      if (!selectedVariant && rawVariants.length > 0) {
        selectedVariant = rawVariants[0];
      }
    }

    let skuIdFromVariant: string | number | null = null;
    let variantPrice: number | null = null;

    if (selectedVariant) {
      skuIdFromVariant = selectedVariant.skuId || selectedVariant.id || null;
      variantPrice = selectedVariant.price || null;
    }

    if (productSkuInfos.length > 0) {
      if (skuIdFromVariant) {
        selectedSku = productSkuInfos.find(
          (sku: any) =>
            sku.skuId?.toString() === skuIdFromVariant?.toString() ||
            sku.specId?.toString() === skuIdFromVariant?.toString(),
        );
      }

      if (!selectedSku && Object.keys(selectedVariations).length > 0) {
        selectedSku = productSkuInfos.find((sku: any) => {
          const skuAttributes = sku.skuAttributes || [];
          return Object.entries(selectedVariations).every(([variationName, selectedValue]) =>
            skuAttributes.some((attr: any) => {
              const attrName = (attr.attributeNameTrans || attr.attributeName || '').toLowerCase();
              const attrValue = attr.valueTrans || attr.value || '';
              return attrName === variationName.toLowerCase() && attrValue === selectedValue;
            }),
          );
        });
      }

      if (!selectedSku && productSkuInfos.length > 0) {
        selectedSku = productSkuInfos[0];
      }
    }

    const productIdForUrl = product.offerId || product.id || productId || offerId || '';

    // For products WITHOUT options (no variations, no SKU list), the
    // backend convention — confirmed by the known-good cart response
    // sample — is to set `skuId` and `specId` equal to the offerId
    // itself, so the request is still well-formed and references a
    // valid product. Without this fallback the cart endpoint received
    // `skuId=0 / specId='0'`, which our validator (correctly) blocked
    // with "잠시 후 다시 시도해 주세요" — making no-option products
    // impossible to add.
    const hasNoOptions =
      rawVariants.length === 0 && productSkuInfos.length === 0;
    const defaultSkuFromOffer = hasNoOptions
      ? productIdForUrl.toString()
      : '0';

    const finalSkuId =
      skuIdFromVariant ||
      selectedSku?.skuId ||
      selectedVariant?.skuId ||
      selectedVariant?.id ||
      defaultSkuFromOffer;
    const isTaobao = source === 'taobao';
    const finalSpecId = isTaobao
      ? finalSkuId.toString()
      : selectedSku?.specId?.toString() ||
        (hasNoOptions ? productIdForUrl.toString() : finalSkuId.toString());
    const finalPrice =
      variantPrice || selectedSku?.price || selectedSku?.consignPrice || product.price || 0;
    const promotionUrl = isTaobao
      ? `${SERVER_BASE_URL}/${productIdForUrl}`
      : (product as any).promotionUrl || '';
    const skuIdValue = typeof finalSkuId === 'string' ? parseInt(finalSkuId, 10) || 0 : finalSkuId;

    // Build the multi-language objects the backend expects. Three rules
    // (derived from the known-good payload sample):
    //
    //   1. If the source value is already a {en,ko,zh} object, forward
    //      only those three keys verbatim.
    //   2. If it's a plain string, decide which locale slot it belongs in
    //      based on its CHARACTER SET, not the user's current UI locale:
    //        - contains CJK ideographs only      → `zh`
    //        - contains Hangul                   → `ko`
    //        - otherwise (ASCII / Latin)         → `en`
    //      The previous version dropped every string into the UI locale's
    //      slot, which produced `subjectMultiLang.ko = "<chinese text>"` —
    //      the backend then rejected it (probably a Hangul validator) and
    //      returned HTTP 500.
    //   3. Empty / nullish input returns an empty object.
    type LocaleSlot = 'en' | 'ko' | 'zh';
    const localeFromText = (text: string): LocaleSlot => {
      if (/[가-힯ᄀ-ᇿ㄰-㆏]/.test(text)) return 'ko';
      if (/[一-鿿]/.test(text)) return 'zh';
      return 'en';
    };
    const buildMultiLang = (value: unknown): { en?: string; ko?: string; zh?: string } => {
      if (value == null) return {};
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return {};
        return { [localeFromText(trimmed)]: trimmed } as {
          en?: string;
          ko?: string;
          zh?: string;
        };
      }
      if (typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: { en?: string; ko?: string; zh?: string } = {};
        if (typeof obj.en === 'string' && obj.en.trim()) out.en = obj.en.trim();
        if (typeof obj.ko === 'string' && obj.ko.trim()) out.ko = obj.ko.trim();
        if (typeof obj.zh === 'string' && obj.zh.trim()) out.zh = obj.zh.trim();
        return out;
      }
      return {};
    };

    // Subject / title — server's accepted format uses the TRANSLATED text
    // for both `subject` and `subjectTrans`, with `subjectMultiLang`
    // containing the language-keyed copy. `product.subject` is the raw
    // upstream value (often Chinese), `product.subjectTrans` is the
    // localised one — so prefer `subjectTrans` everywhere user-facing.
    const subjectTransText = resolveText(
      (product as any).subjectTrans || product.name || (product as any).subject || '',
    );
    const subjectOriginalText = resolveText(
      (product as any).subject || (product as any).subjectOriginal || '',
    );
    // Subject multilang — the known-good payload sample contains ONLY the
    // translated slot (`ko`). Send just that slot exactly mirroring the
    // sample. (We avoid filling `zh` from a different source; the backend
    // appears to dislike payloads with mixed-origin multilang content.)
    const rawSubjectMultiLang = buildMultiLang(
      (product as any).subjectMultiLang ?? (product as any).subjectMultilang,
    );
    const subjectMultiLang: { en?: string; ko?: string; zh?: string } =
      // If the upstream API already gave us a multilang object, prefer it
      // verbatim. Otherwise build a single-slot one from `subjectTrans`.
      Object.keys(rawSubjectMultiLang).length > 0
        ? rawSubjectMultiLang
        : subjectTransText
          ? ({ [localeFromText(subjectTransText)]: subjectTransText } as {
              en?: string;
              ko?: string;
              zh?: string;
            })
          : {};
    void subjectOriginalText;

    // Company name — Android always tries to send the ORIGINAL Chinese
    // name in the `zh` slot. Strict invariant: a value is only allowed in
    // the `zh` slot if it ACTUALLY contains Chinese ideographs. Slots
    // labelled `zh` but holding English/Korean text have been observed to
    // trigger HTTP 500 — the backend appears to validate that the zh
    // value matches a Chinese character set.
    //
    // We also forward `en` and `ko` slots when they're available and
    // language-correct, so the cart row ends up with a complete
    // multilang object (matching the known-good response sample).
    const containsChinese = (s: string) => /[一-鿿]/.test(s);
    const containsHangul = (s: string) => /[가-힯ᄀ-ᇿ㄰-㆏]/.test(s);

    /** Pick the best Chinese-character string from a list of candidates. */
    const findChineseCompanyName = (): string => {
      // 1) Existing cart row's zh value — only trust it if it's actually
      //    Chinese characters. (If the row is corrupted by a previous
      //    buggy submit, fall through.)
      const ec = existingCartItem as any;
      if (
        ec?.companyName?.zh &&
        typeof ec.companyName.zh === 'string' &&
        containsChinese(ec.companyName.zh)
      ) {
        return ec.companyName.zh.trim();
      }

      // 2) Walk the collected candidate list. For each candidate that's
      //    an object, only accept its zh slot IF the value is Chinese.
      const candidates: unknown[] = (product as any)._rawCompanyNameCandidates || [];
      for (const cand of candidates) {
        if (
          cand &&
          typeof cand === 'object' &&
          typeof (cand as any).zh === 'string' &&
          containsChinese((cand as any).zh)
        ) {
          return (cand as any).zh.trim();
        }
      }
      // For candidates that are plain strings, check character set.
      for (const cand of candidates) {
        if (typeof cand === 'string' && containsChinese(cand)) {
          return cand.trim();
        }
      }

      // 3) Direct product fields — same strictness.
      const direct = (product as any).companyName;
      if (
        direct &&
        typeof direct === 'object' &&
        typeof direct.zh === 'string' &&
        containsChinese(direct.zh)
      ) {
        return direct.zh.trim();
      }
      if (typeof direct === 'string' && containsChinese(direct)) {
        return direct.trim();
      }

      // 4) Seller name.
      const sellerName = resolveText(product.seller?.name ?? '');
      if (sellerName && containsChinese(sellerName)) {
        return sellerName.trim();
      }

      // 5) Nothing Chinese found — return empty string so the caller can
      //    omit the zh slot entirely instead of poisoning it with a
      //    non-Chinese value (which would re-create the 500).
      return '';
    };

    /** Pick the best Hangul string. */
    const findKoreanCompanyName = (): string => {
      const ec = existingCartItem as any;
      if (
        ec?.companyName?.ko &&
        typeof ec.companyName.ko === 'string' &&
        containsHangul(ec.companyName.ko)
      ) {
        return ec.companyName.ko.trim();
      }
      const candidates: unknown[] = (product as any)._rawCompanyNameCandidates || [];
      for (const cand of candidates) {
        if (
          cand &&
          typeof cand === 'object' &&
          typeof (cand as any).ko === 'string' &&
          containsHangul((cand as any).ko)
        ) {
          return (cand as any).ko.trim();
        }
      }
      for (const cand of candidates) {
        if (typeof cand === 'string' && containsHangul(cand)) return cand.trim();
      }
      const direct = (product as any).companyName;
      if (
        direct &&
        typeof direct === 'object' &&
        typeof direct.ko === 'string' &&
        containsHangul(direct.ko)
      ) {
        return direct.ko.trim();
      }
      const sellerName = resolveText(product.seller?.name ?? '');
      if (sellerName && containsHangul(sellerName)) return sellerName.trim();
      return '';
    };

    /** Pick the best English / Latin string. */
    const findEnglishCompanyName = (): string => {
      const ec = existingCartItem as any;
      if (
        ec?.companyName?.en &&
        typeof ec.companyName.en === 'string' &&
        !containsChinese(ec.companyName.en) &&
        !containsHangul(ec.companyName.en)
      ) {
        return ec.companyName.en.trim();
      }
      const candidates: unknown[] = (product as any)._rawCompanyNameCandidates || [];
      for (const cand of candidates) {
        if (
          cand &&
          typeof cand === 'object' &&
          typeof (cand as any).en === 'string' &&
          (cand as any).en.trim() &&
          !containsChinese((cand as any).en) &&
          !containsHangul((cand as any).en)
        ) {
          return (cand as any).en.trim();
        }
      }
      for (const cand of candidates) {
        if (
          typeof cand === 'string' &&
          cand.trim() &&
          !containsChinese(cand) &&
          !containsHangul(cand)
        ) {
          return cand.trim();
        }
      }
      const direct = (product as any).companyName;
      if (
        direct &&
        typeof direct === 'object' &&
        typeof direct.en === 'string' &&
        direct.en.trim() &&
        !containsChinese(direct.en) &&
        !containsHangul(direct.en)
      ) {
        return direct.en.trim();
      }
      if (
        typeof direct === 'string' &&
        direct.trim() &&
        !containsChinese(direct) &&
        !containsHangul(direct)
      ) {
        return direct.trim();
      }
      const sellerName = resolveText(product.seller?.name ?? '');
      if (
        sellerName &&
        !containsChinese(sellerName) &&
        !containsHangul(sellerName)
      ) {
        return sellerName.trim();
      }
      return '';
    };

    // Build the multilang object — each slot only gets filled when the
    // value's character set matches the slot's locale. This guarantees
    // the backend's per-slot validators (Chinese for zh, Hangul for ko,
    // ASCII for en) never see a mismatched value.
    const companyZh = findChineseCompanyName();
    const companyKo = findKoreanCompanyName();
    const companyEn = findEnglishCompanyName();
    const companyMultiLang: { en?: string; ko?: string; zh?: string } = {};
    if (companyZh) companyMultiLang.zh = companyZh;
    if (companyKo) companyMultiLang.ko = companyKo;
    if (companyEn) companyMultiLang.en = companyEn;

    // Category — backend accepts `categoryName` (string, empty OK; or a
    // {en,ko,zh} object as seen in the response sample). Forward whatever
    // the upstream gave us; default to empty string to mirror the sample.
    const rawCategoryName = (product as any).categoryName;
    const categoryName: string | { en?: string; ko?: string; zh?: string } =
      rawCategoryName && typeof rawCategoryName === 'object'
        ? rawCategoryName
        : typeof rawCategoryName === 'string' && rawCategoryName
          ? rawCategoryName
          : typeof product.category === 'object' && product.category
            ? resolveText((product.category as any).name) || ''
            : '';

    const finalPriceStr = finalPrice.toString();

    // Strip the `_NNNxNNN.jpg` size suffix that our image normaliser
    // appends for 1688 CDN thumbnails. The backend stores the original
    // URL (see the known-good payload sample) and likely re-fetches it
    // from 1688 — the size variant URL is not a valid 1688 resource and
    // makes that fetch fail, contributing to the 500.
    const stripAlicdnSizeSuffix = (url: string): string =>
      url ? url.replace(/_\d+x\d+\.(jpg|jpeg|png|webp)$/i, '') : url;
    const rawImageUrl = product.images?.[0] || product.image || '';
    const cleanImageUrl = stripAlicdnSizeSuffix(rawImageUrl);

    const builtPayload: AddToCartRequest = {
      offerId: parseInt(productIdForUrl.toString() || '0', 10),
      categoryName,
      // Both `subject` and `subjectTrans` carry the translated text — the
      // known-good payload sample shows them identical. Sending the raw
      // Chinese in `subject` (the previous behaviour) caused a 500 because
      // the backend's Hangul-validator on the ko-locale path rejected it.
      subject: subjectTransText,
      subjectTrans: subjectTransText,
      subjectMultiLang,
      imageUrl: cleanImageUrl,
      promotionUrl,
      source,
      // `originalSource` keeps the marketplace of record even if the client
      // remaps `source` for routing — backend uses it for SKU lookups.
      originalSource: (product as any).originalSource || source,
      skuInfo: {
        skuId: skuIdValue,
        specId: finalSpecId,
        price: finalPriceStr,
        // For products without options, fall back to a large stock figure
        // (matches the backend's own convention — known-good payload sample
        // shows `amountOnSale: 999999` for no-option products). `0` would
        // make some downstream stock checks reject the line item.
        amountOnSale:
          selectedSku?.amountOnSale ||
          selectedVariant?.stock ||
          (hasNoOptions ? 999999 : 0),
        consignPrice: finalPriceStr,
        cargoNumber: selectedSku?.cargoNumber || '',
        skuAttributes: (selectedSku?.skuAttributes || selectedVariant?.attributes || []).map(
          (attr: any) => ({
            attributeId: parseInt(attr.attributeId || attr.propId || '0', 10) || 0,
            attributeName: attr.attributeName || attr.prop_name || '',
            attributeNameTrans:
              attr.attributeNameTrans || attr.prop_name || attr.attributeName || '',
            value: attr.value || attr.value_name || attr.value_desc || '',
            valueTrans:
              attr.valueTrans || attr.value_name || attr.value_desc || attr.value || '',
            skuImageUrl: stripAlicdnSizeSuffix(attr.skuImageUrl || attr.image || ''),
          }),
        ),
        // Backend expects BOTH `onePiecePrice` and `offerPrice` here.
        fenxiaoPriceInfo: selectedSku?.fenxiaoPriceInfo
          ? {
              onePiecePrice:
                selectedSku.fenxiaoPriceInfo.onePiecePrice ||
                selectedSku.fenxiaoPriceInfo.offerPrice ||
                finalPriceStr,
              offerPrice:
                selectedSku.fenxiaoPriceInfo.offerPrice ||
                selectedSku.fenxiaoPriceInfo.onePiecePrice ||
                finalPriceStr,
            }
          : {
              onePiecePrice: finalPriceStr,
              offerPrice: finalPriceStr,
            },
      },
      companyName: companyMultiLang,
      sellerOpenId: product.seller?.id || (product as any).sellerOpenId || '',
      quantity,
      minOrderQuantity,
    };

    // OVERRIDE with canonical data from the existing cart row (if any).
    // The cart backend's GET /cart response is the authoritative shape for
    // POST /cart — by reusing the exact `companyName`, `subjectMultiLang`,
    // `categoryName`, `imageUrl`, `subject`, `subjectTrans` it already
    // stored for this offerId, we eliminate every class of "Korean text
    // in zh slot" / "alicdn size suffix" mismatch that has been causing
    // the 500. Only fields that come from the cart row are replaced;
    // SKU-specific fields (skuId, specId, price, quantity, skuAttributes,
    // fenxiaoPriceInfo) are kept from the user's current selection.
    if (existingCartItem) {
      const ec = existingCartItem as any;
      // When the same product is already in the cart, the row stored by
      // the backend is the authoritative shape. Copy each slot AS-IS but
      // only if its content matches the slot's expected character set —
      // a `zh` slot holding English text would re-create the 500 we're
      // trying to fix.
      if (ec.companyName && typeof ec.companyName === 'object') {
        const merged: { en?: string; ko?: string; zh?: string } = {};
        const zhVal =
          typeof ec.companyName.zh === 'string' ? ec.companyName.zh.trim() : '';
        const koVal =
          typeof ec.companyName.ko === 'string' ? ec.companyName.ko.trim() : '';
        const enVal =
          typeof ec.companyName.en === 'string' ? ec.companyName.en.trim() : '';
        if (zhVal && containsChinese(zhVal)) merged.zh = zhVal;
        if (koVal && containsHangul(koVal)) merged.ko = koVal;
        if (enVal && !containsChinese(enVal) && !containsHangul(enVal)) {
          merged.en = enVal;
        }
        if (merged.zh || merged.ko || merged.en) {
          builtPayload.companyName = merged;
        }
      }
      if (ec.subjectMultiLang && typeof ec.subjectMultiLang === 'object') {
        builtPayload.subjectMultiLang = ec.subjectMultiLang;
      }
      if (ec.categoryName !== undefined && ec.categoryName !== null) {
        builtPayload.categoryName = ec.categoryName;
      }
      if (typeof ec.imageUrl === 'string' && ec.imageUrl) {
        builtPayload.imageUrl = ec.imageUrl;
      }
      if (typeof ec.subject === 'string' && ec.subject) {
        builtPayload.subject = ec.subject;
      }
      if (typeof ec.subjectTrans === 'string' && ec.subjectTrans) {
        builtPayload.subjectTrans = ec.subjectTrans;
      }
      if (typeof ec.promotionUrl === 'string') {
        builtPayload.promotionUrl = ec.promotionUrl;
      }
      if (typeof ec.source === 'string' && ec.source) {
        builtPayload.source = ec.source;
      }
      if (typeof ec.sellerOpenId === 'string' && ec.sellerOpenId) {
        builtPayload.sellerOpenId = ec.sellerOpenId;
      }
    }

    return builtPayload;
  };

  const validateBeforeCartAction = (): boolean => {
    if (!canAddToCart) {
      const variationTypes = getVariationTypes();
      if (variationTypes.length > 0) {
        showToast(t('product.pleaseSelectOptions'), 'warning');
      }
      return false;
    }

    const minOrderQuantity = (product as any).minOrderQuantity || 1;
    if (quantity < minOrderQuantity) {
      showToast(
        t('product.minOrderQuantity') || `Minimum order quantity is ${minOrderQuantity}`,
        'warning',
      );
      return false;
    }

    // Build the payload once up-front so we can sanity-check the values
    // BEFORE sending. The staggered reveal can make the cart button paint
    // a few frames before `selectedSku`/`selectedVariant` settle for
    // products without options — without this guard a request with
    // skuId=0 / specId='0' reaches the backend and triggers a 500.
    try {
      const req = buildAddToCartRequest();
      if (!req.offerId || req.offerId === 0) {
        showToast(t('product.failedToAdd') || '상품 정보를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.', 'warning');
        return false;
      }
      const skuId = req.skuInfo?.skuId;
      if (!skuId || skuId === 0) {
        // Most likely path here: variations exist on the product but no SKU
        // matched the current selection yet. Tell the user to pick options.
        const variationTypes = getVariationTypes();
        if (variationTypes.length > 0) {
          showToast(t('product.pleaseSelectOptions'), 'warning');
        } else {
          showToast(t('product.failedToAdd') || '상품 정보를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.', 'warning');
        }
        return false;
      }
    } catch {
      showToast(t('product.failedToAdd') || '상품 정보를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.', 'warning');
      return false;
    }

    return true;
  };

  const handleAddToCart = async () => {
    if (!isAuthenticated) {
      navigation.navigate('Auth', {
        screen: 'Login',
        params: {
          returnTo: 'ProductDetail',
          returnParams: {
            productId: productId || offerId,
            offerId: offerId,
            productData: product,
          },
        },
      } as never);
      return;
    }

    if (!validateBeforeCartAction()) {
      return;
    }

    try {
      await addToCart(buildAddToCartRequest(), locale);
    } catch (error: any) {
      showToast(error?.message || t('product.failedToAdd'), 'error');
    }
  };

  const handleBuyNow = async () => {
    if (isBuyingNow) {
      return;
    }

    if (!isAuthenticated) {
      showToast(t('home.pleaseLogin'), 'warning');
      return;
    }

    if (!validateBeforeCartAction()) {
      return;
    }

    try {
      await addToCartForBuyNow(buildAddToCartRequest(), locale);
    } catch (error: any) {
      showToast(error?.message || t('product.failedToProceedToCheckout'), 'error');
    }
  };

  const handleCartIconPress = () => {
    if (!isAuthenticated) {
      return;
    }
    navigation.navigate('Cart');
  };

  const handlePhotoCaptureConfirm = (data: { quantity: number; request: string; photos: string[] }) => {
    // Handle photo capture confirmation
    // In a real app, this would send the data to the server
  };

  const handleSimilarImageSearch = async () => {
    if (!product) return;
    const imageUrl = getApiProductImages(product)[0] || product.image || '';
    if (!imageUrl) {
      showToast(t('product.noProductImageAvailable'), 'error');
      return;
    }
    setIsFetchingBase64(true);
    try {
      const RNFS = require('react-native-fs');
      // Download the remote image to a temp file then read as base64
      const tempPath = `${RNFS.CachesDirectoryPath}/similar_search_${Date.now()}.jpg`;
      await RNFS.downloadFile({ fromUrl: imageUrl, toFile: tempPath }).promise;
      const base64 = await RNFS.readFile(tempPath, 'base64');
      setSimilarSearchUri(imageUrl);
      setSimilarSearchBase64(base64);
      setSimilarSearchVisible(true);
    } catch (e) {
      showToast(t('product.failedToLoadProductImage'), 'error');
    } finally {
      setIsFetchingBase64(false);
    }
  };

  const handleShare = () => {
    if (!shareProductId || !product?.name) {
      showToast(t('product.invalidProductData'), 'error');
      return;
    }
    setShareModalVisible(true);
  };

  const renderHeader = () => {
    return (
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={handleBack}>
          <ArrowBackIcon width={12} height={20} color={COLORS.text.primary} />
        </TouchableOpacity>

        {/* Search bar — fades in on scroll */}
        <Animated.View style={[styles.headerCenter, { opacity: searchBarOpacity }]}>
          <SearchButton
            placeholder={t('category.searchPlaceholder') || 'Search products...'}
            onPress={() => navigation.navigate('Search' as never)}
            style={styles.searchButtonStyle}
            isHomepage={false}
          />
        </Animated.View>

        {/* Camera icon — fades out on scroll */}
        <Animated.View style={[styles.headerCameraIcon, { opacity: cameraIconOpacity }]}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={handleSimilarImageSearch}
            disabled={isFetchingBase64}
          >
            <SearchImageIcon width={30} height={30} color={COLORS.black}/>
          </TouchableOpacity>
        </Animated.View>

        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.headerButton} onPress={handleShare}>
            <ShareAppIcon width={24} height={24} color={COLORS.black} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerButton} onPress={handleCartIconPress}>
            <CartIcon width={24} height={24} color={COLORS.black} />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderImageGallery = () => {
    const apiImages = displayGalleryImages;
    const totalImages = apiImages.length;
    const currentStat = liveStats[currentStatIndex];
    
    if (totalImages === 0) {
      return null;
    }
    
    return (
      <View style={styles.imageGalleryContainer}>
        <ScrollView
          ref={imageGalleryScrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={(e) => {
            const index = Math.round(e.nativeEvent.contentOffset.x / width);
            setSelectedImageIndex(index);
          }}
          scrollEventThrottle={16}
        >
          {apiImages.map((img: string, index: number) => (
            <TouchableOpacity
              key={`image-${img}-${index}`}
              activeOpacity={0.9}
              onPress={() => {
                setViewerImageIndex(index);
                setImageViewerVisible(true);
              }}
            >
              <ProductImage
                uri={img}
                style={styles.productImage as any}
                resizeMode="cover"
              />
            </TouchableOpacity>
          ))}
        </ScrollView>
        
        {/* Image indicators */}
        <View style={styles.imageIndicators}>
          {apiImages.map((img: any, index: number) => (
            <View
              key={`indicator-${index}`}
              style={[
                styles.indicator,
                selectedImageIndex === index && styles.activeIndicator,
              ]}
            />
          ))}
        </View>
        <View style={styles.itemInfoBar}>
          {/* Review badge with star and review count */}
          <View style={styles.reviewBadgeContainer}>
            {/* <View style={styles.reviewBadge}>
              <FamilyStarIcon width={18} height={18} color={COLORS.white} />
              <Text style={[styles.reviewBadgeText, { marginLeft: SPACING.xs }]}>
                {product.rating?.toFixed(1) || '0'}
              </Text>
            </View> */}
            <Text style={styles.itemInfoText}>
              {totalImages}/{selectedImageIndex + 1}
            </Text>
          </View>
          
          <View style={{ flex: 1 }} />
          
          <View style={styles.heartButtonContainer}>
            {wishlistCount !== null && wishlistCount > 0 && (
              <Text style={styles.wishlistCountText}>{wishlistCount}</Text>
            )}
            <TouchableOpacity
              style={styles.heartButton}
              onPress={() => toggleWishlist(product)}
            >
              <HeartPlusIcon
                width={24}
                height={24}
                color={isLiked ? COLORS.red : COLORS.white}
              />
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const handleCopyProductCode = async () => {
    const productCode = (product as any).productCode || 
                       (product as any).offerId || 
                       product.id || 
                       '';
    if (productCode) {
      await Clipboard.setString(productCode);
      setIsCopied(true);
      showToast(t('product.productCodeCopied'), 'success');
      setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    }
  };

  const renderProductInfo = () => {
    // Calculate discount percentage
    const discount = product.originalPrice && product.originalPrice > product.price
      ? Math.round(((product.originalPrice - product.price) / product.originalPrice) * 100)
      : 0;
    
    // Get product code
    const productCode = (product as any).productCode || 
                       (product as any).offerId || 
                       product.id || 
                       '';
    
    // Get soldOut number from product
    const soldOut = (product as any).soldOut || '0';
    
    return (
      <View style={styles.productInfoContainer}>
        <Text style={styles.productName} numberOfLines={2}>
          {product.name || t('product.product')}
        </Text>
        
        {/* Review/Rating Row */}
        <View style={styles.ratingRow}>
          <View style={styles.ratingContainer}>
            <View style={styles.starsContainer}>
              {(() => {
                const rating = product.rating || 0;
                const fullStars = Math.floor(rating);
                const hasHalfStar = rating % 1 >= 0.5;
                const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);
                
                const stars = [];
                // Full stars
                for (let i = 0; i < fullStars; i++) {
                  stars.push(
                    <StarIcon key={`full-${i}`} width={16} height={16} color="#FF5500" />
                  );
                }
                // Half star
                if (hasHalfStar) {
                  stars.push(
                    <StarHalfIcon key="half" width={16} height={16} color="#FF5500" />
                  );
                }
                // Empty stars
                for (let i = 0; i < emptyStars; i++) {
                  stars.push(
                    <StarOutlineIcon key={`empty-${i}`} width={16} height={16} color="#E0E0E0" />
                  );
                }
                return stars;
              })()}
            </View>
            <Text style={styles.ratingText}>
              {product.rating?.toFixed(1) || '0'}
            </Text>
          </View>
          <View style={styles.ratingDivider} />
          <Text style={styles.soldText}>{soldOut || 0} {t('product.sold')}</Text>
          <View style={styles.ratingRowSpacer} />
          <TouchableOpacity
            style={styles.topCategoryLink}
            onPress={handleOpenPlatformCategory}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={topCategoryLabel}
          >
            <Text style={styles.topCategoryLinkText} numberOfLines={1}>
              {topCategoryLabel}
            </Text>
            <Icon name="chevron-forward" size={14} color={COLORS.primary} />
          </TouchableOpacity>
        </View>
        
        {/* Discount and Product Code badges */}
        <View style={styles.badgesRow}>
          {discount > 0 && (
            <View style={styles.discountBadgeInline}>
              <Text style={styles.discountBadgeText}>-{discount}%</Text>
            </View>
          )}
          {productCode && (
            <View style={styles.productCodeBadge}>
              <Text style={styles.productCodeBadgeText}>
                {t('product.productCodeLabel')} {productCode}
              </Text>
              <TouchableOpacity
                onPress={handleCopyProductCode}
                style={styles.copyIconButton}
                accessibilityRole="button"
                accessibilityLabel={t('product.copy')}
              >
                {isCopied ? (
                  <CheckIcon size={18} color={COLORS.red} isSelected={true} />
                ) : (
                  <ContentCopyIcon width={18} height={18} color={COLORS.red} />
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    );
  };
  
  const renderRatingRow = () => {
    // Get soldOut number from product
    const soldOut = (product as any).soldOut || '0';
    
    return (
      <View style={styles.ratingRow}>
        <View style={styles.ratingContainer}>
          <Icon name="star" size={16} color="#FFD700" />
          <Text style={styles.ratingText}>
            {product.rating?.toFixed(1) || '0'}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <Text style={styles.soldText}>{soldOut || 0} sold</Text>
      </View>
    );
  };

  const renderPriceRow = () => {
    const { price, originalPrice } = getSelectedVariationPrice;
    return (
      <View style={styles.priceRow}>
        <Text style={styles.pricePrimary}>{formatPriceCNY(price)}</Text>
        {originalPrice > 0 && originalPrice > price && (
          <Text style={styles.originalPriceRight}>{formatPriceCNY(originalPrice)}</Text>
        )}
      </View>
    );
  };

  const renderProductCode = () => (
    <>
      {/* Product Code with Copy Button */}
      {product.productCode && (
        <View style={styles.productCodeContainer}>
          <Text style={styles.productCodeLabel}>{t('product.productCodeLabel')}</Text>
          <Text style={styles.productCodeText}>{product.productCode}</Text>
          <TouchableOpacity
            style={styles.copyButton}
            onPress={handleCopyProductCode}
            accessibilityRole="button"
            accessibilityLabel={t('product.copy')}
          >
            {isCopied ? (
              <CheckIcon size={16} color="#10B981" isSelected={true} circleColor="#10B981" />
            ) : (
              <ContentCopyIcon width={16} height={16} color={COLORS.primary} />
            )}
            <Text style={[
              styles.copyButtonText,
              isCopied && { color: "#10B981" }
            ]}>
              {isCopied ? t('product.copied') : t('product.copy')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  );


  const renderVariationSelector = (variationType: { name: string; options: Array<{ value: string; image?: string; [key: string]: any }> }, index: number) => {
    const variationName = variationType.name.toLowerCase();
    
    // Get selected value from selectedVariations state
    const selectedValue = selectedVariations[variationName] || null;
    
    const galleryFirst = getApiProductImages(product)[0] || '';
    const isColorSection = isColorVariationType(variationType.name);

    const resolveOptionImage = (option: any): string =>
      normalizeProductImageUrl(option.image || '') || galleryFirst;

    const handleSelect = (value: string, option?: { image?: string }) => {
      setSelectedVariations((prev) => ({
        ...prev,
        [variationName]: value,
      }));

      if (isColorSection) {
        setSelectedColor(value);
        const uri = normalizeProductImageUrl(option?.image || '') || galleryFirst;
        if (uri) {
          syncGalleryToColorUri(uri);
        }
      } else if (variationName === 'size' || /size|尺码|사이즈/i.test(variationType.name)) {
        setSelectedSize(value);
      }
    };

    const handleColorImagePress = (option: any) => {
      const uri = resolveOptionImage(option);
      handleSelect(option.value, option);
      if (uri) {
        syncGalleryToColorUri(uri);
      }
    };

    if (isColorSection) {
      return (
        <View style={styles.selectorContainer}>
          <Text style={styles.selectorTitle}>{variationType.name}{selectedValue ? ` : ${selectedValue}` : ''}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {variationType.options.map((option: any, optIndex: number) => {
              const isSelected = selectedValue === option.value;
              const displayUri = resolveOptionImage(option);
              return (
                <TouchableOpacity
                  key={optIndex}
                  style={styles.colorOption}
                  onPress={() => handleSelect(option.value, option)}
                >
                  {displayUri ? (
                    <TouchableOpacity
                      activeOpacity={0.85}
                      onPress={() => handleColorImagePress(option)}
                    >
                      <ProductImage
                        uri={displayUri}
                        style={[
                          styles.colorImage,
                          isSelected && styles.selectedColorImage,
                        ] as any}
                      />
                    </TouchableOpacity>
                  ) : null}
                  <Text 
                    style={[
                      styles.colorName,
                      isSelected && styles.selectedColorName,
                    ]}
                    numberOfLines={3}
                  >
                    {option.value}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      );
    } else {
      // Render other variation types (or first if no images) as text buttons
      return (
        <View style={styles.selectorContainer}>
          <Text style={styles.selectorTitle}>{variationType.name}{selectedValue ? ` : ${selectedValue}` : ''}</Text>
          <View style={styles.sizeGrid}>
            {variationType.options.map((option: any, optIndex: number) => {
              const isSelected = selectedValue === option.value;
              return (
                <TouchableOpacity
                  key={optIndex}
                  style={[
                    styles.sizeOption,
                    isSelected && styles.selectedSizeOption,
                  ]}
                  onPress={() => handleSelect(option.value)}
                >
                  <Text
                    style={[
                      styles.sizeText,
                      isSelected && styles.selectedSizeText,
                    ]}
                  >
                    {option.value}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      );
    }
  };

  const renderAllVariations = () => {
    const variationTypes = getVariationTypes();
    
    if (variationTypes.length === 0) {
      return null;
    }
    
    return variationTypes.map((variationType, index) => (
      <View key={index} style={{ paddingBottom: SPACING.md}}>
        {renderVariationSelector(variationType, index)}
      </View>
    ));
  };

  const renderServiceCommitment = () => {
    return (
      <View style={styles.serviceCommitmentContainer}>
        <Text style={styles.serviceCommitmentTitle}>
          {t('product.serviceCommitment.title')}
        </Text>
        {/* Choice line at the top */}
        <View style={styles.serviceCommitmentChoice}>
          <Text style={styles.serviceCommitmentChoiceText}>
            {t('product.serviceCommitment.choice')}
          </Text>
          <Text style={styles.serviceCommitmentChoiceContent}>
            {t('product.serviceCommitment.choiceContent')}
          </Text>
        </View>
        
        {/* Title and contents */}
        <View style={styles.serviceCommitmentContent}>
          <View style={styles.serviceCommitmentContentHeader}>
            <View style={styles.serviceCommitmentContentHeaderLeft}>
              <DeliveryIcon width={20} height={20} color={COLORS.text.red} />
              <Text style={styles.serviceCommitmentContentTitle}>
                {t('product.serviceCommitment.title')}
              </Text>
            </View>
            <View style={styles.serviceCommitmentContentHeaderRight}>
              <ArrowRightIcon width={10} height={10} color={COLORS.black} />
            </View>
          </View>
          <View style={styles.serviceCommitmentContentSeparator} >
            <Text style={styles.serviceCommitmentText}>
              Delivery:
            </Text>
            <Text style={[styles.serviceCommitmentText, { fontWeight: '800' }]}>
              Dec 19 - 26
            </Text>
          </View>
          <Text style={[styles.serviceCommitmentText, { marginLeft: SPACING.lg }]}>
            Courier company:
          </Text>
        </View>
      </View>
    );
  };

  const renderSellerInfo = () => {
    // Locale-aware company name. Returns the slot matching the current
    // UI locale (or character-set-matched fallback) — so the Chinese
    // user sees Chinese name even when the backend's product-detail
    // response only carried the English slot.
    const companyName = resolveCompanyDisplayName() || 'Store';
    
    // Get seller rating
    const sellerRating = product.seller?.rating || 
                        (product as any).metadata?.original1688Data?.sellerDataInfo?.compositeServiceScore || 
                        '0';
    
    // Get sold count
    const soldCount = product.orderCount || product.reviewCount || 0;
    const soldText = soldCount >= 1000 
      ? `${Math.floor(soldCount / 1000)},${String(soldCount % 1000).padStart(3, '0')}+` 
      : `${soldCount}+`;
    
    return (
      <View style={styles.sellerInfoContainer}>
        <TouchableOpacity 
          style={styles.sellerHeader}
          onPress={() => {
            const sellerId = product.seller?.id || (product as any).sellerOpenId || '';
            const shopId = source === 'taobao' 
              ? (product.seller?.id || (product as any).shop_id || '')
              : sellerId;
            
            if (shopId) {
              navigation.navigate('SellerProfile', {
                sellerId: shopId,
                sellerName: companyName,
                source: source,
                country: country,
              });
            }
          }}
          activeOpacity={0.7}
        >
          <View style={styles.sellerDetails}>
            <Text style={styles.sellerNameBold}>{companyName}</Text>
            <View style={styles.sellerStatsRow}>
              <View style={styles.sellerRatingContainer}>
                {(() => {
                  const r = typeof sellerRating === 'number' ? sellerRating : parseFloat(sellerRating) || 0;
                  const full = Math.floor(r);
                  const half = r % 1 >= 0.5;
                  const empty = 5 - full - (half ? 1 : 0);
                  const stars: React.ReactNode[] = [];
                  for (let i = 0; i < full; i++) stars.push(<StarIcon key={`sf-${i}`} width={16} height={16} color="#FF5500" />);
                  if (half) stars.push(<StarHalfIcon key="sh" width={16} height={16} color="#FF5500" />);
                  for (let i = 0; i < empty; i++) stars.push(<StarOutlineIcon key={`se-${i}`} width={16} height={16} color="#E0E0E0" />);
                  return stars;
                })()}
                <Text style={styles.sellerRatingText}>
                  {typeof sellerRating === 'number' ? sellerRating.toFixed(1) : sellerRating}
                </Text>
              </View>
              <Text style={styles.sellerSoldText}>| {soldText} sold</Text>
            </View>
          </View>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.followButton, isStoreFollowed && styles.followButtonActive]}
          onPress={handleFollowStore}
          disabled={isFollowingStore || isStoreFollowed}
        >
          {isFollowingStore ? (
            <ActivityIndicator size="small" color={isStoreFollowed ? COLORS.text.primary : COLORS.white} />
          ) : (
            <>
              {!isStoreFollowed && <PlusIcon width={16} height={16} color={COLORS.white} />}
              <Text style={[styles.followButtonText, isStoreFollowed && styles.followButtonTextActive]}>
                {isStoreFollowed ? 'Following' : 'Follow'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    );
  };


  const renderReviews = () => (
    <View style={styles.reviewsContainer}>
      <View style={styles.reviewsHeader}>
        <Text style={styles.reviewsTitle}>{t('product.reviewsCount').replace('{count}', product.ratingCount || '5.5K')}</Text>
        <TouchableOpacity onPress={() => navigation.navigate('Reviews', { productId })}>
          <Text style={styles.seeAllText}>{t('product.seeAll')}</Text>
        </TouchableOpacity>
      </View>

      {(product.reviews || []).slice(0, 2).map((review: any, index: number) => (
        <View key={review.id || `review-${index}`} style={styles.reviewItem}>
          <View style={styles.reviewHeader}>
            <Image
              source={{ uri: 'https://picsum.photos/seed/user/50/50' }}
              style={styles.reviewAvatar as any}
            />
            <View style={styles.reviewUserInfo}>
              <Text style={styles.reviewUserName}>{review.user || 'Artimus'}</Text>
              <View style={styles.reviewRating}>
                {[...Array(5)].map((_, i) => (
                  <Icon
                    key={i}
                    name="star"
                    size={12}
                    color={i < (review.rating || 5) ? '#FFD700' : COLORS.gray[300]}
                  />
                ))}
              </View>
            </View>
          </View>
          <Text style={styles.reviewText}>
            {review.comment || 'This product is absolutely Great.'}
          </Text>
        </View>
      ))}
    </View>
  );

  const renderProductDetails = () => {
    // Use product attributes from API (productAttribute with attributeNameTrans and valueTrans)
    const attributes = product.attributes || [];
    
    // Extract images from HTML description
    const descriptionImages = product.description ? extractImagesFromHtml(product.description) : [];
    
    // Strip HTML tags and get plain text
    const stripHtml = (html: string) => {
      if (!html) return '';
      return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Remove styles
        .replace(/<[^>]*>/g, ' ') // Remove HTML tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    };
    
    const plainText = product.description ? stripHtml(product.description) : '';
    
    // Return null if no attributes and no description
    if (attributes.length === 0 && !product.description) {
      return null;
    }
    
    const INITIAL_SPECS_COUNT = 5; // Show first 5 specifications initially
    const shouldShowReadMore = attributes.length > INITIAL_SPECS_COUNT;
    const displayedSpecs = showFullSpecifications 
      ? attributes 
      : attributes.slice(0, INITIAL_SPECS_COUNT);
    
    return (
      <View style={styles.detailsContainer}>
        {/* Header with title and report link */}
        <View style={styles.detailsHeader}>
          <Text style={styles.detailsTitle}>{t('product.productDetails')}</Text>
          <TouchableOpacity>
            <Text style={styles.reportItemText}>{t('product.reportItem')}</Text>
          </TouchableOpacity>
        </View>
        
        {/* Specifications Section */}
        {attributes.length > 0 && (
          <View style={styles.specificationsContainer}>
            <Text style={styles.sectionSubtitle}>{t('product.specifications')}{" >"}</Text>
            {displayedSpecs.map((attr: any, index: number) => (
              <View key={`${attr.name || 'spec'}-${index}`} style={styles.detailRow}>
                <Text style={styles.detailLabel}>{attr.name || ''}</Text>
                <Text style={styles.detailValue} numberOfLines={0}>{attr.value || ''}</Text>
              </View>
            ))}
            {shouldShowReadMore && (
              <TouchableOpacity onPress={() => setShowFullSpecifications(!showFullSpecifications)}>
                <Text style={styles.readMoreText}>
                  {showFullSpecifications ? t('product.readLess') : t('product.readMore')}
                </Text>
              </TouchableOpacity>
            )}
          </ View >
        )}
        
        {/* Product Description Section */}
        {product.description && (
          <>
            {/* {attributes.length > 0 && <View style={styles.sectionSeparator} />} */}
            {/* <Text style={styles.sectionSubtitle}>{t('product.productDescription')}</Text> */}
            <View style={styles.htmlContentContainer}>
              {/* Description images — windowed via `descriptionImagesShown`
                  so only a few <ProductImage>'s mount on first paint. The
                  background timer in the useEffect above grows the window
                  automatically; the "Show more" button lets the user jump
                  to the full list if they're impatient. */}
              {descriptionImages.length > 0 && (
                <View style={styles.descriptionImagesContainer}>
                  {descriptionImages
                    .slice(0, descriptionImagesShown)
                    .map((imgUrl: string, index: number) => (
                      // Each image fades in the first time it mounts. Images
                      // that were already on screen keep their existing
                      // Animated.Value (mounted = true), so only the new
                      // batch added by the timer animates — earlier ones
                      // stay put without re-animating.
                      <RevealOnMount key={index} duration={220} translateY={12}>
                        <ProductImage
                          uri={imgUrl}
                          style={styles.descriptionImage as any}
                          resizeMode="contain"
                        />
                      </RevealOnMount>
                    ))}
                  {descriptionImagesShown < descriptionImages.length && (
                    <TouchableOpacity
                      onPress={() =>
                        setDescriptionImagesShown(descriptionImages.length)
                      }
                      style={{ paddingVertical: SPACING.sm, alignItems: 'center' }}
                    >
                      <Text style={styles.readMoreText}>
                        {t('product.readMore')}
                        {' ('}
                        {descriptionImages.length - descriptionImagesShown}
                        {')'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
              
              {/* Display plain text description */}
              {plainText && (
                <View style={styles.descriptionTextContainer}>
                  <Text style={styles.descriptionText} numberOfLines={3}>{plainText}</Text>
                </View>
              )}
            </View>
          </>
        )}
      </View>
    );
  };

  const renderRelatedProducts = () => {
    const isLoading = source === 'taobao' ? searchProductsLoading : relatedRecommendationsLoading;
    if (relatedProducts.length === 0 && !isLoading) {
      return null;
    }
    
    return (
      <View style={styles.similarProductsContainer}>
        <Text style={styles.similarProductsTitle}>{t('home.moreToLove')}</Text>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={COLORS.primary} />
            <Text style={styles.loadingText}>{t('product.loadingProduct')}</Text>
          </View>
        ) : (
          <FlatList
            data={relatedProducts}
            renderItem={({ item }) => {
              // Taobao case: show only image, name and price as requested
              if (selectedPlatform === 'taobao') {
                return (
                  <TouchableOpacity
                    style={styles.similarProductItem}
                    onPress={() => {
                      const productIdToUse = (item as any).offerId || item.id;
                      const source = (item as any).source || 'taobao';
                      // zh → en: backend's /products/detail doesn't accept
                      // country=zh, so collapse to 'en' for the pushed page.
                      const country = locale === 'ko' ? 'ko' : 'en';
                      // Prefetch the recommended card's image and forward it
                      // — gives the pushed ProductDetail an instant hero.
                      openProductDetail(
                        navigation,
                        {
                          productId: productIdToUse?.toString() || item.id?.toString() || '',
                          offerId: (item as any).offerId?.toString(),
                          source,
                          country,
                          thumbnailUrl: (item as any).image,
                        },
                        { usePush: true },
                      );
                    }}
                  >
                    <View style={styles.simpleTaobaoCard}>
                      <ProductImage
                        uri={(item as any).image}
                        style={styles.simpleTaobaoImage as any}
                        resizeMode="cover"
                      />
                      <Text
                        style={styles.simpleTaobaoTitle}
                        numberOfLines={2}
                      >
                        {(item as any).name}
                      </Text>
                      <Text style={styles.simpleTaobaoPrice}>
                        {formatPriceCNY(Number((item as any).price || 0))}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }

              // Default (1688 etc.) uses existing ProductCard
              return (
                <View style={styles.similarProductItem}>
                  <ProductCard
                    product={item}
                    variant="moreToLove"
                    onPress={() => {
                      const productIdToUse = (item as any).offerId || item.id;
                      const source = (item as any).source || selectedPlatform || '1688';
                      // zh → en: backend's /products/detail doesn't accept
                      // country=zh, so collapse to 'en' for the pushed page.
                      const country = locale === 'ko' ? 'ko' : 'en';
                      openProductDetail(
                        navigation,
                        {
                          productId: productIdToUse?.toString() || item.id?.toString() || '',
                          offerId: (item as any).offerId?.toString(),
                          source,
                          country,
                          thumbnailUrl: (item as any).image,
                        },
                        { usePush: true },
                      );
                    }}
                    onLikePress={() => toggleWishlist(item)}
                    isLiked={isProductLiked(item)}
                  />
                </View>
              );
            }}
            keyExtractor={(item, index) => `related-${item.id?.toString() || (item as any).offerId?.toString() || index}-${index}`}
            numColumns={2}
            scrollEnabled={false}
            nestedScrollEnabled={true}
            columnWrapperStyle={styles.similarProductsGrid}
            removeClippedSubviews={true}
            maxToRenderPerBatch={6}
            windowSize={5}
            initialNumToRender={6}
            updateCellsBatchingPeriod={50}
            // Warm the cache for cards as they enter the viewport.
            onViewableItemsChanged={handleRelatedViewable}
            viewabilityConfig={{ itemVisiblePercentThreshold: 30 }}
          />
        )}
      </View>
    );
  };


  const renderSimilarProducts = () => {
    if (similarProducts.length === 0 && !similarProductsLoadingMore) {
      return null;
    }
    
    return (
    <View style={styles.similarProductsContainer}>
        <Text style={styles.similarProductsTitle}>{t('home.moretolove')}</Text>
        <FlatList
          data={similarProducts}
          renderItem={renderSimilarProductItem}
          keyExtractor={similarProductsKeyExtractor}
          numColumns={2}
          scrollEnabled={false}
          nestedScrollEnabled={true}
          columnWrapperStyle={styles.similarProductsGrid}
          onEndReached={loadMoreSimilarProducts}
          onEndReachedThreshold={0.5}
          ListFooterComponent={renderSimilarProductsFooter}
          removeClippedSubviews={true}
          maxToRenderPerBatch={6}
          windowSize={5}
          initialNumToRender={6}
          updateCellsBatchingPeriod={50}
        />
    </View>
  );
  };

  const renderBottomBar = () => { 
    const companyName = (product as any).metadata?.original1688Data?.companyName || 
                        product.seller?.name || 
                        'Store';
    // 수량+재고 / 액션버튼을 각각 한 번만 정의해 폰(2줄)·태블릿(1줄) 양쪽에서 재사용.
    const quantityStockBlock = (
      <View style={styles.quantityWithStock}>
        <View style={styles.quantitySelector}>
          <TouchableOpacity
            style={styles.quantityButton}
            onPress={() => handleQuantityChange(false)}
          >
            <MinusIcon width={18} height={18} color={COLORS.text.primary} />
          </TouchableOpacity>
          <TextInput
            style={styles.quantityText}
            value={String(quantity)}
            onChangeText={handleQuantityInput}
            onBlur={handleQuantityBlur}
            keyboardType="number-pad"
            returnKeyType="done"
            selectTextOnFocus
            maxLength={7}
          />
          <TouchableOpacity
            style={styles.quantityButton}
            onPress={() => handleQuantityChange(true)}
          >
            <PlusIcon width={18} height={18} color={COLORS.text.primary} />
          </TouchableOpacity>
        </View>
        {displayStock != null && (
          <Text style={styles.quantityStockText}>
            {locale === 'ko' ? `재고 ${displayStock.toLocaleString()}`
              : locale === 'zh' ? `库存 ${displayStock.toLocaleString()}`
              : `Stock ${displayStock.toLocaleString()}`}
          </Text>
        )}
      </View>
    );
    const actionButtonsBlock = (
      <View style={[styles.actionButtonsGroup, responsive.isTablet ? styles.actionButtonsGroupTablet : styles.actionButtonsGroupPhone]}>
        <TouchableOpacity
          style={[
            styles.actionButton,
            styles.addToCartButton,
            !canAddToCart && styles.disabledButton,
          ]}
          disabled={isAddingToCart}
          onPress={() => {
            handleAddToCart();
          }}
        >
          {isAddingToCart ? (
            <View style={styles.actionButtonContent}>
              <ActivityIndicator size="small" color={COLORS.black} />
              <Text style={styles.addToCartText}>{t('product.addingToCart')}</Text>
            </View>
          ) : (
            <Text style={styles.addToCartText} numberOfLines={1}>
              {t('product.addToCart')}
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.actionButton,
            styles.buyNowButton,
            !canAddToCart && styles.disabledButton,
          ]}
          disabled={!canAddToCart}
          onPress={() => {
            if (!isAuthenticated) {
              navigation.navigate('Auth', {
                screen: 'Login',
                params: {
                  returnTo: 'ProductDetail',
                  returnParams: {
                    productId: productId || offerId,
                    offerId: offerId,
                    productData: product,
                  },
                },
              } as never);
              return;
            }

            handleBuyNow();
          }}
        >
          {isBuyingNow ? (
            <View style={styles.actionButtonContent}>
              <ActivityIndicator size="small" color={COLORS.white} />
              <Text style={styles.buyNowText}>{t('product.buyNow')}</Text>
            </View>
          ) : (
            <Text style={styles.buyNowText} numberOfLines={1}>
              {t('product.buyNow')}
            </Text>
          )}
        </TouchableOpacity>
      </View>
    );
    return(
    <View style={[styles.bottomBar, { paddingBottom: responsive.isTablet ? SPACING.lg + insets.bottom : Math.max(insets.bottom - SPACING.md, SPACING.xs) }]}>
      {/* 아이폰: 수량/재고를 맨 윗줄에 단독 배치 (아래 아이콘/버튼 줄과 분리) */}
      {!responsive.isTablet && (
        <View style={styles.phoneQuantityRow}>
          {quantityStockBlock}
        </View>
      )}
      {/* 아이콘(좌) + (폰)담기/구매 / (태블릿)수량+버튼 */}
      <View style={styles.mainActionRow}>
        <View style={{flexDirection: 'row', alignItems: 'center', gap: SPACING.sm}}>
          <TouchableOpacity 
            style={styles.cameraButton}
            onPress={() => {
              const sellerId = product.seller?.id || (product as any).sellerOpenId || '';
              const shopId = source === 'taobao' 
                ? (product.seller?.id || (product as any).shop_id || '')
                : sellerId;
              
              if (shopId) {
                navigation.navigate('SellerProfile', {
                  sellerId: shopId,
                  sellerName: companyName,
                  source: source,
                  country: country,
                });
              }
            }}
          >
            <SellerShopIcon width={30} height={30} color={COLORS.text.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.supportAgentButton}
            onPress={() =>
              // Open the Message tab and land on its second tab (1:1 / general
              // inquiry), so tapping this icon from a product page goes straight
              // to the user's general inquiry list.
              navigation.navigate('Main', {
                screen: 'Message',
                params: { initialTab: 'general' },
              })
            }
          >
            <SupportAgentIcon width={30} height={30} color={COLORS.text.primary} />
          </TouchableOpacity>
          
          {/* Cart Icon Button */}
          <TouchableOpacity 
            style={styles.cartIconButton}
            onPress={() => toggleWishlist(product)}
          >
            {/* <Ionicons name="cart-outline" size={22} color={COLORS.text.primary} /> */}
            <HeartIcon 
              width={30} 
              height={30} 
              color={isLiked ? COLORS.red : COLORS.black} 
            />
          </TouchableOpacity>
        </View>
        {responsive.isTablet ? (
          /* 태블릿: 수량/재고 + 버튼을 한 줄(버튼 바로 왼쪽에 수량/재고) */
          <View style={styles.bottomRightGroup}>
            {quantityStockBlock}
            {actionButtonsBlock}
          </View>
        ) : (
          /* 아이폰: 이 줄(아이콘 옆)엔 담기/구매 버튼. 수량/재고는 윗줄로 분리됨 */
          actionButtonsBlock
        )}
      </View>
    </View>
  );}

  const renderImageViewer = () => {
    const images = displayGalleryImages;
    
    return (
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={imageViewerVisible}
        transparent={false}
        animationType="fade"
        onRequestClose={() => setImageViewerVisible(false)}
      >
        <View style={styles.imageViewerContainer}>
          <StatusBar barStyle="light-content" backgroundColor="#000" />
          
          {/* Close button */}
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => setImageViewerVisible(false)}
          >
            <Icon name="close" size={32} color={COLORS.white} />
          </TouchableOpacity>

          {/* Image counter */}
          <View style={styles.imageCounter}>
            <Text style={styles.imageCounterText}>
              {viewerImageIndex + 1} / {images.length}
            </Text>
          </View>

          {/* Full screen image gallery */}
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={(e) => {
              const index = Math.round(e.nativeEvent.contentOffset.x / width);
              setViewerImageIndex(index);
            }}
            scrollEventThrottle={16}
            contentOffset={{ x: viewerImageIndex * width, y: 0 }}
          >
            {images.map((img: string, index: number) => (
              <View key={`fullscreen-${img}-${index}`} style={styles.fullScreenImageContainer}>
                <ProductImage
                  uri={img}
                  style={styles.fullScreenImage as any}
                  resizeMode="contain"
                />
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    );
  };

  return (
    <View style={styles.container}>
      {/* Absolutely positioned header overlays the image; top fills white on scroll */}
      <Animated.View
        style={[
          styles.safeArea,
          { paddingTop: insets.top, backgroundColor: headerBg },
        ]}
        pointerEvents="box-none"
      >
        {renderHeader()}
      </Animated.View>

      {/*
        RecyclerView-style layout: each screen section is one item in the
        FlatList, so React Native's virtualizer can unmount sections that
        scroll off-screen (instead of keeping the entire page mounted as a
        plain ScrollView would).

        Heavy sections that aren't visible on first paint (`productDetails`,
        `relatedProducts`) are wrapped in <LazyMount> so their subtree is
        deferred until after interactions, keeping the initial paint cheap.
      */}
      {(() => {
        // Stage-gated section list. Each section only enters the data array
        // once `revealStage` has advanced far enough to allow it. Sections
        // that aren't in the array are not rendered at all — this is what
        // makes the first frame cheap (just the four critical sections
        // instead of the full page tree).
        const sections: Array<{
          key: string;
          render: () => React.ReactNode;
          lazy?: boolean;
          placeholderHeight?: number;
          /** Wrap with <RevealOnMount> so the section fades + lifts into
           *  place on first mount instead of popping in. Stage-0 critical
           *  sections skip this so they paint instantly. */
          reveal?: boolean;
        }> = [
          // stage 0 — critical path, always shown (no reveal animation;
          // these are the first thing the user sees, must not be delayed)
          { key: 'gallery', render: renderImageGallery },
          { key: 'info', render: renderProductInfo },
          { key: 'price', render: renderPriceRow },
          { key: 'variations', render: renderAllVariations },
        ];

        const sellerEligible =
          routeSource !== 'live-commerce' && routeSource !== 'live';

        // stage 1 — seller card
        if (revealStage >= 1 && sellerEligible) {
          sections.push({ key: 'seller', render: renderSellerInfo, reveal: true });
        }

        // stage 2 — product details (HTML + description images, heaviest)
        if (revealStage >= 2) {
          sections.push({
            key: 'details',
            render: renderProductDetails,
            lazy: true,
            placeholderHeight: 320,
            reveal: true,
          });
        }

        // stage 3 — related products grid
        if (revealStage >= 3) {
          sections.push({
            key: 'related',
            render: renderRelatedProducts,
            lazy: true,
            placeholderHeight: 480,
            reveal: true,
          });
        }

        return (
          <Animated.FlatList
            style={styles.scrollView}
            data={sections}
            extraData={revealStage}
            keyExtractor={(s) => s.key}
            renderItem={({ item }) => {
              // Inner content: deferred mount for heavy sections, immediate
              // for the rest. Either way it ends up wrapped by RevealOnMount
              // when `item.reveal` is set, so the section fades + lifts into
              // place when it first appears.
              const content = item.lazy ? (
                <LazyMount
                  minHeight={item.placeholderHeight}
                  placeholder={<View style={{ minHeight: item.placeholderHeight }} />}
                >
                  {item.render()}
                </LazyMount>
              ) : (
                <>{item.render()}</>
              );

              return item.reveal ? <RevealOnMount>{content}</RevealOnMount> : content;
            }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 200 + insets.bottom }}
            scrollEventThrottle={16}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { y: scrollY } } }],
              { useNativeDriver: false },
            )}
            // Virtualization tuning — first paint shows gallery+info+price+
            // variations, the rest are mounted as the user scrolls.
            initialNumToRender={4}
            maxToRenderPerBatch={2}
            windowSize={5}
            removeClippedSubviews
            updateCellsBatchingPeriod={50}
          />
        );
      })()}

      {renderBottomBar()}
      {renderImageViewer()}

      <ProductShareModal
        visible={shareModalVisible}
        onClose={() => setShareModalVisible(false)}
        productUrl={productShareUrl}
        productName={product?.name || ''}
        shareMessage={productShareMessage}
        onShareError={(msg) => showToast(msg, 'error')}
      />

      {/* Similar product image search modal */}
      {similarSearchVisible && (
        <ImageSearchResultsModal
          visible={similarSearchVisible}
          onClose={() => setSimilarSearchVisible(false)}
          imageUri={similarSearchUri}
          imageBase64={similarSearchBase64}
        />
      )}

      <PhotoCaptureModal
        visible={photoCaptureVisible}
        onClose={() => setPhotoCaptureVisible(false)}
        onConfirm={handlePhotoCaptureConfirm}
        product={{
          id: product.id,
          name: product.name,
          image: product.images?.[0] || product.image,
          price: product.price,
        }}
      />

      {/* Unfollow Confirmation Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showUnfollowModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowUnfollowModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Unfollow</Text>
            <Text style={styles.modalMessage}>Are you sure you want to unfollow?</Text>
            
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowUnfollowModal(false)}
                disabled={isFollowingStore}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={styles.confirmButton}
                onPress={performUnfollowAction}
                disabled={isFollowingStore}
              >
                {isFollowingStore ? (
                  <ActivityIndicator size="small" color={COLORS.white} />
                ) : (
                  <Text style={styles.confirmButtonText}>Confirm</Text>
                )}
              </TouchableOpacity>
            </View>
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
  safeArea: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: SPACING.md,
    paddingBottom: SPACING.xs,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerCenter: {
    flex: 1,
  },
  headerCameraIcon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: SPACING.sm,
  },
  searchButtonStyle: {
    // flex: 1,
    height: 40,
    marginRight: SPACING.sm,
  },
  scrollView: {
    flex: 1,
  },
  imageGalleryContainer: {
    position: 'relative',
  },
  productImage: {
    width: width,
    height: IMAGE_HEIGHT,
    backgroundColor: COLORS.gray[100],
  },
  imageIndicators: {
    position: 'absolute',
    bottom: SPACING.md,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: SPACING.xs,
  },
  indicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.white,
    opacity: 0.5,
  },
  activeIndicator: {
    opacity: 1,
  },
  liveStatBadge: {
    position: 'absolute',
    bottom: 70,
    left: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 20,
    maxWidth: width - SPACING.md * 2,
  },
  liveStatIconContainer: {
    marginRight: SPACING.xs,
  },
  liveStatBadgeText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.white,
    fontWeight: '500',
  },
  itemInfoBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  itemInfoText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  itemInfoSeparator: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.gray[400],
    marginHorizontal: SPACING.sm,
  },
  reviewBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    padding: SPACING.xs,
    paddingHorizontal: SPACING.smmd,
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.full,
    ...SHADOWS.small,
  },
  reviewBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.yellow,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.full,
  },
  reviewBadgeText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.white,
    fontWeight: '600',
  },
  heartButtonContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  heartButton: {
    padding: SPACING.xs,
    backgroundColor: '#00000066',
    borderRadius: BORDER_RADIUS.full,
    ...SHADOWS.small,
  },
  wishlistCountText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
    backgroundColor: '#FFFFFF33',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.full,
    ...SHADOWS.small,
  },
  productInfoContainer: {
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.smmd,
    paddingBottom: SPACING.sm,
    marginTop: 0,
  },
  productName: {
    fontSize: FONTS.productDetailSizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: 0,
  },
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: SPACING.xs,
  },
  discountBadgeInline: {
    backgroundColor: COLORS.red,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  discountBadgeText: {
    fontSize: FONTS.productDetailSizes.xs,
    color: COLORS.white,
    fontWeight: '600',
  },
  productCodeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.lightRed,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.sm,
  },
  productCodeBadgeText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.red,
    fontWeight: '600',
    marginRight: SPACING.xs,
  },
  copyIconButton: {
    padding: 2,
  },
  productDescription: {
    fontSize: FONTS.productDetailSizes.md,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.productDetailSizes.md * 20 / 16),
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  soldOutText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    marginTop: SPACING.xs,
    fontWeight: '500',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
    marginTop: SPACING.xs,
  },
  ratingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: SPACING.sm,
  },
  starsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  ratingText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    marginLeft: SPACING.xs,
  },
  soldText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    marginRight: SPACING.sm,
  },
  ratingDivider: {
    width: 1,
    height: 16,
    backgroundColor: COLORS.gray[500],
    marginRight: SPACING.sm,
  },
  ratingRowSpacer: {
    flex: 1,
    minWidth: SPACING.xs,
  },
  topCategoryLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    maxWidth: '42%',
  },
  topCategoryLinkText: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '600',
    color: COLORS.primary,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
  },
  price: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.red,
    marginRight: SPACING.sm,
  },
  pricePrimary: {
    fontSize: 24,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginRight: SPACING.sm,
  },
  originalPrice: {
    fontSize: FONTS.productDetailSizes.md,
    color: COLORS.gray[500],
    textDecorationLine: 'line-through',
    marginRight: SPACING.sm,
  },
  originalPriceRight: {
    fontSize: FONTS.productDetailSizes.md,
    color: COLORS.gray[500],
    textDecorationLine: 'line-through',
    marginLeft: 'auto',
  },
  discountBadge: {
    backgroundColor: COLORS.red,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: BORDER_RADIUS.sm,
  },
  discountText: {
    fontSize: FONTS.productDetailSizes.xs,
    color: COLORS.white,
    fontWeight: '600',
  },
  productCodeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.md,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
  },
  productCodeLabel: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  productCodeText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    fontWeight: '600',
    flex: 1,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.gray[100],
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.md,
    gap: SPACING.xs,
  },
  copyButtonText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.primary,
    fontWeight: '600',
  },
  selectorContainer: {
    padding: SPACING.md,
    paddingBottom: 0,
  },
  selectorTitle: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
  },
  colorOption: {
    alignItems: 'center',
    marginRight: SPACING.md,
  },
  colorImage: {
    width: 60,
    height: 60,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.xs,
    borderWidth: 2,
    borderColor: COLORS.gray[300],
  },
  selectedColorImage: {
    borderColor: COLORS.red,
    borderWidth: 3,
  },
  colorName: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
    textAlign: 'center',
    maxWidth: 80,
  },
  selectedColorName: {
    color: COLORS.red,
    fontWeight: '600',
  },
  sizeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  sizeOption: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    backgroundColor: COLORS.white,
  },
  selectedSizeOption: {
    borderColor: COLORS.red,
    backgroundColor: COLORS.white,
  },
  sizeText: {
    fontSize: FONTS.productDetailSizes.md,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  selectedSizeText: {
    color: COLORS.red,
    fontWeight: '600',
  },
  serviceCommitmentContainer: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderColor: COLORS.gray[100],
    marginTop: SPACING.md,
  },
  serviceCommitmentChoice: {
    marginBottom: SPACING.sm,
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: SPACING.sm,
    backgroundColor: '#E1FEEE',
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: '#0000000D',
  },
  serviceCommitmentChoiceText: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '900',
    color: COLORS.white,
    backgroundColor: COLORS.text.red,
    padding: SPACING.sm,
    paddingVertical: 0,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1,
    borderColor: '#0000000D',
  },
  serviceCommitmentChoiceContent: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '900',
    color: COLORS.text.primary,
  },
  serviceCommitmentContent: {
    marginTop: SPACING.xs,
  },
  serviceCommitmentContentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  serviceCommitmentContentHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  serviceCommitmentContentHeaderRight: {
    alignItems: 'center',
  },
  serviceCommitmentContentSeparator: {
    marginLeft: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  serviceCommitmentContentTitle: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
    color: COLORS.black,
  },
  serviceCommitmentTitle: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
    color: COLORS.text.red,
    marginBottom: SPACING.xs,
  },
  serviceCommitmentText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.productDetailSizes.sm * 20 / 14),
  },
  sellerInfoContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
    borderBottomWidth: 5,
    borderTopWidth: 5,
    borderColor: COLORS.gray[100],
    backgroundColor: COLORS.white,
  },
  sellerHeader: {
    flex: 1,
    marginRight: SPACING.md,
  },
  sellerDetails: {
    flex: 1,
    marginRight: SPACING.md,
  },
  sellerInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sellerNameBold: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
  },
  sellerStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  sellerRatingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  sellerRatingText: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginLeft: SPACING.xs,
  },
  sellerSoldText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '400',
  },
  sellerStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: SPACING.md,
  },
  sellerStatsText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    marginLeft: SPACING.xs,
  },
  followButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.text.primary,
    borderRadius: 20,
    gap: SPACING.xs,
    minWidth: 100,
  },
  followButtonActive: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
  },
  followButtonText: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '600',
    color: COLORS.white,
  },
  followButtonTextActive: {
    color: COLORS.text.primary,
  },
  reviewsContainer: {
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  reviewsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  reviewsTitle: {
    fontSize: FONTS.productDetailSizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  seeAllText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.primary,
    fontWeight: '500',
  },
  reviewItem: {
    marginBottom: SPACING.md,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  reviewAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: SPACING.sm,
  },
  reviewUserInfo: {
    flex: 1,
  },
  reviewUserName: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: 2,
  },
  reviewRating: {
    flexDirection: 'row',
    gap: 2,
  },
  reviewText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    lineHeight: Math.round(FONTS.productDetailSizes.sm * 20 / 14),
  },
  detailsContainer: {
    padding: SPACING.lg,
  },
  detailsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  detailsTitle: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  reportItemText: {
    fontSize: FONTS.productDetailSizes.xs,
    fontWeight: '400',
    color: COLORS.text.primary,
  },
  specificationsContainer: {
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.md,
  },
  sectionSubtitle: {
    fontSize: FONTS.productDetailSizes.sm,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
    paddingLeft: SPACING.md,
  },
  sectionSeparator: {
    height: 1,
    backgroundColor: COLORS.gray[200],
    marginVertical: SPACING.md,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderTopWidth: 1,
    borderColor: COLORS.gray[200],
  },
  detailLabel: {
    fontSize: FONTS.productDetailSizes.xs,
    color: COLORS.text.primary,
    width: '35%',
    height: '100%',
    marginRight: SPACING.md,
    borderRightWidth: 1,
    borderColor: COLORS.gray[200],
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    backgroundColor: COLORS.gray[50],
    textAlignVertical: 'center',
  },
  detailValue: {
    fontSize: FONTS.productDetailSizes.xs,
    color: COLORS.text.primary,
    fontWeight: '400',
    height: '100%',
    width: '60%',
    flexWrap: 'wrap',
    textAlign: 'left',
    paddingVertical: SPACING.sm,
    textAlignVertical: 'center',
  },
  readMoreText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.primary,
    textDecorationLine: 'underline',
    paddingHorizontal: SPACING.md,
    textAlign: 'center',
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderColor: COLORS.gray[200],
  },
  productImagesContainer: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  productImagesTitle: {
    fontSize: FONTS.productDetailSizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  productDescriptionContainer: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    backgroundColor: COLORS.white,
  },
  productDescriptionTitle: {
    fontSize: FONTS.productDetailSizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
  },
  htmlContentContainer: {
    width: '100%',
    backgroundColor: COLORS.white,
  },
  descriptionImagesContainer: {
    width: '100%',
    marginVertical: SPACING.md,
  },
  descriptionImage: {
    width: '100%',
    height: 300,
    marginBottom: SPACING.md,
    backgroundColor: COLORS.gray[100],
    borderRadius: BORDER_RADIUS.md,
  },
  descriptionTextContainer: {
    width: '100%',
  },
  descriptionText: {
    fontSize: FONTS.productDetailSizes.md,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.productDetailSizes.md * 24 / 16),
  },
  similarProductsContainer: {
    padding: SPACING.sm,
  },
  similarProductsTitle: {
    fontSize: FONTS.productDetailSizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  loadingContainer: {
    paddingVertical: SPACING.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: SPACING.md,
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
  },
  similarProductsGrid: {
    justifyContent: 'flex-start',
    gap: SPACING.sm,
  },
  simpleTaobaoCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: SPACING.sm,
    margin: SPACING.xs,
    ...SHADOWS.small,
  },
  simpleTaobaoImage: {
    width: '100%',
    height: 150,
    borderRadius: 10,
    marginBottom: SPACING.xs,
    backgroundColor: COLORS.background,
  },
  simpleTaobaoTitle: {
    fontSize: 12,
    color: COLORS.text.primary,
    marginTop: SPACING.xs,
  },
  simpleTaobaoPrice: {
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.primary,
    marginTop: SPACING.xs,
  },
  similarProductItem: {
    width: (width - SPACING.sm * 2 - SPACING.sm) / 2,
  },
  loadingMoreContainer: {
    paddingVertical: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  loadingMoreText: {
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    marginLeft: SPACING.sm,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.lg,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
    ...SHADOWS.lg,
  },
  topActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  // 태블릿: 하단 액션 행(수량+장바구니/바로구매)을 화면 전체로 늘이지 않고
  // 보기 좋은 최대 너비로 제한해 중앙정렬 — 버튼이 과하게 길어지지 않게 한다.
  topActionRowTablet: {
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },
  quantitySelector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.gray[50],
    borderRadius: 25,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    paddingHorizontal: SPACING.xs,
    paddingVertical: 2,
  },
  // 수량 컨트롤 + 재고 라벨을 한 줄로 묶는 wrapper.
  quantityWithStock: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // 재고 표시 — 수량 컨트롤 오른쪽 옆.
  quantityStockText: {
    marginLeft: SPACING.sm,
    fontSize: FONTS.productDetailSizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  quantityButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    margin: 3,
    ...SHADOWS.small,
  },
  quantityText: {
    fontSize: FONTS.productDetailSizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
    paddingHorizontal: SPACING.lg,
    // TextInput 의 기본 vertical padding 을 제거하여 +/- 버튼 행 높이와 정렬.
    paddingVertical: 0,
    minWidth: 56,
    textAlign: 'center',
  },
  supportAgentButton: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  cameraButton: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  cartIconButton: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  mainActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  // 수량/재고 + 장바구니/바로구매 버튼을 한 묶음으로 (수량이 버튼 바로 왼쪽).
  // justifyContent: 'flex-end' — 묶음을 오른쪽 끝으로 치우치게 한다.
  bottomRightGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: SPACING.sm,
    marginLeft: SPACING.sm,
  },
  actionButtonsGroup: {
    flex: 1,
    flexDirection: 'row',
    marginLeft: SPACING.sm,
  },
  // 태블릿: 장바구니/바로구매 버튼 그룹의 길이를 360px 이하로 제한.
  actionButtonsGroupTablet: {
    maxWidth: 360,
  },
  // 아이폰: 버튼 그룹을 아랫줄에서 전체너비로 (왼쪽 여백 제거).
  actionButtonsGroupPhone: {
    marginLeft: 0,
  },
  // 아이폰: 수량/재고 전용 윗줄 (왼쪽 정렬).
  phoneQuantityRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: SPACING.sm,
  },
  actionButton: {
    flex: 1,
    minHeight: 28,
    paddingVertical: 5,
    paddingHorizontal: 8,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#00000033',
  },
  actionButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  addToCartButton: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: BORDER_RADIUS.full,
    borderBottomLeftRadius: BORDER_RADIUS.full,
    borderRightWidth: 0,
  },
  addToCartText: {
    fontSize: FONTS.productDetailSizes.smmd,
    fontWeight: '700',
    color: COLORS.black,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  buyNowButton: {
    backgroundColor: COLORS.red,
    borderTopRightRadius: BORDER_RADIUS.full,
    borderBottomRightRadius: BORDER_RADIUS.full,
    borderLeftWidth: 0,
  },
  buyNowText: {
    fontSize: FONTS.productDetailSizes.smmd,
    fontWeight: '700',
    color: COLORS.white,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  disabledButton: {
    opacity: 0.5,
  },
  imageViewerContainer: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: SPACING.lg,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageCounter: {
    position: 'absolute',
    top: 50,
    left: SPACING.lg,
    zIndex: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: 20,
  },
  imageCounterText: {
    color: COLORS.white,
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
  },
  fullScreenImageContainer: {
    width: width,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullScreenImage: {
    width: width,
    height: '100%',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    width: width * 0.8,
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: FONTS.productDetailSizes.xl,
    fontWeight: '700',
    color: COLORS.black,
    marginBottom: SPACING.md,
    textAlign: 'center',
  },
  modalMessage: {
    fontSize: FONTS.productDetailSizes.md,
    color: COLORS.gray[500],
    marginBottom: SPACING.xl,
    textAlign: 'center',
    lineHeight: Math.round(FONTS.productDetailSizes.md * 22 / 16),
  },
  modalButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
    color: COLORS.black,
  },
  confirmButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: '#FF5722',
    alignItems: 'center',
  },
  confirmButtonText: {
    fontSize: FONTS.productDetailSizes.md,
    fontWeight: '600',
    color: COLORS.white,
  },
});

export default ProductDetailScreen;

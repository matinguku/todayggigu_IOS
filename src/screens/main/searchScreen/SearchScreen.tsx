import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ScrollView,
  FlatList,
  Dimensions,
  TextInput,
  Animated,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Icon from '../../../components/Icon';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { launchCamera, launchImageLibrary, MediaType, ImagePickerResponse, CameraOptions, ImageLibraryOptions } from 'react-native-image-picker';
import { Platform, Alert } from 'react-native';
import RNFS from 'react-native-fs';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../../../utils/permissions';

import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS } from '../../../constants';
import { RootStackParamList, Product } from '../../../types';
import { usePlatformStore } from '../../../store/platformStore';
import { useAppSelector } from '../../../store/hooks';
import { ImagePickerModal, ProductCard, Button, SortDropdown, PriceFilterModal } from '../../../components';
import { sortProducts } from '../../../utils/productSort';
import { translations } from '../../../i18n/translations';
import { productsApi } from '../../../services/productsApi';
import { useToast } from '../../../context/ToastContext';
import { convertFromKRW } from '../../../utils/i18nHelpers';
import { useAuth } from '../../../context/AuthContext';
import { useWishlistStatus } from '../../../hooks/useWishlistStatus';
import { useAddToWishlistMutation } from '../../../hooks/useAddToWishlistMutation';
import { useDeleteFromWishlistMutation } from '../../../hooks/useDeleteFromWishlistMutation';
import { useGetSearchHistory, useDeleteSearchKeyword, useClearSearchHistory, useGetSearchSuggestions } from '../../../hooks/useSearchHistoryMutation';
import { useAutocompleteMutation } from '../../../hooks/useAutocompleteMutation';
import { useFocusEffect } from '@react-navigation/native';
import ArrowBackIcon from '../../../assets/icons/ArrowBackIcon';
import ViewListIcon from '../../../assets/icons/ViewListIcon';
import CameraIcon from '../../../assets/icons/CameraIcon';
import { useSearchProductsMutation } from '../../../hooks/useSearchProductsMutation';
import DeleteIcon from '../../../assets/icons/DeleteIcon';
import { looksLikeDirectProductSearch, resolveProductFromSearchInput } from '../../../utils/parseProductLinkSearch';
import { productPlatformToCompanyTab, resolveProductPlatformKey } from '../../../utils/productPlatform';
import { openProductDetail } from '../../../utils/openProductDetail';


const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - SPACING.sm * 2 - SPACING.sm) / 2;

type ProductDetailNavigationProp = StackNavigationProp<RootStackParamList, 'ProductDetail'>;

const SearchScreenComponent: React.FC = () => {
  const navigation = useNavigation<ProductDetailNavigationProp>();
  // Search context removed - using local state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedSort, setSelectedSort] = useState<string>('best_match');
  const [isSearchFocused, setIsSearchFocused] = useState<boolean>(false);
  
  // Map company name to platform/source parameter
  const getPlatformFromCompany = (company: string): string => {
    if (company === 'All') {
      // Special handling for "All" - handled separately in loadProducts
      return '1688';
    }
    // Convert company name to lowercase for API (e.g., "Taobao" -> "taobao")
    return company.toLowerCase();
  };
  
  // States
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]); // Store all products for filtering (unsorted)
  const [companies, setCompanies] = useState<string[]>(['All', '1688', 'Taobao']); // Store unique company names
  const [stores, setStores] = useState<any[]>([]); // Store stores data
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(1);
  const [offset, setOffset] = useState(1); // Add offset state
  const [activeCategoryTab, setActiveCategoryTab] = useState<string | null>(null);
  const [selectedCompany, setSelectedCompany] = useState<string>('All'); // Company filter state
  const selectedCompanyRef = useRef<string>('All'); // Ref to always have current value in callbacks
  const [refreshing, setRefreshing] = useState(false); // Add refreshing state
  const [categoryLoading, setCategoryLoading] = useState(false); // Add category loading state
  const [dualPlatformLoading, setDualPlatformLoading] = useState(false); // Add dual platform loading state
  const [recentSearches, setRecentSearches] = useState<string[]>([]); // Recent searches state
  const [keepShoppingForProducts, setKeepShoppingForProducts] = useState<any[]>([]); // Keep Shopping For products
  const [debugKeepShoppingFor, setDebugKeepShoppingFor] = useState<string>(''); // Debug: Store raw keepShoppingFor data
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<string[]>([]); // Autocomplete suggestions
  const [showAutocomplete, setShowAutocomplete] = useState<boolean>(false); // Show/hide autocomplete dropdown
  
  // Refs
  const isLoadingRef = useRef(false);
  const flatListRef = useRef<FlatList>(null); // Change to FlatList ref
  const isRecentSearchClickRef = useRef(false); // Track if search was triggered by recent search click
  const hasFetchedSuggestionsRef = useRef(false); // Track if search suggestions have been fetched
  
  // Modal states
  const [imagePickerModalVisible, setImagePickerModalVisible] = useState(false);
  const [priceFilterModalVisible, setPriceFilterModalVisible] = useState(false);
  const [clearHistoryConfirmVisible, setClearHistoryConfirmVisible] = useState(false);
  
  // Filter states (for price filter modal)
  const [minPrice, setMinPrice] = useState<string>('');
  const [maxPrice, setMaxPrice] = useState<string>('');
  
  // Category state
  const categoryScrollRef = useRef<ScrollView>(null);
  const tabLayouts = useRef<{ x: number; width: number }[]>([]);
  const indicatorX = useRef(new Animated.Value(0)).current;
  const indicatorW = useRef(new Animated.Value(0)).current;
  const scrollX = useRef(new Animated.Value(0)).current;

  // Get Zustand store
  const { selectedPlatform, setSelectedPlatform } = usePlatformStore();
  
  // Get locale from Redux store
  const locale = useAppSelector((s) => s.i18n.locale) as 'en' | 'ko' | 'zh';
  const { showToast } = useToast();
  const { isProductLiked, refreshExternalIds, addExternalId, removeExternalId } = useWishlistStatus();
  const { user, isGuest } = useAuth();
  // console.log('SearchScreen rendered with user:', user, 'isGuest:', isGuest);
  
  // Add to wishlist mutation
  const { mutate: addToWishlist } = useAddToWishlistMutation({
    onSuccess: async (data) => {
      // console.log('Product added to wishlist successfully:', data);
      showToast(t('search.messages.productAddedToWishlist'), 'success');
      // Immediately refresh external IDs to update heart icon color
      await refreshExternalIds();
    },
    onError: (error) => {
      // console.error('Failed to add product to wishlist:', error);
      showToast(error || t('search.messages.failedToAddToWishlist'), 'error');
    },
  });

  // Delete from wishlist mutation
  const { mutate: deleteFromWishlist } = useDeleteFromWishlistMutation({
    onSuccess: async (data) => {
      // console.log('Product removed from wishlist successfully:', data);
      showToast(t('search.messages.productRemovedFromWishlist'), 'success');
      // Immediately refresh external IDs to update heart icon color
      await refreshExternalIds();
    },
    onError: (error) => {
      // console.error('Failed to remove product from wishlist:', error);
      showToast(error || t('search.messages.failedToRemoveFromWishlist'), 'error');
    },
  });

  // Search suggestions hook (includes search history and keep shopping for)
  const { mutate: fetchSearchSuggestions } = useGetSearchSuggestions({
    onSuccess: (data) => {
      // Debug: Log to console (visible in Metro bundler terminal or log commands)
      // console.log('=== Search Suggestions API Response ===');
      // console.log('Full data:', JSON.stringify(data, null, 2));
      // console.log('keepShoppingFor:', JSON.stringify(data.keepShoppingFor, null, 2));
      // console.log('keepShoppingFor.products:', data.keepShoppingFor?.products);
      // console.log('keepShoppingFor.products length:', data.keepShoppingFor?.products?.length);
      // if (data.keepShoppingFor?.products && data.keepShoppingFor.products.length > 0) {
      //   console.log('First product:', JSON.stringify(data.keepShoppingFor.products[0], null, 2));
      // }
      // console.log('=======================================');
      
      // Debug: Store raw data for display
      setDebugKeepShoppingFor(JSON.stringify(data.keepShoppingFor || null, null, 2));
      
      // Update search history from suggestions API (only if provided and has data)
      if (data.searchHistory && Array.isArray(data.searchHistory) && data.searchHistory.length > 0) {
        const processedData = data.searchHistory
          .map((item: any) => {
            if (typeof item === 'string') {
              return item.trim();
            }
            if (item && typeof item === 'object' && item.keyword) {
              return String(item.keyword || '').trim();
            }
            return String(item || '').trim();
          })
          .filter((item: string) => item != null && String(item).trim().length > 0);
        
        setRecentSearches(processedData);
        if (processedData.length > 0) {
          AsyncStorage.setItem('recentSearches', JSON.stringify(processedData)).catch(() => {});
        }
      }
      // Don't clear recent searches if searchHistory is not provided - preserve existing data
      
      // Update Keep Shopping For products
      if (data.keepShoppingFor && data.keepShoppingFor.products && Array.isArray(data.keepShoppingFor.products)) {
        setKeepShoppingForProducts(data.keepShoppingFor.products);
      } else {
        setKeepShoppingForProducts([]);
      }
    },
    onError: (error) => {
      // Silently fail - don't show error if user is not authenticated
      if (error !== 'Not authenticated' && error !== 'No authentication token found') {
        // console.error('Failed to fetch search suggestions:', error);
      }
      // Don't clear on error - preserve existing recent searches from AsyncStorage
    },
  });

  // Autocomplete hook
  const { mutate: fetchAutocomplete, data: autocompleteData, isLoading: isAutocompleteLoading } = useAutocompleteMutation({
    onSuccess: (data) => {
      // Update suggestions with new data from API
      setAutocompleteSuggestions(data.suggestions || []);
      // Keep modal visible if there are suggestions, or if user is still typing
      // (we'll hide it when query is empty or on blur)
      if (data.suggestions && data.suggestions.length > 0) {
        setShowAutocomplete(true);
      } else if (searchQuery && searchQuery.trim().length > 0) {
        // Keep modal visible even if no suggestions (user might still be typing)
        setShowAutocomplete(true);
      }
    },
    onError: (error) => {
      // On error, clear suggestions but keep modal visible if user is still typing
      setAutocompleteSuggestions([]);
      if (!searchQuery || searchQuery.trim().length === 0) {
        setShowAutocomplete(false);
      }
    },
  });

  // Debounce autocomplete API calls
  const autocompleteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const headerTopHeightRef = useRef<number>(70); // Default height, will be updated via onLayout
  
  // Handle search query change with autocomplete
  const handleSearchQueryChange = useCallback((text: string) => {
    setSearchQuery(text);

    // Clear previous timeout
    if (autocompleteTimeoutRef.current) {
      clearTimeout(autocompleteTimeoutRef.current);
    }

    // Hide autocomplete if query is empty
    if (!text || text.trim().length === 0) {
      setShowAutocomplete(false);
      setAutocompleteSuggestions([]);
      return;
    }

    // Product links / offerId / productNo — skip keyword autocomplete
    if (looksLikeDirectProductSearch(text)) {
      setShowAutocomplete(false);
      setAutocompleteSuggestions([]);
      return;
    }

    // "https" 가 입력된 순간부터 자동완성/자동검색을 중단.
    // 사용자가 검색 단추(또는 Enter) 를 직접 눌러야만 검색이 진행되도록 한다.
    // (h, ht, htt, http 까지는 일반 키워드일 가능성이 있어 허용,
    //  https 부터는 URL 입력으로 간주.)
    const trimmedLower = text.trim().toLowerCase();
    if (trimmedLower.startsWith('https')) {
      setShowAutocomplete(false);
      setAutocompleteSuggestions([]);
      return;
    }
    
    // Show autocomplete modal immediately when user starts typing
    // This ensures the modal appears even while loading
    setShowAutocomplete(true);
    
    // Debounce autocomplete API call (wait 200ms after user stops typing)
    // This fetches suggestions for the current query incrementally
    // e.g., "I" -> fetch for "I", "Ia" -> fetch for "Ia", etc.
    autocompleteTimeoutRef.current = setTimeout(() => {
      const trimmedText = text.trim();
      if (trimmedText.length > 0) {
        fetchAutocomplete(trimmedText, 20);
      }
    }, 200);
  }, [fetchAutocomplete]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (autocompleteTimeoutRef.current) {
        clearTimeout(autocompleteTimeoutRef.current);
      }
    };
  }, []);

  // Search history hooks (keep for backward compatibility, but use suggestions API instead)
  const { mutate: fetchSearchHistory, data: searchHistoryData } = useGetSearchHistory({
    onSuccess: (data) => {
      // Debug: Log raw API response
      // console.log('🔍 [SearchHistory] Raw API data:', JSON.stringify(data, null, 2));
      // console.log('🔍 [SearchHistory] Data type:', typeof data);
      // console.log('🔍 [SearchHistory] Is array:', Array.isArray(data));
      if (data && Array.isArray(data)) {
        // console.log('🔍 [SearchHistory] Array length:', data.length);
        // console.log('🔍 [SearchHistory] First item:', data[0]);
        // console.log('🔍 [SearchHistory] First item type:', typeof data[0]);
      }
      
      // API returns array of strings like ["bicycle"] or ["hello"]
      if (data && Array.isArray(data)) {
        // Process all items - keep them as strings, don't filter aggressively
        const processedData = data
          .map((item: any, index: number) => {
            // console.log(`🔍 [SearchHistory] Processing item ${index}:`, item, 'Type:', typeof item);
            // Handle string directly - trim whitespace but keep the value
            if (typeof item === 'string') {
              const trimmed = item.trim();
              // console.log(`🔍 [SearchHistory] Item ${index} (string): "${item}" -> "${trimmed}"`);
              return trimmed;
            }
            // Handle object with keyword property (fallback)
            if (item && typeof item === 'object' && item.keyword) {
              const keyword = String(item.keyword || '');
              // console.log(`🔍 [SearchHistory] Item ${index} (object.keyword):`, item, '->', keyword);
              return keyword;
            }
            // Convert to string as last resort
            const converted = String(item || '');
            // console.log(`🔍 [SearchHistory] Item ${index} (converted):`, item, '->', converted);
            return converted;
          })
          // Only filter out null, undefined, or completely empty strings after trimming
          .filter((item: string, index: number) => {
            const isValid = item != null && String(item).trim().length > 0;
            // console.log(`🔍 [SearchHistory] Filter item ${index}: "${item}" (length: ${String(item).length}) -> ${isValid ? 'KEEP' : 'REMOVE'}`);
            return isValid;
          });
        
        // console.log('🔍 [SearchHistory] Final processed data:', JSON.stringify(processedData, null, 2));
        // console.log('🔍 [SearchHistory] Processed data length:', processedData.length);
        // console.log('🔍 [SearchHistory] Setting recentSearches state with:', processedData);
        
        setRecentSearches(processedData);
        // Also save to AsyncStorage as backup for authenticated users
        if (processedData.length > 0) {
          AsyncStorage.setItem('recentSearches', JSON.stringify(processedData)).catch(() => {});
        }
      } else {
        // If API returns empty or invalid data, don't clear existing searches
        // console.log('🔍 [SearchHistory] Invalid or empty data, preserving existing searches');
      }
    },
    onError: (error) => {
      // Silently fail - don't clear existing searches on error
      if (error !== 'Not authenticated') {
        // console.error('Failed to fetch search history:', error);
      }
    },
  });

  const { mutate: deleteKeyword } = useDeleteSearchKeyword({
    onSuccess: () => {
      // Refresh search history after deletion
      fetchSearchHistory();
    },
    onError: (error) => {
      showToast(error || t('search.messages.failedToDeleteKeyword'), 'error');
    },
  });

  const { mutate: clearHistory } = useClearSearchHistory({
    onSuccess: () => {
      setRecentSearches([]);
      // Also clear AsyncStorage
      AsyncStorage.removeItem('recentSearches').catch(() => {});
      showToast(t('search.messages.searchHistoryCleared'), 'success');
    },
    onError: (error) => {
      showToast(error || t('search.messages.failedToClearHistory'), 'error');
    },
  });

  // Track if we've fetched on focus to prevent infinite loops
  const hasFetchedOnFocusRef = useRef(false);
  
  // Fetch search suggestions and history when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      // Prevent multiple fetches on the same focus
      if (hasFetchedOnFocusRef.current) {
        return;
      }
      
      if (!isGuest && user) {
        // Fetch from search suggestions API for authenticated users
        fetchSearchSuggestions('hot');
        hasFetchedSuggestionsRef.current = true;
        // Also fetch search history as fallback/refresh to ensure recent searches are loaded
        fetchSearchHistory();
        hasFetchedOnFocusRef.current = true;
      } else if (isGuest || !user) {
        // For guest users, clear recent searches (not available)
        setRecentSearches([]);
        setKeepShoppingForProducts([]);
        hasFetchedOnFocusRef.current = true;
      }
      
      // Reset the flags when screen loses focus so fresh data loads on next visit
      return () => {
        hasFetchedOnFocusRef.current = false;
        hasFetchedSuggestionsRef.current = false;
      };
    }, [isGuest, user]) // Remove fetchSearchSuggestions and fetchSearchHistory from dependencies
  );
  
  // Toggle wishlist function
  const toggleWishlist = async (product: any) => {
    if (!user || isGuest) {
      showToast(t('search.messages.pleaseLogin'), 'warning');
      return;
    }

    // Get product external ID - prioritize externalId, never use MongoDB _id
    const externalId = 
      (product as any).externalId?.toString() ||
      (product as any).offerId?.toString() ||
      '';

    if (!externalId) {
      showToast(t('search.messages.invalidProductId'), 'error');
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
        showToast(t('search.messages.invalidProductData'), 'error');
        return;
      }

      // Optimistic update - add to state and AsyncStorage immediately
      await addExternalId(externalId);
      addToWishlist({ offerId: externalId, platform: source });
    }
  };
  
  // Translation function
  const t = (key: string) => {
    const keys = key.split('.');
    let value: any = translations[locale as keyof typeof translations];
    for (const k of keys) {
      value = value?.[k];
    }
    return value || key;
  };

  // Sort options (defined after t function)
  const sortOptions = [
    { label: t('search.sortOptions.bestMatch'), value: 'best_match' },
    { label: t('search.sortOptions.priceHigh'), value: 'price_high' },
    { label: t('search.sortOptions.priceLow'), value: 'price_low' },
    { label: t('search.sortOptions.highSales'), value: 'high_sales' },
    { label: t('search.sortOptions.lowSales'), value: 'low_sales' },
  ];

  // Helper function to navigate to product detail
  const navigateToProductDetail = async (
    productId: string | number,
    source: string = selectedPlatform,
    country: string = locale
  ) => {
    navigation.navigate('ProductDetail', {
      productId: productId.toString(),
      source: source,
      country: country,
    });
  };

  const resolveSearchPlatform = useCallback((): '1688' | 'taobao' => {
    const company = selectedCompanyRef.current;
    if (company === 'Taobao') return 'taobao';
    if (company === '1688') return '1688';
    return resolveProductPlatformKey(selectedPlatform);
  }, [selectedPlatform]);

  const tryOpenProductFromSearchInput = useCallback(
    (input: string): boolean => {
      const defaultSource = resolveSearchPlatform();
      const parsed = resolveProductFromSearchInput(input, defaultSource);
      if (!parsed) return false;

      const companyTab = productPlatformToCompanyTab(parsed.source);
      setSelectedCompany(companyTab);
      selectedCompanyRef.current = companyTab;
      setShowAutocomplete(false);

      openProductDetail(navigation, {
        productId: parsed.offerId,
        offerId: parsed.offerId,
        source: parsed.source,
        country: locale,
      });
      return true;
    },
    [navigation, locale, resolveSearchPlatform],
  );

  // Preload recent searches when component mounts
  useEffect(() => {
    const loadInitialSearches = async () => {
      if (isGuest || !user) {
        // For guest users, clear recent searches (not available for guests)
        setRecentSearches([]);
      } else if (!isGuest && user) {
        // For authenticated users, load from AsyncStorage as cache/fallback
        // while API call happens in useFocusEffect
        try {
          const saved = await AsyncStorage.getItem('recentSearches');
          if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setRecentSearches(parsed);
            }
          }
        } catch (error) {
          // Silently fail if AsyncStorage read fails
        }
      }
    };
    loadInitialSearches();
    
    // Set default sort to "all" if not already set
    if (!selectedSort) {
      setSelectedSort('all');
    }
  }, [isGuest, user]);


  // Save recent searches to AsyncStorage whenever they change (only for guest users or as backup)
  useEffect(() => {
    // Only auto-save to AsyncStorage for guest users
    // For authenticated users, API is the source of truth
    if (isGuest || !user) {
      const saveRecentSearches = async () => {
        try {
          await AsyncStorage.setItem('recentSearches', JSON.stringify(recentSearches));
        } catch (error) {
          // console.error('Error saving recent searches:', error);
        }
      };
      saveRecentSearches();
    }
  }, [recentSearches, isGuest, user]);

  // Memoize categories for performance
  const memoizedCategories = useMemo(() => categories, [categories]);
  const memoizedCategoryIds = useMemo(() => categoryIds, [categoryIds]);



  // Update indicator position when active category changes
  useEffect(() => {
    if (activeCategoryTab && memoizedCategories.length > 0) {
      const index = memoizedCategories.indexOf(activeCategoryTab);
      if (index !== -1 && tabLayouts.current[index]) {
        const layout = tabLayouts.current[index];
        Animated.parallel([
          Animated.timing(indicatorX, { 
            toValue: layout.x, 
            duration: 150, 
            useNativeDriver: false 
          }),
          Animated.timing(indicatorW, { 
            toValue: layout.width, 
            duration: 150, 
            useNativeDriver: false 
          }),
        ]).start();
      }
    }
  }, [activeCategoryTab, memoizedCategories]);

  // Show first category indicator when entering with search query
  // Use a ref to prevent infinite loops
  const hasSetInitialCategoryRef = useRef(false);
  useEffect(() => {
    if (searchQuery && memoizedCategories.length > 0 && !activeCategoryTab && memoizedCategories[0] && !hasSetInitialCategoryRef.current) {
      // Set first category as active if none is selected and there's a search query
      setActiveCategoryTab(memoizedCategories[0]);
      hasSetInitialCategoryRef.current = true;
    }
    // Reset flag when search query or categories change significantly
    if (!searchQuery || memoizedCategories.length === 0) {
      hasSetInitialCategoryRef.current = false;
    }
  }, [searchQuery, memoizedCategories, activeCategoryTab]);


  // Handle manual search trigger (only when user explicitly searches)
  const handleSearch = useCallback(() => {
    if (!searchQuery || searchQuery.trim().length === 0) {
      return;
    }
    
    // Hide autocomplete
    setShowAutocomplete(false);

    if (tryOpenProductFromSearchInput(searchQuery)) {
      return;
    }
    
    // Reset states - always start fresh with 'All' platforms
    isRecentSearchClickRef.current = false;
    setSelectedCompany('All');
    selectedCompanyRef.current = 'All';
    setOffset(1);
    setHasMore(true);
    setProducts([]);
    setAllProducts([]);

    loadProducts(selectedSort || 'best_match', 1);
  }, [searchQuery, selectedSort, tryOpenProductFromSearchInput]);

  // Note: Removed automatic search on searchQuery change
  // Search now only triggers when:
  // 1. User presses Enter (onSubmitEditing)
  // 2. User presses search icon button
  // Autocomplete suggestions still work while typing

  // Apply sorting when selectedSort changes
  useEffect(() => {
    if (allProducts.length > 0) {
      const sorted = sortProducts(allProducts, selectedSort);
      setProducts(sorted);
    }
  }, [selectedSort, allProducts]);

  // Load more products when offset changes (infinite scroll)
  useEffect(() => {
    // console.log('Offset changed to:', offset);
    // Prevent loading more data when refreshing
    if (isRefreshingRef.current) {
      // console.log('Skipping offset effect during refresh');
      return;
    }
    
    if (offset > 1 && searchQuery && searchQuery.trim()) {
      // console.log('Loading more products for offset:', offset, 'with sort:', selectedSort);
      loadProducts(selectedSort || 'popularity', offset); // Use the selected sort option
    }
  }, [offset, selectedSort, searchQuery]);

  // Memoize stores for performance
  const memoizedStores = useMemo(() => stores, [stores]);


  // Memoize products for performance
  const memoizedProducts = useMemo(() => products, [products]);

  // Add a ref to track if we're currently refreshing
  const isRefreshingRef = useRef(false);
  
  // Ref to store current page offset for use in callbacks
  const currentPageOffsetRef = useRef<number>(1);

  // Search products mutation
  const { mutate: searchProducts, isLoading: isSearching } = useSearchProductsMutation({
    onSuccess: (data) => {
      // console.log('Products fetched successfully:', data);
      isLoadingRef.current = false;
      
      const currentPage = currentPageOffsetRef.current;
      // Only clear loading spinner for first page
      if (currentPage === 1) {
        // Loading spinner removed
      }
      
      // Refresh search history after successful search (only for authenticated users)
      // Only refresh if we have a valid search query to avoid unnecessary API calls
      if (!isGuest && user && searchQuery && searchQuery.trim().length > 0) {
        fetchSearchHistory();
        // Only refresh suggestions if not already fetched recently
        if (!hasFetchedSuggestionsRef.current) {
          fetchSearchSuggestions('hot');
          hasFetchedSuggestionsRef.current = true;
        }
      }
      
      if (data && data.data && data.data.products && Array.isArray(data.data.products)) {
        // Map API response to Product format
        const mappedProducts = data.data.products.map((item: any) => {
          const price = parseFloat(item.price || item.wholesalePrice || item.dropshipPrice || 0);
          const originalPrice = parseFloat(item.originalPrice || price);
          const discount = originalPrice > price && originalPrice > 0
            ? Math.round(((originalPrice - price) / originalPrice) * 100)
            : 0;
          
          const productId = item.id?.toString() || item.externalId?.toString() || '';
          const externalId = item.externalId?.toString() || item.id?.toString() || '';
          const offerId = item.offerId?.toString() || item.externalId?.toString() || item.id?.toString() || '';
          
          return {
            id: productId,
            externalId: externalId,
            offerId: offerId,
            name: item.title || item.titleOriginal || '',
            image: item.image || '',
            price: price,
            originalPrice: originalPrice,
            discount: discount,
            description: '',
            category: { id: '', name: '', icon: '', image: '', subcategories: [] },
            subcategory: '',
            brand: '',
            seller: { 
              id: '', 
              name: item.companyName || item.sellerName || '', 
              avatar: '', 
              rating: 0, 
              reviewCount: 0, 
              isVerified: false, 
              followersCount: 0, 
              description: '', 
              location: '', 
              joinedDate: new Date() 
            },
            rating: item.rating || 0,
            reviewCount: item.sales || 0,
            rating_count: item.sales || 0,
            inStock: true,
            stockCount: 0,
            tags: [],
            isNew: false,
            isFeatured: false,
            isOnSale: discount > 0,
            createdAt: new Date(item.createDate || new Date()),
            updatedAt: new Date(item.modifyDate || new Date()),
            orderCount: item.sales || 0,
            repurchaseRate: item.repurchaseRate || '',
            // Store companyName for filtering
            companyName: item.companyName || item.sellerName || '',
          } as Product & { companyName?: string };
        });
        
        // Check pagination
        const pagination = data.data.pagination;
        const hasMore = pagination && currentPage < pagination.totalPage;
        setHasMore(hasMore || false);
        
        // Extract unique company names from mapped products
        const uniqueCompanies = new Set<string>(['All']);
        mappedProducts.forEach((product: any) => {
          const companyName = product.companyName || product.seller?.name || '';
          if (companyName && companyName.trim()) {
            uniqueCompanies.add(companyName);
          }
        });
        // Sort companies with "All" always first
        const sortedCompanies = Array.from(uniqueCompanies).sort((a, b) => {
          if (a === 'All') return -1;
          if (b === 'All') return 1;
          return a.localeCompare(b);
        });
        // setCompanies(sortedCompanies);
        
        // If it's the first page, replace products, otherwise append
        if (currentPage === 1) {
          setAllProducts(mappedProducts);
          // Apply current sort to the products
          const sorted = sortProducts(mappedProducts, selectedSort);
          setProducts(sorted);
        } else {
          const updatedProducts = [...allProducts, ...mappedProducts];
          setAllProducts(updatedProducts);
          // Apply current sort to the updated products
          const sorted = sortProducts(updatedProducts, selectedSort);
          setProducts(sorted);
        }
      } else {
        // No products found
        if (currentPage === 1) {
          setProducts([]);
          setAllProducts([]);
        }
        setHasMore(false);
      }
    },
    onError: (error) => {
      // console.error('Failed to fetch products:', error);
      isLoadingRef.current = false;
      
      const currentPage = currentPageOffsetRef.current;
      // Loading spinner removed
      // Clear products on error when on first page
      if (currentPage === 1) {
        setProducts([]);
        setAllProducts([]);
      }
      setHasMore(false);
    },
  });

  // Load products using search API
  // sortType: The sort parameter to pass to API (popularity, price_high, price_low, newest, rating)
  // pageOffset: The page number (1-based) - API will return sorted results for this page
  // Each page request includes the sort parameter, so sorting is applied per page by the API
  const loadProducts = async (sortType: string = selectedSort || 'popularity', pageOffset: number = offset || 1, keywordOverride?: string ) => {
    // Prevent multiple simultaneous API calls
    if (isLoadingRef.current || isSearching || dualPlatformLoading) {
      return;
    }

    // Use keywordOverride (e.g. from recent/recommend tap) or searchQuery
    const searchKeyword = (keywordOverride ?? searchQuery)?.trim() || '';

    if (!searchKeyword) {
      // console.warn('No search keyword available, skipping product load');
      isLoadingRef.current = false;
      return;
    }

    if (tryOpenProductFromSearchInput(searchKeyword)) {
      isLoadingRef.current = false;
      return;
    }

    // console.log('loadProducts called:', {
    //   offset: pageOffset,
    //   searchKeyword,
    //   minPrice,
    //   maxPrice,
    //   sortType
    // });
    isLoadingRef.current = true;
    // Loading spinner removed

    // Map sort type to API sort parameter
    // The API expects: popularity (best match), price_high, price_low, newest, rating
    // This mapping handles all sort types including high_sales, low_sales, price_high, price_low
    let sortParam = '';
    if (sortType === 'Price High to Low' || sortType === 'price_high') {
      sortParam = 'price_high';
    } else if (sortType === 'Price Low to High' || sortType === 'price_low') {
      sortParam = 'price_low';
    } else if (sortType === 'Newest' || sortType === 'newest' || sortType === 'low_sales') {
      // low_sales maps to newest
      sortParam = 'newest';
    } else if (sortType === 'Top' || sortType === 'rating' || sortType === 'high_sales') {
      // high_sales maps to rating
      sortParam = 'rating';
    } else {
      // Default to 'popularity' (best match from API)
      sortParam = 'popularity';
    }

    // console.log('Sort mapping:', { sortType, sortParam, pageOffset });

    // Convert price strings to numbers and convert from KRW to CNY for API
    // User enters prices in KRW (what they see), but API expects CNY
    const priceStart = minPrice ? parseFloat(minPrice)/230 : undefined;
    const priceEnd = maxPrice ? parseFloat(maxPrice)/230 : undefined;
    console.log("Search Price Filter value: ", priceStart, " : ", priceEnd);
    // For Taobao, we'll pass price filters via the filter parameter in the API
    // For 1688, we use priceStart and priceEnd directly
    // The API will handle the conversion
    const filterParam = undefined; // Price filters are handled in API based on source

    // Store current page offset for use in callbacks
    currentPageOffsetRef.current = pageOffset;

    // Handle "All" case - search both platforms
    if (selectedCompanyRef.current === 'All') {
      await loadProductsFromBothPlatforms(
        searchKeyword,
        locale,
        pageOffset,
        10, // pageSize per platform (10 from 1688 + 10 from taobao = 20 combined)
        sortParam,
        priceStart,
        priceEnd,
        filterParam
      );
    } else {
      // Single platform search
      const platformSource = getPlatformFromCompany(selectedCompanyRef.current);

      // Call search API with auth token (only for search page query search)
      searchProducts(
        searchKeyword,
        platformSource,
        locale,
        pageOffset,
        20, // pageSize for single platform
        sortParam,
        priceStart,
        priceEnd,
        filterParam,
        true // requireAuth = true for search page
      );
    }
  };

  // Helper function to load products from both platforms and combine them
  const loadProductsFromBothPlatforms = async (
    searchKeyword: string,
    locale: string,
    pageOffset: number,
    pageSize: number,
    sortParam: string,
    priceStart?: number,
    priceEnd?: number,
    filterParam?: any
  ) => {
    try {
      setDualPlatformLoading(true);
      // Make both API calls in parallel
      const [response1688, responseTaobao] = await Promise.allSettled([
        productsApi.searchProductsByKeyword(
          searchKeyword,
          '1688',
          locale,
          pageOffset,
          pageSize,
          sortParam,
          priceStart,
          priceEnd,
          filterParam,
          true
        ),
        productsApi.searchProductsByKeyword(
          searchKeyword,
          'taobao',
          locale,
          pageOffset,
          pageSize,
          sortParam,
          priceStart,
          priceEnd,
          filterParam,
          true
        )
      ]);

      // Process results
      const products1688 = response1688.status === 'fulfilled' && response1688.value?.success && response1688.value?.data?.data?.products
        ? response1688.value.data.data.products
        : [];
      const productsTaobao = responseTaobao.status === 'fulfilled' && responseTaobao.value?.success && responseTaobao.value?.data?.data?.products
        ? responseTaobao.value.data.data.products
        : [];

      // Combine and randomize products
      const combinedProducts = [...products1688, ...productsTaobao];

      // Randomize the order using Fisher-Yates shuffle
      for (let i = combinedProducts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [combinedProducts[i], combinedProducts[j]] = [combinedProducts[j], combinedProducts[i]];
      }

      // Create a mock response object for the existing success handler
      const mockResponse = {
        data: {
          data: {
            products: combinedProducts,
            pagination: {
              totalPage: Math.max(
                response1688.status === 'fulfilled' && response1688.value?.data?.data?.pagination?.totalPage ? response1688.value.data.data.pagination.totalPage : 1,
                responseTaobao.status === 'fulfilled' && responseTaobao.value?.data?.data?.pagination?.totalPage ? responseTaobao.value.data.data.pagination.totalPage : 1
              )
            }
          }
        }
      };

      // Call the success handler with the combined data
      const currentPage = currentPageOffsetRef.current;

      // Refresh search history after successful search (only for authenticated users)
      if (!isGuest && user && searchQuery && searchQuery.trim().length > 0) {
        fetchSearchHistory();
        if (!hasFetchedSuggestionsRef.current) {
          fetchSearchSuggestions('hot');
          hasFetchedSuggestionsRef.current = true;
        }
      }

      if (mockResponse.data && mockResponse.data.data && mockResponse.data.data.products && Array.isArray(mockResponse.data.data.products)) {
        // Map API response to Product format
        const mappedProducts = mockResponse.data.data.products.map((item: any) => {
          const price = parseFloat(item.price || item.wholesalePrice || item.dropshipPrice || 0);
          const originalPrice = parseFloat(item.originalPrice || price);
          const discount = originalPrice > price && originalPrice > 0
            ? Math.round(((originalPrice - price) / originalPrice) * 100)
            : 0;

          const productId = item.id?.toString() || item.externalId?.toString() || '';
          const externalId = item.externalId?.toString() || item.id?.toString() || '';
          const offerId = item.offerId?.toString() || item.externalId?.toString() || item.id?.toString() || '';

          return {
            id: productId,
            externalId: externalId,
            offerId: offerId,
            name: item.title || item.titleOriginal || '',
            image: item.image || '',
            price: price,
            originalPrice: originalPrice,
            discount: discount,
            description: '',
            category: { id: '', name: '', icon: '', image: '', subcategories: [] },
            subcategory: '',
            brand: '',
            seller: {
              id: '',
              name: item.companyName || item.sellerName || '',
              avatar: '',
              rating: 0,
              reviewCount: 0,
              isVerified: false,
              followersCount: 0,
              description: '',
              location: '',
              joinedDate: new Date()
            },
            rating: item.rating || 0,
            reviewCount: item.sales || 0,
            rating_count: item.sales || 0,
            inStock: true,
            stockCount: 0,
            tags: [],
            isNew: false,
            isFeatured: false,
            isOnSale: discount > 0,
            createdAt: new Date(item.createDate || new Date()),
            updatedAt: new Date(item.modifyDate || new Date()),
            orderCount: item.sales || 0,
            repurchaseRate: item.repurchaseRate || '',
            // Store companyName for filtering
            companyName: item.companyName || item.sellerName || '',
          } as Product & { companyName?: string };
        });

        // Check pagination
        const pagination = mockResponse.data.data.pagination;
        const hasMore = pagination && currentPage < pagination.totalPage;
        setHasMore(hasMore || false);

        // Extract unique company names from mapped products
        const uniqueCompanies = new Set<string>(['All']);
        mappedProducts.forEach((product: any) => {
          const companyName = product.companyName || product.seller?.name || '';
          if (companyName && companyName.trim()) {
            uniqueCompanies.add(companyName);
          }
        });
        // Sort companies with "All" always first
        const sortedCompanies = Array.from(uniqueCompanies).sort((a, b) => {
          if (a === 'All') return -1;
          if (b === 'All') return 1;
          return a.localeCompare(b);
        });

        // If it's the first page, replace products, otherwise append
        if (currentPage === 1) {
          setAllProducts(mappedProducts);
          // Apply current sort to the products
          const sorted = sortProducts(mappedProducts, selectedSort);
          setProducts(sorted);
        } else {
          const updatedProducts = [...allProducts, ...mappedProducts];
          setAllProducts(updatedProducts);
          // Apply current sort to the updated products
          const sorted = sortProducts(updatedProducts, selectedSort);
          setProducts(sorted);
        }
      } else {
        // No products found
        if (currentPage === 1) {
          setProducts([]);
          setAllProducts([]);
        }
        setHasMore(false);
      }

      isLoadingRef.current = false;
      setDualPlatformLoading(false);

    } catch (error) {
      // If both calls fail, call error handler
      isLoadingRef.current = false;
      setDualPlatformLoading(false);
      const currentPage = currentPageOffsetRef.current;
      if (currentPage === 1) {
        setProducts([]);
        setAllProducts([]);
      }
      setHasMore(false);
    }
  };

  // Handle end reached for infinite scroll
  const handleEndReached = useCallback(() => {
    // console.log('handleEndReached called:', { hasMore, searchQuery, offset });
    // Prevent loading more data when refreshing
    if (isRefreshingRef.current) {
      // console.log('Skipping handleEndReached during refresh');
      return;
    }
    
    if (hasMore && searchQuery) {
      // console.log('Incrementing offset to:', offset + 1);
      setOffset(prev => prev + 1);
    } else {
      // console.log('Not loading more because:', { 
      //   hasMore, 
      //   searchQuery: !!searchQuery,
      //   reason: !hasMore ? 'no more products' : 'no search query'
      // });
    }
  }, [hasMore, searchQuery]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    // Set the refreshing ref to true to prevent end reached during refresh
    isRefreshingRef.current = true;
    setOffset(1);
    setRefreshing(true);
    setHasMore(true);
    // Clear products immediately
    setProducts([]);
    setAllProducts([]);

    try {
      await loadProducts(selectedSort || 'popularity', 1);
    } finally {
      setRefreshing(false);
      // Reset the refreshing ref after refresh is complete
      isRefreshingRef.current = false;
    }
  }, [selectedSort]);

  // Handle product press
  const handleProductPress = useCallback(async (product: Product) => {
    // Get source from product data, fallback to selectedPlatform
    const source = (product as any).source || selectedPlatform || '1688';
    await navigateToProductDetail(product.id, source, locale);
  }, [locale, selectedPlatform]);

  // Handle like press
  const handleLikePress = useCallback(async (product: Product) => {
    await toggleWishlist(product);
  }, []);

  // Handle store press
  const handleStorePress = (storeId: number) => {
    // Navigate to store profile or detail screen
    // console.log('Store pressed:', storeId);
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
      Alert.alert(t('search.messages.permissionRequired'), t('search.messages.grantCameraPermission'));
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
        Alert.alert(t('common.error'), response.errorMessage || t('search.messages.failedToTakePhoto'));
        return;
      }
      if (response.assets && response.assets[0]) {
        setImagePickerModalVisible(false);
        let base64Data = response.assets[0].base64;
        
        // Image is already compressed with quality: 0.5 in camera options
        // Only compress if base64 is not available (fallback case)
        if (!base64Data && response.assets[0].uri) {
          const { compressImageForSearch } = require('../../../utils/imageCompression');
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
      Alert.alert(t('search.messages.permissionRequired'), t('search.messages.grantPhotoLibraryPermission'));
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
        Alert.alert(t('common.error'), response.errorMessage || t('search.messages.failedToPickImage'));
        return;
      }
      if (response.assets && response.assets[0]) {
        setImagePickerModalVisible(false);
        let base64Data = response.assets[0].base64;
        
        // Image is already compressed with quality: 0.5 in gallery options
        // Only compress if base64 is not available (fallback case)
        if (!base64Data && response.assets[0].uri) {
          const { compressImageForSearch } = require('../../../utils/imageCompression');
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

  // Render header
  const renderHeader = () => (
    <View style={styles.header}>
      <View 
        style={styles.headerTop}
        onLayout={(event) => {
          const { height } = event.nativeEvent.layout;
          headerTopHeightRef.current = height;
        }}
      >
        <TouchableOpacity 
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >          
          <ArrowBackIcon width={12} height={20} color={COLORS.black} />
        </TouchableOpacity>
        <View style={styles.searchButtonContainer}>
          <View style={styles.searchBar}>
            <TouchableOpacity style={styles.cameraButton} onPress={handleTakePhoto}>
              <CameraIcon width={20} height={20} color={COLORS.black} />
              <View style={styles.cameraButtonText}/>
            </TouchableOpacity>
            {!isSearchFocused && !searchQuery && (
              <View style={styles.trendingTextContainer} pointerEvents="none">
                <Text style={styles.trendingText}>{t('search.trending')}</Text>
                <Text style={styles.keywordText}>{t('search.keyword')}</Text>
              </View>
            )}
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={handleSearchQueryChange}
              // placeholder={!isSearchFocused && !searchQuery ? '' : t('search.placeholder')}
              placeholderTextColor={COLORS.gray[400]}
              returnKeyType="search"
              onFocus={() => {
                setIsSearchFocused(true);
                if (searchQuery && searchQuery.trim().length > 0 && autocompleteSuggestions.length > 0) {
                  setShowAutocomplete(true);
                }
              }}
              onBlur={() => {
                setIsSearchFocused(false);
                // Delay hiding autocomplete to allow selection
                setTimeout(() => setShowAutocomplete(false), 200);
              }}
              onSubmitEditing={handleSearch}
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => {
                setSearchQuery('');
                setShowAutocomplete(false);
                setAutocompleteSuggestions([]);
              }} style={styles.clearButton}>
                <Icon name="close-outline" size={20} color={COLORS.black} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity 
              style={styles.searchIconContainer}
              onPress={handleSearch}
            >
              <Icon name="search" size={16} color={COLORS.white} style={styles.searchIcon} />
            </TouchableOpacity>
          </View>
        </View>
      </View>
      {searchQuery.trim() && renderCompanyTabs()}
    </View>
  )

  // Products are already filtered by API based on selectedCompany (platform parameter)
  // No need for client-side filtering since API handles it
  const filteredProducts = useMemo(() => {
    return products;
  }, [products]);

  // Render company filter tabs
  const renderCompanyTabs = () => {
    // Always show company tabs if there are any companies (at least "All")
    // Show even when search query is cleared
    if (companies.length === 0) return null;
    
    return (
      <View style={styles.companyTabsContainer}>
        <ScrollView 
          horizontal 
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.companyTabs}
        >
          {companies.map((company, index) => {
            const isSelected = selectedCompany === company;
            
            return (
              <TouchableOpacity
                key={`company-${company}-${index}`}
                style={[
                  styles.companyTab,
                  index === companies.length - 1 && { marginRight: SPACING.md },
                  index === 0 && { marginLeft: SPACING.md }
                ]}
                onPress={() => {
                  setSelectedCompany(company);
                  selectedCompanyRef.current = company;
                  const platform = getPlatformFromCompany(company);
                  setSelectedPlatform(platform);
                  // console.log('[SearchScreen] Company selected:', company, 'Platform updated to:', platform);
                  // Reload products when company changes
                  setPage(1);
                  setOffset(1);
                  setHasMore(true);
                  setProducts([]);
                  setAllProducts([]);
                  loadProducts(selectedSort || 'best_match', 1);
                }}
              >
                <Text style={[
                  styles.companyTabText,
                  isSelected && styles.activeCompanyTabText
                ]}>
                  {company === 'All' ? t('common.all') : company}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    );
  };

  // Render sort and filter bar
  const renderSortAndFilter = () => (
    <View style={styles.sortFilterBar}>
      <View style={styles.sortButton}>
        <SortDropdown
          options={sortOptions}
          selectedValue={selectedSort}
          onSelect={(value) => {
            setSelectedSort(value);
            // Sort existing products locally (no API call needed)
            if (allProducts.length > 0) {
              const sorted = sortProducts(allProducts, value);
              setProducts(sorted);
            }
          }}
          textColor={COLORS.black}
          iconColor={COLORS.black}
        />
      </View>
      {/* <TouchableOpacity 
        style={styles.filterButton}
        onPress={() => setPriceFilterModalVisible(true)}
      >
        <ViewListIcon width={20} height={20} color={COLORS.black} />
      </TouchableOpacity> */}
    </View>
  );


  // Render store carousel
  const renderStoreCarousel = () => (
    <View style={styles.storeBannersContainer}>
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.storeBanners}
      >
        {Array.isArray(memoizedStores) && memoizedStores.map((store, index) => (
          <TouchableOpacity key={`store-${store.id || index}`} style={styles.storeBanner}>
            <Image 
              source={store.avatar || (store.logo ? { uri: store.logo } : require('../../../assets/images/avatar.png'))}
              style={styles.storeAvatar}
              resizeMode="cover"
            />
             <Text style={styles.storeName} numberOfLines={2}>{store.name}</Text>
            <Icon name="chevron-forward" size={16} color={COLORS.gray[400]} />
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );

  // Render product item using ProductCard with moreToLove variant
  const renderProductItem = useCallback(({ item }: { item: any }) => {
    if (!item) {
      return null;
    }
    
    // Parse variation data if it exists
    let price = item.price || 0;
    let productImage = '';
    
    if (item.variation) {
      try {
        const variations = JSON.parse(item.variation);
        if (Array.isArray(variations) && variations.length > 0 && variations[0].options && variations[0].options.length > 0) {
          price = variations[0].options[0].price;
          productImage = variations[0].options[0].image;
        }
      } catch (e) {
        // console.error('Error parsing variations:', e);
      }
    }
    
    // Get image from item - API returns 'image' (singular), Product type expects 'image' (string)
    const itemImage = item.image || item.imageUrl || productImage || '';
    
    // Create Product object
    const productId = item.id?.toString() || item.externalId?.toString() || '';
    const externalId = item.externalId?.toString() || item.id?.toString() || '';
    const offerId = item.offerId?.toString() || item.externalId?.toString() || item.id?.toString() || '';
    
    const product: Product = {
      id: productId,
      externalId: externalId,
      offerId: offerId,
      name: item.name || item.title || 'Unknown Product',
      description: item.description || item.titleOriginal || item.title || '',
      price: price,
      originalPrice: item.originalPrice,
      discount: item.discount,
      image: itemImage,
      category: item.category || { id: '', name: '', icon: '', image: '', subcategories: [] },
      subcategory: item.subcategory || '',
      brand: item.brand || '',
      seller: item.seller || {
        id: '',
        name: '',
        avatar: '',
        rating: 0,
        reviewCount: 0,
        isVerified: false,
        followersCount: 0,
        description: '',
        location: '',
        joinedDate: new Date()
      },
      rating: item.rating || 0,
      reviewCount: item.reviewCount || item.rating_count || 0,
      rating_count: item.rating_count || 0,
      inStock: item.inStock !== undefined ? item.inStock : true,
      stockCount: item.stockCount || item.stock_count || 0,
      sizes: item.sizes || [],
      colors: item.colors || [],
      tags: item.tags || [],
      isNew: item.isNew !== undefined ? item.isNew : false,
      isFeatured: item.isFeatured !== undefined ? item.isFeatured : false,
      isOnSale: item.isOnSale !== undefined ? item.isOnSale : false,
      createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
      updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
      orderCount: item.orderCount || item.order_count || 0,
    };
    
    return (
      <ProductCard
        product={product}
        variant="moreToLove"
        onPress={() => handleProductPress(product)}
        onLikePress={() => handleLikePress(product)}
        isLiked={isProductLiked(product)}
        cardWidth={CARD_WIDTH}
      />
    );
  }, [handleLikePress, handleProductPress, isProductLiked]);

  const productKeyExtractor = useCallback(
    (item: any, index: number) => `product-${item.id?.toString() || index}-${index}`,
    [],
  );

  const autocompleteKeyExtractor = useCallback(
    (item: string, index: number) => `autocomplete-${index}-${item}`,
    [],
  );
  
  // Handle clear filters
  const handleClearFilters = useCallback(() => {
    setMinPrice('');
    setMaxPrice('');
    
    // Reset to first page when filters are cleared
    setOffset(1);
    setHasMore(true);
    setProducts([]); // Clear existing products
    setAllProducts([]);
    loadProducts(selectedSort || 'popularity', 1);
  }, [selectedSort]);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.headerWrapper}>
          {renderHeader()}
          {/* Autocomplete Suggestions Dropdown - positioned below search bar */}
          {showAutocomplete && searchQuery && searchQuery.trim().length > 0 && (
            <View style={[styles.autocompleteContainer, { top: headerTopHeightRef.current }]}>
              {isAutocompleteLoading && (
                <View style={styles.autocompleteLoading}>
                  <ActivityIndicator size="small" color={COLORS.primary} />
                  <Text style={styles.autocompleteLoadingText}>Loading suggestions...</Text>
                </View>
              )}
              {!isAutocompleteLoading && autocompleteSuggestions.length === 0 && (
                <View style={styles.autocompleteEmpty}>
                  <Text style={styles.autocompleteEmptyText}>No suggestions found</Text>
                </View>
              )}
              {!isAutocompleteLoading && autocompleteSuggestions.length > 0 && (
                <FlatList
                  data={autocompleteSuggestions}
                  keyExtractor={autocompleteKeyExtractor}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={styles.autocompleteItem}
                      onPress={() => {
                        setSearchQuery(item);
                        setShowAutocomplete(false);
                        setSelectedCompany('All');
                        selectedCompanyRef.current = 'All';
                        setOffset(1);
                        setHasMore(true);
                        setProducts([]);
                        setAllProducts([]);
                        loadProducts(selectedSort || 'best_match', 1, item);
                      }}
                    >
                      <Icon name="search" size={16} color={COLORS.text.secondary} style={styles.autocompleteIcon} />
                      <Text style={styles.autocompleteText} numberOfLines={1}>{item}</Text>
                    </TouchableOpacity>
                  )}
                  style={styles.autocompleteList}
                  contentContainerStyle={styles.autocompleteListContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled={true}
                  scrollEnabled={true}
                />
              )}
            </View>
          )}
        </View>
        
        {/* Show product list only when there's a non-empty search query; otherwise show recent searches + keep shopping for */}
        {searchQuery.trim() ? (
          <View style={styles.contentContainer}>
            {/* Sort and Filter Bar */}
            {renderSortAndFilter()}
            
            {/* Product List */}
            <>
              {/* Category loading overlay */}
              {/* Loading spinner removed */}
              
              {/* Product list with moreToLove variant */}
              <FlatList
              ref={flatListRef}
              data={filteredProducts}
              renderItem={renderProductItem}
              keyExtractor={productKeyExtractor}
              numColumns={2}
              columnWrapperStyle={styles.productGrid}
              contentContainerStyle={styles.productListContent}
              showsVerticalScrollIndicator={false}
              onEndReached={handleEndReached}
              onEndReachedThreshold={0.5}
              removeClippedSubviews={true}
              maxToRenderPerBatch={10}
              windowSize={10}
              initialNumToRender={10}
              updateCellsBatchingPeriod={50}
              refreshControl={
                <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
              }
              style={styles.productList}
              ListFooterComponent={
                (isSearching || dualPlatformLoading) && currentPageOffsetRef.current > 1 ? (
                  <View style={styles.loadMoreFooter}>
                    <ActivityIndicator size="small" color={COLORS.primary} />
                    <Text style={styles.loadMoreFooterText}>{t('home.loadingMore')}</Text>
                  </View>
                ) : null
              }
                />
              
              {/* Loading overlay for initial search only */}
              {(isSearching || dualPlatformLoading) && currentPageOffsetRef.current === 1 && (
                <View style={styles.loadingOverlay}>
                  <ActivityIndicator size="large" color={COLORS.primary} />
                  <Text style={{ marginTop: SPACING.sm, color: COLORS.text.primary }}>
                    Searching products...
                  </Text>
                </View>
              )}
              </>
          </View>
        ) : (
          <View style={styles.contentContainer}>
          <ScrollView 
            style={styles.recentSearchesScrollContainer}
            contentContainerStyle={styles.recentSearchesContentContainer}
            showsVerticalScrollIndicator={false}
          >
            {/* Recent Searches Section */}
            <View style={styles.recentSearchesContainer}>
              <View style={styles.recentSearchesHeader}>
                <Text style={styles.recentSearchesTitle}>{t('search.recentSearches')}</Text>
                {!isGuest && user && recentSearches.length > 0 && (
                  <TouchableOpacity onPress={() => setClearHistoryConfirmVisible(true)}>
                    {/* <Text style={styles.clearAllButton}>{t('search.clean')}</Text> */}
                    <DeleteIcon width={16} height={16} />
                  </TouchableOpacity>
                )}
              </View>
              {!isGuest && user ? (
                <View style={styles.recentSearchesList}>
                  
                  {recentSearches.length > 0 ? (
                    recentSearches.map((item, index) => {
                      const itemValue = typeof item === 'string' ? item : String(item || '');
                      
                      // Skip empty items
                      if (!itemValue || itemValue.trim().length === 0) {
                        return null;
                      }
                      
                      return (
                        <View key={`recent-${index}`} style={styles.recentSearchItemContainer}>
                          <Text 
                            style={styles.recentSearchText} 
                            numberOfLines={1} 
                            ellipsizeMode="tail"
                            onPress={() => {
                              isRecentSearchClickRef.current = true;
                              setSearchQuery(itemValue);
                              setSelectedCompany('All');
                              selectedCompanyRef.current = 'All';
                              setOffset(1);
                              setHasMore(true);
                              setProducts([]);
                              setAllProducts([]);
                              setShowAutocomplete(false);
                              loadProducts(selectedSort || 'best_match', 1, itemValue);
                            }}
                          >
                            {itemValue}
                          </Text>
                          <TouchableOpacity
                            style={styles.deleteKeywordButton}
                            onPress={() => {
                              deleteKeyword(itemValue);
                            }}
                          >
                            <Icon name="close-circle" size={20} color={COLORS.text.secondary} />
                          </TouchableOpacity>
                        </View>
                      );
                    }).filter(Boolean)
                  ) : (
                    <View style={styles.recentSearchesList}>
                      <Text style={styles.recentSearchText}>{t('search.noRecentSearches')}</Text>
                    </View>
                  )}
                </View>
              ) : null}
            </View>
            
            {/* Keep Shopping For Section */}
            {/* {!isGuest && user && keepShoppingForProducts.length > 0 && (
              <View style={styles.keepShoppingForContainer}>
                <Text style={styles.keepShoppingForTitle}>
                  {t('search.keepShoppingFor')}
                </Text>
                <View style={styles.keepShoppingForGrid}>
                  {keepShoppingForProducts.map((item, index) => {
                    // Map API product to Product format
                    // Parse price as float to ensure it's a number
                    const price = parseFloat(item.price || item.originalPrice || '0') || 0;
                    const originalPrice = parseFloat(item.originalPrice || item.price || '0') || price;
                    const discount = originalPrice > price && originalPrice > 0
                      ? Math.round(((originalPrice - price) / originalPrice) * 100)
                      : 0;
                    
                    const product: Product = {
                      id: item.externalId?.toString() || item._id?.toString() || '',
                      externalId: item.externalId?.toString() || '',
                      offerId: item.externalId?.toString() || '',
                      name: item.title || 'Unknown Product',
                      description: item.title || '',
                      price: price,
                      originalPrice: originalPrice,
                      discount: discount,
                      image: item.imageUrl || '',
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
                        joinedDate: new Date()
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
                    };
                    
                    // Add source to product for navigation
                    (product as any).source = item.source || '1688';
                    
                    return (
                      <ProductCard
                        key={`keep-shopping-${product.id || index}`}
                        product={product}
                        variant="simple"
                        onPress={() => {
                          const source = item.source || '1688';
                          navigateToProductDetail(product.id, source, locale);
                        }}
                        cardWidth={CARD_WIDTH}
                      />
                    );
                  })}
                </View>
              </View>
            )} */}
          </ScrollView>
          </View>
        )}
      </SafeAreaView>

      {/* Clear history confirm modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={clearHistoryConfirmVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setClearHistoryConfirmVisible(false)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.clearHistoryModalOverlay}
          onPress={() => setClearHistoryConfirmVisible(false)}
        >
          <View style={styles.clearHistoryModalContent} onStartShouldSetResponder={() => true}>
            <Text style={styles.clearHistoryModalMessage}>
              {t('search.clearHistoryConfirm')}
            </Text>
            <View style={styles.clearHistoryModalButtons}>
              <TouchableOpacity
                style={[styles.clearHistoryModalButton, styles.clearHistoryModalButtonCancel]}
                onPress={() => setClearHistoryConfirmVisible(false)}
              >
                <Text style={styles.clearHistoryModalButtonCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.clearHistoryModalButton, styles.clearHistoryModalButtonConfirm]}
                onPress={() => {
                  setClearHistoryConfirmVisible(false);
                  clearHistory();
                }}
              >
                <Text style={styles.clearHistoryModalButtonConfirmText}>{t('common.confirm')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Image Picker Modal */}
      <ImagePickerModal
        visible={imagePickerModalVisible}
        onClose={() => setImagePickerModalVisible(false)}
        onTakePhoto={handleTakePhoto}
        onChooseFromGallery={handleChooseFromGallery}
      />

      {/* Price Filter Modal */}
      <PriceFilterModal
        visible={priceFilterModalVisible}
        onClose={() => setPriceFilterModalVisible(false)}
        onApply={(min, max) => {
          setMinPrice(min);
          setMaxPrice(max);
          // Reset to first page and reload products with new price filter
          setOffset(1);
          setHasMore(true);
          setProducts([]);
          setAllProducts([]);
            loadProducts(selectedSort || 'popularity', 1);
        }}
        initialMinPrice={minPrice}
        initialMaxPrice={maxPrice}
      />
    </View>
  );
};

// Styles
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.white,
  },
  safeArea: {
    backgroundColor: COLORS.white,
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: SPACING.sm,
  },
  headerWrapper: {
    position: 'relative',
    zIndex: 100,
  },
  header: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingTop: SPACING.sm,
    paddingBottom: SPACING.sm,
    gap: SPACING.sm,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchButtonContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 2.5,
    paddingHorizontal: SPACING.md,
    paddingRight: SPACING.xs,
    paddingVertical: SPACING.xs,
    minHeight: 35,
  },
  searchIconContainer: {
    padding: SPACING.xs,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.black,
    borderRadius: BORDER_RADIUS.full,
  },
  searchIcon: {
    marginRight: SPACING.xs,
  },
  searchInput: {
    flex: 1,
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    padding: 0,
  },
  trendingTextContainer: {
    position: 'absolute',
    left: 40 +SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 0,
  },
  trendingText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.red,
    fontWeight: '600',
  },
  keywordText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  clearButton: {
    marginLeft: SPACING.xs,
  },
  cameraButton: {
    width: 35,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  cameraButtonText: {
    borderLeftWidth: 1,
    borderLeftColor: COLORS.text.secondary,
    height: 10,
  },
  companyTabsContainer: {
    backgroundColor: COLORS.white,
    paddingBottom: SPACING.md,
  },
  companyTabs: {
    alignItems: 'center',
  },
  companyTab: {
    paddingHorizontal: SPACING.smmd,
    paddingVertical: SPACING.xs,
    // marginRight: SPACING.md,
  },
  companyTabText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.black,
    fontWeight: '700',
  },
  activeCompanyTabText: {
    color: COLORS.text.red,
    fontWeight: '600',
  },
  categoryTabsContainer: {
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  categoryTabsWrapper: {
    position: 'relative',
  },
  categoryTabs: {
    // paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  categoryTab: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginRight: SPACING.lg,
  },
  categoryTabText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[500],
    fontWeight: '500',
  },
  activeCategoryTabText: {
    color: COLORS.black,
    fontWeight: '600',
  },
  categoryBaseline: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: COLORS.gray[200],
  },
  categoryIndicator: {
    position: 'absolute',
    bottom: 0,
    height: 3,
    backgroundColor: COLORS.black,
    borderRadius: 1.5,
  },
  sortFilterBar: {
    flexDirection: 'row',
    paddingVertical: SPACING.sm,
    justifyContent: 'space-between',
  },
  sortButton: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xs,
    paddingHorizontal: SPACING.md,
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.full,
    borderWidth: 1,
    borderRightWidth: 1,
    borderColor: COLORS.gray[200],
    marginLeft: SPACING.md,
  },
  filterButton: {
    width: 50,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.sm,
  },
  sortButtonText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.black,
    fontWeight: '500',
    marginRight: SPACING.xs,
  },
  storeCarousel: {
    backgroundColor: COLORS.white,
  },
  storeCarouselContent: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  storeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.gray[100],
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginRight: SPACING.md,
    minWidth: 200,
  },
  // Adding store banner styles to match HomeScreen
  storeBannersContainer: {
    backgroundColor: COLORS.white,
    paddingBottom: SPACING.md,
    paddingTop: SPACING.sm,
  },
  storeBanners: {
    paddingHorizontal: SPACING.md,
  },
  storeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: SPACING.sm,
    marginRight: SPACING.sm,
    marginVertical: SPACING.xs,
    ...SHADOWS.sm,
  },
  storeAvatar: {
    width: 40,
    height: 40,
    // borderRadius: 20,
    marginRight: SPACING.sm,
  },
  storeName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
    flex: 1,
  },
  productGrid: {
    // paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
    justifyContent: 'space-between',
  },
  productListContent: {
    paddingBottom: 120,
  },
  productList: {
    flex: 1,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  loadMoreFooter: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.md,
    gap: SPACING.xs,
  },
  loadMoreFooterText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  productCard: {
    width: CARD_WIDTH,
    backgroundColor: COLORS.white,
    marginBottom: SPACING.md,
  },
  productImageContainer: {
    position: 'relative',
  },
  productImageScrollView: {
    width: '100%',
    height: CARD_WIDTH * 1.3,
  },
  productImage: {
    width: CARD_WIDTH,
    height: CARD_WIDTH * 1.3,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.gray[200]
  },
  discountBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  discountText: {
    color: COLORS.white,
    fontSize: 10,
    fontWeight: 'bold',
  },
  likeButton: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Adding trending heart button styles to match HomeScreen
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
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: COLORS.white,
  },
  productInfo: {
    padding: SPACING.sm,
  },
  productName: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '500',
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  originalPrice: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[500],
    textDecorationLine: 'line-through',
    marginRight: SPACING.xs,
  },
  productPrice: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.red,
  },
  ratingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ratingText: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '500',
    color: COLORS.text.primary,
    marginLeft: 4,
  },
  soldText: {
    fontSize: FONTS.sizes.xs,
    fontWeight: '500',
    color: COLORS.text.primary,
    marginLeft: 8,
  },
  recentSearchesScrollContainer: {
    flex: 1,
  },
  recentSearchesContentContainer: {
    paddingBottom: SPACING.xl,
  },
  recentSearchesContainer: {
    padding: SPACING.sm,
  },
  recentSearchesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  recentSearchesTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.text.primary,
  },
  clearAllButton: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  debugContainer: {
    marginTop: SPACING.lg,
    marginHorizontal: SPACING.md,
    padding: SPACING.md,
    backgroundColor: '#FFF3CD',
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 2,
    borderColor: '#FFC107',
  },
  debugTitle: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: '#856404',
    marginBottom: SPACING.xs,
  },
  debugText: {
    fontSize: FONTS.sizes.xs,
    color: '#856404',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    lineHeight: Math.round(FONTS.sizes.xs * 16 / 12),
  },
  keepShoppingForContainer: {
    marginTop: SPACING.lg,
    // paddingHorizontal: SPACING.sm,
  },
  keepShoppingForTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginBottom: SPACING.md,
  },
  keepShoppingForGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  autocompleteContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
    maxHeight: 300,
    zIndex: 1000,
    ...SHADOWS.md,
  },
  autocompleteList: {
    flexGrow: 0,
  },
  autocompleteListContent: {
    paddingBottom: SPACING.xs,
  },
  autocompleteItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  autocompleteIcon: {
    marginRight: SPACING.sm,
  },
  autocompleteText: {
    flex: 1,
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
  },
  autocompleteLoading: {
    padding: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  autocompleteLoadingText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  autocompleteEmpty: {
    padding: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autocompleteEmptyText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
  },
  recentSearchesList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  recentSearchItemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.gray[200],
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.xs,
    minHeight: 36,
    maxWidth: width - SPACING.md * 2,
    flexShrink: 1,
  },
  recentSearchItem: {
    flex: 1,
    minHeight: 20,
    justifyContent: 'center',
    paddingRight: SPACING.xs,
  },
  recentSearchText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
    includeFontPadding: true,
    textAlignVertical: 'center',
    lineHeight: FONTS.sizes.sm * 1.4,
    maxWidth: width - 88
  },
  deleteKeywordButton: {
    width: 40,
    marginLeft: SPACING.xs,
    padding: SPACING.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterSection: {
    backgroundColor: COLORS.white,
    flex: 1,
    justifyContent: 'space-between',
  },
  filterMainContent: {
    flexDirection: 'row',
    flex: 1,
  },
  filterLeftColumn: {
    width: 120,
    backgroundColor: COLORS.gray[100],
    borderRightWidth: 1,
    borderRightColor: COLORS.gray[200],
  },
  filterCategoryItem: {
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.sm,
    backgroundColor: COLORS.gray[100],
  },
  filterCategoryItemActive: {
    backgroundColor: COLORS.white,
  },
  filterCategoryText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    textAlign: 'center',
    fontWeight: '500',
  },
  filterCategoryTextActive: {
    fontWeight: '600',
    color: COLORS.red,
  },
  filterRightColumn: {
    flex: 1,
    padding: SPACING.md,
  },
  filterOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  filterOptionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  filterOptionsList: {
    gap: SPACING.sm,
  },
  filterOption: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.gray[100],
    borderWidth: 2,
    borderColor: 'transparent',
  },
  filterOptionWide: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.gray[100],
    borderWidth: 2,
    borderColor: 'transparent',
    minWidth: '45%',
    alignItems: 'center',
  },
  filterOptionFull: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: COLORS.gray[100],
    borderWidth: 2,
    borderColor: 'transparent',
    width: '100%',
  },
  filterOptionSelected: {
    backgroundColor: COLORS.white,
    borderColor: '#3B82F6',
  },
  filterOptionText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  filterOptionTextSelected: {
    color: '#3B82F6',
    fontWeight: '600',
    fontSize: FONTS.sizes.md,
  },
  priceInputContainer: {
    padding: SPACING.sm,
  },
  priceInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  priceInputWrapper: {
    flex: 1,
  },
  priceInputLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.secondary,
    marginBottom: SPACING.xs,
    fontWeight: '500',
  },
  priceInput: {
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    fontSize: FONTS.sizes.md,
    backgroundColor: COLORS.white,
  },
  priceSeparator: {
    fontSize: FONTS.sizes.lg,
    color: COLORS.text.secondary,
    marginTop: 20,
  },
  confirmButtonContainer: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
  },
  confirmButton: {
    backgroundColor: COLORS.transparent,
    borderRadius: 50,
    paddingVertical: SPACING.md + 2,
  },
  confirmButtonText: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
  },
  clearHistoryModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.lg,
  },
  clearHistoryModalContent: {
    backgroundColor: COLORS.white,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    width: '100%',
    maxWidth: 300,
  },
  clearHistoryModalMessage: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    textAlign: 'center',
    marginBottom: SPACING.xl,
  },
  clearHistoryModalButtons: {
    flexDirection: 'row',
    gap: SPACING.md,
    justifyContent: 'center',
    width: '100%'
  },
  clearHistoryModalButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
  },
  clearHistoryModalButtonCancel: {
    backgroundColor: COLORS.gray[200],
  },
  clearHistoryModalButtonCancelText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    fontWeight: '600',
  },
  clearHistoryModalButtonConfirm: {
    backgroundColor: COLORS.text.red,
  },
  clearHistoryModalButtonConfirmText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.white,
    fontWeight: '600',
  },
});

export default SearchScreenComponent;

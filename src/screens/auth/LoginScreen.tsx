import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  BackHandler,
  Modal,
  FlatList,
  TextInput as RNTextInput,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Icon from '../../components/Icon';
import ArrowBackIcon from '../../assets/icons/ArrowBackIcon';
import ArrowDownIcon from '../../assets/icons/ArrowDownIcon';
import { Button, TextInput } from '../../components';
import LinearGradient from 'react-native-linear-gradient';
import { useNavigation, useFocusEffect, useRoute } from '@react-navigation/native';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useLoginMutation, useSocialLoginMutation } from '../../hooks/useAuthMutations';
import { COLORS, FONTS, SPACING, BORDER_RADIUS, SHADOWS, ERROR_MESSAGES, SCREEN_HEIGHT } from '../../constants';
import { useAppSelector } from '../../store/hooks';
import { translations } from '../../i18n/translations';
import ShieldCheckIcon from '../../assets/icons/ShieldCheckIcon';
import ArrowDropDownIcon from '../../assets/icons/ArrowDropDownIcon';

// GoogleSignin.configure({
//   webClientId: '504835766110-ionim2k1keti3uhom9quotmifkimg42o.apps.googleusercontent.com',
// });

const LoginScreen: React.FC = () => {
  
  // const handleGoogleResponse = async () => { 
  //   try {
  //     console.log("Google Sign In");
  //     await GoogleSignin.hasPlayServices();
  //     const user = await GoogleSignin.signIn();
  //     console.log("Google User:", user);
  //     if (isSuccessResponse(user)) {
  //       // setData(user);
  //       // setIsSuccess(true);
  //       // options?.onSuccess?.(user);
  //       console.log("Success: ", user)
  //     }
  //   } catch (error) {
  //     if (isErrorWithCode(error)) {
  //       switch (error.code) {
  //         case "SIGN_IN_REQUIRED":
  //           console.log("User needs to sign in");
  //           break;
  //         case "PLAY_SERVICES_NOT_AVAILABLE":
  //           console.log("Play services are not available");
  //           break;
  //         default:
  //           console.log("Unknown error");
  //       }
  //     }
  //   }
  // };

  const navigation = useNavigation();
  const route = useRoute<any>();
  const returnTo = route.params?.returnTo;
  const returnParams = route.params?.returnParams;
  const { loginError, clearLoginError, isGuest, setAuthenticatedUser, clearNavigateToProfile } = useAuth();
  const { showToast } = useToast();
  const locale = useAppSelector((state) => state.i18n.locale) as 'en' | 'ko' | 'zh';
  
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
  
  const { mutate: login, isLoading, isError, error, isSuccess, data } = useLoginMutation({
    onSuccess: (data) => {
      console.log('🔵 LOGIN SUCCESS:', data);
      if (data && data.user) {
        // Create a full User object from the partial data (new API uses users_id)
        const user = {
          id: data.user.id || (data.user as any).users_id || Date.now().toString(),
          email: data.user.email || '',
          name: data.user.name || (data.user as any).users_id || 'User',
          memberId: (data.user as any).memberId || (data.user as any).tjMemberId || '',
          avatar: data.user.avatar || 'https://via.placeholder.com/150',
          phone: data.user.phone || '',
          addresses: data.user.addresses || [],
          paymentMethods: data.user.paymentMethods || [],
          wishlist: data.user.wishlist || [],
          followersCount: data.user.followersCount || 0,
          followingsCount: data.user.followingsCount || 0,
          depositBalance: (data.user as any).depositBalance ?? 0,
          points: (data.user as any).points ?? 0,
          preferences: data.user.preferences || {
            notifications: {
              email: true,
              push: true,
              sms: true,
            },
            language: 'en',
            currency: 'USD',
          },
          createdAt: data.user.createdAt || new Date(),
          updatedAt: data.user.updatedAt || new Date(),
          userUniqueId: data.user.userUniqueId || '',
          userUniqueNo: data.user.userUniqueNo || '',
        };
        setAuthenticatedUser(user);
        showToast(t('auth.login.success') || 'Login successful', 'success');
        // Navigate back to the previous page, or to returnTo param, or fall back to Main
        if (returnTo) {
          (navigation as any).navigate(returnTo, returnParams);
        } else if (navigation.canGoBack()) {
          navigation.goBack();
        } else {
          navigation.navigate('Main' as never);
        }
      }
    },
    onError: (error, errorCode) => {
      console.log('🔴 LOGIN ERROR:', { error, errorCode });
      let errorMessage = error;
      let errorField: 'email' | 'password' = 'password';

      switch (errorCode) {
        case 'INVALID_CREDENTIALS':
          errorMessage = t('auth.accountOrPasswordIncorrect') || 'Your account name or password is incorrect.';
          break;
        case 'USER_NOT_REGISTERED':
          showToast(
            t('auth.userNotRegistered') || 'No account with this User ID. Please sign up first.',
            'info',
          );
          (navigation as any).navigate('Signup', { prefillUserId: formData.email });
          return;
        case 'EMAIL_NOT_VERIFIED':
          errorMessage = t('auth.emailNotVerified') || 'Please verify your email before logging in.';
          errorField = 'email';
          break;
        case 'VALIDATION_ERROR':
          errorMessage = error || t('auth.checkInput');
          break;
        default:
          errorMessage = error || t('auth.accountOrPasswordIncorrect') || 'Your account name or password is incorrect.';
      }

      setErrors({ [errorField]: errorMessage });
    }
  });
  
  // Track which provider is being used for social login
  const { mutate: socialLoginMutation, isLoading: isSocialLoading, isError: isSocialError, error: socialError } = useSocialLoginMutation({
    onSuccess: async (data) => {
      // Handle successful social login - data already contains token, refreshToken, and user from backend
      // Update AuthContext with user data
      const user = {
        id: data.user.id || data.user.email || Date.now().toString(),
        email: data.user.email || '',
        name: data.user.name || data.user.email?.split('@')[0] || 'User',
        avatar: data.user.avatar || 'https://via.placeholder.com/150',
        phone: data.user.phone || '',
        addresses: data.user.addresses || [],
        paymentMethods: data.user.paymentMethods || [],
        wishlist: data.user.wishlist || [],
        followersCount: data.user.followersCount || 0,
        followingsCount: data.user.followingsCount || 0,
        depositBalance: (data.user as any).depositBalance ?? 0, // Preserve depositBalance
        points: (data.user as any).points ?? 0, // Preserve points
        preferences: data.user.preferences || {
          notifications: {
            email: true,
            push: true,
            sms: true,
          },
          language: 'en',
          currency: 'USD',
        },
        createdAt: data.user.createdAt || new Date(),
        updatedAt: data.user.updatedAt || new Date(),
      };
      
      setAuthenticatedUser(user);
      showToast(t('auth.login.success') || 'Login successful', 'success');
      if (returnTo) {
        (navigation as any).navigate(returnTo, returnParams);
      } else if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('Main' as never);
      }
    },
    onError: (error) => {
      // Handle social login error
      showToast(error || t('auth.loginFailed') || 'Login failed', 'error');
    }
  });

  // Resend verification code mutation
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [errors, setErrors] = useState<{ [key: string]: string }>({});
  // Simplified login: use email + password on one screen
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showEmailSuggestions, setShowEmailSuggestions] = useState(false);
  const [emailSuggestions, setEmailSuggestions] = useState<string[]>([]);
  const [showCountryCodeModal, setShowCountryCodeModal] = useState(false);
  const [countryCode, setCountryCode] = useState('+82');
  const [showPassword, setShowPassword] = useState(false);
  
  // Common email domains
  const commonEmailDomains = [
    'qq.com',
    'aol.com',
    'hotmail.com',
    'icloud.com',
    'gmail.com',
    'outlook.com',
    'naver.com',
    'yahoo.com',
    'kakao.com',
  ];
  
  // Common country codes
  const countryCodes = [
    { code: '+82', flag: '🇰🇷', name: 'South Korea' },
    { code: '+1', flag: '🇺🇸', name: 'United States' },
    { code: '+86', flag: '🇨🇳', name: 'China' },
    { code: '+81', flag: '🇯🇵', name: 'Japan' },
    { code: '+44', flag: '🇬🇧', name: 'United Kingdom' },
    { code: '+33', flag: '🇫🇷', name: 'France' },
    { code: '+49', flag: '🇩🇪', name: 'Germany' },
    { code: '+61', flag: '🇦🇺', name: 'Australia' },
    { code: '+65', flag: '🇸🇬', name: 'Singapore' },
    { code: '+852', flag: '🇭🇰', name: 'Hong Kong' },
  ];

  // Watch for login success and navigate accordingly
  useEffect(() => {
    if (isSuccess && data) {
      // If we have a returnTo param, navigate back to that screen
      if (returnTo) {
        Promise.resolve().then(() => {
          // Navigate back to the previous screen (ProductDetail)
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            // Fallback: navigate to ProductDetail with params
            (navigation as any).navigate(returnTo, returnParams);
          }
        });
      } else {
        // Navigate to main app (default behavior)
        Promise.resolve().then(() => {
          navigation.navigate('Main' as never);
        });
      }
    }
  }, [isSuccess, data, navigation, returnTo, returnParams]);

  const validateForm = () => {
    const newErrors: { [key: string]: string } = {};

    if (!formData.email) {
      newErrors.email = ERROR_MESSAGES.REQUIRED_FIELD;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleLogin = async () => {
    console.log('➡️ LOGIN BUTTON PRESSED', {
      users_id: formData.email,
      hasPassword: !!formData.password,
    });
    // Clear any existing errors
    setErrors({});
    clearLoginError();

    const isValid = validateForm();
    if (!isValid) {
      console.log('⚠️ LOGIN VALIDATION FAILED', { errors });
      return;
    }

    console.log('📡 SENDING LOGIN API REQUEST');
    const identifier = formData.email.trim();
    const looksLikeEmail = identifier.includes('@');
    await login({
      users_id: identifier,
      password: formData.password,
      email: looksLikeEmail ? identifier : undefined,
    });
  };

  // Demo login function
  const handleDemoLogin = async () => {
    // Clear any existing errors
    setErrors({});
    clearLoginError();

    // Use demo credentials
    const demoUsersId = 'demo';

    // Update form data to show demo credentials
    setFormData({
      email: demoUsersId,
      password: '',
    });

    // Perform login with demo credentials
    await login({ users_id: demoUsersId, password: '' });
  };

  const handleSocialLogin = async (provider: 'google' | 'facebook' | 'apple' | 'twitter' | 'kakao' | 'naver') => {
    try {
      if (provider === 'naver') {
        // TODO: Implement Naver social login when backend support is available
        return;
      }
      await socialLoginMutation(provider as 'google' | 'facebook' | 'apple' | 'twitter' | 'kakao');
    } catch (error) {
      // Social login error
    }
  };

  const handleForgotPassword = () => {
    navigation.navigate('ForgotPassword' as never);
  };

  const handleSignup = () => {
    navigation.navigate('Signup' as never);
  };

  useFocusEffect(
    React.useCallback(() => {
      const onBackPress = () => {
        if (route.params?.fromProfile) {
          (navigation as any).navigate('Main', { screen: 'Home' });
        } else {
          navigation.goBack();
        }
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      
      return () => {
        sub.remove();
      };
    }, [navigation])
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} translucent={Platform.OS === 'android'} />
      {/* 전역 배경과 동일 팔레트로 전체 화면 연속 그라데이션 (절반 높이 시 경계 얼룩 제거) */}
      <LinearGradient
        colors={[...COLORS.gradients.authBackground]}
        style={styles.gradientBackground}
      />

      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!showEmailSuggestions}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <TouchableOpacity 
              style={styles.backButton}
              onPress={() => {
                if (route.params?.fromProfile) {
                  (navigation as any).navigate('Main', { screen: 'Home' });
                } else {
                  navigation.goBack();
                }
              }}
            >
              <ArrowBackIcon width={12} height={20} color={COLORS.text.primary} />
            </TouchableOpacity>

            <View style={styles.headerRight}>
              <TouchableOpacity
                style={styles.languageButton}
                onPress={() => navigation.navigate('LanguageSettings' as never)}
              >
                <Text style={styles.flagText}>{getLanguageFlag(locale)}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.form}>
            <View style={styles.toyContainer}>
              <Image
                source={require('../../assets/icons/logo.png')}
                style={styles.headerImage}
                resizeMode="contain"
              />
              <Image
                source={require('../../assets/icons/toy.png')}
                style={styles.toyImage}
                resizeMode="contain"
              />
            </View>
            <View style={styles.formInputs}>
              <View style={styles.securityMessageContainer}>
                <ShieldCheckIcon width={16} height={16} color={COLORS.gray[600]} />
                <Text style={styles.securityMessageText}>
                  {t('auth.infoProtected') || 'Your information is protected'}
                </Text>
              </View>

              <View style={[styles.inputContainer, styles.inputContainerEmail]}>
                <View style={[
                  styles.unifiedInputContainer,
                  !isInputFocused && styles.unifiedInputContainerUnfocused
                ]}>
                  <View style={[
                    styles.inputFieldContainer,
                    formData.email.length > 0 && styles.inputFieldContainerWithLabel
                  ]}>
                    {formData.email.length > 0 && (
                      <Text style={styles.floatingLabel}>
                        {t('auth.userIdOrEmail') || 'User ID or Email'}
                      </Text>
                    )}
                    <View style={styles.inputRow}>
                      <RNTextInput
                        underlineColorAndroid="transparent"
                        placeholder={formData.email.length > 0
                          ? ''
                          : (t('auth.enterUserIdOrEmail') || 'Enter user ID or email')
                        }
                        placeholderTextColor={COLORS.text.secondary}
                        value={formData.email}
                        onFocus={() => setIsInputFocused(true)}
                        onBlur={() => {
                          setIsInputFocused(false);
                          // Delay hiding suggestions to allow tap on suggestion item
                          setTimeout(() => {
                            setShowEmailSuggestions(false);
                          }, 200);
                        }}
                        onChangeText={(text) => {
                          setFormData({ ...formData, email: text });
                          
                          // Show email suggestions when @ is typed
                          const hasAtSymbol = text.includes('@');
                          if (hasAtSymbol) {
                            const atIndex = text.indexOf('@');
                            const afterAt = text.substring(atIndex + 1);
                            
                            if (afterAt.length === 0 || !afterAt.includes('.')) {
                              const filtered = commonEmailDomains.filter(domain =>
                                domain.toLowerCase().startsWith(afterAt.toLowerCase())
                              );
                              setEmailSuggestions(filtered);
                              setShowEmailSuggestions(filtered.length > 0);
                            } else {
                              setShowEmailSuggestions(false);
                            }
                          } else {
                            setShowEmailSuggestions(false);
                          }
                          
                          if (errors.email) {
                            setErrors({ ...errors, email: '' });
                          }
                          if (errors.password) {
                            setErrors({ ...errors, password: '' });
                          }
                          if (loginError) {
                            clearLoginError();
                          }
                          if (isError) {
                            setErrors({ ...errors, email: '' });
                          }
                        }}
                        keyboardType="default"
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.unifiedInput}
                      />
                    </View>
                  </View>

                  {formData.email.length > 0 && (
                    <TouchableOpacity
                      style={styles.clearButton}
                      onPress={() => {
                        setFormData({ ...formData, email: '', password: '' });
                        setShowEmailSuggestions(false);
                      }}
                    >
                      <Icon name="close" size={12} color={COLORS.white} />
                    </TouchableOpacity>
                  )}
                </View>
                
                {showEmailSuggestions && emailSuggestions.length > 0 && (
                  <View style={styles.emailSuggestionsWrapper}>
                    <View style={styles.emailSuggestionsContainer}>
                      {emailSuggestions.map((domain, index) => {
                        const atIndex = formData.email.indexOf('@');
                        const beforeAt = formData.email.substring(0, atIndex);
                        const fullEmail = `${beforeAt}@${domain}`;
                        const isLast = index === emailSuggestions.length - 1;
                        
                        return (
                          <TouchableOpacity
                            key={`suggestion-${fullEmail}`}
                            style={[
                              styles.emailSuggestionItem,
                              isLast && styles.emailSuggestionItemLast
                            ]}
                            onPress={() => {
                              setFormData({ ...formData, email: fullEmail });
                              setShowEmailSuggestions(false);
                              // Blur the input to close keyboard
                              setIsInputFocused(false);
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.emailSuggestionText}>{fullEmail}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
              </View>
              
              <View style={[styles.inputContainer, styles.inputContainerPassword]}>
                  <View style={[
                    styles.unifiedInputContainer,
                    !isInputFocused && styles.unifiedInputContainerUnfocused
                  ]}>
                    <View style={[
                      styles.inputFieldContainer,
                      formData.password.length > 0 && styles.inputFieldContainerWithLabel
                    ]}>
                      {formData.password.length > 0 && (
                        <Text style={styles.floatingLabel}>
                          {t('auth.enterPassword') || 'Password'}
                        </Text>
                      )}
                      <View style={styles.inputRow}>
                        <RNTextInput
                          underlineColorAndroid="transparent"
                          placeholder={formData.password.length > 0 
                            ? '' 
                            : (t('auth.enterPassword') || 'Password')
                          }
                          placeholderTextColor={COLORS.text.secondary}
                          value={formData.password}
                          onFocus={() => setIsInputFocused(true)}
                          onBlur={() => setIsInputFocused(false)}
                          onChangeText={(text) => {
                            setFormData({ ...formData, password: text });
                            if (errors.password) {
                              setErrors({ ...errors, password: '' });
                            }
                          }}
                          keyboardType="default"
                          autoCapitalize="none"
                          autoCorrect={false}
                          secureTextEntry={!showPassword}
                          style={styles.unifiedInput}
                        />
                        <TouchableOpacity
                          style={styles.eyeButton}
                          onPress={() => setShowPassword(!showPassword)}
                        >
                          <Icon 
                            name={showPassword ? "eye-outline" : "eye-off-outline"} 
                            size={20} 
                            color={COLORS.gray[600]} 
                          />
                        </TouchableOpacity>
                      </View>
                    </View>
                  </View>
                  
                  {errors.password && (
                    <View style={styles.errorMessageContainer}>
                      <Text style={styles.errorText}>{errors.password}</Text>
                    </View>
                  )}
              </View>
              
              <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
                visible={showCountryCodeModal}
                transparent={true}
                animationType="slide"
                onRequestClose={() => setShowCountryCodeModal(false)}
              >
                <TouchableOpacity
                  style={styles.modalOverlay}
                  activeOpacity={1}
                  onPress={() => setShowCountryCodeModal(false)}
                >
                  <View style={styles.modalContent}>
                    <View style={styles.modalHeader}>
                      <Text style={styles.modalTitle}>{t('auth.selectCountryCode') || 'Select Country Code'}</Text>
                      <TouchableOpacity
                        onPress={() => setShowCountryCodeModal(false)}
                        style={styles.modalCloseButton}
                      >
                        <Icon name="close" size={24} color={COLORS.text.primary} />
                      </TouchableOpacity>
                    </View>
                    <FlatList
                      data={countryCodes}
                      keyExtractor={(item) => item.code}
                      renderItem={({ item }) => (
                        <TouchableOpacity
                          style={[
                            styles.countryCodeItem,
                            countryCode === item.code && styles.countryCodeItemSelected
                          ]}
                          onPress={() => {
                            setCountryCode(item.code);
                            setShowCountryCodeModal(false);
                          }}
                        >
                          <Text style={styles.countryCodeItemFlag}>{item.flag}</Text>
                          <Text style={styles.countryCodeItemText}>{item.code}</Text>
                          <Text style={styles.countryCodeItemName}>{item.name}</Text>
                          {countryCode === item.code && (
                            <Icon name="checkmark" size={20} color={COLORS.primary} />
                          )}
                        </TouchableOpacity>
                      )}
                    />
                  </View>
                </TouchableOpacity>
              </Modal>

              <Button
                title={t('auth.loginButton') || 'Log in'}
                onPress={handleLogin}
                disabled={isLoading || !formData.email || !formData.password}
                loading={isLoading}
                variant="danger"
                style={
                  (isLoading || !formData.email || !formData.password)
                    ? { ...styles.loginButton, ...styles.loginButtonDisabled }
                    : styles.loginButton
                }
                textStyle={
                  (isLoading || !formData.email || !formData.password)
                    ? { ...styles.loginButtonText, ...styles.loginButtonTextDisabled }
                    : styles.loginButtonText
                }
              />
              <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'center'}}>                 
                <TouchableOpacity
                  onPress={handleForgotPassword}
                  style={styles.forgotPassword}
                >
                  <Text style={styles.forgotPasswordText}>
                    {t('auth.forgotPassword') || 'Forgot Password'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
            <Text style={styles.dividerText}>{t('auth.orContinueWith')}</Text>

            <View style={styles.socialButtons}>
              {/* 애플 로그인만 노출 — google/kakao/naver/facebook 제거(사용자 요청) */}
              <TouchableOpacity
                style={styles.socialButton}
                onPress={() => handleSocialLogin('apple')}
                disabled={isSocialLoading}
              >
                <Image
                  source={require('../../assets/icons/apple.png')}
                  style={styles.socialIcon}
                  resizeMode="contain"
                />
                <Text style={styles.socialButtonText}>apple</Text>
              </TouchableOpacity>
            </View>


            <View style={styles.loginContainer}>
              <Text style={styles.loginText}>{t('auth.dontHaveAccount')} </Text>
              <TouchableOpacity onPress={handleSignup}>
                <Text style={styles.loginLink}>{t('auth.signup')}</Text>
              </TouchableOpacity>
            </View>
            
            <View style={styles.footerContainer}>
              <Text style={styles.footerSupportText}>
                <Text style={styles.footerSupportGray}>
                  {t('auth.supportText') || '주식회사:투데이직구 /대표 유두성 주소: 경기도 의정부시 녹양로34번길 47, 101동 305호(가능동, e편한세상 녹양역) 사업자번호: 661-12-03163 전화: 07077926663 서비스 이메일: taoexpress_1@163.com '}
                </Text>
              </Text>
              <Text style={styles.footerCopyright}>
                {t('auth.copyright') || '© 2025 TodayMall. All Rights Reserved.'}
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  gradientBackground: {
    ...StyleSheet.absoluteFillObject,
  },
  keyboardView: {
    flex: 1,
    position: 'relative',
    backgroundColor: 'transparent',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: SPACING.smmd,
    paddingBottom: SPACING.xl,
    backgroundColor: 'transparent',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.xs,
    paddingTop: SPACING.lg,
  },
  backButton: {
    paddingHorizontal: SPACING.xs,
    paddingVertical: SPACING.xs,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  placeholder: {
    width: 32,
  },
  headerImage: {
    position: 'absolute',
    width: 270,
    height: 61,
    top: 62,
  },
  subHeader: {
    paddingHorizontal: SPACING.xs,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: FONTS.sizes['xl'],
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
  },
  subtitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: '700',
    color: COLORS.text.primary,
    marginBottom: SPACING.xs,
  },
  languageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
    paddingVertical: SPACING.xs,
  },
  flagText: {
    fontSize: 24,
  },
  toyContainer: {
    position: 'absolute',
    top: 28, // just below logo area
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: -1, // send behind form inputs
  },
  toyImage: {
    marginTop: SPACING.sm,
    width: 106,
    height: 125,
  },
  form: {
    flex: 1,
    position: 'relative',
    paddingHorizontal: SPACING.xs,
  },
  formInputs: {
    marginTop: 147,
    borderWidth: 2,
    borderColor: COLORS.black,
    borderRadius: BORDER_RADIUS.xl,
    paddingVertical: SPACING.md,
    paddingTop: 0,
    backgroundColor: COLORS.background,
    overflow: 'visible', // Changed to visible so dropdown can show over
    position: 'relative',
    zIndex: 1,
  },
  securityMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background,
    paddingVertical: SPACING.xs,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
  },
  securityMessageText: {
    marginLeft: SPACING.xs,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  singleInputWrapper: {
    backgroundColor: COLORS.gray[100],
    borderRadius: BORDER_RADIUS.lg,
    marginTop: SPACING.md,
  },
  unifiedInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 2,
    borderColor: COLORS.black,
    marginTop: SPACING.md,
    overflow: 'hidden',
    paddingRight: SPACING.sm,
  },
  unifiedInputContainerUnfocused: {
    borderColor: COLORS.gray[200],
    backgroundColor: COLORS.background,
    borderWidth: 1,
  },
  inputFieldContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: SPACING.md,
    paddingTop: SPACING.md,
    paddingBottom: SPACING.md,
    position: 'relative',
  },
  inputFieldContainerWithLabel: {
    paddingTop: SPACING.xs + 16, // Add space for label
    paddingBottom: SPACING.xs,
  },
  floatingLabel: {
    position: 'absolute',
    top: SPACING.xs,
    left: SPACING.md,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  unifiedInput: {
    flex: 1,
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    padding: 0,
    minHeight: 20,
  },
  clearButton: {
    width: 14.4,
    height: 14.4,
    borderRadius: 10,
    backgroundColor: COLORS.gray[500],
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: SPACING.xs,
    alignSelf: 'center',
  },
  separator: {
    width: 1,
    height: 32,
    backgroundColor: COLORS.gray[200],
  },
  countryCodeSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  countryCodeFlagContainer: {
    width: 20,
    height: 20,
    borderRadius: 10,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: SPACING.sm,
  },
  countryCodeFlag: {
    fontSize: 20,
    lineHeight: 20,
    textAlign: 'center',
  },
  countryCodeText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
    fontWeight: '500',
    marginRight: SPACING.sm,
  },
  consentContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: SPACING.xs,
    marginHorizontal: SPACING.md,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.black,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: SPACING.sm,
    marginTop: 2,
  },
  checkboxChecked: {
    backgroundColor: COLORS.black,
  },
  consentText: {
    flex: 1,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.xs * 20 / 12),
  },
  emailSuggestionsWrapper: {
    position: 'absolute',
    top: '100%',
    left: SPACING.md, // Match inputContainer padding
    right: SPACING.md, // Match inputContainer padding
    zIndex: 2000, // Higher than formInputs
    marginTop: SPACING.xs,
  },
  emailSuggestionsContainer: {
    backgroundColor: COLORS.surface,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
    // No fixed height - let it grow based on content — 그림자는 이 플로팅 박스에만 (입력 행 전체 elevation 방지)
    ...Platform.select({
      ios: {
        shadowColor: COLORS.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 2,
      },
      android: { elevation: 3 },
      default: {},
    }),
  },
  emailSuggestionItem: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  emailSuggestionItemLast: {
    borderBottomWidth: 0,
  },
  emailSuggestionText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.background,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    maxHeight: SCREEN_HEIGHT * 0.7,
    paddingBottom: SPACING.xl,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[200],
  },
  modalTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  modalCloseButton: {
    padding: SPACING.xs,
  },
  countryCodeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  countryCodeItemSelected: {
    backgroundColor: COLORS.gray[50],
  },
  countryCodeItemFlag: {
    fontSize: 24,
    marginRight: SPACING.md,
  },
  countryCodeItemText: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginRight: SPACING.md,
    minWidth: 60,
  },
  countryCodeItemName: {
    flex: 1,
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
  },
  inputContainer: {
    backgroundColor: COLORS.background,
    paddingHorizontal: SPACING.md,
    position: 'relative',
  },
  /** zIndex만 사용 — 부모에 elevation을 주면 그림자가 아래 행에 가로 띠로 깔림 */
  inputContainerEmail: {
    zIndex: 50,
  },
  inputContainerPassword: {
    zIndex: 0,
    elevation: 0,
  },
  label: {
    fontSize: FONTS.sizes.md,
    fontWeight: '600',
    color: COLORS.red,
    marginBottom: SPACING.sm,
  },
  eyeIcon: {
    padding: SPACING.xs,
  },
  eyeButton: {
    padding: SPACING.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.xs,
  },
  errorText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.error,
    marginLeft: SPACING.xs,
    marginTop: SPACING.xs,
  },
  alarmMark: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: COLORS.white,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.error,
  },
  alarmText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: 'bold',
    color: COLORS.error,
  },
  forgotPassword: {
    alignSelf: 'center',
  },
  forgotPasswordText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.black,
    fontWeight: '400',
    textAlign: 'center',
  },
  signinWithEmailCode: {
    alignSelf: 'center',
    marginTop: SPACING.xs,
  },
  signinWithEmailCodeText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.primary,
    fontWeight: '500',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  signinWithEmailCodeTextDisabled: {
    color: COLORS.gray[400],
    opacity: 0.6,
  },
  loginButton: {
    marginTop: SPACING.md,
    backgroundColor: COLORS.text.red,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.smmd,
    alignItems: 'center',
    marginBottom: SPACING.md,
    marginHorizontal: SPACING.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    // ...SHADOWS.sm,
  },
  loginButtonDisabled: {
    backgroundColor: COLORS.gray[300],
  },
  loginButtonText: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.white,
    letterSpacing: 0.5,
  },
  loginButtonTextDisabled: {
    color: COLORS.black,
  },
  demoButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 12,
    paddingVertical: SPACING.smmd,
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  demoButtonText: {
    fontSize: FONTS.sizes.base,
    fontWeight: '500',
    color: COLORS.white,
  },
  dividerText: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
    margin: SPACING.md,
    marginVertical: SPACING.mdlg,
    marginTop: SPACING.md,
    fontWeight: '400',
    textAlign: 'center',
  },
  socialButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  socialButton: {
    width: 60,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  socialIcon: {
    width: 50,
    height: 50,
  },
  socialButtonGoogle: {
    backgroundColor: COLORS.gray[100],
    borderColor: COLORS.border,
  },
  socialButtonText: {
    fontSize: 10,
    fontWeight: '400',
    color: COLORS.gray[500],
    marginLeft: SPACING.xs,
  },
  loginContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  loginText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  loginLink: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.red,
    fontWeight: '700',
  },
  arrowDownContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  footerContainer: {
    paddingHorizontal: SPACING.md,
    gap: SPACING.xs,
    marginTop: SPACING.lg,
    paddingBottom: SPACING.xl,
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xs,
  },
  footerProtectedText: {
    marginLeft: SPACING.xs,
    fontSize: FONTS.sizes.xs,
    color: COLORS.text.secondary,
    fontWeight: '500',
    textAlign: 'center',
  },
  footerSupportText: {
    fontSize: 11,
    lineHeight: FONTS.sizes.xs + 4,
    textAlign: 'center',
    paddingVertical: SPACING.sm,
  },
  footerSupportGray: {
    color: COLORS.gray[500],
  },
  footerSupportLink: {
    color: COLORS.text.red,
    fontWeight: '500',
  },
  footerCopyright: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.black,
    marginTop: SPACING.xs,
    textAlign: 'center',
  },
  signupContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  signupText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    fontWeight: '500',
  },
  signupLink: {
    fontSize: FONTS.sizes.md,
    color: COLORS.red,
    fontWeight: '700',
  },
});

export default LoginScreen;

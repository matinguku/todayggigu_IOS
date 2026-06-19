import { Platform, Linking } from 'react-native';
import React from 'react';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import appleAuth from '@invertase/react-native-apple-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SocialLoginOptions, SocialLoginResult } from '../types';
import { API_BASE_URL, STORAGE_KEYS } from '../constants';
import { storeAuthData } from './authApi';

// React Native CLI alternatives for Expo packages
// Note: OAuth flows for Facebook, Twitter, and Kakao require additional setup
// For now, these are stubbed out. Google Sign In works with @react-native-google-signin/google-signin

// Helper function to generate redirect URI (replaces expo-auth-session's makeRedirectUri)
const makeRedirectUri = (options: { native: string }): string => {
  return options.native;
};

// Helper function to generate random string (replaces expo-crypto)
const getRandomBytes = (length: number): Uint8Array => {
  const array = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(array);
  } else {
    // Fallback for environments without crypto
    for (let i = 0; i < length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }
  return array;
};

// Helper function to generate SHA256 hash (replaces expo-crypto)
// Note: This is a simplified implementation. For production, consider using a proper crypto library
const digestString = async (algorithm: string, data: string, options: { encoding: string }): Promise<string> => {
  try {
    // Try to use Web Crypto API if available (React Native Web or newer environments)
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder();
      const dataBuffer = encoder.encode(data);
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
      const base64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
      return base64;
    }
    
    // Fallback: Simple base64 encoding (not cryptographically secure, but works for basic use)
    // For production OAuth flows, install a proper crypto library like 'react-native-crypto' or 'crypto-js'
    return btoa(data).substring(0, 44); // Truncate to approximate base64 hash length
  } catch (error) {
    // Final fallback
    return btoa(data).substring(0, 44);
  }
};

// Google OAuth Configuration
// IMPORTANT: You need BOTH Web Client ID AND Android Client ID in Google Cloud Console
// Web Client ID - for getting ID tokens
const GOOGLE_WEB_CLIENT_ID = '504835766110-u1kq6htjoenjum17a9g7k27j7ui4q2u7.apps.googleusercontent.com';
const GOOGLE_REDIRECT_URI = "https://auth.expo.io/@roy_hensley/todaymall";

// Configure Google Sign-In
// IMPORTANT: Create an Android OAuth Client in Google Cloud Console with:
// - Package name: com.todayggigu.kr (must match build.gradle applicationId)
// - SHA-1: Get from running: cd android && gradlew.bat signingReport
// 
// You need BOTH:
// 1. Web OAuth Client (for backend) - webClientId below
// 2. Android OAuth Client (for mobile) - with SHA-1 fingerprint



GoogleSignin.configure({
  webClientId: GOOGLE_WEB_CLIENT_ID,
  offlineAccess: true,
  forceCodeForRefreshToken: true,
});



// Facebook OAuth Configuration
const FACEBOOK_APP_ID = 'YOUR_FACEBOOK_APP_ID';
const FACEBOOK_REDIRECT_URI = makeRedirectUri({
  native: 'com.glowmify.app://oauthredirect',
});

// Apple OAuth Configuration
const APPLE_REDIRECT_URI = makeRedirectUri({
  native: 'com.glowmify.app://oauthredirect',
});
// Twitter OAuth 2.0 Configuration
const TWITTER_CLIENT_ID = 'dURqNDZQVDRTQjJYbWt2cUwtOFU6MTpjaQ';
const TWITTER_CLIENT_SECRET = '7KcFO61dXldQA8Em1JQqWJK4VaJqL-DO46e25gObmnPGHbrfgZ';
const TWITTER_REDIRECT_URI = makeRedirectUri({
  native: 'com.todayggigu.kr://oauthredirect',
});
const KAKAO_CLIENT_ID = 'YOUR_KAKAO_REST_API_KEY';
const KAKAO_REDIRECT_URI = makeRedirectUri({
  native: 'com.glowmify.app://oauthredirect',
});

// Generate random string for PKCE
const generateRandomString = async (length: number = 32): Promise<string> => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  
  // Use React Native compatible random generation
  const randomBytes = getRandomBytes(length);
  
  for (let i = 0; i < length; i++) {
    result += charset[randomBytes[i] % charset.length];
  }
  
  return result;
};

// Generate SHA256 hash for PKCE
const generateCodeChallenge = async (codeVerifier: string): Promise<string> => {
  try {
    const hashed = await digestString('SHA-256', codeVerifier, { encoding: 'base64' });
    
    // Convert base64 to base64url encoding
    return hashed
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  } catch (error) {
    // Fallback: return a simple hash if crypto is not available
    console.warn('Crypto not available, using fallback for code challenge');
    return btoa(codeVerifier).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
};

// Google Sign In with native modal and backend integration
export const signInWithGoogle = async () => {
  
  try {
    // Check if Play Services are available (Android only)
    await GoogleSignin.hasPlayServices();
    // console.log("Google Signin Start");
    
    // Sign in with Google - this shows the native Google Sign-In modal
    const response = await GoogleSignin.signIn();
    
    // console.log('Google Sign-In Success:', response);

    // Check if sign-in was successful
    if (!response || !response.data) {
      // console.log('Google Sign-In: No response data');
      return {
        success: false,
        error: 'Sign-in failed - no response data',
      };
    }

    // Get ID token directly from response (more reliable)
    const idToken = response.data.idToken;
    
    if (!idToken) {
      // console.log('Google Sign-In: No ID token in response');
      return {
        success: false,
        error: 'Failed to get authentication token',
      };
    }
    
    // console.log("Google ID Token: ", idToken);

    // Send idToken to backend
    const backendResponse = await fetch(`${API_BASE_URL}/auth/google/mobile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({
        idToken: idToken,
      }),
    });

    // console.log('Backend Response Status:', backendResponse.status);
    
    // Get response text first
    const responseText = await backendResponse.text();
    // console.log('Backend Response Text:', responseText.substring(0, 200));
    
    // Try to parse as JSON
    let backendData;
    try {
      backendData = JSON.parse(responseText);
      // console.log('Backend Response:', backendData);
    } catch (parseError) {
      // console.error('Failed to parse backend response:', parseError);
      return {
        success: false,
        error: 'Invalid response from server',
      };
    }

    // Check if backend authentication was successful
    if (!backendResponse.ok || backendData.status !== 'success') {
      return {
        success: false,
        error: backendData.message || 'Backend authentication failed',
      };
    }

    // Extract user data from backend response (same format as login)
    const { user, token, refreshToken } = backendData.data;

    // 백엔드 user 객체의 필드명이 환경마다 다를 수 있어 방어적으로 매핑한다
    // (todaymall 검증 구현과 동일). 특히 id 는 `_id`(MongoDB) 폴백이 없으면
    // undefined 가 되어 로그인 직후 세션이 깨질 수 있다.
    const userData = {
      id: user.id || user._id,
      email: user.email || '',
      name:
        user.userName ||
        user.user_id ||
        user.name ||
        (user.email ? String(user.email).split('@')[0] : '') ||
        'User',
      phone: user.phone,
      avatar: user.avatar || user.pictureUrl,
    };

    // 토큰 영속 저장(이메일 로그인 apiLogin 과 동일) — 이후 인증 API 호출과
    // 앱 재시작 시 세션 유지를 위해 USER_TOKEN/REFRESH_TOKEN 을 저장한다.
    // 이게 없으면 로그인 직후엔 동작해도 재시작 시 로그아웃되고 인증 API 가 실패한다.
    if (token) {
      await storeAuthData(token, userData);
      if (refreshToken) {
        await AsyncStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
      }
    }

    return {
      success: true,
      data: {
        token,
        refreshToken,
        user: userData,
      },
    };
  } catch (error: any) {
    // console.error('Google Sign-In Error:', error);
    // console.error('Error code:', error.code);
    // console.error('Error message:', error.message);
    
    // Handle specific error codes
    if (error.code === 'SIGN_IN_CANCELLED' || error.code === '-5') {
      return {
        success: false,
        error: 'Sign-in cancelled',
      };
    } else if (error.code === 'IN_PROGRESS') {
      return {
        success: false,
        error: 'Sign-in already in progress',
      };
    } else if (error.code === 'PLAY_SERVICES_NOT_AVAILABLE') {
      return {
        success: false,
        error: 'Google Play Services not available',
      };
    } else if (error.code === 'SIGN_IN_REQUIRED' || error.message?.includes('getTokens requires')) {
      return {
        success: false,
        error: 'Sign-in was not completed',
      };
    } else if (error.code === 'DEVELOPER_ERROR') {
      return {
        success: false,
        error: 'Configuration error - Please check SHA-1 fingerprint in Firebase Console',
      };
    }
    
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
};

// Facebook Sign In
// Note: Facebook OAuth requires additional setup with react-native-oauth or similar library
// This is a placeholder implementation
export const signInWithFacebook = async () => {
  return {
    success: false,
    error: 'Facebook Sign-In is not yet implemented for React Native CLI. Please use Google Sign-In instead.',
  };
};

// Apple Sign In (iOS only)
// Uses @invertase/react-native-apple-authentication. The native flow returns an
// identityToken (a signed JWT) which is forwarded to the backend at
// POST /auth/apple/mobile for verification against Apple's public keys.
export const signInWithApple = async () => {
  if (Platform.OS !== 'ios') {
    return {
      success: false,
      error: 'Apple Sign-In is only available on iOS devices',
    };
  }

  if (!appleAuth.isSupported) {
    return {
      success: false,
      error: 'Apple Sign-In requires iOS 13 or later',
    };
  }

  try {
    // Trigger the native Apple authentication sheet.
    const credential = await appleAuth.performRequest({
      requestedOperation: appleAuth.Operation.LOGIN,
      requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
    });

    // Confirm the credential is authorized for this user.
    const credentialState = await appleAuth.getCredentialStateForUser(
      credential.user,
    );
    if (credentialState !== appleAuth.State.AUTHORIZED) {
      return { success: false, error: 'Apple authorization was not granted' };
    }

    const { identityToken, authorizationCode, fullName, email } = credential;
    if (!identityToken) {
      return { success: false, error: 'Failed to get Apple identity token' };
    }

    // Apple returns name/email only on the FIRST authorization, so forward
    // whatever is present this time (backend should persist it on first login).
    const displayName = fullName
      ? [fullName.givenName, fullName.familyName].filter(Boolean).join(' ').trim()
      : undefined;

    // Send the identityToken to the backend for verification + our own JWT.
    const backendResponse = await fetch(`${API_BASE_URL}/auth/apple/mobile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({
        identityToken,
        authorizationCode,
        email: email || undefined,
        name: displayName || undefined,
      }),
    });

    const responseText = await backendResponse.text();
    let backendData;
    try {
      backendData = JSON.parse(responseText);
    } catch (parseError) {
      return { success: false, error: 'Invalid response from server' };
    }

    if (!backendResponse.ok || backendData.status !== 'success') {
      return {
        success: false,
        error: backendData.message || 'Backend authentication failed',
      };
    }

    const { user, token, refreshToken } = backendData.data;

    // 백엔드 user 객체의 필드명이 환경마다 다를 수 있어 방어적으로 매핑한다
    // (todaymall 검증 구현과 동일). 특히 id 는 `_id`(MongoDB) 폴백이 없으면
    // undefined 가 되어 로그인 직후 세션이 깨질 수 있다.
    const userData = {
      id: user.id || user._id,
      email: user.email || '',
      name:
        user.userName ||
        user.user_id ||
        user.name ||
        (user.email ? String(user.email).split('@')[0] : '') ||
        'User',
      phone: user.phone,
      avatar: user.avatar || user.pictureUrl,
    };

    // 토큰 영속 저장(이메일 로그인 apiLogin 과 동일) — 이후 인증 API 호출과
    // 앱 재시작 시 세션 유지를 위해 USER_TOKEN/REFRESH_TOKEN 을 저장한다.
    // 이게 없으면 로그인 직후엔 동작해도 재시작 시 로그아웃되고 인증 API 가 실패한다.
    if (token) {
      await storeAuthData(token, userData);
      if (refreshToken) {
        await AsyncStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
      }
    }

    return {
      success: true,
      data: {
        token,
        refreshToken,
        user: userData,
      },
    };
  } catch (err: any) {
    if (err?.code === appleAuth.Error.CANCELED) {
      return { success: false, error: 'Sign-in cancelled' };
    }
    return {
      success: false,
      error: err?.message || 'Apple sign-in failed',
    };
  }
};

// Social login hook (similar to useMutation pattern)

export const useSocialLogin = (options?: SocialLoginOptions): SocialLoginResult => {
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState<boolean>(false);
  const [isSuccess, setIsSuccess] = React.useState<boolean>(false);
  const [isError, setIsError] = React.useState<boolean>(false);

  const mutate = async (provider: 'google' | 'facebook' | 'apple' | 'naver' | 'kakao') => {
    setIsLoading(true);
    setIsSuccess(false);
    setIsError(false);
    setError(null);

    try {
      let result;
      switch (provider) {
        case 'google':
          result = await signInWithGoogle();
          break;
        case 'facebook':
          result = await signInWithFacebook();
          break;
        case 'apple':
          result = await signInWithApple();
          break;
        case 'naver':
          result = await signInWithTwitter();
          break;
        case 'kakao':
          result = await signInWithKakao();
          break;
        default:
          throw new Error('Unsupported provider');
      }

      if (result.success) {
        setData(result.data);
        setIsSuccess(true);
        options?.onSuccess?.(result.data);
      } else {
        setError(result.error || 'Authentication failed');
        setIsError(true);
        options?.onError?.(result.error || 'Authentication failed');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
      setError(errorMessage);
      setIsError(true);
      options?.onError?.(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    mutate,
    data,
    error,
    isLoading,
    isSuccess,
    isError,
  };
};

// Twitter Sign In with OAuth 2.0 PKCE
// Note: Twitter OAuth requires additional setup with react-native-oauth or similar library
// This is a placeholder implementation
export const signInWithTwitter = async () => {
  return {
    success: false,
    error: 'Twitter Sign-In is not yet implemented for React Native CLI. Please use Google Sign-In instead.',
  };
};

export const signInWithKakao = async () => {
  return {
    success: false,
    error: 'Kakao Sign-In is not yet implemented for React Native CLI. Please use Google Sign-In instead.',
  };
};

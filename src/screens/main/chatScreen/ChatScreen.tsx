import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
  Platform,
  Modal,
  Dimensions,
  ActivityIndicator,
  Image,
  Keyboard,
  KeyboardAvoidingView,
} from 'react-native';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from '../../../components/Icon';
import { COLORS, FONTS, SHADOWS, SPACING } from '../../../constants';
import { RootStackParamList } from '../../../types';
import { launchCamera, launchImageLibrary, MediaType, ImagePickerResponse, CameraOptions, ImageLibraryOptions } from 'react-native-image-picker';
import { useAppSelector } from '../../../store/hooks';
import { requestCameraPermission, requestPhotoLibraryPermission } from '../../../utils/permissions';
import { useTranslation } from '../../../hooks/useTranslation';
import { useSocket } from '../../../context/SocketContext';
import { useToast } from '../../../context/ToastContext';
import { useAuth } from '../../../context/AuthContext';
import { SocketMessage, socketService } from '../../../services/socketService';
import { inquiryApi } from '../../../services/inquiryApi';
import { orderApi } from '../../../services/orderApi';
import { getOrderProgressStatusLabel } from '../../../utils/orderProgressStatusLabel';
import { markInquiryVisited } from '../../../utils/visitedInquiries';
import {
  fetchOrderFromProxy,
  mergeChatMessages,
  orderNoteLinesToChatMessages,
} from '../../../utils/messageInquiryMappers';
import { stripChatHtml } from '../../../utils/stripChatHtml';
import { parseChatBubbleContent } from '../../../utils/parseChatBubbleContent';

type ChatRouteProp = RouteProp<RootStackParamList, 'Chat'>;
type ChatScreenNavigationProp = StackNavigationProp<RootStackParamList, 'Chat'>;

interface Message {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
  sentAt?: number; // Date.now() when user sent — for 30s recall window
  senderName?: string;
  senderId?: string;
  readBy?: string[];
  attachments?: Array<{
    type: 'image' | 'file' | 'video';
    url: string;
    name?: string;
  }>;
}

type ChatScreenProps = {
  embedded?: boolean;
  embeddedParams?: {
    inquiryId?: string;
    orderId?: string;
    orderNumber?: string;
  };
  onEmbeddedBack?: () => void;
};

const ChatScreen: React.FC<ChatScreenProps> = ({
  embedded = false,
  embeddedParams,
  onEmbeddedBack,
}) => {
  const route = useRoute<ChatRouteProp>();
  const navigation = useNavigation<ChatScreenNavigationProp>();

  const handleBack = () => {
    if (embedded && onEmbeddedBack) {
      onEmbeddedBack();
      return;
    }
    navigation.goBack();
  };
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const {
    isConnected,
    isConnecting,
    connect,
    subscribeToInquiry,
    unsubscribeFromInquiry,
    markInquiryAsRead,
    createInquiry,
    getUnreadCounts,
    // Order note (주문문의) — admin → user 단방향 수신 + 읽음 확인.
    // user → admin 방향은 REST POST /orders-proxy 단독 경로이므로 `sendOrderNote`
    // 소켓 emit 은 제거됨 (backend 에 해당 핸들러 없음으로 추정).
    subscribeToOrderNotes,
    unsubscribeFromOrderNotes,
    confirmOrderNotes,
    onOrderNoteReceived,
    onOrderNoteConfirmed,
    onInquiryCreated,
    onMessageReceived,
    onMessagesRead,
    onInquiryClosed,
  } = useSocket();
  const { showToast } = useToast();
  const { user } = useAuth();
  const locale = useAppSelector((s) => s.i18n.locale) as string;

  const routeInquiryId = embedded ? embeddedParams?.inquiryId : route.params?.inquiryId;
  const routeOrderId = embedded ? embeddedParams?.orderId : route.params?.orderId;
  const routeOrderNumber = embedded ? embeddedParams?.orderNumber : route.params?.orderNumber;

  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [showMoreModal, setShowMoreModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [inquiryId, setInquiryId] = useState<string | null>(routeInquiryId || null);
  const [orderNumber, setOrderNumber] = useState<string | null>(routeOrderNumber || null);
  const [resolvedOrderId, setResolvedOrderId] = useState<string | null>(routeOrderId || null);
  const [orderData, setOrderData] = useState<any>(null);
  const [showOrderDetail, setShowOrderDetail] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ uri: string; type: string; name: string }>>([]);
  const scrollViewRef = useRef<ScrollView>(null);
  const hasFetchedInquiryRef = useRef(false);
  const messageCallbackSetRef = useRef(false);

  // Convert socket messages to local message format
  const convertSocketMessage = (socketMsg: SocketMessage): Message => {
    return {
      id: socketMsg._id || `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      text: socketMsg.message,
      isUser: socketMsg.senderType === 'user',
      timestamp: new Date(socketMsg.timestamp),
      senderName: socketMsg.senderName,
      senderId: socketMsg.senderId,
      readBy: socketMsg.readBy,
      attachments: socketMsg.attachments,
    };
  };

  const noteLinesToMessages = (order: Record<string, any> | null): Message[] =>
    orderNoteLinesToChatMessages(order?.orderNoteLines).map((note) => ({
      id: note.id,
      text: note.text,
      isUser: note.isUser,
      timestamp: note.timestamp,
      senderName: note.senderName,
    }));

  // Load order (orders-proxy) + inquiry history; orderNoteLines are the base thread
  useEffect(() => {
    if (hasFetchedInquiryRef.current) return;
    if (!routeInquiryId && !routeOrderId && !routeOrderNumber) return;

    hasFetchedInquiryRef.current = true;

    const fetchChatHistory = async () => {
      setIsLoading(true);
      try {
        let proxyOrder: Record<string, any> | null = null;
        let inquiryMessages: Message[] = [];
        let loadedInquiryId: string | null = routeInquiryId || null;

        proxyOrder = await fetchOrderFromProxy(
          {
            orderNumber: routeOrderNumber || orderNumber || undefined,
            orderId: routeOrderId || undefined,
          },
          locale,
        );

        if (proxyOrder) {
          setOrderData(proxyOrder);
          if (proxyOrder.orderNumber) setOrderNumber(proxyOrder.orderNumber);
          const proxyOrderId = String(proxyOrder._id ?? proxyOrder.id ?? '');
          if (proxyOrderId) setResolvedOrderId(proxyOrderId);
        }

        if (routeInquiryId) {
          const response = await inquiryApi.getInquiry(routeInquiryId);
          if (response.success && response.data?.inquiry) {
            const inquiry = response.data.inquiry;
            loadedInquiryId = inquiry._id;
            setInquiryId(inquiry._id);

            if (!proxyOrder) {
              const inquiryOrderId =
                typeof inquiry.order === 'string'
                  ? inquiry.order
                  : String(inquiry.order?._id ?? inquiry.orderId ?? '');
              const inquiryOrderNumber =
                typeof inquiry.order === 'object' && inquiry.order
                  ? inquiry.order.orderNumber
                  : undefined;

              if (typeof inquiry.order === 'object' && inquiry.order) {
                setOrderData(inquiry.order);
              }
              if (inquiryOrderNumber) setOrderNumber(inquiryOrderNumber);
              if (inquiryOrderId) setResolvedOrderId(inquiryOrderId);

              proxyOrder = await fetchOrderFromProxy(
                {
                  orderNumber: inquiryOrderNumber || routeOrderNumber || orderNumber || undefined,
                  orderId: inquiryOrderId || routeOrderId || undefined,
                },
                locale,
              );
              if (proxyOrder) {
                setOrderData(proxyOrder);
                if (proxyOrder.orderNumber) setOrderNumber(proxyOrder.orderNumber);
                const proxyOrderId = String(proxyOrder._id ?? proxyOrder.id ?? '');
                if (proxyOrderId) setResolvedOrderId(proxyOrderId);
              }
            }

            if (inquiry.messages?.length) {
              inquiryMessages = [...inquiry.messages]
                .sort(
                  (a, b) =>
                    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                )
                .map(convertSocketMessage);
            }

            if (isConnected) {
              subscribeToInquiry(inquiry._id);
              // mark-read 엔드포인트는 lang 쿼리 파라미터를 받아 admin 측
              // 시스템 메시지 로케일을 결정. 누락 시 default(en) 로 떨어짐.
              await inquiryApi.markAsRead(inquiry._id, locale);
            }
          } else {
            showToast(response.error || 'Failed to load chat history', 'error');
          }
        } else {
          const lookupOrderId =
            String(proxyOrder?._id ?? proxyOrder?.id ?? '') || routeOrderId || '';
          if (lookupOrderId) {
            const response = await inquiryApi.getInquiryDetailByOrderId(lookupOrderId);
            if (response.success && response.data) {
              if (!proxyOrder && response.data.order) {
                const detailOrderNumber = response.data.order.orderNumber;
                if (detailOrderNumber) setOrderNumber(detailOrderNumber);
                proxyOrder = await fetchOrderFromProxy(
                  {
                    orderNumber: detailOrderNumber || routeOrderNumber || orderNumber || undefined,
                    orderId: lookupOrderId,
                  },
                  locale,
                );
                if (proxyOrder) {
                  setOrderData(proxyOrder);
                } else {
                  setOrderData(response.data.order);
                }
              }
              if (response.data.inquiry) {
                loadedInquiryId = response.data.inquiry._id;
                setInquiryId(response.data.inquiry._id);
                if (response.data.inquiry.messages?.length) {
                  inquiryMessages = [...response.data.inquiry.messages]
                    .sort(
                      (a: SocketMessage, b: SocketMessage) =>
                        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                    )
                    .map(convertSocketMessage);
                }
              }
            }
          }
        }

        const noteMessages = noteLinesToMessages(proxyOrder);
        const merged = mergeChatMessages(noteMessages, inquiryMessages).map((msg) => ({
          id: msg.id,
          text: msg.text,
          isUser: msg.isUser,
          timestamp: msg.timestamp,
          senderName: msg.senderName,
        }));
        setMessages(merged);

        if (loadedInquiryId && isConnected) {
          subscribeToInquiry(loadedInquiryId);
        }

        setTimeout(() => {
          scrollViewRef.current?.scrollToEnd({ animated: false });
        }, 100);
      } catch {
        showToast('Failed to load chat history', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    fetchChatHistory();
  }, [
    routeInquiryId,
    routeOrderId,
    routeOrderNumber,
    locale,
    isConnected,
    subscribeToInquiry,
    showToast,
  ]);

  // Try socket connection once on mount
  const socketAttemptedRef = useRef(false);
  useEffect(() => {
    if (socketAttemptedRef.current) return;
    socketAttemptedRef.current = true;

    const ensureSocketConnected = async () => {
      console.log('[ChatScreen] Initial socket check - isConnected:', isConnected, 'socketService.isConnected:', socketService.isConnected());
      if (!isConnected && !isConnecting) {
        try {
          console.log('[ChatScreen] Attempting socket connection...');
          await connect();
          console.log('[ChatScreen] Socket connect() resolved, actuallyConnected:', socketService.isConnected());
        } catch (error) {
          console.warn('[ChatScreen] Socket connection failed, will use REST API:', (error as Error).message);
        }
      }
    };

    ensureSocketConnected();
  }, []);

  // Subscribe to inquiry when socket becomes connected
  useEffect(() => {
    if (isConnected && inquiryId) {
      console.log('[ChatScreen] Socket connected, subscribing to inquiry:', inquiryId);
      subscribeToInquiry(inquiryId);
      markInquiryAsRead(inquiryId);
    }
  }, [isConnected, inquiryId, subscribeToInquiry, markInquiryAsRead]);

  // Set up socket listeners for new messages
  useEffect(() => {
    if (!messageCallbackSetRef.current) {
      messageCallbackSetRef.current = true;

      // Listen for inquiry creation success
      const handleInquiryCreated = (inquiry: any) => {
        if (!inquiryId && inquiry._id) {
          setInquiryId(inquiry._id);
          setOrderNumber(inquiry.order?.orderNumber || null);
          subscribeToInquiry(inquiry._id);
          markInquiryAsRead(inquiry._id);
          showToast(t('inquiry.inquiryCreated'), 'success');
        }
      };

      // Listen for new messages
      const handleMessageReceived = (data: {
        message: SocketMessage;
        inquiryId: string;
        unreadCount?: number;
        totalUnreadCount?: number;
      }) => {
        if (data.inquiryId === inquiryId) {
          const newMessage = convertSocketMessage(data.message);
          setMessages(prev => {
            // 1) 같은 id 가 이미 있으면 추가 안 함.
            if (prev.some(msg => msg.id === newMessage.id)) return prev;
            // 2) optimistic temp 메시지(`temp-…` id) 와 같은 본문 + 같은 발신자
            //    + 5초 이내 timestamp 면 temp 를 서버 메시지로 교체.
            //    REST 저장 후 socket echo 가 돌아오면서 temp 와 별도 id 로
            //    중복 표시되던 문제(스크린샷 증상)를 차단.
            const tsMs = new Date(newMessage.timestamp).getTime();
            const tempIdx = prev.findIndex(
              (m) =>
                String(m.id).startsWith('temp-') &&
                m.isUser === newMessage.isUser &&
                m.text === newMessage.text &&
                Math.abs(new Date(m.timestamp).getTime() - tsMs) < 5000,
            );
            if (tempIdx >= 0) {
              const next = prev.slice();
              next[tempIdx] = newMessage;
              return next;
            }
            // 3) temp 가 없어도 서버 echo 가 두 번 도착하는 케이스 — 같은 본문 +
            //    같은 발신자 + 5초 이내면 중복으로 간주.
            if (
              prev.some(
                (m) =>
                  m.isUser === newMessage.isUser &&
                  m.text === newMessage.text &&
                  Math.abs(new Date(m.timestamp).getTime() - tsMs) < 5000,
              )
            ) {
              return prev;
            }
            return [...prev, newMessage];
          });
          setTimeout(() => {
            scrollViewRef.current?.scrollToEnd({ animated: true });
          }, 100);
        }
      };

      // Listen for messages read
      const handleMessagesRead = (data: { 
        inquiryId: string; 
        readBy: string; 
        readByType: string; 
        readByName: string; 
        readAt: string;
      }) => {
        // 읽음 통보 토스트 제거(사용자 요청). 관리자가 읽었는지는 더 이상
        // 팝업으로 알리지 않고, MessageScreen 카드의 체크 표시
        // (✓ 전송 / ✓✓ 읽음)로만 노출한다. 그 읽음 상태는 SocketContext 가
        // messages-read 이벤트를 받아 영속 기록한다.
        void data;
      };

      // Listen for inquiry closure
      const handleInquiryClosed = (closedInquiryId: string) => {
        if (closedInquiryId === inquiryId) {
          showToast('Inquiry has been closed', 'info');
        }
      };

      onInquiryCreated(handleInquiryCreated);
      onMessageReceived(handleMessageReceived);
      onMessagesRead(handleMessagesRead);
      onInquiryClosed(handleInquiryClosed);
    }

    // Cleanup
    return () => {
      if (inquiryId) {
        unsubscribeFromInquiry(inquiryId);
      }
      // Refresh unread counts so badges update when navigating back
      getUnreadCounts();
    };
  }, [
    inquiryId,
    isConnected,
    isConnecting,
    subscribeToInquiry,
    unsubscribeFromInquiry,
    markInquiryAsRead,
    getUnreadCounts,
    onInquiryCreated,
    onMessageReceived,
    onMessagesRead,
    onInquiryClosed,
    showToast,
  ]);

  // ─── Order-note 채널 구독 + admin → user push 수신 ─────────────────
  //
  // 주문문의 페지는 orderId 단위로도 메시지 채널을 운영한다 (admin 측 web
  // 콘솔의 OrderNote 위젯에서 보내는 메시지). 화면 진입 시 orderId 로 구독,
  // 화면 이탈 시 해제. admin 이 보낸 새 note 가 socket 으로 push 되면
  // 채팅 메시지 목록에 즉시 prepend 한다.
  useEffect(() => {
    const orderId = resolvedOrderId || routeOrderId || orderData?._id || orderData?.id;
    if (!orderId) return;
    if (!isConnected) return;

    subscribeToOrderNotes(String(orderId));
    // 화면 진입 = admin 이 보낸 note 들을 user 가 본 것으로 간주 → 확인 broadcast.
    // 이로 인해 admin web 의 OrderNote 위젯의 '미확인' 카운트가 0 으로 떨어진다.
    confirmOrderNotes(String(orderId), { orderNumber: orderNumber || undefined });

    onOrderNoteReceived((data) => {
      // 같은 주문이 아니면 무시 — 다른 ChatScreen 인스턴스가 활성화돼 있을 수 있다.
      if (String(data?.orderId) !== String(orderId)) return;

      // 발신자 판별 — 'admin' 인 경우만 admin 메시지로 추가하고, 그 외에는
      // 무시한다. 사용자가 직접 보낸 메시지는 이미 optimistic UI + inquiry
      // 채널 echo 로 화면에 추가되므로, order-note 채널의 echo 까지 받으면
      // 같은 메시지가 2~3번 중복으로 표시되는 문제(스크린샷의 증상)가 발생.
      const senderType = String(data?.senderType ?? '').toLowerCase();
      const senderName = String(data?.name ?? '').toLowerCase();
      const isAdminMessage = senderType === 'admin' || senderName === 'admin';
      if (!isAdminMessage) {
        console.log(
          '[ChatScreen] OrderNote received from non-admin (skip echo):',
          { name: data?.name, senderType: data?.senderType },
        );
        return;
      }

      console.log('[ChatScreen] OrderNote received from admin:', {
        orderId: data.orderId,
        value: data?.value?.toString().substring(0, 40),
        name: data?.name,
      });
      const valueStr = String(data.value || '');
      const ts = data.date ? new Date(data.date) : new Date();
      const newMessage: Message = {
        id: data.noteId || `note-${ts.getTime()}-${Math.random().toString(36).substring(2, 8)}`,
        text: valueStr,
        isUser: false,
        timestamp: ts,
        sentAt: Date.now(),
        senderName: data.name,
        readBy: [],
        attachments: [],
      };
      setMessages((prev) => {
        // 1) 같은 noteId 가 이미 있으면 추가 안 함.
        if (newMessage.id && prev.some((m) => m.id === newMessage.id)) return prev;
        // 2) noteId 가 없거나 다른데 같은 본문 + 5초 이내 timestamp 인 메시지가
        //    이미 있으면 추가 안 함 — 서버가 노트 id 를 다르게 발급한 echo
        //    중복 케이스를 차단.
        const tsMs = ts.getTime();
        if (
          prev.some(
            (m) =>
              !m.isUser &&
              m.text === valueStr &&
              Math.abs(new Date(m.timestamp).getTime() - tsMs) < 5000,
          )
        ) {
          return prev;
        }
        return [...prev, newMessage];
      });
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    });

    onOrderNoteConfirmed((data) => {
      if (String(data?.orderId) !== String(orderId)) return;
      console.log('[ChatScreen] OrderNote confirmed broadcast:', {
        orderId: data.orderId,
        confirmedBy: data.confirmedBy,
        confirmedCount: data.confirmedCount,
      });
      // 단순 로깅 — 필요한 경우 여기서 read receipt UI 갱신을 트리거할 수 있음.
    });

    return () => {
      unsubscribeFromOrderNotes(String(orderId));
    };
  }, [
    resolvedOrderId,
    routeOrderId,
    orderData?._id,
    orderData?.id,
    orderNumber,
    isConnected,
    subscribeToOrderNotes,
    unsubscribeFromOrderNotes,
    confirmOrderNotes,
    onOrderNoteReceived,
    onOrderNoteConfirmed,
  ]);

  // REST API for sending messages — persists to DB. After success, ALSO
  // emit the socket event so admin / web clients subscribed to this inquiry
  // receive the new message in real time. Without the socket emit, the
  // message is saved in DB but admin doesn't see it until they refresh —
  // which is exactly the symptom the user reported.
  const sendMessageViaRest = async (_targetInquiryId: string, messageText: string, optimisticMessageId: string, attachments: Array<{ uri: string; type: string; name: string }> = []) => {
    // ─── 송신 경로: PATCH /api/orders-proxy 단독 ─────────────────────
    //
    // 사용자가 명시한 정확한 API 명세:
    //   URL: https://todayggigu.kr/api/orders-proxy
    //   Method: PATCH
    //   Body: { orderId, orderNoteLines: { message, username } }
    //   응답: "Manual order updated successfully" — 노트 append 됨.
    //
    // 결정적 발견: HTTP method 가 POST 가 아니라 **PATCH** 였다.
    //   - POST → createCrossOrder 라우팅 (새 주문 생성)
    //   - PATCH → manual order update 라우팅 (기존 주문 orderNoteLines append)
    //
    // 사용자 지시: "메세지 전송에 관하여 api 이제 입력하는거로 하고 나머지는
    // 리용하지 말라" → inquiries/messages 호출은 모두 제거.
    const orderContextId = resolvedOrderId || routeOrderId || orderData?._id || orderData?.id;

    if (!orderContextId) {
      // orderId 가 없으면 주문문의 모드가 아님 → 메시지 전송 불가.
      setMessages(prev => prev.filter(msg => msg.id !== optimisticMessageId));
      showToast(t('inquiry.failedToSend'), 'error');
      return;
    }

    const username =
      (user as any)?.user_id ||
      (user as any)?.userInfo?.userName ||
      (user as any)?.name ||
      user?.email ||
      'user';

    // ─── 1) 이미지 첨부 처리 ───────────────────────────────────────
    //
    // 백엔드는 orderNoteLines.value 안의 `<img src="...">` 마크업으로 이미지를
    // 표시한다. 따라서 다음 흐름으로 처리:
    //   a) POST /v1/orders/upload-images?lang=ko  (FormData: kind, images)
    //   b) 응답의 urls[] 를 받아 `<img src="URL">` 태그로 변환
    //   c) 텍스트 메시지 뒤에 이어붙여 한 노트로 PATCH /api/orders-proxy 전송
    //
    // 사용자가 이미지만 보내는 경우엔 텍스트가 공백이므로 마크업만 들어간다.
    let composedMessage = messageText;
    if (attachments.length > 0) {
      try {
        const filesToUpload = attachments.map((a, idx) => ({
          uri: a.uri,
          fileName: a.name || `image_${Date.now()}_${idx}.jpg`,
          type: a.type || 'image/jpeg',
        }));
        const uploadRes = await orderApi.uploadOrderImages(
          'negotiationContentImages',
          filesToUpload,
          locale,
        );
        if (uploadRes.success && Array.isArray(uploadRes.data?.urls) && uploadRes.data!.urls.length > 0) {
          const imgTags = uploadRes.data!.urls
            .map((u) => `<img src="${String(u).replace(/"/g, '&quot;')}">`)
            .join('');
          const base = messageText.trim();
          // 텍스트 + 이미지 마크업 결합. 공백만 있는 placeholder 는 제거.
          composedMessage = base ? `${base}${imgTags}` : imgTags;
        } else {
          console.warn('[ChatScreen] uploadOrderImages failed:', uploadRes.error);
          setMessages((prev) => prev.filter((msg) => msg.id !== optimisticMessageId));
          showToast(uploadRes.error || t('inquiry.failedToSend'), 'error');
          return;
        }
      } catch (uploadErr) {
        console.error('[ChatScreen] uploadOrderImages threw:', uploadErr);
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticMessageId));
        showToast(t('inquiry.failedToSendRetry'), 'error');
        return;
      }
    }

    try {
      const proxyRes = await orderApi.appendOrderNoteLine(
        String(orderContextId),
        composedMessage,
        String(username),
      );
      console.log('[ChatScreen] orders-proxy appendOrderNoteLine:',
        proxyRes.success ? 'ok' : `error: ${proxyRes.error}`);

      if (!proxyRes.success) {
        setMessages(prev => prev.filter(msg => msg.id !== optimisticMessageId));
        showToast(proxyRes.error || t('inquiry.failedToSend'), 'error');
        return;
      }

      // ─── 소켓 broadcast 단계 ───────────────────────────────────────
      //
      // PATCH /api/orders-proxy 가 성공하면 backend 가 자체적으로
      // `user:order-note:received` socket broadcast 를 admin / 다른 user 세션
      // 에게 발사한다. 따라서 client 측 추가 emit 은 불필요.
    } catch (error) {
      console.error('[ChatScreen] REST sendMessage error:', error);
      setMessages(prev => prev.filter(msg => msg.id !== optimisticMessageId));
      showToast(t('inquiry.failedToSendRetry'), 'error');
    }
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() && pendingAttachments.length === 0) return;

    const messageText = inputText.trim() || (pendingAttachments.length > 0 ? ' ' : '');
    const attachmentsToSend = [...pendingAttachments];

    const createOrderId = resolvedOrderId || routeOrderId || orderData?._id || orderData?.id;
    console.log('[ChatScreen] handleSendMessage called, inquiryId:', inquiryId, 'orderId:', createOrderId, 'attachments:', attachmentsToSend.length);

    // Send message to existing inquiry
    if (inquiryId) {
      setInputText('');
      setPendingAttachments([]);

      // Create optimistic message
      const optimisticMessage: Message = {
        id: `temp-${Date.now()}`,
        text: messageText,
        isUser: true,
        timestamp: new Date(),
        sentAt: Date.now(),
        senderName: (user as any)?.user_id || user?.email || 'You',
        senderId: (user as any)?._id || (user as any)?.id,
        readBy: [],
        attachments: attachmentsToSend.map((a) => ({ type: 'image' as const, url: a.uri, name: a.name })),
      };

      setMessages(prev => [...prev, optimisticMessage]);

      // Always use REST API for reliability
      await sendMessageViaRest(inquiryId, messageText, optimisticMessage.id, attachmentsToSend);

      // 사용자 본인 전송은 "미확인" 상태에 영향을 주지 않는다 — 방문 시각을 갱신해
      // 다음 목록 재조회에서도 확인완료로 유지되게 한다 (lastMessageAt 이 본인 메시지로
      // 갱신돼도 visitedAt >= lastMessageAt).
      void markInquiryVisited(inquiryId);

      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } else if (createOrderId) {
      // No inquiry yet — create one via REST API
      setInputText('');
      setPendingAttachments([]);
      console.log('[ChatScreen] Creating new inquiry via REST API, orderId:', createOrderId);

      const sentMessage: Message = {
        id: `temp-${Date.now()}`,
        text: messageText,
        isUser: true,
        timestamp: new Date(),
        sentAt: Date.now(),
        senderName: (user as any)?.user_id || user?.email || 'You',
        senderId: (user as any)?._id || (user as any)?.id,
        readBy: [],
        attachments: attachmentsToSend.map((a) => ({ type: 'image' as const, url: a.uri, name: a.name })),
      };
      setMessages(prev => [...prev, sentMessage]);

      try {
        const response = await inquiryApi.createInquiry(String(createOrderId), messageText, attachmentsToSend);
        console.log('[ChatScreen] Create inquiry REST response:', JSON.stringify(response).substring(0, 300));
        if (response.success && response.data?.inquiry) {
          const newInquiry = response.data.inquiry;
          setInquiryId(newInquiry._id);
          setOrderNumber(newInquiry.order?.orderNumber || orderNumber);
          if (newInquiry.order) {
            setOrderData(newInquiry.order);
          }

          if (newInquiry.messages && newInquiry.messages.length > 0) {
            const serverMessages = [...newInquiry.messages]
              .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
              .map(convertSocketMessage);
            setMessages(serverMessages);
          }

          if (!isConnected) {
            try { await connect(); } catch (_) {}
          }
          if (isConnected || socketService.isConnected()) {
            subscribeToInquiry(newInquiry._id);
            markInquiryAsRead(newInquiry._id);
          }
          showToast(t('inquiry.inquiryCreated'), 'success');
        } else {
          setMessages(prev => prev.filter(msg => msg.id !== sentMessage.id));
          showToast(response.error || t('inquiry.failedToCreate'), 'error');
        }
      } catch (error) {
        setMessages(prev => prev.filter(msg => msg.id !== sentMessage.id));
        showToast(t('inquiry.failedToCreateRetry'), 'error');
      }
    } else {
      showToast(t('inquiry.failedToCreateRetry'), 'error');
    }
  };

  const handleMoreOptions = () => {
    setShowMoreModal(true);
  };

  const handleCloseMoreModal = () => {
    setShowMoreModal(false);
  };

  const handleMoreOptionPress = async (option: string) => {
    // console.log(`${option} option pressed`);
    setShowMoreModal(false);
    
    if (option === 'Gallery') {
      await openGallery();
    } else if (option === 'Camera') {
      await openCamera();
    }
  };

  // Pick files from gallery (mixed media — images, videos, documents)
  const openFilePicker = async () => {
    try {
      const granted = await requestPhotoLibraryPermission();
      if (!granted) {
        Alert.alert(t('permissions.required'), t('permissions.galleryPermission'));
        return;
      }
      const options: ImageLibraryOptions = {
        mediaType: 'mixed' as MediaType,
        selectionLimit: 5,
      };
      launchImageLibrary(options, (response: ImagePickerResponse) => {
        if (response.didCancel || response.errorCode) {
          if (response.errorCode) Alert.alert(t('permissions.error'), response.errorMessage || t('permissions.failedPickImage'));
          return;
        }
        if (response.assets) {
          const newAttachments = response.assets
            .filter((asset) => asset.uri)
            .map((asset) => ({
              uri: asset.uri!,
              type: asset.type || 'application/octet-stream',
              name: asset.fileName || `file_${Date.now()}`,
            }));
          setPendingAttachments((prev) => [...prev, ...newAttachments]);
        }
      });
    } catch (error) {
      Alert.alert(t('permissions.error'), t('permissions.failedOpenGallery'));
    }
  };

  // Pick images from gallery
  const openGallery = async () => {
    try {
      const granted = await requestPhotoLibraryPermission();
      if (!granted) {
        Alert.alert(t('permissions.required'), t('permissions.galleryPermission'));
        return;
      }

      const options: ImageLibraryOptions = {
        mediaType: 'photo' as MediaType,
        quality: 0.7,
        selectionLimit: 5,
      };

      launchImageLibrary(options, (response: ImagePickerResponse) => {
        if (response.didCancel || response.errorCode) {
          if (response.errorCode) Alert.alert(t('permissions.error'), response.errorMessage || t('permissions.failedPickImage'));
          return;
        }
        if (response.assets) {
          const newAttachments = response.assets
            .filter((asset) => asset.uri)
            .map((asset) => ({
              uri: asset.uri!,
              type: asset.type || 'image/jpeg',
              name: asset.fileName || `image_${Date.now()}.jpg`,
            }));
          setPendingAttachments((prev) => [...prev, ...newAttachments]);
        }
      });
    } catch (error) {
      Alert.alert(t('permissions.error'), t('permissions.failedOpenGallery'));
    }
  };

  const openCamera = async () => {
    try {
      const granted = await requestCameraPermission();
      if (!granted) {
        Alert.alert(t('permissions.required'), t('permissions.cameraPermission'));
        return;
      }

      const options: CameraOptions = {
        mediaType: 'photo' as MediaType,
        quality: 0.7,
        saveToPhotos: false,
      };

      launchCamera(options, (response: ImagePickerResponse) => {
        if (response.didCancel || response.errorCode) {
          if (response.errorCode) Alert.alert(t('permissions.error'), response.errorMessage || t('permissions.failedTakePhoto'));
          return;
        }
        if (response.assets && response.assets[0]) {
          const asset = response.assets[0];
          if (asset.uri) {
            setPendingAttachments((prev) => [...prev, {
              uri: asset.uri!,
              type: asset.type || 'image/jpeg',
              name: asset.fileName || `photo_${Date.now()}.jpg`,
            }]);
          }
        }
      });
    } catch (error) {
      Alert.alert(t('permissions.error'), t('permissions.failedOpenCamera'));
    }
  };

  // Format date for grouping (YYYY-MM-DD)
  const formatDateForGrouping = (date: Date): string => {
    return date.toISOString().split('T')[0];
  };

  // Format date for display (e.g., "Today", "Yesterday", "Dec 15, 2024")
  const formatDateForDisplay = (date: Date): string => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    const dateStr = date.toISOString().split('T')[0];
    const todayStr = today.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    if (dateStr === todayStr) {
      return 'Today';
    } else if (dateStr === yesterdayStr) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  // Format time for display (e.g., "10:30 AM")
  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  };

  // Check if message is read (for user messages, check if admin has read it)
  const isMessageRead = (message: Message): boolean => {
    if (!message.isUser || !message.readBy || !user) {
      return false;
    }
    // For user messages, check if any admin has read it (readBy contains admin IDs, not user ID)
    // If readBy array has items and user's ID is not in it, it means admin has read it
    const userId = (user as any)?._id || (user as any)?.id;
    return message.readBy.length > 0 && userId && !message.readBy.includes(userId);
  };

  // Group messages by date
  const groupMessagesByDate = (messages: Message[]): Array<{ date: string; messages: Message[] }> => {
    const groups: { [key: string]: Message[] } = {};
    
    messages.forEach((message) => {
      const dateKey = formatDateForGrouping(message.timestamp);
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(message);
    });
    
    // Convert to array and sort by date (oldest first)
    return Object.keys(groups)
      .sort()
      .map((dateKey) => ({
        date: dateKey,
        messages: groups[dateKey],
      }));
  };

  const renderDateHeader = (date: string) => {
    const dateObj = new Date(date);
    return (
      <View key={`date-${date}`} style={styles.dateHeaderContainer}>
        <View style={styles.dateHeaderLine} />
        <Text style={styles.dateHeaderText}>{formatDateForDisplay(dateObj)}</Text>
        <View style={styles.dateHeaderLine} />
      </View>
    );
  };

  const formatMessageTimestamp = (date: Date): string => {
    const y = String(date.getFullYear()).slice(2);
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}/${m}/${d} ${h}:${min}`;
  };

  const renderMessage = (message: Message, showName: boolean = false) => {
    const isUser = message.isUser;
    return (
      <View key={message.id} style={isUser ? styles.userMessageContainer : styles.adminMessageContainer}>
        <Text style={styles.messageMeta}>
          {formatMessageTimestamp(message.timestamp)} {isUser ? (t('chat.customer') || '고객') : (message.senderName || t('chat.admin') || '관리자')}
        </Text>
        <View style={styles.messageRow}>
          {!isUser && (
            <View style={styles.adminAvatar}>
              <Icon name="person" size={16} color={COLORS.white} />
            </View>
          )}
          <View style={isUser ? styles.userBubble : styles.adminBubble}>
            {message.attachments && message.attachments.length > 0 && (
              <View style={{ marginBottom: message.text?.trim() ? 6 : 0 }}>
                {message.attachments.map((att, idx) => (
                  <View key={`att-${idx}`} style={{ marginBottom: 4 }}>
                    {att.type === 'image' ? (
                      <Image source={{ uri: att.url }} style={{ width: 180, height: 180, borderRadius: 8 }} resizeMode="cover" />
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 6, backgroundColor: COLORS.gray[100], borderRadius: 6 }}>
                        <Icon name="document-outline" size={18} color={COLORS.gray[600]} />
                        <Text style={{ marginLeft: 6, fontSize: 12, color: COLORS.text.primary }} numberOfLines={1}>{att.name || 'File'}</Text>
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}
            {(() => {
              // 노트 value 안의 `<img src="...">` 와 일반 텍스트를 분해해 인라인
              // 으로 렌더. admin/web 리치 에디터의 div/br 같은 블록 태그는
              // 자동으로 제거되고 줄바꿈으로 변환된다.
              const segments = parseChatBubbleContent(message.text);
              if (segments.length === 0) {
                // fallback: 마크업이 없으면 기존 stripChatHtml 흐름.
                const cleaned = stripChatHtml(message.text);
                return cleaned ? (
                  <Text style={isUser ? styles.userMessageText : styles.adminMessageText}>
                    {cleaned}
                  </Text>
                ) : null;
              }
              return (
                <View>
                  {segments.map((seg, segIdx) => {
                    if (seg.type === 'text') {
                      return (
                        <Text
                          key={`seg-text-${segIdx}`}
                          style={isUser ? styles.userMessageText : styles.adminMessageText}
                        >
                          {seg.value}
                        </Text>
                      );
                    }
                    // 이미지 세그먼트 — 첨부 이미지와 동일한 스타일 적용.
                    return (
                      <Image
                        key={`seg-img-${segIdx}`}
                        source={{ uri: seg.url }}
                        style={{ width: 180, height: 180, borderRadius: 8, marginTop: segIdx > 0 ? 6 : 0 }}
                        resizeMode="cover"
                      />
                    );
                  })}
                </View>
              );
            })()}
          </View>
          {isUser && (
            (user as any)?.avatar ? (
              <Image source={typeof (user as any).avatar === 'string' ? { uri: (user as any).avatar } : (user as any).avatar} style={styles.userAvatarImage} />
            ) : (
              <View style={styles.userAvatar}>
                <Icon name="person" size={16} color={COLORS.white} />
              </View>
            )
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.headerSafeArea} edges={['top', 'left', 'right']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            activeOpacity={0.85}
          >
            <Icon name="arrow-back" size={16} color={COLORS.black} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>
              {t('chat.orderInquiry') || '주문문의'}{messages.length > 0 ? ` (${messages.length})` : ''}
            </Text>
          </View>
        </View>
      </SafeAreaView>

      {/* Order Info Bar */}
      {orderNumber ? (
        <View style={styles.orderInfoSection}>
          <TouchableOpacity
            style={styles.orderInfoBar}
            activeOpacity={0.7}
            onPress={() => setShowOrderDetail(!showOrderDetail)}
          >
            {(orderData?.items?.[0]?.imageUrl || orderData?.items?.[0]?.image) ? (
              <Image source={{ uri: orderData.items[0].imageUrl || orderData.items[0].image }} style={styles.orderInfoImage} />
            ) : (
              <View style={styles.orderInfoIcon}>
                <Icon name="receipt-outline" size={20} color={COLORS.primary} />
              </View>
            )}
            <View style={styles.orderInfoContent}>
              <Text style={styles.orderInfoNumber} numberOfLines={1}>{orderNumber}</Text>
              {orderData?.progressStatus ? (
                <Text style={styles.orderInfoStatus}>
                  {getOrderProgressStatusLabel(t, orderData.progressStatus)}
                </Text>
              ) : null}
            </View>
            <Icon name={showOrderDetail ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.gray[400]} />
          </TouchableOpacity>

          {/* Order Detail Dropdown */}
          {showOrderDetail && orderData ? (
            <View style={styles.orderDetailDropdown}>
              {orderData.items?.map((item: any, idx: number) => (
                <View key={`item-${idx}`} style={styles.orderDetailItem}>
                  {(item.imageUrl || item.image) ? (
                    <Image source={{ uri: item.imageUrl || item.image }} style={styles.orderDetailItemImage} />
                  ) : null}
                  <View style={styles.orderDetailItemInfo}>
                    <Text style={styles.orderDetailItemName} numberOfLines={2}>{item.subjectTrans || item.subject || item.productName || item.name || ''}</Text>
                    <Text style={styles.orderDetailItemMeta}>
                      {item.quantity ? `x${item.quantity}` : ''}{item.price ? `  ₩${Number(item.price).toLocaleString()}` : ''}
                    </Text>
                  </View>
                </View>
              ))}
              {orderData.totalAmount ? (
                <View style={styles.orderDetailRow}>
                  <Text style={styles.orderDetailLabel}>{t('chat.totalAmount') || '합계'}</Text>
                  <Text style={styles.orderDetailValue}>₩{Number(orderData.totalAmount).toLocaleString()}</Text>
                </View>
              ) : null}
              {/* {orderData.progressStatus ? (
                <View style={styles.orderDetailRow}>
                  <Text style={styles.orderDetailLabel}>{t('chat.orderStatus') || '주문상태'}</Text>
                  <Text style={[styles.orderDetailValue, { color: COLORS.primary }]}>{orderData.progressStatus}</Text>
                </View>
              ) : null}
              {orderData.createdAt ? (
                <View style={styles.orderDetailRow}>
                  <Text style={styles.orderDetailLabel}>{t('chat.orderDate') || '주문일'}</Text>
                  <Text style={styles.orderDetailValue}>{new Date(orderData.createdAt).toLocaleDateString()}</Text>
                </View>
              ) : null} */}
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Messages + Input */}
      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
        </View>
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1, paddingBottom: Platform.OS === 'android' && keyboardHeight > 0 ? keyboardHeight + insets.bottom : 0 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <ScrollView
            ref={scrollViewRef}
            style={styles.messagesList}
            contentContainerStyle={styles.messagesContent}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>
                  {inquiryId ? t('chat.noMessages') || 'No messages yet.' : t('chat.sendToCreateInquiry') || '문의할 내용을 자세히 입력해 주세요.'}
                </Text>
              </View>
            ) : (
              messages.map((message, index) => renderMessage(message))
            )}
          </ScrollView>

          {/* Pending Attachments Preview */}
          {pendingAttachments.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ paddingHorizontal: 12, paddingVertical: 6, backgroundColor: COLORS.white }}>
              {pendingAttachments.map((att, idx) => (
                <View key={`pending-${idx}`} style={{ marginRight: 8, position: 'relative' }}>
                  <Image source={{ uri: att.uri }} style={{ width: 60, height: 60, borderRadius: 8 }} resizeMode="cover" />
                  <TouchableOpacity
                    style={{ position: 'absolute', top: -6, right: -6, backgroundColor: COLORS.red || '#FF0000', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}
                    onPress={() => setPendingAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Icon name="close" size={12} color={COLORS.white} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}

          {/* Input Area */}
          <View style={[styles.inputContainer, { paddingBottom: keyboardHeight > 0 ? 10 : 10 + insets.bottom }]}>
            <TouchableOpacity style={styles.attachIconBtn} onPress={handleMoreOptions}>
              <Icon name="image-outline" size={22} color={COLORS.gray[500]} />
            </TouchableOpacity>
            <View style={styles.inputWrapper}>
              <TextInput
                style={styles.input}
                placeholder={t('chat.typeMessage')}
                value={inputText}
                onChangeText={setInputText}
                multiline
                maxLength={500}
                placeholderTextColor={COLORS.gray[400]}
              />
            </View>
            <TouchableOpacity
              style={[styles.sendButton, (!inputText.trim() && pendingAttachments.length === 0) && styles.sendButtonDisabled]}
              onPress={handleSendMessage}
              disabled={!inputText.trim() && pendingAttachments.length === 0}
            >
              <Text style={styles.sendButtonText}>
                {t('chat.send') || '전송'}
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* More Options Modal */}
      <Modal
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right']}
        visible={showMoreModal}
        statusBarTranslucent={true}
        transparent={true}
        animationType="slide"
        onRequestClose={handleCloseMoreModal}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity 
            style={styles.modalBackdrop} 
            activeOpacity={1} 
            onPress={handleCloseMoreModal}
          >
            <View style={styles.stickbar} />
          </TouchableOpacity>
          <View style={styles.modalContainer}>
            {/* <View style={styles.modalHandle} /> */}
            <Text style={styles.modalTitle}>{t('chat.more')}</Text>
            
            <View style={styles.optionsGrid}>
              <TouchableOpacity 
                style={styles.optionButton} 
                onPress={() => handleMoreOptionPress('Gallery')}
              >
                <View style={styles.optionIcon}>
                  <Icon name="images-outline" size={24} color={COLORS.text.primary} />
                </View>
                <Text style={styles.optionText}>{t('chat.gallery')}</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={styles.optionButton} 
                onPress={() => handleMoreOptionPress('Camera')}
              >
                <View style={styles.optionIcon}>
                  <Icon name="camera-outline" size={24} color={COLORS.text.primary} />
                </View>
                <Text style={styles.optionText}>{t('chat.camera')}</Text>
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
    backgroundColor: '#F5F5F5',
  },
  headerSafeArea: {
    backgroundColor: COLORS.white,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    backgroundColor: COLORS.white,
  },
  orderInfoSection: {
    marginTop: SPACING.md,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.md,
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: FONTS.sizes.lg,
    fontWeight: '700',
    color: COLORS.black,
  },
  orderInfoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  orderInfoIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#FFF3ED',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  orderInfoContent: {
    flex: 1,
  },
  orderInfoImage: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: COLORS.gray[100],
    marginRight: 10,
  },
  orderInfoNumber: {
    fontSize: FONTS.sizes.base,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  orderInfoStatus: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.primary,
    marginTop: 2,
    fontWeight: '500',
  },
  orderDetailDropdown: {
    backgroundColor: COLORS.white,
    paddingHorizontal: SPACING.md,
    paddingBottom: 12,
    marginTop: SPACING.xs,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  orderDetailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray[100],
  },
  orderDetailItemImage: {
    width: 48,
    height: 48,
    borderRadius: 6,
    backgroundColor: COLORS.gray[100],
    marginRight: 10,
  },
  orderDetailItemInfo: {
    flex: 1,
  },
  orderDetailItemName: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 18 / 14),
  },
  orderDetailItemMeta: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
    marginTop: 2,
  },
  orderDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  orderDetailLabel: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[500],
  },
  orderDetailValue: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  messagesList: {
    flex: 1,
  },
  messagesContent: {
    padding: SPACING.md,
    paddingBottom: SPACING.lg,
  },
  userMessageContainer: {
    alignItems: 'flex-end',
    marginBottom: SPACING.md,
  },
  adminMessageContainer: {
    alignItems: 'flex-start',
    marginBottom: SPACING.md,
  },
  messageMeta: {
    fontSize: 11,
    color: COLORS.gray[500],
    marginBottom: 4,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    maxWidth: '85%',
  },
  adminAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.primary || '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  userAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.gray[400],
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  userAvatarImage: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginLeft: 8,
  },
  userBubble: {
    backgroundColor: '#FFF3ED',
    borderRadius: 16,
    borderTopRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexShrink: 1,
  },
  adminBubble: {
    backgroundColor: COLORS.white,
    borderRadius: 16,
    borderTopLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexShrink: 1,
  },
  userMessageText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 20 / 14),
  },
  adminMessageText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    lineHeight: Math.round(FONTS.sizes.sm * 20 / 14),
  },
  attachIconBtn: {
    padding: 4,
    justifyContent: 'center',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: SPACING.sm,
    paddingBottom: 10,
    paddingTop: 6,
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: COLORS.gray[200],
  },
  inputWrapper: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.gray[300],
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginHorizontal: 6,
    minHeight: 40,
    justifyContent: 'center',
  },
  input: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    maxHeight: 80,
    padding: 0,
  },
  sendButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: COLORS.primary || '#FF6B35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: COLORS.gray[300],
  },
  sendButtonText: {
    fontSize: FONTS.sizes.sm,
    fontWeight: '700',
    color: COLORS.white,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    height: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  modalContainer: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingBottom: 34, // Space for home indicator
    paddingHorizontal: SPACING.lg,
    maxHeight: '50%',
  },
  modalHandle: {
    width: 40,
    height: 4,
    backgroundColor: COLORS.gray[300],
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: SPACING.md,
  },
  modalTitle: {
    fontSize: FONTS.sizes.xl,
    fontWeight: 'bold',
    color: COLORS.text.primary,
    textAlign: 'center',
    marginBottom: SPACING.md,
  },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  optionButton: {
    width: '24%',
    aspectRatio: 1,
    backgroundColor: COLORS.gray[50],
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    // marginBottom: SPACING.md,
    paddingVertical: SPACING.md,
  },
  optionIcon: {
    marginBottom: SPACING.sm,
  },
  optionText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.text.primary,
    fontWeight: '500',
  },
  recallButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: COLORS.gray[100],
    borderWidth: 1,
    borderColor: COLORS.gray[200],
  },
  recallButtonText: {
    fontSize: 11,
    color: COLORS.gray[600],
    marginLeft: 4,
    fontWeight: '500',
  },
  stickbar: {
    width: '10%',
    height: 15,
    borderTopColor: COLORS.white,
    borderTopWidth: 3,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.xxl,
  },
  loadingText: {
    marginTop: SPACING.md,
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: SPACING.xxl,
  },
  emptyStateText: {
    fontSize: FONTS.sizes.md,
    color: COLORS.text.secondary,
    textAlign: 'center',
  },
  // Date header styles
  dateHeaderContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
  },
  dateHeaderLine: {
    flex: 1,
    height: 1,
    backgroundColor: COLORS.gray[300],
  },
  dateHeaderText: {
    fontSize: FONTS.sizes.sm,
    color: COLORS.gray[500],
    marginHorizontal: SPACING.sm,
    fontWeight: '500',
  },
  // Message footer styles
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.xs,
  },
  messageFooterSeller: {
    justifyContent: 'flex-start',
  },
  messageTime: {
    fontSize: FONTS.sizes.xs,
    color: COLORS.gray[500],
    marginRight: SPACING.xs,
  },
  readIcon: {
    marginLeft: SPACING.xs,
  },
});

export default ChatScreen;
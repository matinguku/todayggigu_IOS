import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import {
  socketService,
  GeneralInquiry,
  SocketMessage,
  BroadcastNote,
  OrderNoteEvent,
  OrderNoteConfirmedEvent,
} from '../services/socketService';
import { useAuth } from './AuthContext';
import { getStoredToken } from '../services/authApi';
import { inquiryApi } from '../services/inquiryApi';
import { isInquiryConfirmedSync, prewarmVisitedInquiries } from '../utils/visitedInquiries';
import { recordAdminReadSync, prewarmAdminReadReceipts } from '../utils/adminReadReceipts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../constants';

interface SocketContextType {
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  // Order Inquiry Socket methods
  subscribeToInquiry: (inquiryId: string) => void;
  unsubscribeFromInquiry: (inquiryId: string) => void;
  getUnreadCounts: () => void;
  createInquiry: (orderId: string, message: string, attachments?: any[]) => void;
  sendInquiryMessage: (inquiryId: string, message: string, attachments?: any[]) => void;
  markInquiryAsRead: (inquiryId: string) => void;
  closeInquiry: (inquiryId: string) => void;
  // General Inquiry Socket methods
  subscribeToGeneralInquiry: (inquiryId: string) => void;
  unsubscribeFromGeneralInquiry: (inquiryId: string) => void;
  getGeneralInquiryUnreadCounts: () => void;
  createGeneralInquiry: (data: { subject?: string; category?: 'general' | 'support' | 'complaint' | 'suggestion' | 'technical'; message: string; attachments?: { type: 'image' | 'file' | 'video'; url: string; name?: string }[] }) => void;
  sendGeneralInquiryMessage: (inquiryId: string, message: string, attachments?: any[]) => void;
  markGeneralInquiryAsRead: (inquiryId: string) => void;
  closeGeneralInquiry: (inquiryId: string) => void;
  // State
  inquiries: GeneralInquiry[];
  currentInquiry: GeneralInquiry | null;
  unreadCount: number;
  orderInquiryUnreadById: Record<string, number>;
  // 관리자가 사용자 메시지를 읽을 때마다 +1. MessageScreen 이 이 값을 구독해
  // 카드의 체크 표시(✓/✓✓)를 다시 그린다. 실제 읽음 시각은 adminReadReceipts 에 영속.
  inquiryReadReceiptVersion: number;
  generalInquiries: GeneralInquiry[];
  currentGeneralInquiry: GeneralInquiry | null;
  generalInquiryUnreadCount: number;
  generalInquiryUnreadById: Record<string, number>;
  // ── 화면 측에서 계산한 미확인 개수를 BottomBar 배지에 즉시 반영하기 위한 setter.
  //    MessageScreen 이 자신이 가진 orderInquiries / generalInquiries 의 status
  //    를 기준으로 정확한 미확인 건수를 SocketContext 로 push 한다.
  setUnreadCountOverride: (count: number) => void;
  setGeneralInquiryUnreadCountOverride: (count: number) => void;
  // Order Inquiry Event handlers
  onInquiryCreated: (callback: (inquiry: GeneralInquiry) => void) => void;
  onMessageReceived: (callback: (data: { message: SocketMessage; inquiryId: string; unreadCount?: number; totalUnreadCount?: number }) => void) => void;
  onInquiryUpdated: (callback: (inquiry: GeneralInquiry) => void) => void;
  onInquiryClosed: (callback: (inquiryId: string) => void) => void;
  onMessagesRead: (callback: (data: { inquiryId: string; readBy: string; readByType: string; readByName: string; readAt: string }) => void) => void;
  onUnreadCountUpdated: (callback: (count: number) => void) => void;
  // General Inquiry Event handlers
  onGeneralInquiryCreated: (callback: (inquiry: GeneralInquiry) => void) => void;
  onGeneralInquiryMessageReceived: (callback: (data: { message: SocketMessage; inquiryId: string; unreadCount?: number; totalUnreadCount?: number }) => void) => void;
  onGeneralInquiryUpdated: (callback: (inquiry: GeneralInquiry) => void) => void;
  onGeneralInquiryClosed: (callback: (inquiryId: string) => void) => void;
  onGeneralInquiryMessagesRead: (callback: (data: { inquiryId: string; readBy: string; readByType: string; readByName: string; readAt: string }) => void) => void;
  onGeneralInquiryUnreadCountUpdated: (callback: (count: number) => void) => void;
  // Note Broadcast
  notes: BroadcastNote[];
  onNoteReceived: (callback: (note: BroadcastNote) => void) => void;
  onNoteDeleted: (callback: (noteId: string) => void) => void;
  // Order Note (주문 단위 메시지 — 주문문의 페지의 양방향 채널)
  subscribeToOrderNotes: (orderId: string) => void;
  unsubscribeFromOrderNotes: (orderId: string) => void;
  sendOrderNote: (
    orderId: string,
    value: string,
    extra?: { orderNumber?: string; name?: string },
  ) => void;
  confirmOrderNotes: (
    orderId: string,
    extra?: { orderNumber?: string; noteIds?: string[] },
  ) => void;
  onOrderNoteReceived: (callback: (data: OrderNoteEvent) => void) => void;
  onOrderNoteConfirmed: (callback: (data: OrderNoteConfirmedEvent) => void) => void;
  // Remove listeners
  removeListeners: () => void;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

export const SocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [inquiries, setInquiries] = useState<GeneralInquiry[]>([]);
  const [currentInquiry, setCurrentInquiry] = useState<GeneralInquiry | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  // 화면에서 push 한 우선 값. null 이면 socket 값(`unreadCount`) 을 사용,
  // number 이면 그 값을 그대로 노출 → socket 응답이 들어와도 무시.
  // 이로 인해 socket 의 반복 emit 으로 인한 배지 깜박임이 사라진다.
  const [unreadCountOverride, setUnreadCountOverrideState] = useState<number | null>(null);
  const [orderInquiryUnreadById, setOrderInquiryUnreadById] = useState<Record<string, number>>({});
  const [inquiryReadReceiptVersion, setInquiryReadReceiptVersion] = useState(0);
  const [generalInquiries, setGeneralInquiries] = useState<GeneralInquiry[]>([]);
  const [currentGeneralInquiry, setCurrentGeneralInquiry] = useState<GeneralInquiry | null>(null);
  const [generalInquiryUnreadCount, setGeneralInquiryUnreadCount] = useState(0);
  const [generalInquiryUnreadCountOverride, setGeneralInquiryUnreadCountOverrideState] = useState<number | null>(null);
  const [generalInquiryUnreadById, setGeneralInquiryUnreadById] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<BroadcastNote[]>([]);
  
  // Callback refs for note event handlers
  const onNoteReceivedCallbackRef = React.useRef<((note: BroadcastNote) => void) | null>(null);
  const onNoteDeletedCallbackRef = React.useRef<((noteId: string) => void) | null>(null);

  // Callback refs for order-note event handlers (주문문의 채널)
  const onOrderNoteReceivedCallbackRef = React.useRef<((data: OrderNoteEvent) => void) | null>(null);
  const onOrderNoteConfirmedCallbackRef = React.useRef<((data: OrderNoteConfirmedEvent) => void) | null>(null);
  
  // Callback refs for order inquiry event handlers
  const onInquiryCreatedCallbackRef = React.useRef<((inquiry: GeneralInquiry) => void) | null>(null);
  const onMessageReceivedCallbackRef = React.useRef<((data: { message: SocketMessage; inquiryId: string; unreadCount?: number; totalUnreadCount?: number }) => void) | null>(null);
  const onInquiryUpdatedCallbackRef = React.useRef<((inquiry: GeneralInquiry) => void) | null>(null);
  const onInquiryClosedCallbackRef = React.useRef<((inquiryId: string) => void) | null>(null);
  const onUnreadCountUpdatedCallbackRef = React.useRef<((count: number) => void) | null>(null);
  const onMessagesReadCallbackRef = React.useRef<((data: { inquiryId: string; readBy: string; readByType: string; readByName: string; readAt: string }) => void) | null>(null);
  
  // Callback refs for general inquiry event handlers
  const onGeneralInquiryCreatedCallbackRef = React.useRef<((inquiry: GeneralInquiry) => void) | null>(null);
  const onGeneralInquiryMessageReceivedCallbackRef = React.useRef<((data: { message: SocketMessage; inquiryId: string; unreadCount?: number; totalUnreadCount?: number }) => void) | null>(null);
  const onGeneralInquiryUpdatedCallbackRef = React.useRef<((inquiry: GeneralInquiry) => void) | null>(null);
  const onGeneralInquiryClosedCallbackRef = React.useRef<((inquiryId: string) => void) | null>(null);
  const onGeneralInquiryUnreadCountUpdatedCallbackRef = React.useRef<((count: number) => void) | null>(null);
  const onGeneralInquiryMessagesReadCallbackRef = React.useRef<((data: { inquiryId: string; readBy: string; readByType: string; readByName: string; readAt: string }) => void) | null>(null);

  // Connect socket when authenticated
  const connect = useCallback(async () => {
    if (!isAuthenticated || !user) {
      console.log('[Socket] Not authenticated, skipping socket connection');
      return;
    }

    if (socketService.isConnected()) {
      console.log('[Socket] Already connected');
      setIsConnected(true);
      return;
    }

    if (isConnecting) {
      console.log('[Socket] Connection already in progress');
      return;
    }

    try {
      setIsConnecting(true);
      console.log('[Socket] Connecting...');
      const token = await getStoredToken();

      if (!token) {
        console.warn('[Socket] No token available for socket connection');
        setIsConnecting(false);
        return;
      }

      await socketService.connect(token);
      const actuallyConnected = socketService.isConnected();
      setIsConnected(actuallyConnected);
      setIsConnecting(false);
      console.log('[Socket] connect() resolved, actuallyConnected:', actuallyConnected);

      // Set up event listeners (even if not connected yet, for auto-reconnect)
      setupEventListeners();
    } catch (error) {
      // Warn only — socket is optional; REST API handles orders/payment without it
      console.warn('[Socket] Failed to connect:', error);
      setIsConnecting(false);
      setIsConnected(false);
    }
  }, [isAuthenticated]);

  // Disconnect socket
  const disconnect = useCallback(() => {
    socketService.disconnect();
    setIsConnected(false);
    setInquiries([]);
    setCurrentInquiry(null);
    setUnreadCount(0);
    setOrderInquiryUnreadById({});
    setGeneralInquiries([]);
    setCurrentGeneralInquiry(null);
    setGeneralInquiryUnreadCount(0);
    setGeneralInquiryUnreadById({});
    setNotes([]);
  }, []);

  // ========== Order Inquiry Socket Methods ==========
  
  const subscribeToInquiry = useCallback((inquiryId: string) => {
    console.log('[Socket][OrderInquiry] Subscribing to inquiry:', inquiryId);
    socketService.subscribeToInquiry(inquiryId);
  }, []);

  const unsubscribeFromInquiry = useCallback((inquiryId: string) => {
    console.log('[Socket][OrderInquiry] Unsubscribing from inquiry:', inquiryId);
    socketService.unsubscribeFromInquiry(inquiryId);
  }, []);

  const getUnreadCounts = useCallback(() => {
    console.log('[Socket][OrderInquiry] Getting unread counts');
    socketService.getUnreadCounts();
  }, []);

  const createInquiry = useCallback((orderId: string, message: string, attachments?: any[]) => {
    console.log('[Socket][OrderInquiry] Creating inquiry via socket:', { orderId, message: message.substring(0, 50) });
    socketService.createInquiry(orderId, message, attachments);
  }, []);

  const sendInquiryMessage = useCallback((inquiryId: string, message: string, attachments?: any[]) => {
    console.log('[Socket][OrderInquiry] Sending message:', { inquiryId, message: message.substring(0, 50), socketConnected: socketService.isConnected() });
    socketService.sendMessage(inquiryId, message, attachments);
  }, []);

  const markInquiryAsRead = useCallback((inquiryId: string) => {
    console.log('[Socket][OrderInquiry] Marking as read:', inquiryId);
    socketService.markInquiryAsRead(inquiryId);
  }, []);

  const closeInquiry = useCallback((inquiryId: string) => {
    console.log('[Socket][OrderInquiry] Closing inquiry:', inquiryId);
    socketService.closeInquiry(inquiryId);
  }, []);

  // ========== General Inquiry Socket Methods ==========

  const subscribeToGeneralInquiry = useCallback((inquiryId: string) => {
    socketService.subscribeToGeneralInquiry(inquiryId);
  }, []);

  const unsubscribeFromGeneralInquiry = useCallback((inquiryId: string) => {
    socketService.unsubscribeFromGeneralInquiry(inquiryId);
  }, []);

  const getGeneralInquiryUnreadCounts = useCallback(() => {
    socketService.getGeneralInquiryUnreadCounts();
  }, []);

  const createGeneralInquiry = useCallback((data: { subject?: string; category?: 'general' | 'support' | 'complaint' | 'suggestion' | 'technical'; message: string; attachments?: { type: 'image' | 'file' | 'video'; url: string; name?: string }[] }) => {
    socketService.createGeneralInquiry(data);
  }, []);

  const sendGeneralInquiryMessage = useCallback((inquiryId: string, message: string, attachments?: any[]) => {
    socketService.sendGeneralInquiryMessage(inquiryId, message, attachments);
  }, []);

  const markGeneralInquiryAsRead = useCallback((inquiryId: string) => {
    socketService.markGeneralInquiryAsRead(inquiryId);
  }, []);

  const closeGeneralInquiry = useCallback((inquiryId: string) => {
    socketService.closeGeneralInquiry(inquiryId);
  }, []);

  // Set up event listeners
  const setupEventListeners = useCallback(() => {
    const socket = socketService.getSocket();
    if (!socket) return;

    // Connection status
    socket.on('connect', () => {
      console.log('[Socket] Connected in context');
      setIsConnected(true);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected in context, reason:', reason);
      setIsConnected(false);
    });

    // Socket Events - Real-time updates (Server → Client)
    // Note: Create, send, list, get, mark-read, close should use REST API

    // Subscribe/Unsubscribe success
    socket.on('user:inquiry:subscribe:success', (data: { inquiryId: string; message: string }) => {
      console.log('[Socket][OrderInquiry] Subscribe success:', data.inquiryId);
    });

    socket.on('user:inquiry:unsubscribe:success', (data: { inquiryId: string; message: string }) => {
      console.log('[Socket][OrderInquiry] Unsubscribe success:', data.inquiryId);
    });

    // Unread counts response
    socket.on('user:inquiry:unread-counts:response', (data: { totalUnread: number; inquiries: Array<{ inquiryId: string; unreadCount: number }> }) => {
      // console.log('Unread counts:', data);
      setUnreadCount(data.totalUnread);
      const byId: Record<string, number> = {};
      for (const item of data.inquiries || []) {
        byId[item.inquiryId] = item.unreadCount ?? 0;
      }
      setOrderInquiryUnreadById(byId);
      if (onUnreadCountUpdatedCallbackRef.current) {
        onUnreadCountUpdatedCallbackRef.current(data.totalUnread);
      }
    });

    // Real-time events - User receives from server
    socket.on('user:inquiry:message:received', (data: {
      message: SocketMessage;
      inquiryId: string;
      unreadCount?: number;
      totalUnreadCount?: number;
    }) => {
      console.log('[Socket][OrderInquiry] Message received:', {
        inquiryId: data.inquiryId,
        messageId: data.message?._id,
        messageText: data.message?.message?.substring(0, 50) || 'N/A',
        senderType: data.message?.senderType,
        unreadCount: data.unreadCount,
        totalUnreadCount: data.totalUnreadCount,
      });
      
      if (data.totalUnreadCount !== undefined) {
        // console.log(`📊 SocketContext: Updating total unread count to ${data.totalUnreadCount}`);
        setUnreadCount(data.totalUnreadCount);
      }
      
      // Save unread count for this inquiry to AsyncStorage (even when BuyListScreen is not open)
      if (data.inquiryId && data.unreadCount !== undefined) {
        setOrderInquiryUnreadById((prev) => ({
          ...prev,
          [data.inquiryId]: data.unreadCount!,
        }));
        AsyncStorage.getItem(STORAGE_KEYS.INQUIRY_UNREAD_COUNTS)
          .then((savedData) => {
            const savedCounts: { [inquiryId: string]: number } = savedData ? JSON.parse(savedData) : {};
            savedCounts[data.inquiryId] = data.unreadCount!;
            return AsyncStorage.setItem(STORAGE_KEYS.INQUIRY_UNREAD_COUNTS, JSON.stringify(savedCounts));
          })
          .then(() => {
            // console.log(`💾 SocketContext: Saved unread count for inquiry ${data.inquiryId} to AsyncStorage`);
          })
          .catch((error) => {
            // console.error('SocketContext: Failed to save unread count:', error);
          });
      }
      
      if (onMessageReceivedCallbackRef.current) {
        // console.log('✅ SocketContext: Calling onMessageReceived callback');
        onMessageReceivedCallbackRef.current({
          message: data.message,
          inquiryId: data.inquiryId,
          unreadCount: data.unreadCount,
          totalUnreadCount: data.totalUnreadCount,
        });
      } else {
        // console.warn('⚠️ SocketContext: No onMessageReceived callback registered');
      }
    });

    socket.on('user:inquiry:messages-read', (data: {
      inquiryId: string;
      readBy: string;
      readByType: string;
      readByName: string;
      readAt: string;
    }) => {
      console.log('[Socket][OrderInquiry] Messages read:', { inquiryId: data.inquiryId, readBy: data.readByName });
      // 사용자 본인 읽음을 제외한 모든 read(=관리자/상담원) 를 영속 기록
      // → MessageScreen 카드가 ✓✓(읽음)로 표시. (원래 토스트도 type 무관하게 떴음)
      if (data.readByType !== 'user' && data.inquiryId) {
        recordAdminReadSync(data.inquiryId, data.readAt);
        setInquiryReadReceiptVersion((v) => v + 1);
      }
      if (onMessagesReadCallbackRef.current) {
        onMessagesReadCallbackRef.current(data);
      }
    });

    // Create order inquiry success (user-initiated)
    socket.on('user:inquiry:create:success', (data: { inquiry: GeneralInquiry }) => {
      console.log('[Socket][OrderInquiry] Create success:', { inquiryId: data.inquiry?._id, orderId: data.inquiry?.order?._id });
      setInquiries(prev => [data.inquiry, ...prev]);
      if (onInquiryCreatedCallbackRef.current) {
        onInquiryCreatedCallbackRef.current(data.inquiry);
      }
    });

    socket.on('user:inquiry:new', (data: { inquiry: GeneralInquiry }) => {
      console.log('[Socket][OrderInquiry] New inquiry from admin:', { inquiryId: data.inquiry?._id });
      setInquiries(prev => [data.inquiry, ...prev]);
      if (onInquiryCreatedCallbackRef.current) {
        onInquiryCreatedCallbackRef.current(data.inquiry);
      }
    });

    socket.on('user:inquiry:closed', (data: { inquiryId: string; status: string }) => {
      console.log('[Socket][OrderInquiry] Inquiry closed:', data.inquiryId);
      setInquiries(prev => 
        prev.map(inq => inq._id === data.inquiryId ? { ...inq, status: 'closed' as const } : inq)
      );
      if (onInquiryClosedCallbackRef.current) {
        onInquiryClosedCallbackRef.current(data.inquiryId);
      }
    });

    socket.on('user:inquiry:reopened', (data: { inquiryId: string; status: string }) => {
      // console.log('Inquiry reopened:', data.inquiryId);
      setInquiries(prev => 
        prev.map(inq => inq._id === data.inquiryId ? { ...inq, status: 'open' as const } : inq)
      );
    });

    socket.on('inquiry:admin-assigned', (data: {
      inquiryId: string;
      assignedAdmin: { _id: string; name: string };
    }) => {
      // console.log('Admin assigned to inquiry:', data);
      setInquiries(prev =>
        prev.map(inq => inq._id === data.inquiryId ? {
          ...inq,
          assignedAdmin: {
            _id: data.assignedAdmin._id,
            name: data.assignedAdmin.name,
            email: inq.assignedAdmin?.email || ''
          }
        } : inq)
      );
    });

    // ========== Order Note Events (주문문의 양방향 채널) ==========

    /** Admin 이 보낸 새 note 가 user 세션에 push 됨. */
    socket.on('user:order-note:received', (data: OrderNoteEvent) => {
      console.log('[Socket][OrderNote] received:', {
        orderId: data?.orderId,
        value: data?.value?.toString().substring(0, 40),
        name: data?.name,
      });
      if (onOrderNoteReceivedCallbackRef.current) {
        try { onOrderNoteReceivedCallbackRef.current(data); } catch (cbErr) {
          console.warn('[Socket][OrderNote] onOrderNoteReceived callback threw:', cbErr);
        }
      }
    });

    /** User (혹은 다른 세션) 가 note 들을 확인 처리했음을 broadcast. */
    socket.on('user:order-note:confirmed', (data: OrderNoteConfirmedEvent) => {
      console.log('[Socket][OrderNote] confirmed:', {
        orderId: data?.orderId,
        orderNumber: data?.orderNumber,
        confirmedBy: data?.confirmedBy,
        confirmedCount: data?.confirmedCount,
      });
      if (onOrderNoteConfirmedCallbackRef.current) {
        try { onOrderNoteConfirmedCallbackRef.current(data); } catch (cbErr) {
          console.warn('[Socket][OrderNote] onOrderNoteConfirmed callback threw:', cbErr);
        }
      }
    });

    // ========== General Inquiry Events ==========
    
    // Subscribe/Unsubscribe success
    socket.on('user:general-inquiry:subscribe:success', (data: { inquiryId: string; message: string }) => {
      // console.log('Subscribed to general inquiry:', data.inquiryId);
    });

    socket.on('user:general-inquiry:unsubscribe:success', (data: { inquiryId: string; message: string }) => {
      // console.log('Unsubscribed from general inquiry:', data.inquiryId);
    });

    // Unread counts response
    socket.on('user:general-inquiry:unread-counts:response', (data: { totalUnread: number; inquiries: Array<{ inquiryId: string; unreadCount: number }> }) => {
      // console.log('General inquiry unread counts:', data);
      setGeneralInquiryUnreadCount(data.totalUnread);
      const byId: Record<string, number> = {};
      for (const item of data.inquiries || []) {
        byId[item.inquiryId] = item.unreadCount ?? 0;
      }
      setGeneralInquiryUnreadById(byId);
      if (onGeneralInquiryUnreadCountUpdatedCallbackRef.current) {
        onGeneralInquiryUnreadCountUpdatedCallbackRef.current(data.totalUnread);
      }
    });

    socket.on('user:general-inquiry:unread-count:response', (data: { count: number }) => {
      // console.log('General inquiry total unread count:', data.count);
      setGeneralInquiryUnreadCount(data.count);
      if (onGeneralInquiryUnreadCountUpdatedCallbackRef.current) {
        onGeneralInquiryUnreadCountUpdatedCallbackRef.current(data.count);
      }
    });

    // Create inquiry success
    socket.on('user:general-inquiry:create:success', (data: { inquiry: GeneralInquiry }) => {
      // console.log('General inquiry created:', data.inquiry);
      setGeneralInquiries(prev => [data.inquiry, ...prev]);
      if (onGeneralInquiryCreatedCallbackRef.current) {
        onGeneralInquiryCreatedCallbackRef.current(data.inquiry);
      }
    });

    // Send message success
    socket.on('user:general-inquiry:message:success', (data: { inquiry: GeneralInquiry }) => {
      // console.log('General inquiry message sent:', data.inquiry);
      setGeneralInquiries(prev => 
        prev.map(inq => inq._id === data.inquiry._id ? data.inquiry : inq)
      );
      if (currentGeneralInquiry?._id === data.inquiry._id) {
        setCurrentGeneralInquiry(data.inquiry);
      }
    });

    // Get inquiry response
    socket.on('user:general-inquiry:get:response', (data: { inquiry: GeneralInquiry }) => {
      // console.log('General inquiry fetched:', data.inquiry);
      setCurrentGeneralInquiry(data.inquiry);
      setGeneralInquiries(prev => {
        const existing = prev.find(inq => inq._id === data.inquiry._id);
        if (existing) {
          return prev.map(inq => inq._id === data.inquiry._id ? data.inquiry : inq);
        }
        return [data.inquiry, ...prev];
      });
    });

    // Get inquiries list response
    socket.on('user:general-inquiry:list:response', (data: { inquiries: GeneralInquiry[] }) => {
      // console.log('General inquiries list:', data.inquiries);
      setGeneralInquiries(data.inquiries);
    });

    // Mark read success
    socket.on('user:general-inquiry:mark-read:success', (data: { inquiryId: string; inquiry: GeneralInquiry }) => {
      // console.log('General inquiry marked as read:', data.inquiryId);
      setGeneralInquiries(prev => 
        prev.map(inq => inq._id === data.inquiryId ? data.inquiry : inq)
      );
      if (currentGeneralInquiry?._id === data.inquiryId) {
        setCurrentGeneralInquiry(data.inquiry);
      }
    });

    // Close inquiry success
    socket.on('user:general-inquiry:close:success', (data: { inquiry: GeneralInquiry }) => {
      // console.log('General inquiry closed:', data.inquiry._id);
      setGeneralInquiries(prev => 
        prev.map(inq => inq._id === data.inquiry._id ? data.inquiry : inq)
      );
      if (onGeneralInquiryClosedCallbackRef.current) {
        onGeneralInquiryClosedCallbackRef.current(data.inquiry._id);
      }
    });

    // Real-time events - User receives from server
    socket.on('user:general-inquiry:message:received', (data: { 
      message: SocketMessage; 
      inquiryId: string; 
      unreadCount?: number; 
      totalUnreadCount?: number;
    }) => {
      // console.log('🔔 General inquiry message received:', {
      //   inquiryId: data.inquiryId,
      //   messageId: data.message?._id,
      //   messageText: data.message?.message || 'N/A',
      //   senderType: data.message?.senderType,
      //   unreadCount: data.unreadCount,
      //   totalUnreadCount: data.totalUnreadCount,
      // });
      
      if (data.totalUnreadCount !== undefined) {
        setGeneralInquiryUnreadCount(data.totalUnreadCount);
      }

      if (data.inquiryId && data.unreadCount !== undefined) {
        setGeneralInquiryUnreadById((prev) => ({
          ...prev,
          [data.inquiryId]: data.unreadCount!,
        }));
      }
      
      // Update inquiry with new message
      setGeneralInquiries(prev => 
        prev.map(inq => {
          if (inq._id === data.inquiryId) {
            return {
              ...inq,
              messages: [...inq.messages, data.message],
              lastMessageAt: data.message.timestamp,
              unreadCount: data.unreadCount,
            };
          }
          return inq;
        })
      );
      
      if (currentGeneralInquiry?._id === data.inquiryId) {
        setCurrentGeneralInquiry(prev => prev ? {
          ...prev,
          messages: [...prev.messages, data.message],
          lastMessageAt: data.message.timestamp,
        } : null);
      }
      
      if (onGeneralInquiryMessageReceivedCallbackRef.current) {
        onGeneralInquiryMessageReceivedCallbackRef.current({
          message: data.message,
          inquiryId: data.inquiryId,
          unreadCount: data.unreadCount,
          totalUnreadCount: data.totalUnreadCount,
        });
      }
    });

    socket.on('user:general-inquiry:messages-read', (data: { 
      inquiryId: string; 
      readBy: string; 
      readByType: string; 
      readByName: string; 
      readAt: string;
    }) => {
      // console.log('Admin read general inquiry messages:', data);
      // 사용자 본인 읽음을 제외한 모든 read(=관리자/상담원) 를 영속 기록.
      if (data.readByType !== 'user' && data.inquiryId) {
        recordAdminReadSync(data.inquiryId, data.readAt);
        setInquiryReadReceiptVersion((v) => v + 1);
      }
      if (onGeneralInquiryMessagesReadCallbackRef.current) {
        onGeneralInquiryMessagesReadCallbackRef.current(data);
      }
    });

    socket.on('user:general-inquiry:new', (data: { inquiry: GeneralInquiry }) => {
      // console.log('New general inquiry created by admin:', data.inquiry);
      setGeneralInquiries(prev => [data.inquiry, ...prev]);
      if (onGeneralInquiryCreatedCallbackRef.current) {
        onGeneralInquiryCreatedCallbackRef.current(data.inquiry);
      }
    });

    socket.on('user:general-inquiry:closed', (data: { inquiryId: string; status: string }) => {
      // console.log('General inquiry closed:', data.inquiryId);
      setGeneralInquiries(prev => 
        prev.map(inq => inq._id === data.inquiryId ? { ...inq, status: 'closed' as const } : inq)
      );
      if (onGeneralInquiryClosedCallbackRef.current) {
        onGeneralInquiryClosedCallbackRef.current(data.inquiryId);
      }
    });

    socket.on('user:general-inquiry:reopened', (data: { inquiryId: string; status: string }) => {
      // console.log('General inquiry reopened:', data.inquiryId);
      setGeneralInquiries(prev => 
        prev.map(inq => inq._id === data.inquiryId ? { ...inq, status: 'open' as const } : inq)
      );
    });

    socket.on('general-inquiry:admin-assigned', (data: { 
      inquiryId: string; 
      assignedAdmin: { _id: string; name: string };
    }) => {
      // console.log('Admin assigned to general inquiry:', data);
      setGeneralInquiries(prev => 
        prev.map(inq => inq._id === data.inquiryId ? { 
          ...inq, 
          assignedAdmin: { 
            _id: data.assignedAdmin._id,
            name: data.assignedAdmin.name,
            email: inq.assignedAdmin?.email || '' 
          } 
        } : inq)
      );
    });

    // ========== Note Broadcast Events ==========
    
    // Receive note broadcast
    socket.on('note:broadcast', (note: BroadcastNote) => {
      // console.log('📢 Note broadcast received:', note);
      
      // Check if note is for users (targetAudience is 'all' or 'users')
      if (note.targetAudience === 'all' || note.targetAudience === 'users') {
        // Check if note has expired
        if (note.expiresAt) {
          const expiresAt = new Date(note.expiresAt);
          const now = new Date();
          if (now > expiresAt) {
            // console.log('Note has expired, ignoring:', note.noteId);
            return;
          }
        }
        
        // Add note to state (replace if exists)
        setNotes(prev => {
          const existingIndex = prev.findIndex(n => n.noteId === note.noteId);
          if (existingIndex >= 0) {
            // Update existing note
            const updated = [...prev];
            updated[existingIndex] = note;
            return updated;
          } else {
            // Add new note
            return [note, ...prev];
          }
        });
        
        // Call callback if registered
        if (onNoteReceivedCallbackRef.current) {
          onNoteReceivedCallbackRef.current(note);
        }
      }
    });

    // Receive note deletion notification
    socket.on('note:deleted', (data: { noteId: string }) => {
      // console.log('🗑️ Note deleted:', data.noteId);
      
      // Remove note from state
      setNotes(prev => prev.filter(n => n.noteId !== data.noteId));
      
      // Call callback if registered
      if (onNoteDeletedCallbackRef.current) {
        onNoteDeletedCallbackRef.current(data.noteId);
      }
    });

    // Error events
    socket.on('user:inquiry:create:error', (data: { message: string; code: string }) => {
      console.error('[Socket][OrderInquiry] Create error:', data);
    });

    socket.on('user:general-inquiry:create:error', (data: { message: string; code: string }) => {
      // console.error('General inquiry create error:', data);
    });

    socket.on('user:general-inquiry:message:error', (data: { message: string; code: string }) => {
      // console.error('General inquiry message error:', data);
    });

    socket.on('user:general-inquiry:list:error', (data: { message: string; code: string }) => {
      // console.error('General inquiry list error:', data);
    });

    socket.on('user:general-inquiry:get:error', (data: { message: string; code: string }) => {
      // console.error('General inquiry get error:', data);
    });
  }, []);

  // Remove all listeners
  const removeListeners = useCallback(() => {
    const socket = socketService.getSocket();
    if (!socket) return;

    socket.removeAllListeners('connect');
    socket.removeAllListeners('disconnect');
    // Order inquiry listeners
    socket.removeAllListeners('user:inquiry:subscribe:success');
    socket.removeAllListeners('user:inquiry:unsubscribe:success');
    socket.removeAllListeners('user:inquiry:unread-counts:response');
    socket.removeAllListeners('user:inquiry:message:received');
    socket.removeAllListeners('user:inquiry:messages-read');
    socket.removeAllListeners('user:inquiry:create:success');
    socket.removeAllListeners('user:inquiry:create:error');
    socket.removeAllListeners('user:inquiry:new');
    socket.removeAllListeners('user:inquiry:closed');
    socket.removeAllListeners('user:inquiry:reopened');
    socket.removeAllListeners('inquiry:admin-assigned');
    // General inquiry listeners
    socket.removeAllListeners('user:general-inquiry:subscribe:success');
    socket.removeAllListeners('user:general-inquiry:unsubscribe:success');
    socket.removeAllListeners('user:general-inquiry:unread-counts:response');
    socket.removeAllListeners('user:general-inquiry:unread-count:response');
    socket.removeAllListeners('user:general-inquiry:create:success');
    socket.removeAllListeners('user:general-inquiry:message:success');
    socket.removeAllListeners('user:general-inquiry:get:response');
    socket.removeAllListeners('user:general-inquiry:list:response');
    socket.removeAllListeners('user:general-inquiry:mark-read:success');
    socket.removeAllListeners('user:general-inquiry:close:success');
    socket.removeAllListeners('user:general-inquiry:message:received');
    socket.removeAllListeners('user:general-inquiry:messages-read');
    socket.removeAllListeners('user:general-inquiry:new');
    socket.removeAllListeners('user:general-inquiry:closed');
    socket.removeAllListeners('user:general-inquiry:reopened');
    socket.removeAllListeners('general-inquiry:admin-assigned');
    socket.removeAllListeners('user:general-inquiry:create:error');
    socket.removeAllListeners('user:general-inquiry:message:error');
    socket.removeAllListeners('user:general-inquiry:list:error');
    socket.removeAllListeners('user:general-inquiry:get:error');
    // Note broadcast listeners
    socket.removeAllListeners('note:broadcast');
    socket.removeAllListeners('note:deleted');
    // Order note listeners
    socket.removeAllListeners('user:order-note:received');
    socket.removeAllListeners('user:order-note:confirmed');
  }, []);

  const userId = user?.id ?? user?.email ?? null;

  // Connect on mount and when auth identity changes (not every profile field update).
  useEffect(() => {
    if (isAuthenticated && userId) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      if (!isAuthenticated) {
        disconnect();
        removeListeners();
      }
    };
  }, [isAuthenticated, userId, connect, disconnect, removeListeners]);

  // ─── 인증 직후 초기 미확인 카운트 계산 (앱 첫 기동 시 BottomBar 배지) ──
  //
  // MessageScreen 의 미확인 표시 규칙과 동일한 기준으로 카운트한다:
  //   /inquiries/orders 의 각 row 에서
  //     visitedInquiries 캐시의 visitedAt < row.lastMessageAt
  //     AND status ∈ {open, pending, unconfirmed}
  //   인 항목 수.
  //
  // MessageScreen 이 아직 mount 되지 않은 시점에도 BottomBar 배지가 정확히
  // 표시되도록 SocketContext 가 직접 계산해 setUnreadCount 한다. 그 뒤
  // MessageScreen 이 mount 되면 setUnreadCountOverride 가 동일 규칙으로
  // 다시 push 하므로 값이 일관되게 유지된다.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!isAuthenticated || !userId) return;
      try {
        // 1) visited 캐시 prewarm — isInquiryConfirmedSync 가 sync 조회하려면 필요.
        await prewarmVisitedInquiries();
        // 관리자 읽음 캐시 prewarm — isReadByAdminSync 가 sync 조회하려면 필요.
        await prewarmAdminReadReceipts();
        if (cancelled) return;

        // 2) /inquiries/orders 응답으로 정확한 미확인 카드 수 계산.
        const ordersRes = await inquiryApi.getOrderInquiries().catch(() => null);
        if (cancelled) return;
        if (ordersRes && ordersRes.success && Array.isArray(ordersRes.data?.orders)) {
          const rows = ordersRes.data!.orders;
          const unconfirmed = rows.reduce((acc: number, row: any) => {
            const inquiryId = String(row?.inquiryId || '');
            if (!inquiryId) return acc;
            // 방문 기록의 visitedAt 이 lastMessageAt 이상이면 confirmed → 제외.
            if (isInquiryConfirmedSync(inquiryId, row?.lastMessageAt)) return acc;
            const s = String(row?.status || '').toLowerCase();
            const isUnconfirmed = s === 'open' || s === 'pending' || s === 'unconfirmed';
            return isUnconfirmed ? acc + 1 : acc;
          }, 0);
          setUnreadCount(unconfirmed);
          return;
        }

        // 3) Fallback — 위 endpoint 가 실패하면 단순 합계 endpoint 사용.
        const countRes = await inquiryApi.getUnreadCount().catch(() => null);
        if (cancelled) return;
        if (countRes && countRes.success && countRes.data && typeof countRes.data.count === 'number') {
          setUnreadCount(countRes.data.count);
          return;
        }
        const pluralRes = await inquiryApi.getUnreadCounts().catch(() => null);
        if (cancelled) return;
        if (pluralRes && pluralRes.success && pluralRes.data && typeof pluralRes.data.totalUnread === 'number') {
          setUnreadCount(pluralRes.data.totalUnread);
        }
      } catch {
        /* silent — socket 흐름이 곧 값을 채워줄 것 */
      }
    };
    run();
    return () => { cancelled = true; };
  }, [isAuthenticated, userId]);


  // Event handler registration (for custom callbacks)
  const onInquiryCreated = useCallback((callback: (inquiry: GeneralInquiry) => void) => {
    onInquiryCreatedCallbackRef.current = callback;
  }, []);

  const onMessageReceived = useCallback((callback: (data: { message: SocketMessage; inquiryId: string; unreadCount?: number; totalUnreadCount?: number }) => void) => {
    onMessageReceivedCallbackRef.current = callback;
  }, []);

  const onInquiryUpdated = useCallback((callback: (inquiry: GeneralInquiry) => void) => {
    onInquiryUpdatedCallbackRef.current = callback;
  }, []);

  const onInquiryClosed = useCallback((callback: (inquiryId: string) => void) => {
    onInquiryClosedCallbackRef.current = callback;
  }, []);

  const onMessagesRead = useCallback((callback: (data: { inquiryId: string; readBy: string; readByType: string; readByName: string; readAt: string }) => void) => {
    onMessagesReadCallbackRef.current = callback;
  }, []);

  const onUnreadCountUpdated = useCallback((callback: (count: number) => void) => {
    onUnreadCountUpdatedCallbackRef.current = callback;
  }, []);

  // General Inquiry Event handler registration
  const onGeneralInquiryCreated = useCallback((callback: (inquiry: GeneralInquiry) => void) => {
    onGeneralInquiryCreatedCallbackRef.current = callback;
  }, []);

  const onGeneralInquiryMessageReceived = useCallback((callback: (data: { message: SocketMessage; inquiryId: string; unreadCount?: number; totalUnreadCount?: number }) => void) => {
    onGeneralInquiryMessageReceivedCallbackRef.current = callback;
  }, []);

  const onGeneralInquiryUpdated = useCallback((callback: (inquiry: GeneralInquiry) => void) => {
    onGeneralInquiryUpdatedCallbackRef.current = callback;
  }, []);

  const onGeneralInquiryClosed = useCallback((callback: (inquiryId: string) => void) => {
    onGeneralInquiryClosedCallbackRef.current = callback;
  }, []);

  const onGeneralInquiryMessagesRead = useCallback((callback: (data: { inquiryId: string; readBy: string; readByType: string; readByName: string; readAt: string }) => void) => {
    onGeneralInquiryMessagesReadCallbackRef.current = callback;
  }, []);

  const onGeneralInquiryUnreadCountUpdated = useCallback((callback: (count: number) => void) => {
    onGeneralInquiryUnreadCountUpdatedCallbackRef.current = callback;
  }, []);

  // Note Broadcast Event handlers
  const onNoteReceived = useCallback((callback: (note: BroadcastNote) => void) => {
    onNoteReceivedCallbackRef.current = callback;
  }, []);

  const onNoteDeleted = useCallback((callback: (noteId: string) => void) => {
    onNoteDeletedCallbackRef.current = callback;
  }, []);

  // ── 외부(예: MessageScreen)에서 미확인 카운트를 직접 push 할 수 있는 setter.
  //    화면이 자신이 그리는 카드의 status 를 기준으로 정확한 미확인 건수를 계산해
  //    여기로 전달하면, BottomBar 배지가 즉시 갱신된다.
  //
  //    Override 가 설정된 동안에는 socket 의 `:unread-counts:response` 가
  //    `setUnreadCount` 를 호출해도 외부에 노출되는 값(`unreadCount`)은 override
  //    가 우선이라 변하지 않는다 → 깜박임 제거.
  //    NaN/음수 방어. 음수 전달 시 override 를 해제하는 것이 아니라 0 으로 clamp.
  const setUnreadCountOverride = useCallback((count: number) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    setUnreadCountOverrideState(n);
  }, []);

  const setGeneralInquiryUnreadCountOverride = useCallback((count: number) => {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    setGeneralInquiryUnreadCountOverrideState(n);
  }, []);

  // 노출용 합성 값: override 가 설정되어 있으면 그 값, 아니면 socket 값.
  const effectiveUnreadCount = unreadCountOverride !== null ? unreadCountOverride : unreadCount;
  const effectiveGeneralInquiryUnreadCount =
    generalInquiryUnreadCountOverride !== null ? generalInquiryUnreadCountOverride : generalInquiryUnreadCount;

  // ========== Order Note (주문문의) socket bindings ==========
  const subscribeToOrderNotes = useCallback((orderId: string) => {
    console.log('[Socket][OrderNote] subscribe:', orderId);
    socketService.subscribeToOrderNotes(orderId);
  }, []);

  const unsubscribeFromOrderNotes = useCallback((orderId: string) => {
    console.log('[Socket][OrderNote] unsubscribe:', orderId);
    socketService.unsubscribeFromOrderNotes(orderId);
  }, []);

  const sendOrderNote = useCallback(
    (orderId: string, value: string, extra?: { orderNumber?: string; name?: string }) => {
      console.log('[Socket][OrderNote] send:', { orderId, value: value.substring(0, 40) });
      socketService.sendOrderNote(orderId, value, extra);
    },
    [],
  );

  const confirmOrderNotes = useCallback(
    (orderId: string, extra?: { orderNumber?: string; noteIds?: string[] }) => {
      console.log('[Socket][OrderNote] confirm:', { orderId, noteIds: extra?.noteIds?.length ?? 0 });
      socketService.confirmOrderNotes(orderId, extra);
    },
    [],
  );

  const onOrderNoteReceived = useCallback(
    (callback: (data: OrderNoteEvent) => void) => {
      onOrderNoteReceivedCallbackRef.current = callback;
    },
    [],
  );

  const onOrderNoteConfirmed = useCallback(
    (callback: (data: OrderNoteConfirmedEvent) => void) => {
      onOrderNoteConfirmedCallbackRef.current = callback;
    },
    [],
  );

  const value: SocketContextType = {
    isConnected,
    isConnecting,
    connect,
    disconnect,
    subscribeToInquiry,
    unsubscribeFromInquiry,
    getUnreadCounts,
    createInquiry,
    sendInquiryMessage,
    markInquiryAsRead,
    closeInquiry,
    subscribeToGeneralInquiry,
    unsubscribeFromGeneralInquiry,
    getGeneralInquiryUnreadCounts,
    createGeneralInquiry,
    sendGeneralInquiryMessage,
    markGeneralInquiryAsRead,
    closeGeneralInquiry,
    inquiries,
    currentInquiry,
    // override 가 설정되면 그 값 우선, 아니면 socket 응답값. 깜박임 차단.
    unreadCount: effectiveUnreadCount,
    orderInquiryUnreadById,
    inquiryReadReceiptVersion,
    generalInquiries,
    currentGeneralInquiry,
    generalInquiryUnreadCount: effectiveGeneralInquiryUnreadCount,
    generalInquiryUnreadById,
    onInquiryCreated,
    onMessageReceived,
    onInquiryUpdated,
    onInquiryClosed,
    onMessagesRead,
    onUnreadCountUpdated,
    onGeneralInquiryCreated,
    onGeneralInquiryMessageReceived,
    onGeneralInquiryUpdated,
    onGeneralInquiryClosed,
    onGeneralInquiryMessagesRead,
    onGeneralInquiryUnreadCountUpdated,
    notes,
    onNoteReceived,
    onNoteDeleted,
    // External setters for screen-side computed unread counts
    setUnreadCountOverride,
    setGeneralInquiryUnreadCountOverride,
    // Order note (주문문의)
    subscribeToOrderNotes,
    unsubscribeFromOrderNotes,
    sendOrderNote,
    confirmOrderNotes,
    onOrderNoteReceived,
    onOrderNoteConfirmed,
    removeListeners,
  };

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

export const useSocket = (): SocketContextType => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};


import { WebSocketTransport } from "@/server/transport/websocket-transport";
import { Adb, AdbBanner } from "@yume-chan/adb";
import {
    AndroidKeyCode,
    AndroidKeyEventAction,
    AndroidScreenPowerMode,
    DefaultServerPath,
    ScrcpyVideoCodecId,
    type ScrcpyMediaStreamPacket,
    type ScrcpyMediaStreamDataPacket
} from "@yume-chan/scrcpy";
import type { ScrcpyControlMessageWriter } from "@yume-chan/scrcpy";
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import { WritableStream } from "@yume-chan/stream-extra";
import { AudioManager } from "./AudioManager";
import {
    BitmapVideoFrameRenderer,
    InsertableStreamVideoFrameRenderer,
    type VideoFrameRenderer,
    WebCodecsVideoDecoder,
    WebGLVideoFrameRenderer
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { flushSync } from "react-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { Button } from '../components/ui/button';
import { AlertCircle, ArrowLeft, Home, ChevronLeft, Square, Power, Volume2, VolumeOff, RectangleVertical, MonitorOff, MonitorPlay, Circle, StopCircle, Play, Save, FileText, Trash2, X, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { TouchControl } from './TouchControl';
import { KeyboardControl } from './KeyboardControl';
import type { DeviceResponse, DeviceInfo } from '../types/device.types';
import { isMobileDevice } from '../lib/device-detect';

interface MacroEvent {
    type: 'touch' | 'key' | 'scroll' | 'power' | 'rotate';
    timestamp: number;
    data: any;
}

interface Macro {
    id: number;
    name: string;
    content: string;
    createdAt: string;
}


function createVideoFrameRenderer(): {
    renderer: VideoFrameRenderer;
    element: HTMLVideoElement | HTMLCanvasElement;
} {
    if (InsertableStreamVideoFrameRenderer.isSupported) {
        const renderer = new InsertableStreamVideoFrameRenderer();
        return { renderer, element: renderer.element };
    }

    if (WebGLVideoFrameRenderer.isSupported) {
        const renderer = new WebGLVideoFrameRenderer();
        return { renderer, element: renderer.canvas as HTMLCanvasElement };
    }

    const renderer = new BitmapVideoFrameRenderer();
    return { renderer, element: renderer.canvas as HTMLCanvasElement };
}

export default function DeviceDetail() {
    const { serial } = useParams<{ serial: string }>();
    const navigate = useNavigate();

    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const controllerRef = useRef<ScrcpyControlMessageWriter | null>(null);
    const scrcpyClientRef = useRef<AdbScrcpyClient<AdbScrcpyOptions3_3_3<boolean>>>(null);

    console.log("DEBUG: DeviceDetail mounted - Version MonkeyPatch");

    const isMutedRef = useRef<boolean>(true); // 使用 ref 保存最新的静音状态，避免闭包问题
    const audioManagerRef = useRef<AudioManager | null>(null); // 音频管理器

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string>();
    const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
    const [screenSize, setScreenSize] = useState<{ width: number; height: number }>(); // 物理尺寸（固定，竖屏尺寸）
    const [videoSize, setVideoSize] = useState<{ width: number; height: number }>(); // 视频尺寸（随旋转变化）
    const [isLandscape, setIsLandscape] = useState(false); // 是否为横屏
    const [isVideoLoaded, setIsVideoLoaded] = useState(false);
    const [isMuted, setIsMuted] = useState(true); // 默认静音，等待用户手动激活
    const [audioAvailable, setAudioAvailable] = useState(true); // 音频是否可用
    const [audioError, setAudioError] = useState(false); // 音频是否出错
    const [isMobile, setIsMobile] = useState(false); // 是否为移动设备
    const [isScreenOff, setIsScreenOff] = useState(false);

    // Connection status for auto-reconnect
    type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
    const reconnectAttemptRef = useRef(0);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isTabVisibleRef = useRef(true);
    const isManualDisconnectRef = useRef(false);
    const MAX_RECONNECT_ATTEMPTS = 10;

    // Macro State
    const [isRecording, setIsRecording] = useState(false);
    const [recordedEvents, setRecordedEvents] = useState<MacroEvent[]>([]);
    const [macros, setMacros] = useState<Macro[]>([]);
    const [showMacroList, setShowMacroList] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [newMacroName, setNewMacroName] = useState('');
    const [isPlaying, setIsPlaying] = useState(false);

    // Stats State
    const [stats, setStats] = useState({ bitrate: 0, fps: 0 });
    const bytesCountRef = useRef(0);
    const framesCountRef = useRef(0);

    // Initial stats timer
    useEffect(() => {
        console.log("DEBUG: MOUNTED (useEffect [])");
        const timer = setInterval(() => {
            console.log(`DEBUG: Stats tick. Frames: ${framesCountRef.current}, Bytes: ${bytesCountRef.current}`);
            setStats({
                bitrate: (bytesCountRef.current * 8) / 1_000_000, // Mbps
                fps: framesCountRef.current
            });
            // Reset counters
            bytesCountRef.current = 0;
            framesCountRef.current = 0; // Reset frame count for next second
        }, 1000);
        return () => {
            console.log("DEBUG: UNMOUNTED");
            clearInterval(timer);
        };
    }, []);

    // DEBUG: Log state changes
    useEffect(() => {
        console.log(`[DEBUG] isRecording changed to: ${isRecording}`);
    }, [isRecording]);

    // Debug: Track showSaveDialog state changes
    useEffect(() => {
        console.log(`[DEBUG] showSaveDialog changed to: ${showSaveDialog}`);
    }, [showSaveDialog]);

    // Quality presets
    type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
    const [quality, setQuality] = useState<QualityLevel>('high');
    const qualityPresets: Record<QualityLevel, { bitRate: number; maxFps: number; label: string }> = {
        low: { bitRate: 1_000_000, maxFps: 24, label: 'Low (1Mbps/24fps)' },
        medium: { bitRate: 4_000_000, maxFps: 30, label: 'Medium (4Mbps/30fps)' },
        high: { bitRate: 8_000_000, maxFps: 60, label: 'High (8Mbps/60fps)' },
        ultra: { bitRate: 16_000_000, maxFps: 60, label: 'Ultra (16Mbps/60fps)' }
    };

    const startTimeRef = useRef<number>(0);
    const originalControllerRef = useRef<ScrcpyControlMessageWriter | null>(null);

    // Fetch Macros
    const fetchMacros = async () => {
        try {
            const res = await fetch('/api/macros');
            const data = await res.json();
            setMacros(data);
        } catch (err) {
            console.error("Failed to fetch macros", err);
        }
    };

    useEffect(() => {
        fetchMacros();

        // Auto-detect network quality
        const checkNetworkQuality = async () => {
            try {
                const res = await fetch('/api/devices/network-check');
                if (res.ok) {
                    const { isHome } = await res.json();
                    console.log('Network check:', isHome ? 'Home Network (High Quality)' : 'Remote Network (Low Quality)');
                    setQuality(isHome ? 'high' : 'low');
                }
            } catch (e) {
                console.error("Failed to check network quality, defaulting to low", e);
                setQuality('low');
            }
        };
        checkNetworkQuality();
    }, []);

    // Start Recording
    const startRecording = () => {
        if (!scrcpyClientRef.current?.controller) return;

        // Backup original controller
        originalControllerRef.current = scrcpyClientRef.current.controller;
        const original = originalControllerRef.current;

        setRecordedEvents([]);
        startTimeRef.current = Date.now();
        setIsRecording(true);

        // create interceptor
        const interceptor = Object.create(original);

        interceptor.injectTouch = (msg: any) => {
            setRecordedEvents(prev => [...prev, { type: 'touch', timestamp: Date.now(), data: [msg] }]);
            return original.injectTouch(msg);
        };

        interceptor.injectKeyCode = (msg: any) => {
            setRecordedEvents(prev => [...prev, { type: 'key', timestamp: Date.now(), data: [msg] }]);
            return original.injectKeyCode(msg);
        };

        interceptor.injectScroll = (msg: any) => {
            setRecordedEvents(prev => [...prev, { type: 'scroll', timestamp: Date.now(), data: [msg] }]);
            return original.injectScroll(msg);
        };

        interceptor.setScreenPowerMode = (mode: any) => {
            setRecordedEvents(prev => [...prev, { type: 'power', timestamp: Date.now(), data: [mode] }]);
            return original.setScreenPowerMode(mode);
        };

        interceptor.rotateDevice = () => {
            setRecordedEvents(prev => [...prev, { type: 'rotate', timestamp: Date.now(), data: [] }]);
            return original.rotateDevice();
        };

        // Replace controller
        (scrcpyClientRef.current as any).controller = interceptor;
    };

    // Stop Recording
    const stopRecording = (e?: React.MouseEvent) => {
        console.log("DEBUG: stopRecording ENTER");
        e?.stopPropagation();
        e?.preventDefault();

        console.log("DEBUG: Step 1 - Events count:", recordedEvents.length);

        // Clear the original controller reference (don't try to reassign, it's read-only)
        originalControllerRef.current = null;
        console.log("DEBUG: Step 2 - Controller ref cleared");

        console.log("DEBUG: Step 3 - Calling setIsRecording(false)");
        setIsRecording(false);

        console.log("DEBUG: Step 4 - Calling setNewMacroName");
        setNewMacroName(`Macro ${new Date().toLocaleString()}`);

        console.log("DEBUG: Step 5 - Calling setShowSaveDialog(true)");
        setShowSaveDialog(true);

        console.log("DEBUG: stopRecording EXIT SUCCESS");
    };

    // Save Macro
    const saveMacro = async () => {
        try {
            await fetch('/api/macros', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newMacroName,
                    content: JSON.stringify(recordedEvents, (key, value) =>
                        typeof value === 'bigint' ? value.toString() : value
                    )
                })
            });
            setShowSaveDialog(false);
            fetchMacros();
        } catch (err) {
            console.error("Failed to save macro", err);
        }
    };

    // Delete Macro
    const deleteMacro = async (id: number) => {
        if (!confirm("Delete this macro?")) return;
        try {
            await fetch(`/api/macros/${id}`, { method: 'DELETE' });
            fetchMacros();
        } catch (err) {
            console.error("Failed to delete macro", err);
        }
    };

    // Play Macro
    const playMacro = async (macro: Macro) => {
        console.log("DEBUG: playMacro called for", macro.name);

        // Use controllerRef instead of scrcpyClientRef.current.controller
        if (!controllerRef.current) {
            console.error("DEBUG: playMacro - No controller available");
            return;
        }

        let events: MacroEvent[];
        try {
            events = JSON.parse(macro.content, (key, value) => {
                // Restore BigInt for pointerId and other known 64-bit fields if needed
                if (key === 'pointerId') {
                    return BigInt(value);
                }
                return value;
            }) as MacroEvent[];
        } catch (e) {
            console.error("DEBUG: playMacro - Failed to parse macro content", e);
            return;
        }

        if (events.length === 0) {
            console.log("DEBUG: playMacro - No events to play");
            return;
        }

        console.log("DEBUG: playMacro - Playing", events.length, "events");
        setIsPlaying(true);
        setShowMacroList(false);

        const controller = controllerRef.current;
        const startTime = events[0].timestamp;

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            const delay = event.timestamp - startTime;

            // Wait for the correct time
            if (i > 0) {
                const prevEvent = events[i - 1];
                const waitTime = event.timestamp - prevEvent.timestamp;
                if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
            }

            try {
                console.log("DEBUG: playMacro - Executing event", i, event.type);
                switch (event.type) {
                    case 'touch': await controller.injectTouch(event.data[0]); break;
                    case 'key': await controller.injectKeyCode(event.data[0]); break;
                    case 'scroll': await controller.injectScroll(event.data[0]); break;
                    case 'power': await controller.setScreenPowerMode(event.data[0]); break;
                    case 'rotate': await controller.rotateDevice(); break;
                }
            } catch (e) {
                console.error("DEBUG: playMacro - Execution error at event", i, e);
            }
        }
        console.log("DEBUG: playMacro - Complete");
        setIsPlaying(false);
    };

    const toggleScreenPower = async () => {
        if (!controllerRef.current) return;

        try {
            const newMode = isScreenOff ? AndroidScreenPowerMode.Normal : AndroidScreenPowerMode.Off;
            await controllerRef.current.setScreenPowerMode(newMode);
            setIsScreenOff(!isScreenOff);
        } catch (error) {
            console.error("Failed to toggle screen power:", error);
        }
    };


    // Button handlers
    const handleKeyPress = (keyCode: AndroidKeyCode) => {
        if (!controllerRef.current) {
            console.warn('Controller not initialized');
            return;
        }

        try {
            // Key Down
            controllerRef.current.injectKeyCode({
                action: AndroidKeyEventAction.Down,
                keyCode: keyCode,
                repeat: 0,
                metaState: 0,
            });

            // Key Up
            controllerRef.current.injectKeyCode({
                action: AndroidKeyEventAction.Up,
                keyCode: keyCode,
                repeat: 0,
                metaState: 0,
            });
        } catch (error) {
            console.error('Failed to send key press:', error);
        }
    };

    // --- Disconnect device (cleanup all connections) ---
    const disconnectDevice = useCallback(() => {
        // Cleanup Audio
        audioManagerRef.current?.cleanup();
        audioManagerRef.current = null;

        // Cleanup Scrcpy
        if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
        }

        controllerRef.current = null;
        scrcpyClientRef.current = null;

        if (wrapperRef.current) {
            wrapperRef.current.innerHTML = '';
        }

        // Reset State
        setIsVideoLoaded(false);
        setIsLandscape(false);
        setIsMuted(true);
        isMutedRef.current = true;
        setAudioAvailable(true);
        setAudioError(false);
    }, []);

    // --- Connect device (initialize everything) ---
    const connectDevice = useCallback(async () => {
        if (!serial) {
            setError('Missing Device Serial');
            setIsLoading(false);
            return;
        }

        // Cleanup previous connection first
        disconnectDevice();

        setError(undefined);
        setIsLoading(true);
        setConnectionStatus('connecting');

        try {
            const response = await fetch(`/api/adb/device/${serial}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch device info: ${response.status}`);
            }

            const data: DeviceResponse = await response.json();
            setDeviceInfo(data.info);

            console.log(`Device Info:`, data);
            if (data.info.screen_width && data.info.screen_height) {
                const physicalWidth = Math.min(data.info.screen_width, data.info.screen_height);
                const physicalHeight = Math.max(data.info.screen_width, data.info.screen_height);
                setScreenSize({
                    width: physicalWidth,
                    height: physicalHeight
                });
            }
            setIsLoading(false);

            const transport = new WebSocketTransport(
                serial,
                data.maxPayloadSize,
                new AdbBanner(data.product, data.model, data.device, data.features),
            );

            const adb = new Adb(transport);

            const scrcpy = await AdbScrcpyClient.start(
                adb,
                DefaultServerPath,
                new AdbScrcpyOptions3_3_3({
                    videoBitRate: qualityPresets[quality].bitRate,
                    displayId: 0,
                    maxFps: qualityPresets[quality].maxFps,
                    videoSource: "display",
                    videoCodec: "h264",
                    audio: true,
                    control: true,
                    tunnelForward: true,
                    stayAwake: true,
                    powerOffOnClose: false,
                    powerOn: false,
                    clipboardAutosync: true,
                    sendDeviceMeta: true,
                    cleanup: true
                }),
            );

            // Save references
            scrcpyClientRef.current = scrcpy;
            if (scrcpy.controller) {
                controllerRef.current = scrcpy.controller;
            }

            // Initialize Audio Stream
            const initAudioStream = async () => {
                try {
                    const audioStreamPromise = scrcpy.audioStream;
                    if (!audioStreamPromise) {
                        console.warn(`Device does not support audio stream`);
                        setAudioAvailable(false);
                        return;
                    }

                    const metadata = await audioStreamPromise;
                    if (metadata.type === 'disabled' || metadata.type === 'errored') {
                        console.warn(`Audio unavailable:`, metadata.type);
                        setAudioAvailable(false);
                        if (metadata.type === 'errored') {
                            setAudioError(true);
                        }
                        return;
                    }

                    console.log(`Audio Codec:`, metadata.codec);

                    const audioManager = new AudioManager(isMutedRef);
                    audioManager.initialize(metadata.codec, metadata.codec.webCodecId, metadata.stream);
                    audioManagerRef.current = audioManager;

                    setAudioAvailable(true);
                    setAudioError(false);
                } catch (error: unknown) {
                    const err = error as Error;
                    console.warn(`Audio initialization failed (video unaffected):`, err.message || error);
                    setAudioAvailable(false);
                    setAudioError(true);
                }
            };

            // Start audio init (don't await)
            void initAudioStream();

            const stream = scrcpy.videoStream!;
            stream.then(async ({ stream: originalStream }) => {
                // Create a TransformStream to count bytes for Mbps calculation
                const statsStream = new TransformStream<ScrcpyMediaStreamPacket, ScrcpyMediaStreamPacket>({
                    transform(chunk, controller) {
                        if (chunk.type === 'data' && chunk.data) {
                            bytesCountRef.current += chunk.data.byteLength;
                        }
                        controller.enqueue(chunk);
                    }
                });

                // Create wrapper element for video
                const { renderer: originalRenderer, element } = createVideoFrameRenderer();

                // Wrap Renderer for FPS counting
                const rendererWrapper: VideoFrameRenderer = {
                    draw: (frame: VideoFrame) => {
                        framesCountRef.current++;
                        return originalRenderer.draw(frame);
                    },
                    setSize: (width: number, height: number) => {
                        return originalRenderer.setSize ? originalRenderer.setSize(width, height) : undefined;
                    }
                };

                if (wrapperRef.current) {
                    wrapperRef.current.innerHTML = '';
                    element.style.display = 'block';
                    element.style.width = '100%';
                    element.style.height = '100%';
                    element.style.objectFit = 'contain';
                    wrapperRef.current.appendChild(element);
                }

                const decoder = new WebCodecsVideoDecoder({
                    codec: ScrcpyVideoCodecId.H264,
                    renderer: rendererWrapper,
                });
                setIsVideoLoaded(true);
                setConnectionStatus('connected');
                reconnectAttemptRef.current = 0; // Reset on successful connection

                // Update size and orientation on change
                decoder.sizeChanged(({ width, height }) => {
                    setVideoSize({ width, height });
                    const landscape = width > height;
                    setIsLandscape(landscape);
                });

                // Use measured stream for decoder
                (originalStream as any)
                    .pipeThrough(statsStream as any)
                    .pipeTo(decoder.writable as any)
                    .catch((error: any) => {
                        if (error.name !== 'AbortError' &&
                            !error.message.includes('locked') &&
                            !error.message.includes('closed')) {
                            console.error(`Video stream error:`, error);
                            // Auto-reconnect on stream error
                            if (!isManualDisconnectRef.current && isTabVisibleRef.current) {
                                scheduleReconnect();
                            }
                        }
                    });
            });

            if (scrcpy.clipboard) {
                void scrcpy.clipboard.pipeTo(
                    new WritableStream<string>({
                        write(chunk) {
                            globalThis.navigator.clipboard.writeText(chunk);
                        },
                    }),
                ).catch(err => console.error(`Clipboard error:`, err));
            }

            void scrcpy.output.pipeTo(
                new WritableStream<string>({
                    write(chunk) {
                        console.log(`Output:`, chunk);
                    },
                }),
            );

            // Listen for transport disconnect → trigger reconnect
            transport.disconnected.then(() => {
                console.warn('Transport disconnected');
                if (!isManualDisconnectRef.current && isTabVisibleRef.current) {
                    setConnectionStatus('disconnected');
                    scheduleReconnect();
                }
            });

            cleanupRef.current = () => {
                isManualDisconnectRef.current = true;
                scrcpy.close();
                adb.close();
                transport.close();
            };

        } catch (e) {
            console.error(`Initialization failed:`, e);
            setError(e instanceof Error ? e.message : 'Device connection failed');
            setIsLoading(false);
            setConnectionStatus('disconnected');
            // Auto-reconnect on connection failure
            if (!isManualDisconnectRef.current && isTabVisibleRef.current) {
                scheduleReconnect();
            }
        }
    }, [serial, quality, disconnectDevice]);

    // --- Schedule reconnect with exponential backoff ---
    const scheduleReconnect = useCallback(() => {
        if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) {
            console.error(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
            setConnectionStatus('disconnected');
            setError('Connection lost. Max reconnect attempts reached.');
            return;
        }

        // Clear any existing timer
        if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
        }

        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // 1s, 2s, 4s, 8s, 16s, 30s max
        reconnectAttemptRef.current++;

        console.log(`Reconnecting in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        setConnectionStatus('reconnecting');

        reconnectTimerRef.current = setTimeout(() => {
            if (isTabVisibleRef.current && !isManualDisconnectRef.current) {
                isManualDisconnectRef.current = false;
                connectDevice();
            }
        }, delay);
    }, [connectDevice]);

    // --- Main connection effect ---
    useEffect(() => {
        // Check if mobile device
        setIsMobile(isMobileDevice());
        isManualDisconnectRef.current = false;

        connectDevice();

        return () => {
            isManualDisconnectRef.current = true;
            // Cancel any pending reconnect
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            disconnectDevice();
        };
    }, [serial, quality, connectDevice, disconnectDevice]);

    // --- Tab visibility handler ---
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                // Tab became hidden → disconnect to save bandwidth
                console.log('Tab hidden → disconnecting video stream');
                isTabVisibleRef.current = false;
                isManualDisconnectRef.current = true;
                // Cancel any pending reconnect
                if (reconnectTimerRef.current) {
                    clearTimeout(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                disconnectDevice();
                setConnectionStatus('disconnected');
            } else {
                // Tab became visible → reconnect
                console.log('Tab visible → reconnecting video stream');
                isTabVisibleRef.current = true;
                isManualDisconnectRef.current = false;
                reconnectAttemptRef.current = 0;
                connectDevice();
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, [connectDevice, disconnectDevice]);


    // Toggle Mute
    const toggleMute = () => {
        if (isMuted) {
            // Unmute
            audioManagerRef.current?.start();
            setIsMuted(false);
            isMutedRef.current = false;
        } else {
            // Mute
            audioManagerRef.current?.stop();
            setIsMuted(true);
            isMutedRef.current = true;
        }
    };

    // Rotate Screen
    const rotateScreen = () => {
        if (scrcpyClientRef.current?.controller) {
            scrcpyClientRef.current.controller.rotateDevice();
        }
    };

    /**
     * Get visual size for placeholder
     */
    const getVisualSize = () => {
        return videoSize || screenSize || { width: 0, height: 0 };
    };

    /**
     * Get video wrapper style
     */
    const getVideoWrapperStyle = (): React.CSSProperties => {
        return {
            position: 'absolute',
            inset: 0
        };
    };

    const getTouchRotation = (): number => {
        return 0;
    };

    const getTouchScreenSize = () => {
        return videoSize || screenSize || { width: 0, height: 0 };
    };


    return (
        <div className="h-full flex items-center justify-center p-2 md:p-6">
            <Card className="w-full h-full gap-3">
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate('/')}
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="flex-1">
                            <CardTitle className="flex items-center gap-1">
                                {deviceInfo ? deviceInfo.market_name : serial}
                                {isLoading && <Spinner className="h-4 w-4 text-muted-foreground" />}
                            </CardTitle>
                            <CardDescription className="flex items-center gap-2">
                                <span>{deviceInfo ? `${deviceInfo.model} (${deviceInfo.device})` : serial}</span>
                                <span className={`text-xs px-1.5 py-0.5 rounded font-mono font-bold ${stats.fps > 20 ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                                    {(stats.bitrate || 0).toFixed(1)} Mbps | {stats.fps || 0} FPS
                                </span>
                                {connectionStatus === 'connected' && (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-600 flex items-center gap-1"><Wifi className="h-3 w-3" /> Connected</span>
                                )}
                                {connectionStatus === 'reconnecting' && (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-600 flex items-center gap-1 animate-pulse"><RefreshCw className="h-3 w-3 animate-spin" /> Reconnecting...</span>
                                )}
                                {connectionStatus === 'disconnected' && !error && (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-600 flex items-center gap-1"><WifiOff className="h-3 w-3" /> Disconnected</span>
                                )}
                            </CardDescription>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={rotateScreen}
                            disabled={!isVideoLoaded}
                            title={`Rotate Screen (Current: ${isLandscape ? 'Landscape' : 'Portrait'})`}
                        >
                            <RectangleVertical
                                className="h-4 w-4 transition-transform duration-300"
                                style={{ transform: isLandscape ? 'rotate(90deg)' : 'rotate(0deg)' }}
                            />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleMute}
                            disabled={!audioAvailable}
                            title={
                                !audioAvailable
                                    ? (audioError ? "Audio Error" : "Audio Unavailable")
                                    : (isMuted ? "Unmute" : "Mute")
                            }
                            className={audioError ? "text-destructive hover:text-destructive" : ""}
                        >
                            {isMuted ? <VolumeOff className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                        </Button>

                        {/* Quality Selector */}
                        <div className="relative">
                            <select
                                value={quality}
                                onChange={(e) => setQuality(e.target.value as QualityLevel)}
                                className="h-9 px-2 rounded-md border border-input bg-background text-sm cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
                                title="Video Quality"
                            >
                                {(Object.entries(qualityPresets) as [QualityLevel, typeof qualityPresets[QualityLevel]][]).map(([key, preset]) => (
                                    <option key={key} value={key}>{preset.label}</option>
                                ))}
                            </select>
                        </div>

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleScreenPower}
                            title={isScreenOff ? "Turn Screen On" : "Turn Screen Off"}
                        >
                            {isScreenOff ? <MonitorPlay className="h-4 w-4" /> : <MonitorOff className="h-4 w-4" />}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleKeyPress(AndroidKeyCode.Power)}
                            title="Power"
                        >
                            <Power className="h-4 w-4" />
                        </Button>

                        {/* Macro Controls */}
                        <div className="h-6 w-px bg-border mx-2" />

                        {!isRecording ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={startRecording}
                                title="Record Macro"
                                disabled={!isVideoLoaded || isPlaying}
                            >
                                <Circle className="h-4 w-4 text-red-500 fill-red-500" />
                            </Button>
                        ) : (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={(e) => stopRecording(e)}
                                title="Stop Recording"
                                className="animate-pulse"
                            >
                                <StopCircle className="h-4 w-4 text-red-500" />
                            </Button>
                        )}

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowMacroList(true)}
                            title="Play Macro"
                            disabled={!isVideoLoaded || isRecording || isPlaying}
                        >
                            <Play className="h-4 w-4" />
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="px-2 md:px-6 relative">
                    {error ? (
                        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-8 flex flex-col items-center gap-4">
                            <AlertCircle className="h-8 w-8 text-destructive" />
                            <div className="text-center">
                                <p className="font-medium text-destructive mb-2">Connection Failed</p>
                                <p className="text-sm text-muted-foreground">{error}</p>
                            </div>
                            <Button onClick={() => window.location.reload()} variant="outline">
                                Retry
                            </Button>
                        </div>
                    ) : screenSize && (
                        <div className="flex items-center justify-center">


                            <div className="inline-flex flex-col gap-0">
                                {/* Screen Display Area */}
                                <div
                                    className="canvas-wrapper border-2 border-solid border-black rounded-t-sm overflow-hidden bg-white relative"
                                    style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
                                    onContextMenu={(e) => e.preventDefault()}
                                >
                                    {/* Keyboard Control - disabled when dialogs are open */}
                                    <KeyboardControl client={scrcpyClientRef.current} enabled={isVideoLoaded && !showSaveDialog && !showMacroList} />

                                    <TouchControl
                                        client={scrcpyClientRef.current}
                                        screenWidth={getTouchScreenSize().width}
                                        screenHeight={getTouchScreenSize().height}
                                        rotation={getTouchRotation()}
                                        onTouchEvent={isRecording ? (event) => {
                                            setRecordedEvents(prev => [...prev, { type: 'touch', timestamp: Date.now(), data: [event] }]);
                                        } : undefined}
                                    >
                                        {/* Background SVG Placeholder */}
                                        <svg
                                            width={getVisualSize().width}
                                            height={getVisualSize().height}
                                            style={{
                                                display: 'block',
                                                maxWidth: '100%',
                                                maxHeight: isLandscape ? '60vh' : '70vh',
                                                width: 'auto',
                                                height: 'auto'
                                            }}
                                        />

                                        {/* Video Container */}
                                        <div
                                            ref={wrapperRef}
                                            style={getVideoWrapperStyle()}
                                        />

                                        {/* Loading Spinner */}
                                        {!isVideoLoaded && connectionStatus !== 'reconnecting' && (
                                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                <Spinner className="h-8 w-8 text-black" />
                                            </div>
                                        )}

                                        {/* Reconnecting Overlay */}
                                        {connectionStatus === 'reconnecting' && (
                                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none z-10">
                                                <RefreshCw className="h-10 w-10 text-white animate-spin mb-3" />
                                                <p className="text-white text-sm font-medium">Reconnecting...</p>
                                                <p className="text-white/60 text-xs mt-1">Attempt {reconnectAttemptRef.current}/{MAX_RECONNECT_ATTEMPTS}</p>
                                            </div>
                                        )}
                                    </TouchControl>
                                </div>

                                {/* Android Navigation Bar */}
                                <div className="flex items-center justify-around bg-black/90 border-2 border-t-0 border-black rounded-b-sm w-full">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8 hover:bg-white/10 text-white"
                                        title="Back"
                                        onClick={() => handleKeyPress(AndroidKeyCode.AndroidHome)}
                                    >
                                        <ChevronLeft className="h-6 w-6" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8 hover:bg-white/10 text-white"
                                        title="Home"
                                        onClick={() => handleKeyPress(AndroidKeyCode.AndroidHome)}
                                    >
                                        <Home className="h-5 w-5" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8 hover:bg-white/10 text-white"
                                        title="Recents"
                                        onClick={() => handleKeyPress(AndroidKeyCode.AndroidAppSwitch)}
                                    >
                                        <Square className="h-5 w-5" />
                                    </Button>

                                </div>
                            </div>
                        </div>
                    )}

                </CardContent>
            </Card>

            {/* Macro Save Dialog */}
            {showSaveDialog && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-background border rounded-lg p-6 w-80 shadow-lg" onClick={(e) => e.stopPropagation()}>
                        <h3 className="font-semibold mb-4">Save Macro</h3>
                        <div className="space-y-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Name</label>
                                <input
                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                    value={newMacroName}
                                    onChange={(e) => setNewMacroName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <div className="flex justify-end gap-2">
                                <Button variant="outline" onClick={() => setShowSaveDialog(false)}>Cancel</Button>
                                <Button onClick={saveMacro}>Save</Button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Macro List Dialog */}
            {showMacroList && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-background border rounded-lg p-4 w-96 max-h-[80%] shadow-lg flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-semibold">Saved Macros</h3>
                            <Button variant="ghost" size="icon" onClick={() => setShowMacroList(false)}>
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-2">
                            {macros.length === 0 ? (
                                <div className="text-center text-muted-foreground py-8">No macros saved</div>
                            ) : (
                                macros.map(macro => (
                                    <div key={macro.id} className="flex items-center justify-between p-2 border rounded hover:bg-accent">
                                        <div className="flex-1 min-w-0">
                                            <div className="font-medium truncate">{macro.name}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {new Date(macro.createdAt).toLocaleDateString()}
                                                {' • '}
                                                {JSON.parse(macro.content).length} steps
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button size="icon" variant="ghost" className="h-8 w-8 text-green-500" onClick={() => playMacro(macro)}>
                                                <Play className="h-4 w-4" />
                                            </Button>
                                            <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => deleteMacro(macro.id)}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
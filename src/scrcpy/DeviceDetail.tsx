import { WebSocketTransport } from "@/server/transport/websocket-transport";
import { Adb, AdbBanner } from "@yume-chan/adb";
import {
    AndroidMotionEventAction,
    AndroidKeyCode,
    AndroidKeyEventAction,
    AndroidScreenPowerMode,
    DefaultServerPath,
    ScrcpyPointerId,
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
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { Button } from '../components/ui/button';
import { AlertCircle, ArrowLeft, Home, ChevronLeft, Square, Power, MonitorOff, MonitorPlay, Circle, StopCircle, Play, Save, FileText, Trash2, X, RefreshCw, Pencil, Ellipsis, PauseCircle, Crosshair, Crop } from 'lucide-react';
import { TouchControl } from './TouchControl';
import { KeyboardControl } from './KeyboardControl';
import type { DeviceResponse, DeviceInfo } from '../types/device.types';
import { isMobileDevice } from '../lib/device-detect';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import {
    countExecutableMacroSteps,
    parseMacroScript,
    type MacroScriptCondition,
    type MacroScriptNode,
    type ParsedMacroScript,
} from "@/shared/macro-script";

type DeviceDetailProps = {
    serialOverride?: string;
    embedded?: boolean;
    defaultQuality?: 'low' | 'medium' | 'high' | 'ultra';
    autoQuality?: boolean;
    onLiveTouchEvent?: (payload: {
        serial: string;
        action: number;
        pointerX: number;
        pointerY: number;
        videoWidth: number;
        videoHeight: number;
    }) => void;
    onControlAction?: (payload: {
        serial: string;
        type: 'key' | 'screen_power';
        keyCode?: number;
        screenPowerMode?: number;
    }) => void;
    registerSyncAdapter?: (serial: string, adapter: {
        injectNormalizedTouch: (action: number, normalizedX: number, normalizedY: number) => void;
        triggerControlAction: (payload: { type: 'key' | 'screen_power'; keyCode?: number; screenPowerMode?: number }) => void;
    } | null) => void;
};

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

type StoredMacroContent =
    | { kind: 'events'; events: MacroEvent[] }
    | { kind: 'script'; source: string };

type MacroRunStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed';
type MacroExecutionSignal =
    | { type: "goto"; label: string }
    | { type: "break" }
    | { type: "exit" };

type DevicePowerState = {
    screenOff: boolean;
    screenState: string;
    interactive: boolean | null;
    wakefulness: string | null;
};

type DevicePowerStateResponse = DevicePowerState & {
    success: boolean;
    serial: string;
};

const DEFAULT_DEVICE_POWER_STATE: DevicePowerState = {
    screenOff: false,
    screenState: 'UNKNOWN',
    interactive: null,
    wakefulness: null,
};

function getMacroStepCount(content: string): number {
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return parsed.length;
        }
        if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { format?: unknown }).format === "script" &&
            typeof (parsed as { source?: unknown }).source === "string"
        ) {
            return countExecutableMacroSteps(parseMacroScript(String((parsed as { source: string }).source)));
        }
        return 0;
    } catch {
        return 0;
    }
}

function parseScript(source: string): MacroScriptNode[] {
    return parseMacroScript(source).nodes;
}

function parseStoredMacroContent(content: string): StoredMacroContent {
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return { kind: 'events', events: parsed as MacroEvent[] };
        }
        if (parsed && typeof parsed === "object" && (parsed as { format?: string }).format === "script") {
            const source = String((parsed as { source?: unknown }).source ?? "");
            return { kind: 'script', source };
        }
    } catch {
        // fallback to plain script text
    }
    return { kind: 'script', source: content };
}

function scriptNeedsVideo(nodes: MacroScriptNode[]): boolean {
    for (const node of nodes) {
        if (node.type === 'if') {
            if (node.condition.type === 'image' || node.condition.type === 'pixel') {
                return true;
            }
            if (scriptNeedsVideo(node.thenNodes) || scriptNeedsVideo(node.elseNodes)) {
                return true;
            }
            continue;
        }
        if (node.type === "for_each" && scriptNeedsVideo(node.body)) {
            return true;
        }
    }
    return false;
}

function macroEventsToSimpleScript(events: MacroEvent[]): string {
    if (!Array.isArray(events) || events.length === 0) {
        return "";
    }

    const lines: string[] = [];
    const keyCodeToName = new Map<number, string>([
        [AndroidKeyCode.AndroidHome, "HOME"],
        [AndroidKeyCode.AndroidBack, "BACK"],
        [AndroidKeyCode.Power, "POWER"],
    ]);

    let lastActionTimestamp = events[0].timestamp;
    let strokePoints: Array<{ x: number; y: number; ts: number }> = [];

    const appendWaitIfNeeded = (timestamp: number) => {
        const waitMs = Math.max(0, Math.round(timestamp - lastActionTimestamp));
        if (waitMs > 0) {
            lines.push(`WAIT ${waitMs}`);
        }
    };

    const flushStrokeAsCommand = (forceTap = false) => {
        if (strokePoints.length === 0) {
            return;
        }

        const first = strokePoints[0];
        const last = strokePoints[strokePoints.length - 1];
        appendWaitIfNeeded(first.ts);

        const dx = Math.abs(last.x - first.x);
        const dy = Math.abs(last.y - first.y);
        const moved = dx + dy >= 6;
        if (forceTap || !moved) {
            lines.push(`TAP ${Math.round(first.x)} ${Math.round(first.y)}`);
        } else {
            const simplified: Array<{ x: number; y: number; ts: number }> = [];
            const MIN_SEGMENT_DIST = 4;
            const MIN_SEGMENT_TIME = 20;
            const MAX_POINTS = 28;
            for (const point of strokePoints) {
                const prev = simplified[simplified.length - 1];
                if (!prev) {
                    simplified.push(point);
                    continue;
                }
                const dist = Math.hypot(point.x - prev.x, point.y - prev.y);
                const dt = point.ts - prev.ts;
                if (dist >= MIN_SEGMENT_DIST || dt >= MIN_SEGMENT_TIME) {
                    simplified.push(point);
                }
            }
            const tail = strokePoints[strokePoints.length - 1];
            const lastSimplified = simplified[simplified.length - 1];
            if (!lastSimplified || lastSimplified.ts !== tail.ts) {
                simplified.push(tail);
            }

            // Downsample very dense gestures while preserving the full path.
            if (simplified.length > MAX_POINTS) {
                const reduced: Array<{ x: number; y: number; ts: number }> = [];
                const step = (simplified.length - 1) / (MAX_POINTS - 1);
                for (let i = 0; i < MAX_POINTS; i++) {
                    reduced.push(simplified[Math.round(i * step)]);
                }
                reduced[reduced.length - 1] = simplified[simplified.length - 1];
                simplified.splice(0, simplified.length, ...reduced);
            }

            for (let i = 1; i < simplified.length; i++) {
                const a = simplified[i - 1];
                const b = simplified[i];
                const duration = Math.max(16, Math.min(220, Math.round(b.ts - a.ts)));
                lines.push(
                    `DRAG ${Math.round(a.x)} ${Math.round(a.y)} ${Math.round(b.x)} ${Math.round(b.y)} ${duration}`,
                );
            }
        }
        lastActionTimestamp = last.ts;
        strokePoints = [];
    };

    for (const event of events) {
        if (event.type === "touch") {
            const payload = (event.data?.[0] ?? {}) as Record<string, unknown>;
            const action = Number(payload.action);
            const x = Number(payload.pointerX ?? payload.x);
            const y = Number(payload.pointerY ?? payload.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }

            if (action === AndroidMotionEventAction.Down) {
                flushStrokeAsCommand(true);
                strokePoints = [{ x, y, ts: event.timestamp }];
                continue;
            }

            if (action === AndroidMotionEventAction.Move || action === AndroidMotionEventAction.HoverMove) {
                if (strokePoints.length > 0) {
                    strokePoints.push({ x, y, ts: event.timestamp });
                }
                continue;
            }

            if (action === AndroidMotionEventAction.Up || action === AndroidMotionEventAction.HoverExit) {
                if (strokePoints.length > 0) {
                    strokePoints.push({ x, y, ts: event.timestamp });
                    flushStrokeAsCommand();
                }
            }
            continue;
        }

        if (event.type === "key") {
            const payload = (event.data?.[0] ?? {}) as Record<string, unknown>;
            const action = Number(payload.action);
            const keyCode = Number(payload.keyCode);
            const keyName = keyCodeToName.get(keyCode);
            if (action === AndroidKeyEventAction.Down && keyName) {
                flushStrokeAsCommand(true);
                appendWaitIfNeeded(event.timestamp);
                lines.push(`KEY ${keyName}`);
                lastActionTimestamp = event.timestamp;
            }
        }
    }

    flushStrokeAsCommand(true);

    return lines.join("\n");
}

function extractSimpleScript(content: string): string {
    try {
        const parsed = JSON.parse(content);
        if (
            parsed &&
            typeof parsed === "object" &&
            (parsed as { format?: unknown }).format === "script" &&
            typeof (parsed as { source?: unknown }).source === "string"
        ) {
            return String((parsed as { source: string }).source);
        }

        if (Array.isArray(parsed)) {
            return macroEventsToSimpleScript(parsed as MacroEvent[]);
        }
    } catch {
        // Keep backward compatibility for older plain text scripts.
    }

    return content;
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

export default function DeviceDetail({
    serialOverride,
    embedded = false,
    defaultQuality = 'high',
    autoQuality = true,
    onLiveTouchEvent,
    onControlAction,
    registerSyncAdapter,
}: DeviceDetailProps = {}) {
    const routeParams = useParams<{ serial: string }>();
    const serial = serialOverride ?? routeParams.serial;
    const navigate = useNavigate();
    const isLikelyIpv4WithoutPort = typeof serial === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(serial);

    useEffect(() => {
        if (serial) {
            localStorage.setItem("macro_editor_last_device_serial", serial);
        }
    }, [serial]);

    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const controllerRef = useRef<ScrcpyControlMessageWriter | null>(null);
    const scrcpyClientRef = useRef<AdbScrcpyClient<AdbScrcpyOptions3_3_3<boolean>>>(null);


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
    const [devicePowerState, setDevicePowerState] = useState<DevicePowerState>(DEFAULT_DEVICE_POWER_STATE);

    // Connection status for auto-reconnect
    type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
    const reconnectAttemptRef = useRef(0);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isTabVisibleRef = useRef(true);
    const isManualDisconnectRef = useRef(false);
    const stallCountRef = useRef(0);
    const scheduleReconnectRef = useRef<() => void>(() => { });
    const STALL_THRESHOLD = 12; // seconds without frames before triggering reconnect
    const MAX_RECONNECT_ATTEMPTS = 10;

    // Macro State
    const [isRecording, setIsRecording] = useState(false);
    const [macros, setMacros] = useState<Macro[]>([]);
    const [showMacroList, setShowMacroList] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [newMacroName, setNewMacroName] = useState('');
    const [isPlaying, setIsPlaying] = useState(false);
    const [activeMacroRunId, setActiveMacroRunId] = useState<string | null>(null);
    const [activeMacroRunStatus, setActiveMacroRunStatus] = useState<MacroRunStatus | null>(null);
    const [activeMacroRunMessage, setActiveMacroRunMessage] = useState('');
    const [showEditDialog, setShowEditDialog] = useState(false);
    const [editingMacroId, setEditingMacroId] = useState<number | null>(null);
    const [editMacroName, setEditMacroName] = useState('');
    const [editMacroScript, setEditMacroScript] = useState('');
    const [isFrameFrozen, setIsFrameFrozen] = useState(false);
    const [frozenFrameDataUrl, setFrozenFrameDataUrl] = useState<string | null>(null);
    const [frozenFrameSize, setFrozenFrameSize] = useState<{ width: number; height: number } | null>(null);
    const [inspectorMode, setInspectorMode] = useState<'pixel' | 'crop'>('pixel');
    const [pixelInfo, setPixelInfo] = useState<{ x: number; y: number; color: string } | null>(null);
    const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
    const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const [croppedImageDataUrl, setCroppedImageDataUrl] = useState<string | null>(null);
    const [savedCropImageUrl, setSavedCropImageUrl] = useState<string | null>(null);
    const [showImageSaveDialog, setShowImageSaveDialog] = useState(false);
    const [cropImageName, setCropImageName] = useState("");
    const uiOverlayOpenRef = useRef(false);

    // Stats State
    const [stats, setStats] = useState({ bitrate: 0, fps: 0 });
    const bytesCountRef = useRef(0);
    const framesCountRef = useRef(0);

    useEffect(() => {
        uiOverlayOpenRef.current = showMacroList || showEditDialog || showImageSaveDialog || showSaveDialog;
    }, [showMacroList, showEditDialog, showImageSaveDialog, showSaveDialog]);

    // Initial stats timer + stall detection
    useEffect(() => {
        const timer = setInterval(() => {
            const currentFps = framesCountRef.current;
            const currentBytes = bytesCountRef.current;

            setStats({
                bitrate: (currentBytes * 8) / 1_000_000, // Mbps
                fps: currentFps
            });

            const now = Date.now();
            const secondsSinceLastFrame = (now - lastFrameAtRef.current) / 1000;
            const secondsSinceConnected = connectedAtRef.current > 0 ? (now - connectedAtRef.current) / 1000 : 0;

            // Stall detection: reconnect only after a longer no-frame window to reduce false positives.
            setConnectionStatus(prevStatus => {
                if (
                    prevStatus === 'connected' &&
                    isVideoLoaded &&
                    currentFps === 0 &&
                    currentBytes === 0 &&
                    !uiOverlayOpenRef.current &&
                    !macroEditorBusyRef.current &&
                    secondsSinceConnected >= 15
                ) {
                    stallCountRef.current = Math.max(stallCountRef.current + 1, Math.floor(secondsSinceLastFrame));
                    if (secondsSinceLastFrame >= STALL_THRESHOLD) {
                        console.warn(`Video stall detected (${secondsSinceLastFrame.toFixed(1)}s without frames). Triggering reconnect...`);
                        stallCountRef.current = 0;
                        // Schedule reconnect on next tick to avoid state update conflicts
                        setTimeout(() => {
                            if (!isManualDisconnectRef.current && isTabVisibleRef.current) {
                                scheduleReconnectRef.current();
                            }
                        }, 0);
                        return 'disconnected';
                    }
                } else {
                    stallCountRef.current = 0;
                }
                return prevStatus;
            });

            // Reset counters
            bytesCountRef.current = 0;
            framesCountRef.current = 0;
        }, 1000);
        return () => clearInterval(timer);
    }, [isVideoLoaded]);

    // Quality presets
    type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
    const [quality, setQuality] = useState<QualityLevel>(defaultQuality);
    const [isAutoQualityResolved, setIsAutoQualityResolved] = useState(!autoQuality);
    const qualityPresets: Record<QualityLevel, { bitRate: number; maxFps: number; label: string }> = {
        low: { bitRate: 1_000_000, maxFps: 24, label: 'Low (1Mbps/24fps)' },
        medium: { bitRate: 4_000_000, maxFps: 30, label: 'Medium (4Mbps/30fps)' },
        high: { bitRate: 8_000_000, maxFps: 60, label: 'High (8Mbps/60fps)' },
        ultra: { bitRate: 16_000_000, maxFps: 60, label: 'Ultra (16Mbps/60fps)' }
    };

    const startTimeRef = useRef<number>(0);
    const originalControllerRef = useRef<ScrcpyControlMessageWriter | null>(null);
    const recordingEnabledRef = useRef(false);
    const recordedEventsRef = useRef<MacroEvent[]>([]);
    const didAutoScreenOffRef = useRef(false);
    const playbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const frozenCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const frozenOverlayRef = useRef<HTMLDivElement | null>(null);
    const templateBestScaleRef = useRef<Map<string, number>>(new Map());
    const macroEditorBusyRef = useRef(false);
    const deferredReconnectRef = useRef(false);
    const connectDeviceRef = useRef<() => void | Promise<void>>(() => { });
    const lastFrameAtRef = useRef<number>(Date.now());
    const connectedAtRef = useRef<number>(0);
    const qualitySwitchPendingRef = useRef(false);
    const lastImageMatchRef = useRef<{ x: number; y: number; centerX: number; centerY: number; width: number; height: number; confidence: number; scale: number } | null>(null);
    const lastScriptConditionDebugRef = useRef<string | null>(null);
    const syncTouchQueueRef = useRef<Promise<void>>(Promise.resolve());
    const latestTouchSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
    const powerStateRequestRef = useRef(0);

    const refreshDevicePowerState = useCallback(async (options?: {
        retries?: number;
        delayMs?: number;
        silent?: boolean;
    }): Promise<DevicePowerStateResponse | null> => {
        if (!serial) {
            return null;
        }

        const retries = options?.retries ?? 0;
        const delayMs = options?.delayMs ?? 150;
        const silent = options?.silent ?? false;
        const requestId = ++powerStateRequestRef.current;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetch(`/api/adb/device/${encodeURIComponent(serial)}/power-state`);
                if (!response.ok) {
                    const payload = await response.json().catch(() => null) as { error?: string } | null;
                    throw new Error(payload?.error || `Failed to fetch power state (${response.status})`);
                }

                const payload = await response.json() as DevicePowerStateResponse;
                if (requestId === powerStateRequestRef.current) {
                    setDevicePowerState({
                        screenOff: Boolean(payload.screenOff),
                        screenState: payload.screenState || 'UNKNOWN',
                        interactive: typeof payload.interactive === 'boolean' ? payload.interactive : null,
                        wakefulness: typeof payload.wakefulness === 'string' ? payload.wakefulness : null,
                    });
                }
                return payload;
            } catch (error) {
                if (attempt >= retries) {
                    if (!silent) {
                        console.warn('Failed to refresh device power state:', error);
                    }
                    return null;
                }
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }

        return null;
    }, [serial]);

    const restoreOriginalController = () => {
        recordingEnabledRef.current = false;
        const originalController = originalControllerRef.current;
        if (!originalController) {
            return;
        }
        if (scrcpyClientRef.current) {
            (scrcpyClientRef.current as any).controller = originalController;
        }
        controllerRef.current = originalController;
        originalControllerRef.current = null;
    };

    const appendRecordedEvent = (type: MacroEvent['type'], payload: unknown) => {
        if (!recordingEnabledRef.current) {
            return;
        }
        const data = Array.isArray(payload) ? payload : [payload];
        recordedEventsRef.current.push({
            type,
            timestamp: Date.now(),
            data,
        });
    };

    useEffect(() => {
        latestTouchSizeRef.current = videoSize || screenSize || { width: 0, height: 0 };
    }, [videoSize, screenSize]);

    // Fetch Macros
    const fetchMacros = async () => {
        try {
            const res = await fetch('/api/macros');
            if (!res.ok) {
                throw new Error(`Fetch macros failed with status ${res.status}`);
            }
            const data = await res.json();
            setMacros(data);
        } catch (err) {
            console.error("Failed to fetch macros", err);
        }
    };

    useEffect(() => {
        fetchMacros();

        if (!autoQuality) {
            setQuality(defaultQuality);
            setIsAutoQualityResolved(true);
            return;
        }

        // Auto-detect network quality
        const checkNetworkQuality = async () => {
            const browserHostname = window.location.hostname.trim().toLowerCase();
            const isLocalHostname = browserHostname === 'localhost' || browserHostname.startsWith('192.168.50.');

            if (isLocalHostname) {
                setQuality('ultra');
                setIsAutoQualityResolved(true);
                return;
            }

            try {
                const res = await fetch('/api/devices/network-check');
                if (res.ok) {
                    const { isHome } = await res.json();
                    setQuality(isHome ? 'ultra' : 'low');
                }
            } catch (e) {
                console.error("Failed to check network quality, defaulting to low", e);
                setQuality('low');
            } finally {
                setIsAutoQualityResolved(true);
            }
        };
        checkNetworkQuality();
    }, [autoQuality, defaultQuality]);

    // Start Recording
    const startRecording = () => {
        // Ensure control channel is ready before recording.
        if (!controllerRef.current && !scrcpyClientRef.current?.controller) {
            alert("Control channel is not ready yet. Please wait for device to finish connecting.");
            return;
        }

        recordedEventsRef.current = [];
        startTimeRef.current = Date.now();
        setIsRecording(true);
        recordingEnabledRef.current = true;
    };

    const persistMacro = async (name: string, events: MacroEvent[]) => {
        const script = macroEventsToSimpleScript(events);
        const res = await fetch('/api/macros', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                content: JSON.stringify({
                    format: 'script',
                    source: script,
                }),
            })
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => null) as { error?: string } | null;
            throw new Error(errData?.error || `Failed to save macro (${res.status})`);
        }
    };

    // Stop Recording
    const stopRecording = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        e?.preventDefault();
        const autoName = `Macro ${new Date().toLocaleString()}`;
        const eventsSnapshot = [...recordedEventsRef.current];
        setIsRecording(false);
        recordingEnabledRef.current = false;
        setNewMacroName(autoName);
        setShowSaveDialog(false);
        void (async () => {
            try {
                await persistMacro(autoName, eventsSnapshot);
                await fetchMacros();
            } catch (err) {
                console.error("Failed to auto-save macro", err);
                alert(err instanceof Error ? err.message : "Failed to auto-save macro");
                setShowSaveDialog(true);
            }
        })();
    };

    const toggleRecording = (e?: React.MouseEvent) => {
        if (recordingEnabledRef.current || isRecording) {
            stopRecording(e);
            return;
        }
        startRecording();
    };

    // Save Macro
    const saveMacro = async () => {
        try {
            const eventsSnapshot = [...recordedEventsRef.current];
            await persistMacro(newMacroName, eventsSnapshot);
            setShowSaveDialog(false);
            fetchMacros();
        } catch (err) {
            console.error("Failed to save macro", err);
            alert(err instanceof Error ? err.message : "Failed to save macro");
        }
    };

    // Delete Macro
    const deleteMacro = async (id: number) => {
        if (!confirm("Delete this macro?")) return;
        try {
            const res = await fetch(`/api/macros/${id}`, { method: 'DELETE' });
            if (!res.ok) {
                const errData = await res.json().catch(() => null) as { error?: string } | null;
                throw new Error(errData?.error || `Failed to delete macro (${res.status})`);
            }
            fetchMacros();
        } catch (err) {
            console.error("Failed to delete macro", err);
            alert(err instanceof Error ? err.message : "Failed to delete macro");
        }
    };

    const openEditMacro = (macro: Macro) => {
        setEditingMacroId(macro.id);
        setEditMacroName(macro.name);
        setEditMacroScript(extractSimpleScript(macro.content));
        setShowEditDialog(true);
    };

    const updateMacro = async () => {
        if (!editingMacroId) return;
        const trimmedName = editMacroName.trim();
        if (!trimmedName) {
            alert("Macro name cannot be empty");
            return;
        }

        try {
            parseScript(editMacroScript);
        } catch (scriptError) {
            alert(scriptError instanceof Error ? scriptError.message : "Invalid script");
            return;
        }

        const contentPayload = JSON.stringify({
            format: 'script',
            source: editMacroScript,
        });

        try {
            const res = await fetch(`/api/macros/${editingMacroId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: trimmedName,
                    content: contentPayload,
                }),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null) as { error?: string } | null;
                throw new Error(errData?.error || `Failed to update macro (${res.status})`);
            }
            setShowEditDialog(false);
            setEditingMacroId(null);
            await fetchMacros();
        } catch (err) {
            console.error("Failed to update macro", err);
            alert(err instanceof Error ? err.message : "Failed to update macro");
        }
    };

    const getFrameSourceElement = () => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return null;
        const source = wrapper.querySelector("canvas,video");
        if (!source) return null;
        return source as HTMLCanvasElement | HTMLVideoElement;
    };

    const captureFramePngDataUrl = (): string | null => {
        const source = getFrameSourceElement();
        if (!source) return null;

        const width = source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
        const height = source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
        if (!width || !height) return null;

        if (!playbackCanvasRef.current) {
            playbackCanvasRef.current = document.createElement("canvas");
        }
        const canvas = playbackCanvasRef.current;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(source, 0, 0, width, height);
        return canvas.toDataURL("image/png");
    };

    useEffect(() => {
        const processMacroEditorPayload = (payload: any) => {
            if (!payload || typeof payload !== "object") {
                return;
            }
            if (payload.serial && payload.serial !== serial) {
                return;
            }

            if (payload.type === "macro-editor:image-test-start") {
                macroEditorBusyRef.current = true;
                deferredReconnectRef.current = false;
                return;
            }

            if (payload.type === "macro-editor:image-test-end") {
                finishMacroEditorBusy();
                return;
            }

            if (payload.type === "macro-editor:test-script") {
                const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
                const source = typeof payload.source === "string" ? payload.source : "";

                void (async () => {
                    macroEditorBusyRef.current = true;
                    deferredReconnectRef.current = false;
                    try {
                        lastScriptConditionDebugRef.current = null;
                        lastImageMatchRef.current = null;
                        const parsedScript = parseMacroScript(source);
                        const needsVideo = scriptNeedsVideo(parsedScript.nodes);
                        const startedAt = Date.now();
                        while (
                            (!controllerRef.current || (needsVideo && !captureFramePngDataUrl())) &&
                            Date.now() - startedAt < 15000
                        ) {
                            await new Promise((resolve) => setTimeout(resolve, 250));
                        }
                        if (!controllerRef.current) {
                            throw new Error("Live Device controller is not ready");
                        }
                        if (needsVideo && !captureFramePngDataUrl()) {
                            throw new Error("Live Device video is not ready");
                        }

                        lastImageMatchRef.current = null;
                        setIsPlaying(true);
                        await executeParsedScript(parsedScript, controllerRef.current);
                        emitMacroEditorEvent("macro-editor:test-script-result", {
                            requestId,
                            serial: serial ?? "",
                            success: true,
                            message: lastScriptConditionDebugRef.current ?? "Script test completed",
                        });
                    } catch (error) {
                        emitMacroEditorEvent("macro-editor:test-script-result", {
                            requestId,
                            serial: serial ?? "",
                            success: false,
                            error: error instanceof Error ? error.message : "Script test failed",
                            message: lastScriptConditionDebugRef.current ?? undefined,
                        });
                    } finally {
                        setIsPlaying(false);
                        finishMacroEditorBusy();
                    }
                })();
                return;
            }

            if (payload.type !== "macro-editor:capture-frame") {
                return;
            }

            const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
            const dataUrl = captureFramePngDataUrl();
            emitMacroEditorEvent("macro-editor:capture-frame-result", {
                requestId,
                serial: serial ?? "",
                dataUrl,
                error: dataUrl ? undefined : "Live Device frame is not ready yet",
            });
        };

        const handleParentMessage = (event: MessageEvent) => {
            if (embedded) {
                return;
            }
            if (event.origin !== window.location.origin) {
                return;
            }
            if (event.source !== window.parent) {
                return;
            }
            processMacroEditorPayload(event.data);
        };

        const handleEmbeddedEvent = (event: Event) => {
            if (!embedded) {
                return;
            }
            processMacroEditorPayload((event as CustomEvent).detail);
        };

        const handleMultiDeviceSyncTouch = (event: Event) => {
            const detail = (event as CustomEvent).detail as {
                targetSerial?: string;
                normalizedX?: number;
                normalizedY?: number;
                action?: number;
            } | null;

            if (!detail || detail.targetSerial !== serial || !controllerRef.current) {
                return;
            }

            const action = Number(detail.action);
            if (action !== AndroidMotionEventAction.Down && action !== AndroidMotionEventAction.Up) {
                return;
            }

            const logicalSize = getTouchScreenSize();
            const normalizedX = Math.max(0, Math.min(1, Number(detail.normalizedX ?? 0)));
            const normalizedY = Math.max(0, Math.min(1, Number(detail.normalizedY ?? 0)));
            const x = Math.round((logicalSize.width || 1) * normalizedX);
            const y = Math.round((logicalSize.height || 1) * normalizedY);

            syncTouchQueueRef.current = syncTouchQueueRef.current
                .catch(() => undefined)
                .then(() => injectTouchActionAt(action, x, y, controllerRef.current!));
        };

        const handleMultiDeviceSyncControl = (event: Event) => {
            const detail = (event as CustomEvent).detail as {
                targetSerial?: string;
                type?: 'key' | 'screen_power';
                keyCode?: number;
                screenPowerMode?: number;
            } | null;

            if (!detail || detail.targetSerial !== serial) {
                return;
            }

            if (detail.type === 'key' && controllerRef.current && typeof detail.keyCode === 'number') {
                void performKeyPress(detail.keyCode as AndroidKeyCode, false);
                return;
            }

            if (detail.type === 'screen_power' && typeof detail.screenPowerMode === 'number') {
                void applyScreenPowerMode(detail.screenPowerMode as AndroidScreenPowerMode, false);
            }
        };

        window.addEventListener("message", handleParentMessage);
        window.addEventListener("macro-editor:image-test-start", handleEmbeddedEvent as EventListener);
        window.addEventListener("macro-editor:image-test-end", handleEmbeddedEvent as EventListener);
        window.addEventListener("macro-editor:test-script", handleEmbeddedEvent as EventListener);
        window.addEventListener("macro-editor:capture-frame", handleEmbeddedEvent as EventListener);
        window.addEventListener("multi-device:sync-touch", handleMultiDeviceSyncTouch as EventListener);
        window.addEventListener("multi-device:sync-control", handleMultiDeviceSyncControl as EventListener);
        return () => {
            window.removeEventListener("message", handleParentMessage);
            window.removeEventListener("macro-editor:image-test-start", handleEmbeddedEvent as EventListener);
            window.removeEventListener("macro-editor:image-test-end", handleEmbeddedEvent as EventListener);
            window.removeEventListener("macro-editor:test-script", handleEmbeddedEvent as EventListener);
            window.removeEventListener("macro-editor:capture-frame", handleEmbeddedEvent as EventListener);
            window.removeEventListener("multi-device:sync-touch", handleMultiDeviceSyncTouch as EventListener);
            window.removeEventListener("multi-device:sync-control", handleMultiDeviceSyncControl as EventListener);
        };
    }, [embedded, serial, isVideoLoaded]);

    const mapClientToFrozenPixel = (clientX: number, clientY: number): { x: number; y: number } | null => {
        const overlay = frozenOverlayRef.current;
        if (!overlay || !frozenFrameSize) {
            return null;
        }
        const rect = overlay.getBoundingClientRect();
        const scale = Math.min(rect.width / frozenFrameSize.width, rect.height / frozenFrameSize.height);
        const drawW = frozenFrameSize.width * scale;
        const drawH = frozenFrameSize.height * scale;
        const offsetX = (rect.width - drawW) / 2;
        const offsetY = (rect.height - drawH) / 2;

        const px = (clientX - rect.left - offsetX) / scale;
        const py = (clientY - rect.top - offsetY) / scale;
        if (px < 0 || py < 0 || px >= frozenFrameSize.width || py >= frozenFrameSize.height) {
            return null;
        }
        return { x: Math.floor(px), y: Math.floor(py) };
    };

    const freezeCurrentFrame = () => {
        const source = getFrameSourceElement();
        if (!source) {
            alert("Frame source not ready");
            return;
        }
        const width = source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
        const height = source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
        if (!width || !height) {
            alert("Frame is empty");
            return;
        }

        if (!frozenCanvasRef.current) {
            frozenCanvasRef.current = document.createElement("canvas");
        }
        const canvas = frozenCanvasRef.current;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
            alert("Cannot access frame context");
            return;
        }
        ctx.drawImage(source, 0, 0, width, height);
        setFrozenFrameDataUrl(canvas.toDataURL("image/png"));
        setFrozenFrameSize({ width, height });
        setPixelInfo(null);
        setCropRect(null);
        setCropStart(null);
        setCroppedImageDataUrl(null);
        setSavedCropImageUrl(null);
        setShowImageSaveDialog(false);
        setInspectorMode('pixel');
        setIsFrameFrozen(true);
    };

    const unfreezeFrame = () => {
        setIsFrameFrozen(false);
        setFrozenFrameDataUrl(null);
        setFrozenFrameSize(null);
        setPixelInfo(null);
        setCropRect(null);
        setCropStart(null);
        setCroppedImageDataUrl(null);
        setSavedCropImageUrl(null);
        setShowImageSaveDialog(false);
    };

    const pickFrozenPixel = (clientX: number, clientY: number) => {
        const point = mapClientToFrozenPixel(clientX, clientY);
        const canvas = frozenCanvasRef.current;
        if (!point || !canvas) {
            return;
        }
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
            return;
        }
        const data = ctx.getImageData(point.x, point.y, 1, 1).data;
        const color = `#${data[0].toString(16).padStart(2, "0")}${data[1].toString(16).padStart(2, "0")}${data[2].toString(16).padStart(2, "0")}`.toUpperCase();
        setPixelInfo({ x: point.x, y: point.y, color });
    };

    const updateCropRect = (from: { x: number; y: number }, to: { x: number; y: number }) => {
        setCropRect({
            x: Math.min(from.x, to.x),
            y: Math.min(from.y, to.y),
            width: Math.max(1, Math.abs(to.x - from.x)),
            height: Math.max(1, Math.abs(to.y - from.y)),
        });
        setSavedCropImageUrl(null);
    };

    const finalizeCropImage = () => {
        if (!cropRect || !frozenCanvasRef.current) {
            return;
        }
        const src = frozenCanvasRef.current;
        const out = document.createElement("canvas");
        out.width = cropRect.width;
        out.height = cropRect.height;
        const outCtx = out.getContext("2d");
        if (!outCtx) {
            return;
        }
        outCtx.drawImage(
            src,
            cropRect.x,
            cropRect.y,
            cropRect.width,
            cropRect.height,
            0,
            0,
            cropRect.width,
            cropRect.height
        );
        setCroppedImageDataUrl(out.toDataURL("image/png"));
        setSavedCropImageUrl(null);
    };

    const openSaveCropImageDialog = () => {
        if (!croppedImageDataUrl) {
            return;
        }
        const defaultName = `template-${Date.now()}.png`;
        setCropImageName(defaultName);
        setShowImageSaveDialog(true);
    };

    const saveCroppedImage = async () => {
        if (!croppedImageDataUrl) {
            alert("No cropped image to save");
            return;
        }

        const trimmedName = cropImageName.trim();
        if (!trimmedName) {
            alert("Please input image name");
            return;
        }

        try {
            const response = await fetch("/api/macros/assets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: trimmedName,
                    dataUrl: croppedImageDataUrl,
                    region: cropRect && frozenFrameSize
                        ? (() => {
                            const logicalSize = getTouchScreenSize();
                            const baseWidth = logicalSize.width || frozenFrameSize.width;
                            const baseHeight = logicalSize.height || frozenFrameSize.height;
                            return {
                                x: Math.max(0, Math.round((cropRect.x / frozenFrameSize.width) * baseWidth)),
                                y: Math.max(0, Math.round((cropRect.y / frozenFrameSize.height) * baseHeight)),
                                width: Math.max(1, Math.round((cropRect.width / frozenFrameSize.width) * baseWidth)),
                                height: Math.max(1, Math.round((cropRect.height / frozenFrameSize.height) * baseHeight)),
                            };
                        })()
                        : undefined,
                }),
            });

            const data = await response.json().catch(() => null) as { error?: string; url?: string; name?: string } | null;
            if (!response.ok) {
                throw new Error(data?.error || `Failed to save image (${response.status})`);
            }

            if (data?.url) {
                setSavedCropImageUrl(data.url);
            }
            const refreshAt = String(Date.now());
            localStorage.setItem("macro_assets_refresh_at", refreshAt);
            try {
                window.parent?.postMessage({ type: "macro-assets-updated", refreshAt }, window.location.origin);
            } catch {
                // Ignore postMessage failures.
            }
            window.dispatchEvent(new CustomEvent("macro-assets-updated", { detail: { refreshAt } }));
            try {
                const channel = new BroadcastChannel("macro-assets");
                channel.postMessage({ type: "updated", refreshAt });
                channel.close();
            } catch {
                // Ignore BroadcastChannel unsupported environments.
            }
            setShowImageSaveDialog(false);
        } catch (error) {
            alert(error instanceof Error ? error.message : "Failed to save image");
        }
    };

    const mapScriptPointToFrame = (x: number, y: number, frameWidth: number, frameHeight: number) => {
        const logicalSize = getTouchScreenSize();
        const baseWidth = logicalSize.width || frameWidth;
        const baseHeight = logicalSize.height || frameHeight;
        return {
            x: Math.max(0, Math.min(frameWidth - 1, Math.round((x / baseWidth) * frameWidth))),
            y: Math.max(0, Math.min(frameHeight - 1, Math.round((y / baseHeight) * frameHeight))),
        };
    };

    const samplePixelHex = (x: number, y: number): string | null => {
        const source = getFrameSourceElement();
        if (!source) return null;

        const frameWidth = source instanceof HTMLCanvasElement ? source.width : source.videoWidth;
        const frameHeight = source instanceof HTMLCanvasElement ? source.height : source.videoHeight;
        if (!frameWidth || !frameHeight) return null;

        if (!playbackCanvasRef.current) {
            playbackCanvasRef.current = document.createElement("canvas");
        }
        const canvas = playbackCanvasRef.current;
        canvas.width = frameWidth;
        canvas.height = frameHeight;

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(source, 0, 0, frameWidth, frameHeight);

        const mapped = mapScriptPointToFrame(x, y, frameWidth, frameHeight);
        const data = ctx.getImageData(mapped.x, mapped.y, 1, 1).data;
        return `#${data[0].toString(16).padStart(2, "0")}${data[1].toString(16).padStart(2, "0")}${data[2].toString(16).padStart(2, "0")}`.toUpperCase();
    };

    const getCropRegionText = useCallback((): string | null => {
        if (!cropRect || !frozenFrameSize) {
            return null;
        }
        const logicalSize = getTouchScreenSize();
        const baseWidth = logicalSize.width || frozenFrameSize.width;
        const baseHeight = logicalSize.height || frozenFrameSize.height;
        if (!baseWidth || !baseHeight) {
            return null;
        }

        const regionX = Math.max(0, Math.round((cropRect.x / frozenFrameSize.width) * baseWidth));
        const regionY = Math.max(0, Math.round((cropRect.y / frozenFrameSize.height) * baseHeight));
        const regionWidth = Math.max(1, Math.round((cropRect.width / frozenFrameSize.width) * baseWidth));
        const regionHeight = Math.max(1, Math.round((cropRect.height / frozenFrameSize.height) * baseHeight));
        return `REGION ${regionX} ${regionY} ${regionWidth} ${regionHeight}`;
    }, [cropRect, frozenFrameSize, screenSize, videoSize]);

    const parseHexColor = (hex: string) => ({
        r: Number.parseInt(hex.slice(1, 3), 16),
        g: Number.parseInt(hex.slice(3, 5), 16),
        b: Number.parseInt(hex.slice(5, 7), 16),
    });

    const evaluateScriptCondition = async (condition: MacroScriptCondition): Promise<boolean> => {
        if (condition.type === 'pixel') {
            lastImageMatchRef.current = null;
            const sampled = samplePixelHex(condition.x, condition.y);
            if (!sampled) {
                lastScriptConditionDebugRef.current = `IF PIXEL ${condition.x} ${condition.y}: no frame data`;
                return false;
            }
            const a = parseHexColor(sampled);
            const b = parseHexColor(condition.color);
            const diff = Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
            lastScriptConditionDebugRef.current = `IF PIXEL ${condition.x} ${condition.y}: sampled ${sampled}, target ${condition.color}, diff=${diff}, tol=${condition.tolerance}`;
            return diff <= condition.tolerance;
        }

        const screenshotDataUrl = captureFramePngDataUrl();
        if (!screenshotDataUrl) {
            lastScriptConditionDebugRef.current = `IF IMAGE ${condition.template}: no frame data`;
            return false;
        }

        let mappedRegion: { x: number; y: number; width: number; height: number } | undefined;
        if (condition.region) {
            const source = getFrameSourceElement();
            const frameWidth = source instanceof HTMLCanvasElement ? source.width : source?.videoWidth;
            const frameHeight = source instanceof HTMLCanvasElement ? source.height : source?.videoHeight;
            if (frameWidth && frameHeight) {
                const p1 = mapScriptPointToFrame(condition.region.x, condition.region.y, frameWidth, frameHeight);
                const p2 = mapScriptPointToFrame(
                    condition.region.x + condition.region.width,
                    condition.region.y + condition.region.height,
                    frameWidth,
                    frameHeight,
                );
                mappedRegion = {
                    x: Math.min(p1.x, p2.x),
                    y: Math.min(p1.y, p2.y),
                    width: Math.max(1, Math.abs(p2.x - p1.x)),
                    height: Math.max(1, Math.abs(p2.y - p1.y)),
                };
            }
        }

        const response = await fetch('/api/macros/image-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                screenshotDataUrl,
                ...(condition.template.startsWith("data:image/")
                    ? { templateDataUrl: condition.template }
                    : { template: condition.template }),
                threshold: condition.threshold,
                region: mappedRegion,
                mode: condition.mode,
                preferredScale: templateBestScaleRef.current.get(`${condition.template}::${condition.mode ?? 'precise'}`),
            }),
        });

        if (!response.ok) {
            lastImageMatchRef.current = null;
            lastScriptConditionDebugRef.current = `IF IMAGE ${condition.template}: image-match request failed (${response.status})`;
            return false;
        }
        const result = await response.json() as { found?: boolean; x?: number; y?: number; centerX?: number; centerY?: number; width?: number; height?: number; confidence?: number; scale?: number };
        const confidenceText = Number(result.confidence ?? 0).toFixed(3);
        const scaleText = Number(result.scale ?? 1).toFixed(2);
        if (result.found) {
            templateBestScaleRef.current.set(`${condition.template}::${condition.mode ?? 'precise'}`, result.scale ?? 1);
            lastImageMatchRef.current = {
                x: result.x ?? 0,
                y: result.y ?? 0,
                centerX: result.centerX ?? 0,
                centerY: result.centerY ?? 0,
                width: result.width ?? 0,
                height: result.height ?? 0,
                confidence: result.confidence ?? 0,
                scale: result.scale ?? 1,
            };
            lastScriptConditionDebugRef.current = `IF IMAGE ${condition.template}${condition.mode ? ` ${condition.mode.toUpperCase()}` : ''}: FOUND center=(${result.centerX ?? 0}, ${result.centerY ?? 0}), conf=${confidenceText}, scale=${scaleText}`;
        } else {
            lastImageMatchRef.current = null;
            lastScriptConditionDebugRef.current = `IF IMAGE ${condition.template}${condition.mode ? ` ${condition.mode.toUpperCase()}` : ''}: NOT FOUND best=(${result.x ?? 0}, ${result.y ?? 0}), conf=${confidenceText}, scale=${scaleText}`;
        }
        return !!result.found;
    };

    const resolveAndroidKeyCode = (key: string): AndroidKeyCode | null => {
        switch (key) {
            case 'HOME':
                return AndroidKeyCode.AndroidHome;
            case 'BACK':
                return AndroidKeyCode.AndroidBack;
            case 'POWER':
                return AndroidKeyCode.Power;
            case 'RECENTS':
            case 'APP_SWITCH':
                return AndroidKeyCode.AndroidAppSwitch;
            default:
                return null;
        }
    };

    const injectTapAt = async (x: number, y: number, controller: ScrcpyControlMessageWriter) => {
        const logicalSize = getTouchScreenSize();
        const msgBase = {
            pointerId: ScrcpyPointerId.Finger,
            videoWidth: logicalSize.width || 1,
            videoHeight: logicalSize.height || 1,
            pointerX: x,
            pointerY: y,
            pressure: 1,
            actionButton: 0,
            buttons: 1,
        };

        await controller.injectTouch({
            ...msgBase,
            action: AndroidMotionEventAction.Down,
        } as any);
        await controller.injectTouch({
            ...msgBase,
            action: AndroidMotionEventAction.Up,
            buttons: 0,
        } as any);
    };

    const injectTouchActionAt = async (
        action: AndroidMotionEventAction,
        x: number,
        y: number,
        controller: ScrcpyControlMessageWriter,
    ) => {
        const logicalSize = getTouchScreenSize();
        await controller.injectTouch({
            pointerId: ScrcpyPointerId.Finger,
            videoWidth: logicalSize.width || 1,
            videoHeight: logicalSize.height || 1,
            pointerX: x,
            pointerY: y,
            pressure: 1,
            action,
            actionButton: 0,
            buttons: action === AndroidMotionEventAction.Up ? 0 : 1,
        } as any);
    };

    const sendKeyPress = async (keyCode: AndroidKeyCode, controller: ScrcpyControlMessageWriter) => {
        await controller.injectKeyCode({
            action: AndroidKeyEventAction.Down,
            keyCode,
            repeat: 0,
            metaState: 0 as any,
        });
        await controller.injectKeyCode({
            action: AndroidKeyEventAction.Up,
            keyCode,
            repeat: 0,
            metaState: 0 as any,
        });
    };

    const applyScreenPowerMode = async (mode: AndroidScreenPowerMode, emit = true) => {
        if (!controllerRef.current) {
            return;
        }

        appendRecordedEvent('power', mode);
        await controllerRef.current.setScreenPowerMode(mode);

        if (emit && serial) {
            onControlAction?.({
                serial,
                type: 'screen_power',
                screenPowerMode: mode,
            });
        }

        await refreshDevicePowerState({
            retries: 4,
            delayMs: 150,
            silent: true,
        });
    };

    const performKeyPress = async (keyCode: AndroidKeyCode, emit = true) => {
        if (!controllerRef.current) {
            console.warn('Controller not initialized');
            return;
        }

        const keyDownEvent: any = {
            action: AndroidKeyEventAction.Down,
            keyCode: keyCode,
            repeat: 0,
            metaState: 0,
        };
        appendRecordedEvent('key', keyDownEvent);

        const keyUpEvent: any = {
            action: AndroidKeyEventAction.Up,
            keyCode: keyCode,
            repeat: 0,
            metaState: 0,
        };
        appendRecordedEvent('key', keyUpEvent);

        await sendKeyPress(keyCode, controllerRef.current);

        if (emit && serial) {
            onControlAction?.({
                serial,
                type: 'key',
                keyCode,
            });
        }

        if (keyCode === AndroidKeyCode.Power) {
            await refreshDevicePowerState({
                retries: 5,
                delayMs: 180,
                silent: true,
            });
        }
    };

    const injectDrag = async (
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        durationMs: number,
        controller: ScrcpyControlMessageWriter,
    ) => {
        const logicalSize = getTouchScreenSize();
        const msgBase = {
            pointerId: ScrcpyPointerId.Finger,
            videoWidth: logicalSize.width || 1,
            videoHeight: logicalSize.height || 1,
            pressure: 1,
            actionButton: 0,
        };

        await controller.injectTouch({
            ...msgBase,
            action: AndroidMotionEventAction.Down,
            pointerX: x1,
            pointerY: y1,
            buttons: 1,
        } as any);

        const steps = Math.max(1, Math.min(24, Math.round(durationMs / 16)));
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const nx = Math.round(x1 + (x2 - x1) * t);
            const ny = Math.round(y1 + (y2 - y1) * t);
            await controller.injectTouch({
                ...msgBase,
                action: AndroidMotionEventAction.Move,
                pointerX: nx,
                pointerY: ny,
                buttons: 1,
            } as any);
            await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.floor(durationMs / steps))));
        }

        await controller.injectTouch({
            ...msgBase,
            action: AndroidMotionEventAction.Up,
            pointerX: x2,
            pointerY: y2,
            buttons: 0,
        } as any);
    };

    const executeParsedScript = async (parsedScript: ParsedMacroScript, controller: ScrcpyControlMessageWriter): Promise<void> => {
        let nextIndex = 0;

        while (nextIndex < parsedScript.nodes.length) {
            const signal = await executeScriptNodes(parsedScript.nodes.slice(nextIndex), controller);
            if (!signal) {
                return;
            }

            if (signal.type === "goto") {
                const targetIndex = parsedScript.topLevelLabels[signal.label];
                if (targetIndex === undefined) {
                    throw new Error(`Unknown label "${signal.label}"`);
                }
                nextIndex = targetIndex;
                continue;
            }

            if (signal.type === "exit") {
                return;
            }

            throw new Error("BREAK can only be used inside FOR EACH");
        }
    };

    const executeScriptNodes = async (nodes: MacroScriptNode[], controller: ScrcpyControlMessageWriter): Promise<MacroExecutionSignal | null> => {
        for (const node of nodes) {
            if (node.type === 'wait') {
                if (node.ms > 0) {
                    await new Promise((resolve) => setTimeout(resolve, node.ms));
                }
                continue;
            }

            if (node.type === "label") {
                continue;
            }

            if (node.type === "goto") {
                lastScriptConditionDebugRef.current = `GOTO ${node.label}`;
                return { type: "goto", label: node.label };
            }

            if (node.type === "break") {
                lastScriptConditionDebugRef.current = "BREAK";
                return { type: "break" };
            }

            if (node.type === "exit") {
                lastScriptConditionDebugRef.current = "EXIT";
                return { type: "exit" };
            }

            if (node.type === 'tap') {
                await injectTapAt(node.x, node.y, controller);
                continue;
            }

            if (node.type === 'tap_match') {
                const match = lastImageMatchRef.current;
                if (!match) {
                    lastScriptConditionDebugRef.current = 'TAP_MATCH skipped because no image match result is available';
                    console.warn('TAP_MATCH skipped because no image match result is available');
                    continue;
                }
                await injectTapAt(
                    Math.round(match.centerX + node.offsetX),
                    Math.round(match.centerY + node.offsetY),
                    controller,
                );
                continue;
            }

            if (node.type === 'drag') {
                await injectDrag(node.x1, node.y1, node.x2, node.y2, node.durationMs, controller);
                continue;
            }

            if (node.type === 'key') {
                const keyCode = resolveAndroidKeyCode(node.key);
                if (!keyCode) {
                    console.warn(`Unsupported KEY in script: ${node.key}`);
                    continue;
                }
                await controller.injectKeyCode({
                    action: AndroidKeyEventAction.Down,
                    keyCode,
                    repeat: 0,
                    metaState: 0 as any,
                });
                await controller.injectKeyCode({
                    action: AndroidKeyEventAction.Up,
                    keyCode,
                    repeat: 0,
                    metaState: 0 as any,
                });
                continue;
            }

            if (node.type === "for_each") {
                let iteration = 0;
                while (node.count === null || iteration < node.count) {
                    const signal = await executeScriptNodes(node.body, controller);
                    if (!signal) {
                        iteration += 1;
                        continue;
                    }
                    if (signal.type === "break") {
                        break;
                    }
                    return signal;
                }
                continue;
            }

            const matched = await evaluateScriptCondition(node.condition);
            const signal = await executeScriptNodes(matched ? node.thenNodes : node.elseNodes, controller);
            if (signal) {
                return signal;
            }
        }

        return null;
    };

    const finishMacroEditorBusy = () => {
        macroEditorBusyRef.current = false;
        if (deferredReconnectRef.current) {
            deferredReconnectRef.current = false;
            isManualDisconnectRef.current = false;
            reconnectAttemptRef.current = 0;
            void connectDeviceRef.current();
        }
    };

    const emitMacroEditorEvent = (type: string, payload: Record<string, unknown>) => {
        if (embedded) {
            window.dispatchEvent(new CustomEvent(type, { detail: payload }));
            return;
        }
        if (window.parent !== window) {
            window.parent.postMessage({ type, ...payload }, window.location.origin);
        }
    };

    useEffect(() => {
        if (!serial || !registerSyncAdapter) {
            return;
        }

        registerSyncAdapter(serial, {
            injectNormalizedTouch: (action, normalizedX, normalizedY) => {
                if (!controllerRef.current) {
                    return;
                }

                if (action !== AndroidMotionEventAction.Down && action !== AndroidMotionEventAction.Up && action !== AndroidMotionEventAction.Move) {
                    return;
                }

                const logicalSize = latestTouchSizeRef.current;
                const x = Math.round((logicalSize.width || 1) * Math.max(0, Math.min(1, normalizedX)));
                const y = Math.round((logicalSize.height || 1) * Math.max(0, Math.min(1, normalizedY)));

                syncTouchQueueRef.current = syncTouchQueueRef.current
                    .catch(() => undefined)
                    .then(() => injectTouchActionAt(action, x, y, controllerRef.current!));
            },
            triggerControlAction: (payload) => {
                if (payload.type === 'key' && typeof payload.keyCode === 'number') {
                    void performKeyPress(payload.keyCode as AndroidKeyCode, false);
                    return;
                }

                if (payload.type === 'screen_power' && typeof payload.screenPowerMode === 'number') {
                    void applyScreenPowerMode(payload.screenPowerMode as AndroidScreenPowerMode, false);
                }
            },
        });

        return () => {
            registerSyncAdapter(serial, null);
        };
    }, [registerSyncAdapter, serial]);

    useEffect(() => {
        if (!embedded && window.parent === window) {
            return;
        }
        try {
            emitMacroEditorEvent("macro-editor:live-device-status", {
                serial: serial ?? "",
                ready: isVideoLoaded,
            });
        } catch {
            // Ignore postMessage failures.
        }
    }, [embedded, isVideoLoaded, serial]);

    const runMacroScriptOnServer = async (macroName: string, source: string) => {
        const startResponse = await fetch('/api/macros/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                serial,
                source,
                name: macroName,
            }),
        });
        const startData = await startResponse.json().catch(() => null) as { error?: string; runId?: string } | null;
        if (!startResponse.ok || !startData?.runId) {
            throw new Error(startData?.error || `Failed to start macro (${startResponse.status})`);
        }

        setActiveMacroRunId(startData.runId);
        setActiveMacroRunStatus('queued');
        setActiveMacroRunMessage('Queued');

        await new Promise<void>((resolve, reject) => {
            const startedAt = Date.now();
            let pausedAt = 0;
            let totalPausedMs = 0;
            const timer = window.setInterval(async () => {
                try {
                    const res = await fetch(`/api/macros/run/${startData.runId}`);
                    const data = await res.json().catch(() => null) as { status?: MacroRunStatus; message?: string; error?: string } | null;
                    if (!res.ok || !data) {
                        window.clearInterval(timer);
                        reject(new Error(data?.error || `Failed to poll macro run (${res.status})`));
                        return;
                    }

                    if (data.status === 'paused') {
                        if (pausedAt === 0) {
                            pausedAt = Date.now();
                        }
                    } else if (pausedAt > 0) {
                        totalPausedMs += Date.now() - pausedAt;
                        pausedAt = 0;
                    }

                    if (data.status === 'queued' || data.status === 'running' || data.status === 'paused') {
                        setActiveMacroRunStatus(data.status);
                        setActiveMacroRunMessage(data.message || (data.status === 'paused' ? 'Paused' : 'Running'));
                        if (data.status !== 'paused' && Date.now() - startedAt - totalPausedMs > 180000) {
                            window.clearInterval(timer);
                            reject(new Error('Macro run timed out'));
                        }
                        return;
                    }

                    window.clearInterval(timer);
                    if (data.status === 'completed') {
                        resolve();
                        return;
                    }
                    reject(new Error(data.message || 'Macro run failed'));
                } catch (error) {
                    window.clearInterval(timer);
                    reject(error instanceof Error ? error : new Error('Macro run failed'));
                }
            }, 1000);
        });
    };

    const toggleMacroRunPause = async () => {
        if (!activeMacroRunId || !activeMacroRunStatus) {
            return;
        }

        const action = activeMacroRunStatus === 'paused' ? 'resume' : 'pause';
        try {
            const response = await fetch(`/api/macros/run/${activeMacroRunId}/${action}`, {
                method: 'POST',
            });
            const data = await response.json().catch(() => null) as { error?: string; message?: string; status?: MacroRunStatus } | null;
            if (!response.ok) {
                throw new Error(data?.error || `Failed to ${action} macro (${response.status})`);
            }
            if (data?.status) {
                setActiveMacroRunStatus(data.status);
            }
            setActiveMacroRunMessage(data?.message || (action === 'pause' ? 'Paused' : 'Running'));
        } catch (error) {
            alert(error instanceof Error ? error.message : `Failed to ${action} macro`);
        }
    };

    // Play Macro
    const playMacro = async (macro: Macro) => {
        setIsPlaying(true);
        setShowMacroList(false);
        try {
            const scriptSource = extractSimpleScript(macro.content).trim();
            if (!scriptSource) {
                throw new Error('Macro has no runnable script');
            }
            await runMacroScriptOnServer(macro.name, scriptSource);
        } catch (e) {
            console.error("Failed to play macro", e);
            alert(e instanceof Error ? e.message : "Failed to play macro");
        } finally {
            setIsPlaying(false);
            setActiveMacroRunId(null);
            setActiveMacroRunStatus(null);
            setActiveMacroRunMessage('');
        }
    };

    const toggleScreenPower = async () => {
        try {
            const latestPowerState = await refreshDevicePowerState({ silent: true });
            const shouldTurnScreenOn = latestPowerState?.screenOff ?? devicePowerState.screenOff;
            const newMode = shouldTurnScreenOn ? AndroidScreenPowerMode.Normal : AndroidScreenPowerMode.Off;
            await applyScreenPowerMode(newMode, true);
        } catch (error) {
            console.error("Failed to toggle screen power:", error);
        }
    };


    // Button handlers
    const handleKeyPress = (keyCode: AndroidKeyCode) => {
        void performKeyPress(keyCode, true).catch((error) => {
            console.error('Failed to send key press:', error);
        });
    };

    const isScreenOff = devicePowerState.screenOff;
    const isScreenStateKnown = devicePowerState.screenState !== 'UNKNOWN' || devicePowerState.wakefulness !== null;
    const isPowerStateKnown = devicePowerState.interactive !== null || devicePowerState.wakefulness !== null;
    const isDeviceSleeping = devicePowerState.interactive === false ||
        (devicePowerState.interactive === null && ['ASLEEP', 'DOZING'].includes(devicePowerState.wakefulness ?? ''));
    const neutralStateAccentClass = "text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80";
    const screenStateAccentClass = !isScreenStateKnown
        ? neutralStateAccentClass
        : isScreenOff
            ? "text-red-500 hover:text-red-600 bg-red-500/10 hover:bg-red-500/15"
            : "text-emerald-600 hover:text-emerald-700 bg-emerald-500/10 hover:bg-emerald-500/15";
    const powerStateAccentClass = !isPowerStateKnown
        ? neutralStateAccentClass
        : isDeviceSleeping
            ? "text-red-500 hover:text-red-600 bg-red-500/10 hover:bg-red-500/15"
            : "text-emerald-600 hover:text-emerald-700 bg-emerald-500/10 hover:bg-emerald-500/15";
    const screenStateTitle = !isScreenStateKnown
        ? "Screen State Unknown"
        : isScreenOff
            ? "Screen Off - Click to Turn On"
            : "Screen On - Click to Turn Off";
    const powerStateTitle = !isPowerStateKnown
        ? "Power State Unknown"
        : isDeviceSleeping
            ? "Power (Sleep)"
            : "Power (Awake)";
    const screenStateMenuLabel = !isScreenStateKnown
        ? "Screen Unknown"
        : isScreenOff
            ? "Screen Off"
            : "Screen On";
    const powerStateMenuLabel = !isPowerStateKnown
        ? "Power Unknown"
        : isDeviceSleeping
            ? "Power Sleep"
            : "Power Awake";

    const isWirelessSerial = typeof serial === "string" && /^[^:\s]+:\d+$/.test(serial);

    const fetchDeviceResponse = async (deviceSerial: string) => {
        const response = await fetch(`/api/adb/device/${encodeURIComponent(deviceSerial)}`);
        if (response.ok) {
            return {
                response,
                payload: await response.json() as DeviceResponse,
            };
        }

        const payload = await response.json().catch(() => null) as { message?: string; error?: string; hint?: string } | null;
        return { response, payload };
    };

    const ensureWirelessAdbConnection = async (deviceSerial: string) => {
        const connectResponse = await fetch('/api/adb/wireless/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: deviceSerial }),
        });

        if (!connectResponse.ok) {
            const connectPayload = await connectResponse.json().catch(() => null) as { error?: string } | null;
            throw new Error(connectPayload?.error || `Wireless reconnect failed (${connectResponse.status})`);
        }
    };

    // --- Disconnect device (cleanup all connections) ---
    const disconnectDevice = useCallback(() => {
        restoreOriginalController();

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
        setDevicePowerState(DEFAULT_DEVICE_POWER_STATE);
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
        didAutoScreenOffRef.current = false;

        try {
            let deviceLookup = await fetchDeviceResponse(serial);
            if ('response' in deviceLookup && !deviceLookup.response.ok && isWirelessSerial) {
                try {
                    await ensureWirelessAdbConnection(serial);
                    deviceLookup = await fetchDeviceResponse(serial);
                } catch (wirelessReconnectError) {
                    console.warn('Wireless reconnect attempt failed:', wirelessReconnectError);
                }
            }

            if ('response' in deviceLookup && !deviceLookup.response.ok) {
                const payload = deviceLookup.payload as { message?: string; error?: string; hint?: string } | null;
                const message = payload?.message || payload?.error || `Failed to fetch device info: ${deviceLookup.response.status}`;
                const hint = payload?.hint ? ` ${payload.hint}` : '';
                if (deviceLookup.response.status === 404 && isLikelyIpv4WithoutPort) {
                    throw new Error(`${message}. Wireless Debugging requires IP:PORT, for example 192.168.1.20:39137.`);
                }
                throw new Error(`${message}${hint}`);
            }

            const data = (deviceLookup as { response: Response; payload: DeviceResponse }).payload;
            setDeviceInfo(data.info);
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
                if (!didAutoScreenOffRef.current) {
                    try {
                        await scrcpy.controller.setScreenPowerMode(AndroidScreenPowerMode.Off);
                        didAutoScreenOffRef.current = true;
                    } catch (screenPowerError) {
                        console.warn("Failed to set default screen off mode:", screenPowerError);
                    }
                }
                await refreshDevicePowerState({
                    retries: 4,
                    delayMs: 150,
                    silent: true,
                });
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
                        lastFrameAtRef.current = Date.now();
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
                setError(undefined);
                setConnectionStatus('connected');
                connectedAtRef.current = Date.now();
                lastFrameAtRef.current = Date.now();
                qualitySwitchPendingRef.current = false;
                reconnectAttemptRef.current = 0; // Reset on successful connection
                stallCountRef.current = 0; // Reset stall counter

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
                            if (macroEditorBusyRef.current) {
                                deferredReconnectRef.current = true;
                            } else if (!isManualDisconnectRef.current && isTabVisibleRef.current) {
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
                    write() {
                    },
                }),
            ).catch(() => undefined);

            // Listen for transport disconnect → trigger reconnect
            transport.disconnected.then(() => {
                console.warn('Transport disconnected');
                if (macroEditorBusyRef.current) {
                    deferredReconnectRef.current = true;
                    return;
                }
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
            if (isManualDisconnectRef.current || qualitySwitchPendingRef.current) {
                return;
            }
            setError(e instanceof Error ? e.message : 'Device connection failed');
            setIsLoading(false);
            setConnectionStatus('disconnected');
            // Auto-reconnect on connection failure
            if (!isManualDisconnectRef.current && isTabVisibleRef.current) {
                scheduleReconnect();
            }
        }
    }, [serial, quality, disconnectDevice, isWirelessSerial, isLikelyIpv4WithoutPort, refreshDevicePowerState]);

    connectDeviceRef.current = connectDevice;

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

        setConnectionStatus('reconnecting');

        reconnectTimerRef.current = setTimeout(() => {
            if (isTabVisibleRef.current && !isManualDisconnectRef.current) {
                isManualDisconnectRef.current = false;
                connectDevice();
            }
        }, delay);
    }, [connectDevice]);

    // Keep ref in sync for stall detection timer
    scheduleReconnectRef.current = scheduleReconnect;

    useEffect(() => {
        if (!serial || connectionStatus !== 'connected') {
            return;
        }

        void refreshDevicePowerState({ silent: true });

        const timer = setInterval(() => {
            if (!document.hidden && controllerRef.current) {
                void refreshDevicePowerState({ silent: true });
            }
        }, 3000);

        return () => clearInterval(timer);
    }, [connectionStatus, refreshDevicePowerState, serial]);

    // --- Main connection effect ---
    useEffect(() => {
        // Check if mobile device
        setIsMobile(isMobileDevice());
        isManualDisconnectRef.current = false;

        if (!isAutoQualityResolved) {
            setIsLoading(true);
            setError(undefined);
            return;
        }

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
    }, [serial, quality, connectDevice, disconnectDevice, isAutoQualityResolved]);

    // --- Tab visibility handler ---
    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.hidden) {
                isTabVisibleRef.current = false;
                if (reconnectTimerRef.current) {
                    clearTimeout(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
                return;
            }

            isTabVisibleRef.current = true;
            if (connectionStatus === "connected") {
                void refreshDevicePowerState({ silent: true });
            }
            if (connectionStatus === "disconnected" || connectionStatus === "reconnecting") {
                isManualDisconnectRef.current = false;
                reconnectAttemptRef.current = 0;
                connectDevice();
            }
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    }, [connectDevice, connectionStatus, refreshDevicePowerState]);


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

    const handleQualityChange = (nextQuality: QualityLevel) => {
        if (nextQuality === quality) {
            return;
        }
        qualitySwitchPendingRef.current = true;
        setError(undefined);
        setIsLoading(true);
        setConnectionStatus('connecting');
        setQuality(nextQuality);
    };


    return (
        <div className={embedded ? "h-full w-full overflow-hidden" : "h-[100dvh] w-full overflow-hidden flex items-center justify-center p-1 md:p-4"}>
            <Card className="w-full h-full gap-2 flex flex-col overflow-hidden">
                <CardHeader className="space-y-0 py-2">
                    <div className="flex w-full items-center gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {!embedded && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => navigate('/')}
                                className="h-8 w-8 shrink-0 md:h-9 md:w-9"
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </Button>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                            {isLoading && <Spinner className="h-2.5 w-2.5 text-muted-foreground" />}
                            <span
                                className={`inline-flex min-w-[74px] flex-col items-center justify-center text-[9px] md:text-[10px] px-1 py-0.5 rounded font-mono font-bold leading-[1.05] ${stats.fps > 20 ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}
                                style={{ fontVariantNumeric: "tabular-nums" }}
                            >
                                <span>{(stats.bitrate || 0).toFixed(1)} Mbps</span>
                                <span>{stats.fps || 0} FPS</span>
                            </span>
                        </div>
                        <div className="relative shrink-0">
                            <select
                                value={quality}
                                onChange={(e) => handleQualityChange(e.target.value as QualityLevel)}
                                className="h-8 w-[72px] md:h-9 md:w-auto px-2 rounded-md border border-input bg-background text-[11px] md:text-sm cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring"
                                title="Video Quality"
                            >
                                {(Object.entries(qualityPresets) as [QualityLevel, typeof qualityPresets[QualityLevel]][]).map(([key, preset]) => (
                                    <option key={key} value={key}>{isMobile ? key.toUpperCase() : preset.label}</option>
                                ))}
                            </select>
                        </div>
                        {activeMacroRunId && (
                            <span
                                className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[10px] font-medium md:text-xs ${activeMacroRunStatus === 'paused'
                                    ? 'bg-amber-500/15 text-amber-700'
                                    : 'bg-blue-500/15 text-blue-700'}`}
                                title={activeMacroRunMessage || undefined}
                            >
                                {activeMacroRunStatus === 'paused' ? 'Macro Paused' : 'Macro Running'}
                            </span>
                        )}

                        <div className="hidden h-6 w-px shrink-0 bg-border mx-1 md:block" />

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => (isFrameFrozen ? unfreezeFrame() : freezeCurrentFrame())}
                            title={isFrameFrozen ? "Unfreeze Frame" : "Freeze Frame"}
                            disabled={!isVideoLoaded}
                            className="h-8 w-8 shrink-0 md:h-9 md:w-9"
                        >
                            <PauseCircle className={`h-4 w-4 ${isFrameFrozen ? 'text-yellow-500' : ''}`} />
                        </Button>

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => toggleRecording(e)}
                            title={isRecording ? "Stop Recording" : "Record Macro"}
                            disabled={!isVideoLoaded || isPlaying}
                            className={`h-8 w-8 shrink-0 md:h-9 md:w-9 ${isRecording ? "animate-pulse" : ""}`}
                        >
                            {isRecording ? (
                                <StopCircle className="h-4 w-4 text-red-500" />
                            ) : (
                                <Circle className="h-4 w-4 text-red-500 fill-red-500" />
                            )}
                        </Button>

                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setShowMacroList(true)}
                            title="Play Macro"
                            disabled={!isVideoLoaded || isRecording || isPlaying}
                            className="hidden h-8 w-8 shrink-0 md:inline-flex md:h-9 md:w-9"
                        >
                            <Play className="h-4 w-4" />
                        </Button>
                        {activeMacroRunId && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => void toggleMacroRunPause()}
                                title={activeMacroRunStatus === 'paused' ? 'Resume Macro' : 'Pause Macro'}
                                className="hidden h-8 w-8 shrink-0 md:inline-flex md:h-9 md:w-9"
                            >
                                {activeMacroRunStatus === 'paused'
                                    ? <Play className="h-4 w-4 text-emerald-600" />
                                    : <PauseCircle className="h-4 w-4 text-amber-600" />}
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleScreenPower}
                            title={screenStateTitle}
                            className={`hidden h-8 w-8 shrink-0 md:inline-flex md:h-9 md:w-9 ${screenStateAccentClass}`}
                        >
                            {isScreenOff ? <MonitorPlay className="h-4 w-4" /> : <MonitorOff className="h-4 w-4" />}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleKeyPress(AndroidKeyCode.Power)}
                            title={powerStateTitle}
                            className={`hidden h-8 w-8 shrink-0 md:inline-flex md:h-9 md:w-9 ${powerStateAccentClass}`}
                        >
                            <Power className="h-4 w-4" />
                        </Button>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 md:hidden" title="More">
                                    <Ellipsis className="h-4 w-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => setShowMacroList(true)} disabled={!isVideoLoaded || isRecording || isPlaying}>
                                    <Play className="h-4 w-4" /> Play Macro
                                </DropdownMenuItem>
                                {activeMacroRunId && (
                                    <DropdownMenuItem onClick={() => void toggleMacroRunPause()}>
                                        {activeMacroRunStatus === 'paused'
                                            ? <Play className="h-4 w-4 text-emerald-600" />
                                            : <PauseCircle className="h-4 w-4 text-amber-600" />}
                                        {activeMacroRunStatus === 'paused' ? 'Resume Macro' : 'Pause Macro'}
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={toggleScreenPower} disabled={!isVideoLoaded} className={screenStateAccentClass}>
                                    {isScreenOff ? <MonitorPlay className="h-4 w-4" /> : <MonitorOff className="h-4 w-4" />} {screenStateMenuLabel}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleKeyPress(AndroidKeyCode.Power)} disabled={!isVideoLoaded} className={powerStateAccentClass}>
                                    <Power className="h-4 w-4" /> {powerStateMenuLabel}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => (isFrameFrozen ? unfreezeFrame() : freezeCurrentFrame())} disabled={!isVideoLoaded}>
                                    <PauseCircle className="h-4 w-4" /> {isFrameFrozen ? "Unfreeze" : "Freeze Frame"}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </CardHeader>
                <CardContent className="px-0 md:px-6 relative flex-1 min-h-0 overflow-hidden">
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
                        <div className="h-full flex items-center justify-center overflow-hidden">


                            <div className="inline-flex flex-col gap-0 max-h-full">
                                {/* Screen Display Area */}
                                <div
                                    className="canvas-wrapper border-2 border-solid border-black rounded-t-sm overflow-hidden bg-white relative"
                                    style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
                                    onContextMenu={(e) => e.preventDefault()}
                                >
                                    {/* Keyboard Control - disabled when dialogs are open */}
                                    <KeyboardControl client={scrcpyClientRef.current} enabled={isVideoLoaded && !showSaveDialog && !showMacroList && !isFrameFrozen} />

                                    <TouchControl
                                        client={isFrameFrozen ? null : scrcpyClientRef.current}
                                        screenWidth={getTouchScreenSize().width}
                                        screenHeight={getTouchScreenSize().height}
                                        rotation={getTouchRotation()}
                                        onTouchEvent={(event) => {
                                            appendRecordedEvent('touch', event);
                                            if (!serial) {
                                                return;
                                            }
                                            const logicalSize = getTouchScreenSize();
                                            onLiveTouchEvent?.({
                                                serial,
                                                action: Number(event.action ?? -1),
                                                pointerX: Number(event.pointerX ?? 0),
                                                pointerY: Number(event.pointerY ?? 0),
                                                videoWidth: Number(logicalSize.width ?? event.videoWidth ?? 0),
                                                videoHeight: Number(logicalSize.height ?? event.videoHeight ?? 0),
                                            });
                                        }}
                                    >
                                        {/* Background SVG Placeholder */}
                                        <svg
                                            width={getVisualSize().width}
                                            height={getVisualSize().height}
                                            style={{
                                                display: 'block',
                                                maxWidth: '100%',
                                                maxHeight: embedded
                                                    ? '100%'
                                                    : isMobile
                                                        ? 'calc(100dvh - 205px)'
                                                        : (isLandscape ? '66vh' : '74vh'),
                                                width: 'auto',
                                                height: 'auto'
                                            }}
                                        />

                                        {/* Video Container */}
                                        <div
                                            ref={wrapperRef}
                                            style={getVideoWrapperStyle()}
                                        />

                                        {isFrameFrozen && frozenFrameDataUrl && (
                                            <div
                                                ref={frozenOverlayRef}
                                                className="absolute inset-0 z-20 bg-black/40"
                                                onPointerDown={(e) => {
                                                    e.preventDefault();
                                                    if (inspectorMode === 'pixel') {
                                                        pickFrozenPixel(e.clientX, e.clientY);
                                                        return;
                                                    }
                                                    const p = mapClientToFrozenPixel(e.clientX, e.clientY);
                                                    if (!p) return;
                                                    setCropStart(p);
                                                    setCropRect({ x: p.x, y: p.y, width: 1, height: 1 });
                                                }}
                                                onPointerMove={(e) => {
                                                    if (inspectorMode !== 'crop' || !cropStart) return;
                                                    const p = mapClientToFrozenPixel(e.clientX, e.clientY);
                                                    if (!p) return;
                                                    updateCropRect(cropStart, p);
                                                }}
                                                onPointerUp={() => {
                                                    if (inspectorMode === 'crop') {
                                                        finalizeCropImage();
                                                    }
                                                    setCropStart(null);
                                                }}
                                            >
                                                <img src={frozenFrameDataUrl} className="absolute inset-0 h-full w-full object-contain select-none pointer-events-none" />
                                                {cropRect && frozenFrameSize && (
                                                    <div
                                                        className="absolute border border-cyan-400 bg-cyan-500/20 pointer-events-none"
                                                        style={{
                                                            left: `${(cropRect.x / frozenFrameSize.width) * 100}%`,
                                                            top: `${(cropRect.y / frozenFrameSize.height) * 100}%`,
                                                            width: `${(cropRect.width / frozenFrameSize.width) * 100}%`,
                                                            height: `${(cropRect.height / frozenFrameSize.height) * 100}%`,
                                                        }}
                                                    />
                                                )}
                                                <div
                                                    className="absolute left-2 top-2 rounded-md bg-black/70 text-white text-[10px] p-2 space-y-1 max-w-[85%]"
                                                    onPointerDown={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                    }}
                                                    onPointerMove={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                    }}
                                                    onPointerUp={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                    }}
                                                >
                                                    <div className="flex items-center gap-1">
                                                        <Button size="sm" variant={inspectorMode === 'pixel' ? 'default' : 'outline'} className="h-6 px-2 text-[10px]" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setInspectorMode('pixel'); }}>
                                                            <Crosshair className="h-3 w-3 mr-1" /> Pixel
                                                        </Button>
                                                        <Button size="sm" variant={inspectorMode === 'crop' ? 'default' : 'outline'} className="h-6 px-2 text-[10px]" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setInspectorMode('crop'); }}>
                                                            <Crop className="h-3 w-3 mr-1" /> Crop
                                                        </Button>
                                                    </div>
                                                    {pixelInfo && (
                                                        <div className="space-y-0.5">
                                                            <div>Pos: ({pixelInfo.x}, {pixelInfo.y})</div>
                                                            <div className="flex items-center gap-1">
                                                                Color: {pixelInfo.color}
                                                                <span className="inline-block h-3 w-3 rounded-sm border" style={{ backgroundColor: pixelInfo.color }} />
                                                            </div>
                                                        </div>
                                                    )}
                                                    {cropRect && (
                                                        <div className="space-y-0.5">
                                                            <div>Crop: {cropRect.width}x{cropRect.height} @ ({cropRect.x},{cropRect.y})</div>
                                                            {getCropRegionText() && (
                                                                <div className="break-all text-emerald-300">
                                                                    {getCropRegionText()}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                    {croppedImageDataUrl && (
                                                        <div className="flex items-center gap-2">
                                                            <img src={croppedImageDataUrl} className="h-10 w-10 border rounded-sm object-cover" />
                                                            <Button
                                                                size="sm"
                                                                variant="outline"
                                                                className="h-6 px-2 text-[10px]"
                                                                onPointerDown={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                }}
                                                                onClick={(e) => {
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                    openSaveCropImageDialog();
                                                                }}
                                                            >
                                                                Save Image
                                                            </Button>
                                                        </div>
                                                    )}
                                                    {savedCropImageUrl && (
                                                        <div className="text-[10px] text-emerald-300 break-all">
                                                            Saved: {savedCropImageUrl}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}

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
                                        onClick={() => handleKeyPress(AndroidKeyCode.AndroidBack)}
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
                                                {getMacroStepCount(macro.content)} steps
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Button size="icon" variant="ghost" className="h-8 w-8 text-green-500" onClick={() => playMacro(macro)}>
                                                <Play className="h-4 w-4" />
                                            </Button>
                                            <Button size="icon" variant="ghost" className="h-8 w-8 text-blue-500" onClick={() => openEditMacro(macro)}>
                                                <Pencil className="h-4 w-4" />
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

            {/* Crop Image Save Dialog */}
            {showImageSaveDialog && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowImageSaveDialog(false)}>
                    <div className="bg-background border rounded-lg p-4 w-[92vw] max-w-md shadow-lg" onClick={(e) => e.stopPropagation()}>
                        {(() => {
                            const cropRegionText = getCropRegionText();
                            const imageScriptText = savedCropImageUrl && cropRegionText
                                ? `IF IMAGE "${savedCropImageUrl}" CONF >= 0.9 ${cropRegionText} FAST\n  TAP_MATCH\nEND`
                                : null;
                            return (
                                <>
                        <h3 className="font-semibold mb-3">Save Cropped Image</h3>
                        <div className="space-y-2">
                            <label className="text-sm font-medium">File name</label>
                            <input
                                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                value={cropImageName}
                                onChange={(e) => setCropImageName(e.target.value)}
                                placeholder="template-login.png"
                                autoFocus
                            />
                            <p className="text-[11px] text-muted-foreground">
                                Saved for scripts at: <code>/api/macros/assets/your-name.png</code>
                            </p>
                            {cropRegionText && (
                                <div className="rounded-md border bg-muted/30 p-2 text-[11px]">
                                    <div className="font-medium text-foreground">Region</div>
                                    <div className="mt-1 break-all font-mono text-muted-foreground">{cropRegionText}</div>
                                </div>
                            )}
                            {savedCropImageUrl && (
                                <div className="rounded-md border bg-muted/30 p-2 text-[11px] space-y-2">
                                    <div>
                                        <div className="font-medium text-foreground">Saved Image URL</div>
                                        <div className="mt-1 break-all font-mono text-muted-foreground">{savedCropImageUrl}</div>
                                    </div>
                                    {imageScriptText && (
                                        <div>
                                            <div className="font-medium text-foreground">Sample IF IMAGE</div>
                                            <pre className="mt-1 whitespace-pre-wrap break-all rounded border bg-background/80 p-2 font-mono text-[10px]">{imageScriptText}</pre>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setShowImageSaveDialog(false)}>Cancel</Button>
                            <Button onClick={saveCroppedImage}>Save Image</Button>
                        </div>
                                </>
                            );
                        })()}
                    </div>
                </div>
            )}

            {/* Macro Edit Dialog */}
            {showEditDialog && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-background border rounded-lg p-4 w-[92vw] max-w-2xl max-h-[85vh] shadow-lg flex flex-col" onClick={(e) => e.stopPropagation()}>
                        <h3 className="font-semibold mb-4">Edit Macro</h3>
                        <div className="space-y-3 overflow-y-auto pr-1">
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Name</label>
                                <input
                                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    value={editMacroName}
                                    onChange={(e) => setEditMacroName(e.target.value)}
                                    autoFocus
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium">Simple Script</label>
                                <textarea
                                    className="w-full min-h-[280px] rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                    value={editMacroScript}
                                    onChange={(e) => setEditMacroScript(e.target.value)}
                                />
                                <p className="text-[11px] text-muted-foreground">
                                    Syntax: WAIT, TAP, TAP_MATCH, DRAG, KEY, IF PIXEL, IF IMAGE, label:, GOTO label, FOR EACH [count] ... END, BREAK, EXIT
                                </p>
                            </div>
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancel</Button>
                            <Button onClick={updateMacro}>Save Changes</Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}


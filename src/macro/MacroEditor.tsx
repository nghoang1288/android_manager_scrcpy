import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, BookText, Copy, GripVertical, PauseCircle, Play, Plus, Save, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { parseMacroScript } from "@/shared/macro-script";

const IMPORT_STORAGE_KEY = "macro_editor_import_script";
const SPLIT_LAYOUT_STORAGE_KEY = "macro_editor_live_device_split";
const DEFAULT_LIVE_DEVICE_WIDTH = 62;
const MIN_LIVE_DEVICE_WIDTH = 38;
const MAX_LIVE_DEVICE_WIDTH = 82;
const DeviceDetail = lazy(() => import("@/scrcpy/DeviceDetail"));

interface Macro {
    id: number;
    name: string;
    content: string;
    createdAt: string;
}

interface MacroAsset {
    name: string;
    url: string;
    region?: { x: number; y: number; width: number; height: number };
}

interface DeviceBasicInfo {
    serial: string;
    state: string;
    model?: string;
    transportId?: number;
}
type MacroRunStatus = "queued" | "running" | "paused" | "completed" | "failed";
type MacroRunLogEntry = {
    at: string;
    message: string;
};

function extractScript(content: string): string {
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
    } catch {
        return content;
    }
    return content;
}

function buildAssetImageScript(asset: MacroAsset): string {
    const region = asset.region
        ? ` REGION ${asset.region.x} ${asset.region.y} ${asset.region.width} ${asset.region.height}`
        : "";
    return `IF IMAGE "${asset.url}" CONF >= 0.9${region} FAST\n  TAP_MATCH\nEND`;
}

export default function MacroEditor() {
    const navigate = useNavigate();
    const liveDeviceReadyRef = useRef(false);
    const imageTestBestScaleRef = useRef<Map<string, number>>(new Map());
    const splitLayoutRef = useRef<HTMLDivElement | null>(null);
    const activeResizePointerIdRef = useRef<number | null>(null);
    const runLogViewportRef = useRef<HTMLDivElement | null>(null);
    const [macros, setMacros] = useState<Macro[]>([]);
    const [assets, setAssets] = useState<MacroAsset[]>([]);
    const [devices, setDevices] = useState<DeviceBasicInfo[]>([]);
    const [selectedDeviceSerial, setSelectedDeviceSerial] = useState("");
    const [selectedMacroId, setSelectedMacroId] = useState<number | null>(null);
    const [name, setName] = useState("");
    const [script, setScript] = useState("");
    const [status, setStatus] = useState<string>("");
    const [busy, setBusy] = useState(false);
    const [testBusy, setTestBusy] = useState(false);
    const [activeRunId, setActiveRunId] = useState<string | null>(null);
    const [activeRunStatus, setActiveRunStatus] = useState<MacroRunStatus | null>(null);
    const [runLogRunId, setRunLogRunId] = useState<string | null>(null);
    const [runLogStatus, setRunLogStatus] = useState<MacroRunStatus | null>(null);
    const [runLogMessage, setRunLogMessage] = useState("");
    const [runLogs, setRunLogs] = useState<MacroRunLogEntry[]>([]);
    const [liveDeviceReady, setLiveDeviceReady] = useState(false);
    const [threshold, setThreshold] = useState("0.9");
    const [imageTestMode, setImageTestMode] = useState<"fast" | "precise">("fast");
    const [testAsset, setTestAsset] = useState("");
    const [testResult, setTestResult] = useState<string>("");
    const [liveDeviceWidth, setLiveDeviceWidth] = useState(() => {
        if (typeof window === "undefined") {
            return DEFAULT_LIVE_DEVICE_WIDTH;
        }
        const saved = Number(window.localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? "");
        if (Number.isFinite(saved)) {
            return Math.min(MAX_LIVE_DEVICE_WIDTH, Math.max(MIN_LIVE_DEVICE_WIDTH, saved));
        }
        return DEFAULT_LIVE_DEVICE_WIDTH;
    });

    const selectedMacro = useMemo(() => macros.find((m) => m.id === selectedMacroId) ?? null, [macros, selectedMacroId]);
    const scriptPaneWidth = 100 - liveDeviceWidth;

    const fetchMacros = async () => {
        const res = await fetch("/api/macros");
        const data = await res.json();
        setMacros(data);
    };

    const fetchAssets = async () => {
        const res = await fetch(`/api/macros/assets?ts=${Date.now()}`, { cache: "no-store" });
        const data = await res.json();
        setAssets(data);
    };

    const syncOnlineDevices = (data: DeviceBasicInfo[]) => {
        const online = data.filter((d) => d.state === "device" && (d.transportId ?? -1) >= 0);
        setDevices(online);
    };

    const fetchDevices = async () => {
        const res = await fetch("/api/adb/devices");
        if (!res.ok) {
            return;
        }
        const data = await res.json() as DeviceBasicInfo[];
        syncOnlineDevices(data);
    };

    useEffect(() => {
        void fetchMacros();
        void fetchAssets();
        void fetchDevices();
        let socket: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let disposed = false;
        let channel: BroadcastChannel | null = null;
        let reconnectAttempt = 0;

        const clearReconnectTimer = () => {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        const scheduleReconnect = () => {
            if (disposed) {
                return;
            }
            clearReconnectTimer();
            const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
            reconnectAttempt += 1;
            reconnectTimer = setTimeout(() => {
                connectDevicesSocket();
            }, delay);
        };

        const connectDevicesSocket = () => {
            if (disposed) {
                return;
            }

            clearReconnectTimer();
            try {
                socket = new WebSocket(`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/api/adb/devices`);
                socket.addEventListener("open", () => {
                    reconnectAttempt = 0;
                });
                socket.addEventListener("message", ({ data }) => {
                    try {
                        syncOnlineDevices(JSON.parse(data) as DeviceBasicInfo[]);
                    } catch {
                        void fetchDevices();
                    }
                });
                socket.addEventListener("close", () => {
                    if (!disposed) {
                        scheduleReconnect();
                    }
                });
                socket.addEventListener("error", () => {
                    socket?.close();
                });
            } catch {
                scheduleReconnect();
            }
        };

        connectDevicesSocket();
        const handleStorage = (event: StorageEvent) => {
            if (event.key === "macro_assets_refresh_at") {
                void fetchAssets();
            }
        };
        const handleAssetUpdated = () => { void fetchAssets(); };
        const handleFocus = () => { void fetchAssets(); };
        const handleMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) {
                return;
            }
            if (event.data && typeof event.data === "object" && event.data.type === "macro-assets-updated") {
                void fetchAssets();
            }
        };
        window.addEventListener("storage", handleStorage);
        window.addEventListener("macro-assets-updated", handleAssetUpdated as EventListener);
        window.addEventListener("focus", handleFocus);
        window.addEventListener("message", handleMessage);
        try {
            channel = new BroadcastChannel("macro-assets");
            channel.onmessage = () => { void fetchAssets(); };
        } catch {
            channel = null;
        }
        return () => {
            disposed = true;
            clearReconnectTimer();
            socket?.close();
            window.removeEventListener("storage", handleStorage);
            window.removeEventListener("macro-assets-updated", handleAssetUpdated as EventListener);
            window.removeEventListener("focus", handleFocus);
            window.removeEventListener("message", handleMessage);
            if (channel) {
                channel.close();
            }
        };
    }, []);

    useEffect(() => {
        if (devices.length === 0) {
            return;
        }
        const saved = localStorage.getItem("macro_editor_last_device_serial") ?? "";
        const online = devices.filter((d) => d.state === "device");
        const fallback = online[0]?.serial ?? devices[0]?.serial ?? "";
        const next = (saved && devices.some((d) => d.serial === saved)) ? saved : fallback;
        if (next && !selectedDeviceSerial) {
            setSelectedDeviceSerial(next);
        }
    }, [devices, selectedDeviceSerial]);

    useEffect(() => {
        if (!selectedDeviceSerial) return;
        localStorage.setItem("macro_editor_last_device_serial", selectedDeviceSerial);
    }, [selectedDeviceSerial]);

    useEffect(() => {
        setRunLogRunId(null);
        setRunLogStatus(null);
        setRunLogMessage("");
        setRunLogs([]);
    }, [selectedDeviceSerial]);

    useEffect(() => {
        setLiveDeviceReady(false);
        liveDeviceReadyRef.current = false;
    }, [selectedDeviceSerial]);

    useEffect(() => {
        liveDeviceReadyRef.current = liveDeviceReady;
    }, [liveDeviceReady]);

    useEffect(() => {
        if (!selectedMacro) {
            return;
        }
        setName(selectedMacro.name);
        setScript(extractScript(selectedMacro.content));
    }, [selectedMacro]);

    useEffect(() => {
        const raw = localStorage.getItem(IMPORT_STORAGE_KEY);
        if (!raw) {
            return;
        }
        try {
            const payload = JSON.parse(raw) as { name?: string; script?: string };
            if (typeof payload.script === "string" && payload.script.trim()) {
                setSelectedMacroId(null);
                setName(payload.name?.trim() ? payload.name : `Macro ${new Date().toLocaleString()}`);
                setScript(payload.script);
                setStatus("Imported script from docs");
            }
        } catch {
            // Ignore malformed import payload.
        } finally {
            localStorage.removeItem(IMPORT_STORAGE_KEY);
        }
    }, []);

    useEffect(() => {
        const handleLiveDeviceStatus = (event: Event) => {
            const payload = (event as CustomEvent).detail;
            if (!payload || typeof payload !== "object") {
                return;
            }
            const payloadSerial = typeof payload.serial === "string" ? payload.serial : "";
            if (payloadSerial !== selectedDeviceSerial) {
                return;
            }
            setLiveDeviceReady(Boolean(payload.ready));
        };

        window.addEventListener("macro-editor:live-device-status", handleLiveDeviceStatus as EventListener);
        return () => {
            window.removeEventListener("macro-editor:live-device-status", handleLiveDeviceStatus as EventListener);
        };
    }, [selectedDeviceSerial]);

    const resetEditor = () => {
        setSelectedMacroId(null);
        setName(`Macro ${new Date().toLocaleString()}`);
        setScript("");
        setStatus("");
    };

    const saveMacro = async () => {
        if (!name.trim()) {
            setStatus("Macro name is required");
            return;
        }
        try {
            parseMacroScript(script);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Invalid script");
            return;
        }

        setBusy(true);
        setStatus("");
        try {
            const payload = {
                name: name.trim(),
                content: JSON.stringify({ format: "script", source: script }),
            };
            const targetId = selectedMacroId;
            const res = await fetch(targetId ? `/api/macros/${targetId}` : "/api/macros", {
                method: targetId ? "PUT" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => null) as { error?: string; id?: number } | null;
            if (!res.ok) throw new Error(data?.error || `Save failed (${res.status})`);
            await fetchMacros();
            if (!targetId && data?.id) {
                setSelectedMacroId(data.id);
            }
            setStatus("Saved");
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Save failed");
        } finally {
            setBusy(false);
        }
    };

    const deleteMacro = async (id: number) => {
        if (!confirm("Delete this macro?")) return;
        const res = await fetch(`/api/macros/${id}`, { method: "DELETE" });
        if (!res.ok) return;
        await fetchMacros();
        if (selectedMacroId === id) {
            resetEditor();
        }
    };

    const uploadAssetFile = async (file: File) => {
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });

        const res = await fetch("/api/macros/assets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name, dataUrl }),
        });
        const data = await res.json().catch(() => null) as { error?: string; name?: string; url?: string } | null;
        if (!res.ok) {
            throw new Error(data?.error || `Upload failed (${res.status})`);
        }
        const savedName = data?.name;
        const savedUrl = data?.url;
        if (savedName && savedUrl) {
            setAssets((prev) => {
                const next = prev.filter((asset) => asset.name !== savedName);
                return [...next, { name: savedName, url: savedUrl }].sort((a, b) => a.name.localeCompare(b.name));
            });
        }
        const refreshAt = String(Date.now());
        localStorage.setItem("macro_assets_refresh_at", refreshAt);
        window.dispatchEvent(new CustomEvent("macro-assets-updated", { detail: { refreshAt } }));
        try {
            const channel = new BroadcastChannel("macro-assets");
            channel.postMessage({ type: "updated", refreshAt });
            channel.close();
        } catch {
            // Ignore BroadcastChannel unsupported environments.
        }
        await fetchAssets();
    };

    const deleteAsset = async (fileName: string) => {
        if (!confirm(`Delete ${fileName}?`)) return;
        setAssets((prev) => prev.filter((asset) => asset.name !== fileName));
        const res = await fetch(`/api/macros/assets/${encodeURIComponent(fileName)}`, { method: "DELETE" });
        if (!res.ok) {
            await fetchAssets();
            return;
        }
        const refreshAt = String(Date.now());
        localStorage.setItem("macro_assets_refresh_at", refreshAt);
        window.dispatchEvent(new CustomEvent("macro-assets-updated", { detail: { refreshAt } }));
        try {
            const channel = new BroadcastChannel("macro-assets");
            channel.postMessage({ type: "updated", refreshAt });
            channel.close();
        } catch {
            // Ignore BroadcastChannel unsupported environments.
        }
        await fetchAssets();
    };

    const testImageMatch = async () => {
        if (!selectedDeviceSerial || !testAsset) {
            setTestResult("Please choose device and template asset");
            return;
        }
        window.dispatchEvent(new CustomEvent("macro-editor:image-test-start", {
            detail: { serial: selectedDeviceSerial },
        }));

        const requestLiveFrameDataUrl = async () => {
            const requestId = `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            return await new Promise<string>((resolve, reject) => {
                const timeout = window.setTimeout(() => {
                    window.removeEventListener("macro-editor:capture-frame-result", handleReply as EventListener);
                    reject(new Error("Live Device did not return a frame"));
                }, 5000);

                const handleReply = (event: Event) => {
                    const payload = (event as CustomEvent).detail;
                    if (!payload || typeof payload !== "object") {
                        return;
                    }
                    if (payload.requestId !== requestId || payload.serial !== selectedDeviceSerial) {
                        return;
                    }

                    window.clearTimeout(timeout);
                    window.removeEventListener("macro-editor:capture-frame-result", handleReply as EventListener);
                    if (typeof payload.dataUrl === "string" && payload.dataUrl.length > 0) {
                        resolve(payload.dataUrl);
                        return;
                    }
                    reject(new Error(typeof payload.error === "string" ? payload.error : "Failed to capture live frame"));
                };

                window.addEventListener("macro-editor:capture-frame-result", handleReply as EventListener);
                window.dispatchEvent(new CustomEvent("macro-editor:capture-frame", {
                    detail: {
                        serial: selectedDeviceSerial,
                        requestId,
                    },
                }));
            });
        };

        try {
            const screenshotDataUrl = await requestLiveFrameDataUrl();
            const res = await fetch("/api/macros/image-match", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    screenshotDataUrl,
                    template: testAsset,
                    threshold: Number(threshold || "0.9"),
                    mode: imageTestMode,
                    preferredScale: imageTestBestScaleRef.current.get(`${testAsset}::${imageTestMode}`),
                }),
            });
            const data = await res.json().catch(() => null) as { found?: boolean; confidence?: number; x?: number; y?: number; centerX?: number; centerY?: number; scale?: number; error?: string; message?: string } | null;
            if (!res.ok || !data) {
                setTestResult(data?.error || data?.message || `Image test failed (${res.status})`);
                return;
            }
            const confidenceText = Number(data.confidence ?? 0).toFixed(3);
            const scaleText = Number(data.scale ?? 1).toFixed(2);
            if (data.found) {
                imageTestBestScaleRef.current.set(`${testAsset}::${imageTestMode}`, data.scale ?? 1);
                setTestResult(`FOUND at x=${data.x ?? 0}, y=${data.y ?? 0}, center=(${data.centerX ?? 0}, ${data.centerY ?? 0}), conf=${confidenceText}, scale=${scaleText}`);
            } else {
                setTestResult(`NOT FOUND (best x=${data.x ?? 0}, y=${data.y ?? 0}, conf=${confidenceText}, scale=${scaleText})`);
            }
        } catch (error) {
            setTestResult(error instanceof Error ? error.message : "Image test failed");
        } finally {
            window.dispatchEvent(new CustomEvent("macro-editor:image-test-end", {
                detail: { serial: selectedDeviceSerial },
            }));
        }
    };

    const testCurrentScript = async () => {
        if (!selectedDeviceSerial) {
            setStatus("Please choose a Live Device first");
            return;
        }

        try {
            parseMacroScript(script);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Invalid script");
            return;
        }

        setTestBusy(true);
        setActiveRunId(null);
        setActiveRunStatus(null);
        setRunLogRunId(null);
        setRunLogStatus(null);
        setRunLogMessage("");
        setRunLogs([]);
        setStatus("Starting server-side script run...");

        try {
            const startRes = await fetch("/api/macros/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    serial: selectedDeviceSerial,
                    source: script,
                    name: name.trim() || "Script Test",
                }),
            });
            const startData = await startRes.json().catch(() => null) as { error?: string; runId?: string; status?: MacroRunStatus } | null;
            if (!startRes.ok || !startData?.runId) {
                throw new Error(startData?.error || `Failed to start run (${startRes.status})`);
            }

            setActiveRunId(startData.runId);
            setActiveRunStatus("queued");
            setRunLogRunId(startData.runId);
            setRunLogStatus(startData.status ?? "queued");
            setRunLogMessage("Queued");
            setRunLogs([{ at: new Date().toISOString(), message: "Queued" }]);

            await new Promise<void>((resolve, reject) => {
                const startedAt = Date.now();
                let pausedAt = 0;
                let totalPausedMs = 0;
                const timer = window.setInterval(async () => {
                    try {
                        const res = await fetch(`/api/macros/run/${startData.runId}`);
                        const data = await res.json().catch(() => null) as { status?: MacroRunStatus; message?: string; error?: string; logs?: MacroRunLogEntry[] } | null;
                        if (!res.ok || !data) {
                            window.clearInterval(timer);
                            reject(new Error(data?.error || `Failed to poll run (${res.status})`));
                            return;
                        }

                        setRunLogStatus(data.status ?? null);
                        setRunLogMessage(data.message ?? "");
                        if (Array.isArray(data.logs)) {
                            setRunLogs(data.logs);
                        }

                        if (data.status === "paused") {
                            if (pausedAt === 0) {
                                pausedAt = Date.now();
                            }
                        } else if (pausedAt > 0) {
                            totalPausedMs += Date.now() - pausedAt;
                            pausedAt = 0;
                        }

                        if (data.status === "queued" || data.status === "running" || data.status === "paused") {
                            setActiveRunStatus(data.status);
                            setStatus(data.message || "Running on server...");
                            if (data.status !== "paused" && Date.now() - startedAt - totalPausedMs > 180000) {
                                window.clearInterval(timer);
                                reject(new Error("Script run timed out"));
                            }
                            return;
                        }
                        window.clearInterval(timer);
                        if (data.status === "completed") {
                            setStatus(data.message || "Script test completed");
                            resolve();
                            return;
                        }
                        reject(new Error(data.message || "Script run failed"));
                    } catch (error) {
                        window.clearInterval(timer);
                        reject(error instanceof Error ? error : new Error("Script run failed"));
                    }
                }, 1000);
            });
        } catch (error) {
            const failureMessage = error instanceof Error ? error.message : "Script test failed";
            setRunLogStatus("failed");
            setRunLogMessage(failureMessage);
            setStatus(error instanceof Error ? error.message : "Script test failed");
        } finally {
            setTestBusy(false);
            setActiveRunId(null);
            setActiveRunStatus(null);
        }
    };

    const toggleActiveRunPause = async () => {
        if (!activeRunId || !activeRunStatus) {
            return;
        }

        const action = activeRunStatus === "paused" ? "resume" : "pause";
        try {
            const response = await fetch(`/api/macros/run/${activeRunId}/${action}`, {
                method: "POST",
            });
            const data = await response.json().catch(() => null) as { error?: string; message?: string; status?: MacroRunStatus } | null;
            if (!response.ok) {
                throw new Error(data?.error || `Failed to ${action} run (${response.status})`);
            }
            if (data?.status) {
                setActiveRunStatus(data.status);
                setRunLogStatus(data.status);
            }
            setRunLogMessage(data?.message || (action === "pause" ? "Paused" : "Running"));
            setStatus(data?.message || (action === "pause" ? "Paused" : "Running"));
        } catch (error) {
            setStatus(error instanceof Error ? error.message : `Failed to ${action} run`);
        }
    };

    useEffect(() => {
        if (!name && selectedMacroId === null) {
            setName(`Macro ${new Date().toLocaleString()}`);
        }
    }, [name, selectedMacroId]);

    useEffect(() => {
        window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, String(liveDeviceWidth));
    }, [liveDeviceWidth]);

    useEffect(() => {
        const viewport = runLogViewportRef.current;
        if (!viewport) {
            return;
        }
        viewport.scrollTop = viewport.scrollHeight;
    }, [runLogs]);

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (activeResizePointerIdRef.current === null || event.pointerId !== activeResizePointerIdRef.current) {
                return;
            }
            const container = splitLayoutRef.current;
            if (!container) {
                return;
            }

            const rect = container.getBoundingClientRect();
            if (rect.width <= 0) {
                return;
            }

            const relativeX = event.clientX - rect.left;
            const nextWidth = (relativeX / rect.width) * 100;
            const clampedWidth = Math.min(MAX_LIVE_DEVICE_WIDTH, Math.max(MIN_LIVE_DEVICE_WIDTH, nextWidth));
            setLiveDeviceWidth(clampedWidth);
        };

        const stopResizing = () => {
            activeResizePointerIdRef.current = null;
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", stopResizing);
        window.addEventListener("pointercancel", stopResizing);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", stopResizing);
            window.removeEventListener("pointercancel", stopResizing);
        };
    }, []);

    return (
        <div className="mx-auto w-full max-w-none p-4 space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="icon" onClick={() => navigate(-1)}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div>
                        <h1 className="text-xl font-semibold">Macro Editor</h1>
                        <p className="text-sm text-muted-foreground">PC editing: script, assets, and image test</p>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => navigate("/macro-docs")}>
                        <BookText className="h-4 w-4 mr-2" /> Docs
                    </Button>
                    <Button variant="outline" onClick={resetEditor}>
                        <Plus className="h-4 w-4 mr-2" /> New
                    </Button>
                    <Button variant="outline" onClick={() => void testCurrentScript()} disabled={busy || testBusy}>
                        <Play className="h-4 w-4 mr-2" /> {testBusy ? "Testing..." : "Test Script"}
                    </Button>
                    {activeRunId && (
                        <Button variant="outline" onClick={() => void toggleActiveRunPause()} disabled={!activeRunStatus}>
                            {activeRunStatus === "paused"
                                ? <Play className="h-4 w-4 mr-2" />
                                : <PauseCircle className="h-4 w-4 mr-2" />}
                            {activeRunStatus === "paused" ? "Resume" : "Pause"}
                        </Button>
                    )}
                    <Button onClick={() => void saveMacro()} disabled={busy}>
                        <Save className="h-4 w-4 mr-2" /> {busy ? "Saving..." : "Save"}
                    </Button>
                </div>
            </div>

            <div className="hidden items-center justify-end gap-2 text-xs text-muted-foreground lg:flex">
                <span>Keo thanh o giua de thay doi kich thuoc hai khung.</span>
                <Button type="button" variant="ghost" size="sm" className="h-8 px-3 text-xs" onClick={() => setLiveDeviceWidth(78)}>
                    Video rong
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-8 px-3 text-xs" onClick={() => setLiveDeviceWidth(DEFAULT_LIVE_DEVICE_WIDTH)}>
                    Can bang
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-8 px-3 text-xs" onClick={() => setLiveDeviceWidth(46)}>
                    Code rong
                </Button>
            </div>

            <div
                ref={splitLayoutRef}
                className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,var(--live-pane))_0.75rem_minmax(0,var(--script-pane))]"
                style={{
                    ["--live-pane" as string]: `${liveDeviceWidth}fr`,
                    ["--script-pane" as string]: `${scriptPaneWidth}fr`,
                }}
            >
                <Card className="min-w-0">
                    <CardHeader>
                        <CardTitle>Live Device</CardTitle>
                        <CardDescription>Choose device and debug directly here. Status: {liveDeviceReady ? "Ready" : "Loading video..."}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <select
                            className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                            value={selectedDeviceSerial}
                            onChange={(e) => setSelectedDeviceSerial(e.target.value)}
                        >
                            <option value="">Select device</option>
                            {devices.map((device) => (
                                <option key={`${device.serial}-${device.transportId ?? -1}`} value={device.serial}>
                                    {(device.model || "Unknown")} - {device.serial}
                                </option>
                            ))}
                        </select>
                        {selectedDeviceSerial ? (
                            <div className="flex h-[72vh] min-h-[28rem] max-h-[48rem] items-center justify-center rounded-md border bg-background overflow-hidden">
                                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading live device...</div>}>
                                    <DeviceDetail serialOverride={selectedDeviceSerial} embedded />
                                </Suspense>
                            </div>
                        ) : (
                            <div className="text-sm text-muted-foreground py-6">Select a device to open live view.</div>
                        )}
                        <div className="overflow-hidden rounded-md border bg-muted/20">
                            <div className="flex items-start justify-between gap-3 border-b bg-background/80 px-3 py-2">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">Macro Run Log</div>
                                    <div className="text-[11px] text-muted-foreground">
                                        {runLogStatus
                                            ? `Status: ${runLogStatus.toUpperCase()}${runLogMessage ? ` - ${runLogMessage}` : ""}`
                                            : "Chua co lan chay macro nao tren server."}
                                    </div>
                                </div>
                                {runLogRunId && (
                                    <div className="shrink-0 text-[10px] font-mono text-muted-foreground">
                                        {runLogRunId.slice(0, 8)}
                                    </div>
                                )}
                            </div>
                            <div
                                ref={runLogViewportRef}
                                className="h-44 overflow-y-auto px-3 py-2 font-mono text-[11px]"
                            >
                                {runLogs.length > 0 ? (
                                    <div className="space-y-1">
                                        {runLogs.map((entry, index) => (
                                            <div key={`${entry.at}-${index}`} className="whitespace-pre-wrap break-words text-foreground/90">
                                                <span className="mr-2 text-muted-foreground">
                                                    {new Date(entry.at).toLocaleTimeString()}
                                                </span>
                                                <span>{entry.message}</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-xs text-muted-foreground">
                                        Chay script tren server de xem tung buoc macro da thuc hien o day.
                                    </div>
                                )}
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <div
                    className="hidden cursor-col-resize items-center justify-center rounded-md border border-dashed border-border bg-muted/40 text-muted-foreground transition hover:bg-muted/70 lg:flex"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize live device and script panels"
                    onPointerDown={(event) => {
                        activeResizePointerIdRef.current = event.pointerId;
                        event.preventDefault();
                    }}
                >
                    <GripVertical className="h-4 w-4" />
                </div>

                <Card className="min-w-0">
                    <CardHeader>
                        <CardTitle>Simple Script</CardTitle>
                        <CardDescription>Supports WAIT, TAP, TAP_MATCH, DRAG, KEY, IF PIXEL, IF IMAGE, label:, GOTO, FOR EACH, BREAK, EXIT</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="space-y-2">
                            <div className="text-sm font-medium">Macros</div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                                <select
                                    className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                                    value={selectedMacroId?.toString() ?? ""}
                                    onChange={(e) => {
                                        const nextValue = e.target.value;
                                        setSelectedMacroId(nextValue ? Number(nextValue) : null);
                                    }}
                                >
                                    <option value="">New macro</option>
                                    {macros.map((macro) => (
                                        <option key={macro.id} value={macro.id}>
                                            {macro.name}
                                        </option>
                                    ))}
                                </select>
                                {selectedMacroId !== null && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="shrink-0 text-destructive hover:text-destructive"
                                        onClick={() => void deleteMacro(selectedMacroId)}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                                    </Button>
                                )}
                            </div>
                            {selectedMacro && (
                                <div className="text-xs text-muted-foreground">
                                    Last updated: {new Date(selectedMacro.createdAt).toLocaleString()}
                                </div>
                            )}
                        </div>
                        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Macro name" />
                        <textarea
                            className="w-full min-h-[60vh] rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            value={script}
                            onChange={(e) => setScript(e.target.value)}
                        />
                        <div className="flex items-center gap-2">
                            <Button variant="outline" onClick={() => {
                                try {
                                    parseMacroScript(script);
                                    setStatus("Syntax OK");
                                } catch (error) {
                                    setStatus(error instanceof Error ? error.message : "Invalid syntax");
                                }
                            }}>
                                <Play className="h-4 w-4 mr-2" /> Test Syntax
                            </Button>
                            {status && <span className="text-sm text-muted-foreground">{status}</span>}
                        </div>
                    </CardContent>
                </Card>

                <Card className="lg:col-span-12">
                    <CardHeader>
                        <CardTitle>Image Assets</CardTitle>
                        <CardDescription>Upload template, copy URL, test match</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Input
                            type="file"
                            accept="image/png"
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                void uploadAssetFile(file).catch((error) => {
                                    setStatus(error instanceof Error ? error.message : "Upload failed");
                                });
                                e.currentTarget.value = "";
                            }}
                        />
                        <div className="max-h-48 overflow-y-auto space-y-2">
                            {assets.map((asset) => (
                                <div key={asset.name} className="rounded border p-2 space-y-2">
                                    <img src={asset.url} className="h-14 w-full object-contain rounded bg-muted" />
                                    <div className="text-xs truncate">{asset.name}</div>
                                    {asset.region && (
                                        <div className="text-[10px] text-muted-foreground break-all">
                                            REGION {asset.region.x} {asset.region.y} {asset.region.width} {asset.region.height}
                                        </div>
                                    )}
                                    <div className="flex gap-1">
                                        <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => {
                                            navigator.clipboard.writeText(asset.url).catch(() => null);
                                        }}>
                                            <Copy className="h-3 w-3" />
                                        </Button>
                                        {asset.region && (
                                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => {
                                                navigator.clipboard.writeText(`REGION ${asset.region!.x} ${asset.region!.y} ${asset.region!.width} ${asset.region!.height}`).catch(() => null);
                                            }}>
                                                REGION
                                            </Button>
                                        )}
                                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => {
                                            setScript((prev) => `${prev}${prev.trim().length > 0 ? "\n" : ""}${buildAssetImageScript(asset)}`);
                                        }}>
                                            Insert
                                        </Button>
                                        <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => void deleteAsset(asset.name)}>
                                            <Trash2 className="h-3 w-3" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="pt-2 border-t space-y-2">
                            <div className="text-xs font-medium">Image Match Test (Live Device)</div>
                            <div className="text-[11px] text-muted-foreground">
                                Device: {selectedDeviceSerial || "Not selected"}
                            </div>
                            <div className="space-y-1">
                                <div className="text-[11px] text-muted-foreground">Template Asset</div>
                                <select
                                    className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                                    value={testAsset}
                                    onChange={(e) => setTestAsset(e.target.value)}
                                >
                                    <option value="">Select template</option>
                                    {assets.map((asset) => (
                                        <option key={`template-${asset.name}`} value={asset.url}>{asset.name}</option>
                                    ))}
                                </select>
                                {testAsset && <img src={testAsset} className="h-20 w-full object-contain rounded border bg-muted" />}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <Input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="0.9" />
                                <select
                                    className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                                    value={imageTestMode}
                                    onChange={(e) => setImageTestMode((e.target.value === "precise" ? "precise" : "fast"))}
                                >
                                    <option value="fast">FAST</option>
                                    <option value="precise">PRECISE</option>
                                </select>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                                FAST nhanh hon cho icon on dinh. PRECISE quet ky hon khi match kho.
                            </div>
                            <Button variant="outline" className="w-full" onClick={() => void testImageMatch()} disabled={!selectedDeviceSerial || !testAsset}>
                                <Upload className="h-4 w-4 mr-2" /> Run Test
                            </Button>
                            {testResult && <div className="text-xs text-muted-foreground break-all">{testResult}</div>}
                        </div>
                    </CardContent>
                </Card>

            </div>
        </div>
    );
}

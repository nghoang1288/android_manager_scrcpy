import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Smartphone } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import DeviceDetail from "./DeviceDetail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

function getGridClass(count: number) {
    if (count <= 1) {
        return "grid-cols-1";
    }

    if (count === 2) {
        return "grid-cols-1 xl:grid-cols-2";
    }

    if (count <= 4) {
        return "grid-cols-1 lg:grid-cols-2";
    }

    if (count <= 6) {
        return "grid-cols-1 md:grid-cols-2 2xl:grid-cols-3";
    }

    return "grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";
}

export default function MultiDeviceView() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [syncTapEnabled, setSyncTapEnabled] = useState(true);
    const [syncControlsEnabled, setSyncControlsEnabled] = useState(true);
    const syncAdaptersRef = useState(() => new Map<string, {
        injectNormalizedTouch: (action: number, normalizedX: number, normalizedY: number) => void;
        triggerControlAction: (payload: { type: 'key' | 'screen_power'; keyCode?: number; screenPowerMode?: number }) => void;
    }>())[0];

    const serials = useMemo(() => {
        const fromRepeatedParams = searchParams
            .getAll("serial")
            .map((value) => value.trim())
            .filter(Boolean);

        const fromCsv = (searchParams.get("serials") ?? "")
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);

        return Array.from(new Set([...fromRepeatedParams, ...fromCsv]));
    }, [searchParams]);

    const [masterSerial, setMasterSerial] = useState("");

    useEffect(() => {
        if (serials.length === 0) {
            setMasterSerial("");
            return;
        }

        if (masterSerial && !serials.includes(masterSerial)) {
            setMasterSerial("");
        }
    }, [masterSerial, serials]);

    const handleLiveTouchEvent = useCallback((payload: {
        serial: string;
        action: number;
        pointerX: number;
        pointerY: number;
        videoWidth: number;
        videoHeight: number;
    }) => {
        if (!syncTapEnabled) {
            return;
        }

        if (masterSerial && payload.serial !== masterSerial) {
            return;
        }

        if (![0, 1, 2].includes(payload.action)) {
            return;
        }

        const normalizedX = payload.videoWidth > 0 ? payload.pointerX / payload.videoWidth : 0;
        const normalizedY = payload.videoHeight > 0 ? payload.pointerY / payload.videoHeight : 0;

        for (const serial of serials) {
            if (serial === payload.serial) {
                continue;
            }
            syncAdaptersRef.get(serial)?.injectNormalizedTouch(payload.action, normalizedX, normalizedY);
        }
    }, [masterSerial, serials, syncAdaptersRef, syncTapEnabled]);

    const handleControlAction = useCallback((payload: {
        serial: string;
        type: 'key' | 'screen_power';
        keyCode?: number;
        screenPowerMode?: number;
    }) => {
        if (!syncControlsEnabled) {
            return;
        }

        if (masterSerial && payload.serial !== masterSerial) {
            return;
        }

        for (const serial of serials) {
            if (serial === payload.serial) {
                continue;
            }
            syncAdaptersRef.get(serial)?.triggerControlAction({
                type: payload.type,
                keyCode: payload.keyCode,
                screenPowerMode: payload.screenPowerMode,
            });
        }
    }, [masterSerial, serials, syncAdaptersRef, syncControlsEnabled]);

    const registerSyncAdapter = useCallback((serial: string, adapter: {
        injectNormalizedTouch: (action: number, normalizedX: number, normalizedY: number) => void;
        triggerControlAction: (payload: { type: 'key' | 'screen_power'; keyCode?: number; screenPowerMode?: number }) => void;
    } | null) => {
        if (adapter) {
            syncAdaptersRef.set(serial, adapter);
        } else {
            syncAdaptersRef.delete(serial);
        }
    }, [syncAdaptersRef]);

    return (
        <div className="h-[100dvh] w-full overflow-hidden bg-muted/20 p-2 md:p-3">
            <div className="flex h-full flex-col gap-2 md:gap-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="min-w-0">
                            <div className="font-medium">Multi Device Control</div>
                            <div className="text-xs text-muted-foreground">
                                {serials.length} device{serials.length === 1 ? "" : "s"} selected, default quality: Low
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                            <span className="text-xs font-medium">Master</span>
                            <select
                                value={masterSerial}
                                onChange={(e) => setMasterSerial(e.target.value)}
                                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                            >
                                <option value="">Any device</option>
                                {serials.map((serial) => (
                                    <option key={serial} value={serial}>
                                        {serial}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                            <span className="text-xs font-medium">Sync Touch</span>
                            <Switch checked={syncTapEnabled} onCheckedChange={setSyncTapEnabled} />
                        </div>
                        <div className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                            <span className="text-xs font-medium">Sync Controls</span>
                            <Switch checked={syncControlsEnabled} onCheckedChange={setSyncControlsEnabled} />
                        </div>
                    </div>
                </div>

                {serials.length === 0 ? (
                    <Card className="flex-1">
                        <CardHeader>
                            <CardTitle>No Devices Selected</CardTitle>
                            <CardDescription>Select devices from the main list, then use Open Selected.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <Button onClick={() => navigate("/")}>Back to Device List</Button>
                        </CardContent>
                    </Card>
                ) : (
                    <div className={`grid min-h-0 flex-1 gap-2 md:gap-3 ${getGridClass(serials.length)}`} style={{ gridAutoRows: "minmax(0, 1fr)" }}>
                        {serials.map((serial) => (
                            <div key={serial} className="min-h-0 overflow-hidden rounded-lg border bg-background shadow-sm">
                                <div className="flex h-full min-h-0 flex-col">
                                    <div className="flex items-center gap-2 border-b px-3 py-2">
                                        <Smartphone className="h-4 w-4 text-muted-foreground" />
                                        <code className="truncate text-xs">{serial}</code>
                                    </div>
                                    <div className="min-h-0 flex-1">
                                        <DeviceDetail
                                            serialOverride={serial}
                                            embedded
                                            autoQuality={false}
                                            defaultQuality="low"
                                            onLiveTouchEvent={handleLiveTouchEvent}
                                            onControlAction={handleControlAction}
                                            registerSyncAdapter={registerSyncAdapter}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

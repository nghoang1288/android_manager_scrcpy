import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom'
import { Smartphone, AlertCircle, ArrowUpRightIcon, Terminal, Folder, Plus, FileCode2, BookText, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'
import { Skeleton } from './components/ui/skeleton'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Checkbox } from './components/ui/checkbox';
import type { DeviceBasicInfo } from './types/device.types';
import { APP_VERSION } from './version';

const DeviceDetail = lazy(() => import('./scrcpy/DeviceDetail'));
const MultiDeviceView = lazy(() => import('./scrcpy/MultiDeviceView'));
const MacroEditor = lazy(() => import('./macro/MacroEditor'));
const MacroScriptDocs = lazy(() => import('./macro/MacroScriptDocs'));

function RouteFallback() {
    return (
        <div className="min-h-screen bg-background p-4 md:p-6">
            <Card className="max-w-4xl mx-auto">
                <CardHeader>
                    <CardTitle>Loading page</CardTitle>
                    <CardDescription>Preparing the requested view.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Skeleton className="h-8 w-48" />
                    <Skeleton className="h-48 w-full" />
                    <Skeleton className="h-24 w-full" />
                </CardContent>
            </Card>
        </div>
    );
}

function LazyRoute({ children }: { children: ReactNode }) {
    return (
        <Suspense fallback={<RouteFallback />}>
            {children}
        </Suspense>
    );
}

// Device status mapping
const getDeviceStateBadge = (state: string) => {
    const stateMap: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline', label: string }> = {
        'device': { variant: 'default', label: 'Online' },
        'offline': { variant: 'destructive', label: 'Offline' },
        'unauthorized': { variant: 'outline', label: 'Unauthorized' },
    };
    return stateMap[state] || { variant: 'secondary', label: state };
};

// Device List Component
function DeviceList() {
    const navigate = useNavigate();
    const [devices, setDevices] = useState<DeviceBasicInfo[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string>();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [serialInput, setSerialInput] = useState('');
    const [pairAddressInput, setPairAddressInput] = useState('');
    const [pairCodeInput, setPairCodeInput] = useState('');
    const [connectBusy, setConnectBusy] = useState(false);
    const [pairBusy, setPairBusy] = useState(false);
    const [connectError, setConnectError] = useState<string | null>(null);
    const [selectedSerials, setSelectedSerials] = useState<string[]>([]);
    const [reconnectingSerials, setReconnectingSerials] = useState<string[]>([]);
    const reconnectCooldownRef = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        let socket: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectAttempts = 0;
        let disposed = false;

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
            const baseDelay = Math.min(1000 * 2 ** reconnectAttempts, 15000);
            const jitter = Math.floor(Math.random() * 500);
            reconnectAttempts += 1;
            const delay = baseDelay + jitter;
            setError(`WebSocket disconnected, retrying in ${(delay / 1000).toFixed(1)}s...`);
            reconnectTimer = setTimeout(() => {
                connect();
            }, delay);
        };

        const connect = () => {
            if (disposed) {
                return;
            }
            clearReconnectTimer();

            try {
                socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/adb/devices`);

                socket.addEventListener('open', () => {
                    reconnectAttempts = 0;
                    setIsLoading(false);
                    setError(undefined);
                });

                socket.addEventListener('message', ({ data }) => {
                    try {
                        setDevices(JSON.parse(data));
                        setIsLoading(false);
                    } catch (err) {
                        setError('Failed to parse device data: ' + err);
                    }
                });

                socket.addEventListener('error', () => {
                    setIsLoading(false);
                });

                socket.addEventListener('close', () => {
                    if (disposed) {
                        return;
                    }
                    scheduleReconnect();
                });
            } catch (err) {
                setError('Could not establish WebSocket connection: ' + err);
                setIsLoading(false);
                scheduleReconnect();
            }
        };

        connect();

        return () => {
            disposed = true;
            clearReconnectTimer();
            socket?.close();
        };
    }, []);

    // Show all devices (no filtering)
    const filteredDevices = devices;
    const selectableDevices = useMemo(
        () => filteredDevices.filter((device) => (device.transportId ?? -1) >= 0 && device.state === 'device'),
        [filteredDevices]
    );
    const selectedSelectableCount = selectedSerials.filter((serial) => selectableDevices.some((device) => device.serial === serial)).length;
    const allSelectableSelected = selectableDevices.length > 0 && selectedSelectableCount === selectableDevices.length;

    useEffect(() => {
        setSelectedSerials((prev) => prev.filter((serial) => selectableDevices.some((device) => device.serial === serial)));
    }, [selectableDevices]);

    const resetAddDeviceDialog = () => {
        setDialogOpen(false);
        setSerialInput('');
        setPairAddressInput('');
        setPairCodeInput('');
        setConnectError(null);
    };

    const isIpPortAddress = (value: string) => /^\s*[^:\s]+:\d+\s*$/.test(value);
    const isWirelessDevice = (device: DeviceBasicInfo) => isIpPortAddress(device.serial);
    const offlineWirelessDevices = filteredDevices.filter((device) => isWirelessDevice(device) && device.state !== 'device');

    const reconnectWirelessDevice = async (address: string, mode: 'manual' | 'auto' = 'manual') => {
        if (!isIpPortAddress(address) || reconnectingSerials.includes(address)) {
            return;
        }

        setReconnectingSerials((prev) => prev.includes(address) ? prev : [...prev, address]);
        reconnectCooldownRef.current.set(address, Date.now());

        try {
            const res = await fetch('/api/adb/wireless/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address }),
            });
            const data = await res.json().catch(() => null) as { error?: string; success?: boolean } | null;
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || `Reconnect failed (${res.status})`);
            }
        } catch (error) {
            if (mode === 'manual') {
                setError(error instanceof Error ? error.message : 'Reconnect failed');
            } else {
                console.warn(`Auto reconnect failed for ${address}:`, error);
            }
        } finally {
            setReconnectingSerials((prev) => prev.filter((serial) => serial !== address));
        }
    };

    const toggleSelectedDevice = (serial: string, checked: boolean) => {
        setSelectedSerials((prev) => {
            if (checked) {
                return prev.includes(serial) ? prev : [...prev, serial];
            }
            return prev.filter((item) => item !== serial);
        });
    };

    const handleToggleAllDevices = (checked: boolean) => {
        setSelectedSerials(checked ? selectableDevices.map((device) => device.serial) : []);
    };

    const handleOpenSelectedDevices = () => {
        if (selectedSerials.length === 0) {
            return;
        }

        const params = new URLSearchParams();
        for (const serial of selectedSerials) {
            params.append('serial', serial);
        }
        navigate(`/devices?${params.toString()}`);
    };

    const handleReconnectAllOfflineWireless = async () => {
        for (const device of offlineWirelessDevices) {
            await reconnectWirelessDevice(device.serial, 'manual');
        }
    };

    useEffect(() => {
        for (const device of offlineWirelessDevices.filter((item) => !reconnectingSerials.includes(item.serial))) {
            const lastAttemptAt = reconnectCooldownRef.current.get(device.serial) ?? 0;
            if (Date.now() - lastAttemptAt < 15000) {
                continue;
            }
            void reconnectWirelessDevice(device.serial, 'auto');
        }
    }, [offlineWirelessDevices, reconnectingSerials]);

    const handleDirectConnect = async () => {
        const address = serialInput.trim();
        if (!address) return;
        if (!isIpPortAddress(address)) {
            setConnectError('Connect Address must be in IP:PORT format, for example 192.168.1.20:39137');
            return;
        }

        setConnectBusy(true);
        setConnectError(null);
        try {
            const res = await fetch('/api/adb/wireless/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address }),
            });
            const data = await res.json().catch(() => null) as { error?: string; success?: boolean } | null;
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || `Connect failed (${res.status})`);
            }

            navigate(`/device/${encodeURIComponent(address)}`);
            resetAddDeviceDialog();
        } catch (error) {
            setConnectError(error instanceof Error ? error.message : 'Connect failed');
        } finally {
            setConnectBusy(false);
        }
    };

    const handlePairAndConnect = async () => {
        const pairAddress = pairAddressInput.trim();
        const pairingCode = pairCodeInput.trim();
        const connectAddress = serialInput.trim();
        if (!pairAddress || !pairingCode || !connectAddress) return;
        if (!isIpPortAddress(pairAddress)) {
            setConnectError('Pair Address must be IP:PAIR_PORT, for example 192.168.1.20:37099');
            return;
        }
        if (!isIpPortAddress(connectAddress)) {
            setConnectError('Connect Address must be IP:PORT, for example 192.168.1.20:39137');
            return;
        }

        setPairBusy(true);
        setConnectError(null);
        try {
            const res = await fetch('/api/adb/wireless/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pairAddress,
                    pairingCode,
                    connectAddress,
                }),
            });
            const data = await res.json().catch(() => null) as { error?: string; success?: boolean } | null;
            if (!res.ok || !data?.success) {
                throw new Error(data?.error || `Pair failed (${res.status})`);
            }

            navigate(`/device/${encodeURIComponent(connectAddress)}`);
            resetAddDeviceDialog();
        } catch (error) {
            setConnectError(error instanceof Error ? error.message : 'Pair failed');
        } finally {
            setPairBusy(false);
        }
    };

    return (
        <div className="container mx-auto p-6 max-w-7xl space-y-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="flex items-center gap-2">
                                <span>Device Management</span>
                                <span className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
                                    {APP_VERSION}
                                </span>
                            </CardTitle>
                            <CardDescription>
                                ADB devices connected to the server
                            </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => navigate('/macro-docs')}>
                                <BookText className="h-4 w-4 mr-2" />
                                Macro Docs
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => navigate('/macro-editor')}>
                                <FileCode2 className="h-4 w-4 mr-2" />
                                Macro Editor
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={offlineWirelessDevices.length === 0}
                                onClick={() => void handleReconnectAllOfflineWireless()}
                            >
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Reconnect Offline Wi-Fi ({offlineWirelessDevices.length})
                            </Button>
                            <Button
                                variant="default"
                                size="sm"
                                disabled={selectedSerials.length === 0}
                                onClick={handleOpenSelectedDevices}
                            >
                                <Smartphone className="h-4 w-4 mr-2" />
                                Open Selected ({selectedSerials.length})
                            </Button>
                            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                                <DialogTrigger asChild>
                                    <Button variant="outline" size="sm">
                                        <Plus className="h-4 w-4 mr-2" />
                                        Add Device
                                    </Button>
                                </DialogTrigger>
                                <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>Add Device</DialogTitle>
                                    <DialogDescription>
                                        Direct connect or pair Wireless Debugging from web.
                                    </DialogDescription>
                                </DialogHeader>
                                <div className="grid gap-4 py-4">
                                    <div className="grid gap-2">
                                        <Label htmlFor="serial">Connect Address (IP:PORT)</Label>
                                        <Input
                                            id="serial"
                                            placeholder="192.168.50.206:39137"
                                            value={serialInput}
                                            onChange={(e) => setSerialInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && serialInput.trim()) {
                                                    void handleDirectConnect();
                                                }
                                            }}
                                        />
                                    </div>
                                    <div className="rounded-md border p-3 space-y-2">
                                        <p className="text-xs font-medium">Wireless Pair (Android 11+)</p>
                                        <div className="grid gap-2">
                                            <Label htmlFor="pairAddress" className="text-xs">Pair Address (IP:PAIR_PORT)</Label>
                                            <Input
                                                id="pairAddress"
                                                placeholder="192.168.50.206:36945"
                                                value={pairAddressInput}
                                                onChange={(e) => setPairAddressInput(e.target.value)}
                                            />
                                        </div>
                                        <div className="grid gap-2">
                                            <Label htmlFor="pairCode" className="text-xs">Pairing Code</Label>
                                            <Input
                                                id="pairCode"
                                                placeholder="123456"
                                                value={pairCodeInput}
                                                onChange={(e) => setPairCodeInput(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                    {connectError && (
                                        <div className="rounded border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                                            {connectError}
                                        </div>
                                    )}
                                </div>
                                <DialogFooter>
                                    <Button
                                        variant="outline"
                                        onClick={resetAddDeviceDialog}
                                        disabled={connectBusy || pairBusy}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        variant="outline"
                                        onClick={() => void handlePairAndConnect()}
                                        disabled={!serialInput.trim() || !pairAddressInput.trim() || !pairCodeInput.trim() || connectBusy || pairBusy}
                                    >
                                        {pairBusy ? 'Pairing...' : 'Pair + Connect'}
                                    </Button>
                                    <Button
                                        onClick={() => void handleDirectConnect()}
                                        disabled={!serialInput.trim() || connectBusy || pairBusy}
                                    >
                                        {connectBusy ? 'Connecting...' : 'Connect'}
                                    </Button>
                                </DialogFooter>
                                </DialogContent>
                            </Dialog>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <div className="space-y-2">
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-16 w-full" />
                            <Skeleton className="h-16 w-full" />
                            <Skeleton className="h-16 w-full" />
                        </div>
                    ) : error ? (
                        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-destructive" />
                            <p className="text-sm text-destructive font-medium">{error}</p>
                        </div>
                    ) : filteredDevices && filteredDevices.length > 0 ? (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-12 text-center">
                                        <Checkbox
                                            checked={allSelectableSelected}
                                            onCheckedChange={(checked) => handleToggleAllDevices(Boolean(checked))}
                                            aria-label="Select all online devices"
                                            disabled={selectableDevices.length === 0}
                                        />
                                    </TableHead>
                                    <TableHead>Model</TableHead>
                                    <TableHead className="text-center">Actions</TableHead>
                                    <TableHead>Serial</TableHead>
                                    <TableHead className="text-center">Transport ID</TableHead>
                                    <TableHead className="text-center">Status</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filteredDevices.map((device) => (
                                    <TableRow key={device.serial + device.transportId?.toString()}>
                                        <TableCell className="text-center">
                                            <Checkbox
                                                checked={selectedSerials.includes(device.serial)}
                                                onCheckedChange={(checked) => toggleSelectedDevice(device.serial, Boolean(checked))}
                                                aria-label={`Select ${device.model || device.serial}`}
                                                disabled={(device.transportId ?? -1) < 0 || device.state !== 'device'}
                                            />
                                        </TableCell>
                                        <TableCell className="font-medium">{device.model || 'Unknown Device'}</TableCell>
                                        <TableCell className="text-center">
                                            <div className="flex items-center justify-center gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="icon"
                                                    className="h-8 w-8"
                                                    disabled={(device.transportId ?? -1) < 0}
                                                    title={(device.transportId ?? -1) < 0 ? 'Device is not currently connected to ADB on the server' : 'Open device'}
                                                    onClick={() => navigate(`/device/${encodeURIComponent(device.serial)}`)}
                                                >
                                                    <Smartphone className="h-4 w-4" />
                                                </Button>
                                                <Button variant="outline" size="icon" className="h-8 w-8">
                                                    <Terminal className="h-4 w-4" />
                                                </Button>
                                                <Button variant="outline" size="icon" className="h-8 w-8">
                                                    <Folder className="h-4 w-4" />
                                                </Button>
                                                {isWirelessDevice(device) && device.state !== 'device' && (
                                                    <Button
                                                        variant="outline"
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        title="Reconnect wireless device"
                                                        onClick={() => void reconnectWirelessDevice(device.serial, 'manual')}
                                                        disabled={reconnectingSerials.includes(device.serial)}
                                                    >
                                                        <RefreshCw className={`h-4 w-4 ${reconnectingSerials.includes(device.serial) ? 'animate-spin' : ''}`} />
                                                    </Button>
                                                )}
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <code className="text-xs bg-muted px-2 py-1 rounded">
                                                {device.serial}
                                            </code>
                                        </TableCell>
                                        <TableCell className="text-center text-muted-foreground">
                                            {device.transportId}
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center justify-center gap-1">
                                                <Badge className="size-2 rounded-full p-0" variant={getDeviceStateBadge(device.state).variant} />
                                                <span>{getDeviceStateBadge(device.state).label}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {isWirelessDevice(device) ? '(Wi-Fi)' : '(USB)'}
                                                </span>
                                                {reconnectingSerials.includes(device.serial) && (
                                                    <span className="text-xs text-amber-600">(reconnecting...)</span>
                                                )}
                                                {(device.transportId ?? -1) < 0 && (
                                                    <span className="text-xs text-muted-foreground">(stored only)</span>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    ) : (
                        <Empty>
                            <EmptyHeader>
                                <EmptyMedia variant="icon">
                                    <Smartphone className="h-6 w-6 text-muted-foreground" />
                                </EmptyMedia>
                                <EmptyTitle>No Devices Found</EmptyTitle>
                                <EmptyDescription>Please ensure usage of ADB or refresh the page</EmptyDescription>
                            </EmptyHeader>
                            <EmptyContent>
                                <div className="flex gap-2">
                                    <Button onClick={() => window.location.reload()}>Refresh</Button>
                                    <Button variant="outline">Connection Guide</Button>
                                </div>
                            </EmptyContent>
                            <Button
                                variant="link"
                                asChild
                                className="text-muted-foreground"
                                size="sm">
                                <a href="#">
                                    Learn More <ArrowUpRightIcon />
                                </a>
                            </Button>
                        </Empty>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}

// 主 App 组件
function App() {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<DeviceList />} />
                <Route path="/device/:serial" element={<LazyRoute><DeviceDetail /></LazyRoute>} />
                <Route path="/devices" element={<LazyRoute><MultiDeviceView /></LazyRoute>} />
                <Route path="/macro-editor" element={<LazyRoute><MacroEditor /></LazyRoute>} />
                <Route path="/macro-docs" element={<LazyRoute><MacroScriptDocs /></LazyRoute>} />
            </Routes>
        </Router>
    )
}

export default App

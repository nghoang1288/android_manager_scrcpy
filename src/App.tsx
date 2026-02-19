import { useEffect, useState } from 'react'
import { BrowserRouter as Router, Routes, Route, useNavigate } from 'react-router-dom'
import { Smartphone, AlertCircle, ArrowUpRightIcon, Terminal, Folder, Plus, Globe, Copy, Check } from 'lucide-react'
import DeviceDetail from './scrcpy/DeviceDetail'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table'
import { Skeleton } from './components/ui/skeleton'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty";
import { Button } from "@/components/ui/button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import type { DeviceBasicInfo } from './types/device.types';

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
    const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
    const [copiedTunnel, setCopiedTunnel] = useState(false);

    useEffect(() => {
        let socket: WebSocket | null = null;

        try {
            socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/adb/devices`);

            socket.addEventListener('open', () => {
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
                setError('WebSocket connection failed');
                setIsLoading(false);
            });

            socket.addEventListener('close', () => {
                setError('WebSocket disconnected');
            });
        } catch (err) {
            setError('Could not establish WebSocket connection: ' + err);
            setIsLoading(false);
        }

        return () => {
            socket?.close();
        };
    }, []);

    // Fetch tunnel URL
    useEffect(() => {
        const fetchTunnelUrl = async () => {
            try {
                const res = await fetch('/api/tunnel/url');
                const data = await res.json();
                if (data.available && data.url) {
                    setTunnelUrl(data.url);
                }
            } catch {
                // Tunnel not available, that's fine
            }
        };
        fetchTunnelUrl();
        // Re-check every 15 seconds in case tunnel starts later
        const timer = setInterval(fetchTunnelUrl, 15000);
        return () => clearInterval(timer);
    }, []);

    const copyTunnelUrl = () => {
        if (tunnelUrl) {
            navigator.clipboard.writeText(tunnelUrl);
            setCopiedTunnel(true);
            setTimeout(() => setCopiedTunnel(false), 2000);
        }
    };

    // Show all devices (no filtering)
    const filteredDevices = devices;

    return (
        <div className="container mx-auto p-6 max-w-7xl space-y-4">
            {/* Tunnel URL Banner */}
            {tunnelUrl && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 p-3 flex items-center gap-3">
                    <Globe className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-blue-900 dark:text-blue-100">Cloudflare Tunnel Active</p>
                        <a href={tunnelUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate block">
                            {tunnelUrl}
                        </a>
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={copyTunnelUrl} title="Copy URL">
                        {copiedTunnel ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                    </Button>
                </div>
            )}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle>Device Management</CardTitle>
                            <CardDescription>
                                ADB devices connected to the server
                            </CardDescription>
                        </div>
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
                                        Enter device IP and port (e.g., 192.168.1.100:5555)
                                    </DialogDescription>
                                </DialogHeader>
                                <div className="grid gap-4 py-4">
                                    <div className="grid gap-2">
                                        <Label htmlFor="serial">Device Address</Label>
                                        <Input
                                            id="serial"
                                            placeholder="192.168.1.100:5555"
                                            value={serialInput}
                                            onChange={(e) => setSerialInput(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && serialInput.trim()) {
                                                    navigate(`/device/${serialInput.trim()}`);
                                                    setDialogOpen(false);
                                                    setSerialInput('');
                                                }
                                            }}
                                        />
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button
                                        variant="outline"
                                        onClick={() => {
                                            setDialogOpen(false);
                                            setSerialInput('');
                                        }}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        onClick={() => {
                                            if (serialInput.trim()) {
                                                navigate(`/device/${serialInput.trim()}`);
                                                setDialogOpen(false);
                                                setSerialInput('');
                                            }
                                        }}
                                        disabled={!serialInput.trim()}
                                    >
                                        Connect
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
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
                                        <TableCell className="font-medium">{device.model || 'Unknown Device'}</TableCell>
                                        <TableCell className="text-center">
                                            <div className="flex items-center justify-center gap-1">
                                                <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => navigate(`/device/${device.serial}`)}>
                                                    <Smartphone className="h-4 w-4" />
                                                </Button>
                                                <Button variant="outline" size="icon" className="h-8 w-8">
                                                    <Terminal className="h-4 w-4" />
                                                </Button>
                                                <Button variant="outline" size="icon" className="h-8 w-8">
                                                    <Folder className="h-4 w-4" />
                                                </Button>
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
                <Route path="/device/:serial" element={<DeviceDetail />} />
            </Routes>
        </Router>
    )
}

export default App
